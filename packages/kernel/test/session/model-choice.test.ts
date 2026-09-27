/**
 * The session's own model choice (spec 02 §模型选择, §会话事实「写入」, §主进程与 kernel 的循环接口
 * 「间接切公网」; plan step 19: 旧 123, 旧 33, 旧 184 and the draft case of open question 16; the two
 * release cases plan step 17 left to step 19).
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

/**
 * `legacy()` true: `session/model_selected` is written the way phase 1 and plan steps 9–18 wrote it,
 * with no `endpointOrigin`.
 */
function harness(o: { legacy?: () => boolean } = {}): Harness {
  const memory = createMemoryTapeStore({ identity: IDENTITY })
  const store: TapeStore =
    o.legacy === undefined
      ? memory
      : {
          ...memory,
          append: (batch) =>
            memory.append({
              ...batch,
              entries: batch.entries.map((entry) => {
                if (o.legacy?.() !== true || entry.name !== 'session/model_selected') return entry
                const { endpointOrigin: _dropped, ...payload } = entry.payload
                return { ...entry, payload }
              }),
            }),
        }
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

function userTexts(all: readonly TapeEntry[]): string[] {
  return named(all, 'message/user').map(
    (entry) => (entry.payload['content'] as { text: string }[])[0]?.text ?? '',
  )
}

function heldHosts(h: Harness): Array<string | null> {
  return h.loop.recorded.flatMap((event) => (event.type === 'queue-held' ? [event.host] : []))
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

  it('names ① in sessionFacts as the prebuild takes it: the draft’s, then the Tape’s, none on a default (rrE-1)', async () => {
    // The model menu does not ask again for the host the session's own choice already confirmed;
    // a default (②–⑤) is none, and a cleared session falls back to one.
    const h = harness()
    expect((await h.service.sessionFacts({ sessionId: A })).chosen).toBeNull()
    await h.service.selectModel({ sessionId: A, choice: choice(TWO.id), origin: null })
    expect((await h.service.sessionFacts({ sessionId: A })).chosen).toEqual({
      providerId: 'anthropic',
    })
    await send(h, A, 'hello')
    expect(h.loop.connector.resolved.at(-1)?.sessionChoice).toMatchObject({ modelId: TWO.id })
    expect((await h.service.sessionFacts({ sessionId: A })).chosen).toEqual({
      providerId: 'anthropic',
    })
    await h.service.resetSession(A)
    expect((await h.service.sessionFacts({ sessionId: A })).chosen).toBeNull()
    await send(h, B, 'on the default')
    expect((await h.service.sessionFacts({ sessionId: B })).chosen).toBeNull()
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
  it('releases the held message with those queued before it, and none queued after (旧 184)', async () => {
    const h = harness()
    await send(h, A, 'history')
    await h.loop.queue.enqueue(A, 'queued before', { urgent: false })
    h.loop.connector.needsConfirm('api.anthropic.com')
    expect(await h.service.send({ sessionId: A, origin: null, text: 'held one' })).toMatchObject({
      status: 'held',
    })
    await h.loop.queue.enqueue(A, 'queued after', { urgent: false })
    h.provider.script(scriptedTurn({ deltas: ['sent'], usage: USAGE }))
    h.provider.script(scriptedTurn({ deltas: ['then'], usage: USAGE }))
    await h.service.selectModel({ sessionId: A, choice: choice(TWO.id), origin: null })
    // The released round: up to the held message, in queue order; the later one waits for its end.
    expect((await h.loop.runEnded()).reason.code).toBe('completed')
    const released = JSON.stringify(h.provider.requests[1]?.body)
    expect(released).toContain('queued before')
    expect(released).toContain('held one')
    expect(released).not.toContain('queued after')
    await h.loop.runEnded()
    expect(userTexts(await entries(h.store, A))).toEqual([
      'history',
      'queued before',
      'held one',
      'queued after',
    ])
  })

  it('only clears the hold when the held message was withdrawn: nothing goes out (plan step 17)', async () => {
    const h = harness()
    await send(h, A, 'history')
    await h.loop.queue.enqueue(A, 'still queued', { urgent: false })
    h.loop.connector.needsConfirm('api.anthropic.com')
    const held = await h.service.send({ sessionId: A, origin: null, text: 'held one' })
    if (held.status !== 'held') throw new Error(`send answered ${JSON.stringify(held)}`)
    // queue.ts's withdraw (chat.queue.act) takes it out by id.
    await h.loop.queue.take(A, { upToSeq: null, urgentOnly: false, queuedId: held.queuedId })
    const leases = h.loop.leaseLog.length
    await h.service.selectModel({ sessionId: A, choice: choice(TWO.id), origin: null })
    expect(heldHosts(h)).toEqual(['api.anthropic.com', null])
    expect(h.loop.leaseLog).toHaveLength(leases)
    expect(h.provider.requests).toHaveLength(1)
    expect(h.loop.queued(A).map((item) => item.text)).toEqual(['still queued'])
  })

  it('takes nothing on a choice once another round has cleared the hold (plan step 17)', async () => {
    const h = harness()
    await send(h, A, 'history')
    h.loop.connector.needsConfirm('api.anthropic.com')
    expect(await h.service.send({ sessionId: A, origin: null, text: 'held one' })).toMatchObject({
      status: 'held',
    })
    // A round with no needsConfirm opens (it takes the held message along) and clears the hold.
    h.loop.connector.needsConfirm(null)
    await send(h, A, 'on this machine')
    expect(heldHosts(h)).toEqual(['api.anthropic.com', null])
    await h.loop.queue.enqueue(A, 'queued later', { urgent: false })
    const leases = h.loop.leaseLog.length
    await h.service.selectModel({ sessionId: A, choice: choice(TWO.id), origin: null })
    // Nothing more to release: no second clear, no Run, the queue as it was.
    expect(heldHosts(h)).toEqual(['api.anthropic.com', null])
    expect(h.loop.leaseLog).toHaveLength(leases)
    expect(h.loop.queued(A).map((item) => item.text)).toEqual(['queued later'])
  })

  it('releases an auto-send hold with every queued message (queuedId null)', async () => {
    const h = harness()
    h.provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
    const first = h.service.send({ sessionId: A, origin: null, text: 'one' })
    await h.service.send({ sessionId: A, origin: null, text: 'two' })
    await h.service.send({ sessionId: A, origin: null, text: 'three' })
    const started = await first
    if (started.status !== 'started') throw new Error(`send answered ${JSON.stringify(started)}`)
    // The auto-send after it would switch to a public host: held, both left in the queue.
    h.loop.connector.needsConfirm('api.anthropic.com')
    await h.loop.runEnded({ runId: started.runId })
    await expect.poll(() => heldHosts(h)).toEqual(['api.anthropic.com'])
    expect(h.loop.queued(A).map((item) => item.text)).toEqual(['two', 'three'])
    h.provider.script(scriptedTurn({ deltas: ['sent'], usage: USAGE }))
    await h.service.selectModel({ sessionId: A, choice: choice(TWO.id), origin: null })
    expect((await h.loop.runEnded()).reason.code).toBe('completed')
    expect(userTexts(await entries(h.store, A))).toEqual(['one', 'two', 'three'])
    expect(h.loop.queued(A)).toEqual([])
  })

  it('compares with where a pre-step-19 Run’s provider sends when its row has no origin (s19-wire-3)', async () => {
    let legacy = true
    const h = harness({ legacy: () => legacy })
    h.loop.connector.use({
      provider: h.provider,
      model: ONE,
      models: [ONE, TWO],
      endpointOrigin: 'http://localhost:11434',
    })
    await send(h, A, 'on this machine')
    expect(
      named(await entries(h.store, A), 'session/model_selected')[0]?.payload,
    ).not.toHaveProperty('endpointOrigin')
    // Without the fallback this session would read as having sent nowhere: no check at all.
    expect(await h.service.sessionFacts({ sessionId: A })).toMatchObject({
      lastEndpointOrigin: 'http://localhost:11434',
    })
    legacy = false
    await send(h, A, 'again')
    expect(h.loop.connector.resolved.at(-1)).toMatchObject({
      sessionChoice: null,
      previousOrigin: 'http://localhost:11434',
    })
  })
})
