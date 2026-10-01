/**
 * Replaying history across providers and to a model that is sent no tools (spec 02 §模型选择「换模型
 * 时的历史」, §不带 tools 的请求与冻结后的变化; plan step 19: 旧 36 ① and ②, 旧 41's kernel half), and
 * the thinking level chosen in the menu reaching each wire (旧 186, 旧 226's level half; 验收 33).
 * Every request goes through a real adapter, with the pairing and last-turn assertions on every
 * fetch: the ids only have to be equal, so a charset difference between vendors is not caught here.
 */
import { describe, expect, it } from 'vitest'
import {
  ZHIPU_DEFAULT_BASE_URL,
  anthropicDefinition,
  createMemoryTapeStore,
  ollamaDefinition,
  zhipuDefinition,
} from '../../src/index.js'
import type { ModelInfo, Provider, SessionService, TapeEntry, TapeStore } from '../../src/index.js'
import {
  assertLastTurnIsUser,
  assertToolPairing,
  createCounterIds,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
} from '../../src/testing/index.js'
import type { FakeNetwork, TestLoopPorts } from '../../src/testing/index.js'
import * as anthropicFixture from '../provider/fixtures/anthropic-sse.js'
import * as openAIFixture from '../provider/fixtures/openai-sse.js'
import { anthropicModel } from '../provider/wire/fixtures.js'
import { LOOK, instantHost, lookSource } from './support.js'

const IDENTITY = { userId: 'x-user', tenantId: 'x-tenant', profileDir: '/tenon/x' }
const SESSION = '3d1d9a2e-6b3d-4a71-9f52-0c8de7a11ba1'

type Wire = 'anthropic-messages' | 'openai-chat'

function callTurn(wire: Wire, id: string): readonly string[] {
  const calls = [{ id, name: LOOK, args: JSON.stringify({ at: id }) }]
  return wire === 'anthropic-messages'
    ? anthropicFixture.turnFrames(['Looking.'], calls, 'tool_use')
    : openAIFixture.turnFrames(['Looking.'], calls, 'tool_calls')
}

function textTurn(wire: Wire): readonly string[] {
  return wire === 'anthropic-messages'
    ? anthropicFixture.turnFrames(['Done.'], [], 'end_turn')
    : openAIFixture.turnFrames(['Done.'], [], 'stop')
}

function wireProvider(
  wire: Wire,
  exchanges: readonly (readonly string[])[],
  ollama = false,
): {
  provider: Provider
  net: FakeNetwork
} {
  const net = fakeNetwork(
    exchanges.map((frames) => ({ kind: 'sse' as const, frames })),
    {
      checkRequest: (request) => {
        assertToolPairing(request)
        assertLastTurnIsUser(request)
      },
    },
  )
  const definition = ollama
    ? ollamaDefinition
    : wire === 'anthropic-messages'
      ? anthropicDefinition
      : zhipuDefinition
  const provider = definition.create({
    network: net,
    clock: { now: () => 0, setTimeout: () => () => undefined },
    config: ollama
      ? {}
      : {
          baseURL:
            wire === 'anthropic-messages' ? 'https://api.anthropic.test' : ZHIPU_DEFAULT_BASE_URL,
        },
    secrets: ollama ? {} : { apiKey: 'test-key-not-a-real-credential' },
  })
  return { provider, net }
}

function zhipuModel(id = 'glm-5.3-flash'): ModelInfo {
  const model = zhipuDefinition.builtinModels.find((row) => row.id === id)
  if (model === undefined) throw new Error(`no ${id} row`)
  return model
}

function anthropicRow(id: string): ModelInfo {
  const model = anthropicDefinition.builtinModels.find((row) => row.id === id)
  if (model === undefined) throw new Error(`no ${id} row`)
  return model
}

interface Harness {
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
}

function harness(first: Provider, model: ModelInfo): Harness {
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const loop = createTestLoopPorts({
    connector: { provider: first, model, mcpSources: [lookSource([])] },
  })
  const service = createTestSessionService(
    {
      host: instantHost(),
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
    },
    { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }) },
  )
  service.bindLoop(loop)
  return { store, service, loop }
}

async function send(h: Harness, text: string): Promise<string> {
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return (await h.loop.runEnded({ runId: sent.runId })).reason.code
}

async function entries(store: TapeStore): Promise<TapeEntry[]> {
  return (await store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}

describe('history across providers (旧 36 ②)', () => {
  it('replays a Zhipu call id on the Anthropic wire and an Anthropic one on Zhipu’s, paired', async () => {
    const a = wireProvider('anthropic-messages', [
      callTurn('anthropic-messages', 'toolu_a1'),
      textTurn('anthropic-messages'),
      textTurn('anthropic-messages'),
    ])
    const z = wireProvider('openai-chat', [
      callTurn('openai-chat', 'call_z1'),
      textTurn('openai-chat'),
    ])
    const h = harness(a.provider, anthropicModel())
    expect(await send(h, 'look on A')).toBe('completed')
    h.loop.connector.use({
      provider: z.provider,
      model: zhipuModel(),
      mcpSources: [lookSource([])],
    })
    expect(await send(h, 'look on Z')).toBe('completed')
    h.loop.connector.use({
      provider: a.provider,
      model: anthropicModel(),
      mcpSources: [lookSource([])],
    })
    expect(await send(h, 'back on A')).toBe('completed')
    // Each wire saw the other's id in its own shape, paired (checked on every fetch).
    expect(JSON.stringify(z.net.requests[0]?.body)).toContain('toolu_a1')
    expect(JSON.stringify(a.net.requests.at(-1)?.body)).toContain('call_z1')
    expect(z.net.checkFailures).toEqual([])
    expect(a.net.checkFailures).toEqual([])
  })
})

describe('a model sent no tools (旧 36 ①, 旧 41)', () => {
  it('sends no tools key to a hand-typed model of the same provider, and records it', async () => {
    const a = wireProvider('anthropic-messages', [
      callTurn('anthropic-messages', 'toolu_b1'),
      textTurn('anthropic-messages'),
      textTurn('anthropic-messages'),
    ])
    const h = harness(a.provider, anthropicModel())
    await send(h, 'look first')
    const typed: ModelInfo = {
      ...anthropicModel(),
      id: 'claude-own-model',
      supportsToolCalling: false,
      supportsStreamingToolCalls: false,
    }
    h.loop.connector.use({
      provider: a.provider,
      model: typed,
      capabilitySource: 'user',
      mcpSources: [lookSource([])],
    })
    expect(await send(h, 'now text only')).toBe('completed')
    const last = a.net.requests.at(-1)?.body as Record<string, unknown>
    expect(last).not.toHaveProperty('tools')
    const withheld = (await entries(h.store)).filter(
      (entry) => entry.name === 'view/tools_withheld',
    )
    expect(withheld.map((entry) => entry.payload['reason'])).toEqual(['model-without-tools'])
    const selected = (await entries(h.store)).filter(
      (entry) => entry.name === 'session/model_selected',
    )
    expect(selected.at(-1)?.payload).toMatchObject({
      modelId: 'claude-own-model',
      capabilitySource: 'user',
    })
    expect(a.net.checkFailures).toEqual([])
  })

  it('sends Ollama no tools in a task either', async () => {
    const z = wireProvider('openai-chat', [textTurn('openai-chat')])
    const h = harness(z.provider, zhipuModel())
    h.loop.connector.use({
      provider: z.provider,
      model: zhipuModel(),
      toolsWithheld: 'provider-text-only',
      mcpSources: [lookSource([])],
    })
    await h.service.selectProfile({
      sessionId: SESSION,
      profile: 'cowork',
      dedicated: '/home/u/Tenon/workspaces/x' as never,
    })
    expect(await send(h, 'hello')).toBe('completed')
    expect(z.net.requests[0]?.body as Record<string, unknown>).not.toHaveProperty('tools')
  })

  it('sends Ollama no tools key with tool blocks in the history, and the history still pairs (验收 35)', async () => {
    const z = wireProvider('openai-chat', [
      callTurn('openai-chat', 'call_o1'),
      textTurn('openai-chat'),
    ])
    const o = wireProvider('openai-chat', [textTurn('openai-chat')], true)
    const h = harness(z.provider, zhipuModel())
    expect(await send(h, 'look first')).toBe('completed')
    expect(z.net.requests[0]?.body).toHaveProperty('tools')
    const ollama = ollamaDefinition.builtinModels[0]
    if (ollama === undefined) throw new Error('no ollama row')
    h.loop.connector.use({
      provider: o.provider,
      model: ollama,
      toolsWithheld: 'provider-text-only',
      mcpSources: [lookSource([])],
    })
    expect(await send(h, 'now on Ollama')).toBe('completed')
    const last = o.net.requests.at(-1)?.body as Record<string, unknown>
    expect(last).not.toHaveProperty('tools')
    // The call and its result go back as they are, paired (checked on the fetch).
    expect(last['messages']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [expect.objectContaining({ id: 'call_o1' })],
        }),
        expect.objectContaining({ role: 'tool', tool_call_id: 'call_o1' }),
      ]),
    )
    expect(o.net.checkFailures).toEqual([])
    const withheld = (await entries(h.store)).filter(
      (entry) => entry.name === 'view/tools_withheld',
    )
    expect(withheld.map((entry) => entry.payload['reason'])).toEqual(['provider-text-only'])
  })
})

describe('the thinking level chosen in the menu (旧 186, 旧 226, 验收 33)', () => {
  async function snapshots(h: Harness): Promise<Array<Record<string, unknown>>> {
    return (await entries(h.store))
      .filter((entry) => entry.name === 'provider/attempt_completed')
      .map((entry) => entry.payload['request'] as Record<string, unknown>)
  }

  // Per wire: the key the level travels in, and two rows that list levels.
  for (const [wire, key, first, second] of [
    ['openai-chat', 'reasoning_effort', zhipuModel(), zhipuModel('glm-5.3-flashx')],
    [
      'anthropic-messages',
      'output_config',
      anthropicRow('claude-sonnet-5'),
      anthropicRow('claude-opus-5-5'),
    ],
  ] as const) {
    it(`reaches the next Run’s request on the ${wire} wire, and clears with a model change`, async () => {
      const w = wireProvider(wire, [textTurn(wire), textTurn(wire), textTurn(wire)])
      const h = harness(w.provider, first)
      h.loop.connector.use({
        provider: w.provider,
        model: first,
        models: [first, second],
        mcpSources: [lookSource([])],
      })
      // No level chosen: the model's own default, so nothing on the wire.
      expect(await send(h, 'by default')).toBe('completed')
      const choose = (model: ModelInfo, effort: string | null): Promise<unknown> =>
        h.service.selectModel({
          sessionId: SESSION,
          choice: { providerId: model.providerId, modelId: model.id, effort },
          origin: null,
        })
      await choose(first, 'high')
      expect(await send(h, 'think harder')).toBe('completed')
      // Another model: the level goes back to empty, its default (A11).
      await choose(second, null)
      expect(await send(h, 'on the other model')).toBe('completed')
      const bodies = w.net.requests.map((request) => request.body as Record<string, unknown>)
      expect(bodies.map((body) => body[key])).toEqual([
        undefined,
        wire === 'openai-chat' ? 'high' : { effort: 'high' },
        undefined,
      ])
      expect(bodies.map((body) => body['model'])).toEqual([first.id, first.id, second.id])
      expect((await snapshots(h)).map((request) => request['effort'])).toEqual([
        undefined,
        'high',
        undefined,
      ])
      expect(w.net.checkFailures).toEqual([])
    })
  }
})
