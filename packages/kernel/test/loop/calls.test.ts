/**
 * A redrawn row's calls (spec 02 01 修补 6「session.messages 与内容块」, §调用的键与读写的数据, §最小审批卡
 * 「答完」; plan step 20: 旧 125 for `calls[i].outcome`, 旧 214's last clause, 验收 36's collapsed row):
 * `listMessages` and `latestSession` hand each assistant row `calls[i]` for its i-th `tool-request`
 * block — the call's key, and its closed outcome in the shape the live `tool-outcome` carried, or null
 * while it has none. An answered card is part of that outcome (`approval`), and it is what redraws the
 * collapsed row after a restart.
 *
 * Every Tape entry here comes from a real Run: the scripted provider asks for the calls, the loop
 * judges, pauses, answers and closes them. The live view each redraw is compared with is the
 * `tool-outcome` event the same Run sent. The last block is plan step 10's 旧 141 in the loop: what
 * a call whose arguments fail validation writes, and what it does not.
 */
import { describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type {
  AbsolutePath,
  McpConnection,
  McpToolSource,
  MemoryHost,
  ModelInfo,
  PendingApproval,
  RowCall,
  SessionEvent,
  SessionMessageRow,
  SessionService,
  StreamEvent,
  TapeStore,
  ToolOutcomeView,
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
import type { FakeInspector, ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'
import { MODEL_NOTES } from '../../src/prompts/index.js'
import { EDIT_SAME_STRINGS } from '../../src/tools/builtin/edit.js'
import { LOOK, lookSource, pendingCard } from './support.js'

const IDENTITY = { userId: 'calls-user', tenantId: 'calls-tenant', profileDir: '/tenon/calls' }
const SESSION = '5b2e9a2e-6b3d-4a71-9f52-0c8de7a11c01'
const DEDICATED = absolutePath(`/home/u/Tenon/workspaces/calls-user/calls-tenant/${SESSION}`)

const MODEL: ModelInfo = {
  id: 'claude-calls-1',
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
  inputTokens: 7,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

const ASK = { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] } as const

/** The members `ToolOutcomeView` declares; a view carrying anything else leaks a Tape field. */
const VIEW_KEYS = new Set([
  'effect',
  'state',
  'source',
  'facts',
  'output',
  'permission',
  'approval',
  'question',
  'handoff',
])

interface Harness {
  readonly memory: MemoryHost
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  readonly inspector: FakeInspector
  readonly executed: Record<string, unknown>[]
}

function harness(
  o: {
    readonly store?: TapeStore
    readonly idsFrom?: number
    readonly during?: (args: Record<string, unknown>) => void | Promise<void>
    /** More connector servers, next to `fs`. */
    readonly sources?: readonly McpToolSource[]
  } = {},
): Harness {
  const memory = createMemoryHost({ identity: IDENTITY })
  const store = o.store ?? createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  const executed: Record<string, unknown>[] = []
  const inspector = createFakeInspector({ id: 'asker', ceiling: 'ask' })
  const loop = createTestLoopPorts({
    connector: {
      provider,
      model: MODEL,
      mcpSources: [lookSource(executed, o.during), ...(o.sources ?? [])],
    },
  })
  const service = createTestSessionService(
    {
      host: memory,
      tape: store,
      ids: createCounterIds({ start: o.idsFrom ?? 1 }),
      inspectors: [inspector.registration],
      connector: loop.connector,
      protectedFiles: [],
    },
    // `look` is always-allowed by the user: without the inspector's opinion it runs.
    { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }) },
  )
  service.bindLoop(loop)
  return { memory, store, service, loop, provider, inspector, executed }
}

/** The session in the task profile, with one picked folder. */
async function cowork(h: Harness, folder: AbsolutePath): Promise<void> {
  await h.service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
  const set = await h.service.setWorkspace({
    sessionId: SESSION,
    change: { kind: 'add', folders: [folder] },
    dedicated: DEDICATED,
  })
  expect(set).toMatchObject({ ok: true })
}

type Call = { readonly name: string; readonly input: Record<string, unknown> }

const look = (at: string): Call => ({ name: LOOK, input: { at } })

/** One reply asking for these calls, in order. */
function reply(...calls: readonly Call[]): StreamEvent[] {
  const events: StreamEvent[] = []
  calls.forEach((call, i) => {
    const id = `toolu_${String(i)}_${call.name}`
    events.push(
      { type: 'tool-call-start', index: i + 1, id, name: call.name },
      { type: 'tool-call-end', index: i + 1, id, name: call.name, input: call.input },
    )
  })
  events.push({ type: 'usage', usage: USAGE }, stopEvent('tool-use', 'tool_use'))
  return events
}

const done = (): StreamEvent[] => scriptedTurn({ deltas: ['Done.'], usage: USAGE })

async function send(h: Harness, text: string): Promise<{ runId: string; code: string }> {
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  const ended = await h.loop.runEnded({ runId: sent.runId })
  return { runId: sent.runId, code: ended.reason.code }
}

async function card(h: Harness): Promise<PendingApproval> {
  const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (pending === null) throw new Error('no card')
  return pending
}

async function answer(
  h: Harness,
  pending: PendingApproval,
  decision: 'allow' | 'deny',
): Promise<void> {
  const answered = await h.service.answer({
    kind: 'approval',
    sessionId: SESSION,
    requestId: pending.card.requestId,
    decision,
    origin: null,
  })
  expect(answered).toEqual({ status: 'applied' })
  await h.loop.runEnded()
}

/** The live `tool-outcome` view of each call, by `callKey`, as the Runs sent them. */
function live(h: Harness): Map<string, ToolOutcomeView> {
  const views = new Map<string, ToolOutcomeView>()
  for (const event of h.loop.recorded) {
    if (event.type === 'tool-outcome') views.set(event.callKey, event.outcome)
  }
  return views
}

function toolRequests(row: SessionMessageRow): number {
  return row.content.filter((block) => block.type === 'tool-request').length
}

/** The assistant rows that asked for calls, oldest first. */
async function callRows(service: SessionService): Promise<SessionMessageRow[]> {
  const rows = await service.listMessages({ sessionId: SESSION, limit: 100 })
  return rows.filter((row) => toolRequests(row) > 0)
}

async function onlyCalls(service: SessionService): Promise<readonly RowCall[]> {
  const rows = await callRows(service)
  expect(rows).toHaveLength(1)
  return rows[0]?.calls ?? []
}

function outcomeOf(calls: readonly RowCall[], i: number): ToolOutcomeView {
  const outcome = calls[i]?.outcome
  if (outcome === null || outcome === undefined) throw new Error(`call ${String(i)} has no outcome`)
  return outcome
}

/**
 * A view without its `approval`, for the one closure whose live event does not carry it: an allowed
 * call runs in the answer's Run, whose `tool-outcome` is the execution's, not the answer's — live, the
 * collapsed row comes from the card's own data (§最小审批卡「答完」). Every closure an answer, a new
 * message or a stop writes carries it live as the redraw does (mailbox.ts emitClosures).
 */
function withoutAnswer(view: ToolOutcomeView | undefined): Omit<ToolOutcomeView, 'approval'> {
  if (view === undefined) throw new Error('no view')
  const { approval: _answered, ...rest } = view
  return rest
}

function runStarted(recorded: readonly SessionEvent[]): string[] {
  return recorded.flatMap((event) => (event.type === 'run-started' ? [event.runId] : []))
}

describe('calls on a redrawn row (01 修补 6)', () => {
  it('gives each tool-request block its key and its outcome, and null until it has one', async () => {
    const h = harness()
    // look runs; the chat profile's Read of a file that is not its own spill is protected; WebFetch
    // asks in the manual mode, so the Run pauses there with the last look still to come.
    h.provider.script(
      reply(
        look('a'),
        { name: 'Read', input: { file_path: '/etc/passwd' } },
        { name: 'WebFetch', input: { url: 'https://example.com/' } },
        look('b'),
      ),
    )
    const { runId, code } = await send(h, 'go')
    expect(code).toBe('paused')

    const rows = await callRows(h.service)
    expect(rows).toHaveLength(1)
    const [row] = rows
    const calls = row?.calls ?? []
    // One entry per tool-request block, in block order, keyed `<runId>:<requestSeq>:<i>`.
    expect(calls.map((call) => call.callKey)).toEqual([0, 1, 2, 3].map((i) => `${runId}:1:${i}`))
    expect(calls).toHaveLength(toolRequests(row as SessionMessageRow))
    // The paused call and the one queued behind it have no outcome yet.
    expect(calls.map((call) => call.outcome === null)).toEqual([false, false, true, true])

    // What ran and what was blocked read back exactly as the live view showed them.
    const views = live(h)
    expect(outcomeOf(calls, 0)).toEqual(views.get(`${runId}:1:0`))
    expect(outcomeOf(calls, 1)).toEqual(views.get(`${runId}:1:1`))
    expect(outcomeOf(calls, 0)).toMatchObject({
      state: 'completed',
      source: null,
      output: 'looked at a',
      permission: { verdict: 'allow' },
    })
    expect(outcomeOf(calls, 1)).toMatchObject({
      effect: 'blocked',
      state: 'not-run',
      source: 'protected',
      facts: { toolName: 'Read', target: '/etc/passwd' },
      permission: { verdict: 'deny', code: 'protected' },
    })
    // Neither had a card, so neither has an answer.
    expect(outcomeOf(calls, 0).approval).toBeUndefined()
    expect(outcomeOf(calls, 1).approval).toBeUndefined()
  })

  it('shows a call in flight as having no outcome, and its result once it is closed', async () => {
    const seen: { h: Harness | null; during: readonly RowCall[] | null } = { h: null, during: null }
    const h = harness({
      during: async () => {
        if (seen.h !== null) seen.during = await onlyCalls(seen.h.service)
      },
    })
    seen.h = h
    h.provider.script(reply(look('a')))
    h.provider.script(done())
    expect((await send(h, 'go')).code).toBe('completed')
    expect(seen.during?.map((call) => call.outcome)).toEqual([null])
    expect(outcomeOf(await onlyCalls(h.service), 0).state).toBe('completed')
  })

  it('keeps each request’s calls on its own row within one Run', async () => {
    const h = harness()
    h.provider.script(reply(look('a')))
    h.provider.script(reply(look('b'), look('c')))
    h.provider.script(done())
    const { runId, code } = await send(h, 'go')
    expect(code).toBe('completed')
    const rows = await callRows(h.service)
    expect(rows.map((row) => row.calls?.map((call) => call.callKey))).toEqual([
      [`${runId}:1:0`],
      [`${runId}:2:0`, `${runId}:2:1`],
    ])
    expect(rows.flatMap((row) => (row.calls ?? []).map((call) => call.outcome?.output))).toEqual([
      'looked at a',
      'looked at b',
      'looked at c',
    ])
    // Rows without tool-request blocks carry no calls at all, not an empty list.
    const all = await h.service.listMessages({ sessionId: SESSION, limit: 100 })
    const bare = all.filter((row) => toolRequests(row) === 0)
    expect(bare.map((row) => row.role)).toEqual(['user', 'assistant'])
    for (const row of bare) expect('calls' in row).toBe(false)
  })

  it('redraws an allowed-once card from calls: the answer, its scope and the card’s target (旧 214)', async () => {
    const h = harness()
    h.inspector.answer(ASK)
    h.provider.script(reply(look('a')))
    expect((await send(h, 'go')).code).toBe('paused')
    const pending = await card(h)
    expect(pending.allowScope).toBe('once')
    h.inspector.answer({ kind: 'none' })
    h.provider.script(done())
    await answer(h, pending, 'allow')

    const calls = await onlyCalls(h.service)
    expect(calls.map((call) => call.callKey)).toEqual([pending.callKey])
    const outcome = outcomeOf(calls, 0)
    expect(outcome.approval).toEqual({
      outcome: 'allowed',
      scope: pending.allowScope,
      target: pending.card.target,
    })
    expect(outcome).toMatchObject({ state: 'completed', source: null, output: 'looked at a' })
    // Everything else is what the live view showed (live, the collapsed row comes from the card).
    expect(withoutAnswer(outcome)).toEqual(withoutAnswer(live(h).get(pending.callKey)))
    // What the card asked about is the decision the summary crosses as: an ask.
    expect(outcome.permission?.verdict).toBe('ask')
  })

  it('redraws an allowed-for-the-session card with scope session', async () => {
    const h = harness()
    h.provider.script(reply({ name: 'WebFetch', input: { url: 'https://example.com/' } }))
    expect((await send(h, 'fetch it')).code).toBe('paused')
    const pending = await card(h)
    expect(pending.allowScope).toBe('session')
    h.provider.script(done())
    await answer(h, pending, 'allow')
    const outcome = outcomeOf(await onlyCalls(h.service), 0)
    expect(outcome.approval).toEqual({
      outcome: 'allowed',
      scope: 'session',
      target: pending.card.target,
    })
    expect(outcome.state).toBe('completed')
  })

  it('redraws a denied card with no scope, and the batch behind it as not run', async () => {
    const h = harness()
    h.inspector.answer(ASK)
    h.provider.script(reply(look('a'), look('b')))
    expect((await send(h, 'go')).code).toBe('paused')
    const pending = await card(h)
    await answer(h, pending, 'deny')
    expect(h.executed).toEqual([])

    const calls = await onlyCalls(h.service)
    const denied = outcomeOf(calls, 0)
    expect(denied).toMatchObject({
      effect: 'blocked',
      state: 'not-run',
      source: 'user-rejected',
      output: MODEL_NOTES.closure['user-rejected']['not-run'],
      approval: { outcome: 'denied', scope: null, target: pending.card.target },
      permission: { verdict: 'ask' },
    })
    // Live, the answer's closure carried the same view, the answer included.
    expect(denied).toEqual(live(h).get(pending.callKey))
    // Never judged, never shown: no decision to summarise, no card to redraw.
    expect(outcomeOf(calls, 1)).toEqual({
      effect: 'blocked',
      state: 'not-run',
      source: 'user-rejected',
      output: MODEL_NOTES.closure['user-rejected']['not-run'],
    })
    expect(outcomeOf(calls, 1)).toEqual(live(h).get(calls[1]?.callKey ?? ''))
  })

  // §调用的键与读写的数据: `permission` is absent only on a call with no decision fact, and this one
  // has one (its ask); §最小审批卡「答完」: the answer is the row's too. Live and redrawn, the same.
  it('sends the denied call live as the redraw has it: its decision summary and its answer', async () => {
    const h = harness()
    h.inspector.answer(ASK)
    h.provider.script(reply(look('a')))
    expect((await send(h, 'go')).code).toBe('paused')
    const pending = await card(h)
    await answer(h, pending, 'deny')
    const redrawn = outcomeOf(await onlyCalls(h.service), 0)
    expect(redrawn.permission?.verdict).toBe('ask')
    expect(redrawn.approval).toEqual({
      outcome: 'denied',
      scope: null,
      target: pending.card.target,
    })
    expect(live(h).get(pending.callKey)).toEqual(redrawn)
  })

  it('redraws a task’s outside-workspace Read by its real path, under the row it hangs on (旧 214)', async () => {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const before = harness({ store })
    // The workspace root is picked through a link; the file read sits beside it, outside.
    await before.memory.fs.mkdirp(absolutePath('/work/project'))
    await before.memory.fs.writeFile(absolutePath('/work/notes.txt'), 'notes')
    before.memory.symlink(absolutePath('/link'), '/work')
    await cowork(before, absolutePath('/link/project'))
    before.provider.script(reply({ name: 'Read', input: { file_path: '/link/notes.txt' } }))
    expect((await send(before, 'read the notes')).code).toBe('paused')
    const pending = await card(before)
    // The card hangs on the call's own row, names the real path, and holds once.
    expect(pending.anchorCallKey).toBe(pending.callKey)
    expect(pending.card.reason).toBe('outside-workspace')
    expect(pending.card.target).toEqual({ type: 'path', path: '/work/notes.txt' })
    expect(pending.card.facts).toMatchObject({ workspace: '/work/project' })
    expect(pending.allowScope).toBe('once')
    const [row] = await callRows(before.service)
    expect(row?.calls?.map((call) => call.callKey)).toEqual([pending.callKey])
    expect(row?.calls?.[0]?.outcome).toBeNull()
    before.provider.script(done())
    await answer(before, pending, 'allow')

    // A restart: a new service on the same store redraws the collapsed row from calls alone.
    const after = harness({ store, idsFrom: 1000 })
    const outcome = outcomeOf(await onlyCalls(after.service), 0)
    expect(outcome.approval).toEqual({
      outcome: 'allowed',
      scope: 'once',
      target: { type: 'path', path: '/work/notes.txt' },
    })
    expect(outcome).toMatchObject({ effect: 'read', state: 'completed', source: null })
  })

  it('reads the same calls back after a restart: a new service on the same store (旧 214)', async () => {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const before = harness({ store })
    before.inspector.answer(ASK)
    before.provider.script(reply(look('a'), { name: 'Read', input: { file_path: '/etc/hosts' } }))
    expect((await send(before, 'go')).code).toBe('paused')
    const pending = await card(before)
    before.inspector.answer({ kind: 'none' })
    before.provider.script(done())
    await answer(before, pending, 'allow')
    const beforeRows = await callRows(before.service)

    const after = harness({ store, idsFrom: 1000 })
    const afterRows = await callRows(after.service)
    expect(afterRows).toEqual(beforeRows)
    expect(afterRows[0]?.calls?.[0]?.outcome?.approval).toEqual({
      outcome: 'allowed',
      scope: 'once',
      target: pending.card.target,
    })
    // latestSession opens on the same rows, calls and all.
    const latest = await after.service.latestSession({ limit: 100 })
    expect(latest?.sessionId).toBe(SESSION)
    expect(latest?.messages.filter((row) => toolRequests(row) > 0)).toEqual(beforeRows)
    // A page that holds only the row with the calls still carries them.
    const all = await after.service.listMessages({ sessionId: SESSION, limit: 100 })
    const at = all.findIndex((row) => toolRequests(row) > 0)
    const page = await after.service.listMessages({
      sessionId: SESSION,
      limit: 1,
      afterOrderSeq: all[at - 1]?.orderSeq ?? 0,
    })
    expect(page).toEqual([beforeRows[0]])
  })

  it('keeps calls[i] on the i-th block when a call is malformed or names no tool it has', async () => {
    const h = harness()
    h.provider.script(
      reply(
        look('a'),
        { name: 'Read', input: {} },
        { name: 'NoSuchTool', input: { x: 1 } },
        look('b'),
      ),
    )
    h.provider.script(done())
    const { runId } = await send(h, 'go')
    const [row] = await callRows(h.service)
    const blocks = (row?.content ?? []).flatMap((block) =>
      block.type === 'tool-request' ? [block.name] : [],
    )
    expect(blocks).toEqual([LOOK, 'Read', 'NoSuchTool', LOOK])
    const calls = row?.calls ?? []
    expect(calls.map((call) => call.callKey)).toEqual([0, 1, 2, 3].map((i) => `${runId}:1:${i}`))
    expect(calls.map((call) => [call.outcome?.state, call.outcome?.source])).toEqual([
      ['completed', null],
      ['not-run', 'invalid-input'],
      ['not-run', 'tool-unavailable'],
      ['completed', null],
    ])
    expect(calls.map((call) => call.outcome?.output)).toEqual([
      'looked at a',
      live(h).get(`${runId}:1:1`)?.output,
      live(h).get(`${runId}:1:2`)?.output,
      'looked at b',
    ])
  })

  it('redraws a card the re-judgement denied: the decision in force, and the card it answered', async () => {
    const h = harness()
    h.inspector.answer(ASK)
    h.provider.script(reply(look('a')))
    expect((await send(h, 'go')).code).toBe('paused')
    const pending = await card(h)
    h.memory.setPolicy({
      status: 'current',
      version: 'v2',
      snapshot: { tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'deny' }] },
    })
    h.provider.script(done())
    await answer(h, pending, 'allow')
    const outcome = outcomeOf(await onlyCalls(h.service), 0)
    // The re-judgement's deny is the decision in force, not the ask the card showed.
    expect(outcome).toMatchObject({
      state: 'not-run',
      source: 'policy',
      facts: { toolName: 'look' },
      permission: { verdict: 'deny', code: 'org-policy' },
      approval: { outcome: 'denied-on-rejudge', scope: null, target: pending.card.target },
    })
  })

  /** Paused on a card for `look a`, then a policy that denies it, then 「允许」: denied on re-judgement. */
  async function rejudged(): Promise<{ h: Harness; pending: PendingApproval }> {
    const h = harness()
    h.inspector.answer(ASK)
    h.provider.script(reply(look('a')))
    expect((await send(h, 'go')).code).toBe('paused')
    const pending = await card(h)
    h.memory.setPolicy({
      status: 'current',
      version: 'v2',
      snapshot: { tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'deny' }] },
    })
    h.provider.script(done())
    await answer(h, pending, 'allow')
    return { h, pending }
  }

  // `denied-on-rejudge` shows a BlockedNotice (§最小审批卡「答完」), which reads its slots from
  // `tool-outcome.facts` (§界面范围 BlockedNotice); facts are there on every block code (01 修补 6
  // toolOutcomeViewShape). Live, the answer's closure carries them and the decision in force, as the
  // redraw of the same call does.
  it('sends the re-judged denial live as the redraw has it: its block facts and decision', async () => {
    const { h, pending } = await rejudged()
    const redrawn = outcomeOf(await onlyCalls(h.service), 0)
    expect(live(h).get(pending.callKey)).toMatchObject({ source: 'policy', facts: redrawn.facts })
    expect(withoutAnswer(live(h).get(pending.callKey))).toEqual(withoutAnswer(redrawn))
  })

  // BUG(step20): the re-judged denial is closed in the facts the answer's resume Run opens with, and
  // mailbox.ts announces them with `emitClosures(ports, box, sessionId, facts)` (openResumeRun, no
  // `waiting`): the target lookup `resolution.decisionKey === waiting?.decisionKey` misses and falls
  // back to the re-judgement's own decision, which has no `confirm`, so the live `tool-outcome` drops
  // `approval` while the redraw has `{ outcome: 'denied-on-rejudge', … }`. emitClosures' contract
  // (「the answer this batch resolved, so the answered row reads the same live and after a restart」)
  // and 01 修补 6 (`calls[i].outcome` is the live `tool-outcome`'s shape) want them equal. No visible
  // effect in 02: ToolRow draws no collapsed row for `denied-on-rejudge` (§最小审批卡「答完」).
  // oxlint-disable-next-line vitest/no-disabled-tests -- BUG(step20) above: kept, red until fixed

  // The answer's own closure names the card it answered, as the redraw does (plan step 20).
  it('sends the re-judged denial’s answer live too, as the redraw has it', async () => {
    const { h, pending } = await rejudged()
    const redrawn = outcomeOf(await onlyCalls(h.service), 0)
    expect(redrawn.approval).toMatchObject({ outcome: 'denied-on-rejudge' })
    expect(live(h).get(pending.callKey)).toEqual(redrawn)
  })

  it('redraws a card a new message superseded, and one a stop cancelled', async () => {
    const superseded = harness()
    superseded.inspector.answer(ASK)
    superseded.provider.script(reply(look('a')))
    expect((await send(superseded, 'go')).code).toBe('paused')
    const first = await card(superseded)
    superseded.inspector.answer({ kind: 'none' })
    superseded.provider.script(done())
    await send(superseded, 'never mind, do this')
    const supersededView = outcomeOf(await onlyCalls(superseded.service), 0)
    expect(supersededView).toMatchObject({
      state: 'not-run',
      source: 'superseded',
      approval: { outcome: 'superseded', scope: null, target: first.card.target },
    })
    // The new message's own closure of the call, live: the same view, the answer included.
    expect(live(superseded).get(first.callKey)).toEqual(supersededView)

    const stopped = harness()
    stopped.inspector.answer(ASK)
    stopped.provider.script(reply(look('a')))
    expect((await send(stopped, 'go')).code).toBe('paused')
    const second = await card(stopped)
    expect(await stopped.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    const stoppedView = outcomeOf(await onlyCalls(stopped.service), 0)
    expect(stoppedView).toMatchObject({
      state: 'not-run',
      source: 'stopped',
      approval: { outcome: 'cancelled-by-stop', scope: null, target: second.card.target },
    })
    expect(live(stopped).get(second.callKey)).toEqual(stoppedView)
  })

  it('crosses a decision as its summary only: verdict, code and facts (旧 125)', async () => {
    const h = harness()
    h.inspector.answer(ASK)
    h.provider.script(
      reply(look('a'), look('b'), { name: 'Read', input: { file_path: '/etc/passwd' } }),
    )
    expect((await send(h, 'go')).code).toBe('paused')
    const first = await card(h)
    h.inspector.answer({ kind: 'none' })
    h.provider.script(done())
    await answer(h, first, 'allow')
    expect(runStarted(h.loop.recorded)).toHaveLength(2)

    const outcomes = (await onlyCalls(h.service)).map((call) => call.outcome)
    const summaries = outcomes.flatMap((outcome) =>
      outcome?.permission === undefined ? [] : [outcome.permission],
    )
    // look a (asked, allowed), look b (allowed), Read (protected): three decisions, three summaries.
    expect(summaries.map((summary) => summary.verdict)).toEqual(['ask', 'allow', 'deny'])
    for (const summary of summaries) {
      expect(Object.keys(summary).toSorted()).toEqual(['code', 'facts', 'verdict'])
    }
    for (const outcome of outcomes) {
      for (const key of Object.keys(outcome ?? {})) expect(VIEW_KEYS.has(key)).toBe(true)
    }
  })
})

describe('arguments that fail validation, in the loop (旧 141; 旧 124: no decision)', () => {
  it('closes each call blocked / not-run with the reason second: no decision, dispatch or card', async () => {
    const ran: string[] = []
    // A connector with a required argument, and one whose schema no validator can use.
    const connection = {
      listTools: () =>
        Promise.resolve([
          {
            name: 'echo',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
          {
            name: 'broken',
            inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '(' } } },
          },
        ]),
      callTool: (name: string) => {
        ran.push(name)
        return Promise.resolve({ content: [{ type: 'text', text: 'ran' }], isError: false })
      },
    } as unknown as McpConnection
    const h = harness({ sources: [{ serverId: 'fix', connection }] })
    await cowork(h, absolutePath('/work'))
    const header13 = '一二三四五六七八九十一二三'
    h.provider.script(
      reply(
        { name: 'Bash', input: { command: 'ls', timeout: 600_001 } },
        { name: 'Write', input: { file_path: 'relative.txt', content: 'x' } },
        { name: 'Edit', input: { file_path: '/work/a.txt', old_string: 'a', new_string: 'a' } },
        {
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which one?',
                header: header13,
                options: [
                  { label: 'A', description: 'a' },
                  { label: 'B', description: 'b' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
        { name: 'fix__echo', input: {} },
        { name: 'fix__broken', input: { id: 'x' } },
      ),
    )
    h.provider.script(done())
    expect((await send(h, 'go')).code).toBe('completed')
    const entries = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    const named = (name: string) => entries.filter((entry) => entry.name === name)
    // Nothing was judged, dispatched, shown or run.
    expect(named('tool/permission_decided')).toEqual([])
    expect(named('execution/dispatch_committed')).toEqual([])
    expect(h.memory.confirmRequests).toEqual([])
    expect(ran).toEqual([])
    expect(
      named('execution/tool_outcome').map((entry) => [
        entry.payload['effect'],
        entry.payload['state'],
        entry.payload['source'],
      ]),
    ).toEqual([
      ...Array.from({ length: 5 }, () => ['blocked', 'not-run', 'invalid-input']),
      ['blocked', 'not-run', 'tool-unavailable'],
    ])
    const results = named('tool/result').map(
      (entry) => entry.payload as { isError: boolean; content: { type: string; text: string }[] },
    )
    expect(results.every((result) => result.isError && result.content.length === 2)).toBe(true)
    expect(results.map((result) => result.content[0]?.text)).toEqual([
      ...Array.from({ length: 5 }, () => MODEL_NOTES.closure['invalid-input']['not-run']),
      MODEL_NOTES.closure['tool-unavailable']['not-run'],
    ])
    // The second block is why: the validator's message, the tool's own check, the unusable schema.
    const reasons = results.map((result) => result.content[1]?.text ?? '')
    expect(reasons[0]).toMatch(/timeout/)
    expect(reasons[1]).toMatch(/absolute/i)
    expect(reasons[2]).toBe(EDIT_SAME_STRINGS)
    expect(reasons[3]).toMatch(/header/)
    expect(reasons[4]).toMatch(/message/)
    expect(reasons[5]).toBe(MODEL_NOTES.schemaUnusable)
  })
})
