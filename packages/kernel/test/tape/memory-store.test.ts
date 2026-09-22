/**
 * The memory store: the shared conformance suite plus what is specific to this implementation.
 *
 * The suite is the contract and step 7 runs it unchanged against SQLite, so everything provable
 * through the port lives there — including the store's own append gate, which every implementation
 * owes (§保留命名空间). What stays here is what the port cannot show: that a batch is abandoned when
 * the reducer itself throws, that what comes back is a copy rather than a window into the store's
 * state, and that the injected reducer is the one applied.
 */
import { describe, expect, it } from 'vitest'
import type { HostIdentity } from '../../src/host/adapter.js'
import type { NewEntry, TapeEntry } from '../../src/tape/entry.js'
import { createMemoryTapeStore } from '../../src/tape/memory-store.js'
import { createEntryWriter } from '../../src/tape/names.js'
import type { ProjectionOp } from '../../src/tape/projection.js'
import { project } from '../../src/tape/projection.js'
import { sessionStartKey } from '../../src/tape/provenance.js'
import type { TapeStore } from '../../src/tape/store.js'
import { createCounterIds } from '../../src/testing/fake-ids.js'
import { tapeConformanceCases } from '../../src/testing/tape-conformance.js'

const IDENTITY: HostIdentity = { userId: 'u', tenantId: 'tenant-a', profileDir: '/tenon/a' }

describe('tape conformance (memory store)', () => {
  // The memory store needs nothing from `label`: every call is already its own private store. The
  // SQLite factory at step 7 derives a temp file from it.
  const cases = tapeConformanceCases((options) => Promise.resolve(createMemoryTapeStore(options)))
  for (const conformanceCase of cases) {
    // A conformance case throws on failure rather than calling expect().
    // oxlint-disable-next-line vitest/expect-expect
    it(
      // oxlint-disable-next-line vitest/valid-title -- the title is data the suite owns
      conformanceCase.name,
      async () => {
        await conformanceCase.run()
      },
      60_000,
    )
  }

  it('closes every store it opened, even when the case fails', async () => {
    // Step 7's factory hands out a real file handle per call. A failed assertion must not leak it, or
    // one broken case would leave an open better-sqlite3 connection (and its -wal / -shm files)
    // behind for the rest of the run — and the failure the runner reports must still be the case's.
    let closed = 0
    const broken = {
      append: (): Promise<never> => Promise.reject(new Error('this store is broken')),
      close: (): Promise<void> => {
        closed += 1
        return Promise.resolve()
      },
    } as unknown as TapeStore
    const [firstCase] = tapeConformanceCases(() => Promise.resolve(broken))
    if (firstCase === undefined) throw new Error('the suite is empty')
    await expect(firstCase.run()).rejects.toThrow('this store is broken')
    expect(closed).toBe(1)
  })
})

const SESSION = '00000000-0000-4000-8000-000000000101'
const INCARNATION = '00000000-0000-4000-8000-000000000102'

function startFact(createdAt = 1_700_000_000_000): NewEntry {
  return createEntryWriter('session')('session/start', {
    sourceType: 'session',
    sourceId: SESSION,
    sourceSeq: 0,
    provenanceKey: sessionStartKey(INCARNATION),
    payload: { incarnationId: INCARNATION },
    createdAt,
  })
}

describe('memory tape store', () => {
  it('hands back copies, not a window into its own state', async () => {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    await store.append({ sessionId: SESSION, incarnationId: INCARNATION, entries: [startFact()] })
    const page = await store.readRange({ sessionId: SESSION, limit: 10 })
    const entry = page.entries[0]
    if (entry === undefined) throw new Error('no entry')
    entry.payload['incarnationId'] = 'tampered'
    entry.entryHash.fill(0)
    const again = await store.readRange({ sessionId: SESSION, limit: 10 })
    expect(again.entries[0]?.payload['incarnationId']).toBe(INCARNATION)
    expect(again.entries[0]?.entryHash).not.toEqual(entry.entryHash)
    const head = await store.head(SESSION)
    expect(head?.lastHash).toEqual(again.entries[0]?.entryHash)
  })

  it('applies the injected reducer instead of the kernel one', async () => {
    const seen: TapeEntry[] = []
    const store = createMemoryTapeStore({
      identity: IDENTITY,
      project: (entry): readonly ProjectionOp[] => {
        seen.push(entry)
        return []
      },
    })
    await store.append({ sessionId: SESSION, incarnationId: INCARNATION, entries: [startFact()] })
    expect(seen.map((entry) => entry.name)).toEqual(['session/start'])
    // The reducer wrote nothing, so the projection stayed empty — proof the store applied THIS one.
    expect(await store.listSessions({ limit: 10 })).toEqual([])
  })

  it('aborts the batch when a reducer throws, leaving nothing behind', async () => {
    let calls = 0
    const store = createMemoryTapeStore({
      identity: IDENTITY,
      project: (entry): readonly ProjectionOp[] => {
        calls += 1
        if (calls === 2) throw new Error('reducer exploded')
        return project(entry)
      },
    })
    const writer = createEntryWriter('session')
    await expect(
      store.append({
        sessionId: SESSION,
        incarnationId: INCARNATION,
        entries: [
          startFact(),
          writer('session/model_selected', {
            sourceType: 'session',
            sourceId: SESSION,
            provenanceKey: 'session:v1:model:00000000-0000-4000-8000-000000000003',
            payload: { providerId: 'anthropic', modelId: 'm' },
            createdAt: 1_700_000_001_000,
          }),
        ],
      }),
    ).rejects.toThrow('reducer exploded')
    expect(await store.head(SESSION)).toBeNull()
    expect((await store.readRange({ sessionId: SESSION, limit: 10 })).entries).toEqual([])
  })

  it('binds its tenant at construction, with no way to pass another one', async () => {
    const ids = createCounterIds()
    const a = createMemoryTapeStore({ identity: IDENTITY })
    const b = createMemoryTapeStore({
      identity: { userId: 'u', tenantId: 'tenant-b', profileDir: '/tenon/b' },
    })
    await a.append({ sessionId: SESSION, incarnationId: INCARNATION, entries: [startFact()] })
    await b.append({ sessionId: SESSION, incarnationId: INCARNATION, entries: [startFact()] })
    const fromA = (await a.readRange({ sessionId: SESSION, limit: 1 })).entries[0]
    const fromB = (await b.readRange({ sessionId: SESSION, limit: 1 })).entries[0]
    expect(fromA?.tenantId).toBe('tenant-a')
    expect(fromB?.tenantId).toBe('tenant-b')
    // The tenant is in the hash preimage, so the same fact under two tenants seals differently.
    expect(fromA?.entryHash).not.toEqual(fromB?.entryHash)
    expect(ids.issued).toBe(0)
  })
})
