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

- [ ] 通过 GitHub 插件读取当前 main，构造保留全部现有内容的增量提交。
- [ ] 使用非强制更新发布到 main；有并发更改时重新核对后再处理。
- [ ] 回读 main 与 raw 安装文件，核对内容摘要和版本。
- [ ] 向用户提供 raw 安装链接及测试范围。

## 验证记录

- 新增脚本：20/20 DOM 行为测试通过，语法检查通过。
- 全仓 Node 测试：47/48 通过，唯一失败为开发前已存在的 BiliForge 画质时序测试。
- 自查已修复独立窗口在路由轮询前点击打开旧主播的竞态，以及 pagehide 中断查询后 pageshow 恢复查询的问题；对应测试均先失败后通过。
- 作者完成自查；未进行独立审查。尚未在真实 Tampermonkey 安装环境执行此脚本。
- 预言参与和历史回查此前通过官方网页真实验证；本次测试不进行硬币交易。
