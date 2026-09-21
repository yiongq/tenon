/**
 * The OpenAI chat-completions wire adapter (spec 01 §Provider 层): the pure `encode()` below, and
 * `OpenAIChatProvider` — the only I/O in this file — at the bottom.
 *
 * `encodeOpenAIChat()` stays a free function that takes no client: the wire format is testable
 * without one, and the hashes are reproducible from a Tape alone. The class delegates to it in one
 * line. The two OpenAI-compatible vendors the spec names (zhipu, ollama) differ only by
 * `ModelInfo` — `requestParams` carries zhipu's non-OpenAI `thinking` parameter and
 * `reasoningEchoField` carries ollama's `reasoning` spelling.
 *
 * `stream: true` is part of the body here (unlike the Anthropic wire, where the SDK sets it),
 * because `stream_options.include_usage` is only legal alongside it and the usage opt-in is
 * what this wire needs to report usage at all.
 *
 * Every key is written only when it has a value: canonicalJson (and therefore `promptHash`)
 * refuses an undefined-valued key.
 */
import OpenAI, { APIConnectionError, APIError } from 'openai'
import type { HostClock, HostNetwork } from '../../host/adapter.js'
import { BaseProvider, withTerminalEvent } from '../base.js'
import {
  ProviderConfigMissingError,
  ProviderInvalidArgumentError,
  causeChain,
  errorDetail,
  errorHeaders,
  errorMessage,
  errorStatus,
  hasEgressDenial,
  isRetryableByDefault,
  looksLikeContextOverflow,
  objectField,
  redactCredentials,
  retryAfterMs,
  statusErrorCode,
  stringField,
} from '../errors.js'
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
  canonicalText,
  effectiveMaxTokens,
  guardReasoning,
  hasSystemPrompt,
  mergeRequestParams,
  sealEncoded,
  thinkingTargetFor,
} from './shared.js'
import type { ImageContentBlock } from './shared.js'
import {
  assertBaseUrl,
  configuredValue,
  fetchThroughHost,
  parseToolArguments,
  tokenCount,
} from './transport.js'

const WIRE = 'openai-chat'

/** The formats the vision part of this wire documents, carried as base64 data URLs. */
const MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/**
 * The keys `requestParams` may not set on this wire (see mergeRequestParams): every key this
 * encoder writes. `stream` and `stream_options` are structural — streaming off would hand the SDK
 * a non-stream response shape the adapter's whole event loop cannot read, and `include_usage: false`
 * on a `usageNeedsOptIn` model would silently empty the `usage` of every `provider/attempt_completed`
 * fact. `max_tokens`, `tools` and `temperature` are what the request snapshot and
 * `toolDefinitionsHash` are taken over. A vendor that spells the output limit differently sets its
 * own key (this wire's own `max_completion_tokens`, say), which is a passthrough like any other.
 *
 * `thinking` is deliberately NOT here: this encoder never writes it, and `requestParams` is the
 * seam the spec chose for zhipu's non-OpenAI thinking parameter (§内置 provider). `system` is
 * unreachable for another reason — on this wire the system prompt lives inside `messages`.
 */
const RESERVED_KEYS: readonly string[] = [
  'model',
  'messages',
  'max_tokens',
  'stream',
  'stream_options',
  'temperature',
  'tools',
]

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** A message's content: a bare string when it is one text part, else the parts array. */
export type OpenAIContent = string | OpenAIContentPart[]

export interface OpenAIToolCall {
  id: string
  type: 'function'
  /** `arguments` is a JSON STRING on this wire: '{}' for empty input, never 'null'. */
  function: { name: string; arguments: string }
}

export interface OpenAIAssistantMessage {
  role: 'assistant'
  content?: OpenAIContent
  tool_calls?: OpenAIToolCall[]
  /** The two spellings `ModelInfo.reasoningEchoField` may name; at most one is ever written. */
  reasoning_content?: string
  reasoning?: string
}

export type OpenAIWireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: OpenAIContent }
  | OpenAIAssistantMessage
  | { role: 'tool'; tool_call_id: string; content: OpenAIContent }

export interface OpenAIToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/**
 * Encodes a ProviderRequest into a chat-completions body.
 *
 * `req.thinking` has no counterpart on this wire and is not encoded: a vendor that takes a
 * thinking parameter (zhipu) declares it in `ModelInfo.requestParams`, which is the seam the
 * spec chose for exactly this. The request snapshot still records what was asked for.
 */
export function encodeOpenAIChat(req: ProviderRequest, providerId: ProviderId): EncodedRequest {
  assertModelBelongs(req.model, providerId)
  const decisions: ThinkingDecision[] = []
  const messages = encodeMessages(req, decisions)
  // The leading system message is not a turn: a body carrying it alone has no conversation in it.
  assertHasMessages(messages.filter((message) => message.role !== 'system').length, WIRE)
  const tools = encodeTools(req.tools)
  const body: Record<string, unknown> = {
    // The WIRE id, never `canonicalId`: the endpoint only knows its own name.
    model: req.model.id,
    messages,
    max_tokens: effectiveMaxTokens(req),
    stream: true,
  }
  // Without the opt-in this wire reports no usage at all; with it, the usage arrives in a
  // trailing chunk after the finish reason.
  if (req.model.usageNeedsOptIn) body.stream_options = { include_usage: true }
  if (tools.length > 0) body.tools = tools
  if (req.temperature !== undefined) body.temperature = req.temperature
  mergeRequestParams(body, req.model, RESERVED_KEYS)
  return sealEncoded(providerId, req.model.id, body, tools, decisions)
}

function encodeTools(tools: readonly ToolSpec[] | undefined): OpenAIToolDefinition[] {
  if (tools === undefined) return []
  return tools.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }))
}

/**
 * Maps the internal transcript onto the wire, in order, with the system prompt as a leading
 * system message.
 *
 * A message whose content is empty after the thinking guard is omitted entirely, which can
 * leave two user turns adjacent; that is left as it is. This wire accepts consecutive same-role
 * messages, and merging them in the encoder would invent a turn boundary no fact records.
 *
 * Tool responses become their own `tool` messages and are emitted BEFORE the rest of their
 * turn: the wire pairs each of them with the `tool_calls` of the preceding assistant message,
 * not with whatever else the user said in the same turn. That hoist is only sound because a tool
 * result is confined to a user turn and a tool call to an assistant one — the two halves are
 * therefore always in different messages, and the result can never be hoisted ahead of the
 * `tool_calls` it answers.
 */
function encodeMessages(req: ProviderRequest, decisions: ThinkingDecision[]): OpenAIWireMessage[] {
  const target = thinkingTargetFor(req)
  const requested = new Set<string>()
  const out: OpenAIWireMessage[] = []
  if (hasSystemPrompt(req.system)) out.push({ role: 'system', content: req.system })
  for (const message of req.messages) {
    const parts: OpenAIContentPart[] = []
    const toolCalls: OpenAIToolCall[] = []
    const toolMessages: OpenAIWireMessage[] = []
    let echo: { field: 'reasoning_content' | 'reasoning'; text: string } | null = null
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          // An empty text part carries nothing and is rejected by parts of this wire.
          if (block.text !== '') parts.push({ type: 'text', text: block.text })
          break
        case 'thinking':
        case 'redacted-thinking': {
          // Reasoning is the assistant's own output: the reasoning field lives on an assistant
          // message, and a downgraded block surfacing as user text would put the model's
          // reasoning in the user's mouth.
          assertBlockRole('a reasoning block', message.role, 'assistant', WIRE)
          const applied = guardReasoning(block, target, decisions)
          const surfaced = reasoning(applied, req.model)
          if (surfaced === null) break
          if (surfaced.kind === 'text') parts.push(surfaced.part)
          else {
            // One field per turn on this wire: several echoed blocks are concatenated in block
            // order, which is the order their deltas arrived in as one field to begin with.
            echo =
              echo === null
                ? surfaced.echo
                : { field: surfaced.echo.field, text: echo.text + surfaced.echo.text }
          }
          break
        }
        case 'tool-request':
          // Only an assistant message has a `tool_calls` field on this wire. Checked before the id
          // is remembered: a call the wire would refuse must not legitimise the result that
          // follows it, and dropping the call silently would leave that result referencing
          // something the endpoint never saw.
          assertBlockRole('a tool call', message.role, 'assistant', WIRE)
          requested.add(block.id)
          toolCalls.push({
            id: block.id,
            type: 'function',
            // Invariant 6 on the way out: canonicalJson gives '{}' for empty input, and a
            // deterministic key order for everything else, so the same input hashes the same.
            function: {
              name: block.name,
              arguments: canonicalText(
                assertToolInput(block.input, block.name, WIRE),
                `the arguments of tool call "${block.name}"`,
              ),
            },
          })
          break
        case 'tool-response':
          // A `tool` message answers the assistant message before it. In the same message as its
          // own call, the hoist below would emit the answer first — a body the wire rejects — so
          // this is where the two halves are kept in different turns.
          assertBlockRole('a tool result', message.role, 'user', WIRE)
          assertToolRequested(requested, block.id, WIRE)
          toolMessages.push({
            role: 'tool',
            tool_call_id: block.id,
            // `isError` has no field on this wire and is not encoded: the kernel never writes
            // a sentence (00-foundation §国际化), so there is nothing to mark it with here.
            content: contentOf(resultParts(block.content)) ?? '',
          })
          break
        case 'image':
          // Only a `user` message can carry an image on this wire: assistant and tool content
          // parts are text-only, so there is nowhere to put one.
          assertBlockRole('an image', message.role, 'user', WIRE)
          parts.push(imagePart(block))
          break
      }
    }
    out.push(...toolMessages)
    const turn = wireMessage(message.role, parts, toolCalls, echo)
    if (turn !== null) out.push(turn)
  }
  return out
}

/**
 * The turn itself, or null when the guard left nothing to send. A reasoning echo only ever
 * reaches here for an assistant turn — see the role guard in encodeMessages().
 */
function wireMessage(
  role: 'user' | 'assistant',
  parts: readonly OpenAIContentPart[],
  toolCalls: readonly OpenAIToolCall[],
  echo: { field: 'reasoning_content' | 'reasoning'; text: string } | null,
): OpenAIWireMessage | null {
  const content = contentOf(parts)
  // An echo with no text adds nothing, so it is not what keeps a turn alive.
  const echoed = echo !== null && echo.text !== '' ? echo : null
  if (role === 'user') return content === null ? null : { role: 'user', content }
  const message: OpenAIAssistantMessage = { role: 'assistant' }
  if (content !== null) message.content = content
  // An assistant message's `content` is required unless it carries `tool_calls`, so an echo on
  // its own does not hold the turn up: the accepted empty content goes with it rather than the
  // echo being dropped. Step 11 confirms '' against a live reasoning-content endpoint.
  else if (echoed !== null && toolCalls.length === 0) message.content = ''
  if (toolCalls.length > 0) message.tool_calls = [...toolCalls]
  if (echoed !== null) message[echoed.field] = echoed.text
  if (content === null && toolCalls.length === 0 && echoed === null) return null
  return message
}

/**
 * The content shape. One text part becomes the bare string every OpenAI-compatible endpoint
 * accepts (ollama's compatibility layer included); anything else becomes the parts array. Null
 * means there is no content at all, which is what makes an empty turn detectable.
 */
function contentOf(parts: readonly OpenAIContentPart[]): OpenAIContent | null {
  if (parts.length === 0) return null
  const only = parts.length === 1 ? parts[0] : undefined
  if (only?.type === 'text') return only.text
  return [...parts]
}

/** What a guard decision surfaces on this wire, or null when nothing does. */
function reasoning(
  applied: ThinkingApplication,
  model: ModelInfo,
):
  | { kind: 'text'; part: OpenAIContentPart }
  | { kind: 'echo'; echo: { field: 'reasoning_content' | 'reasoning'; text: string } }
  | null {
  switch (applied.kind) {
    case 'drop':
      return null
    case 'echo':
      return applied.text === ''
        ? null
        : { kind: 'echo', echo: { field: applied.field, text: applied.text } }
    case 'text':
      // A downgrade with nothing left to say adds no part.
      return applied.block.text === ''
        ? null
        : { kind: 'text', part: { type: 'text', text: applied.block.text } }
    case 'keep':
      // This wire has no signed thinking blocks and no opaque redacted ones: a model reaching
      // rule 7 here declares `signed-blocks` on a wire that cannot carry them, which is a
      // ModelInfo table error. A signature is never rewritten into some other field.
      throw new ProviderInvalidArgumentError(
        `model ${model.id}: ${WIRE} carries no signed thinking blocks, so one cannot be replayed`,
      )
  }
}

function resultParts(
  blocks: readonly Extract<ContentBlock, { type: 'text' | 'image' }>[],
): OpenAIContentPart[] {
  const out: OpenAIContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'image') {
      // A tool message is text-only on this wire — see the image case in encodeMessages().
      throw new ProviderInvalidArgumentError(
        `${WIRE}: a tool result cannot carry an image; this wire has no place to put one`,
      )
    }
    if (block.text !== '') out.push({ type: 'text', text: block.text })
  }
  return out
}

function imagePart(block: ImageContentBlock): OpenAIContentPart {
  assertImageMediaType(block, MEDIA_TYPES, WIRE)
  return { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } }
}

export interface OpenAIChatProviderOptions {
  /** The definition's id. The models this adapter encodes must belong to it. */
  readonly id: ProviderId
  readonly network: HostNetwork
  /** Only `now()`: see ProviderDefinition.create(). Read when an error is mapped. */
  readonly clock: Pick<HostClock, 'now'>
  /**
   * The credential, which on this wire is never absent: `null` and `''` make the SDK throw
   * `Missing credentials`, and `undefined` makes it read OPENAI_API_KEY. A provider that needs no
   * key therefore configures one anyway (ollama's default `'ollama'`, spec §内置 provider).
   */
  readonly apiKey: string | null
  /** Always explicit: a blank baseURL makes the SDK fall back to api.openai.com — see below. */
  readonly baseURL: string
  readonly models: readonly ModelInfo[]
}

/**
 * The OpenAI-compatible chat-completions adapter, shared by every vendor speaking this wire.
 *
 * The SDK client is built once, in the constructor, from the injected host capabilities alone:
 *
 * - `fetch` is `network.fetch`, so every byte goes through HostAdapter.network. There is no
 *   module-level fetch and no `globalThis` fallback anywhere (invariant 8);
 * - `maxRetries: 0`, because a retry the kernel cannot see destroys the `requestSeq` /
 *   `physicalAttempt` distinction the Tape records (spec §中止、重试、错误);
 * - `apiKey` is a non-empty string passed explicitly. A missing one is refused here, before a
 *   client exists: `undefined` would make the SDK read OPENAI_API_KEY, and `null` / `''` would
 *   have it throw its own `Missing credentials` — an error the caller cannot tell from a bug;
 * - `baseURL` is explicit AND non-blank, which matters more here than on the other wire: the SDK
 *   resolves a falsy baseURL to `https://api.openai.com/v1`, so a zhipu provider whose baseURL
 *   went missing would send a zhipu key to OpenAI. A blank value is a configuration error;
 * - `organization`, `project`, `adminAPIKey` and `webhookSecret` are pinned to `null` because each
 *   of them otherwise defaults to an environment variable (OPENAI_ORG_ID, OPENAI_PROJECT_ID,
 *   OPENAI_ADMIN_KEY, OPENAI_WEBHOOK_SECRET). `null` means "send no such header";
 * - the credential header is pinned through `defaultHeaders` as well, because passing the
 *   credential is not enough: the SDK reads OPENAI_CUSTOM_HEADERS by itself and merges it as
 *   `buildHeaders([envLines, defaultHeaders])`, and `defaultHeaders` is applied AFTER the
 *   authentication header — so an `Authorization:` line in that variable would replace the
 *   credential on every request and invariant 8 would hold only in an environment nobody had
 *   touched. Non-credential lines still travel; dropping those needs an allowlist of header names,
 *   which is the same decision as the spec's open question 1 on `x-stainless-*`;
 * - `logLevel: 'off'` closes the last door: the logger (`console`) would otherwise be switched on
 *   by OPENAI_LOG and print request details the kernel never decided to print;
 * - the request timeout is left at the SDK's own default (10 minutes). A stall budget is a policy
 *   this spec does not state, and a number invented here would ship as one.
 *
 * `thinkingEffortSupport()` is deliberately NOT overridden: this wire has no thinking parameter of
 * its own, and a vendor's own (zhipu's `thinking` / `reasoning_effort`) travels through
 * `ModelInfo.requestParams`, which the kernel does not interpret. 'none' is the honest answer for
 * the seam the caller can actually drive.
 */
export class OpenAIChatProvider extends BaseProvider {
  readonly id: ProviderId
  readonly #client: OpenAI
  readonly #clock: Pick<HostClock, 'now'>
  readonly #models: readonly ModelInfo[]
  /** The credential value, for redacting it out of an error `detail` that reaches logs. */
  readonly #credentials: readonly string[]

  constructor(options: OpenAIChatProviderOptions) {
    super()
    const apiKey = configuredValue(options.apiKey)
    if (apiKey === null) throw new ProviderConfigMissingError(options.id, 'apiKey')
    const baseURL = configuredValue(options.baseURL)
    if (baseURL === null) throw new ProviderConfigMissingError(options.id, 'baseURL')
    // `/v1` is where this wire lives, so the suffix is allowed here (it is refused on the
    // Anthropic wire, whose SDK appends its own). The SDK collapses the join either way.
    assertBaseUrl(options.id, baseURL, { wire: WIRE, refuseV1Suffix: false })
    this.id = options.id
    this.#clock = options.clock
    this.#models = [...options.models]
    this.#credentials = [apiKey]
    // Called through a closure rather than handed over as a bare property: the SDK invokes it
    // with `undefined` as the receiver, so a host whose `fetch` is a method would lose its
    // `this`. The reference is captured on this instance and nowhere else.
    const network = options.network
    this.#client = new OpenAI({
      apiKey,
      baseURL,
      maxRetries: 0,
      organization: null,
      project: null,
      adminAPIKey: null,
      webhookSecret: null,
      logLevel: 'off',
      defaultHeaders: { authorization: `Bearer ${apiKey}` },
      fetch: (input, init) => fetchThroughHost(network, input, init),
    })
  }

  /** A copy: the definition's table is data the caller must not be able to edit through here. */
  models(): Promise<ModelInfo[]> {
    return Promise.resolve([...this.#models])
  }

  encode(req: ProviderRequest): EncodedRequest {
    return encodeOpenAIChat(req, this.id)
  }

  /**
   * Streams `encoded.body` as the SDK's chunks, normalised (invariants 1-6).
   *
   * The body is handed over unchanged — `stream: true` and `stream_options` are part of what the
   * encoder hashed, so what `promptHash` covers is what travels. `withTerminalEvent` owns the
   * terminal event, both abort paths and the ordering buffer for out-of-order argument fragments.
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
        mapOpenAIError(error, {
          now: this.#clock.now(),
          redact: (text) => redactCredentials(text, this.#credentials),
        }),
      signal: ctx.signal,
    })
  }

  async *#events(
    params: OpenAI.ChatCompletionCreateParamsStreaming,
    ctx: SendContext,
  ): AsyncIterable<StreamEvent> {
    const stream = await this.#client.chat.completions.create(params, {
      // The SDK's own AbortController is chained to this one, so an abort reaches the fetch the
      // host performed. `withTerminalEvent` still races the signal itself: a socket that has
      // gone quiet must not be able to outlive a Stop.
      signal: ctx.signal,
    })
    yield* normaliseOpenAIChunks(readBody(stream))
  }
}

/**
 * The SDK's chunks, with a failure raised while READING the body marked for what it is.
 *
 * The SDK wraps a rejected `fetch` in `APIConnectionError`, but only on the connect path: once the
 * response exists, `core/streaming` rethrows whatever the body stream raises verbatim (`catch (e) {
 * if (receivedCompletionSentinel || isTransportAbortError(e) || …) return; throw e }`). A dropped
 * connection therefore arrives as a bare `TypeError('terminated')`, an errno `Error`, or — when the
 * body stops mid-frame — a `SyntaxError` about malformed event JSON. None of those is classifiable,
 * so all three would land on `unknown`, which is the one code that is never retried; meanwhile the
 * SAME connection dropping one byte later, on a frame boundary, ends the iterator cleanly and
 * `withTerminalEvent` reports it as `error{ code: 'network', retryable: true }`. One physical event
 * must not get two opposite retry verdicts, so it is rewrapped here as the connection failure it
 * is, with the original kept on `cause` for `detail`.
 *
 * An `APIError` passes through untouched: that is the vendor speaking (a mid-stream `error` object
 * inside a 200), not the transport failing. Only the pull is guarded — a bug in this adapter's own
 * normalisation still reaches the mapper as itself, which is why it is not classified as a network
 * failure.
 */
async function* readBody(stream: AsyncIterable<ChunkView>): AsyncIterable<ChunkView> {
  const iterator = stream[Symbol.asyncIterator]()
  try {
    for (;;) {
      let step: IteratorResult<ChunkView>
      try {
        // oxlint-disable-next-line no-await-in-loop -- a stream is sequential by nature
        step = await iterator.next()
      } catch (error) {
        throw error instanceof APIError
          ? error
          : new APIConnectionError({
              message: 'the response body failed before the stream ended',
              cause: error instanceof Error ? error : undefined,
            })
      }
      if (step.done === true) return
      yield step.value
    }
  } finally {
    // The SDK stream's own `return()` is what releases the HTTP body; a `for await` would do this
    // for us, but it would also catch a throw from the consumer as if the body had failed. A
    // throwing close is swallowed: it must not replace the failure we are reporting.
    try {
      await iterator.return?.()
    } catch {
      // The body is gone either way.
    }
  }
}

/**
 * `encoded.body` as the SDK's parameter object.
 *
 * Nothing is added on the way out: `stream: true` is part of the body the encoder produced (the
 * SDK reads `body.stream` only to decide how to PARSE the response and posts the body verbatim),
 * so `promptHash` covers every byte that travels.
 */
function streamParams(encoded: EncodedRequest): OpenAI.ChatCompletionCreateParamsStreaming {
  const body = encoded.body
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProviderInvalidArgumentError(
      `${WIRE}: stream() takes the object encode() produced, not ${typeof body}`,
    )
  }
  return body as unknown as OpenAI.ChatCompletionCreateParamsStreaming
}

/**
 * A streamed chunk as this adapter reads it: the SDK's own shape widened by the two reasoning
 * fields no OpenAI type declares (`reasoning_content` for DeepSeek-style vendors and zhipu,
 * `reasoning` for ollama) and loosened everywhere a compatible endpoint might omit something the
 * type calls required. A chunk is data off a socket, so nothing here is assumed to be present.
 */
interface ChunkView {
  readonly choices?: readonly ChoiceView[] | null
  readonly usage?: OpenAIWireUsage | null
}

interface ChoiceView {
  readonly delta?: DeltaView | null
  readonly finish_reason?: string | null
}

interface DeltaView {
  readonly content?: string | null
  readonly reasoning_content?: string | null
  readonly reasoning?: string | null
  readonly tool_calls?: readonly ToolCallView[] | null
}

interface ToolCallView {
  /** `unknown`, not `number`: a compatible endpoint may JSON-encode it — see slotKey(). */
  readonly index?: unknown
  readonly id?: string | null
  readonly type?: string | null
  /** `arguments` is `unknown` for the same reason: this wire's string is not guaranteed. */
  readonly function?: { readonly name?: string | null; readonly arguments?: unknown } | null
  /** A `custom` tool call, which phase 1 never requests and no normalised event can carry. */
  readonly custom?: unknown
}

/** The usage fields this wire reports; every one of them is optional on a compatible endpoint. */
interface OpenAIWireUsage {
  readonly prompt_tokens?: number | null
  readonly completion_tokens?: number | null
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: number | null
    readonly cache_write_tokens?: number | null
  } | null
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number | null } | null
}

/**
 * Translates this wire's chunks into the normalised stream.
 *
 * The shape of this wire decides the shape of this function. There are no content-block
 * boundaries: `content` is one text block, the reasoning field is one thinking block, and a tool
 * call is identified only by its `index`. There is also no per-call end marker — `finish_reason`
 * is the only statement that the turn is over — and the usage arrives in a trailing chunk AFTER
 * it. Since `withTerminalEvent` forwards nothing after a terminal event, the `stop` is held back
 * to the end of the iterator; emitting it where the wire announced it would drop the usage the
 * `provider/attempt_completed` fact records (invariant 1). The cost of holding it is explicit: a
 * body that breaks between the finish reason and `[DONE]` is reported as the error it is, and the
 * stop the vendor did state is lost with it — which is the right way round, because a fact saying
 * "ended normally" about a truncated exchange is the one mistake nothing later can detect.
 *
 * Only the first choice of each chunk is read. `encode()` never asks for more than one completion,
 * and there is no normalised event that could carry a second one.
 */
async function* normaliseOpenAIChunks(
  chunks: AsyncIterable<ChunkView>,
): AsyncIterable<StreamEvent> {
  const slots = createChunkSlots()
  /** The latest usage reading. Both this wire's readings are cumulative, so a later one wins. */
  let usage: Usage | null = null
  let stop: Extract<StreamEvent, { type: 'stop' }> | null = null
  try {
    for await (const chunk of chunks) {
      const reading = chunkUsage(chunk.usage)
      if (reading !== null) usage = reading
      const choice = chunk.choices?.[0]
      if (choice == null) continue
      const delta = choice.delta
      if (delta != null) {
        const text = delta.content
        // An empty string is not content: the wire opens a turn with `content: ''` beside the role,
        // and forwarding it would open a text block that has nothing in it.
        if (typeof text === 'string' && text !== '') {
          yield { type: 'text-delta', index: slots.text(), text }
        }
        // `reasoning_content` first: a vendor that sends both means the same text twice, and the
        // DeepSeek-style spelling is the one `ModelInfo.reasoningEchoField` names by default.
        const reasoningText = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoningText === 'string' && reasoningText !== '') {
          // No signature: this wire has none, and one is never synthesised (invariant 7).
          yield { type: 'thinking-delta', index: slots.thinking(), text: reasoningText }
        }
        for (const raw of delta.tool_calls ?? []) yield* slots.place(raw)
      }
      const finish = choice.finish_reason
      // The first finish reason wins: a wire that restates it is not ending the turn twice.
      if (typeof finish === 'string' && finish !== '' && stop === null) {
        yield* slots.flush(finish)
        stop = { type: 'stop', reason: stopReasonOf(finish), providerReason: finish }
      }
    }
  } finally {
    // In the `finally`, so that a reading already received survives a stream that then fails: the
    // attempt was billed either way, and a `provider/attempt_completed` fact reporting zero tokens
    // for a turn that consumed some is indistinguishable later from a genuinely free one. A
    // generator may yield while an exception is propagating — the consumer gets this event and the
    // throw on its next pull, which is the order invariant 1 wants (usage, then the terminal). One
    // reading only, the latest: several `final: true` readings would break the same invariant.
    if (usage !== null) yield { type: 'usage', usage }
  }
  // No finish reason means the body ended mid-turn. Nothing more is yielded, and withTerminalEvent
  // reports the missing terminal as a retryable `network` error — which is what a truncated
  // stream is. Inventing `end-turn` here would let the phase 2 loop treat a turn the vendor never
  // called finished as a completed one.
  if (stop !== null) yield stop
}

/** One tool call this wire is assembling, keyed by the `index` its fragments arrive under. */
interface OpenAICall {
  /** The normalised `index`. Handed out once and never reused within a response. */
  readonly slot: number
  id: string | null
  name: string | null
  /** `tool-call-start` has been emitted, so the wrapper releases this slot's fragments. */
  started: boolean
  args: string
  /**
   * The vendor sent an `arguments` that is not a string. It is not an EMPTY argument set: taking it
   * as one would hand the caller a runnable call with `input: {}` for a call that had arguments —
   * `/etc/passwd` becoming nothing at all. Marked unusable instead, exactly like fragments that do
   * not parse (see flush).
   */
  malformed: boolean
  /** A call no normalised event can carry: its fragments are dropped rather than mismapped. */
  readonly skipped: boolean
}

/**
 * The adapter's block slots. Text and reasoning get one slot each, allocated on first sight so the
 * slot numbers follow arrival order (a vendor that reasons first, like zhipu, therefore yields the
 * thinking block before the text one); every tool CALL gets its own, which is not the same as every
 * wire index — see slotFor().
 */
function createChunkSlots() {
  /** The call currently open under each wire index. */
  const open = new Map<number, OpenAICall>()
  /** Every call opened, in slot order — what flush() walks; an index may open more than one. */
  const calls: OpenAICall[] = []
  let next = 0
  let textSlot: number | null = null
  let thinkingSlot: number | null = null
  const allocate = (): number => {
    const slot = next
    next += 1
    return slot
  }
  const start = (key: number, raw: ToolCallView): OpenAICall => {
    const call: OpenAICall = {
      slot: allocate(),
      id: null,
      name: null,
      started: false,
      args: '',
      malformed: false,
      skipped: raw.type === 'custom' || raw.custom != null,
    }
    open.set(key, call)
    calls.push(call)
    return call
  }
  /**
   * The call a fragment belongs to, or null when the wire gave an index this adapter cannot read.
   *
   * A fragment naming an `id` that the open call under this index does NOT have opens a new call.
   * Ollama's OpenAI-compatible endpoint reports `index: 0` for every streamed tool call
   * (ollama/ollama#15457 and #15497, still open for models on its legacy parser path), so a second
   * call really does arrive under an index that is already in use — and the vendor hands over a
   * whole call per chunk, id included, which is what makes the two distinguishable. Keeping the
   * first id and appending the second call's `arguments` to it would leave one slot whose JSON no
   * longer parses, so BOTH calls would be dropped and the turn would end `tool-use` with nothing
   * runnable in it.
   */
  const slotFor = (raw: ToolCallView, id: string | null): OpenAICall | null => {
    const key = slotKey(raw.index)
    if (key === null) return null
    const existing = open.get(key)
    if (existing === undefined) return start(key, raw)
    return id !== null && existing.id !== null && existing.id !== id ? start(key, raw) : existing
  }
  return {
    text(): number {
      textSlot ??= allocate()
      return textSlot
    },
    thinking(): number {
      thinkingSlot ??= allocate()
      return thinkingSlot
    },
    /**
     * One `delta.tool_calls` entry. The id and the name may arrive in any chunk — after the first
     * argument fragment on some endpoints — so `tool-call-start` is emitted the moment both are
     * known, and fragments go out immediately: `withTerminalEvent` holds anything that precedes
     * its start and releases it in order (invariant 4). That buffer is the one step 8 built; a
     * second one here would be a second reading of the same invariant.
     */
    place(raw: ToolCallView): StreamEvent[] {
      // First statement wins for both: a wire that restates them is not renaming the call.
      const id = nonEmpty(raw.id)
      const call = slotFor(raw, id)
      if (call === null || call.skipped) return []
      const out: StreamEvent[] = []
      if (id !== null && call.id === null) call.id = id
      const name = nonEmpty(raw.function?.name)
      if (name !== null && call.name === null) call.name = name
      if (!call.started && call.id !== null && call.name !== null) {
        call.started = true
        out.push({ type: 'tool-call-start', index: call.slot, id: call.id, name: call.name })
      }
      const fragment = raw.function?.arguments
      if (typeof fragment === 'string') {
        if (fragment !== '') {
          call.args += fragment
          out.push({ type: 'tool-call-args-delta', index: call.slot, json: fragment })
        }
        // A present `arguments` of the wrong type — ollama's native API states it as an OBJECT and
        // no relay is obliged to stringify it, while the SDK JSON-parses the frame and casts. Null
        // and absent both mean the vendor said nothing, which for this field is an empty call.
      } else if (fragment != null) call.malformed = true
      return out
    },
    /**
     * The `tool-call-end` events the finish reason completes, in slot order. Called once, and only
     * from the finish reason: nothing else on this wire says a call is over, so an end emitted
     * earlier would be a guess, and a fragment that arrives after it belongs to no call the vendor
     * finished (it is dropped, like a truncated one).
     *
     * Four kinds of call get no end, and therefore never execute (invariant 5):
     * - every call when the turn was cut off by the output limit — `length` means the arguments
     *   stop wherever the budget ran out;
     * - one whose id or name never arrived, which cannot be dispatched at all;
     * - one whose `arguments` arrived with the wrong type (see OpenAICall.malformed);
     * - one whose fragments do not parse into a JSON object. That is where this wire differs from
     *   the Anthropic one, deliberately: there a `content_block_stop` proves the call was complete,
     *   so garbled arguments are a vendor bug worth reporting as the terminal error, whereas here
     *   nothing proves completeness and an unparsable call is indistinguishable from a truncated
     *   one. It is dropped for the same reason a truncated one is, and the turn keeps its stop
     *   reason (which is `tool-use`, so a caller sees a tool turn with no runnable call in it).
     */
    flush(finish: string): StreamEvent[] {
      const out: StreamEvent[] = []
      if (finish === 'length') return out
      // Allocation order is slot order.
      for (const call of calls) {
        if (call.skipped || call.malformed || call.id === null || call.name === null) continue
        const input = parseToolArguments(call.args)
        if (input === null) continue
        out.push({ type: 'tool-call-end', index: call.slot, id: call.id, name: call.name, input })
      }
      return out
    },
  }
}

/** Only digits: a slot key is a wire index, and a signed or fractional one is not one. */
const WIRE_INDEX = /^\d+$/

/**
 * The map key one `delta.tool_calls` entry belongs to, or null when the wire stated an index this
 * adapter will not guess at.
 *
 * An ABSENT index is the single-call shape — everything belongs to one call — and that fallback is
 * deliberately not extended to a value that is present but unreadable: two distinct calls sharing a
 * slot concatenate their argument strings into JSON that does not parse, so both are dropped and the
 * turn ends `tool-use` with an empty message. A JSON-encoded index ('0', '1') is read as the number
 * it spells, because that costs nothing and keeps two calls in two slots.
 */
function slotKey(index: unknown): number | null {
  if (index == null) return 0
  if (typeof index === 'number') return Number.isSafeInteger(index) && index >= 0 ? index : null
  if (typeof index === 'string' && WIRE_INDEX.test(index)) {
    const parsed = Number(index)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

/** A non-empty string off the wire, or null. */
function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * One usage reading. Every field is what the vendor stated or zero: unlike the other wire, this
 * one sends a single reading for the whole response, so there is no earlier statement to fall back
 * on. `prompt_tokens` is kept as given — on this wire it INCLUDES the cached tokens that
 * `cacheReadTokens` also reports, and subtracting them here would be arithmetic the vendor did not
 * do (`Usage` is the audit, not a bill).
 */
function chunkUsage(usage: OpenAIWireUsage | null | undefined): Usage | null {
  if (usage == null || typeof usage !== 'object') return null
  const prompt = usage.prompt_tokens_details
  return {
    inputTokens: tokenCount(usage.prompt_tokens) ?? 0,
    outputTokens: tokenCount(usage.completion_tokens) ?? 0,
    cacheReadTokens: tokenCount(prompt?.cached_tokens) ?? 0,
    cacheWriteTokens: tokenCount(prompt?.cache_write_tokens) ?? 0,
    reasoningTokens: tokenCount(usage.completion_tokens_details?.reasoning_tokens) ?? 0,
    // The only reading there is, and it arrives after the finish reason: the stop is held back
    // behind it, so this one is always the final one.
    final: true,
  }
}

/**
 * This wire's finish reasons. A Record over the SDK's own union, so a value a later SDK adds fails
 * to compile until it is mapped; anything else (a compatible vendor's own spelling — zhipu answers
 * `sensitive`, `network_error` and `model_context_window_exceeded`) reads as `unknown` with the
 * raw string kept in `providerReason`, which is where a later mapping can be added without
 * touching a single stored fact.
 */
const STOP_REASONS: Readonly<
  Record<NonNullable<OpenAI.ChatCompletionChunk.Choice['finish_reason']>, StopReason>
> = {
  stop: 'end-turn',
  length: 'max-tokens',
  tool_calls: 'tool-use',
  // The deprecated single-function shape. The turn still ended because the model called something.
  function_call: 'tool-use',
  content_filter: 'content-filter',
}

function stopReasonOf(raw: string): StopReason {
  return Object.hasOwn(STOP_REASONS, raw)
    ? STOP_REASONS[raw as NonNullable<OpenAI.ChatCompletionChunk.Choice['finish_reason']>]
    : 'unknown'
}

interface OpenAIErrorContext {
  /** A `HostClock.now()` reading, for `retryAfterMs()`'s HTTP-date branch. */
  readonly now: number
  /** Applied to `detail`, which reaches logs: the credential must never appear in one. */
  readonly redact: (text: string) => string
}

/**
 * Whatever the SDK threw, as the `error` event that replaces it (invariant 3).
 *
 * Three shapes arrive here, and the mapping has to hold for all of them:
 * - an HTTP error, with `status` and `headers`, whose body's `error` object the SDK puts on
 *   `err.error` and whose `code` / `type` it copies onto `err.code` / `err.type`;
 * - a mid-stream `error` chunk inside a 200, which the SDK also throws as an APIError but with
 *   `status` undefined and the still-streaming response's own `Headers` attached;
 * - a connection-layer failure, where the host's own rejection sits in the `cause` chain.
 */
function mapOpenAIError(
  error: unknown,
  ctx: OpenAIErrorContext,
): Extract<StreamEvent, { type: 'error' }> {
  const chain = causeChain(error)
  const providerCode = providerCodeOf(error)
  const status = errorStatus(error)
  const code = classifyOpenAIError(error, chain, status, providerCode)
  const event: Extract<StreamEvent, { type: 'error' }> = {
    type: 'error',
    code,
    retryable: isRetryableByDefault(code),
    providerCode,
    detail: errorDetail(chain, ctx.redact),
  }
  if (status !== undefined) event.status = status
  const delay = retryAfterMs(errorHeaders(error), ctx.now)
  if (delay !== null) event.retryAfterMs = delay
  return event
}

function classifyOpenAIError(
  error: unknown,
  chain: readonly unknown[],
  status: number | undefined,
  providerCode: string | null,
): ProviderErrorCode {
  // First, and anywhere in the chain: the host refused to let the request out. The SDK wraps a
  // rejected fetch as `new APIConnectionError({ cause })`, so the denial arrives one or two links
  // down (see fetchThroughHost for why a timeout cannot swallow it).
  if (hasEgressDenial(chain)) return 'egress-denied'
  const vocabulary = vocabularyCode(providerCode)
  // Before the status table, but only for a code the vendor uses to name a PERMANENT condition: a
  // status is a class of failure while `code` is the failure itself, and where the two disagree it
  // is always in the same direction. A context refusal is an ordinary 400 here; an exhausted
  // account is a 429 on both vendors that document one (OpenAI's `insufficient_quota`, zhipu's
  // 1113), which the status table alone reads as a retryable rate limit — so the phase 2 loop would
  // resend it until a human noticed. Restricted to the non-retryable codes so this can only ever
  // make us retry LESS: a vendor code that IS retryable says nothing the status does not.
  if (vocabulary !== null && !isRetryableByDefault(vocabulary)) return vocabulary
  const message = errorMessage(error)
  if (status !== undefined) return statusErrorCode(status, message)
  if (vocabulary !== null) return vocabulary
  // A mid-stream error frame carries no status, so its message is all there is to read.
  if (looksLikeContextOverflow(message)) return 'context-overflow'
  // A failed connection, including the SDK's own timeout (a subclass of this one) and a body that
  // failed while being read (readBody rewraps those, because the SDK rethrows them verbatim). A
  // bare TypeError is deliberately NOT read as one: everything the transport can raise has been
  // marked by the time it reaches here, so what is left was raised by this adapter's own
  // normalisation, and advertising our bug as retryable would have the phase 2 loop resend a
  // request nothing was wrong with.
  if (chain.some((link) => link instanceof APIConnectionError)) return 'network'
  // Not classified, so not resent: `unknown` is the one code that is never retryable by default,
  // and a payload whose failure we could not explain is the wrong thing to repeat.
  return 'unknown'
}

/**
 * The vendors' own error vocabulary, looked up with `code` first and `type` second (see
 * providerCodeOf). One table for both because this wire has no single vocabulary: OpenAI answers
 * with `code`, compatible gateways with `type`, and the two name spaces do not collide.
 *
 * `insufficient_quota` and `billing_error` are `invalid-request` rather than a retryable class:
 * resending will fail the same way until a human tops the account up. Both arrive with a 429, so
 * they only take effect because classifyOpenAIError consults a non-retryable code FIRST.
 *
 * The numeric entries are zhipu's, from docs.bigmodel.cn/cn/faq/api-code (read 2026-09-21), and are
 * the two rows where that vendor's status contradicts its code: 1113 (欠费) is a 429 and 1261
 * (Prompt 超长) a 400 whose message no English regex matches. `stringField()` stringifies a numeric
 * code, so a gateway that answers `"code": 1113` unquoted lands here too.
 */
const ERROR_VOCABULARY: Readonly<Record<string, ProviderErrorCode>> = {
  context_length_exceeded: 'context-overflow',
  model_context_window_exceeded: 'context-overflow',
  '1261': 'context-overflow',
  '1113': 'invalid-request',
  '1302': 'rate-limit',
  invalid_api_key: 'auth',
  invalid_authentication: 'auth',
  authentication_error: 'auth',
  permission_error: 'auth',
  rate_limit_exceeded: 'rate-limit',
  rate_limit_error: 'rate-limit',
  insufficient_quota: 'invalid-request',
  billing_error: 'invalid-request',
  model_not_found: 'invalid-request',
  not_found_error: 'invalid-request',
  invalid_request_error: 'invalid-request',
  overloaded_error: 'overloaded',
  timeout_error: 'server',
  server_error: 'server',
  api_error: 'server',
}

function vocabularyCode(providerCode: string | null): ProviderErrorCode | null {
  if (providerCode === null || !Object.hasOwn(ERROR_VOCABULARY, providerCode)) return null
  return ERROR_VOCABULARY[providerCode] ?? null
}

/**
 * The failure the vendor named: `code` if it gave one, else `type`. Both are read off the thrown
 * error (where the SDK copies them) and off the error body it kept, because a compatible endpoint
 * may nest either.
 *
 * Only off an `APIError`, which is the only thing that carries a vendor body: `code` is also where
 * a Node system error puts its errno, and recording `ECONNRESET` as the vendor's own vocabulary
 * would put a transport failure in the field a later mapping is built from — and the field
 * `vocabularyCode()` classifies on.
 */
function providerCodeOf(error: unknown): string | null {
  if (!(error instanceof APIError)) return null
  const body = objectField(error, 'error')
  return (
    stringField(error, 'code') ??
    stringField(body, 'code') ??
    stringField(error, 'type') ??
    stringField(body, 'type')
  )
}
