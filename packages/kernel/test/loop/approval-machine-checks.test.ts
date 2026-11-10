/* oxlint-disable no-await-in-loop -- each case exercises ordered Tape writes, pauses and resumes */
/* oxlint-disable vitest/no-conditional-expect -- branches assert the named platform/mode scenario */
import { expect, it, vi } from 'vitest'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createTape,
  exfiltrationInspector,
} from '../../src/index.js'
import type {
  BeforeCallInput,
  HostAdapter,
  SandboxPorts,
  InspectorRegistration,
  NewEntry,
  PermissionDecidedPayload,
  SandboxPosture,
  StreamEvent,
} from '../../src/index.js'
import { judgeCall } from '../../src/loop/batch.js'
import { receiptOverrideKey } from '../../src/tape/provenance.js'
import { grantKey } from '../../src/permission/grants.js'
import { readSessionFacts } from '../../src/session/facts.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import { fakeChild, lookSource, pendingCard, proxyStore } from './support.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const WORK = absolutePath('/work')
const FILE = absolutePath('/work/a')
const MODEL = {
  id: 'machine-checks',
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
const usage = {
  inputTokens: 5,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}
const done = () => scriptedTurn({ deltas: ['done'], usage })
const read = (n = 0) => ({ name: 'Read', input: { file_path: FILE, offset: n + 1 } })
const bash = { name: 'Bash', input: { command: 'echo stable' } }
const agent = { name: 'Agent', input: { description: 'child task', prompt: 'child work' } }
function calls(list: readonly { name: string; input: Record<string, unknown> }[]): StreamEvent[] {
  return [
    ...list.flatMap(({ name, input }, index): StreamEvent[] => [
      { type: 'tool-call-start', index, id: `call-${index}`, name },
      { type: 'tool-call-end', index, id: `call-${index}`, name, input },
    ]),
    { type: 'usage', usage },
    stopEvent('tool-use', 'tool_use'),
  ]
}
async function harness(mode: 'manual' | 'auto' = 'auto', realBash = false, tokenLimit?: number) {
  const memory = createMemoryHost()
  await memory.fs.mkdirp(WORK)
  await memory.fs.writeFile(FILE, 'private')
  let posture: SandboxPosture = { state: 'active', profile: 'workspace-write' }
  let reachable = false
  const spawned = vi.fn<HostAdapter['process']['spawn']>(async () => {
    const child = fakeChild(() => memory.clock.now(), 'dies')
    child.exit(0)
    return child.child
  })
  const host = {
    ...memory,
    process: { spawn: spawned },
    sandbox: {
      ...memory.sandbox,
      wrap: memory.sandbox.wrap.bind(memory.sandbox),
      afterExit: memory.sandbox.afterExit.bind(memory.sandbox),
      violations: memory.sandbox.violations.bind(memory.sandbox),
      posture: () => posture,
    },
  }
  const store = createMemoryTapeStore({ identity: memory.identity })
  const appends: Array<{ sessionId: string; entries: readonly NewEntry[] }> = []
  let onAppend: ((entries: readonly NewEntry[]) => Promise<void>) | undefined
  const recorded = proxyStore(store, {
    append: async (q, ...rest) => {
      appends.push({ sessionId: q.sessionId, entries: q.entries })
      await onAppend?.(q.entries)
      return store.append(q, ...rest)
    },
  })
  const provider = createScriptedProvider({ models: [MODEL] })
  const inspectors: InspectorRegistration[] = []
  const loop = createTestLoopPorts({
    connector: { provider, model: MODEL, mcpSources: [lookSource([])] },
  })
  const canReach = vi.fn<NonNullable<SandboxPorts['canReach']>>(() => reachable)
  const sandbox = {
    autoCommands: () => 'yes' as const,
    canReach,
    beforeWrap: () => {},
    grantsChanged: () => {},
  }
  const logs: string[] = []
  const service = createTestSessionService(
    {
      host,
      tape: recorded,
      ids: createCounterIds(),
      connector: loop.connector,
      inspectors,
      protectedFiles: [],
      approvalModeDefault: () => mode,
      log: (line) => logs.push(line),
    },
    {
      tools: { Agent: 'real', ...(realBash ? { Bash: 'real' as const } : {}) },
      ...(tokenLimit === undefined ? {} : { tokenLimit }),
    },
  )
  service.bindLoop({ ...loop, sandbox })
  await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: WORK })
  memory.snapshots.setStatus(SESSION, 'tree')
  const tape = createTape(recorded)
  const entries = async (sessionId = SESSION) =>
    (await store.readRange({ sessionId, limit: 1000 })).entries
  const rootEnd = async () => {
    for (;;) {
      const end = await loop.runEnded()
      if (end.sessionId === SESSION) return end
    }
  }
  const send = async (list: Parameters<typeof calls>[0], text = 'next step') => {
    provider.script(calls(list))
    provider.script(done())
    await service.send({ sessionId: SESSION, origin: null, text })
    return rootEnd()
  }
  const allow = async () => {
    const p = pendingCard(await service.currentPending({ sessionId: SESSION }))
    if (p === null) throw new Error('no approval')
    expect(
      (
        await service.answer({
          kind: 'approval',
          sessionId: p.card.sessionId,
          requestId: p.card.requestId,
          decision: 'allow',
          origin: null,
        })
      ).status,
    ).toBe('applied')
    return rootEnd()
  }
  const judge = (signal = new AbortController().signal) =>
    judgeCall(
      {
        tape,
        host,
        sandbox,
        sessionId: SESSION,
        writer: { by: 'resolver' },
        inspectors,
        protectedFiles: [],
        userSetting: () => null,
        searchHost: null,
        signal,
      },
      {
        name: 'Bash',
        originalName: 'Bash',
        source: 'builtin',
        serverId: 'builtin',
        requiresUserInteraction: false,
        spec: { name: 'Bash', description: '', inputSchema: { type: 'object' } },
      },
      { input: bash.input },
    )
  return {
    memory,
    host,
    store,
    tape,
    appends,
    recorded,
    provider,
    service,
    loop,
    inspectors,
    sandbox,
    canReach,
    spawned,
    logs,
    entries,
    rootEnd,
    send,
    allow,
    judge,
    interceptAppend: (hook: typeof onAppend) => {
      onAppend = hook
    },
    setPosture: (p: SandboxPosture) => {
      posture = p
    },
    setReachable: (value: boolean) => {
      reachable = value
    },
  }
}
type H = Awaited<ReturnType<typeof harness>>
async function history(h: H, source: 'web' | 'connector', privateRead = true) {
  const list = privateRead ? [read()] : []
  const end = await h.send([
    ...list,
    source === 'web'
      ? { name: 'WebFetch', input: { url: 'https://example.com/page' } }
      : { name: 'fs__look', input: { at: 'remote' } },
  ])
  expect(end.reason.code).toBe('paused')
  expect((await h.allow()).reason.code).toBe('completed')
}
it.each(['canReach', 'full-access', 'missing-query', 'connector'] as const)(
  '06 验收 18: after private data and untrusted content a command that can reach out via %s asks once',
  async (via) => {
    for (const mode of ['manual', 'auto'] as const) {
      const h = await harness('manual')
      // A durable session command grant must not exempt it from the machine check.
      expect((await h.send([bash])).reason.code).toBe('paused')
      await h.allow()
      await h.service.setApprovalMode({ sessionId: SESSION, mode })
      await history(h, via === 'connector' ? 'connector' : 'web')
      h.inspectors.push(exfiltrationInspector)
      const inputs: BeforeCallInput[] = []
      h.inspectors.push({
        id: 'record',
        kind: 'local-rule',
        ceiling: 'ask',
        beforeCall: async (input) => {
          inputs.push(input)
          return { kind: 'none' }
        },
      })
      h.setReachable(via !== 'full-access')
      if (via === 'full-access') h.setPosture({ state: 'unavailable', profile: 'read-only' })
      if (via === 'missing-query') Reflect.deleteProperty(h.sandbox, 'canReach')
      expect((await h.send([bash])).reason.code).toBe('paused')
      const p = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
      expect(p).toMatchObject({
        allowScope: 'once',
        card: { reason: 'command', facts: { category: 'exfiltration' } },
      })
      expect(inputs.at(-1)?.call).toMatchObject({ canReachNetwork: true })
      expect(inputs.at(-1)?.view).not.toHaveProperty('canReachNetwork')
      expect(inputs.at(-1)?.view).not.toHaveProperty('approvalMode')
      if (via !== 'full-access' && via !== 'missing-query')
        expect(h.canReach).toHaveBeenLastCalledWith({ sessionId: SESSION, hosts: [] })
      await h.allow()
      const approval = (await h.entries()).findLast((e) => e.name === 'tool/approval_resolved')
      expect(approval?.payload['grant']).toEqual({
        scope: 'once',
        key: grantKey('builtin', 'Bash', {
          kind: 'command',
          command: bash.input.command,
          cwd: WORK,
        }),
      })
      expect((await h.send([bash])).reason.code).toBe('paused')
      expect(pendingCard(await h.service.currentPending({ sessionId: SESSION }))?.allowScope).toBe(
        'once',
      )
      expect(h.logs).toEqual([])
    }
  },
)

it('06 验收 18: after private data and untrusted content a command that can reach out via negative controls and session domains asks once', async () => {
  for (const missing of ['network', 'private', 'untrusted'] as const) {
    const h = await harness()
    if (missing !== 'untrusted') await history(h, 'web', missing !== 'private')
    else await h.send([read()])
    h.setReachable(missing !== 'network')
    h.inspectors.push(exfiltrationInspector)
    expect((await h.send([bash])).reason.code).toBe('completed')
  }
  const h = await harness()
  await h.send([read()])
  const head = await h.tape.head(SESSION)
  if (head === null) throw new Error('missing head')
  await h.tape.appendEntries({
    sessionId: SESSION,
    incarnationId: head.incarnationId,
    entries: [
      h.tape.writer('tool').entry('tool/receipt_override', {
        sourceType: 'runtime_event',
        sourceId: SESSION,
        sourceSeq: 0,
        provenanceKey: receiptOverrideKey(SESSION, 0, 0, 'allow-domain', 0),
        createdAt: 0,
        payload: {
          runId: SESSION,
          requestSeq: 0,
          ordinal: 0,
          providerToolCallId: 'domain',
          action: 'allow-domain',
          target: 'granted.example',
          writer: { by: 'resolver' },
        },
      }),
    ],
  })
  await h.judge()
  expect(h.canReach).toHaveBeenLastCalledWith({ sessionId: SESSION, hosts: ['granted.example'] })
})

function heldInspector() {
  const reached = Promise.withResolvers<BeforeCallInput>()
  const released = Promise.withResolvers<void>()
  const inputs: BeforeCallInput[] = []
  const inspector: InspectorRegistration = {
    id: 'held',
    kind: 'local-rule',
    ceiling: 'ask',
    beforeCall: async (input) => {
      inputs.push(input)
      reached.resolve(input)
      await released.promise
      return { kind: 'none' }
    },
  }
  return { reached, released, inputs, inspector }
}
it('06 验收 29: a profile switch during inspection keeps the post-inspection plan and runs the checks once', async () => {
  const h = await harness()
  await h.send([read()])
  const gate = heldInspector()
  h.inspectors.push(gate.inspector)
  const pending = h.judge()
  await gate.reached.promise
  h.setPosture({ state: 'active', profile: 'read-only' })
  gate.released.resolve()
  const result = await pending
  expect(result).toMatchObject({
    kind: 'judged',
    sandbox: { profile: 'read-only', chosen: 'read-only' },
    decision: { record: { verdict: 'allow' } },
  })
  expect(gate.inputs).toHaveLength(1)
})
it('06 验收 30: pending to unavailable during inspection reruns the checks, and the third run is strict', async () => {
  for (const change of ['posture', 'allowlist', 'autoCommands'] as const) {
    const h = await harness()
    await history(h, 'web')
    if (change === 'posture') h.setPosture({ state: 'pending', profile: 'workspace-write' })
    const gate = heldInspector()
    h.inspectors.push(gate.inspector, exfiltrationInspector)
    const pending = h.judge()
    expect((await gate.reached.promise).call).toMatchObject({ canReachNetwork: false })
    if (change === 'posture') h.setPosture({ state: 'unavailable', profile: 'workspace-write' })
    else if (change === 'allowlist') h.setReachable(true)
    else Object.assign(h.sandbox, { autoCommands: () => 'no' as const })
    gate.released.resolve()
    const result = await pending
    expect(gate.inputs).toHaveLength(2)
    expect(gate.inputs.map((input) => input.call.canReachNetwork)).toEqual(
      change === 'autoCommands' ? [false, false] : [false, true],
    )
    expect(result).toMatchObject({ kind: 'judged', decision: { record: { verdict: 'ask' } } })
    if (change !== 'autoCommands')
      expect(result).toMatchObject({
        decision: {
          confirm: { facts: { category: 'exfiltration' } },
        },
      })
    if (change === 'posture')
      expect(result).toMatchObject({
        sandbox: {
          profile: 'full-access',
          unavailable: true,
        },
      })
  }
  for (const granted of [false, true]) {
    const h = await harness('manual')
    if (granted) {
      await h.send([bash])
      await h.allow()
    } else await h.send([read()])
    await h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
    const inputs: BeforeCallInput[] = []
    h.inspectors.push({
      id: 'oscillating',
      kind: 'local-rule',
      ceiling: 'ask',
      beforeCall: async (input) => {
        const released = Promise.withResolvers<void>()
        inputs.push(input)
        // Every pass is explicitly held while its caller changes the fake host.
        gates.push({ input, released })
        reached?.resolve()
        await released.promise
        return { kind: 'none' }
      },
    })
    const gates: Array<{
      input: BeforeCallInput
      released: ReturnType<typeof Promise.withResolvers<void>>
    }> = []
    let reached: ReturnType<typeof Promise.withResolvers<void>> | undefined
    reached = Promise.withResolvers<void>()
    const pending = h.judge()
    for (const [state, profile] of [
      ['pending', 'workspace-write'],
      ['active', 'workspace-write'],
      ['active', 'read-only'],
    ] as const) {
      await reached.promise
      reached = Promise.withResolvers<void>()
      h.setPosture({ state, profile })
      gates.at(-1)!.released.resolve()
    }
    const result = await pending
    expect(inputs.map((input) => input.call.canReachNetwork)).toEqual([false, false, true])
    expect(result).toMatchObject({
      kind: 'judged',
      sandbox: { profile: 'read-only' },
      decision: { record: { verdict: granted ? 'allow' : 'ask' } },
    })
    if (!granted)
      expect(result).toMatchObject({ decision: { confirm: { facts: { autoAsk: 'sandbox' } } } })
  }
  const h = await harness()
  await h.send([read()])
  const gate = heldInspector()
  h.inspectors.push(gate.inspector)
  const before = (await h.entries()).filter((e) => e.name === 'tool/permission_decided').length
  h.provider.script(calls([bash, read(1)]))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'stoppable command' })
  await gate.reached.promise
  await h.service.stop({ rootSessionId: SESSION })
  gate.released.resolve()
  expect((await h.rootEnd()).reason.code).toBe('user-stopped')
  const entries = await h.entries()
  expect(entries.filter((e) => e.name === 'tool/permission_decided')).toHaveLength(before)
  expect(
    entries
      .filter((e) => e.name === 'execution/tool_outcome')
      .slice(-2)
      .map((e) => e.payload['source']),
  ).toEqual(['stopped', 'stopped'])
})

function denialInspector(): InspectorRegistration {
  return {
    id: 'deny',
    kind: 'local-rule',
    ceiling: 'deny',
    beforeCall: async ({ call }) =>
      call.args['offset'] === 1
        ? { kind: 'deny', category: 'exfiltration', findings: [] }
        : { kind: 'none' },
  }
}
const alternating = (n: number) => Array.from({ length: n }, (_, i) => [read(), read(i + 1)]).flat()
it('06 验收 24: twenty machine denials in a round end it and downgrade auto', async () => {
  for (const mode of ['manual', 'auto'] as const) {
    const h = await harness(mode)
    h.inspectors.push(denialInspector())
    const end = await h.send([...alternating(20), read(100)])
    expect(end.reason).toEqual({ code: 'blocked-repeatedly', scope: 'round', count: 20 })
    const entries = await h.entries()
    const outcomes = entries.filter((e) => e.name === 'execution/tool_outcome')
    expect(outcomes.filter((e) => e.payload['source'] === 'inspector')).toHaveLength(20)
    expect(outcomes.slice(-2).map((e) => e.payload['source'])).toEqual([
      'blocked-repeatedly',
      'blocked-repeatedly',
    ])
    expect(
      entries
        .filter((entry) => entry.name === 'tool/result')
        .slice(-2)
        .map((entry) => entry.payload['content']),
    ).toEqual([
      [
        {
          type: 'text',
          text: 'The task reached its limit for blocked calls in this round, so it stopped and this call was not run.',
        },
      ],
      [
        {
          type: 'text',
          text: 'The task reached its limit for blocked calls in this round, so it stopped and this call was not run.',
        },
      ],
    ])
    expect(entries.filter((e) => e.name === 'tool/permission_decided')).toHaveLength(39)
    expect(h.provider.starts).toBe(1)
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
    const downgrade = h.appends.filter((batch) =>
      batch.entries.some((e) => e.payload['by'] === 'downgrade'),
    )
    expect(downgrade).toHaveLength(mode === 'auto' ? 1 : 0)
    if (mode === 'auto')
      expect(downgrade[0]!.entries.some((e) => e.name === 'execution/run_terminal')).toBe(true)
    expect(h.logs).toEqual([])
  }
})
it('06 验收 24: twenty machine denials in a round end it and downgrade auto', async () => {
  for (const mode of ['manual', 'auto'] as const) {
    const h = await harness(mode)
    h.inspectors.push(denialInspector())
    expect((await h.send([read(), read(), read(), read(10)])).reason).toEqual({
      code: 'blocked-repeatedly',
      count: 3,
    })
    expect(
      (await h.entries()).findLast((entry) => entry.name === 'tool/result')?.payload['content'],
    ).toEqual([
      {
        type: 'text',
        text: 'Several calls in a row were blocked, so the task stopped and this call was not run.',
      },
    ])
    expect((await h.entries()).filter((e) => e.payload['by'] === 'downgrade')).toHaveLength(
      mode === 'auto' ? 1 : 0,
    )
  }
  const h = await harness('auto', true)
  h.inspectors.push(denialInspector())
  h.host.sandbox.violations = async () => [
    {
      kind: 'network',
      line: 'observer network denied',
      target: 'observed.example',
      observed: true,
    },
  ]
  expect((await h.send([...alternating(19), bash])).reason.code).toBe('completed')
  expect(
    (await h.entries()).findLast((e) => e.name === 'execution/tool_outcome')?.payload,
  ).toMatchObject({ source: null, sandbox: { violations: [{ observed: true }] } })
  expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('auto')
})

it('06 验收 24: twenty machine denials in a round end it and downgrade auto', async () => {
  const h = await harness()
  h.inspectors.push(denialInspector())
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  h.interceptAppend(async (entries) => {
    if (!entries.some((entry) => entry.payload['by'] === 'downgrade')) return
    reached.resolve()
    await released.promise
  })
  const ending = h.send([...alternating(20), read(100)])
  await reached.promise
  const switching = h.service.setApprovalMode({ sessionId: SESSION, mode: 'auto' })
  released.resolve()
  expect((await ending).reason).toEqual({ code: 'blocked-repeatedly', count: 20, scope: 'round' })
  expect(await switching).toEqual({ status: 'set' })
  expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('auto')
  expect(
    (await h.entries())
      .filter((entry) => entry.name === 'session/approval_mode_set')
      .slice(-2)
      .map((entry) => entry.payload['by']),
  ).toEqual(['downgrade', 'user'])
})
it('06 验收 24: twenty machine denials in a round end it and downgrade auto', async () => {
  for (const childRound of [true, false]) {
    const h = await harness()
    h.inspectors.push(denialInspector())
    h.provider.script(calls([...alternating(childRound ? 12 : 1), agent, read(100)]))
    h.provider.script(calls(childRound ? [...alternating(8), read(100)] : [read(), read(), read()]))
    if (!childRound) h.provider.script(done())
    await h.service.send({ sessionId: SESSION, origin: null, text: 'delegate' })
    const end = await h.rootEnd()
    expect(end.reason).toEqual(
      childRound
        ? { code: 'blocked-repeatedly', scope: 'round', count: 20 }
        : { code: 'completed' },
    )
    const root = await h.entries()
    const handoff = root.find((e) => e.name === 'tool/result' && e.payload['handoff'] !== undefined)
    if (handoff === undefined) throw new Error('missing Agent handoff')
    const childId = (handoff.payload['handoff'] as { childSessionId: string }).childSessionId
    const child = await h.entries(childId)
    expect(child.findLast((e) => e.name === 'execution/run_terminal')?.payload['reason']).toEqual(
      childRound
        ? { code: 'blocked-repeatedly', scope: 'round', count: 20 }
        : { code: 'blocked-repeatedly', count: 3 },
    )
    expect(child.filter((e) => e.name === 'tool/permission_decided')).toHaveLength(
      childRound ? 15 : 3,
    )
    const downgrade = h.appends.filter((batch) =>
      batch.entries.some((e) => e.payload['by'] === 'downgrade'),
    )
    expect(downgrade).toHaveLength(1)
    expect(downgrade[0]?.sessionId).toBe(SESSION)
    expect(
      downgrade[0]?.entries.some((e) =>
        childRound
          ? e.name === 'execution/run_terminal'
          : e.provenanceKey === handoff?.provenanceKey,
      ),
    ).toBe(true)
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
    expect(h.logs).toEqual([])
  }
})
it('06 验收 24: twenty machine denials in a round end it and downgrade auto', async () => {
  const h = await harness()
  h.inspectors.push(denialInspector())
  h.provider.script(calls([...alternating(19), bash, read(100)]))
  // A card interrupts the round. Its answer rejudges the call into the twentieth denial.
  h.setPosture({ state: 'pending', profile: 'workspace-write' })
  await h.service.send({ sessionId: SESSION, origin: null, text: 'pause at nineteen' })
  expect((await h.rootEnd()).reason.code).toBe('paused')
  h.inspectors.push({
    id: 'deny-command',
    kind: 'local-rule',
    ceiling: 'deny',
    beforeCall: async ({ call }) =>
      call.tool.originalName === 'Bash'
        ? { kind: 'deny', category: 'exfiltration', findings: [] }
        : { kind: 'none' },
  })
  const starts = h.provider.starts
  expect((await h.allow()).reason).toEqual({
    code: 'blocked-repeatedly',
    scope: 'round',
    count: 20,
  })
  expect(h.provider.starts).toBe(starts)
  const entries = await h.entries()
  expect(entries.findLast((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
    source: 'blocked-repeatedly',
  })
  expect(entries.findLast((e) => e.name === 'tool/permission_decided')?.payload).toMatchObject({
    record: { verdict: 'deny' },
  } as Partial<PermissionDecidedPayload>)
})

it('06 验收 24: twenty machine denials in a round end it and downgrade auto', async () => {
  const h = await harness()
  h.inspectors.push(denialInspector())
  h.provider.script(calls(alternating(19)))
  h.provider.script([stopEvent('max-tokens', 'max_tokens')])
  await h.service.send({ sessionId: SESSION, origin: null, text: 'nineteen before truncation' })
  expect((await h.rootEnd()).reason.code).toBe('output-truncated')
  h.provider.script(calls(alternating(2)))
  h.provider.script(done())
  expect(await h.service.continueRun({ sessionId: SESSION, origin: null })).toEqual({
    status: 'started',
  })
  expect((await h.rootEnd()).reason.code).toBe('completed')
  expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('auto')
})

it('06 验收 24: twenty machine denials in a round end it and downgrade auto', async () => {
  const h = await harness('auto', false, 12)
  h.inspectors.push(denialInspector())
  h.provider.script(calls([...alternating(12), agent, read(100)]))
  h.provider.script(calls([...alternating(8), read(100)]))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'cap and usage together' })
  expect((await h.rootEnd()).reason).toEqual({
    code: 'blocked-repeatedly',
    scope: 'round',
    count: 20,
  })
  expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
})

it('06 验收 24: twenty machine denials in a round end it and downgrade auto', async () => {
  for (const round of [false, true]) {
    const h = await harness()
    h.inspectors.push(denialInspector())
    let childEnded = false
    h.interceptAppend(async (entries) => {
      if (
        entries.some(
          (entry) =>
            entry.name === 'execution/run_terminal' &&
            (entry.payload['reason'] as { code: string }).code === 'blocked-repeatedly',
        )
      )
        childEnded = true
      if (childEnded && entries.some((entry) => entry.payload['handoff'] !== undefined))
        throw new Error('crash after child cap and before Agent closure')
    })
    h.provider.script(calls([...alternating(round ? 12 : 0), agent, read(100)]))
    h.provider.script(calls(round ? [...alternating(8), read(100)] : [read(), read(), read()]))
    await h.service.send({ sessionId: SESSION, origin: null, text: 'crash gap' })
    expect((await h.rootEnd()).recorded).toBe(false)
    h.interceptAppend(undefined)
    const loop = createTestLoopPorts({ connector: { provider: h.provider, model: MODEL } })
    const service = createTestSessionService(
      {
        host: h.host,
        tape: h.recorded,
        ids: createCounterIds({ start: 1000 }),
        connector: loop.connector,
        inspectors: h.inspectors,
        protectedFiles: [],
      },
      { tools: { Agent: 'real' } },
    )
    service.bindLoop({ ...loop, sandbox: h.sandbox })
    expect((await service.recover()).errors).toEqual([])
    expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
    const recovery = h.appends.find((batch) =>
      batch.entries.some(
        (entry) =>
          entry.payload['by'] === 'downgrade' &&
          (entry.payload['writer'] as { by: string }).by === 'recovery',
      ),
    )
    expect(recovery?.sessionId).toBe(SESSION)
    expect(
      recovery?.entries.some((entry) =>
        round
          ? entry.name === 'execution/run_terminal'
          : entry.name === 'tool/result' &&
            (entry.payload['handoff'] as { outcome: string } | undefined)?.outcome === 'uncertain',
      ),
    ).toBe(true)
  }
})

it('06 验收 24: twenty machine denials in a round end it and downgrade auto', async () => {
  const h = await harness()
  h.inspectors.push(denialInspector())
  h.setPosture({ state: 'pending', profile: 'workspace-write' })
  h.provider.script(calls([...alternating(12), agent, read(100)]))
  h.provider.script(calls([bash]))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'child approval before crash' })
  expect((await h.rootEnd()).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
  const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (pending === null) throw new Error('missing child approval')
  const crashed = Promise.withResolvers<void>()
  let childEnded = false
  h.interceptAppend(async (entries) => {
    if (
      entries.some(
        (entry) =>
          entry.name === 'execution/run_terminal' &&
          (entry.payload['reason'] as { code: string }).code === 'blocked-repeatedly',
      )
    )
      childEnded = true
    if (childEnded && entries.some((entry) => entry.payload['handoff'] !== undefined)) {
      crashed.resolve()
      throw new Error('crash before parent resumes')
    }
  })
  h.provider.script(calls([...alternating(8), read(100)]))
  expect(
    (
      await h.service.answer({
        kind: 'approval',
        sessionId: pending.card.sessionId,
        requestId: pending.card.requestId,
        decision: 'allow',
        origin: null,
      })
    ).status,
  ).toBe('applied')
  await crashed.promise
  await expect.poll(() => h.loop.liveLease(SESSION)).toBeNull()
  h.interceptAppend(undefined)
  const loop = createTestLoopPorts({ connector: { provider: h.provider, model: MODEL } })
  const service = createTestSessionService(
    {
      host: h.host,
      tape: h.recorded,
      ids: createCounterIds({ start: 1000 }),
      connector: loop.connector,
      inspectors: h.inspectors,
      protectedFiles: [],
    },
    { tools: { Agent: 'real' } },
  )
  service.bindLoop({ ...loop, sandbox: h.sandbox })
  expect((await service.recover()).errors).toEqual([])
  expect((await readSessionFacts(h.tape, SESSION)).approvalMode).toBe('manual')
  const recovery = h.appends.find((batch) =>
    batch.entries.some(
      (entry) =>
        entry.payload['by'] === 'downgrade' &&
        (entry.payload['writer'] as { by: string }).by === 'recovery',
    ),
  )
  expect(
    recovery?.entries.some(
      (entry) =>
        entry.name === 'tool/result' &&
        (entry.payload['handoff'] as { outcome: string } | undefined)?.outcome === 'uncertain',
    ),
  ).toBe(true)
})
