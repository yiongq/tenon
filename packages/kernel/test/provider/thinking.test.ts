/**
 * The thinking guard, rule by rule (acceptance 16): every case asserts both `action` and
 * `reason`, and the last block of cases asserts that the ORDER of the rules is observable —
 * a foreign block is dropped as foreign-provider even when the target would have dropped it
 * anyway, so a re-ordered implementation cannot pass by accident.
 */
import { describe, expect, it } from 'vitest'
import {
  ProviderInvalidArgumentError,
  applyThinkingDecision,
  decideThinking,
} from '../../src/index.js'
import type {
  ContentBlock,
  ModelInfo,
  ThinkingBlock,
  ThinkingDecision,
  ThinkingTarget,
} from '../../src/index.js'

/** A signature with the base64 alphabet in it: equality here is byte equality. */
const SIGNATURE = 'EqoBCkgIARABGAIiQL2+/wK3Zg=='

function modelOf(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'model-a',
    providerId: 'anthropic',
    contextLimit: 200_000,
    maxOutputTokens: 8192,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: false,
    supportsCacheControl: true,
    thinkingPreservationFormat: 'signed-blocks',
    usageNeedsOptIn: false,
    ...overrides,
  }
}

function thinkingOf(
  overrides: Partial<Extract<ContentBlock, { type: 'thinking' }>> = {},
): Extract<ContentBlock, { type: 'thinking' }> {
  return {
    type: 'thinking',
    text: 'weighing the options',
    signature: SIGNATURE,
    provider: 'anthropic',
    providerModel: 'model-a',
    ...overrides,
  }
}

function redactedOf(
  overrides: Partial<Extract<ContentBlock, { type: 'redacted-thinking' }>> = {},
): Extract<ContentBlock, { type: 'redacted-thinking' }> {
  return {
    type: 'redacted-thinking',
    data: 'RURBQ1RFRA==',
    provider: 'anthropic',
    providerModel: 'model-a',
    ...overrides,
  }
}

function targetOf(model: ModelInfo, hasTools = false): ThinkingTarget {
  return { model, hasTools }
}

interface GuardCase {
  readonly name: string
  readonly block: ThinkingBlock
  readonly target: ThinkingTarget
  readonly expected: ThinkingDecision
}

const CASES: readonly GuardCase[] = [
  // Rule 1 — source gate: another provider's history.
  {
    name: 'rule 1: a thinking block from another provider',
    block: thinkingOf({ provider: 'zhipu' }),
    target: targetOf(modelOf()),
    expected: { action: 'drop', reason: 'foreign-provider' },
  },
  {
    name: 'rule 1: a redacted block from another provider',
    block: redactedOf({ provider: 'zhipu' }),
    target: targetOf(modelOf()),
    expected: { action: 'drop', reason: 'foreign-provider' },
  },
  // Rule 2 — source gate: same provider, another model.
  {
    name: 'rule 2: a thinking block from another model',
    block: thinkingOf({ providerModel: 'model-b' }),
    target: targetOf(modelOf()),
    expected: { action: 'drop', reason: 'model-changed' },
  },
  {
    name: 'rule 2: a redacted block from another model',
    block: redactedOf({ providerModel: 'model-b' }),
    target: targetOf(modelOf()),
    expected: { action: 'drop', reason: 'model-changed' },
  },
  {
    // A resale channel (Bedrock / Azure) in front of the same upstream model: the spec says
    // the thinking rules are computed from `canonicalId`, so swapping the endpoint in is not
    // a model change.
    name: 'rule 2: a block from the upstream model behind a resale endpoint',
    block: thinkingOf({ providerModel: 'model-a' }),
    target: targetOf(modelOf({ id: 'eu.anthropic.model-a-v1:0', canonicalId: 'model-a' })),
    expected: { action: 'replay', reason: 'same-model' },
  },
  {
    // And the converse: a block stamped with the wire id of the resale endpoint does not
    // match the canonical identity the guard compares on.
    name: 'rule 2: a block stamped with a resale wire id is a model change',
    block: thinkingOf({ providerModel: 'eu.anthropic.model-a-v1:0' }),
    target: targetOf(modelOf({ id: 'eu.anthropic.model-a-v1:0', canonicalId: 'model-a' })),
    expected: { action: 'drop', reason: 'model-changed' },
  },
  {
    // A blank `canonicalId` is not a mapping. Kept as the identity it would collapse every
    // model on the provider to the empty string, so two different models would compare equal
    // at rule 2 and a signature would replay to a model that never issued it.
    name: 'rule 2: a blank canonicalId falls back to the model id',
    block: thinkingOf({ providerModel: 'model-a' }),
    target: targetOf(modelOf({ id: 'model-a', canonicalId: '   ' })),
    expected: { action: 'replay', reason: 'same-model' },
  },
  {
    name: 'rule 2: a block stamped with a blank model id is a model change',
    block: thinkingOf({ providerModel: '' }),
    target: targetOf(modelOf({ id: 'model-a', canonicalId: '' })),
    expected: { action: 'drop', reason: 'model-changed' },
  },
  // Rule 3 — the target keeps nothing.
  {
    name: 'rule 3: the target drops thinking',
    block: thinkingOf(),
    target: targetOf(modelOf({ thinkingPreservationFormat: 'drop' })),
    expected: { action: 'drop', reason: 'target-drops' },
  },
  {
    name: 'rule 3: the target drops redacted thinking',
    block: redactedOf(),
    target: targetOf(modelOf({ thinkingPreservationFormat: 'drop' })),
    expected: { action: 'drop', reason: 'target-drops' },
  },
  // Rule 4 — echoed under reasoningEchoField, tools permitting.
  {
    name: 'rule 4: reasoning-content with tools echoes',
    block: thinkingOf(),
    target: targetOf(
      modelOf({
        thinkingPreservationFormat: 'reasoning-content',
        reasoningEchoField: 'reasoning_content',
      }),
      true,
    ),
    expected: { action: 'echo', reason: 'same-model' },
  },
  {
    name: 'rule 4: reasoning-content without tools drops',
    block: thinkingOf(),
    target: targetOf(
      modelOf({
        thinkingPreservationFormat: 'reasoning-content',
        reasoningEchoField: 'reasoning',
      }),
    ),
    expected: { action: 'drop', reason: 'no-tools' },
  },
  {
    name: 'rule 4: reasoning-content cannot echo redacted data, tools or not',
    block: redactedOf(),
    target: targetOf(
      modelOf({
        thinkingPreservationFormat: 'reasoning-content',
        reasoningEchoField: 'reasoning_content',
      }),
      true,
    ),
    expected: { action: 'drop', reason: 'redacted-unsupported' },
  },
  {
    name: 'rule 4: redacted beats no-tools when both apply',
    block: redactedOf(),
    target: targetOf(
      modelOf({
        thinkingPreservationFormat: 'reasoning-content',
        reasoningEchoField: 'reasoning_content',
      }),
    ),
    expected: { action: 'drop', reason: 'redacted-unsupported' },
  },
  // Rule 5 — text-only.
  {
    name: 'rule 5: text-only downgrades thinking',
    block: thinkingOf(),
    target: targetOf(modelOf({ thinkingPreservationFormat: 'text-only' })),
    expected: { action: 'downgrade', reason: 'same-model' },
  },
  {
    name: 'rule 5: text-only drops redacted data',
    block: redactedOf(),
    target: targetOf(modelOf({ thinkingPreservationFormat: 'text-only' })),
    expected: { action: 'drop', reason: 'redacted-unsupported' },
  },
  // Rule 6 — signed blocks with nothing to sign with.
  {
    name: 'rule 6: signed-blocks with an empty signature',
    block: thinkingOf({ signature: '' }),
    target: targetOf(modelOf()),
    expected: { action: 'drop', reason: 'missing-signature' },
  },
  {
    // A declared deviation: the spec's rule 6 says 「签名为空」, and this reads a
    // whitespace-only signature as empty too. Unreachable from a real response (signatures
    // are base64), and the stricter of the two readings — replaying whitespace is the 400
    // the guard exists to prevent. Cheap to relax if the owner rules the other way.
    name: 'rule 6: signed-blocks with a blank signature',
    block: thinkingOf({ signature: '   ' }),
    target: targetOf(modelOf()),
    expected: { action: 'drop', reason: 'missing-signature' },
  },
  // Rule 7 — replayed as stored.
  {
    name: 'rule 7: signed-blocks replays a signed block',
    block: thinkingOf(),
    target: targetOf(modelOf()),
    expected: { action: 'replay', reason: 'same-model' },
  },
  {
    name: 'rule 7: signed-blocks replays redacted data opaquely',
    block: redactedOf(),
    target: targetOf(modelOf()),
    expected: { action: 'replay', reason: 'same-model' },
  },
  // Rule order: the source gate runs first, so its reason is what gets audited.
  {
    name: 'order: foreign beats target-drops',
    block: thinkingOf({ provider: 'zhipu' }),
    target: targetOf(modelOf({ thinkingPreservationFormat: 'drop' })),
    expected: { action: 'drop', reason: 'foreign-provider' },
  },
  {
    name: 'order: foreign beats text-only downgrade',
    block: thinkingOf({ provider: 'zhipu' }),
    target: targetOf(modelOf({ thinkingPreservationFormat: 'text-only' })),
    expected: { action: 'drop', reason: 'foreign-provider' },
  },
  {
    name: 'order: foreign beats model-changed',
    block: thinkingOf({ provider: 'zhipu', providerModel: 'model-b' }),
    target: targetOf(modelOf()),
    expected: { action: 'drop', reason: 'foreign-provider' },
  },
  {
    name: 'order: model-changed beats target-drops',
    block: thinkingOf({ providerModel: 'model-b' }),
    target: targetOf(modelOf({ thinkingPreservationFormat: 'drop' })),
    expected: { action: 'drop', reason: 'model-changed' },
  },
  {
    name: 'order: missing-signature only matters once the source gate passed',
    block: thinkingOf({ provider: 'zhipu', signature: '' }),
    target: targetOf(modelOf()),
    expected: { action: 'drop', reason: 'foreign-provider' },
  },
]

describe('decideThinking', () => {
  it.each(CASES)('$name', ({ block, target, expected }) => {
    expect(decideThinking(block, target)).toEqual(expected)
  })

  it('re-stamping a block onto the target reaches the retention policy', () => {
    // The two gates are independent: the same history that was dropped as foreign is judged
    // by the retention policy once it belongs to the target.
    const foreign = thinkingOf({ provider: 'zhipu', providerModel: 'glm-4' })
    const target = targetOf(modelOf({ thinkingPreservationFormat: 'text-only' }))
    expect(decideThinking(foreign, target)).toEqual({
      action: 'drop',
      reason: 'foreign-provider',
    })
    const restamped = thinkingOf({ provider: 'anthropic', providerModel: 'model-a' })
    expect(decideThinking(restamped, target)).toEqual({
      action: 'downgrade',
      reason: 'same-model',
    })
  })
})

describe('applyThinkingDecision', () => {
  it('replays the very same block, so the signature is byte for byte the stored one', () => {
    const block = thinkingOf()
    const model = modelOf()
    const applied = applyThinkingDecision(block, decideThinking(block, targetOf(model)), model)
    expect(applied).toEqual({ kind: 'keep', block })
    if (applied.kind !== 'keep') throw new Error('expected the block to be kept')
    expect(applied.block).toBe(block)
    if (applied.block.type !== 'thinking') throw new Error('expected a thinking block')
    expect(applied.block.signature).toBe(SIGNATURE)
  })

  it('replays redacted data opaquely', () => {
    const block = redactedOf()
    const model = modelOf()
    const applied = applyThinkingDecision(block, decideThinking(block, targetOf(model)), model)
    expect(applied).toEqual({ kind: 'keep', block })
  })

  it('surfaces an echo under the model’s reasoningEchoField', () => {
    const block = thinkingOf()
    for (const field of ['reasoning_content', 'reasoning'] as const) {
      const model = modelOf({
        thinkingPreservationFormat: 'reasoning-content',
        reasoningEchoField: field,
      })
      const decision = decideThinking(block, targetOf(model, true))
      expect(applyThinkingDecision(block, decision, model)).toEqual({
        kind: 'echo',
        field,
        text: block.text,
      })
    }
  })

  it('downgrades to a text block carrying the thinking text', () => {
    const block = thinkingOf()
    const model = modelOf({ thinkingPreservationFormat: 'text-only' })
    const decision = decideThinking(block, targetOf(model))
    expect(applyThinkingDecision(block, decision, model)).toEqual({
      kind: 'text',
      block: { type: 'text', text: block.text },
    })
  })

  it('drops mean nothing goes into the body', () => {
    const block = thinkingOf({ provider: 'zhipu' })
    const model = modelOf()
    const decision = decideThinking(block, targetOf(model))
    expect(applyThinkingDecision(block, decision, model)).toEqual({ kind: 'drop' })
  })

  it('refuses an echo the model declared no field for', () => {
    // A ModelInfo table mistake, i.e. a programmer error: it throws rather than guessing a
    // field name onto the wire.
    const model = modelOf({ thinkingPreservationFormat: 'reasoning-content' })
    expect(() =>
      applyThinkingDecision(thinkingOf(), { action: 'echo', reason: 'same-model' }, model),
    ).toThrow(ProviderInvalidArgumentError)
  })

  it('refuses to turn redacted data into text or an echo', () => {
    const model = modelOf({
      thinkingPreservationFormat: 'reasoning-content',
      reasoningEchoField: 'reasoning_content',
    })
    expect(() =>
      applyThinkingDecision(redactedOf(), { action: 'downgrade', reason: 'same-model' }, model),
    ).toThrow(ProviderInvalidArgumentError)
    expect(() =>
      applyThinkingDecision(redactedOf(), { action: 'echo', reason: 'same-model' }, model),
    ).toThrow(ProviderInvalidArgumentError)
  })
})
