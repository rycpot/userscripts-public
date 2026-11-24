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
    'hasn\'t posted yet',          // not hidden, but checked against the archive below
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

  const style = document.createElement('style');
  style.textContent = `
    #${ROOT_ID}, .rhph-pop { --rhph-weak: var(--color-neutral-content-weak, #576f76);
      --rhph-strong: var(--color-neutral-content-strong, #0f1a1c);
      --rhph-border: var(--color-neutral-border-weak, rgba(0,0,0,.1));
      --rhph-hover: var(--color-neutral-background-hover, rgba(0,0,0,.04));
      --rhph-pill: var(--color-secondary-background, #e5ebee);
      --rhph-pill-hover: var(--color-secondary-background-hover, #d2dadd);
      --rhph-sel: var(--color-neutral-background-selected, #d2dadd);
      --rhph-bg: var(--color-neutral-background, #fff);
      color: var(--rhph-strong); font-family: inherit; }
    #${ROOT_ID} { width: 100%; }
    #${ROOT_ID} a { color: inherit; text-decoration: none; }
    .rhph-banner { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--rhph-weak);
      padding: 8px 16px; }
    .rhph-banner b { color: #ff4500; font-weight: 600; }
    .rhph-banner button { margin-left: auto; }
    .rhph-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 16px 12px;
      position: sticky; top: var(--shreddit-header-height, 56px); z-index: 3; background: var(--rhph-bg); }
    .rhph-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
      border-radius: 999px; border: 0; background: var(--rhph-pill); color: var(--rhph-strong);
      font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
    .rhph-btn:hover { background: var(--rhph-pill-hover); }
    .rhph-btn.rhph-on { background: var(--rhph-sel); }
    .rhph-plain { background: transparent; }
    .rhph-search { flex: 1 1 200px; min-width: 160px; height: 32px; border-radius: 999px; padding: 0 14px;
      border: 1px solid var(--rhph-border); background: var(--color-neutral-background-weak, transparent);
      color: var(--rhph-strong); font: inherit; font-size: 14px; }
    .rhph-chips { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; }
    .rhph-chips:empty { display: none; }
    .rhph-chip { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 4px 0 10px;
      border-radius: 999px; background: var(--rhph-sel); font-size: 12px; font-weight: 600; }
    .rhph-chip button { border: 0; background: none; color: inherit; cursor: pointer; font-size: 14px; padding: 0 4px; }
    .rhph-pop { position: absolute; z-index: 20; width: 320px; max-height: 420px; display: flex; flex-direction: column;
      background: var(--color-neutral-background-container, var(--rhph-bg)); color: var(--rhph-strong);
      border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.25); padding: 8px; }
    .rhph-pop input { margin-bottom: 6px; flex: none; }
    .rhph-pop .rhph-list { overflow-y: auto; }
    .rhph-pop label { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px;
      font-size: 14px; cursor: pointer; }
    .rhph-pop label:hover { background: var(--rhph-hover); }
    .rhph-pop label span.rhph-n { margin-left: auto; color: var(--rhph-weak); font-size: 12px; }
    .rhph-pop .rhph-pop-foot { display: flex; gap: 6px; justify-content: flex-end; padding-top: 6px; flex: none; }
    .rhph-status { padding: 16px; color: var(--rhph-weak); font-size: 14px; text-align: center; }
    .rhph-status.rhph-err { color: var(--color-danger-content, #d93a00); }
    .rhph-hr { border: 0; border-top: 1px solid var(--rhph-border); margin: 0 16px; }

    .rhph-item { position: relative; display: block; padding: 4px 16px 8px; margin: 4px 0;
      border-radius: 16px; cursor: pointer; }
    .rhph-item:hover { background: var(--rhph-hover); }
    .rhph-meta { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--rhph-weak);
      min-height: 32px; flex-wrap: wrap; }
    .rhph-meta .rhph-sub { color: var(--rhph-strong); font-weight: 600; }
    .rhph-meta a:hover { text-decoration: underline; }
    .rhph-icon { width: 24px; height: 24px; border-radius: 50%; flex: none; object-fit: cover;
      background: #ff4500; color: #fff; display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; }
    .rhph-title { font-size: 18px; line-height: 24px; font-weight: 600; margin: 4px 0 8px;
      overflow-wrap: anywhere; color: var(--rhph-strong); }
    .rhph-post-title { color: var(--rhph-strong); font-weight: 600; }
    .rhph-body { font-size: 14px; line-height: 20px; overflow-wrap: anywhere; color: var(--rhph-strong); }
    .rhph-body.rhph-clamp { max-height: 180px; overflow: hidden;
      -webkit-mask-image: linear-gradient(180deg, #000 70%, transparent); mask-image: linear-gradient(180deg, #000 70%, transparent); }
    .rhph-body p { margin: 0 0 .7em; } .rhph-body p:last-child { margin-bottom: 0; }
    .rhph-body a { color: var(--color-link, #0045ac); text-decoration: underline; }
    .rhph-body blockquote { border-left: 4px solid var(--rhph-border); margin: .4em 0; padding-left: 10px; }
    .rhph-body pre { background: var(--rhph-hover); padding: 8px; border-radius: 8px; overflow-x: auto; white-space: pre; font-size: 13px; }
    .rhph-body code { background: var(--rhph-hover); padding: 0 3px; border-radius: 3px; font-size: 13px; }
    .rhph-body pre code { background: none; padding: 0; }
    .rhph-body ul, .rhph-body ol { margin: .3em 0 .7em 1.4em; padding: 0; }
    .rhph-body ul { list-style: disc; } .rhph-body ol { list-style: decimal; }
    .rhph-body h1, .rhph-body h2, .rhph-body h3, .rhph-body h4, .rhph-body h5, .rhph-body h6 { font-weight: 700; margin: .5em 0 .3em; font-size: 1.05em; }
    .rhph-body hr { border: 0; border-top: 1px solid var(--rhph-border); margin: .6em 0; }
    .rhph-body table { border-collapse: collapse; margin: .4em 0; }
    .rhph-body th, .rhph-body td { border: 1px solid var(--rhph-border); padding: 2px 6px; }
    .rdr-spoiler { background: currentColor; border-radius: 3px; cursor: pointer; }
    .rdr-spoiler.rdr-open { background: var(--rhph-hover); }
    .rhph-thumb { display: block; max-width: 100%; max-height: 540px; border-radius: 16px; margin: 4px 0 8px;
      border: 1px solid var(--rhph-border); object-fit: contain; background: #000; }
    .rhph-linkcard { display: inline-block; font-size: 12px; color: var(--color-link, #0045ac) !important;
      margin: 0 0 8px; overflow-wrap: anywhere; }
    .rhph-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .rhph-pillstat { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
      border-radius: 999px; background: var(--rhph-pill); font-size: 12px; font-weight: 600; }
    .rhph-pillstat svg { width: 16px; height: 16px; fill: currentColor; }
    .rhph-tag { font-size: 12px; font-weight: 600; padding: 0 6px; border-radius: 4px; }
    .rhph-tag-nsfw { color: #fff; background: #d93a00; }
    .rhph-tag-removed { color: var(--rhph-weak); border: 1px solid var(--rhph-border); }
    .rhph-dot { position: absolute; top: 14px; right: -24px; width: 8px; height: 8px; border-radius: 50%;
      background: #ff4500; opacity: .8; }
    .rhph-native-hidden { display: none !important; }
  `;

  // ------------------------------------------------------------ rendering

  const ICONS = {
    up: 'M10 19a3.966 3.966 0 01-3.96-3.962V10.98H2.838a1.731 1.731 0 01-1.605-1.073 1.734 1.734 0 01.377-1.895L9.364.254a.925.925 0 011.272 0l7.754 7.759c.498.499.646 1.242.376 1.894-.27.652-.9 1.073-1.605 1.073h-3.202v4.058A3.965 3.965 0 019.999 19H10z',
    comment: 'M10 19H1.871a.886.886 0 01-.798-.52.886.886 0 01.158-.941L3.1 15.771A9 9 0 1110 19zm-6.549-1.5H10a7.5 7.5 0 10-5.323-2.219l.54.545L3.451 17.5z',
  };
  function svg(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', ICONS[name]);
    s.appendChild(p);
    return s;
  }

  const subIcons = new Map();
  function subIcon(name) {
    const span = el('span', { class: 'rhph-icon' }, (name || '?').slice(0, 1).toUpperCase());
    const key = (name || '').toLowerCase();
    if (!subIcons.has(key)) {
      subIcons.set(key, fetch(`/r/${encodeURIComponent(name)}/about.json`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const d = j && j.data;
          const u = d && decodeEntities(d.community_icon || d.icon_img || '').split('?')[0];
          return u && /^https:\/\//.test(u) ? u : null;
        })
        .catch(() => null));
    }
    subIcons.get(key).then((u) => {
      if (!u || !span.isConnected) return;
      const img = el('img', { class: 'rhph-icon', src: u, alt: '', referrerpolicy: 'no-referrer' });
      span.replaceWith(img);
    });
    return span;
  }

  function subLink(sub) {
    return el('a', { class: 'rhph-sub', href: `/r/${sub}/` }, 'r/' + sub);
  }

  function timeEl(utc) {
    return el('time', { datetime: new Date(utc * 1000).toISOString(), title: fullDate(utc) }, timeAgo(utc));
  }

  function isRemovedBody(t) {
    t = (t || '').trim();
    return t === '[removed]' || t === '[deleted]' || t === '[ Removed by Reddit ]';
  }

  function stat(icon, text) {
    return el('span', { class: 'rhph-pillstat' }, [svg(icon), text]);
  }

  function goTo(node, href) {
    node.addEventListener('click', (e) => {
      if (e.target.closest('a, button, .rdr-spoiler')) return;
      if (window.getSelection && String(window.getSelection())) return;
      if (e.metaKey || e.ctrlKey) window.open(href, '_blank');
      else location.href = href;
    });
  }

  function mediaFor(p) {
    const prev = p.preview && p.preview.images && p.preview.images[0];
    let src = prev && prev.source && decodeEntities(prev.source.url);
    if (!src && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(p.url || '')) src = p.url;
    if (!src && p.is_gallery && p.media_metadata) {
      const first = Object.values(p.media_metadata)[0];
      src = first && first.s && decodeEntities(first.s.u || first.s.gif || '');
    }
    if (src && /^https:\/\//.test(src)) return el('img', { class: 'rhph-thumb', src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    return null;
  }

  function renderPost(p) {
    const href = p.permalink ? 'https://www.reddit.com' + p.permalink : `https://www.reddit.com/comments/${p.id}/`;
    const node = el('article', { class: 'rhph-item rhph-post', 'data-id': 't3_' + p.id });
    node.appendChild(el('div', { class: 'rhph-meta' }, [
      subIcon(p.subreddit), subLink(p.subreddit), el('span', null, '•'), timeEl(p.created_utc),
      p.over_18 ? el('span', { class: 'rhph-tag rhph-tag-nsfw' }, 'NSFW') : null,
      isRemovedBody(p.selftext) || p.removed_by_category ? el('span', { class: 'rhph-tag rhph-tag-removed' }, 'Removed') : null,
    ]));
    node.appendChild(el('a', { class: 'rhph-title', href, style: 'display:block' }, decodeEntities(p.title || '')));
    if (p.selftext && !isRemovedBody(p.selftext)) {
      const body = el('div', { class: 'rhph-body rhph-clamp' });
      body.appendChild(renderMarkdown(p.selftext));
      node.appendChild(body);
    } else if (!p.is_self) {
      const m = mediaFor(p);
      if (m) node.appendChild(m);
      else if (p.url && safeHref(p.url) && !/reddit\.com\/r\/.+\/comments\//.test(p.url)) {
        node.appendChild(el('a', { class: 'rhph-linkcard', href: safeHref(p.url), target: '_blank', rel: 'noopener noreferrer' },
          p.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)));
      }
    }
    node.appendChild(el('div', { class: 'rhph-actions' }, [
      stat('up', compactNumber(p.score)),
      stat('comment', compactNumber(p.num_comments)),
    ]));
    goTo(node, href);
    return node;
  }

  function renderComment(c, author) {
    const linkId = (c.link_id || '').replace(/^t3_/, '');
    const post = postCache.get(linkId);
    const href = c.permalink ? 'https://www.reddit.com' + c.permalink
      : `https://www.reddit.com/r/${c.subreddit}/comments/${linkId}/_/${c.id}/`;
    const node = el('article', { class: 'rhph-item rhph-comment', 'data-id': 't1_' + c.id });
    node.appendChild(el('div', { class: 'rhph-meta' }, [
      subIcon(c.subreddit), subLink(c.subreddit), el('span', null, '•'),
      el('a', { class: 'rhph-post-title', href: `https://www.reddit.com/comments/${linkId}/` },
        post && post.title ? decodeEntities(post.title) : 'View post'),
    ]));
    node.appendChild(el('div', { class: 'rhph-meta', style: 'min-height:20px' }, [
      el('a', { href: `/user/${author}/`, class: 'rhph-sub' }, author),
      el('span', null, 'commented'), timeEl(c.created_utc),
    ]));
    const body = el('div', { class: 'rhph-body' });
    if (isRemovedBody(c.body)) body.appendChild(el('em', null, c.body));
    else body.appendChild(renderMarkdown(c.body || ''));
    node.appendChild(body);
    node.appendChild(el('div', { class: 'rhph-actions' }, [stat('up', compactNumber(c.score))]));
    goTo(node, href);
    return node;
  }

  // ------------------------------------------------------------- the view

  function tabFromPath() {
    const p = location.pathname;
    if (/\/submitted\/?/.test(p)) return 'posts';
    if (/\/comments\/?/.test(p)) return 'comments';
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
      this.root = el('div', { id: ROOT_ID });
      this.build();
    }

    build() {
      const label = this.reason === 'partial'
        ? 'Some communities are hidden. Showing full history from '
        : 'History is hidden. Showing it from ';
      this.toggleNative = this.reason === 'partial'
        ? el('button', { class: 'rhph-btn rhph-plain', type: 'button' }, 'Show Reddit\'s view') : null;
      this.root.appendChild(el('div', { class: 'rhph-banner' }, [
        el('span', null, [label, el('b', null, 'Arctic Shift')]), this.toggleNative]));

      this.subBtn = el('button', { class: 'rhph-btn', type: 'button' }, 'All communities ▾');
      this.subBtn.addEventListener('click', () => this.openPicker());
      this.search = el('input', { class: 'rhph-search', type: 'search', placeholder: `Search u/${this.author}'s history` });
      let t;
      this.search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => this.setText(this.search.value), 500); });
      this.search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(t); this.setText(this.search.value); } });
      this.chips = el('div', { class: 'rhph-chips' });
      this.root.appendChild(el('div', { class: 'rhph-bar' }, [this.subBtn, this.search, this.chips]));
      this.list = el('div', { class: 'rhph-list' });
      this.status = el('div', { class: 'rhph-status' });
      this.sentinel = el('div', { style: 'height:1px' });
      this.root.append(this.list, this.status, this.sentinel);

      this.io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) this.loadMore(); }, { rootMargin: '800px' });
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
        const x = el('button', { type: 'button', title: 'Remove' }, '×');
        x.addEventListener('click', () => { this.subs = this.subs.filter((n) => n !== s); this.afterSubs(); });
        return el('span', { class: 'rhph-chip' }, ['r/' + s, x]);
      }));
      this.subBtn.textContent = (this.subs.length ? `${this.subs.length} selected` : 'All communities') + ' ▾';
      this.subBtn.classList.toggle('rhph-on', !!this.subs.length);
    }

    afterSubs() { this.renderChips(); this.reset(); }

    openPicker() {
      if (this.pop) { this.closePicker(); return; }
      this.pop = el('div', { class: 'rhph-pop' });
      this.popFilter = el('input', { class: 'rhph-search', type: 'search', placeholder: 'Find a community' });
      this.popFilter.addEventListener('input', () => this.fillPicker());
      this.popList = el('div', { class: 'rhph-list' });
      const clear = el('button', { class: 'rhph-btn rhph-plain', type: 'button' }, 'Clear');
      clear.addEventListener('click', () => { this.pending = new Set(); this.fillPicker(); });
      const apply = el('button', { class: 'rhph-btn', type: 'button' }, 'Apply');
      apply.addEventListener('click', () => { this.subs = [...this.pending]; this.closePicker(); this.afterSubs(); });
      this.pop.append(this.popFilter, this.popList, el('div', { class: 'rhph-pop-foot' }, [clear, apply]));
      this.pending = new Set(this.subs);
      const r = this.subBtn.getBoundingClientRect();
      this.pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
      this.pop.style.left = (r.left + window.scrollX) + 'px';
      document.body.appendChild(this.pop);
      this.fillPicker();
      this.popFilter.focus();
      this.outside = (e) => { if (!this.pop.contains(e.target) && e.target !== this.subBtn) this.closePicker(); };
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
      this.popList.replaceChildren(...rows.slice(0, 300).map((s) => {
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
      this.busy = false;
      this.loadMore();
    }

    async loadMore() {
      if (this.busy || this.feed.done) return;
      this.busy = true;
      const gen = this.gen;
      this.status.className = 'rhph-status';
      this.status.textContent = 'Loading…';
      try {
        const items = await this.feed.next(25);
        if (gen !== this.gen) return;
        await fetchPostsById(items.filter((i) => i.__kind === 'comments').map((c) => (c.link_id || '').replace(/^t3_/, '')));
        if (gen !== this.gen) return;
        for (const it of items) this.list.appendChild(it.__kind === 'posts' ? renderPost(it) : renderComment(it, this.author));
        if (this.feed.done) {
          this.status.textContent = this.list.children.length ? 'End of archived history.' : (this.text || this.subs.length ? 'No matches in the archive.' : 'Nothing archived for this user.');
        } else this.status.textContent = '';
      } catch (e) {
        if (gen !== this.gen) return;
        this.status.className = 'rhph-status rhph-err';
        this.status.replaceChildren(e.message + ' ', (() => {
          const b = el('button', { class: 'rhph-btn', type: 'button' }, 'Retry');
          b.addEventListener('click', () => this.loadMore());
          return b;
        })());
      } finally {
        if (gen === this.gen) {
          this.busy = false;
          // Keep filling while the sentinel is still on screen.
          const r = this.sentinel.getBoundingClientRect();
          if (!this.feed.done && r.top < window.innerHeight + 800 && this.status.className === 'rhph-status') setTimeout(() => this.loadMore(), 50);
        }
      }
    }

    destroy() {
      this.gen++;
      this.io.disconnect();
      this.closePicker();
      this.root.remove();
    }
  }

  // --------------------------------------------------- detecting & mounting

  function textIncludes(node, phrase) {
    return (node.textContent || '').toLowerCase().includes(phrase);
  }

  // The smallest element holding the "keeps their posts hidden" text.
  function findHiddenNotice() {
    const main = document.querySelector('main') || document.body;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.toLowerCase();
      if (HIDDEN_PHRASES.slice(0, 2).some((p) => t.includes(p))) return n.parentElement;
    }
    return null;
  }

  // Reddit loads the "Active in" modal only when clicked. If it is already on
  // the page (the user clicked), read it; otherwise fetch the same partial.
  const partialCache = new Map();
  function checkPartial(author) {
    const modal = document.querySelector('shreddit-active-subreddits-modal');
    if (modal && modal.shadowRoot && textIncludes(modal.shadowRoot, PARTIAL_PHRASE)) return Promise.resolve(true);
    const key = author.toLowerCase();
    if (!partialCache.has(key)) {
      const url = activeInPartialUrl(author);
      partialCache.set(key, !url ? Promise.resolve(false) : fetch(url, { credentials: 'include' })
        .then((r) => (r.ok ? r.text() : ''))
        .then((html) => html.toLowerCase().includes(PARTIAL_PHRASE))
        .catch(() => false));
    }
    return partialCache.get(key);
  }

  // The URL of the "Active in" modal partial. Filled in from the page dump.
  function activeInPartialUrl(author) {
    const loader = document.querySelector('[src*="active-subreddits"], [src*="active_subreddits"], [src*="activeSubreddits"]');
    if (loader) return loader.getAttribute('src');
    return null;
  }

  // Where the feed lives (the element we put ours in front of).
  function feedAnchor(notice) {
    if (notice) {
      let n = notice;
      const main = notice.closest('main') || document.querySelector('main');
      while (n.parentElement && n.parentElement !== main && n.parentElement.children.length === 1) n = n.parentElement;
      return n;
    }
    return document.querySelector('main shreddit-feed, main [id^="profile-feed"], main faceplate-batch, main shreddit-post')
      ? (document.querySelector('main shreddit-feed') || document.querySelector('main shreddit-post').parentElement)
      : null;
  }

  let view = null;
  let viewKey = '';
  let nativeHidden = [];

  function unmount() {
    if (view) view.destroy();
    view = null; viewKey = '';
    for (const n of nativeHidden) n.classList.remove('rhph-native-hidden');
    nativeHidden = [];
  }

  function mount(author, reason, anchor) {
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
    view = new View(author, reason);
    viewKey = author.toLowerCase();
    anchor.parentElement.insertBefore(view.root, anchor);
    anchor.classList.add('rhph-native-hidden');
    nativeHidden = [anchor];
    if (view.toggleNative) {
      view.toggleNative.addEventListener('click', () => {
        const showNative = anchor.classList.toggle('rhph-native-hidden') === false;
        view.list.style.display = view.status.style.display = showNative ? 'none' : '';
        view.toggleNative.textContent = showNative ? 'Show full history' : 'Show Reddit\'s view';
      });
    }
    log('mounted', author, reason);
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
    checking = true;
    try {
      const notice = findHiddenNotice();
      if (notice) { mount(author, 'hidden', feedAnchor(notice)); return; }
      if (await checkPartial(author)) {
        if (userFromPath() !== author || view) return;
        const anchor = feedAnchor(null);
        if (anchor) mount(author, 'partial', anchor);
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
      const text = ['url ' + location.href, 'view ' + (view ? view.reason : 'none'), ...debugLog].join('\n');
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text); else console.log(text);
    });
  }
})();
