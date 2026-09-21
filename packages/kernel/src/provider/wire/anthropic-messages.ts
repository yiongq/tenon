/**
 * encode() for the Anthropic Messages wire — the pure half of the adapter (spec 01 §Provider
 * 层). No SDK import, no network, no clock: step 10's `AnthropicMessagesProvider.encode()` is a
 * one-line delegation to the function below, which is what keeps the wire format testable
 * without a client and the hashes reproducible from a Tape alone.
 *
 * `stream` is deliberately absent from the body: the SDK sets it when it opens the stream.
 *
 * Every key is written only when it has a value — canonicalJson (and therefore `promptHash`)
 * refuses an undefined-valued key, and the wire's notion of "absent" is a missing key.
 */
import { ProviderInvalidArgumentError } from '../errors.js'
import type { ThinkingApplication } from '../thinking.js'
import type {
  ContentBlock,
  EncodedRequest,
  ModelInfo,
  ProviderId,
  ProviderRequest,
  ThinkingDecision,
  ToolSpec,
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
 *   `temperature`, `thinking`. All but `model` and `messages` are also what the
 *   `provider/attempt_completed` record describes (`systemHash`, `maxTokens`, `temperature`,
 *   `thinking` in the request snapshot, `toolDefinitionsHash` beside it), so a passthrough that
 *   replaced one would leave the fact describing a request nobody sent;
 * - `stream`, which this encoder deliberately leaves to the SDK;
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
