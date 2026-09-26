/**
 * The session's own model choice (spec 02 §模型选择, §会话事实「写入」, §主进程与 kernel 的循环接口
 * 「间接切公网」; plan step 19: 旧 123, 旧 33, 旧 184 and the draft case of open question 16).
 */
import { describe, expect, it } from 'vitest'
import { createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type {
  ModelChoiceSetPayload,
  ModelInfo,
  SessionService,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
} from '../../src/testing/index.js'
import type { ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'

const IDENTITY = { userId: 'mc-user', tenantId: 'mc-tenant', profileDir: '/tenon/mc' }
const A = '2b1d9a2e-6b3d-4a71-9f52-0c8de7a11b81'
const B = '2b1d9a2e-6b3d-4a71-9f52-0c8de7a11b82'

function model(id: string): ModelInfo {
  return {
    id,
    providerId: 'anthropic',
    contextLimit: 200_000,
    maxOutputTokens: 1024,
    reasoning: false,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: false,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'drop',
    usageNeedsOptIn: false,
  }
}

const ONE = model('claude-mc-1')
const TWO = model('claude-mc-2')

const USAGE: Usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

interface Harness {
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
}

function harness(): Harness {
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [ONE, TWO] })
  const loop = createTestLoopPorts({ connector: { provider, model: ONE, models: [ONE, TWO] } })
  const service = createTestSessionService(
    {
      host: createMemoryHost({ identity: IDENTITY }),
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
    },
    { tools: {} },
  )
  service.bindLoop(loop)
  return { store, service, loop, provider }
}

const choice = (modelId: string, effort: string | null = null): ModelChoiceSetPayload => ({
  providerId: 'anthropic',
  modelId,
  effort,
})

async function entries(store: TapeStore, sessionId: string): Promise<TapeEntry[]> {
  return (await store.readRange({ sessionId, limit: 1000 })).entries
}

function named(all: readonly TapeEntry[], name: string): TapeEntry[] {
  return all.filter((entry) => entry.name === name)
}

async function send(h: Harness, sessionId: string, text: string): Promise<void> {
  h.provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
  const sent = await h.service.send({ sessionId, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  await h.loop.runEnded({ runId: sent.runId })
}

describe('the model choice (§模型选择)', () => {
  it('writes a choice made before the session exists as its 0th, with session/start (旧 123)', async () => {
    const h = harness()
    expect(
      await h.service.selectModel({ sessionId: A, choice: choice(TWO.id), origin: null }),
    ).toEqual({
      profile: 'chat',
    })
    await send(h, A, 'hello')
    const all = await entries(h.store, A)
    expect(all.slice(0, 3).map((entry) => entry.name)).toEqual([
      'session/start',
      'session/profile_set',
      'session/model_choice_set',
    ])
    expect(all[2]?.sourceSeq).toBe(0)
    expect(named(all, 'session/model_selected')[0]?.payload).toMatchObject({ modelId: TWO.id })
    // Two quick choices afterwards: each counted in the mailbox, n = 1 and n = 2.
    await Promise.all([
      h.service.selectModel({ sessionId: A, choice: choice(ONE.id), origin: null }),
      h.service.selectModel({ sessionId: A, choice: choice(TWO.id, 'high'), origin: null }),
    ])
    const choices = named(await entries(h.store, A), 'session/model_choice_set')
    expect(choices.map((entry) => [entry.sourceSeq, entry.payload['modelId']])).toEqual([
      [0, TWO.id],
      [1, ONE.id],
      [2, TWO.id],
    ])
    expect(await h.service.effectiveModelChoice({ sessionId: A })).toEqual({
      providerId: 'anthropic',
      modelId: TWO.id,
      effort: 'high',
      capabilitySource: 'builtin',
    })
  })

  it('never loses a choice made right after the send: it lands once the session exists', async () => {
    const h = harness()
    h.provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
    const sending = h.service.send({ sessionId: A, origin: null, text: 'first' })
    const choosing = h.service.selectModel({ sessionId: A, choice: choice(TWO.id), origin: null })
    const sent = await sending
    await choosing
    if (sent.status === 'started') await h.loop.runEnded({ runId: sent.runId })
    const all = await entries(h.store, A)
    // The first Run used the default; the choice is the session's n = 0, after session/start's batch.
    expect(named(all, 'session/model_selected')[0]?.payload).toMatchObject({ modelId: ONE.id })
    expect(named(all, 'session/model_choice_set').map((entry) => entry.sourceSeq)).toEqual([0])
    await send(h, A, 'second')
    expect(named(await entries(h.store, A), 'session/model_selected')[1]?.payload).toMatchObject({
      modelId: TWO.id,
    })
  })

  it('keeps each session on its own choice (旧 33)', async () => {
    const h = harness()
    await h.service.selectModel({ sessionId: A, choice: choice(ONE.id), origin: null })
    await h.service.selectModel({ sessionId: B, choice: choice(TWO.id), origin: null })
    await send(h, A, 'a1')
    await send(h, B, 'b1')
    await send(h, A, 'a2')
    await send(h, B, 'b2')
    const picked = async (sessionId: string): Promise<unknown[]> =>
      named(await entries(h.store, sessionId), 'session/model_selected').map(
        (entry) => entry.payload['modelId'],
      )
    expect(await picked(A)).toEqual([ONE.id, ONE.id])
    expect(await picked(B)).toEqual([TWO.id, TWO.id])
    const sentModels = h.provider.requests.map(
      (request) => (request.body as { model: string }).model,
    )
    expect(sentModels).toEqual([ONE.id, TWO.id, ONE.id, TWO.id])
  })

  it('falls back to the profile’s default once the session is cleared (M5)', async () => {
    const h = harness()
    await h.service.selectModel({ sessionId: A, choice: choice(TWO.id), origin: null })
    await send(h, A, 'hello')
    await h.service.resetSession(A)
    expect((await entries(h.store, A)).map((entry) => entry.name)).toEqual([
      'session/start',
      'session/profile_set',
    ])
    // The connector's default (the test script's model): no choice carried into the new incarnation.
    expect(await h.service.effectiveModelChoice({ sessionId: A })).toMatchObject({
      modelId: ONE.id,
    })
  })

  it('hands the connector ① and where the last Run sent, for the data-flow check', async () => {
    const h = harness()
    await send(h, A, 'first')
    expect(h.loop.connector.resolved.at(-1)).toMatchObject({
      sessionChoice: null,
      previousOrigin: null,
    })
    await send(h, A, 'second')
    expect(h.loop.connector.resolved.at(-1)).toMatchObject({
      sessionChoice: null,
      previousOrigin: 'https://connector.test',
    })
  })

  it('releases a message a public host held, with the ones queued before it (旧 184)', async () => {
    const h = harness()
    await send(h, A, 'history')
    // The profile default now points at a public host: the next round waits for the menu.
    h.loop.connector.needsConfirm('api.anthropic.com')
    const held = await h.service.send({ sessionId: A, origin: null, text: 'held one' })
    expect(held.status).toBe('held')
    expect(h.provider.requests).toHaveLength(1)
    expect(h.loop.recorded.findLast((event) => event.type === 'queue-held')).toMatchObject({
      host: 'api.anthropic.com',
    })
    // Choosing in the menu clears the hold and the message goes out under the choice.
    h.provider.script(scriptedTurn({ deltas: ['sent'], usage: USAGE }))
    await h.service.selectModel({ sessionId: A, choice: choice(TWO.id), origin: null })
    const ended = await h.loop.runEnded()
    expect(ended.reason.code).toBe('completed')
    expect(h.loop.recorded.findLast((event) => event.type === 'queue-held')).toMatchObject({
      host: null,
    })
    const texts = named(await entries(h.store, A), 'message/user').map((entry) =>
      JSON.stringify(entry.payload['content']),
    )
    expect(texts.at(-1)).toContain('held one')
    expect(h.loop.queued(A)).toEqual([])
    expect(
      named(await entries(h.store, A), 'session/model_selected').at(-1)?.payload,
    ).toMatchObject({
      modelId: TWO.id,
    })
  })
})
