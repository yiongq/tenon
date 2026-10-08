// Consent is independent of process PATH and secret values; live hashes are checked on every call.
import { expect, it, vi } from 'vitest'
import { mcpServerSchema } from '@tenon-app/contracts'
import { mcpRuntimes, launchHash } from '../src/main/mcp/runtime.js'
import { mcpUserSetting } from '../src/main/mcp/user-setting.js'
import { createMcpConsent } from '../src/main/mcp/consent.js'
import { mcpDraft, mcpHarness } from './support/mcp-harness.js'
import type { McpServerStatus } from '@tenon-app/kernel'
const fetchFactory = () => fetch
const server = () =>
  mcpServerSchema.parse({
    ...mcpDraft(),
    enabled: true,
    toolsPinned: true,
    tools: { echo: { setting: 'always-allow', definitionHash: 'a'.repeat(64) } },
    consent: null,
    instructions: { enabled: false, pinHash: null },
  })
it('03 验收 24 (runtime) / 03 不变量 3: run consent immediately applies without a config write and disappears on restart; persistent consent requires matching launch', async () => {
  const s = server(),
    changed = vi.fn<() => void>(),
    consent = createMcpConsent(changed),
    fetchFor = fetchFactory
  expect(mcpRuntimes([s], consent, fetchFor)[0]?.consented).toBe(false)
  consent.allow(s.id, launchHash(s))
  expect(changed).toHaveBeenCalledTimes(1)
  expect(mcpRuntimes([s], consent, fetchFor)[0]?.consented).toBe(true)
  expect(mcpRuntimes([s], createMcpConsent(changed), fetchFor)[0]?.consented).toBe(false)
  s.consent = { launchHash: launchHash(s) }
  expect(mcpRuntimes([s], consent, fetchFor)[0]?.consented).toBe(true)
  s.transport = {
    ...s.transport,
    type: 'stdio',
    command: '/different',
    args: [],
    envs: {},
    env_keys: [],
  }
  expect(mcpRuntimes([s], consent, fetchFor)[0]?.consented).toBe(false)
  s.enabled = false
  expect(mcpRuntimes([s], consent, fetchFor)).toEqual([])
  const h = await mcpHarness()
  try {
    await h.mcp.store.save({
      mode: 'create',
      draft: mcpDraft(),
      secrets: { env: {}, headers: {} },
      consent: 'run',
    })
    await h.call('mcp.revoke', { id: 'notes' })
    const writes = vi.spyOn(h.host.fs, 'writeFile')
    expect(await h.call('mcp.connect', { id: 'notes', consent: 'run' })).toEqual({ ok: true })
    expect(writes).not.toHaveBeenCalled()
    expect(h.mcp.pool.status()[0]?.phase).toBe('connecting')
  } finally {
    await h.close()
  }
})
it('03 验收 36 / 38 (desktop) / 03 不变量 8: frozen, pinned and live hashes must agree; unknown live retains the pin, disabled or deleted reads connectorOff', () => {
  const s = server(),
    key = { tenantId: 'fixture', serverId: s.id, toolName: 'echo', definitionHash: 'a'.repeat(64) }
  let statuses: readonly McpServerStatus[] = []
  const setting = mcpUserSetting(
    () => [s],
    () => statuses,
  )
  expect(setting(key)).toEqual({ userSetting: 'always-allow' })
  statuses = [
    {
      serverId: s.id,
      tools: [{ originalName: 'echo', definitionHash: 'b'.repeat(64) }],
    } as unknown as McpServerStatus,
  ]
  expect(setting(key)).toEqual({ userSetting: 'ask', definitionChanged: true })
  statuses = [{ serverId: s.id, tools: [] } as unknown as McpServerStatus]
  expect(setting(key)).toEqual({ userSetting: 'ask', definitionChanged: true })
  statuses = [{ serverId: s.id, tools: null } as unknown as McpServerStatus]
  expect(setting(key)).toEqual({ userSetting: 'always-allow' })
  statuses = []
  expect(setting({ ...key, definitionHash: 'b'.repeat(64) })).toEqual({
    userSetting: 'ask',
    definitionChanged: true,
  })
  s.tools.echo!.setting = 'never'
  expect(setting(key)).toEqual({ userSetting: 'never' })
  s.enabled = false
  expect(setting(key)).toEqual({ connectorOff: true })
  expect(setting({ ...key, serverId: 'deleted' })).toEqual({ connectorOff: true })
  expect(setting({ ...key, serverId: 'builtin' })).toBeNull()
})
it('03 验收 8 (runtime): PATH resolution and secret values cannot alter launchHash; env_keys sort by code-unit; timeout defaults match the runtime', () => {
  const s = server()
  s.transport = {
    type: 'stdio',
    command: 'node',
    args: ['fixture'],
    envs: { B: '2', A: '1' },
    env_keys: ['Z', 'a'],
  }
  const hash = launchHash(s)
  s.transport.env_keys.reverse()
  expect(launchHash(s)).toBe(hash)
  s.displayName = 'renamed'
  s.callTimeoutSec = 60
  s.handshakeTimeoutSec = 30
  expect(launchHash(s)).toBe(hash)
  const runtime = mcpRuntimes(
    [s],
    createMcpConsent(() => {}),
    () => fetch,
  )[0]!
  expect(runtime).toMatchObject({
    callTimeoutMs: 60000,
    handshakeTimeoutMs: 30000,
    transport: { command: 'node', envKeys: ['a', 'Z'] },
  })
})

it('03 验收 28 / 6 / 27 (desktop): enabled consented servers connect in parallel, routes share processes, secret rotation restarts without new consent and leaves no secret in files or logs', async () => {
  const { mkdtemp, readFile, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createMemoryHost, absolutePath, keyFor } = await import('@tenon-app/kernel')
  const { DesktopFs } = await import('../src/main/host/fs.js')
  const { SystemClock } = await import('../src/main/host/clock.js')
  const { createHostProcess } = await import('../src/main/host/process.js')
  const { createDesktopMcp } = await import('../src/main/mcp/controller.js')
  const { readConfig } = await import('../src/main/host/profile.js')
  const { createSchemaWorker } = await import('../src/main/mcp/schema-worker.js')
  const root = await mkdtemp(join(tmpdir(), 'tenon-mcp-runtime-'))
  const processPort = createHostProcess(),
    spawn = vi.fn<typeof processPort.spawn>((spec, signal) => processPort.spawn(spec, signal))
  const host = Object.assign(
    createMemoryHost({ identity: { profileDir: root }, process: { spawn } }),
    { fs: new DesktopFs(), clock: new SystemClock() },
  )
  const mcp = createDesktopMcp({
    host,
    config: await readConfig(host.fs, host.identity),
    home: absolutePath('/'),
    baseEnv: async () => ({ PATH: '/bin:/usr/bin', GITHUB_TOKEN: 'must-not-inherit' }),
    uuid: () => crypto.randomUUID(),
    changed: () => {},
    schemaValidator: createSchemaWorker(),
  })
  try {
    const draft = mcpDraft()
    draft.transport = {
      ...draft.transport,
      type: 'stdio',
      command: process.execPath,
      args: [
        new URL('../../../packages/kernel/test/support/fixtures/modern-server.mjs', import.meta.url)
          .pathname,
        'dual',
        '--start-delay-ms',
        '200',
        '--log-fixture-secret',
      ],
      envs: {},
      env_keys: ['TOKEN'],
    }
    await Promise.all(
      ['one', 'two'].map((id) =>
        mcp.store.save({
          mode: 'create',
          draft: { ...draft, id },
          secrets: { env: { TOKEN: 'fake-credential-before' }, headers: {} },
          consent: 'persistent',
        }),
      ),
    )
    await vi.waitFor(() =>
      expect(mcp.pool.status().map((s) => s.phase)).toEqual(['connected', 'connected']),
    )
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(
      spawn.mock.calls.every(
        ([spec]) =>
          spec.env.TOKEN === 'fake-credential-before' && !Object.hasOwn(spec.env, 'GITHUB_TOKEN'),
      ),
    ).toBe(true)
    const route = mcp.pool.routes().find((r) => r.serverId === 'one')!
    const [a, b] = await Promise.all([
      route.connection.callTool('pid', {}),
      route.connection.callTool('pid', {}),
    ])
    expect(a).toEqual(b)
    expect(spawn).toHaveBeenCalledTimes(2)
    const before = mcp.config().mcpServers.find((s) => s.id === 'one')!.consent
    expect(
      await mcp.store.save({
        mode: 'update',
        draft: { ...draft, id: 'one' },
        secrets: { env: { TOKEN: 'fake-credential-after' }, headers: {} },
        consent: null,
      }),
    ).toEqual({ ok: true })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3))
    await vi.waitFor(() =>
      expect(mcp.pool.status().find((s) => s.serverId === 'one')?.phase).toBe('connected'),
    )
    expect(spawn.mock.calls.at(-1)?.[0].env.TOKEN).toBe('fake-credential-after')
    expect(mcp.config().mcpServers.find((s) => s.id === 'one')!.consent).toEqual(before)
    expect(mcp.needsConsent('one')).toBe(false)
    await mcp.logs.close()
    const files = [
      join(root, 'config.json'),
      ...(await readdir(join(root, 'mcp'))).map((f) => join(root, 'mcp', f)),
      ...(await readdir(join(root, 'logs'))).map((f) => join(root, 'logs', f)),
    ]
    const text = (await Promise.all(files.map((f) => readFile(f, 'utf8')))).join('\n')
    expect(text).not.toContain('fake-credential-before')
    expect(text).not.toContain('fake-credential-after')
    expect(text).toContain('fixture credential ***')
    expect(await host.secrets.get(keyFor(host.identity, 'mcp', 'one', 'env', 'TOKEN'))).toBe(
      'fake-credential-after',
    )
    const remove = vi
      .spyOn(host.secrets, 'delete')
      .mockRejectedValueOnce(new Error('fixture denied'))
    expect(await mcp.store.delete('one')).toEqual({ ok: false, code: 'keychain' })
    await vi.waitFor(() =>
      expect(mcp.pool.status().find((s) => s.serverId === 'one')?.phase).toBe('connected'),
    )
    expect(spawn).toHaveBeenCalledTimes(4)
    remove.mockRestore()
    expect(await mcp.store.delete('one')).toEqual({ ok: true })
    expect(await host.secrets.get(keyFor(host.identity, 'mcp', 'one', 'env', 'TOKEN'))).toBeNull()
  } finally {
    await mcp.close({ deadlineMs: 1000 })
    await rm(root, { recursive: true, force: true })
  }
})

it('03 验收 8 / 24: seeded persistent consent starts, unconfirmed stays stopped, PATH changes on restart, revoke stops the connected process; unrelated config writes do not reapply', async () => {
  const { mkdtemp, mkdir, symlink, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createMemoryHost, absolutePath } = await import('@tenon-app/kernel')
  const { DesktopFs } = await import('../src/main/host/fs.js')
  const { SystemClock } = await import('../src/main/host/clock.js')
  const { createHostProcess } = await import('../src/main/host/process.js')
  const { createDesktopMcp } = await import('../src/main/mcp/controller.js')
  const { readConfig, writeConfig } = await import('../src/main/host/profile.js')
  const { createSchemaWorker } = await import('../src/main/mcp/schema-worker.js')
  const root = await mkdtemp(join(tmpdir(), 'tenon-mcp-seeded-')),
    a = join(root, 'a'),
    b = join(root, 'b')
  await Promise.all([mkdir(a), mkdir(b)])
  await Promise.all([
    symlink(process.execPath, join(a, 'fixture-node')),
    symlink(process.execPath, join(b, 'fixture-node')),
  ])
  const port = createHostProcess(),
    spawn = vi.fn<typeof port.spawn>((q, s) => port.spawn(q, s))
  const host = Object.assign(
    createMemoryHost({ identity: { profileDir: root }, process: { spawn } }),
    { fs: new DesktopFs(), clock: new SystemClock() },
  )
  const s = server()
  s.id = 'confirmed'
  s.transport = {
    type: 'stdio',
    command: 'fixture-node',
    args: [
      new URL('../../../packages/kernel/test/support/fixtures/modern-server.mjs', import.meta.url)
        .pathname,
      'dual',
    ],
    envs: {},
    env_keys: [],
  }
  s.consent = { launchHash: launchHash(s) }
  const config = {
    ...(await readConfig(host.fs, host.identity)),
    mcpServers: [s, { ...s, id: 'unconfirmed', consent: null }],
  }
  await writeConfig(host.fs, host.identity, config)
  let path = a
  const mcp = createDesktopMcp({
    host,
    config,
    home: absolutePath('/'),
    baseEnv: async () => ({ PATH: path }),
    uuid: () => crypto.randomUUID(),
    changed: () => {},
    schemaValidator: createSchemaWorker(),
  })
  try {
    await vi.waitFor(() => expect(mcp.pool.status()[0]?.phase).toBe('connected'))
    expect(mcp.pool.status()[1]).toMatchObject({ phase: 'stopped', stopReason: 'needs-consent' })
    expect(mcp.needsConsent('unconfirmed')).toBe(true)
    expect(spawn.mock.calls[0]?.[0].argv[0]).toBe(join(a, 'fixture-node'))
    path = b
    mcp.pool.restart('confirmed')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(mcp.pool.status()[0]?.phase).toBe('connected'))
    expect(spawn.mock.calls[1]?.[0].argv[0]).toBe(join(b, 'fixture-node'))
    expect(mcp.needsConsent('confirmed')).toBe(false)
    const apply = vi.spyOn(mcp.pool, 'apply'),
      write = vi.spyOn(host.fs, 'writeFile')
    await writeConfig(host.fs, host.identity, { locale: 'en' })
    expect(apply).not.toHaveBeenCalled()
    expect(write.mock.calls.filter(([p]) => String(p).includes('/mcp/'))).toEqual([])
    const child = await spawn.mock.results[1]!.value
    await mcp.store.revoke('confirmed')
    await vi.waitFor(() =>
      expect(mcp.pool.status()[0]).toMatchObject({ phase: 'stopped', stopReason: 'needs-consent' }),
    )
    expect(mcp.needsConsent('confirmed')).toBe(true)
    await child.exited
    expect(() => process.kill(-child.pid, 0)).toThrow(/./)
  } finally {
    await mcp.close({ deadlineMs: 1000 })
    await rm(root, { recursive: true, force: true })
  }
})
