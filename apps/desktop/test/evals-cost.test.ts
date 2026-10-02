/**
 * The eval cost function (spec 02 §记录格式与费用口径; plan step 25, 旧 229; acceptance 45; M8). Each
 * case is a Tape the kernel wrote — a real Run, the attempt, its `view/assembled` and the frozen
 * `view/content(model_info)` — read back by `tapeCost` and compared with a hand computation:
 *
 *   - anthropic-messages (the scripted provider's real encoder): `inputTokens` leave the cache out,
 *     so `usage.input` is `inputTokens`;
 *   - openai-chat (the zhipu definition over a scripted network): `inputTokens` hold the cache, so
 *     `usage.input` is `inputTokens − cacheRead − cacheWrite`;
 *   - reasoning is inside output and is not priced twice; a row with no `pricing` costs null.
 */
import {
  anthropicDefinition,
  createMemoryHost,
  createMemoryTapeStore,
  createSessionService,
  zhipuDefinition,
} from '@tenon-app/kernel'
import type { ModelInfo, Provider, Usage } from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  fakeNetwork,
  scriptedTurn,
} from '@tenon-app/kernel/testing'
import { describe, expect, it } from 'vitest'
import { costOf, sumAttempts, tapeCost } from '../evals/cost.js'

const SESSION = '0f8e6a52-3b1d-4c7e-9a2f-6d5b4c3a2e10'

function row(definition: { builtinModels: readonly ModelInfo[] }, id: string): ModelInfo {
  const found = definition.builtinModels.find((model) => model.id === id)
  if (found === undefined) throw new Error(`no ${id}`)
  return found
}

/** One chat message through a real Run on `provider`; the Tape it leaves. */
async function tapeOf(provider: Provider, model: ModelInfo) {
  const host = createMemoryHost()
  const store = createMemoryTapeStore({ identity: host.identity })
  const loop = createTestLoopPorts({ connector: { provider, model } })
  const service = createSessionService({
    host,
    tape: store,
    ids: createCounterIds(),
    inspectors: [],
    connector: loop.connector,
    protectedFiles: [],
  })
  service.bindLoop(loop)
  const sent = await service.send({ sessionId: SESSION, origin: null, text: 'hi' })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  expect((await loop.runEnded({ runId: sent.runId })).reason).toEqual({ code: 'completed' })
  return store
}

/** One openai-chat stream: a text delta, the finish reason, and the trailing usage chunk. */
function frame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function openAIFrames(usage: Record<string, unknown>): string[] {
  const chunk = (delta: unknown, finish: string | null = null): string =>
    frame({
      id: 'chatcmpl-eval',
      object: 'chat.completion.chunk',
      created: 1_774_000_000,
      model: 'glm-5.3-flash',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
  return [
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: 'hello' }),
    chunk({}, 'stop'),
    frame({
      id: 'chatcmpl-eval',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'glm-5.3-flash',
      choices: [],
      usage,
    }),
    'data: [DONE]\n\n',
  ]
}

describe('the eval cost function, by wire (旧 229)', () => {
  it('anthropic-messages: inputTokens leave the cache out; each part at its own price', async () => {
    const opus = row(anthropicDefinition, 'claude-opus-5-5')
    const provider = createScriptedProvider({ models: [opus] })
    const usage: Usage = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 2_000,
      reasoningTokens: 200,
      final: true,
    }
    provider.script(scriptedTurn({ deltas: ['hello'], usage }))
    const cost = await tapeCost(await tapeOf(provider, opus), SESSION)
    expect(cost.usage).toEqual({
      input: 1_000,
      cacheRead: 4_000,
      cacheWrite: 2_000,
      output: 500,
      reasoning: 200,
    })
    // $4 in, $0.20 cache read, $5 cache write, $20 out, per million; reasoning is inside the 500.
    const hand = (1_000 * 4 + 4_000 * 0.2 + 2_000 * 5 + 500 * 20) / 1_000_000
    expect(cost.cost?.currency).toBe('USD')
    expect(cost.cost?.amount).toBeCloseTo(hand, 12)
    expect(cost.perRequest).toEqual([{ input: 7_000, cost: cost.cost?.amount }])
  })

  it('openai-chat: inputTokens hold the cache, which comes off first; CNY from the row', async () => {
    const flash = row(zhipuDefinition, 'glm-5.3-flash')
    const network = fakeNetwork({
      kind: 'sse',
      frames: openAIFrames({
        prompt_tokens: 10_000,
        completion_tokens: 800,
        total_tokens: 10_800,
        prompt_tokens_details: { cached_tokens: 6_000 },
        completion_tokens_details: { reasoning_tokens: 300 },
      }),
    })
    const provider = zhipuDefinition.create({
      network,
      clock: { now: () => 0, setTimeout: () => () => {} },
      config: { baseURL: 'https://open.bigmodel.cn/api/paas/v4/' },
      secrets: { apiKey: 'not-a-real-key' },
    })
    const cost = await tapeCost(await tapeOf(provider, flash), SESSION)
    expect(network.callCount).toBe(1)
    expect(cost.usage).toEqual({
      input: 4_000,
      cacheRead: 6_000,
      cacheWrite: 0,
      output: 800,
      reasoning: 300,
    })
    // ¥0.8 in, ¥0.23 cache hit, ¥2.8 out, per million.
    const hand = (4_000 * 0.8 + 6_000 * 0.23 + 800 * 2.8) / 1_000_000
    expect(cost.cost?.currency).toBe('CNY')
    expect(cost.cost?.amount).toBeCloseTo(hand, 12)
    expect(cost.perRequest).toEqual([{ input: 10_000, cost: cost.cost?.amount }])
  })

  it('a row with no pricing costs null; the usage is still summed', async () => {
    const { pricing: _pricing, ...unpriced } = row(anthropicDefinition, 'claude-sonnet-5')
    const provider = createScriptedProvider({ models: [unpriced] })
    const usage: Usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      final: true,
    }
    provider.script(scriptedTurn({ deltas: ['hello'], usage }))
    const tape = await tapeOf(provider, unpriced)
    const cost = await tapeCost(tape, SESSION)
    expect(cost.usage).toEqual({ input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 })
    expect(cost.cost).toBeNull()
    expect(cost.perRequest).toBeNull()
    // The eval-only instance column's rows are such rows (M6 §合成): the runner prices it at the
    // column's own price instead (§点名 (d), Q17).
    const column = {
      inputPerMTok: 8,
      outputPerMTok: 28,
      cacheReadPerMTok: 2,
      currency: 'CNY' as const,
    }
    const priced = await tapeCost(tape, SESSION, column)
    expect(priced.cost).toEqual({ amount: (10 * 8 + 5 * 28) / 1_000_000, currency: 'CNY' })
    expect(priced.perRequest).toEqual([{ input: 10, cost: (10 * 8 + 5 * 28) / 1_000_000 }])
  })

  it('a missing cache price is the input price; currency defaults to USD; two currencies cost null', () => {
    const line = { input: 1_000, cacheRead: 2_000, cacheWrite: 3_000, output: 100, reasoning: 50 }
    expect(costOf(line, { inputPerMTok: 2, outputPerMTok: 10 })).toEqual({
      amount: (6_000 * 2 + 100 * 10) / 1_000_000,
      currency: 'USD',
    })
    expect(costOf(line, undefined)).toBeNull()
    const usage: Usage = {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      final: true,
    }
    const mixed = sumAttempts([
      { usage, wire: 'anthropic-messages', pricing: { inputPerMTok: 1, outputPerMTok: 1 } },
      {
        usage,
        wire: 'openai-chat',
        pricing: { inputPerMTok: 1, outputPerMTok: 1, currency: 'CNY' },
      },
    ])
    expect(mixed.cost).toBeNull()
    expect(mixed.usage?.input).toBe(2)
    // An attempt that failed before any usage costs nothing and needs no price.
    expect(sumAttempts([{ usage: null, wire: null, pricing: undefined }])).toEqual({
      usage: null,
      cost: null,
      perRequest: null,
    })
  })

  it('openai-chat takes cache writes off the input too, priced at the input price without their own', () => {
    const pricing = {
      inputPerMTok: 2,
      outputPerMTok: 8,
      cacheReadPerMTok: 0.5,
      currency: 'CNY' as const,
    }
    const usage: Usage = {
      inputTokens: 10_000,
      outputTokens: 400,
      cacheReadTokens: 6_000,
      cacheWriteTokens: 1_000,
      reasoningTokens: 0,
      final: true,
    }
    const summed = sumAttempts([{ usage, wire: 'openai-chat', pricing }])
    expect(summed.usage).toEqual({
      input: 3_000,
      cacheRead: 6_000,
      cacheWrite: 1_000,
      output: 400,
      reasoning: 0,
    })
    const hand = (3_000 * 2 + 6_000 * 0.5 + 1_000 * 2 + 400 * 8) / 1_000_000
    expect(summed.cost?.amount).toBeCloseTo(hand, 12)
    expect(summed.perRequest).toEqual([{ input: 10_000, cost: summed.cost?.amount }])
  })

  it('one unpriced attempt among priced ones makes the whole cost null, not a partial one', () => {
    const usage: Usage = {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      final: true,
    }
    const priced = {
      usage,
      wire: 'anthropic-messages' as const,
      pricing: { inputPerMTok: 1, outputPerMTok: 1 },
    }
    expect(sumAttempts([priced, { ...priced, pricing: undefined }])).toEqual({
      usage: { input: 200, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0 },
      cost: null,
      perRequest: null,
    })
  })
})
