import { expect, it, vi } from 'vitest'
import { createMemoryHost } from '../../src/index.js'
import { createMcpTokenStore, McpKeychainError } from '../../src/mcp/token-store.js'

const tokens = (value: string) => ({
  access_token: value,
  token_type: 'Bearer',
  refresh_token: 'fixture-refresh',
})
function setup() {
  const host = createMemoryHost()
  const calls: string[] = []
  const store = createMcpTokenStore({
    secrets: host.secrets,
    identity: host.identity,
    serverId: 'fixture',
    ids: { uuid: () => crypto.randomUUID() },
    onIssuer: async () => {
      calls.push('issuer')
    },
    deleting: () => false,
    log: () => {},
  })
  return { host, calls, store }
}
it('03 验收 20 / 03 不变量 15: long tokens shard within four bounded values; issuer is recorded before writes; all keys carry tenant', async () => {
  const { host, store, calls } = setup()
  const set = vi.spyOn(host.secrets, 'set').mockImplementation(async (key, value) => {
    expect(key.startsWith('tenant:mcp:fixture:oauth:h:tokens:a:')).toBe(true)
    expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(2560)
    calls.push('write')
  })
  await store.saveTokens({ hash: 'h', url: 'https://fixture.invalid' }, tokens('x'.repeat(5000)))
  expect(set).toHaveBeenCalledTimes(3)
  expect(calls[0]).toBe('issuer')
})
it('03 验收 20: rotation writes the complete new group before deleting old; interruption leaves old complete group readable', async () => {
  const { host, store } = setup()
  await store.saveTokens({ hash: 'h', url: 'https://fixture.invalid' }, tokens('old'))
  const del = vi.spyOn(host.secrets, 'delete').mockImplementation(async () => {
    throw new Error('fixture delete fails')
  })
  await store.saveTokens({ hash: 'h', url: 'https://fixture.invalid' }, tokens('new'))
  expect(await store.tokens('h')).toEqual(tokens('new'))
  expect(del).toHaveBeenCalledTimes(4)
  del.mockRestore()
  const set = vi.spyOn(host.secrets, 'set')
  const original = host.secrets.set.bind(host.secrets)
  set.mockRestore()
  let writes = 0
  const fail = vi.spyOn(host.secrets, 'set').mockImplementation(async (key, value) => {
    if (++writes === 2) throw new Error('fixture write fails')
    await original(key, value)
  })
  await expect(
    store.saveTokens({ hash: 'h', url: 'https://fixture.invalid' }, tokens('z'.repeat(5000))),
  ).rejects.toBeInstanceOf(McpKeychainError)
  expect(await store.tokens('h')).toEqual(tokens('new'))
  fail.mockRestore()
})
it('03 验收 20: a partial group is ignored; five shards write nothing; a throwing keychain maps to keychain', async () => {
  const { host, store } = setup()
  await host.secrets.set('tenant:mcp:fixture:oauth:h:tokens:a:0', '1-fixture.2.0.e30')
  expect(await store.tokens('h')).toBeUndefined()
  const set = vi.spyOn(host.secrets, 'set')
  await expect(
    store.saveTokens({ hash: 'h', url: 'https://fixture.invalid' }, tokens('x'.repeat(10000))),
  ).rejects.toBeInstanceOf(McpKeychainError)
  expect(set).not.toHaveBeenCalled()
  vi.spyOn(host.secrets, 'get').mockRejectedValue(new Error('fixture read fails'))
  await expect(store.tokens('h')).rejects.toBeInstanceOf(McpKeychainError)
})
it('03 验收 20: concurrent saves leave one complete group; delete removes all eight shards', async () => {
  const { host, store } = setup()
  await Promise.all([
    store.saveTokens({ hash: 'h', url: 'https://fixture.invalid' }, tokens('one')),
    store.saveTokens({ hash: 'h', url: 'https://fixture.invalid' }, tokens('two')),
  ])
  expect(await store.tokens('h')).toEqual(tokens('two'))
  const shards = await Promise.all(
    ['a', 'b'].map((slot) => host.secrets.get(`tenant:mcp:fixture:oauth:h:tokens:${slot}:0`)),
  )
  expect(shards.some((shard) => shard?.startsWith('2-'))).toBe(true)
  const del = vi.spyOn(host.secrets, 'delete')
  await store.deleteTokens('h')
  expect(del).toHaveBeenCalledTimes(8)
  expect(await store.tokens('h')).toBeUndefined()
})
it('03 不变量 15: deleting refuses writes; client records contain only the declared fields', async () => {
  const { host } = setup()
  const store = createMcpTokenStore({
    secrets: host.secrets,
    identity: host.identity,
    serverId: 'fixture',
    ids: { uuid: () => 'fixture' },
    onIssuer: async () => {},
    deleting: () => true,
    log: () => {},
  })
  const set = vi.spyOn(host.secrets, 'set')
  await expect(
    store.saveTokens({ hash: 'h', url: 'https://fixture.invalid' }, tokens('never-saved')),
  ).rejects.toBeInstanceOf(McpKeychainError)
  expect(set).not.toHaveBeenCalled()
})

it('client storage filters undeclared fields and preserves issuer and client credentials', async () => {
  const { store, host } = setup()
  const set = vi.spyOn(host.secrets, 'set')
  await store.saveClient({ hash: 'h', url: 'https://fixture.invalid' }, {
    client_id: 'fixture-client',
    client_secret: 'fixture-secret',
    issuer: 'https://fixture.invalid',
    extra: 'discard',
  } as Parameters<typeof store.saveClient>[1])
  expect(JSON.parse(set.mock.calls[0]![1])).toEqual({
    client_id: 'fixture-client',
    client_secret: 'fixture-secret',
    issuer: 'https://fixture.invalid',
  })
  expect(await store.client('h')).toEqual({
    client_id: 'fixture-client',
    client_secret: 'fixture-secret',
    issuer: 'https://fixture.invalid',
  })
})
