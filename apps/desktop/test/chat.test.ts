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
  ProviderConfigMissingError,
  ZHIPU_PROVIDER_ID,
  createMemoryHost,
  createMemoryTapeStore,
  createProviderRegistry,
  createSessionService,
  keyFor,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type {
  AbsolutePath,
  HostAdapter,
  MessageRow,
  ModelInfo,
  SessionService,
} from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestConnector,
  createTestSessionService,
  scriptedTurn,
} from '@tenon-app/kernel/testing'
import type { ScriptedProvider, TestConnector } from '@tenon-app/kernel/testing'
import { chatEventSchema, chatQueueEvent, chatSend, chatSendNow } from '@tenon-app/contracts'
import type { ChatEvent, IpcMainLike } from '@tenon-app/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createDesktopLoop, registerChatRoutes } from '../src/main/chat.js'
import { writeConfig } from '../src/main/host/profile.js'
import { createRunConnector } from '../src/main/run-assembly.js'
import { registerSessionRoutes } from '../src/main/session.js'
import { startFakeAnthropic } from './support/fake-anthropic.js'
import type { FakeAnthropic } from './support/fake-anthropic.js'
import { startFakeOpenAI } from './support/fake-openai.js'

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
    send(channel, payload) {
      // Only the chat stream: `chat.queue` goes out on the same sender.
      if (channel !== 'chat.event') return
      const event = payload as ChatEvent
      events.push(event)
      if (event.type === 'done' || event.type === 'error') terminal?.()
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
  const providers = createProviderRegistry()
  registerBuiltinProviders(providers)
  // index.ts's wiring: the connector at construction, the loop's host half through bindLoop.
  const sessions = createSessionService({
    host,
    tape,
    ids: { uuid: (): string => randomUUID() },
    inspectors: [],
    connector: createRunConnector({ host, providers, env: options.env ?? {}, log: noop }),
    protectedFiles: [],
  })
  const ipc = fakeIpc()
  const out = collector()
  const loop = createDesktopLoop({
    clock: host.clock,
    send: out.send,
    locale: () => 'en',
    log: noop,
  })
  sessions.bindLoop(loop.ports)
  registerChatRoutes({ send: out.send, ipcMain: ipc.ipcMain, sessions, loop, log: noop })
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
    expect(accepted).toEqual({ ok: true, data: { accepted: true, status: 'started' } })
    const done = await out.waitFor('done')
    await out.waitFor('user-message')
    expect(done).toEqual({
      type: 'done',
      sessionId,
      stopReason: 'end-turn',
      endReason: { code: 'completed' },
      // Which Run ended, for the failure card's copied diagnostics (plan step 20).
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u),
      // Its reply follows the message that opened it: a resend would be a second copy (run-ended.retryOf).
      retryOf: null,
    })
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
    await out.waitFor('user-message')
    expect(done).toEqual({
      type: 'done',
      sessionId,
      stopReason: 'aborted',
      endReason: { code: 'user-stopped' },
      // Which Run ended, for the failure card's copied diagnostics (plan step 20).
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u),
      // The message opened it and no call went out: the kernel names it (run-ended.retryOf).
      retryOf: null, // the stopped reply is kept after the message (run-ended.retryOf)
    })
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
    // Nothing was written, and no event will name the message: the renderer settles it (plan step 20).
    expect(await sending).toEqual({ ok: true, data: { accepted: true, status: 'not-sent' } })
    expect(await out.waitFor('done')).toMatchObject({ stopReason: 'aborted', retryOf: null })
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
    // The first turn, the day's environment note (spec 02 §提示层「环境说明」), the partial reply.
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user'])
    expect(JSON.stringify(second.messages[2]?.content)).toContain('w0')
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
    const failed = await out.waitFor('error')
    expect(failed).toMatchObject({ code: 'provider' })
    // The user's turn stayed; no assistant message was invented for a turn that failed.
    const afterFailure = await sessions.listMessages({ sessionId, limit: 10 })
    expect(afterFailure.map((m) => m.role)).toEqual(['user'])
    // 「重试」 is offered for it, and resends that very message (§失败卡与结束原因).
    expect(failed).toMatchObject({ retryOf: afterFailure[0]?.messageId })
    out.events.length = 0

    await ipc.call('chat.send', { sessionId, text: 'question' })
    await out.waitFor('done')
    const retry = fake.requests.at(-1)?.body as { messages: Array<{ role: string }> }
    // The question and the environment note the failed Run wrote; unchanged, it is not written again.
    expect(retry.messages.map((m) => m.role)).toEqual(['user', 'user'])
    // One user message, not two: the retry reused it.
    const afterRetry = await sessions.listMessages({ sessionId, limit: 10 })
    expect(afterRetry.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(afterRetry[0]?.messageId).toBe(afterFailure[0]?.messageId)
  }, 20_000)

  it('shows an exhausted spend limit as the unknown error code (spec 02, 01 修补 5)', async () => {
    fake = await startFakeAnthropic({
      chunks: ['ok'],
      delayMs: 5,
      failWith: {
        status: 400,
        type: 'invalid_request_error',
        message: 'You have reached your specified API usage limits.',
      },
    })
    const { ipc, out, sessionId } = harness({ env: withKey(fake.baseURL) })
    await ipc.call('chat.send', { sessionId, text: 'question' })
    // quota-exhausted maps to 01's fallback; the finer reason travels as the Run's endReason.
    expect(await out.waitFor('error')).toMatchObject({ code: 'unknown' })
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

  it('queues a message sent while a reply streams, and sends it once that reply is done', async () => {
    fake = await startFakeAnthropic({ chunks: ['one ', 'two ', 'three'], delayMs: 20 })
    const { ipc, out, sessions, sessionId } = harness({ env: withKey(fake.baseURL) })

    await ipc.call('chat.send', { sessionId, text: 'hi' })
    await out.waitFor('text-delta')
    // Not refused any more (01 修补 9 (a)): the kernel queues it.
    expect(await ipc.call('chat.send', { sessionId, text: 'again' })).toEqual({
      ok: true,
      data: { accepted: true, status: 'queued' },
    })
    await expect
      .poll(() => out.events.filter((event) => event.type === 'done').length, { timeout: 5000 })
      .toBe(2)
    expect(fake.requests).toHaveLength(2)
    // It became its own user turn once sent, with its queued id.
    const users = out.events.filter((event) => event.type === 'user-message')
    expect(
      users.map((event) => (event.type === 'user-message' ? event.queuedId !== null : null)),
    ).toEqual([false, true])
    const messages = await sessions.listMessages({ sessionId, limit: 10 })
    expect(messages.map((m) => [m.role, said(m)])).toEqual([
      ['user', 'hi'],
      ['assistant', 'one two three'],
      ['user', 'again'],
      ['assistant', 'one two three'],
    ])
  })

  it('reports a missing credential as auth before making any request', async () => {
    fake = await startFakeAnthropic({ chunks: ['never'] })
    const { ipc, out, sessions, sessionId } = harness({
      env: { ANTHROPIC_BASE_URL: fake.baseURL },
    })

    expect(await ipc.call('chat.send', { sessionId, text: 'hi' })).toEqual({
      ok: true,
      data: { accepted: true, status: 'not-sent' },
    })
    expect(await out.waitFor('error')).toMatchObject({ code: 'auth', runId: null, retryOf: null })
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

  it('sends to the provider config.json selected, not to the default one', async () => {
    // The point of step 14: which provider a send uses is a SETTING, and the whole path — the
    // other wire, another vendor's credential header, the model that definition declares — comes
    // from `config.json` plus the keychain, with no code here naming any of it.
    fake = await startFakeAnthropic({ chunks: ['never'] })
    const openai = await startFakeOpenAI({ chunks: ['你好', '，Tenon'], delayMs: 5 })
    try {
      const host = createMemoryHost({
        network: { fetch: (input, init) => globalThis.fetch(input, init) },
      })
      await host.fs.mkdirp(host.identity.profileDir as AbsolutePath)
      await writeConfig(host.fs, host.identity, {
        provider: { id: ZHIPU_PROVIDER_ID, modelId: 'glm-4.6' },
        providerConfig: { [ZHIPU_PROVIDER_ID]: { baseURL: openai.baseURL } },
      })
      await host.secrets.set(
        keyFor(host.identity, 'provider', ZHIPU_PROVIDER_ID, 'apiKey'),
        'zhipu-key',
      )
      const { ipc, out, sessions, sessionId } = harness({ host, env: withKey(fake.baseURL) })

      await ipc.call('chat.send', { sessionId, text: 'hi' })
      expect(await out.waitFor('done')).toMatchObject({ stopReason: 'end-turn' })
      expect(textOf(out.events)).toBe('你好，Tenon')
      expect(fake.requests).toHaveLength(0)
      expect(openai.requests).toHaveLength(1)
      expect(openai.requests[0]?.path).toBe('/v1/chat/completions')
      expect(openai.requests[0]?.headers['authorization']).toBe('Bearer zhipu-key')
      expect(openai.requests[0]?.body).toMatchObject({ model: 'glm-4.6', stream: true })
      const assistant = (await sessions.listMessages({ sessionId, limit: 10 })).at(-1)
      expect(said(assistant as MessageRow)).toBe('你好，Tenon')
    } finally {
      await openai.close()
    }
  })

  it('continues a truncated reply through chat.continue, with a note only the model sees', async () => {
    fake = await startFakeAnthropic({ chunks: ['half'], delayMs: 1, stopReasons: ['max_tokens'] })
    const { ipc, out, sessions, sessionId } = harness({ env: withKey(fake.baseURL) })
    const doneEvents = (): ChatEvent[] => out.events.filter((event) => event.type === 'done')

    await ipc.call('chat.send', { sessionId, text: 'write it all' })
    await expect.poll(() => doneEvents().length).toBe(1)
    expect(doneEvents()[0]).toMatchObject({
      stopReason: 'error',
      endReason: { code: 'output-truncated' },
    })

    expect(await ipc.call('chat.continue', { sessionId })).toEqual({
      ok: true,
      data: { status: 'started' },
    })
    await expect.poll(() => doneEvents().length).toBe(2)
    expect(doneEvents()[1]).toMatchObject({ endReason: { code: 'completed' } })
    // The second request ends with the continuation note: a user turn for the model…
    const body = fake.requests[1]?.body as { messages: Array<{ role: string }> }
    expect(body.messages.map((message) => message.role)).toEqual([
      'user',
      'user',
      'assistant',
      'user',
    ])
    expect(JSON.stringify(body.messages.at(-1))).toContain('cut off at the output limit')
    // …that the transcript never shows.
    const rows = await sessions.listMessages({ sessionId, limit: 10 })
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'assistant'])
    // A completed Run leaves nothing to continue.
    expect(await ipc.call('chat.continue', { sessionId })).toEqual({
      ok: true,
      data: { status: 'not-available' },
    })
  })

  it('answers every chat route when the session store could not be opened', async () => {
    fake = await startFakeAnthropic({ chunks: ['never'] })
    const ipc = fakeIpc()
    const out = collector()
    registerChatRoutes({
      send: out.send,
      ipcMain: ipc.ipcMain,
      sessions: null,
      loop: null,
      log: noop,
    })

    const sessionId = randomUUID()
    // Nothing is written anywhere: the renderer settles what it showed (plan step 20).
    expect(await ipc.call('chat.send', { sessionId, text: 'hi' })).toEqual({
      ok: true,
      data: { accepted: true, status: 'not-sent' },
    })
    expect(await ipc.call('chat.sendNow', { sessionId, text: 'now', runId: null })).toEqual({
      ok: true,
      data: { accepted: true, status: 'not-sent' },
    })
    expect(await out.waitFor('error')).toMatchObject({ code: 'unknown' })
    expect(fake.requests).toHaveLength(0)
    // Terminal means terminal: the session is free, so the composer comes back.
    expect(await ipc.call('chat.stop', { sessionId })).toEqual({
      ok: true,
      data: { stopped: false },
    })
    expect(await ipc.call('chat.continue', { sessionId })).toMatchObject({ ok: false })
  })
})

const SCRIPTED_MODEL: ModelInfo = {
  id: 'claude-status-1',
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

/**
 * The same routes over the real kernel with the scripted connector behind it: where a case holds a
 * prebuild open, asks for a public host's confirmation, or takes the key away.
 */
function scriptedHarness(): {
  readonly ipc: ReturnType<typeof fakeIpc>
  readonly out: ReturnType<typeof collector>
  readonly connector: TestConnector
  readonly provider: ScriptedProvider
  /** Every `chat.queue` push, parsed. */
  readonly queue: Array<ReturnType<typeof chatQueueEvent.payload.parse>>
  readonly sessionId: string
} {
  const host = createMemoryHost()
  const provider = createScriptedProvider({ models: [SCRIPTED_MODEL] })
  const connector = createTestConnector({ provider, model: SCRIPTED_MODEL })
  const sessions = createTestSessionService(
    {
      host,
      tape: createMemoryTapeStore({ identity: host.identity }),
      ids: createCounterIds(),
      inspectors: [],
      connector,
      protectedFiles: [],
    },
    { tools: {} },
  )
  const out = collector()
  const queue: Array<ReturnType<typeof chatQueueEvent.payload.parse>> = []
  const send = (channel: string, payload: unknown): void => {
    if (channel === chatQueueEvent.channel) queue.push(chatQueueEvent.payload.parse(payload))
    if (channel === 'chat.event') chatEventSchema.parse(payload)
    out.send(channel, payload)
  }
  const loop = createDesktopLoop({ clock: host.clock, send, locale: () => 'en', log: noop })
  sessions.bindLoop(loop.ports)
  const ipc = fakeIpc()
  registerChatRoutes({ send, ipcMain: ipc.ipcMain, sessions, loop, log: noop })
  return { ipc, out, connector, provider, queue, sessionId: randomUUID() }
}

/** A route's answer, checked against the route's own response schema. */
async function answered(
  route: typeof chatSend | typeof chatSendNow,
  sent: Promise<unknown>,
): Promise<unknown> {
  const answer = (await sent) as { ok: boolean; data?: unknown }
  expect(answer.ok).toBe(true)
  return route.response.parse(answer.data)
}

describe('what chat.send and chat.sendNow answer: the kernel’s status (plan step 20)', () => {
  it('started, and queued for one judged while the first holds the root', async () => {
    // §chat.event: `started`, `queued` and `held` are followed by events that show the message.
    const h = scriptedHarness()
    h.provider.script(scriptedTurn({ deltas: ['one'] }))
    h.provider.script(scriptedTurn({ deltas: ['two'] }))
    const held = h.connector.holdAssemble()
    const first = h.ipc.call('chat.send', { sessionId: h.sessionId, text: 'first' })
    await held.reached
    const second = h.ipc.call('chat.send', { sessionId: h.sessionId, text: 'second' })
    held.release()
    expect(await answered(chatSend, first)).toEqual({ accepted: true, status: 'started' })
    expect(await answered(chatSend, second)).toEqual({ accepted: true, status: 'queued' })
    // The queued one was shown by the queue push, then went out on its own.
    expect(h.queue.some((push) => push.items.some((item) => item.text === 'second'))).toBe(true)
    await expect.poll(() => h.out.events.filter((event) => event.type === 'done').length).toBe(2)
  })

  it('send-now answers the same way: started when idle, queued behind a Run it did not name', async () => {
    const h = scriptedHarness()
    h.provider.script(scriptedTurn({ deltas: ['one'] }))
    h.provider.script(scriptedTurn({ deltas: ['two'] }))
    const held = h.connector.holdAssemble()
    const first = h.ipc.call('chat.sendNow', { sessionId: h.sessionId, text: 'first', runId: null })
    await held.reached
    const second = h.ipc.call('chat.sendNow', {
      sessionId: h.sessionId,
      text: 'second',
      runId: null,
    })
    held.release()
    expect(await answered(chatSendNow, first)).toEqual({ accepted: true, status: 'started' })
    expect(await answered(chatSendNow, second)).toEqual({ accepted: true, status: 'queued' })
  })

  it('held: a public host it would switch to indirectly waits for the menu, and the queue says so', async () => {
    const h = scriptedHarness()
    h.connector.needsConfirm('api.example.com')
    const sent = h.ipc.call('chat.send', { sessionId: h.sessionId, text: 'to the cloud' })
    expect(await answered(chatSend, sent)).toEqual({ accepted: true, status: 'held' })
    expect(h.queue.at(-1)).toEqual({
      sessionId: h.sessionId,
      items: [{ queuedId: expect.any(String), text: 'to the cloud' }],
      held: { host: 'api.example.com' },
    })
    expect(h.provider.starts).toBe(0)
  })

  it('not-sent from the kernel: a missing key, and a stop in the prebuild — nothing was written', async () => {
    const noKey = scriptedHarness()
    noKey.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'))
    expect(
      await answered(
        chatSend,
        noKey.ipc.call('chat.send', { sessionId: noKey.sessionId, text: 'hi' }),
      ),
    ).toEqual({ accepted: true, status: 'not-sent' })
    expect(await noKey.out.waitFor('error')).toMatchObject({ runId: null, retryOf: null })

    const stopped = scriptedHarness()
    const held = stopped.connector.holdAssemble()
    const sending = stopped.ipc.call('chat.send', { sessionId: stopped.sessionId, text: 'hi' })
    await held.reached
    expect(await stopped.ipc.call('chat.stop', { sessionId: stopped.sessionId })).toEqual({
      ok: true,
      data: { stopped: true },
    })
    held.release()
    expect(await answered(chatSend, sending)).toEqual({ accepted: true, status: 'not-sent' })
    for (const h of [noKey, stopped]) {
      expect(h.out.events.filter((event) => event.type === 'user-message')).toEqual([])
    }
  })

  it('not-sent from main itself: a session id that is not one, with the error it sent', async () => {
    const h = scriptedHarness()
    expect(
      await answered(chatSend, h.ipc.call('chat.send', { sessionId: 'not-a-uuid', text: 'hi' })),
    ).toEqual({ accepted: true, status: 'not-sent' })
    expect(await h.out.waitFor('error')).toMatchObject({ sessionId: 'not-a-uuid', code: 'unknown' })
  })
})
