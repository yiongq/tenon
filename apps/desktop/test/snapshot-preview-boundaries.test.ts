import {
  appendFile,
  chmod,
  lstat,
  symlink,
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

const recordFileChange = async (name: string, act: () => Promise<void>, callKey: string) => {
  const before = await take(name)
  await act()
  return { callKey, path: path(name), before, after: await take(name, 'after-call') }
}

it.each([false, true])(
  '05 验收 52: restoring an ignored child keeps its parent directory (write first %s)',
  async (writeFirst) => {
    await writeFile(path('.gitignore'), '*.log\n')
    await writeFile(path('b'), 'origin')
    const before = await take()
    await rm(path('b'))
    await mkdir(path('b'))
    await writeFile(path('b/run.log'), 'ignored')
    const changes: RestoreQuery['calls'][number][] = [
      { callKey: 'bash', before, after: await take(undefined, 'after-call') },
    ]
    if (writeFirst)
      changes.push(
        await recordFileChange('b/run.log', () => writeFile(path('b/run.log'), 'edited'), 'write'),
      )
    changes.push(await recordFileChange('b/run.log', () => rm(path('b/run.log')), 'delete'))
    const q = query(changes)
    const { done } = await restore(q)
    expect(done.failed).toEqual([])
    expect(await readFile(path('b/run.log'), 'utf8')).toBe('ignored')
    const end = await snapshots.preview(q)
    expect([end.restore, end.remove, end.conflicts]).toEqual([[], [], []])
  },
)

it('05 验收 52: a promised file now held by a directory the restore cannot clear is skipped', async () => {
  await writeFile(path('.gitignore'), '*.log\n')
  await writeFile(path('x'), 'origin')
  const edited = await recordFileChange('x', () => writeFile(path('x'), 'edit'), 'edit')
  const before = await take()
  await rm(path('x'))
  await mkdir(path('x'))
  await writeFile(path('x/run.log'), 'ignored')
  const after = await take(undefined, 'after-call')
  const q = query([edited, { callKey: 'bash', before, after }])
  expect((await snapshots.preview(q)).skipped).toEqual([
    expect.objectContaining({ path: path('x'), reason: 'excluded', promised: true }),
  ])
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
  expect(await readFile(path('x/run.log'), 'utf8')).toBe('ignored')
})

it('05 验收 41: restoring a child two directories deep keeps both ancestors', async () => {
  await writeFile(path('.gitignore'), '*.log\n')
  await writeFile(path('x'), 'origin')
  const before = await take()
  await rm(path('x'))
  await mkdir(path('x/e'), { recursive: true })
  await writeFile(path('x/e/run.log'), 'ignored')
  const after = await take(undefined, 'after-call')
  const deleted = await recordFileChange('x/e/run.log', () => rm(path('x/e/run.log')), 'delete')
  const q = query([{ callKey: 'bash', before, after }, deleted])
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
  expect(await readFile(path('x/e/run.log'), 'utf8')).toBe('ignored')
  const end = await snapshots.preview(q)
  expect([end.restore, end.remove, end.conflicts]).toEqual([[], [], []])
})

it('05 验收 41: a newly selected workspace folder survives restoration', async () => {
  const selected = path('sub')
  const before = await take()
  await mkdir(selected)
  await writeFile(path('sub/a'), 'agent')
  const after = await take(undefined, 'after-call')
  await rooted([selected])
  const { done } = await restore(query([{ callKey: 'bash', before, after }]))
  expect(done.failed).toEqual([])
  expect((await lstat(selected)).isDirectory()).toBe(true)
  await take()
})

it('05 验收 41: restoring a user file keeps the newly created directory', async () => {
  const before = await take()
  await mkdir(path('d'))
  const after = await take(undefined, 'after-call')
  await writeFile(path('d/mine'), 'mine')
  const written = await recordFileChange(
    'd/mine',
    () => writeFile(path('d/mine'), 'agent'),
    'write',
  )
  const q = query([{ callKey: 'bash', before, after }, written])
  expect((await snapshots.preview(q)).remove).not.toContain(path('d'))
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
  expect((await lstat(path('d'))).isDirectory()).toBe(true)
  expect(await readFile(path('d/mine'), 'utf8')).toBe('mine')
})

it('05 验收 41: a promised new ignored file leaves with its directory', async () => {
  await writeFile(path('.gitignore'), '*.log\n')
  const before = await take()
  await mkdir(path('d'))
  const after = await take(undefined, 'after-call')
  const written = await recordFileChange(
    'd/run.log',
    () => writeFile(path('d/run.log'), 'agent'),
    'write',
  )
  const q = query([{ callKey: 'bash', before, after }, written])
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
  await expect(lstat(path('d'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(path('d/run.log'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  ['logs', 'run.log', '*.log\n', false, false],
  ['.pytest_cache', '.gitignore', '', false, false],
  ['logs', 'run.log', '*.log\n', true, false],
  ['logs', 'run.log', '*.log\n', true, true],
  ['x', 'run.log', '*.log\n', false, 'file'],
  ['cache', '.gitignore', '', false, 'file'],
  ['x', 'run.log', '*.log\n', false, 'link'],
  ['x', 'run.log', '*.log\n', false, 'moved'],
] as const)(
  '05 验收 41、33 复现: %s/%s retains ignored contents (%s, mixed %s, existing %s)',
  async (dir, leaf, rule, mixed, existing) => {
    await writeFile(path('.gitignore'), rule)
    await writeFile(path('f'), 'origin')
    if (existing === 'link') await symlink('f', path(dir))
    else if (typeof existing === 'string') await writeFile(path(dir), 'unique origin')
    else if (existing) await mkdir(path(dir), { mode: 0o700 })
    const before = await take()
    if (existing === 'moved') await rename(path(dir), path('y'))
    else if (existing) await rm(path(dir), { recursive: true })
    await mkdir(path(dir), { mode: 0o755 })
    await chmod(path(dir), 0o755)
    await writeFile(path(`${dir}/${leaf}`), '*\n')
    if (mixed) {
      await writeFile(path('f'), 'agent')
      await writeFile(path(`${dir}/ordinary`), 'agent')
    }
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const preview = await snapshots.preview(q)
    expect(preview.remove).not.toContain(path(dir))
    expect(preview.restore.includes(path(dir))).toBe(existing === true)
    expect(preview.skipped).toEqual(
      existing === true ? [] : [{ path: path(dir), reason: 'excluded' }],
    )
    const { done } = await restore(q)
    expect(done.failed).toEqual([])
    expect(await readFile(path(`${dir}/${leaf}`), 'utf8')).toBe('*\n')
    expect(await readFile(path('f'), 'utf8')).toBe('origin')
    expect(await readFile(path('y'), 'utf8').catch(() => null)).toBe(
      existing === 'moved' ? 'unique origin' : null,
    )
    expect((await lstat(path(dir))).mode & 0o777).toBe(existing === true ? 0o700 : 0o755)
    const end = await snapshots.preview(q)
    const retained = existing === 'moved' ? [path('y')] : []
    expect([end.restore, end.remove, end.conflicts]).toEqual([[], retained, retained])
  },
)

const inner = () => absolutePath(join(temp, 'workspace', 'sub'))
const rooted = async (roots: ReturnType<typeof inner>[]) => {
  await snapshots.setWorkspace(sessionId, roots)
  await snapshots.settled(sessionId)
}

it('05 验收 41: nested folders, the rule lives only in the outer folder: new directory is skipped', async () => {
  await writeFile(path('.gitignore'), '*.log\n')
  await mkdir(inner())
  await rooted([folder, inner()])
  const before = await take()
  await mkdir(join(inner(), 'd'))
  await writeFile(join(inner(), 'd/run.log'), 'ignored')
  const after = await take(undefined, 'after-call')
  const q = query([{ callKey: 'bash', before, after }])
  const preview = await snapshots.preview(q)
  expect(preview.remove).toEqual([])
  expect(preview.skipped.map((s) => s.path)).toContain(join(inner(), 'd'))
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
  expect((await snapshots.preview(q)).remove).toEqual([])
})

it('05 验收 41 复现: nested folders: mv x y; mkdir x; write x/run.log keeps the origin in the workspace', async () => {
  await writeFile(path('.gitignore'), '*.log\n')
  await mkdir(inner())
  await writeFile(join(inner(), 'x'), 'unique origin')
  await rooted([folder, inner()])
  const before = await take()
  await rename(join(inner(), 'x'), join(inner(), 'y'))
  await mkdir(join(inner(), 'x'))
  await writeFile(join(inner(), 'x/run.log'), 'ignored')
  const after = await take(undefined, 'after-call')
  const q = query([{ callKey: 'bash', before, after }])
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
  expect(await readFile(join(inner(), 'y'), 'utf8')).toBe('unique origin')
})

it.each([
  ['added', () => [folder, inner()]],
  ['narrowed', () => [inner()]],
] as const)(
  '05 验收 41 复现: a folder %s after the round: the directory is still skipped',
  async (_, roots) => {
    await mkdir(inner())
    await writeFile(join(inner(), '.gitignore'), '*.log\n')
    const before = await take()
    await mkdir(join(inner(), 'd'))
    await writeFile(join(inner(), 'd/run.log'), 'ignored')
    const after = await take(undefined, 'after-call')
    await rooted(roots())
    const q = query([{ callKey: 'bash', before, after }])
    const preview = await snapshots.preview(q)
    expect(preview.remove).toEqual([])
    const { done } = await restore(q)
    expect(done.failed).toEqual([])
  },
)

it('05 验收 41: the rule goes away in a later call, new directory stays skipped', async () => {
  await writeFile(path('.gitignore'), '*.log\n')
  const t0 = await take()
  await mkdir(path('d'))
  await writeFile(path('d/run.log'), 'ignored')
  const t1 = await take(undefined, 'after-call')
  const t2 = await take()
  await writeFile(path('.gitignore'), '# nothing\n')
  const t3 = await take(undefined, 'after-call')
  const q = query([
    { callKey: 'one', before: t0, after: t1 },
    { callKey: 'two', before: t2, after: t3 },
  ])
  expect((await snapshots.preview(q)).remove).toEqual([])
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
})

it('05 验收 41: the rule goes away in a later call, the moved origin stays in the workspace', async () => {
  await writeFile(path('.gitignore'), '*.log\n')
  await writeFile(path('x'), 'unique origin')
  const t0 = await take()
  await rename(path('x'), path('y'))
  await mkdir(path('x'))
  await writeFile(path('x/run.log'), 'ignored')
  const t1 = await take(undefined, 'after-call')
  const t2 = await take()
  await writeFile(path('.gitignore'), '# nothing\n')
  const t3 = await take(undefined, 'after-call')
  const q = query([
    { callKey: 'one', before: t0, after: t1 },
    { callKey: 'two', before: t2, after: t3 },
  ])
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
  expect(await readFile(path('y'), 'utf8')).toBe('unique origin')
})

it('05 验收 41 复现: a path that stopped being a directory after the last snapshot is not skipped', async () => {
  await writeFile(path('.gitignore'), '*.log\n')
  const before = await take()
  await mkdir(path('d'))
  await writeFile(path('d/run.log'), 'ignored')
  const after = await take(undefined, 'after-call')
  await rm(path('d'), { recursive: true })
  await writeFile(path('d'), 'yours')
  const preview = await snapshots.preview(query([{ callKey: 'mkdir', before, after }]))
  expect(preview.skipped).toEqual([])
  expect(preview.remove).toEqual([path('d')])
  expect(preview.conflicts).toEqual([path('d')])
})

it('05 验收 41: a later single-file call leaves the directory skipped', async () => {
  await writeFile(path('.gitignore'), '*.log\n')
  await writeFile(path('x'), 'origin')
  const t0 = await take()
  await rm(path('x'))
  await mkdir(path('x'))
  await writeFile(path('x/run.log'), 'ignored')
  const t1 = await take(undefined, 'after-call')
  const t2 = await take('other')
  await writeFile(path('other'), 'w')
  const t3 = await take('other', 'after-call')
  const q = query([
    { callKey: 'one', before: t0, after: t1 },
    { callKey: 'w', path: path('other'), before: t2, after: t3 },
  ])
  const preview = await snapshots.preview(q)
  expect(preview.skipped).toEqual([{ path: path('x'), reason: 'excluded' }])
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
})

it('05 验收 41: new directories in two folders are each skipped', async () => {
  const other = absolutePath(join(temp, 'workspace-b'))
  await mkdir(other)
  await writeFile(path('.gitignore'), '*.log\n')
  await writeFile(join(other, '.gitignore'), '*.log\n')
  await snapshots.setWorkspace(sessionId, [folder, other])
  await snapshots.settled(sessionId)
  const before = await take()
  await mkdir(path('a'))
  await writeFile(path('a/run.log'), 'x')
  await mkdir(join(other, 'b'))
  await writeFile(join(other, 'b/run.log'), 'x')
  const after = await take(undefined, 'after-call')
  const q = query([{ callKey: 'one', before, after }])
  const preview = await snapshots.preview(q)
  expect(preview.remove).toEqual([])
  expect(preview.skipped.map((s) => s.path).toSorted()).toEqual(
    [join(other, 'b'), path('a')].toSorted(),
  )
})

it('05 验收 41: ignored child removed after the last snapshot restores its origin', async () => {
  await writeFile(path('.gitignore'), '*.log\n')
  await writeFile(path('b'), 'origin')
  const before = await take()
  await rm(path('b'))
  await mkdir(path('b'))
  await writeFile(path('b/run.log'), 'ignored')
  const after = await take(undefined, 'after-call')
  await rm(path('b/run.log'))
  const q = query([{ callKey: 'bash', before, after }])
  const preview = await snapshots.preview(q)
  expect(preview.restore).toEqual([path('b')])
  expect(preview.skipped).toEqual([])
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
  expect((await lstat(path('b'))).isFile()).toBe(true)
  expect(await readFile(path('b'), 'utf8')).toBe('origin')
})

it('05 验收 41 复现: a user file added after the last snapshot keeps its directory', async () => {
  const before = await take()
  await mkdir(path('d'))
  await writeFile(path('d/a'), 'agent')
  const after = await take(undefined, 'after-call')
  await writeFile(path('d/mine.txt'), 'mine')
  const q = query([{ callKey: 'bash', before, after }])
  const preview = await snapshots.preview(q)
  expect(preview.remove).toEqual([path('d/a')])
  expect(preview.skipped).toEqual([{ path: path('d'), reason: 'excluded' }])
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
  expect(await readFile(path('d/mine.txt'), 'utf8')).toBe('mine')
  await expect(lstat(path('d/a'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('05 验收 41 复现: a skipped changed child keeps its directory', async () => {
  const before = await take()
  await mkdir(path('d'))
  await writeFile(path('d/a'), 'agent')
  const after = await take(undefined, 'after-call')
  await writeFile(path('.gitignore'), 'a\n')
  const q = query([{ callKey: 'bash', before, after }])
  const preview = await snapshots.preview(q)
  expect(preview.remove).toEqual([])
  expect(preview.skipped).toEqual(
    ['d', 'd/a'].map((name) => ({ path: path(name), reason: 'excluded' })),
  )
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
  expect(await readFile(path('d/a'), 'utf8')).toBe('agent')
})

it.skipIf(process.platform === 'win32')(
  '05 验收 41 复现: an unreadable directory stays skipped',
  async () => {
    const before = await take()
    await mkdir(path('d'))
    const after = await take(undefined, 'after-call')
    await chmod(path('d'), 0o000)
    try {
      const preview = await snapshots.preview(query([{ callKey: 'mkdir', before, after }]))
      expect(preview.remove).toEqual([])
      expect(preview.skipped).toEqual([{ path: path('d'), reason: 'excluded' }])
    } finally {
      await chmod(path('d'), 0o755)
    }
  },
)

it.each([true, false])('05 验收 41 复现: S8240 file %s', async (existed) => {
  await writeFile(path('.gitignore'), '*.log\n')
  if (existed) await writeFile(path('b'), 'origin')
  const before = await take()
  if (existed) await rm(path('b'))
  await mkdir(path('b'))
  await writeFile(path('b/run.log'), 'ignored')
  const middle = await take(undefined, 'after-call')
  await rm(path('b/run.log'))
  const after = await take(undefined, 'after-call')
  const q = query([
    { callKey: 'replace', before, after: middle },
    { callKey: 'empty', before: middle, after },
  ])
  const preview = await snapshots.preview(q)
  expect([preview.restore, preview.remove, preview.skipped]).toEqual(
    existed ? [[path('b')], [], []] : [[], [path('b')], []],
  )
  const { done } = await restore(q)
  expect(done.failed).toEqual([])
  expect(await readFile(path('b'), 'utf8').catch(() => null)).toBe(existed ? 'origin' : null)
  const stat = await lstat(path('b')).catch(() => null)
  expect(stat?.isFile() ?? null).toBe(existed ? true : null)
})

it.each(['d', 'd/e/f'])('05 验收 41 复现: excluded ancestry with current path %s', async (dir) => {
  await writeFile(path('.gitignore'), '*.log\n')
  const before = await take()
  await mkdir(path(dir), { recursive: true })
  await writeFile(path(`${dir}/run.log`), 'ignored')
  const recorded = await take(undefined, 'after-call')
  const calls = [{ callKey: 'mkdir', before, after: recorded }]
  if (dir === 'd') {
    await rm(path(dir), { recursive: true })
    await writeFile(path(dir), 'agent')
    calls.push({ callKey: 'file', before: recorded, after: await take(undefined, 'after-call') })
  }
  const preview = await snapshots.preview(query(calls))
  expect(preview.remove).toEqual(dir === 'd' ? [path('d')] : [])
  expect(preview.skipped.map((s) => s.path)).toEqual(
    dir === 'd' ? [] : ['d', 'd/e', 'd/e/f'].map(path),
  )
})

it('05 验收 41: an unreadable root exclusion covers every candidate', async () => {
  await writeFile(path('f'), 'origin')
  const before = await take()
  await writeFile(path('f'), 'agent')
  const after = await take(undefined, 'after-call')
  const manifest = snapshots['sessions'].get(sessionId)!.manifests.find((m) => m.id === before)!
  manifest.trees[0]!.excluded.push('')
  const preview = await snapshots.preview(query([{ callKey: 'bash', before, after }]))
  expect(preview.skipped).toEqual([{ path: path('f'), reason: 'excluded' }])
})

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
  expect(
    snapshots['sessions'].get(sessionId)!.manifests.find((m) => m.id === first.undo)!.files,
  ).toEqual([])
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
