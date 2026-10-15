/**
 * Spec 04 §档位到 srt 配置: what Tenon hands srt, per platform and profile (04 验收 5, 11, 29 — the
 * config halves — and 04 不变量 4, 5, 6). Every expected name, key set and preset row below is a
 * literal copied from the spec's tables and Revisions; none is computed by the code under test.
 */
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime'
import type { FilesystemConfig, FilesystemPathEntry } from '@anthropic-ai/sandbox-runtime'
import type { AbsolutePath } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import {
  PACKAGE_MANAGER_PRESETS,
  SandboxConfigError,
  credentialPaths,
  sessionConfig,
  wrapConfig,
  wrapFilesystem,
} from '../../src/main/host/sandbox-config.js'
import type {
  PathPorts,
  SandboxHostPaths,
  SandboxPlatform,
  WorkspaceRoot,
  WrapFilesystemInput,
} from '../../src/main/host/sandbox-config.js'

const p = (path: string): AbsolutePath => path as AbsolutePath

// ---------------------------------------------------------------------------------------------
// Literals from the spec

/** §档位到 srt 配置, 凭据清单 (P3 settled; 2026-10-15 additions), darwin. */
const DARWIN_CREDENTIALS = [
  '/Users/u/.config/gh',
  '/Users/u/.npmrc',
  '/Users/u/.docker/config.json',
  '/Users/u/.kube',
  '/Users/u/.git-credentials',
  '/Users/u/.netrc',
  '/Users/u/.pypirc',
  '/Users/u/.cargo/credentials.toml',
  '/Users/u/.config/gcloud/credentials.db',
  '/Users/u/.config/gcloud/access_tokens.db',
  '/Users/u/.config/gcloud/application_default_credentials.json',
  '/Users/u/.config/gcloud/legacy_credentials',
  '/Users/u/Library/Application Support/Google/Chrome',
  '/Users/u/Library/Application Support/Chromium',
  '/Users/u/Library/Application Support/Microsoft Edge',
  '/Users/u/Library/Application Support/BraveSoftware',
  '/Users/u/Library/Application Support/Arc',
  '/Users/u/Library/Application Support/Firefox',
  '/Users/u/Library/Safari',
  '/Users/u/Library/Cookies',
  '/Users/u/.config/op',
  '/Users/u/.vault-token',
  '/Users/u/.pgpass',
  '/Users/u/.cache/huggingface/token',
  '/Users/u/.cache/huggingface/stored_tokens',
]

/** The same list, Linux. */
const LINUX_CREDENTIALS = [
  '/home/u/.config/gh',
  '/home/u/.npmrc',
  '/home/u/.docker/config.json',
  '/home/u/.kube',
  '/home/u/.git-credentials',
  '/home/u/.netrc',
  '/home/u/.pypirc',
  '/home/u/.cargo/credentials.toml',
  '/home/u/.config/gcloud',
  '/home/u/.config/google-chrome',
  '/home/u/.config/chromium',
  '/home/u/.config/microsoft-edge',
  '/home/u/.config/BraveSoftware',
  '/home/u/.mozilla',
  '/home/u/snap/firefox',
  '/home/u/snap/chromium',
  '/home/u/.config/op',
  '/home/u/.vault-token',
  '/home/u/.pgpass',
  '/home/u/.cache/huggingface/token',
  '/home/u/.cache/huggingface/stored_tokens',
]

/** denyRead and denyWrite: `.ssh`, `.aws`, `.gnupg` under home (mech:267). */
const HOME_SECRET_DIRS = ['.ssh', '.aws', '.gnupg']

/** denyWrite: the six shell files (workspace.ts:34-41), under home and under `ZDOTDIR`. */
const SHELL_FILES = ['.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.profile']

/** denyWrite: home's auto-run locations (读法 34). */
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
]

/** workspace-write denyWrite, under each workspace directory: Tenon's names (T13). */
const ROOT_TENON = [
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.envrc',
  '.codex',
  '.gemini',
  '.cursor',
  '.aws',
]

/** …and srt's mandatory names, without the `.git` pair (srt79 sandbox-utils.js:10-37). */
const ROOT_SRT = [
  '.gitconfig',
  '.gitmodules',
  '.ripgreprc',
  '.mcp.json',
  '.vscode',
  '.idea',
  '.claude/commands',
  '.claude/agents',
]

/** …and the `.git` pair: darwin always, Linux only where `.git` is a directory. */
const ROOT_GIT = ['.git/hooks', '.git/config']

/** darwin's `ignoreViolations` (P2 and 读法 53). */
const DARWIN_IGNORE = {
  '*': [
    'mach-lookup com.apple.SystemConfiguration.configd',
    'mach-lookup com.apple.SystemConfiguration.DNSConfiguration',
  ],
}

// ---------------------------------------------------------------------------------------------
// Fixtures

const D_APP = '/Users/u/Library/Application Support/Tenon'
const D_PROFILE = `${D_APP}/profiles/u1/t1`
const D_CACHE = `${D_APP}/sandbox-cache`
const D_CWD = `${D_APP}/sandbox-cwd`
const D_TOOL_OUTPUT = `${D_PROFILE}/tool-output/6f1c2a4e-3b5d-4c7e-9f80-1a2b3c4d5e6f`
const D_ZDOTDIR = '/Users/u/.zsh'
const L_APP = '/home/u/.local/share/Tenon'
const L_PROFILE = `${L_APP}/profiles/u1/t1`
const L_CACHE = `${L_APP}/sandbox-cache`
const L_CWD = `${L_APP}/sandbox-cwd`
const L_TOOL_OUTPUT = `${L_PROFILE}/tool-output/6f1c2a4e-3b5d-4c7e-9f80-1a2b3c4d5e6f`
const SRT = '/opt/tenon/srt'

function hostPaths(platform: SandboxPlatform): SandboxHostPaths {
  return platform === 'darwin'
    ? {
        platform,
        home: p('/Users/u'),
        zdotdir: p(D_ZDOTDIR),
        profileDir: p(D_PROFILE),
        cacheDir: p(D_CACHE),
        chdirDir: p(D_CWD),
        srtPackageDir: p(SRT),
        credentials: DARWIN_CREDENTIALS.map(p),
        noSeccomp: false,
        uid: 501,
        xdgRuntimeDir: null,
        sshAuthSock: null,
      }
    : {
        platform,
        home: p('/home/u'),
        zdotdir: null,
        profileDir: p(L_PROFILE),
        cacheDir: p(L_CACHE),
        chdirDir: p(L_CWD),
        srtPackageDir: p(SRT),
        credentials: LINUX_CREDENTIALS.map(p),
        noSeccomp: false,
        uid: 1000,
        xdgRuntimeDir: null,
        sshAuthSock: null,
      }
}

function root(path: string, gitDirectory = true): WorkspaceRoot {
  return { path: p(path), directory: true, gitDirectory }
}

function wrapInput(
  platform: SandboxPlatform,
  overrides: Partial<WrapFilesystemInput> = {},
): WrapFilesystemInput {
  const home = platform === 'darwin' ? '/Users/u' : '/home/u'
  return {
    ...hostPaths(platform),
    profile: 'workspace-write',
    chosen: 'workspace-write',
    workspace: [root(`${home}/code/app`)],
    toolOutputDir: p(platform === 'darwin' ? D_TOOL_OUTPUT : L_TOOL_OUTPUT),
    packageManagers: false,
    ...overrides,
  }
}

function sessionInput(platform: SandboxPlatform) {
  return {
    ...hostPaths(platform),
    allowedDomains: ['github.com', 'localhost:8080'],
    applySeccompPath: p(`${SRT}/vendor/seccomp/arm64/apply-seccomp`),
    javaAgentJarPath: p(`${SRT}/vendor/java-proxy-agent/srt-proxy-agent.jar`),
    linuxBinaries:
      platform === 'linux'
        ? { bwrap: p('/usr/bin/bwrap'), socat: p('/usr/bin/socat'), rg: p('/usr/bin/rg') }
        : null,
  }
}

/** Nothing is a link and every path is its own real path. */
const PLAIN: PathPorts = {
  realpath: (path) => path,
  lstat: () => ({ isSymbolicLink: () => false }),
}

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
}

function joinName(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/**
 * A small disk: `entries` are real paths that exist (their ancestors exist too), `links` map a
 * link's own real location to its target. `realpath` and `lstat` behave like node's.
 */
function fakeDisk(entries: readonly string[], links: Readonly<Record<string, string>>): PathPorts {
  const exists = (real: string): boolean =>
    real === '/' || entries.some((entry) => entry === real || entry.startsWith(`${real}/`))
  const realpath = (path: string, depth = 0): string => {
    if (depth > 20) throw new Error(`ELOOP: ${path}`)
    let current = '/'
    for (const segment of path.split('/').filter(Boolean)) {
      const next = joinName(current, segment)
      const target = links[next]
      if (target !== undefined) current = realpath(target, depth + 1)
      else if (exists(next)) current = next
      else throw missing(path)
    }
    return current
  }
  const lstat = (path: string): { isSymbolicLink(): boolean } | undefined => {
    const cut = path.lastIndexOf('/')
    let parent: string
    try {
      parent = realpath(cut === 0 ? '/' : path.slice(0, cut))
    } catch {
      return undefined
    }
    const node = joinName(parent, path.slice(cut + 1))
    if (links[node] !== undefined) return { isSymbolicLink: () => true }
    return exists(node) ? { isSymbolicLink: () => false } : undefined
  }
  return { realpath: (path) => realpath(path), lstat }
}

/** A list as comparable strings: a literal entry is its path, a pattern is `glob <pattern>`. */
function spelled(list: readonly FilesystemPathEntry[] | undefined): string[] {
  return (list ?? [])
    .map((entry) => (typeof entry === 'string' ? `glob ${entry}` : entry.path))
    .toSorted()
}

function sorted(list: readonly string[]): string[] {
  return list.toSorted()
}

function literal(path: string): FilesystemPathEntry {
  return { path, literal: true }
}

// ---------------------------------------------------------------------------------------------

describe('04 sandbox config (spec 04 §档位到 srt 配置)', () => {
  it("04 验收 5: read-only writes nothing but srt's defaults", () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const home = platform === 'darwin' ? '/Users/u' : '/home/u'
      const wrap = wrapFilesystem(
        wrapInput(platform, { profile: 'read-only', chosen: 'read-only', packageManagers: true }),
        PLAIN,
      )
      expect(wrap.filesystem.allowWrite).toEqual([])
      expect(wrap.env).toEqual({})
      expect(wrap.presetDirs).toEqual([])
      // No per-root names either: those are the workspace-write column's.
      expect(spelled(wrap.filesystem.denyWrite).some((e) => e.includes(`${home}/code/app`))).toBe(
        false,
      )
      // The session config is read-only's shape.
      expect(sessionConfig(sessionInput(platform), PLAIN).filesystem.allowWrite).toEqual([])
    }
  })

  it("04 验收 5: workspace-write allows exactly the request's workspace, as literal entries", () => {
    const wrap = wrapFilesystem(
      wrapInput('darwin', {
        workspace: [
          root('/Users/u/code/app'),
          root('/Users/u/code/lib'),
          { path: p('/Users/u/notes/todo.md'), directory: false, gitDirectory: false },
        ],
      }),
      PLAIN,
    )
    expect(wrap.filesystem.allowWrite).toEqual([
      literal('/Users/u/code/app'),
      literal('/Users/u/code/lib'),
      literal('/Users/u/notes/todo.md'),
    ])
    // A path release is not a directory: nothing is denied beneath it.
    expect(spelled(wrap.filesystem.denyWrite).filter((e) => e.includes('todo.md'))).toEqual([])
  })

  it('04 验收 5: denyRead, allowRead and denyWrite follow the table', () => {
    const darwinRead = [
      D_PROFILE,
      ...HOME_SECRET_DIRS.map((n) => `/Users/u/${n}`),
      ...DARWIN_CREDENTIALS,
    ]
    const darwinWrite = [
      ...darwinRead,
      ...SHELL_FILES.map((n) => `/Users/u/${n}`),
      ...SHELL_FILES.map((n) => `${D_ZDOTDIR}/${n}`),
      ...HOME_AUTO_RUN.map((n) => `/Users/u/${n}`),
      SRT,
      D_CWD,
    ]
    const darwinRoot = [...ROOT_TENON, ...ROOT_SRT, ...ROOT_GIT]
    const linuxRead = [
      L_PROFILE,
      ...HOME_SECRET_DIRS.map((n) => `/home/u/${n}`),
      ...LINUX_CREDENTIALS,
    ]
    const linuxWrite = [
      ...linuxRead,
      ...SHELL_FILES.map((n) => `/home/u/${n}`),
      ...HOME_AUTO_RUN.map((n) => `/home/u/${n}`),
      SRT,
      L_CWD,
    ]
    const linuxRoot = [...ROOT_TENON, ...ROOT_SRT, ...ROOT_GIT]

    const darwinRO = wrapFilesystem(wrapInput('darwin', { profile: 'read-only' }), PLAIN).filesystem
    expect(spelled(darwinRO.denyRead)).toEqual(sorted(darwinRead))
    expect(spelled(darwinRO.allowRead)).toEqual([D_TOOL_OUTPUT])
    expect(spelled(darwinRO.denyWrite)).toEqual(sorted(darwinWrite))

    const darwinWW = wrapFilesystem(wrapInput('darwin'), PLAIN).filesystem
    expect(spelled(darwinWW.denyRead)).toEqual(sorted(darwinRead))
    expect(spelled(darwinWW.allowRead)).toEqual([D_TOOL_OUTPUT])
    expect(spelled(darwinWW.denyWrite)).toEqual(
      sorted([
        ...darwinWrite,
        ...darwinRoot.map((n) => `/Users/u/code/app/${n}`),
        ...darwinRoot.map((n) => `glob /Users/u/code/app/**/${n}`),
      ]),
    )

    const linuxRO = wrapFilesystem(wrapInput('linux', { profile: 'read-only' }), PLAIN).filesystem
    expect(spelled(linuxRO.denyRead)).toEqual(sorted(linuxRead))
    expect(spelled(linuxRO.allowRead)).toEqual([L_TOOL_OUTPUT])
    expect(spelled(linuxRO.denyWrite)).toEqual(sorted(linuxWrite))

    const linuxWW = wrapFilesystem(wrapInput('linux'), PLAIN).filesystem
    expect(spelled(linuxWW.denyRead)).toEqual(sorted(linuxRead))
    expect(spelled(linuxWW.allowRead)).toEqual([L_TOOL_OUTPUT])
    expect(spelled(linuxWW.denyWrite)).toEqual(
      sorted([...linuxWrite, ...linuxRoot.map((n) => `/home/u/code/app/${n}`)]),
    )

    // Without a spill folder there is nothing to read back.
    const none = wrapFilesystem(wrapInput('darwin', { toolOutputDir: null }), PLAIN).filesystem
    expect(none.allowRead).toEqual([])
  })

  it('04 验收 5: a folder named `[WIP] *` stays literal', () => {
    const wip = '/Users/u/code/[WIP] *'
    for (const platform of ['darwin', 'linux'] as const) {
      const wrap = wrapFilesystem(
        wrapInput(platform, { workspace: [root(wip), root('/Users/u/code/app')] }),
        PLAIN,
      )
      expect(wrap.filesystem.allowWrite).toEqual([literal(wip), literal('/Users/u/code/app')])
      expect(wrap.filesystem.denyWrite).toContainEqual(literal(`${wip}/.envrc`))
      expect(wrap.filesystem.denyWrite).toContainEqual(literal(`${wip}/.git/hooks`))
      // A root whose spelling holds `*?[]` gets no glob (darwin's other roots do).
      const patterns = wrap.filesystem.denyWrite.filter((e) => typeof e === 'string')
      expect(patterns.filter((e) => e.startsWith('/Users/u/code/[WIP]'))).toEqual([])
      expect(patterns.length).toBe(platform === 'darwin' ? 23 : 0)
      expect(patterns.includes('/Users/u/code/app/**/.envrc')).toBe(platform === 'darwin')
      // Every other entry anywhere is literal.
      for (const list of [wrap.filesystem.denyRead, wrap.filesystem.allowRead ?? []]) {
        expect(list.every((e) => typeof e === 'object' && e.literal === true)).toBe(true)
      }
    }
  })

  it("04 验收 5: denyWrite carries every denyRead entry, the home auto-run paths, the srt package dir and, per root, srt's mandatory names (Linux: the .git pair only when .git is a directory)", () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const home = platform === 'darwin' ? '/Users/u' : '/home/u'
      const app = `${home}/code/app`
      const lib = `${home}/code/lib`
      const { denyRead, denyWrite } = wrapFilesystem(
        wrapInput(platform, { workspace: [root(app, true), root(lib, false)] }),
        PLAIN,
      ).filesystem
      for (const entry of denyRead) expect(denyWrite).toContainEqual(entry)
      for (const name of HOME_AUTO_RUN) expect(denyWrite).toContainEqual(literal(`${home}/${name}`))
      expect(denyWrite).toContainEqual(literal(SRT))
      for (const name of ROOT_SRT) {
        expect(denyWrite).toContainEqual(literal(`${app}/${name}`))
        expect(denyWrite).toContainEqual(literal(`${lib}/${name}`))
      }
      for (const name of ROOT_GIT) {
        expect(denyWrite).toContainEqual(literal(`${app}/${name}`))
        expect(spelled(denyWrite).includes(`${lib}/${name}`)).toBe(platform === 'darwin')
      }
    }
  })

  it('04 验收 5: no-seccomp adds the socket paths to denyRead', () => {
    const sockets = [
      '/run/user/1000',
      '/var/run/docker.sock',
      '/run/docker.sock',
      '/tmp/.X11-unix',
      '/tmp/ssh-XYZ',
    ]
    const linux = (overrides: Partial<WrapFilesystemInput>) =>
      wrapFilesystem(
        wrapInput('linux', { sshAuthSock: '/tmp/ssh-XYZ/agent.42', ...overrides }),
        PLAIN,
      ).filesystem

    const degraded = linux({ noSeccomp: true })
    for (const path of sockets) {
      expect(degraded.denyRead).toContainEqual(literal(path))
      expect(degraded.denyWrite).toContainEqual(literal(path))
    }
    // `XDG_RUNTIME_DIR` when set, `/run/user/<uid>` otherwise.
    const own = linux({ noSeccomp: true, xdgRuntimeDir: '/run/user/4242' })
    expect(own.denyRead).toContainEqual(literal('/run/user/4242'))
    expect(own.denyRead).not.toContainEqual(literal('/run/user/1000'))

    const active = linux({ noSeccomp: false })
    for (const path of sockets) expect(active.denyRead).not.toContainEqual(literal(path))
    // Linux only.
    const darwin = wrapFilesystem(
      wrapInput('darwin', { noSeccomp: true, sshAuthSock: '/tmp/ssh-XYZ/agent.42' }),
      PLAIN,
    ).filesystem
    for (const path of sockets) expect(darwin.denyRead).not.toContainEqual(literal(path))
  })

  it("04 不变量 4: only the listed keys, parentProxy { noProxy: '*' }, strictAllowlist on, schema-valid", () => {
    const darwin = sessionConfig(sessionInput('darwin'), PLAIN)
    expect(Object.keys(darwin).toSorted()).toEqual([
      'filesystem',
      'ignoreViolations',
      'javaAgentJarPath',
      'network',
      'seccomp',
    ])
    const linux = sessionConfig(sessionInput('linux'), PLAIN)
    expect(Object.keys(linux).toSorted()).toEqual([
      'bwrapPath',
      'filesystem',
      'javaAgentJarPath',
      'network',
      'ripgrep',
      'seccomp',
      'socatPath',
    ])
    expect(linux.bwrapPath).toBe('/usr/bin/bwrap')
    expect(linux.socatPath).toBe('/usr/bin/socat')
    expect(linux.ripgrep).toEqual({ command: '/usr/bin/rg' })

    for (const config of [darwin, linux]) {
      expect(config.network).toEqual({
        allowedDomains: ['github.com', 'localhost:8080'],
        deniedDomains: [],
        strictAllowlist: true,
        parentProxy: { noProxy: '*' },
      })
      expect(Object.keys(config.filesystem).toSorted()).toEqual([
        'allowWrite',
        'denyRead',
        'denyWrite',
      ])
      expect(config.seccomp).toEqual({ applyPath: `${SRT}/vendor/seccomp/arm64/apply-seccomp` })
      expect(config.javaAgentJarPath).toBe(`${SRT}/vendor/java-proxy-agent/srt-proxy-agent.jar`)
      expect(SandboxRuntimeConfigSchema.safeParse(config).success).toBe(true)
    }

    // An empty allowlist is still written out (security-m2).
    const empty = sessionConfig({ ...sessionInput('darwin'), allowedDomains: [] }, PLAIN)
    expect(empty.network.allowedDomains).toEqual([])

    // A wrap's filesystem merged into the session config: the four lists, nothing else, valid.
    for (const platform of ['darwin', 'linux'] as const) {
      const session = platform === 'darwin' ? darwin : linux
      for (const profile of ['read-only', 'workspace-write'] as const) {
        const { filesystem } = wrapFilesystem(
          wrapInput(platform, { profile, packageManagers: true }),
          PLAIN,
        )
        expect(Object.keys(filesystem).toSorted()).toEqual([
          'allowRead',
          'allowWrite',
          'denyRead',
          'denyWrite',
        ])
        const merged = wrapConfig(session, filesystem)
        expect(Object.keys(merged).toSorted()).toEqual(Object.keys(session).toSorted())
        expect(SandboxRuntimeConfigSchema.safeParse(merged).success).toBe(true)
      }
    }

    // What srt's schema refuses is refused here.
    expect(() =>
      sessionConfig({ ...sessionInput('darwin'), allowedDomains: ['*'] }, PLAIN),
    ).toThrow(SandboxConfigError)
    const inert: FilesystemConfig = { denyRead: [], allowWrite: [], denyWrite: ['/w/*/'] }
    expect(() => wrapConfig(darwin, inert)).toThrow(SandboxConfigError)
  })

  it('04 不变量 5: allowWrite holds only the workspace and, with the preset in effect, its dirs', () => {
    const darwin = wrapFilesystem(wrapInput('darwin', { packageManagers: true }), PLAIN)
    expect(spelled(darwin.filesystem.allowWrite)).toEqual(
      sorted([
        '/Users/u/code/app',
        `${D_CACHE}/npm`,
        `${D_CACHE}/pnpm`,
        `${D_CACHE}/uv`,
        `${D_CACHE}/cargo`,
      ]),
    )
    const linux = wrapFilesystem(wrapInput('linux', { packageManagers: true }), PLAIN)
    expect(spelled(linux.filesystem.allowWrite)).toEqual(
      sorted([
        '/home/u/code/app',
        `${L_CACHE}/npm`,
        `${L_CACHE}/pnpm`,
        `${L_CACHE}/pip`,
        `${L_CACHE}/uv`,
        `${L_CACHE}/cargo`,
      ]),
    )
    // Only in workspace-write: read-only stays read-only even with the preset on.
    for (const platform of ['darwin', 'linux'] as const) {
      const readOnly = wrapFilesystem(
        wrapInput(platform, { profile: 'read-only', chosen: 'read-only', packageManagers: true }),
        PLAIN,
      )
      expect(readOnly.filesystem.allowWrite).toEqual([])
    }
    // Never your own caches.
    for (const own of ['/Users/u/.npm', '/Users/u/.cargo', '/Users/u/.cache/uv']) {
      expect(spelled(darwin.filesystem.allowWrite)).not.toContain(own)
    }
  })

  it('04 不变量 6: denyRead holds the secrets, denyWrite holds denyRead, the chdir dir and the root names; links only in darwin denyWrite', () => {
    const disk = linkedDisk()
    for (const platform of ['darwin', 'linux'] as const) {
      const input = linkedInput(platform)
      const { filesystem } = wrapFilesystem(input, disk)
      const read = spelled(filesystem.denyRead)
      const write = spelled(filesystem.denyWrite)
      for (const path of [
        LINKED_PROFILE,
        '/Users/u/.ssh',
        '/Users/u/.aws',
        '/Users/u/.gnupg',
        ...DARWIN_CREDENTIALS,
      ]) {
        expect(read).toContain(path)
      }
      for (const entry of read) expect(write).toContain(entry)
      expect(write).toContain(LINKED_CWD)
      for (const name of [...ROOT_TENON, ...ROOT_SRT, ...ROOT_GIT]) {
        expect(write).toContain(`/Users/u/proj/${name}`)
      }
      // Two spellings: as written, and real.
      expect(read).toContain('/Users/u/.config/gh')
      expect(read).toContain('/Users/u/dotfiles/config/gh')
      // A link on the way is never in denyRead; it is in denyWrite on darwin only.
      expect(read).not.toContain('/Users/u/.config')
      expect(write.includes('/Users/u/.config')).toBe(platform === 'darwin')
      // allowWrite has real paths only; allowRead at most the spill folder.
      expect(spelled(filesystem.allowWrite)).toEqual(['/Volumes/work/proj'])
      expect(spelled(filesystem.allowRead)).toEqual([`${LINKED_PROFILE}/tool-output/s1`])
      // read-only also denies writes to the chdir dir.
      const readOnly = wrapFilesystem({ ...input, profile: 'read-only' }, disk).filesystem
      expect(spelled(readOnly.denyWrite)).toContain(LINKED_CWD)
    }
  })

  it("04 验收 29 (config): with the preset on in workspace-write, allowWrite gains exactly the platform's preset dirs and the extra env is exactly their variables (darwin: npm, pnpm, uv, cargo; linux: also pip); in read-only (also with a path release) or with the preset off, neither; ~/.npm and ~/.cargo are never added", () => {
    // The preset table (§网络白名单), one constant for config, settings and UI.
    expect(PACKAGE_MANAGER_PRESETS).toEqual([
      {
        manager: 'npm',
        platforms: ['darwin', 'linux'],
        domains: ['registry.npmjs.org'],
        variable: 'npm_config_cache',
        variableSubdir: null,
      },
      {
        manager: 'pnpm',
        platforms: ['darwin', 'linux'],
        domains: ['registry.npmjs.org'],
        variable: 'npm_config_store_dir',
        variableSubdir: 'store',
      },
      {
        manager: 'pip',
        platforms: ['linux'],
        domains: ['pypi.org', 'files.pythonhosted.org'],
        variable: 'PIP_CACHE_DIR',
        variableSubdir: null,
      },
      {
        manager: 'uv',
        platforms: ['darwin', 'linux'],
        domains: ['pypi.org', 'files.pythonhosted.org'],
        variable: 'UV_CACHE_DIR',
        variableSubdir: null,
      },
      {
        manager: 'cargo',
        platforms: ['darwin', 'linux'],
        domains: ['index.crates.io', 'static.crates.io'],
        variable: 'CARGO_HOME',
        variableSubdir: null,
      },
    ])

    const darwin = wrapFilesystem(wrapInput('darwin', { packageManagers: true }), PLAIN)
    expect(darwin.presetDirs).toEqual([
      `${D_CACHE}/npm`,
      `${D_CACHE}/pnpm`,
      `${D_CACHE}/uv`,
      `${D_CACHE}/cargo`,
    ])
    expect(darwin.env).toEqual({
      npm_config_cache: `${D_CACHE}/npm`,
      npm_config_store_dir: `${D_CACHE}/pnpm/store`,
      UV_CACHE_DIR: `${D_CACHE}/uv`,
      CARGO_HOME: `${D_CACHE}/cargo`,
    })
    expect(spelled(darwin.filesystem.allowWrite)).toEqual(
      sorted(['/Users/u/code/app', ...darwin.presetDirs]),
    )

    const linux = wrapFilesystem(wrapInput('linux', { packageManagers: true }), PLAIN)
    expect(linux.presetDirs).toEqual([
      `${L_CACHE}/npm`,
      `${L_CACHE}/pnpm`,
      `${L_CACHE}/pip`,
      `${L_CACHE}/uv`,
      `${L_CACHE}/cargo`,
    ])
    expect(linux.env).toEqual({
      npm_config_cache: `${L_CACHE}/npm`,
      npm_config_store_dir: `${L_CACHE}/pnpm/store`,
      PIP_CACHE_DIR: `${L_CACHE}/pip`,
      UV_CACHE_DIR: `${L_CACHE}/uv`,
      CARGO_HOME: `${L_CACHE}/cargo`,
    })

    for (const platform of ['darwin', 'linux'] as const) {
      const home = platform === 'darwin' ? '/Users/u' : '/home/u'
      const release = `${home}/notes/todo.md`
      const cases: Partial<WrapFilesystemInput>[] = [
        // read-only
        { profile: 'read-only', chosen: 'read-only', packageManagers: true },
        // read-only with a path release: the request is workspace-write, your profile is not
        {
          profile: 'workspace-write',
          chosen: 'read-only',
          packageManagers: true,
          workspace: [{ path: p(release), directory: false, gitDirectory: false }],
        },
        // the preset off
        { packageManagers: false },
      ]
      for (const overrides of cases) {
        const wrap = wrapFilesystem(wrapInput(platform, overrides), PLAIN)
        expect(wrap.env).toEqual({})
        expect(wrap.presetDirs).toEqual([])
        expect(spelled(wrap.filesystem.allowWrite).some((e) => e.includes('sandbox-cache'))).toBe(
          false,
        )
      }
      for (const overrides of [...cases, { packageManagers: true }]) {
        const allow = spelled(
          wrapFilesystem(wrapInput(platform, overrides), PLAIN).filesystem.allowWrite,
        )
        expect(allow).not.toContain(`${home}/.npm`)
        expect(allow).not.toContain(`${home}/.cargo`)
      }
    }
  })

  it('04 不变量 6: the credential list per platform (darwin: the four gcloud files, not the directory; both: the whole ~/.kube, ~/.config/op, ~/.vault-token, ~/.pgpass and the Hugging Face token files)', () => {
    expect(sorted(credentialPaths('darwin', p('/Users/u')))).toEqual(sorted(DARWIN_CREDENTIALS))
    expect(sorted(credentialPaths('linux', p('/home/u')))).toEqual(sorted(LINUX_CREDENTIALS))
  })

  it('04 不变量 6: ignoreViolations is exactly the configd and DNSConfiguration lines on darwin and absent on linux', () => {
    expect(sessionConfig(sessionInput('darwin'), PLAIN).ignoreViolations).toEqual(DARWIN_IGNORE)
    expect('ignoreViolations' in sessionConfig(sessionInput('linux'), PLAIN)).toBe(false)
  })

  it("04 验收 11 (config): a deny entry is passed as written and as its real path; on darwin each link on its way joins denyWrite only, never denyRead; on linux no link is passed; a missing tail hangs off the deepest existing ancestor's real path; allowWrite gets the real path only; the links on the way come back for the lstat record", () => {
    const disk = linkedDisk()
    const linksOnTheWay = ['/Users/u/.config', '/Users/u/.cache', '/Users/u/proj']
    for (const platform of ['darwin', 'linux'] as const) {
      const wrap = wrapFilesystem(linkedInput(platform), disk)
      const read = spelled(wrap.filesystem.denyRead)
      const write = spelled(wrap.filesystem.denyWrite)

      // The entry is a link itself (`~/.aws` → dotfiles): written and real.
      expect(read).toContain('/Users/u/.aws')
      expect(read).toContain('/Users/u/dotfiles/aws')
      // An entry under a linked directory: written and real.
      expect(read).toContain('/Users/u/.config/gh')
      expect(read).toContain('/Users/u/dotfiles/config/gh')
      expect(write).toContain('/Users/u/.config/gh')
      expect(write).toContain('/Users/u/dotfiles/config/gh')
      // A protected name that is a link to a file elsewhere: written and real.
      expect(write).toContain('/Users/u/proj/.envrc')
      expect(write).toContain('/Users/u/dotfiles/envrc')
      // Missing tails hang off the deepest existing ancestor's real path.
      expect(read).toContain('/Users/u/.config/op')
      expect(read).toContain('/Users/u/dotfiles/config/op')
      expect(read).toContain('/Users/u/.cache/huggingface/token')
      expect(read).toContain('/Volumes/cache/huggingface/token')
      expect(write).toContain('/Users/u/.config/git')
      expect(write).toContain('/Users/u/dotfiles/config/git')

      // Links on the way: never denyRead; darwin's denyWrite has each where it itself is.
      for (const link of [...linksOnTheWay, '/Volumes/work/proj/.envrc']) {
        expect(read).not.toContain(link)
        expect(write.includes(link)).toBe(platform === 'darwin')
      }

      // allowWrite: the workspace's real path only.
      expect(wrap.filesystem.allowWrite).toEqual([literal('/Volumes/work/proj')])

      // darwin's per-root globs hang off both spellings of the root.
      expect(write.includes('glob /Users/u/proj/**/.envrc')).toBe(platform === 'darwin')
      expect(write.includes('glob /Volumes/work/proj/**/.envrc')).toBe(platform === 'darwin')

      // The links on the way come back, each where it itself is, for step 4's lstat record.
      expect(sorted(wrap.links)).toEqual(
        sorted([
          '/Users/u/.aws',
          '/Users/u/.cache',
          '/Users/u/.config',
          '/Users/u/proj',
          '/Volumes/work/proj/.envrc',
        ]),
      )
    }
  })

  it('04 验收 5: with a chdir dir both profiles deny writes to it; with none (eval host) there is no such entry', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const cwd = platform === 'darwin' ? D_CWD : L_CWD
      for (const profile of ['read-only', 'workspace-write'] as const) {
        const withDir = wrapFilesystem(wrapInput(platform, { profile }), PLAIN).filesystem
        expect(withDir.denyWrite).toContainEqual(literal(cwd))
        expect(withDir.denyRead).not.toContainEqual(literal(cwd))
        const evals = wrapFilesystem(
          wrapInput(platform, { profile, chdirDir: null }),
          PLAIN,
        ).filesystem
        expect(spelled(evals.denyWrite).some((e) => e.includes('sandbox-cwd'))).toBe(false)
      }
      expect(sessionConfig(sessionInput(platform), PLAIN).filesystem.denyWrite).toContainEqual(
        literal(cwd),
      )
      expect(
        spelled(
          sessionConfig({ ...sessionInput(platform), chdirDir: null }, PLAIN).filesystem.denyWrite,
        ).some((e) => e.includes('sandbox-cwd')),
      ).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The linked disk: `~/.aws` and `~/.config` point into a dotfiles repo, `~/.cache` to another
// volume, the workspace folder `~/proj` to `/Volumes/work/proj`, whose `.envrc` points back into the
// dotfiles. `~/.config/op` and `~/.cache/huggingface` do not exist.

const LINKED_PROFILE = '/Users/u/Library/Application Support/Tenon/profiles/u1/t1'
const LINKED_CWD = '/Users/u/Library/Application Support/Tenon/sandbox-cwd'

function linkedDisk(): PathPorts {
  return fakeDisk(
    [
      '/Users/u/.ssh',
      '/Users/u/dotfiles/aws',
      '/Users/u/dotfiles/config/gh/hosts.yml',
      '/Users/u/dotfiles/envrc',
      '/Volumes/cache',
      '/Volumes/work/proj/src',
    ],
    {
      '/Users/u/.aws': '/Users/u/dotfiles/aws',
      '/Users/u/.config': '/Users/u/dotfiles/config',
      '/Users/u/.cache': '/Volumes/cache',
      '/Users/u/proj': '/Volumes/work/proj',
      '/Volumes/work/proj/.envrc': '/Users/u/dotfiles/envrc',
    },
  )
}

function linkedInput(platform: SandboxPlatform): WrapFilesystemInput {
  return {
    platform,
    home: p('/Users/u'),
    zdotdir: null,
    profileDir: p(LINKED_PROFILE),
    cacheDir: p('/Users/u/Library/Application Support/Tenon/sandbox-cache'),
    chdirDir: p(LINKED_CWD),
    srtPackageDir: p(SRT),
    credentials: DARWIN_CREDENTIALS.map(p),
    noSeccomp: false,
    uid: 501,
    xdgRuntimeDir: null,
    sshAuthSock: null,
    profile: 'workspace-write',
    chosen: 'workspace-write',
    workspace: [root('/Users/u/proj')],
    toolOutputDir: p(`${LINKED_PROFILE}/tool-output/s1`),
    packageManagers: false,
  }
}
