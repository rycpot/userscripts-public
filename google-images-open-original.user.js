// ==UserScript==
// @name         Google Images — Open Original (Preview Panel Only)
// @namespace    https://tampermonkey.net/
// @version      2.0
// @description  Adds a subtle "Open Image" button next to the existing controls in the Google Images preview panel that opens the original full-size image in a new tab. Never suppresses the panel or touches grid thumbnails.
// @author       you
// @match        *://www.google.com/*
// @match        *://www.google.co.in/*
// @match        *://www.google.co.uk/*
// @match        *://www.google.ca/*
// @match        *://www.google.com.au/*
// @match        *://www.google.de/*
// @match        *://www.google.fr/*
// @include      /^https?:\/\/www\.google\.[a-z.]+\//
// @grant        none
// @run-at       document-idle
// @noframes
// @icon         https://www.google.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/rycpot/userscripts-public/main/google-images-open-original.user.js
// @updateURL    https://raw.githubusercontent.com/rycpot/userscripts-public/main/google-images-open-original.user.js
// ==/UserScript==

(function () {
  'use strict';

  const ROOT_CLASS = 'giob-actions';
  const BTN_ID = 'giob-open-btn';

  let lastClickedCandidate = null; // { url, capturedAt }
  let scanQueued = false;
  let observer = null;

  // ---------------------------------------------------------------------
  // URL extraction — kept intentionally identical to the first reference's
  // logic, since it's proven to have the highest hit rate. Google's
  // thumbnail/panel links carry the original image URL in their own href
  // as /imgres?imgurl=...&imgrefurl=... (Google's JS just intercepts the
  // click to render the panel instead of navigating). We only ever READ
  // this — never preventDefault/stopPropagation — so nothing about the
  // panel's normal open behavior changes.
  // ---------------------------------------------------------------------
  function parseImgUrl(href) {
    if (!href || href.indexOf('imgurl') === -1) return null;
    let decoded = href;
    try {
      decoded = decodeURIComponent(decoded);
      if (decoded.indexOf('%25') !== -1 || decoded.indexOf('%') !== -1) {
        decoded = decodeURIComponent(decoded);
      }
    } catch (e) {
      decoded = href;
    }
    const m = /imgurl=([^&]+)/.exec(decoded);
    if (m && m[1]) {
      try {
        return decodeURIComponent(m[1]);
      } catch (e) {
        return m[1];
      }
    }
    return null;
  }

  function parseOnclick(onclick) {
    if (!onclick || onclick.indexOf('imgurl') === -1) return null;
    let m = onclick.match(/imgurl:\s*'([^']+)'/);
    if (m && m[1]) return m[1];
    m = onclick.match(/imgurl:\s*"([^"]+)"/);
    if (m && m[1]) return m[1];
    return null;
  }

  // Walk up from a node looking for either an anchor with imgurl= in its
  // href, or an onclick attribute containing imgurl — same dual strategy
  // the first reference used.
  function findImgUrlFromNode(element) {
    let node = element;
    while (node && node !== document.body && node !== document) {
      if (node.tagName === 'A') {
        const url = parseImgUrl(node.getAttribute('href') || '');
        if (url) return url;
      }
      const onclick = node.getAttribute ? node.getAttribute('onclick') : null;
      if (onclick) {
        const url = parseOnclick(onclick);
        if (url) return url;
      }
      node = node.parentNode;
    }
    return null;
  }

  // Purely observational click capture: never blocks the click, just
  // remembers the imgurl= from whatever the user clicked, as a fallback
  // for when the panel's own markup doesn't expose the URL directly.
  document.addEventListener(
    'click',
    (e) => {
      const url = findImgUrlFromNode(e.target);
      if (url) {
        lastClickedCandidate = { url, capturedAt: Date.now() };
      }
      queueScan(150);
      queueScan(600);
    },
    true
  );

  // ---------------------------------------------------------------------
  // Panel / action-bar detection — adapted from the second reference.
  // Instead of guessing fixed pixel coordinates, we find the largest
  // visible non-branding image on the page (the panel's hero image),
  // walk up to find its enclosing panel, then find the row of existing
  // controls (Visit / Share / Save / More) near the image so our button
  // can be inserted as a natural sibling instead of floated on top.
  // ---------------------------------------------------------------------
  function isLikelyGoogleImagesPage() {
    const hostname = location.hostname.toLowerCase();
    if (!hostname.endsWith('.google.com') && hostname !== 'google.com') {
      // still allow other Google TLDs matched above
      if (!/\.google\.[a-z.]+$/.test(hostname) && !hostname.startsWith('www.google.')) return false;
    }
    const params = new URLSearchParams(location.search);
    return (
      params.get('tbm') === 'isch' ||
      params.get('udm') === '2' ||
      /\/imgres$/i.test(location.pathname) ||
      Boolean(document.querySelector("a[href*='tbm=isch'], a[href*='udm=2']"))
    );
  }

  function isGoogleBrandingUrl(url) {
    return /(?:googlelogo|\/logos\/|\/images\/branding\/|gstatic\.com\/images\?)/i.test(url);
  }

  function visibleRectArea(rect, vw, vh) {
    const left = Math.max(0, rect.left);
    const right = Math.min(vw, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(vh, rect.bottom);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }

  function findActivePreviewImage() {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;

    return (
      Array.from(document.querySelectorAll('img'))
        .filter((img) => !img.closest('.' + ROOT_CLASS))
        .map((img) => {
          const rect = img.getBoundingClientRect();
          return { img, rect, visibleArea: visibleRectArea(rect, vw, vh) };
        })
        .filter(({ img, rect, visibleArea }) => {
          if (!visibleArea || rect.width < 220 || rect.height < 160) return false;
          if ((img.currentSrc || img.src || '').startsWith('data:')) return false;
          if (isGoogleBrandingUrl(img.currentSrc || img.src || '')) return false;
          return true;
        })
        .sort((a, b) => b.visibleArea - a.visibleArea)[0] || {}
    ).img || null;
  }

  function accessibleText(el) {
    return [el.textContent, el.getAttribute?.('aria-label'), el.getAttribute?.('title')]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function visibleControlsIn(root) {
    return Array.from(root.querySelectorAll("a[href], a[role='button'], button, [role='button']")).filter((el) => {
      if (el.closest('.' + ROOT_CLASS)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 16 && r.height >= 16 && r.bottom > 0 && r.right > 0;
    });
  }

  function findPreviewPanel(image) {
    const imageRect = image.getBoundingClientRect();
    let bestPanel = null;
    let bestScore = -Infinity;

    for (let node = image.parentElement; node && node !== document.body; node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.width < Math.max(260, imageRect.width) || rect.height < Math.max(180, imageRect.height)) continue;

      const controls = visibleControlsIn(node);
      const hasCommonAction = controls.some((c) => /visit|share|save|more|lens|open|view/i.test(accessibleText(c)));
      const previewShape = rect.width > imageRect.width * 1.05 || rect.height > imageRect.height * 1.1;
      const score = controls.length * 15 + (hasCommonAction ? 60 : 0) + (previewShape ? 30 : 0) - (rect.width * rect.height) / 150000;

      if (score > bestScore && controls.length >= 1) {
        bestPanel = node;
        bestScore = score;
      }
    }

    return bestPanel || image.parentElement;
  }

  // Finds the *tight* cluster of small icon-buttons (prev / next / more /
  // close) specifically — not the wider row that also holds the site
  // icon+name link. We require every control inside the candidate to be
  // narrow (icon-sized), which the site-name link never is (it has visible
  // text), so this reliably isolates just the nav-icons group even when
  // findActionBar's broader search grabs the whole header row.
  function findNavControlsGroup(panel) {
    const controls = visibleControlsIn(panel);
    const candidates = new Map();

    for (const control of controls) {
      let node = control.parentElement;
      let depth = 0;
      while (node && node !== panel.parentElement && depth < 4) {
        const rect = node.getBoundingClientRect();
        if (rect.height >= 20 && rect.height <= 80 && rect.width >= 60 && rect.width <= 420) {
          const inner = visibleControlsIn(node);
          const allIconSized = inner.length > 0 && inner.every((c) => c.getBoundingClientRect().width <= 60);
          if (inner.length >= 3 && allIconSized) {
            const score = inner.length * 20 - rect.width;
            candidates.set(node, Math.max(candidates.get(node) ?? -Infinity, score));
          }
        }
        node = node.parentElement;
        depth += 1;
      }
    }

    return Array.from(candidates.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  function findActionBar(panel, image) {
    const imageRect = image.getBoundingClientRect();
    const controls = visibleControlsIn(panel);
    const candidates = new Map();

    for (const control of controls) {
      let node = control.parentElement;
      let depth = 0;
      while (node && node !== panel.parentElement && depth < 5) {
        const rect = node.getBoundingClientRect();
        if (rect.height >= 28 && rect.height <= 112 && rect.width >= 80) {
          const count = visibleControlsIn(node).length;
          // Require at least 2 controls so we don't latch onto a single-link
          // row (e.g. the site-attribution/name link), which caused the
          // button to jump between that row and the real nav-controls bar.
          if (count >= 2) {
            const text = accessibleText(node);
            const nearImage =
              Math.abs(rect.top - imageRect.bottom) < 260 ||
              Math.abs(rect.bottom - imageRect.top) < 180 ||
              rect.top < imageRect.top + 120;
            const score = count * 25 + (nearImage ? 30 : 0) + (/visit|share|save|more|lens/i.test(text) ? 70 : 0) - depth * 4;
            candidates.set(node, Math.max(candidates.get(node) || -Infinity, score));
          }
        }
        node = node.parentElement;
        depth += 1;
      }
    }

    return Array.from(candidates.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  // Resolve the URL for the currently-open panel: prefer an imgurl= anchor
  // scoped to the panel itself (most accurate, tied to the exact image
  // shown), then fall back to whatever was last actually clicked.
  function resolveImageUrl(panel) {
    const anchors = panel.querySelectorAll('a[href*="imgurl="]');
    let best = null;
    let bestArea = 0;
    anchors.forEach((a) => {
      const r = a.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = a;
      }
    });
    if (best) {
      const url = parseImgUrl(best.getAttribute('href') || best.href);
      if (url) return url;
    }

    if (lastClickedCandidate && Date.now() - lastClickedCandidate.capturedAt < 20000) {
      return lastClickedCandidate.url;
    }

    return null;
  }

  // ---------------------------------------------------------------------
  // Button injection
  // ---------------------------------------------------------------------
  function ensureButtonRoot(container, beforeNode) {
    let root = container.querySelector('.' + ROOT_CLASS);
    if (root) return root;

    root = document.createElement('span');
    root.className = ROOT_CLASS;
    root.innerHTML = `
      <button id="${BTN_ID}" type="button">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M14 4h6v6h-2V7.4l-8.3 8.3-1.4-1.4L16.6 6H14V4ZM5 5h6v2H7v10h10v-4h2v6H5V5Z"/>
        </svg>
        <span>Open Image</span>
      </button>
    `;
    if (beforeNode && beforeNode.parentElement === container) {
      container.insertBefore(root, beforeNode);
    } else {
      container.append(root);
    }
    return root;
  }

  function updateButton(root, url) {
    const btn = root.querySelector('#' + BTN_ID);
    if (!btn) return;
    btn.disabled = !url;
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (url) window.open(url, '_blank', 'noopener');
    };
  }

  function removeAllButtons() {
    document.querySelectorAll('.' + ROOT_CLASS).forEach((el) => el.remove());
  }

  function injectIntoActivePreview() {
    if (!isLikelyGoogleImagesPage()) {
      removeAllButtons();
      return;
    }

    const image = findActivePreviewImage();
    if (!image) {
      removeAllButtons();
      return;
    }

    const panel = findPreviewPanel(image);
    if (!panel) return;

    const actionBar = findActionBar(panel, image) || panel;
    const navGroup = findNavControlsGroup(panel);
    // Prefer sitting as a sibling right before the tight nav-controls
    // cluster (Visit/Share/Save/More) — that places us between the site
    // name and those buttons, hugging the buttons on the right. Fall back
    // to the wider action bar if the cluster can't be isolated.
    const insertionParent = (navGroup && navGroup.parentElement) || actionBar;
    const url = resolveImageUrl(panel);

    // Clean up any button left behind in a previously-chosen container
    // (Google's panel re-renders can shift which row scores best between
    // scans) before placing/reusing the one in the current container.
    document.querySelectorAll('.' + ROOT_CLASS).forEach((el) => {
      if (!insertionParent.contains(el)) el.remove();
    });

    const root = ensureButtonRoot(insertionParent, navGroup);
    updateButton(root, url);
  }

  function queueScan(delay = 100) {
    if (scanQueued) return;
    scanQueued = true;
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        scanQueued = false;
        injectIntoActivePreview();
      });
    }, delay);
  }

  // ---------------------------------------------------------------------
  // Styling — a subtle pill button matching Google's own control style.
  // ---------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    .${ROOT_CLASS} {
      display: inline-flex;
      align-items: center;
      margin-left: auto;
      margin-right: 8px;
      vertical-align: middle;
      font-family: "Google Sans", Roboto, Arial, sans-serif;
    }
    #${BTN_ID} {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 0 12px;
      border: 1px solid rgba(60, 64, 67, 0.2);
      border-radius: 16px;
      background: #fff;
      color: #202124;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(60, 64, 67, 0.12);
      transition: box-shadow 0.15s ease, background 0.15s ease;
    }
    #${BTN_ID}:hover {
      box-shadow: 0 2px 6px rgba(60, 64, 67, 0.25);
    }
    #${BTN_ID}:disabled {
      opacity: 0.45;
      cursor: default;
      box-shadow: none;
    }
    html[dark] #${BTN_ID} {
      background: #2f3033;
      color: #f1f3f4;
      border-color: rgba(255, 255, 255, 0.16);
    }
  `;
  document.head.appendChild(style);

  // ---------------------------------------------------------------------
  // Observe for panel open/close/update. Debounced so we don't re-scan on
  // every single mutation Google's UI produces.
  // ---------------------------------------------------------------------
  observer = new MutationObserver(() => queueScan());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'src', 'srcset'],
  });

  queueScan(300);
})();