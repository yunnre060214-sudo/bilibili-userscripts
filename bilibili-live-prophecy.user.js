// ==UserScript==
// @name         B站直播预言
// @namespace    https://space.bilibili.com/1937432404
// @version      0.1.2
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

  const VERSION = '0.1.2';

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
        :host { all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; color-scheme: light; }
        * { box-sizing: border-box; }
        .badge { position: fixed; top: 6px; left: 6px; background: #e5f6fd; color: #008ac5; padding: 3px 8px; border-radius: 4px; font: 11px/1.5 system-ui, sans-serif; pointer-events: none; }
        .backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 20px; background: #0007; }
        .dialog { width: min(340px, 100%); background: #fff; color: #18191c; border-radius: 14px; padding: 22px; box-shadow: 0 12px 40px #0003; font: 14px/1.6 system-ui, sans-serif; }
        h2 { margin: 0 0 12px; font-size: 17px; }
        p { margin: 0 0 20px; white-space: pre-wrap; overflow-wrap: anywhere; }
        .buttons { display: flex; gap: 12px; }
        button { flex: 1; border: 0; border-radius: 8px; padding: 9px; font: inherit; cursor: pointer; background: #f1f2f3; color: #61666d; }
        button[data-desktop-action="confirm"] { background: #00aeec; color: white; }
        button:focus-visible { outline: 3px solid #00aeec; outline-offset: 3px; }
        .toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 32px); background: #18191ce8; color: #fff; border-radius: 8px; padding: 10px 16px; font: 14px/1.5 system-ui, sans-serif; text-align: center; }
        [hidden] { display: none !important; }
      </style><span class="badge"></span><div class="toast" role="status" hidden></div>`;
      updateBadge();
      (doc.body || doc.documentElement).append(host);
      doc.addEventListener('keydown', event => {
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
      const title = doc.createElement('h2');
      title.id = 'desktop-modal-title';
      title.textContent = options.title || '直播预言';
      const content = doc.createElement('p');
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
        dialog.append(title, content, buttons);
        backdrop.append(dialog);
        root.append(backdrop);
        // Default focus goes to cancellation when available; never auto-confirm.
        buttons.querySelector('button').focus();
      });
    }

    function showToast(options = {}) {
      const toast = ensureRoot().querySelector('.toast');
      toast.textContent = options.msg || options.title || '';
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
        :host { all: initial; display: block; position: fixed; width: 0; height: 0; z-index: 2147483647; color-scheme: light; }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        button, a { font: inherit; }
        button { cursor: pointer; }
        button:focus-visible, a:focus-visible { outline: 3px solid #00aeec; outline-offset: 2px; }
        .launcher { position: fixed; right: 20px; bottom: 160px; height: 42px; padding: 0 18px; border: 0; border-radius: 21px;
          color: #fff; background: #00a4d8; box-shadow: 0 4px 20px #0003; font: 600 15px/42px system-ui, sans-serif; }
        .panel { position: fixed; right: 20px; bottom: 216px; width: min(400px, calc(100vw - 24px));
          height: min(640px, calc(100vh - 240px)); height: min(640px, calc(100dvh - 240px)); min-height: 260px;
          display: flex; flex-direction: column; overflow: hidden; border: 1px solid #e3e5e7; border-radius: 16px;
          background: #fff; color: #18191c; box-shadow: 0 8px 40px #0003; font: 14px/1.5 system-ui, sans-serif; }
        header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 6px; }
        h2 { margin: 0; font-size: 17px; font-weight: 650; }
        .close { border: 0; background: transparent; color: #61666d; padding: 4px 8px; border-radius: 6px; }
        .room { padding: 0 16px 10px; color: #61666d; font-size: 12px; }
        nav { display: flex; gap: 8px; padding: 0 16px 12px; }
        nav button { flex: 1; padding: 7px 10px; border: 0; border-radius: 8px; background: #f1f2f3; color: #61666d; }
        nav button[aria-pressed="true"] { background: #e5f6fd; color: #008ac5; font-weight: 600; }
        .content { flex: 1; min-height: 0; background: #f8f9fa; overflow: hidden; }
        .content iframe { width: 100%; height: 100%; display: block; border: 0; background: #fff; }
        .message { padding: 48px 24px; text-align: center; color: #61666d; }
        .message p { margin: 0 0 16px; }
        .retry { border: 0; border-radius: 8px; background: #00aeec; color: #fff; padding: 8px 18px; }
        footer { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-top: 1px solid #eee; }
        footer button, footer a { border: 0; padding: 3px 0; background: transparent; color: #008ac5; text-decoration: none; }
        footer a[aria-disabled="true"] { color: #9499a0; pointer-events: none; }
        .hint { margin: 0; padding: 0 16px 12px; color: #9499a0; font-size: 12px; }
        @media (max-width: 540px), (max-height: 600px) {
          .launcher { right: 12px; bottom: 20px; }
          .panel { right: 12px; bottom: 76px; height: calc(100vh - 96px); height: calc(100dvh - 96px); min-height: 160px; }
        }
      </style>
      <button class="launcher" data-action="toggle" aria-expanded="false" aria-controls="prophecy-panel" title="打开当前直播间的官方预言">预言</button>
      <section class="panel" id="prophecy-panel" role="dialog" aria-label="B站直播预言" hidden>
        <header><h2>直播预言</h2><button class="close" data-action="close" aria-label="关闭预言面板">关闭</button></header>
        <div class="room"></div>
        <nav aria-label="预言页面">
          <button data-action="current" aria-pressed="true">当前预言</button>
          <button data-action="history" aria-pressed="false">参与历史</button>
        </nav>
        <div class="content"></div>
        <div class="message" role="status" hidden><p></p><button class="retry" data-action="retry" hidden>重新识别主播</button></div>
        <footer><button data-action="refresh">刷新</button><a data-action="external" target="_blank" rel="noopener noreferrer">独立窗口打开</a></footer>
        <p class="hint">v${VERSION}：在官方面板中选择并确认；参与后可到历史查看记录。</p>
      </section>`;

    const find = selector => shadow.querySelector(selector);
    ui = {
      host, shadow, open: false, view: 'current',
      panel: find('.panel'), content: find('.content'), message: find('.message'),
      status: find('.message p'), retry: find('[data-action="retry"]'),
      launcher: find('[data-action="toggle"]'), external: find('[data-action="external"]'),
      room: find('.room'), current: find('[data-action="current"]'), history: find('[data-action="history"]'),
      hint: find('.hint'),
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
      ui.content.replaceChildren();
      ui.launcher.focus();
    }
  }

  function render() {
    if (!ui || !state) return;
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
    ui.status.textContent = state.status === 'error'
      ? `${state.error} 可重试，或先查看参与历史。` : '正在识别当前主播…';
    if (!ui.open || !canLoad) return;

    const frame = document.createElement('iframe');
    frame.title = ui.view === 'history' ? '官方预言参与历史' : '官方直播预言';
    frame.src = officialUrl();
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    ui.hint.textContent = `v${VERSION}：正在加载桌面适配…`;
    frame.addEventListener('load', () => {
      if (!ui || !frame.isConnected || ui.content.firstChild !== frame) return;
      try {
        // Same-origin fallback: some userscript managers skip dynamic frames
        // or inject after startup. The parent can also repair the loaded SDK.
        const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
        const child = page.document.getElementById(ROOT_ID)?.shadowRoot?.querySelector('iframe')?.contentWindow;
        if (!child) throw new Error('missing frame');
        if (child.location.origin !== location.origin || child.location.pathname !== new URL(OFFICIAL).pathname) throw new Error('unexpected frame');
        const adapter = adaptOfficialDesktop(child);
        ui.hint.textContent = adapter?.status === 'ready'
          ? `v${VERSION}：桌面适配已启用，在官方面板中选择并确认。`
          : `v${VERSION}：未检测到桌面适配，请用独立窗口打开并查看左上角状态。`;
      } catch {
        ui.hint.textContent = `v${VERSION}：无法连接官方面板，请用独立窗口打开。`;
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
