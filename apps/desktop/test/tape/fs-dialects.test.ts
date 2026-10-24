/**
 * Spec 05: the same kernel fs facts survive both SQL dialects without a schema migration.
 * There is no Postgres TapeStore until phase 6b. Its SQL half can be exercised with a disposable
 * database: TENON_TEST_POSTGRES_URL=postgresql://... pnpm vitest run --maxWorkers=2 fs-dialects.
 * The Postgres test creates a schema inside a transaction and rolls everything back.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import {
  bytesToHex,
  canonicalJson,
  createEntryWriter,
  createMemoryTapeStore,
  restoredKey,
  restoreStartedKey,
  sessionStartKey,
  snapshotCreatedKey,
} from '@tenon-app/kernel'
import type { TapeEntry, TapePayloadByName } from '@tenon-app/kernel'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

const SESSION = '11111111-1111-4111-8111-111111111111'
const INCARNATION = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'
const COLUMNS = [
  'tenant_id',
  'session_id',
  'entry_id',
  'incarnation_id',
  'kind',
  'name',
  'source_type',
  'source_id',
  'source_seq',
  'provenance_key',
  'payload_json',
  'meta_json',
  'created_at',
  'content_hash',
  'prev_hash',
  'entry_hash',
  'hash_ver',
]
const sql = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

async function entries() {
  const store = createMemoryTapeStore({
    identity: { tenantId: 'tenant', userId: 'user', profileDir: '/profile' },
  })
  const snapshot: TapePayloadByName['fs/snapshot_created'] = {
    snapshotId: 'snapshot',
    runId: RUN,
    requestSeq: 2,
    ordinal: 3,
    moment: 'before-call',
    scope: 'tree',
    commits: { '/work': 'a'.repeat(40) },
    files: { '/work/a': 'b'.repeat(64) },
    roundRunId: RUN,
    skipped: 1,
    writer: { by: 'run', runId: RUN },
  }
  const started: TapePayloadByName['fs/restore_started'] = {
    roundRunId: RUN,
    undoSnapshotId: 'undo',
    previewKey: 'preview',
  }
  const restored: TapePayloadByName['fs/restored'] = {
    roundRunId: RUN,
    undoSnapshotId: 'undo',
    restored: 1,
    removed: 2,
    kept: 3,
    skipped: 4,
    failed: 5,
  }
  const fs = createEntryWriter('fs')
  try {
    await store.append({
      sessionId: SESSION,
      incarnationId: INCARNATION,
      entries: [
        createEntryWriter('session')('session/start', {
          sourceType: 'session',
          sourceId: SESSION,
          sourceSeq: 0,
          provenanceKey: sessionStartKey(INCARNATION),
          payload: { incarnationId: INCARNATION },
          createdAt: 0,
        }),
        fs('fs/snapshot_created', {
          sourceType: 'runtime_event',
          sourceId: RUN,
          sourceSeq: 2,
          provenanceKey: snapshotCreatedKey(RUN, 2, 3, 'before-call'),
          payload: snapshot,
          createdAt: 1,
        }),
        fs('fs/restore_started', {
          sourceType: 'session',
          sourceId: SESSION,
          sourceSeq: 0,
          provenanceKey: restoreStartedKey(INCARNATION, 0),
          payload: started,
          createdAt: 2,
        }),
        fs('fs/restored', {
          sourceType: 'session',
          sourceId: SESSION,
          sourceSeq: 0,
          provenanceKey: restoredKey(INCARNATION, 0),
          payload: restored,
          createdAt: 3,
        }),
      ],
    })
    return (await store.readRange({ sessionId: SESSION, limit: 10 })).entries
  } finally {
    await store.close()
  }
}

function values(entry: TapeEntry) {
  return [
    entry.tenantId,
    entry.sessionId,
    entry.entryId,
    entry.incarnationId,
    entry.kind,
    entry.name,
    entry.sourceType,
    entry.sourceId,
    entry.sourceSeq,
    entry.provenanceKey,
    canonicalJson(entry.payload),
    canonicalJson(entry.meta),
    entry.createdAt,
    entry.contentHash,
    entry.prevHash,
    entry.entryHash,
    entry.hashVer,
  ]
}

function sqliteRows(facts: TapeEntry[]) {
  const db = new Database(':memory:')
  try {
    db.exec(sql('../../src/main/tape/sql/tape.sqlite.sql'))
    db.exec(sql('../../src/main/tape/sql/tape.sqlite.002.sql'))
    const insert = db.prepare(
      `INSERT INTO tape_entry (${COLUMNS.join(',')}) VALUES (${COLUMNS.map(() => '?').join(',')})`,
    )
    for (const entry of facts) insert.run(...values(entry))
    return db
      .prepare(
        'SELECT name, source_type, source_id, source_seq, provenance_key, payload_json, lower(hex(content_hash)) AS content_hash FROM tape_entry WHERE tenant_id = ? AND session_id = ? ORDER BY entry_id',
      )
      .all('tenant', SESSION)
  } finally {
    db.close()
  }
}

function expectedRows(facts: TapeEntry[]) {
  return facts.map((entry) => ({
    name: entry.name,
    source_type: entry.sourceType,
    source_id: entry.sourceId,
    source_seq: entry.sourceSeq,
    provenance_key: entry.provenanceKey,
    payload_json: canonicalJson(entry.payload),
    content_hash: bytesToHex(entry.contentHash),
  }))
}

it('05 验收 1、21: SQLite schema stores all three fs names with exact payload bytes and identities', async () => {
  const facts = await entries()
  expect(sqliteRows(facts)).toEqual(expectedRows(facts))
})

function literal(value: unknown): string {
  if (value === null) return 'NULL'
  if (value instanceof Uint8Array) return `decode('${bytesToHex(value)}','hex')`
  if (typeof value === 'number') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

it.skipIf(!process.env['TENON_TEST_POSTGRES_URL'])(
  '05 验收 1、21: Postgres and SQLite schemas preserve identical fs evidence',
  async () => {
    const facts = await entries()
    const schema = `tenon_fs_test_${randomUUID().replaceAll('-', '')}`
    const inserts = facts
      .map(
        (entry) =>
          `INSERT INTO tape_entry (${COLUMNS.join(',')}) VALUES (${values(entry).map(literal).join(',')});`,
      )
      .join('\n')
    const output = execFileSync(
      process.env['TENON_TEST_PSQL'] ??
        (existsSync('/opt/homebrew/bin/psql') ? '/opt/homebrew/bin/psql' : '/usr/bin/psql'),
      [
        // libpq reads a connection URI from --dbname, not from PGDATABASE.
        `--dbname=${process.env['TENON_TEST_POSTGRES_URL']}`,
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=1',
      ],
      {
        env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
        encoding: 'utf8',
        timeout: 15_000,
        input: `BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema};
${sql('../../../../apps/server/sql/tape.postgres.sql')}
${sql('../../../../apps/server/sql/tape.postgres.002.sql')}
${inserts}
SELECT row_to_json(t) FROM (SELECT name, source_type, source_id, source_seq, provenance_key, payload_json, encode(content_hash, 'hex') AS content_hash FROM tape_entry WHERE tenant_id = 'tenant' AND session_id = '${SESSION}' ORDER BY entry_id) t;
ROLLBACK;`,
      },
    )
    expect(
      output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual(sqliteRows(facts))
  },
)
