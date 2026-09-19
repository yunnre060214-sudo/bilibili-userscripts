// Requires Playwright and a Chromium browser. All network responses are local fixtures.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    const reply = (id, parent = '1') => ({
      rpid: Number(id),
      rpid_str: id,
      root: id === '1' ? 0 : 1,
      root_str: id === '1' ? '0' : '1',
      parent: id === '1' ? 0 : Number(parent),
      parent_str: id === '1' ? '0' : parent,
      oid: 123,
      oid_str: '123',
      type: 1,
      ctime: 1789787077,
      like: Number(id),
      member: { mid: id, uname: id === '1' ? '测试根用户' : `测试用户${id}` },
      content: { message: id === '1' ? '这是一条测试根评论' : `测试回复 ${id}` },
      reply_control: { location: id === '1' ? 'IP属地：重庆' : 'IP属地：广东' },
    });

    await page.route('**/*', route => {
      const url = new URL(route.request().url());

      if (url.pathname.startsWith('/video/')) {
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html>
<html>
<head><meta charset="utf-8"><title>四脚本兼容性测试</title></head>
<body>
  <h1>四脚本兼容性测试</h1>
  <p>本页与所有接口均为测试数据。</p>
  <div class="quality-wrap">
    <button class="quality-item active" data-qn="80">流畅</button>
    <button class="quality-item" data-qn="10000">原画</button>
  </div>
  <div id="comments"></div>
</body>
</html>`,
        });
      }

      let payload = { code: 0, data: { replies: [reply('1')] } };

      if (url.pathname.includes('/view')) {
        payload = { code: 0, data: { aid: 123 } };
      }

      if (url.pathname.endsWith('/reply/reply')) {
        const pn = Number(url.searchParams.get('pn'));
        const pages = [
          [reply('2'), reply('3', '2')],
          [reply('3', '2'), reply('4')],
          [reply('5')],
        ];
        payload = {
          code: 0,
          data: {
            root: reply('1', '0'),
            replies: pages[pn - 1] || [],
            page: { count: 4 },
          },
        };
      }

      return route.fulfill({
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': 'https://www.bilibili.com',
          'access-control-allow-credentials': 'true',
        },
        body: JSON.stringify(payload),
      });
    });

    await page.addInitScript(() => {
      window.GM_setClipboard = text => {
        window.copiedText = text;
      };
    });

    await page.goto('https://www.bilibili.com/video/BV1234567890');

    await page.evaluate(() => {
      document.querySelectorAll('.quality-item').forEach(el => el.addEventListener('click', () => {
        document.querySelector('.quality-item.active')?.classList.remove('active');
        el.classList.add('active');
      }));

      const action = document.createElement('bili-comment-action-buttons-renderer');
      const actionRoot = action.attachShadow({ mode: 'open' });
      const more = document.createElement('div');
      more.id = 'more';
      const button = document.createElement('button');
      const icon = document.createElement('bili-icon');
      icon.setAttribute('icon', 'BDC/more_vertical_fill/1');
      button.appendChild(icon);

      const menu = document.createElement('bili-comment-menu');
      menu.style.display = 'block';
      const menuRoot = menu.attachShadow({ mode: 'open' });
      const options = document.createElement('ul');
      options.id = 'options';
      for (const text of ['复制评论链接', '加入黑名单', '硬核会员举报']) {
        const li = document.createElement('li');
        li.textContent = text;
        options.appendChild(li);
      }
      menuRoot.appendChild(options);

      more.append(button, menu);
      actionRoot.appendChild(more);
      action.__data = {
        rpid: 1,
        rpid_str: '1',
        root: 0,
        root_str: '0',
        parent: 0,
        parent_str: '0',
        oid: 123,
        oid_str: '123',
        type: 1,
        ctime: 1789787077,
        like: 67,
        member: { mid: '1', uname: '测试根用户' },
        content: { message: '这是一条测试根评论' },
        reply_control: { location: 'IP属地：重庆' },
      };
      document.querySelector('#comments').appendChild(action);
    });

    for (const file of [
      'make-bilibili-great-again-promax',
      'bilibili-comment-anti-fraud-pro',
      'bilibili-comment-thread-exporter',
      'bilibili-live-auto-quality',
    ]) {
      await page.addScriptTag({ path: path.join(__dirname, '..', file + '.user.js') });
    }

    await page.locator('bili-comment-action-buttons-renderer button').click();
    await page.locator('bili-comment-menu .bce-menu-export-item').first().waitFor();

    const menuLabels = await page.locator('bili-comment-menu .bce-menu-export-item').allTextContents();
    assert.deepEqual(menuLabels, ['导出本楼', '下载本楼 MD']);

    await page.locator('bili-comment-menu .bce-menu-export-item').filter({ hasText: '导出本楼' }).first().click();
    await page.waitForFunction(() => window.copiedText?.includes('测试回复 5'));

    const markdown = await page.evaluate(() => window.copiedText);
    assert.equal(markdown.split('测试回复 3').length - 1, 1);
    assert.match(markdown, /点赞 67/);
    assert.match(markdown, /IP属地：重庆/);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('bili-comment-menu .bce-menu-export-item').filter({ hasText: '下载本楼 MD' }).click();
    const download = await downloadPromise;
    const suggestedName = download.suggestedFilename();
    const downloadedMarkdown = fs.readFileSync(await download.path(), 'utf8');

    assert.match(suggestedName, /\.md$/i);
    assert.match(downloadedMarkdown, /测试回复 5/);
    assert.match(downloadedMarkdown, /点赞 67/);
    assert.match(downloadedMarkdown, /IP属地：重庆/);
    assert.doesNotMatch(downloadedMarkdown, /schema v/i);

    assert.equal(
      await page.evaluate(async () => (await fetch('https://data.bilibili.com/test')).status),
      204
    );

    assert.equal(
      await page.evaluate(() => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'https://api.bilibili.com/x/v2/reply?oid=123');
        xhr.responseType = 'json';
        xhr.onload = () => resolve(xhr.response.code);
        xhr.onerror = reject;
        xhr.send();
      })),
      0
    );

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('.quality-item.active')?.textContent === '原画');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForFunction(() => document.querySelector('.quality-item.active')?.textContent === '流畅');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('.quality-item.active')?.textContent === '原画');

    await page.screenshot({
      path: process.env.SCREENSHOT_PATH || '/tmp/bilibili-userscripts-smoke.png',
      fullPage: true,
    });

    assert.deepEqual(errors, []);
    console.log('PASS: four scripts loaded together; native comment menu Markdown copy/download, native XHR, tracker response and high/low/high switching; no page errors.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
