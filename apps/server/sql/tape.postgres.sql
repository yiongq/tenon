-- Tape schema v1 — Postgres dialect.
-- THIS FILE IS NOT EXECUTED. It exists only so scripts/check-tape-schema.mjs can prove, as part
-- of `pnpm lint`, that the logical schema is portable; nothing runs it before phase 6b, where the
-- server host gains a real Postgres store (runtime verification and RLS belong to that phase).
-- Its twin is apps/desktop/src/main/tape/sql/tape.sqlite.sql. Keep the two in lockstep: the only
-- differences allowed are the ones registered in the checker (no STRICT, BLOB → BYTEA,
-- INTEGER → BIGINT, and the two triggers expressed as plpgsql functions). payload_json,
-- meta_json and content_json stay TEXT and never become JSONB: JSONB reorders keys and the hash
-- is taken over the stored bytes.

CREATE TABLE schema_version (version BIGINT NOT NULL PRIMARY KEY, applied_at BIGINT NOT NULL);  -- one row per migration; current version = MAX(version)
CREATE TABLE tape_meta (id BIGINT NOT NULL PRIMARY KEY CHECK (id = 1), tenant_id TEXT NOT NULL);  -- exactly one row

CREATE TABLE tape_entry (
  tenant_id      TEXT   NOT NULL,
  session_id     TEXT   NOT NULL,
  entry_id       BIGINT NOT NULL,
  incarnation_id TEXT   NOT NULL,
  kind           TEXT   NOT NULL,
  name           TEXT   NOT NULL,
  source_type    TEXT   NOT NULL,
  source_id      TEXT,
  source_seq     BIGINT,
  provenance_key TEXT   NOT NULL,
  payload_json   TEXT   NOT NULL,
  meta_json      TEXT   NOT NULL DEFAULT '{}',
  created_at     BIGINT NOT NULL,
  content_hash   BYTEA  NOT NULL,
  prev_hash      BYTEA,
  entry_hash     BYTEA  NOT NULL,
  hash_ver       BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, session_id, entry_id),
  UNIQUE (tenant_id, session_id, provenance_key)
);

CREATE INDEX tape_entry_by_kind   ON tape_entry (tenant_id, session_id, kind, entry_id);
-- Last column is entry_id, not source_seq: readBySource orders by entry_id, and with source_seq
-- last the planner falls back to the primary key or adds a temp B-tree (measured).
CREATE INDEX tape_entry_by_source ON tape_entry (tenant_id, session_id, source_type, source_id, entry_id);

CREATE TABLE session_head (
  tenant_id      TEXT   NOT NULL,
  session_id     TEXT   NOT NULL,
  incarnation_id TEXT   NOT NULL,
  last_entry_id  BIGINT NOT NULL,   -- high-water mark: only grows, a reset does not lower it
  last_hash      BYTEA,             -- chain head of the current incarnation; NULL right after a reset
  entry_count    BIGINT NOT NULL,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
);

CREATE TABLE tape_maintenance (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
  mode TEXT NOT NULL,                -- 'reset' | 'delete'
  opened_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
);

-- A Postgres trigger's WHEN clause may not contain a subquery, so the maintenance gate moves into
-- the function body. Same semantics as the SQLite pair: UPDATE always aborts, DELETE aborts unless
-- tape_maintenance holds a row for the SAME (tenant_id, session_id) as the row being deleted.
CREATE FUNCTION tape_entry_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tape_entry is append-only';
END;
$$;

CREATE TRIGGER tape_entry_no_update BEFORE UPDATE ON tape_entry
FOR EACH ROW EXECUTE FUNCTION tape_entry_no_update_fn();

CREATE FUNCTION tape_entry_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tape_maintenance m
                  WHERE m.tenant_id = OLD.tenant_id AND m.session_id = OLD.session_id) THEN
    RAISE EXCEPTION 'tape_entry delete requires an open maintenance gate';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER tape_entry_no_delete BEFORE DELETE ON tape_entry
FOR EACH ROW EXECUTE FUNCTION tape_entry_no_delete_fn();

CREATE TABLE projection_cursor (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, projection TEXT NOT NULL,
  incarnation_id TEXT NOT NULL, last_entry_id BIGINT NOT NULL,
  projection_version BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, session_id, projection)
);

CREATE TABLE message_projection (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  order_seq BIGINT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
  content_json TEXT NOT NULL, entry_id BIGINT NOT NULL,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, session_id, message_id)
);
CREATE INDEX message_projection_by_order ON message_projection (tenant_id, session_id, order_seq);

CREATE TABLE session_projection (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
  title TEXT, provider_id TEXT, model_id TEXT,
  last_message_at BIGINT,
  forked_from_session_id TEXT,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
);
CREATE INDEX session_projection_by_updated ON session_projection (tenant_id, updated_at);
