// ==UserScript==
// @name         Claude Usage Monitor
// @namespace    claude-usage-monitor
// @version      0.8.1
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




  // One date/time style everywhere: "06:08PM" today, "Oct 25 01:26PM" on
  // another day, "Jan 3 2027 09:00AM" when the year differs from now.
  function formatTime(date, locale) {
    return date
      .toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: true })
      .replace(/\s+/g, "");
  }

  function formatDay(date, now, locale) {
    const day = date.toLocaleDateString(locale, { month: "short", day: "numeric" });
    return date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
  }

  function formatWhen(isoString, now = new Date(), locale = "en-US") {
    if (!isoString) return "N/A";
    const raw = new Date(isoString);
    if (Number.isNaN(raw.getTime())) return "N/A";
    const date = roundToNearestMinute(raw);
    const time = formatTime(date, locale);
    if (date.toDateString() === now.toDateString()) return time;
    return `${formatDay(date, now, locale)} ${time}`;
  }

  // "2026-10-25" is a calendar date with no time; parse it as local so it
  // can't shift a day.
  function formatCalendarDate(dateString, now, locale) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateString || "");
    if (!m) return null;
    return formatDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), now, locale);
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
      updatePosition();
      return;
    }

    const { fiveHour, sevenDay } = data;
    const pct = toPercent(fiveHour.utilization);
    const locale = navigator.language;
    const now = new Date();
    const fiveReset = formatWhen(fiveHour.resetsAt, now, locale);
    const compactFiveReset = formatWhen(fiveHour.resetsAt, now, locale);
    const sevenPct = sevenDay ? toPercent(sevenDay.utilization) : null;
    const sevenReset = formatWhen(sevenDay?.resetsAt, now, locale);

    // Credits are used before the plan limits, so while one is active the
    // indicator shows it in place of the 5-hour session.
    const credits = getActiveCredits(data.credits, now, data.inUseCreditKey);
    const credit = credits[0];

    let color, mainPct, symbol, symbolClass, mainTime, ariaLabel;
    if (credit) {
      mainPct = toPercent(credit.utilization);
      color = getUtilizationColor(credit.utilization);
      symbol = "C";
      symbolClass = "claude-usage-reset-symbol claude-usage-credit-symbol";
      mainTime = formatWhen(credit.expiresAt, now, locale);
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
            <span>Expires:</span><span>${formatWhen(c.expiresAt, now, locale)}</span>
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
          </div>${renderBillingRow(cachedBilling, now, locale)}
        </div>
      </button>`;

    attachTooltipListeners(container);
    updatePosition();
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
  // Plan renewal date, from the same data claude.ai's Settings > Billing uses.
  async function fetchSubscriptionDetails(orgUuid) {
    const url = `https://claude.ai/api/organizations/${orgUuid}/subscription_details`;
    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`API ${response.status}`);
    return response.json();
  }

  // "2026-10-25" is a calendar date; parse it as local so it can't shift a day.

  // Full timestamp in the viewer's local time zone, e.g. "Oct 25, 2026, 1:26 PM".

  function renderBillingRow(billing, now, locale) {
    if (!billing) return "";
    const when = (iso) => {
      const text = formatWhen(iso, now, locale);
      return text === "N/A" ? null : text;
    };
    let label = "Renews:";
    let date =
      when(billing.next_charge_at) ||
      formatCalendarDate(billing.next_charge_date, now, locale);
    if (!date && billing.plan_ending_at) {
      label = "Plan ends:";
      date = when(billing.plan_ending_at);
    }
    if (!date) return "";
    return `
          <div class="claude-usage-tooltip-row claude-usage-tooltip-billing">
            <span>${label}</span><span>${date}</span>
          </div>`;
  }

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
  let cachedBilling = null;
  let billingFetchedAt = 0;
  const BILLING_REFRESH_MS = 60 * 60 * 1000;

  // Best-effort: if this fails the tooltip just leaves out the renewal row.
  async function refreshBilling(orgUuid) {
    if (Date.now() - billingFetchedAt < BILLING_REFRESH_MS) return;
    billingFetchedAt = Date.now();
    try {
      cachedBilling = await fetchSubscriptionDetails(orgUuid);
      if (cachedData) renderIndicator(cachedData);
    } catch {
      // Try again sooner than the full hour.
      billingFetchedAt = Date.now() - BILLING_REFRESH_MS + 5 * 60 * 1000;
    }
  }
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

  // --- Placement ---
  // Wide windows: bottom-right, vertically centred on the message box's model
  // button ("Opus 5.5", ...). Narrow windows: top-right, just under the page
  // header, where it can't cover the message box controls.
  const NARROW_WIDTH = 1300;
  const DEFAULT_BOTTOM = 16;
  const DEFAULT_TOP = 52;
  const MODEL_NAME = /^(claude\s+)?(opus|sonnet|haiku|fable)\b/i;

  function isShown(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // The lowest model button in the bottom part of the window, if any.
  function findModelButton() {
    let best = null;
    for (const el of document.querySelectorAll("button")) {
      if (el.closest(`#${CONTAINER_ID}`)) continue;
      if (!MODEL_NAME.test((el.textContent || "").trim())) continue;
      if (!isShown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < window.innerHeight - 160) continue;
      if (!best || r.bottom > best.getBoundingClientRect().bottom) best = el;
    }
    return best;
  }

  function findHeaderBottom() {
    for (const el of document.querySelectorAll("header")) {
      if (el.closest(`#${CONTAINER_ID}`) || !isShown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top <= 8 && r.height <= 120 && r.right > window.innerWidth - 80) return r.bottom;
    }
    return null;
  }

  function setPx(container, prop, value) {
    container.style.setProperty(prop, value === null ? "auto" : `${Math.round(value)}px`, "important");
  }

  // Claude Code's title bar: one flex row with the title/repo group on the
  // left (which can shrink) and the icon group on the right (ml-auto).
  function findTitlebar() {
    const bar = document.querySelector('[data-perf-region="header"]');
    if (!bar || !isShown(bar)) return null;
    const icons = [...bar.children].find((el) => el.classList.contains("ml-auto"));
    return icons ? { bar, icons } : null;
  }

  // Inside the title bar the indicator is a normal item in the row, so the
  // repo label shrinks to make room instead of being covered.
  // The icon group's own ml-auto would split the free space with ours and
  // leave a gap, so it's switched off while docked and restored after.
  let dockedIcons = null;

  function releaseIcons() {
    if (dockedIcons) {
      dockedIcons.style.removeProperty("margin-left");
      dockedIcons.style.removeProperty("padding-left");
    }
    dockedIcons = null;
  }

  // Gap so the space between the indicator's text and the first icon matches
  // the visible space between the first two icons (glyph to glyph).
  function iconSpacing(container, icons) {
    const buttons = [...icons.querySelectorAll("button")].filter(isShown);
    const glyph = (btn) => (btn.querySelector("svg") || btn).getBoundingClientRect();
    if (buttons.length < 2) return 8;
    const [a, b] = buttons;
    const visibleGap = glyph(b).left - glyph(a).right;
    const insetBeforeFirst = glyph(a).left - a.getBoundingClientRect().left;
    const indicator = container.querySelector(".claude-usage-indicator");
    const ownPadding = indicator ? parseFloat(getComputedStyle(indicator).paddingRight) || 0 : 0;
    return Math.max(0, visibleGap - insetBeforeFirst - ownPadding);
  }

  function dockInTitlebar(container, { bar, icons }) {
    if (container.parentElement !== bar || container.nextElementSibling !== icons) {
      bar.insertBefore(container, icons);
    }
    if (dockedIcons !== icons) {
      releaseIcons();
      icons.style.setProperty("margin-left", "0px");
      icons.style.setProperty("padding-left", "0px");
      dockedIcons = icons;
    }
    container.style.setProperty("margin-right", `${Math.round(iconSpacing(container, icons))}px`, "important");
    container.classList.add("claude-usage-docked", "claude-usage-at-top", "draggable-none");
    setPx(container, "top", null);
    setPx(container, "bottom", null);
  }

  function undock(container) {
    releaseIcons();
    container.style.removeProperty("margin-right");
    if (container.parentElement !== document.body) document.body.appendChild(container);
    container.classList.remove("claude-usage-docked", "draggable-none");
  }

  function updatePosition() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    if (window.innerWidth < NARROW_WIDTH) {
      const titlebar = findTitlebar();
      if (titlebar) {
        dockInTitlebar(container, titlebar);
        return;
      }
      undock(container);
      const headerBottom = findHeaderBottom();
      container.classList.add("claude-usage-at-top");
      setPx(container, "top", headerBottom === null ? DEFAULT_TOP : headerBottom + 8);
      setPx(container, "bottom", null);
      return;
    }
    undock(container);
    container.classList.remove("claude-usage-at-top");
    setPx(container, "top", null);
    const button = findModelButton();
    if (!button) {
      setPx(container, "bottom", DEFAULT_BOTTOM);
      return;
    }
    const r = button.getBoundingClientRect();
    const centre = r.top + r.height / 2;
    const bottom = window.innerHeight - centre - container.offsetHeight / 2;
    setPx(container, "bottom", Math.max(0, bottom));
  }

  async function pollAndRender() {
    ensureContainer();

    const orgUuid = getOrgUuid();
    if (!orgUuid) {
      renderIndicator({ error: "no_org_uuid" });
      scheduleStartupRetry();
      return;
    }

    refreshBilling(orgUuid);

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
        font-size: 12px;
        font-weight: 700;
        margin-right: 2px;
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

      #${CONTAINER_ID}.claude-usage-docked {
        position: relative !important;
        right: auto !important;
        margin-left: auto;
        margin-right: 4px;
        flex-shrink: 0;
        z-index: 50 !important;
      }

      #${CONTAINER_ID}.claude-usage-at-top .claude-usage-tooltip {
        bottom: auto;
        top: 100%;
        margin-bottom: 0;
        margin-top: 12px;
      }

      #${CONTAINER_ID}.claude-usage-at-top .claude-usage-tooltip::after {
        top: auto;
        bottom: 100%;
        border-top: 0;
        border-bottom: 6px solid hsl(var(--bg-000));
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

      #${CONTAINER_ID} .claude-usage-tooltip-billing {
        border-top: 1px solid hsl(var(--text-100) / 0.15);
        margin-top: 6px;
        padding-top: 6px;
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

    // The message box grows as you type and the layout shifts, so keep
    // re-placing the indicator; it's a cheap check.
    updatePosition();
    window.addEventListener("resize", updatePosition);
    setInterval(updatePosition, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();