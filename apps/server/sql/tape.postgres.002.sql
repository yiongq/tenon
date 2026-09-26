-- Tape schema migration 2 — Postgres dialect.
-- THIS FILE IS NOT EXECUTED before phase 6b; it exists so scripts/check-tape-schema.mjs can prove, as
-- part of `pnpm lint`, that migration 2 is portable. Its twin is
-- apps/desktop/src/main/tape/sql/tape.sqlite.002.sql, and the only differences allowed are the ones
-- registered in the checker (no STRICT, INTEGER → BIGINT). Migration 1 (tape.postgres.sql) is never
-- edited.

CREATE TABLE pending_approval_projection (
  tenant_id    TEXT   NOT NULL,
  session_id   TEXT   NOT NULL,
  run_id       TEXT   NOT NULL,
  request_seq  BIGINT NOT NULL,
  call_ordinal BIGINT NOT NULL,  -- which client tool call of that reply (the <i> of the keys)
  wait_kind    TEXT   NOT NULL CHECK (wait_kind IN ('approval','question')), -- an approval or a question (H6)
  entry_id     BIGINT NOT NULL,  -- the tool/permission_decided currently in force
  created_at   BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, session_id, run_id, request_seq, call_ordinal)
);
CREATE INDEX pending_approval_projection_by_created ON pending_approval_projection (tenant_id, created_at);
