// ==UserScript==
// @name         Bilibili Comment Thread Exporter
// @name:zh-CN   B站评论楼层导出器
// @namespace    https://space.bilibili.com/1937432404
// @version      0.5.5
// @updateURL    https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-comment-thread-exporter.user.js?v=055
// @downloadURL  https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-comment-thread-exporter.user.js?v=055
// @description  Export one Bilibili comment thread from the native three-dot comment menu as Markdown or JSON.
// @description:zh-CN 在 B 站评论三点菜单中增加“导出本楼”，并保留点赞数，把指定楼层整理成 Markdown 或 JSON。
// @author       素晴
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
  const VERSION = "0.5.5";
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
    menuTarget: null,
  };

  boot();

  function boot() {
    installNetworkObservers();
    onReady(() => {
      injectStyles();
      removeLegacyShell();
      installFullscreenTracking();
      observePage();
      installCommentMenuIntegration();
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
      const promise = originalFetch.apply(this, arguments);
      if (looksLikeCommentApi(url)) {
        // Keep observation failures separate from the page's original request.
        promise.then((response) => response.clone().json())
          .then((payload) => ingestCommentPayload(payload, url))
          .catch(() => {});
      }
      return promise;
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
      if (!this.__bceWatched) {
        this.__bceWatched = true;
        this.addEventListener("load", () => {
          if (!looksLikeCommentApi(this.__bceUrl)) return;
          try {
            const payload = this.responseType === "json" ? this.response
              : (!this.responseType || this.responseType === "text") ? JSON.parse(this.responseText) : null;
            if (payload) ingestCommentPayload(payload, this.__bceUrl);
          } catch (_) {
            // Ignore non-JSON, binary, or inaccessible responses.
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
    try {
      const parsed = new URL(String(url || ""), location.href);
      return parsed.hostname === "api.bilibili.com" && /^\/x\/v2\/reply(?:\/|$)/.test(parsed.pathname);
    } catch (_) {
      return false;
    }
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
    const observer = new MutationObserver((mutations) => {
      const hasPageChange = mutations.some(({ target }) => {
        const element = target.nodeType === 1 ? target : target.parentElement;
        return !element?.closest?.(`#${SCRIPT_ID}-shell`);
      });
      if (!hasPageChange) return;
      scheduleScan(600);
      scheduleMenuInjection(60);
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
    if (state.scanTimer) return;
    state.scanTimer = window.setTimeout(() => {
      state.scanTimer = 0;
      scanPageForCommentTargets();
    }, delay);
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

  function removeLegacyShell() {
    document.getElementById(`${SCRIPT_ID}-shell`)?.remove();
    state.shell = null;
    state.panelOpen = false;
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
      const userName = getReplyUser(root) || `rpid ${id}`;
      user.textContent = `${userName} · 点赞 ${getReplyLike(root)}`;
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
    ingestRepliesFromDom(candidates);
    updateRootDomOrder(candidates);
    removeLegacyInlineButtons();
    scheduleMenuInjection(20);
    scheduleRender(100);
  }

  function ingestRepliesFromDom(candidates) {
    for (const element of candidates) {
      const reply = getReplyDataFromElement(element);
      if (!reply) continue;
      storeSeenReply(reply, "dom:__data");
      if (isRootReply(reply)) storeRootReply(reply, "dom:__data");
    }
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
      "bili-comment-thread-renderer",
      "bili-comment-renderer",
      "bili-comment-reply-renderer",
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
      const tag = String(element.tagName || "").toLowerCase();
      if (["bili-comment-thread-renderer", "bili-comment-renderer", "bili-comment-reply-renderer"].includes(tag)) {
        return true;
      }
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

  function removeLegacyInlineButtons() {
    for (const button of deepQueryAll(".bce-inline-btn")) {
      button.remove();
    }
    for (const element of deepQueryAll("[data-bce-export-root]")) {
      element.removeAttribute?.("data-bce-export-root");
    }
  }

  function installCommentMenuIntegration() {
    if (document.__bceCommentMenuInstalled) return;
    document.__bceCommentMenuInstalled = true;
    document.addEventListener("pointerdown", handleCommentMenuPointerDown, true);
  }

  function handleCommentMenuPointerDown(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    const trigger = path.find((node) => node?.nodeType === 1 && isCommentMoreTrigger(node));
    if (!trigger) return;

    const actionRenderer = findCommentActionRendererInPath(path);
    const contextElement = actionRenderer || findCommentElementInPath(path, trigger);
    const context = resolveCommentExportContext(contextElement);
    if (!context?.rootId) return;

    state.menuTarget = {
      rootId: context.rootId,
      selectedReplyId: context.selectedReplyId || context.rootId,
      capturedAt: Date.now(),
      actionRenderer,
      menuHost: findBiliCommentMenuHost(path, actionRenderer),
    };

    for (const delay of [0, 30, 80, 160, 300, 600, 1000]) {
      scheduleMenuInjection(delay);
    }
  }

  function isCommentMoreTrigger(element) {
    if (!element || element.classList?.contains("bce-menu-export-item")) return false;
    const hint = [
      element.tagName,
      element.id,
      element.className,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("data-title"),
      element.getAttribute?.("icon"),
    ].filter(Boolean).join(" ").toLowerCase();
    const text = normalizeForMatch(element.textContent || "").slice(0, 30);
    return /(?:more|more_vertical|ellipsis|three[-_ ]?dot|operation[-_ ]?more|menu[-_ ]?button)/i.test(hint) ||
      /^(?:更多|more)$/i.test(text);
  }

  function findCommentActionRendererInPath(path) {
    return path.find((node) =>
      String(node?.tagName || "").toLowerCase() === "bili-comment-action-buttons-renderer"
    ) || null;
  }

  function findBiliCommentMenuHost(path, actionRenderer) {
    const moreContainer = path.find((node) =>
      node?.nodeType === 1 &&
      String(node.id || "").toLowerCase() === "more" &&
      typeof node.querySelector === "function"
    );
    return moreContainer?.querySelector?.("bili-comment-menu") ||
      actionRenderer?.shadowRoot?.querySelector?.("#more > bili-comment-menu, bili-comment-menu") ||
      null;
  }

  function findCommentElementInPath(path, trigger) {
    const isCommentElement = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const tag = String(node.tagName || "").toLowerCase();
      if ([
        "bili-comment-action-buttons-renderer",
        "bili-comment-thread-renderer",
        "bili-comment-renderer",
        "bili-comment-reply-renderer",
      ].includes(tag)) return true;
      const className = String(node.className || "").toLowerCase();
      return Boolean(
        pickReplyIdFromAttributes(node) ||
        className.includes("root-reply") ||
        className.includes("sub-reply") ||
        className.includes("reply-item") ||
        className.includes("comment-item")
      );
    };

    for (const node of path) {
      if (isCommentElement(node)) return node;
    }

    return trigger?.closest?.(
      "bili-comment-thread-renderer, bili-comment-renderer, bili-comment-reply-renderer, [data-rpid], [data-reply-id], .root-reply-container, .sub-reply-container, .reply-item, .sub-reply-item, .comment-item"
    ) || null;
  }

  function resolveCommentExportContext(element) {
    if (!element) return null;

    const dataReply = getReplyDataFromElement(element);
    if (dataReply) {
      storeSeenReply(dataReply, "dom:menu");
      if (isRootReply(dataReply)) storeRootReply(dataReply, "dom:menu");
    }

    const selectedReplyId = getReplyId(dataReply) || findReplyIdInElement(element);
    if (!selectedReplyId) return null;

    const indexed = dataReply || state.replyIndex.get(selectedReplyId);
    let rootId = indexed?.root_str || (indexed?.root == null ? "" : String(indexed.root));
    if (!rootId || rootId === "0") rootId = selectedReplyId;

    if (state.roots.has(selectedReplyId)) rootId = selectedReplyId;

    const directRoot = pickNumericId(
      element.getAttribute?.("data-root") ||
      element.getAttribute?.("data-root-id") ||
      ""
    );
    if (directRoot) rootId = directRoot;

    return { rootId: String(rootId), selectedReplyId: String(selectedReplyId) };
  }

  function scheduleMenuInjection(delay) {
    window.setTimeout(injectExportIntoOpenMenu, Math.max(0, Number(delay) || 0));
  }

  function injectExportIntoOpenMenu() {
    const context = state.menuTarget;
    if (!context || Date.now() - context.capturedAt > 8000) return;

    if ((!context.menuHost || !context.menuHost.isConnected) && context.actionRenderer?.shadowRoot) {
      context.menuHost = context.actionRenderer.shadowRoot.querySelector(
        "#more > bili-comment-menu, bili-comment-menu"
      );
    }

    if (context.menuHost && injectIntoBiliCommentMenu(context.menuHost, context)) return;

    const menu = findBestOpenCommentMenu();
    if (!menu) return;
    injectMenuItemIntoContainer(menu, context, null);
  }

  function injectIntoBiliCommentMenu(menuHost, context) {
    const root = menuHost?.shadowRoot;
    if (!root) return false;

    const options = root.querySelector("#options");
    if (!options) return false;

    const key = `${context.rootId}:${context.selectedReplyId}`;
    const existing = options.querySelector(".bce-menu-export-item");
    if (existing) {
      if (existing.dataset?.bceExportFor === key) return true;
      existing.remove();
    }

    const template = options.querySelector("li");
    return injectMenuItemIntoContainer(options, context, template || null);
  }

  function injectMenuItemIntoContainer(container, context, template) {
    if (!container) return false;

    const key = `${context.rootId}:${context.selectedReplyId}`;
    const old = container.querySelector?.(".bce-menu-export-item");
    if (old) {
      if (old.dataset?.bceExportFor === key) return true;
      old.remove();
    }

    let item;
    if (template) {
      item = template.cloneNode(false);
      item.removeAttribute?.("id");
      item.removeAttribute?.("href");
      item.removeAttribute?.("target");
    } else {
      item = document.createElement("li");
    }

    if (String(item.tagName || "").toLowerCase() === "button") item.type = "button";
    item.classList?.add("bce-menu-export-item");
    if (item.dataset) item.dataset.bceExportFor = key;
    item.textContent = "导出本楼";
    item.title = "复制本楼 Markdown；按住 Alt/Option 点击下载 JSON";
    item.style.cursor = "pointer";

    const stopNativeAction = (event) => {
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };
    item.addEventListener("pointerdown", stopNativeAction);
    item.addEventListener("mousedown", stopNativeAction);
    item.addEventListener("click", (event) => {
      event.preventDefault();
      stopNativeAction(event);
      exportRoot(context.rootId, {
        format: event.altKey ? "json" : "markdown",
        sourceButton: item,
        selectedReplyId: context.selectedReplyId,
      });
    });

    container.appendChild(item);
    return true;
  }

  function findBestOpenCommentMenu() {
    const selector = [
      '[role="menu"]',
      '[class*="more-menu"]',
      '[class*="MoreMenu"]',
      '[class*="operation-menu"]',
      '[class*="OperationMenu"]',
      '[class*="menu-list"]',
      '[class*="MenuList"]',
      '[class*="popover"]',
      '[class*="Popover"]',
      '[class*="popup"]',
      '[class*="Popup"]',
    ].join(",");

    const candidates = deepQueryAll(selector)
      .filter((element) => {
        if (!isElementVisible(element)) return false;
        if (element.closest?.(`#${SCRIPT_ID}-shell`)) return false;
        const text = normalizeForMatch(element.textContent || "");
        if (!text || text.length > 500) return false;
        return /举报|删除|置顶|拉黑|屏蔽|复制|report|delete|block/i.test(text);
      })
      .sort((a, b) => normalizeForMatch(a.textContent || "").length - normalizeForMatch(b.textContent || "").length);

    return candidates[0] || null;
  }

  function isElementVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect?.();
    if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
    try {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    } catch (_) {
      // Ignore transient or detached shadow DOM nodes.
    }
    return true;
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
    const seenReplyIds = new Set();
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
      const previousCount = allReplies.length;
      for (const reply of replies) {
        const id = getReplyId(reply);
        if (!id || seenReplyIds.has(id)) continue;
        seenReplyIds.add(id);
        allReplies.push(reply);
      }
      const reportedTotal = Number(data.page?.count);
      if (Number.isFinite(reportedTotal) && reportedTotal >= 0) total = reportedTotal;
      progress?.(allReplies.length, total);

      if (replies.length === 0) {
        truncated = total > allReplies.length;
        break;
      }
      if (total > 0 && allReplies.length >= total) break;
      if (allReplies.length === previousCount || pn === MAX_REPLY_PAGES) {
        truncated = true;
        break;
      }
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
      like: getReplyLike(reply),
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
      lines.push(`- 注意：导出可能不完整（分页提前结束、重复或达到上限），已获取 ${replies.length} 条不重复回复`);
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
    const like = ` · 点赞 ${getReplyLike(reply)}`;
    const message = (reply.message || "(无正文)").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const messageLines = message.split("\n");

    lines.push(`${indent}- **${escapeMarkdown(name)}**${parent}${time}${like}`);
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

  function getReplyLike(reply) {
    const value = Number(reply?.like);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
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
