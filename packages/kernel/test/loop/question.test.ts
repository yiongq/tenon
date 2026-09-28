/** AskUserQuestion's persisted answers, pause/resume and mailbox contract (spec 02, step 26). */
import { describe, expect, it } from 'vitest'
import {
  ProviderConfigMissingError,
  createMemoryHost,
  createMemoryTapeStore,
} from '../../src/index.js'
import type { ModelInfo, StreamEvent, TapeStore } from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import { answeredReply, typedReply } from '../../src/tools/builtin/ask-user-question.js'
import { LOOK, lookSource, proxyStore } from './support.js'

const SESSION = '7c4e9a2e-6b3d-4a71-9f52-0c8de7a11b37'
const IDENTITY = { userId: 'ask', tenantId: 'ask', profileDir: '/tenon/ask' }
const MODEL: ModelInfo = {
  id: 'ask-model',
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
const USAGE = {
  inputTokens: 9,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}
const question = (text = 'Pick?') => ({
  question: text,
  header: 'Choice',
  multiSelect: true,
  options: [
    { label: 'x, y', description: 'First' },
    { label: 'z', description: 'Second' },
  ],
})
const INPUT = { questions: [question(), question('Why?')] }
function calls(input: Record<string, unknown> = INPUT, withRest = false): StreamEvent[] {
  const events: StreamEvent[] = [
    { type: 'tool-call-start', index: 1, id: 'ask', name: 'AskUserQuestion' },
    { type: 'tool-call-end', index: 1, id: 'ask', name: 'AskUserQuestion', input },
  ]
  if (withRest)
    events.push(
      { type: 'tool-call-start', index: 2, id: 'rest', name: LOOK },
      { type: 'tool-call-end', index: 2, id: 'rest', name: LOOK, input: { at: 'rest' } },
    )
  return [...events, { type: 'usage', usage: USAGE }, stopEvent('tool-use', 'tool_use')]
}
function harness(store = createMemoryTapeStore({ identity: IDENTITY }), start = 1) {
  const provider = createScriptedProvider({ models: [MODEL] })
  const executed: Record<string, unknown>[] = []
  const loop = createTestLoopPorts({
    connector: { provider, model: MODEL, mcpSources: [lookSource(executed)] },
  })
  const service = createTestSessionService(
    {
      host: createMemoryHost(),
      tape: store,
      ids: createCounterIds({ start }),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
      log: () => {},
    },
    { tools: { AskUserQuestion: 'real' }, userSetting: () => ({ userSetting: 'always-allow' }) },
  )
  service.bindLoop(loop)
  return { provider, executed, loop, service, store }
}
type Harness = ReturnType<typeof harness>
async function entries(store: TapeStore) {
  return (await store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}
async function pause(h: Harness, withRest = false) {
  h.provider.script(calls(INPUT, withRest))
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'Ask me' })
  expect(sent.status).toBe('started')
  expect((await h.loop.runEnded()).reason).toEqual({ code: 'paused', waitingFor: 'question' })
  const pending = await h.service.currentPending({ sessionId: SESSION })
  if (pending?.waitKind !== 'question') throw new Error('no question')
  return pending
}
const done = () => scriptedTurn({ deltas: ['Done'], usage: USAGE })

describe('question answers', () => {
  it('joins arrays without splitting labels, skips only null/missing, rejects unknown keys', () => {
    const reply = answeredReply(['Pick?', 'Why?', 'Empty?'], {
      'Pick?': ['x, y', 'z'],
      'Empty?': [],
    })
    expect(reply).toMatchObject({
      source: 'no-preference',
      record: { answers: { 'Pick?': ['x, y', 'z'], 'Why?': null, 'Empty?': [] } },
    })
    if (reply === 'invalid') throw new Error('invalid')
    expect(reply.text).toContain('"Pick?" = "x, y, z"')
    expect(reply.text).toContain('"Empty?" = ""')
    expect(answeredReply(['Pick?'], { unknown: null })).toBe('invalid')
    expect(typedReply('  raw\ntext  ')).toMatchObject({
      source: 'typed-answer',
      record: { answers: {}, response: '  raw\ntext  ' },
    })
  })

  it('answers once, resumes the rest and persists the same summary as live', async () => {
    const h = harness()
    const pending = await pause(h, true)
    expect(h.executed).toEqual([])
    const before = await entries(h.store)
    expect(
      await h.service.answer({
        kind: 'question',
        sessionId: SESSION,
        requestId: pending.requestId,
        answers: { unknown: ['x'] },
        origin: null,
      }),
    ).toEqual({ status: 'invalid' })
    expect(await entries(h.store)).toEqual(before)
    h.provider.script(done())
    const command = {
      kind: 'question' as const,
      sessionId: SESSION,
      requestId: pending.requestId,
      answers: { 'Pick?': ['x, y', 'z'] },
      origin: null,
    }
    expect(await h.service.answer(command)).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(h.executed).toEqual([{ at: 'rest' }])
    expect(await h.service.answer(command)).toEqual({ status: 'already-resolved' })
    const facts = await entries(h.store)
    const result = facts.find(
      (e) => e.name === 'tool/result' && e.payload['providerToolCallId'] === 'ask',
    )
    const body = h.provider.requests.at(-1)?.body as {
      messages: { content: { type: string; tool_use_id?: string; content?: unknown }[] }[]
    }
    const replay = body.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result' && block.tool_use_id === 'ask')
    expect(replay?.content).toEqual(result?.payload['content'])
    expect(result?.payload['question']).toEqual({
      answers: { 'Pick?': ['x, y', 'z'], 'Why?': null },
    })
    expect(
      facts.filter(
        (e) =>
          e.name === 'execution/dispatch_committed' && e.payload['providerToolCallId'] === 'ask',
      ),
    ).toEqual([])
    expect(
      facts.find(
        (e) => e.name === 'execution/tool_outcome' && e.payload['providerToolCallId'] === 'ask',
      )?.payload,
    ).toMatchObject({ effect: 'blocked', state: 'completed', source: 'no-preference' })
    expect(
      h.loop.recorded.find((e) => e.type === 'tool-outcome' && e.providerToolCallId === 'ask'),
    ).toMatchObject({ outcome: { question: result?.payload['question'] } })
  })

  it('restores the question after restart and types an answer without a user message', async () => {
    const first = harness()
    const pending = await pause(first)
    const h = harness(first.store, 100)
    await h.service.recover()
    expect(await h.service.currentPending({ sessionId: SESSION })).toEqual(pending)
    const resolved = h.loop.connector.calls.resolveChoice
    h.provider.script(done())
    expect(
      await h.service.send({ sessionId: SESSION, origin: null, text: '  my\nanswer  ' }),
    ).toEqual({ status: 'answered' })
    await h.loop.runEnded()
    expect(h.loop.connector.calls.resolveChoice).toBe(resolved)
    const facts = await entries(h.store)
    expect(facts.filter((e) => e.name === 'message/user')).toHaveLength(1)
    expect(facts.find((e) => e.name === 'tool/result')?.payload['question']).toEqual({
      answers: {},
      response: '  my\nanswer  ',
    })
  })

  it('uses the send lease and frozen provider despite a missing key on the current selection', async () => {
    const h = harness()
    await pause(h)
    await h.service.selectModel({
      sessionId: SESSION,
      origin: null,
      choice: {
        providerId: 'zhipu',
        modelId: 'missing-key',
        effort: null,
      },
    })
    const assemble = h.loop.connector.assemble.bind(h.loop.connector)
    h.loop.connector.assemble = async (q) => {
      if (q.choice.providerId === 'zhipu') throw new ProviderConfigMissingError('zhipu', 'apiKey')
      return assemble(q)
    }
    await h.loop.queue.enqueue(SESSION, 'queued before the answer', { urgent: false })
    const leases = h.loop.leaseLog.length
    h.provider.script(done())
    const held = h.loop.connector.holdAssemble()
    const sending = h.service.send({ sessionId: SESSION, origin: null, text: 'typed answer' })
    await held.reached
    const lease = h.loop.liveLease(SESSION)
    expect(lease).not.toBeNull()
    expect(lease?.finished).toBe(false)
    held.release()
    expect(await sending).toEqual({ status: 'answered' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(h.loop.leaseLog).toHaveLength(leases + 1)
    expect(h.loop.leaseLog.at(-1)).toBe(lease)
    expect(JSON.stringify(h.provider.requests.at(-1)?.body)).toContain('queued before the answer')
    const facts = await entries(h.store)
    expect(facts.filter((e) => e.name === 'message/user')).toHaveLength(2)
    expect(facts.findLast((e) => e.name === 'session/model_selected')?.payload['providerId']).toBe(
      'anthropic',
    )
  })

  it('appends the question pause atomically and the answer with its continuation head', async () => {
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const batches: string[][] = []
    const store = proxyStore(inner, {
      append: async (batch) => {
        batches.push(batch.entries.map((entry) => entry.name))
        return inner.append(batch)
      },
    })
    const h = harness(store)
    const pending = await pause(h)
    expect(batches.find((batch) => batch.includes('tool/permission_decided'))).toContain(
      'execution/run_terminal',
    )
    h.provider.script(done())
    await h.service.answer({
      kind: 'question',
      sessionId: SESSION,
      requestId: pending.requestId,
      origin: null,
      answers: {},
    })
    await h.loop.runEnded()
    expect(batches.find((batch) => batch.includes('tool/result'))).toEqual(
      expect.arrayContaining([
        'execution/tool_outcome',
        'execution/run_started',
        'session/model_selected',
      ]),
    )
  })

  it('stops an unanswered question and closes its unexecuted siblings', async () => {
    const h = harness()
    await pause(h, true)
    await h.service.stop({ rootSessionId: SESSION })
    expect(h.executed).toEqual([])
    expect(await h.service.currentPending({ sessionId: SESSION })).toBeNull()
    const facts = await entries(h.store)
    expect(
      facts
        .filter((e) => e.name === 'execution/tool_outcome')
        .map((e) => [e.payload['state'], e.payload['source'], e.payload['effect']]),
    ).toEqual([
      ['aborted', 'unanswered', 'blocked'],
      ['not-run', 'stopped', 'blocked'],
    ])
    expect(facts.find((e) => e.name === 'tool/result')?.payload['isError']).toBe(true)
  })

  it.each([
    { questions: [] },
    { questions: Array.from({ length: 5 }, () => question()) },
    { questions: [{ ...question(), header: '😀'.repeat(13) }] },
    { questions: [{ ...question(), options: [question().options[0]] }] },
    {
      questions: [
        { ...question(), options: Array.from({ length: 5 }, () => question().options[0]) },
      ],
    },
  ])('rejects out-of-bounds question input before any decision: %j', async (input) => {
    const h = harness()
    h.provider.script(calls(input))
    h.provider.script(done())
    await h.service.send({ sessionId: SESSION, origin: null, text: 'Ask' })
    await h.loop.runEnded()
    const facts = await entries(h.store)
    expect(facts.filter((e) => e.name === 'tool/permission_decided')).toEqual([])
    expect(facts.find((e) => e.name === 'execution/tool_outcome')?.payload['source']).toBe(
      'invalid-input',
    )
  })
})
