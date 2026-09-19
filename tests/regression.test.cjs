const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = name => fs.readFileSync(path.join(__dirname, '..', name + '.user.js'), 'utf8');

function load(name, marker, injection, extra = {}) {
  const context = vm.createContext({
    console,
    URL,
    Request,
    Response,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: {
      href: 'https://www.bilibili.com/video/BV1234567890',
      pathname: '/video/BV1234567890',
    },
    document: {},
    window: {},
    localStorage: { getItem: () => null },
    ...extra,
  });

  const code = source(name);
  assert.ok(code.includes(marker), `missing marker in ${name}`);
  vm.runInContext(code.replace(marker, injection), context);
  return context.api;
}

function xhrClass() {
  return class extends EventTarget {
    open(method, url) { this.url = url; }
    send() { this.sent = (this.sent || 0) + 1; }
    abort() { this.aborted = true; }
    complete(payload, type = '') {
      this.responseType = type;
      this.response = type === 'json' ? payload : JSON.stringify(payload);
      Object.defineProperty(this, 'responseText', {
        configurable: true,
        get: () => {
          if (type === 'json') throw new DOMException('InvalidStateError');
          return this.response;
        },
      });
      this.dispatchEvent(new Event('load'));
    }
  };
}

function network(extra = {}) {
  return load(
    'make-bilibili-great-again-promax',
    '    App.init();',
    '    globalThis.api = NetworkManager;',
    extra
  );
}

function exporter(extra = {}) {
  return load(
    'bilibili-comment-thread-exporter',
    '  boot();',
    `globalThis.api = {
      runtime,
      CONFIG,
      EXPORT_ACTIONS,
      findMoreButtonTrigger,
      findCommentActionRendererInPath,
      findBiliCommentMenuHost,
      getReplyDataFromElement,
      resolveCommentExportContext,
      ensureMenuAction,
      fetchThread,
      normalizeReply,
      formatThreadMarkdown,
      buildThreadGraph,
      beginExportTask,
      cancelActiveTask,
      makeContextKey,
      getReplyLike,
      setRequest(fn) { dependencies.requestJson = fn; },
      setDelay(fn) { dependencies.waitBetweenPages = fn; },
    };`,
    extra
  );
}

function anti(extra = {}) {
  return load(
    'bilibili-comment-anti-fraud-pro',
    '  init();',
    `globalThis.api = {
      patchXhr,
      requestJson,
      STATE,
      setObserve(fn) { observeAddCommentResponse = fn; },
      setFetch(fn) { requestJsonByFetch = fn; },
      setGm(fn) { requestJsonByGm = fn; canUseGmXhr = () => true; },
    };`,
    extra
  );
}

test('ProMax returns a valid empty 204 for blocked fetch', async () => {
  const response = await network().makeBlockedFetchResult('empty', 'tracker');
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
});

test('ProMax allows a reused XHR after an earlier blocked URL', () => {
  const XHR = xhrClass();
  const api = network({ window: { XMLHttpRequest: XHR } });
  api.addRule('test', url => url.includes('blocked') ? { block: true } : null);
  api.patchXHR();

  const xhr = new XHR();
  xhr.open('GET', '/blocked');
  xhr.send();
  xhr.open('GET', '/allowed');
  xhr.send();

  assert.equal(xhr.sent, 1);
});

test('exporter 1.0.5 keeps the event-driven architecture and no legacy scanners', () => {
  const code = source('bilibili-comment-thread-exporter');
  assert.match(code, /@version\s+1\.0\.5/);
  assert.doesNotMatch(code, /function\s+patchFetch\b/);
  assert.doesNotMatch(code, /function\s+patchXhr\b/);
  assert.doesNotMatch(code, /function\s+observePage\b/);
  assert.doesNotMatch(code, /function\s+scanPageForCommentTargets\b/);
  assert.doesNotMatch(code, /function\s+ensureShell\b/);
});

test('exporter 1.0.5 is download-only and contains no clipboard path', () => {
  const code = source('bilibili-comment-thread-exporter');
  assert.doesNotMatch(code, /导出本楼/);
  assert.doesNotMatch(code, /GM_setClipboard/);
  assert.doesNotMatch(code, /navigator\.clipboard/);
  assert.doesNotMatch(code, /function\s+copyText\b/);
  assert.doesNotMatch(code, /destination:\s*["']clipboard["']/);
  assert.match(code, /导出为 MD/);
  assert.match(code, /text\/markdown;charset=utf-8/);
});

test('exporter resolves the clicked root comment directly from action renderer __data', () => {
  const api = exporter();
  const action = {
    tagName: 'BILI-COMMENT-ACTION-BUTTONS-RENDERER',
    __data: {
      rpid: 314390848657,
      rpid_str: '314390848657',
      root: 0,
      root_str: '0',
      oid: 117290507045669,
      oid_str: '117290507045669',
      type: 1,
      like: 67,
      member: { mid: '325888754', uname: '狐鸽鸽儿' },
      content: { message: '测试根评论' },
      reply_control: { location: 'IP属地：重庆' },
    },
  };

  const context = api.resolveCommentExportContext(action);
  assert.deepEqual(
    {
      oid: context.oid,
      type: context.type,
      rootId: context.rootId,
      selectedReplyId: context.selectedReplyId,
    },
    {
      oid: '117290507045669',
      type: 1,
      rootId: '314390848657',
      selectedReplyId: '314390848657',
    }
  );
});

test('exporter resolves a sub reply to its root while preserving selected rpid', () => {
  const api = exporter();
  const action = {
    __data: {
      rpid_str: '20002',
      root_str: '20001',
      root: 20001,
      oid_str: '123',
      type: 1,
      content: { message: 'sub' },
      member: {},
    },
  };

  const context = api.resolveCommentExportContext(action);
  assert.equal(context.rootId, '20001');
  assert.equal(context.selectedReplyId, '20002');
});

test('exporter recognizes the actual Bilibili three-dot button path and menu host', () => {
  const api = exporter();
  const menuHost = { tagName: 'BILI-COMMENT-MENU' };
  const more = {
    nodeType: 1,
    id: 'more',
    querySelector: selector => selector === 'bili-comment-menu' ? menuHost : null,
  };
  const button = {
    nodeType: 1,
    tagName: 'BUTTON',
    parentElement: more,
  };
  const action = {
    tagName: 'BILI-COMMENT-ACTION-BUTTONS-RENDERER',
    shadowRoot: { querySelector: () => menuHost },
  };
  const path = [button, more, action];

  assert.equal(api.findMoreButtonTrigger(path), button);
  assert.equal(api.findCommentActionRendererInPath(path), action);
  assert.equal(api.findBiliCommentMenuHost(path, action), menuHost);
});

test('exporter injects only one Markdown download menu item', () => {
  const api = exporter({ document: { createElement: makeLi } });
  const appended = [];
  const template = makeLi();

  const options = {
    querySelector(selector) {
      if (selector === 'li') return template;
      const match = selector.match(/data-bce-action="([^"]+)"/);
      if (!match) return null;
      return appended.find(item =>
        item.classNameSet.has('bce-menu-export-item') &&
        item.dataset.bceAction === match[1]
      ) || null;
    },
    appendChild(item) {
      appended.push(item);
      item.isConnected = true;
    },
  };

  const context = {
    oid: '123',
    type: 1,
    rootId: '10001',
    selectedReplyId: '10001',
  };

  for (const action of api.EXPORT_ACTIONS) {
    api.ensureMenuAction(options, context, action);
  }
  api.ensureMenuAction(options, context, api.EXPORT_ACTIONS[0]);

  assert.equal(api.EXPORT_ACTIONS.length, 1);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].textContent, '导出为 MD');
  assert.equal(appended[0].dataset.bceAction, 'download-md');
});

function makeLi() {
  const classNameSet = new Set();
  return {
    tagName: 'LI',
    dataset: {},
    style: {},
    classNameSet,
    classList: { add: value => classNameSet.add(value) },
    textContent: '',
    title: '',
    isConnected: false,
    cloneNode: () => makeLi(),
    removeAttribute() {},
    addEventListener() {},
    setAttribute() {},
    remove() { this.removed = true; },
  };
}

test('exporter paginates, deduplicates and flattens replies', async () => {
  const api = exporter({
    document: { querySelector: () => null, title: '测试视频' },
  });

  const reply = (id, parent = '1', extra = {}) => ({
    rpid_str: id,
    root_str: id === '1' ? '0' : '1',
    root: id === '1' ? 0 : 1,
    parent_str: id === '1' ? '0' : parent,
    parent: id === '1' ? 0 : Number(parent),
    ctime: 1789787077,
    like: Number(id),
    member: { mid: id, uname: `用户${id}` },
    content: { message: `回复${id}` },
    reply_control: { location: `IP属地：地区${id}` },
    ...extra,
  });

  const pages = [
    [reply('2', '1', { replies: [reply('3', '2')] })],
    [reply('3', '2'), reply('4', '1')],
    [reply('5', '1')],
  ];

  let requestIndex = 0;
  api.setRequest(async () => ({
    code: 0,
    data: {
      root: reply('1', '0'),
      replies: pages[requestIndex++] || [],
      page: { count: 4 },
    },
  }));
  api.setDelay(async () => {});

  const result = await api.fetchThread({
    oid: '123',
    type: 1,
    rootId: '1',
    selectedReplyId: '3',
    seedReply: reply('3', '2'),
  });

  assert.equal(result.exporter.version, '1.0.5');
  assert.equal(result.exporter.duplicateReplyCount, 1);
  assert.equal(result.exporter.complete, true);
  assert.equal(result.exporter.expectedReplyCount, 4);
  assert.equal(result.exporter.actualReplyCount, 4);
  assert.deepEqual(Array.from(result.replies, item => item.rpid), ['2', '3', '4', '5']);
  assert.equal(result.selected.rpid, '3');
  assert.equal(result.selected.location, 'IP属地：地区3');
  assert.equal(result.root.like, 1);
});

test('exporter marks repeated pagination as incomplete', async () => {
  const api = exporter({
    document: { querySelector: () => null, title: '测试视频' },
  });
  const root = {
    rpid_str: '1',
    root: 0,
    member: {},
    content: { message: 'root' },
  };
  const child = {
    rpid_str: '2',
    root: 1,
    parent: 1,
    member: {},
    content: { message: 'child' },
  };

  let requests = 0;
  api.setRequest(async () => {
    requests += 1;
    return {
      code: 0,
      data: { root, replies: [child], page: { count: 99 } },
    };
  });
  api.setDelay(async () => {});

  const result = await api.fetchThread({
    oid: '123',
    type: 1,
    rootId: '1',
    selectedReplyId: '1',
    seedReply: root,
  });

  assert.equal(requests, 2);
  assert.equal(result.exporter.complete, false);
  assert.equal(result.exporter.truncated, true);
  assert.equal(result.exporter.actualReplyCount, 1);
});

test('exporter Markdown includes likes, UID, IP location and reply target', () => {
  const api = exporter({
    document: { querySelector: () => null, title: '测试视频' },
  });

  const root = api.normalizeReply({
    rpid_str: '1',
    root: 0,
    parent: 0,
    ctime: 1789787077,
    like: 67,
    member: { mid: '10', uname: '根用户' },
    content: { message: '根评论' },
    reply_control: { location: 'IP属地：重庆' },
  });
  const child = api.normalizeReply({
    rpid_str: '2',
    root: 1,
    parent: 1,
    ctime: 1789787078,
    like: 8,
    member: { mid: '20', uname: '回复用户' },
    content: { message: '回复正文' },
    reply_control: { location: 'IP属地：广东' },
  });

  const markdown = api.formatThreadMarkdown({
    exporter: {
      complete: true,
      actualReplyCount: 1,
      expectedReplyCount: 1,
    },
    source: {
      title: '测试视频',
      url: 'https://www.bilibili.com/video/BV1234567890',
      bvid: 'BV1234567890',
      oid: '123',
      rootRpid: '1',
      selectedRpid: '2',
    },
    selected: child,
    root,
    replies: [child],
  });

  assert.match(markdown, /<a id="msg-0001"><\/a>/);
  assert.match(markdown, /<a id="msg-0002"><\/a>/);
  assert.match(markdown, /点赞 67/);
  assert.match(markdown, /UID 10/);
  assert.match(markdown, /IP属地：重庆/);
  assert.match(markdown, /回复 \[0001\]\(#msg-0001\) 根用户$/m);
  assert.doesNotMatch(markdown, /回复 \[0001\]\(#msg-0001\) 根用户：「根评论」/);
  assert.match(markdown, /直接回复（1）：\[0002\]\(#msg-0002\) 回复用户/);
  assert.match(markdown, /IP属地：广东/);
  assert.doesNotMatch(markdown, /## 选中的评论/);
  assert.doesNotMatch(markdown, /schema v/i);
});

test('exporter 1.0.5 suppresses shallow redundancy but keeps deep navigation', () => {
  const api = exporter({
    document: { querySelector: () => null, title: '测试视频' },
  });

  const make = (id, parent, message) => api.normalizeReply({
    rpid_str: String(id),
    root: id === 1 ? 0 : 1,
    parent,
    ctime: 1789787000 + id,
    member: { mid: String(id), uname: `用户${id}` },
    content: { message },
  });

  const root = make(1, 0, '这是会被大量 L1 回复重复引用的根评论摘要');
  const replies = [
    make(2, 1, '第一层'),
    make(3, 2, '第二层'),
    make(4, 3, '第三层'),
    make(5, 4, '第四层'),
  ];

  const thread = {
    exporter: { complete: true, actualReplyCount: 4, expectedReplyCount: 4 },
    source: { title: '密度测试', url: '', bvid: '', oid: '1', rootRpid: '1', selectedRpid: '5' },
    root,
    replies,
  };

  const markdown = api.formatThreadMarkdown(thread);

  assert.match(markdown, /回复 \[0001\]\(#msg-0001\) 用户1$/m);
  assert.doesNotMatch(markdown, /回复 \[0001\]\(#msg-0001\) 用户1：「/);

  assert.match(markdown, /回复 \[0002\]\(#msg-0002\) 用户2：「第一层」/);
  assert.match(markdown, /回复 \[0003\]\(#msg-0003\) 用户3：「第二层」/);
  assert.match(markdown, /回复 \[0004\]\(#msg-0004\) 用户4：「第三层」/);

  assert.doesNotMatch(markdown, /路径：\[0001\]\(#msg-0001\) → \[0002\]\(#msg-0002\) → \[0003\]\(#msg-0003\)$/m);
  assert.doesNotMatch(markdown, /路径：\[0001\]\(#msg-0001\) → \[0002\]\(#msg-0002\)$/m);
  assert.match(markdown, /路径：\[0001\]\(#msg-0001\) → \[0002\]\(#msg-0002\) → \[0003\]\(#msg-0003\) → \[0004\]\(#msg-0004\) → \[0005\]\(#msg-0005\)/);
});

test('exporter graph keeps deep reply chains flat and precise', () => {
  const api = exporter({
    document: { querySelector: () => null, title: '测试视频' },
  });

  const make = (id, parent, message) => api.normalizeReply({
    rpid_str: String(id),
    root: id === 1 ? 0 : 1,
    parent,
    ctime: 1789787000 + id,
    member: { mid: String(id), uname: `用户${id}` },
    content: { message },
  });

  const root = make(1, 0, '根');
  const replies = [
    make(2, 1, '第一层'),
    make(3, 2, '第二层'),
    make(4, 3, '第三层'),
    make(5, 4, '第四层'),
    make(6, 5, '第五层'),
    make(7, 6, '第六层'),
  ];

  const thread = {
    exporter: { complete: true, actualReplyCount: 6, expectedReplyCount: 6 },
    source: { title: '深链', url: '', bvid: '', oid: '1', rootRpid: '1', selectedRpid: '7' },
    selected: replies.at(-1),
    root,
    replies,
  };

  const graph = api.buildThreadGraph(thread);
  const markdown = api.formatThreadMarkdown(thread);

  assert.equal(graph.nodeById.get('7').depth, 6);
  assert.match(markdown, /回复 \[0006\]\(#msg-0006\) 用户6：「第五层」/);
  assert.match(markdown, /路径：\[0001\]\(#msg-0001\) → … → \[0005\]\(#msg-0005\) → \[0006\]\(#msg-0006\) → \[0007\]\(#msg-0007\)/);
  assert.doesNotMatch(markdown, /^ {4,}/m);
});


test('exporter 1.0.4 distinguishes explicit, inferred, missing and abnormal relations', () => {
  const api = exporter({
    document: { querySelector: () => null, title: '测试视频' },
  });

  const make = (id, parent, root = 1, ctime = 1000 + id) => api.normalizeReply({
    rpid_str: String(id),
    root,
    parent,
    ctime,
    member: { mid: String(id), uname: `用户${id}` },
    content: { message: `消息${id}` },
  });

  const thread = {
    exporter: {
      complete: true,
      actualReplyCount: 5,
      expectedReplyCount: 5,
      duplicateReplyCount: 2,
    },
    source: {
      title: '关系校验',
      url: '',
      bvid: '',
      oid: '1',
      rootRpid: '1',
      selectedRpid: '2',
    },
    root: make(1, 0, 0, 1000),
    replies: [
      make(2, 1, 1, 1001),
      make(3, 0, 1, 1002),
      make(4, 999, 1, 1003),
      make(5, 5, 1, 1004),
      make(6, 1, 777, 999),
    ],
  };

  const graph = api.buildThreadGraph(thread);
  const markdown = api.formatThreadMarkdown(thread);

  assert.equal(graph.integrity.total, 5);
  assert.equal(graph.integrity.explicitResolved, 2);
  assert.equal(graph.integrity.inferred, 1);
  assert.equal(graph.integrity.missing, 1);
  assert.equal(graph.integrity.abnormal, 2);

  assert.equal(graph.relationById.get('2').source, 'explicit');
  assert.equal(graph.relationById.get('3').source, 'root');
  assert.equal(graph.relationById.get('4').source, 'explicit');

  assert.ok(graph.issuesById.get('5').has('self-cycle'));
  assert.ok(graph.issuesById.get('6').has('cross-root'));
  assert.ok(graph.issuesById.get('6').has('time-reversal'));

  assert.match(markdown, /关系完整度：2 \/ 5/);
  assert.match(markdown, /推断关系：1/);
  assert.match(markdown, /缺失父消息：1（涉及 1 条回复）/);
  assert.match(markdown, /异常关系：2/);
  assert.match(markdown, /重复 rpid：2/);
  assert.match(markdown, /推断回复 \[0001\]\(#msg-0001\)/);
  assert.match(markdown, /关系异常索引/);
});

test('exporter 1.0.4 detects multi-node cycles without recursion', () => {
  const api = exporter({
    document: { querySelector: () => null, title: '测试视频' },
  });

  const make = (id, parent) => api.normalizeReply({
    rpid_str: String(id),
    root: 1,
    parent,
    ctime: 1000 + id,
    member: { mid: String(id), uname: `用户${id}` },
    content: { message: `消息${id}` },
  });

  const graph = api.buildThreadGraph({
    exporter: { complete: true, actualReplyCount: 3, expectedReplyCount: 3 },
    source: { title: '环', url: '', bvid: '', oid: '1', rootRpid: '1', selectedRpid: '2' },
    root: api.normalizeReply({
      rpid_str: '1',
      root: 0,
      parent: 0,
      ctime: 999,
      member: { mid: '1', uname: '根' },
      content: { message: '根' },
    }),
    replies: [
      make(2, 3),
      make(3, 4),
      make(4, 2),
    ],
  });

  assert.equal(graph.nodeById.get('2').depth, null);
  assert.equal(graph.nodeById.get('3').depth, null);
  assert.equal(graph.nodeById.get('4').depth, null);
  assert.ok(graph.issuesById.get('2').has('cycle'));
  assert.ok(graph.issuesById.get('3').has('cycle'));
  assert.ok(graph.issuesById.get('4').has('cycle'));
  assert.equal(graph.integrity.abnormal, 3);
});

test('exporter 1.0.4 handles a 1000-level chain with bounded breadcrumbs', () => {
  const api = exporter({
    document: { querySelector: () => null, title: '测试视频' },
  });

  const root = api.normalizeReply({
    rpid_str: '1',
    root: 0,
    parent: 0,
    ctime: 1000,
    member: { mid: '1', uname: '根' },
    content: { message: '根' },
  });

  const replies = [];
  for (let id = 2; id <= 1001; id += 1) {
    replies.push(api.normalizeReply({
      rpid_str: String(id),
      root: 1,
      parent: id - 1,
      ctime: 1000 + id,
      member: { mid: String(id), uname: `用户${id}` },
      content: { message: `消息${id}` },
    }));
  }

  const thread = {
    exporter: { complete: true, actualReplyCount: 1000, expectedReplyCount: 1000 },
    source: { title: '千层深链', url: '', bvid: '', oid: '1', rootRpid: '1', selectedRpid: '1001' },
    root,
    replies,
  };

  const graph = api.buildThreadGraph(thread);
  const markdown = api.formatThreadMarkdown(thread);
  const deepest = graph.nodeById.get('1001');

  assert.equal(deepest.depth, 1000);
  assert.equal(graph.integrity.explicitResolved, 1000);
  assert.equal(graph.integrity.abnormal, 0);
  assert.match(markdown, /路径：\[0001\]\(#msg-0001\) → … → \[0999\]\(#msg-0999\) → \[1000\]\(#msg-1000\) → \[1001\]\(#msg-1001\)/);
  assert.doesNotMatch(markdown, /^ {4,}/m);
});

test('exporter 1.0.4 keeps a 500-reply fanout bounded in the main body', () => {
  const api = exporter({
    document: { querySelector: () => null, title: '测试视频' },
  });

  const root = api.normalizeReply({
    rpid_str: '1',
    root: 0,
    parent: 0,
    ctime: 1000,
    member: { mid: '1', uname: '根' },
    content: { message: '根' },
  });

  const replies = [];
  for (let id = 2; id <= 501; id += 1) {
    replies.push(api.normalizeReply({
      rpid_str: String(id),
      root: 1,
      parent: 1,
      ctime: 1000 + id,
      member: { mid: String(id), uname: `用户${id}` },
      content: { message: `消息${id}` },
    }));
  }

  const thread = {
    exporter: { complete: true, actualReplyCount: 500, expectedReplyCount: 500 },
    source: { title: '大分叉', url: '', bvid: '', oid: '1', rootRpid: '1', selectedRpid: '1' },
    root,
    replies,
  };

  const graph = api.buildThreadGraph(thread);
  const markdown = api.formatThreadMarkdown(thread);

  assert.equal(graph.childrenById.get('1').length, 500);
  assert.equal(graph.integrity.explicitResolved, 500);
  assert.match(markdown, /直接回复（500）：/);
  assert.match(markdown, /另有 488 条，见 \[完整索引\]\(#children-0001\)/);
  assert.match(markdown, /### \[0001\] 的直接回复（500）/);
});

test('starting a new export task cancels and aborts the previous task', () => {
  const api = exporter();
  let aborted = 0;

  const first = api.beginExportTask();
  first.abortCurrentRequest = () => { aborted += 1; };
  const second = api.beginExportTask();

  assert.equal(first.cancelled, true);
  assert.equal(aborted, 1);
  assert.equal(second.cancelled, false);
  assert.equal(api.runtime.export.activeTask, second);
});

test('anti-fraud observes JSON XHR but ignores unrelated reuse', () => {
  const XHR = xhrClass();
  const api = anti({ window: { XMLHttpRequest: XHR } });
  const received = [];

  api.setObserve((url, text) => received.push(JSON.parse(text)));
  api.patchXhr();

  const xhr = new XHR();
  xhr.open('POST', 'https://api.bilibili.com/x/v2/reply/add');
  xhr.send();
  xhr.complete({ code: 0 }, 'json');
  xhr.open('GET', 'https://api.bilibili.com/other');
  xhr.send();
  xhr.complete({ unrelated: true });

  assert.equal(received.length, 1);
  assert.equal(received[0].code, 0);
});

test('anti-fraud cancellation prevents fallback requests after fetch fails', async () => {
  const api = anti();
  let fallback = 0;

  api.setFetch(async () => {
    api.STATE.cancelVersion++;
    throw new Error('offline');
  });
  api.setGm(async () => {
    fallback++;
    return { code: 0 };
  });

  await assert.rejects(
    api.requestJson('https://api.bilibili.com/x/v2/reply', { token: { version: 0 } }),
    { name: 'BfcCancelledError' }
  );
  assert.equal(fallback, 0);
});

test('live quality applies latest visibility request during menu loading', () => {
  const pending = [];
  const clicks = [];
  const item = (text, rank) => ({
    textContent: text,
    dataset: { qn: rank },
    getAttribute: () => null,
    click: () => clicks.push(text),
  });
  let items = [];
  const high = item('原画', '10000');
  const low = item('流畅', '80');
  const doc = {
    querySelector: selector => selector.includes('.active') ? high : { click() {} },
    querySelectorAll: () => items,
  };

  const api = load(
    'bilibili-live-auto-quality',
    "    document.addEventListener('visibilitychange', () => {",
    "    globalThis.api = { selectQuality }; return; document.addEventListener('visibilitychange', () => {",
    { document: doc, setTimeout: fn => pending.push(fn) }
  );

  api.selectQuality('low', false);
  api.selectQuality('high', false);
  items = [high, low];
  while (pending.length) pending.shift()();

  assert.equal(clicks.at(-1), '原画');
});
