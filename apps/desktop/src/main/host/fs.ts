import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { parse, sep } from 'node:path'
import type { AbsolutePath, HostFs } from '@tenon-app/kernel'
import { UnresolvableAliasError, absolutePath } from '@tenon-app/kernel'

/** Real filesystem access for the desktop host. Every path is re-checked to be absolute. */
export class DesktopFs implements HostFs {
  async readFile(path: AbsolutePath, opts?: { encoding?: 'utf8' }): Promise<Uint8Array | string> {
    absolutePath(path)
    if (opts?.encoding === 'utf8') return readFile(path, 'utf8')
    const buf = await readFile(path)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  async writeFile(path: AbsolutePath, data: Uint8Array | string): Promise<void> {
    absolutePath(path)
    await writeFile(path, data)
  }

  async stat(
    path: AbsolutePath,
  ): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null> {
    absolutePath(path)
    try {
      const s = await stat(path)
      return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() }
    } catch (err) {
      if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return null
      throw err
    }
  }

  async readdir(path: AbsolutePath): Promise<string[]> {
    absolutePath(path)
    return (await readdir(path)).toSorted()
  }

  async mkdirp(path: AbsolutePath): Promise<void> {
    absolutePath(path)
    await mkdir(path, { recursive: true })
  }

  /**
   * `fs.promises.realpath` is the native realpath(3), which also gives the on-disk letter case
   * (the JS `fs.realpathSync` does not; spec 02 §「在不在工作区里」). A dangling link's realpath
   * reports ENOENT like a missing path does, so ENOENT / ENOTDIR are checked once more with lstat:
   * only an entry lstat cannot see either is "not there" (null). Otherwise the original error is
   * thrown — writing through that dangling link would create a file wherever it points. lstat looks
   * at the entry itself, so a trailing separator or `/.` is dropped first: with one, lstat follows
   * the link too, and `ws/evil/` would read as missing while mkdirp through it escapes.
   *
   * When lstat sees the entry, stat tells the two apart: a dangling link cannot be followed, and its
   * error is thrown as above; an entry stat can follow is there, and realpath(3) only cannot name it —
   * macOS's `/.vol/<dev>/<ino>` reaches any file by inode that way. That throws
   * `UnresolvableAliasError`, which the kernel blocks like the protected list (spec 02
   * §「在不在工作区里」 step 2; owner 2026-09-27).
   *
   * On macOS that check runs for every errno realpath(3) reports, not only ENOENT / ENOTDIR:
   * `/.resolve/<n>/<path>` answers EINVAL while lstat, stat and a read all reach the file (s11-safety-2,
   * probed on macOS 26.3). And the VFS has spellings realpath(3) gives back as they are, or names by
   * something no protected path can equal: `/.nofollow/<path>` (the same path, links not followed),
   * `/.vol/…`, and `/dev/fd/<n>`, a file this process holds open — `sessions.db` among them — which
   * realpath(3) names `/dev/fd/<file name>`. A path under one of those roots, as given or as realpath(3)
   * answers it (`/dev/stdout` is a link into `/dev/fd`), throws `UnresolvableAliasError` too, unless it
   * is simply missing: then it is null, and the kernel meets the alias at the first parent that is
   * there. Matched without regard to case: the root volume is case-insensitive, and `/DEV/fd/<n>` reads
   * the same fd. Only an exact prefix is live — `//.nofollow/…` is an ordinary missing path — and
   * realpath(3) folds such spellings into the alias, which the check on its answer catches.
   *
   * On macOS the data volume is also mounted at /System/Volumes/Data, and realpath(3) leaves that
   * spelling as it is: `/System/Volumes/Data/Users/u/.zshrc` is `/Users/u/.zshrc` under another name
   * (a firmlink), and compared as a string it would read as outside the protected list. A result under
   * that mount is given back in the root spelling when that path is the same file (same device and
   * inode), so one file has one real path (spec 02 §「在不在工作区里」 steps 2–3; D8).
   */
  async realpath(path: AbsolutePath): Promise<AbsolutePath | null> {
    absolutePath(path)
    let real: string
    try {
      real = await realpath(path)
    } catch (err) {
      const missing = isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')
      if (!missing && !DARWIN) throw err
      // Under an alias root, what is not simply missing is the alias: a name to be made there
      // (`/.resolve/1/<path>/new`, EINVAL) included.
      const failed = (): unknown =>
        DARWIN && underAliasRoot(path) ? new UnresolvableAliasError(path, { cause: err }) : err
      const entry = entryOf(path)
      try {
        await lstat(entry)
      } catch (lstatErr) {
        // Missing: the kernel walks up, and meets the alias at the first parent that is there.
        if (missing && (isErrno(lstatErr, 'ENOENT') || isErrno(lstatErr, 'ENOTDIR'))) return null
        throw failed()
      }
      const followed = await stat(entry).then(
        () => true,
        () => false,
      )
      if (followed) throw new UnresolvableAliasError(path, { cause: err })
      throw failed()
    }
    if (DARWIN && (underAliasRoot(path) || underAliasRoot(real))) {
      throw new UnresolvableAliasError(path)
    }
    return absolutePath(await rootSpelling(real))
  }
}

const DARWIN = process.platform === 'darwin'

/**
 * macOS's roots of other names for a file (s11-safety-2): `/.vol/<dev>/<ino>` by inode, `/.nofollow`
 * and `/.resolve/<n>` over any path, `/dev/fd/<n>` over an open file. Each root itself included: a
 * walk from it would reach the same files.
 */
const ALIAS_ROOTS = ['/.vol', '/.nofollow', '/.resolve', '/dev/fd']

function underAliasRoot(path: string): boolean {
  const folded = path.toLowerCase()
  return ALIAS_ROOTS.some((root) => folded === root || folded.startsWith(`${root}/`))
}

/** The macOS data volume's own mount point, where every firmlinked folder has a second spelling. */
const DATA_VOLUME = '/System/Volumes/Data'

/** A real path under the data volume's mount, as the root spells it when that is the same file. */
async function rootSpelling(real: string): Promise<string> {
  if (!real.startsWith(`${DATA_VOLUME}/`)) return real
  try {
    const root = await realpath(real.slice(DATA_VOLUME.length))
    if (root === real) return real
    const [a, b] = await Promise.all([stat(real, { bigint: true }), stat(root, { bigint: true })])
    return a.dev === b.dev && a.ino === b.ino ? root : real
  } catch {
    return real // no such folder at the root: the path is only the data volume's
  }
}

/** The directory entry a path names: trailing separators and `/.` segments removed, root kept. */
function entryOf(path: string): string {
  const { root } = parse(path)
  const tail = sep === '\\' ? /(?:[\\/]+|[\\/]\.)$/ : /(?:\/+|\/\.)$/
  let entry = path
  for (;;) {
    const trimmed = entry.replace(tail, '')
    if (trimmed === entry || trimmed.length < root.length) return entry
    entry = trimmed
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code
}
