// ==UserScript==
// @name         YouTube Comment Search
// @namespace    https://tampermonkey.net/
// @version      1.2.0
// @description  Search a video's comments by keyword from a panel opened with Cmd+S / Ctrl+S. Uses your own YouTube Data API key. Highlights matches, expands reply threads, makes timestamps clickable, and supports /regex/, :creator and global: (whole channel).
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
  };

  const API = 'https://www.googleapis.com/youtube/v3';
  const KEY_STORE = 'ytcsApiKey';
  const GEOMETRY_STORE = 'ytcsGeometry';

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

  function loadAllThreads(vd, onProgress) {
    if (vd.threads) return Promise.resolve(vd.threads);
    vd.onProgress = onProgress || null;
    if (vd.loading) {
      if (onProgress && vd.loaded) onProgress(vd.loaded);
      return vd.loading;
    }
    vd.loading = (async () => {
      const all = [];
      vd.loaded = 0;
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

      // Fill in long reply threads, several at a time.
      if (CONFIG.fetchAllReplies) {
        const todo = all.filter((t) => t.replyCount > t.replies.length);
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
      vd.threads = all;
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
  // Styles
  // ------------------------------------------------------------------
  const CSS = `
    :host { all: initial; }
    .root {
      --bg: #1c1c1c; --header: #222; --chip: #2b2b2b; --chip-hover: #383838; --line: #3d3d3d;
      --text: #d6d6d6; --muted: #888; --strong: #fff; --placeholder: rgba(255,255,255,.35);
      --link: #609fff; --mark: orange; --mark-style: dotted; --accent: #ddd; --accent-text: #222;
      --count-border: orange; --error: #f28b82; --progress: #7f7f7f;
      position: fixed; bottom: 0; z-index: 2147483646;
      display: flex; flex-direction: column;
      background: var(--bg); color: var(--text);
      border-radius: 8px 8px 0 0;
      box-shadow: 0 16px 24px 2px rgba(0,0,0,.14), 0 6px 30px 5px rgba(0,0,0,.12), 0 8px 10px -5px rgba(0,0,0,.4);
      font: 400 14px/20px Roboto, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      overflow: visible; cursor: default; user-select: none;
    }
    .root.light {
      --bg: #fafafa; --header: #e3e3e3; --chip: #d0d0d0; --chip-hover: #c4c4c4; --line: #cacaca;
      --text: #111; --muted: #606060; --strong: #222; --placeholder: rgba(0,0,0,.35);
      --link: #065fd4; --mark: #e1251b; --mark-style: solid; --accent: #3b7bbf; --accent-text: #fff;
      --count-border: #065fd4; --error: #d93025; --progress: #3b7bbf;
    }
    [hidden] { display: none !important; }
    * { box-sizing: border-box; }
    button, input { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; outline: none; }
    button { cursor: pointer; display: flex; align-items: center; justify-content: center; }
    a { color: inherit; text-decoration: none; cursor: pointer; }
    svg { width: 100%; height: 100%; fill: currentColor; }
    code { background: var(--chip); border-radius: 3px; padding: 1px 5px; margin: 0 2px; letter-spacing: .5px; font-family: inherit; }

    /* resize / move handles */
    .bar { position: absolute; z-index: 5; }
    .bar.n { top: -4px; left: 0; width: 100%; height: 8px; cursor: ns-resize; }
    .bar.e { right: -4px; top: 0; width: 8px; height: 100%; cursor: ew-resize; }
    .bar.w { left: -4px; top: 0; width: 8px; height: 100%; cursor: ew-resize; }
    .bar.ne { right: -6px; top: -6px; width: 14px; height: 14px; cursor: nesw-resize; z-index: 6; }
    .bar.nw { left: -6px; top: -6px; width: 14px; height: 14px; cursor: nwse-resize; z-index: 6; }
    .bar.move { top: 0; left: 0; width: calc(100% - 48px); height: 14px; cursor: move; }

    header {
      position: relative; display: flex; align-items: center; flex: none;
      height: 56px; padding-right: 48px;
      background: var(--header); border-radius: 8px 8px 0 0;
    }
    header input { flex: 1; height: 100%; padding: 0 12px 0 20px; font-size: 16px; user-select: text; cursor: text; }
    header input::placeholder { color: var(--placeholder); font-size: 15px; }
    header input:focus::placeholder { opacity: 0; }
    .count {
      flex: none; min-width: 3ch; height: 22px; padding: 2px 6px 0; margin-right: 4px; text-align: center; line-height: 18px;
      background: var(--chip); color: var(--strong); font-size: 12px; white-space: nowrap;
      border-radius: 4px 4px 0 0; border-bottom: 2px solid transparent; opacity: .75;
      transition: opacity .2s, border-color .2s;
    }
    .count.ready { border-bottom-color: var(--count-border); opacity: 1; }
    .close { position: absolute; top: 12px; right: 10px; width: 32px; height: 32px; padding: 6px; border-radius: 50%; opacity: .6; z-index: 7; }
    .close:hover { opacity: 1; background: var(--chip); }
    .progress { position: absolute; left: 0; bottom: 0; height: 1px; width: 0; background: var(--progress); }
    .progress.busy { height: 2px; width: 30%; animation: slide 1s infinite ease-in-out; }
    .progress.determinate { height: 2px; animation: none; transition: width .2s; }
    @keyframes slide { from { left: -30%; } to { left: 100%; } }

    .body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .scroll { flex: 1; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
    .message { padding: 24px 28px; text-align: center; color: var(--text); user-select: text; }
    .message.error { color: var(--error); }
    .guide { padding: 18px 28px 24px; user-select: text; }
    .guide h1 { font-size: 18px; font-weight: 500; margin: 0 0 10px; color: var(--strong); }
    .guide p { margin: 12px 0 6px; }
    .guide ul { margin: 0; padding-left: 4px; list-style: none; }
    .guide li { margin: 4px 0; }
    .guide li::before { content: "\\2022"; font-weight: bold; padding-right: 10px; }
    .guide a { color: var(--link); }
    .guide a:hover { text-decoration: underline; }

    .thread { padding: 6px 0; }
    .thread + .thread { border-top: 1px solid color-mix(in srgb, var(--line) 45%, transparent); }
    .comment {
      position: relative; display: grid; grid-template-columns: auto 1fr;
      padding: 10px 40px 10px 18px; user-select: text;
    }
    .comment.reply { padding-left: 74px; }
    .comment.reply::before { content: ""; position: absolute; left: 37px; top: 0; bottom: 0; width: 2px; background: var(--chip); }
    .side { grid-row: 1 / span 3; position: relative; width: 40px; height: 40px; margin-right: 16px; }
    .reply .side { width: 24px; height: 24px; }
    .avatar { display: block; width: 100%; height: 100%; border-radius: 50%; background: var(--chip) center / cover no-repeat; }
    .replies-btn {
      position: absolute; left: 50%; bottom: -26px; transform: translateX(-50%);
      min-width: 24px; height: 17px; padding: 0 4px; border-radius: 3px;
      background: var(--chip); font-size: 11px; line-height: 17px;
    }
    .replies-btn:hover { background: var(--chip-hover); }
    .author { display: flex; align-items: center; gap: 6px; height: 20px; margin-bottom: 2px; font-size: 13px; line-height: 18px; min-width: 0; }
    .author .name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--strong); }
    .author .badge { width: 13px; height: 13px; flex: none; color: var(--muted); }
    .author .date, .author .likes { flex: none; color: var(--muted); }
    .author .date:hover { color: var(--text); }
    .author .likes { display: inline-flex; align-items: center; gap: 3px; }
    .author .likes svg { width: 13px; height: 13px; }
    .text {
      white-space: pre-line; word-break: break-word;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden;
    }
    .reply .text { -webkit-line-clamp: 3; }
    .text.open { -webkit-line-clamp: unset; display: block; }
    .text a { color: var(--link); }
    .text a:hover { text-decoration: underline; }
    .text mark {
      background: transparent; color: inherit;
      border-bottom: 1px var(--mark-style) var(--mark);
    }
    .more { justify-self: start; margin-top: 2px; font-size: 12px; color: var(--muted); }
    .more:hover { color: var(--text); }
    .other-video { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .other-video a { color: var(--link); }

    /* API key screen */
    .auth { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 34px 28px 20px; background: var(--bg); border-radius: 8px 8px 0 0; overflow-y: auto; user-select: text; }
    .auth h1 { font-size: 22px; font-weight: 500; margin: 0 0 6px; color: var(--strong); }
    .auth p { margin: 4px 0; color: var(--muted); }
    .auth input { width: min(360px, 100%); margin-top: 18px; padding: 6px 4px; font-size: 15px; text-align: center; border-bottom: 1px solid var(--line); cursor: text; }
    .auth input:focus { border-bottom-color: var(--accent); }
    .auth .status { min-height: 20px; margin-top: 6px; font-size: 13px; color: var(--error); }
    .auth .status.ok { color: var(--muted); }
    .auth .row { display: flex; gap: 10px; margin-top: 10px; }
    .auth button { height: 34px; padding: 0 18px; border-radius: 17px; font-weight: 500; background: var(--accent); color: var(--accent-text); }
    .auth button.secondary { background: var(--chip); color: var(--text); }
    .auth ol { text-align: left; margin: 18px 0 0; padding-left: 20px; color: var(--muted); font-size: 13px; }
    .auth ol a { color: var(--link); }
    .auth ol a:hover { text-decoration: underline; }
  `;

  // ------------------------------------------------------------------
  // Panel
  // ------------------------------------------------------------------
  const ui = {};
  let current = null;         // { vd, q, results, rendered }
  let requestSeq = 0;

  function geometry() {
    const g = GM_getValue(GEOMETRY_STORE, null) || {};
    const w = Math.min(Math.max(g.w || 500, 360), innerWidth);
    const hgt = Math.min(Math.max(g.h || Math.round(innerHeight * 0.6), 200), innerHeight - 20);
    const x = Math.min(Math.max(g.x != null ? g.x : innerWidth - w - 24, 0), Math.max(0, innerWidth - w));
    return { x, w, h: hgt };
  }

  function applyGeometry(g) {
    Object.assign(ui.root.style, { left: g.x + 'px', width: g.w + 'px', height: g.h + 'px' });
  }

  function saveGeometry() {
    const r = ui.root.getBoundingClientRect();
    GM_setValue(GEOMETRY_STORE, { x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) });
  }

  function makeBar(kind) {
    const bar = h('div', { class: 'bar ' + kind });
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, ...geometryNow() };
      const move = (ev) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        let { x, w, h: hh } = start;
        if (kind === 'move') x += dx;
        if (kind.includes('n')) hh = start.h - dy;
        if (kind === 'e' || kind === 'ne') w = start.w + dx;
        if (kind === 'w' || kind === 'nw') { w = start.w - dx; x = start.x0 + dx; }
        w = Math.min(Math.max(w, 360), innerWidth);
        hh = Math.min(Math.max(hh, 200), innerHeight - 10);
        if (kind === 'w' || kind === 'nw') x = Math.min(x, start.x0 + start.w - w);
        x = Math.min(Math.max(x, 0), innerWidth - w);
        applyGeometry({ x, w, h: hh });
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        saveGeometry();
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
    return bar;
  }

  function geometryNow() {
    const r = ui.root.getBoundingClientRect();
    return { x0: r.left, x: r.left, w: r.width, h: r.height };
  }

  function buildPanel() {
    if (ui.host) return;
    ui.host = h('ytcs-panel');
    const shadow = ui.host.attachShadow({ mode: 'open' });
    shadow.append(h('style', { text: CSS }));

    ui.input = h('input', {
      type: 'text', placeholder: 'type keywords here..', spellcheck: 'false', autocomplete: 'off',
    });
    ui.input.ytcsKeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runQuery(ui.input.value); }
    };
    ui.count = h('div', { class: 'count', title: 'Comments on this video', text: '…' });
    ui.progress = h('div', { class: 'progress' });
    ui.scroll = h('div', { class: 'scroll' });
    ui.scroll.addEventListener('scroll', () => {
      if (ui.scroll.scrollTop + ui.scroll.clientHeight > ui.scroll.scrollHeight - 300) renderMore();
    }, { passive: true });

    ui.root = h('div', { class: 'root', hidden: true },
      ['n', 'e', 'w', 'ne', 'nw', 'move'].map(makeBar),
      h('button', { class: 'close', title: 'Close (Esc)', onclick: () => togglePanel(false) }, svgIcon(ICON_X)),
      h('header', null, ui.input, ui.count, ui.progress),
      h('div', { class: 'body' }, ui.scroll),
    );
    shadow.append(ui.root);
    (document.body || document.documentElement).append(ui.host);
    applyGeometry(geometry());
    new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
  }

  function syncTheme() {
    if (!ui.root) return;
    ui.root.classList.toggle('light', !document.documentElement.hasAttribute('dark'));
  }

  function setBusy(on, fraction) {
    ui.progress.classList.toggle('busy', on && fraction == null);
    ui.progress.classList.toggle('determinate', on && fraction != null);
    ui.progress.style.width = on && fraction != null ? (Math.max(2, fraction * 100)) + '%' : '';
    if (!on) ui.progress.style.width = '0';
  }

  function showMessage(text, isError) {
    ui.scroll.replaceChildren(h('div', { class: 'message' + (isError ? ' error' : '') }, text));
    ui.scroll.scrollTop = 0;
  }

  function showGuide() {
    const code = (s) => h('code', { text: s });
    const li = (...c) => h('li', null, ...c);
    ui.scroll.replaceChildren(h('div', { class: 'guide' },
      h('h1', { text: 'Quick Guide' }),
      h('ul', null,
        li('Type keywords and press ', code('Enter'), '. Matches are underlined.'),
        li('Type ', code('/regex/'), ' to search with a regular expression.'),
        li('Type ', code(':creator'), ' for comments by the uploader.'),
        li('Use ', code('global: xyz'), ' to search all of the channel\'s videos.'),
      ),
      h('p', { text: 'Also:' }),
      h('ul', null,
        li('Click a timestamp in a comment to jump the video there.'),
        li(code('Cmd/Ctrl + S'), ' opens and closes this panel; ', code('Esc'), ' closes it.'),
        li('Type ', code('/key'), ' or ', h('a', { onclick: () => showAuth(true), text: 'click here' }), ' to change your API key.'),
      ),
    ));
    ui.scroll.scrollTop = 0;
  }

  // --- API key screen ---
  function showAuth(changing) {
    hideAuth();
    const existing = GM_getValue(KEY_STORE, '');
    const input = h('input', {
      type: 'password', placeholder: 'Paste API key (AIza…)', spellcheck: 'false', autocomplete: 'off',
      value: changing ? existing : '',
    });
    const status = h('div', { class: 'status' });
    const save = async () => {
      const key = input.value.trim();
      if (!key) { status.textContent = 'Paste a key first.'; return; }
      status.className = 'status ok';
      status.textContent = 'Checking key…';
      try {
        await apiGet('videos', { part: 'id', id: 'jNQXAC9IVRw' }, key);
        GM_setValue(KEY_STORE, key);
        hideAuth();
        cache.clear();
        startForVideo(true);
      } catch (err) {
        status.className = 'status';
        status.textContent = errorText(err);
      }
    };
    input.ytcsKeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
    ui.auth = h('div', { class: 'auth' },
      h('h1', { text: changing ? 'YouTube API Key' : 'Welcome!' }),
      h('p', { text: 'Please insert your YouTube Data API key.' }),
      h('p', { text: 'It is saved in Tampermonkey on this computer and only sent to googleapis.com.' }),
      input,
      status,
      h('div', { class: 'row' },
        h('button', { text: 'Save key', onclick: save }),
        changing && existing ? h('button', { class: 'secondary', text: 'Cancel', onclick: hideAuth }) : null,
      ),
      h('ol', null,
        h('li', null, 'Open ', h('a', { href: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com', target: '_blank', rel: 'noopener', text: 'YouTube Data API v3' }), ' in Google Cloud and click Enable (create a project if asked).'),
        h('li', null, 'Go to ', h('a', { href: 'https://console.cloud.google.com/apis/credentials', target: '_blank', rel: 'noopener', text: 'Credentials' }), ', then Create credentials → API key.'),
        h('li', null, 'Copy the key and paste it above. The free quota (10,000 units a day) covers thousands of searches.'),
      ),
    );
    ui.root.append(ui.auth);
    setTimeout(() => input.focus(), 0);
  }

  function hideAuth() {
    if (ui.auth) { ui.auth.remove(); ui.auth = null; }
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
  }

  function renderComment(c, q, opts = {}) {
    const vid = c.videoId || (current && current.vd.id);
    const permalink = `https://www.youtube.com/watch?v=${vid}&lc=${c.id}`;
    const avatar = h('a', { class: 'avatar', href: c.authorUrl || null, target: '_blank', rel: 'noopener' });
    if (c.authorImg) avatar.style.backgroundImage = `url("${c.authorImg.replace(/"/g, '%22')}")`;
    const side = h('div', { class: 'side' }, avatar);
    const text = renderText(c.text, q);
    const more = h('button', { class: 'more', text: 'Read more', hidden: true });
    more.addEventListener('click', () => {
      const open = text.classList.toggle('open');
      more.textContent = open ? 'Show less' : 'Read more';
    });
    const el = h('div', { class: 'comment' + (opts.reply ? ' reply' : '') },
      side,
      h('div', { class: 'author' },
        h('a', { class: 'name', href: c.authorUrl || null, target: '_blank', rel: 'noopener', text: c.author }),
        opts.isCreator ? h('span', { class: 'badge', title: 'Creator' }, svgIcon(ICON_CHECK)) : null,
        h('a', { class: 'date', href: permalink, target: '_blank', rel: 'noopener', title: new Date(c.published).toLocaleString(),
          text: timeAgo(c.published) + (c.edited ? ' (edited)' : '') }),
        c.likes ? h('span', { class: 'likes', title: c.likes.toLocaleString() + ' likes' }, svgIcon(ICON_LIKE), fmtCount(c.likes)) : null,
      ),
      text,
      more,
      opts.otherVideo ? h('div', { class: 'other-video' }, 'On ', h('a', { href: `https://www.youtube.com/watch?v=${vid}`, target: '_blank', rel: 'noopener', text: 'another video' })) : null,
    );
    // Show "Read more" only when the text is actually clamped.
    requestAnimationFrame(() => { if (text.scrollHeight > text.clientHeight + 2) more.hidden = false; });
    return { el, side };
  }

  function renderThread(result, q, details) {
    const { thread, shown } = result;
    const channelId = details && details.channelId;
    const otherVideo = current && thread.videoId && thread.videoId !== current.vd.id;
    const wrap = h('div', { class: 'thread' });
    const top = renderComment(thread.top, q, { isCreator: channelId && thread.top.authorId === channelId, otherVideo });
    wrap.append(top.el);
    const repliesBox = h('div');
    const drawReplies = (list) => repliesBox.replaceChildren(...list.map((c) =>
      renderComment(c, q, { reply: true, isCreator: channelId && c.authorId === channelId }).el));
    drawReplies(shown || []);
    wrap.append(repliesBox);

    if (thread.replyCount > 0) {
      let expanded = false;
      const btn = h('button', { class: 'replies-btn', title: 'Show replies', text: fmtCount(thread.replyCount) });
      btn.addEventListener('click', async () => {
        if (expanded) { expanded = false; drawReplies(shown || []); btn.title = 'Show replies'; return; }
        btn.disabled = true;
        setBusy(true);
        try {
          const all = thread.replies.length >= thread.replyCount ? thread.replies : await loadReplies(thread.id);
          expanded = true;
          btn.title = 'Hide replies';
          drawReplies(all);
        } catch (err) {
          repliesBox.replaceChildren(h('div', { class: 'message error' }, errorText(err)));
        } finally {
          btn.disabled = false;
          setBusy(false);
        }
      });
      top.side.append(btn);
    }
    return wrap;
  }

  function showResults(results, q, details) {
    current.results = results;
    current.rendered = 0;
    current.q = q;
    current.details = details;
    ui.scroll.replaceChildren();
    ui.scroll.scrollTop = 0;
    if (!results.length) return showMessage('No comments found.');
    renderMore();
  }

  function renderMore() {
    if (!current || !current.results || current.rendered >= current.results.length) return;
    const next = current.results.slice(current.rendered, current.rendered + CONFIG.pageSize);
    current.rendered += next.length;
    for (const r of next) ui.scroll.append(renderThread(r, current.q, current.details));
  }

  function updateCount(details, vd) {
    ui.count.classList.toggle('ready', !!(details && vd && vd.threads));
    if (!details) { ui.count.textContent = '…'; return; }
    if (details.count == null) { ui.count.textContent = 'off'; ui.count.title = 'Comments are turned off'; return; }
    ui.count.textContent = details.count ? fmtCount(details.count) : 'zero';
    ui.count.title = canLoadAll(details)
      ? `${details.count.toLocaleString()} comments` + (vd && vd.threads ? ', all loaded' : '')
      : `${details.count.toLocaleString()} comments. Too many to load, so /regex/ and :creator are off; keyword search uses YouTube's search.`;
  }

  // Load details for the current video and (when small enough) prefetch
  // all comments so searches are instant.
  async function startForVideo(focus) {
    const id = videoId();
    if (!id) { togglePanel(false); return; }
    if (!GM_getValue(KEY_STORE, '')) { showAuth(false); return; }
    const vd = videoData(id);
    current = { vd };
    updateCount(null);
    if (!ui.input.value.trim()) showGuide();
    if (focus) ui.input.focus();
    const seq = ++requestSeq;
    try {
      setBusy(true);
      const details = await loadDetails(vd);
      if (seq !== requestSeq) return;
      updateCount(details, vd);
      setBusy(false);
      if (canLoadAll(details) && !vd.threads) {
        loadAllThreads(vd).then(() => { if (current && current.vd === vd) updateCount(details, vd); }).catch(() => {});
      }
      if (ui.input.value.trim()) runQuery(ui.input.value);
    } catch (err) {
      if (seq !== requestSeq) return;
      setBusy(false);
      if (err.reason === 'noKey') return showAuth(false);
      showMessage(errorText(err), true);
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

  async function runQuery(raw, setInput) {
    if (setInput) ui.input.value = raw;
    raw = raw.trim();
    if (!raw) return showGuide();
    if (raw === '/key') { ui.input.value = ''; return showAuth(true); }
    if (raw === '/' || raw === '?' || raw === '/help') { ui.input.value = ''; return showGuide(); }
    const id = videoId();
    if (!id) return;
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
          showMessage(`Loading comments… ${n.toLocaleString()} of ${details.count.toLocaleString()}`);
        });
        updateCount(details, vd);
        results = localSearch(threads, q, details);
      } else if (q.kind !== 'keywords') {
        setBusy(false);
        return showMessage(`/regex/ and :creator need every comment downloaded, but this video has ${details.count.toLocaleString()} (limit ${CONFIG.maxLoadComments.toLocaleString()}). Keyword search still works.`, true);
      } else {
        const threads = await searchApi({ videoId: vd.id, searchTerms: q.text });
        results = fromApi(threads, q, details);
      }
      if (seq !== requestSeq) return;
      setBusy(false);
      showResults(results, q, details);
    } catch (err) {
      if (seq !== requestSeq) return;
      setBusy(false);
      if (err.reason === 'noKey') return showAuth(false);
      showMessage(errorText(err), true);
    }
  }

  function isOpen() {
    return ui.root && !ui.root.hidden;
  }

  function togglePanel(force) {
    const open = force != null ? force : !isOpen();
    if (open && !videoId()) return false;
    buildPanel();
    if (open) {
      syncTheme();
      applyGeometry(geometry());
      ui.root.hidden = false;
      const id = videoId();
      if (!current || current.vd.id !== id) startForVideo(true);
      else {
        ui.input.focus();
        ui.input.select();
      }
    } else {
      ui.root.hidden = true;
      if (ui.root.contains(ui.root.getRootNode().activeElement)) ui.root.getRootNode().activeElement.blur();
    }
    return true;
  }

  // ------------------------------------------------------------------
  // Keyboard. Registered at document-start in the capture phase so it runs
  // before YouTube's own shortcuts: Cmd/Ctrl+S toggles the panel, and keys
  // typed inside the panel never reach YouTube (no "k" pausing the video).
  // ------------------------------------------------------------------
  function fromPanel(e) {
    return ui.host && e.composedPath().includes(ui.host);
  }

  window.addEventListener('keydown', (e) => {
    const isToggle = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyS' || e.key === 's' || e.key === 'S');
    if (isToggle && (videoId() || isOpen())) {
      e.preventDefault();
      e.stopImmediatePropagation();
      togglePanel();
      return;
    }
    if (!fromPanel(e)) return;
    e.stopImmediatePropagation();
    const target = e.composedPath()[0];
    if (e.key === 'Escape') {
      e.preventDefault();
      if (ui.auth && GM_getValue(KEY_STORE, '')) hideAuth();
      else togglePanel(false);
      return;
    }
    // Our own key handlers run from here, since the event stops above.
    if (target && typeof target.ytcsKeydown === 'function') target.ytcsKeydown(e);
  }, true);

  for (const type of ['keyup', 'keypress']) {
    window.addEventListener(type, (e) => { if (fromPanel(e)) e.stopImmediatePropagation(); }, true);
  }

  // ------------------------------------------------------------------
  // Page lifecycle
  // ------------------------------------------------------------------
  document.addEventListener('yt-navigate-finish', () => {
    if (!isOpen()) return;
    const id = videoId();
    if (!id) togglePanel(false);
    else if (!current || current.vd.id !== id) {
      ui.input.value = '';
      startForVideo(false);
    }
  });


  window.addEventListener('resize', () => {
    if (isOpen()) applyGeometry(geometry());
  });

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Open comment search (Cmd/Ctrl+S)', () => togglePanel(true));
    GM_registerMenuCommand('Set YouTube API key', () => {
      if (togglePanel(true) !== false) showAuth(true);
    });
  }
})();
