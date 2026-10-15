/**
 * Spec 04 §启动、自检与姿态: the sandbox's startup against a fake sandbox-runtime, a fake disk, a fake
 * process table and a fake runner (04 验收 2; 验收 9 the startup half; 读法 4, 50; P1, P5, P7). The
 * wording fixtures are srt79's own text, copied with their file and line, and the last test reads the
 * installed package to hold them to it: an srt upgrade that rewords one turns this file red. The P1
 * and P5 stderr lines are the probes' captures as they are. Every expected value is a literal from
 * the spec or those sources, never computed by the code under test.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { CAP_SETFCAP_MISSING_MESSAGE } from '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js'
import type { AbsolutePath } from '@tenon-app/kernel'
import { describe, expect, it, vi } from 'vitest'
import {
  SandboxConfigError,
  credentialPaths,
  sessionConfig,
  type SandboxHostPaths,
  type SandboxPlatform,
} from '../../src/main/host/sandbox-config.js'
import {
  selfTestScript,
  startSandboxPosture,
  type PostureFileStat,
  type PostureFs,
  type PostureRunner,
  type ProcessRow,
  type RunResult,
  type SandboxPostureOutcome,
  type SandboxReason,
  type SessionParts,
  type SrtStartup,
} from '../../src/main/host/sandbox-posture.js'

const p = (path: string): AbsolutePath => path as AbsolutePath

const SELF: Readonly<Record<SandboxPlatform, number>> = { darwin: 501, linux: 1000 }
const ANOTHER_USER = 0
const MAIN_PID = 4321

// ---------------------------------------------------------------------------------------------
// srt79's wording (the installed package is held to these in the last test)

/** sandbox-manager.js:490 */
const DEPS_PREFIX = 'Sandbox dependencies not available: '
/** linux-sandbox-utils.js:904 */
const BWRAP_NOT_INSTALLED = 'bubblewrap (bwrap) not installed'
/** linux-sandbox-utils.js:899, with the bwrapPath Tenon passed */
const BWRAP_NOT_EXECUTABLE = 'bubblewrap (bwrap) not executable at /usr/bin/bwrap'
/** linux-sandbox-utils.js:911 */
const SOCAT_NOT_INSTALLED = 'socat not installed'
/** linux-sandbox-utils.js:908, with the socatPath Tenon passed */
const SOCAT_NOT_EXECUTABLE = 'socat not executable at /usr/bin/socat'
/** sandbox-manager.js:816, srt's own default `{ command: 'rg' }` */
const RG_NOT_FOUND = 'ripgrep (rg) not found'
/** sandbox-manager.js:816, for the very rg Tenon found and passed: srt's `which` is missing */
const RG_NOT_FOUND_AT_OURS = 'ripgrep (/usr/bin/rg) not found'
/** linux-sandbox-utils.js:521-524 */
const CAP_SETFCAP =
  "running as uid 0 without CAP_SETFCAP in this process's capability bounding set - on " +
  'kernels that enforce the CAP_SETFCAP requirement for mapping uid 0 into a user namespace ' +
  '(Linux 5.12 and distribution backports) every sandboxed command fails while writing a uid ' +
  'map ("Operation not permitted"). Grant CAP_SETFCAP to this process, or run as a non-root user'
/** linux-sandbox-utils.js:1014, bubblewrap's refusal appended */
const CAP_SETFCAP_CONFIRMED = `${CAP_SETFCAP} (bubblewrap: bwrap: setting up uid map: Permission denied)`
/** linux-sandbox-utils.js:915 */
const NO_SECCOMP = 'seccomp not available - unix socket access not restricted'
/** linux-sandbox-utils.js:989-994, for bubblewrap 0.4.0 at /usr/bin/bwrap */
const OLD_BWRAP =
  'bubblewrap 0.4.0 at /usr/bin/bwrap is older than 0.5.0: a denyRead entry or credential ' +
  'mask naming a path that is not a regular file (a fifo, socket or device node) cannot be ' +
  'applied on it, and a mount point an interrupted sandbox left behind is not recognised as one ' +
  'and stays on the host. Everything else is unaffected'
/** macos-sandbox-utils.js:1109 (linux-sandbox-utils.js:2806 alike), for the `/bin/sh` the self-test passes */
const SHELL_NOT_FOUND = "Shell '/bin/sh' not found in PATH"

/** P1 (probes/results/macos/p1.nested.json:24), the run directory replaced */
const NESTED_INIT_ERROR =
  'listen EPERM: operation not permitted /tmp/claude-501/run/srt-mux-7162-0.sock'
/** P1 (probes/results/macos/p1.nested.json:35) */
const SANDBOX_APPLY_STDERR = 'sandbox-exec: sandbox_apply: Operation not permitted\n'
/** P5, Ubuntu 24.04 with the sysctl at 1 (probes/results/linux-u2404/p5.json:163) */
const BWRAP_LOOPBACK_STDERR = 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n'
/** P5, Ubuntu 26.04 as shipped (probes/results/linux-u2604/p5.json:73); vendor/seccomp/<arch>/apply-seccomp */
const APPLY_SECCOMP_STDERR =
  'apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller ' +
  'must provide CAP_SYS_ADMIN): Permission denied\n'

// ---------------------------------------------------------------------------------------------
// A fake disk

interface Node {
  readonly kind: 'dir' | 'file' | 'link' | 'fifo'
  readonly uid: number
  readonly mode: number
  readonly target?: string
  readonly text?: string
  /** Hard links to a file (1 unless given). */
  readonly nlink?: number
}

function errno(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code })
}

/** Paths resolve like the kernel's: every link on the way followed, the last one only if asked. */
class FakeDisk implements PostureFs {
  readonly nodes = new Map<string, Node>([['/', { kind: 'dir', uid: 0, mode: 0o755 }]])
  readonly removed: string[] = []
  private readonly self: number

  constructor(self: number) {
    this.self = self
  }

  dir(path: string, own: { uid?: number; mode?: number } = {}): void {
    this.parents(path)
    this.nodes.set(path, { kind: 'dir', uid: own.uid ?? this.self, mode: own.mode ?? 0o755 })
  }

  file(path: string, text = '', mode = 0o644, nlink = 1): void {
    this.parents(path)
    this.nodes.set(path, { kind: 'file', uid: this.self, mode, text, nlink })
  }

  link(path: string, target: string): void {
    this.parents(path)
    this.nodes.set(path, { kind: 'link', uid: this.self, mode: 0o755, target })
  }

  /** A named pipe: no size, one link. */
  fifo(path: string, mode: number): void {
    this.parents(path)
    this.nodes.set(path, { kind: 'fifo', uid: this.self, mode })
  }

  has(path: string): boolean {
    return this.nodes.has(path)
  }

  text(path: string): string | undefined {
    return this.nodes.get(path)?.text
  }

  lstat(path: string): PostureFileStat | undefined {
    const node = this.find(path, false)
    return node === undefined ? undefined : statOf(node)
  }

  stat(path: string): PostureFileStat | undefined {
    const node = this.find(path, true)
    return node === undefined ? undefined : statOf(node)
  }

  realpath(path: string): string {
    const { real, node } = this.walk(path, true)
    if (node === undefined) throw errno('ENOENT', path)
    return real
  }

  readlink(path: string): string {
    const node = this.find(path, false)
    if (node?.kind !== 'link' || node.target === undefined) throw errno('EINVAL', path)
    return node.target
  }

  mkdirPrivate(path: string): void {
    let at = ''
    for (const part of path.split('/').filter(Boolean)) {
      at += `/${part}`
      const { real, node } = this.walk(at, true)
      if (node === undefined) this.nodes.set(real, { kind: 'dir', uid: this.self, mode: 0o700 })
      else if (node.kind !== 'dir') throw errno('EEXIST', at)
    }
  }

  readFile(path: string): string | undefined {
    const node = this.find(path, true)
    if (node === undefined) return undefined
    if (node.kind !== 'file') throw errno('EISDIR', path)
    return node.text ?? ''
  }

  writeFile(path: string, text: string): void {
    const { real } = this.walk(path, true)
    this.nodes.set(real, { kind: 'file', uid: this.self, mode: 0o600, text })
  }

  readdir(path: string): string[] {
    const { real, node } = this.walk(path, true)
    if (node?.kind !== 'dir') throw errno('ENOTDIR', path)
    const prefix = real === '/' ? '/' : `${real}/`
    return [...this.nodes.keys()]
      .filter(
        (key) => key.startsWith(prefix) && key !== real && !key.slice(prefix.length).includes('/'),
      )
      .map((key) => key.slice(prefix.length))
  }

  isExecutable(path: string): boolean {
    const node = this.find(path, true)
    return node?.kind === 'file' && (node.mode & 0o111) !== 0
  }

  removeEmptyDir(path: string): void {
    if (this.readdir(path).length > 0) throw errno('ENOTEMPTY', path)
    this.nodes.delete(path)
    this.removed.push(path)
  }

  removeFile(path: string): void {
    const node = this.nodes.get(path)
    if (node === undefined) throw errno('ENOENT', path)
    if (node.kind === 'dir') throw errno('EISDIR', path)
    this.nodes.delete(path)
    this.removed.push(path)
  }

  removeTree(path: string): void {
    for (const key of this.nodes.keys()) {
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key)
    }
    this.removed.push(path)
  }

  private parents(path: string): void {
    let at = ''
    const parts = path.split('/').filter(Boolean)
    for (const part of parts.slice(0, -1)) {
      at += `/${part}`
      if (!this.nodes.has(at)) this.nodes.set(at, { kind: 'dir', uid: 0, mode: 0o755 })
    }
  }

  private find(path: string, follow: boolean): Node | undefined {
    try {
      return this.walk(path, follow).node
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private walk(path: string, followLast: boolean): { real: string; node: Node | undefined } {
    let parts = path.split('/').filter(Boolean)
    let at = ''
    let hops = 0
    for (let i = 0; i < parts.length; i += 1) {
      const next = `${at}/${parts[i]}`
      const node = this.nodes.get(next)
      const last = i === parts.length - 1
      if (node === undefined) {
        if (last) return { real: next, node: undefined }
        throw errno('ENOENT', path)
      }
      if (node.kind === 'link' && (!last || followLast)) {
        hops += 1
        if (hops > 40) throw errno('ELOOP', path)
        const target = node.target ?? ''
        const base = target.startsWith('/') ? [] : at.split('/').filter(Boolean)
        parts = [...base, ...target.split('/').filter(Boolean), ...parts.slice(i + 1)]
        at = ''
        i = -1
        continue
      }
      if (!last && node.kind !== 'dir') throw errno('ENOTDIR', path)
      at = next
    }
    const real = at === '' ? '/' : at
    return { real, node: this.nodes.get(real) }
  }
}

function statOf(node: Node): PostureFileStat {
  return {
    isDirectory: () => node.kind === 'dir',
    isFile: () => node.kind === 'file',
    isSymbolicLink: () => node.kind === 'link',
    uid: node.uid,
    mode: node.mode,
    size: {
      file: Buffer.byteLength(node.text ?? ''),
      fifo: 0,
      link: node.target?.length ?? 0,
      dir: 4096,
    }[node.kind],
    nlink: node.nlink ?? 1,
  }
}

// ---------------------------------------------------------------------------------------------
// The harness

function layout(platform: SandboxPlatform, tmp?: string) {
  const home = platform === 'darwin' ? '/Users/u' : '/home/u'
  const userData =
    platform === 'darwin' ? `${home}/Library/Application Support/Tenon` : `${home}/.config/Tenon`
  return {
    home,
    userData,
    profile: `${userData}/profiles/u1/t1`,
    cwdDir: `${userData}/sandbox-cwd`,
    tmp: tmp ?? (platform === 'darwin' ? '/private/var/folders/zz/q1w2/T' : '/tmp'),
    stubs: `${userData}/profiles/u1/t1/sandbox/stubs.json`,
    seccomp: '/opt/srt/vendor/seccomp/arm64/apply-seccomp',
    jar: '/opt/srt/vendor/java-proxy-agent/srt-proxy-agent.jar',
  }
}

/** What the fake self-test does when run. */
interface SelfTestBehaviour {
  readonly code: number | null
  readonly stderr: string
  /** It writes its target on the host (the sandbox did not stop it). */
  readonly writes: boolean
  readonly timedOut: boolean
}

interface HarnessOptions {
  /** The platform the host says it is; win32 and others reuse the Linux layout. */
  readonly arch?: string
  readonly chdir?: boolean
  readonly wsl?: string
  /** What `initialize` throws. */
  readonly initError?: Error
  readonly warnings?: readonly string[]
  readonly selfTest?: Partial<SelfTestBehaviour>
  /** What the darwin sandbox-exec check returns. */
  readonly sandboxExec?: Partial<RunResult>
  /** The wrap of the self-test throws this. */
  readonly wrapError?: Error
  /** Main's `os.tmpdir()`, when not the platform's usual one. */
  readonly tmpdir?: string
  /** `sessionConfig` throws this (srt's schema refused the config). */
  readonly sessionConfigError?: Error
  /** Something else on the host acts while initialize runs, or while the self-test does. */
  readonly duringInitialize?: (disk: FakeDisk) => void
  readonly duringSelfTest?: (disk: FakeDisk) => void
}

function harness(platform: NodeJS.Platform, options: HarnessOptions = {}) {
  const os: SandboxPlatform = platform === 'darwin' ? 'darwin' : 'linux'
  const at = layout(os, options.tmpdir)
  const uid = SELF[os]
  const disk = new FakeDisk(uid)
  disk.dir(at.home, { mode: 0o750 })
  disk.dir(at.profile, { mode: 0o700 })
  disk.dir(at.tmp, { uid: 0, mode: 0o777 })
  disk.file(at.seccomp, '', 0o755)
  disk.file(at.jar)
  disk.dir('/usr/local/bin', { uid: 0 })
  // Not executable: the PATH walk passes it by for /usr/bin's.
  disk.file('/usr/local/bin/bwrap', '', 0o644)
  for (const name of ['bwrap', 'socat', 'rg']) disk.file(`/usr/bin/${name}`, '', 0o755)
  disk.file('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '0\n')
  disk.file('/proc/sys/kernel/unprivileged_userns_clone', '1\n')
  disk.file('/proc/sys/user/max_user_namespaces', '15329\n')
  // Main's own sockets before initialize: an unbound one and one bound elsewhere.
  disk.file('/proc/net/unix', `${PROC_NET_UNIX_HEADER}\n${UNIX_UNBOUND_ROW}\n`)
  unixRow(disk, '18812', '/run/user/1000/bus')
  disk.link('/proc/self/fd/0', '/dev/null')
  disk.link('/proc/self/fd/17', 'socket:[18812]')
  disk.link('/proc/self/fd/18', 'socket:[19003]')

  const order: string[] = []
  const logs: string[] = []
  const table: ProcessRow[] = [
    { pid: 1, ppid: 0, command: '/sbin/launchd' },
    { pid: MAIN_PID, ppid: 1, command: '/Applications/Tenon.app/Contents/MacOS/Tenon' },
  ]
  const killed: number[] = []
  const wraps: {
    command: string
    binShell: string
    config: Partial<SandboxRuntimeConfig>
    cwd: string
    id: string
  }[] = []
  const runs: { argv: readonly string[]; cwd: string; env: Record<string, string> }[] = []
  const sessions: SessionParts[] = []
  const selfTest: SelfTestBehaviour = {
    code: 0,
    stderr: '',
    writes: false,
    timedOut: false,
    ...options.selfTest,
  }
  let initialized = false

  const srt = {
    initialize: vi.fn<SrtStartup['initialize']>(async (config) => {
      order.push('initialize')
      if (options.initError !== undefined) throw options.initError
      // srt's own lookup of a binary it was not given (sandbox-manager.js:813-816,
      // linux-sandbox-utils.js:897-912): on this host it is nowhere else either.
      if (os === 'linux') {
        const errors = [
          ...(config.ripgrep === undefined ? [RG_NOT_FOUND] : []),
          ...(config.bwrapPath === undefined ? [BWRAP_NOT_INSTALLED] : []),
          ...(config.socatPath === undefined ? [SOCAT_NOT_INSTALLED] : []),
        ]
        if (errors.length > 0) throw new Error(DEPS_PREFIX + errors.join(', '))
      }
      options.duringInitialize?.(disk)
      initialized = true
      // What srt leaves in main's tmpdir and process table (P7).
      disk.file(`${at.tmp}/srt-mux-${MAIN_PID}-0.sock`)
      if (os === 'linux') {
        disk.file(`${at.tmp}/claude-http-cafe01.sock`)
        // The observer: main listens on its socket (linux-violation-monitor.js:34-35, :129).
        disk.dir(`${at.tmp}/srt-obs-Q1w2e3`, { mode: 0o700 })
        disk.file(`${at.tmp}/srt-obs-Q1w2e3/s0a1b2c3d.sock`)
        unixRow(disk, '23456', `${at.tmp}/srt-obs-Q1w2e3/s0a1b2c3d.sock`)
        disk.link('/proc/self/fd/21', 'socket:[23456]')
        table.push({ pid: 5555, ppid: MAIN_PID, command: SOCAT_COMMAND('cafe01') })
      }
    }),
    // Before initialize srt has no config and cannot see the explicit paths (spec §启动 step 3).
    checkDependenciesAsync: vi.fn<SrtStartup['checkDependenciesAsync']>(async () => {
      order.push('checkDependenciesAsync')
      return initialized
        ? { errors: [], warnings: [...(options.warnings ?? [])] }
        : { errors: [RG_NOT_FOUND], warnings: [] }
    }),
    wrapWithSandboxArgv: vi.fn<SrtStartup['wrapWithSandboxArgv']>(
      async (command, binShell, customConfig, _abort, cwd, wrapOptions) => {
        order.push('wrap')
        wraps.push({ command, binShell, config: customConfig, cwd, id: wrapOptions.commandId })
        if (options.wrapError !== undefined) throw options.wrapError
        return { argv: [binShell, '-c', `srt-wrapped ${command}`], env: { SECRET: 'x' } }
      },
    ),
    cleanupAfterCommand: vi.fn<() => void>(() => {
      order.push('cleanupAfterCommand')
    }),
    getWslVersion: vi.fn<() => string | undefined>(() => options.wsl),
  }

  const run = vi.fn<PostureRunner>(async (argv, opts): Promise<RunResult> => {
    runs.push({ argv, cwd: opts.cwd, env: opts.env })
    if (argv[0] === '/usr/bin/sandbox-exec') {
      order.push('sandbox-exec')
      return { code: 0, signal: null, stderr: '', timedOut: false, ...options.sandboxExec }
    }
    order.push('self-test')
    options.duringSelfTest?.(disk)
    const target = targetOf(wraps.at(-1)?.command ?? '')
    if (selfTest.writes) disk.file(target, 'x\n')
    return {
      code: selfTest.code,
      signal: null,
      stderr: selfTest.stderr,
      timedOut: selfTest.timedOut,
    }
  })

  const hostPaths: Omit<SandboxHostPaths, 'noSeccomp'> = {
    platform: os,
    home: p(at.home),
    zdotdir: null,
    profileDir: p(at.profile),
    cacheDir: p(`${at.userData}/sandbox-cache`),
    chdirDir: options.chdir === false ? null : p(at.cwdDir),
    srtPackageDir: p('/opt/srt'),
    credentials: credentialPaths(os, p(at.home)),
    uid,
    xdgRuntimeDir: null,
    sshAuthSock: null,
  }
  const env: Record<string, string | undefined> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: at.home,
    CLAUDE_CODE_TMPDIR: '/var/tmp/elsewhere',
    CLAUDE_TMPDIR: '/var/tmp/elsewhere-too',
    SECRET_FROM_DOTENV: 'sk-test-not-a-key',
  }
  const chdir = vi.fn<(dir: string) => void>((dir) => {
    order.push(`chdir ${dir}`)
  })
  const deps = {
    platform,
    arch: options.arch ?? 'arm64',
    srt,
    helpers: { packageDir: p('/opt/srt'), applySeccomp: p(at.seccomp), javaAgentJar: p(at.jar) },
    sessionConfig: (parts: SessionParts) => {
      sessions.push(parts)
      if (options.sessionConfigError !== undefined) throw options.sessionConfigError
      return sessionConfig({ ...hostPaths, noSeccomp: false, allowedDomains: [], ...parts }, disk)
    },
    env,
    chdirDir: hostPaths.chdirDir,
    chdir,
    fs: disk,
    tmpdir: p(at.tmp),
    processes: {
      list: async () => table.map((row) => ({ ...row })),
      kill: (pid: number) => {
        order.push(`kill ${pid}`)
        killed.push(pid)
      },
    },
    run,
    uid,
    pid: MAIN_PID,
    home: p(at.home),
    profileDir: p(at.profile),
    log: (line: string) => logs.push(line),
  }
  const start = () => startSandboxPosture(deps)
  return {
    at,
    disk,
    deps,
    env,
    srt,
    run,
    runs,
    wraps,
    sessions,
    order,
    logs,
    table,
    killed,
    chdir,
    start,
  }
}

/** /proc/net/unix's header and an unbound socket's row (net/unix/af_unix.c, unix_seq_show). */
const PROC_NET_UNIX_HEADER = 'Num       RefCount Protocol Flags    Type St Inode Path'
const UNIX_UNBOUND_ROW = '0000000000000000: 00000003 00000000 00000000 0001 03 19003'

/** Appends a listening socket bound at `path` to the fake /proc/net/unix. */
function unixRow(disk: FakeDisk, inode: string, path: string): void {
  const row = `0000000000000000: 00000002 00000000 00010000 0001 01 ${inode.padStart(5)} ${path}`
  disk.file('/proc/net/unix', `${disk.text('/proc/net/unix') ?? ''}${row}\n`)
}

const SOCAT_COMMAND = (hex: string): string =>
  `/usr/bin/socat UNIX-LISTEN:/tmp/claude-http-${hex}.sock,fork,reuseaddr ` +
  'TCP:localhost:51000,keepalive,keepidle=10,keepintvl=5,keepcnt=3'

/** The path a self-test script writes to. */
function targetOf(script: string): string {
  return /echo x > '([^']+)'/.exec(script)?.[1] ?? ''
}

/** Whether a promise has settled by the time everything queued has run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  await new Promise((resolve) => setImmediate(resolve))
  return done
}

async function outcomeOf(h: ReturnType<typeof harness>): Promise<SandboxPostureOutcome> {
  return h.start().outcome
}

const reasons = (outcome: SandboxPostureOutcome): readonly SandboxReason[] => outcome.reasons

// ---------------------------------------------------------------------------------------------

describe('04 验收 2: sandbox startup, self-test and reason codes', () => {
  it('04 验收 2: initialize gets true as its third argument on darwin and linux', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const h = harness(platform)
      const run = h.start()
      // oxlint-disable-next-line no-await-in-loop -- one platform after the other
      const outcome = await run.outcome
      expect(outcome.state).toBe('active')
      expect(outcome.reasons).toEqual([])
      expect(outcome.session).not.toBeNull()
      expect(outcome.initialize).toBe('returned')
      expect(h.srt.initialize).toHaveBeenCalledTimes(1)
      expect(h.srt.initialize.mock.calls[0]?.[1]).toBeUndefined()
      expect(h.srt.initialize.mock.calls[0]?.[2]).toBe(true)
      expect(h.srt.initialize.mock.calls[0]?.[0]).toBe(outcome.session)
      // oxlint-disable-next-line no-await-in-loop
      expect(await settled(run.initialized)).toBe(true)
      // The dependency check comes after initialize, and only for its warnings (spec §启动 step 3).
      expect(h.order.filter((step) => !step.startsWith('chdir'))).toEqual([
        'initialize',
        'checkDependenciesAsync',
        'wrap',
        'self-test',
        'cleanupAfterCommand',
      ])
      // srt's two tmpdir variables left main's environment (spec §启动 step 2).
      expect(h.env['CLAUDE_CODE_TMPDIR']).toBeUndefined()
      expect(h.env['CLAUDE_TMPDIR']).toBeUndefined()
      expect(h.env['SECRET_FROM_DOTENV']).toBe('sk-test-not-a-key')
    }
    // Linux hands srt the absolute paths it found on main's PATH, an executable one only.
    const linux = harness('linux')
    const outcome = await outcomeOf(linux)
    expect(linux.sessions).toEqual([
      {
        applySeccompPath: '/opt/srt/vendor/seccomp/arm64/apply-seccomp',
        javaAgentJarPath: '/opt/srt/vendor/java-proxy-agent/srt-proxy-agent.jar',
        linuxBinaries: { bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', rg: '/usr/bin/rg' },
      },
    ])
    expect(outcome.session).toMatchObject({
      bwrapPath: '/usr/bin/bwrap',
      socatPath: '/usr/bin/socat',
      ripgrep: { command: '/usr/bin/rg' },
    })
  })

  it('04 验收 2: a dependency error thrown by initialize maps to its reason code; any other throw is init-failed', async () => {
    const cases: readonly {
      readonly thrown: string
      readonly reasons: readonly SandboxReason[]
    }[] = [
      {
        thrown: DEPS_PREFIX + BWRAP_NOT_INSTALLED,
        reasons: [{ code: 'missing-bwrap', detail: BWRAP_NOT_INSTALLED }],
      },
      {
        thrown: DEPS_PREFIX + BWRAP_NOT_EXECUTABLE,
        reasons: [{ code: 'missing-bwrap', detail: BWRAP_NOT_EXECUTABLE }],
      },
      {
        thrown: DEPS_PREFIX + SOCAT_NOT_INSTALLED,
        reasons: [{ code: 'missing-socat', detail: SOCAT_NOT_INSTALLED }],
      },
      {
        thrown: DEPS_PREFIX + SOCAT_NOT_EXECUTABLE,
        reasons: [{ code: 'missing-socat', detail: SOCAT_NOT_EXECUTABLE }],
      },
      {
        thrown: DEPS_PREFIX + RG_NOT_FOUND,
        reasons: [{ code: 'missing-rg', detail: RG_NOT_FOUND }],
      },
      {
        thrown: DEPS_PREFIX + CAP_SETFCAP,
        reasons: [{ code: 'root-without-setfcap', detail: CAP_SETFCAP }],
      },
      {
        thrown: DEPS_PREFIX + CAP_SETFCAP_CONFIRMED,
        reasons: [{ code: 'root-without-setfcap', detail: CAP_SETFCAP_CONFIRMED }],
      },
      // srt joins them with `, ` (sandbox-manager.js:490), and the CAP_SETFCAP text holds one itself.
      {
        thrown: `${DEPS_PREFIX}${RG_NOT_FOUND}, ${BWRAP_NOT_INSTALLED}, ${SOCAT_NOT_INSTALLED}, ${CAP_SETFCAP}`,
        reasons: [
          { code: 'missing-rg', detail: RG_NOT_FOUND },
          { code: 'missing-bwrap', detail: BWRAP_NOT_INSTALLED },
          { code: 'missing-socat', detail: SOCAT_NOT_INSTALLED },
          { code: 'root-without-setfcap', detail: CAP_SETFCAP },
        ],
      },
      // A wording srt did not have: `other`, its text the detail.
      {
        thrown: `${DEPS_PREFIX}landlock not available, ${SOCAT_NOT_INSTALLED}`,
        reasons: [
          { code: 'other', detail: 'landlock not available' },
          { code: 'missing-socat', detail: SOCAT_NOT_INSTALLED },
        ],
      },
      // The rg Tenon found, not found by srt: srt's `which` is missing (spec §启动 step 2).
      {
        thrown: DEPS_PREFIX + RG_NOT_FOUND_AT_OURS,
        reasons: [{ code: 'other', detail: RG_NOT_FOUND_AT_OURS }],
      },
    ]
    for (const { thrown, reasons: expected } of cases) {
      const h = harness('linux', { initError: new Error(thrown) })
      const run = h.start()
      // oxlint-disable-next-line no-await-in-loop -- one case after the other
      const outcome = await run.outcome
      expect({ thrown, state: outcome.state, reasons: outcome.reasons }).toEqual({
        thrown,
        state: 'unavailable',
        reasons: expected,
      })
      expect(outcome.session).toBeNull()
      expect(outcome.initialize).toBe('dependency-error')
      expect(h.srt.initialize).toHaveBeenCalledTimes(1)
      // oxlint-disable-next-line no-await-in-loop
      expect(await settled(run.initialized)).toBe(false)
      expect(h.srt.wrapWithSandboxArgv).not.toHaveBeenCalled()
    }

    // Any other throw: init-failed with srt's message (Linux runs no sandbox-exec check).
    const linux = harness('linux', { initError: new Error('Failed to get mux proxy server port') })
    const linuxRun = linux.start()
    expect(reasons(await linuxRun.outcome)).toEqual([
      { code: 'init-failed', detail: 'Failed to get mux proxy server port' },
    ])
    expect((await linuxRun.outcome).initialize).toBe('threw')
    expect(linux.runs).toEqual([])
    expect(await settled(linuxRun.initialized)).toBe(false)
    // darwin, where the sandbox-exec check exits 0: still init-failed.
    const darwin = harness('darwin', {
      initError: new Error('Failed to get mux proxy server port'),
    })
    expect(reasons(await outcomeOf(darwin))).toEqual([
      { code: 'init-failed', detail: 'Failed to get mux proxy server port' },
    ])
    // On Linux nothing else is wrapped or run once initialize threw.
    expect(linux.srt.checkDependenciesAsync).not.toHaveBeenCalled()
  })

  it('04 验收 2: on darwin, initialize throwing and the sandbox-exec check exiting 71 is nested-sandbox', async () => {
    // Exit 71 decides on its own, with nothing on stderr.
    const h = harness('darwin', {
      initError: new Error(NESTED_INIT_ERROR),
      sandboxExec: { code: 71, stderr: '' },
    })
    const outcome = await outcomeOf(h)
    expect(outcome.state).toBe('unavailable')
    expect(outcome.reasons).toEqual([{ code: 'nested-sandbox', detail: NESTED_INIT_ERROR }])
    // The check's argv is fixed, and it goes through the runner, not srt (spec §启动 step 3), with
    // the self-test's 10 s.
    expect(h.runs.map((one) => one.argv)).toEqual([
      ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true'],
    ])
    expect(h.run.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([10_000])
    expect(h.srt.wrapWithSandboxArgv).not.toHaveBeenCalled()
    expect(h.order.filter((step) => !step.startsWith('chdir'))).toEqual([
      'initialize',
      'sandbox-exec',
    ])

    // `sandbox_apply` in its stderr is enough on its own.
    const byStderr = harness('darwin', {
      initError: new Error(NESTED_INIT_ERROR),
      sandboxExec: { code: 1, stderr: SANDBOX_APPLY_STDERR },
    })
    expect(reasons(await outcomeOf(byStderr))).toEqual([
      { code: 'nested-sandbox', detail: NESTED_INIT_ERROR },
    ])
  })

  it('04 验收 2: a missing helper file is unavailable without initialize', async () => {
    const missingSeccomp = harness('linux')
    missingSeccomp.disk.removeTree(missingSeccomp.at.seccomp)
    const seccompOutcome = await outcomeOf(missingSeccomp)
    expect(seccompOutcome.state).toBe('unavailable')
    expect(seccompOutcome.reasons).toEqual([
      { code: 'other', detail: 'missing helper file: /opt/srt/vendor/seccomp/arm64/apply-seccomp' },
    ])
    expect(missingSeccomp.srt.initialize).not.toHaveBeenCalled()
    expect(missingSeccomp.chdir).not.toHaveBeenCalled()

    const missingJar = harness('darwin')
    missingJar.disk.removeTree(missingJar.at.jar)
    expect(reasons(await outcomeOf(missingJar))).toEqual([
      {
        code: 'other',
        detail: 'missing helper file: /opt/srt/vendor/java-proxy-agent/srt-proxy-agent.jar',
      },
    ])
    expect(missingJar.srt.initialize).not.toHaveBeenCalled()

    // A directory where the helper should be is no helper file either.
    const dirSeccomp = harness('linux')
    dirSeccomp.disk.removeTree(dirSeccomp.at.seccomp)
    dirSeccomp.disk.dir(dirSeccomp.at.seccomp)
    expect(await outcomeOf(dirSeccomp)).toEqual({
      state: 'unavailable',
      session: null,
      noSeccomp: false,
      reasons: [
        {
          code: 'other',
          detail: 'missing helper file: /opt/srt/vendor/seccomp/arm64/apply-seccomp',
        },
      ],
      initialize: 'not-called',
    })
    expect(dirSeccomp.srt.initialize).not.toHaveBeenCalled()

    // An architecture srt ships no apply-seccomp for: srt's own warning decides (`no-seccomp`).
    const otherArch = harness('linux', { arch: 'ia32', warnings: [NO_SECCOMP] })
    otherArch.disk.removeTree(otherArch.at.seccomp)
    const otherOutcome = await outcomeOf(otherArch)
    expect(otherArch.srt.initialize).toHaveBeenCalledTimes(1)
    expect(otherOutcome.state).toBe('degraded')
    expect(otherOutcome.reasons).toEqual([{ code: 'no-seccomp', detail: NO_SECCOMP }])
  })

  it("04 验收 2: bwrap, socat or rg missing from main's PATH is left to srt, and initialize names it in srt's own words", async () => {
    const cases: readonly {
      readonly remove: string
      readonly found: Record<'bwrap' | 'socat' | 'rg', string | null>
      readonly reason: SandboxReason
    }[] = [
      // /usr/local/bin/bwrap is there but not executable: no bwrap on the PATH at all.
      {
        remove: '/usr/bin/bwrap',
        found: { bwrap: null, socat: '/usr/bin/socat', rg: '/usr/bin/rg' },
        reason: { code: 'missing-bwrap', detail: 'bubblewrap (bwrap) not installed' },
      },
      {
        remove: '/usr/bin/socat',
        found: { bwrap: '/usr/bin/bwrap', socat: null, rg: '/usr/bin/rg' },
        reason: { code: 'missing-socat', detail: 'socat not installed' },
      },
      {
        remove: '/usr/bin/rg',
        found: { bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', rg: null },
        reason: { code: 'missing-rg', detail: 'ripgrep (rg) not found' },
      },
    ]
    for (const { remove, found, reason } of cases) {
      const h = harness('linux')
      h.disk.removeTree(remove)
      // Last run's empty mount point: startup still cleans up and chdirs first.
      h.disk.dir('/home/u/code/app/.claude')
      h.disk.file(
        h.at.stubs,
        JSON.stringify({ mountPoints: { 'toolu_01.0a0b': ['/home/u/code/app/.claude'] } }),
      )
      // oxlint-disable-next-line no-await-in-loop -- one case after the other
      const outcome = await outcomeOf(h)
      expect({ remove, outcome }).toEqual({
        remove,
        outcome: {
          state: 'unavailable',
          session: null,
          noSeccomp: false,
          reasons: [reason],
          initialize: 'dependency-error',
        },
      })
      expect(h.sessions.map((parts) => parts.linuxBinaries)).toEqual([found])
      // srt was not handed the missing one, so it looked it up itself.
      const handed = h.srt.initialize.mock.calls[0]?.[0]
      expect({
        bwrapPath: handed?.bwrapPath,
        socatPath: handed?.socatPath,
        ripgrep: handed?.ripgrep,
      }).toEqual({
        bwrapPath: found.bwrap ?? undefined,
        socatPath: found.socat ?? undefined,
        ripgrep: found.rg === null ? undefined : { command: found.rg },
      })
      expect(h.srt.initialize).toHaveBeenCalledTimes(1)
      expect(h.chdir.mock.calls).toEqual([['/home/u/.config/Tenon/sandbox-cwd']])
      expect(h.disk.has('/home/u/code/app/.claude')).toBe(false)
    }
  })

  it('04 验收 2: a session config the schema refuses, or a dependency check that throws, is init-failed', async () => {
    const refused = harness('linux', {
      sessionConfigError: new SandboxConfigError(
        "sandbox config refused by srt's schema: network.allowedDomains.0: Invalid domain pattern",
      ),
    })
    expect(await outcomeOf(refused)).toEqual({
      state: 'unavailable',
      session: null,
      noSeccomp: false,
      reasons: [
        {
          code: 'init-failed',
          detail:
            "sandbox config refused by srt's schema: network.allowedDomains.0: Invalid domain pattern",
        },
      ],
      initialize: 'not-called',
    })
    expect(refused.srt.initialize).not.toHaveBeenCalled()

    const throws = harness('darwin')
    throws.srt.checkDependenciesAsync.mockRejectedValueOnce(new Error('spawnSync which ETIMEDOUT'))
    const run = throws.start()
    expect(await run.outcome).toEqual({
      state: 'unavailable',
      session: null,
      noSeccomp: false,
      reasons: [{ code: 'init-failed', detail: 'spawnSync which ETIMEDOUT' }],
      initialize: 'returned',
    })
    // srt is up all the same (DesktopSandbox resets it on quit); no self-test follows.
    expect(await settled(run.initialized)).toBe(true)
    expect(throws.srt.wrapWithSandboxArgv).not.toHaveBeenCalled()
  })

  it('04 验收 2: warnings after initialize are degraded', async () => {
    const h = harness('linux', { warnings: [NO_SECCOMP, OLD_BWRAP] })
    const outcome = await outcomeOf(h)
    expect(outcome.state).toBe('degraded')
    expect(outcome.reasons).toEqual([
      { code: 'no-seccomp', detail: NO_SECCOMP },
      { code: 'old-bwrap', detail: OLD_BWRAP },
    ])
    expect(outcome.noSeccomp).toBe(true)
    expect(outcome.session).not.toBeNull()

    const oldBwrapOnly = harness('linux', { warnings: [OLD_BWRAP] })
    const oldOutcome = await outcomeOf(oldBwrapOnly)
    expect(oldOutcome.state).toBe('degraded')
    expect(oldOutcome.noSeccomp).toBe(false)
    expect(oldOutcome.reasons).toEqual([{ code: 'old-bwrap', detail: OLD_BWRAP }])

    // Warnings never stand in for the self-test (spec §启动 step 5, 读法 4): it still runs, and when
    // it fails the posture is unavailable whatever the warnings said.
    const wroteAnyway = harness('linux', {
      warnings: [OLD_BWRAP],
      selfTest: { code: 0, writes: true },
    })
    const wroteOutcome = await outcomeOf(wroteAnyway)
    const target = targetOf(wroteAnyway.wraps[0]?.command ?? '')
    expect(target).toMatch(/^\/tmp\/tenon-sandbox-self-test-[0-9a-f]{16}$/)
    expect(wroteOutcome).toEqual({
      state: 'unavailable',
      session: null,
      noSeccomp: false,
      reasons: [{ code: 'self-test-failed', detail: `wrote ${target} outside the sandbox` }],
      initialize: 'returned',
    })

    const restricted = harness('linux', {
      warnings: [NO_SECCOMP],
      selfTest: { code: 1, stderr: BWRAP_LOOPBACK_STDERR },
    })
    restricted.disk.file('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1\n')
    expect(await outcomeOf(restricted)).toEqual({
      state: 'unavailable',
      session: null,
      noSeccomp: false,
      reasons: [
        {
          code: 'userns-restricted',
          detail:
            'kernel.apparmor_restrict_unprivileged_userns=1\nkernel.unprivileged_userns_clone=1\n' +
            `user.max_user_namespaces=15329\nexited 1\n${BWRAP_LOOPBACK_STDERR}bwrap=/usr/bin/bwrap`,
        },
      ],
      initialize: 'returned',
    })
  })

  it("04 验收 2: a warning srt words in a way Tenon does not know is degraded with other and srt's own text, never unavailable", async () => {
    // An srt upgrade that rewords linux-sandbox-utils.js:915: the sandbox is up, one layer perhaps
    // weaker (spec §IPC: other also comes with degraded).
    const reworded = 'seccomp not available - unix sockets are not restricted'
    for (const platform of ['linux', 'darwin'] as const) {
      const h = harness(platform, { warnings: [reworded] })
      // oxlint-disable-next-line no-await-in-loop -- one platform after the other
      const outcome = await outcomeOf(h)
      expect({ platform, state: outcome.state, reasons: outcome.reasons }).toEqual({
        platform,
        state: 'degraded',
        reasons: [
          { code: 'other', detail: 'seccomp not available - unix sockets are not restricted' },
        ],
      })
      expect(outcome.noSeccomp).toBe(false)
      expect(outcome.session).not.toBeNull()
    }
  })

  it('04 验收 2: on linux a restricting sysctl reading with a passing self-test (the bwrap AppArmor profile, P5) is active', async () => {
    // P5: with the profile from spec §启动 step 6 installed, 24.04 at 1 and 26.04 as shipped (1) are
    // active. A reading only names why a self-test failed (step 5); it never fails one that passed.
    for (const [path, value] of [
      ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1'],
      ['/proc/sys/kernel/unprivileged_userns_clone', '0'],
    ] as const) {
      const h = harness('linux')
      h.disk.file(path, `${value}\n`)
      // oxlint-disable-next-line no-await-in-loop -- one reading after the other
      const outcome = await outcomeOf(h)
      expect({ path, state: outcome.state, reasons: outcome.reasons }).toEqual({
        path,
        state: 'active',
        reasons: [],
      })
      expect(h.srt.cleanupAfterCommand).toHaveBeenCalledTimes(1)
    }
  })

  it("04 验收 2: a failing self-test is unavailable; exit 71 is nested-sandbox; a restricting sysctl reading or apply-seccomp's `nested userns is capability-restricted` makes it userns-restricted", async () => {
    const READINGS_OPEN =
      'kernel.apparmor_restrict_unprivileged_userns=0\nkernel.unprivileged_userns_clone=1\nuser.max_user_namespaces=15329'
    const cases: readonly {
      readonly platform: SandboxPlatform
      readonly selfTest: Partial<SelfTestBehaviour>
      readonly apparmor?: string
      readonly reason: SandboxReason
    }[] = [
      {
        platform: 'darwin',
        selfTest: { code: 1, stderr: 'sh: something else\n' },
        reason: { code: 'self-test-failed', detail: 'exited 1\nsh: something else\n' },
      },
      // darwin: exit 71 alone, and `sandbox_apply` on stderr alone, each say nesting.
      {
        platform: 'darwin',
        selfTest: { code: 71, stderr: '' },
        reason: { code: 'nested-sandbox', detail: 'exited 71' },
      },
      {
        platform: 'darwin',
        selfTest: { code: 1, stderr: SANDBOX_APPLY_STDERR },
        reason: { code: 'nested-sandbox', detail: `exited 1\n${SANDBOX_APPLY_STDERR}` },
      },
      // P5, Ubuntu 24.04 with the sysctl at 1: bwrap's line, and the reading says it.
      {
        platform: 'linux',
        selfTest: { code: 1, stderr: BWRAP_LOOPBACK_STDERR },
        apparmor: '1',
        reason: {
          code: 'userns-restricted',
          detail:
            'kernel.apparmor_restrict_unprivileged_userns=1\nkernel.unprivileged_userns_clone=1\n' +
            `user.max_user_namespaces=15329\nexited 1\n${BWRAP_LOOPBACK_STDERR}bwrap=/usr/bin/bwrap`,
        },
      },
      // P5, Ubuntu 26.04 as shipped with the sysctl at 0: only apply-seccomp's line says it.
      {
        platform: 'linux',
        selfTest: { code: 1, stderr: APPLY_SECCOMP_STDERR },
        reason: {
          code: 'userns-restricted',
          detail: `${READINGS_OPEN}\nexited 1\n${APPLY_SECCOMP_STDERR}bwrap=/usr/bin/bwrap`,
        },
      },
      {
        platform: 'linux',
        selfTest: { code: 1, stderr: 'bwrap: execvp /bin/sh: No such file or directory\n' },
        reason: {
          code: 'self-test-failed',
          detail: `${READINGS_OPEN}\nexited 1\nbwrap: execvp /bin/sh: No such file or directory\n`,
        },
      },
      // Exit 71 is no nesting on Linux.
      {
        platform: 'linux',
        selfTest: { code: 71, stderr: '' },
        reason: { code: 'self-test-failed', detail: `${READINGS_OPEN}\nexited 71` },
      },
      {
        platform: 'darwin',
        selfTest: { code: null, stderr: '', timedOut: true },
        reason: { code: 'self-test-failed', detail: 'did not finish within 10000 ms' },
      },
    ]
    for (const { platform, selfTest, apparmor, reason } of cases) {
      const h = harness(platform, { selfTest })
      if (apparmor !== undefined) {
        h.disk.file('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', `${apparmor}\n`)
      }
      const run = h.start()
      // oxlint-disable-next-line no-await-in-loop -- one case after the other
      const outcome = await run.outcome
      expect({ platform, selfTest, state: outcome.state, reasons: outcome.reasons }).toEqual({
        platform,
        selfTest,
        state: 'unavailable',
        reasons: [reason],
      })
      expect(outcome.session).toBeNull()
      // srt is up all the same: DesktopSandbox resets it on quit (§退出).
      // oxlint-disable-next-line no-await-in-loop
      expect(await settled(run.initialized)).toBe(true)
      expect(h.srt.cleanupAfterCommand).toHaveBeenCalledTimes(1)
    }

    // A wrap that throws: self-test-failed, and no cleanupAfterCommand for a wrap that never was.
    const wrapThrows = harness('darwin', { wrapError: new Error(SHELL_NOT_FOUND) })
    expect(reasons(await outcomeOf(wrapThrows))).toEqual([
      { code: 'self-test-failed', detail: "wrap: Shell '/bin/sh' not found in PATH" },
    ])
    expect(wrapThrows.srt.cleanupAfterCommand).not.toHaveBeenCalled()

    // A runner that cannot start it: self-test-failed, and cleanupAfterCommand once all the same.
    const spawnFails = harness('linux')
    spawnFails.run.mockImplementationOnce(async () => {
      throw new Error('spawn /bin/sh EACCES')
    })
    expect(reasons(await outcomeOf(spawnFails))).toEqual([
      { code: 'self-test-failed', detail: 'did not start: spawn /bin/sh EACCES' },
    ])
    expect(spawnFails.srt.cleanupAfterCommand).toHaveBeenCalledTimes(1)

    // stderr's first 2 KB only.
    const long = harness('darwin', { selfTest: { code: 2, stderr: `${'a'.repeat(3000)}` } })
    expect(reasons(await outcomeOf(long))).toEqual([
      { code: 'self-test-failed', detail: `exited 2\n${'a'.repeat(2048)}` },
    ])
  })

  it('04 验收 2: a self-test whose outside write succeeds is self-test-failed', async () => {
    for (const code of [3, 0]) {
      const h = harness('darwin', { selfTest: { code, writes: true } })
      // oxlint-disable-next-line no-await-in-loop -- one case after the other
      const outcome = await outcomeOf(h)
      const target = targetOf(h.wraps[0]?.command ?? '')
      expect(outcome.state).toBe('unavailable')
      expect(outcome.reasons).toEqual([
        { code: 'self-test-failed', detail: `wrote ${target} outside the sandbox` },
      ])
      // The file it wrote is gone from the host again.
      expect(h.disk.has(target)).toBe(false)
      expect(h.srt.cleanupAfterCommand).toHaveBeenCalledTimes(1)
    }

    // The self-test's wrap: read-only (nothing writable but srt's defaults), /bin/sh, from home; its
    // target a new path in main's tmpdir, under none of srt's default writable places.
    const h = harness('linux')
    await outcomeOf(h)
    const wrap = h.wraps[0]
    expect(wrap?.binShell).toBe('/bin/sh')
    expect(wrap?.cwd).toBe('/home/u')
    expect(wrap?.config.filesystem?.allowWrite).toEqual([])
    expect(wrap?.config.filesystem?.allowRead ?? []).toEqual([])
    expect(wrap?.id).toMatch(/^tenon-sandbox-self-test\.[0-9a-f]{32}$/)
    const target = targetOf(wrap?.command ?? '')
    expect(target).toMatch(/^\/tmp\/tenon-sandbox-self-test-[0-9a-f]{16}$/)
    for (const writable of ['/tmp/claude', '/home/u/.npm/_logs', '/home/u/.claude/debug']) {
      expect(target.startsWith(`${writable}/`)).toBe(false)
    }
    // It ran from home with only PATH and HOME: main's environment (.env.local) is not forwarded.
    expect(h.runs.map(({ argv, cwd, env }) => ({ argv0: argv[0], cwd, env }))).toEqual([
      {
        argv0: '/bin/sh',
        cwd: '/home/u',
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/u' },
      },
    ])
    // Killed at 10 s (spec §启动 step 5).
    expect(h.run.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([10_000])
  })

  it("04 验收 2: the self-test writes under none of srt's writable places, even with main's tmpdir there", async () => {
    // Main started with TMPDIR=/tmp/claude: home instead, which read-only keeps unwritable too.
    const linux = harness('linux', { tmpdir: '/tmp/claude' })
    expect((await outcomeOf(linux)).state).toBe('active')
    expect(targetOf(linux.wraps[0]?.command ?? '')).toMatch(
      /^\/home\/u\/tenon-sandbox-self-test-[0-9a-f]{16}$/,
    )

    // A tmpdir that only by its real path is srt's (/private/tmp/claude on darwin).
    const darwin = harness('darwin', { tmpdir: '/Users/u/tmp' })
    darwin.disk.dir('/private/tmp/claude', { mode: 0o700 })
    darwin.disk.link('/Users/u/tmp', '/private/tmp/claude')
    expect((await outcomeOf(darwin)).state).toBe('active')
    expect(targetOf(darwin.wraps[0]?.command ?? '')).toMatch(
      /^\/Users\/u\/tenon-sandbox-self-test-[0-9a-f]{16}$/,
    )
  })

  it('04 验收 2: the self-test script never uses `: >`', () => {
    expect(selfTestScript('/tmp/tenon-sandbox-self-test-0a1b')).toBe(
      "( echo x > '/tmp/tenon-sandbox-self-test-0a1b' ) 2>/dev/null; " +
        "if [ -e '/tmp/tenon-sandbox-self-test-0a1b' ]; then exit 3; fi; exit 0",
    )
    expect(selfTestScript("/tmp/it's")).toBe(
      "( echo x > '/tmp/it'\\''s' ) 2>/dev/null; if [ -e '/tmp/it'\\''s' ]; then exit 3; fi; exit 0",
    )
    expect(selfTestScript('/tmp/x')).not.toMatch(/:\s*>/)

    // In real POSIX shells: a write that fails reaches `exit 0`, one that succeeds exits 3.
    const dir = mkdtempSync(join(tmpdir(), 'tenon-posture-'))
    try {
      const shells = [['/bin/sh'], ['/bin/bash', '--posix'], ['/bin/dash']].filter(([shell]) =>
        existsSync(shell ?? ''),
      )
      expect(shells.length).toBeGreaterThan(0)
      for (const [shell, ...flags] of shells) {
        const refused = spawnSync(shell ?? '', [...flags, '-c', selfTestScript(`${dir}/missing/x`)])
        expect({ shell, status: refused.status }).toEqual({ shell, status: 0 })
        const written = spawnSync(shell ?? '', [...flags, '-c', selfTestScript(`${dir}/x`)])
        expect({ shell, status: written.status }).toEqual({ shell, status: 3 })
        expect(readFileSync(`${dir}/x`, 'utf8')).toBe('x\n')
        rmSync(`${dir}/x`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('04 验收 2: win32 and WSL1 never initialize', async () => {
    const win32 = harness('win32')
    const winOutcome = await outcomeOf(win32)
    expect(winOutcome).toMatchObject({
      state: 'unavailable',
      session: null,
      reasons: [{ code: 'windows', detail: null }],
      initialize: 'not-called',
    })
    expect(win32.srt.initialize).not.toHaveBeenCalled()
    expect(win32.chdir).not.toHaveBeenCalled()
    expect(win32.runs).toEqual([])

    const freebsd = harness('freebsd')
    expect(reasons(await outcomeOf(freebsd))).toEqual([
      { code: 'unsupported-platform', detail: 'freebsd' },
    ])
    expect(freebsd.srt.initialize).not.toHaveBeenCalled()

    const wsl1 = harness('linux', { wsl: '1' })
    expect(reasons(await outcomeOf(wsl1))).toEqual([{ code: 'wsl1', detail: null }])
    expect(wsl1.srt.initialize).not.toHaveBeenCalled()
    expect(wsl1.chdir).not.toHaveBeenCalled()

    const wsl2 = harness('linux', { wsl: '2' })
    expect((await outcomeOf(wsl2)).state).toBe('active')
    expect(wsl2.srt.initialize).toHaveBeenCalledTimes(1)
  })

  it('04 验收 2: a userns-restricted detail ends with the bwrap step 2 found, for the fix (spec §启动 step 6)', async () => {
    // /usr/local/bin/bwrap is first on PATH but not executable: the fix names /usr/bin/bwrap.
    const h = harness('linux', { selfTest: { code: 1, stderr: APPLY_SECCOMP_STDERR } })
    h.disk.file('/opt/bubblewrap/bin/bwrap', '', 0o755)
    h.env['PATH'] = '/opt/bubblewrap/bin:/usr/local/bin:/usr/bin:/bin'
    const outcome = await outcomeOf(h)
    expect(h.sessions[0]?.linuxBinaries?.bwrap).toBe('/opt/bubblewrap/bin/bwrap')
    expect(outcome.reasons).toEqual([
      {
        code: 'userns-restricted',
        detail:
          'kernel.apparmor_restrict_unprivileged_userns=0\nkernel.unprivileged_userns_clone=1\n' +
          `user.max_user_namespaces=15329\nexited 1\n${APPLY_SECCOMP_STDERR}` +
          'bwrap=/opt/bubblewrap/bin/bwrap',
      },
    ])
    // A stderr that does not end its line still leaves the path a line of its own.
    const bare = harness('linux', { selfTest: { code: 1, stderr: '' } })
    bare.disk.file('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1\n')
    expect(reasons(await outcomeOf(bare))).toEqual([
      {
        code: 'userns-restricted',
        detail:
          'kernel.apparmor_restrict_unprivileged_userns=1\nkernel.unprivileged_userns_clone=1\n' +
          'user.max_user_namespaces=15329\nexited 1\nbwrap=/usr/bin/bwrap',
      },
    ])
    // Only userns-restricted carries it: the fix is for that code alone.
    const other = harness('linux', { selfTest: { code: 1, stderr: 'sh: 1: oops\n' } })
    expect(reasons(await outcomeOf(other))).toEqual([
      {
        code: 'self-test-failed',
        detail:
          'kernel.apparmor_restrict_unprivileged_userns=0\nkernel.unprivileged_userns_clone=1\n' +
          'user.max_user_namespaces=15329\nexited 1\nsh: 1: oops\n',
      },
    ])
  })

  it('04 验收 2: the three sysctl readings reach the detail', async () => {
    const h = harness('linux', { selfTest: { code: 1, stderr: BWRAP_LOOPBACK_STDERR } })
    h.disk.file('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1\n')
    h.disk.file('/proc/sys/kernel/unprivileged_userns_clone', '1\n')
    h.disk.file('/proc/sys/user/max_user_namespaces', '63432\n')
    const outcome = await outcomeOf(h)
    const detail = outcome.reasons[0]?.detail ?? ''
    expect(detail.split('\n').slice(0, 3)).toEqual([
      'kernel.apparmor_restrict_unprivileged_userns=1',
      'kernel.unprivileged_userns_clone=1',
      'user.max_user_namespaces=63432',
    ])

    // A reading that is not there says so; each restricting one alone is enough.
    for (const [path, value] of [
      ['/proc/sys/kernel/unprivileged_userns_clone', '0'],
      ['/proc/sys/user/max_user_namespaces', '0'],
    ] as const) {
      const one = harness('linux', { selfTest: { code: 1, stderr: '' } })
      one.disk.removeTree('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
      one.disk.file(path, `${value}\n`)
      // oxlint-disable-next-line no-await-in-loop -- one case after the other
      const result = await outcomeOf(one)
      expect(result.reasons[0]?.code).toBe('userns-restricted')
      expect(result.reasons[0]?.detail?.split('\n')[0]).toBe(
        'kernel.apparmor_restrict_unprivileged_userns=(none)',
      )
      expect(result.reasons[0]?.detail).toContain(
        `${path.slice('/proc/sys/'.length).replace('/', '.')}=0`,
      )
    }
  })

  it('04 验收 2: no command run contains sudo', async () => {
    const scenarios: readonly [NodeJS.Platform, HarnessOptions][] = [
      ['darwin', {}],
      ['linux', {}],
      ['darwin', { initError: new Error(NESTED_INIT_ERROR), sandboxExec: { code: 71 } }],
      ['linux', { selfTest: { code: 1, stderr: APPLY_SECCOMP_STDERR } }],
      ['linux', { selfTest: { code: 1, stderr: BWRAP_LOOPBACK_STDERR } }],
      ['linux', { initError: new Error(DEPS_PREFIX + CAP_SETFCAP) }],
      ['linux', { warnings: [NO_SECCOMP] }],
    ]
    const commands: string[] = []
    for (const [platform, options] of scenarios) {
      const h = harness(platform, options)
      h.disk.file(
        h.at.stubs,
        JSON.stringify({ socat: [{ pid: 777, command: SOCAT_COMMAND('beef') }] }),
      )
      h.table.push({ pid: 777, ppid: 1, command: SOCAT_COMMAND('beef') })
      // A restricting reading: the path most tempting to "fix" with sudo is the one taken.
      if (platform === 'linux') {
        h.disk.file('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1\n')
      }
      // oxlint-disable-next-line no-await-in-loop -- one scenario after the other
      const outcome = await outcomeOf(h)
      commands.push(...h.runs.map(({ argv }) => argv.join(' ')))
      commands.push(...h.wraps.map(({ command, binShell }) => `${binShell} ${command}`))
      commands.push(...outcome.reasons.map((reason) => reason.detail ?? ''))
      // Only the fixed check and srt's wrap of the self-test are ever run.
      for (const { argv } of h.runs) {
        expect(
          argv[0] === '/usr/bin/sandbox-exec' ||
            argv.join(' ').startsWith('/bin/sh -c srt-wrapped'),
        ).toBe(true)
      }
    }
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.filter((command) => /\bsudo\b/.test(command))).toEqual([])
  })

  it('04 验收 2: the process chdirs to the given dir before initialize, making it when missing', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const h = harness(platform)
      expect(h.disk.has(h.at.cwdDir)).toBe(false)
      // oxlint-disable-next-line no-await-in-loop -- one platform after the other
      const outcome = await outcomeOf(h)
      expect(outcome.state).toBe('active')
      expect(h.chdir.mock.calls).toEqual([[h.at.cwdDir]])
      expect(h.order.indexOf(`chdir ${h.at.cwdDir}`)).toBe(0)
      expect(h.order.indexOf('initialize')).toBe(1)
      // Made as `/tmp/claude` is checked: this user's, 0700, a directory.
      expect(h.disk.lstat(h.at.cwdDir)).toMatchObject({ uid: SELF[platform], mode: 0o700 })
      expect(h.disk.lstat(h.at.cwdDir)?.isDirectory()).toBe(true)
    }
    // An existing one that passes is used as it is.
    const kept = harness('darwin')
    kept.disk.dir(kept.at.cwdDir, { mode: 0o700 })
    await outcomeOf(kept)
    expect(kept.chdir.mock.calls).toEqual([[kept.at.cwdDir]])
  })

  it("04 验收 2: a chdir dir that is a link, another user's or not 0700 is unavailable/init-failed and initialize is never called", async () => {
    const cases: readonly {
      readonly set: (h: ReturnType<typeof harness>) => void
      readonly why: string
    }[] = [
      {
        set: (h) => {
          h.disk.dir('/Users/u/elsewhere', { mode: 0o700 })
          h.disk.link(h.at.cwdDir, '/Users/u/elsewhere')
        },
        why: 'is a link',
      },
      {
        set: (h) => h.disk.dir(h.at.cwdDir, { uid: ANOTHER_USER, mode: 0o700 }),
        why: "is another user's",
      },
      { set: (h) => h.disk.dir(h.at.cwdDir, { mode: 0o755 }), why: 'is not 0700' },
      { set: (h) => h.disk.file(h.at.cwdDir, ''), why: 'is not a directory' },
    ]
    for (const { set, why } of cases) {
      const h = harness('darwin')
      set(h)
      // oxlint-disable-next-line no-await-in-loop -- one case after the other
      const outcome = await outcomeOf(h)
      expect(outcome).toMatchObject({
        state: 'unavailable',
        session: null,
        reasons: [
          {
            code: 'init-failed',
            detail: `/Users/u/Library/Application Support/Tenon/sandbox-cwd ${why}`,
          },
        ],
        initialize: 'not-called',
      })
      expect(h.chdir).not.toHaveBeenCalled()
      expect(h.srt.initialize).not.toHaveBeenCalled()
    }

    // chdir itself throwing: the same.
    const throws = harness('linux')
    throws.chdir.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, chdir')
    })
    expect(reasons(await outcomeOf(throws))).toEqual([
      {
        code: 'init-failed',
        detail: 'chdir /home/u/.config/Tenon/sandbox-cwd: EACCES: permission denied, chdir',
      },
    ])
    expect(throws.srt.initialize).not.toHaveBeenCalled()
  })

  it('04 验收 2: with no dir given (evals) it never chdirs', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const h = harness(platform, { chdir: false })
      // oxlint-disable-next-line no-await-in-loop -- one platform after the other
      const outcome = await outcomeOf(h)
      expect(outcome.state).toBe('active')
      expect(h.chdir).not.toHaveBeenCalled()
      expect(h.srt.initialize).toHaveBeenCalledTimes(1)
      expect(h.disk.has(h.at.cwdDir)).toBe(false)
    }
  })

  it('04 验收 2: every wording fixture is still srt79 own text', () => {
    const require = createRequire(import.meta.url)
    const dir = dirname(require.resolve('@anthropic-ai/sandbox-runtime/package.json'))
    const manager = readFileSync(join(dir, 'dist/sandbox/sandbox-manager.js'), 'utf8')
    const linux = readFileSync(join(dir, 'dist/sandbox/linux-sandbox-utils.js'), 'utf8')
    expect(manager).toContain(
      "throw new Error(`Sandbox dependencies not available: ${deps.errors.join(', ')}`);",
    )
    expect(manager).toContain('errors.push(`ripgrep (${rgToCheck.command}) not found`);')
    expect(linux).toContain('errors.push(`bubblewrap (bwrap) not executable at ${bwrapPath}`);')
    expect(linux).toContain("errors.push('bubblewrap (bwrap) not installed');")
    expect(linux).toContain('errors.push(`socat not executable at ${socatPath}`);')
    expect(linux).toContain("errors.push('socat not installed');")
    expect(linux).toContain(
      "warnings.push('seccomp not available - unix socket access not restricted');",
    )
    expect(linux).toContain(': `${CAP_SETFCAP_MISSING_MESSAGE} (bubblewrap: ${refusal})`;')
    expect(CAP_SETFCAP_MISSING_MESSAGE).toBe(CAP_SETFCAP)
    expect(linux).toContain(
      'return (`bubblewrap ${version} at ${bwrap} is older than ` +\n' +
        '        `${OLDEST_FULLY_SUPPORTED_BWRAP_VERSION}: a denyRead entry or credential ` +\n' +
        '        `mask naming a path that is not a regular file (a fifo, socket or device ` +\n' +
        '        `node) cannot be applied on it, and a mount point an interrupted sandbox ` +\n' +
        '        `left behind is not recognised as one and stays on the host. Everything ` +\n' +
        '        `else is unaffected`);',
    )
    expect(linux).toContain("export const OLDEST_FULLY_SUPPORTED_BWRAP_VERSION = '0.5.0';")
    const macos = readFileSync(join(dir, 'dist/sandbox/macos-sandbox-utils.js'), 'utf8')
    for (const source of [macos, linux]) {
      expect(source).toContain("throw new Error(`Shell '${shellName}' not found in PATH`);")
    }
    for (const arch of ['x64', 'arm64']) {
      const helper = readFileSync(join(dir, `vendor/seccomp/${arch}/apply-seccomp`)).toString(
        'latin1',
      )
      expect(helper).toContain(
        'apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN)',
      )
    }
  })
})

describe('04 验收 9 (startup): the record of mount points and leftovers', () => {
  it('04 验收 9 (startup): recorded empty mount-point dirs, recorded leaf mount points that are still empty read-only files, orphaned socat with the exact recorded command line and recorded tmpdir entries are removed; unrecorded ones with the same names are not', async () => {
    const h = harness('linux')
    const ws = '/home/u/code/app'
    const other = '/home/u/code/other'
    h.disk.dir(`${ws}/.claude`) // recorded, empty: goes
    h.disk.dir(`${ws}/.vscode`) // recorded, not empty: stays
    h.disk.file(`${ws}/.vscode/settings.json`, '{}')
    h.disk.dir(`${other}/.claude`) // the same name, unrecorded: stays
    h.disk.file(`${ws}/.codex`, '') // recorded, a file now: stays
    h.disk.dir('/home/u/empty-elsewhere') // recorded path is now a link to an empty dir: both stay
    h.disk.link(`${ws}/.idea`, '/home/u/empty-elsewhere')
    // Leaf mount points (srt's four conditions, linux-sandbox-utils.js:418-428): only what bwrap
    // made — a regular file, empty, no write bit, one link — goes.
    h.disk.file(`${ws}/.envrc`, '', 0o444) // bwrap's: goes
    h.disk.file(`${ws}/.zshrc`, '', 0o400) // bwrap's under a umask: goes
    h.disk.file(`${ws}/.mcp.json`, '{}', 0o444) // has content: stays
    h.disk.file(`${ws}/.gitconfig`, '', 0o644) // writable: stays
    h.disk.file(`${ws}/.ripgreprc`, '', 0o464) // group-writable: stays
    h.disk.file(`${ws}/.profile`, '', 0o444, 2) // a second link: stays
    h.disk.fifo(`${ws}/.cursor`, 0o444) // not a regular file: stays
    h.disk.dir(`${ws}/.gemini`, { mode: 0o555 }) // a directory: stays
    h.disk.file(`${other}/.envrc`, '', 0o444) // the same name, unrecorded: stays
    h.disk.file('/tmp/claude-http-aa11.sock')
    h.disk.dir('/tmp/srt-obs-AbC123', { mode: 0o700 })
    h.disk.file('/tmp/srt-obs-AbC123/s1.sock')
    h.disk.file('/tmp/srt-mux-999-0.sock')
    h.disk.file('/tmp/claude-http-bb22.sock') // unrecorded: another srt user's
    h.disk.file('/tmp/srt-mux-888-0.sock') // unrecorded
    h.disk.file(
      h.at.stubs,
      JSON.stringify({
        mountPoints: {
          'toolu_01.0a0b': [`${ws}/.claude`, `${ws}/.vscode`],
          'toolu_02.0c0d': [`${ws}/.codex`, `${ws}/.idea`],
        },
        leafMountPoints: {
          'toolu_01.0a0b': [`${ws}/.envrc`, `${ws}/.zshrc`, `${ws}/.mcp.json`, `${ws}/.gitconfig`],
          'toolu_02.0c0d': [
            `${ws}/.ripgreprc`,
            `${ws}/.profile`,
            `${ws}/.cursor`,
            `${ws}/.gemini`,
            `${ws}/.aws`,
          ],
        },
        pid: 999,
        socat: [
          { pid: 4242, command: SOCAT_COMMAND('aa11') },
          { pid: 4343, command: SOCAT_COMMAND('cc33') },
          { pid: 4444, command: SOCAT_COMMAND('dd44') },
        ],
        tmpEntries: [
          '/tmp/claude-http-aa11.sock',
          '/tmp/srt-obs-AbC123',
          '/tmp/srt-mux-999-0.sock',
        ],
      }),
    )
    h.table.push(
      { pid: 1234, ppid: 1, command: '/usr/lib/systemd/systemd --user' },
      { pid: 4242, ppid: 1, command: SOCAT_COMMAND('aa11') }, // the recorded orphan: killed
      { pid: 4343, ppid: 1, command: '/usr/bin/sleep 600' }, // its pid reused: left alone
      // An orphan a desktop session's subreaper (`systemd --user`) took in: killed all the same.
      { pid: 4444, ppid: 1234, command: SOCAT_COMMAND('dd44') },
      { pid: 4545, ppid: 1, command: SOCAT_COMMAND('ee55') }, // unrecorded: left alone
    )

    const outcome = await outcomeOf(h)
    expect(outcome.state).toBe('active')
    expect(h.killed).toEqual([4242, 4444])
    expect(h.disk.has(`${ws}/.claude`)).toBe(false)
    expect(h.disk.has(`${ws}/.vscode/settings.json`)).toBe(true)
    expect(h.disk.has(`${other}/.claude`)).toBe(true)
    expect(h.disk.has(`${ws}/.codex`)).toBe(true)
    expect(h.disk.lstat(`${ws}/.idea`)?.isSymbolicLink()).toBe(true)
    expect(h.disk.lstat('/home/u/empty-elsewhere')?.isDirectory()).toBe(true)
    const leaves = [
      '.envrc',
      '.zshrc',
      '.mcp.json',
      '.gitconfig',
      '.ripgreprc',
      '.profile',
      '.cursor',
      '.gemini',
    ]
    expect(leaves.filter((name) => h.disk.has(`${ws}/${name}`))).toEqual([
      '.mcp.json',
      '.gitconfig',
      '.ripgreprc',
      '.profile',
      '.cursor',
      '.gemini',
    ])
    expect(h.disk.text(`${ws}/.mcp.json`)).toBe('{}')
    expect(h.disk.has(`${other}/.envrc`)).toBe(true)
    for (const gone of [
      '/tmp/claude-http-aa11.sock',
      '/tmp/srt-obs-AbC123',
      '/tmp/srt-mux-999-0.sock',
    ]) {
      expect(h.disk.has(gone)).toBe(false)
    }
    expect(h.disk.has('/tmp/claude-http-bb22.sock')).toBe(true)
    expect(h.disk.has('/tmp/srt-mux-888-0.sock')).toBe(true)
    // All of it before initialize (spec §启动 step 2).
    expect(h.order.indexOf('kill 4242')).toBeLessThan(h.order.indexOf('initialize'))

    // The record now holds this run's: main's pid, srt's socat and its new tmpdir entries.
    expect(JSON.parse(h.disk.text(h.at.stubs) ?? '{}')).toEqual({
      pid: MAIN_PID,
      socat: [{ pid: 5555, command: SOCAT_COMMAND('cafe01') }],
      tmpEntries: [
        `/tmp/srt-mux-${MAIN_PID}-0.sock`,
        '/tmp/claude-http-cafe01.sock',
        '/tmp/srt-obs-Q1w2e3',
      ],
    })
  })

  it("04 验收 9 (startup): a recorded entry outside main's tmpdir, or not of the three kinds initialize makes (claude-empty-* is a wrap's), is left alone", async () => {
    const h = harness('linux')
    h.disk.dir('/home/u/x/srt-obs-AbC123', { mode: 0o700 })
    h.disk.file('/home/u/x/srt-obs-AbC123/keep.md', 'notes')
    h.disk.dir('/tmp/notes-AbC123', { mode: 0o700 })
    h.disk.file('/tmp/notes-AbC123/keep.md', 'notes')
    // srt makes claude-empty-* at a wrap (linux-sandbox-utils.js:400, :2161), never in initialize:
    // a record that names one names another srt user's.
    h.disk.dir('/tmp/claude-empty-XyZ789', { mode: 0o700 })
    h.disk.file('/tmp/claude-http-aa11.sock')
    h.disk.file(
      h.at.stubs,
      JSON.stringify({
        pid: 999,
        tmpEntries: [
          '/home/u/x/srt-obs-AbC123',
          '/tmp/notes-AbC123',
          '/tmp/claude-empty-XyZ789',
          '/tmp/claude-http-aa11.sock',
        ],
      }),
    )
    await outcomeOf(h)
    expect({
      outside: h.disk.has('/home/u/x/srt-obs-AbC123/keep.md'),
      otherName: h.disk.has('/tmp/notes-AbC123/keep.md'),
      claudeEmpty: h.disk.has('/tmp/claude-empty-XyZ789'),
      recorded: h.disk.has('/tmp/claude-http-aa11.sock'),
    }).toEqual({ outside: true, otherName: true, claudeEmpty: true, recorded: false })
  })

  it("04 验收 9 (startup): another srt user's claude-http, srt-mux, srt-obs and claude-empty entries made in main's tmpdir while initialize runs, and any made after it, are not recorded, nor removed next time", async () => {
    let first = true
    const foreign = [
      '/tmp/claude-http-beef02.sock', // no bridge of ours listens on it
      '/tmp/srt-mux-888-1.sock', // another process's pid
      '/tmp/srt-obs-Fo7Re1', // its socket listens, under an inode none of main's fds holds
      '/tmp/srt-obs-Gh3Jk4', // its socket not listed in /proc/net/unix at all
      '/tmp/claude-empty-Ab12Cd', // srt makes ours at a wrap, never in initialize
      '/tmp/srt-obs-Zz9Yy8', // during the self-test
      '/tmp/claude-http-dead03.sock', // during the self-test
    ]
    const h = harness('linux', {
      duringInitialize: (disk) => {
        if (!first) return
        disk.file('/tmp/claude-http-beef02.sock')
        disk.file('/tmp/srt-mux-888-1.sock')
        disk.dir('/tmp/srt-obs-Fo7Re1', { mode: 0o700 })
        disk.file('/tmp/srt-obs-Fo7Re1/s99887766.sock')
        unixRow(disk, '77777', '/tmp/srt-obs-Fo7Re1/s99887766.sock')
        disk.dir('/tmp/srt-obs-Gh3Jk4', { mode: 0o700 })
        disk.file('/tmp/srt-obs-Gh3Jk4/s55443322.sock')
        disk.dir('/tmp/claude-empty-Ab12Cd', { mode: 0o700 })
      },
      duringSelfTest: (disk) => {
        if (!first) return
        disk.dir('/tmp/srt-obs-Zz9Yy8', { mode: 0o700 })
        disk.file('/tmp/claude-http-dead03.sock')
      },
    })
    expect((await outcomeOf(h)).state).toBe('active')
    expect(JSON.parse(h.disk.text(h.at.stubs) ?? '{}')).toEqual({
      pid: MAIN_PID,
      socat: [{ pid: 5555, command: SOCAT_COMMAND('cafe01') }],
      tmpEntries: [
        `/tmp/srt-mux-${MAIN_PID}-0.sock`,
        '/tmp/claude-http-cafe01.sock',
        '/tmp/srt-obs-Q1w2e3',
      ],
    })

    // The next startup (the recorder's pid is its own, so that run is gone) removes ours only.
    first = false
    await outcomeOf(h)
    expect(h.disk.removed).toEqual(
      expect.arrayContaining([
        `/tmp/srt-mux-${MAIN_PID}-0.sock`,
        '/tmp/claude-http-cafe01.sock',
        '/tmp/srt-obs-Q1w2e3',
      ]),
    )
    expect(foreign.filter((path) => !h.disk.has(path))).toEqual([])
  })

  it('04 验收 9 (startup): socat, leaf mount points and tmpdir entries stay while the run that recorded them is alive; a socat whose parent is that run is never killed; darwin records no socat', async () => {
    const ws = '/home/u/code/app'
    const record = (pid: number) =>
      JSON.stringify({
        pid,
        socat: [
          { pid: 4242, command: SOCAT_COMMAND('aa11') },
          { pid: 4343, command: SOCAT_COMMAND('bb22') },
        ],
        leafMountPoints: { 'toolu_01.0a0b': [`${ws}/.envrc`] },
        tmpEntries: ['/tmp/claude-http-aa11.sock'],
      })
    const alive = harness('linux')
    alive.disk.file('/tmp/claude-http-aa11.sock')
    alive.disk.file(`${ws}/.envrc`, '', 0o444)
    alive.disk.file(alive.at.stubs, record(999))
    alive.table.push(
      { pid: 999, ppid: 1, command: '/opt/Tenon/tenon' },
      { pid: 4242, ppid: 1, command: SOCAT_COMMAND('aa11') },
      { pid: 4343, ppid: 999, command: SOCAT_COMMAND('bb22') },
    )
    await outcomeOf(alive)
    expect({
      killed: alive.killed,
      leaf: alive.disk.has(`${ws}/.envrc`),
      tmp: alive.disk.has('/tmp/claude-http-aa11.sock'),
    }).toEqual({ killed: [], leaf: true, tmp: true })

    // The recorder's pid is this process's own: that run is gone. Its orphan goes; a socat whose
    // parent has that pid is this process's child, never the old run's orphan.
    const reused = harness('linux')
    reused.disk.file('/tmp/claude-http-aa11.sock')
    reused.disk.file(`${ws}/.envrc`, '', 0o444)
    reused.disk.file(reused.at.stubs, record(MAIN_PID))
    reused.table.push(
      { pid: 4242, ppid: 1, command: SOCAT_COMMAND('aa11') },
      { pid: 4343, ppid: MAIN_PID, command: SOCAT_COMMAND('bb22') },
    )
    await outcomeOf(reused)
    expect({
      killed: reused.killed,
      leaf: reused.disk.has(`${ws}/.envrc`),
      tmp: reused.disk.has('/tmp/claude-http-aa11.sock'),
    }).toEqual({ killed: [4242], leaf: false, tmp: false })

    // No process table: nothing that waits on it goes.
    const blind = harness('linux')
    blind.disk.file(`${ws}/.envrc`, '', 0o444)
    blind.disk.file(blind.at.stubs, record(999))
    blind.deps.processes.list = async () => {
      throw new Error('ps: not found')
    }
    await outcomeOf(blind)
    expect({ killed: blind.killed, leaf: blind.disk.has(`${ws}/.envrc`) }).toEqual({
      killed: [],
      leaf: true,
    })

    const darwin = harness('darwin')
    await outcomeOf(darwin)
    expect(JSON.parse(darwin.disk.text(darwin.at.stubs) ?? '{}')).toEqual({
      pid: MAIN_PID,
      socat: [],
      tmpEntries: [`/private/var/folders/zz/q1w2/T/srt-mux-${MAIN_PID}-0.sock`],
    })
  })
})
