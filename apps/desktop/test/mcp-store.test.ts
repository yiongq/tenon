// Mutations and failure injection are sequential under one profile lock.
// oxlint-disable no-await-in-loop
import { expect, it, vi } from 'vitest'
import { createMemoryHost, keyFor, absolutePath } from '@tenon-app/kernel'
import type { McpPool } from '@tenon-app/kernel'
import type { McpDraft, McpServer } from '@tenon-app/contracts'
import { createMcpStore, mcpAccounts } from '../src/main/mcp/store.js'
import { createMcpConsent } from '../src/main/mcp/consent.js'
import { launchHash } from '../src/main/mcp/runtime.js'
import { configPath, readConfig, watchConfig } from '../src/main/host/profile.js'
const draft = (id = 'notes'): McpDraft => ({
  id,
  displayName: id,
  source: 'manual',
  transport: { type: 'stdio', command: '/bin/node', args: [], envs: {}, env_keys: [] },
  handshakeTimeoutSec: null,
  callTimeoutSec: null,
  instructions: { enabled: false },
})
function setup() {
  const host = createMemoryHost()
  void host.fs.mkdirp(absolutePath(host.identity.profileDir))
  const apply = vi.fn<(servers: readonly McpServer[]) => void>()
  const restart = vi.fn<() => void>()
  const pool = { status: () => [], restart } as unknown as McpPool
  const store = createMcpStore({
    host,
    apply,
    pool: () => pool,
    consent: createMcpConsent(() => {}),
    log: () => {},
  })
  const save = (
    d = draft(),
    secrets = { env: {}, headers: {} },
    mode: 'create' | 'update' = 'create',
  ) => store.save({ mode, draft: d, secrets, consent: 'persistent' })
  return {
    host,
    pool,
    store,
    apply,
    restart,
    save,
    config: () => readConfig(host.fs, host.identity),
  }
}
it('03 验收 22: isolated invalid entries and duplicate ids keep only the first valid row', async () => {
  const h = setup()
  await h.save()
  const config = await h.config()
  await h.host.fs.writeFile(
    configPath(h.host.identity),
    JSON.stringify({
      ...config,
      mcpServers: [
        config.mcpServers[0],
        { id: 'BAD' },
        { ...config.mcpServers[0], displayName: 'duplicate' },
        { ...config.mcpServers[0], id: 'other' },
      ],
    }),
  )
  expect((await h.config()).mcpServers.map((s) => [s.id, s.displayName])).toEqual([
    ['notes', 'notes'],
    ['other', 'notes'],
  ])
})
it('03 验收 22 / 03 不变量 16: concurrent stores share the config lock and atomic replacement', async () => {
  const h = setup()
  const replaced: string[] = []
  Object.assign(h.host.fs, {
    replaceFile: async (path: ReturnType<typeof absolutePath>, text: string) => {
      replaced.push(text)
      await h.host.fs.writeFile(path, text)
    },
  })
  await Promise.all([h.save(draft('first')), h.save(draft('second'))])
  expect((await h.config()).mcpServers.map((s) => s.id)).toEqual(['first', 'second'])
  expect(replaced).toHaveLength(2)
})
it('03 验收 7 (store): injection env names in either collection are refused in every case without writes', async () => {
  for (const secret of [false, true]) {
    const h = setup()
    const d = draft()
    d.transport = {
      type: 'stdio',
      command: '/bin/node',
      args: [],
      envs: secret ? {} : { dyld_insert_libraries: 'fixture' },
      env_keys: secret ? ['ld_preload'] : [],
    }
    const set = vi.spyOn(h.host.secrets, 'set')
    expect(await h.save(d)).toEqual({ ok: false, code: 'blocked-env' })
    expect((await h.config()).mcpServers).toEqual([])
    expect(set).not.toHaveBeenCalled()
  }
})
it('a launch change resets always-allow in the same config write; secret values never enter launchHash', async () => {
  const h = setup()
  await h.save()
  await h.store.pin('notes', [{ name: 'echo', definitionHash: 'a'.repeat(64) }])
  const first = (await h.config()).mcpServers[0]!
  await h.host.fs.writeFile(
    configPath(h.host.identity),
    JSON.stringify({
      ...(await h.config()),
      mcpServers: [
        { ...first, tools: { echo: { setting: 'always-allow', definitionHash: 'a'.repeat(64) } } },
      ],
    }),
  )
  const d = draft()
  d.transport = {
    ...(d.transport as Extract<McpDraft['transport'], { type: 'stdio' }>),
    args: ['changed'],
  }
  await h.save(d, { env: {}, headers: {} }, 'update')
  const next = (await h.config()).mcpServers[0]!
  expect(next.tools.echo?.setting).toBe('ask')
  expect(next.consent?.launchHash).toBe(launchHash(next))
  expect(next.consent?.launchHash).not.toBe(launchHash(first))
})
it('03 验收 26 / 03 不变量 16: deletion retires the pool before keychain, failure restores unchanged config, success deletes every declared account', async () => {
  const h = setup()
  const d = draft()
  d.transport = {
    type: 'http',
    url: 'https://mcp.example/mcp',
    protocol: 'auto',
    header_keys: ['X-Token'],
    oauth: { ownClient: { clientId: 'own', hasSecret: true, redirectPort: 53280 } },
  }
  await h.save(d, {
    env: {},
    headers: { 'X-Token': 'fixture-header' },
    ownClientSecret: 'fixture-client',
  } as never)
  for (const hash of ['a'.repeat(16), 'b'.repeat(16)])
    await h.store.recordIssuer('notes', { hash, url: 'https://issuer.example' }, 'tokens')
  const before = await h.config()
  const accounts = mcpAccounts(before.mcpServers[0]!, h.host)
  const deleted: string[] = []
  const remove = vi.spyOn(h.host.secrets, 'delete').mockImplementation(async (account) => {
    expect(h.apply).toHaveBeenCalledWith([])
    expect(h.store.isDeleting('notes')).toBe(true)
    deleted.push(account)
    throw new Error('fixture refused')
  })
  expect(await h.store.delete('notes')).toEqual({ ok: false, code: 'keychain' })
  expect(h.apply.mock.calls[0]?.[0]).toEqual([])
  expect(await h.config()).toEqual(before)
  expect(h.apply).toHaveBeenLastCalledWith(before.mcpServers)
  remove.mockImplementation(async (account) => {
    expect(h.store.isDeleting('notes')).toBe(true)
    deleted.push(account)
  })
  expect(await h.store.delete('notes')).toEqual({ ok: true })
  expect(new Set(deleted)).toEqual(new Set(accounts))
  expect(accounts).toHaveLength(20)
  expect((await h.config()).mcpServers).toEqual([])
})
it('recordIssuer persists order and first own-client issuer before the first token write', async () => {
  const h = setup()
  const d = draft()
  d.transport = {
    type: 'http',
    url: 'https://mcp.example',
    protocol: 'auto',
    header_keys: [],
    oauth: { ownClient: { clientId: 'own', hasSecret: false, redirectPort: 53280 } },
  }
  await h.save(d)
  const order: string[] = []
  const unwatch = watchConfig(h.host.identity, (config) => {
    if (config.mcpServers[0]?.transport.type === 'http') order.push('config')
  })
  try {
    await h.store.recordIssuer(
      'notes',
      { hash: 'a'.repeat(16), url: 'https://issuer.example' },
      'tokens',
    )
    await h.host.secrets.set(
      keyFor(h.host.identity, 'mcp', 'notes', 'oauth', 'a'.repeat(16), 'tokens', 'a', '0'),
      'fixture',
    )
    order.push('tokens')
    const t = (await h.config()).mcpServers[0]!.transport
    expect(t.type === 'http' && t.oauth.ownClient?.issuer).toBe('https://issuer.example')
    expect(order).toEqual(['config', 'tokens'])
  } finally {
    unwatch()
  }
})
it('03 验收 27 (store): keychain failure or a secret over 2560 UTF-8 bytes writes no config', async () => {
  const h = setup()
  const d = draft()
  d.transport = { type: 'stdio', command: '/bin/node', args: [], envs: {}, env_keys: ['TOKEN'] }
  expect(await h.save(d, { env: { TOKEN: '界'.repeat(854) }, headers: {} })).toEqual({
    ok: false,
    code: 'secret-too-long',
  })
  vi.spyOn(h.host.secrets, 'set').mockRejectedValue(new Error('fixture keychain failed'))
  expect(await h.save(d, { env: { TOKEN: 'fixture' }, headers: {} })).toEqual({
    ok: false,
    code: 'keychain',
  })
  expect((await h.config()).mcpServers).toEqual([])
})
it('a config write failure rolls back newly declared secrets without logging their values', async () => {
  const h = setup()
  const d = draft()
  d.transport = { type: 'stdio', command: '/bin/node', args: [], envs: {}, env_keys: ['TOKEN'] }
  vi.spyOn(h.host.fs, 'writeFile').mockRejectedValueOnce(new Error('fixture disk failed'))
  await expect(h.save(d, { env: { TOKEN: 'fixture-secret' }, headers: {} })).rejects.toThrow(
    'fixture disk failed',
  )
  expect(
    await h.host.secrets.get(keyFor(h.host.identity, 'mcp', 'notes', 'env', 'TOKEN')),
  ).toBeNull()
})

it('a failed secret read preserves existing credentials and performs no rollback writes', async () => {
  const h = setup(),
    d = draft()
  d.transport = { type: 'stdio', command: '/bin/node', args: [], envs: {}, env_keys: ['TOKEN'] }
  const key = keyFor(h.host.identity, 'mcp', 'notes', 'env', 'TOKEN')
  await h.host.secrets.set(key, 'old-fixture')
  const get = vi.spyOn(h.host.secrets, 'get').mockRejectedValueOnce(new Error('fixture denied'))
  const remove = vi.spyOn(h.host.secrets, 'delete'),
    set = vi.spyOn(h.host.secrets, 'set')
  expect(await h.save(d, { env: { TOKEN: 'new-fixture' }, headers: {} })).toEqual({
    ok: false,
    code: 'keychain',
  })
  expect(remove).not.toHaveBeenCalled()
  expect(set).not.toHaveBeenCalled()
  get.mockRestore()
  expect(await h.host.secrets.get(key)).toBe('old-fixture')
})

it('03 验收 26 (runtime): in-flight refresh and DCR cannot write after deletion retires the server', async () => {
  const { createMcpTokenStore } = await import('../../../packages/kernel/src/mcp/token-store.js')
  const h = setup(),
    d = draft()
  d.transport = {
    type: 'http',
    url: 'https://mcp.example',
    protocol: 'auto',
    header_keys: ['x-fixture'],
    oauth: { ownClient: null },
  }
  await h.save(d, { env: {}, headers: { 'x-fixture': 'fixture-secret' } })
  const read = Promise.withResolvers<string | null>(),
    remove = Promise.withResolvers<void>()
  const get = vi.spyOn(h.host.secrets, 'get').mockImplementationOnce(() => read.promise)
  const deleting = vi.spyOn(h.host.secrets, 'delete').mockImplementationOnce(() => remove.promise)
  const set = vi.spyOn(h.host.secrets, 'set')
  const tokens = createMcpTokenStore({
    identity: h.host.identity,
    secrets: h.host.secrets,
    serverId: 'notes',
    ids: { uuid: () => crypto.randomUUID() },
    deleting: () => h.store.isDeleting('notes'),
    onIssuer: async (issuer, kind) => {
      if (!(await h.store.recordIssuer('notes', issuer, kind)).ok) throw new Error('retired')
    },
    log: () => {},
  })
  const refresh = tokens.saveTokens(
    { hash: 'a'.repeat(16), url: 'https://issuer.example' },
    { access_token: 'fake-access', token_type: 'Bearer' },
  )
  const refused = refresh.catch((e) => e)
  const deletion = h.store.delete('notes')
  await vi.waitFor(() => expect(h.store.isDeleting('notes')).toBe(true))
  read.resolve(null)
  await expect(refused).resolves.toBeInstanceOf(Error)
  await expect(
    tokens.saveClient(
      { hash: 'a'.repeat(16), url: 'https://issuer.example' },
      { client_id: 'fake-client' },
    ),
  ).rejects.toThrow(/keychain/i)
  expect(set).not.toHaveBeenCalled()
  remove.resolve()
  expect(await deletion).toEqual({ ok: true })
  expect(
    await h.store.recordIssuer(
      'notes',
      { hash: 'a'.repeat(16), url: 'https://issuer.example' },
      'tokens',
    ),
  ).toEqual({ ok: false, code: 'not-found' })
  get.mockRestore()
  deleting.mockRestore()
})

it('config failure restores credentials before reapplying the previous run consent', async () => {
  const host = createMemoryHost()
  await host.fs.mkdirp(absolutePath(host.identity.profileDir))
  const d = draft()
  d.transport = { type: 'stdio', command: '/bin/node', args: [], envs: {}, env_keys: ['TOKEN'] }
  const originalHash = launchHash({ transport: d.transport }),
    key = keyFor(host.identity, 'mcp', 'notes', 'env', 'TOKEN'),
    seen: Promise<string | null>[] = []
  let ready = false
  const consent = createMcpConsent(() => {
    if (ready && consent.matches('notes', originalHash)) seen.push(host.secrets.get(key))
  })
  const store = createMcpStore({
    host,
    consent,
    pool: () => ({ restart: () => {} }) as unknown as McpPool,
    apply: () => {},
    log: () => {},
  })
  await store.save({
    mode: 'create',
    draft: d,
    consent: 'run',
    secrets: { env: { TOKEN: 'fixture-original' }, headers: {} },
  })
  ready = true
  vi.spyOn(host.fs, 'writeFile').mockRejectedValueOnce(new Error('fixture disk refused'))
  await expect(
    store.save({
      mode: 'update',
      draft: { ...d, transport: { ...d.transport, args: ['new-launch'] } },
      consent: 'run',
      secrets: { env: { TOKEN: 'fixture-new' }, headers: {} },
    }),
  ).rejects.toThrow('fixture disk refused')
  expect(await Promise.all(seen)).toEqual(['fixture-original'])
  expect(consent.matches('notes', originalHash)).toBe(true)
})

it('03 不变量 16: the issuer cap never silently forgets declared keychain accounts', async () => {
  const h = setup(),
    d = draft()
  d.transport = {
    type: 'http',
    url: 'https://mcp.example',
    protocol: 'auto',
    header_keys: [],
    oauth: { ownClient: null },
  }
  await h.save(d)
  for (let i = 0; i < 8; i++)
    await h.store.recordIssuer(
      'notes',
      { hash: i.toString(16).padStart(16, '0'), url: 'https://issuer.example/' + i },
      'client',
    )
  const before = await h.config()
  await expect(
    h.store.recordIssuer('notes', { hash: 'f'.repeat(16), url: 'https://ninth.example' }, 'client'),
  ).rejects.toBeInstanceOf(Error)
  expect(await h.config()).toEqual(before)
  expect(mcpAccounts(before.mcpServers[0]!, h.host)).toHaveLength(72)
})
