/** Shared git metadata and hook discovery for auto-tier-hardening. */
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
  readonly hookDirs: readonly AbsolutePath[]
  readonly hookNames: readonly string[]
  readonly fallbackDeny: readonly AbsolutePath[]
  readonly incomplete: boolean
}

const REDIRECT_NAMES = ['config', 'config.worktree', 'commondir', 'hooks'] as const
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_ENTRIES = 4096
const MAX_DEPTH = 32

/** Fixed names, even in a workspace without git metadata. */
export const GIT_HOOK_NAMES: readonly string[] = [
  '.husky',
  '.lefthook',
  '.lefthook-local',
  '.pre-commit-config.yaml',
  ...[
    'lefthook.yml',
    '.lefthook.yml',
    'lefthook.yaml',
    '.lefthook.yaml',
    'lefthook.toml',
    'lefthook.json',
  ].flatMap((name) => [name, name.replace('lefthook', 'lefthook-local')]),
]

class DiscoveryError extends Error {
  constructor(path: string, reason: string) {
    super(`${JSON.stringify(path)}: ${reason}`)
  }
}

/** No subprocesses or cross-wrap cache; ports preserve realpath's component-by-component lookup. */
export async function discoverGitProtection(
  q: {
    readonly root: AbsolutePath
    readonly home: AbsolutePath
    readonly xdgConfigHome: string | null
    readonly platform: 'darwin' | 'linux'
  },
  ports: GitDiscoveryPorts,
  diagnostic?: (message: string) => void,
): Promise<GitProtection> {
  const existing = new Set<AbsolutePath>()
  const absent = new Set<AbsolutePath>()
  const fallback = new Set<AbsolutePath>()
  const hookDirs = new Set<AbsolutePath>()
  const configSeen = new Set<string>()
  let configRemaining = MAX_ENTRIES
  let incomplete = false
  let remaining = MAX_ENTRIES
  const seen = new Set<string>()
  const queue: {
    path: string
    container: boolean
    depth: number
    rootMetadata: boolean
    hooksConfig: boolean
  }[] = []
  const git = `${q.root}/.git`

  // One failed read must not discard the other paths already discovered (notably commondir).
  async function attempt<T>(read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read()
    } catch (error) {
      incomplete = true
      if (error instanceof DiscoveryError) diagnostic?.(error.message)
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
    else existing.add(path as AbsolutePath)
  }

  async function directory(path: string, rootMetadata: boolean): Promise<string> {
    const found = await actual(path)
    if (found?.kind !== 'dir') throw new DiscoveryError(path, 'git target is not a directory')
    if (rootMetadata) fallback.add(path as AbsolutePath)
    return found.real
  }

  function configPath(base: string, value: string, source: string): string {
    if (value === '~') return q.home
    if (value.startsWith('~/')) return `${q.home}/${value.slice(2)}`
    if (value.startsWith('~') || value.startsWith('%(') || /[\0\r\n]/.test(value))
      throw new DiscoveryError(source, 'hooksPath/include path cannot be resolved')
    return relativeTo(base, value)
  }

  async function readConfig(path: string, depth = 0): Promise<void> {
    if (depth > MAX_DEPTH || --configRemaining < 0)
      throw new DiscoveryError(path, 'git config include budget/depth exceeded')
    const real = await ports.realpath(path)
    // Includes are git configuration sources too; preserve each existing spelling for deny rules.
    if (depth > 0 && real !== null) existing.add(path as AbsolutePath)
    if (real !== null && configSeen.has(real)) return
    const text = await ports.readText(path, MAX_TEXT_BYTES)
    if (text === null) return
    if (real === null) throw new DiscoveryError(path, 'git config cannot be resolved')
    configSeen.add(real)
    let entries: { section: string; key: string; value: string }[]
    try {
      entries = configEntries(text)
    } catch {
      throw new DiscoveryError(path, 'git config/hooksPath cannot be parsed')
    }
    for (const entry of entries) {
      // Keep all configured paths, including conditional includes whose condition is false now.
      if (entry.section === 'core' && entry.key === 'hookspath') {
        if (entry.value === '') continue
        const target = configPath(q.root, entry.value, path) as AbsolutePath
        // A missing directory stays protected, but files/devices (notably /dev/null) run no hooks.
        // oxlint-disable-next-line no-await-in-loop -- resolve each configured hook directory once
        const found = await actual(target)
        if (found !== null && found.kind !== 'dir') continue
        hookDirs.add(target)
        if (target.replace(/\/+$/, '').endsWith('/.husky/_'))
          hookDirs.add(posix.dirname(target) as AbsolutePath)
      } else if (['include', 'includeif'].includes(entry.section) && entry.key === 'path') {
        // oxlint-disable-next-line no-await-in-loop -- bounded include traversal in config order
        await attempt(() =>
          readConfig(configPath(posix.dirname(path), entry.value, path), depth + 1),
        )
      }
    }
  }

  const root = await attempt(async () => {
    const entry = await ports.lstat(git)
    if (entry === null) return null
    const found = await actual(git)
    if (found === null) throw new DiscoveryError(git, 'git entry does not resolve')
    fallback.add(git as AbsolutePath)
    if (found.kind === 'dir') return { path: git, pointer: false }
    if (found.kind !== 'file') throw new DiscoveryError(git, 'git entry is not a file or directory')
    existing.add(git as AbsolutePath)
    const text = await ports.readText(git, MAX_TEXT_BYTES)
    const match = /^gitdir: ([^\r\n\0]+)$/.exec(stripLineEndings(text ?? ''))
    if (match?.[1] === undefined) throw new DiscoveryError(git, 'git pointer cannot be parsed')
    const target = relativeTo(q.root, match[1])
    await directory(target, true)
    return { path: target, pointer: true }
  })
  if (root != null) {
    queue.push({
      path: root.path,
      container: false,
      depth: 0,
      rootMetadata: root.pointer,
      hooksConfig: true,
    })
  }

  // Breadth first, bounded both by entry count and depth; never walk object stores or worktrees.
  while (queue.length > 0) {
    const item = queue.shift()!
    // oxlint-disable-next-line no-await-in-loop -- bounded metadata traversal with shared budget
    await attempt(async () => {
      if (--remaining < 0 || item.depth > MAX_DEPTH)
        throw new DiscoveryError(item.path, 'git discovery budget/depth exceeded')
      if (item.container && (await actual(item.path)) === null) return
      const real = await directory(item.path, item.rootMetadata)
      const dir = item.path
      const key = `${item.container}:${item.hooksConfig}:${real}`
      if (seen.has(key)) return
      seen.add(key)
      if (item.container) {
        const names = await ports.readdir(real)
        if (names.length > remaining)
          throw new DiscoveryError(item.path, 'git directory enumeration budget exceeded')
        remaining -= names.length
        for (const name of names) {
          // oxlint-disable-next-line no-await-in-loop -- bounded metadata traversal
          await attempt(async () => {
            const path = `${dir}/${name}`
            const child = await actual(path)
            if (child?.kind !== 'dir') return
            const isGit =
              (await actual(`${path}/HEAD`)) !== null || (await actual(`${path}/config`)) !== null
            queue.push({
              path,
              container: !isGit,
              depth: item.depth + 1,
              rootMetadata: false,
              hooksConfig: false,
            })
          })
        }
        return
      }

      await Promise.all(REDIRECT_NAMES.map((name) => attempt(() => redirect(`${dir}/${name}`))))
      // Resolve common metadata before reading config, so an unreadable config cannot hide it.
      await attempt(async () => {
        const text = await ports.readText(`${real}/commondir`, MAX_TEXT_BYTES)
        if (text === null) return
        const target = stripLineEndings(text)
        if (target.length === 0 || /[\r\n\0]/.test(target))
          throw new DiscoveryError(`${real}/commondir`, 'invalid commondir')
        const path = relativeTo(dir, target)
        await directory(path, item.rootMetadata)
        queue.push({
          path,
          container: false,
          depth: item.depth + 1,
          rootMetadata: item.rootMetadata,
          hooksConfig: item.hooksConfig,
        })
      })
      await Promise.all(
        ['config', 'config.worktree'].map((name) =>
          attempt(async () => {
            if (item.hooksConfig) await readConfig(`${real}/${name}`)
            else await ports.readText(`${real}/${name}`, MAX_TEXT_BYTES)
          }),
        ),
      )
      for (const name of ['modules', 'worktrees']) {
        queue.push({
          path: `${dir}/${name}`,
          container: true,
          depth: item.depth + 1,
          rootMetadata: false,
          hooksConfig: false,
        })
      }
    })
  }

  const xdg =
    q.xdgConfigHome !== null && posix.isAbsolute(q.xdgConfigHome)
      ? q.xdgConfigHome
      : `${q.home}/.config`
  await Promise.all(
    [`${xdg}/git/config`, `${q.home}/.gitconfig`].map((path) => attempt(() => readConfig(path))),
  )

  return {
    redirectExisting: [...existing],
    redirectAbsent: [...absent],
    hookDirs: [...hookDirs],
    hookNames: GIT_HOOK_NAMES,
    fallbackDeny: incomplete ? [...fallback] : [],
    incomplete,
  }
}

/** Git strips trailing CR/LF, but spaces and tabs are part of a metadata path. */
function stripLineEndings(text: string): string {
  return text.replace(/[\r\n]+$/, '')
}

/** Keep `..` for realpath: folding it before following a link can select a different directory. */
function relativeTo(base: string, path: string): string {
  return posix.isAbsolute(path) ? path : `${base}/${path}`
}

/** Git's quoted values, comments and continuations; never evaluate conditions or shell text. */
function configEntries(text: string): { section: string; key: string; value: string }[] {
  const entries: { section: string; key: string; value: string }[] = []
  let section = ''
  let pending = ''
  for (const physical of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = pending + physical
    let inQuote = false
    // A comment's trailing backslash does not continue onto (and hide) the next section.
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') i++
      else if (line[i] === '"') inQuote = !inQuote
      else if (!inQuote && (line[i] === '#' || line[i] === ';')) {
        line = line.slice(0, i)
        break
      }
    }
    if ((/\\+$/.exec(line)?.[0].length ?? 0) % 2 === 1) {
      pending = line.slice(0, -1)
      continue
    }
    pending = ''
    let trimmed = line.trim()
    if (trimmed === '' || /^[#;]/.test(trimmed)) continue
    if (trimmed.startsWith('[')) {
      const header = /^\[([\w-]+)(\s+"(?:[^"\\]|\\.)*"|\.[^\]]+)?\](.*)$/.exec(trimmed)
      if (header === null) throw new Error('invalid git section')
      const name = header[1]!.toLowerCase()
      section = name === 'includeif' || header[2] === undefined ? name : `${name}.subsection`
      trimmed = header[3]!.trim()
      if (trimmed === '') continue
    }
    const pair = /^([a-z][a-z0-9-]*)(?:\s*=\s*(.*)|\s*(?:[#;].*)?)$/i.exec(trimmed)
    if (pair === null || section === '') throw new Error('invalid git variable')
    const key = pair[1]!.toLowerCase()
    if (
      !(section === 'core' && key === 'hookspath') &&
      !(['include', 'includeif'].includes(section) && key === 'path')
    )
      continue
    if (pair[2] === undefined) throw new Error('path needs a value')
    let value = ''
    let spaces = ''
    let quoted = false
    const source = pair[2]
    for (let i = 0; i < source.length; i++) {
      let char = source[i]!
      if (char === '"') {
        quoted = !quoted
        continue
      }
      if (!quoted && (char === '#' || char === ';')) break
      if (char === '\\') {
        const escape = source[++i]
        const escapes: Record<string, string> = { n: '\n', t: '\t', b: '\b', '\\': '\\', '"': '"' }
        if (escape === undefined || escapes[escape] === undefined) throw new Error('invalid escape')
        char = escapes[escape]!
      } else if (!quoted && /\s/.test(char)) {
        spaces += char
        continue
      }
      value += spaces + char
      spaces = ''
    }
    if (quoted) throw new Error('unclosed git value')
    entries.push({ section, key, value })
  }
  if (pending !== '') throw new Error('unfinished git continuation')
  return entries
}
