// ==UserScript==
// @name         YouTube Focus Mode + Full-Sized Theater Mode
// @namespace    https://tampermonkey.net/
// @version      2.0.0
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
  const MINI_CLOSE_ID = 'yt-focus-mini-close';
  const MINI_CLASS = 'yt-focus-mini-player';
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

    /* --- Mini player --- */
    body.${MINI_CLASS} ytd-player #movie_player:not(.ytp-fullscreen) {
      position: fixed !important;
      ${miniV === 'top' ? 'top: 72px !important; bottom: auto !important;' : 'bottom: 16px !important; top: auto !important;'}
      ${miniH === 'left' ? 'left: 16px !important; right: auto !important;' : 'right: 16px !important; left: auto !important;'}
      width: ${CONFIG.miniPlayerWidth}px !important;
      height: ${CONFIG.miniPlayerHeight}px !important;
      z-index: 2198 !important;
      background: #000 !important;
      border-radius: 8px !important;
      overflow: hidden !important;
      box-shadow: 0 4px 24px rgba(0, 0, 0, .5);
    }
    body.${MINI_CLASS} #movie_player:not(.ytp-fullscreen) video.html5-main-video {
      width: 100% !important;
      height: 100% !important;
      left: 0 !important;
      top: 0 !important;
      margin-left: 0 !important;
    }
    body.${MINI_CLASS} #movie_player:not(.ytp-fullscreen) .ytp-chrome-bottom {
      width: calc(100% - 24px) !important;
      left: 12px !important;
    }
    body.${MINI_CLASS} #movie_player:not(.ytp-fullscreen) .ytp-size-button,
    body.${MINI_CLASS} #movie_player:not(.ytp-fullscreen) .ytp-ce-element,
    body.${MINI_CLASS} #movie_player:not(.ytp-fullscreen) .ytp-iv-player-content {
      display: none !important;
    }
    #${MINI_CLOSE_ID} {
      display: none;
      position: absolute;
      top: 8px;
      ${miniH === 'left' ? 'right' : 'left'}: 8px;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 50%;
      background: rgba(0, 0, 0, .6);
      color: #fff;
      font-size: 18px;
      line-height: 28px;
      text-align: center;
      cursor: pointer;
      z-index: 70;
      padding: 0;
    }
    body.${MINI_CLASS} #movie_player:not(.ytp-fullscreen):not(.ytp-autohide) #${MINI_CLOSE_ID} {
      display: block;
    }

    /* --- Screenshot button --- */
    #${SHOT_ID} svg {
      width: 100%;
      height: 100%;
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
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', '#fff');
    path.setAttribute('d',
      'M15 10l-1.8 2H10a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V14a2 2 0 0 0-2-2h-3.2L21 10h-6z' +
      'm3 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z');
    svg.appendChild(path);
    btn.appendChild(svg);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      takeScreenshot();
    });
    return btn;
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
  // pin it to a corner. The × button hides it until you scroll back up.
  // ------------------------------------------------------------------
  let miniDismissed = false;
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

  function setMini(on) {
    if (document.body.classList.contains(MINI_CLASS) === on) return;
    document.body.classList.toggle(MINI_CLASS, on);
    // Let the player re-measure itself for the new size.
    window.dispatchEvent(new Event('resize'));
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
    if (!outOfView) miniDismissed = false;
    const started = !p.classList.contains('unstarted-mode') && !p.classList.contains('ended-mode');
    setMini(outOfView && started && !miniDismissed);
  }

  function scheduleMiniUpdate() {
    if (miniScheduled) return;
    miniScheduled = true;
    requestAnimationFrame(updateMiniPlayer);
  }

  function insertMiniClose() {
    if (!CONFIG.miniPlayer || document.getElementById(MINI_CLOSE_ID)) return true;
    const p = document.querySelector('ytd-player #movie_player');
    if (!p) return false;
    const btn = document.createElement('button');
    btn.id = MINI_CLOSE_ID;
    btn.type = 'button';
    btn.title = 'Close mini player';
    btn.textContent = '×';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      miniDismissed = true;
      setMini(false);
    });
    p.appendChild(btn);
    return true;
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
    if (isEmbed) return;

    retry(insertButton);
    retry(enableTheaterMode);
    retry(disableAutoplay);
    retry(insertMiniClose);

    document.addEventListener('yt-navigate-finish', () => {
      // Turn off focus mode when navigating to a new video/page
      setFocusMode(false);
      miniDismissed = false;
      const existing = document.getElementById(BTN_ID);
      if (existing) existing.remove();
      retry(insertButton);
      retry(enableTheaterMode);
      retry(insertScreenshotButton);
      retry(insertMiniClose);
      scheduleMiniUpdate();
    });

    window.addEventListener('scroll', scheduleMiniUpdate, { passive: true });
    window.addEventListener('resize', scheduleMiniUpdate, { passive: true });
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
    if (CONFIG.miniPlayer && !document.getElementById(MINI_CLOSE_ID)) insertMiniClose();
  });
  observer.observe(document, { childList: true, subtree: true });
})();
