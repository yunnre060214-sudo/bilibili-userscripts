// ==UserScript==
// @name         Bilibili Comment Thread Exporter
// @name:zh-CN   B站评论楼层导出器
// @namespace    https://codex.local/bilibili-comment-thread-exporter
// @version      0.4.2
// @updateURL    https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-comment-thread-exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-comment-thread-exporter.user.js
// @description  Add lightweight page controls to export one Bilibili comment thread as Markdown or JSON.
// @description:zh-CN 给 B 站评论区增加“导出本楼”和右下角面板，把指定楼层整理成 Markdown 或 JSON。
// @author       Codex
// @match        https://www.bilibili.com/video/*
// @connect      api.bilibili.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_ID = "bce-thread-exporter";
  const VERSION = "0.4.1";
  const COMMENT_TYPE_VIDEO = 1;
  const REPLY_PAGE_SIZE = 20;
  const MAX_REPLY_PAGES = 250;
  const REQUEST_DELAY_MS = 250;

  const state = {
    aid: null,
    bvid: getBvidFromLocation(),
    roots: new Map(),
    replyIndex: new Map(),
    rootSeenAt: new Map(),
    rootFirstSeenOrder: new Map(),
    rootDomOrder: new Map(),
    replySeenAt: new Map(),
    nextRootFirstSeenOrder: 0,
    exportBusy: new Set(),
    scanTimer: 0,
    renderTimer: 0,
    shell: null,
    panelOpen: false,
  };

  boot();

  function boot() {
    installNetworkObservers();
    onReady(() => {
      injectStyles();
      ensureShell();
      installFullscreenTracking();
      observePage();
      scheduleScan(100);
      ensureAid()
        .then(() => fetchInitialRoots())
        .catch((error) => showToast(`无法读取视频信息：${error.message}`, "error"));
    });
  }

  function getPageWindow() {
    try {
      return typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    } catch (_) {
      return window;
    }
  }

  function installNetworkObservers() {
    const pageWindow = getPageWindow();
    if (!pageWindow || pageWindow.__BCE_THREAD_EXPORTER_PATCHED__) return;

    try {
      Object.defineProperty(pageWindow, "__BCE_THREAD_EXPORTER_PATCHED__", {
        value: true,
        configurable: false,
      });
    } catch (_) {
      pageWindow.__BCE_THREAD_EXPORTER_PATCHED__ = true;
    }

    patchFetch(pageWindow);
    patchXhr(pageWindow);
  }

  function patchFetch(pageWindow) {
    const originalFetch = pageWindow.fetch;
    if (typeof originalFetch !== "function") return;

    pageWindow.fetch = function patchedFetch(input, init) {
      const url = getRequestUrl(input);
      return originalFetch.apply(this, arguments).then((response) => {
        if (looksLikeCommentApi(url) && response && typeof response.clone === "function") {
          response
            .clone()
            .json()
            .then((payload) => ingestCommentPayload(payload, url))
            .catch(() => {});
        }
        return response;
      });
    };
  }

  function patchXhr(pageWindow) {
    const Xhr = pageWindow.XMLHttpRequest;
    if (!Xhr || !Xhr.prototype) return;

    const originalOpen = Xhr.prototype.open;
    const originalSend = Xhr.prototype.send;
    if (originalOpen.__bcePatched || originalSend.__bcePatched) return;

    Xhr.prototype.open = function patchedOpen(method, url) {
      this.__bceUrl = typeof url === "string" ? url : String(url || "");
      return originalOpen.apply(this, arguments);
    };
    Xhr.prototype.open.__bcePatched = true;

    Xhr.prototype.send = function patchedSend() {
      if (looksLikeCommentApi(this.__bceUrl)) {
        this.addEventListener("load", () => {
          const text = this.responseText;
          if (!text || typeof text !== "string") return;
          try {
            ingestCommentPayload(JSON.parse(text), this.__bceUrl);
          } catch (_) {
            // Ignore non-JSON or partial responses.
          }
        });
      }
      return originalSend.apply(this, arguments);
    };
    Xhr.prototype.send.__bcePatched = true;
  }

  function getRequestUrl(input) {
    if (!input) return "";
    if (typeof input === "string") return input;
    if (input.url) return String(input.url);
    return String(input);
  }

  function looksLikeCommentApi(url) {
    return /api\.bilibili\.com\/x\/v2\/reply/.test(String(url || ""));
  }

  function ingestCommentPayload(payload, sourceUrl) {
    if (!payload || typeof payload !== "object") return;
    if (Object.prototype.hasOwnProperty.call(payload, "code") && payload.code !== 0) return;

    const data = payload.data || payload;
    const rootsBefore = state.roots.size;

    if (data.root) storeRootReply(data.root, sourceUrl);

    const lists = [data.replies, data.top_replies, data.hots, data.upper?.top, data.notice?.top];
    for (const list of lists) {
      if (Array.isArray(list)) {
        for (const reply of list) traverseReply(reply, sourceUrl);
      } else if (list && typeof list === "object") {
        traverseReply(list, sourceUrl);
      }
    }

    if (state.roots.size !== rootsBefore) {
      scheduleScan(200);
      scheduleRender(200);
    }
  }

  function traverseReply(reply, sourceUrl) {
    if (!reply || typeof reply !== "object") return;
    storeSeenReply(reply, sourceUrl);
    if (isRootReply(reply)) storeRootReply(reply, sourceUrl);
    if (Array.isArray(reply.replies)) {
      for (const child of reply.replies) traverseReply(child, sourceUrl);
    }
  }

  function isRootReply(reply) {
    const rpid = getReplyId(reply);
    if (!rpid) return false;
    const root = reply.root == null ? "0" : String(reply.root);
    return root === "0" || root === rpid;
  }

  function storeRootReply(reply, sourceUrl) {
    const id = getReplyId(reply);
    if (!id) return;
    storeSeenReply(reply, sourceUrl);
    const existing = state.roots.get(id);
    if (!state.rootFirstSeenOrder.has(id)) {
      state.rootFirstSeenOrder.set(id, state.nextRootFirstSeenOrder);
      state.nextRootFirstSeenOrder += 1;
    }
    state.roots.set(id, mergeReply(existing, reply, sourceUrl));
    state.rootSeenAt.set(id, Date.now());
  }

  function storeSeenReply(reply, sourceUrl) {
    const id = getReplyId(reply);
    if (!id) return;
    const existing = state.replyIndex.get(id);
    state.replyIndex.set(id, mergeReply(existing, reply, sourceUrl));
    state.replySeenAt.set(id, Date.now());
  }

  function mergeReply(existing, reply, sourceUrl) {
    if (!existing) {
      return Object.assign({ __bceSourceUrl: sourceUrl || "" }, reply);
    }
    return Object.assign({}, existing, reply, {
      __bceSourceUrl: existing.__bceSourceUrl || sourceUrl || "",
    });
  }

  function onReady(callback) {
    if (document.readyState === "interactive" || document.readyState === "complete") {
      callback();
      return;
    }
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  }

  function observePage() {
    const observer = new MutationObserver(() => {
      scheduleScan(600);
      updateShellVisibility();
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }

  function installFullscreenTracking() {
    document.addEventListener("fullscreenchange", updateShellVisibility, true);
    document.addEventListener("webkitfullscreenchange", updateShellVisibility, true);
    window.addEventListener("resize", updateShellVisibility, { passive: true });
    window.setInterval(updateShellVisibility, 1200);
    updateShellVisibility();
  }

  function scheduleScan(delay) {
    clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(scanPageForCommentTargets, delay);
  }

  function scheduleRender(delay) {
    clearTimeout(state.renderTimer);
    state.renderTimer = window.setTimeout(renderPanelList, delay);
  }

  function injectStyles() {
    if (document.getElementById(`${SCRIPT_ID}-style`)) return;
    const style = document.createElement("style");
    style.id = `${SCRIPT_ID}-style`;
    style.textContent = `
      .bce-inline-btn {
        margin-left: 8px;
        padding: 2px 7px;
        border: 1px solid #00aeec;
        border-radius: 6px;
        background: #fff;
        color: #008ac5;
        font-size: 12px;
        line-height: 18px;
        cursor: pointer;
        vertical-align: middle;
      }
      .bce-inline-btn:hover {
        background: #eaf8ff;
      }
      .bce-inline-btn[disabled] {
        border-color: #c9ccd0;
        color: #999;
        cursor: wait;
      }
      #bce-thread-exporter-shell {
        position: fixed;
        z-index: 1200;
        right: 18px;
        bottom: 18px;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        color: #222;
      }
      #bce-thread-exporter-shell.bce-hidden-fullscreen {
        display: none !important;
      }
      #bce-thread-exporter-toggle {
        min-width: 96px;
        height: 34px;
        padding: 0 12px;
        border: 0;
        border-radius: 17px;
        background: #00aeec;
        color: #fff;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
        cursor: pointer;
      }
      #bce-thread-exporter-panel {
        display: none;
        width: min(420px, calc(100vw - 36px));
        max-height: min(580px, calc(100vh - 78px));
        margin-bottom: 10px;
        border: 1px solid #e3e5e7;
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.2);
        overflow: hidden;
      }
      #bce-thread-exporter-shell.bce-open #bce-thread-exporter-panel {
        display: block;
      }
      .bce-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #edf0f2;
        background: #f6f7f8;
      }
      .bce-panel-title {
        font-weight: 650;
      }
      .bce-panel-actions {
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        border-bottom: 1px solid #edf0f2;
      }
      .bce-panel-actions button,
      .bce-list-item button {
        border: 1px solid #d0d7de;
        border-radius: 6px;
        background: #fff;
        color: #24292f;
        cursor: pointer;
        font-size: 12px;
        line-height: 24px;
        padding: 0 8px;
      }
      .bce-panel-actions button:hover,
      .bce-list-item button:hover {
        border-color: #00aeec;
        color: #008ac5;
      }
      .bce-list {
        max-height: 430px;
        overflow: auto;
      }
      .bce-empty {
        padding: 18px 14px;
        color: #777;
      }
      .bce-list-item {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: 7px;
        align-items: center;
        padding: 9px 12px;
        border-bottom: 1px solid #f0f1f2;
      }
      .bce-list-main {
        min-width: 0;
      }
      .bce-list-user {
        font-weight: 650;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bce-list-snippet {
        margin-top: 2px;
        color: #666;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bce-toast {
        position: fixed;
        z-index: 1201;
        right: 18px;
        bottom: 64px;
        max-width: min(420px, calc(100vw - 36px));
        padding: 10px 12px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.82);
        color: #fff;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      }
      .bce-toast.bce-error {
        background: rgba(189, 35, 35, 0.92);
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureShell() {
    if (state.shell || document.getElementById(`${SCRIPT_ID}-shell`)) return;

    const shell = document.createElement("div");
    shell.id = `${SCRIPT_ID}-shell`;

    const panel = document.createElement("div");
    panel.id = `${SCRIPT_ID}-panel`;

    const header = document.createElement("div");
    header.className = "bce-panel-header";
    const title = document.createElement("div");
    title.className = "bce-panel-title";
    title.textContent = "评论楼层导出";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "收起";
    closeButton.addEventListener("click", () => togglePanel(false));
    header.append(title, closeButton);

    const actions = document.createElement("div");
    actions.className = "bce-panel-actions";
    actions.append(
      makePanelAction("重扫页面", () => {
        scheduleScan(0);
        renderPanelList();
      }),
      makePanelAction("刷新第一页", () => {
        fetchInitialRoots(true).catch((error) => showToast(error.message, "error"));
      }),
      makePanelAction("手动 rpid", () => exportManualRoot())
    );

    const list = document.createElement("div");
    list.className = "bce-list";
    list.id = `${SCRIPT_ID}-list`;

    panel.append(header, actions, list);

    const toggle = document.createElement("button");
    toggle.id = `${SCRIPT_ID}-toggle`;
    toggle.type = "button";
    toggle.textContent = "评论导出";
    toggle.addEventListener("click", () => togglePanel(!state.panelOpen));

    shell.append(panel, toggle);
    document.body.appendChild(shell);
    state.shell = shell;
    updateShellVisibility();
    renderPanelList();
  }

  function makePanelAction(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function togglePanel(open) {
    state.panelOpen = Boolean(open);
    if (state.shell) state.shell.classList.toggle("bce-open", state.panelOpen);
    if (state.panelOpen) renderPanelList();
  }

  function updateShellVisibility() {
    if (!state.shell) return;
    const hidden = isVideoFullscreenLike();
    state.shell.classList.toggle("bce-hidden-fullscreen", hidden);
    if (hidden && state.panelOpen) togglePanel(false);
  }

  function isVideoFullscreenLike() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;

    const selectors = [
      ".bpx-player-container[data-screen='full']",
      ".bpx-player-container[data-screen='web']",
      ".bpx-player-container.bpx-state-entered-fullscreen",
      ".bpx-player-container.bpx-state-fullscreen",
      ".bpx-player-container.bpx-state-web-fullscreen",
      ".bilibili-player-video-wrap-fullscreen",
      ".bilibili-player-video-wrap-web-fullscreen",
      ".bilibili-player.mode-fullscreen",
      ".bilibili-player.mode-webfullscreen",
    ];

    if (document.querySelector(selectors.join(","))) return true;

    const bodyClass = String(document.body?.className || "").toLowerCase();
    return /\b(fullscreen|webfullscreen|web-fullscreen)\b/.test(bodyClass);
  }

  function renderPanelList() {
    const list = document.getElementById(`${SCRIPT_ID}-list`);
    if (!list) return;

    clearChildren(list);

    const roots = getSortedRoots().slice(0, 80);
    if (roots.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bce-empty";
      empty.textContent = "还没有捕获到评论。打开评论区、滚动到目标楼层后再试，或点击“刷新第一页”。";
      list.appendChild(empty);
      return;
    }

    for (const root of roots) {
      const id = getReplyId(root);
      const item = document.createElement("div");
      item.className = "bce-list-item";

      const main = document.createElement("div");
      main.className = "bce-list-main";
      const user = document.createElement("div");
      user.className = "bce-list-user";
      user.textContent = getReplyUser(root) || `rpid ${id}`;
      const snippet = document.createElement("div");
      snippet.className = "bce-list-snippet";
      snippet.textContent = getReplyMessage(root) || "(无正文)";
      main.append(user, snippet);

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.textContent = "复制";
      copyButton.title = "复制本楼 Markdown";
      copyButton.addEventListener("click", () => exportRoot(id, { format: "markdown" }));

      const jsonButton = document.createElement("button");
      jsonButton.type = "button";
      jsonButton.textContent = "JSON";
      jsonButton.title = "下载本楼 JSON";
      jsonButton.addEventListener("click", () => exportRoot(id, { format: "json" }));

      item.append(main, copyButton, jsonButton);
      list.appendChild(item);
    }
  }

  function getSortedRoots() {
    return Array.from(state.roots.values()).sort((a, b) => {
      const aId = getReplyId(a);
      const bId = getReplyId(b);
      const aDomOrder = state.rootDomOrder.get(aId);
      const bDomOrder = state.rootDomOrder.get(bId);

      if (Number.isFinite(aDomOrder) && Number.isFinite(bDomOrder)) return aDomOrder - bDomOrder;
      if (Number.isFinite(aDomOrder)) return -1;
      if (Number.isFinite(bDomOrder)) return 1;

      const aFirstSeen = state.rootFirstSeenOrder.get(aId);
      const bFirstSeen = state.rootFirstSeenOrder.get(bId);
      if (Number.isFinite(aFirstSeen) && Number.isFinite(bFirstSeen)) return aFirstSeen - bFirstSeen;

      return (state.rootSeenAt.get(aId) || 0) - (state.rootSeenAt.get(bId) || 0);
    });
  }

  function scanPageForCommentTargets() {
    const candidates = collectCandidateElements();
    updateRootDomOrder(candidates);
    bindButtonsByStoredRoots(candidates);
    bindButtonsByElementIds(candidates);
    scheduleRender(100);
  }

  function updateRootDomOrder(candidates) {
    state.rootDomOrder.clear();
    let order = 0;

    for (const element of candidates) {
      const id = findReplyIdInElement(element);
      if (!id) continue;
      if (!state.roots.has(id) && !looksLikeRootElement(element)) continue;
      if (state.rootDomOrder.has(id)) continue;

      state.rootDomOrder.set(id, order);
      order += 1;
    }
  }

  function collectCandidateElements() {
    const selector = [
      "[data-rpid]",
      "[data-reply-id]",
      "[data-id]",
      ".root-reply-container",
      ".sub-reply-container",
      ".reply-item",
      ".sub-reply-item",
      ".comment-item",
      '[class*="root-reply"]',
      '[class*="RootReply"]',
      '[class*="sub-reply"]',
      '[class*="SubReply"]',
      '[class*="reply-item"]',
      '[class*="ReplyItem"]',
      '[class*="comment-item"]',
      '[class*="CommentItem"]',
    ].join(",");
    return deepQueryAll(selector).filter((element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      if (element.closest && element.closest(`#${SCRIPT_ID}-shell`)) return false;
      const text = normalizeForMatch(element.textContent || "");
      return text.length > 0 && text.length < 8000;
    });
  }

  function deepQueryAll(selector, root) {
    const start = root || document;
    const result = [];
    try {
      result.push(...start.querySelectorAll(selector));
      const all = start.querySelectorAll("*");
      for (const element of all) {
        if (element.shadowRoot) result.push(...deepQueryAll(selector, element.shadowRoot));
      }
    } catch (_) {
      // Some transient shadow roots may disappear during scanning.
    }
    return Array.from(new Set(result));
  }

  function bindButtonsByStoredRoots(candidates) {
    const roots = getSortedRoots().slice(0, 160);
    for (const root of roots) {
      const id = getReplyId(root);
      if (!id) continue;
      const target = findBestElementForRoot(root, candidates);
      if (target) {
        const targetIndex = candidates.indexOf(target);
        if (targetIndex >= 0 && !state.rootDomOrder.has(id)) state.rootDomOrder.set(id, targetIndex);
        bindExportButton(target, id);
      }
    }
  }

  function bindButtonsByElementIds(candidates) {
    for (const element of candidates) {
      const id = findReplyIdInElement(element);
      if (!id) continue;
      if (!state.roots.has(id) && !looksLikeRootElement(element)) continue;
      bindExportButton(element, id);
      if (!state.roots.has(id)) {
        storeRootReply({ rpid: Number(id), rpid_str: id, root: 0, content: { message: "" }, member: {} }, "");
      }
    }
  }

  function looksLikeRootElement(element) {
    const className = String(element.className || "").toLowerCase();
    if (className.includes("root-reply") || className.includes("rootreply")) return true;
    const attr = element.getAttribute?.("data-root") || element.getAttribute?.("data-root-id") || "";
    return /\d{5,}/.test(attr);
  }

  function findBestElementForRoot(root, candidates) {
    const id = getReplyId(root);
    const user = normalizeForMatch(getReplyUser(root));
    const message = normalizeForMatch(getReplyMessage(root));
    const needle = message.slice(0, Math.min(28, Math.max(12, message.length)));
    let best = null;
    let bestScore = 0;

    for (const element of candidates) {
      const elementId = findReplyIdInElement(element);
      const text = normalizeForMatch(element.textContent || "");
      let score = 0;

      if (elementId && elementId === id) score += 100;
      if (user && text.includes(user)) score += 10;
      if (needle && text.includes(needle)) score += 30;
      if (!score) continue;

      const lengthPenalty = Math.min(text.length / 1500, 8);
      score -= lengthPenalty;

      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }

    return bestScore >= 20 ? best : null;
  }

  function findReplyIdInElement(element) {
    const direct = pickReplyIdFromAttributes(element);
    if (direct) return direct;

    const descendants = Array.from(element.querySelectorAll("[data-rpid], [data-reply-id], [data-id], a[href]")).slice(0, 80);
    for (const child of descendants) {
      const id = pickReplyIdFromAttributes(child);
      if (id) return id;
    }
    return "";
  }

  function pickReplyIdFromAttributes(element) {
    if (!element || !element.getAttributeNames) return "";
    for (const name of element.getAttributeNames()) {
      const lower = name.toLowerCase();
      if (!/(rpid|reply|comment|data-id)/.test(lower)) continue;
      const id = pickNumericId(element.getAttribute(name));
      if (id) return id;
    }

    if (element.tagName === "A") {
      const href = element.getAttribute("href") || "";
      const match = href.match(/(?:reply_id|rpid|comment_id|root|reply)=?(\d{5,})/i);
      if (match) return match[1];
    }
    return "";
  }

  function pickNumericId(value) {
    const text = String(value || "");
    const match = text.match(/\b\d{5,}\b/);
    return match ? match[0] : "";
  }

  function bindExportButton(element, rootId) {
    const id = String(rootId || "");
    if (!id || !element || element.dataset?.bceExportRoot === id) return;
    if (element.querySelector && element.querySelector(`.bce-inline-btn[data-root-id="${cssEscape(id)}"]`)) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "bce-inline-btn";
    button.dataset.rootId = id;
    button.textContent = "导出本楼";
    button.title = "复制本楼 Markdown；按住 Alt/Option 点击下载 JSON";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      exportRoot(id, { format: event.altKey ? "json" : "markdown", sourceButton: button });
    });

    const target =
      element.querySelector?.('[class*="operation"], [class*="Operation"], [class*="action"], [class*="Action"], [class*="info"], [class*="Info"]') ||
      element;
    target.appendChild(button);

    if (element.dataset) element.dataset.bceExportRoot = id;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }

  async function exportManualRoot() {
    const rootId = window.prompt("输入根评论 rpid：");
    if (!rootId) return;
    const id = pickNumericId(rootId);
    if (!id) {
      showToast("没有识别到有效 rpid", "error");
      return;
    }
    await exportRoot(id, { format: "markdown" });
  }

  async function exportRoot(rootId, options) {
    const id = String(rootId);
    const format = options?.format || "markdown";
    const sourceButton = options?.sourceButton;
    const selectedReplyId = options?.selectedReplyId ? String(options.selectedReplyId) : "";
    if (state.exportBusy.has(id)) return;

    state.exportBusy.add(id);
    setButtonBusy(sourceButton, true);
    showToast(`正在获取 rpid ${id} 的楼中楼...`);

    try {
      await ensureAid();
      const thread = await fetchThread(id, {
        selectedReplyId,
        progress: (current, total) => {
        const totalText = total ? ` / ${total}` : "";
        showToast(`正在获取 rpid ${id}：${current}${totalText}`);
        },
      });

      if (format === "json") {
        const json = JSON.stringify(thread, null, 2);
        downloadText(`${safeFileName(thread.source.title || "bilibili")}-rpid-${id}.json`, json, "application/json;charset=utf-8");
        showToast(`已下载 JSON：${thread.replies.length} 条回复`);
      } else {
        const markdown = formatThreadMarkdown(thread);
        await copyText(markdown);
        showToast(`已复制 Markdown：${thread.replies.length} 条回复`);
      }
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      state.exportBusy.delete(id);
      setButtonBusy(sourceButton, false);
    }
  }

  function setButtonBusy(button, busy) {
    if (!button) return;
    button.disabled = Boolean(busy);
    button.textContent = busy ? "导出中" : "导出本楼";
  }

  async function fetchThread(rootId, options) {
    const root = String(rootId);
    const selectedReplyId = options?.selectedReplyId ? String(options.selectedReplyId) : "";
    const progress = options?.progress;
    const allReplies = [];
    let rootReply = state.roots.get(root) || null;
    let total = 0;
    let truncated = false;

    for (let pn = 1; pn <= MAX_REPLY_PAGES; pn += 1) {
      const url = buildApiUrl("https://api.bilibili.com/x/v2/reply/reply", {
        type: COMMENT_TYPE_VIDEO,
        oid: state.aid,
        root,
        pn,
        ps: REPLY_PAGE_SIZE,
        jsonp: "jsonp",
      });
      const payload = await requestJson(url);
      if (!payload || payload.code !== 0) {
        throw new Error(payload?.message || `评论接口返回异常：${payload?.code ?? "unknown"}`);
      }

      const data = payload.data || {};
      if (data.root) {
        rootReply = data.root;
        storeRootReply(data.root, url);
      }

      const replies = Array.isArray(data.replies) ? data.replies : [];
      for (const reply of replies) traverseReply(reply, url);
      allReplies.push(...replies);
      total = Number(data.page?.count || total || replies.length || 0);
      progress?.(allReplies.length, total);

      if (replies.length === 0) break;
      if (total > 0 && allReplies.length >= total) break;
      if (pn === MAX_REPLY_PAGES) truncated = true;
      await delay(REQUEST_DELAY_MS);
    }

    if (!rootReply) {
      rootReply = state.roots.get(root) || {
        rpid: Number(root),
        rpid_str: root,
        root: 0,
        member: {},
        content: { message: "" },
      };
    }

    const simplifiedRoot = simplifyReply(rootReply);
    const simplifiedReplies = allReplies.map(simplifyReply);
    const selected =
      selectedReplyId && selectedReplyId === simplifiedRoot.rpid
        ? simplifiedRoot
        : simplifiedReplies.find((reply) => reply.rpid === selectedReplyId) ||
          (selectedReplyId ? simplifyReply(state.replyIndex.get(selectedReplyId)) : null);

    return {
      exporter: {
        name: "Bilibili Comment Thread Exporter",
        version: VERSION,
        exportedAt: new Date().toISOString(),
        truncated,
        pageSize: REPLY_PAGE_SIZE,
        maxPages: MAX_REPLY_PAGES,
      },
      source: {
        title: getVideoTitle(),
        url: location.href,
        bvid: state.bvid || getBvidFromLocation(),
        aid: state.aid,
        type: COMMENT_TYPE_VIDEO,
        rootRpid: root,
        selectedRpid: selectedReplyId || root,
      },
      selected: selected || null,
      root: simplifiedRoot,
      replies: simplifiedReplies,
    };
  }

  async function fetchInitialRoots(forceToast) {
    await ensureAid();
    const url = buildApiUrl("https://api.bilibili.com/x/v2/reply", {
      type: COMMENT_TYPE_VIDEO,
      oid: state.aid,
      pn: 1,
      ps: 20,
      sort: 2,
      jsonp: "jsonp",
    });
    const payload = await requestJson(url);
    if (!payload || payload.code !== 0) {
      throw new Error(payload?.message || "刷新第一页评论失败");
    }
    ingestCommentPayload(payload, url);
    scheduleScan(50);
    renderPanelList();
    if (forceToast) showToast(`已刷新：捕获 ${state.roots.size} 条根评论`);
  }

  async function ensureAid() {
    if (state.aid) return state.aid;

    const pageWindow = getPageWindow();
    const candidates = [
      pageWindow.__INITIAL_STATE__?.aid,
      pageWindow.__INITIAL_STATE__?.videoData?.aid,
      pageWindow.__INITIAL_STATE__?.videoInfo?.aid,
      pageWindow.__INITIAL_STATE__?.mediaInfo?.aid,
    ];
    for (const candidate of candidates) {
      const aid = Number(candidate);
      if (Number.isFinite(aid) && aid > 0) {
        state.aid = aid;
        return aid;
      }
    }

    state.bvid = state.bvid || getBvidFromLocation();
    if (!state.bvid) throw new Error("当前页面不是可识别的视频页");

    const url = buildApiUrl("https://api.bilibili.com/x/web-interface/view", {
      bvid: state.bvid,
    });
    const payload = await requestJson(url);
    if (!payload || payload.code !== 0 || !payload.data?.aid) {
      throw new Error(payload?.message || "无法通过 BV 号获取 avid");
    }

    state.aid = Number(payload.data.aid);
    return state.aid;
  }

  function buildApiUrl(base, params) {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  function requestJson(url) {
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          responseType: "json",
          anonymous: false,
          withCredentials: true,
          timeout: 30000,
          headers: {
            Accept: "application/json, text/plain, */*",
          },
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`网络请求失败：HTTP ${response.status}`));
              return;
            }
            if (response.response && typeof response.response === "object") {
              resolve(response.response);
              return;
            }
            try {
              resolve(JSON.parse(response.responseText));
            } catch (error) {
              reject(new Error(`接口返回不是 JSON：${error.message}`));
            }
          },
          onerror: () => reject(new Error("网络请求失败")),
          ontimeout: () => reject(new Error("网络请求超时")),
        });
      });
    }

    return fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json, text/plain, */*" },
    }).then((response) => {
      if (!response.ok) throw new Error(`网络请求失败：HTTP ${response.status}`);
      return response.json();
    });
  }

  function simplifyReply(reply) {
    const content = reply?.content || {};
    const member = reply?.member || {};
    return {
      rpid: getReplyId(reply),
      root: reply?.root == null ? "0" : String(reply.root),
      parent: reply?.parent == null ? "0" : String(reply.parent),
      user: {
        mid: member.mid == null ? "" : String(member.mid),
        name: member.uname || "",
        avatar: member.avatar || "",
      },
      time: {
        ctime: reply?.ctime || 0,
        local: reply?.ctime ? formatTime(reply.ctime) : "",
      },
      like: reply?.like || 0,
      message: content.message || "",
      pictures: Array.isArray(content.pictures)
        ? content.pictures.map((picture) => picture.img_src || picture.src || "").filter(Boolean)
        : [],
      emotes: content.emote ? Object.keys(content.emote) : [],
      jumpUrls: content.jump_url ? Object.keys(content.jump_url) : [],
    };
  }

  function formatThreadMarkdown(thread) {
    const lines = [];
    const root = thread.root;
    const replies = thread.replies;
    const byId = new Map();
    byId.set(root.rpid, root);
    for (const reply of replies) byId.set(reply.rpid, reply);

    lines.push(`# ${thread.source.title || "Bilibili 评论楼层"}`);
    lines.push("");
    lines.push(`- 页面：${thread.source.url}`);
    lines.push(`- BV：${thread.source.bvid || ""}`);
    lines.push(`- AV：${thread.source.aid || ""}`);
    lines.push(`- 根评论 rpid：${thread.source.rootRpid}`);
    lines.push(`- 选中评论 rpid：${thread.source.selectedRpid || thread.source.rootRpid}`);
    lines.push(`- 导出时间：${formatTime(Date.now() / 1000)}`);
    if (thread.exporter.truncated) {
      lines.push(`- 注意：达到脚本上限，只导出了前 ${thread.exporter.maxPages * thread.exporter.pageSize} 条回复`);
    }

    if (thread.selected && thread.selected.rpid !== root.rpid) {
      lines.push("");
      lines.push("## 选中的评论");
      lines.push("");
      appendReplyMarkdown(lines, thread.selected, 0);
    }

    lines.push("");
    lines.push("## 根评论");
    lines.push("");
    appendReplyMarkdown(lines, root, 0);
    lines.push("");
    lines.push("## 回复");
    lines.push("");

    if (replies.length === 0) {
      lines.push("_没有获取到二级回复。_");
    } else {
      for (const reply of replies) {
        const parent = byId.get(reply.parent);
        const parentName = parent?.user?.name || "";
        appendReplyMarkdown(lines, reply, 0, parentName);
      }
    }

    lines.push("");
    lines.push(`_Exported by Bilibili Comment Thread Exporter ${VERSION}_`);
    return lines.join("\n");
  }

  function appendReplyMarkdown(lines, reply, indentLevel, parentName) {
    const indent = "  ".repeat(indentLevel);
    const name = reply.user?.name || `mid:${reply.user?.mid || "unknown"}`;
    const time = reply.time?.local ? ` · ${reply.time.local}` : "";
    const parent = parentName ? ` 回复 ${parentName}` : "";
    const message = (reply.message || "(无正文)").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const messageLines = message.split("\n");

    lines.push(`${indent}- **${escapeMarkdown(name)}**${parent}${time}`);
    for (const line of messageLines) {
      lines.push(`${indent}  ${line || ""}`);
    }
    for (const picture of reply.pictures || []) {
      lines.push(`${indent}  ![](${picture})`);
    }
  }

  function escapeMarkdown(text) {
    return String(text || "").replace(/([\\*_`[\]])/g, "\\$1");
  }

  async function copyText(text) {
    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(text, "text");
      return;
    }
    await navigator.clipboard.writeText(text);
  }

  function downloadText(fileName, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showToast(message, kind) {
    const existing = document.querySelector(".bce-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `bce-toast${kind === "error" ? " bce-error" : ""}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), kind === "error" ? 5000 : 2200);
  }

  function getReplyId(reply) {
    if (!reply) return "";
    return String(reply.rpid_str || reply.rpid || "");
  }

  function getReplyUser(reply) {
    return reply?.member?.uname || "";
  }

  function getReplyMessage(reply) {
    return reply?.content?.message || "";
  }

  function normalizeForMatch(value) {
    return String(value || "")
      .replace(/\[[^\]]{1,32}\]/g, "")
      .replace(/\s+/g, "")
      .trim();
  }

  function getBvidFromLocation() {
    const match = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
    return match ? match[1] : "";
  }

  function getVideoTitle() {
    const pageWindow = getPageWindow();
    return (
      pageWindow.__INITIAL_STATE__?.videoData?.title ||
      document.querySelector("h1")?.textContent?.trim() ||
      document.title.replace(/_哔哩哔哩_bilibili$/, "").trim()
    );
  }

  function formatTime(seconds) {
    const date = new Date(Number(seconds) * 1000);
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function safeFileName(value) {
    return String(value || "bilibili-comment-thread")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  function clearChildren(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
