# 00 · 地基（Foundation）

Status: ready
Phase: 0 of the roadmap in [master-reference §13](../master-reference.md)
Owner: architecture decided in the Claude Desktop project; implementation in Claude Code / Codex

## 背景与问题

Tenon 是一个 Electron + TypeScript 的桌面 Agent 工作台，目标是对齐 Claude Desktop 的三种形态（Chat / Cowork / Code 共用一个 agent 内核，三套工具与权限 profile），并在后期加入服务端多租户 host。阶段 0 不实现任何 agent 能力，只把**之后改不起的东西**定下来：仓库形状、内核与壳的边界、`HostAdapter` 接口、租户键、契约层、门禁。这些定错了，后面每个阶段都要返工。

## 目标

1. monorepo 跑起来：`packages/kernel`、`packages/contracts`、`apps/desktop` 三个包能 build、lint、typecheck、test。
2. 内核与壳的边界由工具强制：`packages/kernel` 里 `import 'electron'` 会被 lint 拦下。
3. `HostAdapter` 接口定稿并有 desktop 实现；kernel 通过它做的第一件事是 spawn 一个 MCP stdio server（`@modelcontextprotocol/server-everything`）、列出 tools、调用一次。
4. 所有持久化路径和键都带 `tenantId`；本地一个 profile = 一个 `(userId, tenantId)` 目录。
5. 一个能流式对话的最小窗口：Electron 壳 + 设计令牌 + 基础组件 + 壳层布局 + Composer 最小态 + 消息流基础。
6. 门禁：hooks 在交接前跑 format / lint / typecheck / test；CI 在 PR 上跑同样的东西；GitHub secret scanning + push protection 开启。

## 非目标

- 不实现 agent 循环、权限引擎、Tape、压缩（阶段 1–2）。
- 不接第二个 provider（阶段 1）。
- 不做沙箱（阶段 4）——但 `HostAdapter.sandbox` 的接口形状现在就定，desktop 实现先是直通（no-op wrap）。
- 不做 `apps/server`（阶段 6b）——只建目录占位。
- 不做视觉定稿；令牌值用临时皮肤，键名按最终结构。

## 仓库形状

```
tenon/
  AGENTS.md  CLAUDE.md  README.md  LICENSE  NOTICE  SECURITY.md  CONTRIBUTING.md
  package.json  pnpm-workspace.yaml  tsconfig.base.json  .oxlintrc.json  .editorconfig
  .claude/settings.json            # includeCoAuthoredBy=false + 门禁 hooks
  .github/workflows/ci.yml
  packages/
    kernel/                        # @tenon-app/kernel — 无 Electron 依赖
    contracts/                     # @tenon-app/contracts — zod schema：IPC、桥协议、插件格式
  apps/
    desktop/                       # Electron host：main / preload / renderer
    server/                        # 占位（阶段 6b）
  examples/plugins/                # 占位（阶段 5）
  docs/                            # 见 docs/spec-driven-dev.md
```

依赖方向只允许：`apps/* → packages/contracts → packages/kernel`（apps 依赖 packages；kernel 不依赖任何 app；contracts 可依赖 kernel 的类型）。用 `no-restricted-imports` + 包边界 lint 强制。

## 技术选型（已在主参考定，此处只列）

Electron（[ADR-001](../../adr/adr-001-electron-vs-tauri.md)）· Vite · React · TypeScript strict · pnpm · oxlint / oxfmt · Vitest（kernel、contracts）· Playwright（desktop e2e）· shadcn/ui（Base UI）+ Tailwind · assistant-ui（消息流骨架）· Streamdown（markdown 流式渲染）· `@modelcontextprotocol/client@2.0.0` · zod · better-sqlite3（阶段 1 才用，阶段 0 不引入）。

## HostAdapter

kernel 与外界的唯一接口。**kernel 只依赖这个接口，不知道自己跑在 Electron 里还是服务端沙箱里。**

```ts
// packages/kernel/src/host/adapter.ts
export interface HostAdapter {
  readonly identity: HostIdentity
  readonly fs: HostFs
  readonly secrets: HostSecrets
  readonly process: HostProcess
  readonly sandbox: HostSandbox
  readonly confirm: HostConfirm
  readonly clock: HostClock
}

export interface HostIdentity {
  userId: string
  tenantId: string           // 本地 = profile 的租户；服务端 = 组织
  profileDir: string         // 本地持久化根目录，已含 tenantId
}

export interface HostFs {
  readFile(path: AbsolutePath, opts?: { encoding?: 'utf8' }): Promise<Uint8Array | string>
  writeFile(path: AbsolutePath, data: Uint8Array | string): Promise<void>
  stat(path: AbsolutePath): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null>
  readdir(path: AbsolutePath): Promise<string[]>
  mkdirp(path: AbsolutePath): Promise<void>
  // 删除是独立可授予的能力，不在基础接口里；阶段 4 加 HostFs.remove + 运行期授权
}

export interface HostSecrets {
  get(key: string): Promise<string | null>     // key 已由 kernel 加上 tenantId 前缀
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface HostProcess {
  spawn(spec: SpawnSpec, signal?: AbortSignal): Promise<ChildHandle>
}
export interface SpawnSpec {
  argv: string[]             // argv[0] 是可执行文件的绝对路径
  cwd: AbsolutePath
  env: Record<string, string>
  stdio: 'pipe' | 'ignore'
}
export interface ChildHandle {
  pid: number
  stdin: WritableStream<Uint8Array>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<{ code: number | null; signal: string | null }>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>   // 必须清理整棵进程树
}

export interface HostSandbox {
  // 把"想执行的命令"变成"实际 spawn 的 argv/env"。desktop 阶段 4 接 sandbox-runtime；阶段 0 直通。
  wrap(request: SandboxRequest): Promise<{ argv: string[]; env: Record<string, string> }>
  afterExit(commandId: string): Promise<void>
  violations(commandId: string): Promise<SandboxViolation[]>
}
export interface SandboxRequest {
  commandId: string          // = tool-use id，违规归因用
  argv: string[]
  cwd: AbsolutePath
  env: Record<string, string>
  profile: 'read-only' | 'workspace-write' | 'full-access'   // full-access = 不包装
  workspace: AbsolutePath[]
}
export interface SandboxViolation { kind: 'fs' | 'network'; line: string }

export interface HostConfirm {
  // 阶段 0 只定形状；阶段 2 的等待模型是"写进 transcript、Run 暂停"，这里的 request 只负责把请求投递给 UI
  request(req: ConfirmRequest): Promise<void>
}
export interface ConfirmRequest {
  requestId: string
  sessionId: string
  kind: 'tool' | 'file' | 'command' | 'network'
  display: { title: string; detail: string; redacted?: unknown }
}

export interface HostClock { now(): number; setTimeout(fn: () => void, ms: number): () => void }

export type AbsolutePath = string & { readonly __brand: 'AbsolutePath' }
```

不变量：

- kernel 代码中不出现 `node:fs`、`node:child_process`、`keytar`、`electron` 的 import（lint 断言）。
- `HostProcess.spawn` 的 `argv[0]` 必须是绝对路径；相对路径直接抛错。
- `HostSandbox.wrap` 在 `profile: 'full-access'` 下原样返回 argv/env；其他档在阶段 0 也原样返回但打日志 `sandbox: passthrough`——阶段 4 替换实现时接口不变。
- `HostIdentity.tenantId` 非空；所有 kernel 内的持久化 key 由 `keyFor(identity, ...parts)` 生成，禁止手拼。

## 契约层

`packages/contracts` 用 zod 定义所有跨进程边界：

- `ipc/*.ts` — renderer ↔ main 的每一条通道：请求 schema、响应 schema、事件 schema。main 侧 `ipcMain.handle` 只允许通过 `registerRoute(route, handler)` 注册，handler 收到的是已校验的输入。
- `bridge/*.ts` — 阶段 6b 的桌面↔服务端协议，阶段 0 只建目录。
- `plugin/*.ts` — 阶段 5 的插件清单，阶段 0 只建目录。

不变量：renderer 发到 main 的任何消息在进入 handler 前经过 `schema.parse`；失败返回结构化错误，不抛到调用方。

## 本地持久化布局

```
<userData>/profiles/<userId>/<tenantId>/
  config.json          # 非机密设置
  sessions.db          # 阶段 1 建；阶段 0 只建目录
  logs/
  mcp/                 # 阶段 3
  skills/  plugins/    # 阶段 5
```

密钥在 OS keychain，服务名 `com.yiongspace.tenon`，账户名 `<tenantId>:<key>`。

## Electron 壳

- 每个 `BrowserWindow`：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。preload 只暴露 `contracts` 里声明的通道。
- 主进程持有 `DesktopHostAdapter`（实现上面的接口）和一个 `Kernel` 实例；renderer 只通过 IPC 与之对话。
- 单实例锁、深链接注册（`tenon://`）先占位不实现。

## UI 最小集

- 设计令牌：按 [master-reference §8.5](../master-reference.md) 的键名分层（surface / text / border / fill / alpha / radius / h-control / weight / ease / dur / z），亮暗两套，壳层背景独立一层；值用 §8.1 临时皮肤。
- 基础组件：Button / IconButton / Popover / Menu / Modal / Tooltip / Switch / Chip。
- 壳层：Sidebar（264px，可折叠）+ TopBar + 内容列；右侧面板先留空。
- Composer 最小态：文本、发送、生成中停止。
- 消息流：用户消息、助手消息（Streamdown 流式渲染）、错误态。block 渲染器做成类型注册表（`text` 一种先），不做 markdown 特例分支。

## 验收标准

1. `pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test` 在干净 clone 上全过。
2. 在 `packages/kernel` 任意文件加一行 `import 'electron'`，`pnpm lint` 失败并指出规则名。
3. `pnpm --filter @tenon-app/kernel test` 里有一个测试：用内存版 `HostAdapter` 假实现，kernel 能 spawn `server-everything`（通过 `HostProcess.spawn`），完成 MCP v2 协议协商，`tools/list` 返回非空，调用 `echo` 工具得到回显。
4. desktop 启动后能向一个 Anthropic-compatible endpoint 发一条消息并流式渲染回复；中途点停止能中断流（`AbortSignal` 传到 fetch）。
5. 两个 profile（不同 `tenantId`）分别写入 `config.json`，路径不同，互不可见。
6. renderer 发送一条不符合 schema 的 IPC 消息，main 返回结构化校验错误，进程不崩。
7. `.claude/settings.json` 的 hooks 在 Stop 时跑 `pnpm lint && pnpm typecheck`；CI 在 PR 上跑第 1 条；仓库开启 secret scanning + push protection（截图或设置页确认）。
8. `git log` 无 AI co-author 尾注；commit 通过 commitlint。

## 开放问题

- **Provider 层的形状**（手写 wire format vs Vercel AI SDK）：阶段 0 只写一个最小的 Anthropic 流式调用，不抽象。阶段 1 写第二个 provider 时定。
- **`HostConfirm` 与"写进 transcript"等待模型的衔接**：阶段 2 定。阶段 0 的 `request()` 只是投递。
- **Code profile 是否与 Cowork 共用壳**：kernel 的 `profile` 枚举含 `chat | cowork | code`，壳只做前两个；阶段 6 前重估。

## 被否决的方案

- 内核直接放在 Electron 主进程里、不分包：DeepChat 的现状，两万行后抽不出来，无法做服务端 host。
- Tauri：见 ADR-001。
- 在 Tape 表里加 `tenant_id` 列而不是按 profile 分文件：本地版按文件隔离更简单，导出 / 删除是文件操作；服务端才用列级隔离。同一套 schema 两种部署，见主参考 §4.13。
