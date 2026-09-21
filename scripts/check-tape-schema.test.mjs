// Acceptance 17 as a regression test: the shipped pair of dialect files agrees, and every kind of
// drift the spec cares about is reported by name. The trigger cases matter most — they are the
// reason the checker compares registered semantics instead of the two files' text, so weakening
// one side to "remove the divergence" is not a way out.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { POSTGRES_FILE, SPEC_FILE, SQLITE_FILE, checkTapeSchema } from './check-tape-schema.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sqliteSql = readFileSync(join(repoRoot, SQLITE_FILE), 'utf8')
const postgresSql = readFileSync(join(repoRoot, POSTGRES_FILE), 'utf8')
const specMd = readFileSync(join(repoRoot, SPEC_FILE), 'utf8')

const findings = (sources) =>
  checkTapeSchema({ sqliteSql, postgresSql, specMd, ...sources }).findings
// The replacement goes through a function: `$$` is a plpgsql body's quoting AND String.replace's
// escape for a literal dollar, and the second meaning would silently mangle the probe.
const edit = (sql, from, to) => {
  expect(sql).toContain(from)
  return sql.replace(from, () => to)
}
const upTo = (sql, marker) => sql.slice(0, sql.indexOf(marker))

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
      "table tape_entry: differs from the spec's DDL block",
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
      "index tape_entry_by_source: differs from the spec's DDL block",
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
      "table tape_entry: differs from the spec's DDL block",
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
      "table projection_cursor: differs from the spec's DDL block",
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
      'trigger tape_entry_no_update (sqlite): registered guard unconditional, file has some other condition',
      "trigger tape_entry_no_update: differs from the spec's DDL block",
    ])
  })

  it('rejects a delete gate that stops matching on session_id', () => {
    const weakened = edit(sqliteSql, ' AND m.session_id = OLD.session_id', '')
    expect(findings({ sqliteSql: weakened })).toEqual([
      'trigger tape_entry_no_delete (sqlite): registered guard maintenance-gate, file has some other condition',
      "trigger tape_entry_no_delete: differs from the spec's DDL block",
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
      'trigger tape_entry_no_delete (sqlite): registered guard maintenance-gate, file has some other condition',
      "trigger tape_entry_no_delete: differs from the spec's DDL block",
    ])
  })

  it('rejects a SQLite gate with an extra conjunct that turns it off', () => {
    const weakened = edit(
      sqliteSql,
      'm.session_id = OLD.session_id)',
      'm.session_id = OLD.session_id AND 1 = 0)',
    )
    expect(findings({ sqliteSql: weakened })).toEqual([
      'trigger tape_entry_no_delete (sqlite): registered guard maintenance-gate, file has some other condition',
      "trigger tape_entry_no_delete: differs from the spec's DDL block",
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
      'trigger tape_entry_no_update (sqlite): body must abort the statement with' +
        ' SELECT RAISE(ABORT, …); and nothing else',
      "trigger tape_entry_no_update: differs from the spec's DDL block",
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
      "index tape_entry_by_kind: differs from the spec's DDL block",
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
      "table tape_entry: differs from the spec's DDL block",
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
      "table tape_entry: differs from the spec's DDL block",
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
      `${SPEC_FILE}: no DDL block found — the SQLite file is unanchored`,
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
