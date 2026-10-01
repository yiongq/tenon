/**
 * How each state closes on a stop, a quit or a closed window (spec 02 §点停止时各状态怎么收, §原因码表
 * `stopped` / `timed-out` / `app-exit`, §进行中、暂停与 RunRegistry「中止原因」, §停止与退出 第 5 步,
 * §上限、守卫与用量; plan step 23: 旧 177, 旧 142, 旧 143, 旧 230 the STOP part, 旧 136 the kernel
 * half). The process-group halves of 旧 177 and 旧 7 run real process trees elsewhere.
 *
 * Every call runs through a real Run on the memory host and its manual clock: the test registry puts
 * the real Read, Write, Edit and Bash executors in the table and the user's always-allow lets them run
 * without a card; Bash spawns a fake ChildHandle, and a write is held in flight by a gated HostFs.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type {
  AbsolutePath,
  DenyOpinion,
  HostFs,
  HostProcess,
  HostSandbox,
  InspectorRegistration,
  MemoryHost,
  ModelInfo,
  SandboxRequest,
  SessionEvent,
  SessionService,
  StreamEvent,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import {
  STOP_EXIT_CONFIRM_MS,
  STOP_TERM_GRACE_MS,
  STOP_WRITE_WAIT_MS,
} from '../../src/loop/limits.js'
import { MODEL_NOTES } from '../../src/prompts/index.js'
import { BASH_DEFAULT_TIMEOUT_MS } from '../../src/tools/builtin/bash.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type { ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'
import { fakeChild, pendingCard } from './support.js'
import type { FakeChild, KillAnswer } from './support.js'

const IDENTITY = { userId: 'stop-user', tenantId: 'stop-tenant', profileDir: '/tenon/stop' }
const SESSION = '7d3b2a1c-4e5f-4a6b-9c8d-0e1f2a3b4c5d'
const DEDICATED = absolutePath(`/home/u/Tenon/workspaces/stop-user/stop-tenant/${SESSION}`)
const WORK = absolutePath('/work/project')
const OTHER = absolutePath('/work/other')
const FILE = absolutePath('/work/project/notes.md')

const MODEL: ModelInfo = {
  id: 'claude-stop-1',
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
  inputTokens: 5,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

type Outcome = Extract<SessionEvent, { type: 'tool-outcome' }>['outcome']

/** Lets every promise the Run has in flight settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 500; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polled one settle at a time
    if (await check()) return
    // oxlint-disable-next-line no-await-in-loop -- polled one settle at a time
    await settle()
  }
  throw new Error(`never: ${what}`)
}

// ----- the harness ------------------------------------------------------------------------------

interface Harness {
  readonly memory: MemoryHost
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  readonly logs: string[]
  readonly wrapped: SandboxRequest[]
  readonly afterExit: string[]
  /** The children spawned so far, in order. */
  readonly children: FakeChild[]
  /** Called with every event as it is recorded. */
  onEvent: ((event: SessionEvent) => void) | null
}

interface HarnessOptions {
  /** How each spawned child answers the kill signals; default `'dies'`. */
  readonly onKill?: KillAnswer
  /** Replaces some of the memory host's HostFs methods; the rest pass through. */
  readonly fs?: (fs: HostFs) => Partial<HostFs>
  readonly inspectors?: readonly InspectorRegistration[]
  readonly folders?: readonly AbsolutePath[]
  /** Wraps the memory store; `h` is the harness, bound once it is made. */
  readonly store?: (inner: TapeStore, h: () => Harness) => TapeStore
}

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  const children: FakeChild[] = []
  let memory: MemoryHost | null = null
  const spawner: HostProcess = {
    spawn: () => {
      const clock = memory
      if (clock === null) throw new Error('spawned before the host was made')
      const fake = fakeChild(() => clock.clock.now(), o.onKill ?? 'dies')
      children.push(fake)
      return Promise.resolve(fake.child)
    },
  }
  const host = createMemoryHost({ identity: IDENTITY, process: spawner, now: 1_000_000 })
  memory = host
  const wrapped: SandboxRequest[] = []
  const afterExit: string[] = []
  const sandbox: HostSandbox = {
    wrap: (request) => {
      wrapped.push(request)
      return host.sandbox.wrap(request)
    },
    afterExit: (commandId) => {
      afterExit.push(commandId)
      return host.sandbox.afterExit(commandId)
    },
    violations: (commandId) => host.sandbox.violations(commandId),
  }
  const overrides = o.fs?.(host.fs) ?? {}
  const fs = new Proxy(host.fs, {
    get(target, key): unknown {
      if (typeof key === 'string' && key in overrides) return overrides[key as keyof HostFs]
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
  const folders = o.folders ?? [WORK]
  for (const folder of folders) {
    // oxlint-disable-next-line no-await-in-loop -- the folders exist before the workspace names them
    await host.fs.mkdirp(folder)
  }
  await host.fs.writeFile(FILE, 'before\n')
  const inner = createMemoryTapeStore({ identity: IDENTITY })
  let made: Harness | null = null
  const store =
    o.store?.(inner, () => {
      if (made === null) throw new Error('the store was used before the harness was made')
      return made
    }) ?? inner
  const provider = createScriptedProvider({ models: [MODEL] })
  const logs: string[] = []
  const h: { onEvent: Harness['onEvent'] } = { onEvent: null }
  const loop = createTestLoopPorts({
    connector: { provider, model: MODEL, mcpSources: [] },
    onEvent: (event) => h.onEvent?.(event),
  })
  const service = createTestSessionService(
    {
      host: { ...host, fs, sandbox },
      tape: store,
      ids: createCounterIds(),
      inspectors: [...(o.inspectors ?? [])],
      connector: loop.connector,
      protectedFiles: [],
      log: (line) => logs.push(line),
    },
    {
      tools: { Read: 'real', Write: 'real', Edit: 'real', Bash: 'real' },
      userSetting: () => ({ userSetting: 'always-allow' }),
    },
  )
  service.bindLoop(loop)
  await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
  await service.setWorkspace({
    sessionId: SESSION,
    change: { kind: 'add', folders: [...folders] },
    dedicated: DEDICATED,
  })
  made = Object.assign(h, {
    memory: host,
    store,
    service,
    loop,
    provider,
    logs,
    wrapped,
    afterExit,
    children,
  })
  return made
}

/** A HostFs whose `writeFile` of FILE waits until `release`; `reached` settles once it is called. */
function gatedWrite(): {
  readonly fs: (fs: HostFs) => Partial<HostFs>
  readonly reached: Promise<void>
  release(error?: Error): void
  readonly calls: () => number
} {
  const reached = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  let calls = 0
  return {
    fs: (fs) => ({
      writeFile: async (path, data) => {
        if (path !== FILE) return fs.writeFile(path, data)
        calls += 1
        reached.resolve()
        await gate.promise
        return fs.writeFile(path, data)
      },
    }),
    reached: reached.promise,
    release: (error) => (error === undefined ? gate.resolve() : gate.reject(error)),
    calls: () => calls,
  }
}

/** A store whose `append` runs `then` once each batch commits, before the appender hears back. */
function afterAppend(
  inner: TapeStore,
  then: (batch: Parameters<TapeStore['append']>[0]) => Promise<void> | void,
): TapeStore {
  return new Proxy(inner, {
    get(target, key): unknown {
      if (key === 'append') {
        return async (batch: Parameters<TapeStore['append']>[0]) => {
          const receipts = await target.append(batch)
          await then(batch)
          return receipts
        }
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
}

let nextCall = 1

type Call = readonly [name: string, input: Record<string, unknown>]

/** A reply asking for these calls, then its usage and a tool-use stop. */
function callsOf(calls: readonly Call[], after: readonly StreamEvent[] = []): StreamEvent[] {
  return [
    ...calls.flatMap(([name, input], k): StreamEvent[] => {
      const id = `toolu_${String(nextCall++)}`
      return [
        { type: 'tool-call-start', index: k + 1, id, name },
        { type: 'tool-call-end', index: k + 1, id, name, input },
      ]
    }),
    ...after,
    { type: 'usage', usage: USAGE },
    stopEvent('tool-use', 'tool_use'),
  ]
}

const done = (): StreamEvent[] => scriptedTurn({ deltas: ['Done.'], usage: USAGE })

/** Sends a message whose reply asks for the calls; the Run's id. */
async function send(h: Harness, calls: readonly Call[], after?: StreamEvent[]): Promise<string> {
  h.provider.script(callsOf(calls, after))
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'go' })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return sent.runId
}

/**
 * Sends a message whose reply asks for the calls, and allows the first one's card: the id of the Run
 * the answer opened, which dispatches it (§续跑).
 */
async function allowed(h: Harness, calls: readonly Call[]): Promise<string> {
  const paused = await send(h, calls)
  expect((await h.loop.runEnded({ runId: paused })).reason).toEqual({
    code: 'paused',
    waitingFor: 'approval',
  })
  const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (pending === null) throw new Error('no card')
  const answered = await h.service.answer({
    kind: 'approval',
    sessionId: SESSION,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  expect(answered).toEqual({ status: 'applied' })
  const started = (): string[] =>
    h.loop.recorded.flatMap((event) => (event.type === 'run-started' ? [event.runId] : []))
  await until(() => started().length === 2, 'the answered Run started')
  return started()[1] ?? ''
}

async function entries(h: Harness): Promise<TapeEntry[]> {
  return (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}

async function named(h: Harness, name: string): Promise<TapeEntry[]> {
  return (await entries(h)).filter((entry) => entry.name === name)
}

/** Every closure as `<i> state source effect`, in Tape order. */
async function outcomes(h: Harness): Promise<string[]> {
  return (await named(h, 'execution/tool_outcome')).map(({ payload }) =>
    [payload['ordinal'], payload['state'], payload['source'], payload['effect']].join(' '),
  )
}

/** Every result's text blocks, in Tape order. */
async function resultTexts(h: Harness): Promise<string[][]> {
  return (await named(h, 'tool/result')).map(({ payload }) =>
    (payload['content'] as Array<{ text?: string }>).map((block) => block.text ?? ''),
  )
}

/** The `tool-outcome` views the interface was sent, in order. */
function views(h: Harness): Outcome[] {
  return h.loop.recorded.flatMap((event) => (event.type === 'tool-outcome' ? [event.outcome] : []))
}

/** Waits until the Run spawned its `n`-th child and the kernel is waiting on it. */
async function spawned(h: Harness, n = 1): Promise<FakeChild> {
  await until(() => h.children.length >= n, `child ${String(n)} spawned`)
  await settle()
  const child = h.children[n - 1]
  if (child === undefined) throw new Error('no child')
  return child
}

/** The kill sequence to its end on the manual clock: SIGTERM already sent, then grace, then window. */
async function throughKill(h: Harness): Promise<void> {
  h.memory.advance(STOP_TERM_GRACE_MS)
  await settle()
  h.memory.advance(STOP_EXIT_CONFIRM_MS)
  await settle()
}

// ----- 旧 177 --------------------------------------------------------------------------------------

describe('a stop in each state (旧 177; §点停止时各状态怎么收)', () => {
  for (const cause of ['user-stop', 'quit'] as const) {
    it(`closes a complete tool_use the stop cut the stream after not-run / stopped, effect blocked (${cause})`, async () => {
      const h = await harness()
      h.onEvent = (event) => {
        if (event.type !== 'text-delta' || event.delta !== 'and then') return
        if (cause === 'user-stop') void h.service.stop({ rootSessionId: SESSION })
        else h.loop.abort(SESSION, 'quit')
      }
      const runId = await send(
        h,
        [['Bash', { command: 'make' }]],
        [
          { type: 'text-delta', index: 3, text: 'and then' },
          { type: 'text-delta', index: 3, text: ' more' },
        ],
      )
      const ended = await h.loop.runEnded({ runId })
      expect(ended.reason).toEqual(
        cause === 'user-stop'
          ? { code: 'user-stopped' }
          : { code: 'shutdown-aborted', trigger: 'quit' },
      )
      expect((await named(h, 'message/assistant'))[0]?.payload['status']).toBe('aborted')
      expect(await named(h, 'tool/call')).toHaveLength(1)
      expect(await named(h, 'execution/dispatch_committed')).toEqual([])
      // Never dispatched: `stopped` whatever the cause (同批后面还没派发的调用一律记 not-run / stopped).
      expect(await outcomes(h)).toEqual(['0 not-run stopped blocked'])
      expect(h.children).toEqual([])
    })
  }

  it('aborts a model inspector’s signal: not-run / stopped, effect blocked, no decision — not an inspector error', async () => {
    const signals: AbortSignal[] = []
    const judging = Promise.withResolvers<void>()
    // An inspector that calls a model: its request rejects the moment its signal aborts.
    const judge: InspectorRegistration = {
      id: 'model-judge',
      kind: 'model',
      ceiling: 'deny',
      beforeCall: (_input, signal) => {
        signals.push(signal)
        judging.resolve()
        return new Promise<DenyOpinion>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('the request was aborted')))
        })
      },
    }
    const h = await harness({ inspectors: [judge] })
    const runId = await send(h, [
      ['Write', { file_path: FILE, content: 'after\n' }],
      ['Bash', { command: 'make' }],
    ])
    await judging.promise
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(signals.map((signal) => signal.aborted)).toEqual([true])
    // No decision fact, so no inspector step that failed; the stop's code, not `inspector`.
    expect(await named(h, 'tool/permission_decided')).toEqual([])
    expect(await outcomes(h)).toEqual(['0 not-run stopped blocked', '1 not-run stopped blocked'])
    expect(views(h).map((view) => [view.source, view.permission])).toEqual([
      ['stopped', undefined],
      ['stopped', undefined],
    ])
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before\n')
  })

  it('02 不变量 24: records a command whose `exited` never comes uncertain, and the view says it may have run', async () => {
    const h = await harness({ onKill: 'hangs' })
    const runId = await allowed(h, [['Bash', { command: 'make' }]])
    const child = await spawned(h)
    child.write('building\n')
    await settle()
    void h.service.stop({ rootSessionId: SESSION })
    await settle()
    expect(child.kills.map((kill) => kill.signal)).toEqual(['SIGTERM'])
    await throughKill(h)
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(child.kills.map((kill) => kill.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(await outcomes(h)).toEqual(['0 uncertain stopped external'])
    expect(await resultTexts(h)).toEqual([[MODEL_NOTES.closure.stopped.uncertain, 'building\n']])
    // The view the run-end card counts: an uncertain call reads 「可能已执行」, never 「未发生」.
    expect(views(h)).toMatchObject([{ state: 'uncertain', source: 'stopped', effect: 'external' }])
    // Not confirmed gone: no afterExit for it.
    expect(h.afterExit).toEqual([])
  })

  it('sends SIGKILL STOP_TERM_GRACE_MS after SIGTERM even when the direct child exited on SIGTERM', async () => {
    const h = await harness({ onKill: 'term-exits' })
    const runId = await allowed(h, [['Bash', { command: 'make' }]])
    const child = await spawned(h)
    const start = h.memory.clock.now()
    void h.service.stop({ rootSessionId: SESSION })
    await settle()
    // The direct child is gone; its group may not be (process.ts: exited says nothing of the group).
    expect(await named(h, 'tool/result')).toEqual([])
    h.memory.advance(STOP_TERM_GRACE_MS)
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(child.kills).toEqual([
      { signal: 'SIGTERM', at: start },
      { signal: 'SIGKILL', at: start + STOP_TERM_GRACE_MS },
    ])
    expect(await outcomes(h)).toEqual(['0 aborted stopped external'])
  })

  it('records an in-process write past STOP_WRITE_WAIT_MS uncertain; its late return writes nothing, throws nothing, logs once', async () => {
    const write = gatedWrite()
    const h = await harness({ fs: write.fs })
    const runId = await allowed(h, [
      ['Write', { file_path: FILE, content: 'after\n' }],
      ['Bash', { command: 'make' }],
    ])
    await write.reached
    void h.service.stop({ rootSessionId: SESSION })
    await settle()
    // Waited for: nothing closed before the wait is over.
    h.memory.advance(STOP_WRITE_WAIT_MS - 1)
    await settle()
    expect(await named(h, 'tool/result')).toEqual([])
    h.memory.advance(1)
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(await outcomes(h)).toEqual(['0 uncertain stopped write', '1 not-run stopped blocked'])
    expect((await resultTexts(h))[0]).toEqual([MODEL_NOTES.closure.stopped.uncertain])
    expect(views(h)[0]).toMatchObject({ state: 'uncertain', source: 'stopped', effect: 'write' })
    const count = (await entries(h)).length
    const logged = h.logs.length
    write.release()
    await until(() => h.logs.length > logged, 'the late return logged')
    await settle()
    // First writer wins: the Tape is as it was, no conflict, one line in the log.
    expect((await entries(h)).length).toBe(count)
    expect(h.logs.slice(logged)).toEqual([
      expect.stringMatching(/Write call .* closed uncertain .* returned later \(completed\)/),
    ])
    expect(h.logs.join('\n')).not.toMatch(/conflict/i)
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('after\n')
  })

  it('records an Edit past STOP_WRITE_WAIT_MS uncertain too: its writeFile is an in-process write', async () => {
    const write = gatedWrite()
    const h = await harness({ fs: write.fs })
    const runId = await allowed(h, [
      ['Edit', { file_path: FILE, old_string: 'before', new_string: 'after' }],
    ])
    await write.reached
    void h.service.stop({ rootSessionId: SESSION })
    await settle()
    h.memory.advance(STOP_WRITE_WAIT_MS)
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(await outcomes(h)).toEqual(['0 uncertain stopped write'])
    expect(await resultTexts(h)).toEqual([[MODEL_NOTES.closure.stopped.uncertain]])
    const count = (await entries(h)).length
    const logged = h.logs.length
    write.release()
    await until(() => h.logs.length > logged, 'the late return logged')
    await settle()
    expect((await entries(h)).length).toBe(count)
    expect(h.logs.slice(logged)).toEqual([
      expect.stringMatching(/Edit call .* closed uncertain .* returned later \(completed\)/),
    ])
  })

  it('waits STOP_WRITE_WAIT_MS for a write whose stop landed while its dispatch was committing', async () => {
    const write = gatedWrite()
    const h = await harness({
      fs: write.fs,
      // The stop lands after the dispatch commits, before the batch hears back: the write begins
      // with its signal already aborted, and nothing will fire `abort` again.
      store: (inner, harnessOf) =>
        afterAppend(inner, (batch) => {
          if (batch.entries.some((entry) => entry.name === 'execution/dispatch_committed')) {
            void harnessOf().service.stop({ rootSessionId: SESSION })
          }
        }),
    })
    const runId = await allowed(h, [['Write', { file_path: FILE, content: 'after\n' }]])
    await write.reached
    await settle()
    h.memory.advance(STOP_WRITE_WAIT_MS - 1)
    await settle()
    expect(await named(h, 'tool/result')).toEqual([])
    h.memory.advance(1)
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(await outcomes(h)).toEqual(['0 uncertain stopped write'])
    write.release()
    await settle()
  })

  it('leaves exactly one result when the stop and the normal end arrive together', async () => {
    const write = gatedWrite()
    const h = await harness({ fs: write.fs })
    const runId = await allowed(h, [['Write', { file_path: FILE, content: 'after\n' }]])
    await write.reached
    // One synchronous stretch: the write returns and the stop lands.
    write.release()
    void h.service.stop({ rootSessionId: SESSION })
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(await named(h, 'tool/result')).toHaveLength(1)
    expect(await outcomes(h)).toEqual(['0 completed  write'])
    expect(views(h)).toHaveLength(1)

    // A command's exit and the stop in one stretch: one result too, whichever the kernel saw first.
    const again = await harness()
    const second = await allowed(again, [['Bash', { command: 'true' }]])
    const child = await spawned(again)
    child.exit(0)
    void again.service.stop({ rootSessionId: SESSION })
    await settle()
    await throughKill(again)
    await again.loop.runEnded({ runId: second })
    expect(await named(again, 'tool/result')).toHaveLength(1)
    expect(await named(again, 'execution/tool_outcome')).toHaveLength(1)
  })
})

// ----- 旧 143 --------------------------------------------------------------------------------------

describe('an in-process call on a stop (旧 143; §点停止时各状态怎么收「进程内写操作」)', () => {
  it('Read sees the stop between two HostFs calls and reads no further: aborted', async () => {
    let h: Harness | null = null
    const reads: string[] = []
    h = await harness({
      fs: (fs) => ({
        // The stop lands while Read's stat is in flight, once the call is dispatched.
        stat: async (path) => {
          const stat = await fs.stat(path)
          const current = h
          if (path === FILE && current !== null) {
            const dispatched = await named(current, 'execution/dispatch_committed')
            if (dispatched.length > 0) current.loop.abort(SESSION, 'user-stop')
          }
          return stat
        },
        readFile: (path, o) => {
          reads.push(path)
          return fs.readFile(path, o)
        },
      }),
    })
    const runId = await send(h, [['Read', { file_path: FILE }]])
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(await named(h, 'execution/dispatch_committed')).toHaveLength(1)
    expect(reads).toEqual([])
    expect(await outcomes(h)).toEqual(['0 aborted stopped read'])
    expect(await resultTexts(h)).toEqual([[MODEL_NOTES.closure.stopped.aborted]])
  })

  it('Write waits for its writeFile in flight, and records how it really ended', async () => {
    const write = gatedWrite()
    const h = await harness({ fs: write.fs })
    const runId = await allowed(h, [
      ['Write', { file_path: FILE, content: 'after\n' }],
      ['Bash', { command: 'make' }],
    ])
    await write.reached
    // No stop, no limit: a slow write is never cut short. The wait runs from the stop.
    h.memory.advance(5 * STOP_WRITE_WAIT_MS)
    await settle()
    void h.service.stop({ rootSessionId: SESSION })
    h.memory.advance(STOP_WRITE_WAIT_MS - 1)
    await settle()
    expect(await named(h, 'tool/result')).toEqual([])
    write.release()
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(await outcomes(h)).toEqual(['0 completed  write', '1 not-run stopped blocked'])
    expect(await resultTexts(h)).toEqual([
      [`Replaced the whole content of ${FILE}.`],
      [MODEL_NOTES.closure.stopped['not-run']],
    ])
    // The wait's timer went with the closure: nothing fires later.
    h.memory.advance(STOP_WRITE_WAIT_MS)
    await settle()
    expect(h.logs).toEqual([])
    expect(write.calls()).toBe(1)
  })

  it('Edit waits for its writeFile in flight too, and records how it really ended', async () => {
    const write = gatedWrite()
    const h = await harness({ fs: write.fs })
    const runId = await allowed(h, [
      ['Edit', { file_path: FILE, old_string: 'before', new_string: 'after' }],
    ])
    await write.reached
    void h.service.stop({ rootSessionId: SESSION })
    h.memory.advance(STOP_WRITE_WAIT_MS - 1)
    await settle()
    expect(await named(h, 'tool/result')).toEqual([])
    write.release()
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(await outcomes(h)).toEqual(['0 completed  write'])
    expect(await resultTexts(h)).toEqual([
      [`Edited ${FILE}: replaced the one occurrence of old_string.`],
    ])
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('after\n')
  })
})

// ----- 旧 142 --------------------------------------------------------------------------------------

describe('a Bash timeout (旧 142; §内置工具与参数「Bash」「超时」)', () => {
  it('sends SIGTERM at the timeout, SIGKILL STOP_TERM_GRACE_MS later, and writes the result only after `exited`', async () => {
    const h = await harness({ onKill: 'hangs' })
    const runId = await allowed(h, [['Bash', { command: 'make all', timeout: 1000 }]])
    h.provider.script(done())
    const child = await spawned(h)
    const start = h.memory.clock.now()
    child.write('step 1 of 3\n')
    await settle()
    h.memory.advance(1000)
    await settle()
    expect(child.kills).toEqual([{ signal: 'SIGTERM', at: start + 1000 }])
    h.memory.advance(STOP_TERM_GRACE_MS)
    await settle()
    expect(child.kills.at(-1)).toEqual({
      signal: 'SIGKILL',
      at: start + 1000 + STOP_TERM_GRACE_MS,
    })
    // The child ignores SIGTERM and has not exited yet: nothing is written.
    expect(await named(h, 'tool/result')).toEqual([])
    h.memory.advance(STOP_EXIT_CONFIRM_MS - 1)
    child.exit(null, 'SIGKILL')
    // Not a block, not a stop: the next request goes out and the Run completes.
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'completed' })
    expect(h.provider.requests).toHaveLength(2)
    expect(await outcomes(h)).toEqual(['0 aborted timed-out external'])
    expect(await named(h, 'tool/result')).toMatchObject([
      {
        payload: {
          isError: true,
          kernelAuthored: true,
          content: [
            { type: 'text', text: MODEL_NOTES.closure['timed-out'].aborted },
            { type: 'text', text: 'step 1 of 3\n' },
          ],
        },
      },
    ])
  })

  it('records uncertain / timed-out when `exited` never comes', async () => {
    const h = await harness({ onKill: 'hangs' })
    const runId = await allowed(h, [['Bash', { command: 'make all', timeout: 1000 }]])
    h.provider.script(done())
    await spawned(h)
    h.memory.advance(1000)
    await settle()
    await throughKill(h)
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'completed' })
    expect(await outcomes(h)).toEqual(['0 uncertain timed-out external'])
    expect((await resultTexts(h))[0]).toEqual([MODEL_NOTES.closure['timed-out'].uncertain])
  })

  for (const cause of ['user-stop', 'quit'] as const) {
    it(`stays timed-out when a ${cause} lands after the kill sequence began`, async () => {
      const h = await harness()
      const runId = await allowed(h, [['Bash', { command: 'make all', timeout: 1000 }]])
      const child = await spawned(h)
      h.memory.advance(1000)
      await settle()
      expect(child.kills.map((kill) => kill.signal)).toEqual(['SIGTERM'])
      if (cause === 'user-stop') void h.service.stop({ rootSessionId: SESSION })
      else h.loop.abort(SESSION, 'quit')
      await throughKill(h)
      expect((await h.loop.runEnded({ runId })).reason).toEqual(
        cause === 'user-stop'
          ? { code: 'user-stopped' }
          : { code: 'shutdown-aborted', trigger: 'quit' },
      )
      // One sequence: the stop sent no second SIGTERM.
      expect(child.kills.map((kill) => kill.signal)).toEqual(['SIGTERM', 'SIGKILL'])
      expect(await outcomes(h)).toEqual(['0 aborted timed-out external'])
    })
  }

  it('times out at BASH_DEFAULT_TIMEOUT_MS (120000) when no timeout is given', async () => {
    expect(BASH_DEFAULT_TIMEOUT_MS).toBe(120_000)
    const h = await harness()
    const runId = await allowed(h, [['Bash', { command: 'sleep 1000' }]])
    h.provider.script(done())
    const child = await spawned(h)
    h.memory.advance(119_999)
    await settle()
    expect(child.kills).toEqual([])
    h.memory.advance(1)
    await settle()
    expect(child.kills.map((kill) => kill.signal)).toEqual(['SIGTERM'])
    await throughKill(h)
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'completed' })
    expect(await outcomes(h)).toEqual(['0 aborted timed-out external'])
  })

  it('wraps the command as the spec’s SandboxRequest, and calls afterExit(commandId) once it exited', async () => {
    const h = await harness({ folders: [WORK, OTHER] })
    const runId = await allowed(h, [['Bash', { command: 'make' }]])
    h.provider.script(done())
    const child = await spawned(h)
    expect(h.afterExit).toEqual([])
    child.exit(0)
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'completed' })
    const call = (await named(h, 'tool/call'))[0]?.payload['providerToolCallId'] as string
    expect(h.wrapped).toMatchObject([
      { commandId: call, cwd: WORK, workspace: [WORK, OTHER], profile: 'workspace-write' },
    ])
    expect(h.memory.sandboxLog).toEqual([`sandbox: passthrough ${call} workspace-write`])
    expect(h.afterExit).toEqual([call])
  })
})

// ----- app-exit --------------------------------------------------------------------------------------

describe('a quit or a closed window (§原因码表 app-exit; 旧 136 the kernel half)', () => {
  for (const trigger of ['quit', 'close-window'] as const) {
    it(`closes a running Bash aborted / app-exit, the undispatched rest not-run / stopped, and ends shutdown-aborted{${trigger}}`, async () => {
      const h = await harness()
      const runId = await allowed(h, [
        ['Bash', { command: 'make' }],
        ['Write', { file_path: FILE, content: 'after\n' }],
      ])
      const child = await spawned(h)
      child.write('half\n')
      await settle()
      h.loop.abort(SESSION, trigger)
      await settle()
      await throughKill(h)
      expect((await h.loop.runEnded({ runId })).reason).toEqual({
        code: 'shutdown-aborted',
        trigger,
      })
      expect(await outcomes(h)).toEqual([
        '0 aborted app-exit external',
        '1 not-run stopped blocked',
      ])
      expect(await resultTexts(h)).toEqual([
        [MODEL_NOTES.closure['app-exit'].aborted, 'half\n'],
        [MODEL_NOTES.closure.stopped['not-run']],
      ])
      // Every dispatched call has an app-exit closure (旧 136).
      const dispatched = (await named(h, 'execution/dispatch_committed')).map(
        (entry) => entry.payload['ordinal'],
      )
      const exits = (await named(h, 'execution/tool_outcome'))
        .filter((entry) => entry.payload['source'] === 'app-exit')
        .map((entry) => entry.payload['ordinal'])
      expect(exits).toEqual(dispatched)
      const terminal = (await named(h, 'execution/run_terminal')).at(-1)
      expect(terminal?.payload['reason']).toEqual({ code: 'shutdown-aborted', trigger })
    })

    it(`closes a Write in flight past the wait uncertain / app-exit on ${trigger}`, async () => {
      const write = gatedWrite()
      const h = await harness({ fs: write.fs })
      const runId = await allowed(h, [['Write', { file_path: FILE, content: 'after\n' }]])
      await write.reached
      h.loop.abort(SESSION, trigger)
      await settle()
      h.memory.advance(STOP_WRITE_WAIT_MS)
      expect((await h.loop.runEnded({ runId })).reason).toEqual({
        code: 'shutdown-aborted',
        trigger,
      })
      expect(await outcomes(h)).toEqual(['0 uncertain app-exit write'])
      expect(await resultTexts(h)).toEqual([[MODEL_NOTES.closure['app-exit'].uncertain]])
      expect(views(h)).toMatchObject([{ state: 'uncertain', source: 'app-exit' }])
      write.release()
      await settle()
    })
  }
})

// ----- a late write after tape.close() -----------------------------------------------------------------

describe('a write that lands after tape.close() (§停止与退出 第 5 步)', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  beforeEach(() => {
    unhandled.length = 0
    process.on('unhandledRejection', onUnhandled)
  })
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
  })

  it('is caught and logged: the Run ends unrecorded, the lease is finished, nothing crashes', async () => {
    const write = gatedWrite()
    const h = await harness({ fs: write.fs })
    const runId = await allowed(h, [
      ['Write', { file_path: FILE, content: 'after\n' }],
      ['Bash', { command: 'make' }],
    ])
    await write.reached
    h.loop.abort(SESSION, 'quit')
    const before = (await entries(h)).length
    // The desktop's shutdown: the wait ran out, the store closes, then the kernel's closure comes.
    await h.store.close()
    h.memory.advance(STOP_WRITE_WAIT_MS)
    const ended = await h.loop.runEnded({ runId })
    expect(ended).toMatchObject({ runId, recorded: false })
    expect(h.loop.liveLease(SESSION)).toBeNull()
    expect(h.loop.leaseLog.every((lease) => lease.finished)).toBe(true)
    expect(h.logs).toEqual([
      expect.stringMatching(new RegExp(`run ${runId} .*did not record its end: .*closed`)),
    ])
    // The host finally answers the write, with an error — Write's own is_error, a call that ran:
    // logged once, still not written.
    write.release(new Error('EIO: the disk went away'))
    await until(() => h.logs.length > 1, 'the late failure logged')
    await settle()
    expect(h.logs[1]).toMatch(/Write call .* closed uncertain .* returned later \(completed\)/)
    expect(h.logs).toHaveLength(2)
    expect(unhandled).toEqual([])
    // What was written before the close is all there is; recovery closes the rest (§启动恢复).
    expect(before).toBeGreaterThan(0)
  })

  it('is caught when a stop reached the pause while it committed and the store closed after it', async () => {
    const h = await harness({
      store: (inner, harnessOf) =>
        afterAppend(inner, async (batch) => {
          const pauses = batch.entries.some(
            (entry) =>
              entry.name === 'execution/run_terminal' &&
              (entry.payload['reason'] as { code: string }).code === 'paused',
          )
          if (pauses) {
            // The stop lands after the paused terminal committed; the exit closes the store.
            await harnessOf().service.stop({ rootSessionId: SESSION })
            await inner.close()
          }
        }),
    })
    const runId = await send(h, [['Bash', { command: 'make' }]])
    const ended = await h.loop.runEnded({ runId })
    expect(ended).toMatchObject({ reason: { code: 'paused' }, recorded: true })
    expect(h.loop.liveLease(SESSION)).toBeNull()
    expect(h.loop.leaseLog.every((lease) => lease.finished)).toBe(true)
    expect(h.logs).toEqual([
      expect.stringMatching(
        new RegExp(`run ${runId} .*its stopped pause was not closed: .*closed`),
      ),
    ])
    await settle()
    expect(unhandled).toEqual([])
  })
})

// ----- 旧 230 -----------------------------------------------------------------------------------------

describe('the STOP constants (旧 230, the STOP part; §上限、守卫与用量)', () => {
  it('are exported from loop/limits.ts, each marked 待校准, the first two within the 1 second', () => {
    const source = readFileSync(new URL('../../src/loop/limits.ts', import.meta.url), 'utf8')
    for (const name of ['STOP_TERM_GRACE_MS', 'STOP_EXIT_CONFIRM_MS', 'STOP_WRITE_WAIT_MS']) {
      const line = source.split('\n').find((text) => text.startsWith(`export const ${name} =`))
      expect(`${name}: ${line ?? 'missing'}`).toMatch(
        new RegExp(`^${name}: export const .*//.*待校准`),
      )
    }
    for (const value of [STOP_TERM_GRACE_MS, STOP_EXIT_CONFIRM_MS, STOP_WRITE_WAIT_MS]) {
      expect(Number.isInteger(value) && value > 0).toBe(true)
    }
    expect(STOP_TERM_GRACE_MS + STOP_EXIT_CONFIRM_MS).toBeLessThanOrEqual(1000)
  })
})
