import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { SnapshotGit } from '../src/main/host/snapshot-git.js'
import { checkIgnoredPaths, scanTree } from '../src/main/host/snapshot-tree.js'
import { folder, path, temp } from './support/snapshot-boundaries.js'
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, readdir: vi.fn<typeof actual.readdir>(actual.readdir) }
})
it('05 验收 10: ignore batches bound UTF-8 bytes without repeating earlier names', async () => {
  const run = vi.fn<SnapshotGit['run']>().mockResolvedValue('')
  await checkIgnoredPaths(
    { run } as unknown as SnapshotGit,
    '/repo',
    folder,
    ['é'.repeat(8_000_000), '界'.repeat(6_000_000)],
    new AbortController().signal,
  )
  expect(run.mock.calls.map((call) => Buffer.byteLength(call[4]!))).toEqual([
    16_000_003, 18_000_003,
  ])
})
it.each(['', 'locked', 'nested'])('05 验收 41: scan preserves exclusion %j', async (name) => {
  const repo = join(temp, 'scan')
  await fs.mkdir(join(repo, 'info'), { recursive: true })
  if (name) await fs.mkdir(path(name))
  if (name === 'nested') await fs.mkdir(path('nested/.git'))
  else {
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    if (name) vi.mocked(fs.readdir).mockImplementationOnce(actual.readdir)
    vi.mocked(fs.readdir).mockRejectedValueOnce(new Error('unreadable'))
  }
  const git = { run: vi.fn<SnapshotGit['run']>().mockResolvedValue('') } as unknown as SnapshotGit
  const scan = await scanTree(git, repo, folder, '/profile', 10, new AbortController().signal)
  expect(scan.excluded).toEqual([name])
})
