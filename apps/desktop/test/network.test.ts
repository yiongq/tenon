/**
 * The desktop egress sets no time limit of its own (spec 02, 01 修补 4 and 01 修补 9 (w); owner
 * 2026-09-27). undici's defaults are 300 s for the response headers and 300 s between two body
 * chunks. Left on, they would cut underneath the kernel: the resend with `firstByteTimeout: false`,
 * the SDK's ten-minute default on every non-official endpoint and the idle watchdog's threshold.
 * With both off, a slow first byte or a quiet body ends only on the kernel's own limits.
 *
 * Fake timers are installed ONCE, before undici sends anything. undici runs every timer above 1 s
 * off one shared ticking timer (undici/lib/util/timers.js) that it makes on first use and only
 * refreshes afterwards; a clock installed per test would leave that ticker on a dead clock. The
 * control case proves this clock drives the npm undici's timers, so the green cases mean something.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { anthropicDefinition } from '@tenon-app/kernel'
import type { ModelInfo, StreamEvent } from '@tenon-app/kernel'
import { Agent, fetch as undiciFetch } from 'undici'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SystemClock } from '../src/main/host/clock.js'
import { createDesktopNetwork } from '../src/main/host/network.js'

/** Past undici's 300 s defaults, and past the SDK's own ten-minute default too. */
const LONG_WAIT_MS = 601_000

beforeAll(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
})
afterAll(() => {
  vi.useRealTimers()
})

interface Held {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly body: string
}

interface Served {
  readonly url: string
  /** Every request the server has read to the end, in arrival order. */
  readonly seen: Held[]
  /** Resolves with the next request once its body has been read. */
  next(): Promise<Held>
}

const servers: ReturnType<typeof createServer>[] = []

/** A local server that parks every request; the test answers it through `next()`. */
async function serve(): Promise<Served> {
  const seen: Held[] = []
  const waiting: ((held: Held) => void)[] = []
  const queued: Held[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      const held = { req, res, body }
      seen.push(held)
      const waiter = waiting.shift()
      if (waiter === undefined) queued.push(held)
      else waiter(held)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    next: () => {
      const held = queued.shift()
      if (held !== undefined) return Promise.resolve(held)
      return new Promise((resolve) => {
        waiting.push(resolve)
      })
    },
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    // oxlint-disable-next-line no-await-in-loop -- a handful of servers, closed one by one
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
})

/** Lets the sockets move: real I/O callbacks run on the real event loop, not on the fake clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn of the event loop each
    await new Promise((resolve) => {
      setImmediate(resolve)
    })
  }
}

/** "ok:<body>", or "err:" and the error's cause (undici's own error sits there), for one assertion. */
function outcome(result: PromiseSettledResult<string>): string {
  if (result.status === 'fulfilled') return `ok:${result.value}`
  const error = result.reason as Error & { cause?: Error }
  return `err:${String(error.cause ?? error)}`
}

describe('the clock reaches undici (control)', () => {
  it("cuts a 301 s wait for headers with undici's own defaults", async () => {
    const server = await serve()
    const pending = undiciFetch(`${server.url}/control`, { dispatcher: new Agent() }).then(
      (response) => response.text(),
    )
    const settled = Promise.allSettled([pending])
    const held = await server.next()
    await settle()
    await vi.advanceTimersByTimeAsync(301_000)
    held.res.end('late')
    const [result] = await settled
    expect(outcome(result as PromiseSettledResult<string>)).toMatch(/HeadersTimeoutError/)
  })
})

describe('createDesktopNetwork sets no time limit of its own (01 修补 4; owner 2026-09-27)', () => {
  it('waits past 300 s for the response headers', async () => {
    const server = await serve()
    const pending = createDesktopNetwork()
      .fetch(`${server.url}/slow-headers`)
      .then((response) => response.text())
    const settled = Promise.allSettled([pending])
    const held = await server.next()
    await settle()
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
    held.res.writeHead(200, { 'content-type': 'text/plain' })
    held.res.end('late')
    const [result] = await settled
    expect(outcome(result as PromiseSettledResult<string>)).toBe('ok:late')
  })

  it('lets a body stay quiet past 300 s when no watchdog is armed', async () => {
    const server = await serve()
    const response = createDesktopNetwork().fetch(`${server.url}/quiet-body`)
    const held = await server.next()
    held.res.writeHead(200, { 'content-type': 'text/plain' })
    held.res.write('first ')
    const reader = (await response).body?.getReader()
    const decoder = new TextDecoder()
    const first = await reader?.read()
    expect(decoder.decode(first?.value)).toBe('first ')
    const rest = (async () => {
      let text = ''
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- a body is read chunk by chunk
        const step = await reader?.read()
        if (step === undefined || step.done) return text
        text += decoder.decode(step.value)
      }
    })()
    const settled = Promise.allSettled([rest])
    await settle()
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
    held.res.end('last')
    const [result] = await settled
    expect(outcome(result as PromiseSettledResult<string>)).toBe('ok:last')
  })

  it('hands a Request made by the platform fetch over whole', async () => {
    const server = await serve()
    const request = new Request(`${server.url}/as-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-probe': 'request' },
      body: '{"a":1}',
    })
    const pending = createDesktopNetwork().fetch(request)
    // A fetch that fails before sending (a foreign Request read as a url string) fails here.
    const held = await Promise.race([
      server.next(),
      pending.then(() => Promise.reject(new Error('answered without reaching the server'))),
    ])
    held.res.end('ok')
    expect(await (await pending).text()).toBe('ok')
    expect(held.req.method).toBe('POST')
    expect(held.req.url).toBe('/as-request')
    expect(held.req.headers['x-probe']).toBe('request')
    expect(held.body).toBe('{"a":1}')
  })

  it('follows a redirect and keeps the headers and body, as the platform fetch does', async () => {
    const server = await serve()
    const pending = createDesktopNetwork().fetch(`${server.url}/moved`, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', 'x-probe': 'init' }),
      body: '{"b":2}',
    })
    const moved = await server.next()
    moved.res.writeHead(307, { location: '/final' })
    moved.res.end()
    const final = await server.next()
    final.res.end('there')
    const response = await pending
    expect(await response.text()).toBe('there')
    expect(response.redirected).toBe(true)
    expect(final.req.method).toBe('POST')
    expect(final.req.headers['x-probe']).toBe('init')
    expect(final.body).toBe('{"b":2}')
  })
})

describe("the kernel's own limits still end a request on the desktop egress", () => {
  const MODEL = anthropicDefinition.builtinModels[0] as ModelInfo

  function streamFrom(baseURL: string): { events: StreamEvent[]; done: Promise<void> } {
    const provider = anthropicDefinition.create({
      network: createDesktopNetwork(),
      clock: new SystemClock(),
      config: { baseURL },
      secrets: { apiKey: 'test-key-not-a-real-credential' },
    })
    const events: StreamEvent[] = []
    const encoded = provider.encode({
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })
    const done = (async () => {
      for await (const event of provider.stream(encoded, {
        identity: {
          runId: '00000000-0000-4000-8000-000000000021',
          requestSeq: 1,
          physicalAttempt: 1,
        },
      })) {
        events.push(event)
      }
    })()
    return { events, done }
  }

  it("ends a slow first byte on the SDK's ten-minute default, not at 300 s", async () => {
    // A non-official endpoint: the kernel passes no timeout, so the SDK's 600 s default stands.
    const server = await serve()
    const { events, done } = streamFrom(server.url)
    await server.next()
    await settle()
    await vi.advanceTimersByTimeAsync(301_000)
    await settle()
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(300_000)
    await done
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'network',
      retryable: true,
      timeout: 'first-byte',
    })
  })

  it('ends a quiet body on the idle watchdog', async () => {
    const server = await serve()
    const { events, done } = streamFrom(server.url)
    const held = await server.next()
    held.res.writeHead(200, { 'content-type': 'text/event-stream' })
    held.res.write(
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_quiet',
          type: 'message',
          role: 'assistant',
          model: MODEL.id,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n\n`,
    )
    await settle()
    await vi.advanceTimersByTimeAsync(300_000)
    await done
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'network',
      retryable: true,
      timeout: 'idle',
    })
  })
})
