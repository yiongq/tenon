/**
 * Waiting and answers (spec 02 §等待模型：审批、提问与拒绝, §每种答复同批写什么, §续跑, §主进程与 kernel
 * 的循环接口; plan step 15: 旧 4, 旧 169, 旧 170, 旧 10, 旧 173, 旧 174, 旧 21, 旧 34, 旧 172, the frozen
 * ModelInfo, the mailbox timing rules, 02 不变量 25–28).
 *
 * The cards come from an ask inspector on the `fs__look` connector tool (the user set it to
 * always-allow, so without the inspector it runs), and from WebFetch, which asks in the manual mode.
 * A question's card is plan step 26's; the startup rejudge and its card-less restart are step 16's.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ProviderConfigMissingError,
  ProviderInvalidArgumentError,
  anthropicDefinition,
  createMemoryHost,
  createMemoryTapeStore,
} from '../../src/index.js'
import type {
  CapabilitySource,
  HostAdapter,
  MemoryHost,
  ModelInfo,
  SessionEvent,
  SessionService,
  StreamEvent,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import {
  createCounterIds,
  createFakeInspector,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type {
  FakeInspector,
  ScriptedProvider,
  TestLoopPorts,
  TestToolRegistry,
} from '../../src/testing/index.js'
import { modelWireHash } from '../../src/provider/wire/shared.js'
import { MODEL_NOTES } from '../../src/prompts/index.js'
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js'
import { LOOK, lookSource, proxyStore } from './support.js'

const IDENTITY = { userId: 'answer-user', tenantId: 'answer-tenant', profileDir: '/tenon/answer' }
const SESSION = '7c4e9a2e-6b3d-4a71-9f52-0c8de7a11b37'

const MODEL: ModelInfo = {
  id: 'claude-answer-1',
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

const USAGE: Usage = {
  inputTokens: 9,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

const ASK = { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] } as const

/** A policy that asks about `fs__look`: with the inspector silent, still a card — a different one. */
const ASK_LOOK = {
  status: 'current',
  version: 'v2',
  snapshot: { tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'ask' }] },
} as const

type RunEnded = Extract<SessionEvent, { type: 'run-ended' }>

interface Harness {
  readonly memory: MemoryHost
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  readonly executed: Record<string, unknown>[]
  readonly inspector: FakeInspector
  readonly logs: string[]
}

interface HarnessOptions {
  readonly store?: TapeStore
  readonly tools?: TestToolRegistry
  /** Where the id counter starts: a restarted service must not mint the ids of the one before. */
  readonly idsFrom?: number
  /** What the menu answers: the model, its effort and where its capabilities came from. */
  readonly model?: ModelInfo
  readonly effort?: string | null
  readonly capabilitySource?: CapabilitySource
  readonly locale?: 'zh-CN' | 'en'
  /** The `fs__look` tool's description, as its server gives it now. */
  readonly description?: string
}

/**
 * A memory host whose clock never moves on its own: an inspector's time limit never runs out, so a
 * card's reason is the inspector's, and no case here waits on a resend.
 */
function hosts(): { memory: MemoryHost; host: HostAdapter } {
  const memory = createMemoryHost()
  return { memory, host: memory }
}

function harness(o: HarnessOptions = {}): Harness {
  const { memory, host } = hosts()
  const store = o.store ?? createMemoryTapeStore({ identity: IDENTITY })
  const model = o.model ?? MODEL
  const provider = createScriptedProvider({ models: [model] })
  const executed: Record<string, unknown>[] = []
  const inspector = createFakeInspector({ id: 'asker', ceiling: 'ask', answer: ASK })
  const logs: string[] = []
  const loop = createTestLoopPorts({
    connector: {
      provider,
      model,
      mcpSources: [lookSource(executed, undefined, o.description)],
      ...(o.effort === undefined ? {} : { effort: o.effort }),
      ...(o.capabilitySource === undefined ? {} : { capabilitySource: o.capabilitySource }),
    },
    ...(o.locale === undefined ? {} : { locale: o.locale }),
  })
  const service = createTestSessionService(
    {
      host,
      tape: store,
      ids: createCounterIds({ start: o.idsFrom ?? 1 }),
      inspectors: [inspector.registration],
      connector: loop.connector,
      protectedFiles: [],
      log: (line) => logs.push(line),
    },
    { tools: o.tools ?? {}, userSetting: () => ({ userSetting: 'always-allow' }) },
  )
  service.bindLoop(loop)
  return { memory, store, service, loop, provider, executed, inspector, logs }
}

/** A reply asking for these `fs__look` calls. */
function calls(...ats: readonly string[]): StreamEvent[] {
  const events: StreamEvent[] = []
  ats.forEach((at, i) => {
    const index = i + 1
    const id = `toolu_${at}`
    events.push(
      { type: 'tool-call-start', index, id, name: LOOK },
      { type: 'tool-call-end', index, id, name: LOOK, input: { at } },
    )
  })
  events.push({ type: 'usage', usage: USAGE }, stopEvent('tool-use', 'tool_use'))
  return events
}

const done = (): StreamEvent[] => scriptedTurn({ deltas: ['Done.'], usage: USAGE })

let texts = 0

async function send(h: Harness, text = `message ${String((texts += 1))}`): Promise<RunEnded> {
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return h.loop.runEnded({ runId: sent.runId })
}

/** Sends, and the Run pauses on the first call's card. */
async function paused(h: Harness, ...ats: readonly string[]): Promise<string> {
  h.provider.script(calls(...(ats.length === 0 ? ['a'] : ats)))
  expect((await send(h)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
  return requestIdOf(h)
}

async function requestIdOf(h: Harness): Promise<string> {
  const card = await h.service.currentPending({ sessionId: SESSION })
  if (card === null) throw new Error('no card')
  return card.card.requestId
}

function answer(h: Harness, requestId: string, decision: 'allow' | 'deny') {
  return h.service.answer({
    kind: 'approval',
    sessionId: SESSION,
    requestId,
    decision,
    origin: null,
  })
}

async function all(h: Harness): Promise<TapeEntry[]> {
  return (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}

function named(entries: readonly TapeEntry[], name: string): TapeEntry[] {
  return entries.filter((entry) => entry.name === name)
}

function outcomes(entries: readonly TapeEntry[]): string[] {
  return named(entries, 'execution/tool_outcome').map(
    (entry) =>
      `${String(entry.payload['ordinal'])}:${String(entry.payload['state'])}/${String(entry.payload['source'])}`,
  )
}

function resolutions(entries: readonly TapeEntry[]): string[] {
  return named(entries, 'tool/approval_resolved').map(
    (entry) => `${String(entry.payload['outcome'])}/${String(entry.payload['via'])}`,
  )
}

/** What an attempt sent: its model, the hashes of its model row and tools, and its request snapshot. */
function attemptSnapshot(entry: TapeEntry | undefined): unknown {
  return {
    modelId: entry?.payload['modelId'],
    modelWireHash: entry?.payload['modelWireHash'],
    toolDefinitionsHash: entry?.payload['toolDefinitionsHash'],
    request: entry?.payload['request'],
  }
}

async function rows(h: Harness): Promise<number> {
  return (await h.store.listPendingApprovals({ sessionId: SESSION, limit: 100 })).length
}

describe('a card, and its answer', () => {
  it('pauses with the decision and the terminal committed, then delivers the card once', async () => {
    const h = harness()
    const requestId = await paused(h)
    expect(requestId).toMatch(/^tool:v1:decision:.+:1:0$/)
    expect(h.memory.confirmRequests.map((request) => request.requestId)).toEqual([requestId])
    expect(await rows(h)).toBe(1)
    const pending = await h.service.currentPending({ sessionId: SESSION })
    expect(pending).toMatchObject({
      waitKind: 'approval',
      card: {
        sessionId: SESSION,
        kind: 'tool',
        reason: 'flagged',
        facts: { category: 'exfiltration' },
      },
      allowScope: 'once',
    })
    expect(pending?.callKey).toBe(pending?.anchorCallKey)
    // Every slot the reason needs is filled, so the card crosses confirm.request's schema.
    expect(pending?.card.facts).toEqual({ category: 'exfiltration', toolName: 'look' })
  })

  it('allows: resumes the batch with that call, under the same model, and the next card waits alone (旧 174)', async () => {
    const appends: string[][] = []
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = proxyStore(inner, {
      append: async (batch) => {
        appends.push(batch.entries.map((entry) => entry.name))
        return inner.append(batch)
      },
    })
    const h = harness({ store })
    const first = await paused(h, 'a', 'b')
    // 旧 174: 在 SessionService 与 approval.list 上断言…最多一行.
    const oneRow = [{ sessionId: SESSION, waitKind: 'approval' }]
    expect(await h.service.listPendingRoots({ limit: 20 })).toEqual(oneRow)
    h.provider.script(done())
    expect(await answer(h, first, 'allow')).toEqual({ status: 'applied' })
    // 验收 12: the allowed answer and the new Run's head, written together or not at all.
    const allowedWith = [
      'tool/approval_resolved',
      'execution/run_started',
      'session/model_selected',
    ]
    expect(appends.filter((names) => names.includes('tool/approval_resolved'))).toEqual([
      allowedWith,
    ])
    // b is judged next, asks, and the resumed Run pauses on it: one row at a time.
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    expect(h.executed).toEqual([{ at: 'a' }])
    expect(await rows(h)).toBe(1)
    expect(await h.service.listPendingRoots({ limit: 20 })).toEqual(oneRow)
    const second = await requestIdOf(h)
    expect(second).toMatch(/:1:1$/)
    expect(await answer(h, second, 'allow')).toEqual({ status: 'applied' })
    expect(appends.filter((names) => names.includes('tool/approval_resolved'))).toEqual([
      allowedWith,
      allowedWith,
    ])
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(h.executed).toEqual([{ at: 'a' }, { at: 'b' }])
    const entries = await all(h)
    expect(resolutions(entries)).toEqual(['allowed/card', 'allowed/card'])
    const grant = named(entries, 'tool/approval_resolved')[0]?.payload['grant'] as { scope: string }
    expect(grant.scope).toBe('once')
    // Two Runs resumed the batch, each naming the paused Run and the batch's request.
    const resumes = named(entries, 'execution/run_started')
      .map((entry) => entry.payload['cause'] as { kind: string; batch?: { requestSeq: number } })
      .filter((cause) => cause.kind === 'resume')
    expect(resumes).toHaveLength(2)
    expect(resumes.every((cause) => cause.batch?.requestSeq === 1)).toBe(true)
    // Each Run selected the same provider and model.
    expect(
      new Set(
        named(entries, 'session/model_selected').map((entry) => JSON.stringify(entry.payload)),
      ).size,
    ).toBe(1)
    // The results hang off the request that made the calls, written by the Run that ran them
    // (验收 12: 六条事实都挂在原 runId 下，writer 记实际写入者).
    const [pausedRun, firstResumed, secondResumed] = named(entries, 'execution/run_started').map(
      (entry) => entry.sourceId,
    )
    const results = named(entries, 'tool/result')
    expect(
      results.map((entry) => [entry.sourceId, entry.sourceSeq, entry.payload['writer']]),
    ).toEqual([
      [pausedRun, 1, { by: 'run', runId: firstResumed }],
      [pausedRun, 1, { by: 'run', runId: secondResumed }],
    ])
    expect(
      named(entries, 'execution/dispatch_committed').map((entry) => [
        entry.sourceId,
        entry.payload['writer'],
      ]),
    ).toEqual([
      [pausedRun, { by: 'run', runId: firstResumed }],
      [pausedRun, { by: 'run', runId: secondResumed }],
    ])
    // 验收 12: rejudge 只在结论、摘要或卡面变了时才写 — both allows found the cards unchanged.
    expect(
      named(entries, 'tool/permission_decided').filter((entry) =>
        entry.provenanceKey?.includes(':rejudge:'),
      ),
    ).toEqual([])
    expect(await h.service.currentPending({ sessionId: SESSION })).toBeNull()
    expect(await h.service.listPendingRoots({ limit: 20 })).toEqual([])
  })

  it('rejects in the main session: one append, a Run that sends nothing, and the rest not run (旧 173)', async () => {
    const appends: string[][] = []
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = proxyStore(inner, {
      append: async (batch) => {
        appends.push(batch.entries.map((entry) => entry.name))
        return inner.append(batch)
      },
    })
    const h = harness({ store })
    const requestId = await paused(h, 'a', 'b')
    const starts = h.provider.starts
    expect(await answer(h, requestId, 'deny')).toEqual({ status: 'applied' })
    const ended = await h.loop.runEnded()
    expect(ended.reason).toEqual({ code: 'user-rejected', toolName: 'look' })
    expect(appends.at(-1)).toEqual([
      'tool/approval_resolved',
      'tool/result',
      'execution/tool_outcome',
      'tool/result',
      'execution/tool_outcome',
      'execution/run_started',
      'execution/run_terminal',
    ])
    expect(h.provider.starts).toBe(starts)
    expect(h.executed).toEqual([])
    const entries = await all(h)
    expect(outcomes(entries)).toEqual(['0:not-run/user-rejected', '1:not-run/user-rejected'])
    expect(named(entries, 'tool/result')[0]?.payload['content']).toEqual([
      { type: 'text', text: MODEL_NOTES.closure['user-rejected']['not-run'] },
    ])
  })
})

describe('a stop, a new message and the answers that lose to them', () => {
  it('stops a paused session: cancelled, the batch not run, no Run, and later answers too late (旧 10, 旧 170)', async () => {
    const h = harness()
    const requestId = await paused(h, 'a', 'b')
    const started = named(await all(h), 'execution/run_started').length
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    let entries = await all(h)
    expect(resolutions(entries)).toEqual(['cancelled-by-stop/stop'])
    expect(outcomes(entries)).toEqual(['0:not-run/stopped', '1:not-run/stopped'])
    expect(named(entries, 'execution/run_started')).toHaveLength(started)
    expect(await h.service.currentPending({ sessionId: SESSION })).toBeNull()
    // 旧 10: 重启后也不再弹出 — a restarted service delivers no card and lists nothing to resume.
    const restarted = harness({ store: h.store, idsFrom: 1000 })
    expect(await restarted.service.recover()).toEqual({ resumable: [], errors: [] })
    expect(restarted.memory.confirmRequests).toEqual([])
    expect(await restarted.service.currentPending({ sessionId: SESSION })).toBeNull()
    expect(await restarted.service.listPendingRoots({ limit: 20 })).toEqual([])
    expect(await answer(h, requestId, 'allow')).toEqual({ status: 'already-resolved' })
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: false })
    // The next request carries both closures.
    h.provider.script(done())
    await send(h)
    entries = await all(h)
    expect(JSON.stringify(h.provider.requests.at(-1)?.body)).toContain(
      MODEL_NOTES.closure.stopped['not-run'],
    )
  })

  it('lets an allow that came first stand: the stop after it finds nothing (旧 170)', async () => {
    const h = harness()
    const requestId = await paused(h)
    h.provider.script(done())
    expect(await answer(h, requestId, 'allow')).toEqual({ status: 'applied' })
    await h.loop.runEnded()
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: false })
    expect(resolutions(await all(h))).toEqual(['allowed/card'])
  })

  /** A stop and an allow on one card, sent together in this order; what each answered, and the Tape. */
  async function together(order: 'stop-first' | 'allow-first'): Promise<{
    answers: unknown[]
    results: number
    resolutions: string[]
  }> {
    const h = harness()
    const requestId = await paused(h)
    h.provider.script(done())
    const stopping = (): Promise<unknown> => h.service.stop({ rootSessionId: SESSION })
    const allowing = (): Promise<unknown> => answer(h, requestId, 'allow')
    const answers = await Promise.all(
      order === 'stop-first' ? [stopping(), allowing()] : [allowing(), stopping()],
    )
    const entries = await all(h)
    return {
      answers,
      results: named(entries, 'tool/result').length,
      resolutions: resolutions(entries),
    }
  }

  it('takes the stop that came first when a stop and an allow arrive together (旧 4)', async () => {
    expect(await together('stop-first')).toEqual({
      answers: [{ stopped: true }, { status: 'already-resolved' }],
      results: 1,
      resolutions: ['cancelled-by-stop/stop'],
    })
  })

  it('lets a stop abort the allow that holds the lease, before its append (旧 4)', async () => {
    expect(await together('allow-first')).toEqual({
      answers: [{ status: 'already-resolved' }, { stopped: true }],
      results: 1,
      resolutions: ['cancelled-by-stop/stop'],
    })
  })

  it('supersedes the card with a new message: closures first, then the message (旧 21)', async () => {
    const h = harness()
    const requestId = await paused(h, 'a', 'b')
    h.provider.script(done())
    await send(h, 'forget that, do this instead')
    const entries = await all(h)
    expect(resolutions(entries)).toEqual(['superseded/new-message'])
    expect(outcomes(entries)).toEqual(['0:not-run/superseded', '1:not-run/superseded'])
    const lastUser = entries.findLast((entry) => entry.name === 'message/user')
    const lastResult = entries.findLast((entry) => entry.name === 'tool/result')
    expect(lastResult?.entryId).toBeLessThan(lastUser?.entryId ?? 0)
    const body = h.provider.requests.at(-1)?.body as {
      messages: { role: string; content: { type: string }[] }[]
    }
    expect(body.messages.at(-2)?.content.map((block) => block.type)).toEqual([
      'tool_result',
      'tool_result',
    ])
    expect(await answer(h, requestId, 'allow')).toEqual({ status: 'already-resolved' })
  })

  it('supersedes with the messages queued meanwhile first, in their order (旧 21, 验收 20)', async () => {
    const h = harness()
    await paused(h, 'a', 'b')
    // Queued while the Run was busy: a pause takes nothing from the queue (§插话与输入框状态表).
    await h.loop.queue.enqueue(SESSION, 'meanwhile', { urgent: false })
    await h.loop.queue.enqueue(SESSION, 'and this', { urgent: false })
    h.provider.script(done())
    await send(h, 'instead')
    const entries = await all(h)
    expect(resolutions(entries)).toEqual(['superseded/new-message'])
    // 取代: 已排队的消息按先后排在新消息前面一起发出 — after the closures, in one round.
    const tail = entries
      .filter((entry) => entry.name === 'tool/result' || entry.name === 'message/user')
      .slice(-5)
      .map((entry) =>
        entry.name === 'tool/result'
          ? 'result'
          : ((entry.payload['content'] as { text: string }[])[0]?.text ?? ''),
      )
    expect(tail).toEqual(['result', 'result', 'meanwhile', 'and this', 'instead'])
    expect(named(entries, 'execution/run_started')).toHaveLength(2)
    // The request shows the model both results, then the three messages in that order.
    const body = h.provider.requests.at(-1)?.body as {
      messages: { role: string; content: { type: string; text?: string }[] }[]
    }
    const blocks = body.messages
      .flatMap((message) => message.content)
      .map((block) => (block.type === 'text' ? String(block.text) : block.type))
    const afterCalls = blocks.slice(blocks.lastIndexOf('tool_use') + 1)
    expect(
      afterCalls.filter((block) =>
        ['tool_result', 'meanwhile', 'and this', 'instead'].includes(block),
      ),
    ).toEqual(['tool_result', 'tool_result', 'meanwhile', 'and this', 'instead'])
    expect(h.loop.queued(SESSION)).toEqual([])
  })

  it('cancels the card when a stop lands while a stale answer reads the Tape (「登记之后、append 之前被中止」)', async () => {
    // The stop found the answer's live lease and aborted it: the holder closes for it (「停止」),
    // whatever its target turned out to be.
    let holding = false
    const reached = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = proxyStore(inner, {
      listPendingApprovals: async (q) => {
        if (holding) {
          holding = false
          reached.resolve()
          await gate.promise
        }
        return inner.listPendingApprovals(q)
      },
    })
    const h = harness({ store })
    const old = await paused(h)
    h.inspector.answer({ kind: 'none' })
    h.memory.setPolicy(ASK_LOOK)
    expect(await answer(h, old, 'allow')).toEqual({ status: 'stale' })
    const fresh = await requestIdOf(h)
    holding = true
    const answering = answer(h, old, 'allow')
    await reached.promise
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    gate.resolve()
    expect(await answering).toEqual({ status: 'already-resolved' })
    const entries = await all(h)
    expect(resolutions(entries)).toEqual(['cancelled-by-stop/stop'])
    expect(outcomes(entries)).toEqual(['0:not-run/stopped'])
    expect(await h.service.currentPending({ sessionId: SESSION })).toBeNull()
    expect(await rows(h)).toBe(0)
    expect(await answer(h, fresh, 'allow')).toEqual({ status: 'already-resolved' })
  })
})

describe('the re-judgement before an allow (F3)', () => {
  it('tightens to a denial the policy now makes: denied-on-rejudge, not run, and the batch goes on (旧 4)', async () => {
    const appends: string[][] = []
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = proxyStore(inner, {
      append: async (batch) => {
        appends.push(batch.entries.map((entry) => entry.name))
        return inner.append(batch)
      },
    })
    const h = harness({ store })
    const requestId = await paused(h)
    h.memory.setPolicy({
      status: 'current',
      version: 'v2',
      snapshot: { tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'deny' }] },
    })
    h.provider.script(done())
    expect(await answer(h, requestId, 'allow')).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    const entries = await all(h)
    expect(resolutions(entries)).toEqual(['denied-on-rejudge/rejudge'])
    expect(named(entries, 'tool/permission_decided').map((entry) => entry.provenanceKey)).toEqual([
      requestId,
      `${requestId}:rejudge:1`,
    ])
    expect(outcomes(entries)).toEqual(['0:not-run/policy'])
    expect(h.executed).toEqual([])
    // 验收 12: the re-judgement, the resolution, the closure and the new Run's head in one append.
    expect(appends.filter((names) => names.includes('tool/approval_resolved'))).toEqual([
      [
        'tool/permission_decided',
        'tool/approval_resolved',
        'tool/result',
        'execution/tool_outcome',
        'execution/run_started',
        'session/model_selected',
      ],
    ])
  })

  it('answers stale when the card changed, and applies on the new card (旧 169)', async () => {
    const h = harness()
    const old = await paused(h)
    // The inspector has nothing to say now, but the policy asks: still a card, a different one.
    h.inspector.answer({ kind: 'none' })
    h.memory.setPolicy({
      status: 'current',
      version: 'v2',
      snapshot: { tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'ask' }] },
    })
    expect(await answer(h, old, 'allow')).toEqual({ status: 'stale' })
    let entries = await all(h)
    expect(resolutions(entries)).toEqual([])
    expect(named(entries, 'tool/permission_decided').at(-1)?.provenanceKey).toBe(`${old}:rejudge:1`)
    const fresh = await requestIdOf(h)
    expect(fresh).toBe(`${old}:rejudge:1`)
    expect(h.memory.confirmRequests.map((request) => request.requestId)).toEqual([old, fresh])
    expect(await answer(h, old, 'allow')).toEqual({ status: 'stale' })
    h.provider.script(done())
    expect(await answer(h, fresh, 'allow')).toEqual({ status: 'applied' })
    await h.loop.runEnded()
    entries = await all(h)
    expect(resolutions(entries)).toEqual(['allowed/card'])
    expect(h.executed).toEqual([{ at: 'a' }])
  })

  /** An allow whose card changed, and a stop or a quit that lands while the re-judgement commits. */
  async function abortedWhileRejudging(cause: 'user-stop' | 'quit'): Promise<{
    stopped: unknown
    answered: unknown
    resolutions: string[]
    delivered: string[]
    cardLeft: string | null
  }> {
    let holding = false
    const reached = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = proxyStore(inner, {
      append: async (batch) => {
        if (holding && batch.entries.some((entry) => entry.provenanceKey?.includes(':rejudge:'))) {
          holding = false
          reached.resolve()
          await gate.promise
        }
        return inner.append(batch)
      },
    })
    const h = harness({ store })
    const old = await paused(h)
    h.inspector.answer({ kind: 'none' })
    h.memory.setPolicy(ASK_LOOK)
    holding = true
    const answering = answer(h, old, 'allow')
    await reached.promise
    const stopped =
      cause === 'user-stop'
        ? await h.service.stop({ rootSessionId: SESSION })
        : h.loop.abort(SESSION, 'quit')
    gate.resolve()
    const answered = await answering
    return {
      stopped,
      answered,
      resolutions: resolutions(await all(h)),
      delivered: h.memory.confirmRequests.map((request) => request.requestId.replace(old, 'old')),
      cardLeft:
        (await h.service.currentPending({ sessionId: SESSION }))?.card.requestId.replace(
          old,
          'old',
        ) ?? null,
    }
  }

  it('cancels the new card, never shown, when a stop lands while the changed re-judgement commits', async () => {
    // 「停止」: 有活租约就 abort('user-stop') — the answer holding it closes as 暂停中停止.
    expect(await abortedWhileRejudging('user-stop')).toEqual({
      stopped: { stopped: true },
      answered: { status: 'already-resolved' },
      resolutions: ['cancelled-by-stop/stop'],
      delivered: ['old'],
      cardLeft: null,
    })
  })

  it('leaves the new card for the restart when a quit lands there instead (B4)', async () => {
    expect(await abortedWhileRejudging('quit')).toEqual({
      stopped: true,
      answered: { status: 'refused' },
      resolutions: [],
      delivered: ['old'],
      cardLeft: 'old:rejudge:1',
    })
  })

  it('closes a tool the build no longer has as tool-unavailable after a restart (旧 4)', async () => {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const before = harness({ store, tools: {} })
    before.inspector.answer({ kind: 'none' })
    // WebFetch asks in the manual mode: it sends data out.
    before.provider.script([
      { type: 'tool-call-start', index: 1, id: 'toolu_fetch', name: 'WebFetch' },
      {
        type: 'tool-call-end',
        index: 1,
        id: 'toolu_fetch',
        name: 'WebFetch',
        input: { url: 'https://example.com/' },
      },
      { type: 'usage', usage: USAGE },
      stopEvent('tool-use', 'tool_use'),
    ])
    expect((await send(before)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    const requestId = await requestIdOf(before)
    // The restart: a new service on the same store, whose build has no WebFetch executor.
    const after = harness({ store, tools: { WebFetch: null }, idsFrom: 1000 })
    after.provider.script(done())
    expect(await answer(after, requestId, 'allow')).toEqual({ status: 'applied' })
    expect((await after.loop.runEnded()).reason).toEqual({ code: 'completed' })
    const entries = await all(after)
    expect(resolutions(entries)).toEqual(['tool-unavailable/rejudge'])
    expect(outcomes(entries)).toEqual(['0:not-run/tool-unavailable'])
  })
})

describe('the resumed Run (§续跑)', () => {
  it('keeps the paused model and its ModelInfo, whatever the menu or the table say now (旧 34)', async () => {
    const h = harness()
    const requestId = await paused(h)
    const pausedAttempt = named(await all(h), 'provider/attempt_completed').at(-1)
    // The row changed after the pause, the menu picked another model, and the server now
    // describes its tool differently (acceptance 21).
    h.loop.connector.use({
      provider: h.provider,
      model: { ...MODEL, id: 'claude-answer-2', contextLimit: 100_000 },
      mcpSources: [lookSource(h.executed, undefined, 'A tool that looks, rewritten.')],
    })
    h.provider.script(done())
    await answer(h, requestId, 'allow')
    await h.loop.runEnded()
    const entries = await all(h)
    const selected = named(entries, 'session/model_selected').map(
      (entry) => entry.payload['modelId'],
    )
    expect(new Set(selected)).toEqual(new Set([MODEL.id]))
    const resumed = named(entries, 'provider/attempt_completed').at(-1)
    expect(resumed?.payload['modelId']).toBe(MODEL.id)
    expect(resumed?.payload['modelWireHash']).toBe(pausedAttempt?.payload['modelWireHash'])
    expect(resumed?.payload['modelWireHash']).toBe(modelWireHash(MODEL))
    expect(resumed?.payload['toolDefinitionsHash']).toBe(
      pausedAttempt?.payload['toolDefinitionsHash'],
    )
  })

  it('sends the one request to the paused model after it was withdrawn, and ends provider-error (旧 172, 验收 21)', async () => {
    const h = harness()
    const requestId = await paused(h)
    const starts = h.provider.starts
    const pausedSelected = named(await all(h), 'session/model_selected').at(-1)?.payload
    // The row is gone: the menu offers another model now, and the server refuses the old one.
    h.loop.connector.use({
      provider: h.provider,
      model: { ...MODEL, id: 'claude-answer-2' },
      mcpSources: [lookSource(h.executed)],
    })
    h.provider.script(
      scriptedTurn({
        deltas: [],
        terminal: {
          type: 'error',
          code: 'invalid-request',
          retryable: false,
          providerCode: 'not_found_error',
          detail: `model: ${MODEL.id}`,
        },
      }),
    )
    expect(await answer(h, requestId, 'allow')).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toMatchObject({
      code: 'provider-error',
      errorCode: 'invalid-request',
    })
    expect(h.executed).toEqual([{ at: 'a' }])
    // 模型已下线：发一次请求，以 provider-error 结束，不换别的模型.
    expect(h.provider.starts).toBe(starts + 1)
    const body = h.provider.requests.at(-1)?.body as { model: string } | undefined
    expect(body?.model).toBe(MODEL.id)
    expect(named(await all(h), 'session/model_selected').at(-1)?.payload).toEqual(pausedSelected)
  })

  it('keeps what ran and records a provider-error end when the base URL is unusable (§续跑)', async () => {
    // 「第一次发请求时才构造 provider；构造失败也不能丢已执行调用的结果」: a value present but unusable
    // is a configuration end, as a new round's prebuild reads it (`invalid-request`), not a Run left
    // without its terminal.
    const h = harness()
    const requestId = await paused(h)
    const starts = h.provider.starts
    h.loop.connector.failProvider(
      new ProviderInvalidArgumentError('baseURL must not carry a query string'),
    )
    expect(await answer(h, requestId, 'allow')).toEqual({ status: 'applied' })
    expect(await h.loop.runEnded()).toMatchObject({
      recorded: true,
      reason: {
        code: 'provider-error',
        providerId: 'anthropic',
        errorCode: 'invalid-request',
        attempts: 0,
      },
      errorCode: 'invalid-request',
    })
    expect(h.executed).toEqual([{ at: 'a' }])
    const entries = await all(h)
    expect(outcomes(entries)).toEqual(['0:completed/null'])
    expect(named(entries, 'execution/run_terminal')).toHaveLength(2)
    expect(h.provider.starts).toBe(starts)
  })

  it('keeps the paused Run’s provider, model, source, effort, system and tools across an upgrade (旧 15, 旧 16, 不变量 25)', async () => {
    const row = anthropicDefinition.builtinModels.find((model) => model.id === 'claude-sonnet-5')
    if (row === undefined) throw new Error('no claude-sonnet-5 row')
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const before = harness({
      store,
      model: row,
      effort: 'low',
      capabilitySource: 'user',
      locale: 'en',
    })
    const requestId = await paused(before)
    // The simulated upgrade: a new process whose menu picked another model and effort, whose
    // interface speaks another language, whose server describes its tool differently, and whose
    // builtin tools read differently.
    const spec = vi.spyOn(BUILTIN_TOOLS.WebFetch, 'spec').mockImplementation(() => ({
      name: 'WebFetch',
      description: 'Fetches a page, as the upgraded build describes it.',
      inputSchema: { type: 'object' },
    }))
    try {
      const after = harness({
        store,
        idsFrom: 1000,
        model: { ...row, id: 'claude-answer-2' },
        effort: 'max',
        capabilitySource: 'builtin',
        locale: 'zh-CN',
        description: 'A tool that looks, rewritten.',
      })
      after.provider.script(done())
      expect(await answer(after, requestId, 'allow')).toEqual({ status: 'applied' })
      expect((await after.loop.runEnded()).reason).toEqual({ code: 'completed' })
    } finally {
      spec.mockRestore()
    }
    const entries = await all(before)
    const [pausedAttempt, resumedAttempt] = named(entries, 'provider/attempt_completed')
    const [pausedSelected, resumedSelected] = named(entries, 'session/model_selected')
    expect(resumedSelected?.payload).toEqual(pausedSelected?.payload)
    expect(resumedSelected?.payload).toMatchObject({
      providerId: 'anthropic',
      modelId: row.id,
      capabilitySource: 'user',
    })
    expect(attemptSnapshot(resumedAttempt)).toEqual(attemptSnapshot(pausedAttempt))
    expect(pausedAttempt?.payload['request']).toMatchObject({ effort: 'low' })
    // One system text for the incarnation, the one assembled before the pause.
    expect(
      named(entries, 'view/content').filter((entry) => entry.payload['type'] === 'system'),
    ).toHaveLength(1)
  })

  it('runs the approved call even when the key is gone, then ends as auth with no request (旧 172)', async () => {
    const h = harness()
    const requestId = await paused(h)
    const starts = h.provider.starts
    h.loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'))
    expect(await answer(h, requestId, 'allow')).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toMatchObject({
      code: 'provider-error',
      errorCode: 'auth',
      attempts: 0,
    })
    expect(h.executed).toEqual([{ at: 'a' }])
    expect(outcomes(await all(h))).toEqual(['0:completed/null'])
    expect(h.provider.starts).toBe(starts)
  })
})

describe('the mailbox around an answer (§主进程与 kernel 的循环接口)', () => {
  it('cancels the card when a user-stop lands while the allow is being judged', async () => {
    const h = harness()
    const requestId = await paused(h)
    h.inspector.answer('never')
    const answering = answer(h, requestId, 'allow')
    await Promise.resolve()
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect(await answering).toEqual({ status: 'already-resolved' })
    const entries = await all(h)
    expect(resolutions(entries)).toEqual(['cancelled-by-stop/stop'])
    expect(named(entries, 'execution/run_started')).toHaveLength(1)
  })

  it('writes nothing on a quit there, and the card is still there after the restart (B4)', async () => {
    const h = harness()
    const requestId = await paused(h)
    const before = await all(h)
    h.inspector.answer('never')
    const answering = answer(h, requestId, 'allow')
    await Promise.resolve()
    expect(h.loop.abort(SESSION, 'quit')).toBe(true)
    expect(await answering).toEqual({ status: 'refused' })
    // 以 quit 中止，Tape 逐字节不变、重启后卡还在.
    expect(await all(h)).toEqual(before)
    expect(await h.service.currentPending({ sessionId: SESSION })).not.toBeNull()
    const restarted = harness({ store: h.store, idsFrom: 1000 })
    expect(await restarted.service.recover()).toEqual({ resumable: [], errors: [] })
    expect(restarted.memory.confirmRequests.map((request) => request.requestId)).toEqual([
      requestId,
    ])
    restarted.provider.script(done())
    expect(await answer(restarted, requestId, 'allow')).toEqual({ status: 'applied' })
    expect((await restarted.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(restarted.executed).toEqual([{ at: 'a' }])
  })

  it('reads a close-window then a stop as the stop', async () => {
    const h = harness()
    const requestId = await paused(h)
    h.inspector.answer('never')
    const answering = answer(h, requestId, 'allow')
    await Promise.resolve()
    h.loop.abort(SESSION, 'close-window')
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect(await answering).toEqual({ status: 'already-resolved' })
    expect(resolutions(await all(h))).toEqual(['cancelled-by-stop/stop'])
  })

  it('lets a message sent during a prebuild supersede, and the allow that came after it loses', async () => {
    const h = harness()
    const requestId = await paused(h)
    const leases = h.loop.leaseLog.length
    h.provider.script(done())
    const sending = h.service.send({ sessionId: SESSION, origin: null, text: 'something else' })
    const answering = answer(h, requestId, 'allow')
    expect(await sending).toMatchObject({ status: 'started' })
    expect(await answering).toEqual({ status: 'already-resolved' })
    expect(resolutions(await all(h))).toEqual(['superseded/new-message'])
    expect(h.loop.leaseLog.length - leases).toBe(1)
  })

  it('queues a message sent while an allow holds the lease, behind the resumed Run', async () => {
    const h = harness()
    const requestId = await paused(h)
    h.provider.script(done())
    const answering = answer(h, requestId, 'allow')
    const sending = h.service.send({ sessionId: SESSION, origin: null, text: 'and then this' })
    expect(await answering).toEqual({ status: 'applied' })
    expect(await sending).toMatchObject({ status: 'queued' })
    expect(resolutions(await all(h))).toEqual(['allowed/card'])
  })

  it('supersedes with a message that waited behind an allow that turned out stale', async () => {
    const h = harness()
    const requestId = await paused(h)
    h.inspector.answer({ kind: 'none' })
    h.memory.setPolicy({
      status: 'current',
      version: 'v2',
      snapshot: { tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'ask' }] },
    })
    h.provider.script(done())
    const answering = answer(h, requestId, 'allow')
    const sending = h.service.send({ sessionId: SESSION, origin: null, text: 'never mind' })
    expect(await answering).toEqual({ status: 'stale' })
    expect(await sending).toMatchObject({ status: 'started' })
    expect(h.loop.queued(SESSION)).toEqual([])
    expect(resolutions(await all(h))).toEqual(['superseded/new-message'])
  })

  it('writes nothing for any command once the host refuses leases', async () => {
    const h = harness()
    const requestId = await paused(h)
    const before = (await all(h)).length
    h.loop.beginShutdown()
    expect(await answer(h, requestId, 'allow')).toEqual({ status: 'refused' })
    expect(await h.service.send({ sessionId: SESSION, origin: null, text: 'x' })).toMatchObject({
      status: 'refused',
    })
    expect(await all(h)).toHaveLength(before)
  })

  it('keeps the card when the new message has no key: nothing superseded, nothing written', async () => {
    const h = harness()
    await paused(h)
    const before = (await all(h)).length
    h.loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'), 1)
    expect(await h.service.send({ sessionId: SESSION, origin: null, text: 'x' })).toEqual({
      status: 'not-sent',
      code: 'config-missing',
    })
    expect(await all(h)).toHaveLength(before)
    expect(await h.service.currentPending({ sessionId: SESSION })).not.toBeNull()
  })

  it('cancels the card, not supersedes it, when a stop lands in the new message’s prebuild', async () => {
    const h = harness()
    await paused(h)
    const hold = h.loop.connector.holdAssemble()
    const sending = h.service.send({ sessionId: SESSION, origin: null, text: 'x' })
    await hold.reached
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect(await sending).toEqual({ status: 'not-sent', code: 'stopped' })
    hold.release()
    const entries = await all(h)
    expect(resolutions(entries)).toEqual(['cancelled-by-stop/stop'])
    expect(named(entries, 'message/user')).toHaveLength(1)
    const ended = await h.loop.runEnded({ runId: null })
    expect(ended).toMatchObject({ recorded: false, reason: { code: 'user-stopped' } })
  })

  /** A pause whose append a stop or a quit reaches mid-flight; what the Run and the Tape say after. */
  async function stoppedWhilePausing(
    cause: 'user-stop' | 'quit' | 'close-window-then-stop',
  ): Promise<{
    stopped: unknown
    reason: unknown
    delivered: number
    resolutions: string[]
    cardLeft: boolean
  }> {
    const gate = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = proxyStore(inner, {
      append: async (batch) => {
        if (batch.entries.some((entry) => entry.name === 'execution/run_terminal')) {
          reached.resolve()
          await gate.promise
        }
        return inner.append(batch)
      },
    })
    const h = harness({ store })
    h.provider.script(calls('a'))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: `go ${cause}` })
    if (sent.status !== 'started') throw new Error('not started')
    await reached.promise
    if (cause === 'close-window-then-stop') h.loop.abort(SESSION, 'close-window')
    const stopped =
      cause === 'quit'
        ? h.loop.abort(SESSION, 'quit')
        : await h.service.stop({ rootSessionId: SESSION })
    gate.resolve()
    const ended = await h.loop.runEnded({ runId: sent.runId })
    return {
      stopped,
      reason: ended.reason,
      delivered: h.memory.confirmRequests.length,
      resolutions: resolutions(await all(h)),
      cardLeft: (await h.service.currentPending({ sessionId: SESSION })) !== null,
    }
  }

  it('cancels a pause a stop reached while it committed, in the same task (「Run 结束」)', async () => {
    expect(await stoppedWhilePausing('user-stop')).toEqual({
      stopped: { stopped: true },
      reason: { code: 'paused', waitingFor: 'approval' },
      delivered: 0,
      resolutions: ['cancelled-by-stop/stop'],
      cardLeft: false,
    })
  })

  it('reads a close-window then a stop there as the stop (「Run 结束」: lease.stopRequested)', async () => {
    // 答复已登记、还没 append 时先以 close-window 中止、再 chat.stop（上一条两个时点同样再各跑一次）.
    expect(await stoppedWhilePausing('close-window-then-stop')).toEqual({
      stopped: { stopped: true },
      reason: { code: 'paused', waitingFor: 'approval' },
      delivered: 0,
      resolutions: ['cancelled-by-stop/stop'],
      cardLeft: false,
    })
  })

  it('leaves that pause and its card for the restart when a quit reached it instead', async () => {
    expect(await stoppedWhilePausing('quit')).toEqual({
      stopped: true,
      reason: { code: 'paused', waitingFor: 'approval' },
      delivered: 0,
      resolutions: [],
      cardLeft: true,
    })
  })

  it('stops first, then sends: the card is cancelled and the message opens a new round', async () => {
    const h = harness()
    await paused(h)
    h.provider.script(done())
    const stopping = h.service.stop({ rootSessionId: SESSION })
    const sending = h.service.send({ sessionId: SESSION, origin: null, text: 'fresh start' })
    expect(await stopping).toEqual({ stopped: true })
    const sent = await sending
    expect(sent).toMatchObject({ status: 'started' })
    if (sent.status !== 'started') return
    expect((await h.loop.runEnded({ runId: sent.runId })).reason).toEqual({ code: 'completed' })
    expect(resolutions(await all(h))).toEqual(['cancelled-by-stop/stop'])
  })

  it('takes the first of two allows that arrive together, with no storage conflict (02 不变量 27)', async () => {
    const h = harness()
    const requestId = await paused(h)
    h.provider.script(done())
    const answers = await Promise.all([
      answer(h, requestId, 'allow'),
      answer(h, requestId, 'allow'),
    ])
    expect(answers).toEqual([{ status: 'applied' }, { status: 'already-resolved' }])
    await h.loop.runEnded()
    expect(resolutions(await all(h))).toEqual(['allowed/card'])
    expect(h.executed).toEqual([{ at: 'a' }])
  })

  it('keeps a card however far the clock moves: nothing here expires (02 不变量 28)', async () => {
    const h = harness()
    const requestId = await paused(h)
    h.memory.advance(400 * 24 * 60 * 60 * 1000)
    expect(await h.service.currentPending({ sessionId: SESSION })).not.toBeNull()
    h.provider.script(done())
    expect(await answer(h, requestId, 'allow')).toEqual({ status: 'applied' })
  })

  it('answers not-found for a session it knows nothing of', async () => {
    const h = harness()
    const requestId = await paused(h)
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: '8d5f9a2e-6b3d-4a71-9f52-0c8de7a11b38',
        requestId,
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'not-found' })
  })
})
