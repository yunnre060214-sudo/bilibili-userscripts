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

function setup(t, { mobile = false, existing = false, cached = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="app">官方组件 fixture</main></body></html>', {
    url: 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978#/',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
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
    button(action) {
      const button = this.root()?.querySelector(`[data-desktop-action="${action}"]`);
      assert.ok(button, `missing desktop ${action}`);
      return button;
    },
  };
}

test('desktop confirmation opens a real dialog and resolves only after manual confirmation', async t => {
  const app = setup(t);
  app.load();
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

test('the room page repairs an iframe where the userscript did not run', async t => {
  const page = setup(t, { mobile: true });
  Object.defineProperty(page.window.navigator, 'userAgent', { value: 'Desktop Chrome', configurable: true });
  page.sdk.getEnvSync = () => -1;
  installRuntime(page.window, page.sdk)(1171);
  const parent = new JSDOM('<html><body>直播页</body></html>', {
    url: 'https://live.bilibili.com/13233348', runScripts: 'outside-only',
  });
  t.after(() => parent.window.close());
  parent.window.unsafeWindow = parent.window;
  parent.window.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: { uid: 353609978 } }) });
  parent.window.eval(source);
  await new Promise(resolve => setImmediate(resolve));
  const root = parent.window.document.getElementById('bili-prophecy-root').shadowRoot;
  root.querySelector('[data-action="toggle"]').click();
  const frame = root.querySelector('iframe');
  Object.defineProperty(frame, 'contentWindow', { value: page.window });
  frame.dispatchEvent(new parent.window.Event('load'));
  assert.notEqual(page.sdk.showConfirm, page.nativeConfirm);
  assert.ok(page.root());
  const confirmation = page.sdk.showConfirm;
  frame.dispatchEvent(new parent.window.Event('load'));
  assert.equal(page.sdk.showConfirm, confirmation);
  assert.equal(page.window.document.querySelectorAll('#bili-prophecy-desktop').length, 1);
  assert.match(root.querySelector('.hint').textContent, /桌面适配已启用/);
  assert.equal(parent.window.document.getElementById('bili-prophecy-desktop'), null);
  const pending = page.sdk.showConfirm({ title: 'iframe 后备适配', content: '本地测试' });
  assert.ok(page.root().querySelector('[role="dialog"]'));
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
