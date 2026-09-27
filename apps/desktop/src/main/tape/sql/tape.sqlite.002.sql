-- Tape schema migration 2 — SQLite dialect.
-- Source of truth: docs/architecture/02-agent-loop/spec.md, 01 修补 7 「待批投影」, the sql block
-- with CREATE TABLE pending_approval_projection. Migration 1 (tape.sqlite.sql) is never edited.
-- The Postgres twin is apps/server/sql/tape.postgres.002.sql; scripts/check-tape-schema.mjs pairs
-- the two by migration number and anchors this file to the spec block, as part of `pnpm lint`.

CREATE TABLE pending_approval_projection (
  tenant_id    TEXT    NOT NULL,
  session_id   TEXT    NOT NULL,
  run_id       TEXT    NOT NULL,
  request_seq  INTEGER NOT NULL,
  call_ordinal INTEGER NOT NULL,  -- which client tool call of that reply (the <i> of the keys)
  wait_kind    TEXT    NOT NULL CHECK (wait_kind IN ('approval','question')), -- an approval or a question (H6)
  entry_id     INTEGER NOT NULL,  -- the tool/permission_decided currently in force
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id, run_id, request_seq, call_ordinal)
) STRICT;
CREATE INDEX pending_approval_projection_by_created ON pending_approval_projection (tenant_id, created_at);
