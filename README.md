# Bilibili Userscripts

个人 Bilibili 用户脚本同步仓库。仓库中的脚本使用稳定的 `.user.js` 地址，适合在 Tampermonkey 中安装和更新。

## 安装

在安装了 Tampermonkey 的设备上打开下面的 Raw 地址即可安装：

- [哔哩发评反诈 Pro](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/bilibili-comment-anti-fraud-pro.user.js)
- [B站评论楼层导出器](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/bilibili-comment-thread-exporter.user.js)
- [B站直播自动最高/最低画质](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/bilibili-live-auto-quality.user.js)
- [Make BiliBili Great Again ProMax](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/make-bilibili-great-again-promax.user.js)

如果 Tampermonkey 安装页显示的版本落后于仓库，可改用目标提交 SHA 对应的 Raw 地址绕过缓存。

## 更新

修改对应的 `.user.js` 文件并提交到 `main` 分支时，必须同步递增文件头部的 `@version`。Tampermonkey 会根据脚本自身的 `@updateURL` 与 `@downloadURL` 检查新版本。

## 本次优化

- 发评反诈 Pro **4.2.3**：支持 JSON 类型的 XHR 响应，复用请求对象时按当前地址判断；取消检测后不再启动匿名回退请求。已经在途的请求仍可能等待返回或超时。
- 评论楼层导出器 **1.0.0**：重构为事件驱动架构。删除常驻页面扫描、浮动面板、评论列表预抓取以及对页面 fetch/XHR 的劫持；直接从 `BILI-COMMENT-ACTION-BUTTONS-RENDERER.__data` 获取当前评论的 rpid、root、oid 与点赞信息，并在原生 `bili-comment-menu` 的 Shadow DOM 中加入“导出本楼”和“导出本楼 JSON”。导出数据新增 schema v1、IP 属地、UID、回复目标、完整性校验、分页去重、嵌套回复展平、请求重试与导出任务取消。
- 直播画质 **2.4.2**：菜单加载期间保留最新的前后台切换意图；没有可选画质时不触发播放器刷新。
- ProMax **3.1.2**：修复拦截 fetch 时空 204 响应的构造错误，以及复用 XHR 时残留的拦截标记。

## 评论楼层导出器 1.0.0

在视频评论右侧点击三个点，原生菜单会增加：

- `导出本楼`：复制完整楼层 Markdown。
- `导出本楼 JSON`：下载完整楼层 JSON。

JSON 顶层包含 `schemaVersion: 1`，脚本版本和数据格式版本彼此独立。每条评论会尽量保留 rpid、root、parent、UID、用户名、发布时间、点赞数、IP 属地、正文、图片、表情和跳转链接。

脚本只在用户打开评论三点菜单和执行导出时工作，不再持续扫描整个评论区。

## 验证

使用 Node.js 22 或更新版本运行无第三方依赖的回归测试：

```sh
node --test tests/regression.test.cjs
```

浏览器联测需要可解析的 `playwright` 包和 Chromium。可设置 `BROWSER_PATH` 指向本机 Chrome/Edge 可执行文件，然后运行：

```sh
node tests/browser-smoke.cjs
```

浏览器联测使用本地拦截的页面和接口数据，覆盖四脚本共同加载、原生评论三点菜单注入、Markdown 复制、JSON 下载、schema v1、分页去重、原生 JSON XHR、请求拦截和画质切换。不会连接真实评论接口或发布评论；不能替代真实 B 站页面、账号风控、会员画质及 Tampermonkey 沙箱的端到端验证。
