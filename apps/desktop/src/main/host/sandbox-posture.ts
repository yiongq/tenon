/**
 * The desktop sandbox's startup (spec 04 §启动、自检与姿态; T4, T12, T32, Q4, Q6; 读法 4, 50; P1, P5,
 * P7). It runs once, in the background once main has its windows, and settles the posture
 * `DesktopSandbox` starts from (`DesktopSandbox.start`):
 *
 *  1. win32, any platform but darwin and linux, and WSL1 never initialize.
 *  2. Preparing: srt's two helper files are there (§依赖); Linux finds bwrap, socat and rg on main's
 *     PATH and hands srt the absolute paths it found (one it did not find srt looks up itself, and
 *     names in its own words at step 3); `CLAUDE_CODE_TMPDIR` and `CLAUDE_TMPDIR` leave main's
 *     environment; what `stubs.json` recorded last time is cleaned up; main chdirs to
 *     `<userData>/sandbox-cwd` (读法 50), checked like `/tmp/claude` — only when given one, which the
 *     eval host never is (读法 45).
 *  3. `initialize(config, undefined, true)` on both platforms. A dependency error maps to its reason
 *     code by srt's own wording; any other throw is `init-failed`, or on darwin `nested-sandbox` when
 *     a fixed sandbox-exec run exits 71 or says `sandbox_apply` (P1). Once it returned, srt's socat
 *     bridges and the tmpdir entries it made are recorded for the next startup (P7).
 *  4. `checkDependenciesAsync()` afterwards, for its warnings only: `degraded`.
 *  5. The self-test (读法 4): one read-only command wrapped by srt itself, not `HostSandbox.wrap`,
 *     that writes outside; it passes only when it exits 0 within 10 s and the host has no such file.
 *  6. On Linux a failed self-test reads three sysctls: a restricting reading, or apply-seccomp's
 *     `nested userns is capability-restricted`, makes it `userns-restricted`; the readings go to the
 *     detail either way.
 *
 * `/proc`, the tmpdir, the process table, every spawn and the chdir go through the injected ports.
 * Nothing here runs sudo or changes the system's settings (Q6 A): the fix for `userns-restricted` is
 * shown, never run.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  constants,
  lstatSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { posix } from 'node:path'
import { SandboxManager, getWslVersion } from '@anthropic-ai/sandbox-runtime'
import type { SandboxReasonCode } from '@tenon-app/contracts'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { AbsolutePath, HostProcess } from '@tenon-app/kernel'
import { desktopSandboxFs, privateDirProblem, stubsFile } from './sandbox.js'
import type {
  SandboxFileStat,
  SandboxFs,
  SandboxLogger,
  SandboxStartup,
  SandboxStartupRun,
  SrtSandbox,
} from './sandbox.js'
import type { HelperPaths, LinuxBinaries } from './sandbox-config.js'
import type { StartupEnv } from './shell-env.js'

/**
 * Why the posture is not plain `active` (spec §启动、自检与姿态). The shared contracts also
 * reserve `test-seam`, which only the e2e seam gives. `no-seccomp` and `old-bwrap`
 * come with `degraded`; the rest with `unavailable`, except `other`, which also comes with
 * `degraded` for a warning of srt's it does not know (its detail srt's own words): the sandbox is up
 * then, one layer perhaps weaker, and `unavailable` would send every command, once you allow it, to
 * run outside the sandbox (2026-10-16).
 */
export type { SandboxReasonCode } from '@tenon-app/contracts'

export interface SandboxReason {
  readonly code: SandboxReasonCode
  /** srt's own words, the sysctl readings or what failed; never translated (§IPC). */
  readonly detail: string | null
}

/** One reason; `detail` is diagnostic text shown as it is, never copy (§IPC: 「不翻译」). */
export function reason(code: SandboxReasonCode, detail: string | null): SandboxReason {
  return { code, detail }
}

/**
 * How `initialize` went: whoever registers `app.quit` for SIGTERM / SIGINT reads it (§退出). Only
 * `dependency-error` says srt's signal listeners are surely not there; `threw` may have come
 * before or after them and counts as after (`SandboxStartupRun`).
 */
export type InitializeResult = 'not-called' | 'dependency-error' | 'threw' | 'returned'

export interface SandboxPostureOutcome extends SandboxStartup {
  /** Empty for real `active`; the test seam's `active` carries `test-seam` (04 §IPC). */
  readonly reasons: readonly SandboxReason[]
  readonly initialize: InitializeResult
}

export interface SandboxPostureRun extends SandboxStartupRun {
  readonly outcome: Promise<SandboxPostureOutcome>
}

/** The part of sandbox-runtime startup uses; injected so tests can fake it. */
export interface SrtStartup {
  initialize(
    config: SandboxRuntimeConfig,
    askCallback: undefined,
    enableLogMonitor: boolean,
  ): Promise<void>
  checkDependenciesAsync(): Promise<{ errors: string[]; warnings: string[] }>
  wrapWithSandboxArgv: SrtSandbox['wrapWithSandboxArgv']
  cleanupAfterCommand(): void
  getWslVersion(): string | undefined
}

/** `lstat` with what srt's stale mount point test reads (linux-sandbox-utils.js:418-428). */
export interface PostureFileStat extends SandboxFileStat {
  isFile(): boolean
  readonly size: number
  readonly nlink: number
}

/** What startup asks of the disk on top of `DesktopSandbox`'s; every path is absolute. */
export interface PostureFs extends Pick<
  SandboxFs,
  'stat' | 'realpath' | 'readlink' | 'mkdirPrivate' | 'readFile' | 'writeFile'
> {
  /** The entry itself, links not followed; undefined when nothing is there. May throw. */
  lstat(path: string): PostureFileStat | undefined
  /** The names in a directory; throws when it cannot be listed. */
  readdir(path: string): string[]
  /** A regular file this process may execute. Never throws. */
  isExecutable(path: string): boolean
  /** `rmdir`: an empty directory only; throws otherwise. */
  removeEmptyDir(path: string): void
  /** `unlink`: never a directory; throws otherwise. */
  removeFile(path: string): void
  /** `rm -rf` on the entry itself, a link not followed. */
  removeTree(path: string): void
}

export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  /** The whole command line, as `ps -o args=` prints it. */
  readonly command: string
}

/** The host's process table (P7). */
export interface PostureProcesses {
  list(): Promise<ProcessRow[]>
  /** SIGKILL one process; a process already gone is no error. */
  kill(pid: number): void
}

export interface RunResult {
  readonly code: number | null
  readonly signal: string | null
  readonly stderr: string
  /** Killed at `timeoutMs`. */
  readonly timedOut: boolean
}

/** One process run to its end, killed at `timeoutMs`; rejects when it cannot be started. */
export type PostureRunner = (
  argv: readonly string[],
  options: {
    readonly cwd: string
    readonly env: Record<string, string>
    readonly timeoutMs: number
  },
) => Promise<RunResult>

/** The parts of the session config only startup knows (spec §依赖, §启动 step 2). */
export interface SessionParts {
  readonly applySeccompPath: AbsolutePath
  readonly javaAgentJarPath: AbsolutePath
  /** Linux only. */
  readonly linuxBinaries: LinuxBinaries | null
}

export interface SandboxPostureDeps {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly srt: SrtStartup
  readonly helpers: HelperPaths
  /** `sessionConfig(...)` with the rest of the host's input (the allowlist, the host paths). */
  readonly sessionConfig: (parts: SessionParts) => SandboxRuntimeConfig
  /** Main's `process.env`: PATH is read from it and srt's two tmpdir variables leave it. */
  readonly env: Record<string, string | undefined>
  /** `<userData>/sandbox-cwd`; null on the eval host, which never chdirs (读法 45, 50). */
  readonly chdirDir: AbsolutePath | null
  readonly chdir: (dir: string) => void
  readonly fs: PostureFs
  /** Main's `os.tmpdir()`, where srt puts its sockets. */
  readonly tmpdir: AbsolutePath
  readonly processes: PostureProcesses
  readonly run: PostureRunner
  readonly uid: number
  /** Main's own pid. */
  readonly pid: number
  readonly home: AbsolutePath
  readonly profileDir: AbsolutePath
  readonly log: SandboxLogger
}

/** How long the self-test and the sandbox-exec check may run (spec §启动 step 5). */
export const SELF_TEST_TIMEOUT_MS = 10_000
/** How much of a failed self-test's stderr goes to the detail. */
export const SELF_TEST_STDERR_BYTES = 2048

/** The fixed nested-sandbox check on darwin (spec §启动 step 3; P1). */
export const SANDBOX_EXEC_CHECK: readonly string[] = [
  '/usr/bin/sandbox-exec',
  '-p',
  '(version 1)(allow default)',
  '/usr/bin/true',
]

/** The three Linux readings (spec §启动 step 6), as `sysctl` names them. */
export const USERNS_READINGS: readonly { readonly name: string; readonly path: string }[] = [
  {
    name: 'kernel.apparmor_restrict_unprivileged_userns',
    path: '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
  },
  {
    name: 'kernel.unprivileged_userns_clone',
    path: '/proc/sys/kernel/unprivileged_userns_clone',
  },
  { name: 'user.max_user_namespaces', path: '/proc/sys/user/max_user_namespaces' },
]

/** The architectures srt79 ships apply-seccomp for (vendor/seccomp/{x64,arm64}). */
const SECCOMP_ARCHES: ReadonlySet<string> = new Set(['x64', 'arm64'])

/** srt79 sandbox-manager.js:490. */
const DEPENDENCY_ERROR_PREFIX = 'Sandbox dependencies not available: '

/** srt79 linux-sandbox-utils.js:521-524. */
const CAP_SETFCAP_MISSING =
  "running as uid 0 without CAP_SETFCAP in this process's capability bounding set - on " +
  'kernels that enforce the CAP_SETFCAP requirement for mapping uid 0 into a user namespace ' +
  '(Linux 5.12 and distribution backports) every sandboxed command fails while writing a uid ' +
  'map ("Operation not permitted"). Grant CAP_SETFCAP to this process, or run as a non-root user'

/** srt79's dependency errors, each up to the `, ` that joins them (sandbox-manager.js:490). */
const DEPENDENCY_ERRORS: readonly { readonly code: SandboxReasonCode; readonly at: RegExp }[] = [
  // linux-sandbox-utils.js:899, :904
  { code: 'missing-bwrap', at: /bubblewrap \(bwrap\) not executable at [\s\S]+?(?=, |$)/y },
  { code: 'missing-bwrap', at: /bubblewrap \(bwrap\) not installed(?=, |$)/y },
  // linux-sandbox-utils.js:908, :911
  { code: 'missing-socat', at: /socat not executable at [\s\S]+?(?=, |$)/y },
  { code: 'missing-socat', at: /socat not installed(?=, |$)/y },
  // sandbox-manager.js:816
  { code: 'missing-rg', at: /ripgrep \([\s\S]+?\) not found(?=, |$)/y },
  // linux-sandbox-utils.js:1012-1014
  {
    code: 'root-without-setfcap',
    at: new RegExp(
      `${escapeRegExp(CAP_SETFCAP_MISSING)}(?: \\(bubblewrap: [\\s\\S]*?\\))?(?=, |$)`,
      'y',
    ),
  },
]

/** linux-sandbox-utils.js:915. */
const NO_SECCOMP_WARNING = 'seccomp not available - unix socket access not restricted'
/** linux-sandbox-utils.js:989-993. */
const OLD_BWRAP_WARNING = /^bubblewrap \S+ at [\s\S]+ is older than 0\.5\.0: /

/** apply-seccomp's own words when a userns profile refuses it (srt79 vendor/seccomp/<arch>/apply-seccomp; P5). */
const NESTED_USERNS = 'nested userns is capability-restricted'

/** Only an unpackaged app explicitly launched for tests may bypass real startup (04 §IPC). */
export function sandboxTestMode(
  isPackaged: boolean,
  startupEnv: StartupEnv,
): 'off' | 'fake' | null {
  if (isPackaged || startupEnv['TENON_DEV_ENV'] !== 'off') return null
  const mode = startupEnv['TENON_TEST_SANDBOX']
  return mode === 'off' || mode === 'fake' ? mode : null
}

/**
 * Desktop's startup selector (step 13c calls this after creating the window). The seam returns
 * before real startup touches the disk, chdirs or initializes srt. `initialized` stays pending,
 * as for any startup that never called initialize; fake commands use a separate test wrapper.
 */
export function startDesktopSandboxPosture(
  deps: SandboxPostureDeps,
  isPackaged: boolean,
  startupEnv: StartupEnv,
): SandboxPostureRun {
  const mode = sandboxTestMode(isPackaged, startupEnv)
  if (mode === null) return startSandboxPosture(deps)
  const state = mode === 'fake' ? 'active' : 'unavailable'
  deps.log(`sandbox: ${state} (test-seam: ${mode})`)
  return {
    initialized: new Promise<void>(() => {}),
    outcome: Promise.resolve({
      state,
      session: null,
      noSeccomp: false,
      reasons: [reason('test-seam', mode)],
      initialize: 'not-called',
    }),
  }
}

/**
 * Starts the sandbox (spec §启动、自检与姿态). `initialized` resolves the moment `initialize` returns
 * and stays pending when it was never called or threw; `outcome` settles once startup is done and
 * never rejects.
 */
export function startSandboxPosture(deps: SandboxPostureDeps): SandboxPostureRun {
  const initialized = Promise.withResolvers<void>()
  const progress = { initialize: 'not-called' as InitializeResult }
  const outcome = startup(deps, progress, () => initialized.resolve()).catch(
    (error: unknown): SandboxPostureOutcome => {
      deps.log(`sandbox: startup failed: ${messageOf(error)}`)
      return unavailable(progress.initialize, [reason('init-failed', messageOf(error))])
    },
  )
  void outcome.then((result) => {
    const reasons = result.reasons.map((one) => one.code).join(', ')
    deps.log(`sandbox: ${result.state}${reasons === '' ? '' : ` (${reasons})`}`)
  })
  return { initialized: initialized.promise, outcome }
}

async function startup(
  deps: SandboxPostureDeps,
  progress: { initialize: InitializeResult },
  markInitialized: () => void,
): Promise<SandboxPostureOutcome> {
  // 1. Platforms that never initialize (Q4 A, T32).
  const { platform } = deps
  if (platform === 'win32') return unavailable('not-called', [reason('windows', null)])
  if (platform !== 'darwin' && platform !== 'linux') {
    return unavailable('not-called', [reason('unsupported-platform', platform)])
  }
  if (platform === 'linux' && deps.srt.getWslVersion() === '1') {
    return unavailable('not-called', [reason('wsl1', null)])
  }

  // 2. Preparing. The helper files: on a supported architecture a missing one is not left to srt,
  // which would fall back to another copy (§依赖); elsewhere srt's own warning says `no-seccomp`.
  const helpers: string[] = [deps.helpers.javaAgentJar]
  if (SECCOMP_ARCHES.has(deps.arch)) helpers.unshift(deps.helpers.applySeccomp)
  const missing = helpers.filter((path) => !isFile(deps.fs, path))
  if (missing.length > 0) {
    return unavailable('not-called', [
      reason('other', `missing helper file: ${missing.join(', ')}`),
    ])
  }
  const binaries = platform === 'linux' ? findBinaries(deps) : null
  // srt sets the sandbox's TMPDIR from these (sandbox-utils.js:650-652): `/tmp/claude` it is.
  delete deps.env['CLAUDE_CODE_TMPDIR']
  delete deps.env['CLAUDE_TMPDIR']
  await cleanUpLastRun(deps)
  // 读法 50: srt's own mandatory write denies anchor at main's cwd.
  if (deps.chdirDir !== null) {
    const problem = privateDirProblem(deps.fs, deps.uid, deps.chdirDir, true)
    if (problem !== undefined) {
      return unavailable('not-called', [reason('init-failed', `${deps.chdirDir} ${problem}`)])
    }
    try {
      deps.chdir(deps.chdirDir)
    } catch (error) {
      return unavailable('not-called', [
        reason('init-failed', `chdir ${deps.chdirDir}: ${messageOf(error)}`),
      ])
    }
  }

  // 3. initialize, with true as its third argument on both platforms: it also starts the Linux
  // observer (sandbox-manager.js:493-536). It checks the dependencies itself, with the config.
  let session: SandboxRuntimeConfig
  try {
    session = deps.sessionConfig({
      applySeccompPath: deps.helpers.applySeccomp,
      javaAgentJarPath: deps.helpers.javaAgentJar,
      linuxBinaries: binaries,
    })
  } catch (error) {
    return unavailable('not-called', [reason('init-failed', messageOf(error))])
  }
  const tmpBefore = new Set(leftoverEntries(deps))
  try {
    await deps.srt.initialize(session, undefined, true)
  } catch (error) {
    const message = messageOf(error)
    if (message.startsWith(DEPENDENCY_ERROR_PREFIX)) {
      progress.initialize = 'dependency-error'
      const reasons = dependencyReasons(message.slice(DEPENDENCY_ERROR_PREFIX.length), binaries)
      return unavailable(
        progress.initialize,
        reasons.length > 0 ? reasons : [reason('other', message)],
      )
    }
    progress.initialize = 'threw'
    // P1: inside another sandbox initialize itself throws (`listen EPERM` on its socket).
    if (platform === 'darwin' && (await insideAnotherSandbox(deps))) {
      return unavailable(progress.initialize, [reason('nested-sandbox', message)])
    }
    return unavailable(progress.initialize, [reason('init-failed', message)])
  }
  progress.initialize = 'returned'
  markInitialized()
  // srt made its sockets, bridges and observer dir in initialize; nothing after it is recorded.
  await recordLeftovers(deps, tmpBefore, binaries)

  // 4. The warnings only: errors were initialize's to throw.
  let warnings: readonly string[]
  try {
    warnings = (await deps.srt.checkDependenciesAsync()).warnings
  } catch (error) {
    return unavailable(progress.initialize, [reason('init-failed', messageOf(error))])
  }
  const degraded = warnings.map(warningReason)

  // 5, 6.
  const failure = await selfTest(deps, session, binaries)
  if (failure !== undefined) return unavailable(progress.initialize, [failure])
  if (degraded.length > 0) {
    return {
      state: 'degraded',
      session,
      noSeccomp: degraded.some((one) => one.code === 'no-seccomp'),
      reasons: degraded,
      initialize: progress.initialize,
    }
  }
  return {
    state: 'active',
    session,
    noSeccomp: false,
    reasons: [],
    initialize: progress.initialize,
  }
}

function unavailable(
  initialize: InitializeResult,
  reasons: readonly SandboxReason[],
): SandboxPostureOutcome {
  return { state: 'unavailable', session: null, noSeccomp: false, reasons, initialize }
}

/**
 * srt's dependency errors, joined by `, `, each mapped by its wording (spec §启动 step 3). A
 * wording it does not know is `other` with srt's text. So is srt's `ripgrep (<path>) not found`
 * for the very rg Tenon found and handed it: srt looks even an absolute path up with `which`
 * (dist/utils/which.js:15), so that is a distribution without `which`.
 */
function dependencyReasons(errors: string, binaries: LinuxBinaries | null): SandboxReason[] {
  const reasons: SandboxReason[] = []
  let at = 0
  let unknownFrom: number | undefined
  const flushUnknown = (end: number): void => {
    if (unknownFrom === undefined) return
    const text = errors.slice(unknownFrom, end)
    if (text.length > 0) reasons.push(reason('other', text))
    unknownFrom = undefined
  }
  while (at < errors.length) {
    const known = knownErrorAt(errors, at)
    if (known === undefined) {
      unknownFrom ??= at
      const next = errors.indexOf(', ', at)
      at = next === -1 ? errors.length : next + 2
      continue
    }
    // `, ` before a known one closes the unknown text before it.
    flushUnknown(at - 2)
    const ours = binaries?.rg ?? null
    const rgFound = ours !== null && known.text === `ripgrep (${ours}) not found`
    reasons.push(reason(rgFound ? 'other' : known.code, known.text))
    at += known.text.length
    if (errors.startsWith(', ', at)) at += 2
  }
  flushUnknown(errors.length)
  return reasons
}

function knownErrorAt(
  errors: string,
  at: number,
): { readonly code: SandboxReasonCode; readonly text: string } | undefined {
  for (const { code, at: pattern } of DEPENDENCY_ERRORS) {
    pattern.lastIndex = at
    const match = pattern.exec(errors)
    if (match !== null) return { code, text: match[0] }
  }
  return undefined
}

/**
 * A warning from `checkDependenciesAsync()` (spec §启动 step 4): `degraded`, whichever it is — one
 * not known by its wording is `other` with srt's text (`SandboxReasonCode`).
 */
function warningReason(warning: string): SandboxReason {
  if (warning === NO_SECCOMP_WARNING) return reason('no-seccomp', warning)
  if (OLD_BWRAP_WARNING.test(warning)) return reason('old-bwrap', warning)
  return reason('other', warning)
}

/**
 * spec §启动 step 2: bwrap, socat and rg on main's PATH. One not there is null: srt looks it up
 * itself and, not finding it either, initialize throws its own words (`bubblewrap (bwrap) not
 * installed`, linux-sandbox-utils.js:904), which step 3 maps.
 */
function findBinaries(deps: SandboxPostureDeps): LinuxBinaries {
  const dirs = (deps.env['PATH'] ?? '').split(':').filter((dir) => posix.isAbsolute(dir))
  const find = (name: string): AbsolutePath | null =>
    dirs
      .map((dir) => posix.join(dir, name) as AbsolutePath)
      .find((path) => deps.fs.isExecutable(path)) ?? null
  return { bwrap: find('bwrap'), socat: find('socat'), rg: find('rg') }
}

/** darwin, after initialize threw: does sandbox-exec itself refuse to apply here (P1)? */
async function insideAnotherSandbox(deps: SandboxPostureDeps): Promise<boolean> {
  try {
    const result = await deps.run(SANDBOX_EXEC_CHECK, {
      cwd: deps.home,
      env: {},
      timeoutMs: SELF_TEST_TIMEOUT_MS,
    })
    return result.code === 71 || result.stderr.includes('sandbox_apply')
  } catch (error) {
    deps.log(`sandbox: the sandbox-exec check did not run: ${messageOf(error)}`)
    return false
  }
}

/**
 * The self-test's script (spec §启动 step 5): the write sits in a subshell, never `: >` — a special
 * built-in's failed redirection makes a non-interactive POSIX sh (dash, `bash --posix`) exit on the
 * spot, and the refused write would then never reach `exit 0` (P1).
 */
export function selfTestScript(target: string): string {
  const path = quote(target)
  return `( echo x > ${path} ) 2>/dev/null; if [ -e ${path} ]; then exit 3; fi; exit 0`
}

/** The self-test: undefined when it passed, else why not (spec §启动 steps 5 and 6). */
async function selfTest(
  deps: SandboxPostureDeps,
  session: SandboxRuntimeConfig,
  binaries: LinuxBinaries | null,
): Promise<SandboxReason | undefined> {
  const base = selfTestBase(deps)
  if (base === undefined) {
    return reason(
      'self-test-failed',
      `no place for the self-test outside srt's writable places: ${deps.tmpdir}, ${deps.home}`,
    )
  }
  const target = posix.join(base, `tenon-sandbox-self-test-${randomBytes(8).toString('hex')}`)
  let argv: string[]
  try {
    const wrapped = await deps.srt.wrapWithSandboxArgv(
      selfTestScript(target),
      '/bin/sh',
      { filesystem: session.filesystem },
      undefined,
      deps.home,
      { commandId: `tenon-sandbox-self-test.${randomBytes(16).toString('hex')}` },
    )
    argv = wrapped.argv
  } catch (error) {
    // srt never wrapped: nothing to clean up after.
    return reason('self-test-failed', `wrap: ${messageOf(error)}`)
  }
  let result: RunResult | undefined
  let spawnError: unknown
  try {
    result = await deps.run(argv, {
      cwd: deps.home,
      env: { PATH: deps.env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin', HOME: deps.home },
      timeoutMs: SELF_TEST_TIMEOUT_MS,
    })
  } catch (error) {
    spawnError = error
  } finally {
    // Exactly once for this wrap (T9).
    try {
      deps.srt.cleanupAfterCommand()
    } catch (error) {
      deps.log(`sandbox: cleanupAfterCommand failed: ${messageOf(error)}`)
    }
  }

  const written = hostHas(deps.fs, target)
  if (written) {
    try {
      deps.fs.removeTree(target)
    } catch (error) {
      deps.log(`sandbox: ${target} could not be removed: ${messageOf(error)}`)
    }
  }
  if (result === undefined) {
    return reason('self-test-failed', `did not start: ${messageOf(spawnError)}`)
  }
  const stderr = firstBytes(result.stderr, SELF_TEST_STDERR_BYTES)
  if (written) {
    return reason('self-test-failed', join(`wrote ${target} outside the sandbox`, stderr))
  }
  if (result.code === 0 && !result.timedOut) return undefined

  const how = result.timedOut
    ? `did not finish within ${SELF_TEST_TIMEOUT_MS} ms`
    : `exited ${result.signal ?? String(result.code)}`
  if (deps.platform === 'darwin') {
    if (result.code === 71 || result.stderr.includes('sandbox_apply')) {
      return reason('nested-sandbox', join(how, stderr))
    }
    return reason('self-test-failed', join(how, stderr))
  }
  const readings = USERNS_READINGS.map(({ name, path }) => ({ name, value: reading(deps, path) }))
  const restricting = readings.some(
    ({ name, value }) =>
      (name === 'kernel.apparmor_restrict_unprivileged_userns' && value === '1') ||
      (name === 'kernel.unprivileged_userns_clone' && value === '0') ||
      (name === 'user.max_user_namespaces' && value === '0'),
  )
  const detail = join(
    readings.map(({ name, value }) => `${name}=${value ?? '(none)'}`).join('\n'),
    how,
    stderr,
  )
  if (restricting || result.stderr.includes(NESTED_USERNS)) {
    // The fix names the bwrap step 2 found (spec §启动 step 6): the detail's last line says which.
    const bwrap = `bwrap=${binaries?.bwrap ?? '(none)'}`
    return reason('userns-restricted', detail.endsWith('\n') ? detail + bwrap : join(detail, bwrap))
  }
  return reason('self-test-failed', detail)
}

/**
 * Where the self-test writes (spec §启动 step 5): a new path under none of srt's default writable
 * places (srt79 sandbox-utils.js:486-504), checked as written and as its real path. Main's tmpdir
 * first; when that is one of them (main started with `TMPDIR=/tmp/claude`), home, which read-only
 * keeps unwritable too.
 */
function selfTestBase(deps: SandboxPostureDeps): string | undefined {
  const places = [
    '/tmp/claude',
    '/private/tmp/claude',
    posix.join(deps.home, '.npm/_logs'),
    posix.join(deps.home, '.claude/debug'),
  ]
  const spellings = (path: string): string[] => {
    try {
      return [path, deps.fs.realpath(path)]
    } catch {
      return [path]
    }
  }
  const writable = places.flatMap(spellings)
  const under = (path: string): boolean =>
    writable.some((place) => path === place || path.startsWith(`${place}/`))
  return [deps.tmpdir, deps.home].find((dir) => !spellings(dir).some(under))
}

/** One sysctl's value, trimmed; null when the file is not there or cannot be read. */
function reading(deps: SandboxPostureDeps, path: string): string | null {
  try {
    return deps.fs.readFile(path)?.trim() ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// The record of mount points and leftovers (§afterExit「挂载点与残留的记录」; P7)

/**
 * The leftovers initialize makes in main's tmpdir (linux-sandbox-utils.js:1075; mux-proxy.js:22;
 * linux-violation-monitor.js:34). Not `claude-empty-*` (linux-sandbox-utils.js:400): srt makes that
 * at a wrap, never in initialize, so one that shows up meanwhile is another srt user's (已知限制).
 */
function leftoverKinds(pid: number | null): RegExp[] {
  return [
    /^claude-http-[0-9a-f]+\.sock$/,
    pid === null
      ? /^srt-mux-\d+-[0-9a-z]+\.sock$/
      : new RegExp(`^srt-mux-${pid}-[0-9a-z]+\\.sock$`),
    /^srt-obs-./,
  ]
}

/** The tmpdir entries of those three kinds there now. */
function leftoverEntries(deps: SandboxPostureDeps): string[] {
  let names: string[]
  try {
    names = deps.fs.readdir(deps.tmpdir)
  } catch (error) {
    deps.log(`sandbox: ${deps.tmpdir} could not be listed: ${messageOf(error)}`)
    return []
  }
  const kinds = leftoverKinds(deps.pid)
  return names
    .filter((name) => kinds.some((kind) => kind.test(name)))
    .map((name) => posix.join(deps.tmpdir, name))
}

interface RecordedSocat {
  readonly pid: number
  readonly command: string
}

interface StubsRecord {
  readonly mountPoints: string[]
  readonly leafMountPoints: string[]
  readonly socat: RecordedSocat[]
  readonly tmpEntries: string[]
  readonly pid: number | null
}

/** What `stubs.json` holds, each item checked for its shape; anything else is dropped. */
function readStubs(deps: SandboxPostureDeps): StubsRecord | undefined {
  const file = stubsFile(deps.profileDir)
  let raw: unknown
  try {
    const text = deps.fs.readFile(file)
    if (text === undefined) return undefined
    raw = JSON.parse(text)
  } catch (error) {
    deps.log(`sandbox: ${file} could not be read: ${messageOf(error)}`)
    return { mountPoints: [], leafMountPoints: [], socat: [], tmpEntries: [], pid: null }
  }
  const record = isPlainObject(raw) ? raw : {}
  const paths = (key: string): string[] => {
    const map = isPlainObject(record[key]) ? record[key] : {}
    return Object.values(map)
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .filter(isAbsolutePathString)
  }
  const kinds = leftoverKinds(null)
  return {
    mountPoints: paths('mountPoints'),
    leafMountPoints: paths('leafMountPoints'),
    socat: socatList(record['socat']),
    // Only those three kinds right in main's tmpdir: the record is a file anyone running as you can
    // rewrite, and what it names is removed whole.
    tmpEntries: readList(record['tmpEntries'])
      .filter(isAbsolutePathString)
      .filter((path) => posix.dirname(path) === deps.tmpdir)
      .filter((path) => kinds.some((kind) => kind.test(posix.basename(path)))),
    pid: isPid(record['pid']) ? record['pid'] : null,
  }
}

/**
 * At startup, before initialize: what the last run recorded and left behind goes, and only that —
 * Linux's tmpdir is most likely the machine's shared `/tmp`, where another srt user's entries are
 * not ours. All of it only once the run that recorded it is gone: a socat while it runs with the
 * very command line recorded (its socket name holds 16 random hex digits) and a parent other than
 * that run — init, or the session's subreaper (`systemd --user`) that took the orphan in; the
 * tmpdir entries; a mount point dir while it is an empty directory, a leaf while it still is what
 * bwrap made (`isStaleMountFile`). A mount point also waits while any bwrap runs (`BWRAP`): taking
 * one away on the host detaches the bind of a sandbox still using it and its deny stops applying
 * there (srt79 linux-sandbox-utils.js:755-760) — a run of ours still alive, or another srt user's
 * (Claude Code re-covers an empty read-only file as its own mount point, :2087-2106). A mount point
 * that waits stays in the record for the next startup; the rest of the record is emptied.
 */
async function cleanUpLastRun(deps: SandboxPostureDeps): Promise<void> {
  const record = readStubs(deps)
  if (record === undefined) return
  const mounts = record.mountPoints.length > 0 || record.leafMountPoints.length > 0
  let table: ProcessRow[] | undefined
  if (mounts || record.socat.length > 0 || record.tmpEntries.length > 0) {
    try {
      table = await deps.processes.list()
    } catch (error) {
      deps.log(`sandbox: the process table could not be read: ${messageOf(error)}`)
    }
  }
  // The recorder's pid held by this process, or by none: that run is gone.
  const recorder = record.pid
  const gone =
    table !== undefined &&
    recorder !== null &&
    (recorder === deps.pid || !table.some((row) => row.pid === recorder))
  for (const socat of gone ? record.socat : []) {
    const row = table?.find((candidate) => candidate.pid === socat.pid)
    if (row === undefined || row.ppid === recorder || row.command !== socat.command) continue
    try {
      deps.processes.kill(socat.pid)
    } catch (error) {
      deps.log(`sandbox: socat ${socat.pid} not killed: ${messageOf(error)}`)
    }
  }
  for (const entry of gone ? record.tmpEntries : []) {
    try {
      deps.fs.removeTree(entry)
    } catch (error) {
      deps.log(`sandbox: ${entry} not removed: ${messageOf(error)}`)
    }
  }
  const mountsGo = gone && table !== undefined && !table.some((row) => BWRAP.test(row.command))
  if (mounts && !mountsGo) {
    deps.log('sandbox: mount points left for the next start: their run or a bwrap is still there')
  }
  for (const path of mountsGo ? record.mountPoints : []) {
    try {
      const own = deps.fs.lstat(path)
      if (own === undefined || own.isSymbolicLink() || !own.isDirectory()) continue
      if (deps.fs.readdir(path).length > 0) continue
      deps.fs.removeEmptyDir(path)
    } catch (error) {
      deps.log(`sandbox: mount point ${path} not removed: ${messageOf(error)}`)
    }
  }
  for (const path of mountsGo ? record.leafMountPoints : []) {
    try {
      if (isStaleMountFile(deps.fs.lstat(path))) deps.fs.removeFile(path)
    } catch (error) {
      deps.log(`sandbox: mount point ${path} not removed: ${messageOf(error)}`)
    }
  }
  writeStubs(
    deps,
    mounts && !mountsGo
      ? {
          mountPoints: listed(record.mountPoints),
          leafMountPoints: listed(record.leafMountPoints),
        }
      : {},
  )
}

/** A bwrap process, by the program its command line starts with or names (`/usr/bin/bwrap …`). */
const BWRAP = /(?:^|\/)bwrap(?:\s|$)/

/** Mount points kept for the next start, under a key no srt id takes (srt ids hold a dot). */
function listed(paths: readonly string[]): Record<string, string[]> {
  return paths.length > 0 ? { 'earlier-runs': [...paths] } : {}
}

/**
 * srt's own test for a mount point an earlier sandbox left behind (linux-sandbox-utils.js:418-428):
 * bwrap's `ensure_file(dest, 0444)` makes an empty regular file with no write bits and one link.
 * A file you made since has write bits, content or a second link, and is never touched.
 */
function isStaleMountFile(stat: PostureFileStat | undefined): boolean {
  return (
    stat !== undefined &&
    stat.isFile() &&
    stat.size === 0 &&
    (stat.mode & 0o222) === 0 &&
    stat.nlink === 1
  )
}

/**
 * Once initialize returned: srt's socat bridges (Linux; children of main running the socat Tenon
 * found) and the tmpdir entries of those three kinds that were not there before, with main's pid.
 * Only `srt-mux-` carries a pid in its name; a `claude-http-` socket counts only when one of those
 * bridges listens on it, and an `srt-obs-` dir only when main itself listens on its socket
 * (`ownObserverDirs`), so another srt user's made meanwhile is not taken for ours. The mount points
 * `DesktopSandbox` records per wrap stay as they are; socat and tmpdir entries another run recorded
 * (another pid) are not adopted.
 */
async function recordLeftovers(
  deps: SandboxPostureDeps,
  before: ReadonlySet<string>,
  binaries: LinuxBinaries | null,
): Promise<void> {
  let socat: RecordedSocat[] = []
  const socatPath = binaries?.socat ?? null
  if (socatPath !== null) {
    const prefix = `${socatPath} UNIX-LISTEN:${posix.join(deps.tmpdir, 'claude-')}`
    try {
      socat = (await deps.processes.list())
        .filter((row) => row.ppid === deps.pid && row.command.startsWith(prefix))
        .map((row) => ({ pid: row.pid, command: row.command }))
    } catch (error) {
      deps.log(`sandbox: the process table could not be read: ${messageOf(error)}`)
    }
  }
  const made = leftoverEntries(deps).filter((path) => !before.has(path))
  const observers = made.some((path) => posix.basename(path).startsWith('srt-obs-'))
    ? ownObserverDirs(deps)
    : new Set<string>()
  const fresh = made.filter((path) => {
    const name = posix.basename(path)
    if (name.startsWith('claude-http-')) {
      return socat.some(({ command }) => command.includes(` UNIX-LISTEN:${path},`))
    }
    return !name.startsWith('srt-obs-') || observers.has(path)
  })
  const file = stubsFile(deps.profileDir)
  let record: Record<string, unknown> = {}
  try {
    const text = deps.fs.readFile(file)
    const parsed: unknown = text === undefined ? {} : JSON.parse(text)
    if (isPlainObject(parsed)) record = parsed
  } catch (error) {
    deps.log(`sandbox: ${file} could not be read: ${messageOf(error)}`)
  }
  // Startup emptied these; any here now another run wrote meanwhile (two Tenons on one profile).
  // Taken under this pid they would be judged by this run's end, and the next start would kill a
  // live socat of that run and remove its sockets: they are left out, not adopted.
  const ours = record['pid'] === deps.pid
  const hadSocat = ours ? socatList(record['socat']) : []
  const hadEntries = ours ? readList(record['tmpEntries']).filter(isAbsolutePathString) : []
  if (
    !ours &&
    (readList(record['socat']).length > 0 || readList(record['tmpEntries']).length > 0)
  ) {
    deps.log(
      `sandbox: ${file} held socat or tmpdir entries of another run (pid ${isPid(record['pid']) ? record['pid'] : 'none'}); not taken as this run's`,
    )
  }
  const known = new Set(hadSocat.map((item) => `${item.pid} ${item.command}`))
  writeStubs(deps, {
    ...record,
    pid: deps.pid,
    socat: [...hadSocat, ...socat.filter((item) => !known.has(`${item.pid} ${item.command}`))],
    tmpEntries: [...new Set([...hadEntries, ...fresh])],
  })
}

/**
 * Linux: the `srt-obs-*` dirs in main's tmpdir whose socket main itself holds — srt's observer
 * listens on `<dir>/s<hex>.sock` from main (linux-violation-monitor.js:34-35, :129). A path bound
 * there is listed in /proc/net/unix with its inode, and main holds that inode when one of its fds
 * (/proc/self/fd) reads `socket:[<inode>]`. Another srt user's dir has no inode of main's.
 */
function ownObserverDirs(deps: SandboxPostureDeps): Set<string> {
  const own = new Set<string>()
  const inodes = new Set<string>()
  let table: string | undefined
  try {
    table = deps.fs.readFile('/proc/net/unix')
    for (const fd of deps.fs.readdir('/proc/self/fd')) {
      try {
        const inode = /^socket:\[(\d+)\]$/.exec(deps.fs.readlink(`/proc/self/fd/${fd}`))?.[1]
        if (inode !== undefined) inodes.add(inode)
      } catch {
        // Closed meanwhile.
      }
    }
  } catch (error) {
    deps.log(`sandbox: main's sockets could not be read: ${messageOf(error)}`)
    return own
  }
  // `Num: RefCount Protocol Flags Type St Inode Path`, the path the rest of the line.
  for (const line of (table ?? '').split('\n')) {
    const row = /^\s*[0-9a-f]+:(?:\s+[0-9a-f]+){5}\s+(\d+) (.+)$/i.exec(line)
    if (row === null || !inodes.has(row[1] ?? '')) continue
    const socket = row[2] ?? ''
    const dir = posix.dirname(socket)
    if (
      posix.dirname(dir) === deps.tmpdir &&
      /^srt-obs-./.test(posix.basename(dir)) &&
      /^s[0-9a-f]+\.sock$/.test(posix.basename(socket))
    ) {
      own.add(dir)
    }
  }
  return own
}

/** The recorded socat bridges that have the shape of one. */
function socatList(value: unknown): RecordedSocat[] {
  return readList(value).flatMap((item: unknown) =>
    isPlainObject(item) &&
    isPid(item['pid']) &&
    typeof item['command'] === 'string' &&
    item['command'].length > 0
      ? [{ pid: item['pid'], command: item['command'] }]
      : [],
  )
}

function writeStubs(deps: SandboxPostureDeps, record: Record<string, unknown>): void {
  const file = stubsFile(deps.profileDir)
  try {
    deps.fs.mkdirPrivate(posix.dirname(file))
    deps.fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
  } catch (error) {
    deps.log(`sandbox: ${file} could not be written: ${messageOf(error)}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

function isFile(fs: PostureFs, path: string): boolean {
  try {
    const stat = fs.stat(path)
    return stat !== undefined && !stat.isDirectory()
  } catch {
    return false
  }
}

/** Anything at `path`, a link not followed; a path that cannot be looked at counts as there. */
function hostHas(fs: PostureFs, path: string): boolean {
  try {
    return fs.lstat(path) !== undefined
  } catch {
    return true
  }
}

/** One argument, single-quoted for a POSIX shell. */
function quote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`
}

/** At most `limit` UTF-8 bytes of `text`. */
function firstBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8')
  return bytes.length <= limit ? text : bytes.subarray(0, limit).toString('utf8')
}

function join(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join('\n')
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isAbsolutePathString(value: unknown): value is string {
  return typeof value === 'string' && posix.isAbsolute(value) && posix.normalize(value) === value
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 1
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------------------------
// The real ports

/** Shared by desktop and the eval host (04 step 13c/13f); never logs the wrapped argv. */
export function desktopSrtSandbox(): SrtSandbox & {
  updateConfig(config: SandboxRuntimeConfig): void
} {
  return {
    wrapWithSandboxArgv: (...args) => SandboxManager.wrapWithSandboxArgv(...args),
    cleanupAfterCommand: () => SandboxManager.cleanupAfterCommand(),
    getSandboxViolationStore: () => SandboxManager.getSandboxViolationStore(),
    reset: () => SandboxManager.reset(),
    updateConfig: (config) => SandboxManager.updateConfig(config),
  }
}

/** sandbox-runtime itself. */
export function desktopSrtStartup(): SrtStartup {
  return {
    initialize: (config, askCallback, enableLogMonitor) =>
      SandboxManager.initialize(config, askCallback, enableLogMonitor),
    checkDependenciesAsync: () => SandboxManager.checkDependenciesAsync(),
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
    getWslVersion: () => getWslVersion(),
  }
}

/** `PostureFs` on the real disk. */
export function desktopPostureFs(): PostureFs {
  return {
    ...desktopSandboxFs(),
    lstat: (path) => lstatSync(path, { throwIfNoEntry: false }),
    readdir: (path) => readdirSync(path),
    isExecutable: (path) => {
      try {
        if (!statSync(path).isFile()) return false
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    removeEmptyDir: (path) => rmdirSync(path),
    removeFile: (path) => unlinkSync(path),
    removeTree: (path) => rmSync(path, { recursive: true, force: true }),
  }
}

/** The process table through `/bin/ps` (P7), and SIGKILL: host-internal, like `ps` in `DesktopSandbox`. */
export function desktopPostureProcesses(): PostureProcesses {
  return {
    list: () =>
      new Promise((resolve, reject) => {
        const child = spawn('/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        const chunks: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
        child.on('error', reject)
        child.on('close', () => resolve(parseProcessTable(Buffer.concat(chunks).toString('utf8'))))
      }),
    kill: (pid) => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    },
  }
}

/** `ps -o pid=,ppid=,args=`'s rows. */
function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+) (.*)$/.exec(line)
    if (match === null) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: (match[3] ?? '').trim() })
  }
  return rows
}

/** How long a run's stderr may trail its exit: a descendant may hold the pipe open (process.ts). */
const STDERR_TRAIL_MS = 200
/** How much stderr a run keeps. */
const STDERR_KEEP_BYTES = 64 * 1024

/**
 * `PostureRunner` through `HostAdapter.process` (spec §启动 step 3): the argv is fixed or srt's, the
 * process group is killed at the timeout, and stderr is read up to its end or a moment past exit.
 */
export function desktopPostureRunner(host: HostProcess): PostureRunner {
  return async (argv, { cwd, env, timeoutMs }) => {
    const child = await host.spawn({
      argv: [...argv],
      cwd: cwd as AbsolutePath,
      env,
      stdio: 'pipe',
    })
    const stdin = child.stdin.getWriter()
    void stdin.closed.catch(() => {})
    void stdin.close().catch(() => {})
    void child.stdout.cancel().catch(() => {})
    const reader = child.stderr.getReader()
    const chunks: Uint8Array[] = []
    let kept = 0
    const read = (async (): Promise<void> => {
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- one chunk after another
          const { done, value } = await reader.read()
          if (done) return
          if (kept < STDERR_KEEP_BYTES) {
            chunks.push(value)
            kept += value.byteLength
          }
        }
      } catch {
        // A read error ends what there is to read.
      }
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      child.exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    if (timedOut) await child.kill('SIGKILL').catch(() => {})
    const exit = await child.exited
    let trail: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      read,
      new Promise<void>((resolve) => {
        trail = setTimeout(resolve, STDERR_TRAIL_MS)
      }),
    ])
    clearTimeout(trail)
    void reader.cancel().catch(() => {})
    return {
      code: exit.code,
      signal: exit.signal,
      stderr: Buffer.concat(chunks).toString('utf8'),
      timedOut,
    }
  }
}
