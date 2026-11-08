/** Git metadata discovery for auto-tier-hardening §规矩 1–3 and §不完整时. */
import { posix } from 'node:path'
import type { AbsolutePath } from '@tenon-app/kernel'

export interface GitDiscoveryPorts {
  readonly lstat: (p: string) => Promise<{ kind: 'file' | 'dir' | 'link' | 'other' } | null>
  readonly readdir: (p: string) => Promise<readonly string[]>
  readonly readText: (p: string, maxBytes: number) => Promise<string | null>
  readonly realpath: (p: string) => Promise<string | null>
}

export interface GitProtection {
  readonly redirectExisting: readonly AbsolutePath[]
  readonly redirectAbsent: readonly AbsolutePath[]
  // Filled by the hooksPath stage; this stage protects only git's own redirect entries.
  readonly hookDirs: readonly AbsolutePath[]
  readonly hookNames: readonly string[]
  readonly fallbackDeny: readonly AbsolutePath[]
  readonly incomplete: boolean
}

const REDIRECT_NAMES = ['config', 'config.worktree', 'commondir', 'hooks'] as const
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_ENTRIES = 4096
const MAX_DEPTH = 32

/** No subprocesses or cross-wrap cache; ports preserve realpath's component-by-component lookup. */
export async function discoverGitProtection(
  q: {
    readonly root: AbsolutePath
    readonly home: AbsolutePath
    readonly xdgConfigHome: string | null
    readonly platform: 'darwin' | 'linux'
  },
  ports: GitDiscoveryPorts,
): Promise<GitProtection> {
  const existing = new Set<AbsolutePath>()
  const absent = new Set<AbsolutePath>()
  const fallback = new Set<AbsolutePath>()
  let incomplete = false
  let remaining = MAX_ENTRIES
  const seen = new Set<string>()
  const queue: { path: string; container: boolean; depth: number; rootMetadata: boolean }[] = []
  const git = `${q.root}/.git`

  // One failed read must not discard the other paths already discovered (notably commondir).
  async function attempt<T>(read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read()
    } catch {
      incomplete = true
      return undefined
    }
  }

  async function actual(path: string) {
    const real = await ports.realpath(path)
    if (real === null) return null
    const stat = await ports.lstat(real)
    return stat === null ? null : { real: real as AbsolutePath, kind: stat.kind }
  }

  async function redirect(path: string): Promise<void> {
    const found = await actual(path)
    if (found === null) absent.add(path as AbsolutePath)
    else {
      existing.add(path as AbsolutePath)
      existing.add(found.real)
    }
  }

  async function directory(path: string, rootMetadata: boolean): Promise<string> {
    const found = await actual(path)
    if (found?.kind !== 'dir') throw new Error('git directory does not resolve')
    if (rootMetadata) fallback.add(found.real)
    return found.real
  }

  const root = await attempt(async () => {
    const entry = await ports.lstat(git)
    if (entry === null) return null
    const found = await actual(git)
    if (found === null) throw new Error('git entry does not resolve')
    fallback.add(found.real)
    if (found.kind === 'dir') return { path: found.real, pointer: false }
    if (found.kind !== 'file') throw new Error('git entry is not a file or directory')
    existing.add(git as AbsolutePath)
    existing.add(found.real)
    const text = await ports.readText(git, MAX_TEXT_BYTES)
    const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(text ?? '')
    if (match?.[1] === undefined) throw new Error('git pointer cannot be parsed')
    const target = await directory(relativeTo(q.root, match[1]), true)
    return { path: target, pointer: true }
  })
  if (root != null) {
    queue.push({ path: root.path, container: false, depth: 0, rootMetadata: root.pointer })
  }

  // Breadth first, bounded both by entry count and depth; never walk object stores or worktrees.
  while (queue.length > 0) {
    const item = queue.shift()!
    // oxlint-disable-next-line no-await-in-loop -- bounded metadata traversal with shared budget
    await attempt(async () => {
      if (--remaining < 0 || item.depth > MAX_DEPTH)
        throw new Error('git discovery budget exceeded')
      if (item.container && (await actual(item.path)) === null) return
      const dir = await directory(item.path, item.rootMetadata)
      const key = `${item.container}:${dir}`
      if (seen.has(key)) return
      seen.add(key)
      if (item.container) {
        const names = await ports.readdir(dir)
        if (names.length > remaining) throw new Error('git directory enumeration budget exceeded')
        remaining -= names.length
        for (const name of names) {
          // oxlint-disable-next-line no-await-in-loop -- bounded metadata traversal
          await attempt(async () => {
            const path = `${dir}/${name}`
            const child = await actual(path)
            if (child?.kind !== 'dir') return
            const isGit =
              (await actual(`${path}/HEAD`)) !== null || (await actual(`${path}/config`)) !== null
            queue.push({ path, container: !isGit, depth: item.depth + 1, rootMetadata: false })
          })
        }
        return
      }

      await Promise.all(REDIRECT_NAMES.map((name) => attempt(() => redirect(`${dir}/${name}`))))
      // Resolve common metadata before reading config, so an unreadable config cannot hide it.
      await attempt(async () => {
        const text = await ports.readText(`${dir}/commondir`, MAX_TEXT_BYTES)
        if (text === null) return
        const target = text.trimEnd()
        if (target.length === 0 || /[\r\n\0]/.test(target)) throw new Error('invalid commondir')
        const path = await directory(relativeTo(dir, target), item.rootMetadata)
        queue.push({
          path,
          container: false,
          depth: item.depth + 1,
          rootMetadata: item.rootMetadata,
        })
      })
      await Promise.all(
        ['config', 'config.worktree'].map((name) =>
          attempt(() => ports.readText(`${dir}/${name}`, MAX_TEXT_BYTES)),
        ),
      )
      for (const name of ['modules', 'worktrees']) {
        queue.push({
          path: `${dir}/${name}`,
          container: true,
          depth: item.depth + 1,
          rootMetadata: false,
        })
      }
    })
  }

  return {
    redirectExisting: [...existing],
    redirectAbsent: [...absent],
    hookDirs: [],
    hookNames: [],
    fallbackDeny: incomplete ? [...fallback] : [],
    incomplete,
  }
}

/** Keep `..` for realpath: folding it before following a link can select a different directory. */
function relativeTo(base: string, path: string): string {
  return posix.isAbsolute(path) ? path : `${base}/${path}`
}
