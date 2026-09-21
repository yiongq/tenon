/**
 * The desktop SQLite `TapeStore` (spec 01 §SQLite 实现约束, §DDL, §哈希链, §删除语义).
 *
 * It is the SEMANTIC TWIN of the kernel's memory store, and the shared conformance suite from
 * `@tenon-app/kernel/testing` runs against both unchanged — anything the two answer differently is a
 * bug in one of them. The port's own rules come from the kernel rather than being restated here (the
 * append and batch gates, the idempotency comparison, the incarnation check, the hash recipe and its
 * verification), so what is left in this file is the SQL, the transaction and the file. What is
 * specific to this side is everything the port hides:
 *
 *   - **The binding is pinned.** `better-sqlite3@13.0.3` ships Node-API prebuilds inside the npm
 *     package, so one `pnpm install` serves ABI 127 (vitest's Node 22) and ABI 149 (Electron 44) with
 *     the SAME SQLite 3.53.4 and the same compile options. The version number therefore pins the
 *     ENGINE as well; changing it is a schema-affecting change.
 *   - **One file per profile**, `<profileDir>/sessions.db`, with `tape_meta.tenant_id` written on
 *     creation and checked on every later open. Every statement binds the tenant from the identity the
 *     store was constructed with, so forgetting the predicate is impossible rather than discouraged.
 *   - **The append statement order is fixed** (§SQLite 实现约束; two reviewers each executed a
 *     different order and both broke): ① look the `provenance_key` up FIRST — the idempotent branch
 *     allocates nothing, or every duplicate burns an id and dirties the head; ② `UPDATE session_head
 *     … RETURNING` hands back the new id, the STILL UNCHANGED `prev_hash` and the incarnation under one
 *     lock (a session's first batch creates that row with `INSERT … ON CONFLICT DO NOTHING`, which
 *     carries no `RETURNING`: on conflict `RETURNING` returns nothing at all); ③ `hashEntry`;
 *     ④ `INSERT INTO tape_entry`; ⑤ a second `UPDATE` writes `last_hash` back; ⑥ apply the kernel's
 *     projection ops and advance `projection_cursor`. The new hash is NEVER an input of the allocating
 *     statement — that is a cycle.
 *   - **Every method owns its `ROLLBACK`.** Neither binding rolls back for you, and a trigger `ABORT`
 *     leaves the transaction OPEN (measured: `db.inTransaction` is still true afterwards), so the next
 *     statement would run inside a doomed transaction. `SQLITE_BUSY` becomes `TapeBusyError` and the
 *     store never retries — the unit of retry is the caller's whole `append`.
 *   - **Integers and bytes cross the port safely.** One prepare helper puts `safeIntegers(true)` on
 *     every statement, so each integer arrives as a `bigint`, is asserted inside
 *     `Number.MAX_SAFE_INTEGER` (`TapeIntegerRangeError` otherwise — this is where better-sqlite3
 *     silently truncates) and is converted; every BLOB arrives as a Node `Buffer` and is copied into a
 *     plain `Uint8Array` (invariant 17). `undefined` binds as an explicit `null`, because
 *     better-sqlite3 would bind it to NULL silently while `node:sqlite` throws.
 *   - `payload_json` / `meta_json` are stored as the kernel's `canonicalJson` produced them and
 *     `verifyChain` hashes THAT text, never a re-serialisation — otherwise acceptance 12's flipped
 *     byte would hide behind an intact `content_hash` column.
 *
 * The file is not wired into the app here; `chat.ts` picks it up in step 13.
 */
import type {
  AbsolutePath,
  AppendResult,
  ContentBlock,
  HostIdentity,
  MessageRow,
  MessageStatus,
  NewEntry,
  ProjectionOp,
  ProjectionReducer,
  SessionHead,
  SessionSummary,
  TapeAppendBatch,
  TapeEntry,
  TapeKind,
  TapeListMessagesQuery,
  TapeListSessionsQuery,
  TapeReadBySourceQuery,
  TapeReadRangePage,
  TapeReadRangeQuery,
  TapeResetSessionQuery,
  TapeSourceType,
  TapeStore,
  TapeVerifyChainPage,
  TapeVerifyChainQuery,
} from '@tenon-app/kernel'
import {
  HASH_VER,
  PROJECTION_TABLES,
  PROJECTION_VERSION,
  TapeBusyError,
  TapeIntegerRangeError,
  TapeProjectionError,
  TapeProvenanceConflictError,
  TapeSessionNotFoundError,
  TapeStaleIncarnationError,
  TapeTenantMismatchError,
  assertBatchAllowed,
  assertCurrentIncarnation,
  assertEntryAllowed,
  assertReadKinds,
  assertReadLimit,
  assertTapeId,
  canonicalJson,
  contentHash,
  hashEntry,
  idempotentAppendResult,
  isStoredEntryProvable,
  joinPath,
  project,
} from '@tenon-app/kernel'
import Database from 'better-sqlite3'
import type { Database as SqliteConnection, Statement } from 'better-sqlite3'
import migration001 from './sql/tape.sqlite.sql?raw'

/** One file per profile (spec 01 §SQLite 实现约束; phase 0's layout reserved the name). */
export const SESSIONS_DB_FILE = 'sessions.db'

/** The `busy_timeout` the spec fixes. Tests lower it to make a held write lock fail fast. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000

/**
 * Forward-only, numbered, one transaction each, recorded in the `schema_version` TABLE rather than
 * `PRAGMA user_version` so both dialects take one code path. Migration 1 is the DDL file the spec owns
 * and `scripts/check-tape-schema.mjs` guards; a migration is never edited once shipped.
 */
const MIGRATIONS: readonly { readonly version: number; readonly sql: string }[] = Object.freeze([
  { version: 1, sql: migration001 },
])

/** The newest schema this build can run. A file above it is refused, not migrated backwards. */
export const PROGRAM_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
)

/** Rows are read back in one shape; the order is the DDL's. */
const ENTRY_COLUMNS =
  'entry_id, incarnation_id, kind, name, source_type, source_id, source_seq, provenance_key, ' +
  'payload_json, meta_json, created_at, content_hash, prev_hash, entry_hash, hash_ver'

/**
 * Exported so acceptance 14 can `EXPLAIN QUERY PLAN` the statement the store REALLY runs: the plan
 * must name `tape_entry_by_source` and must not contain `TEMP B-TREE`. Renaming the index, reordering
 * its columns or turning this into a scan then reds that test instead of quietly costing a sort.
 */
export const READ_BY_SOURCE_SQL =
  `SELECT ${ENTRY_COLUMNS} FROM tape_entry ` +
  'WHERE tenant_id = ? AND session_id = ? AND source_type = ? AND source_id = ? ' +
  'ORDER BY entry_id LIMIT ?'

/** Internal page size for the full scans that live behind the port (`rebuildProjections`). */
const SCAN_PAGE = 1000

/**
 * The file was written by a NEWER build. The store refuses to open it and writes nothing: a
 * forward-only migration ladder cannot undo what it does not know, and half-downgrading a user's
 * history is worse than refusing to start. Host-specific, so it is not one of the port's seven errors.
 */
export class TapeSchemaVersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeSchemaVersionError'
  }
}

export interface SqliteTapeStoreOptions {
  /** The store is BOUND to this identity: the tenant is never a method parameter. */
  readonly identity: HostIdentity
  /** Injectable so a test can count applications (acceptance 11). Defaults to the kernel reducer. */
  readonly project?: ProjectionReducer
  /**
   * `busy_timeout` in ms. The spec fixes 5000 for the app; a test that holds the write lock on purpose
   * lowers it so `TapeBusyError` arrives in milliseconds instead of five seconds (acceptance 10).
   */
  readonly busyTimeoutMs?: number
  /**
   * `applied_at` of a migration and `opened_at` of a maintenance gate — the two timestamps that are
   * NOT data on a fact. Everything else takes its time from the entry's own `createdAt`, so the tape
   * never depends on the wall clock. Defaults to `Date.now` (a host concern; the kernel's lint ban on
   * clocks stops at the package boundary).
   */
  readonly now?: () => number
}

/** A value SQLite can bind, or return once normalised. */
type SqlValue = string | number | bigint | Uint8Array | null

/** What a call site may hand the binder. `undefined` is mapped to an explicit `null` there. */
type BindValue = SqlValue | undefined

/** One row after normalisation: bigint → number (range-checked), Buffer → plain Uint8Array. */
type SqlRow = Record<string, SqlValue>

/** A `tape_entry` row as stored, which is what both the reader and the verifier work from. */
interface StoredRow {
  readonly entryId: number
  readonly incarnationId: string
  readonly kind: TapeKind
  readonly name: string
  readonly sourceType: TapeSourceType
  readonly sourceId: string | null
  readonly sourceSeq: number | null
  readonly provenanceKey: string
  /** The stored TEXT. Hashing and verification use this, never a fresh serialisation. */
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

export function createSqliteTapeStore(options: SqliteTapeStoreOptions): TapeStore {
  const tenantId = options.identity.tenantId
  if (tenantId.length === 0) throw new TypeError('identity.tenantId must not be empty')
  const reduce: ProjectionReducer = options.project ?? project
  const now = options.now ?? Date.now
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  // It goes into a PRAGMA, which takes no parameters, so it is validated rather than interpolated
  // blindly.
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError(`busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`)
  }
  const file = joinPath(options.identity.profileDir as AbsolutePath, SESSIONS_DB_FILE)

  // ---------------------------------------------------------------------------------------------
  // Open: refuse a newer file without touching it, then the PRAGMAs, the tenant, the ladder
  // ---------------------------------------------------------------------------------------------

  // 「拒绝打开且不写任何东西」 is checked BEFORE the file is opened for writing at all, because two of
  // the three on-disk states are written to by merely opening one: `PRAGMA journal_mode = WAL`
  // rewrites page 1's header on a file that is not already in WAL mode (one restored from
  // `VACUUM INTO` or `.backup` is in delete mode), and closing the last read-write connection of a
  // WAL database CHECKPOINTS it, folding a hot `-wal` left by a crash into the main file. A read-only
  // connection does neither (measured: main file unchanged, `-wal` still present after its close).
  refuseNewerFile(file)

  const db = new Database(file)
  const statements = statementsFor(db, file)
  const { prepare, execute } = statements

  try {
    // Fixed order (§SQLite 实现约束). `cache_size` is explicit because the two bindings' defaults
    // differ eightfold, and `synchronous = NORMAL` means a power cut can lose the last few committed
    // transactions: the tape's durability rests on the chain plus replay, not on fsync per write.
    // The first pragma can itself meet a locked file; better-sqlite3 arms its own 5000 ms busy timeout
    // in the constructor (lib/database.js), so the open sequence is never unprotected while the
    // configured `busy_timeout` is still two statements away.
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma(`busy_timeout = ${busyTimeoutMs}`)
    db.pragma('foreign_keys = ON')
    db.pragma('cache_size = -16000')
    // The authoritative re-check: another process may have migrated the file between the read-only
    // probe above and this connection.
    const current = readSchemaVersion(statements)
    refuseIfNewer(file, current)
    // `tape_meta` exists from migration 1 on, and the tenant is compared BEFORE any migration runs:
    // upgrading a file that belongs to someone else and only then refusing it would leave the
    // rightful owner's older build refusing its own history with TapeSchemaVersionError.
    if (current >= 1) assertFileTenant()
    migrate(current)
    bindTenant()
  } catch (error) {
    // A refused file must not leave a handle (and its -wal / -shm companions) behind.
    db.close()
    throw error
  }

  function migrate(currentBeforeLadder: number): void {
    for (const migration of MIGRATIONS) {
      if (migration.version <= currentBeforeLadder) continue
      // One transaction per migration, and the version is re-read INSIDE it: two processes opening
      // one fresh file both read version 0 outside, and the loser has to converge rather than fail on
      // `table schema_version already exists` (phase 0's single-instance lock is a placeholder, so two
      // instances can share one profile directory).
      transact(() => {
        if (readSchemaVersion(statements) >= migration.version) return
        execute(migration.sql)
        prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run([
          migration.version,
          now(),
        ])
      })
    }
  }

  /**
   * The tenant row is the one write outside an append, and it goes through `transact` like every
   * other write (§SQLite 实现约束: 「每次写都是 `BEGIN IMMEDIATE … COMMIT`」). That also puts it inside
   * the `SQLITE_BUSY` → `TapeBusyError` mapping and serialises two stores racing to create it.
   */
  function bindTenant(): void {
    transact(() => {
      const row = prepare('SELECT tenant_id FROM tape_meta WHERE id = 1').get()
      if (row === undefined) {
        prepare('INSERT INTO tape_meta (id, tenant_id) VALUES (1, ?)').run([tenantId])
        return
      }
      assertTenant(readText(row, 'tenant_id'))
    })
  }

  /** The read-only half, run before the ladder. An absent row is the crash window migration 1 leaves. */
  function assertFileTenant(): void {
    const row = prepare('SELECT tenant_id FROM tape_meta WHERE id = 1').get()
    if (row === undefined) return
    assertTenant(readText(row, 'tenant_id'))
  }

  function assertTenant(owner: string): void {
    if (owner !== tenantId) {
      throw new TapeTenantMismatchError(
        `${file} belongs to tenant "${owner}", but this store is bound to "${tenantId}"`,
      )
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Transactions — every method owns its ROLLBACK
  // ---------------------------------------------------------------------------------------------

  /**
   * `BEGIN IMMEDIATE`, not a deferred `BEGIN`: `busy_timeout` applies to lock contention between
   * IMMEDIATE transactions, while a deferred transaction whose snapshot goes stale fails with
   * `SQLITE_BUSY_SNAPSHOT` after 0 ms however long the timeout is.
   */
  function transact<T>(body: () => T): T {
    try {
      execute('BEGIN IMMEDIATE')
    } catch (error) {
      // Nothing was opened, so there is nothing to roll back.
      throw mapSqliteError(error)
    }
    let result: T
    try {
      result = body()
      execute('COMMIT')
    } catch (error) {
      rollback()
      throw mapSqliteError(error)
    }
    return result
  }

  function rollback(): void {
    // Guarded because a failed COMMIT may already have ended the transaction, while a trigger ABORT
    // leaves it open. A ROLLBACK that itself fails is swallowed: the caller's answer is the original
    // failure, and a connection too broken to roll back reports itself on the next statement.
    if (!db.inTransaction) return
    try {
      execute('ROLLBACK')
    } catch {
      /* the original error is the one worth raising */
    }
  }

  /**
   * The one error translation. A write lock held past `busy_timeout` is `TapeBusyError` and the store
   * never retries: the kernel counts physical attempts, so retrying behind its back would lose count.
   */
  function mapSqliteError(error: unknown): unknown {
    if (error instanceof Database.SqliteError && error.code.startsWith('SQLITE_BUSY')) {
      return new TapeBusyError(
        `${file}: the write lock was still held after ${busyTimeoutMs} ms (${error.code}); ` +
          "retrying the whole append is the caller's job",
      )
    }
    return error
  }

  // ---------------------------------------------------------------------------------------------
  // Row mapping
  // ---------------------------------------------------------------------------------------------

  function toStoredRow(row: SqlRow): StoredRow {
    const sourceId = row['source_id']
    const sourceSeq = row['source_seq']
    const prevHash = row['prev_hash']
    return {
      entryId: readInt(row, 'entry_id'),
      incarnationId: readText(row, 'incarnation_id'),
      kind: readText(row, 'kind') as TapeKind,
      name: readText(row, 'name'),
      sourceType: readText(row, 'source_type') as TapeSourceType,
      sourceId: sourceId === null ? null : readText(row, 'source_id'),
      sourceSeq: sourceSeq === null ? null : readInt(row, 'source_seq'),
      provenanceKey: readText(row, 'provenance_key'),
      payloadJson: readText(row, 'payload_json'),
      metaJson: readText(row, 'meta_json'),
      createdAt: readInt(row, 'created_at'),
      contentHash: readBytes(row, 'content_hash'),
      prevHash: prevHash === null ? null : readBytes(row, 'prev_hash'),
      entryHash: readBytes(row, 'entry_hash'),
      hashVer: readInt(row, 'hash_ver'),
    }
  }

  function toTapeEntry(sessionId: string, stored: StoredRow): TapeEntry {
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
      // Parsed from the stored text on every read, as the memory store does, so that `append` and
      // `rebuildProjections` hand the reducer exactly the same value.
      payload: parseJsonObject(stored.payloadJson, `${stored.name}.payload`),
      meta: parseJsonObject(stored.metaJson, `${stored.name}.meta`),
      createdAt: stored.createdAt,
      contentHash: stored.contentHash,
      prevHash: stored.prevHash,
      entryHash: stored.entryHash,
      hashVer: stored.hashVer,
    }
  }

  function toHeadRow(row: SqlRow): HeadRow {
    const lastHash = row['last_hash']
    return {
      incarnationId: readText(row, 'incarnation_id'),
      lastEntryId: readInt(row, 'last_entry_id'),
      lastHash: lastHash === null ? null : readBytes(row, 'last_hash'),
      entryCount: readInt(row, 'entry_count'),
      createdAt: readInt(row, 'created_at'),
      updatedAt: readInt(row, 'updated_at'),
    }
  }

  function selectHead(sessionId: string): HeadRow | undefined {
    const row = prepare(
      'SELECT incarnation_id, last_entry_id, last_hash, entry_count, created_at, updated_at ' +
        'FROM session_head WHERE tenant_id = ? AND session_id = ?',
    ).get([tenantId, sessionId])
    return row === undefined ? undefined : toHeadRow(row)
  }

  // ---------------------------------------------------------------------------------------------
  // Append (steps ①–⑥)
  // ---------------------------------------------------------------------------------------------

  function lookupByKey(sessionId: string, provenanceKey: string): StoredRow | undefined {
    const row = prepare(
      `SELECT ${ENTRY_COLUMNS} FROM tape_entry ` +
        'WHERE tenant_id = ? AND session_id = ? AND provenance_key = ?',
    ).get([tenantId, sessionId, provenanceKey])
    return row === undefined ? undefined : toStoredRow(row)
  }

  /** Steps ②–⑥ for one fact, inside the caller's transaction. */
  function insertEntry(sessionId: string, entry: NewEntry): AppendResult {
    // ② The new id, the UNCHANGED prev hash and the incarnation, under one lock.
    const allocated = prepare(
      'UPDATE session_head SET last_entry_id = last_entry_id + 1, entry_count = entry_count + 1, ' +
        'updated_at = ? WHERE tenant_id = ? AND session_id = ? ' +
        'RETURNING last_entry_id, last_hash, incarnation_id',
    ).get([entry.createdAt, tenantId, sessionId])
    if (allocated === undefined) {
      throw new TapeSessionNotFoundError(
        `session "${sessionId}" has no head row under tenant "${tenantId}"`,
      )
    }
    const entryId = readInt(allocated, 'last_entry_id')
    const lastHash = allocated['last_hash']
    const prevHash = lastHash === null ? null : readBytes(allocated, 'last_hash')
    const incarnationId = readText(allocated, 'incarnation_id')

    const payloadJson = canonicalJson(entry.payload)
    const metaJson = canonicalJson(entry.meta ?? {})
    const sourceId = entry.sourceId ?? null
    const sourceSeq = entry.sourceSeq ?? null
    // ③ The kernel's recipe, called here because only here are entry_id and prev_hash known.
    const digest = contentHash(payloadJson, metaJson)
    const entryHash = hashEntry({
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
    })

    // ④ The insert. `ON CONFLICT DO NOTHING` is only the backstop the spec asks for — the lookup in ①
    // is what decides idempotency — so a conflict here means the unique key disagrees with the lookup
    // inside one transaction, which is corruption rather than a retry.
    //
    // WHY 0 rows can only be corruption: the `BEGIN IMMEDIATE` around this whole sequence, not the
    // statement. SQLite's write lock is the whole file, so no other writer can insert this key
    // between ① and here. A Postgres twin has no such lock — two READ COMMITTED backends appending the
    // same `provenanceKey` both miss ①, and the loser's insert legitimately affects 0 rows — so that
    // store must re-run the lookup here and answer `created: false`, and this file says so rather
    // than letting 6b inherit an assumption it cannot keep.
    const inserted = prepare(
      'INSERT INTO tape_entry (tenant_id, session_id, entry_id, incarnation_id, kind, name, ' +
        'source_type, source_id, source_seq, provenance_key, payload_json, meta_json, created_at, ' +
        'content_hash, prev_hash, entry_hash, hash_ver) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (tenant_id, session_id, provenance_key) DO NOTHING',
    ).run([
      tenantId,
      sessionId,
      entryId,
      incarnationId,
      entry.kind,
      entry.name,
      entry.sourceType,
      sourceId,
      sourceSeq,
      entry.provenanceKey,
      payloadJson,
      metaJson,
      entry.createdAt,
      digest,
      prevHash,
      entryHash,
      HASH_VER,
    ])
    if (inserted !== 1) {
      throw new TapeProvenanceConflictError(
        `provenanceKey "${entry.provenanceKey}" hit the unique index although the lookup missed it; ` +
          'the file disagrees with itself',
      )
    }
    // ⑤ Write the chain head back. Never an input of ② — that would be a cycle.
    prepare('UPDATE session_head SET last_hash = ? WHERE tenant_id = ? AND session_id = ?').run([
      entryHash,
      tenantId,
      sessionId,
    ])

    // ⑥ The kernel's ops, then the cursor.
    const stored: StoredRow = {
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
      entryHash,
      hashVer: HASH_VER,
    }
    applyOps(sessionId, reduce(toTapeEntry(sessionId, stored)))
    advanceCursors(sessionId, incarnationId, entryId, entry.createdAt)
    return { entryId, entryHash, created: true }
  }

  // ---------------------------------------------------------------------------------------------
  // Projections (kernel owns the reducer, this store owns the transaction)
  // ---------------------------------------------------------------------------------------------

  function applyOps(sessionId: string, ops: readonly ProjectionOp[]): void {
    for (const op of ops) {
      if (op.key.sessionId !== sessionId) {
        throw new TapeProjectionError(
          `a projection op for session "${op.key.sessionId}" cannot be applied while appending ` +
            `to "${sessionId}"`,
        )
      }
      if (op.table === 'message') applyMessageOp(sessionId, op)
      else applySessionOp(sessionId, op)
    }
  }

  function applyMessageOp(
    sessionId: string,
    op: Extract<ProjectionOp, { table: 'message' }>,
  ): void {
    if (op.op === 'delete') {
      prepare(
        'DELETE FROM message_projection WHERE tenant_id = ? AND session_id = ? AND message_id = ?',
      ).run([tenantId, sessionId, op.key.messageId])
      return
    }
    if (op.insertOnly === undefined) {
      // No insertOnly means the op can only update: `order_seq` and `created_at` are NOT NULL and the
      // reducer is blind, so there is nothing to insert with.
      const changed = prepare(
        'UPDATE message_projection SET role = ?, status = ?, content_json = ?, entry_id = ?, ' +
          'updated_at = ? WHERE tenant_id = ? AND session_id = ? AND message_id = ?',
      ).run([
        op.values.role,
        op.values.status,
        op.values.contentJson,
        op.values.entryId,
        op.values.updatedAt,
        tenantId,
        sessionId,
        op.key.messageId,
      ])
      if (changed === 0) {
        throw new TapeProjectionError(
          `inserting message_projection "${op.key.messageId}" needs insertOnly ` +
            '(order_seq and created_at are NOT NULL)',
        )
      }
      return
    }
    // `order_seq` and `created_at` are in VALUES but not in DO UPDATE: that is what insertOnly means,
    // and it is why a revision never moves a message in the interface.
    prepare(
      'INSERT INTO message_projection (tenant_id, session_id, message_id, order_seq, role, status, ' +
        'content_json, entry_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (tenant_id, session_id, message_id) DO UPDATE SET role = excluded.role, ' +
        'status = excluded.status, content_json = excluded.content_json, ' +
        'entry_id = excluded.entry_id, updated_at = excluded.updated_at',
    ).run([
      tenantId,
      sessionId,
      op.key.messageId,
      op.insertOnly.orderSeq,
      op.values.role,
      op.values.status,
      op.values.contentJson,
      op.values.entryId,
      op.insertOnly.createdAt,
      op.values.updatedAt,
    ])
  }

  function applySessionOp(
    sessionId: string,
    op: Extract<ProjectionOp, { table: 'session' }>,
  ): void {
    if (op.op === 'delete') {
      prepare('DELETE FROM session_projection WHERE tenant_id = ? AND session_id = ?').run([
        tenantId,
        sessionId,
      ])
      return
    }
    // An absent value means "do not touch that column", which is what COALESCE(excluded.x, x) says —
    // the SQL twin of the memory store's `op.values.x ?? existing.x`.
    const providerId = op.values.providerId ?? null
    const modelId = op.values.modelId ?? null
    const lastMessageAt = op.values.lastMessageAt ?? null
    if (op.insertOnly === undefined) {
      const changed = prepare(
        'UPDATE session_projection SET provider_id = COALESCE(?, provider_id), ' +
          'model_id = COALESCE(?, model_id), last_message_at = COALESCE(?, last_message_at), ' +
          'updated_at = ? WHERE tenant_id = ? AND session_id = ?',
      ).run([providerId, modelId, lastMessageAt, op.values.updatedAt, tenantId, sessionId])
      if (changed === 0) {
        throw new TapeProjectionError(
          `inserting session_projection "${sessionId}" needs insertOnly (created_at is NOT NULL)`,
        )
      }
      return
    }
    prepare(
      'INSERT INTO session_projection (tenant_id, session_id, title, provider_id, model_id, ' +
        'last_message_at, forked_from_session_id, created_at, updated_at) ' +
        'VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (tenant_id, session_id) DO UPDATE SET ' +
        'provider_id = COALESCE(excluded.provider_id, provider_id), ' +
        'model_id = COALESCE(excluded.model_id, model_id), ' +
        'last_message_at = COALESCE(excluded.last_message_at, last_message_at), ' +
        'updated_at = excluded.updated_at',
    ).run([
      tenantId,
      sessionId,
      providerId,
      modelId,
      lastMessageAt,
      op.insertOnly.forkedFromSessionId ?? null,
      op.insertOnly.createdAt,
      op.values.updatedAt,
    ])
  }

  /**
   * The cursor records what a projection has CONSUMED, not what it wrote, so it advances for every
   * inserted fact — including the ones that project to nothing.
   */
  function advanceCursors(
    sessionId: string,
    incarnationId: string,
    entryId: number,
    updatedAt: number,
  ): void {
    for (const table of PROJECTION_TABLES) {
      prepare(
        'INSERT INTO projection_cursor (tenant_id, session_id, projection, incarnation_id, ' +
          'last_entry_id, projection_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT (tenant_id, session_id, projection) DO UPDATE SET ' +
          'incarnation_id = excluded.incarnation_id, last_entry_id = excluded.last_entry_id, ' +
          'projection_version = excluded.projection_version, updated_at = excluded.updated_at',
      ).run([tenantId, sessionId, table, incarnationId, entryId, PROJECTION_VERSION, updatedAt])
    }
  }

  function clearProjections(sessionId: string): void {
    // No gate and no trigger here: both projection tables are derivable from `tape_entry` at any time
    // (§投影与重放), which is exactly why they carry no append-only trigger.
    for (const table of ['message_projection', 'session_projection', 'projection_cursor']) {
      prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND session_id = ?`).run([
        tenantId,
        sessionId,
      ])
    }
  }

  /** Walks the facts in id order, in pages, so a huge session does not materialise at once. */
  function replayInto(sessionId: string, incarnationId: string): void {
    let fromEntryId = 0
    for (;;) {
      const rows = prepare(
        `SELECT ${ENTRY_COLUMNS} FROM tape_entry WHERE tenant_id = ? AND session_id = ? ` +
          'AND entry_id >= ? ORDER BY entry_id LIMIT ?',
      ).all([tenantId, sessionId, fromEntryId, SCAN_PAGE])
      for (const row of rows) {
        const stored = toStoredRow(row)
        applyOps(sessionId, reduce(toTapeEntry(sessionId, stored)))
        advanceCursors(sessionId, incarnationId, stored.entryId, stored.createdAt)
        fromEntryId = stored.entryId + 1
      }
      if (rows.length < SCAN_PAGE) return
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The two physical lifecycle paths, both through the per-session maintenance gate
  // ---------------------------------------------------------------------------------------------

  /**
   * `BEFORE DELETE` on `tape_entry` aborts unless THIS session has an open gate row, so the gate is
   * opened and closed inside the same transaction as the delete. A gate for session A cannot delete
   * B's rows (invariant 9), and because it lives and dies inside one transaction a crash cannot leave
   * one standing.
   */
  function withGate(sessionId: string, mode: 'reset' | 'delete', body: () => void): void {
    prepare(
      'INSERT INTO tape_maintenance (tenant_id, session_id, mode, opened_at) VALUES (?, ?, ?, ?)',
    ).run([tenantId, sessionId, mode, now()])
    body()
    prepare('DELETE FROM tape_maintenance WHERE tenant_id = ? AND session_id = ?').run([
      tenantId,
      sessionId,
    ])
  }

  // ---------------------------------------------------------------------------------------------
  // The port
  // ---------------------------------------------------------------------------------------------

  return {
    append(batch: TapeAppendBatch): Promise<AppendResult[]> {
      return promised(() => {
        assertTapeId(batch.sessionId, 'sessionId')
        assertTapeId(batch.incarnationId, 'incarnationId')
        assertBatchAllowed(batch.entries)
        const first = batch.entries[0]
        if (first === undefined) {
          // An EMPTY batch still answers the stale-incarnation question, because the memory store does
          // (its check sits above its own early return) and the two are semantic twins: one store
          // rejecting what the other accepts is observable, since §删除语义 routes incognito sessions
          // to the memory store and normal ones here. Read-only and outside a transaction — the
          // in-transaction check below stays the authoritative one.
          const existing = selectHead(batch.sessionId)
          if (existing !== undefined) {
            assertCurrentIncarnation(batch.sessionId, existing, batch.incarnationId)
          }
          return []
        }
        return transact(() => {
          // No head row yet ⇒ create it with the incarnation the kernel minted. No RETURNING on this
          // statement: on conflict it would return no row at all.
          prepare(
            'INSERT INTO session_head (tenant_id, session_id, incarnation_id, last_entry_id, ' +
              'last_hash, entry_count, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, 0, ?, ?) ' +
              'ON CONFLICT (tenant_id, session_id) DO NOTHING',
          ).run([tenantId, batch.sessionId, batch.incarnationId, first.createdAt, first.createdAt])
          const head = selectHead(batch.sessionId)
          if (head === undefined) {
            throw new TapeSessionNotFoundError(
              `session "${batch.sessionId}" has no head row under tenant "${tenantId}"`,
            )
          }
          if (head.incarnationId !== batch.incarnationId) {
            throw new TapeStaleIncarnationError(
              `session "${batch.sessionId}" is at incarnation ${head.incarnationId}, ` +
                `not ${batch.incarnationId}`,
            )
          }
          const results: AppendResult[] = []
          for (const entry of batch.entries) {
            // ① The lookup comes first and the idempotent branch allocates nothing.
            const hit = lookupByKey(batch.sessionId, entry.provenanceKey)
            results.push(
              hit === undefined
                ? insertEntry(batch.sessionId, entry)
                : idempotentAppendResult(hit, entry),
            )
          }
          return results
        })
      })
    },

    readRange(q: TapeReadRangeQuery): Promise<TapeReadRangePage> {
      return promised(() => {
        const limit = assertReadLimit(q.limit)
        assertReadKinds(q.kinds)
        const head = selectHead(q.sessionId)
        // An unknown session reads as empty rather than throwing: a store cannot tell "another
        // tenant's session" from "never existed", and acceptance 4 needs the first to look absent.
        if (head === undefined) return { entries: [], incarnationId: '', nextFromEntryId: null }
        assertCurrentIncarnation(q.sessionId, head, q.incarnationId)
        const params: SqlValue[] = [tenantId, q.sessionId]
        let where = 'tenant_id = ? AND session_id = ?'
        if (q.fromEntryId !== undefined) {
          where += ' AND entry_id >= ?'
          params.push(q.fromEntryId)
        }
        if (q.atEntryId !== undefined) {
          where += ' AND entry_id <= ?'
          params.push(q.atEntryId)
        }
        if (q.kinds !== undefined) {
          // A single kind goes through `tape_entry_by_kind`; several scan the primary key
          // (§存储端口). `kinds: []` never reaches here — the port refuses it.
          where +=
            q.kinds.length === 1
              ? ' AND kind = ?'
              : ` AND kind IN (${q.kinds.map(() => '?').join(', ')})`
          params.push(...q.kinds)
        }
        params.push(limit)
        const rows = prepare(
          `SELECT ${ENTRY_COLUMNS} FROM tape_entry WHERE ${where} ORDER BY entry_id LIMIT ?`,
        ).all(params)
        const entries = rows.map((row) => toTapeEntry(q.sessionId, toStoredRow(row)))
        const last = entries.at(-1)
        return {
          entries,
          incarnationId: head.incarnationId,
          // A full page means "there may be more"; a short page is the end. Guessing otherwise would
          // take a second query, at the price of one empty last page on an exact multiple.
          nextFromEntryId: last !== undefined && entries.length === limit ? last.entryId + 1 : null,
        }
      })
    },

    readBySource(q: TapeReadBySourceQuery): Promise<TapeEntry[]> {
      return promised(() => {
        const limit = assertReadLimit(q.limit)
        const rows = prepare(READ_BY_SOURCE_SQL).all([
          tenantId,
          q.sessionId,
          q.sourceType,
          q.sourceId,
          limit,
        ])
        return rows.map((row) => toTapeEntry(q.sessionId, toStoredRow(row)))
      })
    },

    head(sessionId: string): Promise<SessionHead | null> {
      return promised(() => {
        const head = selectHead(sessionId)
        if (head === undefined) return null
        return { tenantId, sessionId, ...head }
      })
    },

    verifyChain(q: TapeVerifyChainQuery): Promise<TapeVerifyChainPage> {
      return promised(() => {
        const limit = assertReadLimit(q.limit)
        const head = selectHead(q.sessionId)
        if (head === undefined) {
          return { incarnationId: '', checked: 0, firstBadEntryId: null, nextFromEntryId: null }
        }
        assertCurrentIncarnation(q.sessionId, head, q.incarnationId)
        const fromEntryId = q.fromEntryId ?? 0
        // The link INTO the page: the row immediately below the cursor, so a paged verification checks
        // the same links a single-page one would. Its absence means the page opens the chain.
        const before = prepare(
          'SELECT entry_hash FROM tape_entry WHERE tenant_id = ? AND session_id = ? ' +
            'AND entry_id < ? ORDER BY entry_id DESC LIMIT 1',
        ).get([tenantId, q.sessionId, fromEntryId])
        let previous: Uint8Array | null =
          before === undefined ? null : readBytes(before, 'entry_hash')
        const rows = prepare(
          `SELECT ${ENTRY_COLUMNS} FROM tape_entry WHERE tenant_id = ? AND session_id = ? ` +
            'AND entry_id >= ? ORDER BY entry_id LIMIT ?',
        ).all([tenantId, q.sessionId, fromEntryId, limit])
        let checked = 0
        let firstBadEntryId: number | null = null
        let lastExamined: number | null = null
        for (const row of rows) {
          const stored = toStoredRow(row)
          checked += 1
          lastExamined = stored.entryId
          // The kernel's predicate, not a local re-implementation: recipe and verification are one
          // module, so the two stores cannot drift into checking different things.
          const provable = isStoredEntryProvable(
            { ...stored, tenantId, sessionId: q.sessionId },
            previous,
          )
          if (!provable) {
            firstBadEntryId = stored.entryId
            break
          }
          previous = stored.entryHash
        }
        return {
          incarnationId: head.incarnationId,
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
      return promised(() => {
        const limit = assertReadLimit(q.limit)
        const params: SqlValue[] = [tenantId]
        let where = 'tenant_id = ?'
        if (q.updatedBefore !== undefined) {
          where += ' AND updated_at < ?'
          params.push(q.updatedBefore)
        }
        params.push(limit)
        // Newest first, with the session id as the tie-break so the order is total.
        const rows = prepare(
          'SELECT session_id, title, provider_id, model_id, last_message_at, ' +
            'forked_from_session_id, created_at, updated_at FROM session_projection ' +
            `WHERE ${where} ORDER BY updated_at DESC, session_id ASC LIMIT ?`,
        ).all(params)
        return rows.map((row) => ({
          sessionId: readText(row, 'session_id'),
          title: readNullableText(row, 'title'),
          providerId: readNullableText(row, 'provider_id'),
          modelId: readNullableText(row, 'model_id'),
          lastMessageAt: readNullableInt(row, 'last_message_at'),
          forkedFromSessionId: readNullableText(row, 'forked_from_session_id'),
          createdAt: readInt(row, 'created_at'),
          updatedAt: readInt(row, 'updated_at'),
        }))
      })
    },

    listMessages(q: TapeListMessagesQuery): Promise<MessageRow[]> {
      return promised(() => {
        const limit = assertReadLimit(q.limit)
        const params: SqlValue[] = [tenantId, q.sessionId]
        let where = 'tenant_id = ? AND session_id = ?'
        if (q.afterOrderSeq !== undefined) {
          where += ' AND order_seq > ?'
          params.push(q.afterOrderSeq)
        }
        if (q.beforeOrderSeq !== undefined) {
          where += ' AND order_seq < ?'
          params.push(q.beforeOrderSeq)
        }
        params.push(limit)
        // Forward from a cursor takes the head of the window; with no cursor, or reading backwards,
        // the tail — the interface opens at the end of a conversation. Both directions ride
        // `message_projection_by_order`; the descending page is reversed here.
        const descending = q.afterOrderSeq === undefined
        const rows = prepare(
          'SELECT message_id, order_seq, role, status, content_json, entry_id, created_at, ' +
            `updated_at FROM message_projection WHERE ${where} ` +
            `ORDER BY order_seq ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
        ).all(params)
        if (descending) rows.reverse()
        return rows.map((row) => ({
          sessionId: q.sessionId,
          messageId: readText(row, 'message_id'),
          orderSeq: readInt(row, 'order_seq'),
          role: readText(row, 'role') as 'user' | 'assistant',
          status: readText(row, 'status') as MessageStatus,
          content: parseJsonArray<ContentBlock>(
            readText(row, 'content_json'),
            'message_projection.content_json',
          ),
          entryId: readInt(row, 'entry_id'),
          createdAt: readInt(row, 'created_at'),
          updatedAt: readInt(row, 'updated_at'),
        }))
      })
    },

    rebuildProjections(sessionId: string): Promise<void> {
      return promised(() => {
        transact(() => {
          const head = selectHead(sessionId)
          if (head === undefined) {
            throw new TapeSessionNotFoundError(
              `session "${sessionId}" has no head row under tenant "${tenantId}"`,
            )
          }
          clearProjections(sessionId)
          replayInto(sessionId, head.incarnationId)
        })
      })
    },

    resetSession(q: TapeResetSessionQuery): Promise<AppendResult> {
      return promised(() => {
        assertTapeId(q.sessionId, 'sessionId')
        assertTapeId(q.incarnationId, 'incarnationId')
        assertEntryAllowed(q.start)
        // A `TypeError` like `assertId`'s: handing a reset something other than the anchor is a
        // programmer error at the call site, not a condition of the tape.
        if (q.start.name !== 'session/start') {
          throw new TypeError(
            `resetSession opens an incarnation with session/start, not "${q.start.name}"`,
          )
        }
        return transact(() => {
          const head = selectHead(q.sessionId)
          if (head === undefined) {
            throw new TapeSessionNotFoundError(
              `session "${q.sessionId}" has no head row under tenant "${tenantId}"; ` +
                'a reset never conjures a session into existence',
            )
          }
          if (head.incarnationId === q.incarnationId) {
            throw new TapeStaleIncarnationError(
              `resetSession must carry a NEW incarnationId; ${q.incarnationId} is the current one, ` +
                'and reusing it would make two generations hash-indistinguishable',
            )
          }
          withGate(q.sessionId, 'reset', () => {
            prepare('DELETE FROM tape_entry WHERE tenant_id = ? AND session_id = ?').run([
              tenantId,
              q.sessionId,
            ])
          })
          clearProjections(q.sessionId)
          // The high-water mark does NOT decrease: a stale reference must never resolve to a fact
          // from the next incarnation. `created_at` stays; the chain restarts at NULL.
          prepare(
            'UPDATE session_head SET incarnation_id = ?, last_hash = NULL, entry_count = 0, ' +
              'updated_at = ? WHERE tenant_id = ? AND session_id = ?',
          ).run([q.incarnationId, q.start.createdAt, tenantId, q.sessionId])
          return insertEntry(q.sessionId, q.start)
        })
      })
    },

    deleteSession(sessionId: string): Promise<void> {
      return promised(() => {
        transact(() => {
          // An unknown session changes nothing and does not throw — and under acceptance 4 another
          // tenant's session IS an unknown session, so this must not so much as open a gate.
          if (selectHead(sessionId) === undefined) return
          withGate(sessionId, 'delete', () => {
            prepare('DELETE FROM tape_entry WHERE tenant_id = ? AND session_id = ?').run([
              tenantId,
              sessionId,
            ])
          })
          clearProjections(sessionId)
          prepare('DELETE FROM session_head WHERE tenant_id = ? AND session_id = ?').run([
            tenantId,
            sessionId,
          ])
        })
      })
    },

    close(): Promise<void> {
      return promised(() => {
        // Idempotent: the conformance runner closes every store it opened, including after a failure.
        // Every method after this rejects with the `TypeError` the prepare helper raises; the port
        // says nothing about use after close, so this is a programmer error, not an eighth error class.
        if (db.open) db.close()
      })
    },
  }
}

// -------------------------------------------------------------------------------------------------
// Module-level helpers: binding, normalisation, column readers
// -------------------------------------------------------------------------------------------------

/** What every statement in this file goes through. One helper, two connections. */
interface Statements {
  prepare(sql: string): {
    get(params?: readonly BindValue[]): SqlRow | undefined
    all(params?: readonly BindValue[]): SqlRow[]
    run(params?: readonly BindValue[]): number
  }
  execute(sql: string): void
}

/**
 * The ONE prepare helper (§SQLite 实现约束: `safeIntegers`, Buffer → Uint8Array, `undefined` → null),
 * parameterised by the connection so the read-only version probe runs through it too rather than
 * growing a second, unchecked way to read a row.
 *
 * It is also the single place a closed connection is caught. Reaching a store after `close()` is a
 * caller bug, so it is the same `TypeError` an empty id gets — never the binding's own
 * `TypeError: The database connection is not open`, which would leak better-sqlite3's wording through
 * the port. (The memory store keeps serving after `close()`; the port defines neither, and the
 * divergence is reported rather than papered over with an eighth error class.)
 */
function statementsFor(db: SqliteConnection, file: string): Statements {
  const statements = new Map<string, Statement<SqlValue[], unknown>>()
  function assertOpen(): void {
    if (!db.open) throw new TypeError(`${file}: this store is closed`)
  }
  return {
    prepare(sql: string) {
      assertOpen()
      let statement = statements.get(sql)
      if (statement === undefined) {
        // safeIntegers on EVERY statement, not only the ones that read an id today: a statement that
        // starts returning a counter later must not be able to skip the range check by omission.
        statement = db.prepare(sql).safeIntegers(true)
        statements.set(sql, statement)
      }
      const stmt = statement
      return {
        get(params = []): SqlRow | undefined {
          const row = stmt.get(...bind(params))
          return row === undefined ? undefined : normaliseRow(row, sql)
        },
        all(params = []): SqlRow[] {
          return stmt.all(...bind(params)).map((row) => normaliseRow(row, sql))
        },
        run(params = []): number {
          // `changes` is a plain number even under safeIntegers; `lastInsertRowid` is a bigint and is
          // deliberately never read — ids come from the head's high-water mark, never from the rowid.
          return stmt.run(...bind(params)).changes
        },
      }
    },
    execute(sql: string): void {
      assertOpen()
      db.exec(sql)
    },
  }
}

/**
 * The refusal that must not write: a short-lived READ-ONLY connection reads `schema_version` and the
 * store gives up before anything opens the file for writing. A missing file (or one this build cannot
 * open read-only at all) is left to the read-write path below, where the ladder starts at version 0.
 */
function refuseNewerFile(file: string): void {
  let probe: SqliteConnection
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true })
  } catch {
    return
  }
  try {
    refuseIfNewer(file, readSchemaVersion(statementsFor(probe, file)))
  } catch (error) {
    // The probe may only ever REFUSE. Anything else it runs into — a locked file, a header it cannot
    // read — is left to the read-write open, which reports it exactly as it did before this check
    // existed: a purely additive step cannot introduce a failure mode of its own.
    if (error instanceof TapeSchemaVersionError) throw error
  } finally {
    probe.close()
  }
}

/**
 * The ladder's current version on any connection, 0 when the table is not there yet. An empty table
 * means "created but nothing applied", which is version 0 rather than a corrupt file.
 *
 * `sqlite_master` is the ONE dialect-specific statement in the ladder, named here so it has somewhere
 * to be registered: it does not exist on Postgres, where 6b's twin asks `information_schema.tables`
 * (or reads version 0 out of the missing-relation error inside a savepoint). Everything else about the
 * ladder — the `schema_version` TABLE, numbered and forward-only, one transaction each — is one code
 * path for both dialects. `BEGIN IMMEDIATE` in `transact` is the other divergence the spec mandates
 * here and the dialect table does not list yet; both are reported, not smuggled.
 */
function readSchemaVersion(statements: Statements): number {
  const table = statements
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(['schema_version'])
  if (table === undefined) return 0
  const row = statements.prepare('SELECT MAX(version) AS version FROM schema_version').get()
  const version = row?.['version']
  return typeof version === 'number' ? version : 0
}

/** A file above this build's ladder is refused, wherever the version was read from. */
function refuseIfNewer(file: string, version: number): void {
  if (version > PROGRAM_SCHEMA_VERSION) {
    throw new TapeSchemaVersionError(
      `${file} is at schema version ${version}; this build implements ` +
        `${PROGRAM_SCHEMA_VERSION}. Refusing to open it — a forward-only ladder cannot step down.`,
    )
  }
}

/**
 * Positional parameters only (the spec's SQLite dialect uses `?`), and `undefined` becomes an explicit
 * `null`: better-sqlite3 binds it to NULL silently, `node:sqlite` throws, and a store that relies on
 * either is a store that behaves differently on the two bindings.
 */
function bind(params: readonly BindValue[]): SqlValue[] {
  return params.map((value) => (value === undefined ? null : value))
}

function normaliseRow(row: unknown, sql: string): SqlRow {
  const source = row as Record<string, unknown>
  const normalised: SqlRow = {}
  for (const column of Object.keys(source)) {
    normalised[column] = normaliseValue(source[column], column, sql)
  }
  return normalised
}

/**
 * The one place a host type could leak through the port (invariant 17) and the one place better-sqlite3
 * silently loses data: above 2^53 it truncates unless `safeIntegers` is on, so every integer arrives as
 * a `bigint` here and is range-checked before it becomes a `number`.
 */
function normaliseValue(value: unknown, column: string, sql: string): SqlValue {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new TapeIntegerRangeError(
        `${column} is ${value.toString()}, outside Number.MAX_SAFE_INTEGER; refusing to truncate ` +
          `(${sql})`,
      )
    }
    return Number(value)
  }
  // A Node `Buffer` IS a Uint8Array, so this copies it into a plain one rather than handing the pool's
  // memory (and a subclass) to the kernel.
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value === null || typeof value === 'string' || typeof value === 'number') return value
  throw new TypeError(
    `${column} came back as ${typeof value}, which this store does not map (${sql})`,
  )
}

function columnError(column: string, value: unknown, expected: string): Error {
  return new TypeError(`column ${column} must be ${expected}, got ${String(value)}`)
}

function readText(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw columnError(column, value, 'text')
  return value
}

function readNullableText(row: SqlRow, column: string): string | null {
  const value = row[column]
  if (value === null) return null
  return readText(row, column)
}

function readInt(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value !== 'number') throw columnError(column, value, 'an integer')
  return value
}

function readNullableInt(row: SqlRow, column: string): number | null {
  const value = row[column]
  if (value === null) return null
  return readInt(row, column)
}

function readBytes(row: SqlRow, column: string): Uint8Array {
  const value = row[column]
  if (!(value instanceof Uint8Array)) throw columnError(column, value, 'a blob')
  return value
}

/**
 * Every method is synchronous inside (better-sqlite3 is) and asynchronous on the port. Wrapping the
 * body means a validation failure REJECTS rather than throwing synchronously — the port promises a
 * promise, and a caller holding only a `.catch()` must not miss a malformed key.
 */
function promised<T>(body: () => T): Promise<T> {
  try {
    return Promise.resolve(body())
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Stored text back into a value. The parse is inside the guard on purpose: text that does not parse and
 * text that parses into the wrong shape are the same failure — a stored column cannot be read — and a
 * bare `SyntaxError` out of a plain `readRange` would name no row and belong to no class the port
 * defines.
 */
function parseStoredJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    // Written on two lines because `pnpm copy:check`'s `message:` field regex matches the ternary
    // `error.message : '…'` inside a template hole and reports it as untranslated UI copy.
    const reason = error instanceof Error ? error.message : String(error)
    throw new TapeProjectionError(`${label}: stored JSON does not parse (${reason})`)
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
