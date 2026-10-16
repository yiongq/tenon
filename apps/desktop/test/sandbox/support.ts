/**
 * Plumbing for the sandbox black-box suite (spec 04 §验收标准 6, 7, 9–16; Q5 A; 读法 24; plan step 6):
 * the `TENON_SANDBOX_TESTS` gate, sandbox-runtime started once per test process the way desktop
 * starts it (`startSandboxPosture`, chdir left out as on the eval host, 读法 45), real
 * `DesktopSandbox` instances over temporary homes, profiles and workspaces, a local HTTP fixture and
 * a scan of the host's process table by marker.
 *
 * Nothing here reads or writes the real home's dotfiles or credentials: every home, profile and
 * workspace is a temporary directory, never under the test process's cwd, and the commands get a
 * request env whose HOME is the test home. The suite never leaves the machine: a host off the
 * allowlist is refused by srt's proxy before any lookup.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { SandboxRuntimeConfig, SandboxViolationEvent } from '@anthropic-ai/sandbox-runtime'
import type { AbsolutePath, SandboxViolation } from '@tenon-app/kernel'
import { COMMAND_SCRIPT } from '../../../../packages/kernel/src/tools/builtin/bash.js'
import { createHostProcess } from '../../src/main/host/process.js'
import {
  DesktopSandbox,
  desktopProcessTable,
  desktopSandboxFs,
  type SandboxSettings,
  type SrtSandbox,
} from '../../src/main/host/sandbox.js'
import {
  credentialPaths,
  helperPaths,
  sessionConfig,
  type PathPorts,
  type SandboxHostPaths,
  type SandboxPlatform,
} from '../../src/main/host/sandbox-config.js'
import {
  desktopPostureFs,
  desktopPostureProcesses,
  desktopPostureRunner,
  desktopSrtStartup,
  startSandboxPosture,
  type SandboxPostureOutcome,
  type SandboxPostureRun,
} from '../../src/main/host/sandbox-posture.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------------------------
// The gate (读法 24)

/** The variable that turns the suite on (plan 开工前读「沙箱外」). */
export const SANDBOX_TESTS_VARIABLE = 'TENON_SANDBOX_TESTS'

export type SandboxTestsGate =
  | { readonly run: true }
  | { readonly run: false; readonly reason: string }

/**
 * `required` runs the suite, and the suite then fails unless the sandbox starts `active`; unset or
 * `skip` skips it with the reason printed. Any other value is a typo that must not quietly skip
 * the suite, so it throws. (The CI half — `CI` set and neither value — is plan step 21.)
 */
export function sandboxTestsGate(value: string | undefined): SandboxTestsGate {
  if (value === 'required') return { run: true }
  if (value === undefined || value === '') {
    return {
      run: false,
      reason:
        `${SANDBOX_TESTS_VARIABLE} is not set: the sandbox black-box suite is skipped. ` +
        `Set it to "required" where sandbox-runtime can start (macOS outside any other sandbox, ` +
        `Linux with bwrap, socat and rg and user namespaces allowed).`,
    }
  }
  if (value === 'skip') {
    return {
      run: false,
      reason: `${SANDBOX_TESTS_VARIABLE}=skip: the sandbox black-box suite is skipped.`,
    }
  }
  throw new Error(
    `${SANDBOX_TESTS_VARIABLE} must be "required" or "skip" (or unset), not ${JSON.stringify(value)}`,
  )
}

/** Under `required` the posture must be `active`: `degraded` fails the suite too (读法 24). */
export function assertSandboxActive(
  outcome: Pick<SandboxPostureOutcome, 'state' | 'reasons'>,
): void {
  if (outcome.state === 'active') return
  const reasons = outcome.reasons.map((one) => `${one.code}: ${one.detail ?? ''}`).join('; ')
  throw new Error(
    `${SANDBOX_TESTS_VARIABLE}=required but the sandbox is ${outcome.state}` +
      (reasons === '' ? '' : ` (${reasons})`),
  )
}

// ---------------------------------------------------------------------------------------------
// Constants

export const PLATFORM: SandboxPlatform = process.platform === 'darwin' ? 'darwin' : 'linux'
export const DARWIN = process.platform === 'darwin'

/** The shell the platform's commands run in; Bash's argv[0] is always an absolute shell (02:1930). */
export const SHELL = DARWIN ? '/bin/zsh' : '/bin/bash'

/** The PATH a command gets: the system's own directories only. */
export const COMMAND_PATH = DARWIN
  ? '/usr/bin:/bin:/usr/sbin:/sbin'
  : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

/** How long a command may run before the suite kills it. */
const COMMAND_TIMEOUT_MS = 30_000
/** How long the output may trail the exit (STOP_EXIT_CONFIRM_MS, as Bash drains it). */
const OUTPUT_TRAIL_MS = 500

/** One random session per lab: `toolOutputDirFor` wants a canonical UUID. */
function sessionUuid(): string {
  const hex = randomBytes(16).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

const abs = (path: string): AbsolutePath => path as AbsolutePath

/** `path` is `dir` or lies under it. */
export function isWithinDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`)
}

// ---------------------------------------------------------------------------------------------
// The rig: sandbox-runtime started once per test process

export interface SandboxRig {
  /** The temporary root every lab lives under: a real path, no link on its way (see below). */
  readonly root: string
  readonly outcome: SandboxPostureOutcome
  /**
   * A fresh home, profile, cache and `DesktopSandbox`, sharing this process's srt. `underLink` puts
   * the lab under `<root>/linked`, a link to `<root>/linked-real`, so every path it spells crosses
   * a link, as a home or workspace under `/tmp` or `/var` does on macOS.
   */
  lab(options?: { readonly underLink?: boolean }): SandboxLab
  /** The effective allowlist, through srt's `updateConfig`; never a reset (§网络白名单). */
  setAllowlist(domains: readonly string[]): void
  /** The port srt's HTTP proxy listens on, on the host. */
  proxyPort(): number | undefined
  /** Every violation event srt stored since startup, timed as it arrived. */
  readonly arrivals: readonly ViolationArrival[]
  /** Every line `DesktopSandbox` and startup logged. */
  readonly logs: readonly string[]
  /** One line on the calls run so far and how their violations arrived, for the run's record. */
  summary(): string
  dispose(): Promise<void>
}

/** When srt stored one event, keyed by the srt id it carries (performance.now() clock). */
export interface ViolationArrival {
  readonly key: string | null
  readonly line: string
  readonly at: number
}

/**
 * Starts sandbox-runtime the way desktop does (§启动、自检与姿态), with the eval host's one
 * difference: no chdir (读法 45, 50), so srt's own mandatory denies anchor at this process's cwd,
 * which no lab is under. The outcome is returned as it is; the caller asserts it is `active`.
 */
export async function startSandboxRig(): Promise<SandboxRig> {
  // The labs lie on a real path, as a real home does (/Users/<u> has no link on its way). macOS's
  // os.tmpdir() is /var/folders/…, under the system link /var: there a deny entry as written never
  // matches Seatbelt, which compares resolved paths, nor do srt's rules on its ancestors, and /var
  // itself joins darwin's denyWrite as a link on the way, which changes what a refusal reports
  // (step 6 review r3). `lab({ underLink: true })` keeps that layout for the cases about it.
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'tenon-escape-'))
  makeDir(join(root, 'linked-real'))
  symlinkSync(join(root, 'linked-real'), join(root, 'linked'))
  const startupHome = makeDir(join(root, 'startup-home'))
  const startupProfile = makeDir(join(root, 'startup-profile'))
  const logs: string[] = []
  const log = (line: string): void => {
    logs.push(line)
  }
  const helpers = helperPaths()
  const startupPaths = hostPaths({
    home: startupHome,
    profileDir: startupProfile,
    cacheDir: join(root, 'startup-userData', 'sandbox-cache'),
    srtPackageDir: helpers.packageDir,
  })
  const ports = pathPorts()
  const run = startSandboxPosture({
    platform: process.platform,
    arch: process.arch,
    srt: desktopSrtStartup(),
    helpers,
    sessionConfig: (parts) =>
      sessionConfig({ ...startupPaths, noSeccomp: false, allowedDomains: [], ...parts }, ports),
    env: process.env,
    chdirDir: null,
    chdir: () => {
      throw new Error('the test rig never chdirs (读法 45)')
    },
    fs: desktopPostureFs(),
    tmpdir: abs(tmpdir()),
    processes: desktopPostureProcesses(),
    run: desktopPostureRunner(createHostProcess()),
    uid: process.getuid?.() ?? 0,
    pid: process.pid,
    home: abs(startupHome),
    profileDir: abs(startupProfile),
    log,
  })
  const outcome = await run.outcome

  const arrivals: ViolationArrival[] = []
  let unsubscribe: (() => void) | undefined
  if (outcome.session !== null) {
    const store = SandboxManager.getSandboxViolationStore()
    let seen = store.getTotalCount()
    unsubscribe = store.subscribe((events: SandboxViolationEvent[]) => {
      const at = performance.now()
      const total = store.getTotalCount()
      const fresh = Math.min(total - seen, events.length)
      seen = total
      for (const event of fresh > 0 ? events.slice(events.length - fresh) : []) {
        const key =
          event.encodedCommand === undefined
            ? null
            : Buffer.from(event.encodedCommand, 'base64').toString('utf8')
        arrivals.push({ key, line: event.line, at })
      }
    })
  }

  let session: SandboxRuntimeConfig | null = outcome.session
  let labs = 0
  const calls: { readonly ms: number; readonly arrivalMs: readonly number[] }[] = []
  return {
    root,
    outcome,
    arrivals,
    logs,
    lab: (options = {}) =>
      newLab({
        root: join(root, options.underLink === true ? 'linked' : '', `lab-${String(++labs)}`),
        run,
        helpers,
        log,
        arrivals,
        calls,
      }),
    summary: () => {
      const arrived = calls.flatMap((call) => call.arrivalMs).toSorted((a, b) => a - b)
      const durations = calls.map((call) => call.ms).toSorted((a, b) => a - b)
      return (
        `${String(calls.length)} sandboxed calls (wrap to exit p50 ${quantile(durations, 0.5)} ms, max ` +
        `${quantile(durations, 1)} ms); ${String(arrived.length)} of their violations reached srt's ` +
        `store at exit ${quantile(arrived, 0)}…${quantile(arrived, 1)} ms (p99 ${quantile(arrived, 0.99)} ms; ` +
        `negative = before the exit)`
      )
    },
    proxyPort: () => SandboxManager.getProxyPort(),
    setAllowlist: (domains) => {
      if (session === null) throw new Error('the sandbox did not start')
      session = { ...session, network: { ...session.network, allowedDomains: [...domains] } }
      SandboxManager.updateConfig(session)
    },
    dispose: async () => {
      unsubscribe?.()
      if (outcome.session !== null) {
        await Promise.race([
          SandboxManager.reset(),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ])
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** The `q` quantile of a sorted list, nearest rank; `-` when empty. */
function quantile(list: readonly number[], q: number): string {
  if (list.length === 0) return '-'
  return String(list[Math.min(list.length - 1, Math.max(0, Math.ceil(q * list.length) - 1))])
}

function hostPaths(q: {
  readonly home: string
  readonly profileDir: string
  readonly cacheDir: string
  readonly srtPackageDir: string
}): Omit<SandboxHostPaths, 'noSeccomp'> {
  return {
    platform: PLATFORM,
    home: abs(q.home),
    zdotdir: null,
    profileDir: abs(q.profileDir),
    cacheDir: abs(q.cacheDir),
    chdirDir: null,
    srtPackageDir: abs(q.srtPackageDir),
    credentials: credentialPaths(PLATFORM, abs(q.home)),
    uid: process.getuid?.() ?? 0,
    xdgRuntimeDir: process.env['XDG_RUNTIME_DIR'] ?? null,
    sshAuthSock: process.env['SSH_AUTH_SOCK'] ?? null,
  }
}

function pathPorts(): PathPorts {
  return {
    realpath: (path) => realpathSync(path),
    lstat: (path) => lstatSync(path, { throwIfNoEntry: false }),
    readlink: (path) => readlinkSync(path),
  }
}

/** sandbox-runtime itself, as `DesktopSandbox` asks for it. */
function realSrt(): SrtSandbox {
  return {
    wrapWithSandboxArgv: (command, binShell, customConfig, abortSignal, cwd, options) =>
      SandboxManager.wrapWithSandboxArgv(
        command,
        binShell,
        customConfig,
        abortSignal,
        cwd,
        options,
      ),
    cleanupAfterCommand: () => SandboxManager.cleanupAfterCommand(),
    getSandboxViolationStore: () => SandboxManager.getSandboxViolationStore(),
    reset: () => SandboxManager.reset(),
  }
}

// ---------------------------------------------------------------------------------------------
// A lab: one home, profile, cache and DesktopSandbox

export interface RunOptions {
  /** `request.workspace`; each is a session folder unless `release` says otherwise. */
  readonly workspace: readonly string[]
  /** Defaults to the first workspace item. */
  readonly cwd?: string
  readonly profile?: 'read-only' | 'workspace-write'
  /** `request.env`; defaults to `lab.requestEnv()`. */
  readonly env?: Record<string, string>
  /** The whole argv; defaults to Bash's shape around `command` (bash.ts:125). */
  readonly argv?: readonly string[]
}

export interface Ran {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly violations: readonly SandboxViolation[]
  /** The srt id this call's wrap handed srt. */
  readonly srtId: string
  /** ms from the exit to each of this call's violations reaching srt's store (negative: before). */
  readonly arrivalMs: readonly number[]
  readonly ms: number
}

export interface SandboxLab {
  readonly home: string
  readonly profileDir: string
  readonly cacheDir: string
  readonly sessionId: string
  /** `<profile>/tool-output/<sessionId>/`. */
  readonly toolOutputDir: string
  readonly sandbox: DesktopSandbox
  /** Your choices under 「权限与网络」, read at every wrap. */
  settings: SandboxSettings
  /** A fresh directory under the lab. */
  dir(name: string): string
  /** The session's folders: the workspace items that are folders, not path releases. */
  folders: string[]
  requestEnv(extra?: Record<string, string>): Record<string, string>
  run(command: string, options: RunOptions): Promise<Ran>
}

function newLab(q: {
  readonly root: string
  readonly run: SandboxPostureRun
  readonly helpers: ReturnType<typeof helperPaths>
  readonly log: (line: string) => void
  readonly arrivals: readonly ViolationArrival[]
  readonly calls: { ms: number; arrivalMs: readonly number[] }[]
}): SandboxLab {
  makeDir(q.root)
  const home = makeDir(join(q.root, 'home'))
  const profileDir = makeDir(join(q.root, 'profile'))
  const cacheDir = join(q.root, 'userData', 'sandbox-cache')
  const sessionId = sessionUuid()
  const toolOutputDir = makeDir(join(profileDir, 'tool-output', sessionId))
  const lastIds: string[] = []
  const srt = realSrt()
  const recordingSrt: SrtSandbox = {
    ...srt,
    wrapWithSandboxArgv: (command, binShell, customConfig, abortSignal, cwd, options) => {
      lastIds.push(options.commandId)
      return srt.wrapWithSandboxArgv(command, binShell, customConfig, abortSignal, cwd, options)
    },
  }
  const sandbox = new DesktopSandbox({
    srt: recordingSrt,
    paths: hostPaths({ home, profileDir, cacheDir, srtPackageDir: q.helpers.packageDir }),
    settings: () => lab.settings,
    sessionFolders: async () => lab.folders.map(abs),
    fs: desktopSandboxFs(),
    processes: desktopProcessTable(),
    // The test process keeps its own signal handling: no `app.quit` here.
    onSignal: () => {},
    log: q.log,
  })
  const lab: SandboxLab = {
    home,
    profileDir,
    cacheDir,
    sessionId,
    toolOutputDir,
    settings: { profile: 'workspace-write', packageManagers: false },
    folders: [],
    sandbox,
    dir: (name) => makeDir(join(q.root, name)),
    requestEnv: (extra = {}) => ({
      PATH: COMMAND_PATH,
      HOME: home,
      LANG: 'C',
      ...extra,
    }),
    run: async (command, options) => {
      const commandId = `toolu_escape_${randomBytes(6).toString('hex')}`
      const cwd = options.cwd ?? options.workspace[0]
      if (cwd === undefined) throw new Error('a run needs a cwd or a workspace')
      sandbox.beforeWrap({ commandId, sessionId })
      const started = performance.now()
      const wrapped = await sandbox.wrap({
        commandId,
        argv: [...(options.argv ?? [SHELL, '-c', COMMAND_SCRIPT, SHELL, command])],
        cwd: abs(cwd),
        env: options.env ?? lab.requestEnv(),
        profile: options.profile ?? 'workspace-write',
        workspace: options.workspace.map(abs),
      })
      const srtId = lastIds.at(-1) ?? ''
      // afterExit even when the spawn throws, as the kernel does (读法 7): srt's Linux count of open
      // commands would otherwise stay up and defer every later cleanup in this process.
      let ran: Awaited<ReturnType<typeof spawnToEnd>>
      try {
        ran = await spawnToEnd(wrapped.argv, cwd, wrapped.env)
      } finally {
        await sandbox.afterExit(commandId)
      }
      const violations = await sandbox.violations(commandId)
      const key = Buffer.from(srtId.slice(0, 100)).toString('utf8')
      const arrivalMs = q.arrivals
        .filter((arrival) => arrival.key === key)
        .map((arrival) => Math.round((arrival.at - ran.exitedAt) * 10) / 10)
      const ms = Math.round(ran.exitedAt - started)
      q.calls.push({ ms, arrivalMs })
      return { ...ran.result, violations, srtId, arrivalMs, ms }
    },
  }
  sandbox.start(q.run)
  return lab
}

/**
 * Spawns through desktop's HostProcess and runs the command to its end the way §执行与收口 says a
 * normal exit goes: read the output (at most `STOP_EXIT_CONFIRM_MS` past the exit), then SIGKILL
 * the process group. A command past `COMMAND_TIMEOUT_MS` is killed.
 */
async function spawnToEnd(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{
  readonly result: Pick<Ran, 'code' | 'signal' | 'stdout' | 'stderr'>
  readonly exitedAt: number
}> {
  const child = await createHostProcess().spawn({
    argv: [...argv],
    cwd: abs(cwd),
    env,
    stdio: 'pipe',
  })
  const stdin = child.stdin.getWriter()
  void stdin.closed.catch(() => {})
  void stdin.close().catch(() => {})
  const stdout = collect(child.stdout)
  const stderr = collect(child.stderr)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), COMMAND_TIMEOUT_MS)
  })
  const first = await Promise.race([child.exited, timedOut])
  clearTimeout(timer)
  if (first === 'timeout') await child.kill('SIGKILL')
  const exit = await child.exited
  const exitedAt = performance.now()
  await Promise.race([
    Promise.all([stdout.done, stderr.done]),
    new Promise((resolve) => setTimeout(resolve, OUTPUT_TRAIL_MS)),
  ])
  await child.kill('SIGKILL').catch(() => {})
  stdout.cancel()
  stderr.cancel()
  return {
    result: { code: exit.code, signal: exit.signal, stdout: stdout.text(), stderr: stderr.text() },
    exitedAt,
  }
}

function collect(stream: ReadableStream<Uint8Array>): {
  readonly done: Promise<void>
  text(): string
  cancel(): void
} {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const done = (async () => {
    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- one chunk after another
        const { done: end, value } = await reader.read()
        if (end) return
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      // A cancelled read ends what there is.
    }
  })()
  return {
    done,
    text: () => text,
    cancel: () => {
      void reader.cancel().catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The host's side

export function makeDir(path: string, mode = 0o700): string {
  mkdirSync(path, { recursive: true, mode })
  return path
}

export function writeHostFile(path: string, text: string, mode = 0o600): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, { mode })
  return path
}

/** What is at `path`, a link not followed. */
export function hostKind(path: string): 'missing' | 'file' | 'dir' | 'link' | 'other' {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return 'missing'
  if (stat.isSymbolicLink()) return 'link'
  if (stat.isDirectory()) return 'dir'
  return stat.isFile() ? 'file' : 'other'
}

/** One POSIX-shell word. */
export function shq(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/** A marker no other process on the machine carries in its argv. */
export function newMark(label: string): string {
  return `TENONMARK${randomBytes(5).toString('hex')}_${label}`
}

/** The living processes whose argv holds `mark` (zombies excluded; `ps` itself excluded). */
export async function markedProcesses(mark: string): Promise<{ pid: number; args: string }[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-A', '-ww', '-o', 'pid=,stat=,args='], {
    maxBuffer: 64 * 1024 * 1024,
  })
  const found: { pid: number; args: string }[] = []
  for (const row of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(row)
    if (match === null) continue
    const [, pid, stat, args] = match
    if (stat?.startsWith('Z') === true || args === undefined || !args.includes(mark)) continue
    if (/^\S*\bps\b/.test(args)) continue
    found.push({ pid: Number(pid), args })
  }
  return found
}

/** How long `holdTmpClaudeLock` waits for the other file's turn. */
const TMP_CLAUDE_LOCK_WAIT_MS = 120_000

/**
 * A turn at srt's shared `/tmp/claude`, between the black box's two files on this machine: 验收 10's
 * `mktemp` case sets that directory aside for one call, and any wrap makes it again, so under S
 * (escape.test.ts and stop-tree.test.ts in parallel) that case and stop-tree.test.ts's sandboxed
 * group take turns. The lock is a directory under the OS temp dir naming its holder's pid; one whose
 * holder is gone is taken over. Resolves to its release.
 */
export async function holdTmpClaudeLock(): Promise<() => void> {
  const lock = join(tmpdir(), 'tenon-sandbox-tmp-claude.lock')
  const owner = join(lock, 'pid')
  const deadline = performance.now() + TMP_CLAUDE_LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 })
      writeFileSync(owner, String(process.pid))
      return () => rmSync(lock, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let holder: number | undefined
    try {
      const text = readFileSync(owner, 'utf8').trim()
      if (text !== '') holder = Number(text)
    } catch {
      // Made but not yet named: its holder is still writing the pid.
    }
    if (holder !== undefined && !isRunning(holder)) {
      rmSync(lock, { recursive: true, force: true })
      continue
    }
    if (performance.now() > deadline) {
      throw new Error(
        `${lock} is still held by pid ${String(holder)}: the other file's turn ran long`,
      )
    }
    // oxlint-disable-next-line no-await-in-loop -- the wait's pace
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** SIGKILL every process carrying `mark`: a failed case's leftovers. */
export async function killMarked(mark: string): Promise<void> {
  for (const { pid } of await markedProcesses(mark)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone already.
    }
  }
}

/** An HTTP server on 127.0.0.1 answering `tenon-escape-ok <port>`; counts what reached it. */
export interface HttpFixture {
  readonly port: number
  readonly hits: { readonly url: string; readonly host: string }[]
  close(): Promise<void>
}

export async function startHttpFixture(): Promise<HttpFixture> {
  const hits: { url: string; host: string }[] = []
  const server: Server = createServer((request, response) => {
    hits.push({ url: request.url ?? '', host: request.headers.host ?? '' })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(`tenon-escape-ok ${String(port)}\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** A Unix-socket server; counts connections. */
export async function startUnixFixture(
  path: string,
): Promise<{ readonly connections: () => number; close(): Promise<void> }> {
  rmSync(path, { force: true })
  let connections = 0
  const server = createNetServer((socket) => {
    connections += 1
    socket.end('tenon-escape-unix-ok\n')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  return {
    connections: () => connections,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** A violation cut to what the receipt reads (§afterExit 的表), absent members spelled out. */
export function shapeOf(violation: SandboxViolation): {
  kind: string
  target: string | null
  release: string | null
  protected: boolean
  observed: boolean
} {
  return {
    kind: violation.kind,
    target: violation.target ?? null,
    release: violation.release ?? null,
    protected: violation.protected === true,
    observed: violation.observed === true,
  }
}
