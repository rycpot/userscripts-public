// ==UserScript==
// @name         Instagram - Right-click images (hardened)
// @namespace    local.rightclick-instagram
// @version      1.0.1
// @description  Enables right-click "Copy image" / "Save image as" on Instagram using structural detection (no class names), with a runtime fallback.
// @icon         https://www.instagram.com/favicon.ico
// @match        *://*.instagram.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://raw.githubusercontent.com/rycpot/userscripts-public/main/instagram-right-click-images.user.js
// @updateURL    https://raw.githubusercontent.com/rycpot/userscripts-public/main/instagram-right-click-images.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------
   * Layer 1: CSS (structural, zero class names)
   * Each rule is its own block on purpose: if a browser doesn't support
   * a selector (e.g. :has), only that rule is dropped, not all of them.
   * ------------------------------------------------------------------ */
  const SAFE = ':empty:not([role]):not([tabindex]):not(a):not(button)';
  const css = [
    // Let the image itself receive pointer events.
    'img { pointer-events: auto !important; }',

    // Empty overlay inside a wrapper that directly holds an <img>.
    `:is(div, a, span):has(> img) > :is(div, span)${SAFE} { pointer-events: none !important; }`,

    // Empty overlay that is a sibling of a wrapper holding an <img>.
    `:is(div, a, span):has(> img) ~ :is(div, span)${SAFE} { pointer-events: none !important; }`,

    // Empty overlay that is a direct sibling after the <img>.
    `img ~ :is(div, span)${SAFE} { pointer-events: none !important; }`,

    // Elements flagged by the runtime fallback (Layer 2).
    '[data-rcig-overlay] { pointer-events: none !important; }',
  ];

  function addCSS(rule) {
    try {
      if (typeof GM_addStyle === 'function') {
        GM_addStyle(rule);
        return;
      }
    } catch (_) { /* fall through */ }
    const s = document.createElement('style');
    s.textContent = rule;
    (document.head || document.documentElement).appendChild(s);
  }
  css.forEach(addCSS);

  /* ------------------------------------------------------------------
   * Layer 2: runtime fallback
   * If something transparent and non-interactive sits on top of an image
   * under the cursor, flag it so the CSS above makes it click-through.
   * Works regardless of how Instagram builds or names the overlay.
   * ------------------------------------------------------------------ */
  const INTERACTIVE =
    'a, button, input, textarea, select, video, audio, svg, canvas, ' +
    '[role], [tabindex], [contenteditable]';
  const MIN_IMG_SIZE = 32;      // ignore tiny icons
  const MIN_COVERAGE = 0.5;     // overlay must cover >=50% of the image

  function coverage(overlay, img) {
    const o = overlay.getBoundingClientRect();
    const i = img.getBoundingClientRect();
    const w = Math.min(o.right, i.right) - Math.max(o.left, i.left);
    const h = Math.min(o.bottom, i.bottom) - Math.max(o.top, i.top);
    if (w <= 0 || h <= 0) return 0;
    const area = i.width * i.height;
    return area ? (w * h) / area : 0;
  }

  function isPassiveOverlay(el) {
    if (el.tagName !== 'DIV' && el.tagName !== 'SPAN') return false;
    if (el.hasAttribute('role') || el.hasAttribute('tabindex')) return false;
    if (el.textContent.trim() !== '') return false;       // has visible text
    if (el.querySelector(INTERACTIVE)) return false;      // has controls inside
    return true;
  }

  function processPoint(x, y) {
    let stack;
    try {
      stack = document.elementsFromPoint(x, y);
    } catch (_) {
      return;
    }
    const candidates = [];
    for (const el of stack) {
      if (el.tagName === 'IMG') {
        const r = el.getBoundingClientRect();
        if (r.width < MIN_IMG_SIZE || r.height < MIN_IMG_SIZE) return;
        for (const c of candidates) {
          if (coverage(c, el) >= MIN_COVERAGE) {
            c.setAttribute('data-rcig-overlay', '');
          }
        }
        return;
      }
      // Something that looks interactive sits above the image: leave it alone.
      if (!isPassiveOverlay(el)) return;
      candidates.push(el);
    }
  }

  let queued = false;
  let lastX = 0, lastY = 0;
  function schedule(e) {
    lastX = e.clientX;
    lastY = e.clientY;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      processPoint(lastX, lastY);
    });
  }

  window.addEventListener('pointermove', schedule, { capture: true, passive: true });
  // Right-button press: process immediately (before the menu opens on some OSes).
  window.addEventListener('mousedown', (e) => {
    if (e.button === 2) processPoint(e.clientX, e.clientY);
  }, { capture: true, passive: true });

  /* ------------------------------------------------------------------
   * Layer 3: stop page scripts from cancelling the native menu on images
   * ------------------------------------------------------------------ */
  window.addEventListener('contextmenu', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG') e.stopImmediatePropagation();
  }, true);
})();