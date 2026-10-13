// ==UserScript==
// @name         BiliFrame · B站自适应大屏布局
// @namespace    https://github.com/yunnre060214-sudo/bilibili-userscripts
// @version      1.0.0
// @description  沉浸观看、紧凑双栏、原版布局一键切换；播放器按窗口宽高自适应，保留弹幕、评论和推荐。
// @author       yunnre060214-sudo
// @match        https://www.bilibili.com/video/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @homepageURL  https://github.com/yunnre060214-sudo/bilibili-userscripts
// @supportURL   https://github.com/yunnre060214-sudo/bilibili-userscripts/issues
// @updateURL    https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/biliframe.user.js
// @downloadURL  https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/biliframe.user.js
// @license      MIT
// ==/UserScript==

(function boot() {
  'use strict';
  if (!document.documentElement) { document.addEventListener('DOMContentLoaded', boot, { once: true }); return; }
  if (window.top !== window.self || document.getElementById('biliframe-style')) return;

  const KEY = 'biliframe.settings.v1';
  const DEFAULTS = { mode: 'cinema', compactNav: true, margin: 12, height: 100, sidebar: 320 };
  const MODES = ['cinema', 'daily', 'original'];
  const html = document.documentElement;
  const clamp = (n, lo, hi, fallback) => Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : fallback;
  function readSettings() {
    try {
      const raw = typeof GM_getValue === 'function' ? GM_getValue(KEY, null) : localStorage.getItem(KEY);
      const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        mode: MODES.includes(saved?.mode) ? saved.mode : DEFAULTS.mode,
        compactNav: typeof saved?.compactNav === 'boolean' ? saved.compactNav : DEFAULTS.compactNav,
        margin: clamp(saved?.margin ?? 12, 6, 32, 12),
        height: clamp(saved?.height ?? 100, 70, 100, 100),
        sidebar: clamp(saved?.sidebar ?? 320, 240, 420, 320),
      };
    } catch { return { ...DEFAULTS }; }
  }
  let settings = readSettings();
  let binding, host, ui, media, frame = 0, routeTimer = 0, resizeObserver, screenObserver;
  let lastRoute = location.pathname, lastScreen = '', panelOpen = false;
  let suspended = false;

  const style = document.createElement('style');
  style.id = 'biliframe-style';
  style.textContent = `
    html[data-biliframe-active] body { min-width: 0 !important; }
    html[data-biliframe-active] #app { min-width: 0 !important; width: 100% !important; max-width: none !important; }
    html[data-biliframe-active][data-biliframe-nav="hidden"] #biliMainHeader { display: none !important; }
    html[data-biliframe-active] [data-biliframe-root] {
      box-sizing: border-box !important; display: grid !important; position: relative !important;
      grid-template-columns: minmax(0, 1fr) var(--bfr-sidebar) !important;
      column-gap: 20px !important; row-gap: 0 !important; align-items: start !important;
      width: calc(100% - var(--bfr-margin) * 2) !important; min-width: 0 !important;
      max-width: none !important; margin: var(--bfr-margin) auto 24px !important; padding: 0 !important;
    }
    html[data-biliframe-active] [data-biliframe-left] {
      min-width: 0 !important; width: auto !important; max-width: none !important;
      position: static !important; margin: 0 !important; padding: 0 !important; top: auto !important;
    }
    html[data-biliframe-active] [data-biliframe-right] {
      display: block !important; min-width: 0 !important; width: auto !important;
      position: static !important; margin: 0 !important; padding: 0 !important;
    }
    html[data-biliframe-active] [data-biliframe-right] .right-container-inner {
      position: static !important; top: auto !important; width: 100% !important;
    }
    html[data-biliframe-active] [data-biliframe-left] > .video-info-container {
      box-sizing: border-box !important; min-width: 0 !important; width: 100% !important;
      height: auto !important; margin: 0 0 12px !important; padding: 0 !important;
    }
    html[data-biliframe-active] .video-info-container .video-title {
      font-size: 18px !important; line-height: 1.5 !important; margin: 0 !important;
    }
    html[data-biliframe-active][data-biliframe-mode="cinema"] [data-biliframe-left] { display: contents !important; }
    html[data-biliframe-active][data-biliframe-mode="cinema"] [data-biliframe-left] > * {
      grid-column: 1; min-width: 0 !important; max-width: 100% !important;
    }
    html[data-biliframe-active][data-biliframe-mode="cinema"] [data-biliframe-left] > .video-info-container {
      grid-row: 2; margin-top: 14px !important;
    }
    html[data-biliframe-active][data-biliframe-mode="cinema"] [data-biliframe-left] > .video-toolbar-container { grid-row: 3; }
    html[data-biliframe-active][data-biliframe-mode="cinema"] [data-biliframe-right] {
      grid-column: 2; grid-row: 2 / span 5; margin-top: 14px !important;
    }
    html[data-biliframe-active][data-biliframe-mode="daily"] [data-biliframe-left] { display: block !important; grid-column: 1; }
    html[data-biliframe-active][data-biliframe-mode="daily"] [data-biliframe-right] { grid-column: 2; }
    html[data-biliframe-active] [data-biliframe-root] #playerWrap {
      box-sizing: border-box !important; position: relative !important; top: auto !important;
      left: auto !important; right: auto !important; width: 100% !important; min-width: 0 !important;
      max-width: none !important; height: var(--bfr-player-height) !important;
      min-height: 0 !important; padding: 0 !important; margin: 0 !important;
    }
    html[data-biliframe-active][data-biliframe-mode="cinema"] [data-biliframe-root] #playerWrap { grid-column: 1 / -1; grid-row: 1; }
    html[data-biliframe-active] #bilibili-player-placeholder { display: none !important; }
    html[data-biliframe-active] #playerWrap #bilibili-player,
    html[data-biliframe-active] #playerWrap .bpx-docker,
    html[data-biliframe-active] #playerWrap .bpx-player-container {
      width: 100% !important; min-width: 0 !important; max-width: none !important;
      height: 100% !important; max-height: none !important;
    }
    html[data-biliframe-active] #playerWrap #bilibili-player { position: relative !important; box-shadow: none !important; }
    html[data-biliframe-active] #playerWrap .bpx-player-primary-area {
      display: flex !important; flex-direction: column !important; height: 100% !important; min-height: 0 !important;
    }
    html[data-biliframe-active] #playerWrap .bpx-player-video-area {
      width: 100% !important; height: var(--bfr-video-height) !important; min-height: 0 !important;
      flex: 1 1 auto !important; background: #000 !important;
    }
    html[data-biliframe-active] #playerWrap .bpx-player-sending-area { flex: 0 0 auto !important; }
    html[data-biliframe-active] #playerWrap .bpx-player-video-perch,
    html[data-biliframe-active] #playerWrap .bpx-player-video-wrap { width: 100% !important; height: 100% !important; }
    html[data-biliframe-active] #playerWrap .bpx-player-video-wrap > video {
      width: 100% !important; height: 100% !important; max-width: 100% !important;
      max-height: 100% !important; object-fit: contain !important;
    }
    #biliframe-toolbar { display: block; position: sticky; top: 0; z-index: 1001; width: 100%; }
    html[data-biliframe-mode="original"] #biliframe-toolbar { position: fixed; top: auto; bottom: 12px; right: 12px; width: auto; }
    #biliframe-toolbar[hidden], html[data-biliframe-special] #biliframe-toolbar { display: none !important; }
    @media (max-width: 960px) {
      html[data-biliframe-active] [data-biliframe-root] { grid-template-columns: minmax(0, 1fr) !important; }
      html[data-biliframe-active] [data-biliframe-right] { grid-column: 1 !important; grid-row: auto !important; }
      html[data-biliframe-active][data-biliframe-mode="cinema"] [data-biliframe-right] { grid-row: 20 !important; }
    }
  `;
  html.appendChild(style);

  function save() {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(KEY, settings);
      else localStorage.setItem(KEY, JSON.stringify(settings));
    } catch { /* Disabled storage leaves the current page usable. */ }
  }
  function schedule() {
    if (frame || suspended || document.hidden) return;
    frame = requestAnimationFrame(() => { frame = 0; sync(); });
  }
  function setMode(mode) {
    settings.mode = mode;
    save();
    // Apply before measuring: the new grid and header visibility determine available height.
    sync();
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
  function setPanel(open) {
    panelOpen = open;
    if (!ui) return;
    ui.querySelector('.panel').hidden = !open;
    ui.querySelector('[data-action="settings"]').setAttribute('aria-expanded', String(open));
    if (open) ui.querySelector('[name="height"]').focus();
  }
  function createToolbar() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'biliframe-toolbar';
    ui = host.attachShadow({ mode: 'open' });
    ui.innerHTML = `
      <style>
        :host { color-scheme: light; font: 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #303547; }
        * { box-sizing: border-box; } [hidden] { display: none !important; }
        .bar { height: 40px; padding: 0 12px; display: flex; gap: 12px; align-items: center; border-bottom: 1px solid #e9eaf1;
          background: linear-gradient(110deg,#fafbff,#fff7fb 60%,#f3fbff); }
        .brand { font-weight: 750; letter-spacing: .2px; } .hint { color: #7c8395; font-size: 12px; }
        :host([data-original]) .bar { border: 1px solid #e3e5ef; border-radius: 8px; box-shadow: 0 4px 20px #20254515; }
        :host([data-original]) .brand, :host([data-original]) .hint { display: none; }
        :host([data-original]) .panel { top: auto; bottom: 46px; }
        .spacer { flex: 1; } .modes { display: flex; gap: 2px; }
        button { font: inherit; color: inherit; cursor: pointer; border: 0; border-radius: 6px; background: transparent; padding: 4px 9px; white-space: nowrap; }
        button:hover { background: #ececf5; } button[aria-pressed="true"] { color: #584cac; background: #eae7fc; }
        button:focus-visible, input:focus-visible { outline: 2px solid #7d6cc8; outline-offset: 2px; }
        .panel { position: absolute; right: 12px; top: 46px; width: min(330px,calc(100vw - 24px)); padding: 16px;
          background: #fff; border: 1px solid #e3e5ef; border-radius: 12px; box-shadow: 0 12px 40px #20254525; }
        .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-weight: 650; }
        label { display: block; margin: 12px 0; } .line { display: flex; justify-content: space-between; gap: 10px; }
        output { color: #77639f; font-variant-numeric: tabular-nums; } input[type="range"] { display: block; width: 100%; margin-top: 6px; accent-color: #8775cb; }
        .check { display: flex; gap: 8px; align-items: center; } .note { margin: 12px 0 0; color: #767c8e; font-size: 12px; }
        @media (max-width: 620px) { .hint { display: none; } .bar { gap: 4px; padding: 0 6px; } button { padding: 4px 6px; } }
      </style>
      <div class="bar" role="region" aria-label="BiliFrame 视频布局">
        <span class="brand">BiliFrame</span><span class="hint">随窗口自适应</span><span class="spacer"></span>
        <div class="modes" role="group" aria-label="观看布局">
          <button type="button" data-mode="cinema" title="播放器置顶，信息和推荐在下方">沉浸</button>
          <button type="button" data-mode="daily" title="紧凑双栏，保留右侧推荐">日常</button>
          <button type="button" data-mode="original" title="恢复 B 站原生布局">原版</button>
        </div>
        <button type="button" data-action="nav" title="展开或收起 B 站顶部导航">导航</button>
        <button type="button" data-action="settings" aria-expanded="false" aria-controls="panel">设置</button>
      </div>
      <div class="panel" id="panel" role="region" aria-label="布局设置" hidden>
        <div class="head"><span>布局设置</span><button type="button" data-action="close" aria-label="关闭设置">关闭</button></div>
        <label><span class="line"><span>播放器可用高度</span><output data-value="height"></output></span><input name="height" type="range" min="70" max="100" step="1"></label>
        <label><span class="line"><span>页面边距</span><output data-value="margin"></output></span><input name="margin" type="range" min="6" max="32" step="1"></label>
        <label><span class="line"><span>推荐栏宽度</span><output data-value="sidebar"></output></span><input name="sidebar" type="range" min="240" max="420" step="10"></label>
        <label class="check"><input name="compactNav" type="checkbox">收起 B 站顶部导航</label>
        <button type="button" data-action="reset">恢复默认设置</button>
        <p class="note">Option / Alt + L 切换布局。视频保持原比例；评论和推荐可向下滚动访问。</p>
      </div>`;
    ui.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.mode) setMode(button.dataset.mode);
      else if (button.dataset.action === 'settings') setPanel(!panelOpen);
      else if (button.dataset.action === 'close') { setPanel(false); ui.querySelector('[data-action="settings"]').focus(); }
      else if (button.dataset.action === 'nav') { settings.compactNav = !settings.compactNav; save(); sync(); }
      else if (button.dataset.action === 'reset') { settings = { ...DEFAULTS }; save(); sync(); }
    });
    ui.addEventListener('input', event => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      if (input.name === 'compactNav') settings.compactNav = input.checked;
      else if (['height', 'margin', 'sidebar'].includes(input.name)) settings[input.name] = Number(input.value);
      else return;
      save(); sync();
    });
    renderUI();
  }
  function renderUI() {
    if (!ui) return;
    ui.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === settings.mode)));
    ui.querySelector('[data-action="nav"]').setAttribute('aria-pressed', String(!settings.compactNav));
    for (const name of ['height', 'margin', 'sidebar']) {
      ui.querySelector(`[name="${name}"]`).value = settings[name];
      ui.querySelector(`[data-value="${name}"]`).textContent = settings[name] + (name === 'height' ? '%' : ' px');
    }
    ui.querySelector('[name="compactNav"]').checked = settings.compactNav;
  }
  function specialScreen() {
    const screen = binding?.container.getAttribute('data-screen');
    return Boolean(document.fullscreenElement || ['web', 'full', 'fullscreen', 'mini'].includes(screen));
  }
  function detach() {
    resizeObserver?.disconnect(); screenObserver?.disconnect();
    if (media) { media.removeEventListener('loadedmetadata', schedule); media.removeEventListener('emptied', schedule); }
    media = null;
    if (binding) {
      for (const [node, attr] of [[binding.root, 'root'], [binding.left, 'left'], [binding.right, 'right']]) {
        node?.removeAttribute(`data-biliframe-${attr}`);
      }
      for (const name of ['margin', 'sidebar', 'video-height', 'player-height']) binding.root.style.removeProperty(`--bfr-${name}`);
    }
    binding = null;
    html.removeAttribute('data-biliframe-active'); html.removeAttribute('data-biliframe-special');
    if (host) host.hidden = true;
  }
  function discover() {
    const wrap = document.querySelector('#playerWrap');
    const root = wrap?.closest('.video-container-v1');
    const left = wrap?.parentElement;
    const container = wrap?.querySelector('.bpx-player-container');
    if (!root || !container || !left?.matches('.left-container') || left.parentElement !== root) return false;
    const right = [...root.children].find(node => node.matches('.right-container'));
    if (!right) return false;
    const title = left.querySelector('.video-info-container');
    const header = document.getElementById('biliMainHeader');
    if (binding?.wrap === wrap && binding.container === container && binding.root === root && binding.left === left && binding.right === right && binding.title === title && binding.header === header) return true;
    detach();
    binding = { root, left, right, wrap, container, title, header };
    root.setAttribute('data-biliframe-root', ''); left.setAttribute('data-biliframe-left', ''); right.setAttribute('data-biliframe-right', '');
    createToolbar();
    root.parentElement.insertBefore(host, root);
    resizeObserver = new ResizeObserver(schedule);
    for (const node of [root, binding.title, binding.header, host, container.querySelector('.bpx-player-sending-area')]) if (node) resizeObserver.observe(node);
    lastScreen = container.getAttribute('data-screen');
    screenObserver = new MutationObserver(() => {
      const next = container.getAttribute('data-screen');
      if (next !== lastScreen) { lastScreen = next; sync(); }
    });
    screenObserver.observe(container, { attributes: true, attributeFilter: ['data-screen'] });
    return true;
  }
  function variable(name, value) {
    const property = `--bfr-${name}`;
    if (binding.root.style.getPropertyValue(property) !== value) binding.root.style.setProperty(property, value);
  }
  function sync() {
    if (suspended || document.hidden) return;
    if (!/^\/video\//.test(location.pathname) || !discover()) { detach(); return; }
    if (!host.isConnected || host.parentElement !== binding.root.parentElement) binding.root.parentElement.insertBefore(host, binding.root);
    const special = specialScreen();
    html.toggleAttribute('data-biliframe-special', special);
    html.toggleAttribute('data-biliframe-active', settings.mode !== 'original' && !special);
    html.setAttribute('data-biliframe-mode', settings.mode);
    html.setAttribute('data-biliframe-nav', settings.compactNav ? 'hidden' : 'visible');
    host.hidden = special;
    host.toggleAttribute('data-original', settings.mode === 'original');
    renderUI();
    if (settings.mode === 'original' || special) { setPanel(false); return; }
    variable('margin', `${settings.margin}px`); variable('sidebar', `${settings.sidebar}px`);
    const nextMedia = binding.container.querySelector('video');
    if (nextMedia !== media) {
      if (media) { media.removeEventListener('loadedmetadata', schedule); media.removeEventListener('emptied', schedule); }
      media = nextMedia;
      if (media) { media.addEventListener('loadedmetadata', schedule); media.addEventListener('emptied', schedule); }
    }
    const viewportHeight = Math.min(window.innerHeight, window.visualViewport?.height || window.innerHeight);
    const toolbarHeight = host.getBoundingClientRect().height;
    const headerHeight = binding.header?.getBoundingClientRect().height || 0;
    const titleHeight = settings.mode === 'daily' ? (binding.title?.getBoundingClientRect().height || 0) + 12 : 0;
    const sending = binding.container.querySelector('.bpx-player-sending-area');
    const sendingHeight = sending?.getBoundingClientRect().height || 0;
    const width = settings.mode === 'cinema' ? binding.root.getBoundingClientRect().width : binding.left.getBoundingClientRect().width;
    const ratio = media?.videoWidth && media?.videoHeight ? media.videoWidth / media.videoHeight : 16 / 9;
    // A height budget preserves the input bar inside the initial viewport, including browser zoom.
    const budget = Math.max(80, viewportHeight - toolbarHeight - headerHeight - titleHeight - settings.margin * 2 - sendingHeight);
    const videoHeight = Math.max(1, Math.floor(Math.min(width / ratio, budget * settings.height / 100)));
    variable('video-height', `${videoHeight}px`);
    variable('player-height', `${videoHeight + sendingHeight}px`);
  }

  const treeObserver = new MutationObserver(records => {
    if (suspended || document.hidden) return;
    if (!binding || !binding.root.isConnected || !binding.container.isConnected || !host?.isConnected || !binding.right.isConnected) { schedule(); return; }
    // Danmaku and comments change constantly. Only structural player/page changes need discovery.
    for (const record of records) {
      if ([binding.left, binding.wrap, binding.root].includes(record.target)) { schedule(); return; }
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType === 1 && node.matches('video, .bpx-docker, .bpx-player-container, .bpx-player-video-wrap, .bpx-player-sending-area, #biliMainHeader')) { schedule(); return; }
      }
    }
  });
  function startObserving() {
    if (!document.body) return;
    treeObserver.observe(document.body, { childList: true, subtree: true });
    clearInterval(routeTimer);
    routeTimer = setInterval(() => {
      if (lastRoute !== location.pathname) { lastRoute = location.pathname; sync(); }
    }, 1000);
    schedule();
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panelOpen) { setPanel(false); ui?.querySelector('[data-action="settings"]').focus(); return; }
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== 'KeyL' || event.repeat || event.isComposing) return;
    if (!binding || specialScreen()) return;
    if (event.composedPath().some(node => node instanceof Element && (node.matches('input, textarea, select') || node.isContentEditable))) return;
    event.preventDefault(); setMode(MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length]);
  });
  document.addEventListener('pointerdown', event => { if (panelOpen && !event.composedPath().includes(host)) setPanel(false); });
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  document.addEventListener('fullscreenchange', () => sync());
  window.addEventListener('popstate', () => sync());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearInterval(routeTimer); routeTimer = 0; }
    else { startObserving(); sync(); }
  });
  window.addEventListener('pagehide', () => {
    suspended = true; clearInterval(routeTimer); cancelAnimationFrame(frame); frame = 0; treeObserver.disconnect(); detach();
  });
  window.addEventListener('pageshow', () => { suspended = false; startObserving(); });
  if (typeof GM_registerMenuCommand === 'function') {
    for (const [mode, name] of [['cinema', '沉浸布局'], ['daily', '日常双栏'], ['original', '恢复原版']]) GM_registerMenuCommand(`BiliFrame：${name}`, () => setMode(mode));
    GM_registerMenuCommand('BiliFrame：布局设置', () => { sync(); setPanel(true); });
  }
  if (document.body) startObserving();
  else document.addEventListener('DOMContentLoaded', startObserving, { once: true });
})();
