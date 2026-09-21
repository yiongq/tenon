/**
 * The chat path on the Tape (spec 01 §desktop 接线, 验收 5; phase 0 验收 4 does not regress).
 *
 * Every behaviour phase 0 pinned is still pinned here — streaming, stop, the partial reply, the
 * failed turn, the retry, release-before-terminal, a stop that lands during setup — but each one
 * is now also asked of the transcript, because the transcript is what the next request is built
 * from. The provider is the real kernel adapter talking to the `node:http` fake over the host's
 * network seam: this is a HOST-level test, and the kernel is never allowed to reach that server.
 */
import { randomUUID } from 'node:crypto'
import {
  createMemoryHost,
  createMemoryTapeStore,
  createProviderRegistry,
  createSessionService,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type { HostAdapter, MessageRow, SessionService } from '@tenon-app/kernel'
import type { ChatEvent, IpcMainLike } from '@tenon-app/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { registerChatRoutes } from '../src/main/chat.js'
import { registerSessionRoutes } from '../src/main/session.js'
import { startFakeAnthropic } from './support/fake-anthropic.js'
import type { FakeAnthropic } from './support/fake-anthropic.js'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function fakeIpc(): {
  ipcMain: IpcMainLike
  /** `event` stands in for Electron's `IpcMainInvokeEvent`; only its `sender` is ever read. */
  call(channel: string, payload: unknown, event?: unknown): Promise<unknown>
} {
  const handlers = new Map<string, Handler>()
  return {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
    },
    async call(channel, payload, event = {}) {
      const h = handlers.get(channel)
      if (!h) throw new Error(`no handler for ${channel}`)
      return h(event, payload)
    },
  }
}

/**
 * The half of a WebContents this path uses: the two events that say the document is gone. The
 * shape of `did-start-navigation`'s details is Electron's own (pinned at 44.4.1).
 */
function fakeWindow(): {
  event: { sender: unknown }
  close(): void
  reload(): void
  listenerCount(): number
} {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const emit = (name: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }
  const sender = {
    on(name: string, listener: (...args: unknown[]) => void): void {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
    },
    off(name: string, listener: (...args: unknown[]) => void): void {
      listeners.get(name)?.delete(listener)
    },
  }
  return {
    event: { sender },
    close: () => emit('destroyed'),
    reload: () =>
      emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'app://x' }),
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  }
}

function collector(): {
  events: ChatEvent[]
  send: (channel: string, payload: unknown) => void
  /** Runs on the terminal event, INSIDE the send — how release-before-terminal is observed. */
  onTerminal: (fn: () => void) => void
  waitFor(type: ChatEvent['type']): Promise<ChatEvent>
} {
  const events: ChatEvent[] = []
  const waiters: Array<{ type: ChatEvent['type']; resolve: (e: ChatEvent) => void }> = []
  let terminal: (() => void) | null = null
  return {
    events,
    send(_channel, payload) {
      const event = payload as ChatEvent
      events.push(event)
      if (event.type !== 'text-delta') terminal?.()
      const matched = waiters.filter((w) => w.type === event.type)
      for (const w of matched) waiters.splice(waiters.indexOf(w), 1)
      for (const w of matched) w.resolve(event)
    },
    onTerminal(fn) {
      terminal = fn
    },
    waitFor(type) {
      const existing = events.find((e) => e.type === type)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve) => waiters.push({ type, resolve }))
    },
  }
}

interface Harness {
  readonly ipc: ReturnType<typeof fakeIpc>
  readonly out: ReturnType<typeof collector>
  readonly sessions: SessionService
  readonly host: HostAdapter
  readonly sessionId: string
}

/**
 * A memory host whose only real capability is the network: the kernel provider talks to the fake
 * server through it, exactly as the desktop host would.
 *
 * The environment is passed in, never read from the process: a developer with a real
 * `ANTHROPIC_AUTH_TOKEN` or `TENON_MAX_TOKENS` exported would otherwise be running a different
 * test from CI's — with their own credential resolved and sent to the fake server.
 */
function harness(options: { host?: HostAdapter; env?: Record<string, string> } = {}): Harness {
  const host =
    options.host ??
    createMemoryHost({ network: { fetch: (input, init) => globalThis.fetch(input, init) } })
  const tape = createMemoryTapeStore({ identity: host.identity })
  const sessions = createSessionService({ host, tape, ids: { uuid: (): string => randomUUID() } })
  const providers = createProviderRegistry()
  registerBuiltinProviders(providers)
  const ipc = fakeIpc()
  const out = collector()
  registerChatRoutes({
    host,
    send: out.send,
    ipcMain: ipc.ipcMain,
    sessions,
    providers,
    env: options.env ?? {},
    log: noop,
  })
  registerSessionRoutes({ ipcMain: ipc.ipcMain, sessions })
  return { ipc, out, sessions, host, sessionId: randomUUID() }
}

function noop(): void {}

function textOf(events: readonly ChatEvent[]): string {
  return events
    .filter((e): e is Extract<ChatEvent, { type: 'text-delta' }> => e.type === 'text-delta')
    .map((e) => e.delta)
    .join('')
}

function said(row: MessageRow): string {
  return row.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

/** The whole environment the provider resolution sees in a test: a key and the fake endpoint. */
function withKey(baseURL: string): Record<string, string> {
  return { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: baseURL }
}

describe('chat routes', () => {
  let fake: FakeAnthropic

  afterEach(async () => {
    await fake?.close()
  })

  it('streams text deltas, finishes with end-turn and records the turn', async () => {
    fake = await startFakeAnthropic({ chunks: ['Hello', ', ', 'Tenon'], delayMs: 5 })
    const { ipc, out, sessions, sessionId } = harness({ env: withKey(fake.baseURL) })

    const accepted = await ipc.call('chat.send', { sessionId, text: 'hi' })
    expect(accepted).toEqual({ ok: true, data: { accepted: true } })
    const done = await out.waitFor('done')
    expect(done).toEqual({ type: 'done', sessionId, stopReason: 'end-turn' })
    expect(textOf(out.events)).toBe('Hello, Tenon')
    expect(fake.requests[0]?.headers['x-api-key']).toBe('test-key')
    expect(fake.aborted).toBe(false)

    // The transcript is the tape now, not a Map in this process.
    const messages = await sessions.listMessages({ sessionId, limit: 10 })
    expect(messages.map((m) => [m.role, m.status, said(m)])).toEqual([
      ['user', 'complete', 'hi'],
      ['assistant', 'complete', 'Hello, Tenon'],
    ])
    // And it is readable through the IPC the renderer restores from.
    const restored = await ipc.call('session.latest', { limit: 10 })
    expect(restored).toMatchObject({ ok: true, data: { sessionId } })
    const page = await ipc.call('session.messages', { sessionId, limit: 10 })
    expect(page).toMatchObject({ ok: true, data: [{ role: 'user' }, { role: 'assistant' }] })
    // No unbounded read can even be expressed on this boundary (invariant 16).
    expect(await ipc.call('session.messages', { sessionId, limit: 5000 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-request' },
    })
  })

  it('chat.stop aborts the in-flight request all the way to the socket', async () => {
    fake = await startFakeAnthropic({
      chunks: Array.from({ length: 500 }, (_, i) => `w${i} `),
      delayMs: 40,
    })
    const { ipc, out, sessions, sessionId } = harness({ env: withKey(fake.baseURL) })

    await ipc.call('chat.send', { sessionId, text: 'hi' })
    await out.waitFor('text-delta')
    const stopped = await ipc.call('chat.stop', { sessionId })
    expect(stopped).toEqual({ ok: true, data: { stopped: true } })
    const done = await out.waitFor('done')
    expect(done).toEqual({ type: 'done', sessionId, stopReason: 'aborted' })
    await expect.poll(() => fake.aborted, { timeout: 3000 }).toBe(true)
    expect(fake.chunksSent).toBeLessThan(500)
    expect(await ipc.call('chat.stop', { sessionId })).toEqual({
      ok: true,
      data: { stopped: false },
    })

    // The partial reply is kept, and it is kept as a stopped one.
    const messages = await sessions.listMessages({ sessionId, limit: 10 })
    const assistant = messages.at(-1)
    expect(assistant?.status).toBe('aborted')
    expect(said(assistant as MessageRow)).toBe(textOf(out.events))
  })

  it('a stop that lands before the stream exists still cancels the run', async () => {
    fake = await startFakeAnthropic({ chunks: ['never'], delayMs: 5 })
    // A keychain that answers slowly: the window in which the UI already shows Stop.
    const host = createMemoryHost({
      network: { fetch: (input, init) => globalThis.fetch(input, init) },
    })
    const keychain = Promise.withResolvers<string | null>()
    host.secrets.get = () => keychain.promise
    const { ipc, out, sessions, sessionId } = harness({ host, env: withKey(fake.baseURL) })

    const sending = ipc.call('chat.send', { sessionId, text: 'hi' })
    expect(await ipc.call('chat.stop', { sessionId })).toEqual({
      ok: true,
      data: { stopped: true },
    })
    keychain.resolve(null)
    await sending
    expect(await out.waitFor('done')).toMatchObject({ stopReason: 'aborted' })
    expect(fake.requests).toHaveLength(0)
    // Nothing was written: the turn never started.
    expect(await sessions.listMessages({ sessionId, limit: 10 })).toEqual([])
    // The session is free again.
    expect(await ipc.call('chat.stop', { sessionId })).toEqual({
      ok: true,
      data: { stopped: false },
    })
  })

  it('keeps the partial reply of a stopped turn in the transcript the model sees', async () => {
    fake = await startFakeAnthropic({
      chunks: Array.from({ length: 500 }, (_, i) => `w${i} `),
      delayMs: 30,
    })
    const { ipc, out, sessionId } = harness({ env: withKey(fake.baseURL) })

    await ipc.call('chat.send', { sessionId, text: 'first' })
    await out.waitFor('text-delta')
    await ipc.call('chat.stop', { sessionId })
    await out.waitFor('done')
    out.events.length = 0

    await ipc.call('chat.send', { sessionId, text: 'keep going' })
    await out.waitFor('text-delta')
    await ipc.call('chat.stop', { sessionId })
    await out.waitFor('done')
    const second = fake.requests[1]?.body as { messages: Array<{ role: string; content: unknown }> }
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(second.messages[1]?.content)).toContain('w0')
  })

  it('treats the same text after a failure as a retry and keeps a failed turn as context', async () => {
    fake = await startFakeAnthropic({
      chunks: ['ok'],
      delayMs: 5,
      // 400 is not retried by the SDK, so the failure reaches the caller.
      failWith: { status: 400, type: 'invalid_request_error', message: 'boom' },
      failTimes: 1,
    })
    const { ipc, out, sessions, sessionId } = harness({ env: withKey(fake.baseURL) })

    await ipc.call('chat.send', { sessionId, text: 'question' })
    expect(await out.waitFor('error')).toMatchObject({ code: 'provider' })
    // The user's turn stayed; no assistant message was invented for a turn that failed.
    const afterFailure = await sessions.listMessages({ sessionId, limit: 10 })
    expect(afterFailure.map((m) => m.role)).toEqual(['user'])
    out.events.length = 0

    await ipc.call('chat.send', { sessionId, text: 'question' })
    await out.waitFor('done')
    const retry = fake.requests.at(-1)?.body as { messages: Array<{ role: string }> }
    expect(retry.messages.map((m) => m.role)).toEqual(['user'])
    // One user message, not two: the retry reused it.
    const afterRetry = await sessions.listMessages({ sessionId, limit: 10 })
    expect(afterRetry.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(afterRetry[0]?.messageId).toBe(afterFailure[0]?.messageId)
  }, 20_000)

  it('releases the session before the terminal event goes out', async () => {
    fake = await startFakeAnthropic({ chunks: ['done'], delayMs: 5 })
    const { ipc, out, sessionId } = harness({ env: withKey(fake.baseURL) })

    // Asked from INSIDE the send of the terminal event: whoever reacts to `done` by sending again
    // must not be told a reply is still streaming.
    let duringTerminal: Promise<unknown> | null = null
    out.onTerminal(() => {
      duringTerminal ??= ipc.call('chat.stop', { sessionId })
    })
    await ipc.call('chat.send', { sessionId, text: 'hi' })
    await out.waitFor('done')
    expect(await duringTerminal).toEqual({ ok: true, data: { stopped: false } })
  })

  it('refuses a second reply while one is streaming', async () => {
    fake = await startFakeAnthropic({
      chunks: Array.from({ length: 200 }, () => 'x '),
      delayMs: 20,
    })
    const { ipc, out, sessionId } = harness({ env: withKey(fake.baseURL) })

    await ipc.call('chat.send', { sessionId, text: 'hi' })
    await out.waitFor('text-delta')
    expect(await ipc.call('chat.send', { sessionId, text: 'again' })).toMatchObject({
      ok: false,
      error: { code: 'handler-failed' },
    })
    await ipc.call('chat.stop', { sessionId })
    await out.waitFor('done')
    expect(fake.requests).toHaveLength(1)
  })

  it('reports a missing credential as auth before making any request', async () => {
    fake = await startFakeAnthropic({ chunks: ['never'] })
    const { ipc, out, sessions, sessionId } = harness({
      env: { ANTHROPIC_BASE_URL: fake.baseURL },
    })

    await ipc.call('chat.send', { sessionId, text: 'hi' })
    expect(await out.waitFor('error')).toMatchObject({ code: 'auth' })
    expect(fake.requests).toHaveLength(0)
    // A configuration problem writes nothing: there is no turn to show.
    expect(await sessions.listMessages({ sessionId, limit: 10 })).toEqual([])
  })

  it('maps provider failures to error codes, never to sentences', async () => {
    fake = await startFakeAnthropic({
      chunks: [],
      failWith: { status: 401, type: 'authentication_error', message: 'invalid x-api-key' },
    })
    const { ipc, out, sessionId } = harness({ env: withKey(fake.baseURL) })

    await ipc.call('chat.send', { sessionId, text: 'hi' })
    const error = await out.waitFor('error')
    expect(error).toMatchObject({ type: 'error', sessionId, code: 'auth' })
  })

  it('ends the run when the window that asked for it is gone', async () => {
    fake = await startFakeAnthropic({
      chunks: Array.from({ length: 500 }, (_, i) => `w${i} `),
      delayMs: 30,
    })
    const { ipc, out, sessions, sessionId } = harness({ env: withKey(fake.baseURL) })
    const win = fakeWindow()

    await ipc.call('chat.send', { sessionId, text: 'hi' }, win.event)
    await out.waitFor('text-delta')
    // The window closes (or the View menu reloads it): nobody is listening any more.
    win.close()
    expect(await out.waitFor('done')).toMatchObject({ stopReason: 'aborted' })
    // The session is free again, so the window that comes back can send; and what did arrive is
    // recorded as what it is.
    expect(await ipc.call('chat.stop', { sessionId })).toEqual({
      ok: true,
      data: { stopped: false },
    })
    const assistant = (await sessions.listMessages({ sessionId, limit: 10 })).at(-1)
    expect(assistant?.status).toBe('aborted')
    // And nothing is left listening on a webContents that outlives the run.
    expect(win.listenerCount()).toBe(0)
  })

  it('ends the run on a reload of the window that asked for it', async () => {
    fake = await startFakeAnthropic({
      chunks: Array.from({ length: 500 }, (_, i) => `w${i} `),
      delayMs: 30,
    })
    const { ipc, out, sessionId } = harness({ env: withKey(fake.baseURL) })
    const win = fakeWindow()

    await ipc.call('chat.send', { sessionId, text: 'hi' }, win.event)
    await out.waitFor('text-delta')
    win.reload()
    expect(await out.waitFor('done')).toMatchObject({ stopReason: 'aborted' })
    await expect.poll(() => fake.aborted, { timeout: 3000 }).toBe(true)
  })

  it('answers every chat route when the session store could not be opened', async () => {
    fake = await startFakeAnthropic({ chunks: ['never'] })
    const host = createMemoryHost()
    const providers = createProviderRegistry()
    registerBuiltinProviders(providers)
    const ipc = fakeIpc()
    const out = collector()
    registerChatRoutes({
      host,
      send: out.send,
      ipcMain: ipc.ipcMain,
      sessions: null,
      providers,
      env: withKey(fake.baseURL),
      log: noop,
    })

    const sessionId = randomUUID()
    expect(await ipc.call('chat.send', { sessionId, text: 'hi' })).toEqual({
      ok: true,
      data: { accepted: true },
    })
    expect(await out.waitFor('error')).toMatchObject({ code: 'unknown' })
    expect(fake.requests).toHaveLength(0)
    // Terminal means terminal: the session is free, so the composer comes back.
    expect(await ipc.call('chat.stop', { sessionId })).toEqual({
      ok: true,
      data: { stopped: false },
    })
  })
})
