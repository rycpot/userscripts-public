// ==UserScript==
// @name         YouTube Comment Search
// @namespace    https://tampermonkey.net/
// @version      2.2.0
// @description  Adds a search box to a video's comment section (Cmd+S / Ctrl+S jumps to it). Uses your own YouTube Data API key. Highlights matches, expands reply threads, makes timestamps clickable, and supports /regex/, :creator and global: (whole channel).
// @author       you
// @icon         https://www.youtube.com/favicon.ico
// @match        https://www.youtube.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      www.googleapis.com
// @run-at       document-start
// @noframes
// @downloadURL  https://raw.githubusercontent.com/rycpot/userscripts-public/main/youtube-comment-search.user.js
// @updateURL    https://raw.githubusercontent.com/rycpot/userscripts-public/main/youtube-comment-search.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  const CONFIG = {
    // Videos with up to this many comments are downloaded once (100 per
    // API request, 1 quota unit each) so search is complete and instant and
    // /regex/ and :creator work. Bigger videos use YouTube's own search.
    maxLoadComments: 10000,
    fetchAllReplies: true,  // YouTube only includes 5 replies per thread; fetch the rest
    replyConcurrency: 6,    // reply threads fetched at the same time
    searchPages: 10,        // YouTube-search pages (100 threads each) for big videos
    pageSize: 50,          // results rendered per scroll step
    // Downloaded comments are saved in this browser for the videos you
    // searched most recently. On the next visit only new comments are
    // fetched; a full re-download (fresh likes and replies) happens once
    // the saved copy is older than cacheFullRefreshHours.
    cacheVideos: 20,
    cacheFullRefreshHours: 24,
  };

  const API = 'https://www.googleapis.com/youtube/v3';
  const KEY_STORE = 'ytcsApiKey';

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function svgIcon(d) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  const ICON_X = 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';
  const ICON_CHECK = 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM9.92 17.93l-4.95-4.95 2.05-2.05 2.9 2.9 7.35-7.35 2.05 2.05-9.4 9.45z';
  const ICON_LIKE = 'M18.77 11h-4.23l1.52-4.94C16.38 5.03 15.54 4 14.38 4c-.58 0-1.14.24-1.52.65L7 11H3v10h4h1h9.43c1.06 0 1.98-.67 2.19-1.61l1.34-6C21.23 12.15 20.18 11 18.77 11zM7 20H4v-8h3V20zM19.98 13.17l-1.34 6C18.54 19.65 18.03 20 17.43 20H8v-8.61l5.6-6.06C13.79 5.12 14.08 5 14.38 5c.26 0 .5.11.63.3.07.1.15.26.09.47l-1.52 4.94L13.18 12h1.35h4.23c.41 0 .8.17 1.03.46.13.15.26.4.19.71z';

  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  const fmtCount = (n) => compact.format(n || 0);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  function timeAgo(iso) {
    const s = (new Date(iso).getTime() - Date.now()) / 1000;
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [u, sec] of units) {
      if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), u);
    }
    return rtf.format(0, 'second');
  }

  function normalize(s) {
    return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function tokenize(s) {
    return [...new Set(normalize(s).match(/[\p{L}\p{N}]+/gu) || [])];
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // "1:02:03" / "12:34" -> seconds
  function hms(s) {
    return s.split(':').reduce((t, p) => t * 60 + Number(p), 0);
  }
  const TIME_RE = /\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/g;
  const URL_RE = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,!?;:'"]/g;

  function isoDuration(d) {
    const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || [];
    return ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }

  function videoId() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  // ------------------------------------------------------------------
  // YouTube Data API
  // ------------------------------------------------------------------
  class ApiError extends Error {
    constructor(reason, message) {
      super(message || reason);
      this.reason = reason;
    }
  }

  function apiGet(path, params, key = GM_getValue(KEY_STORE, '')) {
    if (!key) return Promise.reject(new ApiError('noKey'));
    const qs = new URLSearchParams({ ...params, key });
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${API}/${path}?${qs}`,
        responseType: 'json',
        timeout: 20000,
        onload: (r) => {
          let data = r.response;
          if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (e) { data = null; }
          }
          if (!data && r.responseText) {
            try { data = JSON.parse(r.responseText); } catch (e) { data = null; }
          }
          if (data && data.error) {
            const e = data.error;
            const reason = (e.errors && e.errors[0] && e.errors[0].reason) ||
              (e.details && e.details[0] && e.details[0].reason) || e.status || 'error';
            return reject(new ApiError(reason, e.message));
          }
          if (r.status < 200 || r.status >= 300 || !data) return reject(new ApiError('http', `HTTP ${r.status}`));
          resolve(data);
        },
        onerror: () => reject(new ApiError('network')),
        ontimeout: () => reject(new ApiError('network')),
      });
    });
  }

  function errorText(err) {
    const r = err && err.reason;
    if (r === 'noKey') return 'Add your YouTube Data API key to start searching.';
    if (/keyInvalid|API_KEY_INVALID|badRequest/i.test(r || '') && /key/i.test(err.message || r))
      return 'Your API key was rejected. Type /key to change it.';
    if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(r || ''))
      return 'Your API key has used up its daily quota. It resets at midnight Pacific time.';
    if (/commentsDisabled/i.test(r || '')) return 'Comments are turned off for this video.';
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(r || ''))
      return 'YouTube Data API v3 is not enabled for this key\'s Google Cloud project.';
    if (/forbidden|API_KEY_HTTP_REFERRER_BLOCKED|ipRefererBlocked/i.test(r || ''))
      return 'Your API key is not allowed here. Check its restrictions in Google Cloud.';
    if (r === 'network') return 'Couldn\'t reach YouTube\'s API. Check your connection.';
    if (/processingFailure|backendError|internalError/i.test(r || ''))
      return 'YouTube\'s comment search failed for this video. Try again, or try different keywords.';
    const msg = String((err && err.message) || r || '').replace(/<[^>]+>/g, '');
    return `Something went wrong: ${msg}`;
  }

  function toComment(snippet, id) {
    return {
      id,
      author: snippet.authorDisplayName || '',
      authorUrl: snippet.authorChannelUrl || '',
      authorImg: snippet.authorProfileImageUrl || '',
      authorId: (snippet.authorChannelId && snippet.authorChannelId.value) || '',
      text: snippet.textOriginal != null ? snippet.textOriginal : (snippet.textDisplay || ''),
      likes: snippet.likeCount || 0,
      published: snippet.publishedAt,
      edited: !!snippet.updatedAt && new Date(snippet.updatedAt) - new Date(snippet.publishedAt) > 60000,
      videoId: snippet.videoId || '',
      parentId: snippet.parentId || '',
    };
  }

  function toThread(item) {
    const top = toComment(item.snippet.topLevelComment.snippet, item.snippet.topLevelComment.id);
    top.videoId = top.videoId || item.snippet.videoId || '';
    const replies = ((item.replies && item.replies.comments) || [])
      .map((c) => toComment(c.snippet, c.id))
      .sort((a, b) => a.published.localeCompare(b.published));
    return { id: item.id, top, replies, replyCount: item.snippet.totalReplyCount || 0, videoId: top.videoId };
  }

  // Per-video data: details, plus every thread once downloaded.
  const cache = new Map();

  function videoData(id) {
    if (!cache.has(id)) cache.set(id, { id, details: null, threads: null, loading: null, loaded: 0 });
    return cache.get(id);
  }

  async function loadDetails(vd) {
    if (vd.details) return vd.details;
    const res = await apiGet('videos', { part: 'snippet,statistics,contentDetails', id: vd.id });
    const v = res.items && res.items[0];
    if (!v) throw new ApiError('notFound', 'Video not found.');
    const count = v.statistics && v.statistics.commentCount;
    vd.details = {
      channelId: v.snippet.channelId,
      title: v.snippet.title,
      duration: isoDuration(v.contentDetails && v.contentDetails.duration),
      count: count == null ? null : Number(count), // null = comments off
    };
    return vd.details;
  }

  function canLoadAll(details) {
    return details.count != null && details.count > 0 && details.count <= CONFIG.maxLoadComments;
  }

  // --- Saved comments (IndexedDB on youtube.com; index in Tampermonkey) ---
  const CACHE_INDEX = 'ytcsCacheIndex';
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('ytcs-comment-cache', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('videos', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  async function idbDo(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('videos', mode);
      const req = fn(tx.objectStore('videos'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function cacheGet(id) {
    try { return await idbDo('readonly', (st) => st.get(id)); } catch (e) { return null; }
  }

  async function cachePut(record) {
    try {
      await idbDo('readwrite', (st) => st.put(record));
      // Keep only the most recently searched videos.
      const index = (GM_getValue(CACHE_INDEX, []) || []).filter((e) => e.id !== record.id);
      index.unshift({ id: record.id, usedAt: Date.now() });
      const drop = index.splice(CONFIG.cacheVideos);
      GM_setValue(CACHE_INDEX, index);
      if (drop.length) await idbDo('readwrite', (st) => { drop.forEach((e) => st.delete(e.id)); return null; });
    } catch (e) { /* storage unavailable: just don't save */ }
  }

  // Fill in long reply threads (YouTube only includes 5), several at a time.
  async function fillReplies(vd, threads) {
    if (!CONFIG.fetchAllReplies) return;
    const todo = threads.filter((t) => t.replyCount > t.replies.length);
    const worker = async () => {
      while (todo.length) {
        const t = todo.shift();
        try {
          const full = await loadReplies(t.id);
          vd.loaded += full.length - t.replies.length;
          t.replies = full;
        } catch (err) {
          if (/quota|keyInvalid|API_KEY/i.test(err.reason || '')) throw err;
          // otherwise keep the 5 replies we already have
        }
        if (vd.onProgress) vd.onProgress(vd.loaded);
      }
    };
    await Promise.all(Array.from({ length: CONFIG.replyConcurrency }, worker));
  }

  // Newest-first pages until we reach comments we already have.
  async function fetchNewThreads(vd, knownIds) {
    const fresh = [];
    let pageToken;
    for (let page = 0; page < 100; page++) {
      const res = await apiGet('commentThreads', {
        part: 'snippet,replies', videoId: vd.id, maxResults: 100, order: 'time',
        textFormat: 'plainText', ...(pageToken ? { pageToken } : {}),
      });
      const items = (res.items || []).map(toThread);
      const known = items.filter((t) => knownIds.has(t.id)).length;
      for (const t of items) if (!knownIds.has(t.id)) fresh.push(t);
      pageToken = res.nextPageToken;
      // A page that is mostly comments we already have means we've caught up
      // (a pinned or out-of-order comment alone doesn't stop us).
      if (!pageToken || (items.length && known >= items.length / 2)) break;
    }
    return fresh;
  }

  function loadAllThreads(vd, onProgress) {
    if (vd.threads) return Promise.resolve(vd.threads);
    vd.onProgress = onProgress || null;
    if (vd.loading) {
      if (onProgress && vd.loaded) onProgress(vd.loaded);
      return vd.loading;
    }
    vd.loading = (async () => {
      vd.loaded = 0;
      const saved = await cacheGet(vd.id);
      const fresh = saved && Date.now() - saved.fullAt < CONFIG.cacheFullRefreshHours * 3600e3;

      if (fresh) {
        // Reuse the saved copy and add only what's new since.
        let threads = saved.threads;
        vd.loaded = threads.reduce((n, t) => n + 1 + t.replies.length, 0);
        if (vd.onProgress) vd.onProgress(vd.loaded);
        try {
          const added = await fetchNewThreads(vd, new Set(threads.map((t) => t.id)));
          if (added.length) {
            vd.loaded += added.reduce((n, t) => n + 1 + t.replies.length, 0);
            await fillReplies(vd, added);
            threads = [...added, ...threads];
          }
        } catch (err) {
          if (err.reason === 'noKey') throw err;
          // offline / quota: the saved copy is still useful
        }
        vd.savedAt = saved.fullAt;
        vd.threads = threads;
        cachePut({ id: vd.id, fullAt: saved.fullAt, updatedAt: Date.now(), threads });
        return threads;
      }

      const all = [];
      let pageToken;
      do {
        const res = await apiGet('commentThreads', {
          part: 'snippet,replies', videoId: vd.id, maxResults: 100, order: 'time',
          textFormat: 'plainText', ...(pageToken ? { pageToken } : {}),
        });
        for (const item of res.items || []) {
          const t = toThread(item);
          all.push(t);
          vd.loaded += 1 + t.replies.length;
        }
        if (vd.onProgress) vd.onProgress(vd.loaded);
        pageToken = res.nextPageToken;
      } while (pageToken);
      await fillReplies(vd, all);
      vd.savedAt = Date.now();
      vd.threads = all;
      cachePut({ id: vd.id, fullAt: vd.savedAt, updatedAt: vd.savedAt, threads: all });
      return all;
    })();
    vd.loading.catch(() => { vd.loading = null; });
    return vd.loading;
  }


  // YouTube's keyword search. order=relevance together with searchTerms
  // fails ("processingFailure") on many videos, so ask for newest first
  // (we rank the matches ourselves) and fall back once if even that fails.
  // Up to CONFIG.searchPages pages (100 threads, 1 quota unit each).
  async function searchApi(params) {
    const out = [];
    let pageToken;
    let order = 'time';
    for (let page = 0; page < CONFIG.searchPages; page++) {
      let res;
      try {
        res = await apiGet('commentThreads', {
          part: 'snippet,replies', maxResults: 100, textFormat: 'plainText',
          order, ...params, ...(pageToken ? { pageToken } : {}),
        });
      } catch (err) {
        if (page === 0 && order === 'time' && /processingFailure|backendError/i.test(err.reason || '')) {
          order = 'relevance';
          page--;
          continue;
        }
        if (out.length) break; // keep what we already have
        throw err;
      }
      for (const item of res.items || []) out.push(toThread(item));
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async function loadReplies(parentId) {
    const out = [];
    let pageToken;
    do {
      const res = await apiGet('comments', {
        part: 'snippet', parentId, maxResults: 100, textFormat: 'plainText',
        ...(pageToken ? { pageToken } : {}),
      });
      for (const c of res.items || []) out.push(toComment(c.snippet, c.id));
      pageToken = res.nextPageToken;
    } while (pageToken && out.length < 5000);
    return out.sort((a, b) => a.published.localeCompare(b.published));
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------
  // Returns { kind: 'keywords' | 'regexp' | 'creator', tokens, regexp, text, global }.
  function parseQuery(raw) {
    const q = { tokens: [], regexp: null, global: false };
    const re = /^\/(.+)\/([a-z]*)$/i.exec(raw.trim());
    if (re) {
      let flags = re[2].replace(/[gy]/g, '');
      if (!flags.includes('i')) flags += 'i';
      try {
        q.regexp = new RegExp(re[1], flags);
      } catch (e) {
        throw new ApiError('badRegex', 'That regular expression is not valid.');
      }
      q.kind = 'regexp';
      return q;
    }
    let s = raw.trim().toLowerCase();
    if (/^global:/.test(s)) { q.global = true; s = s.replace(/^global:/, '').trim(); }
    if (!q.global && s === ':creator') {
      q.kind = 'creator';
      return q;
    }
    q.tokens = tokenize(s);
    if (!q.tokens.length) throw new ApiError('empty', q.global ? 'Type keywords after global:' : 'Type some keywords.');
    q.kind = 'keywords';
    q.text = s;
    return q;
  }

  function commentsOf(t) {
    return [t.top, ...t.replies];
  }

  // Local search over downloaded threads. Each result is
  // { thread, shown: [replies to show under the top comment], score }.
  function localSearch(threads, q, details) {
    const out = [];
    for (const t of threads) {
      const all = commentsOf(t);
      let match = false;
      let score = 0;
      let shown = [];
      if (q.kind === 'keywords') {
        const perComment = all.map((c) => {
          const n = normalize(c.text);
          return q.tokens.reduce((sum, tok) => sum + (n.split(tok).length - 1), 0);
        });
        const joined = normalize(all.map((c) => c.text).join(' '));
        match = q.tokens.every((tok) => joined.includes(tok));
        score = perComment.reduce((a, b) => a + b, 0);
        shown = t.replies.filter((c, i) => perComment[i + 1] > 0);
      } else {
        const hits = q.kind === 'regexp'
          ? all.map((c) => q.regexp.test(c.text))
          : all.map((c) => !!c.authorId && c.authorId === details.channelId); // :creator
        match = hits.some(Boolean);
        shown = t.replies.filter((c, i) => hits[i + 1]);
      }
      if (match) out.push({ thread: t, shown, score });
    }
    const byLikes = (a, b) => b.thread.top.likes - a.thread.top.likes;
    out.sort(q.kind === 'keywords' ? (a, b) => b.score - a.score || byLikes(a, b) : byLikes);
    return out;
  }

  // ------------------------------------------------------------------
  // Styles. The search bar and results live in a shadow root inside
  // YouTube's comment section; YouTube's theme variables (--yt-spec-*)
  // inherit into it, so it matches light and dark mode automatically.
  // ------------------------------------------------------------------
  const PAGE_CSS = `
    ytd-comments.ytcs-active #sections > #contents,
    ytd-comments.ytcs-active #sections > #continuations { display: none !important; }
    ytd-comments.ytcs-inline:not(.ytcs-show-simplebox) ytd-comments-header-renderer #simple-box { display: none !important; }
    ytd-comments.ytcs-inline:not(.ytcs-show-simplebox) ytd-comments-header-renderer { margin-bottom: 12px !important; }
    .ytcs-compose {
      display: inline-flex; align-items: center; gap: 8px; height: 36px; margin-left: 16px; padding: 0 12px 0 8px;
      border: 0; border-radius: 18px; background: transparent; cursor: pointer;
      color: var(--yt-spec-text-primary, #0f0f0f); font: 500 14px/20px "Roboto", "Arial", sans-serif;
      vertical-align: middle; flex: none;
    }
    .ytcs-compose:hover { background: var(--yt-spec-10-percent-layer, rgba(0,0,0,.1)); }
    .ytcs-compose svg { width: 24px; height: 24px; fill: currentColor; display: block; }
  `;

  const CSS = `
    :host {
      display: block; margin: 0 0 20px;
      --fg: var(--yt-spec-text-primary, #0f0f0f);
      --fg2: var(--yt-spec-text-secondary, #606060);
      --line: var(--yt-spec-10-percent-layer, rgba(0,0,0,.1));
      --chip: var(--yt-spec-badge-chip-background, rgba(0,0,0,.05));
      --hover: var(--yt-spec-10-percent-layer, rgba(0,0,0,.1));
      --blue: var(--yt-spec-call-to-action, #065fd4);
      --inverse: var(--yt-spec-text-primary-inverse, #fff);
      --error: #cc0000;
      --mark: #e1251b; --mark-style: solid;
      color: var(--fg);
      font: 400 14px/20px "Roboto", "Arial", sans-serif;
    }
    :host([inline]) { margin: 0 0 4px; }
    :host([dark]) { --error: #ff6b6b; --mark: orange; --mark-style: dotted; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button, input { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; outline: none; }
    button { cursor: pointer; }
    a { color: inherit; text-decoration: none; cursor: pointer; }
    svg { display: block; width: 100%; height: 100%; fill: currentColor; }
    code { background: var(--chip); border-radius: 4px; padding: 1px 5px; font-family: inherit; font-size: 13px; }

    /* Search bar */
    .bar {
      position: relative; display: flex; align-items: center; gap: 8px;
      height: 40px; padding: 0 6px 0 14px;
      border: 1px solid var(--line); border-radius: 20px;
      transition: border-color .15s, box-shadow .15s;
    }
    .bar:focus-within { border-color: var(--blue); box-shadow: inset 0 0 0 1px var(--blue); }
    .bar .icon { width: 20px; height: 20px; flex: none; color: var(--fg2); }
    .bar input { flex: 1; min-width: 0; height: 100%; font-size: 14px; color: var(--fg); }
    .bar input::placeholder { color: var(--fg2); }
    .count { flex: none; font-size: 12px; color: var(--fg2); white-space: nowrap; }
    .count.ready::before { content: "\\25CF  "; color: var(--blue); }
    .clear { flex: none; width: 30px; height: 30px; padding: 6px; border-radius: 50%; color: var(--fg2); }
    .clear:hover { background: var(--hover); color: var(--fg); }
    .progress { position: absolute; left: 20px; right: 20px; bottom: -1px; height: 2px; overflow: hidden; border-radius: 1px; }
    .progress > div { height: 100%; width: 0; background: var(--blue); }
    .progress.busy > div { width: 30%; animation: slide 1s infinite ease-in-out; }
    .progress.determinate > div { animation: none; transition: width .2s; }
    @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
    .hint { margin: 6px 14px 0; font-size: 12px; line-height: 18px; color: var(--fg2); white-space: nowrap; overflow: hidden; }
    .hint code { font-size: 12px; padding: 0 4px; }
    .hint { display: flex; align-items: center; gap: 6px; }
    .hint .chip {
      display: inline-flex; align-items: center; height: 22px; padding: 0 10px; border-radius: 11px;
      border: 1px solid var(--line); background: var(--chip); color: var(--fg);
      font-size: 12px; line-height: 20px; cursor: pointer; transition: background .1s, border-color .1s;
    }
    .hint .chip:hover { background: var(--hover); border-color: var(--blue); color: var(--blue); }
    .hint .chip:active { transform: translateY(1px); }

    /* Status line + messages */
    .status { display: flex; align-items: center; gap: 12px; margin: 16px 0 8px; color: var(--fg2); }
    .status.error { color: var(--error); }
    .status .show-all { color: var(--blue); font-weight: 500; }
    .status .show-all:hover { text-decoration: underline; }

    /* Results, styled like YouTube's own comments */
    .thread { margin-top: 16px; }
    .comment { display: grid; grid-template-columns: 40px 1fr; column-gap: 16px; }
    .reply-list { margin-left: 56px; }
    .reply-list .comment { grid-template-columns: 24px 1fr; column-gap: 12px; margin-top: 12px; }
    .avatar { display: block; width: 40px; height: 40px; border-radius: 50%; background: var(--chip) center / cover no-repeat; }
    .reply-list .avatar { width: 24px; height: 24px; }
    .head { display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap; margin-bottom: 2px; }
    .name { font-size: 13px; font-weight: 500; line-height: 18px; color: var(--fg); }
    .name.creator { background: var(--chip); border-radius: 12px; padding: 1px 6px; }
    .badge { display: inline-block; width: 12px; height: 12px; margin-left: 2px; vertical-align: -1px; color: var(--fg2); }
    .date { font-size: 12px; line-height: 18px; color: var(--fg2); }
    .date:hover { color: var(--fg); }
    .text { white-space: pre-wrap; word-break: break-word; user-select: text;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }
    .text.open { -webkit-line-clamp: unset; display: block; }
    .text a { color: var(--blue); }
    .text mark { background: transparent; color: inherit; border-bottom: 1px var(--mark-style) var(--mark); }
    .more { margin-top: 4px; font-size: 14px; font-weight: 500; color: var(--fg2); }
    .more:hover { color: var(--fg); }
    .tools { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 12px; color: var(--fg2); }
    .likes { display: inline-flex; align-items: center; gap: 6px; }
    .likes svg { width: 16px; height: 16px; }
    .other-video a { color: var(--blue); }
    .replies-btn {
      display: inline-flex; align-items: center; gap: 6px; height: 36px; margin: 4px 0 0 -12px; padding: 0 12px;
      border-radius: 18px; color: var(--blue); font-weight: 500;
    }
    .replies-btn:hover { background: color-mix(in srgb, var(--blue) 12%, transparent); }
    .replies-btn .chev { width: 20px; height: 20px; transition: transform .15s; }
    .replies-btn.open .chev { transform: rotate(180deg); }
    .sentinel { height: 1px; }

    /* API key card */
    .auth { margin-top: 12px; padding: 20px 24px; border-radius: 12px; background: var(--chip); }
    .auth h2 { margin: 0 0 4px; font-size: 16px; font-weight: 500; }
    .auth p { margin: 2px 0; color: var(--fg2); }
    .auth .row { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
    .auth input { flex: 1; min-width: 220px; height: 36px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); }
    .auth input:focus { border-color: var(--blue); }
    .auth button { height: 36px; padding: 0 16px; border-radius: 18px; font-weight: 500; }
    .auth .primary { background: var(--blue); color: var(--inverse); }
    .auth .secondary { background: var(--hover); }
    .auth .msg { min-height: 20px; margin-top: 6px; font-size: 13px; color: var(--error); }
    .auth .msg.ok { color: var(--fg2); }
    .auth ol { margin: 10px 0 0; padding-left: 20px; color: var(--fg2); font-size: 13px; }
    .auth ol a { color: var(--blue); }
    .auth ol a:hover { text-decoration: underline; }
  `;

  const ICON_SEARCH = 'M20.87 20.17l-5.59-5.59C16.35 13.35 17 11.75 17 10c0-3.87-3.13-7-7-7s-7 3.13-7 7 3.13 7 7 7c1.75 0 3.35-.65 4.58-1.71l5.59 5.59.7-.71zM10 16c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z';
  const ICON_PENCIL = 'M14.06 9.02l.92.92L5.92 19H5v-.92l9.06-9.06M17.66 3c-.25 0-.51.1-.7.29l-1.83 1.83 3.75 3.75 1.83-1.83a.996.996 0 0 0 0-1.41l-2.34-2.34c-.2-.2-.45-.29-.71-.29zm-3.6 3.19L3 17.25V21h3.75L17.81 9.94l-3.75-3.75z';
  const ICON_CHEVRON = 'M12 15.7 5.6 9.4l.8-.8 5.6 5.6 5.6-5.6.8.8z';

  // ------------------------------------------------------------------
  // Search bar inside the comment section
  // ------------------------------------------------------------------
  const ui = {};
  let current = null;         // { vd, details, q, results, rendered }
  let requestSeq = 0;

  function commentsEl() {
    return document.querySelector('ytd-watch-flexy ytd-comments#comments, ytd-comments#comments');
  }

  function buildHost() {
    if (ui.host) return;
    if (!document.getElementById('ytcs-page-css')) {
      (document.head || document.documentElement).append(h('style', { id: 'ytcs-page-css', text: PAGE_CSS }));
    }
    ui.host = h('ytcs-search');
    const shadow = ui.host.attachShadow({ mode: 'open' });
    shadow.append(h('style', { text: CSS }));

    ui.input = h('input', {
      type: 'text', placeholder: 'Search comments', spellcheck: 'false', autocomplete: 'off',
      'aria-label': 'Search comments',
    });
    ui.input.ytcsKeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runQuery(ui.input.value); }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (ui.input.value || isActive()) clearSearch(); else ui.input.blur();
      }
    };
    ui.input.addEventListener('focus', () => { ui.hint.hidden = false; prepare(); });
    ui.input.addEventListener('blur', () => { ui.hint.hidden = true; });

    ui.count = h('span', { class: 'count' });
    ui.clear = h('button', { class: 'clear', title: 'Clear search', hidden: true, onclick: () => { clearSearch(); ui.input.focus(); } }, svgIcon(ICON_X));
    ui.input.addEventListener('input', () => { ui.clear.hidden = !ui.input.value && !isActive(); });
    ui.progress = h('div', { class: 'progress' }, h('div'));
    // Clickable examples. mousedown keeps focus in the box (the hint hides on blur).
    const chip = (label, title, act) => {
      const b = h('button', { class: 'chip', title, text: label });
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', act);
      return b;
    };
    const fill = (value, caret, run) => () => {
      ui.input.value = value;
      ui.input.focus();
      ui.input.setSelectionRange(caret, caret);
      ui.clear.hidden = false;
      if (run) runQuery(value);
    };
    ui.hint = h('div', { class: 'hint', hidden: true },
      h('span', { text: 'Enter to search · Try:' }),
      chip(':creator', 'Click to show comments by the uploader', fill(':creator', 8, true)),
      chip('/regex/', 'Click to start a regular-expression search', fill('//', 1)),
      chip('global: words', 'Click to search the whole channel', fill('global: ', 8)),
      chip('API key', 'Click to change your YouTube API key', () => { ui.input.value = ''; showAuth(true); }));
    // "Add a comment" is folded away while the search box sits in its spot;
    // this button next to "Sort by" shows or hides it.
    ui.compose = h('button', { class: 'ytcs-compose', type: 'button', onclick: toggleCompose },
      svgIcon(ICON_PENCIL), h('span'));
    updateCompose();
    ui.status = h('div', { class: 'status', hidden: true });
    ui.auth = h('div', { hidden: true });
    ui.results = h('div', { class: 'results' });
    ui.sentinel = h('div', { class: 'sentinel' });
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) renderMore();
    }, { rootMargin: '800px 0px' }).observe(ui.sentinel);

    shadow.append(
      h('div', { class: 'bar' }, h('span', { class: 'icon' }, svgIcon(ICON_SEARCH)), ui.input, ui.count, ui.clear, ui.progress),
      ui.hint, ui.auth, ui.status, ui.results, ui.sentinel,
    );
    syncTheme();
    new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
  }

  function syncTheme() {
    if (ui.host) ui.host.toggleAttribute('dark', document.documentElement.hasAttribute('dark'));
  }

  // Put the bar where YouTube's "Add a comment" box is (folding that box
  // away), or just below the comments header if that box isn't there.
  // YouTube re-renders this area, so this is re-checked on DOM changes.
  function placeHost() {
    if (!videoId()) return false;
    const comments = commentsEl();
    const header = comments && comments.querySelector('#sections > #header');
    if (!header || !header.parentElement) return false;
    buildHost();
    const simple = header.querySelector('ytd-comments-header-renderer #simple-box');
    if (simple && simple.parentElement) {
      if (ui.host.nextElementSibling !== simple) simple.before(ui.host);
    } else if (ui.host.previousElementSibling !== header) {
      header.after(ui.host);
    }
    const inline = !!simple;
    ui.host.toggleAttribute('inline', inline);
    comments.classList.toggle('ytcs-inline', inline);
    // Compose button to the right of "Sort by".
    const sort = inline && header.querySelector('ytd-comments-header-renderer #sort-menu');
    const titleRow = inline && header.querySelector('ytd-comments-header-renderer #title');
    if (sort && sort.parentElement) {
      if (ui.compose.previousElementSibling !== sort) sort.after(ui.compose);
    } else if (titleRow) {
      if (ui.compose.parentElement !== titleRow) titleRow.append(ui.compose);
    } else if (ui.compose.isConnected) {
      ui.compose.remove();
    }
    updateCompose();
    return true;
  }

  function composeOpen() {
    const c = commentsEl();
    return !!(c && c.classList.contains('ytcs-show-simplebox'));
  }

  function updateCompose() {
    if (!ui.compose) return;
    const open = composeOpen();
    ui.compose.lastChild.textContent = open ? 'Hide comment box' : 'Add comment';
    ui.compose.title = open ? 'Fold the "Add a comment" box away' : 'Show the "Add a comment" box';
  }

  function toggleCompose() {
    const comments = commentsEl();
    if (!comments) return;
    const open = !composeOpen();
    comments.classList.toggle('ytcs-show-simplebox', open);
    updateCompose();
    if (open) {
      const simple = comments.querySelector('ytd-comments-header-renderer #simple-box');
      const placeholder = simple && simple.querySelector('#placeholder-area, #simplebox-placeholder');
      if (placeholder) placeholder.click();
    }
  }

  let placeScheduled = false;
  function schedulePlace() {
    if (placeScheduled) return;
    placeScheduled = true;
    requestAnimationFrame(() => { placeScheduled = false; placeHost(); });
  }

  function isActive() {
    const c = commentsEl();
    return !!(c && c.classList.contains('ytcs-active'));
  }

  function setActive(on) {
    const c = commentsEl();
    if (c) c.classList.toggle('ytcs-active', on);
    if (ui.clear) ui.clear.hidden = !on && !(ui.input && ui.input.value);
  }

  function clearSearch() {
    requestSeq++;
    setBusy(false);
    ui.input.value = '';
    ui.status.hidden = true;
    ui.results.replaceChildren();
    if (current) { current.results = null; current.rendered = 0; }
    setActive(false);
  }

  function setBusy(on, fraction) {
    if (!ui.progress) return;
    ui.progress.classList.toggle('busy', on && fraction == null);
    ui.progress.classList.toggle('determinate', on && fraction != null);
    ui.progress.firstChild.style.width = on && fraction != null ? Math.max(2, fraction * 100) + '%' : '';
  }

  function showStatus(content, isError, withShowAll) {
    ui.status.className = 'status' + (isError ? ' error' : '');
    ui.status.replaceChildren(h('span', null, content),
      withShowAll ? h('a', { class: 'show-all', text: 'Show all comments', onclick: clearSearch }) : null);
    ui.status.hidden = false;
  }

  function showMessage(text, isError) {
    ui.results.replaceChildren();
    if (current) current.results = null;
    showStatus(text, isError, true);
    setActive(true);
  }

  // --- API key card ---
  function showAuth(changing) {
    hideAuth();
    const existing = GM_getValue(KEY_STORE, '');
    const input = h('input', {
      type: 'password', placeholder: 'Paste API key (AIza…)', spellcheck: 'false', autocomplete: 'off',
      value: changing ? existing : '',
    });
    const msg = h('div', { class: 'msg' });
    const save = async () => {
      const key = input.value.trim();
      if (!key) { msg.className = 'msg'; msg.textContent = 'Paste a key first.'; return; }
      msg.className = 'msg ok';
      msg.textContent = 'Checking key…';
      try {
        await apiGet('videos', { part: 'id', id: 'jNQXAC9IVRw' }, key);
        GM_setValue(KEY_STORE, key);
        hideAuth();
        cache.clear();
        current = null;
        ui.input.focus();
        if (ui.input.value.trim()) runQuery(ui.input.value);
      } catch (err) {
        msg.className = 'msg';
        msg.textContent = errorText(err);
      }
    };
    input.ytcsKeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape' && existing) { e.preventDefault(); hideAuth(); ui.input.focus(); }
    };
    const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener', text });
    ui.auth.replaceChildren(h('div', { class: 'auth' },
      h('h2', { text: changing ? 'YouTube API key' : 'Set up comment search' }),
      h('p', { text: 'Comment search needs your own YouTube Data API key. It is saved in Tampermonkey and only sent to googleapis.com.' }),
      h('div', { class: 'row' },
        input,
        h('button', { class: 'primary', text: 'Save key', onclick: save }),
        changing && existing ? h('button', { class: 'secondary', text: 'Cancel', onclick: () => { hideAuth(); ui.input.focus(); } }) : null,
      ),
      msg,
      h('ol', null,
        h('li', null, 'Open ', link('https://console.cloud.google.com/apis/library/youtube.googleapis.com', 'YouTube Data API v3'), ' in Google Cloud and click Enable (create a project if asked).'),
        h('li', null, 'Go to ', link('https://console.cloud.google.com/apis/credentials', 'Credentials'), ', then Create credentials → API key.'),
        h('li', null, 'Paste the key above. The free quota (10,000 units a day) is plenty.'),
      ),
    ));
    ui.auth.hidden = false;
    setTimeout(() => input.focus(), 0);
  }

  function hideAuth() {
    if (!ui.auth) return;
    ui.auth.hidden = true;
    ui.auth.replaceChildren();
  }

  // --- Results ---
  function renderText(text, q) {
    const el = h('div', { class: 'text' });
    // Split into links, timestamps and plain text.
    const parts = [];
    const re = new RegExp(`${URL_RE.source}|${TIME_RE.source}`, 'g');
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push({ t: 'text', s: text.slice(last, m.index) });
      parts.push({ t: /^https?:/.test(m[0]) ? 'url' : 'time', s: m[0] });
      last = re.lastIndex;
    }
    if (last < text.length) parts.push({ t: 'text', s: text.slice(last) });

    const markRe = q && (q.regexp
      ? new RegExp(q.regexp.source, q.regexp.flags.includes('g') ? q.regexp.flags : q.regexp.flags + 'g')
      : q.tokens && q.tokens.length
        ? new RegExp(q.tokens.map(escapeRe).sort((a, b) => b.length - a.length).join('|'), 'gi')
        : null);

    const appendMarked = (target, s) => {
      if (!markRe) { target.append(s); return; }
      let i = 0;
      markRe.lastIndex = 0;
      let mm;
      while ((mm = markRe.exec(s))) {
        if (!mm[0]) { markRe.lastIndex++; continue; }
        if (mm.index > i) target.append(s.slice(i, mm.index));
        target.append(h('mark', { text: mm[0] }));
        i = mm.index + mm[0].length;
      }
      if (i < s.length) target.append(s.slice(i));
    };

    for (const p of parts) {
      if (p.t === 'url') {
        const a = h('a', { href: p.s, target: '_blank', rel: 'noopener' });
        appendMarked(a, p.s);
        el.append(a);
      } else if (p.t === 'time') {
        const secs = hms(p.s);
        const a = h('a', { title: 'Jump to ' + p.s, onclick: (e) => { e.preventDefault(); seek(secs); } });
        appendMarked(a, p.s);
        el.append(a);
      } else {
        appendMarked(el, p.s);
      }
    }
    return el;
  }

  function seek(secs) {
    const v = document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video');
    if (!v) return;
    v.currentTime = secs;
    if (v.paused) v.play().catch(() => {});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderComment(c, q, opts = {}) {
    const vid = c.videoId || (current && current.vd.id);
    const permalink = `https://www.youtube.com/watch?v=${vid}&lc=${c.id}`;
    const avatar = h('a', { class: 'avatar', href: c.authorUrl || null, target: '_blank', rel: 'noopener' });
    if (c.authorImg) avatar.style.backgroundImage = `url("${c.authorImg.replace(/"/g, '%22')}")`;
    const text = renderText(c.text, q);
    const more = h('button', { class: 'more', text: 'Read more', hidden: true });
    more.addEventListener('click', () => {
      const open = text.classList.toggle('open');
      more.textContent = open ? 'Show less' : 'Read more';
    });
    const body = h('div', { class: 'body' },
      h('div', { class: 'head' },
        h('a', { class: 'name' + (opts.isCreator ? ' creator' : ''), href: c.authorUrl || null, target: '_blank', rel: 'noopener', text: c.author },
          opts.isCreator ? h('span', { class: 'badge', title: 'Creator' }, svgIcon(ICON_CHECK)) : null),
        h('a', { class: 'date', href: permalink, title: 'Open this comment on YouTube to like or reply · ' + new Date(c.published).toLocaleString(),
          text: timeAgo(c.published) + (c.edited ? ' (edited)' : '') }),
      ),
      text,
      more,
      h('div', { class: 'tools' },
        h('span', { class: 'likes', title: (c.likes || 0).toLocaleString() + ' likes' }, svgIcon(ICON_LIKE), c.likes ? fmtCount(c.likes) : ''),
        opts.otherVideo ? h('span', { class: 'other-video' }, '· on ', h('a', { href: `https://www.youtube.com/watch?v=${vid}`, text: 'another video' })) : null,
      ),
    );
    // Show "Read more" only when the text is actually clamped.
    requestAnimationFrame(() => { if (text.scrollHeight > text.clientHeight + 2) more.hidden = false; });
    return { el: h('div', { class: 'comment' }, avatar, body), body };
  }

  function renderThread(result, q, details) {
    const { thread, shown } = result;
    const channelId = details && details.channelId;
    const otherVideo = current && thread.videoId && thread.videoId !== current.vd.id;
    const wrap = h('div', { class: 'thread' });
    const top = renderComment(thread.top, q, { isCreator: channelId && thread.top.authorId === channelId, otherVideo });
    wrap.append(top.el);
    const repliesBox = h('div', { class: 'reply-list' });
    const drawReplies = (list) => repliesBox.replaceChildren(...list.map((c) =>
      renderComment(c, q, { isCreator: channelId && c.authorId === channelId }).el));
    drawReplies(shown || []);

    if (thread.replyCount > 0) {
      let expanded = false;
      const n = thread.replyCount;
      const label = () => expanded ? 'Hide replies'
        : (shown && shown.length ? `Show all ${n.toLocaleString()} replies` : `${n.toLocaleString()} ${n === 1 ? 'reply' : 'replies'}`);
      const btnText = h('span', { text: label() });
      const btn = h('button', { class: 'replies-btn' }, h('span', { class: 'chev' }, svgIcon(ICON_CHEVRON)), btnText);
      btn.addEventListener('click', async () => {
        if (expanded) {
          expanded = false;
          drawReplies(shown || []);
        } else {
          btn.disabled = true;
          setBusy(true);
          try {
            const all = thread.replies.length >= thread.replyCount ? thread.replies : await loadReplies(thread.id);
            expanded = true;
            drawReplies(all);
          } catch (err) {
            repliesBox.replaceChildren(h('div', { class: 'status error' }, errorText(err)));
          } finally {
            btn.disabled = false;
            setBusy(false);
          }
        }
        btn.classList.toggle('open', expanded);
        btnText.textContent = label();
      });
      top.body.append(btn);
    }
    wrap.append(repliesBox);
    return wrap;
  }

  function showResults(results, q, details, raw) {
    current.results = results;
    current.rendered = 0;
    current.q = q;
    current.details = details;
    ui.results.replaceChildren();
    const n = results.length;
    showStatus(n ? `${n.toLocaleString()} ${n === 1 ? 'comment matches' : 'comments match'} “${raw}”` : `No comments match “${raw}”.`, false, true);
    setActive(true);
    renderMore();
  }

  function renderMore() {
    if (!current || !current.results || current.rendered >= current.results.length) return;
    const next = current.results.slice(current.rendered, current.rendered + CONFIG.pageSize);
    current.rendered += next.length;
    for (const r of next) ui.results.append(renderThread(r, current.q, current.details));
  }

  function updateCount(details, vd) {
    const ready = !!(details && vd && vd.threads);
    ui.count.classList.toggle('ready', ready);
    if (!details) { ui.count.textContent = ''; return; }
    if (details.count == null) { ui.count.textContent = 'comments off'; return; }
    if (!canLoadAll(details)) {
      ui.count.textContent = `${fmtCount(details.count)} · YouTube search`;
      ui.count.title = `Too many comments to download (limit ${CONFIG.maxLoadComments.toLocaleString()}), so keyword search uses YouTube's own search and /regex/ and :creator are off.`;
      return;
    }
    ui.count.textContent = ready ? `${fmtCount(details.count)} loaded` : (vd && vd.loading ? `loading ${fmtCount(vd.loaded)} / ${fmtCount(details.count)}` : fmtCount(details.count));
    ui.count.title = ready
      ? `All comments downloaded${vd.savedAt ? ` (full copy from ${timeAgo(new Date(vd.savedAt).toISOString())}, plus anything new)` : ''}; searches are instant.`
      : '';
  }

  // On first focus for a video: fetch its details and, when small enough,
  // download every comment in the background so searches are instant.
  async function prepare() {
    const id = videoId();
    if (!id) return;
    if (!GM_getValue(KEY_STORE, '')) { showAuth(false); return; }
    const vd = videoData(id);
    if (current && current.vd === vd && current.prepared) return;
    current = { vd, prepared: true };
    try {
      const details = await loadDetails(vd);
      if (!current || current.vd !== vd) return;
      updateCount(details, vd);
      if (canLoadAll(details) && !vd.threads) {
        const tick = setInterval(() => { if (current && current.vd === vd) updateCount(details, vd); }, 500);
        loadAllThreads(vd)
          .catch(() => {})
          .finally(() => { clearInterval(tick); if (current && current.vd === vd) updateCount(details, vd); });
      }
    } catch (err) {
      if (current && current.vd === vd) current.prepared = false;
      if (err.reason === 'noKey') showAuth(false);
    }
  }

  // YouTube's search also matches things we can't check locally (other
  // spellings, replies it didn't send), so keep its results: ours first,
  // ranked, then the rest in YouTube's order.
  function fromApi(threads, q, details) {
    const results = localSearch(threads, q, details);
    const seen = new Set(results.map((r) => r.thread.id));
    for (const t of threads) if (!seen.has(t.id)) results.push({ thread: t, shown: [] });
    return results;
  }

  async function runQuery(raw) {
    raw = raw.trim();
    if (!raw) return clearSearch();
    if (raw === '/key') { ui.input.value = ''; return showAuth(true); }
    const id = videoId();
    if (!id) return;
    if (!GM_getValue(KEY_STORE, '')) return showAuth(false);
    const vd = videoData(id);
    if (!current || current.vd !== vd) current = { vd };
    const seq = ++requestSeq;
    let q;
    try {
      q = parseQuery(raw);
    } catch (err) {
      return showMessage(err.message, true);
    }
    try {
      setBusy(true);
      const details = await loadDetails(vd);
      if (seq !== requestSeq) return;
      updateCount(details, vd);
      let results;
      if (q.global) {
        if (q.kind !== 'keywords') throw new ApiError('empty', 'global: works with keywords only.');
        showMessage('Searching the whole channel…');
        const threads = await searchApi({ allThreadsRelatedToChannelId: details.channelId, searchTerms: q.text });
        results = fromApi(threads, q, details);
      } else if (details.count == null) {
        throw new ApiError('commentsDisabled');
      } else if (details.count === 0) {
        setBusy(false);
        return showMessage('This video has no comments yet.');
      } else if (canLoadAll(details)) {
        const threads = await loadAllThreads(vd, (n) => {
          if (seq !== requestSeq) return;
          setBusy(true, Math.min(1, n / details.count));
          updateCount(details, vd);
          showMessage(`Loading comments… ${n.toLocaleString()} of ${details.count.toLocaleString()}`);
        });
        updateCount(details, vd);
        results = localSearch(threads, q, details);
      } else if (q.kind !== 'keywords') {
        setBusy(false);
        return showMessage(`/regex/ and :creator need every comment downloaded, but this video has ${details.count.toLocaleString()} (limit ${CONFIG.maxLoadComments.toLocaleString()}). Keyword search still works.`, true);
      } else {
        showMessage('Searching…');
        const threads = await searchApi({ videoId: vd.id, searchTerms: q.text });
        results = fromApi(threads, q, details);
      }
      if (seq !== requestSeq) return;
      setBusy(false);
      showResults(results, q, details, raw);
    } catch (err) {
      if (seq !== requestSeq) return;
      setBusy(false);
      if (err.reason === 'noKey') return showAuth(false);
      showMessage(errorText(err), true);
    }
  }

  // Cmd/Ctrl+S: jump to the search box (scrolling down to the comments,
  // which also makes YouTube load them); again: back up to the video.
  function focusSearch() {
    if (ui.host && ui.host.shadowRoot.activeElement === ui.input) {
      ui.input.blur();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    // Start downloading right away, while YouTube is still rendering the
    // comment section (as the old panel did), not when the box appears.
    buildHost();
    prepare();
    const go = () => {
      const top = ui.host.getBoundingClientRect().top + window.scrollY - 140;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      ui.input.focus({ preventScroll: true });
      ui.input.select();
    };
    if (placeHost()) return go();
    const comments = commentsEl();
    if (comments) comments.scrollIntoView({ behavior: 'smooth', block: 'start' });
    let tries = 0;
    const wait = setInterval(() => {
      if (placeHost()) { clearInterval(wait); go(); } else if (++tries > 40) clearInterval(wait);
    }, 250);
  }

  // ------------------------------------------------------------------
  // Keyboard. Registered at document-start in the capture phase so it runs
  // before YouTube's own shortcuts: Cmd/Ctrl+S jumps to the search box, and
  // keys typed in it never reach YouTube (no "k" pausing the video).
  // ------------------------------------------------------------------
  function fromUs(e) {
    return ui.host && e.composedPath().includes(ui.host);
  }

  window.addEventListener('keydown', (e) => {
    const isShortcut = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyS' || e.key === 's' || e.key === 'S');
    if (isShortcut && videoId()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      focusSearch();
      return;
    }
    if (!fromUs(e)) return;
    const target = e.composedPath()[0];
    if (!target || !/^(INPUT|TEXTAREA)$/.test(target.tagName)) return; // buttons/links keep normal keys
    e.stopImmediatePropagation();
    // Our own key handlers run from here, since the event stops above.
    if (typeof target.ytcsKeydown === 'function') target.ytcsKeydown(e);
  }, true);

  for (const type of ['keyup', 'keypress']) {
    window.addEventListener(type, (e) => {
      if (!fromUs(e)) return;
      const target = e.composedPath()[0];
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) e.stopImmediatePropagation();
    }, true);
  }

  // ------------------------------------------------------------------
  // Page lifecycle
  // ------------------------------------------------------------------
  document.addEventListener('yt-navigate-finish', () => {
    const id = videoId();
    const c = commentsEl();
    if (c) c.classList.remove('ytcs-show-simplebox');
    updateCompose();
    if (current && current.vd.id !== id) {
      current = null;
      if (ui.host) { clearSearch(); hideAuth(); updateCount(null); }
    }
    schedulePlace();
  });

  const startObserver = () => {
    new MutationObserver(() => {
      if (videoId() && (!ui.host || !ui.host.isConnected || (ui.host.hasAttribute('inline') && !ui.compose.isConnected))) schedulePlace();
    })
      .observe(document.documentElement, { childList: true, subtree: true });
    schedulePlace();
  };
  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Search comments (Cmd/Ctrl+S)', () => { if (videoId()) focusSearch(); });
    GM_registerMenuCommand('Set YouTube API key', () => {
      if (!videoId()) return;
      focusSearch();
      setTimeout(() => { if (ui.host) showAuth(true); }, 800);
    });
  }
})();
