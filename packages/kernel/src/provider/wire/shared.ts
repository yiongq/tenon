/**
 * What the two wire encoders share, plus the pure helpers the session service needs for the
 * `provider/attempt_completed` request snapshot (spec 01 §Provider 层, entry model).
 *
 * Everything here is pure: no I/O, no clock, no randomness. `promptHash` is the hash of
 * `canonicalJson(body)`, so the body a wire encoder builds must contain NO undefined-valued
 * key — canonicalJson refuses one, and "absent" on the wire means the key was never written.
 *
 * Neither encoder copies the caller's blocks, tool schemas or requestParams values: a
 * ProviderRequest is a value, and the hash is taken from the same object the SDK is handed.
 */
import { CanonicalJsonError, canonicalJson } from '../../tape/canonical-json.js'
import type { AttemptRequestSnapshot } from '../../tape/entry.js'
import { sha256Hex } from '../../tape/hash.js'
import { ProviderInvalidArgumentError } from '../errors.js'
import { applyThinkingDecision, decideThinking } from '../thinking.js'
import type { ThinkingApplication, ThinkingBlock, ThinkingTarget } from '../thinking.js'
import type {
  ContentBlock,
  EncodedRequest,
  ModelInfo,
  ProviderId,
  ProviderRequest,
  ThinkingDecision,
} from '../types.js'

/** The image block both wires have to place; its media type is checked per wire. */
export type ImageContentBlock = Extract<ContentBlock, { type: 'image' }>

/**
 * canonicalJson with the tape layer's error class translated into a provider one.
 *
 * The encoders copy caller data by reference — a `ToolSpec.inputSchema`, a tool call's `input`,
 * every `requestParams` value — so a value canonicalJson refuses (an undefined-valued key nested
 * one level down, a `toJSON` method, 100 levels of nesting) surfaces when the body is hashed,
 * which is inside encode(). Throwing is right (spec §中止、重试、错误: only programmer errors
 * throw), but `CanonicalJsonError` is the class a caller uses to recognise tape corruption; every
 * throw out of encode() is one named provider error instead.
 */
export function canonicalText(value: unknown, what: string): string {
  try {
    return canonicalJson(value)
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new ProviderInvalidArgumentError(`${what} cannot be encoded — ${error.message}`)
    }
    throw error
  }
}

/** `promptHash` / `toolDefinitionsHash`: one recipe, used by both wires. */
export function canonicalHash(value: unknown, what: string): string {
  return sha256Hex(canonicalText(value, what))
}

/**
 * The `systemHash` of a request with no system prompt. Deliberately NOT a digest: absence and
 * the empty prompt have to be distinguishable from every real hash when an auditor reads a
 * `provider/attempt_completed` fact, and 64 zeros is a value SHA-256 will not produce.
 */
export const NO_SYSTEM_PROMPT_HASH = '0'.repeat(64)

/**
 * The snapshot's `systemHash`. An empty system prompt is treated as no system prompt — the
 * same reading both encoders take when they decide whether to write a system field at all, so
 * the snapshot cannot claim a prompt the body does not carry.
 */
export function systemHash(system: string | undefined): string {
  if (system === undefined || system === '') return NO_SYSTEM_PROMPT_HASH
  return sha256Hex(system)
}

/**
 * Invariant: `max_tokens` is never undefined — it is mandatory on the Anthropic wire.
 *
 * A limit that is not a positive integer is refused rather than sent: `0`, `-1`, `1.5` and `NaN`
 * are all 400s (or, for NaN, an unhashable body) that this pure function can see coming, and the
 * spec feeds this number from the `TENON_MAX_TOKENS` environment variable, where a mis-parsed
 * value is a realistic input. `requestSnapshot` goes through here too, so the recorded number and
 * the sent one cannot disagree.
 */
export function effectiveMaxTokens(req: ProviderRequest): number {
  const limit = req.maxTokens ?? req.model.maxOutputTokens
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ProviderInvalidArgumentError(
      `model ${req.model.id}: max_tokens must be a positive integer, not ${String(limit)}`,
    )
  }
  return limit
}

/**
 * The request parameter snapshot a `provider/attempt_completed` fact records. It lives here so
 * the session service cannot disagree with the encoders about `maxTokens` or about what counts
 * as "no system prompt": a snapshot that disagrees makes the promptHash unverifiable, which is
 * the one thing the snapshot exists for (acceptance 3).
 *
 * Every key here names something an encoder writes into the body, and `requestParams` may not
 * overwrite any of them (see mergeRequestParams), so the snapshot describes the request that was
 * actually built. One exception, and it is deliberate: `thinking` on the OpenAI wire has no body
 * key at all — that wire's vendors take their own parameter through `requestParams` (spec §内置
 * provider) — so there the field records what was ASKED for, not a key of the body.
 */
export function requestSnapshot(req: ProviderRequest): AttemptRequestSnapshot {
  const snapshot: AttemptRequestSnapshot = {
    systemHash: systemHash(req.system),
    maxTokens: effectiveMaxTokens(req),
  }
  if (req.temperature !== undefined) snapshot.temperature = req.temperature
  const thinking = req.thinking
  if (thinking !== undefined) {
    snapshot.thinking =
      thinking.budgetTokens === undefined
        ? { enabled: thinking.enabled }
        : { enabled: thinking.enabled, budgetTokens: thinking.budgetTokens }
  }
  return snapshot
}

/** Whether a system prompt goes on the wire at all: see systemHash(). */
export function hasSystemPrompt(system: string | undefined): system is string {
  return system !== undefined && system !== ''
}

/** What the thinking guard compares against for THIS request; `hasTools` turns rule 4. */
export function thinkingTargetFor(req: ProviderRequest): ThinkingTarget {
  return { model: req.model, hasTools: (req.tools?.length ?? 0) > 0 }
}

/**
 * Every reasoning block of every message goes through this, and only through this: the
 * decision is recorded before it is applied, so `thinkingDecisions` is one entry per reasoning
 * block in message/block order whatever the wire then does with it.
 */
export function guardReasoning(
  block: ThinkingBlock,
  target: ThinkingTarget,
  decisions: ThinkingDecision[],
): ThinkingApplication {
  const decision = decideThinking(block, target)
  decisions.push(decision)
  return applyThinkingDecision(block, decision, target.model)
}

/**
 * A ModelInfo from another provider is a programmer error, and a silent one: the guard's rule 1
 * compares a block's `provider` against `model.providerId`, so encoding someone else's model
 * here would stamp this provider's audit onto another provider's history.
 */
export function assertModelBelongs(model: ModelInfo, providerId: ProviderId): void {
  if (model.providerId !== providerId) {
    throw new ProviderInvalidArgumentError(
      `model ${model.id} belongs to provider "${model.providerId}", not "${providerId}"`,
    )
  }
}

/**
 * A tool result whose id no tool request in an EARLIER message asked for. Both wires reject it,
 * and the id is what pairs the two halves — encoding it anyway would send a result the model
 * cannot attach to anything. "Earlier message", not "earlier block": a result must follow the
 * assistant turn that declared the call, and the role guards below are what make the two halves
 * land in different messages in the first place.
 */
export function assertToolRequested(
  requested: ReadonlySet<string>,
  id: string,
  wire: string,
): void {
  if (!requested.has(id)) {
    throw new ProviderInvalidArgumentError(
      `${wire}: tool response "${id}" has no tool request with that id in an earlier message`,
    )
  }
}

/**
 * A block kind the wire only accepts in one role. Both wires refuse rather than move the block: a
 * tool call on a user turn, a tool result on an assistant turn, an image the assistant "sent" or a
 * reasoning block outside the assistant's own turn is a transcript the wire cannot express, and
 * each vendor's content union says so. Refusing beats both alternatives — rewriting which turn a
 * block sits in would invent a transcript no fact records, and dropping it silently would let the
 * model answer about an image it was never shown.
 */
export function assertBlockRole(
  what: string,
  role: 'user' | 'assistant',
  expected: 'user' | 'assistant',
  wire: string,
): void {
  if (role !== expected) {
    throw new ProviderInvalidArgumentError(
      `${wire}: ${what} can only be sent in the ${expected} role, not in the ${role} one`,
    )
  }
}

/**
 * Both vendors require at least one message. An empty list reaches here two ways — a caller that
 * assembled no context, or a thinking guard that emptied every turn there was — and both are 400s
 * a pure function can see coming, next door to the spec's own promise that replay never produces
 * an empty assistant turn.
 */
export function assertHasMessages(count: number, wire: string): void {
  if (count === 0) {
    throw new ProviderInvalidArgumentError(
      `${wire}: a request must carry at least one message, and none survived encoding`,
    )
  }
}

/**
 * Invariant 6 on the way out: a tool call's input is an object, so empty input encodes as `{}` on
 * one wire and `'{}'` on the other — never `null`, never a primitive. The type says so, but a
 * transcript read back from the Tape is data, and both wires would carry `input: null` /
 * `arguments: 'null'` from one without noticing. Coercing to `{}` instead would invent an empty
 * argument set for a call whose arguments were lost.
 */
export function assertToolInput(
  input: unknown,
  name: string,
  wire: string,
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProviderInvalidArgumentError(
      `${wire}: tool call "${name}" has a non-object input; empty input is {}, never null`,
    )
  }
  return input as Record<string, unknown>
}

/** The media types a wire documents. Anything else is a caller bug, not a vendor 400. */
export function assertImageMediaType(
  block: ImageContentBlock,
  accepted: readonly string[],
  wire: string,
): void {
  if (!accepted.includes(block.mediaType)) {
    throw new ProviderInvalidArgumentError(
      `${wire}: image media type "${block.mediaType}" is not accepted on this wire`,
    )
  }
}

/**
 * `ModelInfo.requestParams` merged in LAST — the escape hatch for a vendor that broke the
 * abstraction (zhipu's non-OpenAI `thinking` travels this way). It is purely ADDITIVE: it may
 * write keys the encoder does not, and it may not touch the ones the wire RESERVES (`reserved`
 * below), which is every key that encoder writes plus the few it deliberately leaves to the SDK.
 * A collision throws rather than winning or losing silently.
 *
 * The rule is the audit: what `promptHash` covers has to be the request the fact describes. A
 * table that redirected `model`, emptied `messages`, swapped `tools`, replaced `system` or turned
 * `temperature` / `thinking` into something else would leave the `provider/attempt_completed`
 * snapshot describing a request nobody sent — `promptHash` would still be right about the bytes,
 * and every other recorded field wrong about their meaning. The same criterion covers a parameter
 * the SDK RELOCATES out of the body (Anthropic's `user_profile_id` / `workspace_id` become
 * headers): hashing a key that never travels in the body breaks 「被哈希的就是被发出去的」.
 *
 * An undefined value is skipped rather than written: JSON.stringify would drop such a key on
 * the way out anyway, so writing it would only make canonicalJson (and therefore promptHash)
 * fail on a body the wire would have accepted.
 */
export function mergeRequestParams(
  body: Record<string, unknown>,
  model: ModelInfo,
  reserved: readonly string[],
): void {
  const params = model.requestParams
  if (params === undefined) return
  for (const key of Object.keys(params)) {
    if (reserved.includes(key)) {
      throw new ProviderInvalidArgumentError(
        `model ${model.id}: requestParams may not set "${key}"; this wire reserves it for encode()`,
      )
    }
    // Assigning `__proto__` sets the body's prototype instead of creating an own property, so the
    // parameter would silently never reach the wire (and canonicalJson would then reject the body
    // for not being plain). A parameter that cannot travel is a table error, not a no-op.
    if (key === '__proto__') {
      throw new ProviderInvalidArgumentError(
        `model ${model.id}: requestParams may not set "__proto__"; it would not reach the wire`,
      )
    }
    const value = params[key]
    if (value === undefined) continue
    body[key] = value
  }
}

/** Assembles the EncodedRequest once a wire has built its body and tool definitions. */
export function sealEncoded(
  providerId: ProviderId,
  modelId: string,
  body: Record<string, unknown>,
  toolDefinitions: readonly unknown[],
  thinkingDecisions: readonly ThinkingDecision[],
): EncodedRequest {
  return {
    providerId,
    modelId,
    body,
    promptHash: canonicalHash(body, 'the request body'),
    // Hashed even when the request carries no tools: `[]` is a statement about this request,
    // and it has to be distinguishable from "the same tools as last time".
    toolDefinitionsHash: canonicalHash(toolDefinitions, 'the tool definitions'),
    thinkingDecisions,
  }
}
