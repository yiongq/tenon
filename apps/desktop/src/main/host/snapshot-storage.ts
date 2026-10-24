/** Spec 05 §快照怎么拍: profile-owned manifests, byte copies and disk accounting. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  link as publishLink,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { AbsolutePath, FileIdentity, SnapshotRequest } from '@tenon-app/kernel'
import { absolutePath } from '@tenon-app/kernel'

export const MAX_FILE_BYTES = 100_000_000
export const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
  '.DS_Store',
  'Thumbs.db',
] as const

export interface SavedIdentity extends Omit<FileIdentity, 'mtimeNs' | 'dev'> {
  mtimeNs: string
  dev: string
}
export interface SavedFile {
  path: AbsolutePath
  identity: SavedIdentity | null
  hash?: string
  link?: string
}
export interface TreeRecord {
  folder: AbsolutePath
  commit: string
  entries: SavedFile[]
  directories: Record<string, number>
  excluded: string[]
}
export interface SnapshotManifest {
  version: 1
  id: string
  sessionId: string
  createdAt: number
  call: SnapshotRequest['call']
  moment: SnapshotRequest['moment']
  bootstrap: boolean
  trees: TreeRecord[]
  files: SavedFile[]
  directories: Record<string, number>
  skipped: number
}

export function pathKey(path: string | Uint8Array): string {
  return createHash('sha256').update(path).digest('hex')
}
export function contains(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
export function errno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === code
}
export function identity(stats: BigIntStats): FileIdentity {
  return {
    kind: stats.isFile()
      ? 'file'
      : stats.isDirectory()
        ? 'dir'
        : stats.isSymbolicLink()
          ? 'link'
          : 'other',
    size: Number(stats.size),
    nlink: Number(stats.nlink),
    mode: Number(stats.mode & 0o7777n),
    mtimeNs: stats.mtimeNs,
    dev: stats.dev,
  }
}
export function saved(stamp: FileIdentity): SavedIdentity {
  return { ...stamp, mtimeNs: String(stamp.mtimeNs), dev: String(stamp.dev) }
}
export function same(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.nlink === b.nlink
  )
}
export async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Snapshot directory is not a real directory')
}
export async function atomicJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(data), { flag: 'wx', mode: 0o600 })
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
}
export async function diskBytes(path: string): Promise<number> {
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if (errno(error, 'ENOENT')) return 0
    throw error
  }
  let bytes = stat.blocks * 512
  if (stat.isDirectory()) {
    for (const child of await readdir(path)) {
      // oxlint-disable-next-line no-await-in-loop -- bounded traversal without following links
      bytes += await diskBytes(join(path, child))
    }
  }
  return bytes
}

/** Loose git objects and CAS copies are immutable. Recount only directories whose entries changed.
 * Mutable files (index, manifests, packs, pending markers) are always statted. Invalidate before GC.
 */
export class SnapshotDiskUsage {
  private readonly immutable = new Map<string, { stamp: string; bytes: number }>()

  invalidate(): void {
    this.immutable.clear()
  }

  async measure(path: string): Promise<number> {
    const stats = await statOrNull(path)
    if (stats === null) return 0
    if (!stats.isDirectory()) return Number(stats.blocks) * 512
    const cacheable = /(?:\/objects\/[0-9a-f]{2}|\/files)$/.test(path)
    const stamp = `${stats.dev}:${stats.ino}:${stats.mtimeNs}:${stats.ctimeNs}`
    const cached = cacheable ? this.immutable.get(path) : undefined
    if (cached?.stamp === stamp) return cached.bytes
    let bytes = Number(stats.blocks) * 512
    const names = await readdir(path)
    const complete = names.every((name) => /^[0-9a-f]{38,64}$/.test(name))
    for (const name of names) {
      // oxlint-disable-next-line no-await-in-loop -- immutable object subtrees are skipped on subsequent captures
      bytes += await this.measure(join(path, name))
    }
    if (cacheable && complete) this.immutable.set(path, { stamp, bytes })
    return bytes
  }
}
export async function statOrNull(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (errno(error, 'ENOENT') || errno(error, 'ENOTDIR')) return null
    throw error
  }
}

/** Resolve parents only: the last component may be a dangling link or a new file. */
export async function targetPath(path: AbsolutePath): Promise<AbsolutePath> {
  if (!isAbsolute(path)) throw new Error('Snapshot target must be absolute')
  let parent = dirname(path)
  const missing: string[] = [path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))]
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- resolve the nearest existing ancestor
      return absolutePath(join(await realpath(parent), ...missing.toReversed()))
    } catch (error) {
      if (!errno(error, 'ENOENT')) throw error
      const next = dirname(parent)
      if (next === parent) throw error
      missing.push(parent.slice(next.length + (next.endsWith(sep) ? 0 : 1)))
      parent = next
    }
  }
}

/** Captures one leaf, never its link target; stamp belongs to the bytes actually copied. */
export async function captureFile(
  path: AbsolutePath,
  filesDir: string,
  signal: AbortSignal,
): Promise<{ file: SavedFile; target: FileIdentity | null }> {
  signal.throwIfAborted()
  const before = await statOrNull(path)
  if (before === null) return { file: { path, identity: null }, target: null }
  const stamp = identity(before)
  if (stamp.kind === 'link') {
    const link = await readlink(path)
    const after = await lstat(path, { bigint: true })
    if (!same(before, after)) throw new Error('Snapshot link changed while reading')
    signal.throwIfAborted()
    return { file: { path, identity: saved(stamp), link }, target: stamp }
  }
  if (stamp.kind !== 'file' || stamp.nlink > 1 || stamp.size > MAX_FILE_BYTES)
    throw new Error('Snapshot target is not covered')
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const start = await handle.stat({ bigint: true })
    if (!same(before, start)) throw new Error('Snapshot target changed before open')
    const data = await handle.readFile({ signal })
    const end = await handle.stat({ bigint: true })
    if (!same(start, end)) throw new Error('Snapshot target changed while reading')
    signal.throwIfAborted()
    const hash = pathKey(data)
    const dest = join(filesDir, hash)
    // Publish only complete bytes. A concurrent writer can only observe a complete CAS entry.
    const tmp = join(filesDir, `${hash}.${randomUUID()}.tmp`)
    try {
      await writeFile(tmp, data, { flag: 'wx', mode: 0o600, signal })
      signal.throwIfAborted()
      try {
        await publishLink(tmp, dest)
      } catch (error) {
        if (!errno(error, 'EEXIST')) throw error
      }
    } finally {
      await rm(tmp, { force: true })
    }
    return { file: { path, identity: saved(identity(end)), hash }, target: identity(end) }
  } finally {
    await handle.close()
  }
}

export async function parentModes(path: string, root: string): Promise<Record<string, number>> {
  const modes: Record<string, number> = {}
  for (let parent = dirname(path); contains(root, parent); parent = dirname(parent)) {
    // oxlint-disable-next-line no-await-in-loop -- walk from leaf to its workspace root
    const stat = await statOrNull(parent)
    if (stat?.isDirectory()) modes[parent] = Number(stat.mode & 0o7777n)
    if (parent === root) break
  }
  return modes
}

export async function loadManifests(
  sessionDir: string,
  sessionId: string,
): Promise<SnapshotManifest[]> {
  const dir = join(sessionDir, 'manifests')
  await directory(dir)
  const manifests: SnapshotManifest[] = []
  for (const name of await readdir(dir)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) {
      // oxlint-disable-next-line no-await-in-loop -- half-written manifests have no published snapshot
      await rm(join(dir, name), { force: true, recursive: true })
      continue
    }
    // An invalid manifest cannot authorize reads or keep a ref alive.
    try {
      // oxlint-disable-next-line no-await-in-loop -- validate each durable snapshot before recovery
      const value = JSON.parse(await readFile(join(dir, name), 'utf8')) as SnapshotManifest
      if (
        value.version !== 1 ||
        value.id !== name.slice(0, -5) ||
        value.sessionId !== sessionId ||
        !Number.isFinite(value.createdAt) ||
        !Array.isArray(value.trees) ||
        !Array.isArray(value.files) ||
        typeof value.call?.roundRunId !== 'string' ||
        value.trees.some(
          (tree) => !isAbsolute(tree.folder) || !/^[0-9a-f]{40,64}$/.test(tree.commit),
        )
      )
        throw new Error('Invalid snapshot manifest')
      manifests.push(value)
    } catch {
      // oxlint-disable-next-line no-await-in-loop -- discard invalid profile-owned metadata only
      await rm(join(dir, name), { force: true })
    }
  }
  return manifests
}

export class SnapshotBudgetError extends Error {
  readonly kind: 'space' | 'files'
  constructor(message: string, kind: 'space' | 'files' = 'space') {
    super(message)
    this.kind = kind
  }
}
