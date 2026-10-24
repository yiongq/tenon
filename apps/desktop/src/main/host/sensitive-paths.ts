/** Spec 05: discover sensitive links by name without traversing directory links or excluded trees. */
import { lstat, readdir, readlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { posix } from 'node:path'
import { absolutePath, foldCase } from '@tenon-app/kernel'
import type { AbsolutePath, PathScope } from '@tenon-app/kernel'
import { credentialPaths, protectionList, walkLinks } from './sandbox-config.js'
import type { PathPorts, SandboxPlatform } from './sandbox-config.js'
import { DesktopFs } from './fs.js'
import { DEFAULT_EXCLUDES, errno } from './snapshot-storage.js'

type Category = 'credential' | 'auto-run'
export type SensitiveTable = NonNullable<PathScope['sensitive']> & {
  readonly incomplete: boolean
  readonly diagnostic: string | null
}
interface SensitivePathScanOptions {
  readonly timeoutMs?: number
  readonly maxEntries?: number
  readonly signal?: AbortSignal
}

/** Resolve through walkLinks itself; collect async metadata first so main never blocks on sync IO. */
function targetResolver(check: () => void) {
  const stats = new Map<string, Awaited<ReturnType<typeof lstat>> | undefined>()
  const links = new Map<string, string>()
  return async (path: string): Promise<AbsolutePath | undefined> => {
    const ports: Pick<PathPorts, 'lstat' | 'readlink'> = {
      lstat: (node) => {
        if (!stats.has(node)) throw node
        return stats.get(node)
      },
      readlink: (node) => {
        const value = links.get(node)
        if (value === undefined) throw node
        return value
      },
    }
    // Each pass requests the next unknown level; missing entries are recorded, loops stay bounded.
    for (let count = 0; count < 4096; count++) {
      check()
      let needed: string | undefined
      const walk = walkLinks(path, {
        lstat: (node) => {
          if (!stats.has(node)) needed = node
          return ports.lstat(node)
        },
        readlink: ports.readlink,
      })
      if (needed === undefined) return walk.real === undefined ? undefined : absolutePath(walk.real)
      try {
        // oxlint-disable-next-line no-await-in-loop -- walkLinks requests one unknown path level at a time
        const stat = await lstat(needed)
        check()
        stats.set(needed, stat)
        // oxlint-disable-next-line no-await-in-loop -- link text is metadata, never target content
        if (stat.isSymbolicLink()) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- a removed link is not a missing future target
            links.set(needed, await readlink(needed))
          } catch {
            return undefined
          }
        }
      } catch (error) {
        check()
        if (
          typeof error === 'object' &&
          error !== null &&
          ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          stats.set(needed, undefined)
        else return undefined
      }
    }
    return undefined
  }
}

/** Same realpath spelling as DesktopFs, retaining the suffix of a not-yet-created target. */
async function canonical(path: string): Promise<AbsolutePath | undefined> {
  let ancestor = path
  const suffix: string[] = []
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- canonicalize the deepest existing ancestor
      const real = await new DesktopFs().realpath(absolutePath(ancestor))
      if (real !== null) return absolutePath(posix.join(real, ...suffix.toReversed()))
    } catch (error) {
      if (!errno(error, 'ENOENT') && !errno(error, 'ENOTDIR')) return undefined
    }
    const parent = posix.dirname(ancestor)
    if (parent === ancestor) return undefined
    suffix.push(posix.basename(ancestor))
    ancestor = parent
  }
}
function baseTable(
  home: AbsolutePath,
  roots: readonly AbsolutePath[],
  zdotdir: AbsolutePath | null,
  platform: SandboxPlatform,
): SensitiveTable {
  const list = protectionList({ home, zdotdir, credentials: credentialPaths(platform, home) })
  return {
    credential: [
      ...list.credential,
      ...roots.map((root) => absolutePath(posix.join(root, '.aws'))),
    ],
    autoRunNames: list.autoRunNames,
    linkTargets: [],
    incomplete: true,
    diagnostic: 'Sensitive link targets have not been scanned',
  }
}

export async function desktopSensitivePaths(
  home: AbsolutePath,
  roots: readonly AbsolutePath[],
  zdotdir: AbsolutePath | null = null,
  platform: SandboxPlatform = process.platform === 'darwin' ? 'darwin' : 'linux',
  options: SensitivePathScanOptions = {},
): Promise<SensitiveTable> {
  const base = baseTable(home, roots, zdotdir, platform)
  const list = protectionList({ home, zdotdir, credentials: credentialPaths(platform, home) })
  const credentials = new Map<string, Category>()
  const workspaceTargets = new Map<string, Category>()
  let failure: string | null = null
  let count = 0
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  const check = () => {
    if (failure !== null) throw new Error(failure)
    if (options.signal?.aborted || Date.now() >= deadline)
      throw new Error('Sensitive link scan aborted or timed out')
  }
  const resolve = targetResolver(check)
  const add = async (map: Map<string, Category>, path: string, category: Category) => {
    check()
    const resolved = await resolve(path)
    const target = resolved === undefined ? undefined : await canonical(resolved)
    check()
    if (target !== undefined && (category === 'credential' || !map.has(target)))
      map.set(target, category)
  }
  // A small, fixed set of home patterns; follow only matching spelling levels, never their contents.
  const homePattern = async (pattern: string, category: Category) => {
    let paths = [home as string]
    for (const segment of pattern.split('/')) {
      const next: string[] = []
      for (const parent of paths) {
        check()
        // oxlint-disable-next-line no-await-in-loop -- match each actual folded spelling of this fixed pattern
        const names = await readdir(parent).catch((error: unknown) => {
          if (errno(error, 'ENOENT') || errno(error, 'ENOTDIR')) return []
          throw error
        })
        for (const name of new Set([
          segment,
          ...names.filter((candidate) => foldCase(candidate) === foldCase(segment)),
        ]))
          next.push(posix.join(parent, name))
      }
      paths = next
    }
    for (const path of paths) {
      // oxlint-disable-next-line no-await-in-loop -- only fixed credential/home startup names are resolved
      await add(credentials, path, category)
    }
  }
  const scan = async () => {
    for (const path of list.credential) {
      // oxlint-disable-next-line no-await-in-loop -- establish known credential targets before scanning workspaces
      await homePattern(posix.relative(home, path), 'credential')
    }
    for (const path of list.homeAutoRun) {
      // oxlint-disable-next-line no-await-in-loop -- the same fixed home startup names as the sandbox
      await homePattern(posix.relative(home, path), 'auto-run')
    }
    const patterns = list.autoRunNames.map((name) => ({
      parts: name.split('/').map(foldCase),
      category: 'auto-run' as Category,
    }))
    const excluded = new Set<string>(DEFAULT_EXCLUDES)
    const privateRoots = () =>
      [
        ...base.credential,
        ...[...credentials]
          .filter(([, category]) => category === 'credential')
          .map(([path]) => path),
      ].map(foldCase)
    const privatePath = (path: string) => {
      const folded = foldCase(path)
      return privateRoots().some((root) => folded === root || folded.startsWith(`${root}/`))
    }
    const rootChildren = new Map<AbsolutePath, Dirent[]>()
    // A later workspace can name credentials inside an earlier one. Resolve every fixed root
    // credential alias first, before entering any ordinary child of any workspace.
    for (const root of roots) {
      check()
      // oxlint-disable-next-line no-await-in-loop -- never follow a replaced workspace root
      const stat = await lstat(root)
      if (!stat.isDirectory() || stat.isSymbolicLink() || privatePath(root)) continue
      // oxlint-disable-next-line no-await-in-loop -- retain Dirent semantics and reuse this listing during discovery
      const children = await readdir(root, { withFileTypes: true })
      rootChildren.set(root, children)
      for (const child of children)
        if (child.isSymbolicLink() && foldCase(child.name) === '.aws')
          // oxlint-disable-next-line no-await-in-loop -- the one fixed workspace credential name
          await add(credentials, posix.join(root, child.name), 'credential')
    }
    const discover = async (dir: string) => {
      check()
      // lstat/Dirent semantics: never enter a directory alias, even when it leads back inside.
      const children =
        rootChildren.get(absolutePath(dir)) ?? (await readdir(dir, { withFileTypes: true }))
      count += children.length
      if (count > (options.maxEntries ?? 100_000))
        throw new Error('Sensitive link scan exceeded its entry budget')
      for (const child of children) {
        check()
        const path = posix.join(dir, child.name)
        if (child.isSymbolicLink()) {
          for (const { parts, category } of patterns) {
            for (let i = 0; i < parts.length; i++) {
              if (foldCase(child.name) !== parts[i]) continue
              // Include the remainder: .claude -> conf protects conf/settings.json, not all of conf.
              // oxlint-disable-next-line no-await-in-loop -- resolve only matching link names and their remaining segments
              await add(workspaceTargets, posix.join(path, ...parts.slice(i + 1)), category)
            }
          }
        } else if (child.isDirectory() && !excluded.has(child.name) && !privatePath(path)) {
          // oxlint-disable-next-line no-await-in-loop -- ordinary workspace directories only, no link traversal
          await discover(path)
        }
      }
    }
    for (const root of roots) {
      check()
      // oxlint-disable-next-line no-await-in-loop -- never follow a root replaced by a directory link
      if (rootChildren.has(root) && !privatePath(root)) await discover(root)
    }
  }
  let abort: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Sensitive link scan aborted or timed out'))
    timer = setTimeout(abort, options.timeoutMs ?? 5000)
    options.signal?.addEventListener('abort', abort, { once: true })
  })
  try {
    check()
    await Promise.race([scan(), stopped])
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
    if (abort !== undefined) options.signal?.removeEventListener('abort', abort)
  }
  const targets = new Map(
    [...credentials].filter(([, category]) => failure === null || category === 'credential'),
  )
  if (failure === null)
    for (const [real, category] of workspaceTargets)
      if (category === 'credential' || !targets.has(real)) targets.set(real, category)
  return {
    ...base,
    linkTargets: [...targets].map(([real, category]) => ({ real: absolutePath(real), category })),
    incomplete: failure !== null,
    diagnostic: failure,
  }
}

/** Cached complete or incomplete tables; every explicit refresh retries discovery. */
export function createSensitivePathProvider(
  home: AbsolutePath,
  zdotdir: AbsolutePath | null = null,
  options: SensitivePathScanOptions = {},
) {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
  const tables = new Map<string, SensitiveTable>()
  const seenSessions = new Set<string>()
  const pending = new Map<string, Promise<SensitiveTable>>()
  const fallback = (roots: readonly AbsolutePath[]) => baseTable(home, roots, zdotdir, platform)
  const refresh = (roots: readonly AbsolutePath[]): Promise<SensitiveTable> => {
    const key = JSON.stringify(roots)
    const running = pending.get(key)
    if (running !== undefined) return running
    const work = desktopSensitivePaths(home, roots, zdotdir, platform, options).then((table) => {
      tables.set(key, table)
      return table
    })
    pending.set(key, work)
    void work
      .finally(() => {
        pending.delete(key)
      })
      .catch(() => {})
    return work
  }
  return {
    fallback,
    refresh,
    get: async (roots: readonly AbsolutePath[], sessionKey?: string) => {
      const key = JSON.stringify(roots)
      const visit = JSON.stringify([sessionKey, key])
      if (sessionKey !== undefined && !seenSessions.has(visit)) {
        seenSessions.add(visit)
        return refresh(roots)
      }
      return tables.get(key) ?? refresh(roots)
    },
  }
}
