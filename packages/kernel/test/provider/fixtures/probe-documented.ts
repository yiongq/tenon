/**
 * 按文档、未实测 — custom-vendor fixtures for the probe and the model list (M6 验收 13, 17, 24, 29, 30),
 * each written from the vendor's own documentation and never compared with a live stream. Where a
 * vendor page is silent on a detail, the frame takes the OpenAI chat-completions chunk shape and the
 * comment says so; ids, texts and token counts are invented. Whoever first probes one of these
 * vendors live should diff a real stream against its fixture and record what differs.
 *
 * Sources (read through the M6 vendor survey, 2026-10-02):
 * - DeepSeek: https://api-docs.deepseek.com/api/create-chat-completion,
 *   https://api-docs.deepseek.com/guides/thinking_mode, https://api-docs.deepseek.com/api/list-models
 * - MiniMax: https://platform.minimax.io/docs/api-reference/text-chat-openai.md
 * - Kimi (国内 and 国际 share the docs): https://platform.kimi.com/docs/api/chat,
 *   https://platform.kimi.com/docs/guide/utilize-the-streaming-output-feature-of-kimi-api,
 *   https://platform.kimi.com/docs/guide/use-thinking-models,
 *   https://platform.kimi.com/docs/guide/use-kimi-api-to-complete-tool-calls
 * - Alibaba Bailian: https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions,
 *   https://help.aliyun.com/zh/model-studio/qwen-function-calling,
 *   https://help.aliyun.com/zh/model-studio/error-code
 * - Volcengine Ark: https://www.volcengine.com/docs/82379/2636748
 * - OpenRouter: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens,
 *   https://openrouter.ai/docs/api_reference/streaming
 * - Gemini (OpenAI compatibility): https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
 * - Anthropic Messages streaming, as a compatible endpoint serves it:
 *   https://docs.anthropic.com/en/api/messages-streaming,
 *   https://api-docs.deepseek.com/guides/anthropic_api,
 *   https://help.aliyun.com/zh/model-studio/anthropic-api-messages
 * - DeepSeek's model list: https://api-docs.deepseek.com/api/list-models (context_window,
 *   max_output_tokens)
 *
 * One frame per array entry, as fakeNetwork replays them.
 */

/** The call every ① fixture makes: the probe's own prompt asks for exactly this one. */
export const PROBE_PATH_ARGS = '{"file_path":"/tenon-probe/ping.txt"}'

const DONE = 'data: [DONE]\n\n'

function data(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

const USAGE = {
  prompt_tokens: 640,
  completion_tokens: 42,
  total_tokens: 682,
  completion_tokens_details: { reasoning_tokens: 17 },
}

// -------------------------------------------------------------------------------------------------
// DeepSeek (passes): the delta holds only content, reasoning_content, role and tool_calls; content is
// null beside the reasoning; the closing chunk's role is null; with include_usage every other chunk
// says `usage: null` and the last one before [DONE] carries the usage.
// -------------------------------------------------------------------------------------------------

export const DEEPSEEK_MODEL = 'deepseek-flash'
export const DEEPSEEK_REASONING = 'The user wants the file read; I will call Read.'

function deepseek(delta: unknown, finish: string | null = null, usage: unknown = null): string {
  return data({
    id: 'a1b2c3d4-0000-4000-8000-deepseek0001',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: DEEPSEEK_MODEL,
    system_fingerprint: 'fp_probe_fixture',
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    usage,
  })
}

export const DEEPSEEK_CALL_FRAMES: readonly string[] = [
  deepseek({ role: 'assistant', content: null, reasoning_content: '' }),
  deepseek({ content: null, reasoning_content: DEEPSEEK_REASONING }),
  deepseek({
    tool_calls: [
      {
        index: 0,
        id: 'call_00_probeFixture',
        type: 'function',
        function: { name: 'Read', arguments: '' },
      },
    ],
  }),
  deepseek({ tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] }),
  deepseek({ tool_calls: [{ index: 0, function: { arguments: '"/tenon-probe/ping.txt"}' } }] }),
  deepseek({ content: '', role: null }, 'tool_calls', USAGE),
  DONE,
]

export const DEEPSEEK_ANSWER_FRAMES: readonly string[] = [
  deepseek({ role: 'assistant', content: null, reasoning_content: '' }),
  deepseek({ content: null, reasoning_content: 'It returned ok.' }),
  deepseek({ content: 'The file said ok.', reasoning_content: null }),
  deepseek({ content: '', role: null }, 'stop', USAGE),
  DONE,
]

// -------------------------------------------------------------------------------------------------
// MiniMax, openai-chat wire (passes): every frame's delta carries the participant `name: "MiniMax
// AI"` and an empty `audio_content`. The reference's chunk schema shows no tool_calls; the calls
// below follow the OpenAI index protocol MiniMax's own provider verifier expects. With include_usage
// the usage arrives in the final chunk.
// -------------------------------------------------------------------------------------------------

export const MINIMAX_MODEL = 'MiniMax-M3'

function minimax(delta: Record<string, unknown>, finish: string | null = null): string {
  return data({
    id: '0603b2c1probefixture',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: MINIMAX_MODEL,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', name: 'MiniMax AI', audio_content: '', ...delta },
        finish_reason: finish,
      },
    ],
  })
}

function minimaxUsage(): string {
  return data({
    id: '0603b2c1probefixture',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: MINIMAX_MODEL,
    choices: [],
    usage: { total_tokens: 682, prompt_tokens: 640, completion_tokens: 42 },
  })
}

export const MINIMAX_CALL_FRAMES: readonly string[] = [
  minimax({ content: 'Reading the file.' }),
  minimax({
    tool_calls: [
      {
        index: 0,
        id: 'call_function_probe_1',
        type: 'function',
        function: { name: 'Read', arguments: PROBE_PATH_ARGS },
      },
    ],
  }),
  minimax({}, 'tool_calls'),
  minimaxUsage(),
  DONE,
]

export const MINIMAX_ANSWER_FRAMES: readonly string[] = [
  minimax({ content: 'It said ok.' }),
  minimax({}, 'stop'),
  minimaxUsage(),
  DONE,
]

// -------------------------------------------------------------------------------------------------
// Alibaba Bailian (passes; 验收 13): reasoning in reasoning_content; the function name in the first
// tool chunk and `id: ''` on the later ones (one documented sample); usage ONLY in a final chunk with
// empty choices, and only because include_usage was sent.
// -------------------------------------------------------------------------------------------------

export const BAILIAN_MODEL = 'qwen-plus'

function bailian(delta: unknown, finish: string | null = null): string {
  return data({
    choices: [{ delta, index: 0, logprobs: null, finish_reason: finish }],
    object: 'chat.completion.chunk',
    usage: null,
    created: 1_791_000_000,
    system_fingerprint: null,
    model: BAILIAN_MODEL,
    id: 'chatcmpl-probe-fixture',
  })
}

function bailianUsage(): string {
  return data({
    choices: [],
    object: 'chat.completion.chunk',
    usage: { prompt_tokens: 640, completion_tokens: 42, total_tokens: 682 },
    created: 1_791_000_000,
    system_fingerprint: null,
    model: BAILIAN_MODEL,
    id: 'chatcmpl-probe-fixture',
  })
}

export const BAILIAN_CALL_FRAMES: readonly string[] = [
  bailian({ content: null, role: 'assistant', reasoning_content: 'I should read it.' }),
  bailian({
    content: null,
    tool_calls: [
      {
        index: 0,
        id: 'call_probe_bailian',
        type: 'function',
        function: { name: 'Read', arguments: '' },
      },
    ],
  }),
  bailian({
    content: null,
    tool_calls: [{ index: 0, id: '', type: 'function', function: { arguments: PROBE_PATH_ARGS } }],
  }),
  bailian({ content: '' }, 'tool_calls'),
  bailianUsage(),
  DONE,
]

export const BAILIAN_ANSWER_FRAMES: readonly string[] = [
  bailian({ content: null, role: 'assistant', reasoning_content: 'Got ok.' }),
  bailian({ content: 'It said ok.' }),
  bailian({ content: '' }, 'stop'),
  bailianUsage(),
  DONE,
]

/**
 * Bailian's TPM throttling (Throttling.AllocationQuota): a 429 whose code is `insufficient_quota`,
 * which the shared vocabulary reads as a permanent `invalid-request` (T11's known limit, 验收 24).
 */
export const BAILIAN_THROTTLED = {
  status: 429,
  body: {
    error: {
      code: 'insufficient_quota',
      param: null,
      message: 'Allocated quota exceeded, please increase your quota limit.',
      type: 'insufficient_quota',
    },
  },
} as const

// -------------------------------------------------------------------------------------------------
// Kimi (passes; openai-chat, the preset's wire): `reasoning_content` comes before `content`, and
// `content` before `tool_calls`; a call's id, type and function.name ride on its first fragment only;
// the finish chunk carries a non-standard choice-level `choices[0].usage`, and with include_usage a
// last chunk with empty choices carries the top-level usage. `max_tokens` is deprecated, not refused,
// so ① goes through under it. Where the pages are silent (`role` on the first delta, `object`,
// `created`) the OpenAI chunk shape is taken.
// -------------------------------------------------------------------------------------------------

export const KIMI_MODEL = 'kimi-k3'
export const KIMI_REASONING = 'The user asks for one file; I will call Read.'

const KIMI_USAGE = { prompt_tokens: 640, completion_tokens: 42, total_tokens: 682 }

function kimi(delta: unknown, finish: string | null = null, usage?: unknown): string {
  return data({
    id: 'chatcmpl-probe-fixture-kimi',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: KIMI_MODEL,
    choices: [
      { index: 0, delta, finish_reason: finish, ...(usage === undefined ? {} : { usage }) },
    ],
  })
}

/** The include_usage chunk: empty choices, the request's usage at the top level. */
export const KIMI_USAGE_FRAME = data({
  id: 'chatcmpl-probe-fixture-kimi',
  object: 'chat.completion.chunk',
  created: 1_791_000_000,
  model: KIMI_MODEL,
  choices: [],
  usage: KIMI_USAGE,
})

export const KIMI_CALL_FRAMES: readonly string[] = [
  kimi({ role: 'assistant', reasoning_content: KIMI_REASONING }),
  kimi({ content: 'Reading the file.' }),
  kimi({
    tool_calls: [
      {
        index: 0,
        id: 'call_probe_kimi',
        type: 'function',
        function: { name: 'Read', arguments: '' },
      },
    ],
  }),
  kimi({ tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] }),
  kimi({ tool_calls: [{ index: 0, function: { arguments: '"/tenon-probe/ping.txt"}' } }] }),
  kimi({}, 'tool_calls', KIMI_USAGE),
  KIMI_USAGE_FRAME,
  DONE,
]

export const KIMI_ANSWER_FRAMES: readonly string[] = [
  kimi({ role: 'assistant', reasoning_content: 'The tool returned ok.' }),
  kimi({ content: 'The file said ok.' }),
  kimi({}, 'stop', KIMI_USAGE),
  KIMI_USAGE_FRAME,
  DONE,
]

// -------------------------------------------------------------------------------------------------
// The three fields the openai-chat wire cannot send back (验收 17, Q14). Each fails the probe as
// `opaque-fields` and names the key.
// -------------------------------------------------------------------------------------------------

/** Volcengine Ark doubao-seed 2.1: the real chain in a message-level `encrypted_content` chunk. */
export const ARK_ENCRYPTED_FRAMES: readonly string[] = [
  data({
    id: 'ark-probe-fixture',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: 'doubao-seed-2-1',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', reasoning_content: 'Summary.' },
        finish_reason: null,
      },
    ],
  }),
  data({
    id: 'ark-probe-fixture',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: 'doubao-seed-2-1',
    choices: [
      {
        index: 0,
        delta: { content: '', reasoning_content: '', encrypted_content: 'gAAAAABoPaqueChain==' },
        finish_reason: null,
      },
    ],
  }),
  data({
    id: 'ark-probe-fixture',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: 'doubao-seed-2-1',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_ark_probe',
              type: 'function',
              function: { name: 'Read', arguments: PROBE_PATH_ARGS },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  }),
  data({
    id: 'ark-probe-fixture',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: 'doubao-seed-2-1',
    choices: [],
    usage: USAGE,
  }),
  DONE,
]

/** OpenRouter reasoning models: `reasoning_details` beside `reasoning` on the delta. */
export const OPENROUTER_DETAILS_FRAMES: readonly string[] = [
  ': OPENROUTER PROCESSING\n\n',
  data({
    id: 'gen-probe-fixture',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: 'anthropic/claude-sonnet-5',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: '',
          reasoning: 'Reading it.',
          reasoning_details: [
            {
              type: 'reasoning.text',
              text: 'Reading it.',
              signature: 'c2lnbmF0dXJl',
              id: 'rs_probe',
              format: 'anthropic-claude-v1',
              index: 0,
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }),
  data({
    id: 'gen-probe-fixture',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: 'anthropic/claude-sonnet-5',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'toolu_probe',
              type: 'function',
              function: { name: 'Read', arguments: PROBE_PATH_ARGS },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: USAGE,
  }),
  DONE,
]

/**
 * Gemini 3 through the OpenAI compatibility layer: the signature on the tool call as
 * `extra_content.google.thought_signature`; the call whole in one chunk, with no `index`, and the
 * turn ending on `stop` (as reported for the compat endpoint).
 */
export const GEMINI_EXTRA_CONTENT_FRAMES: readonly string[] = [
  data({
    id: 'gemini-probe-fixture',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: 'gemini-3.6-flash',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'function-call-probe',
              type: 'function',
              function: { name: 'Read', arguments: PROBE_PATH_ARGS },
              extra_content: { google: { thought_signature: 'U2lnbmF0dXJlQQ==' } },
            },
          ],
        },
        finish_reason: 'stop',
      },
    ],
    usage: USAGE,
  }),
  DONE,
]

// -------------------------------------------------------------------------------------------------
// Anthropic Messages, as a compatible endpoint streams it: a signed thinking block, then the call.
// Bailian's Anthropic path documents the signature as always empty (the second shape).
// -------------------------------------------------------------------------------------------------

export const ANTHROPIC_SIGNATURE = 'c2lnbmVkLXRoaW5raW5nLWZpeHR1cmU='
export const ANTHROPIC_THINKING = 'I will read the file.'

function event(name: string, body: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`
}

function messageStart(model: string): string {
  return event('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_probe_fixture',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 640, output_tokens: 1 },
    },
  })
}

function messageEnd(stopReason: string): readonly string[] {
  return [
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: 640, output_tokens: 42 },
    }),
    event('message_stop', { type: 'message_stop' }),
  ]
}

/**
 * ① on the anthropic-messages wire, the thinking block signed with `signature`. The
 * `signature_delta` is sent even when `signature` is '': Bailian's Anthropic endpoint documents
 * both the block's signature and its `signature_delta` as an empty string.
 */
export function anthropicCallFrames(model: string, signature: string): readonly string[] {
  return [
    messageStart(model),
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }),
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: ANTHROPIC_THINKING },
    }),
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature },
    }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_probe_fixture', name: 'Read', input: {} },
    }),
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: PROBE_PATH_ARGS },
    }),
    event('content_block_stop', { type: 'content_block_stop', index: 1 }),
    ...messageEnd('tool_use'),
  ]
}

/** ② on the anthropic-messages wire: one sentence, then `end_turn`. */
export function anthropicAnswerFrames(model: string): readonly string[] {
  return [
    messageStart(model),
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'It said ok.' },
    }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ...messageEnd('end_turn'),
  ]
}

// -------------------------------------------------------------------------------------------------
// GET /models bodies (§列表与上限): each vendor's own limit keys.
// -------------------------------------------------------------------------------------------------

/** DeepSeek's rich list: `context_window` and `max_output_tokens` beside the id. */
export const DEEPSEEK_MODELS_BODY = {
  object: 'list',
  data: [
    {
      id: 'deepseek-flash',
      object: 'model',
      owned_by: 'deepseek',
      name: 'DeepSeek V4.1 Flash',
      context_window: 1_048_576,
      max_output_tokens: 393_216,
    },
    {
      id: 'deepseek-v4-pro',
      object: 'model',
      owned_by: 'deepseek',
      context_window: 1_048_576,
      max_output_tokens: 393_216,
    },
  ],
} as const
