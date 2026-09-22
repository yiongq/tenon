/**
 * The thinking guard — one decision function every encode() calls for every reasoning
 * block, plus the helper that applies a decision, so the two wire adapters do not each
 * write their own (spec 01 §thinking 守卫).
 *
 * The seven rules are two independent gates in a fixed order: rules 1-2 are the SOURCE gate
 * (history another provider or another model produced is dropped outright), rules 3-7 are
 * the target's RETENTION policy. Re-stamping a block onto the target provider is the only
 * way to reach the second gate — which is what makes the order observable and worth testing.
 *
 * Signatures are never rewritten and never synthesised: a signature Anthropic did not
 * produce comes back as a 400.
 */
import { ProviderInvalidArgumentError } from './errors.js'
import type { ContentBlock, ModelInfo, ThinkingDecision } from './types.js'

/** The two reasoning block kinds the guard judges. */
export type ThinkingBlock = Extract<ContentBlock, { type: 'thinking' | 'redacted-thinking' }>

/**
 * What the guard compares against. `hasTools` is not on ModelInfo because it is a property
 * of THIS request, and rule 4 turns on it; the model alone cannot answer it.
 */
export interface ThinkingTarget {
  readonly model: ModelInfo
  /** Whether this request carries tools at all (`ProviderRequest.tools` is non-empty). */
  readonly hasTools: boolean
}

/**
 * The model identity the guard compares on, and therefore the one stamped onto a thinking
 * block: `canonicalId` when a resale channel declares one, else `id`. The spec's rule for
 * `canonicalId` is that pricing AND the thinking rules are computed from it, so swapping a
 * Bedrock / Azure endpoint in front of the same upstream model must not read as a model
 * change. `EncodedRequest.modelId` stays the wire id and is never used here.
 */
export function thinkingModelId(model: ModelInfo): string {
  const canonical = model.canonicalId
  // A blank `canonicalId` is not a mapping. `??` would keep it, and every model on the
  // provider carrying one would collapse to the same identity: two different models would
  // then compare equal at rule 2, and a signature would replay to a model that never issued
  // it. A non-blank value is returned as it stands — trimming it would rewrite an identity.
  if (canonical === undefined || canonical.trim() === '') return model.id
  return canonical
}

export function decideThinking(block: ThinkingBlock, target: ThinkingTarget): ThinkingDecision {
  const { model } = target
  // 1. Another provider's history is never replayed, whatever the target would do with it.
  if (block.provider !== model.providerId) return { action: 'drop', reason: 'foreign-provider' }
  // 2. Same provider, different model: the signature is bound to the model that signed it.
  if (block.providerModel !== thinkingModelId(model)) {
    return { action: 'drop', reason: 'model-changed' }
  }
  const redacted = block.type === 'redacted-thinking'
  switch (model.thinkingPreservationFormat) {
    // 3. The target keeps no reasoning at all.
    case 'drop':
      return { action: 'drop', reason: 'target-drops' }
    // 4. Echoed under reasoningEchoField, but only when the request carries tools. Redacted
    //    data has no textual form to echo, so it goes regardless of tools.
    case 'reasoning-content':
      if (redacted) return { action: 'drop', reason: 'redacted-unsupported' }
      return target.hasTools
        ? { action: 'echo', reason: 'same-model' }
        : { action: 'drop', reason: 'no-tools' }
    // 5. Thinking survives as plain text; redacted data cannot be turned into text.
    case 'text-only':
      return redacted
        ? { action: 'drop', reason: 'redacted-unsupported' }
        : { action: 'downgrade', reason: 'same-model' }
    // 6. Signed blocks without a signature cannot be replayed, and one is never invented.
    //    A redacted block carries no signature and needs none: it replays opaque.
    //    Declared deviation: the spec says 「签名为空」 and this reads whitespace-only as empty
    //    too — the stricter reading, since replaying whitespace is the 400 this rule exists
    //    to avoid, and unreachable from a real response (signatures are base64).
    case 'signed-blocks':
      if (!redacted && block.signature.trim() === '') {
        return { action: 'drop', reason: 'missing-signature' }
      }
      // 7. Otherwise it goes back exactly as it was stored.
      return { action: 'replay', reason: 'same-model' }
  }
}

/**
 * What a decision does to the block on the way into a request body. `keep` hands back the
 * very same block, which is how "byte for byte" is guaranteed rather than asserted.
 */
export type ThinkingApplication =
  | { kind: 'keep'; block: ThinkingBlock }
  | { kind: 'text'; block: Extract<ContentBlock, { type: 'text' }> }
  | { kind: 'echo'; field: 'reasoning_content' | 'reasoning'; text: string }
  | { kind: 'drop' }

/**
 * Applies a decision from decideThinking(). Both adapters call this instead of interpreting
 * `action` themselves; an action that cannot apply to this block (echoing or downgrading
 * opaque redacted data, a 'reasoning-content' model with no field name declared) is a bug
 * in our own tables and throws.
 */
export function applyThinkingDecision(
  block: ThinkingBlock,
  decision: ThinkingDecision,
  model: ModelInfo,
): ThinkingApplication {
  switch (decision.action) {
    case 'drop':
      return { kind: 'drop' }
    case 'replay':
      return { kind: 'keep', block }
    case 'echo': {
      const text = textOf(block, 'echoed')
      const field = model.reasoningEchoField
      if (field === undefined) {
        throw new ProviderInvalidArgumentError(
          `model ${model.id} preserves thinking as reasoning-content but declares no reasoningEchoField`,
        )
      }
      return { kind: 'echo', field, text }
    }
    case 'downgrade':
      return { kind: 'text', block: { type: 'text', text: textOf(block, 'downgraded') } }
  }
}

function textOf(block: ThinkingBlock, action: string): string {
  if (block.type === 'redacted-thinking') {
    throw new ProviderInvalidArgumentError(`redacted thinking is opaque and cannot be ${action}`)
  }
  return block.text
}
