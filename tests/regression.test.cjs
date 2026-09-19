const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name + '.user.js'), 'utf8');
function load(name, marker, injection, extra = {}) {
  const context = vm.createContext({ console, URL, Request, Response, AbortController, DOMException,
    setTimeout, clearTimeout, setInterval, clearInterval, location: { href: 'https://www.bilibili.com/video/BV1234567890', pathname: '/video/BV1234567890' },
    document: {}, window: {}, localStorage: { getItem: () => null }, ...extra });
  const code = source(name);
  assert.ok(code.includes(marker));
  vm.runInContext(code.replace(marker, injection), context);
  return context.api;
}
function xhrClass() {
  return class extends EventTarget {
    open(method, url) { this.url = url; }
    send() { this.sent = (this.sent || 0) + 1; }
    abort() { this.aborted = true; }
    complete(payload, type = '') {
      this.responseType = type; this.response = type === 'json' ? payload : JSON.stringify(payload);
      Object.defineProperty(this, 'responseText', { configurable: true, get: () => {
        if (type === 'json') throw new DOMException('InvalidStateError');
        return this.response;
      }});
      this.dispatchEvent(new Event('load'));
    }
  };
}
function network(extra = {}) {
  return load('make-bilibili-great-again-promax', '    App.init();', '    globalThis.api = NetworkManager;', extra);
}
test('ProMax returns a valid empty 204 for blocked fetch', async () => {
  const response = await network().makeBlockedFetchResult('empty', 'tracker');
  assert.equal(response.status, 204); assert.equal(await response.text(), '');
});
test('ProMax allows a reused XHR after an earlier blocked URL', () => {
  const XHR = xhrClass(); const api = network({ window: { XMLHttpRequest: XHR } });
  api.addRule('test', url => url.includes('blocked') ? { block: true } : null); api.patchXHR();
  const xhr = new XHR(); xhr.open('GET', '/blocked'); xhr.send();
  xhr.open('GET', '/allowed'); xhr.send(); assert.equal(xhr.sent, 1);
});
function exporter(extra = {}) {
  return load('bilibili-comment-thread-exporter', '  boot();', `globalThis.api = { state, patchXhr, patchFetch, looksLikeCommentApi, scheduleScan, fetchThread,
    simplifyReply, formatThreadMarkdown, getReplyLike, getReplyDataFromElement, resolveCommentExportContext,
    setRequest(fn) { requestJson = fn; delay = async () => {}; },
    setScan(fn) { scanPageForCommentTargets = fn; },
    setIngest(fn) { ingestCommentPayload = fn; } };`, extra);
}
test('exporter scan runs despite continuous mutations', () => {
  let serial = 0; const timers = new Map(); let scans = 0;
  const api = exporter({ window: { setTimeout: fn => { timers.set(++serial, fn); return serial; } }, clearTimeout: id => timers.delete(id) });
  api.setScan(() => scans++); api.scheduleScan(600); const first = timers.keys().next().value;
  api.scheduleScan(600); assert.ok(timers.has(first), 'pending scan must not be postponed');
  timers.get(first)(); assert.equal(scans, 1);
  api.scheduleScan(600); assert.ok(timers.has(serial));
});
test('exporter accepts only the actual comment API host and path', () => {
  const api = exporter();
  assert.equal(api.looksLikeCommentApi('https://evil.test/api.bilibili.com/x/v2/reply'), false);
  assert.equal(api.looksLikeCommentApi('https://api.bilibili.com/x/v2/replyFake'), false);
  assert.equal(api.looksLikeCommentApi('https://api.bilibili.com/x/v2/reply/reply?oid=1'), true);
});
test('exporter supports JSON XHR and does not accumulate listeners on reuse', () => {
  const XHR = xhrClass(); const api = exporter(); const received = [];
  api.setIngest(p => received.push(p)); api.patchXhr({ XMLHttpRequest: XHR });
  const xhr = new XHR();
  for (let i = 0; i < 2; i++) { xhr.open('GET', 'https://api.bilibili.com/x/v2/reply'); xhr.send(); xhr.complete({ code: 0, n: i }, 'json'); }
  assert.equal(received.length, 2);
});
test('exporter observer cannot turn successful fetch into a rejection', async () => {
  const response = { clone() { throw new Error('body already consumed'); } };
  const page = { fetch: async () => response }; exporter().patchFetch(page);
  assert.equal(await page.fetch('https://api.bilibili.com/x/v2/reply'), response);
});
test('exporter deduplicates overlapping pages and keeps fetching remaining replies', async () => {
  const api = exporter({ document: { querySelector: () => null, title: 'test' } }); api.state.aid = 1;
  const reply = id => ({ rpid_str: id, root: 1, content: { message: id }, member: {} });
  const pages = [[reply('2'), reply('3')], [reply('3'), reply('4')], [reply('5')]];
  let requests = 0; api.setRequest(async () => ({ code: 0, data: { root: reply('1'), replies: pages[requests++] || [], page: { count: 4 } } }));
  const result = await api.fetchThread('1');
  assert.deepEqual(Array.from(result.replies, r => r.rpid), ['2', '3', '4', '5']); assert.equal(requests, 3);
});
test('exporter preserves like counts and writes them to Markdown', () => {
  const api = exporter({ document: { querySelector: () => null, title: 'test' } });
  const root = api.simplifyReply({ rpid_str: '10001', root: 0, like: '42', ctime: 0, content: { message: 'root' }, member: { uname: 'A' } });
  const child = api.simplifyReply({ rpid_str: '10002', root: 10001, parent: 10001, like: 7, ctime: 0, content: { message: 'child' }, member: { uname: 'B' } });
  assert.equal(root.like, 42);
  assert.equal(child.like, 7);
  const markdown = api.formatThreadMarkdown({
    exporter: { version: 'test', truncated: false },
    source: { title: 'test', url: 'https://example.test', bvid: 'BV1', aid: 1, rootRpid: '10001', selectedRpid: '10001' },
    selected: root,
    root,
    replies: [child],
  });
  assert.match(markdown, /点赞 42/);
  assert.match(markdown, /点赞 7/);
});

test('exporter reads comment ids and roots from Bilibili custom-element __data', () => {
  const api = exporter();
  const element = {
    __data: { rpid_str: '10002', root: 10001, like: 9, content: { message: 'x' }, member: {} },
    getAttribute: () => null,
    querySelectorAll: () => [],
  };
  const data = api.getReplyDataFromElement(element);
  assert.equal(data.rpid_str, '10002');
  const context = api.resolveCommentExportContext(element);
  assert.deepEqual({ ...context }, { rootId: '10001', selectedReplyId: '10002' });
});
function anti(extra = {}) {
  return load('bilibili-comment-anti-fraud-pro', '  init();', `globalThis.api = { patchXhr, requestJson, STATE,
    setObserve(fn) { observeAddCommentResponse = fn; },
    setFetch(fn) { requestJsonByFetch = fn; },
    setGm(fn) { requestJsonByGm = fn; canUseGmXhr = () => true; } };`, extra);
}
test('anti-fraud observes JSON XHR but ignores unrelated reuse', () => {
  const XHR = xhrClass(); const api = anti({ window: { XMLHttpRequest: XHR } }); const received = [];
  api.setObserve((url, text) => received.push(JSON.parse(text))); api.patchXhr();
  const xhr = new XHR(); xhr.open('POST', 'https://api.bilibili.com/x/v2/reply/add'); xhr.send(); xhr.complete({ code: 0 }, 'json');
  xhr.open('GET', 'https://api.bilibili.com/other'); xhr.send(); xhr.complete({ unrelated: true });
  assert.equal(received.length, 1); assert.equal(received[0].code, 0);
});
test('anti-fraud cancellation prevents fallback requests after fetch fails', async () => {
  const api = anti(); let fallback = 0;
  api.setFetch(async () => { api.STATE.cancelVersion++; throw new Error('offline'); });
  api.setGm(async () => { fallback++; return { code: 0 }; });
  await assert.rejects(api.requestJson('https://api.bilibili.com/x/v2/reply', { token: { version: 0 } }), { name: 'BfcCancelledError' });
  assert.equal(fallback, 0);
});
test('live quality applies latest visibility request during menu loading', () => {
  const pending = []; const clicks = [];
  const item = (text, rank) => ({ textContent: text, dataset: { qn: rank }, getAttribute: () => null, click: () => clicks.push(text) });
  let items = []; const high = item('原画', '10000'); const low = item('流畅', '80');
  const doc = { querySelector: selector => selector.includes('.active') ? high : { click() {} }, querySelectorAll: () => items };
  const api = load('bilibili-live-auto-quality', "    document.addEventListener('visibilitychange', () => {", "    globalThis.api = { selectQuality }; return; document.addEventListener('visibilitychange', () => {", { document: doc, setTimeout: fn => pending.push(fn) });
  api.selectQuality('low', false); api.selectQuality('high', false); items = [high, low];
  while (pending.length) pending.shift()();
  assert.equal(clicks.at(-1), '原画');
});
test('exporter stops repeating pages and marks output incomplete', async () => {
  const api = exporter({ document: { querySelector: () => null, title: 'test' } }); api.state.aid = 1;
  let requests = 0; api.setRequest(async () => { requests++; return { code: 0, data: { replies: [{ rpid_str: '2', root: 1 }], page: { count: 99 } } }; });
  const result = await api.fetchThread('1');
  assert.equal(requests, 2); assert.equal(result.replies.length, 1); assert.equal(result.exporter.truncated, true);
});
test('exporter ignores its own panel mutations to avoid endless scan-render cycles', () => {
  let notify; let scheduled = 0;
  const api = load('bilibili-comment-thread-exporter', '  boot();', 'globalThis.api = { observePage }; updateShellVisibility = () => {}; scheduleScan = () => { globalThis.count(); };', {
    MutationObserver: class { constructor(fn) { notify = fn; } observe() {} }, count: () => scheduled++,
  });
  api.observePage();
  notify([{ target: { nodeType: 1, closest: () => ({}) } }]);
  assert.equal(scheduled, 0);
  notify([{ target: { nodeType: 1, closest: () => null } }]); assert.equal(scheduled, 1);
});
