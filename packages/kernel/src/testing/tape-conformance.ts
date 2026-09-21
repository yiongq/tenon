/**
 * The shared `TapeStore` conformance suite (spec 01 acceptance 3, 10, 11, 13, 15).
 *
 * It is FRAMEWORK-FREE by necessity: this file ships from `@tenon-app/kernel/testing`, an entry that
 * `test/host-independence.test.ts` bundles for the browser, so it may not import vitest or any Node
 * module. Cases are plain named async functions that throw on failure; a tiny vitest file maps them
 * onto `it()`. Step 7 runs this very file against the SQLite store, so nothing in here may touch a
 * store's internals — every assertion goes through the port.
 *
 * Whatever the store, the same properties are being proved: an `entryId` is a causal clock that
 * survives a reset, an append is idempotent by `provenanceKey` and atomic per batch, the store's own
 * append gate refuses a reserved name even when the facade is bypassed, reads are bounded and
 * pinnable, the chain recomputes from what the port returns, and a rebuilt projection equals the one
 * written incrementally. **Anything this file does not pin is free to differ between the two stores**,
 * and §删除语义 routes live (incognito) sessions to the memory store, so both contracts ship.
 *
 * Two things are NOT covered here, on purpose:
 *
 *   - acceptance 3's `promptHash` half needs `encode()` from the provider track and is wired at step
 *     12 — faking it would prove nothing about the real encoder;
 *   - acceptance 12's tamper detection. `verifyChain`'s POSITIVE half is here (a healthy chain reports
 *     no bad link, page by page); its negative half needs a way to corrupt a stored row, which the
 *     spec gives only to SQLite (「用测试专用手段（去掉触发器）」) and which no port method offers. The
 *     predicate every store's `verifyChain` is built from — `isStoredEntryProvable` — has its four
 *     rejection branches unit-tested in `test/tape/hash.test.ts`, and step 7 owns the byte flip.
 */
import type { HostIdentity } from '../host/adapter.js'
import type { AppendResult, NewEntry, TapeEntry, TapeKind } from '../tape/entry.js'
import { bytesToHex, contentHash, hashEntry } from '../tape/hash.js'
import type { SliceEntryFields, TapeSlice } from '../tape/names.js'
import { TapeAppendAuthorizationError, createEntryWriter } from '../tape/names.js'
import type { ProjectionOp, ProjectionReducer } from '../tape/projection.js'
import { project } from '../tape/projection.js'
import { canonicalJson } from '../tape/canonical-json.js'
import {
  TapeProvenanceSyntaxError,
  attemptCompletedKey,
  messageRetractedKey,
  messageRevisionKey,
  modelSelectedKey,
  sessionStartKey,
} from '../tape/provenance.js'
import type { MessageRow, TapeStore } from '../tape/store.js'
import {
  MAX_READ_LIMIT,
  TapeProvenanceConflictError,
  TapeReadLimitError,
  TapeSessionNotFoundError,
  TapeStaleIncarnationError,
} from '../tape/store.js'
import { createCounterIds } from './fake-ids.js'

export interface TapeStoreFactoryOptions {
  /** The store binds its tenant to this; the suite never passes a tenant to a method. */
  readonly identity: HostIdentity
  /** When present, the store must apply THIS reducer instead of the kernel's. */
  readonly project?: ProjectionReducer
  /**
   * The case asking for the store, as a slug. A factory that needs a fresh backing store per call —
   * the SQLite one cannot honour `identity.profileDir`, or all cases would share one file — derives a
   * name from it and keeps the path itself. The suite closes every store it opened, including after a
   * failed assertion, so a factory may also track handles by label to tear down leftovers.
   */
  readonly label: string
}

export type TapeStoreFactory = (options: TapeStoreFactoryOptions) => Promise<TapeStore>

export interface TapeConformanceCase {
  readonly name: string
  run(): Promise<void>
}

/** Thrown by every failed assertion, so a runner can tell a failure from a crash. */
export class TapeConformanceFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeConformanceFailure'
  }
}

type ErrorClass = new (...args: never[]) => Error

function fail(message: string): never {
  throw new TapeConformanceFailure(message)
}

function assertTrue(condition: boolean, message: string): void {
  if (!condition) fail(message)
}

/** Structural equality over what a tape returns: JSON values plus `Uint8Array`. */
function describeValue(value: unknown): string {
  if (value instanceof Uint8Array) return `bytes(${bytesToHex(value)})`
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false
    if (left.length !== right.length) return false
    return left.every((byte, index) => byte === right[index])
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (typeof left === 'object' && typeof right === 'object' && left !== null && right !== null) {
    const leftKeys = Object.keys(left).toSorted()
    const rightKeys = Object.keys(right).toSorted()
    if (!deepEqual(leftKeys, rightKeys)) return false
    const leftRecord: Record<string, unknown> = { ...left }
    const rightRecord: Record<string, unknown> = { ...right }
    return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]))
  }
  return false
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!deepEqual(actual, expected)) {
    fail(`${message}: expected ${describeValue(expected)}, got ${describeValue(actual)}`)
  }
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expected: ErrorClass,
  message: string,
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof expected) return
    fail(`${message}: threw ${describeValue(String(error))} instead of ${expected.name}`)
  }
  fail(`${message}: resolved instead of throwing ${expected.name}`)
}

/**
 * Invariant 17, applied to whatever a read returned. A Node `Buffer` IS a `Uint8Array`, so the check
 * is on the prototype — and it has to work without importing `node:buffer`, which this file may not
 * do. `bigint` is caught by `typeof`.
 */
function assertPortSafe(value: unknown, path: string): void {
  if (typeof value === 'bigint') fail(`${path} is a bigint; no bigint crosses the port`)
  if (value === null || typeof value !== 'object') return
  if (value instanceof Uint8Array) {
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype) {
      fail(`${path} is a Uint8Array subclass (a Buffer?); only plain Uint8Array crosses the port`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortSafe(item, `${path}[${index}]`))
    return
  }
  const record: Record<string, unknown> = { ...value }
  for (const key of Object.keys(record)) assertPortSafe(record[key], `${path}.${key}`)
}

// -------------------------------------------------------------------------------------------------
// Fixture helpers — the kernel's own writers, so the suite can only build facts a slice may write
// -------------------------------------------------------------------------------------------------

const TENANT: HostIdentity = {
  userId: 'conformance-user',
  tenantId: 'conformance-tenant',
  profileDir: '/tenon/conformance',
}

/** Deterministic clock: `createdAt` is data on the fact, never read from a host clock. */
function clockFrom(start: number): () => number {
  let now = start
  return () => {
    now += 1000
    return now
  }
}

interface Fixture {
  readonly store: TapeStore
  readonly sessionId: string
  incarnationId: string
  readonly ids: ReturnType<typeof createCounterIds>
  readonly at: () => number
}

/** What one case's runner holds: its label, its private id range, and the stores it opened. */
interface CaseContext {
  readonly label: string
  readonly idStart: number
  readonly stores: TapeStore[]
}

/** How a case opens a store. The runner closes it afterwards, pass or fail. */
export type OpenFixture = (options?: { readonly project?: ProjectionReducer }) => Promise<Fixture>

async function openFixture(
  createStore: TapeStoreFactory,
  context: CaseContext,
  options: { readonly project?: ProjectionReducer } = {},
): Promise<Fixture> {
  const store = await createStore({
    identity: TENANT,
    label: context.label,
    ...(options.project === undefined ? {} : { project: options.project }),
  })
  context.stores.push(store)
  // Each case counts from its own base, so two cases never mint the same session id — a factory that
  // hands out ONE backing store would otherwise see case 2 collide with case 1's rows.
  const ids = createCounterIds({ start: context.idStart })
  return {
    store,
    sessionId: ids.uuid(),
    incarnationId: ids.uuid(),
    ids,
    at: clockFrom(1_700_000_000_000),
  }
}

/** Every fact goes through the kernel's own writer, so a fixture cannot build an unauthorised one. */
function write(slice: TapeSlice | null, name: string, fields: SliceEntryFields): NewEntry {
  return createEntryWriter(slice)(name, fields)
}

function startEntry(fixture: Fixture, incarnationId: string): NewEntry {
  return write('session', 'session/start', {
    sourceType: 'session',
    sourceId: fixture.sessionId,
    sourceSeq: 0,
    provenanceKey: sessionStartKey(incarnationId),
    payload: { incarnationId },
    createdAt: fixture.at(),
  })
}

function userMessage(
  fixture: Fixture,
  messageId: string,
  revision: number,
  text: string,
): NewEntry {
  return write('message', 'message/user', {
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
    createdAt: fixture.at(),
  })
}

function assistantMessage(
  fixture: Fixture,
  messageId: string,
  revision: number,
  runId: string,
  text: string,
): NewEntry {
  return write('message', 'message/assistant', {
    sourceType: 'message',
    sourceId: messageId,
    sourceSeq: revision,
    provenanceKey: messageRevisionKey(messageId, revision),
    payload: {
      messageId,
      revision,
      role: 'assistant',
      runId,
      content: [{ type: 'text', text }],
      status: 'complete',
    },
    createdAt: fixture.at(),
  })
}

function retraction(fixture: Fixture, messageId: string): NewEntry {
  return write('message', 'message/retracted', {
    sourceType: 'message',
    sourceId: messageId,
    provenanceKey: messageRetractedKey(messageId),
    payload: { messageId, reason: 'user-deleted' },
    createdAt: fixture.at(),
  })
}

function modelSelected(fixture: Fixture, runId: string): NewEntry {
  return write('session', 'session/model_selected', {
    sourceType: 'session',
    sourceId: fixture.sessionId,
    provenanceKey: modelSelectedKey(runId),
    payload: { providerId: 'anthropic', modelId: 'claude-test' },
    createdAt: fixture.at(),
  })
}

function attemptCompleted(fixture: Fixture, runId: string, requestSeq: number): NewEntry {
  return write('provider', 'provider/attempt_completed', {
    sourceType: 'runtime_event',
    sourceId: runId,
    sourceSeq: requestSeq,
    provenanceKey: attemptCompletedKey(runId, requestSeq, 1),
    payload: {
      providerId: 'anthropic',
      modelId: 'claude-test',
      contextAtEntryId: 1,
      request: { systemHash: 'a'.repeat(64), maxTokens: 1024 },
      promptHash: 'b'.repeat(64),
      toolDefinitionsHash: 'c'.repeat(64),
      thinkingDecisions: [],
      usage: null,
      stop: { reason: 'end-turn', providerReason: 'end_turn' },
      error: null,
    },
    createdAt: fixture.at(),
  })
}

/** An `ext/<owner>/…` fact: the only thing generic append may write, and a cheap filler. */
function extFact(fixture: Fixture, ordinal: number): NewEntry {
  return write(null, 'ext/acme/note', {
    kind: 'event',
    sourceType: 'session',
    sourceId: fixture.sessionId,
    provenanceKey: `ext:v1:acme:note.${ordinal}`,
    payload: { ordinal },
    createdAt: fixture.at(),
  })
}

async function appendAll(fixture: Fixture, entries: readonly NewEntry[]): Promise<AppendResult[]> {
  return fixture.store.append({
    sessionId: fixture.sessionId,
    incarnationId: fixture.incarnationId,
    entries,
  })
}

/** Reads a whole session through the port, page by page, with `atEntryId` pinned if given. */
async function readAll(
  store: TapeStore,
  sessionId: string,
  options: { readonly atEntryId?: number; readonly limit?: number } = {},
): Promise<TapeEntry[]> {
  const limit = options.limit ?? MAX_READ_LIMIT
  const entries: TapeEntry[] = []
  let fromEntryId: number | undefined
  let incarnationId: string | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
    const page = await store.readRange({
      sessionId,
      limit,
      ...(fromEntryId === undefined ? {} : { fromEntryId }),
      ...(options.atEntryId === undefined ? {} : { atEntryId: options.atEntryId }),
      ...(incarnationId === undefined ? {} : { incarnationId }),
    })
    entries.push(...page.entries)
    incarnationId = page.incarnationId
    if (page.nextFromEntryId === null) return entries
    fromEntryId = page.nextFromEntryId
  }
}

function countingReducer(counts: Map<string, number>): ProjectionReducer {
  return (entry: TapeEntry): readonly ProjectionOp[] => {
    const key = `${entry.name}#${entry.entryId}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return project(entry)
  }
}

// -------------------------------------------------------------------------------------------------
// The cases
// -------------------------------------------------------------------------------------------------

/** A case name as a factory can use it in a file name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 48)
}

export function tapeConformanceCases(
  createStore: TapeStoreFactory,
): readonly TapeConformanceCase[] {
  const cases: TapeConformanceCase[] = []
  const add = (name: string, body: (open: OpenFixture) => Promise<void>): void => {
    // A private id range per case, wide enough for the 5000-fact one to stay inside it.
    const idStart = (cases.length + 1) * 100_000 + 1
    cases.push({
      name,
      async run(): Promise<void> {
        const context: CaseContext = { label: slugify(name), idStart, stores: [] }
        let failed = false
        let failure: unknown
        try {
          await body((options = {}) => openFixture(createStore, context, options))
        } catch (error) {
          failed = true
          failure = error
        }
        // Closed in every outcome: a failed assertion must not leave an open handle (and, for SQLite,
        // its -wal / -shm files) behind for the rest of the run. A close that itself fails is reported
        // only when the body passed, so it can never mask the real failure.
        for (const store of context.stores.splice(0)) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- handles are released one at a time
            await store.close()
          } catch (error) {
            if (!failed) {
              failed = true
              failure = error
            }
          }
        }
        if (failed) throw failure
      },
    })
  }

  // ----- acceptance 10: entry_id is a causal clock -----------------------------------------------

  add('entry ids keep rising across a reset, and the head never goes backwards', async (open) => {
    const fixture = await open()
    const runId = fixture.ids.uuid()
    const firstMessage = fixture.ids.uuid()
    const before = await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      modelSelected(fixture, runId),
      userMessage(fixture, firstMessage, 0, 'before the reset'),
      assistantMessage(fixture, fixture.ids.uuid(), 0, runId, 'answer'),
      attemptCompleted(fixture, runId, 0),
    ])
    assertEqual(before.length, 5, 'five receipts')
    assertEqual(
      before.map((result) => result.entryId),
      [1, 2, 3, 4, 5],
      'ids are allocated from the head high-water mark, starting at 1',
    )
    const headBefore = await fixture.store.head(fixture.sessionId)
    if (headBefore === null) fail('head row is missing after the first append')
    assertEqual(headBefore.lastEntryId, 5, 'last_entry_id after five facts')
    assertEqual(headBefore.entryCount, 5, 'entry_count after five facts')

    const nextIncarnation = fixture.ids.uuid()
    const reset = await fixture.store.resetSession({
      sessionId: fixture.sessionId,
      incarnationId: nextIncarnation,
      start: startEntry(fixture, nextIncarnation),
    })
    assertTrue(
      reset.entryId > headBefore.lastEntryId,
      `the reset's session/start (${reset.entryId}) must be above every earlier id`,
    )
    const headAfterReset = await fixture.store.head(fixture.sessionId)
    if (headAfterReset === null) fail('head row is missing after the reset')
    assertEqual(headAfterReset.incarnationId, nextIncarnation, 'the incarnation was swapped')
    assertTrue(
      headAfterReset.lastEntryId >= headBefore.lastEntryId,
      'last_entry_id never decreases across a reset',
    )
    assertEqual(headAfterReset.entryCount, 1, 'entry_count restarts at the new session/start')

    fixture.incarnationId = nextIncarnation
    const after = await appendAll(fixture, [
      userMessage(fixture, fixture.ids.uuid(), 0, 'after the reset'),
    ])
    const newest = after[0]
    if (newest === undefined) fail('the post-reset append returned no receipt')
    assertTrue(
      newest.entryId > headBefore.lastEntryId,
      'ids after a reset are above every id from before it',
    )

    const entries = await readAll(fixture.store, fixture.sessionId)
    assertEqual(entries.length, 2, 'the old incarnation is physically gone')
    const anchor = entries.find((entry) => entry.name === 'session/start')
    if (anchor === undefined) fail('the new incarnation has no session/start')
    assertEqual(
      anchor.payload['incarnationId'],
      nextIncarnation,
      'the fresh anchor names the new id',
    )
    assertEqual(anchor.prevHash, null, 'a new incarnation opens a new chain')
  })

  add('a stale incarnation is refused on append and on a paged read', async (open) => {
    const fixture = await open()
    const stale = fixture.incarnationId
    await appendAll(fixture, [startEntry(fixture, stale), extFact(fixture, 1)])
    const fresh = fixture.ids.uuid()
    await fixture.store.resetSession({
      sessionId: fixture.sessionId,
      incarnationId: fresh,
      start: startEntry(fixture, fresh),
    })
    await assertRejects(
      () =>
        fixture.store.append({
          sessionId: fixture.sessionId,
          incarnationId: stale,
          entries: [extFact(fixture, 2)],
        }),
      TapeStaleIncarnationError,
      'appending with the previous incarnation',
    )
    await assertRejects(
      () =>
        fixture.store.readRange({
          sessionId: fixture.sessionId,
          incarnationId: stale,
          limit: 10,
        }),
      TapeStaleIncarnationError,
      'paging with the previous incarnation',
    )
    const entries = await readAll(fixture.store, fixture.sessionId)
    assertEqual(entries.length, 1, 'the refused append wrote nothing')
  })

  add('an EMPTY batch still answers the stale-incarnation question', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    // An empty batch writes nothing, so both stores are free to shortcut it — but they must shortcut
    // it the SAME way, and the guard is cheaper than the divergence: a caller holding a stale
    // incarnation learns it is stale on the call it made, not two calls later. Reported by a reviewer
    // as a real divergence between the two stores (SQLite resolved to [], memory threw).
    await assertRejects(
      () =>
        fixture.store.append({
          sessionId: fixture.sessionId,
          incarnationId: fixture.ids.uuid(),
          entries: [],
        }),
      TapeStaleIncarnationError,
      'an empty batch carrying an incarnation the head does not have',
    )
    assertEqual(
      await appendAll(fixture, []),
      [],
      'an empty batch on the current incarnation is an empty answer',
    )
    // And on a session that does not exist yet: nothing to be stale against, and nothing created.
    const unborn = fixture.ids.uuid()
    assertEqual(
      await fixture.store.append({
        sessionId: unborn,
        incarnationId: fixture.ids.uuid(),
        entries: [],
      }),
      [],
      'an empty batch never creates a head row',
    )
    assertEqual(await fixture.store.head(unborn), null, 'no head row was conjured up')
  })

  add('resetSession on an unknown session throws and writes nothing', async (open) => {
    const fixture = await open()
    const unknown = fixture.ids.uuid()
    const incarnation = fixture.ids.uuid()
    await assertRejects(
      () =>
        fixture.store.resetSession({
          sessionId: unknown,
          incarnationId: incarnation,
          start: write('session', 'session/start', {
            sourceType: 'session',
            sourceId: unknown,
            sourceSeq: 0,
            provenanceKey: sessionStartKey(incarnation),
            payload: { incarnationId: incarnation },
            createdAt: fixture.at(),
          }),
        }),
      TapeSessionNotFoundError,
      'resetting a session that has no head row',
    )
    assertEqual(await fixture.store.head(unknown), null, 'no head row was conjured up')
    assertEqual((await readAll(fixture.store, unknown)).length, 0, 'no facts were written')
  })

  add('a reset carries a NEW incarnation and opens it with session/start', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId), extFact(fixture, 1)])
    const headBefore = await fixture.store.head(fixture.sessionId)
    if (headBefore === null) fail('head row is missing')
    // Reusing the current incarnation would make two generations hash-indistinguishable.
    await assertRejects(
      () =>
        fixture.store.resetSession({
          sessionId: fixture.sessionId,
          incarnationId: fixture.incarnationId,
          start: startEntry(fixture, fixture.incarnationId),
        }),
      TapeStaleIncarnationError,
      'resetting into the incarnation the session is already in',
    )
    // And the anchor is the one fact a reset writes: anything else is a call-site error.
    const fresh = fixture.ids.uuid()
    await assertRejects(
      () =>
        fixture.store.resetSession({
          sessionId: fixture.sessionId,
          incarnationId: fresh,
          start: modelSelected(fixture, fixture.ids.uuid()),
        }),
      TypeError,
      'resetting with something other than session/start',
    )
    assertEqual(await fixture.store.head(fixture.sessionId), headBefore, 'neither call wrote')
  })

  // ----- acceptance 11: idempotency and conflict -------------------------------------------------

  add(
    'the same key with the same content returns the original receipt exactly once',
    async (open) => {
      const counts = new Map<string, number>()
      const fixture = await open({ project: countingReducer(counts) })
      const messageId = fixture.ids.uuid()
      const [, first] = await appendAll(fixture, [
        startEntry(fixture, fixture.incarnationId),
        userMessage(fixture, messageId, 0, 'resend me'),
      ])
      if (first === undefined) fail('the first append returned no receipt for the message')
      assertTrue(first.created, 'the first write created a row')
      const headAfterFirst = await fixture.store.head(fixture.sessionId)
      if (headAfterFirst === null) fail('head row is missing')

      // A retry rebuilds the same fact with a LATER clock: created_at is deliberately not compared.
      const replay = await appendAll(fixture, [userMessage(fixture, messageId, 0, 'resend me')])
      const second = replay[0]
      if (second === undefined) fail('the replay returned no receipt')
      assertEqual(second.created, false, 'the second write created nothing')
      assertEqual(second.entryId, first.entryId, 'the original entryId comes back')
      assertEqual(second.entryHash, first.entryHash, 'the original entryHash comes back')

      const headAfterReplay = await fixture.store.head(fixture.sessionId)
      if (headAfterReplay === null) fail('head row vanished')
      assertEqual(
        headAfterReplay.lastEntryId,
        headAfterFirst.lastEntryId,
        'last_entry_id did not move',
      )
      assertEqual(headAfterReplay.entryCount, headAfterFirst.entryCount, 'entry_count did not move')

      const entries = await readAll(fixture.store, fixture.sessionId)
      assertEqual(entries.length, 2, 'no second row was written')
      assertEqual(
        entries.map((entry) => entry.entryId),
        [1, 2],
        'the id sequence has no holes: the idempotent branch allocated nothing',
      )
      assertEqual(
        counts.get(`message/user#${first.entryId}`),
        1,
        'the reducer ran exactly once for the message fact',
      )
      // A third write, in a batch with a genuinely new fact: the batch must not become a conflict.
      const mixed = await appendAll(fixture, [
        userMessage(fixture, messageId, 0, 'resend me'),
        extFact(fixture, 1),
      ])
      assertEqual(
        mixed.map((result) => result.created),
        [false, true],
        'an idempotent hit next to a new fact in one batch',
      )
    },
  )

  add('the same key with different content is a conflict, whatever differs', async (open) => {
    const fixture = await open()
    const messageId = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      userMessage(fixture, messageId, 0, 'original'),
    ])
    const key = messageRevisionKey(messageId, 0)
    const before = await readAll(fixture.store, fixture.sessionId)

    await assertRejects(
      () =>
        appendAll(fixture, [
          write('message', 'message/user', {
            sourceType: 'message',
            sourceId: messageId,
            sourceSeq: 0,
            provenanceKey: key,
            payload: {
              messageId,
              revision: 0,
              role: 'user',
              content: [{ type: 'text', text: 'edited without a new revision' }],
              status: 'complete',
            },
            createdAt: fixture.at(),
          }),
        ]),
      TapeProvenanceConflictError,
      'same key, different payload',
    )
    // A different name and kind conflicts too (this one's payload differs as well — the case below
    // isolates each identity column with bytes that are identical).
    await assertRejects(
      () =>
        appendAll(fixture, [
          write('message', 'message/assistant', {
            sourceType: 'message',
            sourceId: messageId,
            sourceSeq: 0,
            provenanceKey: key,
            payload: {
              messageId,
              revision: 0,
              role: 'assistant',
              runId: fixture.ids.uuid(),
              content: [{ type: 'text', text: 'original' }],
              status: 'complete',
            },
            createdAt: fixture.at(),
          }),
        ]),
      TapeProvenanceConflictError,
      'same key, different name and kind',
    )
    await assertRejects(
      () =>
        appendAll(fixture, [
          write('message', 'message/user', {
            sourceType: 'message',
            sourceId: fixture.ids.uuid(),
            sourceSeq: 0,
            provenanceKey: key,
            payload: {
              messageId,
              revision: 0,
              role: 'user',
              content: [{ type: 'text', text: 'original' }],
              status: 'complete',
            },
            createdAt: fixture.at(),
          }),
        ]),
      TapeProvenanceConflictError,
      'same key and payload, different sourceId',
    )
    assertEqual(await readAll(fixture.store, fixture.sessionId), before, 'the tape is unchanged')
  })

  add('the comparison covers every identity column, not just the content hash', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    // One `ext/<owner>/…` fact, then the same key with a BYTE-IDENTICAL payload and exactly one
    // identity column changed. Identical bytes are the point: the content hash alone cannot tell
    // these apart, so each branch reaches a different half of the comparison (spec 01 §存储端口:
    // `content_hash` AND kind, name, source_type, source_id, source_seq).
    const base = write(null, 'ext/acme/note', {
      kind: 'event',
      sourceType: 'session',
      sourceId: fixture.sessionId,
      sourceSeq: 0,
      provenanceKey: 'ext:v1:acme:identity',
      payload: { note: 'unchanged bytes' },
      createdAt: fixture.at(),
    })
    await appendAll(fixture, [base])
    const before = await readAll(fixture.store, fixture.sessionId)
    const variants: readonly (readonly [string, NewEntry])[] = [
      ['kind', { ...base, kind: 'message' }],
      ['name', { ...base, name: 'ext/acme/other' }],
      ['sourceType', { ...base, sourceType: 'summary' }],
      ['sourceId', { ...base, sourceId: fixture.ids.uuid() }],
      ['sourceSeq', { ...base, sourceSeq: 7 }],
      ['payload', { ...base, payload: { note: 'different bytes' } }],
    ]
    for (const [column, variant] of variants) {
      // oxlint-disable-next-line no-await-in-loop -- one rejection asserted per column, in order
      await assertRejects(
        () => appendAll(fixture, [variant]),
        TapeProvenanceConflictError,
        `same key, only ${column} differs`,
      )
    }
    // And a replay with a LATER clock is still the same fact: created_at is deliberately not compared.
    const replay = await appendAll(fixture, [{ ...base, createdAt: fixture.at() }])
    assertEqual(replay[0]?.created, false, 'a later created_at does not make it a new fact')
    assertEqual(await readAll(fixture.store, fixture.sessionId), before, 'the tape is unchanged')
  })

  add('a duplicate key inside one batch rejects the whole batch', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    const headBefore = await fixture.store.head(fixture.sessionId)
    if (headBefore === null) fail('head row is missing')
    const messageId = fixture.ids.uuid()
    await assertRejects(
      () =>
        appendAll(fixture, [
          userMessage(fixture, messageId, 0, 'twice'),
          userMessage(fixture, messageId, 0, 'twice'),
        ]),
      TapeProvenanceConflictError,
      'two facts with one provenance key in one batch',
    )
    assertEqual(
      (await readAll(fixture.store, fixture.sessionId)).length,
      1,
      'neither of the two was written',
    )
    assertEqual(await fixture.store.head(fixture.sessionId), headBefore, 'the head did not move')
  })

  add('a failing second entry leaves the first unwritten and the store usable', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    const headBefore = await fixture.store.head(fixture.sessionId)
    if (headBefore === null) fail('head row is missing')
    const conflicting = fixture.ids.uuid()
    await appendAll(fixture, [userMessage(fixture, conflicting, 0, 'already here')])
    const headAfterSetup = await fixture.store.head(fixture.sessionId)
    if (headAfterSetup === null) fail('head row is missing')

    const survivor = fixture.ids.uuid()
    await assertRejects(
      () =>
        appendAll(fixture, [
          userMessage(fixture, survivor, 0, 'first of the failing batch'),
          // Same key as the fact above with a different payload: the second entry aborts the batch.
          write('message', 'message/user', {
            sourceType: 'message',
            sourceId: conflicting,
            sourceSeq: 0,
            provenanceKey: messageRevisionKey(conflicting, 0),
            payload: {
              messageId: conflicting,
              revision: 0,
              role: 'user',
              content: [{ type: 'text', text: 'different' }],
              status: 'complete',
            },
            createdAt: fixture.at(),
          }),
        ]),
      TapeProvenanceConflictError,
      'the second entry of the batch conflicts',
    )
    const entries = await readAll(fixture.store, fixture.sessionId)
    assertEqual(entries.length, 2, "the batch's first entry did not land")
    assertEqual(
      await fixture.store.head(fixture.sessionId),
      headAfterSetup,
      'the head is untouched',
    )
    assertEqual(
      (await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: 10 })).length,
      1,
      'no projection row from the aborted batch',
    )
    // The store rolled back rather than leaving a transaction open.
    const afterwards = await appendAll(fixture, [userMessage(fixture, survivor, 0, 'retry')])
    const receipt = afterwards[0]
    if (receipt === undefined) fail('the retry returned no receipt')
    assertTrue(receipt.created, 'the same store still appends after a failed batch')
  })

  // ----- acceptance 13 / invariant 14: the store's own append gate -------------------------------

  add('the store refuses a reserved name and a malformed key on its own', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    const before = await readAll(fixture.store, fixture.sessionId)
    // Every attempt goes STRAIGHT at the port, as a test double or a second facade would. The gate is
    // a two-way assertion and the spec puts every store behind it (§保留命名空间), so this half cannot
    // live in the facade's tests alone: the slice half is the facade's, this half is every store's.
    const refused: readonly (readonly [string, ErrorClass, NewEntry])[] = [
      [
        'an undeclared sibling under a reserved prefix',
        TapeAppendAuthorizationError,
        {
          kind: 'event',
          name: 'execution/anything',
          sourceType: 'runtime_event',
          sourceId: fixture.sessionId,
          provenanceKey: 'execution:v1:anything',
          payload: {},
          createdAt: fixture.at(),
        },
      ],
      [
        'an exactly reserved, declared name with the wrong kind',
        TapeAppendAuthorizationError,
        {
          kind: 'event',
          name: 'message/user',
          sourceType: 'message',
          sourceId: fixture.sessionId,
          sourceSeq: 0,
          provenanceKey: messageRevisionKey(fixture.sessionId, 0),
          payload: {},
          createdAt: fixture.at(),
        },
      ],
      [
        'a declared name with the wrong identity triple',
        TapeAppendAuthorizationError,
        {
          kind: 'anchor',
          name: 'session/start',
          sourceType: 'runtime_event',
          sourceId: fixture.sessionId,
          sourceSeq: 0,
          provenanceKey: sessionStartKey(fixture.incarnationId),
          payload: {},
          createdAt: fixture.at(),
        },
      ],
      [
        'the context kind outside skill/',
        TapeAppendAuthorizationError,
        {
          kind: 'context',
          name: 'ext/acme/note',
          sourceType: 'session',
          sourceId: fixture.sessionId,
          provenanceKey: 'ext:v1:acme:context',
          payload: {},
          createdAt: fixture.at(),
        },
      ],
      [
        'a provenance key with a timestamp in it',
        TapeProvenanceSyntaxError,
        { ...extFact(fixture, 1), provenanceKey: 'ext:v1:acme:note.2026-09-21T10:00:00Z' },
      ],
    ]
    for (const [description, expected, entry] of refused) {
      // oxlint-disable-next-line no-await-in-loop -- one rejection asserted per attempt, in order
      await assertRejects(
        () =>
          fixture.store.append({
            sessionId: fixture.sessionId,
            incarnationId: fixture.incarnationId,
            entries: [entry],
          }),
        expected,
        `the store accepted ${description}`,
      )
    }
    // A batch is validated as a whole, so one bad entry keeps the good one out too.
    await assertRejects(
      () =>
        fixture.store.append({
          sessionId: fixture.sessionId,
          incarnationId: fixture.incarnationId,
          entries: [extFact(fixture, 2), { ...extFact(fixture, 3), name: 'view/assembled' }],
        }),
      TapeAppendAuthorizationError,
      'a batch whose second entry is unauthorised',
    )
    assertEqual(await readAll(fixture.store, fixture.sessionId), before, 'nothing was written')
  })

  // ----- acceptance 15: bounded reads, pinning, no host types ------------------------------------

  add('reads are bounded: a limit above the ceiling is refused', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    await assertRejects(
      () => fixture.store.readRange({ sessionId: fixture.sessionId, limit: MAX_READ_LIMIT + 1 }),
      TapeReadLimitError,
      'readRange above the ceiling',
    )
    await assertRejects(
      () =>
        fixture.store.readBySource({
          sessionId: fixture.sessionId,
          sourceType: 'session',
          sourceId: fixture.sessionId,
          limit: MAX_READ_LIMIT + 1,
        }),
      TapeReadLimitError,
      'readBySource above the ceiling',
    )
    await assertRejects(
      () => fixture.store.verifyChain({ sessionId: fixture.sessionId, limit: MAX_READ_LIMIT + 1 }),
      TapeReadLimitError,
      'verifyChain above the ceiling',
    )
    await assertRejects(
      () => fixture.store.listMessages({ sessionId: fixture.sessionId, limit: MAX_READ_LIMIT + 1 }),
      TapeReadLimitError,
      'listMessages above the ceiling',
    )
    await assertRejects(
      () => fixture.store.listSessions({ limit: MAX_READ_LIMIT + 1 }),
      TapeReadLimitError,
      'listSessions above the ceiling',
    )
    // The floor and the integers, not only the ceiling: zero rows and half a row are answers a store
    // would otherwise have to invent.
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      // oxlint-disable-next-line no-await-in-loop -- one rejection asserted per limit, in order
      await assertRejects(
        () => fixture.store.readRange({ sessionId: fixture.sessionId, limit }),
        TapeReadLimitError,
        `readRange with limit ${String(limit)}`,
      )
    }
    // An EMPTY kinds filter means neither "nothing" nor "everything" — it is refused, so the two
    // stores cannot settle on opposite readings (`kind IN ()` is not even valid SQL).
    await assertRejects(
      () => fixture.store.readRange({ sessionId: fixture.sessionId, limit: 10, kinds: [] }),
      TypeError,
      'readRange with an empty kinds filter',
    )
  })

  add('readRange filters by kind, and readBySource caps its page', async (open) => {
    const fixture = await open()
    const runId = fixture.ids.uuid()
    const messageId = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId), // 1 · anchor
      modelSelected(fixture, runId), // 2 · event
      userMessage(fixture, messageId, 0, 'filtered'), // 3 · message
      attemptCompleted(fixture, runId, 0), // 4 · event
      assistantMessage(fixture, fixture.ids.uuid(), 0, runId, 'filtered too'), // 5 · message
    ])
    const idsOf = async (kinds: readonly TapeKind[], limit = 10): Promise<number[]> =>
      (await fixture.store.readRange({ sessionId: fixture.sessionId, limit, kinds })).entries.map(
        (entry) => entry.entryId,
      )
    // One kind and several kinds are two different query shapes in SQLite (§存储端口: a single kind
    // goes through `tape_entry_by_kind`, several scan the primary key), and replay depends on this
    // filter — it reads `kinds: REPLAY_KINDS` and nothing else.
    assertEqual(await idsOf(['message']), [3, 5], 'a single kind')
    assertEqual(await idsOf(['message', 'anchor']), [1, 3, 5], 'several kinds')
    assertEqual(await idsOf(['tool_call']), [], 'a kind with no rows')
    // Paging happens over the FILTERED set, not over the rows the filter skipped.
    const firstPage = await fixture.store.readRange({
      sessionId: fixture.sessionId,
      limit: 1,
      kinds: ['message'],
    })
    assertEqual(
      firstPage.entries.map((entry) => entry.entryId),
      [3],
      'the first filtered page',
    )
    if (firstPage.nextFromEntryId === null) fail('the filtered read stopped paging too early')
    const secondPage = await fixture.store.readRange({
      sessionId: fixture.sessionId,
      limit: 1,
      kinds: ['message'],
      fromEntryId: firstPage.nextFromEntryId,
    })
    assertEqual(
      secondPage.entries.map((entry) => entry.entryId),
      [5],
      'the second filtered page continues from the cursor',
    )
    // And `readBySource` is bounded as well (invariant 16): its limit is a cap, not a hint.
    await appendAll(fixture, [
      attemptCompleted(fixture, runId, 1),
      attemptCompleted(fixture, runId, 2),
    ])
    const capped = await fixture.store.readBySource({
      sessionId: fixture.sessionId,
      sourceType: 'runtime_event',
      sourceId: runId,
      limit: 2,
    })
    assertEqual(
      capped.map((entry) => entry.sourceSeq),
      [0, 1],
      'readBySource returns at most `limit` rows, in entry_id order',
    )
  })

  add('a page is full or final, and an exact multiple ends on an empty page', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      extFact(fixture, 1),
      extFact(fixture, 2),
      extFact(fixture, 3),
    ])
    const pages: (readonly [readonly number[], number | null])[] = []
    let fromEntryId: number | undefined
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
      const page = await fixture.store.readRange({
        sessionId: fixture.sessionId,
        limit: 2,
        ...(fromEntryId === undefined ? {} : { fromEntryId }),
      })
      pages.push([page.entries.map((entry) => entry.entryId), page.nextFromEntryId])
      if (page.nextFromEntryId === null) break
      fromEntryId = page.nextFromEntryId
    }
    // Four facts at two per page: a FULL page always says "there may be more", so the count being an
    // exact multiple of the limit costs one empty final page. Guessing instead — "a full page that
    // happens to end at the last row is final" — cannot be done without a second query.
    assertEqual(
      pages,
      [
        [[1, 2], 3],
        [[3, 4], 5],
        [[], null],
      ],
      'the paging rule, including the empty final page',
    )
  })

  add('a paged read pinned at atEntryId equals a snapshot taken beforehand', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    // 5000 facts, appended in batches so the setup is one transaction per 250 rather than per fact.
    const total = 5000
    const batchSize = 250
    for (let base = 0; base < total; base += batchSize) {
      const batch: NewEntry[] = []
      for (let offset = 0; offset < batchSize; offset += 1) {
        batch.push(extFact(fixture, base + offset))
      }
      // oxlint-disable-next-line no-await-in-loop -- each batch is its own transaction, in order
      await appendAll(fixture, batch)
    }
    const head = await fixture.store.head(fixture.sessionId)
    if (head === null) fail('head row is missing')
    assertEqual(head.entryCount, total + 1, 'every fact landed')
    const pinnedAt = head.lastEntryId
    const snapshot = await readAll(fixture.store, fixture.sessionId, { atEntryId: pinnedAt })
    assertEqual(snapshot.length, total + 1, 'the snapshot holds the whole session')

    // Now read it again page by page, appending between pages: the pin must keep them out.
    const paged: TapeEntry[] = []
    let fromEntryId: number | undefined
    let incarnationId: string | undefined
    let interleaved = 0
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
      const page = await fixture.store.readRange({
        sessionId: fixture.sessionId,
        atEntryId: pinnedAt,
        limit: MAX_READ_LIMIT,
        ...(fromEntryId === undefined ? {} : { fromEntryId }),
        ...(incarnationId === undefined ? {} : { incarnationId }),
      })
      paged.push(...page.entries)
      incarnationId = page.incarnationId
      interleaved += 1
      // oxlint-disable-next-line no-await-in-loop -- the append has to land BETWEEN two pages
      await appendAll(fixture, [extFact(fixture, total + interleaved)])
      if (page.nextFromEntryId === null) break
      fromEntryId = page.nextFromEntryId
    }
    assertTrue(interleaved > 1, 'the session was read in more than one page')
    assertEqual(
      paged,
      snapshot,
      'the paged read equals the snapshot despite the appends between pages',
    )
    assertPortSafe(paged, 'readRange')
    assertPortSafe(await fixture.store.head(fixture.sessionId), 'head')
    assertPortSafe(
      await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: 5 }),
      'listMessages',
    )
    assertPortSafe(await fixture.store.listSessions({ limit: 5 }), 'listSessions')
  })

  // ----- invariant 13: the chain ----------------------------------------------------------------

  add(
    'entry hashes recompute from what the port returns and the head names the last one',
    async (open) => {
      const fixture = await open()
      const runId = fixture.ids.uuid()
      const messageId = fixture.ids.uuid()
      await appendAll(fixture, [
        startEntry(fixture, fixture.incarnationId),
        modelSelected(fixture, runId),
        userMessage(fixture, messageId, 0, 'hash me'),
        attemptCompleted(fixture, runId, 0),
      ])
      const entries = await readAll(fixture.store, fixture.sessionId)
      let previous: Uint8Array | null = null
      for (const entry of entries) {
        const digest = contentHash(canonicalJson(entry.payload), canonicalJson(entry.meta))
        assertEqual(digest, entry.contentHash, `content_hash of entry ${entry.entryId}`)
        assertEqual(entry.prevHash, previous, `prev_hash of entry ${entry.entryId} links the chain`)
        const sealed = hashEntry({
          hashVer: entry.hashVer,
          tenantId: entry.tenantId,
          sessionId: entry.sessionId,
          incarnationId: entry.incarnationId,
          entryId: entry.entryId,
          kind: entry.kind,
          name: entry.name,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          sourceSeq: entry.sourceSeq,
          provenanceKey: entry.provenanceKey,
          createdAt: entry.createdAt,
          contentHash: entry.contentHash,
          prevHash: entry.prevHash,
        })
        assertEqual(sealed, entry.entryHash, `entry_hash of entry ${entry.entryId}`)
        previous = entry.entryHash
      }
      const head = await fixture.store.head(fixture.sessionId)
      if (head === null) fail('head row is missing')
      assertEqual(head.lastHash, previous, "head.lastHash is the last entry's hash")

      const verified = await fixture.store.verifyChain({ sessionId: fixture.sessionId, limit: 2 })
      assertEqual(verified.firstBadEntryId, null, 'a healthy chain reports no bad link')
      assertEqual(verified.checked, 2, 'verifyChain honours its limit')
      assertEqual(verified.incarnationId, head.incarnationId, 'verifyChain reports the incarnation')
      if (verified.nextFromEntryId === null) fail('verifyChain stopped paging too early')
      const rest = await fixture.store.verifyChain({
        sessionId: fixture.sessionId,
        fromEntryId: verified.nextFromEntryId,
        incarnationId: verified.incarnationId,
        limit: MAX_READ_LIMIT,
      })
      assertEqual(rest.firstBadEntryId, null, 'the second page is healthy too')
      assertEqual(rest.checked, entries.length - 2, 'the two pages cover every entry')
    },
  )

  // ----- acceptance 3, projection half ----------------------------------------------------------

  add('a rebuilt projection equals the incrementally written one, row by row', async (open) => {
    const fixture = await open()
    const runOne = fixture.ids.uuid()
    const runTwo = fixture.ids.uuid()
    const firstUser = fixture.ids.uuid()
    const firstAssistant = fixture.ids.uuid()
    const secondUser = fixture.ids.uuid()
    const secondAssistant = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      modelSelected(fixture, runOne),
      userMessage(fixture, firstUser, 0, 'first question'),
      assistantMessage(fixture, firstAssistant, 0, runOne, 'first answer'),
      attemptCompleted(fixture, runOne, 0),
    ])
    await appendAll(fixture, [
      modelSelected(fixture, runTwo),
      userMessage(fixture, secondUser, 0, 'second question'),
      assistantMessage(fixture, secondAssistant, 0, runTwo, 'second answer'),
      attemptCompleted(fixture, runTwo, 0),
    ])
    // One revision of the first question and one retraction of the second answer.
    await appendAll(fixture, [userMessage(fixture, firstUser, 1, 'first question, edited')])
    await appendAll(fixture, [retraction(fixture, secondAssistant)])

    const incremental = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: MAX_READ_LIMIT,
    })
    assertEqual(
      incremental.map((row) => row.messageId),
      [firstUser, firstAssistant, secondUser],
      'the retracted message is gone and order_seq still orders by first appearance',
    )
    const revised = incremental[0]
    if (revised === undefined) fail('the revised message is missing')
    assertEqual(revised.orderSeq, 3, 'order_seq is the entry id of the FIRST fact of the message')
    assertTrue(revised.entryId > revised.orderSeq, 'entry_id moved to the revision')
    assertEqual(revised.createdAt < revised.updatedAt, true, 'created_at did not move with it')
    assertEqual(
      revised.content,
      [{ type: 'text', text: 'first question, edited' }],
      'the row carries the latest revision',
    )

    const sessionsBefore = await fixture.store.listSessions({ limit: MAX_READ_LIMIT })
    const summaryBefore = sessionsBefore.find((row) => row.sessionId === fixture.sessionId)
    if (summaryBefore === undefined) fail('the session summary is missing')
    assertEqual(summaryBefore.providerId, 'anthropic', 'session_projection carries the provider')
    assertEqual(summaryBefore.modelId, 'claude-test', 'session_projection carries the model')
    assertEqual(summaryBefore.title, null, 'phase 1 never writes a title')

    await fixture.store.rebuildProjections(fixture.sessionId)
    const rebuilt = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: MAX_READ_LIMIT,
    })
    assertEqual(rebuilt, incremental, 'message_projection rebuilt from the facts, row by row')
    const summaryAfter = (await fixture.store.listSessions({ limit: MAX_READ_LIMIT })).find(
      (row) => row.sessionId === fixture.sessionId,
    )
    assertEqual(summaryAfter, summaryBefore, 'session_projection rebuilt from the facts')

    // The cursor half of the same property: a second rebuild is a no-op, not a doubling.
    await fixture.store.rebuildProjections(fixture.sessionId)
    assertEqual(
      await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: MAX_READ_LIMIT }),
      incremental,
      'rebuilding twice changes nothing',
    )
    await assertRejects(
      () => fixture.store.rebuildProjections(fixture.ids.uuid()),
      TapeSessionNotFoundError,
      'rebuilding a session that has no head row',
    )
  })

  add('a revision after a retraction resurrects the row at its own order_seq', async (open) => {
    const fixture = await open()
    const retracted = fixture.ids.uuid()
    const neighbour = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId), // 1
      userMessage(fixture, retracted, 0, 'the first question'), // 2
      userMessage(fixture, neighbour, 0, 'the second question'), // 3
      retraction(fixture, retracted), // 4 · deletes the row (§删除语义)
      userMessage(fixture, retracted, 1, 'edited after deleting'), // 5 · re-inserts it
    ])
    const rows = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: MAX_READ_LIMIT,
    })
    // A RECORDED GAP, pinned so both stores answer alike and nobody closes it by accident. §投影与重放
    // says a retraction does not move `order_seq`, while §删除语义 says it deletes the row — and a
    // reducer that cannot read the current row has nothing left to restore the original id from, so
    // the revision inserts afresh at its own entry id and the message moves to the end. The fold
    // (`effectiveMessages`, pinned in test/tape/replay.test.ts) keeps it at 2, so the interface's
    // order and the model's context order differ for this one sequence. Phase 1 has no writer for it —
    // edit and delete are phase 6, and regenerate retracts and then runs with NEW messageIds — and
    // closing it takes a spec decision (a visibility column, or a fold that makes retraction final).
    assertEqual(
      rows.map((row) => [row.messageId, row.orderSeq]),
      [
        [neighbour, 3],
        [retracted, 5],
      ],
      'the resurrected message sits after its neighbour, at the revision entry id',
    )
    // Whatever the answer is, a rebuild from the facts must reproduce it (invariant 12).
    await fixture.store.rebuildProjections(fixture.sessionId)
    assertEqual(
      await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: MAX_READ_LIMIT }),
      rows,
      'a rebuild reaches the same rows through the same ops',
    )
  })

  add('listMessages returns the latest rows without a cursor and pages with one', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    const messageIds: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const messageId = fixture.ids.uuid()
      messageIds.push(messageId)
      // oxlint-disable-next-line no-await-in-loop -- one transaction per message, in order
      await appendAll(fixture, [userMessage(fixture, messageId, 0, `message ${index}`)])
    }
    const tail = await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: 2 })
    assertEqual(
      tail.map((row) => row.messageId),
      messageIds.slice(-2),
      'no cursor means the LATEST rows, in order_seq order',
    )
    const head = tail[0]
    if (head === undefined) fail('the tail page is empty')
    const forward = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: 10,
      afterOrderSeq: head.orderSeq,
    })
    assertEqual(
      forward.map((row) => row.messageId),
      messageIds.slice(-1),
      'afterOrderSeq is exclusive and reads forwards',
    )
    const backward = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: 2,
      beforeOrderSeq: head.orderSeq,
    })
    assertEqual(
      backward.map((row) => row.messageId),
      messageIds.slice(1, 3),
      'beforeOrderSeq is exclusive and reads the rows nearest below it',
    )
  })

  // ----- readBySource, isolation, delete --------------------------------------------------------

  add('readBySource groups a run by its identity columns, in entry_id order', async (open) => {
    const fixture = await open()
    const runId = fixture.ids.uuid()
    const otherRun = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      attemptCompleted(fixture, runId, 0),
      attemptCompleted(fixture, otherRun, 0),
      attemptCompleted(fixture, runId, 1),
    ])
    const facts = await fixture.store.readBySource({
      sessionId: fixture.sessionId,
      sourceType: 'runtime_event',
      sourceId: runId,
      limit: 10,
    })
    assertEqual(
      facts.map((entry) => entry.sourceSeq),
      [0, 1],
      'only this run, ordered by entry_id',
    )
    assertEqual(
      facts.map((entry) => entry.entryId),
      [2, 4],
      'entry_id order, not source_seq order',
    )
  })

  add('sessions are isolated: separate id sequences and separate chains', async (open) => {
    const fixture = await open()
    const otherSession = fixture.ids.uuid()
    const otherIncarnation = fixture.ids.uuid()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId), extFact(fixture, 1)])
    await fixture.store.append({
      sessionId: otherSession,
      incarnationId: otherIncarnation,
      entries: [
        write('session', 'session/start', {
          sourceType: 'session',
          sourceId: otherSession,
          sourceSeq: 0,
          provenanceKey: sessionStartKey(otherIncarnation),
          payload: { incarnationId: otherIncarnation },
          createdAt: fixture.at(),
        }),
      ],
    })
    const other = await fixture.store.head(otherSession)
    if (other === null) fail('the second session has no head row')
    assertEqual(other.lastEntryId, 1, 'each session allocates ids from its own high-water mark')
    const mine = await readAll(fixture.store, fixture.sessionId)
    assertEqual(mine.length, 2, 'the second session did not leak into the first')
    const theirs = await readAll(fixture.store, otherSession)
    assertEqual(theirs.length, 1, 'and the first did not leak into the second')
    const anchor = theirs[0]
    if (anchor === undefined) fail('the second session has no anchor')
    assertEqual(anchor.prevHash, null, 'each session starts its own chain')
  })

  add('deleteSession removes the facts, the head and the projections', async (open) => {
    const fixture = await open()
    const messageId = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      userMessage(fixture, messageId, 0, 'delete me'),
    ])
    await fixture.store.deleteSession(fixture.sessionId)
    assertEqual(await fixture.store.head(fixture.sessionId), null, 'the head row is gone')
    assertEqual((await readAll(fixture.store, fixture.sessionId)).length, 0, 'the facts are gone')
    const rows: MessageRow[] = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: 10,
    })
    assertEqual(rows.length, 0, 'the message projection is gone')
    assertEqual(
      (await fixture.store.listSessions({ limit: MAX_READ_LIMIT })).filter(
        (row) => row.sessionId === fixture.sessionId,
      ).length,
      0,
      'the session projection is gone',
    )
    // Deleting a session that is not there changes nothing and does not throw.
    await fixture.store.deleteSession(fixture.ids.uuid())
  })

  add('a session this store cannot see reads as absent, never as an error', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    // A store cannot tell "another tenant's session" from "never existed", and acceptance 4 needs the
    // first to look exactly like the second: empty reads, a null head, no throw. Only the two writes
    // that would otherwise conjure a session up are errors (`resetSession`, `rebuildProjections`).
    const unknown = fixture.ids.uuid()
    assertEqual(
      await fixture.store.readRange({ sessionId: unknown, limit: 10 }),
      { entries: [], incarnationId: '', nextFromEntryId: null },
      'readRange of an unknown session',
    )
    assertEqual(
      await fixture.store.readBySource({
        sessionId: unknown,
        sourceType: 'runtime_event',
        sourceId: unknown,
        limit: 10,
      }),
      [],
      'readBySource of an unknown session',
    )
    assertEqual(await fixture.store.head(unknown), null, 'head of an unknown session')
    assertEqual(
      await fixture.store.verifyChain({ sessionId: unknown, limit: 10 }),
      { incarnationId: '', checked: 0, firstBadEntryId: null, nextFromEntryId: null },
      'verifyChain of an unknown session',
    )
    assertEqual(
      await fixture.store.listMessages({ sessionId: unknown, limit: 10 }),
      [],
      'listMessages of an unknown session',
    )
  })

  add('listSessions breaks a tie on session id by code unit, not by locale', async (open) => {
    const fixture = await open()
    // Equal `updatedAt` is the only case where the tie-break is observable, and the two stores must
    // agree: SQLite orders TEXT with BINARY collation, so the memory store compares code units rather
    // than calling `localeCompare` (whose answer here is ['a-1', 'B-1'] and also depends on the
    // runtime's ICU build). The port accepts any non-empty string as a session id, so this is
    // reachable without a non-canonical UUID.
    const at = 1_700_000_777_000
    for (const sessionId of ['a-1', 'B-1']) {
      const incarnationId = fixture.ids.uuid()
      // oxlint-disable-next-line no-await-in-loop -- one session per transaction, in order
      await fixture.store.append({
        sessionId,
        incarnationId,
        entries: [
          write('session', 'session/start', {
            sourceType: 'session',
            sourceId: sessionId,
            sourceSeq: 0,
            provenanceKey: sessionStartKey(incarnationId),
            payload: { incarnationId },
            // The SAME timestamp for both, or there is no tie to break.
            createdAt: at,
          }),
        ],
      })
    }
    const rows = await fixture.store.listSessions({ limit: MAX_READ_LIMIT })
    assertEqual(
      rows.map((row) => row.sessionId),
      ['B-1', 'a-1'],
      'uppercase sorts before lowercase, as SQLite BINARY does',
    )
  })

  return cases
}
