/** Real plans, with filesystem changes/faults injected at restore boundaries. */
vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fsPromises>()) }))
import * as fsPromises from 'node:fs/promises'
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RestoreQuery } from '@tenon-app/kernel'
import { expect, it, vi } from 'vitest'
import { path, temp, snapshots, sessionId, query, take } from './support/snapshot-boundaries.js'

async function prepare(q: RestoreQuery) {
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  if (!prepared.ok) throw new Error(prepared.reason)
  return { preview, undoSnapshotId: prepared.undoSnapshotId }
}

it('05 验收 19、40: a real plan protects a retained path that aliases a removal after prepare', async () => {
  await mkdir(path('sub'))
  await writeFile(path('sub/new'), 'origin')
  const beforeKept = await take('sub/new')
  await writeFile(path('sub/new'), 'edited')
  const afterKept = await take('sub/new', 'after-call')
  const beforeNew = await take('new')
  await writeFile(path('new'), 'only copy')
  const afterNew = await take('new', 'after-call')
  await mkdir(join(temp, 'empty'))
  await rm(path('sub'), { recursive: true })
  await symlink(join(temp, 'empty'), path('sub'))
  const q = query([
    { callKey: 'kept', before: beforeKept, after: afterKept, path: path('sub/new') },
    { callKey: 'new', before: beforeNew, after: afterNew, path: path('new') },
  ])
  const { preview, undoSnapshotId } = await prepare(q)
  expect(preview.remove).toEqual([path('new')])
  expect(preview.restore).toEqual([path('sub/new')])
  expect(preview.conflicts).toEqual([path('sub/new')])
  expect(preview.skipped).toEqual([])
  // The real plan is unchanged; an outside actor retargets the retained path's parent to the removal's inode.
  await rm(path('sub'))
  await symlink('.', path('sub'))
  const done = await snapshots.apply({ sessionId, undoSnapshotId, overwrite: [] })
  expect(done).toMatchObject({ removed: 0, kept: 1, failed: [path('new')] })
  expect(await readFile(path('new'), 'utf8')).toBe('only copy')
  expect(await readFile(path('sub/new'), 'utf8')).toBe('only copy')
})

it('05 验收 19、40: an unreadable retained identity blocks otherwise valid removals', async () => {
  await writeFile(path('keep'), 'origin')
  const before = await take()
  await writeFile(path('keep'), 'edited')
  await writeFile(path('new'), 'only copy')
  const after = await take(undefined, 'after-call')
  const { undoSnapshotId } = await prepare(query([{ callKey: 'bash', before, after }]))
  const lstat = fsPromises.lstat
  vi.spyOn(fsPromises, 'lstat').mockImplementation((async (...args: Parameters<typeof lstat>) => {
    if (args[0] === path('keep'))
      throw Object.assign(new Error('permission changed'), { code: 'EACCES' })
    return lstat(...args)
  }) as typeof lstat)
  const done = await snapshots.apply({ sessionId, undoSnapshotId, overwrite: [] })
  expect(done.removed).toBe(0)
  expect(done.failed).toEqual(expect.arrayContaining([path('keep'), path('new')]))
  expect(await readFile(path('new'), 'utf8')).toBe('only copy')
})

// Requires a volume where A.txt and a.txt currently resolve to the same inode.
it.skipIf(process.platform !== 'darwin')(
  '05 验收 19、40: deletion rechecks a pair swapped between the two identity reads',
  async () => {
    await writeFile(path('A.txt'), 'origin')
    const before = await take()
    await rename(path('A.txt'), path('a.txt'))
    await writeFile(path('a.txt'), 'agent edit')
    const after = await take(undefined, 'after-call')
    const { undoSnapshotId } = await prepare(query([{ callKey: 'bash', before, after }]))
    const lstat = fsPromises.lstat
    const swapped = Promise.withResolvers<void>()
    let originReads = 0
    let swapping = false
    vi.spyOn(fsPromises, 'lstat').mockImplementation((async (...args: Parameters<typeof lstat>) => {
      // Grouping, initial pairing, retained-object index, then the destructive boundary recheck.
      if (args[0] === path('A.txt') && ++originReads === 4) {
        swapping = true
        const previous = await lstat(...args)
        await rename(path('a.txt'), join(temp, 'moved'))
        await writeFile(path('a.txt'), 'outside replacement')
        swapped.resolve()
        return previous
      }
      if (args[0] === path('a.txt') && swapping) await swapped.promise
      return lstat(...args)
    }) as typeof lstat)
    const done = await snapshots.apply({ sessionId, undoSnapshotId, overwrite: [] })
    expect(swapping).toBe(true)
    expect(done).toMatchObject({ restored: 0, removed: 0 })
    expect(done.failed).toEqual(expect.arrayContaining([path('A.txt'), path('a.txt')]))
    expect(await readFile(path('a.txt'), 'utf8')).toBe('outside replacement')
    expect(await readFile(join(temp, 'moved'), 'utf8')).toBe('agent edit')
  },
)

it.skipIf(process.platform !== 'darwin')(
  '05 验收 40、52: three actionable spellings sharing a live inode are all skipped',
  async () => {
    await writeFile(path('A.txt'), 'origin')
    const beforeA = await take('A.txt')
    await writeFile(path('A.txt'), 'first')
    const afterA = await take('A.txt', 'after-call')
    await rename(path('A.txt'), path('a.txt'))
    const beforeB = await take('a.txt')
    await writeFile(path('a.txt'), 'second')
    const afterB = await take('a.txt', 'after-call')
    await rename(path('a.txt'), path('a.TXT'))
    const beforeC = await take('a.TXT')
    await writeFile(path('a.TXT'), 'third')
    const afterC = await take('a.TXT', 'after-call')
    const q = query([
      { callKey: 'a', before: beforeA, after: afterA, path: path('A.txt') },
      { callKey: 'b', before: beforeB, after: afterB, path: path('a.txt') },
      { callKey: 'c', before: beforeC, after: afterC, path: path('a.TXT') },
    ])
    const preview = await snapshots.preview(q)
    expect(preview.restore).toEqual([])
    expect(preview.remove).toEqual([])
    expect(preview.skipped).toHaveLength(3)
    expect(preview.skipped).toEqual(
      expect.arrayContaining(
        ['A.txt', 'a.txt', 'a.TXT'].map((name) => ({
          path: path(name),
          reason: 'not-covered',
          promised: true,
        })),
      ),
    )
    expect(await readFile(path('a.TXT'), 'utf8')).toBe('third')
  },
)

// Parent-alias propagation must still protect descendants when leaf identity grouping is unavailable.
it.skipIf(process.platform !== 'darwin')(
  '05 验收 39、40: a proven parent alias protects its child even when the old leaf identity is unreadable',
  async () => {
    await mkdir(path('Dir'))
    await writeFile(path('Dir/f'), 'origin')
    const before = await take()
    await rename(path('Dir'), path('dir'))
    await writeFile(path('dir/f'), 'only copy')
    const after = await take(undefined, 'after-call')
    const lstat = fsPromises.lstat
    vi.spyOn(fsPromises, 'lstat').mockImplementation((async (...args: Parameters<typeof lstat>) => {
      if (args[0] === path('Dir/f'))
        throw Object.assign(new Error('unreadable old spelling'), { code: 'EACCES' })
      return lstat(...args)
    }) as typeof lstat)
    const preview = await snapshots.preview(query([{ callKey: 'bash', before, after }]))
    expect(preview.restore).toEqual([])
    expect(preview.remove).toEqual([])
    expect(preview.skipped).toContainEqual({ path: path('dir/f'), reason: 'not-covered' })
    expect(await readFile(path('dir/f'), 'utf8')).toBe('only copy')
  },
)
