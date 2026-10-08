// Fixture permutations run sequentially to keep counters and close assertions isolated.
// oxlint-disable no-await-in-loop
import { afterEach, expect, it } from 'vitest'
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
    await expect(setup(era)).rejects.toMatchObject({ code: expect.anything() })
  const { fixture } = await setup('legacy', 'legacy')
  expect(fixture.requests.some((r) => r.method === 'server/discover')).toBe(false)
})
it('03 不变量 1 / 03 验收 43 / 03 不变量 22: every HTTP request uses the handed fetch and has no Tenon meta', async () => {
  const { fixture, connection, count } = await setup('modern')
  await connection.listTools()
  await connection.callTool('echo', { x: 1 })
  expect(count()).toBe(fixture.requests.length)
  for (const r of fixture.requests)
    expect(JSON.stringify(r.meta)).not.toMatch(/session_id|working_dir|call_id/)
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
it('03 验收 30 (HTTP): legacy cancellation notifies; modern cancellation closes only its request', async () => {
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
  }
})
// Pin the optional surface without a renderer route.
export type KernelOnlyConnection = Pick<
  McpConnection,
  'listPrompts' | 'getPrompt' | 'listResources' | 'readResource'
>
