/**
 * The projection reducer (spec 01 §投影与重放): **the kernel owns the reducer, a store owns the
 * transaction.**
 *
 * `project(entry)` is pure and per-fact. It returns `ProjectionOp`s — scalars only, a fixed table
 * list, no expressions — and every store applies them inside the same transaction that inserted the
 * fact, then advances its projection cursor. The reducer does not live in `apps/desktop` because
 * acceptance 3 is a kernel-level property: down there the kernel's own tests could not reach it and
 * the server host would have to implement it a second time, which means drift.
 *
 * `insertOnly` is what lets a reducer stay blind to the current row: those columns are written on
 * insert and left alone on conflict, so `order_seq` and `created_at` never move. `order_seq` is the
 * `entry_id` of the FIRST `message/*` fact of a messageId — a revision carries its own (larger)
 * entry id in `insertOnly`, the upsert ignores it, and editing an old message therefore does not
 * make it jump in the interface.
 *
 * Being blind has two consequences worth stating rather than discovering:
 *
 *   - The message upsert is LAST-WRITE-WINS on `values`. The write path requires a revision to be
 *     the stored one + 1 (spec 01 §entry 模型: 「`revision` 必须 +1」), so out-of-order revisions are
 *     a caller bug; if one is appended anyway, this row shows the last fact written while
 *     `effectiveMessages` shows the highest revision. Neither reader guesses; the writer is wrong.
 *   - `message/retracted` DELETES the row (§删除语义), and a reducer that cannot read the current row
 *     cannot then restore a deleted message's original `order_seq`. A revision appended AFTER a
 *     retraction therefore re-inserts the message at its own entry id, while the fold keeps it where
 *     it started — the two readers disagree on that one sequence. Spec 02 closed it on the WRITE side
 *     (B2, 「撤回即终局」): the kernel's message writer refuses such a revision with
 *     `TapeMessageRetractedError`, so no kernel path produces the sequence. The shared conformance
 *     suite still pins what a store does with one it is handed anyway, so both stores answer alike.
 *
 * Every projection table can be rebuilt from `tape_entry` at any time, which is why none carries an
 * append-only trigger; a change to `PROJECTION_VERSION` means rebuild. Version 2 (spec 02, 01 修补 7)
 * adds `pending_approval`: the calls waiting on an approval or a question, driven by three facts only
 * — a `tool/permission_decided` that `awaits` upserts the row, and that call's
 * `tool/approval_resolved` or `tool/result` deletes it (§待批表).
 */
import type {
  ContentBlock,
  ProviderErrorCode,
  StopReason,
  ThinkingDecision,
  Usage,
} from '../provider/types.js'
import { canonicalJson } from './canonical-json.js'
import type {
  ApprovalResolvedPayload,
  AssistantMessagePayload,
  AttemptCompletedPayload,
  CompactionAnchorPayload,
  ContinuationPayload,
  EnvironmentPayload,
  DispatchCommittedPayload,
  MessagePayload,
  MessageRetractedPayload,
  MessageStatus,
  ModelChoiceSetPayload,
  ModelSelectedPayload,
  ParentLinkPayload,
  PermissionDecidedPayload,
  ProfileSetPayload,
  RunStartedPayload,
  RunTerminalPayload,
  SessionStartPayload,
  TapeEntry,
  ToolCallPayload,
  ToolOutcomePayload,
  ToolResultPayload,
  ToolTablePayload,
  ToolsWithheldPayload,
  UserMessagePayload,
  ViewAssembledPayload,
  ViewContentPayload,
  WorkspaceSetPayload,
} from './entry.js'
import type { DeclaredTapeNameId } from './names.js'

/** Bump it and every projection is rebuilt from the facts. 2 = spec 02's pending-approval table. */
export const PROJECTION_VERSION = 2

/** The closed table list. A `projection_cursor` row exists per session per entry of this list. */
export const PROJECTION_TABLES = Object.freeze(['message', 'session', 'pending_approval'] as const)

export type ProjectionTable = (typeof PROJECTION_TABLES)[number]

/**
 * A payload does not have the shape its name declares, or an op cannot be applied (an insert with
 * no `insertOnly` for the NOT NULL columns). Both are the same class of failure: the projection
 * cannot be derived, and guessing would put a wrong row in front of the user. Inside `append` it
 * aborts the batch, which is what keeps facts and projections in step.
 */
export class TapeProjectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeProjectionError'
  }
}

// ---------------------------------------------------------------------------------------------
// Payload types per declared name
// ---------------------------------------------------------------------------------------------

/**
 * The tape's message payloads bound to the provider layer's content model. `entry.ts` leaves the
 * block type a parameter so the tape core does not depend on the provider layer; this is the module
 * where the two meet, and binding it here is what lets the reducer read `content` without a cast.
 */
export type TapeUserMessagePayload = UserMessagePayload<ContentBlock>
export type TapeAssistantMessagePayload = AssistantMessagePayload<ContentBlock>
export type TapeMessagePayload = MessagePayload<ContentBlock>

/** The stop half of `provider/attempt_completed`; exactly one of stop / error is non-null. */
export type TapeAttemptStop = { reason: StopReason; providerReason: string | null }

/** The error half. Same shape as the stream's `error` event — `detail` is for logs, never rendered. */
export type TapeAttemptError = {
  type: 'error'
  code: ProviderErrorCode
  retryable: boolean
  retryAfterMs?: number
  status?: number
  providerCode: string | null
  detail: string
}

export type TapeAttemptCompletedPayload = AttemptCompletedPayload<
  ThinkingDecision,
  Usage,
  TapeAttemptStop,
  TapeAttemptError
>

/**
 * Every declared name to the payload it carries. The reserved-only names have no writer before the
 * phase that owns them (R1, R5), so their payload is still open; the entry is here so adding the
 * writer means narrowing a type rather than inventing one. Spec 02 §载荷 fills in every phase-2 name,
 * including the four `execution/*` and `session/parent_link` that 01 reserved.
 */
export interface TapePayloadByName {
  'session/start': SessionStartPayload
  'session/model_selected': ModelSelectedPayload
  'message/user': TapeUserMessagePayload
  'message/assistant': TapeAssistantMessagePayload
  'message/retracted': MessageRetractedPayload
  'provider/attempt_completed': TapeAttemptCompletedPayload
  'session/profile_set': ProfileSetPayload
  'session/workspace_set': WorkspaceSetPayload
  'session/model_choice_set': ModelChoiceSetPayload
  'session/parent_link': ParentLinkPayload
  'view/content': ViewContentPayload
  'view/tool_table': ToolTablePayload
  'view/tools_withheld': ToolsWithheldPayload
  'view/assembled': ViewAssembledPayload
  'message/continuation': ContinuationPayload
  'message/environment': EnvironmentPayload
  'tool/call': ToolCallPayload
  'tool/permission_decided': PermissionDecidedPayload
  'tool/approval_resolved': ApprovalResolvedPayload
  'tool/result': ToolResultPayload
  'execution/run_started': RunStartedPayload
  'execution/dispatch_committed': DispatchCommittedPayload
  'execution/tool_outcome': ToolOutcomePayload
  'execution/run_terminal': RunTerminalPayload
  'compaction/anchor': CompactionAnchorPayload
  'tool/result_marked': Record<string, unknown>
  'fs/snapshot_created': Record<string, unknown>
}

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type AssertTrue<T extends true> = T

/**
 * Compile-time proof that the map covers EXACTLY the declared names: declaring a thirteenth name
 * without giving it a payload type reds this line instead of leaving a reader to guess.
 */
export type TapePayloadMapIsExhaustive = AssertTrue<
  Exactly<keyof TapePayloadByName, DeclaredTapeNameId>
>

// ---------------------------------------------------------------------------------------------
// Projection ops
// ---------------------------------------------------------------------------------------------

/**
 * Message row columns that a revision overwrites. `contentJson` is text, not blocks: the op writes
 * the column, and the column is the canonical JSON the fact stored.
 */
export interface MessageProjectionValues {
  readonly role: 'user' | 'assistant'
  readonly status: MessageStatus
  readonly contentJson: string
  readonly entryId: number
  readonly updatedAt: number
}

/** Written on insert, untouched on conflict — this is why a revision cannot move a message. */
export interface MessageProjectionInsertOnly {
  readonly orderSeq: number
  readonly createdAt: number
}

export interface MessageProjectionKey {
  readonly sessionId: string
  readonly messageId: string
}

export interface SessionProjectionKey {
  readonly sessionId: string
}

/**
 * An absent key means "do not touch that column"; a present one is a scalar. Phase 1 never writes a
 * null through an op, so `undefined` stays unambiguous.
 */
export interface SessionProjectionValues {
  readonly providerId?: string
  readonly modelId?: string
  readonly lastMessageAt?: number
  readonly updatedAt: number
}

export interface SessionProjectionInsertOnly {
  readonly createdAt: number
  readonly forkedFromSessionId?: string
}

/** A waiting call, keyed the way every tool/ fact is: `(runId, requestSeq, <i>)` in its session. */
export interface PendingApprovalProjectionKey {
  readonly sessionId: string
  readonly runId: string
  readonly requestSeq: number
  readonly callOrdinal: number
}

/** Overwritten by a re-judgement that still asks: `entryId` moves to the newest decision. */
export interface PendingApprovalProjectionValues {
  readonly waitKind: 'approval' | 'question'
  readonly entryId: number
}

/** When the call started waiting. Required: the reducer always knows it, and the column is NOT NULL. */
export interface PendingApprovalProjectionInsertOnly {
  readonly createdAt: number
}

export type ProjectionOp =
  | {
      readonly table: 'message'
      readonly op: 'upsert'
      readonly key: MessageProjectionKey
      readonly values: MessageProjectionValues
      readonly insertOnly?: MessageProjectionInsertOnly
    }
  | { readonly table: 'message'; readonly op: 'delete'; readonly key: MessageProjectionKey }
  | {
      readonly table: 'session'
      readonly op: 'upsert'
      readonly key: SessionProjectionKey
      readonly values: SessionProjectionValues
      readonly insertOnly?: SessionProjectionInsertOnly
    }
  | { readonly table: 'session'; readonly op: 'delete'; readonly key: SessionProjectionKey }
  | {
      readonly table: 'pending_approval'
      readonly op: 'upsert'
      readonly key: PendingApprovalProjectionKey
      readonly values: PendingApprovalProjectionValues
      readonly insertOnly: PendingApprovalProjectionInsertOnly
    }
  | {
      readonly table: 'pending_approval'
      readonly op: 'delete'
      readonly key: PendingApprovalProjectionKey
    }

/** Injectable at store construction so a test can count applications (acceptance 11). */
export type ProjectionReducer = (entry: TapeEntry) => readonly ProjectionOp[]

// ---------------------------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------------------------

/**
 * Payloads are read field by field with a runtime check rather than cast into shape. `project()`
 * also runs during `rebuildProjections`, where its input is text that came back off a disk — a cast
 * there would turn a corrupted row into a wrong row in front of the user, while a named error stops
 * the rebuild where the corruption is.
 */
function readString(payload: Record<string, unknown>, key: string, name: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TapeProjectionError(`${name}: payload.${key} must be a non-empty string`)
  }
  return value
}

function readOrdinal(payload: Record<string, unknown>, key: string, name: string): number {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TapeProjectionError(`${name}: payload.${key} must be a non-negative safe integer`)
  }
  return value
}

const MESSAGE_STATUSES: readonly MessageStatus[] = Object.freeze(['complete', 'aborted', 'error'])

function isMessageStatus(value: unknown): value is MessageStatus {
  return typeof value === 'string' && (MESSAGE_STATUSES as readonly string[]).includes(value)
}

function readStatus(payload: Record<string, unknown>, name: string): MessageStatus {
  const value = payload['status']
  if (!isMessageStatus(value)) {
    throw new TapeProjectionError(
      `${name}: payload.status must be one of ${MESSAGE_STATUSES.join(', ')}`,
    )
  }
  return value
}

/**
 * Blocks are checked for the one thing every variant shares — an object with a string `type` — and
 * no further. The content model belongs to the provider layer and grows with it, so re-validating
 * the variants here would mean a second vocabulary to keep in step; what the projection needs is
 * only that the value is JSON `canonicalJson` accepts, and a non-JSON value could never have been
 * written in the first place.
 */
function isContentArray(value: unknown): value is ContentBlock[] {
  return (
    Array.isArray(value) &&
    value.every(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        typeof (block as { type?: unknown }).type === 'string',
    )
  )
}

function readContent(payload: Record<string, unknown>, name: string): ContentBlock[] {
  const value = payload['content']
  if (!isContentArray(value)) {
    throw new TapeProjectionError(
      `${name}: payload.content must be an array of blocks, each with a string type`,
    )
  }
  return value
}

/**
 * Reads a `message/user` or `message/assistant` payload. Shared with replay so that a fact the
 * projection refuses is also a fact replay refuses — acceptance 3 compares the two, and they can
 * only agree if they read the payload the same way.
 */
export function parseMessagePayload(entry: TapeEntry): TapeMessagePayload {
  const expectedRole = entry.name === 'message/assistant' ? 'assistant' : 'user'
  const role = readString(entry.payload, 'role', entry.name)
  if (role !== expectedRole) {
    throw new TapeProjectionError(`${entry.name}: payload.role must be '${expectedRole}'`)
  }
  const common = {
    messageId: readString(entry.payload, 'messageId', entry.name),
    revision: readOrdinal(entry.payload, 'revision', entry.name),
    content: readContent(entry.payload, entry.name),
    status: readStatus(entry.payload, entry.name),
  }
  if (expectedRole === 'assistant') {
    return { ...common, role: 'assistant', runId: readString(entry.payload, 'runId', entry.name) }
  }
  return { ...common, role: 'user' }
}

/** Reads the `messageId` off a `message/retracted` tombstone. */
export function parseRetractedMessageId(entry: TapeEntry): string {
  return readString(entry.payload, 'messageId', entry.name)
}

// ---------------------------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------------------------

function projectMessage(entry: TapeEntry): ProjectionOp[] {
  const payload = parseMessagePayload(entry)
  return [
    {
      table: 'message',
      op: 'upsert',
      key: { sessionId: entry.sessionId, messageId: payload.messageId },
      values: {
        role: payload.role,
        status: payload.status,
        contentJson: canonicalJson(payload.content),
        entryId: entry.entryId,
        updatedAt: entry.createdAt,
      },
      // `orderSeq` is this fact's own entry id. On a revision the row already exists and the upsert
      // drops it, which is exactly how the first fact's id survives.
      insertOnly: { orderSeq: entry.entryId, createdAt: entry.createdAt },
    },
    {
      table: 'session',
      op: 'upsert',
      key: { sessionId: entry.sessionId },
      values: { lastMessageAt: entry.createdAt, updatedAt: entry.createdAt },
      insertOnly: { createdAt: entry.createdAt },
    },
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function projectSessionStart(entry: TapeEntry): ProjectionOp[] {
  const forkedFrom = entry.payload['forkedFrom']
  let forkedFromSessionId: string | undefined
  if (forkedFrom !== undefined && forkedFrom !== null) {
    if (!isRecord(forkedFrom)) {
      throw new TapeProjectionError(`${entry.name}: payload.forkedFrom must be an object`)
    }
    forkedFromSessionId = readString(forkedFrom, 'sessionId', `${entry.name}.forkedFrom`)
  }
  return [
    {
      table: 'session',
      op: 'upsert',
      key: { sessionId: entry.sessionId },
      values: { updatedAt: entry.createdAt },
      insertOnly: {
        createdAt: entry.createdAt,
        ...(forkedFromSessionId === undefined ? {} : { forkedFromSessionId }),
      },
    },
  ]
}

function projectModelSelected(entry: TapeEntry): ProjectionOp[] {
  return [
    {
      table: 'session',
      op: 'upsert',
      key: { sessionId: entry.sessionId },
      values: {
        providerId: readString(entry.payload, 'providerId', entry.name),
        modelId: readString(entry.payload, 'modelId', entry.name),
        updatedAt: entry.createdAt,
      },
      // The `session/start` of the incarnation came first, so this only ever updates. `createdAt` is
      // here because the column is NOT NULL and an upsert has to be able to insert.
      insertOnly: { createdAt: entry.createdAt },
    },
  ]
}

/**
 * The key a tool/ fact hangs on. Its identity columns carry `(runId, requestSeq)` — the name table
 * binds them, so a declared tool/ fact always has both — and the payload carries `<i>`.
 */
function pendingKey(entry: TapeEntry): PendingApprovalProjectionKey {
  if (entry.sourceId === null || entry.sourceSeq === null) {
    throw new TapeProjectionError(`${entry.name}: a tool/ fact carries (runId, requestSeq)`)
  }
  return {
    sessionId: entry.sessionId,
    runId: entry.sourceId,
    requestSeq: entry.sourceSeq,
    callOrdinal: readOrdinal(entry.payload, 'ordinal', entry.name),
  }
}

/**
 * §待批表 rules 1 and 3: a decision that `awaits` upserts the row — a re-judgement that still asks
 * carries `awaits` too and so moves `entry_id` to itself — and a decision without it (allow, deny, a
 * re-judgement turned into a denial) leaves the table alone.
 */
function projectDecision(entry: TapeEntry): ProjectionOp[] {
  const awaits = entry.payload['awaits']
  if (awaits === undefined) return []
  if (awaits !== 'approval' && awaits !== 'question') {
    throw new TapeProjectionError(`${entry.name}: payload.awaits must be 'approval' or 'question'`)
  }
  return [
    {
      table: 'pending_approval',
      op: 'upsert',
      key: pendingKey(entry),
      values: { waitKind: awaits, entryId: entry.entryId },
      insertOnly: { createdAt: entry.createdAt },
    },
  ]
}

/**
 * The phase-1 facts, matched on the (kind, name) PAIR: every other combination projects to nothing
 * and passes through as evidence. `title` is never written — the interface uses the first user
 * message until phase 6 names sessions — and `provider/attempt_completed` has no projection at all.
 * `message/continuation` and `message/environment` are user messages to the provider but never a
 * row: they are not rendered.
 *
 * Spec 02 adds the pending-approval rules, and only those: every other phase-2 fact is evidence.
 */
export function project(entry: TapeEntry): ProjectionOp[] {
  if (entry.kind === 'message') {
    if (entry.name === 'message/user' || entry.name === 'message/assistant') {
      return projectMessage(entry)
    }
    return []
  }
  if (entry.kind === 'tool_result') {
    // §待批表 rule 2: the call's result ends its wait — a question's answer IS its result. Deleting a
    // row that is not there is a no-op.
    return entry.name === 'tool/result'
      ? [{ table: 'pending_approval', op: 'delete', key: pendingKey(entry) }]
      : []
  }
  if (entry.kind === 'anchor') {
    return entry.name === 'session/start' ? projectSessionStart(entry) : []
  }
  if (entry.kind === 'event') {
    if (entry.name === 'message/retracted') {
      return [
        {
          table: 'message',
          op: 'delete',
          key: { sessionId: entry.sessionId, messageId: parseRetractedMessageId(entry) },
        },
      ]
    }
    if (entry.name === 'session/model_selected') return projectModelSelected(entry)
    if (entry.name === 'tool/permission_decided') return projectDecision(entry)
    if (entry.name === 'tool/approval_resolved') {
      return [{ table: 'pending_approval', op: 'delete', key: pendingKey(entry) }]
    }
  }
  return []
}
