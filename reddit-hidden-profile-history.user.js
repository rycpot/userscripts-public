// ==UserScript==
// @name         Reddit Hidden Profile History
// @namespace    https://github.com/rycpot/userscripts-public
// @version      1
// @description  On new Reddit, when a user's profile history is hidden (fully, or partly: "Some communities may be hidden due to their private status"), shows their posts and comments from the Arctic Shift archive in Reddit's own profile-feed look, with a subreddit filter and search.
// @author       you
// @icon         https://www.reddit.com/favicon.ico
// @match        https://www.reddit.com/*
// @match        https://sh.reddit.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      arctic-shift.photon-reddit.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/rycpot/userscripts-public/main/reddit-hidden-profile-history.user.js
// @updateURL    https://raw.githubusercontent.com/rycpot/userscripts-public/main/reddit-hidden-profile-history.user.js
// ==/UserScript==

/*
 * How it works
 *  - Hidden profile: Reddit shows "<name> likes to keep their posts hidden" (or
 *    similar) instead of a feed. Partly hidden profile: the feed shows, but the
 *    "Active in" modal says "Some communities may be hidden due to their
 *    private status." That modal is loaded lazily, so the script fetches it in
 *    the background instead of waiting for a click.
 *  - Subreddit list: Arctic Shift's users/interactions/subreddits, which counts
 *    the user's whole archived history (not just the latest page).
 *  - Search runs on Arctic Shift's server (posts: title + text, comments: body),
 *    so it covers the full history too. Several subreddits = one request stream
 *    per subreddit, merged newest first.
 *  - Everything is built with DOM calls (no innerHTML), so it is not blocked by
 *    Reddit's Trusted Types policy and archived text cannot run scripts.
 */

(function () {
  'use strict';

  if (window.top !== window.self) return;

  const API = 'https://arctic-shift.photon-reddit.com/api';
  const PAGE = 100;              // items per request (API max is 100 for search)
  const ROOT_ID = 'rhph-root';

  // Text Reddit shows instead of a feed on a fully hidden profile.
  const HIDDEN_PHRASES = [
    'likes to keep their posts hidden',
    'likes to keep their',
  ];
  const PARTIAL_PHRASE = 'some communities may be hidden due to their private status';

  // ---------------------------------------------------------------- utils

  function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

  const debugLog = [];
  function log(...args) {
    debugLog.push(new Date().toISOString().slice(11, 19) + ' ' + args.map((a) =>
      typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    if (debugLog.length > 300) debugLog.shift();
  }

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (attrs[k] == null) continue;
      if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (children) for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return n;
  }

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#x200B;/gi, '​').replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function safeHref(url) {
    let u = (url || '').trim();
    if (/^\/?(r|u|user)\//i.test(u)) u = 'https://www.reddit.com/' + u.replace(/^\//, '');
    else if (u.startsWith('/')) u = 'https://www.reddit.com' + u;
    else if (/^www\./i.test(u)) u = 'https://' + u;
    return /^(https?:|mailto:)/i.test(u) ? u : null;
  }

  // Reddit's own short form: "now", "5m ago", "3h ago", "2d ago", "4mo ago", "3y ago".
  function timeAgo(utc) {
    const s = Math.max(0, Date.now() / 1000 - utc);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    if (s < 86400 * 365) return Math.floor(s / (86400 * 30)) + 'mo ago';
    return Math.floor(s / (86400 * 365)) + 'y ago';
  }

  function fullDate(utc) {
    try { return new Date(utc * 1000).toLocaleString(); } catch (e) { return ''; }
  }

  function compactNumber(n) {
    n = Number(n) || 0;
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  // ------------------------------------------------------------- API layer

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 45000,
        onload: (r) => resolve(r),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  function headerValue(raw, name) {
    const m = new RegExp('^' + name + ':\\s*(.+)$', 'im').exec(raw || '');
    return m ? m[1].trim() : null;
  }

  async function api(path, params) {
    const qs = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    const url = `${API}/${path}?${qs}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      let r;
      try {
        r = await gmGet(url);
      } catch (e) {
        log('request failed', path, e && e.message);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (r.status === 429) {
        const reset = parseFloat(headerValue(r.responseHeaders, 'x-ratelimit-reset')) || 5;
        await sleep(Math.min(60, reset) * 1000 + 250);
        continue;
      }
      if (r.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
      if (r.status !== 200) {
        let msg = '';
        try { msg = JSON.parse(r.responseText).error || ''; } catch (e) { /* not json */ }
        log('API error', r.status, url, (r.responseText || '').slice(0, 200));
        throw new Error(msg || `Arctic Shift returned ${r.status}`);
      }
      const json = JSON.parse(r.responseText);
      return json && json.data;
    }
    throw new Error('Arctic Shift is busy. Try again in a minute.');
  }

  // All-time list of subreddits the user posted or commented in, with counts.
  async function fetchSubreddits(author) {
    const data = await api('users/interactions/subreddits', { author, limit: '' });
    return (Array.isArray(data) ? data : [])
      .filter((d) => d && d.subreddit)
      .map((d) => ({ name: d.subreddit, count: Number(d.count) || 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  // Post titles for comments ("commented on <title>").
  const postCache = new Map();
  async function fetchPostsById(ids) {
    const need = [...new Set(ids)].filter((id) => id && !postCache.has(id));
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      try {
        const data = await api('posts/ids', { ids: chunk.join(',') });
        for (const p of data || []) postCache.set(p.id, p);
      } catch (e) { log('posts/ids failed', e.message); }
      for (const id of chunk) if (!postCache.has(id)) postCache.set(id, null);
    }
  }

  // One stream = one kind (posts|comments), optionally one subreddit, optional text.
  // It pages backwards in time with `before`.
  class Stream {
    constructor(kind, author, subreddit, text) {
      this.kind = kind; this.author = author; this.subreddit = subreddit; this.text = text;
      this.buffer = []; this.before = null; this.done = false; this.loading = null;
    }
    params() {
      const p = { author: this.author, limit: PAGE, sort: 'desc' };
      if (this.subreddit) p.subreddit = this.subreddit;
      if (this.before) p.before = this.before;
      if (this.text) {
        if (this.kind === 'comments') p.body = this.text;
        else p.query = this.text;
      }
      return p;
    }
    async more() {
      if (this.done) return;
      if (this.loading) return this.loading;
      this.loading = (async () => {
        const items = await api(this.kind + '/search', this.params());
        const list = Array.isArray(items) ? items : [];
        for (const it of list) it.__kind = this.kind;
        this.buffer.push(...list);
        if (list.length < PAGE) this.done = true;
        else this.before = Math.floor(list[list.length - 1].created_utc);
        // Items sharing the cursor second may repeat on the next page; dedup happens in Feed.
      })().finally(() => { this.loading = null; });
      return this.loading;
    }
    // Oldest time this stream can vouch for: everything newer has been fetched.
    floor() {
      if (this.done) return -Infinity;
      return this.buffer.length ? this.buffer[this.buffer.length - 1].created_utc : Infinity;
    }
  }

  // Merges several streams newest first.
  class Feed {
    constructor(author, tab, subreddits, text) {
      const kinds = tab === 'posts' ? ['posts'] : tab === 'comments' ? ['comments'] : ['posts', 'comments'];
      const subs = subreddits.length ? subreddits : [null];
      this.streams = [];
      for (const k of kinds) for (const s of subs) this.streams.push(new Stream(k, author, s, text));
      this.seen = new Set();
      this.shown = [];
    }
    get done() { return this.streams.every((s) => s.done && !s.buffer.length); }
    // Returns the next batch of items in order (at least `want` unless exhausted).
    async next(want) {
      const out = [];
      while (out.length < want) {
        // Every unfinished stream must have something buffered before we can merge safely.
        const hungry = this.streams.filter((s) => !s.done && !s.buffer.length);
        if (hungry.length) {
          for (let i = 0; i < hungry.length; i += 4) await Promise.all(hungry.slice(i, i + 4).map((s) => s.more()));
          continue;
        }
        const live = this.streams.filter((s) => s.buffer.length);
        if (!live.length) break;
        // Safe line: the newest "floor" among streams that still have more to load.
        const line = Math.max(...this.streams.filter((s) => !s.done).map((s) => s.floor()), -Infinity);
        let took = false;
        for (;;) {
          let best = null;
          for (const s of live) if (s.buffer.length && (!best || s.buffer[0].created_utc > best.buffer[0].created_utc)) best = s;
          if (!best || best.buffer[0].created_utc < line) break;
          const it = best.buffer.shift();
          const key = it.__kind + it.id;
          if (this.seen.has(key)) continue;
          this.seen.add(key);
          out.push(it);
          took = true;
          if (out.length >= want) break;
        }
        if (!took) {
          // Refill the stream that holds the line back.
          const blocker = this.streams.filter((s) => !s.done).sort((a, b) => b.floor() - a.floor())[0];
          if (!blocker) continue;
          await blocker.more();
        }
      }
      this.shown.push(...out);
      return out;
    }
  }

  // ------------------------------------------------- Reddit markdown → DOM

  function link(text, url, plain) {
    const href = safeHref(url);
    if (!href) return document.createTextNode(text);
    const a = el('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' });
    if (plain) a.textContent = text;
    else appendInline(a, text);
    return a;
  }

  // Inline tokens, earliest match wins.
  const INLINE = [
    { re: /`([^`\n]+)`/, make: (m) => el('code', null, m[1]) },
    { re: /\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/, make: (m) => link(m[1], m[2]) },
    { re: /\*\*\*(?=\S)([\s\S]+?)\*\*\*/, make: (m) => inl(el('strong', null, inl(el('em'), m[1])), '') },
    { re: /\*\*(?=\S)([\s\S]+?)\*\*/, make: (m) => inl(el('strong'), m[1]) },
    { re: /__(?=\S)([\s\S]+?)__/, make: (m) => inl(el('strong'), m[1]) },
    { re: /~~(?=\S)([\s\S]+?)~~/, make: (m) => inl(el('del'), m[1]) },
    { re: />!(?=\S)([\s\S]+?)!</, make: (m) => {
      const s = inl(el('span', { class: 'rdr-spoiler', title: 'Spoiler: click to reveal' }), m[1]);
      s.addEventListener('click', () => s.classList.toggle('rdr-open'));
      return s;
    } },
    { re: /\*(?=\S)([^*\n]+?)\*/, make: (m) => inl(el('em'), m[1]) },
    { re: /(^|[^\w])_(?=\S)([^_\n]+?)_(?!\w)/, make: (m) => frag([m[1], inl(el('em'), m[2])]) },
    { re: /\^\(([^)\n]+)\)/, make: (m) => inl(el('sup'), m[1]) },
    { re: /\^([^\s^]+)/, make: (m) => inl(el('sup'), m[1]) },
    { re: /\bhttps?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/, make: (m) => link(m[0], m[0], true) },
    { re: /(^|[^\w/])(\/?(?:r|u)\/[A-Za-z0-9_-]{2,})/, make: (m) => frag([m[1], link(m[2], m[2], true)]) },
    { re: /\\([\\`*_{}[\]()#+\-.!>~^|])/, make: (m) => document.createTextNode(m[1]) },
  ];

  function frag(parts) {
    const f = document.createDocumentFragment();
    for (const p of parts) if (p != null && p !== '') f.appendChild(typeof p === 'string' ? document.createTextNode(p) : p);
    return f;
  }

  function inl(node, text) { appendInline(node, text); return node; }

  function appendInline(parent, text) {
    let rest = text;
    let guard = 0;
    while (rest && guard++ < 5000) {
      let best = null;
      for (const tok of INLINE) {
        const m = tok.re.exec(rest);
        if (m && (best === null || m.index < best.m.index)) best = { m, tok };
      }
      if (!best) break;
      if (best.m.index > 0) appendText(parent, rest.slice(0, best.m.index));
      parent.appendChild(best.tok.make(best.m));
      rest = rest.slice(best.m.index + best.m[0].length);
    }
    if (rest) appendText(parent, rest);
  }

  // Text with hard line breaks (two trailing spaces or a backslash before \n).
  function appendText(parent, text) {
    const parts = text.split(/(?: {2,}|\\)\n/);
    parts.forEach((p, i) => {
      if (i) parent.appendChild(el('br'));
      parent.appendChild(document.createTextNode(p.replace(/\n/g, ' ')));
    });
  }

  function renderMarkdown(src) {
    const root = document.createDocumentFragment();
    const lines = decodeEntities(src).replace(/\r\n?/g, '\n').split('\n');
    renderBlocks(lines, root);
    return root;
  }

  function renderBlocks(lines, parent) {
    let i = 0;
    let para = [];
    const flush = () => {
      if (para.length) {
        const text = para.join('\n').trim();
        if (text) parent.appendChild(inl(el('p'), text));
        para = [];
      }
    };
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (/^\s*$/.test(line)) { flush(); i++; continue; }
      if ((m = /^\s*(```|~~~)/.exec(line))) {
        flush();
        const fence = m[1];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
        i++;
        parent.appendChild(el('pre', null, el('code', null, body.join('\n'))));
        continue;
      }
      if (/^( {4}|\t)/.test(line) && para.length === 0) {
        const body = [];
        while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || /^\s*$/.test(lines[i]))) {
          body.push(lines[i].replace(/^( {4}|\t)/, ''));
          i++;
        }
        while (body.length && !body[body.length - 1].trim()) body.pop();
        parent.appendChild(el('pre', null, el('code', null, body.join('\n'))));
        continue;
      }
      if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
        flush();
        parent.appendChild(inl(el('h' + m[1].length), m[2]));
        i++;
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        parent.appendChild(el('hr'));
        i++;
        continue;
      }
      if (/^\s{0,3}>/.test(line) && !/^\s{0,3}>!/.test(line)) {
        flush();
        const body = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
          body.push(lines[i].replace(/^\s{0,3}> ?/, ''));
          i++;
        }
        const bq = el('blockquote');
        renderBlocks(body, bq);
        parent.appendChild(bq);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const table = el('table');
        const head = el('tr');
        row(line).forEach((c) => head.appendChild(inl(el('th'), c)));
        table.appendChild(head);
        i += 2;
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
          const tr = el('tr');
          row(lines[i]).forEach((c) => tr.appendChild(inl(el('td'), c)));
          table.appendChild(tr);
          i++;
        }
        parent.appendChild(table);
        continue;
      }
      if ((m = /^(\s*)([-*+]|\d{1,9}[.)])\s+/.exec(line))) {
        flush();
        const ordered = /\d/.test(m[2]);
        const list = el(ordered ? 'ol' : 'ul');
        const itemRe = ordered ? /^\s*\d{1,9}[.)]\s+/ : /^\s*[-*+]\s+/;
        let item = null;
        while (i < lines.length) {
          const l = lines[i];
          if (itemRe.test(l)) {
            item = [l.replace(itemRe, '')];
            list.appendChild(el('li'))._rdr = item;
            i++;
          } else if (item && /^\s+\S/.test(l)) {
            item.push(l.replace(/^\s{1,4}/, ''));
            i++;
          } else if (item && /^\s*$/.test(l) && i + 1 < lines.length && (itemRe.test(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))) {
            item.push('');
            i++;
          } else break;
        }
        for (const li of list.children) {
          const sub = li._rdr;
          delete li._rdr;
          if (sub.length === 1) appendInline(li, sub[0]);
          else renderBlocks(sub, li);
        }
        parent.appendChild(list);
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
  }

  // ---------------------------------------------------------------- styles
  //
  // Items reuse Reddit's own elements and utility classes (copied from a live
  // profile feed), so they pick up Reddit's fonts, colors, hover and dark mode.
  // The rules below only cover our filter bar and the fallbacks used when one
  // of Reddit's components is not loaded on the page.

  const style = document.createElement('style');
  style.textContent = `
    .rhph-scope { --rhph-weak: var(--color-neutral-content-weak, #576f76);
      --rhph-strong: var(--color-neutral-content-strong, #0f1a1c);
      --rhph-border: var(--color-neutral-border-weak, rgba(0,0,0,.1));
      --rhph-hover: var(--color-neutral-background-hover, rgba(0,0,0,.04));
      --rhph-pill: var(--color-secondary-background, #e5ebee);
      --rhph-pill-hover: var(--color-secondary-background-hover, #d2dadd);
      --rhph-sel: var(--color-secondary-background-selected, #d2dadd);
      --rhph-bg: var(--color-neutral-background, #fff); }
    #${ROOT_ID} { width: 100%; color: var(--rhph-strong); }
    .rhph-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; flex: 1 1 auto; min-width: 0; }
    .rhph-bar.rhph-bar-own { padding: 8px 8px 12px; }
    .rhph-btn { display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 12px;
      border-radius: 999px; border: 0; background: var(--rhph-pill); color: var(--rhph-strong);
      font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .rhph-btn:hover { background: var(--rhph-pill-hover); }
    .rhph-btn.rhph-on { background: var(--rhph-sel); }
    .rhph-plain { background: transparent; }
    .rhph-btn svg { width: 16px; height: 16px; }
    .rhph-search { flex: 1 1 180px; min-width: 140px; max-width: 360px; height: 32px; border-radius: 999px;
      padding: 0 14px; border: 1px solid var(--rhph-border); background: var(--color-neutral-background-weak, transparent);
      color: var(--rhph-strong); font: inherit; font-size: 14px; box-sizing: border-box; }
    .rhph-search:focus { outline: none; border-color: var(--color-neutral-border-strong, #888); }
    .rhph-src { font-size: 12px; color: var(--rhph-weak); white-space: nowrap; margin-left: auto; }
    .rhph-src b { color: #ff4500; font-weight: 600; }
    .rhph-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 8px 8px; }
    .rhph-chips:empty { display: none; }
    .rhph-chip { display: inline-flex; align-items: center; gap: 2px; height: 24px; padding: 0 2px 0 10px;
      border-radius: 999px; background: var(--rhph-sel); color: var(--rhph-strong); font-size: 12px; font-weight: 600; }
    .rhph-chip button { border: 0; background: none; color: inherit; cursor: pointer; font-size: 15px; padding: 0 6px; line-height: 1; }
    .rhph-pop { position: absolute; z-index: 100; width: 320px; max-height: 420px; display: flex; flex-direction: column;
      background: var(--color-neutral-background-container, var(--rhph-bg)); color: var(--rhph-strong);
      border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.25); padding: 8px; font-size: 14px; }
    .rhph-pop .rhph-search { max-width: none; flex: none; margin-bottom: 6px; }
    .rhph-pop .rhph-list { overflow-y: auto; }
    .rhph-pop label { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
    .rhph-pop label:hover { background: var(--rhph-hover); }
    .rhph-pop .rhph-n { margin-left: auto; color: var(--rhph-weak); font-size: 12px; }
    .rhph-pop-foot { display: flex; gap: 6px; justify-content: flex-end; padding-top: 6px; flex: none; }
    .rhph-status { padding: 16px; color: var(--rhph-weak); font-size: 14px; text-align: center; }
    .rhph-status.rhph-err { color: var(--color-danger-content, #d93a00); }
    .rhph-status:empty { display: none; }
    .rhph-native-hidden { display: none !important; }
    /* Media */
    .rhph-media { display: block; position: relative; z-index: 1; margin: 4px 0 8px; border-radius: 16px;
      overflow: hidden; border: 1px solid var(--rhph-border); background: #000; max-height: 540px; }
    .rhph-media img { display: block; width: 100%; max-height: 540px; object-fit: contain; }
    .rhph-linkcard { display: inline-block; position: relative; z-index: 1; font-size: 12px; margin: 0 0 8px;
      color: var(--color-link, #0045ac); overflow-wrap: anywhere; }
    .rhph-linkcard:hover { text-decoration: underline; }
    /* Fallback action bar when Reddit's own component is not on the page */
    .rhph-actions { display: flex; gap: 8px; margin-top: 8px; position: relative; z-index: 1; }
    .rhph-pillstat { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
      border-radius: 999px; background: var(--rhph-pill); color: var(--rhph-strong); font-size: 12px; font-weight: 600; }
    .rhph-pillstat:hover { background: var(--rhph-pill-hover); }
    .rhph-pillstat svg { width: 16px; height: 16px; }
    .rhph-actions.rhph-plainbar .rhph-pillstat { background: transparent; }
    .rhph-actions.rhph-plainbar .rhph-pillstat:hover { background: var(--rhph-hover); }
    .rhph-tag { font-size: 12px; font-weight: 600; padding: 0 6px; border-radius: 4px; margin-left: 4px; }
    .rhph-tag-nsfw { color: #fff; background: #d93a00; }
    .rhph-tag-removed { color: var(--rhph-weak); border: 1px solid var(--rhph-border); }
    #${ROOT_ID} .rdr-spoiler { background: currentColor; border-radius: 3px; cursor: pointer; }
    #${ROOT_ID} .rdr-spoiler.rdr-open { background: var(--rhph-hover); }
    #${ROOT_ID} .md a { position: relative; z-index: 1; }
    /* Layout fallbacks with Reddit's spacing, in case a utility class is missing. */
    #${ROOT_ID} a { text-decoration: none; color: inherit; }
    #${ROOT_ID} .md a { text-decoration: underline; color: var(--color-link, var(--color-primary, #0a449b)); }
    #${ROOT_ID} .metadata-divider { padding: 0 2px 0 4px; }
    #${ROOT_ID} ul { list-style: none; padding: 0; margin: 0; }
    #${ROOT_ID} .rhph-cover { position: absolute; inset: 0; }
    #${ROOT_ID} .rhph-flex { display: flex; align-items: center; gap: 4px; min-width: 0; }
    #${ROOT_ID} .rhph-av { display: inline-flex; width: 24px; height: 24px; flex: none; }
    #${ROOT_ID} .rhph-av img { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; }
    #${ROOT_ID} .rhph-post { display: block; position: relative; padding: 4px 16px; margin: 4px 0;
      border-radius: 16px; cursor: pointer; color: var(--rhph-strong); }
    #${ROOT_ID} .rhph-post:hover, #${ROOT_ID} .rhph-cin:hover { background: var(--rhph-hover); }
    #${ROOT_ID} .rhph-credit { font-size: 12px; line-height: 16px; color: var(--rhph-weak); margin: 0 0 4px; min-height: 32px; display: flex; align-items: center; }
    #${ROOT_ID} .rhph-subname { font-weight: 600; color: var(--rhph-strong); }
    #${ROOT_ID} .rhph-subname:hover, #${ROOT_ID} .rhph-ul:hover { text-decoration: underline; }
    #${ROOT_ID} .rhph-ptitle { display: block; font-size: 18px; line-height: 24px; font-weight: 600; margin: 0 0 8px;
      color: var(--rhph-strong); overflow-wrap: anywhere; }
    #${ROOT_ID} .rhph-ptext { font-size: 14px; line-height: 20px; color: var(--color-neutral-content, var(--rhph-strong)); }
    #${ROOT_ID} .rhph-cin { position: relative; border-radius: 16px; }
    #${ROOT_ID} .rhph-cpad { padding: 8px 16px; }
    #${ROOT_ID} .rhph-chead { font-size: 12px; line-height: 24px; position: relative; width: fit-content; }
    #${ROOT_ID} .rhph-cmeta { margin-left: 32px; margin-top: 4px; color: var(--rhph-weak); position: relative; z-index: 1; line-height: 16px; }
    #${ROOT_ID} .rhph-cmeta .rhph-ul { font-weight: 700; color: var(--rhph-strong); }
    #${ROOT_ID} .rhph-cbody { margin-left: 22px; margin-top: 4px; padding-left: 10px; font-size: 14px; line-height: 20px;
      position: relative; z-index: 1; overflow-wrap: anywhere; color: var(--rhph-strong); }
    #${ROOT_ID} .rhph-cbody p, #${ROOT_ID} .rhph-ptext p { margin: 0 0 8px; }
    #${ROOT_ID} .rhph-cbody p:last-child, #${ROOT_ID} .rhph-ptext p:last-child { margin-bottom: 0; }
    #${ROOT_ID} .rhph-cact { margin-left: 24px; position: relative; z-index: 1; }
    #${ROOT_ID} .rhph-cact .rhph-actions { margin-top: 4px; }
  `;

  // ------------------------------------------------------------ rendering

  const PATHS = {
    // Outline arrows (stroked), like Reddit's unvoted state.
    up: 'M10 1.9 18 9.9h-4.6v6.4a2.6 2.6 0 0 1-2.6 2.6H9.2a2.6 2.6 0 0 1-2.6-2.6V9.9H2Z',
    down: 'M10 18.1 2 10.1h4.6V3.7a2.6 2.6 0 0 1 2.6-2.6h1.6a2.6 2.6 0 0 1 2.6 2.6v6.4H18Z',
    comment: 'M10 1a9 9 0 00-9 9c0 1.947.79 3.58 1.935 4.957L.231 17.661A.784.784 0 00.785 19H10a9 9 0 009-9 9 9 0 00-9-9Zm0 16.2H6.162c-.994.004-1.907.053-3.045.144l-.076-.188a36.981 36.981 0 002.328-2.087l-1.05-1.263C3.297 12.576 2.8 11.331 2.8 10c0-3.97 3.23-7.2 7.2-7.2s7.2 3.23 7.2 7.2-3.23 7.2-7.2 7.2Z',
    caret: 'M10 13.125a.882.882 0 01-.625-.259L5.175 8.667a.884.884 0 111.25-1.25L10 10.992l3.575-3.575a.884.884 0 111.25 1.25l-4.2 4.2a.882.882 0 01-.625.258Z',
  };
  function svg(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    s.setAttribute('width', '16'); s.setAttribute('height', '16');
    if (name === 'up' || name === 'down') {
      s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
      s.setAttribute('stroke-width', '1.7'); s.setAttribute('stroke-linejoin', 'round');
    } else s.setAttribute('fill', 'currentColor');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', PATHS[name]);
    s.appendChild(p);
    return s;
  }

  // "18 days ago" (comment credit line, like faceplate-timeago short).
  const rtf = (() => { try { return new Intl.RelativeTimeFormat('en', { numeric: 'always', style: 'short' }); } catch (e) { return null; } })();
  function splitAge(utc) {
    const s = Math.max(0, Date.now() / 1000 - utc);
    if (s < 60) return [Math.floor(s), 'second'];
    if (s < 3600) return [Math.floor(s / 60), 'minute'];
    if (s < 86400) return [Math.floor(s / 3600), 'hour'];
    if (s < 86400 * 30) return [Math.floor(s / 86400), 'day'];
    if (s < 86400 * 365) return [Math.floor(s / (86400 * 30)), 'month'];
    return [Math.floor(s / (86400 * 365)), 'year'];
  }
  function ageShort(utc) {
    const [n, u] = splitAge(utc);
    return rtf ? rtf.format(-n, u) : timeAgo(utc);
  }
  // "3 mths" (post credit bar, faceplate-timeago narrow without "ago").
  const NARROW = { second: ['sec', 'secs'], minute: ['min', 'mins'], hour: ['hr', 'hrs'], day: ['day', 'days'], month: ['mth', 'mths'], year: ['yr', 'yrs'] };
  function ageNarrow(utc) {
    const [n, u] = splitAge(utc);
    return n + ' ' + NARROW[u][n === 1 ? 0 : 1];
  }
  function timeNode(utc, text) {
    return el('time', { datetime: new Date(utc * 1000).toISOString(), title: fullDate(utc) }, text);
  }

  function isRemovedBody(t) {
    t = (t || '').trim();
    return t === '[removed]' || t === '[deleted]' || t === '[ Removed by Reddit ]';
  }

  function defined(tag) {
    try { return !!customElements.get(tag); } catch (e) { return false; }
  }

  // Community icons, looked up once per subreddit.
  const subIcons = new Map();
  function subIconUrl(name) {
    const key = (name || '').toLowerCase();
    if (!subIcons.has(key)) {
      subIcons.set(key, fetch(`/r/${encodeURIComponent(name)}/about.json`, { credentials: 'include', headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const d = j && j.data;
          const u = d && decodeEntities(d.community_icon || d.icon_img || '');
          return u && /^https:\/\//.test(u) ? u : null;
        })
        .catch(() => null));
    }
    return subIcons.get(key);
  }

  // Reddit's round 24px community avatar.
  function subAvatar(name, extraClass) {
    const img = el('img', {
      alt: '', width: '24', loading: 'lazy', referrerpolicy: 'no-referrer',
      class: 'mb-0 shreddit-subreddit-icon__icon rounded-full overflow-hidden nd:bg-secondary-background  w-full h-full',
      style: 'width: 24px; background: #ff4500;',
      src: 'https://www.redditstatic.com/shreddit/assets/snoo_wave.png',
    });
    img.style.visibility = 'hidden';
    subIconUrl(name).then((u) => {
      if (u) { img.src = u; img.style.background = ''; }
      img.style.visibility = '';
    });
    return el('span', { class: 'inline-flex items-center justify-center w-lg h-lg relative shrink-0 rhph-av ' + (extraClass || ''), rpl: '', avatar: '', style: extraClass ? 'margin-right:8px' : null },
      el('span', { rpl: '', class: 'inline-block rounded-full relative h-full w-full overflow-hidden' }, img));
  }

  // Parent authors for "X replied to Y".
  const commentAuthorCache = new Map();
  async function fetchCommentAuthors(ids) {
    const need = [...new Set(ids)].filter((id) => id && !commentAuthorCache.has(id));
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      try {
        const data = await api('comments/ids', { ids: chunk.join(','), fields: 'id,author' });
        for (const c of data || []) commentAuthorCache.set(c.id, c.author);
      } catch (e) { log('comments/ids failed', e.message); }
      for (const id of chunk) if (!commentAuthorCache.has(id)) commentAuthorCache.set(id, null);
    }
  }

  function parentAuthor(c) {
    const pid = c.parent_id || '';
    if (pid.startsWith('t1_')) return commentAuthorCache.get(pid.slice(3)) || null;
    if (pid.startsWith('t3_')) { const p = postCache.get(pid.slice(3)); return p ? p.author : null; }
    return null;
  }

  function stat(icon, text, href) {
    const n = el(href ? 'a' : 'span', { class: 'rhph-pillstat', href }, [svg(icon), text]);
    return n;
  }

  function fallbackPostBar(p, href) {
    return el('div', { class: 'rhph-actions rhph-fallback' }, [
      el('span', { class: 'rhph-pillstat' }, [svg('up'), compactNumber(p.score), svg('down')]),
      stat('comment', compactNumber(p.num_comments), href),
    ]);
  }

  // Remove our stand-in bars if Reddit's component loads after we rendered.
  function dropFallbackWhenDefined(tag, root) {
    if (defined(tag)) return;
    customElements.whenDefined(tag).then(() => {
      root.querySelectorAll(`.rhph-fallback[data-for="${tag}"]`).forEach((n) => n.remove());
    }).catch(() => {});
  }

  function mediaFor(p) {
    const prev = p.preview && p.preview.images && p.preview.images[0];
    let src = prev && prev.source && decodeEntities(prev.source.url);
    if (!src && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(p.url || '')) src = p.url;
    if (!src && p.media_metadata) {
      const first = Object.values(p.media_metadata)[0];
      src = first && first.s && decodeEntities(first.s.u || first.s.gif || '');
    }
    if (!src && p.thumbnail && /^https:\/\//.test(p.thumbnail)) src = p.thumbnail;
    return src && /^https:\/\//.test(src) ? src : null;
  }

  function postType(p) {
    if (p.is_self) return 'text';
    if (p.is_gallery) return 'gallery';
    if (p.is_video) return 'video';
    if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(p.url || '') || p.post_hint === 'image') return 'image';
    return 'link';
  }

  // A post, built like Reddit's own profile-feed card (<shreddit-post> + slots).
  function renderPost(p, index) {
    const permalink = p.permalink || `/comments/${p.id}/`;
    const href = 'https://www.reddit.com' + permalink;
    const sub = p.subreddit;
    const subHref = `https://www.reddit.com/r/${sub}/`;
    const useNative = defined('shreddit-post');
    const post = el(useNative ? 'shreddit-post' : 'div', {
      class: 'block relative cursor-pointer group bg-neutral-background focus-within:bg-neutral-background-hover hover:bg-neutral-background-hover xs:rounded-4 px-md py-2xs my-2xs',
      permalink, 'content-href': href, 'view-context': 'ProfileFeed2', 'comment-count': String(p.num_comments || 0),
      'view-type': 'cardView', 'pdp-target': '_self', 'created-timestamp': new Date(p.created_utc * 1000).toISOString(),
      domain: p.domain || '', id: 't3_' + p.id, 'post-title': decodeEntities(p.title || ''), 'post-type': postType(p),
      score: String(p.score || 0), 'subreddit-prefixed-name': 'r/' + sub, 'subreddit-name': sub,
      'subreddit-id': p.subreddit_id || null, author: p.author || '', 'author-id': p.author_fullname || null,
      'item-state': 'UNMODERATED', 'data-rhph': '1',
    });
    post.classList.add('rhph-post');
    if (!useNative) post.classList.add('hover:bg-neutral-background-hover');

    post.appendChild(el('a', { slot: 'full-post-link', class: 'absolute inset-0 rhph-cover', href, target: '_self', 'aria-label': decodeEntities(p.title || '') }));

    // Credit bar: icon, r/sub • time
    const credit = el('span', { slot: 'credit-bar', class: 'flex w-full items-center justify-between -mb-2xs mb-2xs -mt-2xs rhph-credit' },
      el('span', { class: 'flex-1 min-w-0' },
        el('div', { class: 'flex min-w-0 w-full items-center gap-2xs rhph-flex', style: 'position:relative;z-index:1;gap:4px' }, [
          el('span', { class: 'flex shrink-0' }, el('a', { class: 'inline-flex', href: subHref, tabindex: '-1', 'aria-hidden': 'true' }, subAvatar(sub))),
          el('ul', { rpl: '', class: 'text-neutral-content-weak text-caption-1 p-0 m-0 list-none flex gap-2xs min-w-0 w-full items-center', role: 'presentation', style: 'font-size:12px;display:flex;align-items:center;gap:4px' }, [
            el('li', { class: 'p-0 m-0 inline-flex whitespace-nowrap items-center overflow-hidden' }, [
              el('a', { class: 'inline-flex max-w-full min-w-0 items-center gap-2xs text-label-2 text-secondary-plain whitespace-nowrap rhph-subname', href: subHref }, 'r/' + sub),
              el('span', { 'aria-hidden': 'true', class: 'metadata-divider w-2xs inline-flex shrink-0 justify-center ps-2xs' }, '•'),
            ]),
            el('li', { class: 'p-0 m-0 inline-flex whitespace-nowrap items-center' }, [
              timeNode(p.created_utc, ageNarrow(p.created_utc)),
              p.over_18 ? el('span', { class: 'rhph-tag rhph-tag-nsfw' }, 'NSFW') : null,
              (isRemovedBody(p.selftext) || p.removed_by_category) ? el('span', { class: 'rhph-tag rhph-tag-removed' }, 'Removed') : null,
            ]),
          ]),
        ])));
    post.appendChild(credit);

    post.appendChild(el('a', {
      href, id: 'post-title-t3_' + p.id, slot: 'title', dir: 'auto',
      class: 'block text-neutral-content-strong m-0 visited:text-neutral-content-weak font-semibold text-16-scalable xs:text-18-scalable mb-2xs xs:mb-xs overflow-hidden rhph-ptitle',
    }, decodeEntities(p.title || '')));

    if (p.selftext && !isRemovedBody(p.selftext)) {
      const md = el('div', {
        class: 'md feed-card-text-preview text-ellipsis line-clamp-3 xs:line-clamp-6 text-14-scalable pb-2xs [--emote-size:20px] rhph-ptext',
        dir: 'auto', style: 'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:hidden',
      });
      md.appendChild(renderMarkdown(p.selftext));
      post.appendChild(el('div', { slot: 'text-body' },
        el('a', { href, class: 'hover:no-underline no-underline pointer-events-none text-neutral-content visited:text-neutral-content-weak', style: 'pointer-events:none;color:inherit;text-decoration:none' },
          el('div', { class: 'overflow-hidden' }, md))));
    } else if (!p.is_self) {
      const src = mediaFor(p);
      if (src) {
        post.appendChild(el('div', { slot: 'post-media-container' },
          el('a', { class: 'rhph-media', href }, el('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }))));
      } else if (p.url && safeHref(p.url) && !/reddit\.com\/r\/.+\/comments\//.test(p.url)) {
        post.appendChild(el('div', { slot: 'text-body' },
          el('a', { class: 'rhph-linkcard', href: safeHref(p.url), target: '_blank', rel: 'noopener noreferrer' },
            p.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 70))));
      }
    }

    if (!useNative) {
      const bar = fallbackPostBar(p, href);
      bar.setAttribute('data-for', 'shreddit-post');
      post.appendChild(bar);
      post.addEventListener('click', (e) => {
        if (e.target.closest('a, button, .rdr-spoiler')) return;
        location.href = href;
      });
    }
    return el('article', { class: 'w-full m-0', 'data-post-id': 't3_' + p.id, 'data-rhph-index': String(index) }, post);
  }

  // A comment, built like Reddit's <shreddit-profile-comment>.
  function renderComment(c, author, index) {
    const linkId = (c.link_id || '').replace(/^t3_/, '');
    const post = postCache.get(linkId);
    const sub = c.subreddit;
    const subHref = `/r/${sub}/`;
    const postHref = post && post.permalink ? post.permalink : `/r/${sub}/comments/${linkId}/`;
    const permalink = (c.permalink ? c.permalink : `/r/${sub}/comments/${linkId}/comment/${c.id}/`).replace(/\/?$/, '/') + '?context=3';
    const title = post && post.title ? decodeEntities(post.title) : 'View post';
    const replyTo = parentAuthor(c);

    const body = el('div', { class: 'md pt-xs pb-2xs [--emote-size:20px]', dir: 'auto' });
    if (isRemovedBody(c.body)) body.appendChild(el('p', null, el('em', null, c.body)));
    else body.appendChild(renderMarkdown(c.body || ''));

    const nativeRow = defined('shreddit-comment-action-row');
    const reply = el('a', {
      rpl: '', class: 'button rpl-cab border-sm text-label-2 button-plain-weak inline-flex items-center px-sm py-xs',
      href: permalink, style: 'height: var(--size-button-sm-h);', target: '_blank',
    }, el('span', { class: 'rpl-cab--leading-icon flex items-center' }, [
      el('span', { class: 'flex text-body-1 me-2xs' }, svg('comment')),
      el('span', { class: 'rpl-cab--content' }, 'Reply'),
    ]));
    let actions;
    if (nativeRow) {
      actions = el('shreddit-comment-action-row', {
        'comment-id': 't1_' + c.id, slot: 'actionRow', score: String(c.score || 0), permalink,
        'telemetry-source': 'profile', 'vote-state': 'NONE', 'is-desktop-viewport': 'true', class: 'block',
      }, [
        el('span', { slot: 'comment-reply', class: 'contents' }, reply),
        defined('shreddit-comment-share-button')
          ? el('shreddit-comment-share-button', { slot: 'comment-share', 'is-desktop-viewport': 'true', permalink }) : null,
      ]);
    } else {
      actions = el('div', { class: 'rhph-actions rhph-plainbar' }, [
        el('span', { class: 'rhph-pillstat' }, [svg('up'), compactNumber(c.score), svg('down')]),
        el('a', { class: 'rhph-pillstat', href: permalink, target: '_blank' }, [svg('comment'), 'Reply']),
      ]);
    }

    const userLink = (name) => (name === '[deleted]'
      ? el('span', { class: 'font-bold text-12 text-tone-1 rhph-ul' }, name)
      : el('a', { rpl: '', class: 'font-bold text-12 hover:underline text-tone-1 inline-flex items-center rhph-ul', href: `/user/${name}/` }, el('span', { dir: 'auto' }, name)));

    const inner = el('div', { class: 'hover:bg-neutral-background-hover relative rounded-4 rhph-cin' }, [
      el('a', { href: permalink, class: 'absolute inset-0 rhph-cover', 'aria-label': `Thread for ${author}'s comment on ${title}` }),
      el('div', { class: 'px-md py-sm rhph-cpad' }, [
        el('div', { class: 'text-12 relative w-fit rhph-chead' }, [
          el('div', { class: 'flex items-center rhph-flex', style: 'position:relative;z-index:1;gap:0' }, [
            el('a', { rpl: '', class: 'flex items-center text-tone-1 font-semibold whitespace-nowrap h-lg', href: subHref, role: 'presentation' },
              subAvatar(sub, 'me-xs')),
            el('div', { class: 'grow leading-6 text-neutral-content-strong' }, [
              el('a', { rpl: '', class: 'inline-flex items-center text-tone-1 font-semibold whitespace-nowrap h-lg rhph-subname', href: subHref }, 'r/' + sub),
              el('span', { class: 'px-2xs' }, ' • '),
              el('h2', { class: 'inline-block m-0', style: 'font-size:inherit;display:inline' },
                el('a', { rpl: '', class: 'text-neutral-content-strong font-normal hover:underline rhph-ul', href: postHref, target: '_blank', style: 'font-weight:400' }, title)),
            ]),
          ]),
          el('div', { class: 'text-neutral-content-weak inline-block ms-xl mt-2xs rhph-cmeta' }, [
            el('span', null, [
              userLink(author),
              replyTo ? ' replied to ' : null,
              replyTo ? userLink(replyTo) : null,
            ]),
            ' ',
            timeNode(c.created_utc, ageShort(c.created_utc)),
          ]),
        ]),
        el('div', { class: 'ms-[22px] mt-2xs ps-[10px] md rhph-cbody' },
          el('div', { class: 'text-neutral-content-strong overflow-hidden' }, body)),
        el('div', { class: 'block ms-lg relative rhph-cact' }, actions),
      ]),
    ]);

    const node = el(defined('shreddit-profile-comment') ? 'shreddit-profile-comment' : 'div', {
      href: permalink, class: 'w-full rounded-4 my-2xs block', 'comment-id': 't1_' + c.id, 'data-rhph': '1',
    }, inner);
    return el('article', { 'aria-label': title, class: 'mb-0 w-full', 'data-rhph-index': String(index) }, node);
  }

  function separator() {
    return el('hr', { class: 'border-0 border-b-sm border-solid border-b-neutral-border-weak', style: 'border:0;border-bottom:1px solid var(--color-neutral-border-weak, rgba(0,0,0,.1));margin:0' });
  }

  // ------------------------------------------------------------- the view

  function tabFromPath() {
    const p = location.pathname;
    if (/\/submitted\/?$/.test(p)) return 'posts';
    if (/\/comments\/?$/.test(p)) return 'comments';
    return 'overview';
  }

  function userFromPath() {
    const m = /^\/(?:user|u)\/([^/?#]+)\/?(?:overview|submitted|comments)?\/?$/i.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  }

  class View {
    constructor(author, reason) {
      this.author = author;
      this.reason = reason;          // 'hidden' | 'partial'
      this.subs = [];                // selected subreddit names
      this.text = '';
      this.tab = tabFromPath();
      this.allSubs = null;
      this.count = 0;
      this.root = el('div', { id: ROOT_ID, class: 'rhph-scope' });
      this.build();
    }

    build() {
      this.subBtn = el('button', { class: 'rhph-btn', type: 'button' }, ['All communities', svg('caret')]);
      this.subBtn.addEventListener('click', () => this.openPicker());
      this.search = el('input', { class: 'rhph-search', type: 'search', placeholder: 'Search posts and comments' });
      let t;
      this.search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => this.setText(this.search.value), 600); });
      this.search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(t); this.setText(this.search.value); } });
      this.toggleNative = this.reason === 'partial'
        ? el('button', { class: 'rhph-btn rhph-plain', type: 'button', title: 'Some communities are hidden on this profile' }, 'Show Reddit\'s view') : null;
      this.src = el('span', { class: 'rhph-src', title: this.reason === 'partial'
        ? 'Some of this profile\'s communities are hidden; this is the full archived history.'
        : 'This profile\'s history is hidden; this is the archived history.' }, ['from ', el('b', null, 'Arctic Shift')]);
      this.bar = el('div', { class: 'rhph-bar rhph-scope' }, [this.subBtn, this.search, this.toggleNative, this.src]);
      this.chips = el('div', { class: 'rhph-chips' });
      this.list = el('div', { class: 'rhph-list' });
      this.status = el('div', { class: 'rhph-status' });
      this.sentinel = el('div', { style: 'height:1px' });
      this.root.append(this.chips, this.list, this.status, this.sentinel);

      this.io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) this.loadMore(); }, { rootMargin: '1200px' });
      this.io.observe(this.sentinel);
      fetchSubreddits(this.author).then((s) => { this.allSubs = s; if (this.pop) this.fillPicker(); })
        .catch((e) => { this.allSubs = []; this.subsError = e.message; if (this.pop) this.fillPicker(); });
      this.reset();
    }

    setText(v) {
      v = (v || '').trim();
      if (v === this.text) return;
      this.text = v;
      this.reset();
    }

    setTab(tab) {
      if (tab === this.tab) return;
      this.tab = tab;
      this.reset();
    }

    renderChips() {
      this.chips.replaceChildren(...this.subs.map((s) => {
        const x = el('button', { type: 'button', title: 'Remove', 'aria-label': 'Remove r/' + s }, '×');
        x.addEventListener('click', () => { this.subs = this.subs.filter((n) => n !== s); this.afterSubs(); });
        return el('span', { class: 'rhph-chip' }, ['r/' + s, x]);
      }));
      this.subBtn.replaceChildren(this.subs.length === 1 ? 'r/' + this.subs[0]
        : this.subs.length ? `${this.subs.length} communities` : 'All communities', svg('caret'));
      this.subBtn.classList.toggle('rhph-on', !!this.subs.length);
    }

    afterSubs() { this.renderChips(); this.reset(); }

    openPicker() {
      if (this.pop) { this.closePicker(); return; }
      this.pop = el('div', { class: 'rhph-pop rhph-scope' });
      this.popFilter = el('input', { class: 'rhph-search', type: 'search', placeholder: 'Find a community' });
      this.popFilter.addEventListener('input', () => this.fillPicker());
      this.popFilter.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply.click(); if (e.key === 'Escape') this.closePicker(); });
      this.popList = el('div', { class: 'rhph-list' });
      const clear = el('button', { class: 'rhph-btn rhph-plain', type: 'button' }, 'Clear');
      clear.addEventListener('click', () => { this.pending = new Set(); this.fillPicker(); });
      const apply = el('button', { class: 'rhph-btn', type: 'button' }, 'Apply');
      apply.addEventListener('click', () => { this.subs = [...this.pending]; this.closePicker(); this.afterSubs(); });
      this.pop.append(this.popFilter, this.popList, el('div', { class: 'rhph-pop-foot' }, [clear, apply]));
      this.pending = new Set(this.subs);
      const r = this.subBtn.getBoundingClientRect();
      this.pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
      this.pop.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 330)) + 'px';
      document.body.appendChild(this.pop);
      this.fillPicker();
      this.popFilter.focus();
      this.outside = (e) => { if (this.pop && !this.pop.contains(e.target) && !this.subBtn.contains(e.target)) this.closePicker(); };
      setTimeout(() => document.addEventListener('mousedown', this.outside), 0);
    }

    closePicker() {
      if (!this.pop) return;
      this.pop.remove(); this.pop = null;
      document.removeEventListener('mousedown', this.outside);
    }

    fillPicker() {
      if (!this.pop) return;
      if (!this.allSubs) { this.popList.replaceChildren(el('div', { class: 'rhph-status' }, 'Loading communities…')); return; }
      if (!this.allSubs.length) {
        this.popList.replaceChildren(el('div', { class: 'rhph-status' }, this.subsError || 'No communities in the archive.'));
        return;
      }
      const q = this.popFilter.value.trim().toLowerCase().replace(/^r\//, '');
      const rows = this.allSubs.filter((s) => !q || s.name.toLowerCase().includes(q))
        .sort((a, b) => (this.pending.has(b.name) - this.pending.has(a.name)) || b.count - a.count);
      this.popList.replaceChildren(...rows.slice(0, 400).map((s) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = this.pending.has(s.name);
        cb.addEventListener('change', () => { if (cb.checked) this.pending.add(s.name); else this.pending.delete(s.name); });
        return el('label', null, [cb, 'r/' + s.name, el('span', { class: 'rhph-n' }, compactNumber(s.count))]);
      }));
    }

    reset() {
      this.gen = (this.gen || 0) + 1;
      this.feed = new Feed(this.author, this.tab, this.subs, this.text);
      this.list.replaceChildren();
      this.count = 0;
      this.busy = false;
      this.loadMore();
    }

    async loadMore() {
      if (this.busy || this.feed.done) return;
      this.busy = true;
      const gen = this.gen;
      this.status.className = 'rhph-status';
      this.status.textContent = 'Loading…';
      let failed = false;
      try {
        const items = await this.feed.next(25);
        if (gen !== this.gen) return;
        const comments = items.filter((i) => i.__kind === 'comments');
        await fetchPostsById(comments.map((c) => (c.link_id || '').replace(/^t3_/, '')));
        await fetchCommentAuthors(comments.map((c) => c.parent_id || '').filter((id) => id.startsWith('t1_')).map((id) => id.slice(3)));
        if (gen !== this.gen) return;
        for (const it of items) {
          if (this.count) this.list.appendChild(separator());
          this.list.appendChild(it.__kind === 'posts' ? renderPost(it, this.count) : renderComment(it, this.author, this.count));
          this.count++;
        }
        dropFallbackWhenDefined('shreddit-post', this.list);
        if (this.feed.done) {
          this.status.textContent = this.count ? '' : (this.text || this.subs.length ? 'No matches in the archive.' : 'Nothing archived for this user.');
        } else this.status.textContent = '';
      } catch (e) {
        if (gen !== this.gen) return;
        failed = true;
        this.status.className = 'rhph-status rhph-err';
        const b = el('button', { class: 'rhph-btn', type: 'button' }, 'Retry');
        b.addEventListener('click', () => this.loadMore());
        this.status.replaceChildren(e.message + ' ', b);
      } finally {
        if (gen === this.gen) {
          this.busy = false;
          // Keep filling while the bottom is still near the screen.
          const r = this.sentinel.getBoundingClientRect();
          if (!failed && !this.feed.done && r.top < window.innerHeight + 1200) setTimeout(() => this.loadMore(), 50);
        }
      }
    }

    destroy() {
      this.gen++;
      this.io.disconnect();
      this.closePicker();
      this.root.remove();
      this.bar.remove();
    }
  }

  // --------------------------------------------------- detecting & mounting

  function lower(s) { return (s || '').replace(/\s+/g, ' ').toLowerCase(); }

  function profileFeed() {
    return document.querySelector('main shreddit-feed') || document.querySelector('shreddit-feed');
  }

  // Fully hidden: Reddit's empty feed says "<name> likes to keep their posts hidden".
  function isHidden(feed) {
    const empty = feed && feed.querySelector('#empty-feed-content');
    const scope = empty || feed;
    if (!scope) return false;
    const t = lower(scope.textContent);
    return HIDDEN_PHRASES.some((p) => t.includes(p));
  }

  // Partly hidden: the "Active in" modal (loaded only on click) says
  // "Some communities may be hidden due to their private status."
  // Fetch the same partial Reddit would load, once per user.
  const partialCache = new Map();
  function checkPartial(author) {
    const modal = document.querySelector('shreddit-active-subreddits-modal');
    if (modal && lower(modal.textContent).includes(PARTIAL_PHRASE)) return Promise.resolve(true);
    const key = author.toLowerCase();
    if (!partialCache.has(key)) {
      partialCache.set(key, fetch(`/svc/shreddit/profiles/${encodeURIComponent(author)}/profile-active-subreddits-modal`, { credentials: 'include' })
        .then((r) => (r.ok ? r.text() : ''))
        .then((html) => { const hit = lower(html).includes(PARTIAL_PHRASE); log('active-in check', author, hit); return hit; })
        .catch((e) => { log('active-in check failed', e && e.message); return false; }));
    }
    return partialCache.get(key);
  }

  // The row that holds Reddit's sort dropdown ("New ▾") above the feed.
  function feedOptionsRow() {
    const setter = document.querySelector('main shreddit-layout-event-setter');
    const row = setter && setter.closest('div.flex');
    return row ? { row, setter } : null;
  }

  let view = null;
  let viewKey = '';
  let hiddenNodes = [];

  function hideNative(nodes) {
    for (const n of nodes) if (n) { n.classList.add('rhph-native-hidden'); hiddenNodes.push(n); }
  }

  function unmount() {
    if (view) view.destroy();
    view = null; viewKey = '';
    for (const n of hiddenNodes) n.classList.remove('rhph-native-hidden');
    hiddenNodes = [];
  }

  function mount(author, reason, feed) {
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
    view = new View(author, reason);
    viewKey = author.toLowerCase();
    feed.parentElement.insertBefore(view.root, feed);
    const opts = feedOptionsRow();
    if (opts) {
      opts.row.appendChild(view.bar);
      hideNative([opts.setter]);
    } else {
      view.bar.classList.add('rhph-bar-own');
      view.root.insertBefore(view.bar, view.root.firstChild);
    }
    hideNative([feed]);
    if (view.toggleNative) {
      view.toggleNative.addEventListener('click', () => {
        const showNative = feed.classList.toggle('rhph-native-hidden') === false;
        if (opts) opts.setter.classList.toggle('rhph-native-hidden', !showNative);
        view.root.style.display = showNative ? 'none' : '';
        view.subBtn.style.display = view.search.style.display = showNative ? 'none' : '';
        view.toggleNative.textContent = showNative ? 'Show full history' : 'Show Reddit\'s view';
      });
    }
    log('mounted', author, reason, opts ? 'bar in feed options' : 'own bar');
  }

  let checking = false;
  async function check() {
    if (checking) return;
    const author = userFromPath();
    if (!author) { if (view) unmount(); return; }
    if (view) {
      if (viewKey === author.toLowerCase() && view.root.isConnected) { view.setTab(tabFromPath()); return; }
      unmount();
    }
    const feed = profileFeed();
    if (!feed) return;
    checking = true;
    try {
      if (isHidden(feed)) { mount(author, 'hidden', feed); return; }
      if (await checkPartial(author)) {
        if (userFromPath() !== author || view) return;
        const f = profileFeed();
        if (f) mount(author, 'partial', f);
      }
    } finally { checking = false; }
  }

  let queued = false;
  function queueCheck() {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; check(); }, 300);
  }

  new MutationObserver(queueCheck).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', queueCheck);
  queueCheck();

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Copy debug report', () => {
      const text = ['url ' + location.href, 'view ' + (view ? view.reason : 'none'),
        'shreddit-post defined ' + defined('shreddit-post'),
        'action-row defined ' + defined('shreddit-comment-action-row'), ...debugLog].join('\n');
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text); else console.log(text);
    });
  }
})();
