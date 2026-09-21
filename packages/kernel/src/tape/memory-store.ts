/**
 * The in-memory `TapeStore` (spec 01 §存储端口, §删除语义, §SQLite 实现约束).
 *
 * It is a faithful SEMANTIC TWIN of the SQLite store, not a convenience double: the shared
 * conformance suite runs against both, incognito sessions ship on this one (§删除语义: "无痕 = 该会话
 * 用内存 store，不是一个列"), and any divergence would mean the suite proves the wrong thing. So it
 * follows the same statement order the spec fixes for an append and keeps the same data on the same
 * shape of row:
 *
 *   ① look the `provenance_key` up FIRST — a hit takes the idempotent branch and allocates NOTHING,
 *      or every duplicate would burn an id and dirty the head;
 *   ② allocate from the head's high-water mark and take the UNCHANGED `prev_hash` and the
 *      incarnation in the same step;
 *   ③ hash; ④ insert; ⑤ write `last_hash` back; ⑥ apply the projection ops.
 *   Never make the new hash an input of the allocation — that is a cycle.
 *
 * Facts are stored as the TEXT `canonicalJson` produced, exactly as SQLite stores them, and reads
 * parse that text. That is what makes `verifyChain` able to recompute `content_hash` from the stored
 * bytes here too, and it gives every reader a fresh copy for free.
 *
 * Atomicity is a copy-on-write transaction: a batch works on cloned containers and swaps them in
 * only after the last entry succeeded, so any throw leaves entries, head, projections and cursors
 * exactly as they were and the same store still appends afterwards (acceptance 9's rollback half).
 * Rows are treated as immutable — an update replaces the object — which is what makes cloning the
 * containers enough.
 */
import type { HostIdentity } from '../host/adapter.js'
import { canonicalJson } from './canonical-json.js'
import type {
  AppendResult,
  MessageStatus,
  NewEntry,
  TapeEntry,
  TapeKind,
  TapeSourceType,
} from './entry.js'
import { HASH_VER, contentHash, hashEntry, isStoredEntryProvable } from './hash.js'
import type { ProjectionOp, ProjectionReducer, ProjectionTable } from './projection.js'
import {
  PROJECTION_TABLES,
  PROJECTION_VERSION,
  TapeProjectionError,
  project,
} from './projection.js'
import type {
  MessageRow,
  SessionHead,
  SessionSummary,
  TapeAppendBatch,
  TapeListMessagesQuery,
  TapeListSessionsQuery,
  TapeReadBySourceQuery,
  TapeReadRangePage,
  TapeReadRangeQuery,
  TapeResetSessionQuery,
  TapeStore,
  TapeVerifyChainPage,
  TapeVerifyChainQuery,
} from './store.js'
import {
  TapeSessionNotFoundError,
  TapeStaleIncarnationError,
  assertBatchAllowed,
  assertCurrentIncarnation,
  assertEntryAllowed,
  assertReadKinds,
  assertReadLimit,
  assertSafeInteger,
  assertTapeId,
  idempotentAppendResult,
} from './store.js'

export interface MemoryTapeStoreOptions {
  /** The store is BOUND to this identity; the tenant is never a method parameter. */
  readonly identity: HostIdentity
  /** Injectable so a test can count applications (acceptance 11). Defaults to the kernel reducer. */
  readonly project?: ProjectionReducer
}

/** A `tape_entry` row. `tenant_id` and `session_id` are the store's and the session's. */
interface StoredEntry {
  readonly entryId: number
  readonly incarnationId: string
  readonly kind: TapeKind
  readonly name: string
  readonly sourceType: TapeSourceType
  readonly sourceId: string | null
  readonly sourceSeq: number | null
  readonly provenanceKey: string
  /** The stored bytes. Hashing and verification use this text, never a fresh serialisation. */
  readonly payloadJson: string
  readonly metaJson: string
  readonly createdAt: number
  readonly contentHash: Uint8Array
  readonly prevHash: Uint8Array | null
  readonly entryHash: Uint8Array
  readonly hashVer: number
}

interface HeadRow {
  readonly incarnationId: string
  readonly lastEntryId: number
  readonly lastHash: Uint8Array | null
  readonly entryCount: number
  readonly createdAt: number
  readonly updatedAt: number
}

interface MessageProjectionRow {
  readonly messageId: string
  readonly orderSeq: number
  readonly role: 'user' | 'assistant'
  readonly status: MessageStatus
  readonly contentJson: string
  readonly entryId: number
  readonly createdAt: number
  readonly updatedAt: number
}

interface SessionProjectionRow {
  readonly title: string | null
  readonly providerId: string | null
  readonly modelId: string | null
  readonly lastMessageAt: number | null
  readonly forkedFromSessionId: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** `projection_cursor`. Invisible through the port; kept so the twin holds the same state. */
interface CursorRow {
  readonly incarnationId: string
  readonly lastEntryId: number
  readonly projectionVersion: number
  readonly updatedAt: number
}

interface SessionState {
  head: HeadRow
  /** Always ascending by `entryId`; only the current incarnation's facts are ever present. */
  entries: StoredEntry[]
  byKey: Map<string, StoredEntry>
  messages: Map<string, MessageProjectionRow>
  session: SessionProjectionRow | null
  cursors: Map<ProjectionTable, CursorRow>
}

function cloneSession(state: SessionState): SessionState {
  return {
    head: state.head,
    entries: [...state.entries],
    byKey: new Map(state.byKey),
    messages: new Map(state.messages),
    session: state.session,
    cursors: new Map(state.cursors),
  }
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

/** SQLite's BINARY collation on the ASCII / BMP ids the port sees: plain code-unit order. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Applies the reducer's ops to a transaction's containers. Module scope, not a closure: it needs
 * nothing from the store but the transaction it is handed, and that keeps it obvious that a
 * projection is a function of the facts alone.
 */
function applyOps(tx: SessionState, sessionId: string, ops: readonly ProjectionOp[]): void {
  for (const op of ops) {
    if (op.key.sessionId !== sessionId) {
      throw new TapeProjectionError(
        `a projection op for session "${op.key.sessionId}" cannot be applied while appending ` +
          `to "${sessionId}"`,
      )
    }
    if (op.table === 'message') {
      if (op.op === 'delete') {
        tx.messages.delete(op.key.messageId)
        continue
      }
      const existing = tx.messages.get(op.key.messageId)
      if (existing === undefined) {
        if (op.insertOnly === undefined) {
          throw new TapeProjectionError(
            `inserting message_projection "${op.key.messageId}" needs insertOnly ` +
              '(order_seq and created_at are NOT NULL)',
          )
        }
        tx.messages.set(op.key.messageId, {
          messageId: op.key.messageId,
          orderSeq: op.insertOnly.orderSeq,
          role: op.values.role,
          status: op.values.status,
          contentJson: op.values.contentJson,
          entryId: op.values.entryId,
          createdAt: op.insertOnly.createdAt,
          updatedAt: op.values.updatedAt,
        })
        continue
      }
      // insertOnly is deliberately dropped here: order_seq and created_at do not move.
      tx.messages.set(op.key.messageId, {
        ...existing,
        role: op.values.role,
        status: op.values.status,
        contentJson: op.values.contentJson,
        entryId: op.values.entryId,
        updatedAt: op.values.updatedAt,
      })
      continue
    }
    if (op.op === 'delete') {
      tx.session = null
      continue
    }
    const existing = tx.session
    if (existing === null) {
      if (op.insertOnly === undefined) {
        throw new TapeProjectionError(
          `inserting session_projection "${sessionId}" needs insertOnly (created_at is NOT NULL)`,
        )
      }
      tx.session = {
        title: null,
        providerId: op.values.providerId ?? null,
        modelId: op.values.modelId ?? null,
        lastMessageAt: op.values.lastMessageAt ?? null,
        forkedFromSessionId: op.insertOnly.forkedFromSessionId ?? null,
        createdAt: op.insertOnly.createdAt,
        updatedAt: op.values.updatedAt,
      }
      continue
    }
    // An absent value means "do not touch that column", which is what `??` says.
    tx.session = {
      ...existing,
      providerId: op.values.providerId ?? existing.providerId,
      modelId: op.values.modelId ?? existing.modelId,
      lastMessageAt: op.values.lastMessageAt ?? existing.lastMessageAt,
      updatedAt: op.values.updatedAt,
    }
  }
}

/**
 * The cursor records what a projection has CONSUMED, not what it wrote, so it advances for every
 * inserted fact — including the ones that project to nothing.
 */
function advanceCursors(tx: SessionState, entryId: number, updatedAt: number): void {
  for (const table of PROJECTION_TABLES) {
    tx.cursors.set(table, {
      incarnationId: tx.head.incarnationId,
      lastEntryId: entryId,
      projectionVersion: PROJECTION_VERSION,
      updatedAt,
    })
  }
}

export function createMemoryTapeStore(options: MemoryTapeStoreOptions): TapeStore {
  const tenantId = options.identity.tenantId
  const reduce: ProjectionReducer = options.project ?? project
  const sessions = new Map<string, SessionState>()

  function toTapeEntry(sessionId: string, stored: StoredEntry): TapeEntry {
    return {
      tenantId,
      sessionId,
      entryId: stored.entryId,
      incarnationId: stored.incarnationId,
      kind: stored.kind,
      name: stored.name,
      sourceType: stored.sourceType,
      sourceId: stored.sourceId,
      sourceSeq: stored.sourceSeq,
      provenanceKey: stored.provenanceKey,
      // Parsed from the stored text on every read, as the SQLite store does: the caller gets a fresh
      // object it cannot use to reach back into the store.
      payload: parseJsonObject(stored.payloadJson, `${stored.name}.payload`),
      meta: parseJsonObject(stored.metaJson, `${stored.name}.meta`),
      createdAt: stored.createdAt,
      contentHash: copyBytes(stored.contentHash),
      prevHash: stored.prevHash === null ? null : copyBytes(stored.prevHash),
      entryHash: copyBytes(stored.entryHash),
      hashVer: stored.hashVer,
    }
  }

  /** Steps ②–⑥ for one fact, on the transaction's containers. */
  function insertEntry(tx: SessionState, sessionId: string, entry: NewEntry): AppendResult {
    const entryId = assertSafeInteger(tx.head.lastEntryId + 1, 'entryId')
    const prevHash = tx.head.lastHash
    const incarnationId = tx.head.incarnationId
    const payloadJson = canonicalJson(entry.payload)
    const metaJson = canonicalJson(entry.meta ?? {})
    const sourceId = entry.sourceId ?? null
    const sourceSeq = entry.sourceSeq ?? null
    const digest = contentHash(payloadJson, metaJson)
    const stored: StoredEntry = {
      entryId,
      incarnationId,
      kind: entry.kind,
      name: entry.name,
      sourceType: entry.sourceType,
      sourceId,
      sourceSeq,
      provenanceKey: entry.provenanceKey,
      payloadJson,
      metaJson,
      createdAt: entry.createdAt,
      contentHash: digest,
      prevHash,
      entryHash: hashEntry({
        hashVer: HASH_VER,
        tenantId,
        sessionId,
        incarnationId,
        entryId,
        kind: entry.kind,
        name: entry.name,
        sourceType: entry.sourceType,
        sourceId,
        sourceSeq,
        provenanceKey: entry.provenanceKey,
        createdAt: entry.createdAt,
        contentHash: digest,
        prevHash,
      }),
      hashVer: HASH_VER,
    }
    tx.entries.push(stored)
    tx.byKey.set(stored.provenanceKey, stored)
    tx.head = {
      ...tx.head,
      lastEntryId: entryId,
      entryCount: tx.head.entryCount + 1,
      lastHash: stored.entryHash,
      updatedAt: entry.createdAt,
    }
    applyOps(tx, sessionId, reduce(toTapeEntry(sessionId, stored)))
    advanceCursors(tx, entryId, entry.createdAt)
    return { entryId, entryHash: copyBytes(stored.entryHash), created: true }
  }

  function rebuildInto(tx: SessionState, sessionId: string): void {
    tx.messages = new Map()
    tx.session = null
    tx.cursors = new Map()
    for (const stored of tx.entries) {
      applyOps(tx, sessionId, reduce(toTapeEntry(sessionId, stored)))
      advanceCursors(tx, stored.entryId, stored.createdAt)
    }
  }

  /**
   * One link of the chain, through the kernel's own predicate: the recipe and its verification are
   * one module, so this store and the SQLite one cannot drift into checking different things. A row's
   * whole verdict — content digest against the STORED text, `prev_hash` against the previous seal, the
   * seal itself, an unknown `hash_ver` — lives in `isStoredEntryProvable`.
   */
  function isEntryProvable(
    sessionId: string,
    stored: StoredEntry,
    previous: Uint8Array | null,
  ): boolean {
    return isStoredEntryProvable({ ...stored, tenantId, sessionId }, previous)
  }

  function toMessageRow(sessionId: string, row: MessageProjectionRow): MessageRow {
    return {
      sessionId,
      messageId: row.messageId,
      orderSeq: row.orderSeq,
      role: row.role,
      status: row.status,
      content: parseJsonArray(row.contentJson, `message_projection.${row.messageId}`),
      entryId: row.entryId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  return {
    append(batch: TapeAppendBatch): Promise<AppendResult[]> {
      return run(() => {
        assertTapeId(batch.sessionId, 'sessionId')
        assertTapeId(batch.incarnationId, 'incarnationId')
        assertBatchAllowed(batch.entries)
        const existing = sessions.get(batch.sessionId)
        if (existing !== undefined && existing.head.incarnationId !== batch.incarnationId) {
          throw new TapeStaleIncarnationError(
            `session "${batch.sessionId}" is at incarnation ${existing.head.incarnationId}, ` +
              `not ${batch.incarnationId}`,
          )
        }
        const first = batch.entries[0]
        if (first === undefined) return []
        const tx: SessionState =
          existing === undefined
            ? {
                // No head row: create it with the incarnation the kernel minted. The store never
                // mints one and never fabricates the `session/start` that must open it.
                head: {
                  incarnationId: batch.incarnationId,
                  lastEntryId: 0,
                  lastHash: null,
                  entryCount: 0,
                  createdAt: first.createdAt,
                  updatedAt: first.createdAt,
                },
                entries: [],
                byKey: new Map<string, StoredEntry>(),
                messages: new Map<string, MessageProjectionRow>(),
                session: null,
                cursors: new Map<ProjectionTable, CursorRow>(),
              }
            : cloneSession(existing)
        const results: AppendResult[] = []
        for (const entry of batch.entries) {
          const hit = tx.byKey.get(entry.provenanceKey)
          results.push(
            hit === undefined
              ? insertEntry(tx, batch.sessionId, entry)
              : idempotentAppendResult(hit, entry),
          )
        }
        sessions.set(batch.sessionId, tx)
        return results
      })
    },

    readRange(q: TapeReadRangeQuery): Promise<TapeReadRangePage> {
      return run(() => {
        const limit = assertReadLimit(q.limit)
        assertReadKinds(q.kinds)
        const state = sessions.get(q.sessionId)
        // An unknown session reads as empty rather than throwing: a store cannot tell "another
        // tenant's session" from "never existed", and acceptance 4 requires the first to look absent.
        if (state === undefined) return { entries: [], incarnationId: '', nextFromEntryId: null }
        assertCurrentIncarnation(q.sessionId, state.head, q.incarnationId)
        const entries: TapeEntry[] = []
        for (const stored of state.entries) {
          if (q.fromEntryId !== undefined && stored.entryId < q.fromEntryId) continue
          if (q.atEntryId !== undefined && stored.entryId > q.atEntryId) break
          if (q.kinds !== undefined && !q.kinds.includes(stored.kind)) continue
          entries.push(toTapeEntry(q.sessionId, stored))
          if (entries.length === limit) break
        }
        const last = entries.at(-1)
        return {
          entries,
          incarnationId: state.head.incarnationId,
          // A full page means "there may be more"; a short page is the end. The same rule a
          // `LIMIT ?` query gives, so both stores page identically — at the price of one empty last
          // page when the count is an exact multiple of the limit.
          nextFromEntryId: last !== undefined && entries.length === limit ? last.entryId + 1 : null,
        }
      })
    },

    readBySource(q: TapeReadBySourceQuery): Promise<TapeEntry[]> {
      return run(() => {
        const limit = assertReadLimit(q.limit)
        const state = sessions.get(q.sessionId)
        if (state === undefined) return []
        const entries: TapeEntry[] = []
        for (const stored of state.entries) {
          if (stored.sourceType !== q.sourceType || stored.sourceId !== q.sourceId) continue
          entries.push(toTapeEntry(q.sessionId, stored))
          if (entries.length === limit) break
        }
        return entries
      })
    },

    head(sessionId: string): Promise<SessionHead | null> {
      return run(() => {
        const state = sessions.get(sessionId)
        if (state === undefined) return null
        return {
          tenantId,
          sessionId,
          incarnationId: state.head.incarnationId,
          lastEntryId: state.head.lastEntryId,
          lastHash: state.head.lastHash === null ? null : copyBytes(state.head.lastHash),
          entryCount: state.head.entryCount,
          createdAt: state.head.createdAt,
          updatedAt: state.head.updatedAt,
        }
      })
    },

    verifyChain(q: TapeVerifyChainQuery): Promise<TapeVerifyChainPage> {
      return run(() => {
        const limit = assertReadLimit(q.limit)
        const state = sessions.get(q.sessionId)
        if (state === undefined) {
          return { incarnationId: '', checked: 0, firstBadEntryId: null, nextFromEntryId: null }
        }
        assertCurrentIncarnation(q.sessionId, state.head, q.incarnationId)
        let start = 0
        if (q.fromEntryId !== undefined) {
          while (start < state.entries.length) {
            const candidate = state.entries[start]
            if (candidate !== undefined && candidate.entryId >= q.fromEntryId) break
            start += 1
          }
        }
        let checked = 0
        let firstBadEntryId: number | null = null
        let lastExamined: number | null = null
        for (let index = start; index < state.entries.length && checked < limit; index += 1) {
          const stored = state.entries[index]
          if (stored === undefined) break
          checked += 1
          lastExamined = stored.entryId
          const previous = index === 0 ? null : (state.entries[index - 1]?.entryHash ?? null)
          if (!isEntryProvable(q.sessionId, stored, previous)) {
            firstBadEntryId = stored.entryId
            break
          }
        }
        return {
          incarnationId: state.head.incarnationId,
          checked,
          firstBadEntryId,
          nextFromEntryId:
            firstBadEntryId === null && checked === limit && lastExamined !== null
              ? lastExamined + 1
              : null,
        }
      })
    },

    listSessions(q: TapeListSessionsQuery): Promise<SessionSummary[]> {
      return run(() => {
        const limit = assertReadLimit(q.limit)
        const rows: SessionSummary[] = []
        for (const [sessionId, state] of sessions) {
          const row = state.session
          if (row === null) continue
          if (q.updatedBefore !== undefined && row.updatedAt >= q.updatedBefore) continue
          rows.push({ sessionId, ...row })
        }
        // Newest first, with the session id as the tie-break so the order is total. Compared by CODE
        // UNIT, not `localeCompare`: SQLite's `ORDER BY … session_id ASC` is BINARY collation, and
        // the point of the tie-break is that both stores return the SAME total order. `localeCompare`
        // would also make the order depend on the runtime's ICU build. (Ids outside the BMP would
        // still differ — UTF-8 byte order is not UTF-16 code-unit order — but phase 1 mints UUIDs.)
        return rows
          .toSorted((left, right) =>
            right.updatedAt === left.updatedAt
              ? compareCodeUnits(left.sessionId, right.sessionId)
              : right.updatedAt - left.updatedAt,
          )
          .slice(0, limit)
      })
    },

    listMessages(q: TapeListMessagesQuery): Promise<MessageRow[]> {
      return run(() => {
        const limit = assertReadLimit(q.limit)
        const state = sessions.get(q.sessionId)
        if (state === undefined) return []
        const rows = [...state.messages.values()]
          .filter(
            (row) =>
              (q.afterOrderSeq === undefined || row.orderSeq > q.afterOrderSeq) &&
              (q.beforeOrderSeq === undefined || row.orderSeq < q.beforeOrderSeq),
          )
          .toSorted((left, right) => left.orderSeq - right.orderSeq)
        // Forward from a cursor takes the head of the window; with no cursor, or reading backwards,
        // the tail — the interface opens at the end of a conversation.
        const window =
          q.afterOrderSeq === undefined
            ? rows.slice(Math.max(0, rows.length - limit))
            : rows.slice(0, limit)
        return window.map((row) => toMessageRow(q.sessionId, row))
      })
    },

    rebuildProjections(sessionId: string): Promise<void> {
      return run(() => {
        const state = sessions.get(sessionId)
        if (state === undefined) {
          throw new TapeSessionNotFoundError(
            `session "${sessionId}" has no head row under tenant "${tenantId}"`,
          )
        }
        const tx = cloneSession(state)
        rebuildInto(tx, sessionId)
        sessions.set(sessionId, tx)
      })
    },

    resetSession(q: TapeResetSessionQuery): Promise<AppendResult> {
      return run(() => {
        assertTapeId(q.sessionId, 'sessionId')
        assertTapeId(q.incarnationId, 'incarnationId')
        assertEntryAllowed(q.start)
        // A `TypeError` like `assertId`'s: handing a reset something other than the anchor is a
        // programmer error at the call site, not a condition of the tape, and it is not the
        // projection that failed.
        if (q.start.name !== 'session/start') {
          throw new TypeError(
            `resetSession opens an incarnation with session/start, not "${q.start.name}"`,
          )
        }
        const state = sessions.get(q.sessionId)
        if (state === undefined) {
          throw new TapeSessionNotFoundError(
            `session "${q.sessionId}" has no head row under tenant "${tenantId}"; ` +
              'a reset never conjures a session into existence',
          )
        }
        if (state.head.incarnationId === q.incarnationId) {
          throw new TapeStaleIncarnationError(
            `resetSession must carry a NEW incarnationId; ${q.incarnationId} is the current one, ` +
              'and reusing it would make two generations hash-indistinguishable',
          )
        }
        const tx: SessionState = {
          // The high-water mark does NOT decrease: a stale reference must never resolve to a fact
          // from the next incarnation.
          head: {
            incarnationId: q.incarnationId,
            lastEntryId: state.head.lastEntryId,
            lastHash: null,
            entryCount: 0,
            createdAt: state.head.createdAt,
            updatedAt: q.start.createdAt,
          },
          entries: [],
          byKey: new Map(),
          messages: new Map(),
          session: null,
          cursors: new Map(),
        }
        const result = insertEntry(tx, q.sessionId, q.start)
        sessions.set(q.sessionId, tx)
        return result
      })
    },

    deleteSession(sessionId: string): Promise<void> {
      return run(() => {
        // Facts, head, projections and cursors go together; an unknown session changes nothing.
        sessions.delete(sessionId)
      })
    },

    close(): Promise<void> {
      // Nothing to release: the memory store owns no handle. It is deliberately NOT a use-after-close
      // gate either — that would need an eighth error class the port does not define.
      return Promise.resolve()
    },
  }
}

/**
 * Every method is synchronous inside and asynchronous on the port. Wrapping the body means a
 * validation failure REJECTS rather than throwing synchronously — the port promises a promise, and a
 * caller that only has a `.catch()` must not miss a malformed key.
 */
function run<T>(body: () => T): Promise<T> {
  try {
    return Promise.resolve(body())
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Stored text back into a value. The parse is inside the guard on purpose: text that does not parse
 * and text that parses into the wrong shape are the same failure — a stored column cannot be read —
 * and a bare `SyntaxError` out of a plain `readRange` would name no row and belong to no class the
 * port defines. `verifyChain`'s verdict and a read's failure then point at the same entry.
 */
function parseStoredJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new TapeProjectionError(
      `${label}: stored JSON does not parse (${error instanceof Error ? error.message : 'unknown'})`,
    )
  }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const value = parseStoredJson(text, label)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TapeProjectionError(`${label}: stored JSON is not an object`)
  }
  return value as Record<string, unknown>
}

function parseJsonArray<T>(text: string, label: string): T[] {
  const value = parseStoredJson(text, label)
  if (!Array.isArray(value)) {
    throw new TapeProjectionError(`${label}: stored JSON is not an array`)
  }
  return value as T[]
}
