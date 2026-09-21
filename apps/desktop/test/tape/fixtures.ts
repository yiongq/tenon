/**
 * Fixtures for the SQLite store's own tests — the half the shared conformance suite cannot reach,
 * because proving it needs a second connection, a raw statement or the file itself.
 *
 * Nothing here is a second implementation of the store: facts are built with the kernel's own slice
 * writers and provenance builders, so a test cannot assemble a fact the store would be right to refuse.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostIdentity, NewEntry, ProjectionReducer, TapeStore } from '@tenon-app/kernel'
import {
  createEntryWriter,
  messageRetractedKey,
  messageRevisionKey,
  modelSelectedKey,
  sessionStartKey,
} from '@tenon-app/kernel'
import { createCounterIds } from '@tenon-app/kernel/testing'
import Database from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { SESSIONS_DB_FILE, createSqliteTapeStore } from '../../src/main/tape/sqlite-store.js'

const roots: string[] = []

/** A profile directory of its own per call: one `sessions.db` per profile is the isolation boundary. */
export function tempProfileDir(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `tenon-${label}-`))
  roots.push(root)
  return root
}

/** Vitest isolates modules per file, so this clears exactly the directories this file created. */
export function removeTempProfiles(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export function dbFile(profileDir: string): string {
  return join(profileDir, SESSIONS_DB_FILE)
}

export function identityFor(profileDir: string, tenantId = 'tenant-a'): HostIdentity {
  return { userId: 'u', tenantId, profileDir }
}

export interface OpenedStore {
  readonly store: TapeStore
  readonly profileDir: string
  readonly file: string
  readonly identity: HostIdentity
}

export function openStore(options: {
  readonly label: string
  readonly profileDir?: string
  readonly tenantId?: string
  readonly busyTimeoutMs?: number
  readonly project?: ProjectionReducer
}): OpenedStore {
  const profileDir = options.profileDir ?? tempProfileDir(options.label)
  const identity = identityFor(profileDir, options.tenantId)
  const store = createSqliteTapeStore({
    identity,
    // A fixed clock for the two timestamps that are not data on a fact, so a test can compare files
    // byte for byte across two opens.
    now: () => 1_700_000_000_000,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    ...(options.project === undefined ? {} : { project: options.project }),
  })
  return { store, profileDir, identity, file: dbFile(profileDir) }
}

/**
 * A second connection onto the same file, as a test-only privileged writer: the spec is explicit that
 * the append-only triggers stop program bugs, not someone with DDL rights (§哈希链, "诚实的边界").
 * Acceptance 9 and 12 need exactly that writer.
 */
export function rawConnection(file: string): SqliteDatabase {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 250')
  return db
}

/** Deterministic ids, so a failure names the same row on every run. */
export function ids(start = 1): ReturnType<typeof createCounterIds> {
  return createCounterIds({ start })
}

export interface FactClock {
  (): number
}

export function clockFrom(start = 1_700_000_000_000): FactClock {
  let now = start
  return () => {
    now += 1000
    return now
  }
}

export function startFact(sessionId: string, incarnationId: string, at: FactClock): NewEntry {
  return createEntryWriter('session')('session/start', {
    sourceType: 'session',
    sourceId: sessionId,
    sourceSeq: 0,
    provenanceKey: sessionStartKey(incarnationId),
    payload: { incarnationId },
    createdAt: at(),
  })
}

export function userFact(
  messageId: string,
  revision: number,
  text: string,
  at: FactClock,
): NewEntry {
  return createEntryWriter('message')('message/user', {
    sourceType: 'message',
    sourceId: messageId,
    sourceSeq: revision,
    provenanceKey: messageRevisionKey(messageId, revision),
    payload: {
      messageId,
      revision,
      role: 'user',
      content: [{ type: 'text', text }],
      status: 'complete',
    },
    createdAt: at(),
  })
}

/** The tombstone §删除语义 writes for a deleted message: the projection row goes, the fact stays. */
export function retractionFact(messageId: string, at: FactClock): NewEntry {
  return createEntryWriter('message')('message/retracted', {
    sourceType: 'message',
    sourceId: messageId,
    provenanceKey: messageRetractedKey(messageId),
    payload: { messageId, reason: 'user-deleted' },
    createdAt: at(),
  })
}

export function modelSelectedFact(sessionId: string, runId: string, at: FactClock): NewEntry {
  return createEntryWriter('session')('session/model_selected', {
    sourceType: 'session',
    sourceId: sessionId,
    provenanceKey: modelSelectedKey(runId),
    payload: { providerId: 'anthropic', modelId: 'claude-test' },
    createdAt: at(),
  })
}

/** An `ext/<owner>/…` fact: the only thing generic append may write, and a cheap filler. */
export function extFact(sessionId: string, ordinal: number, at: FactClock): NewEntry {
  return createEntryWriter(null)('ext/acme/note', {
    kind: 'event',
    sourceType: 'session',
    sourceId: sessionId,
    provenanceKey: `ext:v1:acme:note.${ordinal}`,
    payload: { ordinal },
    createdAt: at(),
  })
}
