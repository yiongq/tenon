# ADR-001：桌面框架选型 —— Electron vs Tauri

- **状态**：建议采纳 Electron
- **日期**：2026-09-11
- **背景**：做一个 MCP host 桌面客户端，TypeScript 主力，个人开发

---

## 决策

**先用 Electron。** 等 MCP 层稳定、真的出现性能瓶颈时，再考虑把那一层迁到 Rust。

---

## 需求前提（决定一切的四条）

| 需求 | Node 依赖 |
|---|---|
| MCP client（`@modelcontextprotocol/client@2.0.0`） | **Node 20+** |
| spawn 并管理 stdio MCP server 子进程 | 绝大多数靠 `npx` / `uvx` |
| `.mcpb` 桌面扩展一键安装 | node 类型扩展需要**真正的 Node 解释器** |
| `@anthropic-ai/sandbox-runtime` 沙箱 | `engines: node >= 20.11.0` |

**四条里三条硬绑 Node ≥ 20。**

---

## Tauri 现状（2026-09-11 核实）

- 最新稳定版 **core 2.11.5**（2026-07-01）
- **无 v3 正式版**，[3.0 milestone](https://github.com/tauri-apps/tauri/milestone/5) 进度 13%，无 due date
  - 计划变更：Linux 迁 GTK4 + WebKitGTK 6.0、去 Windows 7、移除 v1 兼容层
  - ⚠️ **milestone 里没有任何 Servo/Verso 或自带 Chromium 的计划**
- WebView 分平台：Windows = WebView2(Chromium) / macOS = WKWebView(WebKit) / **Linux = webkit2gtk(WebKit，随发行版走)** / Android = System WebView
- 架构：Rust 主进程 + 系统 WebView，IPC 走 JSON 序列化。**WebView 里只有浏览器 JS，没有 Node**

---

## 否决理由（按杀伤力排序）

### 1. ⭐ Node 依赖是结构性的，不是工程量问题

**Tauri 官方立场：不嵌入 Node。** 官方讨论区原话（[Discussion #7037](https://github.com/orgs/tauri-apps/discussions/7037)）：

> "Tauri doesn't embed any node runtime, your only solution would be to package your node app with pkg or something similar and then use it as a sidecar."
>
> "There is no Node.js, only browser based javascript at your disposal."

**官方 Node sidecar 教程指着一个已死项目**：[官方文档](https://v2.tauri.app/learn/sidecar-nodejs/) 推荐用 `pkg`，而 **`pkg` 已于 2024-01-13 归档、官方弃用**（最后版本 5.8.1），README 自己说改用 Node 21 的 SEA。

**Node SEA 的限制**（[2026 指南](https://www.hirenodejs.com/blog/nodejs-single-executable-applications-2026)）：
- 基线体积：Linux x64 ~48MB / macOS arm64 ~46MB / Windows x64 ~50MB，应用代码再 +1–10MB
- native module 不能嵌进 SEA blob，必须以 `.node` 另发，用 `createRequire` 加载
- 运行时没有 `node_modules`，`require.resolve()` / `__dirname` 动态解析全失效
- ⭐ **最致命：SEA 二进制不能充当 Node 解释器给 spawn 出来的子进程用**

**最后一条直接堵死 `.mcpb`。** [mcpb 官方仓库](https://github.com/modelcontextprotocol/mcpb) 明写：

> "Node.js ships with Claude for macOS and Windows, which means your bundle will work out-of-the-box for users"

宿主必须提供一个**真正的、能当解释器用的 Node 可执行文件**。而 `.mcpb` 的 node 扩展是**别人的任意 JS**，你没法在构建期打包。

**结论：无论 Electron 还是 Tauri，你都要发一个完整 Node runtime（~50MB+）。Electron 里它是白送的；Tauri 里它是你要自己下载、签名、公证、按平台分发、管 PATH 的额外资产。**

### 2. 体积优势在这个场景下基本消失

最可信的第一手实测（[gethopp](https://www.gethopp.app/blog/tauri-vs-electron)，作者自己声明 N=1、demo 应用）：

| 指标 (macOS) | Tauri | Electron |
|---|---|---|
| Bundle 体积 | **8.6 MiB** | **244 MiB** |
| 内存（6 窗口） | ~172 MB | ~409 MB |
| 构建时间 | 80.9s | 15.8s |

**但这组数字对本场景严重失真：**

1. 那是**空 demo**。塞进 Node/bun（~50MB）+ uv + sandbox-runtime 依赖后，Tauri 至少 +50~100MB
2. **Linux AppImage 实测 93.7MB**（因为要打包 WebKitGTK 依赖；其他格式 15–18MB）
3. 内存差距会被摊薄 —— **真正吃内存的是 spawn 出来的 N 个 MCP server 子进程，两个框架一模一样**

**你付出了全部架构成本，收益被自己的依赖吃掉。**

⚠️ **未查到** 2026 年针对「同一个 MCP host 分别用 Tauri 和 Electron 实现」的对照实测。所有可查对比都是 hello-world 级别。

### 3. 唯一的成功案例（Jan）用的正是你想避开的方案

实查 [Jan 的 `src-tauri/Cargo.toml`](https://raw.githubusercontent.com/menloresearch/jan/dev/src-tauri/Cargo.toml)：

- **`rmcp` v0.8.5** —— [官方 Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)，features 含 client、transport-child-process、SSE、streamable-http
- tauri 2.8.5、tokio v1 full、tauri-plugin-shell 2.2.0（**但 MCP 不走它**）

**代码分工：**

| 层 | 职责 | 路径 |
|---|---|---|
| Rust (`src-tauri`) | **MCP 服务端生命周期、stdio transport、工具执行** | `src-tauri/src/core/mcp/helpers.rs`、`commands.rs`、`lockfile.rs` |
| TS (`web-app`) | **只做 UI 配置 + `invoke()` 包装** | `TauriMCPService.callTool()`、`MCPOrchestrator`、`useTools` hook |

spawn 实现（实查 `helpers.rs`）：
```rust
TokioChildProcess::builder(build_cmd(use_override))
  .stderr(Stdio::piped())
  .spawn()
// Unix 下设 process_group(0)，以便 kill 整个进程子树
let handler = JanClientHandler::new(ClientInfo::default(), name, app);
handler.serve(process).await
```

⭐ **Jan 根本不打包 Node —— 它打包 `bun` 和 `uv`：**
- `npx` → 检查 `can_override_npx(bun_x_path)`，改用打包的 **`bun x`**
- `uvx` → 检查 `can_override_uvx(uv_path)`，改用打包的 **`uv tool run`**

扩展系统：TS 写，继承 `BaseExtension`（`onLoad()`/`onUnload()`），rolldown 打包成 `.tgz` 放 `/pre-install/`，跑在 webview 里。

**→ Jan 证明 Tauri 能做 MCP host，但它的做法正好是放弃你的技术前提（TS 主力 + 官方 TS SDK）。**

⚠️ **未查到任何生产级项目，在 Tauri 里用 `@modelcontextprotocol/client`（官方 TS SDK）做 MCP host。这是本次调研最重要的空白。**

### 4. 子进程管理用不上 Tauri 的现成能力

`tauri-plugin-shell` 确实有 `execute`/`spawn`/`stdin_write`/`kill` 权限，支持流式读 stdout/stderr。**但默认全部 deny，必须在 `capabilities` 里按命令名/路径/参数正则配 scope。**

⭐ **scope 机制与 MCP host 的需求根本冲突**：MCP host 的本质是「用户在配置文件里写任意 command + args，我去 spawn」，而插件要求命令**预先在编译期的 capability 里声明**。

**已知问题（全部实查）：**

| 问题 | 状态 |
|---|---|
| [tauri#5736](https://github.com/tauri-apps/tauri/issues/5736) `child.write()` 写 stdin 不生效 | 2022-12 报，**closed as not planned**，无修复 |
| [plugins-workspace#687](https://github.com/tauri-apps/plugins-workspace/issues/687) sidecar 从 JS 调用时强行带上 conf 的 args，Rust 侧不带，两边不一致 | 2023-10 开，**至今 open** |
| [tauri#11686](https://github.com/tauri-apps/tauri/issues/11686) 杀不掉会 fork 出第二个进程的子进程 | open |
| [plugins-workspace#2135](https://github.com/tauri-apps/plugins-workspace/issues/2135) Windows 上 `CREATE_NO_WINDOW` 不可配置 | feature request |
| [tauri#3508](https://github.com/tauri-apps/tauri/issues/3508) 子进程清屏输出时 stdout 收不到 | — |

社区为此 fork 了 [`tauri-plugin-shellx`](https://huakunshen.github.io/tauri-plugin-shellx/)（移除权限强制、加 stdin/流式/`fixPathEnv`/`hasCommand`），**但作者自己在文档里挂了醒目警告："It is not recommended to use this plugin."**

**正解是在 Rust 侧直接用 `tokio::process`（Jan 就是这么干的）—— 代价是这部分逻辑必须用 Rust 写。**

### 5. Linux WebView 是持续的、上游的、Tauri 自己解不了的成本

**官方自己承认**：有一整页 [Linux Graphics Issues 文档](https://v2.tauri.app/develop/debug/linux-graphics/)，症状包括窗口空白、resize 闪烁、resize 崩溃、DMABUF framebuffer 错误、Wayland 协议错误。给出四个环境变量 workaround，按推荐顺序降级，最后一手是 `WEBKIT_DISABLE_COMPOSITING_MODE=1`（**彻底关硬件加速**）。

- [tauri#14963 "Bundle chromium renderer"](https://github.com/tauri-apps/tauri/issues/14963) **至今 open、无 assignee、无 PR**。诉求原文：WebKitGTK 性能 "really bad"、"often breaks"、"hard to test for app maintainers since nobody really uses it"
- [tauri#13157](https://github.com/tauri-apps/tauri/issues/13157)（Ubuntu 22.04 + Wayland 出现 DOM "影子拷贝"）被标 `status: upstream` 后 **closed as not planned**

**第一手复盘（最有价值的一篇）**：[Six Months With Tauri: The Benefits and the Bill](https://hackernoon.com/six-months-with-tauri-the-benefits-and-the-bill)，作者做 Tabularis：

- 三个引擎在 CSS、输入处理、GPU 合成上不一致。**具体例子：用户在表格筛选框里打了个直引号，系统自动改成弯引号，生成的 SQL 直接解析失败**
- Linux 图形栈：Wayland 协议错误、DRI_Mesa 扩展缺失、AppImage 空白窗、WebKit 进程 abort
- **glibc 兼容**：在 Ubuntu 新版（glibc 2.39）上构建的二进制在 2.35 上跑不起来，必须回退到旧容器镜像构建
- **AppImage 93.7MB**
- ⭐ **六个月发了 64 个版本来处理 webview 相关 bug**
- IPC 序列化成本：查询结果必须分页（默认 500 行），因为每次跨 IPC 都要 JSON 序列化

**注意作者最终仍然会再选 Tauri**，但明确限定：不是把它当「没有臃肿的 Electron」，而是**只在「Rust 系统级后端 + 富 web UI」这个特定组合下才划算**。

---

## 真正的分叉点

**不是「Tauri vs Electron」，而是「你愿不愿意用 Rust 写 MCP 层」。**

| 选择 | 后果 |
|---|---|
| **愿意用 Rust 写 MCP 层** | Tauri 可行。照抄 Jan：`rmcp` + `TokioChildProcess` + 打包 bun/uv。**但要放弃 TS SDK、放弃 `.mcpb` 开箱即用（没有真 Node）、放弃 `@anthropic-ai/sandbox-runtime`**（或为它单独再塞一个 Node） |
| **要保住 TS 主力** | **用 Electron。** 白送 Node，`.mcpb`/TS SDK/sandbox-runtime 三个需求零成本满足，Chromium 统一渲染，省掉整条 Linux WebView 战线。代价是 ~200MB 安装包和多出一两百 MB 内存 |

**对一个本来就要 spawn 一堆子进程的 MCP host 来说，Electron 的代价是所有选项里最便宜的。**

---

## 一句话总结

**Tauri 的收益是体积和内存，而你的需求（Node runtime + 任意第三方 JS + Node 沙箱工具）会把这部分收益吃掉大半；Tauri 的代价是 Rust 和跨 WebView 兼容，而这部分代价正好砸在你的技术短板上。这是一笔结构性不划算的交易。**

---

## 有待验证的一条可能路径

MCP TS SDK v2 文档说它**支持 Bun**。Jan 已经在包里放了 bun。**理论上可以「Tauri + bun sidecar 跑 TS SDK」。**

⚠️ **但未查到任何人这么做过的公开实例，属于未经验证的推测路线。** 而且 `.mcpb` 的 node 扩展、`@anthropic-ai/sandbox-runtime` 在 bun 下的兼容性**都未查到**证据。

如果哪天真要走 Tauri，这是唯一值得先验证的假设。

---

## 顺带：其他 Tauri MCP host 的调研结果

**基本没有。** 搜索结果被大量反方向的东西污染 —— 「给 AI agent 用来调试 Tauri 应用的 MCP server」（`dirvine/tauri-mcp`、`P3GLEG/tauri-plugin-mcp`、`hypothesi/mcp-server-tauri`、`delorenj/tauri-mcp-server`），**这些不是 MCP host**。

唯一方向正确的：
- **[sublayerapp/tauri-plugin-mcp-client](https://github.com/sublayerapp/tauri-plugin-mcp-client)** —— Rust 实现的 MCP client Tauri 插件，stdio transport、完整 JSON-RPC 2.0、多服务端管理。**但 v0.1.0、4 stars、2 forks，社区几乎为零，不能作为依赖**
- **[Kunkun](https://docs.kunkun.sh/blog/creation/)** —— Tauri 扩展型启动器，作者建站动机原文就是 "NodeJS lacks a built-in sandbox"。**其扩展运行时是 Deno 还是别的、是否碰 MCP，未查到**。它是 `tauri-plugin-shellx` 的来源项目
- **NextChat** —— 关于 MCP 是否 build-time 开关、Tauri 桌面端是否支持 MCP，**未查到实质证据**

**「从 Tauri 迁回 Electron」的案例**：只找到 [ZoneMinder/zmNinjaNg#173](https://github.com/ZoneMinder/zmNinjaNg/issues/173)，桌面端在 1.1.14 从 Tauri 换成 Electron。**但迁移理由未写明 → 未查到。** 其余未查到有分量的复盘。

---

## 参考

- [Tauri Core Releases](https://tauri.app/release/core/) · [3.0 Milestone](https://github.com/tauri-apps/tauri/milestone/5) · [Webview Versions](https://v2.tauri.app/reference/webview-versions/)
- [Tauri: Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/) · [Shell Plugin](https://v2.tauri.app/plugin/shell/) · [Linux Graphics Issues](https://v2.tauri.app/develop/debug/linux-graphics/)
- [Discussion #7037 — whether node can be used in tauri](https://github.com/orgs/tauri-apps/discussions/7037)
- [vercel/pkg (archived)](https://github.com/vercel/pkg) · [Node.js SEA in 2026](https://www.hirenodejs.com/blog/nodejs-single-executable-applications-2026)
- [MCP TS SDK v1→v2 upgrade](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html) · [modelcontextprotocol/mcpb](https://github.com/modelcontextprotocol/mcpb)
- [Jan Cargo.toml](https://raw.githubusercontent.com/menloresearch/jan/dev/src-tauri/Cargo.toml) · [Jan mcp/helpers.rs](https://raw.githubusercontent.com/menloresearch/jan/dev/src-tauri/src/core/mcp/helpers.rs) · [DeepWiki: Jan MCP Integration](https://deepwiki.com/janhq/jan/6-mcp-integration)
- [gethopp: Tauri vs Electron](https://www.gethopp.app/blog/tauri-vs-electron) · [Six Months With Tauri](https://hackernoon.com/six-months-with-tauri-the-benefits-and-the-bill)
