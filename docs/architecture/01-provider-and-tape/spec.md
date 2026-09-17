# 01 · Provider 抽象 + 会话存储（Tape）

Status: ready
Phase: 1 of the roadmap in [master-reference §13](../master-reference.md)
Owner: architecture decided in the Claude Desktop project; implementation in Claude Code / Codex
Amends: [00-foundation](../00-foundation/spec.md) §HostAdapter 与 §技术选型——只增不改，按 [spec-driven-dev](../../spec-driven-dev.md)「改变决定」的 amend 规则（2026-09-17 owner 确认），全文见「对 00-foundation 的修补」
Revisions: 2026-09-17 首版草稿经一轮五角度对抗审查与一轮执行复核后就地修订（尚无代码依赖）。主要改动：`incarnationId` 由 kernel 铸造并随批传入（原为 store 自铸）；`session_projection` 去掉 `message_count`（逐条标量 reducer 算不出累计值）；`tape_entry_by_source` 末列由 `source_seq` 改为 `entry_id`（原列序下恢复读取要临时排序）；补齐 `Usage` / `ToolSpec` / `MessageStatus`；凭据规则按线协议分开；重放增加 `atEntryId`；失败轮次不写 assistant 消息；amend 机制由提议改为记录

## 背景与问题

阶段 0 的对话是一条写死的路径：[`apps/desktop/src/main/chat.ts`](../../../apps/desktop/src/main/chat.ts) 直接 new 一个 Anthropic SDK 客户端，会话历史是主进程里的一个 `Map`，应用一关就没了。这两处正是主参考说的「改错了要重写一大片」的地方：

- **Provider 接口**。第一版若假设「所有厂商都支持流式 + 原生 tool calling + 无 thinking」，接 Ollama、reasoning 模型、国内兼容端点时每个实现都得动（主参考 §4.8.3）。
- **消息怎么存**。一旦有了用户数据，entry 模型的每一列都是一次迁移；哈希链不能回填；幂等键、身份列、命名空间事后补都要动线上数据（DeepChat 的 `source_*` 与 `provenance_key` 四列就是事后 `ALTER TABLE` 补的，见 [deepchat-mechanisms §二之补](../../reference/deepchat-mechanisms.md)）。

阶段 1 不做 agent 循环。它只把这两个接口和一张表定下来，并保证阶段 2（循环）、阶段 4（沙箱与快照）、阶段 6b（服务端多租户）之后**只加 name、加索引、加实现，不改列、不改接口**。

本 spec 的事实依据来自三份实测（每份都经过一轮独立的对抗复核）：SQLite 绑定对比、两家官方 SDK 的 fetch 注入与流形状、DeepChat Tape 的补读。结论写在各节，探针不入库。

## 目标

1. `packages/kernel` 里有一套 Provider 抽象：`stream` 是唯一必需的 I/O，其余能力都是带默认值的方法；内置 Anthropic Messages 与 OpenAI 兼容两种线协议适配器，三个 provider 定义（Anthropic、智谱、Ollama）。
2. kernel 出网只有一条路：`HostAdapter.network.fetch`。
3. `packages/kernel` 里有 Tape 的 entry 模型、存储端口 `TapeStore`、内存实现、投影 reducer 与重放；`apps/desktop` 里有基于 better-sqlite3 的实现。
4. 八条开工前裁决全部落成文字与 schema。
5. desktop 的对话走新路径：换 provider 不改调用方；重启后对话还在；另一个 profile 看不到。
6. `packages/contracts/src/bridge/` 有帧信封与版本协商骨架。

## 非目标

- agent 循环、工具分发、权限引擎、`ConfirmReason` 扩展（阶段 2）。阶段 1 不写任何 `tool/*`、`execution/*`、`view/*`、`compaction/*` 事实，只保留它们的名字与身份列。
- Execution Journal 的写入方与恢复分类（阶段 2，见裁决 R1）；ViewManifest；压缩与 anchor 的工作机制（`anchor` kind 只用于 `session/start`）。
- MCP 接线（阶段 3）；沙箱、文件桥、快照与一键还原（阶段 4）。
- `apps/server`、Postgres 实现、RLS、保留期清扫、链签名（阶段 6b）。阶段 1 只交付 Postgres 方言的 DDL 文件与一致性检查，不运行它。
- 静态加密（SQLCipher 或同类）。**哈希链只让篡改可被发现，不提供保密性**；阶段 1 的保密性靠 OS 磁盘加密与 keychain。
- 分支 / 编辑重发 / 重新生成 / 删除单条消息的界面（阶段 6）。阶段 1 只定它们在 Tape 里的表示与折叠规则。
- 无痕会话的入口与 store 路由（阶段 6）。阶段 1 只保证端口形状支持它：kernel 服务接的是一个 `TapeStore` 实例，换实现不改 kernel 代码。
- 会话列表界面、搜索、FTS 投影（阶段 6）。会话的导出 / 导入与「本地 → 云端」迁移演练（6b）。
- token 计数、ToolShim、OAuth / device-code 登录流、定价展示、完整的 canonical model registry。`ConfigKey` 声明这些标志位，只实现 API key 配置。
- 在 CI 里调用任何真实 provider。真实端点只由手动的 `pnpm test:live` 覆盖。

## 开工前裁决

主参考 §13 阶段 1 列出的八条，逐条给结论。细节在后面对应的节里。

| # | 问题 | 裁决 | 阶段 1 落地 | 推迟 |
|---|---|---|---|---|
| R1 | Execution Journal 排阶段 2 还是 4 | **阶段 2**，只做核心：四个事件名（`execution/run_started` / `dispatch_committed` / `tool_outcome` / `run_terminal`）、T1 紧贴副作用边界之前、四分类恢复。理由：阶段 2 已有真实写文件与 `HostProcess.kill`，它自己的验收「任务小结写『已停，后续写入未发生』」就是一句关于副作用是否越界的断言，没有 dispatch / outcome 事实答不了。阶段 4 的沙箱只改写 argv / env，不移动分发调用点，所以「等阶段 4 一起重铺」的理由不成立。**阶段 1 的代价在两种排法下完全相同**；细分范围由阶段 2 的 spec 最终确定 | kind 集合、`execution/` 前缀保留、身份列 `(source_type, source_id, source_seq)` 与其索引、`provenance_key` 唯一约束、session 内严格递增的 `entry_id` | 嵌套身份（`childOrdinal`）、契约血缘、细分的损坏原因与 `parked` 诊断 → 阶段 4。不预留的代价：一旦通用 append 往用户文件里写过一行 `execution/foo`，以后的 Journal 读者分不清真事实与占位，修法是数据审计而不是迁移 |
| R2 | 现在就留 `prev_hash` / `entry_hash` 吗 | **留**，并且链的配方现在定死。链不能回填：从第 500 条开始的链对前 499 条什么也证明不了 | `prev_hash`、`entry_hash`、`content_hash`、`hash_ver` 四列；kernel 里一个纯函数算哈希，store 在事务里调用；`verifyChain` | 签名、密钥托管、跨会话锚定 → 6b（另加一张 seal 表，不动 `tape_entry`） |
| R3 | append-only 下的删除 / 保留期 / 无痕 | **append-only 只对一个 incarnation 之内的事实成立；逐条物理删除与哈希链不相容（删掉中间一条，后面每一条都不可验），所以物理删除的粒度只能是整个 session 或整个 incarnation**。删单条 = tombstone；清空会话 = 物理重置 + 新 incarnation；删会话 = 物理删除。保留期与 legal hold 的粒度是 **session**，永不是 entry。无痕 = 该会话用内存 store，不是一个列 | 两条物理删除路径都必须经过「维护闸」（触发器强制）；`content_hash` 让将来的单条内容擦除不破链 | `retention_until` / `legal_hold` 两列、清扫任务、删除回执表（记 `last_hash_before`）→ 6b。前两者加在不参与哈希的 `session_head` 上，是一次无数据风险的 `ADD COLUMN`，「列不存在」与「列为 NULL」含义相同；回执只在有审计制度时才有意义，而对本地用户它本身就是「这个会话存在过」的残留 |
| R4 | 本地主键形状；「同一套 DDL 通用」是否为真 | `tenant_id` **仍是**主键与每个索引的第一列，即使它在一个 profile 文件里恒定。「同一套**表结构**通用」为真；「同一套 **DDL** 通用」为假——是**一套逻辑 schema、两份方言文件** | `tape.sqlite.sql` + `tape.postgres.sql` + 挂在 `pnpm lint` 里的一致性检查；store 打开文件时校验租户 | Postgres 上的运行时验证、RLS → 6b |
| R5 | 阶段 4 反推的字段 | **不为它们加列**。`runId` 归组走身份列（`source_type='runtime_event'`、`source_id=runId`、`source_seq=requestSeq`）；副作用分类是 payload 里的固定路径，词表现在定；快照号不是实体，快照坐标就是 `(incarnation_id, entry_id)` | 身份列索引；`SideEffectClass` 词表进 kernel 类型 | 写入方 → 阶段 2 / 4；按 `effect` 查询时加表达式索引（加索引不是迁移） |
| R6 | 分支 / 编辑重发：fork entry 还是新 session | **Session ↔ Tape 保持一一对应，Tape 内永不分支**。编辑重发 = 同 `messageId` 追加一条修订事实；重新生成 = 逐条 `message/retracted` 后跑新 Run；fork = 新 session，它的 `session/start` 锚点带来源指针 | 折叠规则、`forkedFrom` 字段、测试 | 三种操作的界面与 kernel 入口 → 阶段 6 |
| R7 | `contracts/bridge/` 帧骨架 | 现在定**信封与版本协商**，不定任何业务帧 | `frame.ts`：信封、`hello` / `welcome` / `ping` / `pong` / `error`、未知帧不致命、`tenantId` 是断言不是选择；`provenance_key` 的语法保证它**有资格**做跨桥幂等键 | 传输方式、鉴权、重连与重投、「至少一次还是恰好一次」、所有业务帧体与它们的名字 → 6b |
| R8 | 补读 DeepChat | 已写回 [deepchat-mechanisms §二之补](../../reference/deepchat-mechanisms.md)：对抗复核后的版本（44 条断言里 3 条被推翻并已更正），标明它读的是比笔记其余部分晚六天的 commit；只留机制证据，Tenon 自己的取舍写在本 spec | — | — |

## 所有权与依赖方向

```
packages/kernel/src/
  host/adapter.ts          + HostNetwork
  provider/                types · base · registry · thinking · errors
    wire/anthropic-messages.ts   wire/openai-chat.ts      # 两种线协议适配器
    definitions/anthropic.ts  zhipu.ts  ollama.ts         # provider 定义（数据 + create）
  tape/                    entry · names · provenance · canonical-json · hash
                           store（端口）· memory-store · projection · replay · tape（门面）
  session/                 service.ts                     # 建会话、写消息事实、跑一次请求
  testing/                 fake-network · tape-conformance  # 导出为 @tenon-app/kernel/testing
packages/contracts/src/
  ipc/provider.ts  ipc/session.ts                          # 新 IPC
  bridge/frame.ts                                          # 帧骨架
apps/desktop/src/main/
  host/network.ts                                          # HostNetwork 的 desktop 实现
  tape/sqlite-store.ts  tape/sql/tape.sqlite.sql           # better-sqlite3 只出现在这里
apps/server/sql/tape.postgres.sql                          # 只为一致性检查存在，6b 前不执行
scripts/check-tape-schema.mjs                              # 挂进 pnpm lint
```

- 依赖方向不变：`apps/* → packages/contracts → packages/kernel`。kernel 不 import contracts；IPC 可见的那部分类型由 contracts 用 zod 重述，并有一个类型级测试断言两边可互相赋值。
- `better-sqlite3` 是 `apps/desktop` 的依赖，**永不**出现在 `packages/kernel`。`@anthropic-ai/sdk` 从 `apps/desktop` 移到 `packages/kernel`，`openai` 是 kernel 的新依赖；两者都钉精确版本。
- `@tenon-app/kernel/testing` 是 kernel `package.json` 里新增的 `./testing` 子路径，与 `.` 同形（`development` 指 `src/testing/index.ts`，`types` / `import` 指 `dist`）。它住在 `src/` 之下，因此受 kernel 的 lint 闸约束：`fakeNetwork` 不用定时器，「慢流」由调用方推进或经传入的 `HostClock`。
- **id 从哪来**：`runId`、`messageId`、`incarnationId` 都是 canonical UUID，一律由构造 kernel 服务时传入的 `ids: { uuid(): string }` 提供（`createSessionService({ host, tape, ids })`）。desktop 传 `crypto.randomUUID()`，测试传确定性的计数器——否则夹具与 conformance 套不可复现。kernel 自己不取随机数；`ids` 刻意不进 `HostAdapter`。
- `TapeStore` **不是** `HostAdapter` 的成员。`HostAdapter` 装的是运行环境级的能力（文件、进程、网络）；store 是构造 kernel 服务时传入的端口（同一个 `createSessionService({ host, tape, ids })`），因为同一个进程里要同时存在多个 store（普通会话用 SQLite，无痕会话用内存），一个 `host.tape` 成员表达不了。

## 对 00-foundation 的修补：`HostAdapter.network`

阶段 0 的 spec 已是 `implemented`，`HostAdapter` 冻结为七个成员；kernel 的 lint 早已禁用裸 `fetch`，提示语写的就是「phase 1 decides its HostAdapter shape」。阶段 1 加第八个成员：

```ts
export interface HostAdapter {
  // …阶段 0 的七个成员不变
  readonly network: HostNetwork
}

/** 完整的 web 签名。把 input 收窄成 string 就不再能赋给两家 SDK 的 `ClientOptions.fetch`。 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** kernel 唯一的出网口。写成属性而不是方法：方法简写在 strictFunctionTypes 下是双变的。 */
export interface HostNetwork {
  readonly fetch: FetchLike
}

/** host 以出网策略拒绝一次请求时 reject 这个错误；provider 把它归一成不可重试的 `egress-denied`。 */
export class HostNetworkDeniedError extends Error {}
```

- provider 只从 `ProviderDefinition.create({ network, … })` 拿到它，捕获在实例上。不许模块级 `fetch`，不许 `globalThis.fetch ?? network.fetch` 式回落——回落正是「desktop 上能跑、服务端 host 上坏掉」的那种 bug。
- desktop 实现是一行：`{ fetch: (input, init) => globalThis.fetch(input, init) }`。阶段 4 的出网收口、6b 的出口白名单都在 host 实现里做（拒绝即 reject `HostNetworkDeniedError`），不拓宽这个接口。
- lint：kernel override 里 `fetch` 的禁用规则**已经存在**，阶段 1 只把提示语改为「走 HostAdapter.network」；同一处新增禁用全局 `WebSocket`、`EventSource`、`XMLHttpRequest`，`process` 与 `crypto`（凭据与配置只从 `ProviderDefinition.create()` 进来，kernel 永不读 `process.env`；随机数走 `ids`），禁止 import `undici`、`node-fetch`、`axios`、`got`、`ky`、`ws`、`better-sqlite3`。
- 内存版 host 的 `network.fetch` 默认抛错；测试用 `@tenon-app/kernel/testing` 的 `fakeNetwork(script)`，它只用 web 标准 API（`Response` + `ReadableStream`）回放录制好的 SSE 帧、响应 `init.signal`、记录发出的请求体，所以 kernel 的测试在任何 realm 里都能跑、永不碰 socket。基于 `node:http` 的假服务器只留在 `apps/desktop/test/support/`，给 host 层的集成测试用。

### 这次修补怎么记录

阶段 0 的 spec 已是 `implemented`。加一个成员没有推翻阶段 0 的任何决定，为此作废整份 spec 不成比例；「部分 supersede」会让旧 spec 一半有效、却没有规则说是哪一半；静默改旧文则丢掉「当时为什么这么定」。原有规则对这种情况没有答案：spec-driven-dev 与 AGENTS.md 只允许整体 supersede，主参考 §13 阶段 2 却写「`HostAdapter` … 改动按 Revisions 规则处理」，阶段 4 对 `SandboxRequest` 也这么写。

owner 于 2026-09-17 确认了一条窄的第三种机制——**修补（amend）**，规则写在 [spec-driven-dev](../../spec-driven-dev.md)「改变决定」与 AGENTS.md「How we work」，已落地：

1. `00-foundation/spec.md` 顶部 `Status: implemented` 之下有一行 `Amended by:` 指向本 spec。`Status` 不变，正文一字未改。
2. 修补的全文、日期、理由写在做修补的这份 spec 里：本节，以及「SQLite 实现约束」里把 better-sqlite3 限定为 13.x 的那一条。
3. 适用条件是只增不改——新增接口成员、新增枚举值、收紧一个原本未限定的选型——且不推翻任何既有决定、不改变任何既有成员的形状。凡是改动或移除既有内容，仍须 supersede。主参考 §13 阶段 2 与阶段 4 的两处措辞已相应改为按 amend 规则处理。

阶段 2 的租户策略落座点、阶段 4 的 `SandboxRequest` 改动都会再碰到同一个问题，所以定成了规则而不是特例。

## Provider 层

### 选型：官方 SDK，不用 Vercel AI SDK，不手写 SSE

- `@anthropic-ai/sdk@0.126.0` 与 `openai@7.17.0` 的 `ClientOptions.fetch` 都能完整接管出网（所有探针里全局 `fetch` 调用数为 0），并且在只有 web 全局对象的 realm 里能跑通流式。SDK 白送 SSE 分帧、类型化错误（带 `status` 与 `headers`）和逐请求的 `AbortSignal`。
- 不用 `ai`（Vercel AI SDK）作核心抽象，理由是具体的：`ai@7.0.105` 静态 import `@ai-sdk/gateway → @vercel/oidc`，后者在模块顶层 `require('fs' | 'path' | 'os')`，无法做到 host 无关；它的 unified stop reason 把 `pause_turn → stop`、`refusal → content-filter` 折叠掉，调用方反正要读 raw；`@ai-sdk/openai-compatible` 无条件回传 `reasoning_content`，而「回不回传、用哪个字段名」是 Tenon 必须按模型拥有的策略（Ollama 的输入字段叫 `reasoning`）；Tenon 需要的是带 `requestSeq` / `physicalAttempt` 的 Tape 形状事件流，不是 UI 形状的。公平地说，v7 确实能往返 thinking 签名、`redactedData` 和带 ttl 的 `cacheControl`。
- host 无关性的准确说法：两家 SDK 的根入口都**不会静态到达任何 `node:` 内置模块**。`openai@7.17.0` 在 `--platform=neutral` 下直接可打包。`@anthropic-ai/sdk@0.126.0` 经两处**动态 import**（文件凭据链、EnvironmentWorker 工具集）能到达九个 `node:` 模块；显式传入凭据时它们永不执行。它还静态 import 一个纯 JS 包 `standardwebhooks`。将来的非 Node host 必须用 `--platform=browser` 打包：把 `internal/node.mjs` 换成桩靠的是 SDK 顶层的旧式 `browser` 字段，只有 `--platform=browser` 会应用它；`--platform=neutral --conditions=browser --main-fields=module,main` 实测仍在那九个模块上失败。

### 接口

```ts
export type ProviderId = string // 'anthropic' | 'zhipu' | 'ollama' …是数据，不是联合类型

export interface ConfigKey {
  name: string
  required: boolean
  /** true = 值进 HostAdapter.secrets（键由 keyFor 生成）；false = 进 config.json。 */
  secret: boolean
  default?: string
  /** 只给 i18n 键；kernel 不产出句子（00-foundation §国际化）。 */
  labelKey: string
  primary?: boolean
  oauthFlow?: boolean // 阶段 1 只声明，不实现
  deviceCodeFlow?: boolean
}

export interface ModelInfo {
  id: string
  providerId: ProviderId
  /** 转售渠道（Bedrock / Azure）映射回上游真实模型，定价与 thinking 规则按它算。 */
  canonicalId?: string
  contextLimit: number
  maxOutputTokens: number
  reasoning: boolean
  supportsToolCalling: boolean
  supportsStreamingToolCalls: boolean
  supportsVision: boolean
  supportsCacheControl: boolean
  /** thinking 块怎么带回下一次请求。 */
  thinkingPreservationFormat: 'signed-blocks' | 'reasoning-content' | 'text-only' | 'drop'
  /** 'reasoning-content' 档回传时用的字段名：DeepSeek 系是 reasoning_content，Ollama 是 reasoning。 */
  reasoningEchoField?: 'reasoning_content' | 'reasoning'
  /** OpenAI 线协议要显式开 stream_options.include_usage 才给用量。 */
  usageNeedsOptIn: boolean
  pricing?: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number }
  /** 原样并入请求体的透传参数——抽象不被某一家撑破的保险。 */
  requestParams?: Record<string, unknown>
}

export interface RequestIdentity {
  runId: string // canonical UUID，不依赖进程内计数器
  requestSeq: number // 载荷身份：载荷变了才 +1
  physicalAttempt: number // 传输次数：同载荷重发才 +1
}

export interface ProviderRequest {
  model: ModelInfo
  system?: string
  messages: InternalMessage[]
  tools?: ToolSpec[]
  maxTokens?: number
  temperature?: number
  thinking?: { enabled: boolean; budgetTokens?: number }
}

export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }

/** 厂商特有的计数进事实的 `meta`，不进 `Usage`。 */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** 一次流可以有多条 usage（Anthropic 在 message_start 与 message_delta 各发一条）。只有 final 的那条进 Tape。 */
  final: boolean
}

export interface SendContext {
  signal?: AbortSignal
  identity: RequestIdentity // provider 只读，永不修改
}

export interface Provider {
  // 写一种新线协议要实现的四样
  readonly id: ProviderId
  models(): Promise<ModelInfo[]>
  /** 纯函数：无 I/O、无时钟、无网络。同一输入两次调用，body 逐字节相同。 */
  encode(req: ProviderRequest): EncodedRequest
  /**
   * 唯一必需的 I/O。吃的是 encode() 的产物而不是原始请求：被哈希的就是被发出去的，
   * 阶段 2 才能在字节离开之前先把 view/assembled 落盘。永不因线上错误而 reject。
   */
  stream(encoded: EncodedRequest, ctx: SendContext): AsyncIterable<StreamEvent>

  // 接口上必需、BaseProvider 给默认值：「不支持」是返回值，不是缺方法，调用方永不判空
  complete(req: ProviderRequest, ctx: SendContext): Promise<CompleteResult> // 默认 = encode → stream → 收集
  managesOwnContext(): boolean // 默认 false
  supportsCacheControl(model: ModelInfo): boolean // 默认读 ModelInfo
  thinkingEffortSupport(model: ModelInfo): 'none' | 'budget' | 'effort' // 默认 'none'
  retryAdvice(): { maxAttempts: number; baseDelayMs: number } // 只是建议；重试在阶段 2 的循环里

  // 真正可选：缺失表示这条流程不存在
  countTokens?(req: ProviderRequest): Promise<number>
}

export interface EncodedRequest {
  readonly providerId: ProviderId
  readonly modelId: string
  readonly body: unknown // 交给 SDK 的线上载荷
  readonly promptHash: string // canonicalJson(body) 的 SHA-256（hex）
  readonly toolDefinitionsHash: string
  readonly thinkingDecisions: readonly ThinkingDecision[] // 审计：每个 reasoning 块的去向与原因
}

export interface ThinkingDecision {
  action: 'replay' | 'echo' | 'downgrade' | 'drop'
  reason:
    | 'same-model' | 'foreign-provider' | 'model-changed' | 'target-drops'
    | 'no-tools' | 'redacted-unsupported' | 'missing-signature'
}

export interface CompleteResult {
  message: InternalMessage
  usage: Usage | null
  stop: { reason: StopReason; providerReason: string | null } | null
  error: Extract<StreamEvent, { type: 'error' }> | null // 不带这两项，默认 complete() 会把错误和中止吞掉
}

export interface ProviderDefinition {
  id: ProviderId
  nameKey: string // i18n 键
  wire: 'anthropic-messages' | 'openai-chat'
  configKeys: ConfigKey[]
  builtinModels: ModelInfo[]
  /** host 能力只从这里进入。 */
  create(args: {
    network: HostNetwork
    config: Record<string, string> // 非机密项，已套默认值
    secrets: Record<string, string> // 调用方已从 HostAdapter.secrets 读出；kernel 永不读 process.env
  }): Provider
}

export interface ProviderRegistry {
  register(def: ProviderDefinition): void
  get(id: ProviderId): ProviderDefinition | null
  list(): ProviderDefinition[]
}
```

内容模型与 Tape 的 message payload 共用：

```ts
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature: string; provider: ProviderId; providerModel: string }
  | { type: 'redacted-thinking'; data: string; provider: ProviderId; providerModel: string }
  | { type: 'tool-request'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-response'; id: string; content: Array<Extract<ContentBlock, { type: 'text' | 'image' }>>; isError: boolean }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
export interface InternalMessage { role: 'user' | 'assistant'; content: ContentBlock[] }
```

`encode()` 的 `max_tokens` 取 `req.maxTokens ?? model.maxOutputTokens`，永不为 `undefined`（Anthropic 线协议里它是必填项）。

`provider` 与 `providerModel` 记在 thinking 块**本身**上——没有它们，thinking 守卫无从比较，主参考 §4.8.3 的「换模型时丢弃或降级上一个模型的 thinking block」就无法实现。

### 归一化事件流

```ts
export type StreamEvent =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'thinking-delta'; index: number; text: string }
  | { type: 'thinking-signature'; index: number; signature: string }
  | { type: 'redacted-thinking'; index: number; data: string }
  | { type: 'tool-call-start'; index: number; id: string; name: string }
  | { type: 'tool-call-args-delta'; index: number; json: string }
  | { type: 'tool-call-end'; index: number; id: string; name: string; input: Record<string, unknown> }
  | { type: 'usage'; usage: Usage }
  | { type: 'stop'; reason: StopReason; providerReason: string | null }
  | { type: 'error'; code: ProviderErrorCode; retryable: boolean; retryAfterMs?: number;
      status?: number; providerCode: string | null; detail: string /* 只进日志，永不渲染 */ }

export type StopReason =
  | 'end-turn' | 'max-tokens' | 'stop-sequence' | 'tool-use'
  | 'pause-turn' | 'refusal' | 'content-filter' | 'context-overflow' | 'aborted' | 'unknown'
export type ProviderErrorCode =
  | 'auth' | 'rate-limit' | 'overloaded' | 'invalid-request'
  | 'context-overflow' | 'network' | 'egress-denied' | 'server' | 'unknown'
```

`index` 是适配器分配的块槽位，只在一次响应内有意义，不是 provider 的语义。`encode()` 的默认实现住在两个线协议适配器类上（`AnthropicMessagesProvider`、`OpenAIChatProvider`），provider 定义是数据加一个 `create()`，不各写一份编码器。

### 中止、重试、错误

- 两个 SDK 客户端都设 `maxRetries: 0`。默认值 2 意味着 kernel 看不见的三次物理请求（实测：3 次 fetch 对 1 次），这会毁掉 §4.8.4 的 `requestSeq` / `physicalAttempt` 区分。重试属于阶段 2 的循环：每次重发 `physicalAttempt + 1`，载荷变了才 `requestSeq + 1` 并把 `physicalAttempt` 归 1，依据是 `error` 事件的 `{ retryable, retryAfterMs }`。阶段 1 每次请求都带上这三个身份字段并记入 Tape，但不实现重试。
- 两家 SDK 遇到流中途的 error 帧都是**抛出**而不是 yield（Anthropic 嵌在 `err.error.error.type`，OpenAI 在 `err.error.code`，`status` 为 `undefined`）。每个适配器把 `for await` 包进 try/catch，把抛出的错误映射成 `error` 事件。只有程序员错误（配置缺失、参数非法）才抛。SDK 里解析 `retry-after` 的代码只在它自己的重试路径上，随 `maxRetries: 0` 一起关掉了，所以 `retryAfterMs` 由适配器从 `err.headers` 取：`retry-after-ms`（毫秒）优先，否则 `retry-after`（秒 ×1000；非数字按 HTTP-date 减 `HostClock.now()`），都没有就不带。`network.fetch` 以 `HostNetworkDeniedError` reject 时映射为 `error{ code: 'egress-denied', retryable: false }`，其余连接层失败是 `network`、可重试。
- 中止有**两条路径**：流中途中止时迭代器静默结束，不抛；调用时 signal 已经中止则 SDK 抛 `APIUserAbortError` 且不触网。适配器把两者都归一成 `stop{ reason: 'aborted' }`。阶段 2 的「停止即杀」依赖这一条。
- 凭据永远显式传入，SDK 的环境变量 / 文件凭据链永不运行。两家 SDK 的规则不同，都实测过：
  - `anthropic-messages`：`apiKey` 与 `authToken` 两个都显式传，未配置的传 `null`，且**至少一个非 null**——两个都为 `null` 时 SDK 会去建 credentials / config / profile 链，那是它唯一会懒加载文件系统的地方；传 `undefined` 会让它读 `ANTHROPIC_API_KEY`。
  - `openai-chat`：`apiKey` 必须是**非空字符串**。`null` 与 `''` 抛 `Missing credentials`，`undefined` 会让 SDK 读 `OPENAI_API_KEY`。所以不需要 key 的 `ollama` 定义也带一个有默认值的 `apiKey` 配置项。

### thinking 守卫

一个函数 `decideThinking(block, target): ThinkingDecision`，住在 kernel，**每个** `encode()` 对**每个** reasoning 块都调用，不由各 provider 各写一份。按序判定：

1. 块的 `provider` ≠ 目标 provider → `drop / foreign-provider`
2. 块的 `providerModel` ≠ 目标模型 → `drop / model-changed`
3. 目标 `thinkingPreservationFormat = 'drop'` → `drop / target-drops`
4. `'reasoning-content'` → 本次请求带 tools 时用 `reasoningEchoField` 回传（`echo / same-model`），否则 `drop / no-tools`；redacted 块 `drop / redacted-unsupported`
5. `'text-only'` → thinking 降级为文本（`downgrade / same-model`），redacted 块 `drop / redacted-unsupported`
6. `'signed-blocks'` 且签名为空 → `drop / missing-signature`
7. 否则原样带回（`replay / same-model`）

签名**永不改写、永不合成**（签名不匹配 = Anthropic 返回 400）。前两条（来源守卫）与后五条（保留策略）是两道独立的闸：别家产出的历史一律丢弃；把同一段历史改标成目标 provider 之后，才轮到保留策略决定回传、降级还是丢弃。

### 内置 provider

| 定义 | 线协议 | 默认 baseURL | 配置项 | 为什么选它 |
|---|---|---|---|---|
| `anthropic` | anthropic-messages | `https://api.anthropic.com` | `apiKey`（机密，primary）、`authToken`（机密，Bearer 式兼容网关用）、`baseURL` | 阶段 0 的现有路径；`baseURL` 可指向任何 Anthropic 兼容端点 |
| `zhipu` | openai-chat | `https://open.bigmodel.cn/api/paas/v4/`（SDK 会归一化尾斜杠，原样存） | `apiKey`（机密）、`baseURL` | **第二个 provider**：`reasoning_content`、`include_usage`、经 `requestParams` 透传的非 OpenAI `thinking` 参数、`(0,1)` 开区间的 temperature，线上格式稳定 |
| `ollama` | openai-chat | `http://localhost:11434/v1/` | `baseURL`、`apiKey`（非机密、非必填，默认 `'ollama'`：Ollama 不校验它，但 SDK 要一个非空串） | **第三个**：以**另一种方式**偏离——没有 `tool_choice`、输入输出都用 `reasoning` 字段、工具参数整段一次给出。两个互相不一致的 OpenAI 兼容厂商，比一个听话的更能检验抽象 |

`ModelInfo` 各字段在实现时按厂商**当时**的文档填，不照抄研究报告；凡未能从文档或一次本地探测确认的字段，在 `plan.md` 记一笔。Ollama 的流式工具调用只从源码与已合并的 PR 核实过，写 `supportsStreamingToolCalls: true` 之前要对本地实例实测一次。

## Tape

### entry 模型

一张表 `tape_entry`，一行一个事实，只追加。

```ts
export type TapeKind = 'message' | 'tool_call' | 'tool_result' | 'anchor' | 'event' | 'context'

/** 「这条事实关于谁」的可索引身份。runtime_event ⇒ sourceId = runId，sourceSeq = requestSeq。 */
export type TapeSourceType =
  | 'session' | 'message' | 'tool_call' | 'tool_result' | 'runtime_event' | 'summary' | 'subagent' | 'migration'

export interface TapeEntry {
  tenantId: string
  sessionId: string
  entryId: number // session 内严格递增，永不复用；因果顺序以它为准
  incarnationId: string // 清空会话后换新；是哈希原像的一部分
  kind: TapeKind
  name: string // 斜杠命名空间，如 'message/user'；NOT NULL，保留规则因此是全覆盖的
  sourceType: TapeSourceType
  sourceId: string | null
  sourceSeq: number | null
  provenanceKey: string // 必填：每次 append 都是幂等的
  payload: Record<string, unknown>
  meta: Record<string, unknown>
  createdAt: number // HostClock 的 epoch ms；不是排序依据
  contentHash: Uint8Array
  prevHash: Uint8Array | null // 仅 incarnation 的第一条为 null
  entryHash: Uint8Array
  hashVer: number
}
```

阶段 1 实际写入的事实：

| kind | name | source | provenance_key | payload |
|---|---|---|---|---|
| `anchor` | `session/start` | `session` / sessionId / 0 | `session:v1:start:<incarnationId>` | `{ incarnationId, forkedFrom?: { sessionId, incarnationId, entryId, entryHash } }`（带 `entryHash`：血缘要能对着链验，而不只是一个裸指针；父会话被删之后它仍然成立） |
| `message` | `message/user`、`message/assistant` | `message` / messageId / revision | `message:v1:<messageId>:<revision>` | `{ messageId, revision, role, content: ContentBlock[], status: MessageStatus }`，`message/assistant` 另带 `runId` |
| `event` | `message/retracted` | `message` / messageId / null | `message:v1:<messageId>:retracted` | `{ messageId, reason }` |
| `event` | `session/model_selected` | `session` / sessionId / null | `session:v1:model:<runId>` | `{ providerId, modelId }` |
| `event` | `provider/attempt_completed` | `runtime_event` / runId / requestSeq | `provider:v1:attempt:<runId>:<requestSeq>:<physicalAttempt>` | `{ providerId, modelId, contextAtEntryId, request: { systemHash, maxTokens, temperature?, thinking? }, promptHash, toolDefinitionsHash, thinkingDecisions, usage, stop \| error }` |

- **谁在什么时候写**：`message/user` 在跑 run **之前**写；`message/assistant` 只在终态写一次。`MessageStatus = 'complete' | 'aborted' | 'error'`，只增词表，新值不改变既有值的含义；阶段 1 只写前两个。`session/model_selected` 在一次 run 开始时写，记录该 run 实际使用的 provider / model——设置卡里的 `provider.select` 只改 `config.json`，不写 Tape 事实；将来一次 run 内换模型，键补一段 `:<requestSeq>`。`provider/attempt_completed` 的 `contextAtEntryId` 是组装这次请求的上下文时钉住的快照上界（含），`request` 是消息之外决定请求体的那几个参数的快照——`maxTokens` 可能来自 Tape 上没有的环境变量，不记下来这条记录以后就无法复核；`usage` 是 `final: true` 的那一条。
- **重试与失败的表示**：`chat.send` 的 schema 不变，`messageId` 由主进程分配——折叠后的最后一条若是同文本、后面还没有 assistant 回复的 user 消息，就复用它的 `messageId` 与 `revision`（这次 append 因而是幂等的空操作），否则新 `messageId`、`revision: 0`。为了让这条成立，`message/user` 的 payload 与 meta 不得含任何随 run 变化的字段（`runId` 只出现在 `message/assistant` 上）——否则重发就成了「同键不同内容」，抛的是永不被吞掉的 `TapeProvenanceConflictError`。同一 `messageId` 的第二次写入只发生在编辑重发，且 `revision` 必须 +1。**失败的一轮不写 assistant 消息**：失败的证据是 `provider/attempt_completed` 的 `error`；只有中止且已收到部分文本时才写 `message/assistant`（`status: 'aborted'`）。内容为空的 assistant 消息永不写入，重放因此永不产出空的 assistant 轮次（Anthropic 会以 400 拒绝它）。
- **工具事实的身份现在就定，形状留给阶段 2**：阶段 2 的 `tool_call` / `tool_result` 事实同样用 `sourceType = 'runtime_event'`、`sourceId = runId`、`sourceSeq = requestSeq`，`providerToolCallId` 与阶段 4 的 `childOrdinal` 放在 payload 的固定路径，配对键是 `(runId, requestSeq, providerToolCallId)`。`readBySource` 因此取得到「一个 runId 下按身份列归组的全部事实」。`TapeSourceType` 里的 `tool_call` / `tool_result` 留给「以某次工具调用本身为主语」的事实（`sourceId = providerToolCallId`）。对 provider 上下文，工具事实是权威；对渲染，message 的内容块是权威。它们的 name、payload 字段与折叠规则由阶段 2 定，阶段 1 的折叠不处理这两个 kind。
- **`provenance_key` 的语法**：`<namespace>:v<n>:<稳定身份>`，不含进程内计数器、时间戳、随机数。kernel 提供 builder 与校验器，store 拒收不合语法的键。这样同一逻辑事实经 6b 的桥「至少一次」重放时键不变，幂等自然成立。代价要说出口：合法地会重复出现的事实必须自己在键里放区分量，否则第二次静默返回 `created: false`。
- **`SideEffectClass = 'read' | 'write' | 'external' | 'blocked'`**：词表现在定，位置固定为 `execution/tool_outcome` 的 `payload.effect`，阶段 1 无人写入。
- `session/parent_link`（阶段 2 的 subagent：独立 session + 父 Tape 里一条冻结的链接事实）现在只保留名字。`TapeSourceType` 里的 `subagent`、`migration`、`summary` 同理：值先占住，写入方在后续阶段。
- **快照坐标** `SnapshotCoordinate = { incarnationId: string; entryId: number }`。阶段 4 的文件快照是另一回事：它是一条 `fs/snapshot_created` 事实的 payload 里的字符串，文件放在 `profileDir` 下。

### 保留命名空间

机制照抄 DeepChat `reservedNamespaces.ts` 的形状，但覆盖面收紧成**白名单**：实测 DeepChat 的 `view/assembled`、`message/retracted` 和未知的 `view/tool_*` 都能通过通用 append，因为只有 `execution/*` 与 `contract/*` 有前缀保留。

- 第一方前缀全部**按前缀保留**：`session/` `message/` `tool/` `execution/` `contract/` `view/` `provider/` `compaction/` `fs/` `skill/` `plugin/` `audit/`。`context` kind 整族保留给 `skill/`。
- 通用 append 只许写 `ext/<owner>/…`。
- kernel 的 `Tape` 门面按 slice 发放写入器：`tape.writer('message')` 只能写 `message/` 下声明过的名字与绑定的 kind；越界即抛。校验是一个双向断言 `assertAppendAuthorized(input, slice | null)`，内存 store 与测试替身同样经过它。
- 更根本的一层：工具与插件拿不到任何 append 面（阶段 2 给模型的 Tape 能力只有只读的检索）。`apps/*` 的代码不直接调 `TapeStore.append`，只经 kernel 的门面。

### 存储端口

```ts
export interface NewEntry {
  kind: TapeKind
  name: string
  sourceType: TapeSourceType
  sourceId?: string
  sourceSeq?: number
  provenanceKey: string
  payload: Record<string, unknown>
  meta?: Record<string, unknown>
  createdAt: number
}

export interface AppendResult {
  entryId: number
  entryHash: Uint8Array
  /** false = 这个 provenanceKey 已存在且内容一致；不写第二行，不写第二次投影。 */
  created: boolean
}

export interface TapeStore {
  /**
   * 一个事务：逐条分配 entryId、接链、插入、应用投影；整批要么全成要么全不成。
   * 只有这一个写入形状——单条就是长度为 1 的批。租户不是参数：store 构造时绑定
   * HostAdapter.identity，漏掉租户谓词因此是不可能的，而不只是不提倡的。
   * incarnationId 由 kernel 铸造并随每批传入：session 还没有 head 行时，store 用它建行
   * （kernel 保证新 incarnation 的第一条是 session/start）；已有 head 行而 id 不符，
   * 抛 TapeStaleIncarnationError。store 因此从不自己铸 id，也从不自己拼保留名下的事实。
   */
  append(batch: { sessionId: string; incarnationId: string; entries: readonly NewEntry[] }): Promise<AppendResult[]>

  readRange(q: {
    sessionId: string
    fromEntryId?: number // 含
    atEntryId?: number // 快照上界（含）。分页时钉住它，翻页期间的新 append 不会混进来
    incarnationId?: string // 分页时把上一页返回的值原样传回；与 head 不符即抛 TapeStaleIncarnationError
    kinds?: readonly TapeKind[]
    limit: number // 必填，≤ MAX_READ_LIMIT（1000）。端口上没有无界扫描
  }): Promise<{ entries: TapeEntry[]; incarnationId: string; nextFromEntryId: number | null }>
  /** 阶段 2 崩溃恢复要用的读法：一个 runId 下按身份列归组的全部事实，按 entry_id 升序，只走索引。 */
  readBySource(q: { sessionId: string; sourceType: TapeSourceType; sourceId: string; limit: number }): Promise<TapeEntry[]>
  head(sessionId: string): Promise<SessionHead | null>
  verifyChain(q: { sessionId: string; fromEntryId?: number; incarnationId?: string; limit: number }): Promise<{
    incarnationId: string
    checked: number
    firstBadEntryId: number | null
    nextFromEntryId: number | null
  }>

  // 投影读取（界面读的是这些，不是 tape_entry）
  listSessions(q: { limit: number; updatedBefore?: number }): Promise<SessionSummary[]>
  /** 不带游标时返回最新的 limit 条（界面默认读尾部）。 */
  listMessages(q: { sessionId: string; limit: number; afterOrderSeq?: number; beforeOrderSeq?: number }): Promise<MessageRow[]>
  rebuildProjections(sessionId: string): Promise<void>

  /**
   * 物理重置，一个事务：删掉该 session 的全部事实与投影，head 换成新 incarnation
   * （last_entry_id 不减，last_hash 置 NULL，entry_count 归 0），再写入 kernel 拼好的新 session/start。
   * 本租户下没有这个 session 的 head 行时什么都不写，抛 TapeSessionNotFoundError——
   * 重置不能凭空造出一个会话。
   */
  resetSession(q: { sessionId: string; incarnationId: string; start: NewEntry }): Promise<AppendResult>
  /** 物理删除：事实、head、投影、游标。 */
  deleteSession(sessionId: string): Promise<void>
  close(): Promise<void>
}

export interface SessionHead {
  tenantId: string; sessionId: string; incarnationId: string
  lastEntryId: number; lastHash: Uint8Array | null /* 刚建或刚重置 */
  entryCount: number // 当前 incarnation 的事实条数
  createdAt: number; updatedAt: number
}
```

`MessageRow` 与 `SessionSummary` 的字段就是 `message_projection` 与 `session_projection` 的列（去掉 `tenant_id`，camelCase，`content_json` 解析成 `ContentBlock[]`）；contracts 按该 DDL 写 zod。

端口暴露的每个过滤条件都有索引，每个索引都有端口方法用它：`readRange` 按单个 `kind` 过滤走 `tape_entry_by_kind`，多个 kind 走主键的区间扫描；`readBySource` 走 `tape_entry_by_source`。按 `name` 过滤阶段 1 不提供，所以也不建那个索引。

错误（kernel 定义，host 无关）：`TapeProvenanceConflictError`（同键、**不同**内容——不是重试，是 bug 或损坏，循环永不吞掉它）、`TapeTenantMismatchError`、`TapeStaleIncarnationError`（调用方带的 incarnation 已不是 head 上当前的那个）、`TapeIntegerRangeError`、`TapeSessionNotFoundError`、`TapeBusyError`（写锁等到超时；**重试归调用方**，做法是整个 `append` 重来，store 不自动重试）、`TapeReadLimitError`。

端口合同里必须写明的几条：

- **异步**。服务端实现不可能同步；desktop 上异步没有可测的代价（10 万次插入放在一个事务里：better-sqlite3 同步 404 ms 对异步端口 358 ms，复核实测，差值在噪声内；逐条一事务约是它的 5 倍，代价在事务粒度而不在 `await`）。驱动是同步的，调用仍会阻塞调用线程，所以端口只暴露有界操作。两种绑定都已验证能在 `utilityProcess` 与 `worker_thread` 里加载，主线程阻塞真成问题时不换绑定就能搬走。
- **`entryId` 的分配留在端口后面**，kernel 只看到「append 返回一个严格递增、永不复用的 entryId」，不假设无空洞。实现从 `session_head.last_entry_id` 这个高水位分配，不用 DeepChat 的 `MAX(entry_id)+1`：物理重置后 `MAX+1` 会复用 id，让一个陈旧引用指向另一条事实；而高水位的分配（两条语句，见「SQLite 实现约束」的语句顺序）在两种方言里逐字相同，Postgres 上同一 session 的并发写者在一行上串行，不同 session 互不阻塞。
- **幂等的判定**：append 事务先按 `provenance_key` 查重，不分配 id。命中后比较既有行的 `content_hash` **以及** `kind`、`name`、`source_type`、`source_id`、`source_seq`：全部一致返回 `created: false` 与**原来的** `entryId`、`entryHash`，任一不同抛 `TapeProvenanceConflictError`。`created_at` 刻意不比——带着更晚的时钟重放同一条事实仍算幂等。`created: false` 时 `last_entry_id` 不动、投影不再写。写入语句的 `ON CONFLICT … DO NOTHING` 只是兜底。同一批里出现重复的 `provenanceKey` 视为调用方 bug，整批抛 `TapeProvenanceConflictError`。
- **不把 host 类型漏进 kernel**：BLOB 一律以 `Uint8Array` 过端口（better-sqlite3 返回的是 Node `Buffer`，要 `new Uint8Array(buf)`）；整数一律是安全范围内的 `number`，没有 `bigint` 过端口。

### 哈希链

```
field(x)     = u32be( byteLength(utf8(x)) ) ‖ utf8(x)      字符串；整数先写成十进制字符串
field(bytes) = u32be( length ) ‖ bytes                      哈希值按原始字节
field(null)  = 0xFFFFFFFF                                   与任何长度都不相撞

content_hash = SHA-256( field(payload_json) ‖ field(meta_json) )
entry_hash   = SHA-256( field("tenon.tape.v" + hash_ver)
                      ‖ field(tenant_id) ‖ field(session_id) ‖ field(incarnation_id) ‖ field(entry_id)
                      ‖ field(kind) ‖ field(name)
                      ‖ field(source_type) ‖ field(source_id) ‖ field(source_seq)
                      ‖ field(provenance_key) ‖ field(created_at)
                      ‖ field(content_hash) ‖ field(prev_hash) )
```

- **长度前缀拼接**，不是分隔符拼接，也不依赖任何 JSON 转义规则：两条字段内容不同的 entry 不可能拼出同一串字节，任何语言照这几行都能复算。开头的域分隔串带着 `hash_ver`。
- 原像覆盖**每一个**有语义的列，包括三个身份列与 `incarnation_id`：少了身份列，一条改写 `source_id` 的裸 `UPDATE` 之后链照样验得过；少了 `incarnation_id`，同一 session 的两代就哈希不可分。由此得出一条规矩：**以后往 payload 里加字段随便加，往 `tape_entry` 加有语义的列则要升 `hash_ver`**——所以本 spec 不为阶段 4 的字段加列（R5）。
- `payload_json`、`meta_json` 是**存进去的那串文本本身**：kernel 用 `canonicalJson`（键按字典序、无多余空白、拒绝 `NaN` / `Infinity` / `undefined` / `bigint`）序列化一次，store 原样落盘，校验时对存储字节做哈希，永不重新序列化——JSON 规范化因此不在信任面里。所以 Postgres 上这两列也必须是 `TEXT`，不是 `JSONB`（JSONB 会重排键）。
- **内容哈希单独成列**，entry 哈希只绑它的摘要。它在阶段 1 就有读者：幂等冲突的判定比的就是它。它同时是 R2 与 R3 的调和点：将来要对单条事实做内容擦除（合规删除、误贴的密钥）时，可以把 `payload_json` / `meta_json` 换成擦除标记而保留 `content_hash`：`entry_hash` 的链接仍然可验，行不删，链不断。阶段 1 的 `verifyChain` 从存储的 `payload_json` / `meta_json` **重算** `content_hash`（否则验收 12 的字节翻转永远测不出来），所以它会把一条被擦除的行报成坏链。6b 真做擦除时要补两样：一个显式的「已擦除」标记，让校验器对这种行改用 `content_hash` 列；以及把 `BEFORE UPDATE` 触发器改成带闸的。两样都不用升 `hash_ver`、不动已有数据——阶段 1 保证的是这个，不是「擦除免费」。
- **谁来算**：配方是 kernel 的一个同步纯函数 `hashEntry(fields)`；store 在 append 事务里调用它，因为只有那里才知道 `entry_id` 与 `prev_hash`。各 host 各写一份，SQLite 与 Postgres 的链就会分叉，本地 → 云端迁移就断了。
- **SHA-256 用 `@noble/hashes`**（MIT、零依赖、经审计的纯 JS、**同步**），这是 kernel 的新依赖。`node:crypto` 在 kernel 里被 lint 禁用；WebCrypto 的 `digest()` 是异步的，而哈希必须在 better-sqlite3 的同步事务**里面**算。`apps/desktop` 的测试里放一条与 `node:crypto` 的逐字节对拍。
- `hash_ver` 是真的列，能从行上读出来：以后配方要变，是新行用新版本、校验器按行选配方，不是静默断链，也不用两种配方都试一遍。
- 链只在**一个 incarnation 之内**连续；`resetSession` 之后的第一条 `prev_hash = NULL`。
- **诚实的边界**：只追加触发器挡的是程序 bug，不是有 DDL 权限的写者（同一连接上 `DROP TRIGGER` 能成功，已实测）。链让篡改**可被发现**（tamper-evident），不是不可篡改，没有签名，也不提供保密性。阶段 1 只在被要求时校验（`verifyChain`，分页，返回**第一条**坏链的 `entryId` 而不是一个布尔值），不在每次打开会话时校验。

### 删除语义

| 操作 | 投影 | Tape |
|---|---|---|
| 删单条消息 | 物理删该行 | 追加一条 `message/retracted`。**事实还在**：在清空或删除会话之前，被撤回消息的内容仍在磁盘上。以后的界面文案不得把「删除这条消息」说成已抹除 |
| 清空会话 `resetSession` | 清该 session 的投影与游标 | 物理删除该 session 的全部事实，换新 `incarnation_id`，写入 kernel 拼好的新 `session/start`。`entry_id` 继续递增，`entry_count` 归 0 后变 1 |
| 删会话 `deleteSession` | 同上 | 物理删除事实与 `session_head` |
| 无痕会话（入口与 store 路由在阶段 6） | — | 这个会话拿到的是内存 store，从不写进 `sessions.db`。不是一个列：WAL、页缓存都会留下字节，做成列是两头不讨好 |

两条物理路径都要在同一事务里先向 `tape_maintenance` 插一行「开闸」，删完再关；`BEFORE DELETE` 触发器在没有开闸行时中止。这让「只追加，除了两个具名的生命周期操作」是可强制的，而不是一句约定。`BEFORE UPDATE` 触发器无条件中止——合法的原地更新不存在。6b 加 legal hold 时，只需在开闸表上加一个检查 `session_head.legal_hold` 的触发器。

### 投影与重放

- **kernel 拥有 reducer，store 拥有事务。** `project(entry): ProjectionOp[]` 是 kernel 里的纯函数；`ProjectionOp` 是 `{ table: 'message' | 'session'; op: 'upsert'; key; values; insertOnly? }` 或 `{ table; op: 'delete'; key }`，只有标量、固定的表清单、没有表达式。`insertOnly` 里的列只在插入时写，冲突更新时不碰——`created_at` 与 `order_seq` 靠它保持不变，reducer 因此不需要读到当前行。每个 store 在 append 的同一事务里应用这些 op 并推进 `projection_cursor`。不放在 host 侧的理由：验收 3（不变量 12）是 kernel 层的性质，reducer 若住在 `apps/desktop`，kernel 的测试套测不到它，服务端 host 还得再实现一遍，必然漂移。
- 阶段 1 的两张投影表：`message_projection`（界面读消息）与 `session_projection`（当前 provider / model、最后活动时间、`forked_from`）。`order_seq` 是该 `messageId` 第一条 `message/*` 事实的 `entry_id`，修订与撤回都不改它，编辑一条旧消息因此不会让它在界面上挪位置。阶段 1 不写 `title`（列留给阶段 6 的自动命名），界面用首条 user 消息的开头。消息数不做成列：逐条处理、无表达式的 reducer 算不出累计值，要用时从 `message_projection` 现数。两张表可由 `tape_entry` 随时重建，所以故意不加只追加触发器；`PROJECTION_VERSION` 变了就重建。
- **折叠规则**（`effectiveMessages(entries)`，kernel 纯函数）：同 `messageId` 取最大 `revision`；存在更大 `entry_id` 的 `message/retracted` 则该消息不可见。阶段 1 的输入是 `message`、`anchor`，外加 `event` 里的 `message/retracted`（撤回墓碑）；其余 kind 与其余 event 名是只穿透的证据。`tool_call` / `tool_result` 的折叠随它们的形状一起在阶段 2 定。
- **重放** `rebuildProviderContext(store, q: { sessionId: string; atEntryId?: number; target: ModelInfo }): Promise<InternalMessage[]>`：分页读 `readRange`（`atEntryId` 原样传下去），应用折叠规则，不从渲染层的 block 猜语义；`target` 交给 thinking 守卫。一次请求的上下文是 Tape 的一个**前缀**而不是整条 Tape，所以每条 `provider/attempt_completed` 记下自己的 `contextAtEntryId`。阶段 2 加上「从最近的压缩 anchor 往后」。

### SQLite 实现约束（`apps/desktop`）

- **绑定：`better-sqlite3`，精确钉在 `13.0.3`。** 决定性理由是引擎确定性：`node:sqlite` 链接的是运行时自带的 SQLite——vitest 所在的 Node 22.22.0 是 3.50.4，产品所在的 Electron 44.4.1 是 3.53.4（实测），CI 认证的会是另一个引擎，且每次升级 Node / Electron 都会再漂一次；`better-sqlite3@13.0.3` 在 Node 22、Electron 44、`worker_thread`、`utilityProcess` 里都是同一个 SQLite 3.53.4，编译选项集逐字节相同。这是前瞻性的结构风险，不是已观察到的 bug：今天四种组合的特性矩阵完全一致。另两条：`node:sqlite` 在仓库声明的下限 Node 22.12 上仍需 `--experimental-sqlite`（22.13 才免 flag）；它的 JS 层 API 在两个 host 上已经不同（布尔绑定在 Node 22 抛错、在 Node 24 静默成功）。
- **v13 是硬要求**：它把 Node-API 预编译产物放在 npm 包内，文件名不含 ABI，一次 `pnpm install` 同时服务 ABI 127（vitest）与 ABI 149（Electron），不需要 `@electron/rebuild`；v12 在 Electron 44 里会报 `NODE_MODULE_VERSION` 不匹配。**这个版本号同时钉住了 SQLite 引擎版本，改它等于一次影响 schema 的变更**。阶段 0 spec 的技术选型一节只写了 `better-sqlite3`；「限定为 13.x」按上文的 amend 机制记在阶段 0 spec 的 `Amended by:` 行上，正文在这里。
- pnpm：把 `better-sqlite3` 追加进 `pnpm-workspace.yaml` 已有的 `ignoredBuiltDependencies`；`strictDepBuilds: true` 与 `onlyBuiltDependencies: []` 不动。
- 每次打开连接依次执行：`journal_mode = WAL`、`synchronous = NORMAL`、`busy_timeout = 5000`、`foreign_keys = ON`、`cache_size = -16000`。`cache_size` 要显式写：两种绑定的默认值差 8 倍，留成隐式等于让绑定选择偷偷决定页缓存。`synchronous = NORMAL` 的含义要写明——断电可能丢最后几个已提交事务；Tape 的持久性靠的是链加重放，不是逐次 fsync。
- 一次 append 在事务里的语句顺序是定死的（两名评审各自执行过别的顺序，都会坏）：① 先按 `provenance_key` 查重，命中就走幂等分支，**不分配 id**，否则每个重复都会烧掉一个 id 并把 head 写脏；② `UPDATE session_head SET last_entry_id = last_entry_id + 1, entry_count = entry_count + 1, updated_at = ? WHERE … RETURNING last_entry_id, last_hash, incarnation_id`——新 id、**尚未改动的** `prev_hash` 与 incarnation 在同一把锁下一起拿到（session 的第一批先用传入的 `incarnationId` 以 `INSERT … ON CONFLICT DO NOTHING` 建 head 行，这条语句不带 `RETURNING`：冲突时 `RETURNING` 不返回任何行）；③ 调 `hashEntry`；④ `INSERT INTO tape_entry`；⑤ 第二条 `UPDATE` 写回 `last_hash`；⑥ 应用投影 op。**永远不要**把新哈希当作分配语句的绑定输入：那是个环。
- 每次写都是 `BEGIN IMMEDIATE … COMMIT`，catch 里显式 `ROLLBACK`——**每个 store 方法自己负责回滚**。两种绑定都不会自动回滚；触发器 `ABORT` 之后事务仍然开着。`busy_timeout` 对 `BEGIN IMMEDIATE` 之间的锁竞争有效；对 deferred 事务的快照过期（`SQLITE_BUSY_SNAPSHOT`）无效，那种情况 0 ms 就失败——这是必须用 `IMMEDIATE` 的原因。
- 读 `entry_id`、`created_at` 与任何计数器的语句一律 `safeIntegers(true)`，读出后断言在 `Number.MAX_SAFE_INTEGER` 以内再转 `number`，越界抛 `TapeIntegerRangeError`。这是 better-sqlite3 会静默丢数据的地方（超过 2^53 时截断而不报错）。
- 绑定参数里的 `undefined` 显式映射成 `null`（better-sqlite3 会静默绑成 NULL，`node:sqlite` 会抛）；只用位置参数或不带前缀的具名参数。
- 迁移：版本记在 `schema_version` **表**里，两种方言同一条代码路径，不用 `PRAGMA user_version`。迁移编号、只前进、各自一个事务、在任何其他语句之前执行；文件版本高于程序认识的版本时**拒绝打开且不写任何东西**。
- 文件位置 `<profileDir>/sessions.db`（阶段 0 的持久化布局已留这个名字），一个 profile 一个文件。首次创建时写入 `tape_meta.tenant_id`；以后用不同 `tenantId` 的 identity 打开即抛 `TapeTenantMismatchError`。store 在每条语句上绑定 `HostAdapter.identity.tenantId`。
- 打包：`.node` 文件需要 asar unpack 并随应用一起签名公证。electron-builder 的 unpack 检测在其源码里核实过，但仓库还没有打包配置，留到打包 spec 落地时实测。

### DDL（SQLite 方言）

```sql
CREATE TABLE schema_version (version INTEGER NOT NULL PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;  -- 每条迁移插一行；当前版本 = MAX(version)
CREATE TABLE tape_meta (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), tenant_id TEXT NOT NULL) STRICT;  -- 恰好一行

CREATE TABLE tape_entry (
  tenant_id      TEXT    NOT NULL,
  session_id     TEXT    NOT NULL,
  entry_id       INTEGER NOT NULL,
  incarnation_id TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  source_type    TEXT    NOT NULL,
  source_id      TEXT,
  source_seq     INTEGER,
  provenance_key TEXT    NOT NULL,
  payload_json   TEXT    NOT NULL,
  meta_json      TEXT    NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  content_hash   BLOB    NOT NULL,
  prev_hash      BLOB,
  entry_hash     BLOB    NOT NULL,
  hash_ver       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, session_id, entry_id),
  UNIQUE (tenant_id, session_id, provenance_key)
) STRICT;

CREATE INDEX tape_entry_by_kind   ON tape_entry (tenant_id, session_id, kind, entry_id);
-- 末列是 entry_id 而不是 source_seq：readBySource 要按 entry_id 排序，末列换成 source_seq 时规划器会退回主键或加临时 B 树（实测）
CREATE INDEX tape_entry_by_source ON tape_entry (tenant_id, session_id, source_type, source_id, entry_id);

CREATE TABLE session_head (
  tenant_id      TEXT    NOT NULL,
  session_id     TEXT    NOT NULL,
  incarnation_id TEXT    NOT NULL,
  last_entry_id  INTEGER NOT NULL,   -- 高水位：只增不减，重置也不减
  last_hash      BLOB,               -- 当前 incarnation 的链头；刚重置完为 NULL
  entry_count    INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
) STRICT;

CREATE TABLE tape_maintenance (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
  mode TEXT NOT NULL,                -- 'reset' | 'delete'
  opened_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
) STRICT;

CREATE TRIGGER tape_entry_no_update BEFORE UPDATE ON tape_entry
BEGIN SELECT RAISE(ABORT, 'tape_entry is append-only'); END;

CREATE TRIGGER tape_entry_no_delete BEFORE DELETE ON tape_entry
WHEN NOT EXISTS (SELECT 1 FROM tape_maintenance m
                  WHERE m.tenant_id = OLD.tenant_id AND m.session_id = OLD.session_id)
BEGIN SELECT RAISE(ABORT, 'tape_entry delete requires an open maintenance gate'); END;

CREATE TABLE projection_cursor (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, projection TEXT NOT NULL,
  incarnation_id TEXT NOT NULL, last_entry_id INTEGER NOT NULL,
  projection_version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id, projection)
) STRICT;

CREATE TABLE message_projection (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  order_seq INTEGER NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
  content_json TEXT NOT NULL, entry_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id, message_id)
) STRICT;
CREATE INDEX message_projection_by_order ON message_projection (tenant_id, session_id, order_seq);

CREATE TABLE session_projection (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
  title TEXT, provider_id TEXT, model_id TEXT,
  last_message_at INTEGER,
  forked_from_session_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
) STRICT;
CREATE INDEX session_projection_by_updated ON session_projection (tenant_id, updated_at);
```

按 `name` 的索引阶段 1 不建：没有读者，将来加是一条无数据风险的 `CREATE INDEX`。

### Postgres 方言与一致性检查

「同一套**表结构**本地和服务端通用」（主参考 §4.13）成立；「同一套 **DDL** 通用」不成立。单份字面文件技术上能在两边执行，但 SQLite 会给 `BYTEA` 以 NUMERIC 亲和性——写进 `entry_hash` 的字符串会静默变成整数——而能拦住它的 `STRICT` 又拒收 `BIGINT` 与 `BYTEA`。所以是两份文件，差异恰好这些：

| SQLite | Postgres |
|---|---|
| `STRICT` | 无 |
| `BLOB` | `BYTEA` |
| `INTEGER`（id、时间戳、计数器） | `BIGINT`（int4 装不下 epoch ms，实测 `integer out of range`） |
| 触发器 `WHEN NOT EXISTS (子查询)` + `RAISE(ABORT)` | PG 触发器的 `WHEN` 不许含子查询，检查移进 plpgsql 函数体 |
| `?` 占位符 | `$n`（端口只负责渲染占位符，别的方言差异一概不碰） |

两边逐字相同、只写一次的：`INSERT … ON CONFLICT (cols) DO NOTHING`、head 的两条分配语句、`UPDATE … RETURNING`。`ON CONFLICT DO NOTHING` 与 `RETURNING` 永不出现在同一条语句里。schema 里不出现 `AUTOINCREMENT`、`WITHOUT ROWID`、`INSERT OR IGNORE`、`json_extract()`、生成列。

`scripts/check-tape-schema.mjs` 解析两份文件，断言表名、列名与顺序、主键、唯一约束、索引定义在一张登记在案的方言映射表之外完全一致（触发器比的是映射表里登记的**语义**，不是文本——谁也不许为了「消除分叉」而削弱 SQLite 那一侧的触发器）；只改一边即 `pnpm lint` 失败并点名分叉的对象。**这份可移植性证明是静态的**：阶段 1 的 CI 不跑 Postgres。运行时验证属于 6b。

与阶段 0 的关系：阶段 0 spec「被否决的方案」里那条否决的是「**用** `tenant_id` 列**代替**按 profile 分文件」。阶段 1 两样都要：本地的隔离边界仍然是文件；列是为了表结构可移植与纵深防御。两句话不矛盾，但读起来像，所以写在这里。

## 桥帧骨架

`packages/contracts/src/bridge/frame.ts`，约 80 行 zod，文件头注明「skeleton——6b 的第一个真实消费者出现之前 v1 不冻结」：

```ts
const envelope = z.object({
  v: z.number().int().positive(), // 主版本，每一帧都带
  id: z.string().min(1), // 发送方内唯一
  type: z.string().min(1),
  ts: z.number().int(),
  tenantId: z.string().min(1),
  deviceId: z.string().min(1),
  body: z.unknown(), // 信封不解析帧体
})
// 有具体 body schema 的只有五种：
// hello { vMin, vMax, capabilities: string[] } · welcome { v, capabilities: string[] }
// ping {} · pong {} · error { code: 'unsupported-frame' | 'unsupported-version' | 'bad-frame' | 'unauthorized', replyTo?: string }
```

现在就写死的四条规则——它们恰好是事后最难补的：

1. 版本协商：`hello` 报区间，`welcome` 选定一个 `v` 与能力集。新帧种类以 capability 的形式到来，不靠升主版本。
2. 未知 `type` 回 `error{ code: 'unsupported-frame' }`，**永不致命**、永不断连。
3. 帧里的 `tenantId` 是**断言**：服务端从设备凭据重新推导并比对，桌面 worker 无权自选租户。
4. 不含 `/` 的 `type` 保留给协议自身（上面五种）；6b 的业务帧用 `<namespace>/<name>`，与 Tape 的 name 同一套前缀保留规则。**阶段 1 不给任何业务帧起名字**——给语义未定的操作冻结名字，正是这一条要避免的事。

「至少一次还是恰好一次、`provenance_key` 是否跨桥延伸」仍是 6b 的开放问题，本 spec 不替它定。本 spec 只保证一件现在不做以后就补不了的事：`provenance_key` 的语法不含本地计数器、时间戳与随机数，所以它**有资格**充当跨桥的幂等键。

传输方式（出站长轮询 / WebSocket）、鉴权与轮换、重连与重投、离线语义、所有业务帧体，都留给 6b。kernel 不 import 这个文件。

## desktop 接线

- `chat.ts` 删掉内存里的 `history` Map 与直接构造的 SDK 客户端，改为：`ProviderRegistry` 取定义 → desktop 从 `HostAdapter.secrets`（`keyFor(identity, 'provider', <id>, <configKey>)`）读机密、从 `config.json` 读非机密 → `create()` → kernel 的 session service 写 `message/user`、跑一次 `stream`、把增量转成既有的 `chat.event`、结束时写 `message/assistant` 与 `provider/attempt_completed`。
- 阶段 0 的行为全部保留，并改由 Tape 承载：运行在第一个 `await` 之前登记；停止后保留已收到的部分文本（`status: 'aborted'`）；失败的一轮留在记录里（user 消息还在，证据是 `provider/attempt_completed` 的 `error`，不写 assistant 消息）；失败后重发同样的文本是同一条 user 消息的重试而不是第二轮；终态事件发出之前先释放 in-flight。
- `chat.send` / `chat.stop` / `chat.event` 的 schema 不变。`ProviderErrorCode` 到 `chat.event` 错误码的映射：`network → network`、`auth → auth`、`rate-limit | overloaded → rate-limit`、`invalid-request | context-overflow | server → provider`、其余 `unknown`。`StopReason` 到 `done.stopReason` 的映射：`end-turn | stop-sequence | tool-use → 'end-turn'`、`aborted → 'aborted'`、其余（`max-tokens`、`refusal`、`content-filter`、`pause-turn`、`context-overflow`、`unknown`）→ `'error'`；原始的 `StopReason` 记在 `provider/attempt_completed` 里。给这几种情况各自的界面文案要扩这个枚举，留给阶段 6。
- 新 IPC（`packages/contracts/src/ipc/`）：
  - `session.latest({ limit })` → `{ sessionId, messages } | null`，返回最新的 `limit` 条；`session.messages({ sessionId, limit, afterOrderSeq?, beforeOrderSeq? })`。渲染端默认读尾部，启动时恢复最近一个会话；`chat.new` 照旧开新会话。会话列表界面不在阶段 1。
  - `provider.list` → 每个定义的 `{ id, nameKey, configKeys, models, configured: boolean }`（**永不回传机密值**）；`provider.configure({ id, values })`（机密进 keychain，其余进 `config.json`）；`provider.select({ providerId, modelId })`。
  - `config.json` 增加 `provider: { id: string; modelId: string }` 与 `providerConfig: Record<ProviderId, Record<string, string>>`（键名即 `ConfigKey.name`，只放 `secret: false` 的值）；`provider.configure` 对 `providerConfig[id]` 逐键合并。
- 一张由 `ConfigKey[]` 渲染的最小设置卡（账号菜单 → 模型与密钥）：provider 选择、每个 `ConfigKey` 一个输入框（`secret` 用密码框）、模型下拉。文案全部来自 `labelKey` / `nameKey` 对应的目录键。**加一个 provider 不碰渲染端代码**，只在两份 locale 目录里加键。
- **e2e 的机密接缝**：desktop 的 `HostSecrets` 只有真 OS keychain 一条路，而 CI 的 Linux 上没有 Secret Service，开发机上则会往登录钥匙串里写条目。`createDesktopHost` 在 `!app.isPackaged` 且 `TENON_SECRETS=memory` 时换成进程内的内存实现，与现有的 `TENON_DEV_ENV=off` 是同一类开关，由 e2e helper 设置。真 keychain 路径由手动的 `pnpm test:live` 与日常使用覆盖。
- 开发期回落保留：keychain 里没有时，desktop（不是 kernel）读环境变量 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 与 `TENON_MODEL`、`TENON_MAX_TOKENS`（后者覆盖 `ProviderRequest.maxTokens`），新增 `TENON_PROVIDER`、`ZHIPU_API_KEY`。`TENON_MODEL` 命中该定义的 `builtinModels` 时取那份 `ModelInfo`；未命中时 desktop 合成一份保守的（能力位全 `false`、`thinkingPreservationFormat: 'drop'`、`contextLimit` / `maxOutputTokens` 取该定义 `builtinModels` 里各自的最小值，`builtinModels` 为空时取 128000 / 4096）并记一条 warn——owner 日常就是用 Anthropic 兼容端点跑一个不在内置表里的模型。`pnpm test:live` 增加一条走 `zhipu` 定义（OpenAI 兼容端点）的用例，仍然只在 `TENON_LIVE=1` 时运行。

## 不变量

每条都能写成断言或测试。

Provider：

1. 每个流**恰好以一个**终态事件结束（`stop` 或 `error`），它是最后一个事件；`usage` 总在它之前，且写进 `provider/attempt_completed` 的是 `final: true` 的那一条。（Anthropic 线上是 usage 先于 stop，OpenAI 线上是 usage 跟在 `finish_reason` 之后的尾块里——适配器把 `stop` 压到迭代器结束时才发，消费方不必知道。）
2. 中止——无论发生在调用前还是流中途——产出 `stop{ reason: 'aborted' }`，不抛、不产出 `error`；调用前已中止时不触网。
3. `stream()` 不因线上错误 reject；SDK 抛出的错误（含流中途的 error 帧）都变成 `error` 事件。
4. 工具调用按 `index` 归位；适配器保证同一 `index` 的 `tool-call-start` 先于它的任何 `tool-call-args-delta`（OpenAI 线上参数片段可能先于 id 到达，适配器缓冲到 id 与 name 齐了再放行）。
5. 没有 `tool-call-end` 的工具调用**永不执行**。被 `max_tokens` 截断的工具调用在 Anthropic 线上没有 `content_block_stop`，因此没有 `tool-call-end`。
6. 空的工具入参是 `{}`，永不是 `null`，永不是 JSON 字符串。
7. thinking 签名永不改写、永不合成；编码后的请求体里出现的签名，逐字节等于存储的签名。`encode()` 无 I/O 且确定。
8. `packages/kernel/src` 的 provider 文件里没有模块级 `fetch`，没有 `process.env`（lint 禁用全局 `process`）；SDK 客户端一律 `maxRetries: 0`、凭据显式传入——provider 的构造与请求测试在清空了 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 的环境下跑，请求头里的凭据恰好等于传入值。

Tape：

9. `tape_entry` 上的 `UPDATE` 永远失败；`DELETE` 只在**该 session** 有开闸行时成功——闸是逐 session 的，为 A 开的闸删不了 B 的行。每个 store 方法在 catch 里自己 `ROLLBACK`。
10. 同一 session 内 `entry_id` 严格递增、永不复用，`resetSession` 之后也是；`session_head.last_entry_id` 从不减小。
11. 同 `provenanceKey` 同内容的第二次 append 返回 `created: false` 与原 `entryId`、原 `entryHash`，不产生第二行、不写第二次投影、`last_entry_id` 与 `entry_count` 不动；同键不同内容抛 `TapeProvenanceConflictError`，库内容逐字节不变。
12. 对任一 session，由 `tape_entry` 从头重建的投影与增量写出的投影逐行相等。
13. `entry_hash` 由存储字节复算可得；`session_head.last_hash` 等于当前 incarnation 最后一条的 `entry_hash`。
14. 通用 append 写任何保留前缀下的名字（含未声明的兄弟名，如 `execution/anything`）或 `context` kind 都被拒；slice 写入器写别的 slice 的名字被拒。
15. 每条读写语句都绑定 `tenant_id`；store 拒绝 `tenantId` 与文件不符的 identity。
16. 端口上没有无界读取：`limit` 必填且 ≤ 1000。
17. 过端口的值里没有 Node `Buffer`、没有 `bigint`。
18. `packages/kernel` 的依赖里没有 `better-sqlite3`、`electron` 或任何 `node:` 内置模块。

## 验收标准

1. **第二个 provider 不改调用方。** 一个参数化测试用**同一条** kernel 调用路径依次驱动 `anthropic`、`zhipu`、`ollama` 三个定义（`fakeNetwork` 回放录制的 SSE），各自产出符合不变量 1–6 的事件序列与同形的 Tape 事实。同一个测试再在测试文件内现场注册第四个定义并走同一条路径——证明接入一个 provider 需要的只有一份定义。
2. **`encode()` 是纯的。** 同一请求调用两次，`body` 逐字节相同、`promptHash` 与 `toolDefinitionsHash` 相同；`fakeNetwork` 记录到的调用数为 0；`thinkingDecisions` 与守卫规则表逐项一致。
3. **从 Tape 重放能重建 provider 上下文，且与投影一致。** 对一个含 user / assistant 消息、一条修订、一条撤回、两轮对话的会话：把 `rebuildProviderContext()` 钉在每条 `provider/attempt_completed` 自己记下的 `contextAtEntryId` 上，其结果配上该条记录的 `request` 快照与夹具里固定的 system / tools，经 `encode()` 得到的 `promptHash` 等于该条记录的 `promptHash`；重放永不产出空的 assistant 轮次；`rebuildProjections()` 之后的投影表与增量写出的逐行相等。这组断言写在共享的 conformance 套里，对内存 store 与 SQLite store 各跑一遍。
4. **另一个 profile 的数据不可见。** 两个 `tenantId` 不同的 profile 各写一个会话：`sessions.db` 路径不同，各自的 `listSessions` 只见自己的；用 A 的 identity 打开 B 的文件抛 `TapeTenantMismatchError`。更强的一条（服务端预演）：同一个库文件里放两个 `tenant_id` 的行，以 A 绑定的 store 的每个读 API（`readRange`、`readBySource`、`head`、`listSessions`、`listMessages`、`verifyChain`）对 B 的 sessionId 都返回空 / `null`，`deleteSession` 改动 0 行，`resetSession` 抛 `TapeSessionNotFoundError` 且改动 0 行。去掉代码里的租户谓词，这个测试必须变红。
5. 重启 desktop 后，上一次会话的消息仍然显示，继续对话时模型看得到此前的上下文（Playwright：假 provider 服务器断言第二次启动后的请求体含第一次的消息）。
6. 在设置卡里把 provider 从 `anthropic` 换成 `zhipu` 并填入 key 后，下一条消息发往 OpenAI 兼容端点并流式渲染；`provider.list` 的返回里不含任何机密值（Playwright + 假服务器，机密走 `TENON_SECRETS=memory` 接缝）。另有一个 desktop 单测遍历 `ProviderRegistry.list()`，断言每个 `nameKey` 与每个 `ConfigKey.labelKey` 在两份 locale 目录里都解析得到非空串——「加 provider 只加目录键」否则没有任何门禁守着。阶段 0 验收 4（流式 + 停止）在新路径上继续通过。
7. **中止与终态事实。** 流式很慢的 `fakeNetwork` 下，在随机的 200 个时点中止：每次迭代器都正常结束、恰好产出一个终态事件 `stop{ reason: 'aborted' }`、累积的部分文本恰好是中止前收到的；调用前已中止的 signal 产出同样的终态且 `fakeNetwork` 调用数为 0。该请求的 `(runId, requestSeq, physicalAttempt)` 在 Tape 里恰好有一条 `provider/attempt_completed`。
8. **kernel 的 host 无关性。** 在 `packages/kernel/src` 任意文件加一行裸 `fetch(…)`、`new WebSocket(…)`、`process.env['X']`、`import 'undici'` 或 `import 'node:https'`，`pnpm lint` 失败并点出规则名。另有一个测试用 esbuild 以 `--bundle --format=esm --platform=browser` 打包 kernel 入口并断言成功——它抓的是 lint 看不见的、经传递依赖**静态**到达 `node:` 内置模块的情况。用 `browser` 而不是 `neutral`：`neutral` 会在 Anthropic SDK 动态 import 的那几个 `node:` 模块上失败（已实测），`browser` 平台则借 SDK 顶层的旧式 `browser` 字段换成了桩。`packages/kernel/package.json` 不依赖 `better-sqlite3` 与 `electron`。
9. **只追加由数据库强制，且 store 自己负责回滚。** 对 `tape_entry` 的裸 `UPDATE` 与未开闸的裸 `DELETE` 都报错，行还在。回滚另测：让一次写在 **store 自己打开的事务里**失败（一个 `append` 批的第二条抛 `TapeProvenanceConflictError`），断言该批第一条没有落盘、head 没动，随后同一个 store 上的 `append` 仍然成功——裸语句跑在 autocommit 下，引擎会自己收尾，测不出 store 有没有 `ROLLBACK`。`resetSession` 与 `deleteSession` 经开闸行删除成功，闸的 `mode` 分别是 `reset` 与 `delete`，事务结束后开闸表为空。
10. **`entry_id` 是因果时钟。** append 5 条、`resetSession`、再 append：新 `entryId` 大于重置前的所有 id，`incarnationId` 已变，新的 `session/start` 存在，`last_entry_id` 从未减小，带旧 `incarnationId` 的 `append` 与带旧 `incarnationId` 的分页 `readRange` 都抛 `TapeStaleIncarnationError`。两个连接按**显式编排的交错顺序**对同一 session 各 append N 条：所有 `entryId` 互不相同且严格递增、没有丢行、`verifyChain` 通过。`TapeBusyError` 是另一个单独的测试，用一把强制持有的写锁触发——不写「要么等到、要么报忙」这种对时序竞态取或的断言。
11. **幂等回执与冲突。** 不变量 11 的两个分支各一个测试；幂等分支另断言 id 序列无空洞、投影只应用了一次（对 reducer 应用次数的 spy）；「同键同 payload、但 kind / name / source 不同」走冲突分支；同一批内重复的键整批抛错。
12. **哈希链。** `hashEntry` 有一组固定向量把配方钉死，其中一对向量的字段在朴素拼接下会相撞、在长度前缀下不相撞。写入 1 万条后分页 `verifyChain` 报告零坏链，`session_head.last_hash` 等于最后一条的 `entry_hash`；用测试专用手段（去掉触发器）改掉某条 `payload_json` 的一个字节后，`firstBadEntryId` 正是那一条；还原该字节后再次通过。`apps/desktop` 里有一条 `@noble/hashes` 与 `node:crypto` 的对拍。
13. **保留命名空间。** 通用 append 写精确的保留名（`execution/run_started`）、保留前缀下未声明的兄弟名（`execution/anything`、`tool/anything`、`fs/anything`、`view/assembled`、`message/retracted`）、`context` kind 都被拒；slice 写入器只能写自己 slice 声明过的名字与 kind，写别的 slice 的名字被拒。
14. **恢复读取路径存在且只走索引。** `readBySource({ sourceType: 'runtime_event', sourceId: runId })` 按 `entry_id` 顺序返回该 run 的事实；对生成的、带 `ORDER BY entry_id` 的 SQL 做 `EXPLAIN QUERY PLAN`，结果里含 `tape_entry_by_source` 且**不含** `TEMP B-TREE`（字符串匹配——以后谁把索引改名、改了列序或把查询改成了扫描，这个测试就红）。
15. **有界读取与整数安全。** 不带 `limit` 的 `readRange` 是类型检查失败（类型测试夹具）；`limit > 1000` 抛 `TapeReadLimitError`；5000 条的会话钉住 `atEntryId` 逐页读完，拼起来与事先的全量快照相同，翻页之间发生的 append 不混入。`entry_id` 被强行写成超过 2^53 的值时读取抛 `TapeIntegerRangeError` 而不是截断；过端口的值里没有 `Buffer` 与 `bigint`。
16. **thinking 守卫。** 七条判定规则一张表测试，每条断言 `action` 与 `reason`；任何分支下，编码后请求体里出现的签名都与存储的逐字节相同。
17. **两份方言、一套逻辑 schema。** 只改 `tape.sqlite.sql` 的一列、一个索引或一个键而不改 `tape.postgres.sql`，`pnpm lint` 失败并点名分叉的对象。
18. **迁移。** 打开空文件建出 schema v1 与一行 `schema_version`；再次打开是空操作；文件版本高于程序版本时以具名错误拒绝打开，文件逐字节不变。
19. **桥帧。** 未知 `type` 的帧被解析进 `unsupported-frame` 错误路径而不是抛出；`hello` / `welcome` 的版本区间协商（有交集、无交集）各有测试。
20. `pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` 在干净 clone 上全过；`better-sqlite3` 在 CI 的 Linux 与本机 macOS 上都不经编译即可加载，并在 Electron 主进程里能打开库。
21. 手动（`pnpm test:live`，不进 CI）：`zhipu` 定义对真实的 OpenAI 兼容端点完成一次流式对话与一次停止。

## 开放问题

1. **两家 SDK 每次请求都带 `x-stainless-*` 头**（arch、os、运行时及版本、包版本、重试计数）。可经 `defaultHeaders` 去掉，但没测过对服务端重试记账的副作用。阶段 6 做隐私盘点时定；在那之前保持默认。
2. **GLM / Qwen 是否接受回传的 `reasoning_content`** 没有实测，阶段 1 按文档里「仅展示用」的说法设为 `drop`。哪天智谱改用 DeepSeek 式规则，是 `ModelInfo` 的一行改动。接入时用 `pnpm test:live` 探一次。
3. **Windows / Linux 上 `synchronous = NORMAL` 的 fsync 行为**与 macOS 差别不小，本 spec 的耗时数字都来自一台 macOS arm64。不影响选型；做打包 spec 时在三个平台各跑一次 append 基准。
4. **主线程上的同步 SQLite。** 阶段 1 留在主进程。什么时候搬：Playwright 里出现可测的输入延迟，或单次 `append` 的 p99 超过 8 ms。搬的方式是 `utilityProcess`，端口不变。

## 被否决的方案

- **Vercel AI SDK 作为核心抽象**：见「选型」。
- **手写 SSE 解析与各家线协议**：SDK 已经把分帧、类型化错误做对了，手写只会重新踩一遍；host 无关性这个唯一的顾虑已被实测排除。
- **`node:sqlite`**：零依赖很诱人，但测试与生产跑的是两个不同的 SQLite 引擎，且在声明的 Node 下限上还要 flag。两种绑定在探针里由同一个约 40 行的包装驱动，哪天 `node:sqlite` 稳定且两个运行时的引擎收敛了，换过去是端口后面一天的活。
- **`TapeStore` 做成 `HostAdapter` 的成员**：见「所有权与依赖方向」。
- **`MAX(entry_id) + 1` 分配**：物理重置后复用 id；两种方言的并发形状也会分叉。
- **Tape 内分支（fork entry + 合并）**：DeepChat 做过又整体移除了，因为每多一个保留命名空间就要重新定义一次合并语义。
- **清空会话 = 写一个抬高可见下限的 anchor，行留在盘上等清扫**：审计上更漂亮，但本地用户点「清空」的预期是数据没了；6b 的 legal hold 可以在开闸处拒绝物理删除，两头都顾得到。
- **为 `effect` / `run_id` / `request_seq` 单独加列**：payload 本来就被哈希覆盖，`hash_ver` 让配方可演进；`runId` / `requestSeq` 已经有 `source_id` / `source_seq` 这组通用身份列承载，再加专用列是同一个信息存两份。
- **`retention_until` / `legal_hold` 第一天进 schema**：没有写入方；「列不存在」与「列为 NULL」含义相同；加在不参与哈希的 `session_head` 上以后没有代价。
- **哈希直接绑 `payload_json` 原文**：少一列，但堵死了「擦除内容而不破链」。
- **一份字面 DDL 两边通用**：见「Postgres 方言」。
- **哈希原像用 JSON 数组**：够用，但把 JSON 的字符串转义与数字格式拉进了信任面；长度前缀拼接按字节定义，第三方拿任何语言都能复算。
- **一行全局的「允许删除」标志**：比逐 session 的闸少一张表的行数，但实测标志抬起期间不带 `WHERE` 的 `DELETE FROM tape_entry` 能删光整个文件。
- **现在就给桥的业务帧起名字**（`tape.append`、`file.read`…）：这些操作的语义在 6b 的开工前裁决里还是开放问题。
- **provider 自己重试**：kernel 看不见物理请求次数，`requestSeq` / `physicalAttempt` 的区分就没了。
