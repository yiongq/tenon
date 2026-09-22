/**
 * The Anthropic Messages adapter's stream(): invariants 1-6 per fixture, invariant 8's credential
 * and request-count half, and acceptance 7's provider half (abort at 200 deterministic points).
 *
 * Everything goes through `fakeNetwork`, so no socket is opened and no credential is real. The
 * fixtures are hand-built from the documented wire format — see the header of
 * ../fixtures/anthropic-sse.ts.
 *
 * Acceptance 7's other half — that the run leaves exactly one `provider/attempt_completed` for
 * its `(runId, requestSeq, physicalAttempt)` — belongs to the session service (step 12); nothing
 * here writes to a Tape.
 */
import { describe, expect, it } from 'vitest'
import {
  AnthropicMessagesProvider,
  ProviderConfigMissingError,
  ProviderInvalidArgumentError,
  createBlockAccumulator,
  encodeAnthropicMessages,
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
import * as fixture from '../fixtures/anthropic-sse.js'
import { TOOL, anthropicModel, requestOf } from './fixtures.js'

const PROVIDER_ID = 'anthropic'
const BASE_URL = 'https://api.anthropic.test'
/** Shaped like the real thing so a leak into a header or a `detail` is unmistakable. */
const API_KEY = 'sk-ant-test-key-0123456789'
const AUTH_TOKEN = 'oat-test-token-9876543210'
/** A fixed HostClock reading: the HTTP-date branch of retry-after is relative to it. */
const NOW = Date.parse('2026-09-21T00:00:00.000Z')

const IDENTITY = {
  runId: '00000000-0000-4000-8000-000000000001',
  requestSeq: 1,
  physicalAttempt: 1,
}

const CONTEXT: SendContext = { identity: IDENTITY }

/**
 * Every variable the pinned SDK reads by itself: the three credentials either SDK would pick up
 * from a credential passed as `undefined`, plus the four doors the client opens on its own —
 * ANTHROPIC_CUSTOM_HEADERS is the one that can REPLACE the credential on the wire.
 */
const CREDENTIAL_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_WEBHOOK_SIGNING_KEY',
  'ANTHROPIC_LOG',
] as const

const DECOY_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: 'sk-ant-decoy-must-not-travel',
  ANTHROPIC_AUTH_TOKEN: 'oat-decoy-must-not-travel',
  OPENAI_API_KEY: 'sk-openai-decoy-must-not-travel',
  // Two credential headers and one innocuous one, in the format the SDK parses (one per line).
  ANTHROPIC_CUSTOM_HEADERS:
    'x-api-key: sk-ant-decoy-must-not-travel\nAuthorization: Bearer oat-decoy-must-not-travel',
  ANTHROPIC_BASE_URL: 'https://decoy.invalid',
  ANTHROPIC_WEBHOOK_SIGNING_KEY: 'whsec_decoy-must-not-travel',
  ANTHROPIC_LOG: 'debug',
}

type Options = ConstructorParameters<typeof AnthropicMessagesProvider>[0]

function providerOf(
  network: FakeNetwork,
  overrides: Partial<Options> = {},
): AnthropicMessagesProvider {
  return new AnthropicMessagesProvider({
    id: PROVIDER_ID,
    network,
    clock: { now: () => NOW },
    apiKey: API_KEY,
    authToken: null,
    baseURL: BASE_URL,
    models: [anthropicModel()],
    ...overrides,
  })
}

/** One encoded request, reused: stream() consumes encode()'s output, never a raw request. */
function encodedRequest(): EncodedRequest {
  return encodeAnthropicMessages(
    requestOf(anthropicModel(), { system: 'be brief', tools: [TOOL] }),
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
    inputTokens: fixture.INPUT_TOKENS,
    outputTokens: fixture.OUTPUT_TOKENS,
    cacheReadTokens: fixture.CACHE_READ_TOKENS,
    cacheWriteTokens: fixture.CACHE_WRITE_TOKENS,
    reasoningTokens: 0,
    final: true,
    ...overrides,
  }
}

const START_USAGE: Usage = usage({ outputTokens: fixture.START_OUTPUT_TOKENS, final: false })

function terminalsOf(events: readonly StreamEvent[]): StreamEvent[] {
  return events.filter((event) => event.type === 'stop' || event.type === 'error')
}

/** The block accumulator's view of a stream — what a caller would persist. */
function contentOf(events: readonly StreamEvent[]): ContentBlock[] {
  const blocks = createBlockAccumulator({ provider: PROVIDER_ID, providerModel: 'claude-test-4' })
  for (const event of events) blocks.apply(event)
  return blocks.content()
}

function textOf(events: readonly StreamEvent[]): string {
  return contentOf(events)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

/**
 * The invariants that hold for EVERY stream, whatever the fixture said: exactly one terminal
 * event and it is last (1), no `usage` after it and at most one final reading (1), a
 * `tool-call-start` before any fragment of its index (4), and an object input on every end (6).
 */
function checkStreamInvariants(events: readonly StreamEvent[]): void {
  const terminals = terminalsOf(events)
  expect(terminals).toHaveLength(1)
  // Last, so no usage event can follow it either.
  expect(events.at(-1)).toBe(terminals[0])
  const finalUsage = events.filter((event) => event.type === 'usage' && event.usage.final)
  expect(finalUsage.length).toBeLessThanOrEqual(1)
  // Collected first, asserted once: a fragment whose index never started, and an ended call whose
  // input is not an object.
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

describe('AnthropicMessagesProvider construction', () => {
  it('refuses a provider with neither apiKey nor authToken', () => {
    const net = fakeNetwork([])
    expect(() => providerOf(net, { apiKey: null, authToken: null })).toThrow(
      ProviderConfigMissingError,
    )
    // A blank string is "not configured", not a credential: the SDK builds its credential /
    // config / profile chain when both are null, and that is its only filesystem path.
    expect(() => providerOf(net, { apiKey: '   ', authToken: '' })).toThrow(
      ProviderConfigMissingError,
    )
  })

  it('takes an undefined credential as unconfigured rather than crashing on it', () => {
    // Step 14 reads these out of a Record, and with noUncheckedIndexedAccess that is
    // `string | undefined`: a provider that HAS an authToken must not be refused by a TypeError
    // raised over the credential it does not have.
    const absent = undefined as unknown as string | null
    expect(() =>
      providerOf(fakeNetwork([]), { apiKey: absent, authToken: AUTH_TOKEN }),
    ).not.toThrow()
    expect(() => providerOf(fakeNetwork([]), { apiKey: absent, authToken: absent })).toThrow(
      ProviderConfigMissingError,
    )
  })

  it('refuses a blank baseURL rather than let the SDK read ANTHROPIC_BASE_URL', () => {
    expect(() => providerOf(fakeNetwork([]), { baseURL: '' })).toThrow(ProviderConfigMissingError)
  })

  it('refuses a baseURL that would make every request /v1/v1/messages', () => {
    // The shape every OpenAI-compatible relay documents. The SDK concatenates, so this answers
    // 404 — which reads as a dead gateway or a bad model name rather than as a mistyped setting.
    for (const baseURL of ['https://gw.test/v1', 'https://gw.test/v1/']) {
      expect(() => providerOf(fakeNetwork([]), { baseURL })).toThrow(ProviderInvalidArgumentError)
    }
    expect(() => providerOf(fakeNetwork([]), { baseURL: 'api.anthropic.test' })).toThrow(
      ProviderInvalidArgumentError,
    )
    // A base path that is not /v1 is none of the adapter's business.
    expect(() =>
      providerOf(fakeNetwork([]), { baseURL: 'https://gw.test/anthropic' }),
    ).not.toThrow()
  })

  it('reports the definition models and the thinking tier the model supports', async () => {
    const provider = providerOf(fakeNetwork([]))
    const models = await provider.models()
    expect(models.map((model) => model.id)).toEqual(['claude-test-4'])
    models.pop()
    expect(await provider.models()).toHaveLength(1)
    expect(provider.thinkingEffortSupport(anthropicModel())).toBe('budget')
    // A model that does not reason has no budget to spend, whatever the wire supports.
    expect(provider.thinkingEffortSupport(anthropicModel({ reasoning: false }))).toBe('none')
  })

  it('refuses to stream a request another provider encoded', () => {
    const provider = providerOf(fakeNetwork([]), { id: 'anthropic-gateway' })
    expect(() => provider.stream(encodedRequest(), CONTEXT)).toThrow(ProviderInvalidArgumentError)
  })
})

describe('AnthropicMessagesProvider stream() normalisation', () => {
  it('maps a plain text turn', async () => {
    const { events, net } = await run(sse(fixture.PLAIN_TEXT_FRAMES))
    checkStreamInvariants(events)
    expect(events).toEqual([
      { type: 'usage', usage: START_USAGE },
      { type: 'text-delta', index: 0, text: fixture.PLAIN_TEXT[0] },
      { type: 'text-delta', index: 0, text: fixture.PLAIN_TEXT[1] },
      { type: 'usage', usage: usage() },
      { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
    ])
    expect(net.callCount).toBe(1)
  })

  it('maps thinking, its signature and the answer, and never rewrites the signature', async () => {
    const { events } = await run(sse(fixture.THINKING_FRAMES))
    checkStreamInvariants(events)
    expect(events).toEqual([
      { type: 'usage', usage: START_USAGE },
      { type: 'thinking-delta', index: 0, text: fixture.THINKING_TEXT[0] },
      { type: 'thinking-delta', index: 0, text: fixture.THINKING_TEXT[1] },
      { type: 'thinking-signature', index: 0, signature: fixture.THINKING_SIGNATURE },
      { type: 'text-delta', index: 1, text: fixture.THINKING_ANSWER },
      { type: 'usage', usage: usage({ reasoningTokens: fixture.THINKING_TOKENS }) },
      { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
    ])
    expect(contentOf(events)).toEqual([
      {
        type: 'thinking',
        text: fixture.THINKING_TEXT.join(''),
        signature: fixture.THINKING_SIGNATURE,
        provider: PROVIDER_ID,
        providerModel: 'claude-test-4',
      },
      { type: 'text', text: fixture.THINKING_ANSWER },
    ])
  })

  it('maps a redacted thinking block as opaque data', async () => {
    const { events } = await run(sse(fixture.REDACTED_THINKING_FRAMES))
    checkStreamInvariants(events)
    expect(events).toEqual([
      { type: 'usage', usage: START_USAGE },
      { type: 'redacted-thinking', index: 0, data: fixture.REDACTED_DATA },
      { type: 'text-delta', index: 1, text: fixture.REDACTED_ANSWER },
      { type: 'usage', usage: usage() },
      { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
    ])
  })

  it('maps one tool call, fragments then parsed input', async () => {
    const { events } = await run(sse(fixture.ONE_TOOL_CALL_FRAMES))
    checkStreamInvariants(events)
    expect(events).toEqual([
      { type: 'usage', usage: START_USAGE },
      { type: 'text-delta', index: 0, text: fixture.TOOL_PREAMBLE },
      { type: 'tool-call-start', index: 1, id: fixture.TOOL_ID, name: fixture.TOOL_NAME },
      { type: 'tool-call-args-delta', index: 1, json: fixture.TOOL_ARGS_FRAGMENTS[0] },
      { type: 'tool-call-args-delta', index: 1, json: fixture.TOOL_ARGS_FRAGMENTS[1] },
      {
        type: 'tool-call-end',
        index: 1,
        id: fixture.TOOL_ID,
        name: fixture.TOOL_NAME,
        input: fixture.TOOL_INPUT,
      },
      { type: 'usage', usage: usage() },
      { type: 'stop', reason: 'tool-use', providerReason: 'tool_use' },
    ])
  })

  it('keeps two parallel tool calls apart and sends {} for the one with no arguments', async () => {
    const { events } = await run(sse(fixture.TWO_TOOL_CALLS_FRAMES))
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
    // Invariant 6 again, on the value itself: `{}`, never null and never the string '{}'.
    expect(ends[1]?.type === 'tool-call-end' ? ends[1].input : null).toEqual({})
  })

  it('never ends a tool call max_tokens truncated (invariant 5)', async () => {
    const { events } = await run(sse(fixture.TRUNCATED_TOOL_CALL_FRAMES))
    checkStreamInvariants(events)
    expect(events.filter((event) => event.type === 'tool-call-end')).toEqual([])
    expect(events.at(-1)).toEqual({
      type: 'stop',
      reason: 'max-tokens',
      providerReason: 'max_tokens',
    })
    // The truncated call must not reach the transcript either: only the text survives.
    expect(contentOf(events)).toEqual([{ type: 'text', text: fixture.TOOL_PREAMBLE }])
  })

  it('completes on message_delta without parking on the frames behind it', async () => {
    const gate = createStreamGate()
    const net = fakeNetwork({ kind: 'sse', frames: fixture.PLAIN_TEXT_FRAMES, gate })
    // Everything except the trailing `message_stop`, and no `gate.end()`: the stop reason arrives
    // with `message_delta`, so the adapter must not wait for a body the vendor has finished with.
    // (plan.md, step 2: both SDKs keep reading after their end-of-stream frame, which is why a
    // gated happy path otherwise hangs until the vitest timeout.)
    gate.release(fixture.PLAIN_TEXT_FRAMES.length - 1)
    const events = await collect(providerOf(net).stream(encodedRequest(), CONTEXT))
    checkStreamInvariants(events)
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end-turn', providerReason: 'end_turn' })
    expect(gate.remaining).toBe(1)
  })

  it('maps every stop reason the pinned SDK knows, and keeps the raw value', async () => {
    const expected: readonly (readonly [string | null, StopReason])[] = [
      ['end_turn', 'end-turn'],
      ['max_tokens', 'max-tokens'],
      ['stop_sequence', 'stop-sequence'],
      ['tool_use', 'tool-use'],
      ['pause_turn', 'pause-turn'],
      ['refusal', 'refusal'],
      ['model_context_window_exceeded', 'context-overflow'],
      // A reason a later API version adds: reported as unknown with the raw value kept.
      ['some_future_reason', 'unknown'],
      // The wire allows a turn to end without saying why; guessing `end-turn` would let the
      // phase 2 loop treat it as a completed turn.
      [null, 'unknown'],
    ]
    for (const [raw, reason] of expected) {
      // oxlint-disable-next-line no-await-in-loop -- one stream per stop reason, in order
      const { events } = await run(sse(fixture.stopReasonFrames(raw)))
      checkStreamInvariants(events)
      expect(events.at(-1)).toEqual({ type: 'stop', reason, providerReason: raw })
    }
  })

  it('never hands over a tool call the vendor runs itself', async () => {
    const { events } = await run(sse(fixture.SERVER_TOOL_CALLER_FRAMES))
    checkStreamInvariants(events)
    // `caller` names a server-side executor: forwarding it would give the kernel's tool executor
    // a call the model never asked us to make. The text of the turn still arrives.
    expect(events.filter((event) => event.type.startsWith('tool-call'))).toEqual([])
    expect(textOf(events)).toBe(fixture.TOOL_PREAMBLE)
  })

  it('gives a reused content-block index its own slot instead of a collision', async () => {
    const { events } = await run(sse(fixture.REUSED_TOOL_SLOT_FRAMES))
    checkStreamInvariants(events)
    const ends = events.filter((event) => event.type === 'tool-call-end')
    // Two calls arrived at vendor index 0; they are two slots here, so both survive the fold.
    expect(ends.map((event) => (event.type === 'tool-call-end' ? event.index : -1))).toEqual([0, 1])
    expect(contentOf(events)).toEqual([
      {
        type: 'tool-request',
        id: fixture.TOOL_ID,
        name: fixture.TOOL_NAME,
        input: fixture.TOOL_INPUT,
      },
      {
        type: 'tool-request',
        id: fixture.SECOND_TOOL_ID,
        name: fixture.SECOND_TOOL_NAME,
        input: {},
      },
    ])
  })

  it('completes a turn whose wire mixed two block kinds in one index', async () => {
    // complete() is the spec's default path, and the fold it uses throws on a slot that holds two
    // kinds — an endpoint renumbering its blocks is not a programmer error, so the turn must still
    // end in a terminal event rather than a rejection.
    const provider = providerOf(fakeNetwork(sse(fixture.MIXED_KIND_SLOT_FRAMES)))
    const result = await provider.complete(
      requestOf(anthropicModel(), { system: 'be brief', tools: [TOOL] }),
      CONTEXT,
    )
    expect(result.error).toBeNull()
    expect(result.stop).toEqual({ reason: 'end-turn', providerReason: 'end_turn' })
    expect(result.message.content).toEqual([
      { type: 'text', text: fixture.PLAIN_TEXT[0] },
      {
        type: 'thinking',
        text: fixture.THINKING_TEXT[0],
        signature: fixture.THINKING_SIGNATURE,
        provider: PROVIDER_ID,
        providerModel: 'claude-test-4',
      },
      // The second signature is not rewritten onto the block that already has one: it opens a
      // slot of its own, which is what keeps invariant 7 out of the fold's way.
      {
        type: 'thinking',
        text: '',
        signature: fixture.THINKING_SIGNATURE,
        provider: PROVIDER_ID,
        providerModel: 'claude-test-4',
      },
    ])
  })

  it('marks only the reading that came with a stop reason as final', async () => {
    const { events } = await run(sse(fixture.TWO_MESSAGE_DELTA_FRAMES))
    checkStreamInvariants(events)
    const readings = events.filter((event) => event.type === 'usage')
    // Three readings, exactly one final — a `message_delta` without a stop reason did not end the
    // turn, and invariant 1 writes "the final one", singular, to the Tape.
    expect(
      readings.map((event) =>
        event.type === 'usage' ? [event.usage.outputTokens, event.usage.final] : [],
      ),
    ).toEqual([
      [fixture.START_OUTPUT_TOKENS, false],
      [fixture.MID_TURN_OUTPUT_TOKENS, false],
      [fixture.OUTPUT_TOKENS, true],
    ])
  })

  it('keeps what message_start stated for a count the final reading left null', async () => {
    const { events } = await run(sse(fixture.NULL_DELTA_USAGE_FRAMES))
    checkStreamInvariants(events)
    const final = events.filter((event) => event.type === 'usage' && event.usage.final)
    expect(final).toEqual([
      {
        type: 'usage',
        usage: usage({
          // Not restated by the delta frame, and both frames are cumulative: null means "no new
          // statement", not zero. A fact saying 0 input tokens for this turn would be false.
          inputTokens: fixture.INPUT_TOKENS,
          cacheReadTokens: fixture.CACHE_READ_TOKENS,
          cacheWriteTokens: fixture.CACHE_WRITE_TOKENS,
          outputTokens: fixture.DELTA_ONLY_OUTPUT_TOKENS,
        }),
      },
    ])
  })

  it('turns a mid-stream error frame into the terminal error event (invariant 3)', async () => {
    const { events } = await run(sse(fixture.MID_STREAM_ERROR_FRAMES))
    checkStreamInvariants(events)
    expect(events.slice(0, 2)).toEqual([
      { type: 'usage', usage: START_USAGE },
      { type: 'text-delta', index: 0, text: fixture.MID_STREAM_TEXT },
    ])
    const terminal = events.at(-1)
    expect(terminal?.type).toBe('error')
    if (terminal?.type !== 'error') throw new Error('unreachable')
    expect(terminal.code).toBe('overloaded')
    expect(terminal.retryable).toBe(true)
    expect(terminal.providerCode).toBe(fixture.MID_STREAM_ERROR_TYPE)
    // The frame carries no HTTP status, which is how a mid-stream error tells itself apart.
    expect('status' in terminal).toBe(false)
    expect(terminal.detail).toContain(fixture.MID_STREAM_ERROR_MESSAGE)
    // The partial text is kept: an error is not an excuse to lose what arrived.
    expect(textOf(events)).toBe(fixture.MID_STREAM_TEXT)
  })
})

interface ErrorCase {
  readonly name: string
  readonly fixture: fixture.HttpErrorFixture
  readonly code: ProviderErrorCode
  readonly retryable: boolean
  readonly providerCode: string
  readonly retryAfterMs?: number
  /** A clock reading other than NOW, for the HTTP-date branch. */
  readonly now?: number
}

const HTTP_DATE_MS = Date.parse(fixture.RETRY_AFTER_HTTP_DATE)

const ERROR_CASES: readonly ErrorCase[] = [
  {
    name: '401',
    fixture: fixture.UNAUTHORIZED,
    code: 'auth',
    retryable: false,
    providerCode: 'authentication_error',
  },
  {
    name: '429 with retry-after seconds',
    fixture: fixture.RATE_LIMITED_SECONDS,
    code: 'rate-limit',
    retryable: true,
    providerCode: 'rate_limit_error',
    retryAfterMs: fixture.RETRY_AFTER_SECONDS * 1000,
  },
  {
    name: '429 with retry-after-ms winning over retry-after',
    fixture: fixture.RATE_LIMITED_MS,
    code: 'rate-limit',
    retryable: true,
    providerCode: 'rate_limit_error',
    retryAfterMs: fixture.RETRY_AFTER_EXPLICIT_MS,
  },
  {
    name: '429 with an HTTP-date retry-after',
    fixture: fixture.RATE_LIMITED_HTTP_DATE,
    code: 'rate-limit',
    retryable: true,
    providerCode: 'rate_limit_error',
    retryAfterMs: 45_000,
    now: HTTP_DATE_MS - 45_000,
  },
  {
    name: '529',
    fixture: fixture.OVERLOADED,
    code: 'overloaded',
    retryable: true,
    providerCode: 'overloaded_error',
  },
  {
    name: '500',
    fixture: fixture.SERVER_ERROR,
    code: 'server',
    retryable: true,
    providerCode: 'api_error',
  },
  {
    name: '400 about a too-long prompt',
    fixture: fixture.CONTEXT_TOO_LONG,
    code: 'context-overflow',
    retryable: false,
    providerCode: 'invalid_request_error',
  },
  {
    name: '400 about anything else',
    fixture: fixture.BAD_REQUEST,
    code: 'invalid-request',
    retryable: false,
    providerCode: 'invalid_request_error',
  },
  {
    // The vendor's own `timeout_error` reads as a retryable `server` when it arrives with no
    // status; gaining a status must not turn the same transient failure into a permanent one.
    name: '408 about a timeout',
    fixture: fixture.REQUEST_TIMEOUT,
    code: 'server',
    retryable: true,
    providerCode: 'timeout_error',
  },
]

describe('AnthropicMessagesProvider stream() error mapping', () => {
  for (const testCase of ERROR_CASES) {
    it(`maps ${testCase.name}`, async () => {
      const exchange: FakeExchange = {
        kind: 'json',
        status: testCase.fixture.status,
        body: testCase.fixture.body,
        ...(testCase.fixture.headers === undefined ? {} : { headers: testCase.fixture.headers }),
      }
      const overrides =
        testCase.now === undefined ? {} : { clock: { now: () => testCase.now as number } }
      const { events, net } = await run(exchange, overrides)
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
    // Two messages, one of them phrased the way the SDK's own timeout heuristic looks for: it
    // string-matches the rejection AND its cause for /timed? ?out/i and then throws an
    // APIConnectionTimeoutError that carries no cause at all, which would lose the denial and
    // have the phase 2 loop resend a request the host's egress policy refused.
    for (const message of [
      'host policy refused api.anthropic',
      'host policy refused api.anthropic: the connection timed out first',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one stream per denial shape, in order
      const { events } = await run({ kind: 'denied', message })
      checkStreamInvariants(events)
      const terminal = events[0]
      if (terminal?.type !== 'error') throw new Error('expected a single error event')
      expect(terminal.code).toBe('egress-denied')
      expect(terminal.retryable).toBe(false)
      // The denial arrives below the SDK's connection error, so the mapper has to walk the chain —
      // and HostNetworkDeniedError's `name` is still 'Error'.
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
    // The SDK wraps a rejected fetch in APIConnectionError only on the connect path: a failure
    // raised while READING the body is rethrown verbatim, so the commonest transient streaming
    // failure arrives as a bare TypeError / errno Error. Unmarked it would classify as `unknown` —
    // never retried — while the same connection dropping on a frame boundary is the retryable
    // `network` error the case above asserts. One physical event, one verdict, on both wires.
    for (const error of [
      Object.assign(new TypeError('terminated'), { cause: new Error('closed') }),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    ]) {
      const gate = createStreamGate()
      const net = fakeNetwork({ kind: 'sse', frames: fixture.PLAIN_TEXT_FRAMES, gate })
      const iterator = providerOf(net).stream(encodedRequest(), CONTEXT)[Symbol.asyncIterator]()
      // message_start (one usage event), content_block_start, ping, one text delta.
      gate.release(4)
      const events: StreamEvent[] = []
      for (let pulled = 0; pulled < 2; pulled += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a stream is consumed one event at a time
        const step = await iterator.next()
        if (step.done === true) throw new Error('the fixture ran out of frames')
        events.push(step.value)
      }
      gate.fail(error)
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- draining the terminal event
        const step = await iterator.next()
        if (step.done === true) break
        events.push(step.value)
      }
      checkStreamInvariants(events)
      const terminal = events.at(-1)
      if (terminal?.type !== 'error') throw new Error('expected a terminal error event')
      expect(terminal.code).toBe('network')
      expect(terminal.retryable).toBe(true)
      // What arrived is kept, opening usage reading included.
      expect(textOf(events)).toBe(fixture.PLAIN_TEXT[0])
      expect(events.filter((event) => event.type === 'usage')).toHaveLength(1)
    }
  })

  it('never redacts less than the whole credential out of detail', async () => {
    // The SDK puts the response body's message in the error message, so a server that echoed
    // the key back is the realistic leak this guards.
    const { events } = await run({
      kind: 'json',
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: `bad ${API_KEY}` } },
    })
    const terminal = events[0]
    if (terminal?.type !== 'error') throw new Error('expected a single error event')
    expect(terminal.detail).not.toContain(API_KEY)
    expect(terminal.detail).toContain('[redacted]')
  })

  it('redacts before it truncates, so a key straddling the cap leaves no prefix', async () => {
    // A gateway that echoes a long request into its error message is the realistic case. The
    // padding is swept in steps shorter than the key, so at least one of these puts the key
    // across `detail`'s 500-character cap whatever the SDK prefixes the vendor message with — and
    // a surviving prefix of a key is still a key in a log.
    for (let padding = 350; padding <= 470; padding += 10) {
      // oxlint-disable-next-line no-await-in-loop -- one stream per padding, in order
      const { events } = await run({
        kind: 'json',
        status: 400,
        body: {
          type: 'error',
          error: { type: 'invalid_request_error', message: `${'p'.repeat(padding)}${API_KEY}` },
        },
      })
      const terminal = events[0]
      if (terminal?.type !== 'error') throw new Error('expected a single error event')
      expect(terminal.detail).not.toContain(API_KEY)
      // Not even the first characters of it: the occurrence was replaced before the cap ran.
      expect(terminal.detail).not.toContain(API_KEY.slice(0, 10))
    }
  })

  it('does not advertise an adapter bug as a retryable network failure', async () => {
    // A `message_start` frame with no usage object at all: whatever goes wrong in this adapter's
    // own normalisation, `unknown` (never retryable) is the honest answer — `network` would have
    // the phase 2 loop resend a request nothing was wrong with.
    const { events } = await run(sse([BROKEN_MESSAGE_START]))
    checkStreamInvariants(events)
    const terminal = events.at(-1)
    if (terminal?.type !== 'error') throw new Error('expected a terminal error event')
    expect(terminal.retryable).toBe(false)
    expect(terminal.code).not.toBe('network')
  })
})

/** A frame the documented wire never sends: `message_start` with no `message` at all. */
const BROKEN_MESSAGE_START = 'event: message_start\ndata: {"type":"message_start"}\n\n'

describe('AnthropicMessagesProvider abort (acceptance 7, provider half)', () => {
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

  it('aborts cleanly at 200 distinct points, keeping exactly the text that arrived', async () => {
    for (let stopAfter = 1; stopAfter <= 200; stopAfter += 1) {
      // Each point drives its own stream to its own frame boundary, so they are sequential.
      // oxlint-disable-next-line no-await-in-loop -- one abort point at a time, on purpose
      const { events, net } = await abortAfter(stopAfter)
      expect(terminalsOf(events)).toEqual([
        { type: 'stop', reason: 'aborted', providerReason: null },
      ])
      expect(events.at(-1)?.type).toBe('stop')
      expect(events).toHaveLength(stopAfter + 1)
      // Event 1 is the message_start usage reading; the rest are text deltas, one per frame.
      expect(textOf(events)).toBe(fixture.LONG_TEXT_DELTAS.slice(0, stopAfter - 1).join(''))
      expect(net.callCount).toBe(1)
    }
  }, 60_000)
})

/**
 * Consumes exactly `stopAfter` events off a gated long stream, releasing one frame per event, and
 * then aborts. Deterministic by construction: no timers, no randomness, and every frame after the
 * first two produces exactly one normalised event.
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
  // message_start (one usage event) and content_block_start (no event of its own).
  gate.release(2)
  while (events.length < stopAfter) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is consumed one event at a time
    const step = await iterator.next()
    if (step.done === true) throw new Error('the long fixture ran out of frames')
    events.push(step.value)
    if (events.length < stopAfter) gate.release(1)
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

describe('AnthropicMessagesProvider request (invariant 8)', () => {
  it('sends exactly the credentials it was given, whatever the environment says', async () => {
    // Both directions, under a decoy env: key-only must carry no `authorization`, token-only no
    // `x-api-key`. What this holds up is the adapter's `defaultHeaders` pin — delete that block and
    // the decoy key travels. It does NOT hold up the explicit `null` constructor arguments: the pin
    // wins over the SDK's env fallback either way, so `apiKey ?? undefined` is invisible from here
    // and from anywhere else on the wire (see the note in anthropic-messages.ts).
    for (const env of [{}, DECOY_ENV]) {
      // oxlint-disable-next-line no-await-in-loop -- process.env is global: one case at a time
      await withCredentialEnv(env, async () => {
        const byKey = await run(sse(fixture.PLAIN_TEXT_FRAMES))
        const keyHeaders = headersOf(byKey.net)
        expect(keyHeaders['x-api-key']).toBe(API_KEY)
        expect(keyHeaders.authorization).toBeUndefined()
        // The baseURL too: ANTHROPIC_BASE_URL must not be able to redirect the request.
        expect(byKey.net.requests[0]?.url).toBe(`${BASE_URL}/v1/messages`)

        const byToken = await run(sse(fixture.PLAIN_TEXT_FRAMES), {
          apiKey: null,
          authToken: AUTH_TOKEN,
        })
        const tokenHeaders = headersOf(byToken.net)
        expect(tokenHeaders.authorization).toBe(`Bearer ${AUTH_TOKEN}`)
        expect(tokenHeaders['x-api-key']).toBeUndefined()

        // Nothing from the environment reached the wire, under either credential — including the
        // ANTHROPIC_CUSTOM_HEADERS lines, which the SDK merges into its own default headers and
        // which would otherwise overwrite the credential this adapter passed.
        for (const headers of [keyHeaders, tokenHeaders]) {
          expect(JSON.stringify(headers)).not.toContain('decoy')
        }
      })
    }
  })

  it('sends the encoded body byte for byte: what was hashed is what goes out', async () => {
    const request = encodedRequest()
    const net = fakeNetwork(sse(fixture.PLAIN_TEXT_FRAMES))
    await collect(providerOf(net).stream(request, CONTEXT))
    const recorded = net.requests[0]
    expect(recorded?.method).toBe('POST')
    expect(recorded?.url).toBe(`${BASE_URL}/v1/messages`)
    // The bytes, not a parse and an order-insensitive compare: promptHash covers
    // canonicalJson(body), and this is the assertion that breaks if a later SDK reorders,
    // re-encodes or augments the payload on its way out.
    expect(recorded?.bodyText).toBe(JSON.stringify(request.body))
    expect((recorded?.body as Record<string, unknown> | undefined)?.stream).toBe(true)
  })

  it('appends /v1/messages to whatever base path the gateway lives under', async () => {
    const net = fakeNetwork(sse(fixture.PLAIN_TEXT_FRAMES))
    // A trailing slash is collapsed by the SDK, and a base path is kept: pinned here because the
    // /v1 refusal below only makes sense against the concatenation the SDK actually performs.
    await collect(
      providerOf(net, { baseURL: 'https://gw.test/anthropic/' }).stream(encodedRequest(), CONTEXT),
    )
    expect(net.requests[0]?.url).toBe('https://gw.test/anthropic/v1/messages')
  })
})

function headersOf(net: FakeNetwork): Readonly<Record<string, string>> {
  return net.requests[0]?.headers ?? {}
}

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
