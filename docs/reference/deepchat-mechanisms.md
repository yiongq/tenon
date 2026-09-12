# DeepChat 源码机制拆解：权限 Broker / Tape / Agent 循环 / MCP v2 host / MCP Apps

> 目标：给用 Electron + TS 自研 agent loop 与 MCP host 的人提供可照抄的设计参考
> 仓库：`ThinkInAIXYZ/deepchat`，Electron + TS + Vue，Apache-2.0
> 版本：commit `4443587`（2026-09-11），package `1.1.2-beta.5`；依赖 `@modelcontextprotocol/client@2.0.0` / `server@2.0.0` / `ext-apps@2.0.0` / `sdk@1.30.0`
> 核对方式：本地 clone 后逐路径 `ls`/`grep`，所有路径相对仓库根。**仓库只有 1 个 squash commit，没有 git 历史可查**，演进证据只来自 `docs/` 和代码注释
> 标注：**[码]** 读源码确认 · **[文]** docs/注释推断 · **[未查到]** 没找到

---

## ⚠️ 先说三个反直觉的结论

1. **模型发起的工具权限不 await Promise。** 待确认写进 transcript，本轮 Run 结束；用户回答后开一个新 Run。应用崩溃重启后弹窗还在，因为它是数据不是内存状态。
2. **工具授权完全不持久化，也没有会话级缓存。** 每次都问。`rememberable: false` 是硬编码，注释原文 "Tool approvals are one-time and intentionally never inherited"。
3. **MCP 的 `readOnlyHint` / `destructiveHint` 注解不参与权限决策，且被刻意拒绝。** 所有 MCP 工具一律按 `write` 处理，因此 MCP 工具永远串行执行。

这三条和 Goose 的选择正好相反（Goose 默认 Auto 全自动、读 readOnlyHint、有 AlwaysAllow 持久化）。两个项目对"权限该多严"给出了光谱的两端，你的产品要在中间选一个位置。

---

# 一、工具权限（最值得抄）

## 分层结构

```
插件声明的工具策略 (allow/ask/deny)      ← src/main/plugin/toolPolicyStore.ts，持久化
        ↓ 只有 ask 或未声明的进 broker
PermissionMode (default/auto_approve/full_access)
        ↓ full_access 直接放行；auto_approve 先过 LLM 审查员
ToolPermissionBroker                     ← src/main/tool/permission/toolPermissionBroker.ts（269 行，薄封装）
        ↓
ApprovalBroker                           ← src/main/approval/approvalBroker.ts（542 行，领域无关的 pending 引擎）
```

## 1. 决策的输入与输出

`src/main/tool/permission/toolPermissionBroker.ts` **[码]**

```ts
type ToolPermissionSource = 'model' | 'mcp-app'

interface ToolPermissionContext {
  conversationId: string
  serverId: string
  configGeneration?: number      // MCP server 配置代次——配置改了，旧授权失效
  bindingHash?: string           // server 非机密绑定哈希
  serverName: string
  toolName: string
  executionId?: string           // 嵌套（programmatic）调用才有
  arguments: unknown             // 原始参数，会被 canonicalize + sha256
  source: ToolPermissionSource
  permissionType: 'read' | 'write'
  permissionMode?: 'default' | 'auto_approve' | 'full_access'
  approvalMode?: 'permission_mode' | 'explicit_user'
  description?: string
}

interface ToolPermissionDecision {
  allowed: boolean
  reason?: 'denied' | 'cancelled' | 'timeout'
}
```

**输出不是 allow/deny/ask 三态枚举**，而是"要不要弹窗 + requestId"。三个入口对应三种调用者 **[码]**：

| 入口 | 调用者 | 行为 |
|---|---|---|
| `evaluateModel(ctx, signal)` | 模型工具调用的预检 | `full_access` 返回 `null`；否则创建 pending，返回 `{ needsPermission: true, requestId, rememberable: false, argumentsHash, argumentsPreview }` |
| `authorizeExecution(ctx, signal)` | 真正执行前的二次校验 | `consumeApproved(match)` 按六元组精确匹配已批准项并**消费掉**；匹配不到再造 pending |
| `requestAppDecision(ctx, onRequest)` | MCP App（iframe）发起 | 这条路径才真的 `await approvals.wait(requestId)` |

**★ 参数哈希绑定** **[码]**：批准时记的是 `argumentsHash`，执行前 `authorizeExecution` 再次核对。用同一个 requestId 批准"改过参数的调用"是不可能的。

## 2. ApprovalBroker：整个文件值得照抄

`src/main/approval/approvalBroker.ts` **[码]**

```ts
type ApprovalDecision =
  | { allowed: true }
  | { allowed: false; reason: 'denied' | 'cancelled' | 'timeout' }

interface ApprovalBinding<TMetadata> {
  domain: string        // 'tool' | 'cli' | 'mcp-app' …
  scopeKey: string      // `tool:${conversationId}`
  operation: string
  effect: string
  bindingKey: string    // JSON.stringify([serverId, configGeneration, bindingHash, toolName, executionId, source, permissionType, approvalMode])
  arguments: unknown
  redactedDisplayData?: JsonValue
  metadata: TMetadata
}
```

实战细节 **[码]**：
- 参数 canonicalize：key 排序、拒绝循环引用 / 非 JSON / 非有限数、深度上限 64、key 上限 10000、体积上限 1MB，然后 sha256
- `deduplicatePending`：同一会话内完全相同的请求复用同一个 pending（模型重复调用不会弹两次）
- 每 scope 最多 64 个 pending（`ApprovalCapacityError`）
- 默认超时 2 分钟，`setTimeout().unref()` 不阻止进程退出
- `attachAbort(signal)`：Run 的 `AbortSignal` 挂到 pending 上，abort 即 `resolve(cancelled)`
- `consumeOnApprove`：批准一次即消费
- 事件 `created / resolved / removed` 用 `queueMicrotask` 广播

tool 权限、CLI mutation guard、MCP App consent 三个域都复用它。**它是领域无关的，你可以原样搬。**

## 3. 主进程如何等用户：写进 transcript，不 await

`src/main/agent/deepchat/runtime/dispatch.ts` → `interactionCoordinator.ts`（1086 行）**[码]**

```
1. 预检返回 needsPermission
   → appendPermissionActionBlock()：在 assistant message 里追加
     { action_type: 'tool_call_permission', requestId, permissionType, executionContractBinding, toolSurfaceBinding }
   → Run 以 paused 结束
2. 渲染进程 IPC: chat.respondToolInteraction
   ToolInteractionResponse = { kind: 'permission', granted }
                           | { kind: 'question_option', optionLabel } | { kind: 'question_custom', answerText } | { kind: 'question_other' }
3. InteractionCoordinator.respond()
   → tryLockInteraction(messageId, toolCallId) 防重入
   → 校验 pendingEntries[0] 必须是被回答的那个（"Interaction queue out of order"）
   → granted：toolPermissionBroker.approve(requestId) 拿 lease
   → deferredToolExecutor.execute()（内部再走 authorizeExecution → consumeApproved）
   → 写回 tool result block
   → 无剩余 pending：turnCoordinator.resume() 开新 Run
```

清理 **[码]**：会话删除 `cancelScope('tool:' + conversationId)` 批量取消；`InteractionCoordinator.dismiss()` 处理"backing run 已不可恢复"的陈旧弹窗，只标 denied 不执行；`InteractionParkingRegistry`（17 行）记录"dispatch 已提交但结果不确定"的 message，禁止再次回答（`DEFERRED_INTERACTION_PARKED_ERROR`）。

契约位置：`src/shared/contracts/routes/chat.routes.ts:74`、`src/shared/contracts/common.ts:374`。

## 4. 不持久化：证据

- **[码]** `toolPermissionBroker.ts:259` `rememberable: false` 硬编码
- **[码]** `src/main/app/sessionPermissionAdapter.ts:78` "Tool approvals are one-time and intentionally never inherited."（fork 子会话时主动 `cancelConversation`）
- **[码]** 命令权限 `commandPermissionCache.ts` 有 session 级 `Map<conversationId, Set<signature>>`，但 `sessionPermissionAdapter.ts:99` 调 `approve(sessionId, signature, false)`——**第三个参数永远 false**，session 缓存代码保留但没有用户入口
- 文件权限 `filePermissionService.ts` 的 `_remember` 参数被忽略，按会话记住路径级别（read/write/all），带 provisional lease
- 会话删除时 `clearSessionPermissions` 一次清空四个服务

**"放弃 server 级 autoApprove 与 session 级权限缓存"确认属实** **[文]+[码]**：
- `docs/architecture/remove-mcp-permission-system/spec.md`（Status: implemented）："Remove MCP-specific permission handling… Do not add a persistent App grant, MCP grant, or parallel permission cache to the broker."
- `src/main/mcp/settings.ts:392` 读取和更新时都 `delete cloned.autoApprove`
- `src/main/plugin/userPluginPackage.ts:202` 插件声明 `autoApprove` 时记 finding "autoApprove is ignored; permissions remain host-owned"
- `src/main/deeplink/index.ts:30` 仍保留 `autoApprove?: string[]` 类型作读兼容 shim

## 5. MCP 注解不可信

- **[码]** `src/main/mcp/toolManager.ts:566` "Server annotations are untrusted hints and must not weaken local execution policy." → 所有 MCP 工具 `execution: TOOL_EXECUTION.write`
- **[码]** `src/main/tool/index.ts:2091` "Remote MCP annotations are not trusted to downgrade host permission checks." → `permissionType: 'write'`
- 后果：`toolExecutionPolicy.ts:42` 只有 `effect === 'read' && mode === 'parallel'` 才并行 → **MCP 工具永远串行**，只有内置 agent tools 能并行。注解只存在 `definition.raw.annotations` 给 UI 看

## 6. auto_approve = LLM 审查员

`src/main/agent/deepchat/runtime/toolPermissionReviewer.ts` **[码]**

最近 8 条消息（每条截 2000 字符）+ 精确动作（含 `actionHash = sha256(stableStringify(envelope))`）送给 `assistantModel`，要求严格 JSON：

```ts
{ actionHash, decision: 'auto_allow' | 'ask_user' | 'block', riskLevel, userAuthorization, rationale }
```

防御性设计：hash 不回显 / JSON 解析失败 / 超时 30s → 一律退化为 `ask_user`；`riskLevel === 'critical'` 强制 `block`，`'high'` 强制 `ask_user`。**审查员的输出本身不被信任。** 对比 Goose 的 permission_judge：思路相同，DeepChat 多了 actionHash 回显校验。

## 关键路径

| 内容 | 路径 |
|---|---|
| 工具权限门面 | `src/main/tool/permission/toolPermissionBroker.ts` |
| **通用 pending/超时/取消引擎** | `src/main/approval/approvalBroker.ts` |
| 权限模式合并 | `src/main/tool/permission/permissionMode.ts` |
| 命令/文件/设置的会话级 grant | `src/main/tool/permission/{commandPermissionService,commandPermissionCache,filePermissionService,settingsPermissionService}.ts` |
| SessionPermissionPort 组装 | `src/main/app/sessionPermissionAdapter.ts`、`src/main/session/contracts.ts:79-103` |
| 预检 / 执行时调 broker | `src/main/tool/index.ts:1040-1060, 1183-1192, 2040-2094` |
| 插件级 allow/ask/deny | `src/main/plugin/toolPolicyStore.ts` |
| LLM 审查员 | `src/main/agent/deepchat/runtime/toolPermissionReviewer.ts` |
| 弹窗写 transcript / 回答后恢复 | `src/main/agent/deepchat/runtime/{dispatch,interactionCoordinator,interactionParkingRegistry}.ts` |
| IPC 契约 | `src/shared/contracts/routes/chat.routes.ts`、`src/shared/contracts/common.ts:374` |
| 设计文档 | `docs/architecture/tool-system.md`、`docs/architecture/remove-mcp-permission-system/spec.md` |

## 取舍

**赚到：**
- 单一 owner、无持久授权 → 没有"配置漂移"和升级迁移问题
- 参数哈希绑定 → 无法用同一 requestId 批准改过参数的调用
- 确认写进 transcript → 崩溃/重启后弹窗仍在，不依赖内存 Promise
- 审查员输出不被信任 → prompt injection 打穿审查员也只能得到 ask_user

**付出：**
- 每次都要点，没有"本会话允许"——体验上比 Claude Desktop 的 "Allow always" 差
- MCP 工具全按 write → 不能并行
- `auto_approve` 多一次 LLM 调用（30s 超时、约 700 token）
- interactionCoordinator 1086 行，恢复语义复杂——这是"写进 transcript"模式的代价

---

# 二、Tape：append-only 事件存储

## 数据模型

单表 `deepchat_tape_entries`，`src/main/tape/infrastructure/sqlite/tapeEntryStore.ts:808` **[码]**

```sql
CREATE TABLE deepchat_tape_entries (
  session_id TEXT NOT NULL, entry_id INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- 'event' | 'anchor' | 'message' | 'tool_call' | 'tool_result' | 'context'
  name TEXT, source_type TEXT, source_id TEXT, source_seq INTEGER,
  provenance_key TEXT,         -- ★ 幂等键，UNIQUE(session_id, provenance_key)
  payload_json TEXT NOT NULL DEFAULT '{}', meta_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, PRIMARY KEY (session_id, entry_id))
```

`source_type` 枚举（`src/main/tape/domain/entry.ts`）：`session | message | assistant_block | tool_call | tool_result | runtime_event | migration | summary | fork | subagent`。事件名走 `name` 列（`execution/run_started`、`provider/attempt_completed`、`message/retracted`、`compaction/auto`…），有多个基于 `json_extract` 的表达式索引。

**[文]** `docs/architecture/tape-system.md`：同一物理序列承载三族语义——Context Tape（消息事实 / anchor / ViewManifest）、Execution Journal（Run / 副作用 / 终态）、Contract lineage（子代理任务契约）。"Tape entry 只能 append。更正、压缩和 handoff 通过新 fact/anchor 表达，不原地改写旧 entry。"

## UI 消息列表怎么来：同事务投影，不是每次 reduce

`src/main/session/data/transcriptProjection.ts:25 TranscriptProjectionApplier` **[码]**：`applyRecord(record)` 把 message fact UPSERT 进 `deepchat_messages` / `deepchat_assistant_blocks`；`applyTapeEntries(rows)` 按 entry 顺序重放（用于 reconciliation / 崩溃恢复）。

哪些行影响有效状态的 reducer 常量在 `src/main/tape/domain/effectiveSemantics.ts`：`EFFECTIVE_VIEW_INPUT_KINDS = ['message','tool_call','tool_result','anchor']`，其他 kind 都是"只穿透的证据"。

**→ 写路径：tape 和投影表在同一个 SQLite 事务里；读路径：UI 直接读投影表。tape 是事实来源，投影可重建。**

## ★ 工具调用身份：三元组 + 两个序号

`src/main/tape/domain/executionJournal.ts:38` **[码]**

```ts
interface ExecutionOperationIdentity {
  runId: string
  requestSeq: number
  providerToolCallId: string
}
interface NestedExecutionOperationIdentity extends ExecutionOperationIdentity { kind: 'nested'; childOrdinal: number }

const EXECUTION_JOURNAL_EVENT_NAMES = ['execution/run_started', 'execution/dispatch_committed', 'execution/tool_outcome', 'execution/run_terminal']
type ExecutionRunKind = 'loop' | 'deferred_tool'
type ExecutionRecoveryClassification = 'not_dispatched' | 'completed' | 'indeterminate' | 'corruption'
```

`src/shared/types/provider-attempt.ts` **[码]**

```ts
interface DeepChatProviderAttemptIdentity {
  readonly logicalRound: number     // 一次模型响应 + 其工具结算循环
  readonly requestSeq: number       // 一份确定的 provider payload + ViewManifest
  readonly physicalAttempt: number  // 该 request 的实际发送次数
}
type DeepChatProviderAttemptOrigin = 'initial' | 'transient_retry'
```

**[文]** `docs/architecture/agent-system.md:80-85` 原文：
> context recovery 改变 payload，因此推进 requestSeq 并把 physicalAttempt 重置为 1；同 payload 的 transient retry 保持 requestSeq，只推进 physicalAttempt。

**[码]** 对应实现 `src/main/agent/deepchat/loop/loopRun.ts:505-630`：`enterLogicalRound` 只 +1 round；`advanceRequestSequence` 把 `requestSeq+1、physicalAttempt=0` 并撤销当前 tool surface；`enterPhysicalAttempt` 仅 `physicalAttempt+1`。provider attempt 幂等 key：`provider-attempt:${sessionId}:${messageId}:${requestSeq}:${physicalAttempt}`。

**为什么工具身份用 `requestSeq` 而非 `physicalAttempt`** **[文]** tape-system.md:143："provider tool call ID 只在该 Run/request namespace 内解释，不能假定跨响应或跨 provider 全局唯一。" 同一 payload 的物理重试不会产生新的 tool call，所以工具身份与 physicalAttempt 无关。

**崩溃恢复语义** **[文]**：`dispatch_committed` 必须位于"所有本地拒绝 gate 之后、真实副作用调用之前"；恢复时分类 `not_dispatched / completed / indeterminate / corruption`；`indeterminate` 输出 `parked` 诊断，**不自动重放**，"后续显式继续执行必须创建新 Run"。Journal 只存 canonical arguments hash 和 `responseHash + isError`，不复制结果文本。

**→ 这套东西解决的问题是：应用在工具执行中途崩溃，重启后要能诚实地说"这个副作用不知道发生没有"，而不是静默重跑。Goose 没有这层。**

## 上下文压缩

`src/main/agent/deepchat/runtime/compactionService.ts`（1417 行）**[码]**

- 触发：`triggerBudget = floor(((contextLength - reserveTokens - extraReserve) / 1.2) * triggerThreshold / 100)`，`triggerThreshold` 默认 **80**（`:990`），`retainRecentPairs` 默认 2，`autoCompactionEnabled` 默认 true
- 保留尾部：`RETAINED_TAIL_INPUT_RATIO = 0.25`、`RETAINED_TAIL_TOKEN_CAP = 20_000`、`SUMMARY_OUTPUT_TOKENS_CAP = 2048`
- **摘要 + 边界锚点，不删除**：写 `anchor` entry（`compaction/auto | manual | context_pressure | resume | migrated_summary`、`auto_handoff/context_overflow`、`summary/reset`）。`CompactionExecutionResult.outcome = 'summarized' | 'boundary_only' | 'unchanged'`——**摘要失败仍可提交 boundary-only anchor**
- **[文]** "Context compact 推进的是 Tape reconstruction boundary 和 provider View，不改写 raw Tape"。第一条 user 消息 pin 为受保护前缀
- 另有 context-pressure preflight（`loop/contextCoordinator.ts:405`，阈值 `contextWindowTokens * 0.99`）和 `tool_result` stub 化

对比 Goose：都是 80% 触发、都不删原消息。Goose 用消息元数据的可见性标记，DeepChat 用 tape 上的边界锚点——**后者更干净，因为"模型看到什么"完全由锚点位置决定，可以回退。**

## 关键路径

| 内容 | 路径 |
|---|---|
| entry / kind / source 类型 | `src/main/tape/domain/entry.ts` |
| SQLite 表与索引 | `src/main/tape/infrastructure/sqlite/tapeEntryStore.ts` |
| **Execution Journal 身份与事实** | `src/main/tape/domain/executionJournal.ts` |
| provider attempt | `src/main/tape/domain/providerAttempt.ts`、`src/shared/types/provider-attempt.ts` |
| 有效视图 reducer | `src/main/tape/domain/effectiveSemantics.ts`、`effectiveView.ts` |
| transcript 投影 | `src/main/session/data/transcriptProjection.ts` |
| 压缩 | `src/main/agent/deepchat/runtime/compactionService.ts` |
| 设计文档 | `docs/architecture/tape-system.md`、`docs/architecture/agent-system.md` |

## 取舍

**赚到：** 单表 + `provenance_key` UNIQUE 让所有写入天然幂等；transcript 是投影 → 可重放修复；Journal 的 committed/outcome 双事实让崩溃后能诚实地说"不知道"；压缩用锚点不改原文。

**付出：** JSON 表达式索引多、查询靠 `json_extract`；三族事实混一张表，靠 name namespace（`reservedNamespaces.ts`）防伪造；domain 层两万多行——**这是全仓库最重的抽象，第一版可以只抄"append-only + provenance_key + 投影表"三件事，Journal 的恢复分类等阶段 4 再上。**

---

# 三、Agent 循环

## 主循环

骨架 `src/main/agent/deepchat/loop/deepChatLoopEngine.ts`（132 行）**[码]**：

```ts
const MAX_TOOL_CALLS = 128

while (true) {
  enterLogicalRound()
  const round = await consumeLogicalRound()      // 调 provider、解析 tool calls
  updateOutput(round)
  if (round.outcome === 'tool_batch' && executed + requested > MAX_TOOL_CALLS) break
  await settleToolBatch()                         // 权限 + 执行 + 写 tape
  await afterRoundPersisted()
  if (settleTurn() !== 'continue') break
}

type DeepChatLoopOutcome = 'terminal' | 'max_provider_rounds' | 'max_tool_calls' | 'halted' | 'thrown'
type LogicalRoundOutcome  = 'terminal' | 'tool_batch' | 'halted'
```

具体实现在 `runtime/deepChatLoopRunner.ts`（2985 行）和 `runtime/dispatch.ts`（3600 行）。`LoopRun`（`loopRun.ts:107`）持有 `runId, sessionId, messageId, abortController, logicalRound, requestSeq, physicalAttempt, messages, activeRequestView / ToolSurface`。

**engine 和 runner 分离** → 循环不变量（round / tool 上限、退出枚举）可以单测，不用起 provider。值得抄。

## 并发、取消、重试、死循环

- **并发** **[码]** `toolExecutionPolicy.ts:selectToolBatchExecutionMode`：只有 `full_access` 且 ≥2 个调用且全部 `effect: 'read', mode: 'parallel'` 才 `Promise.allSettled` 并行（`dispatch.ts:2977`），否则串行
- **取消** **[码]**：Run 自带 `AbortController`；`dispatch.ts` 每步 `io.abortSignal.throwIfAborted()`；透传到 `ToolService.callTool(options.signal)` → `McpClient.callTool(request, { signal })`（`mcpClient.ts:1541`）→ SDK；也挂到 ApprovalBroker pending 上。**解决了 Goose 那个"cancel 后 orphaned tool_use 块"的洞**
- **重试** **[文]** agent-system.md："AI SDK chat stream 显式 `maxRetries: 0`，由 coordinator 统一重试"，每 logical round 最多 2 次 transient retry，每 Run 最多 3 条 context recovery sequence（`loopRun.ts:73`）
- **死循环守卫** **[码]** `noProgressToolLoopGuard.ts`：相同 tool batch 得到相同结果 2 次注入纠正提示，4 次终止（`NO_PROGRESS_TERMINAL_ERROR`）；比较前剥离时间戳 / UUID 等易变字段。**便宜有效，第一版就该有**

## utility process：四个独立入口

| 入口（`src/main/`） | fork 处 | 用途 |
|---|---|---|
| `codeModeUtilityHostEntry.ts` | `tool/codeMode/runCodeRuntimeManager.ts:1147` | `run_code`：每个 code cell 一个新进程，`node:vm`，`--max-old-space-size=64`，`stdio: 'ignore'`，最小 env |
| `backgroundExecUtilityHostEntry.ts` | `agent/shared/process/backgroundExecSessionManager.ts:1547` | 后台 shell / 长进程宿主 |
| `schedulerUtilityHostEntry.ts` | `scheduler/schedulerProcessManager.ts:192` | cron 调度 |
| `fileWatcherUtilityHostEntry.ts` | `platform/fileWatcher/watcherHostClient.ts:152` | 文件监视 |

**[文]** `docs/features/experimental-tool-modes/spec.md:161`："`node:vm` 本身不被描述为恶意代码安全沙箱。隔离边界来自每 cell 独立 UtilityProcess、最小环境、IPC allowlist、V8 内存限制、heartbeat 和强制回收的组合。" 明确"这不是把 UtilityProcess 当成安全沙箱"，Code Mode 要求 `full_access`。

**→ DeepChat 没有 OS 级沙箱。** 这是它和你的路线的最大差异——你有 `@anthropic-ai/sandbox-runtime`，DeepChat 只有进程隔离。

**子代理不是进程** **[码]+[文]**：`src/main/orchestration/liveDelegationService.ts` 实现 "durable live delegation through child Sessions"，子代理是同进程内的子 Session，有 Tape lineage、Handoff、`explicit | proactive` 策略。

## 关键路径

| 内容 | 路径 |
|---|---|
| **循环骨架** | `src/main/agent/deepchat/loop/deepChatLoopEngine.ts`、`loopRun.ts` |
| 轮次 / 工具批处理 | `src/main/agent/deepchat/runtime/deepChatLoopRunner.ts`、`dispatch.ts` |
| 并行策略 / 死循环守卫 | `runtime/toolExecutionPolicy.ts`、`runtime/noProgressToolLoopGuard.ts` |
| utility 进程 | 上表四个 entry + `src/main/tool/codeMode/codeModeUtilityHost.ts` |
| 子代理 | `src/main/orchestration/liveDelegationService.ts` |

## 取舍

**赚到：** engine / runner 分离可单测；no-progress guard 便宜；AbortSignal 贯穿到 SDK；utility process 让 `run_code` 崩溃不拖垮 main。
**付出：** dispatch.ts 3600 行 + runner 近 3000 行，权限 / tool surface / journal 交织；MCP 工具不并行；没有 OS 沙箱。

---

# 四、MCP host（SDK v2）

## Client 用法

`src/main/mcp/mcpClient.ts`（1996 行）只 import v2 包 **[码]**

**Transport**（`:554-720`）：`stdio` → 自定义子类 `RegistryRecordedStdioTransport`（`stderr: 'pipe'`，`maxBufferSize: 10MB`，登记到 `childProcessRegistry`）；`sse` → `SSEClientTransport`；`http` → `StreamableHTTPClientTransport`（带 `authProvider` OAuth）；内置 in-memory server → `InMemoryTransport.createLinkedPair()`。

**Client 构造**（`:726-756`）**[码]**：

```ts
new Client({
  capabilities: {
    sampling, elicitation: { form: { applyDefaults }, url }, roots,
    extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
  },
  versionNegotiation: useModern
    ? { mode: 'auto', probe: { timeoutMs: http ? 20_000 : 8_000, maxRetries } }
    : { mode: 'legacy' },
  inputRequired: { autoFulfill: true, maxRounds: 10 },   // ★ MRTR 交给 SDK 自动续跑
  listChanged: { tools / prompts / resources: { onChanged } },
  defaultCacheTtlMs: 0,
})
```

handler：`sampling/createMessage`、`elicitation/create` 转主进程 UI；`roots/list` 恒返回 `{ roots: [] }`。

**v2 特性怎么用** **[文]+[码]**：
- `resultType`：spec.md:98 "the v2 SDK deliberately consumes that discriminator before returning public result types. DeepChat must not read a private/raw wire field." 代码中确实无读取
- `server/discover`：由 SDK 承担；`mcpClient.ts:1936` 仅诊断里报告 `getNegotiatedProtocolVersion()`
- **→ v2 的协议状态机（MRTR、discover、缓存、listChanged）全在 SDK 里，host 代码不碰。你也不该碰。**

**为什么同时保留 `sdk@1.30.0`** **[文]+[码]**：spec.md:26 "required as a peer by the MCP Apps SDK and isolated to the Apps boundary"。`src/main` 无任何 `@modelcontextprotocol/sdk` import；唯一使用在渲染层 `McpAppView.vue:16-25` 引类型。in-memory servers 用 `@modelcontextprotocol/server@2.0.0` 但走 legacy wire（"v2 SDK does not provide a modern in-memory serving transport"）。

## 工具聚合与命名

`src/main/mcp/toolManager.ts:500-560` **[码]**：默认**不加前缀**，保留原名；只有跨 server 同名冲突时两边都改成 `${serverName}_${toolName}` 并在描述前加 `[serverName]`；最终名必须匹配 `/^[a-zA-Z0-9_-]+$/`，否则跳过。映射表 `toolNameToTargetMap` 记 `{ serverName, originalName, client, definition }`。

对比 Goose 一律 `{ext}__{tool}` 前缀：DeepChat 省 token，但工具名会随其他 server 的加入而变——**模型记住的工具名可能失效。Goose 的做法更稳。**

## 子进程管理

`src/main/mcp/serverManager.ts` **[码]**
- 启动 `:258 startServer` → `McpClient.connect()`；`MCP_STARTUP_SOFT_TIMEOUT_MS = 45s`、`MCP_CONNECT_HARD_TIMEOUT_MS = 5min`
- stderr `'pipe'`，`transport.stderr.on('data')` 只记日志（`mcpClient.ts:697`）——**不像 Goose 那样包进错误对象**
- 崩溃：`client.onclose` → 状态 `stopped` + `reason: 'connect-error'`；**无自动重启**（`serverManager.ts:398` "Retain the inactive client so diagnostics can report the terminal lifecycle until the user restarts or stops it."）。和 Goose 一样
- **运行时不内置**：`src/main/toolchains/service.ts` 按 `resources/runtime-versions.json`（node v24.18.0、uv 0.9.18）按需下载到用户目录，`rewriteToken()` 把 `npx/npm/node/uvx/uv` 重写成已解析的绝对路径，`prependResolvedToEnv` 注入 PATH。环境变量走 `createMinimalProcessEnvironment`（`src/main/mcp/processEnvironment.ts`）。**和 Cherry Studio 的 BinaryManager 是同一思路，可以二选一抄**

## 关键路径

| 内容 | 路径 |
|---|---|
| **v2 client、transport、negotiation** | `src/main/mcp/mcpClient.ts` |
| 生命周期 | `src/main/mcp/serverManager.ts` |
| 聚合命名 | `src/main/mcp/toolManager.ts:500-600` |
| 运行时下载 | `src/main/toolchains/service.ts`、`resources/runtime-versions.json` |
| 设计文档 | `docs/architecture/mcp-v2-protocol/spec.md` |

---

# 五、MCP Apps 嵌入与安全边界（RCE 风险点）

## 三层结构 **[码]**

```
主渲染进程 (Vue, sandbox:false, contextIsolation:true, nodeIntegration:false)
  └─ <iframe src="mcp-app://<instanceId>/sandbox.html" sandbox="allow-scripts allow-same-origin">   ← appHost.ts:278
       └─ 代理页脚本再建 <iframe sandbox="allow-scripts allow-same-origin allow-forms">               ← sandboxProtocol.ts:95
            └─ document.write(appHtml)
```

- **自定义协议** `src/main/mcp/apps/sandboxProtocol.ts:183`：`protocol.registerSchemesAsPrivileged([{ scheme: 'mcp-app', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false } }])`；`protocol.handle` 只服务 `/sandbox.html`，实例过期返 410
- **CSP 响应头**（`:25-43`）：`default-src 'none'; script-src 'self' 'unsafe-inline' <resourceDomains>; img-src 'self' data: blob: …; connect-src <connectDomains 或 'none'>; frame-src <frameDomains 或 'none'>; base-uri 'self'; object-src 'none'; form-action 'none'` + `Permissions-Policy: camera=(), microphone=(), geolocation=(), clipboard-write=()`（按 App 声明开 `(self)`）+ `X-Content-Type-Options: nosniff`
- **代理页自检**：`window.self !== window.top` 且访问 `window.top.location.href` 必须抛错（证明跨源），否则拒绝运行；消息 ≤ 20MB、必须 `jsonrpc: '2.0'`；只接受来自 parent 的 `ui/notifications/sandbox-resource-ready` 一次性注入 HTML
- **宿主 webPreferences** `src/main/desktop/tab.ts:146` `sandbox: false`（注释："禁用沙箱，允许 preload 访问 Node.js API"）；`window/index.ts:685` `contextIsolation: true, nodeIntegration: false`

**⚠️ 安全边界依赖 iframe 跨源 + 自定义 scheme + CSP，而不是 Chromium 进程沙箱。** 主 renderer `sandbox: false` 意味着一旦 App HTML 逃出 iframe 到 renderer origin，就能碰到 preload。你做的时候应该把主 renderer 也开 `sandbox: true`——这是 DeepChat 为了 preload 方便做的妥协，不是必须的。

## 通信桥与工具调用 **[码]**

- 渲染层 `McpAppView.vue:236,350` 用 `@modelcontextprotocol/ext-apps/app-bridge` 的 `AppBridge` + `PostMessageTransport(frameWindow, frameWindow)`
- App 的工具调用经 IPC `mcp.apps.callTool`（`src/shared/contracts/routes/mcp.routes.ts:1299`）→ `src/main/mcp/apps/appHost.ts:293 callTool()`：
  1. `assertLiveInstance`：校验实例归属 webContents
  2. 工具可见性含 `'app'`、插件策略
  3. `permissionBroker.requestAppDecision(... permissionType: 'write')`
  4. 用户拒绝后 `instance.toolAccessSuspended = true`（**防轮询重弹**）
  5. 再次核对 server 绑定 → 调用；结果超 `MAX_APP_TOOL_RESULT_BYTES` 报错
- `prepareAppView`（`appHost.ts:227`）：`validateSource` 校验 messageId / blockId / descriptor / toolInput 与 DB 中持久化的 tool result 一致，再从 server 读 resource（MIME 必须为 `text/html;profile=mcp-app`，恰好一条），CSP / permissions 取自 resource `_meta` 并归一化

## 浏览器权限 **[码]**

`sandboxRegistry.ts:377-434`：default session 上 `setPermissionRequestHandler`——来自 `mcp-app://` 的请求必须匹配实例 webContentsId、在 App 声明的 permissions 内，再逐项弹 consent（2 分钟超时）；`setPermissionCheckHandler` 对 mcp-app 恒 false（**无常驻授权**）。实例 TTL 30 分钟，全局 64 个、每 webContents 32 个。

## 关键路径

| 内容 | 路径 |
|---|---|
| **App 宿主 / 工具调用** | `src/main/mcp/apps/appHost.ts` |
| **自定义协议 / CSP / 代理页** | `src/main/mcp/apps/sandboxProtocol.ts` |
| 实例注册 / 浏览器权限 | `src/main/mcp/apps/sandboxRegistry.ts` |
| 渲染层桥 | `src/renderer/src/components/mcp/McpAppView.vue` |
| 宿主 webPreferences | `src/main/desktop/tab.ts`、`src/main/desktop/window/index.ts` |

## 取舍

**赚到：** App HTML 永远不在 renderer origin 上执行；参数 / 结果 / CSP 全部有 byte 上限；拒绝后挂起防轮询；App 与持久化的 tool result 绑定，防伪造来源。
**付出：** 主 renderer `sandbox: false`（可修）；两套 MCP SDK 共存（仅因 ext-apps peer）；双层 iframe + document.write 的方案没有 Electron 官方背书，是社区实践。

---

# 六、其他目录一句话

- **Provider**（`src/main/provider/baseProvider.ts:43`）**[码]**：`abstract class BaseLLMProvider`，必须实现 `fetchProviderModels / check / summaryTitles / completions / summaries / generateText / coreStream(...)：AsyncGenerator<LLMCoreStreamEvent>`。**streaming 必需**（`completions` 注释 "工具调用仅在 stream 版本中处理"）。事件枚举 `src/shared/types/core/llm-events.ts:164`：`Text | Reasoning | ToolCallStart | ToolCallChunk | ToolCallEnd | PermissionRequest | Error | Usage | Stop | ImageData | RateLimit | ProviderSearch | ProviderUrlSource | Plan`。绝大多数 provider 走 `providers/aiSdkProvider.ts`（Vercel AI SDK），`aiSdk/streamAdapter.ts:220-250` 做 tool call 事件映射；不支持原生 function call 的用 `aiSdk/middlewares/legacyFunctionCallMiddleware.ts` prompt 模拟。具体类 6 个（aiSdk, acp, apimart, githubCopilot, ollama, voiceAI），`providerRegistry.ts` 用 9 种 `AiSdkProviderKind` 注册约 56 个 provider id。**→ 和 Goose "7 份手写 format" 相反：DeepChat 把 wire format 差异外包给 Vercel AI SDK。TS 项目这是更省事的路线，代价是受 AI SDK 的能力边界限制（thinking 签名、cache_control 等要看它支持到什么程度）**
- `src/main/approval/`：领域无关的 pending 审批引擎 + CLI 侧 `approvals.resolve` 路由
- `src/main/hook/`：Claude Code 风格外部命令钩子，事件 `SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | PostToolUseFailure | PermissionRequest | Stop | SessionEnd`（`hook/events.ts:45`），30s 超时，**只做通知/观测不改变决策**
- `src/main/skill/`：SKILL.md 技能包的发现 / 导入 / frontmatter / 执行授权（skill 脚本需绑定 Run 的 ViewManifest 才可 spawn）
- `src/main/plugin/`：插件包（MCP server 声明、工具 allow/ask/deny 策略、CUA 适配器）
- `sandbox`：**没有独立目录**；沙箱语义分布在 `mcp/apps/sandbox*.ts`（MCP App）和 `tool/codeMode/`（run_code utility process）

---

# 结论：抄什么

## 1. 照抄 `approvalBroker.ts` 整个文件

它是领域无关的：参数 canonical hash、dedupe、scope 容量、abort / timeout 清理、事件广播。TS 写的，直接搬。Goose 的 `ToolConfirmationRouter` 只是 `Map<id, oneshot>`，这个是它的完整版。

## 2. 抄"权限请求写入 transcript、Run 暂停、回答后新 Run"的模型

比 await Promise 复杂，但它是唯一能让"应用重启后待确认还在"的做法。Claude Desktop 的行为也是这样（关掉再开，权限弹窗还在）。**但不要抄 interactionCoordinator 的 1086 行**——第一版只需要：写 block → Run 结束 → 回答 → 校验 pending 头部 → 执行 → 新 Run。

## 3. 抄 tape 的三件事，不抄第四件

抄：append-only 单表、`provenance_key` UNIQUE 幂等、同事务投影表。
暂不抄：Execution Journal 的 `dispatch_committed / tool_outcome` 双事实和四态恢复分类——等阶段 4 有真实副作用工具了再上。但**现在就把 `(runId, requestSeq, providerToolCallId)` 定成工具调用的身份，`requestSeq` 和 `physicalAttempt` 分开**，后面加 Journal 不用改身份。

## 4. 权限严格度：在 DeepChat 和 Goose 之间选

| | DeepChat | Goose | Claude Desktop（观察到的行为） |
|---|---|---|---|
| 默认 | 每次问 | 全自动 | 每次问 |
| 持久化 | 无 | AlwaysAllow/NeverAllow | "Allow always"（按工具） |
| 读 readOnlyHint | 不读，不信 | 读 | 未知 |
| LLM 判官 | auto_approve 模式 | SmartApprove 模式 | 无 |

建议：默认每次问 + 按 `(server, tool)` 的 "Allow always" 持久化 + **不信 readOnlyHint**（DeepChat 的理由站得住：注解来自远端，不该削弱本地策略）。这比 DeepChat 松、比 Goose 严，和 Claude Desktop 一致。

## 5. MCP Apps：抄结构，改一处

抄：自定义 scheme + CSP 头 + 双层 iframe + 代理页跨源自检 + 拒绝后挂起。
改：主 renderer 开 `sandbox: true`。DeepChat 关掉它是为了 preload 方便，你没有这个包袱。

## 6. 不抄的

- 工具不加前缀的命名策略（Goose 的 `{ext}__{tool}` 更稳）
- 三千行的 dispatch.ts（它的复杂度来自 Journal + 权限 + tool surface 三者交织，你分阶段上就不会长成这样）
- MCP 工具一律串行（你信自己的沙箱，可以让 read-only 工具并行）
