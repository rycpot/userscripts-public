// ==UserScript==
// @name         Enter = New Line (Claude, ChatGPT, Gemini, DeepSeek)
// @namespace    local.enter-newline
// @version      1.2.1
// @description  Enter inserts a new line. Ctrl/Cmd+Enter sends. Runs only on Claude, ChatGPT, Gemini and DeepSeek.
// @match        https://claude.ai/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://gemini.google.com/*
// @match        https://chat.deepseek.com/*
// @run-at       document-start
// @grant        none
// @noframes
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3QgeD0iNCIgeT0iNCIgd2lkdGg9IjU2IiBoZWlnaHQ9IjU2IiByeD0iMTQiIGZpbGw9IiMyYjJkMzEiLz48cGF0aCBkPSJNNDQgMTh2MTZhNiA2IDAgMCAxLTYgNkgyMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjxwYXRoIGQ9Ik0yOSAzMWwtOSA5IDkgOSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjwvc3ZnPg==
// @downloadURL  https://raw.githubusercontent.com/rycpot/userscripts-public/main/enter-new-line-ai-chats.user.js
// @updateURL    https://raw.githubusercontent.com/rycpot/userscripts-public/main/enter-new-line-ai-chats.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Hard site lock (Claude, ChatGPT, Gemini, DeepSeek), even if the @match lines above are edited later.
  if (!/^(claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com|chat\.deepseek\.com)$/.test(location.hostname)) return;

  const TAG = '[Enter=NewLine]';
  // Message boxes only (composer + edit boxes). Never <input> fields like search/rename.
  const EDITABLE =
    'textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
  const MOD_PROPS = ['shiftKey', 'ctrlKey', 'metaKey', 'altKey'];
  const MODIFIER_NAMES = new Map([['Shift', 'shiftKey'], ['Control', 'ctrlKey'], ['Meta', 'metaKey']]);

  const KP = KeyboardEvent.prototype;
  const nativeGetModifierState = KP.getModifierState;
  const nativeGetters = {};
  for (const p of MOD_PROPS) {
    const d = Object.getOwnPropertyDescriptor(KP, p);
    nativeGetters[p] = d && d.get ? d.get : null;
  }
  // Real modifier state, read through the browser's own getters.
  const real = (e, p) => (nativeGetters[p] ? nativeGetters[p].call(e) : e[p]);

  // ---------------------------------------------------------------------------
  // The decision: what should the SITE see for this key event?
  //   Enter            -> looks like Shift+Enter (new line)
  //   Ctrl/Cmd+Enter  -> looks like plain Enter (the site's own send path)
  // Decided once per event and cached, so every reader gets the same answer.
  // ---------------------------------------------------------------------------
  const decisions = new WeakMap();

  function decide(e) {
    if (!e || typeof e !== 'object') return null;
    if (decisions.has(e)) return decisions.get(e);
    let result = null;
    try {
      if (e.key === 'Enter' && e.isTrusted && !e.isComposing && e.keyCode !== 229 && !real(e, 'altKey')) {
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        const target = path[0] || e.target;
        const editable = target && typeof target.closest === 'function' ? target.closest(EDITABLE) : null;
        if (editable) {
          const shift = real(e, 'shiftKey'), ctrl = real(e, 'ctrlKey'), meta = real(e, 'metaKey');
          if (!ctrl && !meta && !shift) {
            result = { kind: 'newline', editable, mods: { shiftKey: true } };
          } else if ((ctrl || meta) && !shift) {
            result = { kind: 'send', editable, mods: { shiftKey: false, ctrlKey: false, metaKey: false } };
          }
        }
      }
    } catch (_) { result = null; }              // fail open: never interfere if unsure
    decisions.set(e, result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Failsafe 1: patch the KeyboardEvent *prototype*, so the spoof applies no
  // matter which listener reads the modifiers first (site code that got in
  // ahead of this script, React synthetic events, etc.).
  // ---------------------------------------------------------------------------
  try {
    for (const p of MOD_PROPS) {
      const d = Object.getOwnPropertyDescriptor(KP, p);
      if (!d || !d.get || !d.configurable) continue;
      Object.defineProperty(KP, p, {
        ...d,
        get: function () {
          try { const r = decide(this); if (r && p in r.mods) return r.mods[p]; } catch (_) {}
          return d.get.call(this);
        },
      });
    }
    if (typeof nativeGetModifierState === 'function') {
      Object.defineProperty(KP, 'getModifierState', {
        configurable: true, writable: true, enumerable: true,
        value: function getModifierState(name) {
          try {
            const r = decide(this), p = MODIFIER_NAMES.get(name);
            if (r && p && p in r.mods) return r.mods[p];
          } catch (_) {}
          return nativeGetModifierState.apply(this, arguments);
        },
      });
    }
  } catch (err) { console.warn(TAG, 'prototype patch skipped, using per-event layer only:', err); }

  // Failsafe 2: per-event override, applied from a window-capture listener.
  // Independent of layer 1, so if the prototype patch is ever blocked this still works.
  function applyToEvent(e, mods) {
    for (const p of Object.keys(mods)) {
      const v = mods[p];
      Object.defineProperty(e, p, { get: () => v, configurable: true });
    }
    Object.defineProperty(e, 'getModifierState', {
      configurable: true,
      value: (name) => {
        const p = MODIFIER_NAMES.get(name);
        return p && p in mods ? mods[p] : nativeGetModifierState.call(e, name);
      },
    });
  }

  // Failsafe 3: sites that react to beforeinput (insertParagraph vs insertLineBreak)
  // instead of keydown still see a line break, but only right after our spoofed Enter.
  let lastNewlineAt = -Infinity;
  try {
    const d = typeof InputEvent !== 'undefined' && Object.getOwnPropertyDescriptor(InputEvent.prototype, 'inputType');
    if (d && d.get && d.configurable) {
      Object.defineProperty(InputEvent.prototype, 'inputType', {
        ...d,
        get: function () {
          const v = d.get.call(this);
          if (v === 'insertParagraph' && this.isTrusted && performance.now() - lastNewlineAt < 150) return 'insertLineBreak';
          return v;
        },
      });
    }
  } catch (_) {}

  // Failsafe 4 (tripwire): if a plain Enter in a non-empty box ends up EMPTYING it,
  // the site sent the message, meaning a site update has defeated the spoof.
  // We can't undo that, but you'll know immediately instead of finding out later.
  const textOf = (el) => (typeof el.value === 'string' ? el.value : el.textContent) || '';
  let warned = false;

  function notify(msg) {
    console.warn(TAG, msg);
    if (warned || !document.body) return;
    warned = true;                                  // toast once per page load
    const box = document.createElement('div');
    box.textContent = TAG + ' ' + msg;
    box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:320px;' +
      'padding:10px 14px;border-radius:8px;background:#b3261e;color:#fff;' +
      'font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 8000);
  }

  function watchForUnexpectedSend(el) {
    if (!textOf(el).trim()) return;
    setTimeout(() => {
      const active = document.activeElement;
      const cur = el.isConnected ? el : (active && active.closest ? active.closest(EDITABLE) : null);
      if (!cur || !textOf(cur).trim()) {
        notify('Enter appears to have SENT your message instead of adding a new line. ' +
               'The site may have changed; this script may need an update.');
      }
    }, 300);
  }

  // ---------------------------------------------------------------------------
  // Listener: window + capture = first in the event path.
  // Any error here is swallowed, so a bug can never block typing.
  // ---------------------------------------------------------------------------
  function onKey(e) {
    try {
      const r = decide(e);
      if (!r) return;
      applyToEvent(e, r.mods);
      if (e.type === 'keydown' && r.kind === 'newline') {
        lastNewlineAt = performance.now();
        if (!e.repeat) watchForUnexpectedSend(r.editable);
      }
    } catch (err) { console.warn(TAG, err); }
  }

  for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, onKey, true);
})();