import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { posix } from 'node:path'
import type { SandboxRuntimeConfig, SandboxViolationEvent } from '@anthropic-ai/sandbox-runtime'
import type {
  AbsolutePath,
  HostSandbox,
  SandboxPosture,
  SandboxRequest,
  SandboxViolation,
} from '@tenon-app/kernel'
import { toolOutputDirFor } from '@tenon-app/kernel'
import { presetRows, wrapConfig, wrapFilesystem } from './sandbox-config.js'
import type {
  FilesystemTables,
  RestrictedProfile,
  SandboxHostPaths,
  WorkspaceRoot,
} from './sandbox-config.js'
import { classify, offersPathRelease } from './sandbox-violations.js'
import type { SandboxPathEntry, ViolationContext } from './sandbox-violations.js'

export type SandboxLogger = (line: string) => void

/**
 * Phase 0: no sandbox yet. Commands pass through unchanged; anything that asked
 * for a restricted profile is logged as `sandbox: passthrough` so the gap is
 * visible. Phase 4 swaps this for sandbox-runtime behind the same interface.
 */
export class PassthroughSandbox implements HostSandbox {
  private readonly log: SandboxLogger

  constructor(log: SandboxLogger) {
    this.log = log
  }

  async wrap(request: SandboxRequest): Promise<{ argv: string[]; env: Record<string, string> }> {
    if (request.profile !== 'full-access') {
      this.log(`sandbox: passthrough ${request.commandId} ${request.profile}`)
    }
    return { argv: [...request.argv], env: { ...request.env } }
  }

  async afterExit(_commandId: string): Promise<void> {}

  async violations(_commandId: string): Promise<SandboxViolation[]> {
    return []
  }
}

// ---------------------------------------------------------------------------------------------
// DesktopSandbox (spec 04 §包装契约; T6, T7, T8, T9; open question 5 A; 读法 3, 5, 6, 9, 25, 35,
// 39, 41, 47, 48, 50)

/** How long `afterExit` waits before it settles a wrap's violations (§afterExit; P2). */
export const VIOLATION_SETTLE_MS = 50
/** How long a restricted wrap waits for startup (读法 3). */
export const SANDBOX_READY_WAIT_MS = 15_000
/** How long `dispose` waits for srt's `reset()` (读法 25). */
export const SANDBOX_RESET_WAIT_MS = 2_000
/** The violations one wrap keeps, the protected ones first (读法 39). */
export const MAX_WRAP_VIOLATIONS = 200

/** The variable that marks a wrap's processes on darwin (P6; 04 不变量 3). */
export const SANDBOX_MARK_VARIABLE = 'TENON_SANDBOX_MARK'

/** The `line` of the violation Linux adds when a link on a deny entry's way changed (spec「链接」). */
export function linkChangedLine(path: string): string {
  return `link changed during the command: ${path}`
}

/** A restricted wrap that is refused rather than run unsandboxed (读法 3, 5, 35, 41, 48, 50). */
export class SandboxUnavailableError extends Error {
  override name = 'SandboxUnavailableError'
}

/** The part of sandbox-runtime's `SandboxManager` this class uses; injected so tests can fake it. */
export interface SrtSandbox {
  wrapWithSandboxArgv(
    command: string,
    binShell: string,
    customConfig: Partial<SandboxRuntimeConfig>,
    abortSignal: AbortSignal | undefined,
    cwd: string,
    options: { commandId: string },
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
  cleanupAfterCommand(): void
  getSandboxViolationStore(): SrtViolationStore
  reset(): Promise<void>
}

/** srt's process-wide violation store: the last 100 events, and a count of all of them. */
export interface SrtViolationStore {
  getTotalCount(): number
  subscribe(listener: (violations: SandboxViolationEvent[]) => void): () => void
}

/**
 * What startup (`sandbox-posture.ts`, plan step 5) hands over once it has settled: the posture and
 * the session config `initialize` got — each wrap's config is it with the wrap's filesystem in place.
 */
export interface SandboxStartup {
  readonly state: 'active' | 'degraded' | 'unavailable'
  readonly session: SandboxRuntimeConfig | null
  /** The posture is `degraded`/`no-seccomp` (读法 42). */
  readonly noSeccomp: boolean
}

/**
 * Startup as it goes (plan step 5). `initialized` resolves the moment `initialize` returns, before
 * the dependency check and the self-test (up to 10 s), and stays pending when `initialize` was
 * never called or threw: from then on the store is watched, a signal marks the sandbox reset and
 * `dispose` resets (§退出). `outcome` settles once startup is done; an active or degraded outcome
 * implies `initialize` returned.
 */
export interface SandboxStartupRun {
  readonly initialized: Promise<void>
  readonly outcome: Promise<SandboxStartup>
}

/** Your choices under 「权限与网络」, read at every wrap. */
export interface SandboxSettings {
  readonly profile: RestrictedProfile
  readonly packageManagers: boolean
}

/** What the class asks of the disk; every path is absolute. */
export interface SandboxFs {
  /** The entry itself, links not followed; undefined when nothing is there. May throw. */
  lstat(path: string): SandboxFileStat | undefined
  /** Links followed; undefined when nothing is there. May throw. */
  stat(path: string): SandboxFileStat | undefined
  /** Throws when the path or a link on its way does not resolve. */
  realpath(path: string): string
  readlink(path: string): string
  /** `mkdir -p` with mode 0700 for what it makes. */
  mkdirPrivate(path: string): void
  /** undefined when the file is not there. */
  readFile(path: string): string | undefined
  /** Replaces the file whole (write and rename). */
  writeFile(path: string, text: string): void
}

export interface SandboxFileStat {
  isDirectory(): boolean
  isSymbolicLink(): boolean
  readonly uid: number
  readonly mode: number
}

/** The host's process table on darwin (§执行与收口; P6): host-internal helpers, like taskkill. */
export interface SandboxProcessTable {
  /** `/bin/ps -E -axww -o pid=,command=`'s output. */
  list(): Promise<string>
  /** SIGKILL one process; a process already gone is no error. */
  kill(pid: number): void
}

export interface DesktopSandboxDeps {
  readonly srt: SrtSandbox
  /** Everything but the `no-seccomp` posture, which startup decides. */
  readonly paths: Omit<SandboxHostPaths, 'noSeccomp'>
  readonly settings: () => SandboxSettings
  /** The session's folders (the workspace facts), for 读法 35's host check. */
  readonly sessionFolders: (sessionId: string) => Promise<readonly AbsolutePath[]>
  readonly fs: SandboxFs
  readonly processes: SandboxProcessTable
  /** Calls `listener` once on SIGTERM or SIGINT; registered once `initialize` returned (§退出). */
  readonly onSignal: (listener: () => void) => void
  readonly log: SandboxLogger
}

/** One restricted wrap, from `wrapWithSandboxArgv` until `violations` hands its results over. */
interface WrapRecord {
  readonly srtId: string
  readonly commandId: string
  readonly sessionId: string | null
  readonly context: ViolationContext
  /** Linux: the links on the deny entries' ways and what `lstat` said before the call. */
  readonly links: readonly { readonly path: string; readonly state: string }[]
  /** Linux: the mount points this wrap recorded in `stubs.json`. */
  readonly stubs: readonly string[]
  readonly kept: SandboxViolation[]
  protectedCount: number
  dropped: number
  exited: boolean
  settled: boolean
}

/**
 * The host's sandbox on macOS and Linux (spec 04 §包装契约). `full-access` passes through untouched;
 * any other profile goes through sandbox-runtime or is refused, never run unwrapped (04 不变量 2).
 * Startup is not done here: `start` takes it as it goes. The kernel's `beforeWrap` (through the host's
 * `LoopPorts.sandbox`) names each command's session; `wrap` reads the session's folders, the spill
 * folder and your settings at the time it runs.
 */
export class DesktopSandbox implements HostSandbox {
  private readonly deps: DesktopSandboxDeps
  private readonly platform: SandboxHostPaths['platform']
  private readonly ready: Promise<SandboxStartup>
  private resolveReady: (startup: SandboxStartup) => void = () => {}
  private startup: SandboxStartup | undefined
  private started = false
  /** `initialize` returned: the store is watched and `dispose` resets (§退出). */
  private initialized = false
  private signalled = false
  private disposing: Promise<void> | undefined
  /** commandId → the session `beforeWrap` named. */
  private readonly sessions = new Map<string, string>()
  /** commandId → its wraps, until `violations` takes their results. */
  private readonly wraps = new Map<string, WrapRecord[]>()
  /** The key srt's events carry → the wrap still collecting them. */
  private readonly open = new Map<string, WrapRecord>()
  private seenTotal = 0

  constructor(deps: DesktopSandboxDeps) {
    this.deps = deps
    this.platform = deps.paths.platform
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve
    })
  }

  /** Synchronous and never throws (04 §对 00 的修补 1). */
  posture(): SandboxPosture {
    const { profile } = this.deps.settings()
    if (this.signalled || this.disposing !== undefined) return { state: 'unavailable', profile }
    return { state: this.startup?.state ?? 'pending', profile }
  }

  /** Startup as it goes, once (spec §启动、自检与姿态). Until `outcome` settles the posture is `pending`. */
  start(run: SandboxStartupRun): void {
    if (this.started) return
    this.started = true
    void run.initialized.then(
      () => this.initializeReturned(),
      // It threw: nothing to watch or reset; `outcome` says why.
      () => {},
    )
    void run.outcome.then(
      (result) => this.settle(result),
      (error: unknown) => {
        this.deps.log(`sandbox: startup failed: ${messageOf(error)}`)
        this.settle({ state: 'unavailable', session: null, noSeccomp: false })
      },
    )
  }

  /** The kernel's `beforeWrap`: which session this command belongs to (读法 19). */
  beforeWrap(q: { readonly commandId: string; readonly sessionId: string }): void {
    this.sessions.set(q.commandId, q.sessionId)
  }

  async wrap(request: SandboxRequest): Promise<{ argv: string[]; env: Record<string, string> }> {
    // 1. full-access: a copy, no srt, no log (00:161).
    if (request.profile === 'full-access') {
      return { argv: [...request.argv], env: { ...request.env } }
    }
    try {
      return await this.wrapRestricted(request, request.profile)
    } catch (error) {
      // A wrap that throws is closed as not started: no afterExit follows (读法 7).
      this.sessions.delete(request.commandId)
      throw error
    }
  }

  private async wrapRestricted(
    request: SandboxRequest,
    profile: RestrictedProfile,
  ): Promise<{ argv: string[]; env: Record<string, string> }> {
    // 读法 5: srt looks the shell up again on main's PATH; only an absolute path is reliable.
    const shell = request.argv[0]
    if (shell === undefined || !posix.isAbsolute(shell) || !SHELLS.has(posix.basename(shell))) {
      throw this.refuse(request, `argv[0] ${JSON.stringify(shell)} is not zsh, bash or sh`)
    }

    // 2. Startup, then the directories srt counts on (读法 3, 41, 48, 50).
    const startup = await this.whenReady()
    if (startup === undefined) {
      throw this.refuse(request, `startup did not finish in ${SANDBOX_READY_WAIT_MS} ms`)
    }
    if (startup.state === 'unavailable' || startup.session === null) {
      throw this.refuse(request, 'the sandbox is unavailable')
    }
    if (this.signalled || this.disposing !== undefined) {
      throw this.refuse(request, 'the sandbox was reset')
    }
    const { paths } = this.deps
    const tmp = this.platform === 'darwin' ? '/private/tmp/claude' : '/tmp/claude'
    this.requirePrivateDir(request, tmp, true)
    if (paths.chdirDir !== null) this.requirePrivateDir(request, paths.chdirDir, false)

    // 3. The filesystem block, from the request, the session and your settings only (T5, T13).
    const sessionId = this.sessions.get(request.commandId) ?? null
    const folders = sessionId === null ? [] : await this.deps.sessionFolders(sessionId)
    const settings = this.deps.settings()
    const workspace: WorkspaceRoot[] = request.workspace.map((path) => {
      const directory = folders.includes(path)
      return { path, directory, gitDirectory: directory && this.isDirectory(`${path}/.git`) }
    })
    const plan = wrapFilesystem(
      {
        ...paths,
        noSeccomp: startup.noSeccomp,
        profile,
        chosen: settings.profile,
        workspace,
        toolOutputDir: sessionId === null ? null : toolOutputDirFor(paths.profileDir, sessionId),
        packageManagers: settings.packageManagers,
      },
      {
        realpath: (path) => this.deps.fs.realpath(path),
        lstat: (path) => this.deps.fs.lstat(path),
      },
    )
    const context = this.contextOf(plan.filesystem)
    // 读法 35, the host half: an item that is not one of the session's folders is a path release.
    for (const root of workspace) {
      if (!root.directory && !offersPathRelease(root.path, context)) {
        throw this.refuse(request, `${root.path} is no session folder and fails 读法 35`)
      }
    }
    if (plan.presetDirs.length > 0) {
      for (const row of presetRows(this.platform)) {
        this.requirePrivateDir(request, posix.join(paths.cacheDir, row.manager), true)
      }
    }
    wrapConfig(this.platform, startup.session, plan.filesystem)

    // 4. Linux: what the call may leave behind or change on the host (spec「链接」, P7).
    const linux = this.platform === 'linux'
    const srtId = srtIdFor(request.commandId)
    const stubs = linux ? this.mountPointsOf(plan.filesystem) : []
    const links = linux ? plan.links.map((path) => ({ path, state: this.linkState(path) })) : []
    if (stubs.length > 0) this.editStubs((mounts) => (mounts[srtId] = [...stubs]))

    const record: WrapRecord = {
      srtId,
      commandId: request.commandId,
      sessionId,
      context,
      links,
      stubs,
      kept: [],
      protectedCount: 0,
      dropped: 0,
      exited: false,
      settled: false,
    }
    this.open.set(keyOf(srtId), record)
    this.wraps.set(request.commandId, [...(this.wraps.get(request.commandId) ?? []), record])
    let wrapped: { argv: string[] }
    try {
      wrapped = await this.deps.srt.wrapWithSandboxArgv(
        request.argv.map(quote).join(' '),
        shell,
        { filesystem: plan.filesystem },
        undefined,
        request.cwd,
        { commandId: srtId },
      )
    } catch (error) {
      this.forget(record)
      throw error
    }

    // T6: request.env, never srt's; the preset's variables replace every case spelling (读法 47).
    const env: Record<string, string> = { ...request.env }
    for (const name of Object.keys(plan.env)) {
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === name.toLowerCase()) delete env[key]
      }
    }
    Object.assign(env, plan.env)
    if (this.platform === 'darwin') env[SANDBOX_MARK_VARIABLE] = srtId
    return { argv: [...wrapped.argv], env }
  }

  async afterExit(commandId: string): Promise<void> {
    const records = (this.wraps.get(commandId) ?? []).filter((record) => !record.exited)
    this.sessions.delete(commandId)
    if (records.length === 0) return
    // Exactly once per wrap (T9, 04 不变量 7): marked before anything awaits.
    for (const record of records) {
      record.exited = true
      try {
        this.deps.srt.cleanupAfterCommand()
      } catch (error) {
        this.deps.log(`sandbox: cleanupAfterCommand failed: ${messageOf(error)}`)
      }
    }
    if (this.platform === 'darwin') await this.killMarked(records)
    for (const record of records) {
      for (const link of record.links) {
        if (this.linkState(link.path) !== link.state) {
          keep(record, {
            kind: 'fs',
            line: linkChangedLine(link.path),
            target: link.path,
            protected: true,
          })
        }
      }
      if (record.stubs.length > 0) this.dropStubs(record.srtId)
    }
    await new Promise((resolve) => setTimeout(resolve, VIOLATION_SETTLE_MS))
    for (const record of records) {
      record.settled = true
      this.open.delete(keyOf(record.srtId))
      if (record.dropped > 0) {
        this.deps.log(`sandbox: ${record.dropped} violations over ${MAX_WRAP_VIOLATIONS} not kept`)
      }
    }
  }

  /** The settled results, the protected ones first, handed over once (§afterExit). */
  async violations(commandId: string): Promise<SandboxViolation[]> {
    const records = this.wraps.get(commandId) ?? []
    const settled = records.filter((record) => record.settled)
    const rest = records.filter((record) => !record.settled)
    if (rest.length > 0) this.wraps.set(commandId, rest)
    else this.wraps.delete(commandId)
    const all = settled.flatMap((record) => record.kept)
    return [...all.filter((v) => v.protected === true), ...all.filter((v) => v.protected !== true)]
  }

  /** srt's `reset()` once, at most 2 s; not after a signal reset it already (§退出, 读法 25). */
  dispose(): Promise<void> {
    this.disposing ??= this.resetOnce()
    return this.disposing
  }

  private async resetOnce(): Promise<void> {
    if (!this.initialized || this.signalled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SANDBOX_RESET_WAIT_MS)
    })
    const reset = Promise.resolve()
      .then(() => this.deps.srt.reset())
      .catch((error: unknown) => this.deps.log(`sandbox: reset failed: ${messageOf(error)}`))
    await Promise.race([reset, bound])
    clearTimeout(timer)
  }

  /** Once `initialize` has returned, whether or not startup has settled yet (§退出). */
  private initializeReturned(): void {
    if (this.initialized) return
    this.initialized = true
    this.watchStore()
    // srt's own once-listeners reset it on the first SIGTERM / SIGINT (§退出).
    this.deps.onSignal(() => {
      this.signalled = true
      this.deps.log('sandbox: reset by a signal; restricted commands are refused from now on')
    })
  }

  private settle(startup: SandboxStartup): void {
    if (startup.state !== 'unavailable') this.initializeReturned()
    this.startup = startup
    this.resolveReady(startup)
  }

  private async whenReady(): Promise<SandboxStartup | undefined> {
    if (this.startup !== undefined) return this.startup
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), SANDBOX_READY_WAIT_MS)
    })
    try {
      return await Promise.race([this.ready, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 读法 39: each new event goes to its wrap the moment srt stores it — srt keeps only the last 100
   * for the whole process — and is classified there and then.
   */
  private watchStore(): void {
    const store = this.deps.srt.getSandboxViolationStore()
    this.seenTotal = store.getTotalCount()
    store.subscribe((events) => {
      // srt calls its listeners without a try.
      try {
        const total = store.getTotalCount()
        const fresh = Math.min(total - this.seenTotal, events.length)
        this.seenTotal = total
        for (const event of fresh > 0 ? events.slice(events.length - fresh) : []) this.take(event)
      } catch (error) {
        this.deps.log(`sandbox: a violation could not be read: ${messageOf(error)}`)
      }
    })
  }

  private take(event: SandboxViolationEvent): void {
    const key =
      event.encodedCommand === undefined
        ? undefined
        : Buffer.from(event.encodedCommand, 'base64').toString('utf8')
    const record = key === undefined ? undefined : this.open.get(key)
    if (record === undefined) {
      // Unattributed, or it came after its wrap settled: the log only (读法 9). srt's store has
      // made the line one tag-free line; the key came over a carrier the sandbox can write, so it
      // is cut to an id's length and quoted.
      const which = key === undefined ? 'none' : JSON.stringify(key.slice(0, 100))
      this.deps.log(`sandbox: a violation for no open command (key ${which}): ${event.line}`)
      return
    }
    const violation = classify(event.line, record.context)
    if (violation !== undefined) keep(record, violation)
  }

  private contextOf(filesystem: FilesystemTables): ViolationContext {
    const { home, profileDir } = this.deps.paths
    let realProfile: string = profileDir
    try {
      realProfile = this.deps.fs.realpath(profileDir)
    } catch {
      // Not there yet: the written spelling is all there is.
    }
    return {
      allowWrite: entries(filesystem.allowWrite),
      denyWrite: entries(filesystem.denyWrite),
      denyRead: entries(filesystem.denyRead),
      profileDirs: [...new Set([profileDir, realProfile])],
      homeDir: home,
      lstat: (path) => this.deps.fs.lstat(path),
    }
  }

  /**
   * 读法 41, 48, 50: a directory of this user's, mode 0700, and not a link — checked on the path
   * itself; the rest on what it leads to, so the link test alone stops a link to a private dir.
   */
  private requirePrivateDir(request: SandboxRequest, path: string, create: boolean): void {
    const problem = this.privateDirProblem(path, create)
    if (problem !== undefined) throw this.refuse(request, `${path} ${problem}`)
  }

  private privateDirProblem(path: string, create: boolean): string | undefined {
    const { fs } = this.deps
    try {
      let own = fs.lstat(path)
      if (own === undefined) {
        if (!create) return 'is missing'
        fs.mkdirPrivate(path)
        own = fs.lstat(path)
        if (own === undefined) return 'could not be made'
      }
      if (own.isSymbolicLink()) return 'is a link'
      const target = fs.stat(path)
      if (target === undefined || !target.isDirectory()) return 'is not a directory'
      if (target.uid !== this.deps.paths.uid) return "is another user's"
      if ((target.mode & 0o777) !== 0o700) return 'is not 0700'
      return undefined
    } catch (error) {
      return `could not be checked: ${messageOf(error)}`
    }
  }

  private isDirectory(path: string): boolean {
    try {
      return this.deps.fs.stat(path)?.isDirectory() === true
    } catch {
      return false
    }
  }

  /**
   * §afterExit「挂载点与残留的记录」: each denyWrite entry absent now whose first absent level is an
   * intermediate directory under this wrap's allowWrite — bwrap makes that level an empty directory
   * on the host, which srt cannot take away after a SIGKILL. The entry is first resolved the way
   * srt resolves it before it masks (linux-sandbox-utils.js:2041), so a dangling link on the way
   * puts the level where srt puts it: under the link's target.
   */
  private mountPointsOf(filesystem: FilesystemTables): string[] {
    const writable = entries(filesystem.allowWrite).flatMap((entry) =>
      typeof entry === 'string' ? [] : [entry.path],
    )
    const found = new Set<string>()
    for (const entry of entries(filesystem.denyWrite)) {
      if (typeof entry === 'string') continue
      const resolved = this.resolveDenyPath(entry.path)
      if (resolved === undefined) continue
      const first = this.firstAbsent(resolved)
      if (first === undefined || first === resolved) continue
      if (writable.some((dir) => within(posix.dirname(first), dir))) found.add(first)
    }
    return [...found]
  }

  /**
   * srt79's `resolveSymlinkedDenyPath` (linux-sandbox-utils.js:50-112): the real path, or the
   * deepest ancestor's real path with the rest joined on, a dangling link at the first missing
   * level followed; undefined where srt gives up (a cycle, too many hops, nothing resolves).
   */
  private resolveDenyPath(path: string): string | undefined {
    const real = (at: string): string | undefined => {
      try {
        return this.deps.fs.realpath(at)
      } catch {
        return undefined
      }
    }
    let current = path
    for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
      const whole = real(current)
      if (whole !== undefined) return whole
      let ancestor = current
      const rest: string[] = []
      let resolved: string | undefined
      while (resolved === undefined) {
        const parent = posix.dirname(ancestor)
        if (parent === ancestor) return undefined
        rest.unshift(posix.basename(ancestor))
        ancestor = parent
        resolved = real(ancestor)
      }
      const firstMissing = posix.join(resolved, rest[0] ?? '')
      let target: string
      try {
        target = this.deps.fs.readlink(firstMissing)
      } catch {
        return posix.join(resolved, ...rest)
      }
      current = posix.join(posix.resolve(posix.dirname(firstMissing), target), ...rest.slice(1))
    }
    return undefined
  }

  /** The first level of `path` that is not there, or undefined (all there, a file on the way, an error). */
  private firstAbsent(path: string): string | undefined {
    let prefix = ''
    const parts = path.split('/').filter((part) => part.length > 0)
    for (const [i, part] of parts.entries()) {
      prefix = `${prefix}/${part}`
      let stat: SandboxFileStat | undefined
      try {
        stat = this.deps.fs.stat(prefix)
      } catch {
        return undefined
      }
      if (stat === undefined) return prefix
      if (i < parts.length - 1 && !stat.isDirectory()) return undefined
    }
    return undefined
  }

  /** What `lstat` says of a link node: its type, and its target when it is still a link. */
  private linkState(path: string): string {
    try {
      const stat = this.deps.fs.lstat(path)
      if (stat === undefined) return 'missing'
      if (stat.isSymbolicLink()) return `link ${this.deps.fs.readlink(path)}`
      return stat.isDirectory() ? 'directory' : 'not a directory'
    } catch {
      return 'unknown'
    }
  }

  /** `<profile>/sandbox/stubs.json`'s `mountPoints`: srt id → the mount points that wrap recorded. */
  private editStubs(edit: (mounts: Record<string, string[]>) => void): void {
    const file = posix.join(this.deps.paths.profileDir, 'sandbox', 'stubs.json')
    let record: Record<string, unknown> = {}
    const text = this.deps.fs.readFile(file)
    if (text !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (isPlainObject(parsed)) record = parsed
      } catch {
        this.deps.log(`sandbox: ${file} was not JSON; starting it over`)
      }
    }
    const mounts = isPlainObject(record['mountPoints'])
      ? (record['mountPoints'] as Record<string, string[]>)
      : {}
    edit(mounts)
    record['mountPoints'] = mounts
    this.deps.fs.mkdirPrivate(posix.dirname(file))
    this.deps.fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
  }

  private dropStubs(srtId: string): void {
    try {
      this.editStubs((mounts) => {
        delete mounts[srtId]
      })
    } catch (error) {
      this.deps.log(`sandbox: stubs.json could not be updated: ${messageOf(error)}`)
    }
  }

  /** P6: what this wrap left running outside its process group, found by its mark (darwin). */
  private async killMarked(records: readonly WrapRecord[]): Promise<void> {
    let table: string
    try {
      table = await this.deps.processes.list()
    } catch (error) {
      this.deps.log(`sandbox: the process table could not be read: ${messageOf(error)}`)
      return
    }
    // `ps -E` prints the environment unquoted, and a provider's tool-call id may hold spaces: the
    // mark is looked for whole, not as one white-space token.
    const marks = records.map((record) => `${SANDBOX_MARK_VARIABLE}=${record.srtId}`)
    for (const row of table.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(row)
      if (match === null) continue
      const pid = Number(match[1])
      if (pid <= 1 || pid === process.pid) continue
      if (!marks.some((mark) => holdsWord(match[2] ?? '', mark))) continue
      try {
        this.deps.processes.kill(pid)
      } catch {
        // Gone already.
      }
    }
  }

  private forget(record: WrapRecord): void {
    this.open.delete(keyOf(record.srtId))
    const rest = (this.wraps.get(record.commandId) ?? []).filter((other) => other !== record)
    if (rest.length > 0) this.wraps.set(record.commandId, rest)
    else this.wraps.delete(record.commandId)
    if (record.stubs.length > 0) this.dropStubs(record.srtId)
  }

  private refuse(request: SandboxRequest, why: string): SandboxUnavailableError {
    this.deps.log(`sandbox: refused ${request.commandId}: ${why}`)
    return new SandboxUnavailableError(`the sandbox refused this command: ${why}`)
  }
}

const SHELLS: ReadonlySet<string> = new Set(['zsh', 'bash', 'sh'])

/** srt79's bound on a dangling link chain (`MAX_SYMLINK_RESOLUTION_DEPTH`, the kernel's ELOOP). */
const MAX_LINK_HOPS = 40

/** 读法 6: the tool-use id cut to 67 characters, a dot and 128 random bits — at most 100 in all. */
function srtIdFor(commandId: string): string {
  return `${commandId.slice(0, 67)}.${randomBytes(16).toString('hex')}`
}

/** The key srt's events carry for an id: its first 100 characters, through UTF-8 and back. */
function keyOf(srtId: string): string {
  return Buffer.from(srtId.slice(0, 100)).toString('utf8')
}

/** T7: one argument, single-quoted for a POSIX shell. */
function quote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`
}

/** Keep one violation: at most 200, the protected ones first and before any other (读法 39). */
function keep(record: WrapRecord, violation: SandboxViolation): void {
  if (violation.protected === true) {
    if (record.kept.length >= MAX_WRAP_VIOLATIONS) {
      if (record.protectedCount === record.kept.length) {
        record.dropped += 1
        return
      }
      record.kept.pop()
      record.dropped += 1
    }
    record.kept.splice(record.protectedCount, 0, violation)
    record.protectedCount += 1
    return
  }
  if (record.kept.length >= MAX_WRAP_VIOLATIONS) {
    record.dropped += 1
    return
  }
  record.kept.push(violation)
}

/** A filesystem list as the classifier reads it: a literal entry (srt's object form), or a pattern. */
function entries(list: FilesystemTables['allowWrite']): SandboxPathEntry[] {
  return (list ?? []).map((entry) =>
    typeof entry === 'string' ? entry : { path: entry.path, literal: true },
  )
}

/** `word` in `text` with white space or an end on each side. */
function holdsWord(text: string, word: string): boolean {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    const before = at === 0 ? ' ' : (text[at - 1] ?? ' ')
    const after = text[at + word.length] ?? ' '
    if (/\s/.test(before) && /\s/.test(after)) return true
  }
  return false
}

function within(path: string, dir: string): boolean {
  return dir === '/' || path === dir || path.startsWith(`${dir}/`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------------------------
// The real ports

/** `SandboxFs` on the real disk. */
export function desktopSandboxFs(): SandboxFs {
  return {
    lstat: (path) => lstatSync(path, { throwIfNoEntry: false }),
    stat: (path) => statSync(path, { throwIfNoEntry: false }),
    realpath: (path) => realpathSync(path),
    readlink: (path) => readlinkSync(path),
    mkdirPrivate: (path) => {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    writeFile: (path, text) => {
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(temporary, text, { mode: 0o600 })
      renameSync(temporary, path)
    },
  }
}

/** The process table through `/bin/ps` (§执行与收口; P6). */
export function desktopProcessTable(): SandboxProcessTable {
  return {
    list: () =>
      new Promise((resolve, reject) => {
        const child = spawn('/bin/ps', ['-E', '-axww', '-o', 'pid=,command='], {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        const chunks: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
        child.on('error', reject)
        child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
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

/** One call on the first SIGTERM or SIGINT, as srt's own once-listeners (§退出). */
export function onFirstSignal(listener: () => void): void {
  let called = false
  const once = (): void => {
    if (called) return
    called = true
    listener()
  }
  process.once('SIGTERM', once)
  process.once('SIGINT', once)
}
