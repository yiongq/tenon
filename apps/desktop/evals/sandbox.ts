/** Process-wide srt startup, with a DesktopSandbox and isolated paths for each eval task (04:26). */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import type { AbsolutePath, SandboxPorts, SessionService } from '@tenon-app/kernel'
import { DesktopSandbox, desktopProcessTable, desktopSandboxFs } from '../src/main/host/sandbox.js'
import { credentialPaths, helperPaths, sessionConfig } from '../src/main/host/sandbox-config.js'
import type { SandboxHostPaths } from '../src/main/host/sandbox-config.js'
import {
  desktopPostureFs,
  desktopPostureProcesses,
  desktopPostureRunner,
  desktopSrtSandbox,
  desktopSrtStartup,
  startSandboxPosture,
} from '../src/main/host/sandbox-posture.js'
import { createHostProcess } from '../src/main/host/process.js'

export interface EvalSandbox {
  readonly sandbox: DesktopSandbox
  readonly ports: SandboxPorts
  bindSessions(sessions: SessionService): void
  dispose(): Promise<void>
}

let processSandbox: ReturnType<typeof startProcessSandbox> | undefined

/** Called by the live harness after its last task, including a failed task. */
export async function disposeEvalSandbox(): Promise<void> {
  await processSandbox?.dispose()
}

export async function createEvalSandbox(
  profileDir: AbsolutePath,
  log: (line: string) => void,
): Promise<EvalSandbox> {
  processSandbox ??= startProcessSandbox(log)
  return processSandbox.attach(profileDir, log)
}

function startProcessSandbox(log: (line: string) => void) {
  const root = absolutePath(realpathSync(mkdtempSync(join(tmpdir(), 'tenon-eval-sandbox-'))))
  const profileDir = absolutePath(join(root, 'profile'))
  mkdirSync(profileDir, { mode: 0o700 })
  const helpers = helperPaths()
  const fs = desktopSandboxFs()
  const paths = pathsFor(profileDir, helpers.packageDir)
  const signals = new Set<() => void>()
  const signal = (): void => {
    for (const listener of signals) listener()
  }
  process.once('SIGINT', signal)
  process.once('SIGTERM', signal)
  const srt = desktopSrtSandbox()
  const deps = {
    srt,
    paths,
    fs,
    settings: () => ({ profile: 'workspace-write' as const, packageManagers: false }),
    sessionFolders: async (): Promise<readonly AbsolutePath[]> => [],
    processes: desktopProcessTable(),
    onSignal: (listener: () => void) => signals.add(listener),
    log,
  }
  // This instance owns reset only; task instances collect the violation events.
  const owner = new DesktopSandbox({
    ...deps,
    srt: {
      ...srt,
      getSandboxViolationStore: () => ({ getTotalCount: () => 0, subscribe: () => () => {} }),
    },
  })
  const run = startSandboxPosture({
    platform: process.platform,
    arch: process.arch,
    srt: desktopSrtStartup(),
    helpers,
    sessionConfig: (parts) =>
      sessionConfig({ ...paths, noSeccomp: false, allowedDomains: [], ...parts }, fs),
    env: process.env,
    chdirDir: null,
    chdir: () => {},
    fs: desktopPostureFs(),
    tmpdir: absolutePath(tmpdir()),
    processes: desktopPostureProcesses(),
    run: desktopPostureRunner(createHostProcess(log)),
    uid: paths.uid,
    pid: process.pid,
    home: paths.home,
    profileDir,
    log,
  })
  owner.start(run)
  let session: ReturnType<typeof sessionConfig> | null = null
  let domains: readonly string[] = []
  let disposed: Promise<void> | undefined
  const ready = run.outcome.then((outcome) => {
    session = outcome.session
  })
  const updateDomains = (hosts: readonly string[]): void => {
    const next = [...new Set(hosts)].toSorted()
    if (session === null || next.join('\n') === domains.join('\n')) return
    session = { ...session, network: { ...session.network, allowedDomains: next } }
    srt.updateConfig(session)
    domains = next
  }
  return {
    async attach(taskProfile: AbsolutePath, taskLog: (line: string) => void): Promise<EvalSandbox> {
      if (disposed !== undefined) throw new Error('the eval sandbox process was disposed')
      await ready
      let sessions: SessionService | undefined
      let currentSession: string | undefined
      const unsubscribers: Array<() => void> = []
      const taskSignals = new Set<() => void>()
      const sandbox = new DesktopSandbox({
        ...deps,
        log: taskLog,
        paths: pathsFor(taskProfile, helpers.packageDir),
        // srt lives until the process's last task. Task disposal only detaches its listeners.
        srt: {
          ...srt,
          reset: async () => {},
          getSandboxViolationStore: () => {
            const store = srt.getSandboxViolationStore()
            return {
              getTotalCount: () => store.getTotalCount(),
              subscribe: (listener) => {
                const unsubscribe = store.subscribe(listener)
                unsubscribers.push(unsubscribe)
                return unsubscribe
              },
            }
          },
        },
        sessionFolders: async (sessionId) =>
          (await sessions?.sessionFacts({ sessionId }))?.workspace?.folders ?? [],
        onSignal: (listener) => {
          taskSignals.add(listener)
          signals.add(listener)
        },
      })
      sandbox.start(run)
      return {
        sandbox,
        bindSessions: (service) => {
          sessions = service
        },
        ports: {
          beforeWrap(q) {
            currentSession = q.sessionId
            updateDomains(q.hosts)
            sandbox.beforeWrap(q)
          },
          grantsChanged(q) {
            if (q.sessionId === currentSession) updateDomains(q.hosts)
          },
        },
        async dispose() {
          await sandbox.dispose()
          for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
          for (const listener of taskSignals) signals.delete(listener)
        },
      }
    },
    dispose(): Promise<void> {
      disposed ??= (async () => {
        await owner.dispose()
        process.removeListener('SIGINT', signal)
        process.removeListener('SIGTERM', signal)
        rmSync(root, { recursive: true, force: true })
      })()
      return disposed
    },
  }
}

function pathsFor(
  profileDir: AbsolutePath,
  srtPackageDir: AbsolutePath,
): Omit<SandboxHostPaths, 'noSeccomp'> {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
  // The command's HOME is temporary; the deny lists must still protect the real user's files.
  const home = absolutePath(homedir())
  return {
    platform,
    home,
    zdotdir: process.env['ZDOTDIR']?.startsWith('/') ? absolutePath(process.env['ZDOTDIR']) : null,
    profileDir,
    cacheDir: absolutePath(join(profileDir, 'sandbox-cache')),
    chdirDir: null,
    srtPackageDir,
    credentials: credentialPaths(platform, home),
    uid: process.getuid?.() ?? 0,
    xdgRuntimeDir: process.env['XDG_RUNTIME_DIR'] ?? null,
    sshAuthSock: process.env['SSH_AUTH_SOCK'] ?? null,
  }
}
