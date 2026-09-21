#!/usr/bin/env node
// pnpm tape:check — spec 01 R4「一套逻辑 schema、两份方言文件」(acceptance 17). Parses both DDL
// files and asserts they are the same logical schema: table names, column names and order,
// NOT NULL / DEFAULT / CHECK, primary keys, unique constraints and index definitions must be
// identical outside the dialect mapping table registered below. Triggers are compared against
// their REGISTERED SEMANTICS rather than each other's text, so weakening the SQLite side to
// "remove the divergence" fails too. Also rejects the constructs the spec bans from the schema.
// The SQLite file is anchored to the spec's own DDL block as well, so the two files cannot drift
// from the spec together — or shrink to nothing — with the twin comparison still green.
// Usage: node scripts/check-tape-schema.mjs [sqliteFile] [postgresFile] [specFile]
// Exit: 0 ok · 1 divergence or forbidden construct · 2 unreadable file.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SQLITE_FILE = 'apps/desktop/src/main/tape/sql/tape.sqlite.sql'
export const POSTGRES_FILE = 'apps/server/sql/tape.postgres.sql'
export const SPEC_FILE = 'docs/architecture/01-provider-and-tape/spec.md'

// ─── the dialect mapping table ────────────────────────────────────────────────
// Every difference the two files are allowed to have is registered here. Nothing else.

/** Logical column type → the spelling each dialect must use. */
export const TYPE_MAP = {
  int: { sqlite: 'INTEGER', postgres: 'BIGINT' }, // ids, timestamps, counters, versions
  text: { sqlite: 'TEXT', postgres: 'TEXT' }, // payload_json / meta_json / content_json included
  bytes: { sqlite: 'BLOB', postgres: 'BYTEA' },
}

/** `STRICT` is mandatory on every SQLite table and is not valid Postgres. */
export const STRICT_BY_DIALECT = { sqlite: true, postgres: false }

/**
 * Registered trigger semantics: which table, which event, and whether the abort is unconditional
 * or gated on a tape_maintenance row for the SAME (tenant_id, session_id). Both dialects are
 * checked against this table, so nobody may drop the SQLite gate to match a weakened Postgres
 * function — or the other way round.
 */
export const TRIGGERS = {
  tape_entry_no_update: { table: 'tape_entry', event: 'UPDATE', guard: 'unconditional' },
  tape_entry_no_delete: { table: 'tape_entry', event: 'DELETE', guard: 'maintenance-gate' },
}

/**
 * The registered trigger shapes, over the token stream `canon` produces. A guard counts as the
 * maintenance gate only when the WHOLE condition matches — not when a few substrings appear
 * somewhere inside it — so `AND` → `OR`, an extra `OR TRUE`, a trailing `AND 1 = 0`, swapped
 * branches or a `RETURN OLD` smuggled in front of the gate are divergences and not passes. The
 * subquery's alias is free (it is a name, not semantics); everything else is fixed.
 */
export const SHAPES = {
  gate: /^not exists \( select 1 from tape_maintenance (\w+) where \1 \. tenant_id = old \. tenant_id and \1 \. session_id = old \. session_id \)$/,
  sqliteAbort: /^select raise \( abort , '[^']*' \) ;$/,
  plpgsqlAbort: /^begin raise exception '[^']*' ; (?:return old ; )?end ;$/,
  plpgsqlGated: /^begin if (.+) then raise exception '[^']*' ; end if ; return old ; end ;$/,
}

/** Constructs the spec keeps out of the schema entirely (both dialects). */
export const FORBIDDEN = [
  { what: 'AUTOINCREMENT', re: /\bAUTOINCREMENT\b/i },
  { what: 'WITHOUT ROWID', re: /\bWITHOUT\s+ROWID\b/i },
  { what: 'INSERT OR IGNORE', re: /\bINSERT\s+OR\s+IGNORE\b/i },
  { what: 'json_extract(', re: /\bjson_extract\s*\(/i },
  { what: 'a generated column', re: /\bGENERATED\s+ALWAYS\s+AS\b|\bAS\s*\(/i },
  { what: 'JSONB', re: /\bJSONB\b/i },
]

// ─── lexing ───────────────────────────────────────────────────────────────────

const norm = (s) => s.replace(/\s+/g, ' ').trim()
const countWord = (s, word) => (s.match(new RegExp(`\\b${word}\\b`, 'gi')) ?? []).length

/**
 * Case-folded token stream: identifiers and keywords are lowercased and punctuation is split off,
 * because SQL does not care about their case or spacing — but single-quoted strings keep their
 * bytes, because a literal's case IS meaningful. Two texts with the same stream are the same SQL,
 * which is what makes shape matching and expression comparison safe.
 */
export function tokens(sql) {
  const out = []
  for (let i = 0; i < sql.length;) {
    if (/\s/.test(sql[i])) {
      i++
      continue
    }
    if (sql[i] === "'") {
      const end = endOfString(sql, i)
      out.push(sql.slice(i, end))
      i = end
      continue
    }
    const word = /^([A-Za-z_]\w*|\d+)/.exec(sql.slice(i))
    if (word) {
      out.push(word[1].toLowerCase())
      i += word[1].length
      continue
    }
    out.push(sql[i])
    i++
  }
  return out
}

/** The token stream as one comparable string. */
export const canon = (sql) => tokens(sql).join(' ')
const canonOrNull = (sql) => (sql === null ? null : canon(sql))

/** Index of the `)` closing the `(` at openIndex, skipping quoted text. */
export function closingParen(text, openIndex) {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "'") {
      i = endOfString(text, i) - 1
      continue
    }
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }
  return -1
}

/** Index just past the single-quoted string starting at i ('' is an escaped quote). */
function endOfString(text, i) {
  let j = i + 1
  while (j < text.length) {
    if (text[j] === "'" && text[j + 1] === "'") j += 2
    else if (text[j] === "'") return j + 1
    else j++
  }
  return text.length
}

/**
 * Splits a file into statements, dropping comments. `text` keeps string literals and plpgsql
 * bodies; `code` blanks them out so keyword scanning never trips over their contents.
 */
export function statementsOf(sql) {
  const out = []
  let text = ''
  let code = ''
  const push = () => {
    const t = text.replace(/;\s*$/, '').trim()
    if (t) out.push({ text: t, code: code.replace(/;\s*$/, '').trim() })
    text = ''
    code = ''
  }
  for (let i = 0; i < sql.length;) {
    const two = sql.slice(i, i + 2)
    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }
    if (sql[i] === "'") {
      const end = endOfString(sql, i)
      text += sql.slice(i, end)
      code += "''"
      i = end
      continue
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
    if (dollar) {
      const tag = dollar[0]
      const close = sql.indexOf(tag, i + tag.length)
      const end = close === -1 ? sql.length : close + tag.length
      text += sql.slice(i, end)
      code += tag + tag
      i = end
      continue
    }
    text += sql[i]
    code += sql[i]
    i++
    // A `;` inside a SQLite trigger body (BEGIN … END) is not a statement terminator.
    if (text.at(-1) !== ';') continue
    const inTriggerBody =
      /^\s*CREATE\s+TRIGGER\b/i.test(code) && countWord(code, 'BEGIN') > countWord(code, 'END')
    if (!inTriggerBody) push()
  }
  push()
  return out
}

/** Splits a parenthesised list body on top-level commas. */
function splitItems(body) {
  const items = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "'") {
      i = endOfString(body, i) - 1
      continue
    }
    if (body[i] === '(') depth++
    else if (body[i] === ')') depth--
    else if (body[i] === ',' && depth === 0) {
      items.push(body.slice(start, i))
      start = i + 1
    }
  }
  items.push(body.slice(start))
  return items.map(norm).filter(Boolean)
}

const columnList = (body) => splitItems(body).map((c) => c.toLowerCase())

function bracketed(text, keywordRe) {
  const m = keywordRe.exec(text)
  if (!m) return null
  const open = text.indexOf('(', m.index)
  if (open === -1) return null
  const close = closingParen(text, open)
  return close === -1 ? null : norm(text.slice(open, close + 1))
}

/** Removes a paren-aware `KEYWORD ( … )` clause, so what is left is the unrecognised remainder. */
function stripBracketed(text, keywordRe) {
  const m = keywordRe.exec(text)
  if (!m) return text
  const open = text.indexOf('(', m.index)
  if (open === -1) return text
  const close = closingParen(text, open)
  return close === -1 ? text : `${text.slice(0, m.index)} ${text.slice(close + 1)}`
}

/**
 * What is left of a column definition once the clauses this checker understands are removed.
 * Anything here is a modifier the dialect mapping table does not register — COLLATE, an inline
 * REFERENCES, a storage clause — and is reported instead of being silently dropped.
 */
function residualOf(rest) {
  let r = stripBracketed(rest, /\bCHECK\s*(?=\()/i)
  r = stripBracketed(r, /\bDEFAULT\s*(?=\()/i)
  r = r.replace(/\bDEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i, ' ')
  r = r.replace(/\bNOT\s+NULL\b/i, ' ')
  r = r.replace(/\bPRIMARY\s+KEY\b/i, ' ')
  r = r.replace(/\bUNIQUE\b/i, ' ')
  return norm(r)
}

function defaultOf(rest) {
  const m = /\bDEFAULT\s+/i.exec(rest)
  if (!m) return null
  const i = m.index + m[0].length
  if (rest[i] === "'") return rest.slice(i, endOfString(rest, i))
  if (rest[i] === '(') return bracketed(rest.slice(i - 8), /\bDEFAULT\s*/i)
  return /^[^\s,]+/.exec(rest.slice(i))?.[0].toUpperCase() ?? null
}

// ─── parsing ──────────────────────────────────────────────────────────────────

const CONSTRAINT = /^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i

function parseTable(text) {
  const head = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)\s*\(/i.exec(text)
  if (!head) return null
  const open = text.indexOf('(', head[0].length - 1)
  const close = closingParen(text, open)
  if (close === -1) return null
  const table = {
    name: head[1].toLowerCase(),
    strict: /\bSTRICT\b/i.test(text.slice(close + 1)),
    columns: [],
    primaryKey: [],
    uniques: [],
    checks: [],
    residuals: [],
    sql: canon(text),
  }
  const inlinePk = []
  for (const item of splitItems(text.slice(open + 1, close))) {
    if (CONSTRAINT.test(item)) {
      const key = /^(PRIMARY\s+KEY|UNIQUE)\b/i.exec(item)
      if (key) {
        const list = columnList(unwrap(item))
        // Words between the keyword and the column list — `UNIQUE NULLS NOT DISTINCT (…)` — change
        // the constraint's meaning, so they may not disappear into the column list.
        const modifier = norm(item.slice(key[0].length, Math.max(item.indexOf('('), key[0].length)))
        if (modifier) {
          const what = norm(key[0]).toUpperCase()
          table.residuals.push(
            `${what} (${cols(list)}) has the unregistered modifier "${modifier}"`,
          )
        }
        if (/^PRIMARY/i.test(key[0])) table.primaryKey = list
        else table.uniques.push(list)
        continue
      }
      if (/^CHECK\b/i.test(item)) table.checks.push(bracketed(item, /\bCHECK\s*/i) ?? item)
      else table.checks.push(norm(item)) // FOREIGN KEY / named constraint: compared verbatim
      continue
    }
    const col = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\b([\s\S]*)$/.exec(item)
    if (!col) return null
    const rest = col[3]
    const column = {
      name: col[1].toLowerCase(),
      type: col[2].toUpperCase(),
      notNull: /\bNOT\s+NULL\b/i.test(rest),
      default: defaultOf(rest),
      check: bracketed(rest, /\bCHECK\s*/i),
      unique: /\bUNIQUE\b/i.test(rest),
      generated: /\bGENERATED\b/i.test(rest) || /\bAS\s*\(/i.test(rest),
      residual: residualOf(rest),
    }
    if (/\bPRIMARY\s+KEY\b/i.test(rest)) inlinePk.push(column.name)
    if (column.unique) table.uniques.push([column.name])
    table.columns.push(column)
  }
  if (table.primaryKey.length === 0) table.primaryKey = inlinePk
  return table
}

const unwrap = (item) => {
  const inner = bracketed(item, /^\w+(\s+\w+)?\s*/i)
  return inner ? inner.slice(1, -1) : ''
}

function parseIndex(text) {
  const m =
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)\s+ON\s+([A-Za-z_]\w*)\s*\(/i.exec(
      text,
    )
  if (!m) return null
  const open = text.indexOf('(', m[0].length - 1)
  const close = closingParen(text, open)
  if (close === -1) return null
  return {
    name: m[2].toLowerCase(),
    unique: Boolean(m[1]),
    table: m[3].toLowerCase(),
    columns: columnList(text.slice(open + 1, close)),
    // Whatever follows the column list — `WHERE …` (a partial index), `INCLUDE (…)`, `NULLS NOT
    // DISTINCT` — changes which rows the index covers. Nothing there is registered, so it is kept
    // and reported rather than discarded.
    tail: norm(text.slice(close + 1)),
    sql: canon(text),
  }
}

function parseTrigger(text) {
  const m =
    /^CREATE\s+TRIGGER\s+([A-Za-z_]\w*)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)\s+ON\s+([A-Za-z_]\w*)\b/i.exec(
      text,
    )
  if (!m) return null
  const trigger = {
    name: m[1].toLowerCase(),
    timing: norm(m[2]).toUpperCase(),
    event: m[3].toUpperCase(),
    table: m[4].toLowerCase(),
    when: /\bWHEN\b([\s\S]*?)\bBEGIN\b/i.exec(text)?.[1] ?? null,
    body: /\bBEGIN\b([\s\S]*)\bEND\b/i.exec(text)?.[1] ?? null,
    forEachRow: /\bFOR\s+EACH\s+ROW\b/i.test(text),
    calls: /\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([A-Za-z_]\w*)\s*\(/i.exec(text)?.[1] ?? null,
    sql: canon(text),
  }
  return trigger
}

function parseFunction(text) {
  const m = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_]\w*)\s*\(/i.exec(text)
  if (!m) return null
  const body = /\$([A-Za-z_]*)\$([\s\S]*)\$\1\$/.exec(text)
  return { name: m[1], body: body?.[2] ?? '' }
}

/** Parses one dialect file into tables / indexes / triggers / functions. */
export function parseSchema(sql, dialect) {
  const schema = {
    dialect,
    tables: new Map(),
    indexes: new Map(),
    triggers: new Map(),
    functions: new Map(),
    unparsed: [],
  }
  let at = 0
  for (const st of statementsOf(sql)) {
    const order = at++
    const table = parseTable(st.text)
    if (table) {
      schema.tables.set(table.name, table)
      continue
    }
    const index = parseIndex(st.text)
    if (index) {
      schema.indexes.set(index.name, index)
      continue
    }
    const trigger = parseTrigger(st.text)
    if (trigger) {
      schema.triggers.set(trigger.name, { ...trigger, order })
      continue
    }
    const fn = parseFunction(st.text)
    if (fn) {
      schema.functions.set(fn.name, { ...fn, order })
      continue
    }
    schema.unparsed.push(norm(st.text).slice(0, 80))
  }
  return schema
}

// ─── comparison ───────────────────────────────────────────────────────────────

const names = (a, b) => [...new Set([...a.keys(), ...b.keys()])].toSorted()
const show = (v) => (v === null ? 'none' : v)
const cols = (list) => (list.length === 0 ? 'none' : list.join(', '))
const sets = (list) => list.map((c) => c.join(', ')).toSorted()

function logicalType(type, dialect) {
  return Object.keys(TYPE_MAP).find((k) => TYPE_MAP[k][dialect] === type) ?? null
}

function compareColumn(table, s, p) {
  const out = []
  const at = `column ${table}.${s.name}`
  const logical = logicalType(s.type, 'sqlite')
  const other = logicalType(p.type, 'postgres')
  if (!logical) out.push(`${at}: sqlite type ${s.type} is not in the dialect type map`)
  if (!other) out.push(`${at}: postgres type ${p.type} is not in the dialect type map`)
  if (logical && other && logical !== other) {
    out.push(
      `${at}: sqlite ${s.type} maps to ${TYPE_MAP[logical].postgres}, postgres has ${p.type}`,
    )
  }
  if (s.notNull !== p.notNull) {
    out.push(
      `${at}: NOT NULL ${s.notNull ? 'set in sqlite, absent' : 'absent in sqlite, set'} in postgres`,
    )
  }
  if (s.default !== p.default) {
    out.push(`${at}: DEFAULT ${show(s.default)} in sqlite, ${show(p.default)} in postgres`)
  }
  if (canonOrNull(s.check) !== canonOrNull(p.check)) {
    out.push(`${at}: CHECK ${show(s.check)} in sqlite, ${show(p.check)} in postgres`)
  }
  if (s.generated || p.generated) out.push(`${at}: generated columns are not allowed`)
  return out
}

function compareTable(name, s, p) {
  const out = []
  if (s.strict !== STRICT_BY_DIALECT.sqlite) {
    out.push(`table ${name}: the SQLite dialect requires STRICT on every table`)
  }
  if (p.strict !== STRICT_BY_DIALECT.postgres) {
    out.push(`table ${name}: STRICT is not valid in the Postgres dialect`)
  }
  const sc = s.columns.map((c) => c.name)
  const pc = p.columns.map((c) => c.name)
  for (const c of sc) {
    if (!pc.includes(c)) out.push(`column ${name}.${c}: in sqlite only`)
  }
  for (const c of pc) {
    if (!sc.includes(c)) out.push(`column ${name}.${c}: in postgres only`)
  }
  if (sc.join() !== pc.join() && sc.toSorted().join() === pc.toSorted().join()) {
    out.push(`table ${name}: column order differs — sqlite (${cols(sc)}) vs postgres (${cols(pc)})`)
  }
  for (const col of s.columns) {
    const twin = p.columns.find((c) => c.name === col.name)
    if (twin) out.push(...compareColumn(name, col, twin))
  }
  if (s.primaryKey.join() !== p.primaryKey.join()) {
    out.push(
      `primary key ${name}: sqlite (${cols(s.primaryKey)}) vs postgres (${cols(p.primaryKey)})`,
    )
  }
  if (sets(s.uniques).join(' | ') !== sets(p.uniques).join(' | ')) {
    out.push(
      `unique constraints ${name}: sqlite [${sets(s.uniques).join(' | ')}] vs postgres [${sets(p.uniques).join(' | ')}]`,
    )
  }
  if (s.checks.map(canon).toSorted().join(' | ') !== p.checks.map(canon).toSorted().join(' | ')) {
    out.push(
      `table constraints ${name}: sqlite [${s.checks.toSorted().join(' | ')}] vs postgres [${p.checks.toSorted().join(' | ')}]`,
    )
  }
  return out
}

function compareIndex(name, s, p) {
  const out = []
  if (s.table !== p.table)
    out.push(`index ${name}: on ${s.table} in sqlite, on ${p.table} in postgres`)
  if (s.columns.join() !== p.columns.join()) {
    out.push(`index ${name}: sqlite (${cols(s.columns)}) vs postgres (${cols(p.columns)})`)
  }
  if (s.unique !== p.unique) {
    out.push(`index ${name}: UNIQUE ${s.unique ? 'in sqlite only' : 'in postgres only'}`)
  }
  return out
}

/**
 * The registered gate: a tape_maintenance row for the row's OWN (tenant_id, session_id), and
 * nothing else. The whole condition has to match, so a widened or inverted gate is not a gate.
 */
const isMaintenanceGate = (condition) => SHAPES.gate.test(canon(condition))

/**
 * Reduces a parsed trigger to the semantics the registry speaks: the guard, and whether the
 * statement is aborted. Both dialects are matched against a registered shape as a whole — a body
 * the shapes do not cover is reported as unregistered rather than interpreted, because an extra
 * statement before the gate (`RETURN OLD;`) or swapped branches leave the gate unreachable while
 * every individual token still looks right.
 */
export function triggerSemantics(trigger, schema) {
  if (schema.dialect === 'sqlite') {
    const guard =
      trigger.when === null
        ? 'unconditional'
        : isMaintenanceGate(trigger.when)
          ? 'maintenance-gate'
          : 'some other condition'
    return { guard, aborts: SHAPES.sqliteAbort.test(canon(trigger.body ?? '')) }
  }
  const fn = trigger.calls === null ? null : schema.functions.get(trigger.calls)
  if (!fn) return { guard: 'no trigger function', aborts: false }
  const body = canon(fn.body)
  if (SHAPES.plpgsqlAbort.test(body)) return { guard: 'unconditional', aborts: true }
  const gated = SHAPES.plpgsqlGated.exec(body)
  if (gated) {
    const guard = isMaintenanceGate(gated[1]) ? 'maintenance-gate' : 'some other condition'
    return { guard, aborts: true }
  }
  return { guard: 'an unregistered function body', aborts: /\braise exception\b/.test(body) }
}

/** Every trigger in a file is checked against the registered semantics, not against the twin. */
export function checkTriggers(schema) {
  const out = []
  const registry = new Map(Object.entries(TRIGGERS))
  for (const name of names(registry, schema.triggers)) {
    const want = registry.get(name)
    const got = schema.triggers.get(name)
    if (!want) {
      out.push(`trigger ${name} (${schema.dialect}): not registered in check-tape-schema.mjs`)
      continue
    }
    if (!got) {
      out.push(
        `trigger ${name} (${schema.dialect}): missing — registered as BEFORE ${want.event} on ${want.table}, guard ${want.guard}`,
      )
      continue
    }
    const at = `trigger ${name} (${schema.dialect})`
    if (got.timing !== 'BEFORE') out.push(`${at}: must be BEFORE, file has ${got.timing}`)
    if (got.event !== want.event) out.push(`${at}: registered ${want.event}, file has ${got.event}`)
    if (got.table !== want.table)
      out.push(`${at}: registered on ${want.table}, file has ${got.table}`)
    if (schema.dialect === 'postgres' && !got.forEachRow) {
      out.push(`${at}: must be FOR EACH ROW — a statement-level trigger cannot see OLD`)
    }
    // A trigger whose function is created later in the file is a file PostgreSQL cannot execute,
    // and this static proof is all phase 1 has — CI does not run Postgres.
    const fn = schema.dialect === 'postgres' ? schema.functions.get(got.calls) : null
    if (fn && fn.order > got.order) {
      out.push(`${at}: ${got.calls}() is created after the trigger — the file will not execute`)
    }
    const { guard, aborts } = triggerSemantics(got, schema)
    if (!aborts) {
      const how = schema.dialect === 'sqlite' ? 'SELECT RAISE(ABORT, …);' : "RAISE EXCEPTION '…';"
      out.push(`${at}: body must abort the statement with ${how} and nothing else`)
    }
    if (guard !== want.guard) out.push(`${at}: registered guard ${want.guard}, file has ${guard}`)
  }
  return out
}

/**
 * Everything the parser saw but the dialect mapping table does not register: a column modifier,
 * a constraint modifier, an index clause. The checker is fail-closed about these the same way it
 * is about a whole statement it cannot parse — an unregistered clause is a divergence waiting to
 * happen, on one side or on both.
 */
export function checkUnregistered(schema) {
  const out = []
  for (const table of schema.tables.values()) {
    for (const c of table.columns) {
      if (c.residual) {
        out.push(`column ${table.name}.${c.name} (${schema.dialect}): unregistered "${c.residual}"`)
      }
    }
    for (const r of table.residuals) out.push(`table ${table.name} (${schema.dialect}): ${r}`)
  }
  for (const index of schema.indexes.values()) {
    if (index.tail) {
      out.push(`index ${index.name} (${schema.dialect}): unregistered clause "${index.tail}"`)
    }
  }
  return out
}

/** The spec's DDL block: the one ```sql fence that defines the tape tables. */
export function specDdl(md) {
  const fences = [...md.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map((m) => m[1])
  return fences.find((f) => /\bCREATE\s+TABLE\s+tape_entry\b/i.test(f)) ?? null
}

const KINDS = { tables: 'table', indexes: 'index', triggers: 'trigger' }

/**
 * The SQLite file is the spec's DDL block, statement for statement (modulo comments, whitespace
 * and keyword case). Without this anchor the two dialect files could drift from the spec together
 * — or shrink to nothing at all — with the twin comparison still reporting agreement.
 */
export function checkAgainstSpec(specSql, sqlite) {
  const spec = parseSchema(specSql, 'sqlite')
  const out = spec.unparsed.map(
    (st) => `spec DDL block: statement the checker does not understand — "${st}"`,
  )
  if (spec.tables.size === 0) out.push('spec DDL block: no CREATE TABLE parsed out of it')
  for (const [kind, what] of Object.entries(KINDS)) {
    for (const name of names(spec[kind], sqlite[kind])) {
      const want = spec[kind].get(name)
      const got = sqlite[kind].get(name)
      if (!want) out.push(`${what} ${name}: not in the spec's DDL block`)
      else if (!got) out.push(`${what} ${name}: in the spec's DDL block but not in ${SQLITE_FILE}`)
      else if (want.sql !== got.sql) out.push(`${what} ${name}: differs from the spec's DDL block`)
    }
  }
  return out
}

/** Constructs banned from the schema, wherever they appear. */
export function checkForbidden(sql, dialect) {
  const out = []
  for (const st of statementsOf(sql)) {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(st.text)) out.push(`${dialect}: ${rule.what} is not allowed in the schema`)
    }
    const doNothing = /\bON\s+CONFLICT\b[\s\S]*\bDO\s+NOTHING\b/i.test(st.text)
    if (doNothing && /\bRETURNING\b/i.test(st.text)) {
      out.push(`${dialect}: ON CONFLICT … DO NOTHING and RETURNING in one statement`)
    }
  }
  return out
}

/**
 * All findings for a pair of dialect sources plus the spec markdown that governs them. Empty
 * array = the two files are one logical schema and the SQLite one is still the spec's DDL.
 */
export function checkTapeSchema({ sqliteSql, postgresSql, specMd }) {
  const sqlite = parseSchema(sqliteSql, 'sqlite')
  const postgres = parseSchema(postgresSql, 'postgres')
  const out = []
  for (const schema of [sqlite, postgres]) {
    for (const st of schema.unparsed) {
      out.push(`${schema.dialect}: statement the checker does not understand — "${st}"`)
    }
    out.push(...checkUnregistered(schema))
  }
  out.push(...checkForbidden(sqliteSql, 'sqlite'), ...checkForbidden(postgresSql, 'postgres'))
  for (const name of names(sqlite.tables, postgres.tables)) {
    const s = sqlite.tables.get(name)
    const p = postgres.tables.get(name)
    if (!s) out.push(`table ${name}: in postgres only`)
    else if (!p) out.push(`table ${name}: in sqlite only`)
    else out.push(...compareTable(name, s, p))
  }
  for (const name of names(sqlite.indexes, postgres.indexes)) {
    const s = sqlite.indexes.get(name)
    const p = postgres.indexes.get(name)
    if (!s) out.push(`index ${name}: in postgres only`)
    else if (!p) out.push(`index ${name}: in sqlite only`)
    else out.push(...compareIndex(name, s, p))
  }
  out.push(...checkTriggers(sqlite), ...checkTriggers(postgres))
  const specSql = specDdl(specMd ?? '')
  if (specSql === null) out.push(`${SPEC_FILE}: no DDL block found — the SQLite file is unanchored`)
  else out.push(...checkAgainstSpec(specSql, sqlite))
  return { findings: out, sqlite, postgres }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'))
  const sqliteFile = args[0] ?? SQLITE_FILE
  const postgresFile = args[1] ?? POSTGRES_FILE
  const specFile = args[2] ?? SPEC_FILE
  let sources
  try {
    sources = {
      sqliteSql: readFileSync(sqliteFile, 'utf8'),
      postgresSql: readFileSync(postgresFile, 'utf8'),
      specMd: readFileSync(specFile, 'utf8'),
    }
  } catch (e) {
    console.error(`tape:check: ${e.message}`)
    process.exit(2)
  }
  const { findings, sqlite } = checkTapeSchema(sources)
  if (findings.length > 0) {
    console.error(`tape:check FAILED — ${findings.length} divergence(s) across the two dialects`)
    for (const f of findings) console.error(`  ${f}`)
    process.exit(1)
  }
  console.log(
    `tape:check OK — ${sqlite.tables.size} tables, ${sqlite.indexes.size} indexes and ` +
      `${sqlite.triggers.size} triggers agree in ${sqliteFile} and ${postgresFile}`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
