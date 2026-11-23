// ==UserScript==
// @name         Reddit Restore Deleted Posts & Comments
// @namespace    https://github.com/rycpot/userscripts-public
// @version      1.2.0
// @description  On new Reddit (www.reddit.com), fills deleted or removed posts and comments back into their original spots using the Arctic Shift archive. Also restores comments that load later ("more replies", "continue thread").
// @author       you
// @icon         https://www.reddit.com/favicon.ico
// @match        https://www.reddit.com/*
// @match        https://sh.reddit.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      arctic-shift.photon-reddit.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/rycpot/userscripts-public/main/reddit-restore-deleted.user.js
// @updateURL    https://raw.githubusercontent.com/rycpot/userscripts-public/main/reddit-restore-deleted.user.js
// ==/UserScript==

/*
 * Why the old "Reddit Uncensored" extension stopped restoring comments:
 *  1. It asked Arctic Shift for `fields=author,body` (no `id`) and then matched
 *     the answers to comments by array position. The API only returns the
 *     comments it has, in its own order, so as soon as one comment is missing
 *     from the archive every later comment gets the wrong text or none at all.
 *     Here every request includes `id` and results are matched by id.
 *  2. On new Reddit it looked for the deleted text with one fixed selector
 *     (`div[slot="commentMeta"] + div > div.inline-block > p`). When Reddit's
 *     markup moved, it found nothing and silently gave up. Here the comment
 *     body is located several ways, and if nothing is found the restored text
 *     is still added to the comment.
 *  3. It never re-scanned comments loaded later ("more replies"). Here a
 *     MutationObserver picks up every <shreddit-comment> as it appears.
 *
 * Restored text is rendered from Reddit markdown with DOM calls only
 * (no innerHTML), so it cannot run scripts and is not blocked by Reddit's
 * Trusted Types policy.
 */

(function () {
  'use strict';

  if (window.top !== window.self) return;

  const API = 'https://arctic-shift.photon-reddit.com/api';
  const BATCH_SIZE = 100;          // API allows 500; keep URLs short
  const BATCH_DELAY_MS = 250;      // collect comments for a moment before asking
  const ACCENT = '#e85646';
  const MARK = 'data-rdr';         // set on every node this script has looked at

  const DELETED_WORDS = [
    '[deleted]', '[removed]', '[deleted by user]',
    'comment deleted by user', 'comment removed by moderator',
    'comment removed by reddit', 'comment removed', 'comment deleted',
    'comment has been removed', 'deleted by user', 'removed by moderator',
    'removed by reddit', 'post removed by moderator', 'post deleted by user',
    'post removed by reddit', 'sorry, this post was deleted by the person who originally posted it.',
    'sorry, this post has been removed by the moderators of',
    'removed by reddit on account of violating the content policy',
  ];

  function isDeletedText(text) {
    const t = (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t) return false;
    if (t.length > 200) return false;
    return DELETED_WORDS.some((w) => t === w || t.startsWith(w) || (t.length < 90 && t.includes(w)));
  }

  function isDeletedName(name) {
    const n = (name || '').trim().toLowerCase();
    return n === '[deleted]' || n === '[removed]' || n === 'deleted' || n === '';
  }

  // ---------------------------------------------------------------- styles

  const style = document.createElement('style');
  style.textContent = `
    .rdr-box { border-left: 3px solid ${ACCENT}; background: rgba(232,86,70,.07);
      padding: 6px 10px; margin: 6px 0 8px; border-radius: 4px; display: block;
      flex-basis: 100%; width: auto; max-width: 100%; box-sizing: border-box;
      font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; color: inherit; }
    .rdr-label { font-size: 11px; font-weight: 600; color: ${ACCENT}; margin-bottom: 4px;
      text-transform: uppercase; letter-spacing: .03em; }
    .rdr-label a { color: inherit; text-decoration: underline; font-weight: 400; }
    .rdr-box p { margin: 0 0 .6em; }
    .rdr-box p:last-child { margin-bottom: 0; }
    .rdr-box a { color: #4a9eff; text-decoration: underline; }
    .rdr-box blockquote { border-left: 3px solid #888; margin: .4em 0; padding: 0 0 0 10px; opacity: .85; }
    .rdr-box pre { background: rgba(127,127,127,.15); padding: 6px 8px; border-radius: 4px;
      overflow-x: auto; white-space: pre; font-size: 13px; }
    .rdr-box code { background: rgba(127,127,127,.15); padding: 0 3px; border-radius: 3px; font-size: 13px; }
    .rdr-box pre code { background: none; padding: 0; }
    .rdr-box ul, .rdr-box ol { margin: .3em 0 .6em 1.4em; padding: 0; }
    .rdr-box ul { list-style: disc; } .rdr-box ol { list-style: decimal; }
    .rdr-box h1, .rdr-box h2, .rdr-box h3, .rdr-box h4, .rdr-box h5, .rdr-box h6 {
      font-weight: 700; margin: .5em 0 .3em; font-size: 1.05em; }
    .rdr-box hr { border: 0; border-top: 1px solid rgba(127,127,127,.4); margin: .6em 0; }
    .rdr-box .rdr-spoiler { background: currentColor; border-radius: 3px; cursor: pointer; }
    .rdr-box .rdr-spoiler.rdr-open { background: rgba(127,127,127,.25); }
    .rdr-box table { border-collapse: collapse; margin: .4em 0; }
    .rdr-box th, .rdr-box td { border: 1px solid rgba(127,127,127,.4); padding: 2px 6px; }
    .rdr-missing { font-style: italic; opacity: .75; }
    .rdr-author { color: ${ACCENT} !important; font-weight: 600; text-decoration: none; }
    .rdr-author:hover { text-decoration: underline; }
    .rdr-title { color: ${ACCENT}; }
    .rdr-hidden-original { display: none !important; }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ------------------------------------------------------------- API layer

  const cache = new Map(); // fullname-less id -> item | null (null = not archived)

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 30000,
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

  async function apiIds(kind, ids, fields) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const url = `${API}/${kind}/ids?ids=${ids.join(',')}` + (fields ? `&fields=${fields}` : '');
      let r;
      try {
        r = await gmGet(url);
      } catch (e) {
        log('request failed', e && e.message);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (r.status === 429) {
        const reset = parseFloat(headerValue(r.responseHeaders, 'x-ratelimit-reset')) || 5;
        await sleep(Math.min(60, reset) * 1000 + 250);
        continue;
      }
      if (r.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
      if (r.status === 400 && fields) {
        // A field name the API no longer accepts; ask for whole objects instead.
        log('API rejected fields', fields, r.responseText && r.responseText.slice(0, 200));
        fields = null;
        continue;
      }
      if (r.status !== 200) {
        log('API error', r.status, url, r.responseText && r.responseText.slice(0, 200));
        throw new Error(`Arctic Shift ${r.status}`);
      }
      const json = JSON.parse(r.responseText);
      return Array.isArray(json && json.data) ? json.data : [];
    }
    throw new Error('Arctic Shift unavailable');
  }

  function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

  const debugLog = [];
  function log(...args) {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    debugLog.push(new Date().toISOString().slice(11, 19) + ' ' + line);
    if (debugLog.length > 60) debugLog.shift();
    console.debug('[Restore Deleted]', ...args);
  }

  // Comment fetching: queued and batched; each waiter gets its own result.
  const commentWaiters = new Map(); // id -> [resolve]
  let commentTimer = 0;

  function fetchComment(id) {
    if (cache.has(id)) return Promise.resolve(cache.get(id));
    return new Promise((resolve) => {
      if (!commentWaiters.has(id)) commentWaiters.set(id, []);
      commentWaiters.get(id).push(resolve);
      clearTimeout(commentTimer);
      commentTimer = setTimeout(flushComments, BATCH_DELAY_MS);
    });
  }

  async function flushComments() {
    const ids = [...commentWaiters.keys()];
    const waiters = new Map(commentWaiters);
    commentWaiters.clear();
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      let items = [];
      let failed = false;
      try {
        items = await apiIds('comments', chunk, 'id,author,body,created_utc');
      } catch (e) {
        console.warn('[Restore Deleted] comment fetch failed:', e);
        failed = true;
      }
      const byId = new Map(items.map((it) => [String(it.id).replace(/^t1_/, ''), it]));
      for (const id of chunk) {
        const item = byId.get(id) || null;
        if (!failed) cache.set(id, item);
        (waiters.get(id) || []).forEach((res) => res(failed ? undefined : item));
      }
    }
  }

  async function fetchPost(id) {
    if (cache.has('p_' + id)) return cache.get('p_' + id);
    const items = await apiIds('posts', [id], null);
    const item = items.find((it) => String(it.id).replace(/^t3_/, '') === id) || null;
    cache.set('p_' + id, item);
    return item;
  }

  // ------------------------------------------------- Reddit markdown → DOM

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#x200B;/gi, '​').replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (children) for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }

  function safeHref(url) {
    let u = (url || '').trim();
    if (/^\/?(r|u|user)\//i.test(u)) u = 'https://www.reddit.com/' + u.replace(/^\//, '');
    else if (u.startsWith('/')) u = 'https://www.reddit.com' + u;
    else if (/^www\./i.test(u)) u = 'https://' + u;
    return /^(https?:|mailto:)/i.test(u) ? u : null;
  }

  // `plain` = the text is the URL itself, so don't parse it for markdown again.
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

  // ----------------------------------------------------------- UI helpers

  function permalinkFor(kind, id) {
    return `${API}/${kind}/ids?ids=${id}`;
  }

  function buildBox(labelText, body, archiveUrl, when) {
    const label = el('div', { class: 'rdr-label' }, labelText);
    if (when) label.appendChild(document.createTextNode(' · ' + when));
    if (archiveUrl) {
      label.appendChild(document.createTextNode(' · '));
      label.appendChild(el('a', { href: archiveUrl, target: '_blank', rel: 'noopener noreferrer' }, 'source'));
    }
    const box = el('div', { class: 'rdr-box md' }, label);
    if (body) box.appendChild(body);
    // Keep clicks on restored links from toggling/collapsing the comment.
    box.addEventListener('click', (e) => e.stopPropagation());
    return box;
  }

  function missingNote(text) {
    return el('p', { class: 'rdr-missing' }, text);
  }

  function formatDate(utc) {
    if (!utc) return '';
    try {
      return new Date(utc * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  function bodyIsUseful(text) {
    const t = (text || '').trim();
    return !!t && !isDeletedText(t) && t !== '[ Removed by Reddit ]';
  }

  function authorLink(name) {
    return el('a', {
      class: 'rdr-author',
      href: `https://www.reddit.com/user/${encodeURIComponent(name)}/`,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'Restored from Arctic Shift',
    }, 'u/' + name);
  }

  // If an element ended up unslotted (not rendered), it has no boxes.
  function isRendered(node) {
    return node.isConnected && node.getClientRects().length > 0;
  }

  function afterLayout(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  }

  // Replace a "[deleted]" author label inside `scope` with the real name.
  // `owner` is the <shreddit-comment> being restored, or null for the post.
  function restoreAuthorIn(scopes, name, owner) {
    if (!name || isDeletedName(name)) return false;
    for (const scope of scopes) {
      if (!scope) continue;
      const candidates = scope.querySelectorAll('a, span, faceplate-tracker, faceplate-hovercard, div, p');
      for (const c of candidates) {
        if (c.closest('.rdr-box, [slot="comment"], [slot="text-body"]')) continue;
        if (c.closest('shreddit-comment') !== owner) continue;
        if (c.children.length > 2) continue;
        const t = (c.textContent || '').trim();
        if (t === '[deleted]' || t === 'u/[deleted]' || t === '[removed]' || t === 'Deleted' || t === 'deleted') {
          c.replaceWith(authorLink(name));
          return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------ comments

  function directChild(node, selector) {
    for (const c of node.children) if (c.matches(selector)) return c;
    return null;
  }

  // Elements that belong to this comment, not to a nested reply.
  function own(comment, selector) {
    return [...comment.querySelectorAll(selector)].filter((n) => n.closest('shreddit-comment') === comment);
  }

  // Reddit (late 2026) renders comments without shadow DOM: a light-DOM
  // <details> holds the header and the text. Older builds slotted a
  // [slot="comment"] element into a shadow root. Handle both.
  function commentBodyNode(comment) {
    return own(comment, '[slot="comment"], [id$="-comment-rtjson-content"]')[0] || null;
  }

  const HEADER_SEL = 'summary, [slot="commentMeta"], faceplate-tracker, faceplate-hovercard, a, time, .rdr-box';

  // Deepest light-DOM elements of this comment whose text is a deleted message
  // ("Comment deleted by user", "[removed]", ...), excluding the author label.
  function lightDeletedNodes(comment) {
    const hits = own(comment, 'p, div, span').filter((n) => {
      if (n.closest(HEADER_SEL)) return false;
      const t = (n.textContent || '').trim();
      // A bare "[deleted]" is the author label, not the comment text.
      if (!isDeletedText(t) || /^\[deleted\]/i.test(t)) return false;
      return ![...n.children].some((k) => isDeletedText(k.textContent));
    });
    return hits;
  }

  function attrOn(node, name) {
    const v = node.getAttribute(name);
    return v !== null && v !== 'false';
  }

  // Text of the comment's shadow DOM, minus slotted content.
  function shadowText(comment) {
    return comment.shadowRoot ? comment.shadowRoot.textContent || '' : '';
  }

  function commentState(comment) {
    const authorAttr = comment.getAttribute('author');
    const authorGone = attrOn(comment, 'is-author-deleted')
      || (authorAttr !== null && isDeletedName(authorAttr));
    // These are boolean attributes: present (often with an empty value) = true.
    const flagged = attrOn(comment, 'deleted')
      || attrOn(comment, 'is-comment-deleted')
      || attrOn(comment, 'is-comment-removed')
      || attrOn(comment, 'removed');
    const body = commentBodyNode(comment);
    const bodyText = body ? body.textContent : '';
    const shadowSaysDeleted = /comment (deleted|removed)|\[(deleted|removed)\]/i.test(shadowText(comment));
    const bodyGone = flagged || isDeletedText(bodyText) || lightDeletedNodes(comment).length > 0
      || (!body && (authorGone || shadowSaysDeleted))
      || (!!body && !bodyText.trim() && authorGone);
    return { authorGone, bodyGone, body };
  }

  function expandComment(comment) {
    if (comment.hasAttribute('collapsed')) comment.removeAttribute('collapsed');
    const details = directChild(comment, 'details')
      || (comment.shadowRoot && comment.shadowRoot.querySelector('details'));
    if (details && !details.open) details.open = true;
  }

  async function processComment(comment) {
    if (comment.hasAttribute(MARK)) return;
    const thing = comment.getAttribute('thingid') || '';
    const id = thing.replace(/^t1_/, '');
    if (!/^[a-z0-9]{1,24}$/i.test(id)) return; // new ids are 13+ chars
    comment.setAttribute(MARK, 'checked');

    const state = commentState(comment);
    if (!state.bodyGone && !state.authorGone) return;
    comment.setAttribute(MARK, 'loading');

    let loading = null;
    if (state.bodyGone) {
      loading = buildBox('Restoring from archive…', null);
      placeCommentBox(comment, state.body, loading, false);
      expandComment(comment);
    }

    const item = await fetchComment(id);
    if (loading) { loading._rdrDead = true; loading.remove(); }
    if (!comment.isConnected) { comment.removeAttribute(MARK); return; }

    if (item === undefined) {
      comment.setAttribute(MARK, 'error');
      if (state.bodyGone) {
        const box = buildBox('Archive', missingNote('Arctic Shift did not respond. Reload the page to try again.'));
        placeCommentBox(comment, state.body, box, false);
      }
      return;
    }

    comment.setAttribute(MARK, 'done');
    if (state.authorGone && item && item.author) {
      restoreAuthorIn([directChild(comment, '[slot="commentMeta"]'), comment], item.author, comment);
    }
    if (!state.bodyGone) return;

    let body;
    let label = 'Restored comment';
    if (!item) {
      body = missingNote('Not found in the Arctic Shift archive.');
      label = 'Archive';
    } else if (!bodyIsUseful(item.body)) {
      body = missingNote('The archive only captured this comment after it was deleted.');
      label = 'Archive';
    } else {
      body = renderMarkdown(item.body);
      if (item.author && !isDeletedName(item.author)) {
        label = 'Restored comment by u/' + item.author;
      }
    }
    const box = buildBox(label, body, permalinkFor('comments', id), item && formatDate(item.created_utc));
    placeCommentBox(comment, state.body, box, !!(item && bodyIsUseful(item.body)));
  }

  // Is the box actually on screen at a usable size? (A box dropped into a
  // small clipped container, like the avatar column, has boxes but is useless.)
  function usable(box) {
    if (!box.isConnected) return false;
    const r = box.getBoundingClientRect();
    return r.width >= 120 && r.height >= 12;
  }

  function ensureShadowStyle(root) {
    if (root.querySelector('style[data-rdr-style]')) return;
    const st = document.createElement('style');
    st.setAttribute('data-rdr-style', '');
    st.textContent = style.textContent;
    root.appendChild(st);
  }

  // Leaf elements inside the shadow DOM whose text is a "deleted" message.
  function shadowDeletedNodes(comment) {
    const root = comment.shadowRoot;
    if (!root) return [];
    return [...root.querySelectorAll('*')].filter((n) =>
      !n.closest('.rdr-box') && n.children.length === 0 && isDeletedText(n.textContent));
  }

  // Try each spot in turn until the box is visibly rendered.
  function placeCommentBox(comment, bodyNode, box, hideOriginal) {
    own(comment, '.rdr-box').forEach((b) => { if (b !== box) b.remove(); });
    if (comment.shadowRoot) comment.shadowRoot.querySelectorAll('.rdr-box').forEach((b) => { if (b !== box) b.remove(); });
    if (comment.nextElementSibling && comment.nextElementSibling.classList.contains('rdr-box') && comment.nextElementSibling !== box) {
      comment.nextElementSibling.remove();
    }

    const meta = () => directChild(comment, '[slot="commentMeta"]');
    const spots = [];
    if (bodyNode) spots.push(['light-body', () => bodyNode.isConnected && (bodyNode.appendChild(box), true)]);
    spots.push(['light-deleted', () => {
      const n = lightDeletedNodes(comment)[0];
      if (!n) return false;
      n.after(box);
      return true;
    }]);
    spots.push(['light-slot', () => {
      box.setAttribute('slot', 'comment');
      const m = meta();
      if (m) m.after(box); else comment.prepend(box);
      return true;
    }]);
    if (comment.shadowRoot) {
      spots.push(['shadow-deleted', () => {
        const n = shadowDeletedNodes(comment)[0];
        if (!n) return false;
        ensureShadowStyle(comment.shadowRoot);
        n.after(box);
        return true;
      }]);
      spots.push(['shadow-slot', () => {
        const root = comment.shadowRoot;
        const slot = root.querySelector('slot[name="comment"]') || root.querySelector('slot[name="commentMeta"]');
        if (!slot) return false;
        ensureShadowStyle(root);
        // Put it after the slot's block-level container so it gets its own line.
        let anchor = slot;
        while (anchor.parentElement && getComputedStyle(anchor.parentElement).display.includes('flex') && anchor.parentElement !== root.host) {
          anchor = anchor.parentElement;
        }
        anchor.after(box);
        return true;
      }]);
    }
    spots.push(['after-comment', () => {
      box.style.marginLeft = '40px';
      comment.after(box);
      return true;
    }]);

    let i = 0;
    const tryNext = () => {
      while (i < spots.length && !box._rdrDead) {
        const [name, put] = spots[i++];
        box.removeAttribute('slot');
        box.remove();
        if (!put()) continue;
        afterLayout(() => {
          if (box._rdrDead) return;
          if (usable(box)) {
            comment.setAttribute('data-rdr-spot', name);
            if (hideOriginal) hideDeletedMessage(comment, bodyNode, box);
            return;
          }
          if (i < spots.length) tryNext();
        });
        return;
      }
    };
    tryNext();
  }

  function hideDeletedMessage(comment, bodyNode, box) {
    if (bodyNode && bodyNode.isConnected) {
      for (const c of bodyNode.children) if (c !== box && !c.classList.contains('rdr-box')) c.classList.add('rdr-hidden-original');
    }
    shadowDeletedNodes(comment).forEach((n) => { n.style.display = 'none'; });
    lightDeletedNodes(comment).forEach((n) => n.classList.add('rdr-hidden-original'));
  }

  // ---------------------------------------------------------------- posts

  function currentPostId() {
    const m = location.pathname.match(/\/comments\/([a-z0-9]+)/i);
    return m ? m[1] : null;
  }

  function postState(post) {
    const authorAttr = post.getAttribute('author');
    const authorGone = authorAttr !== null && isDeletedName(authorAttr);
    const titleAttr = post.getAttribute('post-title');
    const titleGone = titleAttr !== null && isDeletedText(titleAttr);
    const banner = post.querySelector('[slot="post-removed-banner"]');
    const textBody = post.querySelector('[slot="text-body"]');
    const media = post.querySelector('[slot="post-media-container"], shreddit-player, shreddit-player-2, gallery-carousel, [slot="thumbnail"]');
    const removedAttr = post.hasAttribute('removed') || post.hasAttribute('deleted')
      || post.getAttribute('is-removed') === 'true' || post.getAttribute('is-deleted') === 'true';
    const textGone = !!(textBody && isDeletedText(textBody.textContent));
    const bodyGone = !!banner || removedAttr || textGone || (!textBody && !media);
    return { authorGone, titleGone, bodyGone, banner, textBody };
  }

  async function processPost(post) {
    const pid = currentPostId();
    const id = (post.getAttribute('id') || '').replace(/^t3_/, '') || pid;
    if (!id || id !== pid) return; // only the thread's own post, not feed cards
    if (post.getAttribute(MARK) === id) return;
    post.setAttribute(MARK, id);

    const state = postState(post);
    if (!state.bodyGone && !state.authorGone && !state.titleGone) return;

    let item;
    try {
      item = await fetchPost(id);
    } catch (e) {
      console.warn('[Restore Deleted] post fetch failed:', e);
      if (state.bodyGone) placePostBox(post, state, buildBox('Archive', missingNote('Arctic Shift did not respond. Reload the page to try again.')));
      post.removeAttribute(MARK);
      return;
    }
    if (!post.isConnected) return;

    if (!item) {
      if (state.bodyGone) placePostBox(post, state, buildBox('Archive', missingNote('This post is not in the Arctic Shift archive.')));
      return;
    }

    if (state.authorGone && item.author) {
      restoreAuthorIn([post.querySelector('[slot="credit-bar"]'), post], item.author, null);
    }

    if (state.titleGone && item.title && !isDeletedText(item.title)) {
      const h = post.querySelector('[slot="title"]');
      if (h) {
        h.textContent = decodeEntities(item.title);
        h.classList.add('rdr-title');
      }
    }

    if (!state.bodyGone) return;
    const body = document.createDocumentFragment();
    let useful = false;
    if (bodyIsUseful(item.selftext)) {
      body.appendChild(renderMarkdown(item.selftext));
      useful = true;
    }
    const url = item.url ? decodeEntities(item.url) : '';
    if (url && !item.is_self && !/reddit\.com\/r\/[^/]+\/comments\//i.test(url)) {
      const p = el('p', null, ['Link: ', link(url, url, true)]);
      body.appendChild(p);
      if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url) || /^https?:\/\/i\.redd\.it\//i.test(url)) {
        const img = el('img', { src: url, alt: '', referrerpolicy: 'no-referrer' });
        img.style.cssText = 'max-width:100%;max-height:600px;display:block;margin-top:6px;border-radius:4px';
        body.appendChild(img);
      }
      useful = true;
    }
    if (!useful) body.appendChild(missingNote('The archive only captured this post after it was deleted, or it had no text.'));
    const by = item.author && !isDeletedName(item.author) ? ' by u/' + item.author : '';
    placePostBox(post, state, buildBox('Restored post' + by, body, permalinkFor('posts', id), formatDate(item.created_utc)));
  }

  function placePostBox(post, state, box) {
    document.querySelectorAll('.rdr-post-box').forEach((b) => b.remove());
    box.classList.add('rdr-post-box');
    box.style.margin = '8px 0 12px';
    if (state.banner) {
      box.setAttribute('slot', state.banner.getAttribute('slot'));
      state.banner.after(box);
    } else if (state.textBody) {
      box.setAttribute('slot', 'text-body');
      state.textBody.after(box);
    } else {
      box.setAttribute('slot', 'text-body');
      post.appendChild(box);
    }
    afterLayout(() => {
      if (box.isConnected && !isRendered(box)) {
        box.removeAttribute('slot');
        post.after(box);
      }
    });
  }

  // ------------------------------------------------------------- scanning

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; scan(); }, 120);
  }

  function scan() {
    if (!currentPostId()) return;
    const pid = currentPostId();
    document.querySelectorAll('shreddit-post').forEach((p) => {
      if (p.getAttribute(MARK) !== pid) processPost(p);
    });
    document.querySelectorAll(`shreddit-comment[thingid]:not([${MARK}])`).forEach((c) => processComment(c));
  }

  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList' && m.addedNodes.length) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && !(n.classList && n.classList.contains('rdr-box'))) { queueScan(); return; }
        }
      } else if (m.type === 'attributes') { queueScan(); return; }
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['thingid', 'deleted', 'is-comment-deleted', 'is-author-deleted', 'post-title', 'author'],
  });

  // Reddit is a single-page app; re-scan on navigation too.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; queueScan(); }
  }, 500);

  // Tampermonkey menu: copy what this script saw, to help fix layout changes.
  function debugReport() {
    const out = ['Restore Deleted ' + (typeof GM_info !== 'undefined' ? GM_info.script.version : ''), location.href, ''];
    const comments = [...document.querySelectorAll('shreddit-comment')];
    out.push(`shreddit-comment: ${comments.length}, shreddit-post: ${document.querySelectorAll('shreddit-post').length}`);
    const interesting = comments.filter((c) => c.getAttribute(MARK) !== 'checked').slice(0, 3);
    if (!interesting.length && comments[0]) interesting.push(comments[0]);
    for (const c of interesting) {
      out.push('', '--- comment attrs: ' + [...c.attributes].map((a) => `${a.name}="${a.value.slice(0, 60)}"`).join(' '));
      out.push('light children: ' + [...c.children].map((k) => `<${k.tagName.toLowerCase()} slot=${k.getAttribute('slot')}> "${(k.textContent || '').trim().slice(0, 50)}"`).join(' | '));
      if (c.shadowRoot) out.push('shadow: ' + c.shadowRoot.innerHTML.replace(/<style[\s\S]*?<\/style>/g, '').replace(/\s+/g, ' ').slice(0, 2500));
      else out.push('shadow: none');
    }
    const p = document.querySelector('shreddit-post');
    if (p) out.push('', '--- post attrs: ' + [...p.attributes].map((a) => `${a.name}="${a.value.slice(0, 60)}"`).join(' '));
    out.push('', '--- log', ...debugLog);
    return out.join('\n');
  }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Copy debug info', () => {
      const text = debugReport();
      try { GM_setClipboard(text, 'text'); } catch (e) { console.log(text); }
      console.log('[Restore Deleted] debug info copied to clipboard:\n' + text);
    });
  }

  scan();
})();
