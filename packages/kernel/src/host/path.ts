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
