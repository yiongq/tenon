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
import { applyThinkingDecision, decideThinking, decideVendorBlock } from '../thinking.js'
import type {
  ThinkingApplication,
  ThinkingBlock,
  ThinkingTarget,
  VendorBlock,
} from '../thinking.js'
import type {
  ContentBlock,
  EncodedRequest,
  InternalMessage,
  ModelInfo,
  ProviderId,
  ProviderRequest,
  ThinkingDecision,
  ThinkingSpec,
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
  // Spec 02, 01 修补 2: what the encoder WROTE. Both wires write `effort` whenever one is given (a
  // level the row does not declare never gets this far), and `display` only while thinking is on —
  // the same reading the Anthropic encoder takes (thinkingIsOn below), which is the only wire whose
  // rows may declare a display at all.
  if (req.effort !== undefined) snapshot.effort = req.effort
  if (req.display !== undefined && thinkingIsOn(req)) snapshot.display = req.display
  if (req.dropThinkingBefore !== undefined) snapshot.dropThinkingBefore = req.dropThinkingBefore
  return snapshot
}

/**
 * Whether thinking is on for this request (spec 02, 01 修补 3): turned on explicitly, or on by the
 * model's default and not turned off this time. A row with no `thinkingSpec` has no default to fall
 * back on, so it reads as off unless the caller turned it on.
 */
export function thinkingIsOn(req: ProviderRequest): boolean {
  return req.thinking?.enabled ?? req.model.thinkingSpec?.defaultOn ?? false
}

/**
 * The ModelInfo fields encode() reads (spec 02, 01 修补 7) — and therefore the only ones
 * `modelWireHash` covers. An encoder that starts reading another field adds it here in the same
 * change; a test watches encode() through a Proxy to hold both wires to it.
 */
export const WIRE_MODEL_FIELDS = Object.freeze([
  'id',
  'providerId',
  'canonicalId',
  'maxOutputTokens',
  'thinkingPreservationFormat',
  'reasoningEchoField',
  'usageNeedsOptIn',
  'requestParams',
  'supportsCacheControl',
  'thinkingSpec',
] as const satisfies readonly (keyof ModelInfo)[])

/**
 * `provider/attempt_completed.modelWireHash`: canonicalHash(pick(model, WIRE_MODEL_FIELDS)). An
 * absent field is left out of the pick rather than written as undefined, which canonicalJson refuses
 * — and "absent" is exactly what the row said. Editing `pricing` or `purposeKey` leaves it unchanged.
 */
export function modelWireHash(model: ModelInfo): string {
  const picked: Record<string, unknown> = {}
  for (const field of WIRE_MODEL_FIELDS) {
    const value = model[field]
    if (value !== undefined) picked[field] = value
  }
  return canonicalHash(picked, `the wire fields of model ${model.id}`)
}

/**
 * `thinkingEffortSupport()` for a row that declares a thinking shape (spec 02, 01 修补 3): `budget`
 * mode answers 'budget', any declared effort level answers 'effort', anything else 'none'.
 */
export function effortTierOf(spec: ThinkingSpec): 'none' | 'budget' | 'effort' {
  if (spec.mode === 'budget') return 'budget'
  return (spec.effortLevels?.length ?? 0) > 0 ? 'effort' : 'none'
}

/**
 * The refusals both wires share (spec 02, 01 修补 3; decision A1): an effort the row does not list
 * in `effortLevels`, or a display it does not list in `displays` — a row with no `thinkingSpec`
 * lists neither. A malformed `dropThinkingBefore` is refused here too: it names a message index.
 */
export function assertThinkingRequest(req: ProviderRequest, wire: string): void {
  const spec = req.model.thinkingSpec
  const effort = req.effort
  if (effort !== undefined && !(spec?.effortLevels ?? []).includes(effort)) {
    throw new ProviderInvalidArgumentError(
      `${wire}: model ${req.model.id} declares no effort level "${effort}"`,
    )
  }
  const display = req.display
  if (display !== undefined && !(spec?.displays ?? []).includes(display)) {
    throw new ProviderInvalidArgumentError(
      `${wire}: model ${req.model.id} declares no thinking display "${display}"`,
    )
  }
  const cut = req.dropThinkingBefore
  if (cut !== undefined && (!Number.isSafeInteger(cut) || cut < 0)) {
    throw new ProviderInvalidArgumentError(
      `${wire}: dropThinkingBefore must be a non-negative integer, not ${String(cut)}`,
    )
  }
}

/**
 * `samplingDefaultsOnly` (spec 02, 01 修补 3; decisions M3, A1): a non-default sampling value is
 * refused rather than quietly dropped — `temperature` only 1.0, `top_p` only >= 0.99, `top_k` never.
 * `temperature` is reserved on both wires, so it can only come from the request; the other two have
 * no request field and can only come from `requestParams`.
 */
export function assertSamplingDefaults(req: ProviderRequest, wire: string): void {
  if (req.model.thinkingSpec?.samplingDefaultsOnly !== true) return
  const refuse = (what: string): never => {
    throw new ProviderInvalidArgumentError(
      `${wire}: model ${req.model.id} accepts sampling parameters at their defaults only; ${what}`,
    )
  }
  if (req.temperature !== undefined && req.temperature !== 1) {
    refuse(`temperature ${String(req.temperature)} is not 1.0`)
  }
  const params = req.model.requestParams ?? {}
  if (Object.hasOwn(params, 'top_p')) {
    const topP = params['top_p']
    if (typeof topP !== 'number' || !(topP >= 0.99)) refuse(`top_p ${String(topP)} is below 0.99`)
  }
  if (Object.hasOwn(params, 'top_k')) refuse('top_k is not accepted at all')
}

/**
 * Spec 02, 01 修补 3 (decision A2; 01 修补 9 (k)): the last message of the request is the user's.
 * Checked on `req.messages` as the caller built them, after every check 01 already made — so a
 * request 01 refused is still refused with 01's error. 02 makes no exception: a continuation prompt
 * is itself a user message.
 */
export function assertLastTurnIsUser(messages: readonly InternalMessage[], wire: string): void {
  const last = messages.at(-1)
  if (last !== undefined && last.role !== 'user') {
    throw new ProviderInvalidArgumentError(
      `${wire}: a request must end with a user turn, and this one ends with an ${last.role} turn`,
    )
  }
}

/** Whether a system prompt goes on the wire at all: see systemHash(). */
export function hasSystemPrompt(system: string | undefined): system is string {
  return system !== undefined && system !== ''
}

/** What the thinking guard compares against for THIS request; `hasTools` turns rule 4. */
export function thinkingTargetFor(req: ProviderRequest): ThinkingTarget {
  const target = { model: req.model, hasTools: (req.tools?.length ?? 0) > 0 }
  return req.dropThinkingBefore === undefined
    ? target
    : { ...target, dropThinkingBefore: req.dropThinkingBefore }
}

/**
 * Every reasoning block of every message goes through this, and only through this: the
 * decision is recorded before it is applied, so `thinkingDecisions` is one entry per reasoning
 * block in message/block order whatever the wire then does with it. `messageIndex` is the block's
 * message within `req.messages`, which the compaction rule (spec 02, H10) reads.
 */
export function guardReasoning(
  block: ThinkingBlock,
  target: ThinkingTarget,
  decisions: ThinkingDecision[],
  messageIndex: number,
): ThinkingApplication {
  const decision = decideThinking(block, target, messageIndex)
  decisions.push(decision)
  return applyThinkingDecision(block, decision, target.model)
}

/**
 * As guardReasoning(), for a vendor block (spec 02, 01 修补 2): the decision is recorded in the same
 * list, in block order, and the block either goes back exactly as stored or not at all.
 */
export function guardVendorBlock(
  block: VendorBlock,
  target: ThinkingTarget,
  decisions: ThinkingDecision[],
): boolean {
  const decision = decideVendorBlock(block, target)
  decisions.push(decision)
  return decision.action === 'replay'
}

/**
 * `vendorFields` merged back into the wire block they were decoded from (spec 02, 01 修补 2): the
 * fields the content model has no place for, then the block's own. The block's own keys win, so a
 * stored field can never rewrite a signature, an id or the text itself.
 */
export function withVendorFields<T extends Record<string, unknown>>(
  wireBlock: T,
  fields: Record<string, unknown> | undefined,
): T {
  if (fields === undefined) return wireBlock
  const merged: Record<string, unknown> = { ...wireBlock }
  for (const key of Object.keys(fields)) {
    // `__proto__` would set the prototype instead of an own key — see mergeRequestParams.
    if (Object.hasOwn(wireBlock, key) || key === '__proto__') continue
    merged[key] = fields[key]
  }
  return merged as T
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

/** `provider/attempt_completed.encoder` (spec 02, 01 修补 7): which encoder built a body. */
export interface EncoderInfo {
  readonly wire: 'anthropic-messages' | 'openai-chat'
  /** The encoder's own version: every commit that changes what it encodes adds one. */
  readonly version: number
  /** The SDK the body is handed to, as `<package>@<version>`. */
  readonly sdk: string
}

/**
 * Which encoder produced each EncodedRequest, kept beside the object rather than on it: the spec
 * adds `encoder` to the attempt fact but no member to EncodedRequest, and the writer of that fact
 * holds only the Provider and what its encode() returned. Weak, so it holds nothing alive; filled
 * only by sealEncoded(), so a request no wire of this build encoded has no entry.
 */
const ENCODERS = new WeakMap<EncodedRequest, EncoderInfo>()

/**
 * The encoder a request came from, or null when it came from none of this build's wires (a copy of
 * the object, or a test double with an encoder of its own) — an attempt then records no `encoder`,
 * and invariant 33 does not cover it.
 */
export function encoderOf(encoded: EncodedRequest): EncoderInfo | null {
  return ENCODERS.get(encoded) ?? null
}

/** Assembles the EncodedRequest once a wire has built its body and tool definitions. */
export function sealEncoded(
  providerId: ProviderId,
  modelId: string,
  body: Record<string, unknown>,
  toolDefinitions: readonly unknown[],
  thinkingDecisions: readonly ThinkingDecision[],
  encoder: EncoderInfo,
): EncodedRequest {
  const encoded: EncodedRequest = {
    providerId,
    modelId,
    body,
    promptHash: canonicalHash(body, 'the request body'),
    // Hashed even when the request carries no tools: `[]` is a statement about this request,
    // and it has to be distinguishable from "the same tools as last time".
    toolDefinitionsHash: canonicalHash(toolDefinitions, 'the tool definitions'),
    thinkingDecisions,
  }
  ENCODERS.set(encoded, encoder)
  return encoded
}
