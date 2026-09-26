/**
 * "Is this path in the workspace?" (spec 02 §「在不在工作区里」; D8, D11, D2, H9, H1). Kernel-internal:
 * nothing here reaches contracts.
 *
 * Everything is compared as REAL paths: the path is normalised, then resolved through `HostFs.realpath`
 * — and when the entry does not exist yet (a file about to be written, a folder about to be made),
 * through its nearest existing parent, with the missing segments put back as the model wrote them.
 * The roots, the profile directory, the session's own spill directory and the protected files are
 * resolved by the same algorithm before they are compared, or a workspace under a link (macOS `/tmp`
 * → `/private/tmp`) would make everything in it read as outside.
 *
 * Two known limits (D8): a link swapped between this judgement and the execution (a race phase 2 does
 * not handle), and a hard link in the workspace to a file outside it. Both are phase 4's to decide.
 */
import type { AbsolutePath, HostFs } from '../host/adapter.js'
import { fromParts, isWithin, normalizePath, pathParts } from '../host/path.js'

export type PathPlace = 'workspace' | 'outside' | 'own-spill' | 'protected'

export interface PathVerdict {
  readonly real: AbsolutePath
  readonly place: PathPlace
}

export interface PathScope {
  readonly roots: readonly AbsolutePath[] // 工作区根，选定时已解析；对话形态传 []
  readonly profileDir: AbsolutePath // 启动时解析一次
  readonly ownSpillDir: AbsolutePath // <profileDir>/tool-output/<sessionId>，同样解析
  readonly protectedFiles: readonly AbsolutePath[] // 保护名单里的 shell 配置文件，desktop 给出，启动时解析
}

/** A path resolved to its real form; `resolved: false` when that cannot be done, which reads as outside. */
export interface ResolvedPath {
  readonly path: AbsolutePath
  readonly resolved: boolean
}

/**
 * Steps 1 and 2: normalise, then `realpath`, walking up past entries that do not exist yet. A null
 * all the way to the root (a drive that is not there, a disconnected share) or a `realpath` that
 * throws (a dangling link, a loop, EACCES) cannot be resolved: the normalised path is returned with
 * `resolved: false`.
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
    } catch {
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
 * A path that cannot be resolved is outside, with `real` the normalised path.
 */
export async function locatePath(
  fs: HostFs,
  path: AbsolutePath,
  scope: PathScope,
): Promise<PathVerdict> {
  const { path: real, resolved } = await resolvePath(fs, path)
  if (!resolved) return { real, place: 'outside' }
  return { real, place: placeOf(real, scope) }
}

/** Step 3 on a path already real. */
export function placeOf(real: AbsolutePath, scope: PathScope): PathPlace {
  if (isWithin(real, scope.ownSpillDir)) return 'own-spill'
  if (isWithin(real, scope.profileDir) || scope.protectedFiles.includes(real)) return 'protected'
  if (scope.roots.some((root) => isWithin(real, root))) return 'workspace'
  return 'outside'
}
