const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const url = 'https://api.bilibili.com/x/v2/reply/main?oid=123&type=1';
const source = fs.readFileSync(path.join(__dirname, '..', 'biliecho.user.js'), 'utf8');
const ok = () => new Response(JSON.stringify({ code: 0, data: { replies: [] } }));

function load({ cookie = '', storage = new Map(), gm, gmModern, fetch = async () => ok() } = {}) {
  let time = 1000000;
  class ClockDate extends Date {
    static now() { return time; }
  }
  const clock = { advance(ms) { time += ms; }, now() { return time; } };
  const context = vm.createContext({
    console, URL, Response, AbortController, DOMException,
    setTimeout, clearTimeout, setInterval, clearInterval, Date: ClockDate,
    location: { href: 'https://www.bilibili.com/video/BV123', origin: 'https://www.bilibili.com' },
    window: {},
    document: { cookie, getElementById: () => null },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    testClock: clock,
    ...(gm ? { GM_xmlhttpRequest: gm } : {}),
    ...(gmModern ? { GM: { xmlHttpRequest: gmModern } } : {}),
  });
  vm.runInContext(source.replace('  init();', `
    sleep = async ms => { testClock.advance(ms); };
    UI.status = UI.open = async () => {};
    UI.progress = UI.indeterminate = () => {};
    globalThis.api = {
      requestJson, gmRequestText, fetchRequestText, STATE, normalizeSettings,
      getRiskControlCooldownRemaining, getGuestCooldownRemaining,
      createCancelToken, createDiagnostics, makeDiagnosticsSummary,
      confirmResultWithRetries, runVisibilityProbe,
      settings: SETTINGS,
      setProbe(fn) { runVisibilityProbe = fn; },
      setSleep(fn) { sleepWithCancel = fn; },
    };
  `), context);
  context.api.STATE.originalFetch = fetch;
  context.api.STATE.diagnostics = context.api.createDiagnostics();
  return { api: context.api, clock, context, storage };
}

test('guest uses only BUVID in an anonymous GM request before trying cookie-free fetch', async () => {
  const calls = [];
  let fetches = 0;
  const { api } = load({
    cookie: 'SESSDATA=secret; buvid3=device-test; bili_jct=csrf-secret; DedeUserID=1937432404',
    fetch: async () => { fetches++; return new Response('{"code":-352}'); },
    gm: details => {
      calls.push(details);
      details.onload({ status: 200, responseText: details.headers.Cookie === 'buvid3=device-test' ? '{"code":0}' : '{"code":-352}' });
    },
  });
  assert.equal((await api.requestJson(url)).code, 0);
  assert.equal(fetches, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].anonymous, true);
  assert.equal(calls[0].headers.Cookie, 'buvid3=device-test');
  assert.equal(api.STATE.diagnostics.buvidFallbackUsed, true);
  assert.equal(api.STATE.diagnostics.pureAnonymousSucceeded, false);
});

test('a guest risk response suppresses further comments and survives a page reload', async () => {
  let requests = 0;
  const storage = new Map();
  const fetch = async () => { requests++; return new Response('{"code":-352}'); };
  const { api } = load({ storage, fetch });
  assert.equal((await api.requestJson(url)).code, -352);
  assert.equal((await api.requestJson(url + '&seek_rpid=456')).code, -352);
  assert.equal(requests, 1);
  const reload = load({ storage, fetch });
  assert.equal((await reload.api.requestJson(url)).code, -352);
  assert.equal(requests, 1);
});

test('HTTP 412 and 429 stop retrying and return an unavailable risk response', async () => {
  for (const status of [412, 429]) {
    let requests = 0;
    const { api } = load({ fetch: async () => { requests++; return new Response('<html>blocked</html>', { status }); } });
    const result = await api.requestJson(url);
    assert.ok([-412, -509].includes(Number(result.code)));
    assert.equal((await api.requestJson(url)).code, result.code);
    assert.equal(requests, 1);
  }
});

test('risk response does not cause an immediate retry through another transport', async () => {
  let gmCalls = 0;
  const { api } = load({
    fetch: async () => new Response('{"code":-509}'),
    gm: details => { gmCalls++; details.onload({ status: 200, responseText: '{"code":-509}' }); },
  });
  assert.equal((await api.requestJson(url)).code, -509);
  assert.equal(gmCalls, 0);
});

test('concurrent probes serialize requests and enforce at least a one-second interval', async () => {
  let finishFirst;
  let active = 0;
  let maxActive = 0;
  const starts = [];
  let clock;
  const loaded = load({ fetch: async () => {
    starts.push(clock.now());
    maxActive = Math.max(maxActive, ++active);
    if (starts.length === 1) await new Promise(resolve => { finishFirst = resolve; });
    active--;
    return ok();
  } });
  clock = loaded.clock;
  loaded.api.settings.pageDelayMs = 0;
  const first = loaded.api.requestJson(url);
  const second = loaded.api.requestJson(url + '&next=1');
  for (let i = 0; i < 20 && !finishFirst; i++) await Promise.resolve();
  assert.ok(finishFirst);
  finishFirst();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.ok(starts[1] - starts[0] >= 1000);
});

test('a risk response during confirmation stops retries and remains unconfirmed', async () => {
  const { api } = load();
  let probes = 0;
  api.setProbe(async () => { probes++; return { kind: 'unavailable', title: '暂时无法检测', extra: '风控' }; });
  const result = await api.confirmResultWithRetries({ rpid: 1 }, { kind: 'suspect', title: '可疑' }, [], api.createCancelToken());
  assert.equal(probes, 1);
  assert.equal(result.confirmedAfterRetry, false);
  assert.equal(result.extra, '风控');
});

test('GM timeout aborts even if the manager ignores its timeout option', async () => {
  let aborted = false;
  const { api } = load({ gm: () => ({ abort() { aborted = true; } }) });
  api.settings.requestTimeoutMs = 20;
  const request = api.gmRequestText(url);
  let watchdog;
  await assert.rejects(Promise.race([
    request,
    new Promise((resolve, reject) => { watchdog = setTimeout(() => reject(new Error('watchdog')), 100); }),
  ]), /请求超时/).finally(() => clearTimeout(watchdog));
  assert.equal(aborted, true);
});

test('without BUVID or GM, a successful guest fetch still omits all cookies', async () => {
  let options;
  const { api } = load({
    cookie: 'SESSDATA=secret; bili_jct=csrf-secret',
    fetch: async (url, init) => { options = init; return ok(); },
  });
  assert.equal((await api.requestJson(url)).code, 0);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.headers.Cookie, undefined);
  assert.equal(api.STATE.diagnostics.pureAnonymousSucceeded, true);
});

test('a GM transport failure falls back to cookie-free fetch after the request interval', async () => {
  let gmCalls = 0;
  let options;
  let gmAt;
  let fetchAt;
  let clock;
  const loaded = load({
    cookie: 'buvid3=device-test',
    gm: details => { gmAt = clock.now(); gmCalls++; details.onerror(new Error('offline')); },
    fetch: async (url, init) => { fetchAt = clock.now(); options = init; return ok(); },
  });
  clock = loaded.clock;
  assert.equal((await loaded.api.requestJson(url)).code, 0);
  assert.equal(gmCalls, 1);
  assert.equal(options.credentials, 'omit');
  assert.ok(fetchAt - gmAt >= 1000);
});

test('a cookie-free fetch transport failure can fall back to pure anonymous GM', async () => {
  let details;
  const { api } = load({
    fetch: async () => { throw new Error('CORS'); },
    gm: request => { details = request; request.onload({ status: 200, responseText: '{"code":0}' }); },
  });
  assert.equal((await api.requestJson(url)).code, 0);
  assert.equal(details.anonymous, true);
  assert.equal(details.headers.Cookie, undefined);
  assert.equal(api.STATE.diagnostics.pureAnonymousSucceeded, true);
});

test('logged-in probes keep credentials and do not use the guest GM transport', async () => {
  let options;
  let gmCalls = 0;
  const { api } = load({
    cookie: 'buvid3=device-test; SESSDATA=secret',
    gm: () => { gmCalls++; },
    fetch: async (url, init) => { options = init; return ok(); },
  });
  assert.equal((await api.requestJson(url, { login: true })).code, 0);
  assert.equal(options.credentials, 'include');
  assert.equal(gmCalls, 0);
  assert.equal(api.STATE.diagnostics.loginRequests, 1);
});

test('logged-in risk does not poison the guest cooldown', async () => {
  let calls = 0;
  const { api } = load({ fetch: async () => new Response(JSON.stringify({ code: ++calls === 1 ? -352 : 0 })) });
  assert.equal((await api.requestJson(url, { login: true })).code, -352);
  assert.equal((await api.requestJson(url)).code, 0);
  assert.equal(calls, 2);
});

test('repeated guest risk escalates cooldown and a successful probe resets it', async () => {
  let blocked = true;
  const { api, clock, storage } = load({ fetch: async () => new Response(JSON.stringify({ code: blocked ? -352 : 0 })) });
  for (const seconds of [60, 120, 240, 300, 300]) {
    assert.equal((await api.requestJson(url)).code, -352);
    assert.equal(api.getRiskControlCooldownRemaining({ rpid: 'another-comment' }), seconds * 1000);
    clock.advance(seconds * 1000);
  }
  blocked = false;
  assert.equal((await api.requestJson(url)).code, 0);
  assert.equal(api.getRiskControlCooldownRemaining({ rpid: 'another-comment' }), 0);
  assert.equal(storage.size, 0);
  blocked = true;
  assert.equal((await api.requestJson(url)).code, -352);
  assert.equal(api.getGuestCooldownRemaining(), 60000);
});

test('HTTP Retry-After is honored and the watchdog clears after a GM response', async () => {
  let details;
  const { api } = load({
    cookie: 'buvid3=device-test',
    gm: request => {
      details = request;
      request.onload({ status: 429, responseText: '', responseHeaders: 'Retry-After: 180\r\n' });
    },
  });
  api.settings.requestTimeoutMs = 20;
  assert.equal((await api.requestJson(url)).code, -509);
  assert.equal(api.getGuestCooldownRemaining(), 180000);
  assert.equal(details.headers.Cookie, 'buvid3=device-test');
});

test('cancellation during a fallback interval prevents the second request', async () => {
  let gmCalls = 0;
  const { api } = load({
    fetch: async () => { throw new Error('offline'); },
    gm: () => { gmCalls++; },
  });
  api.setSleep(async ms => { if (ms > 0) api.STATE.cancelVersion++; });
  await assert.rejects(api.requestJson(url, { token: api.createCancelToken() }), { name: 'BfcCancelledError' });
  assert.equal(gmCalls, 0);
});

test('invalid cooldown storage and inaccessible cookies do not break requests', async () => {
  const storage = new Map([['bfc-guest-risk-v1', '{"until":1e99,"at":1,"code":-352}']]);
  const loaded = load({ storage });
  Object.defineProperty(loaded.context.document, 'cookie', { get() { throw new Error('blocked storage'); } });
  assert.equal((await loaded.api.requestJson(url)).code, 0);
  assert.equal(loaded.api.getGuestCooldownRemaining(), 0);
});

test('old fast-pagination settings migrate to the one-second minimum', () => {
  const { api } = load();
  assert.equal(api.normalizeSettings({ pageDelayMs: 160 }).pageDelayMs, 1000);
  assert.equal(api.normalizeSettings({ pageDelayMs: 0 }).pageDelayMs, 1000);
  assert.equal(api.normalizeSettings({ pageDelayMs: 2500 }).pageDelayMs, 2500);
});

test('promise-based GM requests preserve the same anonymous device-only identity', async () => {
  let details;
  const { api } = load({
    cookie: 'buvid3=device-test; SESSDATA=secret',
    gmModern: async request => { details = request; return { status: 200, responseText: '{"code":0}' }; },
  });
  assert.equal((await api.requestJson(url)).code, 0);
  assert.equal(details.anonymous, true);
  assert.equal(details.headers.Cookie, 'buvid3=device-test');
});

test('unavailable browser storage retains the current page cooldown', async () => {
  let calls = 0;
  const { api, context } = load({ fetch: async () => { calls++; return new Response('{"code":-352}'); } });
  context.localStorage.getItem = context.localStorage.setItem = context.localStorage.removeItem = () => { throw new Error('storage disabled'); };
  assert.equal((await api.requestJson(url)).code, -352);
  assert.equal((await api.requestJson(url)).code, -352);
  assert.equal(api.getGuestCooldownRemaining(), 60000);
  assert.equal(calls, 1);
});

test('an older successful response cannot erase a newer risk response from another page', async () => {
  let clock;
  const storage = new Map();
  let calls = 0;
  const loaded = load({ storage, fetch: async () => {
    calls++;
    clock.advance(1);
    storage.set('bfc-guest-risk-v1', JSON.stringify({ at: clock.now(), until: clock.now() + 60000, strikes: 1, code: -352 }));
    return ok();
  } });
  clock = loaded.clock;
  assert.equal((await loaded.api.requestJson(url)).code, 0);
  assert.equal((await loaded.api.requestJson(url)).code, -352);
  assert.equal(calls, 1);
});

test('disabled or changed confirmation is reported without a false confirmation claim', async () => {
  const { api } = load();
  api.settings.autoRetry = false;
  assert.equal((await api.confirmResultWithRetries({}, { kind: 'suspect' }, [], api.createCancelToken())).confirmedAfterRetry, false);
  api.settings.autoRetry = true;
  api.setProbe(async () => ({ kind: 'shadow_ban' }));
  const result = await api.confirmResultWithRetries({}, { kind: 'suspect' }, [], api.createCancelToken());
  assert.equal(result.confirmedAfterRetry, false);
  assert.match(result.extra, /结论发生变化/);
});
