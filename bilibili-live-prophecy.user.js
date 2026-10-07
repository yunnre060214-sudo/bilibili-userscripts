// ==UserScript==
// @name         B站直播预言
// @namespace    https://space.bilibili.com/1937432404
// @version      0.2.1
// @description  在直播网页打开官方硬币预言面板，自动识别主播，查看当前预言和参与历史。
// @author       素晴
// @homepageURL  https://github.com/yunnre060214-sudo/bilibili-userscripts
// @supportURL   https://github.com/yunnre060214-sudo/bilibili-userscripts/issues
// @updateURL    https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-live-prophecy.user.js
// @downloadURL  https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-live-prophecy.user.js
// @match        https://live.bilibili.com/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.2.1';

  // The official H5 can read account data on desktop, but showConfirm/showToast
  // invoke an App bridge without a WEB/PC_ROOM fallback. Adapt only the UI SDK;
  // the official account, eligibility checks, requests and participation remain.
  if (location.pathname === '/p/html/live-app-guessing-game/index.html') {
    if (!/BiliApp|biliLink|Android|iPhone|iPad/i.test(navigator.userAgent)) {
      adaptOfficialDesktop(typeof unsafeWindow === 'undefined' ? window : unsafeWindow);
    }
    return;
  }
  if (location.pathname.startsWith('/p/')) return;
  if (window.top !== window.self || document.getElementById('bili-prophecy-root')) return;

  const OFFICIAL = 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html';
  const ROOT_ID = 'bili-prophecy-root';
  let state = null;
  let ui = null;
  let poll = null;

  function positiveId(value) {
    const text = String(value ?? '');
    return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
  }

  function icon(name, size = 20) {
    const paths = {
      spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/><path d="M19 2v4m-2-2h4"/>',
      history: '<path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7"/><path d="M12 7v5l3 2"/>',
      close: '<path d="m6 6 12 12M6 18 18 6"/>',
      room: '<rect x="3" y="5" width="18" height="14" rx="4"/><path d="m10 9 5 3-5 3Z"/>',
      refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
      external: '<path d="M14 3h7v7m0-7L11 13"/><path d="M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
      signal: '<path d="M5 9a11 11 0 0 1 14 0M8 12a6 6 0 0 1 8 0m-5 3a2 2 0 0 1 2 0"/><circle cx="12" cy="19" r="1"/>',
    };
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.spark}</svg>`;
  }

  function adaptOfficialDesktop(page) {
    if (/BiliApp|biliLink|Android|iPhone|iPad/i.test(page.navigator.userAgent)) return null;
    const marker = '__biliProphecyDesktopAdapter__';
    if (page[marker]?.version === VERSION) {
      page[marker].probe();
      return page[marker];
    }
    const doc = page.document;
    const key = 'webpackChunkguessing_game';
    const queue = page[key] = page[key] || [];
    const wrappedFactories = new WeakSet();
    const patchedSDKs = new WeakSet();
    const adapter = { version: VERSION, status: 'waiting', probe: probeCurrentSDK };
    page[marker] = adapter;
    let shadow = null;
    let cancelPending = null;
    let toastTimer = null;

    function ensureRoot() {
      if (shadow) return shadow;
      if (!doc.documentElement) return null;
      const host = doc.createElement('div');
      host.id = 'bili-prophecy-desktop';
      shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        :host { all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; color-scheme: light; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
        * { box-sizing: border-box; }
        .badge { position: fixed; top: 10px; left: 12px; padding: 4px 9px; border: 1px solid #e2edf3; background: #fffffff2; color: #71909e; border-radius: 20px; font-size: 10px; line-height: 1.5; pointer-events: none; box-shadow: 0 2px 8px #26455a06; }
        .badge::before { content: ""; display: inline-block; width: 5px; height: 5px; margin: 0 5px 1px 0; border-radius: 50%; background: #a7b7c3; }
        .badge[data-ready="true"]::before { background: #25b38b; }
        .backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 22px; background: #14233969; backdrop-filter: blur(6px); animation: veil-in .16s ease-out; }
        .dialog { width: min(364px, 100%); max-height: calc(100dvh - 44px); overflow: auto; background: #fff; color: #202d3c; border: 1px solid #fff; border-radius: 22px; padding: 26px; box-shadow: 0 22px 70px #14233933; font-size: 14px; line-height: 1.65; animation: dialog-in .2s ease-out; }
        .dialog-mark { display: grid; place-items: center; width: 48px; height: 48px; margin-bottom: 16px; color: #00a0d6; background: linear-gradient(140deg, #e4f8ff, #eef5ff); border: 1px solid #dceff8; border-radius: 16px; }
        .dialog-eyebrow { margin-bottom: 6px; color: #8492a3; font-size: 11px; font-weight: 600; letter-spacing: .12em; }
        h2 { margin: 0 0 16px; font-size: 20px; font-weight: 700; line-height: 1.5; overflow-wrap: anywhere; }
        p { margin: 0 0 22px; padding: 16px; color: #526276; background: #f5f8fb; border: 1px solid #edf1f6; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.85; }
        .buttons { display: flex; gap: 10px; }
        button { flex: 1; min-width: 0; border: 1px solid #e4eaf1; border-radius: 11px; padding: 11px 8px; font: inherit; font-weight: 600; cursor: pointer; background: #fff; color: #617187; transition: background .15s, transform .15s; }
        button:hover { background: #f3f6fa; }
        button:active { transform: translateY(1px); }
        button[data-desktop-action="confirm"] { border-color: #00a8e1; background: linear-gradient(110deg, #00aeec, #159bdd); color: white; box-shadow: 0 4px 12px #00aeec26; }
        button[data-desktop-action="confirm"]:hover { background: #009ed7; }
        button:focus-visible { outline: 3px solid #00aeec70; outline-offset: 3px; }
        .toast { position: fixed; display: flex; align-items: center; gap: 9px; left: 50%; bottom: 28px; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 32px); background: #223147f5; color: #fff; border: 1px solid #ffffff20; border-radius: 12px; padding: 12px 16px; font-size: 13px; line-height: 1.6; text-align: left; box-shadow: 0 8px 28px #14233924; }
        .toast svg { color: #79d6f6; flex-shrink: 0; }
        @keyframes veil-in { from { opacity: 0; } }
        @keyframes dialog-in { from { opacity: 0; transform: translateY(8px) scale(.98); } }
        @media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
        [hidden] { display: none !important; }
      </style><span class="badge"></span><div class="toast" role="status" hidden>${icon('signal', 18)}<span></span></div>`;
      // The room panel already shows adapter status; keep its cards clear.
      shadow.querySelector('.badge').hidden = page.top !== page.self;
      updateBadge();
      installOfficialTheme();
      (doc.body || doc.documentElement).append(host);
      doc.addEventListener('keydown', event => {
        if (event.key === 'Tab' && cancelPending) {
          const buttons = [...shadow.querySelectorAll('.dialog button')];
          const first = buttons[0], last = buttons[buttons.length - 1];
          const active = shadow.activeElement;
          if (buttons.length && ((!event.shiftKey && active === last) || (event.shiftKey && active === first) || !buttons.includes(active))) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
        }
        if (event.key === 'Escape' && cancelPending) {
          event.preventDefault();
          cancelPending();
        }
      });
      page.addEventListener('pagehide', () => cancelPending?.());
      return shadow;
    }

    function updateBadge() {
      if (!shadow) return;
      shadow.querySelector('.badge').textContent = adapter.status === 'ready'
        ? `桌面交互适配已启用 v${VERSION}` : `桌面适配 v${VERSION}：等待官方组件`;
      shadow.querySelector('.badge').dataset.ready = String(adapter.status === 'ready');
    }

    function installOfficialTheme() {
      if (doc.getElementById('bili-prophecy-theme')) return;
      doc.documentElement.dataset.biliProphecyDesktop = '';
      doc.documentElement.toggleAttribute('data-bili-prophecy-embedded', page.top !== page.self);
      const style = doc.createElement('style');
      style.id = 'bili-prophecy-theme';
      // Scope to the official desktop document and its existing component
      // classes. Vue owns the cards, selected state and all event handlers.
      style.textContent = `
        html[data-bili-prophecy-desktop] { font-size: 40px !important; color-scheme: light; background: #f5f7fb; }
        html[data-bili-prophecy-desktop] body { margin: 0; background: #f5f7fb !important; opacity: 1 !important; font: 14px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
        html[data-bili-prophecy-desktop] body::-webkit-scrollbar { width: 5px; }
        html[data-bili-prophecy-desktop] body::-webkit-scrollbar-thumb { background: #ccd6e2; border-radius: 8px; }
        html[data-bili-prophecy-desktop] .user-detail-content,
        html[data-bili-prophecy-desktop] .content[data-v-00192e7f] { width: 100%; padding: 42px 16px 12px; box-sizing: border-box; }
        html[data-bili-prophecy-desktop] .content[data-v-7569cb0e] { padding: 0 4px 2px; align-items: flex-start; }
        html[data-bili-prophecy-desktop] .content[data-v-7569cb0e] > .title { font-size: 13px; color: #526378; font-weight: 600; }
        html[data-bili-prophecy-desktop] .sub-title { color: #63758b; font-size: 12px; margin-top: 7px; margin-left: 0; }
        html[data-bili-prophecy-desktop] .tip { opacity: .5; right: 4px; filter: grayscale(1) brightness(.6); }
        html[data-bili-prophecy-desktop] .mb20 { margin-bottom: 16px; }
        html[data-bili-prophecy-desktop] .content-prohets-box,
        html[data-bili-prophecy-desktop] .item-content { height: auto; min-height: 0; border: 1px solid #e5ebf3; background: #fff; padding: 16px; margin-bottom: 14px; border-radius: 16px; box-shadow: 0 4px 14px #2a496506; }
        html[data-bili-prophecy-desktop] .content-prohets-box .title,
        html[data-bili-prophecy-desktop] .item-content .title { color: #273449; flex: 1; min-width: 0; font-size: 16px; line-height: 1.6; font-weight: 650; overflow-wrap: anywhere; }
        html[data-bili-prophecy-desktop] .text-line { min-height: 0; height: auto; padding: 0 0 14px; gap: 12px; align-items: flex-start; }
        html[data-bili-prophecy-desktop] .text-line > .line,
        html[data-bili-prophecy-desktop] .tick-block { flex-shrink: 0; margin-top: 3px; }
        html[data-bili-prophecy-desktop] .tickey,
        html[data-bili-prophecy-desktop] .sub-info,
        html[data-bili-prophecy-desktop] .count { color: #63758b; font-size: 12px; }
        html[data-bili-prophecy-desktop] .text-line .count-time { color: #008dbe; font-size: 12px; font-variant-numeric: tabular-nums; }
        /* The official card centers this row without a width. Flex children
           then shrink to their text, leaving two narrow vertical buttons. */
        html[data-bili-prophecy-desktop] .content-prohets-box > .line.mt8 { display: grid; grid-template-columns: minmax(0, 1fr) 22px minmax(0, 1fr); align-items: stretch; gap: 10px; width: 100%; margin-top: 0; }
        html[data-bili-prophecy-desktop] .bigbox { flex: 1; width: auto; min-width: 0; height: auto; }
        html[data-bili-prophecy-desktop] .box { width: 100%; height: 100%; min-height: 68px; border-radius: 12px; opacity: 1; border: 1px solid #dcecf4; background: #eef8fd !important; transition: box-shadow .15s, transform .15s; }
        html[data-bili-prophecy-desktop] .bigbox:last-child .box { border-color: #f4dfe8; background: #fff3f8 !important; }
        html[data-bili-prophecy-desktop] .box .count-time { position: relative; max-width: 100%; color: #08769d; font-size: 16px; font-weight: 650; line-height: 1.45; text-align: center; overflow-wrap: anywhere; }
        html[data-bili-prophecy-desktop] .bigbox:last-child .box .count-time { color: #b63f70; }
        html[data-bili-prophecy-desktop] .box .sub-score { color: #5e7085; font-size: 10px; line-height: 1.5; transform: none; margin-top: 5px; }
        html[data-bili-prophecy-desktop] .box.selected { border: 2px solid #00aeec; box-shadow: 0 0 0 3px #00aeec15; }
        html[data-bili-prophecy-desktop] .bigbox:last-child .box.selected { border-color: #f69; box-shadow: 0 0 0 3px #ff669915; }
        html[data-bili-prophecy-desktop] .box.unselected { opacity: 1; }
        html[data-bili-prophecy-desktop] .content-prohets-box > .line:has(.box.selected) .box.unselected { opacity: .72; }
        html[data-bili-prophecy-desktop] .block { min-height: 66px; padding: 12px 26px; cursor: default; box-sizing: border-box; }
        html[data-bili-prophecy-desktop] .content-prohets-box:has(.tick-block .count-time):not(:has(.box.selected)) .block { cursor: pointer; }
        html[data-bili-prophecy-desktop] .content-prohets-box:has(.tick-block .count-time):not(:has(.box.selected)) .box:hover { box-shadow: 0 4px 12px #1d8db317; transform: translateY(-1px); }
        html[data-bili-prophecy-desktop] .box .icon { height: 22px; left: 7px; top: 7px; opacity: .7; }
        html[data-bili-prophecy-desktop] .vs { width: 22px; margin: 0; align-self: center; opacity: .65; filter: grayscale(1) brightness(.6); }
        html[data-bili-prophecy-desktop] .pk { width: 100%; height: 14px; margin-top: 14px; }
        html[data-bili-prophecy-desktop] .content-pkline { font-variant-numeric: tabular-nums; }
        html[data-bili-prophecy-desktop] .pk .left,
        html[data-bili-prophecy-desktop] .pk .right { font: 10px/14px system-ui, sans-serif; }
        html[data-bili-prophecy-desktop] .pk .left { color: #033a4f; font-weight: 600; }
        html[data-bili-prophecy-desktop] .pk .right { color: #571930; font-weight: 600; }
        html[data-bili-prophecy-desktop] .pk .trangle { width: 10px; }
        html[data-bili-prophecy-desktop] .pk .trangle .blue { border-bottom-width: 14px; border-right-width: 10px; }
        html[data-bili-prophecy-desktop] .pk .trangle .pink { border-top-width: 14px; border-left-width: 10px; }
        html[data-bili-prophecy-desktop] .user-game-footer { display: flex; align-items: center; height: 58px; background: #fffffff5; border-top: 1px solid #e5ebf3; padding: 12px 16px; backdrop-filter: blur(10px); box-shadow: 0 -4px 14px #2a496503; }
        html[data-bili-prophecy-desktop] .user-game-footer > .line { width: 100%; gap: 8px; }
        html[data-bili-prophecy-desktop] .user-game-footer .left { color: #273449; }
        html[data-bili-prophecy-desktop] .user-game-footer .right,
        html[data-bili-prophecy-desktop] .get-heart { color: #65758b; font-size: 11px; }
        html[data-bili-prophecy-desktop] .user-game-footer .heart { width: 18px; opacity: .75; }
        html[data-bili-prophecy-desktop] .heart-num { color: #008dbe; font-size: 18px; line-height: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
        html[data-bili-prophecy-desktop] .h80 { height: 64px; flex-shrink: 0; }
        html[data-bili-prophecy-desktop] .item-content .title-line { align-items: flex-start; gap: 10px; }
        html[data-bili-prophecy-desktop] .item-content .sub,
        html[data-bili-prophecy-desktop] .item-content .gary { color: #63758b; }
        html[data-bili-prophecy-desktop] .item-content .text-content,
        html[data-bili-prophecy-desktop] .item-content .white { color: #516075; }
        html[data-bili-prophecy-desktop] .header[data-v-00192e7f] .title { color: #526378; font-size: 13px; font-weight: 600; }
        html[data-bili-prophecy-desktop] .empty { margin-top: 54px; }
        html[data-bili-prophecy-desktop] .empty-content .sub { color: #8593a5; max-width: 270px; line-height: 1.8; }
        html[data-bili-prophecy-desktop] .loading p { color: #526378; }
        @media (min-width: 560px) { html[data-bili-prophecy-desktop] .user-detail-content, html[data-bili-prophecy-desktop] .content[data-v-00192e7f] { max-width: 680px; margin: 0 auto; padding-top: 54px; } html[data-bili-prophecy-desktop] .user-game-footer { max-width: 680px; left: 50%; transform: translateX(-50%); border-radius: 16px 16px 0 0; } }
        html[data-bili-prophecy-desktop][data-bili-prophecy-embedded] .user-detail-content,
        html[data-bili-prophecy-desktop][data-bili-prophecy-embedded] .content[data-v-00192e7f] { padding-top: 12px; }
        @media (max-width: 340px) { html[data-bili-prophecy-desktop] .content-prohets-box, html[data-bili-prophecy-desktop] .item-content { padding: 12px; } html[data-bili-prophecy-desktop] .text-line { gap: 8px; } html[data-bili-prophecy-desktop] .block { padding-left: 14px; padding-right: 14px; } }
        @media (prefers-reduced-motion: reduce) { html[data-bili-prophecy-desktop] .box { transition: none; } }
      `.replaceAll('html[data-bili-prophecy-desktop]', 'html[data-bili-prophecy-desktop]:has(.user-detail-content, .content[data-v-00192e7f])');
      (doc.head || doc.documentElement).append(style);
    }

    function showModal(options = {}) {
      cancelPending?.();
      const root = ensureRoot();
      const backdrop = doc.createElement('div');
      backdrop.className = 'backdrop';
      const dialog = doc.createElement('section');
      dialog.className = 'dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'desktop-modal-title');
      dialog.setAttribute('aria-describedby', 'desktop-modal-content');
      const mark = doc.createElement('div');
      mark.className = 'dialog-mark';
      mark.innerHTML = icon('spark', 28);
      const eyebrow = doc.createElement('div');
      eyebrow.className = 'dialog-eyebrow';
      eyebrow.textContent = '直播预言 · 请确认';
      const title = doc.createElement('h2');
      title.id = 'desktop-modal-title';
      title.textContent = options.title || '直播预言';
      const content = doc.createElement('p');
      content.id = 'desktop-modal-content';
      content.textContent = options.content || '';
      const buttons = doc.createElement('div');
      buttons.className = 'buttons';
      const previousFocus = doc.activeElement;
      return new page.Promise(resolve => {
        let settled = false;
        const settle = confirm => {
          if (settled) return;
          settled = true;
          cancelPending = null;
          backdrop.remove();
          previousFocus?.focus?.();
          const result = { confirm, cancel: !confirm, noRemind: false };
          try {
            if (typeof options.callback === 'function') options.callback(result);
            if (typeof options.success === 'function') options.success(result);
          } finally { resolve(result); }
        };
        cancelPending = () => settle(false);
        for (const action of options.showCancel === false ? ['confirm'] : ['cancel', 'confirm']) {
          const button = doc.createElement('button');
          button.type = 'button';
          button.dataset.desktopAction = action;
          button.textContent = action === 'confirm' ? options.confirmText || '确认' : options.cancelText || '取消';
          button.addEventListener('click', () => settle(action === 'confirm'), { once: true });
          buttons.append(button);
        }
        dialog.append(mark, eyebrow, title, content, buttons);
        backdrop.append(dialog);
        root.append(backdrop);
        // Default focus goes to cancellation when available; never auto-confirm.
        buttons.querySelector('button').focus();
      });
    }

    function showToast(options = {}) {
      const toast = ensureRoot().querySelector('.toast');
      toast.querySelector('span').textContent = options.msg || options.title || '';
      toast.hidden = false;
      page.clearTimeout(toastTimer);
      toastTimer = page.setTimeout(() => { toast.hidden = true; }, 3200);
      return page.Promise.resolve({});
    }

    function patchSDK(sdk) {
      if (!sdk || typeof sdk.showConfirm !== 'function' || typeof sdk.Request !== 'function' || patchedSDKs.has(sdk)) return;
      if ([1, 2, 3].includes(sdk.getEnvSync?.())) return;
      patchedSDKs.add(sdk);
      sdk.showModal = showModal;
      sdk.showConfirm = options => showModal({ ...options, showCancel: true });
      sdk.showAlert = options => showModal({ ...options, showCancel: false });
      sdk.showToast = showToast;
      adapter.status = 'ready';
      ensureRoot();
      updateBadge();
    }

    function patchChunk(record) {
      const modules = record?.[1];
      const factory = modules?.[1171];
      if (typeof factory !== 'function' || wrappedFactories.has(factory)) return;
      const wrapped = function(module, exports, require) {
        const value = factory.call(this, module, exports, require);
        patchSDK(exports.Ay);
        return value;
      };
      wrappedFactories.add(wrapped);
      modules[1171] = wrapped;
    }

    for (const record of queue) patchChunk(record);
    const wrapPush = implementation => function(...records) {
      for (const record of records) patchChunk(record);
      return implementation.apply(this, records);
    };
    let push = wrapPush(queue.push);
    // Webpack's bootstrap replaces push; keep adapting before it registers modules.
    Object.defineProperty(queue, 'push', {
      configurable: true,
      get: () => push,
      set: implementation => { push = wrapPush(implementation); },
    });

    function probeCurrentSDK() {
      // A userscript can run after Webpack has cached the SDK. Merely wrapping
      // its factory then has no effect. A local runtime chunk exposes the same
      // require function so we can adapt the existing export without a reload.
      queue.push([[
        `bili-prophecy-desktop-${VERSION}-${Date.now()}-${Math.random()}`,
      ], {}, require => {
        if (typeof require?.m?.[1171] === 'function') patchSDK(require(1171).Ay);
      }]);
    }

    ensureRoot();
    if (!shadow) doc.addEventListener('DOMContentLoaded', ensureRoot, { once: true });
    probeCurrentSDK();
    return adapter;
  }

  function roomId() {
    const match = location.pathname.match(/^\/(?:blanc\/)?([1-9]\d*)\/?$/);
    return match ? positiveId(match[1]) : null;
  }

  function officialUrl(view = ui?.view || 'current') {
    const url = new URL(OFFICIAL);
    if (state?.anchorId) url.searchParams.set('anchorId', state.anchorId);
    url.hash = view === 'history' ? '/history' : '/';
    return url.href;
  }

  function placeRoot() {
    if (!ui) return;
    // Container fullscreen can contain an overlay; a native video element cannot.
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && !/^(VIDEO|IFRAME)$/.test(fullscreen.tagName)
      ? fullscreen : document.body;
    if (parent && ui.host.parentNode !== parent) parent.append(ui.host);
  }

  function createUI() {
    const host = document.createElement('div');
    host.id = ROOT_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; display: block; position: fixed; width: 0; height: 0; z-index: 2147483647; color-scheme: light; --ink: #263448; --muted: #8896a8; --blue: #00aeec; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        button, a { font: inherit; -webkit-tap-highlight-color: transparent; }
        button { cursor: pointer; transition: background .15s, box-shadow .15s, transform .15s; }
        button:focus-visible, a:focus-visible { outline: 3px solid #00aeec70; outline-offset: 3px; }
        svg { flex-shrink: 0; }
        .launcher { position: fixed; right: 24px; bottom: 142px; display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 18px 0 13px; border: 1px solid #ffffff38; border-radius: 17px;
          color: #fff; background: linear-gradient(115deg, #00afea, #258ddf); box-shadow: 0 6px 22px #008ccb38, inset 0 1px 0 #ffffff26; font-size: 15px; font-weight: 650; letter-spacing: .05em; }
        .launcher::after { content: ""; position: absolute; top: 9px; right: 9px; width: 5px; height: 5px; background: #ffe1ef; border-radius: 50%; box-shadow: 0 0 0 3px #ffffff12; }
        .launcher:hover { transform: translateY(-2px); box-shadow: 0 9px 26px #008ccb45; }
        .launcher[aria-expanded="true"] { background: #fff; color: #009ed6; border-color: #d5eaf3; box-shadow: 0 4px 18px #253b5b14; }
        .launcher[aria-expanded="true"]::after { background: #00aeec; box-shadow: 0 0 0 3px #00aeec12; }
        .launcher-mark { display: grid; place-items: center; width: 30px; height: 30px; background: #ffffff18; border-radius: 10px; }
        .panel { position: fixed; right: 24px; bottom: 208px; width: min(448px, calc(100vw - 32px));
          height: min(728px, calc(100vh - 232px)); height: min(728px, calc(100dvh - 232px)); min-height: 240px;
          display: flex; flex-direction: column; overflow: hidden; border: 1px solid #e1e8f1; border-radius: 22px;
          background: #fff; color: var(--ink); box-shadow: 0 22px 70px #1f38552b, 0 3px 12px #1f385514; font-size: 14px; line-height: 1.5; animation: panel-in .2s ease-out; }
        .panel::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, #00aeec 5%, #79c9f5 65%, #ff9cbe); }
        header { display: flex; flex-shrink: 0; align-items: flex-start; justify-content: space-between; padding: 20px 20px 10px; background: radial-gradient(ellipse at 100% 0, #f0faff, transparent 70%); }
        .brand { display: flex; align-items: center; gap: 12px; }
        .brand-mark { width: 42px; height: 42px; display: grid; place-items: center; border: 1px solid #dceff8; border-radius: 14px; color: #009ed6; background: linear-gradient(140deg, #e9f9ff, #f2f6ff); }
        .eyebrow { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; color: #63758b; font-size: 10px; font-weight: 600; letter-spacing: .1em; }
        .live-dot { width: 5px; height: 5px; border-radius: 50%; background: #ff82ab; }
        h2 { margin: 0; font-size: 20px; font-weight: 720; line-height: 1.3; letter-spacing: .02em; }
        .close { display: grid; place-items: center; width: 32px; height: 32px; margin-top: -2px; border: 1px solid #e9eef5; background: #ffffffb3; color: #94a1b0; border-radius: 10px; }
        .close:hover { color: #526479; background: #f1f5f9; }
        .room-row { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 8px; padding: 0 20px 12px; }
        .room-chip { display: flex; align-items: center; gap: 6px; color: #6f8097; font-size: 11px; }
        .room { font-variant-numeric: tabular-nums; }
        .source { color: #5f728a; background: #f4f8fc; border: 1px solid #e9f0f6; border-radius: 6px; padding: 3px 7px; font-size: 10px; }
        nav { display: flex; flex-shrink: 0; gap: 4px; margin: 0 18px 12px; padding: 4px; border: 1px solid #edf1f6; border-radius: 13px; background: #f3f6fa; }
        nav button { display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; min-height: 37px; padding: 7px 10px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: #5e7088; font-size: 13px; font-weight: 550; }
        nav button:hover { color: #4f6c84; background: #ffffff70; }
        nav button[aria-pressed="true"] { background: #fff; color: #007ba5; border-color: #e2eaf3; font-weight: 650; box-shadow: 0 2px 5px #1e395508; }
        .viewport { flex: 1; min-height: 0; position: relative; overflow: hidden; border-top: 1px solid #edf1f6; border-bottom: 1px solid #edf1f6; background: #f5f7fb; }
        .content { height: 100%; overflow: hidden; }
        .content iframe { width: 100%; height: 100%; display: block; border: 0; background: #f5f7fb; }
        .message { height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 28px; text-align: center; color: #8896a7; }
        .message-mark { display: grid; place-items: center; width: 60px; height: 60px; margin-bottom: 20px; border: 1px solid #dfebf5; border-radius: 20px; color: #83b4cf; background: #edf5fb; }
        .message[data-state="error"] .message-mark { color: #d49a70; background: #fcf4ec; border-color: #f4e5d7; }
        .message-title { font-size: 15px; color: #556579; margin-bottom: 9px; }
        .message p { margin: 0 0 20px; max-width: 280px; font-size: 12px; line-height: 1.9; }
        .retry { display: flex; align-items: center; gap: 7px; border: 1px solid #00a7df; border-radius: 10px; background: #00aeec; color: #fff; padding: 9px 16px; font-size: 12px; font-weight: 600; }
        .retry:hover { background: #009ed7; }
        .loading-view { position: absolute; inset: 0; padding: 25px 20px; background: #f5f7fb; overflow: hidden; }
        .loading-caption { display: flex; align-items: center; gap: 8px; margin: 0 0 18px; font-size: 12px; color: #8c9aab; }
        .spinner { width: 13px; height: 13px; border: 2px solid #dce9f4; border-top-color: #00aeec; border-radius: 50%; animation: spin 1s linear infinite; }
        .skeleton-card { padding: 20px; margin-bottom: 14px; background: #fff; border: 1px solid #e5ebf3; border-radius: 16px; }
        .skeleton-line { height: 12px; border-radius: 4px; background: #edf1f6; width: 75%; margin-bottom: 12px; animation: pulse 1.4s ease-in-out infinite; }
        .skeleton-line.short { width: 42%; height: 8px; margin-bottom: 20px; }
        .skeleton-options { display: flex; gap: 16px; margin-bottom: 16px; }
        .skeleton-options span { flex: 1; height: 60px; border-radius: 10px; background: #eef7fc; }
        .skeleton-options span + span { background: #fcf1f7; }
        .skeleton-bar { height: 9px; border-radius: 5px; background: linear-gradient(90deg, #d9effa 60%, #f7dfeb 60%); }
        footer { flex-shrink: 0; padding: 10px 16px; background: #fff; }
        .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .connection { display: flex; align-items: center; gap: 6px; color: #7b8b9e; font-size: 11px; white-space: nowrap; }
        .connection::before { content: ""; flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: #b4c1ce; }
        .connection[data-state="ready"] { color: #4a7b69; }
        .connection[data-state="ready"]::before { background: #29b28c; box-shadow: 0 0 0 3px #29b28c10; }
        .connection[data-state="loading"]::before { background: #78bce0; }
        .connection[data-state="warning"] { color: #b08b64; }
        .connection[data-state="warning"]::before { background: #d4a771; }
        .tools { display: flex; align-items: center; gap: 3px; }
        footer button, footer a { display: flex; align-items: center; gap: 5px; min-height: 30px; border: 0; border-radius: 7px; padding: 6px 7px; background: transparent; color: #617e98; text-decoration: none; font-size: 11px; white-space: nowrap; }
        footer button:hover, footer a:hover { color: #009ed6; background: #f0f8fc; }
        footer a[aria-disabled="true"] { color: #b1bcc8; pointer-events: none; }
        .footnote { display: flex; align-items: flex-start; gap: 10px; justify-content: space-between; margin-top: 5px; }
        .hint { flex: 1; margin: 0; color: #63758b; font-size: 10px; line-height: 1.7; }
        .version { color: #65758b; font-size: 10px; font-variant-numeric: tabular-nums; padding-top: 1px; }
        @keyframes panel-in { from { opacity: 0; transform: translateY(8px); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 50% { opacity: .45; } }
        @media (max-width: 540px), (max-height: 640px) {
          .launcher { right: 14px; bottom: 20px; height: 48px; }
          .panel { right: 14px; bottom: 82px; width: min(448px, calc(100vw - 28px)); height: calc(100vh - 106px); height: calc(100dvh - 106px); min-height: 180px; border-radius: 18px; }
          header { padding: 19px 18px 12px; }
          .room-row { padding: 0 18px 12px; }
          nav { margin: 0 16px 14px; }
          footer { padding: 11px 16px; }
        }
        @media (max-height: 420px) { header { padding: 12px 18px 8px; } .brand-mark { width: 36px; height: 36px; } h2 { font-size: 18px; } .room-row, .footnote { display: none; } nav { margin-bottom: 10px; } }
        @media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
      </style>
      <button class="launcher" data-action="toggle" aria-expanded="false" aria-controls="prophecy-panel" title="打开当前直播间的官方预言"><span class="launcher-mark">${icon('spark', 21)}</span><span>预言</span></button>
      <section class="panel" id="prophecy-panel" role="dialog" aria-label="B站直播预言" hidden>
        <header><div class="brand"><span class="brand-mark">${icon('spark', 27)}</span><div><div class="eyebrow"><span class="live-dot"></span>BILIBILI LIVE</div><h2>直播预言</h2></div></div><button class="close" data-action="close" aria-label="关闭预言面板" title="收起面板">${icon('close', 16)}</button></header>
        <div class="room-row"><div class="room-chip">${icon('room', 14)}<span class="room"></span></div><span class="source">官方预言</span></div>
        <nav aria-label="预言页面">
          <button data-action="current" aria-pressed="true">${icon('spark', 16)}当前预言</button>
          <button data-action="history" aria-pressed="false">${icon('history', 16)}参与历史</button>
        </nav>
        <div class="viewport">
          <div class="content" aria-busy="false"></div>
          <div class="message" role="status" hidden><span class="message-mark">${icon('signal', 28)}</span><strong class="message-title">正在连接直播间</strong><p></p><button class="retry" data-action="retry" hidden>${icon('refresh', 14)}重新识别主播</button></div>
          <div class="loading-view" role="status" hidden><div class="loading-caption"><span class="spinner" aria-hidden="true"></span><span>正在打开预言…</span></div><div aria-hidden="true"><div class="skeleton-card"><div class="skeleton-line"></div><div class="skeleton-line short"></div><div class="skeleton-options"><span></span><span></span></div><div class="skeleton-bar"></div></div><div class="skeleton-card"><div class="skeleton-line"></div><div class="skeleton-line short"></div><div class="skeleton-options"><span></span><span></span></div><div class="skeleton-bar"></div></div></div></div>
        </div>
        <footer><div class="toolbar"><span class="connection" data-state="waiting" role="status">正在连接</span><div class="tools"><button data-action="refresh" title="重新加载预言">${icon('refresh', 13)}刷新</button><a data-action="external" target="_blank" rel="noopener noreferrer">独立窗口${icon('external', 12)}</a></div></div><div class="footnote"><p class="hint">在卡片中选择答案，确认后参与预言。</p><span class="version">v${VERSION}</span></div></footer>
      </section>`;

    const find = selector => shadow.querySelector(selector);
    ui = {
      host, shadow, open: false, view: 'current',
      panel: find('.panel'), content: find('.content'), message: find('.message'),
      status: find('.message p'), retry: find('[data-action="retry"]'),
      launcher: find('[data-action="toggle"]'), external: find('[data-action="external"]'),
      room: find('.room'), current: find('[data-action="current"]'), history: find('[data-action="history"]'),
      hint: find('.hint'),
      connection: find('.connection'), loader: find('.loading-view'), loaderCaption: find('.loading-caption > span:last-child'),
      messageTitle: find('.message-title'), loadTimer: null,
    };
    shadow.addEventListener('click', event => {
      const action = event.target.closest?.('[data-action]')?.dataset.action;
      if (!action) return;
      const previousState = state;
      syncRoute();
      if (action === 'external') {
        // Revalidate synchronously so a SPA navigation cannot open a stale owner.
        if (!ui || state !== previousState || !ui.external.hasAttribute('href')) event.preventDefault();
        return;
      }
      if (!ui) return;
      if (action === 'toggle') setOpen(!ui.open);
      else if (action === 'close') setOpen(false);
      else if (action === 'current' || action === 'history') {
        ui.view = action;
        render();
      } else if (action === 'retry') lookup(state);
      else if (action === 'refresh') {
        if (!state.anchorId && ui.view === 'current') lookup(state);
        else render();
      }
    });
    placeRoot();
  }

  function setOpen(open) {
    if (!ui) return;
    ui.open = open;
    ui.panel.hidden = !open;
    ui.launcher.setAttribute('aria-expanded', String(open));
    if (open) {
      render();
      ui.current.focus();
    } else {
      clearTimeout(ui.loadTimer);
      ui.loadTimer = null;
      ui.loader.hidden = true;
      ui.content.setAttribute('aria-busy', 'false');
      ui.content.replaceChildren();
      ui.launcher.focus();
    }
  }

  function render() {
    if (!ui || !state) return;
    clearTimeout(ui.loadTimer);
    ui.loadTimer = null;
    ui.loader.hidden = true;
    ui.content.setAttribute('aria-busy', 'false');
    ui.room.textContent = `当前直播间 ${state.roomId}`;
    ui.current.setAttribute('aria-pressed', String(ui.view === 'current'));
    ui.history.setAttribute('aria-pressed', String(ui.view === 'history'));
    const canLoad = ui.view === 'history' || Boolean(state.anchorId);
    if (canLoad) {
      ui.external.href = officialUrl();
      ui.external.removeAttribute('aria-disabled');
      ui.external.removeAttribute('tabindex');
    } else {
      ui.external.removeAttribute('href');
      ui.external.setAttribute('aria-disabled', 'true');
      ui.external.setAttribute('tabindex', '-1');
    }
    ui.content.replaceChildren();
    ui.message.hidden = canLoad;
    ui.content.hidden = !canLoad;
    ui.retry.hidden = state.status !== 'error';
    ui.message.dataset.state = state.status;
    ui.messageTitle.textContent = state.status === 'error' ? '暂时未能连接主播' : '正在连接直播间';
    ui.status.textContent = state.status === 'error'
      ? `${state.error} 可重试，或先查看参与历史。` : '正在识别当前主播…';
    ui.connection.dataset.state = state.status === 'error' ? 'warning' : 'waiting';
    ui.connection.textContent = state.status === 'error' ? '连接待恢复' : '正在连接';
    if (!ui.open || !canLoad) return;

    const frame = document.createElement('iframe');
    frame.title = ui.view === 'history' ? '官方预言参与历史' : '官方直播预言';
    frame.src = officialUrl();
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    ui.hint.textContent = '正在连接官方预言，请稍候。';
    ui.connection.dataset.state = 'loading';
    ui.connection.textContent = '正在加载';
    ui.loader.hidden = false;
    ui.loaderCaption.textContent = ui.view === 'history' ? '正在打开参与历史…' : '正在打开预言…';
    ui.content.setAttribute('aria-busy', 'true');
    ui.loadTimer = setTimeout(() => {
      if (!ui || !frame.isConnected || ui.content.firstChild !== frame) return;
      ui.loader.hidden = true;
      ui.content.setAttribute('aria-busy', 'false');
      ui.connection.dataset.state = 'warning';
      ui.connection.textContent = '加载较慢';
      ui.hint.textContent = '加载时间较长，可刷新或用独立窗口打开。';
      ui.loadTimer = null;
    }, 15000);
    frame.addEventListener('load', () => {
      if (!ui || !frame.isConnected || ui.content.firstChild !== frame) return;
      clearTimeout(ui.loadTimer);
      ui.loadTimer = null;
      ui.loader.hidden = true;
      ui.content.setAttribute('aria-busy', 'false');
      try {
        // Same-origin fallback: some userscript managers skip dynamic frames
        // or inject after startup. The parent can also repair the loaded SDK.
        const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
        const child = page.document.getElementById(ROOT_ID)?.shadowRoot?.querySelector('iframe')?.contentWindow;
        if (!child) throw new Error('missing frame');
        if (child.location.origin !== location.origin || child.location.pathname !== new URL(OFFICIAL).pathname) throw new Error('unexpected frame');
        const adapter = adaptOfficialDesktop(child);
        ui.connection.dataset.state = adapter?.status === 'ready' ? 'ready' : 'warning';
        ui.connection.textContent = adapter?.status === 'ready' ? '已连接' : '交互待就绪';
        ui.hint.textContent = adapter?.status === 'ready'
          ? '桌面适配已启用，在卡片中选择答案并确认。'
          : '交互暂未就绪，可用独立窗口打开查看状态。';
      } catch {
        ui.connection.dataset.state = 'warning';
        ui.connection.textContent = '连接待恢复';
        ui.hint.textContent = '无法连接官方面板，可用独立窗口打开。';
      }
    });
    ui.content.append(frame);
  }

  async function lookup(target) {
    if (!target || target !== state) return;
    target.controller?.abort();
    const controller = new AbortController();
    target.controller = controller;
    target.status = 'loading';
    target.error = '';
    render();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const url = new URL('https://api.live.bilibili.com/room/v1/Room/room_init');
      url.searchParams.set('id', target.roomId);
      const response = await fetch(url.href, { method: 'GET', credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('room lookup HTTP failure');
      const payload = await response.json();
      const uid = positiveId(payload?.data?.uid);
      if (payload.code !== 0 || !uid) throw new Error('room lookup invalid response');
      if (state !== target || target.controller !== controller || roomId() !== target.roomId) return;
      target.anchorId = uid;
      target.status = 'ready';
      render();
    } catch {
      if (state !== target || target.controller !== controller || roomId() !== target.roomId) return;
      target.status = 'error';
      target.error = controller.signal.aborted ? '主播识别超时。' : '暂时无法识别主播。';
      render();
    } finally {
      clearTimeout(timeout);
      if (target.controller === controller) target.controller = null;
    }
  }

  function syncRoute() {
    const id = roomId();
    if (id === state?.roomId) {
      // Some room layouts replace their body contents after navigation.
      placeRoot();
      return;
    }
    state?.controller?.abort();
    state = id ? { roomId: id, anchorId: null, status: 'loading', error: '', controller: null } : null;
    if (!state) {
      clearTimeout(ui?.loadTimer);
      ui?.host.remove();
      ui = null;
      return;
    }
    if (!ui) createUI();
    else ui.view = 'current';
    lookup(state);
  }

  function start() {
    syncRoute();
    if (state && state.status !== 'ready' && (!state.controller || state.controller.signal.aborted)) lookup(state);
    if (poll === null) poll = setInterval(syncRoute, 1000);
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && ui?.open) setOpen(false);
  });
  document.addEventListener('fullscreenchange', placeRoot);
  window.addEventListener('popstate', syncRoute);
  window.addEventListener('pageshow', start);
  window.addEventListener('pagehide', () => {
    clearTimeout(ui?.loadTimer);
    if (ui) {
      ui.loadTimer = null;
      ui.loader.hidden = true;
      ui.content.setAttribute('aria-busy', 'false');
    }
    clearInterval(poll);
    poll = null;
    state?.controller?.abort();
  });
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('打开直播预言', () => {
      syncRoute();
      if (ui) setOpen(true);
    });
  }
  start();
})();
