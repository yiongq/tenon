import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  truncate,
  link as fsLink,
} from 'node:fs/promises'
import { join, relative } from 'node:path'
import { expect, it, vi } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
import { repoPath } from '../src/main/host/snapshot-git.js'
import type { SnapshotGit } from '../src/main/host/snapshot-git.js'
import type { RestoreQuery } from '@tenon-app/kernel'
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

it.each(['foo', ':foo'])(
  '05 验收 41 复现: literal colon names survive tree capture with ignore rule %s',
  async (rule) => {
    const names = [':(bad)', ':foo', 'foo', 'ordinary']
    await writeFile(path('.gitignore'), `${rule}\n`)
    await Promise.all(names.map((name) => writeFile(path(name), 'origin')))
    const before = await take()
    const tree = snapshots['sessions'].get(sessionId)!.manifests.find((m) => m.id === before)!
      .trees[0]!
    expect(tree.excluded).toEqual([rule])
    expect(tree.entries.map((entry) => entry.path).toSorted()).toEqual(
      ['.gitignore', ...names.filter((name) => name !== rule)].map(path).toSorted(),
    )
    await Promise.all(names.map((name) => writeFile(path(name), 'agent')))
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const preview = await snapshots.preview(q)
    expect(preview.restore.toSorted()).toEqual(
      names
        .filter((name) => name !== rule)
        .map(path)
        .toSorted(),
    )
    expect(preview.skipped).toEqual([])
    expect(await snapshots.prepare({ ...q, previewKey: preview.previewKey })).toMatchObject({
      ok: true,
    })
  },
)

it.each(['foo', ':foo'])(
  '05 验收 41 复现: preview applies new ignore rule %s to literal :foo independently of foo',
  async (rule) => {
    const names = [':foo', 'foo', 'ordinary']
    await Promise.all(names.map((name) => writeFile(path(name), 'origin')))
    const before = await take()
    await Promise.all(names.map((name) => writeFile(path(name), 'agent')))
    const after = await take(undefined, 'after-call')
    await writeFile(path('.gitignore'), `${rule}\n`)
    const preview = await snapshots.preview(query([{ callKey: 'bash', before, after }]))
    expect(preview.restore.toSorted()).toEqual(
      names
        .filter((name) => name !== rule)
        .map(path)
        .toSorted(),
    )
    expect(preview.skipped).toEqual([{ path: path(rule), reason: 'excluded' }])
  },
)

it.each(['target/', '*.tmp'])(
  '05 验收 41 复现: excluded keeps only names without an ignored ancestor for rule %s',
  async (rule) => {
    await mkdir(path('target/nested'), { recursive: true })
    await writeFile(path('target/one.tmp'), 'one')
    await writeFile(path('target/nested/two.tmp'), 'two')
    await writeFile(path('.gitignore'), `${rule}\n`)
    const expected = rule === 'target/' ? ['target'] : ['target/nested/two.tmp', 'target/one.tmp']
    const before = await take()
    const after = await take(undefined, 'after-call')
    for (const id of [before, after]) {
      const manifest = snapshots['sessions'].get(sessionId)!.manifests.find((m) => m.id === id)!
      expect(manifest.trees[0]!.excluded.toSorted()).toEqual(expected)
    }
  },
)

it('05 验收 41: an ignored directory also subsumes previously indexed children', async () => {
  await mkdir(path('target/nested'), { recursive: true })
  await writeFile(path('target/one'), 'one')
  await writeFile(path('target/nested/two'), 'two')
  await take()
  await writeFile(path('.gitignore'), 'target/\n')
  const after = await take(undefined, 'after-call')
  const manifest = snapshots['sessions'].get(sessionId)!.manifests.find((m) => m.id === after)!
  expect(manifest.trees[0]!.excluded).toEqual(['target'])
})

it.each([375, 446])(
  '05 验收 41、22 复现: seed %i prepares on first confirmation without shrinking the preview',
  async (seed) => {
    await writeFile(path('.gitignore'), 'build/\n')
    await writeFile(path('b'), 'o-b')
    await mkdir(path('a'))
    await writeFile(path('a/a'), 'o-a/a')
    await writeFile(path('a/b'), 'o-a/b')
    const calls: RestoreQuery['calls'][number][] = []
    const command = async (act: () => Promise<void>) => {
      const before = await take()
      await act()
      calls.push({
        callKey: String(calls.length),
        before,
        after: await take(undefined, 'after-call'),
      })
    }
    if (seed === 375) {
      await command(async () => {
        await rename(path('a'), path('c'))
        await appendFile(path('.gitignore'), 'b\n')
      })
      await command(async () => {
        await copyFile(path('c/a'), path('c/b'))
        await rm(path('c/a'))
      })
    } else {
      await writeFile(path('c'), 'o-c')
      const before = await take('b')
      await appendFile(path('b'), '+e446.1')
      calls.push({ callKey: 'edit', path: path('b'), before, after: await take('b', 'after-call') })
      await command(() => rename(path('a/b'), path('b')))
      await command(async () => {
        await copyFile(path('c'), path('a/a'))
        await rename(path('a/a'), path('a/b'))
        await rename(path('b'), path('a/b'))
        await appendFile(path('.gitignore'), 'b\n')
      })
    }
    const q = query(calls)
    const preview = await snapshots.preview(q)
    expect(preview.restore).toContain(path('a/a'))
    expect(preview.restore).not.toContain(path('a/b'))
    const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
    expect(prepared).toMatchObject({ ok: true })
    expect(await snapshots.preview(q)).toEqual(preview)
    if (!prepared.ok) throw new Error(prepared.reason)
    await snapshots.cancel({ sessionId, undoSnapshotId: prepared.undoSnapshotId })
    expect(await readFile(path('a/b'), 'utf8').catch(() => null)).toBe(
      seed === 375 ? null : 'o-a/b',
    )
  },
)

it.each(['real', 'exit 1', 'exit 128'] as const)(
  '05 验收 41: batch check-ignore once per root matches individual checks (%s)',
  async (mode) => {
    const other = absolutePath(join(temp, 'workspace-b'))
    await mkdir(other)
    await snapshots.setWorkspace(sessionId, [folder, other])
    await snapshots.settled(sessionId)
    const roots = [folder, other]
    const names = ['keep file', 'ignored\nfile', 'second']
    const paths = roots.flatMap((root) => names.map((name) => absolutePath(join(root, name))))
    await Promise.all(paths.map((file) => writeFile(file, 'A')))
    const before = await take()
    await Promise.all(paths.map((file) => writeFile(file, 'B')))
    const after = await take(undefined, 'after-call')
    await Promise.all(roots.map((root) => writeFile(join(root, '.gitignore'), 'ignored*\n')))
    const git = snapshots['git']
    const run = git.run.bind(git)
    if (mode !== 'real')
      vi.spyOn(git, 'run').mockImplementation(async (repo, root, args, sig, input) => {
        if (args[0] === 'check-ignore')
          throw Object.assign(new Error('check-ignore'), { exitCode: mode === 'exit 1' ? 1 : 128 })
        return run(repo, root, args, sig, input)
      })
    const skipped = []
    const restored = []
    for (const file of paths) {
      const root = roots.find((candidate) => file.startsWith(candidate + '/'))!
      try {
        // oxlint-disable-next-line no-await-in-loop -- establish the individual-query reference result
        const ignored = await git.run(
          repoPath(snapshots['sessions'].get(sessionId)!.dir, root),
          root,
          ['check-ignore', '--no-index', '-z', '--stdin'],
          new AbortController().signal,
          relative(root, file) + '\0',
        )
        if (ignored.length > 0) skipped.push({ path: file, reason: 'excluded' })
        else restored.push(file)
      } catch (error) {
        if ((error as { exitCode?: number }).exitCode === 1) restored.push(file)
        else skipped.push({ path: file, reason: 'not-covered' })
      }
    }
    const spy = vi.spyOn(git, 'run')
    spy.mockClear()
    const preview = await snapshots.preview(query([{ callKey: 'bash', before, after }]))
    const checks = spy.mock.calls.filter(([, , args]) => args[0] === 'check-ignore')
    expect(checks).toHaveLength(roots.length)
    for (const root of roots) {
      const checksForRoot = checks.filter(([, candidate]) => candidate === root)
      expect(checksForRoot).toHaveLength(1)
      expect(checksForRoot[0]![2]).toEqual(['check-ignore', '--no-index', '-z', '--stdin'])
      expect(checksForRoot[0]![4]!.split('\0').filter(Boolean).toSorted()).toEqual(
        names.map((name) => `./${name}`).toSorted(),
      )
    }
    expect(preview.restore.toSorted()).toEqual(restored.toSorted())
    expect(preview.skipped).toEqual(skipped.toSorted((a, b) => a.path.localeCompare(b.path)))
  },
)

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

it('05 验收 41: a genuinely ignored directory keeps its historical exclusion after its rule is removed', async () => {
  await mkdir(path('ignored'), { mode: 0o700 })
  await writeFile(path('ignored/child'), 'origin')
  await writeFile(path('.gitignore'), 'ignored/\n')
  const before = await take()
  await writeFile(path('.gitignore'), '')
  await chmod(path('ignored'), 0o755)
  const after = await take(undefined, 'after-call')
  const preview = await snapshots.preview(query([{ callKey: 'bash', before, after }]))
  expect(preview.skipped).toContainEqual({ path: path('ignored'), reason: 'excluded' })
  expect(preview.restore).not.toContain(path('ignored'))
})

it('05 验收 21: the undo tree preserves the content from before restoration', async () => {
  await writeFile(path('f'), 'origin')
  const before = await take()
  await writeFile(path('f'), 'agent')
  const after = await take(undefined, 'after-call')
  const first = await restore(query([{ callKey: 'bash', before, after }]))
  expect(first.done).toMatchObject({ restored: 1, failed: [] })
  expect(await readFile(path('f'), 'utf8')).toBe('origin')
  const restored = await take(undefined, 'after-call')
  const undone = await restore(query([{ callKey: 'restore', before: first.undo, after: restored }]))
  expect(undone.done).toMatchObject({ restored: 1, failed: [] })
  expect(await readFile(path('f'), 'utf8')).toBe('agent')
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
