// Chromium layout/interaction checks. All pages are local fixtures; no Bilibili requests.
// NODE_PATH can point to an installed Playwright. Mirrors the existing browser-smoke runner.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'biliframe.user.js'), 'utf8');

// Structure and sending-area height inspected on the current www.bilibili.com video page.
// Position/width rules deliberately include original sticky, wide and min-width constraints.
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing:border-box; } body { margin:0; font:14px sans-serif; min-width:1100px; background:#fff; }
  #biliMainHeader { height:64px; background:#f6f7fb; } #app { min-width:1100px; }
  .video-container-v1 { display:flex; position:relative; width:1100px; padding:0 10px; margin:0 auto; }
  .left-container { width:730px; position:sticky; top:0; } .right-container { width:320px; margin-left:30px; }
  .right-container-inner { position:sticky; top:72px; } .video-info-container { height:104px; padding-top:16px; }
  h1 { font-size:20px; margin:0 0 16px; } .video-title { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #playerWrap,#bilibili-player,.bpx-docker,.bpx-player-container { width:730px; height:457px; }
  #playerWrap { position:relative; } #bilibili-player { background:#000; }
  .bpx-player-container { min-width:600px; } .bpx-player-primary-area { display:flex; flex-direction:column; height:100%; }
  .bpx-player-video-area { position:relative; height:411px; flex:1; min-height:0; }
  .bpx-player-video-perch,.bpx-player-video-wrap,video { height:100%; width:100%; }
  video { display:block; object-fit:contain; background:linear-gradient(135deg,#132934,#42385b); }
  .bpx-player-sending-area { height:46px; flex-shrink:0; background:#f2f3f5; display:flex; align-items:center; padding:8px; }
  .video-toolbar-container { padding:16px 0; border-bottom:1px solid #ddd; }
  #commentapp { height:900px; padding:20px 0; } .right-container-inner { height:1100px; background:#f6f7fb; padding:16px; }
  .video-desc-container { padding:16px 0; } .video-tag-container { padding:12px 0; }
  html.native-wide .left-container { width:1080px; } html.native-wide #playerWrap { width:1080px; }
  html.native-wide .right-container { display:none; }
  .bpx-player-container[data-screen="web"] { position:fixed; inset:0; width:100vw; height:100vh; z-index:10000; }
  .bpx-player-container[data-screen="mini"] { position:fixed; right:20px; bottom:20px; width:320px; height:226px; min-width:0; z-index:10000; }
</style></head><body><div id="app"><div id="biliMainHeader">Bilibili 搜索、账号与导航</div>
<div class="video-container-v1" id="mirror-vdcon"><div class="left-container scroll-sticky">
<div class="video-info-container" id="viewbox_report"><h1 class="video-title">窗口自适应验证 · 保留视频原比例、弹幕和完整评论</h1><span>播放量 · 发布时间</span></div>
<div id="playerWrap" class="player-wrap"><div id="bilibili-player-placeholder"></div><div id="bilibili-player"><div class="bpx-docker bpx-docker-major"><div class="bpx-player-container" data-screen="normal">
<div class="bpx-player-primary-area"><div class="bpx-player-video-area"><div class="bpx-player-video-perch"><div class="bpx-player-video-wrap"><video></video></div></div></div>
<div class="bpx-player-sending-area"><span>弹幕</span><input placeholder="发个友善的弹幕"><button id="send">发送</button></div></div></div></div></div></div>
<div class="video-toolbar-container">点赞 · 投币 · 收藏 · 分享</div><div class="video-desc-container">视频简介保留在页面中。</div><div class="video-tag-container">视频标签</div><div id="commentapp">评论区<input placeholder="评论输入框"></div>
</div><div class="right-container"><div class="right-container-inner">UP 主信息、弹幕列表、分 P 与相关推荐</div></div><div class="fixed-sidenav-storage"></div></div></div></body></html>`;

(async () => {
  const browser = await chromium.launch({ headless:true, ...(process.env.BROWSER_PATH ? {executablePath:process.env.BROWSER_PATH} : {}) });
  let passed = 0;
  try {
    const page = await browser.newPage({viewport:{width:1536,height:745}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({contentType:'text/html',body:fixture}));
    await page.goto('https://www.bilibili.com/video/BV1UGa961Ejt/');
    const geometry = () => page.evaluate(() => {
      const rect = selector => {const e=document.querySelector(selector),r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom};};
      return { player:rect('#playerWrap'), title:rect('#viewbox_report'), right:rect('.right-container'), sending:rect('.bpx-player-sending-area'),
        root:rect('.video-container-v1'), header:rect('#biliMainHeader'), overflow:document.documentElement.scrollWidth > innerWidth,
        height:innerHeight, mode:document.documentElement.dataset.biliframeMode, active:document.documentElement.hasAttribute('data-biliframe-active') };
    });
    const native = await geometry();
    await page.evaluate(() => {window.originalVideo=document.querySelector('video');window.originalWrap=document.querySelector('#playerWrap');window.originalParent=window.originalWrap.parentElement;window.sent=0;document.querySelector('#send').addEventListener('click',()=>window.sent++);});
    await page.addScriptTag({content:source});
    await page.locator('html[data-biliframe-active]').waitFor();
    if (process.env.FRAME_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.FRAME_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.FRAME_SCREENSHOT_DIR,'cinema.png')});
    }
    const clickMode = async mode => {
      await page.locator(`#biliframe-toolbar button[data-mode="${mode}"]`).click();
      await page.waitForFunction(mode => document.documentElement.dataset.biliframeMode === mode, mode);
      await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    };
    for (const [width,height] of [[1536,745],[1280,720],[1363,936],[1920,1080],[820,620],[620,420]]) {
      await page.setViewportSize({width,height});
      await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      const g=await geometry();
      assert(g.player.y < g.title.y, 'Cinema: player must precede the title');
      assert(g.sending.bottom <= height+1, `Sending area must fit ${width}×${height}: ${g.sending.bottom}`);
      assert(g.player.w >= width-65, 'Cinema must use almost all horizontal space');
      assert(!g.overflow, 'No horizontal page overflow');
      passed++;
    }
    await page.setViewportSize({width:1536,height:745});
    // Later hydration can overwrite attributes on existing nodes without replacing them.
    await page.evaluate(()=>{for(const e of document.querySelectorAll('[data-biliframe-root],[data-biliframe-left],[data-biliframe-right]')) for(const a of [...e.attributes]) if(a.name.startsWith('data-biliframe-')) e.removeAttribute(a.name);});
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert(await page.locator('[data-biliframe-root]').count(), 'Hydration must not permanently drop layout markers');passed++;
    await page.evaluate(()=>{document.documentElement.removeAttribute('data-biliframe-active');document.querySelector('.video-container-v1').removeAttribute('style');});
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert((await geometry()).active && (await geometry()).player.w >= 1471,'Late attribute/style rewrites must recover');passed++;
    await page.evaluate(()=>document.getElementById('biliframe-style').remove());
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert(await page.locator('#biliframe-style').count());assert((await geometry()).player.w >= 1471,'Removed stylesheet must be reattached');passed++;
    await page.evaluate(()=>document.getElementById('biliframe-style').disabled=true);
    await page.waitForFunction(()=>!document.getElementById('biliframe-style').disabled,{},{timeout:2500});
    assert((await geometry()).player.w >= 1471,'Disabled stylesheet must recover');passed++;
    await page.evaluate(()=>{const w=document.querySelector('#playerWrap'),slot=document.createElement('div');slot.id='late-player-shell';w.replaceWith(slot);slot.appendChild(w);});
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    let late=await geometry();assert(late.active && late.player.y < late.title.y && late.player.w>=1471,'A new player ancestor must keep the cinema grid');passed++;
    await page.evaluate(()=>{const slot=document.getElementById('late-player-shell');slot.replaceWith(document.querySelector('#playerWrap'));});
    await page.evaluate(()=>{window.savedAside=document.querySelector('.right-container');window.savedAside.remove();});
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert(await page.locator('html[data-biliframe-active]').count(),'Loading or absent recommendations must not disable the player layout');
    assert.equal(await page.locator('[data-biliframe-root]').evaluate(r=>getComputedStyle(r).gridTemplateColumns.split(' ').length),1);
    await page.evaluate(()=>document.querySelector('.video-container-v1').appendChild(window.savedAside));
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert(await page.locator('[data-biliframe-right]').count());passed++;
    await page.addStyleTag({content:'#app #mirror-vdcon {width:1100px!important;display:flex!important;} #app .left-container {width:730px!important;position:sticky!important;}'});
    late=await geometry();assert(late.active && late.player.w>=1471,'Later native layout CSS must not override the selected layout');
    await page.evaluate(()=>{for(const s of document.querySelectorAll('style')) if(s.textContent.startsWith('#app #mirror-vdcon'))s.remove();});passed++;
    await clickMode('daily');
    let g=await geometry();
    assert(g.title.y < g.player.y && g.right.x >= g.player.x+g.player.w, 'Daily: title above player, recommendation alongside');
    assert(g.sending.bottom<=745 && !g.overflow); passed++;
    await page.locator('#biliframe-toolbar [data-action="nav"]').click();
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    g=await geometry();assert.equal(g.header.h,64);assert(g.sending.bottom<=745);passed++;
    await clickMode('original');
    g=await geometry();for(const key of ['player','title','right','header']) assert.deepEqual(g[key],native[key], 'Original geometry fully restored');
    assert(!g.active);passed++;
    await clickMode('cinema');
    await page.locator('.bpx-player-sending-area input').fill('本地弹幕输入验证');
    await page.locator('#send').click();assert.equal(await page.evaluate(()=>window.sent),1);passed++;
    await page.locator('.bpx-player-sending-area input').press('Alt+l');assert.equal((await geometry()).mode,'cinema');passed++;
    await page.locator('body').click({position:{x:10,y:200}});await page.keyboard.press('Alt+l');assert.equal((await geometry()).mode,'daily');passed++;
    await clickMode('cinema');
    await page.locator('#biliframe-toolbar [data-action="settings"]').click();
    await page.locator('#biliframe-toolbar [name="height"]').fill('80');
    await page.locator('#biliframe-toolbar [name="sidebar"]').fill('380');
    await page.keyboard.press('Escape');assert(await page.locator('#biliframe-toolbar .panel').isHidden());passed++;
    const prefs=await page.evaluate(()=>JSON.parse(localStorage.getItem('biliframe.settings.v1')));assert.equal(prefs.height,80);assert.equal(prefs.sidebar,380);passed++;
    await page.addScriptTag({content:source});assert.equal(await page.locator('#biliframe-toolbar').count(),1);passed++;
    assert(await page.evaluate(()=>document.querySelector('video')===window.originalVideo && document.querySelector('#playerWrap')===window.originalWrap && window.originalWrap.parentElement===window.originalParent));passed++;
    for (const screen of ['web','full','mini']) {
      await page.evaluate(screen=>document.querySelector('.bpx-player-container').setAttribute('data-screen',screen),screen);
      await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-biliframe-active'));
      assert(await page.locator('#biliframe-toolbar').isHidden(),'Native special screens hide toolbar');
      await page.evaluate(()=>document.querySelector('.bpx-player-container').setAttribute('data-screen','normal'));
      await page.locator('html[data-biliframe-active]').waitFor();passed++;
    }
    await page.evaluate(()=>{document.documentElement.classList.add('native-wide');document.querySelector('.bpx-player-container').setAttribute('data-screen','wide');});
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    g=await geometry();assert(g.active && !g.overflow && g.sending.bottom<=745);passed++;
    await page.evaluate(()=>{const v=document.querySelector('video');Object.defineProperty(v,'videoWidth',{value:1080,configurable:true});Object.defineProperty(v,'videoHeight',{value:1920,configurable:true});v.dispatchEvent(new Event('loadedmetadata'));});
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert((await geometry()).sending.bottom<=745);assert.equal(await page.locator('video').evaluate(v=>getComputedStyle(v).objectFit),'contain');passed++;
    await page.evaluate(()=>{const c=document.querySelector('.bpx-player-container');c.replaceWith(c.cloneNode(true));});
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert((await geometry()).active);assert.equal(await page.locator('#biliframe-toolbar').count(),1);passed++;
    await page.evaluate(()=>{const h=document.querySelector('#biliMainHeader');h.replaceWith(h.cloneNode(true));});
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert((await geometry()).active && (await geometry()).sending.bottom<=745);passed++;
    await page.evaluate(()=>history.pushState({},'', '/read/cv123'));await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-biliframe-active'));assert(await page.locator('#biliframe-toolbar').isHidden());passed++;
    await page.evaluate(()=>history.pushState({},'', '/video/BV1UGa961Ejt/'));await page.locator('html[data-biliframe-active]').waitFor();passed++;
    // Browser fullscreen is distinct from the player's data-screen flag.
    await page.evaluate(()=>document.querySelector('#bilibili-player').requestFullscreen());
    await page.waitForFunction(()=>document.fullscreenElement && !document.documentElement.hasAttribute('data-biliframe-active'));
    await page.evaluate(()=>document.exitFullscreen());await page.locator('html[data-biliframe-active]').waitFor();passed++;
    await page.reload();await page.addScriptTag({content:source});await page.locator('html[data-biliframe-active]').waitFor();
    assert.equal(await page.locator('#biliframe-toolbar [name="height"]').inputValue(),'80');passed++;
    await page.evaluate(()=>document.querySelector('#playerWrap').remove());await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-biliframe-active'));passed++;
    const early=await browser.newPage({viewport:{width:1280,height:720}});
    await early.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture}));
    await early.addInitScript({content:source});await early.goto('https://www.bilibili.com/video/BV1UGa961Ejt/');
    await early.locator('html[data-biliframe-active]').waitFor();await early.close();passed++;
    assert.deepEqual(errors,[]);
    console.log(`BiliFrame: ${passed} browser checks passed; no page errors. Network: local fixtures only.`);
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
