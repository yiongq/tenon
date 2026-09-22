/**
 * Anthropic Messages streaming fixtures.
 *
 * NOT RECORDED FROM A LIVE ENDPOINT. The spec asks for recorded SSE, but this run may not touch
 * real credentials or call a provider, so every frame below is hand-built from Anthropic's
 * documented streaming wire format: one `event:` line, one `data:` line carrying the documented
 * event object, a terminating blank line, and the `ping` events the API interleaves. The event
 * names, the object shapes and the order (message_start → content_block_* → message_delta →
 * message_stop) are the documented ones; the numbers and ids are invented. Whoever first runs
 * `pnpm test:live` against the real endpoint should diff one real stream against these and record
 * what differs.
 *
 * One frame per array entry, because that is how fakeNetwork's StreamGate releases them: a frame
 * boundary is the unit an abort test can stop at.
 *
 * Fields the adapter never reads are left out even where the pinned SDK's types declare them
 * (`citations`, `container`, `stop_details`, `service_tier`, `cache_creation`…). `caller` is the
 * exception and is spelled out: it decides who executes a tool call, so both of its shapes are
 * fixtures of their own.
 */

/** Token counts every fixture reports, so an assertion can name them instead of a literal. */
export const INPUT_TOKENS = 25
export const START_OUTPUT_TOKENS = 1
export const OUTPUT_TOKENS = 42
export const CACHE_WRITE_TOKENS = 4
export const CACHE_READ_TOKENS = 12
export const THINKING_TOKENS = 17

/** The base64 alphabet appears in it on purpose: every assertion on it is byte equality. */
export const THINKING_SIGNATURE = 'EroBCkgIBBABGAIiQFTd9/C6m1lQ=='
export const REDACTED_DATA = 'RURBQ1RFRF9USElOS0lORw=='

export const TOOL_ID = 'toolu_01A09q90qw90lq917835lq9'
export const TOOL_NAME = 'read_file'
export const SECOND_TOOL_ID = 'toolu_01B29q90qw90lq917835lq8'
export const SECOND_TOOL_NAME = 'list_dir'

/** The model id the fixtures claim to come from: the one `anthropicModel()` uses. */
const MODEL_ID = 'claude-test-4'

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** The API sends these to keep the connection alive; the SDK drops them. */
const PING = frame('ping', { type: 'ping' })

function messageStart(): string {
  return frame('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_01Fixture',
      type: 'message',
      role: 'assistant',
      model: MODEL_ID,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: INPUT_TOKENS,
        output_tokens: START_OUTPUT_TOKENS,
        cache_creation_input_tokens: CACHE_WRITE_TOKENS,
        cache_read_input_tokens: CACHE_READ_TOKENS,
      },
    },
  })
}

function blockStart(index: number, contentBlock: unknown): string {
  return frame('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: contentBlock,
  })
}

function blockDelta(index: number, delta: unknown): string {
  return frame('content_block_delta', { type: 'content_block_delta', index, delta })
}

function blockStop(index: number): string {
  return frame('content_block_stop', { type: 'content_block_stop', index })
}

/** `reasoning` adds the thinking-token breakdown the API only sends when it thought. */
function messageDelta(stopReason: string | null, reasoning = false): string {
  return messageDeltaUsage(stopReason, {
    input_tokens: INPUT_TOKENS,
    output_tokens: OUTPUT_TOKENS,
    cache_creation_input_tokens: CACHE_WRITE_TOKENS,
    cache_read_input_tokens: CACHE_READ_TOKENS,
    ...(reasoning ? { output_tokens_details: { thinking_tokens: THINKING_TOKENS } } : {}),
  })
}

/** A `message_delta` whose usage object is given verbatim, for the shapes the SDK types allow. */
function messageDeltaUsage(stopReason: string | null, usage: unknown): string {
  return frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  })
}

const MESSAGE_STOP = frame('message_stop', { type: 'message_stop' })

const TEXT_START = { type: 'text', text: '' }

/** `caller: { type: 'direct' }` is the model asking US to run the call — the only shape phase 1 runs. */
function toolStart(id: string, name: string, caller: unknown = { type: 'direct' }): unknown {
  return { type: 'tool_use', id, name, input: {}, caller }
}

export const PLAIN_TEXT = ['Hello', ', world'] as const

/** The simplest complete turn. */
export const PLAIN_TEXT_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, TEXT_START),
  PING,
  blockDelta(0, { type: 'text_delta', text: PLAIN_TEXT[0] }),
  blockDelta(0, { type: 'text_delta', text: PLAIN_TEXT[1] }),
  blockStop(0),
  messageDelta('end_turn'),
  MESSAGE_STOP,
]

export const STOP_REASON_TEXT = 'ok'

/**
 * The shortest complete turn, with the stop reason as a parameter — `null` is the shape the wire
 * allows when it ends a turn without saying why, and an unknown string is what a newer API version
 * looks like to this pinned SDK.
 */
export function stopReasonFrames(stopReason: string | null): readonly string[] {
  return [
    messageStart(),
    blockStart(0, TEXT_START),
    blockDelta(0, { type: 'text_delta', text: STOP_REASON_TEXT }),
    blockStop(0),
    messageDelta(stopReason),
    MESSAGE_STOP,
  ]
}

export const THINKING_TEXT = ['Let me ', 'check the file.'] as const
export const THINKING_ANSWER = 'It is a TypeScript module.'

/** Thinking with its signature, then the answer: two blocks, two slots. */
export const THINKING_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
  blockDelta(0, { type: 'thinking_delta', thinking: THINKING_TEXT[0] }),
  blockDelta(0, { type: 'thinking_delta', thinking: THINKING_TEXT[1] }),
  blockDelta(0, { type: 'signature_delta', signature: THINKING_SIGNATURE }),
  blockStop(0),
  blockStart(1, TEXT_START),
  blockDelta(1, { type: 'text_delta', text: THINKING_ANSWER }),
  blockStop(1),
  messageDelta('end_turn', true),
  MESSAGE_STOP,
]

export const REDACTED_ANSWER = 'I cannot help with that.'

/** A safety-redacted thinking block: opaque data, no deltas, no signature. */
export const REDACTED_THINKING_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, { type: 'redacted_thinking', data: REDACTED_DATA }),
  blockStop(0),
  blockStart(1, TEXT_START),
  blockDelta(1, { type: 'text_delta', text: REDACTED_ANSWER }),
  blockStop(1),
  messageDelta('end_turn'),
  MESSAGE_STOP,
]

export const TOOL_PREAMBLE = 'Reading it now.'
/** Split across frames exactly the way the wire splits arguments: mid-token. */
export const TOOL_ARGS_FRAGMENTS = ['{"path"', ': "/tmp/a.ts"}'] as const
export const TOOL_INPUT = { path: '/tmp/a.ts' }

/** Text, then one tool call. */
export const ONE_TOOL_CALL_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, TEXT_START),
  blockDelta(0, { type: 'text_delta', text: TOOL_PREAMBLE }),
  blockStop(0),
  blockStart(1, toolStart(TOOL_ID, TOOL_NAME)),
  blockDelta(1, { type: 'input_json_delta', partial_json: TOOL_ARGS_FRAGMENTS[0] }),
  blockDelta(1, { type: 'input_json_delta', partial_json: TOOL_ARGS_FRAGMENTS[1] }),
  blockStop(1),
  messageDelta('tool_use'),
  MESSAGE_STOP,
]

/**
 * Two calls in one turn. The second takes no arguments, which the wire expresses by sending no
 * `input_json_delta` at all — the empty input of invariant 6.
 */
export const TWO_TOOL_CALLS_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, toolStart(TOOL_ID, TOOL_NAME)),
  blockDelta(0, { type: 'input_json_delta', partial_json: TOOL_ARGS_FRAGMENTS[0] }),
  blockDelta(0, { type: 'input_json_delta', partial_json: TOOL_ARGS_FRAGMENTS[1] }),
  blockStop(0),
  blockStart(1, toolStart(SECOND_TOOL_ID, SECOND_TOOL_NAME)),
  blockStop(1),
  messageDelta('tool_use'),
  MESSAGE_STOP,
]

/**
 * A tool call cut off by `max_tokens`: the arguments stop mid-JSON and the block never gets its
 * `content_block_stop`, so invariant 5 must keep the call from ever materialising.
 */
export const TRUNCATED_TOOL_CALL_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, TEXT_START),
  blockDelta(0, { type: 'text_delta', text: TOOL_PREAMBLE }),
  blockStop(0),
  blockStart(1, toolStart(TOOL_ID, TOOL_NAME)),
  blockDelta(1, { type: 'input_json_delta', partial_json: '{"pa' }),
  messageDelta('max_tokens'),
  MESSAGE_STOP,
]

/**
 * A tool call the vendor's own container runs: `caller` names a server-side executor instead of
 * `direct`, so the kernel must not be handed it as a call to make.
 */
export const SERVER_TOOL_CALLER_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, TEXT_START),
  blockDelta(0, { type: 'text_delta', text: TOOL_PREAMBLE }),
  blockStop(0),
  blockStart(
    1,
    toolStart(TOOL_ID, TOOL_NAME, { type: 'code_execution_20250825', tool_id: 'srvtoolu_01' }),
  ),
  blockDelta(1, { type: 'input_json_delta', partial_json: TOOL_ARGS_FRAGMENTS[0] }),
  blockDelta(1, { type: 'input_json_delta', partial_json: TOOL_ARGS_FRAGMENTS[1] }),
  blockStop(1),
  messageDelta('end_turn'),
  MESSAGE_STOP,
]

/**
 * A wire that reuses content-block index 0 for a second tool call. Legal responses do not, but a
 * compatible gateway that renumbers blocks is not a programmer error, so the adapter has to hand
 * the second call its own slot rather than a collision the caller's fold would refuse.
 */
export const REUSED_TOOL_SLOT_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, toolStart(TOOL_ID, TOOL_NAME)),
  blockDelta(0, { type: 'input_json_delta', partial_json: TOOL_ARGS_FRAGMENTS[0] }),
  blockDelta(0, { type: 'input_json_delta', partial_json: TOOL_ARGS_FRAGMENTS[1] }),
  blockStop(0),
  blockStart(0, toolStart(SECOND_TOOL_ID, SECOND_TOOL_NAME)),
  blockStop(0),
  messageDelta('tool_use'),
  MESSAGE_STOP,
]

/** The same slot abused harder: thinking deltas and two signatures on an open text block. */
export const MIXED_KIND_SLOT_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, TEXT_START),
  blockDelta(0, { type: 'text_delta', text: PLAIN_TEXT[0] }),
  blockDelta(0, { type: 'thinking_delta', thinking: THINKING_TEXT[0] }),
  blockDelta(0, { type: 'signature_delta', signature: THINKING_SIGNATURE }),
  blockDelta(0, { type: 'signature_delta', signature: THINKING_SIGNATURE }),
  messageDelta('end_turn'),
  MESSAGE_STOP,
]

/** What the second `message_delta` reading of TWO_MESSAGE_DELTA_FRAMES restates. */
export const MID_TURN_OUTPUT_TOKENS = 10

/**
 * Two `message_delta` frames, the first without a stop reason (the wire allows `null` there).
 * Invariant 1 says the reading written to the Tape is "the final one", singular.
 */
export const TWO_MESSAGE_DELTA_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, TEXT_START),
  blockDelta(0, { type: 'text_delta', text: PLAIN_TEXT[0] }),
  blockStop(0),
  messageDeltaUsage(null, {
    input_tokens: INPUT_TOKENS,
    output_tokens: MID_TURN_OUTPUT_TOKENS,
    cache_creation_input_tokens: CACHE_WRITE_TOKENS,
    cache_read_input_tokens: CACHE_READ_TOKENS,
  }),
  messageDelta('end_turn'),
  MESSAGE_STOP,
]

/** The only field the SDK's `MessageDeltaUsage` type declares non-nullable. */
export const DELTA_ONLY_OUTPUT_TOKENS = 7

/**
 * `message_delta` in its SDK-typed nullable shape: every count but `output_tokens` may be null,
 * and null means "not restated" — both frames report cumulative totals, so the reading that
 * reaches the Tape must keep what `message_start` said rather than report zeros.
 */
export const NULL_DELTA_USAGE_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, TEXT_START),
  blockDelta(0, { type: 'text_delta', text: PLAIN_TEXT[0] }),
  blockStop(0),
  messageDeltaUsage('end_turn', {
    input_tokens: null,
    output_tokens: DELTA_ONLY_OUTPUT_TOKENS,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    output_tokens_details: null,
    server_tool_use: null,
  }),
  MESSAGE_STOP,
]

export const MID_STREAM_TEXT = 'Working on '
export const MID_STREAM_ERROR_TYPE = 'overloaded_error'
export const MID_STREAM_ERROR_MESSAGE = 'Overloaded'

/**
 * An error frame in the middle of a 200 response. The SDK throws an APIError with `status`
 * undefined, its `.type` taken straight from the frame (also readable at `err.error.error.type`)
 * and the still-streaming 200's own `Headers` attached; there is no `message_stop`.
 */
export const MID_STREAM_ERROR_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, TEXT_START),
  blockDelta(0, { type: 'text_delta', text: MID_STREAM_TEXT }),
  frame('error', {
    type: 'error',
    error: { type: MID_STREAM_ERROR_TYPE, message: MID_STREAM_ERROR_MESSAGE },
  }),
]

/** How many text deltas the long stream carries: one more than the abort test needs. */
const LONG_DELTA_COUNT = 240

/**
 * A long single-text-block stream for the abort test, generated deterministically (no
 * randomness anywhere in these fixtures). Every frame after the first two produces exactly one
 * normalised event, which is what lets a test stop at frame N and know what should have arrived.
 */
export const LONG_TEXT_DELTAS: readonly string[] = Array.from(
  { length: LONG_DELTA_COUNT },
  (_unused, index) => `chunk-${index} `,
)

export const LONG_TEXT_FRAMES: readonly string[] = [
  messageStart(),
  blockStart(0, TEXT_START),
  ...LONG_TEXT_DELTAS.map((text) => blockDelta(0, { type: 'text_delta', text })),
  blockStop(0),
  messageDelta('end_turn'),
  MESSAGE_STOP,
]

/** An HTTP error response, as a fakeNetwork `json` exchange minus its `kind`. */
export interface HttpErrorFixture {
  readonly status: number
  readonly body: unknown
  readonly headers?: Readonly<Record<string, string>>
}

function errorBody(type: string, message: string): unknown {
  return { type: 'error', error: { type, message } }
}

export const UNAUTHORIZED: HttpErrorFixture = {
  status: 401,
  body: errorBody('authentication_error', 'invalid x-api-key'),
}

export const RETRY_AFTER_SECONDS = 30

export const RATE_LIMITED_SECONDS: HttpErrorFixture = {
  status: 429,
  body: errorBody('rate_limit_error', 'Number of requests has exceeded your rate limit'),
  headers: { 'retry-after': String(RETRY_AFTER_SECONDS) },
}

export const RETRY_AFTER_EXPLICIT_MS = 1500

/** Both headers present: the millisecond one wins (spec §中止、重试、错误). */
export const RATE_LIMITED_MS: HttpErrorFixture = {
  status: 429,
  body: errorBody('rate_limit_error', 'Number of requests has exceeded your rate limit'),
  headers: { 'retry-after-ms': String(RETRY_AFTER_EXPLICIT_MS), 'retry-after': '9' },
}

export const RETRY_AFTER_HTTP_DATE = 'Wed, 21 Oct 2026 07:28:00 GMT'

export const RATE_LIMITED_HTTP_DATE: HttpErrorFixture = {
  status: 429,
  body: errorBody('rate_limit_error', 'Number of requests has exceeded your rate limit'),
  headers: { 'Retry-After': RETRY_AFTER_HTTP_DATE },
}

export const REQUEST_TIMEOUT: HttpErrorFixture = {
  status: 408,
  body: errorBody('timeout_error', 'request timeout'),
}

export const OVERLOADED: HttpErrorFixture = {
  status: 529,
  body: errorBody('overloaded_error', 'Overloaded'),
}

export const SERVER_ERROR: HttpErrorFixture = {
  status: 500,
  body: errorBody('api_error', 'Internal server error'),
}

export const CONTEXT_TOO_LONG: HttpErrorFixture = {
  status: 400,
  body: errorBody('invalid_request_error', 'prompt is too long: 205000 tokens > 200000 maximum'),
}

export const BAD_REQUEST: HttpErrorFixture = {
  status: 400,
  body: errorBody('invalid_request_error', 'max_tokens: must be greater than 0'),
}
