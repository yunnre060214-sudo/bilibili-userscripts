# Bilibili Userscripts

一套面向 Bilibili 网页端的 Tampermonkey 用户脚本集合。当前包含三个相互独立、可以同时安装的工具：**BiliForge** 负责整体网页体验优化，**BiliEcho** 负责评论发送后的可见性检测，**B站评论楼层导出器** 负责把完整评论楼层保存为结构清晰的 Markdown。

## 正式版 1.0.0

从 **2026-09-19** 起，本仓库进入正式发布阶段。此前出现过的 3.x、4.x、1.0.5 等版本号全部视为开发和测试阶段编号，不代表此前已经存在对应的公开稳定版。**1.0.0 是三个脚本共同的首个正式稳定基线。**

- BiliForge **1.0.0**：Bilibili 网页体验整合优化器，覆盖页面清理、URL 清理、动态页、文章复制、播放器、P2P/CDN 与直播体验。
- BiliEcho **1.0.0**：评论发送后自动检查无账号视角下的可见性，区分正常、疑似仅自己可见、疑似秒删和可疑状态，并针对风控响应进行降级与延迟复检。
- 评论楼层导出器 **1.0.0**：在 B 站原生评论三点菜单中增加“导出为 MD”，下载完整楼层并保留精确父子回复关系、锚点、深链路径和关系完整度信息。

三个脚本没有强制依赖关系。只需要其中一个功能时可以单独安装，也可以全部安装。

## 一键安装

推荐使用桌面版 Chrome、Edge 等 Chromium 浏览器配合 Tampermonkey。安装 Tampermonkey 后，直接打开下面对应的 Raw 链接即可进入脚本安装页。

### BiliForge

**用途：** 把日常 B 站网页端中分散的体验优化集中到一个脚本里。

[安装 BiliForge 1.0.0](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/biliforge.user.js)

### BiliEcho

**用途：** 发完评论后自动检查这条评论是否被阿瓦隆和谐。

[安装 BiliEcho 1.0.0](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/biliecho.user.js)

### B站评论楼层导出器

**用途：** 把一个完整评论楼层下载为 Markdown，尤其适合保存长楼、深层互相回复、争论记录和需要后续交给 AI 分析的评论线程。

[安装评论楼层导出器 1.0.0](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-comment-thread-exporter.user.js)

> 新用户只应安装上面三个主文件。仓库中的 `make-bilibili-great-again-promax.user.js` 与 `bilibili-comment-anti-fraud-pro.user.js` 是旧名称迁移入口，用于让历史安装继续收到更新，不需要重复安装。

## BiliForge 1.0.0

BiliForge 的目标是减少 Bilibili 网页端中影响正常使用的广告、追踪参数、P2P/CDN 行为和播放器小问题，同时尽量保持脚本本身模块化，避免每个功能各自重复 Hook 同一个浏览器 API。

### 页面与界面

- 清理部分首页广告、广告占位和相关提示。
- 去除全站灰度滤镜影响。
- 清理 B 站注入的特定网页字体，优先使用系统字体。
- 清理 `vd_source`、`spm*`、`share*` 等常见追踪参数，并针对首页、视频、直播、动态页追加页面专属规则。
- 动态页提供宽屏显示逻辑，并过滤部分商品动态。
- 修复专栏文章复制限制。
- 视频播放器增加裁切模式，可让视频以 `object-fit: cover` 方式填充播放器。

### 网络与播放

- 统一管理 `fetch`、XHR 与 `sendBeacon` 的网络 Hook，避免多个模块重复包裹同一原生接口。
- 拦截部分 Bilibili 统计与追踪请求。
- 禁用或绕开部分 P2P/PCDN 路径，并在视频媒体 URL 中执行 CDN 替换。
- 对 Bilibili 初始化状态中的部分广告和推广数据进行清理。

### 直播优化

BiliForge 已经吸收原来的独立直播画质脚本，不再需要额外安装直播脚本。

- 直播页面处于前台时自动选择当前可用的最高画质。
- 页面隐藏或失去焦点时自动切换到最低画质，减少后台流量和解码负担。
- 回到前台后自动恢复最高画质。
- 对 mcdn、smtcdns 和直播媒体 URL 进行网络层处理。
- `LiveFailureGuard` 会观察直播媒体请求。当连续出现 403、404 或请求失败时，暂时停止自动拉高画质；网络稳定后自动恢复。
- FailureGuard 只做临时保护，不会清除用户原本的最高画质偏好。
- 如果目标画质已经处于选中状态，会跳过重复点击和不必要的播放器刷新。

直播实际可用画质仍取决于账号权限、直播间提供的档位和 Bilibili 服务端状态。脚本不会解锁账号本身不可用的会员画质。

### 运行时调试入口

页面上下文中保留 `window.__BILIFORGE__`，可查看当前版本、配置、Hook 管理器以及直播模块状态。旧的 `__MBGA_PROMAX__` 与 `__MBGA__` 入口暂时继续保留，用于兼容历史调试方式。

## BiliEcho 1.0.0

BiliEcho 关注的是一个非常具体的问题：**评论成功提交，并不等于其他人一定能看到。**

脚本会监听评论发送结果，在等待一段时间后通过 Bilibili 评论接口重新查询对应评论，并尽可能使用无账号视角进行确认。检测结果分为：

- **评论正常可见**：重新查询后能够确认评论存在。
- **疑似仅自己可见**：登录视角与匿名视角之间出现可疑差异。
- **评论疑似秒删**：发送成功后很快无法在重新查询中找到。
- **评论状态可疑**：现有证据不足以安全归入前三类。
- **暂时无法检测**：接口风控或网络状态导致本次检测无法给出可靠结论。

### 风控处理

BiliEcho 会单独识别常见风控响应，不会把接口风控直接误写成“评论被删”。

- 对 `-509`、`-412`、`-352` 等风险控制响应执行降级处理。
- 支持登录请求、BUVID 回退和更弱身份的查询路径。
- 默认支持自动延迟复检，避免刚发送后的短暂状态直接变成最终判断。
- 检测过程中可取消，新的检测任务会进入队列。
- 检测完成后可无限次重新检测，不把第一次结果当成永久状态。

### 可观测性

- 提供设置界面，可调整首次等待时间、请求超时、最大翻页数、分页间隔、延迟复检时间和复检冷却。
- 可复制完整诊断报告，便于排查“到底在哪个请求阶段失败”。
- 可选详细控制台日志。
- 不使用 AI，不需要 API Key。
- 设置保存在浏览器本地存储中。

BiliEcho 给出的是基于接口可见性和重新查询结果的**检测判断**，并非 Bilibili 官方提供的审核结论。遇到持续风控、接口结构变化或服务端异常时，脚本会优先降低结论强度。

## 评论楼层导出器 1.0.0

评论楼层导出器专门解决 B 站长楼难以保存、深层回复难以追踪的问题。

### 使用方式

在视频评论区找到想保存的根评论，点击评论右侧原生三个点菜单。脚本只增加一个入口：

`导出为 MD`

点击后会由浏览器直接下载该楼层的 Markdown 文件。脚本不提供 JSON 导出，也不写入剪贴板。

### 回复关系表达

导出结果采用高密度的平铺线程图，而不是无限缩进的传统树形文本。

- 每条评论获得稳定编号和 Markdown 锚点。
- 每条回复记录自己的精确父评论编号和父作者。
- L1 直接回复不重复整段根评论摘要。
- L2-L3 保留父评论摘要，但不额外输出完整路径。
- L4 及以上显示压缩后的深链路径，方便定位复杂对话。
- 一个评论拥有大量直接回复时，正文只预览前 12 条，其余保留在完整索引中。
- 1000 层级深链不会通过递归不断增加 Markdown 缩进。

### 完整性检查

导出器会尽量区分“接口明确给出的关系”和“根据上下文恢复出的关系”，并检查：

- 明确解析的父子关系数量。
- 推断关系数量。
- 缺失父消息。
- 自引用。
- 多节点循环引用。
- 跨楼层 root。
- 时间倒挂。
- 重复 rpid。

因此，即使 Bilibili 接口返回了部分异常数据，最终 Markdown 也会把关系缺口暴露出来，而不是悄悄拼成一棵看似正常的树。

### 工作方式

脚本采用事件驱动结构。正常浏览评论区时不会持续扫描整个页面，主要在用户打开评论三点菜单以及真正执行导出时工作。导出过程中通过 Bilibili 评论接口分页获取楼层回复，并执行去重、关系重建和 Markdown 渲染。

## 三个脚本能否同时安装

可以。当前正式版已经按“三脚本共同运行”进行兼容性测试。

- BiliForge 负责通用页面和网络层优化。
- BiliEcho 只关注评论发送后的检测流程。
- 评论楼层导出器只关注原生评论菜单与楼层导出。

其中 BiliForge 自己统一管理通用网络 Hook；另外两个脚本只在各自需要的接口和交互路径上工作。

## 权限与隐私

### BiliForge

使用 `unsafeWindow`、`GM_addStyle` 和 `GM_notification`，用于访问页面上下文、注入样式以及在直播异常降级时提示用户。

### BiliEcho

使用 `unsafeWindow`、`GM.xmlHttpRequest / GM_xmlhttpRequest`、`GM_setClipboard`，并只声明连接 `api.bilibili.com`。跨域请求用于重新查询评论状态，剪贴板权限只在用户主动复制诊断报告时使用。

### 评论楼层导出器

使用 `GM_xmlhttpRequest` 并只声明连接 `api.bilibili.com`，用于分页获取评论楼层数据。

三个主脚本都没有配置第三方遥测服务器，也不需要用户填写第三方 API Key。脚本的主要网络目标是 Bilibili 自身页面、媒体资源和 API；更新文件来自本 GitHub 仓库。

## 兼容性与限制

当前主要开发和验证目标是**桌面版 Bilibili 网页 + Tampermonkey + Chromium 浏览器**。Chrome 与 Edge 属于主要使用环境。

- BiliForge 与 BiliEcho 匹配 `https://*.bilibili.com/*`。
- 评论楼层导出器匹配 `https://www.bilibili.com/video/*`。
- 其他用户脚本管理器可能也能运行，但没有作为正式版主要验证目标。
- Bilibili 经常调整前端 DOM、Shadow DOM、接口结构和播放器实现，依赖页面结构的功能未来可能需要跟随更新。
- BiliEcho 无法替代官方审核信息，只能根据实际可查询结果判断。
- 评论导出完整度仍取决于 Bilibili 接口是否愿意返回完整楼层。
- BiliForge 不会绕过账号权限，也不会创造服务端没有提供的画质。

## 自动更新

三个主脚本都在头部配置了稳定的 `@updateURL` 和 `@downloadURL`。安装后，只要 Tampermonkey 正常执行更新检查，就可以从 `main` 分支获取后续版本。

如果 Raw 页面短时间仍显示旧内容，通常属于 GitHub Raw 或浏览器缓存。可以检查仓库中文件头的 `@version` 是否已经更新，再让 Tampermonkey 重新检查更新。

## 版本规则

从正式版 1.0.0 开始使用正常的稳定版本语义：

- `1.0.x`：Bug 修复、兼容性修复和不改变核心行为的小型优化。
- `1.x.0`：新增功能、明显的模块升级或新的用户能力。
- `2.0.0`：存在需要用户关注的重大行为变化、配置迁移或兼容性断裂。

**1.0.0 之前的全部版本号都按测试阶段处理。** 它们只用于记录开发过程，不参与正式稳定版本的大小比较。

## 项目来源与致谢

### BiliForge

BiliForge 的前身是本仓库中的 **Make BiliBili Great Again ProMax**。其早期代码继承并扩展自 kookxiang 的 [Make BiliBili Great Again](https://greasyfork.org/scripts/415714-make-bilibili-great-again)，随后经过模块化重构、统一网络 Hook、P2P/CDN 处理重写、直播模块整合和 FailureGuard 等多轮改造，于正式版阶段统一更名为 BiliForge。

旧文件 `make-bilibili-great-again-promax.user.js` 继续保留为迁移副本，它与当前 BiliForge 主文件同步，但不再作为新用户安装入口。

### BiliEcho

BiliEcho 源自 freedom-introvert 的 [biliSendCommAntifraud](https://github.com/freedom-introvert/biliSendCommAntifraud) 网页油猴脚本方向，在本仓库中经过持续重构与扩展，并保留脚本头部的 GPL-3.0 许可信息和上游来源链接。

旧文件 `bilibili-comment-anti-fraud-pro.user.js` 继续保留为迁移副本，它与当前 BiliEcho 主文件同步，但不再作为新用户安装入口。

### 评论楼层导出器

评论楼层导出器为本仓库独立实现，围绕“完整获取一个楼层，并准确表达谁在回复谁”这一目标持续迭代。

## 开发与测试

仓库包含无第三方依赖的 Node.js 回归测试。建议使用 Node.js 22 或更新版本：

```sh
node --test tests/regression.test.cjs
```

浏览器联测使用 Playwright 和 Chromium：

```sh
node tests/browser-smoke.cjs
```

如果需要指定本机 Chrome 或 Edge，可设置 `BROWSER_PATH`。

浏览器 smoke test 使用本地拦截的测试页面和接口数据，覆盖三个主脚本共同加载、评论原生三点菜单注入、Markdown 下载、分页去重、关系图渲染、原生 JSON XHR、请求拦截以及 BiliForge 的直播前台最高、后台最低、重新恢复最高画质流程。测试不会连接真实评论发布接口，也不会替用户发布评论。

## 反馈

如果 Bilibili 页面更新导致某项功能失效，建议提交 GitHub Issue，并尽量附带：

1. 失效的脚本名称与版本。
2. 浏览器与 Tampermonkey 版本。
3. 出问题的 Bilibili 页面类型。
4. 控制台错误或 BiliEcho 诊断报告。
5. 能稳定复现问题的最短步骤。

仓库地址：

https://github.com/yunnre060214-sudo/bilibili-userscripts

## 免责声明

本项目是第三方浏览器用户脚本集合，与哔哩哔哩官方无隶属关系。页面结构、接口策略、风控规则和播放器实现均可能随 Bilibili 更新发生变化，请以实际运行结果为准。
