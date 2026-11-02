/* oxlint-disable no-await-in-loop -- restoration order is a safety contract; filesystem effects are sequential. */
/** Spec 05 §一键还原: manifest planning and guarded, per-path POSIX restoration. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lchmod,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { AbsolutePath, RestoreDone, RestorePreview, RestoreQuery } from '@tenon-app/kernel'
import { absolutePath } from '@tenon-app/kernel'
import { repoPath } from './snapshot-git.js'
import type { SnapshotGit } from './snapshot-git.js'
import {
  contains,
  DEFAULT_EXCLUDES,
  identity,
  MAX_FILE_BYTES,
  pathKey,
  same,
  saved,
  statOrNull,
} from './snapshot-storage.js'
import type { SavedFile, SavedIdentity, SnapshotManifest, TreeRecord } from './snapshot-storage.js'

type Reason = RestorePreview['skipped'][number]['reason']
interface Point {
  file: SavedFile
  content: string | undefined
  covered: boolean
  reason?: Reason
  manifest?: SnapshotManifest
  tree?: TreeRecord
}
export interface RestoreItem {
  path: AbsolutePath
  root: AbsolutePath
  start: Point
  last: Point | undefined
  now: Point
  conflict: boolean
  modes: Record<string, number>
}
export interface RestorePlan {
  preview: RestorePreview
  items: RestoreItem[]
}
/** Propagate proven parent aliases with NFC + simple lowercase, narrower than APFS equivalence
 * (e.g. final σ/ς or the ﬁ ligature). A missed alias may appear in preview.remove; apply's
 * filesystem-identity guard is what prevents deleting its retained object. */
export const foldRestorePath = (path: string): string => path.normalize('NFC').toLowerCase()
async function objectKey(path: string): Promise<string | undefined> {
  const stats = await statOrNull(path)
  return stats === null ? undefined : `${stats.dev}:${stats.ino}`
}
async function aliasKeys(paths: readonly string[]): Promise<Map<string, string>> {
  const keys = new Map<string, string>()
  for (const path of paths) {
    // Missing/unreadable names have no proven shared object and must not form an alias group.
    const key = await objectKey(path).catch(() => undefined)
    if (key !== undefined) keys.set(path, key)
  }
  return keys
}
interface AliasLeaf {
  path: AbsolutePath
  startKind: SavedIdentity['kind'] | null
  nowKind: SavedIdentity['kind'] | null
  object: string | undefined
  parentsExact: boolean
}
/** Only a two-name leaf rename may escape conservative alias skipping. */
export function pairRestoreLeaves(
  group: readonly AliasLeaf[],
): readonly [AbsolutePath, AbsolutePath] | undefined {
  if (group.length !== 2) return undefined
  const origin = group.find((item) => item.startKind === 'file' || item.startKind === 'link')
  const removal = group.find((item) => item.startKind === null)
  if (
    origin === undefined ||
    removal === undefined ||
    origin.path === removal.path ||
    origin.nowKind !== null ||
    (removal.nowKind !== 'file' && removal.nowKind !== 'link') ||
    dirname(origin.path) !== dirname(removal.path) ||
    !origin.parentsExact ||
    !removal.parentsExact ||
    origin.object === undefined ||
    origin.object !== removal.object
  )
    return undefined
  return [origin.path, removal.path]
}
async function leafRenamePair(
  group: readonly RestoreItem[],
): Promise<readonly [AbsolutePath, AbsolutePath] | undefined> {
  if (group.length !== 2) return undefined
  return pairRestoreLeaves(
    await Promise.all(
      group.map(async (item) => ({
        path: item.path,
        startKind: item.start.file.identity?.kind ?? null,
        nowKind: item.now.file.identity?.kind ?? null,
        // An absent-name folding fallback is insufficient proof for a destructive rename.
        object: await objectKey(item.path).catch(() => undefined),
        parentsExact: await parents(item.root, item.path, false).catch(() => false),
      })),
    ),
  )
}
const depth = (path: string): number => path.split(sep).length
const gitHash = (data: Uint8Array): string =>
  createHash('sha1').update(`blob ${data.byteLength}\0`).update(data).digest('hex')
function contentKey(p: Point | undefined): string | undefined {
  const file = p?.file.identity
  return p?.covered && file?.kind === 'file' && file.size > 0 && p.content !== undefined
    ? `${file.size}:${p.content}`
    : undefined
}
function equal(a: Point | undefined, b: Point | undefined, mode = true): boolean {
  if (a === undefined || b === undefined || !a.covered || !b.covered) return false
  return (
    a.file.identity?.kind === b.file.identity?.kind &&
    (!mode || a.file.identity?.mode === b.file.identity?.mode) &&
    a.content === b.content
  )
}
const missing = (path: AbsolutePath, covered = true, reason?: Reason): Point => ({
  file: { path, identity: null },
  content: undefined,
  covered,
  ...(reason === undefined ? {} : { reason }),
})
function directoryPoint(path: AbsolutePath, mode: number): Point {
  return {
    file: { path, identity: { kind: 'dir', mode, size: 0, nlink: 1, mtimeNs: '0', dev: '0' } },
    content: undefined,
    covered: true,
  }
}
function excluded(tree: TreeRecord, path: string): boolean {
  return (
    relative(tree.folder, path)
      .split(sep)
      .some((part) => DEFAULT_EXCLUDES.includes(part as (typeof DEFAULT_EXCLUDES)[number])) ||
    tree.excluded.some((name) => contains(join(tree.folder, name), path))
  )
}
interface IndexedTree extends TreeRecord {
  entriesByPath: ReadonlyMap<AbsolutePath, SavedFile>
}
interface IndexedManifest extends SnapshotManifest {
  filesByPath: ReadonlyMap<AbsolutePath, SavedFile>
  trees: IndexedTree[]
}
function indexManifest(manifest: SnapshotManifest): IndexedManifest {
  return {
    ...manifest,
    filesByPath: new Map(manifest.files.map((file) => [file.path, file])),
    trees: manifest.trees.map((tree) => ({
      ...tree,
      entriesByPath: new Map(tree.entries.map((entry) => [entry.path, entry])),
    })),
  }
}
async function point(
  manifest: IndexedManifest | undefined,
  path: AbsolutePath,
  dir: string,
): Promise<Point> {
  if (manifest === undefined) return missing(path, false, 'not-covered')
  const explicit = manifest.filesByPath.get(path)
  if (explicit !== undefined) {
    let content = explicit.link
    if (explicit.identity?.kind === 'file') {
      if (explicit.hash === undefined || !/^[0-9a-f]{64}$/.test(explicit.hash))
        return missing(path, false, 'not-covered')
      const bytes = await readFile(join(dir, 'files', explicit.hash))
      if (pathKey(bytes) !== explicit.hash) return missing(path, false, 'not-covered')
      content = gitHash(bytes)
    }
    return { file: explicit, content, covered: true, manifest }
  }
  const tree = manifest.trees
    .filter((candidate) => contains(candidate.folder, path))
    .toSorted((a, b) => b.folder.length - a.folder.length)[0]
  if (tree === undefined) return missing(path, false, 'not-covered')
  if (excluded(tree, path)) return missing(path, false, 'excluded')
  const entry = tree.entriesByPath.get(path)
  if (entry !== undefined)
    return { file: entry, content: entry.link ?? entry.hash, covered: true, manifest, tree }
  const mode = tree.directories[path]
  if (mode !== undefined) return { ...directoryPoint(path, mode), manifest, tree }
  return { ...missing(path, tree.coverageComplete === true, 'not-covered'), manifest, tree }
}

/** No leaf or intermediate link is followed. A child of a non-directory is logically absent. */
export async function parents(
  root: string,
  path: string,
  create: boolean,
  modes: Record<string, number> = {},
  created?: Set<string>,
): Promise<boolean> {
  if (!contains(root, path)) throw new Error('Restore outside workspace')
  const rootStat = await statOrNull(root)
  if (!rootStat?.isDirectory() || (await realpath(root)) !== root)
    throw new Error('Workspace root changed')
  const rel = relative(root, dirname(path))
  if (rel === '' || path === root) return true
  let current = root
  for (const segment of rel.split(sep)) {
    current = join(current, segment)
    // oxlint-disable-next-line no-await-in-loop -- each parent must be validated before the next
    let stats = await statOrNull(current)
    if (stats === null && create) {
      // mkdir without recursive is exclusive; EEXIST is a failed path, never a reason to follow it.
      // oxlint-disable-next-line no-await-in-loop -- create one validated level at a time
      await mkdir(current, { mode: (modes[current] ?? 0o700) | 0o700 })
      created?.add(current)
      // oxlint-disable-next-line no-await-in-loop -- verify the entry actually created
      stats = await statOrNull(current)
    }
    if (stats === null || !stats.isDirectory() || stats.isSymbolicLink()) {
      if (create) throw new Error('Unsafe restore parent')
      return false
    }
    // oxlint-disable-next-line no-await-in-loop -- realpath must name exactly this root plus relative components
    if ((await realpath(current)) !== current) throw new Error('Restore parent alias')
  }
  return true
}
/** Exact on-disk spelling matters for case-only renames on insensitive filesystems. */
export async function exactEntry(path: string): Promise<boolean> {
  try {
    return (await readdir(dirname(path))).includes(basename(path))
  } catch {
    return false
  }
}
async function live(root: AbsolutePath, path: AbsolutePath): Promise<Point> {
  if (!(await parents(root, path, false))) return missing(path)
  const stats = (await exactEntry(path)) ? await statOrNull(path) : null
  if (stats === null) return missing(path)
  const stamp = saved(identity(stats))
  if (stats.isDirectory())
    return { ...directoryPoint(path, stamp.mode), file: { path, identity: stamp } }
  if (stats.isSymbolicLink()) {
    const text = await readlink(path)
    const after = await statOrNull(path)
    if (after === null || !same(stats, after)) throw new Error('Link changed during preview')
    return { file: { path, identity: stamp, link: text }, content: text, covered: true }
  }
  if (!stats.isFile() || stats.size > BigInt(MAX_FILE_BYTES))
    return missing(path, false, 'excluded')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const start = await handle.stat({ bigint: true })
    if (!same(stats, start)) throw new Error('File changed during preview')
    // Bound the read to the lstat size plus one sentinel byte even if an outside writer grows it.
    const size = Number(stats.size)
    const buffer = Buffer.alloc(size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== size) throw new Error('File changed during preview')
    const bytes = buffer.subarray(0, size)
    if (!same(start, await handle.stat({ bigint: true })))
      throw new Error('File changed during preview')
    return { file: { path, identity: stamp }, content: gitHash(bytes), covered: true }
  } finally {
    await handle.close()
  }
}
function names(manifest: SnapshotManifest | undefined): AbsolutePath[] {
  return manifest === undefined
    ? []
    : [
        ...manifest.files.map((file) => file.path),
        ...manifest.trees.flatMap((tree) => [
          ...tree.entries.map((entry) => entry.path),
          ...Object.keys(tree.directories)
            .filter((dir) => dir !== tree.folder)
            .map(absolutePath),
        ]),
      ]
}

const treeCovers = (manifest: IndexedManifest | undefined, path: AbsolutePath) =>
  manifest?.trees.some(
    (tree) => tree.entriesByPath.has(path) || tree.directories[path] !== undefined,
  ) === true

export async function planRestore(
  q: RestoreQuery,
  manifests: readonly SnapshotManifest[],
  roots: readonly AbsolutePath[],
  dir: string,
  git: SnapshotGit,
  current?: SnapshotManifest,
  capturedPaths?: ReadonlySet<AbsolutePath>,
): Promise<RestorePlan> {
  const wanted = new Set(q.calls.flatMap((call) => [call.before, call.after]))
  const byId = new Map(
    manifests
      .filter((manifest) => wanted.has(manifest.id))
      .map((manifest) => [manifest.id, indexManifest(manifest)]),
  )
  const currentIndex = current === undefined ? undefined : indexManifest(current)
  const changes = new Map<
    AbsolutePath,
    {
      start: Point
      last: Point | undefined
      gap: boolean
      gapSince?: number
      lastAt: number
      promised: boolean
      excluded: boolean
      treeCovered: boolean
      modes: Record<string, number>
    }
  >()
  // Index changed tree paths by ancestor once, so later exclusion lists visit only affected paths.
  const changesBelow = new Map<string, Set<AbsolutePath>>()
  const indexChange = (path: AbsolutePath) => {
    let ancestor: string = path
    for (;;) {
      const paths = changesBelow.get(ancestor) ?? new Set<AbsolutePath>()
      paths.add(path)
      changesBelow.set(ancestor, paths)
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  }
  const perCall: { path: AbsolutePath; start: Point; end: Point | undefined }[][] = []
  for (const [callIndex, call] of q.calls.entries()) {
    const before = call.before === undefined ? undefined : byId.get(call.before)
    const after = call.after === undefined ? undefined : byId.get(call.after)
    const candidates =
      call.path === undefined ? new Set([...names(before), ...names(after)]) : new Set([call.path])
    const modes = {
      ...Object.assign({}, ...(before?.trees.map((tree) => tree.directories) ?? [])),
      ...before?.directories,
    }
    const transitions: { path: AbsolutePath; start: Point; end: Point | undefined }[] = []
    for (const path of candidates) {
      // oxlint-disable-next-line no-await-in-loop -- call order determines each path's origin and gaps
      const start = await point(before, path, dir)
      // oxlint-disable-next-line no-await-in-loop -- compare the two snapshots for this call
      const end = after === undefined ? undefined : await point(after, path, dir)
      const previous = changes.get(path)
      // Only paths previously held by a tree can lose that coverage to a later exclusion.
      if (previous?.treeCovered && (!start.covered || (end !== undefined && !end.covered)))
        previous.excluded = true
      if (call.path === undefined && end !== undefined && equal(start, end)) continue
      transitions.push({ path, start, end })
      if (previous === undefined) {
        indexChange(path)
        changes.set(path, {
          start,
          last: end,
          gap: false,
          lastAt: callIndex,
          promised: call.path !== undefined && start.covered,
          excluded: false,
          treeCovered: treeCovers(before, path) || treeCovers(after, path),
          modes,
        })
      } else {
        previous.treeCovered ||= treeCovers(before, path) || treeCovers(after, path)
        const opened = !equal(previous.last, start)
        if (opened && !previous.gap) previous.gapSince = previous.lastAt
        previous.gap ||= opened
        previous.lastAt = callIndex
        previous.last = end
        previous.promised ||= call.path !== undefined && start.covered
      }
    }
    perCall.push(transitions)
    // D67: when a gap's source changes, protect surviving changes from the call after its
    // last record through this call. Propagated gaps open at the call that marks them.
    // Without an after-call snapshot we cannot prove a change, so do not trigger propagation.
    const sources = transitions.filter(
      ({ path, start, end }) =>
        changes.get(path)!.gap &&
        start.file.identity !== null &&
        end !== undefined &&
        !equal(start, end),
    )
    if (sources.length > 0) {
      let from = Infinity
      for (const { path } of sources)
        from = Math.min(from, changes.get(path)!.gapSince ?? callIndex - 1)
      for (let k = from + 1; k <= callIndex; k++) {
        for (const { path, start, end } of perCall[k] ?? []) {
          if (end === undefined || end.file.identity === null || equal(start, end)) continue
          const change = changes.get(path)!
          if (!change.gap) {
            change.gap = true
            change.gapSince = callIndex
          }
        }
      }
    }
    // Omitted paths are absent from candidates; look them up by excluded subtree instead.
    for (const manifest of [before, after]) {
      if (manifest === undefined) continue
      for (const tree of manifest.trees) {
        for (const name of tree.excluded) {
          for (const path of changesBelow.get(join(tree.folder, name)) ?? []) {
            const change = changes.get(path)!
            if (change.treeCovered && !manifest.filesByPath.has(path)) change.excluded = true
          }
        }
      }
    }
  }

  const preview: {
    previewKey: string
    restore: AbsolutePath[]
    remove: AbsolutePath[]
    conflicts: AbsolutePath[]
    skipped: RestorePreview['skipped'][number][]
  } = { previewKey: '', restore: [], remove: [], conflicts: [], skipped: [] }
  const items: RestoreItem[] = []
  const stamps: unknown[] = []
  const aliases = new Set<string>()
  const currentContents = new Map<AbsolutePath, string | undefined>()
  for (const [path, change] of [...changes].toSorted(([a], [b]) => a.localeCompare(b))) {
    const root = roots
      .filter((candidate) => contains(candidate, path))
      .toSorted((a, b) => b.length - a.length)[0]
    let now: Point = missing(path, false, 'outside-folders')
    let reason: Reason | undefined
    let historical = false
    if (root !== undefined) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- live inspection is read-only and leaf guarded
        // Even captured entries must pass live parent spelling checks (case-only directory aliases).
        await parents(root, path, false)
        now =
          current === undefined || !capturedPaths?.has(path)
            ? await live(root, path)
            : await point(currentIndex, path, dir)
        // A stored undo tree must not make a changed/symlinked workspace root safe.
        // oxlint-disable-next-line no-await-in-loop -- validate every selected real folder
        if ((await realpath(root)) !== root) reason = 'outside-folders'
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Restore parent alias' &&
          !change.gap &&
          change.start.covered &&
          change.start.file.identity === null &&
          change.last !== undefined &&
          change.last.covered &&
          change.last.file.identity === null
        ) {
          // Covered absence at both ends proves this is only a historical spelling; a missing
          // after-call record cannot prove that and must retain the normal alias protections.
          // A gap carries outside edits that must keep the entire alias group protected.
          historical = true
          now = missing(path)
        } else {
          if (error instanceof Error && error.message === 'Restore parent alias')
            aliases.add(foldRestorePath(path))
          reason = 'not-covered'
        }
      }
    } else reason = 'outside-folders'
    if (
      !change.start.covered ||
      (change.last !== undefined && !change.last.covered) ||
      !now.covered ||
      change.excluded
    )
      reason ??= change.excluded
        ? 'excluded'
        : (change.start.reason ?? change.last?.reason ?? now.reason ?? 'not-covered')
    if (
      [change.start, now].some((p) => p.file.identity?.kind === 'file' && p.file.identity.nlink > 1)
    )
      reason = 'hardlink'
    // Current gitignore/default/nested exclusions apply to Bash paths. Explicit file copies override them.
    if (
      reason === undefined &&
      !historical &&
      !change.promised &&
      root !== undefined &&
      (current === undefined || !capturedPaths?.has(path)) &&
      (await parents(root, path, false))
    ) {
      try {
        const repo = repoPath(dir, root)
        // oxlint-disable-next-line no-await-in-loop -- check-ignore does not mutate index or workspace
        const ignored = await git.run(
          repo,
          root,
          ['check-ignore', '--no-index', '-z', '--stdin'],
          new AbortController().signal,
          relative(root, path) + '\0',
        )
        if (ignored.length > 0) reason = 'excluded'
      } catch (error) {
        if ((error as { exitCode?: number }).exitCode !== 1) reason = 'not-covered'
      }
    }
    stamps.push([
      path,
      now.file.identity?.kind === 'dir'
        ? { kind: 'dir', mode: now.file.identity.mode }
        : now.file.identity,
      now.content,
      reason,
    ])
    currentContents.set(path, contentKey(now))
    if (reason !== undefined) {
      preview.skipped.push({
        path,
        reason,
        ...(change.promised ? { promised: true as const } : {}),
      })
      continue
    }
    if (equal(change.start, now)) continue
    const conflict = change.gap || !equal(change.last, now)
    if (conflict) preview.conflicts.push(path)
    if (change.start.file.identity === null) preview.remove.push(path)
    else preview.restore.push(path)
    items.push({
      path,
      root: root!,
      start: change.start,
      last: change.last,
      now,
      conflict,
      modes: change.modes,
    })
  }
  // Group only actionable/skipped paths; proven historical directory spellings were discarded above.
  const identities = await aliasKeys(
    [...items.map((item) => item.path), ...preview.skipped.map((item) => item.path)].filter(
      (path) => roots.some((root) => contains(root, path)),
    ),
  )
  const groups = new Map<string, string[]>()
  for (const [path, key] of identities) {
    const group = groups.get(key) ?? []
    group.push(path)
    groups.set(key, group)
  }
  const objectAliases = new Set<string>()
  const byPath = new Map(items.map((item) => [item.path, item]))
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const candidates = group.flatMap((path) => byPath.get(absolutePath(path)) ?? [])
    if (candidates.length === group.length && (await leafRenamePair(candidates)) !== undefined)
      continue
    for (const path of group) objectAliases.add(path)
  }
  // A skipped alias and its folded removal/ancestors refer to the same physical subtree.
  // Keep the whole affected pair: deleting the other spelling could delete its only copy.
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    const folded = foldRestorePath(item.path)
    if (
      !objectAliases.has(item.path) &&
      ![...aliases].some((alias) => contains(folded, alias) || contains(alias, folded))
    )
      continue
    items.splice(index, 1)
    preview.restore = preview.restore.filter((path) => path !== item.path)
    preview.remove = preview.remove.filter((path) => path !== item.path)
    preview.conflicts = preview.conflicts.filter((path) => path !== item.path)
    preview.skipped.push({
      path: item.path,
      reason: 'not-covered',
      ...(changes.get(item.path)?.promised ? { promised: true as const } : {}),
    })
  }
  // D70: default-kept conflicts and skipped origins can each leave their only copy elsewhere.
  // Reuse the guarded live/undo content hashes; compare nonempty regular files by size + Git blob
  // hash. Index candidates once, then enqueue newly protected origins until a fixed point.
  // Each item becomes a conflict at most once and each content key is queued once, so this stops.
  const candidatesByContent = new Map<string, RestoreItem[]>()
  const pending: string[] = []
  const queued = new Set<string>()
  const enqueue = (origin: Point | undefined) => {
    const key = contentKey(origin)
    if (key === undefined || queued.has(key)) return
    queued.add(key)
    pending.push(key)
  }
  for (const item of items) {
    if (item.conflict) enqueue(item.start)
    else {
      const key = contentKey(item.now)
      if (key === undefined) continue
      const candidates = candidatesByContent.get(key) ?? []
      candidates.push(item)
      candidatesByContent.set(key, candidates)
    }
  }
  for (const skipped of preview.skipped) {
    const origin = changes.get(skipped.path)?.start
    // A skipped file still holding its origin needs no other copy protected. Unknown live
    // content (including unreadable parent aliases) stays conservative and seeds the worklist.
    if (contentKey(origin) !== currentContents.get(skipped.path)) enqueue(origin)
  }
  for (let head = 0; head < pending.length; head++) {
    const key = pending[head]!
    for (const item of candidatesByContent.get(key) ?? []) {
      item.conflict = true
      enqueue(item.start)
    }
    candidatesByContent.delete(key)
  }
  preview.conflicts = items.filter((item) => item.conflict).map((item) => item.path)
  preview.skipped.sort((a, b) => a.path.localeCompare(b.path))
  // Covers the displayed plan and every live candidate's identity/content, including kept conflicts
  // and skipped/already-restored paths. Only actionable paths use captured undo state in prepare;
  // the others stay live because an undo snapshot need not (and sometimes cannot) capture them.
  preview.previewKey = pathKey(JSON.stringify([q, roots, preview, stamps]))
  return { preview, items }
}

function sameIdentity(a: SavedIdentity | null, b: SavedIdentity | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
async function check(item: RestoreItem): Promise<void> {
  if (!(await parents(item.root, item.path, false))) {
    if (item.now.file.identity !== null) throw new Error('Restore parent changed')
    return
  }
  const stats = await statOrNull(item.path)
  if (!sameIdentity(item.now.file.identity, stats === null ? null : saved(identity(stats))))
    throw new Error('Restore target changed')
}
async function sourceBytes(item: RestoreItem, dir: string, git: SnapshotGit): Promise<Uint8Array> {
  const file = item.start.file
  if (file.hash === undefined) throw new Error('Snapshot content missing')
  if (item.start.tree !== undefined)
    return git.blob(
      repoPath(dir, item.start.tree.folder),
      item.start.tree.folder,
      file.hash,
      new AbortController().signal,
    )
  if (!/^[0-9a-f]{64}$/.test(file.hash)) throw new Error('Invalid content hash')
  const data = await readFile(join(dir, 'files', file.hash))
  if (pathKey(data) !== file.hash) throw new Error('Snapshot content damaged')
  return data
}

export async function applyRestore(
  plan: RestorePlan,
  dir: string,
  git: SnapshotGit,
  overwrite: readonly AbsolutePath[],
): Promise<RestoreDone> {
  if (overwrite.some((path) => !plan.preview.conflicts.includes(path)))
    throw new Error('Overwrite must be a subset of conflicts')
  const selected = plan.items.filter((item) => !item.conflict || overwrite.includes(item.path))
  const failed = new Set<AbsolutePath>()
  const done: RestoreDone = {
    restored: 0,
    removed: 0,
    kept: plan.items.length - selected.length,
    failed: [],
  }
  const deleted = new Set<AbsolutePath>()
  const modes: Record<string, number> = {}
  const touchedDirs = new Map<string, AbsolutePath[]>()
  const createdDirs = new Set<string>()
  const directoryChecks = new Map<AbsolutePath, SavedIdentity | null>()
  const checkSelected = async (item: RestoreItem): Promise<void> => {
    const expected = directoryChecks.get(item.path)
    if (expected === undefined) return check(item)
    if (!(await parents(item.root, item.path, false))) throw new Error('Restore parent changed')
    const stats = await statOrNull(item.path)
    if (!sameIdentity(expected, stats === null ? null : saved(identity(stats))))
      throw new Error('Restore directory changed')
  }
  const refreshAncestors = async (path: AbsolutePath): Promise<void> => {
    for (const ancestor of directoryChecks.keys()) {
      if (ancestor === path || !contains(ancestor, path)) continue
      const stats = await statOrNull(ancestor)
      if (stats?.isDirectory()) directoryChecks.set(ancestor, saved(identity(stats)))
    }
  }
  // Include skipped/kept names in the group: selecting two names cannot hide a third alias.
  const identities = await aliasKeys([
    ...plan.items.map((item) => item.path),
    ...plan.preview.skipped.map((item) => item.path),
  ])
  const groups = new Map<string, AbsolutePath[]>()
  for (const [path, key] of identities) {
    const group = groups.get(key) ?? []
    group.push(absolutePath(path))
    groups.set(key, group)
  }
  const byPath = new Map(selected.map((item) => [item.path, item]))
  const paired = new Map<AbsolutePath, AbsolutePath>()
  for (const group of groups.values()) {
    const candidates = group.flatMap((path) => byPath.get(path) ?? [])
    if (candidates.length !== group.length) continue
    const pair = await leafRenamePair(candidates)
    if (pair !== undefined) paired.set(...pair)
  }
  const origins = new Map([...paired].map(([origin, removal]) => [removal, origin]))
  const selectedPaths = new Set(selected.map((item) => item.path))
  const protectedPaths = new Set([
    ...plan.preview.skipped.map((skip) => skip.path),
    ...plan.items
      .filter((item) => !selectedPaths.has(item.path) || item.start.file.identity !== null)
      .map((item) => item.path),
  ])
  // Validate all byte sources before deleting a path whose type has changed.
  const contents = new Map<AbsolutePath, Uint8Array>()
  for (const item of selected.filter((candidate) => candidate.now.file.identity?.kind === 'dir')) {
    try {
      await check(item)
      directoryChecks.set(item.path, item.now.file.identity)
    } catch {
      failed.add(item.path)
    }
  }
  for (const item of selected) {
    if (item.start.file.identity?.kind === 'file' && !equal(item.start, item.now, false)) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- object reads use the serialized shadow repo
        contents.set(item.path, await sourceBytes(item, dir, git))
      } catch {
        failed.add(item.path)
      }
    }
  }
  // Re-read retained identities once at the destructive phase boundary, not from the preview.
  // Each deletion then checks its current inode against this index; keep colliding objects intact.
  const protectedObjects = new Map<string, Set<AbsolutePath>>()
  let unreadableProtected = false
  for (const path of protectedPaths) {
    try {
      const key = await objectKey(path)
      if (key === undefined) continue
      const paths = protectedObjects.get(key) ?? new Set<AbsolutePath>()
      paths.add(path)
      protectedObjects.set(key, paths)
    } catch {
      unreadableProtected = true
    }
  }
  for (const item of selected.toSorted((a, b) => depth(b.path) - depth(a.path))) {
    if (failed.has(item.path)) continue
    const start = item.start.file.identity
    const now = item.now.file.identity
    const remove =
      now !== null &&
      (start === null ||
        start.kind !== now.kind ||
        (start.kind === 'link' && !equal(item.start, item.now)))
    if (!remove) continue
    try {
      // oxlint-disable-next-line no-await-in-loop -- every destructive operation checks parents and identity
      await checkSelected(item)
      for (const ancestorItem of selected.filter(
        (candidate) =>
          directoryChecks.has(candidate.path) &&
          candidate.path !== item.path &&
          contains(candidate.path, item.path),
      ))
        await checkSelected(ancestorItem)
      // oxlint-disable-next-line no-await-in-loop -- deletions precede every placement
      await parents(item.root, item.path, true, item.modes, createdDirs)
      const origin = origins.get(item.path)
      if (origin !== undefined) {
        // Do not unlink the sole copy if its replacement is unavailable or the pair has changed.
        if (failed.has(origin) || (await leafRenamePair([byPath.get(origin)!, item])) === undefined)
          throw new Error('Restore rename changed')
      }
      const deleting = await objectKey(item.path)
      const retained = deleting === undefined ? undefined : protectedObjects.get(deleting)
      if (
        unreadableProtected ||
        (retained !== undefined &&
          [...retained].some((path) => path !== item.path && path !== origin))
      )
        throw new Error('Restore removal aliases a retained path')
      // Never recursive: an unlisted child must survive and make rmdir fail.
      // oxlint-disable-next-line no-await-in-loop -- deepest entries first
      if (now.kind === 'dir') await rmdir(item.path)
      // oxlint-disable-next-line no-await-in-loop -- unlink never follows the leaf
      else await unlink(item.path)
      await refreshAncestors(item.path)
      deleted.add(item.path)
      if (start === null && !origins.has(item.path)) done.removed++
    } catch {
      failed.add(item.path)
    }
  }
  for (const item of selected.toSorted((a, b) => depth(a.path) - depth(b.path))) {
    if (failed.has(item.path) || item.start.file.identity === null) continue
    const stamp = item.start.file.identity
    const pair = paired.get(item.path)
    try {
      if (pair !== undefined && !deleted.has(pair)) throw new Error('Rename source not removed')
      const wasRemoved = deleted.has(item.path) || pair !== undefined
      // oxlint-disable-next-line no-await-in-loop -- identity is rechecked immediately before placement
      if (!wasRemoved) await checkSelected(item)
      // oxlint-disable-next-line no-await-in-loop -- validate/create every level before a write
      await parents(item.root, item.path, true, item.modes, createdDirs)
      if (wasRemoved && (await statOrNull(item.path)) !== null)
        throw new Error('Restore target appeared')
      Object.assign(modes, item.modes)
      for (const parent of Object.keys(item.modes).filter(
        (candidate) =>
          createdDirs.has(candidate) &&
          contains(item.root, candidate) &&
          contains(candidate, item.path),
      ))
        touchedDirs.set(parent, [...(touchedDirs.get(parent) ?? []), item.path])
      if (stamp.kind === 'dir') {
        // oxlint-disable-next-line no-await-in-loop -- directory permissions are finalized after contents
        if (wasRemoved || item.now.file.identity === null)
          await mkdir(item.path, { mode: stamp.mode | 0o700 })
        modes[item.path] = stamp.mode
        touchedDirs.set(item.path, [item.path])
      } else if (stamp.kind === 'link') {
        // oxlint-disable-next-line no-await-in-loop -- exclusive symlink creation preserves the link text, never its target
        await symlink(item.start.file.link!, item.path)
        // POSIX Linux fixes link modes at 0777; Darwin exposes and restores lchmod bits.
        if (process.platform === 'darwin') await lchmod(item.path, stamp.mode)
      } else if (stamp.kind === 'file') {
        if (equal(item.start, item.now, false) && !wasRemoved) {
          // O_NOFOLLOW and fstat before chmod keep a swapped leaf from changing another file.
          // oxlint-disable-next-line no-await-in-loop -- mode-only changes never rewrite content or mtime
          const handle = await open(
            item.path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          )
          try {
            if (
              !sameIdentity(
                item.now.file.identity,
                saved(identity(await handle.stat({ bigint: true }))),
              )
            )
              throw new Error('Restore target changed')
            await handle.chmod(stamp.mode)
          } finally {
            await handle.close()
          }
        } else {
          const data = contents.get(item.path)!
          const creating = wasRemoved || item.now.file.identity === null
          const temp = creating
            ? item.path
            : join(dirname(item.path), `.tenon-restore-${randomUUID()}`)
          // oxlint-disable-next-line no-await-in-loop -- each leaf is created exclusively without following links
          const handle = await open(
            temp,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            stamp.mode,
          )
          let completed = false
          let created: { dev: bigint; ino: bigint } | undefined
          try {
            try {
              created = await handle.stat({ bigint: true })
              await handle.writeFile(data)
              await handle.chmod(stamp.mode)
            } finally {
              await handle.close()
            }
            if (!creating) {
              await check(item)
              if (!(await parents(item.root, item.path, false)))
                throw new Error('Restore parent changed')
              await rename(temp, item.path)
            }
            completed = true
          } finally {
            if (!creating) await unlink(temp).catch(() => {})
            else if (
              !completed &&
              created !== undefined &&
              (await parents(item.root, item.path, false))
            ) {
              const current = await statOrNull(item.path)
              // Failed exclusive creates may leave partial bytes; never remove a replacement inode.
              if (current?.dev === created.dev && current.ino === created.ino)
                await unlink(item.path)
            }
          }
        }
      } else throw new Error('Unsupported restore type')
      await refreshAncestors(item.path)
      done.restored++
    } catch {
      failed.add(item.path)
    }
  }
  for (const [path, affected] of [...touchedDirs].toSorted(([a], [b]) => depth(b) - depth(a))) {
    try {
      const root = selected.find((item) => contains(item.root, path))!.root
      // oxlint-disable-next-line no-await-in-loop -- finalize from deepest directory to root
      if (!(await parents(root, path, false))) throw new Error('Restore parent changed')
      // oxlint-disable-next-line no-await-in-loop -- no-follow handle prevents chmod through a substituted link
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      )
      try {
        const opened = await handle.stat({ bigint: true })
        const current = await statOrNull(path)
        if (
          !current?.isDirectory() ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          (await realpath(path)) !== path
        )
          throw new Error('Directory alias or replacement')
        await handle.chmod(modes[path]!)
      } finally {
        await handle.close()
      }
    } catch {
      for (const affectedPath of affected) failed.add(affectedPath)
    }
  }
  return { ...done, failed: [...failed].toSorted() }
}
