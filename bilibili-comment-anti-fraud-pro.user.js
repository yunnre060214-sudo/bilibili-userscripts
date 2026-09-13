// ==UserScript==
// @name         哔哩发评反诈 Pro
// @namespace    https://chatgpt.com/user-scripts/bili-comment-anti-fraud-Pro
// @version      4.2.3
// @updateURL    https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-comment-anti-fraud-pro.user.js
// @downloadURL  https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-comment-anti-fraud-pro.user.js
// @description  B站评论发送后自动检查无账号可见性：正常、疑似仅自己可见、疑似秒删、可疑状态。风控响应会自动降级，不误判评论状态。支持设置、取消队列、透明报告和无限次重新检测。无 AI、无 API Key。
// @author       素晴
// @match        https://*.bilibili.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      api.bilibili.com
// @license      GPL-3.0
// ==/UserScript==

(() => {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  if (W.__BFC_LITE_INSTALLED__) return;
  Object.defineProperty(W, '__BFC_LITE_INSTALLED__', {
    value: true,
    configurable: false,
    writable: false,
  });

  const CONFIG = Object.freeze({
    mainSortByTime: 2,
    replySortByTime: 0,
    recentDedupMs: 30000,
    logPrefix: '[发评反诈 Pro]',
  });

  const RISK_CONTROL_CODES = new Set([-509, -412, -352]);
  const RISK_CONTROL_RETRY_DELAY_MS = 1800;

  const SETTINGS_KEY = 'bfc-pro-settings-v42';
  const DEFAULT_SETTINGS = Object.freeze({
    waitAfterPostMs: 6500,
    requestTimeoutMs: 10000,
    maxReplyPages: 18,
    pageDelayMs: 160,
    retryCheckDelaysText: '20000,45000',
    recheckCooldownMs: 30000,
    autoRetry: true,
    verboseLog: false,
  });

  const STATE = {
    originalFetch: null,
    originalXhrOpen: null,
    originalXhrSend: null,
    running: false,
    queue: [],
    recentRpid: new Map(),
    uiReady: false,
    lastReport: '',
    lastReply: null,
    cancelVersion: 0,
    activeToken: null,
    diagnostics: null,
    riskControlRecheckAt: new Map(),
  };

  let SETTINGS = loadSettings();

  function log(...args) {
    if (!SETTINGS.verboseLog) return;
    console.log(CONFIG.logPrefix, ...args);
  }

  function warn(...args) {
    console.warn(CONFIG.logPrefix, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  function parseRetryCheckDelaysMs(text) {
    return String(text || '')
      .split(',')
      .map((part) => clampNumber(part.trim(), 0, 0, 300000))
      .filter((value) => value > 0)
      .slice(0, 4);
  }

  function normalizeSettings(raw = {}) {
    const retryCheckDelaysText = typeof raw.retryCheckDelaysText === 'string'
      ? raw.retryCheckDelaysText
      : DEFAULT_SETTINGS.retryCheckDelaysText;

    return {
      waitAfterPostMs: clampNumber(raw.waitAfterPostMs, DEFAULT_SETTINGS.waitAfterPostMs, 1000, 120000),
      requestTimeoutMs: clampNumber(raw.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 3000, 60000),
      maxReplyPages: clampNumber(raw.maxReplyPages, DEFAULT_SETTINGS.maxReplyPages, 1, 80),
      pageDelayMs: clampNumber(raw.pageDelayMs, DEFAULT_SETTINGS.pageDelayMs, 0, 3000),
      retryCheckDelaysText,
      recheckCooldownMs: clampNumber(raw.recheckCooldownMs, DEFAULT_SETTINGS.recheckCooldownMs, 5000, 120000),
      autoRetry: raw.autoRetry !== false,
      verboseLog: raw.verboseLog === true,
    };
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return normalizeSettings(raw ? safeJsonParse(raw) || {} : {});
    } catch {
      return normalizeSettings({});
    }
  }

  function saveSettings(nextSettings = SETTINGS) {
    SETTINGS = normalizeSettings(nextSettings);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS));
    } catch {
      // Ignore storage failures; the current page session still uses SETTINGS.
    }
    return SETTINGS;
  }

  function getRetryCheckDelaysMs() {
    if (!SETTINGS.autoRetry) return [];
    return parseRetryCheckDelaysMs(SETTINGS.retryCheckDelaysText);
  }

  function createDiagnostics() {
    return {
      startedAt: now(),
      finishedAt: 0,
      requestAttempts: [],
      retries: 0,
      buvidFallbackUsed: false,
      pureAnonymousSucceeded: false,
      loginRequests: 0,
      finalKind: '',
      cancelled: false,
    };
  }

  function recordRequestAttempt(entry) {
    if (!STATE.diagnostics) return;
    STATE.diagnostics.requestAttempts.push({
      at: new Date().toLocaleTimeString(),
      ...entry,
    });
  }

  function createCancelToken() {
    return { version: STATE.cancelVersion };
  }

  function isCancelledError(error) {
    return error && error.name === 'BfcCancelledError';
  }

  function checkCancelled(token) {
    if (token && token.version !== STATE.cancelVersion) {
      const error = new Error('检测已取消');
      error.name = 'BfcCancelledError';
      throw error;
    }
  }

  async function sleepWithCancel(ms, token) {
    const endAt = now() + Math.max(0, Number(ms) || 0);
    while (now() < endAt) {
      checkCancelled(token);
      await sleep(Math.min(250, endAt - now()));
    }
    checkCancelled(token);
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function stringifyForUser(value) {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function normalizeUrl(input) {
    if (!input) return '';
    try {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
      if (typeof input.url === 'string') return input.url;
      return String(input);
    } catch {
      return '';
    }
  }

  function toAbsoluteUrl(url) {
    try {
      return new URL(url, location.origin).href;
    } catch {
      return url || '';
    }
  }

  function isAddCommentEndpoint(url) {
    const absolute = toAbsoluteUrl(url);
    try {
      const u = new URL(absolute);
      return u.hostname === 'api.bilibili.com' && u.pathname === '/x/v2/reply/add';
    } catch {
      return String(absolute).includes('api.bilibili.com/x/v2/reply/add') || String(url).startsWith('//api.bilibili.com/x/v2/reply/add');
    }
  }

  function compactText(text, max = 800) {
    const s = String(text || '').trim();
    if (s.length <= max) return s;
    return `${s.slice(0, max)}……`;
  }

  function getCommentText(reply) {
    return compactText(reply?.content?.message || '');
  }

  function getBuvid3Cookie() {
    const match = document.cookie.match(/(?:^|;\s*)buvid3=([^;]+)/);
    return match ? `buvid3=${match[1]}` : '';
  }

  function now() {
    return Date.now();
  }

  function isDuplicateRpid(rpid) {
    if (!rpid) return false;
    const key = String(rpid);
    const previous = STATE.recentRpid.get(key) || 0;
    STATE.recentRpid.set(key, now());

    for (const [storedKey, ts] of STATE.recentRpid.entries()) {
      if (now() - ts > CONFIG.recentDedupMs) STATE.recentRpid.delete(storedKey);
    }

    return previous && now() - previous < CONFIG.recentDedupMs;
  }

  function setRiskControlCooldown(reply) {
    if (!reply?.rpid) return;
    STATE.riskControlRecheckAt.set(String(reply.rpid), now() + SETTINGS.recheckCooldownMs);
  }

  function getRiskControlCooldownRemaining(reply) {
    if (!reply?.rpid) return 0;
    const key = String(reply.rpid);
    const remaining = (STATE.riskControlRecheckAt.get(key) || 0) - now();
    if (remaining <= 0) {
      STATE.riskControlRecheckAt.delete(key);
      return 0;
    }
    return remaining;
  }

  function createElement(tagName, options = {}) {
    const node = document.createElement(tagName);
    const { id, className, text, title, type, hidden, attrs = {}, children = [] } = options;

    if (id) node.id = id;
    if (className) node.className = className;
    if (typeof text === 'string') node.textContent = text;
    if (title) node.title = title;
    if (type) node.type = type;
    if (hidden) node.hidden = true;

    for (const [name, value] of Object.entries(attrs)) {
      node.setAttribute(name, value);
    }

    for (const child of children) {
      if (child) node.appendChild(child);
    }

    return node;
  }

  function createSettingsField(labelText, inputId, attrs) {
    return createElement('label', {
      className: 'bfc-lite-field',
      children: [
        createElement('span', { text: labelText }),
        createElement('input', { id: inputId, attrs }),
      ],
    });
  }

  function createSettingsPanel() {
    return createElement('div', {
      id: 'bfc-lite-settings-panel',
      className: 'bfc-lite-settings-panel',
      hidden: true,
      children: [
        createElement('div', {
          className: 'bfc-lite-settings-grid',
          children: [
            createSettingsField('首次等待（秒）', 'bfc-lite-setting-wait', { type: 'number', min: '1', max: '120', step: '1' }),
            createSettingsField('请求超时（秒）', 'bfc-lite-setting-timeout', { type: 'number', min: '3', max: '60', step: '1' }),
            createSettingsField('楼中楼页数', 'bfc-lite-setting-pages', { type: 'number', min: '1', max: '80', step: '1' }),
            createSettingsField('翻页间隔（毫秒）', 'bfc-lite-setting-page-delay', { type: 'number', min: '0', max: '3000', step: '20' }),
            createSettingsField('复检延迟（毫秒，逗号分隔）', 'bfc-lite-setting-retries', { type: 'text' }),
          ],
        }),
        createElement('div', {
          className: 'bfc-lite-checks',
          children: [
            createElement('label', {
              children: [
                createElement('input', { id: 'bfc-lite-setting-auto-retry', attrs: { type: 'checkbox' } }),
                createElement('span', { text: '自动延迟复检' }),
              ],
            }),
            createElement('label', {
              children: [
                createElement('input', { id: 'bfc-lite-setting-verbose', attrs: { type: 'checkbox' } }),
                createElement('span', { text: '详细控制台日志' }),
              ],
            }),
          ],
        }),
        createElement('div', {
          className: 'bfc-lite-settings-actions',
          children: [
            createElement('button', {
              id: 'bfc-lite-settings-reset',
              className: 'bfc-lite-btn',
              type: 'button',
              text: '恢复默认',
            }),
            createElement('button', {
              id: 'bfc-lite-settings-save',
              className: 'bfc-lite-btn bfc-lite-btn-secondary',
              type: 'button',
              text: '保存设置',
            }),
          ],
        }),
      ],
    });
  }

  function setInputValue(id, value) {
    const node = document.getElementById(id);
    if (node) node.value = String(value);
  }

  function setInputChecked(id, checked) {
    const node = document.getElementById(id);
    if (node) node.checked = Boolean(checked);
  }

  function populateSettingsPanel(settings = SETTINGS) {
    setInputValue('bfc-lite-setting-wait', Math.round(settings.waitAfterPostMs / 1000));
    setInputValue('bfc-lite-setting-timeout', Math.round(settings.requestTimeoutMs / 1000));
    setInputValue('bfc-lite-setting-pages', settings.maxReplyPages);
    setInputValue('bfc-lite-setting-page-delay', settings.pageDelayMs);
    setInputValue('bfc-lite-setting-retries', settings.retryCheckDelaysText);
    setInputChecked('bfc-lite-setting-auto-retry', settings.autoRetry);
    setInputChecked('bfc-lite-setting-verbose', settings.verboseLog);
  }

  function readSettingsFromPanel() {
    const valueOf = (id) => document.getElementById(id)?.value;
    const checkedOf = (id) => Boolean(document.getElementById(id)?.checked);

    return normalizeSettings({
      waitAfterPostMs: Number(valueOf('bfc-lite-setting-wait')) * 1000,
      requestTimeoutMs: Number(valueOf('bfc-lite-setting-timeout')) * 1000,
      maxReplyPages: valueOf('bfc-lite-setting-pages'),
      pageDelayMs: valueOf('bfc-lite-setting-page-delay'),
      retryCheckDelaysText: valueOf('bfc-lite-setting-retries'),
      autoRetry: checkedOf('bfc-lite-setting-auto-retry'),
      verboseLog: checkedOf('bfc-lite-setting-verbose'),
    });
  }

  async function saveSettingsFromPanel() {
    saveSettings(readSettingsFromPanel());
    populateSettingsPanel();
    await UI.status('设置已保存，下一次检测会使用新参数。');
  }

  async function resetSettingsPanel() {
    saveSettings(DEFAULT_SETTINGS);
    populateSettingsPanel();
    await UI.status('设置已恢复默认。');
  }

  function toggleSettingsPanel() {
    const panel = document.getElementById('bfc-lite-settings-panel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) populateSettingsPanel();
  }

  function ensureUi() {
    if (STATE.uiReady) return Promise.resolve();

    return new Promise((resolve) => {
      const mount = () => {
        if (STATE.uiReady) {
          resolve();
          return;
        }

        if (!document.documentElement) {
          requestAnimationFrame(mount);
          return;
        }

        const style = document.createElement('style');
        style.id = 'bfc-lite-style';
        style.textContent = `
          #bfc-lite-shell {
            position: fixed;
            inset: auto 22px 22px auto;
            width: min(460px, calc(100vw - 28px));
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
            color: #18191c;
          }

          #bfc-lite-card {
            display: none;
            overflow: hidden;
            border: 1px solid rgba(143, 148, 157, 0.24);
            border-radius: 16px;
            background: rgba(255, 255, 255, 0.98);
            box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
            backdrop-filter: blur(20px);
          }

          .bfc-lite-head {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 15px 16px 13px;
            background: linear-gradient(135deg, rgba(251, 114, 153, 0.14), rgba(0, 174, 236, 0.12));
            border-bottom: 1px solid rgba(143, 148, 157, 0.18);
          }

          .bfc-lite-dot {
            width: 10px;
            height: 10px;
            border-radius: 999px;
            background: #fb7299;
            box-shadow: 0 0 0 6px rgba(251, 114, 153, 0.14);
            flex: 0 0 auto;
          }

          .bfc-lite-title {
            flex: 1;
            min-width: 0;
            font-size: 15px;
            font-weight: 750;
            line-height: 1.4;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .bfc-lite-close {
            border: 0;
            background: transparent;
            color: #61666d;
            cursor: pointer;
            font-size: 18px;
            line-height: 1;
            width: 30px;
            height: 30px;
            border-radius: 8px;
          }

          .bfc-lite-close:hover {
            background: rgba(0, 0, 0, 0.06);
          }

          .bfc-lite-body {
            padding: 15px 16px 16px;
          }

          .bfc-lite-status {
            font-size: 14px;
            line-height: 1.65;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 210px;
            overflow: auto;
          }

          .bfc-lite-comment {
            margin-top: 11px;
            padding: 10px 12px;
            border-radius: 12px;
            background: #f6f7f8;
            border: 1px solid rgba(143, 148, 157, 0.14);
            color: #18191c;
            font-size: 13px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 130px;
            overflow: auto;
          }

          .bfc-lite-steps {
            margin-top: 10px;
            padding: 10px 11px;
            border-radius: 12px;
            background: rgba(0, 174, 236, 0.08);
            border: 1px solid rgba(0, 174, 236, 0.12);
            color: #4e5969;
            font-size: 12px;
            line-height: 1.55;
            max-height: 116px;
            overflow: auto;
            white-space: pre-wrap;
          }

          .bfc-lite-settings-panel {
            margin-top: 10px;
            padding: 11px;
            border: 1px solid rgba(143, 148, 157, 0.18);
            border-radius: 12px;
            background: #fafbfc;
          }

          .bfc-lite-settings-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 9px;
          }

          .bfc-lite-field {
            display: grid;
            gap: 5px;
            min-width: 0;
            color: #4e5969;
            font-size: 12px;
            line-height: 1.35;
          }

          .bfc-lite-field input {
            width: 100%;
            box-sizing: border-box;
            border: 1px solid rgba(143, 148, 157, 0.28);
            border-radius: 9px;
            background: #fff;
            color: #18191c;
            font: inherit;
            min-height: 30px;
            padding: 5px 8px;
            outline: none;
          }

          .bfc-lite-field input:focus {
            border-color: rgba(0, 174, 236, 0.62);
            box-shadow: 0 0 0 3px rgba(0, 174, 236, 0.12);
          }

          .bfc-lite-checks {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 10px;
            color: #4e5969;
            font-size: 12px;
          }

          .bfc-lite-checks label {
            display: inline-flex;
            align-items: center;
            gap: 5px;
          }

          .bfc-lite-settings-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 10px;
          }

          .bfc-lite-bar-wrap {
            height: 5px;
            margin: 14px 0 10px;
            overflow: hidden;
            border-radius: 999px;
            background: #eceff3;
          }

          .bfc-lite-bar {
            width: 0;
            height: 100%;
            border-radius: 999px;
            background: linear-gradient(90deg, #fb7299, #00aeec);
            transition: width 180ms ease;
          }

          .bfc-lite-bar.bfc-lite-indeterminate {
            width: 38%;
            animation: bfc-lite-slide 1.08s ease-in-out infinite;
          }

          @keyframes bfc-lite-slide {
            0% { transform: translateX(-120%); }
            100% { transform: translateX(330%); }
          }

          .bfc-lite-actions {
            display: flex;
            flex-wrap: wrap;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 13px;
          }

          .bfc-lite-btn {
            border: 1px solid rgba(251, 114, 153, 0.36);
            background: #fff;
            color: #fb7299;
            border-radius: 10px;
            min-height: 32px;
            padding: 7px 11px;
            font-size: 12px;
            font-weight: 650;
            cursor: pointer;
          }

          .bfc-lite-btn[disabled] {
            cursor: not-allowed;
            opacity: 0.52;
          }

          .bfc-lite-btn:hover {
            background: rgba(251, 114, 153, 0.08);
          }

          .bfc-lite-btn-primary {
            background: #fb7299;
            color: #fff;
          }

          .bfc-lite-btn-primary:hover {
            background: #f85f8f;
          }

          .bfc-lite-btn-secondary {
            border-color: rgba(0, 174, 236, 0.34);
            color: #008ac5;
          }

          .bfc-lite-btn-secondary:hover {
            background: rgba(0, 174, 236, 0.08);
          }

          .bfc-lite-btn-danger {
            border-color: rgba(255, 77, 79, 0.36);
            color: #d9363e;
          }

          .bfc-lite-btn-danger:hover {
            background: rgba(255, 77, 79, 0.08);
          }

          #bfc-lite-card[data-tone="ok"] .bfc-lite-dot { background: #00b578; box-shadow: 0 0 0 6px rgba(0, 181, 120, 0.14); }
          #bfc-lite-card[data-tone="warn"] .bfc-lite-dot { background: #ff9f18; box-shadow: 0 0 0 6px rgba(255, 159, 24, 0.16); }
          #bfc-lite-card[data-tone="bad"] .bfc-lite-dot { background: #ff4d4f; box-shadow: 0 0 0 6px rgba(255, 77, 79, 0.14); }
          #bfc-lite-card[data-tone="info"] .bfc-lite-dot { background: #00aeec; box-shadow: 0 0 0 6px rgba(0, 174, 236, 0.14); }
        `;

        const shell = createElement('div', { id: 'bfc-lite-shell' });
        const card = createElement('div', { id: 'bfc-lite-card', attrs: { 'data-tone': 'info' } });
        const title = createElement('div', {
          id: 'bfc-lite-title',
          className: 'bfc-lite-title',
          text: '发评反诈检测',
        });
        const closeButton = createElement('button', {
          id: 'bfc-lite-close',
          className: 'bfc-lite-close',
          type: 'button',
          title: '关闭',
          text: '×',
        });
        const head = createElement('div', {
          className: 'bfc-lite-head',
          children: [
            createElement('div', { className: 'bfc-lite-dot' }),
            title,
            closeButton,
          ],
        });
        const status = createElement('div', { id: 'bfc-lite-status', className: 'bfc-lite-status' });
        const comment = createElement('div', { id: 'bfc-lite-comment', className: 'bfc-lite-comment', hidden: true });
        const bar = createElement('div', { id: 'bfc-lite-bar', className: 'bfc-lite-bar' });
        const barWrap = createElement('div', { className: 'bfc-lite-bar-wrap', children: [bar] });
        const steps = createElement('div', { id: 'bfc-lite-steps', className: 'bfc-lite-steps', hidden: true });
        const settingsPanel = createSettingsPanel();
        const settingsButton = createElement('button', {
          id: 'bfc-lite-settings',
          className: 'bfc-lite-btn',
          type: 'button',
          text: '设置',
        });
        const cancelButton = createElement('button', {
          id: 'bfc-lite-cancel',
          className: 'bfc-lite-btn bfc-lite-btn-danger',
          type: 'button',
          text: '取消',
          hidden: true,
        });
        const copyButton = createElement('button', {
          id: 'bfc-lite-copy',
          className: 'bfc-lite-btn',
          type: 'button',
          text: '复制报告',
        });
        const recheckButton = createElement('button', {
          id: 'bfc-lite-recheck',
          className: 'bfc-lite-btn bfc-lite-btn-secondary',
          type: 'button',
          text: '重新检测',
          hidden: true,
        });
        const okButton = createElement('button', {
          id: 'bfc-lite-ok',
          className: 'bfc-lite-btn bfc-lite-btn-primary',
          type: 'button',
          text: '知道了',
        });
        const actions = createElement('div', {
          className: 'bfc-lite-actions',
          children: [settingsButton, cancelButton, recheckButton, copyButton, okButton],
        });
        const body = createElement('div', {
          className: 'bfc-lite-body',
          children: [status, comment, barWrap, steps, settingsPanel, actions],
        });

        card.appendChild(head);
        card.appendChild(body);
        shell.appendChild(card);

        const parent = document.body || document.documentElement;
        parent.appendChild(style);
        parent.appendChild(shell);

        document.getElementById('bfc-lite-close').addEventListener('click', UI.close);
        document.getElementById('bfc-lite-ok').addEventListener('click', UI.close);
        document.getElementById('bfc-lite-copy').addEventListener('click', () => copyText(STATE.lastReport || ''));
        document.getElementById('bfc-lite-recheck').addEventListener('click', recheckLastReply);
        document.getElementById('bfc-lite-settings').addEventListener('click', toggleSettingsPanel);
        document.getElementById('bfc-lite-cancel').addEventListener('click', cancelCurrentAndClearQueue);
        document.getElementById('bfc-lite-settings-save').addEventListener('click', saveSettingsFromPanel);
        document.getElementById('bfc-lite-settings-reset').addEventListener('click', resetSettingsPanel);
        populateSettingsPanel();

        STATE.uiReady = true;
        resolve();
      };

      if (document.body || document.documentElement) mount();
      else document.addEventListener('DOMContentLoaded', mount, { once: true });
    });
  }

  const UI = {
    async open({ title = '发评反诈检测', status = '', comment = '', tone = 'info', progress = 0, steps = '' } = {}) {
      await ensureUi();
      const card = document.getElementById('bfc-lite-card');
      const commentNode = document.getElementById('bfc-lite-comment');
      const stepsNode = document.getElementById('bfc-lite-steps');
      document.getElementById('bfc-lite-title').textContent = title;
      document.getElementById('bfc-lite-status').textContent = status;
      commentNode.textContent = comment;
      commentNode.hidden = !comment;
      stepsNode.textContent = steps;
      stepsNode.hidden = !steps;
      card.dataset.tone = tone;
      card.style.display = 'block';
      updateActionButtons();
      UI.progress(progress);
    },

    close() {
      const card = document.getElementById('bfc-lite-card');
      if (card) card.style.display = 'none';
    },

    async status(text, { title, tone, comment, steps } = {}) {
      await ensureUi();
      const card = document.getElementById('bfc-lite-card');
      if (title) document.getElementById('bfc-lite-title').textContent = title;
      if (tone) card.dataset.tone = tone;
      if (typeof text === 'string') document.getElementById('bfc-lite-status').textContent = text;
      if (typeof comment === 'string') {
        const node = document.getElementById('bfc-lite-comment');
        node.textContent = comment;
        node.hidden = !comment;
      }
      if (typeof steps === 'string') {
        const node = document.getElementById('bfc-lite-steps');
        node.textContent = steps;
        node.hidden = !steps;
      }
    },

    setRecheckState({ visible = true, disabled = false, label = '重新检测' } = {}) {
      const button = document.getElementById('bfc-lite-recheck');
      if (!button) return;
      button.hidden = !visible;
      button.disabled = disabled;
      button.textContent = label;
    },

    setCancelState({ visible = false, disabled = false, label = '取消检测' } = {}) {
      const button = document.getElementById('bfc-lite-cancel');
      if (!button) return;
      button.hidden = !visible;
      button.disabled = disabled;
      button.textContent = label;
    },

    progress(value) {
      const bar = document.getElementById('bfc-lite-bar');
      if (!bar) return;
      bar.classList.remove('bfc-lite-indeterminate');
      bar.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
    },

    indeterminate(on = true) {
      const bar = document.getElementById('bfc-lite-bar');
      if (!bar) return;
      if (on) bar.classList.add('bfc-lite-indeterminate');
      else bar.classList.remove('bfc-lite-indeterminate');
    },
  };

  function updateActionButtons() {
    const queueLength = STATE.queue.length;
    const hasLastReply = Boolean(STATE.lastReply);
    const busy = STATE.running || queueLength > 0;

    UI.setCancelState({
      visible: busy,
      disabled: !busy,
      label: queueLength > 0 ? `取消(${queueLength})` : '取消检测',
    });

    UI.setRecheckState({
      visible: hasLastReply,
      disabled: STATE.running,
      label: STATE.running ? '检测中' : '重新检测',
    });
  }

  async function copyText(text) {
    if (!text) return;

    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
        await UI.status('报告已复制。');
        return;
      }
    } catch {
      // fallback below
    }

    try {
      await navigator.clipboard.writeText(text);
      await UI.status('报告已复制。');
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      await UI.status('报告已复制。');
    }
  }

  async function waitBeforeCheck(comment, token) {
    const waitAfterPostMs = SETTINGS.waitAfterPostMs;
    await UI.open({
      title: '发评反诈检测中',
      status: `评论已发送，等待 ${Math.round(waitAfterPostMs / 1000)} 秒后检查公开可见性。`,
      comment,
      tone: 'info',
      progress: 0,
    });

    const start = now();
    while (now() - start < waitAfterPostMs) {
      checkCancelled(token);
      const elapsed = now() - start;
      UI.progress((elapsed / waitAfterPostMs) * 100);
      await sleepWithCancel(120, token);
    }
    UI.progress(100);
    await UI.status('等待结束，开始交叉检测。');
    UI.indeterminate(true);
  }

  function canUseGmXhr() {
    return (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') || typeof GM_xmlhttpRequest === 'function';
  }

  function gmRequestText(url, { anonymous = true, includeBuvidCookie = false } = {}) {
    return new Promise((resolve, reject) => {
      const fn = typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function'
        ? GM.xmlHttpRequest
        : typeof GM_xmlhttpRequest === 'function'
          ? GM_xmlhttpRequest
          : null;

      if (!fn) {
        reject(new Error('GM.xmlHttpRequest 不可用'));
        return;
      }

      const headers = {
        Accept: 'application/json, text/plain, */*',
      };

      const buvid3 = getBuvid3Cookie();
      if (includeBuvidCookie && buvid3) headers.Cookie = buvid3;

      let settled = false;
      const settleResolve = (res) => {
        if (settled) return;
        settled = true;
        const status = Number(res.status || 0);
        if (status >= 200 && status < 300) resolve(res.responseText || '');
        else reject(new Error(`HTTP ${status}: ${res.responseText || ''}`));
      };
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(stringifyForUser(error)));
      };

      try {
        const ret = fn({
          method: 'GET',
          url,
          headers,
          anonymous,
          timeout: SETTINGS.requestTimeoutMs,
          onload: settleResolve,
          onerror: settleReject,
          ontimeout: () => settleReject(new Error('请求超时')),
        });

        if (ret && typeof ret.then === 'function') {
          ret.then(settleResolve).catch(settleReject);
        }
      } catch (error) {
        settleReject(error);
      }
    });
  }

  async function fetchRequestText(url, { login = false } = {}) {
    if (!STATE.originalFetch) throw new Error('原生 fetch 不可用');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SETTINGS.requestTimeoutMs);

    try {
      const response = await STATE.originalFetch.call(W, url, {
        method: 'GET',
        credentials: login ? 'include' : 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
        },
      });

      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestJsonByFetch(url, { login = false } = {}) {
    const text = await fetchRequestText(url, { login });
    const json = safeJsonParse(text);
    if (!json) throw new Error(`JSON 解析失败：${compactText(text, 300)}`);

    const riskControlled = isRiskControlResponse(json);
    recordRequestAttempt({
      mode: login ? '页面 fetch 登录态' : '页面 fetch 游客',
      login,
      ok: !riskControlled,
      riskControlled,
      url,
      error: riskControlled ? `B站风控 code ${json.code}` : undefined,
    });
    if (login && STATE.diagnostics) STATE.diagnostics.loginRequests += 1;
    return json;
  }

  async function requestJsonByGm(url) {
    const text = await gmRequestText(url, { anonymous: true, includeBuvidCookie: false });
    const json = safeJsonParse(text);
    if (!json) throw new Error(`JSON 解析失败：${compactText(text, 300)}`);

    const riskControlled = isRiskControlResponse(json);
    recordRequestAttempt({
      mode: 'GM 匿名回退',
      login: false,
      ok: !riskControlled,
      riskControlled,
      url,
      error: riskControlled ? `B站风控 code ${json.code}` : undefined,
    });
    if (!riskControlled && STATE.diagnostics) STATE.diagnostics.pureAnonymousSucceeded = true;
    return json;
  }

  async function requestJson(url, { login = false, token } = {}) {
    checkCancelled(token);
    const errors = [];
    let riskControlResponse = null;

    try {
      const json = await requestJsonByFetch(url, { login });
      checkCancelled(token);
      if (!isRiskControlResponse(json)) return json;
      riskControlResponse = json;
    } catch (error) {
      checkCancelled(token);
      if (isCancelledError(error)) throw error;
      recordRequestAttempt({ mode: login ? '页面 fetch 登录态' : '页面 fetch 游客', login, ok: false, url, error: error.message });
      errors.push(`页面 fetch ${login ? '登录' : '游客'}请求失败：${error.message}`);
    }

    checkCancelled(token);
    if (!login && canUseGmXhr()) {
      if (riskControlResponse) {
        await sleepWithCancel(RISK_CONTROL_RETRY_DELAY_MS, token);
      }

      try {
        checkCancelled(token);
        const json = await requestJsonByGm(url);
        checkCancelled(token);
        if (!isRiskControlResponse(json)) return json;
        riskControlResponse = json;
      } catch (error) {
        checkCancelled(token);
        if (isCancelledError(error)) throw error;
        recordRequestAttempt({ mode: 'GM 匿名回退', login: false, ok: false, url, error: error.message });
        errors.push(`GM 匿名回退请求失败：${error.message}`);
      }
    }

    if (riskControlResponse) return riskControlResponse;
    throw new Error(errors.join('\n'));
  }

  function buildUrl(path, params) {
    const url = new URL(`https://api.bilibili.com${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    return url.href;
  }

  async function getMainCommentList(oid, type, next = 0, login = false, seekRpid = '', token) {
    const url = buildUrl('/x/v2/reply/main', {
      oid,
      type,
      next,
      mode: CONFIG.mainSortByTime,
      seek_rpid: seekRpid,
    });
    const resp = await requestJson(url, { login, token });
    log('主评论列表', { login, next, resp });
    return resp;
  }

  async function getChildCommentList(oid, type, root, pn = 0, login = false, token) {
    const url = buildUrl('/x/v2/reply/reply', {
      oid,
      type,
      root,
      pn,
      sort: CONFIG.replySortByTime,
    });
    const resp = await requestJson(url, { login, token });
    log('回复列表', { login, pn, root, resp });
    return resp;
  }

  function findReply(replies, rpid) {
    if (!Array.isArray(replies)) return null;
    const target = String(rpid);

    for (const item of replies) {
      if (!item) continue;
      if (String(item.rpid) === target) return item;

      const children = item.replies;
      if (Array.isArray(children)) {
        const hit = findReply(children, rpid);
        if (hit) return hit;
      }
    }

    return null;
  }

  function getReplies(resp) {
    if (!resp || resp.code !== 0 || !resp.data) return null;
    return Array.isArray(resp.data.replies) ? resp.data.replies : [];
  }

  function isDeletedCode(resp) {
    return resp && Number(resp.code) === 12022;
  }

  function isRiskControlResponse(resp) {
    return Boolean(resp && RISK_CONTROL_CODES.has(Number(resp.code)));
  }

  function isSuccess(resp) {
    return resp && Number(resp.code) === 0;
  }

  function makeReport({ title, status, comment, steps, extra = '' }) {
    const parts = [
      `【${title}】`,
      status,
      comment ? `\n【评论原文】\n${comment}` : '',
      steps ? `\n【检测路径】\n${steps}` : '',
      extra ? `\n【补充】\n${extra}` : '',
      `\n时间：${new Date().toLocaleString()}`,
    ];
    return parts.filter(Boolean).join('\n');
  }

  function makeDiagnosticsSummary() {
    const diagnostics = STATE.diagnostics;
    if (!diagnostics) return '';

    const finishedAt = diagnostics.finishedAt || now();
    const totalSeconds = Math.max(0, ((finishedAt - diagnostics.startedAt) / 1000).toFixed(1));
    const requestCount = diagnostics.requestAttempts.length;
    const failedCount = diagnostics.requestAttempts.filter((item) => !item.ok).length;
    const modes = Array.from(new Set(diagnostics.requestAttempts.map((item) => item.mode))).join('、') || '无';

    return [
      `检测耗时：${totalSeconds} 秒`,
      `请求尝试：${requestCount} 次，失败 ${failedCount} 次`,
      `请求方式：${modes}`,
      `纯匿名命中：${diagnostics.pureAnonymousSucceeded ? '是' : '否'}`,
      `buvid3 辅助回退：${diagnostics.buvidFallbackUsed ? '是' : '否'}`,
      `登录态请求：${diagnostics.loginRequests} 次`,
      `延迟复检：${diagnostics.retries} 次`,
      `自动复检：${SETTINGS.autoRetry ? '开启' : '关闭'}`,
      `设置：首次等待 ${Math.round(SETTINGS.waitAfterPostMs / 1000)} 秒，楼中楼最多 ${SETTINGS.maxReplyPages} 页`,
    ].join('\n');
  }

  async function showFinal({ title, status, comment, steps, tone, progress = 100, extra = '' }) {
    UI.indeterminate(false);
    UI.progress(progress);
    const diagnosticsSummary = makeDiagnosticsSummary();
    const fullExtra = [extra, diagnosticsSummary ? `【检测依据】\n${diagnosticsSummary}` : ''].filter(Boolean).join('\n\n');
    STATE.lastReport = makeReport({ title, status, comment, steps, extra: fullExtra });
    await UI.status(status, { title, tone, comment, steps });
    updateActionButtons();
  }

  async function showError(error, comment, steps = '') {
    const message = error instanceof Error ? error.message : stringifyForUser(error);
    await showFinal({
      title: '检测发生错误',
      status: `检测没有完成。\n\n${message}`,
      comment,
      steps,
      tone: 'bad',
      progress: 0,
      extra: '通常是 B 站接口变化、网络问题、风控响应或浏览器扩展权限问题。',
    });
  }

  function shouldConfirmResult(result) {
    return result && result.kind !== 'ok' && result.kind !== 'unavailable';
  }

  function makeRiskControlUnavailableResult(steps) {
    steps.push('游客评论接口被 B 站临时风控拦截，无法取得可用于判断的评论数据。');
    return {
      kind: 'unavailable',
      title: '暂时无法检测',
      status: 'B 站暂时拒绝游客查询，常见于请求频率较高或游客校验未通过。\n\n本次无法判断评论状态；这不代表评论被删除或仅自己可见。请等待片刻后重新检测。',
      tone: 'info',
      extra: '接口返回了 B 站风控响应。脚本已完成一次温和回退，未继续高频请求。',
    };
  }

  async function runVisibilityProbe(reply, steps, token) {
    checkCancelled(token);
    const root = Number(reply.root || 0);
    return root === 0
      ? await detectRootComment(reply, steps, token)
      : await detectChildComment(reply, steps, token);
  }

  async function confirmResultWithRetries(reply, initialResult, steps, token) {
    if (!shouldConfirmResult(initialResult)) {
      return { ...initialResult, confirmedAfterRetry: false };
    }

    let latestResult = initialResult;
    const retryCheckDelaysMs = getRetryCheckDelaysMs();

    for (let index = 0; index < retryCheckDelaysMs.length; index += 1) {
      const delayMs = retryCheckDelaysMs[index];
      const seconds = Math.round(delayMs / 1000);

      steps.push(`复检等待：${seconds} 秒后再次确认异常结论。`);
      await UI.status(`当前结论为“${latestResult.title}”，${seconds} 秒后自动复检，降低审核延迟误判。`, {
        title: '等待复检确认',
        tone: 'info',
        steps: steps.join('\n'),
      });
      UI.indeterminate(false);
      await sleepWithCancel(delayMs, token);
      UI.indeterminate(true);

      steps.push(`第 ${index + 1} 次延迟复检。`);
      if (STATE.diagnostics) STATE.diagnostics.retries += 1;
      latestResult = await runVisibilityProbe(reply, steps, token);

      if (latestResult.kind === 'ok') {
        return {
          ...latestResult,
          confirmedAfterRetry: true,
          extra: '首次检测为异常或可疑状态，延迟复检后已恢复为公开可见。',
        };
      }
    }

    return {
      ...latestResult,
      confirmedAfterRetry: true,
      extra: retryCheckDelaysMs.length > 0
        ? `异常或可疑状态已经过 ${retryCheckDelaysMs.length} 次延迟复检确认。`
        : '自动延迟复检已关闭，本次只报告即时检测结果。',
    };
  }

  async function detectRootComment(reply, steps, token) {
    checkCancelled(token);
    const { oid, type, rpid } = reply;

    steps.push('1. 匿名按 rpid 定位主评论。');
    await UI.status('匿名按 rpid 定位主评论。', { steps: steps.join('\n') });
    const mainAnonymous = await getMainCommentList(oid, type, 0, false, rpid, token);
    checkCancelled(token);

    if (isRiskControlResponse(mainAnonymous)) return makeRiskControlUnavailableResult(steps);

    if (!isSuccess(mainAnonymous)) {
      throw new Error(`匿名主评论列表响应异常：${stringifyForUser(mainAnonymous)}`);
    }

    const mainReplies = getReplies(mainAnonymous);
    if (findReply(mainReplies, rpid)) {
      return {
        kind: 'ok',
        title: '评论正常可见',
        status: '无账号状态下已经能定位到你的评论。\n\n结论：评论公开可见，未发现 shadow ban。',
        tone: 'ok',
      };
    }

    steps.push('2. 匿名主评论未命中，使用登录态检查该评论节点。');
    await UI.status('匿名主评论未命中，继续登录态交叉检查。', { steps: steps.join('\n') });
    const childLogin = await getChildCommentList(oid, type, rpid, 0, true, token);
    checkCancelled(token);

    if (isRiskControlResponse(childLogin)) return makeRiskControlUnavailableResult(steps);

    if (isDeletedCode(childLogin)) {
      return {
        kind: 'deleted',
        title: '评论疑似秒删',
        status: '登录态也无法读取该评论节点。\n\n结论：评论大概率已经被系统删除。刷新评论区后可能不再显示。',
        tone: 'bad',
      };
    }

    if (!isSuccess(childLogin)) {
      throw new Error(`登录态评论节点响应异常：${stringifyForUser(childLogin)}`);
    }

    steps.push('3. 登录态存在，改用匿名态检查同一评论节点。');
    await UI.status('登录态可读，继续匿名态检查同一评论节点。', { steps: steps.join('\n') });
    const childAnonymous = await getChildCommentList(oid, type, rpid, 0, false, token);
    checkCancelled(token);

    if (isRiskControlResponse(childAnonymous)) return makeRiskControlUnavailableResult(steps);

    if (isDeletedCode(childAnonymous)) {
      return {
        kind: 'shadow_ban',
        title: '疑似仅自己可见',
        status: '登录态可以读取该评论，但匿名态无法读取。\n\n结论：疑似 shadow ban，也就是仅自己可见。',
        tone: 'warn',
      };
    }

    if (isSuccess(childAnonymous)) {
      return {
        kind: 'suspect',
        title: '评论状态可疑',
        status: '匿名主评论列表找不到，但匿名接口仍能读取该评论节点。\n\n结论：状态可疑，可能是评论区排序、审核延迟、评论区限制或接口表现差异。',
        tone: 'warn',
      };
    }

    throw new Error(`匿名评论节点响应异常：${stringifyForUser(childAnonymous)}`);
  }

  async function scanChildPages({ oid, type, root, rpid, login, steps, token }) {
    const modeText = login ? '登录态' : '匿名态';

    for (let pn = 0; pn < SETTINGS.maxReplyPages; pn += 1) {
      checkCancelled(token);
      steps.push(`${modeText}扫描回复页：第 ${pn} 页。`);
      await UI.status(`${modeText}扫描回复页第 ${pn} 页。`, { steps: steps.join('\n') });

      const resp = await getChildCommentList(oid, type, root, pn, login, token);
      checkCancelled(token);

      if (isRiskControlResponse(resp)) {
        return { found: false, unavailable: true, ended: true, page: pn, resp };
      }

      if (isDeletedCode(resp)) {
        return { found: false, deleted: true, ended: true, page: pn, resp };
      }

      if (!isSuccess(resp)) {
        return { found: false, error: true, ended: true, page: pn, resp };
      }

      const replies = getReplies(resp);
      if (!replies || replies.length === 0) {
        return { found: false, ended: true, page: pn, resp };
      }

      const hit = findReply(replies, rpid);
      if (hit) {
        return { found: true, reply: hit, page: pn, resp };
      }

      await sleepWithCancel(SETTINGS.pageDelayMs, token);
    }

    return { found: false, reachedLimit: true, page: SETTINGS.maxReplyPages - 1 };
  }

  async function detectChildComment(reply, steps, token) {
    const { oid, type, rpid, root } = reply;

    steps.push('1. 这是楼中楼回复，先匿名扫描回复页。');
    const anonymous = await scanChildPages({ oid, type, root, rpid, login: false, steps, token });

    if (anonymous.found) {
      return {
        kind: 'ok',
        title: '评论正常可见',
        status: `匿名态在回复页第 ${anonymous.page} 页找到了你的评论。\n\n结论：评论公开可见，未发现 shadow ban。`,
        tone: 'ok',
      };
    }

    if (anonymous.error) {
      throw new Error(`匿名扫描回复页响应异常：${stringifyForUser(anonymous.resp)}`);
    }

    if (anonymous.unavailable) return makeRiskControlUnavailableResult(steps);

    steps.push('2. 匿名态未找到，继续登录态扫描回复页。');
    const login = await scanChildPages({ oid, type, root, rpid, login: true, steps, token });

    if (login.found) {
      return {
        kind: 'shadow_ban',
        title: '疑似仅自己可见',
        status: `匿名态没有找到，但登录态在回复页第 ${login.page} 页找到了你的评论。\n\n结论：疑似 shadow ban，也就是仅自己可见。`,
        tone: 'warn',
      };
    }

    if (login.error) {
      throw new Error(`登录态扫描回复页响应异常：${stringifyForUser(login.resp)}`);
    }

    if (login.unavailable) return makeRiskControlUnavailableResult(steps);

    return {
      kind: 'deleted',
      title: '评论疑似秒删',
      status: '匿名态和登录态都没有在回复页中找到你的评论。\n\n结论：评论大概率已经被系统删除，或接口暂时未同步。',
      tone: 'bad',
    };
  }

  async function detectCommentVisibility(reply, { waitFirst = true, token = createCancelToken() } = {}) {
    const comment = getCommentText(reply);
    const steps = [];

    if (!reply || !reply.oid || !reply.type || !reply.rpid) {
      throw new Error(`发评响应缺少必要字段：${stringifyForUser(reply)}`);
    }

    STATE.lastReply = reply;
    STATE.diagnostics = createDiagnostics();

    if (waitFirst) {
      await waitBeforeCheck(comment, token);
    } else {
      await UI.open({
        title: '重新检测中',
        status: '正在重新检查这条评论的公开可见性。',
        comment,
        tone: 'info',
        progress: 12,
      });
      UI.indeterminate(true);
    }

    const initialResult = await runVisibilityProbe(reply, steps, token);
    const result = await confirmResultWithRetries(reply, initialResult, steps, token);
    checkCancelled(token);

    if (STATE.diagnostics) {
      STATE.diagnostics.finishedAt = now();
      STATE.diagnostics.finalKind = result.kind;
    }

    if (result.kind === 'unavailable') setRiskControlCooldown(reply);

    await showFinal({
      title: result.title,
      status: result.status,
      comment,
      steps: steps.join('\n'),
      tone: result.tone,
      progress: 100,
      extra: result.extra || (result.confirmedAfterRetry ? '检测结果已完成延迟复检确认。' : ''),
    });
  }

  function enqueueReply(reply, { force = false, waitFirst = true } = {}) {
    if (!reply || !reply.rpid) return;

    if (!force && isDuplicateRpid(reply.rpid)) {
      log('跳过重复检测', reply.rpid);
      return;
    }

    STATE.queue.push({ reply, waitFirst });
    updateActionButtons();
    runQueue();
  }

  function recheckLastReply() {
    if (!STATE.lastReply) return;
    const cooldownRemaining = getRiskControlCooldownRemaining(STATE.lastReply);
    if (cooldownRemaining > 0) {
      const seconds = Math.ceil(cooldownRemaining / 1000);
      UI.status(`B 站刚刚拒绝过游客查询，请 ${seconds} 秒后再重新检测。`, {
        title: '请稍后重试',
        tone: 'info',
      }).catch((error) => warn('冷却提示失败', error));
      return;
    }
    enqueueReply(STATE.lastReply, { force: true, waitFirst: false });
    updateActionButtons();
  }

  function cancelCurrentAndClearQueue() {
    const hadWork = STATE.running || STATE.queue.length > 0;
    STATE.queue = [];
    STATE.cancelVersion += 1;

    if (STATE.diagnostics) {
      STATE.diagnostics.cancelled = true;
      STATE.diagnostics.finishedAt = now();
    }

    updateActionButtons();

    if (hadWork) {
      UI.status('已取消当前检测，并清空等待队列。', {
        title: '检测已取消',
        tone: 'info',
      }).catch((error) => warn('取消提示失败', error));
    }
  }

  async function runQueue() {
    if (STATE.running) return;
    STATE.running = true;
    updateActionButtons();

    while (STATE.queue.length > 0) {
      const task = STATE.queue.shift();
      const token = createCancelToken();
      STATE.activeToken = token;
      updateActionButtons();
      try {
        await detectCommentVisibility(task.reply, { waitFirst: task.waitFirst, token });
      } catch (error) {
        if (isCancelledError(error)) {
          log('检测已取消');
          break;
        }
        warn('检测失败', error);
        if (STATE.diagnostics) {
          STATE.diagnostics.finishedAt = now();
          STATE.diagnostics.finalKind = 'error';
        }
        await showError(error, getCommentText(task.reply));
      }
    }

    STATE.activeToken = null;
    STATE.running = false;
    updateActionButtons();
  }

  function handleAddCommentJson(json) {
    if (!json || typeof json !== 'object') return;

    if (Number(json.code) !== 0) {
      log('发评接口返回非成功状态，不进入检测', json);
      return;
    }

    const reply = json?.data?.reply;
    if (!reply || !reply.rpid) {
      warn('发评成功但响应中没有 reply/rpid', json);
      return;
    }

    log('捕获发评成功响应，准备检测', reply);
    enqueueReply(reply);
  }

  function observeAddCommentResponse(url, text) {
    if (!isAddCommentEndpoint(url)) return;
    const json = safeJsonParse(text);
    if (!json) {
      warn('发评接口响应不是 JSON', compactText(text, 300));
      return;
    }
    handleAddCommentJson(json);
  }

  function patchFetch() {
    if (typeof W.fetch !== 'function') {
      warn('未发现 fetch，跳过 fetch hook');
      return;
    }

    if (STATE.originalFetch) return;
    STATE.originalFetch = W.fetch;

    W.fetch = function patchedFetch(...args) {
      const requestUrl = normalizeUrl(args[0]);
      const promise = STATE.originalFetch.apply(W, args);

      if (isAddCommentEndpoint(requestUrl)) {
        promise
          .then((response) => response.clone().text())
          .then((text) => observeAddCommentResponse(requestUrl, text))
          .catch((error) => warn('读取发评 fetch 响应失败', error));
      }

      return promise;
    };

    log('fetch hook 已启用');
  }

  function patchXhr() {
    const XHR = W.XMLHttpRequest;
    if (!XHR || !XHR.prototype) {
      warn('未发现 XMLHttpRequest，跳过 XHR hook');
      return;
    }

    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;

    if (XHR.prototype.__BFC_LITE_XHR_PATCHED__) return;
    STATE.originalXhrOpen = nativeOpen;
    STATE.originalXhrSend = nativeSend;
    Object.defineProperty(XHR.prototype, '__BFC_LITE_XHR_PATCHED__', {
      value: true,
      configurable: true,
    });

    XHR.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__bfcLiteUrl = normalizeUrl(url);
      return nativeOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function patchedSend(...args) {
      const xhr = this;
      if (!xhr.__bfcLiteWatched) {
        xhr.__bfcLiteWatched = true;
        xhr.addEventListener('load', () => {
          const responseUrl = xhr.__bfcLiteUrl || '';
          if (!isAddCommentEndpoint(responseUrl)) return;
          try {
            const text = xhr.responseType === 'json' ? JSON.stringify(xhr.response)
              : (!xhr.responseType || xhr.responseType === 'text') ? xhr.responseText : '';
            if (text) observeAddCommentResponse(responseUrl, text);
          } catch (error) {
            warn('读取发评 XHR 响应失败', error);
          }
        });
      }

      return nativeSend.apply(xhr, args);
    };

    log('XHR hook 已启用');
  }

  function restoreNetworkHooks() {
    if (STATE.originalFetch && W.fetch !== STATE.originalFetch) {
      W.fetch = STATE.originalFetch;
    }

    const XHR = W.XMLHttpRequest;
    if (XHR?.prototype && STATE.originalXhrOpen && STATE.originalXhrSend) {
      XHR.prototype.open = STATE.originalXhrOpen;
      XHR.prototype.send = STATE.originalXhrSend;
      try {
        delete XHR.prototype.__BFC_LITE_XHR_PATCHED__;
      } catch {
        // Some script managers may refuse deleting patched markers.
      }
    }
  }

  function exposeDebugApi() {
    const api = {
      getState() {
        return {
          running: STATE.running,
          queueLength: STATE.queue.length,
          lastReply: STATE.lastReply,
          lastReport: STATE.lastReport,
          settings: { ...SETTINGS },
          diagnostics: STATE.diagnostics ? JSON.parse(JSON.stringify(STATE.diagnostics)) : null,
        };
      },
      cancelCurrentAndClearQueue,
      recheckLastReply,
      saveSettings(nextSettings) {
        const saved = saveSettings(nextSettings);
        populateSettingsPanel(saved);
        return saved;
      },
      restoreNetworkHooks,
    };

    Object.defineProperty(W, '__BFC_PRO__', {
      value: api,
      configurable: true,
    });
  }

  function init() {
    try {
      patchFetch();
      patchXhr();
      exposeDebugApi();
      ensureUi().catch((error) => warn('UI 初始化失败', error));
      log('脚本已加载：仅保留评论可见性检测，无 AI，无 API Key。');
    } catch (error) {
      warn('初始化失败', error);
    }
  }

  init();
})();
