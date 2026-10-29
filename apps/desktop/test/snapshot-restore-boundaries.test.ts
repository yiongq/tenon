import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
  symlink as lnSymlink,
  symlink as fsSymlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parents, exactEntry } from '../src/main/host/snapshot-restore.js'
import {
  temp,
  folder,
  snapshots,
  sessionId,
  path,
  query,
  take,
  restore,
} from './support/snapshot-boundaries.js'
it('05 验收 21: A1 — bytes damaged between prepare and apply fail only that path and leave the file untouched', async () => {
  await writeFile(path('f'), 'A')
  await writeFile(path('g'), 'G')
  const before = await take('f')
  const beforeG = await take('g')
  await writeFile(path('f'), 'B')
  await writeFile(path('g'), 'B')
  const after = await take('f', 'after-call')
  const afterG = await take('g', 'after-call')
  const q = query([
    { callKey: 'f', before, after, path: path('f') },
    { callKey: 'g', before: beforeG, after: afterG, path: path('g') },
  ])
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  if (!prepared.ok) throw new Error(prepared.reason)
  const session = snapshots['sessions'].get(sessionId)!
  const hash = session.manifests
    .find((m) => m.id === before)!
    .files.find((x) => x.path === path('f'))!.hash!
  await writeFile(join(session.dir, 'files', hash), 'tampered')
  const done = await snapshots.apply({
    sessionId,
    undoSnapshotId: prepared.undoSnapshotId,
    overwrite: [],
  })
  expect(done.failed).toEqual([path('f')])
  expect(done.restored).toBe(1)
  expect(await readFile(path('f'), 'utf8')).toBe('B')
  expect(await readFile(path('g'), 'utf8')).toBe('G')
})

it.each(['new child', 'mode only'] as const)(
  '05 验收 19、21: A2 — a file replaced by a directory fails if the directory changes after prepare (%s)',
  async (change) => {
    await writeFile(path('f'), 'A')
    const before = await take()
    await rm(path('f'))
    await mkdir(path('f'))
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const preview = await snapshots.preview(q)
    const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
    if (!prepared.ok) throw new Error(prepared.reason)
    if (change === 'new child') await writeFile(path('f/late'), 'owner')
    else await chmod(path('f'), 0o711)
    const done = await snapshots.apply({
      sessionId,
      undoSnapshotId: prepared.undoSnapshotId,
      overwrite: [],
    })
    expect(done.failed).toEqual([path('f')])
    expect((await lstat(path('f'))).isDirectory()).toBe(true)
    const preserved =
      change === 'new child'
        ? await readFile(path('f/late'), 'utf8')
        : (await lstat(path('f'))).mode & 0o7777
    expect(preserved).toBe(change === 'new child' ? 'owner' : 0o711)
  },
)

it('05 验收 49: A3 — restoring a file whose parent directory was removed later recreates the parent with its recorded mode', async () => {
  await mkdir(path('d'), { mode: 0o750 })
  await chmod(path('d'), 0o750)
  await writeFile(path('d/x'), 'A')
  const before = await take('d/x')
  await writeFile(path('d/x'), 'B')
  const after = await take('d/x', 'after-call')
  await rm(path('d'), { recursive: true })
  const { done } = await restore(query([{ callKey: 'file', before, after, path: path('d/x') }]), [
    path('d/x'),
  ])
  expect(done).toMatchObject({ restored: 1, failed: [] })
  expect(await readFile(path('d/x'), 'utf8')).toBe('A')
  expect((await lstat(path('d'))).mode & 0o7777).toBe(0o750)
})

it('05 验收 39: A4 — a parent directory swapped for a link after prepare is never written through', async () => {
  await mkdir(path('d'))
  await writeFile(path('d/f'), 'A')
  const outside = join(temp, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'f'), 'outside original')
  const before = await take('d/f')
  await writeFile(path('d/f'), 'B')
  const after = await take('d/f', 'after-call')
  const q = query([{ callKey: 'file', before, after, path: path('d/f') }])
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  if (!prepared.ok) throw new Error(prepared.reason)
  await rm(path('d'), { recursive: true })
  await lnSymlink(outside, path('d'))
  const done = await snapshots.apply({
    sessionId,
    undoSnapshotId: prepared.undoSnapshotId,
    overwrite: [],
  })
  expect(done.failed).toEqual([path('d/f')])
  expect(await readFile(join(outside, 'f'), 'utf8')).toBe('outside original')
})

it('05 验收 19、21: A5 — a file the command created is not deleted when the owner edited it after prepare', async () => {
  const before = await take()
  await writeFile(path('new'), 'agent')
  const after = await take(undefined, 'after-call')
  const q = query([{ callKey: 'bash', before, after }])
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  if (!prepared.ok) throw new Error(prepared.reason)
  await writeFile(path('new'), 'owner wrote more')
  const done = await snapshots.apply({
    sessionId,
    undoSnapshotId: prepared.undoSnapshotId,
    overwrite: [],
  })
  expect(done.failed).toEqual([path('new')])
  expect(done.removed).toBe(0)
  expect(await readFile(path('new'), 'utf8')).toBe('owner wrote more')
})

it('05 验收 49: A7 — a deleted empty directory is recreated with its mode', async () => {
  await mkdir(path('empty'), { mode: 0o750 })
  await chmod(path('empty'), 0o750)
  const before = await take()
  await rm(path('empty'), { recursive: true })
  const after = await take(undefined, 'after-call')
  const { done } = await restore(query([{ callKey: 'bash', before, after }]))
  expect(done).toMatchObject({ restored: 1, failed: [] })
  expect((await lstat(path('empty'))).isDirectory()).toBe(true)
  expect((await lstat(path('empty'))).mode & 0o7777).toBe(0o750)
})

it('05 验收 39、49: B5 — parents() refuses paths outside the root, aliased roots and links, and creates only what it must', async () => {
  const root = folder
  await mkdir(join(root, 'real'))
  await fsSymlink(join(root, 'real'), join(root, 'link'))
  await writeFile(join(root, 'file'), 'x')
  await expect(parents(root, join(temp, 'elsewhere', 'x'), false)).rejects.toThrow(
    'outside workspace',
  )
  expect(await parents(root, join(root, 'x'), false)).toBe(true) // direct child
  expect(await parents(root, root, true)).toBe(true)
  expect(await parents(root, join(root, 'real', 'x'), false)).toBe(true)
  expect(await parents(root, join(root, 'missing', 'x'), false)).toBe(false)
  expect(await parents(root, join(root, 'link', 'x'), false)).toBe(false)
  await expect(parents(root, join(root, 'link', 'x'), true)).rejects.toThrow(
    'Unsafe restore parent',
  )
  expect(await parents(root, join(root, 'file', 'x'), false)).toBe(false)
  await expect(parents(root, join(root, 'file', 'x'), true)).rejects.toThrow(
    'Unsafe restore parent',
  )
  const created = new Set<string>()
  expect(
    await parents(root, join(root, 'a', 'b', 'x'), true, { [join(root, 'a')]: 0o050 }, created),
  ).toBe(true)
  expect([...created].toSorted()).toEqual([join(root, 'a'), join(root, 'a', 'b')])
  expect((await lstat(join(root, 'a'))).mode & 0o7777).toBe((0o050 | 0o700) & ~process.umask())
  // the root itself must be a real directory path
  await expect(parents(join(root, 'link'), join(root, 'link', 'x', 'y'), false)).rejects.toThrow(
    'Workspace root changed',
  )
  await expect(parents(join(root, 'file'), join(root, 'file', 'x', 'y'), false)).rejects.toThrow(
    'Workspace root changed',
  )
  await expect(parents(join(root, 'nope'), join(root, 'nope', 'x', 'y'), false)).rejects.toThrow(
    'Workspace root changed',
  )
})

it('05 验收 40: B6 — exactEntry() is true only for the on-disk spelling and false when the directory is unreadable', async () => {
  await writeFile(path('Exact'), 'x')
  expect(await exactEntry(path('Exact'))).toBe(true)
  expect(await exactEntry(path('exact'))).toBe(false) // even on a case-insensitive volume
  expect(await exactEntry(path('nope'))).toBe(false)
  expect(await exactEntry(join(temp, 'no-dir', 'x'))).toBe(false)
})
