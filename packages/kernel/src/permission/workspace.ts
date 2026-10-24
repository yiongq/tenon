/**
 * "Is this path in the workspace?" (spec 02 §「在不在工作区里」; D8, D11, D2, H9, H1). Kernel-internal:
 * nothing here reaches contracts.
 *
 * Everything is compared as REAL paths: the path is normalised, then resolved through `HostFs.realpath`
 * — and when the entry does not exist yet (a file about to be written, a folder about to be made),
 * through its nearest existing parent, with the missing segments put back as the model wrote them.
 * The roots, the profile directory and the protected files are resolved by the same algorithm before
 * they are compared, or a workspace under a link (macOS `/tmp` → `/private/tmp`) would make everything
 * in it read as outside. The session's own spill directory is not resolved itself: it is the resolved
 * profile directory's `tool-output/<sessionId>`, so a link planted there places what it leads to as
 * that place, not as the spill (step 4).
 *
 * A path the host finds but cannot name (`UnresolvableAliasError`: macOS's `/.vol/<dev>/<ino>`
 * reaches any file by inode) cannot be compared with anything, so it is placed `protected`: blocked
 * with no card, like the protected list (owner 2026-09-27). Any other failure reads as outside.
 *
 * Two known limits (D8): a link swapped after Write and Edit resolve their path once more, just
 * before they touch it (`stillNamesItself`, step 5), and before the write (a race phase 2 does not
 * handle); and a hard link in the workspace to a file outside it. Both are phase 4's to decide.
 */
import { UnresolvableAliasError } from '../host/adapter.js'
import type { AbsolutePath, HostFs } from '../host/adapter.js'
import { fromParts, isWithin, normalizePath, pathParts, joinPath } from '../host/path.js'

export type PathPlace = 'workspace' | 'outside' | 'own-spill' | 'protected'

export interface PathVerdict {
  readonly real: AbsolutePath
  readonly place: PathPlace
  readonly sensitive?: 'credential' | 'auto-run' | 'hardlink'
}

export interface PathScope {
  readonly sensitive?: {
    readonly credential: readonly AbsolutePath[]
    readonly autoRunNames: readonly string[]
    readonly linkTargets: readonly { real: AbsolutePath; category: 'credential' | 'auto-run' }[]
  }
  readonly roots: readonly AbsolutePath[] // 工作区根，选定时已解析；对话形态传 []
  readonly profileDir: AbsolutePath // 启动时解析一次
  readonly ownSpillDir: AbsolutePath // 解析过的 profileDir 下的 tool-output/<sessionId>，本身不解析
  readonly protectedFiles: readonly AbsolutePath[] // 保护名单里的 shell 配置文件，desktop 给出，启动时解析
}

/**
 * A path resolved to its real form; `resolved: false` when that cannot be done, which reads as
 * outside — or, with `alias`, as protected: the host found the entry but could not name it.
 */
export interface ResolvedPath {
  readonly path: AbsolutePath
  readonly resolved: boolean
  readonly alias?: true
}

/**
 * Steps 1 and 2: normalise, then `realpath`, walking up past entries that do not exist yet. A null
 * all the way to the root (a drive that is not there, a disconnected share) or a `realpath` that
 * throws (a dangling link, a loop, EACCES) cannot be resolved: the normalised path is returned with
 * `resolved: false`, and `alias` when the throw was `UnresolvableAliasError` — for the path or for
 * the parent it walked up to.
 */
export async function resolvePath(fs: HostFs, path: AbsolutePath): Promise<ResolvedPath> {
  const normalized = normalizePath(path)
  const parts = pathParts(normalized)
  const missing: string[] = []
  let segments = [...parts.segments]
  for (;;) {
    const current = fromParts({ ...parts, segments })
    let real: AbsolutePath | null
    try {
      // oxlint-disable-next-line no-await-in-loop -- each parent is asked only once the child was missing
      real = await fs.realpath(current)
    } catch (error) {
      if (error instanceof UnresolvableAliasError) {
        return { path: normalized, resolved: false, alias: true }
      }
      return { path: normalized, resolved: false }
    }
    if (real !== null) {
      if (missing.length === 0) return { path: real, resolved: true }
      const resolved = pathParts(real)
      return {
        path: fromParts({ ...resolved, segments: [...resolved.segments, ...missing] }),
        resolved: true,
      }
    }
    const last = segments.pop()
    if (last === undefined) return { path: normalized, resolved: false }
    missing.unshift(last)
  }
}

/**
 * Where a path falls (step 3), first match wins: the session's own spill directory; the rest of the
 * profile directory or a protected file — even inside a workspace root; a workspace root; outside.
 * A path that cannot be resolved is outside, with `real` the normalised path; one the host found but
 * could not name is protected, with the same `real` (spec 02 §「在不在工作区里」 step 2; owner
 * 2026-09-27).
 */
export async function locatePath(
  fs: HostFs,
  path: AbsolutePath,
  scope: PathScope,
  tool: 'Read' | 'Write' | 'Edit' | 'Delete' | 'Glob' | 'Grep' = 'Read',
): Promise<PathVerdict> {
  const written = normalizePath(path)
  const parts = pathParts(written)
  const leaf = parts.segments.at(-1)
  const resolution =
    tool === 'Delete' && leaf !== undefined
      ? await resolvePath(fs, fromParts({ ...parts, segments: parts.segments.slice(0, -1) }))
      : await resolvePath(fs, written)
  const real =
    tool === 'Delete' && leaf !== undefined ? joinPath(resolution.path, leaf) : resolution.path
  if (resolution.alias === true) return { real, place: 'protected' }
  const place = resolution.resolved ? placeOf(real, scope) : 'outside'
  if (place === 'protected' || isProtectedFile(written, scope.protectedFiles))
    return { real, place: 'protected' }
  if (place === 'own-spill' && (tool === 'Write' || tool === 'Edit' || tool === 'Delete'))
    return { real, place }
  const sensitive = sensitiveName(
    written,
    real,
    scope,
    tool !== 'Read' && tool !== 'Glob' && tool !== 'Grep',
  )
  if (sensitive !== undefined) return { real, place: 'outside', sensitive }
  if (tool === 'Write' || tool === 'Edit' || tool === 'Delete') {
    try {
      const stamp = await fs.identity(real)
      if (stamp?.kind === 'file' && stamp.nlink > 1)
        return { real, place: 'outside', sensitive: 'hardlink' }
    } catch {
      return { real, place: 'protected' }
    }
  }
  return { real, place }
}

/** Spec 05: shared names compare by folded path segments, never string prefixes. */
export function sensitiveName(
  written: AbsolutePath,
  real: AbsolutePath,
  scope: PathScope,
  writing: boolean,
): 'credential' | 'auto-run' | undefined {
  const list = scope.sensitive
  if (list === undefined) return undefined
  const paths = [written, real]
  const within = (path: string, root: string): boolean => {
    const a = foldCase(path).replaceAll('\\', '/')
    const b = foldCase(root).replaceAll('\\', '/').replace(/\/$/, '')
    return a === b || a.startsWith(b + '/')
  }
  if (
    paths.some(
      (path) =>
        list.credential.some((entry) => within(path, entry)) ||
        list.linkTargets.some(
          (entry) => entry.category === 'credential' && within(path, entry.real),
        ),
    )
  )
    return 'credential'
  if (!writing) return undefined
  if (
    paths.some((path) =>
      list.linkTargets.some((entry) => entry.category === 'auto-run' && within(path, entry.real)),
    )
  )
    return 'auto-run'
  for (const path of paths) {
    for (const root of scope.roots) {
      if (!within(path, root)) continue
      const segments = pathParts(path).segments.slice(pathParts(root).segments.length).map(foldCase)
      if (
        list.autoRunNames.some((name) => {
          const wanted = name.split('/').filter(Boolean).map(foldCase)
          return segments.some((_, start) =>
            wanted.every((part, offset) => segments[start + offset] === part),
          )
        })
      )
        return 'auto-run'
    }
  }
  return undefined
}

/**
 * Step 3 on a path already real. The protected files are compared without regard to case: a file
 * that does not exist yet keeps the model's spelling (step 2), and on a case-insensitive volume
 * (APFS: `.ZPROFILE` is written as `.zprofile`) a spelling in another case would create the protected
 * file. Only more paths become protected: two paths equal in code units are equal folded.
 */
export function placeOf(real: AbsolutePath, scope: PathScope): PathPlace {
  if (isWithin(real, scope.ownSpillDir)) return 'own-spill'
  if (isWithin(real, scope.profileDir) || isProtectedFile(real, scope.protectedFiles)) {
    return 'protected'
  }
  if (scope.roots.some((root) => isWithin(real, root))) return 'workspace'
  return 'outside'
}

function isProtectedFile(real: AbsolutePath, files: readonly AbsolutePath[]): boolean {
  let folded = foldedLists.get(files)
  if (folded === undefined) {
    folded = new Set(files.map((file) => foldCase(file)))
    foldedLists.set(files, folded)
  }
  return folded.has(foldCase(real))
}

/** Each scope's list folded once: a walk places every file it meets. */
const foldedLists = new WeakMap<readonly AbsolutePath[], ReadonlySet<string>>()

/**
 * The fold the protected compare uses: canonical decomposition (NFD, as APFS ignores the form), then
 * lower, upper and lower case again. ASCII letters fold as they would anywhere; so does every
 * character APFS folds onto the list's ASCII names — `ſ` onto `s`, the Kelvin sign onto `k`, `ﬁ` onto
 * `fi`, `ẞ` onto `ss` (a sweep of U+0080–U+2FFFF against one- and two-letter names, 2026-09-27: all
 * nine that APFS matched fold the same here). Where it is wider than APFS (`ı` onto `i`), it only
 * blocks one more spelling.
 */
export function foldCase(path: string): string {
  return path.normalize('NFD').toLowerCase().toUpperCase().toLowerCase()
}
