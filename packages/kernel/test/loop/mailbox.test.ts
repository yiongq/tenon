/**
 * The mailbox and its leases (spec 02 §主进程与 kernel 的循环接口; plan step 9). Written the way the
 * executable models state the rules (models/model1): one live lease per root, never handed over; a
 * command judged in arrival order even while the one ahead of it is still prebuilding; nothing written
 * when a new round cannot start; the lease finished before `run-ended` goes out.
 *
 * The waiting states, recovery and the queue's insertion arrive in plan steps 15–17, and their cases
 * with them.
 */
import { describe, expect, it } from 'vitest'
import {
  ProviderConfigMissingError,
  createMemoryHost,
  createMemoryTapeStore,
  createSessionService,
} from '../../src/index.js'
import type {
  HostAdapter,
  ModelInfo,
  SessionEvent,
  SessionService,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  scriptedTurn,
} from '../../src/testing/index.js'
import type { ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'

const IDENTITY = { userId: 'loop-user', tenantId: 'loop-tenant', profileDir: '/tenon/loop' }
const SESSION = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'

const MODEL: ModelInfo = {
  id: 'claude-loop-1',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 2048,
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

interface Harness {
  readonly store: TapeStore
  readonly service: SessionService
  readonly provider: ScriptedProvider
  readonly loop: TestLoopPorts
}

function harness(onEvent?: (event: SessionEvent, h: Harness) => void): Harness {
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  let self: Harness | null = null
  const loop = createTestLoopPorts({
    connector: { provider, model: MODEL },
    onEvent: (event) => {
      if (self !== null) onEvent?.(event, self)
    },
  })
  const memory = createMemoryHost()
  let clock = 1_700_000_000_000
  const host: HostAdapter = {
    ...memory,
    clock: { now: () => (clock += 1000), setTimeout: (fn, ms) => memory.clock.setTimeout(fn, ms) },
  }
  const service = createSessionService({
    host,
    tape: store,
    ids: createCounterIds(),
    inspectors: [],
    connector: loop.connector,
    protectedFiles: [],
  })
  service.bindLoop(loop)
  self = { store, service, provider, loop }
  return self
}

async function names(store: TapeStore, sessionId = SESSION): Promise<string[]> {
  const page = await store.readRange({ sessionId, limit: 1000 })
  return page.entries.map((entry: TapeEntry) => entry.name)
}

describe('leases and the arrival order', () => {
  it('queues a send that arrives while the first is still prebuilding, then sends it after', async () => {
    const h = harness()
    h.provider.script(scriptedTurn({ deltas: ['an answer'], usage: USAGE }))
    h.provider.script(scriptedTurn({ deltas: ['the second answer'], usage: USAGE }))
    const held = h.loop.connector.holdAssemble()
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'first' })
    await held.reached
    // The second arrives inside the first's prebuild: the root has a live lease, so it does not
    // begin one and goes into the mailbox — where it waits for the first to open its Run.
    const second = h.service.send({ sessionId: SESSION, origin: null, text: 'second' })
    expect(h.loop.leaseLog).toHaveLength(1)
    held.release()
    const started = await first
    expect(started.status).toBe('started')
    // Judged after the first opened its Run, so it finds a Run in progress and queues.
    expect(await second).toEqual({ status: 'queued', queuedId: expect.any(String) })
    if (started.status !== 'started') return
    await h.loop.runEnded({ runId: started.runId })
    // The first Run completed: the queued one goes out on a lease begun as the first finished
    // (「Run 结束」) — the recording lease would have thrown had they overlapped.
    const auto = await h.loop.runEnded()
    expect(auto.reason).toEqual({ code: 'completed' })
    const tape = await names(h.store)
    expect(tape.filter((name) => name === 'execution/run_started')).toHaveLength(2)
    expect(tape.filter((name) => name === 'message/user')).toHaveLength(2)
    expect(h.loop.leaseLog).toHaveLength(2)
    expect(h.loop.queued(SESSION)).toEqual([])
  })

  it('judges a send by the state at its turn, not at its arrival', async () => {
    const h = harness()
    const held = h.loop.connector.holdAssemble()
    // Only the first send's provider() fails.
    h.loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'), 1)
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'first' })
    await held.reached
    const second = h.service.send({ sessionId: SESSION, origin: null, text: 'second' })
    // The first cannot start (no key) and writes nothing. The second arrived while the first held
    // the lease, but by its turn the root is idle: it begins a lease of its own and starts a round.
    h.provider.script(scriptedTurn({ deltas: ['an answer'], usage: USAGE }))
    held.release()
    expect(await first).toEqual({ status: 'not-sent', code: 'config-missing' })
    const started = await second
    expect(started.status).toBe('started')
    if (started.status === 'started') await h.loop.runEnded({ runId: started.runId })
    expect(h.loop.leaseLog).toHaveLength(2)
    expect(h.loop.queued(SESSION)).toEqual([])
    const rows = await h.service.listMessages({ sessionId: SESSION, limit: 10 })
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant'])
  })

  it('lets the next command run when a prebuild fails for a reason that is not configuration', async () => {
    const h = harness()
    const held = h.loop.connector.holdAssemble()
    h.loop.connector.failProvider(new Error('a bug in the host'), 1)
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'first' })
    await held.reached
    const second = h.service.send({ sessionId: SESSION, origin: null, text: 'second' })
    h.provider.script(scriptedTurn({ deltas: ['an answer'], usage: USAGE }))
    held.release()
    // Not a configuration problem: it goes up, with nothing written and the lease finished…
    await expect(first).rejects.toThrow(/a bug in the host/)
    // …and the command that waited behind it is not left waiting.
    const started = await second
    expect(started.status).toBe('started')
    if (started.status === 'started') await h.loop.runEnded({ runId: started.runId })
    expect(h.loop.leaseLog.map((lease) => lease.finished)).toEqual([true, true])
  })

  it('queues a send that arrives while a Run streams, marked urgent once that Run is stopped', async () => {
    const results: Array<Promise<unknown>> = []
    const h = harness((event, self) => {
      if (event.type !== 'text-delta' || results.length > 0) return
      results.push(self.service.send({ sessionId: SESSION, origin: null, text: 'while streaming' }))
      void self.service.stop({ rootSessionId: SESSION })
      results.push(self.service.send({ sessionId: SESSION, origin: null, text: 'after the stop' }))
    })
    h.provider.script(scriptedTurn({ deltas: ['a', 'b', 'c'], usage: USAGE }))
    h.provider.script(scriptedTurn({ deltas: ['sent after the stop'], usage: USAGE }))
    h.provider.script(scriptedTurn({ deltas: ['and then the rest'], usage: USAGE }))
    const started = await h.service.send({ sessionId: SESSION, origin: null, text: 'hi' })
    if (started.status !== 'started') throw new Error(JSON.stringify(started))
    const ended = await h.loop.runEnded({ runId: started.runId })
    expect(ended.reason).toEqual({ code: 'user-stopped' })
    // 「何时判定」: a Run aborted and still closing counts as in progress, and what arrives then is
    // marked urgent — after a `user-stopped` end only the urgent item goes out; the other waits.
    expect(h.loop.queued(SESSION).map((item) => [item.text, item.urgent])).toEqual([
      ['while streaming', false],
    ])
    const [whileStreaming, afterStop] = await Promise.all(results)
    expect(whileStreaming).toMatchObject({ status: 'queued' })
    expect(afterStop).toMatchObject({ status: 'queued' })
    // The urgent Run completes, and then the rest of the queue goes out after it.
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(h.loop.queued(SESSION)).toEqual([])
    const users = h.loop.recorded.filter((event) => event.type === 'user-message')
    expect(users.map((event) => event.queuedId === null)).toEqual([true, false, false])
  })

  it('finishes the lease before run-ended goes out', async () => {
    let liveAtEnd: unknown = 'not seen'
    const h = harness((event, self) => {
      if (event.type === 'run-ended') liveAtEnd = self.loop.liveLease(SESSION)
    })
    h.provider.script(scriptedTurn({ deltas: ['done'], usage: USAGE }))
    const started = await h.service.send({ sessionId: SESSION, origin: null, text: 'hi' })
    if (started.status !== 'started') throw new Error(JSON.stringify(started))
    await h.loop.runEnded({ runId: started.runId })
    // Whoever reacts to the end by sending again must not find the root still leased.
    expect(liveAtEnd).toBeNull()
    expect(h.loop.leaseLog[0]?.finished).toBe(true)
  })

  it('stops a streaming Run through its lease, and answers false with nothing to stop', async () => {
    let stopped: Promise<{ stopped: boolean }> | null = null
    const h = harness((event, self) => {
      if (event.type === 'text-delta') stopped ??= self.service.stop({ rootSessionId: SESSION })
    })
    h.provider.script(scriptedTurn({ deltas: ['a', 'b', 'c'], usage: USAGE }))
    const started = await h.service.send({ sessionId: SESSION, origin: null, text: 'hi' })
    if (started.status !== 'started') throw new Error(JSON.stringify(started))
    const ended = await h.loop.runEnded({ runId: started.runId })
    expect(await stopped).toEqual({ stopped: true })
    expect(h.loop.leaseLog[0]?.stopRequested).toBe(true)
    expect(ended).toMatchObject({ reason: { code: 'user-stopped' }, lastStop: 'aborted' })
    const rows = await h.service.listMessages({ sessionId: SESSION, limit: 10 })
    expect(rows.at(-1)?.status).toBe('aborted')
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: false })
  })

  it('refuses to begin while the host shuts down, and writes nothing', async () => {
    const h = harness()
    h.loop.beginShutdown()
    expect(await h.service.send({ sessionId: SESSION, origin: null, text: 'hi' })).toEqual({
      status: 'refused',
      code: 'shutting-down',
    })
    expect(await h.store.head(SESSION)).toBeNull()
    expect(h.loop.connector.calls.resolveChoice).toBe(0)
  })
})

describe('a new round that cannot start writes nothing', () => {
  it('a missing key: not sent, the lease finished, run-ended with auth', async () => {
    const h = harness()
    h.loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'))
    const result = await h.service.send({ sessionId: SESSION, origin: null, text: 'hi' })
    expect(result).toEqual({ status: 'not-sent', code: 'config-missing' })
    // 「缺 key 什么都不写」 (owner 2026-09-25): not even the session.
    expect(await h.store.head(SESSION)).toBeNull()
    expect(h.provider.starts).toBe(0)
    expect(h.loop.liveLease(SESSION)).toBeNull()
    expect(h.loop.recorded.at(-1)).toEqual({
      type: 'run-ended',
      rootSessionId: SESSION,
      sessionId: SESSION,
      runId: null,
      reason: {
        code: 'provider-error',
        providerId: 'anthropic',
        errorCode: 'auth',
        providerReason: null,
        attempts: 0,
      },
      recorded: false,
      lastStop: null,
      errorCode: 'auth',
    })
  })

  it('a stop during the prebuild does not wait for it, and the next send starts afresh', async () => {
    const h = harness()
    const held = h.loop.connector.holdAssemble()
    const sending = h.service.send({ sessionId: SESSION, origin: null, text: 'hi' })
    await held.reached
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    // The keychain may never answer: the send returns without the assembly.
    expect(await sending).toEqual({ status: 'not-sent', code: 'stopped' })
    expect(h.loop.recorded.at(-1)).toMatchObject({
      type: 'run-ended',
      runId: null,
      reason: { code: 'user-stopped' },
      recorded: false,
      errorCode: null,
    })
    expect(await h.store.head(SESSION)).toBeNull()
    // The late assembly is dropped; the next send is a new round with a lease of its own.
    held.release()
    h.provider.script(scriptedTurn({ deltas: ['an answer'], usage: USAGE }))
    const next = await h.service.send({ sessionId: SESSION, origin: null, text: 'hi again' })
    expect(next.status).toBe('started')
    if (next.status === 'started') await h.loop.runEnded({ runId: next.runId })
    expect(h.loop.leaseLog).toHaveLength(2)
    expect(await names(h.store)).toContain('message/assistant')
  })

  it('a window closed during the prebuild ends it as an app exit', async () => {
    const h = harness()
    const held = h.loop.connector.holdAssemble()
    const sending = h.service.send({ sessionId: SESSION, origin: null, text: 'hi' })
    await held.reached
    expect(h.loop.abort(SESSION, 'close-window')).toBe(true)
    expect(await sending).toEqual({ status: 'not-sent', code: 'app-exit' })
    expect(h.loop.recorded.at(-1)).toMatchObject({
      type: 'run-ended',
      reason: { code: 'shutdown-aborted', trigger: 'close-window' },
      recorded: false,
    })
    expect(await h.store.head(SESSION)).toBeNull()
    held.release()
  })

  it('an indirect switch to a public host holds the message and asks first', async () => {
    const h = harness()
    h.loop.connector.needsConfirm('api.example.com')
    const result = await h.service.send({ sessionId: SESSION, origin: null, text: 'hi' })
    expect(result).toEqual({ status: 'held', queuedId: expect.any(String) })
    // 0 requests, no fact; the message waits for the menu's confirmation (released in plan step 19).
    expect(h.loop.connector.calls.assemble).toBe(0)
    expect(h.provider.starts).toBe(0)
    expect(await h.store.head(SESSION)).toBeNull()
    expect(h.loop.queued(SESSION).map((item) => item.text)).toEqual(['hi'])
    expect(h.loop.recorded).toEqual([
      { type: 'queue-held', rootSessionId: SESSION, sessionId: SESSION, host: 'api.example.com' },
    ])
    expect(h.loop.liveLease(SESSION)).toBeNull()
  })
})

describe('the commands that come with later steps', () => {
  it('resume and recover have nothing to act on yet; answer and continue find nothing', async () => {
    const h = harness()
    expect(await h.service.resume({ rootSessionId: SESSION, origin: null })).toEqual({
      status: 'none',
    })
    expect(await h.service.recover()).toEqual({ resumable: [], errors: [] })
    expect(h.loop.leaseLog).toEqual([])
    // An answer and 「继续」 may open a Run: each begins its lease at its entry, finds nothing to act
    // on, and finishes it having written nothing (plan steps 13 and 15).
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: 'r',
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'not-found' })
    expect(h.loop.leaseLog).toHaveLength(1)
    expect(await h.service.continueRun({ sessionId: SESSION, origin: null })).toEqual({
      status: 'not-available',
    })
    // Every lease begun was finished, and nothing was written or sent.
    expect(h.loop.leaseLog.length).toBeGreaterThanOrEqual(1)
    expect(h.loop.liveLease(SESSION)).toBeNull()
    expect(h.loop.recorded).toEqual([])
  })
})
