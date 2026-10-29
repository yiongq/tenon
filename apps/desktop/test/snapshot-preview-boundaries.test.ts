import { mkdir, readFile, writeFile, truncate, link as fsLink } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
import type { SnapshotGit } from '../src/main/host/snapshot-git.js'
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
it('05 验收 41: R1 — ignore rules added after the capture exclude the path from the plan (current git check-ignore)', async () => {
  await writeFile(path('f'), 'A')
  const before = await take()
  await writeFile(path('f'), 'B')
  const after = await take(undefined, 'after-call')
  await writeFile(path('.gitignore'), 'f\n') // added only after the capture
  const preview = await snapshots.preview(query([{ callKey: 'bash', before, after }]))
  expect(preview.skipped).toEqual([{ path: path('f'), reason: 'excluded' }])
  expect(preview.restore).toEqual([])
  expect(preview.remove).toEqual([])
})

it('05 验收 41: R2 — check-ignore failing with exit 1 means "not ignored"; any other failure skips the path as not-covered', async () => {
  await writeFile(path('f'), 'A')
  const before = await take()
  await writeFile(path('f'), 'B')
  const after = await take(undefined, 'after-call')
  const q = query([{ callKey: 'bash', before, after }])
  const git = snapshots['git'] as SnapshotGit
  const run = git.run.bind(git)
  const failWith = (exitCode: number) =>
    vi.spyOn(git, 'run').mockImplementation(async (repo, root, args, sig, input) => {
      if (args[0] === 'check-ignore') throw Object.assign(new Error('check-ignore'), { exitCode })
      return run(repo, root, args, sig, input)
    })
  const one = failWith(1)
  expect((await snapshots.preview(q)).restore).toEqual([path('f')])
  one.mockRestore()
  const bad = failWith(128)
  const preview = await snapshots.preview(q)
  expect(preview.skipped).toEqual([{ path: path('f'), reason: 'not-covered' }])
  expect(preview.restore).toEqual([])
  bad.mockRestore()
})

it('05 验收 46、52: R4 — an explicit copy under a default-excluded directory remains promised across later tree exclusions', async () => {
  await mkdir(path('node_modules/pkg'), { recursive: true })
  await writeFile(path('node_modules/pkg/a.js'), 'A')
  const before = await take('node_modules/pkg/a.js')
  await writeFile(path('node_modules/pkg/a.js'), 'B')
  const after = await take('node_modules/pkg/a.js', 'after-call')
  const tree = await take()
  const q = query([
    { callKey: 'file', before, after, path: path('node_modules/pkg/a.js') },
    { callKey: 'bash', before: tree, after: tree },
  ])
  const preview = await snapshots.preview(q)
  expect(preview.skipped).toEqual([])
  expect(preview.restore).toEqual([path('node_modules/pkg/a.js')])
  const { done } = await restore(q)
  expect(done).toMatchObject({ restored: 1, failed: [] })
  expect(await readFile(path('node_modules/pkg/a.js'), 'utf8')).toBe('A')
})

it('05 验收 21、52: R6 — a tampered / malformed explicit copy is not-covered at preview, with the promise kept', async () => {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const q = query([{ callKey: 'file', before, after, path: path('f') }])
  const session = snapshots['sessions'].get(sessionId)!
  const manifest = session.manifests.find((m) => m.id === before)!
  const entry = manifest.files.find((file) => file.path === path('f'))!
  const good = entry.hash!
  for (const bad of [`zz${good}`, `${good}zz`, 'not-a-hash']) {
    entry.hash = bad
    // oxlint-disable-next-line no-await-in-loop -- each corrupt hash is installed before checking its preview
    const preview = await snapshots.preview(q)
    expect(preview.skipped).toEqual([{ path: path('f'), reason: 'not-covered' }])
  }
  entry.hash = good
  // content-addressed bytes replaced on disk: sha256 no longer matches
  await writeFile(join(session.dir, 'files', good), 'tampered')
  const preview = await snapshots.preview(q)
  expect(preview.skipped).toEqual([{ path: path('f'), reason: 'not-covered' }])
  expect(await readFile(path('f'), 'utf8')).toBe('B')
})

it('05 验收 52: B2 — an explicit file the command turned oversize is skipped as excluded, with the reason the live point reports', async () => {
  await writeFile(path('big'), 'A')
  const before = await take('big')
  await writeFile(path('big'), 'B')
  const after = await take('big', 'after-call')
  const q = query([{ callKey: 'file', before, after, path: path('big') }])
  await truncate(path('big'), 100_000_001)
  const preview = await snapshots.preview(q)
  expect(preview.skipped).toEqual([{ path: path('big'), reason: 'excluded', promised: true }])
  expect(preview.restore).toEqual([])
})

it('05 验收 39: B4 — with several workspace folders a path is planned against the tree of ITS (innermost) folder', async () => {
  const other = absolutePath(join(temp, 'workspace-b'))
  const nested = absolutePath(join(temp, 'workspace', 'inner'))
  await mkdir(other)
  await mkdir(nested)
  await snapshots.setWorkspace(sessionId, [folder, other, nested])
  await snapshots.settled(sessionId)
  await writeFile(join(other, 'b.txt'), 'A')
  await writeFile(join(nested, 'n.txt'), 'A')
  await writeFile(path('top.txt'), 'A')
  const before = await take()
  await writeFile(join(other, 'b.txt'), 'B')
  await writeFile(join(nested, 'n.txt'), 'B')
  await writeFile(path('top.txt'), 'B')
  const after = await take(undefined, 'after-call')
  const preview = await snapshots.preview(query([{ callKey: 'bash', before, after }]))
  expect(preview.skipped).toEqual([])
  expect([...preview.restore].toSorted()).toEqual(
    [join(other, 'b.txt'), join(nested, 'n.txt'), path('top.txt')].toSorted(),
  )
  const { done } = await restore(query([{ callKey: 'bash', before, after }]))
  expect(done).toMatchObject({ restored: 3, failed: [] })
  expect(await readFile(join(nested, 'n.txt'), 'utf8')).toBe('A')
})

it('05 验收 52: B7 — a manifest tree without the coverageComplete mark never proves that an absent path was absent', async () => {
  await writeFile(path('keep'), 'A')
  const before = await take()
  await writeFile(path('created'), 'new')
  const after = await take(undefined, 'after-call')
  const session = snapshots['sessions'].get(sessionId)!
  for (const id of [before, after])
    for (const tree of session.manifests.find((m) => m.id === id)!.trees)
      delete tree.coverageComplete
  const preview = await snapshots.preview(query([{ callKey: 'bash', before, after }]))
  expect(preview.remove).toEqual([])
  expect(preview.skipped).toEqual([{ path: path('created'), reason: 'not-covered' }])
})

it('05 验收 52: B8 — a file of exactly the size limit is still covered; one byte more is excluded', async () => {
  await writeFile(path('big'), 'A')
  const before = await take('big')
  await writeFile(path('big'), 'B')
  const after = await take('big', 'after-call')
  const q = query([{ callKey: 'file', before, after, path: path('big') }])
  await truncate(path('big'), 100_000_000)
  const preview = await snapshots.preview(q)
  expect(preview.skipped).toEqual([])
  expect(preview.restore).toEqual([path('big')])
})

it('05 验收 52: B9 — a later call on the same path whose start is not covered invalidates the earlier promise', async () => {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const preview = await snapshots.preview(
    query([
      { callKey: '1', before, after, path: path('f') },
      { callKey: '2', before: 'gone-snapshot', path: path('f') },
    ]),
  )
  expect(preview.skipped).toEqual([{ path: path('f'), reason: 'excluded', promised: true }])
})

it('05 验收 52: B11 — a file-tool call after a command on the same path keeps its promise when the path is later skipped', async () => {
  await writeFile(path('g'), 'A')
  const treeBefore = await take()
  await writeFile(path('g'), 'B')
  const treeAfter = await take(undefined, 'after-call')
  const fileBefore = await take('g')
  await writeFile(path('g'), 'C')
  const fileAfter = await take('g', 'after-call')
  await fsLink(path('g'), path('g-other-name'))
  const preview = await snapshots.preview(
    query([
      { callKey: 'bash', before: treeBefore, after: treeAfter },
      { callKey: 'file', before: fileBefore, after: fileAfter, path: path('g') },
    ]),
  )
  expect(preview.skipped).toContainEqual({ path: path('g'), reason: 'hardlink', promised: true })
})
