/**
 * Spec 04 §afterExit、清理与违规: the host classifies each srt violation line by its text (验收 16, the
 * classification half; T10, T41; 读法 11, 18, 32, 35, 36, 44, 53). The fixture holds the lines the
 * probes P1–P3 captured on macOS 26.3 and in the Ubuntu 24.04 / 26.04 VMs (plan 实施记录
 * 2026-10-14), real paths swapped for /fx. Every expected result below is a literal read off the
 * spec's table, never computed by the code under test.
 */
import { readFileSync } from 'node:fs'
import type { SandboxViolation } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import {
  classify,
  type PathKind,
  type SandboxPathEntry,
  type ViolationContext,
} from '../../src/main/host/sandbox-violations.js'

interface FixtureLine {
  id: string
  platforms: string[]
  probe: 'P1' | 'P2' | 'P3'
  check: string
  profile: 'workspace-write' | 'read-only'
  line: string
}

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/violation-lines.json', import.meta.url), 'utf8'),
) as { srt: string; lines: FixtureLine[] }

// --- The wraps the lines are read against -------------------------------------------------------

/** What is on disk as a line arrives. */
const DIRECTORIES = new Set([
  '/fx',
  '/fx/p1',
  '/fx/p1/home',
  '/fx/p1/home/.ssh',
  '/fx/p1/home/tenon-profile',
  '/fx/p1/ws',
  '/fx/p1/ws/sub',
  '/fx/p1/outside',
  '/fx/p1/outside/existing',
  '/fx/p2',
  '/fx/p2/home',
  '/fx/p2/home/tenon-sandbox-cache',
  '/fx/p2/home/tenon-sandbox-cache/npm',
  '/fx/p2/ws',
  '/fx/p2/ws/.git',
  '/fx/p2/outside',
  '/fx/p3',
  '/fx/p3/home',
  '/fx/p3/home/.config',
  '/fx/p3/home/.config/gcloud',
  '/fx/p3/home/.config/gcloud/logs',
  '/fx/p3/home/.config/gcloud/logs/2026.10.14',
  '/fx/p3/ws',
  '/fx/p3/ws/.git',
  '/fx/user-data',
  '/fx/p1/linked/sub',
  // roots holding regex metacharacters (the glob test)
  '/fx/c++ (copy)$',
  '/fx/c++ (copy)$/home',
  '/fx/c++ (copy)$/ws',
  '/fx/c++ (copy)$/ws/sub',
  '/fx/a$b (copy)',
  '/fx/a$b (copy)/home',
  '/fx/a$b (copy)/ws',
  '/fx/a$b (copy)/ws/sub',
])
/** `ws/out-link` points outside the workspace (P1's F8); `linked` to a directory elsewhere. */
const LINKS: ReadonlyMap<string, string> = new Map([
  ['/fx/p1/ws/out-link', '/fx/p1/outside'],
  ['/fx/p1/linked', '/fx/elsewhere'],
])
const FILES = new Set(['/fx/p1/outside/a-file'])

function is(kind: 'dir' | 'link' | 'file'): PathKind {
  return { isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' }
}

function lstat(path: string): PathKind | undefined {
  if (DIRECTORIES.has(path)) return is('dir')
  if (LINKS.has(path)) return is('link')
  if (FILES.has(path)) return is('file')
  return undefined
}

function noLink(path: string): Error {
  return Object.assign(new Error(`EINVAL: ${path}`), { code: 'EINVAL' })
}

function readlink(path: string): string {
  const target = LINKS.get(path)
  if (target === undefined) throw noLink(path)
  return target
}

/** The credential list per platform (spec §档位到 srt 配置, P3 and 2026-10-15). */
const CREDENTIALS = {
  darwin: [
    '.config/gh',
    '.npmrc',
    '.docker/config.json',
    '.kube',
    '.git-credentials',
    '.netrc',
    '.pypirc',
    '.cargo/credentials.toml',
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
    '.config/op',
    '.vault-token',
    '.pgpass',
    '.cache/huggingface/token',
    '.cache/huggingface/stored_tokens',
  ],
  linux: [
    '.config/gh',
    '.npmrc',
    '.docker/config.json',
    '.kube',
    '.git-credentials',
    '.netrc',
    '.pypirc',
    '.cargo/credentials.toml',
    '.config/gcloud',
    '.config/google-chrome',
    '.config/chromium',
    '.config/microsoft-edge',
    '.config/BraveSoftware',
    '.mozilla',
    'snap/firefox',
    'snap/chromium',
    '.config/op',
    '.vault-token',
    '.pgpass',
    '.cache/huggingface/token',
    '.cache/huggingface/stored_tokens',
  ],
} as const

const HOME_SHELL_FILES = ['.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.profile']

/** Tenon's names and srt's mandatory ones under each workspace root (workspace-write only). */
const ROOT_NAMES = [
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
  '.gitconfig',
  '.gitmodules',
  '.ripgreprc',
  '.mcp.json',
  '.vscode',
  '.idea',
  '.claude/commands',
  '.claude/agents',
]
/** srt's .git pair: on Linux only under a root whose .git is a directory. */
const GIT_PAIR = ['.git/hooks', '.git/config']

const literal = (path: string): SandboxPathEntry => ({ path, literal: true })

/** A wrap as spec §档位到 srt 配置 hands it to srt, for a probe directory such as /fx/p1. */
function wrapOf(
  platform: 'darwin' | 'linux',
  profile: 'workspace-write' | 'read-only',
  base: string,
): ViolationContext {
  const home = `${base}/home`
  const ws = `${base}/ws`
  const profileDir = `${home}/tenon-profile`
  const denyRead = [profileDir, `${home}/.ssh`, `${home}/.aws`, `${home}/.gnupg`]
    .concat(CREDENTIALS[platform].map((name) => `${home}/${name}`))
    .map(literal)
  const autorun = platform === 'darwin' ? 'Library/LaunchAgents' : '.config/autostart'
  const denyWrite = [
    ...denyRead,
    ...HOME_SHELL_FILES.map((name) => literal(`${home}/${name}`)),
    literal(`${home}/${autorun}`),
    literal('/fx/app/srt'),
    literal('/fx/user-data/sandbox-cwd'),
  ]
  if (profile === 'workspace-write') {
    const gitPair = platform === 'darwin' || lstat(`${ws}/.git`)?.isDirectory() === true
    const names = gitPair ? [...ROOT_NAMES, ...GIT_PAIR] : ROOT_NAMES
    denyWrite.push(...names.map((name) => literal(`${ws}/${name}`)))
    if (platform === 'darwin') denyWrite.push(...names.map((name) => `${ws}/**/${name}`))
  }
  const allowWrite =
    profile === 'workspace-write' ? [literal(ws), literal(`${home}/tenon-sandbox-cache/npm`)] : []
  return {
    allowWrite,
    denyWrite,
    denyRead,
    profileDirs: [profileDir],
    homeDir: home,
    lstat,
    readlink,
  }
}

const PROBE_DIRS = { P1: '/fx/p1', P2: '/fx/p2', P3: '/fx/p3' } as const

/**
 * A Linux disk for writes through links (读法 11): the workspace `/fx/p4/mnt/code/proj` was opened
 * as `~/code/proj`, `~/code` being a link; in it `out-link` leads outside, `new-link` (relative) to
 * a file not made yet and `rc-link` to the home's .bashrc; `~/.ssh/config` links into a dotfiles
 * dir; `/proc/self/fd/3` and `/dev/stdout` lead into the workspace, as Tenon's own would.
 */
const P4_DIRS = new Set([
  '/fx',
  '/fx/p4',
  '/fx/p4/home',
  '/fx/p4/home/.ssh',
  '/fx/p4/home/dotfiles',
  '/fx/p4/home/dotfiles/ssh',
  '/fx/p4/mnt',
  '/fx/p4/mnt/code',
  '/fx/p4/mnt/code/proj',
  '/fx/p4/outside',
  '/proc',
  '/proc/4242',
  '/proc/4242/fd',
  '/dev',
])
const P4_LINKS: ReadonlyMap<string, string> = new Map([
  ['/fx/p4/home/code', '/fx/p4/mnt/code'],
  ['/fx/p4/mnt/code/proj/out-link', '/fx/p4/outside'],
  ['/fx/p4/mnt/code/proj/new-link', '../../../outside/not-yet'],
  ['/fx/p4/mnt/code/proj/rc-link', '/fx/p4/home/.bashrc'],
  ['/fx/p4/outside/ws-link', '/fx/p4/mnt/code/proj/f'],
  ['/fx/p4/home/.ssh/config', '/fx/p4/home/dotfiles/ssh/config'],
  ['/proc/self', '4242'],
  ['/proc/4242/fd/3', '/fx/p4/mnt/code/proj/log.txt'],
  ['/proc/4242/fd/1', '/fx/p4/mnt/code/proj/out.txt'],
  ['/dev/stdout', '/proc/self/fd/1'],
])
const P4_FILES = new Set(['/fx/p4/home/.bashrc', '/fx/p4/mnt/code/proj/f'])
/** The workspace's real path, and the home, as allowWrite holds them. */
const P4_WS = '/fx/p4/mnt/code/proj'
const P4_HOME = '/fx/p4/home'

/** A Linux workspace-write wrap on the /fx/p4 disk, `writable` its one allowWrite entry. */
function linkedWrap(writable: string): ViolationContext {
  const denyRead = ['/fx/p4/home/.ssh', '/fx/p4/home/.aws'].map(literal)
  return {
    allowWrite: [literal(writable)],
    denyWrite: [...denyRead, literal('/fx/p4/home/.bashrc'), literal(`${writable}/.envrc`)],
    denyRead,
    profileDirs: ['/fx/p4/home/tenon-profile'],
    homeDir: P4_HOME,
    lstat: (path) => {
      if (P4_DIRS.has(path)) return is('dir')
      if (P4_LINKS.has(path)) return is('link')
      if (P4_FILES.has(path)) return is('file')
      return undefined
    },
    readlink: (path) => {
      const target = P4_LINKS.get(path)
      if (target === undefined) throw noLink(path)
      return target
    },
  }
}

function wrapOfFixture(fixture: FixtureLine): ViolationContext {
  const platform = fixture.platforms[0] === 'macos' ? 'darwin' : 'linux'
  return wrapOf(platform, fixture.profile, PROBE_DIRS[fixture.probe])
}

// --- Expected results ----------------------------------------------------------------------------

type Expected = Omit<SandboxViolation, 'line'>
const DROPPED = 'dropped'

/** Each fixture line's result under its wrap, read off spec §afterExit's table. */
const EXPECTED: Record<string, Expected | typeof DROPPED> = {
  // macOS, P1 (workspace-write unless the check says read-only)
  'macos P1 F1-write-outside': { kind: 'fs', target: '/fx/p1/outside/f1', release: 'path' },
  'macos P1 F3-read-profile': {
    kind: 'fs',
    target: '/fx/p1/home/tenon-profile/config.json',
    protected: true,
  },
  'macos P1 F4-denyWrite:.envrc': { kind: 'fs', target: '/fx/p1/ws/.envrc', protected: true },
  // mkdir of .claude: no denyWrite name itself, but the parent of one, so no release either
  'macos P1 F4-denyWrite:.claude/settings.json': { kind: 'fs', target: '/fx/p1/ws/.claude' },
  'macos P1 F4-denyWrite:.mcp.json': { kind: 'fs', target: '/fx/p1/ws/.mcp.json', protected: true },
  'macos P1 F4-denyWrite:.git/hooks/x': { kind: 'fs', target: '/fx/p1/ws/.git' },
  'macos P1 F4-denyWrite:.vscode/tasks.json': {
    kind: 'fs',
    target: '/fx/p1/ws/.vscode',
    protected: true,
  },
  'macos P1 F4-denyWrite:.zshrc': { kind: 'fs', target: '/fx/p1/ws/.zshrc', protected: true },
  'macos P1 F6-read-only-ws': { kind: 'fs', target: '/fx/p1/ws/ro.txt', release: 'path' },
  'macos P1 F7-chmod-home': { kind: 'fs', target: '/fx/p1/home' },
  'macos P1 F8-symlinks #1': { kind: 'fs', target: '/fx/p1/outside/via-link', release: 'path' },
  'macos P1 F8-symlinks #2': { kind: 'fs', target: '/fx/p1/home/.ssh/id_ed25519' },
  'macos P1 F10-mach-lookup #1': { kind: 'fs', observed: true },
  'macos P1 F10-mach-lookup #2': { kind: 'fs', observed: true },
  'macos P1 F10-mach-lookup #3': { kind: 'fs', observed: true },
  'macos P1 N1-host-not-listed-http': { kind: 'fs', observed: true },
  'all P1 N1-host-not-listed-http': { kind: 'network', target: 'example.com', release: 'domain' },
  'all P1 N2-host-not-listed-connect': {
    kind: 'network',
    target: 'example.com',
    release: 'domain',
  },
  'all P1 N3-ip-literal': { kind: 'network', target: '1.1.1.1' },
  'macos P1 N4-direct': { kind: 'network', observed: true },
  'macos P1 N5b-localhost-listed-default-curl': { kind: 'network', observed: true },
  'all P1 N6b-other-port': { kind: 'network', target: '127.0.0.1' },
  'all P1 N6c-localhost-not-listed': { kind: 'network', target: 'localhost' },
  'all P1 N9-parentproxy': { kind: 'network', target: 'tenon-probe-loopback.test' },
  // macOS, P2
  'macos P2 denied write': { kind: 'fs', target: '/fx/p2/outside/w0', release: 'path' },
  'all P2 denied connect': {
    kind: 'network',
    target: 'p2-denied-0.example.invalid',
    release: 'domain',
  },
  'macos P2 git status': { kind: 'fs', target: '/fx/p2/ws/.git/index.lock', release: 'path' },
  'macos P2 npm install': { kind: 'network', observed: true },
  // macOS, P3 (the wrap carries the final credential list, not the probe's candidates)
  'macos P3 npm view #1': { kind: 'fs', observed: true },
  'macos P3 npm view #2': { kind: 'fs', target: '/fx/p3/home/.npmrc' },
  'macos P3 gh auth status #1': { kind: 'network', observed: true },
  'macos P3 gh auth status #2': { kind: 'fs', observed: true },
  'all P3 gh auth status': { kind: 'network', target: 'fake-ghe.invalid', release: 'domain' },
  'macos P3 gh auth status #3': { kind: 'fs', target: '/fx/p3/home/.config/gh/config.yml' },
  'macos P3 docker version #1': { kind: 'fs', observed: true },
  'macos P3 docker version #2': { kind: 'fs', target: '/fx/p3/home/.docker/config.json' },
  'macos P3 gcloud --version #1': {
    kind: 'fs',
    target: '/fx/p3/home/.config/gcloud/logs/2026.10.14/21.41.20.251467.log',
    release: 'path',
  },
  'macos P3 gcloud --version #2': { kind: 'fs', observed: true },
  'macos P3 gcloud --version #3': {
    kind: 'fs',
    target: '/fx/p3/home/.config/gcloud/active_config',
  },
  'macos P3 git ls-remote #1': { kind: 'fs', observed: true },
  'macos P3 git ls-remote #2': { kind: 'fs', observed: true },
  'macos P3 git ls-remote #3': { kind: 'fs', target: '/fx/p3/home/.netrc' },
  'macos P3 credential read #1': { kind: 'fs', target: '/fx/p3/home/.ssh/id_ed25519' },
  'macos P3 credential read #2': { kind: 'fs', target: '/fx/p3/home/.aws/credentials' },
  'macos P3 credential read #3': {
    kind: 'fs',
    target: '/fx/p3/home/.gnupg/private-keys-v1.d/probe.key',
  },
  'macos P3 credential read #4': { kind: 'fs', target: '/fx/p3/home/.config/gh/hosts.yml' },
  'macos P3 credential read #5': { kind: 'fs', target: '/fx/p3/home/.npmrc' },
  'macos P3 credential read #6': { kind: 'fs', target: '/fx/p3/home/.docker/config.json' },
  'macos P3 credential read #7': { kind: 'fs', target: '/fx/p3/home/.kube/config' },
  'macos P3 credential read #8': {
    kind: 'fs',
    target: '/fx/p3/home/.config/gcloud/application_default_credentials.json',
  },
  'macos P3 credential read #9': { kind: 'fs', target: '/fx/p3/home/.git-credentials' },
  'macos P3 credential read #10': { kind: 'fs', target: '/fx/p3/home/.netrc' },
  'macos P3 credential read #11': { kind: 'fs', target: '/fx/p3/home/.pypirc' },
  'macos P3 credential read #12': { kind: 'fs', target: '/fx/p3/home/.cargo/credentials.toml' },
  'macos P3 credential read #13': {
    kind: 'fs',
    target: '/fx/p3/home/Library/Application Support/Google/Chrome/Default/Cookies',
  },
  'macos P3 credential read #14': {
    kind: 'fs',
    target: '/fx/p3/home/Library/Application Support/Chromium/Default/Cookies',
  },
  'macos P3 credential read #15': {
    kind: 'fs',
    target: '/fx/p3/home/Library/Application Support/Microsoft Edge/Default/Cookies',
  },
  'macos P3 credential read #16': {
    kind: 'fs',
    target: '/fx/p3/home/Library/Application Support/BraveSoftware/Default/Cookies',
  },
  'macos P3 credential read #17': {
    kind: 'fs',
    target: '/fx/p3/home/Library/Application Support/Arc/Default/Cookies',
  },
  'macos P3 credential read #18': {
    kind: 'fs',
    target: '/fx/p3/home/Library/Application Support/Firefox/Default/Cookies',
  },
  'macos P3 credential read #19': {
    kind: 'fs',
    target: '/fx/p3/home/Library/Safari/Default/Cookies',
  },
  'macos P3 credential read #20': {
    kind: 'fs',
    target: '/fx/p3/home/Library/Cookies/Default/Cookies',
  },
  // Linux, P1
  'linux P1 F1-write-outside': { kind: 'fs', target: '/fx/p1/outside/f1', observed: true },
  'u2404 P1 F4-denyWrite:.envrc #1': DROPPED, // mkdir -p on an existing ancestor
  'u2404 P1 F4-denyWrite:.envrc #2': DROPPED,
  'linux P1 F4-denyWrite:.envrc #1': DROPPED,
  'linux P1 F4-denyWrite:.envrc #2': {
    kind: 'fs',
    target: '/fx/p1/ws/.envrc',
    protected: true,
    observed: true,
  },
  'linux P1 F4-denyWrite:.claude/settings.json #1': DROPPED, // inside allowWrite, no deny on .claude
  'linux P1 F4-denyWrite:.claude/settings.json #2': {
    kind: 'fs',
    target: '/fx/p1/ws/.claude/settings.json',
    protected: true,
    observed: true,
  },
  'linux P1 F4-denyWrite:.mcp.json': {
    kind: 'fs',
    target: '/fx/p1/ws/.mcp.json',
    protected: true,
    observed: true,
  },
  // P1's ws had no .git when wrapped, so the config carries no .git pair on Linux and the write
  // went through (rc=0, the file on the host): inside allowWrite, dropped
  'linux P1 F4-denyWrite:.git/hooks/x #1': DROPPED,
  'linux P1 F4-denyWrite:.git/hooks/x #2': DROPPED,
  'linux P1 F4-denyWrite:.git/hooks/x #3': DROPPED,
  'linux P1 F4-denyWrite:.vscode/tasks.json #1': {
    kind: 'fs',
    target: '/fx/p1/ws/.vscode',
    protected: true,
    observed: true,
  },
  'linux P1 F4-denyWrite:.vscode/tasks.json #2': {
    kind: 'fs',
    target: '/fx/p1/ws/.vscode/tasks.json',
    protected: true,
    observed: true,
  },
  'linux P1 F4-denyWrite:.zshrc': {
    kind: 'fs',
    target: '/fx/p1/ws/.zshrc',
    protected: true,
    observed: true,
  },
  'linux P1 F6-read-only-ws': { kind: 'fs', target: '/fx/p1/ws/ro.txt', observed: true },
  'linux P1 F7-chmod-home': { kind: 'fs', target: '/fx/p1/home', observed: true },
  // the path as written lies inside allowWrite, but out-link leads out and bwrap refused the write
  // where it landed: 读法 11 judges that place, which is also the target (as on macOS)
  'linux P1 F8-symlinks': { kind: 'fs', target: '/fx/p1/outside/via-link', observed: true },
  // Linux, P2
  'linux P2 denied write': { kind: 'fs', target: '/fx/p2/outside/w0', observed: true },
  'linux P2 git status #1': DROPPED,
  'u2404 P2 git status #1': DROPPED,
  'u2404 P2 git status #2': DROPPED,
  'linux P2 git status #2': DROPPED,
  'linux P2 git status #3': { kind: 'fs', target: '/fx/p2/ws/.git/index.lock', observed: true },
  'linux P2 workspace writes #1': DROPPED,
  'linux P2 workspace writes #2': DROPPED,
  'linux P2 workspace writes #3': DROPPED,
  'linux P2 workspace writes #4': DROPPED,
  'linux P2 npm install #1': DROPPED,
  'linux P2 npm install #2': DROPPED,
  'linux P2 npm install #3': DROPPED,
  'linux P2 npm install #4': DROPPED,
  'linux P2 npm install #5': DROPPED,
  'linux P2 npm install #6': DROPPED,
  'linux P2 npm install #7': DROPPED,
  'linux P2 npm install #8': DROPPED,
  // Linux, P3: the whole ~/.config/gcloud is on Linux's list
  'linux P3 gcloud --version #1': DROPPED, // mkdirat on a directory that is there
  'linux P3 gcloud --version #2': {
    kind: 'fs',
    target: '/fx/p3/home/.config/gcloud/logs/2026.10.14/21.49.53.203977.log',
    protected: true,
    observed: true,
  },
  'linux P3 gcloud --version #3': {
    kind: 'fs',
    target: '/fx/p3/home/.config/gcloud/configurations',
    protected: true,
    observed: true,
  },
  'linux P3 gcloud --version #4': {
    kind: 'fs',
    target: '/fx/p3/home/.config/gcloud/configurations/config_default',
    protected: true,
    observed: true,
  },
  'linux P3 gcloud --version #5': DROPPED,
  'linux P3 gcloud --version #6': {
    kind: 'fs',
    target: '/fx/p3/home/.config/gcloud/active_config',
    protected: true,
    observed: true,
  },
  'linux P3 gcloud --version #7': DROPPED,
  'linux P3 gcloud --version #8': {
    kind: 'fs',
    target: '/fx/p3/home/.config/gcloud/gce',
    protected: true,
    observed: true,
  },
  'linux P3 gcloud --version #9': {
    kind: 'fs',
    target: '/fx/p3/home/.config/gcloud/.last_survey_prompt.yaml',
    protected: true,
    observed: true,
  },
}

// --- Tests -----------------------------------------------------------------------------------------

const P1 = '/fx/p1'
const P2 = '/fx/p2'
const P3 = '/fx/p3'

function proxyLine(hostAndPort: string, reason = 'host is not on the allow list'): string {
  return `deny network-outbound ${hostAndPort} (${reason})`
}

function writeLine(path: string): string {
  return `zsh(1) deny(1) file-write-create ${path}`
}

/** Each line's result against one wrap, in order, so one assertion shows every line that differs. */
function classifyAll(lines: readonly string[], wrap: ViolationContext) {
  return lines.map((line) => classify(line, wrap))
}

/** The expected result for one line: dropped, or the literal with its line. */
function resultOf(line: string, want: Expected | typeof DROPPED): SandboxViolation | undefined {
  return want === DROPPED ? undefined : { line, ...want }
}

/** The expected results for `[line, expected]` pairs: each literal with its line. */
function withLines(cases: readonly (readonly [string, Expected])[]): SandboxViolation[] {
  return cases.map(([line, expected]) => ({ line, ...expected }))
}

describe('04 验收 16 (classification): srt violation lines', () => {
  it('the fixture is srt 0.0.79 and every captured line has an expected result, and only those', () => {
    expect(FIXTURE.srt).toBe('0.0.79')
    expect(FIXTURE.lines.map((fixture) => fixture.id).toSorted()).toEqual(
      Object.keys(EXPECTED).toSorted(),
    )
  })

  it.each(FIXTURE.lines.map((fixture) => [fixture.id, fixture] as const))(
    'fixture %s: kind / target / release / protected / observed',
    (id, fixture) => {
      const expected = EXPECTED[id]
      expect(classify(fixture.line, wrapOfFixture(fixture))).toStrictEqual(
        expected === DROPPED ? undefined : { line: fixture.line, ...expected },
      )
    },
  )

  it('a Linux observer write inside allowWrite is dropped', () => {
    const write = wrapOf('linux', 'workspace-write', P2)
    expect(
      classifyAll(
        [
          'deny openat /fx/p2/ws/f1',
          'deny unlinkat /fx/p2/ws/.git/index.lock',
          'deny openat /fx/p2/home/tenon-sandbox-cache/npm/_update-notifier-last-checked',
        ],
        write,
      ),
    ).toStrictEqual([undefined, undefined, undefined])
    // Outside allowWrite, or the same write with nothing writable, stays as a diagnostic.
    expect(classify('deny openat /fx/p2/outside/w0', write)).toStrictEqual({
      kind: 'fs',
      line: 'deny openat /fx/p2/outside/w0',
      target: '/fx/p2/outside/w0',
      observed: true,
    })
    expect(classify('deny openat /fx/p2/ws/f1', wrapOf('linux', 'read-only', P2))).toStrictEqual({
      kind: 'fs',
      line: 'deny openat /fx/p2/ws/f1',
      target: '/fx/p2/ws/f1',
      observed: true,
    })
  })

  it('a Linux observer write on a denyWrite entry is protected', () => {
    const cases = [
      // inside allowWrite, but a denyWrite carve-out
      [
        'deny openat /fx/p1/ws/.envrc',
        { kind: 'fs', target: '/fx/p1/ws/.envrc', protected: true, observed: true },
      ],
      // a denyRead entry carried into denyWrite
      [
        'deny openat /fx/p1/home/.ssh/authorized_keys',
        {
          kind: 'fs',
          target: '/fx/p1/home/.ssh/authorized_keys',
          protected: true,
          observed: true,
        },
      ],
      [
        'deny openat /fx/p1/outside/f1',
        { kind: 'fs', target: '/fx/p1/outside/f1', observed: true },
      ],
    ] as const
    const wrap = wrapOf('linux', 'workspace-write', P1)
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrap,
      ),
    ).toStrictEqual(withLines(cases))
  })

  it('a Linux observer write is judged where it lands (读法 11): through a link spelling of the workspace it is dropped; through a workspace link that leads out it stays, targeting where it landed; onto a protected file, or a protected name reached by the link spelling, it is protected', () => {
    const cases = [
      ['deny openat /fx/p4/home/code/proj/b.txt', DROPPED],
      [
        'deny openat /fx/p4/mnt/code/proj/out-link/f',
        { kind: 'fs', target: '/fx/p4/outside/f', observed: true },
      ],
      [
        'deny openat /fx/p4/mnt/code/proj/rc-link',
        { kind: 'fs', target: '/fx/p4/home/.bashrc', protected: true, observed: true },
      ],
      [
        'deny openat /fx/p4/home/code/proj/.envrc',
        { kind: 'fs', target: '/fx/p4/mnt/code/proj/.envrc', protected: true, observed: true },
      ],
    ] as const
    expect(
      classifyAll(
        cases.map(([line]) => line),
        linkedWrap(P4_WS),
      ),
    ).toStrictEqual(cases.map(([line, want]) => resultOf(line, want)))
  })

  it('a Linux observer call on a link itself (unlinkat, renameat, mkdirat …) is judged at the link; one through it (openat, fchmodat …) at its target, a dangling one included; another call (x64’s older ones) is dropped only when both readings land in allowWrite', () => {
    const cases = [
      ['deny unlinkat /fx/p4/mnt/code/proj/out-link', DROPPED],
      ['deny renameat2 /fx/p4/mnt/code/proj/out-link', DROPPED],
      [
        'deny fchmodat /fx/p4/mnt/code/proj/out-link',
        { kind: 'fs', target: '/fx/p4/outside', observed: true },
      ],
      [
        'deny openat /fx/p4/mnt/code/proj/new-link',
        { kind: 'fs', target: '/fx/p4/outside/not-yet', observed: true },
      ],
      // x64: unlink acts on the link (outside), chmod would follow it (into the workspace)
      [
        'deny unlink /fx/p4/outside/ws-link',
        { kind: 'fs', target: '/fx/p4/outside/ws-link', observed: true },
      ],
      ['deny chmod /fx/p4/home/code/proj/f', DROPPED],
    ] as const
    expect(
      classifyAll(
        cases.map(([line]) => line),
        linkedWrap(P4_WS),
      ),
    ).toStrictEqual(cases.map(([line, want]) => resultOf(line, want)))
  })

  it('a Linux observer write on a denyWrite entry as spelled is protected even where it lands inside allowWrite (~/.ssh/config a link into a dotfiles dir, the home the workspace)', () => {
    expect(classify('deny openat /fx/p4/home/.ssh/config', linkedWrap(P4_HOME))).toStrictEqual({
      kind: 'fs',
      line: 'deny openat /fx/p4/home/.ssh/config',
      target: '/fx/p4/home/dotfiles/ssh/config',
      protected: true,
      observed: true,
    })
  })

  it('a Linux observer path under /proc or /dev is judged as spelled, never resolved into Tenon’s own process', () => {
    // /proc/self/fd/3 and /dev/stdout lead, on the host, to files of the workspace
    expect(
      classifyAll(['deny openat /proc/self/fd/3', 'deny openat /dev/stdout'], linkedWrap(P4_WS)),
    ).toStrictEqual([
      {
        kind: 'fs',
        line: 'deny openat /proc/self/fd/3',
        target: '/proc/self/fd/3',
        observed: true,
      },
      { kind: 'fs', line: 'deny openat /dev/stdout', target: '/dev/stdout', observed: true },
    ])
  })

  it('a Linux observer path that cannot be resolved (lstat or readlink throws) stays, as spelled', () => {
    const wrap = linkedWrap(P4_WS)
    const throwing: ViolationContext = {
      ...wrap,
      lstat: (path) => {
        if (path === '/fx/p4/home/code')
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return wrap.lstat(path)
      },
      readlink: (path) => {
        if (path === '/fx/p4/mnt/code/proj/rc-link') throw noLink(path)
        return wrap.readlink(path)
      },
    }
    expect(
      classifyAll(
        ['deny openat /fx/p4/home/code/proj/b.txt', 'deny openat /fx/p4/mnt/code/proj/rc-link'],
        throwing,
      ),
    ).toStrictEqual([
      {
        kind: 'fs',
        line: 'deny openat /fx/p4/home/code/proj/b.txt',
        target: '/fx/p4/home/code/proj/b.txt',
        observed: true,
      },
      {
        kind: 'fs',
        line: 'deny openat /fx/p4/mnt/code/proj/rc-link',
        target: '/fx/p4/mnt/code/proj/rc-link',
        observed: true,
      },
    ])
  })

  it('a wrap looks each directory of the observer paths up once', () => {
    const wrap = linkedWrap(P4_WS)
    const looked = new Map<string, number>()
    const counting: ViolationContext = {
      ...wrap,
      lstat: (path) => {
        looked.set(path, (looked.get(path) ?? 0) + 1)
        return wrap.lstat(path)
      },
    }
    const lines = ['a', 'b', 'c'].map((name) => `deny openat /fx/p4/home/code/proj/${name}`)
    expect(classifyAll(lines, counting)).toStrictEqual([undefined, undefined, undefined])
    expect(looked.get('/fx/p4/mnt/code/proj')).toBe(1)
  })

  it('an IP literal, a numeric host, localhost, *.localhost, a malformed host or a `resolved to …` denial offers no domain release', () => {
    const cases: [string, Expected][] = [
      [proxyLine('1.1.1.1:80'), { kind: 'network', target: '1.1.1.1' }],
      [proxyLine('169.254.169.254:80'), { kind: 'network', target: '169.254.169.254' }],
      [proxyLine('2130706433:80'), { kind: 'network', target: '127.0.0.1' }],
      [proxyLine('127.1:8080'), { kind: 'network', target: '127.0.0.1' }],
      [proxyLine('0x7f.0.0.1:8080'), { kind: 'network', target: '127.0.0.1' }],
      [proxyLine('::1:443'), { kind: 'network', target: '::1' }],
      [proxyLine('[::1]:443'), { kind: 'network', target: '::1' }],
      [proxyLine('localhost:8080'), { kind: 'network', target: 'localhost' }],
      [proxyLine('LocalHost.:8080'), { kind: 'network', target: 'localhost' }],
      [proxyLine('api.localhost:8080'), { kind: 'network', target: 'api.localhost' }],
      [proxyLine('Dev.LOCALHOST:8080'), { kind: 'network', target: 'dev.localhost' }],
      [proxyLine('example.com:443', 'malformed host'), { kind: 'network', target: 'example.com' }],
      [proxyLine('evil.com\u0000.example.com:443', 'malformed host'), { kind: 'network' }],
      [proxyLine('a b(1) deny(1) file-write-create /x:443', 'malformed host'), { kind: 'network' }],
      // outside srt's host charset: no target, though the URL parser would take this one
      [proxyLine('exa$mple.com:443', 'malformed host'), { kind: 'network' }],
      [
        proxyLine('tenon-probe-loopback.test:50109', 'resolved to a loopback address'),
        { kind: 'network', target: 'tenon-probe-loopback.test' },
      ],
      [
        proxyLine('metadata.example:80', 'resolved to a link-local address'),
        { kind: 'network', target: 'metadata.example' },
      ],
      [
        proxyLine('example.com:443', 'host is on the deny list'),
        { kind: 'network', target: 'example.com' },
      ],
      // the one that does: an off-list domain name, spelled as the URL parser spells it
      [
        proxyLine('Example.COM.:443'),
        { kind: 'network', target: 'example.com', release: 'domain' },
      ],
    ]
    const wrap = wrapOf('darwin', 'workspace-write', P1)
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrap,
      ),
    ).toStrictEqual(withLines(cases))
  })

  it("an off-list name srt's allowedDomains schema refuses (no dot, a leading dot) or one with an empty label offers no domain release", () => {
    // past the spec table's "a domain, not localhost" (plan Open 2026-10-15「域名按钮只给 srt schema
    // 收的名字」): such a button would make every later restricted wrap fail srt's schema
    const cases: [string, Expected][] = [
      [proxyLine('db:5432'), { kind: 'network', target: 'db' }],
      [proxyLine('com:80'), { kind: 'network', target: 'com' }],
      [proxyLine('.example.com:80'), { kind: 'network', target: '.example.com' }],
      // srt's schema takes this one; Tenon refuses the empty label itself
      [proxyLine('a..example.com:80'), { kind: 'network', target: 'a..example.com' }],
      [proxyLine('..:80'), { kind: 'network', target: '.' }],
      // srt takes `.` as a host; without its trailing dot nothing is left to name
      [proxyLine('.:80'), { kind: 'network' }],
      [proxyLine('example.com:443'), { kind: 'network', target: 'example.com', release: 'domain' }],
    ]
    const wrap = wrapOf('darwin', 'workspace-write', P1)
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrap,
      ),
    ).toStrictEqual(withLines(cases))
  })

  it('a proxy-shaped line whose host srt would never pass as valid gets no target and no release', () => {
    // srt says `host is not on the allow list` only for a host its isValidHost takes (srt79
    // parent-proxy.js:369-381), so such a line is forged. Only the first can come through srt: the
    // Linux observer writes `deny <syscall> <path>` with the syscall from the sandboxed process
    // (header, shape 2), so syscall `network-outbound` and a path `/example.com:443 (…)` make it;
    // its path always starts with ` /`, so the other three reach classify from no srt source and
    // are defensive cases. The URL parser would read all four as `example.com`. A host outside
    // isValidHost's charset gets no target, past the spec table (plan Open 2026-10-15「HOST_NAME
    // 外的主机名不给 target」).
    const lines = [
      proxyLine('/example.com:443'),
      proxyLine('user@example.com:443'),
      proxyLine('example.com/x:443'),
      proxyLine('example.com?x:443'),
    ]
    expect(classifyAll(lines, wrapOf('linux', 'workspace-write', P1))).toStrictEqual(
      lines.map((line) => ({ kind: 'network', line })),
    )
  })

  it('a Seatbelt line carries `<proc>(<pid>) `; a bare `deny(1) …` line or a process name with parentheses matches nothing', () => {
    const cases: [string, Expected][] = [
      [
        'zsh(74865) deny(1) file-write-create /fx/p1/outside/f1',
        { kind: 'fs', target: '/fx/p1/outside/f1', release: 'path' },
      ],
      [
        'Google Chrome Helper(812) deny(1) file-write-create /fx/p1/outside/f1',
        { kind: 'fs', target: '/fx/p1/outside/f1', release: 'path' },
      ],
      [
        'cat(75125) deny(1) file-read-data /fx/p1/home/tenon-profile/config.json',
        { kind: 'fs', target: '/fx/p1/home/tenon-profile/config.json', protected: true },
      ],
      ['deny(1) file-write-create /fx/p1/outside/f1', { kind: 'fs' }],
      ['deny(1) file-read-data /fx/p1/home/tenon-profile/config.json', { kind: 'fs' }],
      ['deny(1) network-outbound remote:*:80', { kind: 'fs' }],
      ['Helper (GPU)(812) deny(1) file-write-create /fx/p1/outside/f1', { kind: 'fs' }],
      ['x)(1) deny(1) mach-lookup com.apple.authd', { kind: 'fs' }],
      ['curl(1)(2) deny(1) network-outbound', { kind: 'fs' }],
      // a name ending in `(<pid>) deny(1) <listed operation> x` must not hide the real denial
      [
        'n(1) deny(1) mach-lookup x(999) deny(1) file-write-create /fx/p1/outside/f1',
        { kind: 'fs' },
      ],
      [
        'n(1) deny(1) sysctl-read x(999) deny(1) file-read-data /fx/p1/home/tenon-profile/config.json',
        { kind: 'fs' },
      ],
    ]
    const wrap = wrapOf('darwin', 'workspace-write', P1)
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrap,
      ),
    ).toStrictEqual(withLines(cases))
  })

  it('a Seatbelt network-outbound line, with `remote:*:<port>` or nothing after it, is network with no target, no release and observed', () => {
    const lines = [
      'curl(76620) deny(1) network-outbound remote:*:80',
      'curl(76720) deny(1) network-outbound remote:*:50109',
      'node(80280) deny(1) network-outbound',
    ]
    expect(classifyAll(lines, wrapOf('darwin', 'workspace-write', P1))).toStrictEqual(
      lines.map((line) => ({ kind: 'network', line, observed: true })),
    )
  })

  it('a mach-lookup line (authd, DNSConfiguration) is fs with no target and observed', () => {
    const lines = [
      'git-credential-osxkeychain(82516) deny(1) mach-lookup com.apple.authd (xpc)',
      'node(80587) deny(1) mach-lookup com.apple.SystemConfiguration.DNSConfiguration',
    ]
    expect(classifyAll(lines, wrapOf('darwin', 'workspace-write', P1))).toStrictEqual(
      lines.map((line) => ({ kind: 'fs', line, observed: true })),
    )
  })

  it('a recognized Seatbelt line whose operation is outside the closed list (appleevent-send, process-exec, signal, iokit-open) is fs with no target and not observed', () => {
    const lines = [
      'osascript(901) deny(1) appleevent-send com.apple.systemevents',
      'zsh(902) deny(1) process-exec* /usr/bin/open',
      'kill(903) deny(1) signal target:1',
      'ioreg(904) deny(1) iokit-open IOSurfaceRootUserClient',
    ]
    expect(classifyAll(lines, wrapOf('darwin', 'workspace-write', P1))).toStrictEqual(
      lines.map((line) => ({ kind: 'fs', line })),
    )
  })

  it('on linux a Seatbelt-shaped observer line (`deny x(1) deny(1) file-write-create /…`) offers nothing', () => {
    // srt writes `deny ${syscall} ${path}` from what the sandboxed process sends to the observer
    // socket, the syscall unchecked (srt79 linux-violation-monitor.js:76-82, :102-116)
    const lines = [
      'deny x(1) deny(1) file-write-create /fx/p1/outside/f1',
      'deny x(1) deny(1) file-read-data /fx/p1/home/tenon-profile/config.json',
      'deny x(1) deny(1) mach-lookup /fx/p1/outside/f1',
    ]
    expect(classifyAll(lines, wrapOf('linux', 'workspace-write', P1))).toStrictEqual(
      lines.map((line) => ({ kind: 'fs', line })),
    )
  })

  it('a line that matches no format is fs with no target and not observed', () => {
    const lines = ['', 'deny', 'something went wrong', 'allow openat /fx/p1/outside/f1']
    expect(classifyAll(lines, wrapOf('linux', 'workspace-write', P1))).toStrictEqual(
      lines.map((line) => ({ kind: 'fs', line })),
    )
  })

  it('a Linux observer mkdirat on a directory that exists when it arrives is dropped; on one that does not, it stays (observed)', () => {
    const lines = [
      'deny mkdirat /fx/p1/outside',
      'deny mkdirat /fx/p1/home/.ssh',
      'deny mkdirat /fx/p1/outside/new',
      // a file of that name, or a link, is no directory
      'deny mkdirat /fx/p1/outside/a-file',
      'deny mkdirat /fx/p1/ws/out-link',
      // only mkdirat: another call on an existing directory stays
      'deny fchmodat /fx/p1/outside',
    ]
    // read-only, so nothing is dropped for being writable
    expect(classifyAll(lines, wrapOf('linux', 'read-only', P1))).toStrictEqual([
      undefined,
      undefined,
      {
        kind: 'fs',
        line: 'deny mkdirat /fx/p1/outside/new',
        target: '/fx/p1/outside/new',
        observed: true,
      },
      {
        kind: 'fs',
        line: 'deny mkdirat /fx/p1/outside/a-file',
        target: '/fx/p1/outside/a-file',
        observed: true,
      },
      {
        kind: 'fs',
        line: 'deny mkdirat /fx/p1/ws/out-link',
        target: '/fx/p1/ws/out-link',
        observed: true,
      },
      {
        kind: 'fs',
        line: 'deny fchmodat /fx/p1/outside',
        target: '/fx/p1/outside',
        observed: true,
      },
    ])
  })

  it('a write denial on the home dir, an existing dir or a newline-cut path offers no path release', () => {
    const cases: [string, Expected][] = [
      ['chmod(75355) deny(1) file-write-mode /fx/p1/home', { kind: 'fs', target: '/fx/p1/home' }],
      [
        'touch(1) deny(1) file-write-times /fx/p1/outside/existing',
        { kind: 'fs', target: '/fx/p1/outside/existing' },
      ],
      // a file named "\nx" in outside/: srt splits the log at the newline
      [writeLine('/fx/p1/outside/'), { kind: 'fs', target: '/fx/p1/outside/' }],
      [writeLine('/'), { kind: 'fs', target: '/' }],
      // and the one that does
      [
        writeLine('/fx/p1/outside/f1'),
        { kind: 'fs', target: '/fx/p1/outside/f1', release: 'path' },
      ],
    ]
    const wrap = wrapOf('darwin', 'read-only', P1)
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrap,
      ),
    ).toStrictEqual(withLines(cases))
  })

  it('a write denial offers a path release only when 读法 35 holds: normalized, parent its own real path, no denied entry below it', () => {
    const cases: [string, Expected][] = [
      // not normalized
      [
        writeLine('/fx/p1/outside/../outside/f1'),
        { kind: 'fs', target: '/fx/p1/outside/../outside/f1' },
      ],
      [writeLine('/fx/p1/outside//f1'), { kind: 'fs', target: '/fx/p1/outside//f1' }],
      // the parent is missing, reached through a link, or a file
      [writeLine('/fx/p1/outside/missing/f1'), { kind: 'fs', target: '/fx/p1/outside/missing/f1' }],
      [writeLine('/fx/p1/ws/out-link/f1'), { kind: 'fs', target: '/fx/p1/ws/out-link/f1' }],
      [writeLine('/fx/p1/linked/sub/f1'), { kind: 'fs', target: '/fx/p1/linked/sub/f1' }],
      [writeLine('/fx/p1/outside/a-file/f1'), { kind: 'fs', target: '/fx/p1/outside/a-file/f1' }],
      // an existing directory above the home directory (refused as an existing directory; each
      // anchor on its own is the next test), and a missing one above a credential-list entry
      // (~/.cache/huggingface/token)
      [writeLine('/fx/p1'), { kind: 'fs', target: '/fx/p1' }],
      [writeLine('/fx/p1/home/.cache'), { kind: 'fs', target: '/fx/p1/home/.cache' }],
      // a sibling of a denied entry is not above it
      [
        writeLine('/fx/user-data/sandbox-cwd-not'),
        { kind: 'fs', target: '/fx/user-data/sandbox-cwd-not', release: 'path' },
      ],
      // the chdir directory itself is on denyWrite, so a write there is protected
      [
        writeLine('/fx/user-data/sandbox-cwd'),
        { kind: 'fs', target: '/fx/user-data/sandbox-cwd', protected: true },
      ],
    ]
    const wrap = wrapOf('darwin', 'read-only', P1)
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrap,
      ),
    ).toStrictEqual(withLines(cases))
  })

  it('each 读法 35 anchor refuses on its own: the home dir, the profile dir, a denyRead or a denyWrite entry, or an ancestor of one', () => {
    // Nothing under /fx/q is on disk and the lists hold one entry each, so no other rule refuses:
    // in the app the home and profile dirs exist and denyWrite carries denyRead (不变量 6), which
    // hides each anchor behind the existing-directory rule or another anchor.
    const bare: ViolationContext = {
      allowWrite: [],
      denyWrite: [],
      denyRead: [],
      profileDirs: ['/fx/elsewhere/profile'],
      homeDir: '/fx/elsewhere/home',
      lstat: (path) => (path === '/fx' || path === '/fx/q' ? is('dir') : undefined),
      readlink: (path) => {
        throw noLink(path)
      },
    }
    const anchored: [string, ViolationContext, string][] = [
      ['home dir', { ...bare, homeDir: '/fx/q/home' }, '/fx/q/home'],
      ['above the home dir', { ...bare, homeDir: '/fx/q/up/home' }, '/fx/q/up'],
      ['profile dir', { ...bare, profileDirs: ['/fx/q/profile'] }, '/fx/q/profile'],
      // its real path, the second spelling
      [
        'above the profile dir',
        { ...bare, profileDirs: ['/fx/link/profile', '/fx/q/up/profile'] },
        '/fx/q/up',
      ],
      ['denyRead entry', { ...bare, denyRead: [literal('/fx/q/token')] }, '/fx/q/token'],
      ['above a denyRead entry', { ...bare, denyRead: [literal('/fx/q/up/token')] }, '/fx/q/up'],
      ['above a denyWrite entry', { ...bare, denyWrite: [literal('/fx/q/up/hook')] }, '/fx/q/up'],
      // a glob stands for the directories before its first wildcard
      ['above a denyWrite glob', { ...bare, denyWrite: ['/fx/q/up/**/.envrc'] }, '/fx/q/up'],
    ]
    expect(
      anchored.map(([anchor, wrap, target]) => [anchor, classify(writeLine(target), wrap)]),
    ).toStrictEqual(
      anchored.map(([anchor, , target]) => [
        anchor,
        { kind: 'fs', line: writeLine(target), target },
      ]),
    )
    // and the same wraps offer the release for a path no anchor touches
    expect(
      anchored.map(([anchor, wrap]) => [anchor, classify(writeLine('/fx/q/free'), wrap)]),
    ).toStrictEqual(
      anchored.map(([anchor]) => [
        anchor,
        { kind: 'fs', line: writeLine('/fx/q/free'), target: '/fx/q/free', release: 'path' },
      ]),
    )
  })

  it('a Seatbelt write on a case variant of a protected name is protected and offers no release (case-insensitive APFS)', () => {
    // P1 F11 and F12 on macOS 26.3: Seatbelt refused each one and logged the name as written
    const cases: [string, Expected][] = [
      [
        'zsh(75476) deny(1) file-write-create /fx/p1/ws/.ENVRC',
        { kind: 'fs', target: '/fx/p1/ws/.ENVRC', protected: true },
      ],
      [
        'zsh(75516) deny(1) file-write-create /fx/p1/ws/.Envrc',
        { kind: 'fs', target: '/fx/p1/ws/.Envrc', protected: true },
      ],
      [
        'zsh(75720) deny(1) file-write-create /fx/p1/ws/.Mcp.json',
        { kind: 'fs', target: '/fx/p1/ws/.Mcp.json', protected: true },
      ],
      [
        'zsh(75744) deny(1) file-write-create /fx/p1/ws/.ZSHRC',
        { kind: 'fs', target: '/fx/p1/ws/.ZSHRC', protected: true },
      ],
      [
        'zsh(76463) deny(1) file-write-create /fx/p1/home/.ZSHRC',
        { kind: 'fs', target: '/fx/p1/home/.ZSHRC', protected: true },
      ],
      // the parent of a protected name, as the lower-case .claude and .git are
      [
        'mkdir(75638) deny(1) file-write-create /fx/p1/ws/.Claude',
        { kind: 'fs', target: '/fx/p1/ws/.Claude' },
      ],
      [
        'mkdir(75697) deny(1) file-write-create /fx/p1/ws/.CLAUDE',
        { kind: 'fs', target: '/fx/p1/ws/.CLAUDE' },
      ],
      [
        'mkdir(75753) deny(1) file-write-create /fx/p1/ws/.Git',
        { kind: 'fs', target: '/fx/p1/ws/.Git' },
      ],
      // a glob entry in a sub-directory, and above a credential-list entry
      [
        'zsh(1) deny(1) file-write-create /fx/p1/ws/sub/.ENVRC',
        { kind: 'fs', target: '/fx/p1/ws/sub/.ENVRC', protected: true },
      ],
      [
        'mkdir(1) deny(1) file-write-create /fx/p1/home/.CACHE',
        { kind: 'fs', target: '/fx/p1/home/.CACHE' },
      ],
      // a read in the profile dir under another case
      [
        'cat(1) deny(1) file-read-data /fx/p1/home/Tenon-Profile/config.json',
        { kind: 'fs', target: '/fx/p1/home/Tenon-Profile/config.json', protected: true },
      ],
    ]
    const wrap = wrapOf('darwin', 'workspace-write', P1)
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrap,
      ),
    ).toStrictEqual(withLines(cases))
  })

  it('a Seatbelt path under a name APFS folds to a protected one (ſ → s, ﬁ → fi) is protected and offers no release', () => {
    // APFS on macOS 26.3 opens .zshrc as `.zſhrc` (U+017F) and .gitconfig as `.gitconﬁg` (U+FB01);
    // JavaScript's toLowerCase keeps both letters as they are
    const cases: [string, Expected][] = [
      [
        writeLine('/fx/p1/ws/.mcp.jſon'),
        { kind: 'fs', target: '/fx/p1/ws/.mcp.jſon', protected: true },
      ],
      [
        writeLine('/fx/p1/ws/.gitconﬁg'),
        { kind: 'fs', target: '/fx/p1/ws/.gitconﬁg', protected: true },
      ],
      [
        writeLine('/fx/p1/home/.zſhrc'),
        { kind: 'fs', target: '/fx/p1/home/.zſhrc', protected: true },
      ],
      [
        writeLine('/fx/p1/home/.ſsh/authorized_keys'),
        { kind: 'fs', target: '/fx/p1/home/.ſsh/authorized_keys', protected: true },
      ],
      [
        writeLine('/fx/p1/home/tenon-proﬁle/config.json'),
        { kind: 'fs', target: '/fx/p1/home/tenon-proﬁle/config.json', protected: true },
      ],
      [
        'cat(1) deny(1) file-read-data /fx/p1/home/tenon-proﬁle/config.json',
        { kind: 'fs', target: '/fx/p1/home/tenon-proﬁle/config.json', protected: true },
      ],
      // a glob entry in a sub-directory
      [
        writeLine('/fx/p1/ws/sub/.vſcode'),
        { kind: 'fs', target: '/fx/p1/ws/sub/.vſcode', protected: true },
      ],
    ]
    const wrap = wrapOf('darwin', 'workspace-write', P1)
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrap,
      ),
    ).toStrictEqual(withLines(cases))
  })

  it('a Seatbelt path in another Unicode normalization than its entry (NFD against NFC) is protected; the Linux observer compares bytes', () => {
    const nfc = '/fx/Café'
    const nfd = '/fx/Café'
    const cases: [string, Expected][] = [
      [writeLine(`${nfd}/ws/.envrc`), { kind: 'fs', target: `${nfd}/ws/.envrc`, protected: true }],
      [
        writeLine(`${nfd}/ws/sub/.envrc`),
        { kind: 'fs', target: `${nfd}/ws/sub/.envrc`, protected: true },
      ],
      [
        `cat(1) deny(1) file-read-data ${nfd}/home/tenon-profile/config.json`,
        { kind: 'fs', target: `${nfd}/home/tenon-profile/config.json`, protected: true },
      ],
    ]
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrapOf('darwin', 'workspace-write', nfc),
      ),
    ).toStrictEqual(withLines(cases))
    // ext4 keeps the two spellings apart: the NFD path is neither the denyWrite entry nor inside
    // the NFC workspace, so it stays as a plain diagnostic; the NFC one is protected
    const linux: [string, Expected][] = [
      [`deny openat ${nfd}/ws/.envrc`, { kind: 'fs', target: `${nfd}/ws/.envrc`, observed: true }],
      [
        `deny openat ${nfc}/ws/.envrc`,
        { kind: 'fs', target: `${nfc}/ws/.envrc`, protected: true, observed: true },
      ],
    ]
    expect(
      classifyAll(
        linux.map(([line]) => line),
        wrapOf('linux', 'workspace-write', nfc),
      ),
    ).toStrictEqual(withLines(linux))
  })

  it('a Linux observer path compares case by case: a case variant is no denyWrite entry', () => {
    const wrap = wrapOf('linux', 'workspace-write', P1)
    // ext4 tells .ENVRC from .envrc: inside allowWrite and not protected, so dropped
    expect(classify('deny openat /fx/p1/ws/.ENVRC', wrap)).toBeUndefined()
  })

  it('a Seatbelt read in the profile dir is protected under either spelling, the written one or the real path', () => {
    // the profile is under /fx/var, a link to /fx/private/var; Seatbelt logs the real path
    const wrap = {
      ...wrapOf('darwin', 'workspace-write', P1),
      profileDirs: ['/fx/var/folders/t/profile', '/fx/private/var/folders/t/profile'],
    }
    const cases: [string, Expected][] = [
      [
        'cat(1) deny(1) file-read-data /fx/private/var/folders/t/profile/config.json',
        {
          kind: 'fs',
          target: '/fx/private/var/folders/t/profile/config.json',
          protected: true,
        },
      ],
      [
        'cat(1) deny(1) file-read-data /fx/var/folders/t/profile/config.json',
        { kind: 'fs', target: '/fx/var/folders/t/profile/config.json', protected: true },
      ],
    ]
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrap,
      ),
    ).toStrictEqual(withLines(cases))
  })

  it('a write denial on an existing link offers no path release', () => {
    // allowWrite gets real paths only: a link to a directory would give that whole subtree. Past
    // 读法 35's "not an existing directory" (plan Open 2026-10-15「已存在的链接不给仅此路径」)
    const cases: [string, Expected][] = [
      [writeLine('/fx/p1/linked'), { kind: 'fs', target: '/fx/p1/linked' }],
      [writeLine('/fx/p1/ws/out-link'), { kind: 'fs', target: '/fx/p1/ws/out-link' }],
    ]
    const wrap = wrapOf('darwin', 'read-only', P1)
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrap,
      ),
    ).toStrictEqual(withLines(cases))
  })

  it('a throwing lstat (ENOTDIR, EACCES) never throws out of classify and offers no release', () => {
    const throws = new Map([
      ['/fx/p1/outside/f1', 'EACCES'],
      ['/fx/p1/outside/locked', 'EACCES'],
      ['/fx/p1/outside/a-file/x', 'ENOTDIR'],
    ])
    function throwing(path: string): PathKind | undefined {
      const code = throws.get(path)
      if (code !== undefined) throw Object.assign(new Error(`${code}: ${path}`), { code })
      return lstat(path)
    }
    const darwin = { ...wrapOf('darwin', 'read-only', P1), lstat: throwing }
    const linux = { ...wrapOf('linux', 'read-only', P1), lstat: throwing }
    const cases: [string, Expected][] = [
      [writeLine('/fx/p1/outside/f1'), { kind: 'fs', target: '/fx/p1/outside/f1' }],
      [writeLine('/fx/p1/outside/locked/f1'), { kind: 'fs', target: '/fx/p1/outside/locked/f1' }],
    ]
    expect(
      classifyAll(
        cases.map(([line]) => line),
        darwin,
      ),
    ).toStrictEqual(withLines(cases))
    // a mkdirat whose lstat throws is not known to be a no-op, so it stays
    expect(classify('deny mkdirat /fx/p1/outside/a-file/x', linux)).toStrictEqual({
      kind: 'fs',
      line: 'deny mkdirat /fx/p1/outside/a-file/x',
      target: '/fx/p1/outside/a-file/x',
      observed: true,
    })
  })

  it('a Seatbelt write under a protected name in a sub-directory (a glob entry) is protected', () => {
    const paths = [
      '/fx/p1/ws/sub/.envrc',
      '/fx/p1/ws/sub/.vscode',
      '/fx/p1/ws/sub/.git/hooks/pre-commit',
      '/fx/p1/ws/sub/deeper/.claude/settings.json',
    ]
    expect(
      classifyAll(paths.map(writeLine), wrapOf('darwin', 'workspace-write', P1)),
    ).toStrictEqual(
      paths.map((path) => ({ kind: 'fs', line: writeLine(path), target: path, protected: true })),
    )
    // a root holding regex metacharacters is matched as written, and classify does not throw
    // (step 4 calls it from srt's store listener with no try around it)
    const roots = ['/fx/c++ (copy)$', '/fx/a$b (copy)']
    expect(
      roots.map((root) =>
        classifyAll(
          [writeLine(`${root}/ws/sub/.envrc`), writeLine(`${root}/ws/sub/.vscode`)],
          wrapOf('darwin', 'workspace-write', root),
        ),
      ),
    ).toStrictEqual([
      [
        {
          kind: 'fs',
          line: writeLine('/fx/c++ (copy)$/ws/sub/.envrc'),
          target: '/fx/c++ (copy)$/ws/sub/.envrc',
          protected: true,
        },
        {
          kind: 'fs',
          line: writeLine('/fx/c++ (copy)$/ws/sub/.vscode'),
          target: '/fx/c++ (copy)$/ws/sub/.vscode',
          protected: true,
        },
      ],
      [
        {
          kind: 'fs',
          line: writeLine('/fx/a$b (copy)/ws/sub/.envrc'),
          target: '/fx/a$b (copy)/ws/sub/.envrc',
          protected: true,
        },
        {
          kind: 'fs',
          line: writeLine('/fx/a$b (copy)/ws/sub/.vscode'),
          target: '/fx/a$b (copy)/ws/sub/.vscode',
          protected: true,
        },
      ],
    ])
  })

  it('a read denial under .ssh or the credential list is not protected; under the profile dir it is', () => {
    const cases: [string, Expected][] = [
      [
        'cat(1) deny(1) file-read-data /fx/p3/home/.ssh/id_ed25519',
        { kind: 'fs', target: '/fx/p3/home/.ssh/id_ed25519' },
      ],
      [
        'cat(1) deny(1) file-read-data /fx/p3/home/.aws/credentials',
        { kind: 'fs', target: '/fx/p3/home/.aws/credentials' },
      ],
      [
        'cat(1) deny(1) file-read-data /fx/p3/home/.gnupg/private-keys-v1.d/probe.key',
        { kind: 'fs', target: '/fx/p3/home/.gnupg/private-keys-v1.d/probe.key' },
      ],
      [
        'cat(1) deny(1) file-read-data /fx/p3/home/.npmrc',
        { kind: 'fs', target: '/fx/p3/home/.npmrc' },
      ],
      [
        'cat(1) deny(1) file-read-data /fx/p3/home/.kube/config',
        { kind: 'fs', target: '/fx/p3/home/.kube/config' },
      ],
      [
        'cat(1) deny(1) file-read-data /fx/p3/home/Library/Cookies/Default/Cookies',
        { kind: 'fs', target: '/fx/p3/home/Library/Cookies/Default/Cookies' },
      ],
      [
        'cat(1) deny(1) file-read-data /fx/p3/home/tenon-profile/config.json',
        { kind: 'fs', target: '/fx/p3/home/tenon-profile/config.json', protected: true },
      ],
      [
        'ls(1) deny(1) file-read-metadata /fx/p3/home/tenon-profile',
        { kind: 'fs', target: '/fx/p3/home/tenon-profile', protected: true },
      ],
    ]
    const wrap = wrapOf('darwin', 'workspace-write', P3)
    expect(
      classifyAll(
        cases.map(([line]) => line),
        wrap,
      ),
    ).toStrictEqual(withLines(cases))
  })

  it('a line that does not match exactly offers nothing', () => {
    const lines = [
      // a second "Sandbox:" (读法 44)
      'Sandbox: zsh(75157) deny(1) file-write-create /fx/p1/outside/f1',
      ' zsh(75157) deny(1) file-write-create /fx/p1/outside/f1',
      'zsh(75157) deny(2) file-write-create /fx/p1/outside/f1',
      'zsh(75157)  deny(1) file-write-create /fx/p1/outside/f1',
      'zsh(75157) deny(1) file-write-create /fx/p1/outside/f1\nmore',
      'zsh(75157) deny(1) file-write-create relative/f1',
      'curl(1) deny(1) network-outbound remote:1.1.1.1:80',
      'curl(1) deny(1) network-outbound /private/var/run/some.sock',
      'deny network-outbound example.com:80 (host is not on the allow list) ',
      'deny network-outbound example.com (host is not on the allow list)',
      'deny network-outbound example.com:80 (host is not on the allow list)(x)',
      'deny network-outbound example.com:80',
      'deny OPENAT /fx/p1/outside/f1',
      'deny openat fx/p1/outside/f1',
      'deny openat /fx/p1/outside/f1\n',
      // a `Sandbox:` anywhere, not only in the process name (读法 44)
      'zsh(1) deny(1) file-write-create /fx/p1/outside/Sandbox: x',
      // a control character: srt cuts the log at newlines and its store turns the rest into
      // spaces, so neither a raw SOCKS host nor an observer path carries a Seatbelt line in
      'deny network-outbound a\nb(1) deny(1) file-write-create /fx/p1/outside/x:443 (malformed host)',
      'deny network-outbound a\nb(1) deny(1) mach-lookup com.apple.x:443 (malformed host)',
      'deny openat /fx/p1/outside/a\nb(1) deny(1) file-write-create /fx/p1/outside/evil',
      'a\nzsh(1) deny(1) file-write-create /fx/p1/outside/f1',
      'zsh\u0007(1) deny(1) file-write-create /fx/p1/outside/f1',
    ]
    expect(classifyAll(lines, wrapOf('darwin', 'workspace-write', P1))).toStrictEqual(
      lines.map((line) => ({ kind: 'fs', line })),
    )
  })
})
