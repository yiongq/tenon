// Fixture permutations run sequentially to keep counters and close assertions isolated.
// Cancellation observations differ by the negotiated protocol era.
// oxlint-disable no-await-in-loop, no-conditional-expect
import { afterEach, expect, it, vi } from 'vitest'
import { connectHttpServer, McpResourceNotFoundError } from '../../src/index.js'
import type { McpConnection } from '../../src/index.js'
import { wrapMcpFetch } from '../../src/mcp/http-fetch.js'
import { startHttpFixture } from '../support/http-fixture.js'

const dispose: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(dispose.splice(0).map((fn) => fn()))
})
async function setup(
  era: 'modern' | 'legacy' | 'probe-204' | 'probe-non-json',
  protocol: 'auto' | 'legacy' = 'auto',
) {
  const fixture = await startHttpFixture({ era })
  dispose.push(() => fixture.close())
  let fetched = 0
  const connection = await connectHttpServer({
    name: 'http',
    url: fixture.url,
    fetch: (input, init) => {
      fetched += 1
      return fetch(input, init)
    },
    protocol,
    handshakeTimeoutMs: 500,
  })
  dispose.push(() => connection.close())
  return { fixture, connection, count: () => fetched }
}
it('03 验收 13: auto reaches modern or legacy; bad 2xx probes fail; legacy skips discover', async () => {
  expect((await setup('modern')).connection.era).toBe('modern')
  expect((await setup('legacy')).connection.era).toBe('legacy')
  for (const era of ['probe-204', 'probe-non-json'] as const)
    await expect(setup(era)).rejects.toMatchObject({ code: 'era-negotiation-failed' })
  const { fixture } = await setup('legacy', 'legacy')
  expect(fixture.requests.some((r) => r.method === 'server/discover')).toBe(false)
})
it('03 不变量 1 / 03 验收 43 / 03 不变量 22: every HTTP request uses the handed fetch and has no Tenon meta', async () => {
  const { fixture, connection, count } = await setup('modern')
  await connection.listTools()
  await connection.callTool('echo', { x: 1 })
  expect(count()).toBe(fixture.requests.length)
  for (const r of fixture.requests)
    expect(
      Object.keys((r.meta as Record<string, unknown>) ?? {}).every(
        (key) => key === 'progressToken' || key.startsWith('io.modelcontextprotocol/'),
      ),
    ).toBe(true)
})
it('03 验收 40 / 03 验收 41: prompts, resources and unsupported elicitation', async () => {
  const { connection } = await setup('modern')
  expect(await connection.listPrompts?.()).toHaveProperty('prompts')
  expect(await connection.getPrompt?.('fixture')).toHaveProperty('messages')
  expect(await connection.listResources?.()).toHaveProperty('resources')
  expect(await connection.readResource?.('fixture://a')).toHaveProperty('contents')
  await expect(connection.readResource?.('fixture://missing')).rejects.toBeInstanceOf(
    McpResourceNotFoundError,
  )
  await expect(connection.callTool('elicit', {})).rejects.toMatchObject({ code: -32021 })
})
it('03 验收 12 / 03 不变量 13: static headers stay same-origin and a token overrides Authorization', async () => {
  const seen: Request[] = []
  const wrapped = wrapMcpFetch(
    async (input) => {
      seen.push(new Request(input))
      return new Response('{}')
    },
    {
      serverUrl: 'https://mcp.example/mcp',
      staticHeaders: { Authorization: 'static', 'x-test': 'value' },
    },
  )
  await wrapped('https://mcp.example/mcp', { headers: { authorization: 'Bearer token' } })
  await wrapped('https://auth.example/token')
  expect(seen[0]?.headers.get('authorization')).toBe('Bearer token')
  expect(seen[0]?.headers.get('x-test')).toBe('value')
  expect(seen[1]?.headers.get('authorization')).toBeNull()
  expect(seen[1]?.headers.get('x-test')).toBeNull()
  const fixture = await startHttpFixture()
  dispose.push(() => fixture.close())
  const c = await connectHttpServer({
    name: 'headers',
    url: fixture.url,
    fetch,
    staticHeaders: { Authorization: 'static' },
    authProvider: { token: async () => 'fixture-token' },
  })
  dispose.push(() => c.close())
  expect(fixture.requests[0]?.headers['authorization']).toBe('Bearer fixture-token')
})
it('03 验收 14 (T49 call) / 03 不变量 10: broken stream reports its id and tools/call is never resent', async () => {
  const fixture = await startHttpFixture()
  dispose.push(() => fixture.close())
  const stop = new AbortController()
  const breaks: unknown[] = []
  const c = await connectHttpServer({
    name: 'broken',
    url: fixture.url,
    fetch,
    onStreamBreak: (request) => {
      breaks.push(request)
      stop.abort(new Error('broken stream'))
    },
  })
  dispose.push(() => c.close())
  fixture.set({ failNext: 'break-stream' })
  await expect(c.callTool('echo', {}, { signal: stop.signal, timeoutMs: 500 })).rejects.toThrow(
    /broken stream/,
  )
  expect(breaks).toMatchObject([{ method: 'tools/call' }])
  expect(fixture.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1)
})
it('03 验收 30 / 03 不变量 17 (HTTP): legacy cancellation notifies; modern cancellation closes only its request', async () => {
  for (const era of ['legacy', 'modern'] as const) {
    const { fixture, connection } = await setup(era)
    const stop = new AbortController()
    const pending = connection.callTool('slow', { ms: 1000 }, { signal: stop.signal })
    const rejected = pending.catch((error: Error) => error)
    await new Promise((resolve) => setTimeout(resolve, 80))
    stop.abort(new Error('stop'))
    expect(await rejected).toMatchObject({ message: expect.stringMatching(/stop/) })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fixture.requests.some((r) => r.method === 'notifications/cancelled')).toBe(
      era === 'legacy',
    )
    if (era === 'modern') {
      const requestId = fixture.requests.find((r) => r.method === 'tools/call')?.body['id']
      expect(requestId).toBeDefined()
      await vi.waitFor(() => expect(fixture.cancelledRequests).toContain(requestId))
    }
  }
})
// Pin the optional surface without a renderer route.
export type KernelOnlyConnection = Pick<
  McpConnection,
  'listPrompts' | 'getPrompt' | 'listResources' | 'readResource'
>

it('03 验收 12: x-mcp-header is mirrored by the SDK', async () => {
  const { fixture, connection } = await setup('modern')
  await connection.listTools()
  await connection.callTool('echo', { trace: 'fixture-trace' })
  expect(
    fixture.requests.find((r) => r.method === 'tools/call')?.headers['mcp-param-x-fixture-trace'],
  ).toBe('fixture-trace')
})
it.each(['legacy', 'modern'] as const)(
  '03 验收 30 (HTTP): %s idle timeout cancels its server request',
  async (era) => {
    const { fixture, connection } = await setup(era)
    const caller = new AbortController()
    await expect(
      connection.callTool('slow', { ms: 1200 }, { signal: caller.signal, timeoutMs: 150 }),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    expect(caller.signal.aborted).toBe(false)
    if (era === 'legacy')
      await vi.waitFor(() =>
        expect(fixture.requests.some((r) => r.method === 'notifications/cancelled')).toBe(true),
      )
    else {
      const requestId = fixture.requests.find((r) => r.method === 'tools/call')?.body['id']
      await vi.waitFor(() => expect(fixture.cancelledRequests).toContain(requestId))
      expect(fixture.requests.some((r) => r.method === 'notifications/cancelled')).toBe(false)
    }
  },
)

it.each(['legacy', 'modern'] as const)(
  '03 验收 30 (HTTP): %s total deadline at ten times uses fake setTimeout and cancels on the server',
  async (era) => {
    const { fixture, connection } = await setup(era)
    const caller = new AbortController()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      let settled = false
      let progress = 0
      const deadlineAt = Date.now() + 1800
      const pending = connection
        .callTool(
          'slow',
          { ms: 3000 },
          {
            signal: caller.signal,
            timeoutMs: era === 'modern' ? 180 : 10000,
            maxTotalTimeoutMs: 1800,
            onprogress: () => {
              progress++
            },
            resetTimeoutOnProgress: true,
          },
        )
        .catch((error: unknown) => {
          settled = true
          return error
        })
      await vi.waitFor(() =>
        expect(fixture.requests.some((r) => r.method === 'tools/call')).toBe(true),
      )
      const requestId = fixture.requests.find((r) => r.method === 'tools/call')!.body['id']
      // Deliver each progress frame over the real loopback socket before advancing the next tick.
      if (era === 'modern') {
        for (let i = 0; i < 17; i++) {
          await vi.waitFor(() => expect(progress).toBeGreaterThan(i), { interval: 1 })
        }
      }
      await vi.advanceTimersByTimeAsync(deadlineAt - Date.now() - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect(await pending).toMatchObject({ code: 'REQUEST_TIMEOUT' })
      expect(caller.signal.aborted).toBe(false)
      if (era === 'legacy')
        await vi.waitFor(() =>
          expect(fixture.requests.some((r) => r.method === 'notifications/cancelled')).toBe(true),
        )
      else {
        expect(progress).toBeGreaterThan(1)
        await vi.waitFor(() => expect(fixture.cancelledRequests).toContain(requestId))
        expect(fixture.requests.some((r) => r.method === 'notifications/cancelled')).toBe(false)
      }
    } finally {
      vi.useRealTimers()
    }
  },
)

it('03 验收 2: HTTP handshake timeout is passed to Client.connect', async () => {
  const { Client } = await import('@modelcontextprotocol/client')
  const fixture = await startHttpFixture({ era: 'legacy' })
  dispose.push(() => fixture.close())
  const connect = vi.spyOn(Client.prototype, 'connect')
  try {
    const connection = await connectHttpServer({
      name: 'fixture',
      url: fixture.url,
      fetch,
      protocol: 'legacy',
      handshakeTimeoutMs: 84000,
    })
    dispose.push(() => connection.close())
    expect(connect.mock.calls[0]?.[1]).toMatchObject({ timeout: 84000 })
  } finally {
    connect.mockRestore()
  }
})

it('03 验收 12 / 03 不变量 13: every outgoing header belongs to SDK, fetch, or the configured static names', async () => {
  const fixture = await startHttpFixture({ era: 'modern' })
  dispose.push(() => fixture.close())
  const connection = await connectHttpServer({
    name: 'fixture',
    url: fixture.url,
    fetch,
    staticHeaders: { 'X-Fixture-Static': 'fixture-static' },
  })
  dispose.push(() => connection.close())
  await connection.listTools()
  await connection.callTool('echo', { trace: 'fixture-trace' }, { onprogress: () => {} })
  const allowed = new Set([
    'host',
    'connection',
    'content-type',
    'accept',
    'accept-language',
    'sec-fetch-mode',
    'user-agent',
    'accept-encoding',
    'content-length',
    'mcp-protocol-version',
    'mcp-session-id',
    'mcp-method',
    'mcp-name',
    'mcp-param-x-fixture-trace',
    'x-fixture-static',
  ])
  const names = new Set(fixture.requests.flatMap((r) => Object.keys(r.headers)))
  expect([...names].filter((name) => !allowed.has(name))).toEqual([])
})

it('03 验收 42: a real modern HTTP connection exposes the exact fixture instructions', async () => {
  const { INSTRUCTIONS } = await import('../support/fixtures/modern-server.mjs')
  expect((await setup('modern')).connection.instructions).toBe(INSTRUCTIONS)
})

it('03 验收 13: an auto probe 5xx is handshake-failed, while a rejected fetch keeps its original TypeError', async () => {
  const fixture = await startHttpFixture({ era: 'modern', failConnect: '503' })
  dispose.push(() => fixture.close())
  await expect(
    connectHttpServer({ name: 'fixture', url: fixture.url, fetch, protocol: 'auto' }),
  ).rejects.toMatchObject({ code: 'handshake-failed' })
  const network = new TypeError('fixture auto network failure')
  await expect(
    connectHttpServer({
      name: 'fixture',
      url: fixture.url,
      fetch: async () => {
        throw network
      },
      protocol: 'auto',
    }),
  ).rejects.toBe(network)
})

it.each(['legacy', 'modern'] as const)(
  '03 验收 41: %s HTTP sends no logging/setLevel and discover declares no capabilities',
  async (era) => {
    const { fixture, connection } = await setup(era)
    await connection.listTools()
    await connection.callTool('echo', {})
    await connection.listPrompts?.()
    await connection.listResources?.()
    expect(fixture.requests.filter((r) => r.method === 'logging/setLevel')).toEqual([])
    if (era === 'modern') {
      const discover = fixture.requests.find((r) => r.method === 'server/discover')!.body
      expect(discover).not.toHaveProperty('capabilities')
      expect(discover['params']).not.toHaveProperty('capabilities')
      expect(
        (discover['params'] as { _meta: Record<string, unknown> })['_meta'][
          'io.modelcontextprotocol/clientCapabilities'
        ],
      ).toEqual({})
    }
  },
)
