import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it } from 'vitest'
import {
  absolutePath,
  connectStdioServer,
  createMemoryHost,
  ChildStdioTransport,
} from '../../src/index.js'
import { createNodeProcess } from '../support/node-process.js'
import { startFakeAuthServer, startHttpFixture } from '../support/http-fixture.js'

const dispose: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(dispose.splice(0).map((close) => close()))
})
const path = (name: string) => new URL(`../support/fixtures/${name}.mjs`, import.meta.url).pathname
it('modern-only answers server/discover, lists tools and closes', async () => {
  const host = createMemoryHost({ process: createNodeProcess() })
  const child = await host.process.spawn({
    argv: [process.execPath, path('modern-server'), 'modern-only'],
    cwd: absolutePath('/'),
    env: {},
    stdio: 'pipe',
  })
  const transport = new ChildStdioTransport(child, host.clock)
  const client = new Client(
    { name: 'fixture-test', version: '1' },
    { versionNegotiation: { mode: 'auto' } },
  )
  dispose.push(() => transport.close())
  await client.connect(transport)
  expect(client.getProtocolEra()).toBe('modern')
  expect((await client.listTools()).tools.map((t) => t.name)).toContain('pid')
  await transport.close()
  expect((await child.exited).code).toBe(0)
})
it('dual starts after --start-delay-ms and closes', async () => {
  const host = createMemoryHost({ process: createNodeProcess() })
  const start = performance.now()
  const conn = await connectStdioServer(host, {
    name: 'dual',
    spawn: {
      argv: [process.execPath, path('modern-server'), 'dual', '--start-delay-ms', '100'],
      cwd: absolutePath('/'),
      env: {},
      stdio: 'pipe',
    },
    sandbox: { profile: 'full-access', workspace: [] },
  })
  dispose.push(() => conn.close())
  expect(performance.now() - start).toBeGreaterThanOrEqual(100)
  expect((await conn.listTools()).map((t) => t.name)).toContain('echo')
})
it('HTTP and fake authorization fixtures start, answer and close', async () => {
  const fixture = await startHttpFixture()
  const auth = await startFakeAuthServer()
  dispose.push(
    () => fixture.close(),
    () => auth.close(),
  )
  const client = new Client(
    { name: 'fixture', version: '1' },
    { versionNegotiation: { mode: 'auto' } },
  )
  dispose.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(fixture.url)))
  expect((await client.listTools()).tools.map((t) => t.name)).toContain('echo')
  expect(
    (await fetch(`${auth.url}/.well-known/oauth-authorization-server`).then((r) => r.json()))
      .code_challenge_methods_supported,
  ).toEqual(['S256'])
})
it('crash fixture lists tools and exits on crash', async () => {
  const host = createMemoryHost({ process: createNodeProcess() })
  const conn = await connectStdioServer(host, {
    name: 'crash',
    spawn: {
      argv: [process.execPath, path('crash-server')],
      cwd: absolutePath('/'),
      env: {},
      stdio: 'pipe',
    },
    sandbox: { profile: 'full-access', workspace: [] },
  })
  dispose.push(() => conn.close())
  expect((await conn.listTools()).map((t) => t.name)).toEqual(['crash', 'big-line'])
  await expect(conn.callTool('crash', {})).rejects.toThrow(/closed/i)
  expect((await conn.exited).code).toBe(1)
})
it('tree fixture exits on EOF and its group can be reaped', async () => {
  const host = createNodeProcess()
  const child = await host.spawn({
    argv: [process.execPath, path('tree-server')],
    cwd: absolutePath('/'),
    env: {},
    stdio: 'pipe',
  })
  const writer = child.stdin.getWriter()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await writer.close()
  expect((await child.exited).code).toBe(0)
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* already empty */
  }
})
