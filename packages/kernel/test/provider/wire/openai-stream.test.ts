/**
 * The OpenAI-compatible adapter's stream(): invariants 1-6 per fixture, invariant 8's credential
 * and request-count half, and the two abort paths (invariant 2).
 *
 * Everything goes through `fakeNetwork`, so no socket is opened and no credential is real. The
 * fixtures are hand-built from the documented wire format — see the header of
 * ../fixtures/openai-sse.ts.
 *
 * Acceptance 1 (the same kernel path through every definition) is in ../definitions.test.ts, and
 * the "same-shaped Tape facts" half of it belongs to the session service (step 12); nothing here
 * writes to a Tape.
 */
import { describe, expect, it } from 'vitest'
import {
  OpenAIChatProvider,
  ProviderConfigMissingError,
  ProviderInvalidArgumentError,
  createBlockAccumulator,
  encodeOpenAIChat,
} from '../../../src/index.js'
import type {
  ContentBlock,
  EncodedRequest,
  ProviderErrorCode,
  SendContext,
  StopReason,
  StreamEvent,
  Usage,
} from '../../../src/index.js'
import { createStreamGate, fakeNetwork } from '../../../src/testing/index.js'
import type { FakeExchange, FakeNetwork } from '../../../src/testing/index.js'
import * as fixture from '../fixtures/openai-sse.js'
import { TOOL, openAIModel, requestOf } from './fixtures.js'

const PROVIDER_ID = 'zhipu'
const BASE_URL = 'https://open.bigmodel.test/api/paas/v4/'
/** Shaped like the real thing so a leak into a header or a `detail` is unmistakable. */
const API_KEY = 'zp-test-key-0123456789.abcdef'
/** A fixed HostClock reading: the HTTP-date branch of retry-after is relative to it. */
const NOW = Date.parse('2026-09-21T00:00:00.000Z')

const IDENTITY = {
  runId: '00000000-0000-4000-8000-000000000002',
  requestSeq: 1,
  physicalAttempt: 1,
}

const CONTEXT: SendContext = { identity: IDENTITY }

/**
 * Every variable the pinned SDK reads by itself: the credential it would take from an `undefined`
 * apiKey, the two tenant headers it would add, the base URL it would redirect to, and
 * OPENAI_CUSTOM_HEADERS — the one that can REPLACE the credential on the wire, because
 * `defaultHeaders` is merged after the authentication header.
 */
const CREDENTIAL_ENV = [
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'OPENAI_BASE_URL',
  'OPENAI_CUSTOM_HEADERS',
  'OPENAI_WEBHOOK_SECRET',
  'OPENAI_LOG',
] as const

const DECOY_ENV: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: 'sk-decoy-must-not-travel',
  OPENAI_ADMIN_KEY: 'sk-admin-decoy-must-not-travel',
  OPENAI_ORG_ID: 'org-decoy-must-not-travel',
  OPENAI_PROJECT_ID: 'proj-decoy-must-not-travel',
  OPENAI_BASE_URL: 'https://decoy.invalid/v1',
  OPENAI_CUSTOM_HEADERS: 'Authorization: Bearer sk-decoy-must-not-travel\nX-Decoy: decoy',
  OPENAI_WEBHOOK_SECRET: 'whsec_decoy-must-not-travel',
  OPENAI_LOG: 'debug',
}

type Options = ConstructorParameters<typeof OpenAIChatProvider>[0]

function providerOf(net: FakeNetwork, overrides: Partial<Options> = {}): OpenAIChatProvider {
  return new OpenAIChatProvider({
    id: PROVIDER_ID,
    network: net,
    clock: { now: () => NOW },
    apiKey: API_KEY,
    baseURL: BASE_URL,
    models: [openAIModel()],
    ...overrides,
  })
}

/** One encoded request, reused: stream() consumes encode()'s output, never a raw request. */
function encodedRequest(): EncodedRequest {
  return encodeOpenAIChat(
    requestOf(openAIModel(), { system: 'be brief', tools: [TOOL] }),
    PROVIDER_ID,
  )
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

interface Run {
  readonly events: StreamEvent[]
  readonly net: FakeNetwork
}

async function run(exchange: FakeExchange, overrides: Partial<Options> = {}): Promise<Run> {
  const net = fakeNetwork(exchange)
  const events = await collect(providerOf(net, overrides).stream(encodedRequest(), CONTEXT))
  return { events, net }
}

function sse(frames: readonly string[]): FakeExchange {
  return { kind: 'sse', frames }
}

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: fixture.PROMPT_TOKENS,
    outputTokens: fixture.COMPLETION_TOKENS,
    cacheReadTokens: fixture.CACHED_TOKENS,
    cacheWriteTokens: fixture.CACHE_WRITE_TOKENS,
    reasoningTokens: 0,
    final: true,
    ...overrides,
  }
}

function terminalsOf(events: readonly StreamEvent[]): StreamEvent[] {
  return events.filter((event) => event.type === 'stop' || event.type === 'error')
}

/** The block accumulator's view of a stream — what a caller would persist. */
function contentOf(events: readonly StreamEvent[]): ContentBlock[] {
  const blocks = createBlockAccumulator({ provider: PROVIDER_ID, providerModel: 'glm-test' })
  for (const event of events) blocks.apply(event)
  return blocks.content()
}

function textOf(events: readonly StreamEvent[]): string {
  return contentOf(events)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

/**
 * The invariants that hold for EVERY stream, whatever the fixture said: exactly one terminal event
 * and it is last (1), no `usage` after it and at most one final reading (1), a `tool-call-start`
 * before any fragment of its index (4), and an object input on every end (6).
 */
function checkStreamInvariants(events: readonly StreamEvent[]): void {
  const terminals = terminalsOf(events)
  expect(terminals).toHaveLength(1)
  expect(events.at(-1)).toBe(terminals[0])
  const finalUsage = events.filter((event) => event.type === 'usage' && event.usage.final)
  expect(finalUsage.length).toBeLessThanOrEqual(1)
  const started = new Set<number>()
  const unstartedFragments: number[] = []
  const badInputs: unknown[] = []
  for (const event of events) {
    if (event.type === 'tool-call-start') started.add(event.index)
    if (event.type === 'tool-call-args-delta' && !started.has(event.index)) {
      unstartedFragments.push(event.index)
    }
    if (event.type === 'tool-call-end' && !isPlainObject(event.input)) badInputs.push(event.input)
  }
  expect(unstartedFragments).toEqual([])
  expect(badInputs).toEqual([])
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('OpenAIChatProvider construction', () => {
  it('refuses a missing or blank apiKey before a client exists', () => {
    const net = fakeNetwork([])
    // `null` and `''` would make the SDK throw its own `Missing credentials`, and `undefined` would
    // make it read OPENAI_API_KEY — neither is an answer a caller can act on.
    for (const apiKey of [null, '', '   ', undefined as unknown as string | null]) {
      expect(() => providerOf(net, { apiKey })).toThrow(ProviderConfigMissingError)
    }
  })

  it('refuses a blank baseURL rather than fall back to api.openai.com', () => {
    // The SDK resolves a falsy baseURL to https://api.openai.com/v1, which would send THIS
    // provider's key to a different vendor.
    expect(() => providerOf(fakeNetwork([]), { baseURL: '' })).toThrow(ProviderConfigMissingError)
    expect(() => providerOf(fakeNetwork([]), { baseURL: 'open.bigmodel.test' })).toThrow(
      ProviderInvalidArgumentError,
    )
  })

  it('accepts the /v1 base URLs this wire actually lives under', () => {
    // Refused on the Anthropic wire, required here: ollama's documented base URL is exactly this.
    for (const baseURL of ['http://localhost:11434/v1/', 'http://localhost:11434/v1']) {
      expect(() => providerOf(fakeNetwork([]), { baseURL })).not.toThrow()
    }
  })

  it('refuses a base URL carrying a query string or a fragment', () => {
    // The SDK appends the endpoint path to the whole string, so these produce a request to `/v1`
    // with `?tenant=a/chat/completions` as its query — a 404 that reads as a dead gateway.
    for (const baseURL of [
      'https://gw.test/v1?tenant=a',
      'https://gw.test/v1#frag',
      'https://gw.test/v1/?api-version=2026-01-01',
    ]) {
      expect(() => providerOf(fakeNetwork([]), { baseURL })).toThrow(ProviderInvalidArgumentError)
    }
  })

  it('reports the definition models and no thinking tier of its own', async () => {
    const provider = providerOf(fakeNetwork([]))
    const models = await provider.models()
    expect(models.map((model) => model.id)).toEqual(['glm-test'])
    models.pop()
    expect(await provider.models()).toHaveLength(1)
    // This wire has no thinking parameter; a vendor's own travels in `requestParams`, which the
    // kernel does not interpret.
    expect(provider.thinkingEffortSupport(openAIModel())).toBe('none')
  })

  it('refuses to stream a request another provider encoded', () => {
    const provider = providerOf(fakeNetwork([]), { id: 'zhipu-gateway' })
    expect(() => provider.stream(encodedRequest(), CONTEXT)).toThrow(ProviderInvalidArgumentError)
  })
})

describe('OpenAIChatProvider stream() normalisation', () => {
  it('maps a plain text turn and puts the trailing usage before the stop', async () => {
    const { events, net } = await run(sse(fixture.PLAIN_TEXT_FRAMES))
    checkStreamInvariants(events)
    expect(events).toEqual([
      // The opening `content: ''` beside the role is not content and opens no block.
      { type: 'text-delta', index: 0, text: fixture.PLAIN_TEXT[0] },
      { type: 'text-delta', index: 0, text: fixture.PLAIN_TEXT[1] },
      { type: 'usage', usage: usage() },
      { type: 'stop', reason: 'end-turn', providerReason: 'stop' },
    ])
    expect(net.callCount).toBe(1)
  })

  it('keeps the usage when it rides on the finish-reason chunk instead of a trailing one', async () => {
    const { events } = await run(sse(fixture.USAGE_WITH_FINISH_FRAMES))
    checkStreamInvariants(events)
    expect(events.slice(-2)).toEqual([
      { type: 'usage', usage: usage() },
      { type: 'stop', reason: 'end-turn', providerReason: 'stop' },
    ])
  })

  it('maps reasoning_content into its own thinking block, in arrival order', async () => {
    const { events } = await run(sse(fixture.REASONING_CONTENT_FRAMES))
    checkStreamInvariants(events)
    expect(events).toEqual([
      { type: 'thinking-delta', index: 0, text: fixture.REASONING_TEXT[0] },
      { type: 'thinking-delta', index: 0, text: fixture.REASONING_TEXT[1] },
      { type: 'text-delta', index: 1, text: fixture.REASONING_ANSWER },
      { type: 'usage', usage: usage({ reasoningTokens: fixture.REASONING_TOKENS }) },
      { type: 'stop', reason: 'end-turn', providerReason: 'stop' },
    ])
    // No signature is ever invented on this wire (invariant 7): the guard will drop the block as
    // `missing-signature` if a signed-blocks model ever sees it.
    expect(contentOf(events)).toEqual([
      {
        type: 'thinking',
        text: fixture.REASONING_TEXT.join(''),
        signature: '',
        provider: PROVIDER_ID,
        providerModel: 'glm-test',
      },
      { type: 'text', text: fixture.REASONING_ANSWER },
    ])
  })

  it("maps ollama's `reasoning` field and a whole tool call delivered in one chunk", async () => {
    const { events } = await run(sse(fixture.OLLAMA_WHOLE_CALL_FRAMES))
    checkStreamInvariants(events)
    expect(events).toEqual([
      { type: 'thinking-delta', index: 0, text: fixture.REASONING_TEXT[0] },
      { type: 'tool-call-start', index: 1, id: fixture.TOOL_ID, name: fixture.TOOL_NAME },
      {
        type: 'tool-call-args-delta',
        index: 1,
        json: JSON.stringify(fixture.TOOL_INPUT),
      },
      {
        type: 'tool-call-end',
        index: 1,
        id: fixture.TOOL_ID,
        name: fixture.TOOL_NAME,
        input: fixture.TOOL_INPUT,
      },
      { type: 'usage', usage: usage() },
      { type: 'stop', reason: 'tool-use', providerReason: 'tool_calls' },
    ])
  })

  it('releases nothing for a tool index before its id and name arrive (invariant 4)', async () => {
    const { events } = await run(sse(fixture.ARGS_BEFORE_ID_FRAMES))
    checkStreamInvariants(events)
    // The fragments were sent first on the wire and come out after the start, in order.
    expect(events.slice(0, 4)).toEqual([
      { type: 'tool-call-start', index: 0, id: fixture.TOOL_ID, name: fixture.TOOL_NAME },
      { type: 'tool-call-args-delta', index: 0, json: fixture.TOOL_ARGS_FRAGMENTS[0] },
      { type: 'tool-call-args-delta', index: 0, json: fixture.TOOL_ARGS_FRAGMENTS[1] },
      {
        type: 'tool-call-end',
        index: 0,
        id: fixture.TOOL_ID,
        name: fixture.TOOL_NAME,
        input: fixture.TOOL_INPUT,
      },
    ])
  })

  it('keeps two interleaved tool calls apart and sends {} for the one with no arguments', async () => {
    const { events } = await run(sse(fixture.PARALLEL_TOOL_CALLS_FRAMES))
    checkStreamInvariants(events)
    const ends = events.filter((event) => event.type === 'tool-call-end')
    expect(ends).toEqual([
      {
        type: 'tool-call-end',
        index: 0,
        id: fixture.TOOL_ID,
        name: fixture.TOOL_NAME,
        input: fixture.TOOL_INPUT,
      },
      {
        type: 'tool-call-end',
        index: 1,
        id: fixture.SECOND_TOOL_ID,
        name: fixture.SECOND_TOOL_NAME,
        input: {},
      },
    ])
    // Invariant 6 on the value itself: `{}`, never null and never the string '{}'.
    expect(ends[1]?.type === 'tool-call-end' ? ends[1].input : null).toEqual({})
    expect(contentOf(events)).toHaveLength(2)
  })

  it('never ends a tool call the output limit truncated (invariant 5)', async () => {
    const { events } = await run(sse(fixture.TRUNCATED_TOOL_CALL_FRAMES))
    checkStreamInvariants(events)
    expect(events.filter((event) => event.type === 'tool-call-end')).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'max-tokens', providerReason: 'length' })
    // Only the text survives into the transcript.
    expect(contentOf(events)).toEqual([{ type: 'text', text: fixture.TOOL_PREAMBLE }])
  })

  it('keeps two calls apart when the vendor reuses one index (ollama#15457)', async () => {
    const { events } = await run(sse(fixture.REUSED_INDEX_FRAMES))
    checkStreamInvariants(events)
    // Two ends, two slots. Keyed on the index alone the second call's arguments would have been
    // appended to the first's, the concatenation would not parse, and BOTH would be dropped — a
    // turn that stops with `tool-use` and nothing runnable in it.
    expect(events.filter((event) => event.type === 'tool-call-end')).toEqual([
      {
        type: 'tool-call-end',
        index: 0,
        id: fixture.TOOL_ID,
        name: fixture.TOOL_NAME,
        input: fixture.TOOL_INPUT,
      },
      {
        type: 'tool-call-end',
        index: 1,
        id: fixture.SECOND_TOOL_ID,
        name: fixture.SECOND_TOOL_NAME,
        input: fixture.SECOND_TOOL_INPUT,
      },
    ])
  })

  it('reads a JSON-encoded tool index and refuses one it cannot read', async () => {
    const { events } = await run(sse(fixture.STRING_INDEX_FRAMES))
    checkStreamInvariants(events)
    expect(
      events
        .filter((event) => event.type === 'tool-call-end')
        .map((event) => (event.type === 'tool-call-end' ? [event.index, event.input] : null)),
    ).toEqual([
      [0, fixture.TOOL_INPUT],
      [1, fixture.SECOND_TOOL_INPUT],
    ])
    // An index that is neither a number nor a number's spelling is NOT defaulted to 0: the fallback
    // belongs to the absent-index (single call) shape, and extending it to an unreadable value is
    // how two calls end up sharing a slot.
    const unreadable = await run(sse(fixture.UNREADABLE_INDEX_FRAMES))
    checkStreamInvariants(unreadable.events)
    expect(unreadable.events.filter((event) => event.type.startsWith('tool-call'))).toEqual([])
  })

  it('never ends a tool call whose arguments arrived as an object', async () => {
    const { events } = await run(sse(fixture.OBJECT_TOOL_ARGS_FRAMES))
    checkStreamInvariants(events)
    // The dangerous reading would be `input: {}`: a runnable call with its arguments thrown away,
    // which is the one outcome parseToolArguments() exists to avoid on the truncated path too.
    expect(events.filter((event) => event.type === 'tool-call-end')).toEqual([])
    expect(contentOf(events)).toEqual([])
  })

  it('never ends a tool call whose arguments are not a JSON object', async () => {
    const { events } = await run(sse(fixture.MALFORMED_TOOL_ARGS_FRAMES))
    checkStreamInvariants(events)
    // Documented divergence from the Anthropic adapter: there a content_block_stop proves the call
    // was complete, so garbled arguments end the stream as an error. Here nothing proves
    // completeness, so an unparsable call is dropped exactly like a truncated one — and NOT coerced
    // to `{}`, which would invent an empty argument set for a call that had one.
    expect(events.filter((event) => event.type === 'tool-call-end')).toEqual([])
    expect(events.at(-1)).toEqual({
      type: 'stop',
      reason: 'tool-use',
      providerReason: 'tool_calls',
    })
    expect(contentOf(events)).toEqual([])
  })

  it('maps every finish reason the pinned SDK knows, and keeps the raw value', async () => {
    const expected: readonly (readonly [string, StopReason])[] = [
      ['stop', 'end-turn'],
      ['length', 'max-tokens'],
      ['tool_calls', 'tool-use'],
      ['function_call', 'tool-use'],
      ['content_filter', 'content-filter'],
      // A compatible vendor's own spelling (zhipu answers all three of these): reported as unknown
      // with the raw value kept, which is where a later mapping can start.
      ['sensitive', 'unknown'],
      ['network_error', 'unknown'],
      ['model_context_window_exceeded', 'unknown'],
    ]
    for (const [raw, reason] of expected) {
      // oxlint-disable-next-line no-await-in-loop -- one stream per finish reason, in order
      const { events } = await run(sse(fixture.finishReasonFrames(raw)))
      checkStreamInvariants(events)
      expect(events.at(-1)).toEqual({ type: 'stop', reason, providerReason: raw })
    }
  })

  it('reports a body that never stated a finish reason as a truncated stream', async () => {
    const { events } = await run(sse(fixture.NO_FINISH_REASON_FRAMES))
    checkStreamInvariants(events)
    const terminal = events.at(-1)
    if (terminal?.type !== 'error') throw new Error('expected a terminal error event')
    // Calling it `end-turn` would let the phase 2 loop treat a truncated turn as a completed one.
    expect(terminal.code).toBe('network')
    expect(terminal.retryable).toBe(true)
    expect(textOf(events)).toBe(fixture.PLAIN_TEXT[0])
  })

  it('turns a mid-stream error object into the terminal error event (invariant 3)', async () => {
    const { events } = await run(sse(fixture.MID_STREAM_ERROR_FRAMES))
    checkStreamInvariants(events)
    expect(events[0]).toEqual({ type: 'text-delta', index: 0, text: fixture.MID_STREAM_TEXT })
    const terminal = events.at(-1)
    if (terminal?.type !== 'error') throw new Error('expected a terminal error event')
    expect(terminal.code).toBe('server')
    expect(terminal.retryable).toBe(true)
    expect(terminal.providerCode).toBe(fixture.MID_STREAM_ERROR_CODE)
    // The frame carries no HTTP status, which is how a mid-stream error tells itself apart.
    expect('status' in terminal).toBe(false)
    expect(terminal.detail).toContain(fixture.MID_STREAM_ERROR_MESSAGE)
    // The partial text is kept: an error is not an excuse to lose what arrived.
    expect(textOf(events)).toBe(fixture.MID_STREAM_TEXT)
  })

  it('completes on the finish reason without parking on the frames behind it', async () => {
    const gate = createStreamGate()
    const net = fakeNetwork({ kind: 'sse', frames: fixture.PLAIN_TEXT_FRAMES, gate })
    // Everything including `[DONE]`, because this wire's stop is held back to the end of the
    // iterator: the usage chunk arrives after the finish reason, so the adapter cannot stop
    // reading when it sees one (plan.md, step 2: both SDKs keep reading after their end frame).
    gate.release(fixture.PLAIN_TEXT_FRAMES.length)
    const events = await collect(providerOf(net).stream(encodedRequest(), CONTEXT))
    checkStreamInvariants(events)
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end-turn', providerReason: 'stop' })
    expect(gate.remaining).toBe(0)
  })
})

interface ErrorCase {
  readonly name: string
  readonly fixture: fixture.HttpErrorFixture
  readonly code: ProviderErrorCode
  readonly retryable: boolean
  readonly providerCode: string
  readonly retryAfterMs?: number
}

const ERROR_CASES: readonly ErrorCase[] = [
  {
    name: '401',
    fixture: fixture.UNAUTHORIZED,
    code: 'auth',
    retryable: false,
    providerCode: 'invalid_api_key',
  },
  {
    name: '429 with retry-after seconds',
    fixture: fixture.RATE_LIMITED,
    code: 'rate-limit',
    retryable: true,
    providerCode: 'rate_limit_exceeded',
    retryAfterMs: fixture.RETRY_AFTER_SECONDS * 1000,
  },
  {
    name: '500',
    fixture: fixture.SERVER_ERROR,
    code: 'server',
    retryable: true,
    providerCode: 'server_error',
  },
  {
    name: '400 naming context_length_exceeded',
    fixture: fixture.CONTEXT_TOO_LONG,
    code: 'context-overflow',
    retryable: false,
    providerCode: 'context_length_exceeded',
  },
  {
    name: '400 with a numeric vendor code this table does not know',
    fixture: fixture.UNKNOWN_NUMERIC_CODE,
    code: 'invalid-request',
    retryable: false,
    providerCode: '9999',
  },
  {
    // The vendor's code beats the status here, and only in this direction: 429 alone would be a
    // retryable rate limit, and the phase 2 loop would resend an empty account for ever.
    name: "429 whose vendor code says 欠费 (zhipu's 1113)",
    fixture: fixture.OUT_OF_CREDIT,
    code: 'invalid-request',
    retryable: false,
    providerCode: '1113',
    retryAfterMs: fixture.RETRY_AFTER_SECONDS * 1000,
  },
  {
    // The same shape from the vendor this wire is named after, which the ERROR_VOCABULARY comment
    // has always claimed to handle: it only takes effect because a non-retryable code is read first.
    name: '429 naming insufficient_quota',
    fixture: fixture.INSUFFICIENT_QUOTA,
    code: 'invalid-request',
    retryable: false,
    providerCode: 'insufficient_quota',
  },
  {
    // A 400 whose message is Chinese: the code carries it, and the widened wording is the backstop
    // for a gateway that relays the message and drops the code.
    name: "400 whose vendor code says Prompt 超长 (zhipu's 1261)",
    fixture: fixture.PROMPT_TOO_LONG,
    code: 'context-overflow',
    retryable: false,
    providerCode: '1261',
  },
]

describe('OpenAIChatProvider stream() error mapping', () => {
  for (const testCase of ERROR_CASES) {
    it(`maps ${testCase.name}`, async () => {
      const exchange: FakeExchange = {
        kind: 'json',
        status: testCase.fixture.status,
        body: testCase.fixture.body,
        ...(testCase.fixture.headers === undefined ? {} : { headers: testCase.fixture.headers }),
      }
      const { events, net } = await run(exchange)
      checkStreamInvariants(events)
      // Exactly one physical request: maxRetries is 0, so a 500 is one call, not three.
      expect(net.callCount).toBe(1)
      expect(events).toHaveLength(1)
      const terminal = events[0]
      if (terminal?.type !== 'error') throw new Error('expected a single error event')
      expect(terminal.code).toBe(testCase.code)
      expect(terminal.retryable).toBe(testCase.retryable)
      expect(terminal.status).toBe(testCase.fixture.status)
      expect(terminal.providerCode).toBe(testCase.providerCode)
      expect(terminal.retryAfterMs).toBe(testCase.retryAfterMs)
      expect(terminal.detail).not.toContain(API_KEY)
    })
  }

  it('maps a host egress denial to a non-retryable egress-denied', async () => {
    // Two messages, one phrased the way the SDK's own timeout heuristic looks for: it string-matches
    // the rejection AND its cause for /timed? ?out/i, and a denial read as a timeout would have the
    // phase 2 loop resend a request the host's egress policy refused.
    for (const message of [
      'host policy refused open.bigmodel',
      'host policy refused open.bigmodel: the connection timed out first',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one stream per denial shape, in order
      const { events } = await run({ kind: 'denied', message })
      checkStreamInvariants(events)
      const terminal = events[0]
      if (terminal?.type !== 'error') throw new Error('expected a single error event')
      expect(terminal.code).toBe('egress-denied')
      expect(terminal.retryable).toBe(false)
      expect(terminal.detail).toContain('host policy refused')
    }
  })

  it('maps a failed connection to a retryable network error', async () => {
    const { events } = await run({ kind: 'connection-failure' })
    checkStreamInvariants(events)
    const terminal = events[0]
    if (terminal?.type !== 'error') throw new Error('expected a single error event')
    expect(terminal.code).toBe('network')
    expect(terminal.retryable).toBe(true)
  })

  it('maps a connection dropped MID-BODY to the same retryable network error', async () => {
    // The pinned SDK wraps a rejected fetch in APIConnectionError only on the connect path: a
    // failure raised while reading the body is rethrown verbatim. Unmarked, the commonest transient
    // streaming failure would classify as `unknown` — never retried — while the same connection
    // dropping on a frame boundary is the retryable `network` error the case above asserts.
    const shapes: readonly (readonly [string, unknown])[] = [
      // What undici really produces when a response body is cut off.
      ['undici', Object.assign(new TypeError('terminated'), { cause: new Error('closed') })],
      ['bare TypeError', new TypeError('fetch failed')],
      ['errno', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
      // A body that stops in the middle of a `data:` line: the SDK raises a SyntaxError of its own.
      [
        'malformed frame',
        new SyntaxError('Error reading response: malformed server-sent event JSON.'),
      ],
    ]
    for (const [name, error] of shapes) {
      // oxlint-disable-next-line no-await-in-loop -- one dropped connection at a time, in order
      const events = await dropMidBody(error)
      checkStreamInvariants(events)
      const terminal = events.at(-1)
      if (terminal?.type !== 'error') throw new Error(`${name}: expected a terminal error event`)
      expect(terminal.code).toBe('network')
      expect(terminal.retryable).toBe(true)
      // An errno is not the vendor's vocabulary: `providerCode` is the field a later mapping is
      // built from, and `ECONNRESET` in it would classify a socket failure as a vendor condition.
      expect(terminal.providerCode).toBeNull()
      // What arrived is kept: a failure is not an excuse to lose the text.
      expect(textOf(events)).toBe(fixture.PLAIN_TEXT[0])
    }
  })

  it('keeps a usage reading the vendor already stated when the stream then fails', async () => {
    const { events } = await run(sse(fixture.ERROR_AFTER_USAGE_FRAMES))
    checkStreamInvariants(events)
    // The attempt was billed. A `provider/attempt_completed` fact reporting zero tokens for it is
    // indistinguishable later from a genuinely free turn — and the stop this error replaces is the
    // only thing the held-back ordering is allowed to cost.
    expect(events).toEqual([
      { type: 'text-delta', index: 0, text: fixture.MID_STREAM_TEXT },
      { type: 'usage', usage: usage() },
      expect.objectContaining({ type: 'error', code: 'server', retryable: true }),
    ])
  })

  it('never lets the credential reach detail, not even a prefix of it', async () => {
    // A gateway that echoes a long request into its error message is the realistic leak. The padding
    // is swept in steps shorter than the key, so at least one of these puts it across `detail`'s
    // 500-character cap — and a surviving prefix of a key is still a key in a log.
    for (let padding = 350; padding <= 470; padding += 10) {
      // oxlint-disable-next-line no-await-in-loop -- one stream per padding, in order
      const { events } = await run({
        kind: 'json',
        status: 400,
        body: {
          error: { code: 'invalid_request_error', message: `${'p'.repeat(padding)}${API_KEY}` },
        },
      })
      const terminal = events[0]
      if (terminal?.type !== 'error') throw new Error('expected a single error event')
      expect(terminal.detail).not.toContain(API_KEY)
      expect(terminal.detail).not.toContain(API_KEY.slice(0, 10))
    }
  })
})

/**
 * Consumes the first text delta off a gated stream and then drops the connection mid-body, the way
 * a real one dies: the response and its headers exist, some of the body arrived, and the rest never
 * does. Deterministic — the reader has provably seen one frame and nothing after it.
 */
async function dropMidBody(error: unknown): Promise<StreamEvent[]> {
  const gate = createStreamGate()
  const net = fakeNetwork({ kind: 'sse', frames: fixture.PLAIN_TEXT_FRAMES, gate })
  const iterator = providerOf(net).stream(encodedRequest(), CONTEXT)[Symbol.asyncIterator]()
  // The role chunk carries `content: ''`, which produces no event of its own.
  gate.release(2)
  const events: StreamEvent[] = []
  const first = await iterator.next()
  if (first.done === true) throw new Error('the fixture ran out of frames')
  events.push(first.value)
  gate.fail(error)
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- draining the terminal event
    const step = await iterator.next()
    if (step.done === true) break
    events.push(step.value)
  }
  return events
}

describe('OpenAIChatProvider abort (invariant 2)', () => {
  it('produces one aborted stop and no request when the signal is already aborted', async () => {
    const net = fakeNetwork(sse(fixture.PLAIN_TEXT_FRAMES))
    const controller = new AbortController()
    controller.abort()
    const events = await collect(
      providerOf(net).stream(encodedRequest(), { identity: IDENTITY, signal: controller.signal }),
    )
    expect(events).toEqual([{ type: 'stop', reason: 'aborted', providerReason: null }])
    expect(net.callCount).toBe(0)
  })

  it('aborts cleanly mid-stream, keeping exactly the text that arrived', async () => {
    for (let stopAfter = 1; stopAfter <= fixture.LONG_TEXT_DELTAS.length; stopAfter += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one abort point at a time, on purpose
      const { events, net } = await abortAfter(stopAfter)
      expect(terminalsOf(events)).toEqual([
        { type: 'stop', reason: 'aborted', providerReason: null },
      ])
      expect(events).toHaveLength(stopAfter + 1)
      expect(textOf(events)).toBe(fixture.LONG_TEXT_DELTAS.slice(0, stopAfter).join(''))
      // The held-back stop is replaced, not appended: an aborted turn has no usage and no
      // finish reason, so nothing of the vendor's terminal survives.
      expect(events.filter((event) => event.type === 'usage')).toEqual([])
      expect(net.callCount).toBe(1)
    }
  }, 30_000)
})

/**
 * Consumes exactly `stopAfter` events off a gated long stream, releasing one frame per event, and
 * then aborts. Deterministic by construction: no timers, no randomness, and every frame after the
 * role chunk produces exactly one normalised event.
 */
async function abortAfter(stopAfter: number): Promise<Run> {
  const gate = createStreamGate()
  const net = fakeNetwork({ kind: 'sse', frames: fixture.LONG_TEXT_FRAMES, gate })
  const controller = new AbortController()
  const stream = providerOf(net).stream(encodedRequest(), {
    identity: IDENTITY,
    signal: controller.signal,
  })
  const iterator = stream[Symbol.asyncIterator]()
  const events: StreamEvent[] = []
  // The role chunk carries `content: ''`, which produces no event of its own.
  gate.release(1)
  while (events.length < stopAfter) {
    gate.release(1)
    // oxlint-disable-next-line no-await-in-loop -- a stream is consumed one event at a time
    const step = await iterator.next()
    if (step.done === true) throw new Error('the long fixture ran out of frames')
    events.push(step.value)
  }
  controller.abort()
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- draining the terminal event
    const step = await iterator.next()
    if (step.done === true) break
    events.push(step.value)
  }
  // Frames the reader provably never saw: the abort stranded them behind the gate.
  expect(gate.remaining).toBeGreaterThan(0)
  return { events, net }
}

describe('OpenAIChatProvider request (invariant 8)', () => {
  it('sends exactly the credential it was given, whatever the environment says', async () => {
    for (const env of [{}, DECOY_ENV]) {
      // oxlint-disable-next-line no-await-in-loop -- process.env is global: one case at a time
      await withCredentialEnv(env, async () => {
        const { net } = await run(sse(fixture.PLAIN_TEXT_FRAMES))
        const headers = net.requests[0]?.headers ?? {}
        // The credential is exactly the one passed in, even against an OPENAI_CUSTOM_HEADERS line
        // that sets `Authorization`: the SDK merges that variable into `defaultHeaders`, and
        // `defaultHeaders` is applied AFTER the authentication header, so pinning it there is what
        // keeps the environment from replacing it.
        expect(headers.authorization).toBe(`Bearer ${API_KEY}`)
        // The tenant headers default to OPENAI_ORG_ID / OPENAI_PROJECT_ID unless pinned to null.
        expect(headers['openai-organization']).toBeUndefined()
        expect(headers['openai-project']).toBeUndefined()
        // No credential the environment offered travels anywhere.
        for (const [name, value] of Object.entries(headers)) {
          if (name === 'x-decoy') continue
          expect(value).not.toContain('decoy')
        }
        // The residual, pinned rather than hidden: a NON-credential OPENAI_CUSTOM_HEADERS line
        // still reaches the wire. Only the keys this adapter sets explicitly can win, and deciding
        // which other header names the kernel allows is the spec's open question 1 (the same
        // decision as the `x-stainless-*` headers). Whoever closes it should see this line fail.
        expect(headers['x-decoy']).toBe(env === DECOY_ENV ? 'decoy' : undefined)
        // The baseURL too: OPENAI_BASE_URL must not be able to redirect the request.
        expect(net.requests[0]?.url).toBe(`${BASE_URL}chat/completions`)
      })
    }
  })

  it('sends the encoded body byte for byte: what was hashed is what goes out', async () => {
    const request = encodedRequest()
    const net = fakeNetwork(sse(fixture.PLAIN_TEXT_FRAMES))
    await collect(providerOf(net).stream(request, CONTEXT))
    const recorded = net.requests[0]
    expect(recorded?.method).toBe('POST')
    // The bytes, not a parse and an order-insensitive compare: promptHash covers
    // canonicalJson(body), and this is the assertion that breaks if a later SDK reorders,
    // re-encodes or augments the payload on its way out.
    expect(recorded?.bodyText).toBe(JSON.stringify(request.body))
    const body = recorded?.body as Record<string, unknown> | undefined
    expect(body?.stream).toBe(true)
    // The usage opt-in this model declares, in the hashed body rather than added by stream().
    expect(body?.stream_options).toEqual({ include_usage: true })
  })

  it('sends a pasted credential and base URL without the whitespace around them', async () => {
    // Both values are typed by a user (step 14's settings card), so a pasted key arrives with a
    // trailing newline and a pasted URL with spaces. Untrimmed, `Bearer ␣key` reads as a wrong key
    // and `…/v1␣␣/chat/completions` as a dead gateway — and neither is visible in the setting.
    const net = fakeNetwork(sse(fixture.PLAIN_TEXT_FRAMES))
    await collect(
      providerOf(net, {
        apiKey: `  ${API_KEY}\n`,
        baseURL: '  http://localhost:11434/v1  ',
      }).stream(encodedRequest(), CONTEXT),
    )
    expect(net.requests[0]?.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(net.requests[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`)
  })

  it('joins the path onto a base URL with or without its trailing slash', async () => {
    const net = fakeNetwork(sse(fixture.PLAIN_TEXT_FRAMES))
    await collect(
      providerOf(net, { baseURL: 'http://localhost:11434/v1' }).stream(encodedRequest(), CONTEXT),
    )
    expect(net.requests[0]?.url).toBe('http://localhost:11434/v1/chat/completions')
  })
})

/** Runs `body` with the credential variables set to `values` and nothing else, then restores. */
async function withCredentialEnv(
  values: Readonly<Record<string, string>>,
  body: () => Promise<void>,
): Promise<void> {
  const saved = new Map(CREDENTIAL_ENV.map((name) => [name, process.env[name]]))
  for (const name of CREDENTIAL_ENV) {
    const value = values[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    await body()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
