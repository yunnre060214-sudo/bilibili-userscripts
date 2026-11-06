const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'bilibili-live-prophecy.user.js'), 'utf8');

function installRuntime(window, sdk) {
  const cache = new Map();
  const require = id => {
    if (!cache.has(id)) {
      const module = { exports: {} };
      cache.set(id, module);
      require.m[id](module, module.exports, require);
    }
    return cache.get(id).exports;
  };
  require.m = { 1171(module, exports) { exports.Ay = sdk; } };
  const queue = window.webpackChunkguessing_game = [];
  queue.push = record => {
    Object.assign(require.m, record[1]);
    record[2]?.(require);
    return Array.prototype.push.call(queue, record);
  };
  return require;
}

function setup(t, { mobile = false, existing = false, cached = false, workspace = false, prepare, url = 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978#/' } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><main id="app">${workspace ? '<div class="user-detail-content"><button id="return-focus">选项</button></div>' : '官方组件 fixture'}</main></body></html>`, {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', event => errors.push(event.message));
  t.after(() => {
    window.dispatchEvent(new window.Event('pagehide'));
    dom.window.close();
    assert.deepEqual(errors, [], 'unexpected desktop runtime error');
  });
  window.unsafeWindow = window;
  if (mobile) Object.defineProperty(window.navigator, 'userAgent', { value: 'BiliApp iPhone', configurable: true });
  const nativeConfirm = () => new Promise(() => {});
  const sdk = {
    getEnvSync: () => mobile ? 1 : -1,
    getUserInfo: async () => ({ uid: 1937432404, isLogin: true }),
    Request: function OfficialRequest() {},
    showConfirm: nativeConfirm, showModal: nativeConfirm, showAlert: nativeConfirm,
    showToast: nativeConfirm, openView: nativeConfirm,
  };
  const chunk = [[504], { 1171(module, exports) { exports.Ay = sdk; } }];
  window.webpackChunkguessing_game = existing ? [chunk] : [];
  if (cached) installRuntime(window, sdk)(1171);
  prepare?.(window);
  window.eval(source);
  const execute = record => {
    const exports = {};
    record[1][1171]({}, exports, () => {});
    return exports.Ay;
  };
  return {
    window, sdk, chunk, execute, nativeConfirm,
    load() { window.webpackChunkguessing_game.push(chunk); return execute(chunk); },
    root: () => window.document.getElementById('bili-prophecy-desktop')?.shadowRoot,
    workspace: () => window.document.getElementById('bili-prophecy-workspace')?.shadowRoot,
    button(action) {
      const button = this.root()?.querySelector(`[data-desktop-action="${action}"]`);
      assert.ok(button, `missing desktop ${action}`);
      return button;
    },
  };
}

test('desktop confirmation opens a real dialog and resolves only after manual confirmation', async t => {
  const app = setup(t);
  assert.equal(app.root().querySelector('.badge'), null);
  app.load();
  assert.equal(app.root().querySelector('.badge'), null);
  assert.doesNotMatch(app.root().textContent, /桌面交互适配已启用|等待官方组件/);
  let resolved = false;
  const result = app.sdk.showConfirm({ title: '这把能不能自摸？', content: '我猜：不能\n猜对将获得：3（硬币）', confirmText: '确认', cancelText: '再想想' });
  result.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.match(app.root()?.querySelector('[role="dialog"]')?.textContent || '', /不能/);
  app.button('confirm').click();
  const outcome = await result;
  assert.equal(outcome.confirm, true);
  assert.equal(outcome.cancel, false);
  assert.equal(app.root().querySelector('[role="dialog"]'), null);
});

test('an embedded official page has no status badge and still opens confirmation', async t => {
  const parent = new JSDOM('<!doctype html><iframe src="https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978#/"></iframe>', {
    url: 'https://live.bilibili.com/13233348', runScripts: 'outside-only',
  });
  const page = parent.window.document.querySelector('iframe').contentWindow;
  const errors = [];
  page.addEventListener('error', event => errors.push(event.message));
  t.after(() => {
    page.dispatchEvent(new page.Event('pagehide'));
    parent.window.close();
    assert.deepEqual(errors, [], 'unexpected embedded desktop runtime error');
  });
  page.document.write('<!doctype html><html><body><main id="app">官方组件 fixture</main></body></html>');
  page.document.close();
  page.unsafeWindow = page;
  const sdk = { getEnvSync: () => -1, showConfirm: () => new Promise(() => {}), Request: function OfficialRequest() {} };
  installRuntime(page, sdk)(1171);
  page.eval(source);
  const root = page.document.getElementById('bili-prophecy-desktop').shadowRoot;
  assert.equal(root.querySelector('.badge'), null);
  const pending = sdk.showConfirm({ title: '嵌入页确认', content: '不能' });
  assert.equal(root.querySelector('[role="dialog"] h2').textContent, '嵌入页确认');
  root.querySelector('[data-desktop-action="cancel"]').click();
  assert.equal((await pending).confirm, false);
});

test('cancel and Escape never confirm participation', async t => {
  const app = setup(t);
  app.load();
  const cancel = app.sdk.showConfirm({ title: '预言', content: '不能' });
  app.button('cancel').click();
  assert.equal((await cancel).confirm, false);
  const escape = app.sdk.showConfirm({ title: '预言', content: '不能' });
  app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal((await escape).confirm, false);
});

test('Tab and Shift+Tab keep keyboard focus inside the confirmation dialog', async t => {
  const app = setup(t);
  app.load();
  const pending = app.sdk.showConfirm({ title: '键盘导航', content: '本地测试' });
  app.button('confirm').focus();
  const forward = new app.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  app.window.document.dispatchEvent(forward);
  assert.equal(forward.defaultPrevented, true);
  assert.equal(app.root().activeElement, app.button('cancel'));
  const backward = new app.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  app.window.document.dispatchEvent(backward);
  assert.equal(backward.defaultPrevented, true);
  assert.equal(app.root().activeElement, app.button('confirm'));
  app.button('cancel').click();
  await pending;
});

test('the adapter preserves the official request and account implementations', t => {
  const app = setup(t);
  const request = app.sdk.Request, userInfo = app.sdk.getUserInfo;
  app.load();
  assert.notEqual(app.sdk.showConfirm, app.nativeConfirm);
  assert.equal(app.sdk.Request, request);
  assert.equal(app.sdk.getUserInfo, userInfo);
});

test('App and mobile environments keep their native bridge', t => {
  const app = setup(t, { mobile: true });
  app.load();
  assert.equal(app.sdk.showConfirm, app.nativeConfirm);
  assert.equal(app.root(), undefined);
});

test('webpack replacing push still receives the patched factory before registration', t => {
  const app = setup(t);
  let registered;
  app.window.webpackChunkguessing_game.push = record => { registered = record[1][1171]; return 1; };
  app.window.webpackChunkguessing_game.push(app.chunk);
  const exports = {};
  registered({}, exports, () => {});
  assert.notEqual(exports.Ay.showConfirm, app.nativeConfirm);
});

test('SDK chunks queued before the userscript runs are adapted', t => {
  const app = setup(t, { existing: true });
  app.execute(app.chunk);
  assert.notEqual(app.sdk.showConfirm, app.nativeConfirm);
});

test('an SDK evaluated before userscript injection still shows manual confirmation', async t => {
  const app = setup(t, { cached: true });
  assert.notEqual(app.sdk.showConfirm, app.nativeConfirm);
  const pending = app.sdk.showConfirm({ title: '晚加载验证', content: '本地模拟' });
  assert.match(app.root()?.querySelector('[role="dialog"]')?.textContent || '', /晚加载验证/);
  app.button('cancel').click();
  assert.equal((await pending).confirm, false);
});

test('a sandbox with a separate global adapts the actual page window', async t => {
  const page = setup(t, { mobile: true });
  Object.defineProperty(page.window.navigator, 'userAgent', { value: 'Desktop Chrome', configurable: true });
  const sandbox = new JSDOM('<html><body></body></html>', {
    url: page.window.location.href, runScripts: 'outside-only',
  });
  t.after(() => sandbox.window.close());
  sandbox.window.unsafeWindow = page.window;
  page.sdk.getEnvSync = () => -1;
  installRuntime(page.window, page.sdk)(1171);
  sandbox.window.eval(source);
  assert.notEqual(page.sdk.showConfirm, page.nativeConfirm);
  const pending = page.sdk.showConfirm({ title: '页面窗口', content: '在实际页面内显示' });
  assert.ok(page.root()?.querySelector('[role="dialog"]'));
  assert.equal(sandbox.window.document.getElementById('bili-prophecy-desktop'), null);
  page.button('cancel').click();
  await pending;
});

test('confirmation text is rendered as text rather than HTML', async t => {
  const app = setup(t);
  app.load();
  const pending = app.sdk.showConfirm({ title: '<img src=x onerror=alert(1)>', content: '<script>bad</script>' });
  assert.equal(app.root()?.querySelectorAll('img, script').length, 0);
  assert.match(app.root()?.textContent || '', /<script>bad<\/script>/);
  app.button('cancel').click();
  await pending;
});

test('desktop toast makes the official success or error message visible', async t => {
  const app = setup(t);
  app.load();
  const pending = app.sdk.showToast({ msg: '完成预言，请等待结算' });
  assert.match(app.root()?.querySelector('[role="status"]')?.textContent || '', /完成预言/);
  await pending;
});

test('showModal invokes the official callback with the manual choice', async t => {
  const app = setup(t);
  app.load();
  let callbackResult;
  const pending = app.sdk.showModal({ title: '硬币不足', content: '如何获取硬币', callback: result => { callbackResult = result; } });
  app.button('cancel').click();
  await pending;
  assert.equal(callbackResult.confirm, false);
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const navigate = (page, action) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('expected official hash navigation')), 1000);
  page.addEventListener('hashchange', () => { clearTimeout(timeout); resolve(); }, { once: true });
  action();
});

test('workspace links use official hashes and preserve the original query', async t => {
  const app = setup(t, { workspace: true });
  await flush();
  const root = app.workspace();
  assert.ok(root, 'missing official page workspace');
  const current = root.querySelector('[data-view="current"]');
  const history = root.querySelector('[data-view="history"]');
  assert.equal(current.getAttribute('aria-current'), 'page');
  await navigate(app.window, () => history.click());
  assert.equal(app.window.location.hash, '#/history');
  assert.equal(app.window.location.search, '?anchorId=353609978');
  assert.equal(history.getAttribute('aria-current'), 'page');
  await navigate(app.window, () => current.click());
  assert.equal(app.window.location.hash, '#/');
});

test('workspace is hidden on rules routes and restores when returning to predictions', async t => {
  const app = setup(t, { workspace: true });
  await flush();
  const host = app.window.document.getElementById('bili-prophecy-workspace');
  assert.ok(host);
  await navigate(app.window, () => { app.window.location.hash = '/rule'; });
  assert.equal(host.hidden, true);
  await navigate(app.window, () => { app.window.location.hash = '/'; });
  assert.equal(host.hidden, false);
});

test('history without an anchor disables current navigation but leaves records accessible', async t => {
  const app = setup(t, { workspace: true, url: 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html#/history' });
  await flush();
  const current = app.workspace()?.querySelector('[data-view="current"]');
  assert.ok(current);
  assert.equal(current.getAttribute('aria-disabled'), 'true');
  current.click();
  assert.equal(app.window.location.hash, '#/history');
  assert.equal(app.workspace().querySelector('[data-view="history"]').getAttribute('aria-current'), 'page');
});

test('workspace waits for official content and does not duplicate after reinjection', async t => {
  const app = setup(t);
  assert.equal(app.workspace(), undefined);
  app.window.document.getElementById('app').innerHTML = '<div class="user-detail-content"></div>';
  await flush();
  assert.ok(app.workspace());
  app.window.eval(source);
  await flush();
  assert.equal(app.window.document.querySelectorAll('#bili-prophecy-workspace').length, 1);
});

test('confirmation locks scroll and content then restores the original state and focus', async t => {
  const app = setup(t, { workspace: true });
  app.load();
  await flush();
  const doc = app.window.document;
  doc.body.style.overflow = 'scroll';
  const content = doc.getElementById('app');
  content.inert = false;
  const focus = doc.getElementById('return-focus');
  focus.focus();
  const pending = app.sdk.showConfirm({ title: '选择', content: '需要确认' });
  assert.equal(doc.body.style.overflow, 'hidden');
  assert.equal(content.inert, true);
  assert.equal(app.workspace().querySelector('[data-workspace-action="refresh"]').disabled, true);
  app.button('cancel').click();
  assert.equal((await pending).confirm, false);
  assert.equal(doc.body.style.overflow, 'scroll');
  assert.equal(content.inert, false);
  assert.equal(doc.activeElement, focus);
  assert.equal(app.workspace().querySelector('[data-workspace-action="refresh"]').disabled, false);
});

test('confirmation preserves content that was already inert before opening', async t => {
  const app = setup(t, { workspace: true });
  app.load();
  const content = app.window.document.getElementById('app');
  content.inert = true;
  const pending = app.sdk.showConfirm({ title: '选择', content: '保留原状态' });
  app.button('cancel').click();
  await pending;
  assert.equal(content.inert, true);
});

test('workspace cannot navigate away while a confirmation is pending', async t => {
  const app = setup(t, { workspace: true });
  app.load();
  await flush();
  const pending = app.sdk.showConfirm({ title: '选择', content: '确认之前保留页面' });
  app.workspace().querySelector('[data-view="history"]').click();
  await flush();
  assert.equal(app.window.location.hash, '#/');
  app.button('cancel').click();
  await pending;
  await navigate(app.window, () => app.workspace().querySelector('[data-view="history"]').click());
  assert.equal(app.window.location.hash, '#/history');
});

test('hiding the page cancels an unconfirmed choice and restores scroll', async t => {
  const app = setup(t, { workspace: true });
  app.load();
  const pending = app.sdk.showConfirm({ title: '选择', content: '页面离开时取消' });
  Object.defineProperty(app.window.document, 'hidden', { configurable: true, value: true });
  app.window.document.dispatchEvent(new app.window.Event('visibilitychange'));
  const outcome = await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve('still pending')))]);
  assert.notEqual(outcome, 'still pending');
  assert.equal(outcome.confirm, false);
  assert.equal(app.window.document.body.style.overflow, '');
});

test('removing a dialog container cancels its choice and permits a new confirmation', async t => {
  const app = setup(t, { workspace: true });
  app.load();
  const pending = app.sdk.showConfirm({ title: '选择', content: '容器重建' });
  app.window.document.getElementById('bili-prophecy-desktop').remove();
  await flush();
  const outcome = await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve('still pending')))]);
  assert.notEqual(outcome, 'still pending');
  assert.equal(outcome.confirm, false);
  const next = app.sdk.showConfirm({ title: '再次选择', content: '仍能取消' });
  assert.ok(app.root().querySelector('[role="dialog"]'));
  app.button('cancel').click();
  assert.equal((await next).confirm, false);
});

test('replacing a pending dialog cancels the old choice without leaking scroll locks', async t => {
  const app = setup(t);
  app.load();
  app.window.document.body.style.overflow = 'auto';
  const first = app.sdk.showConfirm({ title: '第一题', content: '旧选项' });
  const second = app.sdk.showConfirm({ title: '第二题', content: '新选项' });
  assert.equal((await first).confirm, false);
  assert.equal(app.window.document.body.style.overflow, 'hidden');
  app.button('cancel').click();
  await second;
  assert.equal(app.window.document.body.style.overflow, 'auto');
  assert.equal(app.root().querySelectorAll('[role="dialog"]').length, 0);
});

test('a synchronous toast after root removal cancels the detached confirmation and releases the page', async t => {
  const app = setup(t, { workspace: true });
  app.load();
  const doc = app.window.document;
  doc.body.style.overflow = 'auto';
  const content = doc.getElementById('app');
  content.inert = false;
  const pending = app.sdk.showConfirm({ title: '待确认', content: '容器移除后立即提示' });
  doc.getElementById('bili-prophecy-desktop').remove();
  app.sdk.showToast({ msg: '页面已更新' });
  await flush();
  const outcome = await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve('still pending')))]);
  assert.notEqual(outcome, 'still pending');
  assert.equal(outcome.confirm, false);
  assert.equal(doc.body.style.overflow, 'auto');
  assert.equal(content.inert, false);
  assert.equal(app.root().querySelector('.toast').hidden, false);
  assert.match(app.root().querySelector('.toast').textContent, /页面已更新/);
  const next = app.sdk.showConfirm({ title: '再次选择', content: '恢复后可以操作' });
  app.button('cancel').click();
  assert.equal((await next).confirm, false);
  assert.equal(doc.body.style.overflow, 'auto');
  assert.equal(content.inert, false);
});

function historyCard({ question, status, answer = '会赢', coins, anchor = '测试主播' }) {
  return `<article class="item-content"><div class="title-line"><span class="title">${question}</span><span class="sub">${status}</span></div><div class="line mt10"><span class="sub">题目答案：</span><span class="text-content">${answer}</span><span class="sub ml20">硬币：</span><span class="text-content">${coins}</span></div><div class="line mt8"><span class="sub">主播名称：</span><span class="text-content">${anchor}</span></div></article>`;
}

function currentCard({ question, ticket, countdown, net, status, potential }) {
  let aside = '';
  if (countdown) aside = `<div class="tick-block"><div class="line"><span class="tickey">门票：</span><span class="tickey">${ticket ?? ''}</span></div><div class="line"><span class="count-time">${countdown}</span><span class="count ml4">截止</span></div></div>`;
  else if (net) aside = `<div class="line"><div class="line"><span class="${String(net).startsWith('+') ? 'pinkText' : 'count'}">${net}</span></div></div>`;
  else if (status) aside = `<div class="line"><span class="count">${status}</span></div>`;
  const hint = potential ? `<span class="sub-score">预言成功得${potential}硬币</span>` : '';
  return `<article class="content-prohets-box"><div class="text-line"><span class="title">${question}</span>${aside}</div><div class="line mt8"><div class="bigbox"><div class="box"><div class="block"><span class="count-time">会</span>${hint}</div></div></div></div></article>`;
}

async function showBoard(t, html, hash = '#/') {
  const app = setup(t, { workspace: true, url: `https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978${hash}` });
  app.window.document.getElementById('app').innerHTML = html;
  await flush();
  await flush();
  return app;
}

function summaryOf(app) {
  const summary = app.window.document.querySelector('.bili-prophecy-summary');
  assert.ok(summary, 'missing net summary');
  const stat = range => {
    const node = summary.querySelector(`[data-bili-range="${range}"]`);
    assert.ok(node, `missing ${range} total`);
    return {
      kicker: node.querySelector('.bili-prophecy-summary-kicker').textContent,
      value: node.querySelector('.bili-prophecy-summary-value').textContent,
      sign: node.dataset.biliSign,
    };
  };
  return { summary, note: summary.querySelector('.bili-prophecy-summary-note').textContent, today: stat('today'), all: stat('all') };
}

test('prophecy 1.3.0 is the version declared to users', () => {
  assert.equal(source.match(/^\/\/ @version\s+(\S+)/m)[1], '1.3.0');
  assert.match(source, /const VERSION = '1\.3\.0'/);
  assert.match(source, /@grant\s+GM_getValue/);
  assert.match(source, /@grant\s+GM_setValue/);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /^## B站直播预言 1\.3\.0$/m);
  assert.match(readme, /安装 B站直播预言 1\.3\.0/);
});

test('history lays out the newest prediction and sums settled coin changes', async t => {
  const app = await showBoard(t, `<div class="content" data-v-00192e7f><div class="header"><span class="title">我的预言</span></div>${[
    historyCard({ question: '一月旧题', status: '2026-01-02 08:00:00', coins: '+5' }),
    historyCard({ question: '三月新题', status: '2026-03-04 09:30:00', coins: '--' }),
    historyCard({ question: '二月题', status: '2026-02-02 10:00:00', coins: '-2' }),
    historyCard({ question: '持平题', status: '2026-02-02 11:00:00', coins: '0' }),
  ].join('')}</div>`, '#/history');
  const cards = [...app.window.document.querySelectorAll('.item-content')];
  assert.equal(cards.filter(card => card.querySelector('.bili-prophecy-new')).length, 1);
  assert.equal(cards[1].querySelector('.bili-prophecy-new').textContent, '新');
  assert.equal(cards[1].classList.contains('bili-prophecy-latest'), true);
  assert.equal(cards[1].querySelector('.title').firstElementChild, cards[1].querySelector('.bili-prophecy-new'));
  assert.deepEqual(cards.map(card => card.dataset.biliSign), ['plus', 'unknown', 'minus', 'zero']);
  assert.equal(cards[1].querySelector('.sub.ml20').getAttribute('aria-label'), '净收益');
  const net = summaryOf(app);
  assert.equal(net.today.kicker, '今天');
  assert.equal(net.today.value, '0 硬币');
  assert.equal(net.today.sign, 'zero');
  assert.equal(net.all.kicker, '历史以来（近 4 条）');
  assert.equal(net.all.value, '+3 硬币');
  assert.equal(net.all.sign, 'plus');
  assert.match(net.note, /未结算和未参与不计入/);
  assert.match(net.note, /这 4 条/);
  const css = app.window.document.getElementById('bili-prophecy-theme').textContent;
  assert.match(css, /\.bili-prophecy-new/);
  assert.match(css, /content:\s*"净收益"/);
  assert.doesNotMatch(css, /repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});

test('an open history record is newest only when it is listed before dated records', async t => {
  const openFirst = await showBoard(t, `<div class="content" data-v-00192e7f>${[
    historyCard({ question: '仍在进行', status: '进行中', coins: '--' }),
    historyCard({ question: '已公布', status: '2026-11-06 12:00:00', coins: '+1' }),
  ].join('')}</div>`, '#/history');
  assert.equal(openFirst.window.document.querySelector('.bili-prophecy-latest .title').textContent, '新仍在进行');

  const datedNewest = await showBoard(t, `<div class="content" data-v-00192e7f>${[
    historyCard({ question: '较早', status: '2026-01-01 00:00:00', coins: '+1' }),
    historyCard({ question: '仍在进行', status: '等待结算', coins: '--' }),
    historyCard({ question: '更晚公布', status: '2026-05-01 00:00:00', coins: '-4' }),
  ].join('')}</div>`, '#/history');
  assert.match(datedNewest.window.document.querySelector('.bili-prophecy-latest .title').textContent, /更晚公布/);
  assert.equal(summaryOf(datedNewest).all.value, '-3 硬币');
  assert.equal(summaryOf(datedNewest).all.sign, 'minus');
  assert.equal(summaryOf(datedNewest).today.value, '0 硬币');
});

test('equal publish times keep the earlier card, and invalid dates are ignored', async t => {
  const app = await showBoard(t, `<div class="content" data-v-00192e7f>${[
    historyCard({ question: '并列靠前', status: '2026-04-01 00:00:00', coins: '+1000' }),
    historyCard({ question: '非法日期', status: '2026-02-31 00:00:00', coins: '+9' }),
    historyCard({ question: '并列靠后', status: '2026-04-01 00:00:00', coins: '+234' }),
  ].join('')}</div>`, '#/history');
  assert.match(app.window.document.querySelector('.bili-prophecy-latest .title').textContent, /并列靠前/);
  assert.equal(summaryOf(app).all.value, '+1,243 硬币');
  assert.equal(summaryOf(app).today.value, '—');
  assert.equal(app.window.document.querySelectorAll('.item-content')[1].dataset.biliSign, 'plus');
});

test('missing history coin changes stay unknown and are not treated as zero', async t => {
  const app = await showBoard(t, `<div class="content" data-v-00192e7f>${[
    historyCard({ question: '取消的预言', status: '主播取消', coins: '--' }),
    historyCard({ question: '另一条', status: '未开始', coins: '  ' }),
  ].join('')}</div>`, '#/history');
  const cards = [...app.window.document.querySelectorAll('.item-content')];
  assert.match(cards[0].querySelector('.title').textContent, /^新/);
  assert.equal(cards[1].querySelector('.bili-prophecy-new'), null);
  assert.deepEqual(cards.map(card => card.dataset.biliSign), ['unknown', 'unknown']);
  const net = summaryOf(app);
  assert.equal(net.today.value, '0 硬币');
  assert.equal(net.all.value, '0 硬币');
  assert.equal(net.all.sign, 'zero');
  assert.match(net.note, /未结算和未参与不计入/);
});

test('current board badges the first card and sums only signed settled results', async t => {
  const app = await showBoard(t, `<div class="user-detail-content"><div class="content mb20"><span class="title">预言</span></div>${[
    currentCard({ question: '正在进行', ticket: '10', countdown: '03:20' }),
    currentCard({ question: '猜对了', net: '+4' }),
    currentCard({ question: '猜错了', net: '-1' }),
    currentCard({ question: '等结果', status: '等待结算', potential: '12' }),
  ].join('')}</div>`);
  const cards = [...app.window.document.querySelectorAll('.content-prohets-box')];
  assert.equal(cards[0].querySelector('.bili-prophecy-new').textContent, '新');
  assert.equal(cards.filter(card => card.querySelector('.bili-prophecy-new')).length, 1);
  assert.equal(cards[1].querySelector('.bili-prophecy-settled-net').classList.contains('is-plus'), true);
  assert.equal(cards[2].querySelector('.bili-prophecy-settled-net').classList.contains('is-minus'), true);
  assert.equal(cards[3].querySelector('.bili-prophecy-settled-net'), null);
  const net = summaryOf(app);
  assert.equal(net.today.value, '—');
  assert.equal(net.today.sign, 'unknown');
  assert.equal(net.all.kicker, '历史以来（近 4 条）');
  assert.equal(net.all.value, '+3 硬币');
  assert.equal(net.all.sign, 'plus');
  assert.doesNotMatch(`${net.today.value} ${net.all.value}`, /10|12/);
  assert.match(net.note, /今天无法计算/);
});

test('a settled current board without timestamps badges the first card and can net to zero', async t => {
  const app = await showBoard(t, `<div class="user-detail-content">${[
    currentCard({ question: '后出现的结算', net: '+2' }),
    currentCard({ question: '更早的进行中', ticket: '1', countdown: '00:05' }),
    currentCard({ question: '另一场', net: '-2' }),
  ].join('')}</div>`);
  assert.match(app.window.document.querySelector('.bili-prophecy-latest .title').textContent, /后出现的结算/);
  assert.equal(summaryOf(app).all.value, '0 硬币');
  assert.equal(summaryOf(app).all.sign, 'zero');
  assert.equal(summaryOf(app).today.value, '—');
  assert.match(summaryOf(app).note, /今天无法计算/);
});

test('annotation stays single after repeat mutations and disappears when the cards do', async t => {
  const app = await showBoard(t, `<div class="content" data-v-00192e7f>${[
    historyCard({ question: '会变化', status: '2026-06-01 00:00:00', coins: '+5' }),
    historyCard({ question: '固定', status: '2026-05-01 00:00:00', coins: '-2' }),
  ].join('')}</div>`, '#/history');
  assert.equal(summaryOf(app).all.value, '+3 硬币');
  app.window.document.body.append(app.window.document.createElement('i'));
  await flush();
  assert.equal(app.window.document.querySelectorAll('.bili-prophecy-new').length, 1);
  assert.equal(app.window.document.querySelectorAll('.bili-prophecy-summary').length, 1);
  app.window.document.querySelector('.text-content:last-child').textContent = '+8';
  await flush();
  assert.equal(summaryOf(app).all.value, '+6 硬币');
  app.window.document.getElementById('app').innerHTML = '<div class="user-detail-content"></div>';
  await flush();
  assert.equal(app.window.document.querySelector('.bili-prophecy-summary'), null);
  assert.equal(app.window.document.querySelector('.bili-prophecy-new'), null);
});

function apiRecord({ id, status = 3, publish, change, answer = 1 }) {
  return {
    prophet: { prophet_id: id, prophet_status: status, publish_time: publish, question: { question: `题目${id}` } },
    my_answer: answer,
    smh_num_change: change,
    anchor_name: '测试主播',
  };
}

function jsonPage(records, extra = {}) {
  return { ok: true, status: 200, json: async () => ({ code: 0, data: { prophet_history: records, ...extra } }) };
}

const waitFor = async predicate => {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('timed out waiting for history totals');
};

async function showFetched(t, fetchImpl) {
  const app = setup(t, { workspace: true, url: 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978#/history' });
  app.window.fetch = fetchImpl;
  app.load();
  app.window.document.getElementById('app').innerHTML = `<div class="content" data-v-00192e7f>${historyCard({ question: '页面占位', status: '进行中', coins: '--' })}</div>`;
  await flush();
  return app;
}

test('today uses the local midnight boundary and ignores unsettled rows', async t => {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const seconds = date => Math.floor(date.getTime() / 1000);
  const records = [
    apiRecord({ id: 1, publish: seconds(new Date(midnight.getTime() - 1000)), change: 5 }),
    apiRecord({ id: 2, publish: seconds(midnight), change: 3 }),
    apiRecord({ id: 3, publish: seconds(new Date(midnight.getTime() + 1000)), change: -1 }),
    apiRecord({ id: 4, publish: seconds(new Date(now.getTime() + 60 * 1000)), change: 9 }),
    apiRecord({ id: 5, publish: seconds(now), change: 7, status: 2 }),
    apiRecord({ id: 6, publish: seconds(now), change: 4, answer: 0 }),
    apiRecord({ id: 7, publish: seconds(now), change: null }),
  ];
  let calls = 0;
  const app = await showFetched(t, async () => { calls += 1; return jsonPage(records); });
  await waitFor(() => summaryOf(app).today.value === '+2 硬币');
  const net = summaryOf(app);
  assert.equal(net.today.sign, 'plus');
  assert.equal(net.all.value, '+16 硬币');
  assert.equal(net.all.kicker, '历史以来');
  assert.match(net.note, /已累计全部 4 条已结算记录/);
  assert.equal(calls, 1);
});

test('explicit history pages are fetched sequentially and duplicates are not summed twice', async t => {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const today = Math.floor(new Date(midnight.getTime() + 60 * 1000).getTime() / 1000);
  const older = Math.floor(new Date(midnight.getTime() - 24 * 60 * 60 * 1000).getTime() / 1000);
  const calls = [];
  const app = await showFetched(t, async url => {
    calls.push({ url: String(url), at: Date.now() });
    const cursor = new URL(url).searchParams.get('cursor');
    if (cursor === 'p2') {
      return jsonPage([
        apiRecord({ id: 3, publish: older, change: 4 }),
        apiRecord({ id: 1, publish: today, change: 8 }),
      ]);
    }
    return jsonPage([
      apiRecord({ id: 1, publish: today, change: 8 }),
      apiRecord({ id: 2, publish: older, change: -2 }),
    ], { has_more: true, next_cursor: 'p2' });
  });
  await waitFor(() => summaryOf(app).all.value === '+10 硬币');
  assert.equal(summaryOf(app).today.value, '+8 硬币');
  assert.equal(summaryOf(app).all.kicker, '历史以来');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].at - calls[0].at >= 300, 'pages should be requested one after another');
  assert.match(calls[1].url, /cursor=p2/);
  app.window.document.body.append(app.window.document.createElement('i'));
  await flush();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls.length, 2);
  app.window.document.querySelector('.title-line > .sub').textContent = '等待结算';
  await flush();
  await waitFor(() => calls.length >= 3);
  assert.equal(summaryOf(app).all.value, '+10 硬币');
});

test('a 100-row history response is labeled as a partial all-time total', async t => {
  const older = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60;
  const records = Array.from({ length: 100 }, (_, index) => apiRecord({ id: index + 1, publish: older, change: 1 }));
  let calls = 0;
  const app = await showFetched(t, async () => { calls += 1; return jsonPage(records); });
  await waitFor(() => summaryOf(app).all.value === '+100 硬币');
  const started = new Date();
  const pad = number => String(number).padStart(2, '0');
  const expected = `历史以来（自 ${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())} 起累计）`;
  assert.equal(summaryOf(app).all.kicker, expected);
  assert.equal(summaryOf(app).today.value, '0 硬币');
  assert.match(summaryOf(app).note, /更早没读到的记录不在合计里/);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls, 1);
});

test('a failed history read falls back to the visible page and says so', async t => {
  let calls = 0;
  const app = setup(t, { workspace: true, url: 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978#/history' });
  app.window.fetch = async () => { calls += 1; throw new TypeError('offline'); };
  app.load();
  app.window.document.getElementById('app').innerHTML = `<div class="content" data-v-00192e7f>${historyCard({ question: '昨天结算', status: '2020-01-02 08:00:00', coins: '+5' })}</div>`;
  await flush();
  await waitFor(() => /这次没能更新接口/.test(summaryOf(app).note));
  const net = summaryOf(app);
  assert.equal(net.today.value, '0 硬币');
  assert.equal(net.all.value, '+5 硬币');
  assert.match(net.all.kicker, /^历史以来（自 \d{4}-\d{2}-\d{2} 起累计）$/);
  assert.match(net.note, /这次没能更新接口/);
  assert.equal(calls, 2);
});

function installMemoryStore(store) {
  return window => {
    window.GM_getValue = (key, fallback = null) => (store.has(key) ? store.get(key) : fallback);
    window.GM_setValue = (key, value) => { store.set(key, value); };
  };
}

async function openStoredHistory(t, store, fetchImpl, uid = 1937432404) {
  const app = setup(t, {
    workspace: true,
    prepare: installMemoryStore(store),
    url: 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978#/history',
  });
  app.sdk.getUserInfo = async () => ({ uid, isLogin: true });
  app.window.fetch = fetchImpl;
  app.load();
  app.window.document.getElementById('app').innerHTML = `<div class="content" data-v-00192e7f>${historyCard({ question: '页面占位', status: '进行中', coins: '--' })}</div>`;
  await flush();
  return app;
}

test('later history fetches keep older saved records instead of double counting', async t => {
  const store = new Map();
  const older = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
  let phase = 1;
  const app = await openStoredHistory(t, store, async () => jsonPage(phase === 1
    ? [apiRecord({ id: 1, publish: older, change: 5 }), apiRecord({ id: 2, publish: older, change: 3 })]
    : [apiRecord({ id: 2, publish: older, change: 3 }), apiRecord({ id: 3, publish: older, change: 4 })]));
  await waitFor(() => summaryOf(app).all.value === '+8 硬币');
  phase = 2;
  app.window.document.querySelector('.title-line > .sub').textContent = '等待结算';
  await flush();
  await waitFor(() => summaryOf(app).all.value === '+12 硬币');
  assert.equal(summaryOf(app).all.kicker, '历史以来');
  const saved = JSON.parse(store.values().next().value);
  assert.deepEqual(Object.keys(saved.users['1937432404'].records).sort(), ['1', '2', '3']);
});

test('saved history stays separated by Bilibili uid', async t => {
  const store = new Map();
  const older = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
  let uid = 111;
  const app = await openStoredHistory(t, store, async () => jsonPage([
    apiRecord({ id: uid, publish: older, change: uid === 111 ? 5 : 9 }),
  ]), 111);
  await waitFor(() => summaryOf(app).all.value === '+5 硬币');
  uid = 222;
  app.sdk.getUserInfo = async () => ({ uid: 222, isLogin: true });
  app.window.document.querySelector('.title-line > .sub').textContent = '等待结算';
  await flush();
  await waitFor(() => summaryOf(app).all.value === '+9 硬币');
  uid = 111;
  app.sdk.getUserInfo = async () => ({ uid: 111, isLogin: true });
  app.window.document.querySelector('.title-line > .sub').textContent = '进行中';
  await flush();
  await waitFor(() => summaryOf(app).all.value === '+5 硬币');
  const saved = JSON.parse(store.values().next().value);
  assert.equal(saved.users['111'].records['111'].change, 5);
  assert.equal(saved.users['222'].records['222'].change, 9);
});

test('saved history survives a new page load', async t => {
  const store = new Map();
  const older = Math.floor(Date.now() / 1000) - 4 * 24 * 60 * 60;
  const first = await openStoredHistory(t, store, async () => jsonPage([apiRecord({ id: 7, publish: older, change: 6 })]));
  await waitFor(() => summaryOf(first).all.value === '+6 硬币');
  const second = await openStoredHistory(t, store, async () => jsonPage([apiRecord({ id: 8, publish: older, change: 1 })]));
  await waitFor(() => summaryOf(second).all.value === '+7 硬币');
  assert.equal(summaryOf(second).all.kicker, '历史以来');
});

test('the archive cap drops the oldest saved records and stops claiming completeness', async t => {
  const store = new Map();
  const records = {};
  for (let index = 1; index <= 2000; index += 1) records[String(index)] = { id: String(index), change: 1, publishedMs: index, title: '', anchor: '' };
  store.set('bili-prophecy-archive-v1', JSON.stringify({
    version: 1,
    users: { '1937432404': { startedAt: new Date(2026, 0, 2, 12).getTime(), complete: true, records } },
  }));
  const fresh = Math.floor(Date.now() / 1000);
  const app = await openStoredHistory(t, store, async () => jsonPage([apiRecord({ id: 99999, publish: fresh, change: 5 })]));
  await waitFor(() => summaryOf(app).all.value === '+2,004 硬币');
  assert.equal(summaryOf(app).all.kicker, '历史以来（自 2026-01-02 起累计）');
  const saved = JSON.parse(store.get('bili-prophecy-archive-v1'));
  assert.equal(Object.keys(saved.users['1937432404'].records).length, 2000);
  assert.equal(saved.users['1937432404'].records['1'], undefined);
  assert.equal(saved.users['1937432404'].complete, false);
});

test('broken or unavailable storage still shows the current history response', async t => {
  const app = setup(t, {
    workspace: true,
    prepare(window) {
      window.GM_getValue = () => { throw new Error('blocked'); };
      window.GM_setValue = () => { throw new Error('blocked'); };
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    },
    url: 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978#/history',
  });
  const older = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  app.window.fetch = async () => jsonPage([apiRecord({ id: 4, publish: older, change: 5 })]);
  app.load();
  app.window.document.getElementById('app').innerHTML = `<div class="content" data-v-00192e7f>${historyCard({ question: '页面占位', status: '进行中', coins: '--' })}</div>`;
  await flush();
  await waitFor(() => summaryOf(app).all.value === '+5 硬币');
  assert.equal(summaryOf(app).all.kicker, '历史以来');
  assert.match(summaryOf(app).note, /接口返回的全部 1 条/);
});

test('a corrupt archive is replaced instead of breaking the total', async t => {
  const store = new Map();
  store.set('bili-prophecy-archive-v1', '{"version":99,"users":"nope"}');
  const older = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const app = await openStoredHistory(t, store, async () => jsonPage([apiRecord({ id: 5, publish: older, change: 2 })]));
  await waitFor(() => summaryOf(app).all.value === '+2 硬币');
  const saved = JSON.parse(store.get('bili-prophecy-archive-v1'));
  assert.equal(saved.version, 1);
  assert.equal(saved.users['1937432404'].records['5'].change, 2);
});
