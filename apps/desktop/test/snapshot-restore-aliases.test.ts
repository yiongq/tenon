/** RC-1: normalization aliases must never delete the only physical copy. */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { folder, path, snapshots, query, take, restore } from './support/snapshot-boundaries.js'

// APFS commonly aliases Unicode normalization forms; Linux normally treats them as distinct.
it.skipIf(process.platform !== 'darwin')(
  '05 验收 40: RC-1 — NFC/NFD directory aliases keep the only file',
  async () => {
    const nfc = 'Café'
    const nfd = nfc.normalize('NFD')
    await mkdir(path(nfc))
    await writeFile(path(`${nfc}/f`), 'origin')
    const before = await take()
    await rename(path(nfc), path(nfd))
    await writeFile(path(`${nfd}/f`), 'agent edit')
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const initial = await snapshots.preview(q)
    expect(initial.skipped.map((skip) => skip.path).toSorted()).toEqual(
      [path(nfc), path(nfd), path(`${nfc}/f`), path(`${nfd}/f`)].toSorted(),
    )
    const { done } = await restore(q)
    expect(done.removed).toBe(0)
    const names = await readdir(folder)
    expect(names).toHaveLength(1)
    expect(await readFile(path(`${names[0]}/f`), 'utf8')).toBe('agent edit')
    const preview = await snapshots.preview(q)
    expect(preview.remove).toEqual([])
  },
)

it('05 验收 40: alias fallback folds NFC/NFD and mixed case on every platform', async () => {
  const { foldRestorePath } = await import('../src/main/host/snapshot-restore.js')
  expect(foldRestorePath('/work/Cafe\u0301/F')).toBe(foldRestorePath('/work/CAFÉ/f'))
  expect(foldRestorePath('/work/Café/f')).not.toBe(foldRestorePath('/work/Cafe/f'))
})

// The removal guard must work even if an older/stale plan admitted an aliased removal.
it.skipIf(process.platform !== 'darwin')(
  '05 验收 19、40: apply rejects an inode shared with a skipped spelling',
  async () => {
    const { sessionId } = await import('./support/snapshot-boundaries.js')
    const before = await take()
    await writeFile(path('Café'), 'only copy')
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const preview = await snapshots.preview(q)
    const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
    if (!prepared.ok) throw new Error(prepared.reason)
    const plan = snapshots['prepared'].get(sessionId)!.plan
    plan.preview = {
      ...plan.preview,
      skipped: [...plan.preview.skipped, { path: path('Cafe\u0301'), reason: 'not-covered' }],
    }
    const done = await snapshots.apply({
      sessionId,
      undoSnapshotId: prepared.undoSnapshotId,
      overwrite: [],
    })
    expect(done).toMatchObject({ removed: 0, failed: [path('Café')] })
    expect(await readFile(path('Café'), 'utf8')).toBe('only copy')
  },
)
