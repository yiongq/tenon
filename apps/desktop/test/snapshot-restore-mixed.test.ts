/** Spec 05: skipped/already-restored paths must not make a mixed undo perpetually stale. */
import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
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
