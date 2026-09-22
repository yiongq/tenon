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
 * The rules every implementation owes are FUNCTIONS at the bottom of this file, not prose: the read
 * limit, the kinds filter, the append gate, the batch gate, the idempotency comparison and the
 * incarnation check. A store keeps its own row shape and its own SQL; what it may not keep is its own
 * answer to one of these questions, or the two stores drift apart exactly where the conformance suite
 * assumes they cannot.
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
import { canonicalJson } from './canonical-json.js'
import type {
  AppendResult,
  MessageStatus,
  NewEntry,
  TapeEntry,
  TapeKind,
  TapeSourceType,
} from './entry.js'
import { TapeIntegerRangeError } from './entry.js'
import { bytesEqual, contentHash } from './hash.js'
import { assertAppendAuthorized, declaredTapeName } from './names.js'
import { assertProvenanceKey } from './provenance.js'

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
   * Minted by the kernel and carried with EVERY batch. No head row yet ⇒ the store creates one with
   * this id, and ONLY for a batch that opens with `session/start` (`assertBatchOpensIncarnation`) —
   * the rule is enforced rather than promised, because the caller that guarantees it cannot see a
   * `deleteSession` land between its head read and its append. A head row carrying a different id ⇒
   * `TapeStaleIncarnationError`. A store therefore never mints an id of its own and never assembles
   * a fact under a reserved name.
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

/**
 * An integer a store may keep. `createdAt` and `sourceSeq` arrive from a caller, so they are checked
 * before they are stored rather than after they come back — SQLite would keep a 2^60 timestamp
 * happily and hand it back as a truncated double.
 */
export function assertSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new TapeIntegerRangeError(`${label} must be a safe integer, got ${String(value)}`)
  }
  return value
}

/**
 * An id on the port. A `TypeError`, not one of the seven tape errors: an empty id is a programmer
 * error at the call site, not a condition of the tape, and widening a named error to cover it would
 * blunt what catching that error tells a caller.
 */
export function assertTapeId(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

/**
 * The store's own append gate (spec 01 §保留命名空间). Looking the declaration up and checking the
 * name against ITS OWN slice is exactly as strict as the facade for everything a store can know: a
 * declared name must carry its declared kind and identity triple, and an undeclared one must be
 * `ext/<owner>/…` under no reserved prefix. Only "this slice may not write another slice's names" is
 * beyond a store — it never learns who called — and that half is the facade's.
 *
 * It lives on the port next to the two read gates because EVERY implementation owes it: the reason
 * §哈希链 gives for keeping the recipe in the kernel (「各 host 各写一份 … 链就会分叉」) holds for the
 * port's rules too, and a Postgres host in 6b would otherwise write a third copy of them.
 */
export function assertEntryAllowed(entry: NewEntry): void {
  assertProvenanceKey(entry.provenanceKey)
  assertAppendAuthorized(
    {
      kind: entry.kind,
      name: entry.name,
      sourceType: entry.sourceType,
      ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
      ...(entry.sourceSeq === undefined ? {} : { sourceSeq: entry.sourceSeq }),
    },
    declaredTapeName(entry.name)?.slice ?? null,
  )
  assertSafeInteger(entry.createdAt, `${entry.name}.createdAt`)
  if (entry.sourceSeq !== undefined) assertSafeInteger(entry.sourceSeq, `${entry.name}.sourceSeq`)
}

/**
 * The WHOLE batch is validated before a single fact can reach storage: a batch is one transaction, so
 * one bad entry keeps the good ones out. A repeated `provenanceKey` inside one batch is a caller bug
 * (§存储端口), not an idempotent replay, and rejects the batch.
 */
export function assertBatchAllowed(entries: readonly NewEntry[]): void {
  const seen = new Set<string>()
  for (const entry of entries) {
    assertEntryAllowed(entry)
    if (seen.has(entry.provenanceKey)) {
      throw new TapeProvenanceConflictError(
        `provenanceKey "${entry.provenanceKey}" appears twice in one batch; ` +
          'a batch is one transaction, so the whole batch is rejected',
      )
    }
    seen.add(entry.provenanceKey)
  }
}

/**
 * The gate on CREATING a head row, owed by every implementation for the same reason
 * `assertBatchAllowed` is (§存储端口): a batch that does not OPEN with `session/start` may not bring
 * a session into existence.
 *
 * Without it the parenthetical in `TapeAppendBatch` — 「kernel 保证新 incarnation 的第一条是
 * session/start」 — is a promise no reader can rely on: a caller that read the head, was overtaken by
 * a `deleteSession` and then appended would silently RESURRECT the session, with its first fact a
 * `message/assistant`, a projection row under no anchor, and a reused `incarnationId` whose entry ids
 * restart at 1 — the very reuse `resetSession` refuses. A kernel-side re-read cannot close that
 * window; this can, because it runs inside the same transaction as the insert.
 */
export function assertBatchOpensIncarnation(sessionId: string, first: NewEntry): void {
  if (first.name !== 'session/start') {
    throw new TapeSessionNotFoundError(
      `session "${sessionId}" has no head row, and a batch opening with "${first.name}" ` +
        'may not create one: an incarnation opens with session/start',
    )
  }
}

/**
 * The minimum a stored row has to expose for the idempotency comparison — the same trick
 * `StoredEntryFields` plays for the chain predicate, so a store keeps its own row shape and still
 * cannot answer the question its own way.
 */
export interface StoredEntryIdentity {
  readonly entryId: number
  readonly entryHash: Uint8Array
  readonly kind: TapeKind
  readonly name: string
  readonly sourceType: TapeSourceType
  readonly sourceId: string | null
  readonly sourceSeq: number | null
  readonly contentHash: Uint8Array
}

/**
 * The idempotency comparison (§存储端口 「幂等的判定」, a rule the port must state): `content_hash`
 * AND the five identity columns. `created_at` is deliberately NOT compared — replaying the same fact
 * with a later clock is still the same fact. The receipt carries the ORIGINAL `entryId` and
 * `entryHash`, copied so no caller holds a window into a store's own state.
 */
export function idempotentAppendResult(hit: StoredEntryIdentity, entry: NewEntry): AppendResult {
  const payloadJson = canonicalJson(entry.payload)
  const metaJson = canonicalJson(entry.meta ?? {})
  const differences: string[] = []
  if (!bytesEqual(contentHash(payloadJson, metaJson), hit.contentHash)) {
    differences.push('payload/meta')
  }
  if (entry.kind !== hit.kind) differences.push(`kind ${entry.kind} != ${hit.kind}`)
  if (entry.name !== hit.name) differences.push(`name ${entry.name} != ${hit.name}`)
  if (entry.sourceType !== hit.sourceType) {
    differences.push(`sourceType ${entry.sourceType} != ${hit.sourceType}`)
  }
  if ((entry.sourceId ?? null) !== hit.sourceId) {
    differences.push(`sourceId ${String(entry.sourceId ?? null)} != ${String(hit.sourceId)}`)
  }
  if ((entry.sourceSeq ?? null) !== hit.sourceSeq) {
    differences.push(`sourceSeq ${String(entry.sourceSeq ?? null)} != ${String(hit.sourceSeq)}`)
  }
  if (differences.length > 0) {
    throw new TapeProvenanceConflictError(
      `provenanceKey "${entry.provenanceKey}" already exists with different content ` +
        `(${differences.join('; ')}); this is corruption or a bug, never a retry`,
    )
  }
  return { entryId: hit.entryId, entryHash: new Uint8Array(hit.entryHash), created: false }
}

/**
 * A paging caller carries the incarnation it started on; a mismatch means the session was reset under
 * it, and answering with the new generation's rows would splice two histories into one page.
 */
export function assertCurrentIncarnation(
  sessionId: string,
  head: { readonly incarnationId: string },
  incarnationId: string | undefined,
): void {
  if (incarnationId !== undefined && incarnationId !== head.incarnationId) {
    throw new TapeStaleIncarnationError(
      `session "${sessionId}" is at incarnation ${head.incarnationId}, not ${incarnationId}`,
    )
  }
}
