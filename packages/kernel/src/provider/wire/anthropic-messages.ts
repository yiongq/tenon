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
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk'
import { VERSION as SDK_VERSION } from '@anthropic-ai/sdk/version'
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
  ThinkingSpec,
  ToolSpec,
  Usage,
} from '../types.js'
import {
  assertBlockRole,
  assertHasMessages,
  assertImageMediaType,
  assertLastTurnIsUser,
  assertModelBelongs,
  assertSamplingDefaults,
  assertThinkingRequest,
  assertToolInput,
  assertToolRequested,
  effectiveMaxTokens,
  effortTierOf,
  guardReasoning,
  guardVendorBlock,
  hasSystemPrompt,
  mergeRequestParams,
  sealEncoded,
  thinkingTargetFor,
  withVendorFields,
} from './shared.js'
import type { EncoderInfo, ImageContentBlock } from './shared.js'
import {
  StreamIdleTimeoutError,
  allowedRequestInit,
  assertBaseUrl,
  configuredValue,
  fetchThroughHost,
  firstByteTimeoutMs,
  idleMsFor,
  parseToolArguments,
  tokenCount,
} from './transport.js'
import type { HeaderAllowList } from './transport.js'

const WIRE = 'anthropic-messages'

/**
 * The request headers this wire lets out (spec 02, 01 修补 4; decision A6), from the headers the
 * pinned SDK was seen to send (02 plan step 3, check 5): the protocol headers, one credential, the
 * `x-stainless-*` group. The fixed protocol values are pinned, so an `ANTHROPIC_CUSTOM_HEADERS` line
 * cannot rewrite them; `anthropic-beta` is the kernel's to decide and 02 decides none.
 */
const ALLOWED_HEADERS: HeaderAllowList = Object.freeze({
  names: Object.freeze(['content-type', 'x-api-key', 'authorization']),
  prefixes: Object.freeze(['x-stainless-']),
  pinned: Object.freeze({
    accept: 'application/json',
    'anthropic-version': '2023-06-01',
    'user-agent': `Anthropic/JS ${SDK_VERSION}`,
  }),
})

/**
 * `provider/attempt_completed.encoder` for every body this file builds (spec 02, 01 修补 7). Version
 * 1 is spec 02's encoder — the thinking shapes, the vendor blocks and the trailing-user rule; add one
 * with every change to what it encodes.
 */
const ENCODER: EncoderInfo = Object.freeze({
  wire: WIRE,
  version: 1,
  sdk: `@anthropic-ai/sdk@${SDK_VERSION}`,
})

/** The four base64 source types the Messages API documents. */
const MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** The documented floor for `thinking.budget_tokens` on this wire. */
const MIN_THINKING_BUDGET = 1024

/**
 * The keys `requestParams` may not set on this wire (see mergeRequestParams). Three groups, one
 * criterion — what promptHash covers has to be the request the audit describes:
 *
 * - every key this encoder writes: `model`, `messages`, `max_tokens`, `system`, `tools`,
 *   `temperature`, `thinking`, `stream`, and since spec 02 `output_config` (the effort) and
 *   `cache_control` (01 修补 3). All but `model`, `messages` and `stream` are also what the
 *   `provider/attempt_completed` record describes (`systemHash`, `maxTokens`, `temperature`,
 *   `thinking`, `effort`, `display` in the request snapshot, `toolDefinitionsHash` beside it), so a
 *   passthrough that replaced one would leave the fact describing a request nobody sent;
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
  'output_config',
  'cache_control',
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

/** A vendor block (spec 02, 01 修补 2) goes back exactly as it arrived, whatever its type. */
export type AnthropicRawBlock = Readonly<Record<string, unknown>>

export interface AnthropicWireMessage {
  role: 'user' | 'assistant'
  content: (AnthropicContentBlock | AnthropicRawBlock)[]
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
  assertThinkingRequest(req, WIRE)
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
  const spec = req.model.thinkingSpec
  if (spec === undefined) {
    // 01's one shape, byte for byte: only an explicit `enabled` writes anything.
    const thinking = req.thinking
    if (thinking?.enabled === true) body.thinking = thinkingParam(req.model, thinking, maxTokens)
  } else {
    assertSamplingDefaults(req, WIRE)
    const thinking = thinkingShape(req, spec, maxTokens)
    if (thinking !== null) body.thinking = thinking
    if (req.effort !== undefined) body.output_config = { effort: req.effort }
  }
  // Spec 02, 01 修补 3 (decisions H8, M8): the automatic-caching form, 5-minute tier, no ttl. In the
  // body, so promptHash covers it; a synthesised row (supportsCacheControl false) writes none.
  if (req.model.supportsCacheControl) body.cache_control = { type: 'ephemeral' }
  mergeRequestParams(body, req.model, RESERVED_KEYS)
  const encoded = sealEncoded(providerId, req.model.id, body, tools, decisions, ENCODER)
  // Last, so every refusal 01 already made still comes first with 01's own error (01 修补 3).
  assertLastTurnIsUser(req.messages, WIRE)
  return encoded
}

/**
 * The `thinking` object for a row that declares its shape (spec 02, 01 修补 3; decisions A1, M3), or
 * null when none is written. `req.thinking` is still three states:
 *
 * - absent: nothing is written, the model's default stands. The one exception is a model that thinks
 *   by default and a `display` to carry, which needs a thinking object to sit in — the equivalent
 *   `{ type: 'adaptive', display }`;
 * - on: the budget mode as 01 (a budget is mandatory); the three adaptive modes as
 *   `{ type: 'adaptive' }`, where a budget is refused;
 * - off: `disabled` for budget and adaptive; adaptive-gated only while this request's level (its
 *   `effort`, else the row's `defaultEffort`) is no higher than `disableMaxEffort`; never on
 *   always-on.
 *
 * `display` goes inside the object only while thinking is on: with `disabled` it is a 400, so it is
 * left out, and the snapshot does not record it (thinkingIsOn in shared.ts reads the same way).
 */
function thinkingShape(
  req: ProviderRequest,
  spec: ThinkingSpec,
  maxTokens: number,
): Record<string, unknown> | null {
  const model = req.model
  if (spec.mode === 'effort-only') {
    // A table error: that mode belongs to the OpenAI-compatible wire, and this one has no
    // `reasoning_effort` to put the level in.
    throw new ProviderInvalidArgumentError(
      `model ${model.id}: thinking mode "effort-only" belongs to the openai-chat wire, not ${WIRE}`,
    )
  }
  const display = req.display === undefined ? {} : { display: req.display }
  const thinking = req.thinking
  if (thinking === undefined) {
    return spec.defaultOn && req.display !== undefined ? { type: 'adaptive', ...display } : null
  }
  if (thinking.enabled) {
    if (spec.mode === 'budget') return { ...thinkingParam(model, thinking, maxTokens), ...display }
    if (thinking.budgetTokens !== undefined) {
      throw new ProviderInvalidArgumentError(
        `model ${model.id}: thinking is adaptive on this model, so budgetTokens has no place in it`,
      )
    }
    return { type: 'adaptive', ...display }
  }
  switch (spec.mode) {
    case 'budget':
    case 'adaptive':
      return { type: 'disabled' }
    case 'adaptive-gated':
      assertMayDisable(req, spec)
      return { type: 'disabled' }
    case 'always-on':
      throw new ProviderInvalidArgumentError(
        `model ${model.id}: thinking is always on for this model and cannot be turned off`,
      )
  }
}

/**
 * adaptive-gated: thinking may be turned off only at a level no higher than `disableMaxEffort`,
 * compared by position in `effortLevels`. A row missing either end of the comparison is a table
 * error, and it is refused rather than guessed at — a guess either way is a 400 or a silent downgrade.
 */
function assertMayDisable(req: ProviderRequest, spec: ThinkingSpec): void {
  const levels = spec.effortLevels ?? []
  const level = req.effort ?? spec.defaultEffort
  const ceiling = spec.disableMaxEffort
  const at = level === undefined ? -1 : levels.indexOf(level)
  const max = ceiling === undefined ? -1 : levels.indexOf(ceiling)
  if (at < 0 || max < 0) {
    throw new ProviderInvalidArgumentError(
      `model ${req.model.id}: an adaptive-gated row needs a default effort and a disableMaxEffort among its effortLevels`,
    )
  }
  if (at > max) {
    throw new ProviderInvalidArgumentError(
      `model ${req.model.id}: thinking cannot be turned off at effort "${String(level)}"; the highest level that allows it is "${String(ceiling)}"`,
    )
  }
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
 * really can arrive inconsistent.
 *
 * Which thinking SHAPE a given model takes is `ModelInfo.thinkingSpec` since spec 02 (01 修补 2): a
 * row without one keeps exactly this form, and a `budget`-mode row reaches it through thinkingShape().
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
  for (const [messageIndex, message] of req.messages.entries()) {
    const content: (AnthropicContentBlock | AnthropicRawBlock)[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          // The API rejects an empty text block, whatever produced it. Fields the vendor put on it
          // that the content model has no place for go back with it (spec 02, 01 修补 2).
          if (block.text !== '') {
            content.push(withVendorFields({ type: 'text', text: block.text }, block.vendorFields))
          }
          break
        case 'thinking':
        case 'redacted-thinking': {
          // Reasoning is the assistant's own output, and the guard judges it against the model
          // that produced it; on a user turn it is neither legal here nor true.
          assertBlockRole('a reasoning block', message.role, 'assistant', WIRE)
          const applied = guardReasoning(block, target, decisions, messageIndex)
          const encoded = reasoningBlock(applied, req.model)
          if (encoded !== null) content.push(encoded)
          break
        }
        case 'tool-request':
          // Checked before the id is remembered: a `tool_use` the wire would refuse must not
          // legitimise the `tool_result` that follows it.
          assertBlockRole('a tool call', message.role, 'assistant', WIRE)
          requested.add(block.id)
          // Invariant 6 on the way out: `{}` for empty input, never null, never a JSON string.
          content.push(
            withVendorFields(
              {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: assertToolInput(block.input, block.name, WIRE),
              },
              block.vendorFields,
            ),
          )
          break
        case 'vendor':
          // The vendor's own block, judged by the guard (spec 02, 01 修补 2 and 3): a call it ran
          // itself never goes back, another provider's or model's block is dropped, and the rest
          // goes back exactly as it was stored. Dropped BEFORE the emptiness check below, so a turn
          // that held nothing else is omitted like any other empty turn.
          assertBlockRole('a vendor block', message.role, 'assistant', WIRE)
          if (guardVendorBlock(block, target, decisions)) content.push(block.raw)
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
      // The fields the vendor put on the block go back with it (spec 02, 01 修补 2): replaying it
      // "as it was stored" means all of it.
      return applied.block.type === 'thinking'
        ? withVendorFields(
            {
              type: 'thinking' as const,
              thinking: applied.block.text,
              signature: applied.block.signature,
            },
            applied.block.vendorFields,
          )
        : withVendorFields(
            { type: 'redacted_thinking' as const, data: applied.block.data },
            applied.block.vendorFields,
          )
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
  readonly clock: Pick<HostClock, 'now' | 'setTimeout'>
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
 *   neither is refused here, before a client exists. Redundant on purpose, and no test can say
 *   otherwise: the header pin below wins over whatever the SDK resolved, so relaxing these two
 *   to `?? undefined` changes not one recorded byte. Green tests are not coverage of this line —
 *   what it buys is that an env credential is never resolved in the first place, which matters
 *   the day the SDK grows a path that reads `client.apiKey` without going through a header;
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
  readonly #clock: Pick<HostClock, 'now' | 'setTimeout'>
  /** Where requests go: it decides the first-byte and idle limits (01 修补 4). */
  readonly #baseURL: string
  readonly #models: readonly ModelInfo[]
  /** The credential values, for redacting them out of an error `detail` that reaches logs. */
  readonly #credentials: readonly string[]

  constructor(options: AnthropicMessagesProviderOptions) {
    super()
    // A blank string is "not configured", not a credential: the SDK would send an empty
    // `x-api-key` header and the endpoint would answer 401, which reads as a wrong key rather
    // than a missing one.
    const apiKey = configuredValue(options.apiKey)
    const authToken = configuredValue(options.authToken)
    if (apiKey === null && authToken === null) {
      // Named after the primary ConfigKey of the `anthropic` definition (spec §内置 provider);
      // `authToken` is the alternative, and the message says so.
      throw new ProviderConfigMissingError(
        options.id,
        'apiKey (or authToken; at least one must be configured)',
      )
    }
    const baseURL = configuredValue(options.baseURL)
    if (baseURL === null) {
      throw new ProviderConfigMissingError(options.id, 'baseURL')
    }
    assertBaseUrl(options.id, baseURL, { wire: WIRE, refuseV1Suffix: true })
    this.id = options.id
    this.#clock = options.clock
    this.#baseURL = baseURL
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
      // Spec 02, 01 修补 4: every request through the header allowlist, every body under the idle
      // watchdog (180 s on the official endpoint, 300 s elsewhere).
      fetch: (input, init) =>
        fetchThroughHost(network, input, allowedRequestInit(init, ALLOWED_HEADERS), {
          clock: options.clock,
          idleMs: idleMsFor(baseURL),
        }),
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
    // Spec 02, 01 修补 4 (A5): the first-byte limit, for the official endpoint only; null leaves the
    // SDK's own default. Runs on the SDK's timer, not the host clock.
    const timeout = firstByteTimeoutMs(this.#baseURL, encoded.body, ctx.firstByteTimeout)
    return withTerminalEvent(() => this.#events(params, ctx, timeout), {
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
   * A row that declares its thinking shape answers from it (spec 02, 01 修补 3): `budget` mode is
   * 'budget', declared effort levels are 'effort'. A row without one keeps 01's answer: this wire
   * takes `budget_tokens`, which is the `'budget'` tier — but only for a model that reasons at all.
   */
  override thinkingEffortSupport(model: ModelInfo): 'none' | 'budget' | 'effort' {
    const spec = model.thinkingSpec
    if (spec !== undefined) return effortTierOf(spec)
    return model.reasoning ? 'budget' : 'none'
  }

  async *#events(
    params: Anthropic.MessageCreateParamsStreaming,
    ctx: SendContext,
    timeout: number | null,
  ): AsyncIterable<StreamEvent> {
    const stream = await this.#client.messages.create(params, {
      // The SDK's own AbortController is chained to this one, so an abort reaches the fetch the
      // host performed. `withTerminalEvent` still races the signal itself: a socket that has
      // gone quiet must not be able to outlive a Stop.
      signal: ctx.signal,
      ...(timeout === null ? {} : { timeout }),
    })
    yield* normaliseAnthropicEvents(readBody(stream))
  }
}

/**
 * The SDK's raw events, with a failure raised while READING the body marked for what it is.
 *
 * Both SDKs wrap a rejected `fetch` in `APIConnectionError`, but only on the connect path: once the
 * response exists, a failure in the body stream is rethrown verbatim, so a dropped connection
 * arrives as a bare `TypeError('terminated')` or an errno `Error`. Unmarked it would classify as
 * `unknown` — never retried — while the same connection dropping on a frame boundary ends the
 * iterator cleanly and `withTerminalEvent` calls it `error{ code: 'network', retryable: true }`. One
 * physical event, one verdict. An `APIError` is the vendor speaking and passes through untouched.
 */
async function* readBody(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
): AsyncIterable<Anthropic.RawMessageStreamEvent> {
  const iterator = events[Symbol.asyncIterator]()
  try {
    for (;;) {
      let step: IteratorResult<Anthropic.RawMessageStreamEvent>
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
    // The SDK stream's own `return()` releases the HTTP body. A throwing close is swallowed: it
    // must not replace the failure we are reporting.
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
 *
 * Spec 02 (01 修补 2, decision M3) stops skipping what the content model has no place for:
 *
 * - a block type this adapter does not map is kept whole as a `vendor-block` (`same-model`);
 * - a call the vendor runs itself — `server_tool_use`, `mcp_tool_use`, a `tool_use` whose `caller`
 *   is not `direct` — and every `*_tool_result` block is kept the same way as `never`: archived, not
 *   dispatched, not sent back (01 修补 9 (t));
 * - a field a known block carries beyond the ones mapped (TEXT_KEYS and friends below) is kept as
 *   that block's `vendor-fields`.
 *
 * Both are emitted at the block's `content_block_stop`, complete; a block that never stops is not
 * emitted, the same way a truncated tool call is not. Deltas are folded into a vendor block exactly
 * as the pinned SDK's own accumulator folds them (lib/MessageStream.mjs): `input_json_delta` builds
 * the `input` of a block that has one, `citations_delta` extends a text block's `citations`, and
 * nothing else applies to a block of an unknown type. The model the vendor says answered is
 * reported once, from `message_start` (M5).
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
        const model: unknown = event.message.model
        if (typeof model === 'string' && model !== '') {
          yield { type: 'response-model', modelId: model }
        }
        break
      }
      case 'content_block_start': {
        // Read as a plain record as well as the SDK's union: a vendor block is whatever the wire
        // sent, and the pinned SDK's types cannot name a block type newer than they are.
        const raw = event.content_block as unknown as Record<string, unknown>
        const block = event.content_block
        switch (block.type) {
          case 'text': {
            const index = blocks.open(event.index, 'text', extraFields(raw, TEXT_KEYS))
            // The wire opens a text block with `text: ''`; anything else is content that
            // arrived and would otherwise be dropped.
            if (block.text !== '') yield { type: 'text-delta', index, text: block.text }
            break
          }
          case 'thinking': {
            const index = blocks.open(event.index, 'thinking', extraFields(raw, THINKING_KEYS))
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
              index: blocks.open(event.index, 'redacted', extraFields(raw, REDACTED_KEYS)),
              data: block.data,
            }
            break
          case 'tool_use': {
            // A call the vendor's own container runs (code execution) is not ours to execute:
            // forwarding it would hand the kernel's tool executor a call the model never asked
            // us for. An absent `caller` is the direct shape — the field is newer than the wire
            // and compatible gateways omit it. Kept, never replayed (spec 02, 01 修补 9 (t)).
            if (!isDirectCall(block.caller)) {
              blocks.openVendor(event.index, raw, 'never')
              break
            }
            const index = blocks.openCall(
              event.index,
              block.id,
              block.name,
              extraFields(raw, TOOL_USE_KEYS),
            )
            yield { type: 'tool-call-start', index, id: block.id, name: block.name }
            break
          }
          default:
            // Server-side tool calls and their results, and any block type this adapter does not
            // map: kept whole rather than skipped or mapped onto something they are not.
            blocks.openVendor(event.index, raw, vendorReplay(raw))
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
            const open = blocks.inputOf(event.index)
            // No open block that takes input: nothing to fold the fragment into.
            if (open === null) break
            open.json += delta.partial_json
            // Only a call of ours streams its arguments; a vendor block's input is folded silently.
            if (open.call !== null) {
              yield { type: 'tool-call-args-delta', index: open.slot, json: delta.partial_json }
            }
            break
          }
          case 'citations_delta':
            // Citations ride on a text block we already forwarded: kept with its other vendor
            // fields, the way the SDK's accumulator appends them. 02 asks for none.
            blocks.cite(event.index, delta.citation)
            break
        }
        break
      }
      case 'content_block_stop': {
        const closed = blocks.close(event.index)
        if (closed === null) break
        if (closed.kind === 'vendor') {
          const raw = vendorRaw(closed)
          if (raw !== null) {
            yield { type: 'vendor-block', index: closed.slot, raw, replay: closed.replay }
          }
          break
        }
        if (closed.fields !== null) {
          yield { type: 'vendor-fields', index: closed.slot, fields: closed.fields }
        }
        // Text, thinking and redacted blocks need no closing event: they were complete as they
        // arrived.
        if (closed.call === null) break
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

/**
 * The keys each known block type maps onto the content model; any other key it carries is a vendor
 * field. `caller` is read (it decides who runs a call) and a direct call is the only kind kept as a
 * `tool-request`, so it carries nothing worth replaying.
 */
const TEXT_KEYS: readonly string[] = ['type', 'text']
const THINKING_KEYS: readonly string[] = ['type', 'thinking', 'signature']
const REDACTED_KEYS: readonly string[] = ['type', 'data']
const TOOL_USE_KEYS: readonly string[] = ['type', 'id', 'name', 'input', 'caller']

/** The keys of `raw` outside `known`, or null when there are none. */
function extraFields(
  raw: Record<string, unknown>,
  known: readonly string[],
): Record<string, unknown> | null {
  let extra: Record<string, unknown> | null = null
  for (const key of Object.keys(raw)) {
    if (known.includes(key)) continue
    extra ??= {}
    extra[key] = raw[key]
  }
  return extra
}

/**
 * Whether a block the vendor ran itself: its server-side calls and every tool-result block they
 * produce are `never` (01 修补 9 (t)); every other unmapped block goes back to the same model (M3).
 */
function vendorReplay(raw: Record<string, unknown>): 'same-model' | 'never' {
  const type = raw['type']
  if (type === 'server_tool_use' || type === 'mcp_tool_use') return 'never'
  return typeof type === 'string' && type.endsWith('_tool_result') ? 'never' : 'same-model'
}

/**
 * A vendor block as it stands at its stop, or null when its streamed input does not parse — a block
 * whose content we cannot state is not archived as if we could, the way an unparsable tool call is
 * not turned into one.
 */
function vendorRaw(block: OpenBlock): Record<string, unknown> | null {
  const raw = block.raw
  if (raw === null) return null
  if (block.json === '') return raw
  const input = parseToolArguments(block.json)
  return input === null ? null : { ...raw, input }
}

/** One open content block: the slot this adapter gave it, and what it holds. */
interface OpenBlock {
  /** The normalised `index`. Handed out once and never reused within a response. */
  readonly slot: number
  readonly kind: BlockKind
  /** `tool` only: the call's identity, which its `tool-call-end` has to repeat. */
  readonly call: { readonly id: string; readonly name: string } | null
  /** `tool`, and a `vendor` block that has an `input`: the argument fragments so far. */
  json: string
  /** `thinking` only: a signature has arrived, and a signature is never rewritten. */
  signed: boolean
  /** A known block's vendor fields so far (spec 02), or null when it has none. */
  fields: Record<string, unknown> | null
  /** `vendor` only: the block as it started. */
  readonly raw: Record<string, unknown> | null
  readonly replay: 'same-model' | 'never'
}

type BlockKind = 'text' | 'thinking' | 'redacted' | 'tool' | 'vendor'

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
  const allocate = (
    index: number,
    kind: BlockKind,
    extra: {
      call?: OpenBlock['call']
      fields?: Record<string, unknown> | null
      raw?: Record<string, unknown>
      replay?: 'same-model' | 'never'
    } = {},
  ): OpenBlock => {
    const block: OpenBlock = {
      slot: next,
      kind,
      call: extra.call ?? null,
      json: '',
      signed: false,
      fields: extra.fields ?? null,
      // A copy: the SDK hands over the parsed frame, and the block kept here must not change with it.
      raw: extra.raw === undefined ? null : { ...extra.raw },
      replay: extra.replay ?? 'same-model',
    }
    next += 1
    open.set(index, block)
    return block
  }
  return {
    /** Opens a block with no identity of its own (text, thinking, redacted). */
    open(index: number, kind: BlockKind, fields: Record<string, unknown> | null = null): number {
      return allocate(index, kind, { fields }).slot
    },
    openCall(
      index: number,
      id: string,
      name: string,
      fields: Record<string, unknown> | null,
    ): number {
      return allocate(index, 'tool', { call: { id, name }, fields }).slot
    },
    /** Opens a block kept whole (spec 02): see normaliseAnthropicEvents(). */
    openVendor(
      index: number,
      raw: Record<string, unknown>,
      replay: 'same-model' | 'never',
    ): number {
      return allocate(index, 'vendor', { raw, replay }).slot
    },
    /**
     * The slot a text / thinking delta belongs to: the open block when its kind matches, a
     * fresh slot when the index holds nothing or holds another kind, and null when the block
     * open there is a vendor block (a text or thinking delta does not apply to one — the SDK's
     * accumulator ignores it too — and its content is not ours).
     */
    deltaSlot(index: number, kind: 'text' | 'thinking'): number | null {
      const block = open.get(index)
      if (block === undefined) return allocate(index, kind).slot
      if (block.kind === 'vendor') return null
      return block.kind === kind ? block.slot : allocate(index, kind).slot
    },
    /** As deltaSlot, for a signature: a second one for the same block opens a fresh slot. */
    signatureSlot(index: number): number | null {
      const block = open.get(index)
      if (block?.kind === 'vendor') return null
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
    /**
     * The open block at `index` that takes an argument fragment: a call of ours, or a vendor block
     * whose start carried an `input` (the blocks the SDK's accumulator builds an input for).
     */
    inputOf(index: number): OpenBlock | null {
      const block = open.get(index)
      if (block === undefined) return null
      if (block.call !== null) return block
      return block.raw !== null && Object.hasOwn(block.raw, 'input') ? block : null
    },
    /** A citation for the text block open at `index`, appended to its `citations` field. */
    cite(index: number, citation: unknown): void {
      const block = open.get(index)
      if (block?.kind !== 'text') return
      const fields = block.fields ?? {}
      const cited = fields['citations']
      fields['citations'] = Array.isArray(cited) ? [...cited, citation] : [citation]
      block.fields = fields
    },
    close(index: number): OpenBlock | null {
      const block = open.get(index)
      if (block === undefined) return null
      open.delete(index)
      return block
    },
  }
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
  const status = errorStatus(error)
  const code = classifyAnthropicError(error, chain, status, providerCode)
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
  // Spec 02, 01 修补 4 (A5): which limit ended the stream. Both are connection failures the
  // classifier already reads as a retryable `network`.
  const timeout = timeoutKindOf(chain)
  if (timeout !== null) event.timeout = timeout
  // Spec 02, 01 修补 2 (H12): the monthly spend limit resets at 00:00 UTC on the 1st.
  if (code === 'quota-exhausted' && isSpendLimit(error))
    event.resetAt = startOfNextMonthUtc(ctx.now)
  return event
}

/** The first-byte limit is the SDK's own timeout; the idle one is the watchdog's (01 修补 4). */
export function timeoutKindOf(chain: readonly unknown[]): 'first-byte' | 'idle' | null {
  if (chain.some((link) => link instanceof StreamIdleTimeoutError)) return 'idle'
  if (chain.some((link) => link instanceof APIConnectionTimeoutError)) return 'first-byte'
  return null
}

/** 429 with `error.details.error_code = enforced_spend_limit_reached` (01 修补 5). */
function isSpendLimit(error: unknown): boolean {
  const body = objectField(error, 'error')
  const inner = objectField(body, 'error')
  const details = objectField(inner, 'details') ?? objectField(body, 'details')
  return stringField(details, 'error_code') === 'enforced_spend_limit_reached'
}

/** The vendor's own `error.message`, not the SDK's `<status> <body>` summary. */
function vendorMessage(error: unknown): string {
  const body = objectField(error, 'error')
  return (
    stringField(objectField(body, 'error'), 'message') ??
    stringField(body, 'message') ??
    ''
  ).trim()
}

function startOfNextMonthUtc(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

function classifyAnthropicError(
  error: unknown,
  chain: readonly unknown[],
  status: number | undefined,
  providerCode: string | null,
): ProviderErrorCode {
  // First, and anywhere in the chain: the host refused to let the request out. The SDK wraps a
  // rejected fetch as `new APIConnectionError({ cause })`, so the denial arrives one or two
  // links down.
  if (hasEgressDenial(chain)) return 'egress-denied'
  // Spec 02, 01 修补 5 (H12): the two spend limits, before the status table reads them as a
  // retryable rate limit or a plain invalid request.
  if (status === 429 && isSpendLimit(error)) return 'quota-exhausted'
  if (status === 400 && vendorMessage(error).startsWith('You have reached your specified')) {
    return 'quota-exhausted'
  }
  if (status !== undefined) return statusErrorCode(status, errorMessage(error))
  if (providerCode !== null && Object.hasOwn(ERROR_TYPES, providerCode)) {
    const code = ERROR_TYPES[providerCode as AnthropicErrorType]
    return code === 'invalid-request' && looksLikeContextOverflow(errorMessage(error))
      ? 'context-overflow'
      : code
  }
  // A failed connection, including the SDK's own timeout (a subclass of this one) and a body that
  // failed while being read (readBody rewraps those, because the SDK rethrows them verbatim). A
  // bare TypeError is deliberately NOT read as one: everything the transport can raise has been
  // marked by the time it reaches here, so what is left was raised by this adapter's own
  // normalisation, and advertising our bug as retryable would have the phase 2 loop resend a
  // request nothing was wrong with.
  if (chain.some((link) => link instanceof APIConnectionError)) return 'network'
  // Not classified, so not resent: `unknown` is the one code that is never retryable by
  // default, and a payload whose failure we could not explain is the wrong thing to repeat.
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

/** The `error.type` the vendor named, from either the typed field or the nested error body. */
function providerCodeOf(error: unknown): string | null {
  const direct = stringField(error, 'type')
  if (direct !== null) return direct
  const body = objectField(error, 'error')
  return stringField(objectField(body, 'error'), 'type')
}
