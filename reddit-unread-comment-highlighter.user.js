// ==UserScript==
// @name         Reddit Unread Comment Highlighter
// @namespace    https://example.com/reddit-unread-highlighter
// @version      3.1.1
// @description  Highlights comments posted since your last visit to a Reddit thread. Nothing highlighted on first visit; refresh or revisit later to see new ones. Also tracks Reddit's same-page (SPA) navigation between threads.
// @author       you
// @icon         https://www.reddit.com/favicon.ico
// @match        *://*.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/rycpot/userscripts-public/main/reddit-unread-comment-highlighter.user.js
// @updateURL    https://raw.githubusercontent.com/rycpot/userscripts-public/main/reddit-unread-comment-highlighter.user.js
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'redditUnreadTracker_v2';
  const MAX_AGE_DAYS = 30; // forget threads you haven't visited in a while

  // Verified against Reddit's current markup (mid-2026):
  // <shreddit-comment thingid="t1_xxxxx"> ... <details><summary> ... <time datetime="...">
  const COMMENT_SELECTOR = 'shreddit-comment[thingid^="t1_"]';
  const TIMESTAMP_REL_SELECTOR = ':scope > details > summary time[datetime]';

  // Old-reddit fallback, in case you use old.reddit.com
  const OLD_COMMENT_SELECTOR = '.comment';
  const OLD_TIMESTAMP_REL_SELECTOR = ':scope > .entry .tagline time';

  function getThreadId() {
    const m = location.pathname.match(/\/comments\/([a-z0-9]+)/i);
    return m ? m[1] : null;
  }

  function loadVisits() {
    try { return JSON.parse(GM_getValue(STORAGE_KEY, '{}')); }
    catch (e) { return {}; }
  }

  function saveVisits(visits) {
    GM_setValue(STORAGE_KEY, JSON.stringify(visits));
  }

  function pruneOldEntries(visits) {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
    for (const id in visits) {
      if (visits[id].lastSeen < cutoff) delete visits[id];
    }
  }

  function injectStyle() {
    const style = document.createElement('style');
    // No outline/border here on purpose - just a soft background tint on
    // whatever element gets the class (the comment body, not the whole
    // comment row), so the username and action buttons stay unstyled.
    style.textContent = `
      .unread-comment-highlight {
        background-color: rgba(255, 200, 0, 0.18) !important;
        border-radius: 6px;
      }
    `;
    document.documentElement.appendChild(style);
  }

  // New-reddit comment body lookup. The body div's id is built from the
  // comment's own thingid, e.g. thingid="t1_p9y7zkj" ->
  // id="t1_p9y7zkj-comment-rtjson-content" slot="comment" - confirmed
  // against Reddit's live markup (mid-2026). This is deeper than a direct
  // child of <shreddit-comment> (it's inside <details> > a couple of grid
  // wrapper divs), so it can't be found with a ":scope >" selector.
  function getNewRedditCommentBody(c) {
    const thingid = c.getAttribute('thingid');
    if (thingid) {
      const byId = c.querySelector(`#${CSS.escape(thingid)}-comment-rtjson-content`);
      if (byId) return byId;
    }
    // Fallback: the first [slot="comment"] found is this comment's own body -
    // any nested replies live further down, inside #comment-children, which
    // comes after in document order.
    return c.querySelector('[slot="comment"]') || c;
  }

  // Old-reddit comment body: the rendered markdown, not the tagline
  // (username/score/time) or the buttons row underneath it.
  function getOldRedditCommentBody(c) {
    return c.querySelector(':scope > .entry .usertext-body .md') || c;
  }

  // ---------------------------------------------------------------------
  // Per-thread state. Reddit is a single-page app: navigating from one
  // thread to another (or back to a subreddit feed) often updates the URL
  // via the History API without a real page load, so this state has to be
  // re-derived on the fly rather than computed once at the top like a
  // normal page script would.
  // ---------------------------------------------------------------------
  let threadId = null;
  let sessionStart = null; // when we "arrived" at the current thread
  let lastVisitTime = null; // baseline read from storage for the current thread
  let visits = {};
  let retryTimer = null;

  function markVisited() {
    if (!threadId || sessionStart === null) return;
    visits[threadId] = { lastVisit: sessionStart, lastSeen: Date.now() };
    saveVisits(visits);
  }

  function highlightWith(commentSelector, timestampRelSelector, getBodyFn, highlightTargetFn) {
    if (lastVisitTime === null) return 0;
    let count = 0;
    document.querySelectorAll(commentSelector).forEach((c) => {
      const body = getBodyFn(c);
      if (body.classList.contains('unread-comment-highlight')) return; // already processed
      const timeEl = c.querySelector(timestampRelSelector);
      if (!timeEl) return;
      const iso = timeEl.getAttribute('datetime');
      if (!iso) return;
      const t = new Date(iso).getTime();
      if (!t || isNaN(t)) return;
      if (t > lastVisitTime) {
        highlightTargetFn(body);
        count++;
      }
    });
    return count;
  }

  function runHighlight() {
    if (!threadId) return; // not currently viewing a thread
    const isNewReddit = document.querySelector(COMMENT_SELECTOR);
    if (isNewReddit) {
      return highlightWith(COMMENT_SELECTOR, TIMESTAMP_REL_SELECTOR, getNewRedditCommentBody, (el) =>
        el.classList.add('unread-comment-highlight')
      );
    }
    return highlightWith(OLD_COMMENT_SELECTOR, OLD_TIMESTAMP_REL_SELECTOR, getOldRedditCommentBody, (el) =>
      el.classList.add('unread-comment-highlight')
    );
  }

  // Comments render in asynchronously, both on a real page load and after a
  // same-page navigation into a thread - poll briefly until they actually
  // exist instead of guessing a fixed delay.
  function waitForCommentsThenHighlight() {
    if (retryTimer) clearInterval(retryTimer);
    let retries = 0;
    const maxRetries = 20; // ~15s
    retryTimer = setInterval(() => {
      retries++;
      const hasComments =
        document.querySelector(COMMENT_SELECTOR) || document.querySelector(OLD_COMMENT_SELECTOR);
      if (hasComments) {
        clearInterval(retryTimer);
        retryTimer = null;
        runHighlight();
      } else if (retries >= maxRetries) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
    }, 750);
  }

  // Called on real page load, and again whenever we detect the SPA router
  // took us to a different thread (or away from one) without a real
  // navigation - see scheduleUrlCheck() below.
  function enterThread(newThreadId) {
    if (threadId && threadId !== newThreadId) {
      markVisited(); // record the thread we're leaving before switching
    }

    threadId = newThreadId;

    if (!threadId) {
      lastVisitTime = null;
      sessionStart = null;
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
      return; // not on a comments page (e.g. a subreddit feed) - nothing to do
    }

    sessionStart = Date.now();
    visits = loadVisits();
    pruneOldEntries(visits);
    const record = visits[threadId];
    // null => first time we've ever seen this thread: highlight nothing, just record.
    lastVisitTime = record ? record.lastVisit : null;

    waitForCommentsThenHighlight();
  }

  injectStyle();
  enterThread(getThreadId());

  // Catch comments that load later on the current thread: "load more
  // comments", infinite scroll, sort-order changes, etc. Also doubles as
  // our signal to check for SPA navigation, since a thread switch causes
  // DOM mutations too.
  const bodyObserver = new MutationObserver(() => {
    runHighlight();
    scheduleUrlCheck();
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });

  // Reddit is a single-page app: clicking between threads often updates the
  // URL via the History API without a real page load, so beforeunload/
  // pagehide never fire and this script never gets a chance to re-run on
  // its own. Debounce a check of location.href (it can lag slightly behind
  // the DOM swap that triggered the mutation above) and re-run enterThread()
  // whenever it points at a different thread.
  let lastCheckedUrl = location.href;
  let urlCheckTimer = null;
  function scheduleUrlCheck() {
    clearTimeout(urlCheckTimer);
    urlCheckTimer = setTimeout(() => {
      if (location.href === lastCheckedUrl) return;
      lastCheckedUrl = location.href;
      const newThreadId = getThreadId();
      if (newThreadId !== threadId) enterThread(newThreadId);
    }, 150);
  }

  // Still handle real navigations/closes too - covers a plain refresh, and
  // acts as a safety net if the tab is closed outright.
  window.addEventListener('pagehide', markVisited);
  window.addEventListener('beforeunload', markVisited);
})();