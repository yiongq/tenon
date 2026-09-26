// Acceptance 17 as a regression test: the shipped pair of dialect files agrees, and every kind of
// drift the spec cares about is reported by name. The trigger cases matter most — they are the
// reason the checker compares registered semantics instead of the two files' text, so weakening
// one side to "remove the divergence" is not a way out. Since spec 02 the checker walks the
// migration ladder (01 修补 7): each migration's pair is checked on its own and anchored to its own
// spec's sql block, and the blocks together are the schema (02 acceptance 11, plan step 8 旧 61).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, SPEC_FILE, SQLITE_FILE, checkTapeSchema } from './check-tape-schema.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(join(repoRoot, file), 'utf8')
const shipped = MIGRATIONS.map((m) => ({
  version: m.version,
  sqliteSql: read(m.sqliteFile),
  postgresSql: read(m.postgresFile),
  specMd: read(m.specFile),
}))
const [first, second] = shipped
const { sqliteSql, postgresSql } = first
const [, MIGRATION_2] = MIGRATIONS

/** Findings with migration 1's sources overridden by `one` and migration 2's by `two`. */
const findings = (one = {}, two = {}) =>
  checkTapeSchema({
    migrations: [
      { ...first, ...one },
      { ...second, ...two },
    ],
  }).findings
/** What the anchor reports when migration 1's SQLite file stops being its spec block. */
const differs = (what, name, detail = '') =>
  `${what} ${name}: ${SQLITE_FILE} differs from the spec's DDL block${detail}`
// The replacement goes through a function: `$$` is a plpgsql body's quoting AND String.replace's
// escape for a literal dollar, and the second meaning would silently mangle the probe.
const edit = (sql, from, to) => {
  expect(sql).toContain(from)
  return sql.replace(from, () => to)
}
const upTo = (sql, marker) => sql.slice(0, sql.indexOf(marker))

/** The pending table's created_at column removed, as a drift both dialects share. */
const dropCreatedAt = (sql) => sql.replace(/\n {2}created_at +\w+ +NOT NULL,/, () => '')

describe('the shipped pair', () => {
  it('is one logical schema in two dialects', () => {
    expect(findings({})).toEqual([])
  })
})

describe('drift in one file only', () => {
  it('names a column whose type stops matching the type map', () => {
    const drifted = edit(sqliteSql, 'source_seq     INTEGER,', 'source_seq     TEXT,')
    expect(findings({ sqliteSql: drifted })).toEqual([
      'column tape_entry.source_seq: sqlite TEXT maps to TEXT, postgres has BIGINT',
      differs('table', 'tape_entry', ' (column source_seq)'),
    ])
  })

  it('names a column that exists on one side only', () => {
    const drifted = edit(
      postgresSql,
      '  order_seq BIGINT NOT NULL,',
      '  order_sequence BIGINT NOT NULL,',
    )
    expect(findings({ postgresSql: drifted })).toEqual([
      'column message_projection.order_seq: in sqlite only',
      'column message_projection.order_sequence: in postgres only',
    ])
  })

  it('names a reordered column list', () => {
    const drifted = edit(
      sqliteSql,
      '  kind           TEXT    NOT NULL,\n  name           TEXT    NOT NULL,',
      '  name           TEXT    NOT NULL,\n  kind           TEXT    NOT NULL,',
    )
    expect(findings({ sqliteSql: drifted })[0]).toMatch(/^table tape_entry: column order differs/)
    expect(findings({ sqliteSql: drifted })).toHaveLength(2)
  })

  it('names an index whose column list changed', () => {
    const drifted = edit(
      sqliteSql,
      'source_type, source_id, entry_id)',
      'source_type, source_id, source_seq)',
    )
    expect(findings({ sqliteSql: drifted })).toEqual([
      'index tape_entry_by_source: sqlite (tenant_id, session_id, source_type, source_id, source_seq)' +
        ' vs postgres (tenant_id, session_id, source_type, source_id, entry_id)',
      differs('index', 'tape_entry_by_source'),
    ])
  })

  it('names a primary key that lost a column', () => {
    const drifted = edit(
      sqliteSql,
      'PRIMARY KEY (tenant_id, session_id, entry_id)',
      'PRIMARY KEY (tenant_id, entry_id)',
    )
    expect(findings({ sqliteSql: drifted })).toEqual([
      'primary key tape_entry: sqlite (tenant_id, entry_id) vs postgres (tenant_id, session_id, entry_id)',
      differs('table', 'tape_entry', ' (primary key)'),
    ])
  })

  it('names a unique constraint that gained a column', () => {
    const drifted = edit(
      postgresSql,
      'UNIQUE (tenant_id, session_id, provenance_key)',
      'UNIQUE (tenant_id, session_id, provenance_key, kind)',
    )
    expect(findings({ postgresSql: drifted })).toEqual([
      'unique constraints tape_entry: sqlite [tenant_id, session_id, provenance_key]' +
        ' vs postgres [tenant_id, session_id, provenance_key, kind]',
    ])
  })

  it('requires STRICT on every SQLite table and on no Postgres table', () => {
    const noStrict = edit(
      sqliteSql,
      'PRIMARY KEY (tenant_id, session_id, projection)\n) STRICT;',
      'PRIMARY KEY (tenant_id, session_id, projection)\n);',
    )
    expect(findings({ sqliteSql: noStrict })).toEqual([
      'table projection_cursor: the SQLite dialect requires STRICT on every table',
      differs('table', 'projection_cursor', ' (STRICT)'),
    ])
    const strict = edit(
      postgresSql,
      'PRIMARY KEY (tenant_id, session_id, projection)\n);',
      'PRIMARY KEY (tenant_id, session_id, projection)\n) STRICT;',
    )
    expect(findings({ postgresSql: strict })).toEqual([
      'table projection_cursor: STRICT is not valid in the Postgres dialect',
    ])
  })
})

describe('triggers are held to the registered semantics', () => {
  it('rejects a SQLite no-update trigger that stops being unconditional', () => {
    const weakened = edit(
      sqliteSql,
      'BEFORE UPDATE ON tape_entry\nBEGIN',
      'BEFORE UPDATE ON tape_entry\nWHEN NEW.entry_id < 0\nBEGIN',
    )
    expect(findings({ sqliteSql: weakened })).toEqual([
      differs('trigger', 'tape_entry_no_update'),
      'trigger tape_entry_no_update (sqlite): registered guard unconditional, file has some other condition',
    ])
  })

  it('rejects a delete gate that stops matching on session_id', () => {
    const weakened = edit(sqliteSql, ' AND m.session_id = OLD.session_id', '')
    expect(findings({ sqliteSql: weakened })).toEqual([
      differs('trigger', 'tape_entry_no_delete'),
      'trigger tape_entry_no_delete (sqlite): registered guard maintenance-gate, file has some other condition',
    ])
  })

  // The gate is matched as a whole condition, not as four substrings that happen to be present:
  // one flipped operator or one extra conjunct is the difference between an append-only tape and a
  // tape any DELETE can empty, and both mutations leave every token of the gate in place.
  it('rejects a SQLite gate whose AND became an OR', () => {
    const weakened = edit(
      sqliteSql,
      'WHERE m.tenant_id = OLD.tenant_id AND m.session_id = OLD.session_id',
      'WHERE m.tenant_id = OLD.tenant_id OR m.session_id = OLD.session_id',
    )
    expect(findings({ sqliteSql: weakened })).toEqual([
      differs('trigger', 'tape_entry_no_delete'),
      'trigger tape_entry_no_delete (sqlite): registered guard maintenance-gate, file has some other condition',
    ])
  })

  it('rejects a SQLite gate with an extra conjunct that turns it off', () => {
    const weakened = edit(
      sqliteSql,
      'm.session_id = OLD.session_id)',
      'm.session_id = OLD.session_id AND 1 = 0)',
    )
    expect(findings({ sqliteSql: weakened })).toEqual([
      differs('trigger', 'tape_entry_no_delete'),
      'trigger tape_entry_no_delete (sqlite): registered guard maintenance-gate, file has some other condition',
    ])
  })

  it('rejects a Postgres gate widened with OR TRUE', () => {
    const weakened = edit(
      postgresSql,
      'm.session_id = OLD.session_id) THEN',
      'm.session_id = OLD.session_id OR TRUE) THEN',
    )
    expect(findings({ postgresSql: weakened })).toEqual([
      'trigger tape_entry_no_delete (postgres): registered guard maintenance-gate, file has some other condition',
    ])
  })

  it('rejects a Postgres trigger function with its two branches swapped', () => {
    const inverted = edit(
      postgresSql,
      "    RAISE EXCEPTION 'tape_entry delete requires an open maintenance gate';\n  END IF;\n  RETURN OLD;",
      "    RETURN OLD;\n  END IF;\n  RAISE EXCEPTION 'tape_entry delete requires an open maintenance gate';",
    )
    expect(findings({ postgresSql: inverted })).toEqual([
      'trigger tape_entry_no_delete (postgres): registered guard maintenance-gate,' +
        ' file has an unregistered function body',
    ])
  })

  it('rejects a Postgres trigger function that returns before reaching the gate', () => {
    const weakened = edit(
      postgresSql,
      'BEGIN\n  IF NOT EXISTS',
      'BEGIN\n  RETURN OLD;\n  IF NOT EXISTS',
    )
    expect(findings({ postgresSql: weakened })).toEqual([
      'trigger tape_entry_no_delete (postgres): registered guard maintenance-gate,' +
        ' file has an unregistered function body',
    ])
  })

  it('rejects a Postgres file whose trigger precedes its function', () => {
    const fn = postgresSql.slice(
      postgresSql.indexOf('CREATE FUNCTION tape_entry_no_delete_fn'),
      postgresSql.indexOf('CREATE TRIGGER tape_entry_no_delete'),
    )
    const reordered = `${postgresSql.replace(fn, () => '')}\n${fn}`
    expect(findings({ postgresSql: reordered })).toEqual([
      'trigger tape_entry_no_delete (postgres): tape_entry_no_delete_fn() is created after the' +
        ' trigger — the file will not execute',
    ])
  })

  it('rejects a Postgres trigger function that stops checking the gate', () => {
    const weakened = edit(
      postgresSql,
      "IF NOT EXISTS (SELECT 1 FROM tape_maintenance m\n                  WHERE m.tenant_id = OLD.tenant_id AND m.session_id = OLD.session_id) THEN\n    RAISE EXCEPTION 'tape_entry delete requires an open maintenance gate';\n  END IF;",
      "RAISE EXCEPTION 'tape_entry delete requires an open maintenance gate';",
    )
    expect(findings({ postgresSql: weakened })).toEqual([
      'trigger tape_entry_no_delete (postgres): registered guard maintenance-gate, file has unconditional',
    ])
  })

  it('rejects a trigger that no longer aborts', () => {
    const weakened = edit(sqliteSql, "RAISE(ABORT, 'tape_entry is append-only')", "'noop'")
    expect(findings({ sqliteSql: weakened })).toEqual([
      differs('trigger', 'tape_entry_no_update'),
      'trigger tape_entry_no_update (sqlite): body must abort the statement with' +
        ' SELECT RAISE(ABORT, …); and nothing else',
    ])
  })

  it('rejects a Postgres trigger that cannot see OLD', () => {
    const weakened = edit(
      postgresSql,
      'FOR EACH ROW EXECUTE FUNCTION tape_entry_no_delete_fn()',
      'EXECUTE FUNCTION tape_entry_no_delete_fn()',
    )
    expect(findings({ postgresSql: weakened })).toEqual([
      'trigger tape_entry_no_delete (postgres): must be FOR EACH ROW — a statement-level trigger cannot see OLD',
    ])
  })
})

describe('clauses no dialect mapping registers', () => {
  it('rejects a partial index on one side', () => {
    const drifted = edit(
      sqliteSql,
      'ON tape_entry (tenant_id, session_id, kind, entry_id);',
      'ON tape_entry (tenant_id, session_id, kind, entry_id) WHERE name IS NOT NULL;',
    )
    expect(findings({ sqliteSql: drifted })).toEqual([
      'index tape_entry_by_kind (sqlite): unregistered clause "WHERE name IS NOT NULL"',
      differs('index', 'tape_entry_by_kind'),
    ])
  })

  it('rejects a Postgres INCLUDE list', () => {
    const drifted = edit(
      postgresSql,
      'ON message_projection (tenant_id, session_id, order_seq);',
      'ON message_projection (tenant_id, session_id, order_seq) INCLUDE (role, status);',
    )
    expect(findings({ postgresSql: drifted })).toEqual([
      'index message_projection_by_order (postgres): unregistered clause "INCLUDE (role, status)"',
    ])
  })

  it('rejects COLLATE on a column of the idempotency key', () => {
    const drifted = edit(
      sqliteSql,
      'provenance_key TEXT    NOT NULL,',
      'provenance_key TEXT    NOT NULL COLLATE NOCASE,',
    )
    expect(findings({ sqliteSql: drifted })).toEqual([
      'column tape_entry.provenance_key (sqlite): unregistered "COLLATE NOCASE"',
      differs('table', 'tape_entry', ' (column provenance_key)'),
    ])
  })

  it('rejects an inline REFERENCES the table-level form would have caught', () => {
    const drifted = edit(
      sqliteSql,
      '  session_id     TEXT    NOT NULL,\n  entry_id',
      '  session_id     TEXT    NOT NULL REFERENCES session_head(session_id),\n  entry_id',
    )
    expect(findings({ sqliteSql: drifted })).toEqual([
      'column tape_entry.session_id (sqlite): unregistered "REFERENCES session_head(session_id)"',
      differs('table', 'tape_entry', ' (column session_id)'),
    ])
  })

  it('rejects NULLS NOT DISTINCT on a UNIQUE constraint', () => {
    const drifted = edit(
      postgresSql,
      'UNIQUE (tenant_id, session_id, provenance_key)',
      'UNIQUE NULLS NOT DISTINCT (tenant_id, session_id, provenance_key)',
    )
    expect(findings({ postgresSql: drifted })).toEqual([
      'table tape_entry (postgres): UNIQUE (tenant_id, session_id, provenance_key) has the' +
        ' unregistered modifier "NULLS NOT DISTINCT"',
    ])
  })
})

describe('the SQLite file is anchored to the spec', () => {
  it('names an object deleted from both files at once', () => {
    const marker = 'CREATE TABLE session_projection'
    expect(
      findings({ sqliteSql: upTo(sqliteSql, marker), postgresSql: upTo(postgresSql, marker) }),
    ).toEqual([
      `table session_projection: in the spec's DDL block but not in ${SQLITE_FILE}`,
      `index session_projection_by_updated: in the spec's DDL block but not in ${SQLITE_FILE}`,
    ])
  })

  it('does not pass vacuously when it parses no tables', () => {
    const triggersOnly = findings({
      sqliteSql: sqliteSql.slice(
        sqliteSql.indexOf('CREATE TRIGGER tape_entry_no_update'),
        sqliteSql.indexOf('CREATE TABLE projection_cursor'),
      ),
      postgresSql: postgresSql.slice(
        postgresSql.indexOf('CREATE FUNCTION tape_entry_no_update_fn'),
        postgresSql.indexOf('CREATE TABLE projection_cursor'),
      ),
    })
    expect(triggersOnly).toContain(
      `table tape_entry: in the spec's DDL block but not in ${SQLITE_FILE}`,
    )
    expect(triggersOnly).toContain(
      `index tape_entry_by_source: in the spec's DDL block but not in ${SQLITE_FILE}`,
    )
  })

  it('fails closed when the spec has no DDL block to anchor against', () => {
    expect(findings({ specMd: '# no sql here\n' })).toEqual([
      `${SPEC_FILE}: no DDL block creating tape_entry — ${SQLITE_FILE} is unanchored`,
    ])
  })

  it('does not report identifier case or whitespace as a divergence', () => {
    expect(
      findings({ postgresSql: edit(postgresSql, 'CHECK (id = 1)', 'CHECK (ID = 1)') }),
    ).toEqual([])
    expect(findings({ postgresSql: postgresSql.toUpperCase() })).toEqual([])
  })
})

describe('constructs the spec keeps out of the schema', () => {
  it('rejects JSONB, which would reorder the keys the hash is taken over', () => {
    const drifted = edit(
      postgresSql,
      'payload_json   TEXT   NOT NULL',
      'payload_json   JSONB  NOT NULL',
    )
    expect(findings({ postgresSql: drifted })).toContain(
      'postgres: JSONB is not allowed in the schema',
    )
  })

  it('rejects AUTOINCREMENT, WITHOUT ROWID and generated columns', () => {
    const auto = edit(
      sqliteSql,
      'version INTEGER NOT NULL PRIMARY KEY',
      'version INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT',
    )
    expect(findings({ sqliteSql: auto })).toContain(
      'sqlite: AUTOINCREMENT is not allowed in the schema',
    )
    const rowid = edit(sqliteSql, ') STRICT;', ') STRICT, WITHOUT ROWID;')
    expect(findings({ sqliteSql: rowid })).toContain(
      'sqlite: WITHOUT ROWID is not allowed in the schema',
    )
    const generated = edit(
      sqliteSql,
      '  hash_ver       INTEGER NOT NULL DEFAULT 1,',
      '  hash_ver       INTEGER NOT NULL DEFAULT 1,\n  name_len       INTEGER AS (length(name)),',
    )
    expect(findings({ sqliteSql: generated })).toContain(
      'sqlite: a generated column is not allowed in the schema',
    )
  })

  it('rejects ON CONFLICT … DO NOTHING together with RETURNING', () => {
    const both = `${sqliteSql}\nINSERT INTO tape_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING RETURNING id;\n`
    expect(findings({ sqliteSql: both })).toContain(
      'sqlite: ON CONFLICT … DO NOTHING and RETURNING in one statement',
    )
  })

  it('refuses to silently ignore a statement it cannot parse', () => {
    const extra = `${sqliteSql}\nCREATE VIEW tape_view AS SELECT 1;\n`
    expect(findings({ sqliteSql: extra })).toEqual([
      'sqlite: statement the checker does not understand — "CREATE VIEW tape_view AS SELECT 1"',
    ])
  })
})

describe('the ladder is anchored by migration number (spec 02 plan step 8, 旧 61)', () => {
  it('pairs every registered migration with its own two files and spec', () => {
    expect(MIGRATIONS.map((m) => [m.version, m.anchorTable])).toEqual([
      [1, 'tape_entry'],
      [2, 'pending_approval_projection'],
    ])
    expect(MIGRATION_2.sqliteFile).toBe('apps/desktop/src/main/tape/sql/tape.sqlite.002.sql')
    expect(MIGRATION_2.postgresFile).toBe('apps/server/sql/tape.postgres.002.sql')
    expect(MIGRATION_2.specFile).toBe('docs/architecture/02-agent-loop/spec.md')
  })

  it('keeps migration 1 byte for byte what spec 01 shipped', async () => {
    // A shipped migration is never edited (sqlite-store.ts MIGRATIONS): a user's file already ran
    // it, and an edit would make two builds disagree about what schema v1 is.
    const { createHash } = await import('node:crypto')
    const digest = (text) => createHash('sha256').update(text).digest('hex')
    expect(digest(first.sqliteSql)).toBe(
      'bfc2de4a9c8e6d24b8ccd5fe62c5470324e2ce54e7d61eba1408fe6499cc37b1',
    )
    expect(digest(first.postgresSql)).toBe(
      '6ee071af1cd6fc4cd93f7f957cbce893e0e16964244af2ace435c19f46309f2a',
    )
  })

  it('names the migration file and the column when both dialects drift from the 02 block together', () => {
    // The two files still agree with each other, so only the anchor can see this.
    const from = "CHECK (wait_kind IN ('approval','question'))"
    const to = "CHECK (wait_kind IN ('approval','question','other'))"
    expect(
      findings(
        {},
        {
          sqliteSql: edit(second.sqliteSql, from, to),
          postgresSql: edit(second.postgresSql, from, to),
        },
      ),
    ).toEqual([
      `table pending_approval_projection: ${MIGRATION_2.sqliteFile} differs from the spec's DDL` +
        ' block (column wait_kind)',
    ])
  })

  it('names a column both 002 files dropped together', () => {
    expect(
      findings(
        {},
        {
          sqliteSql: dropCreatedAt(second.sqliteSql),
          postgresSql: dropCreatedAt(second.postgresSql),
        },
      ),
    ).toEqual([
      `table pending_approval_projection: ${MIGRATION_2.sqliteFile} differs from the spec's DDL` +
        ' block (column created_at is missing)',
    ])
  })

  it('names a table that the 01 and the 02 block both create', () => {
    // Copied into the 02 block AND both 002 files, so the pair and the anchor agree: the union is the
    // only thing left to object, and it names the table.
    const meta =
      'CREATE TABLE tape_meta (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), tenant_id TEXT NOT NULL) STRICT;\n'
    const metaPg =
      'CREATE TABLE tape_meta (id BIGINT NOT NULL PRIMARY KEY CHECK (id = 1), tenant_id TEXT NOT NULL);\n'
    const block = 'CREATE TABLE pending_approval_projection ('
    expect(
      findings(
        {},
        {
          sqliteSql: `${second.sqliteSql}\n${meta}`,
          postgresSql: `${second.postgresSql}\n${metaPg}`,
          specMd: edit(second.specMd, block, `${meta}${block}`),
        },
      ),
    ).toEqual([
      'table tape_meta: created by the DDL blocks of migration 1 and migration 2 — each object' +
        ' belongs to exactly one migration',
    ])
  })

  it('still reports a one-dialect drift in migration 2 by the twin rules (01 acceptance 17)', () => {
    const drifted = edit(
      second.postgresSql,
      'request_seq  BIGINT NOT NULL,',
      'request_sequence BIGINT NOT NULL,',
    )
    expect(findings({}, { postgresSql: drifted })).toEqual([
      'column pending_approval_projection.request_seq: in sqlite only',
      'column pending_approval_projection.request_sequence: in postgres only',
    ])
    const loosened = edit(second.sqliteSql, 'wait_kind    TEXT    NOT NULL', 'wait_kind    TEXT')
    expect(findings({}, { sqliteSql: loosened })).toEqual([
      'column pending_approval_projection.wait_kind: NOT NULL absent in sqlite, set in postgres',
      `table pending_approval_projection: ${MIGRATION_2.sqliteFile} differs from the spec's DDL` +
        ' block (column wait_kind)',
    ])
  })

  it('fails closed when migration 2 is emptied, or its spec block is gone', () => {
    expect(findings({}, { sqliteSql: '', postgresSql: '' })).toEqual([
      `table pending_approval_projection: in the spec's DDL block but not in ${MIGRATION_2.sqliteFile}`,
      `index pending_approval_projection_by_created: in the spec's DDL block but not in ${MIGRATION_2.sqliteFile}`,
    ])
    expect(findings({}, { specMd: '# no sql here\n' })).toEqual([
      `${MIGRATION_2.specFile}: no DDL block creating pending_approval_projection — ` +
        `${MIGRATION_2.sqliteFile} is unanchored`,
    ])
  })

  it('refuses a ladder with a migration missing or unregistered', () => {
    expect(checkTapeSchema({ migrations: [first] }).findings).toEqual([
      'migration 2: no sources were handed to the checker',
    ])
    expect(
      checkTapeSchema({ migrations: [first, second, { ...second, version: 3 }] }).findings,
    ).toEqual(['migration 3: not registered in MIGRATIONS'])
  })
})
