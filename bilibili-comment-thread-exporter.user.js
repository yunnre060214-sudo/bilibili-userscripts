// ==UserScript==
// @name         Bilibili Comment Thread Exporter
// @name:zh-CN   B站评论楼层导出器
// @namespace    https://space.bilibili.com/1937432404
// @version      1.0.0
// @updateURL    https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/bilibili-comment-thread-exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/bilibili-comment-thread-exporter.user.js
// @description  Export a complete Bilibili comment thread from the native three-dot menu as Markdown or JSON.
// @description:zh-CN 在 B 站评论三点菜单中直接导出完整楼层，支持 Markdown、JSON、点赞数、IP 属地与完整性校验。
// @author       素晴
// @match        https://www.bilibili.com/video/*
// @connect      api.bilibili.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_ID = "bce-thread-exporter";
  const VERSION = "1.0.0";
  const SCHEMA_VERSION = 1;
  const DEFAULT_COMMENT_TYPE = 1;
  const REPLY_PAGE_SIZE = 20;
  const MAX_REPLY_PAGES = 250;
  const REQUEST_DELAY_MS = 250;
  const REQUEST_RETRIES = 3;
  const MENU_CONTEXT_TTL_MS = 8000;

  const state = {
    menuContext: null,
    menuObserver: null,
    menuObserverTimer: 0,
    activeTask: null,
    taskSerial: 0,
  };

  let requestJson = requestJsonWithRetry;
  let waitBetweenPages = delay;

  boot();

  function boot() {
    installCommentMenuIntegration();
    onReady(cleanupLegacyUi);
  }

  function onReady(callback) {
    if (document.readyState === "interactive" || document.readyState === "complete") {
      callback();
      return;
    }
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  }

  function cleanupLegacyUi() {
    document.getElementById(`${SCRIPT_ID}-shell`)?.remove();
    document.getElementById(`${SCRIPT_ID}-style`)?.remove();
    document.querySelectorAll?.(".bce-inline-btn").forEach((element) => element.remove());
    document.querySelectorAll?.("[data-bce-export-root]").forEach((element) => {
      element.removeAttribute("data-bce-export-root");
    });
  }

  function installCommentMenuIntegration() {
    if (document.__bceCommentExporterV1Installed) return;
    document.__bceCommentExporterV1Installed = true;
    document.addEventListener("pointerdown", handlePointerDown, true);
  }

  function handlePointerDown(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    const trigger = findMoreButtonTrigger(path);
    if (!trigger) return;

    const actionRenderer = findCommentActionRendererInPath(path);
    if (!actionRenderer) return;

    const context = resolveCommentExportContext(actionRenderer);
    if (!context) return;

    context.actionRenderer = actionRenderer;
    context.menuHost = findBiliCommentMenuHost(path, actionRenderer);
    context.capturedAt = Date.now();
    state.menuContext = context;

    stopMenuObserver();

    for (const delayMs of [0, 25, 75, 150, 300, 600, 1000]) {
      window.setTimeout(() => {
        if (state.menuContext !== context) return;
        injectMenuActions(context);
      }, delayMs);
    }
  }

  function findMoreButtonTrigger(path) {
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;

      const tag = String(node.tagName || "").toLowerCase();
      if (tag === "bili-icon") {
        const icon = String(node.getAttribute?.("icon") || "").toLowerCase();
        if (icon.includes("more_vertical")) return node;
      }

      if (tag === "button") {
        const parent = node.parentElement;
        if (String(parent?.id || "").toLowerCase() === "more") return node;
      }
    }
    return null;
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

  function getReplyDataFromElement(element) {
    if (!element || typeof element !== "object") return null;
    const data = element.__data;
    if (!data || typeof data !== "object") return null;

    const candidates = [
      data.reply,
      data.root,
      data.comment,
      data.data?.reply,
      data.data?.root,
      data.data,
      data,
    ];

    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object" && getReplyId(candidate)) return candidate;
    }
    return null;
  }

  function resolveCommentExportContext(actionRenderer) {
    const reply = getReplyDataFromElement(actionRenderer);
    if (!reply) return null;

    const selectedReplyId = getReplyId(reply);
    if (!selectedReplyId) return null;

    const rootValue = reply.root_str ?? reply.root;
    const rootId = !rootValue || String(rootValue) === "0"
      ? selectedReplyId
      : String(rootValue);

    const oid = String(reply.oid_str || reply.oid || "");
    if (!oid) return null;

    const typeValue = Number(reply.type);
    const type = Number.isFinite(typeValue) && typeValue > 0 ? typeValue : DEFAULT_COMMENT_TYPE;

    return {
      oid,
      type,
      rootId,
      selectedReplyId,
      seedReply: reply,
    };
  }

  function injectMenuActions(context) {
    if (!context || Date.now() - context.capturedAt > MENU_CONTEXT_TTL_MS) return false;

    if ((!context.menuHost || !context.menuHost.isConnected) && context.actionRenderer?.shadowRoot) {
      context.menuHost = context.actionRenderer.shadowRoot.querySelector(
        "#more > bili-comment-menu, bili-comment-menu"
      );
    }

    const menuHost = context.menuHost;
    const root = menuHost?.shadowRoot;
    const options = root?.querySelector?.("#options");
    if (!options) return false;

    ensureMenuItem(options, context, "markdown", "导出本楼");
    ensureMenuItem(options, context, "json", "导出本楼 JSON");
    watchMenuRoot(menuHost, context);
    return true;
  }

  function ensureMenuItem(options, context, format, label) {
    const selector = `.bce-menu-export-item[data-bce-format="${format}"]`;
    const key = contextKey(context);
    const existing = options.querySelector?.(selector);

    if (existing?.dataset?.bceContextKey === key) return existing;
    existing?.remove?.();

    const template = options.querySelector?.("li");
    const item = template ? template.cloneNode(false) : document.createElement("li");

    item.removeAttribute?.("id");
    item.removeAttribute?.("href");
    item.removeAttribute?.("target");
    item.classList?.add("bce-menu-export-item");
    item.dataset.bceFormat = format;
    item.dataset.bceContextKey = key;
    item.textContent = label;
    item.title = format === "json" ? "下载本楼 JSON" : "复制本楼 Markdown";
    item.style.cursor = "pointer";

    const blockNative = (event) => {
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };

    item.addEventListener("pointerdown", blockNative);
    item.addEventListener("mousedown", blockNative);
    item.addEventListener("click", (event) => {
      event.preventDefault();
      blockNative(event);
      exportThread(context, format, item);
    });

    options.appendChild(item);
    return item;
  }

  function watchMenuRoot(menuHost, context) {
    const root = menuHost?.shadowRoot;
    if (!root || typeof MutationObserver !== "function") return;
    if (state.menuObserver?.__bceRoot === root && state.menuContext === context) return;

    stopMenuObserver();

    const observer = new MutationObserver(() => {
      if (state.menuContext !== context) return;
      injectMenuActions(context);
    });
    observer.__bceRoot = root;
    observer.observe(root, { childList: true, subtree: true });
    state.menuObserver = observer;
    state.menuObserverTimer = window.setTimeout(stopMenuObserver, MENU_CONTEXT_TTL_MS);
  }

  function stopMenuObserver() {
    if (state.menuObserver) {
      state.menuObserver.disconnect();
      state.menuObserver = null;
    }
    if (state.menuObserverTimer) {
      clearTimeout(state.menuObserverTimer);
      state.menuObserverTimer = 0;
    }
  }

  function contextKey(context) {
    return [context.oid, context.type, context.rootId, context.selectedReplyId].join(":");
  }

  async function exportThread(context, format, sourceItem) {
    const task = beginExportTask();
    const normalLabel = format === "json" ? "导出本楼 JSON" : "导出本楼";
    setMenuItemBusy(sourceItem, true, normalLabel);
    showToast("正在获取完整楼层…");

    try {
      const thread = await fetchThread(context, {
        task,
        progress: (current, total) => {
          const totalText = total > 0 ? ` / ${total}` : "";
          const message = `正在导出 ${current}${totalText}`;
          if (sourceItem?.isConnected) sourceItem.textContent = message;
          showToast(message);
        },
      });

      throwIfCancelled(task);

      if (format === "json") {
        const json = JSON.stringify(thread, null, 2);
        downloadText(
          `${safeFileName(thread.source.title || "bilibili")}-rpid-${thread.source.rootRpid}.json`,
          json,
          "application/json;charset=utf-8"
        );
      } else {
        await copyText(formatThreadMarkdown(thread));
      }

      const actionText = format === "json" ? "已下载 JSON" : "已复制 Markdown";
      const countText = `${thread.exporter.actualReplyCount} 条回复`;
      showToast(
        thread.exporter.complete
          ? `${actionText}：${countText}`
          : `${actionText}：${countText}，结果可能不完整`,
        thread.exporter.complete ? "success" : "warning"
      );
    } catch (error) {
      if (isCancelledError(error)) return;
      showToast(error?.message || String(error), "error");
    } finally {
      if (state.activeTask === task) state.activeTask = null;
      setMenuItemBusy(sourceItem, false, normalLabel);
    }
  }

  function beginExportTask() {
    cancelActiveTask();
    const task = {
      id: ++state.taskSerial,
      cancelled: false,
      abort: null,
    };
    state.activeTask = task;
    return task;
  }

  function cancelActiveTask() {
    const task = state.activeTask;
    if (!task) return;
    task.cancelled = true;
    try {
      task.abort?.();
    } catch (_) {
      // Ignore transport-specific abort failures.
    }
    task.abort = null;
    state.activeTask = null;
  }

  function setMenuItemBusy(item, busy, normalLabel) {
    if (!item) return;
    item.setAttribute?.("aria-busy", busy ? "true" : "false");
    item.style.pointerEvents = busy ? "none" : "";
    if (!busy && item.isConnected) item.textContent = normalLabel;
  }

  async function fetchThread(context, options = {}) {
    const task = options.task;
    const progress = options.progress;
    const repliesById = new Map();
    const orderedReplyIds = [];
    let rootReply = null;
    let expectedReplyCount = 0;
    let truncated = false;
    let pagesFetched = 0;

    for (let pn = 1; pn <= MAX_REPLY_PAGES; pn += 1) {
      throwIfCancelled(task);

      const url = buildApiUrl("https://api.bilibili.com/x/v2/reply/reply", {
        type: context.type || DEFAULT_COMMENT_TYPE,
        oid: context.oid,
        root: context.rootId,
        pn,
        ps: REPLY_PAGE_SIZE,
        jsonp: "jsonp",
      });

      const payload = await requestJson(url, task);
      throwIfCancelled(task);
      pagesFetched = pn;

      const data = payload?.data || {};
      if (data.root) rootReply = data.root;

      const pageReplies = Array.isArray(data.replies) ? data.replies : [];
      const countBefore = repliesById.size;

      for (const reply of pageReplies) {
        collectReplyTree(reply, repliesById, orderedReplyIds);
      }

      const reportedTotal = Number(data.page?.count);
      if (Number.isFinite(reportedTotal) && reportedTotal >= 0) {
        expectedReplyCount = reportedTotal;
      }

      progress?.(repliesById.size, expectedReplyCount);

      if (pageReplies.length === 0) {
        if (expectedReplyCount > repliesById.size) truncated = true;
        break;
      }

      if (expectedReplyCount > 0 && repliesById.size >= expectedReplyCount) break;

      if (repliesById.size === countBefore) {
        truncated = true;
        break;
      }

      if (pn === MAX_REPLY_PAGES) {
        truncated = expectedReplyCount === 0 || repliesById.size < expectedReplyCount;
        break;
      }

      await waitBetweenPages(REQUEST_DELAY_MS, task);
    }

    throwIfCancelled(task);

    if (!rootReply && String(context.seedReply?.root_str ?? context.seedReply?.root ?? "0") === "0") {
      rootReply = context.seedReply;
    }

    if (!rootReply) {
      rootReply = {
        rpid_str: String(context.rootId),
        rpid: Number(context.rootId),
        root: 0,
        parent: 0,
        member: {},
        content: { message: "" },
      };
    }

    const root = simplifyReply(rootReply);
    const replies = orderedReplyIds.map((id) => simplifyReply(repliesById.get(id)));
    const selected = String(context.selectedReplyId) === root.rpid
      ? root
      : replies.find((reply) => reply.rpid === String(context.selectedReplyId)) ||
        simplifyReply(context.seedReply);

    const actualReplyCount = replies.length;
    const complete = !truncated &&
      (expectedReplyCount === 0 || actualReplyCount >= expectedReplyCount);

    return {
      schemaVersion: SCHEMA_VERSION,
      exporter: {
        name: "Bilibili Comment Thread Exporter",
        version: VERSION,
        exportedAt: new Date().toISOString(),
        complete,
        truncated: !complete,
        pageSize: REPLY_PAGE_SIZE,
        maxPages: MAX_REPLY_PAGES,
        pagesFetched,
        expectedReplyCount,
        actualReplyCount,
      },
      source: {
        title: getVideoTitle(),
        url: location.href,
        bvid: getBvidFromLocation(),
        oid: String(context.oid),
        aid: String(context.oid),
        type: Number(context.type || DEFAULT_COMMENT_TYPE),
        rootRpid: String(context.rootId),
        selectedRpid: String(context.selectedReplyId || context.rootId),
      },
      selected: selected?.rpid ? selected : null,
      root,
      replies,
    };
  }

  function collectReplyTree(reply, map, order) {
    if (!reply || typeof reply !== "object") return;
    const id = getReplyId(reply);
    if (id && !map.has(id)) {
      map.set(id, reply);
      order.push(id);
    } else if (id) {
      map.set(id, mergeReply(map.get(id), reply));
    }

    if (Array.isArray(reply.replies)) {
      for (const child of reply.replies) collectReplyTree(child, map, order);
    }
  }

  function mergeReply(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    return Object.assign({}, existing, incoming, {
      member: Object.assign({}, existing.member || {}, incoming.member || {}),
      content: Object.assign({}, existing.content || {}, incoming.content || {}),
      reply_control: Object.assign({}, existing.reply_control || {}, incoming.reply_control || {}),
    });
  }

  function simplifyReply(reply) {
    if (!reply || typeof reply !== "object") return {
      rpid: "",
      root: "0",
      parent: "0",
      user: { mid: "", name: "", avatar: "" },
      time: { ctime: 0, local: "" },
      like: 0,
      location: "",
      replyCount: 0,
      message: "",
      pictures: [],
      emotes: [],
      jumpUrls: [],
    };

    const content = reply.content || {};
    const member = reply.member || {};
    const ctime = Number(reply.ctime) || 0;

    return {
      rpid: getReplyId(reply),
      root: String(reply.root_str ?? reply.root ?? "0"),
      parent: String(reply.parent_str ?? reply.parent ?? "0"),
      user: {
        mid: member.mid == null ? "" : String(member.mid),
        name: member.uname || "",
        avatar: member.avatar || "",
      },
      time: {
        ctime,
        local: ctime ? formatTime(ctime) : "",
      },
      like: getReplyLike(reply),
      location: String(reply.reply_control?.location || ""),
      replyCount: normalizeNonNegativeInt(reply.rcount ?? reply.count),
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
    const replies = thread.replies || [];
    const byId = new Map();
    if (root?.rpid) byId.set(root.rpid, root);
    for (const reply of replies) {
      if (reply?.rpid) byId.set(reply.rpid, reply);
    }

    lines.push(`# ${thread.source.title || "Bilibili 评论楼层"}`);
    lines.push("");
    lines.push(`- 页面：${thread.source.url || ""}`);
    lines.push(`- BV：${thread.source.bvid || ""}`);
    lines.push(`- AV/OID：${thread.source.oid || thread.source.aid || ""}`);
    lines.push(`- 根评论 rpid：${thread.source.rootRpid || ""}`);
    lines.push(`- 选中评论 rpid：${thread.source.selectedRpid || thread.source.rootRpid || ""}`);
    lines.push(`- 导出时间：${formatTime(Date.now() / 1000)}`);
    lines.push(
      `- 回复数：${thread.exporter.actualReplyCount}` +
      (thread.exporter.expectedReplyCount > 0 ? ` / ${thread.exporter.expectedReplyCount}` : "")
    );

    if (!thread.exporter.complete) {
      lines.push("- 注意：接口分页提前结束、重复或达到上限，导出结果可能不完整");
    }

    if (thread.selected?.rpid && thread.selected.rpid !== root?.rpid) {
      lines.push("");
      lines.push("## 选中的评论");
      lines.push("");
      appendReplyMarkdown(lines, thread.selected, byId);
    }

    lines.push("");
    lines.push("## 根评论");
    lines.push("");
    appendReplyMarkdown(lines, root, byId);

    lines.push("");
    lines.push("## 回复");
    lines.push("");

    if (replies.length === 0) {
      lines.push("_没有获取到二级回复。_");
    } else {
      for (const reply of replies) appendReplyMarkdown(lines, reply, byId);
    }

    lines.push("");
    lines.push(`_Exported by Bilibili Comment Thread Exporter ${VERSION} · schema v${SCHEMA_VERSION}_`);
    return lines.join("\n");
  }

  function appendReplyMarkdown(lines, reply, byId) {
    if (!reply) return;

    const name = reply.user?.name || `mid:${reply.user?.mid || "unknown"}`;
    const parentName = reply.parent && reply.parent !== "0"
      ? byId.get(reply.parent)?.user?.name || ""
      : "";

    const meta = [];
    if (reply.user?.mid) meta.push(`UID ${reply.user.mid}`);
    if (reply.time?.local) meta.push(reply.time.local);
    meta.push(`点赞 ${normalizeNonNegativeInt(reply.like)}`);
    if (reply.location) meta.push(reply.location);

    const replyTo = parentName ? ` 回复 **${escapeMarkdown(parentName)}**` : "";
    lines.push(
      `- **${escapeMarkdown(name)}**${replyTo}` +
      (meta.length ? ` · ${meta.join(" · ")}` : "")
    );

    const message = String(reply.message || "(无正文)")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");

    for (const line of message.split("\n")) {
      lines.push(`  ${line || ""}`);
    }

    for (const picture of reply.pictures || []) {
      lines.push(`  ![](${picture})`);
    }
  }

  async function requestJsonWithRetry(url, task) {
    let lastError = null;

    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      throwIfCancelled(task);

      try {
        const payload = await requestJsonOnce(url, task);
        throwIfCancelled(task);

        if (!payload || typeof payload !== "object") {
          throw new BceTransportError("接口返回为空", true);
        }

        if (Object.prototype.hasOwnProperty.call(payload, "code") && payload.code !== 0) {
          const error = new BceApiError(
            Number(payload.code),
            payload.message || payload.msg || `评论接口返回异常：${payload.code}`
          );
          if (!error.retryable || attempt === REQUEST_RETRIES) throw error;
          lastError = error;
        } else {
          return payload;
        }
      } catch (error) {
        if (isCancelledError(error)) throw error;
        lastError = error;
        if (error?.retryable === false || attempt === REQUEST_RETRIES) throw error;
      }

      await delay(350 * attempt, task);
    }

    throw lastError || new Error("评论接口请求失败");
  }

  function requestJsonOnce(url, task) {
    throwIfCancelled(task);

    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        let settled = false;

        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          if (task) task.abort = null;
          callback(value);
        };

        const handle = GM_xmlhttpRequest({
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
              const retryable = response.status === 429 || response.status >= 500;
              finish(reject, new BceTransportError(`网络请求失败：HTTP ${response.status}`, retryable));
              return;
            }

            if (response.response && typeof response.response === "object") {
              finish(resolve, response.response);
              return;
            }

            try {
              finish(resolve, JSON.parse(response.responseText));
            } catch (error) {
              finish(reject, new BceTransportError(`接口返回不是 JSON：${error.message}`, true));
            }
          },
          onerror: () => finish(reject, new BceTransportError("网络请求失败", true)),
          ontimeout: () => finish(reject, new BceTransportError("网络请求超时", true)),
          onabort: () => finish(reject, new BceCancelledError()),
        });

        if (task) {
          task.abort = () => {
            try {
              handle?.abort?.();
            } finally {
              finish(reject, new BceCancelledError());
            }
          };
        }
      });
    }

    const controller = new AbortController();
    if (task) task.abort = () => controller.abort();

    return fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json, text/plain, */*" },
      signal: controller.signal,
    }).then(async (response) => {
      if (task) task.abort = null;
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new BceTransportError(`网络请求失败：HTTP ${response.status}`, retryable);
      }
      return response.json();
    }).catch((error) => {
      if (task) task.abort = null;
      if (error?.name === "AbortError") throw new BceCancelledError();
      throw error;
    });
  }

  class BceCancelledError extends Error {
    constructor() {
      super("导出已取消");
      this.name = "BceCancelledError";
      this.retryable = false;
    }
  }

  class BceTransportError extends Error {
    constructor(message, retryable) {
      super(message);
      this.name = "BceTransportError";
      this.retryable = Boolean(retryable);
    }
  }

  class BceApiError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "BceApiError";
      this.code = code;
      this.retryable = code === -412 || code === -509;
    }
  }

  function throwIfCancelled(task) {
    if (task?.cancelled) throw new BceCancelledError();
  }

  function isCancelledError(error) {
    return error?.name === "BceCancelledError";
  }

  function buildApiUrl(base, params) {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  function getReplyId(reply) {
    if (!reply) return "";
    return String(reply.rpid_str || reply.rpid || "");
  }

  function getReplyLike(reply) {
    return normalizeNonNegativeInt(reply?.like);
  }

  function normalizeNonNegativeInt(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
  }

  function getBvidFromLocation() {
    const match = String(location.pathname || "").match(/\/video\/(BV[a-zA-Z0-9]+)/);
    return match ? match[1] : "";
  }

  function getVideoTitle() {
    return (
      document.querySelector?.("h1")?.textContent?.trim() ||
      String(document.title || "").replace(/_哔哩哔哩_bilibili$/, "").trim()
    );
  }

  function formatTime(seconds) {
    const date = new Date(Number(seconds) * 1000);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function escapeMarkdown(text) {
    return String(text || "").replace(/([\\*_\`[\]])/g, "\\$1");
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

  function safeFileName(value) {
    return String(value || "bilibili-comment-thread")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  function showToast(message, kind) {
    if (!document.body) return;

    document.getElementById(`${SCRIPT_ID}-toast`)?.remove();

    const toast = document.createElement("div");
    toast.id = `${SCRIPT_ID}-toast`;
    toast.textContent = String(message || "");
    toast.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "right:18px",
      "bottom:18px",
      "max-width:min(460px,calc(100vw - 36px))",
      "padding:10px 13px",
      "border-radius:8px",
      "box-shadow:0 8px 28px rgba(0,0,0,.22)",
      "font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,sans-serif",
      "color:#fff",
      `background:${kind === "error" ? "rgba(190,35,35,.94)" : kind === "warning" ? "rgba(174,104,0,.94)" : "rgba(0,0,0,.84)"}`,
      "pointer-events:none",
    ].join(";");

    document.body.appendChild(toast);
    window.setTimeout(() => {
      if (toast.isConnected) toast.remove();
    }, kind === "error" ? 5000 : 2600);
  }

  function delay(ms, task) {
    return new Promise((resolve, reject) => {
      window.setTimeout(() => {
        try {
          throwIfCancelled(task);
          resolve();
        } catch (error) {
          reject(error);
        }
      }, ms);
    });
  }
})();
