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
import { judgeCall } from '../../src/loop/batch.js'
import { readSessionFacts } from '../../src/session/facts.js'
import { profileSetKey, sessionStartKey } from '../../src/tape/provenance.js'
import {
  createCounterIds,
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
    append: async (q, ...rest) => {
      batches.push(q.entries.map((e) => e.name))
      return store.append(q, ...rest)
    },
  })
  const tape = createTape(recorded)
  const ids = createCounterIds()
  const provider = createScriptedProvider({ models: [MODEL] })
  const make = () => {
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
        inspectors: [],
        protectedFiles: [],
        approvalModeDefault: defaultMode,
      },
      { tools: { Write: 'real', Edit: 'real', Delete: 'real', Bash: 'real' } },
    )
    service.bindLoop({
      ...ports,
      sandbox: { beforeWrap: () => {}, grantsChanged: () => {}, autoCommands: () => 'yes' },
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
  await h.service.answer({
    kind: 'approval',
    sessionId: SESSION,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  await h.ports.runEnded()
}

describe('06 session mode and dispatch', () => {
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
    const judge = () =>
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
  })

  it('06 验收 12: the mode fact survives a restart and new tasks start at the default', async () => {
    let mode: 'manual' | 'auto' = 'manual'
    const h = await harness(() => mode)
    await send(h)
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
    expect((await h.entries()).filter((e) => e.name === 'session/approval_mode_set')).toEqual([])
    expect(await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })).toEqual({
      status: 'set',
    })
    const restarted = h.make()
    await restarted.service.recover()
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('auto')
    expect(
      (await h.entries()).findLast((e) => e.name === 'session/approval_mode_set')?.payload,
    ).toMatchObject({ mode: 'auto', by: 'user' })
    mode = 'auto'
    await restarted.service.selectProfile({ sessionId: OTHER, profile: 'cowork', dedicated: WORK })
    h.provider.script(done())
    const sent = await restarted.service.send({ sessionId: OTHER, origin: null, text: 'new task' })
    if (sent.status !== 'started') throw new Error('not started')
    await restarted.ports.runEnded({ runId: sent.runId })
    expect(
      (await h.entries(OTHER)).find((e) => e.name === 'session/approval_mode_set')?.payload,
    ).toMatchObject({ mode: 'auto', by: 'default' })
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

  it('06 验收 13: auto chosen in the draft judges the first call in auto', async () => {
    const h = await harness()
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
    await send(h, 'Write')
    expect((await h.decisions())[0]?.record.verdict).toBe('allow')
    expect(
      (await h.entries()).find((e) => e.name === 'session/approval_mode_set')?.payload,
    ).toMatchObject({ mode: 'auto', by: 'user' })
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
    await another.service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: WORK })
    expect((await send(another, 'Write')).reason.code).toBe('paused')
    const explicitManual = await harness(() => 'auto')
    await explicitManual.service.setApprovalMode({ sessionId: SESSION, mode: 'manual' })
    expect((await send(explicitManual, 'Write')).reason.code).toBe('paused')
  })

  it('06 验收 14: switching to auto never releases a waiting card, even after a restart', async () => {
    const h = await harness()
    await send(h, 'Write')
    const before = await h.service.currentPending({ sessionId: SESSION })
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
    expect(await h.service.currentPending({ sessionId: SESSION })).toEqual(before)
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
    const restarted = h.make()
    await restarted.service.recover()
    await restarted.service.resume({ rootSessionId: SESSION, origin: null })
    expect(await restarted.service.currentPending({ sessionId: SESSION })).toEqual(before)
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
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
    expect(child.kills).toEqual([])
    child.exit(0)
    expect((await active.ports.runEnded({ runId: sent.runId })).reason.code).toBe('completed')
  })

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
      { mode: 'manual', by: 'policy' },
    ])
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
  })

  it('06 验收 16: clearing a session carries its approval mode', async () => {
    const h = await harness(() => 'auto')
    await send(h)
    const before = (await h.entries()).find((e) => e.name === 'session/approval_mode_set')!
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
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('auto')
  })

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
    'custom_ACCESS_KEY',
  ])('06 验收 17: an unasked command never receives %s; manual commands keep it', async (key) => {
    const env = {
      [key]: 'fixture',
      PATH: '/bin',
      HOME: '/home/test',
      JAVA_HOME: '/java',
      NODE_OPTIONS: '--trace-warnings',
    }
    const h = await harness(() => 'auto', env)
    await send(h, 'Bash', { command: 'echo environment' })
    expect(h.wrapped[0]?.env).toEqual({
      PATH: '/bin',
      HOME: '/home/test',
      JAVA_HOME: '/java',
      NODE_OPTIONS: '--trace-warnings',
    })
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
})
