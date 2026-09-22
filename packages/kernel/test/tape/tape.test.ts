/**
 * The Tape facade: acceptance 13 re-proved THROUGH the facade and a real store, plus the property
 * the facade exists for — nothing reaches a transaction before the gate has run.
 *
 * `names.test.ts` already pins the assertion itself. What this file adds is that the door `apps/*`
 * actually use is wired to it: a slice writer that only writes its own names, a generic path that
 * only writes `ext/<owner>/…`, and a reset that cannot smuggle an unauthorised fact past either.
 */
import { describe, expect, it } from 'vitest'
import type { HostIdentity } from '../../src/host/adapter.js'
import type { AppendResult, NewEntry } from '../../src/tape/entry.js'
import { createMemoryTapeStore } from '../../src/tape/memory-store.js'
import { TapeAppendAuthorizationError } from '../../src/tape/names.js'
import { TapeProvenanceSyntaxError, sessionStartKey } from '../../src/tape/provenance.js'
import type { TapeAppendBatch, TapeResetSessionQuery, TapeStore } from '../../src/tape/store.js'
import { createTape } from '../../src/tape/tape.js'
import { createCounterIds } from '../../src/testing/fake-ids.js'

const IDENTITY: HostIdentity = { userId: 'u', tenantId: 'tenant-a', profileDir: '/tenon/a' }

const SESSION = '00000000-0000-4000-8000-000000000201'
const INCARNATION = '00000000-0000-4000-8000-000000000202'
const MESSAGE = '00000000-0000-4000-8000-000000000203'

function openTape(): ReturnType<typeof createTape> {
  return createTape(createMemoryTapeStore({ identity: IDENTITY }))
}

async function withSession(): Promise<ReturnType<typeof createTape>> {
  const tape = openTape()
  await tape.writer('session').write({
    sessionId: SESSION,
    incarnationId: INCARNATION,
    fact: {
      name: 'session/start',
      fields: {
        sourceType: 'session',
        sourceId: SESSION,
        sourceSeq: 0,
        provenanceKey: sessionStartKey(INCARNATION),
        payload: { incarnationId: INCARNATION },
        createdAt: 1_700_000_000_000,
      },
    },
  })
  return tape
}

/** A store that records whether it was reached at all. */
function spyStore(): { store: TapeStore; calls: string[] } {
  const calls: string[] = []
  const receipt: AppendResult = { entryId: 1, entryHash: new Uint8Array(32), created: true }
  const partial = {
    append(batch: TapeAppendBatch): Promise<AppendResult[]> {
      calls.push('append')
      return Promise.resolve(batch.entries.map(() => receipt))
    },
    resetSession(_q: TapeResetSessionQuery): Promise<AppendResult> {
      calls.push('resetSession')
      return Promise.resolve(receipt)
    },
  }
  return { store: partial as unknown as TapeStore, calls }
}

describe('tape facade', () => {
  it('writes a slice fact through to the store and reads it back', async () => {
    const tape = await withSession()
    const receipt = await tape.writer('message').write({
      sessionId: SESSION,
      incarnationId: INCARNATION,
      fact: {
        name: 'message/user',
        fields: {
          sourceType: 'message',
          sourceId: MESSAGE,
          sourceSeq: 0,
          provenanceKey: `message:v1:${MESSAGE}:0`,
          payload: {
            messageId: MESSAGE,
            revision: 0,
            role: 'user',
            content: [{ type: 'text', text: 'through the facade' }],
            status: 'complete',
          },
          createdAt: 1_700_000_001_000,
        },
      },
    })
    expect(receipt.created).toBe(true)
    // The kind came from the declaration: a slice writer does not make the caller repeat it.
    const page = await tape.readRange({ sessionId: SESSION, limit: 10 })
    expect(page.entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ['anchor', 'session/start'],
      ['message', 'message/user'],
    ])
    const rows = await tape.listMessages({ sessionId: SESSION, limit: 10 })
    expect(rows[0]?.content).toEqual([{ type: 'text', text: 'through the facade' }])
    expect((await tape.head(SESSION))?.entryCount).toBe(2)
    await tape.close()
  })

  it('writes several facts of one slice in a single batch', async () => {
    const tape = await withSession()
    const second = '00000000-0000-4000-8000-000000000204'
    const results = await tape.writer('message').writeBatch({
      sessionId: SESSION,
      incarnationId: INCARNATION,
      facts: [MESSAGE, second].map((messageId) => ({
        name: 'message/user',
        fields: {
          sourceType: 'message' as const,
          sourceId: messageId,
          sourceSeq: 0,
          provenanceKey: `message:v1:${messageId}:0`,
          payload: {
            messageId,
            revision: 0,
            role: 'user',
            content: [{ type: 'text', text: messageId }],
            status: 'complete',
          },
          createdAt: 1_700_000_002_000,
        },
      })),
    })
    expect(results.map((result) => result.entryId)).toEqual([2, 3])
  })

  it('writes facts of several slices in one transaction, each re-checked', async () => {
    const tape = await withSession()
    const runId = '00000000-0000-4000-8000-000000000205'
    // A run's terminal facts: the assistant message belongs to the message slice, the attempt record
    // to the provider slice, and they are one event. Each is built by its own writer.
    const assistant = tape.writer('message').entry('message/assistant', {
      sourceType: 'message',
      sourceId: MESSAGE,
      sourceSeq: 0,
      provenanceKey: `message:v1:${MESSAGE}:0`,
      payload: {
        messageId: MESSAGE,
        revision: 0,
        role: 'assistant',
        runId,
        content: [{ type: 'text', text: 'both in one batch' }],
        status: 'complete',
      },
      createdAt: 1_700_000_009_000,
    })
    const attempt = tape.writer('provider').entry('provider/attempt_completed', {
      sourceType: 'runtime_event',
      sourceId: runId,
      sourceSeq: 0,
      provenanceKey: `provider:v1:attempt:${runId}:0:1`,
      payload: { providerId: 'anthropic', modelId: 'm', contextAtEntryId: 1 },
      createdAt: 1_700_000_009_000,
    })
    const results = await tape.appendEntries({
      sessionId: SESSION,
      incarnationId: INCARNATION,
      entries: [assistant, attempt],
    })
    expect(results.map((result) => result.entryId)).toEqual([2, 3])
    expect((await tape.head(SESSION))?.entryCount).toBe(3)
  })

  it('re-runs the gate on entries handed to appendEntries', async () => {
    const spy = spyStore()
    const tape = createTape(spy.store)
    const smuggled: NewEntry = {
      kind: 'event',
      name: 'execution/anything',
      sourceType: 'runtime_event',
      sourceId: 'run',
      provenanceKey: 'execution:v1:anything',
      payload: {},
      createdAt: 1_700_000_010_000,
    }
    const ok: NewEntry = tape.writer('session').entry('session/model_selected', {
      sourceType: 'session',
      sourceId: SESSION,
      provenanceKey: 'session:v1:model:00000000-0000-4000-8000-000000000206',
      payload: { providerId: 'anthropic', modelId: 'm' },
      createdAt: 1_700_000_010_000,
    })
    // An unauthorised name anywhere in the batch, and a malformed key, both stop before the store.
    await expect(
      tape.appendEntries({
        sessionId: SESSION,
        incarnationId: INCARNATION,
        entries: [ok, smuggled],
      }),
    ).rejects.toThrow(TapeAppendAuthorizationError)
    await expect(
      tape.appendEntries({
        sessionId: SESSION,
        incarnationId: INCARNATION,
        entries: [{ ...ok, provenanceKey: 'session:v1:model:2026-09-21T10:00:00Z' }],
      }),
    ).rejects.toThrow(TapeProvenanceSyntaxError)
    expect(spy.calls).toEqual([])
  })

  // ----- acceptance 13 --------------------------------------------------------------------------

  it('refuses every reserved name on the generic path', async () => {
    const tape = await withSession()
    const reserved = [
      'execution/run_started', // an exactly reserved, declared name
      'execution/anything', // an undeclared sibling under a reserved prefix
      'tool/anything',
      'fs/anything',
      'view/assembled',
      'message/retracted',
      'session/start',
      'provider/attempt_completed',
    ]
    for (const name of reserved) {
      // oxlint-disable-next-line no-await-in-loop -- one rejection asserted per name, in order
      await expect(
        tape.append({
          sessionId: SESSION,
          incarnationId: INCARNATION,
          facts: [
            {
              name,
              fields: {
                kind: 'event',
                sourceType: 'session',
                sourceId: SESSION,
                provenanceKey: 'ext:v1:acme:note',
                payload: {},
                createdAt: 1_700_000_003_000,
              },
            },
          ],
        }),
      ).rejects.toThrow(TapeAppendAuthorizationError)
    }
    // …and the context kind, which belongs wholesale to skill/.
    await expect(
      tape.append({
        sessionId: SESSION,
        incarnationId: INCARNATION,
        facts: [
          {
            name: 'ext/acme/note',
            fields: {
              kind: 'context',
              sourceType: 'session',
              sourceId: SESSION,
              provenanceKey: 'ext:v1:acme:note',
              payload: {},
              createdAt: 1_700_000_003_000,
            },
          },
        ],
      }),
    ).rejects.toThrow(TapeAppendAuthorizationError)
    expect((await tape.readRange({ sessionId: SESSION, limit: 10 })).entries).toHaveLength(1)
  })

  it('writes ext/<owner>/… on the generic path and nothing without an owner segment', async () => {
    const tape = await withSession()
    const receipt = await tape.append({
      sessionId: SESSION,
      incarnationId: INCARNATION,
      facts: [
        {
          name: 'ext/acme/note',
          fields: {
            kind: 'event',
            sourceType: 'session',
            sourceId: SESSION,
            provenanceKey: 'ext:v1:acme:note',
            payload: { note: 'extension fact' },
            createdAt: 1_700_000_004_000,
          },
        },
      ],
    })
    expect(receipt[0]?.created).toBe(true)
    await expect(
      tape.append({
        sessionId: SESSION,
        incarnationId: INCARNATION,
        facts: [
          {
            name: 'ext/note',
            fields: {
              kind: 'event',
              sourceType: 'session',
              sourceId: SESSION,
              provenanceKey: 'ext:v1:acme:other',
              payload: {},
              createdAt: 1_700_000_004_000,
            },
          },
        ],
      }),
    ).rejects.toThrow(TapeAppendAuthorizationError)
  })

  it('lets a slice write only its own names, with the kind they are bound to', async () => {
    const tape = await withSession()
    const fields = {
      sourceType: 'session' as const,
      sourceId: SESSION,
      sourceSeq: 0,
      provenanceKey: sessionStartKey(INCARNATION),
      payload: {},
      createdAt: 1_700_000_005_000,
    }
    // The session slice may not write a message name…
    await expect(
      tape.writer('session').write({
        sessionId: SESSION,
        incarnationId: INCARNATION,
        fact: { name: 'message/user', fields },
      }),
    ).rejects.toThrow(TapeAppendAuthorizationError)
    // …the message slice may not write a session one…
    await expect(
      tape.writer('message').write({
        sessionId: SESSION,
        incarnationId: INCARNATION,
        fact: { name: 'session/start', fields },
      }),
    ).rejects.toThrow(TapeAppendAuthorizationError)
    // …nor an ext name, which belongs to the generic path…
    await expect(
      tape.writer('message').write({
        sessionId: SESSION,
        incarnationId: INCARNATION,
        fact: { name: 'ext/acme/note', fields: { ...fields, kind: 'event' } },
      }),
    ).rejects.toThrow(TapeAppendAuthorizationError)
    // …and not its own name with another kind.
    await expect(
      tape.writer('session').write({
        sessionId: SESSION,
        incarnationId: INCARNATION,
        fact: { name: 'session/start', fields: { ...fields, kind: 'event' } },
      }),
    ).rejects.toThrow(TapeAppendAuthorizationError)
  })

  // ----- the gate runs before the store ---------------------------------------------------------

  it('rejects a malformed provenance key before the store is reached', async () => {
    const spy = spyStore()
    const tape = createTape(spy.store)
    await expect(
      tape.append({
        sessionId: SESSION,
        incarnationId: INCARNATION,
        facts: [
          {
            name: 'ext/acme/note',
            fields: {
              kind: 'event',
              sourceType: 'session',
              sourceId: SESSION,
              // No owner segment: two extensions describing their own facts would mint the same key
              // and the second append would silently be a no-op.
              provenanceKey: 'ext:v1:note',
              payload: {},
              createdAt: 1_700_000_006_000,
            },
          },
        ],
      }),
    ).rejects.toThrow(TapeProvenanceSyntaxError)
    expect(spy.calls).toEqual([])
  })

  it('rejects an unauthorised reset fact before the store is reached', async () => {
    const spy = spyStore()
    const tape = createTape(spy.store)
    const smuggled: NewEntry = {
      kind: 'event',
      name: 'execution/run_started',
      sourceType: 'runtime_event',
      sourceId: 'run',
      provenanceKey: 'execution:v1:run',
      payload: {},
      createdAt: 1_700_000_007_000,
    }
    await expect(
      tape.resetSession({ sessionId: SESSION, incarnationId: INCARNATION, start: smuggled }),
    ).rejects.toThrow(TapeAppendAuthorizationError)
    expect(spy.calls).toEqual([])
  })

  it('resets a session with a start fact built by the session writer', async () => {
    const tape = await withSession()
    const ids = createCounterIds({ start: 900 })
    const next = ids.uuid()
    const start = tape.writer('session').entry('session/start', {
      sourceType: 'session',
      sourceId: SESSION,
      sourceSeq: 0,
      provenanceKey: sessionStartKey(next),
      payload: { incarnationId: next },
      createdAt: 1_700_000_008_000,
    })
    const receipt = await tape.resetSession({
      sessionId: SESSION,
      incarnationId: next,
      start,
    })
    expect(receipt.entryId).toBe(2)
    const head = await tape.head(SESSION)
    expect(head?.incarnationId).toBe(next)
    expect(head?.entryCount).toBe(1)
    expect(head?.lastEntryId).toBe(2)
    await tape.deleteSession(SESSION)
    expect(await tape.head(SESSION)).toBeNull()
  })
})
