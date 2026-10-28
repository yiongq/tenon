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
  TapeEntry,
  NewEntry,
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
  '05 验收 52: %s promised calls safely restore; explicit previews detect workspace changes between cached rounds queries',
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
    // Coverage annotations now stay cached until this round's Tape or liveness changes.
    expect(await h.service.snapshotRounds({ sessionId: SESSION })).toMatchObject({
      ok: true,
      rounds: [{ roundRunId, incompleteCoverage: false }],
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

it('05 验收 33、34: rounds expose resumed root Runs and their before snapshots, never child calls or child ending messages', async () => {
  const h = await harness()
  const { pending, roundRunId } = await pause(h)
  h.provider.script(call('Agent', { description: 'child', prompt: 'write b' }, 'agent'))
  h.provider.script(
    call('Write', { file_path: '/work/project/child.txt', content: 'child' }, 'child-write'),
  )
  await answerCard(h, pending)
  expect((await rootEnded(h)).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
  const child = pendingCard(await h.service.currentPending({ sessionId: SESSION }))!
  expect(child.card.sessionId).not.toBe(SESSION)
  h.provider.script(done())
  h.provider.script(done())
  await answerCard(h, child)
  expect((await rootEnded(h)).reason).toEqual({ code: 'completed' })
  const entries = await h.entries()
  const runs = entries
    .filter((entry) => entry.name === 'execution/run_started')
    .map((entry) => entry.sourceId)
  expect(runs.length).toBeGreaterThan(1)
  expect(runs[0]).toBe(roundRunId)
  const before = entries.find(
    (entry) => entry.name === 'fs/snapshot_created' && entry.payload['moment'] === 'before-call',
  )!
  const outcome = entries.find(
    (entry) => entry.name === 'execution/tool_outcome' && entry.payload['snapshotId'] !== undefined,
  )!
  expect(outcome.payload['snapshotId']).toBe(before.payload['snapshotId'])
  const result = await h.service.snapshotRounds({ sessionId: SESSION })
  expect(result).toMatchObject({
    ok: true,
    rounds: [
      {
        roundRunId,
        runIds: runs,
        calls: [
          {
            callKey: `${outcome.sourceId}:${outcome.sourceSeq}:${outcome.payload['ordinal']}`,
            snapshotId: before.payload['snapshotId'],
          },
        ],
      },
    ],
  })
  if (!result.ok) throw new Error(result.code)
  expect(result.rounds).toHaveLength(1)
  expect(result.rounds[0]!.calls).toHaveLength(1)
  const rootEnd = entries.findLast((entry) => entry.name === 'message/assistant')!
  const childEnd = (await h.entries(child.card.sessionId)).findLast(
    (entry) => entry.name === 'message/assistant',
  )!
  expect(result.rounds[0]!.endMessageId).toBe(rootEnd.payload['messageId'])
  expect(result.rounds[0]!.endMessageId).not.toBe(childEnd.payload['messageId'])
  expect(
    (await h.entries(child.card.sessionId)).some((entry) => entry.name === 'fs/snapshot_created'),
  ).toBe(true)
  const previews = vi.spyOn(h.host.snapshots, 'preview')
  await h.service.snapshotRounds({ sessionId: SESSION })
  expect(previews).not.toHaveBeenCalled()
  const childHead = (await h.store.head(child.card.sessionId))!
  await h.store.append({
    sessionId: child.card.sessionId,
    incarnationId: childHead.incarnationId,
    entries: [
      {
        kind: 'event',
        name: 'ext/perf/note',
        sourceType: 'session',
        sourceId: child.card.sessionId,
        provenanceKey: 'ext:v1:perf:child',
        payload: {},
        createdAt: 0,
      },
    ],
  })
  await h.service.snapshotRounds({ sessionId: SESSION })
  expect(previews).toHaveBeenCalledOnce()
  await h.service.snapshotRounds({ sessionId: SESSION })
  expect(previews).toHaveBeenCalledOnce()
})

it('05 验收 34: a root Bash call exposes its before-dispatch tree, not the after-call snapshot', async () => {
  const h = await harness()
  vi.spyOn(h.host.process, 'spawn').mockImplementation(async () => {
    const child = fakeChild(() => h.host.clock.now(), 'dies')
    child.exit(0)
    return child.child
  })
  const { pending, roundRunId } = await pause(h, 'Bash', { command: 'echo change' })
  await approve(h, pending)
  const entries = await h.entries()
  const before = entries.find(
    (entry) => entry.name === 'fs/snapshot_created' && entry.payload['moment'] === 'before-call',
  )!
  const after = entries.find(
    (entry) => entry.name === 'fs/snapshot_created' && entry.payload['moment'] === 'after-call',
  )!
  expect(before.payload['scope']).toBe('tree')
  expect(before.payload['snapshotId']).not.toBe(after.payload['snapshotId'])
  expect(await h.service.snapshotRounds({ sessionId: SESSION })).toMatchObject({
    ok: true,
    rounds: [
      {
        roundRunId,
        calls: [
          {
            callKey: `${before.sourceId}:${before.sourceSeq}:${before.payload['ordinal']}`,
            snapshotId: before.payload['snapshotId'],
          },
        ],
      },
    ],
  })
})

it('05 验收 33: a paused round has no end message; a text-only resumed ending survives restart', async () => {
  const h = await harness()
  const { pending, roundRunId } = await pause(h)
  expect(await h.service.snapshotRounds({ sessionId: SESSION })).toMatchObject({
    ok: true,
    rounds: [{ roundRunId, endMessageId: null }],
  })
  await approve(h, pending)
  const entries = await h.entries()
  const last = entries.findLast((entry) => entry.name === 'message/assistant')!
  expect(last.payload['runId']).not.toBe(roundRunId)
  expect(last.payload['content']).toEqual([{ type: 'text', text: 'done' }])
  const messages = await readEffectiveMessages(h.store, { sessionId: SESSION })
  expect(messages.at(-1)?.messageId).toBe(last.payload['messageId'])
  const restarted = h.makeService()
  expect(await restarted.snapshotRounds({ sessionId: SESSION })).toMatchObject({
    ok: true,
    rounds: [{ roundRunId, endMessageId: last.payload['messageId'] }],
  })
})

it('05 验收 33: an active round has no end message and does not hide an older completed round', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const last = (await h.entries()).findLast((entry) => entry.name === 'message/assistant')!
  const live = await liveRun(h, SESSION)
  try {
    expect(await h.service.snapshotRounds({ sessionId: SESSION })).toMatchObject({
      ok: true,
      rounds: [
        { roundRunId, endMessageId: last.payload['messageId'] },
        { roundRunId: live.runId, endMessageId: null },
      ],
    })
  } finally {
    await live.release()
  }
})

it('05 验收 33: rounds cache preview skips until that round gains a fact or its liveness changes; explicit preview stays fresh', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const realPreview = h.host.snapshots.preview.bind(h.host.snapshots)
  const spy = vi.spyOn(h.host.snapshots, 'preview')
  const rounds = () => h.service.snapshotRounds({ sessionId: SESSION })
  await rounds()
  await rounds()
  expect(spy).toHaveBeenCalledTimes(1)
  // Another round's facts must not invalidate the completed round.
  h.provider.script(done())
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'just answer' })
  if (sent.status !== 'started') throw new Error('Run did not start')
  await h.ports.runEnded({ runId: sent.runId })
  await rounds()
  expect(spy.mock.calls.filter(([q]) => q.roundRunId === roundRunId)).toHaveLength(1)
  const head = (await h.store.head(SESSION))!
  await h.store.append({
    sessionId: SESSION,
    incarnationId: head.incarnationId,
    entries: [
      {
        kind: 'event',
        name: 'ext/perf/note',
        sourceType: 'runtime_event',
        sourceId: roundRunId,
        provenanceKey: 'ext:v1:perf:note',
        payload: {},
        createdAt: 0,
      },
    ],
  })
  spy.mockImplementation(async (q) => ({
    ...(await realPreview(q)),
    skipped: [{ path: FILE, reason: 'hardlink', promised: true }],
  }))
  expect(await rounds()).toMatchObject({ ok: true, rounds: [{ incompleteCoverage: true }, {}] })
  expect(spy.mock.calls.filter(([q]) => q.roundRunId === roundRunId)).toHaveLength(2)
  await rounds()
  expect(spy.mock.calls.filter(([q]) => q.roundRunId === roundRunId)).toHaveLength(2)
  const realAlive = h.host.snapshots.alive.bind(h.host.snapshots)
  const live = vi.spyOn(h.host.snapshots, 'alive').mockResolvedValue(new Set())
  expect(await rounds()).toMatchObject({
    ok: true,
    rounds: [{ canRestore: false }, { canRestore: false }],
  })
  live.mockImplementation(realAlive)
  await rounds()
  expect(spy.mock.calls.filter(([q]) => q.roundRunId === roundRunId)).toHaveLength(3)
  await preview(h, roundRunId)
  await preview(h, roundRunId)
  expect(spy.mock.calls.filter(([q]) => q.roundRunId === roundRunId)).toHaveLength(5)
})

const FILE2 = absolutePath('/work/project/big.bin')
it('05 验收 33: a round with one snapshotted Write and one unsnapshotted Write shows incomplete coverage', async () => {
  const h = await harness()
  const first = await pause(h) // Write FILE (snapshotted)
  // The resumed Run makes a second Write whose coverage is none (e.g. a >100 MB file).
  const cov = h.host.snapshots.coverage.bind(h.host.snapshots)
  vi.spyOn(h.host.snapshots, 'coverage').mockImplementation(async (q) =>
    q.path === FILE2 ? 'none' : cov(q),
  )
  h.provider.script(call('Write', { file_path: FILE2, content: 'X' }, 'second'))
  await h.service.answer({
    kind: 'approval',
    sessionId: first.pending.card.sessionId,
    requestId: first.pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  await h.ports.runEnded()
  const second = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (second === null) throw new Error('second approval missing')
  h.host.snapshots.failNextTake('not-covered')
  await approve(h, second)
  expect(await h.host.fs.readFile(FILE2, { encoding: 'utf8' })).toBe('X')
  const rounds = await h.service.snapshotRounds({ sessionId: SESSION })
  if (!rounds.ok) throw new Error(rounds.code)
  const round = rounds.rounds.find((r) => r.roundRunId === first.roundRunId)!
  expect(round.canRestore).toBe(true)
  // spec §结算行: 「有改动没进快照，写成「可还原（不含被排除的文件）」」
  expect(round.incompleteCoverage).toBe(true)
})

it('05 验收 22、51: a later completed restore clears earlier unfinished attempts of the same round', async () => {
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
  fail = true
  await expect(
    h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).rejects.toThrow('completion not recorded')
  fail = false
  await h.host.fs.writeFile(FILE, 'B') // the round's change again, e.g. the user redid it
  const p2 = await preview(h, roundRunId)
  expect(
    await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: p2.previewKey,
      overwrite: [],
    }),
  ).toMatchObject({ ok: true })
  const rounds = await h.service.snapshotRounds({ sessionId: SESSION })
  expect(rounds.ok && rounds.incompleteRestores).toEqual([])
})

it('05 验收 33: a guard-refused Write needs no after snapshot and adds no coverage warning', async () => {
  const h = await harness()
  const first = await pause(h)
  const take = h.host.snapshots.take.bind(h.host.snapshots)
  let beforeCalls = 0
  vi.spyOn(h.host.snapshots, 'take').mockImplementation(async (q, signal) => {
    if (q.moment === 'before-call' && ++beforeCalls === 2)
      await h.host.fs.writeFile(FILE, 'user changed this')
    return take(q, signal)
  })
  h.provider.script(call('Write', { file_path: FILE, content: 'C' }, 'second'))
  h.provider.script(done())
  await h.service.answer({
    kind: 'approval',
    sessionId: SESSION,
    requestId: first.pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  await h.ports.runEnded()
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('user changed this')
  const rounds = await h.service.snapshotRounds({ sessionId: SESSION })
  if (!rounds.ok) throw new Error(rounds.code)
  expect(rounds.rounds[0]?.incompleteCoverage).toBe(false)
})

const boundaryRounds = async (h: Harness) => {
  const r = await h.service.snapshotRounds({ sessionId: SESSION })
  if (!r.ok) throw new Error(r.code)
  return r.rounds
}
async function agentRound(h: Harness) {
  h.provider.script(call('Agent', { description: 'child', prompt: 'write b' }, 'agent'))
  h.provider.script(call('Write', { file_path: '/work/project/child.txt', content: 'c' }, 'cw'))
  const sent = await h.service.send({ sessionId: SESSION, text: 'go', origin: null })
  if (sent.status !== 'started') throw new Error('no start')
  expect((await rootEnded(h)).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
  const child = pendingCard(await h.service.currentPending({ sessionId: SESSION }))!
  h.provider.script(done())
  h.provider.script(done())
  await answerCard(h, child)
  expect((await rootEnded(h)).reason).toEqual({ code: 'completed' })
  return { roundRunId: sent.runId, child }
}
const appendRaw = async (h: Harness, sessionId: string, entry: NewEntry) => {
  const head = (await h.store.head(sessionId))!
  return h.store.append({ sessionId, incarnationId: head.incarnationId, entries: [entry] })
}
const note = (over: Partial<NewEntry>): NewEntry => ({
  kind: 'event',
  name: 'ext/perf/note',
  sourceType: 'runtime_event',
  sourceId: SESSION,
  provenanceKey: `ext:v1:perf:${Math.random()}`,
  payload: {},
  createdAt: 0,
  ...over,
})

it('05 验收 33: K1 — a guard-refused Write with failed before capture is unrestorable without a coverage warning', async () => {
  const h = await harness()
  const q = await pause(h)
  h.host.snapshots.failNextTake('error')
  await approve(h, q.pending)
  expect(await boundaryRounds(h)).toMatchObject([
    { roundRunId: q.roundRunId, canRestore: false, incompleteCoverage: false },
  ])
})

it('05 验收 33: K2 — a call whose after-call capture is missing keeps its path+before in the host query and marks the round incomplete', async () => {
  const h = await harness()
  const take = h.host.snapshots.take.bind(h.host.snapshots)
  vi.spyOn(h.host.snapshots, 'take').mockImplementation(async (q, signal) =>
    q.moment === 'after-call' ? { ok: false, reason: 'error' } : take(q, signal),
  )
  const roundRunId = await changed(h)
  const spy = vi.spyOn(h.host.snapshots, 'preview')
  const r = await boundaryRounds(h)
  expect(r).toMatchObject([{ roundRunId, canRestore: true, incompleteCoverage: true }])
  const asked = spy.mock.calls.at(-1)![0]
  expect(asked.calls).toHaveLength(1)
  expect(asked.calls[0]).toMatchObject({ path: FILE })
  expect(asked.calls[0]!.before).toEqual(expect.any(String))
  expect(asked.calls[0]!.after).toBeUndefined()
})

it('05 验收 33: K3 — a round that is still waiting for approval is not incomplete and runs no command', async () => {
  const h = await harness()
  const q = await pause(h)
  expect(await boundaryRounds(h)).toMatchObject([
    { roundRunId: q.roundRunId, incompleteCoverage: false, commandsWithoutSnapshot: false },
  ])
})

it('05 验收 33: K4 — a round with a delegated child (dispatched but never snapshotted parent call) is complete', async () => {
  const h = await harness()
  const { roundRunId } = await agentRound(h)
  expect(await boundaryRounds(h)).toMatchObject([
    { roundRunId, canRestore: true, incompleteCoverage: false, commandsWithoutSnapshot: false },
  ])
})

it('05 验收 33: K5 — facts that name the round only through payload.runId or payload.roundRunId invalidate its cached preview', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const spy = vi.spyOn(h.host.snapshots, 'preview')
  const count = () => spy.mock.calls.filter(([q]) => q.roundRunId === roundRunId).length
  await boundaryRounds(h)
  await boundaryRounds(h)
  expect(count()).toBe(1)
  await appendRaw(
    h,
    SESSION,
    note({ sourceId: '99999999-9999-4999-8999-999999999999', payload: { runId: roundRunId } }),
  )
  await boundaryRounds(h)
  expect(count()).toBe(2)
  await appendRaw(
    h,
    SESSION,
    note({ sourceId: '88888888-8888-4888-8888-888888888888', payload: { roundRunId } }),
  )
  await boundaryRounds(h)
  expect(count()).toBe(3)
  await appendRaw(
    h,
    SESSION,
    note({ sourceId: '77777777-7777-4777-8777-777777777777', payload: { roundRunId: 42 } }),
  )
  await boundaryRounds(h)
  expect(count()).toBe(3)
})

it('05 验收 21、22: K6 — a forged cyclic resume chain, and a resume pointing at an unknown run, are handled explicitly', async () => {
  const h = await harness()
  const first = await changed(h)
  const a = '0000000a-0000-4000-8000-00000000000a'
  const b = '0000000b-0000-4000-8000-00000000000b'
  const unknownPaused = '0000000c-0000-4000-8000-00000000000c'
  const run = (id: string, paused: string) =>
    note({
      name: 'execution/run_started',
      sourceType: 'runtime_event',
      sourceId: id,
      provenanceKey: `execution:v1:run_started:${id}`,
      payload: {
        cause: { kind: 'resume', pausedRunId: paused, batch: { runId: paused, requestSeq: 0 } },
      },
    })
  await appendRaw(h, SESSION, run(a, unknownPaused))
  // the paused run has no run_started: the chain simply ends there
  const ok = await boundaryRounds(h)
  expect(ok.map((round) => round.roundRunId)).toEqual([first, unknownPaused])
  await appendRaw(h, SESSION, run(b, a))
  await appendRaw(h, SESSION, run(unknownPaused, b))
  await expect(h.service.snapshotRounds({ sessionId: SESSION })).rejects.toThrow(
    'cyclic resume chain',
  )
})

const clone = (e: TapeEntry, over: Partial<NewEntry> = {}): NewEntry => ({
  kind: e.kind,
  name: e.name,
  sourceType: e.sourceType,
  sourceId: e.sourceId!,
  sourceSeq: e.sourceSeq!,
  provenanceKey: e.provenanceKey,
  payload: { ...e.payload },
  createdAt: 0,
  ...over,
})

it.each([
  [
    'runId',
    (p: Readonly<Record<string, unknown>>) => ({
      ...p,
      runId: '0000000d-0000-4000-8000-00000000000d',
    }),
  ],
  [
    'requestSeq',
    (p: Readonly<Record<string, unknown>>) => ({ ...p, requestSeq: Number(p['requestSeq']) + 7 }),
  ],
  [
    'roundRunId',
    (p: Readonly<Record<string, unknown>>) => ({
      ...p,
      roundRunId: '0000000e-0000-4000-8000-00000000000e',
    }),
  ],
] as const)(
  '05 验收 21、22: K8a — a snapshot fact whose %s disagrees with its call is rejected explicitly',
  async (_label, mutate) => {
    const h = await harness()
    await changed(h)
    const snap = (await h.entries()).find(
      (e) => e.name === 'fs/snapshot_created' && e.payload['moment'] === 'before-call',
    )!
    await appendRaw(
      h,
      SESSION,
      clone(snap, {
        sourceSeq: snap.sourceSeq!,
        provenanceKey: `fs:v1:snapshot:${snap.sourceId}:${snap.sourceSeq}:7:before-call`,
        payload: { ...mutate(snap.payload), ordinal: 7 },
      }),
    )
    await expect(h.service.snapshotRounds({ sessionId: SESSION })).rejects.toThrow(
      'Snapshot identity disagrees with its call or root round',
    )
  },
)

it('05 验收 21、22: K8b — before and after records of one call must name the same target', async () => {
  const h = await harness()
  await changed(h)
  const snaps = (await h.entries()).filter((e) => e.name === 'fs/snapshot_created')
  const before = snaps.find((e) => e.payload['moment'] === 'before-call')!
  await appendRaw(
    h,
    SESSION,
    clone(before, {
      provenanceKey: `fs:v1:snapshot:${before.sourceId}:${before.sourceSeq}:${before.payload['ordinal']}:after-call:x`,
      payload: { ...before.payload, moment: 'after-call', path: '/work/project/other.txt' },
    }),
  )
  await expect(h.service.snapshotRounds({ sessionId: SESSION })).rejects.toThrow(
    'Snapshot target changed between call records',
  )
})

it('05 验收 21、22: K9 — a repeated or self-referencing child link is rejected explicitly', async () => {
  const h = await harness()
  const { child } = await agentRound(h)
  const link = (await h.entries()).find((e) => e.name === 'session/parent_link')!
  const forged = (n: number, sessionId: string) =>
    appendRaw(
      h,
      SESSION,
      clone(link, {
        provenanceKey: `session:v1:parent_link:${link.sourceId}:${link.sourceSeq}:${n}`,
        payload: {
          ...link.payload,
          ordinal: n,
          child: { ...(link.payload['child'] as Record<string, unknown>), sessionId },
        },
      }),
    )
  await forged(7, SESSION) // the root linking itself
  await expect(h.service.snapshotRounds({ sessionId: SESSION })).rejects.toThrow(
    'cyclic or repeated',
  )
  const h2 = await harness()
  await agentRound(h2)
  const link2 = (await h2.entries()).find((e) => e.name === 'session/parent_link')!
  await appendRaw(
    h2,
    SESSION,
    clone(link2, {
      provenanceKey: `session:v1:parent_link:${link2.sourceId}:${link2.sourceSeq}:8`,
      payload: { ...link2.payload, ordinal: 8 },
    }),
  )
  await expect(h2.service.snapshotRounds({ sessionId: SESSION })).rejects.toThrow(
    'cyclic or repeated',
  )
  expect(child.card.sessionId).not.toBe(SESSION)
})

it("05 验收 21、22: K10 — a child link whose child is not that parent call's subagent makes the round incomplete and still tracks the child tape", async () => {
  const h = await harness()
  const { roundRunId } = await agentRound(h)
  const link = (await h.entries()).find((e) => e.name === 'session/parent_link')!
  await h.service.createSession({ sessionId: OTHER })
  const otherStart = (await h.entries(OTHER)).find((e) => e.name === 'session/start')!
  await appendRaw(
    h,
    SESSION,
    clone(link, {
      provenanceKey: `session:v1:parent_link:${link.sourceId}:${link.sourceSeq}:9`,
      payload: {
        ...link.payload,
        ordinal: 9,
        child: { sessionId: OTHER, incarnationId: otherStart.payload['incarnationId'] },
      },
    }),
  )
  const spy = vi.spyOn(h.host.snapshots, 'preview')
  const count = () => spy.mock.calls.filter(([q]) => q.roundRunId === roundRunId).length
  expect(await boundaryRounds(h)).toMatchObject([{ roundRunId, incompleteCoverage: true }])
  const first = count()
  await boundaryRounds(h)
  expect(count()).toBe(first) // unchanged tape: cached
  await appendRaw(h, OTHER, note({ sourceId: OTHER, sourceType: 'session' }))
  await boundaryRounds(h)
  expect(count()).toBe(first + 1) // a fact on the unreadable child still moves the round revision
  // a link to a session with no tape at all is unreadable too, without throwing
  await appendRaw(
    h,
    SESSION,
    clone(link, {
      provenanceKey: `session:v1:parent_link:${link.sourceId}:${link.sourceSeq}:10`,
      payload: {
        ...link.payload,
        ordinal: 10,
        child: {
          sessionId: '5555aaaa-5555-4555-8555-5555aaaa5555',
          incarnationId: (link.payload['child'] as Record<string, unknown>)['incarnationId'],
        },
      },
    }),
  )
  expect(await boundaryRounds(h)).toMatchObject([{ roundRunId, incompleteCoverage: true }])
})

it('05 验收 21、22: K11 — restore() refuses unknown rounds, stale keys, forged overwrites and live workspaces before preparing anything', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const p = await preview(h, roundRunId)
  const prepare = vi.spyOn(h.host.snapshots, 'prepare')
  const restoreAs = (over: Record<string, unknown>) =>
    h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
      ...over,
    })
  // unknown round
  expect(await restoreAs({ roundRunId: '4444dddd-4444-4444-8444-4444dddd4444' })).toEqual({
    ok: false,
    code: 'gone',
  })
  // stale key: never reaches prepare (which would spend an undo snapshot)
  expect(await restoreAs({ previewKey: 'stale-key' })).toEqual({ ok: false, code: 'stale' })
  expect(prepare).not.toHaveBeenCalled()
  // forged overwrite: TypeError before any prepare / restore_started
  await expect(restoreAs({ overwrite: [absolutePath('/forged')] })).rejects.toThrow('subset')
  expect(prepare).not.toHaveBeenCalled()
  expect((await h.entries()).filter((e) => e.name.startsWith('fs/restore'))).toEqual([])
  // a live Run in the same workspace: busy at the first check, before preview or prepare
  const previewSpy = vi.spyOn(h.host.snapshots, 'preview')
  const live = await liveRun(h, OTHER)
  try {
    previewSpy.mockClear()
    expect(await restoreAs({})).toEqual({ ok: false, code: 'busy' })
    expect(previewSpy).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    // the same answer when the host cannot resolve real paths (aliases fall back to the folder itself)
    vi.spyOn(h.host.fs, 'realpath').mockResolvedValue(null as never)
    expect(await restoreAs({})).toEqual({ ok: false, code: 'busy' })
  } finally {
    vi.restoreAllMocks()
    await live.release()
  }
})

it('05 验收 21、22: K12 — a completion fact alone also retires its undo id (never applied twice)', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  const p = await preview(h, roundRunId)
  const first = await h.service.snapshotRestore({
    sessionId: SESSION,
    roundRunId,
    previewKey: p.previewKey,
    overwrite: [],
  })
  if (!first.ok) throw new Error(first.code)
  const restored = (await h.entries()).find((e) => e.name === 'fs/restored')!
  await appendRaw(
    h,
    SESSION,
    clone(restored, {
      sourceSeq: 5,
      provenanceKey: restored.provenanceKey.replace(/:0$/, ':5'),
      payload: { ...restored.payload, undoSnapshotId: 'forged-undo-id' },
    }),
  )
  const again = await preview(h, roundRunId)
  vi.spyOn(h.host.snapshots, 'prepare').mockResolvedValueOnce({
    ok: true,
    undoSnapshotId: 'forged-undo-id',
  })
  const apply = vi.spyOn(h.host.snapshots, 'apply')
  const cancel = vi.spyOn(h.host.snapshots, 'cancel')
  expect(
    await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: again.previewKey,
      overwrite: [],
    }),
  ).toEqual({ ok: false, code: 'stale' })
  expect(apply).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledOnce()
})

it('05 验收 21、22: K13 — losing the restore_started write race (duplicate fact) cancels and answers stale', async () => {
  let dup = false
  const h = await harness({
    store: (inner) =>
      proxyStore(inner, {
        append: async (batch) => {
          if (dup && batch.entries.some((entry) => entry.name === 'fs/restore_started')) {
            await inner.append(batch) // a concurrent writer got there first
            return inner.append(batch)
          }
          return inner.append(batch)
        },
      }),
  })
  const roundRunId = await changed(h)
  const p = await preview(h, roundRunId)
  const apply = vi.spyOn(h.host.snapshots, 'apply')
  const cancel = vi.spyOn(h.host.snapshots, 'cancel')
  dup = true
  expect(
    await h.service.snapshotRestore({
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).toEqual({ ok: false, code: 'stale' })
  expect(apply).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledOnce()
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('B')
})

it('05 验收 33: K14 — a round killed before any assistant message has no end message (and does not throw); a live round hides its end', async () => {
  const h = await harness()
  const live = await liveRun(h, SESSION)
  await h.service.stop({ rootSessionId: SESSION })
  await live.release().catch(() => {})
  const r = await boundaryRounds(h)
  expect(r).toHaveLength(1)
  expect(r[0]!.endMessageId).toBeNull()
})

it.each(['not-a-uuid', '11111111-1111-4111-8111-11111111111G'])(
  '05 验收 21、22: K15 — snapshot commands refuse a non-canonical session id (%s) before touching any mailbox',
  async (sessionId) => {
    const h = await harness()
    const roundRunId = await changed(h)
    await expect(h.service.snapshotRounds({ sessionId })).rejects.toThrow(TypeError)
    await expect(h.service.snapshotPreview({ sessionId, roundRunId })).rejects.toThrow(
      'canonical UUID',
    )
    await expect(
      h.service.snapshotRestore({ sessionId, roundRunId, previewKey: 'x', overwrite: [] }),
    ).rejects.toThrow('canonical UUID')
  },
)

it('05 验收 33: K16 — each round lists only its own root calls', async () => {
  const h = await harness()
  const first = await changed(h)
  h.provider.script(call('Write', { file_path: FILE, content: 'C' }, 'second'))
  h.provider.script(done())
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'again' })
  if (sent.status !== 'started') throw new Error('no start')
  await h.ports.runEnded({ runId: sent.runId })
  const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (pending !== null) {
    await answerCard(h, pending)
    await h.ports.runEnded()
  }
  const r = await boundaryRounds(h)
  expect(r.map((round) => round.roundRunId)).toEqual([first, sent.runId])
  expect(r[0]!.calls).toHaveLength(1)
  expect(r[1]!.calls).toHaveLength(1)
  expect(r[0]!.calls[0]!.callKey.startsWith(first)).toBe(true)
  expect(r[1]!.calls[0]!.callKey.startsWith(sent.runId)).toBe(true)
})

it.each([
  ['after', 0, 1],
  ['before', 1, 0],
] as const)(
  '05 验收 33: K17 — a %s record that skipped files marks the round incomplete even when other calls are whole',
  async (_which, skipBefore, skipAfter) => {
    const h = await harness()
    const roundRunId = await changed(h)
    const snaps = (await h.entries()).filter((e) => e.name === 'fs/snapshot_created')
    const b = snaps.find((e) => e.payload['moment'] === 'before-call')!
    const a = snaps.find((e) => e.payload['moment'] === 'after-call')!
    // reuse the live snapshot ids so the round stays restorable (canRestore must not explain the result)
    for (const [moment, skipped, src] of [
      ['before-call', skipBefore, b],
      ['after-call', skipAfter, a],
    ] as const)
      // oxlint-disable-next-line no-await-in-loop -- Tape before/after facts are appended in causal order
      await appendRaw(
        h,
        SESSION,
        clone(src, {
          provenanceKey: `fs:v1:snapshot:${src.sourceId}:${src.sourceSeq}:8:${moment}`,
          payload: { ...src.payload, ordinal: 8, moment, skipped },
        }),
      )
    const r0 = await boundaryRounds(h)
    expect(r0[0]!.canRestore).toBe(true)
    expect(await boundaryRounds(h)).toMatchObject([{ roundRunId, incompleteCoverage: true }])
  },
)

it('05 验收 33: K18 — a round is restorable only while ALL its snapshots are alive', async () => {
  const h = await harness()
  const roundRunId = await changed(h)
  vi.spyOn(h.host.snapshots, 'alive').mockImplementation(
    async (_s, ids) => new Set(ids.slice(0, 1)),
  )
  expect(await boundaryRounds(h)).toMatchObject([
    { roundRunId, canRestore: false, incompleteCoverage: true },
  ])
  expect(await h.service.snapshotPreview({ sessionId: SESSION, roundRunId })).toEqual({
    ok: false,
    code: 'gone',
  })
})

it('05 验收 21、22: K20 — snapshotRounds refuses unknown and non-cowork sessions with a code, not a crash', async () => {
  const h = await harness()
  await changed(h)
  await h.service.createSession({ sessionId: OTHER })
  expect(await h.service.snapshotRounds({ sessionId: OTHER })).toEqual({
    ok: false,
    code: 'not-cowork',
  })
  expect(
    await h.service.snapshotRounds({ sessionId: '33333333-3333-4333-8333-333333333333' }),
  ).toEqual({ ok: false, code: 'gone' })
})

it('05 验收 33: K21 — a round mixing a file edit and a command is incomplete / unprotected as soon as ONE call is a command', async () => {
  const h = await harness({ status: 'file-only' })
  vi.spyOn(h.host.process, 'spawn').mockImplementation(async () => {
    const child = fakeChild(() => h.host.clock.now(), 'dies')
    child.exit(0)
    return child.child
  })
  h.provider.script([
    { type: 'tool-call-start', index: 0, id: 'w', name: 'Write' },
    {
      type: 'tool-call-end',
      index: 0,
      id: 'w',
      name: 'Write',
      input: { file_path: FILE, content: 'B' },
    },
    { type: 'tool-call-start', index: 1, id: 'b', name: 'Bash' },
    { type: 'tool-call-end', index: 1, id: 'b', name: 'Bash', input: { command: 'echo hi' } },
    { type: 'usage', usage },
    stopEvent('tool-use', 'tool_use'),
  ])
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'both' })
  if (sent.status !== 'started') throw new Error('Run did not start')
  await h.ports.runEnded({ runId: sent.runId })
  for (let n = 0; n < 4; n++) {
    // oxlint-disable-next-line no-await-in-loop -- each approval reveals the next pending call
    const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
    if (pending === null) break
    h.provider.script(done())
    // oxlint-disable-next-line no-await-in-loop -- answer before waiting for this resumed Run
    await answerCard(h, pending)
    // oxlint-disable-next-line no-await-in-loop -- wait for the resumed Run before reading the next approval
    await h.ports.runEnded()
  }
  const r = await boundaryRounds(h)
  expect(r).toMatchObject([
    { roundRunId: sent.runId, incompleteCoverage: true, commandsWithoutSnapshot: true },
  ])
})

it.each(['no ordinal', 'null sourceSeq', 'null sourceId'] as const)(
  '05 验收 21、22: K7 — a malformed tool/call read from the Tape port (%s) is rejected explicitly',
  async (missing) => {
    const h = await harness()
    await changed(h)
    const read = h.store.readRange.bind(h.store)
    vi.spyOn(h.store, 'readRange').mockImplementation(async (q) => {
      const result = await read(q)
      return {
        ...result,
        entries: result.entries.map((entry) => {
          if (entry.name !== 'tool/call') return entry
          if (missing === 'no ordinal')
            return Object.assign({}, entry, { payload: { name: 'Write' } })
          return Object.assign({}, entry, {
            [missing === 'null sourceSeq' ? 'sourceSeq' : 'sourceId']: null,
          })
        }),
      }
    })
    await expect(h.service.snapshotRounds({ sessionId: SESSION })).rejects.toThrow(
      'Snapshot call has no runtime identity',
    )
  },
)
