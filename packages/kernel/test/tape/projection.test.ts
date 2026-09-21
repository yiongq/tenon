/**
 * The projection reducer: acceptance 3's kernel half, stated per fact.
 *
 * The two properties worth a gate are the ones a store cannot restore afterwards: `order_seq` and
 * `created_at` are `insertOnly`, so a revision never moves a message, and a fact the reducer does
 * not know about projects to NOTHING rather than to a guess.
 */
import { describe, expect, it } from 'vitest'
import type { TapeEntry, TapeKind } from '../../src/tape/entry.js'
import type { ProjectionOp } from '../../src/tape/projection.js'
import {
  PROJECTION_TABLES,
  PROJECTION_VERSION,
  TapeProjectionError,
  parseMessagePayload,
  project,
} from '../../src/tape/projection.js'

const SESSION = '00000000-0000-4000-8000-000000000001'
const MESSAGE = '00000000-0000-4000-8000-000000000002'
const RUN = '00000000-0000-4000-8000-000000000003'

function entry(overrides: Partial<TapeEntry> & { kind: TapeKind; name: string }): TapeEntry {
  return {
    tenantId: 'tenant',
    sessionId: SESSION,
    entryId: 7,
    incarnationId: '00000000-0000-4000-8000-00000000000a',
    sourceType: 'message',
    sourceId: MESSAGE,
    sourceSeq: 0,
    provenanceKey: 'message:v1:x:0',
    payload: {},
    meta: {},
    createdAt: 1_700_000_000_000,
    contentHash: new Uint8Array(32),
    prevHash: null,
    entryHash: new Uint8Array(32),
    hashVer: 1,
    ...overrides,
  }
}

function userMessage(overrides: Partial<TapeEntry> = {}): TapeEntry {
  return entry({
    kind: 'message',
    name: 'message/user',
    payload: {
      messageId: MESSAGE,
      revision: 0,
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      status: 'complete',
    },
    ...overrides,
  })
}

function messageOps(ops: readonly ProjectionOp[]): readonly ProjectionOp[] {
  return ops.filter((op) => op.table === 'message')
}

describe('project', () => {
  it('turns a user message into a message upsert plus session activity', () => {
    const ops = project(userMessage())
    expect(ops).toEqual([
      {
        table: 'message',
        op: 'upsert',
        key: { sessionId: SESSION, messageId: MESSAGE },
        values: {
          role: 'user',
          status: 'complete',
          contentJson: '[{"text":"hello","type":"text"}]',
          entryId: 7,
          updatedAt: 1_700_000_000_000,
        },
        insertOnly: { orderSeq: 7, createdAt: 1_700_000_000_000 },
      },
      {
        table: 'session',
        op: 'upsert',
        key: { sessionId: SESSION },
        values: { lastMessageAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 },
        insertOnly: { createdAt: 1_700_000_000_000 },
      },
    ])
  })

  it('puts order_seq and created_at in insertOnly, so a revision cannot move a message', () => {
    const revision = userMessage({
      entryId: 99,
      createdAt: 1_700_000_900_000,
      payload: {
        messageId: MESSAGE,
        revision: 1,
        role: 'user',
        content: [{ type: 'text', text: 'edited' }],
        status: 'complete',
      },
    })
    const [upsert] = messageOps(project(revision))
    if (upsert === undefined || upsert.table !== 'message' || upsert.op !== 'upsert') {
      throw new Error('no message upsert')
    }
    // The op carries the revision's own id in insertOnly; dropping it on conflict is what pins the
    // row's position. `values.entryId` moves, so a reader can still find the winning fact.
    expect(upsert.insertOnly).toEqual({ orderSeq: 99, createdAt: 1_700_000_900_000 })
    expect(upsert.values.entryId).toBe(99)
    expect(upsert.values.updatedAt).toBe(1_700_000_900_000)
  })

  it('carries the assistant role and its content', () => {
    const [upsert] = messageOps(
      project(
        entry({
          kind: 'message',
          name: 'message/assistant',
          payload: {
            messageId: MESSAGE,
            revision: 0,
            role: 'assistant',
            runId: RUN,
            content: [{ type: 'text', text: 'answer' }],
            status: 'aborted',
          },
        }),
      ),
    )
    if (upsert === undefined || upsert.table !== 'message' || upsert.op !== 'upsert') {
      throw new Error('no message upsert')
    }
    expect(upsert.values.role).toBe('assistant')
    expect(upsert.values.status).toBe('aborted')
  })

  it('deletes the row for a retraction and writes nothing else', () => {
    const ops = project(
      entry({
        kind: 'event',
        name: 'message/retracted',
        sourceSeq: null,
        payload: { messageId: MESSAGE, reason: 'user-deleted' },
      }),
    )
    expect(ops).toEqual([
      { table: 'message', op: 'delete', key: { sessionId: SESSION, messageId: MESSAGE } },
    ])
  })

  it('opens the session row on session/start, with forked_from insert-only', () => {
    const ops = project(
      entry({
        kind: 'anchor',
        name: 'session/start',
        sourceType: 'session',
        sourceId: SESSION,
        payload: {
          incarnationId: '00000000-0000-4000-8000-00000000000a',
          forkedFrom: {
            sessionId: 'parent-session',
            incarnationId: 'parent-incarnation',
            entryId: 4,
            entryHash: 'ab'.repeat(32),
          },
        },
      }),
    )
    expect(ops).toEqual([
      {
        table: 'session',
        op: 'upsert',
        key: { sessionId: SESSION },
        values: { updatedAt: 1_700_000_000_000 },
        insertOnly: { createdAt: 1_700_000_000_000, forkedFromSessionId: 'parent-session' },
      },
    ])
  })

  it('records the provider and model a run actually used', () => {
    const ops = project(
      entry({
        kind: 'event',
        name: 'session/model_selected',
        sourceType: 'session',
        sourceId: SESSION,
        sourceSeq: null,
        payload: { providerId: 'zhipu', modelId: 'glm-4' },
      }),
    )
    const [op] = ops
    if (op === undefined || op.table !== 'session' || op.op !== 'upsert') {
      throw new Error('no session upsert')
    }
    expect(op.values.providerId).toBe('zhipu')
    expect(op.values.modelId).toBe('glm-4')
    // Never a title: phase 1 leaves that column to phase 6's auto-naming.
    expect(JSON.stringify(ops)).not.toContain('title')
  })

  it('projects every other kind and name to nothing', () => {
    const passthrough: TapeEntry[] = [
      entry({
        kind: 'event',
        name: 'provider/attempt_completed',
        sourceType: 'runtime_event',
        sourceId: RUN,
        payload: { providerId: 'anthropic', modelId: 'm', contextAtEntryId: 3 },
      }),
      entry({ kind: 'event', name: 'ext/acme/note', payload: { note: 'x' } }),
      // A declared name carrying the wrong kind selects nothing either: the pair decides.
      entry({ kind: 'event', name: 'message/user', payload: { messageId: MESSAGE } }),
      entry({ kind: 'anchor', name: 'ext/acme/anchor', payload: {} }),
      entry({ kind: 'context', name: 'skill/context', payload: {} }),
    ]
    for (const candidate of passthrough) {
      expect(project(candidate)).toEqual([])
    }
  })

  it('refuses a payload that does not match the name, rather than projecting a guess', () => {
    expect(() => project(userMessage({ payload: { revision: 0, role: 'user' } }))).toThrow(
      TapeProjectionError,
    )
    expect(() =>
      project(
        userMessage({
          payload: { messageId: MESSAGE, revision: 0, role: 'assistant', content: [], status: 'x' },
        }),
      ),
    ).toThrow(TapeProjectionError)
    expect(() =>
      project(
        userMessage({
          payload: {
            messageId: MESSAGE,
            revision: -1,
            role: 'user',
            content: [],
            status: 'complete',
          },
        }),
      ),
    ).toThrow(TapeProjectionError)
    expect(() =>
      project(
        userMessage({
          payload: {
            messageId: MESSAGE,
            revision: 0,
            role: 'user',
            content: ['not a block'],
            status: 'complete',
          },
        }),
      ),
    ).toThrow(TapeProjectionError)
  })

  it('reads a message payload the same way for the projection and for replay', () => {
    const payload = parseMessagePayload(userMessage())
    expect(payload).toEqual({
      messageId: MESSAGE,
      revision: 0,
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      status: 'complete',
    })
  })

  it('names exactly the two phase-1 projections', () => {
    expect(PROJECTION_TABLES).toEqual(['message', 'session'])
    expect(PROJECTION_VERSION).toBe(1)
  })
})
