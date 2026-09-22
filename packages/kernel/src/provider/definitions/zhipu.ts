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
 * Two rows only, and on purpose: each one is a model whose own documentation page was read. The
 * catalogue is larger (GLM-5.2, GLM-5.1, GLM-5-Turbo, GLM-4.7 and the free Flash tiers), and
 * adding a row is data, not code.
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
 * - `thinkingPreservationFormat: 'drop'` is fixed by the spec (open question 2): the vendor
 *   documents `reasoning_content` as display-only and nothing has tested whether it accepts one
 *   back, so a reasoning block from a previous turn is dropped rather than echoed. A `pnpm
 *   test:live` probe is what would change this line.
 * - `requestParams.thinking` is the seam the spec chose for this vendor's non-OpenAI parameter. It
 *   states the vendor's own default (`enabled`), so it changes no behaviour — what it buys is that
 *   `promptHash` covers the statement. Note the consequence: `requestParams` is per MODEL, not per
 *   request, so `ProviderRequest.thinking` cannot turn this off (the attempt snapshot still records
 *   what was asked for). GLM-5.3 could not be turned off anyway — its page says thinking is always
 *   enabled.
 * - `supportsCacheControl: false` everywhere on this wire: the vendor's context caching is
 *   automatic and there is no `cache_control` parameter to place, so there is nothing for a caller
 *   to control.
 * - `usageNeedsOptIn: false`, re-read on 2026-09-21: the chat-completions reference still lists no
 *   `stream_options` parameter at all, while documenting `usage` as a field of the streamed chunk.
 *   The spec's provider table names `include_usage` among the things this vendor was chosen to
 *   exercise, so the two disagree, and the vendor's own documentation is what plan step 11 says to
 *   fill from. Sending an undocumented parameter risks a 400 on EVERY request; being wrong this way
 *   costs the usage of a recorded attempt, which a case in test/provider/definitions.test.ts makes
 *   visible instead of assumed. The `pnpm test:live` probe acceptance 21 already requires settles
 *   it: if that endpoint reports no usage without the opt-in, this line becomes `true`.
 * - `supportsVision: false`: the GLM-5.3 page says it handles text only; vision is a separate
 *   model family (GLM-4.6V / GLM-5.3V), which is a row nobody has read the page for yet.
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
    thinkingPreservationFormat: 'drop',
    usageNeedsOptIn: false,
    requestParams: { thinking: { type: 'enabled' } },
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
    thinkingPreservationFormat: 'drop',
    usageNeedsOptIn: false,
    requestParams: { thinking: { type: 'enabled' } },
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
