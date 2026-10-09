// Mutations and failure injection are sequential under one profile lock.
// oxlint-disable no-await-in-loop
import { expect, it, vi } from 'vitest'
import { createMemoryHost, keyFor, absolutePath } from '@tenon-app/kernel'
import type { McpPool } from '@tenon-app/kernel'
import type { McpDraft, McpServer } from '@tenon-app/contracts'
import { createMcpStore, mcpAccounts } from '../src/main/mcp/store.js'
import { createMcpConsent } from '../src/main/mcp/consent.js'
import { launchHash } from '../src/main/mcp/runtime.js'
import { mcpHarness } from './support/mcp-harness.js'
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
  const retire = vi.fn<() => Promise<void>>(async () => {})
  const log = vi.fn<(line: string) => void>()
  const pool = { status: () => [], restart, retire } as unknown as McpPool
  const store = createMcpStore({
    host,
    apply,
    pool: () => pool,
    consent: createMcpConsent(() => {}),
    log,
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
    retire,
    log,
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
  const reasons: string[] = []
  await readConfig(h.host.fs, h.host.identity, (line) => reasons.push(line))
  expect(reasons).toEqual([
    '[config] mcpServers[1] dropped: invalid-schema',
    '[config] mcpServers[2] dropped: duplicate-id',
  ])
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
  for (const name of [
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'DYLD_FRAMEWORK_PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'DYLD_FALLBACK_LIBRARY_PATH',
  ]) {
    for (const secret of [false, true]) {
      const h = setup()
      const d = draft()
      d.transport = {
        type: 'stdio',
        command: '/bin/node',
        args: [],
        envs: secret ? {} : { [name.toLowerCase()]: 'fixture' },
        env_keys: secret ? [name.toLowerCase()] : [],
      }
      const set = vi.spyOn(h.host.secrets, 'set')
      expect(await h.save(d)).toEqual({ ok: false, code: 'blocked-env' })
      expect((await h.config()).mcpServers).toEqual([])
      expect(set).not.toHaveBeenCalled()
    }
  }
})
it('03 不变量 4: a launch change resets always-allow in the same config write; secret values never enter launchHash', async () => {
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
  h.apply.mockClear()
  const deleted: string[] = []
  const remove = vi.spyOn(h.host.secrets, 'delete').mockImplementation(async (account) => {
    expect(h.apply).not.toHaveBeenCalled()
    expect(h.retire).toHaveBeenCalledWith('notes')
    expect(h.store.isDeleting('notes')).toBe(true)
    deleted.push(account)
    throw new Error('fixture refused')
  })
  expect(await h.store.delete('notes')).toEqual({ ok: false, code: 'keychain' })
  expect(h.apply.mock.calls[0]?.[0]).toEqual(before.mcpServers)
  expect(await h.config()).toEqual(before)
  expect(h.apply).toHaveBeenLastCalledWith(before.mcpServers)
  h.apply.mockClear()
  remove.mockImplementation(async (account) => {
    expect(h.apply).not.toHaveBeenCalled()
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
  const writes = vi.spyOn(h.host.secrets, 'set')
  expect(await h.save(d, { env: { TOKEN: '界'.repeat(854) }, headers: {} })).toEqual({
    ok: false,
    code: 'secret-too-long',
  })
  expect(writes).not.toHaveBeenCalled()
  writes.mockRejectedValue(new Error('fixture keychain failed'))
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
  expect(JSON.stringify(h.log.mock.calls)).not.toContain('fixture-secret')
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

it('03 验收 52 / 03 不变量 16: ninth issuer deletes oldest accounts before config, rolls back failure, and remaining accounts are deleted with server', async () => {
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
      { hash: String(i).padStart(16, '0'), url: 'https://issuer.example/' + i },
      'client',
    )
  const before = await h.config(),
    accounts = mcpAccounts(before.mcpServers[0]!, h.host)
  for (const account of accounts) await h.host.secrets.set(account, 'fixture')
  const ninth = { hash: 'f'.repeat(16), url: 'https://ninth.example' }
  const original = h.host.secrets.delete
  const remove = vi
    .spyOn(h.host.secrets, 'delete')
    .mockImplementationOnce(original)
    .mockRejectedValueOnce(new Error('denied'))
  expect(await h.store.recordIssuer('notes', ninth, 'client')).toEqual({
    ok: false,
    code: 'keychain',
  })
  expect(await h.config()).toEqual(before)
  expect(await Promise.all(accounts.map((k) => h.host.secrets.get(k)))).toEqual(
    accounts.map(() => 'fixture'),
  )
  remove.mockRestore()
  const deleted = vi.spyOn(h.host.secrets, 'delete')
  const unwatch = watchConfig(h.host.identity, () => {
    expect(deleted.mock.calls.map(([k]) => k)).toEqual(accounts.slice(0, 9))
  })
  expect(await h.store.recordIssuer('notes', ninth, 'client')).toEqual({ ok: true })
  expect(deleted.mock.calls.map(([k]) => k)).toEqual(accounts.slice(0, 9))
  unwatch()
  const next = (await h.config()).mcpServers[0]!
  expect(next.transport.type === 'http' && next.transport.oauth.issuers).toEqual([
    ...Array.from({ length: 7 }, (_, i) => String(i + 1).padStart(16, '0')),
    ninth.hash,
  ])
  const expected = [
    ...Array.from({ length: 7 }, (_, i) => String(i + 1).padStart(16, '0')),
    ninth.hash,
    // oxlint-disable-next-line oxc/no-map-spread -- independent expected issuer/account expansion
  ].flatMap((hash) => [
    keyFor(h.host.identity, 'mcp', 'notes', 'oauth', hash, 'client'),
    ...['a', 'b'].flatMap((slot) =>
      Array.from({ length: 4 }, (_, i) =>
        keyFor(h.host.identity, 'mcp', 'notes', 'oauth', hash, 'tokens', slot, String(i)),
      ),
    ),
  ])
  for (const account of expected) await h.host.secrets.set(account, 'fixture-final')
  expect(await h.store.delete('notes')).toEqual({ ok: true })
  expect(await Promise.all(expected.map((k) => h.host.secrets.get(k)))).toEqual(
    Array(72).fill(null),
  )
  expect(await Promise.all(accounts.map((k) => h.host.secrets.get(k)))).toEqual(
    accounts.map(() => null),
  )
})

it('03 验收 27: exact byte limit, required secrets, removed accounts and valid reorder are enforced', async () => {
  const h = setup(),
    d = draft()
  d.transport = { type: 'stdio', command: '/bin/node', args: [], envs: {}, env_keys: ['TOKEN'] }
  const set = vi.spyOn(h.host.secrets, 'set')
  expect(await h.save(d)).toEqual({ ok: false, code: 'secret-required' })
  expect(await h.save(d, { env: { TOKEN: 'x'.repeat(2561) }, headers: {} })).toEqual({
    ok: false,
    code: 'secret-too-long',
  })
  expect(set).not.toHaveBeenCalled()
  expect(await h.save(d, { env: { TOKEN: 'x'.repeat(2560) }, headers: {} })).toEqual({ ok: true })
  const hash = (await h.config()).mcpServers[0]?.consent?.launchHash
  await h.save(d, { env: { TOKEN: 'different-secret' }, headers: {} }, 'update')
  expect((await h.config()).mcpServers[0]?.consent?.launchHash).toBe(hash)
  await h.save(
    { ...d, transport: { ...d.transport, env_keys: [] } },
    { env: {}, headers: {} },
    'update',
  )
  expect(
    await h.host.secrets.get(keyFor(h.host.identity, 'mcp', 'notes', 'env', 'TOKEN')),
  ).toBeNull()
  await h.save(draft('two'))
  const before = await h.config()
  for (const ids of [['notes'], ['notes', 'notes'], ['notes', 'unknown']])
    expect(await h.store.reorder(ids)).toEqual({ ok: false, code: 'invalid-id' })
  expect(await h.config()).toEqual(before)
  expect(await h.store.reorder(['two', 'notes'])).toEqual({ ok: true })
  expect((await h.config()).mcpServers.map((s) => s.id)).toEqual(['two', 'notes'])
  expect(await h.store.setEnabled('notes', false)).toEqual({ ok: true })
  expect((await h.config()).mcpServers.find((s) => s.id === 'notes')?.enabled).toBe(false)
})
it('03 验收 52 / 读法 59: issuer ordering is recency and header or own-client removal restarts once', async () => {
  const h = setup(),
    d = draft()
  d.transport = {
    type: 'http',
    url: 'https://mcp.example/',
    header_keys: ['x-token'],
    protocol: 'auto',
    oauth: { ownClient: { clientId: 'own', redirectPort: 53280, hasSecret: false } },
  }
  await h.save(d, { env: {}, headers: { 'x-token': 'fake' } })
  const a = { hash: 'a'.repeat(16), url: 'https://a.example' },
    b = { hash: 'b'.repeat(16), url: 'https://b.example' }
  await h.store.recordIssuer('notes', a, 'client')
  await h.store.recordIssuer('notes', b, 'client')
  await h.store.recordIssuer('notes', a, 'client')
  const t = (await h.config()).mcpServers[0]!.transport
  expect(t.type === 'http' && t.oauth.issuers).toEqual([b.hash, a.hash])
  h.restart.mockClear()
  await h.save(
    { ...d, transport: { ...d.transport, header_keys: [] } },
    { env: {}, headers: {} },
    'update',
  )
  expect(h.restart).toHaveBeenCalledExactlyOnceWith('notes')
  h.restart.mockClear()
  await h.save(
    { ...d, transport: { ...d.transport, header_keys: [], oauth: { ownClient: null } } },
    { env: {}, headers: {} },
    'update',
  )
  expect(h.restart).toHaveBeenCalledExactlyOnceWith('notes')
})

it('03 不变量 16: retirement drains an already-started token shard write before deleting accounts, and blocked issuer callbacks cannot deadlock the config lock', async () => {
  const { createMcpTokenStore } = await import('../../../packages/kernel/src/mcp/token-store.js')
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
  const issuer = { hash: 'a'.repeat(16), url: 'https://issuer.example' }
  const tokens = createMcpTokenStore({
    identity: h.host.identity,
    secrets: h.host.secrets,
    serverId: 'notes',
    ids: { uuid: () => crypto.randomUUID() },
    deleting: () => h.store.isDeleting('notes'),
    onIssuer: async (i, k) => {
      if (!(await h.store.recordIssuer('notes', i, k)).ok) throw new Error('retired')
    },
    log: () => {},
  })
  h.retire.mockImplementation(() => tokens.retire())
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    original = h.host.secrets.set.bind(h.host.secrets)
  vi.spyOn(h.host.secrets, 'set').mockImplementationOnce(async (k, v) => {
    entered.resolve()
    await release.promise
    await original(k, v)
  })
  const writing = tokens.saveTokens(issuer, { access_token: 'fixture', token_type: 'Bearer' })
  await entered.promise
  const remove = vi.spyOn(h.host.secrets, 'delete')
  const deletion = h.store.delete('notes')
  await vi.waitFor(() => expect(h.retire).toHaveBeenCalled())
  expect(remove).not.toHaveBeenCalled()
  release.resolve()
  await writing
  expect(await deletion).toEqual({ ok: true })
  expect(await tokens.tokens(issuer.hash)).toBeUndefined()
  await expect(tokens.saveClient(issuer, { client_id: 'late' })).rejects.toThrow('keychain')
})

it('03 不变量 16: deletion completes while an issuer callback awaits the config lock; the late client cannot write', async () => {
  const { createMcpTokenStore } = await import('../../../packages/kernel/src/mcp/token-store.js')
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
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const tokens = createMcpTokenStore({
    identity: h.host.identity,
    secrets: h.host.secrets,
    serverId: 'notes',
    ids: { uuid: () => crypto.randomUUID() },
    deleting: () => h.store.isDeleting('notes'),
    onIssuer: async (i, k) => {
      entered.resolve()
      await release.promise
      if (!(await h.store.recordIssuer('notes', i, k)).ok) throw new Error('retired')
    },
    log: () => {},
  })
  h.retire.mockImplementation(() => tokens.retire())
  const set = vi.spyOn(h.host.secrets, 'set')
  const refused = tokens
    .saveClient({ hash: 'a'.repeat(16), url: 'https://issuer.example' }, { client_id: 'late' })
    .catch((e) => e)
  await entered.promise
  expect(await h.store.delete('notes')).toEqual({ ok: true })
  release.resolve()
  expect(await refused).toBeInstanceOf(Error)
  expect(set).not.toHaveBeenCalled()
})

it.each(['command-not-found', 'windows-unsupported'] as const)(
  '03 验收 8: saving succeeds when the pool reports %s',
  async (code) => {
    const h = setup()
    await h.save()
    h.pool.status = () =>
      [
        { serverId: 'notes', phase: 'error', error: { code, stderrTail: '' } },
      ] as unknown as ReturnType<McpPool['status']>
    const next = { ...draft(), displayName: 'Saved despite command error' }
    expect(await h.save(next, { env: {}, headers: {} }, 'update')).toEqual({ ok: true })
    expect((await h.config()).mcpServers[0]?.displayName).toBe(next.displayName)
    expect(h.pool.status()[0]?.error?.code).toBe(code)
  },
)
it.each([false, true])(
  '03 验收 26 / 53: the stopped row remains listed throughout keychain deletion, failure=%s',
  async (fail) => {
    const h = await mcpHarness()
    const release = Promise.withResolvers<void>()
    let pending: ReturnType<typeof h.mcp.store.delete> | undefined
    try {
      const d = draft()
      d.transport = {
        type: 'stdio',
        command: '/missing/node',
        args: [],
        envs: {},
        env_keys: ['TOKEN'],
      }
      await h.mcp.store.save({
        mode: 'create',
        draft: d,
        secrets: { env: { TOKEN: 'fixture' }, headers: {} },
        consent: 'persistent',
      })
      const entered = Promise.withResolvers<void>()
      const remove = h.host.secrets.delete.bind(h.host.secrets)
      vi.spyOn(h.host.secrets, 'delete').mockImplementation(async (account) => {
        entered.resolve()
        await release.promise
        if (fail) throw new Error('fixture denied')
        await remove(account)
      })
      const apply = vi.spyOn(h.mcp.pool, 'apply')
      pending = h.mcp.store.delete('notes')
      await entered.promise
      expect(apply).not.toHaveBeenCalled()
      const during = await h.call('mcp.list', {})
      expect(during.servers).toHaveLength(1)
      expect(during.servers[0]?.status.phase).toBe('stopped')
      release.resolve()
      expect(await pending).toEqual(fail ? { ok: false, code: 'keychain' } : { ok: true })
      expect((await h.call('mcp.list', {})).servers.map((s) => s.id)).toEqual(fail ? ['notes'] : [])
      expect(h.mcp.store.isDeleting('notes')).toBe(false)
    } finally {
      release.resolve()
      await pending?.catch(() => {})
      await h.close()
    }
  },
)
it.each(['retire', 'config'] as const)(
  '03 验收 26 / 53: %s failure preserves the row and reapplies the snapshot',
  async (step) => {
    const h = setup()
    await h.save()
    const before = await h.config()
    if (step === 'retire') h.retire.mockRejectedValueOnce(new Error('fixture failure'))
    else vi.spyOn(h.host.fs, 'writeFile').mockRejectedValueOnce(new Error('fixture failure'))
    h.apply.mockClear()
    await expect(h.store.delete('notes')).rejects.toThrow('fixture failure')
    expect(await h.config()).toEqual(before)
    expect(h.apply).toHaveBeenCalledExactlyOnceWith(before.mcpServers)
    expect(h.store.isDeleting('notes')).toBe(false)
  },
)
