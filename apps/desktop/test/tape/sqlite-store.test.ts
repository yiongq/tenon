/**
 * What only the SQLite store can be asked (spec 01 acceptance 4, 9, 10, 14, 15, 18). Everything
 * provable through the port lives in the shared conformance suite and is NOT repeated here; these tests
 * need a second connection, a raw statement, a held write lock or the file on disk.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ProjectionOp, TapeEntry } from '@tenon-app/kernel'
import {
  TapeBusyError,
  TapeIntegerRangeError,
  TapeSessionNotFoundError,
  TapeTenantMismatchError,
  project,
} from '@tenon-app/kernel'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import {
  READ_BY_SOURCE_SQL,
  TapeSchemaVersionError,
  createSqliteTapeStore,
} from '../../src/main/tape/sqlite-store.js'
import {
  clockFrom,
  dbFile,
  extFact,
  identityFor,
  ids,
  modelSelectedFact,
  openStore,
  rawConnection,
  removeTempProfiles,
  retractionFact,
  startFact,
  tempProfileDir,
  userFact,
} from './fixtures.js'

afterAll(() => {
  removeTempProfiles()
})

function fileDigest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function tableNames(raw: SqliteDatabase): string[] {
  return raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name)
}

function countFacts(raw: SqliteDatabase, tenantId: string): number {
  const row = raw
    .prepare('SELECT count(*) AS n FROM tape_entry WHERE tenant_id = ?')
    .get(tenantId) as { n: number }
  return row.n
}

/** A complete, syntactically valid row for a second tenant. Its hashes are filler: no read may see it. */
function insertForeignFact(
  raw: SqliteDatabase,
  tenantId: string,
  sessionId: string,
  incarnationId: string,
  // A bigint is allowed on purpose: 2^53 + 1 is not a `number`, and writing it as one would round it
  // down to a value the range check would be right to accept.
  entryId: number | bigint,
): void {
  raw
    .prepare(
      'INSERT INTO tape_entry (tenant_id, session_id, entry_id, incarnation_id, kind, name, ' +
        'source_type, source_id, source_seq, provenance_key, payload_json, meta_json, created_at, ' +
        'content_hash, prev_hash, entry_hash, hash_ver) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
    )
    .run(
      tenantId,
      sessionId,
      entryId,
      incarnationId,
      'event',
      'ext/acme/note',
      'session',
      sessionId,
      null,
      `ext:v1:acme:note.${entryId.toString()}`,
      '{"ordinal":1}',
      '{}',
      1_700_000_000_000,
      Buffer.alloc(32, 1),
      null,
      Buffer.alloc(32, 2),
    )
}

/** A foreign tenant's `message/user`, which PROJECTS — so a replay that forgets the tenant shows it. */
function insertForeignMessageFact(
  raw: SqliteDatabase,
  tenantId: string,
  sessionId: string,
  incarnationId: string,
  entryId: number,
  messageId: string,
): void {
  raw
    .prepare(
      'INSERT INTO tape_entry (tenant_id, session_id, entry_id, incarnation_id, kind, name, ' +
        'source_type, source_id, source_seq, provenance_key, payload_json, meta_json, created_at, ' +
        'content_hash, prev_hash, entry_hash, hash_ver) ' +
        "VALUES (?, ?, ?, ?, 'message', 'message/user', 'message', ?, 0, ?, ?, '{}', ?, ?, NULL, ?, 1)",
    )
    .run(
      tenantId,
      sessionId,
      entryId,
      incarnationId,
      messageId,
      `msg:v1:${messageId}:0`,
      JSON.stringify({
        messageId,
        revision: 0,
        role: 'user',
        content: [{ type: 'text', text: 'theirs' }],
        status: 'complete',
      }),
      1_700_000_000_000,
      Buffer.alloc(32, 1),
      Buffer.alloc(32, 2),
    )
}

/** The head row of a foreign tenant, as a server host would have one beside ours. */
function insertForeignHead(
  raw: SqliteDatabase,
  tenantId: string,
  sessionId: string,
  incarnationId: string,
  lastEntryId: number,
): void {
  raw
    .prepare(
      'INSERT INTO session_head (tenant_id, session_id, incarnation_id, last_entry_id, ' +
        'last_hash, entry_count, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
    )
    .run(
      tenantId,
      sessionId,
      incarnationId,
      lastEntryId,
      lastEntryId,
      1_700_000_000_000,
      1_700_000_000_000,
    )
}

/** Both projections of a foreign tenant. `updatedAt` is far in the future so a leak sorts FIRST. */
function insertForeignProjections(
  raw: SqliteDatabase,
  tenantId: string,
  sessionId: string,
  messageId: string,
): void {
  raw
    .prepare(
      'INSERT INTO session_projection (tenant_id, session_id, title, provider_id, model_id, ' +
        'last_message_at, forked_from_session_id, created_at, updated_at) ' +
        'VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)',
    )
    .run(tenantId, sessionId, 1_700_000_000_000, 1_900_000_000_000)
  raw
    .prepare(
      'INSERT INTO message_projection (tenant_id, session_id, message_id, order_seq, role, ' +
        'status, content_json, entry_id, created_at, updated_at) ' +
        "VALUES (?, ?, ?, 1, 'user', 'complete', '[]', 1, ?, ?)",
    )
    .run(tenantId, sessionId, messageId, 1_700_000_000_000, 1_700_000_000_000)
}

/** Two upserts with NO `insertOnly`, the shape only a reducer that reads the current row produces. */
function updateOps(entry: TapeEntry, messageId: string): readonly ProjectionOp[] {
  return [
    {
      table: 'message',
      op: 'upsert',
      key: { sessionId: entry.sessionId, messageId },
      values: {
        role: 'assistant',
        status: 'complete',
        contentJson: '[]',
        entryId: entry.entryId,
        updatedAt: entry.createdAt,
      },
    },
    {
      table: 'session',
      op: 'upsert',
      key: { sessionId: entry.sessionId },
      values: { providerId: 'rewritten', updatedAt: entry.createdAt },
    },
  ]
}

/** What the foreign tenant's rows look like right now, as one comparable snapshot. */
function foreignState(raw: SqliteDatabase, tenantId: string): unknown {
  return {
    facts: countFacts(raw, tenantId),
    head: raw
      .prepare(
        'SELECT session_id, incarnation_id, last_entry_id, last_hash, entry_count FROM ' +
          'session_head WHERE tenant_id = ?',
      )
      .all(tenantId),
    sessions: raw
      .prepare('SELECT session_id, updated_at FROM session_projection WHERE tenant_id = ?')
      .all(tenantId),
    messages: raw
      .prepare('SELECT session_id, message_id FROM message_projection WHERE tenant_id = ?')
      .all(tenantId),
    cursors: raw
      .prepare('SELECT count(*) AS n FROM projection_cursor WHERE tenant_id = ?')
      .get(tenantId),
    gates: raw
      .prepare('SELECT session_id, mode FROM tape_maintenance WHERE tenant_id = ?')
      .all(tenantId),
  }
}

// -------------------------------------------------------------------------------------------------
// Acceptance 18 · migrations
// -------------------------------------------------------------------------------------------------

describe('opening the file (acceptance 18)', () => {
  it('builds schema v1 with one schema_version row, and reopening writes nothing', async () => {
    const profileDir = tempProfileDir('tape-migrate')
    const first = openStore({ label: 'migrate', profileDir })
    await first.store.close()

    const raw = rawConnection(first.file)
    expect(raw.prepare('SELECT version FROM schema_version ORDER BY version').all()).toEqual([
      { version: 1 },
    ])
    // The DDL file's objects, all of them, in one file.
    expect(tableNames(raw)).toEqual([
      'message_projection',
      'projection_cursor',
      'schema_version',
      'session_head',
      'session_projection',
      'tape_entry',
      'tape_maintenance',
      'tape_meta',
    ])
    expect(raw.prepare('SELECT tenant_id FROM tape_meta').all()).toEqual([
      { tenant_id: 'tenant-a' },
    ])
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal')
    raw.close()

    // Reopening is a no-op: the ladder is forward-only and there is nothing left to apply.
    const before = fileDigest(first.file)
    const second = openStore({ label: 'migrate', profileDir })
    await second.store.close()
    expect(fileDigest(first.file)).toBe(before)
  })

  it('treats a zero-byte file as an empty database', async () => {
    const profileDir = tempProfileDir('tape-empty-file')
    writeFileSync(dbFile(profileDir), '')
    const opened = openStore({ label: 'empty', profileDir })
    const raw = rawConnection(opened.file)
    expect(raw.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: 1 }])
    raw.close()
    await opened.store.close()
  })

  it('refuses a file from a newer build and leaves it byte for byte unchanged', async () => {
    const profileDir = tempProfileDir('tape-newer')
    const first = openStore({ label: 'newer', profileDir })
    await first.store.close()
    const raw = rawConnection(first.file)
    raw
      .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(2, 1_700_000_000_000)
    raw.close()

    const before = fileDigest(first.file)
    expect(() =>
      createSqliteTapeStore({ identity: identityFor(profileDir), now: () => 1 }),
    ).toThrow(TapeSchemaVersionError)
    // Refusing means writing NOTHING: a forward-only ladder cannot step down, and half-downgrading a
    // user's history is worse than refusing to start.
    expect(fileDigest(first.file)).toBe(before)
  })

  it('refuses a newer file with a hot -wal and neither checkpoints nor deletes it', async () => {
    // The third on-disk state, the likeliest one in the field: a newer build crashed and left a hot
    // `-wal`, then an older build starts. Closing the LAST read-write connection of a WAL database
    // checkpoints it, so before the fix the refused open folded the -wal into the main file and deleted
    // it — the right error, and the user's newest facts rewritten on the way out. The crash is staged by
    // snapshotting both files while a writer still holds them.
    const profileDir = tempProfileDir('tape-newer-hot')
    const first = openStore({ label: 'newer-hot', profileDir })
    await first.store.close()
    const walFile = `${first.file}-wal`
    const snapshot = `${first.file}.snapshot`
    const walSnapshot = `${walFile}.snapshot`
    const writer = rawConnection(first.file)
    writer.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(2, 1)
    expect(existsSync(walFile)).toBe(true)
    copyFileSync(first.file, snapshot)
    copyFileSync(walFile, walSnapshot)
    writer.close() // checkpoints and removes the -wal, which is exactly what a crash does NOT do
    copyFileSync(snapshot, first.file)
    copyFileSync(walSnapshot, walFile)

    const before = fileDigest(first.file)
    expect(() =>
      createSqliteTapeStore({ identity: identityFor(profileDir), now: () => 1 }),
    ).toThrow(TapeSchemaVersionError)
    expect(fileDigest(first.file)).toBe(before)
    expect(existsSync(walFile)).toBe(true)
  })

  it('refuses a newer file that is NOT in WAL mode without rewriting its header', async () => {
    // The half the WAL case cannot show. `PRAGMA journal_mode = WAL` rewrites bytes 18-19 of page 1 on
    // a file that is not already in WAL mode — a file restored from `VACUUM INTO` or `.backup` is in
    // delete mode — so 「拒绝打开且不写任何东西」 only holds if the version is read BEFORE the pragmas, on
    // a read-only connection. Measured before the fix: same size, different sha256, and the file came
    // back in WAL mode.
    const profileDir = tempProfileDir('tape-newer-delete')
    const first = openStore({ label: 'newer-delete', profileDir })
    await first.store.close()
    const raw = rawConnection(first.file)
    raw.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(2, 1)
    expect(raw.pragma('journal_mode = DELETE', { simple: true })).toBe('delete')
    raw.close()

    const before = fileDigest(first.file)
    expect(() =>
      createSqliteTapeStore({ identity: identityFor(profileDir), now: () => 1 }),
    ).toThrow(TapeSchemaVersionError)
    expect(fileDigest(first.file)).toBe(before)
    // The two direct witnesses that nothing opened it for writing: byte 18 of page 1 is the file
    // format's write version (1 = rollback journal, 2 = WAL), and a read-only open creates no -wal.
    expect(readFileSync(first.file)[18]).toBe(1)
    expect(existsSync(`${first.file}-wal`)).toBe(false)
  })
})

// -------------------------------------------------------------------------------------------------
// Acceptance 4 · another profile's data is invisible
// -------------------------------------------------------------------------------------------------

describe('tenant isolation (acceptance 4)', () => {
  it('gives each profile its own file, and refuses a file that belongs to another tenant', async () => {
    const a = openStore({ label: 'tenant-a', tenantId: 'tenant-a' })
    const b = openStore({ label: 'tenant-b', tenantId: 'tenant-b' })
    expect(a.file).not.toBe(b.file)

    const seqA = ids(1)
    const seqB = ids(500)
    const atA = clockFrom()
    const atB = clockFrom()
    const sessionA = seqA.uuid()
    const sessionB = seqB.uuid()
    const incarnationA = seqA.uuid()
    const incarnationB = seqB.uuid()
    await a.store.append({
      sessionId: sessionA,
      incarnationId: incarnationA,
      entries: [startFact(sessionA, incarnationA, atA), userFact(seqA.uuid(), 0, 'mine', atA)],
    })
    await b.store.append({
      sessionId: sessionB,
      incarnationId: incarnationB,
      entries: [startFact(sessionB, incarnationB, atB), userFact(seqB.uuid(), 0, 'theirs', atB)],
    })
    expect((await a.store.listSessions({ limit: 10 })).map((row) => row.sessionId)).toEqual([
      sessionA,
    ])
    expect((await b.store.listSessions({ limit: 10 })).map((row) => row.sessionId)).toEqual([
      sessionB,
    ])
    await b.store.close()

    // A's identity on B's file: the tenant is written on creation and checked on every later open —
    // and, like a newer file, the refusal writes nothing. Today the ladder has one rung so a
    // mismatched open applies nothing anyway; the assertion is here so that at schema v2 the tenant is
    // still compared BEFORE a migration is committed to someone else's file.
    const before = fileDigest(b.file)
    expect(() =>
      createSqliteTapeStore({ identity: identityFor(b.profileDir, 'tenant-a'), now: () => 1 }),
    ).toThrow(TapeTenantMismatchError)
    expect(fileDigest(b.file)).toBe(before)
    await a.store.close()
  })

  it('cannot see a second tenant sharing one file (the server rehearsal)', async () => {
    // One file, two tenants' rows — the shape a server host has. Every statement of the A-bound store
    // binds its tenant, so B's session must look exactly like a session that never existed.
    const a = openStore({ label: 'shared-file', tenantId: 'tenant-a' })
    const seq = ids(1)
    const at = clockFrom()
    const mine = seq.uuid()
    const myIncarnation = seq.uuid()
    await a.store.append({
      sessionId: mine,
      incarnationId: myIncarnation,
      entries: [startFact(mine, myIncarnation, at), userFact(seq.uuid(), 0, 'mine', at)],
    })

    const theirs = seq.uuid()
    const theirIncarnation = seq.uuid()
    const raw = rawConnection(a.file)
    insertForeignFact(raw, 'tenant-b', theirs, theirIncarnation, 1)
    insertForeignFact(raw, 'tenant-b', theirs, theirIncarnation, 2)
    raw
      .prepare(
        'INSERT INTO session_head (tenant_id, session_id, incarnation_id, last_entry_id, ' +
          'last_hash, entry_count, created_at, updated_at) VALUES (?, ?, ?, 2, NULL, 2, ?, ?)',
      )
      .run('tenant-b', theirs, theirIncarnation, 1_700_000_000_000, 1_700_000_000_000)
    raw
      .prepare(
        'INSERT INTO session_projection (tenant_id, session_id, title, provider_id, model_id, ' +
          'last_message_at, forked_from_session_id, created_at, updated_at) ' +
          'VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)',
      )
      .run('tenant-b', theirs, 1_700_000_000_000, 1_900_000_000_000)
    raw
      .prepare(
        'INSERT INTO message_projection (tenant_id, session_id, message_id, order_seq, role, ' +
          'status, content_json, entry_id, created_at, updated_at) ' +
          "VALUES (?, ?, ?, 1, 'user', 'complete', '[]', 1, ?, ?)",
      )
      .run('tenant-b', theirs, seq.uuid(), 1_700_000_000_000, 1_700_000_000_000)

    // Every read API, on B's sessionId.
    expect(await a.store.readRange({ sessionId: theirs, limit: 10 })).toEqual({
      entries: [],
      incarnationId: '',
      nextFromEntryId: null,
    })
    expect(
      await a.store.readBySource({
        sessionId: theirs,
        sourceType: 'session',
        sourceId: theirs,
        limit: 10,
      }),
    ).toEqual([])
    expect(await a.store.head(theirs)).toBeNull()
    expect((await a.store.listSessions({ limit: 10 })).map((row) => row.sessionId)).toEqual([mine])
    expect(await a.store.listMessages({ sessionId: theirs, limit: 10 })).toEqual([])
    expect(await a.store.verifyChain({ sessionId: theirs, limit: 10 })).toEqual({
      incarnationId: '',
      checked: 0,
      firstBadEntryId: null,
      nextFromEntryId: null,
    })

    // And neither write path touches a row it cannot see.
    const foreignFacts = countFacts(raw, 'tenant-b')
    expect(foreignFacts).toBe(2)
    await a.store.deleteSession(theirs)
    expect(countFacts(raw, 'tenant-b')).toBe(foreignFacts)
    expect(
      raw.prepare('SELECT count(*) AS n FROM session_head WHERE tenant_id = ?').get('tenant-b'),
    ).toEqual({ n: 1 })
    const freshIncarnation = seq.uuid()
    await expect(
      a.store.resetSession({
        sessionId: theirs,
        incarnationId: freshIncarnation,
        start: startFact(theirs, freshIncarnation, at),
      }),
    ).rejects.toThrow(TapeSessionNotFoundError)
    expect(countFacts(raw, 'tenant-b')).toBe(foreignFacts)
    expect(
      raw.prepare('SELECT incarnation_id FROM session_head WHERE tenant_id = ?').get('tenant-b'),
    ).toEqual({ incarnation_id: theirIncarnation })
    expect(countFacts(raw, 'tenant-a')).toBe(2)
    raw.close()
    await a.store.close()
  })

  it('cannot see, touch or be confused by a second tenant under the SAME sessionId', async () => {
    // The sharpest shape of the rehearsal, and the one that makes acceptance 4's 「去掉代码里的租户谓词，
    // 这个测试必须变红」 true: a foreign tenant holding rows under the SAME session_id, so a dropped
    // predicate is no longer filtered out upstream by the head lookup. Fourteen statements in the store
    // bind `tenant_id`; with a DIFFERENT foreign session_id only five of them are load-bearing (a
    // reviewer removed each in turn and nine mutants survived the whole suite). Verified by hand again
    // here: the nine now red this test — see the fix report for the list.
    const a = openStore({ label: 'shadow-session', tenantId: 'tenant-a' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const myIncarnation = seq.uuid()
    const myMessage = seq.uuid()
    await a.store.append({
      sessionId,
      incarnationId: myIncarnation,
      entries: [startFact(sessionId, myIncarnation, at), userFact(myMessage, 0, 'mine', at)],
    })

    const raw = rawConnection(a.file)
    const theirIncarnation = seq.uuid()
    // The same session_id AND the same entry ids: the primary key is (tenant_id, session_id,
    // entry_id), so a read that forgets the tenant sees ids 1, 1, 2, 2. The provenance keys are the
    // ones this store's own `extFact` mints, so a forgetful idempotency lookup hits a foreign row.
    insertForeignFact(raw, 'tenant-b', sessionId, theirIncarnation, 1)
    insertForeignFact(raw, 'tenant-b', sessionId, theirIncarnation, 2)
    // A fact of B's that PROJECTS, so a rebuild that forgets the tenant writes B's message into A's
    // projection, and a projection row under A's OWN messageId, so a forgetful delete takes it.
    insertForeignMessageFact(raw, 'tenant-b', sessionId, theirIncarnation, 3, seq.uuid())
    insertForeignHead(raw, 'tenant-b', sessionId, theirIncarnation, 3)
    insertForeignProjections(raw, 'tenant-b', sessionId, myMessage)
    // An open gate of B's, which only a raw writer can leave lying about: closing a gate is a DELETE
    // too, and it must not close someone else's.
    raw
      .prepare(
        'INSERT INTO tape_maintenance (tenant_id, session_id, mode, opened_at) VALUES (?, ?, ?, ?)',
      )
      .run('tenant-b', sessionId, 'delete', 1_700_000_000_000)
    const before = foreignState(raw, 'tenant-b')

    // ----- every read sees exactly two rows, all of them A's -------------------------------------
    const page = await a.store.readRange({ sessionId, limit: 10 })
    expect(page.entries.map((entry) => entry.entryId)).toEqual([1, 2])
    expect(page.incarnationId).toBe(myIncarnation)
    expect(page.entries.map((entry) => entry.incarnationId)).toEqual([myIncarnation, myIncarnation])
    expect(
      (
        await a.store.readBySource({
          sessionId,
          sourceType: 'session',
          sourceId: sessionId,
          limit: 10,
        })
      ).length,
    ).toBe(1)
    const head = await a.store.head(sessionId)
    expect(head?.incarnationId).toBe(myIncarnation)
    expect(head?.entryCount).toBe(2)
    expect(await a.store.verifyChain({ sessionId, limit: 10 })).toEqual({
      incarnationId: myIncarnation,
      checked: 2,
      firstBadEntryId: null,
      nextFromEntryId: null,
    })
    expect((await a.store.listSessions({ limit: 10 })).map((row) => row.sessionId)).toEqual([
      sessionId,
    ])
    expect(
      (await a.store.listMessages({ sessionId, limit: 10 })).map((row) => row.messageId),
    ).toEqual([myMessage])

    // ----- and every write stays on this side of the boundary ------------------------------------
    // `ext:v1:acme:note.1` already exists under tenant-b: the idempotency lookup must miss it and
    // allocate a new id, and the two head statements must leave B's head row alone.
    const [receipt] = await a.store.append({
      sessionId,
      incarnationId: myIncarnation,
      entries: [extFact(sessionId, 1, at)],
    })
    expect(receipt).toMatchObject({ entryId: 3, created: true })
    expect(foreignState(raw, 'tenant-b')).toEqual(before)

    // A retraction deletes a projection row by message_id — B has one under that very id — and a
    // rebuild replays the facts, where B's own `message/user` would otherwise land in A's projection.
    await a.store.append({
      sessionId,
      incarnationId: myIncarnation,
      entries: [retractionFact(myMessage, at)],
    })
    expect(await a.store.listMessages({ sessionId, limit: 10 })).toEqual([])
    expect(foreignState(raw, 'tenant-b')).toEqual(before)
    await a.store.rebuildProjections(sessionId)
    expect(await a.store.listMessages({ sessionId, limit: 10 })).toEqual([])
    expect((await a.store.listSessions({ limit: 10 })).map((row) => row.sessionId)).toEqual([
      sessionId,
    ])
    expect(foreignState(raw, 'tenant-b')).toEqual(before)

    const nextIncarnation = seq.uuid()
    await a.store.resetSession({
      sessionId,
      incarnationId: nextIncarnation,
      start: startFact(sessionId, nextIncarnation, at),
    })
    expect(foreignState(raw, 'tenant-b')).toEqual(before)
    expect(countFacts(raw, 'tenant-a')).toBe(1)

    await a.store.deleteSession(sessionId)
    expect(foreignState(raw, 'tenant-b')).toEqual(before)
    expect(countFacts(raw, 'tenant-a')).toBe(0)
    raw.close()
    await a.store.close()
  })

  it("never links a page of verifyChain to another tenant's row", async () => {
    // `verifyChain` reads one row BELOW the page cursor to get the link INTO the page. That statement
    // binds the tenant like every other, and this is the construction that can tell: A's ids have a
    // gap (its high-water mark was pushed forward), and B holds a row inside the gap, so "the nearest
    // row below the cursor" is a DIFFERENT row for the two tenants. Without the predicate the page is
    // linked to B's filler hash and the first row of the page is reported as broken.
    const a = openStore({ label: 'chain-link', tenantId: 'tenant-a' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    await a.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at), extFact(sessionId, 1, at)],
    })
    const raw = rawConnection(a.file)
    // `session_head` carries no append-only trigger, so a raw writer can move the high-water mark. The
    // next fact therefore lands at 11 and leaves 3..10 empty.
    raw
      .prepare('UPDATE session_head SET last_entry_id = 10 WHERE tenant_id = ? AND session_id = ?')
      .run('tenant-a', sessionId)
    insertForeignFact(raw, 'tenant-b', sessionId, seq.uuid(), 5)
    const [receipt] = await a.store.append({
      sessionId,
      incarnationId,
      entries: [extFact(sessionId, 2, at)],
    })
    expect(receipt?.entryId).toBe(11)
    expect(await a.store.verifyChain({ sessionId, fromEntryId: 11, limit: 10 })).toEqual({
      incarnationId,
      checked: 1,
      firstBadEntryId: null,
      nextFromEntryId: null,
    })
    raw.close()
    await a.store.close()
  })

  it('binds the tenant on the projection statements the kernel reducer never reaches', async () => {
    // Three statements in `applyOps` are unreachable through `project()`: the two upserts WITHOUT
    // `insertOnly` (which can only UPDATE an existing row) and the delete of a session projection.
    // They are there for a reducer that does read the current row, invariant 15 covers them like every
    // other statement, and a mutation check showed they are the only tenant predicates no test could
    // falsify — so they are pinned here through an injected reducer instead of being left for a future
    // caller to discover.
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    const messageId = seq.uuid()
    const a = openStore({
      label: 'blind-reducer',
      tenantId: 'tenant-a',
      project: (entry) => {
        if (entry.name !== 'ext/acme/note') return project(entry)
        const ordinal = (entry.payload as { ordinal: number }).ordinal
        return ordinal === 1
          ? updateOps(entry, messageId)
          : [{ table: 'session', op: 'delete', key: { sessionId: entry.sessionId } }]
      },
    })
    await a.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at), userFact(messageId, 0, 'mine', at)],
    })
    const raw = rawConnection(a.file)
    // B's rows carry the SAME session_id and the SAME message_id, so a statement missing its tenant
    // predicate updates or deletes them instead of (or as well as) A's.
    insertForeignProjections(raw, 'tenant-b', sessionId, messageId)
    const before = foreignState(raw, 'tenant-b')

    await a.store.append({
      sessionId,
      incarnationId,
      entries: [extFact(sessionId, 1, at)],
    })
    const [updated] = await a.store.listMessages({ sessionId, limit: 10 })
    expect(updated?.role).toBe('assistant')
    const [summary] = await a.store.listSessions({ limit: 10 })
    expect(summary?.providerId).toBe('rewritten')
    expect(foreignState(raw, 'tenant-b')).toEqual(before)
    expect(
      raw
        .prepare(
          'SELECT role FROM message_projection WHERE tenant_id = ? AND session_id = ? AND ' +
            'message_id = ?',
        )
        .get('tenant-b', sessionId, messageId),
    ).toEqual({ role: 'user' })

    await a.store.append({ sessionId, incarnationId, entries: [extFact(sessionId, 2, at)] })
    expect(await a.store.listSessions({ limit: 10 })).toEqual([])
    expect(foreignState(raw, 'tenant-b')).toEqual(before)
    raw.close()
    await a.store.close()
  })
})

// -------------------------------------------------------------------------------------------------
// Acceptance 9 · append-only is enforced by the database, and the store rolls back
// -------------------------------------------------------------------------------------------------

describe('append-only and rollback (acceptance 9)', () => {
  it('refuses a bare UPDATE and an ungated DELETE, and the row survives both', async () => {
    const opened = openStore({ label: 'append-only' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at)],
    })
    const raw = rawConnection(opened.file)
    expect(() =>
      raw
        .prepare('UPDATE tape_entry SET payload_json = ? WHERE tenant_id = ? AND session_id = ?')
        .run('{"tampered":true}', 'tenant-a', sessionId),
    ).toThrow(/append-only/)
    expect(() =>
      raw
        .prepare('DELETE FROM tape_entry WHERE tenant_id = ? AND session_id = ?')
        .run('tenant-a', sessionId),
    ).toThrow(/maintenance gate/)
    expect(countFacts(raw, 'tenant-a')).toBe(1)
    const survivor = (await opened.store.readRange({ sessionId, limit: 10 })).entries[0]
    expect(survivor?.payload).toEqual({ incarnationId })
    raw.close()
    await opened.store.close()
  })

  it('releases the write lock when a batch fails, so another connection can take it', async () => {
    // The conformance suite already proves the batch left no trace. What only SQLite can show is that
    // the store's own ROLLBACK ran: a trigger ABORT or a failed statement leaves the transaction OPEN,
    // and a second connection's BEGIN IMMEDIATE would then fail with SQLITE_BUSY.
    const opened = openStore({ label: 'rollback', busyTimeoutMs: 50 })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    const messageId = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at), userFact(messageId, 0, 'first', at)],
    })
    await expect(
      opened.store.append({
        sessionId,
        incarnationId,
        entries: [extFact(sessionId, 1, at), userFact(messageId, 0, 'conflicting text', at)],
      }),
    ).rejects.toThrow(/different content/)

    const raw = rawConnection(opened.file)
    raw.exec('BEGIN IMMEDIATE')
    expect(raw.inTransaction).toBe(true)
    raw.exec('ROLLBACK')
    raw.close()
    // And the same store still appends afterwards.
    const [receipt] = await opened.store.append({
      sessionId,
      incarnationId,
      entries: [extFact(sessionId, 1, at)],
    })
    expect(receipt?.created).toBe(true)
    await opened.store.close()
  })

  it('deletes through a per-session gate whose mode says which path opened it', async () => {
    const opened = openStore({ label: 'gate' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const other = seq.uuid()
    const incarnationId = seq.uuid()
    const otherIncarnation = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at), extFact(sessionId, 1, at)],
    })
    await opened.store.append({
      sessionId: other,
      incarnationId: otherIncarnation,
      entries: [startFact(other, otherIncarnation, at)],
    })

    // The gate is opened and closed inside one transaction, so no other connection can observe it
    // directly. A test-only trigger records every gate row as it is inserted.
    const raw = rawConnection(opened.file)
    raw.exec(
      'CREATE TABLE gate_log (session_id TEXT NOT NULL, mode TEXT NOT NULL) STRICT; ' +
        'CREATE TRIGGER gate_watch AFTER INSERT ON tape_maintenance BEGIN ' +
        'INSERT INTO gate_log (session_id, mode) VALUES (NEW.session_id, NEW.mode); END;',
    )

    const nextIncarnation = seq.uuid()
    await opened.store.resetSession({
      sessionId,
      incarnationId: nextIncarnation,
      start: startFact(sessionId, nextIncarnation, at),
    })
    await opened.store.deleteSession(sessionId)
    expect(raw.prepare('SELECT session_id, mode FROM gate_log').all()).toEqual([
      { session_id: sessionId, mode: 'reset' },
      { session_id: sessionId, mode: 'delete' },
    ])
    // Closed before COMMIT, both times.
    expect(raw.prepare('SELECT count(*) AS n FROM tape_maintenance').get()).toEqual({ n: 0 })

    // A gate for one session cannot delete another's rows: the trigger checks the OLD row's session.
    raw.exec('DROP TRIGGER gate_watch')
    raw.exec('BEGIN IMMEDIATE')
    raw
      .prepare(
        'INSERT INTO tape_maintenance (tenant_id, session_id, mode, opened_at) VALUES (?, ?, ?, ?)',
      )
      .run('tenant-a', sessionId, 'delete', 1_700_000_000_000)
    expect(() =>
      raw
        .prepare('DELETE FROM tape_entry WHERE tenant_id = ? AND session_id = ?')
        .run('tenant-a', other),
    ).toThrow(/maintenance gate/)
    raw.exec('ROLLBACK')
    expect(countFacts(raw, 'tenant-a')).toBe(1)
    raw.close()
    await opened.store.close()
  })
})

// -------------------------------------------------------------------------------------------------
// Acceptance 10 · two connections, and a lock held on purpose
// -------------------------------------------------------------------------------------------------

describe('two connections on one session (acceptance 10)', () => {
  it('allocates distinct, strictly increasing ids in a scripted interleaving', async () => {
    // Both stores are separate connections onto one file. The interleaving is SCRIPTED rather than
    // raced: better-sqlite3 is synchronous, so a race would only prove which of the two got the lock.
    const profileDir = tempProfileDir('tape-interleave')
    const one = openStore({ label: 'writer-one', profileDir })
    const two = openStore({ label: 'writer-two', profileDir })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    await one.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at)],
    })
    const received: number[] = []
    for (let round = 0; round < 6; round += 1) {
      const writer = round % 2 === 0 ? one.store : two.store
      // oxlint-disable-next-line no-await-in-loop -- the interleaving is the point of the test
      const results = await writer.append({
        sessionId,
        incarnationId,
        entries: [extFact(sessionId, round, at)],
      })
      for (const result of results) received.push(result.entryId)
    }
    expect(received).toEqual([2, 3, 4, 5, 6, 7])
    expect(new Set(received).size).toBe(received.length)

    // No lost rows, and the chain both connections extended verifies as one chain.
    const page = await two.store.readRange({ sessionId, limit: 100 })
    expect(page.entries.map((entry) => entry.entryId)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(await one.store.verifyChain({ sessionId, limit: 100 })).toEqual({
      incarnationId,
      checked: 7,
      firstBadEntryId: null,
      nextFromEntryId: null,
    })
    await one.store.close()
    await two.store.close()
  })

  it('raises TapeBusyError when the write lock is held past the timeout', async () => {
    const opened = openStore({ label: 'busy', busyTimeoutMs: 25 })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at)],
    })
    const holder = rawConnection(opened.file)
    holder.exec('BEGIN IMMEDIATE')
    // Something must actually be written, or SQLite defers the lock acquisition.
    holder
      .prepare(
        'INSERT INTO tape_maintenance (tenant_id, session_id, mode, opened_at) VALUES (?, ?, ?, ?)',
      )
      .run('tenant-a', 'lock-holder', 'delete', 1)
    await expect(
      opened.store.append({ sessionId, incarnationId, entries: [extFact(sessionId, 1, at)] }),
    ).rejects.toThrow(TapeBusyError)
    // Not a race: the lock is released explicitly, and only then does the same store get through.
    holder.exec('ROLLBACK')
    holder.close()
    const [receipt] = await opened.store.append({
      sessionId,
      incarnationId,
      entries: [extFact(sessionId, 1, at)],
    })
    expect(receipt?.entryId).toBe(2)
    await opened.store.close()
  })
})

// -------------------------------------------------------------------------------------------------
// Acceptance 14 · the recovery read path exists and stays on its index
// -------------------------------------------------------------------------------------------------

describe('readBySource (acceptance 14)', () => {
  it("returns a run's facts in entry_id order, on tape_entry_by_source, with no temp B-tree", async () => {
    const opened = openStore({ label: 'by-source' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    const runId = seq.uuid()
    const otherRun = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [
        startFact(sessionId, incarnationId, at),
        modelSelectedFact(sessionId, runId, at),
        modelSelectedFact(sessionId, otherRun, at),
      ],
    })
    const facts = await opened.store.readBySource({
      sessionId,
      sourceType: 'session',
      sourceId: sessionId,
      limit: 10,
    })
    expect(facts.map((entry) => entry.entryId)).toEqual([1, 2, 3])

    // The plan of the statement the store REALLY runs: a rename, a column reorder or a rewrite into a
    // scan has to red this test rather than quietly cost a sort.
    const raw = rawConnection(opened.file)
    const plan = raw
      .prepare(`EXPLAIN QUERY PLAN ${READ_BY_SOURCE_SQL}`)
      .all('tenant-a', sessionId, 'runtime_event', runId, 10)
      .map((row) => (row as { detail: string }).detail)
      .join('\n')
    expect(plan).toContain('tape_entry_by_source')
    expect(plan).not.toContain('TEMP B-TREE')
    raw.close()
    await opened.store.close()
  })
})

// -------------------------------------------------------------------------------------------------
// The projection cursor · invisible through the port, so the shared suite cannot assert it
// -------------------------------------------------------------------------------------------------

describe('projection_cursor', () => {
  it('advances for every fact, one row per projection, and restarts with an incarnation', async () => {
    const opened = openStore({ label: 'cursor' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [
        startFact(sessionId, incarnationId, at),
        // An attempt fact projects to nothing, and the cursor must still pass it: it records what a
        // projection has CONSUMED, not what it wrote.
        modelSelectedFact(sessionId, seq.uuid(), at),
        userFact(seq.uuid(), 0, 'counted', at),
      ],
    })
    const raw = rawConnection(opened.file)
    const cursors = raw
      .prepare(
        'SELECT projection, incarnation_id, last_entry_id, projection_version FROM ' +
          'projection_cursor WHERE tenant_id = ? AND session_id = ? ORDER BY projection',
      )
      .all('tenant-a', sessionId)
    expect(cursors).toEqual([
      {
        projection: 'message',
        incarnation_id: incarnationId,
        last_entry_id: 3,
        projection_version: 1,
      },
      {
        projection: 'session',
        incarnation_id: incarnationId,
        last_entry_id: 3,
        projection_version: 1,
      },
    ])

    // A rebuild replays the same facts through the same ops, so it lands on the same cursor.
    await opened.store.rebuildProjections(sessionId)
    expect(
      raw
        .prepare(
          'SELECT projection, last_entry_id FROM projection_cursor WHERE tenant_id = ? AND ' +
            'session_id = ? ORDER BY projection',
        )
        .all('tenant-a', sessionId),
    ).toEqual([
      { projection: 'message', last_entry_id: 3 },
      { projection: 'session', last_entry_id: 3 },
    ])

    // A reset clears the cursor with the rest of the projection and re-opens it on the new anchor.
    const nextIncarnation = seq.uuid()
    const reset = await opened.store.resetSession({
      sessionId,
      incarnationId: nextIncarnation,
      start: startFact(sessionId, nextIncarnation, at),
    })
    expect(
      raw
        .prepare(
          'SELECT projection, incarnation_id, last_entry_id FROM projection_cursor ' +
            'WHERE tenant_id = ? AND session_id = ? ORDER BY projection',
        )
        .all('tenant-a', sessionId),
    ).toEqual([
      { projection: 'message', incarnation_id: nextIncarnation, last_entry_id: reset.entryId },
      { projection: 'session', incarnation_id: nextIncarnation, last_entry_id: reset.entryId },
    ])

    // And deleting the session takes the cursor with it.
    await opened.store.deleteSession(sessionId)
    expect(
      raw
        .prepare('SELECT count(*) AS n FROM projection_cursor WHERE tenant_id = ?')
        .get('tenant-a'),
    ).toEqual({ n: 0 })
    raw.close()
    await opened.store.close()
  })
})

// -------------------------------------------------------------------------------------------------
// After close() · the port says nothing, so the store must at least not leak the binding's wording
// -------------------------------------------------------------------------------------------------

describe('a closed store', () => {
  it("rejects every method with its own error instead of better-sqlite3's", async () => {
    const opened = openStore({ label: 'closed' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at)],
    })
    await opened.store.close()
    // Idempotent, and then every path refuses through the one prepare helper. Use after close is a
    // caller bug, not a condition of the tape, so it is the TypeError an empty id gets — never
    // `TypeError: The database connection is not open`, which would name the binding through the port.
    await opened.store.close()
    for (const call of [
      () => opened.store.readRange({ sessionId, limit: 10 }),
      () => opened.store.head(sessionId),
      () => opened.store.listSessions({ limit: 10 }),
      () => opened.store.append({ sessionId, incarnationId, entries: [extFact(sessionId, 1, at)] }),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one rejection asserted per method, in order
      await expect(call()).rejects.toThrow(/this store is closed/)
    }
  })
})

// -------------------------------------------------------------------------------------------------
// Acceptance 15 · integer and byte safety
// -------------------------------------------------------------------------------------------------

describe('integers and bytes at the port (acceptance 15)', () => {
  it('refuses an entry_id above 2^53 instead of truncating it', async () => {
    const opened = openStore({ label: 'integers' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at)],
    })
    const raw = rawConnection(opened.file)
    // 2^53 + 1: the first integer a double cannot represent, which is where better-sqlite3 would
    // silently hand back the wrong number without safeIntegers.
    insertForeignFact(raw, 'tenant-a', sessionId, incarnationId, 9_007_199_254_740_993n)
    await expect(opened.store.readRange({ sessionId, limit: 10 })).rejects.toThrow(
      TapeIntegerRangeError,
    )
    raw
      .prepare('UPDATE session_head SET last_entry_id = ? WHERE tenant_id = ? AND session_id = ?')
      .run(9_007_199_254_740_993n, 'tenant-a', sessionId)
    await expect(opened.store.head(sessionId)).rejects.toThrow(TapeIntegerRangeError)
    raw.close()
    await opened.store.close()
  })

  it('hands digests over as plain Uint8Array, never a Buffer or a bigint', async () => {
    const opened = openStore({ label: 'port-types' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at), extFact(sessionId, 1, at)],
    })
    const page = await opened.store.readRange({ sessionId, limit: 10 })
    const entry = page.entries[1]
    if (entry === undefined) throw new Error('no second entry')
    for (const digest of [entry.contentHash, entry.entryHash, entry.prevHash]) {
      // A Buffer IS a Uint8Array, so the check is on the prototype (invariant 17).
      expect(digest).toBeInstanceOf(Uint8Array)
      expect(Object.getPrototypeOf(digest)).toBe(Uint8Array.prototype)
    }
    expect(typeof entry.entryId).toBe('number')
    expect(typeof entry.createdAt).toBe('number')
    const head = await opened.store.head(sessionId)
    expect(typeof head?.lastEntryId).toBe('number')
    expect(Object.getPrototypeOf(head?.lastHash)).toBe(Uint8Array.prototype)
    await opened.store.close()
  })
})
