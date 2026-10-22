/** Fake srt and filesystem ports for the desktop assembly tests. */
import { absolutePath, createMemoryHost } from '@tenon-app/kernel'
import type { SandboxRequest } from '@tenon-app/kernel'
import type { SandboxSettings } from '@tenon-app/contracts'
import { vi } from 'vitest'
import { createDesktopLoop } from '../../src/main/chat.js'
import {
  DesktopSandboxRuntime,
  type SandboxRuntimeOptions,
} from '../../src/main/host/sandbox-runtime.js'
import { sessionConfig } from '../../src/main/host/sandbox-config.js'
import type { SandboxPostureOutcome } from '../../src/main/host/sandbox-posture.js'
import { snapshotEnv } from '../../src/main/host/shell-env.js'
const p = absolutePath
const SESSION = '6f1c2a4e-3b5d-4c7e-9f80-1a2b3c4d5e6f'
export function wiringFixture(
  mode?: 'off' | 'fake',
  packaged = false,
  dev: string | undefined = 'off',
) {
  let settings: SandboxSettings = {
    profile: 'workspace-write',
    packageManagers: false,
    allowedDomains: [],
  }
  const signals: (() => void)[] = []
  const fs: SandboxRuntimeOptions['fs'] = {
    lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 501, mode: 0o700 }),
    stat: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 501, mode: 0o700 }),
    realpath: (path) => path,
    readlink: () => {
      throw new Error('not a link')
    },
    mkdirPrivate: vi.fn(),
    readFile: () => undefined,
    writeFile: vi.fn(),
  }
  const paths: SandboxRuntimeOptions['paths'] = {
    platform: 'darwin',
    home: p('/home/u'),
    zdotdir: null,
    profileDir: p('/data/profiles/u/t'),
    cacheDir: p('/data/sandbox-cache'),
    chdirDir: p('/data/sandbox-cwd'),
    srtPackageDir: p('/srt'),
    credentials: [],
    uid: 501,
    xdgRuntimeDir: null,
    sshAuthSock: null,
  }
  const session = sessionConfig(
    {
      ...paths,
      noSeccomp: false,
      allowedDomains: [],
      applySeccompPath: p('/srt/apply-seccomp'),
      javaAgentJarPath: p('/srt/java.jar'),
      linuxBinaries: null,
    },
    fs,
  )
  const outcome: SandboxPostureOutcome = {
    state: 'active',
    session,
    noSeccomp: false,
    reasons: [],
    initialize: 'returned',
  }
  const srt: SandboxRuntimeOptions['srt'] = {
    wrapWithSandboxArgv: vi.fn(async () => ({ argv: ['/bin/sh', '-c', 'true'], env: {} })),
    cleanupAfterCommand: vi.fn(),
    getSandboxViolationStore: () => ({ getTotalCount: () => 0, subscribe: () => () => {} }),
    reset: vi.fn(async () => {}),
    updateConfig: vi.fn(),
  }
  const options: SandboxRuntimeOptions = {
    paths,
    fs,
    settings: () => settings,
    sessionFolders: vi.fn(async () => [p('/work/project')]),
    processes: { list: async () => '', listArgv: async () => '', kill: () => {} },
    onSignal: (listener) => {
      signals.push(listener)
    },
    log: vi.fn(),
    srt,
    platform: 'darwin',
    isPackaged: packaged,
    startupEnv: snapshotEnv({
      TENON_DEV_ENV: dev === 'missing' ? undefined : dev,
      TENON_TEST_SANDBOX: mode,
    }),
    startPosture: vi.fn(() => ({
      initialized: Promise.resolve(),
      outcome: Promise.resolve(outcome),
    })),
  }
  const runtime = new DesktopSandboxRuntime(options)
  const memory = createMemoryHost()
  const loop = createDesktopLoop({
    clock: memory.clock,
    send: () => {},
    locale: () => 'en',
    commandShell: { path: p('/bin/sh'), env: async () => ({}) },
    sandbox: runtime,
  })
  const request = (
    commandId = 'cmd',
    profile: SandboxRequest['profile'] = settings.profile,
  ): SandboxRequest => ({
    commandId,
    profile,
    argv: ['/bin/sh', '-c', 'echo ok'],
    env: { PATH: '/bin' },
    cwd: p('/work/project'),
    workspace: profile === 'read-only' ? [] : [p('/work/project')],
  })
  return {
    runtime,
    srt,
    fs,
    options,
    signals,
    outcome,
    loop,
    request,
    setSettings: (patch: Partial<SandboxSettings>) => {
      settings = { ...settings, ...patch }
    },
    async command(hosts: readonly string[] = [], sessionId = SESSION, commandId = 'cmd') {
      loop.ports.sandbox!.beforeWrap({ commandId, sessionId, hosts })
      await runtime.wrap(request(commandId))
      await runtime.afterExit(commandId)
      return runtime.violations(commandId)
    },
  }
}
