/**
 * Startup recovery (spec 02 §启动恢复与发送防护, §执行日志与恢复表; plan step 16: 旧 119, 旧 120,
 * 旧 121, 旧 168, 旧 171, the resumable items, stopping one, `approval.list`, `session.latest`).
 *
 * A crash is a store that fails every append from a chosen batch on — the process died there; a
 * restart is a new service on the same store, with ids that do not repeat the old one's. Sub-agent
 * sessions and the hand-off class are plan step 31's.
 */
import { describe, expect, it } from 'vitest'
import {
  ProviderConfigMissingError,
  TapeProvenanceConflictError,
  createMemoryHost,
  createMemoryTapeStore,
} from '../../src/index.js'
import type {
  InspectorRegistration,
  MemoryHost,
  ModelInfo,
  NewEntry,
  SessionEvent,
  SessionService,
  StreamEvent,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import { RecoveryCorruptionError } from '../../src/loop/recovery.js'
import {
  dispatchCommittedKey,
  messageRevisionKey,
  profileSetKey,
} from '../../src/tape/provenance.js'
import { createTape } from '../../src/tape/tape.js'
import {
  assertToolPairing,
  createCounterIds,
  createFakeInspector,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type {
  FakeInspector,
  RecordedRequest,
  ScriptedProvider,
  TestLoopPorts,
  TestToolRegistry,
} from '../../src/testing/index.js'
import { LOOK, lookSource, proxyStore } from './support.js'

const IDENTITY = {
  userId: 'recover-user',
  tenantId: 'recover-tenant',
  profileDir: '/tenon/recover',
}
const SESSION = '8e5f9a2e-6b3d-4a71-9f52-0c8de7a11b3a'

const MODEL: ModelInfo = {
  id: 'claude-recover-1',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}

const USAGE: Usage = {
  inputTokens: 9,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

const ASK = { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] } as const
const DENY = { kind: 'deny', category: 'exfiltration', findings: [{ code: 'test' }] } as const

type RunEnded = Extract<SessionEvent, { type: 'run-ended' }>

interface Service {
  readonly memory: MemoryHost
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  readonly executed: Record<string, unknown>[]
  readonly inspector: FakeInspector
  readonly logs: string[]
}

interface ServiceOptions {
  readonly idsFrom?: number
  readonly tools?: TestToolRegistry
  readonly repair?: boolean
  readonly inspector?: FakeInspector
  readonly extraInspectors?: readonly InspectorRegistration[]
  /** Runs while a call executes. */
  readonly during?: () => void
}

/** One process's service on the store: a new one is a restart. */
function service(store: TapeStore, o: ServiceOptions = {}): Service {
  const memory = createMemoryHost()
  const provider = createScriptedProvider({ models: [MODEL] })
  const executed: Record<string, unknown>[] = []
  const inspector = o.inspector ?? createFakeInspector({ id: 'asker', ceiling: 'ask', answer: ASK })
  const logs: string[] = []
  const loop = createTestLoopPorts({
    connector: { provider, model: MODEL, mcpSources: [lookSource(executed, o.during)] },
  })
  const built = createTestSessionService(
    {
      host: memory,
      tape: store,
      ids: createCounterIds({ start: o.idsFrom ?? 1 }),
      inspectors: [inspector.registration, ...(o.extraInspectors ?? [])],
      connector: loop.connector,
      protectedFiles: [],
      log: (line) => logs.push(line),
      ...(o.repair === true ? { onUnansweredCall: 'repair' as const } : {}),
    },
    { tools: o.tools ?? {}, userSetting: () => ({ userSetting: 'always-allow' }) },
  )
  built.bindLoop(loop)
  return { memory, service: built, loop, provider, executed, inspector, logs }
}

/** A store that dies at the first batch `when` picks: that append and every later one fail. */
function dying(when: (batch: readonly NewEntry[]) => boolean): {
  store: TapeStore
  inner: TapeStore
  dead: () => boolean
} {
  const inner = createMemoryTapeStore({ identity: IDENTITY })
  let dead = false
  const store = proxyStore(inner, {
    append: (batch) => {
      if (dead || when(batch.entries)) {
        dead = true
        return Promise.reject(new Error('the process died here'))
      }
      return inner.append(batch)
    },
  })
  return { store, inner, dead: () => dead }
}

const has =
  (name: string) =>
  (batch: readonly NewEntry[]): boolean =>
    batch.some((entry) => entry.name === name)

/** The stream events of `fs__look` calls, the first at block `from`. */
function callEvents(ats: readonly string[], from = 1): StreamEvent[] {
  return ats.flatMap((at, i): StreamEvent[] => {
    const index = from + i
    const id = `toolu_${at}`
    return [
      { type: 'tool-call-start', index, id, name: LOOK },
      { type: 'tool-call-end', index, id, name: LOOK, input: { at } },
    ]
  })
}

function calls(...ats: readonly string[]): StreamEvent[] {
  return [...callEvents(ats), { type: 'usage', usage: USAGE }, stopEvent('tool-use', 'tool_use')]
}

const done = (): StreamEvent[] => scriptedTurn({ deltas: ['Done.'], usage: USAGE })

let texts = 0

async function send(s: Service, text = `message ${String((texts += 1))}`): Promise<RunEnded> {
  const sent = await s.service.send({ sessionId: SESSION, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return s.loop.runEnded({ runId: sent.runId })
}

async function requestIdOf(s: Service): Promise<string> {
  const card = await s.service.currentPending({ sessionId: SESSION })
  if (card === null) throw new Error('no card')
  return card.card.requestId
}

function allow(s: Service, requestId: string) {
  return s.service.answer({
    kind: 'approval',
    sessionId: SESSION,
    requestId,
    decision: 'allow',
    origin: null,
  })
}

async function all(store: TapeStore): Promise<TapeEntry[]> {
  return (await store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}

async function everything(store: TapeStore): Promise<TapeEntry[]> {
  const entries: TapeEntry[] = []
  let fromEntryId: number | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- paged
    const page = await store.readRange({
      sessionId: SESSION,
      limit: 1000,
      ...(fromEntryId === undefined ? {} : { fromEntryId }),
    })
    entries.push(...page.entries)
    if (page.nextFromEntryId === null) return entries
    fromEntryId = page.nextFromEntryId
  }
}

function named(entries: readonly TapeEntry[], name: string): TapeEntry[] {
  return entries.filter((entry) => entry.name === name)
}

function outcomes(entries: readonly TapeEntry[]): string[] {
  return named(entries, 'execution/tool_outcome').map(
    (entry) =>
      `${String(entry.payload['ordinal'])}:${String(entry.payload['state'])}/${String(entry.payload['source'])}`,
  )
}

function terminals(entries: readonly TapeEntry[]): string[] {
  return named(entries, 'execution/run_terminal').map(
    (entry) =>
      `${(entry.payload['reason'] as { code: string }).code}/${(entry.payload['writer'] as { by: string }).by}`,
  )
}

function resolutions(entries: readonly TapeEntry[]): string[] {
  return named(entries, 'tool/approval_resolved').map(
    (entry) =>
      `${String(entry.payload['outcome'])}/${String(entry.payload['via'])}/${(entry.payload['writer'] as { by: string }).by}`,
  )
}

function recorded(s: Service, index: number): RecordedRequest {
  const body = s.provider.requests.at(index)?.body
  return {
    url: 'https://api.anthropic.test/v1/messages',
    method: 'POST',
    headers: {},
    bodyText: JSON.stringify(body),
    body,
  }
}

describe('closing what a crash left open (§执行日志与恢复表)', () => {
  it('closes an approved call that never got its dispatch not-run / crashed, and the Run recovered (旧 120, 旧 171)', async () => {
    const crash = dying(has('execution/dispatch_committed'))
    const before = service(crash.store)
    before.provider.script(calls('a'))
    expect((await send(before)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    expect(await allow(before, await requestIdOf(before))).toEqual({ status: 'applied' })
    expect((await before.loop.runEnded()).recorded).toBe(false)
    expect(crash.dead()).toBe(true)

    const after = service(crash.inner, { idsFrom: 1000 })
    expect(await after.service.recover()).toEqual({ resumable: [], errors: [] })
    const entries = await all(crash.inner)
    expect(outcomes(entries)).toEqual(['0:not-run/crashed'])
    expect(terminals(entries)).toEqual(['paused/run', 'recovered/recovery'])
    expect(before.executed).toEqual([])
    // The next request passes B1's check before it goes out.
    after.provider.script(done())
    expect((await send(after)).reason).toEqual({ code: 'completed' })
    assertToolPairing(recorded(after, -1))
  })

  it('closes a dispatched call with no result uncertain / crashed, and never runs it again (旧 120)', async () => {
    const crash = dying(has('tool/result'))
    const before = service(crash.store)
    before.inspector.answer({ kind: 'none' })
    before.provider.script(calls('a'))
    expect((await send(before)).recorded).toBe(false)
    expect(before.executed).toEqual([{ at: 'a' }])

    const after = service(crash.inner, { idsFrom: 1000 })
    await after.service.recover()
    const entries = await all(crash.inner)
    expect(outcomes(entries)).toEqual(['0:uncertain/crashed'])
    expect(named(entries, 'execution/tool_outcome')[0]?.payload['effect']).toBe('external')
    expect(terminals(entries)).toEqual(['recovered/recovery'])
    after.provider.script(done())
    await send(after)
    expect(after.executed).toEqual([])
    assertToolPairing(recorded(after, -1))
  })

  it('writes the missing outcome of a result as repair, and throws on it in a strict build (旧 120)', async () => {
    let dropped = false
    let dead = false
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = proxyStore(inner, {
      append: (batch) => {
        if (dead) return Promise.reject(new Error('the process died here'))
        if (!dropped && batch.entries.some((entry) => entry.name === 'tool/result')) {
          // The result lands without its outcome, and the process dies right after.
          dropped = true
          dead = true
          return inner.append({
            ...batch,
            entries: batch.entries.filter((entry) => entry.name !== 'execution/tool_outcome'),
          })
        }
        return inner.append(batch)
      },
    })
    const before = service(store)
    before.inspector.answer({ kind: 'none' })
    before.provider.script(calls('a'))
    await send(before)

    await expect(service(inner, { idsFrom: 1000 }).service.recover()).rejects.toBeInstanceOf(
      RecoveryCorruptionError,
    )
    const packaged = service(inner, { idsFrom: 2000, repair: true })
    const recovered = await packaged.service.recover()
    expect(recovered.errors.some((line) => line.includes('broken'))).toBe(true)
    const entries = await all(inner)
    expect(outcomes(entries)).toEqual(['0:uncertain/repair'])
    expect(named(entries, 'tool/result')).toHaveLength(1)
  })

  it('leaves a blocked call as it was: its closure is complete without a dispatch (旧 120)', async () => {
    const deny = createFakeInspector({ id: 'denier', ceiling: 'deny', answer: DENY })
    // The process dies at the second request's assembly: after the denial's closure is written.
    let assemblies = 0
    const crash = dying((batch) => {
      if (batch.some((entry) => entry.name === 'view/assembled')) assemblies += 1
      return assemblies === 2
    })
    const before = service(crash.store, { extraInspectors: [deny.registration] })
    before.inspector.answer({ kind: 'none' })
    before.provider.script(calls('a'))
    expect((await send(before)).recorded).toBe(false)
    const after = service(crash.inner, { idsFrom: 1000 })
    await after.service.recover()
    const entries = await all(crash.inner)
    expect(outcomes(entries)).toEqual(['0:not-run/inspector'])
    expect(named(entries, 'tool/result')).toHaveLength(1)
    expect(terminals(entries)).toEqual(['recovered/recovery'])
  })

  it('keeps a call whose card was committed without its pause: the Run ends paused, the card answerable (旧 121)', async () => {
    let dead = false
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = proxyStore(inner, {
      append: async (batch) => {
        if (dead) throw new Error('the process died here')
        if (batch.entries.some((entry) => entry.name === 'execution/run_terminal')) {
          // Only the asking decision lands; the process dies before the terminal.
          dead = true
          await inner.append({
            ...batch,
            entries: batch.entries.filter((entry) => entry.name !== 'execution/run_terminal'),
          })
          throw new Error('the process died here')
        }
        return inner.append(batch)
      },
    })
    const before = service(store)
    before.provider.script(calls('a'))
    expect((await send(before)).recorded).toBe(false)

    const after = service(inner, { idsFrom: 1000 })
    await after.service.recover()
    const entries = await all(inner)
    expect(outcomes(entries)).toEqual([])
    expect(terminals(entries)).toEqual(['paused/recovery'])
    after.provider.script(done())
    expect(await allow(after, await requestIdOf(after))).toEqual({ status: 'applied' })
    expect((await after.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(after.executed).toEqual([{ at: 'a' }])
  })

  it(
    'reads a Run of more than 1000 facts to its end, and closes every call it left (B5, 旧 121)',
    { timeout: 60_000 },
    async () => {
      let results = 0
      const LAST_BATCH_FIRST_RESULT = 59 * 3 + 1
      const crash = dying((batch) => {
        if (!batch.some((entry) => entry.name === 'tool/result')) return false
        results += 1
        return results === LAST_BATCH_FIRST_RESULT
      })
      const before = service(crash.store)
      before.inspector.answer({ kind: 'none' })
      for (let i = 0; i < 60; i += 1)
        before.provider.script(calls(`${String(i)}a`, `${String(i)}b`, `${String(i)}c`))
      expect((await send(before)).recorded).toBe(false)
      const facts = await crash.inner.readBySource({
        sessionId: SESSION,
        sourceType: 'runtime_event',
        sourceId: String(
          named(await everything(crash.inner), 'execution/run_started')[0]?.sourceId,
        ),
        limit: 1000,
      })
      expect(facts).toHaveLength(1000)

      const after = service(crash.inner, { idsFrom: 5000 })
      await after.service.recover()
      const entries = await everything(crash.inner)
      expect(outcomes(entries).slice(-3)).toEqual([
        '0:uncertain/crashed',
        '1:not-run/crashed',
        '2:not-run/crashed',
      ])
      expect(named(entries, 'tool/result')).toHaveLength(180)
      expect(terminals(entries)).toEqual(['recovered/recovery'])
    },
  )
})

describe('judging a waiting card again at startup (旧 168)', () => {
  /** Pauses on a card for `ats`, then restarts with `change` applied to the new service. */
  async function restartedWith(
    change: 'policy' | 'withdrawn' | 'inspector',
    ats: readonly string[],
  ): Promise<{ store: TapeStore; after: Service }> {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const before = service(store, { tools: {} })
    if (change === 'withdrawn') {
      before.inspector.answer({ kind: 'none' })
      before.provider.script([
        { type: 'tool-call-start', index: 1, id: 'toolu_fetch', name: 'WebFetch' },
        {
          type: 'tool-call-end',
          index: 1,
          id: 'toolu_fetch',
          name: 'WebFetch',
          input: { url: 'https://example.com/' },
        },
        ...callEvents(ats, 2),
        { type: 'usage', usage: USAGE },
        stopEvent('tool-use', 'tool_use'),
      ])
    } else {
      before.provider.script(calls(...ats))
    }
    expect((await send(before)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    const inspector =
      change === 'inspector'
        ? createFakeInspector({ id: 'asker', ceiling: 'deny', answer: DENY })
        : createFakeInspector({ id: 'asker', ceiling: 'ask', answer: { kind: 'none' } })
    const after = service(store, {
      idsFrom: 1000,
      inspector,
      tools: change === 'withdrawn' ? { WebFetch: null } : {},
    })
    if (change === 'policy') {
      after.memory.setPolicy({
        status: 'current',
        version: 'v2',
        snapshot: { tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'deny' }] },
      })
    }
    return { store, after }
  }

  for (const [change, outcome, source] of [
    ['policy', 'denied-on-rejudge', 'policy'],
    ['withdrawn', 'tool-unavailable', 'tool-unavailable'],
    ['inspector', 'denied-on-rejudge', 'inspector'],
  ] as const) {
    it(`closes a single-call batch with no card when ${change} tightens it, and lists it resumable`, async () => {
      const { store, after } = await restartedWith(change, change === 'withdrawn' ? [] : ['a'])
      const recovered = await after.service.recover()
      expect(recovered.resumable.map((item) => item.rootSessionId)).toEqual([SESSION])
      expect(after.memory.confirmRequests).toEqual([])
      const entries = await all(store)
      expect(resolutions(entries)).toEqual([`${outcome}/rejudge/recovery`])
      expect(outcomes(entries)).toEqual([`0:not-run/${source}`])
      expect(await store.listPendingApprovals({ sessionId: SESSION, limit: 10 })).toEqual([])
      expect(await after.service.listPendingRoots({ limit: 20 })).toEqual([
        { sessionId: SESSION, waitKind: 'resume' },
      ])
      after.provider.script(done())
      expect(await after.service.resume({ rootSessionId: SESSION, origin: null })).toEqual({
        status: 'started',
      })
      expect((await after.loop.runEnded()).reason).toEqual({ code: 'completed' })
      expect(after.provider.starts).toBe(1)
      assertToolPairing(recorded(after, 0))
      expect(await after.service.listPendingRoots({ limit: 20 })).toEqual([])
    })
  }

  it('delivers an unchanged card again, and keeps it answerable', async () => {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const before = service(store)
    before.provider.script(calls('a'))
    await send(before)
    const requestId = await requestIdOf(before)
    const after = service(store, { idsFrom: 1000 })
    expect(await after.service.recover()).toEqual({ resumable: [], errors: [] })
    expect(after.memory.confirmRequests.map((card) => card.requestId)).toEqual([requestId])
    expect(await after.service.listPendingRoots({ limit: 20 })).toEqual([
      { sessionId: SESSION, waitKind: 'approval' },
    ])
    after.provider.script(done())
    expect(await allow(after, requestId)).toEqual({ status: 'applied' })
  })

  it('resumes a multi-call batch only when opened: nothing runs at startup, and b is judged then', async () => {
    const { store, after } = await restartedWith('policy', ['a', 'b'])
    // b is a different call the same policy denies; the one that should run is on another server.
    after.memory.setPolicy({
      status: 'current',
      version: 'v2',
      snapshot: {
        tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'deny' }],
      },
    })
    const recovered = await after.service.recover()
    expect(recovered.resumable.map((item) => item.rootSessionId)).toEqual([SESSION])
    const started = named(await all(store), 'execution/run_started').length
    expect(after.loop.connector.calls).toEqual({ resolveChoice: 0, assemble: 0, provider: 0 })
    expect(after.provider.starts).toBe(0)

    // A second restart without opening it: still listed, nothing written for b, no recovered terminal.
    const again = service(store, { idsFrom: 2000 })
    expect((await again.service.recover()).resumable.map((item) => item.rootSessionId)).toEqual([
      SESSION,
    ])
    let entries = await all(store)
    expect(named(entries, 'execution/run_started')).toHaveLength(started)
    expect(outcomes(entries)).toEqual(['0:not-run/policy'])
    expect(terminals(entries)).toEqual(['paused/run'])

    again.memory.setPolicy({ status: 'current', version: 'v3', snapshot: { tools: [] } })
    again.inspector.answer({ kind: 'none' })
    again.provider.script(done())
    expect(await again.service.resume({ rootSessionId: SESSION, origin: null })).toEqual({
      status: 'started',
    })
    expect((await again.loop.runEnded()).reason).toEqual({ code: 'completed' })
    entries = await all(store)
    const cause = named(entries, 'execution/run_started').at(-1)?.payload['cause'] as {
      kind: string
    }
    expect(cause.kind).toBe('resume')
    expect(outcomes(entries)).toEqual(['0:not-run/policy', '1:completed/null'])
    expect(again.executed).toEqual([{ at: 'b' }])
  })

  it('resumes first when a message comes to a resumable session, and queues the message', async () => {
    for (const trouble of ['confirm', 'no-key'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one restart per trouble
      const { after } = await restartedWith('policy', ['a'])
      // oxlint-disable-next-line no-await-in-loop -- startup first
      await after.service.recover()
      if (trouble === 'confirm') {
        after.loop.connector.needsConfirm('api.example.com')
        after.provider.script(done())
      } else {
        after.loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'))
      }
      // oxlint-disable-next-line no-await-in-loop -- the send resumes, then queues
      const sent = await after.service.send({ sessionId: SESSION, origin: null, text: 'and also' })
      expect(sent).toMatchObject({ status: 'queued' })
      expect(after.loop.connector.calls.resolveChoice).toBe(0)
      // oxlint-disable-next-line no-await-in-loop -- the resuming Run's end
      const ended = await after.loop.runEnded()
      expect(after.loop.queued(SESSION)).toHaveLength(1)
      // oxlint-disable-next-line no-await-in-loop -- this round's list
      expect(await after.service.listPendingRoots({ limit: 20 })).toEqual([])
      // oxlint-disable-next-line no-await-in-loop -- and nothing left to resume
      expect(await after.service.resume({ rootSessionId: SESSION, origin: null })).toEqual({
        status: 'none',
      })
      // The resuming Run asks for its provider at its first request only: a missing key ends it there.
      expect(ended.reason).toMatchObject(
        trouble === 'no-key'
          ? { code: 'provider-error', errorCode: 'auth' }
          : { code: 'completed' },
      )
      expect(after.loop.connector.calls.provider).toBe(1)
    }
  })
})

describe('stopping a resumable session (§每种答复同批写什么「可续跑的会话里停止」)', () => {
  it('writes a Run that sends nothing, closes the rest stopped, and lists it no more', async () => {
    for (const ats of [['a'], ['a', 'b']]) {
      const store = createMemoryTapeStore({ identity: IDENTITY })
      const before = service(store)
      before.provider.script(calls(...ats))
      // oxlint-disable-next-line no-await-in-loop -- one session per batch size
      await send(before)
      const after = service(store, { idsFrom: 1000 })
      after.memory.setPolicy({
        status: 'current',
        version: 'v2',
        snapshot: { tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'deny' }] },
      })
      // oxlint-disable-next-line no-await-in-loop -- startup first
      await after.service.recover()
      // oxlint-disable-next-line no-await-in-loop -- the stop
      expect(await after.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
      // oxlint-disable-next-line no-await-in-loop -- this session's facts
      const entries = await all(store)
      expect(terminals(entries).at(-1)).toBe('user-stopped/run')
      expect(outcomes(entries)).toEqual(
        ats.length === 1 ? ['0:not-run/policy'] : ['0:not-run/policy', '1:not-run/stopped'],
      )
      expect(after.provider.starts).toBe(0)
      // oxlint-disable-next-line no-await-in-loop -- the next start
      expect((await service(store, { idsFrom: 2000 }).service.recover()).resumable).toEqual([])
    }
  })

  it('stops with the lease a send began at its entry: one lease, only that Run’s end', async () => {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const before = service(store)
    before.provider.script(calls('a', 'b'))
    await send(before)
    const after = service(store, { idsFrom: 1000 })
    after.memory.setPolicy({
      status: 'current',
      version: 'v2',
      snapshot: { tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'deny' }] },
    })
    await after.service.recover()
    const sending = after.service.send({ sessionId: SESSION, origin: null, text: 'hello' })
    expect(await after.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect(await sending).toEqual({ status: 'not-sent', code: 'stopped' })
    expect(after.loop.leaseLog).toHaveLength(1)
    const ends = after.loop.recorded.filter((event) => event.type === 'run-ended')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ recorded: true, reason: { code: 'user-stopped' } })
    expect(outcomes(await all(store))).toEqual(['0:not-run/policy', '1:not-run/stopped'])
  })
})

describe('T1 at the write (旧 119)', () => {
  it('commits each dispatch before its side effect', async () => {
    const order: string[] = []
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = proxyStore(inner, {
      append: async (batch) => {
        const receipts = await inner.append(batch)
        if (batch.entries.some((entry) => entry.name === 'execution/dispatch_committed')) {
          order.push('dispatch')
        }
        return receipts
      },
    })
    const s = service(store, { during: () => order.push('execute') })
    s.inspector.answer({ kind: 'none' })
    s.provider.script(calls('a', 'b'))
    s.provider.script(done())
    await send(s)
    expect(order).toEqual(['dispatch', 'execute', 'dispatch', 'execute'])
  })

  /** A Run whose first dispatch key another writer already holds, in a strict or a packaged build. */
  async function overAnotherDispatch(repair: boolean): Promise<{
    ended: RunEnded
    executed: number
    outcomes: string[]
    logged: boolean
  }> {
    let planted = false
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = proxyStore(inner, {
      append: async (batch) => {
        const dispatch = batch.entries.find(
          (entry) => entry.name === 'execution/dispatch_committed',
        )
        if (dispatch !== undefined && !planted) {
          planted = true
          // The same key under another writer, already on the Tape.
          const head = await inner.head(SESSION)
          const tape = createTape(inner)
          await tape.appendEntries({
            sessionId: SESSION,
            incarnationId: head?.incarnationId ?? '',
            entries: [
              tape.writer('execution').entry('execution/dispatch_committed', {
                sourceType: 'runtime_event',
                sourceId: String(dispatch.sourceId),
                sourceSeq: Number(dispatch.sourceSeq),
                provenanceKey: dispatchCommittedKey(
                  String(dispatch.sourceId),
                  Number(dispatch.sourceSeq),
                  0,
                ),
                payload: { ...dispatch.payload, writer: { by: 'resolver' } },
                createdAt: 1,
              }),
            ],
          })
        }
        return inner.append(batch)
      },
    })
    const s = service(store, { repair })
    s.inspector.answer({ kind: 'none' })
    s.provider.script(calls('a'))
    s.provider.script(done())
    const ended = await send(s)
    return {
      ended,
      executed: s.executed.length,
      outcomes: outcomes(await all(inner)),
      logged: s.logs.some(
        (line) =>
          line.includes('conflicts') ||
          line.includes(TapeProvenanceConflictError.name) ||
          line.includes('already exists'),
      ),
    }
  }

  it('never dispatches over another writer’s dispatch: a strict build throws', async () => {
    const strict = await overAnotherDispatch(false)
    expect(strict).toMatchObject({ ended: { recorded: false }, executed: 0, logged: true })
  })

  it('and a packaged build closes that call uncertain / repair, and goes on', async () => {
    const packaged = await overAnotherDispatch(true)
    expect(packaged).toMatchObject({
      ended: { reason: { code: 'completed' } },
      executed: 0,
      outcomes: ['0:uncertain/repair'],
      logged: true,
    })
  })
})

describe('session.latest after a sub-agent wrote last (B3)', () => {
  it('opens the root session', async () => {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const s = service(store)
    s.provider.script(done())
    await send(s)
    // A sub-agent session, written last: its profile_set names the parent.
    const child = '9f6a9a2e-6b3d-4a71-9f52-0c8de7a11b3b'
    await s.service.createSession({ sessionId: child })
    const head = await store.head(child)
    const tape = createTape(store)
    await tape.appendEntries({
      sessionId: child,
      incarnationId: head?.incarnationId ?? '',
      entries: [
        tape.writer('session').entry('session/profile_set', {
          sourceType: 'session',
          sourceId: child,
          provenanceKey: profileSetKey(head?.incarnationId ?? ''),
          payload: { profile: 'cowork', subagentOf: { sessionId: SESSION, linkKey: 'x' } },
          createdAt: 5,
        }),
        tape.writer('message').entry('message/user', {
          sourceType: 'message',
          sourceId: 'a1b2c3d4-6b3d-4a71-9f52-0c8de7a11b3c',
          sourceSeq: 0,
          provenanceKey: messageRevisionKey('a1b2c3d4-6b3d-4a71-9f52-0c8de7a11b3c', 0),
          payload: {
            messageId: 'a1b2c3d4-6b3d-4a71-9f52-0c8de7a11b3c',
            revision: 0,
            role: 'user',
            content: [{ type: 'text', text: 'the task' }],
            status: 'complete',
          },
          createdAt: 6,
        }),
      ],
    })
    expect((await s.service.latestSession({ limit: 10 }))?.sessionId).toBe(SESSION)
  })
})
