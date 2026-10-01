import type * as DecideModule from '../../src/permission/decide.js'
/**
 * The parallel group of workspace reads (spec 02 §一批工具怎么执行, §执行日志与恢复表 T1,
 * §点停止时各状态怎么收; invariant 13; plan step 24: 旧 23, 旧 126, 验收 44).
 *
 * Every call runs through a real Run on the memory host and its manual clock. Every executor a batch
 * picks is wrapped (a module mock of `executorFor`) to record its execution interval and, while
 * `rec.holding`, to wait until the case releases it — so a case decides which call ends first. Read,
 * Glob, Grep and Write are the real executors; WebSearch, WebFetch and Bash are the test registry's
 * fakes (WebSearch and WebFetch have no executor yet); `fs__look` is a connector tool the user always
 * allows. The host's clock tells `hook.onNow` of each reading, so a case can land a stop at the moment
 * the kernel stamps a fact.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type {
  InspectorRegistration,
  MemoryHost,
  ModelInfo,
  SearchBackend,
  SessionEvent,
  SessionService,
  StreamEvent,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import { STOP_WRITE_WAIT_MS } from '../../src/loop/limits.js'
import type * as ExecutorModule from '../../src/tools/executor.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type { ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'
import { LOOK, lookSource, pendingCard } from './support.js'

// ----- the recorder ------------------------------------------------------------------------------

const rec = vi.hoisted(() => {
  interface Execution {
    readonly label: string
    readonly start: number
    end: number | null
    readonly release: () => void
  }
  return {
    /** While true, each execution waits for its `release` before its executor runs. */
    holding: false,
    serial: false,
    tick: 0,
    executions: [] as Execution[],
    /** A call as the cases name it: the tool and what it acts on. */
    label(name: string, input: Record<string, unknown>): string {
      const what =
        input['file_path'] ??
        input['pattern'] ??
        input['query'] ??
        input['url'] ??
        input['command'] ??
        input['at']
      return `${name} ${String(what)}`
    },
  }
})

vi.mock('../../src/tools/executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExecutorModule>()
  return {
    ...actual,
    executorFor: (
      q: Parameters<typeof actual.executorFor>[0],
    ): ReturnType<typeof actual.executorFor> => {
      const executor = actual.executorFor(q)
      if (executor === null) return null
      return async (e) => {
        const gate = Promise.withResolvers<void>()
        const execution = {
          label: rec.label(e.item.originalName, e.input),
          start: (rec.tick += 1),
          end: null as number | null,
          release: () => gate.resolve(),
        }
        rec.executions.push(execution)
        if (rec.holding) await gate.promise
        try {
          return await executor(e)
        } finally {
          execution.end = rec.tick += 1
        }
      }
    },
  }
})

// Exercise the real serial batch branch without changing the permission verdict or tool table.
vi.mock('../../src/permission/decide.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DecideModule>()
  return {
    ...actual,
    canRunInParallel: (...args: Parameters<typeof actual.canRunInParallel>) =>
      !rec.serial && actual.canRunInParallel(...args),
  }
})

/** Called on every reading of the host clock, before it answers. */
const hook: { onNow?: () => void } = {}

beforeEach(() => {
  rec.holding = false
  rec.serial = false
  rec.tick = 0
  rec.executions.length = 0
  delete hook.onNow
})

// ----- the harness -------------------------------------------------------------------------------

const PROFILE = '/tenon/group'
const IDENTITY = { userId: 'group-user', tenantId: 'group-tenant', profileDir: PROFILE }
const SESSION = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d'
const DEDICATED = absolutePath(`/home/u/Tenon/workspaces/group-user/group-tenant/${SESSION}`)
const WORK = absolutePath('/work/project')
const A = `${WORK}/a.md`
const B = `${WORK}/b.md`
const C = `${WORK}/c.md`
const D = `${WORK}/d.md`
const OWN_SPILL = `${PROFILE}/tool-output/${SESSION}`
const SPILLED_1 = `${OWN_SPILL}/r-1-0.txt`
const SPILLED_2 = `${OWN_SPILL}/r-1-1.txt`

const FILES: Readonly<Record<string, string>> = {
  [A]: 'a\n',
  [B]: 'b\n',
  [D]: 'd\n',
  [SPILLED_1]: 'spilled one\n',
  [SPILLED_2]: 'spilled two\n',
}

const MODEL: ModelInfo = {
  id: 'claude-group-1',
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
  inputTokens: 5,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

const SEARCH: SearchBackend = {
  host: 'open.bigmodel.cn',
  domainFilter: false,
  prepareQuery: (query) => ({ query, truncated: false }),
  search: () => Promise.resolve({ ok: true, hits: [] }),
}

interface Harness {
  readonly memory: MemoryHost
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  readonly logs: string[]
}

async function harness(
  profile: 'chat' | 'cowork' = 'cowork',
  inspectors: readonly InspectorRegistration[] = [],
): Promise<Harness> {
  const memory = createMemoryHost({ identity: IDENTITY, now: 1_000_000 })
  await memory.fs.mkdirp(WORK)
  await memory.fs.mkdirp(absolutePath(OWN_SPILL))
  for (const [path, text] of Object.entries(FILES)) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    await memory.fs.writeFile(absolutePath(path), text)
  }
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({
    connector: { provider, model: MODEL, search: SEARCH, mcpSources: [lookSource([])] },
  })
  const logs: string[] = []
  const clock = {
    now: () => {
      hook.onNow?.()
      return memory.clock.now()
    },
    setTimeout: (fn: () => void, ms: number) => memory.clock.setTimeout(fn, ms),
  }
  const service = createTestSessionService(
    {
      host: { ...memory, clock },
      tape: store,
      ids: createCounterIds(),
      inspectors: [...inspectors],
      connector: loop.connector,
      protectedFiles: [],
      log: (line) => logs.push(line),
    },
    {
      tools: { Read: 'real', Glob: 'real', Grep: 'real', Write: 'real' },
      userSetting: (key) => (key.serverId === 'fs' ? { userSetting: 'always-allow' } : null),
    },
  )
  service.bindLoop(loop)
  if (profile === 'cowork') {
    await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
    await service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [WORK] },
      dedicated: DEDICATED,
    })
  }
  return { memory, store, service, loop, provider, logs }
}

/** Lets every promise the Run has in flight settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Settles a few turns in a row: whatever the kernel would start now, it has. */
async function quiet(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn at a time
    await settle()
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 500; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polled one settle at a time
    if (await check()) return
    // oxlint-disable-next-line no-await-in-loop -- polled one settle at a time
    await settle()
  }
  throw new Error(`never: ${what}`)
}

let nextCall = 1

type Call = readonly [name: string, input: Record<string, unknown>]

/** A reply asking for these calls, then its usage and a tool-use stop. */
function callsOf(calls: readonly Call[]): StreamEvent[] {
  return [
    ...calls.flatMap(([name, input], k): StreamEvent[] => {
      const id = `toolu_${String(nextCall++)}`
      return [
        { type: 'tool-call-start', index: k + 1, id, name },
        { type: 'tool-call-end', index: k + 1, id, name, input },
      ]
    }),
    { type: 'usage', usage: USAGE },
    stopEvent('tool-use', 'tool_use'),
  ]
}

const done = (): StreamEvent[] => scriptedTurn({ deltas: ['Done.'], usage: USAGE })

/** Sends a message whose reply asks for the calls, and a plain reply after; the Run's id. */
async function send(h: Harness, calls: readonly Call[]): Promise<string> {
  h.provider.script(callsOf(calls))
  h.provider.script(done())
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'go' })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return sent.runId
}

type RunEnded = Extract<SessionEvent, { type: 'run-ended' }>

/** The Run's end, polled: a Run that never ends fails the case instead of timing it out. */
async function ended(h: Harness, runId?: string): Promise<RunEnded> {
  const seen: { event: RunEnded | null } = { event: null }
  void h.loop.runEnded(runId === undefined ? {} : { runId }).then((event) => {
    seen.event = event
  })
  await until(() => seen.event !== null, `the Run ${runId ?? ''} ended`)
  return seen.event as RunEnded
}

/** Runs the Run to its end, each time the kernel is quiet releasing every execution in flight. */
async function drive(h: Harness, runId?: string): Promise<RunEnded> {
  const seen: { event: RunEnded | null } = { event: null }
  void h.loop.runEnded(runId === undefined ? {} : { runId }).then((event) => {
    seen.event = event
  })
  for (let turns = 0; seen.event === null; turns += 1) {
    if (turns > 100) throw new Error('the Run never ended')
    // oxlint-disable-next-line no-await-in-loop -- released only once the kernel started all it would
    await quiet()
    for (const execution of rec.executions) if (execution.end === null) execution.release()
  }
  return seen.event
}

function release(label: string): void {
  const execution = rec.executions.find((candidate) => candidate.label === label)
  if (execution === undefined) throw new Error(`${label} never started`)
  execution.release()
}

function finished(label: string): boolean {
  return rec.executions.find((candidate) => candidate.label === label)?.end != null
}

/** Every pair of executions whose intervals overlap, by label. */
function overlapping(): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  const all = rec.executions
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const x = all[i]
      const y = all[j]
      if (x === undefined || y === undefined) continue
      if (x.start < (y.end ?? Infinity) && y.start < (x.end ?? Infinity)) {
        pairs.push([x.label, y.label])
      }
    }
  }
  return pairs
}

async function entries(h: Harness): Promise<TapeEntry[]> {
  return (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}

async function named(h: Harness, name: string): Promise<TapeEntry[]> {
  return (await entries(h)).filter((entry) => entry.name === name)
}

/** The calls a fact names, in Tape order. */
async function ordinalsOf(h: Harness, name: string): Promise<number[]> {
  return (await named(h, name)).map(({ payload }) => Number(payload['ordinal']))
}

const CALL_FACTS = new Set([
  'tool/permission_decided',
  'execution/dispatch_committed',
  'tool/result',
  'execution/tool_outcome',
])

/** Each call fact as `<name> <i>`, in Tape order. */
async function callFacts(h: Harness): Promise<string[]> {
  return (await entries(h))
    .filter((entry) => CALL_FACTS.has(entry.name))
    .map((entry) => `${entry.name.split('/')[1] ?? ''} ${String(entry.payload['ordinal'])}`)
}

/** Every closure as `<i> state source effect`, in Tape order. */
async function outcomes(h: Harness): Promise<string[]> {
  return (await named(h, 'execution/tool_outcome')).map(({ payload }) =>
    [payload['ordinal'], payload['state'], payload['source'], payload['effect']].join(' '),
  )
}

/** Every result's text, in Tape order. */
async function resultTexts(h: Harness): Promise<string[]> {
  return (await named(h, 'tool/result')).map(({ payload }) =>
    (payload['content'] as Array<{ text?: string }>).map((block) => block.text ?? '').join(''),
  )
}

async function answer(h: Harness, decision: 'allow' | 'deny'): Promise<void> {
  const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (pending === null) throw new Error('no card')
  expect(
    await h.service.answer({
      kind: 'approval',
      sessionId: SESSION,
      requestId: pending.card.requestId,
      decision,
      origin: null,
    }),
  ).toEqual({ status: 'applied' })
}

const READ_A: Call = ['Read', { file_path: A }]
const READ_B: Call = ['Read', { file_path: B }]
const WRITE_C: Call = ['Write', { file_path: C, content: 'c\n' }]
const READ_D: Call = ['Read', { file_path: D }]

// ----- 旧 23 / 旧 126 --------------------------------------------------------------------------------

describe('「读 a、读 b、写 c、读 d」 (旧 23, 旧 126; 验收 44)', () => {
  /** Sends the batch; b ends first; the Run pauses on c's card. */
  async function pausedOnC(h: Harness): Promise<void> {
    rec.holding = true
    const runId = await send(h, [READ_A, READ_B, WRITE_C, READ_D])
    await until(() => rec.executions.length === 2, 'a and b started')
    await quiet()
    // a and b in parallel: both dispatched before either finishes.
    expect(rec.executions.map(({ label, end }) => [label, end])).toEqual([
      [`Read ${A}`, null],
      [`Read ${B}`, null],
    ])
    expect(await ordinalsOf(h, 'execution/dispatch_committed')).toEqual([0, 1])
    // b finishes first: its result waits for a's.
    release(`Read ${B}`)
    await quiet()
    expect([finished(`Read ${A}`), finished(`Read ${B}`)]).toEqual([false, true])
    expect(await named(h, 'tool/result')).toEqual([])
    release(`Read ${A}`)
    expect((await ended(h, runId)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    // b's decision and dispatch before a's result (T1); the results in call order; c's decision
    // after them, with the pause; d waits behind c's card: nothing written for it yet.
    expect(await callFacts(h)).toEqual([
      'permission_decided 0',
      'dispatch_committed 0',
      'permission_decided 1',
      'dispatch_committed 1',
      'result 0',
      'tool_outcome 0',
      'result 1',
      'tool_outcome 1',
      'permission_decided 2',
    ])
    expect(await resultTexts(h)).toEqual(['1\ta', '1\tb'])
    const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
    expect(pending?.card.target).toEqual({ type: 'path', path: C })
    expect(overlapping()).toEqual([[`Read ${A}`, `Read ${B}`]])
  }

  it('denying c records d not-run, never dispatched; results and outcomes in the order a, b, c, d', async () => {
    const h = await harness()
    await pausedOnC(h)
    await answer(h, 'deny')
    expect((await ended(h)).reason).toEqual({ code: 'user-rejected', toolName: 'Write' })
    expect(await ordinalsOf(h, 'execution/dispatch_committed')).toEqual([0, 1])
    expect(await ordinalsOf(h, 'tool/result')).toEqual([0, 1, 2, 3])
    expect(await outcomes(h)).toEqual([
      '0 completed  read',
      '1 completed  read',
      '2 not-run user-rejected blocked',
      '3 not-run user-rejected blocked',
    ])
    expect(rec.executions.map(({ label }) => label)).toEqual([`Read ${A}`, `Read ${B}`])
    expect(await h.memory.fs.stat(absolutePath(C))).toBeNull()
  })

  it('allowing c runs it, then d after it, one at a time', async () => {
    const h = await harness()
    await pausedOnC(h)
    await answer(h, 'allow')
    expect((await drive(h)).reason).toEqual({ code: 'completed' })
    expect(await callFacts(h)).toEqual([
      'permission_decided 0',
      'dispatch_committed 0',
      'permission_decided 1',
      'dispatch_committed 1',
      'result 0',
      'tool_outcome 0',
      'result 1',
      'tool_outcome 1',
      'permission_decided 2',
      'dispatch_committed 2',
      'result 2',
      'tool_outcome 2',
      'permission_decided 3',
      'dispatch_committed 3',
      'result 3',
      'tool_outcome 3',
    ])
    expect(await outcomes(h)).toEqual([
      '0 completed  read',
      '1 completed  read',
      '2 completed  write',
      '3 completed  read',
    ])
    expect(rec.executions.map(({ label }) => label)).toEqual([
      `Read ${A}`,
      `Read ${B}`,
      `Write ${C}`,
      `Read ${D}`,
    ])
    expect(overlapping()).toEqual([[`Read ${A}`, `Read ${B}`]])
    expect(await h.memory.fs.readFile(absolutePath(C), { encoding: 'utf8' })).toBe('c\n')
  })
})

// ----- invariant 13 ------------------------------------------------------------------------------

describe('02 不变量 13: only the leading Read / Glob / Grep group overlaps (旧 126)', () => {
  /** Answers every card allow until the Run ends otherwise: each answer grants for the session. */
  async function allowEach(h: Harness, runId: string): Promise<void> {
    let end = await ended(h, runId)
    while (end.reason.code === 'paused') {
      // oxlint-disable-next-line no-await-in-loop -- one card at a time
      await answer(h, 'allow')
      // oxlint-disable-next-line no-await-in-loop -- the answer's Run, to its end
      end = await ended(h)
    }
    expect(end.reason).toEqual({ code: 'completed' })
  }

  it('with search, a domain, a command and a file allowed this session, nothing after the cut overlaps', async () => {
    const h = await harness()
    // Allowed this session: the search host, the domain, the command, the file (旧 126).
    await allowEach(
      h,
      await send(h, [
        ['WebSearch', { query: 'setup' }],
        ['WebFetch', { url: 'https://example.com/setup' }],
        ['Bash', { command: 'make' }],
        ['Write', { file_path: C, content: 'setup\n' }],
      ]),
    )
    rec.executions.length = 0
    rec.holding = true
    const before = (await named(h, 'tool/permission_decided')).length
    const runId = await send(h, [
      READ_A,
      ['Grep', { pattern: 'b' }],
      ['Glob', { pattern: '*.md' }],
      ['WebSearch', { query: 'tenon' }],
      ['WebFetch', { url: 'https://example.com/b' }],
      ['Bash', { command: 'make' }],
      WRITE_C,
      [LOOK, { at: 'x' }],
      READ_B,
      ['Glob', { pattern: '**/*.md' }],
      ['Grep', { pattern: 'd' }],
    ])
    expect((await drive(h, runId)).reason).toEqual({ code: 'completed' })
    // No card: every call allowed, every call run.
    const decided = (await named(h, 'tool/permission_decided')).slice(before)
    expect(
      decided.map(({ payload }) => (payload['record'] as { verdict: string }).verdict),
    ).toEqual(Array.from({ length: 11 }, () => 'allow'))
    expect(rec.executions).toHaveLength(11)
    const group = new Set([`Read ${A}`, 'Grep b', 'Glob *.md'])
    // The leading group ran together…
    expect(overlapping().filter(([x, y]) => group.has(x) && group.has(y))).toHaveLength(3)
    // …and nothing else overlapped anything: WebSearch, WebFetch, Bash, Write and the connector
    // tool never in flight together, and no second group after the cut.
    expect(overlapping().filter(([x, y]) => !group.has(x) || !group.has(y))).toEqual([])
  })

  it('forms no group when the first call is a read of the spill, though reads follow it', async () => {
    const h = await harness()
    rec.holding = true
    const runId = await send(h, [['Read', { file_path: SPILLED_1 }], READ_A, READ_B])
    expect((await drive(h, runId)).reason).toEqual({ code: 'completed' })
    expect(await outcomes(h)).toEqual([
      '0 completed  read',
      '1 completed  read',
      '2 completed  read',
    ])
    expect(overlapping()).toEqual([])
  })

  it('forms no group from the rest of a resumed batch whose answered call is judged again and denied', async () => {
    // Tightened while the card waits: the answer's re-judgement denies c (§等待模型), and the Run
    // that resumes starts at a — past the cut, with no approved call, so still one at a time (F6).
    const tightened = { on: false }
    const tightening: InspectorRegistration = {
      id: 'tightening',
      kind: 'local-rule',
      ceiling: 'deny',
      beforeCall: (input) =>
        Promise.resolve(
          tightened.on && input.call.tool.originalName === 'Write'
            ? { kind: 'deny', category: 'exfiltration', findings: [{ code: 'tightened' }] }
            : { kind: 'none' },
        ),
    }
    const h = await harness('cowork', [tightening])
    const runId = await send(h, [WRITE_C, READ_A, READ_B])
    expect((await ended(h, runId)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    tightened.on = true
    rec.holding = true
    await answer(h, 'allow')
    expect((await drive(h)).reason).toEqual({ code: 'completed' })
    expect(await outcomes(h)).toEqual([
      '0 not-run inspector blocked',
      '1 completed  read',
      '2 completed  read',
    ])
    expect(rec.executions.map(({ label }) => label)).toEqual([`Read ${A}`, `Read ${B}`])
    expect(overlapping()).toEqual([])
  })

  it('dispatches consecutive Reads one at a time in the chat profile', async () => {
    const h = await harness('chat')
    rec.holding = true
    const runId = await send(h, [
      ['Read', { file_path: SPILLED_1 }],
      ['Read', { file_path: SPILLED_2 }],
    ])
    await until(() => rec.executions.length === 1, 'the first Read started')
    await quiet()
    expect(rec.executions).toHaveLength(1)
    expect(await ordinalsOf(h, 'execution/dispatch_committed')).toEqual([0])
    expect((await drive(h, runId)).reason).toEqual({ code: 'completed' })
    expect(await callFacts(h)).toEqual([
      'permission_decided 0',
      'dispatch_committed 0',
      'result 0',
      'tool_outcome 0',
      'permission_decided 1',
      'dispatch_committed 1',
      'result 1',
      'tool_outcome 1',
    ])
    expect(overlapping()).toEqual([])
  })
})

// ----- judging the members ------------------------------------------------------------------------

/**
 * An inspector that records, per call, whether its view counted a workspace read as dispatched
 * (`touchedPrivateData`), and never answers for `hangOn` until its signal aborts.
 */
function watcher(
  seen: Array<[string, boolean]>,
  hangOn?: string,
): { readonly registration: InspectorRegistration; readonly reached: Promise<void> } {
  const reached = Promise.withResolvers<void>()
  return {
    registration: {
      id: 'watcher',
      kind: 'local-rule',
      ceiling: 'ask',
      beforeCall: (input, signal) => {
        const label = rec.label(input.call.tool.originalName, input.call.args)
        seen.push([label, input.view.touchedPrivateData])
        if (label !== hangOn) return Promise.resolve({ kind: 'none' })
        reached.resolve()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('stopped')))
        })
      },
    },
    reached: reached.promise,
  }
}

describe('judging the members (§一批工具怎么执行 第 2 步, §挂点与会话视图)', () => {
  it('judges each member with the dispatches before it in view, and the cut once', async () => {
    const seen: Array<[string, boolean]> = []
    const h = await harness('cowork', [watcher(seen).registration])
    rec.holding = true
    const runId = await send(h, [READ_A, READ_B, ['Read', { file_path: SPILLED_1 }], READ_D])
    expect((await drive(h, runId)).reason).toEqual({ code: 'completed' })
    // b sees a dispatched, as it would in call order; the spill read is the cut, judged once.
    expect(seen).toEqual([
      [`Read ${A}`, false],
      [`Read ${B}`, true],
      [`Read ${SPILLED_1}`, true],
      [`Read ${D}`, true],
    ])
    expect(overlapping()).toEqual([[`Read ${A}`, `Read ${B}`]])
  })

  it('never judges or dispatches a leading Read whose arguments are invalid: it closes invalid-input', async () => {
    const h = await harness()
    const runId = await send(h, [['Read', { file_path: A, offset: 'x' }], READ_B])
    expect((await drive(h, runId)).reason).toEqual({ code: 'completed' })
    expect(await ordinalsOf(h, 'tool/permission_decided')).toEqual([1])
    expect(await ordinalsOf(h, 'execution/dispatch_committed')).toEqual([1])
    expect(await outcomes(h)).toEqual(['0 not-run invalid-input blocked', '1 completed  read'])
    // No decision fact, so its reversibility is 'unknown' (§载荷 ToolOutcomePayload).
    expect((await named(h, 'execution/tool_outcome'))[0]?.payload['reversibility']).toBe('unknown')
    expect(rec.executions.map(({ label }) => label)).toEqual([`Read ${B}`])
  })

  it('clears the machine-denial count with an allowed member, as a serial allow does (不变量 14)', async () => {
    // Two protected denials, then a reply whose leading Read is allowed before a third: not three in
    // a row, so the Run goes on (§上限、守卫与用量「中间有一次放行或问人就清零」).
    const h = await harness()
    const blocked: Call = ['Read', { file_path: `${PROFILE}/sessions.db` }]
    h.provider.script(callsOf([blocked, blocked]))
    h.provider.script(callsOf([READ_A, blocked]))
    h.provider.script(done())
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'go' })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    expect((await drive(h, sent.runId)).reason).toEqual({ code: 'completed' })
    expect(await outcomes(h)).toEqual([
      '0 not-run protected blocked',
      '1 not-run protected blocked',
      '0 completed  read',
      '1 not-run protected blocked',
    ])
  })

  it('a stop while a later member is judged: the ones dispatched close first, the rest not-run with no decision', async () => {
    const seen: Array<[string, boolean]> = []
    const watch = watcher(seen, `Read ${B}`)
    const h = await harness('cowork', [watch.registration])
    rec.holding = true
    const runId = await send(h, [READ_A, READ_B, READ_D])
    await watch.reached
    await quiet()
    expect(rec.executions.map(({ label, end }) => [label, end])).toEqual([[`Read ${A}`, null]])
    void h.service.stop({ rootSessionId: SESSION })
    await quiet()
    release(`Read ${A}`)
    expect((await ended(h, runId)).reason).toEqual({ code: 'user-stopped' })
    expect(await ordinalsOf(h, 'tool/permission_decided')).toEqual([0])
    expect(await ordinalsOf(h, 'execution/dispatch_committed')).toEqual([0])
    expect(await outcomes(h)).toEqual([
      '0 aborted stopped read',
      '1 not-run stopped blocked',
      '2 not-run stopped blocked',
    ])
  })
})

// ----- a stop while the group runs ----------------------------------------------------------------

describe('a stop that reaches a member’s decision and dispatch write first (§点停止时各状态怎么收)', () => {
  it('writes neither, dispatches no more, and still closes the member already dispatched', async () => {
    // Armed once b's inspectors answered; the kernel's next clock reading stamps b's decision, and
    // the stop lands then — before that write's turn, which the mailbox then refuses.
    const armed = { on: false, fired: false }
    const arming: InspectorRegistration = {
      id: 'arming',
      kind: 'local-rule',
      ceiling: 'ask',
      beforeCall: (input) => {
        if (rec.label(input.call.tool.originalName, input.call.args) === `Read ${B}`)
          armed.on = true
        return Promise.resolve({ kind: 'none' })
      },
    }
    const h = await harness('cowork', [arming])
    hook.onNow = () => {
      if (!armed.on || armed.fired) return
      armed.fired = true
      void h.service.stop({ rootSessionId: SESSION })
    }
    rec.holding = true
    const runId = await send(h, [READ_A, READ_B, READ_D])
    await until(() => armed.fired, 'the stop landed')
    await quiet()
    release(`Read ${A}`)
    expect((await ended(h, runId)).reason).toEqual({ code: 'user-stopped' })
    expect(await ordinalsOf(h, 'tool/permission_decided')).toEqual([0])
    expect(await ordinalsOf(h, 'execution/dispatch_committed')).toEqual([0])
    expect(await outcomes(h)).toEqual([
      '0 aborted stopped read',
      '1 not-run stopped blocked',
      '2 not-run stopped blocked',
    ])
    expect(rec.executions.map(({ label }) => label)).toEqual([`Read ${A}`])
  })
})

describe('a stop while the parallel group runs (§点停止时各状态怎么收)', () => {
  for (const cause of ['user-stop', 'quit'] as const) {
    it(`closes each member as the stop table says, each with its own write wait, results in call order (${cause})`, async () => {
      const h = await harness()
      rec.holding = true
      const runId = await send(h, [READ_A, READ_B, READ_D, ['Grep', { pattern: 'b' }], WRITE_C])
      await until(() => rec.executions.length === 4, 'the group started')
      await quiet()
      expect(await ordinalsOf(h, 'execution/dispatch_committed')).toEqual([0, 1, 2, 3])
      // The last member ends before the stop; its result waits for the three before it.
      release('Grep b')
      await quiet()
      expect(finished('Grep b')).toBe(true)
      if (cause === 'user-stop') void h.service.stop({ rootSessionId: SESSION })
      else h.loop.abort(SESSION, 'quit')
      await quiet()
      // d's Read begins after the stop: it sees the stop after its stat, and reads no further.
      release(`Read ${D}`)
      await quiet()
      expect(finished(`Read ${D}`)).toBe(true)
      // a and b never end: each waits STOP_WRITE_WAIT_MS from the stop — the same moment for both.
      h.memory.advance(STOP_WRITE_WAIT_MS - 1)
      await quiet()
      expect(await named(h, 'tool/result')).toEqual([])
      h.memory.advance(1)
      expect((await ended(h, runId)).reason).toEqual(
        cause === 'user-stop'
          ? { code: 'user-stopped' }
          : { code: 'shutdown-aborted', trigger: 'quit' },
      )
      const source = cause === 'user-stop' ? 'stopped' : 'app-exit'
      expect(await outcomes(h)).toEqual([
        `0 uncertain ${source} read`,
        `1 uncertain ${source} read`,
        `2 aborted ${source} read`,
        '3 completed  read',
        // Never dispatched: `stopped` whatever the cause.
        '4 not-run stopped blocked',
      ])
      expect(await ordinalsOf(h, 'tool/result')).toEqual([0, 1, 2, 3, 4])
      expect(await ordinalsOf(h, 'execution/dispatch_committed')).toEqual([0, 1, 2, 3])
      // a and b return late: nothing more is written, each logged once.
      const count = (await entries(h)).length
      release(`Read ${A}`)
      release(`Read ${B}`)
      await until(() => h.logs.length === 2, 'the late returns logged')
      await quiet()
      expect((await entries(h)).length).toBe(count)
      expect(h.logs).toEqual([
        expect.stringMatching(/Read call .*:0 was closed uncertain .* returned later/),
        expect.stringMatching(/Read call .*:1 was closed uncertain .* returned later/),
      ])
    })
  }
})

it('02 不变量 31: parallel and serial execution preserve results, outcomes and the next wire body', async () => {
  const run = async (serial: boolean) => {
    rec.serial = serial
    rec.holding = true
    rec.tick = 0
    rec.executions.length = 0
    nextCall = 1
    const h = await harness()
    const id = await send(h, [READ_A, READ_B])
    await until(() => rec.executions.length === (serial ? 1 : 2), 'initial reads dispatched')
    await quiet()
    expect(rec.executions.map((e) => e.label)).toEqual(
      serial ? [`Read ${A}`] : [`Read ${A}`, `Read ${B}`],
    )
    let earlyResults: unknown[] = []
    if (serial) {
      release(`Read ${A}`)
      await until(() => rec.executions.length === 2, 'second serial read')
      release(`Read ${B}`)
    } else {
      release(`Read ${B}`)
      await quiet()
      earlyResults = await named(h, 'tool/result')
      release(`Read ${A}`)
    }
    expect(earlyResults).toEqual([])
    expect((await ended(h, id)).reason).toEqual({ code: 'completed' })
    expect(overlapping()).toEqual(serial ? [] : [[`Read ${A}`, `Read ${B}`]])
    expect(h.provider.requests).toHaveLength(2)
    const recordedEntries = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    // Only the append positions differ: parallel dispatches precede either result. Compare every
    // persisted identity/payload field, without normalizing tool IDs, result text or wire content.
    const facts = recordedEntries
      .filter((e) => e.name === 'tool/result' || e.name === 'execution/tool_outcome')
      .map(
        ({ name, kind, sourceType, sourceId, sourceSeq, provenanceKey, payload, createdAt }) => ({
          name,
          kind,
          sourceType,
          sourceId,
          sourceSeq,
          provenanceKey,
          payload,
          createdAt,
        }),
      )
    expect(facts).toHaveLength(4)
    return { facts, body: h.provider.requests[1]!.body }
  }
  const parallel = await run(false)
  const serial = await run(true)
  expect(parallel).toEqual(serial)
})
