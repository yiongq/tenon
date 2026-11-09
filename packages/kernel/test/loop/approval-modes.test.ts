import { describe, expect, it, vi } from 'vitest'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createTape,
} from '../../src/index.js'
import type {
  HostAdapter,
  PermissionDecidedPayload,
  SandboxRequest,
  StreamEvent,
} from '../../src/index.js'
import { frozenBatchOf, rejudgeWaiting, waitingOf } from '../../src/loop/answer.js'
import type { JudgeContext } from '../../src/loop/batch.js'
import * as judgeModule from '../../src/loop/batch.js'
import { judgeCall } from '../../src/loop/batch.js'
import { approvalModeEntry, readSessionFacts } from '../../src/session/facts.js'
import { profileSetKey, sessionStartKey } from '../../src/tape/provenance.js'
import {
  createCounterIds,
  createFakeInspector,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import { fakeChild, pendingCard, proxyStore } from './support.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const WORK = absolutePath('/work')
const FILE = absolutePath('/work/a')
const MODEL = {
  id: 'approval-model',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: false,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop' as const,
  usageNeedsOptIn: false,
}
const usage = {
  inputTokens: 5,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}
const done = () => scriptedTurn({ deltas: ['done'], usage })
function call(name: string, input: Record<string, unknown>, id = 'call'): StreamEvent[] {
  return [
    { type: 'tool-call-start', index: 0, id, name },
    { type: 'tool-call-end', index: 0, id, name, input },
    { type: 'usage', usage },
    stopEvent('tool-use', 'tool_use'),
  ]
}
async function harness(
  defaultMode: () => 'manual' | 'auto' = () => 'manual',
  env: Record<string, string> = {},
  platform: 'yes' | 'linux' | 'no' = 'yes',
) {
  const memory = createMemoryHost()
  await memory.fs.mkdirp(WORK)
  await memory.fs.writeFile(FILE, 'before')
  const wrapped: SandboxRequest[] = []
  const spawned = vi.fn<HostAdapter['process']['spawn']>(async () => {
    const child = fakeChild(() => memory.clock.now(), 'dies')
    child.exit(0)
    return child.child
  })
  const host = {
    ...memory,
    process: { spawn: spawned },
    sandbox: {
      afterExit: (id: string) => memory.sandbox.afterExit(id),
      violations: (id: string) => memory.sandbox.violations(id),
      posture: () => ({ state: 'active' as const, profile: 'workspace-write' as const }),
      wrap: vi.fn<HostAdapter['sandbox']['wrap']>(async (q) => {
        wrapped.push(q)
        return memory.sandbox.wrap(q)
      }),
    },
  }
  const store = createMemoryTapeStore({ identity: host.identity })
  const batches: string[][] = []
  const recorded = proxyStore(store, {
    resetSession: async (q) => {
      batches.push([q.start.name, ...(q.carry ?? []).map((e) => e.name)])
      return store.resetSession(q)
    },
    append: async (q, ...rest) => {
      batches.push(q.entries.map((e) => e.name))
      return store.append(q, ...rest)
    },
  })
  const tape = createTape(recorded)
  const ids = createCounterIds()
  const provider = createScriptedProvider({ models: [MODEL] })
  const sandboxPorts = {
    beforeWrap: () => {},
    grantsChanged: () => {},
    autoCommands: () => platform,
  }
  const inspectors: Array<Parameters<typeof createTestSessionService>[0]['inspectors'][number]> = []
  const make = (bind = true) => {
    const ports = createTestLoopPorts({
      connector: { provider, model: MODEL },
      commandShell: { path: absolutePath('/bin/sh'), env: async () => env },
    })
    const service = createTestSessionService(
      {
        host,
        tape: recorded,
        ids,
        connector: ports.connector,
        inspectors,
        protectedFiles: [],
        approvalModeDefault: defaultMode,
      },
      { tools: { Write: 'real', Edit: 'real', Delete: 'real', Bash: 'real' } },
    )
    if (bind)
      service.bindLoop({
        ...ports,
        sandbox: sandboxPorts,
      })
    return { service, ports }
  }
  const { service, ports } = make()
  await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: WORK })
  memory.snapshots.setStatus(SESSION, 'tree')
  const entries = async (sessionId = SESSION) =>
    (await store.readRange({ sessionId, limit: 1000 })).entries
  const decisions = async () =>
    (await entries())
      .filter((e) => e.name === 'tool/permission_decided')
      .map((e) => e.payload as PermissionDecidedPayload)
  return {
    memory,
    host,
    store,
    tape,
    service,
    ports,
    provider,
    wrapped,
    spawned,
    make,
    entries,
    decisions,
    batches,
    sandboxPorts,
    recorded,
    inspectors,
  }
}
type H = Awaited<ReturnType<typeof harness>>
async function send(
  h: H,
  name?: string,
  input: Record<string, unknown> = { file_path: FILE, content: 'after' },
) {
  if (name !== undefined) h.provider.script(call(name, input))
  h.provider.script(done())
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'do the next step' })
  if (sent.status !== 'started') throw new Error(`send: ${sent.status}`)
  return h.ports.runEnded({ runId: sent.runId })
}
async function allow(h: Pick<H, 'service' | 'ports'>) {
  const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (pending === null) throw new Error('missing card')
  const answered = await h.service.answer({
    kind: 'approval',
    sessionId: SESSION,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  expect(answered.status).toBe('applied')
  await h.ports.runEnded()
  return answered
}

describe('06 session mode and dispatch', () => {
  it.each([
    'npm test >> out.log',
    'npm test 2>&1',
    'npm test >&2',
    'npm test >&-',
    'npm test 2>&-',
    'npm test >& 2',
    'npm test >& -',
    'npm test > /dev/null',
    'bash -c "npm test 2>&1"',
    "sh -c 'make 2>&1'",
    'x => x',
    'a -> b',
    'a >= b',
  ])('06 验收 8: a redirect asks once in auto with a session answer; %s does not', async (miss) => {
    const h = await harness(() => 'auto')
    const command = 'npm test > out.log'
    expect((await send(h, 'Bash', { command })).reason.code).toBe('paused')
    const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
    expect(pending).toMatchObject({
      allowScope: 'session',
      card: { reason: 'command', facts: { autoAsk: 'redirect' } },
    })
    const restarted = h.make()
    h.memory.snapshots.setStatus(SESSION, 'tree')
    await restarted.service.recover()
    expect(await restarted.service.currentPending({ sessionId: SESSION })).toEqual(pending)
    await allow(restarted)
    const active = { ...h, ...restarted }
    expect((await send(active, 'Bash', { command })).reason.code).toBe('completed')
    expect((await h.decisions()).at(-1)?.summary.code).toBe('session-allowed')
    expect((await send(active, 'Bash', { command: miss })).reason.code).toBe('completed')
    expect(
      (await h.decisions()).at(-1)?.record.steps.find((s) => s.by === 'approval-mode')?.basis
        ?.modeRule,
    ).toBe('auto-sandboxed-command')
    await active.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })
    expect((await send(active, 'Bash', { command })).reason.code).toBe('completed')
    expect((await h.decisions()).at(-1)?.summary.code).toBe('session-allowed')
    expect((await h.entries()).filter((e) => e.name === 'tool/approval_resolved')).toHaveLength(1)
  })

  it.each([
    'npm test >&out.log',
    'npm test >& out.log',
    'npm test >&2.log',
    'npm test >&-notes',
    'npm test > /dev/null.log',
    'npm test >/dev/nullx',
    'npm test > /dev/null/x',
    'npm test >| out.log',
    'npm test &> out.log',
    'npm test 2> err.log',
  ])('06 验收 8: filename redirect %s asks and accepts a real answer', async (command) => {
    const h = await harness(() => 'auto')
    expect((await send(h, 'Bash', { command })).reason.code).toBe('paused')
    expect(await h.service.currentPending({ sessionId: SESSION })).toMatchObject({
      card: { facts: { autoAsk: 'redirect' } },
    })
    await allow(h)
    expect((await send(h, 'Bash', { command })).reason.code).toBe('completed')
  })

  it('06 验收 3: twenty-five snapshotted Deletes in auto raise no card and are restorable', async () => {
    const h = await harness()
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
    for (let n = 0; n < 25; n++) {
      const file = absolutePath(`/work/file-${n}`)
      // oxlint-disable-next-line no-await-in-loop -- seed each distinct file before its scripted deletion
      await h.memory.fs.writeFile(file, `contents-${n}`)
      h.provider.script(call('Delete', { file_path: file }, `delete-${n}`))
    }
    h.provider.script(done())
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'delete 25' })
    if (sent.status !== 'started') throw new Error('not started')
    expect((await h.ports.runEnded({ runId: sent.runId })).reason).toEqual({ code: 'completed' })
    expect(await h.service.currentPending({ sessionId: SESSION })).toBeNull()
    expect(await h.decisions()).toHaveLength(25)
    expect((await h.decisions()).every((d) => d.record.verdict === 'allow')).toBe(true)
    const rounds = await h.service.snapshotRounds({ sessionId: SESSION })
    expect(rounds).toMatchObject({ ok: true, rounds: [{ canRestore: true }] })
    if (!rounds.ok) throw new Error(rounds.code)
    expect(rounds.rounds[0]?.calls).toHaveLength(25)
    const preview = await h.service.snapshotPreview({ sessionId: SESSION, roundRunId: sent.runId })
    if (!preview.ok) throw new Error(preview.code)
    expect(preview.preview.restore).toHaveLength(25)
    const restored = await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId: sent.runId,
      previewKey: preview.preview.previewKey,
      overwrite: [],
    })
    expect(restored).toMatchObject({ ok: true })
    for (let n = 0; n < 25; n++)
      expect(
        // oxlint-disable-next-line no-await-in-loop -- verify each independently restored file
        await h.memory.fs.readFile(absolutePath(`/work/file-${n}`), { encoding: 'utf8' }),
      ).toBe(`contents-${n}`)
  })

  it.each(['tree', 'warming', 'file-only', 'tree-failed'] as const)(
    '06 验收 4: a sandboxed command runs unasked in auto under %s',
    async (status) => {
      const h = await harness(() => 'auto')
      h.memory.snapshots.setStatus(SESSION, status === 'tree-failed' ? 'tree' : status)
      if (status === 'tree-failed') h.memory.snapshots.failNextTake('error')
      expect((await send(h, 'Bash', { command: 'echo ok' })).reason).toEqual({ code: 'completed' })
      expect((await h.decisions()).at(-1)).toMatchObject({
        record: {
          verdict: 'allow',
          decidedBy: 'approval-mode',
          steps: expect.arrayContaining([
            {
              by: 'approval-mode',
              said: 'allow',
              status: 'ok',
              basis: { modeRule: 'auto-sandboxed-command' },
            },
          ]),
        },
        summary: { code: 'auto-mode' },
      })
      expect(h.wrapped).toHaveLength(1)
      expect(await h.service.snapshotRounds({ sessionId: SESSION })).toMatchObject({
        ok: true,
        rounds: [{ commandsWithoutSnapshot: status !== 'tree' }],
      })
    },
  )

  it('06 验收 10: an unasked call writes no grant; manual grants still allow in auto', async () => {
    const h = await harness(() => 'auto')
    await send(h, 'Write')
    expect((await h.entries()).filter((e) => e.name === 'tool/approval_resolved')).toEqual([])
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })
    expect((await send(h, 'Write')).reason.code).toBe('paused')
    await allow(h)
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
    await send(h, 'Write')
    expect((await h.decisions()).at(-1)?.summary.code).toBe('session-allowed')
  })

  it("06 验收 11: a child follows the root's current mode", async () => {
    const h = await harness(() => 'auto')
    await send(h)
    const childInc = '33333333-3333-4333-8333-333333333333'
    await h.tape.appendEntries({
      sessionId: OTHER,
      incarnationId: childInc,
      entries: [
        h.tape.writer('session').entry('session/start', {
          sourceType: 'session',
          sourceId: OTHER,
          sourceSeq: 0,
          provenanceKey: sessionStartKey(childInc),
          payload: { incarnationId: childInc },
          createdAt: 0,
        }),
        h.tape.writer('session').entry('session/profile_set', {
          sourceType: 'session',
          sourceId: OTHER,
          provenanceKey: profileSetKey(childInc),
          payload: {
            profile: 'cowork',
            subagentOf: { sessionId: SESSION, linkKey: 'unused-for-judging' },
          },
          createdAt: 0,
        }),
      ],
    })
    const judge = (over: Partial<JudgeContext> = {}) =>
      judgeCall(
        {
          host: h.host,
          tape: h.tape,
          sessionId: OTHER,
          inspectors: [],
          protectedFiles: [],
          userSetting: () => null,
          searchHost: null,
          signal: new AbortController().signal,
          sandbox: h.sandboxPorts,
          ...over,
        },
        {
          name: 'Write',
          originalName: 'Write',
          source: 'builtin',
          serverId: 'builtin',
          requiresUserInteraction: false,
          spec: { name: 'Write', description: '', inputSchema: {} },
        },
        { input: { file_path: FILE, content: 'child' } },
      )
    expect(await judge()).toMatchObject({ decision: { record: { verdict: 'allow' } } })
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })
    expect(await judge()).toMatchObject({ decision: { record: { verdict: 'ask' } } })
    expect((await h.entries(OTHER)).some((e) => e.name === 'session/approval_mode_set')).toBe(false)
    expect(await h.service.setApprovalMode({ sessionId: OTHER, mode: 'auto' })).toEqual({
      status: 'not-cowork',
    })
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const inspector = createFakeInspector({
      id: 'paused',
      ceiling: 'ask',
      answer: async () => {
        entered.resolve()
        await release.promise
        return { kind: 'none' }
      },
    })
    const pending = judge({ inspectors: [inspector.registration] })
    await entered.promise
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })
    release.resolve()
    expect(await pending).toMatchObject({ decision: { record: { verdict: 'ask' } } })
    expect(inspector.calls).toHaveLength(1)
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
    const enteredSnapshot = Promise.withResolvers<void>()
    const releaseSnapshot = Promise.withResolvers<void>()
    inspector.answer(async () => {
      enteredSnapshot.resolve()
      await releaseSnapshot.promise
      return { kind: 'none' }
    })
    const snapshotPending = judge({ inspectors: [inspector.registration] })
    await enteredSnapshot.promise
    h.memory.snapshots.setStatus(SESSION, 'unavailable')
    releaseSnapshot.resolve()
    expect(await snapshotPending).toMatchObject({
      decision: { record: { verdict: 'ask' }, confirm: { facts: { autoAsk: 'no-snapshot' } } },
    })
    h.memory.setPolicy({
      status: 'current',
      version: 'disabled',
      snapshot: { tools: [], disableAutoMode: true },
    })
    expect(await judge()).toMatchObject({ decision: { record: { verdict: 'ask' } } })
    expect((await h.entries(OTHER)).some((e) => e.name === 'session/approval_mode_set')).toBe(false)
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
  })

  it('06 验收 12: the mode fact survives a restart and new tasks start at the default', async () => {
    let legacyDefault: 'manual' | 'auto' = 'manual'
    const legacy = await harness(() => legacyDefault)
    await send(legacy)
    legacyDefault = 'auto'
    expect((await send(legacy, 'Write')).reason.code).toBe('paused')
    const legacyRestart = legacy.make()
    legacy.memory.snapshots.setStatus(SESSION, 'tree')
    await legacyRestart.service.recover()
    expect((await readSessionFacts(legacy.tape, SESSION)).approvalMode).toBe('manual')
    expect((await legacy.entries()).filter((e) => e.name === 'session/approval_mode_set')).toEqual(
      [],
    )
    const legacyWaiting = await waitingOf(legacy.tape, SESSION)
    if (legacyWaiting === null) throw new Error('legacy card missing')
    const legacyFrozen = await frozenBatchOf(legacy.tape, legacyWaiting)
    const legacyJudgement = await rejudgeWaiting({
      judge: {
        tape: legacy.tape,
        host: legacy.host,
        sandbox: legacy.sandboxPorts,
        inspectors: [],
        protectedFiles: [],
        userSetting: () => null,
        signal: new AbortController().signal,
      },
      waiting: legacyWaiting,
      item: legacyFrozen.item,
      testTools: { Write: 'real' },
    })
    expect(legacyJudgement).toMatchObject({
      kind: 'unchanged',
      judged: { decision: { record: { verdict: 'ask' } } },
    })
    let mode: 'manual' | 'auto' = 'manual'
    const h = await harness(() => mode)
    await send(h)
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
    expect((await h.entries()).filter((e) => e.name === 'session/approval_mode_set')).toEqual([])
    expect(await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })).toEqual({
      status: 'set',
    })
    const restarted = h.make()
    h.memory.snapshots.setStatus(SESSION, 'tree')
    await restarted.service.recover()
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('auto')
    expect(
      (await h.entries()).findLast((e) => e.name === 'session/approval_mode_set')?.payload,
    ).toMatchObject({ mode: 'auto', by: 'user', writer: { by: 'resolver' } })
    mode = 'auto'
    await restarted.service.selectProfile({ sessionId: OTHER, profile: 'cowork', dedicated: WORK })
    h.provider.script(done())
    const sent = await restarted.service.send({ sessionId: OTHER, origin: null, text: 'new task' })
    if (sent.status !== 'started') throw new Error('not started')
    await restarted.ports.runEnded({ runId: sent.runId })
    expect(
      (await h.entries(OTHER)).find((e) => e.name === 'session/approval_mode_set')?.payload,
    ).toMatchObject({ mode: 'auto', by: 'default', writer: { by: 'resolver' } })
    expect(
      h.batches.some((batch) =>
        [
          'session/start',
          'session/profile_set',
          'session/workspace_set',
          'session/approval_mode_set',
        ].every((name) => batch.includes(name)),
      ),
    ).toBe(true)
    await restarted.service.createSession({ sessionId: '44444444-4444-4444-8444-444444444444' })
    expect(
      await restarted.service.setApprovalMode({
        sessionId: '44444444-4444-4444-8444-444444444444',
        mode: 'auto',
      }),
    ).toEqual({ status: 'not-cowork' })
    expect(
      await restarted.service.setApprovalMode({
        sessionId: '55555555-5555-4555-8555-555555555555',
        mode: 'auto',
      }),
    ).toEqual({ status: 'unknown-session' })
    restarted.ports.beginShutdown()
    expect(await restarted.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })).toEqual(
      { status: 'refused' },
    )
  })

  it('06 验收 12: an auto default never writes a mode fact for chat', async () => {
    const h = await harness(() => 'auto')
    await h.service.selectProfile({ sessionId: SESSION, profile: 'chat' })
    expect(await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })).toEqual({
      status: 'not-cowork',
    })
    await send(h)
    expect((await h.entries()).filter((e) => e.name === 'session/approval_mode_set')).toEqual([])
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
  })

  it.each(['manual', 'auto'] as const)(
    '06 验收 13: the %s default is captured when send starts',
    async (initial) => {
      let mode = initial
      const h = await harness(() => mode)
      const held = h.ports.connector.holdAssemble()
      h.provider.script(done())
      const sending = h.service.send({ sessionId: SESSION, text: 'start', origin: null })
      await held.reached
      mode = initial === 'auto' ? 'manual' : 'auto'
      held.release()
      const sent = await sending
      if (sent.status !== 'started') throw new Error('not started')
      await h.ports.runEnded({ runId: sent.runId })
      expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe(initial)
      const modes = (await h.entries()).filter((e) => e.name === 'session/approval_mode_set')
      expect(modes.map((e) => e.payload['by'])).toEqual(initial === 'auto' ? ['default'] : [])
    },
  )
  it.each([
    ['auto', 'manual'],
    ['manual', 'auto'],
  ] as const)(
    '06 验收 13: the %s draft choice overrides the %s default on the first call',
    async (choice, defaultMode) => {
      const h = await harness(() => defaultMode)
      await h.service.setApprovalMode({ sessionId: SESSION, mode: choice })
      expect((await send(h, 'Write')).reason.code).toBe(choice === 'auto' ? 'completed' : 'paused')
      expect((await h.decisions())[0]?.record.verdict).toBe(choice === 'auto' ? 'allow' : 'ask')
      expect(
        (await h.entries()).find((e) => e.name === 'session/approval_mode_set')?.payload,
      ).toMatchObject({ mode: choice, by: 'user', writer: { by: 'resolver' } })
      expect(
        h.batches.some((batch) =>
          [
            'session/start',
            'session/profile_set',
            'session/workspace_set',
            'session/approval_mode_set',
          ].every((name) => batch.includes(name)),
        ),
      ).toBe(true)
      const another = await harness()
      await another.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
      await another.service.selectProfile({ sessionId: SESSION, profile: 'chat' })
      await another.service.selectProfile({
        sessionId: SESSION,
        profile: 'cowork',
        dedicated: WORK,
      })
      expect((await send(another, 'Write')).reason.code).toBe('paused')
    },
  )

  it('06 验收 14: switching to auto never releases a waiting card, even after a restart', async () => {
    const h = await harness()
    await send(h, 'Write')
    const before = await h.service.currentPending({ sessionId: SESSION })
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
    expect(await h.service.currentPending({ sessionId: SESSION })).toEqual(before)
    const waiting = await waitingOf(h.tape, SESSION)
    if (waiting === null) throw new Error('missing waiting Write')
    const { item } = await frozenBatchOf(h.tape, waiting)
    const rejudged = await rejudgeWaiting({
      judge: {
        tape: h.tape,
        host: h.host,
        sandbox: h.sandboxPorts,
        inspectors: [],
        protectedFiles: [],
        userSetting: () => null,
        signal: new AbortController().signal,
      },
      waiting,
      item,
      testTools: { Write: 'real' },
    })
    expect(rejudged).toMatchObject({
      kind: 'unchanged',
      judged: { decision: { record: { verdict: 'allow' } } },
    })
    const control = await harness(() => 'auto')
    expect((await send(control, 'Write')).reason.code).toBe('completed')
    expect(await control.service.currentPending({ sessionId: SESSION })).toBeNull()

    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
    const restarted = h.make()
    h.memory.snapshots.setStatus(SESSION, 'tree')
    await restarted.service.recover()
    await restarted.service.resume({ rootSessionId: SESSION, origin: null })
    expect(await restarted.service.currentPending({ sessionId: SESSION })).toEqual(before)
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
    await allow(restarted)
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('after')
    const redirect = await harness(() => 'auto')
    await send(redirect, 'Bash', { command: 'npm test > out.log' })
    const redirectBefore = await redirect.service.currentPending({ sessionId: SESSION })
    const redirectRestart = redirect.make()
    await redirectRestart.service.recover()
    expect(await redirectRestart.service.currentPending({ sessionId: SESSION })).toEqual(
      redirectBefore,
    )
    // Switching while a command is running leaves its lease and result intact.
    const active = await harness(() => 'auto')
    const child = fakeChild(() => 0, 'dies')
    active.spawned.mockResolvedValue(child.child)
    active.provider.script(call('Bash', { command: 'echo held' }))
    active.provider.script(done())
    const sent = await active.service.send({ sessionId: SESSION, text: 'run', origin: null })
    if (sent.status !== 'started') throw new Error('not started')
    await vi.waitFor(() => expect(active.spawned).toHaveBeenCalledOnce())
    await active.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })
    expect(active.ports.liveLease(SESSION)).not.toBeNull()
    expect(child.kills).toEqual([])
    child.exit(0)
    expect((await active.ports.runEnded({ runId: sent.runId })).reason.code).toBe('completed')
  })

  it.each(['Write', 'Bash'])(
    '06 验收 14: changing only autoAsk never stales an answer for %s',
    async (name) => {
      const h = await harness(() => 'manual', {}, 'linux')
      h.memory.snapshots.setStatus(SESSION, 'unavailable')
      await send(
        h,
        name,
        name === 'Bash' ? { command: 'echo old card' } : { file_path: FILE, content: 'after' },
      )
      const before = await h.service.currentPending({ sessionId: SESSION })
      await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
      const restarted = h.make()
      await restarted.service.recover()
      expect(await restarted.service.currentPending({ sessionId: SESSION })).toEqual(before)
      await allow(restarted)
      const active = { ...h, ...restarted }
      await send(
        active,
        name,
        name === 'Bash'
          ? { command: 'echo auto card' }
          : { file_path: absolutePath('/work/other'), content: 'other' },
      )
      const autoCard = await active.service.currentPending({ sessionId: SESSION })
      expect(autoCard).toMatchObject({ card: { facts: { autoAsk: 'no-snapshot' } } })
      await active.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })
      await allow(active)
    },
  )

  it('06 验收 15: disableAutoMode folds auto to manual and records a policy fact', async () => {
    const h = await harness(() => 'auto')
    await send(h)
    h.memory.setPolicy({
      status: 'current',
      version: 'disabled',
      snapshot: { tools: [], disableAutoMode: true },
    })
    expect(await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })).toEqual({
      status: 'policy',
    })
    expect((await send(h, 'Write')).reason.code).toBe('paused')
    expect(
      (await h.entries())
        .filter((e) => e.name === 'session/approval_mode_set')
        .map((e) => e.payload),
    ).toMatchObject([
      { mode: 'auto', by: 'default' },
      { mode: 'manual', by: 'policy', writer: { by: 'run', runId: expect.any(String) } },
    ])
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
  })

  it.each(['auto', 'manual'] as const)(
    '06 验收 16: clearing a session carries its %s approval mode',
    async (mode) => {
      const h = await harness(() => 'auto')
      await send(h)
      if (mode === 'manual') await h.service.setApprovalMode({ sessionId: SESSION, mode })
      const before = (await h.entries()).findLast((e) => e.name === 'session/approval_mode_set')!
      h.batches.length = 0
      const reset = await h.service.resetSession(SESSION)
      const after = await h.entries()
      expect(after.map((e) => e.name)).toEqual([
        'session/start',
        'session/profile_set',
        'session/workspace_set',
        'session/approval_mode_set',
      ])
      expect(after.at(-1)?.payload).toEqual(before.payload)
      expect(after.at(-1)?.provenanceKey).toBe(`session:v1:approval_mode:${reset.incarnationId}:0`)
      expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe(mode)
      expect(h.batches).toContainEqual([
        'session/start',
        'session/profile_set',
        'session/workspace_set',
        'session/approval_mode_set',
      ])
    },
  )

  it.each([
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'NPM_TOKEN',
    'HF_TOKEN',
    'VAULT_TOKEN',
    'PGPASSWORD',
    'OP_SERVICE_ACCOUNT_TOKEN',
    'OP_SESSION_personal',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'ZHIPU_API_KEY',
    'DEEPSEEK_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'custom_TOKEN',
    'custom_secret',
    'Custom_Password',
    'custom_API_KEY',
    'my_api_key',
    'MiXeD_aCcEsS_kEy',
    'custom_ACCESS_KEY',
  ])('06 验收 17: an unasked command never receives %s; manual commands keep it', async (key) => {
    const ordinary = {
      PATH: '/bin',
      HOME: '/home/test',
      JAVA_HOME: '/java',
      NODE_OPTIONS: '--trace-warnings',
      TOKENIZERS_PARALLELISM: 'false',
      GH_TOKEN_PATH: '/tmp/token',
      MY_API_KEY_FILE: '/tmp/key',
      AUTHTOKEN: 'fixture',
      MYPASSWORD: 'fixture',
      WEBSECRET: 'fixture',
      MYAPI_KEY: 'fixture',
      MYACCESS_KEY: 'fixture',
    }
    const env: Record<string, string> = {
      ...ordinary,
      [key]: 'fixture',
    }
    const h = await harness(() => 'auto', env)
    await send(h, 'Bash', { command: 'echo environment' })
    expect(h.wrapped[0]?.env).toEqual(ordinary)
    expect(env[key]).toBe('fixture')
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })
    await send(h, 'Bash', { command: 'echo approved' })
    await allow(h)
    expect(h.wrapped.at(-1)?.env).toEqual(env)
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
    await send(h, 'Bash', { command: 'echo approved' })
    expect((await h.decisions()).at(-1)?.summary.code).toBe('session-allowed')
    expect(h.wrapped.at(-1)?.env).toEqual(env)
    await send(h, 'Bash', { command: 'truncate -s 0 x' })
    await allow(h)
    expect(h.wrapped.at(-1)?.env).toEqual(env)
  })
  it('06 验收 14: other card facts still invalidate an old answer', async () => {
    const h = await harness()
    await send(h, 'Bash', { command: 'echo old card' })
    const before = pendingCard(await h.service.currentPending({ sessionId: SESSION }))!
    vi.spyOn(h.host.sandbox, 'posture').mockReturnValue({
      state: 'unavailable',
      profile: 'workspace-write',
    } as never)
    const waiting = (await waitingOf(h.tape, SESSION))!
    const { item } = await frozenBatchOf(h.tape, waiting)
    expect(
      await rejudgeWaiting({
        judge: {
          tape: h.tape,
          host: h.host,
          sandbox: h.sandboxPorts,
          inspectors: [],
          protectedFiles: [],
          userSetting: () => null,
          signal: new AbortController().signal,
        },
        waiting,
        item,
        testTools: { Bash: 'real' },
      }),
    ).toMatchObject({
      kind: 'changed',
      judged: { decision: { confirm: { facts: { sandbox: 'unavailable' } } } },
    })
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: before.card.requestId,
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'stale' })
    expect(await h.service.currentPending({ sessionId: SESSION })).toMatchObject({
      card: { facts: { sandbox: 'unavailable' } },
    })
    expect(h.spawned).not.toHaveBeenCalled()
  })

  it('06 验收 8: every judgement entry retains the same redirect explanation', async () => {
    const h = await harness(() => 'auto')
    const spy = vi.spyOn(judgeModule, 'judgeCall')
    try {
      await send(h, 'Bash', { command: 'npm test > out.log' })
      expect((await h.decisions()).at(-1)?.confirm?.facts['autoAsk']).toBe('redirect')
      spy.mockClear()
      const restarted = h.make()
      await restarted.service.recover()
      expect(spy).toHaveBeenCalledOnce()
      expect(await spy.mock.results[0]!.value).toMatchObject({
        decision: { confirm: { facts: { autoAsk: 'redirect' } } },
      })
      expect(spy.mock.calls[0]![0].sandbox).toBe(h.sandboxPorts)
      spy.mockClear()
      await allow(restarted)
      expect(await spy.mock.results[0]!.value).toMatchObject({
        decision: { confirm: { facts: { autoAsk: 'redirect' } } },
      })
      expect(spy.mock.calls[0]![0].sandbox).toBe(h.sandboxPorts)
    } finally {
      spy.mockRestore()
    }
  })

  it('06 验收 12: chat stays manual even with a stray mode fact', async () => {
    const h = await harness()
    await h.service.selectProfile({ sessionId: SESSION, profile: 'chat' })
    await send(h)
    const head = (await h.tape.head(SESSION))!
    await h.tape.appendEntries({
      sessionId: SESSION,
      incarnationId: head.incarnationId,
      entries: [
        approvalModeEntry(
          { tape: h.tape, sessionId: SESSION, incarnationId: head.incarnationId, now: () => 0 },
          0,
          { mode: 'auto', by: 'user', writer: { by: 'resolver' } },
        ),
      ],
    })
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
  })

  it('06 验收 15: unavailable policy denies calls but never throws on a mode choice', async () => {
    const h = await harness(() => 'auto')
    await send(h)
    h.memory.setPolicy({ status: 'unavailable' } as never)
    expect((await send(h, 'Write')).reason.code).not.toBe('error')
    expect((await h.decisions()).at(-1)?.record.verdict).toBe('deny')
    expect(await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })).toEqual({
      status: 'set',
    })
  })

  it('06 验收 15: policy never prevents choosing manual', async () => {
    const h = await harness(() => 'auto')
    await send(h)
    h.memory.setPolicy({
      status: 'current',
      version: 'disabled',
      snapshot: { tools: [], disableAutoMode: true },
    })
    expect(await h.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })).toEqual({
      status: 'set',
    })
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
  })

  it.each(['answer', 'recovery'] as const)(
    '06 验收 15: a policy fold records its %s writer',
    async (entry) => {
      const h = await harness()
      await send(h, 'Bash', { command: 'echo pending' })
      await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
      h.memory.setPolicy({
        status: 'current',
        version: 'disabled',
        snapshot: { tools: [], disableAutoMode: true },
      })
      if (entry === 'answer') await allow(h)
      else await h.make().service.recover()
      expect(
        (await h.entries()).findLast((e) => e.name === 'session/approval_mode_set')?.payload,
      ).toMatchObject({
        mode: 'manual',
        by: 'policy',
        writer: { by: entry === 'answer' ? 'resolver' : 'recovery' },
      })
    },
  )

  it('06 验收 15: a Run policy fold and user choice share the root mailbox', async () => {
    const h = await harness(() => 'auto')
    await send(h)
    h.memory.setPolicy({
      status: 'current',
      version: 'disabled',
      snapshot: { tools: [], disableAutoMode: true },
    })
    let armed = false
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    h.inspectors.push(
      createFakeInspector({
        id: 'arm-head',
        ceiling: 'ask',
        answer: () => {
          armed = true
          return { kind: 'none' }
        },
      }).registration,
    )
    const head = h.store.head.bind(h.store)
    vi.spyOn(h.store, 'head').mockImplementation(async (id) => {
      if (armed) {
        armed = false
        held.resolve()
        await release.promise
      }
      return head(id)
    })
    const running = send(h, 'Write')
    await held.promise
    const choosing = h.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })
    // Let the competing command reach its mailbox turn while the policy head read is held.
    for (let n = 0; n < 30; n++) {
      // oxlint-disable-next-line no-await-in-loop -- let the competing mailbox command advance
      await Promise.resolve()
    }
    release.resolve()
    const [ended, selected] = await Promise.all([running, choosing])
    expect(ended.reason.code).toBe('paused')
    expect(selected).toEqual({ status: 'set' })
    const modes = (await h.entries()).filter((e) => e.name === 'session/approval_mode_set')
    expect(modes.map((e) => e.sourceSeq)).toEqual([0, 1, 2])
    expect(modes.map((e) => e.payload['by'])).toEqual(['default', 'policy', 'user'])
  })

  it('06 验收 14: a user stop still permits a choice while the Run closes', async () => {
    const h = await harness(() => 'auto')
    const child = fakeChild(() => 0, 'hangs')
    h.spawned.mockResolvedValue(child.child)
    h.provider.script(call('Bash', { command: 'echo held' }))
    const sent = await h.service.send({ sessionId: SESSION, text: 'start', origin: null })
    if (sent.status !== 'started') throw new Error('not started')
    await vi.waitFor(() => expect(h.spawned).toHaveBeenCalledOnce())
    const lease = h.ports.liveLease(SESSION)!
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect(lease.signal.aborted).toBe(true)
    expect(h.ports.liveLease(SESSION)).toBe(lease)
    expect(await h.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })).toEqual({
      status: 'set',
    })
    expect(h.ports.liveLease(SESSION)).toBe(lease)
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
    h.ports.beginShutdown()
    expect(await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })).toEqual({
      status: 'refused',
    })
    await vi.waitFor(() => expect(child.kills.some((k) => k.signal === 'SIGTERM')).toBe(true))
    h.memory.advance(1000)
    child.exit(0)
    await h.ports.runEnded({ runId: sent.runId })
  })

  it('06 验收 12: mode choices validate binding, ids and a missing head', async () => {
    const h = await harness()
    expect(
      await h.make(false).service.setApprovalMode({ sessionId: SESSION, mode: 'auto' }),
    ).toEqual({ status: 'refused' })
    await expect(h.service.setApprovalMode({ sessionId: 'invalid', mode: 'auto' })).rejects.toThrow(
      TypeError,
    )
    await send(h)
    vi.spyOn(h.store, 'head').mockResolvedValue(null)
    const count = (await h.entries()).length
    expect(await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })).toEqual({
      status: 'unknown-session',
    })
    expect(await h.entries()).toHaveLength(count)
  })

  it.each(['begin', 'facts', 'head'] as const)(
    '06 验收 12: shutdown at the %s boundary refuses a choice without later IO',
    async (stage) => {
      const h = await harness()
      await send(h)
      const modes = (await h.entries()).filter((e) => e.name === 'session/approval_mode_set')
      let reads = 0
      let heads = 0
      const read = h.store.readRange.bind(h.store)
      const head = h.store.head.bind(h.store)
      const begin = h.ports.leases.begin.bind(h.ports.leases)
      vi.spyOn(h.ports.leases, 'begin').mockImplementation((q) => {
        const lease = begin(q)
        if (stage === 'begin') h.ports.beginShutdown()
        return lease
      })
      vi.spyOn(h.store, 'readRange').mockImplementation(async (q) => {
        reads++
        const page = await read(q)
        if (stage === 'facts') h.ports.beginShutdown()
        return page
      })
      vi.spyOn(h.store, 'head').mockImplementation(async (id) => {
        heads++
        const result = await head(id)
        if (stage === 'head') h.ports.beginShutdown()
        return result
      })
      const policy = vi.spyOn(h.host.policy, 'current')
      expect(await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })).toEqual({
        status: 'refused',
      })
      expect(reads).toBe(stage === 'begin' ? 0 : 1)
      expect(heads).toBe(stage === 'head' ? 1 : 0)
      expect(policy).toHaveBeenCalledTimes(stage === 'head' ? 1 : 0)
      expect((await h.entries()).filter((e) => e.name === 'session/approval_mode_set')).toEqual(
        modes,
      )
      expect(h.ports.liveLease(SESSION)).toBeNull()
    },
  )
})
