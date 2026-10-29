vi.mock('../src/main/host/snapshot-restore.js', async (original) => ({
  ...(await original<typeof restoreModule>()),
}))
import * as restoreModule from '../src/main/host/snapshot-restore.js'
import { chmod, mkdir, readFile, writeFile, utimes } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
import { workspaceLeases } from '../src/main/host/workspace-leases.js'
import {
  temp,
  folder,
  snapshots,
  sessionId,
  path,
  query,
  take,
} from './support/snapshot-boundaries.js'
async function changedFile() {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const q = query([{ callKey: 'file', before, after, path: path('f') }])
  const preview = await snapshots.preview(q)
  return { q, key: preview.previewKey, before }
}
const activeOf = () => snapshots['active']

it('05 验收 18、22、53: S1 — prepare refuses a second concurrent prepare, unknown snapshots and a wrong preview key, and leaves nothing pinned', async () => {
  const { q, key } = await changedFile()
  // a snapshot id the host does not know (one known call + one unknown call)
  const unknown = await snapshots.prepare({
    ...q,
    calls: [...q.calls, { callKey: 'x', before: 'no-such-snapshot' }],
    previewKey: key,
  })
  expect(unknown).toEqual({ ok: false, reason: 'gone' })
  expect(await snapshots.prepare({ ...q, previewKey: 'wrong-key' })).toEqual({
    ok: false,
    reason: 'stale',
  })
  expect(activeOf().size).toBe(0)
  const first = await snapshots.prepare({ ...q, previewKey: key })
  if (!first.ok) throw new Error(first.reason)
  expect(activeOf().get(sessionId)!).toBe(1) // the source round stays pinned while prepared
  expect(await snapshots.prepare({ ...q, previewKey: key })).toEqual({ ok: false, reason: 'busy' })
  expect(activeOf().get(sessionId)!).toBe(1)
  await snapshots.cancel({ sessionId, undoSnapshotId: first.undoSnapshotId })
  expect(activeOf().size).toBe(0)
  const released = workspaceLeases.exclusive([folder])
  expect(released).not.toBeNull()
  released?.() // the exclusive lease was released
})

it('05 验收 22: S2 — an unavailable store, or a failed undo capture, answers undo-unavailable and releases everything', async () => {
  const { q, key } = await changedFile()
  const session = snapshots['sessions'].get(sessionId)!
  const state = session.state
  session.state = 'unavailable'
  expect(await snapshots.prepare({ ...q, previewKey: key })).toEqual({
    ok: false,
    reason: 'undo-unavailable',
  })
  session.state = state
  const capture = vi
    .spyOn(snapshots as unknown as { capture: (typeof snapshots)['capture'] }, 'capture')
    .mockResolvedValueOnce({ ok: false, reason: 'error' })
  expect(await snapshots.prepare({ ...q, previewKey: key })).toEqual({
    ok: false,
    reason: 'undo-unavailable',
  })
  capture.mockRestore()
  expect(activeOf().size).toBe(0)
  const lease = workspaceLeases.exclusive([folder])
  expect(lease).not.toBeNull()
  lease?.()
  // and a good prepare works again afterwards
  expect((await snapshots.prepare({ ...q, previewKey: key })).ok).toBe(true)
})

it('05 验收 18: S3 — the workspace changing between undo capture and the final plan makes the prepare stale', async () => {
  const { q, key } = await changedFile()
  const capture = snapshots['capture'].bind(snapshots)
  vi.spyOn(
    snapshots as unknown as { capture: (typeof snapshots)['capture'] },
    'capture',
  ).mockImplementationOnce(async (...args) => {
    const result = await capture(...args)
    await writeFile(path('f'), 'owner edit after the undo capture')
    return result
  })
  expect(await snapshots.prepare({ ...q, previewKey: key })).toEqual({ ok: false, reason: 'stale' })
  expect(activeOf().size).toBe(0)
})

it('05 验收 21、22: S4 — apply/cancel only act on the prepared undo id; a changed workspace drops the prepared restore', async () => {
  const { q, key } = await changedFile()
  const prepared = await snapshots.prepare({ ...q, previewKey: key })
  if (!prepared.ok) throw new Error(prepared.reason)
  await snapshots.cancel({ sessionId, undoSnapshotId: 'some-other-id' }) // no-op
  await snapshots.cancel({ sessionId: randomUUID(), undoSnapshotId: prepared.undoSnapshotId }) // no-op
  await expect(
    snapshots.apply({ sessionId, undoSnapshotId: 'some-other-id', overwrite: [] }),
  ).rejects.toThrow('not prepared')
  expect(await readFile(path('f'), 'utf8')).toBe('B')
  // still prepared: the right id applies
  const done = await snapshots.apply({
    sessionId,
    undoSnapshotId: prepared.undoSnapshotId,
    overwrite: [],
  })
  expect(done).toMatchObject({ restored: 1, failed: [] })
  expect(activeOf().size).toBe(0)
  // second round: prepare, then the session's workspace changes -> dropped, lease and pin released
  await writeFile(path('f'), 'B')
  const again = await changedFile()
  const p2 = await snapshots.prepare({ ...again.q, previewKey: again.key })
  if (!p2.ok) throw new Error(p2.reason)
  const other = absolutePath(join(temp, 'other'))
  await mkdir(other)
  await snapshots.setWorkspace(sessionId, [folder, other])
  await snapshots.settled(sessionId)
  expect(activeOf().size).toBe(0)
  await expect(
    snapshots.apply({ sessionId, undoSnapshotId: p2.undoSnapshotId, overwrite: [] }),
  ).rejects.toThrow('not prepared')
  const lease = workspaceLeases.exclusive([folder, other])
  expect(lease).not.toBeNull()
  lease?.()
})

it('05 验收 18: B13 — the preview key ignores directory timestamp churn but notices a directory mode change', async () => {
  const before = await take()
  await mkdir(path('d'), { mode: 0o755 })
  await chmod(path('d'), 0o755) // establish a mode independent of the process umask
  const after = await take(undefined, 'after-call')
  const q = query([{ callKey: 'bash', before, after }])
  const k1 = (await snapshots.preview(q)).previewKey
  await writeFile(path('d/unrelated'), 'x') // changes the directory mtime only
  await utimes(path('d'), new Date(1_000_000), new Date(1_000_000))
  expect((await snapshots.preview(q)).previewKey).toBe(k1)
  await chmod(path('d'), 0o700)
  expect((await snapshots.preview(q)).previewKey).not.toBe(k1)
  await chmod(path('d'), 0o755)
})

it('05 验收 18: S6 — a timestamp-only change of a planned file between preview and prepare makes the preview key stale', async () => {
  const { q, key } = await changedFile()
  await utimes(path('f'), new Date(500_000), new Date(500_000))
  expect(await snapshots.prepare({ ...q, previewKey: key })).toEqual({ ok: false, reason: 'stale' })
  expect(snapshots['active'].size).toBe(0)
})

it('05 验收 21、22: N9 — every latest item must be captured even if the initial plan omitted it', async () => {
  const first = await changedFile()
  await writeFile(path('g'), 'G')
  const before = await take('g')
  await writeFile(path('g'), 'changed')
  const after = await take('g', 'after-call')
  const q = {
    ...first.q,
    calls: [...first.q.calls, { callKey: 'g', before, after, path: path('g') }],
  }
  const key = (await snapshots.preview(q)).previewKey
  // Model a path that was temporarily at its origin during the first plan, then changed back.
  // File-only capture cannot incidentally save it through the tree.
  snapshots['sessions'].get(sessionId)!.state = 'file-only'
  const plan = restoreModule.planRestore
  vi.spyOn(restoreModule, 'planRestore').mockImplementationOnce(async (...args) => {
    const initial = await plan(...args)
    return { ...initial, items: initial.items.filter((item) => item.path !== path('f')) }
  })
  expect(await snapshots.prepare({ ...q, previewKey: key })).toEqual({
    ok: false,
    reason: 'undo-unavailable',
  })
  expect(await readFile(path('f'), 'utf8')).toBe('B')
  expect(activeOf().size).toBe(0)
})
