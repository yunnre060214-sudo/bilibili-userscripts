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
    let subtitleScenario = 'available';
    const subtitleCids = [];

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

      if (url.pathname.startsWith('/video/') || url.hostname === 'live.bilibili.com') {
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html>
<html>
<head><meta charset="utf-8"><title>BiliForge 集成兼容性测试</title></head>
<body>
  <h1>BiliForge 集成兼容性测试</h1>
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
        payload = { code: 0, data: {
          aid: 123, bvid: 'BV1234567890', cid: 100,
          pages: [{ page: 1, cid: 100, part: '第一集' }, { page: 2, cid: 200, part: '第二集' }],
        } };
      }

      if (url.pathname.startsWith('/x/player/')) {
        subtitleCids.push(url.searchParams.get('cid'));
        payload = { code: 0, data: { subtitle: { subtitles: subtitleScenario === 'available' ? [
          { lan: 'en', lan_doc: 'English', subtitle_url: '//i0.hdslb.com/bfs/subtitle/en.json' },
          { lan: 'zh-CN', lan_doc: '中文', subtitle_url: '//i0.hdslb.com/bfs/subtitle/zh.json' },
        ] : [] } } };
      }

      if (url.hostname === 'i0.hdslb.com') {
        assert.equal(url.pathname, '/bfs/subtitle/zh.json');
        payload = { body: [
          { from: 0, to: 2, content: '第二集的字幕正文第一句。' },
          { from: 2, to: 4, content: '第二集的字幕正文第二句。' },
        ] };
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

    await page.goto('https://www.bilibili.com/video/BV1234567890?p=2');

    // Privileged transport adapter: checks real metadata and GM callbacks.
    // This is still a fixture, not a real Tampermonkey sandbox or CORS test.
    const exporterSource = fs.readFileSync(path.join(__dirname, '..', 'bilibili-comment-thread-exporter.user.js'), 'utf8');
    const connectDomains = Array.from(exporterSource.split('// ==/UserScript==')[0].matchAll(/^\/\/ @connect\s+(\S+)/gm), match => match[1]);
    await page.evaluate(domains => {
      window.GM_xmlhttpRequest = details => {
        const host = new URL(details.url).hostname;
        const controller = new AbortController();
        if (!domains.some(domain => host === domain || host.endsWith(`.${domain}`))) {
          queueMicrotask(() => details.onerror?.({ status: 0 }));
          return { abort() { details.onabort?.(); } };
        }
        fetch(details.url, { credentials: details.anonymous ? 'omit' : 'include', signal: controller.signal })
          .then(async response => details.onload?.({ status: response.status, responseText: await response.text() }))
          .catch(error => error.name === 'AbortError' ? details.onabort?.() : details.onerror?.(error));
        return { abort() { controller.abort(); } };
      };
    }, connectDomains);

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
      'biliforge',
      'biliecho',
      'bilibili-comment-thread-exporter',
    ]) {
      await page.addScriptTag({ path: path.join(__dirname, '..', file + '.user.js') });
    }

    await page.locator('bili-comment-action-buttons-renderer button').click();
    await page.locator('bili-comment-menu .bce-menu-export-item').first().waitFor();

    const menuLabels = await page.locator('bili-comment-menu .bce-menu-export-item').allTextContents();
    assert.deepEqual(menuLabels, ['导出为 MD']);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('bili-comment-menu .bce-menu-export-item').filter({ hasText: '导出为 MD' }).click();
    const download = await downloadPromise;
    const suggestedName = download.suggestedFilename();
    const downloadedMarkdown = fs.readFileSync(await download.path(), 'utf8');

    assert.match(suggestedName, /\.md$/i);
    assert.match(downloadedMarkdown, /测试回复 5/);
    assert.equal(downloadedMarkdown.split('测试回复 3').length - 1, 1);
    assert.match(downloadedMarkdown, /点赞 67/);
    assert.match(downloadedMarkdown, /IP属地：重庆/);
    assert.match(downloadedMarkdown, /回复 \[0002\]\(#msg-0002\) 测试用户2/);
    assert.match(downloadedMarkdown, /当前分 P：P2 · 第二集 · CID 200/);
    assert.match(downloadedMarkdown, /第二集的字幕正文第一句。/);
    assert.match(downloadedMarkdown, /第二集的字幕正文第二句。/);
    assert.ok(downloadedMarkdown.indexOf('## 视频字幕正文') < downloadedMarkdown.indexOf('## 评论楼层'));
    assert.doesNotMatch(downloadedMarkdown, /schema v/i);

    subtitleScenario = 'unavailable';
    await page.evaluate(() => { delete window.GM_xmlhttpRequest; });
    const noSubtitleDownload = page.waitForEvent('download');
    await page.locator('bili-comment-menu .bce-menu-export-item').click();
    const withoutSubtitles = fs.readFileSync(await (await noSubtitleDownload).path(), 'utf8');
    assert.match(withoutSubtitles, /未提供平台字幕轨道/);
    assert.match(withoutSubtitles, /这是一条测试根评论/);
    assert.match(withoutSubtitles, /测试回复 5/);
    assert.doesNotMatch(withoutSubtitles, /第二集的字幕正文第一句。/);
    assert.ok(subtitleCids.length >= 3 && subtitleCids.every(cid => cid === '200'));

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

    await page.goto('https://live.bilibili.com/123');

    await page.evaluate(() => {
      document.querySelectorAll('.quality-item').forEach(el => el.addEventListener('click', () => {
        document.querySelector('.quality-item.active')?.classList.remove('active');
        el.classList.add('active');
      }));
    });

    await page.addScriptTag({ path: path.join(__dirname, '..', 'biliforge.user.js') });
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
    console.log('PASS: three userscripts; P2 subtitle Markdown download and no-subtitle fallback; linked reply graph, native XHR, tracker response and high/low/high live switching; no page errors.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
