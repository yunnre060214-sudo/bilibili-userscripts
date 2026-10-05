const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const scriptPath = path.join(__dirname, '..', 'bilibili-live-prophecy.user.js');
const source = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
const official = 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html';
const roomPayload = uid => ({
  code: 0, msg: 'ok', message: 'ok', data: {
    room_id: 13233348, short_id: 0, uid, need_p2p: 0, is_hidden: false,
    is_locked: false, is_portrait: false, live_status: 1, hidden_till: 0,
    lock_till: 0, encrypted: false, pwd_verified: false, live_time: 1791198127,
    room_shield: 1, is_sp: 0, special_type: 0,
  },
});

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

function setup(t, { url = 'https://live.bilibili.com/13233348', response = () => roomPayload(353609978), status = 200 } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main>直播页 fixture</main></body></html>', {
    url, runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.AbortController = AbortController;
  const requests = [], intervals = new Map(), timeouts = new Map(), menus = new Map();
  let serial = 0;
  window.setInterval = callback => { const id = ++serial; intervals.set(id, callback); return id; };
  window.clearInterval = id => intervals.delete(id);
  window.setTimeout = (callback, delay) => { const id = ++serial; timeouts.set(id, { callback, delay }); return id; };
  window.clearTimeout = id => timeouts.delete(id);
  window.GM_registerMenuCommand = (label, callback) => menus.set(label, callback);
  window.fetch = async (input, options) => {
    const target = new URL(input);
    assert.equal(target.origin, 'https://api.live.bilibili.com');
    assert.equal(target.pathname, '/room/v1/Room/room_init');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.method, 'GET');
    requests.push({ url: target, options });
    const body = await response(target.searchParams.get('id'), options.signal);
    return { ok: status === 200, status, json: async () => body };
  };
  window.eval(source);
  return {
    window, requests, menus,
    root: () => window.document.getElementById('bili-prophecy-root')?.shadowRoot,
    button(action) {
      const button = this.root()?.querySelector(`[data-action="${action}"]`);
      assert.ok(button, `missing ${action} action`);
      return button;
    },
    navigate(pathname) {
      window.history.pushState({}, '', pathname);
      for (const callback of intervals.values()) callback();
    },
    timeout(delay) {
      for (const { callback, delay: actual } of timeouts.values()) if (actual === delay) callback();
    },
  };
}

test('opens the official component for the room owner and releases it when closed', async t => {
  const app = setup(t);
  await flush();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].url.searchParams.get('id'), '13233348');
  assert.equal(app.root().querySelectorAll('iframe').length, 0);
  app.button('toggle').click();
  assert.equal(app.root().querySelector('iframe').src, `${official}?anchorId=353609978#/`);
  assert.equal(app.button('external').href, `${official}?anchorId=353609978#/`);
  assert.equal(app.button('external').target, '_blank');
  app.button('close').click();
  assert.equal(app.root().querySelectorAll('iframe').length, 0);
  app.button('toggle').click();
  assert.equal(app.root().querySelectorAll('iframe').length, 1);
  assert.equal(app.window.document.querySelectorAll('#bili-prophecy-root').length, 1);
});

test('resolves a short room number to the returned anchor uid', async t => {
  const app = setup(t, { url: 'https://live.bilibili.com/814?live_from=71002' });
  await flush();
  app.button('toggle').click();
  assert.equal(app.requests[0].url.searchParams.get('id'), '814');
  assert.equal(app.root().querySelector('iframe').src, `${official}?anchorId=353609978#/`);
});

test('supports the blanc live room route', async t => {
  const app = setup(t, { url: 'https://live.bilibili.com/blanc/13233348?liteVersion=true' });
  await flush();
  app.button('toggle').click();
  assert.equal(app.root().querySelector('iframe').src, `${official}?anchorId=353609978#/`);
});

test('history and refresh each load one fresh official iframe', async t => {
  const app = setup(t);
  await flush();
  app.button('toggle').click();
  app.button('history').click();
  const old = app.root().querySelector('iframe');
  assert.equal(old.src, `${official}?anchorId=353609978#/history`);
  app.button('refresh').click();
  assert.equal(old.isConnected, false);
  assert.equal(app.root().querySelectorAll('iframe').length, 1);
  app.button('current').click();
  assert.equal(app.root().querySelector('iframe').src, `${official}?anchorId=353609978#/`);
});

for (const route of ['/', '/p/html/live-app-guessing-game/index.html?anchorId=353609978', '/123/not-a-room', '/blanc/0']) {
  test(`does not inject into non-room route ${route}`, async t => {
    const app = setup(t, { url: `https://live.bilibili.com${route}` });
    await flush();
    assert.equal(app.root(), undefined);
    assert.equal(app.requests.length, 0);
  });
}

test('failed room lookup leaves history usable and can be retried', async t => {
  let failed = true;
  const app = setup(t, { response: () => failed ? { code: -400, message: 'invalid', data: null } : roomPayload(353609978) });
  await flush();
  app.button('toggle').click();
  assert.equal(app.root().querySelector('iframe'), null);
  assert.equal(app.button('retry').hidden, false);
  app.button('history').click();
  assert.equal(app.root().querySelector('iframe').src, `${official}#/history`);
  app.button('current').click();
  failed = false;
  app.button('retry').click();
  await flush();
  assert.equal(app.root().querySelector('iframe').src, `${official}?anchorId=353609978#/`);
});

test('rejects invalid uid instead of opening an unrelated prediction', async t => {
  const app = setup(t, { response: () => roomPayload('not-a-uid') });
  await flush();
  app.button('toggle').click();
  assert.equal(app.root().querySelector('iframe'), null);
  assert.equal(app.button('external').hasAttribute('href'), false);
});

test('a late lookup for the previous room cannot overwrite the current room', async t => {
  let resolveOld;
  const app = setup(t, { response: id => id === '13233348' ? new Promise(resolve => { resolveOld = resolve; }) : roomPayload(777) });
  await flush();
  app.button('toggle').click();
  app.navigate('/999');
  await flush();
  assert.equal(app.root().querySelector('iframe').src, `${official}?anchorId=777#/`);
  resolveOld(roomPayload(353609978));
  await flush();
  assert.equal(app.root().querySelector('iframe').src, `${official}?anchorId=777#/`);
  assert.equal(app.requests[0].options.signal.aborted, true);
});

test('leaving a room removes its panel and entering another room recreates a single entry', async t => {
  const app = setup(t);
  await flush();
  app.button('toggle').click();
  app.navigate('/');
  assert.equal(app.root(), undefined);
  app.navigate('/456');
  await flush();
  assert.equal(app.window.document.querySelectorAll('#bili-prophecy-root').length, 1);
  assert.equal(app.root().querySelectorAll('iframe').length, 0);
});

test('timeout aborts a pending request and displays retry', async t => {
  const app = setup(t, { response: (id, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  await flush();
  app.button('toggle').click();
  app.timeout(8000);
  await flush();
  assert.equal(app.requests[0].options.signal.aborted, true);
  assert.equal(app.button('retry').hidden, false);
});

test('Escape closes the panel and restores launcher focus', async t => {
  const app = setup(t);
  await flush();
  app.button('toggle').click();
  app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(app.root().querySelectorAll('iframe').length, 0);
  assert.equal(app.root().activeElement, app.button('toggle'));
});

test('the open panel follows a page fullscreen container', async t => {
  const app = setup(t);
  await flush();
  app.button('toggle').click();
  const player = app.window.document.createElement('div');
  app.window.document.body.append(player);
  Object.defineProperty(app.window.document, 'fullscreenElement', { configurable: true, value: player });
  app.window.document.dispatchEvent(new app.window.Event('fullscreenchange'));
  assert.equal(player.querySelector('#bili-prophecy-root')?.shadowRoot, app.root());
});

test('stale results after leaving a room cannot recreate the entry', async t => {
  let finish;
  const app = setup(t, { response: () => new Promise(resolve => { finish = resolve; }) });
  await flush();
  app.navigate('/');
  finish(roomPayload(353609978));
  await flush();
  assert.equal(app.root(), undefined);
});

test('an external link click before the route timer runs cannot open the old anchor', async t => {
  const app = setup(t);
  await flush();
  app.button('toggle').click();
  app.window.history.pushState({}, '', '/999');
  const event = new app.window.MouseEvent('click', { bubbles: true, cancelable: true });
  app.button('external').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.button('external').hasAttribute('href'), false);
  await flush();
  assert.equal(app.button('external').href, `${official}?anchorId=353609978#/`);
});

test('a lookup interrupted by pagehide resumes on pageshow', async t => {
  let requests = 0;
  const app = setup(t, { response: (id, signal) => {
    if (++requests > 1) return roomPayload(353609978);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await flush();
  app.window.dispatchEvent(new app.window.Event('pagehide'));
  await flush();
  app.window.dispatchEvent(new app.window.Event('pageshow'));
  await flush();
  app.button('toggle').click();
  assert.equal(app.root().querySelector('iframe')?.src, `${official}?anchorId=353609978#/`);
});

test('menu entry opens the same current prediction without duplicate UI', async t => {
  const app = setup(t);
  await flush();
  assert.equal(app.menus.size, 1);
  app.menus.values().next().value();
  assert.equal(app.root().querySelector('iframe').src, `${official}?anchorId=353609978#/`);
  assert.equal(app.window.document.querySelectorAll('#bili-prophecy-root').length, 1);
});

test('an HTTP error leaves history and retry available', async t => {
  const app = setup(t, { status: 403 });
  await flush();
  app.button('toggle').click();
  assert.equal(app.button('retry').hidden, false);
  app.button('history').click();
  assert.equal(app.root().querySelector('iframe').src, `${official}#/history`);
});
