// State-machine permutations are sequential so a server is never doubled.
// oxlint-disable no-await-in-loop
import { afterEach, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost } from '../../src/index.js'
import { createMcpPool } from '../../src/mcp/pool.js'
import type { McpPool, McpServerRuntime, McpPoolOptions } from '../../src/mcp/pool.js'
import type { McpLoginUi } from '../../src/mcp/oauth.js'
import type { McpConnection } from '../../src/mcp/connection.js'
import * as connections from '../../src/mcp/connection.js'
import { createNodeProcess } from '../support/node-process.js'
import { startHttpFixture } from '../support/http-fixture.js'

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
function fakeConnection() {
  let exit!: () => void
  const exited = new Promise<{ code: number; signal: null }>((done) => {
    exit = () => done({ code: 1, signal: null })
  })
  const c = {
    name: 'fixture',
    client: {},
    protocolVersion: '2025-11-25',
    era: 'legacy',
    instructions: '',
    serverVersion: undefined,
    exited,
    close: vi.fn<() => Promise<void>>(async () => {}),
    listTools: vi.fn<NonNullable<McpConnection['listTools']>>(async () => tools),
    callTool: vi.fn<McpConnection['callTool']>(async () => ({ content: [] })),
  } as unknown as McpConnection
  return { c, exit }
}
function setup(initial = runtime(), real = false, start = true) {
  const host = createMemoryHost(real ? { process: createNodeProcess() } : {})
  const current = new Map([[initial.serverId, initial]])
  const onPin = vi.fn<McpPoolOptions['onPin']>(async () => {})
  const logs: string[] = []
  const onChange = vi.fn<() => void>()
  const pool = createMcpPool({
    host,
    ids: { uuid: () => crypto.randomUUID() },
    baseEnv: async () => ({ HOME: '/', PATH: '/bin', GITHUB_TOKEN: 'never-inherit' }),
    homeDir: absolutePath('/'),
    resolveCommand: async (command) => ({ ok: true, path: absolutePath(command) }),
    runtimeOf: (id) => current.get(id) ?? null,
    log: (_id, line) => logs.push(line),
    onPin,
    onIssuer: async () => {},
    onChange,
  })
  cleanup.push(() => {
    const closing = pool.close({ deadlineMs: 0 })
    host.advance(0)
    return closing
  })
  if (start) pool.apply([initial])
  return { pool, host, current, onPin, logs, onChange }
}
const phase = (pool: McpPool) => pool.status()[0]?.phase
async function connected(pool: McpPool) {
  await vi.waitFor(() => expect(phase(pool)).toBe('connected'))
}

it('first successful list pins every tool once; snapshots never fetch; consent false spawns nothing', async () => {
  const fake = fakeConnection()
  const connect = vi.spyOn(connections, 'connectStdioServer').mockResolvedValue(fake.c)
  const { pool, onPin } = setup()
  await connected(pool)
  expect(onPin).toHaveBeenCalledExactlyOnceWith('fixture', {
    tools: [{ name: 'echo', definitionHash: expect.any(String) }],
  })
  await pool.refreshTools('fixture')
  expect(onPin).toHaveBeenCalledTimes(1)
  const before = vi.mocked(fake.c.listTools).mock.calls.length
  expect(await pool.routes()[0]!.connection.listTools()).toEqual(tools)
  expect(vi.mocked(fake.c.listTools).mock.calls.length).toBe(before)
  const stopped = setup(runtime({ consented: false })).pool
  expect(phase(stopped)).toBe('stopped')
  expect(stopped.status()[0]?.stopReason).toBe('needs-consent')
  await expect(stopped.routes()[0]!.connection.callTool('echo', {})).rejects.toBeInstanceOf(
    connections.McpServerUnavailableError,
  )
  expect(connect).toHaveBeenCalledTimes(1)
})
it('03 验收 2: handshake is 120 s after a launch change and configured after a cached success', async () => {
  const connect = vi
    .spyOn(connections, 'connectStdioServer')
    .mockImplementation(async () => fakeConnection().c)
  const { pool } = setup()
  await connected(pool)
  expect(connect.mock.calls[0]?.[1].handshakeTimeoutMs).toBe(120_000)
  pool.restart('fixture')
  await connected(pool)
  expect(connect.mock.calls[1]?.[1].handshakeTimeoutMs).toBe(30_000)
  pool.apply([runtime({ launchHash: 'changed', handshakeTimeoutMs: 150_000 })])
  await connected(pool)
  expect(connect.mock.calls[2]?.[1].handshakeTimeoutMs).toBe(150_000)
})
it('03 验收 3: crash restarts after 1 s then 2 s, third stops; reset after 60 s; runtimeOf null stops', async () => {
  const started: ReturnType<typeof fakeConnection>[] = []
  const connect = vi.spyOn(connections, 'connectStdioServer').mockImplementation(async () => {
    const c = fakeConnection()
    started.push(c)
    return c.c
  })
  const { pool, host, current } = setup()
  await connected(pool)
  started[0]!.exit()
  await vi.waitFor(() => expect(phase(pool)).toBe('restarting'))
  host.advance(999)
  expect(connect).toHaveBeenCalledTimes(1)
  host.advance(1)
  await connected(pool)
  started[1]!.exit()
  await vi.waitFor(() => expect(pool.status()[0]?.restartInMs).toBe(2000))
  host.advance(1000)
  expect(connect).toHaveBeenCalledTimes(2)
  host.advance(1000)
  await connected(pool)
  started[2]!.exit()
  await vi.waitFor(() => expect(pool.status()[0]?.stopReason).toBe('crash-limit'))
  pool.restart('fixture')
  await connected(pool)
  host.advance(61_000)
  started[3]!.exit()
  await vi.waitFor(() => expect(pool.status()[0]?.restartInMs).toBe(1000))
  host.advance(1000)
  await connected(pool)
  host.advance(61_000)
  started[4]!.exit()
  await vi.waitFor(() => expect(pool.status()[0]?.restartInMs).toBe(1000))
  current.clear()
  host.advance(1000)
  expect(phase(pool)).toBe('stopped')
  expect(connect).toHaveBeenCalledTimes(5)
})
it('03 验收 29 (pool): routes never waits; tableSources waits then reports cached tools absent', async () => {
  const fake = fakeConnection()
  let next!: (c: McpConnection) => void
  vi.spyOn(connections, 'connectStdioServer')
    .mockResolvedValueOnce(fake.c)
    .mockImplementation(
      () =>
        new Promise((done) => {
          next = done
        }),
    )
  const { pool, host } = setup()
  await connected(pool)
  pool.restart('fixture')
  expect(pool.routes()).toHaveLength(1)
  const pending = pool.tableSources({ waitMs: 10_000, signal: new AbortController().signal })
  let done = false
  void pending.then(() => {
    done = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(done).toBe(false)
  host.advance(9999)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(done).toBe(false)
  host.advance(1)
  expect(await pending).toMatchObject({
    sources: [],
    absent: [{ cachedTools: ['echo'], code: 'connector-unavailable' }],
  })
  await vi.waitFor(() => expect(next).toBeTypeOf('function'))
  next(fakeConnection().c)
  await connected(pool)
})
it('03 验收 3: a call during reconnect waits one handshake timeout from arrival', async () => {
  const fake = fakeConnection()
  let next!: (c: McpConnection) => void
  vi.spyOn(connections, 'connectStdioServer')
    .mockResolvedValueOnce(fake.c)
    .mockImplementation(
      () =>
        new Promise((done) => {
          next = done
        }),
    )
  const { pool, host } = setup()
  await connected(pool)
  fake.exit()
  await vi.waitFor(() => expect(phase(pool)).toBe('restarting'))
  host.advance(1000)
  await vi.waitFor(() => expect(next).toBeTypeOf('function'))
  const pending = pool
    .routes()[0]!
    .connection.callTool('echo', {})
    .catch((e: unknown) => e)
  let done = false
  void pending.then(() => {
    done = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(done).toBe(false)
  host.advance(10_000)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(done).toBe(false)
  host.advance(19_999)
  await Promise.resolve()
  expect(done).toBe(false)
  host.advance(1)
  expect(await pending).toBeInstanceOf(connections.McpServerUnavailableError)
  next(fakeConnection().c)
  await connected(pool)
})
it('03 验收 6: missing env_keys errors and spawns nothing', async () => {
  const connect = vi.spyOn(connections, 'connectStdioServer')
  const { pool } = setup(
    runtime({
      transport: { type: 'stdio', command: '/bin/node', args: [], envs: {}, envKeys: ['SECRET'] },
    }),
  )
  await vi.waitFor(() => expect(pool.status()[0]?.error?.code).toBe('missing-secret'))
  expect(connect).not.toHaveBeenCalled()
})
it('03 验收 32: more than 1000 tools errors tools-limit', async () => {
  const fake = fakeConnection()
  vi.mocked(fake.c.listTools).mockResolvedValue(Array.from({ length: 1001 }, () => tools[0]!))
  vi.spyOn(connections, 'connectStdioServer').mockResolvedValue(fake.c)
  const { pool } = setup()
  await vi.waitFor(() => expect(pool.status()[0]?.error?.code).toBe('tools-limit'))
  expect(
    (await pool.tableSources({ waitMs: 0, signal: new AbortController().signal })).sources,
  ).toEqual([])
})
it('03 验收 9 / 03 不变量 2: real spawn uses sandbox, home cwd, allowlisted env and log redaction', async () => {
  const initial = runtime({
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [new URL('../support/fixtures/crash-server.mjs', import.meta.url).pathname],
      envs: { PLAIN_VAR: 'visible' },
      envKeys: ['SECRET_TOKEN', 'MULTI_SECRET'],
    },
  })
  const host = createMemoryHost({ process: createNodeProcess() })
  await host.secrets.set('tenant:mcp:fixture:env:SECRET_TOKEN', 'fixture-private')
  await host.secrets.set('tenant:mcp:fixture:env:MULTI_SECRET', 'first-secret\nsecond-secret')
  const wrap = vi.spyOn(host.sandbox, 'wrap')
  const log: string[] = []
  const pool = createMcpPool({
    host,
    ids: { uuid: () => 'test' },
    baseEnv: async () => ({ PATH: '/bin', GITHUB_TOKEN: 'not-inherited' }),
    homeDir: absolutePath('/'),
    resolveCommand: async (command) => ({ ok: true, path: absolutePath(command) }),
    runtimeOf: () => initial,
    log: (_id, line) => log.push(line),
    onPin: async () => {},
    onIssuer: async () => {},
    onChange: () => {},
  })
  cleanup.push(() => {
    const closing = pool.close({ deadlineMs: 0 })
    host.advance(0)
    return closing
  })
  pool.apply([initial])
  await connected(pool)
  expect(wrap).toHaveBeenCalledWith(
    expect.objectContaining({
      commandId: 'mcp:fixture',
      cwd: '/',
      profile: 'full-access',
      workspace: [],
    }),
  )
  expect(wrap.mock.calls[0]?.[0].env).not.toHaveProperty('GITHUB_TOKEN')
  expect(log.join('\n')).not.toMatch(/fixture-private|first-secret|second-secret/)
  expect(log).toContain('visible')
  expect(log.filter((line) => line === '***')).toHaveLength(3)
  await expect(pool.routes()[0]!.connection.callTool('crash', {})).rejects.toThrow(
    /closed|POSTing/i,
  )
  await vi.waitFor(() => expect(phase(pool)).toBe('restarting'))
})
it('03 验收 14: connected HTTP 429 fails only its call; connecting 429 errors without retry', async () => {
  const fixture = await startHttpFixture({ era: 'legacy' })
  cleanup.push(() => fixture.close())
  const initial = runtime({
    transport: {
      type: 'http',
      url: fixture.url,
      fetch,
      protocol: 'legacy',
      headerKeys: [],
      oauth: { ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
    },
  })
  const { pool, host } = setup(initial)
  await connected(pool)
  fixture.set({ failNext: '429' })
  await expect(pool.routes()[0]!.connection.callTool('echo', {})).rejects.toThrow(/closed|POSTing/i)
  expect(phase(pool)).toBe('connected')
  fixture.set({ failConnect: '429' })
  pool.restart('fixture')
  await vi.waitFor(() => expect(pool.status()[0]?.error?.code).toBe('rate-limited'))
  const count = fixture.requests.length
  host.advance(60_000)
  expect(fixture.requests).toHaveLength(count)
})
it('03 验收 14 (T49 read): broken stream retries tools/list, resources/read and prompts/get once with a new id; calls never resend', async () => {
  const fixture = await startHttpFixture({ era: 'legacy' })
  cleanup.push(() => fixture.close())
  const sent: { method: string; id?: string | number }[] = []
  let fail: string | null = null
  const handed = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = (await request.clone().json()) as { method: string; id?: string | number }
    sent.push(body)
    if (body.method === fail) {
      fail = null
      return new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    return fetch(request)
  }
  const { pool } = setup(
    runtime({
      transport: {
        type: 'http',
        url: fixture.url,
        fetch: handed,
        protocol: 'legacy',
        headerKeys: [],
        oauth: { ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
      },
    }),
  )
  await connected(pool)
  const proxy = pool.routes()[0]!.connection
  const before = sent.length
  fail = 'tools/list'
  await pool.refreshTools('fixture')
  fail = 'resources/read'
  expect(await proxy.readResource?.('fixture://a')).toHaveProperty('contents')
  fail = 'prompts/get'
  expect(await proxy.getPrompt?.('fixture')).toHaveProperty('messages')
  fail = 'tools/call'
  await expect(proxy.callTool('echo', {})).rejects.toThrow(/stream broke/)
  for (const method of ['tools/list', 'resources/read', 'prompts/get']) {
    const attempts = sent.slice(before).filter((r) => r.method === method)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.id).not.toBe(attempts[1]?.id)
  }
  expect(sent.slice(before).filter((r) => r.method === 'tools/call')).toHaveLength(1)
  expect(phase(pool)).toBe('connected')
})

it('03 验收 14: remote retries after 1,2,4,8,16 s then errors network; launch changes cancel pending retries', async () => {
  const fixture = await startHttpFixture({ era: 'legacy' })
  cleanup.push(() => fixture.close())
  let down = false
  let attempts = 0
  const handed = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (down) {
      attempts++
      throw new TypeError('fixture network down')
    }
    return fetch(input, init)
  }
  const initial = runtime({
    transport: {
      type: 'http',
      url: fixture.url,
      fetch: handed,
      protocol: 'legacy',
      headerKeys: [],
      oauth: { ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
    },
  })
  const { pool, host } = setup(initial)
  await connected(pool)
  down = true
  await expect(pool.routes()[0]!.connection.callTool('echo', {})).rejects.toThrow(/network down/)
  for (const delay of [1000, 2000, 4000, 8000, 16000]) {
    await vi.waitFor(() => expect(pool.status()[0]?.restartInMs).toBe(delay))
    const before = attempts
    host.advance(delay - 1)
    expect(attempts).toBe(before)
    host.advance(1)
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(before))
  }
  await vi.waitFor(() => expect(pool.status()[0]?.error?.code).toBe('network'))
  expect(attempts).toBe(6)
})
it('03 验收 39 / 33: list_changed marks added tools new and refuses a changed unsafe output before tools/call', async () => {
  const initial = runtime({
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [new URL('../support/fixtures/modern-server.mjs', import.meta.url).pathname, 'dual'],
      envs: {},
      envKeys: [],
    },
  })
  const { pool, current } = setup(initial, true)
  await connected(pool)
  const pinned = {
    ...initial,
    toolsPinned: true,
    pins: Object.fromEntries(
      pool.status()[0]!.tools!.map((t) => [t.originalName, t.definitionHash]),
    ),
  }
  current.set('fixture', pinned)
  pool.apply([pinned])
  const proxy = pool.routes()[0]!.connection
  await proxy.callTool('add-tool', {})
  await vi.waitFor(() =>
    expect(pool.status()[0]?.tools?.find((t) => t.originalName === 'added')?.review).toBe('new'),
  )
  await proxy.callTool('change-output', {})
  await vi.waitFor(() =>
    expect(pool.status()[0]?.tools?.find((t) => t.originalName === 'echo')?.review).toBe('changed'),
  )
  const call = vi.spyOn(proxy.client, 'callTool')
  await expect(proxy.callTool('echo', {})).rejects.toMatchObject({
    reason: expect.stringContaining('schema'),
  })
  expect(call).not.toHaveBeenCalled()
})
it('03 验收 32: 5 MiB tool list errors tools-limit; malformed cache is ignored and a valid launch cache uses configured handshake', async () => {
  const fake = fakeConnection()
  vi.mocked(fake.c.listTools).mockResolvedValue([
    { ...tools[0]!, description: 'x'.repeat(5 * 1024 * 1024) },
  ])
  vi.spyOn(connections, 'connectStdioServer').mockResolvedValue(fake.c)
  const { pool } = setup()
  await vi.waitFor(() => expect(pool.status()[0]?.error?.code).toBe('tools-limit'))
})
it('03 验收 29: a never-connected server contributes no cached tools; caller abort ends the table wait', async () => {
  const connect = vi
    .spyOn(connections, 'connectStdioServer')
    .mockImplementation(async (_host, _spec, signal) => {
      return new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('stop')), { once: true }),
      )
    })
  const { pool } = setup()
  await vi.waitFor(() => expect(connect).toHaveBeenCalled())
  const stop = new AbortController()
  const pending = pool.tableSources({ waitMs: 10_000, signal: stop.signal })
  stop.abort()
  expect(await pending).toMatchObject({ sources: [], absent: [{ cachedTools: [] }] })
})

it('03 验收 4: error status keeps the last 20 redacted stderr lines within 4 KiB', async () => {
  vi.spyOn(connections, 'connectStdioServer').mockImplementation(async (_host, spec) => {
    for (let i = 0; i < 30; i++)
      spec.transport?.onStderr?.(`${i}: ${'界'.repeat(200)} fixture-secret`)
    throw new Error('fixture handshake error')
  })
  const initial = runtime({
    transport: { type: 'stdio', command: '/bin/node', args: [], envs: {}, envKeys: ['SECRET'] },
  })
  const { pool, host } = setup(initial, false, false)
  await host.secrets.set('tenant:mcp:fixture:env:SECRET', 'fixture-secret')
  pool.apply([initial])
  await vi.waitFor(() => expect(pool.status()[0]?.error?.code).toBe('handshake-failed'))
  const tail = pool.status()[0]!.error!.stderrTail
  expect(tail.split('\n').length).toBeLessThanOrEqual(20)
  expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(4096)
  expect(tail).toContain('29:')
  expect(tail).not.toContain('fixture-secret')
  expect(tail).toContain('***')
})
it('03 验收 3: oversized stdout counts as a crash and closes the failed call', async () => {
  const initial = runtime({
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [new URL('../support/fixtures/crash-server.mjs', import.meta.url).pathname],
      envs: {},
      envKeys: [],
    },
  })
  const { pool, host } = setup(initial, true, false)
  Object.assign(host, {
    clock: {
      now: () => Date.now(),
      setTimeout: (fn: () => void, ms: number) => {
        const id = setTimeout(fn, ms)
        return () => clearTimeout(id)
      },
    },
  })
  pool.apply([initial])
  await connected(pool)
  const pending = pool
    .routes()[0]!
    .connection.callTool('big-line', {})
    .catch((e: unknown) => e)
  expect(await pending).toBeInstanceOf(Error)
  await vi.waitFor(() => expect(phase(pool)).toBe('restarting'))
})

it('03 验收 21: login resumes the same route after unauthorized, next call succeeds and later 403 becomes unauthorized', async () => {
  const { startFakeAuthServer } = await import('../support/http-fixture.js')
  const authServer = await startFakeAuthServer()
  cleanup.push(() => authServer.close())
  const fixture = await startHttpFixture({
    era: 'legacy',
    authUrl: authServer.url,
    requireToken: 'fixture-access-1',
  })
  cleanup.push(() => fixture.close())
  const initial = runtime({
    transport: {
      type: 'http',
      url: fixture.url,
      fetch,
      protocol: 'legacy',
      headerKeys: [],
      oauth: { ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
    },
  })
  const { pool } = setup(initial)
  const route = pool.routes()[0]!.connection
  await vi.waitFor(() => expect(phase(pool)).toBe('unauthorized'))
  await expect(route.callTool('echo', {})).rejects.toBeInstanceOf(connections.McpUnauthorizedError)
  let callback!: URLSearchParams
  const ui: McpLoginUi = {
    listen: async (port) => ({
      port,
      waitForCallback: async (state) => {
        expect(callback.get('state')).toBe(state)
        return callback
      },
      close: async () => {},
    }),
    openUrl: async (url) => {
      const response = await fetch(url, { redirect: 'manual' })
      callback = new URL(response.headers.get('location')!).searchParams
    },
  }
  const result = await pool.login('fixture', ui)
  expect(result).toEqual({ ok: true })
  expect(pool.routes()[0]!.connection).toBe(route)
  expect(await route.callTool('echo', {})).toHaveProperty('content')
  expect(phase(pool)).toBe('connected')
  const registrations = authServer.requests.filter((r) => r.path === '/register').length
  authServer.set({ refreshResult: 'invalid_client' })
  fixture.set({ failNext: '401' })
  await expect(route.callTool('echo', {})).rejects.toBeInstanceOf(connections.McpUnauthorizedError)
  expect(authServer.requests.filter((r) => r.path === '/register')).toHaveLength(registrations)
  authServer.set({ refreshResult: 'ok' })
  fixture.set({ requireToken: undefined })
  expect(await pool.login('fixture', ui)).toEqual({ ok: true })
  fixture.set({ failNext: '403-scope' })
  await expect(route.callTool('echo', {})).rejects.toBeInstanceOf(connections.McpUnauthorizedError)
  expect(phase(pool)).toBe('unauthorized')
})
it('03 不变量 11: a broken concurrent call never cancels the neighboring request', async () => {
  const fixture = await startHttpFixture({ era: 'legacy' })
  cleanup.push(() => fixture.close())
  const initial = runtime({
    transport: {
      type: 'http',
      url: fixture.url,
      fetch,
      protocol: 'legacy',
      headerKeys: [],
      oauth: { ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
    },
  })
  const { pool } = setup(initial)
  await connected(pool)
  fixture.set({ failNext: 'break-stream' })
  const proxy = pool.routes()[0]!.connection
  const failed = proxy.callTool('echo', {}).catch((e: unknown) => e)
  const neighbor = proxy.callTool('slow', { ms: 200 })
  expect(await failed).toMatchObject({ message: expect.stringContaining('stream broke') })
  expect(await neighbor).toHaveProperty('content')
  expect(fixture.requests.filter((r) => r.method === 'tools/call')).toHaveLength(2)
})

it('pin release updates review and persisted definitions without reconnecting', async () => {
  const fake = fakeConnection()
  const connect = vi.spyOn(connections, 'connectStdioServer').mockResolvedValue(fake.c)
  const initial = runtime({ toolsPinned: true, pins: { echo: 'previous' } })
  const { pool, host } = setup(initial)
  await connected(pool)
  expect(pool.status()[0]?.tools?.[0]?.review).toBe('changed')
  const hash = pool.status()[0]!.tools![0]!.definitionHash
  pool.apply([{ ...initial, pins: { echo: hash } }])
  expect(pool.status()[0]?.tools?.[0]?.review).toBe('ok')
  expect(connect).toHaveBeenCalledTimes(1)
  await vi.waitFor(async () => {
    const data = JSON.parse(
      String(
        await host.fs.readFile(absolutePath(`${host.identity.profileDir}/mcp/fixture.json`), {
          encoding: 'utf8',
        }),
      ),
    )
    expect(data.pinnedDefinitions.echo).toEqual(tools[0])
  })
})

it('an unreadable keychain env value maps to missing-secret before connecting', async () => {
  const connect = vi.spyOn(connections, 'connectStdioServer')
  const initial = runtime({
    transport: {
      type: 'stdio',
      command: '/bin/node',
      args: [],
      envs: {},
      envKeys: ['FIXTURE_SECRET'],
    },
  })
  const { pool, host } = setup(initial, false, false)
  vi.spyOn(host.secrets, 'get').mockRejectedValue(new Error('keychain unavailable'))
  pool.apply([initial])
  await vi.waitFor(() => expect(pool.status()[0]?.error?.code).toBe('missing-secret'))
  expect(connect).not.toHaveBeenCalled()
})

it('03 验收 12 (pool): static headers are read from tenant keychain accounts with lowercase names', async () => {
  const fixture = await startHttpFixture({ era: 'legacy' })
  cleanup.push(() => fixture.close())
  const initial = runtime({
    transport: {
      type: 'http',
      url: fixture.url,
      protocol: 'legacy',
      fetch,
      headerKeys: ['X-Fixture-Static'],
      oauth: { ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
    },
  })
  const { pool, host } = setup(initial, false, false)
  await host.secrets.set('tenant:mcp:fixture:header:x-fixture-static', 'fixture-static-secret')
  pool.apply([initial])
  await connected(pool)
  expect(fixture.requests.find((r) => r.method === 'initialize')?.headers['x-fixture-static']).toBe(
    'fixture-static-secret',
  )
})
