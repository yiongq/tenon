/**
 * Provider contract — the shapes fixed by docs/architecture/01-provider-and-tape/spec.md
 * §Provider 层 (接口 / 归一化事件流). Change them there first.
 *
 * Types only: no runtime code lives here, and nothing in this file imports from tape/.
 * The content model is shared with the Tape message payloads — the tape track binds its
 * payloads to `ContentBlock[]` later, and a value import either way would make that a
 * dependency cycle instead of a shared vocabulary.
 */
import type { HostClock, HostNetwork } from '../host/adapter.js'

/** 'anthropic' | 'zhipu' | 'ollama' … is data, not a union type. */
export type ProviderId = string

export interface ConfigKey {
  name: string
  required: boolean
  /** true = the value goes into HostAdapter.secrets (key built by keyFor); false = config.json. */
  secret: boolean
  default?: string
  /** An i18n key only; the kernel never produces sentences (00-foundation §国际化). */
  labelKey: string
  primary?: boolean
  oauthFlow?: boolean // phase 1 declares it, does not implement it
  deviceCodeFlow?: boolean
}

export interface ModelInfo {
  id: string
  providerId: ProviderId
  /** Resale channels (Bedrock / Azure) map back to the upstream model; pricing and the
   * thinking rules are computed from it. */
  canonicalId?: string
  contextLimit: number
  maxOutputTokens: number
  reasoning: boolean
  supportsToolCalling: boolean
  supportsStreamingToolCalls: boolean
  supportsVision: boolean
  supportsCacheControl: boolean
  /** How a thinking block is carried into the next request. */
  thinkingPreservationFormat: 'signed-blocks' | 'reasoning-content' | 'text-only' | 'drop'
  /** The field name used when echoing under the 'reasoning-content' tier: DeepSeek-style
   * models use reasoning_content, Ollama uses reasoning. */
  reasoningEchoField?: 'reasoning_content' | 'reasoning'
  /** The OpenAI wire protocol only reports usage when stream_options.include_usage is set. */
  usageNeedsOptIn: boolean
  pricing?: {
    inputPerMTok: number
    outputPerMTok: number
    cacheReadPerMTok?: number
    /** Spec 02, 01 修补 2. Absent reads as USD: every price 01 filled in is in dollars. */
    currency?: 'USD' | 'CNY'
    /** Spec 02, 01 修补 2: the price of writing the cache. */
    cacheWritePerMTok?: number
  }
  /** Merged into the request body verbatim — the insurance against one vendor breaking
   * the abstraction. */
  requestParams?: Record<string, unknown>
  /**
   * Spec 02, 01 修补 2: which thinking shape this model takes, as data. Absent = 01's behaviour byte
   * for byte, which is what every synthesised row (dev fallback, hand-typed ids) keeps.
   */
  thinkingSpec?: ThinkingSpec
  /**
   * Spec 02, 01 修补 2: the i18n key of the model menu's one-line purpose, given as data the way
   * `ProviderDefinition.nameKey` is. Never read by encode(), so it is not in WIRE_MODEL_FIELDS.
   */
  purposeKey?: string
  /**
   * Spec 02, 01 修补 2 (open question 16, owner 2026-09-26): where the model menu lists the row —
   * `'more'` puts it under 更多模型 ›. Absent = `'main'`. Only the desktop reads it, so it is not in
   * WIRE_MODEL_FIELDS; a definition's first row (the new-user fallback) is never `'more'`.
   */
  listing?: 'main' | 'more'
}

/**
 * Spec 02, 01 修补 2 (decision A1): the thinking shape a model takes.
 *
 * - `budget`: only `enabled` + `budget_tokens` (Haiku 4.5);
 * - `adaptive`: adaptive, can be turned off (Sonnet 5);
 * - `adaptive-gated`: adaptive, can be turned off only at an effort no higher than
 *   `disableMaxEffort` (Opus 5);
 * - `always-on`: always on (Opus 5.5, Fable 5.1);
 * - `effort-only`: the OpenAI-compatible wire's one mode — the level travels as `reasoning_effort`,
 *   and thinking can be turned off only when `effortLevels` holds `'none'` (the GLM-5.3 family has
 *   no such level). An openai-chat row takes only this mode, an anthropic-messages row never does.
 */
export interface ThinkingSpec {
  mode: 'budget' | 'adaptive' | 'adaptive-gated' | 'always-on' | 'effort-only'
  defaultOn: boolean
  /** The vendor's own names, lowest first; the interface lists levels in this order. */
  effortLevels?: readonly string[]
  defaultEffort?: string
  disableMaxEffort?: string
  displays?: readonly ('summarized' | 'omitted')[]
  defaultDisplay?: 'summarized' | 'omitted'
  /** true: `temperature` only 1.0, `top_p` only >= 0.99, `top_k` always refused. */
  samplingDefaultsOnly?: boolean
  /** false: `tool_choice` of `any` / `tool` is a 400. The main conversation never reads it. */
  forcedToolChoice?: boolean
}

export interface RequestIdentity {
  runId: string // canonical UUID, never an in-process counter
  requestSeq: number // payload identity: +1 only when the payload changed
  physicalAttempt: number // transmissions: +1 when the same payload is resent
}

export interface ProviderRequest {
  model: ModelInfo
  system?: string
  messages: InternalMessage[]
  tools?: ToolSpec[]
  maxTokens?: number
  temperature?: number
  /** Still three states: absent / on / off. */
  thinking?: { enabled: boolean; budgetTokens?: number }
  /** Spec 02, 01 修补 2: one of the row's `thinkingSpec.effortLevels`; absent = the model's default. */
  effort?: string
  /** Spec 02, 01 修补 2: one of the row's `thinkingSpec.displays`; written only while thinking is on. */
  display?: 'summarized' | 'omitted'
  /**
   * Spec 02, 01 修补 2 (decision H10): the guard drops the thinking blocks of every message whose
   * index is below this one, each recorded as `drop / compacted`. Absent = 01's behaviour.
   */
  dropThinkingBefore?: number
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Vendor-specific counters go into the fact's `meta`, never into `Usage`. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** One stream can carry several usage events (Anthropic sends one at message_start and
   * one at message_delta). Only the final one reaches the Tape. */
  final: boolean
}

export interface SendContext {
  signal?: AbortSignal
  identity: RequestIdentity // read-only for the provider, never modified
  /**
   * Spec 02, 01 修补 4 (decision A5): false = no first-byte limit on this send. The loop passes it
   * only on the resend right after a first-byte timeout; absent = the adapter's own rule.
   */
  firstByteTimeout?: boolean
}

export interface Provider {
  // The four members a new wire protocol implements
  readonly id: ProviderId
  models(): Promise<ModelInfo[]>
  /** Pure: no I/O, no clock, no network. Two calls on the same input give the same bytes. */
  encode(req: ProviderRequest): EncodedRequest
  /**
   * The only required I/O. It consumes encode()'s output rather than the raw request, so
   * what is hashed is what goes out and phase 2 can persist view/assembled before the
   * bytes leave. Never rejects because of a wire error.
   */
  stream(encoded: EncodedRequest, ctx: SendContext): AsyncIterable<StreamEvent>

  // Required on the interface, defaulted by BaseProvider: "unsupported" is a return value,
  // not a missing method, so callers never null-check
  complete(req: ProviderRequest, ctx: SendContext): Promise<CompleteResult>
  managesOwnContext(): boolean
  supportsCacheControl(model: ModelInfo): boolean
  thinkingEffortSupport(model: ModelInfo): 'none' | 'budget' | 'effort'
  /** Advice only; retrying itself belongs to the phase 2 loop. */
  retryAdvice(): { maxAttempts: number; baseDelayMs: number }

  // Truly optional: absent means this flow does not exist
  countTokens?(req: ProviderRequest): Promise<number>
}

export interface EncodedRequest {
  readonly providerId: ProviderId
  /** The model id that goes on the wire: always `ProviderRequest.model.id`, never
   * `canonicalId` (the endpoint only knows its own name). The thinking guard compares on
   * `thinkingModelId(model)` instead, so the two are free to differ. */
  readonly modelId: string
  readonly body: unknown // the wire payload handed to the SDK
  readonly promptHash: string // SHA-256 (hex) of canonicalJson(body)
  readonly toolDefinitionsHash: string
  /** Audit: where each reasoning block went, and why. */
  readonly thinkingDecisions: readonly ThinkingDecision[]
}

export interface ThinkingDecision {
  action: 'replay' | 'echo' | 'downgrade' | 'drop'
  reason:
    | 'same-model'
    | 'foreign-provider'
    | 'model-changed'
    | 'target-drops'
    | 'no-tools'
    | 'redacted-unsupported'
    | 'missing-signature'
    /** Spec 02: a `replay: 'never'` vendor block — a call the vendor ran itself, or its result. */
    | 'server-executed'
    /** Spec 02 (H10): a thinking block below `ProviderRequest.dropThinkingBefore`. */
    | 'compacted'
}

export interface CompleteResult {
  /** The assistant turn, partial content included. Empty `content` means there is nothing
   * to persist: a caller writing it anyway would produce the empty assistant turn that
   * replay must never yield (and that Anthropic rejects with a 400). */
  message: InternalMessage
  /** The `final: true` reading, or null when the stream carried none: only a final reading
   * may reach `provider/attempt_completed` (invariant 1). */
  usage: Usage | null
  stop: { reason: StopReason; providerReason: string | null } | null
  /** Without these two the default complete() would swallow errors and aborts. */
  error: Extract<StreamEvent, { type: 'error' }> | null
}

export interface ProviderDefinition {
  id: ProviderId
  nameKey: string // i18n key
  wire: 'anthropic-messages' | 'openai-chat'
  configKeys: ConfigKey[]
  builtinModels: ModelInfo[]
  /**
   * Spec 02, 01 修补 2 (decisions A12, M2, M6): finish_reason values the openai-chat wire's own table
   * does not know, as data. A definition may only ADD values: one the table already maps is refused
   * when the provider is built. The anthropic-messages wire does not read it.
   */
  finishReasons?: Readonly<Record<string, StopReason>>
  /** Host capabilities enter only through here. */
  create(args: {
    network: HostNetwork
    /**
     * `now` is what `retryAfterMs()` needs: the HTTP-date branch of `retry-after` is an absolute
     * time, and the kernel has no `Date.now()` (lint gate). `setTimeout` (spec 02, 01 修补 2 and 4)
     * is for the byte-level idle watchdog only: retrying is still the loop's job, and the
     * first-byte limit runs on the SDK's own timer.
     */
    clock: Pick<HostClock, 'now' | 'setTimeout'>
    config: Record<string, string> // non-secret items, defaults already applied
    secrets: Record<string, string> // read from HostAdapter.secrets by the caller
  }): Provider
}

export interface ProviderRegistry {
  register(def: ProviderDefinition): void
  get(id: ProviderId): ProviderDefinition | null
  list(): ProviderDefinition[]
}

/**
 * The content model, shared with the Tape message payloads.
 *
 * `provider` and `providerModel` are recorded on the thinking block ITSELF: without them
 * the thinking guard has nothing to compare, and "drop or downgrade the previous model's
 * thinking blocks when the model changes" (master-reference §4.8.3) is unimplementable.
 */
export type ContentBlock =
  | { type: 'text'; text: string; vendorFields?: Record<string, unknown> }
  | {
      type: 'thinking'
      text: string
      signature: string
      provider: ProviderId
      providerModel: string
      vendorFields?: Record<string, unknown>
    }
  | {
      type: 'redacted-thinking'
      data: string
      provider: ProviderId
      providerModel: string
      vendorFields?: Record<string, unknown>
    }
  | {
      type: 'tool-request'
      id: string
      name: string
      input: Record<string, unknown>
      vendorFields?: Record<string, unknown>
    }
  | {
      type: 'tool-response'
      id: string
      content: Array<Extract<ContentBlock, { type: 'text' | 'image' }>>
      isError: boolean
    }
  | {
      type: 'image'
      mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
      data: string
    }
  /**
   * Spec 02, 01 修补 2 (decision M3): a block the vendor sent that has no counterpart above, kept
   * verbatim. `replay: 'never'` marks a call the vendor executed itself, and its result: archived,
   * never dispatched, never sent back.
   */
  | {
      type: 'vendor'
      provider: ProviderId
      providerModel: string
      raw: Record<string, unknown>
      replay: 'same-model' | 'never'
    }

export interface InternalMessage {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

/**
 * The normalised event stream. `index` is the block slot the adapter assigned; it means
 * something only within one response and is never a provider semantic.
 */
export type StreamEvent =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'thinking-delta'; index: number; text: string }
  | { type: 'thinking-signature'; index: number; signature: string }
  | { type: 'redacted-thinking'; index: number; data: string }
  | { type: 'tool-call-start'; index: number; id: string; name: string }
  | { type: 'tool-call-args-delta'; index: number; json: string }
  | {
      type: 'tool-call-end'
      index: number
      id: string
      name: string
      input: Record<string, unknown>
    }
  | { type: 'usage'; usage: Usage }
  /** Spec 02, 01 修补 2: a whole vendor block, complete as it stands. */
  | {
      type: 'vendor-block'
      index: number
      raw: Record<string, unknown>
      replay: 'same-model' | 'never'
    }
  /** Spec 02, 01 修补 2: the fields a known block carried that the content model has no place for. */
  | { type: 'vendor-fields'; index: number; fields: Record<string, unknown> }
  /** Spec 02 (M5): the model name the vendor reported, at most once per stream. */
  | { type: 'response-model'; modelId: string }
  | { type: 'stop'; reason: StopReason; providerReason: string | null }
  | {
      type: 'error'
      code: ProviderErrorCode
      retryable: boolean
      retryAfterMs?: number
      status?: number
      providerCode: string | null
      detail: string /* logs only, never rendered */
      /** Spec 02, 01 修补 4 (A5): which limit ended the stream — no first byte, or no byte for too long. */
      timeout?: 'first-byte' | 'idle'
      /** Spec 02, 01 修补 2 (H12): epoch ms when an exhausted quota resets, when the vendor says. */
      resetAt?: number
    }

export type StopReason =
  | 'end-turn'
  | 'max-tokens'
  | 'stop-sequence'
  | 'tool-use'
  | 'pause-turn'
  | 'refusal'
  | 'content-filter'
  | 'context-overflow'
  | 'aborted'
  | 'unknown'

export type ProviderErrorCode =
  | 'auth'
  | 'rate-limit'
  | 'overloaded'
  | 'invalid-request'
  | 'context-overflow'
  | 'network'
  | 'egress-denied'
  | 'server'
  | 'unknown'
  /** Spec 02, 01 修补 5 (H12): an exhausted quota or spend limit; not retryable. */
  | 'quota-exhausted'
  /** Spec 02, 01 修补 5 (H12): the account or organisation is not set up for this; not retryable. */
  | 'account-config'
