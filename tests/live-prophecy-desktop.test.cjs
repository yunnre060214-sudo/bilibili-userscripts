const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'bilibili-live-prophecy.user.js'), 'utf8');

function setup(t, { mobile = false, existing = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="app">官方组件 fixture</main></body></html>', {
    url: 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978#/',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.unsafeWindow = window;
  if (mobile) Object.defineProperty(window.navigator, 'userAgent', { value: 'BiliApp iPhone' });
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
