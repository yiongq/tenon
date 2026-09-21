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
}
