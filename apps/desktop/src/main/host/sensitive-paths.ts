/** Spec 05 §硬链接、保护名单与选文件夹: rebuild targets from the shared list, without content reads. */
import { lstat, readdir, readlink, realpath, stat as followedStat } from 'node:fs/promises'
import { posix } from 'node:path'
import { absolutePath, foldCase } from '@tenon-app/kernel'
import type { AbsolutePath, PathScope } from '@tenon-app/kernel'
import { credentialPaths, protectionList, walkLinks } from './sandbox-config.js'
import type { PathPorts, SandboxPlatform } from './sandbox-config.js'

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
        if (stat.isSymbolicLink()) links.set(needed, await readlink(needed))
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

export async function desktopSensitivePaths(
  home: AbsolutePath,
  roots: readonly AbsolutePath[],
  zdotdir: AbsolutePath | null = null,
  platform: SandboxPlatform = process.platform === 'darwin' ? 'darwin' : 'linux',
  options: SensitivePathScanOptions = {},
): Promise<NonNullable<PathScope['sensitive']>> {
  const timeoutMs = options.timeoutMs ?? 5000
  const deadline = Date.now() + timeoutMs
  let failure: Error | undefined
  let entries = 0
  const check = () => {
    if (failure !== undefined) throw failure
    if (options.signal?.aborted || Date.now() >= deadline) {
      failure = new Error('sensitive path scan aborted or timed out')
      throw failure
    }
  }
  const consume = (count: number) => {
    check()
    entries += count
    if (entries > (options.maxEntries ?? 100_000)) {
      failure = new Error('sensitive path scan exceeded its entry budget')
      throw failure
    }
  }
  let abort: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = new Promise<never>((_, reject) => {
    abort = () => {
      failure = new Error('sensitive path scan aborted or timed out')
      reject(failure)
    }
    timer = setTimeout(abort, timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
  })
  try {
    check()
    return await Promise.race([
      scanSensitivePaths(home, roots, zdotdir, platform, check, consume),
      stopped,
    ])
  } finally {
    clearTimeout(timer)
    if (abort !== undefined) options.signal?.removeEventListener('abort', abort)
  }
}

/** Local discovery limits: an incomplete table must never be published to the kernel. */
interface SensitivePathScanOptions {
  readonly timeoutMs?: number
  readonly maxEntries?: number
  readonly signal?: AbortSignal
}

async function scanSensitivePaths(
  home: AbsolutePath,
  roots: readonly AbsolutePath[],
  zdotdir: AbsolutePath | null,
  platform: SandboxPlatform,
  check: () => void,
  consume: (count: number) => void,
): Promise<NonNullable<PathScope['sensitive']>> {
  const target = targetResolver(check)
  const list = protectionList({ home, zdotdir, credentials: credentialPaths(platform, home) })
  const credential = [
    ...list.credential,
    ...roots.map((root) => absolutePath(posix.join(root, '.aws'))),
  ]
  const candidates = new Map<string, 'credential' | 'auto-run'>()
  const listings = new Map<string, Promise<string[]>>()
  const names = (dir: string): Promise<string[]> => {
    let work = listings.get(dir)
    if (work === undefined) {
      check()
      work = readdir(dir)
        .catch(() => [])
        .then((entries) => {
          consume(entries.length)
          return entries
        })
      listings.set(dir, work)
    }
    return work
  }
  const addPattern = async (
    anchor: string,
    pattern: string,
    category: 'credential' | 'auto-run',
  ): Promise<void> => {
    let paths = [anchor]
    for (const segment of pattern.split('/').filter(Boolean)) {
      const next: string[] = []
      for (const parent of paths) {
        // oxlint-disable-next-line no-await-in-loop -- expand actual folded spellings one pattern level at a time
        const actual = (await names(parent)).filter((name) => foldCase(name) === foldCase(segment))
        for (const name of new Set([segment, ...actual])) next.push(posix.join(parent, name))
      }
      paths = next
    }
    for (const path of paths)
      if (category === 'credential' || !candidates.has(path)) candidates.set(path, category)
  }
  for (const path of list.credential) {
    // oxlint-disable-next-line no-await-in-loop -- credential spellings may themselves be directory aliases
    await addPattern(home, posix.relative(home, path), 'credential')
  }
  for (const path of list.homeAutoRun) {
    // oxlint-disable-next-line no-await-in-loop -- same source and fold as the sandbox names
    await addPattern(home, posix.relative(home, path), 'auto-run')
  }
  for (const root of roots) {
    // oxlint-disable-next-line no-await-in-loop -- workspace-root .aws is a credential, before auto-run matching
    await addPattern(root, '.aws', 'credential')
  }
  const credentialTargets: string[] = []
  for (const [path, category] of candidates) {
    if (category !== 'credential') continue
    // oxlint-disable-next-line no-await-in-loop -- avoid traversing credentials even through an ordinary alias
    const real = await target(path)
    if (real !== undefined) credentialTargets.push(real)
  }
  const visited = new Set<string>()
  const discover = async (dir: string): Promise<void> => {
    check()
    let real: string
    try {
      real = await realpath(dir)
    } catch {
      check()
      return
    }
    check()
    if (
      visited.has(real) ||
      credentialTargets.some((root) => real === root || real.startsWith(root + '/'))
    )
      return
    visited.add(real)
    for (const name of list.autoRunNames) {
      // oxlint-disable-next-line no-await-in-loop -- include the real spelling of intermediate and final pattern levels
      await addPattern(dir, name, 'auto-run')
    }
    for (const name of await names(dir)) {
      const path = posix.join(dir, name)
      let directory = false
      try {
        // oxlint-disable-next-line no-await-in-loop -- follow directory aliases with a real-directory cycle guard
        directory = (await followedStat(path)).isDirectory()
      } catch {
        check()
        continue
      }
      check()
      // oxlint-disable-next-line no-await-in-loop -- aliases may expose nested sensitive entries outside the original root
      if (directory) await discover(path)
    }
  }
  for (const root of roots) {
    // oxlint-disable-next-line no-await-in-loop -- roots are user-accepted folders
    await discover(root)
  }
  const linkTargets: NonNullable<PathScope['sensitive']>['linkTargets'][number][] = []
  for (const [path, category] of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- resolve the same shared patterns as the sandbox
    const real = await target(path)
    if (real !== undefined) linkTargets.push({ real, category })
  }
  return { credential, autoRunNames: list.autoRunNames, linkTargets }
}

/** A profile-local table, refreshed by workspace changes and snapshot listings, not every tool. */
export function createSensitivePathProvider(
  home: AbsolutePath,
  zdotdir: AbsolutePath | null = null,
  options: SensitivePathScanOptions = {},
) {
  type Table = NonNullable<PathScope['sensitive']>
  const tables = new Map<string, Table>()
  const pending = new Map<string, Promise<Table>>()
  const failures = new Map<string, unknown>()
  const refresh = (roots: readonly AbsolutePath[]): Promise<Table> => {
    const key = JSON.stringify(roots)
    const running = pending.get(key)
    if (running !== undefined) return running
    const work = desktopSensitivePaths(home, roots, zdotdir, undefined, options).then(
      (table) => {
        tables.set(key, table)
        failures.delete(key)
        return table
      },
      (error: unknown) => {
        failures.set(key, error)
        throw error
      },
    )
    pending.set(key, work)
    void work
      .finally(() => {
        if (pending.get(key) === work) pending.delete(key)
      })
      .catch(() => {})
    return work
  }
  return {
    refresh,
    get: async (roots: readonly AbsolutePath[]): Promise<Table> => {
      const key = JSON.stringify(roots)
      if (failures.has(key)) throw failures.get(key)
      return tables.get(key) ?? refresh(roots)
    },
  }
}
