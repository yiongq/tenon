/**
 * A HostFs with a volfs, as macOS has one: `/.vol/1/<n>` reaches a file or folder by number, the way
 * `/.vol/<dev>/<ino>` reaches it by inode, and realpath cannot name it — it throws
 * `UnresolvableAliasError`, as DesktopFs does (spec 02 §`HostFs.realpath`; owner 2026-09-27). Every
 * other path, and every other method, is the wrapped fs's. apps/desktop/test/volfs.test.ts is the same
 * on the real disk.
 */
import { UnresolvableAliasError, absolutePath } from '../../src/index.js'
import type { AbsolutePath, HostFs } from '../../src/index.js'

const VOLFS = /^\/\.vol\/1\/(\d+)(?=\/|$)/

/** `fs` with `/.vol/1/<n>` naming `numbered[n]`. */
export function withVolfs(fs: HostFs, numbered: Readonly<Record<string, string>>): HostFs {
  const reached = (path: AbsolutePath): AbsolutePath => {
    const match = VOLFS.exec(path)
    const target = match === null ? undefined : numbered[match[1] ?? '']
    return target === undefined ? path : absolutePath(target + path.slice(match?.[0].length))
  }
  return {
    readFile: (path, opts) => fs.readFile(reached(path), opts),
    writeFile: (path, data) => fs.writeFile(reached(path), data),
    stat: (path) => fs.stat(reached(path)),
    readdir: (path) => fs.readdir(reached(path)),
    mkdirp: (path) => fs.mkdirp(reached(path)),
    async realpath(path) {
      const target = reached(path)
      const real = await fs.realpath(target)
      // Missing is missing under any name; found through a number, there is no name to give.
      if (real === null || target === path) return real
      throw new UnresolvableAliasError(path)
    },
  }
}
