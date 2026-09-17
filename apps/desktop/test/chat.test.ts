import { createMemoryHost } from '@tenon-app/kernel'
import type { ChatEvent, IpcMainLike } from '@tenon-app/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerChatRoutes } from '../src/main/chat.js'
import { startFakeAnthropic } from './support/fake-anthropic.js'
import type { FakeAnthropic } from './support/fake-anthropic.js'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function fakeIpc(): {
  ipcMain: IpcMainLike
  call(channel: string, payload: unknown): Promise<unknown>
} {
  const handlers = new Map<string, Handler>()
  return {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
    },
    async call(channel, payload) {
      const h = handlers.get(channel)
      if (!h) throw new Error(`no handler for ${channel}`)
      return h({}, payload)
    },
  }
}

function collector(): {
  events: ChatEvent[]
  send: (channel: string, payload: unknown) => void
  waitFor(type: ChatEvent['type']): Promise<ChatEvent>
} {
  const events: ChatEvent[] = []
  const waiters: Array<{ type: ChatEvent['type']; resolve: (e: ChatEvent) => void }> = []
  return {
    events,
    send(_channel, payload) {
      const event = payload as ChatEvent
      events.push(event)
      const matched = waiters.filter((w) => w.type === event.type)
      for (const w of matched) waiters.splice(waiters.indexOf(w), 1)
      for (const w of matched) w.resolve(event)
    },
    waitFor(type) {
      const existing = events.find((e) => e.type === type)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve) => waiters.push({ type, resolve }))
    },
  }
}

/** Acceptance 4 mechanics against an Anthropic-compatible endpoint: streaming and abort. */
describe('chat routes', () => {
  let fake: FakeAnthropic
  const savedEnv = { ...process.env }

  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
  })
  afterEach(async () => {
    await fake?.close()
    process.env = { ...savedEnv }
  })

  it('streams text deltas and finishes with end-turn', async () => {
    fake = await startFakeAnthropic({ chunks: ['Hello', ', ', 'Tenon'], delayMs: 5 })
    process.env['ANTHROPIC_BASE_URL'] = fake.baseURL
    const ipc = fakeIpc()
    const out = collector()
    registerChatRoutes({ host: createMemoryHost(), send: out.send, ipcMain: ipc.ipcMain })

    const accepted = await ipc.call('chat.send', { sessionId: 's1', text: 'hi' })
    expect(accepted).toEqual({ ok: true, data: { accepted: true } })
    const done = await out.waitFor('done')
    expect(done).toEqual({ type: 'done', sessionId: 's1', stopReason: 'end-turn' })
    const text = out.events
      .filter((e): e is Extract<ChatEvent, { type: 'text-delta' }> => e.type === 'text-delta')
      .map((e) => e.delta)
      .join('')
    expect(text).toBe('Hello, Tenon')
    expect(fake.requests[0]?.headers['x-api-key']).toBe('test-key')
    expect(fake.aborted).toBe(false)
  })

  it('chat.stop aborts the in-flight request all the way to the socket', async () => {
    fake = await startFakeAnthropic({
      chunks: Array.from({ length: 50 }, (_, i) => `w${i} `),
      delayMs: 40,
    })
    process.env['ANTHROPIC_BASE_URL'] = fake.baseURL
    const ipc = fakeIpc()
    const out = collector()
    registerChatRoutes({ host: createMemoryHost(), send: out.send, ipcMain: ipc.ipcMain })

    await ipc.call('chat.send', { sessionId: 's1', text: 'hi' })
    await out.waitFor('text-delta')
    const stopped = await ipc.call('chat.stop', { sessionId: 's1' })
    expect(stopped).toEqual({ ok: true, data: { stopped: true } })
    const done = await out.waitFor('done')
    expect(done).toEqual({ type: 'done', sessionId: 's1', stopReason: 'aborted' })
    await expect.poll(() => fake.aborted, { timeout: 3000 }).toBe(true)
    expect(fake.chunksSent).toBeLessThan(50)
    expect(await ipc.call('chat.stop', { sessionId: 's1' })).toEqual({
      ok: true,
      data: { stopped: false },
    })
  })

  it('maps provider failures to error codes, never to sentences', async () => {
    fake = await startFakeAnthropic({
      chunks: [],
      failWith: { status: 401, type: 'authentication_error', message: 'invalid x-api-key' },
    })
    process.env['ANTHROPIC_BASE_URL'] = fake.baseURL
    const ipc = fakeIpc()
    const out = collector()
    registerChatRoutes({ host: createMemoryHost(), send: out.send, ipcMain: ipc.ipcMain })

    await ipc.call('chat.send', { sessionId: 's1', text: 'hi' })
    const error = await out.waitFor('error')
    expect(error).toMatchObject({ type: 'error', sessionId: 's1', code: 'auth' })
  })
})
