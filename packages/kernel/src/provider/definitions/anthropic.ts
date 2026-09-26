/**
 * The `anthropic` provider definition (spec 01 §内置 provider): data plus a `create()`.
 *
 * A definition is the ONLY thing adding a provider takes (acceptance 1), so there is no logic
 * here: the wire adapter owns encoding, streaming and — deliberately — credential validation, so
 * that every provider on this wire refuses a missing key the same way and in the same place.
 *
 * `builtinModels` was filled on 2026-09-21 from the vendor's own model overview (then at
 * .../about-claude/models/overview, now https://platform.claude.com/docs/en/models/overview): the
 * model ids, context windows, output limits, pricing and the statement that "all current models
 * support text and image input, text output, multilingual capabilities, vision, and tool use" come
 * from that page, and the cache-read rates from its pricing footnote. The `claude-opus-5-5` row
 * was added on 2026-09-26 for spec 02 (§内置模型表的数据改动) from
 * https://platform.claude.com/docs/en/models/opus-5-5/overview and the pricing page
 * https://platform.claude.com/docs/en/about-claude/pricing; the same day the footnote read "10% of
 * the base input price (2.5% on Claude Fable 5.1 and Claude Mythos 5.1, 5% on Claude Opus 5.5)",
 * and the four older rows were re-checked against their own pages and still match.
 *
 * The order is the owner's, not the vendor's (02 decision A16): Sonnet 5 first and Opus 5.5 second
 * until an official key passes the Anthropic group's prefix acceptance, then Opus 5.5 first. The
 * first row is only the fallback for a user who never picked a model (02 decision M5); the
 * overview itself now says to start with Opus 5.5. Whatever a caller does with this table, it is
 * data — a host that wants another model passes its own `ModelInfo`.
 */
import type { HostClock, HostNetwork } from '../../host/adapter.js'
import type { ConfigKey, ModelInfo, Provider, ProviderDefinition } from '../types.js'
import { AnthropicMessagesProvider } from '../wire/anthropic-messages.js'
import { configuredValue } from '../wire/transport.js'
import { frozenModels } from './models.js'

export const ANTHROPIC_PROVIDER_ID = 'anthropic'

/** Spec §内置 provider. The SDK appends `/v1/messages`, so this URL carries no `/v1`. */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'

/**
 * The credential pair is `required: false` on BOTH keys, and that is not an oversight: the adapter
 * needs `apiKey` OR `authToken` (a Bearer-style compatible gateway has only the latter), and
 * `ConfigKey` has no way to say "one of these". Marking `apiKey` required would make a gateway
 * user unable to save the form; marking neither leaves `primary` to say which one to ask for
 * first, and the adapter to refuse a provider that has neither.
 */
const CONFIG_KEYS: readonly ConfigKey[] = [
  {
    name: 'apiKey',
    required: false,
    secret: true,
    primary: true,
    labelKey: 'provider.anthropic.config.apiKey',
  },
  {
    name: 'authToken',
    required: false,
    secret: true,
    labelKey: 'provider.anthropic.config.authToken',
  },
  {
    // A value is always needed (the adapter refuses a blank one), and the default supplies it.
    name: 'baseURL',
    required: true,
    secret: false,
    default: ANTHROPIC_DEFAULT_BASE_URL,
    labelKey: 'provider.anthropic.config.baseURL',
  },
]

/**
 * `thinkingPreservationFormat: 'signed-blocks'` on every row: this wire carries thinking back as
 * the signed block it issued, and a signature is never rewritten (invariant 7).
 *
 * `reasoning: true` states that the model reasons; WHICH thinking parameter it takes is its
 * `thinkingSpec` (spec 02, 01 修补 2; decision A1), filled on 2026-09-26 (02 plan.md, step 6) from
 * https://platform.claude.com/docs/en/build-with-claude/thinking, .../build-with-claude/effort,
 * .../build-with-claude/extended-thinking and each model's overview page, all read that day:
 *
 * - modes: Sonnet 5 thinks by default and accepts `disabled` (`adaptive`); Opus 5 thinks by default
 *   and accepts `disabled` only at effort `high` or below (`adaptive-gated`, `disableMaxEffort:
 *   'high'`); Opus 5.5 and Fable 5.1 reject `disabled` (`always-on`); Haiku 4.5 takes only the
 *   manual `enabled` + `budget_tokens` form and is off by default (`budget`). The manual form is a
 *   400 on the four others;
 * - effort: all five levels `low` … `max` on the four adaptive rows; the default is `medium` on
 *   Opus 5.5 and `high` on the other three; Haiku 4.5 does not support the parameter;
 * - display: `summarized` or `omitted` in either mode, `omitted` the default on the four newer rows
 *   and `summarized` on "earlier models", Haiku 4.5 among them. `updates` is a beta and not listed;
 * - sampling: a non-default `temperature`, `top_p` or `top_k` is a 400 on every request on the four
 *   newer rows (`samplingDefaultsOnly`); on Haiku 4.5 only while thinking is on, which the flag
 *   cannot say, so that row does not set it. The thresholds the kernel enforces are spec 02's
 *   (01 修补 2: temperature 1.0 only, top_p >= 0.99, no top_k); the pages say only "the defaults";
 * - forced `tool_choice` (`any` / `tool`) is a 400 on Opus 5.5 and Fable 5.1 (`forcedToolChoice:
 *   false`); the other rows leave the field out, which the search sub-request reads as usable.
 *
 * The vendor has thinking on by default on the four adaptive rows with no thinking parameter sent,
 * so an absent `ProviderRequest.thinking` writes none and the model's default stands.
 */
const MODELS: readonly ModelInfo[] = frozenModels([
  {
    id: 'claude-sonnet-5',
    providerId: ANTHROPIC_PROVIDER_ID,
    contextLimit: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: true,
    supportsCacheControl: true,
    thinkingPreservationFormat: 'signed-blocks',
    usageNeedsOptIn: false,
    thinkingSpec: {
      mode: 'adaptive',
      defaultOn: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      displays: ['summarized', 'omitted'],
      defaultDisplay: 'omitted',
      samplingDefaultsOnly: true,
    },
    pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  },
  {
    // A fixed id with no date suffix; the alias is the same string. The 5-minute cache-write price
    // is the one recorded (the 1-hour tier is $8). Thinking always on, five effort levels from low
    // to max with medium the default, no forced `tool_choice`, sampling parameters at their
    // defaults only (02 §内置模型表的数据改动, decisions A16 and A1).
    id: 'claude-opus-5-5',
    providerId: ANTHROPIC_PROVIDER_ID,
    contextLimit: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: true,
    supportsCacheControl: true,
    thinkingPreservationFormat: 'signed-blocks',
    usageNeedsOptIn: false,
    thinkingSpec: {
      mode: 'always-on',
      defaultOn: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      displays: ['summarized', 'omitted'],
      defaultDisplay: 'omitted',
      samplingDefaultsOnly: true,
      forcedToolChoice: false,
    },
    pricing: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  },
  {
    // Legacy ("still available") since Opus 5.5; the deprecations page still lists it as Active,
    // retiring not sooner than 2027-07-24. It moves under 更多模型 › once `listing` exists (02 A16).
    id: 'claude-opus-5',
    providerId: ANTHROPIC_PROVIDER_ID,
    contextLimit: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: true,
    supportsCacheControl: true,
    thinkingPreservationFormat: 'signed-blocks',
    usageNeedsOptIn: false,
    thinkingSpec: {
      mode: 'adaptive-gated',
      defaultOn: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      disableMaxEffort: 'high',
      displays: ['summarized', 'omitted'],
      defaultDisplay: 'omitted',
      samplingDefaultsOnly: true,
    },
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
  },
  {
    // The dated snapshot rather than the `claude-haiku-4-5` alias: a pinned id is what makes a
    // recorded `provider/attempt_completed` fact mean one model for ever. Tentative retirement:
    // "not sooner than October 15, 2026", and the vendor gives "at least 60 days' notice before
    // model retirement" (https://platform.claude.com/docs/en/about-claude/model-deprecations, read
    // 2026-09-26, when no notice for this model was listed). 02 decision A16 drops the row once a
    // deprecation notice appears.
    id: 'claude-haiku-4-5-20251001',
    providerId: ANTHROPIC_PROVIDER_ID,
    contextLimit: 200_000,
    maxOutputTokens: 64_000,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: true,
    supportsCacheControl: true,
    thinkingPreservationFormat: 'signed-blocks',
    usageNeedsOptIn: false,
    thinkingSpec: {
      mode: 'budget',
      defaultOn: false,
      displays: ['summarized', 'omitted'],
      defaultDisplay: 'summarized',
    },
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
  },
  {
    id: 'claude-fable-5-1',
    providerId: ANTHROPIC_PROVIDER_ID,
    contextLimit: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: true,
    supportsCacheControl: true,
    thinkingPreservationFormat: 'signed-blocks',
    usageNeedsOptIn: false,
    thinkingSpec: {
      mode: 'always-on',
      defaultOn: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      displays: ['summarized', 'omitted'],
      defaultDisplay: 'omitted',
      samplingDefaultsOnly: true,
      forcedToolChoice: false,
    },
    pricing: { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25 },
  },
])

export const anthropicDefinition: ProviderDefinition = {
  id: ANTHROPIC_PROVIDER_ID,
  // An i18n key, never a sentence: the kernel produces no prose (00-foundation §国际化).
  nameKey: 'provider.anthropic.name',
  wire: 'anthropic-messages',
  configKeys: [...CONFIG_KEYS],
  builtinModels: [...MODELS],
  create(args: {
    network: HostNetwork
    clock: Pick<HostClock, 'now' | 'setTimeout'>
    config: Record<string, string>
    secrets: Record<string, string>
  }): Provider {
    return new AnthropicMessagesProvider({
      id: ANTHROPIC_PROVIDER_ID,
      network: args.network,
      clock: args.clock,
      // `?? null` is "not configured", which is what the adapter's "at least one" rule reads.
      apiKey: args.secrets['apiKey'] ?? null,
      authToken: args.secrets['authToken'] ?? null,
      // Through `configuredValue`, so a field the user CLEARED gets the declared default rather
      // than the "missing config" error: the settings card stores a cleared non-secret field as
      // '', and a key with a default is never missing.
      baseURL: configuredValue(args.config['baseURL']) ?? ANTHROPIC_DEFAULT_BASE_URL,
      models: MODELS,
    })
  },
}
