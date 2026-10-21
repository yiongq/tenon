/** Spec 04 §IPC's e2e seam: guarded startup, no initialize/chdir, explicit diagnostic reasons. */
import type { AbsolutePath } from '@tenon-app/kernel'
import { describe, expect, it, vi } from 'vitest'
import { appEnvironment } from '../../e2e/helpers/app-env.js'
import {
  sandboxTestMode,
  startDesktopSandboxPosture,
  type SandboxPostureDeps,
} from '../../src/main/host/sandbox-posture.js'
import { snapshotEnv, withoutTenonVars } from '../../src/main/host/shell-env.js'

/** Real startup on win32 stops before any disk or process access; seams also run on darwin. */
function deps(platform: NodeJS.Platform = 'darwin'): SandboxPostureDeps {
  return {
    platform,
    arch: 'arm64',
    srt: {
      initialize: vi.fn<SandboxPostureDeps['srt']['initialize']>(),
      checkDependenciesAsync: vi.fn<SandboxPostureDeps['srt']['checkDependenciesAsync']>(),
      wrapWithSandboxArgv: vi.fn<SandboxPostureDeps['srt']['wrapWithSandboxArgv']>(),
      cleanupAfterCommand: vi.fn<SandboxPostureDeps['srt']['cleanupAfterCommand']>(),
      getWslVersion: vi.fn<SandboxPostureDeps['srt']['getWslVersion']>(),
    },
    helpers: {
      packageDir: '/srt' as AbsolutePath,
      applySeccomp: '/srt/apply-seccomp' as AbsolutePath,
      javaAgentJar: '/srt/java-agent.jar' as AbsolutePath,
    },
    sessionConfig: vi.fn<SandboxPostureDeps['sessionConfig']>(),
    env: {},
    chdirDir: '/data/sandbox-cwd' as AbsolutePath,
    chdir: vi.fn<SandboxPostureDeps['chdir']>(),
    fs: {
      stat: vi.fn<SandboxPostureDeps['fs']['stat']>(),
      realpath: vi.fn<SandboxPostureDeps['fs']['realpath']>(),
      readlink: vi.fn<SandboxPostureDeps['fs']['readlink']>(),
      mkdirPrivate: vi.fn<SandboxPostureDeps['fs']['mkdirPrivate']>(),
      readFile: vi.fn<SandboxPostureDeps['fs']['readFile']>(),
      writeFile: vi.fn<SandboxPostureDeps['fs']['writeFile']>(),
      lstat: vi.fn<SandboxPostureDeps['fs']['lstat']>(),
      readdir: vi.fn<SandboxPostureDeps['fs']['readdir']>(),
      isExecutable: vi.fn<SandboxPostureDeps['fs']['isExecutable']>(),
      removeEmptyDir: vi.fn<SandboxPostureDeps['fs']['removeEmptyDir']>(),
      removeFile: vi.fn<SandboxPostureDeps['fs']['removeFile']>(),
      removeTree: vi.fn<SandboxPostureDeps['fs']['removeTree']>(),
    },
    tmpdir: '/tmp' as AbsolutePath,
    processes: {
      list: vi.fn<SandboxPostureDeps['processes']['list']>(),
      kill: vi.fn<SandboxPostureDeps['processes']['kill']>(),
    },
    run: vi.fn<SandboxPostureDeps['run']>(),
    uid: 501,
    pid: 4321,
    home: '/Users/u' as AbsolutePath,
    profileDir: '/data/profiles/local/personal' as AbsolutePath,
    log: vi.fn<SandboxPostureDeps['log']>(),
  }
}

describe('04 sandbox e2e seam', () => {
  it.each([
    {
      mode: 'off',
      expected: {
        state: 'unavailable',
        session: null,
        noSeccomp: false,
        reasons: [{ code: 'test-seam', detail: 'off' }],
        initialize: 'not-called',
      },
    },
    {
      mode: 'fake',
      expected: {
        state: 'active',
        session: null,
        noSeccomp: false,
        reasons: [{ code: 'test-seam', detail: 'fake' }],
        initialize: 'not-called',
      },
    },
  ])(
    '04 验收 34 (seam): $mode skips initialize, chdir and all startup preparation',
    async ({ mode, expected }) => {
      const ports = deps()
      const run = startDesktopSandboxPosture(
        ports,
        false,
        snapshotEnv({
          TENON_DEV_ENV: 'off',
          TENON_TEST_SANDBOX: mode,
        }),
      )
      expect(await run.outcome).toEqual(expected)
      let initialized = false
      void run.initialized.then(() => {
        initialized = true
      })
      await Promise.resolve()
      expect(initialized).toBe(false)
      expect(ports.srt.initialize).not.toHaveBeenCalled()
      expect(ports.srt.getWslVersion).not.toHaveBeenCalled()
      expect(ports.srt.checkDependenciesAsync).not.toHaveBeenCalled()
      expect(ports.chdir).not.toHaveBeenCalled()
      expect(ports.fs.mkdirPrivate).not.toHaveBeenCalled()
      expect(ports.fs.lstat).not.toHaveBeenCalled()
      expect(ports.sessionConfig).not.toHaveBeenCalled()
      expect(ports.processes.list).not.toHaveBeenCalled()
      expect(ports.run).not.toHaveBeenCalled()
    },
  )

  it('04 验收 34 (seam): fake is active with exactly the test-seam reason and a startup log', async () => {
    const ports = deps()
    const outcome = await startDesktopSandboxPosture(
      ports,
      false,
      snapshotEnv({
        TENON_DEV_ENV: 'off',
        TENON_TEST_SANDBOX: 'fake',
      }),
    ).outcome
    expect(outcome.state).toBe('active')
    expect(outcome.reasons).toEqual([{ code: 'test-seam', detail: 'fake' }])
    expect(ports.log).toHaveBeenCalledExactlyOnceWith('sandbox: active (test-seam: fake)')
  })

  it.each([
    { packaged: true, dev: 'off', mode: 'fake' },
    { packaged: true, dev: 'off', mode: 'off' },
    { packaged: false, dev: undefined, mode: 'fake' },
    { packaged: false, dev: 'on', mode: 'off' },
    { packaged: false, dev: 'OFF', mode: 'fake' },
    { packaged: false, dev: 'off', mode: undefined },
    { packaged: false, dev: 'off', mode: 'FAKE' },
    { packaged: false, dev: 'off', mode: 'invalid' },
  ])(
    '04 验收 34 (seam): guards fall back to real startup ($packaged, $dev, $mode)',
    async ({ packaged, dev, mode }) => {
      const env = snapshotEnv({ TENON_DEV_ENV: dev, TENON_TEST_SANDBOX: mode })
      expect(sandboxTestMode(packaged, env)).toBeNull()
      const outcome = await startDesktopSandboxPosture(deps('win32'), packaged, env).outcome
      expect(outcome.state).toBe('unavailable')
      expect(outcome.reasons).toEqual([{ code: 'windows', detail: null }])
      expect(outcome.initialize).toBe('not-called')
    },
  )

  it('04 验收 34 (seam): a packaged build never reads the seam environment', () => {
    const env = new Proxy(snapshotEnv({}), {
      get() {
        throw new Error('packaged build read a test switch')
      },
    })
    expect(sandboxTestMode(true, env)).toBeNull()
  })

  it.each([false, true])(
    '04 验收 34 (seam): commands never inherit the switch (packaged=%s)',
    (packaged) => {
      expect(
        withoutTenonVars(
          snapshotEnv({
            PATH: '/usr/bin',
            TENON_DEV_ENV: 'off',
            TENON_TEST_SANDBOX: 'fake',
          }),
          packaged,
        ),
      ).toEqual({ PATH: '/usr/bin' })
    },
  )

  it('04 验收 34 (seam): e2e defaults to fake regardless of the runner switch and permits an explicit override', () => {
    expect(appEnvironment({ TENON_TEST_SANDBOX: 'off' }, {})).toMatchObject({
      TENON_DEV_ENV: 'off',
      TENON_TEST_SANDBOX: 'fake',
    })
    expect(appEnvironment({}, {})).toMatchObject({
      TENON_DEV_ENV: 'off',
      TENON_TEST_SANDBOX: 'fake',
    })
    expect(appEnvironment({}, { env: { TENON_TEST_SANDBOX: 'off' } })).toMatchObject({
      TENON_DEV_ENV: 'off',
      TENON_TEST_SANDBOX: 'off',
    })
  })
})
