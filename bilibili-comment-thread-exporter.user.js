// ==UserScript==
// @name         Bilibili Comment Thread Exporter
// @name:zh-CN   B站评论楼层导出器
// @namespace    https://space.bilibili.com/1937432404
// @version      1.0.2
// @updateURL    https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/bilibili-comment-thread-exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/bilibili-comment-thread-exporter.user.js
// @description  Copy or download a complete Bilibili comment thread as Markdown from the native three-dot menu.
// @description:zh-CN 在 B 站评论三点菜单中复制或下载完整楼层 Markdown，保留点赞数、IP 属地与完整性校验。
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

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  const META = Object.freeze({
    id: "bce-thread-exporter",
    version: "1.0.2",
    installGuard: "__bceCommentExporterV1Installed",
  });

  const CONFIG = Object.freeze({
    commentType: 1,
    replyPageSize: 20,
    maxReplyPages: 250,
    pageDelayMs: 250,
    requestRetries: 3,
    retryBaseDelayMs: 350,
    requestTimeoutMs: 30000,
    menuContextTtlMs: 8000,
    menuInjectionDelaysMs: Object.freeze([0, 25, 75, 150, 300, 600, 1000]),
  });

  const API = Object.freeze({
    replyThread: "https://api.bilibili.com/x/v2/reply/reply",
  });

  const DOM = Object.freeze({
    actionRendererTag: "bili-comment-action-buttons-renderer",
    menuTag: "bili-comment-menu",
    moreId: "more",
    menuOptions: "#options",
    menuHost: "#more > bili-comment-menu, bili-comment-menu",
    exportItemClass: "bce-menu-export-item",
  });

  const MIME = Object.freeze({
    markdown: "text/markdown;charset=utf-8",
  });

  const EXPORT_ACTIONS = Object.freeze([
    Object.freeze({
      id: "copy-md",
      label: "导出本楼",
      title: "复制本楼 Markdown",
      destination: "clipboard",
      successText: "已复制 Markdown",
    }),
    Object.freeze({
      id: "download-md",
      label: "下载本楼 MD",
      title: "下载本楼 Markdown 文件",
      destination: "download",
      successText: "已下载 Markdown",
    }),
  ]);

  const runtime = {
    menu: {
      context: null,
      observer: null,
      observedRoot: null,
      observerTimer: 0,
    },
    export: {
      activeTask: null,
      nextTaskId: 0,
    },
  };

  const dependencies = {
    requestJson: requestJsonWithRetry,
    waitBetweenPages: delay,
  };

  boot();

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

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
    document.getElementById(`${META.id}-shell`)?.remove();
    document.getElementById(`${META.id}-style`)?.remove();

    document.querySelectorAll?.(".bce-inline-btn").forEach((element) => element.remove());
    document.querySelectorAll?.("[data-bce-export-root]").forEach((element) => {
      element.removeAttribute("data-bce-export-root");
    });
  }

  // ---------------------------------------------------------------------------
  // Native Bilibili comment-menu integration
  // ---------------------------------------------------------------------------

  function installCommentMenuIntegration() {
    if (document[META.installGuard]) return;
    document[META.installGuard] = true;
    document.addEventListener("pointerdown", handleCommentMenuPointerDown, true);
  }

  function handleCommentMenuPointerDown(event) {
    const path = getComposedPath(event);
    if (!findMoreButtonTrigger(path)) return;

    const actionRenderer = findCommentActionRendererInPath(path);
    if (!actionRenderer) return;

    const baseContext = resolveCommentExportContext(actionRenderer);
    if (!baseContext) return;

    const context = {
      ...baseContext,
      actionRenderer,
      menuHost: findBiliCommentMenuHost(path, actionRenderer),
      capturedAt: Date.now(),
    };

    activateMenuContext(context);
  }

  function getComposedPath(event) {
    return typeof event?.composedPath === "function"
      ? event.composedPath()
      : [event?.target].filter(Boolean);
  }

  function findMoreButtonTrigger(path) {
    for (const node of path) {
      if (!isElementNode(node)) continue;

      const tag = tagNameOf(node);
      if (tag === "bili-icon") {
        const icon = String(node.getAttribute?.("icon") || "").toLowerCase();
        if (icon.includes("more_vertical")) return node;
      }

      if (tag === "button" && String(node.parentElement?.id || "").toLowerCase() === DOM.moreId) {
        return node;
      }
    }
    return null;
  }

  function findCommentActionRendererInPath(path) {
    return path.find((node) => tagNameOf(node) === DOM.actionRendererTag) || null;
  }

  function findBiliCommentMenuHost(path, actionRenderer) {
    const moreContainer = path.find((node) =>
      isElementNode(node) &&
      String(node.id || "").toLowerCase() === DOM.moreId &&
      typeof node.querySelector === "function"
    );

    return moreContainer?.querySelector?.(DOM.menuTag) ||
      actionRenderer?.shadowRoot?.querySelector?.(DOM.menuHost) ||
      null;
  }

  function activateMenuContext(context) {
    runtime.menu.context = context;
    stopMenuObserver();

    for (const delayMs of CONFIG.menuInjectionDelaysMs) {
      window.setTimeout(() => {
        if (runtime.menu.context !== context) return;
        injectMenuActions(context);
      }, delayMs);
    }
  }

  function injectMenuActions(context) {
    if (!isMenuContextFresh(context)) return false;

    const options = resolveMenuOptions(context);
    if (!options) return false;

    for (const action of EXPORT_ACTIONS) {
      ensureMenuAction(options, context, action);
    }

    watchMenuRoot(context.menuHost, context);
    return true;
  }

  function isMenuContextFresh(context) {
    return Boolean(
      context &&
      Date.now() - context.capturedAt <= CONFIG.menuContextTtlMs
    );
  }

  function resolveMenuOptions(context) {
    if ((!context.menuHost || !context.menuHost.isConnected) && context.actionRenderer?.shadowRoot) {
      context.menuHost = context.actionRenderer.shadowRoot.querySelector(DOM.menuHost);
    }

    return context.menuHost?.shadowRoot?.querySelector?.(DOM.menuOptions) || null;
  }

  function ensureMenuAction(options, context, action) {
    const selector = `.${DOM.exportItemClass}[data-bce-action="${action.id}"]`;
    const contextKey = makeContextKey(context);
    const existing = options.querySelector?.(selector);

    if (existing?.dataset?.bceContextKey === contextKey) return existing;
    existing?.remove?.();

    const item = createNativeStyleMenuItem(options);
    item.classList?.add(DOM.exportItemClass);
    item.dataset.bceAction = action.id;
    item.dataset.bceContextKey = contextKey;
    item.textContent = action.label;
    item.title = action.title;
    item.style.cursor = "pointer";

    bindMenuActionEvents(item, context, action);
    options.appendChild(item);
    return item;
  }

  function createNativeStyleMenuItem(options) {
    const nativeItem = options.querySelector?.("li");
    const item = nativeItem ? nativeItem.cloneNode(false) : document.createElement("li");

    item.removeAttribute?.("id");
    item.removeAttribute?.("href");
    item.removeAttribute?.("target");
    return item;
  }

  function bindMenuActionEvents(item, context, action) {
    const stopNativeAction = (event) => {
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };

    item.addEventListener("pointerdown", stopNativeAction);
    item.addEventListener("mousedown", stopNativeAction);
    item.addEventListener("click", (event) => {
      event.preventDefault();
      stopNativeAction(event);
      runExport(context, action, item);
    });
  }

  function watchMenuRoot(menuHost, context) {
    const root = menuHost?.shadowRoot;
    if (!root || typeof MutationObserver !== "function") return;

    if (
      runtime.menu.observer &&
      runtime.menu.observedRoot === root &&
      runtime.menu.context === context
    ) {
      return;
    }

    stopMenuObserver();

    const observer = new MutationObserver(() => {
      if (runtime.menu.context !== context) return;
      injectMenuActions(context);
    });

    observer.observe(root, { childList: true, subtree: true });

    runtime.menu.observer = observer;
    runtime.menu.observedRoot = root;
    runtime.menu.observerTimer = window.setTimeout(
      stopMenuObserver,
      CONFIG.menuContextTtlMs
    );
  }

  function stopMenuObserver() {
    runtime.menu.observer?.disconnect();
    runtime.menu.observer = null;
    runtime.menu.observedRoot = null;

    if (runtime.menu.observerTimer) {
      clearTimeout(runtime.menu.observerTimer);
      runtime.menu.observerTimer = 0;
    }
  }

  function makeContextKey(context) {
    return [
      context.oid,
      context.type,
      context.rootId,
      context.selectedReplyId,
    ].join(":");
  }

  // ---------------------------------------------------------------------------
  // Bilibili comment data adapter
  // ---------------------------------------------------------------------------

  function getReplyDataFromElement(element) {
    const data = element?.__data;
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

    return candidates.find((candidate) =>
      candidate &&
      typeof candidate === "object" &&
      getReplyId(candidate)
    ) || null;
  }

  function resolveCommentExportContext(actionRenderer) {
    const reply = getReplyDataFromElement(actionRenderer);
    if (!reply) return null;

    const selectedReplyId = getReplyId(reply);
    const oid = String(reply.oid_str || reply.oid || "");
    if (!selectedReplyId || !oid) return null;

    const rootValue = reply.root_str ?? reply.root;
    const rootId = !rootValue || String(rootValue) === "0"
      ? selectedReplyId
      : String(rootValue);

    return {
      oid,
      type: normalizeCommentType(reply.type),
      rootId,
      selectedReplyId,
      seedReply: reply,
    };
  }

  function normalizeCommentType(value) {
    const type = Number(value);
    return Number.isFinite(type) && type > 0 ? type : CONFIG.commentType;
  }

  // ---------------------------------------------------------------------------
  // Export orchestration and task lifecycle
  // ---------------------------------------------------------------------------

  async function runExport(context, action, sourceItem) {
    const task = beginExportTask();
    setMenuItemBusy(sourceItem, true, action.label);
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

      const markdown = formatThreadMarkdown(thread);
      await deliverMarkdown(action, thread, markdown);

      const replyCountText = `${thread.exporter.actualReplyCount} 条回复`;
      showToast(
        thread.exporter.complete
          ? `${action.successText}：${replyCountText}`
          : `${action.successText}：${replyCountText}，结果可能不完整`,
        thread.exporter.complete ? "success" : "warning"
      );
    } catch (error) {
      if (!isCancelledError(error)) {
        showToast(error?.message || String(error), "error");
      }
    } finally {
      finishExportTask(task);
      setMenuItemBusy(sourceItem, false, action.label);
    }
  }

  async function deliverMarkdown(action, thread, markdown) {
    if (action.destination === "download") {
      downloadText(
        buildMarkdownFileName(thread),
        markdown,
        MIME.markdown
      );
      return;
    }

    await copyText(markdown);
  }

  function buildMarkdownFileName(thread) {
    return `${safeFileName(thread.source.title || "bilibili")}-rpid-${thread.source.rootRpid}.md`;
  }

  function beginExportTask() {
    cancelActiveTask();

    const task = {
      id: ++runtime.export.nextTaskId,
      cancelled: false,
      abortCurrentRequest: null,
    };

    runtime.export.activeTask = task;
    return task;
  }

  function finishExportTask(task) {
    clearTaskAbort(task);
    if (runtime.export.activeTask === task) {
      runtime.export.activeTask = null;
    }
  }

  function cancelActiveTask() {
    const task = runtime.export.activeTask;
    if (!task) return;

    task.cancelled = true;

    try {
      task.abortCurrentRequest?.();
    } catch (_) {
      // Transport abort failures do not change the cancellation state.
    }

    task.abortCurrentRequest = null;
    runtime.export.activeTask = null;
  }

  function bindTaskAbort(task, abort) {
    if (!task) return;

    if (task.cancelled) {
      abort();
      return;
    }

    task.abortCurrentRequest = abort;
  }

  function clearTaskAbort(task, abort) {
    if (!task) return;
    if (!abort || task.abortCurrentRequest === abort) {
      task.abortCurrentRequest = null;
    }
  }

  function throwIfCancelled(task) {
    if (task?.cancelled) throw new BceCancelledError();
  }

  function isCancelledError(error) {
    return error?.name === "BceCancelledError";
  }

  function setMenuItemBusy(item, busy, normalLabel) {
    if (!item) return;

    item.setAttribute?.("aria-busy", busy ? "true" : "false");
    item.style.pointerEvents = busy ? "none" : "";

    if (!busy && item.isConnected) {
      item.textContent = normalLabel;
    }
  }

  // ---------------------------------------------------------------------------
  // Thread retrieval and accumulation
  // ---------------------------------------------------------------------------

  async function fetchThread(context, options = {}) {
    const task = options.task;
    const progress = options.progress;
    const accumulator = createReplyAccumulator();

    let rootReply = null;
    let expectedReplyCount = 0;
    let truncated = false;
    let pagesFetched = 0;

    for (let pageNumber = 1; pageNumber <= CONFIG.maxReplyPages; pageNumber += 1) {
      throwIfCancelled(task);

      const payload = await fetchReplyPage(context, pageNumber, task);
      throwIfCancelled(task);
      pagesFetched = pageNumber;

      const data = payload?.data || {};
      if (data.root) rootReply = data.root;

      const pageReplies = Array.isArray(data.replies) ? data.replies : [];
      const countBefore = accumulator.size;

      for (const reply of pageReplies) {
        accumulator.addTree(reply);
      }

      expectedReplyCount = readExpectedReplyCount(data, expectedReplyCount);
      progress?.(accumulator.size, expectedReplyCount);

      const stopReason = getPaginationStopReason({
        pageReplies,
        countBefore,
        currentCount: accumulator.size,
        expectedReplyCount,
        pageNumber,
      });

      if (stopReason) {
        truncated = isIncompleteStop(stopReason, accumulator.size, expectedReplyCount);
        break;
      }

      await dependencies.waitBetweenPages(CONFIG.pageDelayMs, task);
    }

    throwIfCancelled(task);

    rootReply = resolveRootReply(rootReply, context);

    const root = normalizeReply(rootReply);
    const replies = accumulator.values().map(normalizeReply);
    const selected = resolveSelectedReply(context, root, replies);

    const actualReplyCount = replies.length;
    const complete = !truncated &&
      (expectedReplyCount === 0 || actualReplyCount >= expectedReplyCount);

    return buildThreadResult({
      context,
      root,
      replies,
      selected,
      complete,
      pagesFetched,
      expectedReplyCount,
      actualReplyCount,
    });
  }

  function fetchReplyPage(context, pageNumber, task) {
    return dependencies.requestJson(
      buildApiUrl(API.replyThread, {
        type: context.type || CONFIG.commentType,
        oid: context.oid,
        root: context.rootId,
        pn: pageNumber,
        ps: CONFIG.replyPageSize,
        jsonp: "jsonp",
      }),
      task
    );
  }

  function createReplyAccumulator() {
    const repliesById = new Map();
    const order = [];

    return {
      get size() {
        return repliesById.size;
      },

      addTree(reply) {
        collectReplyTree(reply, repliesById, order);
      },

      values() {
        return order.map((id) => repliesById.get(id));
      },
    };
  }

  function collectReplyTree(reply, repliesById, order) {
    if (!reply || typeof reply !== "object") return;

    const id = getReplyId(reply);
    if (id) {
      if (!repliesById.has(id)) {
        repliesById.set(id, reply);
        order.push(id);
      } else {
        repliesById.set(id, mergeReply(repliesById.get(id), reply));
      }
    }

    if (Array.isArray(reply.replies)) {
      for (const child of reply.replies) {
        collectReplyTree(child, repliesById, order);
      }
    }
  }

  function mergeReply(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;

    return {
      ...existing,
      ...incoming,
      member: {
        ...(existing.member || {}),
        ...(incoming.member || {}),
      },
      content: {
        ...(existing.content || {}),
        ...(incoming.content || {}),
      },
      reply_control: {
        ...(existing.reply_control || {}),
        ...(incoming.reply_control || {}),
      },
    };
  }

  function readExpectedReplyCount(data, fallback) {
    const count = Number(data?.page?.count);
    return Number.isFinite(count) && count >= 0 ? count : fallback;
  }

  function getPaginationStopReason({
    pageReplies,
    countBefore,
    currentCount,
    expectedReplyCount,
    pageNumber,
  }) {
    if (pageReplies.length === 0) return "empty-page";
    if (expectedReplyCount > 0 && currentCount >= expectedReplyCount) return "complete";
    if (currentCount === countBefore) return "duplicate-page";
    if (pageNumber === CONFIG.maxReplyPages) return "page-limit";
    return "";
  }

  function isIncompleteStop(reason, actualCount, expectedCount) {
    if (reason === "complete") return false;
    if (reason === "empty-page") return expectedCount > actualCount;
    if (reason === "duplicate-page") return true;
    if (reason === "page-limit") return expectedCount === 0 || actualCount < expectedCount;
    return false;
  }

  function resolveRootReply(rootReply, context) {
    if (rootReply) return rootReply;

    const seedRoot = String(
      context.seedReply?.root_str ??
      context.seedReply?.root ??
      "0"
    );

    if (seedRoot === "0") return context.seedReply;

    return {
      rpid_str: String(context.rootId),
      rpid: Number(context.rootId),
      root: 0,
      parent: 0,
      member: {},
      content: { message: "" },
    };
  }

  function resolveSelectedReply(context, root, replies) {
    const selectedReplyId = String(context.selectedReplyId || "");

    if (selectedReplyId === root.rpid) return root;

    return replies.find((reply) => reply.rpid === selectedReplyId) ||
      normalizeReply(context.seedReply);
  }

  function buildThreadResult({
    context,
    root,
    replies,
    selected,
    complete,
    pagesFetched,
    expectedReplyCount,
    actualReplyCount,
  }) {
    return {
      exporter: {
        name: "Bilibili Comment Thread Exporter",
        version: META.version,
        exportedAt: new Date().toISOString(),
        complete,
        truncated: !complete,
        pageSize: CONFIG.replyPageSize,
        maxPages: CONFIG.maxReplyPages,
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
        type: Number(context.type || CONFIG.commentType),
        rootRpid: String(context.rootId),
        selectedRpid: String(context.selectedReplyId || context.rootId),
      },
      selected: selected?.rpid ? selected : null,
      root,
      replies,
    };
  }

  // ---------------------------------------------------------------------------
  // Data normalization and Markdown rendering
  // ---------------------------------------------------------------------------

  function normalizeReply(reply) {
    if (!reply || typeof reply !== "object") return emptyNormalizedReply();

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
      replyCount: toNonNegativeInt(reply.rcount ?? reply.count),
      message: content.message || "",
      pictures: normalizePictures(content.pictures),
      emotes: content.emote ? Object.keys(content.emote) : [],
      jumpUrls: content.jump_url ? Object.keys(content.jump_url) : [],
    };
  }

  function emptyNormalizedReply() {
    return {
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
  }

  function normalizePictures(pictures) {
    if (!Array.isArray(pictures)) return [];

    return pictures
      .map((picture) => picture?.img_src || picture?.src || "")
      .filter(Boolean);
  }

  function formatThreadMarkdown(thread) {
    const lines = [];
    const replies = thread.replies || [];
    const replyIndex = buildReplyIndex(thread.root, replies);

    appendThreadMetadata(lines, thread);

    if (thread.selected?.rpid && thread.selected.rpid !== thread.root?.rpid) {
      lines.push("", "## 选中的评论", "");
      appendReplyMarkdown(lines, thread.selected, replyIndex);
    }

    lines.push("", "## 根评论", "");
    appendReplyMarkdown(lines, thread.root, replyIndex);

    lines.push("", "## 回复", "");

    if (replies.length === 0) {
      lines.push("_没有获取到二级回复。_");
    } else {
      for (const reply of replies) {
        appendReplyMarkdown(lines, reply, replyIndex);
      }
    }

    lines.push("", `_Exported by Bilibili Comment Thread Exporter ${META.version}_`);
    return lines.join("\n");
  }

  function appendThreadMetadata(lines, thread) {
    lines.push(`# ${thread.source.title || "Bilibili 评论楼层"}`);
    lines.push("");
    lines.push(`- 页面：${thread.source.url || ""}`);
    lines.push(`- BV：${thread.source.bvid || ""}`);
    lines.push(`- AV/OID：${thread.source.oid || thread.source.aid || ""}`);
    lines.push(`- 根评论 rpid：${thread.source.rootRpid || ""}`);
    lines.push(`- 选中评论 rpid：${thread.source.selectedRpid || thread.source.rootRpid || ""}`);
    lines.push(`- 导出时间：${formatTime(Date.now() / 1000)}`);

    const expected = thread.exporter.expectedReplyCount;
    lines.push(
      `- 回复数：${thread.exporter.actualReplyCount}` +
      (expected > 0 ? ` / ${expected}` : "")
    );

    if (!thread.exporter.complete) {
      lines.push("- 注意：接口分页提前结束、重复或达到上限，导出结果可能不完整");
    }
  }

  function buildReplyIndex(root, replies) {
    const index = new Map();

    if (root?.rpid) index.set(root.rpid, root);
    for (const reply of replies) {
      if (reply?.rpid) index.set(reply.rpid, reply);
    }

    return index;
  }

  function appendReplyMarkdown(lines, reply, replyIndex) {
    if (!reply) return;

    lines.push(formatReplyHeader(reply, replyIndex));

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

  function formatReplyHeader(reply, replyIndex) {
    const name = reply.user?.name || `mid:${reply.user?.mid || "unknown"}`;
    const parentName = reply.parent && reply.parent !== "0"
      ? replyIndex.get(reply.parent)?.user?.name || ""
      : "";

    const metadata = [];

    if (reply.user?.mid) metadata.push(`UID ${reply.user.mid}`);
    if (reply.time?.local) metadata.push(reply.time.local);

    metadata.push(`点赞 ${toNonNegativeInt(reply.like)}`);

    if (reply.location) metadata.push(reply.location);

    const replyTarget = parentName
      ? ` 回复 **${escapeMarkdown(parentName)}**`
      : "";

    return `- **${escapeMarkdown(name)}**${replyTarget}` +
      (metadata.length ? ` · ${metadata.join(" · ")}` : "");
  }

  // ---------------------------------------------------------------------------
  // HTTP transport with retry and cancellation
  // ---------------------------------------------------------------------------

  async function requestJsonWithRetry(url, task) {
    let lastError = null;

    for (let attempt = 1; attempt <= CONFIG.requestRetries; attempt += 1) {
      throwIfCancelled(task);

      try {
        const payload = await requestJsonOnce(url, task);
        throwIfCancelled(task);

        validateApiPayload(payload);
        return payload;
      } catch (error) {
        if (isCancelledError(error)) throw error;

        lastError = error;
        if (!isRetryableError(error) || attempt === CONFIG.requestRetries) {
          throw error;
        }
      }

      await delay(CONFIG.retryBaseDelayMs * attempt, task);
    }

    throw lastError || new Error("评论接口请求失败");
  }

  function validateApiPayload(payload) {
    if (!payload || typeof payload !== "object") {
      throw new BceTransportError("接口返回为空", true);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "code") && payload.code !== 0) {
      throw new BceApiError(
        Number(payload.code),
        payload.message || payload.msg || `评论接口返回异常：${payload.code}`
      );
    }
  }

  function isRetryableError(error) {
    return error?.retryable !== false;
  }

  function requestJsonOnce(url, task) {
    throwIfCancelled(task);

    return typeof GM_xmlhttpRequest === "function"
      ? requestJsonByGm(url, task)
      : requestJsonByFetch(url, task);
  }

  function requestJsonByGm(url, task) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let requestHandle = null;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTaskAbort(task, abortRequest);
        callback(value);
      };

      const abortRequest = () => {
        try {
          requestHandle?.abort?.();
        } finally {
          finish(reject, new BceCancelledError());
        }
      };

      requestHandle = GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "json",
        anonymous: false,
        withCredentials: true,
        timeout: CONFIG.requestTimeoutMs,
        headers: {
          Accept: "application/json, text/plain, */*",
        },
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            const retryable = response.status === 429 || response.status >= 500;
            finish(
              reject,
              new BceTransportError(
                `网络请求失败：HTTP ${response.status}`,
                retryable
              )
            );
            return;
          }

          if (response.response && typeof response.response === "object") {
            finish(resolve, response.response);
            return;
          }

          try {
            finish(resolve, JSON.parse(response.responseText));
          } catch (error) {
            finish(
              reject,
              new BceTransportError(
                `接口返回不是 JSON：${error.message}`,
                true
              )
            );
          }
        },
        onerror: () => finish(
          reject,
          new BceTransportError("网络请求失败", true)
        ),
        ontimeout: () => finish(
          reject,
          new BceTransportError("网络请求超时", true)
        ),
        onabort: () => finish(reject, new BceCancelledError()),
      });

      bindTaskAbort(task, abortRequest);
    });
  }

  function requestJsonByFetch(url, task) {
    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    bindTaskAbort(task, abortRequest);

    return fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          throw new BceTransportError(
            `网络请求失败：HTTP ${response.status}`,
            retryable
          );
        }
        return response.json();
      })
      .catch((error) => {
        if (error?.name === "AbortError") throw new BceCancelledError();
        throw error;
      })
      .finally(() => {
        clearTaskAbort(task, abortRequest);
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

  // ---------------------------------------------------------------------------
  // Shared utilities and output
  // ---------------------------------------------------------------------------

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
    return reply ? String(reply.rpid_str || reply.rpid || "") : "";
  }

  function getReplyLike(reply) {
    return toNonNegativeInt(reply?.like);
  }

  function toNonNegativeInt(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
  }

  function isElementNode(node) {
    return Boolean(node && node.nodeType === 1);
  }

  function tagNameOf(node) {
    return String(node?.tagName || "").toLowerCase();
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

    document.getElementById(`${META.id}-toast`)?.remove();

    const toast = document.createElement("div");
    toast.id = `${META.id}-toast`;
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
      `background:${getToastBackground(kind)}`,
      "pointer-events:none",
    ].join(";");

    document.body.appendChild(toast);
    window.setTimeout(() => {
      if (toast.isConnected) toast.remove();
    }, kind === "error" ? 5000 : 2600);
  }

  function getToastBackground(kind) {
    if (kind === "error") return "rgba(190,35,35,.94)";
    if (kind === "warning") return "rgba(174,104,0,.94)";
    return "rgba(0,0,0,.84)";
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
