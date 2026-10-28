const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '..', 'bilibili-comment-thread-exporter.user.js'), 'utf8');

function load(extra = {}, code = script) {
  const scope = vm.createContext({
    console, URL, AbortController, setTimeout, clearTimeout,
    window: { setTimeout, clearTimeout },
    location: { href: 'https://www.bilibili.com/video/BV1234567890?p=2&vd_source=private&spm_id_from=track#reply', pathname: '/video/BV1234567890' },
    document: { title: '测试视频', querySelector: () => null },
    ...extra,
  });
  vm.runInContext(code.replace('  boot();', `globalThis.api = {
    CONFIG, runtime, captureVideoSource, cleanVideoUrl, normalizeReply, normalizeSubtitleCues,
    groupSubtitleCues, fetchThread, fetchVideoSubtitles, buildThreadGraph, formatThreadMarkdown,
    requestJsonWithRetry, beginExportTask, cancelActiveTask, delay, getReplyDataFromElement,
    resolveCommentExportContext,
    setRequest(fn) { dependencies.requestJson = fn; },
    setDelay(fn) { dependencies.waitBetweenPages = fn; },
  };`), scope);
  return scope.api;
}

function message(api, id, parent, text = `正文 ${id}`, mid = id) {
  return api.normalizeReply({
    rpid_str: String(id), root_str: id === 1 ? '0' : '1', parent_str: String(parent),
    ctime: 1000 + id, like: id === 1 ? 12 : 0,
    member: { mid: String(mid), uname: '同名用户' }, content: { message: text },
  });
}

function thread(api, replies = [], rootText = '根评论') {
  return {
    source: { title: '排版示例', url: 'https://www.bilibili.com/video/BV1234567890?p=2&vd_source=private',
      bvid: 'BV1234567890', page: 2, rootRpid: '1', selectedRpid: '2', oid: '123' },
    exporter: { complete: true, expectedReplyCount: replies.length, actualReplyCount: replies.length,
      pagesFetched: 1, stopReason: 'complete', exportedAt: '2026-10-28T12:00:00Z' },
    root: message(api, 1, 0, rootText, 10), replies,
  };
}

test('CommonMark rendering preserves literal multiline comments, anchors and relationship line breaks', () => {
  const { Parser, HtmlRenderer } = require('commonmark');
  const { JSDOM } = require('jsdom');
  const api = load();
  const text = '# 假标题\n  > 假引用\n- 假列表\n1) 假列表\n---\n===\n    缩进正文\n<script>literal</script>\n<!--\nvector<int> & 原文\n| 表头 | 表头 |\n| --- | --- |\n~~字面删除线~~\n\n第二段';
  const data = thread(api, [message(api, 2, 1, text), message(api, 3, 2, '最后一条仍可见')]);
  const md = api.formatThreadMarkdown(data);
  const html = new HtmlRenderer().render(new Parser().parse(md));
  const dom = new JSDOM(html);
  try {
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('script, hr, pre, ol').length, 0);
    assert.equal(doc.querySelectorAll('h1').length, 1);
    assert.deepEqual(Array.from(doc.querySelectorAll('h2'), el => el.textContent), ['评论楼层', '导出诊断与关系索引']);
    assert.equal(doc.querySelectorAll('[id="msg-0001"]').length, 1);
    assert.equal(doc.querySelectorAll('[id^="msg-"]').length, 3);
    assert.ok(Array.from(doc.querySelectorAll('p')).some(p => p.textContent.includes('vector<int> & 原文') && p.querySelectorAll('br').length >= 8));
    assert.match(doc.body.textContent, /<!--/);
    assert.match(doc.body.textContent, /最后一条仍可见/);
    const relations = Array.from(doc.querySelectorAll('blockquote')).find(el => el.textContent.includes('直接回复（1）'));
    assert.ok(relations.querySelector('br'));
    for (const link of doc.querySelectorAll('a[href^="#"]')) {
      assert.ok(doc.getElementById(link.getAttribute('href').slice(1)), `missing anchor: ${link.outerHTML}`);
    }
    assert.doesNotMatch(md, /vd_source|private/);
    assert.ok(md.includes('\\| 表头 \\| 表头 \\|'));
    assert.ok(md.includes('\\~\\~字面删除线\\~\\~'));
  } finally { dom.window.close(); }
});

test('disconnected branches preserve local depth and paths without claiming a root depth', () => {
  const api = load();
  const data = thread(api, [message(api, 2, 999), message(api, 3, 2), message(api, 4, 3), message(api, 5, 4)]);
  const graph = api.buildThreadGraph(data);
  assert.equal(graph.nodeById.get('5').depth, null);
  assert.equal(graph.nodeById.get('5').chainDepth, 4);
  assert.equal(graph.nodeById.get('5').missingAncestor, '999');
  const md = api.formatThreadMarkdown(data);
  assert.match(md, /断链 L4（分支内）/);
  assert.match(md, /路径：缺失父消息 rpid 999 → \[0002\]\(#msg-0002\) → \[0003\]/);
  assert.doesNotMatch(md, /路径：\[0001\]/);
});

test('a 1000-message disconnected chain remains iterative with bounded navigation', () => {
  const api = load();
  const replies = Array.from({ length: 1000 }, (_, i) => message(api, i + 2, i === 0 ? 99999 : i + 1));
  const data = thread(api, replies);
  const graph = api.buildThreadGraph(data);
  assert.equal(graph.nodeById.get('1001').chainDepth, 1000);
  const summary = graph.pathSummaryById.get('1001');
  assert.equal(summary.full, null);
  assert.equal(summary.head.length, 2);
  assert.equal(summary.tail.length, 3);
  assert.match(api.formatThreadMarkdown(data), /缺失父消息 rpid 99999/);
});

test('root author and repeated speech use UID and never merge same-name distinct users', () => {
  const api = load();
  const data = thread(api, [message(api, 2, 1, '层主再次发言', 10), message(api, 3, 2, '另一个同名用户', 20)]);
  const graph = api.buildThreadGraph(data);
  assert.equal(graph.nodeById.get('2').isLayerAuthor, true);
  assert.equal(graph.nodeById.get('2').authorOrdinal, 2);
  assert.equal(graph.nodeById.get('3').isLayerAuthor, false);
  assert.equal(graph.nodeById.get('3').authorTotal, 1);
  assert.match(api.formatThreadMarkdown(data), /层主 · 第 2 次发言 · 导出入口/);
});

test('non-root large fanouts retain full linked indexes while the root index is omitted', () => {
  const api = load();
  const replies = [message(api, 2, 1), ...Array.from({ length: 30 }, (_, i) => message(api, i + 3, 2))];
  const md = api.formatThreadMarkdown(thread(api, replies));
  assert.match(md, /children-0002/);
  assert.match(md, /另有 18 条/);
  assert.doesNotMatch(md, /children-0001/);
  assert.match(md, /#### \[0002\] 的直接回复（30）/);
});

test('empty terminal pages report an unknown count discrepancy rather than a truncation', async () => {
  const api = load();
  let calls = 0;
  api.setDelay(async () => {});
  api.setRequest(async () => ({ code: 0, data: {
    root: { rpid_str: '1' }, page: { count: 3 },
    replies: calls++ === 0 ? [{ rpid_str: '2', parent_str: '1', content: { message: '返回的回复' } }] : [],
  } }));
  const data = await api.fetchThread({ oid: '123', rootId: '1', selectedReplyId: '1' });
  assert.equal(data.exporter.complete, false);
  assert.equal(data.exporter.truncated, false);
  assert.equal(data.exporter.paginationComplete, true);
  assert.equal(data.exporter.stopReason, 'empty-page');
  assert.equal(data.exporter.countGap, 2);
  const md = api.formatThreadMarkdown(data);
  assert.match(md, /原因无法确定/);
  assert.doesNotMatch(md, /分页提前停止|差额.*为.*已删/);
});

test('subtitle paragraphs preserve order, repetition and multiline cues with deterministic boundaries', () => {
  const api = load();
  const cues = api.normalizeSubtitleCues([
    { from: 0, to: 1, content: '相同台词' }, { from: 1, to: 2, content: '相同台词' },
    { from: 5, to: 6, content: '停顿之后' }, { from: 6, to: 7, content: 'English\n中文' },
    { from: 7, to: 8, content: '下一句' },
  ]);
  assert.deepEqual(Array.from(api.groupSubtitleCues(cues)), ['相同台词 相同台词', '停顿之后', 'English\n中文', '下一句']);
  assert.deepEqual(Array.from(api.groupSubtitleCues(api.normalizeSubtitleCues([
    { from: 0, content: '没有结束时间' }, { from: 2, content: '继续' }, { from: 10, content: '长停顿' },
  ]))), ['没有结束时间 继续', '长停顿']);
  const long = api.groupSubtitleCues(api.normalizeSubtitleCues(Array.from({ length: 200 }, (_, i) => ({ from: i, to: i + 1, content: `台词${i}` }))));
  assert.ok(long.length > 1 && long.length < 15);
  assert.ok(long.every(p => Array.from(p).length <= api.CONFIG.subtitleParagraphChars));
});

test('plain subtitle paragraphs reduce long-export noise without dropping words', () => {
  const api = load();
  const cues = api.normalizeSubtitleCues(Array.from({ length: 1000 }, (_, i) => ({ from: i, to: i + 1, content: `字幕${i}` })));
  const data = thread(api, Array.from({ length: 500 }, (_, i) => message(api, i + 2, 1)));
  data.subtitles = { status: 'ok', label: '中文', cues };
  const md = api.formatThreadMarkdown(data);
  assert.equal((md.match(/字幕\d+/g) || []).length, 1000);
  assert.equal((md.match(/<a id="msg-/g) || []).length, 501);
  assert.doesNotMatch(md, /^---$/m);
  assert.doesNotMatch(md, /children-0001/);
  assert.ok(md.indexOf('## 视频字幕正文') < md.indexOf('## 评论楼层'));
});

test('CDN JSON is validated separately from Bilibili business envelopes', async () => {
  const api = load({ GM_xmlhttpRequest(options) {
    queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify({ code: 7, body: [{ content: '字幕' }] }) }));
    return { abort() {} };
  } });
  const payload = await api.requestJsonWithRetry('https://aisubtitle.hdslb.com/a', undefined, { maxAttempts: 1, expectBiliEnvelope: false });
  assert.equal(payload.body[0].content, '字幕');
  await assert.rejects(api.requestJsonWithRetry('https://api.bilibili.com/a', undefined, { maxAttempts: 1 }), { name: 'BceApiError', code: 7 });
});

test('real GM transport retries one transient failure and decodes responseText', async () => {
  let calls = 0;
  const api = load({ GM_xmlhttpRequest(options) {
    queueMicrotask(() => {
      if (++calls === 1) options.onerror({ status: 0 });
      else options.onload({ status: 200, responseText: '{"code":0,"data":{"ok":true}}' });
    });
    return { abort() {} };
  } });
  api.setDelay(async () => {});
  const result = await api.requestJsonWithRetry('https://api.bilibili.com/a', undefined, { maxAttempts: 2 });
  assert.equal(result.data.ok, true);
  assert.equal(calls, 2);
  await assert.rejects(api.requestJsonWithRetry('https://api.bilibili.com/a', undefined, { maxAttempts: 0 }), { name: 'RangeError' });
});

test('HTTP 403 fails once without a retry storm', async () => {
  let calls = 0;
  const api = load({ GM_xmlhttpRequest(options) {
    calls++;
    queueMicrotask(() => options.onload({ status: 403 }));
    return { abort() {} };
  } });
  await assert.rejects(api.requestJsonWithRetry('https://api.bilibili.com/a', undefined, { maxAttempts: 3 }), /HTTP 403/);
  assert.equal(calls, 1);
});

test('cancelling a task interrupts long waits immediately and clears the timer', async () => {
  let cleared = false;
  const api = load({ window: { setTimeout: () => 123, clearTimeout }, clearTimeout(id) { assert.equal(id, 123); cleared = true; } });
  const task = api.beginExportTask();
  const waiting = api.delay(60000, task);
  api.cancelActiveTask();
  await assert.rejects(waiting, { name: 'BceCancelledError' });
  assert.equal(cleared, true);
  assert.equal(task.abortCurrentRequest, null);
});

test('video source strips tracking and fills absent BV and title from matching view metadata', async () => {
  const api = load({ location: { href: 'https://www.bilibili.com/video/av123?p=2&vd_source=private#reply', pathname: '/video/av123' } });
  const source = api.captureVideoSource({ oid: '123', type: 1 });
  assert.equal(source.url, 'https://www.bilibili.com/video/av123?p=2');
  api.setRequest(async raw => new URL(raw).pathname.endsWith('/view')
    ? { code: 0, data: { aid: 123, bvid: 'BV1234567890', title: '真实标题', pages: [{ page: 2, cid: 200 }] } }
    : { code: 0, data: { subtitle: { subtitles: [] } } });
  assert.equal((await api.fetchVideoSubtitles(source)).status, 'unavailable');
  assert.equal(source.bvid, 'BV1234567890');
  assert.equal(source.title, '真实标题');
});

test('an authoritative empty subtitle list does not request a redundant fallback', async () => {
  const api = load();
  let playerCalls = 0;
  api.setRequest(async raw => new URL(raw).pathname.endsWith('/view')
    ? { data: { aid: 123, pages: [{ page: 2, cid: 200 }] } }
    : (playerCalls++, { data: { subtitle: { subtitles: [] } } }));
  const result = await api.fetchVideoSubtitles(api.captureVideoSource({ oid: '123', type: 1 }));
  assert.equal(playerCalls, 1);
  assert.match(result.reason, /未提供平台字幕轨道/);
});

test('comment data fallback reads only known component hosts and wrapped data', () => {
  const api = load();
  const data = { rpid_str: '2', root_str: '1', oid_str: '123', type: 1 };
  const host = { tagName: 'BILI-COMMENT-REPLY-RENDERER', wrappedJSObject: { __data: data } };
  assert.equal(api.resolveCommentExportContext({}, [host]).selectedReplyId, '2');
  assert.equal(api.resolveCommentExportContext({}, [{ tagName: 'DIV', __data: data }]), null);
});
