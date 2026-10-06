// ==UserScript==
// @name         Claude Usage Monitor
// @namespace    claude-usage-monitor
// @version      0.5.1
// @description  Shows Claude usage limits, and any active usage credit, in a fixed bottom-right indicator.
// @match        https://claude.ai/*
// @run-at       document-idle
// @grant        none
// @icon         https://claude.ai/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/rycpot/userscripts-public/main/claude-usage-monitor.user.js
// @updateURL    https://raw.githubusercontent.com/rycpot/userscripts-public/main/claude-usage-monitor.user.js
// ==/UserScript==

(() => {
  "use strict";

  const CONTAINER_ID = "claude-usage-userscript-container";
  const TOOLTIP_ID = "claude-usage-userscript-tooltip";

  // src/logic/usageColors.js
  function getUtilizationColor(percent) {
    if (percent < 50) return "hsl(var(--success-100))";
    if (percent < 80) return "hsl(var(--warning-100))";
    return "hsl(var(--danger-100))";
  }

  // Round down, like claude.ai's Settings > Usage page (79.7 shows as 79%).
  function toPercent(utilization) {
    return Math.floor(utilization);
  }

  // src/logic/timeFormat.js
  function roundToNearestMinute(date) {
    return new Date(Math.round(date.getTime() / 60000) * 60000);
  }

  function formatResetTime(isoString, now = new Date(), locale = "en-US") {
    if (!isoString) return "N/A";
    const date = roundToNearestMinute(new Date(isoString));
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const targetDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const isToday = today.getTime() === targetDate.getTime();
    const timeStr = date.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit"
    });
    if (isToday) return timeStr;
    const dateStr = date.toLocaleDateString(locale, {
      month: "short",
      day: "numeric"
    });
    return `${dateStr}, ${timeStr}`;
  }

  function formatCompactResetTime(isoString, locale = "en-US") {
    if (!isoString) return "N/A";
    const rawDate = new Date(isoString);
    if (Number.isNaN(rawDate.getTime())) return "N/A";
    const date = roundToNearestMinute(rawDate);
    const timeStr = date.toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
    return timeStr.replace(/\s+/g, "");
  }

  function formatCompactExpiry(isoString, now = new Date(), locale = "en-US") {
    if (!isoString) return "N/A";
    const date = roundToNearestMinute(new Date(isoString));
    if (Number.isNaN(date.getTime())) return "N/A";
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) return formatCompactResetTime(isoString, locale);
    return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
  }

  // src/ui/chatIndicator.js, adapted only by changing its mount point
  // from the Claude chat toolbar to a fixed bottom-right container.
  function attachTooltipListeners(containerEl) {
    const indicator = containerEl.querySelector(".claude-usage-indicator");
    if (!indicator) return;

    const showTooltip = () => {
      const tooltip = containerEl.querySelector(".claude-usage-tooltip");
      if (tooltip) tooltip.style.display = "block";
      indicator.setAttribute("aria-expanded", "true");
    };

    const hideTooltip = () => {
      const tooltip = containerEl.querySelector(".claude-usage-tooltip");
      if (tooltip) tooltip.style.display = "none";
      indicator.setAttribute("aria-expanded", "false");
    };

    indicator.addEventListener("mouseenter", showTooltip);
    indicator.addEventListener("mouseleave", hideTooltip);
    indicator.addEventListener("focus", showTooltip);
    indicator.addEventListener("blur", hideTooltip);
    indicator.addEventListener("click", () => {
      const tooltip = containerEl.querySelector(".claude-usage-tooltip");
      const isVisible = tooltip?.style.display === "block";
      isVisible ? hideTooltip() : showTooltip();
    });
    indicator.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideTooltip();
    });
  }

  function renderIndicator(data) {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;

    const hasData =
      data &&
      !data.error &&
      data.fiveHour?.utilization !== void 0;

    if (!hasData) {
      container.innerHTML = `
        <button type="button"
          class="claude-usage-indicator inline-flex items-center gap-1 relative select-none cursor-pointer rounded-lg transition duration-300 hover:!bg-bg-200"
          aria-describedby="${TOOLTIP_ID}"
          aria-expanded="false"
          aria-label="Usage data loading">
          <span class="claude-usage-error-icon" title="Usage data loading...">?</span>
          <div class="claude-usage-tooltip" role="tooltip" id="${TOOLTIP_ID}">
            <div class="claude-usage-tooltip-title">Usage Limits</div>
            <div class="claude-usage-tooltip-row">
              <span>Status:</span><span>Loading...</span>
            </div>
          </div>
        </button>`;
      attachTooltipListeners(container);
      return;
    }

    const { fiveHour, sevenDay } = data;
    const pct = toPercent(fiveHour.utilization);
    const locale = navigator.language;
    const now = new Date();
    const fiveReset = formatResetTime(fiveHour.resetsAt, now, locale);
    const compactFiveReset = formatCompactResetTime(fiveHour.resetsAt, locale);
    const sevenPct = sevenDay ? toPercent(sevenDay.utilization) : null;
    const sevenReset = formatResetTime(sevenDay?.resetsAt, now, locale);

    // Credits are used before the plan limits, so while one is active the
    // indicator shows it in place of the 5-hour session.
    const credits = getActiveCredits(data.credits, now, data.inUseCreditKey);
    const credit = credits[0];

    let color, mainPct, symbol, symbolClass, mainTime, ariaLabel;
    if (credit) {
      mainPct = toPercent(credit.utilization);
      color = getUtilizationColor(credit.utilization);
      symbol = "◆";
      symbolClass = "claude-usage-reset-symbol claude-usage-credit-symbol";
      mainTime = formatCompactExpiry(credit.expiresAt, now, locale);
      ariaLabel = `${credit.label}: ${mainPct}% used, expires ${mainTime}, click for details`;
    } else {
      mainPct = pct;
      color = getUtilizationColor(fiveHour.utilization);
      symbol = pct >= 100 ? "▶" : "■";
      symbolClass = pct >= 100
        ? "claude-usage-reset-symbol claude-usage-reset-symbol-green"
        : "claude-usage-reset-symbol claude-usage-reset-symbol-red";
      mainTime = compactFiveReset;
      ariaLabel = `Usage: ${pct}%, resets at ${compactFiveReset}, click for details`;
    }

    const creditRows = credits.map((c) => `
          <div class="claude-usage-tooltip-row">
            <span>${c.label}${c.key === data.inUseCreditKey ? " (in use)" : ""}:</span><span>${toPercent(c.utilization)}% used</span>
          </div>
          <div class="claude-usage-tooltip-row">
            <span>Expires:</span><span>${formatResetTime(c.expiresAt, now, locale)}</span>
          </div>`).join("");

    container.innerHTML = `
      <button type="button"
        class="claude-usage-indicator inline-flex items-center gap-1 relative select-none cursor-pointer rounded-lg transition duration-300 hover:!bg-bg-200"
        aria-describedby="${TOOLTIP_ID}"
        aria-expanded="false"
        aria-label="${ariaLabel}">
        <span class="claude-usage-dot" style="background-color: ${color};"></span>
        <span class="claude-usage-percent">${mainPct}%</span>
        <span class="${symbolClass}">${symbol}</span><span class="claude-usage-reset-time">${mainTime}</span>
        <div class="claude-usage-tooltip" role="tooltip" id="${TOOLTIP_ID}">
          <div class="claude-usage-tooltip-title">Usage Limits</div>${creditRows}
          <div class="claude-usage-tooltip-row">
            <span>5-hour:</span><span>${pct}% used</span>
          </div>
          <div class="claude-usage-tooltip-row">
            <span>Resets:</span><span>${fiveReset}</span>
          </div>
          <div class="claude-usage-tooltip-row">
            <span>7-day:</span><span>${sevenPct ?? "N/A"}% used</span>
          </div>
          <div class="claude-usage-tooltip-row">
            <span>Resets:</span><span>${sevenReset}</span>
          </div>
        </div>
      </button>`;

    attachTooltipListeners(container);
  }

  // src/logic/usageData.js
  // The usage API reports dollar credits under internal codenames that can
  // change, so credits are found by shape (an entry with a dollar limit).
  // Known codenames only get a friendlier label.
  const CREDIT_LABELS = {
    harbor_lantern: "Setup credit",
    iguana_necktie: "Cloud credit"
  };

  // Round expiry down (not to nearest) so it never shows later than the real
  // expiry; this also matches the time on claude.ai's Settings > Usage page.
  function floorToMinute(isoString) {
    if (!isoString) return null;
    const t = new Date(isoString).getTime();
    if (Number.isNaN(t)) return null;
    return new Date(Math.floor(t / 60000) * 60000).toISOString();
  }

  function extractCredits(raw) {
    const credits = [];
    for (const [key, value] of Object.entries(raw || {})) {
      if (
        value &&
        typeof value === "object" &&
        typeof value.utilization === "number" &&
        typeof value.limit_dollars === "number" &&
        value.limit_dollars > 0
      ) {
        credits.push({
          key,
          label: CREDIT_LABELS[key] || "Credit",
          utilization: value.utilization,
          usedDollars: typeof value.used_dollars === "number" ? value.used_dollars : null,
          expiresAt: floorToMinute(value.resets_at)
        });
      }
    }
    return credits;
  }

  // Credits that still have balance and haven't expired. The credit last seen
  // in use comes first; otherwise the soonest expiry.
  function getActiveCredits(credits, now = new Date(), inUseKey = null) {
    return (credits || [])
      .filter((c) => c.utilization < 100)
      .filter((c) => !c.expiresAt || new Date(c.expiresAt) > now)
      .sort((a, b) => {
        if (a.key === inUseKey) return -1;
        if (b.key === inUseKey) return 1;
        const ta = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
        const tb = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
        return ta - tb;
      });
  }

  // The API doesn't say which credit is drawn from first, so infer it: the
  // credit whose used amount went up since the last fetch is the one in use.
  // Remembered across reloads in localStorage.
  const CREDIT_STATE_KEY = "claude-usage-monitor:credit-state";

  function loadCreditState() {
    try {
      const state = JSON.parse(localStorage.getItem(CREDIT_STATE_KEY));
      if (state && typeof state === "object") return state;
    } catch {}
    return { used: {}, inUseKey: null };
  }

  function saveCreditState(state) {
    try {
      localStorage.setItem(CREDIT_STATE_KEY, JSON.stringify(state));
    } catch {}
  }

  function updateInUseCredit(credits) {
    const state = loadCreditState();
    const prevUsed = state.used || {};
    let bestKey = null;
    let bestIncrease = 0;
    const used = {};
    for (const c of credits) {
      if (c.usedDollars === null) continue;
      used[c.key] = c.usedDollars;
      const prev = prevUsed[c.key];
      const increase = typeof prev === "number" ? c.usedDollars - prev : 0;
      if (increase > 0.0001 && increase > bestIncrease) {
        bestIncrease = increase;
        bestKey = c.key;
      }
    }
    const inUseKey = bestKey ?? state.inUseKey ?? null;
    saveCreditState({ used, inUseKey });
    return inUseKey;
  }

  function normalizeUsageData(raw) {
    return {
      fiveHour: {
        utilization: raw.five_hour?.utilization ?? 0,
        resetsAt: raw.five_hour?.resets_at ?? null
      },
      sevenDay: {
        utilization: raw.seven_day?.utilization ?? 0,
        resetsAt: raw.seven_day?.resets_at ?? null
      },
      credits: extractCredits(raw),
      fetchedAt: new Date().toISOString(),
      error: null
    };
  }

  // src/background/usageApi.js
  async function fetchUsage(orgUuid) {
    const url = `https://claude.ai/api/organizations/${orgUuid}/usage`;
    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`API ${response.status}: ${body}`);
    }
    return response.json();
  }

  function getOrgUuid() {
    const match = document.cookie.match(/(?:^|; )lastActiveOrg=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  let cachedData = null;
  let hasSucceededOnce = false;
  let retryTimeoutId = null;
  let retryAttempt = 0;
  // Short backoff used only until the first successful fetch (e.g. right
  // after opening a tab, before claude.ai has finished setting the org
  // cookie). Once a fetch succeeds, we rely on the normal 3-minute interval.
  const STARTUP_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

  function clearRetryTimeout() {
    if (retryTimeoutId !== null) {
      clearTimeout(retryTimeoutId);
      retryTimeoutId = null;
    }
  }

  function scheduleStartupRetry() {
    if (hasSucceededOnce) return;
    if (retryAttempt >= STARTUP_RETRY_DELAYS_MS.length) return;
    const delay = STARTUP_RETRY_DELAYS_MS[retryAttempt];
    retryAttempt += 1;
    clearRetryTimeout();
    retryTimeoutId = setTimeout(pollAndRender, delay);
  }

  function ensureContainer() {
    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = CONTAINER_ID;
      document.body.appendChild(container);
    }
    return container;
  }

  async function pollAndRender() {
    ensureContainer();

    const orgUuid = getOrgUuid();
    if (!orgUuid) {
      renderIndicator({ error: "no_org_uuid" });
      scheduleStartupRetry();
      return;
    }

    try {
      const data = normalizeUsageData(await fetchUsage(orgUuid));
      data.inUseCreditKey = updateInUseCredit(data.credits);
      cachedData = data;
      hasSucceededOnce = true;
      clearRetryTimeout();
      renderIndicator(data);
    } catch {
      renderIndicator({ error: "fetch_failed" });
      scheduleStartupRetry();
    }
  }

  function rerenderCached() {
    if (cachedData) renderIndicator(cachedData);
  }

  function setupMutationObserver() {
    let mutationTimeout;
    const observer = new MutationObserver(() => {
      clearTimeout(mutationTimeout);
      mutationTimeout = setTimeout(() => {
        ensureContainer();
        if (cachedData) renderIndicator(cachedData);
      }, 500);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function injectStyles() {
    if (document.getElementById("claude-usage-userscript-styles")) return;

    const style = document.createElement("style");
    style.id = "claude-usage-userscript-styles";
    style.textContent = `
      #${CONTAINER_ID} {
        position: fixed !important;
        right: 16px !important;
        bottom: 16px !important;
        z-index: 2147483647 !important;
        display: flex;
        align-items: center;
        font-family: inherit;
        font-size: 12px;
        color: hsl(var(--text-400));
        pointer-events: auto;
      }

      #${CONTAINER_ID} .claude-usage-indicator {
        padding: 2px 4px;
        background: transparent;
        border: 0;
      }

      #${CONTAINER_ID} .claude-usage-indicator:focus-visible {
        outline: 2px solid hsl(var(--text-300));
        outline-offset: 2px;
      }

      #${CONTAINER_ID} .claude-usage-indicator:focus:not(:focus-visible) {
        outline: none;
      }

      #${CONTAINER_ID} .claude-usage-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        display: inline-block;
        flex-shrink: 0;
      }

      #${CONTAINER_ID} .claude-usage-percent {
        font-size: 11px;
        font-weight: 500;
        opacity: 0.8;
        white-space: nowrap;
      }

      #${CONTAINER_ID} .claude-usage-reset-symbol {
        font-size: 10px;
        line-height: 1;
        margin-left: 1px;
      }

      #${CONTAINER_ID} .claude-usage-reset-symbol-green {
        color: #86efac;
      }

      #${CONTAINER_ID} .claude-usage-reset-symbol-red {
        color: #fca5a5;
      }

      #${CONTAINER_ID} .claude-usage-credit-symbol {
        color: #93c5fd;
      }

      #${CONTAINER_ID} .claude-usage-reset-time {
        font-size: 11px;
        font-weight: 500;
        opacity: 0.8;
        white-space: nowrap;
      }

      #${CONTAINER_ID} .claude-usage-error-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background-color: #9ca3af;
        color: white;
        font-size: 10px;
        font-weight: bold;
      }

      #${CONTAINER_ID} .claude-usage-tooltip {
        display: none;
        position: absolute;
        bottom: 100%;
        right: 0;
        left: auto;
        transform: none;
        background: hsl(var(--bg-000));
        color: hsl(var(--text-100));
        border-radius: 8px;
        padding: 12px;
        min-width: 200px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        z-index: 2147483647;
        font-size: 12px;
        margin-bottom: 12px;
        white-space: nowrap;
      }

      #${CONTAINER_ID} .claude-usage-tooltip::after {
        content: '';
        position: absolute;
        top: 100%;
        right: 0;
        left: auto;
        transform: none;
        width: 0;
        height: 0;
        border-left: 6px solid transparent;
        border-right: 6px solid transparent;
        border-top: 6px solid hsl(var(--bg-000));
      }

      #${CONTAINER_ID} .claude-usage-tooltip-title {
        font-weight: 600;
        margin-bottom: 8px;
        font-size: 13px;
      }

      #${CONTAINER_ID} .claude-usage-tooltip-row {
        display: flex;
        justify-content: space-between;
        padding: 2px 0;
        gap: 12px;
      }

      #${CONTAINER_ID} .claude-usage-tooltip-row span:first-child {
        opacity: 0.7;
        flex-shrink: 0;
      }

    `;
    document.head.appendChild(style);
  }

  function init() {
    injectStyles();
    ensureContainer();
    pollAndRender();

    // Same refresh cadence as the extension.
    setInterval(pollAndRender, 3 * 60 * 1000);
    setInterval(rerenderCached, 60 * 1000);
    setupMutationObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();