/** Receipt release contracts and capabilities (04 step 11). All expected facts are literal. */
import { describe, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type {
  PermissionDecidedPayload,
  SandboxOutcome,
  SandboxPorts,
  SessionService,
  SandboxRequest,
} from '../../src/index.js'
import { createTape } from '../../src/tape/tape.js'
import {
  approvalResolvedKey,
  toolCallKey,
  toolOutcomeKey,
  permissionDecidedKey,
  profileSetKey,
  messageRetractedKey,
} from '../../src/tape/provenance.js'
import { sandboxDomainHosts } from '../../src/permission/sandbox-release.js'
import { decisionEntry, judgeCall, readSessionEntries } from '../../src/loop/batch.js'
import { frozenBatchOf, rejudgeWaiting, waitingOf } from '../../src/loop/answer.js'
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import { pendingCard } from '../loop/support.js'

const SESSION = 'b6e30bed-0e02-4f29-8e20-0010e83e2190'
const CHILD = 'b6e30bed-0e02-4f29-8e20-0010e83e2191'
const OTHER = 'b6e30bed-0e02-4f29-8e20-0010e83e2192'
const RECEIPT_RUN = 'b6e30bed-0e02-4f29-8e20-0010e83e2193'
const MESSAGE = 'b6e30bed-0e02-4f29-8e20-0010e83e2194'
const CALL = 'b6e30bed-0e02-4f29-8e20-0010e83e2193:0:0'
const COMMAND = 'echo hello'
const WORK = absolutePath('/work/project')
const MODEL = {
  id: 'release-model',
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
const domain = {
  kind: 'network',
  target: 'registry.example.com',
  release: 'domain',
  protected: false,
  observed: false,
} as const
const path = {
  kind: 'fs',
  target: '/outside/file.txt',
  release: 'path',
  protected: false,
  observed: false,
} as const

async function harness(profile: 'read-only' | 'workspace-write' = 'workspace-write') {
  const memory = createMemoryHost()
  await memory.fs.mkdirp(WORK)
  await memory.fs.mkdirp(absolutePath('/outside'))
  await memory.fs.mkdirp(absolutePath('/home/user'))
  const wrapped: SandboxRequest[] = []
  const beforeWrap = vi.fn<SandboxPorts['beforeWrap']>()
  const grantsChanged = vi.fn<SandboxPorts['grantsChanged']>()
  let during: (() => Promise<void>) | undefined
  const host = {
    ...memory,
    process: {
      spawn: async () => {
        await during?.()
        return {
          pid: 42,
          stdin: new WritableStream<Uint8Array>(),
          stdout: new ReadableStream<Uint8Array>({
            start(c) {
              c.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(c) {
              c.close()
            },
          }),
          exited: Promise.resolve({ code: 0, signal: null }),
          kill: async () => {},
        }
      },
    },
    sandbox: {
      afterExit: (id: string) => memory.sandbox.afterExit(id),
      violations: (id: string) => memory.sandbox.violations(id),
      posture: () => ({ state: 'active' as const, profile }),
      wrap: async (q: SandboxRequest) => {
        wrapped.push(q)
        return memory.sandbox.wrap(q)
      },
    },
  }
  const store = createMemoryTapeStore({ identity: memory.identity })
  const tape = createTape(store)
  const logs: string[] = []
  const ids = createCounterIds()
  const provider = createScriptedProvider({ models: [MODEL] })
  const shell = { path: absolutePath('/bin/sh'), env: async () => ({ HOME: '/home/user' }) }
  function serviceBound(bind = true) {
    const loop = createTestLoopPorts({ connector: { provider, model: MODEL }, commandShell: shell })
    const service = createTestSessionService(
      {
        log: (line) => logs.push(line),
        host,
        tape: store,
        ids,
        inspectors: [],
        protectedFiles: [absolutePath('/home/user/.zshrc')],
        connector: loop.connector,
      },
      { tools: { Bash: 'real', Agent: 'real' } },
    )
    if (bind) service.bindLoop({ ...loop, sandbox: { beforeWrap, grantsChanged } })
    return { service, loop }
  }
  const h = {
    logs,
    memory,
    host,
    store,
    tape,
    provider,
    ids,
    wrapped,
    beforeWrap,
    grantsChanged,
    ...serviceBound(),
    serviceBound,
    during: (fn: () => Promise<void>) => {
      during = fn
    },
    judge: {
      tape,
      host,
      inspectors: [],
      protectedFiles: [],
      userSetting: () => null,
      searchHost: null,
      signal: new AbortController().signal,
    },
  }
  await h.service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: WORK })
  await h.service.setWorkspace({
    sessionId: SESSION,
    change: { kind: 'add', folders: [WORK] },
    dedicated: WORK,
  })
  provider.script(scriptedTurn({ deltas: ['Ready.'] }))
  const sent = await h.service.send({ sessionId: SESSION, text: 'start', origin: null })
  if (sent.status !== 'started') throw new Error(sent.status)
  await h.loop.runEnded({ runId: sent.runId })
  return h
}
type Harness = Awaited<ReturnType<typeof harness>>

/** A historical receipt with its original command/cwd, independent of the current workspace. */
async function receipt(
  h: Harness,
  sandbox: SandboxOutcome | null = { violations: [domain, path], more: 0, anyProtected: false },
  sessionId = SESSION,
  name = 'Bash',
) {
  const head = await h.tape.head(sessionId)
  if (!head) throw new Error('missing session')
  const ref = { ordinal: 0, providerToolCallId: 'receipt-call' }
  const fields = {
    sourceType: 'runtime_event' as const,
    sourceId: RECEIPT_RUN,
    sourceSeq: 0,
    createdAt: 1,
  }
  await h.tape.appendEntries({
    sessionId,
    incarnationId: head.incarnationId,
    entries: [
      h.tape.writer('tool').entry('tool/call', {
        ...fields,
        provenanceKey: toolCallKey(RECEIPT_RUN, 0, 0),
        payload: {
          ...ref,
          messageId: MESSAGE,
          name,
          input: { command: COMMAND },
          argsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }),
      h.tape.writer('tool').entry('tool/permission_decided', {
        ...fields,
        provenanceKey: permissionDecidedKey(RECEIPT_RUN, 0, 0),
        payload: {
          ...ref,
          argsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          reversibility: 'unknown',
          record: { verdict: 'allow', decidedBy: 'user-grant', steps: [] },
          summary: { verdict: 'allow', code: 'session-allowed', facts: { toolName: 'Bash' } },
          target: { type: 'command', command: COMMAND, cwd: WORK },
          policyVersion: 'test',
          writer: { by: 'resolver' },
        },
      }),
      h.tape.writer('execution').entry('execution/tool_outcome', {
        ...fields,
        provenanceKey: toolOutcomeKey(RECEIPT_RUN, 0, 0),
        payload: {
          ...ref,
          state: 'completed',
          effect: 'external',
          source: 'sandbox',
          kernelAuthored: false,
          ...(sandbox === null ? {} : { sandbox }),
          writer: { by: 'resolver' },
        },
      }),
    ],
  })
}
const release = (
  service: SessionService,
  action: 'allow-domain' | 'allow-path' | 'rerun-unsandboxed',
  target: string | null,
  sessionId = SESSION,
) => service.release({ sessionId, callKey: CALL, action, target })
const done = (h: Harness) => h.provider.script(scriptedTurn({ deltas: ['Done.'] }))
function scriptCommand(h: Harness, text = COMMAND) {
  h.provider.script([
    { type: 'tool-call-start', index: 0, id: 'live-command', name: 'Bash' },
    { type: 'tool-call-end', index: 0, id: 'live-command', name: 'Bash', input: { command: text } },
    stopEvent('tool-use', 'tool_use'),
  ])
}
async function command(h: Harness, granted = false, text = COMMAND, sessionId = SESSION) {
  scriptCommand(h, text)
  if (granted) done(h)
  const sent = await h.service.send({ sessionId, text: 'run', origin: null })
  if (sent.status !== 'started') throw new Error(sent.status)
  const ended = await h.loop.runEnded({ runId: sent.runId })
  if (ended.reason.code === 'provider-error') throw new Error(JSON.stringify(h.logs))
  return ended
}
async function answer(h: Harness, decision: 'allow' | 'deny' = 'allow', sessionId = SESSION) {
  const current = pendingCard(await h.service.currentPending({ sessionId }))
  if (!current) throw new Error('expected card')
  if (decision === 'allow') done(h)
  expect(
    await h.service.answer({
      kind: 'approval',
      sessionId: current.card.sessionId,
      requestId: current.card.requestId,
      decision,
      origin: null,
    }),
  ).toEqual({ status: 'applied' })
  if (decision === 'deny') return
  const ended = await h.loop.runEnded()
  expect(ended.reason).toEqual({ code: 'completed' })
}
async function judged(h: Harness, sessionId = SESSION, text = COMMAND) {
  return judgeCall(
    { ...h.judge, sessionId },
    {
      source: 'builtin',
      serverId: 'builtin',
      originalName: 'Bash',
      name: 'Bash',
      spec: BUILTIN_TOOLS.Bash.spec({ domainFilter: false }),
      requiresUserInteraction: false,
    },
    { input: { command: text } },
  )
}
async function bindJudgement(h: Harness, sessionId = SESSION) {
  const j = await judged(h, sessionId)
  if (j.kind !== 'judged') throw new Error('stopped')
  const head = (await h.tape.head(sessionId))!
  await h.tape.appendEntries({
    sessionId,
    incarnationId: head.incarnationId,
    entries: [
      decisionEntry({
        tape: h.tape,
        now: () => 2,
        ref: { runId: RECEIPT_RUN, requestSeq: 1, ordinal: 0, providerToolCallId: 'binding' },
        argsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        judged: j,
        key: permissionDecidedKey(RECEIPT_RUN, 1, 0),
        writer: { by: 'resolver' },
      }),
    ],
  })
  return j
}
async function childSession(h: Harness) {
  await h.service.createSession({ sessionId: CHILD })
  const head = (await h.tape.head(CHILD))!
  await h.tape.writer('session').write({
    sessionId: CHILD,
    incarnationId: head.incarnationId,
    fact: {
      name: 'session/profile_set',
      fields: {
        sourceType: 'session',
        sourceId: CHILD,
        provenanceKey: profileSetKey(head.incarnationId),
        createdAt: 1,
        payload: {
          profile: 'cowork',
          subagentOf: { sessionId: SESSION, linkKey: 'session:v1:test' },
        },
      },
    },
  })
}

async function overrideAfterUnrelatedRun(action: 'allow-path' | 'rerun-unsandboxed') {
  const h = await harness()
  await receipt(h)
  await release(h.service, action, action === 'allow-path' ? '/outside/file.txt' : null)
  done(h)
  const sent = await h.service.send({
    sessionId: SESSION,
    text: 'unrelated turn',
    origin: null,
  })
  if (sent.status !== 'started') throw new Error(sent.status)
  await h.loop.runEnded({ runId: sent.runId })
  Object.assign(h, h.serviceBound())
  const j = await judged(h)
  return j.kind === 'judged' && j.sandbox?.override
}

describe('04 验收 21: domain receipt releases', () => {
  it('04 验收 21: writes one domain override and repeated clicks return already-released', async () => {
    const h = await harness()
    await receipt(h, { violations: [path, domain, domain], more: 0, anyProtected: false })
    expect(
      await Promise.all([
        release(h.service, 'allow-domain', 'registry.example.com'),
        release(h.service, 'allow-domain', 'registry.example.com'),
      ]),
    ).toEqual([{ status: 'released' }, { status: 'already-released' }])
    const entries = await readSessionEntries(h.tape, SESSION)
    const facts = entries.filter((e) => e.name === 'tool/receipt_override')
    expect(facts.map((e) => ({ key: e.provenanceKey, payload: e.payload }))).toEqual([
      {
        key: 'tool:v1:override:b6e30bed-0e02-4f29-8e20-0010e83e2193:0:0:allow-domain:1',
        payload: {
          ordinal: 0,
          providerToolCallId: 'receipt-call',
          action: 'allow-domain',
          target: 'registry.example.com',
          violation: 1,
          command: 'echo hello',
          cwd: '/work/project',
          via: 'receipt-override',
          writer: { by: 'resolver' },
        },
      },
    ])
    expect(entries.filter((e) => e.name === 'tool/approval_resolved')).toEqual([])
  })
  it('04 不变量 10: a target absent from the receipt is stale', async () => {
    const h = await harness()
    await receipt(h)
    expect(await release(h.service, 'allow-domain', 'attacker.example.com')).toEqual({
      status: 'stale',
    })
    expect(await release(h.service, 'allow-path', '/outside/other.txt')).toEqual({
      status: 'stale',
    })
    expect(await sandboxDomainHosts((id) => readSessionEntries(h.tape, id), SESSION)).toEqual([])
  })
  it.each([
    { scenario: 'no sandbox member', name: 'Bash', sandbox: null, target: 'registry.example.com' },
    {
      scenario: 'non-Bash call',
      name: 'Read',
      sandbox: { violations: [domain], more: 0, anyProtected: false },
      target: 'registry.example.com',
    },
    {
      scenario: 'target absent from the receipt',
      name: 'Bash',
      sandbox: { violations: [domain], more: 0, anyProtected: false },
      target: 'attacker.example.com',
    },
  ])('04 验收 21: returns stale for $scenario', async ({ name, sandbox, target }) => {
    const h = await harness()
    await receipt(h, sandbox, SESSION, name)
    expect(await release(h.service, 'allow-domain', target)).toEqual({ status: 'stale' })
  })
  it('an absent, malformed, cross-session or retracted call is not-found; unbound is refused', async () => {
    const h = await harness()
    expect(await release(h.service, 'allow-domain', 'registry.example.com')).toEqual({
      status: 'not-found',
    })
    await receipt(h)
    for (const callKey of ['bad', RECEIPT_RUN + ':00:0', CALL + ':1']) {
      expect(
        // oxlint-disable-next-line no-await-in-loop -- each malformed key is independently refused
        await h.service.release({
          sessionId: SESSION,
          callKey,
          action: 'rerun-unsandboxed',
          target: null,
        }),
      ).toEqual({ status: 'not-found' })
    }
    expect(await release(h.service, 'allow-domain', 'registry.example.com', OTHER)).toEqual({
      status: 'not-found',
    })
    expect(
      await release(h.serviceBound(false).service, 'allow-domain', 'registry.example.com'),
    ).toEqual({ status: 'refused' })
    const head = (await h.tape.head(SESSION))!
    await h.tape.writer('message').write({
      sessionId: SESSION,
      incarnationId: head.incarnationId,
      fact: {
        name: 'message/retracted',
        fields: {
          sourceType: 'message',
          sourceId: MESSAGE,
          provenanceKey: messageRetractedKey(MESSAGE),
          payload: { messageId: MESSAGE },
          createdAt: 2,
        },
      },
    })
    expect(await release(h.service, 'allow-domain', 'registry.example.com')).toEqual({
      status: 'not-found',
    })
  })
  it('04 验收 21: every wrap receives domain grants, including after restart', async () => {
    const h = await harness()
    await receipt(h)
    expect(await release(h.service, 'allow-domain', 'registry.example.com')).toEqual({
      status: 'released',
    })
    expect(h.grantsChanged).not.toHaveBeenCalled()
    await command(h)
    await answer(h)
    expect(h.beforeWrap).toHaveBeenLastCalledWith({
      commandId: 'live-command',
      sessionId: SESSION,
      hosts: ['registry.example.com'],
    })
    await command(h, true)
    expect(h.beforeWrap).toHaveBeenCalledTimes(2)
    Object.assign(h, h.serviceBound())
    await command(h, true)
    expect(h.beforeWrap).toHaveBeenLastCalledWith({
      commandId: 'live-command',
      sessionId: SESSION,
      hosts: ['registry.example.com'],
    })
  })
  it('04 验收 21: beforeWrap in another session excludes the released domain', async () => {
    const h = await harness()
    await receipt(h)
    await release(h.service, 'allow-domain', 'registry.example.com')
    await h.service.selectProfile({ sessionId: OTHER, profile: 'cowork', dedicated: WORK })
    await h.service.setWorkspace({
      sessionId: OTHER,
      change: { kind: 'add', folders: [WORK] },
      dedicated: WORK,
    })
    expect((await command(h, false, COMMAND, OTHER)).reason).toEqual({
      code: 'paused',
      waitingFor: 'approval',
    })
    await answer(h, 'allow', OTHER)
    expect(h.beforeWrap).toHaveBeenCalledExactlyOnceWith({
      commandId: 'live-command',
      sessionId: OTHER,
      hosts: [],
    })
  })

  it('04 验收 21: a release during the session command immediately calls grantsChanged', async () => {
    const h = await harness()
    await receipt(h)
    h.during(async () => {
      expect(await release(h.service, 'allow-domain', 'registry.example.com')).toEqual({
        status: 'released',
      })
      expect(h.grantsChanged).toHaveBeenCalledExactlyOnceWith({
        sessionId: SESSION,
        hosts: ['registry.example.com'],
      })
    })
    await command(h)
    await answer(h)
  })
  it('never treats a WebFetch approval as a command domain release', async () => {
    const h = await harness()
    await receipt(h)
    const head = (await h.tape.head(SESSION))!
    await h.tape.writer('tool').write({
      sessionId: SESSION,
      incarnationId: head.incarnationId,
      fact: {
        name: 'tool/approval_resolved',
        fields: {
          sourceType: 'runtime_event',
          sourceId: RECEIPT_RUN,
          sourceSeq: 0,
          provenanceKey: approvalResolvedKey(RECEIPT_RUN, 0, 0),
          createdAt: 1,
          payload: {
            ordinal: 0,
            providerToolCallId: 'receipt-call',
            outcome: 'allowed',
            via: 'card',
            decisionKey: permissionDecidedKey(RECEIPT_RUN, 0, 0),
            grant: {
              scope: 'session',
              key: '["builtin","WebFetch","domain","fetch.example.com"]',
            },
            writer: { by: 'resolver' },
          },
        },
      },
    })
    expect(await sandboxDomainHosts((id) => readSessionEntries(h.tape, id), SESSION)).toEqual([])
    await command(h)
    await answer(h)
    expect(h.beforeWrap).toHaveBeenLastCalledWith({
      commandId: 'live-command',
      sessionId: SESSION,
      hosts: [],
    })
  })

  it('serializes release and clear in arrival order in the root mailbox', async () => {
    const h = await harness()
    await receipt(h)
    const [released] = await Promise.all([
      release(h.service, 'allow-domain', 'registry.example.com'),
      h.service.resetSession(SESSION),
    ])
    expect(released).toEqual({ status: 'released' })
    expect(await sandboxDomainHosts((id) => readSessionEntries(h.tape, id), SESSION)).toEqual([])
    await receipt(h)
    const [, stale] = await Promise.all([
      h.service.resetSession(SESSION),
      release(h.service, 'allow-domain', 'registry.example.com'),
    ])
    expect(stale).toEqual({ status: 'not-found' })
  })

  it('04 验收 21: wraps the child with inherited hosts and restores the parent hosts', async () => {
    const h = await harness()
    await command(h)
    await answer(h)
    await receipt(h)
    await release(h.service, 'allow-domain', 'registry.example.com')
    h.beforeWrap.mockClear()
    h.grantsChanged.mockClear()
    let childId = ''
    h.during(async () => {
      const current = h.beforeWrap.mock.lastCall![0].sessionId
      if (current === SESSION) return
      childId = current
      await receipt(
        h,
        {
          violations: [
            { ...domain, target: 'child.example.com' },
            { ...domain, target: 'late.example.com' },
          ],
          more: 0,
          anyProtected: false,
        },
        current,
      )
      expect(await release(h.service, 'allow-domain', 'child.example.com', current)).toEqual({
        status: 'released',
      })
    })
    h.provider.script([
      { type: 'tool-call-start', index: 0, id: 'agent', name: 'Agent' },
      {
        type: 'tool-call-end',
        index: 0,
        id: 'agent',
        name: 'Agent',
        input: { description: 'child task', prompt: 'run echo hello' },
      },
      stopEvent('tool-use', 'tool_use'),
    ])
    scriptCommand(h)
    done(h) // child completes
    scriptCommand(h)
    done(h) // parent completes
    const sent = await h.service.send({ sessionId: SESSION, text: 'delegate', origin: null })
    if (sent.status !== 'started') throw new Error(sent.status)
    expect((await h.loop.runEnded({ runId: sent.runId })).reason).toEqual({ code: 'completed' })
    expect(childId).not.toBe('')
    expect(
      h.beforeWrap.mock.calls.map(([q]) => ({ child: q.sessionId === childId, hosts: q.hosts })),
    ).toEqual([
      { child: true, hosts: ['registry.example.com'] },
      { child: false, hosts: ['registry.example.com'] },
    ])
    expect(h.grantsChanged).toHaveBeenCalledExactlyOnceWith({
      sessionId: childId,
      hosts: ['registry.example.com', 'child.example.com'],
    })
    // A late click on the child's receipt must not install its hosts over the parent's config.
    expect(await release(h.service, 'allow-domain', 'late.example.com', childId)).toEqual({
      status: 'released',
    })
    expect(h.grantsChanged).toHaveBeenCalledTimes(1)
  })

  it('04 验收 21: inherits downward, isolates unrelated sessions and clears grants with the incarnation', async () => {
    const h = await harness()
    await receipt(h)
    await childSession(h)
    await h.service.createSession({ sessionId: OTHER })
    await release(h.service, 'allow-domain', 'registry.example.com')
    await receipt(
      h,
      { violations: [{ ...domain, target: 'child.example.com' }], more: 0, anyProtected: false },
      CHILD,
    )
    expect(await release(h.service, 'allow-domain', 'child.example.com', CHILD)).toEqual({
      status: 'released',
    })
    expect(await sandboxDomainHosts((id) => readSessionEntries(h.tape, id), CHILD)).toEqual([
      'registry.example.com',
      'child.example.com',
    ])
    expect(await sandboxDomainHosts((id) => readSessionEntries(h.tape, id), SESSION)).toEqual([
      'registry.example.com',
    ])
    expect(await sandboxDomainHosts((id) => readSessionEntries(h.tape, id), OTHER)).toEqual([])
    await h.service.resetSession(CHILD)
    expect(await sandboxDomainHosts((id) => readSessionEntries(h.tape, id), CHILD)).toEqual([
      'registry.example.com',
    ])
    await h.service.resetSession(SESSION)
    expect(await sandboxDomainHosts((id) => readSessionEntries(h.tape, id), SESSION)).toEqual([])
    expect(await release(h.service, 'allow-domain', 'registry.example.com')).toEqual({
      status: 'not-found',
    })
  })
})

describe('04 验收 22: one-off unsandboxed reruns', () => {
  it('04 不变量 18 (rerun): session grants cannot bypass the elevated card, then the next command returns to sandbox', async () => {
    const h = await harness()
    await command(h)
    await answer(h)
    await receipt(h)
    expect(await release(h.service, 'rerun-unsandboxed', null)).toEqual({ status: 'released' })
    expect(await release(h.service, 'rerun-unsandboxed', null)).toEqual({
      status: 'already-released',
    })
    const initial = await judged(h)
    expect(initial.kind === 'judged' && initial.decision.record.verdict).toBe('ask')
    expect((await command(h)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    const card = pendingCard(await h.service.currentPending({ sessionId: SESSION }))!
    expect(card.card.reason).toBe('elevated')
    expect(card.card.target).toEqual({
      type: 'command',
      command: 'echo hello',
      cwd: '/work/project',
    })
    expect(card.allowScope).toBe('once')
    const entries = await readSessionEntries(h.tape, SESSION)
    expect(
      (
        entries.findLast((e) => e.name === 'tool/permission_decided')!
          .payload as PermissionDecidedPayload
      ).sandbox,
    ).toEqual({
      profile: 'full-access',
      chosen: 'workspace-write',
      override: {
        key: 'tool:v1:override:b6e30bed-0e02-4f29-8e20-0010e83e2193:0:0:rerun-unsandboxed:0',
        action: 'rerun-unsandboxed',
      },
    })
    await answer(h)
    expect(h.wrapped.at(-1)?.profile).toBe('full-access')
    await command(h, true)
    expect(h.wrapped.at(-1)?.profile).toBe('workspace-write')
  })
  it('04 验收 22: rerun asks elevated despite a session grant and runs full-access once', async () => {
    const h = await harness('read-only')
    await command(h)
    await answer(h)
    await receipt(h)
    expect(await release(h.service, 'rerun-unsandboxed', null)).toEqual({ status: 'released' })
    expect((await command(h)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    const current = pendingCard(await h.service.currentPending({ sessionId: SESSION }))!
    expect(current.card.reason).toBe('elevated')
    expect(current.allowScope).toBe('once')
    expect(current.card.target).toEqual({
      type: 'command',
      command: 'echo hello',
      cwd: '/work/project',
    })
    const entries = await readSessionEntries(h.tape, SESSION)
    expect(
      (
        entries.findLast((e) => e.name === 'tool/permission_decided')!
          .payload as PermissionDecidedPayload
      ).sandbox,
    ).toEqual({
      profile: 'full-access',
      chosen: 'read-only',
      override: {
        key: 'tool:v1:override:b6e30bed-0e02-4f29-8e20-0010e83e2193:0:0:rerun-unsandboxed:0',
        action: 'rerun-unsandboxed',
      },
    })
    await answer(h)
    expect((await command(h, true)).reason).toEqual({ code: 'completed' })
    expect(h.wrapped.map((request) => request.profile)).toEqual([
      'read-only',
      'full-access',
      'read-only',
    ])
  })

  it('04 不变量 11: binding survives rejudgement and restart, and denial does not return it', async () => {
    const h = await harness()
    await receipt(h)
    await release(h.service, 'rerun-unsandboxed', null)
    await command(h)
    const waiting = (await waitingOf(h.tape, SESSION))!
    const { item } = await frozenBatchOf(h.tape, waiting)
    const rejudged = await rejudgeWaiting({ judge: h.judge, waiting, item, testTools: {} })
    expect(rejudged.kind).toBe('unchanged')
    expect('judged' in rejudged && rejudged.judged.sandbox).toEqual({
      profile: 'full-access',
      chosen: 'workspace-write',
      override: {
        key: 'tool:v1:override:b6e30bed-0e02-4f29-8e20-0010e83e2193:0:0:rerun-unsandboxed:0',
        action: 'rerun-unsandboxed',
      },
    })
    expect(
      (await judged(h)).kind === 'judged' && ((await judged(h)) as { sandbox?: unknown }).sandbox,
    ).toEqual({ profile: 'workspace-write', chosen: 'workspace-write' })
    Object.assign(h, h.serviceBound())
    const again = await rejudgeWaiting({ judge: h.judge, waiting, item, testTools: {} })
    expect(again.kind).toBe('unchanged')
    expect('judged' in again && again.judged.sandbox).toEqual({
      profile: 'full-access',
      chosen: 'workspace-write',
      override: {
        key: 'tool:v1:override:b6e30bed-0e02-4f29-8e20-0010e83e2193:0:0:rerun-unsandboxed:0',
        action: 'rerun-unsandboxed',
      },
    })
    await answer(h, 'deny')
    const j = await judged(h)
    expect(j.kind === 'judged' && j.sandbox).toEqual({
      profile: 'workspace-write',
      chosen: 'workspace-write',
    })
  })
  it('04 验收 22: rebuilds an unbound release from Tape without changing an already pending decision', async () => {
    const h = await harness()
    await command(h)
    await receipt(h)
    await release(h.service, 'rerun-unsandboxed', null)
    const waiting = (await waitingOf(h.tape, SESSION))!
    const { item } = await frozenBatchOf(h.tape, waiting)
    const rejudged = await rejudgeWaiting({ judge: h.judge, waiting, item, testTools: {} })
    expect('judged' in rejudged && rejudged.judged.sandbox).toEqual({
      profile: 'workspace-write',
      chosen: 'workspace-write',
    })
    Object.assign(h, h.serviceBound())
    const fresh = await judged(h)
    expect(fresh.kind === 'judged' && fresh.sandbox).toEqual({
      profile: 'full-access',
      chosen: 'workspace-write',
      override: {
        key: 'tool:v1:override:b6e30bed-0e02-4f29-8e20-0010e83e2193:0:0:rerun-unsandboxed:0',
        action: 'rerun-unsandboxed',
      },
    })
  })

  it.each(['deny', 'stop'] as const)(
    '04 验收 22: rejudgement retains the binding and %s never returns it',
    async (decision) => {
      const h = await harness()
      await receipt(h)
      await release(h.service, 'rerun-unsandboxed', null)
      await command(h)
      const waiting = (await waitingOf(h.tape, SESSION))!
      const { item } = await frozenBatchOf(h.tape, waiting)
      const rejudged = await rejudgeWaiting({ judge: h.judge, waiting, item, testTools: {} })
      expect(rejudged.kind).toBe('unchanged')
      expect('judged' in rejudged && rejudged.judged.sandbox).toEqual({
        profile: 'full-access',
        chosen: 'workspace-write',
        override: {
          key: 'tool:v1:override:b6e30bed-0e02-4f29-8e20-0010e83e2193:0:0:rerun-unsandboxed:0',
          action: 'rerun-unsandboxed',
        },
      })
      if (decision === 'deny') await answer(h, 'deny')
      else await h.service.stop({ rootSessionId: SESSION })
      const j = await judged(h)
      expect(j.kind === 'judged' && j.sandbox?.override).toBeUndefined()
    },
  )
  it('04 验收 22: requires the same session, exact command and cwd for binding', async () => {
    const h = await harness()
    await receipt(h)
    await childSession(h)
    await release(h.service, 'rerun-unsandboxed', null)
    const different = await judged(h, SESSION, 'echo hello ')
    expect(different.kind === 'judged' && different.sandbox?.override).toBeUndefined()
    const child = await judged(h, CHILD)
    expect(child.kind === 'judged' && child.sandbox?.override).toBeUndefined()
    await h.memory.fs.mkdirp(absolutePath('/other'))
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [absolutePath('/other')] },
      dedicated: WORK,
    })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'remove', folder: WORK },
      dedicated: WORK,
    })
    const moved = await judged(h)
    expect(moved.kind === 'judged' && moved.sandbox?.override).toBeUndefined()
    // The receipt still records the original cwd after the workspace was changed.
    expect(
      (await readSessionEntries(h.tape, SESSION)).find((e) => e.name === 'tool/receipt_override')
        ?.payload['cwd'],
    ).toBe('/work/project')
    await receipt(h, undefined, CHILD)
    await release(h.service, 'rerun-unsandboxed', null, CHILD)
    const parent = await judged(h)
    expect(parent.kind === 'judged' && parent.sandbox?.override).toBeUndefined()
  })
  it('04 验收 22: a click after a workspace change still binds only the receipt’s original cwd', async () => {
    const h = await harness()
    await receipt(h)
    await h.memory.fs.mkdirp(absolutePath('/other'))
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [absolutePath('/other')] },
      dedicated: WORK,
    })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'remove', folder: WORK },
      dedicated: WORK,
    })
    expect(await release(h.service, 'rerun-unsandboxed', null)).toEqual({ status: 'released' })
    const moved = await judged(h)
    expect(moved.kind === 'judged' && moved.sandbox?.override).toBeUndefined()
    expect(
      (await readSessionEntries(h.tape, SESSION)).find((e) => e.name === 'tool/receipt_override')
        ?.payload['cwd'],
    ).toBe('/work/project')
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [WORK] },
      dedicated: WORK,
    })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'remove', folder: '/other' },
      dedicated: WORK,
    })
    const original = await judged(h)
    expect(original.kind === 'judged' && original.sandbox?.override?.action).toBe(
      'rerun-unsandboxed',
    )
  })

  it('04 不变量 10: anyProtected blocks rerun even when the protected violation is beyond the saved 20', async () => {
    const h = await harness()
    await receipt(h, {
      violations: Array.from({ length: 20 }, () => domain),
      more: 1,
      anyProtected: true,
    })
    expect(await release(h.service, 'rerun-unsandboxed', null)).toEqual({ status: 'stale' })
  })
  it('04 验收 22: credential reads may rerun; anyProtected beyond twenty stays stale', async () => {
    const h = await harness()
    await receipt(h, {
      violations: [{ ...path, target: '/home/user/.ssh/config', release: null }],
      more: 0,
      anyProtected: false,
    })
    expect(await release(h.service, 'allow-path', '/home/user/.ssh/config')).toEqual({
      status: 'stale',
    })
    expect(await release(h.service, 'rerun-unsandboxed', null)).toEqual({ status: 'released' })
    const protectedReceipt = await harness()
    await receipt(protectedReceipt, {
      violations: Array.from({ length: 20 }, () => domain),
      more: 1,
      anyProtected: true,
    })
    expect(await release(protectedReceipt.service, 'rerun-unsandboxed', null)).toEqual({
      status: 'stale',
    })
  })
  it('04 验收 22: an unbound rerun expires at the end of the first Run started after the click', async () => {
    expect(await overrideAfterUnrelatedRun('rerun-unsandboxed')).toBeUndefined()
  })
  it('04 验收 22: a release during a Run can bind in that Run or the next, then expires', async () => {
    const h = await harness()
    await receipt(h)
    h.during(async () => {
      expect(await release(h.service, 'rerun-unsandboxed', null)).toEqual({ status: 'released' })
      const j = await judged(h)
      expect(j.kind === 'judged' && j.sandbox?.override?.action).toBe('rerun-unsandboxed')
    })
    await command(h)
    await answer(h)
    const j = await judged(h)
    expect(j.kind === 'judged' && j.sandbox?.override?.action).toBe('rerun-unsandboxed')
    done(h)
    const sent = await h.service.send({
      sessionId: SESSION,
      text: 'next unrelated run',
      origin: null,
    })
    if (sent.status !== 'started') throw new Error(sent.status)
    await h.loop.runEnded({ runId: sent.runId })
    const expired = await judged(h)
    expect(expired.kind === 'judged' && expired.sandbox?.override).toBeUndefined()
  })
  it('one decision binds only one release, preferring rerun over path', async () => {
    const h = await harness()
    await receipt(h)
    await release(h.service, 'allow-path', '/outside/file.txt')
    await release(h.service, 'rerun-unsandboxed', null)
    const first = await bindJudgement(h)
    expect(first.sandbox?.override?.action).toBe('rerun-unsandboxed')
    const second = await judged(h)
    expect(second.kind === 'judged' && second.sandbox?.override).toEqual({
      key: 'tool:v1:override:b6e30bed-0e02-4f29-8e20-0010e83e2193:0:0:allow-path:1',
      action: 'allow-path',
      path: '/outside/file.txt',
    })
  })
})

describe('04 验收 23: one-off path releases', () => {
  it('04 验收 23: an unbound path release expires at the end of the first Run started after the click', async () => {
    expect(await overrideAfterUnrelatedRun('allow-path')).toBeUndefined()
  })
  it.each(['workspace-write', 'read-only'] as const)(
    '04 验收 23: %s runs workspace-write with the released file once',
    async (profile) => {
      const h = await harness(profile)
      await receipt(h)
      expect(await release(h.service, 'allow-path', '/outside/file.txt')).toEqual({
        status: 'released',
      })
      expect(await release(h.service, 'allow-path', '/outside/file.txt')).toEqual({
        status: 'already-released',
      })
      await command(h)
      await answer(h)
      expect(h.wrapped.at(-1)?.profile).toBe('workspace-write')
      expect(h.wrapped.at(-1)?.workspace).toEqual(
        profile === 'read-only' ? ['/outside/file.txt'] : ['/work/project', '/outside/file.txt'],
      )
      const entries = await readSessionEntries(h.tape, SESSION)
      expect(
        entries.filter((e) => e.name === 'tool/approval_resolved').map((e) => e.payload['grant']),
      ).toEqual([
        {
          scope: 'session',
          key: '["builtin","Bash","command","echo hello","/work/project"]',
        },
      ])
      await command(h, true)
      expect(h.wrapped.at(-1)?.profile).toBe(profile)
      expect(h.wrapped.at(-1)?.workspace).toEqual(['/work/project'])
    },
  )
  it('04 验收 23: path binding matches session, command and cwd and survives rejudgement, not denial', async () => {
    const h = await harness()
    await receipt(h)
    await childSession(h)
    expect(await release(h.service, 'allow-path', '/outside/file.txt')).toEqual({
      status: 'released',
    })
    const different = await judged(h, SESSION, 'echo hello ')
    expect(different.kind === 'judged' && different.sandbox?.override).toBeUndefined()
    const child = await judged(h, CHILD)
    expect(child.kind === 'judged' && child.sandbox?.override).toBeUndefined()
    await h.memory.fs.mkdirp(absolutePath('/other'))
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [absolutePath('/other')] },
      dedicated: WORK,
    })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'remove', folder: WORK },
      dedicated: WORK,
    })
    const moved = await judged(h)
    expect(moved.kind === 'judged' && moved.sandbox?.override).toBeUndefined()
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [WORK] },
      dedicated: WORK,
    })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'remove', folder: '/other' },
      dedicated: WORK,
    })
    expect((await command(h)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    const waiting = (await waitingOf(h.tape, SESSION))!
    const { item } = await frozenBatchOf(h.tape, waiting)
    const rejudged = await rejudgeWaiting({ judge: h.judge, waiting, item, testTools: {} })
    expect(rejudged.kind).toBe('unchanged')
    expect('judged' in rejudged && rejudged.judged.sandbox).toEqual({
      profile: 'workspace-write',
      chosen: 'workspace-write',
      override: {
        key: 'tool:v1:override:b6e30bed-0e02-4f29-8e20-0010e83e2193:0:0:allow-path:1',
        action: 'allow-path',
        path: '/outside/file.txt',
      },
    })
    await answer(h, 'deny')
    const next = await judged(h)
    expect(next.kind === 'judged' && next.sandbox?.override).toBeUndefined()
  })

  it.each([
    { scenario: 'an observed write', target: '/outside/file.txt', observed: true },
    { scenario: 'a protected write', target: '/outside/file.txt', protected: true },
    { scenario: 'the home directory', target: '/home/user' },
    { scenario: 'the root directory', target: '/' },
    { scenario: 'an existing directory', target: '/outside' },
    { scenario: 'a newline-cut directory path', target: '/outside/' },
    { scenario: 'an unnormalized path', target: '/outside/../outside/file.txt' },
    { scenario: 'a missing parent directory', target: '/outside/missing/file.txt' },
    { scenario: 'a relative path', target: 'relative.txt' },
    { scenario: 'a newline in the file name', target: '/outside/new\nfile' },
    { scenario: 'an existing link', target: '/outside/alias' },
    { scenario: 'a linked parent directory', target: '/linked/file.txt' },
  ])('04 验收 23: returns stale for $scenario', async ({ scenario: _scenario, ...change }) => {
    const h = await harness()
    h.memory.symlink(absolutePath('/outside/alias'), '/outside/file.txt')
    h.memory.symlink(absolutePath('/linked'), '/outside')
    await receipt(h, { violations: [{ ...path, ...change }], more: 0, anyProtected: false })
    expect(await release(h.service, 'allow-path', change.target)).toEqual({ status: 'stale' })
  })
  it('allows an existing regular file, and a clear invalidates unbound one-off releases', async () => {
    const h = await harness()
    await h.memory.fs.writeFile(absolutePath('/outside/file.txt'), 'original')
    await receipt(h)
    expect(await release(h.service, 'allow-path', '/outside/file.txt')).toEqual({
      status: 'released',
    })
    await h.service.resetSession(SESSION)
    const j = await judged(h)
    expect(j.kind === 'judged' && j.sandbox?.override).toBeUndefined()
  })
})
