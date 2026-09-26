import type { AbsolutePath } from './adapter.js'

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
const UNC = /^\\\\/

/** True for POSIX (`/x`), Windows drive (`C:\x`, `C:/x`) and UNC (`\\server\x`) paths. */
export function isAbsolutePath(path: string): path is AbsolutePath {
  return path.startsWith('/') || WINDOWS_DRIVE.test(path) || UNC.test(path)
}

/** Brands `path` as absolute or throws. Hosts call this at every boundary. */
export function absolutePath(path: string): AbsolutePath {
  if (!isAbsolutePath(path)) {
    throw new TypeError(`expected an absolute path, got "${path}"`)
  }
  return path
}

/**
 * Appends segments to an absolute base with `/`. Does not resolve `.` or `..`;
 * callers validate segments (see profileDirFor).
 */
export function joinPath(base: AbsolutePath, ...segments: string[]): AbsolutePath {
  const parts = segments.filter((s) => s.length > 0)
  const trimmed = base.length > 1 ? base.replace(/[\\/]+$/, '') : base
  if (parts.length === 0) return trimmed as AbsolutePath
  const sep = trimmed.endsWith('/') ? '' : '/'
  return `${trimmed}${sep}${parts.join('/')}` as AbsolutePath
}

/**
 * An absolute path split into its root and its segments, the three spellings `isAbsolutePath` accepts:
 * POSIX (root `/`, only `/` separates), a Windows drive (root `C:` plus its separator) and UNC (root
 * `\\server\share`, which `..` cannot climb above). Both Windows forms take `/` and `\` alike.
 */
export interface PathParts {
  readonly root: string
  readonly separator: '/' | '\\'
  readonly segments: readonly string[]
}

export function pathParts(path: AbsolutePath): PathParts {
  if (UNC.test(path)) {
    const [server = '', share = '', ...segments] = path.slice(2).split(/[\\/]+/)
    return { root: `\\\\${server}\\${share}`, separator: '\\', segments: segments.filter(Boolean) }
  }
  if (WINDOWS_DRIVE.test(path)) {
    const separator = path[2] === '/' ? '/' : '\\'
    return {
      root: `${path.slice(0, 2)}${separator}`,
      separator,
      segments: path
        .slice(3)
        .split(/[\\/]+/)
        .filter(Boolean),
    }
  }
  return { root: '/', separator: '/', segments: path.split('/').filter(Boolean) }
}

/** The path the parts spell. */
export function fromParts(parts: PathParts): AbsolutePath {
  if (parts.segments.length === 0) return parts.root as AbsolutePath
  const joiner = parts.root.endsWith(parts.separator) ? '' : parts.separator
  return `${parts.root}${joiner}${parts.segments.join(parts.separator)}` as AbsolutePath
}

/**
 * Drops `.` and resolves `..` without touching the disk (spec 02 §「在不在工作区里」 step 1, D8); a
 * `..` past the root stays at the root. Pure, no `node:path`, the same three spellings as `joinPath`.
 */
export function normalizePath(path: AbsolutePath): AbsolutePath {
  const parts = pathParts(path)
  const segments: string[] = []
  for (const segment of parts.segments) {
    if (segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return fromParts({ ...parts, segments })
}

/**
 * Whether `path` is `folder` or inside it, by segments: `/a/ws` does not contain `/a/ws2`. Both are
 * compared as given — case-sensitive — so both should be real paths already.
 */
export function isWithin(path: AbsolutePath, folder: AbsolutePath): boolean {
  const inner = pathParts(path)
  const outer = pathParts(folder)
  if (inner.root !== outer.root || inner.segments.length < outer.segments.length) return false
  return outer.segments.every((segment, i) => inner.segments[i] === segment)
}
