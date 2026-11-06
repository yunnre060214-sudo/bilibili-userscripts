const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'bilibili-live-prophecy.user.js'), 'utf8');
const roomPayload = uid => ({ code: 0, data: { room_id: 13233348, short_id: 0, uid, live_status: 1 } });
// Structure observed on the live site's danmaku controls, including the native icons.
const controls = `<div id="chat-control-panel-vm" class="chat-control-panel">
  <div id="control-panel-ctnr-box" class="control-panel-ctnr">
    <div class="control-panel-icon-row">
      <div class="icon-left-part"><button class="danmaku-preference-btn">设置</button><button class="block-effect-btn">特效</button><button class="block-danmaku-btn">弹幕</button></div>
      <div class="icon-right-part"><button class="like-btn">赞</button><button class="emoticons-panel">表情</button><button class="super-chat">SC</button></div>
    </div>
    <div class="chat-input-ctnr"><textarea class="chat-input" placeholder="发个弹幕呗~">未发送内容</textarea><button class="send-btn">发送</button></div>
  </div>
</div>`;

async function flush() { await new Promise(resolve => setImmediate(resolve)); }

function setup(t, { url = 'https://live.bilibili.com/13233348', response = () => roomPayload(353609978), status = 200, withControls = true, embedded = false, online = true } = {}) {
  const dom = new JSDOM(embedded ? `<iframe src="${url}"></iframe>` : `<!doctype html><html><body>${withControls ? controls : '<main>直播页</main>'}</body></html>`, {
    url: embedded ? 'https://live.bilibili.com/13233348' : url, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const window = embedded ? dom.window.document.querySelector('iframe').contentWindow : dom.window;
  const errors = [];
  window.addEventListener('error', event => errors.push(event.message));
  t.after(() => {
    window.dispatchEvent(new window.Event('pagehide'));
    dom.window.close();
    assert.deepEqual(errors, [], 'unexpected script runtime error');
  });
  if (embedded) {
    window.document.open();
    window.document.write(`<!doctype html><html><body>${withControls ? controls : ''}</body></html>`);
    window.document.close();
  }
  window.AbortController = AbortController;
  let clock = 1800000000000;
  window.Date.now = () => clock;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  const requests = [], opened = [], intervals = new Map(), timeouts = new Map(), menus = new Map();
  let serial = 0;
  window.setInterval = callback => { const id = ++serial; intervals.set(id, callback); return id; };
  window.clearInterval = id => intervals.delete(id);
  window.setTimeout = (callback, delay) => { const id = ++serial; timeouts.set(id, { callback, delay }); return id; };
  window.clearTimeout = id => timeouts.delete(id);
  window.GM_registerMenuCommand = (label, callback) => menus.set(label, callback);
  window.open = (...args) => { opened.push(args); return null; };
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
    window, requests, opened, menus,
    root: () => window.document.getElementById('bili-prophecy-root')?.shadowRoot,
    button() {
      const button = this.root()?.querySelector('[data-action="open"]');
      assert.ok(button, 'missing standalone prediction button');
      return button;
    },
    menu(label = '打开直播预言') { assert.ok(menus.has(label)); menus.get(label)(); },
    addControls() { window.document.body.insertAdjacentHTML('beforeend', controls); },
    navigate(pathname) { window.history.pushState({}, '', pathname); for (const callback of intervals.values()) callback(); },
    timeout(delay) { for (const [id, timer] of [...timeouts]) if (timer.delay === delay) { timeouts.delete(id); timer.callback(); } },
    advance(ms) { clock += ms; },
    intervalCount: () => intervals.size,
    setOnline(value) { online = value; window.dispatchEvent(new window.Event(value ? 'online' : 'offline')); },
  };
}

const expectedURL = 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978#/';

test('the standalone button follows the three native icons above the unchanged danmaku input', async t => {
  const app = setup(t);
  await flush();
  const doc = app.window.document;
  const left = doc.querySelector('.icon-left-part');
  const host = doc.getElementById('bili-prophecy-root');
  assert.equal(host.parentNode, left);
  assert.equal(left.lastElementChild, host);
  assert.equal(left.querySelectorAll('button').length, 3);
  assert.equal(doc.querySelector('textarea').value, '未发送内容');
  assert.equal(doc.querySelector('.send-btn').textContent, '发送');
  assert.equal(app.button().textContent, '');
  assert.equal(app.button().querySelectorAll('svg').length, 1);
  assert.equal(app.button().getAttribute('aria-label'), '在独立窗口打开直播预言');
  assert.equal(app.button().type, 'button');
  assert.equal(app.requests.length, 1);
  app.button().click();
  assert.deepEqual(app.opened, [[expectedURL, '_blank', 'noopener,noreferrer']]);
  assert.equal(app.root().querySelector('iframe, .panel, [data-action="toggle"]'), null);
  assert.equal(doc.querySelectorAll('#bili-prophecy-root').length, 1);
});

test('a short room number opens the returned owner rather than treating the room number as a uid', async t => {
  const app = setup(t, { url: 'https://live.bilibili.com/814?live_from=71002' });
  await flush();
  app.button().click();
  assert.equal(app.requests[0].url.searchParams.get('id'), '814');
  assert.equal(app.opened[0][0], expectedURL);
});

test('the blanc room route receives its own toolbar entry', async t => {
  const app = setup(t, { url: 'https://live.bilibili.com/blanc/13233348?liteVersion=true' });
  await flush();
  app.button().click();
  assert.equal(app.opened[0][0], expectedURL);
});

test('a live room inside an event page frame can open its owner prediction', async t => {
  const app = setup(t, { url: 'https://live.bilibili.com/blanc/13233348?liteVersion=true', embedded: true });
  assert.notEqual(app.window.top, app.window);
  await flush();
  app.button().click();
  assert.equal(app.opened[0][0], expectedURL);
});

test('a late danmaku toolbar mounts the entry without adding a floating fallback', async t => {
  const app = setup(t, { withControls: false });
  await flush();
  assert.equal(app.root(), undefined);
  app.addControls();
  await flush();
  assert.equal(app.window.document.querySelector('.icon-left-part').lastElementChild.id, 'bili-prophecy-root');
  app.button().click();
  assert.equal(app.opened.length, 1);
});

test('a replacement chat toolbar receives the same working entry exactly once', async t => {
  const app = setup(t);
  await flush();
  const host = app.window.document.getElementById('bili-prophecy-root');
  app.window.document.getElementById('chat-control-panel-vm').remove();
  app.addControls();
  await flush();
  assert.equal(app.window.document.getElementById('bili-prophecy-root'), host);
  assert.equal(app.window.document.querySelectorAll('#bili-prophecy-root').length, 1);
  app.button().click();
  assert.equal(app.opened.length, 1);
  assert.equal(app.requests.length, 1);
});

test('a toolbar without a separate left group still receives a standalone entry', async t => {
  const app = setup(t, { withControls: false });
  app.window.document.body.innerHTML = '<div class="chat-control-panel"><div class="control-panel-icon-row"></div><div class="chat-input-ctnr"><textarea></textarea></div></div>';
  await flush();
  assert.equal(app.window.document.getElementById('bili-prophecy-root').parentNode, app.window.document.querySelector('.control-panel-icon-row'));
  app.button().click();
  assert.equal(app.opened.length, 1);
});

test('the userscript menu opens a standalone page even if the room has no chat toolbar', async t => {
  const app = setup(t, { withControls: false });
  await flush();
  app.menu();
  assert.equal(app.root(), undefined);
  assert.equal(app.opened[0][0], expectedURL);
});

for (const route of ['/', '/p/html/live-app-guessing-game/index.html?anchorId=353609978', '/123/not-a-room', '/blanc/0']) {
  test(`non-room route ${route} does not receive a prediction entry or owner request`, async t => {
    const app = setup(t, { url: `https://live.bilibili.com${route}` });
    await flush();
    assert.equal(app.root(), undefined);
    assert.equal(app.requests.length, 0);
    assert.equal(app.opened.length, 0);
  });
}

test('a failed owner lookup retries on click without opening a page asynchronously', async t => {
  let failed = true;
  const app = setup(t, { response: () => failed ? { code: -400, data: null } : roomPayload(353609978) });
  await flush();
  assert.equal(app.button().disabled, false);
  assert.match(app.button().title, /重试/);
  failed = false;
  app.button().click();
  assert.equal(app.button().disabled, true);
  await flush();
  assert.equal(app.requests.length, 2);
  assert.equal(app.opened.length, 0);
  app.button().click();
  assert.equal(app.opened.length, 1);
});

test('an invalid owner uid cannot open an unrelated prediction page', async t => {
  const app = setup(t, { response: () => roomPayload('not-a-uid') });
  await flush();
  app.button().click();
  app.menu();
  await flush();
  assert.equal(app.opened.length, 0);
  assert.match(app.button().title, /重试/);
});

test('loading the owner disables the button and never automatically opens a window', async t => {
  let finish;
  const app = setup(t, { response: () => new Promise(resolve => { finish = resolve; }) });
  await flush();
  assert.equal(app.button().disabled, true);
  assert.equal(app.button().getAttribute('aria-busy'), 'true');
  app.button().click();
  app.menu();
  assert.equal(app.opened.length, 0);
  finish(roomPayload(353609978));
  await flush();
  assert.equal(app.button().disabled, false);
  assert.equal(app.button().getAttribute('aria-busy'), 'false');
  assert.equal(app.opened.length, 0);
  app.button().click();
  // Recorded synchronously, while the click gesture is still active.
  assert.equal(app.opened.length, 1);
});

test('a late result from the previous room cannot replace the current owner', async t => {
  let finish;
  const app = setup(t, { response: id => id === '13233348' ? new Promise(resolve => { finish = resolve; }) : roomPayload(777) });
  await flush();
  app.navigate('/999');
  await flush();
  finish(roomPayload(353609978));
  await flush();
  assert.equal(app.requests[0].options.signal.aborted, true);
  app.button().click();
  assert.equal(app.opened[0][0], 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=777#/');
});

test('leaving a room removes its entry and entering another recreates one button', async t => {
  const app = setup(t);
  await flush();
  app.navigate('/');
  assert.equal(app.root(), undefined);
  app.menu();
  assert.equal(app.opened.length, 0);
  app.navigate('/456');
  await flush();
  assert.equal(app.window.document.querySelectorAll('#bili-prophecy-root').length, 1);
  app.button().click();
  assert.equal(app.opened.length, 1);
});

test('a timed-out lookup enables a retry without leaving the button busy', async t => {
  const app = setup(t, { response: (id, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  await flush();
  app.timeout(8000);
  await flush();
  assert.equal(app.requests[0].options.signal.aborted, true);
  assert.equal(app.button().disabled, false);
  assert.equal(app.button().getAttribute('aria-busy'), 'false');
  assert.match(app.button().title, /超时.*重试/);
  assert.equal(app.opened.length, 0);
});

test('a late result after leaving the room cannot recreate the entry', async t => {
  let finish;
  const app = setup(t, { response: () => new Promise(resolve => { finish = resolve; }) });
  await flush();
  app.navigate('/');
  finish(roomPayload(353609978));
  await flush();
  assert.equal(app.root(), undefined);
  assert.equal(app.opened.length, 0);
});

test('a click immediately after an SPA route change cannot open the previous owner', async t => {
  const app = setup(t, { response: id => roomPayload(id === '13233348' ? 353609978 : 777) });
  await flush();
  app.window.history.pushState({}, '', '/999');
  app.button().click();
  assert.equal(app.opened.length, 0);
  await flush();
  app.button().click();
  assert.equal(app.opened[0][0], 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=777#/');
});

test('a lookup interrupted by pagehide resumes on pageshow without opening a window', async t => {
  let count = 0;
  const app = setup(t, { response: (id, signal) => {
    if (++count > 1) return roomPayload(353609978);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await flush();
  app.window.dispatchEvent(new app.window.Event('pagehide'));
  app.window.dispatchEvent(new app.window.Event('pageshow'));
  await flush();
  assert.equal(app.requests.length, 2);
  assert.equal(app.opened.length, 0);
  app.button().click();
  assert.equal(app.opened.length, 1);
});

test('the restored page resumes observing a replacement chat toolbar', async t => {
  const app = setup(t);
  await flush();
  app.window.dispatchEvent(new app.window.Event('pagehide'));
  app.window.document.getElementById('chat-control-panel-vm').remove();
  app.window.dispatchEvent(new app.window.Event('pageshow'));
  app.addControls();
  await flush();
  app.button().click();
  assert.equal(app.opened.length, 1);
  assert.equal(app.requests.length, 1);
});

test('reinjecting before the toolbar arrives does not duplicate requests or entries', async t => {
  const app = setup(t, { withControls: false });
  app.window.eval(source);
  await flush();
  app.addControls();
  await flush();
  assert.equal(app.requests.length, 1);
  assert.equal(app.window.document.querySelectorAll('#bili-prophecy-root').length, 1);
  app.button().click();
  assert.equal(app.opened.length, 1);
});

test('an HTTP error leaves a retry entry and cannot open a prediction', async t => {
  const app = setup(t, { status: 403 });
  await flush();
  assert.match(app.button().title, /重试/);
  app.button().click();
  await flush();
  assert.equal(app.requests.length, 2);
  assert.equal(app.opened.length, 0);
});

test('Shift clicking the icon opens the official participation history', async t => {
  const app = setup(t);
  await flush();
  app.button().dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, shiftKey: true }));
  assert.equal(app.opened[0][0], 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?anchorId=353609978#/history');
});

test('history remains accessible from the menu when owner lookup fails', async t => {
  const app = setup(t, { response: () => ({ code: -400, data: null }) });
  await flush();
  app.menu('查看预言参与记录');
  assert.equal(app.opened[0][0], 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html#/history');
});

test('a room revisit reuses its validated owner for five minutes only', async t => {
  const app = setup(t, { response: id => roomPayload(id === '13233348' ? 353609978 : 777) });
  await flush();
  app.navigate('/999');
  await flush();
  app.navigate('/13233348');
  assert.equal(app.requests.length, 2);
  assert.equal(app.button().disabled, false);
  app.button().click();
  assert.equal(app.opened[0][0], expectedURL);
  app.navigate('/999');
  app.advance(300001);
  app.navigate('/13233348');
  await flush();
  assert.equal(app.requests.length, 3);
});

test('the owner cache evicts its oldest room after 32 rooms', async t => {
  const app = setup(t);
  await flush();
  for (let i = 1; i <= 32; i++) { app.navigate(`/${i}`); await flush(); }
  app.navigate('/31');
  await flush();
  assert.equal(app.requests.length, 33);
  app.navigate('/13233348');
  await flush();
  assert.equal(app.requests.length, 34);
});

test('rapid repeated opening is limited to one window per address in 600ms', async t => {
  const app = setup(t);
  await flush();
  app.button().click();
  app.button().click();
  app.menu();
  assert.equal(app.opened.length, 1);
  app.advance(601);
  app.button().click();
  assert.equal(app.opened.length, 2);
});

test('a transient network failure receives one automatic retry without opening a window', async t => {
  let attempts = 0;
  const app = setup(t, { response: () => { if (++attempts === 1) throw new TypeError('offline transport'); return roomPayload(353609978); } });
  await flush();
  assert.equal(app.button().disabled, false);
  app.timeout(1200);
  await flush();
  assert.equal(app.requests.length, 2);
  assert.equal(app.button().dataset.state, 'ready');
  assert.equal(app.opened.length, 0);
});

test('automatic retry stops after a second transport failure', async t => {
  const app = setup(t, { response: () => { throw new TypeError('broken transport'); } });
  await flush();
  app.timeout(1200);
  await flush();
  app.timeout(1200);
  await flush();
  assert.equal(app.requests.length, 2);
  assert.equal(app.button().dataset.state, 'error');
});

test('an empty owner response is rejected without treating it as a transport failure', async t => {
  const app = setup(t, { response: () => null });
  await flush();
  app.timeout(1200);
  await flush();
  assert.equal(app.requests.length, 1);
  assert.equal(app.button().dataset.state, 'error');
  assert.equal(app.opened.length, 0);
});

test('a scheduled retry cannot request the room after navigation away', async t => {
  const app = setup(t, { response: () => { throw new TypeError('broken transport'); } });
  await flush();
  app.navigate('/');
  app.timeout(1200);
  await flush();
  assert.equal(app.requests.length, 1);
  assert.equal(app.root(), undefined);
});

test('an offline page waits for reconnect before identifying its owner', async t => {
  const app = setup(t, { online: false });
  await flush();
  assert.equal(app.requests.length, 0);
  assert.match(app.button().title, /网络|联网/);
  app.setOnline(true);
  await flush();
  assert.equal(app.requests.length, 1);
  assert.equal(app.button().dataset.state, 'ready');
  assert.equal(app.opened.length, 0);
});

test('hidden rooms suspend route polling and resume exactly once when visible', async t => {
  const app = setup(t);
  await flush();
  let hidden = true;
  Object.defineProperty(app.window.document, 'hidden', { configurable: true, get: () => hidden });
  app.window.document.dispatchEvent(new app.window.Event('visibilitychange'));
  assert.equal(app.intervalCount(), 0);
  hidden = false;
  app.window.document.dispatchEvent(new app.window.Event('visibilitychange'));
  app.window.document.dispatchEvent(new app.window.Event('visibilitychange'));
  assert.equal(app.intervalCount(), 1);
  assert.equal(app.requests.length, 1);
});

test('the icon adapts when the native input background changes from dark to light', async t => {
  const app = setup(t);
  await flush();
  const input = app.window.document.querySelector('.chat-input-ctnr');
  const host = app.window.document.getElementById('bili-prophecy-root');
  input.style.backgroundColor = '#1c1d1f';
  await flush();
  assert.equal(host.dataset.theme, 'dark');
  input.style.backgroundColor = '#ffffff';
  await flush();
  assert.equal(host.dataset.theme, 'light');
  app.button().click();
  assert.equal(app.opened.length, 1);
});

test('replacing only the native input updates the icon theme and observes the replacement', async t => {
  const app = setup(t);
  await flush();
  const doc = app.window.document;
  const host = doc.getElementById('bili-prophecy-root');
  const input = doc.querySelector('.chat-input-ctnr');
  input.style.backgroundColor = '#ffffff';
  await flush();
  assert.equal(host.dataset.theme, 'light');
  const replacement = input.cloneNode(true);
  replacement.style.backgroundColor = '#1c1d1f';
  input.replaceWith(replacement);
  await flush();
  assert.equal(host.dataset.theme, 'dark');
  replacement.style.backgroundColor = '#ffffff';
  await flush();
  assert.equal(host.dataset.theme, 'light');
  assert.equal(doc.querySelectorAll('#bili-prophecy-root').length, 1);
});
