# Bilibili Userscripts

个人 Bilibili 用户脚本同步仓库。仓库中的脚本使用稳定的 `.user.js` 地址，适合在 Tampermonkey 中安装和更新。

## 安装

在安装了 Tampermonkey 的设备上打开下面的 Raw 地址即可安装：

- [哔哩发评反诈 Pro](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-comment-anti-fraud-pro.user.js)
- [B站评论楼层导出器](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-comment-thread-exporter.user.js)
- [B站直播自动最高/最低画质](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-live-auto-quality.user.js)
- [Make BiliBili Great Again ProMax](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/make-bilibili-great-again-promax.user.js)

## 更新

以后直接编辑对应的 `.user.js` 文件并提交到 `main` 分支即可。每次修改代码时必须同步递增文件头部的 `@version`，Tampermonkey 才会识别为新版本；在油猴设置中点击“检查更新”即可拉取更新。

## 本次优化

- 发评反诈 Pro **4.2.3**：支持 JSON 类型的 XHR 响应，复用请求对象时按当前地址判断；取消检测后不再启动匿名回退请求。已经在途的请求仍可能等待返回或超时。
- 评论楼层导出器 **0.4.3**：扫描改为合并调度，排除自身面板重绘，避免持续页面变化造成扫描饥饿或循环；兼容 JSON XHR；观察响应失败不影响原请求；分页按 rpid 去重，重复分页及时停止，并对不完整结果给出提示。
- 直播画质 **2.4.2**：菜单加载期间保留最新的前后台切换意图；没有可选画质时不触发播放器刷新。
- ProMax **3.1.2**：修复拦截 fetch 时空 204 响应的构造错误，以及复用 XHR 时残留的拦截标记。

## 验证

使用 Node.js 22 或更新版本运行无第三方依赖的回归测试：

```sh
node --test tests/regression.test.cjs
```

浏览器联测需要可解析的 `playwright` 包和 Chromium。可设置 `BROWSER_PATH` 指向本机 Chrome/Edge 可执行文件，然后运行：

```sh
node tests/browser-smoke.cjs
```

浏览器联测使用本地拦截的页面和接口数据，覆盖四脚本共同加载、面板点击、Markdown 复制、JSON 下载、原生 JSON XHR、请求拦截和画质切换。不会连接真实评论接口或发布评论；不能替代真实 B 站页面、账号风控、会员画质及 Tampermonkey 沙箱的端到端验证。
