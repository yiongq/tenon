/** 04 step 13c: actual desktop wiring over fake srt ports, no OS sandbox or Electron needed. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime'
import { sandboxAllowedDomainsSchema } from '@tenon-app/contracts'
import { absolutePath, createMemoryHost } from '@tenon-app/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readConfig, watchConfig, writeConfig } from '../../src/main/host/profile.js'
import {
  startSandboxAfterWindow,
  createDesktopSandboxRuntime,
} from '../../src/main/host/sandbox-runtime.js'
import type { SandboxPostureOutcome } from '../../src/main/host/sandbox-posture.js'
import { wiringFixture } from './wiring-support.js'
import { snapshotEnv } from '../../src/main/host/shell-env.js'
import * as sandboxPorts from '../../src/main/host/sandbox.js'
import * as posturePorts from '../../src/main/host/sandbox-posture.js'

const SESSION = '6f1c2a4e-3b5d-4c7e-9f80-1a2b3c4d5e6f'
const CHILD = '11111111-1111-4111-8111-111111111111'

afterEach(() => vi.useRealTimers())

describe('04 desktop sandbox wiring', () => {
  it('04 不变量 19: the installed host never adds provider, gateway, MCP or telemetry endpoints', async () => {
    const h = wiringFixture()
    const host = createMemoryHost()
    await host.fs.mkdirp(absolutePath(host.identity.profileDir))
    await writeConfig(host.fs, host.identity, {
      provider: { id: 'anthropic', modelId: 'test-model' },
      providerConfig: {
        anthropic: { baseURL: 'https://api.anthropic.com' },
        openai: { baseURL: 'https://gateway.example.net/v1' },
      },
      customVendors: [
        {
          id: 'custom-11111111-1111-4111-8111-111111111111',
          displayName: 'Test vendor',
          wire: 'openai-chat',
          baseURL: 'https://vendor.example.net/v1',
          models: [],
        },
      ],
      mcpServers: [
        {
          id: 'test-mcp',
          displayName: 'Test MCP',
          source: 'manual',
          enabled: true,
          transport: {
            type: 'http',
            url: 'https://mcp.example.net/mcp',
            header_keys: [],
            protocol: 'auto',
            oauth: { ownClient: null, issuers: [] },
          },
          handshakeTimeoutSec: null,
          callTimeoutSec: null,
          instructions: { enabled: true, pinHash: null },
          consent: null,
          toolsPinned: false,
          tools: {},
        },
      ],
      sandbox: {
        profile: 'workspace-write',
        allowedDomains: ['user.example.org'],
        packageManagers: true,
      },
    })
    const fs = {
      ...h.fs,
      lstat: () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: process.getuid?.() ?? 0,
        mode: 0o700,
      }),
      stat: () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: process.getuid?.() ?? 0,
        mode: 0o700,
      }),
    }
    const startupSrt = {
      initialize: vi.fn<posturePorts.SrtStartup['initialize']>(async () => {}),
      checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
      wrapWithSandboxArgv: async () => ({ argv: ['/bin/sh', '-c', 'true'], env: {} }),
      cleanupAfterCommand: () => {},
      getWslVersion: () => undefined,
    }
    const mocks = [
      vi.spyOn(sandboxPorts, 'desktopSandboxFs').mockReturnValue(fs),
      vi.spyOn(sandboxPorts, 'desktopProcessTable').mockReturnValue(h.options.processes),
      vi.spyOn(posturePorts, 'desktopSrtSandbox').mockReturnValue(h.srt),
      vi.spyOn(posturePorts, 'desktopSrtStartup').mockReturnValue(startupSrt),
      vi.spyOn(posturePorts, 'desktopPostureFs').mockReturnValue({
        ...fs,
        lstat: (path) =>
          path.includes('tenon-sandbox-self-test-')
            ? undefined
            : {
                ...fs.lstat(),
                isFile: () => false,
                size: 0,
                nlink: 1,
              },
        stat: (path) => ({
          ...fs.stat(),
          isDirectory: () => !path.endsWith('.jar') && !path.endsWith('/apply-seccomp'),
        }),
        readdir: () => [],
        isExecutable: () => true,
        removeEmptyDir: () => {},
        removeFile: () => {},
        removeTree: () => {},
      }),
      vi.spyOn(posturePorts, 'desktopPostureProcesses').mockReturnValue({
        list: async () => [],
        kill: () => {},
      }),
      vi.spyOn(posturePorts, 'desktopPostureRunner').mockReturnValue(async () => ({
        code: 0,
        signal: null,
        stderr: '',
        timedOut: false,
      })),
      vi.spyOn(process, 'chdir').mockImplementation(() => {}),
    ]
    try {
      const runtime = await createDesktopSandboxRuntime({
        host,
        userDataDir: absolutePath('/data'),
        isPackaged: false,
        startupEnv: snapshotEnv({}),
        log: () => {},
      })
      runtime.bindSessionFolders(async () => [absolutePath('/work/project')])
      expect((await runtime.start().outcome).state).toBe('active')
      runtime.beforeWrap({
        commandId: 'installed',
        sessionId: SESSION,
        hosts: ['grant.example.org'],
      })
      await runtime.wrap(h.request('installed'))
      expect(h.srt.wrapWithSandboxArgv).toHaveBeenCalledTimes(1)
      const domains = vi.mocked(h.srt.updateConfig).mock.calls.at(-1)?.[0].network.allowedDomains
      expect(domains).toEqual([
        'user.example.org',
        'registry.npmjs.org',
        'pypi.org',
        'files.pythonhosted.org',
        'index.crates.io',
        'static.crates.io',
        'grant.example.org',
      ])
      for (const endpoint of [
        'api.anthropic.com',
        'api.openai.com',
        'gateway.example.net',
        'vendor.example.net',
        'mcp.example.net',
        'telemetry.example.net',
      ])
        expect(domains).not.toContain(endpoint)
      await runtime.afterExit('installed')
    } finally {
      mocks.forEach((mock) => mock.mockRestore())
    }
  })

  it('04 验收 29: an edit or the preset takes effect on the next command through updateConfig, never reset', async () => {
    const h = wiringFixture()
    h.runtime.start()
    await h.command()
    expect(h.srt.updateConfig).not.toHaveBeenCalled()
    h.setSettings({ allowedDomains: ['docs.example.com'] })
    await h.command()
    expect(h.srt.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: {
          allowedDomains: ['docs.example.com'],
          deniedDomains: [],
          strictAllowlist: true,
          parentProxy: { noProxy: '*' },
        },
      }),
    )
    h.setSettings({ packageManagers: true })
    await h.command()
    expect(h.srt.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({
          allowedDomains: [
            'docs.example.com',
            'registry.npmjs.org',
            'pypi.org',
            'files.pythonhosted.org',
            'index.crates.io',
            'static.crates.io',
          ],
        }),
      }),
    )
    await h.command()
    expect(h.srt.updateConfig).toHaveBeenCalledTimes(2)
    h.setSettings({ allowedDomains: [], packageManagers: false })
    await h.command()
    expect(h.srt.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ network: expect.objectContaining({ allowedDomains: [] }) }),
    )
    expect(h.srt.reset).not.toHaveBeenCalled()
  })

  it('04 验收 29: with the preset on, the Tenon npm cache is writable and named by npm_config_cache in workspace-write only; ~/.npm is never in allowWrite', async () => {
    const h = wiringFixture()
    h.setSettings({ packageManagers: true })
    h.runtime.start()
    h.loop.ports.sandbox!.beforeWrap({ commandId: 'write', sessionId: SESSION, hosts: [] })
    const wrapped = await h.runtime.wrap(h.request('write'))
    expect(wrapped.env['npm_config_cache']).toBe('/data/sandbox-cache/npm')
    expect(h.srt.wrapWithSandboxArgv).toHaveBeenLastCalledWith(
      expect.any(String),
      '/bin/sh',
      expect.objectContaining({
        filesystem: expect.objectContaining({
          allowWrite: [
            { path: '/work/project', literal: true },
            { path: '/data/sandbox-cache/npm', literal: true },
            { path: '/data/sandbox-cache/pnpm', literal: true },
            { path: '/data/sandbox-cache/uv', literal: true },
            { path: '/data/sandbox-cache/cargo', literal: true },
          ],
        }),
      }),
      undefined,
      '/work/project',
      expect.any(Object),
    )
    await h.runtime.afterExit('write')
    h.setSettings({ profile: 'read-only' })
    h.loop.ports.sandbox!.beforeWrap({ commandId: 'read', sessionId: SESSION, hosts: [] })
    expect((await h.runtime.wrap(h.request('read'))).env).toEqual({
      PATH: '/bin',
      OS_ACTIVITY_MODE: 'disable',
      TENON_SANDBOX_MARK: expect.any(String),
    })
    expect(h.srt.wrapWithSandboxArgv).toHaveBeenLastCalledWith(
      expect.any(String),
      '/bin/sh',
      expect.objectContaining({ filesystem: expect.objectContaining({ allowWrite: [] }) }),
      undefined,
      '/work/project',
      expect.any(Object),
    )
    await h.runtime.afterExit('read')
  })

  it("04 验收 29: setSettings({ profile: 'read-only' }) reaches posture() and the next wrap without a restart", async () => {
    const h = wiringFixture()
    const host = createMemoryHost()
    await host.fs.mkdirp(absolutePath(host.identity.profileDir))
    const installed = await createDesktopSandboxRuntime({
      host,
      userDataDir: absolutePath('/data'),
      isPackaged: false,
      startupEnv: snapshotEnv({}),
      log: () => {},
    })
    let config = await readConfig(host.fs, host.identity)
    const unwatch = watchConfig(host.identity, (next) => {
      config = next
      h.setSettings(config.sandbox)
    })
    try {
      h.runtime.start()
      await h.command()
      await writeConfig(host.fs, host.identity, {
        sandbox: { ...config.sandbox, profile: 'read-only' },
      })
      expect(h.runtime.posture()).toEqual({ state: 'active', profile: 'read-only' })
      expect(installed.posture()).toEqual({ state: 'pending', profile: 'read-only' })
      await h.command()
      expect(h.srt.wrapWithSandboxArgv).toHaveBeenLastCalledWith(
        expect.any(String),
        '/bin/sh',
        expect.objectContaining({ filesystem: expect.objectContaining({ allowWrite: [] }) }),
        undefined,
        '/work/project',
        expect.any(Object),
      )
      expect(h.options.startPosture).toHaveBeenCalledTimes(1)
    } finally {
      unwatch()
    }
  })

  it("04 验收 28: every sample the Tenon schema accepts, srt's schema accepts", () => {
    const h = wiringFixture()
    const samples = [
      'example.com',
      '*.example.com',
      'example.com:443',
      'localhost:8080',
      'a.localhost:1234',
      '127.0.0.1:80',
      '10.0.0.1:8080',
      '[::1]:9000',
      '[fe80::1]:9001',
      '[2001:4860:4860::8888]',
      '8.8.8.8',
    ]
    for (const sample of samples) {
      expect(sandboxAllowedDomainsSchema.safeParse([sample]).success).toBe(true)
      expect(
        SandboxRuntimeConfigSchema.safeParse({
          ...h.outcome.session,
          network: { ...h.outcome.session!.network, allowedDomains: [sample] },
        }).success,
      ).toBe(true)
    }
    for (const sample of ['example.com:0443', '127.0.0.1:00080', '[::1]:03000']) {
      expect([sample, sandboxAllowedDomainsSchema.safeParse([sample]).success]).toEqual([
        sample,
        false,
      ])
      expect(
        SandboxRuntimeConfigSchema.safeParse({
          ...h.outcome.session,
          network: { ...h.outcome.session!.network, allowedDomains: [sample] },
        }).success,
      ).toBe(false)
    }
  })

  it('04 不变量 9: a grant from another session during a wrap never reaches the command being wrapped', async () => {
    const h = wiringFixture()
    const entered = Promise.withResolvers<void>()
    const wrapped = Promise.withResolvers<{ argv: string[]; env: Record<string, string> }>()
    vi.mocked(h.srt.wrapWithSandboxArgv).mockImplementationOnce(() => {
      entered.resolve()
      return wrapped.promise
    })
    h.runtime.start()
    h.loop.ports.sandbox!.beforeWrap({
      commandId: 'first',
      sessionId: SESSION,
      hosts: ['one.example.com'],
    })
    const pending = h.runtime.wrap(h.request('first'))
    await entered.promise
    h.loop.ports.sandbox!.beforeWrap({
      commandId: 'second',
      sessionId: CHILD,
      hosts: ['two.example.com'],
    })
    h.loop.ports.sandbox!.grantsChanged({ sessionId: CHILD, hosts: ['new.example.com'] })
    expect(h.srt.updateConfig).toHaveBeenCalledTimes(1)
    expect(h.srt.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ allowedDomains: ['one.example.com'] }),
      }),
    )
    wrapped.resolve({ argv: ['/bin/sh', '-c', 'true'], env: {} })
    await pending
    expect(h.srt.updateConfig).toHaveBeenCalledTimes(1)
    await h.runtime.afterExit('first')
    await h.runtime.wrap(h.request('second'))
    expect(h.srt.updateConfig).toHaveBeenCalledTimes(2)
    expect(h.srt.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ allowedDomains: ['new.example.com'] }),
      }),
    )
    await h.runtime.afterExit('second')
    expect(h.srt.reset).not.toHaveBeenCalled()
  })

  it('04 不变量 9: each command replaces session grants; grantsChanged updates only the most recent session without reset', async () => {
    const h = wiringFixture()
    h.runtime.start()
    await h.command(['child.example.com'], CHILD)
    expect(h.srt.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ allowedDomains: ['child.example.com'] }),
      }),
    )
    await h.command([], SESSION)
    expect(h.srt.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ network: expect.objectContaining({ allowedDomains: [] }) }),
    )
    h.loop.ports.sandbox!.grantsChanged({ sessionId: CHILD, hosts: ['ignored.example.com'] })
    expect(h.srt.updateConfig).toHaveBeenCalledTimes(2)
    h.loop.ports.sandbox!.grantsChanged({ sessionId: SESSION, hosts: ['now.example.com'] })
    expect(h.srt.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ allowedDomains: ['now.example.com'] }),
      }),
    )
    expect(h.srt.reset).not.toHaveBeenCalled()
  })

  it("04 不变量 19: with providers, custom vendors, a gateway and MCP servers configured, the effective allowlist is exactly the user list, the preset and the session's grants, and the preset table holds only package-registry domains", async () => {
    const h = wiringFixture()
    const config = {
      providers: ['api.anthropic.com', 'api.openai.com'],
      customVendors: ['vendor.example.net'],
      gateway: 'gateway.example.net',
      mcpServers: ['mcp.example.net'],
      sandbox: {
        profile: 'workspace-write' as const,
        allowedDomains: ['user.example.org'],
        packageManagers: true,
      },
    }
    h.setSettings(config.sandbox)
    h.runtime.start()
    await h.command(['grant.example.org'])
    expect(h.runtime.view().preset.domains).toEqual([
      'registry.npmjs.org',
      'pypi.org',
      'files.pythonhosted.org',
      'index.crates.io',
      'static.crates.io',
    ])
    expect(h.srt.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({
          allowedDomains: [
            'user.example.org',
            'registry.npmjs.org',
            'pypi.org',
            'files.pythonhosted.org',
            'index.crates.io',
            'static.crates.io',
            'grant.example.org',
          ],
        }),
      }),
    )
  })

  it('04 不变量 9: another session waits for afterExit, then switches; a hung call waits at most 2 s and logs', async () => {
    vi.useFakeTimers()
    const h = wiringFixture()
    h.runtime.start()
    h.loop.ports.sandbox!.beforeWrap({
      commandId: 'first',
      sessionId: SESSION,
      hosts: ['one.example.com'],
    })
    await h.runtime.wrap(h.request('first'))
    h.loop.ports.sandbox!.beforeWrap({
      commandId: 'second',
      sessionId: CHILD,
      hosts: ['two.example.com'],
    })
    const pending = h.runtime.wrap(h.request('second'))
    h.loop.ports.sandbox!.grantsChanged({ sessionId: CHILD, hosts: ['new.example.com'] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.srt.wrapWithSandboxArgv).toHaveBeenCalledTimes(1)
    expect(h.srt.updateConfig).toHaveBeenCalledTimes(1)
    const exiting = h.runtime.afterExit('first')
    await vi.advanceTimersByTimeAsync(50)
    await exiting
    await pending
    expect(h.srt.wrapWithSandboxArgv).toHaveBeenCalledTimes(2)
    expect(h.srt.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ allowedDomains: ['new.example.com'] }),
      }),
    )
    // A different pending session cannot stay stuck behind this now-running command.
    h.loop.ports.sandbox!.beforeWrap({ commandId: 'third', sessionId: SESSION, hosts: [] })
    const third = h.runtime.wrap(h.request('third'))
    await vi.advanceTimersByTimeAsync(1999)
    expect(h.srt.wrapWithSandboxArgv).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await third
    expect(h.options.log).toHaveBeenCalledWith(
      'sandbox: other session commands did not settle within 2000 ms; switching allowlist',
    )
    const closing = Promise.all([h.runtime.afterExit('second'), h.runtime.afterExit('third')])
    await vi.advanceTimersByTimeAsync(50)
    await closing
  })

  it('04 验收 2 (wiring): the window is created before the posture settles', async () => {
    const h = wiringFixture()
    const pending = Promise.withResolvers<SandboxPostureOutcome>()
    const order: string[] = []
    vi.mocked(h.options.startPosture).mockImplementation(() => {
      order.push('posture')
      return { initialized: Promise.resolve(), outcome: pending.promise }
    })
    const window = startSandboxAfterWindow(() => {
      order.push('window')
      return { visible: true }
    }, h.runtime)
    expect(window).toEqual({ visible: true })
    expect(order).toEqual(['window', 'posture'])
    expect(h.runtime.posture().state).toBe('pending')
    pending.resolve(h.outcome)
    await pending.promise
    expect(h.runtime.posture().state).toBe('active')
    const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('const win = startSandboxAfterWindow(openWindow, host.sandbox)')
  })

  it('04 验收 4 (wiring): pending startup refuses within 15 s, without a second startup wait', async () => {
    vi.useFakeTimers()
    const h = wiringFixture()
    vi.mocked(h.options.startPosture).mockReturnValue({
      initialized: new Promise(() => {}),
      outcome: new Promise(() => {}),
    })
    h.runtime.start()
    const refused = h.runtime
      .wrap(h.request())
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await refused).toBe('sandbox startup did not finish in 15000 ms')
    expect(h.srt.wrapWithSandboxArgv).not.toHaveBeenCalled()
  })

  it('04 不变量 9: beforeWrap selects only that session spill directory and workspace folders', async () => {
    const h = wiringFixture()
    h.runtime.start()
    await h.command([], SESSION)
    expect(h.options.sessionFolders).toHaveBeenLastCalledWith(SESSION)
    expect(h.srt.wrapWithSandboxArgv).toHaveBeenLastCalledWith(
      expect.any(String),
      '/bin/sh',
      expect.objectContaining({
        filesystem: expect.objectContaining({
          allowRead: [
            {
              path: '/data/profiles/u/t/tool-output/6f1c2a4e-3b5d-4c7e-9f80-1a2b3c4d5e6f',
              literal: true,
            },
          ],
        }),
      }),
      undefined,
      '/work/project',
      expect.any(Object),
    )
    await h.command([], CHILD)
    expect(h.options.sessionFolders).toHaveBeenLastCalledWith(CHILD)
    expect(h.srt.wrapWithSandboxArgv).toHaveBeenLastCalledWith(
      expect.any(String),
      '/bin/sh',
      expect.objectContaining({
        filesystem: expect.objectContaining({
          allowRead: [
            {
              path: '/data/profiles/u/t/tool-output/11111111-1111-4111-8111-111111111111',
              literal: true,
            },
          ],
        }),
      }),
      undefined,
      '/work/project',
      expect.any(Object),
    )
    await expect(h.runtime.wrap(h.request('unnoted'))).rejects.toThrow('is no session folder')
    expect(h.srt.wrapWithSandboxArgv).toHaveBeenCalledTimes(2)
  })

  it('04 验收 3 (wiring): the signal reset reason is merged into SandboxView', async () => {
    const h = wiringFixture()
    h.runtime.start()
    await h.command()
    h.signals.forEach((listener) => listener())
    expect(h.runtime.view().posture).toEqual({ state: 'unavailable', profile: 'workspace-write' })
    expect(h.runtime.view().reasons).toEqual([{ code: 'init-failed', detail: 'reset by a signal' }])
  })

  it('04 不变量 1: only Bash, MCP stdio and the shell environment call sandbox.wrap', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const files = [
      ...readdirSync(join(root, 'packages')).flatMap((name) =>
        sources(join(root, 'packages', name, 'src')),
      ),
      ...sources(join(root, 'apps/desktop/src')),
    ]
    expect(
      files
        .filter((file) => /\bsandbox\.wrap\s*\(/.test(readFileSync(file, 'utf8')))
        .map((file) => relative(root, file))
        .toSorted(),
    ).toEqual([
      'apps/desktop/src/main/host/shell-env.ts',
      'packages/kernel/src/mcp/connection.ts',
      'packages/kernel/src/tools/builtin/bash.ts',
    ])
  })
})

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : [join(dir, entry.name)],
  )
