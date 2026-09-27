/**
 * `run.state` (spec 02 §进行中、暂停与 RunRegistry「runId 的来历」「何时推」, §主进程与 kernel 的循环接口
 * 「租约」「Run 结束」; plan step 20, open question 16's added test points): the main process pushes a
 * root's `running` and `runId` whenever either changes — begin, abort, finish, the lease's first
 * `run-started` — once per synchronous stretch with the last values, for every Run the kernel opens:
 * a send, an answer, 「继续」 and an auto-send alike, because the renderer's thread sees none but the
 * first.
 *
 * The desktop half is the real one (`createDesktopLoop`, its RunRegistry, run-events.ts, the chat and
 * approval routes); the kernel is the real loop, with the scripted provider behind the test
 * connector so a case can hold a prebuild or a stream open without a timer.
 */
import { randomUUID } from 'node:crypto'
import { chatEvent, chatQueueEvent, runStateEvent } from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '@tenon-app/kernel'
import type {
  CommandShell,
  MemoryHost,
  ModelInfo,
  RunLease,
  SessionEvent,
  SessionService,
  StreamEvent,
  Usage,
} from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestConnector,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '@tenon-app/kernel/testing'
import type { ScriptedProvider, TestConnector } from '@tenon-app/kernel/testing'
import { describe, expect, it } from 'vitest'
import { registerApprovalRoutes } from '../src/main/approval-routes.js'
import { createDesktopLoop, createRunRegistry, registerChatRoutes } from '../src/main/chat.js'
import type { DesktopLoop, RootRunState } from '../src/main/chat.js'
import { replayOnLoad } from '../src/main/window-replay.js'

/** These cases run no Bash: the shell is a stand-in. */
const NO_SHELL: CommandShell = { path: absolutePath('/bin/sh'), env: () => Promise.resolve({}) }

const MODEL: ModelInfo = {
  id: 'claude-state-1',
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

type Handler = (event: unknown, payload: unknown) => unknown

/** The scripted provider, whose NEXT stream can be held before its first event. */
interface GatedProvider {
  readonly provider: ScriptedProvider
  hold(): { readonly reached: Promise<void>; readonly release: () => void }
}

function gated(inner: ScriptedProvider): GatedProvider {
  let held: { reached: () => void; gate: Promise<void> } | null = null
  const stream: ScriptedProvider['stream'] = (encoded, ctx) => {
    const hold = held
    held = null
    if (hold === null) return inner.stream(encoded, ctx)
    return (async function* (): AsyncIterable<StreamEvent> {
      hold.reached()
      await hold.gate
      yield* inner.stream(encoded, ctx)
    })()
  }
  const provider = new Proxy(inner, {
    get(target, key): unknown {
      if (key === 'stream') return stream
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
  return {
    provider,
    hold() {
      const reached = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      held = { reached: reached.resolve, gate: gate.promise }
      return { reached: reached.promise, release: gate.resolve }
    },
  }
}

type Listener = (...args: unknown[]) => void

/**
 * A WebContents as main reads it: the chat routes' two "the document is gone" events, the load event
 * the replay listens on, and what was sent to this document alone.
 */
function fakeWindow(): {
  event: { sender: unknown }
  contents: Parameters<typeof replayOnLoad>[0]
  /** What main sent to this window's document, in order. */
  received: Array<[string, unknown]>
  close(): void
  /** The View menu's Reload: the main frame navigates to a new document, which then loads. */
  reload(): void
} {
  const listeners = new Map<string, Set<Listener>>()
  const received: Array<[string, unknown]> = []
  const emit = (name: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }
  const sender = {
    on(name: string, listener: Listener): void {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
    },
    off(name: string, listener: Listener): void {
      listeners.get(name)?.delete(listener)
    },
    send(channel: string, payload: unknown): void {
      received.push([channel, payload])
    },
  }
  return {
    event: { sender },
    contents: sender,
    received,
    close: () => emit('destroyed'),
    reload: () => {
      emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      emit('did-finish-load')
    },
  }
}

interface Harness {
  readonly root: string
  readonly memory: MemoryHost
  readonly sessions: SessionService
  readonly loop: DesktopLoop
  readonly connector: TestConnector
  readonly scripted: ScriptedProvider
  readonly gate: GatedProvider
  /** Every `run.state` main sent, in order. */
  readonly states: RootRunState[]
  /** Every loop event, in the order the kernel sent them. */
  readonly seen: SessionEvent[]
  call(channel: string, payload: unknown, event?: unknown): Promise<unknown>
}

function harness(): Harness {
  const memory = createMemoryHost()
  const scripted = createScriptedProvider({ models: [MODEL] })
  const gate = gated(scripted)
  const connector = createTestConnector({ provider: gate.provider, model: MODEL })
  const sessions = createTestSessionService(
    {
      host: memory,
      tape: createMemoryTapeStore({ identity: memory.identity }),
      ids: createCounterIds(),
      inspectors: [],
      connector,
      protectedFiles: [],
    },
    { tools: {} },
  )
  const root = randomUUID()
  const states: RootRunState[] = []
  const seen: SessionEvent[] = []
  const record = (channel: string, payload: unknown): void => {
    if (channel !== runStateEvent.channel) return
    // What crosses is the contract's shape, for the root it names.
    const parsed = runStateEvent.payload.parse(payload)
    expect(parsed.sessionId).toBe(root)
    states.push({ running: parsed.running, runId: parsed.runId })
  }
  const loop = createDesktopLoop({
    clock: memory.clock,
    send: record,
    locale: () => 'en',
    commandShell: NO_SHELL,
    log: () => {},
  })
  // The kernel's events reach run-events.ts unchanged; the case only keeps a copy of each.
  sessions.bindLoop({
    ...loop.ports,
    events: (event) => {
      seen.push(event)
      loop.ports.events(event)
    },
  })
  const handlers = new Map<string, Handler>()
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener as Handler)
    },
  }
  registerChatRoutes({ send: record, ipcMain, sessions, loop, log: () => {} })
  registerApprovalRoutes({ ipcMain, sessions })
  return {
    root,
    memory,
    sessions,
    loop,
    connector,
    scripted,
    gate,
    states,
    seen,
    async call(channel, payload, event = {}) {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`no handler for ${channel}`)
      return handler(event, payload)
    },
  }
}

const idle: RootRunState = { running: false, runId: null }
const preparing: RootRunState = { running: true, runId: null }
const runningAs = (runId: string): RootRunState => ({ running: true, runId })
const abortedAs = (runId: string): RootRunState => ({ running: false, runId })

/** The Runs the kernel opened, in order. */
function runIds(h: Harness): string[] {
  return h.seen.flatMap((event) => (event.type === 'run-started' ? [event.runId] : []))
}

function ended(h: Harness): number {
  return h.seen.filter((event) => event.type === 'run-ended').length
}

/** Waits until `count` Runs (or lease-only rounds) have ended and the last push has gone out. */
async function settle(h: Harness, count: number, last: RootRunState = idle): Promise<void> {
  await expect.poll(() => ended(h)).toBe(count)
  await expect.poll(() => h.states.at(-1)).toEqual(last)
}

function send(h: Harness, text: string, event?: unknown): Promise<unknown> {
  return h.call('chat.send', { sessionId: h.root, text }, event)
}

describe('run.state for the Runs a route opens', () => {
  it('shows a send as running with no Run through its prebuild, then its Run, then idle', async () => {
    const h = harness()
    const prebuild = h.connector.holdAssemble()
    h.scripted.script(scriptedTurn({ deltas: ['hi'], usage: USAGE }))
    // The send answers once its Run is open, so it is not awaited while the prebuild is held.
    const sending = send(h, 'hello')
    await prebuild.reached
    // Holding the lease counts as running before any Run exists (§进行中).
    await expect.poll(() => h.states).toEqual([preparing])
    expect(h.loop.registry.running()).toEqual([h.root])
    prebuild.release()
    expect(await sending).toEqual({ ok: true, data: { accepted: true, status: 'started' } })
    await settle(h, 1)
    const [r1] = runIds(h)
    expect(h.states).toEqual([preparing, runningAs(r1 ?? ''), idle])
  })

  it('keeps the runId, not running, once a stop aborts the Run; null once it has finished', async () => {
    const h = harness()
    const stream = h.gate.hold()
    h.scripted.script(scriptedTurn({ deltas: ['never'], usage: USAGE }))
    await send(h, 'hello')
    await stream.reached
    const [r1] = runIds(h)
    expect(await h.call('chat.stop', { sessionId: h.root })).toEqual({
      ok: true,
      data: { stopped: true },
    })
    // Aborted and still closing: not running, and still that Run (spec: 已中止、在收尾的仍报).
    await expect.poll(() => h.states.at(-1)).toEqual(abortedAs(r1 ?? ''))
    expect(h.loop.registry.running()).toEqual([])
    stream.release()
    await settle(h, 1)
    expect(h.states).toEqual([preparing, runningAs(r1 ?? ''), abortedAs(r1 ?? ''), idle])
  })

  it('does the same when the window that asked for the Run goes away', async () => {
    const h = harness()
    const win = fakeWindow()
    const stream = h.gate.hold()
    h.scripted.script(scriptedTurn({ deltas: ['never'], usage: USAGE }))
    await send(h, 'hello', win.event)
    await stream.reached
    const [r1] = runIds(h)
    win.close()
    await expect.poll(() => h.states.at(-1)).toEqual(abortedAs(r1 ?? ''))
    stream.release()
    await settle(h, 1)
    expect(h.states).toEqual([preparing, runningAs(r1 ?? ''), abortedAs(r1 ?? ''), idle])
  })

  it('pushes an auto-send’s finish and begin once: running, no Run, through its prebuild', async () => {
    const h = harness()
    const stream = h.gate.hold()
    h.scripted.script(scriptedTurn({ deltas: ['one'], usage: USAGE }))
    h.scripted.script(scriptedTurn({ deltas: ['two'], usage: USAGE }))
    await send(h, 'first')
    await stream.reached
    // Queued behind the streaming reply, which has no batch boundary left to insert it at.
    expect(await send(h, 'second')).toEqual({
      ok: true,
      data: { accepted: true, status: 'queued' },
    })
    await expect.poll(async () => (await h.loop.queue.peek(h.root)).length).toBe(1)
    const prebuild = h.connector.holdAssemble()
    stream.release()
    await prebuild.reached
    const [r1] = runIds(h)
    // The first Run's finish and the auto-send's begin are one synchronous stretch: one push, with
    // the last values — never an idle in between (「Run 结束」: finish and begin, no await).
    await expect.poll(() => h.states).toEqual([preparing, runningAs(r1 ?? ''), preparing])
    expect(h.loop.registry.running()).toEqual([h.root])
    prebuild.release()
    await settle(h, 2)
    const [, r2] = runIds(h)
    expect(r2).not.toBe(r1)
    expect(h.states).toEqual([preparing, runningAs(r1 ?? ''), preparing, runningAs(r2 ?? ''), idle])
  })

  it('pushes the Run an answer opens, which the renderer never started (旧 134)', async () => {
    const h = harness()
    // WebFetch asks in the manual mode: the Run pauses on its card, and pausing ends the Run.
    h.scripted.script([
      { type: 'tool-call-start', index: 1, id: 'toolu_f', name: 'WebFetch' },
      {
        type: 'tool-call-end',
        index: 1,
        id: 'toolu_f',
        name: 'WebFetch',
        input: { url: 'https://example.com/' },
      },
      { type: 'usage', usage: USAGE },
      stopEvent('tool-use', 'tool_use'),
    ])
    await send(h, 'fetch it')
    await settle(h, 1)
    const [r1] = runIds(h)
    expect(h.states).toEqual([preparing, runningAs(r1 ?? ''), idle])
    const pending = await h.sessions.currentPending({ sessionId: h.root })
    expect(pending).not.toBeNull()

    h.scripted.script(scriptedTurn({ deltas: ['fetched'], usage: USAGE }))
    expect(
      await h.call('approval.respond', {
        kind: 'approval',
        sessionId: h.root,
        requestId: pending?.card.requestId,
        decision: 'allow',
      }),
    ).toEqual({ ok: true, data: { status: 'applied' } })
    await settle(h, 2)
    const [, r2] = runIds(h)
    expect(r2).not.toBe(r1)
    expect(h.states).toEqual([
      preparing,
      runningAs(r1 ?? ''),
      idle,
      preparing,
      runningAs(r2 ?? ''),
      idle,
    ])
  })

  it('re-sends a reloaded document the Run its old document began, aborted, and the queue', async () => {
    const h = harness()
    const win = fakeWindow()
    replayOnLoad(win.contents, h.loop)
    const stream = h.gate.hold()
    h.scripted.script(scriptedTurn({ deltas: ['never'], usage: USAGE }))
    await send(h, 'first', win.event)
    await stream.reached
    const [r1] = runIds(h)
    expect(await send(h, 'second', win.event)).toEqual({
      ok: true,
      data: { accepted: true, status: 'queued' },
    })
    const [queued] = await h.loop.queue.peek(h.root)
    expect(win.received).toEqual([])

    // The reload replaces the document the Run belongs to (watchOwner: close-window), and the new
    // document is re-sent that Run — not running, still closing — and the message still queued.
    win.reload()
    expect(win.received).toEqual([
      [runStateEvent.channel, { sessionId: h.root, running: false, runId: r1 }],
      [
        chatQueueEvent.channel,
        { sessionId: h.root, items: [{ queuedId: queued?.queuedId, text: 'second' }] },
      ],
    ])
    await expect.poll(() => h.states.at(-1)).toEqual(abortedAs(r1 ?? ''))

    stream.release()
    await settle(h, 1)
    // A document closing a window's Run keeps the queue (§插话「Run 结束时」): only it is re-sent now.
    win.received.length = 0
    win.reload()
    expect(win.received).toEqual([
      [
        chatQueueEvent.channel,
        { sessionId: h.root, items: [{ queuedId: queued?.queuedId, text: 'second' }] },
      ],
    ])
    expect(h.states).toEqual([preparing, runningAs(r1 ?? ''), abortedAs(r1 ?? ''), idle])
  })

  it('pushes the Run 「继续」 opens after a truncated reply', async () => {
    const h = harness()
    h.scripted.script(
      scriptedTurn({
        deltas: ['half'],
        usage: USAGE,
        terminal: stopEvent('max-tokens', 'max_tokens'),
      }),
    )
    await send(h, 'write it all')
    await settle(h, 1)
    const [r1] = runIds(h)
    h.scripted.script(scriptedTurn({ deltas: ['rest'], usage: USAGE }))
    expect(await h.call('chat.continue', { sessionId: h.root })).toEqual({
      ok: true,
      data: { status: 'started' },
    })
    await settle(h, 2)
    const [, r2] = runIds(h)
    expect(h.states).toEqual([
      preparing,
      runningAs(r1 ?? ''),
      idle,
      preparing,
      runningAs(r2 ?? ''),
      idle,
    ])
  })
})

const REGISTRY_ROOT = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'

/** A RunRegistry whose pushes are recorded as they would be sent. */
function recorded(): {
  registry: ReturnType<typeof createRunRegistry>
  pushes: Array<[string, RootRunState]>
} {
  const pushes: Array<[string, RootRunState]> = []
  const registry = createRunRegistry(createMemoryHost().clock, (root, state) =>
    pushes.push([root, state]),
  )
  return { registry, pushes }
}

function leaseOf(registry: ReturnType<typeof createRunRegistry>, root = REGISTRY_ROOT) {
  const begun = registry.begin({ rootSessionId: root, origin: null })
  if ('refused' in begun) throw new Error('refused')
  return begun
}

/** Lets the pushes queued in the stretch before go out. */
const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

describe('the RunRegistry’s pushes', () => {
  const ROOT = REGISTRY_ROOT

  it('pushes a finish and the next begin in one synchronous stretch once, with the last values', async () => {
    const { registry, pushes } = recorded()
    const first = leaseOf(registry)
    registry.noteRunStarted(ROOT, 'run-1')
    await flush()
    // begin and the first run-started in one stretch: one push.
    expect(pushes).toEqual([[ROOT, runningAs('run-1')]])
    first.finish()
    const next = leaseOf(registry)
    await flush()
    expect(pushes).toEqual([
      [ROOT, runningAs('run-1')],
      [ROOT, preparing],
    ])
    // The new lease's first Run is its runId (a handoff's parent Run has this shape too).
    registry.noteRunStarted(ROOT, 'run-2')
    await flush()
    next.finish()
    await flush()
    expect(pushes.slice(2)).toEqual([
      [ROOT, runningAs('run-2')],
      [ROOT, idle],
    ])
  })

  it('pushes nothing when neither value changed: a later run-started, a second abort', async () => {
    const { registry, pushes } = recorded()
    const live = leaseOf(registry)
    registry.noteRunStarted(ROOT, 'run-1')
    await flush()
    // A sub-agent's Run under the same lease is not the lease's Run.
    registry.noteRunStarted(ROOT, 'child-run')
    await flush()
    live.abort('user-stop')
    await flush()
    registry.abort({ rootSessionId: ROOT }, 'close-window')
    registry.abort('all', 'quit')
    await flush()
    expect(pushes).toEqual([
      [ROOT, runningAs('run-1')],
      [ROOT, abortedAs('run-1')],
    ])
    live.finish()
    await flush()
    expect(pushes.at(-1)).toEqual([ROOT, idle])
  })

  it('pushes each root on its own', async () => {
    const { registry, pushes } = recorded()
    const OTHER = '0b8f2a1c-3d4e-4f50-8a61-7b2c3d4e5f60'
    const mine = leaseOf(registry)
    const theirs = leaseOf(registry, OTHER)
    await flush()
    expect(pushes).toEqual([
      [ROOT, preparing],
      [OTHER, preparing],
    ])
    mine.finish()
    await flush()
    expect(pushes.at(-1)).toEqual([ROOT, idle])
    theirs.finish()
  })

  it('pushes what the registry’s own abort reaches, by root and then all, and nothing else', async () => {
    // §进行中、暂停与 RunRegistry: `abort` is the port the host stops a root or every root with; the
    // renderer's stop button and leave dialog read the push, not the lease.
    const { registry, pushes } = recorded()
    const OTHER = '0b8f2a1c-3d4e-4f50-8a61-7b2c3d4e5f60'
    const mine = leaseOf(registry)
    const theirs = leaseOf(registry, OTHER)
    registry.noteRunStarted(ROOT, 'run-1')
    registry.noteRunStarted(OTHER, 'run-2')
    await flush()
    pushes.length = 0
    expect(registry.abort({ rootSessionId: ROOT }, 'close-window')).toBe(true)
    await flush()
    expect(pushes).toEqual([[ROOT, abortedAs('run-1')]])
    expect(registry.abort('all', 'quit')).toBe(true)
    await flush()
    expect(pushes).toEqual([
      [ROOT, abortedAs('run-1')],
      [OTHER, abortedAs('run-2')],
    ])
    mine.finish()
    theirs.finish()
  })
})

/**
 * A sub-agent's Runs (spec 02 §进行中、暂停与 RunRegistry「runId 的来历」): the kernel opens none yet —
 * the Agent tool lands at plan step 31 — so these cases hand the desktop's loop ports the events and
 * leases the kernel will: the half under test is run-events.ts and the RunRegistry behind them.
 */
function wired(): { loop: DesktopLoop; sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = []
  const loop = createDesktopLoop({
    clock: createMemoryHost().clock,
    send: (channel, payload) => sent.push([channel, payload]),
    locale: () => 'en',
    commandShell: NO_SHELL,
    log: () => {},
  })
  return { loop, sent }
}

/** The `run.state` pushes among what main sent, each through the contract. */
function statesOf(sent: ReadonlyArray<[string, unknown]>): unknown[] {
  return sent.flatMap(([channel, payload]) =>
    channel === runStateEvent.channel ? [runStateEvent.payload.parse(payload)] : [],
  )
}

describe('run.state for a sub-agent’s Runs (the desktop half)', () => {
  const ROOT = REGISTRY_ROOT
  const CHILD = '7e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b'

  function begun(loop: DesktopLoop): RunLease {
    const lease = loop.ports.leases.begin({ rootSessionId: ROOT, origin: null })
    if ('refused' in lease) throw new Error('refused')
    return lease
  }

  it('reports the Run a child session’s answer opens, then the parent’s Run that takes the handoff', async () => {
    const { loop, sent } = wired()
    // The answer to a card the child raised: the root's lease, whose first Run is the child's.
    const answer = begun(loop)
    loop.ports.events({
      type: 'run-started',
      rootSessionId: ROOT,
      sessionId: CHILD,
      runId: 'child',
    })
    loop.ports.events({
      type: 'text-delta',
      rootSessionId: ROOT,
      sessionId: CHILD,
      runId: 'child',
      delta: 'working',
    })
    await flush()
    expect(statesOf(sent)).toEqual([{ sessionId: ROOT, running: true, runId: 'child' }])

    // The child hands off: its lease finishes and the parent's receiving Run is begun in one
    // stretch; the parent's run-started makes it the root's Run.
    answer.finish()
    const handoff = begun(loop)
    await flush()
    loop.ports.events({
      type: 'run-started',
      rootSessionId: ROOT,
      sessionId: ROOT,
      runId: 'parent',
    })
    await flush()
    handoff.finish()
    await flush()
    expect(statesOf(sent)).toEqual([
      { sessionId: ROOT, running: true, runId: 'child' },
      { sessionId: ROOT, running: true, runId: null },
      { sessionId: ROOT, running: true, runId: 'parent' },
      { sessionId: ROOT, running: false, runId: null },
    ])
    // Only the RunRegistry hears the child: its delta never reaches the renderer's stream, and no
    // run-started is a chat.event (run-events.ts).
    expect(sent.filter(([channel]) => channel === chatEvent.channel)).toEqual([])
  })

  it('keeps the parent’s Run when a child’s Run starts under the same lease', async () => {
    const { loop, sent } = wired()
    const live = begun(loop)
    loop.ports.events({
      type: 'run-started',
      rootSessionId: ROOT,
      sessionId: ROOT,
      runId: 'parent',
    })
    await flush()
    // The parent runs its Agent call: the child's Run uses the parent's lease (§RunRegistry).
    loop.ports.events({
      type: 'run-started',
      rootSessionId: ROOT,
      sessionId: CHILD,
      runId: 'child',
    })
    await flush()
    live.abort('user-stop')
    await flush()
    live.finish()
    await flush()
    expect(statesOf(sent)).toEqual([
      { sessionId: ROOT, running: true, runId: 'parent' },
      { sessionId: ROOT, running: false, runId: 'parent' },
      { sessionId: ROOT, running: false, runId: null },
    ])
  })
})
