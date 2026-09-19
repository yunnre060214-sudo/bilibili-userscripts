# Bilibili Userscripts

个人 Bilibili 用户脚本同步仓库。仓库中的脚本使用稳定的 `.user.js` 地址，适合在 Tampermonkey 中安装和更新。

## 安装

在安装了 Tampermonkey 的设备上打开下面的 Raw 地址即可安装：

- [哔哩发评反诈 Pro](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/bilibili-comment-anti-fraud-pro.user.js)
- [B站评论楼层导出器](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/bilibili-comment-thread-exporter.user.js)
- [B站直播自动最高/最低画质](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/bilibili-live-auto-quality.user.js)
- [BiliForge](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/refs/heads/main/biliforge.user.js)

如果 Tampermonkey 安装页显示的版本落后于仓库，可改用目标提交 SHA 对应的 Raw 地址绕过缓存。

## 更新

修改对应的 `.user.js` 文件并提交到 `main` 分支时，必须同步递增文件头部的 `@version`。Tampermonkey 会根据脚本自身的 `@updateURL` 与 `@downloadURL` 检查新版本。

## 本次优化

- 发评反诈 Pro **4.2.3**：支持 JSON 类型的 XHR 响应，复用请求对象时按当前地址判断；取消检测后不再启动匿名回退请求。已经在途的请求仍可能等待返回或超时。
- 评论楼层导出器 **1.0.5**：在 1.0.4 的关系校验基础上压缩 Markdown 冗余。L1 直接回复不再重复根评论摘要，L2-L3 不再额外输出路径，L4 及以上继续保留压缩路径；父子编号、锚点、大分叉完整索引和异常关系索引保持不变。
- 直播画质 **2.4.2**：菜单加载期间保留最新的前后台切换意图；没有可选画质时不触发播放器刷新。
- BiliForge **3.2.0**：由 Make BiliBili Great Again ProMax 正式更名；保留原功能与兼容接口，并新增 `__BILIFORGE__` 运行时入口。旧 Raw 路径暂时保留用于自动更新迁移。

## 评论楼层导出器 1.0.5

在视频评论右侧点击三个点，原生菜单只增加一个入口：

- `导出为 MD`：由浏览器直接下载完整楼层 `.md` 文件。

Markdown 继续使用平铺线程图表达回复关系，每条评论都有唯一编号和锚点。1.0.5 在不改变父子关系的前提下减少浅层重复信息：

- L1 直接回复只显示父评论编号和作者，不重复整段根评论摘要。
- L2-L3 保留精确父评论编号与父摘要，但不额外输出完整路径。
- L4 及以上继续显示压缩路径，便于阅读深链。
- 大分叉正文仍只预览前 12 条直接回复，完整列表保留在文末索引。
- 关系完整度、推断关系、缺失父消息、异常关系和重复 rpid 统计继续保留。

关系校验规则沿用 1.0.4，会检测自引用、循环引用、跨楼层 root、时间倒挂和缺失父消息等异常。脚本只在用户打开评论三点菜单和执行导出时工作，不持续扫描整个评论区。

## 验证

使用 Node.js 22 或更新版本运行无第三方依赖的回归测试：

```sh
node --test tests/regression.test.cjs
```

浏览器联测需要可解析的 `playwright` 包和 Chromium。可设置 `BROWSER_PATH` 指向本机 Chrome/Edge 可执行文件，然后运行：

```sh
node tests/browser-smoke.cjs
```

浏览器联测使用本地拦截的页面和接口数据，覆盖四脚本共同加载、原生评论三点菜单注入、Markdown 文件下载、分页去重、关系图渲染、原生 JSON XHR、请求拦截和画质切换。不会连接真实评论接口或发布评论；不能替代真实 B 站页面、账号风控、会员画质及 Tampermonkey 沙箱的端到端验证。
