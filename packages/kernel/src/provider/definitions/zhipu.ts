/**
 * The `zhipu` provider definition — the spec's second provider, on the OpenAI-compatible wire
 * (spec 01 §内置 provider).
 *
 * Filled on 2026-09-21 from the vendor's own documentation: the model list with context windows and
 * output limits from https://docs.bigmodel.cn/cn/guide/start/model-overview, the capabilities and
 * the `thinking` parameter from the per-model pages
 * (https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3 and .../glm-4.6), and the streamed
 * response fields — `delta.reasoning_content`, `delta.tool_calls` with incremental
 * `function.arguments`, `usage.prompt_tokens_details.cached_tokens` — from the chat-completions
 * reference (https://docs.bigmodel.cn/api-reference/模型-api/对话补全) and
 * https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool.
 *
 * Re-read on 2026-09-26 for spec 02 (§内置模型表的数据改动): the flash pair's one shared page
 * https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash (model codes
 * `glm-5.3-flash/glm-5.3-flashx`, 1M / 128K for both; there is no separate FlashX page), the model
 * overview and the chat-completions reference again, the pricing table
 * https://docs.bigmodel.cn/cn/guide/start/pricing with its landing page
 * https://open.bigmodel.cn/pricing, and the thinking pages
 * https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode and .../thinking. The same day's
 * live probes (TS, R46, V) are recorded in 02 plan.md, step 2.
 *
 * Four rows, each a model whose own documentation page was read. glm-5.3 stays first because the
 * first row is only the fallback for a user who never picked one (02 decision M5), and moving it
 * is not a data change 02 asked for. The catalogue is larger (GLM-5.2, GLM-5.1, GLM-5-Turbo,
 * GLM-4.7 and the free Flash tiers), and adding a row is data, not code.
 */
import type { HostClock, HostNetwork } from '../../host/adapter.js'
import type { ConfigKey, ModelInfo, Provider, ProviderDefinition } from '../types.js'
import { OpenAIChatProvider } from '../wire/openai-chat.js'
import { configuredValue } from '../wire/transport.js'
import { frozenModels } from './models.js'

export const ZHIPU_PROVIDER_ID = 'zhipu'

/** Spec §内置 provider, stored exactly as written; the SDK normalises the trailing slash. */
export const ZHIPU_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4/'

const CONFIG_KEYS: readonly ConfigKey[] = [
  {
    name: 'apiKey',
    // This wire has no anonymous mode and this vendor has no second credential: without a key
    // there is nothing to construct.
    required: true,
    secret: true,
    // No `primary`: the spec's table marks it in exactly one cell (anthropic's `apiKey`, where two
    // credentials compete to be asked for first) and this one has nothing to disambiguate. Adding
    // the flag would be deciding step 14's form order here, which the table did not.
    labelKey: 'provider.zhipu.config.apiKey',
  },
  {
    name: 'baseURL',
    required: true,
    secret: false,
    default: ZHIPU_DEFAULT_BASE_URL,
    labelKey: 'provider.zhipu.config.baseURL',
  },
]

/**
 * The fields that need saying out loud:
 *
 * - `thinkingPreservationFormat: 'reasoning-content'` under `reasoning_content` on every row,
 *   replacing 01's `'drop'` (02 decision A12, closing 01's open question 2): the vendor's
 *   thinking-mode page says interleaved thinking with tools must keep the reasoning and send it
 *   back with the tool results. Probed: T6 (2026-09-25, glm-5.3 and flashx) and R46 (2026-09-26,
 *   glm-4.6) — an echoed `reasoning_content` is accepted, counted in `prompt_tokens` and changes no
 *   answer, and leaving it out is no 400 either. The guard's rule 4 echoes only when the request
 *   carries tools. `clear_thinking` is not sent, so the vendor default holds (`true`: reasoning
 *   from turns before the last user message is stripped server side), although the flash page
 *   recommends `false`. The T6 extension of 2026-09-26 found glm-5.3 counting only the current
 *   turn's echo and flash counting every echoed turn; whether that changes the row (02 plan,
 *   step 2: A, C or D) waits for the owner's bill.
 * - `requestParams.thinking` is the seam the spec chose for this vendor's non-OpenAI parameter. It
 *   states the vendor's own default (`enabled`), so it changes no behaviour — what it buys is that
 *   `promptHash` covers the statement. Note the consequence: `requestParams` is per MODEL, not per
 *   request, so `ProviderRequest.thinking` cannot turn this off (the attempt snapshot still records
 *   what was asked for). The GLM-5.3 family could not be turned off anyway — the vendor says
 *   `disabled` is refused there — and on glm-4.6 `enabled` means the model decides for itself.
 * - `requestParams.tool_stream: true` on every row, probe TS (2026-09-26): with it, a streamed tool
 *   call's `function.arguments` arrived in 5–6 fragments on all four models (without it, in one on
 *   glm-5.3 and glm-4.6), and each joined into parseable JSON, so `supportsStreamingToolCalls`
 *   stays true. A request with no tools and `tool_stream: true` returned 200 / `stop` on all four,
 *   which is what makes a per-model parameter safe on tool-less requests. The reference's text
 *   schema lists GLM-5.3 and GLM-4.6 for it; its vision schema, where the flash pair sits, has no
 *   such property, but the flash page recommends it and the probe is what these rows follow.
 * - `supportsCacheControl: false` everywhere on this wire: the vendor's context caching is
 *   automatic and there is no `cache_control` parameter to place, so there is nothing for a caller
 *   to control.
 * - `usageNeedsOptIn: false` is settled: 01's live record (01 plan.md, acceptance 21, 2026-09-22)
 *   found the usage on the finish-reason chunk with no `stream_options`, and the opt-in accepted
 *   but changing nothing; probe TS (2026-09-26) saw usage on all four rows without it.
 * - `supportsVision`, probe V (2026-09-26): glm-5.3-flash and glm-5.3-flashx each named the colour
 *   of a 64×64 red and a blue PNG sent as a base64 `image_url` part (200), and their page documents
 *   image, video and file input, so both are true. glm-5.3 refused the same request with `400 1210
 *   messages.content.type 参数非法，取值范围 ['text']` and its page says text only; glm-4.6's page
 *   says text only too. Both stay false.
 * - `pricing` is CNY per million tokens at the standard price in the pricing table (2026-09-26).
 *   The three priced rows are flat: one row each, no input-length tier and no time-of-day tier.
 *   There is no `cacheWritePerMTok` because the vendor quotes no write price: its only other cache
 *   charge is storage, per million tokens per HOUR, free for a limited time with the later price
 *   unpublished. glm-4.6 has no per-token price on either pricing page (only a private-instance
 *   rate), so its row has none. The landing page's FAQ claims a limited-time 50% discount on
 *   glm-5.3-flash (0.4 / 1.4, cache hit 0.115) with no dates, and no price card shows it; the bill
 *   decides, and until then the row keeps the standard price.
 */
const MODELS: readonly ModelInfo[] = frozenModels([
  {
    id: 'glm-5.3',
    providerId: ZHIPU_PROVIDER_ID,
    contextLimit: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: false,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'reasoning-content',
    reasoningEchoField: 'reasoning_content',
    usageNeedsOptIn: false,
    pricing: { inputPerMTok: 8, outputPerMTok: 28, cacheReadPerMTok: 2, currency: 'CNY' },
    requestParams: { thinking: { type: 'enabled' }, tool_stream: true },
  },
  {
    // The daily model (02 §模型与密钥).
    id: 'glm-5.3-flash',
    providerId: ZHIPU_PROVIDER_ID,
    contextLimit: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: true,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'reasoning-content',
    reasoningEchoField: 'reasoning_content',
    usageNeedsOptIn: false,
    pricing: { inputPerMTok: 0.8, outputPerMTok: 2.8, cacheReadPerMTok: 0.23, currency: 'CNY' },
    requestParams: { thinking: { type: 'enabled' }, tool_stream: true },
  },
  {
    // The speed tier the live suite runs on (02 §模型与密钥).
    id: 'glm-5.3-flashx',
    providerId: ZHIPU_PROVIDER_ID,
    contextLimit: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: true,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'reasoning-content',
    reasoningEchoField: 'reasoning_content',
    usageNeedsOptIn: false,
    pricing: { inputPerMTok: 2, outputPerMTok: 7, cacheReadPerMTok: 0.57, currency: 'CNY' },
    requestParams: { thinking: { type: 'enabled' }, tool_stream: true },
  },
  {
    id: 'glm-4.6',
    providerId: ZHIPU_PROVIDER_ID,
    contextLimit: 200_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: false,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'reasoning-content',
    reasoningEchoField: 'reasoning_content',
    usageNeedsOptIn: false,
    requestParams: { thinking: { type: 'enabled' }, tool_stream: true },
  },
])

export const zhipuDefinition: ProviderDefinition = {
  id: ZHIPU_PROVIDER_ID,
  nameKey: 'provider.zhipu.name',
  wire: 'openai-chat',
  configKeys: [...CONFIG_KEYS],
  builtinModels: [...MODELS],
  create(args: {
    network: HostNetwork
    clock: Pick<HostClock, 'now'>
    config: Record<string, string>
    secrets: Record<string, string>
  }): Provider {
    return new OpenAIChatProvider({
      id: ZHIPU_PROVIDER_ID,
      network: args.network,
      clock: args.clock,
      // The adapter refuses a missing key, so every provider on this wire fails the same way.
      apiKey: args.secrets['apiKey'] ?? null,
      // Through `configuredValue`, so a field the user CLEARED gets the declared default rather
      // than the "missing config" error: the settings card stores a cleared non-secret field as
      // '', and a key with a default is never missing.
      baseURL: configuredValue(args.config['baseURL']) ?? ZHIPU_DEFAULT_BASE_URL,
      models: MODELS,
    })
  },
}
