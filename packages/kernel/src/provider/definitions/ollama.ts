/**
 * The `ollama` provider definition — the spec's third provider, and the one that deviates from the
 * OpenAI wire in a DIFFERENT direction from zhipu (spec 01 §内置 provider): no `tool_choice`,
 * `reasoning` for the thinking field in both directions, and a tool call delivered whole.
 *
 * Filled on 2026-09-21 from https://docs.ollama.com/openai (the supported parameter list: `tools`
 * yes, `tool_choice` no, `stream_options.include_usage` yes with usage reported only when it is
 * set, `reasoning` / `reasoning_effort` for thinking models, the `http://localhost:11434/v1/` base
 * URL and "an API key is required but ignored"), https://docs.ollama.com/faq (the server's default
 * context window) and https://ollama.com/library/qwen3 (the model's tags and its tool + thinking
 * support). Read on 2026-09-26 for spec 02: https://docs.ollama.com/context-length (the basis of
 * `contextLimit` below) and https://docs.ollama.com/api/openai-compatibility, where the /openai
 * page now redirects (its sentence on context size is quoted below).
 *
 * The catalogue here is whatever the user pulled, so a builtin table can only ever be a starting
 * point; one row keeps it honest. `ModelInfo` is data — a host with other models passes its own.
 */
import type { HostClock, HostNetwork } from '../../host/adapter.js'
import type { ConfigKey, ModelInfo, Provider, ProviderDefinition } from '../types.js'
import { OpenAIChatProvider } from '../wire/openai-chat.js'
import { configuredValue } from '../wire/transport.js'
import { frozenModels } from './models.js'

export const OLLAMA_PROVIDER_ID = 'ollama'

/** Spec §内置 provider. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1/'

/**
 * Ollama does not check the key, but the OpenAI SDK requires a non-empty one, so the spec gives
 * this definition a non-secret config item with a default. Non-secret because there is no secret:
 * putting a fixed, documented placeholder in the OS keychain would only make it look like one.
 */
export const OLLAMA_DEFAULT_API_KEY = 'ollama'

const CONFIG_KEYS: readonly ConfigKey[] = [
  {
    name: 'baseURL',
    required: true,
    secret: false,
    // No `primary`: the spec's table marks it in exactly one cell (anthropic's `apiKey`), and the
    // endpoint being the field a local provider should ask for first is a settings-card decision
    // nobody has recorded. Declaration order already puts it first.
    default: OLLAMA_DEFAULT_BASE_URL,
    labelKey: 'provider.ollama.config.baseURL',
  },
  {
    name: 'apiKey',
    required: false,
    secret: false,
    default: OLLAMA_DEFAULT_API_KEY,
    labelKey: 'provider.ollama.config.apiKey',
  },
]

/**
 * Every number here is the conservative reading, because the two probes this row needs cannot be
 * run without a live instance and none is available:
 *
 * - `contextLimit: 4096` is the lowest tier of Ollama's VRAM-based default context length, not the
 *   model's capability: the context-length page gives 4k below 24 GiB of VRAM, 32k from 24 to
 *   48 GiB and 256k from 48 GiB, and the FAQ's flat "4096 tokens" is the exact figure behind that
 *   4k. qwen3's own tags advertise 40K, but a prompt longer than `num_ctx` is silently truncated,
 *   and the OpenAI-compatible endpoint cannot raise it: "The OpenAI API does not have a way of
 *   setting the context size for a model". A host that runs `OLLAMA_CONTEXT_LENGTH=…` (the page
 *   asks for at least 64000 for agents) can raise this row; guessing high would silently drop the
 *   system prompt, which is the failure the spec asked to probe for.
 * - `maxOutputTokens: 2048` is OURS, not the vendor's: nothing documents a ceiling for this
 *   endpoint (`num_predict` defaults to unlimited), and `max_tokens` is mandatory in the encoded
 *   body, so a number had to be chosen. Half the documented window leaves room for the prompt.
 * - `supportsStreamingToolCalls: false` until a probe against a running instance says otherwise:
 *   the spec requires exactly that, and the adapter does not depend on the answer (it places
 *   fragments by index either way, and a whole call in one chunk is the shape this vendor sends).
 *
 * `thinkingPreservationFormat: 'reasoning-content'` with `reasoningEchoField: 'reasoning'` is the
 * spec's own statement about this vendor: it echoes thinking back under `reasoning`, and a model on
 * that tier must declare the field (plan.md, step 8).
 */
const MODELS: readonly ModelInfo[] = frozenModels([
  {
    id: 'qwen3:8b',
    providerId: OLLAMA_PROVIDER_ID,
    contextLimit: 4096,
    maxOutputTokens: 2048,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: false,
    supportsVision: false,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'reasoning-content',
    reasoningEchoField: 'reasoning',
    usageNeedsOptIn: true,
  },
])

export const ollamaDefinition: ProviderDefinition = {
  id: OLLAMA_PROVIDER_ID,
  nameKey: 'provider.ollama.name',
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
      id: OLLAMA_PROVIDER_ID,
      network: args.network,
      clock: args.clock,
      // From `config`, not `secrets`: this key is not a secret. The default is applied here too,
      // because a caller that skipped the ConfigKey defaults must not end up with a client the
      // SDK refuses to build — and through `configuredValue`, because a BLANK value has to reach
      // the default as well: this key is `required: false`, and the settings card stores a field
      // the user cleared as '', which `?? ` alone would carry through to a client the SDK refuses
      // and an error naming a key the definition says is optional.
      apiKey: configuredValue(args.config['apiKey']) ?? OLLAMA_DEFAULT_API_KEY,
      baseURL: configuredValue(args.config['baseURL']) ?? OLLAMA_DEFAULT_BASE_URL,
      models: MODELS,
    })
  },
}
