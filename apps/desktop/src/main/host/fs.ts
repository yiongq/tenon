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
   * On macOS the data volume is also mounted at /System/Volumes/Data, and realpath(3) leaves that
   * spelling as it is: `/System/Volumes/Data/Users/u/.zshrc` is `/Users/u/.zshrc` under another name
   * (a firmlink), and compared as a string it would read as outside the protected list. A result under
   * that mount is given back in the root spelling when that path is the same file (same device and
   * inode), so one file has one real path (spec 02 §「在不在工作区里」 steps 2–3; D8).
   */
  async realpath(path: AbsolutePath): Promise<AbsolutePath | null> {
    absolutePath(path)
    try {
      return absolutePath(await rootSpelling(await realpath(path)))
    } catch (err) {
      if (!isErrno(err, 'ENOENT') && !isErrno(err, 'ENOTDIR')) throw err
      const entry = entryOf(path)
      try {
        await lstat(entry)
      } catch (lstatErr) {
        if (isErrno(lstatErr, 'ENOENT') || isErrno(lstatErr, 'ENOTDIR')) return null
        throw err
      }
      const followed = await stat(entry).then(
        () => true,
        () => false,
      )
      if (followed) throw new UnresolvableAliasError(path, { cause: err })
      throw err
    }
  }
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
