/**
 * OpenAI-compatible chat-completions streaming fixtures — for the wire itself and for the two
 * vendors that deviate from it in opposite directions (zhipu's `reasoning_content`, ollama's
 * `reasoning` plus a whole tool call in one chunk).
 *
 * NOT RECORDED FROM A LIVE ENDPOINT. The spec asks for recorded SSE, but this run may not touch
 * real credentials or call a provider, so every frame below is hand-built from the vendors'
 * documented streaming format: one `data:` line carrying the chunk object, a terminating blank
 * line, and the `data: [DONE]` sentinel that ends the stream. The field names and the order
 * (role → content → finish_reason → trailing usage chunk) come from
 * https://docs.bigmodel.cn/api-reference/模型-api/对话补全 and https://docs.ollama.com/openai; the
 * numbers and ids are invented. Whoever first runs `pnpm test:live` should diff one real stream
 * against these and record what differs.
 *
 * One frame per array entry, because that is how fakeNetwork's StreamGate releases them: a frame
 * boundary is the unit an abort test can stop at.
 */

/** Token counts every fixture reports, so an assertion can name them instead of a literal. */
export const PROMPT_TOKENS = 31
export const COMPLETION_TOKENS = 57
export const CACHED_TOKENS = 12
export const CACHE_WRITE_TOKENS = 5
export const REASONING_TOKENS = 23

export const TOOL_ID = 'call_0ZqK9wTest1'
export const TOOL_NAME = 'read_file'
export const SECOND_TOOL_ID = 'call_0ZqK9wTest2'
export const SECOND_TOOL_NAME = 'list_dir'

/** The model id the fixtures claim to come from: the one `openAIModel()` uses. */
const MODEL_ID = 'glm-test'

function frame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

/** The sentinel that ends every stream on this wire. */
const DONE = 'data: [DONE]\n\n'

function chunk(delta: unknown, finishReason: string | null = null): string {
  return frame({
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    created: 1_774_000_000,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
}

function usageObject(reasoning = false): unknown {
  return {
    prompt_tokens: PROMPT_TOKENS,
    completion_tokens: COMPLETION_TOKENS,
    total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
    prompt_tokens_details: {
      cached_tokens: CACHED_TOKENS,
      cache_write_tokens: CACHE_WRITE_TOKENS,
    },
    ...(reasoning ? { completion_tokens_details: { reasoning_tokens: REASONING_TOKENS } } : {}),
  }
}

/**
 * The trailing chunk `stream_options.include_usage` buys: empty `choices`, and it arrives AFTER the
 * finish reason. It is the reason the adapter holds its `stop` back to the end of the iterator.
 */
function usageChunk(reasoning = false): string {
  return frame({
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    created: 1_774_000_000,
    model: MODEL_ID,
    choices: [],
    usage: usageObject(reasoning),
  })
}

/** The wire opens a turn with the role and an empty string; neither is content. */
const ROLE_CHUNK = chunk({ role: 'assistant', content: '' })

export const PLAIN_TEXT = ['Hello', ', world'] as const

/** The simplest complete turn, with the usage in its own trailing chunk. */
export const PLAIN_TEXT_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({ content: PLAIN_TEXT[0] }),
  chunk({ content: PLAIN_TEXT[1] }),
  chunk({}, 'stop'),
  usageChunk(),
  DONE,
]

export const STOP_REASON_TEXT = 'ok'

/** The shortest complete turn, with the finish reason as a parameter. */
export function finishReasonFrames(finishReason: string): readonly string[] {
  return [
    ROLE_CHUNK,
    chunk({ content: STOP_REASON_TEXT }),
    chunk({}, finishReason),
    usageChunk(),
    DONE,
  ]
}

export const REASONING_TEXT = ['Let me ', 'check the file.'] as const
export const REASONING_ANSWER = 'It is a TypeScript module.'

/**
 * zhipu: `reasoning_content` first, then the answer. Two blocks, in arrival order.
 *
 * The usage rides on the finish-reason chunk rather than in a trailing empty-`choices` one, because
 * the trailing chunk is what `stream_options.include_usage` buys and zhipu's reference documents no
 * such parameter (see the `usageNeedsOptIn` note on its ModelInfo rows): it lists `usage` as a field
 * of the chunk and says nothing about which chunk. That placement is therefore a GUESS, and the
 * narrower one — whoever diffs a real zhipu stream against this file should record which it is. The
 * trailing shape is exercised by the ollama fixture, whose `include_usage` support is documented.
 */
export const REASONING_CONTENT_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({ reasoning_content: REASONING_TEXT[0] }),
  chunk({ reasoning_content: REASONING_TEXT[1] }),
  chunk({ content: REASONING_ANSWER }),
  frame({
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    created: 1_774_000_000,
    model: MODEL_ID,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: usageObject(true),
  }),
  DONE,
]

/**
 * zhipu again, on an endpoint that reports usage ONLY when the request opted in — the other reading
 * of the same open question. Nothing here is a usage chunk, which is what a `usageNeedsOptIn: false`
 * model would then record.
 */
export const NO_USAGE_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({ content: REASONING_ANSWER }),
  chunk({}, 'stop'),
  DONE,
]

export const TOOL_INPUT = { path: '/tmp/a.ts' }
export const SECOND_TOOL_INPUT = { path: '/tmp/b.ts' }
/** Split mid-token, the way an endpoint that streams arguments splits them. */
export const TOOL_ARGS_FRAGMENTS = ['{"path"', ': "/tmp/a.ts"}'] as const

/**
 * ollama: the thinking field is spelled `reasoning`, and the whole tool call — id, name and every
 * argument — arrives in ONE chunk.
 */
export const OLLAMA_WHOLE_CALL_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({ reasoning: REASONING_TEXT[0] }),
  chunk({
    tool_calls: [
      {
        index: 0,
        id: TOOL_ID,
        type: 'function',
        function: { name: TOOL_NAME, arguments: JSON.stringify(TOOL_INPUT) },
      },
    ],
  }),
  chunk({}, 'tool_calls'),
  usageChunk(),
  DONE,
]

export const TOOL_PREAMBLE = 'Reading it now.'

/**
 * Text, then one tool call whose arguments arrive in fragments: the shape acceptance 1 drives
 * through every definition, so that one set of assertions covers every wire.
 */
export const TEXT_THEN_TOOL_CALL_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({ content: TOOL_PREAMBLE }),
  chunk({
    tool_calls: [{ index: 0, id: TOOL_ID, type: 'function', function: { name: TOOL_NAME } }],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: TOOL_ARGS_FRAGMENTS[0] } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: TOOL_ARGS_FRAGMENTS[1] } }] }),
  chunk({}, 'tool_calls'),
  usageChunk(),
  DONE,
]

/**
 * The out-of-order shape invariant 4 exists for: the arguments start arriving before the chunk that
 * reveals the call's id and name. The adapter must release nothing for that index until its
 * `tool-call-start`.
 */
export const ARGS_BEFORE_ID_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({ tool_calls: [{ index: 0, function: { arguments: TOOL_ARGS_FRAGMENTS[0] } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: TOOL_ARGS_FRAGMENTS[1] } }] }),
  chunk({ tool_calls: [{ index: 0, id: TOOL_ID, function: { name: TOOL_NAME } }] }),
  chunk({}, 'tool_calls'),
  usageChunk(),
  DONE,
]

/**
 * Two complete calls that BOTH arrive under `index: 0` — what ollama's OpenAI-compatible endpoint
 * sends for a model on its legacy tool parser (ollama/ollama#15457, #15497). The ids are what tells
 * them apart; keyed on the index alone, the second call's arguments would be appended to the first's
 * and neither would survive.
 */
export const REUSED_INDEX_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({
    tool_calls: [
      {
        index: 0,
        id: TOOL_ID,
        type: 'function',
        function: { name: TOOL_NAME, arguments: JSON.stringify(TOOL_INPUT) },
      },
    ],
  }),
  chunk({
    tool_calls: [
      {
        index: 0,
        id: SECOND_TOOL_ID,
        type: 'function',
        function: { name: SECOND_TOOL_NAME, arguments: JSON.stringify(SECOND_TOOL_INPUT) },
      },
    ],
  }),
  chunk({}, 'tool_calls'),
  usageChunk(),
  DONE,
]

/**
 * A call whose `arguments` is an OBJECT rather than this wire's JSON string — ollama's native API
 * states it that way and no relay is obliged to stringify it. It is not an EMPTY argument set, so
 * the call must not become a runnable one with `input: {}`.
 */
export const OBJECT_TOOL_ARGS_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({
    tool_calls: [
      {
        index: 0,
        id: TOOL_ID,
        type: 'function',
        function: { name: TOOL_NAME, arguments: TOOL_INPUT },
      },
    ],
  }),
  chunk({}, 'tool_calls'),
  usageChunk(),
  DONE,
]

/**
 * Two complete calls whose `index` is a STRING. A gateway that JSON-encodes the field must not
 * collapse them onto one slot.
 */
export const STRING_INDEX_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({
    tool_calls: [
      {
        index: '0',
        id: TOOL_ID,
        type: 'function',
        function: { name: TOOL_NAME, arguments: JSON.stringify(TOOL_INPUT) },
      },
    ],
  }),
  chunk({
    tool_calls: [
      {
        index: '1',
        id: SECOND_TOOL_ID,
        type: 'function',
        function: { name: SECOND_TOOL_NAME, arguments: JSON.stringify(SECOND_TOOL_INPUT) },
      },
    ],
  }),
  chunk({}, 'tool_calls'),
  usageChunk(),
  DONE,
]

/** An `index` that is neither a number nor a number's spelling: nothing may be placed for it. */
export const UNREADABLE_INDEX_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({
    tool_calls: [
      {
        index: { nested: true },
        id: TOOL_ID,
        type: 'function',
        function: { name: TOOL_NAME, arguments: JSON.stringify(TOOL_INPUT) },
      },
    ],
  }),
  chunk({}, 'tool_calls'),
  usageChunk(),
  DONE,
]

/**
 * Two calls in one turn, interleaved by `index`. The second takes no arguments — the empty input of
 * invariant 6 — and this wire expresses that by sending no argument fragment at all.
 */
export const PARALLEL_TOOL_CALLS_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({
    tool_calls: [{ index: 0, id: TOOL_ID, type: 'function', function: { name: TOOL_NAME } }],
  }),
  chunk({
    tool_calls: [
      {
        index: 1,
        id: SECOND_TOOL_ID,
        type: 'function',
        function: { name: SECOND_TOOL_NAME, arguments: '' },
      },
    ],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: TOOL_ARGS_FRAGMENTS[0] } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: TOOL_ARGS_FRAGMENTS[1] } }] }),
  chunk({}, 'tool_calls'),
  usageChunk(),
  DONE,
]

/**
 * A tool call cut off by the output limit: the arguments stop mid-JSON and the turn ends with
 * `finish_reason: 'length'`, so invariant 5 must keep the call from ever materialising.
 */
export const TRUNCATED_TOOL_CALL_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({ content: TOOL_PREAMBLE }),
  chunk({
    tool_calls: [{ index: 0, id: TOOL_ID, type: 'function', function: { name: TOOL_NAME } }],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
  chunk({}, 'length'),
  usageChunk(),
  DONE,
]

/**
 * A call whose fragments never form a JSON object even though the turn ended normally. Nothing on
 * this wire proves a call was complete, so it is dropped exactly like a truncated one.
 */
export const MALFORMED_TOOL_ARGS_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({
    tool_calls: [
      {
        index: 0,
        id: TOOL_ID,
        type: 'function',
        function: { name: TOOL_NAME, arguments: 'not json' },
      },
    ],
  }),
  chunk({}, 'tool_calls'),
  usageChunk(),
  DONE,
]

/** A vendor that puts the usage on the same chunk as the finish reason instead of after it. */
export const USAGE_WITH_FINISH_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({ content: PLAIN_TEXT[0] }),
  frame({
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    created: 1_774_000_000,
    model: MODEL_ID,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: usageObject(),
  }),
  DONE,
]

/** A body that reached `[DONE]` without ever stating a finish reason: a truncated turn. */
export const NO_FINISH_REASON_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({ content: PLAIN_TEXT[0] }),
  DONE,
]

/**
 * A vendor that states the usage EARLY — zhipu documents usage as a field of the streaming chunk
 * rather than as a trailing `stream_options` chunk — followed by two text chunks. It exists so a test
 * can drop the connection after the first delta with a usage reading already consumed: a turn that was
 * billed and then broke must not be recorded as a free one.
 */
export const USAGE_BEFORE_TEXT_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  usageChunk(),
  chunk({ content: PLAIN_TEXT[0] }),
  chunk({ content: PLAIN_TEXT[1] }),
  chunk({}, 'stop'),
  DONE,
]

export const MID_STREAM_TEXT = 'Working on '
export const MID_STREAM_ERROR_CODE = 'server_error'
export const MID_STREAM_ERROR_MESSAGE = 'upstream failed mid-stream'

/**
 * An error object inside a 200 response. The SDK throws an APIError with `status` undefined, its
 * `code` / `type` taken from the object and the still-streaming response's own `Headers` attached;
 * there is no `[DONE]`.
 */
export const MID_STREAM_ERROR_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({ content: MID_STREAM_TEXT }),
  frame({ error: { code: MID_STREAM_ERROR_CODE, message: MID_STREAM_ERROR_MESSAGE } }),
]

/**
 * The same failure, but after the vendor already stated the usage: a turn that was billed and then
 * broke. The tokens must not be lost with the stop that the error replaces.
 */
export const ERROR_AFTER_USAGE_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  chunk({ content: MID_STREAM_TEXT }),
  chunk({}, 'stop'),
  usageChunk(),
  frame({ error: { code: MID_STREAM_ERROR_CODE, message: MID_STREAM_ERROR_MESSAGE } }),
]

/** How many text deltas the long stream carries: more than the abort test needs. */
const LONG_DELTA_COUNT = 12

/**
 * A long single-text stream for the abort test, generated deterministically (no randomness anywhere
 * in these fixtures). Every frame after the role chunk produces exactly one normalised event.
 */
export const LONG_TEXT_DELTAS: readonly string[] = Array.from(
  { length: LONG_DELTA_COUNT },
  (_unused, index) => `chunk-${index} `,
)

export const LONG_TEXT_FRAMES: readonly string[] = [
  ROLE_CHUNK,
  ...LONG_TEXT_DELTAS.map((text) => chunk({ content: text })),
  chunk({}, 'stop'),
  usageChunk(),
  DONE,
]

/** An HTTP error response, as a fakeNetwork `json` exchange minus its `kind`. */
export interface HttpErrorFixture {
  readonly status: number
  readonly body: unknown
  readonly headers?: Readonly<Record<string, string>>
}

function errorBody(code: string, message: string, type = 'invalid_request_error'): unknown {
  return { error: { code, message, type, param: null } }
}

export const UNAUTHORIZED: HttpErrorFixture = {
  status: 401,
  body: errorBody('invalid_api_key', 'Incorrect API key provided', 'invalid_request_error'),
}

export const RETRY_AFTER_SECONDS = 20

export const RATE_LIMITED: HttpErrorFixture = {
  status: 429,
  body: errorBody('rate_limit_exceeded', 'Rate limit reached for requests', 'rate_limit_error'),
  headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) },
}

export const SERVER_ERROR: HttpErrorFixture = {
  status: 500,
  body: errorBody('server_error', 'The server had an error', 'server_error'),
}

export const CONTEXT_TOO_LONG: HttpErrorFixture = {
  status: 400,
  body: errorBody(
    'context_length_exceeded',
    "This model's maximum context length is 200000 tokens",
    'invalid_request_error',
  ),
}

/**
 * zhipu's two numeric codes whose HTTP status says something else, from
 * https://docs.bigmodel.cn/cn/faq/api-code (read 2026-09-21), in that page's own body shape —
 * `{"error": {"code": "1113", "message": …}}`, with `code` a JSON STRING.
 *
 * 1113 is 欠费 at **429**: the status alone reads as a retryable rate limit, and resending would
 * continue until a human topped the account up. 1261 is Prompt 超长 at 400, whose message no English
 * context-overflow regex matches.
 */
export const OUT_OF_CREDIT: HttpErrorFixture = {
  status: 429,
  body: { error: { code: '1113', message: '您的账户已欠费，请充值后重试' } },
  headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) },
}

export const PROMPT_TOO_LONG: HttpErrorFixture = {
  status: 400,
  body: { error: { code: '1261', message: 'Prompt 超长' } },
}

/**
 * A code this vocabulary does not know, stated as a NUMBER — not a documented shape but what a
 * non-conforming gateway relaying a numeric-code vendor produces. It must read as an ordinary
 * invalid request with the code kept, stringified.
 */
export const UNKNOWN_NUMERIC_CODE: HttpErrorFixture = {
  status: 400,
  body: { error: { code: 9999, message: '未知错误' } },
}

/** OpenAI's own out-of-credit answer: a 429 whose `code` names a permanent condition. */
export const INSUFFICIENT_QUOTA: HttpErrorFixture = {
  status: 429,
  body: errorBody(
    'insufficient_quota',
    'You exceeded your current quota, please check your plan and billing details',
    'insufficient_quota',
  ),
}
