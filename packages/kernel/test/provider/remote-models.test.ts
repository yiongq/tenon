/**
 * A custom vendor's model list (M6 §列表与上限; T6, T7): one GET per press, the ids and six limit keys,
 * a code and a status on failure, never the body. M6 不变量 3's no-redirect half for this route.
 */
import { describe, expect, it } from 'vitest'
import {
  ProviderConfigMissingError,
  createMemoryHost,
  customVendorDefinition,
  fetchRemoteModels,
} from '../../src/index.js'
import type { CustomVendorDescription, HostNetwork, RemoteModelsResult } from '../../src/index.js'
import { ALLOWED_HEADERS as ANTHROPIC_HEADERS } from '../../src/provider/wire/anthropic-messages.js'
import { ALLOWED_HEADERS as OPENAI_HEADERS } from '../../src/provider/wire/openai-chat.js'
import { IDLE_MS_OTHER } from '../../src/provider/wire/transport.js'
import { createStreamGate, fakeNetwork } from '../../src/testing/index.js'
import type { FakeExchange } from '../../src/testing/index.js'
import { DEEPSEEK_MODELS_BODY } from './fixtures/probe-documented.js'

const KEY = 'test-key-not-a-real-credential'
/** A clock whose timers never fire: every body below arrives whole. */
const CLOCK = { setTimeout: () => () => undefined }
/** §列表与上限: the two limits the list sets itself, as the spec states them. */
const HEADERS_MS = 30_000
const MAX_BODY_BYTES = 8 * 1024 * 1024

type Vendor = Pick<CustomVendorDescription, 'id' | 'wire' | 'baseURL' | 'keyRequired'>

const OPENAI: Vendor = {
  id: 'custom-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
  wire: 'openai-chat',
  baseURL: 'https://api.vendor.test/v1',
  keyRequired: true,
}
const ANTHROPIC: Vendor = {
  id: 'custom-6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b',
  wire: 'anthropic-messages',
  baseURL: 'https://api.vendor.test/anthropic',
  keyRequired: true,
}

async function list(
  vendor: Vendor,
  exchange: FakeExchange | readonly FakeExchange[],
  secrets: Record<string, string> = { apiKey: KEY },
) {
  const net = fakeNetwork(exchange)
  const result = await fetchRemoteModels({ vendor, secrets, network: net, clock: CLOCK })
  return { result, net }
}

describe('fetchRemoteModels (§列表与上限)', () => {
  it('按文档、未实测 DeepSeek: GETs <baseURL>/models with the bearer key and prefills both limits', async () => {
    const { result, net } = await list(OPENAI, { kind: 'json', body: DEEPSEEK_MODELS_BODY })
    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'deepseek-flash', contextLimit: 1_048_576, maxOutputTokens: 393_216 },
        { id: 'deepseek-v4-pro', contextLimit: 1_048_576, maxOutputTokens: 393_216 },
      ],
    })
    expect(net.requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', 'https://api.vendor.test/v1/models'],
    ])
    const headers = net.requests[0]?.headers ?? {}
    expect(headers['authorization']).toBe(`Bearer ${KEY}`)
    const allowed = new Set([...OPENAI_HEADERS.names, ...Object.keys(OPENAI_HEADERS.pinned)])
    expect(Object.keys(headers).filter((name) => !allowed.has(name))).toEqual([])
  })

  it('GETs <baseURL>/v1/models on the anthropic wire with x-api-key alone', async () => {
    const { result, net } = await list(ANTHROPIC, { kind: 'json', body: { data: [{ id: 'm' }] } })
    expect(result).toEqual({ ok: true, models: [{ id: 'm' }] })
    const request = net.requests[0]
    expect(request?.url).toBe('https://api.vendor.test/anthropic/v1/models')
    expect(request?.headers['x-api-key']).toBe(KEY)
    expect(request?.headers['anthropic-version']).toBe(
      ANTHROPIC_HEADERS.pinned['anthropic-version'],
    )
    expect(request?.headers).not.toHaveProperty('authorization')
  })

  it('reads the first positive integer of each limit, in the order the spec lists the keys', async () => {
    const { result } = await list(OPENAI, {
      kind: 'json',
      body: {
        data: [
          // Kimi / OpenRouter spell the window context_length; vLLM max_model_len.
          { id: 'kimi', context_length: 262_144 },
          { id: 'vllm', max_model_len: 32_768 },
          // Qianfan's output key, then OpenRouter's nested one.
          { id: 'qianfan', max_completions_tokens: 8192 },
          { id: 'openrouter', top_provider: { max_completion_tokens: 16_384 } },
          // The first key that holds a positive integer wins; the rest are not looked at.
          { id: 'order', context_window: 0, context_length: 100, max_model_len: 200 },
          { id: 'strings', context_window: '128000', max_output_tokens: 4096.5 },
          // Two positive values: the earlier key in the spec's list wins.
          { id: 'window-first', context_window: 64_000, context_length: 128_000 },
          { id: 'length-first', context_length: 1, max_model_len: 2 },
          {
            id: 'output-first',
            max_output_tokens: 8,
            max_completions_tokens: 9,
            top_provider: { max_completion_tokens: 10 },
          },
          {
            id: 'nested-last',
            max_completions_tokens: 9,
            top_provider: { max_completion_tokens: 10 },
          },
          // Size keys outside the spec's six prefill nothing, the top-level spelling of
          // OpenRouter's nested key included.
          {
            id: 'unlisted',
            max_tokens: 4096,
            max_input_tokens: 200_000,
            context_size: 8192,
            max_completion_tokens: 77,
          },
          // A value the IPC contract cannot carry (past Number.MAX_SAFE_INTEGER) is skipped, and the
          // next key in §列表与上限's order is read.
          {
            id: 'huge',
            context_window: 2 ** 53,
            context_length: 4096,
            max_output_tokens: 1e20,
            max_completions_tokens: 8192,
          },
        ],
      },
    })
    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'kimi', contextLimit: 262_144 },
        { id: 'vllm', contextLimit: 32_768 },
        { id: 'qianfan', maxOutputTokens: 8192 },
        { id: 'openrouter', maxOutputTokens: 16_384 },
        { id: 'order', contextLimit: 100 },
        { id: 'strings' },
        { id: 'window-first', contextLimit: 64_000 },
        { id: 'length-first', contextLimit: 1 },
        { id: 'output-first', maxOutputTokens: 8 },
        { id: 'nested-last', maxOutputTokens: 9 },
        { id: 'unlisted' },
        { id: 'huge', contextLimit: 4096, maxOutputTokens: 8192 },
      ],
    })
  })

  it('keeps ids a model row can hold, each once', async () => {
    const { result } = await list(OPENAI, {
      kind: 'json',
      body: {
        // An entry that is not a row is skipped, not the end of the list.
        data: [
          'b',
          { id: 'a' },
          { id: '' },
          null,
          { id: 'c' },
          { id: 7 },
          { name: 'no id' },
          { id: 'a' },
          42,
        ],
      },
    })
    expect(result).toEqual({ ok: true, models: [{ id: 'a' }, { id: 'c' }] })
    const long = await list(OPENAI, {
      kind: 'json',
      body: { data: [{ id: 'x'.repeat(201) }, { id: 'y'.repeat(200) }] },
    })
    expect(long.result).toEqual({ ok: true, models: [{ id: 'y'.repeat(200) }] })
  })

  it('M6 不变量 3: follows no redirect', async () => {
    const seen: (RequestRedirect | undefined)[] = []
    const network: HostNetwork = {
      fetch: (_input, init) => {
        seen.push(init?.redirect)
        return Promise.resolve(Response.json({ data: [] }))
      },
      fetchUntrusted: () => Promise.reject(new Error('never')),
    }
    await fetchRemoteModels({ vendor: OPENAI, secrets: { apiKey: KEY }, network, clock: CLOCK })
    expect(seen).toEqual(['error'])
  })

  it('sends no credential for a keyless local instance (the placeholder is the factory’s alone, §key), and nothing at all for a public one without a key', async () => {
    const locals: readonly Vendor[] = [
      { ...OPENAI, baseURL: 'http://127.0.0.1:8000/v1', keyRequired: false },
      { ...ANTHROPIC, baseURL: 'http://192.168.1.20:8000', keyRequired: false },
    ]
    for (const vendor of locals) {
      // oxlint-disable-next-line no-await-in-loop -- one listing per wire
      const local = await list(vendor, { kind: 'json', body: { data: [] } }, {})
      expect(local.result).toEqual({ ok: true, models: [] })
      expect(local.net.callCount).toBe(1)
      expect(local.net.requests[0]?.headers).not.toHaveProperty('authorization')
      expect(local.net.requests[0]?.headers).not.toHaveProperty('x-api-key')
    }
    const publicOne = await list(OPENAI, [], {})
    expect(publicOne.result).toEqual({ ok: false, code: 'config', status: null })
    expect(publicOne.net.callCount).toBe(0)
  })

  it('reads the key as the instance’s own factory does: trimmed, and blank is none', async () => {
    const description: CustomVendorDescription = {
      ...OPENAI,
      models: [{ id: 'm', contextLimit: 128_000, maxOutputTokens: 8192 }],
    }
    const blank = { apiKey: '   ' }
    expect(() =>
      customVendorDefinition(description).create({
        network: fakeNetwork([]),
        clock: { now: () => 0, setTimeout: CLOCK.setTimeout },
        config: {},
        secrets: blank,
      }),
    ).toThrow(ProviderConfigMissingError)
    const none = await list(OPENAI, [], blank)
    expect(none.result).toEqual({ ok: false, code: 'config', status: null })
    expect(none.net.callCount).toBe(0)
    const padded = await list(OPENAI, { kind: 'json', body: { data: [] } }, { apiKey: ` ${KEY}\n` })
    expect(padded.net.requests[0]?.headers['authorization']).toBe(`Bearer ${KEY}`)
  })

  it('joins a baseURL that ends in a slash as the SDK does', async () => {
    const openAI = await list(
      { ...OPENAI, baseURL: 'https://api.vendor.test/v1/' },
      {
        kind: 'json',
        body: { data: [] },
      },
    )
    expect(openAI.net.requests[0]?.url).toBe('https://api.vendor.test/v1/models')
    const anthropic = await list(
      { ...ANTHROPIC, baseURL: 'https://api.vendor.test/anthropic/' },
      {
        kind: 'json',
        body: { data: [] },
      },
    )
    expect(anthropic.net.requests[0]?.url).toBe('https://api.vendor.test/anthropic/v1/models')
  })

  it('answers config for a key no header can carry, sending nothing and keeping the key out of the answer', async () => {
    // A line break inside a pasted key, and a zero-width space: `Headers` refuses both, and its
    // refusal quotes the key.
    for (const apiKey of ['sk-LEAKME-0123\nrest', 'sk-LEAKME-abc\u200Bdef']) {
      for (const wire of [OPENAI, ANTHROPIC]) {
        // oxlint-disable-next-line no-await-in-loop -- one listing per key and wire
        const { result, net } = await list(wire, [], { apiKey })
        expect(result).toEqual({ ok: false, code: 'config', status: null })
        expect(net.callCount).toBe(0)
        expect(JSON.stringify(result)).not.toContain('LEAKME')
      }
    }
  })

  const failures: readonly {
    readonly name: string
    readonly exchange: FakeExchange
    readonly result: RemoteModelsResult
  }[] = [
    {
      name: 'a refused key',
      exchange: { kind: 'json', status: 401, body: { error: { message: 'bad key sk-secret' } } },
      result: { ok: false, code: 'auth', status: 401 },
    },
    {
      name: 'a forbidden list',
      exchange: { kind: 'json', status: 403, body: {} },
      result: { ok: false, code: 'auth', status: 403 },
    },
    {
      name: 'no list at that path',
      exchange: { kind: 'text', status: 404, body: 'Not Found' },
      result: { ok: false, code: 'unsupported', status: 404 },
    },
    {
      name: 'a body that is not JSON',
      exchange: { kind: 'text', body: '<html>console</html>' },
      result: { ok: false, code: 'unsupported', status: 200 },
    },
    {
      name: 'JSON without a data array',
      exchange: { kind: 'json', body: { models: [{ id: 'a' }] } },
      result: { ok: false, code: 'unsupported', status: 200 },
    },
    {
      name: 'a bare array with no data',
      exchange: { kind: 'json', body: [{ id: 'a' }] },
      result: { ok: false, code: 'unsupported', status: 200 },
    },
    {
      name: 'a request timeout',
      exchange: { kind: 'json', status: 408, body: {} },
      result: { ok: false, code: 'service', status: 408 },
    },
    {
      name: 'a rate limit',
      exchange: { kind: 'json', status: 429, body: {} },
      result: { ok: false, code: 'service', status: 429 },
    },
    {
      name: 'the first server status',
      exchange: { kind: 'json', status: 500, body: {} },
      result: { ok: false, code: 'service', status: 500 },
    },
    {
      name: 'a server error',
      exchange: { kind: 'json', status: 503, body: {} },
      result: { ok: false, code: 'service', status: 503 },
    },
    {
      name: 'no connection',
      exchange: { kind: 'connection-failure' },
      result: { ok: false, code: 'service', status: null },
    },
    {
      name: 'an egress refusal',
      exchange: { kind: 'denied' },
      result: { ok: false, code: 'service', status: null },
    },
  ]
  for (const failure of failures) {
    it(`answers ${failure.name} with a code and the status only`, async () => {
      const { result } = await list(OPENAI, failure.exchange)
      // Exactly these keys: nothing of the body travels back.
      expect(result).toEqual(failure.result)
    })
  }

  it('answers service when the body stops arriving for the idle limit (02 A5, 01 修补 4)', async () => {
    const host = createMemoryHost({ now: Date.parse('2026-10-02T08:00:00.000Z') })
    const gate = createStreamGate()
    const net = fakeNetwork({
      kind: 'sse',
      frames: ['{"data":[', '{"id":"never"}]}'],
      headers: { 'content-type': 'application/json' },
      gate,
    })
    let settled = false
    const listing = fetchRemoteModels({
      vendor: OPENAI,
      secrets: { apiKey: KEY },
      network: net,
      clock: host.clock,
    }).finally(() => {
      settled = true
    })
    gate.release(1)
    await waitFor(() => net.callCount === 1)
    await flush()
    // One millisecond short of the limit, the list is still waiting for its body.
    host.advance(IDLE_MS_OTHER - 1)
    await flush()
    expect(settled).toBe(false)
    host.advance(1)
    expect(await listing).toEqual({ ok: false, code: 'service', status: 200 })
  })

  it('answers service with no status when the response headers take 30 s, and lets the request go', async () => {
    const host = createMemoryHost({ now: Date.parse('2026-10-02T08:00:00.000Z') })
    const signals: AbortSignal[] = []
    // A host whose fetch never answers and does not honour the request's signal either.
    const network: HostNetwork = {
      fetch: (_input, init) => {
        if (init?.signal) signals.push(init.signal)
        return new Promise<Response>(() => undefined)
      },
      fetchUntrusted: () => Promise.reject(new Error('never')),
    }
    let settled = false
    const listing = fetchRemoteModels({
      vendor: OPENAI,
      secrets: { apiKey: KEY },
      network,
      clock: host.clock,
    }).finally(() => {
      settled = true
    })
    await waitFor(() => signals.length === 1)
    host.advance(HEADERS_MS - 1)
    await flush()
    expect(settled).toBe(false)
    host.advance(1)
    expect(await listing).toEqual({ ok: false, code: 'service', status: null })
    // The request itself was aborted rather than left holding a connection.
    expect(signals[0]?.aborted).toBe(true)
  })

  it('rejects on an abort before the response headers even from a host that ignores the signal, rather than answering service', async () => {
    const host = createMemoryHost({ now: Date.parse('2026-10-02T08:00:00.000Z') })
    const controller = new AbortController()
    let calls = 0
    // A host whose fetch never answers and does not honour the request's signal either.
    const network: HostNetwork = {
      fetch: () => {
        calls += 1
        return new Promise<Response>(() => undefined)
      },
      fetchUntrusted: () => Promise.reject(new Error('never')),
    }
    const listing = fetchRemoteModels({
      vendor: OPENAI,
      secrets: { apiKey: KEY },
      network,
      clock: host.clock,
      signal: controller.signal,
    })
    await waitFor(() => calls === 1)
    controller.abort()
    host.advance(HEADERS_MS)
    await expect(listing).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('stops counting the 30 s once the headers arrive: a slow body is held to the idle limit alone', async () => {
    const host = createMemoryHost({ now: Date.parse('2026-10-02T08:00:00.000Z') })
    let push: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = controller
      },
    })
    let answer: ((response: Response) => void) | undefined
    // As a real fetch does, an abort of the request's signal after the headers fails the body.
    const network: HostNetwork = {
      fetch: (_input, init) =>
        new Promise<Response>((resolve) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => push?.error(signal.reason), { once: true })
          answer = resolve
        }),
      fetchUntrusted: () => Promise.reject(new Error('never')),
    }
    let settled = false
    const listing = fetchRemoteModels({
      vendor: OPENAI,
      secrets: { apiKey: KEY },
      network,
      clock: host.clock,
    }).finally(() => {
      settled = true
    })
    await waitFor(() => answer !== undefined)
    // The headers arrive one millisecond inside the limit.
    host.advance(HEADERS_MS - 1)
    answer?.(new Response(body, { headers: { 'content-type': 'application/json' } }))
    await flush()
    push?.enqueue(new TextEncoder().encode('{"data":['))
    await flush()
    // Long past 30 s from the request, one millisecond short of the idle limit since the last byte.
    host.advance(IDLE_MS_OTHER - 1)
    await flush()
    expect(settled).toBe(false)
    push?.enqueue(new TextEncoder().encode('{"id":"late"}]}'))
    push?.close()
    expect(await listing).toEqual({ ok: true, models: [{ id: 'late' }] })
  })

  it('reads a body of exactly 8 MiB, and answers unsupported for one byte more', async () => {
    const head = '{"data":[{"id":"big"}],"pad":"'
    const tail = '"}'
    const sized = (bytes: number): string =>
      `${head}${'x'.repeat(bytes - head.length - tail.length)}${tail}`
    const exact = await list(OPENAI, { kind: 'text', body: sized(MAX_BODY_BYTES) })
    expect(exact.result).toEqual({ ok: true, models: [{ id: 'big' }] })
    const over = await list(OPENAI, { kind: 'text', body: sized(MAX_BODY_BYTES + 1) })
    expect(over.result).toEqual({ ok: false, code: 'unsupported', status: 200 })
  })

  it('stops reading a body that goes on past 8 MiB, and cancels it', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20)
    const chunks = 64
    let pulled = 0
    let cancelled = false
    // 64 MiB of whitespace: every byte arrives promptly, so neither the idle watchdog nor the JSON
    // parser would end it early.
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(chunk)
        if (pulled === chunks) controller.close()
      },
      cancel() {
        cancelled = true
      },
    })
    const network: HostNetwork = {
      fetch: () =>
        Promise.resolve(
          new Response(oversized, { headers: { 'content-type': 'application/json' } }),
        ),
      fetchUntrusted: () => Promise.reject(new Error('never')),
    }
    const result = await fetchRemoteModels({
      vendor: OPENAI,
      secrets: { apiKey: KEY },
      network,
      clock: CLOCK,
    })
    expect(result).toEqual({ ok: false, code: 'unsupported', status: 200 })
    await waitFor(() => cancelled)
    // The body was let go of, not drained to its end.
    expect(pulled).toBeLessThan(chunks)
  })

  it('counts the 8 MiB in UTF-8 bytes, not in characters', async () => {
    const head = '{"data":[{"id":"big"}],"pad":"'
    const tail = '"}'
    // '模' is three bytes in UTF-8 and one UTF-16 unit.
    const room = MAX_BODY_BYTES - head.length - tail.length
    const fits = `${head}${'模'.repeat(Math.floor(room / 3))}${'x'.repeat(room % 3)}${tail}`
    expect(new TextEncoder().encode(fits).byteLength).toBe(MAX_BODY_BYTES)
    const exact = await list(OPENAI, { kind: 'text', body: fits })
    expect(exact.result).toEqual({ ok: true, models: [{ id: 'big' }] })
    const over = `${head}${'模'.repeat(Math.floor(room / 3) + 1)}${tail}`
    expect(new TextEncoder().encode(over).byteLength).toBeGreaterThan(MAX_BODY_BYTES)
    // Well under the limit counted in characters.
    expect(over.length).toBeLessThan(MAX_BODY_BYTES / 2)
    const tooBig = await list(OPENAI, { kind: 'text', body: over })
    expect(tooBig.result).toEqual({ ok: false, code: 'unsupported', status: 200 })
  })

  it('decodes the body as Response.text() would: a leading BOM dropped, a character split across chunks kept whole', async () => {
    const bytes = new TextEncoder().encode('{"data":[{"id":"模型-a"}]}')
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf)
    // The boundary falls after the first of the three bytes of '模'.
    const split = bytes.indexOf(0xe6) + 1
    const chunks = [Uint8Array.of(...bom, ...bytes.subarray(0, split)), bytes.subarray(split)]
    const network: HostNetwork = {
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                const chunk = chunks.shift()
                if (chunk === undefined) controller.close()
                else controller.enqueue(chunk)
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
      fetchUntrusted: () => Promise.reject(new Error('never')),
    }
    const result = await fetchRemoteModels({
      vendor: OPENAI,
      secrets: { apiKey: KEY },
      network,
      clock: CLOCK,
    })
    expect(result).toEqual({ ok: true, models: [{ id: '模型-a' }] })
  })

  it('rejects on an abort while the body is arriving, rather than answering service', async () => {
    const controller = new AbortController()
    const gate = createStreamGate()
    const net = fakeNetwork({
      kind: 'sse',
      frames: ['{"data":[', '{"id":"never"}]}'],
      headers: { 'content-type': 'application/json' },
      gate,
    })
    const signals: (AbortSignal | null | undefined)[] = []
    const network: HostNetwork = {
      fetch: (input, init) => {
        signals.push(init?.signal)
        return net.fetch(input, init)
      },
      fetchUntrusted: net.fetchUntrusted,
    }
    const listing = fetchRemoteModels({
      vendor: OPENAI,
      secrets: { apiKey: KEY },
      network,
      clock: CLOCK,
      signal: controller.signal,
    })
    gate.release(1)
    await waitFor(() => net.callCount === 1)
    await flush()
    controller.abort()
    await expect(listing).rejects.toMatchObject({ name: 'AbortError' })
    // The caller's signal reached the request itself.
    expect(signals.map((signal) => signal?.aborted)).toEqual([true])
  })

  it('rejects on an abort before the response headers, rather than answering service', async () => {
    const controller = new AbortController()
    let calls = 0
    // A host whose fetch stays out until the request's own signal aborts it, as a real fetch does.
    const network: HostNetwork = {
      fetch: (_input, init) => {
        calls += 1
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
        })
      },
      fetchUntrusted: () => Promise.reject(new Error('never')),
    }
    const listing = fetchRemoteModels({
      vendor: OPENAI,
      secrets: { apiKey: KEY },
      network,
      clock: CLOCK,
      signal: controller.signal,
    })
    await waitFor(() => calls === 1)
    controller.abort()
    await expect(listing).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('answers config for an address no request could reach, sending nothing', async () => {
    const { result, net } = await list({ ...ANTHROPIC, baseURL: 'https://api.vendor.test/v1' }, [])
    expect(result).toEqual({ ok: false, code: 'config', status: null })
    expect(net.callCount).toBe(0)
  })
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling until the request is out
    await flush()
  }
  if (!condition()) throw new Error('the condition never held')
}
