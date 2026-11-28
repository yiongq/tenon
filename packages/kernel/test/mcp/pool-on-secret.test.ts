/**
 * `McpPoolOptions.onSecret` (docs/features/error-logs/spec.md §对 03 的增补, D19; acceptance 3's
 * kernel half): every value the pool adds to a server's redaction table is given to `onSecret` at
 * the same time — an `env_keys` value, a static header's value, and the tokens the OAuth provider
 * puts together from the keychain's shards — so that the host can keep them out of its own log.
 *
 * The pool, the OAuth provider and the token store are the real ones; the connection is the fake
 * of `pool.test.ts` (this file asks what the pool reported, not how a server answers), and the
 * keychain is the memory host's.
 *
 * `onSecret` is not on `McpPoolOptions` until segment 1 adds it, so the one `@ts-expect-error`
 * below keeps the typecheck green meanwhile: delete it when tsc reports it unused.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost } from '../../src/index.js'
import { createMcpPool } from '../../src/mcp/pool.js'
import type { McpServerRuntime } from '../../src/mcp/pool.js'
import type { McpConnection } from '../../src/mcp/connection.js'
import * as connections from '../../src/mcp/connection.js'
import { createMcpTokenStore } from '../../src/mcp/token-store.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
  vi.restoreAllMocks()
})

const tools = [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' as const } }]

function runtime(changes: Partial<McpServerRuntime> = {}): McpServerRuntime {
  return {
    serverId: 'fixture',
    launchHash: 'launch',
    consented: true,
    transport: { type: 'stdio', command: '/bin/node', args: [], envs: {}, envKeys: [] },
    handshakeTimeoutMs: 30_000,
    callTimeoutMs: 1000,
    rank: 0,
    toolsPinned: false,
    pins: {},
    instructions: { enabled: false, pinHash: null },
    ...changes,
  }
}

function fakeConnection(): McpConnection {
  return {
    name: 'fixture',
    client: {},
    protocolVersion: '2025-11-25',
    era: 'legacy',
    instructions: '',
    serverVersion: undefined,
    exited: new Promise(() => {}),
    close: vi.fn<() => Promise<void>>(async () => {}),
    listTools: vi.fn<NonNullable<McpConnection['listTools']>>(async () => tools),
    callTool: vi.fn<McpConnection['callTool']>(async () => ({ content: [] })),
  } as unknown as McpConnection
}

function start(initial: McpServerRuntime, host = createMemoryHost()) {
  const onSecret = vi.fn<(value: string) => void>()
  const pool = createMcpPool({
    host,
    ids: { uuid: () => crypto.randomUUID() },
    baseEnv: async () => ({ PATH: '/bin' }),
    homeDir: absolutePath('/'),
    resolveCommand: async (command) => ({ ok: true, path: absolutePath(command) }),
    runtimeOf: () => initial,
    log: () => {},
    onPin: async () => {},
    onIssuer: async () => {},
    onChange: () => {},
    // @ts-expect-error — `onSecret` is added to McpPoolOptions by error-logs segment 1
    onSecret,
  })
  cleanup.push(() => {
    const closing = pool.close({ deadlineMs: 0 })
    host.advance(0)
    return closing
  })
  pool.apply([initial])
  return { pool, host, onSecret }
}

const httpTransport = (
  changes: Partial<Extract<McpServerRuntime['transport'], { type: 'http' }>>,
) =>
  ({
    type: 'http',
    url: 'https://fixture.invalid/mcp',
    fetch: async () => {
      throw new Error('unexpected network request')
    },
    protocol: 'legacy',
    headerKeys: [],
    oauth: { issuers: [], ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
    ...changes,
  }) satisfies McpServerRuntime['transport']

it('error-logs 验收 3: the pool reports an env_keys value to onSecret', async () => {
  vi.spyOn(connections, 'connectStdioServer').mockResolvedValue(fakeConnection())
  const initial = runtime({
    transport: {
      type: 'stdio',
      command: '/bin/node',
      args: [],
      envs: {},
      envKeys: ['SECRET_A'],
    },
  })
  const host = createMemoryHost()
  await host.secrets.set('tenant:mcp:fixture:env:SECRET_A', 'env-key-value-0001')
  const { pool, onSecret } = start(initial, host)
  await vi.waitFor(() => expect(pool.status()[0]?.phase).toBe('connected'))
  expect(onSecret).toHaveBeenCalledWith('env-key-value-0001')
})

it('error-logs 验收 3: the pool reports a static header value to onSecret', async () => {
  vi.spyOn(connections, 'connectHttpServer').mockResolvedValue(fakeConnection())
  const initial = runtime({ transport: httpTransport({ headerKeys: ['X-Fixture-Static'] }) })
  const host = createMemoryHost()
  await host.secrets.set('tenant:mcp:fixture:header:x-fixture-static', 'header-value-0002')
  const { pool, onSecret } = start(initial, host)
  await vi.waitFor(() => expect(pool.status()[0]?.phase).toBe('connected'))
  expect(onSecret).toHaveBeenCalledWith('header-value-0002')
})

it('error-logs 验收 3: the pool reports the access and refresh tokens it puts together from the keychain shards', async () => {
  vi.spyOn(connections, 'connectHttpServer').mockResolvedValue(fakeConnection())
  const host = createMemoryHost()
  const issuer = { hash: '00000000000000a1', url: 'https://issuer.example.test' }
  const store = createMcpTokenStore({
    secrets: host.secrets,
    identity: host.identity,
    serverId: 'fixture',
    ids: { uuid: () => crypto.randomUUID() },
    onIssuer: async () => {},
    deleting: () => false,
    log: () => {},
  })
  await store.saveTokens(issuer, {
    access_token: 'access-token-value-0003',
    refresh_token: 'refresh-token-value-0004',
    token_type: 'Bearer',
  })
  const initial = runtime({
    transport: httpTransport({
      oauth: {
        issuers: [issuer.hash],
        ownClient: null,
        clientMetadataUrl: null,
        dcrRedirectPort: 53280,
      },
    }),
  })
  const { onSecret } = start(initial, host)
  await vi.waitFor(() => {
    expect(onSecret).toHaveBeenCalledWith('access-token-value-0003')
    expect(onSecret).toHaveBeenCalledWith('refresh-token-value-0004')
  })
})
