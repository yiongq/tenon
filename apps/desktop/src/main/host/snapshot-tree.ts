/** Spec 05 §快照怎么拍: ignored-file enumeration and independent (parentless) git trees. */
import { access, lstat, readdir, readlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, relative } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import type { AbsolutePath } from '@tenon-app/kernel'
import type { SnapshotGit } from './snapshot-git.js'
import {
  contains,
  DEFAULT_EXCLUDES,
  errno,
  identity,
  MAX_FILE_BYTES,
  saved,
  SnapshotBudgetError,
} from './snapshot-storage.js'
import type { SavedFile, TreeRecord } from './snapshot-storage.js'

export interface TreeScan {
  entries: SavedFile[]
  directories: Record<string, number>
  excluded: string[]
  skipped: number
  bytes: number
}
function pattern(path: string): string {
  return `/${path.replace(/[\\*?[\]#!]/g, '\\$&')}`
}

export async function scanTree(
  git: SnapshotGit,
  repo: string,
  folder: AbsolutePath,
  profile: string,
  maxFiles: number,
  signal: AbortSignal,
): Promise<TreeScan> {
  const excluded: string[] = []
  const directories: Record<string, number> = {}
  const defaults: string[] = DEFAULT_EXCLUDES.map((name) => (name === '.git' ? '.git' : `${name}`))
  if (contains(folder, profile)) defaults.push(pattern(relative(folder, profile)))
  const discover = async (dir: string): Promise<void> => {
    signal.throwIfAborted()
    const stats = await lstat(dir)
    directories[dir] = stats.mode & 0o7777
    let children
    try {
      children = await readdir(dir, { withFileTypes: true })
    } catch {
      excluded.push(relative(folder, dir))
      return
    }
    for (const child of children) {
      if (
        !child.isDirectory() ||
        DEFAULT_EXCLUDES.includes(child.name as (typeof DEFAULT_EXCLUDES)[number])
      )
        continue
      const path = join(dir, child.name)
      if (contains(profile, path)) continue
      // oxlint-disable-next-line no-await-in-loop -- do not descend through a nested git root
      const nested = await lstat(join(path, '.git')).then(
        () => true,
        () => false,
      )
      if (nested) excluded.push(relative(folder, path))
      // oxlint-disable-next-line no-await-in-loop -- one directory traversal, abort checked at every level
      else await discover(path)
    }
  }
  await discover(folder)
  const base = [...defaults, ...excluded.map(pattern)]
  await writeFile(join(repo, 'info', 'exclude'), `${base.join('\n')}\n`)
  const names = (
    await git.run(
      repo,
      folder,
      ['ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z'],
      signal,
    )
  )
    .split('\0')
    .filter(Boolean)
  const ignored = new Set(
    (
      await git.run(
        repo,
        folder,
        ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'],
        signal,
      )
    ).split('\0'),
  )
  const entries: SavedFile[] = []
  let bytes = 0
  let skipped = 0
  const candidates = names.filter((name) => !ignored.has(name))
  // Bounded metadata concurrency keeps large unchanged trees inside the capture deadline.
  for (let start = 0; start < candidates.length; start += 32) {
    signal.throwIfAborted()
    // oxlint-disable-next-line no-await-in-loop -- at most 32 independent metadata requests, never a full-tree fan-out
    const batch = await Promise.all(
      candidates.slice(start, start + 32).map(async (name) => {
        const path = absolutePath(join(folder, name))
        if (!contains(folder, path)) throw new Error('Git listed a path outside the workspace')
        try {
          const stats = await lstat(path, { bigint: true })
          if ((!stats.isFile() && !stats.isSymbolicLink()) || stats.size > BigInt(MAX_FILE_BYTES))
            return { name }
          if (stats.isFile()) await access(path, constants.R_OK)
          return {
            name,
            entry: { path, identity: saved(identity(stats)) },
            bytes: Number(stats.size),
          }
        } catch (error) {
          return { name, absent: errno(error, 'ENOENT') || errno(error, 'ENOTDIR') }
        }
      }),
    )
    signal.throwIfAborted()
    for (const result of batch) {
      if (result.entry === undefined) {
        if (result.absent === true) continue
        excluded.push(result.name)
        skipped++
        continue
      }
      entries.push(result.entry)
      bytes += result.bytes
      if (entries.length > maxFiles)
        throw new SnapshotBudgetError('Snapshot file-count budget exceeded', 'files')
    }
  }
  await writeFile(
    join(repo, 'info', 'exclude'),
    `${[...base, ...excluded.map(pattern)].join('\n')}\n`,
  )
  return { entries, directories, excluded, skipped, bytes }
}

export async function captureTree(
  git: SnapshotGit,
  repo: string,
  folder: AbsolutePath,
  scan: TreeScan,
  id: string,
  signal: AbortSignal,
): Promise<TreeRecord> {
  const wanted = new Set(scan.entries.map((entry) => relative(folder, entry.path)))
  const indexed = (await git.run(repo, folder, ['ls-files', '-z'], signal))
    .split('\0')
    .filter(Boolean)
  const removed = indexed.filter((name) => !wanted.has(name))
  if (removed.length > 0)
    await git.run(
      repo,
      folder,
      ['update-index', '--force-remove', '-z', '--stdin'],
      signal,
      removed.join('\0') + '\0',
    )
  if (scan.entries.length > 0)
    await git.run(
      repo,
      folder,
      ['update-index', '--add', '-z', '--stdin'],
      signal,
      scan.entries.map((entry) => relative(folder, entry.path)).join('\0') + '\0',
    )
  const index = await git.run(repo, folder, ['ls-files', '--stage', '-z'], signal)
  const hashes = new Map(
    index
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t')
        return [line.slice(tab + 1), line.slice(0, tab).split(' ')[1]!] as const
      }),
  )
  const entries: SavedFile[] = []
  for (const entry of scan.entries) {
    const hash = hashes.get(relative(folder, entry.path))
    // update-index can reject unsafe names with exit code zero. The index is authoritative.
    if (hash === undefined) {
      scan.excluded.push(relative(folder, entry.path))
      scan.skipped++
      continue
    }
    if (entry.identity?.kind === 'link') {
      // Link text, never bytes at its target. Git stores the same text as a 120000 blob.
      // oxlint-disable-next-line no-await-in-loop -- metadata saved per captured link
      entries.push({ ...entry, hash, link: await readlink(entry.path) })
    } else entries.push({ ...entry, hash })
  }
  const tree = (await git.run(repo, folder, ['write-tree'], signal)).trim()
  const commit = (
    await git.run(repo, folder, ['commit-tree', tree, '-m', 'Tenon snapshot'], signal)
  ).trim()
  await git.run(repo, folder, ['update-ref', `refs/tenon/${id}`, commit], signal)
  return { folder, commit, entries, directories: scan.directories, excluded: scan.excluded }
}
