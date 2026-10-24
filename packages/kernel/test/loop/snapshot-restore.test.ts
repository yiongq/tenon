/** Spec 05 step 13: a real mailbox/Tape and memory snapshots, with scripted providers only. */
import { expect, it, vi } from 'vitest'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  readEffectiveMessages,
} from '../../src/index.js'
import type {
  HostProcess,
  PendingApproval,
  SnapshotStatus,
  StreamEvent,
  TapeStore,
} from '../../src/index.js'
import { STOP_EXIT_CONFIRM_MS, STOP_TERM_GRACE_MS } from '../../src/loop/limits.js'
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
const WORK = absolutePath('/work/project')
const FILE = absolutePath('/work/project/a.txt')
const MODEL = {
  id: 'restore-model',
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
  o: {
    status?: SnapshotStatus
    store?: (store: TapeStore) => TapeStore
    process?: HostProcess
  } = {},
) {
  const host = createMemoryHost(o.process === undefined ? {} : { process: o.process })
  await host.fs.mkdirp(WORK)
  await host.fs.writeFile(FILE, 'A')
  const inner = createMemoryTapeStore({ identity: host.identity })
  const store = o.store?.(inner) ?? inner
  const ids = createCounterIds()
  const provider = createScriptedProvider({ models: [MODEL] })
  const ports = createTestLoopPorts({ connector: { provider, model: MODEL } })
  const logs: string[] = []
  const makeService = () => {
    const service = createTestSessionService(
      {
        host,
        tape: store,
        ids,
        connector: ports.connector,
        inspectors: [],
        protectedFiles: [],
        log: (line) => logs.push(line),
      },
      { tools: { Write: 'real', Delete: 'real', Bash: 'real', Agent: 'real' } },
    )
    service.bindLoop(ports)
    return service
  }
  const service = makeService()
  await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: WORK })
  host.snapshots.setStatus(SESSION, o.status ?? 'tree')
  const entries = async (sessionId = SESSION) =>
    (await store.readRange({ sessionId, limit: 1000 })).entries
  return { host, inner, store, provider, ports, service, entries, logs, makeService, ids }
}
type Harness = Awaited<ReturnType<typeof harness>>
async function pause(
  h: Harness,
  name = 'Write',
  input: Record<string, unknown> = { file_path: FILE, content: 'B' },
) {
  h.provider.script(call(name, input))
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'change a file' })
  if (sent.status !== 'started') throw new Error('Run did not start')
  await h.ports.runEnded({ runId: sent.runId })
  const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (pending === null) throw new Error('Approval missing')
  return { pending, roundRunId: sent.runId }
}
async function approve(h: Harness, pending: PendingApproval) {
  h.provider.script(done())
  await h.service.answer({
    kind: 'approval',
    sessionId: pending.card.sessionId,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  await h.ports.runEnded()
}
async function changed(h: Harness) {
  const q = await pause(h)
  await approve(h, q.pending)
  return q.roundRunId
}
async function preview(h: Harness, roundRunId: string) {
  const result = await h.service.snapshotPreview({ sessionId: SESSION, roundRunId })
  if (!result.ok) throw new Error(result.code)
  return result.preview
}

it('05 验收 16、22: preview is read-only and returns the host preview without approval or permission facts', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const before = await h.entries()
  const spy = vi.spyOn(h.host.snapshots, 'preview')
  const result = await preview(h, roundRunId)
  expect(result.restore).toEqual([FILE])
  expect(result.conflicts).toEqual([])
  expect(spy).toHaveBeenCalledOnce()
  expect(await h.entries()).toEqual(before)
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('B')
})

it('05 验收 17、21、22: restore_started is durable before apply; restored keeps the undo id and all counts', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const p = await preview(h, roundRunId)
  const apply = h.host.snapshots.apply.bind(h.host.snapshots)
  const applied = vi.spyOn(h.host.snapshots, 'apply').mockImplementation(async (q) => {
    const started = (await h.entries()).findLast((entry) => entry.name === 'fs/restore_started')
    expect(started?.payload).toEqual({
      roundRunId,
      undoSnapshotId: q.undoSnapshotId,
      previewKey: p.previewKey,
    })
    return apply(q)
  })
  const before = await h.entries()
  const result = await h.service.snapshotRestore({
    sessionId: SESSION,
    roundRunId,
    previewKey: p.previewKey,
    overwrite: [],
  })
  expect(result).toMatchObject({
    ok: true,
    restored: 1,
    removed: 0,
    kept: 0,
    skipped: 0,
    failed: [],
  })
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('A')
  expect(applied).toHaveBeenCalledOnce()
  const facts = (await h.entries()).slice(before.length)
  expect(facts.map((entry) => entry.name)).toEqual(['fs/restore_started', 'fs/restored'])
  expect(facts[0]).toMatchObject({ sourceType: 'session', sourceId: SESSION, sourceSeq: 0 })
  expect(facts[0]!.provenanceKey).toMatch(/^fs:v1:restore_started:[0-9a-f-]+:0$/)
  expect(facts[1]!.payload).toMatchObject({
    roundRunId,
    undoSnapshotId: facts[0]!.payload['undoSnapshotId'],
    restored: 1,
    removed: 0,
    kept: 0,
    skipped: 0,
    failed: 0,
  })
})

it('05 验收 22: a refused restore_started write cancels the prepared lease and never applies', async () => {
  let fail = false
  const h = await harness({
    store: (inner) =>
      proxyStore(inner, {
        append: async (batch) => {
          if (fail && batch.entries.some((entry) => entry.name === 'fs/restore_started'))
            throw new Error('restore fact write failed')
          return inner.append(batch)
        },
      }),
  })
  const roundRunId = await changed(h)
  const p = await preview(h, roundRunId)
  const apply = vi.spyOn(h.host.snapshots, 'apply')
  const cancel = vi.spyOn(h.host.snapshots, 'cancel')
  fail = true
  await expect(
    h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).rejects.toThrow('restore fact write failed')
  expect(apply).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledOnce()
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('B')
  fail = false
  expect(
    await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).toMatchObject({ ok: true })
})

it('05 验收 18、20: restoring an earlier round keeps later edits unless the conflict is explicitly overwritten', async () => {
  const h = await harness()
  const first = await changed(h)
  h.provider.script(call('Write', { file_path: FILE, content: 'C' }, 'later'))
  h.provider.script(done())
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'later round' })
  if (sent.status !== 'started') throw new Error('Later run did not start')
  await h.ports.runEnded({ runId: sent.runId })
  const p = await preview(h, first)
  expect(p.conflicts).toEqual([FILE])
  expect(
    await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId: first,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).toMatchObject({ ok: true, restored: 0, kept: 1 })
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('C')
  await expect(
    h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId: first,
      previewKey: p.previewKey,
      overwrite: [absolutePath('/forged')],
    }),
  ).rejects.toThrow('subset')
  const again = await preview(h, first)
  expect(
    await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId: first,
      previewKey: again.previewKey,
      overwrite: [FILE],
    }),
  ).toMatchObject({ ok: true, restored: 1 })
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('A')
})

it('05 验收 22: stale state refuses before applying or writing restore facts', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const p = await preview(h, roundRunId)
  await h.host.fs.writeFile(FILE, 'external')
  const apply = vi.spyOn(h.host.snapshots, 'apply')
  expect(
    await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).toEqual({ ok: false, code: 'stale' })
  expect(apply).not.toHaveBeenCalled()
  expect((await h.entries()).filter((entry) => entry.name.startsWith('fs/restore'))).toEqual([])
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('external')
})

it.each(['busy', 'stale', 'undo-unavailable', 'over-budget', 'gone'] as const)(
  '05 验收 21、22: prepare refusal %s is returned unchanged without restore facts',
  async (reason) => {
    const h = await harness()
    const roundRunId = await changed(h)
    const p = await preview(h, roundRunId)
    vi.spyOn(h.host.snapshots, 'prepare').mockResolvedValueOnce({ ok: false, reason })
    const apply = vi.spyOn(h.host.snapshots, 'apply')
    expect(
      await h.service.snapshotRestore({
        sessionId: SESSION,
        roundRunId,
        previewKey: p.previewKey,
        overwrite: [],
      }),
    ).toEqual({ ok: false, code: reason })
    expect(apply).not.toHaveBeenCalled()
    expect((await h.entries()).filter((entry) => entry.name.startsWith('fs/restore'))).toEqual([])
  },
)

it('05 验收 21、52: collected snapshots must all be alive and non-task sessions are refused', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const p = await preview(h, roundRunId)
  const alive = vi.spyOn(h.host.snapshots, 'alive').mockResolvedValueOnce(new Set())
  const prepare = vi.spyOn(h.host.snapshots, 'prepare')
  expect(
    await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).toEqual({ ok: false, code: 'gone' })
  expect(alive).toHaveBeenCalledWith(
    SESSION,
    expect.arrayContaining(
      (await h.entries())
        .filter((entry) => entry.name === 'fs/snapshot_created')
        .map((entry) => entry.payload['snapshotId']),
    ),
  )
  expect(prepare).not.toHaveBeenCalled()
  await h.service.createSession({ sessionId: OTHER })
  expect(
    await h.service.snapshotRestore({
      sessionId: OTHER,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).toEqual({ ok: false, code: 'not-cowork' })
  expect(
    await h.service.snapshotPreview({
      sessionId: '33333333-3333-4333-8333-333333333333',
      roundRunId,
    }),
  ).toEqual({ ok: false, code: 'gone' })
})

async function liveRun(h: Harness, sessionId: string, folder = WORK) {
  if (sessionId !== SESSION)
    await h.service.selectProfile({ sessionId, profile: 'cowork', dedicated: folder })
  h.provider.script(done())
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const stream = h.provider.stream.bind(h.provider)
  vi.spyOn(h.provider, 'stream').mockImplementationOnce((request, context) =>
    (async function* () {
      entered.resolve()
      await released.promise
      yield* stream(request, context)
    })(),
  )
  const sent = await h.service.send({ sessionId, origin: null, text: 'stay active' })
  if (sent.status !== 'started') throw new Error('Live run did not start')
  await entered.promise
  return {
    runId: sent.runId,
    release: async () => {
      released.resolve()
      await h.ports.runEnded({ runId: sent.runId })
    },
  }
}

it.each([
  'same session',
  'other session',
  'ancestor workspace',
  'descendant workspace',
  'unrelated workspace',
] as const)(
  '05 验收 22、53: a live Run in %s is checked across session mailboxes',
  async (scope) => {
    const h = await harness()
    const roundRunId = await changed(h)
    const p = await preview(h, roundRunId)
    const otherFolder =
      scope === 'ancestor workspace'
        ? absolutePath('/work')
        : scope === 'descendant workspace'
          ? absolutePath('/work/project/sub')
          : scope === 'unrelated workspace'
            ? absolutePath('/elsewhere')
            : WORK
    await h.host.fs.mkdirp(otherFolder)
    const live = await liveRun(h, scope === 'same session' ? SESSION : OTHER, otherFolder)
    try {
      const result = await h.service.snapshotRestore({
        sessionId: SESSION,
        roundRunId,
        previewKey: p.previewKey,
        overwrite: [],
      })
      expect(result.ok).toBe(scope === 'unrelated workspace')
      expect(result).toMatchObject(
        scope === 'unrelated workspace' ? { ok: true, restored: 1 } : { ok: false, code: 'busy' },
      )
    } finally {
      await live.release()
    }
  },
)

it('05 验收 22、53: a Run that starts while prepare is in flight cancels the prepared restore', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const p = await preview(h, roundRunId)
  const prepare = h.host.snapshots.prepare.bind(h.host.snapshots)
  let live: Awaited<ReturnType<typeof liveRun>> | undefined
  vi.spyOn(h.host.snapshots, 'prepare').mockImplementationOnce(async (q) => {
    const prepared = await prepare(q)
    live = await liveRun(h, OTHER)
    return prepared
  })
  const cancel = vi.spyOn(h.host.snapshots, 'cancel')
  try {
    expect(
      await h.service.snapshotRestore({
        sessionId: SESSION,
        roundRunId,
        previewKey: p.previewKey,
        overwrite: [],
      }),
    ).toEqual({ ok: false, code: 'busy' })
  } finally {
    await live?.release()
  }
  expect(cancel).toHaveBeenCalledOnce()
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('B')
  expect((await h.entries()).filter((entry) => entry.name === 'fs/restore_started')).toEqual([])
})

it('05 验收 22、53: a stopped Run with an unexited command stays busy until its real cleanup', async () => {
  const child = fakeChild(() => 0, 'hangs')
  // This process produces no output. Keep the exit controller independent of stream cancellation.
  const spawn = vi.fn<HostProcess['spawn']>(async () => ({
    ...child.child,
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
  }))
  const h = await harness({ process: { spawn } })
  const { pending, roundRunId } = await pause(h, 'Bash', { command: 'change a file' })
  await answerCard(h, pending)
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
  await h.host.fs.writeFile(FILE, 'B')
  const cleanup = vi.spyOn(h.host.sandbox, 'afterExit')
  try {
    await h.service.stop({ rootSessionId: SESSION })
    await vi.waitFor(() => expect(child.kills.map((kill) => kill.signal)).toEqual(['SIGTERM']))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    h.host.advance(STOP_TERM_GRACE_MS)
    await vi.waitFor(() =>
      expect(child.kills.map((kill) => kill.signal)).toEqual(['SIGTERM', 'SIGKILL']),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    h.host.advance(STOP_EXIT_CONFIRM_MS)
    expect((await h.ports.runEnded()).reason).toEqual({ code: 'user-stopped' })
    expect(cleanup).not.toHaveBeenCalled()
    const p = await preview(h, roundRunId)
    expect(
      await h.service.snapshotRestore({
        sessionId: SESSION,
        roundRunId,
        previewKey: p.previewKey,
        overwrite: [FILE],
      }),
    ).toEqual({ ok: false, code: 'busy' })
    expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('B')
    child.exit(0)
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
    const fresh = await preview(h, roundRunId)
    expect(
      await h.service.snapshotRestore({
        sessionId: SESSION,
        roundRunId,
        previewKey: fresh.previewKey,
        overwrite: [FILE],
      }),
    ).toMatchObject({ ok: true, restored: 1 })
    expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('A')
  } finally {
    child.exit(0)
  }
})

it('05 验收 16、22: preview and restore commands serialize through the root mailbox', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const p = await preview(h, roundRunId)
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const original = h.host.snapshots.prepare.bind(h.host.snapshots)
  vi.spyOn(h.host.snapshots, 'prepare').mockImplementationOnce(async (q) => {
    entered.resolve()
    await gate.promise
    return original(q)
  })
  const peek = vi.spyOn(h.host.snapshots, 'preview')
  const restoring = h.service.snapshotRestore({
    sessionId: SESSION,
    roundRunId,
    previewKey: p.previewKey,
    overwrite: [],
  })
  await entered.promise
  const previewing = h.service.snapshotPreview({ sessionId: SESSION, roundRunId })
  await Promise.resolve()
  expect(peek).toHaveBeenCalledOnce()
  gate.resolve()
  expect(await restoring).toMatchObject({ ok: true })
  expect(await previewing).toMatchObject({
    ok: true,
    preview: { restore: [], remove: [], conflicts: [] },
  })
  expect(peek).toHaveBeenCalledTimes(2)
})

it.each(['tree', 'warming', 'file-only'] as const)(
  '05 验收 52: %s promised calls are listed and safely restore; invalidated promises mark incomplete coverage',
  async (status) => {
    const h = await harness({ status })
    const roundRunId = await changed(h)
    expect(await h.service.snapshotRounds({ sessionId: SESSION })).toMatchObject({
      ok: true,
      status,
      rounds: [
        { roundRunId, canRestore: true, incompleteCoverage: false, commandsWithoutSnapshot: false },
      ],
      incompleteRestores: [],
    })
    h.host.hardlink(FILE, absolutePath('/work/project/second-name'))
    expect(await h.service.snapshotRounds({ sessionId: SESSION })).toMatchObject({
      ok: true,
      rounds: [{ roundRunId, incompleteCoverage: true }],
    })
    expect((await preview(h, roundRunId)).skipped).toEqual([
      { path: FILE, reason: 'hardlink', promised: true },
    ])
    await h.host.fs.remove(absolutePath('/work/project/second-name'))
    const p = await preview(h, roundRunId)
    expect(
      await h.service.snapshotRestore({
        sessionId: SESSION,
        roundRunId,
        previewKey: p.previewKey,
        overwrite: [],
      }),
    ).toMatchObject({ ok: true, restored: 1 })
    expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('A')
  },
)

it('05 验收 21、22: an unfinished completion is discoverable after restart and the same undo id is never applied again', async () => {
  let fail = false
  const h = await harness({
    store: (inner) =>
      proxyStore(inner, {
        append: async (batch) => {
          if (fail && batch.entries.some((entry) => entry.name === 'fs/restored'))
            throw new Error('completion not recorded')
          return inner.append(batch)
        },
      }),
  })
  const roundRunId = await changed(h)
  const p = await preview(h, roundRunId)
  const apply = vi.spyOn(h.host.snapshots, 'apply')
  fail = true
  await expect(
    h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).rejects.toThrow('completion not recorded')
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('A')
  const started = (await h.entries()).find((entry) => entry.name === 'fs/restore_started')!
  const requests = h.provider.starts
  const restarted = h.makeService()
  await restarted.recover()
  expect(await restarted.snapshotRounds({ sessionId: SESSION })).toMatchObject({
    ok: true,
    incompleteRestores: [
      { roundRunId, undoSnapshotId: started.payload['undoSnapshotId'], previewKey: p.previewKey },
    ],
  })
  expect(await restarted.resume({ rootSessionId: SESSION, origin: null })).toEqual({
    status: 'none',
  })
  expect(apply).toHaveBeenCalledOnce()
  expect(h.provider.starts).toBe(requests)
  const fresh = await restarted.snapshotPreview({ sessionId: SESSION, roundRunId })
  if (!fresh.ok) throw new Error(fresh.code)
  vi.spyOn(h.host.snapshots, 'prepare').mockResolvedValueOnce({
    ok: true,
    undoSnapshotId: String(started.payload['undoSnapshotId']),
  })
  expect(
    await restarted.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: fresh.preview.previewKey,
      overwrite: [],
    }),
  ).toEqual({ ok: false, code: 'stale' })
  expect(apply).toHaveBeenCalledOnce()
})

it.each(['tree', 'warming', 'file-only', 'unavailable'] as const)(
  '05 验收 9: %s command safety is derived from dispatch and before-call tree facts',
  async (status) => {
    const h = await harness({ status })
    vi.spyOn(h.host.process, 'spawn').mockImplementation(async () => {
      const child = fakeChild(() => h.host.clock.now(), 'dies')
      child.exit(0)
      return child.child
    })
    const q = await pause(h, 'Bash', { command: 'echo change' })
    await approve(h, q.pending)
    const rounds = await h.service.snapshotRounds({ sessionId: SESSION })
    expect(rounds).toMatchObject({
      ok: true,
      status,
      rounds: [
        {
          roundRunId: q.roundRunId,
          canRestore: status === 'tree',
          incompleteCoverage: true,
          commandsWithoutSnapshot: status !== 'tree',
        },
      ],
    })
  },
)

it('05 验收 9: a dispatched command whose before-call capture failed is explicitly unprotected', async () => {
  const h = await harness()
  vi.spyOn(h.host.process, 'spawn').mockImplementation(async () => {
    const child = fakeChild(() => h.host.clock.now(), 'dies')
    child.exit(0)
    return child.child
  })
  const q = await pause(h, 'Bash', { command: 'echo change' })
  h.host.snapshots.failNextTake('error')
  await approve(h, q.pending)
  expect(await h.service.snapshotRounds({ sessionId: SESSION })).toMatchObject({
    ok: true,
    rounds: [
      {
        roundRunId: q.roundRunId,
        canRestore: false,
        incompleteCoverage: true,
        commandsWithoutSnapshot: true,
      },
    ],
  })
})

it.each(['create', 'delete'] as const)(
  '05 验收 17、21: kernel %s undo uses the recorded snapshots and persists the matching counts',
  async (kind) => {
    const h = await harness()
    const created = absolutePath('/work/project/new')
    const q = await pause(
      h,
      kind === 'create' ? 'Write' : 'Delete',
      kind === 'create' ? { file_path: created, content: 'new' } : { file_path: FILE },
    )
    await approve(h, q.pending)
    const p = await preview(h, q.roundRunId)
    const restored = await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId: q.roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    })
    expect(restored).toMatchObject({
      ok: true,
      restored: kind === 'create' ? 0 : 1,
      removed: kind === 'create' ? 1 : 0,
      failed: [],
    })
    expect(await h.host.fs.identity(created)).toBeNull()
    expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('A')
    expect(
      (await h.entries()).findLast((entry) => entry.name === 'fs/restored')?.payload,
    ).toMatchObject({ restored: kind === 'create' ? 0 : 1, removed: kind === 'create' ? 1 : 0 })
  },
)

it('05 验收 21、52: skipped invalid promises are counted in the completion fact', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  h.host.hardlink(FILE, absolutePath('/work/project/alias'))
  const p = await preview(h, roundRunId)
  expect(p.skipped).toEqual([{ path: FILE, reason: 'hardlink', promised: true }])
  expect(
    await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).toMatchObject({ ok: true, restored: 0, skipped: 1 })
  expect(
    (await h.entries()).findLast((entry) => entry.name === 'fs/restored')?.payload,
  ).toMatchObject({ skipped: 1, failed: 0 })
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('B')
})

async function rootEnded(h: Harness) {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- child ends precede the root's terminal event
    const ended = await h.ports.runEnded()
    if (ended.sessionId === SESSION) return ended
  }
}
async function answerCard(h: Harness, pending: PendingApproval) {
  await h.service.answer({
    kind: 'approval',
    sessionId: pending.card.sessionId,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
}

it('05 验收 16、17、21: completed child sessions remain in their root round in causal order, including resumed Runs', async () => {
  const h = await harness()
  const second = absolutePath('/work/project/b.txt')
  await h.host.fs.writeFile(second, 'A')
  h.provider.script(call('Agent', { description: 'first child', prompt: 'write a' }, 'agent-one'))
  h.provider.script(call('Write', { file_path: FILE, content: 'B' }, 'child-one'))
  const sent = await h.service.send({ sessionId: SESSION, text: 'two child tasks', origin: null })
  if (sent.status !== 'started') throw new Error('Parent did not start')
  expect((await rootEnded(h)).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
  const first = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (first === null) throw new Error('First child approval missing')
  h.provider.script(done())
  h.provider.script(call('Agent', { description: 'second child', prompt: 'write b' }, 'agent-two'))
  h.provider.script(call('Write', { file_path: second, content: 'B' }, 'child-two'))
  await answerCard(h, first)
  expect((await rootEnded(h)).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
  const last = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (last === null) throw new Error('Second child approval missing')
  h.provider.script(done())
  h.provider.script(done())
  await answerCard(h, last)
  expect((await rootEnded(h)).reason).toEqual({ code: 'completed' })
  const own = await h.entries()
  expect(own.filter((entry) => entry.name === 'fs/snapshot_created')).toEqual([])
  const before = vi.spyOn(h.host.snapshots, 'preview')
  const p = await preview(h, sent.runId)
  const childOne = (await h.entries(first.card.sessionId)).filter(
    (entry) => entry.name === 'fs/snapshot_created',
  )
  const childTwo = (await h.entries(last.card.sessionId)).filter(
    (entry) => entry.name === 'fs/snapshot_created',
  )
  expect(before).toHaveBeenCalledWith({
    sessionId: SESSION,
    roundRunId: sent.runId,
    calls: [
      {
        callKey: `${String(childOne[0]!.sourceId)}:${String(childOne[0]!.sourceSeq)}:0`,
        before: childOne[0]!.payload['snapshotId'],
        after: childOne[1]!.payload['snapshotId'],
        path: FILE,
      },
      {
        callKey: `${String(childTwo[0]!.sourceId)}:${String(childTwo[0]!.sourceSeq)}:0`,
        before: childTwo[0]!.payload['snapshotId'],
        after: childTwo[1]!.payload['snapshotId'],
        path: second,
      },
    ],
  })
  expect(await h.service.snapshotRounds({ sessionId: SESSION })).toMatchObject({
    ok: true,
    rounds: [{ roundRunId: sent.runId, canRestore: true }],
  })
  expect(
    await h.service.snapshotPreview({ sessionId: first.card.sessionId, roundRunId: sent.runId }),
  ).toEqual({ ok: false, code: 'gone' })
  expect(
    await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId: sent.runId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).toMatchObject({ ok: true, restored: 2 })
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('A')
  expect(await h.host.fs.readFile(second, { encoding: 'utf8' })).toBe('A')
  expect(
    (await h.entries(first.card.sessionId)).filter((entry) => entry.name === 'fs/restored'),
  ).toEqual([])
})

it('05 验收 21、22: restore facts survive projection rebuild and replay without changing messages', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const messages = await h.store.listMessages({ sessionId: SESSION, limit: 100 })
  const replay = await readEffectiveMessages(h.store, { sessionId: SESSION })
  const p = await preview(h, roundRunId)
  await h.service.snapshotRestore({
    sessionId: SESSION,
    roundRunId,
    previewKey: p.previewKey,
    overwrite: [],
  })
  await h.store.rebuildProjections(SESSION)
  expect(await h.store.listMessages({ sessionId: SESSION, limit: 100 })).toEqual(messages)
  expect(await readEffectiveMessages(h.store, { sessionId: SESSION })).toEqual(replay)
  expect(await h.makeService().snapshotRounds({ sessionId: SESSION })).toMatchObject({
    ok: true,
    incompleteRestores: [],
  })
})

it('05 验收 21、22、51: an interrupted partial restore keeps the undo evidence and retries only paths not already at origin', async () => {
  const h = await harness()
  const second = absolutePath('/work/project/b.txt')
  const hardlink = absolutePath('/work/project/b-other-name')
  await h.host.fs.writeFile(second, 'A')
  const { pending, roundRunId } = await pause(h)
  h.provider.script(call('Write', { file_path: second, content: 'B' }, 'second-file'))
  h.provider.script(done())
  await answerCard(h, pending)
  await h.ports.runEnded()
  const more = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (more !== null) {
    await answerCard(h, more)
    await h.ports.runEnded()
  }
  expect(await h.host.fs.readFile(second, { encoding: 'utf8' })).toBe('B')
  const p = await preview(h, roundRunId)
  const apply = h.host.snapshots.apply.bind(h.host.snapshots)
  const applied = vi.spyOn(h.host.snapshots, 'apply').mockImplementationOnce(async (q) => {
    h.host.hardlink(second, hardlink)
    const result = await apply(q)
    expect(result.failed).toEqual([second])
    expect(result.restored).toBe(1)
    throw new Error('process interrupted after partial restore')
  })
  await expect(
    h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).rejects.toThrow('process interrupted')
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('A')
  expect(await h.host.fs.readFile(second, { encoding: 'utf8' })).toBe('B')
  await h.host.fs.remove(hardlink)
  const stamp = await h.host.fs.identity(FILE)
  const restarted = h.makeService()
  await restarted.recover()
  const rounds = await restarted.snapshotRounds({ sessionId: SESSION })
  expect(rounds).toMatchObject({
    ok: true,
    incompleteRestores: [{ roundRunId, undoSnapshotId: expect.any(String) }],
  })
  const fresh = await restarted.snapshotPreview({ sessionId: SESSION, roundRunId })
  if (!fresh.ok) throw new Error(fresh.code)
  expect(fresh.preview.restore).toEqual([second])
  expect(fresh.preview.conflicts).toEqual([])
  expect(
    await restarted.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: fresh.preview.previewKey,
      overwrite: [],
    }),
  ).toMatchObject({ ok: true, restored: 1, failed: [] })
  expect(applied).toHaveBeenCalledTimes(2)
  expect(await h.host.fs.identity(FILE)).toEqual(stamp)
  expect(await h.host.fs.readFile(second, { encoding: 'utf8' })).toBe('A')
  expect(
    (await h.entries())
      .filter((entry) => entry.name === 'fs/restore_started')
      .map((entry) => entry.sourceSeq),
  ).toEqual([0, 1])
  expect((await h.entries()).findLast((entry) => entry.name === 'fs/restored')?.sourceSeq).toBe(1)
})
