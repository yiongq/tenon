/**
 * Closing a window and quitting (spec 02 §停止与退出; plan step 23, 旧 137; acceptance 42's unit
 * half): the six steps of `before-quit` on a fake app and a fake store, the window's close confirm,
 * `before-quit-for-update`, and the routes that answer `ok: false` once the shutdown began. The
 * RunRegistry is the real one (chat.ts); the kernel is the real loop where a route is asked.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  STOP_TERM_GRACE_MS,
  STOP_WRITE_WAIT_MS,
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createProviderRegistry,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type {
  CommandShell,
  HostClock,
  ModelInfo,
  RunLease,
  SessionService,
  TapeStore,
} from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestConnector,
  createTestSessionService,
  scriptedTurn,
} from '@tenon-app/kernel/testing'
import type { IpcMainLike } from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import { registerApprovalRoutes } from '../src/main/approval-routes.js'
import { createDesktopLoop, createRunRegistry, registerChatRoutes } from '../src/main/chat.js'
import type { RunRegistry } from '../src/main/chat.js'
import { registerModelRoutes } from '../src/main/model-routes.js'
import { registerSessionRoutes } from '../src/main/session.js'
import {
  EXIT_CONFIRM_CANCEL,
  EXIT_CONFIRM_STOP,
  REFUSED_WHILE_SHUTTING_DOWN,
  SHUTDOWN_SETTLE_MS,
  createShutdown,
  refuseWhileShuttingDown,
} from '../src/main/shutdown.js'
import type { ExitConfirmOptions, ExitCopyKey, ExitDialog, Shutdown } from '../src/main/shutdown.js'
import { registerWorkspaceRoutes } from '../src/main/workspace.js'

const ROOT = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'
const OTHER = '0b8f2a1c-3d4e-4f50-8a61-7b2c3d4e5f60'

/** The copy, by key: what the confirm shows is the catalogue's, never a literal of main's. */
const t = (key: ExitCopyKey): string => `<${key}>`

/** Every timer the registry's `settled` sets, fired by hand. */
function fakeClock(): {
  clock: Pick<HostClock, 'setTimeout'>
  timers: Array<{ ms: number; fire(): void }>
} {
  const timers: Array<{ ms: number; fire(): void }> = []
  return {
    timers,
    clock: {
      setTimeout(fn, ms) {
        let live = true
        timers.push({ ms, fire: () => live && fn() })
        return () => {
          live = false
        }
      },
    },
  }
}

/**
 * Electron's `app`, as the six steps see it: `quit()` emits `before-quit` first, and the app only
 * goes on to quit when no listener prevented it. `userQuits()` is Cmd+Q, the menu, or `window-all-closed`.
 */
function fakeApp(): {
  app: {
    on(event: 'before-quit', listener: (e: { preventDefault(): void }) => void): void
    quit(): void
  }
  userQuits(): boolean
  /** How many times main itself called `app.quit()`. */
  quits(): number
  /** Whether the app got past `before-quit`. */
  exited(): boolean
} {
  const listeners: Array<(e: { preventDefault(): void }) => void> = []
  let quits = 0
  let exited = false
  const emit = (): boolean => {
    let prevented = false
    for (const listener of listeners) listener({ preventDefault: () => (prevented = true) })
    if (!prevented) exited = true
    return prevented
  }
  return {
    app: {
      on: (_event, listener) => void listeners.push(listener),
      quit: () => {
        quits += 1
        emit()
      },
    },
    userQuits: emit,
    quits: () => quits,
    exited: () => exited,
  }
}

interface FakeWindow {
  readonly webContents: object
  readonly closes: number
  close(): void
  isDestroyed(): boolean
}

/**
 * Electron's `dialog.showMessageBox`: each call is recorded with the window it sits over, and waits
 * for the test to answer it.
 */
function fakeDialog(): {
  dialog: ExitDialog<FakeWindow>
  asked: Array<{ over: FakeWindow | null; options: ExitConfirmOptions }>
  answer(index: number, response: number): void
} {
  const asked: Array<{ over: FakeWindow | null; options: ExitConfirmOptions }> = []
  const pending: Array<(value: { response: number }) => void> = []
  const showMessageBox = (
    a: FakeWindow | ExitConfirmOptions,
    b?: ExitConfirmOptions,
  ): Promise<{ response: number }> => {
    asked.push(
      b === undefined
        ? { over: null, options: a as ExitConfirmOptions }
        : { over: a as FakeWindow, options: b },
    )
    return new Promise((resolve) => pending.push(resolve))
  }
  return {
    dialog: { showMessageBox } as ExitDialog<FakeWindow>,
    asked,
    answer: (index, response) => pending[index]?.({ response }),
  }
}

/** The session store's `close`, held until the test lets it resolve. */
function fakeTape(): { tape: { close(): Promise<void> }; closes(): number; resolve(): void } {
  let closes = 0
  const done = Promise.withResolvers<void>()
  return {
    tape: {
      close: () => {
        closes += 1
        return done.promise
      },
    },
    closes: () => closes,
    resolve: () => done.resolve(),
  }
}

function fakeWindow(): FakeWindow & { closes: number } {
  const win = {
    webContents: {},
    closes: 0,
    close() {
      win.closes += 1
    },
    isDestroyed: () => false,
  }
  return win
}

function lease(result: RunLease | { refused: 'shutting-down' }): RunLease {
  if ('refused' in result) throw new Error('refused')
  return result
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

interface Rig {
  readonly app: ReturnType<typeof fakeApp>
  readonly dialog: ReturnType<typeof fakeDialog>
  readonly tape: ReturnType<typeof fakeTape>
  readonly clock: ReturnType<typeof fakeClock>
  readonly registry: RunRegistry
  readonly shutdown: Shutdown<FakeWindow>
  readonly win: FakeWindow & { closes: number }
  readonly log: string[]
}

function rig(options: { registry?: RunRegistry } = {}): Rig {
  const app = fakeApp()
  const dialog = fakeDialog()
  const tape = fakeTape()
  const clock = fakeClock()
  const registry = options.registry ?? createRunRegistry(clock.clock)
  const win = fakeWindow()
  const log: string[] = []
  const shutdown = createShutdown<FakeWindow>({
    app: app.app,
    dialog: dialog.dialog,
    registry,
    tape: tape.tape,
    t,
    parent: () => win,
    log: (line) => log.push(line),
  })
  return { app, dialog, tape, clock, registry, shutdown, win, log }
}

describe('before-quit: the six steps (§停止与退出「退出」)', () => {
  it('with no Run in progress asks nothing, and quits only once the store has closed', async () => {
    const r = rig()
    // Step 1: even an ordinary quit is held, so the store can close first.
    expect(r.app.userQuits()).toBe(true)
    expect(r.app.exited()).toBe(false)
    await flush()
    expect(r.dialog.asked).toEqual([])
    // Step 5 has started; step 6 waits for it.
    expect(r.tape.closes()).toBe(1)
    expect(r.app.quits()).toBe(0)
    await flush()
    expect(r.app.quits()).toBe(0)
    r.tape.resolve()
    await flush()
    // Step 6: main's own quit goes through the listener untouched.
    expect(r.app.quits()).toBe(1)
    expect(r.app.exited()).toBe(true)
    expect(r.tape.closes()).toBe(1)
  })

  it('runs once: a quit repeated while it waits waits on the same run', async () => {
    const r = rig()
    lease(r.registry.begin({ rootSessionId: ROOT, origin: null }))
    r.app.userQuits()
    r.app.userQuits()
    await flush()
    r.app.userQuits()
    expect(r.dialog.asked).toHaveLength(1)
    r.dialog.answer(0, EXIT_CONFIRM_STOP)
    await flush()
    r.app.userQuits()
    // The Run has not finished: the settle timer runs, and still one confirm, one close to come.
    expect(r.clock.timers).toHaveLength(1)
    r.clock.timers[0]?.fire()
    await flush()
    r.tape.resolve()
    await flush()
    expect(r.dialog.asked).toHaveLength(1)
    expect(r.tape.closes()).toBe(1)
    expect(r.app.quits()).toBe(1)
  })

  it('asks while a Run is in progress, in the catalogue’s words; cancel changes nothing', async () => {
    const r = rig()
    const running = lease(r.registry.begin({ rootSessionId: ROOT, origin: null }))
    r.app.userQuits()
    await flush()
    expect(r.dialog.asked).toEqual([
      {
        over: r.win,
        options: {
          type: 'warning',
          message: '<leave.title>',
          detail: '<leave.description>',
          buttons: ['<leave.stopAndQuit>', '<leave.cancel>'],
          defaultId: EXIT_CONFIRM_CANCEL,
          cancelId: EXIT_CONFIRM_CANCEL,
          noLink: true,
        },
      },
    ])
    r.dialog.answer(0, EXIT_CONFIRM_CANCEL)
    await flush()
    expect(running.signal.aborted).toBe(false)
    expect(r.shutdown.started).toBe(false)
    expect(r.tape.closes()).toBe(0)
    expect(r.app.quits()).toBe(0)
    expect(r.app.exited()).toBe(false)
    // Not shutting down: a Run can still begin.
    lease(r.registry.begin({ rootSessionId: OTHER, origin: null })).finish()
    // And the next quit asks again.
    r.app.userQuits()
    await flush()
    expect(r.dialog.asked).toHaveLength(2)
  })

  it('stop: beginShutdown, then abort(all, quit), in one synchronous stretch', async () => {
    const inner = createRunRegistry(fakeClock().clock)
    const order: string[] = []
    const registry: RunRegistry = {
      ...inner,
      beginShutdown: () => {
        order.push('beginShutdown')
        queueMicrotask(() => order.push('a microtask'))
        inner.beginShutdown()
      },
      abort: (target, cause) => {
        order.push(`abort ${JSON.stringify(target)} ${cause}`)
        return inner.abort(target, cause)
      },
      settled: (ms) => {
        order.push(`settled ${String(ms)}`)
        return Promise.resolve()
      },
    }
    const r = rig({ registry })
    const running = lease(registry.begin({ rootSessionId: ROOT, origin: null }))
    r.app.userQuits()
    await flush()
    r.dialog.answer(0, EXIT_CONFIRM_STOP)
    await flush()
    // Nothing runs between the two: not even a microtask queued by the first.
    expect(order.slice(0, 2)).toEqual(['beginShutdown', 'abort "all" quit'])
    expect(order.indexOf('a microtask')).toBeGreaterThan(1)
    expect(order).toContain(`settled ${String(STOP_TERM_GRACE_MS + STOP_WRITE_WAIT_MS)}`)
    expect(running.signal.reason).toBe('quit')
    expect(registry.begin({ rootSessionId: OTHER, origin: null })).toEqual({
      refused: 'shutting-down',
    })
    expect(r.shutdown.started).toBe(true)
  })

  it('waits STOP_TERM_GRACE_MS + STOP_WRITE_WAIT_MS for the aborted Runs, then closes the store', async () => {
    const r = rig()
    lease(r.registry.begin({ rootSessionId: ROOT, origin: null }))
    r.app.userQuits()
    await flush()
    r.dialog.answer(0, EXIT_CONFIRM_STOP)
    await flush()
    // A Run that never finishes: the store waits for the bound, from the kernel's two constants.
    expect(SHUTDOWN_SETTLE_MS).toBe(STOP_TERM_GRACE_MS + STOP_WRITE_WAIT_MS)
    expect(r.clock.timers.map((timer) => timer.ms)).toEqual([
      STOP_TERM_GRACE_MS + STOP_WRITE_WAIT_MS,
    ])
    expect(r.tape.closes()).toBe(0)
    r.clock.timers[0]?.fire()
    await flush()
    expect(r.tape.closes()).toBe(1)
    expect(r.app.quits()).toBe(0)
    r.tape.resolve()
    await flush()
    expect(r.app.quits()).toBe(1)
  })

  it('a Run that finishes within the bound closes the store at once', async () => {
    const r = rig()
    const running = lease(r.registry.begin({ rootSessionId: ROOT, origin: null }))
    r.app.userQuits()
    await flush()
    r.dialog.answer(0, EXIT_CONFIRM_STOP)
    await flush()
    expect(r.tape.closes()).toBe(0)
    running.finish()
    await flush()
    expect(r.tape.closes()).toBe(1)
  })

  it('a Run a closed window already aborted asks nothing, and is still waited for (non-macOS)', async () => {
    const r = rig()
    const closing = lease(r.registry.begin({ rootSessionId: ROOT, origin: null }))
    r.registry.abort({ rootSessionId: ROOT }, 'close-window')
    r.app.userQuits()
    await flush()
    expect(r.dialog.asked).toEqual([])
    // The first cause stands.
    expect(closing.signal.reason).toBe('close-window')
    expect(r.tape.closes()).toBe(0)
    closing.finish()
    await flush()
    expect(r.tape.closes()).toBe(1)
  })

  it('without a store there is nothing to wait for or close: it quits', async () => {
    const app = fakeApp()
    const dialog = fakeDialog()
    createShutdown<FakeWindow>({
      app: app.app,
      dialog: dialog.dialog,
      registry: null,
      tape: null,
      t,
      parent: () => null,
      log: () => {},
    })
    app.userQuits()
    await flush()
    expect(dialog.asked).toEqual([])
    expect(app.quits()).toBe(1)
    expect(app.exited()).toBe(true)
  })

  it('before-quit-for-update is step 3 with quit; the before-quit that follows goes on from step 4', async () => {
    const r = rig()
    const running = lease(r.registry.begin({ rootSessionId: ROOT, origin: null }))
    r.shutdown.beforeQuitForUpdate()
    expect(running.signal.reason).toBe('quit')
    expect(r.shutdown.started).toBe(true)
    expect(r.registry.begin({ rootSessionId: OTHER, origin: null })).toEqual({
      refused: 'shutting-down',
    })
    r.app.userQuits()
    await flush()
    expect(r.dialog.asked).toEqual([])
    running.finish()
    await flush()
    r.tape.resolve()
    await flush()
    expect(r.app.quits()).toBe(1)
  })
})

describe('a window’s close (§停止与退出「关窗」)', () => {
  it('asks only while its document has a Run in progress; cancel changes nothing', async () => {
    const r = rig()
    const idle = { prevented: false, preventDefault: () => (idle.prevented = true) }
    r.shutdown.onClose(r.win, idle)
    // No Run of this window's (a card waiting has no lease): it closes without a word.
    expect(idle.prevented).toBe(false)
    expect(r.dialog.asked).toEqual([])

    const elsewhere = lease(r.registry.begin({ rootSessionId: OTHER, origin: {} }))
    r.shutdown.onClose(r.win, idle)
    expect(idle.prevented).toBe(false)

    const running = lease(r.registry.begin({ rootSessionId: ROOT, origin: r.win.webContents }))
    const asked = { prevented: false, preventDefault: () => (asked.prevented = true) }
    r.shutdown.onClose(r.win, asked)
    expect(asked.prevented).toBe(true)
    await flush()
    expect(r.dialog.asked.map((entry) => [entry.over, entry.options.buttons])).toEqual([
      [r.win, ['<leave.stopAndClose>', '<leave.cancel>']],
    ])
    // A second close while it asks waits on that answer.
    const again = { prevented: false, preventDefault: () => (again.prevented = true) }
    r.shutdown.onClose(r.win, again)
    expect(again.prevented).toBe(true)
    expect(r.dialog.asked).toHaveLength(1)
    r.dialog.answer(0, EXIT_CONFIRM_CANCEL)
    await flush()
    expect(running.signal.aborted).toBe(false)
    expect(r.win.closes).toBe(0)
    expect(elsewhere.signal.aborted).toBe(false)
  })

  it('stop aborts that window’s Runs with close-window and closes it again, which asks no more', async () => {
    const r = rig()
    const running = lease(r.registry.begin({ rootSessionId: ROOT, origin: r.win.webContents }))
    const elsewhere = lease(r.registry.begin({ rootSessionId: OTHER, origin: {} }))
    r.shutdown.onClose(r.win, { preventDefault: () => {} })
    await flush()
    r.dialog.answer(0, EXIT_CONFIRM_STOP)
    await flush()
    expect(running.signal.reason).toBe('close-window')
    expect(running.stopRequested).toBe(false)
    expect(elsewhere.signal.aborted).toBe(false)
    expect(r.win.closes).toBe(1)
    const second = { prevented: false, preventDefault: () => (second.prevented = true) }
    r.shutdown.onClose(r.win, second)
    expect(second.prevented).toBe(false)
    expect(r.dialog.asked).toHaveLength(1)
    // The store stays open: the Run's closing writes still land.
    expect(r.tape.closes()).toBe(0)
    expect(r.shutdown.started).toBe(false)
  })

  it('once the shutdown began, no close asks', async () => {
    const r = rig()
    lease(r.registry.begin({ rootSessionId: ROOT, origin: null }))
    r.app.userQuits()
    await flush()
    r.dialog.answer(0, EXIT_CONFIRM_STOP)
    await flush()
    // A Run begun before, by this window, is aborted and closing; nothing of it asks now.
    const closing = { prevented: false, preventDefault: () => (closing.prevented = true) }
    r.shutdown.onClose(r.win, closing)
    expect(closing.prevented).toBe(false)
    expect(r.dialog.asked).toHaveLength(1)
  })
})

// ---- the routes once the shutdown began (step 3) ------------------------------------------------

type Handler = (event: unknown, ...args: unknown[]) => unknown

function fakeIpc(): {
  ipcMain: IpcMainLike
  call(channel: string, payload: unknown): Promise<unknown>
} {
  const handlers = new Map<string, Handler>()
  return {
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
    async call(channel, payload) {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`no handler for ${channel}`)
      return handler({}, payload)
    },
  }
}

const MODEL: ModelInfo = {
  id: 'claude-quit-1',
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

const NO_SHELL: CommandShell = { path: absolutePath('/bin/sh'), env: () => Promise.resolve({}) }

/** The memory store, its appends counted and its `close` held open until the test lets it go. */
function countedTape(inner: TapeStore): {
  store: TapeStore
  appends(): number
  closes(): number
  release(): void
} {
  let appends = 0
  let closes = 0
  const held = Promise.withResolvers<void>()
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'append') {
        return (batch: Parameters<TapeStore['append']>[0]) => {
          appends += 1
          return target.append(batch)
        }
      }
      if (property === 'close') {
        return async () => {
          closes += 1
          await held.promise
          await target.close()
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { store, appends: () => appends, closes: () => closes, release: () => held.resolve() }
}

/** Every method of the service a route calls, by name, in order. */
function recorded(sessions: SessionService): { sessions: SessionService; reached: string[] } {
  const reached: string[] = []
  const proxy = new Proxy(sessions, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        reached.push(String(property))
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  return { sessions: proxy, reached }
}

/** A valid request for every refused route: what reaches its handler when no shutdown is on. */
function refusedRequests(sessionId: string): Array<[string, unknown]> {
  return [
    ['chat.send', { sessionId, text: 'one more' }],
    ['chat.sendNow', { sessionId, text: 'now', runId: null }],
    ['chat.queue.act', { sessionId, queuedId: 'q-1', action: 'send-now', runId: null }],
    ['chat.stop', { sessionId }],
    ['chat.continue', { sessionId }],
    ['approval.respond', { kind: 'approval', sessionId, requestId: 'r-1', decision: 'allow' }],
    ['approval.resume', { sessionId }],
    [
      'session.selectModel',
      { sessionId, providerId: 'anthropic', modelId: 'claude-quit-1', effort: null },
    ],
    ['session.selectProfile', { sessionId, profile: 'cowork' }],
    ['workspace.pick', { sessionId }],
    ['workspace.usePrefill', { sessionId }],
    ['workspace.remove', { sessionId, folder: '/tmp/x' }],
  ]
}

describe('once the shutdown began, a route that opens a Run or writes a fact answers ok: false', () => {
  it('lists the sends, the queue, the stop, 「继续」, the answers, the resume and the fact writers', () => {
    expect([...REFUSED_WHILE_SHUTTING_DOWN].toSorted()).toEqual(
      refusedRequests(ROOT)
        .map(([channel]) => channel)
        .toSorted(),
    )
  })

  it('chat.send and approval.respond, and every other writer: no Run opens and no fact is written', async () => {
    const host = createMemoryHost()
    const tape = countedTape(createMemoryTapeStore({ identity: host.identity }))
    const provider = createScriptedProvider({ models: [MODEL] })
    provider.script(scriptedTurn({ deltas: ['first'] }))
    provider.script(scriptedTurn({ deltas: ['never'] }))
    const kernel = createTestSessionService(
      {
        host,
        tape: tape.store,
        ids: createCounterIds(),
        inspectors: [],
        connector: createTestConnector({ provider, model: MODEL }),
        protectedFiles: [],
      },
      { tools: {} },
    )
    const { sessions, reached } = recorded(kernel)
    const loop = createDesktopLoop({
      clock: host.clock,
      send: () => {},
      locale: () => 'en',
      commandShell: NO_SHELL,
      log: () => {},
    })
    kernel.bindLoop(loop.ports)
    const app = fakeApp()
    const dialog = fakeDialog()
    const shutdown = createShutdown<FakeWindow>({
      app: app.app,
      dialog: dialog.dialog,
      registry: loop.registry,
      tape: tape.store,
      t,
      parent: () => null,
      log: () => {},
    })
    const ipc = fakeIpc()
    const routes = refuseWhileShuttingDown(ipc.ipcMain, () => shutdown.started)
    registerChatRoutes({ send: () => {}, ipcMain: routes, sessions, loop, log: () => {} })
    registerApprovalRoutes({ ipcMain: routes, sessions })
    registerSessionRoutes({ ipcMain: routes, sessions })
    registerWorkspaceRoutes({
      ipcMain: routes,
      sessions,
      host,
      home: absolutePath('/home/me'),
      pickFolders: () => Promise.resolve(['/tmp/x']),
    })
    const providers = createProviderRegistry()
    registerBuiltinProviders(providers)
    registerModelRoutes({ ipcMain: routes, sessions, providers, host })

    // Before: a send opens a Run and writes it.
    const sessionId = randomUUID()
    expect(await ipc.call('chat.send', { sessionId, text: 'hi' })).toEqual({
      ok: true,
      data: { accepted: true, status: 'started' },
    })
    await expect.poll(() => loop.registry.snapshot()).toEqual([])
    const written = tape.appends()
    expect(written).toBeGreaterThan(0)
    expect(provider.starts).toBe(1)

    // No Run in progress: the quit asks nothing, and holds at the store's close.
    app.userQuits()
    await flush()
    expect(dialog.asked).toEqual([])
    expect(shutdown.started).toBe(true)
    expect(tape.closes()).toBe(1)
    reached.length = 0

    for (const [channel, payload] of refusedRequests(sessionId)) {
      // oxlint-disable-next-line no-await-in-loop -- one route at a time, each on its own
      const answer = await ipc.call(channel, payload)
      expect([channel, answer]).toEqual([
        channel,
        { ok: false, error: { code: 'handler-failed', message: 'the app is shutting down' } },
      ])
    }
    // Nothing reached the kernel: no Run was begun, no fact written, no request sent.
    expect(reached).toEqual([])
    expect(loop.registry.snapshot()).toEqual([])
    expect(tape.appends()).toBe(written)
    expect(provider.starts).toBe(1)

    // The reads still answer, from the store that is still open.
    expect(await ipc.call('session.latest', { limit: 10 })).toMatchObject({
      ok: true,
      data: { sessionId },
    })
    expect(await ipc.call('approval.list', { limit: 20 })).toEqual({ ok: true, data: [] })
    expect(reached).toEqual(['latestSession', 'listPendingRoots'])

    tape.release()
    await flush()
    expect(app.quits()).toBe(1)
  })
})

// ---- no number of the desktop's own (§停止与退出 第 4 步) --------------------------------------

/** Every source file of apps/desktop that is ours: not installed, not built, not a screenshot. */
function desktopSources(dir: string): string[] {
  const skipped = new Set(['node_modules', 'out', 'dist', '__screenshots__', 'test-results'])
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (!skipped.has(name)) files.push(...desktopSources(path))
    } else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs|json)$/u.test(name)) {
      files.push(path)
    }
  }
  return files
}

describe('the quit’s wait is the kernel’s', () => {
  it('apps/desktop holds no literal of the two constants’ sum', () => {
    // Built so that this file does not match itself: a 2, an optional separator, then 500.
    const literal = new RegExp(`(?<![\\w.])${'2'}_?${'500'}(?![\\d_])`, 'u')
    expect(literal.test(['2', '500'].join(''))).toBe(true)
    expect(literal.test(['2', '500'].join('_'))).toBe(true)
    expect(literal.test(['2', '5000'].join(''))).toBe(false)
    const root = join(import.meta.dirname, '..')
    const files = desktopSources(root)
    expect(files.length).toBeGreaterThan(100)
    const found = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          literal.test(line) ? [`${relative(root, file)}:${String(index + 1)}`] : [],
        ),
    )
    expect(found).toEqual([])
  })
})
