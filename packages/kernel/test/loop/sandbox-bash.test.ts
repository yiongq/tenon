/** Sandbox planning only (04 step 9): execution still uses the 02 fake executor. */
import { describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type { PendingApproval, PermissionDecidedPayload, SandboxPosture } from '../../src/index.js'
import {
  rejudgeDecisionOf,
  rejudgeWaiting,
  waitingOf,
  frozenBatchOf,
} from '../../src/loop/answer.js'
import { judgeCall } from '../../src/loop/batch.js'
import { createTape } from '../../src/tape/tape.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import { pendingCard } from './support.js'

const SESSION = 'b6e30bed-0e02-4f29-8e20-0010e83e2190'
const WORK = absolutePath('/work/project')
const OTHER = absolutePath('/work/other')
const DEDICATED = absolutePath('/work/dedicated')
const COMMAND = 'echo hello'
const MODEL = {
  id: 'sandbox-model',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop' as const,
  usageNeedsOptIn: false,
}

async function harness(
  initial: SandboxPosture | null = {
    state: 'active',
    profile: 'workspace-write',
  },
) {
  const memory = createMemoryHost()
  let posture = initial
  const host = {
    ...memory,
    sandbox: {
      wrap: memory.sandbox.wrap.bind(memory.sandbox),
      afterExit: memory.sandbox.afterExit.bind(memory.sandbox),
      violations: memory.sandbox.violations.bind(memory.sandbox),
      ...(initial === null ? {} : { posture: () => posture! }),
    },
  }
  const store = createMemoryTapeStore({ identity: memory.identity })
  const tape = createTape(store)
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
  const service = createTestSessionService(
    {
      host,
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      protectedFiles: [],
      connector: loop.connector,
    },
    { tools: {} },
  )
  service.bindLoop(loop)
  await memory.fs.mkdirp(WORK)
  await memory.fs.mkdirp(OTHER)
  await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
  await service.setWorkspace({
    sessionId: SESSION,
    change: { kind: 'add', folders: [WORK, OTHER] },
    dedicated: DEDICATED,
  })
  const judge = {
    tape,
    host,
    inspectors: [],
    protectedFiles: [],
    userSetting: () => null,
    signal: new AbortController().signal,
  }
  return {
    service,
    provider,
    loop,
    store,
    tape,
    judge,
    setPosture: (value: SandboxPosture) => {
      posture = value
    },
  }
}
type Harness = Awaited<ReturnType<typeof harness>>

async function command(h: Harness, granted = false) {
  h.provider.script([
    { type: 'tool-call-start', index: 1, id: 'sandbox-call', name: 'Bash' },
    {
      type: 'tool-call-end',
      index: 1,
      id: 'sandbox-call',
      name: 'Bash',
      input: { command: COMMAND },
    },
    stopEvent('tool-use', 'tool_use'),
  ])
  // A session-granted command executes and asks for a second model turn.
  if (granted) h.provider.script(scriptedTurn({ deltas: ['Done.'] }))
  const sent = await h.service.send({ sessionId: SESSION, text: 'run the command', origin: null })
  if (sent.status !== 'started') throw new Error(`send: ${sent.status}`)
  return h.loop.runEnded({ runId: sent.runId })
}

async function card(h: Harness): Promise<PendingApproval> {
  const current = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (current === null) throw new Error('expected command card')
  return current
}

async function allow(h: Harness) {
  h.provider.script(scriptedTurn({ deltas: ['Done.'] }))
  const current = await card(h)
  expect(
    await h.service.answer({
      kind: 'approval',
      sessionId: SESSION,
      requestId: current.card.requestId,
      decision: 'allow',
      origin: null,
    }),
  ).toEqual({ status: 'applied' })
  await h.loop.runEnded()
}

async function decisions(h: Harness) {
  const entries = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  return entries
    .filter((e) => e.name === 'tool/permission_decided')
    .map((e) => e.payload as unknown as PermissionDecidedPayload)
}

async function rejudge(h: Harness) {
  const waiting = await waitingOf(h.tape, SESSION)
  if (waiting === null) throw new Error('expected waiting call')
  const { item } = await frozenBatchOf(h.tape, waiting)
  return rejudgeWaiting({ judge: h.judge, waiting, item, testTools: {} })
}

describe('Bash sandbox plans (04 step 9)', () => {
  it('04 验收 17: an active workspace-write posture plans workspace-write with the session folders', async () => {
    const h = await harness()
    expect((await command(h)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    expect((await decisions(h)).at(-1)?.sandbox).toEqual({
      profile: 'workspace-write',
      chosen: 'workspace-write',
    })
    expect((await card(h)).card.target).toEqual({
      type: 'command',
      command: 'echo hello',
      cwd: '/work/project',
    })
    const entries = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    expect(entries.findLast((e) => e.name === 'session/workspace_set')?.payload['folders']).toEqual(
      ['/work/project', '/work/other'],
    )
  })

  it('04 验收 17: read-only chosen plans read-only for the next decision', async () => {
    const h = await harness()
    await command(h)
    h.setPosture({ state: 'active', profile: 'read-only' })
    await command(h)
    expect((await decisions(h)).map((d) => d.sandbox)).toEqual([
      { profile: 'workspace-write', chosen: 'workspace-write' },
      { profile: 'read-only', chosen: 'read-only' },
    ])
  })

  it('04 验收 17: a host without posture behaves as 02', async () => {
    const h = await harness(null)
    await command(h)
    const current = await card(h)
    expect(current.card.reason).toBe('command')
    expect(current.card.facts).toEqual({ command: 'echo hello', cwd: '/work/project' })
    expect(current.allowScope).toBe('session')
    expect((await decisions(h)).at(-1)?.sandbox).toEqual({
      profile: 'workspace-write',
      chosen: 'workspace-write',
    })
    await allow(h)
    expect((await command(h, true)).reason).toEqual({ code: 'completed' })
    expect((await decisions(h)).at(-1)?.record.decidedBy).toBe('user-grant')
  })

  it('04 验收 18: unavailable keeps reason command, adds facts.sandbox and plans full-access', async () => {
    const h = await harness({ state: 'unavailable', profile: 'read-only' })
    await command(h)
    expect((await card(h)).card.reason).toBe('command')
    expect((await card(h)).card.facts).toEqual({
      command: 'echo hello',
      cwd: '/work/project',
      sandbox: 'unavailable',
    })
    expect((await decisions(h)).at(-1)?.sandbox).toEqual({
      profile: 'full-access',
      chosen: 'read-only',
      unavailable: true,
    })
  })

  it('04 验收 18: a session grant given while active does not skip the unavailable card', async () => {
    const h = await harness()
    await command(h)
    await allow(h)
    h.setPosture({ state: 'unavailable', profile: 'workspace-write' })
    expect((await command(h)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    expect((await card(h)).card.facts).toEqual({
      command: 'echo hello',
      cwd: '/work/project',
      sandbox: 'unavailable',
    })
    expect((await decisions(h)).at(-1)?.record.steps.find((s) => s.by === 'user-grant')?.said).toBe(
      'none',
    )
  })

  it('04 验收 18: a re-judgement while pending keeps the line', async () => {
    const h = await harness({ state: 'unavailable', profile: 'workspace-write' })
    await command(h)
    const before = await card(h)
    h.setPosture({ state: 'pending', profile: 'workspace-write' })
    const judged = await rejudge(h)
    expect(judged.kind).toBe('unchanged')
    if (judged.kind !== 'unchanged') throw new Error('card changed')
    expect(judged.judged.sandbox).toEqual({
      profile: 'full-access',
      chosen: 'workspace-write',
      unavailable: true,
    })
    expect(judged.judged.decision.confirm?.facts).toEqual({
      command: 'echo hello',
      cwd: '/work/project',
      sandbox: 'unavailable',
    })
    await allow(h)
    expect((await decisions(h)).at(-1)?.confirm?.facts).toEqual(before.card.facts)
  })

  it('04 不变量 18 (unavailable)', async () => {
    const h = await harness({ state: 'unavailable', profile: 'workspace-write' })
    await command(h)
    expect((await card(h)).allowScope).toBe('session')
    await allow(h)
    expect((await command(h, true)).reason).toEqual({ code: 'completed' })
    expect((await decisions(h)).at(-1)?.record.decidedBy).toBe('user-grant')
    expect((await decisions(h)).at(-1)?.sandbox).toEqual({
      profile: 'full-access',
      chosen: 'workspace-write',
      unavailable: true,
    })
  })

  it('a degraded posture keeps its chosen profile and a newly pending posture has no unavailable line', async () => {
    const h = await harness({ state: 'degraded', profile: 'read-only' })
    await command(h)
    expect((await decisions(h)).at(-1)?.sandbox).toEqual({
      profile: 'read-only',
      chosen: 'read-only',
    })
    h.setPosture({ state: 'pending', profile: 'workspace-write' })
    await command(h)
    expect((await decisions(h)).at(-1)?.sandbox).toEqual({
      profile: 'workspace-write',
      chosen: 'workspace-write',
    })
    expect((await card(h)).card.facts).toEqual({ command: 'echo hello', cwd: '/work/project' })
  })

  it('a bound rerun asks with elevated reason despite a command grant and allows only once', async () => {
    const h = await harness()
    await command(h)
    await allow(h)
    // Model the already-bound plan only; binding a release is step 11.
    await command(h, true)
    // A new command card with the same scope is needed to seed the retained binding.
    h.setPosture({ state: 'unavailable', profile: 'workspace-write' })
    await command(h)
    const waiting = await waitingOf(h.tape, SESSION)
    if (waiting === null) throw new Error('no waiting call')
    const { item } = await frozenBatchOf(h.tape, waiting)
    if (item === undefined) throw new Error('missing Bash')
    h.setPosture({ state: 'active', profile: 'workspace-write' })
    const judged = await judgeCall(
      {
        ...h.judge,
        sessionId: SESSION,
        searchHost: null,
        previousSandbox: {
          profile: 'full-access',
          chosen: 'workspace-write',
          override: { key: 'rerun-key', action: 'rerun-unsandboxed' },
        },
      },
      item,
      waiting.call,
    )
    if (judged.kind !== 'judged') throw new Error('stopped')
    expect(judged.decision.record.verdict).toBe('ask')
    expect(judged.decision.confirm).toEqual({
      reason: 'elevated',
      facts: { command: 'echo hello' },
    })
    expect(judged.sandbox).toEqual({
      profile: 'full-access',
      chosen: 'workspace-write',
      override: { key: 'rerun-key', action: 'rerun-unsandboxed' },
    })
    // Seed the pending elevated decision so both the visible period and the written grant are tested.
    const head = await h.tape.head(SESSION)
    if (head === null) throw new Error('missing head')
    await h.tape.appendEntries({
      sessionId: SESSION,
      incarnationId: head.incarnationId,
      entries: [
        rejudgeDecisionOf({
          tape: h.tape,
          now: () => 0,
          waiting,
          judged,
          writer: { by: 'resolver' },
        }),
      ],
    })
    expect((await card(h)).allowScope).toBe('once')
    await allow(h)
    const entries = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    expect(entries.findLast((e) => e.name === 'tool/approval_resolved')?.payload['grant']).toEqual({
      scope: 'once',
      key: '["builtin","Bash","command","echo hello","/work/project"]',
    })
  })
})
