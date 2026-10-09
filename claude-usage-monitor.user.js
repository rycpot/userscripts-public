// ==UserScript==
// @name         Claude Usage Monitor
// @namespace    claude-usage-monitor
// @version      0.9.8
// @description  Shows Claude usage limits, and any active usage credit, in a top-right indicator.
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
  // The tooltip is shown in its own layer on <body>: inside the title bar it
  // would be stuck under page content on pages where the title bar sits in a
  // lower stacking context (e.g. Claude Code project pages).
  const LAYER_ID = "claude-usage-userscript-tooltip-layer";
  let tooltipOpen = false;
  let showCurrentTooltip = null;

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




  // An invalid tag (e.g. "en-US@posix") would make every toLocale* call
  // throw, so fall back to the browser default.
  function safeLocale(tag) {
    try {
      return Intl.DateTimeFormat.supportedLocalesOf([tag]).length ? tag : undefined;
    } catch {
      return undefined;
    }
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

    // Centre the tooltip under the indicator, but keep it at least 12px (the
    // title bar's own inset) inside the window; the arrow always points at
    // the indicator's centre.
    const TOOLTIP_EDGE_GAP = 12;
    const TOOLTIP_OFFSET = 12;

    const getLayer = () => {
      let layer = document.getElementById(LAYER_ID);
      if (!layer) {
        layer = document.createElement("div");
        layer.id = LAYER_ID;
        document.body.appendChild(layer);
      }
      return layer;
    };

    // Copy the theme colours and font from where the indicator sits, so the
    // tooltip matches light/dark mode outside that part of the page.
    const copyTheme = (layer) => {
      const cs = getComputedStyle(containerEl);
      for (const name of ["--bg-000", "--text-100"]) {
        const value = cs.getPropertyValue(name);
        if (value) layer.style.setProperty(name, value);
      }
      layer.style.fontFamily = cs.fontFamily;
    };

    const positionTooltip = (tooltip) => {
      const r = indicator.getBoundingClientRect();
      const centre = r.left + r.width / 2;
      const width = tooltip.offsetWidth;
      let left = centre - width / 2;
      left = Math.min(left, window.innerWidth - TOOLTIP_EDGE_GAP - width);
      left = Math.max(left, TOOLTIP_EDGE_GAP);
      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(r.bottom + TOOLTIP_OFFSET)}px`;
      tooltip.style.setProperty("--claude-usage-arrow-right", `${Math.max(6, left + width - centre - 6)}px`);
    };

    const showTooltip = () => {
      const tooltip = containerEl.querySelector(".claude-usage-tooltip");
      const layer = getLayer();
      if (tooltip) {
        copyTheme(layer);
        layer.replaceChildren(tooltip);
      }
      const shown = layer.querySelector(".claude-usage-tooltip");
      if (shown) {
        shown.style.display = "block";
        positionTooltip(shown);
      }
      tooltipOpen = true;
      indicator.setAttribute("aria-expanded", "true");
    };

    const hideTooltip = () => {
      document.getElementById(LAYER_ID)?.replaceChildren();
      tooltipOpen = false;
      indicator.setAttribute("aria-expanded", "false");
    };

    indicator.addEventListener("mouseenter", showTooltip);
    indicator.addEventListener("mouseleave", hideTooltip);
    indicator.addEventListener("focus", showTooltip);
    indicator.addEventListener("blur", hideTooltip);
    indicator.addEventListener("click", () => {
      tooltipOpen ? hideTooltip() : showTooltip();
    });
    indicator.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideTooltip();
    });

    // Re-rendered while open (data refresh): keep it open with the new content.
    showCurrentTooltip = showTooltip;
    if (tooltipOpen) showTooltip();
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
    const locale = safeLocale(navigator.language);
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

    // A line separates each group: every credit, the 5-hour and the 7-day
    // limit (and the renewal row, styled the same way).
    const GROUP = "claude-usage-tooltip-row claude-usage-tooltip-group";
    const creditRows = credits.map((c, i) => `
          <div class="${i === 0 ? "claude-usage-tooltip-row" : GROUP}">
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
          <div class="${credits.length ? GROUP : "claude-usage-tooltip-row"}">
            <span>5-hour:</span><span>${pct}% used</span>
          </div>
          <div class="claude-usage-tooltip-row">
            <span>Resets:</span><span>${fiveReset}</span>
          </div>
          <div class="${GROUP}">
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
      // Hidden until updatePosition() has settled its spot, so it doesn't
      // flash somewhere else and then jump.
      container.style.visibility = "hidden";
      document.body.appendChild(container);
    }
    return container;
  }

  // --- Placement ---
  // Always at the top. On Claude Code pages it sits inside the main pane's
  // title bar, just before the icon group, so the row makes room for it.
  // On new-chat and Claude Code home pages it's in the top row, just left of
  // any top-right buttons. Elsewhere it's fixed top-right, just under the
  // page header.
  const DEFAULT_TOP = 52;
  // Centre of the top row when there's no button to line up with.
  const DEFAULT_ROW_CENTRE = 26;
  const ROW_GAP = 8;

  function isNewPage() {
    return /^\/(new|code)?\/?$/.test(location.pathname);
  }

  function isShown(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
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

  // Buttons in the page's top row (the sidebar's first row and any
  // top-right buttons such as the incognito ghost).
  function topRowButtons() {
    return [...document.querySelectorAll("button, a[href]")].filter((el) => {
      if (el.closest(`#${CONTAINER_ID}, #${LAYER_ID}`) || !isShown(el)) return false;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < 60 && r.height < 60;
    });
  }

  function placeInTopRow(container) {
    const buttons = topRowButtons();
    const right = buttons.filter((el) => el.getBoundingClientRect().left > window.innerWidth * 0.5);
    const leftmost = right.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    const anchor = leftmost || buttons[0];
    const a = anchor ? anchor.getBoundingClientRect() : null;
    const centre = a ? a.top + a.height / 2 : DEFAULT_ROW_CENTRE;
    setPx(container, "top", centre - container.getBoundingClientRect().height / 2);
    setPx(container, "bottom", null);
    if (leftmost) {
      setPx(container, "right", window.innerWidth - a.left + ROW_GAP);
    } else {
      container.style.removeProperty("right");
    }
  }

  // Claude Code title bars (session and project pages) are a flex row ending
  // in an icon group pushed right with ml-auto. Claude Design's header is the
  // same, but its icon group follows a flex-1 spacer. Pick the main pane's
  // one: near the top, on the right half, and not in the project thread panel.
  function findTitlebar() {
    const groups = [
      ...document.querySelectorAll('[data-perf-region="header"] > .ml-auto'),
      ...document.querySelectorAll(".ml-auto.draggable-none"),
      ...document.querySelectorAll('[data-testid="floating-card"] > div > .flex-1.min-w-0 ~ .shrink-0')
    ];
    for (const icons of groups) {
      const bar = icons.parentElement;
      if (!bar || bar.closest(`#${CONTAINER_ID}`)) continue;
      if (icons.closest('[data-perf-region="side_panel"]')) continue;
      if (!isShown(icons)) continue;
      const r = icons.getBoundingClientRect();
      if (r.top > 80 || r.right < window.innerWidth * 0.5) continue;
      if (getComputedStyle(bar).display !== "flex") continue;
      return { bar, icons };
    }
    return null;
  }

  // The icon group's own ml-auto/padding would leave a gap before it, so
  // they're switched off while docked and restored after.
  let dockedIcons = null;

  function releaseIcons() {
    if (dockedIcons) {
      dockedIcons.style.removeProperty("margin-left");
      dockedIcons.style.removeProperty("padding-left");
    }
    dockedIcons = null;
  }

  // Box around what's actually drawn in a button (icons and text), ignoring
  // full-size backgrounds, so "Overview" counts as icon + text.
  function contentRect(btn) {
    const rects = [...btn.querySelectorAll("svg")].map((el) => el.getBoundingClientRect());
    const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(range.getBoundingClientRect());
    }
    const shown = rects.filter((r) => r.width > 0 && r.height > 0);
    if (!shown.length) return btn.getBoundingClientRect();
    return {
      left: Math.min(...shown.map((r) => r.left)),
      right: Math.max(...shown.map((r) => r.right))
    };
  }

  // Gap so the space from the indicator's text to the first button's content
  // matches the visible space between the first two buttons' content.
  function iconSpacing(container, icons) {
    const buttons = [...icons.querySelectorAll("button")].filter(isShown);
    if (buttons.length < 2) return 8;
    const [a, b] = buttons;
    const visibleGap = contentRect(b).left - contentRect(a).right;
    const insetBeforeFirst = contentRect(a).left - a.getBoundingClientRect().left;
    const indicator = container.querySelector(".claude-usage-indicator");
    const ownPadding = indicator ? parseFloat(getComputedStyle(indicator).paddingRight) || 0 : 0;
    return Math.max(0, visibleGap - insetBeforeFirst - ownPadding);
  }

  function dockInTitlebar(container, { bar, icons }) {
    if (container.parentElement !== bar || container.nextElementSibling !== icons) {
      // Moving after it's been shown (e.g. a loading-stage title bar was
      // replaced by the real one): hide and settle again rather than jump.
      debugLog("docking into title bar", icons.getBoundingClientRect());
      setVisible(container, false);
      stableSignature = null;
      bar.insertBefore(container, icons);
    }
    if (dockedIcons !== icons) {
      releaseIcons();
      icons.style.setProperty("margin-left", "0px");
      icons.style.setProperty("padding-left", "0px");
      dockedIcons = icons;
    }
    container.style.setProperty("margin-right", `${Math.round(iconSpacing(container, icons))}px`, "important");
    container.classList.add("claude-usage-docked", "draggable-none");
    container.style.removeProperty("right");
    setPx(container, "top", null);
    setPx(container, "bottom", null);
  }

  function undock(container) {
    releaseIcons();
    container.style.removeProperty("margin-right");
    if (container.parentElement !== document.body) document.body.appendChild(container);
    container.classList.remove("claude-usage-docked", "draggable-none");
  }

  // The title bar is built a moment after the page loads, and the spacing
  // depends on text widths, which change once the web font loads. Stay hidden
  // until both are ready; pages with no title bar show the fallback spot
  // after a short wait.
  const FALLBACK_DELAY_MS = 2500;
  // Safety net in case the title bar markup changes and is never found.
  const CODE_FALLBACK_DELAY_MS = 15000;
  const startedAt = Date.now();

  // Claude Code session and project pages and Claude Design always get a
  // title bar, but a full reload can take a few seconds to build it, so wait
  // much longer before the fallback spot. The Claude Code home page has none.
  function fallbackDelay() {
    const hasTitlebar = /^\/(code|design)(\/|$)/.test(location.pathname) && !isNewPage();
    return hasTitlebar ? CODE_FALLBACK_DELAY_MS : FALLBACK_DELAY_MS;
  }

  // fonts.ready resolves as soon as nothing is downloading, which on a fresh
  // load can be before the title bar has even asked for its font. So check
  // the title bar's own font instead.
  function fontLoaded(el) {
    const style = getComputedStyle(el);
    try {
      return document.fonts.check(`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`);
    } catch {
      return true;
    }
  }

  function fontsSettled(container, icons) {
    if (!document.fonts) return true;
    if (document.fonts.status !== "loaded") return false;
    const samples = [icons.querySelector("button") || icons, container.querySelector(".claude-usage-percent")];
    return samples.every((el) => !el || fontLoaded(el));
  }

  // On a full reload the page keeps shifting for a moment after the title
  // bar appears (fonts, panels settling at their saved sizes), so only reveal
  // once the indicator and icons have stayed put for a short while.
  const STABLE_FOR_MS = 400;
  const DATA_WAIT_MS = 10000;
  let stableSignature = null;
  let stableSince = 0;
  let revealTimer = null;

  function scheduleRevealCheck() {
    if (revealTimer) return;
    revealTimer = setTimeout(() => {
      revealTimer = null;
      updatePosition();
    }, 100);
  }

  function layoutSignature(container, icons) {
    const c = container.getBoundingClientRect();
    const i = icons.getBoundingClientRect();
    return [c.left, c.top, c.width, i.left, i.width].map(Math.round).join(",");
  }

  function revealWhenSettled(container, icons) {
    if (container.style.visibility !== "hidden") return;
    // Wait for the usage numbers too, so it can't show "?" and then widen
    // (unless the fetch is failing, in which case show what we have).
    const hasData = !!container.querySelector(".claude-usage-percent") || Date.now() - startedAt > DATA_WAIT_MS;
    const signature = hasData && fontsSettled(container, icons) ? layoutSignature(container, icons) : null;
    if (signature === null || signature !== stableSignature) {
      stableSignature = signature;
      stableSince = Date.now();
      scheduleRevealCheck();
      return;
    }
    if (Date.now() - stableSince >= STABLE_FOR_MS) {
      setVisible(container, true);
    } else {
      scheduleRevealCheck();
    }
  }

  // Re-measure the moment a font finishes loading.
  document.fonts?.addEventListener?.("loadingdone", () => updatePosition());

  function setVisible(container, visible) {
    if (visible && container.style.visibility === "hidden") debugLog("revealed", container.getBoundingClientRect());
    container.style.visibility = visible ? "" : "hidden";
  }

  // Opt-in placement log: run
  //   localStorage.setItem("claude-usage-monitor:debug", "1")
  // in the console on claude.ai and reload; removeItem to turn it off.
  function debugEnabled() {
    try {
      return localStorage.getItem("claude-usage-monitor:debug") === "1";
    } catch {
      return false;
    }
  }

  function debugLog(...args) {
    if (!debugEnabled()) return;
    const describe = (a) =>
      a && typeof a.left === "number"
        ? `left=${Math.round(a.left)} top=${Math.round(a.top)} width=${Math.round(a.width)}`
        : a;
    console.log(`[claude-usage-monitor +${Date.now() - startedAt}ms]`, ...args.map(describe));
  }

  // Debug only: log any movement after it's been revealed.
  let lastLoggedRect = "";
  function debugLogMovement(container) {
    if (!debugEnabled() || container.style.visibility === "hidden") return;
    const r = container.getBoundingClientRect();
    const key = `${Math.round(r.left)},${Math.round(r.top)}`;
    if (key !== lastLoggedRect) {
      if (lastLoggedRect) debugLog("moved while visible", r, location.pathname);
      lastLoggedRect = key;
    }
  }

  function updatePosition() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    const titlebar = findTitlebar();
    if (titlebar) {
      dockInTitlebar(container, titlebar);
      revealWhenSettled(container, titlebar.icons);
      debugLogMovement(container);
      return;
    }
    if (Date.now() - startedAt < fallbackDelay()) {
      setVisible(container, false);
      return;
    }
    if (container.parentElement !== document.body) debugLog("no title bar found, using fallback spot");
    undock(container);
    setVisible(container, true);
    debugLogMovement(container);
    if (isNewPage()) {
      placeInTopRow(container);
      return;
    }
    container.style.removeProperty("right");
    const headerBottom = findHeaderBottom();
    setPx(container, "top", headerBottom === null ? DEFAULT_TOP : headerBottom + 8);
    setPx(container, "bottom", null);
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
    let positionQueued = false;
    const observer = new MutationObserver(() => {
      // Re-dock on the next frame if the title bar just appeared or was
      // re-rendered without us, rather than waiting for the 500ms check.
      if (!positionQueued) {
        positionQueued = true;
        requestAnimationFrame(() => {
          positionQueued = false;
          const container = document.getElementById(CONTAINER_ID);
          if (!container || !container.classList.contains("claude-usage-docked") || !container.isConnected) {
            ensureContainer();
            updatePosition();
          }
        });
      }
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
      }

      #${LAYER_ID} {
        position: fixed;
        top: 0;
        left: 0;
        width: 0;
        height: 0;
        z-index: 2147483647;
        pointer-events: none;
      }

      #${LAYER_ID} .claude-usage-tooltip {
        position: fixed;
        background: hsl(var(--bg-000));
        color: hsl(var(--text-100));
        border-radius: 8px;
        padding: 12px;
        min-width: 200px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        font-size: 12px;
        white-space: nowrap;
        pointer-events: none;
      }

      #${LAYER_ID} .claude-usage-tooltip::after {
        content: '';
        position: absolute;
        bottom: 100%;
        right: var(--claude-usage-arrow-right, 0px);
        width: 0;
        height: 0;
        border-left: 6px solid transparent;
        border-right: 6px solid transparent;
        border-bottom: 6px solid hsl(var(--bg-000));
      }

      #${CONTAINER_ID}.claude-usage-docked {
        position: relative !important;
        right: auto !important;
        margin-left: auto;
        margin-right: 4px;
        flex-shrink: 0;
        z-index: 50 !important;
      }


      #${LAYER_ID} .claude-usage-tooltip-title {
        text-align: center;
        font-weight: 600;
        margin-bottom: 8px;
        font-size: 13px;
      }

      #${LAYER_ID} .claude-usage-tooltip-row {
        display: flex;
        justify-content: space-between;
        padding: 2px 0;
        gap: 12px;
      }

      #${LAYER_ID} .claude-usage-tooltip-group,
      #${LAYER_ID} .claude-usage-tooltip-billing {
        border-top: 1px solid hsl(var(--text-100) / 0.15);
        margin-top: 6px;
        padding-top: 6px;
      }

      #${LAYER_ID} .claude-usage-tooltip-row span:first-child {
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
    window.addEventListener("resize", () => {
      updatePosition();
      if (tooltipOpen && showCurrentTooltip) showCurrentTooltip();
    });
    setInterval(updatePosition, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();