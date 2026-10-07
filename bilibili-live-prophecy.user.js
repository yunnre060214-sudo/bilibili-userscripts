// ==UserScript==
// @name         B站直播预言
// @namespace    https://space.bilibili.com/1937432404
// @version      0.3.1
// @description  在弹幕输入框上方添加简约预言图标，独立打开官方预言与参与历史，适配桌面交互。
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

  const VERSION = '0.3.1';

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
  const instance = Symbol.for('bili-prophecy-room-entry');
  if (document[instance] || document.getElementById('bili-prophecy-root')) return;
  document[instance] = true;

  const OFFICIAL = 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html';
  const ROOT_ID = 'bili-prophecy-root';
  let state = null;
  let ui = null;
  let poll = null;
  let observer = null;
  let active = true;

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
        .backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 22px; background: #14233969; backdrop-filter: blur(6px); animation: veil-in .16s ease-out; }
        .dialog { width: min(364px, 100%); max-height: calc(100dvh - 44px); overflow: auto; background: #fff; color: #18191c; border: 1px solid #dfe3e9; border-radius: 16px; padding: 0; box-shadow: 0 18px 48px #0f172e2e; font-size: 14px; line-height: 1.65; animation: dialog-in .2s ease-out; }
        .dialog-head { display: flex; align-items: flex-start; gap: 10px; padding: 16px 18px; background: linear-gradient(120deg, #fcedf2, #f2eef8 48%, #e6f7fd); border-bottom: 1px solid #e0e4ea; }
        .dialog-mark { display: grid; place-items: center; flex-shrink: 0; width: 30px; height: 30px; margin-top: 2px; color: #0084b0; border: 1px solid #ffffffb3; border-radius: 10px; background: #ffffff80; }
        .dialog-heading { min-width: 0; }
        .dialog-eyebrow { margin-bottom: 3px; color: #637083; font-size: 11px; }
        h2 { margin: 0; font-size: 16px; font-weight: 700; line-height: 1.55; overflow-wrap: anywhere; }
        p { margin: 18px 18px 14px; padding: 12px; color: #3f4c5d; background: #f6f7f8; border: 1px solid #e5e7eb; border-radius: 12px; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.85; }
        .dialog-accent { height: 3px; margin: 0 18px; border-radius: 8px; background: linear-gradient(90deg, #fb7299, #ae9cdb 48%, #00aeec); }
        .buttons { display: flex; gap: 9px; padding: 16px 18px 18px; }
        button { flex: 1; min-width: 0; min-height: 36px; border: 1px solid #b9e1f2; border-radius: 10px; padding: 8px; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; background: #fff; color: #007ba5; transition: background .15s, transform .15s; }
        button:hover { background: #f0faff; }
        button:active { transform: translateY(1px); }
        button[data-desktop-action="confirm"] { border-color: #f3b8ce; background: linear-gradient(115deg, #fff0f5, #f9f2ff); color: #b33568; font-weight: 700; }
        button[data-desktop-action="confirm"]:hover { background: linear-gradient(115deg, #ffe4ed, #f3e9fc); }
        button:focus-visible { outline: 2px solid #aa9ad9; outline-offset: 2px; }
        .toast { position: fixed; display: flex; align-items: center; gap: 9px; left: 50%; bottom: 24px; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 32px); background: linear-gradient(115deg, #fff7fa, #f8f5fc 45%, #eefaff); color: #3f4c5d; border: 1px solid #dce4ef; border-radius: 12px; padding: 11px 14px; font-size: 13px; line-height: 1.6; text-align: left; box-shadow: 0 8px 28px #1423391a; }
        .toast svg { color: #0084b0; flex-shrink: 0; }
        @keyframes veil-in { from { opacity: 0; } }
        @keyframes dialog-in { from { opacity: 0; transform: translateY(8px) scale(.98); } }
        @media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
        [hidden] { display: none !important; }
      </style><div class="toast" role="status" hidden>${icon('signal', 18)}<span></span></div>`;
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

    function installOfficialTheme() {
      if (doc.getElementById('bili-prophecy-theme')) return;
      doc.documentElement.dataset.biliProphecyDesktop = '';
      const style = doc.createElement('style');
      style.id = 'bili-prophecy-theme';
      // Scope to the official desktop document and its existing component
      // classes. Vue owns the cards, selected state and all event handlers.
      style.textContent = `
        html[data-bili-prophecy-desktop] { font-size: 40px !important; color-scheme: light; background: #fafbfc; }
        html[data-bili-prophecy-desktop] body { margin: 0; background: #fafbfc !important; opacity: 1 !important; font: 14px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
        html[data-bili-prophecy-desktop] body::-webkit-scrollbar { width: 5px; }
        html[data-bili-prophecy-desktop] body::-webkit-scrollbar-thumb { background: #ccd6e2; border-radius: 8px; }
        html[data-bili-prophecy-desktop] .user-detail-content,
        html[data-bili-prophecy-desktop] .content[data-v-00192e7f] { width: 100%; padding: 16px 16px 12px; box-sizing: border-box; }
        html[data-bili-prophecy-desktop] .content[data-v-7569cb0e] { padding: 0 4px 2px; align-items: flex-start; }
        html[data-bili-prophecy-desktop] .content[data-v-7569cb0e] > .title { font-size: 13px; color: #526378; font-weight: 600; }
        html[data-bili-prophecy-desktop] .sub-title { color: #63758b; font-size: 12px; margin-top: 7px; margin-left: 0; }
        html[data-bili-prophecy-desktop] .tip { opacity: .5; right: 4px; filter: grayscale(1) brightness(.6); }
        html[data-bili-prophecy-desktop] .mb20 { margin-bottom: 16px; }
        html[data-bili-prophecy-desktop] .content-prohets-box,
        html[data-bili-prophecy-desktop] .item-content { height: auto; min-height: 0; border: 1px solid #e5e7eb; background: #fff; padding: 16px; margin-bottom: 14px; border-radius: 12px; box-shadow: 0 2px 8px #2a496504; }
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
        html[data-bili-prophecy-desktop] .box { width: 100%; height: 100%; min-height: 68px; border-radius: 10px; opacity: 1; border: 1px solid #cce8f5; background: linear-gradient(120deg, #edfaff, #f3f5ff) !important; transition: box-shadow .15s, transform .15s; }
        html[data-bili-prophecy-desktop] .bigbox:last-child .box { border-color: #f1d4e0; background: linear-gradient(120deg, #fff1f6, #f9f3ff) !important; }
        html[data-bili-prophecy-desktop] .box .count-time { position: relative; max-width: 100%; color: #08769d; font-size: 16px; font-weight: 650; line-height: 1.45; text-align: center; overflow-wrap: anywhere; }
        html[data-bili-prophecy-desktop] .bigbox:last-child .box .count-time { color: #b63f70; }
        html[data-bili-prophecy-desktop] .box .sub-score { color: #5e7085; font-size: 10px; line-height: 1.5; transform: none; margin-top: 5px; }
        html[data-bili-prophecy-desktop] .box.selected { border: 2px solid #40b4da; box-shadow: 0 2px 8px #00aeec0c; }
        html[data-bili-prophecy-desktop] .bigbox:last-child .box.selected { border-color: #ee85aa; box-shadow: 0 2px 8px #ff66990c; }
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
        @media (min-width: 560px) { html[data-bili-prophecy-desktop] .user-detail-content, html[data-bili-prophecy-desktop] .content[data-v-00192e7f] { max-width: 680px; margin: 0 auto; padding-top: 20px; } html[data-bili-prophecy-desktop] .user-game-footer { max-width: 680px; left: 50%; transform: translateX(-50%); border-radius: 16px 16px 0 0; } }
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
      mark.innerHTML = icon('spark', 18);
      const eyebrow = doc.createElement('div');
      eyebrow.className = 'dialog-eyebrow';
      eyebrow.textContent = '直播预言 · 请确认';
      const title = doc.createElement('h2');
      title.id = 'desktop-modal-title';
      title.textContent = options.title || '直播预言';
      const heading = doc.createElement('div');
      heading.className = 'dialog-heading';
      heading.append(eyebrow, title);
      const head = doc.createElement('div');
      head.className = 'dialog-head';
      head.append(mark, heading);
      const content = doc.createElement('p');
      content.id = 'desktop-modal-content';
      content.textContent = options.content || '';
      const accent = doc.createElement('div');
      accent.className = 'dialog-accent';
      accent.setAttribute('aria-hidden', 'true');
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
        dialog.append(head, content, accent, buttons);
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

  function officialUrl() {
    const url = new URL(OFFICIAL);
    url.searchParams.set('anchorId', state.anchorId);
    url.hash = '/';
    return url.href;
  }

  function placeRoot() {
    if (!active || !ui || !state) return;
    // Keep the entry inside the native controls, including when Vue replaces them.
    // The connected fast path avoids scanning the DOM for each incoming danmaku.
    if (ui.host.isConnected && ui.host.parentNode === ui.mountPoint) return;
    const toolbar = document.querySelector('#chat-control-panel-vm .control-panel-icon-row, .chat-control-panel .control-panel-icon-row');
    if (!toolbar) return;
    const left = toolbar.querySelector(':scope > .icon-left-part');
    ui.mountPoint = left || toolbar;
    ui.host.dataset.placement = left ? 'left' : 'toolbar';
    if (left) left.append(ui.host);
    else toolbar.prepend(ui.host);
  }

  function createUI() {
    const host = document.createElement('div');
    host.id = ROOT_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host { all: initial; display: inline-flex; flex: 0 0 auto; align-self: center; vertical-align: middle; width: 28px; height: 28px; margin-left: 4px; color-scheme: light dark; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
      :host([data-placement="toolbar"]) { float: left; }
      * { box-sizing: border-box; }
      button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 3px; border: 0; border-radius: 6px; color: #858b96; background: transparent; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background .15s, transform .15s; }
      svg { display: block; flex-shrink: 0; }
      button:hover:not(:disabled) { background: linear-gradient(135deg, #fb72991a, #ae9cdb1a 48%, #00aeec1a); }
      button:active:not(:disabled) { transform: scale(.94); }
      button:focus-visible { outline: 2px solid #aa9ad9; outline-offset: 2px; }
      button:disabled { opacity: .6; cursor: wait; }
      button[data-state="error"] { color: #bf7857; }
      @media (prefers-reduced-motion: reduce) { button { transition: none; } }
    </style><button type="button" data-action="open" aria-label="在独立窗口打开直播预言">${icon('spark', 22)}</button>`;
    const button = shadow.querySelector('button');
    ui = { host, button, mountPoint: null };
    button.addEventListener('click', event => {
      event.stopPropagation();
      openPrediction();
    });
    renderEntry();
    placeRoot();
  }

  function renderEntry() {
    if (!ui || !state) return;
    const loading = state.status === 'loading';
    ui.button.disabled = loading;
    ui.button.dataset.state = state.status;
    ui.button.setAttribute('aria-busy', String(loading));
    ui.button.setAttribute('aria-label', state.status === 'error' ? '主播识别失败，点击重试' : '在独立窗口打开直播预言');
    ui.button.title = loading ? '正在识别当前主播…'
      : state.status === 'error' ? `${state.error} 点击重试。`
      : `在独立窗口打开当前主播的预言 · v${VERSION}`;
  }

  function openPrediction() {
    // Recheck synchronously in case the SPA route changed before the timer ran.
    syncRoute();
    if (!state || state.status === 'loading') return;
    if (state.status === 'error') {
      lookup(state);
      return;
    }
    if (!positiveId(state.anchorId)) return;
    // Stay inside the user gesture. Browser preferences choose a new tab/window.
    window.open(officialUrl(), '_blank', 'noopener,noreferrer');
  }

  async function lookup(target) {
    if (!target || target !== state) return;
    target.controller?.abort();
    const controller = new AbortController();
    target.controller = controller;
    target.status = 'loading';
    target.error = '';
    renderEntry();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const url = new URL('https://api.live.bilibili.com/room/v1/Room/room_init');
      url.searchParams.set('id', target.roomId);
      const response = await fetch(url.href, { method: 'GET', credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('room lookup HTTP failure');
      const payload = await response.json();
      const uid = positiveId(payload?.data?.uid);
      if (payload.code !== 0 || !uid) throw new Error('room lookup invalid response');
      if (!active || controller.signal.aborted || state !== target || target.controller !== controller || roomId() !== target.roomId) return;
      target.anchorId = uid;
      target.status = 'ready';
      renderEntry();
    } catch {
      if (!active || state !== target || target.controller !== controller || roomId() !== target.roomId) return;
      target.status = 'error';
      target.error = controller.signal.aborted ? '主播识别超时。' : '暂时无法识别主播。';
      renderEntry();
    } finally {
      clearTimeout(timeout);
      if (target.controller === controller) target.controller = null;
    }
  }

  function syncRoute() {
    const id = roomId();
    if (id === state?.roomId) {
      placeRoot();
      return;
    }
    state?.controller?.abort();
    state = id ? { roomId: id, anchorId: null, status: 'loading', error: '', controller: null } : null;
    if (!state) {
      ui?.host.remove();
      ui = null;
      return;
    }
    if (!ui) createUI();
    lookup(state);
  }

  function start() {
    active = true;
    if (!observer) {
      observer = new MutationObserver(placeRoot);
      observer.observe(document, { childList: true, subtree: true });
    }
    syncRoute();
    if (state && state.status !== 'ready' && (!state.controller || state.controller.signal.aborted)) lookup(state);
    if (poll === null) poll = setInterval(syncRoute, 1000);
  }

  window.addEventListener('popstate', syncRoute);
  window.addEventListener('pageshow', start);
  window.addEventListener('pagehide', () => {
    active = false;
    observer?.disconnect();
    observer = null;
    clearInterval(poll);
    poll = null;
    state?.controller?.abort();
  });
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('打开直播预言', openPrediction);
  }
  start();
})();
