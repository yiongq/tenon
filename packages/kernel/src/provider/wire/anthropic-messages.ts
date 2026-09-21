/**
 * The Anthropic Messages wire adapter (spec 01 §Provider 层): the pure `encode()` below, and
 * `AnthropicMessagesProvider` — the only I/O in this file — at the bottom.
 *
 * `encodeAnthropicMessages()` stays a free function that takes no client: the wire format is
 * testable without one, and the hashes are reproducible from a Tape alone. The class delegates
 * to it in one line.
 *
 * Every key is written only when it has a value — canonicalJson (and therefore `promptHash`)
 * refuses an undefined-valued key, and the wire's notion of "absent" is a missing key.
 */
import Anthropic, { APIConnectionError } from '@anthropic-ai/sdk'
import type { HostClock, HostNetwork } from '../../host/adapter.js'
import { HostNetworkDeniedError } from '../../host/adapter.js'
import { BaseProvider, withTerminalEvent } from '../base.js'
import {
  ProviderConfigMissingError,
  ProviderInvalidArgumentError,
  isRetryableByDefault,
  retryAfterMs,
} from '../errors.js'
import type { HeaderLookup } from '../errors.js'
import type { ThinkingApplication } from '../thinking.js'
import type {
  ContentBlock,
  EncodedRequest,
  ModelInfo,
  ProviderErrorCode,
  ProviderId,
  ProviderRequest,
  SendContext,
  StopReason,
  StreamEvent,
  ThinkingDecision,
  ToolSpec,
  Usage,
} from '../types.js'
import {
  assertBlockRole,
  assertHasMessages,
  assertImageMediaType,
  assertModelBelongs,
  assertToolInput,
  assertToolRequested,
  effectiveMaxTokens,
  guardReasoning,
  hasSystemPrompt,
  mergeRequestParams,
  sealEncoded,
  thinkingTargetFor,
} from './shared.js'
import type { ImageContentBlock } from './shared.js'

const WIRE = 'anthropic-messages'

/** The four base64 source types the Messages API documents. */
const MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** The documented floor for `thinking.budget_tokens` on this wire. */
const MIN_THINKING_BUDGET = 1024

/**
 * The keys `requestParams` may not set on this wire (see mergeRequestParams). Three groups, one
 * criterion — what promptHash covers has to be the request the audit describes:
 *
 * - every key this encoder writes: `model`, `messages`, `max_tokens`, `system`, `tools`,
 *   `temperature`, `thinking`, `stream`. All but `model`, `messages` and `stream` are also what
 *   the `provider/attempt_completed` record describes (`systemHash`, `maxTokens`, `temperature`,
 *   `thinking` in the request snapshot, `toolDefinitionsHash` beside it), so a passthrough that
 *   replaced one would leave the fact describing a request nobody sent;
 * - `user_profile_id` / `workspace_id`, which the pinned SDK destructures out of the body into
 *   `anthropic-user-profile-id` / `anthropic-workspace-id` headers: promptHash would cover a key
 *   that never travels in the body. Nothing in phase 1 wants them; refusing is enough. Re-audit
 *   this pair whenever the SDK pin moves.
 */
const RESERVED_KEYS: readonly string[] = [
  'model',
  'messages',
  'max_tokens',
  'system',
  'tools',
  'temperature',
  'thinking',
  'stream',
  'user_profile_id',
  'workspace_id',
]

export type AnthropicResultBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export type AnthropicContentBlock =
  | AnthropicResultBlock
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result'
      tool_use_id: string
      is_error: boolean
      /** Omitted rather than sent empty: the API treats a tool result's content as optional. */
      content?: AnthropicResultBlock[]
    }

export interface AnthropicWireMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

export interface AnthropicToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/**
 * Encodes a ProviderRequest into an Anthropic Messages body.
 *
 * `providerId` is the adapter's own id, which the model must belong to: the thinking guard
 * compares a block's `provider` against `model.providerId`, so the two cannot be allowed to
 * disagree here. Throws only on programmer errors (see the named errors below).
 */
export function encodeAnthropicMessages(
  req: ProviderRequest,
  providerId: ProviderId,
): EncodedRequest {
  assertModelBelongs(req.model, providerId)
  const decisions: ThinkingDecision[] = []
  const messages = encodeMessages(req, decisions)
  assertHasMessages(messages.length, WIRE)
  const tools = encodeTools(req.tools)
  const maxTokens = effectiveMaxTokens(req)
  const body: Record<string, unknown> = {
    // The WIRE id, never `canonicalId`: the endpoint only knows its own name.
    model: req.model.id,
    max_tokens: maxTokens,
    messages,
    // The transport flag belongs to the HASHED body, not to the adapter: the endpoint needs it
    // in the body to answer with SSE, `stream()` sends the body unchanged, and spec §接口 asks
    // that what was hashed be what went out. Adding it after the hash would leave every
    // `provider/attempt_completed` describing a payload one key short of the bytes on the wire,
    // and once facts exist that is not fixable. RESERVED_KEYS keeps `requestParams` off it.
    stream: true,
  }
  if (hasSystemPrompt(req.system)) body.system = req.system
  if (tools.length > 0) body.tools = tools
  if (req.temperature !== undefined) body.temperature = req.temperature
  const thinking = req.thinking
  if (thinking?.enabled === true) body.thinking = thinkingParam(req.model, thinking, maxTokens)
  mergeRequestParams(body, req.model, RESERVED_KEYS)
  return sealEncoded(providerId, req.model.id, body, tools, decisions)
}

/**
 * `budget_tokens` is mandatory once extended thinking is enabled, so "enabled with no budget" is
 * a caller bug rather than something to guess a number for: a default chosen here would be
 * policy invented in the encoder, and quietly dropping the `thinking` key would send a request
 * without the thinking the caller asked for.
 *
 * The documented bounds for this form are checked here too — an integer, at least 1024, and
 * strictly below `max_tokens`. All three are 400s a pure function can see coming, and the spec's
 * dev fallback lets `TENON_MAX_TOKENS` move `max_tokens` independently of the budget, so the pair
 * really can arrive inconsistent. (Which thinking SHAPE the newer models take is a `ModelInfo`
 * question this step cannot answer — see plan.md's Open.)
 */
function thinkingParam(
  model: ModelInfo,
  thinking: { enabled: boolean; budgetTokens?: number },
  maxTokens: number,
): { type: 'enabled'; budget_tokens: number } {
  const budget = thinking.budgetTokens
  if (budget === undefined) {
    throw new ProviderInvalidArgumentError(
      `model ${model.id}: thinking is enabled but no budgetTokens was given; budget_tokens is mandatory on ${WIRE}`,
    )
  }
  if (!Number.isInteger(budget) || budget < MIN_THINKING_BUDGET || budget >= maxTokens) {
    throw new ProviderInvalidArgumentError(
      `model ${model.id}: thinking budgetTokens must be an integer in [${MIN_THINKING_BUDGET}, max_tokens), got ${String(budget)} with max_tokens ${maxTokens}`,
    )
  }
  return { type: 'enabled', budget_tokens: budget }
}

function encodeTools(tools: readonly ToolSpec[] | undefined): AnthropicToolDefinition[] {
  if (tools === undefined) return []
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
}

/**
 * Maps the internal transcript onto the wire, in order.
 *
 * A message whose content is empty after the thinking guard is omitted entirely: an empty
 * assistant turn is a 400 here. Omitting one can leave two user turns adjacent, and that is
 * left as it is — the API combines consecutive same-role turns, whereas merging them in the
 * encoder would invent a turn boundary that no fact in the Tape records, and inserting a
 * placeholder would put words in the user's mouth.
 *
 * Each block kind is checked against the role it is legal in: this API's user-turn content union
 * has no `tool_use` and no `thinking`, and its assistant-turn union has no `tool_result` and no
 * `image`. A transcript read back from the Tape is data, so the type union alone does not settle
 * it — see assertBlockRole.
 */
function encodeMessages(
  req: ProviderRequest,
  decisions: ThinkingDecision[],
): AnthropicWireMessage[] {
  const target = thinkingTargetFor(req)
  const requested = new Set<string>()
  const out: AnthropicWireMessage[] = []
  for (const message of req.messages) {
    const content: AnthropicContentBlock[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          // The API rejects an empty text block, whatever produced it.
          if (block.text !== '') content.push({ type: 'text', text: block.text })
          break
        case 'thinking':
        case 'redacted-thinking': {
          // Reasoning is the assistant's own output, and the guard judges it against the model
          // that produced it; on a user turn it is neither legal here nor true.
          assertBlockRole('a reasoning block', message.role, 'assistant', WIRE)
          const encoded = reasoningBlock(guardReasoning(block, target, decisions), req.model)
          if (encoded !== null) content.push(encoded)
          break
        }
        case 'tool-request':
          // Checked before the id is remembered: a `tool_use` the wire would refuse must not
          // legitimise the `tool_result` that follows it.
          assertBlockRole('a tool call', message.role, 'assistant', WIRE)
          requested.add(block.id)
          // Invariant 6 on the way out: `{}` for empty input, never null, never a JSON string.
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: assertToolInput(block.input, block.name, WIRE),
          })
          break
        case 'tool-response':
          assertBlockRole('a tool result', message.role, 'user', WIRE)
          assertToolRequested(requested, block.id, WIRE)
          content.push(toolResult(block))
          break
        case 'image':
          assertBlockRole('an image', message.role, 'user', WIRE)
          content.push(imageBlock(block))
          break
      }
    }
    if (content.length > 0) out.push({ role: message.role, content })
  }
  return out
}

/**
 * What a guard decision becomes on this wire, or null when nothing goes into the body.
 *
 * A signature is copied byte for byte and never rewritten (invariant 7) — replay hands back the
 * very block that was stored, including a signed block with empty text, which is still a valid
 * signed block and must not be broken up.
 */
function reasoningBlock(
  applied: ThinkingApplication,
  model: ModelInfo,
): AnthropicContentBlock | null {
  switch (applied.kind) {
    case 'drop':
      return null
    case 'keep':
      return applied.block.type === 'thinking'
        ? {
            type: 'thinking',
            thinking: applied.block.text,
            signature: applied.block.signature,
          }
        : { type: 'redacted_thinking', data: applied.block.data }
    case 'text':
      // A downgrade with nothing left to say is skipped: an empty text block is a 400.
      return applied.block.text === '' ? null : { type: 'text', text: applied.block.text }
    case 'echo':
      // This wire has no reasoning echo field — a model reaching rule 4 here is a ModelInfo
      // table error (it declares `reasoning-content` on a wire that carries signed blocks),
      // and inventing a field name or silently downgrading would misreport the audit.
      throw new ProviderInvalidArgumentError(
        `model ${model.id}: ${WIRE} carries no reasoning echo field, so thinking cannot be echoed`,
      )
  }
}

function toolResult(
  block: Extract<ContentBlock, { type: 'tool-response' }>,
): AnthropicContentBlock {
  const content = resultBlocks(block.content)
  const result = { type: 'tool_result', tool_use_id: block.id, is_error: block.isError } as const
  return content.length === 0 ? result : { ...result, content }
}

function resultBlocks(
  blocks: readonly Extract<ContentBlock, { type: 'text' | 'image' }>[],
): AnthropicResultBlock[] {
  const out: AnthropicResultBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image') out.push(imageBlock(block))
    else if (block.text !== '') out.push({ type: 'text', text: block.text })
  }
  return out
}

function imageBlock(block: ImageContentBlock): AnthropicResultBlock {
  assertImageMediaType(block, MEDIA_TYPES, WIRE)
  return {
    type: 'image',
    source: { type: 'base64', media_type: block.mediaType, data: block.data },
  }
}

export interface AnthropicMessagesProviderOptions {
  /** The definition's id. The models this adapter encodes must belong to it. */
  readonly id: ProviderId
  readonly network: HostNetwork
  /** Only `now()`: see ProviderDefinition.create(). Read when an error is mapped. */
  readonly clock: Pick<HostClock, 'now'>
  /** `null` = not configured. `apiKey` and `authToken` are never both absent — see below. */
  readonly apiKey: string | null
  readonly authToken: string | null
  /** Always explicit: an absent baseURL makes the SDK read ANTHROPIC_BASE_URL. */
  readonly baseURL: string
  readonly models: readonly ModelInfo[]
}

/**
 * The Anthropic Messages adapter. `encode()` is the pure function above; `stream()` is the only
 * I/O in the kernel's provider layer.
 *
 * The SDK client is built once, in the constructor, from the injected host capabilities alone:
 *
 * - `fetch` is `network.fetch`, so every byte goes through HostAdapter.network. There is no
 *   module-level fetch and no `globalThis` fallback anywhere (invariant 8);
 * - `maxRetries: 0`, because a retry the kernel cannot see destroys the `requestSeq` /
 *   `physicalAttempt` distinction the Tape records (spec §中止、重试、错误);
 * - both credentials are passed explicitly, with `null` for the unconfigured one. `null` for
 *   BOTH would send the SDK into its credentials / config / profile chain — its only lazy
 *   filesystem path — and `undefined` would make it read ANTHROPIC_API_KEY, so a provider with
 *   neither is refused here, before a client exists;
 * - the two credential headers are pinned through `defaultHeaders` as well, because passing the
 *   credential is not enough: the SDK reads ANTHROPIC_CUSTOM_HEADERS by itself and merges it as
 *   `{ ...envLines, ...defaultHeaders }`, so an `x-api-key:` line in that variable would
 *   REPLACE the credential on every request and invariant 8 would hold only in an environment
 *   nobody had touched. Non-credential lines still travel; dropping those needs an allowlist of
 *   header names, which is the same decision as the spec's open question 1 on `x-stainless-*`;
 * - `webhookKey: null` and `logLevel: 'off'` close the other two doors the SDK opens onto the
 *   environment by itself: it defaults `webhookKey` from ANTHROPIC_WEBHOOK_SIGNING_KEY, and its
 *   logger (`console`) would otherwise be switched on by ANTHROPIC_LOG and print request details
 *   the kernel never decided to print. Two `console.warn` lines in `messages.create` are NOT
 *   behind that logger (they fire for two named models when `thinking.type` is `enabled`); no
 *   client option suppresses them, so only the `thinking` shape those models want will;
 * - the request timeout is left at the SDK's own default (10 minutes, armed around the fetch
 *   that returns the headers and cleared in a `finally`). A stall budget is a policy this spec
 *   does not state, and a number invented here would ship as one.
 */
export class AnthropicMessagesProvider extends BaseProvider {
  readonly id: ProviderId
  readonly #client: Anthropic
  readonly #clock: Pick<HostClock, 'now'>
  readonly #models: readonly ModelInfo[]
  /** The credential values, for redacting them out of an error `detail` that reaches logs. */
  readonly #credentials: readonly string[]

  constructor(options: AnthropicMessagesProviderOptions) {
    super()
    // A blank string is "not configured", not a credential: the SDK would send an empty
    // `x-api-key` header and the endpoint would answer 401, which reads as a wrong key rather
    // than a missing one.
    const apiKey = configured(options.apiKey)
    const authToken = configured(options.authToken)
    if (apiKey === null && authToken === null) {
      // Named after the primary ConfigKey of the `anthropic` definition (spec §内置 provider);
      // `authToken` is the alternative, and the message says so.
      throw new ProviderConfigMissingError(
        options.id,
        'apiKey (or authToken; at least one must be configured)',
      )
    }
    const baseURL = configured(options.baseURL)
    if (baseURL === null) {
      throw new ProviderConfigMissingError(options.id, 'baseURL')
    }
    assertBaseUrl(options.id, baseURL)
    this.id = options.id
    this.#clock = options.clock
    this.#models = [...options.models]
    this.#credentials = [apiKey, authToken].filter((value): value is string => value !== null)
    // Called through a closure rather than handed over as a bare property: the SDK invokes it
    // with `undefined` as the receiver, so a host whose `fetch` is a method would lose its
    // `this`. The reference is captured on this instance and nowhere else.
    const network = options.network
    this.#client = new Anthropic({
      apiKey,
      authToken,
      baseURL,
      maxRetries: 0,
      webhookKey: null,
      logLevel: 'off',
      // The credential headers, pinned against ANTHROPIC_CUSTOM_HEADERS (see above): the env
      // lines are spread FIRST, so these two win whatever their casing there, and `null` means
      // "send no such header" — how the unconfigured credential is kept off the wire.
      defaultHeaders: {
        'x-api-key': apiKey,
        authorization: authToken === null ? null : `Bearer ${authToken}`,
      },
      fetch: (input, init) => fetchThroughHost(network, input, init),
    })
  }

  /** A copy: the definition's table is data the caller must not be able to edit through here. */
  models(): Promise<ModelInfo[]> {
    return Promise.resolve([...this.#models])
  }

  encode(req: ProviderRequest): EncodedRequest {
    return encodeAnthropicMessages(req, this.id)
  }

  /**
   * Streams `encoded.body` as the SDK's raw events, normalised (invariants 1-6).
   *
   * The raw event stream, not `messages.stream()`: the helper accumulates a Message and
   * re-emits derived events, which would put a second reading of the wire between the bytes and
   * the Tape. `withTerminalEvent` owns the terminal event, both abort paths and the ordering
   * buffer, so what the generator below has to do is translate.
   */
  stream(encoded: EncodedRequest, ctx: SendContext): AsyncIterable<StreamEvent> {
    // Synchronous, before anything is wrapped: streaming a body another provider encoded would
    // send its payload to THIS endpoint with THIS provider's credentials. A programmer error.
    if (encoded.providerId !== this.id) {
      throw new ProviderInvalidArgumentError(
        `${WIRE}: this adapter is provider "${this.id}" and cannot stream a request encoded for "${encoded.providerId}"`,
      )
    }
    // Both argument checks throw from the same place. Raised inside the generator instead, an
    // illegal body would reach `mapError` and be recorded in `provider/attempt_completed` as if
    // the endpoint had failed — and `EncodedRequest.body` is typed `unknown`, which phase 2 will
    // rebuild from a Tape.
    const params = streamParams(encoded)
    return withTerminalEvent(() => this.#events(params, ctx), {
      // Read when the error happens, not when the stream is built: a `retry-after` HTTP-date is
      // relative to now.
      mapError: (error) =>
        mapAnthropicError(error, {
          now: this.#clock.now(),
          redact: (text) => redactCredentials(text, this.#credentials),
        }),
      signal: ctx.signal,
    })
  }

  /**
   * The Messages API takes `budget_tokens`, which is the `'budget'` tier — but only for a model
   * that reasons at all: answering `'budget'` for one whose `ModelInfo` says `reasoning: false`
   * would tell the caller a thinking budget is available on a model that 400s on the parameter.
   */
  override thinkingEffortSupport(model: ModelInfo): 'none' | 'budget' | 'effort' {
    return model.reasoning ? 'budget' : 'none'
  }

  async *#events(
    params: Anthropic.MessageCreateParamsStreaming,
    ctx: SendContext,
  ): AsyncIterable<StreamEvent> {
    const stream = await this.#client.messages.create(params, {
      // The SDK's own AbortController is chained to this one, so an abort reaches the fetch the
      // host performed. `withTerminalEvent` still races the signal itself: a socket that has
      // gone quiet must not be able to outlive a Stop.
      signal: ctx.signal,
    })
    yield* normaliseAnthropicEvents(stream)
  }
}

/**
 * A configured credential or URL, or null when the value is absent / blank.
 *
 * `undefined` reads as "not configured" too, not as a crash: with `noUncheckedIndexedAccess` a
 * caller reading `secrets['apiKey']` holds `string | undefined`, and a provider that HAS an
 * authToken must not be refused by a TypeError raised over the credential it does not have.
 */
function configured(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : value
}

/**
 * Refuses a base URL that would send every request to `/v1/v1/messages`.
 *
 * The SDK concatenates `baseURL` with this wire's fixed `/v1/messages` path (collapsing only a
 * doubled slash), so a gateway URL pasted with the `/v1` suffix that every OpenAI-compatible
 * relay documents answers 404 — which reads as a dead gateway or a bad model name rather than as
 * a mistyped setting. Any other base path is left alone: a relay may live under any prefix.
 */
function assertBaseUrl(providerId: ProviderId, baseURL: string): void {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new ProviderInvalidArgumentError(
      `provider ${providerId}: baseURL "${baseURL}" is not an absolute http(s) URL`,
    )
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ProviderInvalidArgumentError(
      `provider ${providerId}: baseURL "${baseURL}" is not an absolute http(s) URL`,
    )
  }
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  if (segments.at(-1) === 'v1') {
    throw new ProviderInvalidArgumentError(
      `provider ${providerId}: baseURL "${baseURL}" already ends in /v1, and ${WIRE} appends /v1/messages; drop the suffix`,
    )
  }
}

/**
 * The host's `fetch`, with an egress denial rewrapped so the SDK cannot lose it.
 *
 * The SDK decides a rejected fetch "timed out" by string-matching the error AND its `cause`, and
 * the `APIConnectionTimeoutError` it then throws carries no `cause` at all — so a denial whose
 * message happens to mention a timeout, or a host that rejects with an abort-shaped error, would
 * reach the mapper as an ordinary connection failure and the phase 2 loop would resend a request
 * the host's egress policy just refused. This wrapper's own message says nothing timeout-like and
 * keeps the denial off `cause`, out of reach of that match; `causeChain` follows it instead.
 */
async function fetchThroughHost(
  network: HostNetwork,
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<Response> {
  try {
    return await network.fetch(input, init)
  } catch (error) {
    if (error instanceof HostNetworkDeniedError) throw new EgressDeniedError(error)
    throw error
  }
}

/** Carries a HostNetworkDeniedError through the SDK's connection layer. Never exported. */
class EgressDeniedError extends Error {
  /** The host's own rejection. NOT on `cause` — see fetchThroughHost. */
  readonly denial: HostNetworkDeniedError

  constructor(denial: HostNetworkDeniedError) {
    super('the host refused this request on egress policy')
    this.name = 'EgressDeniedError'
    this.denial = denial
  }
}

/**
 * `encoded.body` as the SDK's parameter object.
 *
 * Nothing is added on the way out: `stream: true` is part of the body the encoder produced, so
 * `promptHash` covers every byte that travels. The SDK shallow-copies the params before posting
 * them, so handing over the caller's object cannot let it mutate what was hashed.
 */
function streamParams(encoded: EncodedRequest): Anthropic.MessageCreateParamsStreaming {
  const body = encoded.body
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProviderInvalidArgumentError(
      `${WIRE}: stream() takes the object encode() produced, not ${typeof body}`,
    )
  }
  return body as unknown as Anthropic.MessageCreateParamsStreaming
}

/**
 * Translates the Messages wire's raw SSE events into the normalised stream.
 *
 * What it deliberately does NOT do: nothing here is buffered to be "fixed up" later, and no
 * event is invented. A tool call whose `content_block_stop` never arrives (the max_tokens
 * truncation) yields no `tool-call-end`, so invariant 5 keeps it from ever being executed.
 *
 * `index` is the slot THIS adapter assigns (spec §归一化事件流: a block slot, meaningful only
 * within one response). On a well-formed stream it coincides with the vendor's content-block
 * index block for block; a wire that reuses one of its indices gets a fresh slot instead, because
 * a collision makes the caller's fold throw — and an endpoint renumbering its blocks is not a
 * programmer error, so it must not cost the turn its terminal event.
 */
async function* normaliseAnthropicEvents(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
): AsyncIterable<StreamEvent> {
  const blocks = createSlots()
  /** `message_start`'s reading: what a field the final reading leaves null falls back to. */
  let opening: Usage | null = null
  /** The latest `message_delta` reading that arrived without a stop reason. */
  let pending: Usage | null = null
  for await (const event of events) {
    switch (event.type) {
      case 'message_start': {
        // The first of two usage readings; only the `final: true` one reaches the Tape.
        const usage = usageEvent(event.message.usage, false, null)
        opening = usage
        yield { type: 'usage', usage }
        break
      }
      case 'content_block_start': {
        const block = event.content_block
        switch (block.type) {
          case 'text': {
            const index = blocks.open(event.index, 'text')
            // The wire opens a text block with `text: ''`; anything else is content that
            // arrived and would otherwise be dropped.
            if (block.text !== '') yield { type: 'text-delta', index, text: block.text }
            break
          }
          case 'thinking': {
            const index = blocks.open(event.index, 'thinking')
            if (block.thinking !== '') {
              yield { type: 'thinking-delta', index, text: block.thinking }
            }
            // Byte for byte; an empty one is "no signature yet", never a signature (invariant 7).
            if (block.signature !== '') {
              blocks.signed(event.index)
              yield { type: 'thinking-signature', index, signature: block.signature }
            }
            break
          }
          case 'redacted_thinking':
            yield {
              type: 'redacted-thinking',
              index: blocks.open(event.index, 'redacted'),
              data: block.data,
            }
            break
          case 'tool_use': {
            // A call the vendor's own container runs (code execution) is not ours to execute:
            // forwarding it would hand the kernel's tool executor a call the model never asked
            // us for. An absent `caller` is the direct shape — the field is newer than the wire
            // and compatible gateways omit it.
            if (!isDirectCall(block.caller)) {
              blocks.open(event.index, 'skipped')
              break
            }
            const index = blocks.openCall(event.index, block.id, block.name)
            yield { type: 'tool-call-start', index, id: block.id, name: block.name }
            break
          }
          default:
            // Server-side tool blocks (web search, code execution, container upload…). Phase 1
            // requests none of them, and there is no normalised event that carries one, so the
            // block and its deltas are skipped rather than mapped onto something they are not.
            blocks.open(event.index, 'skipped')
            break
        }
        break
      }
      case 'content_block_delta': {
        const delta = event.delta
        switch (delta.type) {
          case 'text_delta': {
            const index = blocks.deltaSlot(event.index, 'text')
            if (index !== null) yield { type: 'text-delta', index, text: delta.text }
            break
          }
          case 'thinking_delta': {
            const index = blocks.deltaSlot(event.index, 'thinking')
            if (index !== null) yield { type: 'thinking-delta', index, text: delta.thinking }
            break
          }
          case 'signature_delta': {
            const index = blocks.signatureSlot(event.index)
            if (index !== null) {
              yield { type: 'thinking-signature', index, signature: delta.signature }
            }
            break
          }
          case 'input_json_delta': {
            const open = blocks.call(event.index)
            // No open tool block: the fragments belong to a server-side tool we skipped.
            if (open === null) break
            open.json += delta.partial_json
            yield { type: 'tool-call-args-delta', index: open.slot, json: delta.partial_json }
            break
          }
          case 'citations_delta':
            // Citations ride on a text block we already forwarded; phase 1 asks for none.
            break
        }
        break
      }
      case 'content_block_stop': {
        const closed = blocks.close(event.index)
        // Text, thinking and redacted blocks need no closing event: they were complete as they
        // arrived.
        if (closed === null || closed.call === null) break
        const input = parseToolArguments(closed.json)
        if (input === null) {
          // Arguments we cannot parse are not a tool call. Reported as the terminal error rather
          // than thrown, so the text and thinking that did arrive are still kept, and NOT
          // coerced to `{}`, which would invent an empty argument set for a call that had one.
          yield {
            type: 'error',
            code: 'unknown',
            retryable: isRetryableByDefault('unknown'),
            providerCode: 'malformed_tool_input',
            detail: `${WIRE}: tool call "${closed.call.name}" (block ${closed.slot}) sent arguments that are not a JSON object`,
          }
          return
        }
        yield {
          type: 'tool-call-end',
          index: closed.slot,
          id: closed.call.id,
          name: closed.call.name,
          input,
        }
        break
      }
      case 'message_delta': {
        const reason = event.delta.stop_reason
        // Usage first, then the terminal: invariant 1 puts every reading before the stop, and
        // exactly ONE of them is the final reading — so a frame that did not end the turn (the
        // wire allows `stop_reason: null`) yields a non-final reading and is remembered instead.
        const usage = usageEvent(event.usage, reason !== null, opening)
        yield { type: 'usage', usage }
        if (reason !== null) {
          yield { type: 'stop', reason: stopReasonOf(reason), providerReason: reason }
          return
        }
        pending = usage
        break
      }
      case 'message_stop':
        // Reached only when `message_delta` carried no stop reason: the turn ended and we cannot
        // say why. Guessing `end-turn` would let the phase 2 loop treat a turn the vendor never
        // called finished as a completed one. The last reading becomes the final one here, so a
        // turn that ends this way still records what it cost.
        if (pending !== null) yield { type: 'usage', usage: { ...pending, final: true } }
        yield { type: 'stop', reason: 'unknown', providerReason: null }
        return
    }
  }
}

/** Absent counts as `direct`: the field is newer than the wire, and gateways omit it. */
function isDirectCall(caller: { readonly type: string } | null | undefined): boolean {
  return caller == null || caller.type === 'direct'
}

/** One open content block: the slot this adapter gave it, and what it holds. */
interface OpenBlock {
  /** The normalised `index`. Handed out once and never reused within a response. */
  readonly slot: number
  readonly kind: BlockKind
  /** `tool` only: the call's identity, which its `tool-call-end` has to repeat. */
  readonly call: { readonly id: string; readonly name: string } | null
  /** `tool` only: the argument fragments so far. */
  json: string
  /** `thinking` only: a signature has arrived, and a signature is never rewritten. */
  signed: boolean
}

type BlockKind = 'text' | 'thinking' | 'redacted' | 'tool' | 'skipped'

/**
 * The adapter's block slots, keyed by the vendor's content-block index.
 *
 * Slots are handed out in arrival order, one per opened block, and never reused — the vendor's
 * index is only the key its events arrive under. A stream that opens two blocks at index 0, or
 * sends a thinking delta on the index a text block is open at, therefore produces two slots
 * rather than one slot the caller's fold would refuse to hold both kinds in.
 */
function createSlots() {
  const open = new Map<number, OpenBlock>()
  let next = 0
  const allocate = (index: number, kind: BlockKind, call: OpenBlock['call'] = null): OpenBlock => {
    const block: OpenBlock = { slot: next, kind, call, json: '', signed: false }
    next += 1
    open.set(index, block)
    return block
  }
  return {
    /** Opens a block with no identity of its own (text, thinking, redacted, skipped). */
    open(index: number, kind: BlockKind): number {
      return allocate(index, kind).slot
    },
    openCall(index: number, id: string, name: string): number {
      return allocate(index, 'tool', { id, name }).slot
    },
    /**
     * The slot a text / thinking delta belongs to: the open block when its kind matches, a
     * fresh slot when the index holds nothing or holds another kind, and null when the block
     * open there is one we skipped (its deltas are not content of ours).
     */
    deltaSlot(index: number, kind: 'text' | 'thinking'): number | null {
      const block = open.get(index)
      if (block === undefined) return allocate(index, kind).slot
      if (block.kind === 'skipped') return null
      return block.kind === kind ? block.slot : allocate(index, kind).slot
    },
    /** As deltaSlot, for a signature: a second one for the same block opens a fresh slot. */
    signatureSlot(index: number): number | null {
      const block = open.get(index)
      if (block?.kind === 'skipped') return null
      if (block === undefined || block.kind !== 'thinking' || block.signed) {
        const fresh = allocate(index, 'thinking')
        fresh.signed = true
        return fresh.slot
      }
      block.signed = true
      return block.slot
    },
    /** Marks the block open at `index` as signed (a signature that came with its start). */
    signed(index: number): void {
      const block = open.get(index)
      if (block !== undefined) block.signed = true
    },
    /** The open tool call at `index`, for appending an argument fragment. */
    call(index: number): OpenBlock | null {
      const block = open.get(index)
      return block !== undefined && block.call !== null ? block : null
    },
    close(index: number): OpenBlock | null {
      const block = open.get(index)
      if (block === undefined) return null
      open.delete(index)
      return block
    },
  }
}

/**
 * Invariant 6: empty arguments are `{}`. Null when the fragments do not form a JSON object,
 * which is a truncated or garbled body rather than an empty call.
 */
function parseToolArguments(json: string): Record<string, unknown> | null {
  // The wire sends no `input_json_delta` at all for a call with no arguments.
  if (json.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** The fields the two usage shapes of this wire share; `message_delta`'s are all nullable. */
interface AnthropicWireUsage {
  readonly input_tokens?: number | null
  readonly output_tokens?: number | null
  readonly cache_read_input_tokens?: number | null
  readonly cache_creation_input_tokens?: number | null
  readonly output_tokens_details?: { readonly thinking_tokens: number } | null
}

/**
 * One usage reading, with `base` the previous reading of the same response (null for the first).
 *
 * A field the `message_delta` frame leaves null was not RESTATED, not reset: the SDK's own types
 * make every field of that frame nullable but `output_tokens`, and both frames report cumulative
 * totals, so the reading falls back per field to what `message_start` said — the only statement
 * the wire made about it. Zeroing instead would write "0 input tokens, 0 cached" into
 * `provider/attempt_completed` for a turn that had 25 and 12, and the fact is the audit.
 *
 * Vendor-specific counters (`service_tier`, `server_tool_use`, `cache_creation` by ttl) stay off
 * `Usage` by design — they belong in the fact's `meta`.
 */
function usageEvent(usage: AnthropicWireUsage, final: boolean, base: Usage | null): Usage {
  return {
    inputTokens: tokenCount(usage.input_tokens) ?? base?.inputTokens ?? 0,
    outputTokens: tokenCount(usage.output_tokens) ?? base?.outputTokens ?? 0,
    cacheReadTokens: tokenCount(usage.cache_read_input_tokens) ?? base?.cacheReadTokens ?? 0,
    cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens) ?? base?.cacheWriteTokens ?? 0,
    reasoningTokens:
      tokenCount(usage.output_tokens_details?.thinking_tokens) ?? base?.reasoningTokens ?? 0,
    final,
  }
}

/** The number the wire stated, or null when it stated nothing usable. */
function tokenCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The wire's stop reasons. A Record over the SDK's own union, so a reason a later SDK adds fails
 * to compile until it is mapped; a value the pinned SDK does not know reads as `unknown` with
 * the raw string kept in `providerReason`.
 */
const STOP_REASONS: Readonly<Record<Anthropic.StopReason, StopReason>> = {
  end_turn: 'end-turn',
  max_tokens: 'max-tokens',
  stop_sequence: 'stop-sequence',
  tool_use: 'tool-use',
  pause_turn: 'pause-turn',
  refusal: 'refusal',
  model_context_window_exceeded: 'context-overflow',
}

function stopReasonOf(raw: string): StopReason {
  return Object.hasOwn(STOP_REASONS, raw) ? STOP_REASONS[raw as Anthropic.StopReason] : 'unknown'
}

interface AnthropicErrorContext {
  /** A `HostClock.now()` reading, for `retryAfterMs()`'s HTTP-date branch. */
  readonly now: number
  /** Applied to `detail`, which reaches logs: the credential must never appear in one. */
  readonly redact: (text: string) => string
}

/**
 * Whatever the SDK threw, as the `error` event that replaces it (invariant 3).
 *
 * Three shapes arrive here, and the mapping has to hold for all of them:
 * - an HTTP error, with `status` and `headers`;
 * - a mid-stream `error` frame, which the SDK also throws as an APIError but with `status`
 *   undefined; it sets `.type` from the frame directly and hands over the still-streaming 200's
 *   own `Headers`, and the vendor's type is also readable at `err.error.error.type`;
 * - a connection-layer failure, where the host's own rejection sits in the `cause` chain.
 */
function mapAnthropicError(
  error: unknown,
  ctx: AnthropicErrorContext,
): Extract<StreamEvent, { type: 'error' }> {
  const chain = causeChain(error)
  const providerCode = providerCodeOf(error)
  const status = statusOf(error)
  const code = classifyAnthropicError(error, chain, status, providerCode)
  const event: Extract<StreamEvent, { type: 'error' }> = {
    type: 'error',
    code,
    retryable: isRetryableByDefault(code),
    providerCode,
    detail: detailOf(chain, ctx.redact),
  }
  if (status !== undefined) event.status = status
  const delay = retryAfterMs(headersOf(error), ctx.now)
  if (delay !== null) event.retryAfterMs = delay
  return event
}

function classifyAnthropicError(
  error: unknown,
  chain: readonly unknown[],
  status: number | undefined,
  providerCode: string | null,
): ProviderErrorCode {
  // First, and anywhere in the chain: the host refused to let the request out. The SDK wraps a
  // rejected fetch as `new APIConnectionError({ cause })`, so the denial arrives one or two
  // links down, and `HostNetworkDeniedError` is a bare `extends Error` whose `name` is still
  // 'Error' — instanceof is the only way to recognise it (see plan.md, step 2). The adapter's own
  // EgressDeniedError counts too: it is how the denial survives the SDK's timeout branch.
  if (chain.some(isEgressDenial)) return 'egress-denied'
  if (status !== undefined) return statusCode(status, messageOf(error))
  if (providerCode !== null && Object.hasOwn(ERROR_TYPES, providerCode)) {
    const code = ERROR_TYPES[providerCode as AnthropicErrorType]
    return code === 'invalid-request' && looksLikeContextOverflow(messageOf(error))
      ? 'context-overflow'
      : code
  }
  // A failed connection, including the SDK's own timeout (a subclass of this one). A bare
  // TypeError — what a web `fetch` rejects with — is deliberately NOT read as one: the SDK wraps
  // every rejected fetch in APIConnectionError, so a TypeError that reaches here was raised by
  // this adapter's own normalisation, and advertising our bug as retryable would have the phase 2
  // loop resend a request nothing was wrong with.
  if (chain.some((link) => link instanceof APIConnectionError)) return 'network'
  // Not classified, so not resent: `unknown` is the one code that is never retryable by
  // default, and a payload whose failure we could not explain is the wrong thing to repeat.
  return 'unknown'
}

function isEgressDenial(link: unknown): boolean {
  return link instanceof HostNetworkDeniedError || link instanceof EgressDeniedError
}

function statusCode(status: number, message: string): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (status === 529) return 'overloaded'
  if (status >= 500) return 'server'
  if (status === 400 && looksLikeContextOverflow(message)) return 'context-overflow'
  // The two 4xx that resending does fix. The vendor's own `timeout_error` reads as `server` when
  // no status accompanies it (see ERROR_TYPES), and gaining a status must not turn a transient
  // timeout into a permanent refusal.
  if (status === 408 || status === 425) return 'server'
  // Every other 4xx is a request this payload cannot fix by being sent again: a bad model name
  // (404), an unsupported field (422), a body too large (413).
  if (status >= 400) return 'invalid-request'
  // A 2xx / 3xx that still produced an error is a shape we do not understand.
  return 'unknown'
}

type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'timeout_error'
  | 'overloaded_error'
  | 'api_error'
  | 'billing_error'

/**
 * The vendor's own `error.type` vocabulary, which is all a mid-stream error frame carries (no
 * status). `timeout_error` and `api_error` are the vendor answering, not our connection failing,
 * so both read as `server`; `billing_error` is not retryable, because resending will fail the
 * same way until a human tops the account up.
 */
const ERROR_TYPES: Readonly<Record<AnthropicErrorType, ProviderErrorCode>> = {
  invalid_request_error: 'invalid-request',
  authentication_error: 'auth',
  permission_error: 'auth',
  not_found_error: 'invalid-request',
  rate_limit_error: 'rate-limit',
  timeout_error: 'server',
  overloaded_error: 'overloaded',
  api_error: 'server',
  billing_error: 'invalid-request',
}

/**
 * A context-window refusal, which the wire reports as an ordinary invalid request. Matched on
 * the vendor's documented wording ("prompt is too long: N tokens > M maximum") plus the two
 * phrasings compatible gateways use, so the phase 2 loop can tell "trim the context and retry"
 * apart from "this request is malformed".
 */
const CONTEXT_OVERFLOW = /prompt is too long|too many tokens|context[ _-]?(?:window|length)/i

function looksLikeContextOverflow(message: string): boolean {
  return CONTEXT_OVERFLOW.test(message)
}

/** How deep a `cause` chain is followed. Two links is the SDK's own depth; five is slack. */
const MAX_CAUSE_DEPTH = 5

/** The error and its `cause` chain, bounded and cycle-safe. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current: unknown = error
  while (current !== null && current !== undefined && chain.length < MAX_CAUSE_DEPTH) {
    if (chain.includes(current)) break
    chain.push(current)
    current = nextLink(current)
  }
  return chain
}

/** The next link down: `cause`, or the denial an EgressDeniedError carries beside it. */
function nextLink(error: unknown): unknown {
  if (error instanceof EgressDeniedError) return error.denial
  return error instanceof Error ? error.cause : undefined
}

/** The `error.type` the vendor named, from either the typed field or the nested error body. */
function providerCodeOf(error: unknown): string | null {
  const direct = stringField(error, 'type')
  if (direct !== null) return direct
  const body = objectField(error, 'error')
  return stringField(objectField(body, 'error'), 'type')
}

function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const status: unknown = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

/** `err.headers` when it is a Headers-like object; `retryAfterMs()` only needs `get()`. */
function headersOf(error: unknown): HeaderLookup | null {
  const headers = objectField(error, 'headers')
  if (headers === null) return null
  return typeof (headers as { get?: unknown }).get === 'function' ? (headers as HeaderLookup) : null
}

/**
 * The text the classifier reads: the thrown error's message plus the vendor's own message out of
 * the error body, because a 400's explanation lives in the body and the SDK's message is a
 * summary of it.
 */
function messageOf(error: unknown): string {
  const own = error instanceof Error ? error.message : ''
  const nested = stringField(objectField(objectField(error, 'error'), 'error'), 'message') ?? ''
  return `${own} ${nested}`
}

function stringField(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object') return null
  const field: unknown = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field !== '' ? field : null
}

function objectField(value: unknown, key: string): object | null {
  if (value === null || typeof value !== 'object') return null
  const field: unknown = (value as Record<string, unknown>)[key]
  return field !== null && typeof field === 'object' ? field : null
}

/** The ceiling on `detail`: a log line, not a transcript of the vendor's body. */
const MAX_DETAIL_LENGTH = 500

/**
 * `detail` is for logs only and is never rendered — see the StreamEvent definition.
 *
 * Redacted BEFORE the cap, never after: a credential that straddles the 500-character boundary
 * would otherwise survive as the prefix the cap left behind, and a prefix of a key is still a key
 * in a log. A gateway that echoes the request into a long error message is the realistic case.
 */
function detailOf(chain: readonly unknown[], redact: (text: string) => string): string {
  const text = redact(chain.map(describeLink).join(' <- '))
  return text.length <= MAX_DETAIL_LENGTH ? text : `${text.slice(0, MAX_DETAIL_LENGTH)}…`
}

function describeLink(link: unknown): string {
  if (link instanceof Error) {
    // `name` is 'Error' for most SDK classes (they do not set it), hence the constructor name.
    return `${link.constructor.name}: ${link.message}`
  }
  return String(link)
}

/**
 * Removes the configured credentials from a message before it becomes `detail`.
 *
 * Nothing in the SDK puts a key in an error message today; this exists because `detail` is the
 * one field of the event that carries free text out of the SDK, and "today" is not a property
 * the pin can guarantee. Replacing rather than dropping the whole message keeps the diagnosis.
 */
function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text
  for (const credential of credentials) {
    if (credential === '') continue
    out = out.split(credential).join('[redacted]')
  }
  return out
}
