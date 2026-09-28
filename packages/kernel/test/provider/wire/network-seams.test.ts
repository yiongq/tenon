/**
 * Spec 02 plan step 7 (01 修补 2, 4 and 5): the first-byte limit, the byte-level idle watchdog, the
 * request-header allowlist, top-level `cache_control`, the new error classes and the definitions'
 * finish_reason additions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  OpenAIChatProvider,
  ProviderInvalidArgumentError,
  ZHIPU_DEFAULT_BASE_URL,
  anthropicDefinition,
  createMemoryHost,
  encodeAnthropicMessages,
  encodeOpenAIChat,
  ollamaDefinition,
  zhipuDefinition,
} from '../../../src/index.js'
import type {
  HostClock,
  HostNetwork,
  ModelInfo,
  Provider,
  ProviderDefinition,
  SendContext,
  StreamEvent,
} from '../../../src/index.js'
import { fetchThroughHost } from '../../../src/provider/wire/transport.js'
import { createStreamGate, fakeNetwork } from '../../../src/testing/index.js'
import type { FakeExchange, FakeNetwork } from '../../../src/testing/index.js'
import * as anthropicFixture from '../fixtures/anthropic-sse.js'
import * as openAIFixture from '../fixtures/openai-sse.js'
import { anthropicModel, requestOf } from './fixtures.js'

const KEY = 'test-key-not-a-real-credential'
const IDENTITY = {
  runId: '00000000-0000-4000-8000-000000000007',
  requestSeq: 1,
  physicalAttempt: 1,
}
const SONNET = anthropicDefinition.builtinModels.find(
  (row) => row.id === 'claude-sonnet-5',
) as ModelInfo
const GLM = zhipuDefinition.builtinModels[0] as ModelInfo
const EMULATION_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function build(
  definition: ProviderDefinition,
  network: HostNetwork,
  clock: Pick<HostClock, 'now' | 'setTimeout'>,
  baseURL?: string,
): Provider {
  return definition.create({
    network,
    clock,
    config: baseURL === undefined ? {} : { baseURL },
    secrets: { apiKey: KEY },
  })
}

async function drain(
  provider: Provider,
  model: ModelInfo,
  ctx: Partial<SendContext> = {},
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of provider.stream(provider.encode(requestOf(model)), {
    identity: IDENTITY,
    ...ctx,
  })) {
    events.push(event)
  }
  return events
}

/** A clock that also counts the timers still armed, to prove the watchdog is torn down. */
function countingClock(): {
  clock: Pick<HostClock, 'now' | 'setTimeout'>
  advance: (ms: number) => void
  armed: () => number
} {
  const host = createMemoryHost({ now: Date.parse('2026-09-26T10:00:00.000Z') })
  let armed = 0
  return {
    clock: {
      now: () => host.clock.now(),
      setTimeout: (fn, ms) => {
        armed += 1
        let live = true
        const cancel = host.clock.setTimeout(() => {
          if (!live) return
          live = false
          armed -= 1
          fn()
        }, ms)
        return () => {
          if (!live) return
          live = false
          armed -= 1
          cancel()
        }
      },
    },
    advance: (ms) => host.advance(ms),
    armed: () => armed,
  }
}

const PING = 'event: ping\ndata: {"type": "ping"}\n\n'

describe('the byte-level idle watchdog (旧 48, 旧 103)', () => {
  async function stallAfterStart(
    definition: ProviderDefinition,
    model: ModelInfo,
    frames: readonly string[],
  ): Promise<{ limit: (ms: number) => Promise<StreamEvent[]>; signal: AbortSignal }> {
    const time = countingClock()
    const gate = createStreamGate()
    const net = fakeNetwork({ kind: 'sse', frames, gate })
    const provider = build(definition, net, time.clock)
    const controller = new AbortController()
    const events: StreamEvent[] = []
    const run = (async () => {
      for await (const event of provider.stream(provider.encode(requestOf(model)), {
        identity: IDENTITY,
        signal: controller.signal,
      })) {
        events.push(event)
      }
    })()
    await flush()
    gate.release(1)
    await flush()
    return {
      signal: controller.signal,
      limit: async (ms) => {
        time.advance(ms - 1)
        await flush()
        expect(events.some((event) => event.type === 'error')).toBe(false)
        time.advance(1)
        await run
        return events
      },
    }
  }

  it('ends a silent Anthropic body after 180 000 ms as a retryable network error, not an abort', async () => {
    const { limit, signal } = await stallAfterStart(
      anthropicDefinition,
      SONNET,
      anthropicFixture.PLAIN_TEXT_FRAMES,
    )
    const events = await limit(180_000)
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'network',
      retryable: true,
      timeout: 'idle',
    })
    expect(events.some((event) => event.type === 'stop')).toBe(false)
    expect(signal.aborted).toBe(false)
  })

  it('waits 300 000 ms on any other endpoint', async () => {
    const { limit } = await stallAfterStart(zhipuDefinition, GLM, openAIFixture.PLAIN_TEXT_FRAMES)
    expect((await limit(300_000)).at(-1)).toMatchObject({ code: 'network', timeout: 'idle' })
  })

  it('is reset by every byte, a ping included, and torn down when the body ends', async () => {
    const time = countingClock()
    const gate = createStreamGate()
    const [start, ...rest] = anthropicFixture.PLAIN_TEXT_FRAMES
    const frames = [start as string, PING, PING, PING, ...rest]
    const net = fakeNetwork({ kind: 'sse', frames, gate })
    const provider = build(anthropicDefinition, net, time.clock)
    const events: StreamEvent[] = []
    const run = (async () => {
      for await (const event of provider.stream(provider.encode(requestOf(SONNET)), {
        identity: IDENTITY,
      })) {
        events.push(event)
      }
    })()
    await flush()
    gate.release(1)
    await flush()
    for (let i = 0; i < 3; i++) {
      time.advance(100_000)
      // oxlint-disable-next-line no-await-in-loop -- one ping per step of the clock
      await flush()
      gate.release(1)
      // oxlint-disable-next-line no-await-in-loop -- as above
      await flush()
    }
    gate.release(rest.length)
    await run
    expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'end-turn' })
    expect(time.armed()).toBe(0)
  })
})

describe('the watchdog is torn down when the body is read to the end (旧 103, 01 修补 4)', () => {
  // Below the SDK: through a provider, the SDK stops reading at message_stop and cancels what is
  // left of the body, so the case above reaches the cancel path, not this one.
  it('cancels its timer once the last byte is read, and never fires afterwards', async () => {
    const time = countingClock()
    const encoder = new TextEncoder()
    const network: HostNetwork = {
      fetchUntrusted: () => Promise.reject(new Error('provider must not fetch untrusted URLs')),
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('a'))
                controller.enqueue(encoder.encode('b'))
                controller.close()
              },
            }),
          ),
        ),
    }
    const response = await fetchThroughHost(network, 'https://api.example.test/v1', undefined, {
      clock: time.clock,
      idleMs: 300_000,
    })
    expect(await response.text()).toBe('ab')
    expect(time.armed()).toBe(0)
    time.advance(300_000)
    await flush()
    expect(time.armed()).toBe(0)
  })
})

describe('the watchdog is torn down when the body is cancelled (旧 103, 01 修补 4)', () => {
  // 「响应体读完、被取消或出错时拆除」: read to the end is the case above; these are the other two
  // ways a body stops being read — a Stop, and a consumer that leaves early. Either would otherwise
  // leave a 180 s / 300 s host timer armed after every stopped turn.
  const wires = [
    ['anthropic-messages', anthropicDefinition, SONNET, anthropicFixture.PLAIN_TEXT_FRAMES],
    ['openai-chat', zhipuDefinition, GLM, openAIFixture.PLAIN_TEXT_FRAMES],
  ] as const

  async function opened(
    definition: ProviderDefinition,
    model: ModelInfo,
    frames: readonly string[],
  ) {
    const time = countingClock()
    const gate = createStreamGate()
    const provider = build(definition, fakeNetwork({ kind: 'sse', frames, gate }), time.clock)
    const controller = new AbortController()
    const stream = provider.stream(provider.encode(requestOf(model)), {
      identity: IDENTITY,
      signal: controller.signal,
    })
    const iterator = stream[Symbol.asyncIterator]()
    await flush()
    gate.release(1)
    const first = await iterator.next()
    expect(first.done).toBe(false)
    // Armed while the body is open: what the two cases below have to take down.
    expect(time.armed()).toBe(1)
    return { time, controller, iterator }
  }

  for (const [wire, definition, model, frames] of wires) {
    it(`${wire}: a Stop mid-stream`, async () => {
      const { time, controller, iterator } = await opened(definition, model, frames)
      controller.abort()
      const rest: StreamEvent[] = []
      // oxlint-disable-next-line no-await-in-loop -- the rest of one stream, in order
      for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) {
        rest.push(step.value)
      }
      await flush()
      expect(rest.at(-1)).toMatchObject({ type: 'stop', reason: 'aborted' })
      expect(time.armed()).toBe(0)
    })

    it(`${wire}: the consumer returning early`, async () => {
      const { time, iterator } = await opened(definition, model, frames)
      await iterator.return?.()
      await flush()
      expect(time.armed()).toBe(0)
    })
  }
})

function timeoutHeader(net: FakeNetwork): string | undefined {
  return net.requests[0]?.headers['x-stainless-timeout']
}

describe('the first-byte limit (旧 48, 旧 103)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives the SDK 180 s plus a second per started 32 KiB, on the official endpoint only', async () => {
    const official = fakeNetwork({ kind: 'sse', frames: anthropicFixture.PLAIN_TEXT_FRAMES })
    const provider = build(anthropicDefinition, official, countingClock().clock)
    const encoded = provider.encode(requestOf(SONNET))
    for await (const event of provider.stream(encoded, { identity: IDENTITY })) void event
    const bodyBytes = new TextEncoder().encode(JSON.stringify(encoded.body)).byteLength
    expect(timeoutHeader(official)).toBe(String(180 + Math.ceil(bodyBytes / 32_768)))

    // Anywhere else, and on the resend right after a first-byte timeout, the SDK's own default.
    const emulation = fakeNetwork({ kind: 'sse', frames: anthropicFixture.PLAIN_TEXT_FRAMES })
    await drain(
      build(anthropicDefinition, emulation, countingClock().clock, EMULATION_BASE_URL),
      SONNET,
    )
    expect(timeoutHeader(emulation)).toBe('600')
    const resend = fakeNetwork({ kind: 'sse', frames: anthropicFixture.PLAIN_TEXT_FRAMES })
    await drain(build(anthropicDefinition, resend, countingClock().clock), SONNET, {
      firstByteTimeout: false,
    })
    expect(timeoutHeader(resend)).toBe('600')
  })

  it('ends the stream as a retryable first-byte network error when no header arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hanging: HostNetwork = {
      fetchUntrusted: () => Promise.reject(new Error('provider must not fetch untrusted URLs')),
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new Error('aborted'))
          })
        }),
    }
    const provider = build(anthropicDefinition, hanging, countingClock().clock)
    const controller = new AbortController()
    const events: StreamEvent[] = []
    const run = (async () => {
      for await (const event of provider.stream(provider.encode(requestOf(SONNET)), {
        identity: IDENTITY,
        signal: controller.signal,
      })) {
        events.push(event)
      }
    })()
    await vi.advanceTimersByTimeAsync(200_000)
    await run
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'network',
      retryable: true,
      timeout: 'first-byte',
    })
    expect(events.some((event) => event.type === 'stop')).toBe(false)
    expect(controller.signal.aborted).toBe(false)
  })
})

describe('top-level cache_control (旧 102)', () => {
  it('is written on an Anthropic row that supports cache control, without a ttl', () => {
    expect(encodeAnthropicMessages(requestOf(SONNET), 'anthropic').body).toMatchObject({
      cache_control: { type: 'ephemeral' },
    })
  })

  it('is not written on a synthesised row or on the OpenAI-compatible wire', () => {
    const synthesised = anthropicModel({ supportsCacheControl: false })
    expect(
      Object.hasOwn(
        encodeAnthropicMessages(requestOf(synthesised), 'anthropic').body as object,
        'cache_control',
      ),
    ).toBe(false)
    expect(
      Object.hasOwn(encodeOpenAIChat(requestOf(GLM), 'zhipu').body as object, 'cache_control'),
    ).toBe(false)
  })
})

/** The SDK's own `x-stainless-*` names a request carries — the group 01 open question 1 keeps. */
function stainless(headers: Readonly<Record<string, string>>): string[] {
  return Object.keys(headers)
    .filter((name) => name.startsWith('x-stainless-'))
    .toSorted()
}

describe('02 不变量 3: the request-header allowlist (旧 104)', () => {
  const ENV = ['ANTHROPIC_CUSTOM_HEADERS', 'OPENAI_CUSTOM_HEADERS'] as const

  async function headersWith(
    env: Partial<Record<(typeof ENV)[number], string>>,
    definition: ProviderDefinition,
    model: ModelInfo,
    exchange: FakeExchange,
  ): Promise<Readonly<Record<string, string>>> {
    const saved = ENV.map((name) => [name, process.env[name]] as const)
    for (const name of ENV) {
      const value = env[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    try {
      const net = fakeNetwork(exchange)
      await drain(build(definition, net, countingClock().clock), model)
      return net.requests[0]?.headers ?? {}
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  const STAINLESS_BOTH = [
    'x-stainless-arch',
    'x-stainless-lang',
    'x-stainless-os',
    'x-stainless-package-version',
    'x-stainless-retry-count',
    'x-stainless-runtime',
    'x-stainless-runtime-version',
  ]

  it('keeps an ANTHROPIC_CUSTOM_HEADERS line from adding a header or changing a value', async () => {
    const exchange: FakeExchange = { kind: 'sse', frames: anthropicFixture.PLAIN_TEXT_FRAMES }
    const clean = await headersWith({}, anthropicDefinition, SONNET, exchange)
    const decoyed = await headersWith(
      {
        ANTHROPIC_CUSTOM_HEADERS: [
          'anthropic-beta: sneaky-2026-01-01',
          'x-foo: bar',
          // A name inside the group's prefix the SDK never sends is a header added all the same.
          'x-stainless-foo: bar',
          'anthropic-version: 1999-01-01',
          'user-agent: evil',
          'accept: text/html',
        ].join('\n'),
      },
      anthropicDefinition,
      SONNET,
      exchange,
    )
    expect(decoyed).toEqual(clean)
    expect(decoyed['anthropic-beta']).toBeUndefined()
    expect(decoyed['x-foo']).toBeUndefined()
    expect(decoyed['x-stainless-foo']).toBeUndefined()
    expect(decoyed['anthropic-version']).toBe('2023-06-01')
    expect(decoyed['x-api-key']).toBe(KEY)
    // The SDK's own eight still go (plan step 3, check 5).
    expect(stainless(decoyed)).toEqual([...STAINLESS_BOTH, 'x-stainless-timeout'].toSorted())
  })

  it('does the same for OPENAI_CUSTOM_HEADERS', async () => {
    const exchange: FakeExchange = { kind: 'sse', frames: openAIFixture.PLAIN_TEXT_FRAMES }
    const clean = await headersWith({}, zhipuDefinition, GLM, exchange)
    const decoyed = await headersWith(
      {
        OPENAI_CUSTOM_HEADERS: [
          'anthropic-beta: sneaky',
          'x-foo: bar',
          'x-stainless-foo: bar',
          'user-agent: evil',
          'accept: text/html',
        ].join('\n'),
      },
      zhipuDefinition,
      GLM,
      exchange,
    )
    expect(decoyed).toEqual(clean)
    expect(decoyed['anthropic-beta']).toBeUndefined()
    expect(decoyed['x-foo']).toBeUndefined()
    expect(decoyed['x-stainless-foo']).toBeUndefined()
    expect(decoyed.authorization).toBe(`Bearer ${KEY}`)
    // The SDK's own seven still go: this wire passes the SDK no per-request timeout.
    expect(stainless(decoyed)).toEqual(STAINLESS_BOTH)
  })
})

describe('finish_reason additions from the definition (旧 47)', () => {
  async function stopOf(definition: ProviderDefinition, model: ModelInfo, raw: string) {
    const net = fakeNetwork({ kind: 'sse', frames: openAIFixture.finishReasonFrames(raw) })
    return (await drain(build(definition, net, countingClock().clock), model)).at(-1)
  }

  it('reads zhipu’s sensitive and model_context_window_exceeded, and leaves network_error unknown', async () => {
    expect(await stopOf(zhipuDefinition, GLM, 'sensitive')).toEqual({
      type: 'stop',
      reason: 'content-filter',
      providerReason: 'sensitive',
    })
    expect(await stopOf(zhipuDefinition, GLM, 'model_context_window_exceeded')).toEqual({
      type: 'stop',
      reason: 'context-overflow',
      providerReason: 'model_context_window_exceeded',
    })
    expect(await stopOf(zhipuDefinition, GLM, 'network_error')).toEqual({
      type: 'stop',
      reason: 'unknown',
      providerReason: 'network_error',
    })
  })

  it('keeps the additions to the definition that declares them', async () => {
    const qwen = ollamaDefinition.builtinModels[0] as ModelInfo
    expect(await stopOf(ollamaDefinition, qwen, 'sensitive')).toMatchObject({ reason: 'unknown' })
  })

  it('refuses a definition that would remap a value the wire already knows', () => {
    expect(
      () =>
        new OpenAIChatProvider({
          id: 'zhipu',
          network: fakeNetwork([]),
          clock: countingClock().clock,
          apiKey: KEY,
          baseURL: ZHIPU_DEFAULT_BASE_URL,
          models: [GLM],
          finishReasons: { stop: 'content-filter' },
        }),
    ).toThrow(ProviderInvalidArgumentError)
  })
})

const zhipuErrorBody = (code: string): unknown => ({ error: { code, message: '…' } })

describe('quota-exhausted (旧 105)', () => {
  async function errorOf(
    definition: ProviderDefinition,
    model: ModelInfo,
    status: number,
    body: unknown,
    now = '2026-09-26T10:00:00.000Z',
  ): Promise<StreamEvent | undefined> {
    const host = createMemoryHost({ now: Date.parse(now) })
    const net = fakeNetwork({ kind: 'json', status, body })
    return (await drain(build(definition, net, host.clock), model)).at(-1)
  }

  const spendLimit = {
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: 'Your organization has reached its spend limit.',
      details: { error_code: 'enforced_spend_limit_reached' },
    },
  }

  it('reads Anthropic’s spend limits as not retryable, the 429 with its reset at the next month', async () => {
    expect(await errorOf(anthropicDefinition, SONNET, 429, spendLimit)).toMatchObject({
      type: 'error',
      code: 'quota-exhausted',
      retryable: false,
      resetAt: Date.parse('2026-10-01T00:00:00.000Z'),
    })
    expect(
      await errorOf(anthropicDefinition, SONNET, 429, spendLimit, '2026-12-31T23:59:59.000Z'),
    ).toMatchObject({ resetAt: Date.parse('2027-01-01T00:00:00.000Z') })
    const usage = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'You have reached your specified API usage limits. You will regain access on …',
      },
    }
    const event = await errorOf(anthropicDefinition, SONNET, 400, usage)
    expect(event).toMatchObject({ code: 'quota-exhausted', retryable: false })
    expect(event && 'resetAt' in event).toBe(false)
    // A plain rate limit stays retryable.
    const plain = { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }
    expect(await errorOf(anthropicDefinition, SONNET, 429, plain)).toMatchObject({
      code: 'rate-limit',
      retryable: true,
    })
  })

  it('reads the spend limit at either nesting depth, as a relay may unwrap the error object', async () => {
    // Plan step 7, 旧 105: `details` beside the vendor's own `type` and `message`, the body a gateway
    // relays without the outer `{ type: 'error', error }` — otherwise a retryable rate limit.
    expect(await errorOf(anthropicDefinition, SONNET, 429, spendLimit.error)).toMatchObject({
      type: 'error',
      code: 'quota-exhausted',
      retryable: false,
      resetAt: Date.parse('2026-10-01T00:00:00.000Z'),
    })
  })

  it('reads zhipu’s balance and quota codes as not retryable, and 1302, 1305 as retryable', async () => {
    for (const code of [
      '1113',
      ...Array.from({ length: 14 }, (_, i) => String(1308 + i)).filter(
        (candidate) => candidate !== '1312',
      ),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one error at a time
      expect(await errorOf(zhipuDefinition, GLM, 429, zhipuErrorBody(code))).toMatchObject({
        code: 'quota-exhausted',
        retryable: false,
        providerCode: code,
      })
    }
    for (const code of ['1302', '1305', '1312']) {
      // oxlint-disable-next-line no-await-in-loop -- one error at a time
      expect(await errorOf(zhipuDefinition, GLM, 429, zhipuErrorBody(code))).toMatchObject({
        code: 'rate-limit',
        retryable: true,
      })
    }
  })
})

describe('the Anthropic emulation endpoint keeps the official limits off (01 修补 4)', () => {
  it('uses the 300 000 ms idle limit on a non-official host of the same wire', async () => {
    const time = countingClock()
    const gate = createStreamGate()
    const net = fakeNetwork({ kind: 'sse', frames: anthropicFixture.PLAIN_TEXT_FRAMES, gate })
    const provider = build(anthropicDefinition, net, time.clock, EMULATION_BASE_URL)
    const events: StreamEvent[] = []
    const run = (async () => {
      for await (const event of provider.stream(provider.encode(requestOf(SONNET)), {
        identity: IDENTITY,
      })) {
        events.push(event)
      }
    })()
    await flush()
    gate.release(1)
    await flush()
    time.advance(180_000)
    await flush()
    expect(events.some((event) => event.type === 'error')).toBe(false)
    time.advance(120_000)
    await run
    expect(events.at(-1)).toMatchObject({ code: 'network', timeout: 'idle' })
  })
})

// The default base URL is exported so a test can tell "the official endpoint" apart without
// spelling it; this pins that it is the host the limits key on.
it('treats the anthropic definition’s default base URL as the official host', () => {
  expect(new URL(ANTHROPIC_DEFAULT_BASE_URL).hostname).toBe('api.anthropic.com')
})
