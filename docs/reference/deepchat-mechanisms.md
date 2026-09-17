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

## 二之补：ViewManifest / 保留命名空间 / entry_id 并发 / 分支 / 删除 / Execution Journal

> 复核 commit `c66b36d65b59251ef1cf109e2f608387cabaeea3`（2026-09-17 15:36:29 +0800，`fix(provider): initialize validation drafts (#2316)`，package `1.1.2-beta.5`），比本笔记其余部分所依据的 `4443587` 晚 6 天。
> 只补上文「二、Tape」未覆盖的部分：表结构、provenance_key、投影表、tool-call identity、compaction anchor 见上文。
> 主要文档：`docs/architecture/tape-system.md`（454 行）、`docs/architecture/durable-execution-journal/spec.md`（363 行）。
> 本节的并发行为与命名空间断言是在 Node v22.22.0 / macOS arm64 上用 `better-sqlite3-multiple-ciphers@13.0.3`（DeepChat 自己 pin 的版本）与 esbuild 打包后的原函数实测的，不是推断。

### 1. ViewManifest：一次 provider 请求的全部凭据

**字段**（`src/shared/types/tape-view-manifest.ts:112-130`）**[码]**。Base 共 18 个字段：

```ts
viewId, sessionId, messageId, requestSeq, taskType, policy, policyVersion,
contextBuilderVersion, latestEntryId, anchorEntryIds, reconstructionAnchorEntryId?,
included[], excluded[], excludedRanges?, tokenBudget, hashes, meta, assembledAt
```

- `taskType`：`chat | resume | tool_loop`；`policy` 7 个枚举（`cache_aware_context_v2/v1`、`legacy_context_v1`、`legacy_context_shadow`、`resume_shadow`、`tool_loop_shadow`、`context_pressure_recovery_shadow`）
- `included[]` 每项 = `{ entryId|null, messageId|null, orderSeq|null, role, source: 'tape'|'synthetic', reason, sourceEntryIds?, contentHash? }`，`reason` 10 种（`system_prompt`/`summary_checkpoint`/`reconstruction_checkpoint`/`memory_context`/`directive_context`/`pinned_first_user`/`selected_history`/`new_user_input`/`resume_target`/`tool_loop_message`）
- `excluded[]` 的 7 种理由（`before_summary_cursor`/`compaction_indicator`/`pending_not_context_history`/`out_of_budget`/`empty_after_formatting`/`superseded`/`retracted`），连续区间压成 `excludedRanges`
- `tokenBudget` 6 个数（contextLength / requestedMaxTokens / effectiveMaxTokens / reserveTokens / toolReserveTokens / estimatedPromptTokens）
- `hashes` = `{ promptHash, toolDefinitionsHash, manifestHash }`；`meta` = `{ providerId, modelId, summaryCursorOrderSeq, supportsVision, supportsAudioInput, traceDebugEnabled }`

schema 演进是叠加而非改列（同文件 `:133-222`）：1–4 legacy → 5（`hashVersion: 3`，`executionContract` **必填**）→ 6（`hashVersion: 4`，+`runId` +`tapeIncarnationId` +`skillContexts`，`executionContract` 转为可选）→ 7（`hashVersion: 5`，runtime-view skillContext 多一个 `executionRef`）。

**什么时候写一条**：每份**确定的 provider payload** 写一条 `view/assembled`（`viewManifest.ts:52`），以 requestSeq 标识；context recovery 改变 payload 就新 requestSeq + 新 manifest，**transient retry 复用原 manifest**（`tape-system.md:263-266`）**[文]**。落盘信封是 `source = { type:'runtime_event', id: messageId, seq: requestSeq }`、`created_at = assembledAt`、`idempotent: true`，payload `{ name, data:{ manifest } }`（`viewReplayService.ts:577-600`）**[码]**。

**requestSeq 不是 Tape 分配的**：它是 LoopRun 的计数器，`advanceRequestSequence(run)` 自增时同步把 `physicalAttempt` 归零、解绑 activeRequestContract / View / ToolSurface（`loopRun.ts:514-525`）；调用点 `contextCoordinator.ts:1109`，前后各一次 "Provider request sequence changed during View assembly" 的 compare 检查（`:1107`、`:1111`）。所以 requestSeq 是 **Run 内序号，不跨 Run 唯一**，Journal 的 operation identity 必须带 runId 才能定位。**[码]**

**provenance_key 两种形态**（`viewReplayService.ts:49-71`）**[码]**：

```
schema ≤5 : view:${sessionId}:${messageId}:${requestSeq}:${manifestHash}
schema 6/7: view6:|view7: + hashJsonData({ sessionId, tapeIncarnationId, runId, requestSeq })
```

后者**不含 manifestHash**——同一 `(incarnation, run, requestSeq)` 只允许一条 Skill-bearing manifest，重复写必须逐字节相等，否则 `Conflicting Skill-bearing ViewManifest binding.`（`:618`），连 kind/source/created_at/payload/meta 的物理信封都逐项比对（`requireEqualSkillManifestRow` `:603-628`、`requireSkillManifestEnvelope` `:629-658`）。

**失败策略分叉**（`contextCoordinator.ts:1158-1241`）**[码]**：`failurePolicy` 的条件是 `input.strictViewContract || input.requireDurableManifest || requiresDurableSkillManifest` → `fail-closed`，否则 `fail-open`。普通请求写不进去时的降级是**把 executionContract 置 null 继续**，并记 "ExecutionContract disabled for request N because durable provider View provenance could not be confirmed"。

**replay 怎么用它**：manifest 只存引用与证明，不存正文（"manifest 只保存引用与证明，不成为内容 sidecar"，`tape-system.md:15`）。join 键是 `included[]` 的 entryId/messageId/orderSeq + contentHash；synthetic contribution 只留 `sourceEntryIds` + `contentHash`，原文不复制。事实侧由 `buildEffectiveTapeView`（`effectiveView.ts:181`）从 kind ∈ {message, tool_call, tool_result, anchor} 加上 `message/retracted` 折叠出 effective 视图（`effectiveSemantics.ts:6, 23-28`），`getViewManifestSourceMaps` 提供四张查找表：entryIdByMessageId / messageContentHashByMessageId / toolCallEntryIdByToolId / toolResultEntryIdByToolId，外加 latestEntryId、anchorEntryIds 与 reconstruction anchor（`viewReplayService.ts:304-360`）。replay 的硬约束在 `tape-system.md:428-431`：必须保住 entry order、role、tool call/result 配对、anchor cursor、policy version、builder version、synthetic provenance；原则一句话在 `:389`——"replay 从 manifest 和 facts 重建 provider-visible context，不从 renderer block 猜测执行语义"。

> ⚠️ 仓库里**没有**"喂一个 manifest 就吐回 provider messages 数组"的函数。`TapeViewReplayService` 的 20 个方法全是 reader / append / 绑定校验；连 docs 点名的纯逻辑文件 `src/main/tape/domain/replay.ts`（301 行）也只导出 `isTapeViewManifest` / `normalizeStoredTapeViewManifest` / `hashString` / `isPositiveInteger` / `collectEntryIds` 五个校验与规范化函数。replay 侧只有 reader + 完整性校验：`verifyTapeViewManifestHash` 返回 `valid | invalid | unverified`，hashable = stored 字段去掉 `assembledAt`/`viewId`、`hashes` 缩成 `{promptHash, toolDefinitionsHash}`（`tape-system.md:433-435`）。被篡改的 manifest 会被标 `invalid` 但**照样返回**（测试名：`test/main/session/data/tapeViewReplay.test.ts:1320` "annotates read records with hash integrity without dropping tampered manifests"）。**[码]**

### 2. reservedNamespaces：一个 139 行的文件挡住**大部分**伪造

`src/main/tape/domain/reservedNamespaces.ts` **[码]**。六个 slice，每个声明 `names / kind? / reservesName? / auditEvents / 两条拒绝文案`（:22-87）：

| slice | 保留的 name | 绑定 kind | 前缀保留 | audit（默认排除出 view/search） |
|---|---|---|---|---|
| `execution` | `execution/{run_started,dispatch_committed,tool_outcome,run_terminal}` | — | `startsWith('execution/')` | 是 |
| `contract` | `contract/{task_frozen,evaluated}` | — | `startsWith('contract/')` | 是 |
| `tool-surface` | `view/{tool_catalog,tool_surface,programmatic_tool_surface}` | — | 否（仅精确名） | 是 |
| `skill-materialized` | `skill/materialized` | **`context` 整个 kind** | 否 | 否（kind 本身就被读者跳过） |
| `provider-attempt` | `provider/attempt_completed` | — | 否 | **否**（最新一条要喂 `tape_info` 的 cache 指标） |
| `compaction-usage` | `compaction/model_call_completed` | — | 否 | 是 |

防伪造是**双向**的，一个函数 `assertTapeAppendAuthorized(input, authorizedNamespace)`（:104-118）：strict writer（带 namespace）只能写自己声明的 name 且 kind 匹配，越界抛 `Unsupported ${strictRejection}: ${name}.`；generic append（namespace = null）命中任一 slice 就拒，命中方式三种——精确 name、`reservesName` 前缀、保留 kind。

**把这个函数 bundle 出来实际跑了一遍**，结果如下（`ALLOWED` = 该 generic append 不会被这层挡住）：

```
REJECTED | generic append of execution/run_started      -> The execution/* namespace is reserved ...
REJECTED | generic append of UNKNOWN execution/foo      -> The execution/* namespace is reserved ...
REJECTED | generic append of contract/whatever          -> The contract/* namespace is reserved ...
REJECTED | generic append of view/tool_surface          -> The View Tool Surface namespace is reserved ...
ALLOWED  | generic append of view/tool_MADEUP
ALLOWED  | generic append of view/assembled (ViewManifest)
REJECTED | generic append of ANY context kind
REJECTED | generic append of provider/attempt_completed
REJECTED | generic append of compaction/model_call_completed
REJECTED | execution writer appending contract/task_frozen -> Unsupported Execution Journal event name: ...
REJECTED | skill writer appending skill/materialized on kind=event -> Unsupported Skill materialization fact: ...
ALLOWED  | generic append of message/retracted
```

**要点：`view/assembled` 不在任何保留 slice 里**，`view/*` 没有前缀保留（只有 `execution/*` 和 `contract/*` 有），`message/retracted` 也不在。也就是说保留命名空间挡的是 Journal / Contract / tool-surface / materialization / provider-attempt / compaction-usage 这六类**审计与执行证据**，**ViewManifest 与 retraction 靠的是别的机制**：manifest 的 `manifestHash` 自校验 + Skill-bearing 的信封逐项比对，retraction 靠它本来就没有 provenance key、幂等为 false、只影响 fold。设计上说得通（manifest 伪造会被 hash 校验标 `invalid`），但**不要**把「有 reservedNamespaces 就没法伪造任何 fact」写进 Tenon 的 spec。

谁能拿到 strict writer：`appendInternal(input, namespace)` 是 **protected**，public 的 `append()` 永远传 `null`（`tapeEntryStore.ts:851-853`）；能传 namespace 的只有两类——基类上的专用方法（`appendSkillMaterialization(...,'skill-materialized')` :946-966、`appendProviderAttemptEvent` :1002、`appendCompactionModelCallEvent` :1024、`appendToolSurfaceEvent` :1046），和**独立子类**：`DeepChatExecutionJournalStore extends DeepChatTapeEntriesTable` 只多一个 `appendExecutionJournalEvent(...,'execution')`（:1927, :2299-2319），`DeepChatContractStore` 同理（:2322-2340）。这两个方法在 port 层也确实**不在** `TapeEntryStore`（`ports/storage.ts:57-151`）上，而在 `ExecutionJournalPersistenceStore`（:197-226）和 `ContractPersistenceStore`（:229-235）上——journal spec:118-120 的 "The native append operation is absent from the generic `TapeEntryStore` capability." 是真的。注释也写明这个断言跑在"每个 Tape store 实现，包括 test double"里。

**模型侧根本没有 append 能力**：`tape-system.md:391-399` 说模型只可调用 `tape_search`（授权 view 内查找）和 `tape_context`（读周边上下文），`tape_info`/`tape_anchors` 是 diagnostic，`tape_handoff` 是 runtime-only，五个名字全 reserved、MCP 不能 shadow。**[文]** 这才是"工具/插件伪造不了 fact"的第一道也是最强的一道门——它们拿不到写入面。

审计位是声明式的：`RESERVED_AUDIT_TAPE_EVENT_NAMES` 由带 `auditEvents` 的 slice `flatMap` 出来（:95-97），实测正好 10 个名字（execution 4 + contract 2 + tool-surface 3 + compaction 1）。

### 3. entry_id 分配与并发写者

**分配**：`entry_id = MAX(entry_id) WHERE session_id = ? + 1`，读与 INSERT 在同一个 `this.db.transaction(...)` 里（`tapeEntryStore.ts:855-873`、`getMaxEntryId` :1635-1644）**[码]**。**per-session 单调，非全局**；主键 `PRIMARY KEY (session_id, entry_id)`（:820）。reset 后从 1 重新开始——所以跨"世代"的引用必须配 `tapeIncarnationId`，那是 bootstrap anchor（`session/start`）meta 里的 `randomUUID()`（`ensureBootstrapAnchor` :1063-1098，key 名见 `domain/entry.ts:9`）。

**幂等**：带 `idempotent:true` 且有 provenance_key 时，事务内**先查一次、INSERT 抛错后再查一次**，命中即返回既有行（:862-924）。兜底是唯一索引 `idx_deepchat_tape_entries_session_provenance ON (session_id, provenance_key) WHERE provenance_key IS NOT NULL`（:249-251）。

**两个写者**：DeepChat 结构上不存在这个场景——单实例锁（`appMain.ts:84`）、主进程一条共享 SQLite 连接（`tape-system.md:56` mermaid 的 `Shared Session SQLite connection`）、better-sqlite3 全同步，进程内不会交错；`test/main/session/data/` 下 11 个 tape 测试文件里没有并发 append 测试。

我用 **`better-sqlite3-multiple-ciphers@13.0.3` 本体**、按 `connectionConfig.ts` 的 pragma（WAL + `synchronous=NORMAL` + `cache_size=-65536`）、按 `db.transaction()` 实际用的 `BEGIN`（= DEFERRED，见 `lib/methods/transaction.js:42`）复现了"真有两个连接"的行为 **（执行验证）**：

```
Case 1  两个 DEFERRED 事务同读 MAX=0，都要写 entry_id=1，provenance 不同
        A committed entry_id 1
        B failed after 0ms: SQLITE_BUSY_SNAPSHOT - database is locked
Case 2  B 整个事务重来：saw max 1 -> committed entry_id 2        （重试即正确）
Case 3  顺序写入同一个 provenance_key
        SQLITE_CONSTRAINT_UNIQUE - ... deepchat_tape_entries.session_id, provenance_key
Case 3' 顺序写入同一个 (session_id, entry_id)、provenance 不同
        SQLITE_CONSTRAINT_PRIMARYKEY - ... deepchat_tape_entries.session_id, entry_id
Case 4  A 持有 BEGIN IMMEDIATE，B 也 BEGIN IMMEDIATE
        B blocked 5188ms then: SQLITE_BUSY - database is locked
```

三条结论，**都和直觉不一样，值得抄进 Tenon 的 storage port 设计**：

1. WAL 下真正挡住 MAX+1 竞争的**不是复合主键，是快照检查**：B 的读快照在 A 提交后已过期，升写锁时直接 `SQLITE_BUSY_SNAPSHOT`，INSERT 根本没发出去，主键约束没机会触发。主键只在"顺序两次写同一个 entry_id"时才报 `SQLITE_CONSTRAINT_PRIMARYKEY`。
2. **better-sqlite3 默认的 5000ms busy timeout 对这种冲突完全无效**——0ms 就失败了（SQLite 对 `SQLITE_BUSY_SNAPSHOT` 不调用 busy handler，等待也没用）。只有纯锁争用（Case 4）才真的等满 5s。所以"有 busy timeout 就能自动扛并发"是错的。
3. 不会写坏，但**也不会自动重试**——DeepChat 没有重试循环，因为它假定单写者。Tenon 若要支持两个写者，重试必须**整个事务重来**（Case 2），不能只重发 INSERT。

**事务纪律**：`runInTransaction` 直接 `db.transaction(op)()`（:842-844），可嵌套并自动退化为 SAVEPOINT——`clearMessages` 就靠它把 Tape reset 挂进外层事务（`tape-system.md:109-110`）。Execution Journal 反过来**拒绝**加入宿主事务：`if (table.isInTransaction()) throw new ExecutionJournalError('Cannot persist ${name} inside an active host transaction.', 'persistence_failed')`（`executionJournalService.ts:456-461`），理由是"它记录已越过外部副作用边界的事实"（`tape-system.md:97-100`，配 `:128-136` 的事务纪律表）。

**索引**（`tapeEntryStore.ts:175-252`）共 **11 个** **[码]**：

- 4 个普通复合：`session+kind+entry`、`session+name+entry`、`session+created_at+entry`、`session+source_type+source_id+source_seq`
- 6 个局部索引，其中 **4 个是 `json_extract` 表达式索引**（compaction attempt、provider context-pressure、execution operation payload、execution message payload），**2 个是纯列局部索引**：`idx_..._event_name ON (name, session_id, entry_id) WHERE kind='event'`，以及 `idx_..._execution_run ON (name, session_id, source_id, entry_id) WHERE kind='event' AND source_type='runtime_event'`
- 1 个唯一局部索引：`(session_id, provenance_key) WHERE provenance_key IS NOT NULL`

注意 `execution_run` 这个**恢复扫描用的索引走的是列（`source_id` = runId），不是 JSON**——这正是把 runId/requestSeq 放进 `source_id`/`source_seq` 列而不是只放 payload 的回报；`execution_operation_payload` / `execution_message_payload` 才是 `json_extract('$.data.operation.runId')` 之类的表达式索引，属于后来按需补的查询加速。

### 4. 分支：DeepChat 现在没有分支

三条路各自的表示 **[码]**：

| 操作 | 路由 | Tape 表示 |
|---|---|---|
| 编辑并重发 | `sessions.editUserMessage`（`sessions.routes.ts:611-621`） | 同一个 `messageId` 追加一条 correction message fact（`name = message/${role}`、`meta.correction = true`、`meta.reason = 'message_content_updated'`、`revisionKind = 'record'`、`idempotent: true`），effective view 取最新（`transcript.ts:607-620` → `factPersistence.ts:569-630`） |
| 重新生成 / 重试 | `sessions.retryMessage` | 算 `retryFromOrderSeq`（target 是 user 则 `orderSeq + 1`，保住原 prompt），`deleteFromOrderSeq` 把其后消息**逐条 retract**，再跑新 Run（`transcriptMutations.ts:43-99`、`transcript.ts:653-664`） |
| Fork | `sessions.fork` | **新建一个 Session**（`lifecycle.ts:488-558`），复制 `status='sent'` 且非 compaction 的前缀，每条**重新 `nanoid()`、order_seq 从 1 稠密重排**，再逐条 `commitRecord` append 成新 Session Tape 的 message fact（`transcript.ts:769-810, 919-923`） |

所以：没有 `source_type:'fork'` 的新写入，Tape 里没有 parent 指针，旧回答也不作为"版本"留存。`DeepChatTapeSourceType` 枚举里确实还留着 `'fork'` 和 `'subagent'`（`domain/entry.ts:11-21`），但全仓 `fork/` 的出现位置只有 4 处，**全部是读路径**：`lineageService.ts:222` 解析历史 `fork/merge`、`traceInspectorProjection.ts:54,317,321,953` 做 lineage family 归类、`tapeEntryStore.ts:1411` 一条 `name IN ('subagent/tape_linked','fork/merge')` 的读 SQL。**没有任何写入方。[码]**

**Session ↔ Tape 是 1:1**：`create` 后立刻 `initializeSessionTape(id)`、`delete` 时 `deleteSessionTape(id)`（`session/data/settings.ts:166,173-176`），表按 `session_id` 分区，全仓**没有 `tape_id` 这个标识符**。Subagent 同样是"独立 Session + 独立 Tape + 父 Tape 一条 frozen head link"（`tape-system.md:406-416`）。

**UI 的"版本翻页"是死代码**：`MessageItemAssistant.vue:415-431` 还留着 `variants` / `is_variant` 的翻页与计数，但 `useDisplayMessages.ts:128,199` 把 `is_variant` 硬编码为 `0`，`DeepChatMessageRow`（`tables/deepchatMessages.ts:4-16`）根本没有这一列——`parent_id` + `is_variant` 只属于旧 `messages` 表（`tables/messages.ts:17,26`），是 legacy import 的遗留。**[码]**

**值得抄的一段告诫**（`tape-system.md:418-424`）**[文]**：v1.0.5–v1.0.9 的 `fork/merge` / `fork/discard` 只作只读兼容；而真正的同 Tape 内并行探索（`fork/start` anchor + 复制 delta + merge receipt）"从未接入产品路径，其 merge 语义也未覆盖后来新增的 reserved namespace，已整体移除；若将来需要，必须为每个 reserved namespace 重新定义合并语义，而不是恢复旧实现"。——append-only + 多命名空间的 store 里，分支合并不是加个 parent 指针的事。

### 5. 删除与保留：三层，语义完全不同

**[码]**

| 操作 | transcript 投影表 | Tape |
|---|---|---|
| 删单条 / 删某 orderSeq 之后 | 物理 DELETE | 追加 `message/retracted` 事件，**每条一个** |
| `clearMessages`（清空会话消息） | `deleteBySession` 清 9 张投影表（`transcript.ts:626-636`） | **物理 reset**：删光 entry + mutation/search projection，再写新 bootstrap anchor（新 incarnation UUID） |
| 删整个 Session | — | **物理 DELETE**：`DELETE FROM deepchat_tape_entries WHERE session_id = ?` |

tombstone 只存在于第一层：`appendMessageRetractionToTape` 写 `data = { messageId, orderSeq, role, reason }`、meta `{ source:'live', correction:true }`、`provenanceKey: null`、`idempotent:false`（`factPersistence.ts:632-661`），reason 目前两种：`message_deleted`、`messages_deleted_from_order_seq`（`transcript.ts:637-651`）。`message/retracted` 是**唯一**参与 effective fold 的 event（`effectiveSemantics.ts:6-14`），SQL 判定是"存在 entry_id 更大、且 ≤ 快照 head 的同 messageId retraction"（`tapeEntryStore.ts:539-548`）。`deleteFromOrderSeq` 先逐条写 retraction，**再无条件 range delete 投影行**，注释说明 range delete 是这个方法一贯的表级保证（`transcript.ts:658-663`）。

会话级不是 append-only：`resetTapeGeneration` / `deleteTapeGeneration` 是真删（`generationLifecycle.ts:8-29` → `tapeLifecycleAdapter.ts:10-16`），docs 明说"reset 物理删除当前 Session Tape 后重新 bootstrap；本阶段没有 archive-on-reset，**不能把 reset 解释成 append-only 运行语义的一部分**"（`tape-system.md:123-124`）。

**保留策略 / 无痕会话：没有。[码]** `src/main` 与 `docs/architecture` 全量 grep `incognito|ephemeral session|privateMode|temporary chat` **零命中**；`retention` 只命中 settings activity（2000 条上限）、memory audit 索引名、skill draft（7 天）、background exec session（5 分钟）这些无关模块。Tape 没有 TTL、没有归档、没有导出脱敏；隐私依赖的是 SQLCipher 整库加密 + 删除即真删。

### 6. Execution Journal：事件、边界与恢复分类

**四个事件名与字段**（`src/main/tape/domain/executionJournal.ts:8-13, 125-183`）**[码]**。公共信封 `ExecutionFactBase` = `{ protocolVersion, type, sessionId, runId, messageId, entryId, createdAt }`，各自追加：

| event | 追加字段 |
|---|---|
| `execution/run_started` | `runKind: 'loop' \| 'deferred_tool'` |
| `execution/dispatch_committed`（T1） | `operation{runId,requestSeq,providerToolCallId}`、`toolName`、`toolSource: 'agent'\|'mcp'`、`argumentsHash`、`target{serverName,originalName?,ownerPluginId?}`；v2 nested 多 `childOrdinal` + `definitionHash` + `capabilityHash` |
| `execution/tool_outcome`（T2） | `operation`、`responseHash`、`isError` |
| `execution/run_terminal` | `outcome: completed\|paused\|aborted\|error`、`stopReason`（**必填 string**）、`errorHash?` |

**只存哈希不存正文**：dispatch 不存原始参数，outcome 不存 response text / MCP envelope / 图片 base64 / offload 路径，terminal error 只存 hash（journal spec:76-82）。理由写得很好："T2 proves that a particular outcome was received without creating a second durable copy of potentially sensitive output"。

**落盘信封**（`executionJournalService.ts:106-200`）**[码]**：`kind='event'`，`source = { type:'runtime_event', id: runId, seq: requestSeq }`（run_started 的 seq=0），provenance_key（`executionJournal.ts:501-521`，注意 v1 用的是 legacy `hashJson` 不是 `hashJsonData`）：

```
execution:v1:run:<hashJson({runId})>:started|terminal
execution:v1:operation:<opKey>:dispatch|outcome
execution:v2:parent:<parentKey>:operation:<nestedKey>:dispatch|outcome
```

**T1 相对权限门和真实副作用的位置**——这条可以在代码里精确读出来 **[码]**：

```
tool/index.ts:1050  permissionBroker.authorizeExecution(...)              ← 权限二次校验
tool/index.ts:1060  observeToolExecution / subagent policy / enabledServerIds
tool/index.ts:1072  assertExecutionContractDispatchAllowed
tool/index.ts:838   guardedCommitDispatch 内：tool-surface + target + 当前 runtime authority 再校验一遍
   ↓ 作为 commitDispatch 回调传进 mcpService.callTool（tool/index.ts:1085）
mcp/toolManager.ts:1081  access?.commitDispatch?.({ toolName, toolSource:'mcp', normalizedArguments, target })  ← T1
mcp/toolManager.ts:1097  notifyComputerUsePreview('started', previewCall)                                        （唯一插在中间的东西）
mcp/toolManager.ts:1103  targetClient.callTool(originalName, preparedArgs.args, ...)                             ← 真实副作用
```

spec 把这写成硬规则："Place dispatch commits **after** local validation, permission, policy, binding, target, and abort gates and **immediately before** the resolved side-effect boundary"（journal spec:41-42），以及 "Journal writes remain synchronous with the existing SQLite transaction model so no **asynchronous** gap is introduced between a fact commit and its local side-effect boundary"（:269-270）。dispatch 回执若 `created === false`（已存在），立刻抛 `ExecutionJournalDuplicateDispatchError`——**重复 claim 即阻止第二次物理调用**（`runtime/dispatch.ts:2160-2176`，错误类定义 `executionJournal.ts:226-234`）。

**重启恢复分类** `classifyExecutionJournalRows`（`executionJournal.ts:997-1161`）**[码]**，优先级是硬编码的四级（表达式在 :1142-1149）：

```
reasons 非空            -> corruption
否则 有 dispatch 缺 outcome -> indeterminate
否则 dispatch 数 == 0    -> not_dispatched
否则                    -> completed
```

`reasons` 共 **19 种**——18 个固定串（`reasons.add(...)` 18 处，:1018–1136）加 1 个动态串 `` malformed_fact:${entry_id}:${message} ``（:1049-1050）：

- 身份/重复类 7：`message_identity_mismatch`、`duplicate_dispatch`、`duplicate_outcome`、`duplicate_run_started`、`duplicate_run_terminal`、`missing_run_started`、`run_identity_reused_across_sessions`
- 顺序类 4：`fact_before_run_started`、`fact_after_run_terminal`、`outcome_without_dispatch`、`outcome_before_dispatch`
- **nested（v2）类 7**：`nested_dispatch_without_parent`、`nested_dispatch_before_parent`、`nested_dispatch_after_parent_outcome`、`nested_outcome_without_parent`、`parent_outcome_with_unsettled_nested`、`parent_outcome_before_nested_outcome`、`terminal_with_unsettled_nested`
- 解析类 1（动态）：`malformed_fact:<entryId>:<msg>`

**所有顺序判定都用 `entry_id` 比较**（如 `outcome.entryId <= dispatch.entryId`、`fact.entryId <= startEntryId`，:1078-1088）——entry_id 的单调性本身就是因果顺序的证据，没有单独的时间戳判定。

处置：`indeterminate` / `corruption` / 缺 terminal 一律输出结构化 `parked` 诊断，**不自动重放**；明细日志最多 100 条并清控制字符；Journal 读取失败直接阻止 harness 构造。`parked` 是 recovery disposition，不是新的持久化 Session 状态；后续继续执行必须**创建新 Run**（`tape-system.md:169-174`，journal spec:160-163）。**[文]**

#### Journal 是零 schema 迁移加进去的：它靠的五个前提

**[文]** Journal 是在一个**已经上线的 Tape** 上零 schema 迁移加进去的。journal spec:211-212 原文——

> "The existing `deepchat_tape_entries` schema and row format remain compatible. Journal records use existing event rows and **add only a query index** for unterminated-Run recovery reads."

它能做到这一点，靠的是 entry 模型里早就有的五样东西（这份归纳是本笔记的，不是 DeepChat 文档的原话）：

1. **通用 `event` kind**，payload 是自由 JSON（kind 共六个：`event/anchor/message/tool_call/tool_result/context`，`domain/entry.ts:1-7`）；
2. **name 是带 `/` 的字符串命名空间**，并且有一个能**按前缀整体保留**的机制（`reservesName`），没有它，新增的 `execution/xxx` 会被旧的 generic append 伪造——上面第 2 节实测过：有前缀保留的 `execution/foo` 被拒，没前缀保留的 `view/tool_MADEUP` 放行；
3. **一组可索引的「外部身份」列** `(source_type, source_id, source_seq)`——Journal 把 runId 放 `source_id`、requestSeq 放 `source_seq`，恢复扫描的 `idx_..._execution_run` 才能走纯列索引而不是解析 JSON；
4. **`provenance_key` + `UNIQUE(session_id, provenance_key)`**——幂等、"同 identity 同 payload 返回既有回执 / 异 payload 报 corruption" 全靠它；
5. **`entry_id` 在 session 内严格单调**，因果顺序可比（Journal 的全部顺序判定都只用它）。

另加一条 kind 之外的：**`payload_json` 里的字段可以后加，列不行**。DeepChat 唯一真正改过物理结构的是 `ensureProvenanceColumns()`——四个列 `source_type / source_id / source_seq / provenance_key` 是用 `ALTER TABLE ADD COLUMN` 补上的（`tapeEntryStore.ts:1912-1924`），靠 `hasColumn` 幂等判断；而这张表**根本没有版本化迁移**：`getMigrationSQL()` 恒返回 `null`、`getLatestVersion()` 恒 `0`（同文件 :835-841）。补列这条路走得通，但它是"没有迁移框架时的权宜"，不是可以反复用的手段。

### 7. 哈希链 / 签名 / 副作用分级 / run 分组 / snapshot

- **prev_hash / entry_hash 链：没有。[码]** `src/main/tape/` 下 grep `prev_hash|prevHash|chainHash|createHmac|hmac|signature|sign(` **零命中**。唯一的整行哈希是 `computeTapeIdentity(row)`（`domain/tapeIdentity.ts:4-22`，sha256 over 11 个列组成的 JSON 数组），但它只用于三处 lineage/contract 场景，对象是**child Tape 的第一条 entry**，语义是"这条 Tape 还是不是我当初引用的那条"，不是相邻 entry 之间的链（`lineageService.ts:350,406`、`taskContractService.ts:303`、`taskEvaluationService.ts:118`）。docs 自己把 Tape 里的 hash 分两类——fact 信封/payload 的自校验，和把 Tape 之外的对象绑定到 entry 的凭据——并明确后者"**不是对不可变 entry 的双重保证**，entryId 无法替代它们"（`tape-system.md:441-444`）。
- **签名：没有。[码]** 防篡改靠 SQLCipher 整库加密 + 单进程写者；篡改后的 manifest 只会被标 `invalid` 且照常返回给 Inspector。
- **工具副作用分级：只有 `read` / `write` 两级，且不进 Journal。[码]** `ToolEffect` = `'read' | 'write'`，配 `mode: sequential | parallel`，合法组合只有三种（read+parallel / read+sequential / write+sequential，`executionContract.ts:325-334` 的 `normalizeExecution` 与 :658-664 的 `isStoredExecutionPolicy`），偏序判定 `isToolEffectWithinCeiling`（:840-846：`effect === 'read' || ceiling === 'write'`）。它冻在 ViewManifest v5+ 的 ExecutionContract ceilings 里，dispatch 时做 typed meet。**没有 external / blocked 这两级**（grep `'external'|'blocked'` 在该文件零命中）；Journal 的 dispatch fact 只记 `toolName / toolSource('agent'|'mcp') / argumentsHash / target`，**不记 effect**。"哪些工具要写 dispatch fact"是散文规则而非枚举（journal spec:190-203）：MCP 的最终 client 边界、能跨持久化或外部副作用边界的内置 agent 工具、批准后的 deferred 执行要写；纯校验、权限弹窗、提问工具、context 读、ViewManifest 写不写。未知 MCP 工具一律保守处理，"their remote behavior cannot be inferred from local annotations"——与本文 §一之 5「MCP 注解不可信」一致。
- **run 分组 id：四层 + 一个横切。[码]** `runId`（每个 physical Run 一个 UUID，`requireExecutionRunId` 强制 canonical UUID，spec:86-87 "never depends on a process-local counter"）→ `requestSeq`（LoopRun 自增，一次确定的 provider payload）→ `logicalRound` / `physicalAttempt`（provider 重试维度；`provider/attempt_completed` 的 provenance key 是 `provider-attempt:${sessionId}:${messageId}:${requestSeq}:${physicalAttempt}`，`providerAttempt.ts:22-28`）→ `providerToolCallId`（v2 再加 `childOrdinal`）。横切的第五个是 `tapeIncarnationId`，标识 Tape 的"这一世"。
- **snapshot id：没有独立实体，用 `(tapeIncarnationId, maxEntryId)` 当快照坐标。[码]** 全仓 `snapshotId|snapshot_id` 在 `src/main/tape/` 零命中；Inspector 分页全部带 `snapshotMaxEntryId` 并在 SQL 里 `AND entry_id <= ?`（`tapeEntryStore.ts:164-171`、`shared/types/tape-inspector.ts:104,111,118,164,171`）；head watcher 的相等判定就是 `left.tapeIncarnationId === right.tapeIncarnationId && left.maxEntryId === right.maxEntryId`（`traceInspectorHeadWatcher.ts:35`）；投影游标同理，`deepchat_transcript_projection_meta(session_id PK, tape_incarnation_id, max_entry_id, projection_version, updated_at)`（`tables/deepchatTranscriptProjectionMeta.ts:25-31`）。

### 关键路径（补充）

| 内容 | 路径 |
|---|---|
| ViewManifest 全部类型与 schema 1–7 | `src/shared/types/tape-view-manifest.ts`（234 行） |
| manifest 事件名 / 构建输入 / hash 校验 | `src/main/tape/domain/viewManifest.ts:52` |
| manifest 纯逻辑校验与规范化 | `src/main/tape/domain/replay.ts`（301 行，5 个导出） |
| manifest append、provenance key、Skill binding 校验 | `src/main/tape/application/viewReplayService.ts:49-71, 539-673` |
| manifest 组装与 fail-open/closed 分叉 | `src/main/agent/deepchat/loop/contextCoordinator.ts:1100-1250` |
| requestSeq / logicalRound 计数器 | `src/main/agent/deepchat/loop/loopRun.ts:505-525` |
| **保留命名空间与双向断言** | `src/main/tape/domain/reservedNamespaces.ts`（139 行，可整份照抄） |
| entry_id 分配 / 幂等 / 索引 / 建表 / 补列 | `src/main/tape/infrastructure/sqlite/tapeEntryStore.ts:175-252, 806-944, 1063-1098, 1635-1644, 1912-1924` |
| strict writer 子类 | `tapeEntryStore.ts:1927(Journal), 2299-2319, 2322-2340(Contract)` |
| 存储 port 的能力切分 | `src/main/tape/ports/storage.ts:57-151(TapeEntryStore), 197-226, 229-235` |
| effective fold 的输入 kind 与 retraction | `src/main/tape/domain/effectiveSemantics.ts:6, 23-28`；`effectiveView.ts:181` |
| Journal 事实模型 + provenance key + 恢复分类 | `src/main/tape/domain/executionJournal.ts:8-13, 125-183, 226-234, 501-521, 997-1161` |
| Journal 写入与"拒绝宿主事务" | `src/main/tape/application/executionJournalService.ts:106-200, 447-470` |
| T1 与真实 MCP 调用的相邻三行 | `src/main/mcp/toolManager.ts:1081, 1097, 1103` |
| T1 前的权限/契约门 | `src/main/tool/index.ts:838-866, 1040-1090` |
| 消息 correction / retraction 事实 | `src/main/tape/application/factPersistence.ts:569-661` |
| 编辑 / 重试 / fork 的 transcript 侧 | `src/main/session/transcriptMutations.ts:33-99`、`src/main/session/data/transcript.ts:607-664, 769-810, 919-940`、`src/main/session/lifecycle.ts:488-558` |
| Tape 物理删除与 reset | `src/main/tape/application/generationLifecycle.ts:8-29`、`infrastructure/sqlite/tapeLifecycleAdapter.ts:10-16` |
| SQLite 连接参数 | `src/main/data/connectionConfig.ts:15-31`（无 `busy_timeout`） |
| 设计文档 | `docs/architecture/tape-system.md`、`docs/architecture/durable-execution-journal/{spec,plan,tasks}.md`、`docs/architecture/tape-layering/`、`docs/architecture/tape-contract-lineage/` |

### Tenon 的取舍

不写在这里。本节只留机制证据；Tenon 据此做的决定（entry 模型、删除语义、`entry_id` 分配、命名空间白名单、哈希链）见 [01-provider-and-tape/spec.md](../architecture/01-provider-and-tape/spec.md)。

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
