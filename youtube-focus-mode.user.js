// ==UserScript==
// @name         YouTube Focus Mode + Full-Sized Theater Mode
// @namespace    https://tampermonkey.net/
// @version      2.2.1
// @description  Focus button that dims everything but the video, full-sized Theater mode by default, H.264 (MP4/AVC) instead of VP9/AV1, auto 1080p quality, a mini player when you scroll down to the comments, hidden related videos, a screenshot button and autoplay-next turned off.
// @author       you
// @icon         https://www.youtube.com/favicon.ico
// @match        https://www.youtube.com/*
// @match        https://www.youtube-nocookie.com/embed/*
// @grant        none
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/rycpot/userscripts-public/main/youtube-focus-mode.user.js
// @updateURL    https://raw.githubusercontent.com/rycpot/userscripts-public/main/youtube-focus-mode.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Settings
  // Quality values: 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large' (480p),
  // 'medium' (360p), 'small' (240p), 'tiny' (144p).
  // ------------------------------------------------------------------
  const CONFIG = {
    forceH264: true,            // MP4/AVC (H.264) instead of WebM/VP9/AV1 (max 1080p60)
    qualityVideos: 'hd1080',
    qualityPlaylists: 'hd1080',
    qualityEmbeds: 'hd1080',    // embedded videos on other sites
    miniPlayer: true,           // mini player when scrolling down to the comments
    miniPlayerWidth: 640,
    miniPlayerHeight: 360,
    miniPlayerPosition: 'top-right', // 'top-left', 'top-right', 'bottom-left', 'bottom-right'
    miniPlayerMargin: 15,       // gap from the window edges, in px
    hideRelated: true,
    screenshotButton: true,
    disableAutoplay: true,      // turns off the "Autoplay next video" toggle
  };

  const isEmbed = /^\/embed\//.test(location.pathname);
  // Other YouTube iframes (live chat, etc.) get nothing.
  if (window.top !== window.self && !isEmbed) return;

  // ------------------------------------------------------------------
  // Force H.264: must run before YouTube's player code asks which formats
  // the browser supports, hence @run-at document-start. Answering "no" for
  // WebM/VP8/VP9/AV1 makes YouTube fall back to MP4/AVC streams, which
  // YouTube only offers up to 1080p60.
  // ------------------------------------------------------------------
  if (CONFIG.forceH264) {
    const BLOCKED = /webm|vp8|vp0?9|av01|av1/i;
    const isBlocked = (type) => typeof type === 'string' && BLOCKED.test(type);

    for (const MS of [window.MediaSource, window.ManagedMediaSource, window.WebKitMediaSource]) {
      if (!MS || typeof MS.isTypeSupported !== 'function') continue;
      const orig = MS.isTypeSupported.bind(MS);
      MS.isTypeSupported = (type) => (isBlocked(type) ? false : orig(type));
    }

    const origCanPlay = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return isBlocked(type) ? '' : origCanPlay.call(this, type);
    };

    const mc = navigator.mediaCapabilities;
    if (mc && typeof mc.decodingInfo === 'function') {
      const origDecodingInfo = mc.decodingInfo.bind(mc);
      mc.decodingInfo = (cfg) => {
        const ct = (cfg && cfg.video && cfg.video.contentType) || '';
        if (isBlocked(ct)) {
          return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
        }
        return origDecodingInfo(cfg);
      };
    }
  }

  const BTN_ID = 'yt-focus-mode-btn';
  const OVERLAY_ID = 'yt-focus-mode-overlay';
  const SHOT_ID = 'yt-focus-screenshot-btn';
  const MINI_CLASS = 'yt-focus-mini-player';
  const MINI_BAR_ID = 'yt-focus-mini-progress';
  let focusOn = false;
  let rafId = null;

  const [miniV, miniH] = CONFIG.miniPlayerPosition.split('-');
  const style = document.createElement('style');
  style.textContent = `
    #${BTN_ID} {
      margin-left: 8px;
      padding: 0 16px;
      height: 36px;
      border-radius: 18px;
      border: none;
      background: #303030;
      color: #fff;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    #${BTN_ID}.active {
      background: #3ea6ff;
      color: #0f0f0f;
    }
    html[dark] #${BTN_ID} {
      background: #272727;
      color: #fff;
    }
    html[dark] #${BTN_ID}.active {
      background: #3ea6ff;
      color: #0f0f0f;
    }
    #${OVERLAY_ID} {
      position: fixed;
      inset: 0;
      background: #000;
      z-index: 999999;
      cursor: pointer;
    }

    /* --- Full-sized theater mode ---
       YouTube's own theater mode caps the player at a modest max height.
       This stretches it to fill the whole visible browser frame below the
       top bar (same technique the "BigTube" extension uses). */
    @media (min-width: 882px) {
      ytd-app ytd-watch:not([fullscreen])[theater] #player.ytd-watch,
      ytd-app ytd-watch-flexy:not([fullscreen])[theater] #player-theater-container.ytd-watch-flexy,
      ytd-app ytd-watch-flexy:not([fullscreen])[theater] #player-wide-container.ytd-watch-flexy,
      ytd-app ytd-watch-flexy:not([fullscreen])[theater] #full-bleed-container.ytd-watch-flexy,
      ytd-app ytd-watch-flexy:not([fullscreen])[full-bleed-player] #full-bleed-container.ytd-watch-flexy,
      ytd-app ytd-watch-flexy[full-bleed-player][respect-aspect-ratio]:not([fullscreen]) #full-bleed-container.ytd-watch-flexy,
      ytd-app ytd-watch-flexy:not([fullscreen])[theater] #player-full-bleed-container.ytd-watch-flexy {
        height: calc(100vh - 56px) !important;
        max-height: calc(100vh - 56px) !important;
      }
      ytd-app ytd-watch-grid:not([fullscreen])[theater] #player-full-bleed-container.ytd-watch-grid {
        height: calc(100vh - 56px) !important;
        max-height: calc(100vh - 56px) !important;
      }
    }

    /* --- Hide related videos (sidebar + end-of-video grid) --- */
    html.yt-focus-hide-related ytd-watch-next-secondary-results-renderer,
    html.yt-focus-hide-related #secondary #related,
    html.yt-focus-hide-related #movie_player .html5-endscreen,
    html.yt-focus-hide-related #movie_player .videowall-endscreen {
      display: none !important;
    }

    /* --- Mini player ---
       Pins YouTube's own player to a corner, shown in the browser's top
       layer (popover) so no page element can cover it. Every control is
       hidden except a thin seek bar; a click on the picture plays/pauses.
       The height follows the video's own aspect ratio (no black bars) and
       narrow windows shrink it to fit. */
    body.${MINI_CLASS} #movie_player:not(.ytp-fullscreen) {
      position: fixed !important;
      ${miniV === 'top' ? `top: ${CONFIG.miniPlayerMargin}px !important; bottom: auto !important;` : `bottom: ${CONFIG.miniPlayerMargin}px !important; top: auto !important;`}
      ${miniH === 'left' ? `left: ${CONFIG.miniPlayerMargin}px !important; right: auto !important;` : `right: ${CONFIG.miniPlayerMargin}px !important; left: auto !important;`}
      --yt-focus-mini-w: min(${CONFIG.miniPlayerWidth}px, calc(100vw - ${2 * CONFIG.miniPlayerMargin}px));
      width: var(--yt-focus-mini-w) !important;
      height: calc(var(--yt-focus-mini-w) * var(--yt-focus-mini-ratio, ${CONFIG.miniPlayerHeight / CONFIG.miniPlayerWidth})) !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      transform: none !important;
      z-index: 2198 !important;
      opacity: 1 !important;
      color: inherit !important;
      background: #000 !important;
      border-radius: 8px !important;
      overflow: hidden !important;
      box-shadow: 0 4px 24px rgba(0, 0, 0, .5);
      cursor: pointer !important;
    }
    /* The video's wrapper normally has no height of its own (the player
       sizes the <video> in pixels), so make both fill the mini player. */
    body.${MINI_CLASS} #movie_player:not(.ytp-fullscreen) .html5-video-container {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
    }
    body.${MINI_CLASS} #movie_player:not(.ytp-fullscreen) video.html5-main-video {
      position: absolute !important;
      left: 0 !important;
      top: 0 !important;
      width: 100% !important;
      height: 100% !important;
      margin: 0 !important;
      object-fit: cover !important;
    }
    /* No controls, overlays, end screens or watermark; captions stay. */
    body.${MINI_CLASS} #movie_player:not(.ytp-fullscreen) > :not(.html5-video-container):not(#ytp-caption-window-container):not(#${MINI_BAR_ID}) {
      display: none !important;
    }
    /* Fallback for browsers without popover support: lift ancestors that
       form their own stacking layer so the comments don't cover it. */
    body.${MINI_CLASS} [data-yt-focus-lift] {
      z-index: 2198 !important;
    }
    body.${MINI_CLASS} [data-yt-focus-lift="static"] {
      position: relative !important;
    }

    /* Seek bar along the bottom edge of the mini player. */
    #${MINI_BAR_ID} {
      display: none;
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 12px;            /* hit area; the visible track is thinner */
      z-index: 100;
      cursor: pointer;
      touch-action: none;
    }
    body.${MINI_CLASS} #movie_player:not(.ytp-fullscreen) #${MINI_BAR_ID} {
      display: block;
    }
    #${MINI_BAR_ID} .yt-focus-track {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 4px;
      background: rgba(255, 255, 255, .3);
      transition: height .1s;
    }
    #${MINI_BAR_ID}:hover .yt-focus-track,
    #${MINI_BAR_ID}.dragging .yt-focus-track {
      height: 7px;
    }
    #${MINI_BAR_ID} .yt-focus-loaded,
    #${MINI_BAR_ID} .yt-focus-played {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 0;
    }
    #${MINI_BAR_ID} .yt-focus-loaded {
      background: rgba(255, 255, 255, .4);
    }
    #${MINI_BAR_ID} .yt-focus-played {
      background: #f03;
    }

    /* --- Screenshot button: sized to match its neighbours (syncShotSize) --- */
    #${SHOT_ID} {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      vertical-align: top;
    }
    #${SHOT_ID} svg {
      display: block;
      flex: none;
    }
  `;
  // At document-start the <html> element may not exist yet.
  function injectStyle() {
    const root = document.documentElement;
    if (!root) return false;
    (document.head || root).appendChild(style);
    if (CONFIG.hideRelated && !isEmbed) root.classList.add('yt-focus-hide-related');
    return true;
  }
  if (!injectStyle()) {
    const waitForRoot = new MutationObserver(() => {
      if (injectStyle()) waitForRoot.disconnect();
    });
    waitForRoot.observe(document, { childList: true });
  }

  function getPlayer() {
    return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  }

  function isWatchPage() {
    return location.pathname === '/watch';
  }

  // ------------------------------------------------------------------
  // Automatic quality: applied once per video, so picking another quality
  // from YouTube's gear menu sticks for the rest of that video.
  // ------------------------------------------------------------------
  const QUALITY_ORDER = ['highres', 'hd2880', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
  const QUALITY_HEIGHT = {
    highres: 4320, hd2880: 2880, hd2160: 2160, hd1440: 1440, hd1080: 1080,
    hd720: 720, large: 480, medium: 360, small: 240, tiny: 144,
  };
  let qualityAppliedFor = null;

  function targetQuality() {
    if (isEmbed) return CONFIG.qualityEmbeds;
    return new URLSearchParams(location.search).has('list') ? CONFIG.qualityPlaylists : CONFIG.qualityVideos;
  }

  function applyQuality() {
    const p = getPlayer();
    if (!p || typeof p.getAvailableQualityLevels !== 'function' || typeof p.getVideoData !== 'function') return false;
    if (p.classList.contains('ad-showing')) return false; // wait for the real video
    const videoId = p.getVideoData().video_id;
    if (!videoId) return false;
    if (videoId === qualityAppliedFor) return true;
    const levels = p.getAvailableQualityLevels();
    if (!levels || !levels.length) return false;

    // Wanted quality, or the best available one below it.
    const want = targetQuality();
    const start = Math.max(0, QUALITY_ORDER.indexOf(want));
    const q = QUALITY_ORDER.slice(start).find((l) => levels.includes(l)) || levels[0];

    if (typeof p.setPlaybackQualityRange === 'function') p.setPlaybackQualityRange(q, q);
    if (typeof p.setPlaybackQuality === 'function') p.setPlaybackQuality(q);
    try {
      const now = Date.now();
      localStorage.setItem('yt-player-quality', JSON.stringify({
        data: JSON.stringify({ quality: QUALITY_HEIGHT[q] || 1080, previousQuality: QUALITY_HEIGHT[q] || 1080 }),
        creation: now,
        expiration: now + 31104e6,
      }));
    } catch (e) { /* storage blocked */ }
    qualityAppliedFor = videoId;
    console.debug('[YT Focus] quality set to', q, 'for', videoId);
    return true;
  }

  // ------------------------------------------------------------------
  // Autoplay next video: switched off once per video, so turning it back
  // on by hand is respected until the next video loads.
  // ------------------------------------------------------------------
  let autoplayHandledFor = null;

  function disableAutoplay() {
    if (isEmbed || !isWatchPage()) return true;
    const p = getPlayer();
    const videoId = p && typeof p.getVideoData === 'function' ? p.getVideoData().video_id : null;
    if (!videoId) return false;
    if (videoId === autoplayHandledFor) return true;
    const toggle = document.querySelector('#movie_player .ytp-autonav-toggle-button');
    if (!toggle) return false;
    if (toggle.getAttribute('aria-checked') === 'true') {
      toggle.click();
      console.debug('[YT Focus] autoplay turned off');
    }
    try {
      sessionStorage.setItem('yt-player-autonavstate', JSON.stringify({ data: '1', creation: Date.now() }));
    } catch (e) { /* storage blocked */ }
    autoplayHandledFor = videoId;
    return true;
  }

  // ------------------------------------------------------------------
  // Screenshot button, placed just left of the Autoplay toggle.
  // ------------------------------------------------------------------
  function makeScreenshotButton() {
    const NS = 'http://www.w3.org/2000/svg';
    const btn = document.createElement('button');
    btn.id = SHOT_ID;
    btn.className = 'ytp-button';
    btn.type = 'button';
    btn.title = 'Screenshot';
    btn.setAttribute('aria-label', 'Screenshot');
    // Outlined camera (Material "photo_camera" outline); the viewBox hugs
    // the glyph so syncShotSize can size it to match its neighbours.
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '2 2 20 18');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '18');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', '#fff');
    path.setAttribute('d',
      'M20 4h-3.17L15 2H9L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6' +
      'h4.05l1.83-2h4.24l1.83 2H20v12zM12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0 8' +
      'c-1.65 0-3-1.35-3-3s1.35-3 3-3 3 1.35 3 3-1.35 3-3 3z');
    svg.appendChild(path);
    btn.appendChild(svg);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      takeScreenshot();
    });
    return btn;
  }

  // YouTube's control bar layout differs between UI versions (classic bar
  // vs. the newer rounded "pill" controls), so copy a neighbouring button:
  // its box size, the size of the icon as actually drawn, and its colour.
  function syncShotSize() {
    const btn = document.getElementById(SHOT_ID);
    if (!btn || !btn.parentElement) return false;
    const controls = btn.closest('.ytp-right-controls') || btn.parentElement;
    const ref = ['.ytp-settings-button', '.ytp-subtitles-button', '.ytp-fullscreen-button']
      .map((sel) => controls.querySelector(sel))
      .find((el) => el && el.offsetWidth > 0 && el.querySelector('svg'));
    if (!ref) return false;

    // Visible glyph = union of the icon's painted shapes (skipping
    // invisible full-size padding paths).
    let glyph = null;
    let color = null;
    for (const shape of ref.querySelectorAll('svg path, svg use, svg rect, svg circle')) {
      const st = getComputedStyle(shape);
      const paint = st.fill !== 'none' ? st.fill : st.stroke !== 'none' ? st.stroke : null;
      if (!paint || shape.closest('defs')) continue;
      const r = shape.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (!color && !shape.classList.contains('ytp-svg-shadow')) color = paint;
      glyph = glyph
        ? { left: Math.min(glyph.left, r.left), top: Math.min(glyph.top, r.top),
            right: Math.max(glyph.right, r.right), bottom: Math.max(glyph.bottom, r.bottom) }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    if (!glyph) return false;

    const rb = ref.getBoundingClientRect();
    const cs = getComputedStyle(ref);
    btn.style.boxSizing = 'border-box';
    btn.style.width = rb.width + 'px';
    btn.style.height = rb.height + 'px';
    btn.style.padding = '0';
    btn.style.margin = cs.margin;
    btn.style.opacity = cs.opacity;

    // Camera glyph is 20x18; make it as wide as the reference glyph is tall
    // or wide (whichever is larger), so it reads at the same weight.
    const size = Math.max(glyph.right - glyph.left, glyph.bottom - glyph.top);
    const svg = btn.querySelector('svg');
    svg.style.width = size + 'px';
    svg.style.height = (size * 18 / 20) + 'px';
    if (color) svg.querySelector('path').setAttribute('fill', color);
    return true;
  }

  function insertScreenshotButton() {
    if (!CONFIG.screenshotButton) return true;
    if (document.getElementById(SHOT_ID)) return true;
    const rightControls = document.querySelector('#movie_player .ytp-right-controls');
    if (!rightControls) return false;
    const toggle = rightControls.querySelector('.ytp-autonav-toggle-button');
    const autonav = toggle && (toggle.closest('button') || toggle.parentElement);
    if (autonav && autonav.parentElement) {
      autonav.parentElement.insertBefore(makeScreenshotButton(), autonav);
    } else {
      rightControls.insertBefore(makeScreenshotButton(), rightControls.firstChild);
    }
    retry(syncShotSize, 10, 300);
    return true;
  }

  function formatTime(sec) {
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return (h ? h + '-' + pad(m) : String(m)) + '-' + pad(s);
  }

  function takeScreenshot() {
    const video = document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video');
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const p = getPlayer();
    const title = (p && typeof p.getVideoData === 'function' && p.getVideoData().title) ||
      document.title.replace(/ - YouTube$/, '') || 'YouTube';
    const name = `${title} ${formatTime(video.currentTime)}`.replace(/[\\/:*?"<>|]+/g, '_').trim() + '.png';
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, 'image/png');
  }

  // ------------------------------------------------------------------
  // Mini player: when the player scrolls out of view (reading comments),
  // pin it to a corner with no controls; clicking it plays/pauses.
  // ------------------------------------------------------------------
  let miniScheduled = false;

  function playerSlot(p) {
    // The page container that keeps its size while #movie_player is pinned.
    const watch = document.querySelector('ytd-watch-flexy, ytd-watch-grid');
    if (!watch) return null;
    for (const sel of ['#player-full-bleed-container', '#full-bleed-container', '#player-container-outer', '#player']) {
      const el = watch.querySelector(sel);
      if (el && el.contains(p) && el.offsetHeight > 0) return el;
    }
    return null;
  }

  // A pinned element can't paint above content outside an ancestor that
  // forms its own stacking layer (this is what made the mini player show
  // behind the comments in narrow windows). Mark those ancestors so the
  // CSS can raise them while the mini player is on.
  function liftAncestors(p) {
    for (let el = p.parentElement; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.zIndex !== 'auto' || cs.isolation === 'isolate' || cs.opacity !== '1' || cs.mixBlendMode !== 'normal') {
        el.setAttribute('data-yt-focus-lift', cs.position === 'static' ? 'static' : '');
      }
    }
  }

  function clearLift() {
    for (const el of document.querySelectorAll('[data-yt-focus-lift]')) el.removeAttribute('data-yt-focus-lift');
  }

  // The browser's top layer (popover API) sits above every page element,
  // whatever stacking layers or transforms its ancestors have, and is
  // always positioned against the window.
  function setMini(on) {
    if (document.body.classList.contains(MINI_CLASS) === on) return;
    const p = getPlayer();
    if (on && p) {
      updateMiniRatio();
      insertMiniBar();
      if (typeof p.showPopover === 'function') {
        p.setAttribute('popover', 'manual');
        try { p.showPopover(); } catch (e) { p.removeAttribute('popover'); liftAncestors(p); }
      } else {
        liftAncestors(p);
      }
    }
    document.body.classList.toggle(MINI_CLASS, on);
    if (!on) {
      if (p && p.hasAttribute('popover')) {
        try { p.hidePopover(); } catch (e) { /* already hidden */ }
        p.removeAttribute('popover');
      }
      clearLift();
    }
    updateMiniBar();
    // Let the player re-measure itself for the new size.
    window.dispatchEvent(new Event('resize'));
  }

  // Match the mini player's shape to the video (e.g. 2:1 videos get a
  // 640x320 player instead of black bars).
  function updateMiniRatio() {
    const video = document.querySelector('#movie_player video.html5-main-video');
    if (!video || !video.videoWidth || !video.videoHeight) return;
    document.documentElement.style.setProperty('--yt-focus-mini-ratio', String(video.videoHeight / video.videoWidth));
  }

  // --- Seek bar ---
  let barDragging = false;
  let barJustDragged = false;

  function insertMiniBar() {
    if (!CONFIG.miniPlayer || document.getElementById(MINI_BAR_ID)) return true;
    const p = document.querySelector('ytd-player #movie_player');
    if (!p) return false;
    const bar = document.createElement('div');
    bar.id = MINI_BAR_ID;
    const track = document.createElement('div');
    track.className = 'yt-focus-track';
    for (const cls of ['yt-focus-loaded', 'yt-focus-played']) {
      const el = document.createElement('div');
      el.className = cls;
      track.appendChild(el);
    }
    bar.appendChild(track);
    p.appendChild(bar);
    return true;
  }

  function videoDuration(p, video) {
    const d = typeof p.getDuration === 'function' ? p.getDuration() : 0;
    return d > 0 ? d : (video && isFinite(video.duration) ? video.duration : 0);
  }

  function updateMiniBar(fraction) {
    const bar = document.getElementById(MINI_BAR_ID);
    const p = getPlayer();
    if (!bar || !p || !document.body.classList.contains(MINI_CLASS)) return;
    const video = p.querySelector('video');
    const dur = videoDuration(p, video);
    if (!dur || !video) return;
    const played = fraction !== undefined ? fraction : video.currentTime / dur;
    let loaded = 0;
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= video.currentTime + 0.5) loaded = Math.max(loaded, b.end(i));
    }
    bar.querySelector('.yt-focus-played').style.width = (Math.min(1, played) * 100) + '%';
    bar.querySelector('.yt-focus-loaded').style.width = (Math.min(1, loaded / dur) * 100) + '%';
  }

  function barFraction(e) {
    const r = document.getElementById(MINI_BAR_ID).getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

  function seekTo(fraction, final) {
    const p = getPlayer();
    const video = p && p.querySelector('video');
    const dur = p && videoDuration(p, video);
    if (!dur) return;
    if (typeof p.seekTo === 'function') p.seekTo(fraction * dur, final);
    else if (video) video.currentTime = fraction * dur;
    updateMiniBar(fraction);
  }

  function onBarMove(e) {
    if (!barDragging) return;
    seekTo(barFraction(e), false);
  }

  function onBarUp(e) {
    if (!barDragging) return;
    barDragging = false;
    barJustDragged = true;
    setTimeout(() => { barJustDragged = false; }, 0);
    document.getElementById(MINI_BAR_ID).classList.remove('dragging');
    seekTo(barFraction(e), true);
  }

  function updateMiniPlayer() {
    miniScheduled = false;
    const p = getPlayer();
    if (!CONFIG.miniPlayer || !isWatchPage() || !p) return setMini(false);
    const slot = playerSlot(p);
    if (!slot) return setMini(false);
    const r = slot.getBoundingClientRect();
    const visible = r.bottom - 56; // part still showing below the top bar
    const outOfView = window.scrollY > 0 && visible < r.height * 0.12;
    const started = !p.classList.contains('unstarted-mode') && !p.classList.contains('ended-mode');
    setMini(outOfView && started);
  }

  function scheduleMiniUpdate() {
    if (miniScheduled) return;
    miniScheduled = true;
    requestAnimationFrame(updateMiniPlayer);
  }

  // In the mini player a click anywhere on the picture plays/pauses, and
  // YouTube's own click/double-click handling (fullscreen etc.) is blocked.
  function onMiniPointer(e) {
    if (!document.body.classList.contains(MINI_CLASS)) return;
    const p = getPlayer();
    if (!p || p.classList.contains('ytp-fullscreen') || !p.contains(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (barDragging) {
      if (e.type === 'pointerup') onBarUp(e);
      return;
    }
    if (barJustDragged && e.type === 'click') {
      barJustDragged = false; // the click that ends a drag isn't play/pause
      return;
    }
    const bar = document.getElementById(MINI_BAR_ID);
    if (bar && bar.contains(e.target)) {
      if (e.type === 'pointerdown' && e.button === 0) {
        barDragging = true;
        bar.classList.add('dragging');
        seekTo(barFraction(e), false);
      }
      return;
    }
    if (e.type !== 'click' || e.button !== 0) return;
    const video = p.querySelector('video');
    const playing = typeof p.getPlayerState === 'function' ? [1, 3].includes(p.getPlayerState()) : video && !video.paused;
    if (playing) {
      if (typeof p.pauseVideo === 'function') p.pauseVideo(); else if (video) video.pause();
    } else if (typeof p.playVideo === 'function') {
      p.playVideo();
    } else if (video) {
      video.play();
    }
  }

  // ------------------------------------------------------------------
  // Focus mode + full-sized theater mode
  // ------------------------------------------------------------------
  function findSubscribeAnchor() {
    // Try several selectors since YouTube's DOM shifts between rollouts.
    const selectors = [
      '#subscribe-button',
      'ytd-subscribe-button-renderer',
      '#owner-sub-count',
      '#top-row #subscribe-button',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el; // must be visible/attached
    }
    return null;
  }

  function makeButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = 'Focus';
    btn.title = 'Dim page, click anywhere to exit';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setFocusMode(!focusOn);
    });
    return btn;
  }

  function insertButton() {
    if (document.getElementById(BTN_ID)) return true;
    const anchor = findSubscribeAnchor();
    if (!anchor || !anchor.parentElement) {
      console.debug('[YT Focus] subscribe anchor not found yet');
      return false;
    }
    anchor.parentElement.insertBefore(makeButton(), anchor.nextSibling);
    console.debug('[YT Focus] button inserted next to', anchor);
    return true;
  }

  // Keep retrying for a while after each attempt, since the owner row can
  // render slightly after the rest of the page (and after yt-navigate-finish).
  function retry(task, maxTries = 20, delayMs = 500) {
    let tries = 0;
    const id = setInterval(() => {
      tries++;
      if (task() || tries >= maxTries) clearInterval(id);
    }, delayMs);
  }

  // Turns on YouTube's native Theater mode (the wide/full-sized player view)
  // so every video opens full-sized by default. Only forces it ONCE per page
  // load/navigation — if you manually switch back to default view afterward,
  // the script won't fight you and re-enable it.
  function enableTheaterMode() {
    if (!isWatchPage()) return true; // nothing to do here, stop retrying
    const flexy = document.querySelector('ytd-watch-flexy');
    if (!flexy) return false; // page not ready yet
    if (flexy.hasAttribute('theater')) return true; // already in theater mode
    const sizeBtn = document.querySelector('.ytp-size-button');
    if (!sizeBtn) return false; // player controls not ready yet
    sizeBtn.click();
    console.debug('[YT Focus] theater mode enabled');
    return true;
  }

  function getPlayerRect() {
    const player = getPlayer();
    if (player) return player.getBoundingClientRect();
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    return video ? video.getBoundingClientRect() : null;
  }

  // Cuts a transparent rectangular hole in the overlay exactly over the
  // player, using an evenodd clip-path (outer full-screen path + inner
  // player-shaped path). This avoids z-index/stacking-context fights
  // entirely, since the "hole" area simply isn't covered by anything.
  function updateOverlayClip() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    const r = getPlayerRect();
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!r || r.width === 0 || r.height === 0) {
      overlay.style.clipPath = 'none';
      return;
    }
    const path =
      `M0,0 H${w} V${h} H0 Z ` +
      `M${r.left},${r.top} H${r.right} V${r.bottom} H${r.left} Z`;
    overlay.style.clipPath = `path(evenodd, "${path}")`;
  }

  function startClipLoop() {
    const step = () => {
      updateOverlayClip();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  function stopClipLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function setFocusMode(on) {
    focusOn = on;
    const btn = document.getElementById(BTN_ID);

    if (on) {
      if (btn) {
        btn.classList.add('active');
        btn.textContent = 'Focus: ON';
      }

      if (!document.getElementById(OVERLAY_ID)) {
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.addEventListener('click', () => setFocusMode(false));
        document.body.appendChild(overlay);
      }
      updateOverlayClip();
      startClipLoop(); // keeps the hole aligned through theater-mode toggles, sidebar collapse, etc.
      document.addEventListener('keydown', escListener);
    } else {
      if (btn) {
        btn.classList.remove('active');
        btn.textContent = 'Focus';
      }
      const overlay = document.getElementById(OVERLAY_ID);
      if (overlay) overlay.remove();
      stopClipLoop();
      document.removeEventListener('keydown', escListener);
    }
  }

  function escListener(e) {
    if (e.key === 'Escape') setFocusMode(false);
  }

  // ------------------------------------------------------------------
  // Startup
  // ------------------------------------------------------------------

  // Each new video (including SPA navigations and the next playlist item)
  // fires loadeddata on the <video>; media events don't bubble, so listen
  // in the capture phase.
  document.addEventListener('loadeddata', () => {
    retry(applyQuality, 20, 250);
    retry(disableAutoplay, 10, 500);
  }, true);

  function init() {
    retry(applyQuality, 40, 250);
    retry(insertScreenshotButton);
    window.addEventListener('resize', () => setTimeout(syncShotSize, 100));
    document.addEventListener('fullscreenchange', () => setTimeout(syncShotSize, 300));
    if (isEmbed) return;

    retry(insertButton);
    retry(enableTheaterMode);
    retry(disableAutoplay);

    document.addEventListener('yt-navigate-finish', () => {
      // Turn off focus mode when navigating to a new video/page
      setFocusMode(false);
      const existing = document.getElementById(BTN_ID);
      if (existing) existing.remove();
      retry(insertButton);
      retry(enableTheaterMode);
      retry(insertScreenshotButton);
        scheduleMiniUpdate();
    });

    window.addEventListener('scroll', scheduleMiniUpdate, { passive: true });
    window.addEventListener('resize', scheduleMiniUpdate, { passive: true });
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      window.addEventListener(type, onMiniPointer, true);
    }
    window.addEventListener('pointermove', onBarMove, true);
    window.addEventListener('pointerup', onBarUp, true);
    window.addEventListener('pointercancel', onBarUp, true);
    // Media events don't bubble; listen in the capture phase.
    document.addEventListener('timeupdate', () => { if (!barDragging) updateMiniBar(); }, true);
    document.addEventListener('progress', () => { if (!barDragging) updateMiniBar(); }, true);
    document.addEventListener('loadedmetadata', updateMiniRatio, true);
    document.addEventListener('resize', updateMiniRatio, true); // <video> size change
    document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) setMini(false); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Fallback: watch DOM in case our buttons get wiped by a re-render
  const observer = new MutationObserver(() => {
    if (CONFIG.screenshotButton && !document.getElementById(SHOT_ID)) insertScreenshotButton();
    if (isEmbed || !isWatchPage()) return;
    if (!document.getElementById(BTN_ID)) insertButton();
  });
  observer.observe(document, { childList: true, subtree: true });
})();
