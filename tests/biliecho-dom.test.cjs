const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'biliecho.user.js'), 'utf8');
const endpoint = 'https://api.bilibili.com/x/v2/reply/add';
const reply = { oid: 123, type: 1, rpid: 456, root: 0, content: { message: '本地测试评论，不会发送到 B 站' } };

function setup(t, response) {
  const dom = new JSDOM('<!doctype html><html><body><main>本地评论检测测试</main></body></html>', {
    url: 'https://www.bilibili.com/video/BV123', runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  window.unsafeWindow = window;
  window.AbortController = AbortController;
  window.document.cookie = 'buvid3=device-test; path=/';
  window.document.cookie = 'SESSDATA=account-secret; path=/';
  window.localStorage.setItem('bfc-pro-settings-v42', JSON.stringify({ waitAfterPostMs: 1000, autoRetry: false }));
  window.fetch = async url => {
    assert.equal(String(url), endpoint, 'guest reads must use the device-only GM transport');
    return new Response(JSON.stringify({ code: 0, data: { reply } }));
  };
  window.GM_xmlhttpRequest = details => {
    calls.push(details);
    details.onload(response);
  };
  window.eval(source);
  return { window, calls, state: () => window.__BILIECHO__.getState() };
}

async function finished(state) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const current = state();
    if (current.lastReport && !current.running) return current;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('comment visibility check did not finish');
}

test('the unmodified script captures a mock post and displays guest-visible success', async t => {
  const { window, calls, state } = setup(t, { status: 200, responseText: JSON.stringify({ code: 0, data: { replies: [reply] } }) });
  await window.fetch(endpoint, { method: 'POST' });
  const result = await finished(state);
  assert.equal(window.document.getElementById('bfc-lite-title').textContent, '评论正常可见');
  assert.equal(result.diagnostics.finalKind, 'ok');
  assert.equal(result.diagnostics.requestAttempts.length, 1);
  assert.equal(result.diagnostics.buvidFallbackUsed, true);
  assert.equal(calls[0].anonymous, true);
  assert.equal(calls[0].headers.Cookie, 'buvid3=device-test');
  assert.match(result.lastReport, /buvid3 游客辅助：是/);
});

test('the unmodified script displays cooldown and a recheck click sends no new request', async t => {
  const { window, calls, state } = setup(t, { status: 412, responseText: '<html>guest blocked</html>' });
  await window.fetch(endpoint, { method: 'POST' });
  const result = await finished(state);
  assert.equal(window.document.getElementById('bfc-lite-title').textContent, '暂时无法检测');
  assert.equal(result.diagnostics.finalKind, 'unavailable');
  assert.ok(result.guestCooldownMs > 0);
  assert.equal(calls.length, 1);
  window.document.getElementById('bfc-lite-recheck').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.length, 1);
  assert.equal(state().running, false);
  assert.doesNotMatch(result.lastReport, /复检确认/);
});
