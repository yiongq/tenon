/**
 * Zhipu (open.bigmodel.cn/api/paas/v4) as a custom vendor's openai-chat instance — the probe's pass
 * fixture for the vendor the M6 live acceptance runs (验收 17, 28).
 *
 * The SHAPE follows the stream recorded live on 2026-09-22 (glm-4.6 on the same endpoint; spec 01
 * plan, live run record): every delta repeats `role`, `reasoning_content` comes before `content`,
 * the finish-reason chunk's delta carries a `content` key, the usage rides on that same chunk with no
 * opt-in, and the stream ends on `[DONE]` with no `event:` lines. That stream was text only, so the
 * tool-call chunk is 按文档、未实测: a whole call in one chunk, which is what the vendor sends without
 * `tool_stream` (an instance sends no request parameters, Q9), with `content: null` beside it
 * (https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool,
 * https://docs.bigmodel.cn/api-reference/模型-api/对话补全). Ids, texts and token counts are invented.
 *
 * 智谱国际站 (api.z.ai/api/paas/v4, a preset) has no fixture of its own: its docs give the same
 * `reasoning_content` on the delta, the same finish reasons and no per-call opaque field as
 * bigmodel's (https://docs.z.ai/api-reference/llm/chat-completion,
 * https://docs.z.ai/guides/capabilities/thinking-mode), so these frames stand for it too, and for
 * it they are 按文档、未实测: no z.ai stream has been recorded.
 */

export const ZHIPU_MODEL = 'glm-5.3-flashx'
export const ZHIPU_REASONING = ['The user wants ', 'the file read.'] as const

const DONE = 'data: [DONE]\n\n'

function chunk(delta: Record<string, unknown>, finish?: string, usage?: unknown): string {
  return `data: ${JSON.stringify({
    id: '2026100212000000probe',
    created: 1_791_000_000,
    model: ZHIPU_MODEL,
    choices: [
      {
        index: 0,
        ...(finish === undefined ? {} : { finish_reason: finish }),
        delta: { role: 'assistant', ...delta },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  })}\n\n`
}

const USAGE = {
  prompt_tokens: 702,
  completion_tokens: 38,
  total_tokens: 740,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 21 },
}

/** ①: thinks, then calls Read once. */
export const ZHIPU_CALL_FRAMES: readonly string[] = [
  chunk({ reasoning_content: ZHIPU_REASONING[0] }),
  chunk({ reasoning_content: ZHIPU_REASONING[1] }),
  chunk({
    content: null,
    tool_calls: [
      {
        index: 0,
        id: 'call_-8126418316409712345',
        type: 'function',
        function: { name: 'Read', arguments: '{"file_path":"/tenon-probe/ping.txt"}' },
      },
    ],
  }),
  chunk({ content: '' }, 'tool_calls', USAGE),
  DONE,
]

/** ②: thinks about the result, answers in one sentence, ends on `stop`. */
export const ZHIPU_ANSWER_FRAMES: readonly string[] = [
  chunk({ reasoning_content: 'The tool returned ok.' }),
  chunk({ content: 'The file said ' }),
  chunk({ content: 'ok.' }),
  chunk({ content: '' }, 'stop', USAGE),
  DONE,
]
