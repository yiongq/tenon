/**
 * The `TapeStore` port (spec 01 §存储端口): the one boundary between the kernel and whatever holds
 * the facts — better-sqlite3 on the desktop, this package's memory store for an incognito session,
 * Postgres in 6b. Four properties of the contract are load-bearing and stated here so no
 * implementation can quietly drop one:
 *
 * 1. **Asynchronous.** A server implementation cannot be synchronous, and on the desktop async
 *    costs nothing measurable (100k inserts in one transaction: 404 ms synchronous against 358 ms
 *    through this port). The driver underneath may still block its thread, so the port only ever
 *    exposes BOUNDED operations — hence `limit` on every read.
 * 2. **`entryId` allocation stays behind the port.** The kernel is promised a strictly increasing,
 *    never reused id and assumes nothing about holes. Implementations allocate from the
 *    `session_head.last_entry_id` HIGH-WATER mark, never `MAX(entry_id) + 1`: after a physical
 *    reset the latter reuses ids, which would silently point a stale reference at a different fact.
 * 3. **Idempotency is decided by the key first.** An append looks the `provenanceKey` up before it
 *    allocates anything; a hit with equal content returns `created: false` and the ORIGINAL
 *    `entryId` / `entryHash`, writes no second row and no second projection, and leaves the head
 *    untouched. A hit with different content is a `TapeProvenanceConflictError` — a bug or
 *    corruption, never something a loop may swallow.
 * 4. **No host types cross.** Digests are `Uint8Array` (better-sqlite3 hands out a Node `Buffer`,
 *    which an implementation must convert), integers are `number` inside `Number.MAX_SAFE_INTEGER`,
 *    and nothing is a `bigint` (invariant 17).
 *
 * The tenant is never a parameter. A store is constructed bound to a `HostIdentity`, so forgetting
 * the tenant predicate is impossible rather than merely discouraged. And a store is NOT a
 * `HostAdapter` member: the adapter carries environment capabilities, while one process holds
 * several stores at once (SQLite for normal sessions, memory for incognito ones).
 *
 * The seventh named error of the spec's list, `TapeIntegerRangeError`, already lives in `entry.ts`
 * next to the promise it enforces; it is deliberately not redefined here — two classes with one
 * name would break every `instanceof`.
 */
import type { ContentBlock } from '../provider/types.js'
import type {
  AppendResult,
  MessageStatus,
  NewEntry,
  TapeEntry,
  TapeKind,
  TapeSourceType,
} from './entry.js'

/**
 * The upper bound on every read. There is no unbounded scan on this port (invariant 16): a store
 * that answers "all of it" is a store whose worst case is the user's whole history.
 */
export const MAX_READ_LIMIT = 1000

/** Same key, DIFFERENT content. Not a retry — a bug or corruption, so the loop never swallows it. */
export class TapeProvenanceConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeProvenanceConflictError'
  }
}

/** The identity opening the store is not the tenant the storage belongs to. */
export class TapeTenantMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeTenantMismatchError'
  }
}

/** The incarnation the caller carries is no longer the one on the head row. */
export class TapeStaleIncarnationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeStaleIncarnationError'
  }
}

/** No head row for this session under this tenant. Reset never conjures a session into existence. */
export class TapeSessionNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeSessionNotFoundError'
  }
}

/**
 * The write lock was held past the timeout. Retrying is the CALLER's job and the unit of retry is
 * the whole `append` — a store never retries by itself, or the loop would lose count of how many
 * physical attempts happened.
 */
export class TapeBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeBusyError'
  }
}

/** `limit` is missing, not a positive integer, or above `MAX_READ_LIMIT`. */
export class TapeReadLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeReadLimitError'
  }
}

/** `session_head` minus nothing: the row as the kernel sees it. */
export interface SessionHead {
  tenantId: string
  sessionId: string
  incarnationId: string
  /** High-water mark. Never decreases, not even across `resetSession`. */
  lastEntryId: number
  /** The chain head of the current incarnation; null just after creation or a reset. */
  lastHash: Uint8Array | null
  /** Facts in the CURRENT incarnation. */
  entryCount: number
  createdAt: number
  updatedAt: number
}

/**
 * `message_projection`'s columns minus `tenant_id`, camelCase. `content` is the decoded
 * `content_json`: the column's suffix names its on-disk encoding, and what crosses the port is the
 * content model itself.
 */
export interface MessageRow {
  sessionId: string
  messageId: string
  /** `entry_id` of the FIRST `message/*` fact of this messageId. A revision never moves it. */
  orderSeq: number
  role: 'user' | 'assistant'
  status: MessageStatus
  content: ContentBlock[]
  /** `entry_id` of the fact this row's content came from — a revision DOES move this one. */
  entryId: number
  createdAt: number
  updatedAt: number
}

/**
 * `session_projection`'s columns minus `tenant_id`, camelCase. `title` has no phase-1 writer (the
 * interface uses the first user message); the column is held for phase 6's auto-naming. There is
 * deliberately no message count: a per-fact reducer with no expressions cannot maintain a running
 * total, so a caller that needs one counts `message_projection`.
 */
export interface SessionSummary {
  sessionId: string
  title: string | null
  providerId: string | null
  modelId: string | null
  lastMessageAt: number | null
  forkedFromSessionId: string | null
  createdAt: number
  updatedAt: number
}

export interface TapeAppendBatch {
  sessionId: string
  /**
   * Minted by the kernel and carried with EVERY batch. No head row yet ⇒ the store creates one
   * with this id (the kernel guarantees a new incarnation opens with `session/start`); a head row
   * carrying a different id ⇒ `TapeStaleIncarnationError`. A store therefore never mints an id of
   * its own and never assembles a fact under a reserved name.
   */
  incarnationId: string
  entries: readonly NewEntry[]
}

export interface TapeReadRangeQuery {
  sessionId: string
  /** Inclusive lower bound. */
  fromEntryId?: number
  /** Inclusive snapshot upper bound. Pin it while paging and appends cannot leak into the pages. */
  atEntryId?: number
  /** While paging, hand the previous page's value back; a mismatch throws `TapeStaleIncarnationError`. */
  incarnationId?: string
  kinds?: readonly TapeKind[]
  /** Required, ≤ `MAX_READ_LIMIT`. A call without it is a compile error, by design. */
  limit: number
}

export interface TapeReadRangePage {
  entries: TapeEntry[]
  incarnationId: string
  nextFromEntryId: number | null
}

export interface TapeReadBySourceQuery {
  sessionId: string
  sourceType: TapeSourceType
  sourceId: string
  limit: number
}

export interface TapeVerifyChainQuery {
  sessionId: string
  fromEntryId?: number
  incarnationId?: string
  limit: number
}

export interface TapeVerifyChainPage {
  incarnationId: string
  /** Rows examined by this page, the first bad one included. */
  checked: number
  /** The FIRST bad entry, not a boolean: a verifier has to say WHICH row stopped being provable. */
  firstBadEntryId: number | null
  nextFromEntryId: number | null
}

export interface TapeListSessionsQuery {
  limit: number
  /** Cursor: only sessions whose `updatedAt` is strictly below this. */
  updatedBefore?: number
}

export interface TapeListMessagesQuery {
  sessionId: string
  limit: number
  afterOrderSeq?: number
  beforeOrderSeq?: number
}

export interface TapeResetSessionQuery {
  sessionId: string
  /** The NEW incarnation. Reusing the current one would make two generations hash-indistinguishable. */
  incarnationId: string
  /** The `session/start` the kernel assembled. A store never builds a reserved fact itself. */
  start: NewEntry
}

export interface TapeStore {
  /**
   * One transaction: allocate each `entryId`, link the chain, insert, apply the projection ops.
   * All of the batch or none of it. There is only this one write shape — a single fact is a batch
   * of length one.
   */
  append(batch: TapeAppendBatch): Promise<AppendResult[]>

  readRange(q: TapeReadRangeQuery): Promise<TapeReadRangePage>

  /**
   * The read phase 2's crash recovery needs: every fact grouped under one `runId` by the identity
   * columns, in `entry_id` order, on the index alone.
   */
  readBySource(q: TapeReadBySourceQuery): Promise<TapeEntry[]>

  head(sessionId: string): Promise<SessionHead | null>

  /** Paged, and it recomputes `content_hash` from the STORED text — otherwise a flipped byte hides. */
  verifyChain(q: TapeVerifyChainQuery): Promise<TapeVerifyChainPage>

  // Projection reads. The interface reads these, never tape_entry.
  listSessions(q: TapeListSessionsQuery): Promise<SessionSummary[]>
  /** With no cursor, the LATEST `limit` rows: the interface opens at the tail of a conversation. */
  listMessages(q: TapeListMessagesQuery): Promise<MessageRow[]>
  rebuildProjections(sessionId: string): Promise<void>

  /**
   * Physical reset, one transaction: drop every fact and projection of the session, swap the head
   * to a new incarnation (`last_entry_id` NOT decreased, `last_hash` null, `entry_count` 0), then
   * write the `session/start` the kernel assembled. No head row under this tenant ⇒ nothing is
   * written and `TapeSessionNotFoundError` is thrown.
   */
  resetSession(q: TapeResetSessionQuery): Promise<AppendResult>

  /** Physical delete: facts, head, projections, cursors. */
  deleteSession(sessionId: string): Promise<void>

  close(): Promise<void>
}

/**
 * The read half of the port. Replay and any other reader takes this rather than the whole store, so
 * a reader cannot reach `append` — and the kernel facade, which has the same method, satisfies it.
 */
export type TapeReader = Pick<TapeStore, 'readRange'>

/**
 * The one gate in front of every `limit`. Non-integers and zero are refused too: the spec fixes the
 * ceiling, and admitting `limit: 0` or `limit: 1.5` would leave each store to invent its own answer.
 */
export function assertReadLimit(limit: number, label = 'limit'): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
    throw new TapeReadLimitError(
      `${label} must be an integer in 1..${MAX_READ_LIMIT}; got ${String(limit)}`,
    )
  }
  return limit
}

/**
 * The other gate every `readRange` runs. An EMPTY `kinds` array is refused rather than answered: "no
 * rows" and "no filter" are equally plausible readings of it, `kind IN ()` is not even valid SQL, and
 * each store would otherwise invent its own answer. The spec is silent, so this is the strict reading
 * — admitting one meaning later is a one-line change, while two stores having settled on opposite
 * ones is not. Omitting `kinds` remains how a caller says "every kind".
 *
 * A `TypeError`, not one of the seven tape errors: an empty filter is a programmer error at the call
 * site, and it is on the port so a store cannot forget it.
 */
export function assertReadKinds(kinds: readonly TapeKind[] | undefined): void {
  if (kinds !== undefined && kinds.length === 0) {
    throw new TypeError('readRange: kinds must not be empty; omit it to read every kind')
  }
}
