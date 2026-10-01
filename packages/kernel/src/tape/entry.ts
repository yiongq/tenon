/**
 * The tape entry model (spec 01 §Tape → entry 模型): one table, one row per fact, append-only.
 *
 * Two rules hold across this whole file. Bytes cross as `Uint8Array` — never a Node `Buffer`, so
 * the kernel stays host-independent. Integers cross as numbers inside `Number.MAX_SAFE_INTEGER` —
 * never `bigint`, so a store that reads 64-bit columns has to assert the range at its own edge.
 *
 * Payload types are type aliases rather than interfaces on purpose: only an object literal type
 * gets TypeScript's implicit index signature, which is what makes it assignable to
 * `NewEntry.payload`. They are also all JSON — every value in them survives `canonicalJson`, so a
 * hash inside a payload is lowercase hex, not bytes.
 */
import type { AbsolutePath, ConfirmRequest, ConfirmTarget, Reversibility } from '../host/adapter.js'
import type { ClosureSource, ExecutionState } from '../loop/closure.js'
import type { SpillMark, SpillRecord } from '../loop/spill.js'
import type { SubagentHandoff } from '../loop/subagent.js'
import type { RunEndReason } from '../loop/terminal.js'
import type { Decision } from '../permission/decide.js'
import type { DecisionRecord, DecisionSummary } from '../permission/record.js'
import type { ContentBlock, ModelInfo, ProviderId, ToolSpec, Usage } from '../provider/types.js'

/**
 * An integer that is outside `Number.MAX_SAFE_INTEGER` (or not an integer at all) where the model
 * promises a safe one. Named by spec 01 §存储端口, and the same class serves both ends of that
 * promise: the hash recipe refuses to seal such a row, and a store asserts the range when it reads a
 * 64-bit column back. Kernel-defined so no host invents its own.
 */
export class TapeIntegerRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeIntegerRangeError'
  }
}

/**
 * The closed `kind` vocabulary, as a frozen runtime list with the union derived FROM it — a second
 * hand-written union could drift from the list, and `kind` is both in the hash preimage and in
 * `tape_entry_by_kind`, so a bogus value is sealed permanently (R1's argument for names applies
 * verbatim). `assertAppendAuthorized` checks membership, because a `kind` that crossed an untyped
 * boundary has had no compiler anywhere near it.
 */
export const TAPE_KINDS = Object.freeze([
  'message',
  'tool_call',
  'tool_result',
  'anchor',
  'event',
  'context',
] as const)

export type TapeKind = (typeof TAPE_KINDS)[number]

/**
 * Indexable "who is this fact about". runtime_event ⇒ sourceId = runId, sourceSeq = requestSeq.
 * Frozen list first, union derived, for the same reason as `TAPE_KINDS`. `summary`, `subagent` and
 * `migration` have no writer before phase 2 — the values are held so later phases do not each invent
 * their own spelling.
 */
export const TAPE_SOURCE_TYPES = Object.freeze([
  'session',
  'message',
  'tool_call',
  'tool_result',
  'runtime_event',
  'summary',
  'subagent',
  'migration',
] as const)

export type TapeSourceType = (typeof TAPE_SOURCE_TYPES)[number]

export interface TapeEntry {
  tenantId: string
  sessionId: string
  /** Strictly increasing within a session, never reused. Causal order is this, not `createdAt`. */
  entryId: number
  /** Replaced when a session is cleared; part of the hash preimage. */
  incarnationId: string
  kind: TapeKind
  /** Slash namespace, e.g. 'message/user'. NOT NULL, so the reservation rules cover everything. */
  name: string
  sourceType: TapeSourceType
  sourceId: string | null
  sourceSeq: number | null
  /** Mandatory: every append is idempotent. */
  provenanceKey: string
  payload: Record<string, unknown>
  meta: Record<string, unknown>
  /** HostClock epoch ms. Not an ordering key. */
  createdAt: number
  contentHash: Uint8Array
  /** Only the first entry of an incarnation has null. */
  prevHash: Uint8Array | null
  entryHash: Uint8Array
  hashVer: number
}

/** What a caller hands a store. `entryId`, the hashes and the incarnation are the store's job. */
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
  /** false = this provenanceKey already exists with identical content; no second row, no second projection. */
  created: boolean
}

/**
 * Additive vocabulary: a new value never changes what an existing one means. Phase 1 writes only
 * the first two — a failed turn writes no assistant message at all, its evidence is the `error`
 * on `provider/attempt_completed`.
 */
export type MessageStatus = 'complete' | 'aborted' | 'error'

/**
 * Fixed at `execution/tool_outcome`'s `payload.effect` (spec 01 R5). Phase 1 writes no such fact;
 * the vocabulary is decided now so phase 2 and 4 do not each invent one.
 */
export type SideEffectClass = 'read' | 'write' | 'external' | 'blocked'

/**
 * A point on a tape. Deliberately not an entity with its own id: phase 4's file snapshot is a
 * string inside an `fs/snapshot_created` payload, this is the tape coordinate it pins.
 */
export interface SnapshotCoordinate {
  incarnationId: string
  entryId: number
}

/**
 * Where a forked session came from. `entryHash` is lowercase hex of the parent entry's
 * `entry_hash`: lineage has to be checkable against the chain rather than being a bare pointer,
 * and it stays checkable after the parent session is deleted. Hex because payloads are JSON.
 */
export type ForkOrigin = {
  sessionId: string
  incarnationId: string
  entryId: number
  entryHash: string
}

/** `anchor` / `session/start` — the first fact of every incarnation. */
export type SessionStartPayload = {
  incarnationId: string
  forkedFrom?: ForkOrigin
}

/**
 * `message` / `message/user`.
 *
 * The payload and meta of a user message must contain nothing that varies per run — `runId` lives
 * on the assistant message only. Resending the same text is a retry of the same logical fact, and
 * a retry has to hash identically or the idempotent append turns into a
 * `TapeProvenanceConflictError`.
 *
 * `TContent` is the shared content model: step 5 binds it to `ContentBlock[]` from
 * `provider/types.ts`. It is a parameter here so the tape does not depend on the provider layer.
 */
export type UserMessagePayload<TContent = unknown> = {
  messageId: string
  revision: number
  role: 'user'
  content: TContent[]
  status: MessageStatus
}

/** `message` / `message/assistant` — written once, at the terminal event, never when empty. */
export type AssistantMessagePayload<TContent = unknown> = {
  messageId: string
  revision: number
  role: 'assistant'
  content: TContent[]
  status: MessageStatus
  runId: string
}

export type MessagePayload<TContent = unknown> =
  | UserMessagePayload<TContent>
  | AssistantMessagePayload<TContent>

/**
 * `event` / `message/retracted` — a tombstone. The retracted message's content is still on disk
 * until the session is cleared or deleted; interface copy must not claim otherwise.
 */
export type MessageRetractedPayload = {
  messageId: string
  reason: string
}

/**
 * `event` / `session/model_selected` — written when a run starts, recording what that run actually
 * used. Picking a provider in the settings card only writes `config.json`; it is not a fact.
 */
export type ModelSelectedPayload = {
  providerId: string
  modelId: string
  /**
   * Spec 02, 01 修补 7 (M5): a builtin row, a hand-typed id, or the dev-time synthesis; M6 02 修补 2
   * adds `probed`, a custom vendor's row that passed its probe.
   */
  capabilitySource?: 'builtin' | 'user' | 'synthesized' | 'probed'
  /** Spec 02, 01 修补 7: `URL.origin` of where the run sends — scheme, host and port only. */
  endpointOrigin?: string
}

/**
 * The request parameters outside the message list, snapshotted so the attempt stays auditable.
 * `maxTokens` can come from an environment variable that is nowhere on the tape — unrecorded, this
 * row could never be re-checked.
 */
export type AttemptRequestSnapshot = {
  systemHash: string
  maxTokens: number
  temperature?: number
  thinking?: { enabled: boolean; budgetTokens?: number }
  /** Spec 02, 01 修补 2: the effort level the encoder wrote. */
  effort?: string
  /** Spec 02, 01 修补 2: the display the encoder wrote — absent whenever thinking was off. */
  display?: 'summarized' | 'omitted'
  /** Spec 02, 01 修补 2 (H10): the index below which the guard dropped thinking blocks. */
  dropThinkingBefore?: number
}

/**
 * `event` / `provider/attempt_completed`, identified by `(runId, requestSeq, physicalAttempt)`.
 *
 * `contextAtEntryId` is the inclusive upper bound of the tape prefix this request was assembled
 * from — a request's context is a prefix, not the whole tape, so replay can be pinned to it.
 * Exactly one of `stop` / `error` is non-null; `usage` is the `final: true` one, or null.
 *
 * The three provider-owned shapes are type parameters for the same reason `TContent` is: step 9
 * binds them to `ThinkingDecision`, `Usage` and the stop / error shapes of `provider/types.ts`.
 */
export type AttemptCompletedPayload<
  TDecision = unknown,
  TUsage = unknown,
  TStop = unknown,
  TError = unknown,
> = {
  providerId: string
  modelId: string
  contextAtEntryId: number
  request: AttemptRequestSnapshot
  promptHash: string
  toolDefinitionsHash: string
  thinkingDecisions: TDecision[]
  usage: TUsage | null
  stop: TStop | null
  error: TError | null
  /** Spec 02, 01 修补 7 (A3): the provenanceKey of this request's `view/assembled`. */
  assemblyRef?: string
  /** Spec 02, 01 修补 7 (M3): the encoder that produced the body, e.g. sdk '@anthropic-ai/sdk@0.128.0'. */
  encoder?: { wire: 'anthropic-messages' | 'openai-chat'; version: number; sdk: string }
  /** Spec 02, 01 修补 7: SHA-256(canonicalJson(pick(model, WIRE_MODEL_FIELDS))). */
  modelWireHash?: string
  /** Spec 02, 01 修补 7 (M5): the model name the `response-model` event reported. */
  responseModelId?: string
  /** Spec 02, 01 修补 7 (H10): present only on the request that writes a summary. */
  compaction?: { keepFromEntryId: number; requestText: string }
}

// -------------------------------------------------------------------------------------------------
// Spec 02 §02 的 Tape 事实 · §载荷 — the payloads of the names phase 2 declares (additive only).
//
// Plan step 8 declares every one of them, including the names only ③ writes, so the payload map in
// `projection.ts` is exhaustive and the later steps narrow nothing. The referenced types each have
// one source: `Reversibility` / `ConfirmRequest` / `ConfirmTarget` in `host/adapter.ts` (§对
// 00-foundation 的修补), `ExecutionState` / `ClosureSource` / `BlockReason` in `loop/closure.ts`,
// `RunEndReason` in `loop/terminal.ts`, `DecisionRecord` / `DecisionSummary` in
// `permission/record.ts`, `Decision` in `permission/decide.ts`, `SubagentHandoff` in
// `loop/subagent.ts`, `SpillRecord` in `loop/spill.ts`. All imports are type-only: the tape core
// still runs without the provider layer, the loop or the permission engine.
// -------------------------------------------------------------------------------------------------

/** 事实挂在发起调用的 run 名下，实际由谁写记在这里（B1）。resolver 指 kernel 按根会话串行处理答复、停止、取代的那一处（F3） */
export type FactWriter = { by: 'run'; runId: string } | { by: 'resolver' } | { by: 'recovery' }
type CallRef = { ordinal: number; providerToolCallId: string } // ordinal 就是键里的 <i>；配对键仍按 01

// session/
export type SessionProfile = 'chat' | 'cowork' | 'code' // 00 spec:239 记下的 kernel profile 枚举，02 第一次落成类型；界面上叫「对话 / 任务」
export type ProfileSetPayload = {
  profile: Exclude<SessionProfile, 'code'> // code 按 00 的开放问题在阶段 6 前重估，02 不写
  subagentOf?: { sessionId: string; linkKey: string } // 只在子会话上有：父会话 id，和父会话里那条 parent_link 的键
}
export type WorkspaceSetPayload = {
  folders: AbsolutePath[] // 变化后的整张列表，真实路径；folders[0] 是命令的 cwd
  origin: 'picked' | 'dedicated'
}
export type ModelChoiceSetPayload = {
  providerId: ProviderId
  modelId: string
  effort: string | null // null 表示模型默认档（A11）
  source?: 'user' // 表外、手填的 id（M6、A15）
}
export type ParentLinkPayload = CallRef & {
  child: { sessionId: string; incarnationId: string }
  tools: string[] // 子会话工具表里的名字：父会话在该 provider 下冻结的表，去掉 Agent、AskUserQuestion 和此刻已被禁的工具，按码元升序（H5、E2）
  stepLimit: number
  deadlineMs: number // 取值见 §主循环与 Run 的结束、§子 agent 契约
}

// view/
export type ViewContentPayload =
  | { type: 'system'; hash: string; text: string } // hash = systemHash(text)（wire/shared.ts:68）
  | { type: 'tool_spec'; hash: string; spec: ToolSpec } // hash = canonicalHash(spec)（wire/shared.ts:52）
  | { type: 'model_info'; hash: string; model: ModelInfo } // hash = canonicalHash(model)，对完整 ModelInfo 取；不等于 attempt 的 modelWireHash（后者只取 WIRE_MODEL_FIELDS）；手填的、合成的也存原文
export type ToolExclusionCode =
  | 'policy'
  | 'user-disabled'
  | 'connector-unauthorized'
  | 'over-limit'
  | 'no-search-backend'
export type ToolOrigin = { source: 'builtin' | 'mcp'; serverId: string; originalName: string } // §内置工具与工具来源 的 ToolTableItem 继承它
export type ToolTablePayload = {
  providerId: ProviderId
  generation: number
  reason: 'first-use' | 'after-compaction'
  policyVersion: string // 开表时那次 policy.current() 的 version；unavailable 时记 'unavailable'（D4）
  tools: Array<ToolOrigin & { name: string; specHash: string; requiresUserInteraction: boolean }> // 按 name 码元升序；name 是 H4 映射后发给模型的名字
  excluded: Array<ToolOrigin & { code: ToolExclusionCode }>
}
export type ToolsWithheldPayload = {
  providerId: ProviderId
  modelId: string
  tableKey: string // tableKey 指仍然冻结着的那张表
  reason: 'model-without-tools' | 'provider-text-only' | 'not-probed' // 表外或不支持工具的模型（A15）；Ollama 与回环、私网实例（A14）；公网实例没通过探测的行（M6 02 修补 3）
}
export type ViewAssembledPayload = {
  modelInfoHash: string // 指向 view/content(model_info)
  systemHash: string // 指向 view/content(system)；没有 system 时取 NO_SYSTEM_PROMPT_HASH（wire/shared.ts:61），不写 content
  tools: { tableKey: string; sent: boolean } | null // null 表示这次请求不走工具表（写摘要的请求）
}

// message/
export type ContinuationPayload = UserMessagePayload<ContentBlock> & {
  cause: 'output-truncated' | 'step-limit'
  afterRunId: string // content 只有一段英文续写提示
}
export type EnvironmentPayload = UserMessagePayload<ContentBlock> & {
  date: string // YYYY-MM-DD，LoopPorts.localDate
  workspace: WorkspaceSetPayload | null // 对话形态为 null；子会话取父会话此刻最新的 workspace_set
} // content 只有一段 MODEL_NOTES.environment 填好的英文（开放问题 16）

// tool/
export type ToolCallPayload = CallRef & {
  messageId: string // 这个调用所属的 message/assistant，撤回时据此连带隐藏（B2）
  name: string
  input: Record<string, unknown>
  argsHash: string // name 是发给模型的名字；argsHash = canonicalHash(input)
}
export type PermissionDecidedPayload = CallRef & {
  target?: ConfirmTarget // 判决当时的卡片对象；旧事实没有时交接使用纯fallback
  argsHash: string
  reversibility: Reversibility // host 的判定（E1）；tool_outcome 从这里取
  record: DecisionRecord // verdict、decidedBy、steps，只进 Tape（F8）
  summary: DecisionSummary // 判定时由 summarize 算出，读取时不重算（§权限引擎 · Inspector 与判决记录）
  policyVersion: string // 本次判决唯一一次 policy.current() 的 version；unavailable 时记 'unavailable'（D4）
  // verdict 为 ask 时有：要投递的卡面，requestId、sessionId 投递时再补。The spec writes the last
  // half as `Pick<ConfirmRequest, 'kind' | 'target'>`; `ConfirmRequest.target` arrives with plan
  // step 5, and until then `{ target: ConfirmTarget }` is that same member spelled out.
  confirm?: NonNullable<Decision['confirm']> &
    Pick<ConfirmRequest, 'kind'> & { target: ConfirmTarget }
  block?: Decision['block'] // verdict 为 deny 时有：拦截码和它的必填槽位（D5）
  awaits?: 'approval' | 'question' // 这条判决让本 Run 暂停：问人的审批，或者放行的 AskUserQuestion（H6）
  rejudge?: number // 等于键里的 <r>
  writer: FactWriter
}
export type GrantScope = 'once' | 'session' | 'persistent' // 阶段 6 只增 'task'（D1）；02 的审批卡只产出前两个
export type ApprovalResolvedPayload = CallRef & {
  parentWorkspaceKey?: string // 父当前workspace_set的provenanceKey，仅子文件/命令session授权
  decisionKey: string // 所答的那条判决（当时最新的一条）的 provenanceKey
  outcome:
    | 'allowed'
    | 'denied'
    | 'cancelled-by-stop'
    | 'superseded'
    | 'tool-unavailable'
    | 'denied-on-rejudge'
  via: 'card' | 'stop' | 'new-message' | 'rejudge' | 'receipt-override' // 'receipt-override' 在 02 没有写入方（F9、F1）
  grant: { scope: GrantScope; key: string } | null // 只在 allowed 时有；scope、key 的取法见 §权限决策顺序
  writer: FactWriter
}
/**
 * The ask summary card's data (spec 02 §提问工具 AskUserQuestion; open question 18): the same shape
 * as `approval.respond`'s question request, written by the resolver in the same batch as the
 * content. Only the approval.respond path fills an unanswered question with null; a typed reply
 * keeps `answers` as {} and its text in `response`. Past the spill threshold the record keeps only
 * the start of each answer, and `preview` says where the full text is (H9; Revisions 31).
 */
export interface AskAnswerRecord {
  answers: Record<string, string[] | null> // 键为题目原文；null = 跳过
  response?: string
  preview?: SpillMark // 结果过了 SPILL_THRESHOLD_CHARS、有回答被截成开头时才有（H9，Revisions 31）
}

export type ToolResultPayload = CallRef & {
  isError: boolean
  content: Array<Extract<ContentBlock, { type: 'text' | 'image' }>> // 发给模型的原样内容；落盘的只放说明和预览（H9）
  kernelAuthored: boolean // true：content 整段是 kernel 按 source 写的固定英文，只给模型看（B1、F2）
  spill?: SpillRecord // 全文落盘时有（H9）
  handoff?: SubagentHandoff // 只用于 Agent 调用（H5）
  question?: AskAnswerRecord // 只用于答过的 AskUserQuestion（来源 null、no-preference、typed-answer）；界面汇总卡读它（H6；开放问题 18）
  searchHitUrls?: string[] // 只用于成功的 WebSearch，F5 外带检查的豁免读它（F5、F10）
  writer: FactWriter
}

// execution/
export type RunStartedPayload = {
  cause:
    | { kind: 'user-message'; messageId: string } // 一个 Run 开头写了几条 message/user（自动发出、取代时带上排队项）的，取最后一条；「重试」重发的就是它
    | { kind: 'resume'; pausedRunId: string; batch: { runId: string; requestSeq: number } } // 审批答复、提问答复、收交接或打开可续跑会话时开的 Run；batch 指被续跑的那批调用所在的请求（F3、H6、H5）
    | { kind: 'continue'; afterRunId: string; messageId: string | null } // 点「继续」开的 Run；messageId 指向 message/continuation，截断时什么都没写下、整轮重发的为 null（§重试与「继续」）
}
export type DispatchCommittedPayload = CallRef & {
  name: string
  argsHash: string
  decisionKey: string
  writer: FactWriter
}
export type ToolOutcomePayload = CallRef & {
  effect: SideEffectClass // 01 固定的路径和四个值（01 spec:398）；取法见 §工具调用的收口
  state: ExecutionState
  source: ClosureSource | null // null 表示正常执行完，没有收口
  facts?: Record<string, string> // 只在 source 是 BlockReason 时有，键为 BLOCKED_FACT_KEYS[source]（D5）
  reversibility: Reversibility // 取判决事实里的值；没有判决事实的（参数不合法、被截断、停止前没轮到）记 'unknown'
  writer: FactWriter
}
export type RunUsageLine = Omit<Usage, 'final'> & {
  providerId: ProviderId
  modelId: string
  origin: 'own' | 'subagent'
  requests: number
}
export type RunTerminalPayload = {
  reason: RunEndReason // 槽位就在各成员上，不另设（H12）
  steps: number // 本 Run 的工具轮数
  usage: RunUsageLine[] // 累计用量，含子 agent（H11）
  writer: FactWriter
}

// compaction/
export type CompactionAnchorPayload = {
  coversThroughEntryId: number
  keepFromEntryId: number // 摘要覆盖到这一条（含）；从这一条起保留原文
  summary: string
  summarizer: { providerId: ProviderId; modelId: string }
  trigger:
    | { code: 'threshold'; estimatedInputTokens: number; thresholdTokens: number }
    | { code: 'overflow'; retry: 1 | 2 }
  generation: number // 压缩之后的工具表代数
}
