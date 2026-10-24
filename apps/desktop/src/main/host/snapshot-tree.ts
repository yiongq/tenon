/** Spec 05 §快照怎么拍: ignored-file enumeration and independent (parentless) git trees. */
import { access, lstat, readdir, readlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, relative } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import type { AbsolutePath } from '@tenon-app/kernel'
import type { SnapshotGit } from './snapshot-git.js'
import { contains, DEFAULT_EXCLUDES, identity, MAX_FILE_BYTES, saved } from './snapshot-storage.js'
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
  // Reset first: info/exclude does not remove paths that are already tracked in the shadow index.
  await git.run(repo, folder, ['read-tree', '--empty'], signal)
  const names = (
    await git.run(repo, folder, ['ls-files', '--others', '--exclude-standard', '-z'], signal)
  )
    .split('\0')
    .filter(Boolean)
  const entries: SavedFile[] = []
  let bytes = 0
  let skipped = 0
  for (const name of names) {
    signal.throwIfAborted()
    const path = absolutePath(join(folder, name))
    if (!contains(folder, path)) throw new Error('Git listed a path outside the workspace')
    try {
      // oxlint-disable-next-line no-await-in-loop -- metadata and permission belong to this scan
      const stats = await lstat(path, { bigint: true })
      if (!stats.isFile() && !stats.isSymbolicLink()) {
        excluded.push(name)
        skipped++
        continue
      }
      if (Number(stats.size) > MAX_FILE_BYTES) {
        excluded.push(name)
        skipped++
        continue
      }
      // Check permission without opening devices or following a symbolic link.
      // oxlint-disable-next-line no-await-in-loop -- a file unreadable by the desktop is excluded
      if (stats.isFile()) await access(path, constants.R_OK)
      entries.push({ path, identity: saved(identity(stats)) })
      bytes += Number(stats.size)
    } catch {
      excluded.push(name)
      skipped++
    }
    if (entries.length > maxFiles) throw new Error('Snapshot file-count budget exceeded')
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
  // Reservation may have reclaimed old refs and rebuilt this index since listing.
  await git.run(repo, folder, ['read-tree', '--empty'], signal)
  if (scan.entries.length > 0) {
    const names = scan.entries.map((entry) => relative(folder, entry.path)).join('\0') + '\0'
    await git.run(
      repo,
      folder,
      ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
      signal,
      names,
    )
  }
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
    if (hash === undefined) throw new Error('Snapshot index missed a listed file')
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
