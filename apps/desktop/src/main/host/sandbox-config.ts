/**
 * The sandbox-runtime configuration Tenon hands srt (spec 04 §档位到 srt 配置; T5, T13, T14, T31,
 * T33, Q12, Q20; open question 5 A; 读法 20–22, 33, 34, 42, 43, 46, 47, 50, 53). Pure: every input is
 * explicit — platform, home, `ZDOTDIR`, profile dir, `<userData>/sandbox-cache`, the dir main chdirs
 * to at startup (null on the eval host), srt's package dir, the session's spill folder, the request's
 * profile and workspace, your profile, the preset switch, the credential list, the `no-seccomp`
 * posture, the effective allowlist and the helper and binary paths — and the disk is read only
 * through the injected `realpath`, `lstat` and `readlink`. Nothing here comes from the model or a
 * command.
 *
 * - `sessionConfig` is what `initialize` and `updateConfig` get: the network block, a filesystem block
 *   shaped like read-only's without `allowRead`, the helper paths, Linux's binaries, and on darwin
 *   the two noise lines of `ignoreViolations`.
 * - `wrapFilesystem` is one wrap's `customConfig.filesystem`, the environment variables the preset
 *   adds, the preset dirs to check, and the links passed resolving the deny entries (Linux records
 *   their `lstat` before the call and compares after it, step 4).
 *
 * Every path goes to srt as `{ path, literal: true }`; the only patterns are darwin's per-root
 * `<root>/**\/<name>` globs, left out for a root whose spelling holds `*?[]`. allowWrite and allowRead
 * get real paths only. A deny entry gets both its written spelling and where it leads, resolved as
 * the kernel resolves it with every link followed, a dangling one too; on darwin each link passed on
 * the way, those inside link targets included, joins denyWrite as itself — never denyRead, and never
 * on Linux — and an entry that is itself a link joins darwin's denyRead by where it leads only
 * (spec「链接」).
 * Each config carries only the listed keys and passes srt's `SandboxRuntimeConfigSchema` (srt itself
 * validates only its CLI's, and its schema is not strict).
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime'
import type {
  FilesystemConfig,
  FilesystemPathEntry,
  SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'
import type { AbsolutePath } from '@tenon-app/kernel'
import { PROTECTED_SHELL_FILES } from '../workspace.js'

export type SandboxPlatform = 'darwin' | 'linux'

export type RestrictedProfile = 'read-only' | 'workspace-write'

/** The disk, read only through these (spec「链接」: `realpath`, `lstat` and `readlink` are injected). */
export interface PathPorts {
  /** The real path; throws when the path or a link on its way does not resolve. */
  readonly realpath: (path: string) => string
  /** The entry itself, links not followed; undefined (or a throw) when nothing is there. */
  readonly lstat: (path: string) => { isSymbolicLink(): boolean } | undefined
  /** What a link holds, as written; throws when the path is no link. */
  readonly readlink: (path: string) => string
}

/** srt79's bound on following links (`MAX_SYMLINK_RESOLUTION_DEPTH`), the kernel's ELOOP. */
export const MAX_LINK_HOPS = 40

/** What walking a path the way the kernel resolves it found (`walkLinks`). */
export interface LinkWalk {
  /**
   * Where the path leads; undefined after a loop or more than `MAX_LINK_HOPS` links, or when a
   * level could not be looked at or a link not read.
   */
  readonly real: string | undefined
  /** Each link passed, once, named where it itself is: its directory's real path and its name. */
  readonly links: readonly string[]
}

/**
 * `path` resolved level by level from `/` as the kernel resolves it (spec「链接」): each link is
 * replaced by what it holds, a relative target read from the real path of the link's directory, a
 * dangling link followed all the same (as srt79's `resolveSymlinkedDenyPath`); from the first level
 * that is not there the rest is joined on as written. `followLast: false` leaves a link in the last
 * place as it is, as unlink and rename do. When the walk cannot finish, `links` still holds every
 * link passed so far. `stop` names levels not to be looked at: from the first one reached, the
 * rest is joined on as written.
 */
export function walkLinks(
  path: string,
  ports: Pick<PathPorts, 'lstat' | 'readlink'>,
  followLast = true,
  stop?: (node: string) => boolean,
): LinkWalk {
  const links = new Set<string>()
  const done = (real: string | undefined): LinkWalk => ({ real, links: [...links] })
  let at = '/'
  let rest = levels(path)
  let hops = 0
  while (rest.length > 0) {
    const [name = '', ...after] = rest
    rest = after
    if (name === '..') {
      at = posix.dirname(at)
      continue
    }
    const node = posix.join(at, name)
    if (stop?.(node) === true) return done(posix.join(node, ...rest))
    let stat: { isSymbolicLink(): boolean } | undefined
    try {
      stat = ports.lstat(node)
    } catch {
      return done(undefined)
    }
    if (stat === undefined) return done(posix.join(node, ...rest))
    if (!stat.isSymbolicLink() || (rest.length === 0 && !followLast)) {
      at = node
      continue
    }
    links.add(node)
    hops += 1
    if (hops > MAX_LINK_HOPS) return done(undefined)
    let target: string
    try {
      target = ports.readlink(node)
    } catch {
      return done(undefined)
    }
    if (target.startsWith('/')) at = '/'
    rest = [...levels(target), ...rest]
  }
  return done(at)
}

/** A path's levels, without empty ones and `.`. */
function levels(path: string): string[] {
  return path.split('/').filter((part) => part.length > 0 && part !== '.')
}

/** What every config is built from (spec §档位到 srt 配置). */
export interface SandboxHostPaths {
  readonly platform: SandboxPlatform
  readonly home: AbsolutePath
  /** `ZDOTDIR` when it has a value. */
  readonly zdotdir: AbsolutePath | null
  readonly profileDir: AbsolutePath
  /** `<userData>/sandbox-cache` (读法 46). */
  readonly cacheDir: AbsolutePath
  /** `<userData>/sandbox-cwd` when main chdirs there at startup; null on the eval host (读法 50). */
  readonly chdirDir: AbsolutePath | null
  /** srt's package dir, a real path (读法 34). */
  readonly srtPackageDir: AbsolutePath
  /** `credentialPaths(platform, home)`. */
  readonly credentials: readonly AbsolutePath[]
  /** The posture is `degraded`/`no-seccomp` (Linux only; 读法 42). */
  readonly noSeccomp: boolean
  /** For 读法 42: the user's uid and `XDG_RUNTIME_DIR` / `SSH_AUTH_SOCK` from main's environment. */
  readonly uid: number
  readonly xdgRuntimeDir: string | null
  readonly sshAuthSock: string | null
}

/** One item of the request's `workspace`, with what the host saw on disk. */
export interface WorkspaceRoot {
  readonly path: AbsolutePath
  /** A directory (a session folder); a path release is not one (读法 35). */
  readonly directory: boolean
  /** `<path>/.git` is a directory: on Linux the `.git` pair is denied only then. */
  readonly gitDirectory: boolean
}

export interface WrapFilesystemInput extends SandboxHostPaths {
  /** The request's profile. */
  readonly profile: RestrictedProfile
  /** Your profile in 「高级」. */
  readonly chosen: RestrictedProfile
  readonly workspace: readonly WorkspaceRoot[]
  /** This session's `tool-output/<sessionId>/`, or null. */
  readonly toolOutputDir: AbsolutePath | null
  /** The 「包管理器」 preset is on. */
  readonly packageManagers: boolean
}

/** srt's filesystem block cut to the four tables Tenon fills; no `disabled`, no `allowGitConfig` (读法 43). */
export type FilesystemTables = Pick<
  FilesystemConfig,
  'denyRead' | 'allowRead' | 'allowWrite' | 'denyWrite'
>

export interface WrapFilesystem {
  readonly filesystem: FilesystemTables
  /** Variables the wrap sets in the command's environment (读法 47); empty unless the preset is in effect. */
  readonly env: Readonly<Record<string, string>>
  /** The preset dirs this wrap made writable, to be checked like `/tmp/claude` (读法 48). */
  readonly presetDirs: readonly AbsolutePath[]
  /**
   * The links passed resolving the deny entries, those inside link targets included, each where it
   * itself is (spec「链接」).
   */
  readonly links: readonly AbsolutePath[]
}

/**
 * bwrap, socat and rg as found on main's PATH (§启动 step 2). One that is not there is null and
 * left out of the config: srt then looks it up itself, and initialize's dependency check names it
 * in srt's own words (§启动 step 3).
 */
export interface LinuxBinaries {
  readonly bwrap: AbsolutePath | null
  readonly socat: AbsolutePath | null
  readonly rg: AbsolutePath | null
}

export interface SessionConfigInput extends SandboxHostPaths {
  /** The effective allowlist (§网络白名单). */
  readonly allowedDomains: readonly string[]
  readonly applySeccompPath: AbsolutePath
  readonly javaAgentJarPath: AbsolutePath
  /** Required on Linux (§启动 step 2); unused on darwin. */
  readonly linuxBinaries: LinuxBinaries | null
}

export interface HelperPaths {
  readonly packageDir: AbsolutePath
  readonly applySeccomp: AbsolutePath
  readonly javaAgentJar: AbsolutePath
}

/** A config srt's schema refuses: the wrap is refused (spec §档位到 srt 配置). */
export class SandboxConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxConfigError'
  }
}

/** One variable a preset row sets (读法 47). */
export interface PresetVariable {
  readonly name: string
  /** The variable points at the manager's dir, or at this sub-directory of it. */
  readonly subdir: string | null
}

/** One row of the 「包管理器」 preset (§网络白名单; P4). */
export interface PackageManagerPreset {
  /** Also its directory's name under `<userData>/sandbox-cache/`. */
  readonly manager: 'npm' | 'pnpm' | 'pip' | 'uv' | 'cargo'
  readonly platforms: readonly SandboxPlatform[]
  readonly domains: readonly string[]
  /** All under the manager's dir (读法 49, 04 不变量 3). */
  readonly variables: readonly PresetVariable[]
}

/**
 * pnpm's store, cache and state, each in both spellings: pnpm 10 and older read `npm_config_*`,
 * 11 and later only `pnpm_config_*` (P4: the three set together leave no denied write).
 */
const PNPM_VARIABLES: readonly PresetVariable[] = [
  { name: 'npm_config_store_dir', subdir: 'store' },
  { name: 'npm_config_cache_dir', subdir: 'cache' },
  { name: 'npm_config_state_dir', subdir: 'state' },
  { name: 'pnpm_config_store_dir', subdir: 'store' },
  { name: 'pnpm_config_cache_dir', subdir: 'cache' },
  { name: 'pnpm_config_state_dir', subdir: 'state' },
]

/** The preset table; settings and the UI read this same constant (step 13a). */
export const PACKAGE_MANAGER_PRESETS: readonly PackageManagerPreset[] = [
  {
    manager: 'npm',
    platforms: ['darwin', 'linux'],
    domains: ['registry.npmjs.org'],
    variables: [{ name: 'npm_config_cache', subdir: null }],
  },
  {
    manager: 'pnpm',
    platforms: ['darwin', 'linux'],
    domains: ['registry.npmjs.org'],
    variables: PNPM_VARIABLES,
  },
  {
    manager: 'pip',
    platforms: ['linux'],
    domains: ['pypi.org', 'files.pythonhosted.org'],
    variables: [{ name: 'PIP_CACHE_DIR', subdir: null }],
  },
  {
    manager: 'uv',
    platforms: ['darwin', 'linux'],
    domains: ['pypi.org', 'files.pythonhosted.org'],
    variables: [{ name: 'UV_CACHE_DIR', subdir: null }],
  },
  {
    manager: 'cargo',
    platforms: ['darwin', 'linux'],
    domains: ['index.crates.io', 'static.crates.io'],
    variables: [{ name: 'CARGO_HOME', subdir: null }],
  },
]

/** The preset rows that apply on `platform`. */
export function presetRows(platform: SandboxPlatform): PackageManagerPreset[] {
  return PACKAGE_MANAGER_PRESETS.filter((row) => row.platforms.includes(platform))
}

/**
 * The only keys a config may carry (读法 43, 04 不变量 4), checked at run time: srt's schema is not
 * strict, so it lets `allowPty`, `filesystem.disabled` and the like through and drops unknown keys.
 */
const TOP_LEVEL_KEYS: Readonly<Record<SandboxPlatform, readonly string[]>> = {
  darwin: ['network', 'filesystem', 'ignoreViolations', 'seccomp', 'javaAgentJarPath'],
  linux: [
    'network',
    'filesystem',
    'seccomp',
    'javaAgentJarPath',
    'bwrapPath',
    'socatPath',
    'ripgrep',
  ],
}
const NETWORK_KEYS = ['allowedDomains', 'deniedDomains', 'strictAllowlist', 'parentProxy'] as const
const FILESYSTEM_KEYS = ['denyRead', 'allowRead', 'allowWrite', 'denyWrite'] as const
const NESTED_KEYS: Readonly<Record<string, readonly string[]>> = {
  'network.parentProxy': ['noProxy'],
  seccomp: ['applyPath'],
  ripgrep: ['command'],
}

/** srt's noise lines (P2, 读法 53): darwin only — srt matches them as substrings of every source. */
const DARWIN_IGNORE_VIOLATIONS: Readonly<Record<string, readonly string[]>> = {
  '*': [
    'mach-lookup com.apple.SystemConfiguration.configd',
    'mach-lookup com.apple.SystemConfiguration.DNSConfiguration',
  ],
}

/** Under home, in both tables (mech:267). */
const HOME_SECRET_DIRS = ['.ssh', '.aws', '.gnupg'] as const

/** Under home, run outside the sandbox without asking (读法 34, settled by P3 on both platforms). */
const HOME_AUTO_RUN = [
  'Library/LaunchAgents',
  '.config/autostart',
  '.config/systemd/user',
  '.config/git',
  '.gitconfig',
  '.zlogin',
  '.zlogout',
  '.bash_login',
  '.bash_aliases',
] as const

/** Tenon's names under each workspace directory (T13; security-m3, -13, -14, hosts-2). */
const ROOT_PROTECTED = [
  ...PROTECTED_SHELL_FILES,
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.envrc',
  '.codex',
  '.gemini',
  '.cursor',
  '.aws',
] as const

/** srt's mandatory write denies, anchored here at each root instead of main's cwd (srt79 sandbox-utils.js:10-37). */
const ROOT_SRT_MANDATORY = [
  '.gitconfig',
  '.gitmodules',
  '.ripgreprc',
  '.mcp.json',
  '.vscode',
  '.idea',
  '.claude/commands',
  '.claude/agents',
] as const

/** Denied at each root on darwin; on Linux only where `.git` is a directory (linux-sandbox-utils.js:186-205). */
const ROOT_GIT = ['.git/hooks', '.git/config'] as const

/** P3's settled credential list, per platform, plus the 2026-10-15 additions (open question 6). */
export function credentialPaths(platform: SandboxPlatform, home: AbsolutePath): AbsolutePath[] {
  const both = [
    '.config/gh',
    '.npmrc',
    '.docker/config.json',
    '.kube',
    '.git-credentials',
    '.netrc',
    '.pypirc',
    '.cargo/credentials.toml',
    '.config/op',
    '.vault-token',
    '.pgpass',
    '.cache/huggingface/token',
    '.cache/huggingface/stored_tokens',
  ]
  const own =
    platform === 'darwin'
      ? [
          '.config/gcloud/credentials.db',
          '.config/gcloud/access_tokens.db',
          '.config/gcloud/application_default_credentials.json',
          '.config/gcloud/legacy_credentials',
          'Library/Application Support/Google/Chrome',
          'Library/Application Support/Chromium',
          'Library/Application Support/Microsoft Edge',
          'Library/Application Support/BraveSoftware',
          'Library/Application Support/Arc',
          'Library/Application Support/Firefox',
          'Library/Safari',
          'Library/Cookies',
        ]
      : [
          '.config/gcloud',
          '.config/google-chrome',
          '.config/chromium',
          '.config/microsoft-edge',
          '.config/BraveSoftware',
          '.mozilla',
          'snap/firefox',
          'snap/chromium',
        ]
  return [...both, ...own].map((relative) => under(home, relative))
}

/**
 * srt's package dir (a real path) and the two helpers in it, passed to srt explicitly rather than
 * left to its `import.meta.url` lookup, which goes wrong once bundled (spec §依赖; T31, srt-m5).
 */
export function helperPaths(arch: string = process.arch): HelperPaths {
  const manifest = createRequire(import.meta.url).resolve(
    '@anthropic-ai/sandbox-runtime/package.json',
  )
  const packageDir = realpathSync(posix.dirname(manifest)) as AbsolutePath
  return {
    packageDir,
    applySeccomp: under(packageDir, `vendor/seccomp/${arch}/apply-seccomp`),
    javaAgentJar: under(packageDir, 'vendor/java-proxy-agent/srt-proxy-agent.jar'),
  }
}

/** The config for `initialize` and `updateConfig`; throws `SandboxConfigError` when srt's schema refuses it. */
export function sessionConfig(input: SessionConfigInput, ports: PathPorts): SandboxRuntimeConfig {
  // Shaped like read-only's, without allowRead: every wrap replaces the whole block (srt-1, srt-m2).
  const { denyRead, allowWrite, denyWrite } = buildFilesystem(
    {
      ...input,
      profile: 'read-only',
      chosen: 'read-only',
      workspace: [],
      toolOutputDir: null,
      packageManagers: false,
    },
    ports,
  ).filesystem
  const config: SandboxRuntimeConfig = {
    network: {
      allowedDomains: [...input.allowedDomains],
      deniedDomains: [],
      strictAllowlist: true,
      parentProxy: { noProxy: '*' },
    },
    filesystem: { denyRead, allowWrite, denyWrite },
    ...(input.platform === 'darwin'
      ? { ignoreViolations: cloneIgnore(DARWIN_IGNORE_VIOLATIONS) }
      : {}),
    seccomp: { applyPath: input.applySeccompPath },
    javaAgentJarPath: input.javaAgentJarPath,
    ...(input.platform === 'linux' ? linuxBinaryKeys(input.linuxBinaries) : {}),
  }
  return checked(config, input.platform)
}

/** One wrap's filesystem block, preset variables, preset dirs and links on the deny entries' ways. */
export function wrapFilesystem(input: WrapFilesystemInput, ports: PathPorts): WrapFilesystem {
  return buildFilesystem(input, ports)
}

/**
 * The session config with one wrap's filesystem in place, as srt merges it — checked against the
 * listed keys and the schema, which wants `network` and `filesystem` both there (spec §档位到 srt 配置).
 */
export function wrapConfig(
  platform: SandboxPlatform,
  session: SandboxRuntimeConfig,
  filesystem: FilesystemTables,
): SandboxRuntimeConfig {
  return checked({ ...session, filesystem }, platform)
}

function checked(config: SandboxRuntimeConfig, platform: SandboxPlatform): SandboxRuntimeConfig {
  const extra = [
    ...extraKeys('', config, TOP_LEVEL_KEYS[platform]),
    ...extraKeys('network.', config.network, NETWORK_KEYS),
    ...NETWORK_KEYS.filter((key) => !(key in config.network)).map(
      (key) => `network.${key} missing`,
    ),
    ...extraKeys('filesystem.', config.filesystem, FILESYSTEM_KEYS),
    ...Object.entries(NESTED_KEYS).flatMap(([where, keys]) =>
      extraKeys(`${where}.`, nested(config, where), keys),
    ),
  ]
  if (extra.length > 0) {
    throw new SandboxConfigError(
      `sandbox config keys differ from the listed ones: ${extra.join('; ')}`,
    )
  }
  const result = SandboxRuntimeConfigSchema.safeParse(config)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    throw new SandboxConfigError(`sandbox config refused by srt's schema: ${issues.join('; ')}`)
  }
  return config
}

/** The keys of `value` outside `allowed`, each prefixed with where it sits. */
function extraKeys(where: string, value: unknown, allowed: readonly string[]): string[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where}${key}`)
}

/** `config` at a dotted path, or undefined. */
function nested(config: SandboxRuntimeConfig, where: string): unknown {
  let value: unknown = config
  for (const key of where.split('.')) {
    value =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined
  }
  return value
}

function cloneIgnore(lines: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(lines).map(([key, list]) => [key, [...list]]))
}

function linuxBinaryKeys(
  binaries: LinuxBinaries | null,
): Pick<SandboxRuntimeConfig, 'bwrapPath' | 'socatPath' | 'ripgrep'> {
  if (binaries === null) {
    throw new TypeError('sessionConfig on linux needs the PATH lookup of bwrap, socat and rg')
  }
  return {
    ...(binaries.bwrap === null ? {} : { bwrapPath: binaries.bwrap }),
    ...(binaries.socat === null ? {} : { socatPath: binaries.socat }),
    ...(binaries.rg === null ? {} : { ripgrep: { command: binaries.rg } }),
  }
}

function buildFilesystem(input: WrapFilesystemInput, ports: PathPorts): WrapFilesystem {
  const darwin = input.platform === 'darwin'
  const writable = input.profile === 'workspace-write'
  // 「预设生效」: the preset is on and your profile is workspace-write; a path release under a
  // read-only profile does not count (读法 20, 47).
  const presetInEffect = input.packageManagers && writable && input.chosen === 'workspace-write'

  const readDenied: string[] = [
    input.profileDir,
    ...HOME_SECRET_DIRS.map((name) => under(input.home, name)),
    ...input.credentials,
    ...(input.platform === 'linux' && input.noSeccomp ? noSeccompSockets(input) : []),
  ]
  const writeDenied: string[] = [
    input.profileDir,
    ...PROTECTED_SHELL_FILES.map((name) => under(input.home, name)),
    ...(input.zdotdir === null
      ? []
      : PROTECTED_SHELL_FILES.map((name) => under(input.zdotdir as AbsolutePath, name))),
    ...readDenied,
    ...HOME_AUTO_RUN.map((name) => under(input.home, name)),
    input.srtPackageDir,
    ...(input.chdirDir === null ? [] : [input.chdirDir]),
  ]
  const globs: string[] = []
  if (writable) {
    for (const root of input.workspace) {
      if (!root.directory) continue
      const names = [
        ...ROOT_PROTECTED,
        ...ROOT_SRT_MANDATORY,
        ...(darwin || root.gitDirectory ? ROOT_GIT : []),
      ]
      writeDenied.push(...names.map((name) => under(root.path, name)))
      // Names deeper in the tree: darwin takes a glob, Linux's write rules take none (已知限制).
      if (darwin) {
        for (const anchor of new Set([root.path, realOf(root.path, ports)])) {
          if (hasGlobChars(anchor)) continue
          globs.push(...names.map((name) => `${anchor}/**/${name}`))
        }
      }
    }
  }

  const denyRead = new EntryList()
  const denyWrite = new EntryList()
  const links = new Set<string>()
  for (const [list, entries] of [
    [denyRead, readDenied],
    [denyWrite, writeDenied],
  ] as const) {
    for (const written of entries) {
      const walk = walkLinks(written, ports)
      // darwin: an entry that is itself a link stays out of denyRead as written — there it refuses
      // every lookup through it, a write as a read — and joins it by where it leads; denyWrite still
      // holds it, so it cannot be removed or replaced. A walk that does not finish keeps it.
      if (!(darwin && list === denyRead && walk.real !== undefined && isLink(written, ports))) {
        list.literal(written)
      }
      list.literal(walk.real ?? realOf(written, ports))
      for (const link of walk.links) {
        links.add(link)
        if (darwin) denyWrite.literal(link)
      }
    }
  }
  for (const glob of globs) denyWrite.glob(glob)

  const presets = presetInEffect ? presetRows(input.platform) : []
  const presetDirs = presets.map((row) => realOf(under(input.cacheDir, row.manager), ports))
  const allowWrite = new EntryList()
  if (writable) {
    for (const root of input.workspace) allowWrite.literal(realOf(root.path, ports))
  }
  // Empty unless the preset is in effect, which already implies workspace-write.
  for (const dir of presetDirs) allowWrite.literal(dir)
  const allowRead = new EntryList()
  if (input.toolOutputDir !== null) allowRead.literal(realOf(input.toolOutputDir, ports))

  const env: Record<string, string> = {}
  presets.forEach((row, i) => {
    const dir = presetDirs[i] as string
    for (const { name, subdir } of row.variables) {
      env[name] = subdir === null ? dir : `${dir}/${subdir}`
    }
  })

  return {
    filesystem: {
      denyRead: denyRead.entries(),
      allowRead: allowRead.entries(),
      allowWrite: allowWrite.entries(),
      denyWrite: denyWrite.entries(),
    },
    env,
    presetDirs: presetDirs as AbsolutePath[],
    links: [...links] as AbsolutePath[],
  }
}

/** 读法 42: what a Linux sandbox without seccomp could otherwise connect to. */
function noSeccompSockets(input: SandboxHostPaths): string[] {
  const runtimeDir =
    input.xdgRuntimeDir !== null && posix.isAbsolute(input.xdgRuntimeDir)
      ? input.xdgRuntimeDir
      : `/run/user/${input.uid}`
  return [
    runtimeDir,
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/tmp/.X11-unix',
    ...(input.sshAuthSock !== null && posix.isAbsolute(input.sshAuthSock)
      ? [posix.dirname(input.sshAuthSock)]
      : []),
  ]
}

/** Entries in first-seen order, each once. */
class EntryList {
  private readonly seen = new Map<string, FilesystemPathEntry>()

  literal(path: string): void {
    if (!this.seen.has(path)) this.seen.set(path, { path, literal: true })
  }

  glob(pattern: string): void {
    const key = `glob:${pattern}`
    if (!this.seen.has(key)) this.seen.set(key, pattern)
  }

  entries(): FilesystemPathEntry[] {
    return [...this.seen.values()]
  }
}

function under(base: string, relative: string): AbsolutePath {
  return posix.join(base, relative) as AbsolutePath
}

function hasGlobChars(path: string): boolean {
  return /[*?[\]]/.test(path)
}

/**
 * The real path; for a path that is not there, the real path of the deepest ancestor that is, with
 * the rest appended (spec「链接」).
 */
function realOf(path: string, ports: PathPorts): string {
  const tail: string[] = []
  let head = path
  for (;;) {
    try {
      const real = ports.realpath(head)
      return tail.length === 0 ? real : posix.join(real, ...tail.toReversed())
    } catch {
      if (head === '/') return path
      tail.push(posix.basename(head))
      head = posix.dirname(head)
    }
  }
}

/** The last level of `path` is a link; a path that cannot be looked at is not one. */
function isLink(path: string, ports: PathPorts): boolean {
  try {
    return ports.lstat(path)?.isSymbolicLink() === true
  } catch {
    return false
  }
}
