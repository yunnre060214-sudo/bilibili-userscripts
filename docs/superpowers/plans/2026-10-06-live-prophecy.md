# Live Prophecy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在直播页添加可用的官方预言入口并发布 raw 安装文件。

**Architecture:** 单文件 userscript 负责公开房间信息查询、路由同步与浮动面板。官方 iframe 负责预言、登录和历史；独立窗口入口与 iframe 使用同一官方地址。

**Tech Stack:** 原生 JavaScript、Shadow DOM、Node test、jsdom 26.1.0（仅开发测试）。

**Spec:** `docs/superpowers/specs/2026-10-06-live-prophecy-design.md`

## Global Constraints

- 版本 `0.1.0`，独立文件 `bilibili-live-prophecy.user.js`。
- 仅公开 GET `room_init`，超时 8 秒；不提交答案、不读取保存 Cookie。
- 支持数字、短号、`/blanc/`，排除非直播页及 iframe 重复注入。
- 只在面板打开时加载官方组件，保持已有产品脚本不变。
- 目标仓库 `yunnre060214-sudo/bilibili-userscripts`，分支 `main`。

## Review Focus

- 短号及带查询参数的房间链接必须以房间信息返回的 uid 为准。
- 旧请求晚于路由切换返回时不可把当前面板切回旧主播。
- 识别接口异常时历史仍可打开并支持重试。
- 非直播页和官方组件页不可重复出现入口。
- 关闭及重复打开不可保留多个 iframe 或重复按钮。

---

### Task 1: Userscript and DOM regression tests

**Files:** 新建脚本、`tests/live-prophecy.test.cjs`、测试 package 文件；更新 README。

**Interfaces:** 消费 `room_init` 的 JSON `code/data.uid`；输出官方 iframe URL 和独立窗口 URL。

- [x] 编写 DOM 行为测试，断言 `13233348` 查询返回的 `353609978` 出现在官方 iframe URL，关闭后 iframe 数为 0；补充 Review Focus 的五个场景。
- [x] 执行 `node --test tests/live-prophecy.test.cjs`，确认因入口功能未实现而失败。
- [x] 实现脚本，使用 Shadow DOM 隔离样式，查询主播、显示面板、历史与重试，处理路由切换竞态。
- [x] 执行脚本测试、语法检查及 `npm test`；所有新测试通过，单独记录已有失败。
- [x] README 添加 raw 安装链接及简短说明；完成自查并提交。

### Task 2: Publish and read back

**Files:** Task 1 的已验证文件。

**Interfaces:** GitHub tree/commit/ref API；raw 安装链接。

- [x] 通过 GitHub 插件读取当前 main，构造保留全部现有内容的增量提交。
- [x] 使用非强制更新发布到 main；有并发更改时重新核对后再处理。
- [x] 回读 main 与 raw 安装文件，核对内容摘要和版本。
- [x] 向用户提供 raw 安装链接及测试范围。

## 验证记录

- 新增脚本：20/20 DOM 行为测试通过，语法检查通过。
- 全仓 Node 测试：47/48 通过，唯一失败为开发前已存在的 BiliForge 画质时序测试。
- 自查已修复独立窗口在路由轮询前点击打开旧主播的竞态，以及 pagehide 中断查询后 pageshow 恢复查询的问题；对应测试均先失败后通过。
- 作者完成自查；未进行独立审查。尚未在真实 Tampermonkey 安装环境执行此脚本。
- 真实参与来自用户在手机网页跳转 App 后提交；桌面当时仅回查到了同一账号的记录。此前“网页参与已验证”结论已撤回。本次测试不进行硬币交易。

## 0.1.1 桌面交互修复记录

- 当前官方 vendor 中 `showConfirm` 调用 `showModal`，只提供 PC_LINK 的回退，普通 WEB 和 PC_ROOM 会等待 App 桥接。
- 在官方组件页面启动时适配 SDK 的弹窗与提示；直播入口仍限定顶层，组件适配允许 iframe，账号及请求实现保持官方逻辑。
- 新增 9 项桌面适配测试，合计 29 项预言测试通过。
- 当前官方 SDK 对照验证：未适配时没有弹窗且 Promise 不返回；适配后显示弹窗，取消返回 `confirm:false`。
- 当前官方 ListItem 组件本地联测：点击“不能”，手动确认，发出模拟硬币检查及 `user_join`（answer=2），调用刷新并显示完成提示；没有连接真实参与接口。
- 桌面真实参与是否被服务器接受仍待真实记录验证。

## 0.1.2 加载修复记录

- 用户反馈 0.1.1 仍不能交互。当前官方 vendor 与此前文件内容一致；先加载 SDK 再注入 0.1.1 时，工厂包装不生效，无适配提示且确认调用无返回。
- 三个新测试先因缺少适配失败：SDK 已缓存、脚本与页面全局分离、iframe 子页面未执行脚本。
- 本地 runtime 探针补适配已有 SDK；直播页在 iframe load 后提供后备适配，所有弹窗使用实际子页面文档。重复调用保持同一适配实例及唯一容器。
- 预言测试 32/32 通过；全仓 59/60 通过，唯一失败仍为原有 BiliForge 画质时序测试。脚本语法检查通过。
- 当前官方 SDK 在提前、晚注入、分离的脚本窗口三种环境均显示确认窗口并由手动取消结束，账号和请求实现保持不变。
- 当前官方 ListItem 先挂载，再从分离的脚本窗口注入；选择、手动确认、模拟资格检查及 user_join（answer=2）、刷新与成功提示均通过。真实网络请求数为 0。
- 作者完成自查；没有独立审查。真实 Tampermonkey 安装环境及桌面真实提交仍未验证。
