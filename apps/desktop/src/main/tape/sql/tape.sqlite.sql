-- Tape schema v1 — SQLite dialect.
-- Source of truth: docs/architecture/01-provider-and-tape/spec.md, section 「DDL（SQLite 方言）」.
-- The Postgres twin is apps/server/sql/tape.postgres.sql. The two files are one logical schema
-- in two dialects; the only differences allowed are the ones registered in
-- scripts/check-tape-schema.mjs, which runs as part of `pnpm lint`.

CREATE TABLE schema_version (version INTEGER NOT NULL PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;  -- one row per migration; current version = MAX(version)
CREATE TABLE tape_meta (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), tenant_id TEXT NOT NULL) STRICT;  -- exactly one row

CREATE TABLE tape_entry (
  tenant_id      TEXT    NOT NULL,
  session_id     TEXT    NOT NULL,
  entry_id       INTEGER NOT NULL,
  incarnation_id TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  source_type    TEXT    NOT NULL,
  source_id      TEXT,
  source_seq     INTEGER,
  provenance_key TEXT    NOT NULL,
  payload_json   TEXT    NOT NULL,
  meta_json      TEXT    NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  content_hash   BLOB    NOT NULL,
  prev_hash      BLOB,
  entry_hash     BLOB    NOT NULL,
  hash_ver       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, session_id, entry_id),
  UNIQUE (tenant_id, session_id, provenance_key)
) STRICT;

CREATE INDEX tape_entry_by_kind   ON tape_entry (tenant_id, session_id, kind, entry_id);
-- Last column is entry_id, not source_seq: readBySource orders by entry_id, and with source_seq
-- last the planner falls back to the primary key or adds a temp B-tree (measured).
CREATE INDEX tape_entry_by_source ON tape_entry (tenant_id, session_id, source_type, source_id, entry_id);

CREATE TABLE session_head (
  tenant_id      TEXT    NOT NULL,
  session_id     TEXT    NOT NULL,
  incarnation_id TEXT    NOT NULL,
  last_entry_id  INTEGER NOT NULL,   -- high-water mark: only grows, a reset does not lower it
  last_hash      BLOB,               -- chain head of the current incarnation; NULL right after a reset
  entry_count    INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
) STRICT;

CREATE TABLE tape_maintenance (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
  mode TEXT NOT NULL,                -- 'reset' | 'delete'
  opened_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
) STRICT;

CREATE TRIGGER tape_entry_no_update BEFORE UPDATE ON tape_entry
BEGIN SELECT RAISE(ABORT, 'tape_entry is append-only'); END;

CREATE TRIGGER tape_entry_no_delete BEFORE DELETE ON tape_entry
WHEN NOT EXISTS (SELECT 1 FROM tape_maintenance m
                  WHERE m.tenant_id = OLD.tenant_id AND m.session_id = OLD.session_id)
BEGIN SELECT RAISE(ABORT, 'tape_entry delete requires an open maintenance gate'); END;

CREATE TABLE projection_cursor (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, projection TEXT NOT NULL,
  incarnation_id TEXT NOT NULL, last_entry_id INTEGER NOT NULL,
  projection_version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id, projection)
) STRICT;

CREATE TABLE message_projection (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  order_seq INTEGER NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
  content_json TEXT NOT NULL, entry_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id, message_id)
) STRICT;
CREATE INDEX message_projection_by_order ON message_projection (tenant_id, session_id, order_seq);

CREATE TABLE session_projection (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
  title TEXT, provider_id TEXT, model_id TEXT,
  last_message_at INTEGER,
  forked_from_session_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
) STRICT;
CREATE INDEX session_projection_by_updated ON session_projection (tenant_id, updated_at);
