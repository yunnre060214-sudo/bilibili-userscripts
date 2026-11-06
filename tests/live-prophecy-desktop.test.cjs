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

function setup(t, { mobile = false, existing = false, cached = false, workspace = false, url = 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978#/' } = {}) {
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
