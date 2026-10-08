// State-machine permutations are sequential so a server is never doubled.
// oxlint-disable no-await-in-loop
import { afterEach, expect, it, vi } from 'vitest'
import type { ChildHandle } from '../../src/index.js'
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
      oauth: { issuers: [], ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
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
        oauth: { issuers: [], ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
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

it.each(['legacy', 'auto'] as const)(
  '03 验收 14: %s remote retries after 1,2,4,8,16 s then errors network',
  async (protocol) => {
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
        protocol,
        headerKeys: [],
        oauth: { issuers: [], ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
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
  },
)
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
      oauth: { issuers: [], ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
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
it('03 验收 14: a broken concurrent call never cancels the neighboring request', async () => {
  const fixture = await startHttpFixture({ era: 'legacy' })
  cleanup.push(() => fixture.close())
  const initial = runtime({
    transport: {
      type: 'http',
      url: fixture.url,
      fetch,
      protocol: 'legacy',
      headerKeys: [],
      oauth: { issuers: [], ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
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
      oauth: { issuers: [], ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
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

it('03 验收 4: crashes retain bounded redacted stderr through restart and crash-limit; connection, restart and user stop clear the recent failure', async () => {
  const connectionsByAttempt = Array.from({ length: 4 }, fakeConnection)
  let attempt = 0
  vi.spyOn(connections, 'connectStdioServer').mockImplementation(async (_host, spec) => {
    for (let i = 0; i < 30; i++)
      spec.transport?.onStderr?.(`${i}: ${'界'.repeat(200)} fixture-secret plain-visible`)
    return connectionsByAttempt[attempt++]!.c
  })
  const initial = runtime({
    transport: {
      type: 'stdio',
      command: '/bin/node',
      args: [],
      envs: { PLAIN: 'plain-visible' },
      envKeys: ['SECRET'],
    },
  })
  const { pool, host, logs } = setup(initial, false, false)
  await host.secrets.set('tenant:mcp:fixture:env:SECRET', 'fixture-secret')
  pool.apply([initial])
  await connected(pool)
  for (let i = 0; i < 3; i++) {
    connectionsByAttempt[i]!.exit()
    await vi.waitFor(() => expect(phase(pool)).toBe(i === 2 ? 'stopped' : 'restarting'))
    const failure = pool.status()[0]!.error!
    expect(failure.code).toBe('crashed')
    expect(failure.stderrTail).toContain('29:')
    expect(failure.stderrTail).toContain('plain-visible')
    expect(failure.stderrTail).toContain('***')
    expect(failure.stderrTail).not.toContain('fixture-secret')
    expect(failure.stderrTail.split('\n').length).toBeLessThanOrEqual(20)
    expect(new TextEncoder().encode(failure.stderrTail).length).toBeLessThanOrEqual(4096)
    if (i < 2) {
      host.advance((i + 1) * 1000)
      await connected(pool)
    }
    expect(pool.status()[0]!.error).toEqual(i < 2 ? null : failure)
  }
  expect(pool.status()[0]!.stopReason).toBe('crash-limit')
  expect(logs.join('\n')).not.toContain('fixture-secret')
  pool.restart('fixture')
  expect(pool.status()[0]!.error).toBeNull()
  await connected(pool)
  connectionsByAttempt[3]!.exit()
  await vi.waitFor(() => expect(phase(pool)).toBe('restarting'))
  pool.apply([{ ...initial, consented: false }])
  expect(phase(pool)).toBe('stopped')
  expect(pool.status()[0]!.error).toBeNull()
})

it('cached success restores handshake timeout across a new pool; malformed and unknown caches contribute no absent tools', async () => {
  const fake = fakeConnection()
  const connect = vi.spyOn(connections, 'connectStdioServer').mockResolvedValue(fake.c)
  const { pool, host } = setup(runtime(), false, false)
  const cached = {
    version: 1,
    connectedLaunchHash: 'launch',
    lastTools: [{ name: 'cached', definitionHash: 'hash' }],
    pinnedDefinitions: {},
    pinnedInstructions: null,
    oauth: null,
  }
  vi.spyOn(host.fs, 'readFile').mockResolvedValue(JSON.stringify(cached))
  pool.apply([runtime()])
  await connected(pool)
  expect(connect.mock.calls[0]?.[1].handshakeTimeoutMs).toBe(30_000)
  for (const corrupt of [
    { ...cached, version: 2 },
    { ...cached, lastTools: [{ name: null }] },
    null,
  ]) {
    const h = setup(runtime({ consented: false }), false, false)
    vi.spyOn(h.host.fs, 'readFile').mockResolvedValue(JSON.stringify(corrupt))
    h.pool.apply([runtime({ consented: false })])
    await new Promise((resolve) => setTimeout(resolve, 0))
    const result = await h.pool.tableSources({
      waitMs: 10_000,
      signal: new AbortController().signal,
    })
    expect(result.absent[0]?.cachedTools).toEqual([])
  }
})

it('close shuts connections in parallel and kills every tracked process group at its deadline, even after its leader exited', async () => {
  const initial = runtime()
  const { pool, host } = setup(initial, false, false)
  const killGroup = vi.fn<ChildHandle['kill']>(async () => {})
  const child = {
    stdin: new WritableStream(),
    stdout: new ReadableStream(),
    stderr: new ReadableStream(),
    exited: Promise.resolve({ code: 0, signal: null }),
    pid: 123,
    kill: killGroup,
  } as ChildHandle
  vi.spyOn(host.process, 'spawn').mockResolvedValue(child)
  const closes: string[] = []
  vi.spyOn(connections, 'connectStdioServer').mockImplementation(async (wrappedHost, spec) => {
    await wrappedHost.process.spawn(spec.spawn)
    const c = fakeConnection().c
    return {
      ...c,
      close: async () => {
        closes.push(spec.name)
        await new Promise(() => {})
      },
    }
  })
  pool.apply([initial, { ...initial, serverId: 'other' }])
  await vi.waitFor(() => expect(pool.status().every((s) => s.phase === 'connected')).toBe(true))
  const closing = pool.close({ deadlineMs: 250 })
  await vi.waitFor(() => expect(closes).toHaveLength(2))
  host.advance(249)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(killGroup).not.toHaveBeenCalled()
  host.advance(1)
  await closing
  expect(killGroup).toHaveBeenCalledTimes(2)
  expect(killGroup).toHaveBeenNthCalledWith(1, 'SIGKILL')
})

it('removal while first pin callback is pending never resurrects the reconstructable cache', async () => {
  vi.spyOn(connections, 'connectStdioServer').mockResolvedValue(fakeConnection().c)
  const { pool, host, onPin } = setup(runtime(), false, false)
  let release!: () => void
  onPin.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const write = vi.spyOn(host.fs, 'writeFile')
  pool.apply([runtime()])
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  pool.apply([])
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(pool.routes()).toEqual([])
  expect(write).not.toHaveBeenCalled()
})

it('03 验收 4: one oversized Unicode stderr line retains a valid bounded suffix', async () => {
  vi.spyOn(connections, 'connectStdioServer').mockImplementation(async (_host, spec) => {
    spec.transport?.onStderr?.(`${'😀'.repeat(20000)}last-marker`)
    throw new Error('fixture failure')
  })
  const { pool } = setup()
  await vi.waitFor(() => expect(phase(pool)).toBe('error'))
  const tail = pool.status()[0]!.error!.stderrTail
  expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(4096)
  expect(tail.endsWith('last-marker')).toBe(true)
  expect(tail).not.toContain('\uFFFD')
})

it('03 验收 29: first-connecting calls stay pending at 9999 ms, time out at 10000 without dispatch, or succeed as soon as connected', async () => {
  const resolves: ((connection: McpConnection) => void)[] = []
  vi.spyOn(connections, 'connectStdioServer').mockImplementation(
    () => new Promise((resolve) => resolves.push(resolve)),
  )
  const timed = setup()
  const succeeds = setup()
  await vi.waitFor(() => expect(resolves).toHaveLength(2))
  const failed = timed.pool
    .routes()[0]!
    .connection.callTool('echo', {})
    .catch((error: unknown) => error)
  let settled = false
  void failed.then(() => {
    settled = true
  })
  timed.host.advance(9999)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(settled).toBe(false)
  timed.host.advance(1)
  expect(await failed).toBeInstanceOf(connections.McpServerUnavailableError)
  const first = fakeConnection()
  resolves[0]!(first.c)
  await connected(timed.pool)
  expect(first.c.callTool).not.toHaveBeenCalled()
  const second = fakeConnection()
  const called = succeeds.pool.routes()[0]!.connection.callTool('echo', {})
  resolves[1]!(second.c)
  expect(await called).toEqual({ content: [] })
  expect(second.c.callTool).toHaveBeenCalledTimes(1)
})

it('03 验收 29: tableSources waits during restart and returns sources when the retry connects within the window', async () => {
  const first = fakeConnection()
  const second = fakeConnection()
  vi.spyOn(connections, 'connectStdioServer')
    .mockResolvedValueOnce(first.c)
    .mockResolvedValueOnce(second.c)
  const { pool, host } = setup()
  await connected(pool)
  first.exit()
  await vi.waitFor(() => expect(phase(pool)).toBe('restarting'))
  let settled = false
  const table = pool.tableSources({ waitMs: 10000, signal: new AbortController().signal })
  void table.then(() => {
    settled = true
  })
  host.advance(999)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(settled).toBe(false)
  host.advance(1)
  expect((await table).sources).toHaveLength(1)
  expect((await table).absent).toEqual([])
})

it('03 验收 14: applying a changed launch cancels the pending retry; expired old delay never launches a third connection', async () => {
  const first = fakeConnection()
  const connect = vi
    .spyOn(connections, 'connectStdioServer')
    .mockResolvedValueOnce(first.c)
    .mockImplementation(async () => fakeConnection().c)
  const { pool, host } = setup()
  await connected(pool)
  first.exit()
  await vi.waitFor(() => expect(phase(pool)).toBe('restarting'))
  pool.apply([runtime({ launchHash: 'changed' })])
  await connected(pool)
  expect(connect).toHaveBeenCalledTimes(2)
  expect(connect.mock.calls[1]![1].handshakeTimeoutMs).toBe(120000)
  host.advance(10000)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(connect).toHaveBeenCalledTimes(2)
})

it('03 验收 3: crash-limit closes the third connection and runtimeOf consent removal announces needs-consent', async () => {
  const attempts = Array.from({ length: 4 }, fakeConnection)
  let attempt = 0
  vi.spyOn(connections, 'connectStdioServer').mockImplementation(async () => attempts[attempt++]!.c)
  const { pool, host, current } = setup()
  await connected(pool)
  for (let i = 0; i < 3; i++) {
    attempts[i]!.exit()
    await vi.waitFor(() => expect(phase(pool)).toBe(i < 2 ? 'restarting' : 'stopped'))
    if (i < 2) {
      host.advance((i + 1) * 1000)
      await connected(pool)
    }
  }
  expect(attempts[2]!.c.close).toHaveBeenCalledTimes(1)
  pool.restart('fixture')
  await connected(pool)
  attempts[3]!.exit()
  await vi.waitFor(() => expect(phase(pool)).toBe('restarting'))
  current.set('fixture', runtime({ consented: false }))
  host.advance(1000)
  expect(pool.status()[0]?.stopReason).toBe('needs-consent')
})

it('Q4-2: a real pool exposes instructions only when enabled and pinned to the live hash, including after reconnect and release', async () => {
  const first = { ...fakeConnection().c, instructions: 'instructions v1' }
  const second = { ...fakeConnection().c, instructions: 'instructions v2' }
  vi.spyOn(connections, 'connectStdioServer')
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
  const { pool } = setup()
  await connected(pool)
  expect(pool.routes()[0]?.instructions).toBeUndefined()
  const hash = pool.status()[0]!.instructions!.hash
  pool.apply([runtime({ instructions: { enabled: false, pinHash: hash } })])
  expect(pool.routes()[0]?.instructions).toBeUndefined()
  pool.apply([runtime({ instructions: { enabled: true, pinHash: hash } })])
  expect(pool.routes()[0]?.instructions).toEqual({ text: first.instructions, hash })
  pool.restart('fixture')
  await connected(pool)
  expect(pool.routes()[0]?.instructions).toBeUndefined()
  const changed = pool.status()[0]!.instructions!.hash
  pool.apply([runtime({ instructions: { enabled: true, pinHash: changed } })])
  expect(pool.routes()[0]?.instructions).toEqual({ text: second.instructions, hash: changed })
})

it('03 验收 30 (T9): pool call timeout has one per-server source, including the 3600-second total cap', async () => {
  for (const callTimeoutMs of [1000, 123000, 3600000]) {
    const fake = fakeConnection()
    vi.spyOn(connections, 'connectStdioServer').mockResolvedValue(fake.c)
    const { pool } = setup(runtime({ callTimeoutMs }))
    await connected(pool)
    await pool.routes()[0]!.connection.callTool('echo', {}, { timeoutMs: 1, maxTotalTimeoutMs: 2 })
    expect(vi.mocked(fake.c.callTool).mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: callTimeoutMs,
      maxTotalTimeoutMs: Math.min(10 * callTimeoutMs, 3600000),
    })
  }
})

it('minor cacheLoaded: tableSources awaits the initial cache even for a stopped unconsented server', async () => {
  const { pool, host } = setup(runtime({ consented: false }), false, false)
  let release!: (value: string) => void
  vi.spyOn(host.fs, 'readFile').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  pool.apply([runtime({ consented: false })])
  const result = pool.tableSources({ waitMs: 10000, signal: new AbortController().signal })
  let settled = false
  void result.then(() => {
    settled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(settled).toBe(false)
  release(
    JSON.stringify({
      version: 1,
      connectedLaunchHash: 'launch',
      lastTools: [{ name: 'cached', definitionHash: 'hash' }],
      pinnedDefinitions: {},
      pinnedInstructions: null,
      oauth: null,
    }),
  )
  expect((await result).absent[0]?.cachedTools).toEqual(['cached'])
})

it('minor stopReason: consent removal publishes needs-consent in the first change notification', async () => {
  vi.spyOn(connections, 'connectStdioServer').mockResolvedValue(fakeConnection().c)
  const { pool, onChange } = setup()
  await connected(pool)
  const changes: unknown[] = []
  onChange.mockImplementation(() => changes.push(pool.status()[0]?.stopReason))
  pool.apply([runtime({ consented: false })])
  expect(changes[0]).toBe('needs-consent')
})

it('03 验收 2: cached handshakes between 30 and 120 seconds pass through; RequestTimeout becomes handshake-timeout', async () => {
  const { SdkError, SdkErrorCode } = await import('@modelcontextprotocol/client')
  const connect = vi
    .spyOn(connections, 'connectStdioServer')
    .mockImplementation(async () => fakeConnection().c)
  const { pool } = setup()
  await connected(pool)
  pool.apply([runtime({ handshakeTimeoutMs: 84000 })])
  pool.restart('fixture')
  await connected(pool)
  expect(connect.mock.calls[1]?.[1].handshakeTimeoutMs).toBe(84000)
  connect.mockRejectedValue(new SdkError(SdkErrorCode.RequestTimeout, 'fixture timeout'))
  pool.restart('fixture')
  await vi.waitFor(() => expect(pool.status()[0]?.error?.code).toBe('handshake-timeout'))
})

it('03 验收 14: a runtimeOf launch change resets OAuth and error just like apply, and takes the new issuer snapshot', async () => {
  const first = fakeConnection()
  const connect = vi
    .spyOn(connections, 'connectHttpServer')
    .mockResolvedValueOnce(first.c)
    .mockImplementation(async () => fakeConnection().c)
  const initial = runtime({
    transport: {
      type: 'http',
      url: 'https://old.example/mcp',
      fetch,
      protocol: 'legacy',
      headerKeys: [],
      oauth: {
        ownClient: null,
        clientMetadataUrl: null,
        dcrRedirectPort: 53280,
        issuers: ['aaaaaaaaaaaaaaaa'],
      },
    },
  })
  const { pool, host, current } = setup(initial)
  await connected(pool)
  first.exit()
  await vi.waitFor(() => expect(phase(pool)).toBe('restarting'))
  current.set('fixture', {
    ...initial,
    launchHash: 'new',
    transport: {
      ...(initial.transport as Extract<McpServerRuntime['transport'], { type: 'http' }>),
      url: 'https://new.example/mcp',
      oauth: {
        ownClient: null,
        clientMetadataUrl: null,
        dcrRedirectPort: 53280,
        issuers: ['bbbbbbbbbbbbbbbb'],
      },
    },
  })
  host.advance(1000)
  await connected(pool)
  expect(connect.mock.calls[1]?.[0].url).toBe('https://new.example/mcp')
  expect(connect.mock.calls[1]?.[0].authProvider).not.toBe(connect.mock.calls[0]?.[0].authProvider)
  expect(connect.mock.calls[1]?.[0].handshakeTimeoutMs).toBe(120000)
  expect(pool.status()[0]?.error).toBeNull()
  pool.apply([current.get('fixture')!])
  expect(connect).toHaveBeenCalledTimes(2)
})

it('03 验收 3 / 4: reconnect discards closed process handles before a later shutdown deadline', async () => {
  const { pool, host } = setup(runtime(), false, false)
  const kills = [
    vi.fn<ChildHandle['kill']>(async () => {}),
    vi.fn<ChildHandle['kill']>(async () => {}),
  ]
  const children = kills.map(
    (kill, i) =>
      ({
        stdin: new WritableStream(),
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve({ code: 0, signal: null }),
        pid: 100 + i,
        kill,
      }) as ChildHandle,
  )
  vi.spyOn(host.process, 'spawn')
    .mockResolvedValueOnce(children[0]!)
    .mockResolvedValueOnce(children[1]!)
  const first = fakeConnection()
  const second = fakeConnection()
  vi.mocked(second.c.close).mockImplementation(async () => new Promise(() => {}))
  let attempt = 0
  vi.spyOn(connections, 'connectStdioServer').mockImplementation(async (wrapped, spec) => {
    await wrapped.process.spawn(spec.spawn)
    return attempt++ === 0 ? first.c : second.c
  })
  pool.apply([runtime()])
  await connected(pool)
  first.exit()
  await vi.waitFor(() => expect(phase(pool)).toBe('restarting'))
  host.advance(1000)
  await connected(pool)
  expect(first.c.close).toHaveBeenCalledOnce()
  const closing = pool.close({ deadlineMs: 250 })
  await vi.waitFor(() => expect(second.c.close).toHaveBeenCalledOnce())
  host.advance(250)
  await closing
  expect(kills[0]).not.toHaveBeenCalled()
  expect(kills[1]).toHaveBeenCalledExactlyOnceWith('SIGKILL')
})

it('03 验收 14: apply and runtimeOf clear the crash error while a changed launch is still connecting', async () => {
  for (const byTimer of [false, true]) {
    const first = fakeConnection()
    let resolve!: (connection: McpConnection) => void
    const gate = new Promise<McpConnection>((done) => {
      resolve = done
    })
    vi.spyOn(connections, 'connectStdioServer')
      .mockResolvedValueOnce(first.c)
      .mockReturnValueOnce(gate)
    const { pool, host, current } = setup()
    await connected(pool)
    first.exit()
    await vi.waitFor(() => expect(phase(pool)).toBe('restarting'))
    expect(pool.status()[0]?.error?.code).toBe('crashed')
    const changed = runtime({ launchHash: 'changed' })
    current.set('fixture', changed)
    if (byTimer) host.advance(1000)
    else pool.apply([changed])
    try {
      expect(phase(pool)).toBe('connecting')
      expect(pool.status()[0]?.error).toBeNull()
    } finally {
      resolve(fakeConnection().c)
    }
    await connected(pool)
    vi.mocked(connections.connectStdioServer).mockRestore()
  }
})

it('03 验收 14: a connection closed while the HTTP server leaves the auto probe unanswered is classified as network', async () => {
  const { Client } = await import('@modelcontextprotocol/client')
  const fixture = await startHttpFixture({ era: 'probe-hang' })
  cleanup.push(() => fixture.close())
  const original = Client.prototype.connect
  const probeErrors: unknown[] = []
  vi.spyOn(Client.prototype, 'connect').mockImplementation(async function (
    this: InstanceType<typeof Client>,
    transport,
    options,
  ) {
    const before = fixture.requests.length
    const pending = original.call(this, transport, options)
    void pending.catch(() => {})
    await vi.waitFor(() => expect(fixture.requests.length).toBeGreaterThan(before))
    await transport.close()
    try {
      await pending
    } catch (error) {
      probeErrors.push(error)
      throw error
    }
  })
  const { pool } = setup(
    runtime({
      transport: {
        type: 'http',
        url: fixture.url,
        fetch,
        protocol: 'auto',
        headerKeys: [],
        oauth: { ownClient: null, clientMetadataUrl: null, issuers: [], dcrRedirectPort: 53280 },
      },
    }),
  )
  await vi.waitFor(() => expect(probeErrors).toHaveLength(1))
  expect(probeErrors[0]).toMatchObject({ message: expect.stringContaining('closed during') })
  await vi.waitFor(() => expect(pool.status()[0]?.error?.code).toBe('network'))
  expect(phase(pool)).toBe('error')
  expect(probeErrors).toHaveLength(1)
  expect(fixture.requests.every((request) => request.method === 'server/discover')).toBe(true)
})
