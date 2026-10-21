/** Desktop assembly for spec 04 step 13c. The wrapper owns srt's process-wide allowlist. */
import { homedir, tmpdir } from 'node:os'
import { posix } from 'node:path'
import type { SandboxSettings, SandboxView } from '@tenon-app/contracts'
import type {
  AbsolutePath,
  HostAdapter,
  HostSandbox,
  SandboxPorts,
  SandboxPosture,
  SandboxRequest,
  SandboxViolation,
} from '@tenon-app/kernel'
import {
  DesktopSandbox,
  SANDBOX_READY_WAIT_MS,
  SandboxUnavailableError,
  desktopProcessTable,
  desktopSandboxFs,
  type DesktopSandboxDeps,
} from './sandbox.js'
import { credentialPaths, helperPaths, sandboxPreset, sessionConfig } from './sandbox-config.js'
import {
  desktopPostureFs,
  desktopPostureProcesses,
  desktopPostureRunner,
  desktopSrtSandbox,
  desktopSrtStartup,
  reason,
  sandboxTestMode,
  startDesktopSandboxPosture,
  type SandboxPostureOutcome,
  type SandboxPostureRun,
} from './sandbox-posture.js'
import { readConfig, watchConfig } from './profile.js'
import type { StartupEnv } from './shell-env.js'

/** This seam is selected only by sandboxTestMode, never by model input. */
class FakeSandbox implements HostSandbox {
  private readonly reports = new Map<string, SandboxViolation[]>()

  async wrap(q: SandboxRequest): Promise<{ argv: string[]; env: Record<string, string> }> {
    const violations: SandboxViolation[] = []
    if (q.profile !== 'full-access') {
      // Bash carries the original command as one argv item; never scan env, cwd or tool output.
      const command = q.argv.at(-1) ?? ''
      for (const match of command.matchAll(/tenon-test-(blocked|write):([^\s'";]+)/g)) {
        const target = match[2]!
        if (match[1] === 'write' && !posix.isAbsolute(target)) continue
        violations.push({
          kind: match[1] === 'blocked' ? 'network' : 'fs',
          line: match[0],
          target,
          release: match[1] === 'blocked' ? 'domain' : 'path',
        })
      }
    }
    this.reports.set(q.commandId, violations)
    return { argv: [...q.argv], env: { ...q.env } }
  }

  async afterExit(_commandId: string): Promise<void> {}

  async violations(commandId: string): Promise<SandboxViolation[]> {
    const reports = this.reports.get(commandId) ?? []
    this.reports.delete(commandId)
    return reports
  }
}

export interface SandboxRuntimeOptions extends Omit<DesktopSandboxDeps, 'srt' | 'settings'> {
  readonly srt: ReturnType<typeof desktopSrtSandbox>
  readonly settings: () => SandboxSettings
  readonly platform: NodeJS.Platform
  readonly isPackaged: boolean
  readonly startupEnv: StartupEnv
  /** Called by start(), after main has created the window. */
  readonly startPosture: () => SandboxPostureRun
}

interface CommandSession {
  readonly sessionId: string
  hosts: readonly string[]
}

/** One host, one srt initialization; session grants are replaced before each command. */
export class DesktopSandboxRuntime implements HostSandbox, SandboxPorts {
  private readonly real: DesktopSandbox | null
  private readonly inner: HostSandbox
  private readonly mode: 'off' | 'fake' | null
  private run: SandboxPostureRun | undefined
  private outcome: SandboxPostureOutcome | undefined
  private session: SandboxPostureOutcome['session'] = null
  private readonly commands = new Map<string, CommandSession>()
  private readonly active = new Map<
    string,
    { sessionId: string | null; done: PromiseWithResolvers<void> }
  >()
  private latest: CommandSession | undefined
  private appliedSession: string | null | undefined
  private preparing: Promise<void> = Promise.resolve()

  private readonly options: SandboxRuntimeOptions

  constructor(options: SandboxRuntimeOptions) {
    this.options = options
    this.mode = sandboxTestMode(options.isPackaged, options.startupEnv)
    this.real = this.mode === 'fake' ? null : new DesktopSandbox(options)
    this.inner = this.real ?? new FakeSandbox()
  }

  /** Main calls this once after creating its first window; it never awaits startup. */
  start(): void {
    if (this.run !== undefined) return
    const run = this.options.startPosture()
    this.run = run
    this.real?.start(run)
    void run.outcome.then((outcome) => {
      this.outcome = outcome
      this.session = outcome.session
    })
  }

  posture(): SandboxPosture {
    return this.mode === 'fake'
      ? { state: 'active', profile: this.options.settings().profile }
      : this.real!.posture()
  }

  view(): SandboxView {
    const platform = this.options.platform
    return {
      posture: this.posture(),
      platform:
        platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : 'other',
      reasons: [
        ...(this.outcome?.reasons ?? []),
        ...(this.real?.reasons() ?? []).map((item) => reason(item.code, item.detail)),
      ],
      settings: this.options.settings(),
      preset: sandboxPreset(
        platform === 'darwin' || platform === 'linux' ? platform : 'other',
        this.options.paths.cacheDir,
      ),
    }
  }

  beforeWrap(q: { commandId: string; sessionId: string; hosts: readonly string[] }): void {
    const command = { sessionId: q.sessionId, hosts: [...q.hosts] }
    this.commands.set(q.commandId, command)
    this.latest = command
  }

  grantsChanged(q: { sessionId: string; hosts: readonly string[] }): void {
    if (this.latest?.sessionId !== q.sessionId) return
    this.latest.hosts = [...q.hosts]
    for (const command of this.commands.values()) {
      if (command.sessionId === q.sessionId) command.hosts = [...q.hosts]
    }
    if (this.appliedSession === q.sessionId || this.active.size === 0) {
      this.updateAllowlist(q.hosts)
    }
  }

  async wrap(q: SandboxRequest): Promise<{ argv: string[]; env: Record<string, string> }> {
    const previous = this.preparing
    const prepared = Promise.withResolvers<void>()
    this.preparing = prepared.promise
    try {
      await previous
      const command = this.commands.get(q.commandId)
      if (q.profile !== 'full-access') {
        if (this.run !== undefined && this.outcome === undefined) {
          if (!(await within(this.run.outcome, SANDBOX_READY_WAIT_MS))) {
            const message = `sandbox startup did not finish in ${SANDBOX_READY_WAIT_MS} ms`
            this.options.log(`sandbox: ${q.commandId}: ${message}`)
            throw new SandboxUnavailableError(message)
          }
        }
        const others = [...this.active.values()].filter(
          (call) => call.sessionId !== (command?.sessionId ?? null),
        )
        if (
          others.length > 0 &&
          !(await within(Promise.all(others.map((call) => call.done.promise)), 2_000))
        ) {
          this.options.log(
            'sandbox: other session commands did not settle within 2000 ms; switching allowlist',
          )
        }
        this.appliedSession = command?.sessionId ?? null
        this.updateAllowlist(command?.hosts ?? [])
      }
      // DesktopSandbox derives toolOutputDirFor(profileDir, sessionId) and reads sessionFolders.
      if (command !== undefined)
        this.real?.beforeWrap({ commandId: q.commandId, sessionId: command.sessionId })
      const wrapped = await this.inner.wrap(q)
      this.active.set(q.commandId, {
        sessionId: command?.sessionId ?? null,
        done: Promise.withResolvers<void>(),
      })
      return wrapped
    } catch (error) {
      this.commands.delete(q.commandId)
      throw error
    } finally {
      prepared.resolve()
    }
  }

  async afterExit(commandId: string): Promise<void> {
    try {
      await this.inner.afterExit(commandId)
    } finally {
      this.active.get(commandId)?.done.resolve()
      this.active.delete(commandId)
      this.commands.delete(commandId)
    }
  }

  violations(commandId: string): Promise<SandboxViolation[]> {
    return this.inner.violations(commandId)
  }

  dispose(): Promise<void> {
    return this.real?.dispose() ?? Promise.resolve()
  }

  private updateAllowlist(hosts: readonly string[]): void {
    const session = this.session
    if (session === null) return
    const settings = this.options.settings()
    const preset = settings.packageManagers
      ? sandboxPreset(this.options.paths.platform, this.options.paths.cacheDir).domains
      : []
    const domains = [...new Set([...settings.allowedDomains, ...preset, ...hosts])]
    const before = session.network.allowedDomains
    if (domains.length === before.length && domains.every((host) => before.includes(host))) return
    const next = { ...session, network: { ...session.network, allowedDomains: domains } }
    this.options.srt.updateConfig(next)
    this.session = next
  }
}

/** Resolves true on completion, false at the bound; clears its timer on either path. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Real desktop ports. The factory prepares objects only; start() performs initialize/chdir. */
export async function createDesktopSandboxRuntime(q: {
  readonly host: Pick<HostAdapter, 'identity' | 'fs' | 'process'>
  readonly userDataDir: AbsolutePath
  readonly isPackaged: boolean
  readonly startupEnv: StartupEnv
  readonly log: (line: string) => void
}): Promise<
  DesktopSandboxRuntime & {
    bindSessionFolders(read: (sessionId: string) => Promise<readonly AbsolutePath[]>): void
    signalReset(): void
  }
> {
  let settings = (await readConfig(q.host.fs, q.host.identity, q.log)).sandbox
  watchConfig(q.host.identity, (config) => {
    settings = config.sandbox
  })
  let folders: (sessionId: string) => Promise<readonly AbsolutePath[]> = noFolders
  const home = homedir() as AbsolutePath
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
  const helpers = helperPaths()
  const fs = desktopSandboxFs()
  const paths = {
    platform,
    home,
    zdotdir: q.startupEnv['ZDOTDIR']?.startsWith('/')
      ? (q.startupEnv['ZDOTDIR'] as AbsolutePath)
      : null,
    profileDir: q.host.identity.profileDir as AbsolutePath,
    cacheDir: posix.join(q.userDataDir, 'sandbox-cache') as AbsolutePath,
    chdirDir: posix.join(q.userDataDir, 'sandbox-cwd') as AbsolutePath,
    srtPackageDir: helpers.packageDir,
    credentials: credentialPaths(platform, home),
    uid: process.getuid?.() ?? 0,
    xdgRuntimeDir: q.startupEnv['XDG_RUNTIME_DIR'] ?? null,
    sshAuthSock: q.startupEnv['SSH_AUTH_SOCK'] ?? null,
  } as const
  const signalListeners: (() => void)[] = []
  const runtime = new DesktopSandboxRuntime({
    paths,
    fs,
    settings: () => settings,
    sessionFolders: (sessionId) => folders(sessionId),
    processes: desktopProcessTable(),
    // Register no process signal handlers here: step 13d supplies the main-process quit handling.
    onSignal: (listener) => {
      signalListeners.push(listener)
    },
    srt: desktopSrtSandbox(),
    platform: process.platform,
    isPackaged: q.isPackaged,
    startupEnv: q.startupEnv,
    log: q.log,
    startPosture: () =>
      startDesktopSandboxPosture(
        {
          platform: process.platform,
          arch: process.arch,
          srt: desktopSrtStartup(),
          helpers,
          sessionConfig: (parts) =>
            sessionConfig(
              {
                ...paths,
                noSeccomp: false,
                allowedDomains: [
                  ...new Set([
                    ...settings.allowedDomains,
                    ...(settings.packageManagers
                      ? sandboxPreset(platform, paths.cacheDir).domains
                      : []),
                  ]),
                ],
                ...parts,
              },
              fs,
            ),
          env: process.env,
          chdirDir: paths.chdirDir,
          chdir: (dir) => process.chdir(dir),
          fs: desktopPostureFs(),
          tmpdir: tmpdir() as AbsolutePath,
          processes: desktopPostureProcesses(),
          run: desktopPostureRunner(q.host.process),
          uid: paths.uid,
          pid: process.pid,
          home,
          profileDir: paths.profileDir,
          log: q.log,
        },
        q.isPackaged,
        q.startupEnv,
      ),
  })
  return Object.assign(runtime, {
    bindSessionFolders: (read: typeof folders) => {
      folders = read
    },
    signalReset: () => {
      for (const listener of signalListeners.splice(0)) listener()
    },
  })
}

/** Keep the startup ordering in one place: a pending posture must never delay the first window. */
export function startSandboxAfterWindow<T>(
  open: () => T,
  runtime: Pick<DesktopSandboxRuntime, 'start'>,
): T {
  const window = open()
  runtime.start()
  return window
}

async function noFolders(): Promise<readonly AbsolutePath[]> {
  return []
}
