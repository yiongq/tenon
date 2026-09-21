/**
 * encode() for the OpenAI chat-completions wire — the pure half of the adapter (spec 01
 * §Provider 层). No SDK import, no network, no clock: step 11's `OpenAIChatProvider.encode()`
 * delegates here, and the two OpenAI-compatible vendors the spec names (zhipu, ollama) differ
 * only by `ModelInfo` — `requestParams` carries zhipu's non-OpenAI `thinking` parameter and
 * `reasoningEchoField` carries ollama's `reasoning` spelling.
 *
 * `stream: true` is part of the body here (unlike the Anthropic wire, where the SDK sets it),
 * because `stream_options.include_usage` is only legal alongside it and the usage opt-in is
 * what this wire needs to report usage at all.
 *
 * Every key is written only when it has a value: canonicalJson (and therefore `promptHash`)
 * refuses an undefined-valued key.
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
  canonicalText,
  effectiveMaxTokens,
  guardReasoning,
  hasSystemPrompt,
  mergeRequestParams,
  sealEncoded,
  thinkingTargetFor,
} from './shared.js'
import type { ImageContentBlock } from './shared.js'

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
