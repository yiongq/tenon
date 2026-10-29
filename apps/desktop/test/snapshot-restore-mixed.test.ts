/** Spec 05: skipped/already-restored paths must not make a mixed undo perpetually stale. */
import { randomUUID } from 'node:crypto'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '@tenon-app/kernel/testing'
import { DesktopFs } from '../src/main/host/fs.js'
import type { AbsolutePath, RestoreQuery, SnapshotRequest } from '@tenon-app/kernel'
import { DesktopSnapshots } from '../src/main/host/snapshots.js'
import { SystemClock } from '../src/main/host/clock.js'
import { createHostProcess } from '../src/main/host/process.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'

let temp: string
let folder: AbsolutePath
let snapshots: DesktopSnapshots
let sessionId: string
let roundRunId: string
let seq = 0
const path = (name: string): AbsolutePath => absolutePath(join(folder, name))
async function setup(mode: 'home' | 'tree', bytes?: number) {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'tenon-review-')))
  folder = absolutePath(join(temp, 'workspace'))
  const home = mode === 'home' ? folder : absolutePath(join(temp, 'home'))
  const profileDir = absolutePath(join(temp, 'profile'))
  await Promise.all(
    [folder, absolutePath(join(temp, 'home')), profileDir].map((d) =>
      mkdir(d, { recursive: true }),
    ),
  )
  sessionId = randomUUID()
  roundRunId = randomUUID()
  snapshots = new DesktopSnapshots({
    identity: { userId: 'test', tenantId: 'test', profileDir },
    process: createHostProcess(),
    sandbox: new PassthroughSandbox(() => {}),
    clock: new SystemClock(),
    home,
    ...(bytes === undefined ? {} : { limits: { bytes } }),
  })
  await snapshots.setWorkspace(sessionId, [folder])
  await snapshots.settled(sessionId)
}
async function take(name?: string, moment: SnapshotRequest['moment'] = 'before-call') {
  if (moment === 'before-call') seq++
  const r = await snapshots.take(
    {
      sessionId,
      call: { sessionId, roundRunId, runId: roundRunId, requestSeq: seq, ordinal: 0 },
      folders: [folder],
      moment,
      ...(name === undefined ? {} : { path: path(name) }),
    },
    new AbortController().signal,
  )
  if (!r.ok) throw new Error(r.reason)
  return r.snapshotId
}
afterEach(async () => {
  vi.restoreAllMocks()
  await snapshots.settled(sessionId)
  await rm(temp, { recursive: true, force: true })
})

it('05 验收 51: file-only restore leaves a path already at origin untouched', async () => {
  await setup('home')
  expect(snapshots.status(sessionId)).toBe('file-only')
  await writeFile(path('a'), 'A')
  await writeFile(path('b'), 'A')
  const b1 = await take('a')
  await writeFile(path('a'), 'B')
  const a1 = await take('a', 'after-call')
  const b2 = await take('b')
  await writeFile(path('b'), 'B')
  const a2 = await take('b', 'after-call')
  await writeFile(path('a'), 'A') // e.g. an interrupted restore already put it back
  const q: RestoreQuery = {
    sessionId,
    roundRunId,
    calls: [
      { callKey: '1', before: b1, after: a1, path: path('a') },
      { callKey: '2', before: b2, after: a2, path: path('b') },
    ],
  }
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  expect(prepared).toMatchObject({ ok: true })
  if (!prepared.ok) throw new Error(prepared.reason)
  expect(
    (await snapshots.apply({ sessionId, undoSnapshotId: prepared.undoSnapshotId, overwrite: [] }))
      .failed,
  ).toEqual([])
})

it('05 验收 52: file-only restore skips a hardlink and restores the other path', async () => {
  await setup('home')
  await writeFile(path('a'), 'A')
  await writeFile(path('b'), 'A')
  const b1 = await take('a')
  await writeFile(path('a'), 'B')
  const a1 = await take('a', 'after-call')
  const b2 = await take('b')
  await writeFile(path('b'), 'B')
  const a2 = await take('b', 'after-call')
  await link(path('a'), path('second'))
  const q: RestoreQuery = {
    sessionId,
    roundRunId,
    calls: [
      { callKey: '1', before: b1, after: a1, path: path('a') },
      { callKey: '2', before: b2, after: a2, path: path('b') },
    ],
  }
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  expect(prepared).toMatchObject({ ok: true })
  if (!prepared.ok) throw new Error(prepared.reason)
  expect(
    (await snapshots.apply({ sessionId, undoSnapshotId: prepared.undoSnapshotId, overwrite: [] }))
      .failed,
  ).toEqual([])
  expect(await readFile(path('a'), 'utf8')).toBe('B')
  expect(await readFile(path('b'), 'utf8')).toBe('A')
})

it('05 验收 51、52: an ignored target already at origin does not block another restore', async () => {
  await setup('tree')
  expect(snapshots.status(sessionId)).toBe('tree')
  await writeFile(path('.gitignore'), 'ignored\n')
  await writeFile(path('ignored'), 'A')
  await writeFile(path('f'), 'A')
  const b1 = await take('ignored')
  await writeFile(path('ignored'), 'B')
  const a1 = await take('ignored', 'after-call')
  const b2 = await take('f')
  await writeFile(path('f'), 'B')
  const a2 = await take('f', 'after-call')
  await writeFile(path('ignored'), 'A')
  const q: RestoreQuery = {
    sessionId,
    roundRunId,
    calls: [
      { callKey: '1', before: b1, after: a1, path: path('ignored') },
      { callKey: '2', before: b2, after: a2, path: path('f') },
    ],
  }
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  expect(prepared).toMatchObject({ ok: true })
  if (!prepared.ok) throw new Error(prepared.reason)
  expect(
    (await snapshots.apply({ sessionId, undoSnapshotId: prepared.undoSnapshotId, overwrite: [] }))
      .failed,
  ).toEqual([])
})

it('05 验收 14、22: a real undo capture exceeding its byte budget returns over-budget', async () => {
  await setup('home', 160_000)
  await writeFile(path('a'), 'A'.repeat(20_000))
  const before = await take('a')
  await writeFile(path('a'), 'B'.repeat(100_000))
  const q: RestoreQuery = {
    sessionId,
    roundRunId,
    calls: [{ callKey: 'c', before, path: path('a') }],
  }
  const preview = await snapshots.preview(q)
  expect(await snapshots.prepare({ ...q, previewKey: preview.previewKey })).toEqual({
    ok: false,
    reason: 'over-budget',
  })
  expect(await readFile(path('a'), 'utf8')).toBe('B'.repeat(100_000))
})

it('05 验收 41: changed exclusions skip one path without blocking prepare or other paths', async () => {
  await setup('tree')
  await writeFile(path('f'), 'A')
  await writeFile(path('g'), 'A')
  const before = await take()
  await writeFile(path('.gitignore'), 'f\n')
  await writeFile(path('f'), 'B')
  await writeFile(path('g'), 'B')
  const after = await take(undefined, 'after-call')
  const q: RestoreQuery = { sessionId, roundRunId, calls: [{ callKey: 'bash', before, after }] }
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  expect(prepared).toMatchObject({ ok: true })
  if (!prepared.ok) throw new Error(prepared.reason)
  expect(
    (await snapshots.apply({ sessionId, undoSnapshotId: prepared.undoSnapshotId, overwrite: [] }))
      .failed,
  ).toEqual([])
})

it('05 验收 46、52: an ignored file-tool target and a later Write both restore', async () => {
  await setup('tree')
  await writeFile(path('.gitignore'), '.env\n')
  await writeFile(path('.env'), 'A')
  await writeFile(path('f'), 'A')
  const b1 = await take('.env')
  await writeFile(path('.env'), 'B')
  const a1 = await take('.env', 'after-call')
  const b2 = await take('f')
  await writeFile(path('f'), 'B')
  const a2 = await take('f', 'after-call')
  const q: RestoreQuery = {
    sessionId,
    roundRunId,
    calls: [
      { callKey: '1', before: b1, after: a1, path: path('.env') },
      { callKey: '2', before: b2, after: a2, path: path('f') },
    ],
  }
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  expect(preview.restore).toEqual([path('.env'), path('f')])
  expect(preview.skipped).toEqual([])
  if (!prepared.ok) throw new Error(prepared.reason)
  expect(
    (await snapshots.apply({ sessionId, undoSnapshotId: prepared.undoSnapshotId, overwrite: [] }))
      .failed,
  ).toEqual([])
  expect(await readFile(path('.env'), 'utf8')).toBe('A')
  expect(await readFile(path('f'), 'utf8')).toBe('A')
})

it('05 验收 18、41: RC-8 — a path gitignored by the user after the round (check-ignore skip) does not make prepare stale', async () => {
  await setup('tree')
  await writeFile(path('f'), 'A')
  await writeFile(path('g'), 'A')
  const before = await take()
  await writeFile(path('f'), 'B')
  await writeFile(path('g'), 'B')
  const after = await take(undefined, 'after-call')
  await writeFile(path('.gitignore'), 'f\n')
  const q = { sessionId, roundRunId, calls: [{ callKey: 'bash', before, after }] }
  const preview = await snapshots.preview(q)
  expect(preview.skipped).toContainEqual({ path: path('f'), reason: 'excluded' })
  expect(preview.restore).toEqual([path('g')])
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  expect(prepared).toMatchObject({ ok: true })
  if (prepared.ok) await snapshots.cancel({ sessionId, undoSnapshotId: prepared.undoSnapshotId })
})

it('05 验收 52、54: a prior single-file copy survives a later missing before record as a kept conflict', async () => {
  await setup('home')
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  await writeFile(path('f'), 'C')
  const laterAfter = await take('f', 'after-call')
  // A sparse call history cannot prove continuity, but does not invalidate a known file copy.
  const q = {
    sessionId,
    roundRunId,
    calls: [
      { callKey: 'first', path: path('f'), before, after },
      { callKey: 'later', path: path('f'), after: laterAfter },
    ],
  }
  const preview = await snapshots.preview(q)
  expect(preview.skipped).toEqual([])
  expect(preview.restore).toEqual([path('f')])
  expect(preview.conflicts).toEqual([path('f')])
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  if (!prepared.ok) throw new Error(prepared.reason)
  const done = await snapshots.apply({
    sessionId,
    undoSnapshotId: prepared.undoSnapshotId,
    overwrite: [],
  })
  expect(done).toMatchObject({ kept: 1, restored: 0, failed: [] })
  expect(await readFile(path('f'), 'utf8')).toBe('C')
})

/** Real file executors and restore host, with scripted model turns and an in-memory Tape. */
async function kernelRound(
  calls: readonly { name: string; input: Record<string, unknown> }[],
  options: { commandStarted?: () => void; fs?: DesktopFs } = {},
) {
  const process = createHostProcess()
  const host = {
    ...createMemoryHost(),
    fs: options.fs ?? new DesktopFs(),
    snapshots,
    clock: new SystemClock(),
    process: {
      spawn: (...args: Parameters<typeof process.spawn>) => {
        options.commandStarted?.()
        return process.spawn(...args)
      },
    },
  }
  const tape = createMemoryTapeStore({ identity: host.identity })
  const model = {
    id: 'restore-integration',
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
  const provider = createScriptedProvider({ models: [model] })
  const ports = createTestLoopPorts({ connector: { provider, model } })
  const logs: string[] = []
  const service = createTestSessionService(
    {
      host,
      tape,
      ids: createCounterIds(),
      connector: ports.connector,
      inspectors: [],
      protectedFiles: [],
      log: (line) => logs.push(line),
    },
    { tools: { Write: 'real', Edit: 'real', Delete: 'real', Bash: 'real' } },
  )
  service.bindLoop(ports)
  await service.selectProfile({ sessionId, profile: 'cowork', dedicated: folder })
  calls.forEach(({ name, input }, index) => {
    const id = `call-${index}`
    provider.script([
      { type: 'tool-call-start', index: 0, id, name },
      { type: 'tool-call-end', index: 0, id, name, input },
      stopEvent('tool-use', 'tool_use'),
    ])
  })
  provider.script(scriptedTurn({ deltas: ['done'] }))
  const sent = await service.send({ sessionId, origin: null, text: 'change files' })
  if (sent.status !== 'started') throw new Error('Run did not start')
  roundRunId = sent.runId
  const cards = []
  for (let i = 0; i <= calls.length; i++) {
    // oxlint-disable-next-line no-await-in-loop -- wait for each resumed Run before answering its next approval
    const end = await ports.runEnded()
    if (end.reason.code === 'completed') break
    expect(end.reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    // oxlint-disable-next-line no-await-in-loop -- the pending card belongs to the Run that just paused
    const pending = await service.currentPending({ sessionId })
    if (pending === null || pending.waitKind === 'question') throw new Error('Approval missing')
    cards.push(pending.card)
    expect(
      // oxlint-disable-next-line no-await-in-loop -- approval must precede the next resumed Run
      await service.answer({
        kind: 'approval',
        sessionId,
        requestId: pending.card.requestId,
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
  }
  expect(await service.currentPending({ sessionId })).toBeNull()
  expect(logs).toEqual([])
  const entries = async () => (await tape.readRange({ sessionId, limit: 1000 })).entries
  const preview = async () => {
    const result = await service.snapshotPreview({ sessionId, roundRunId })
    if (!result.ok) throw new Error(result.code)
    return result.preview
  }
  const restore = async () => {
    const p = await preview()
    return service.snapshotRestore({
      sessionId,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    })
  }
  return { service, tape, cards, entries, preview, restore }
}
const writeCall = (name: string, content: string) => ({
  name: 'Write',
  input: { file_path: path(name), content },
})
const refusedEdit = () => ({
  name: 'Edit',
  input: { file_path: path('g'), old_string: 'no such text', new_string: 'replacement' },
})

it.each(['current execution', 'legacy after-only Tape'] as const)(
  '05 验收 52: %s keeps a promised Write restorable and untouched files out of skips',
  async (history) => {
    await setup('tree')
    await writeFile(path('g'), 'origin')
    await writeFile(path('untouched'), 'unchanged')
    // Control the kernel-facing warming boundary; captures and restore still use the real host.
    let ready = false
    vi.spyOn(snapshots, 'status').mockImplementation(() => (ready ? 'tree' : 'warming'))
    const h = await kernelRound(
      [writeCall('g', 'agent'), { name: 'Bash', input: { command: 'true' } }],
      {
        commandStarted: () => {
          ready = history === 'current execution'
        },
      },
    )
    ready = true
    expect(h.cards[0]?.reversibility).toBe('snapshotted')
    const entries = await h.entries()
    const command = entries.find(
      (e) => e.name === 'execution/dispatch_committed' && e.payload['name'] === 'Bash',
    )!
    expect(
      entries.filter(
        (e) =>
          e.name === 'fs/snapshot_created' &&
          e.sourceId === command.sourceId &&
          e.sourceSeq === command.sourceSeq,
      ),
    ).toEqual([])
    if (history === 'legacy after-only Tape') {
      const after = await take(undefined, 'after-call')
      await h.tape.append({
        sessionId,
        incarnationId: command.incarnationId,
        entries: [
          {
            kind: 'event',
            name: 'fs/snapshot_created',
            sourceType: 'runtime_event',
            sourceId: command.sourceId!,
            sourceSeq: command.sourceSeq!,
            provenanceKey: `fs:v1:snapshot:${command.sourceId}:${command.sourceSeq}:0:after-call`,
            createdAt: 0,
            payload: {
              runId: command.sourceId!,
              requestSeq: command.sourceSeq!,
              ordinal: 0,
              roundRunId,
              snapshotId: after,
              moment: 'after-call',
              scope: 'tree',
              skipped: 0,
              writer: { by: 'run' },
            },
          },
        ],
      })
    }
    expect(await h.service.snapshotRounds({ sessionId })).toMatchObject({
      ok: true,
      rounds: [{ commandsWithoutSnapshot: true, canRestore: true }],
    })
    expect(await h.preview()).toMatchObject({
      restore: [path('g')],
      remove: [],
      conflicts: [],
      skipped: [],
    })
    expect(await h.restore()).toMatchObject({ ok: true, restored: 1, failed: [] })
    expect(await readFile(path('g'), 'utf8')).toBe('origin')
    expect(await readFile(path('untouched'), 'utf8')).toBe('unchanged')
  },
)

it.each(['no match', 'no match before later writes', 'outside edit'] as const)(
  '05 验收 19: refused Edit after Write does not open a restore gap — %s',
  async (scenario) => {
    await setup('tree')
    await writeFile(path('g'), 'origin')
    if (scenario === 'outside edit') {
      const takeReal = snapshots.take.bind(snapshots)
      let captures = 0
      vi.spyOn(snapshots, 'take').mockImplementation(async (request, signal) => {
        if (request.moment === 'before-call' && ++captures === 2)
          await writeFile(path('g'), 'your outside edit')
        return takeReal(request, signal)
      })
    }
    const calls = [writeCall('g', 'agent'), refusedEdit()]
    if (scenario === 'no match before later writes')
      calls.push(writeCall('x', 'new file'), writeCall('g', 'agent again'))
    const h = await kernelRound(calls)
    const refused = (await h.entries()).filter((e) => e.name === 'tool/result')[1]!
    expect(refused.payload).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringContaining(
            scenario === 'outside edit' ? 'changed' : 'old_string was not found',
          ),
        },
      ],
    })
    const p = await h.preview()
    expect(p.skipped).toEqual([])
    expect(p.restore).toEqual([path('g')])
    expect(p.conflicts).toEqual(scenario === 'outside edit' ? [path('g')] : [])
    expect(p.remove).toEqual(scenario === 'no match before later writes' ? [path('x')] : [])
    expect(await h.restore()).toMatchObject({
      ok: true,
      restored: scenario === 'outside edit' ? 0 : 1,
      kept: scenario === 'outside edit' ? 1 : 0,
      failed: [],
    })
    expect(await readFile(path('g'), 'utf8')).toBe(
      scenario === 'outside edit' ? 'your outside edit' : 'origin',
    )
    await expect(readFile(path('x'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it.each([
  ['Delete notFound', 'Delete'],
  ['Delete parentChanged', 'Delete'],
  ['Delete targetChanged', 'Delete'],
  ['Write resolvesElsewhere', 'Write'],
  ['Edit tooLarge', 'Edit'],
] as const)(
  '05 验收 19: %s before mutation leaves later writes conflict-free and new files removable',
  async (failure, tool) => {
    await setup('home')
    await writeFile(path('g'), 'origin')
    await mkdir(path('dir'))
    const target = path('dir/h')
    const original =
      failure === 'Edit tooLarge'
        ? Buffer.alloc(64 * 1024 * 1024 + 1, 65)
        : Buffer.from('original h')
    if (failure !== 'Delete notFound') await writeFile(target, original)
    await writeFile(path('anchor'), 'untouched anchor')
    const fs = new DesktopFs()
    const mutations = [
      vi.spyOn(fs, 'mkdirp'),
      vi.spyOn(fs, 'remove'),
      vi.spyOn(fs, 'writeFile'),
      vi.spyOn(fs.guarded, 'create'),
    ]
    const counts = () => mutations.map((spy) => spy.mock.calls.length)
    let beforeRefusal: number[] = []
    let afterRefusal: number[] = []
    let resolveRace = false
    const realResolve = fs.realpath.bind(fs)
    vi.spyOn(fs, 'realpath').mockImplementation(async (file) => {
      if (resolveRace && file === target) {
        resolveRace = false
        // Write has passed snapshotGuard; replace the leaf before stillNamesItself resolves it.
        await rm(target)
        await symlink(path('anchor'), target)
      }
      return realResolve(file)
    })
    const takeReal = snapshots.take.bind(snapshots)
    let captures = 0
    vi.spyOn(snapshots, 'take').mockImplementation(async (request, signal) => {
      if (request.moment === 'before-call') {
        captures++
        if (captures === 2) {
          beforeRefusal = counts()
          if (failure === 'Delete targetChanged') {
            // Approval saw a regular file; capture sees a link, so the kind check refuses Delete.
            await rm(target)
            await symlink(path('anchor'), target)
          }
        }
        if (captures === 3) {
          afterRefusal = counts()
          // End the transient race before subsequent calls: no outside content change remains.
          if (failure === 'Delete parentChanged') {
            await rm(path('dir'))
            await rename(path('saved-dir'), path('dir'))
          }
          if (failure === 'Delete targetChanged' || failure === 'Write resolvesElsewhere') {
            await rm(target)
            await writeFile(target, original)
          }
        }
      }
      const result = await takeReal(request, signal)
      if (request.moment === 'before-call' && captures === 2) {
        if (failure === 'Delete parentChanged') {
          await rename(path('dir'), path('saved-dir'))
          await symlink(path('saved-dir'), path('dir'))
        }
        resolveRace = failure === 'Write resolvesElsewhere'
      }
      return result
    })
    const input =
      tool === 'Edit'
        ? { file_path: target, old_string: 'A', new_string: 'B' }
        : tool === 'Write'
          ? { file_path: target, content: 'must not be written' }
          : { file_path: target }
    const h = await kernelRound(
      [
        writeCall('g', 'agent'),
        { name: tool, input },
        writeCall('x', 'new x'),
        writeCall('dir/h', 'new h'),
      ],
      { fs },
    )
    const texts = {
      'Delete notFound': `Nothing exists at ${target}.`,
      'Delete parentChanged': 'The parent folder changed after approval. Nothing was deleted.',
      'Delete targetChanged': 'The file or link changed after approval. Nothing was deleted.',
      'Write resolvesElsewhere': `${target} now resolves elsewhere, through a link that leads to another path or to none, so nothing was written.`,
      'Edit tooLarge': `${target} is ${original.length} bytes, larger than the 67108864 bytes a file tool opens.`,
    }
    const entries = await h.entries()
    const refusal = entries.filter((e) => e.name === 'tool/result')[1]!
    expect(refusal.payload).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: texts[failure] }],
    })
    expect(beforeRefusal).toHaveLength(4)
    expect(afterRefusal).toEqual(beforeRefusal)
    expect(
      entries
        .filter(
          (e) =>
            e.name === 'fs/snapshot_created' &&
            e.sourceId === refusal.sourceId &&
            e.sourceSeq === refusal.sourceSeq,
        )
        .map((e) => e.payload['moment']),
    ).toEqual(['before-call'])
    const p = await h.preview()
    expect(p.conflicts).toEqual([])
    expect(p.skipped).toEqual([])
    expect(p.remove).toContain(path('x'))
    expect(failure === 'Delete notFound' ? p.remove : p.restore).toContain(target)
    expect(await h.restore()).toMatchObject({ ok: true, kept: 0, failed: [] })
    expect(await readFile(path('g'), 'utf8')).toBe('origin')
    expect(await readFile(path('anchor'), 'utf8')).toBe('untouched anchor')
    await expect(readFile(path('x'))).rejects.toMatchObject({ code: 'ENOENT' })
    const restoredTarget = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    expect(restoredTarget === null ? null : restoredTarget.equals(original)).toBe(
      failure === 'Delete notFound' ? null : true,
    )
  },
  20_000,
)

it.each(['alone', 'before the agent creates the path'] as const)(
  '05 验收 19: notDirectory refusal %s adds no restorable change or conflict',
  async (scenario) => {
    await setup('tree')
    await writeFile(path('f'), 'origin')
    const calls: { name: string; input: Record<string, unknown> }[] = [writeCall('f/x', 'never')]
    if (scenario !== 'alone')
      calls.push({
        name: 'Bash',
        input: { command: 'rm f && mkdir f && printf new > f/x && printf y > y' },
      })
    const preview = vi.spyOn(snapshots, 'preview')
    const h = await kernelRound(calls)
    expect((await h.entries()).find((e) => e.name === 'tool/result')?.payload).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: `${path('f')} is a file, not a folder.` }],
    })
    expect(await h.service.snapshotRounds({ sessionId })).toMatchObject({
      ok: true,
      rounds: [{ canRestore: scenario !== 'alone' }],
    })
    const p = await h.service.snapshotPreview({ sessionId, roundRunId })
    expect(p.ok ? p.preview.conflicts : p.code).toEqual(scenario === 'alone' ? 'gone' : [])
    expect(
      preview.mock.calls.flatMap(([q]) => q.calls).every((call) => call.path !== path('f/x')),
    ).toBe(true)
  },
)

it.each(['read-only command', 'Write'] as const)(
  '05 验收 33: %s is restorable only while its preview has changes, without extra previews',
  async (tool) => {
    await setup('tree')
    await writeFile(path('g'), 'origin')
    const h = await kernelRound([
      tool === 'Write' ? writeCall('g', 'agent') : { name: 'Bash', input: { command: 'true' } },
    ])
    const spy = vi.spyOn(snapshots, 'preview')
    const rounds = () => h.service.snapshotRounds({ sessionId })
    expect(await rounds()).toMatchObject({
      ok: true,
      rounds: [{ canRestore: tool === 'Write', commandsWithoutSnapshot: false }],
    })
    await rounds()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(await h.restore()).toMatchObject({ ok: true, failed: [] })
    spy.mockClear()
    expect(await rounds()).toMatchObject({ ok: true, rounds: [{ canRestore: false }] })
    await rounds()
    expect(spy).toHaveBeenCalledTimes(1)
  },
)

it('05 验收 19: a Write that changes bytes before throwing remains in the restore comparison', async () => {
  await setup('tree')
  await writeFile(path('g'), 'origin')
  const fs = new DesktopFs()
  const write = fs.writeFile.bind(fs)
  vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (file) => {
    await write(file, 'partial bytes')
    throw new Error('injected failure after writing')
  })
  const h = await kernelRound([writeCall('g', 'requested bytes')], { fs })
  expect((await h.entries()).find((e) => e.name === 'tool/result')?.payload).toMatchObject({
    isError: true,
  })
  expect(await readFile(path('g'), 'utf8')).toBe('partial bytes')
  expect(await h.preview()).toMatchObject({ restore: [path('g')], conflicts: [], skipped: [] })
  expect(await h.restore()).toMatchObject({ ok: true, restored: 1, failed: [] })
  expect(await readFile(path('g'), 'utf8')).toBe('origin')
})

it('05 验收 33: a command with only hardlink skips does not offer restore', async () => {
  await setup('tree')
  await writeFile(path('h'), 'origin')
  await link(path('h'), path('second-name'))
  const h = await kernelRound([{ name: 'Bash', input: { command: 'printf agent > h' } }])
  const preview = await h.preview()
  expect(preview).toMatchObject({ restore: [], remove: [], conflicts: [] })
  expect(preview.skipped).toEqual([
    { path: path('h'), reason: 'hardlink' },
    { path: path('second-name'), reason: 'hardlink' },
  ])
  expect(await h.service.snapshotRounds({ sessionId })).toMatchObject({
    ok: true,
    rounds: [{ canRestore: false, incompleteCoverage: true }],
  })
})
