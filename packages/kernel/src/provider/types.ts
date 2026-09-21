/**
 * Provider contract — the shapes fixed by docs/architecture/01-provider-and-tape/spec.md
 * §Provider 层 (接口 / 归一化事件流). Change them there first.
 *
 * Types only: no runtime code lives here, and nothing in this file imports from tape/.
 * The content model is shared with the Tape message payloads — the tape track binds its
 * payloads to `ContentBlock[]` later, and a value import either way would make that a
 * dependency cycle instead of a shared vocabulary.
 */
import type { HostNetwork } from '../host/adapter.js'

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
  pricing?: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number }
  /** Merged into the request body verbatim — the insurance against one vendor breaking
   * the abstraction. */
  requestParams?: Record<string, unknown>
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
  thinking?: { enabled: boolean; budgetTokens?: number }
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
}

export interface CompleteResult {
  message: InternalMessage
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
  /** Host capabilities enter only through here. */
  create(args: {
    network: HostNetwork
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
  | { type: 'text'; text: string }
  | {
      type: 'thinking'
      text: string
      signature: string
      provider: ProviderId
      providerModel: string
    }
  | { type: 'redacted-thinking'; data: string; provider: ProviderId; providerModel: string }
  | { type: 'tool-request'; id: string; name: string; input: Record<string, unknown> }
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
  | { type: 'stop'; reason: StopReason; providerReason: string | null }
  | {
      type: 'error'
      code: ProviderErrorCode
      retryable: boolean
      retryAfterMs?: number
      status?: number
      providerCode: string | null
      detail: string /* logs only, never rendered */
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
