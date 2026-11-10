/* oxlint-disable no-await-in-loop -- each scenario exercises ordered persistent permissions */
/* oxlint-disable vitest/no-conditional-expect -- modes and release actions have different documented results */
import { expect, it } from 'vitest'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createTape,
} from '../../src/index.js'
import type {
  DenyOpinion,
  InspectorRegistration,
  PermissionDecidedPayload,
  StreamEvent,
} from '../../src/index.js'
import { readSessionEntries } from '../../src/loop/batch.js'
import { sandboxReleaseEntry } from '../../src/loop/sandbox-release.js'
import { validInspectorReleases } from '../../src/permission/inspector-release.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import {
  inspectorOverrideKey,
  permissionDecidedKey,
  toolCallKey,
  toolOutcomeKey,
  compactionAnchorKey,
} from '../../src/tape/provenance.js'
import { lookSource, pendingCard } from '../loop/support.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const WORK = absolutePath('/work')
const COMMAND = { command: 'blocked command', description: 'original description', timeout: 1000 }
const MODEL = {
  id: 'overrides',
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
const done = () => scriptedTurn({ deltas: ['done'] })
const tool = (name = 'Bash', input: Record<string, unknown> = COMMAND): StreamEvent[] => [
  { type: 'tool-call-start', index: 0, id: 'call', name },
  { type: 'tool-call-end', index: 0, id: 'call', name, input },
  stopEvent('tool-use', 'tool_use'),
]
async function harness(mode: 'manual' | 'auto' = 'auto') {
  const memory = createMemoryHost()
  await memory.fs.mkdirp(WORK)
  await memory.fs.mkdirp(absolutePath('/outside'))
  const host = {
    ...memory,
    sandbox: {
      wrap: memory.sandbox.wrap.bind(memory.sandbox),
      afterExit: memory.sandbox.afterExit.bind(memory.sandbox),
      violations: memory.sandbox.violations.bind(memory.sandbox),
      posture: () => ({ state: 'active' as const, profile: 'workspace-write' as const }),
    },
  }
  const store = createMemoryTapeStore({ identity: host.identity })
  const tape = createTape(store)
  const ids = createCounterIds()
  const provider = createScriptedProvider({ models: [MODEL] })
  let opinion: DenyOpinion = { kind: 'deny', category: 'control-characters', findings: [] }
  const inspectors: InspectorRegistration[] = [
    {
      id: 'hygiene',
      ceiling: 'deny',
      kind: 'local-rule',
      beforeCall: async ({ call }) =>
        call.tool.originalName === 'Agent' ? { kind: 'none' } : opinion,
    },
  ]
  let disabled = false
  const make = (bind = true) => {
    const loop = createTestLoopPorts({
      connector: { provider, model: MODEL, mcpSources: [lookSource([])] },
    })
    const service = createTestSessionService(
      {
        host,
        tape: store,
        ids,
        inspectors,
        protectedFiles: [],
        connector: loop.connector,
        approvalModeDefault: () => mode,
        userSetting: () => (disabled ? { userSetting: 'never' } : null),
      },
      { tools: { Agent: 'real' } },
    )
    if (bind)
      service.bindLoop({
        ...loop,
        sandbox: {
          autoCommands: () => 'yes',
          canReach: () => false,
          beforeWrap: () => {},
          grantsChanged: () => {},
        },
      })
    return { service, loop }
  }
  const { service, loop } = make()
  await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: WORK })
  memory.snapshots.setStatus(SESSION, 'tree')
  const entries = (sessionId = SESSION) => readSessionEntries(tape, sessionId)
  const decisions = async () =>
    (await entries())
      .filter((entry) => entry.name === 'tool/permission_decided')
      .map((entry) => entry.payload as PermissionDecidedPayload)
  const rootEnd = async () => {
    for (;;) {
      const end = await loop.runEnded()
      if (end.sessionId === SESSION) return end
    }
  }
  const send = async (
    name = 'Bash',
    input: Record<string, unknown> = COMMAND,
    terminal: StreamEvent[] = done(),
  ) => {
    provider.script(tool(name, input))
    provider.script(terminal)
    await service.send({ sessionId: SESSION, origin: null, text: 'next' })
    return rootEnd()
  }
  const lastCall = async () => {
    const call = (await entries()).findLast((entry) => entry.name === 'tool/call')!
    return { call, callKey: `${call.sourceId}:${call.sourceSeq}:${call.payload['ordinal']}` }
  }
  const release = async () =>
    service.releaseInspector({ sessionId: SESSION, callKey: (await lastCall()).callKey })
  const allow = async () => {
    const pending = pendingCard(await service.currentPending({ sessionId: SESSION }))
    if (pending === null) throw new Error('missing card')
    expect(
      (
        await service.answer({
          kind: 'approval',
          sessionId: pending.card.sessionId,
          requestId: pending.card.requestId,
          decision: 'allow',
          origin: null,
        })
      ).status,
    ).toBe('applied')
    return rootEnd()
  }
  return {
    memory,
    host,
    store,
    tape,
    provider,
    service,
    loop,
    make,
    entries,
    decisions,
    rootEnd,
    send,
    release,
    lastCall,
    allow,
    inspectors,
    setOpinion: (next: DenyOpinion) => {
      opinion = next
    },
    disable: () => {
      disabled = true
    },
  }
}
type H = Awaited<ReturnType<typeof harness>>
async function seedSandboxReceipt(h: H) {
  const head = await h.tape.head(SESSION)
  if (head === null) throw new Error('missing session')
  const fields = {
    sourceType: 'runtime_event' as const,
    sourceId: OTHER,
    sourceSeq: 0,
    createdAt: 0,
  }
  const ref = { ordinal: 0, providerToolCallId: 'sandbox-receipt' }
  await h.tape.appendEntries({
    sessionId: SESSION,
    incarnationId: head.incarnationId,
    entries: [
      h.tape.writer('tool').entry('tool/call', {
        ...fields,
        provenanceKey: toolCallKey(OTHER, 0, 0),
        payload: {
          ...ref,
          messageId: OTHER,
          name: 'Bash',
          input: COMMAND,
          argsHash: 'sandbox-history',
        },
      }),
      h.tape.writer('tool').entry('tool/permission_decided', {
        ...fields,
        provenanceKey: permissionDecidedKey(OTHER, 0, 0),
        payload: {
          ...ref,
          argsHash: 'sandbox-history',
          reversibility: 'unknown',
          record: { verdict: 'allow', decidedBy: 'approval-mode', steps: [] },
          summary: { verdict: 'allow', code: 'auto-mode', facts: { toolName: 'Bash' } },
          policyVersion: 'empty',
          target: { type: 'command', command: COMMAND.command, cwd: WORK },
          writer: { by: 'resolver' },
        },
      }),
      h.tape.writer('execution').entry('execution/tool_outcome', {
        ...fields,
        provenanceKey: toolOutcomeKey(OTHER, 0, 0),
        payload: {
          ...ref,
          state: 'completed',
          effect: 'external',
          source: 'sandbox',
          kernelAuthored: false,
          writer: { by: 'resolver' },
          sandbox: {
            more: 0,
            anyProtected: false,
            violations: [
              {
                kind: 'fs',
                target: '/outside/file',
                release: 'path',
                protected: false,
                observed: false,
              },
            ],
          },
        },
      }),
    ],
  })
}

it.each(['manual', 'auto'] as const)(
  '06 验收 21: an inspector override binds the next identical call once and expires',
  async (mode) => {
    const h = await harness(mode)
    expect((await h.send()).reason.code).toBe('completed')
    const { call, callKey } = await h.lastCall()
    expect(await h.release()).toEqual({ status: 'released' })
    expect(await h.release()).toEqual({ status: 'already-released' })
    const release = (await h.entries()).at(-1)!
    const key = inspectorOverrideKey(
      call.sourceId!,
      call.sourceSeq!,
      Number(call.payload['ordinal']),
    )
    expect(release).toMatchObject({
      name: 'tool/inspector_override',
      provenanceKey: key,
      payload: {
        toolName: 'Bash',
        argsHash: call.payload['argsHash'],
        inspectorIds: ['hygiene'],
        via: 'receipt-override',
      },
    })
    expect((await h.entries()).filter((entry) => entry.name === 'tool/receipt_override')).toEqual(
      [],
    )
    const end = await h.send()
    expect(end.reason.code).toBe(mode === 'manual' ? 'paused' : 'completed')
    const bound = (await h.decisions()).at(-1)!
    expect(bound.inspectorOverride).toEqual({ key })
    expect(bound.record.steps.find((step) => step.inspectorId === 'hygiene')).toMatchObject({
      said: 'none',
      basis: { override: key },
    })
    if (mode === 'manual') {
      expect((await h.allow()).reason.code).toBe('completed')
      expect(
        (await h.entries()).findLast((entry) => entry.name === 'execution/dispatch_committed')
          ?.payload['decisionKey'],
      ).toBe(
        (await h.entries()).findLast((entry) => entry.name === 'tool/permission_decided')
          ?.provenanceKey,
      )
    }
    expect((await h.send()).reason.code).toBe('completed')
    expect((await h.decisions()).at(-1)?.record).toMatchObject({
      verdict: 'deny',
      decidedBy: 'inspector',
    })
    expect((await h.decisions()).at(-1)?.inspectorOverride).toBeUndefined()
    expect(await h.service.releaseInspector({ sessionId: OTHER, callKey })).toEqual({
      status: 'not-found',
    })
    expect(await h.make(false).service.releaseInspector({ sessionId: SESSION, callKey })).toEqual({
      status: 'refused',
    })
    await h.service.resetSession(SESSION)
    expect(await h.service.releaseInspector({ sessionId: SESSION, callKey })).toEqual({
      status: 'not-found',
    })
  },
)

it('06 验收 21: an inspector override binds the next identical call once and expires', async () => {
  for (const mismatch of [
    { ...COMMAND, command: 'blocked command!' },
    { ...COMMAND, description: 'different description' },
    { ...COMMAND, timeout: 1001 },
  ]) {
    const h = await harness()
    await h.send()
    await h.release()
    await h.send('Bash', mismatch)
    expect((await h.decisions()).at(-1)).toMatchObject({ record: { verdict: 'deny' } })
    expect((await h.decisions()).at(-1)?.inspectorOverride).toBeUndefined()
  }
  for (const continuing of [false, true]) {
    const h = await harness()
    await h.send('Bash', COMMAND, continuing ? [stopEvent('max-tokens', 'max_tokens')] : done())
    await h.release()
    h.provider.script(done())
    if (continuing)
      expect(await h.service.continueRun({ sessionId: SESSION, origin: null })).toEqual({
        status: 'started',
      })
    else await h.service.send({ sessionId: SESSION, origin: null, text: 'no tool needed' })
    await h.rootEnd()
    await h.send()
    expect((await h.decisions()).at(-1)?.record.verdict).toBe('deny')
    expect((await h.decisions()).at(-1)?.inspectorOverride).toBeUndefined()
  }
})

it('06 验收 21: an inspector override binds the next identical call once and expires', async () => {
  const h = await harness()
  await h.send()
  await h.release()
  await seedSandboxReceipt(h)
  expect(
    await h.service.release({
      sessionId: SESSION,
      callKey: `${OTHER}:0:0`,
      action: 'allow-path',
      target: '/outside/file',
    }),
  ).toEqual({ status: 'released' })
  await h.send()
  const bound = (await h.decisions()).at(-1)!
  expect(bound.record.verdict).toBe('allow')
  expect(bound.inspectorOverride?.key).toBeDefined()
  expect(bound.sandbox?.override).toMatchObject({ action: 'allow-path', path: '/outside/file' })
  expect(bound.sandbox?.override?.key).not.toBe(bound.inspectorOverride?.key)
  expect(validInspectorReleases(await h.entries())).toEqual([])
})

it('06 验收 21: an inspector override binds the next identical call once and expires', async () => {
  const h = await harness()
  await h.send()
  const { callKey } = await h.lastCall()
  expect(
    await Promise.all([
      h.service.releaseInspector({ sessionId: SESSION, callKey }),
      h.service.releaseInspector({ sessionId: SESSION, callKey }),
    ]),
  ).toEqual([{ status: 'released' }, { status: 'already-released' }])
  expect(
    (await h.entries()).filter((entry) => entry.name === 'tool/inspector_override'),
  ).toHaveLength(1)
  await h.send('fs__look', COMMAND)
  expect((await h.decisions()).at(-1)?.record.verdict).toBe('deny')
  expect((await h.decisions()).at(-1)?.inspectorOverride).toBeUndefined()
})

it('06 验收 21: an inspector override binds the next identical call once and expires', async () => {
  const h = await harness()
  await h.send()
  await h.release()
  h.memory.setPolicy({
    status: 'current',
    version: 'deny',
    snapshot: {
      tools: [{ policyId: 'deny', serverId: 'builtin', toolName: 'Bash', effect: 'deny' }],
    },
  })
  await h.send()
  expect((await h.decisions()).at(-1)).toMatchObject({
    record: { verdict: 'deny', decidedBy: 'tenant-policy' },
    inspectorOverride: { key: expect.any(String) },
  })
  expect(await h.release()).toEqual({ status: 'stale' })
  h.memory.setPolicy({ status: 'current', version: 'empty', snapshot: { tools: [] } })
  await h.send()
  expect((await h.decisions()).at(-1)?.record).toMatchObject({
    verdict: 'deny',
    decidedBy: 'inspector',
  })
  expect((await h.decisions()).at(-1)?.inspectorOverride).toBeUndefined()
  const protectedCall = await h.send('Read', { file_path: `${h.host.identity.profileDir}/data` })
  expect(protectedCall.reason.code).toBe('completed')
  expect(await h.release()).toEqual({ status: 'stale' })
  // Freeze a connector in the table first, then disable it while inspection is in flight.
  h.inspectors.push({
    id: 'enable-never',
    ceiling: 'ask',
    kind: 'local-rule',
    beforeCall: async ({ call }) => {
      if (call.tool.source === 'mcp') h.disable()
      return { kind: 'none' }
    },
  })
  await h.send('fs__look', {})
  expect((await h.decisions()).at(-1)?.record.decidedBy).toBe('user-disabled')
  expect(await h.release()).toEqual({ status: 'stale' })
  const before = await h.entries()
  expect(await h.service.releaseInspector({ sessionId: SESSION, callKey: 'invalid:0:0' })).toEqual({
    status: 'not-found',
  })
  expect(await h.entries()).toEqual(before)
})

it('06 验收 21: an inspector override binds the next identical call once and expires', async () => {
  const h = await harness()
  await h.send()
  const original = await h.lastCall()
  h.setOpinion({ kind: 'ask', category: 'hidden-characters', findings: [] })
  expect((await h.send()).reason.code).toBe('paused')
  expect(
    await h.service.releaseInspector({ sessionId: SESSION, callKey: original.callKey }),
  ).toEqual({ status: 'released' })
  h.setOpinion({ kind: 'deny', category: 'control-characters', findings: [] })
  expect((await h.allow()).reason.code).toBe('completed')
  expect((await h.decisions()).at(-1)?.inspectorOverride).toBeUndefined()
  await h.send()
  expect((await h.decisions()).at(-1)?.inspectorOverride?.key).toBeDefined()
})

it('06 验收 21: an inspector override binds the next identical call once and expires', async () => {
  const h = await harness()
  await h.send()
  await h.release()
  h.provider.script(tool('Agent', { description: 'child', prompt: 'same command' }))
  h.provider.script(tool())
  h.provider.script(done())
  h.provider.script(done())
  await h.service.send({ sessionId: SESSION, origin: null, text: 'delegate' })
  await h.rootEnd()
  const handoff = (await h.entries()).findLast((entry) => entry.payload['handoff'] !== undefined)
    ?.payload['handoff'] as { childSessionId: string }
  const child = await h.entries(handoff.childSessionId)
  expect(
    child.find((entry) => entry.name === 'tool/permission_decided')?.payload['inspectorOverride'],
  ).toBeUndefined()
  const childCall = child.find((entry) => entry.name === 'tool/call')!
  expect(
    await h.service.releaseInspector({
      sessionId: handoff.childSessionId,
      callKey: `${childCall.sourceId}:${childCall.sourceSeq}:0`,
    }),
  ).toEqual({ status: 'released' })
  await h.send()
  expect((await h.decisions()).at(-1)?.record.verdict).toBe('deny')
  expect((await h.decisions()).at(-1)?.inspectorOverride).toBeUndefined()
})

it('06 验收 22: an unannounced inspector override reaches the model at the next checkpoint', async () => {
  const h = await harness()
  await h.send()
  await h.release()
  const release = (await h.entries()).at(-1)!
  h.provider.script(done())
  await h.service.send({ sessionId: SESSION, origin: null, text: 'next checkpoint' })
  await h.rootEnd()
  const notes = (await h.entries()).filter((entry) => entry.name === 'message/sandbox_release')
  expect(notes).toHaveLength(1)
  expect(notes[0]?.payload['overrides']).toEqual([release.provenanceKey])
  const request = JSON.stringify(h.provider.requests.at(-1))
  const text = `<sandbox_release>\nThe user granted the following permissions:\nThe next call to "Bash" with the same arguments (hash ${JSON.stringify(release.payload['argsHash'])}) may run once despite blocks from permission checks ["hygiene"]; all other permission checks and any required user confirmation still apply.\n</sandbox_release>`
  expect(notes[0]?.payload['content']).toEqual([{ type: 'text', text }])
  expect(request).toContain(JSON.stringify(text).slice(1, -1))
  // A completed reply expires this unbound release, even if its old note leaves context.
  const entries = await h.entries()
  const note = sandboxReleaseEntry({
    entries: entries.filter((entry) => entry.name !== 'message/sandbox_release'),
    tape: h.tape,
    now: () => 0,
    messageId: () => OTHER,
  })
  expect(note).toBeNull() // The intervening reply ended, so this release has expired.
})

it('06 验收 22: an unannounced inspector override reaches the model at the next checkpoint', async () => {
  const h = await harness()
  await h.send()
  await h.release()
  const release = (await h.entries()).at(-1)!
  const makeNote = async () =>
    sandboxReleaseEntry({
      entries: await h.entries(),
      tape: h.tape,
      now: () => 0,
      messageId: () => OTHER,
    })
  const note = await makeNote()
  if (note === null) throw new Error('missing unannounced release')
  const head = (await h.tape.head(SESSION))!
  await h.tape.appendEntries({
    sessionId: SESSION,
    incarnationId: head.incarnationId,
    entries: [note],
  })
  expect(await makeNote()).toBeNull()
  const before = (await h.entries()).at(-1)!
  await h.tape.writer('compaction').write({
    sessionId: SESSION,
    incarnationId: head.incarnationId,
    fact: {
      name: 'compaction/anchor',
      fields: {
        sourceType: 'runtime_event',
        sourceId: OTHER,
        sourceSeq: 10,
        provenanceKey: compactionAnchorKey(OTHER, 10),
        createdAt: 0,
        payload: {
          keepFromEntryId: before.entryId + 1,
          coversThroughEntryId: before.entryId,
          summary: 'summary',
          summarizer: { providerId: 'anthropic', modelId: MODEL.id },
          trigger: { code: 'threshold', estimatedInputTokens: 160000, thresholdTokens: 150000 },
          generation: 1,
        },
      },
    },
  })
  const announcedAgain = await makeNote()
  expect(announcedAgain?.payload['overrides']).toEqual([release.provenanceKey])
  expect(announcedAgain?.payload['content']).toEqual(note.payload['content'])
})

it('06 验收 21: an inspector override binds the next identical call once and expires', async () => {
  const h = await harness()
  await h.send()
  h.inspectors.push({
    id: 'another-check',
    kind: 'local-rule',
    ceiling: 'deny',
    beforeCall: async () => ({ kind: 'deny', category: 'exfiltration', findings: [] }),
  })
  await h.release()
  await h.send()
  const decision = (await h.decisions()).at(-1)!
  expect(decision.record.verdict).toBe('deny')
  expect(decision.record.steps.find((step) => step.inspectorId === 'hygiene')).toMatchObject({
    said: 'none',
    basis: { override: decision.inspectorOverride?.key },
  })
  expect(decision.record.steps.find((step) => step.inspectorId === 'another-check')).toMatchObject({
    said: 'deny',
  })
})

it('refuses an inspector release if shutdown begins during its final head read', async () => {
  const h = await harness()
  await h.send()
  const { callKey } = await h.lastCall()
  const head = h.store.head.bind(h.store)
  h.store.head = async (sessionId) => {
    const value = await head(sessionId)
    h.loop.beginShutdown()
    return value
  }
  expect(await h.service.releaseInspector({ sessionId: SESSION, callKey })).toEqual({
    status: 'refused',
  })
  expect((await h.entries()).filter((entry) => entry.name === 'tool/inspector_override')).toEqual(
    [],
  )
})

it('06 验收 21: an inspector override binds the next identical call once and expires', async () => {
  const h = await harness()
  await h.send()
  const before = (await h.decisions()).at(-1)!
  await h.release()
  expect(
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [absolutePath('/outside')] },
      dedicated: WORK,
    }),
  ).toMatchObject({ ok: true })
  h.memory.snapshots.setStatus(SESSION, 'tree')
  await h.send()
  const after = (await h.decisions()).at(-1)!
  expect(after.record.verdict).toBe('allow')
  expect(after.inspectorOverride?.key).toBeDefined()
  expect(after.argsHash).toBe(before.argsHash)
  expect(after.target).toMatchObject({ type: 'command', cwd: '/outside' })
})
