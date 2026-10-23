# 复刻 Claude Desktop：主参考（第四版 rev3，2026-09-12）

> 本文是项目唯一的主参考（两份早期来源文档已并入本文并删除）。
> 深入材料另见：[goose-mechanisms](../reference/goose-mechanisms.md)、[deepchat-mechanisms](../reference/deepchat-mechanisms.md)、[sandbox-runtime-mechanisms](../reference/sandbox-runtime-mechanisms.md)、[ADR-001](../adr/adr-001-electron-vs-tauri.md)、[claude-desktop-feature-map](../reference/claude-desktop-feature-map.md)。

---

## 第四版修订说明

### 已定决策

| 决策 | 结论 | 依据 |
|---|---|---|
| **桌面框架** | **Electron** | ADR-001。Node 依赖是结构性的，Tauri 的体积优势被 Node runtime 吃掉 |
| **Agent 路线** | **路线 A：自研 agent loop** | "端到端吃透"与"业界最佳实现"都要求内核在自己手里。路线 B（OpenCode）保留为阶段 2 的对照组 |
| **MCP SDK** | **`@modelcontextprotocol/client@2.0.0`**，spec 2026-07-28 | v1 保底维护到 2027-01 前后 |
| **沙箱** | **`@anthropic-ai/sandbox-runtime`** + Codex 三档语义 | 不需要容器，TS 98.5%，三平台 |
| **质量目标** | **业界最佳实现水准**，不按演示项目取舍 | 2026-09-11 决定。各阶段验收标准见 §13 |
| **仓库** | **另起新仓库，名 Tenon**（榫：靠结构咬合不靠胶水），不在既有 Web 项目上改 | 运行时（Electron 主进程 / OS 沙箱 / 本地文件桥）与 Web 平台的权限模型完全不同，单独建仓。可复用的部分后期抽包 |
| **开发流程** | **DeepChat 式轻量 SDD**：`AGENTS.md`（架构规则 + 约束，正本；`CLAUDE.md` 一行转发）+ 每个实质性目标一个 `docs/architecture/<goal>/spec.md` + `plan.md` + 少量仓库内 skills。不上 BMAD / OpenSpec 等第三方框架 | 源码核实（2026-09-11）：Cherry Studio 与 DeepChat 都**没有**用第三方规格框架，都是 `CLAUDE.md`/`AGENTS.md` + `.claude/skills` 或 `.agents/skills`；DeepChat 另有自研 `docs/spec-driven-dev.md`（337 行：spec 是 RFC，plan 是唯一执行跟踪，明确不建 `tasks.md`，测试不驱动实现）。spec.md 就是"这里定架构 → Claude Code 实现"的交接物，达标线写在它的 acceptance criteria 里 |
| **多租户** | **对齐 Claude Desktop 的第三层：服务端多租户**。租户 = 组织（个人 / Team / Enterprise），用户可属于多个组织；云端会话、Projects、记忆、连接器授权、定时任务、管理员策略都是组织作用域 | 2026-09-12 决定。后果见 §4.13 与 §13 |
| **内核与壳分离** | **`packages/kernel` 不依赖 Electron**（agent loop、Provider、Tape、权限 broker、MCP host 全在里面），通过 `HostAdapter` 接文件系统 / 密钥 / 沙箱 / 用户确认；`apps/desktop` 是本地 host，`apps/server` 是云端多租户 host | 多租户的直接推论：同一个内核要能在用户机器上跑，也要能在服务端的租户沙箱里跑。Goose（core lib + goosed + desktop）和 Claude Desktop（Cowork 云端 = 内核在 Anthropic 沙箱、桌面是桥）都是这个结构。**DeepChat 是反例：内核和 Electron 主进程缠在一起，抽不出来** |
| **分工** | **本项目只定架构**（ADR、模块边界、接口、验收标准）；**实现在 Claude Code 中做** | 源码阅读也分两层：架构决策所需的机制拆解在这里做（如 Goose 那份），实现细节由 Claude Code 现场读源码 |

### 修正的错误

1. **Cherry Studio 版本**：第三版写 "v2.0.14 ✅"，核实 releases 页**最新是 v1.9.11（2026-06-07），无任何 v2.x release**。V2 代码在 main 分支但未发布。→ 路径可信，但 **main 处于 v1/v2 并存的重构中期，不宜整仓 clone 阅读，只读 `CLAUDE.md` 和指定文件**。
2. **AionUi star 数**：第三版沿用 4 月的 2.2 万，核实 9 月 11 日为 **32.7k**。
3. **AionUi 的 Rust 疑问**：第三版标 ❓，核实为 **Rust 在独立的 AionCore 仓库（`aionrs` 引擎），主仓库是 Electron/TS**。已解。
4. **"本地 Agent 的安全隔离非常难做"和"虚拟机级沙箱暂时不做"**：这两条在 `@anthropic-ai/sandbox-runtime` 面前已过时。OS 级沙箱现在是一个 npm 依赖，不是一个研发项目。见 §4.10。

### 新增内容

- §4.8 Agent 循环大幅扩写（路线 A 的核心）：Goose 六步循环、四种上下文管理手段、权限引擎四层设计
- §4.10 沙箱（新节）
- §4.11 权限引擎设计要点（新节）：Cline / Zed / DeepChat / Goose 的可抄结论
- §3 对照表新增 sandbox-runtime、Goose、Cline、Zed、DeepChat 验证路径
- §13 阶段路线按路线 A 重排
- 第 15 节：本版审查发现的遗留问题

### 标注含义

| 标注 | 含义 |
|---|---|
| ✅ 已核实 | 直接在 GitHub 原始文件或官方页面确认 |
| ⚠️ 二手 | 来自媒体或第三方，未直接核实 |
| ❓ 存疑 | 来源冲突或未找到证据 |
| 🟢 / 🟡 / 🔴 | 可复制代码 / 仅可阅读学习 / 需商业授权 |

> 许可证判断仅供参考，不构成法律意见。

---
---

# 上篇：复刻 Claude Desktop

## 1. 一句话结论

**"拼装 + 打磨"，agent loop 自己写。**

- **壳**：Electron + React + TypeScript（与 Claude Desktop 本身一致，ADR-001）
- **架构**看 Cherry Studio 的 `CLAUDE.md`（只读），**后端逻辑**抄 LibreChat（MIT），**MCP v2 写法**看 DeepChat（Apache）
- **Agent loop**：自己写。参照 Goose（Rust，设计最清楚）、OpenCode（TS）、computer-use-demo（最小实现）
- **沙箱**：直接用 `@anthropic-ai/sandbox-runtime`，产品语义层抄 Codex
- **UI** 从 assistant-ui 的 Claude 示例起步，交互参考 Claude，视觉最终换成自己的
- **协议**一律 MCP 2026-07-28 + TS SDK v2

## 2. 精读项目（按路线 A 排序）

| # | 项目 | 读什么 | 许可证 | 时间 |
|---|---|---|---|---|
| 1 | **DeepChat** | 权限 Broker、Tape、工具调用身份、MCP v2 host、MCP Apps 安全边界 | Apache-2.0 🟢 | 半天（读 [deepchat-mechanisms](../reference/deepchat-mechanisms.md) 即可，路径已实地核实） |
| 2 | **Goose** | agent 循环、上下文管理四手段、provider 抽象、权限四层 | Apache-2.0 🟢 | 2 天（读拆解文档即可） |
| 3 | **sandbox-runtime** | 直接用；API 形状、规则语义、Electron 打包钩子 | Apache-2.0 🟢 | 半天（读 [sandbox-runtime-mechanisms](../reference/sandbox-runtime-mechanisms.md) 即可） |
| 4 | **OpenCode** | TS 实现的 agent 循环、plan/act 双模式、上下文压缩、子 agent | MIT 🟢 | 2–3 天 |
| 5 | **LibreChat** | MCP 管理、OAuth 落地、Artifacts（Sandpack）、RAG | MIT 🟢 | 2 天 |
| 6 | **Cline** | 只读 `docs/features/auto-approve.mdx` + `sdk/` | Apache-2.0 🟢 | 半天 |
| 7 | **assistant-ui** | Claude 示例、Artifacts 示例 | MIT 🟢 | 1 天 |
| 8 | **Cherry Studio** | 只读 `CLAUDE.md` + `src/main/core/paths/README.md` | AGPL-3.0 🟡 | 1 天 |
| 9 | **MCP 官方组** | typescript-sdk、servers（Everything）、inspector、mcpb、ext-apps | MIT 🟢 | 按需 |

## 3. 对照表：功能模块 → 项目 → 代码位置 → 许可证

> 路径标 ✅ 的已在 GitHub 主分支确认。仓库持续变化，以实际为准。

### 3.1 壳层与基础设施

| 功能模块 | 推荐项目 | 代码位置 | 许可证 |
|---|---|---|---|
| 主进程分层与 DI | Cherry Studio | `CLAUDE.md` ✅（`BaseService` + `@Injectable`/`@ServicePhase`/`@DependsOn` + `serviceRegistry.ts`） | 🟡 |
| 路径注册表 | Cherry Studio | `src/main/core/paths/README.md` ✅（六命名空间 `cherry.*`/`sys.*`/`app.*`/`feature.*`/`v1.*`/`external.*`） | 🟡 |
| **运行时分发（node/python/uv）** | Cherry Studio | `BinaryManager`（封装 mise 多语言后端，禁止直接 shell out 到包管理器）| 🟡 |
| 主窗口管理 | Cherry Studio | `src/main/core/window/WindowManager.ts` ✅、`src/main/services/MainWindowService.ts` ✅ | 🟡 |
| 自动更新 | Cherry Studio | `src/main/services/AppUpdaterService.ts` ✅ | 🟡 |
| 托盘 / 全局快捷键 / 快速浮窗 | Cherry Studio | `TrayService.ts` ✅、`ShortcutService.ts` ✅、`QuickAssistantService.ts` ✅ | 🟡 |
| 全局快捷键 + 跨应用注入 | Witsy | Prompt Anywhere / Command Palette 实现 | AGPL 🟡 |
| 本地数据库 | Cherry Studio | `migrations/`（drizzle + better-sqlite3 + sqlite-vec）✅ | 🟡 |
| IPC 安全边界 | Cherry Studio | `src/main/core/security/guardedIpc.ts` ✅ | 🟡 |
| 流式 Markdown | Streamdown | `vercel/streamdown` ✅ | Apache-2.0 🟢 |
| 流式滚动贴底 | use-stick-to-bottom | `stackblitz-labs/use-stick-to-bottom` ✅ | MIT 🟢 |
| AI 聊天组件 | assistant-ui / AI Elements | Claude 示例 `apps/docs/components/pages/examples/claude.tsx` ✅ | MIT / Apache 🟢 |

### 3.2 MCP host

| 功能模块 | 推荐项目 | 代码位置 | 许可证 |
|---|---|---|---|
| **MCP client（v2 写法）** | DeepChat | `src/main/mcp/` ✅（配置、生命周期、OAuth、调用）；依赖 `@modelcontextprotocol/client` 2.0.0 ✅ | 🟢 |
| MCP 运行时（v1 工程组织） | Cherry Studio | `src/main/ai/mcp/McpRuntimeService.ts` ✅、`mcpTransport.ts` ✅、`mcpClientSdk.ts` ✅、`oauth/` ✅、`mcpRedact.ts` ✅ | 🟡 |
| MCP 管理与 OAuth（v1） | LibreChat | `packages/api/src/mcp/MCPManager.ts` ✅、`packages/api/src/mcp/oauth/handler.ts` ✅ | 🟢 |
| MCP 设置界面 | Cherry Studio | `src/renderer/pages/settings/McpSettings/` ✅ | 🟡 |
| **扩展配置 schema（显式 `type` 判别式）** | Goose | `crates/goose/src/agents/extension.rs` ✅（7 种 transport 枚举） | 🟢 |
| **超时向 server 发 cancelled** | Goose | `crates/goose/src/agents/mcp_client.rs` ✅ | 🟢 |
| **会话上下文注入 MCP meta** | Goose | 同上（`SESSION_ID_HEADER` / `WORKING_DIR_HEADER` / `TOOL_CALL_REQUEST_ID_HEADER`） | 🟢 |
| **多 CLI agent 的 MCP 配置同步** | AionUi | "inject or sync compatible transports" 机制 | 🟢 |
| .mcpb 安装包 | mcpb | `src/index.ts` ✅、`MANIFEST.md` ✅、`schemas/` ✅ | MIT 🟢 |
| MCP Apps 宿主 | ext-apps | `examples/basic-host/src/implementation.ts` ✅、`specification/` | MIT 🟢 |
| 联调对端 | servers | `Everything`（协议全面）、`Filesystem`（路径边界） | MIT 🟢 |
| 开发期示波器 | inspector | `npx @modelcontextprotocol/inspector --tui`；`core/` + `clients/` 切分 | MIT 🟢 |

### 3.3 Agent 与权限（路线 A 核心）

| 功能模块 | 推荐项目 | 代码位置 | 许可证 |
|---|---|---|---|
| **Agent 主循环** | Goose | `crates/goose/src/agents/agent.rs` ✅（`reply()` / `reply_internal()`） | 🟢 |
| **上下文压缩（四手段）** | Goose | `crates/goose/src/context_mgmt/mod.rs` ✅（单文件） | 🟢 |
| **大工具响应落盘** | Goose | `crates/goose/src/agents/large_response_handler.rs` ✅ | 🟢 |
| **Provider 抽象** | Goose | `crates/goose-provider-types/src/base.rs` ✅、`canonical.rs` ✅、`formats/*.rs` ✅ | 🟢 |
| **ToolShim（无原生 tool calling 的模型）** | Goose | `crates/goose/src/providers/toolshim.rs` ✅ | 🟢 |
| Agent 循环（TS） | OpenCode | 仓库内搜索 agent loop / plan mode | MIT 🟢 |
| **权限 broker** | DeepChat | `src/main/tool/` ✅（`ToolPermissionBroker`） | 🟢 |
| **权限四层（mode / inspector / judge / router）** | Goose | `tool_inspection.rs` ✅、`permission/permission_inspector.rs` ✅、`permission_judge.rs` ✅、`agents/tool_confirmation_router.rs` ✅ | 🟢 |
| **命令审批分类** | Cline | `docs/features/auto-approve.mdx` ✅ + `sdk/` | 🟢 |
| **权限键格式** | Zed | `docs/src/ai/mcp.md` ✅（`mcp:<server>:<tool_name>`） | GPL 文档可读 |
| Agent 安全规则 | Cherry Studio | `src/main/ai/agents/builtin/builtinAgentGuardRules.ts` ✅、`assistantCommandSafety.ts` ✅ | 🟡 |
| Agent 任务运行 | Cherry Studio | `src/main/ai/agents/runAgentTask.ts` ✅ | 🟡 |
| **会话存储（append-only + 四元组身份）** | DeepChat | `docs/architecture/tape-system.md` ✅、`src/main/tape/` ✅ | 🟢 |
| Subagent 契约 | DeepChat | `docs/architecture/agent-system.md` ✅ | 🟢 |
| computer use 最小示例 | claude-quickstarts | `computer-use-demo/computer_use_demo/loop.py` ✅、`tools/computer.py` ✅ | MIT 🟢 |

### 3.4 沙箱

| 功能模块 | 推荐项目 | 代码位置 | 许可证 |
|---|---|---|---|
| **OS 级沙箱（直接用）** | sandbox-runtime | npm `@anthropic-ai/sandbox-runtime`（latest 0.0.79，2026-10-07；2026-10-09 改，见 [04 §依赖](04-sandbox/spec.md)，原为「latest 0.0.76，2026-09-10」）；`src/`；README 安全限制清单 | Apache-2.0 🟢 |
| **沙箱产品语义层** | Codex | https://learn.chatgpt.com/codex/agent-approvals-security（三档 mode + 审批策略） | 文档可读 |
| workspace 抽象概念 | OpenHands | `software-agent-sdk` 的 `openhands-workspace` 包 | MIT 🟢（Docker 依赖不适合桌面） |

### 3.5 内容与知识

| 功能模块 | 推荐项目 | 代码位置 | 许可证 |
|---|---|---|---|
| Artifacts | LibreChat | `client/src/utils/artifacts.ts` ✅（Sandpack ✅） | 🟢 |
| Skills 管理 | Cherry Studio | `src/main/ai/skills/SkillService.ts` ✅、`SkillInstaller.ts` ✅ | 🟡 |
| Skills 跨工具导入导出 | DeepChat | `src/main/skill/` ✅ | 🟢 |
| 记忆（做成内置 MCP server） | Cherry Studio | `src/main/ai/mcp/servers/memory.ts` ✅、`agentMemory.ts` ✅ | 🟡 |
| 知识库 RAG | LibreChat / AnythingLLM | LibreChat RAG API；AnythingLLM `server/` | 🟢 |
| 工具多时的 token 控制 | AnythingLLM | `server/` 里的 "Intelligent Skill Selection"（声称省 80%） | MIT 🟢 |
| Tauri 壳层（仅对照） | Jan | `src-tauri/` ✅、`web-app/` ✅ | Apache-2.0 🟢 |

## 4. 分模块详述

### 4.1 桌面壳层

**Electron，已定（ADR-001）。** 核心理由：你的四条需求（MCP TS SDK v2、spawn `npx`/`uvx` 子进程、`.mcpb` node 扩展、sandbox-runtime）三条硬绑 Node ≥ 20，而 Tauri 官方不嵌 Node、官方 sidecar 教程指着 2024 年已归档的 `pkg`、Node SEA 不能当解释器给子进程用。Tauri 的体积优势被你自己要发的 Node runtime 吃掉。详见 ADR。

**Cherry Studio V2 的结构**（✅ 文件树确认，**注意：V2 在 main 但未发布，最新 release 仍是 v1.9.11**）：

```
src/
├── main/            主进程
│   ├── core/        应用骨架：window、security、lifecycle、scheduler、job、paths
│   ├── services/    系统服务：更新、托盘、快捷键、快速浮窗、主题、菜单
│   ├── ai/          AI 相关：mcp、agents、skills、runtime、tools、channels
│   ├── data/        数据层与迁移
│   └── ipc/         进程间通信
├── preload/
├── renderer/        React 前端
└── shared/
migrations/          SQLite 迁移（drizzle）
packages/            内部共享包
```

**分层值得模仿：`core` 放骨架，`services` 放系统能力，`ai` 放和模型相关的一切。**

三样直接从 `CLAUDE.md` 拿：
1. **服务生命周期 DI**：`BaseService` + `@Injectable`/`@ServicePhase`/`@DependsOn` + `serviceRegistry.ts`。Electron 主进程服务的启动顺序是必定失控的地方，这是被 8,446 commits 验证过的解法。
2. **路径注册表**：六命名空间，全走 `application.getPath()`，自动 ensure，`NO_ENSURE` 排除表。"dot 分隔是语义的不是物理的"。
3. **⭐ `BinaryManager`**：MCP server 靠 `npx`/`uvx` 启动，但**用户机器上没有 node/python**。谁装运行时、装哪、怎么升级、怎么和系统已有的不打架——**这块做不好，MCP 接入成功率卡 30%，用户只会说"点了没反应"**。Cherry 是唯一把它抽象成受管服务的。

⚠️ **AGPL-3.0**：只读 `CLAUDE.md` 学架构，**代码一行别复制**。架构思想不受版权保护，代码受。

**密钥存储**：Electron `safeStorage`。macOS 需应用签名才能用钥匙串；Linux 无系统密钥服务时退化为弱加密，要提示用户。Goose 的做法可参考：所有 secret 打包成一个 JSON 存单条 keyring 记录，捕获 `"keyring"/"dbus"/"no secret service"` 错误串判定不可用后回落到 `0o600` 文件。

### 4.2 聊天核心与流式渲染

- **assistant-ui**（MIT 🟢）：通过 shadcn registry 分发，组件源码归你。官方 [Claude 示例](https://www.assistant-ui.com/examples/claude) 和 [Artifacts 示例](https://www.assistant-ui.com/examples/artifacts) 是起点。
- **Streamdown**（Apache-2.0 🟢 ✅）：Vercel 的流式 Markdown 渲染器，处理"代码块还没闭合"这类中间态，避免逐字重排闪烁。
- **AI Elements**（Apache-2.0 🟢 ✅）：Vercel 基于 shadcn 的 AI 组件集，含推理过程、代码块、Artifact、网页预览。
- **Cherry Studio 渲染层**（🟡）：`src/renderer/components/chat/messages/tools/mcp/MessageMcpTool.tsx` ✅，学工具调用怎么渲染成卡片。

**消息流的 block 类型至少五种**：text / tool_call / artifact_ref / question_choice / rich_widget。做成注册表，不做 markdown 渲染器 + 特例。

### 4.3 MCP host（2026-07-28 规范）

**新规范核心变化，大白话：**

| 变化 | 以前 | 现在 |
|---|---|---|
| 连接方式 | 先握手建会话，服务端记住你（有状态） | 每个请求独立（无状态），`initialize` 和 `Mcp-Session-Id` 删除 |
| 服务端要输入 | 服务端主动发请求 | 返回 `resultType: "input_required"`，客户端补齐后**换新 id 重发**（MRTR） |
| 请求路由 | 要拆请求体看 | 请求头带 `Mcp-Method` / `Mcp-Name` |
| 长任务 | 实验性 | 正式 Tasks 扩展 |
| 弃用 | — | HTTP+SSE、Roots、Sampling、Logging 进入弃用期；`ping` 删除 |

来源：[MCP 2026-07-28 发布说明](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md) ✅

**TS SDK v2 拆包**：

| 包 | 版本 | 用途 |
|---|---|---|
| **`@modelcontextprotocol/client`** | **2.3.1** | **你要用这个**（2026-10-08 改：版本按 npm 刷新，原 2.0.0 / 1.30.0，见 [03 §SDK 升级](03-mcp-host/spec.md)） |
| `@modelcontextprotocol/server` / `core` / `node` | 2.3.1 / 2.3.1 / 2.1.1 | |
| `@modelcontextprotocol/sdk` | 1.32.1 | v1 老包，**保底维护到 2027-01 前后** |

⚠️ **v2 文档在 `/v2/` 路径下**。搜到的教程八成是 v1 的（`StdioClientTransport` 那套），会把你带沟里。

**各项目当前 SDK 版本**（✅ 读取 `package.json`）：

| 项目 | MCP SDK |
|---|---|
| **DeepChat** | `client` 2.0.0、`server` 2.0.0、`ext-apps` 2.0.0（同时保留 `sdk` 1.30.0）—— **唯一已上 v2 的桌面客户端** |
| Cherry Studio | `sdk` 1.27.1 |
| LibreChat | `sdk` ^1.30.0 |
| AnythingLLM | `sdk` ^1.24.3 |
| AionUi | `sdk` ^1.20.0 |
| Goose | Rust `rmcp` |

**怎么读才不被带偏：**
1. 协议和 API 以官方 SDK v2 文档为准
2. Cherry Studio、LibreChat 学"工程组织"（多 server 管理、OAuth 回调、日志、脱敏）
3. DeepChat 学"新版协议写法"

**扩展配置：显式 `type` 判别式**（Goose 的做法，对比 `claude_desktop_config.json`）：

| 维度 | Claude Desktop | Goose（值得抄） |
|---|---|---|
| transport | `command/args` 或 `url` **隐式区分** | **显式 `type` 判别式** |
| 开关 | 删条目才能停用 | `enabled: false` |
| 密钥 | 只能明文 `env` | **`envs`(明文) + `env_keys`(keychain) 分离** |
| 工具粒度 | 全有或全无 | **`available_tools` 白名单** |
| 超时 | 无 | 每扩展 `timeout` |

**`available_tools` 白名单是 context 管理的第一道闸**——一个扩展 40 个工具只要 3 个，直接砍掉 37 个的 token 占用和误触风险，比事后压缩便宜得多。

**两个 Goose 的实现细节直接抄**：
- **超时不是简单 drop future，而是向 server 发 `notifications/cancelled`**。很多 host 漏掉，导致 server 侧任务泄漏。
- **会话上下文通过 MCP meta 注入**（session_id / working_dir / tool_call_request_id），MCP server 能知道自己在哪个会话为哪次调用服务。阶段 3 评估后不做：远程 server 会拿到本机路径与跨调用的关联 id（2026-10-08 改，见 [03 §协议代际](03-mcp-host/spec.md)）。

**联调**：`Everything` server 当对端，`npx @modelcontextprotocol/inspector --tui` 当示波器。

### 4.4 .mcpb 一键安装包

[modelcontextprotocol/mcpb](https://github.com/modelcontextprotocol/mcpb)（MIT 🟢，已从 `anthropics/mcpb` 转移）。`src/index.ts` ✅ 就是 Claude 桌面端加载和校验 .mcpb 的代码。配合 `MANIFEST.md` ✅ 和 `schemas/` ✅ 读，能实现"拖进来 → 读说明书 → 弹配置表单 → 安装"。

核心链路：`user_config` → 生成配置表单 → 校验 → `sensitive: true` 的值写 keychain → spawn 时做 `${...}` 模板插值。**内置 Node runtime 是"双击即装"能成立的关键**——这也是 ADR-001 选 Electron 的直接原因。

### 4.5 MCP Apps

- [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps)（MIT 🟢），宿主示例 `examples/basic-host/src/implementation.ts` ✅
- DeepChat 已依赖 `@modelcontextprotocol/ext-apps` 2.0.0 ✅
- **MCP-UI**（Apache-2.0 🟢）：社区先驱，`@mcp-ui/client` 有现成 React 渲染组件（2026-10-15 改：不采用。`@mcp-ui/client` 7.1.1（2026-05-09，此后没再发版）依赖 `@modelcontextprotocol/sdk` ^1.27.1、`@modelcontextprotocol/ext-apps` ^1.2.0 与 `zod` ^3.23.8，仍绑在 SDK v1 和 zod 3 上，Tenon 在 SDK 2.x 与 zod 4。宿主侧的桥改用 `@modelcontextprotocol/ext-apps` 的 `/app-bridge` 子路径（最新 2.0.3，2026-09-25；peer 是 `@modelcontextprotocol/core` ^2.0.0、`@modelcontextprotocol/client` ^2.0.0 与 `zod` ^4.2.0（`server` 可选），core 要显式声明，线协议与 1.x 相同）。assistant-ui 自带的 `McpAppRenderer` 也不采：它的 `SafeContentFrame` 默认把 frame 放在第三方域名 `scf.auiusercontent.com`，Tenon 钉的 `@assistant-ui/react` 0.15.20 随带的 `safe-content-frame` 0.0.30 把这个域写死、没有覆盖选项，每渲染一个 widget 都要联网访问它；自托管选项 `unsafeShimDomain` 要到 `safe-content-frame` 0.0.34（随 `@assistant-ui/react` 0.15.28）才有，还要通配 DNS 与通配 TLS 证书。出处：npm registry、modelcontextprotocol/ext-apps 仓库、assistant-ui 文档）

⚠️ **对 Electron host 是硬活**：server 的 tool 声明 `ui://` 资源，host 在 sandboxed iframe 里渲染 + CSP + 主进程消息通道，**做错就是 RCE**。`specification/` 必读。放在阶段 5。

### 4.6 Artifacts

| 方案 | 代表 | 优点 | 缺点 |
|---|---|---|---|
| Sandpack | LibreChat（`@codesandbox/sandpack-react` ✅）、LobeChat | 能跑完整 React 组件和 npm 依赖 | 默认依赖外部打包服务，离线需自托管；体积大 |
| 自建 iframe（`srcdoc` + `sandbox`） | assistant-ui Artifacts 示例 | 轻量、可控、离线 | 跑 React 要自己处理编译 |

**建议**：先自建 iframe 支持 HTML/SVG，把"侧栏打开、调宽度、版本切换"做好；需要跑 React 再引 Sandpack。

### 4.7 知识库、记忆与 Skills

- **Skills 规范**：[agentskills.io](https://agentskills.io) + [anthropics/skills](https://github.com/anthropics/skills)。许可证 ✅：示例 skill 多为 Apache-2.0 🟢；**`docx`/`pdf`/`pptx`/`xlsx` 四个是专有许可 🔴**。
- **Skills 管理实现**：Cherry Studio `src/main/ai/skills/` ✅（🟡）；DeepChat `src/main/skill/` ✅（🟢，支持文件夹/ZIP/URL 安装，**能和 Claude Code、Cursor 互相导入导出**）。
- **Skill 三级渐进加载**（官方机制）：元数据常驻 system prompt（≈100 token/skill）→ 正文命中才读 → 脚本只回传 stdout。**前提是 agent 有文件系统和 bash。**
- **记忆**：Cherry Studio 把记忆做成内置 MCP server（`src/main/ai/mcp/servers/memory.ts` ✅）——记忆读写变成模型可调用的工具，不用在对话流程里写死。
- **知识库 RAG**：LibreChat RAG API、AnythingLLM。**工具多到撑爆上下文时**看 AnythingLLM 的 "Intelligent Skill Selection"。

### 4.8 Agent 循环（路线 A 核心）

**这一节是整份文档的重心。** 三个参照，各取所长：

| 项目 | 语言 | 学什么 | 许可证 |
|---|---|---|---|
| **Goose** | Rust | **设计最清楚**：六步循环、上下文四手段、provider 抽象、权限四层。读拆解文档不读 Rust | Apache-2.0 🟢 |
| **OpenCode** | TS | **和你同栈的实现**：agent 循环、plan/act 双模式、上下文自动压缩、子 agent、MCP | MIT 🟢 |
| **computer-use-demo** | Python | **最小可读实现**：`loop.py` 是完整采样循环，一个下午读完 | MIT 🟢 |
| Hermes Agent | Python | 从经验生成技能、跨会话记忆、定时任务 | MIT 🟢 |
| Claude Agent SDK 文档 | — | 官方的工具权限模型、hooks 设计 | 🔴 文档可读，SDK 按条款 |

#### 4.8.1 主循环（Goose 实证）

```ts
while (true) {
  if (isCancelled(token)) break;
  drain_pending_steers();                  // 取出用户中途插入的消息
  if (finalOutputTool.hasOutput()) break;

  const stream = stream_response_from_provider();
  maybe_summarize_tool_pairs();            // 后台异步，不阻塞

  const { frontend, rest } = categorize_tools();
  const findings = await inspect_tools();  // 权限 inspector 管线
  const decided  = apply_permission_policy(findings);

  handle_approved_and_denied(decided);     // → dispatch_tool_call()
  handle_approval_requests(decided);       // → 人工确认

  for await (const item of select_all(toolStreams)) {
    add_tool_response(request_id, output);
  }
  persist_message(...);
}
```

退出条件：max_turns / FinalOutputTool / cancel / 终止性错误（refusal、重试后仍失败、压缩两次仍溢出）。

⚠️ **Goose 有个洞你要补**：cancel 时只 `break`，**没把 in-flight 的 tool call 标记为已取消**，会留下 orphaned `tool_use` 块，下一轮发给 Anthropic 直接 400。补注：Goose 现在会在发请求前删掉孤儿调用；Tenon 的收口以 02 为准（2026-09-25 改，见 [02 §工具调用的收口](02-agent-loop/spec.md)）。

#### 4.8.2 上下文管理：四种手段（Goose 实证）

**⚠️ 元教训：Goose 官方文档说循环第 5 步是 "Context Revision"，代码里没有这个步骤。** 它是四个独立机制拼出来的。照文档抄会抄空。

| 手段 | 机制 | 触发 | 谁判断 |
|---|---|---|---|
| **A. 算法式删除** | "middle-out"：中段按比例删 tool response，保留首尾 | token 占比 > 80%（硬编码） | **纯规则**，无模型 |
| **B. 摘要** | fast model + thinking off 跑摘要 | 同上 / 手动 `/compact` | 模型 |
| **C. 工具对定向摘要** | 单个 tool request/response 对折叠成一句，batch=10，保护最近 N 轮 | 超 cutoff | 模型，**后台异步** |
| **D. 大响应落盘** | 工具输出 > 200k 字符 → 写临时文件 → 模型只看到"太大了，在这个路径" | 单次响应 | 规则 |

**⭐ 最值得抄的一条**：**B 压缩后不删原消息，只改 `MessageMetadata` 可见性**——原消息"仅用户可见"，摘要"仅 agent 可见"。**用户在 UI 上看到完整历史，模型看到压缩的。** **2026-09-12 决定：不用可变的 `visibleTo` 字段**——它是原地改写，与 Tape append-only 冲突。改用 DeepChat 的做法：压缩写一条 `anchor` 事实（边界 + 摘要），provider 视图从最近锚点重建，用户视图始终全量。效果相同，且可回退。

**判断"满没满"用规则，判断"怎么概括"用模型**——这个分工是对的。

⚠️ **中文产品要改**：D 的阈值是 200,000 **字符**不是 token，中文 token 密度差 2–3 倍。

⚠️ **Goose 的妥协**：A/C 的"old or irrelevant"判定**完全是位置性的**，零语义相关性。50 轮前的关键结果和无关结果待遇相同。换来可预测和零额外成本。

溢出兜底：捕获 `ContextLengthExceeded` → 压缩 → 重试，**最多两次**。

#### 4.8.3 Provider 抽象（Goose 实证，最值得照抄）

**核心洞察：能力不是一个 `capabilities: {}` 对象，而是"带默认值的可选方法"。**

```ts
interface Provider {
  // 只有三个必需方法
  get_name(): string;
  get_model_config(): ModelConfig;
  stream(model_config, system, messages, tools): Promise<MessageStream>;  // 唯一必需 I/O
  // complete() 有默认实现（跑 stream 再收集）→ 不存在"这家不支持流式"的分支
  // 其余二十多个方法全带默认实现：
  manages_own_context(): boolean;        // 默认 false
  supports_cache_control(): boolean;     // 默认 false
  thinking_effort_support(): ...;
  configure_oauth(): ...;                // 默认 NotImplemented
}
```

**今天就能抄进 TS 的四个点**：
1. `stream` 必需、`complete` 默认实现
2. `ModelInfo` 表：`context_limit` / `reasoning` / `supports_cache_control` / `thinking_preservation_format` / **`request_params`（透传 map，抽象不被撑破的保险）**
3. `ConfigKey` 驱动 setup UI：`{ name, required, secret, default, oauth_flow, device_code_flow, primary }`——加 provider 不碰前端
4. canonical model registry：内嵌模型表，管名字归一、context limit、定价、meta-provider（Azure/Bedrock）按上游真实模型计价

**ToolShim**（给不支持原生 tool calling 的本地模型）：再跑一个小模型把文本翻译成 tool call，**先试纯解析（token 标记 / 内联 JSON）再退化到调模型**。

**换模型时会话怎么接续**：模型归属记在 session 上；换模型是"用新 provider 重建 Agent 挂回同一 session"，不是热替换；**上一个模型的 thinking block 要丢弃或降级**（否则 Anthropic 因签名不匹配 400）。

**为什么先抄这个**：Provider 接口是唯一"改错了要重写一大片"的地方。第一版假设"所有厂商都支持流式 + 原生 tool calling + 无 thinking"，接 Ollama / reasoning 模型 / Bedrock 时都得动所有实现。

#### 4.8.4 会话存储（DeepChat 实证）

`docs/architecture/tape-system.md` ✅——**"消息怎么存"是一旦选错就无法回头的决定**，现在读文档，别读代码。

现在就要吸收进数据模型的两条：
- **工具调用身份 = `(runId, requestSeq, providerToolCallId[, childOrdinal])`**
- **`requestSeq`（载荷身份）和 `physicalAttempt`（传输次数）分开计数**——上下文恢复推进 requestSeq 并重置 attempt，瞬时重试两者都保留。**直接解决"重试到底算不算新一轮"**

Tape 是 append-only fact store，修正/压缩/handoff 都是新事实，绝不原地改写。重放从 manifest + facts 重建 provider 可见上下文，不从渲染层 block 重建。

#### 4.8.5 Subagent 契约（DeepChat 实证）

独立 Session / workspace 授权 / tool mapping / memory 命名空间 / 权限状态；默认 300 秒 deadline（1–1800 可调）；每个父级最多 3 个并发非终态 run；强制 handoff 格式 `Result / Evidence / Changed Files / Validation / Unresolved`。02 的差异：权限只往下继承；每个父级 1 个并发；交接由最后一条回复承担、不强制格式；deadline 不可调（2026-09-25 改，见 [02 §子 agent 契约](02-agent-loop/spec.md)）。

**层级只有两层**（Claude Desktop 的 Dispatch 同样如此）：child 不能再生 child，防无限递归。10 分钟是 Claude Dispatch 的规则，Claude Code 的子 agent 不超时；02 定为**转发审批不超时，等审批时 deadline 暂停**（2026-09-25 改，见 [02 §暂停、转发、排队与期限](02-agent-loop/spec.md)）。

**多 agent 的反直觉证据**：固定 reasoning token 下单 agent 持平或优于多 agent（arXiv:2604.02460）；多 agent 约 15× token。**角色扮演式分工（PM agent / 架构师 agent）是多 agent 最差的用法**。真正占优的是可并行的读密集任务。

### 4.9 UI 组件底座

- **shadcn/ui**（MIT 🟢）：2026 年 7 月起新项目默认 Base UI，Radix 仍支持。来源 ✅
- **assistant-ui**（MIT 🟢）
- **AI Elements**（Apache-2.0 🟢）
- lobe-ui（MIT 🟢）：风格强烈，快速出效果可选

### 4.10 沙箱（新节）

**结论：不需要自己做，直接用 `@anthropic-ai/sandbox-runtime`。**

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/anthropic-experimental/sandbox-runtime（2026-10-15 补：已迁到 https://github.com/anthropics/sandbox-runtime，npm 0.0.79 的 package.json 里 repository 写的是这个） |
| star | 4.6k |
| license | **Apache-2.0** |
| 语言 | **TypeScript 98.5%** |
| npm | `@anthropic-ai/sandbox-runtime`，**latest 0.0.79**（2026-10-07；发版走 npm 不走 GitHub release，以 npm 为准；2026-10-09 改，见 [04 §依赖](04-sandbox/spec.md)，原为「latest 0.0.76（2026-09-10）」） |
| 依赖 | **只有 4 个** |
| engines | Node >= 22.12.0（0.0.79；2026-10-09 改，见 [04 §依赖](04-sandbox/spec.md)，原为「Node >= 20.11.0」，那是 0.0.76 的） |

**为什么是最优解**：官方原话「enforcing filesystem and network restrictions on arbitrary processes **at the OS level, without requiring a container**」。OpenHands 那套 Docker 方案在消费级桌面上转化率会死得很难看。

| 平台 | 机制 |
|---|---|
| macOS | `sandbox-exec` + 动态生成 Seatbelt profile |
| Linux | `bubblewrap` + seccomp BPF + network namespace（需系统装 bubblewrap、socat、ripgrep） |
| Windows | 专用 `srt-sandbox` 本地用户 + WFP 出口过滤（**alpha**，需一次性提权安装） |

用法：`SandboxManager.initialize(config, askCb, true)` → `wrapWithSandboxArgv(command, shell, cfg, signal, cwd, { commandId })` → `spawn(argv[0], argv.slice(1), { shell: false, env })` → `cleanupAfterCommand()` → 退出 `reset()`。（`wrapWithSandbox` 在 Windows 抛错，不用）

**API 形状（这就是你文件桥配置该长的样子）**：
```ts
{
  network:    { allowedDomains, deniedDomains, allowLocalBinding, allowUnixSockets, ... }
  filesystem: { denyRead, allowRead, allowWrite, denyWrite }
}
```

**⭐ 两条决定权限 UI 设计的语义**：
- **读是 deny-then-allow（先拒后放），写是 allow-only（只有明确允许的能写）**——读写默认立场不同
- **强制 deny 路径自动保护**：`.bashrc`、`.git/hooks/`、`.vscode/`

**产品语义层抄 Codex**（业界事实标准）：

| Sandbox mode | 含义 |
|---|---|
| `read-only` | 只读文件、跑命令但不能改 |
| `workspace-write` | 工作目录内可改可执行 |
| `danger-full-access` | 无限制（官方标注 not recommended） |

审批策略：`on-request` / `never` / `granular`。**⭐ 网络默认关闭**，workspace-write 下要开需显式配。域名白名单冲突时 **deny 优先**。

**⚠️ 源码核实后的修正（2026-09-11）**：sandbox-runtime 的网络 schema **拒绝 `"*"`**，无法表达"全允许"。所以 `danger-full-access` 档不是一种 config，而是**跳过 wrap**。UI 三档 = 两种 config + 一个 bypass。另外相对路径相对宿主 `process.cwd()` 解析，Electron 里只传绝对路径；文件系统规则不热更新，切换工作区要 `reset() + initialize()`。三档的具体 config 见 [sandbox-runtime-mechanisms](../reference/sandbox-runtime-mechanisms.md) §三。

**→ Codex 定义"用户看得懂的档位"，sandbox-runtime 提供"OS 层执行"，正好是一套方案的上下半。**

**README 的 9 条安全限制清单必读**——是我见过唯一一份把"沙箱在哪些地方靠不住"写清楚的开源文档。最关键的三条：
- 允许 `/var/run/docker.sock` = 把整台主机给出去
- 写路径给太宽（`$PATH` 里的可执行文件、shell 配置）= 提权
- `allowAppleEvents` 是"移除"代码执行隔离，不是"削弱"

**其他选项**：microsandbox（microVM，隔离更强但要分发 runtime）、E2B（云端，不适合桌面）。

### 4.11 权限引擎设计要点（新节）

四个项目各贡献一条可抄结论：

**① Cline：命令危险性让模型自己标，不用白名单**

> "the system doesn't use fixed allowlists; instead, **the model marks each command with a `requires_approval` flag** based on the command and arguments."

**你一定会想写"安全命令白名单"。Cline 用 67.6k star 告诉你这条路走不通**——shell 的管道、`$()`、别名、环境变量会绕过任何正则。

补注：仅 Cline v3 / legacy 运行时如此：新 SDK 运行时已删掉 `requires_approval`；Tenon 不设模型自标（2026-09-25 改，见 [02 §权限决策顺序](02-agent-loop/spec.md)）。

权限类目两层嵌套（直接当设置面板信息架构）：Read project files / **Read all files**；Edit project files / **Edit all files**；Execute safe commands / **Execute all commands**；Use browser；Use MCP servers。"基础开关不开，扩展变体不生效"。

**② Zed：工具键格式 `mcp:<server>:<tool_name>`**

三段命名空间，**让"按 server 授权"和"按单个 tool 授权"用同一套结构表达**。`agent.tool_permissions.default` 默认 `"confirm"`（默认确认，不是默认放行）。

**③ DeepChat：一次架构反悔**

**它废掉了 server 级 `autoApprove` 配置和 session 权限缓存**，只留单 session 内 broker 的运行时状态。从"配置式白名单"退回"运行时 broker"。**看别人为什么推翻自己的设计，比看设计本身值钱。**

源码核实（2026-09-11，详见 [deepchat-mechanisms](../reference/deepchat-mechanisms.md)）：此事属实，且比笔记更彻底——**工具授权完全不持久化**（`rememberable: false` 硬编码），**MCP 的 `readOnlyHint` 注解被刻意不信任**（"untrusted hints and must not weaken local execution policy"），后果是 MCP 工具永远串行。另一个反直觉点：**权限请求写进 transcript、Run 结束、用户回答后开新 Run**，不是 await Promise——这样崩溃重启后弹窗还在。最值得照抄的是领域无关的 `src/main/approval/approvalBroker.ts`（参数 canonical hash、dedupe、scope 容量、abort/timeout 清理）。

其他：MCP 同名工具不能覆盖 built-in reserved capability；`AbortSignal` 贯穿 MCP client 与 provider adapter；有副作用的工具在 output 裁剪时不重跑。

**④ Goose：四层 + 不对称缓存**

```
第 0 层 GooseMode：Auto（★默认，全自动批准）/ Approve / SmartApprove / Chat
第 1 层 Inspector 管线：按注册顺序串行执行，取最严，confidence 只写日志
第 2 层 PermissionInspector：查用户显式权限 → 读 MCP readOnlyHint 注解 → 扩展管理类工具强制人工 → 交 LLM 判定
第 3 层 LLM 判官：把不可信的工具请求作为 JSON 塞进 user 消息，显式防注入，失败 fail-closed
第 4 层 确认路由：request_id → oneshot channel 映射，UI 通过 IPC 调 deliver() 唤醒
```

上面第 1 层一行只更正对 Goose 的事实描述，依据 aaif-goose/goose@80c1197 `tool_inspection.rs:68-118、170-262`（2026-09-25 改，见 [02 §Inspector 接口与合议](02-agent-loop/spec.md)）。

**⭐ 不对称缓存**：LLM 判定后**只缓存"不是只读"的结论，不缓存"是只读"**。理由：缓存错了"安全"会造成风险，缓存错了"危险"只是多问一次。

⚠️ **Goose 默认 `Auto`（全自动批准）**——对一个能读写文件执行命令的 agent 是激进默认值。**你的产品默认应该是 `confirm`**（Zed 的选择）。

**⑤ Claude Desktop 自己的教训**（2026-09-11 实测）：
- 权限粒度不统一：第一方连接器和自定义 MCP 的控制面不一样
- 一个开关管四件事（code execution → 文件创建 + Skills + 长会话压缩 + artifact），出问题用户猜不到
- 界面不告诉你本次回答用了什么 skill
- **按可逆性给工具自动分级**（发出去撤不回的先 blocked）——比让用户逐个勾靠谱

**spec 里的两句直接当需求**：
> "Hosts must obtain explicit user consent before invoking any tool"
> "descriptions of tool behavior such as annotations should be considered **untrusted**"

**第二条是重点：tool description 是 prompt injection 的主入口。**

**决策顺序（2026-09-12 定，多个机制冲突时按此裁决，Claude Code 实现时不得自选）**：

决策表以 02 §权限决策顺序 为唯一权威，本节原表作废（2026-09-25 改，见 [02 §权限决策顺序](02-agent-loop/spec.md)）。原表逐行的变化：

- 行 1 租户策略 → 第 1 层：策略是上限，它的「允许」只解锁，不替用户预先批准（裁决 D3）。
- 行 2 可逆性 → 第 4 层「必须问」：「默认 blocked」改为「必须问，只认这一次」，只有三种有意的放开能免；可逆性只认 host 和租户策略（裁决 D10、D3、E1）。第 4 层另收 server 显式声明的 `requiresUserInteraction`，谁都免不掉（裁决 D12）。
- 行 3 用户持久设定 → 拆两层：「永不」到第 3 层「用户禁用」，只能拒；「总是允许」到第 6 层「用户授权」，只有连接器工具可设。「覆盖 4、5」作废，机器检查仍能把总是允许改回问（裁决 D1、F9）。
- 行 4 Inspector 合议 → 第 5 层「机器收紧」：取最严，没有放行，confidence 只进判决记录；超时或出错按注册时声明的最严意见处理；来源改为「02 交付接口和一条只会问人的外带检查」（裁决 F1、F5）。
- 行 5 模型自标：删去；以后若有「模型申请提权」，只作为第 5 层的一个输入（裁决 D2、E4）。
- 行 6 默认 → 第 8 层，不变。新增第 2 层保护名单、第 7 层审批档（手动、自动两档）（裁决 D2、D6）。
- MCP `readOnlyHint` 等注解：不参与放宽，只展示；server 显式声明 `requiresUserInteraction` 为 true 时触发必须问（裁决 D12）。

一句话：**放宽只能来自策略或用户，机器只能收紧；策略和用户意见不同时，取更严的一方**（2026-09-25 改，见 [02 §权限决策顺序](02-agent-loop/spec.md)）。

**⑥ 与姊妹项目 railguard 的关系**（2026-09-12，[yiongq/railguard](https://github.com/yiongq/railguard)，MIT，TS，零运行时依赖）：railguard 守的是**内容与数据访问**（输入注入检测、输出引用核验 / URL 白名单 / PII 打码、RBAC 工具门、行过滤、字段掩码、人工审批、Ed25519 签名审计链）；Tenon 权限引擎守的是**本机能力**（哪个工具能跑、沙箱放行什么文件和网络、用户是否同意）。威胁模型不同，不是同一个东西，**不合并仓库**。交集两处：(1) railguard 的注入检测 / 不可信内容标记可作为 Inspector 管线里的**一个 inspector** 接入（阶段 2 定 `Inspector` 接口时留位置，adapter 形式，可选），接入点是调用前挂点，加上结果回来后只记录的挂点（2026-09-25 改，见 [02 §挂点与会话视图](02-agent-loop/spec.md)）；(2) 签名审计链可在阶段 6b 给 Tape 的 Execution Journal 加防篡改（多租户合规需要）。

### 4.12 扩展层：Customize 页与 Skills / Plugins / Connectors / .mcpb（2026-09-12 补）

行为细节全在 [claude-desktop-feature-map](../reference/claude-desktop-feature-map.md) §06，这里只写架构位置。四个概念一句话：**Connector 是 UI 概念，MCP 是协议，Plugin 是打包格式，Skill 是提示词工程的模块化。** Customize 页 = `skills / connectors / plugins` × `yours / discover` 六个 tab。

| 组件 | Tenon 里是什么 | 关键约束（来自 Claude Desktop 实测 / 官方文档） | 参考代码 |
|---|---|---|---|
| **Skill** | 一个文件夹（`SKILL.md` + 脚本 + 资源），**三级渐进加载**：L1 元数据常驻 system prompt（≈100 token/skill）→ L2 正文命中时读 → L3 脚本走 bash 只有 stdout 进上下文 | description 是路由表（纯语义匹配，无意图分类器）；成立前提是 agent 有文件系统和 bash；恶意 skill 能反向指使工具 → 沙箱执行 + 内容扫描 + 组织级禁用 | DeepChat `src/main/skill/`（🟢，能与 Claude Code / Cursor 互导）；Cherry `src/main/ai/skills/`（🟡只看） |
| **Plugin** | 一个包：`.claude-plugin/plugin.json` + `.mcp.json` + `commands/` + `skills/` + `agents/` + `hooks/` | **任何含插件包的 Git 仓库都能当 marketplace**（填 `owner/repo`）；sha256 完整性校验；三层优先级 managed MCP > 组织插件 > 用户扩展，用户层可整体关闭；**组件级开关**（装了插件仍能单独禁某个 skill / hook）；限额：包 200MB / 5000 文件 / 单市场 500 插件 / 25 个市场 | anthropics/knowledge-work-plugins（Apache-2.0）做格式样板 |
| **Connector 声明** | 插件里**按角色而非厂商**声明连接器（`~~source control`、`~~chat`），安装时用户把角色绑定到具体 MCP（GitHub / Gitee；Slack / 飞书） | 声明不含凭证，OAuth 自己走；STANDALONE（无连接器也能用）/ SUPERCHARGED（连上更强）两级降级 | 同上 |
| **Connector 目录** | 目录 + 三档标签 Verified / Community / Custom（**只影响展示，不影响运行时能力**） | **连接器身份绑目录 ID 不绑 URL**（服务商改 `/sse`→`/mcp` 不能让用户的连接掉成 Custom）；五类：第一方 / 远程 MCP / MCP Apps / .mcpb / 本地自托管 | Goose `documentation/static/servers.json`（静态 JSON，约 95 条）做最小版 |
| **远程连接器 OAuth** | 填 URL → 探测并预填认证设置 → 认证三选一（Always / When asked / None）→ client 三选一（**CIMD 优先** / DCR 兜底 / 自带） | 必须校验授权响应 `iss`（RFC 9207）；凭证按 issuer 分键进 keychain；认证设置添加后不可改 | LibreChat `packages/api/src/mcp/`（OAuth 落地）；DeepChat `mcpClient.ts` 的 `authProvider` |
| **.mcpb** | ZIP，唯一必需 `manifest.json`；`user_config` → 表单 → `sensitive` 进 keychain → spawn 时 `${...}` 插值 | "双击即装"成立的前提是**宿主自带 Node runtime**——所以 Electron（ADR-001）；`.dxt` 旧扩展名兼容 | mcpb `src/index.ts` + `MANIFEST.md` + `schemas/`（MIT） |
| **Hooks** | 会话生命周期事件点挂脚本（`SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PermissionRequest / Stop / SessionEnd`） | 风险最高的组件；DeepChat 的做法是**只通知不改变决策**，第一版照此 | DeepChat `src/main/hook/events.ts` |
| **Record a skill** | 录屏 + 口述 → 可复跑 skill（2026 新增） | 需屏幕录制 + 转写 + "demo 转结构化指令"管线 | 无参照，**阶段 7 后** |

**多租户下的归属**：Skills / Plugins / Connectors 授权都是**租户作用域**（§4.13），marketplace 列表由租户策略层下发，用户层只能在策略允许范围内增删。

**"接公司系统"不需要另写项目。** 公司的客服、审批、查数系统各自是一个 MCP server（公司自己写或买），打成一个 plugin 放在公司的 Git 仓库里，员工在 Customize 里填 `company/plugins` 就装上了。Tenon 只负责当 host。跨角色对照：

| 角色 | 公司系统 | 作为 MCP server 暴露的工具 | 权限档 | plugin 里的 skill |
|---|---|---|---|---|
| 客服 | 工单系统 | `search_tickets`（读）、`reply_ticket`（写，需确认） | 写操作每次确认；租户策略可禁 `close_ticket` | "按 SLA 分级回复"的话术与流程 |
| 财务 | 报销 / 审批流 | `list_pending_approvals`、`approve`（写，不可逆 → 每次都要你亲自批；只有策略点名放开、连接器页设的总是允许、阶段 6 的按任务授权这三种能免；可逆性由租户策略标定，未标定时为「未知」，卡上的允许只管这一次） | 不可逆动作每次问（2026-09-25 改，见 [02 §决策表与各层输入](02-agent-loop/spec.md)） | "对照发票校验报销单" |
| 数据分析 | 数仓 | `run_sql`（只读账号）、`list_tables` | 只读账号 + 沙箱网络白名单只放数仓域名 | `data:explore-data` 那类探索框架 |
| HR | HRIS | `lookup_employee`（读，字段掩码） | PII 掩码在 server 侧做（railguard 那类） | 入职 checklist |
| 法务 | 合同库 | `search_contracts`、`extract_clauses` | 只读 | 条款审查清单 |
| 市场 | CRM + 飞书 | `~~crm`、`~~chat` 按角色声明，安装时绑到具体系统 | 发消息类工具需确认 | 周报生成 |

**Tenon 仓库里值得写的"其他项目"只有一个**：`examples/plugins/` 下两三个样例插件（一个只读查数 MCP 对着 SQLite、一个 mock 审批流、一个把 `~~chat` 绑到飞书官方 MCP），用途是证明 marketplace 链路能跑、给企业当模板。几百行，不是独立项目。

**railguard 在这条链路上的位置**（2026-09-12）：它在**公司 MCP server 那一侧**，不在 Tenon 里。Tenon 的权限引擎只看得见"哪个工具、要不要用户同意、沙箱放行什么"，看不见业务语义——HR 能查哪些字段、财务能审哪个部门的单，这些是 server 侧的事，正是 railguard 的 `rbacToolGate` / 行过滤 / 字段掩码 / 人工审批。所以：(1) 样例插件里的查数 MCP 和 mock 审批流**内置 railguard**，作为"公司写 MCP server 时怎么做数据访问守卫"的模板；(2) railguard 加一个 MCP server adapter（它现有的是 Vercel AI SDK / Mastra adapter）；(3) Tenon 侧仍可选装 railguard 的注入检测作为 Inspector（§4.11 ⑥）。三个位置，两个仓库，边界清楚。

### 4.13 多租户与云端 host（对齐 Claude Desktop）

Claude Desktop 的概念 → Tenon 的实现：

| Claude Desktop | Tenon | 作用域 |
|---|---|---|
| 账号 | `userId` | 全局 |
| 组织（个人 / Team / Enterprise），可切换 | **`tenantId`**，用户与组织多对多 | 租户 |
| Projects、记忆、连接器授权、插件、定时任务 | 全部带 `tenantId`；服务端行级隔离，本地按 profile 目录隔离（**一个本地 profile = 一个 `(userId, tenantId)`**） | 租户 |
| 管理员托管设置（允许的 MCP、权限下限、能否连本地文件夹） | 权限作用域：**租户策略 → 用户默认 → 会话 → 单次**，这四级只标作用域，不代表查找顺序；决策顺序见 02 §权限决策顺序（2026-09-25 改，见 [02 §权限决策顺序](02-agent-loop/spec.md)）；策略层由服务端下发，本地缓存 | 租户 |
| Cowork 云端会话：内核在 Anthropic 临时沙箱，会话跟随账号 | `apps/server` 为每个会话起一个租户隔离的沙箱，跑同一个 `packages/kernel` | 租户 + 会话 |
| 桌面 App 是桥：云端会话读本地文件夹要开着桌面 App | **桥协议**：桌面 App 与服务端保持长连接，服务端通过它对本机文件做受限读写（Claude Desktop "云端会话经桌面 App 读本地文件夹"那条桥的自研版） | 用户 + 设备 |
| 本地模式：Linux VM（2026-10-09 补，2026-10-15 照公开文档改准：Pro / Max 的新 Cowork 任务自 2026-10-06 起在云端运行（[15520349](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)），已进合并体验的账号任务只在云端（[15811196](https://support.claude.com/en/articles/15811196-what-to-expect-with-claude-cowork-in-the-cloud)）；Team / Enterprise 仍有本地 VM 会话（[13455879](https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans)、[14479288](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)）；Tenon 本机执行与隔离的对照改为 Claude Desktop 的 Code 会话与 Claude Code，见 [04](04-sandbox/spec.md) T37） | `apps/desktop` 直接用 sandbox-runtime | 用户 |

**内核不变量**（写进 `AGENTS.md` 硬规则）：`packages/kernel` 禁止 import `electron`、禁止直接读写文件系统和 keychain、禁止直接 spawn——全部经 `HostAdapter`。用 lint 规则（`no-restricted-imports`）和包边界强制，不靠自觉。

**存储**：Tape 表加 `tenant_id` 列并进主键前缀；本地版一个 profile 一个 SQLite 文件，`tenant_id` 恒为该 profile 的租户。这样同一套表结构本地和服务端通用，本地→云端迁移是数据搬运不是 schema 改造。

**云端沙箱**：这是全项目最难的安全问题——租户之间跑的是模型写的代码。sandbox-runtime 是进程级，云端要再包一层容器或 microVM（主参考 §4.10 提过 microsandbox / E2B）。**阶段 6b 定**，但内核的 `HostAdapter.sandbox` 接口从阶段 0 就按"可能是远端"设计（异步、可取消、可回传违规）。

**参考（2026-09-12 核实）**：

| 子问题 | 参考 | 许可证 | 拿什么 |
|---|---|---|---|
| **内核 / 执行环境 / 远程 agent server 的分层** | OpenHands Software Agent SDK（[arXiv 2511.03690](https://arxiv.org/html/2511.03690v2)）：`openhands.sdk`（Agent 是无状态、可序列化的规格）/ `openhands.tools` / `openhands.workspace`（`BaseWorkspace`：`execute_command` / `file_upload` / `file_download`，Local / Docker / Remote 三实现）/ `openhands.agent_server`（REST + WebSocket） | MIT 🟢 | **就是 `packages/kernel` + `HostAdapter` + `apps/server` 的现成样板**。Agent 规格序列化跨进程、append-only EventLog + `base_state.json` 恢复 |
| **桥协议：云端会话在用户机器上执行** | Claude Managed Agents 的 [self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)：**出站轮询模型**——用户侧 worker 用 environment key 长轮询 `/v1/beta/environments/{id}/work` 领工作项，本地执行 bash / read / write / edit / glob / grep，结果 POST 回控制面；代码、文件、网络出口留在本地，只有工具输入输出上云；memory store 15s 同步 | 文档公开；SDK 里的 `EnvironmentWorker` 在 MIT 的 anthropic SDK 内 | **这就是"云端会话读本地文件夹要开着桌面 App"的官方实现形状**：桌面 App = 一个 worker，无需入站端口。注意它自述文件工具只限 `/workspace + allowed_roots`、**bash 不受限**——我们的桌面 worker 要再套 sandbox-runtime |
| **服务端资源模型** | Claude Managed Agents [overview](https://platform.claude.com/docs/en/managed-agents/overview)：Agent（模型 + 提示 + 工具 + MCP + skills，按 ID 复用）/ Environment（云端或自托管沙箱）/ Session（在 environment 里跑的实例）/ Events（SSE 流，服务端持久化全量事件史，可中途追加事件 steer） | 文档公开 | `apps/server` 的 API 形状照这个定；Session ↔ Tape 一一对应 |
| **组织 / 成员 / 角色 / 资源共享** | LibreChat [Access Control](https://www.librechat.ai/docs/features/access_control)：三层——角色级功能权限、资源级 ACL（agents / prompts / MCP servers / files / projects，Viewer / Editor / Owner）、系统级管理授权；principal 有 User / Group / Role / Public，Group 可从 Entra 同步 | MIT 🟢 | ACL 模型可抄。**但它没有 workspace / tenant 隔离**，共享是实例级的——租户这一层要自己加 |
| **身份与组织（拿来用）** | better-auth organization 插件（TS）：organization / member / invitation / team / role | MIT 🟢 | 不自己写账号系统 |
| **租户数据模型（只看不抄）** | Dify：tenant = workspace，`tenants` / `tenant_account_joins` | Apache-2.0 + 附加条款：**未经书面授权不得用其源码运营多租户环境** | 看 schema 怎么切租户；一行不抄 |
| **云端沙箱基础设施** | E2B [infra](https://github.com/e2b-dev/infra)：API / orchestrator / client-proxy / envd（VM 内守护进程）/ template manager，Firecracker microVM，快照恢复 | Apache-2.0 🟢 | 阶段 6b 选型的重量级选项；需要 GCP/AWS + Nomad + Terraform，**自托管运维成本高**，更可能直接买它的托管或用 microsandbox |

**明确不在第一版做**：计费、SSO、审计日志导出、跨区域部署。

## 5. 开源"类 Claude Desktop"项目现状

结论：**沾边的很多，完整复刻的没有。**

### 5.1 名字像，但不是复刻

| 类型 | 例子 | 本质 |
|---|---|---|
| Linux 移植脚本 | emsi/claude-desktop、aaddrick/claude-desktop-debian、fsoft72/claude-desktop-to-appimage | 把官方 Windows 包重新打包，**用的还是官方本体** |
| 多开工具 | scadastrangelove/claude-clone（macOS）、vodongha/claude-desktop-clone（Windows） | 换数据目录多账号登录 |

意外价值：README 透露了官方内部信息，如环境变量 `CLAUDE_USER_DATA_DIR` 切换数据目录。**只看公开说明，不解包、不反编译。**

### 5.2 只复刻 Cowork 的开源替代品

| 项目 | 技术栈 ✅ | 许可证 ✅ | Agent 引擎 | 备注 |
|---|---|---|---|---|
| **AionUi** | Electron + React + Arco Design | Apache-2.0 🟢 | 接 Gemini CLI、Claude Code、Codex、OpenCode、Goose CLI 等；内置 `aionrs` 引擎 | **32.7k star**（2026-09-11 ✅）；Rust 在独立的 AionCore 仓库 ✅；"inject or sync compatible transports"——把 MCP 配置同步进各 CLI agent 的配置文件，**要和用户已装 CLI agent 共存时唯一有现成答案的** |
| **OpenWork** | Electron（默认分支 `dev`） | 主体 MIT 🟢；`/ee` 企业版 🔴 | 基于 OpenCode | 桌面免费；团队版前 5 席免费，之后 $10/席/月 ⚠️ |
| **Open Claude Cowork** | Electron 39 + `@anthropic-ai/claude-agent-sdk` | MIT 🟢 | Claude Agent SDK（🔴 商业条款） | Composio 出品，卖点是它自家 500+ 集成 |

### 5.3 共同规律

**界面自己做，Agent 引擎用现成的。** 连 Cherry Studio V2 也内置了 Claude Code 运行时并集成 Hermes、OpenClaw。"桌面客户端 = 好用的界面 + 可插拔的 Agent 引擎"正在成为主流。

**这正是路线 B。我们选了 A，但要理解为什么主流是 B**：出活快、精力集中在体验上。**A 的代价是慢，收益是你真的懂。**

## 6. 为什么没人完整复刻，以及复刻范围

### 6.1 非技术原因

1. **复刻出来很难有人用。** Claude Desktop 免费。一个"只接 Claude、长得一样"的开源版没有差异价值；加多模型就得暴露服务商、API Key、参数，简洁感消失。
2. **官方迭代太快。** Cowork 几个月变几轮，小团队追不上。
3. **名称、Logo、视觉照搬有商标和外观侵权风险。**

### 6.2 技术难点

1. **很多功能在服务端不在客户端。** Cowork 云端会话里 agent 循环和代码执行都在 Anthropic 沙箱（[架构概览](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview) ✅）。记忆、项目知识库、连接器授权、定时任务同样依赖服务端。**客户端更像遥控器**——"算力在云端，文件在本地，桥是桌面 App"。
2. ~~本地 Agent 的安全隔离非常难做~~ → **已有现成库**（§4.10）。官方本地模式用专用 Linux VM，今年仍有 VM 逃逸的安全研究（[Techzine](https://www.techzine.eu/news/security/143187/claude-cowork-escapes-from-virtual-machine/) ⚠️）。sandbox-runtime 是 OS 级不是 VM 级，隔离强度低一档，但对本地模式是正确的起点，云端隔离见 §4.13。（2026-10-09 补：本地 VM 模式已不是 Cowork 的默认——Pro / Max 自 2026-10-06 起新任务一律上云、「Only on your computer」已移除，已进合并体验的账号任务只在云端、没有本地选项（2026-10-15 补，[15811196](https://support.claude.com/en/articles/15811196-what-to-expect-with-claude-cowork-in-the-cloud)），Team / Enterprise 仍可保留本地（[15520349](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)、[13455879](https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans)）；Tenon 自阶段 4 起执行与隔离对照 Claude Desktop 的 Code 会话与 Claude Code 的 OS 级沙箱，见 [04](04-sandbox/spec.md) T37）
3. **效果和模型深度绑定。** Claude 好用是模型、系统提示词、工具设计联合调优的结果。
4. **协议还在快速变化。**
5. **UX 打磨极其耗人。**

### 6.3 复刻范围划分

| 类别 | 功能 | 建议 |
|---|---|---|
| **必须自己做（核心学习价值）** | 聊天与流式渲染、**agent loop**、MCP host、工具调用展示与权限确认、.mcpb 安装、Artifacts、会话管理、桌面壳层 | 第一阶段 |
| **可以简化** | 记忆（本地文件或 SQLite）、知识库（单机向量检索）、Skills（本地目录加载） | 本地版先做，云同步在阶段 6b |
| **直接用现成** | **沙箱（sandbox-runtime）**、联网搜索（搜索 API 或 MCP server） | 不自研 |
| **放到阶段 6b** | 云端会话、跨设备同步、定时任务云端执行、企业管理策略（2026-09-12 改：对齐 Claude Desktop 第三层，见 §4.13） | 成本极高，但架构从阶段 0 就为它留位置 |

## 7. 技术路线：已选 A

### 路线 A：自研 agent loop（**已选**）

自己实现"调模型 → 解析工具调用 → 权限确认 → 执行工具 → 结果回灌 → 循环"，外加上下文压缩、子 agent。

- **优点**：完全掌握原理，符合"端到端吃透"；能说清的是具体工程决策（每轮修剪上下文、错误回传给模型而非终止、requestSeq/physicalAttempt 分离）而不是"我用了 XX 框架"
- **缺点**：慢；要做到 OpenCode / Claude Code 的稳定度要大量调试
- **参照**：Goose（设计）、OpenCode（TS 实现）、computer-use-demo（最小）、Claude Agent SDK 文档（官方权限模型）

### 路线 B：接现成 CLI Agent（**保留为对照**）

像 AionUi、OpenWork 那样把 OpenCode / Claude Code 当引擎，桌面端管会话、展示、预览、权限确认界面。

- **优点**：几周能有能力很强的 agent；精力集中在体验上
- **缺点**：agent 是黑盒；工具调用失败、崩溃恢复、租户策略这些都要改它的内部，改不动

### 为什么选 A

目标是业界最佳实现水准（2026-09-11 已定），而内核不在自己手里就没有"最佳"可言：多租户云端 host、租户策略层、Tape 的崩溃恢复语义，这些都要改到循环内部，路线 B 改不动。**A 慢，但慢的那部分正是这个项目存在的理由。**

**B 有一个 A 给不了的东西**：几周内有真的在用的产品，用它发现真实问题。所以更准确的做法：**A 是主线，但可以在阶段 2 用 OpenCode 当"对照组"**——你的循环和它跑同一个任务，看差在哪。这比闷头写强。

**2026-09-17 改**：主对照组换成用户机器上的 Claude Desktop 本身（对话对 Chat、任务对 Cowork），同题两边跑、录屏对比；OpenCode 保留为第二对照。见 §13 阶段 2「提示层」。 **2026-10-15 补**：这套口径已不能照原样复现。Pro / Max 自 2026-09-16 起按账号分批把 Chat 与 Cowork 合一（迁移后不能切回）、自 2026-10-06 起新 Cowork 任务一律在云端（[官方博客](https://claude.com/blog/cowork-is-now-claude)、[帮助文章 16761823](https://support.claude.com/en/articles/16761823)、[15520349](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)），「在本机 Cowork 会话里跑、Manual 档」这个协议对 Pro / Max 不再成立，owner 要求下一次评测运行之前另定新协议，2026-10-15 定它只挡主对比（与 Claude Desktop 的同题对比），基线列照常跑——基线列的跑法本身不涉及 Claude Desktop（见 [04 plan](04-sandbox/plan.md) 的 Open）。2026-10-01 同题对比里 Claude Desktop 一列（B）由 GPT 操作得出，03 读法 70 已把「Claude Desktop 一侧交给程序自动跑」判为违反消费者条款，owner 2026-10-15 改为只作参考、不作验收证据；同模型列（Claude Code + glm-5.3 对 Tenon + glm-5.3）不受影响。

## 8. UX 策略：交互参考 Claude，视觉做自己的

| 层次 | 内容 | 策略 | 理由 |
|---|---|---|---|
| **交互层** | 布局、输入框行为、流式与滚动、工具调用折叠、权限确认弹窗、Artifacts 侧栏、快捷键 | **放心参考** | 大多已是行业惯例 |
| **视觉层** | 品牌色、字体、Logo、图标、插画、文案 | **最终换成自己的** | 见下 |

视觉必须自己做的三个理由：
1. **法律**：名称、Logo、一眼可辨的视觉组合照搬有侵权风险（非法律意见）
2. **字体用不了**：claude.ai 加载的是 Anthropic 自有字体 Anthropic Sans / Serif / Mono ✅，专有字体，外部不能用。网上"免费下载 Claude 字体"的站不要用
3. **会被看成山寨**：Anthropic 官方 frontend-design skill 把"暖奶油底 + 衬线标题 + 赤陶色强调（约 `#D97757`）"列为 AI 设计扎堆套路 ✅，并说明该强调色是 Anthropic 自己的交互色

**学习和自用阶段照着 Claude 做没问题，只要技术上保证随时能换装。**

### 8.1 设计令牌

```css
:root {
  --color-bg: #f0ece0;          /* 学习阶段临时借用 assistant-ui Claude 示例 */
  --color-text: #1f1e1d;
  --color-accent: #c96442;
  --font-body: "Inter", "PingFang SC", "Source Han Sans SC", sans-serif;
  --font-display: "Source Serif 4", "Noto Serif SC", serif;
  --radius-sm: 6px;
  --radius-md: 12px;
  --space-unit: 4px;
}
```

> 色值来自 assistant-ui 官方 Claude 示例 ✅，仅作临时皮肤。第三方整理的 Claude 色值（`#faf9f5`、`#cc785c` 等）⚠️ 是二手分析。
>
> **2026-10-15 注记**：owner 当天决定离开这组奶油赤陶，先换一组中性的临时种子（`bg #f4f5f3` / `text #15191a` / `accent #1e5e4a`），仍是临时皮肤，定稿照 §8.3。现行值、派生规则和逐项推导在 [docs/ux/tokens.md](../ux/tokens.md)「2026-10-15 临时换装记录」，代码以 `apps/desktop/src/styles/tokens.css` 为准；上面代码块里的三个色值只作历史记录。三个新种子取自 2026-09-12 十三款产品差异化调研的推荐值（仓库外，另记）；owner 当天定的是离开赤陶，owner 2026-10-15 在 PR #46 评审中确认用这三个值作临时皮肤，定稿照 §8.3。字族与「界面无衬线 + 助手正文衬线」这一条不受影响。

**必须保留的一条**：「界面无衬线 + 助手正文衬线」的区分。这不是品牌，是**可读性设计**——让"系统在说话"和"助手在说话"视觉可区分。

### 8.2 底座

| 方案 | 推荐度 |
|---|---|
| **shadcn/ui（Base UI）+ Tailwind** | ⭐⭐⭐ 组件源码归你，主题靠变量；assistant-ui、AI Elements 都基于它 |
| lobe-ui | ⭐⭐ 快速出效果 |
| 完全手写 | ⭐ 可访问性坑极多 |

### 8.3 没有设计师怎么定视觉

1. 一个主色 + 一套中性色阶。避开 Claude 的暖橙系
2. 一套开源字体。**一定要测中英文混排**
3. 圆角 2–3 档；间距 4 的倍数
4. 固定一个图标库（lucide）

### 8.4 节奏

1. **功能跑通**：用 assistant-ui Claude 示例风格，从第一天用变量写样式
2. **打磨**：按 §10 清单逐条优化
3. **决定做产品前**：定主色、字体、Logo，替换令牌，换装

### 8.5 最终形态与规格来源（2026-09-12 明确）

**一句话**：用过 Claude Desktop 的人打开 Tenon，十秒内知道每样东西在哪、怎么用；但没有人会把它误认成 Claude。

| 层 | 做成什么样 | 规格来源 | 能不能进仓库 |
|---|---|---|---|
| 信息架构 | 与 Claude Desktop **一致**：左侧栏 264px（品牌行 + 双模式切换 → 主导航 → Scheduled → Projects 两级树 → Chats and tasks → 账号行）、顶栏、右侧面板（Artifacts / Cowork 两种）、Settings 模态、Customize / Projects / Artifacts / Scheduled 四个页面。**2026-09-17 注**：对话 / 任务切换在 Tenon 里放首页输入框内，不在侧栏品牌行，以 UX 画布 v18 为准（见 `docs/ux/parity-audit-2026-09-12.md`）。**2026-10-15 注**：Claude 自 2026-09-16 起把 Pro / Max 的 Chat 与 Cowork 合成一个入口、不再选模式（按账号分批放量，[官方博客](https://claude.com/blog/cowork-is-now-claude)、[帮助文章](https://support.claude.com/en/articles/16761823)），这一行写的「双模式切换」「Cowork 面板」是合一之前的界面；Tenon 不跟，仍保留对话与任务两种会话形态（02 的 H1），入口改成输入框里的「在文件夹里工作」开关，取代两颗胶囊的模式切换（owner 2026-10-15 定，随 4d 或展示层 spec 做）；侧栏、右面板等其余几项照旧 | uxkit `interactions.md` §1、§4 | 规格可进，DOM 快照不进 |
| 交互行为 | **1:1**：Composer 状态机与 `+` 菜单（Chat / Cowork 差异）、6 种工具块、产物块、版本切换、审批 / 中断 / 引用 / 流式态、行菜单、快捷键表、空 / 加载 / 错误态、响应式断点、动效目录（含 reduced-motion 降级） | `interactions.md` §2、§3、§5–7 + `animations.json` | 规格可进 |
| 设计令牌的**结构** | 同样的语义分层：surface / text / border / fill / alpha / radius / h-control / weight / ease / dur / z，亮暗两套，壳层背景独立一层 | `tokens.css` 的**键名**与分层 | 键名可进，**值不进** |
| 设计令牌的**值** | 自己的：一个主色 + 中性色阶（避开暖橙系）、开源字体（测中英混排）、保留"界面无衬线 / 助手正文衬线"的区分 | §8.1 临时皮肤 → §8.3 定稿 | 自己的值进 |
| 视觉资产 | 自己的 Logo、图标（lucide）、插画、文案 | — | 自己的进 |
| **不做** | Claude Code 壳（`interactions.md` §8，用户明确不关心）、Claude Design 壳 | — | — |

**规格已经存在**：`interactions.md`（288 行，每条挂 fixture 编号，全部实拍验证）就是 UX 规格本身，不用另写。缺的两样：(1) 每个界面到 shadcn/ui 组件的映射表；(2) 令牌值替换表。这两样在阶段 0 做基础组件时补。

**用法边界**：fixtures 用来**看**结构和状态（打开 `fixtures/index.html` 逐个对照），不复制 class 串、不引用 `css/`；`tokens.css` 只抄键名。uxkit 整包放仓库外的私人目录。

**UX 与阶段的对应**：阶段 0 = 令牌 + 基础组件 + 壳层 + Composer 最小态 + 消息流基础；阶段 2 = Thinking 块、流式态、中断，以及 02 §界面范围 列出的最小版；阶段 3 = MCP 直接相关的界面：连接器栏、添加确认框、审批卡的可逆性刻度、工具行的副作用段与可逆性标记、连接器卡的 server 名与「定义已变」；其余工具块、带样式的改动预览与持久文件夹授权挪到阶段 4，SkillReadSubRow 随阶段 5 的 Skills（2026-10-08 改，见 [03 §界面](03-mcp-host/spec.md)；原为「6 种工具块、审批弹窗（均指完整版）」，2026-09-25 改，见 [02 §界面范围](02-agent-loop/spec.md)）；阶段 5 = 产物块、Artifacts 页与右面板；阶段 6 = 空 / 加载 / 错误态、动效目录、响应式全部过一遍（§10 清单）。Scheduled / Projects / Customize 页面跟随各自后端能力出现。

## 9. 优秀客户端参考与拆解方法

### 9.1 AI 客户端

| 产品 | 学什么 |
|---|---|
| **Claude Desktop** | 工具调用折叠、权限弹窗措辞和按钮层级、Artifacts 侧栏、三 tab 切换 |
| **ChatGPT 桌面版** | 7 月改版后聊天 + Work + Codex 合一并内置浏览器 ✅；快捷键浮窗 |
| **Perplexity** | 引用角标、来源卡片、悬停预览 |
| **Cursor / Zed** | Agent 执行步骤列表、diff 审阅、接受/拒绝 |
| **LobeHub** | 开源里视觉最好的之一 |

### 9.2 非 AI 桌面标杆

| 产品 | 学什么 |
|---|---|
| **Linear** | ⌘K 命令面板、全键盘、悬停选中反馈、暗色层次 |
| **Raycast** | 快速唤起、扩展商店、设置页 |
| **Things 3** | 动效节奏和留白 |
| **Notion** | 斜杠命令、粘贴、拖拽 |
| **VS Code / Obsidian** | 功能多但不乱的设置页与插件管理 |

### 9.3 拆解方法

1. **DevTools 看网页版真实数值**（claude.ai、chatgpt.com、linear.app 都有网页版）
2. **录屏慢放**，0.25 倍速逐帧看动效
3. **写拆解笔记**：怎么触发 → 中间给什么反馈 → 结束是什么状态
4. 先深度拆解 **Claude、Linear、Raycast** 三个

**私有 UX 规格（`interactions.md`，不入库）就是拆解笔记的成品**——状态机、快捷键、各菜单差异表。`css/` 和 `fixtures/` 里的像素学完就该扔。

## 10. UX 细节打磨清单

| # | 细节 | 问题 | 做法 |
|---|---|---|---|
| 1 | 流式滚动 | 输出时贴底；用户上翻后不被拽回 | use-stick-to-bottom ✅ |
| 2 | 中文输入法回车 | 拼音选词时回车误发送 | `compositionstart`/`compositionend` 或 `event.isComposing` |
| 3 | 长对话性能 | 几百条后卡顿 | 虚拟列表（TanStack Virtual），和贴底、动态高度配合 |
| 4 | 流式 Markdown | 逐字重排闪烁 | Streamdown |
| 5 | 代码块、表格、公式 | 高亮、复制、横向滚动、LaTeX | Shiki、KaTeX；AI Elements |
| 6 | 动效节奏 | 拖沓或生硬 | 参考 Linear、Things 3；只给"用户操作带来的变化"加动效 |
| 7 | 字体与明暗 | 暗色层次糊、中英混排不齐 | 边框、代码块、阴影分别调；中英字体实测 |
| 8 | 桌面原生感 | 像网页套壳 | macOS 隐藏标题栏 + 拖拽区、红绿灯位置、原生菜单 |
| 9 | 加载、错误、空状态 | 界面发懵 | 骨架屏、工具执行中态、可重试错误、有引导的首屏 |
| 10 | 附件 | 拖放没反馈 | 拖入高亮、粘贴处理、上传进度、附件预览 |
| 11 | 可访问性 | 键盘不可用、读屏读不出流式 | 焦点管理、`aria-live` |
| 12 | **skill 生效反馈** | 用户不知道本次用了什么 | Claude Desktop 自己没做好的地方，你可以做 |
| 13 | **插件热加载** | 装完当前会话看不到 | 同上 |

## 11. 泄露源码风险

2026 年 3 月 31 日 Anthropic 发布 Claude Code npm 包时误带 source map 导致源码外泄（约 16 万行 TS），随后 DMCA 下架 ⚠️。

| 风险 | 说明 |
|---|---|
| **版权** | 无任何开源授权 🔴。不能复制，不能商用 |
| **"净室重写"存疑** | 泄露后一两天完成的重写很难证明没接触原代码 |
| **声誉** | 公开仓库里出现源自泄露代码的痕迹，会被社区和雇主视为红线 |
| **相关性有限** | Claude Code 是终端工具（React + Ink），对桌面 UX 帮助不大 |
| **安全** | 不要运行来路不明的"解锁版" |

**合法替代**：Claude Agent SDK 官方文档、OpenCode、Hermes Agent、Goose、Codex CLI。

## 12. Claude Desktop 功能清单（2026 年 9 月）

| 功能 | 现状 | 复刻 |
|---|---|---|
| **三个 tab** | Chat / Cowork / Code，同一 agent 内核三套 profile（2026-10-15 改：2026-09-16 起 Pro / Max 的 Chat 与 Cowork 合成一个 Claude，不再选模式，快问和长任务在同一个对话里提，按账号分批放量、迁移后不能切回；Code 仍是独立标签；Team / Enterprise 暂时保持 Chat 与 Cowork 分开（[13455879](https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans)），Enterprise 另有默认关闭的统一版公测（[17444462](https://support.claude.com/en/articles/17444462-set-up-and-manage-the-new-unified-claude-experience-for-your-enterprise-organization)）。出处：[官方博客](https://claude.com/blog/cowork-is-now-claude)、[帮助文章](https://support.claude.com/en/articles/16761823)） | Chat / Cowork 两套 profile 实现；kernel 的 profile 枚举为 Code 留位，壳不做（§8.5）（2026-10-15 owner 定：Tenon 不跟合并，两种会话形态照旧，入口改为输入框里的「在文件夹里工作」开关，见 §8.5） |
| **Cowork 云端会话** | **默认云端**：agent 循环和代码执行在 Anthropic 临时沙箱，会话跟随账号 ✅ | 阶段 6b（§4.13） |
| **Cowork 本地会话** | 专用 Linux VM（macOS Apple Virtualization.framework，Windows Hyper-V），自带网络出口过滤 ✅（2026-10-09 补：Pro / Max 自 2026-10-06 起新任务一律上云，本地模式只在 Team / Enterprise 可保留；2026-10-15 补：10-06 之前在本机开始的任务留在本机、可以做完，之前建的本机定时任务继续在本机跑；想纯本机运行，官方指向桌面端的 Claude Code；已进入合并体验的账号任务一律在云端、没有本地选项。出处：[帮助文章 15520349](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)、[13854387](https://support.claude.com/en/articles/13854387)、[14479288](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)、[15811196](https://support.claude.com/en/articles/15811196-what-to-expect-with-claude-cowork-in-the-cloud)） | sandbox-runtime（OS 级，低一档；2026-10-09 起对照改为 Claude Desktop 的 Code 会话与 Claude Code，见 [04](04-sandbox/spec.md) T37） |
| **本地连接器与本地 MCP** | 只在桌面端；云端会话读本地文件夹要开着桌面 App ✅ | §4.3、§4.4 |
| **定时任务** | 云端运行 ✅ | 本地版先做，云端版阶段 6b |
| **computer use** | Pro/Max beta ✅，三档应用权限按类别固定 | computer-use-demo |
| **浏览器** | 内置浏览器或 Claude in Chrome ✅ | 暂不复刻 |
| **Artifacts** | 8/19 后创建的桌面和 web 都能用 ✅ | §4.6 |
| **记忆、Projects、Skills、Plugins、连接器** | 均已上线 | §4.7、§4.12、§4.13 |
| **企业管控** | MDM 可禁本地 MCP、禁 .mcpb ✅ | 租户策略层，阶段 6b |

详细功能勘测见 [claude-desktop-feature-map](../reference/claude-desktop-feature-map.md)。

## 13. 分阶段路线（按路线 A）

### 阶段 0 之前：仓库与发布规范（源码核实自 DeepChat / Cherry Studio，2026-09-12）

| 项 | 做法 | 依据 |
|---|---|---|
| Agent 指令文件 | **`AGENTS.md` 是唯一正本**，`CLAUDE.md` 内容只有一行 `READ [AGENTS.md](AGENTS.md)` | DeepChat 原样如此；Cherry 是两份完全相同。Codex 读 AGENTS.md，Claude Code 读 CLAUDE.md，一份规则两边生效 |
| 提交 | Conventional Commits（`type(scope): subject`，≤50 字符）+ commitlint；**禁止 AI co-author 尾注**（Claude Code 需在 settings 关掉 `includeCoAuthoredBy`） | DeepChat AGENTS.md 明文 "never add AI co-authors" |
| 分支 | `main` 受保护；日常 PR 进 `dev`；只有 release 分支进 `main` | DeepChat 规则。单人阶段可简化为 main + feature 分支 + 自己给自己开 PR（为了 CI 门禁和记录） |
| 交接前门禁 | format → i18n → lint → typecheck → 相关测试，全过才 handoff；用 hooks 强制 | DeepChat AGENTS.md；Cherry `build:check = lint && docs:check && test` |
| 许可证 | **Apache-2.0**，首个 commit 就带 `LICENSE` + `NOTICE`；从 DeepChat / Goose / sandbox-runtime 抄的文件保留原版权头并在 NOTICE 列出 | 抄的都是 Apache；**Cherry 是 AGPL，一行都不能抄** |
| 绝不入库 | uxkit（Claude 真实 CSS / DOM fixtures / 品牌 token）、`.env`、密钥；开 GitHub secret scanning + push protection | §8、§11 |
| 仓库标配 | README（中英）、CONTRIBUTING、CODE_OF_CONDUCT、**SECURITY.md**（沙箱产品必须有漏洞披露渠道）、issue / PR 模板、dependabot、`.editorconfig`、oxlint | 两家都有 |
| CI | `ci.yml`：PR 触发 install / typecheck / lint / test；打 tag 触发三平台 electron-builder 打包 + GitHub Release；nightly 可选 | DeepChat `build / prcheck / release / _package-{linux,macos,windows}`；Cherry `ci / nightly-build / release-packages` |
| 签名与分发 | macOS 公证要 Apple Developer（年费）、Windows 签名证书更贵——**阶段 7 做**，Release 里写明"未签名，首次打开需右键"；sandbox-runtime 三个 helper 放 asar 外 | [sandbox-runtime-mechanisms](../reference/sandbox-runtime-mechanisms.md) §三 |
| 版本 | `0.x` semver，tag `v0.1.0`；CHANGELOG 由 commit 生成（release-please 或 changesets） | DeepChat 有 CHANGELOG + commitlint |

### 阶段 0：地基（半天 + 1 周）

- **定依赖**：`@modelcontextprotocol/client@2.0.0`、`@anthropic-ai/sandbox-runtime`
- **spike**：连上 `Everything` server、列出 tools、调一次。100 行。
- 装 `npx @modelcontextprotocol/inspector --tui`
- **monorepo 骨架**：`packages/kernel`（无 Electron 依赖，lint 强制）、`packages/contracts`（IPC / 桥协议的 schema）、`apps/desktop`；`apps/server` 目录先建空壳占位
- **`HostAdapter` 接口**先定：`fs`、`secrets`、`process`（spawn / kill / 进程树，stdio MCP server 和沙箱包装的命令都走它）、`sandbox`（`wrapArgv` 由 host 侧调用 sandbox-runtime，kernel 只拿到 argv + env）、`confirm`（用户确认）、`clock`。desktop 实现第一个
- 所有存储 key 从第一天带 `tenantId`；本地 profile = `(userId, tenantId)` 目录
- Electron + Vite + React + TS 起项目；shadcn/ui（Base UI）+ assistant-ui 照 Claude 示例搭界面，**样式全走令牌**
- 接一个模型 API，流式对话，Streamdown 渲染
- **读**：Cherry Studio `CLAUDE.md`（1 天）
- **验收**：Everything server 列出 tools 并调用成功；`packages/kernel` 的 `no-restricted-imports` 能拦住 `import 'electron'`；流式对话跑通；CI 绿且 secret scanning 生效

### 阶段 1：Provider 抽象 + 会话存储（1–2 周）

**这两个是"改错了要重写一大片"的地方，先定。**

- 按 §4.8.3 实现 Provider 接口：`stream` 必需、`complete` 默认、`ModelInfo` 表、`ConfigKey` 驱动 setup UI
- 按 §4.8.4 定消息数据模型：append-only Tape + `provenance_key` 幂等 + 同事务投影表；压缩用 `anchor` 事实（不用 `visibleTo`）；工具调用身份 `(runId, requestSeq, providerToolCallId)`、`requestSeq`/`physicalAttempt` 分离；所有键带 `tenantId`
- 接第二个 provider（比如 Ollama）验证抽象
- **读**：[goose-mechanisms](../reference/goose-mechanisms.md) §一、[deepchat-mechanisms](../reference/deepchat-mechanisms.md) §二
- **开工前裁决**（2026-09-17 五题覆盖审阅的结论；机制层已有 deepchat 笔记 §二，缺的是 Tenon 自己的决定）：
  - 执行日志（Execution Journal）排阶段 2 还是 4——deepchat 笔记说等阶段 4，但阶段 2 已有真实写文件与 `HostProcess.kill`；无论排哪，阶段 1 的 entry 模型先预留 kind 与命名空间
  - 是否现在就留 `prev_hash` / `entry_hash` 列：6b 的签名链要证明更早的历史未被改，不留则补不上
  - 删除 / 保留期 / 无痕模式在 append-only 下的语义：物理删、分区删还是 tombstone；retention days 与 legal hold 列是否第一天进 schema
  - 本地主键形状（`tenant_id` 恒定时是否仍作前缀），以及「同一套 DDL 本地 SQLite 与服务端库通用」是否为真——阶段 1 就验证，不留到 6b
  - 阶段 4 反推的字段现在进 entry 模型：副作用分类（读 / 写 / 外呼 / 拦截）、`runId` 归组、快照号；否则「任务小结由 Tape 投影、不另存」做不到
  - 分支 / 编辑重发是同 session 的 fork entry 还是新 session，决定 `Session ↔ Tape 一一对应` 是否成立
  - `packages/contracts/bridge/` 的帧类型骨架此时定：AGENTS.md 规定桥只走 contracts，空到 6b 等于把一个公开契约推到最后
  - 补读半天：DeepChat `docs/architecture/tape-system.md` 的 ViewManifest 字段与产生时机、`reservedNamespaces.ts` 规则、`entry_id` 分配与并发写策略，以增补写回 deepchat 笔记 §二，不新建笔记
  - **裁决结果**（2026-09-17）：八条逐条写在 [01-provider-and-tape/spec.md](01-provider-and-tape/spec.md) 的「开工前裁决」一节；补读已写回 deepchat 笔记 §二之补
- **验收**：第二个 provider 不改任何调用方代码即可接入；从 Tape 重放能重建 provider 上下文且与投影表一致；换 profile 后另一个 profile 的数据不可见

### 阶段 2：Agent loop（2–3 周）

- 按 §4.8.1 实现主循环
- 上下文管理：先只做 D（大响应落盘）和 B（摘要 + 锚点），A/C 后补
- **权限引擎**：`approvalBroker`（照 DeepChat）+ 等待模型用 **"写进 transcript、Run 暂停、回答后新 Run"**（不用内存 `Map<id, Promise>`——服务端 host 的会话沙箱可能被回收，内存等待失效）+ 决策顺序见 02 §权限决策顺序（2026-09-25 改，见 [02 §权限决策顺序](02-agent-loop/spec.md)） + `Inspector` 接口（为 railguard 等留位）
- **审批原因码**（2026-09-17 补）：权限引擎只输出 `ConfirmRequest`：原因码、事实槽位、可逆性、对象（形状见 02 §对 00-foundation 的修补）；界面据此渲染，kernel 不产生句子。决策表各层留在内核，界面不露层号；「撤不回」从此取自可逆性，不取自原因码（2026-09-25 改，见 [02 §对 00-foundation 的修补](02-agent-loop/spec.md)）
- **停止即杀**（2026-09-17 补）：用户点停止，正在跑的命令经 `ChildHandle.kill`（2026-09-25 改，见 [02 §点停止时各状态怎么收](02-agent-loop/spec.md)）结束整棵进程树，不等它跑完（Claude 实测命令会继续跑完）；任务小结写「已停，后续写入未发生」
- **提示层**（2026-09-17 补，明确交付物）：(1) 对话 / 任务两个 profile 各一份系统提示，从 Anthropic 公开发布的 claude.ai 系统提示与 Claude Code 文档学，不抄原文；(2) 工具集形状贴 Claude Code——读 / 写 / 编辑 / 命令 / 查找 / 子 agent，名字与参数语义一致（模型对这套形状有先验），其余能力走 MCP；WebFetch 例外：只收 url，返回整页 Markdown，不带 prompt，差异写进工具描述（2026-09-25 改，见 [02 §内置工具与工具来源](02-agent-loop/spec.md)）；(3) 扩展思考、提示缓存直接用 API 功能，不自造；网络搜索、网页抓取做成 Tenon 的客户端工具，后端调各家官方接口；服务端代码执行推后（2026-09-25 改，见 [02 §搜索与抓取](02-agent-loop/spec.md)）；(4) 对照组改为用户机器上的 Claude Desktop 本身：同一题两边跑、录屏对比、差在哪改哪（OpenCode 降为第二对照）；同模型列用 Claude Code + GLM；OpenCode 仍是第二对照，作为同模型列的备选（2026-09-25 改，见 [02 §同题对比](02-agent-loop/spec.md)）；(5) 固定 20–30 个任务的评测集，改系统提示或工具描述必跑，结果记 `docs/evals/`；提示层包括 kernel 写给模型的固定英文（收口说明、续写提示、落盘说明等）；评测基线建立之前版本号照常递增、不要求跑评测（2026-09-25 改，见 [02 §提示层与评测](02-agent-loop/spec.md)）
- **读**：DeepChat `src/main/tool/`（`ToolPermissionBroker`）、`docs/architecture/tool-system.md`、Cline `auto-approve.mdx` + `sdk/`、OpenCode agent loop
- **对照组**：主对照是 Claude Desktop；同模型列是 Claude Code + glm-5.3 对 Tenon + glm-5.3；OpenCode 作同模型列的备选（2026-09-25 改，见 [02 §同题对比](02-agent-loop/spec.md)；2026-10-15 补：主对照的 Claude Desktop 一列暂时不能按原协议复现，2026-10-01 的 B 列只作参考，见 §7「为什么选 A」末尾的「2026-10-15 补」与 [evals README](../evals/README.md)）
- **开工前裁决**（2026-09-17 审阅结论；DeepChat broker 与 Goose 四层已有逐路径笔记，不需要新笔记，需要的是拍板）：
  - 严格度定位：工具级「以后都允许」第一版有没有、存哪、怎么撤销。§4.11 第 3 行说有（键 `tenantId / serverId / toolName`），UX 画布 v18 与 parity 审计 09-16 补记说审批只「本次会话内有效」、「以后都允许」只出现在文件夹与连接器授权弹窗——两者必须合成一份
  - 可逆性判定规则：输入是什么（内置工具白名单 / host 判定 / MCP 注解按硬规则不可信），未知 MCP 工具默认哪档；UX 四档刻度（可撤销 / 有快照 / 不可逆 / 未知）到 `ConfirmReason` 的映射，阶段 2 尚无快照时「有快照」档怎么显示
  - blocked 是「从发给模型的工具列表过滤掉」还是「调用前拦截」，及其对提示缓存与 Tape 记录的影响。已由 E2 裁决：按会话与 provider 冻结，冻结后调用时拦（2026-09-25 改，见 [02 §工具目录与冻结](02-agent-loop/spec.md)）
  - §4.13 的四级查找顺序（租户策略 → 用户默认 → 会话 → 单次）与 §4.11 六层表对账成一份，避免实现出两套作用域
  - 租户策略在接口上的落座点：`HostAdapter` 的新成员、kernel 侧 store 由桥喂、还是 contracts 里的 schema。`HostAdapter` 已在阶段 0 冻结：只增成员按 spec-driven-dev 的 amend 规则修补（阶段 1 的 `network` 是先例），改动既有成员须 supersede
  - 第 1 层真值表：策略 allow 撞用户 Never、策略 deny 撞用户 Allow always、个人租户第 1 层是否求值。表行 1「不可放宽到低于用户设定」、表行 2「只有租户策略或用户显式 Allow always 能放开」与总结句「策略与用户可放宽」目前三者打架
  - 策略拒绝需要的 `ConfirmReason` 新值与 facts 键（policyId 等）回填阶段 0 spec 的必填键表
  - Inspector 接口形状与合议规则（多个 inspector 冲突取最严还是按 confidence）、超时与抛错是否 fail-closed；LLM 判官是否在本阶段交付
  - 拒绝路径：回给模型的 tool result 形状、能否换参重试、连续拒绝是否计入 no-progress guard；判决 trace 的内部形状（验收要求每行一个测试，但界面不露层号）
  - 补读各半页并入上面的「读」：Cline `requires_approval` 实际怎么传；OpenCode 的审批路径（§15.1 #1 至今无核实路径）
  - **裁决结果**（2026-09-25）：逐条见 02 §开工前裁决（2026-09-25 改，见 [02 §开工前裁决](02-agent-loop/spec.md)）
- **验收**：cancel 后无 orphaned tool_use（下一轮请求不 400）；`ContextLengthExceeded` 压缩重试 ≤ 2；no-progress guard 在 4 次相同 batch 后终止；权限弹窗在应用重启后仍在且可回答；决策顺序表的每一行有一个测试；每个 `ConfirmReason` 在 zh-CN 与 en 下各有一条文案且槽位齐全；点停止后 1 秒内无子进程存活；评测集每题有基线记录；与 Claude Desktop 同题对比至少 10 题有记录（差异与原因）（2026-10-15 补：2026-10-01 那 10 题里 Claude Desktop 一列改为只作参考、不算验收证据，新协议另定，见 [evals README](../evals/README.md)；本节与 02 不因此改写）
- **范围调整**：最小工具行、审批卡、任务形态、文件夹 chip 已挪进 02，阶段 3 / 4 的对应项改做完整版，工期不动（2026-09-25 改，见 [02 §界面范围](02-agent-loop/spec.md)）；阶段 2、3 只开手动档，见 [02 §可逆性判定与阶段 2 的默认权限姿态](02-agent-loop/spec.md)；工作区来源见 [02 §会话形态、工作区与模型选择](02-agent-loop/spec.md)

### 阶段 3：MCP host 完整版（2–3 周）

- MCP 设置界面、OAuth（CIMD 优先、DCR 兜底、凭证按 issuer 分键进 keychain）、工具调用卡片、权限确认弹窗（完整版；最小版在阶段 2）（2026-09-25 改，见 [02 §界面范围](02-agent-loop/spec.md)）。阶段 3 只做 MCP 相关的部分：审批卡的可逆性刻度、连接器卡的 server 名与「定义已变」；带样式的改动预览挪阶段 4（2026-10-08 改，见 [03 §界面](03-mcp-host/spec.md)）
- 扩展配置 schema：显式 `type`、`envs`/`env_keys` 分离、`available_tools` 白名单。不用白名单语义：三态逐个记在 server 条目下，`available_tools` 只在导入、导出配置时与「永不」互转，阶段 3 没有导入导出、不做（2026-10-08 改，见 [03 §配置与机密](03-mcp-host/spec.md)）
- stdio 子进程管理：spawn → 握手超时 → 崩溃重连 → stderr 落日志 → 进程树清理 → **超时向 server 发 cancelled**（2026-10-15 补：03 §协议代际 定的「stdio 不探测」写着「与 Claude Code 的默认相同」，这半句已过期——Claude Code 的 MCP 文档现写它默认向 stdio server 询问 2026-07-28 版本，更新日志写明 2.1.292（2026-10-06）起所有安装的本地 stdio 连接默认协商，对不理会探测的 server 一次慢连接之后记 7 天、改走旧握手（[MCP 文档](https://code.claude.com/docs/en/mcp)、[changelog](https://code.claude.com/docs/en/changelog)）。Tenon 不探测的决定不变，依据只剩 03 写的技术原因（`ChildStdioTransport` 没有 `stderr`、`pid`，开 `auto` 会在正式进程上原地探测）；03 正文不改，Q2-B 的改判条件「主流 stdio server 只说新代时重评」照旧；下一份碰 MCP 的 spec 起草时引这一条）
- **读**：[deepchat-mechanisms](../reference/deepchat-mechanisms.md) §四、LibreChat `packages/api/src/mcp/`（OAuth 落地）
- **开工前裁决**：02 留下两条（2026-09-25 改，见 [02 §开工前裁决](02-agent-loop/spec.md)）。**裁决结果**（2026-10-08）：逐条见 [03 §裁决索引](03-mcp-host/spec.md)——中途工具维持 E2-C（Q15 A）；连接器卡先按 02 上线，同题对比超过 2 倍才加「本会话允许」（Q13 A）。原列的两条：
  - 中途连上的 MCP 工具是否即时生效：支持的 Anthropic 模型用 E2-D，其余用 E2-F，或仍到下个会话（裁决 E2）
  - 连接器卡要不要加「以后都允许」（D1-A2）或「本会话允许」，按同题对比的确认次数定（裁决 D1、D10）
- **验收**：Everything server 的每类能力（tools / prompts / resources / listChanged）各一个 e2e，tools 的 listChanged 用自写夹具；sampling 已在 2026-07-28 弃用、elicitation 照 02 的 H6 在阶段 3 之后，都不做（2026-10-08 改，见 [03 §验收标准](03-mcp-host/spec.md)）；超时后 server 侧能观测到 `notifications/cancelled`；子进程崩溃后状态正确且 stderr 进错误对象；OAuth `iss` 不匹配时拒绝兑换 code；工具名按 02 的命名规则稳定（以 `{server}__{tool}` 为基础，非法字符替换，超长截断并加哈希后缀；替换过的名字也加后缀），映射表进 Tape（2026-09-25 改，见 [02 §工具来源、命名与权限键](02-agent-loop/spec.md)）

### 阶段 4：沙箱 + 文件桥（拆为 4a–4d：4a 2–3 周、4b 约 2 周、4c 与 4d 各 1–2 周，是起草人的估计、没有出处，以 04 标 implemented 时的检查点为准；2026-10-09 改，原为「1–2 周」）

- `sandbox-runtime` 包住 Bash 起的命令（`wrapWithSandboxArgv` + `spawn`）；MCP stdio server 暂不入沙箱，上游发布按命令网络白名单后另立，03 写的「按工作区拆进程」不做；档位 = 只读 / 工作区可写两种 config + 不包装，默认工作区可写、只读放在设置「高级」里，不设常驻「完全访问」，越出沙箱只由用户从拦截回执一次性放行；**网络默认关闭**（2026-10-09 改，见 [04 §包装契约](04-sandbox/spec.md)；原为「包住所有子进程（`wrapWithSandboxArgv` + `spawn`，MCP stdio server 整体入沙箱）；UI 三档 = 两种 config + 一个 bypass」）
- 三个预编译 helper（`apply-seccomp` / `srt-win.exe` / `srt-proxy-agent.jar`）放 asar 外与签名归阶段 7 的打包，4a 只在开发构建里验收、用 config 指 node_modules 里的绝对路径（2026-10-09 改，见 [04 §依赖](04-sandbox/spec.md)；原为「放 asar 外，用 config 指绝对路径」）；启动 `checkDependenciesAsync()` 把缺依赖告诉用户（Linux 含 userns sysctl）
- 违规回传：`SandboxViolationStore.subscribe()` 推 UI，`annotateStderrWithSandboxFailures` 把 `<sandbox_violations>` 喂给模型，`deniedDomainReasons` 写给模型看的替代方案
- 文件桥：路径归属校验（symlink / `..` 归一化）、宿主↔沙箱双向映射、**mtime 守卫**（2026-10-09 补，见 [04](04-sandbox/spec.md) Q2 A：宿主↔沙箱双向映射挪阶段 6b，其余随 05）
- 读/写/删/执行拆成独立可授予单位；删除运行期单独申请
- **任务模式成型**（2026-09-17 补；2026-10-09 改，见 [04](04-sandbox/spec.md) T37、Q2：原写「对齐 Cowork 本地模式」；Pro / Max 的新 Cowork 任务自 2026-10-06 起在云端运行，已进合并体验的账号任务只在云端（[15811196](https://support.claude.com/en/articles/15811196-what-to-expect-with-claude-cowork-in-the-cloud)），Team / Enterprise 仍有本地 VM 会话（2026-10-15 照公开文档改准，[15520349](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)、[13455879](https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans)），执行与隔离改为对照 Claude Desktop 的 Code 会话与 Claude Code；原写的「右面板 进度 / 产物 / 上下文」挪阶段 5，与 §8.5 和 components.md 一致）：任务会话 = 工作文件夹 + 沙箱 `workspace-write` 档 + 内联审批卡；主栏折叠头 + 活动时间线；界面以 UX 画布 v18 与 `docs/ux/parity-audit-2026-09-12.md` 为准，随 4d（`docs/features/task-mode-ui`）。定时任务与 Projects 页仍在阶段 6
- **快照与一键还原**（Tenon 自有）：每次写入 / 删除前对受影响文件留快照，按 `runId` 归组，放 profile 目录（带 `tenantId`）；审批卡与任务小结显示「可还原」；还原是一次操作，冲突（文件在还原前又被改过）时逐文件提示
- **任务小结**（Tenon 自有）：任务结束一行「读了 n · 写了 n · 发出 n · 可还原」，由 Tape 投影得出，不另存；「查看本次记录」按需打开
- **读**：[sandbox-runtime-mechanisms](../reference/sandbox-runtime-mechanisms.md) §三、DeepChat `src/main/tool/agentTools/agentFileSystemHandler.ts`（`validatePath` / `resolveValidatedCreatePath`）与 `src/main/agent/acp/runtime/acpPathGuard.ts`（2026-10-09 改，见 [04](04-sandbox/spec.md) T3；原为「`src/main/file/`（adapters / validation.ts / mime）、`src/main/workspace/directoryReader.ts`」，validation.ts 管的是文件类型、不是路径）
- **开工前裁决**（2026-09-17 审阅结论；sandbox-runtime 笔记是全仓最扎实的一份，不需要新笔记）。**裁决结果**（2026-10-09）：4a 承担的逐条见 [04 §裁决索引](04-sandbox/spec.md)，下列各条与 02 的七条落在哪份见 04 §主参考与 02 留下的各条的去向。阶段 4 拆成 4a = [04-sandbox](04-sandbox/spec.md)（沙箱与出网）、4b = 05-file-bridge（文件桥、快照与小结）、4c = 06-approval-modes（审批档位）、4d = `docs/features/task-mode-ui`（任务模式界面），按 4a → 4b → 4c → 4d 写、各自验收，4b–4d 的裁决已定、在 04 标 implemented 之后起草；spec 编号从此与阶段号脱钩（阶段 5 的 spec 取 07）。预算合计不超过阶段 3 的 3 倍；检查点：04 标 implemented 时验收条数或改动行数超过阶段 3 的 1.5 倍，就在起草 05 之前按「4d 挪阶段 6 打磨 → 快照只管文件工具 → macOS 那半本机跑 → 阶段 4 不开自动档」的顺序砍。原列的：
  - 沙箱档位与网络是一个枚举还是两个轴：`SandboxRequest.profile` 只有三档没有网络字段，而 UX 要「档位 / 网络 / 跑完自动降回」三件事；若改 `SandboxRequest`：只增字段按 amend 规则修补 00-foundation，改既有字段须 supersede
  - 沙箱不可用时的降级阶梯（Linux 缺 bwrap / socat、userns 被关、Windows 未提权、平台不支持）：抛错、直通加告警、还是拒绝执行任何工具；fail-closed 的边界
  - 「跑完自动降回」的确切时机与对象；Tenon 自己的 profileDir（含 Tape 与密钥引用）必须进 denyRead
  - 长驻 MCP stdio server 的档位与换工作区时的生命周期（FS 规则不热更新）；「仅包管理器」预设的域名表
  - 快照与一键还原单独立题：staging 目录 / 整目录预快照 / git 三选一——它反过来决定 workspace-write 的 allowWrite 指向工作区还是 staging
  - 补查 sandbox-runtime 三点，以 Revisions 追加进现有笔记：`customConfig` 在 macOS / Linux 能否放宽 FS、模块级单例下多工作区并发的实际行为、三个 helper 的 arch 覆盖矩阵
  - 02 留下的七条（2026-09-25 改，见 [02 §开工前裁决](02-agent-loop/spec.md)）：
    - ① 自动档随快照和规则 inspector 开放，判为不安全时按 D6、F5 处理；规则 inspector 与 railguard 适配随自动档交付，LLM 判官单独立题（裁决 D7、E6、D6、F5）
    - ② 跳过档做不做：做，就只在本会话沙箱生效时可选、由内核或主进程强制，并入上面「沙箱不可用时的降级阶梯」；不做，就带日期删去 parity-audit:39、:230 和 components.md `ApprovalModeMenu` 行的跳过项（裁决 D6、E6）
    - ③ 只读命令免问（裁决 E4）
    - ④ 有快照后，被覆盖的删除（含命令里的 rm）还算不算不可逆、还问不问（裁决 D10、E6）
    - ⑤ 工作区内写入免问之前先挡硬链接：`HostFs.stat` 只增 nlink、大于 1 按工作区外处理，或 host 改用「临时文件加改名」（裁决 D8）
    - ⑥ 出网收口到位后，WebFetch 的地址判定并入 host 的统一收口（裁决 H8、D7）
    - ⑦ 沙箱能判联网与越界后，命令的主原因是否仍固定为 `command`，多个原因按 D5 排（裁决 E1、E4）
- **验收**：Tenon 自己的沙箱黑盒用例（照上游测试的断言思路：工作区外写、符号链接逃逸、保护文件、直连 IP、白名单外域名、停止后无残留进程）在 macOS 与 Linux CI 上全过（2026-10-09 改，见 [04 §验收标准](04-sandbox/spec.md)；原为「sandbox-runtime 的 `test/sandbox/*.test.ts` 逃逸测试集在我们的集成层上全过」：npm 包不带测试，上游测试直接 import 源码内部模块，测不到 Tenon 的接法）；端到端：选文件夹 → 发一个会写文件的任务 → 审批一次写入 → 完成并看到小结 → 点还原后文件内容与 mtime 回到任务前，`git status` 干净（这一句归 4b，05）

### 阶段 5：扩展层 + MCP Apps + Artifacts（4–6 周）

- **Customize 页**六个 tab 与扩展层的存储 / 开关模型（§4.12）：组件级开关、三层优先级、租户作用域
- Skills：三级渐进加载、目录 / ZIP / URL 安装、与 Claude Code 互导（学 DeepChat `src/main/skill/`）
- Plugins + marketplace：`plugin.json` / `.mcp.json` 解析、Git 仓库当市场、sha256 校验、按角色声明的连接器绑定
- Connectors 目录：目录 ID 绑定、三档标签；远程 OAuth 复用阶段 3（2026-10-08 改，见 [03 §远程 server 与 OAuth](03-mcp-host/spec.md)；原为「Connectors 目录 + 远程 OAuth：……CIMD 优先 / DCR 兜底、`iss` 校验、按 issuer 分键」）
- .mcpb：`user_config` → 表单 → keychain → 模板插值；**运行时分发**（学 Cherry `BinaryManager` 或 DeepChat `toolchains/`）
- Artifacts：自建 iframe 先支持 HTML/SVG
- MCP Apps：sandboxed iframe + CSP（学 DeepChat `src/main/mcp/apps/`，主 renderer 开 `sandbox: true`）
- `examples/plugins/` 两三个样例插件
- **读**：[claude-desktop-feature-map](../reference/claude-desktop-feature-map.md) §06、mcpb `src/index.ts` + `MANIFEST.md` + `schemas/`、knowledge-work-plugins 的包结构、ext-apps `basic-host`、assistant-ui Artifacts 示例
- **验收**：从一个私有 Git 仓库装上一个含 skill + 连接器声明的插件，把 `~~chat` 绑到飞书，skill 被语义触发并调用连接器；单独禁用该插件里的一个 skill 后不再触发

### 阶段 6：聊天体验打磨（持续）

- §10 清单逐条
- 会话列表、编辑重发、分支
- 记忆、知识库按 §6.3 简化版；本地版定时任务；Projects 页
- **Research（深度检索）**（2026-09-17 补；此前 parity 审计误归为「不做」，并非 owner 决定）：编排者 + 并行子 agent + 引用后置，架构照 Anthropic 公开的多 agent 检索系统文章（orchestrator-worker、子 agent 各自独立上下文、按题目复杂度定并行度与预算、引用由单独一步补），内部提示词不公开，自己写；数据源 = 网络搜索 + 已授权连接器；UI 照 `docs/ux/parity-audit-2026-09-12.md` 的「深度检索卡 / 检索面板」四行与录屏 02；前置：阶段 2 子 agent 契约与提示层、阶段 5 连接器与右面板；成本约为普通对话十倍以上，必须提示缓存 + 单次预算上限
- **读**：§9 拆解方法、§10 打磨清单
- **验收**：§10 清单逐项打钩；键盘可达性与 reduced-motion 降级通过检查；空 / 加载 / 错误态每个界面各有截图对照；一个需要 5 次以上检索的问题得到带引用的报告，来源面板可下钻到正文上标；中途停止保留已收集的来源与部分报告

### 阶段 6b：云端 host 与多租户（对齐 Cowork 云端模式；周期待定，至少 4–6 周）

- `apps/server`：账号 / 组织 / 成员关系；每会话一个租户隔离沙箱跑 `packages/kernel`；Tape 走服务端数据库（同 schema，`tenant_id` 行级隔离）
- **桥协议**：桌面 App ↔ 服务端长连接；服务端对本机文件的读写经桥、经用户授权、受路径归属校验
- 管理员策略下发 → 本地权限查找顺序的"租户策略"层生效
- 云端沙箱选型（容器 vs microVM）在此阶段定，依据是租户隔离强度和单会话成本
- **读**：§4.13 参考表（OpenHands SDK、Managed Agents self-hosted sandbox 文档、LibreChat 访问控制、better-auth organization）
- **开工前裁决**（2026-09-17 审阅结论；本阶段四个参照全部停留在链接与一句话，证据等级最低）：
  - 先补两份机制笔记，按 goose / deepchat / sandbox-runtime 三份的标准（clone 到具体 commit、逐路径核实、写清文件名与签名）：`docs/reference/openhands-agent-server-mechanisms.md`（`BaseWorkspace` 三实现、agent_server 的端点与事件形状、Agent 规格序列化、EventLog + `base_state.json` 恢复流程）；`docs/reference/tenancy-and-acl-mechanisms.md`（better-auth organization 的表与活跃组织在 session 里的表达、LibreChat ACL 的真实表结构与 principal 解析、Dify tenants 只读对照，并给出服务端数据库选型与 RLS vs 查询层过滤的结论）
  - 桥协议传输选型（出站长轮询 / WebSocket / REST + WS）、断线续传、至少一次 vs 恰好一次、`provenance_key` 是否跨桥延伸
  - 租户策略层零参照、需自研（LibreChat 无租户隔离、better-auth 只给身份、Dify 一行不抄）：策略文档 schema（扁平 MDM 键 vs 规则列表）、server 标识（目录 ID / 命令 / URL）、下发协议（推拉、版本号、回滚）、缓存 TTL 与离线 fail-open / fail-closed、本地缓存防篡改、会话中途变更与租户切换的行为、策略对沙箱档位与网络白名单的钳制点、§4.12 安装优先级与 §4.11 调用优先级的分工、策略挂 org 还是 team、策略拒绝进 Tape 的形状
  - 服务端会话生命周期：每会话一进程还是热池、空闲回收阈值、回收后从 Tape 恢复的流程、每租户并发上限与计量
  - 桥的安全模型：文件夹授权粒度与撤销、worker 凭据与轮转、多设备派发与吊销；「桌面 worker 离线」的具体语义（超时、Run 暂停还是报错、重连是否补跑）
  - 本地 → 云端迁移的过程（导出格式、冲突规则、既有 profile 能否挂到已有租户）
  - 云端沙箱选型（容器 / microVM / 托管）是几周的评估工作不是 spec 篇幅，计入工期；开工时只能写成「开放问题 + 什么时候依据什么能定」
- **验收**：同一份 `packages/kernel` 在 desktop 和 server 两个 host 上跑通同一组 e2e；跨租户读不到任何数据的测试作为硬门禁；桌面 worker 离线时云端会话的本地工具调用有明确的失败语义

### 阶段 7：决定做产品时

- 替换视觉令牌、字体、Logo
- 重新审视依赖许可证（尤其确认没复制 AGPL 代码）
- 计费、SSO、审计日志、国内合规（模型境内、数据不出境）
- computer use、Record a skill 放在此阶段之后评估
- 许可证、CLA、开源核心边界与商业模式方向已在 [ADR-002](../adr/adr-002-license-and-business-model.md) 定（2026-09-17）：Apache-2.0 永久开源核心，付费层放 `ee/` 或独立仓库，收费面是团队 / 企业服务端；本阶段只定定价、商标、计费与合规
- **验收**：许可证扫描无 AGPL / 专有代码；令牌值全部替换；三平台签名与公证通过

## 14. 许可证速查

| 项目 | 许可证 | 档位 |
|---|---|---|
| DeepChat、Goose、sandbox-runtime、Jan、AionUi、Codex CLI、Streamdown、AI Elements、MCP-UI | Apache-2.0 | 🟢 |
| LibreChat、assistant-ui、shadcn/ui、lobe-ui、OpenCode、Hermes Agent、AnythingLLM、Cline、MCP SDK / mcpb / ext-apps / inspector | MIT（MCP SDK v2 自 2.3.0 起 Apache-2.0，2026-10-08 改，见 [03 §SDK 升级](03-mcp-host/spec.md)） | 🟢 |
| OpenWork | 主体 MIT；`/ee` 企业版 | 🟢 / 🔴 |
| Open Claude Cowork | MIT（依赖 Claude Agent SDK 🔴） | 🟢 |
| anthropics/skills 示例 | 多数 Apache-2.0 ✅ | 🟢 |
| **Cherry Studio、Witsy** | **AGPL-3.0** | 🟡 只读学习 |
| Zed | GPL-3.0-or-later | 🟡 文档可读 |
| LobeHub | Community License | 🔴 衍生商业分发需授权 |
| anthropics/skills 文档类（docx/pdf/pptx/xlsx） | 专有 ✅ | 🔴 |
| Claude Agent SDK | 商业条款 | 🔴 按条款 |
| 泄露的 Claude Code 源码 | 无授权 | 🔴 不要用 |

**Cherry Studio 社区版对组织使用有额外商业授权要求** ⚠️。

---
---

# 15. 本版审查：遗留问题与未核实项

合并时逐节审查，以下是**仍未核实**的（已解决项划掉保留，便于追溯）：

### 15.1 事实层面

| # | 项 | 状况 |
|---|---|---|
| 1 | **OpenCode 的具体路径** | 第三版和本版都只写"仓库内搜索"，**没有验证过的文件路径**。阶段 2 读它之前要先 clone 看结构 |
| 2 | **LibreChat 被 ClickHouse 收购** | ⚠️ 二手，未在 LibreChat 官方仓库或 ClickHouse 公告确认 |
| 3 | **Cherry Studio V2 何时发布** | 未知。现在读 main 会同时看到 v1/v2 两套代码 |
| 4 | ~~DeepChat 的 `src/main/**` 路径~~ | **已解决**（2026-09-11）：clone commit `4443587` 逐路径核实，见 [deepchat-mechanisms](../reference/deepchat-mechanisms.md)。注意该仓库只有 1 个 squash commit，无 git 历史 |
| 5 | ~~sandbox-runtime GitHub release 页 vs npm~~ | **已解决**：clone 的 main 是 v0.0.76（2026-09-10，PR #528 release 分支合并），npm 同步。新发现：源码检出里 `vendor/seccomp/` 等只有 `build.ts`，预编译 helper 只在 npm 包里 |
| 6 | **Goose `augment_message_with_tool_calls()` 调用点** | 未查到在 agent 循环还是 provider 的 stream 里 |
| 7 | **Goose `Conversation` 类型文件** | import 路径 `crate::conversation::{...}`，但 `conversation.rs` 和 `conversation/mod.rs` 都 404 |
| 8 | **Goose MCP 子进程崩溃后是否自动重启** | 未查到证据，看起来是报错保持不可用 |
| 9 | **国内产品**（通义桌面 MCP、AutoClaw、GLM-PC、Kimi Work 价格） | ⚠️ 全部二手 |
| 10 | **LM Studio 商用授权** | 未核实 |
| 11 | **Windows Copilot MCP 细节** | ⚠️ 沿用旧版信息 |

### 15.2 设计层面的开放问题

| # | 问题 | 现状 |
|---|---|---|
| 1 | **确定性门禁（hooks / 测试）在强模型上的边际价值** | 没有任何对照实验。诊断数据支持"长任务失败 72.5% 是 process-level 跑偏"，但唯一测过的干预（plan-first prompt）结论是无效。**这是整个领域的空白，也是你的 agent loop 设计里最没有依据的一块** |
| 2 | **上下文压缩的语义相关性判定** | Goose 是纯位置性的。有没有更好的方案，没有可靠参照 |
| 3 | **MCP Apps 的 sandboxed iframe 安全模型** | 有了参照：DeepChat 的自定义 `mcp-app://` scheme + CSP 头 + 双层 iframe + 代理页跨源自检（`src/main/mcp/apps/`）。但它主 renderer `sandbox: false`，**我们要开 `sandbox: true`**。仍无 Electron 官方指南，方案是社区实践 |
| 4 | **Provider 抽象在 TS 下的具体形状** | Goose 是 Rust trait，TS 里"带默认实现的可选方法"怎么表达（abstract class？mixin？）要自己定 |
| 5 | **本地模型的 tool calling** | ToolShim 是"用模型修模型"。国内模型（通义、DeepSeek）的 function calling 支持度未调研 |

### 15.2b 源码拆解后新增的待办（2026-09-11）

| # | 项 | 状况 |
|---|---|---|
| 1 | **`sandbox-exec` deprecated** | sandbox-runtime 仓库内无任何应对或版本探测。Apple 标记多年仍可用，Claude Code 也在用，但要盯 |
| 2 | **Ubuntu 24.04 AppArmor userns 限制** | 需 `sysctl kernel.apparmor_restrict_unprivileged_userns=0`，安装引导要处理 |
| 3 | **Windows 沙箱侵入性** | 要建本机账户 + WFP 过滤器 + NTFS ACE，alpha。产品上要给"不装沙箱"的降级 |
| 4 | **权限严格度定位** | DeepChat 每次问且不持久化、Goose 默认全自动。建议取中间：默认问 + 按 `(server, tool)` 的 Allow always + 不信 `readOnlyHint`。这是产品决策，阶段 2 前定 |
| 5 | **云端沙箱选型** | 租户之间跑模型写的代码，进程级沙箱不够。容器（sandbox-runtime 在容器内再包一层）vs microVM（Firecracker / microsandbox）vs 托管（E2B）。阶段 6b 定，现在只保证 `HostAdapter.sandbox` 接口不假设本地 |
| 6 | **桥协议的安全模型** | 有了官方参照：Managed Agents self-hosted sandbox 的出站轮询 worker（见 §4.13 参考表）。仍要自己定的：桌面 worker 的授权粒度（按文件夹）、路径归属校验、离线行为、worker 内再套 sandbox-runtime |
| 7 | **Provider 抽象路线** | Goose 手写 7 家 wire format；DeepChat 外包给 Vercel AI SDK（9 种 kind 注册 56 个 provider）。TS 项目更接近后者，但要核实 AI SDK 对 thinking 签名 / cache_control 的支持边界——这是 §15.2 表中 Provider 抽象一条的具体化 |

### 15.3 有意省略的

早期版本的 Windows Copilot 细节、重复的"按功能模块找参考"表、5ire / HyperChat / Witsy 的详细段落（已并入 §3 一行）。

---
---

> 下篇是 2026-09 的市场分析，供参考。上篇的技术选择由学习与工程目标决定，不以下篇的商业建议为准。

# 下篇：AI 桌面客户端 / MCP Host 全景对比

另记（2026-10-22 挪到仓库外的私有笔记：这一篇是 2026-09 的市场分析，按「公开与私有的边界」不放公开仓库）。

---

*第四版 rev2，2026-09-11：并入 DeepChat 与 sandbox-runtime 源码拆解结论。*
*第四版 rev3，2026-09-12：项目定名 Tenon；整体审查后修 40 余处（矛盾、过时事实、悬空引用、个人语境）；补齐各阶段验收标准；定权限决策顺序表、等待模型、锚点压缩、HostAdapter.process；§15 移至上篇末；已定决策新增质量目标 / 仓库 / 分工 / 开发流程 / 多租户 / 内核壳分离；新增 §4.12 扩展层、§4.13 多租户与云端 host（含参考表）、§8.5 UX 最终形态、§13 仓库与发布规范、阶段 6b；railguard 边界（§4.11 ⑥、§4.12）；路线 A 依据改写为以质量目标为准。*


# 总参考（sdd）

## 目标和不做

给谁用：想要一个开源、可自己掌控的 Claude Desktop 式桌面工作台的人（owner 2026-10-22，见 ADR-004）。
解决什么：桌面 agent 工作台；指向一个文件夹，agent 在其中读取、编辑文件和运行命令，变更先请用户批准，以八层权限判定决定是否执行，每步追加到可在崩溃、重启后恢复的会话 Tape。
永远不做：
- 不改成 AGPL 或 source-available（ADR-002 决策 1）。
- 不用 AGPL 或专有来源的代码（AGENTS.md 硬规矩）。
- 逆向得来的标识符不进仓库（源码门禁）。
- 不做桌面端订阅、广告、模型 token 转售（ADR-002 决策 5）。
- 沙箱和联网搜索不自研（本文件「6.3 直接用现成」）。

## 阶段表

本表摘自 [§13 分阶段路线](#13-分阶段路线按路线-a)；4b 以后尚无 spec 的行保留规划状态，起草时再登记目录及 Status。

| 阶段 | 目录 | 一句话 | 状态 | 关键决策 |
|---|---|---|---|---|
| 0 | [00-foundation](00-foundation/spec.md) | 仓库地基、窗口和宿主边界 | implemented | Electron + TypeScript，kernel 不依赖宿主 |
| 1 | [01-provider-and-tape](01-provider-and-tape/spec.md) | Provider 抽象和会话存储 | implemented | HostAdapter 端口与 append-only Tape |
| 2 | [02-agent-loop](02-agent-loop/spec.md) | Agent 循环、权限和提示层 | implemented | 八层权限与每次调用收口 |
| 3 | [03-mcp-host](03-mcp-host/spec.md) | MCP host 与 OAuth | implemented | 注解不放宽权限，机密进钥匙串 |
| 4（4a） | [04-sandbox](04-sandbox/spec.md) | 沙箱与出网 | implemented | 沙箱默认工作区可写，网络默认关闭 |
| 4b | `05-file-bridge`（待起草） | 文件桥、快照和任务小结 | 规划中 | 路径校验、mtime 守卫和冲突逐文件处理 |
| 4c | `06-approval-modes`（待起草） | 审批档位 | 规划中 | 随快照与规则 inspector 开放，另行验收 |
| 4d | `docs/features/task-mode-ui`（待起草） | 任务模式界面 | 规划中 | 按 4a → 4b → 4c → 4d 顺序交付 |
| 5 | `07`（目录待起草） | 扩展层、MCP Apps 和 Artifacts | 规划中 | Skills、Plugins 和 Connectors 复用已有权限与 OAuth |
| 6 | 待起草 | 聊天体验、记忆、知识库和 Research | 规划中 | Research 有单次预算上限 |
| 6b | 待起草（host 在 `apps/server`） | 云端 host 和多租户 | 规划中 | 复用 kernel，跨租户隔离为硬门禁 |
| 7 | 待起草 | 产品化与发布 | 规划中 | 视觉替换、许可证扫描和平台签名公证 |

## 以后再说

2026-10-23 按 owner 的选择写入，原话「以后再说按推荐 R 收」（R 是私有笔记里那份 29 条推荐清单的名字；98 条候选也在那里）。格式：什么事 · 谁做 · 什么时候做或挡着什么 · 出处。

- 沙箱对仓库元数据只护了 `.git/hooks` 与 `.git/config`，其余能让之后在沙箱外运行的 git 执行代码的位置没挡 · lead · 挡 06 开自动档 · 2026-10-22 外部调研（另记）
- 命令的「撤不回」模式表太短，`git reset --hard`、`npm publish`、`docker push`、`kubectl delete`、`truncate` 这类被判成「未知」 · lead · 挡 06 开自动档 · 2026-10-22 外部调研（另记）
- 文件工具不认沙箱的凭据清单：家目录当工作区时读私钥不出卡，写 `.git/hooks` 只当普通写入 · lead · 挡 06 开自动档 · 2026-10-22 外部调研（另记）；04 §留给 05、06 与 task-mode-ui 的
- 外带检查认不出连接器：连接器的结果不算不可信来源、读取不算私密数据、非只读调用不算外发出口 · lead · 挡 06 开自动档 · 2026-10-22 外部调研（另记）
- 回答渲染对外链图片与链接全放行，防外泄只靠一行 CSP，也没有测试锁住 · lead · 挡 06 开自动档 · 2026-10-22 外部调研（另记）
- 中文粗体在标点处收尾时露出星号 · lead · 待定 · 2026-10-22 外部调研（另记）
- 渲染层没有错误边界，一处异常整窗白屏，打包版里没法恢复，冷启动又回到同一个会话 · lead · 待定 · 2026-10-22 外部调研（另记）
- 执行失败的工具调用收起后和成功的长得一样 · lead · 待定 · 2026-10-22 外部调研（另记）
- 重试与长时间等待对用户不可见，半截回复消失后只剩「思考中…」，没有原因也没有计时 · lead · 待定 · 2026-10-22 外部调研（另记）
- 没有会话列表，点「新对话」后旧会话在界面上回不去 · lead · 待定 · 2026-10-22 外部调研（另记）；02 §留到后续阶段；01 plan Open
- 单个长回合撑满上下文后，之后的消息接连溢出，最坏会话一直卡住（要修补 02） · lead · 待定 · 2026-10-22 外部调研（另记）
- 模型请求不走系统代理与 `HTTPS_PROXY`，也不信任系统根证书；证书错误没有单独归类 · lead · 待定 · 2026-10-22 外部调研（另记）
- 评测门禁只数记录不看结果：没有通过率阈值、没有 pass^k、不与上一版比、收下 dirty 工作区跑出的记录 · lead · 待定 · 2026-10-22 外部调研（另记）
- 余额耗尽在运行时被当成「请求被拒」，与探测和智谱的判法不一致 · lead · 待定 · 2026-10-22 外部调研（另记）
- 「投影版本变了就重建」没有实现，追加时还把游标上的版本号直接改成新版本（与 01 不符） · lead · 待定 · 2026-10-22 外部调研（另记）
- 更正本文件 §3、§14 的许可证记录（Cline 是 Apache-2.0；mcpb 与 ext-apps 新贡献是 Apache-2.0；Vercel AI Elements 已弃用，改指 shadcn 的 AI 组件），§11 要排除依据外泄源码写成的材料；动手前先对一手来源复核 · lead · 待定 · 2026-10-22 外部调研（另记）
- CLA 文本与 cla-assistant 上线；上线前外部 PR 只审不合 · owner · 第一个外部 PR 出现前 · ADR-002 后续动作；00 plan
- 「包管理器」预设加「npm 镜像地址」，填了就设 registry 并把镜像域名加进白名单（要改 04 不变量 3）；现在可用项目里的 .npmrc 绕过 · lead · 待定，不挡 · 04 plan Open（owner 2026-10-14）
- 提示层加一句：没有违规块时的 Operation not permitted 多半是 macOS 隐私授权，不是沙箱（要升提示层版本） · lead · 下次改提示层时 · 04 plan Open（owner 2026-10-22）
- 合规、可复现的同题对比协议（与 Claude Desktop 的那一列） · owner 与 lead · 下一份要跑同题对比的 spec 之前 · 04 plan Open；docs/evals/README.md
- 盯 CI 的 `sandbox-macos` 上「setsid python3 起 perl」那条用例的偶发红（观察）；再红先查 ready 条件与超时 · lead · 再红时处理 · 04 plan Open（2026-10-22）
- 本地 MCP server 进沙箱、按工作区拆进程（03 原写阶段 4 做，04 定为不做，现以你的权限运行） · owner · 待定，没有 spec 接手 · 04 §非目标（Q11）；03 §给阶段 4、5 留的位置
- MCP Apps 的 iframe 安全模型（Electron 没有官方指南；参照 DeepChat 的自定义协议、CSP 与双层 iframe，Tenon 要开 sandbox） · lead · 阶段 5 起草前 · 本文件 §15.2
- LLM 判官单独立题，要答：缓存规则、退回人工的阈值、判官自己怎么防注入、手动档下跑不跑（只拦截，还是只给卡加一句提醒） · lead · 06 之后 · 02 §留到后续阶段；04 §非目标
- 连接器卡加「本会话允许」（撤不回与要求用户交互的卡不出），另起只增修补 02 与 03 的 feature spec · owner 给使用反馈，lead 起草 · 你觉得确认弹得太多时 · 03 开放问题 14
- 厂商现状表（docs/reference/ 下，每行写能力、实测结果、核实日期、一手来源、依赖它的 spec、重核时间），先收 Anthropic · lead · 随 claude-5-5-models 第 1 步起 · ADR-004 A12
- README 的截图：一次对话、审批卡打开，存为 docs/assets/approval-card.png，模型选择器不显示厂商模型名 · lead · 待定 · README.md
- spec-check job 装 e2e 工具链，让 e2e 层与 macOS 专属的突变也能每个 PR 机器重跑 · lead · 待定 · ADR-004 A18
- Windows 桌面的未验证与未做（进程树、钥匙串、目录联接与盘符、cmd 包装与 Job Object、基础环境白名单与 npx / uvx 本地连接器、无 OS 级沙箱时每条命令都问） · lead · Windows 进验收的那一阶段 · 00 plan Open；03 开放问题 4；04 §非目标
- claude-5-5-models 合入之前不切 release 分支：presentation-r1 先合入，第一把 key 现在只写钉住的行 id，指针一支要等它补上，其间写下的值分不出是不是用户选的 · owner · 挡上线 · [claude-5-5-models](../features/claude-5-5-models/spec.md) §跟随最新「迁移」
