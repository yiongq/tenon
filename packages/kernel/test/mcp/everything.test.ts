import { describe, expect, it } from 'vitest'
import { absolutePath, connectStdioServer, createMemoryHost } from '../../src/index.js'
import type { HostClock } from '../../src/index.js'
import { createNodeProcess } from '../support/node-process.js'
import { serverEverythingSpawnSpec } from '../support/server-everything.js'

/** Acceptance 3: the kernel drives a real MCP stdio server through HostProcess only. */
describe('connectStdioServer against @modelcontextprotocol/server-everything', () => {
  it('negotiates, lists tools and calls echo, then shuts the server down cleanly', async () => {
    const host = createMemoryHost({ process: createNodeProcess() })
    const conn = await connectStdioServer(host, {
      name: 'everything',
      spawn: serverEverythingSpawnSpec(),
      sandbox: { profile: 'read-only', workspace: [] },
    })
    // The spawn went through the sandbox wrapper (phase 0: passthrough + log).
    expect(host.sandboxLog).toEqual(['sandbox: passthrough mcp:everything read-only'])
    try {
      expect(conn.serverVersion?.name).toBeTruthy()
      expect(conn.protocolVersion).toBeTruthy()

      const tools = await conn.listTools()
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.map((t) => t.name)).toContain('echo')

      const result = await conn.callTool('echo', { message: 'tenon' })
      const text = JSON.stringify(result.content)
      expect(text).toContain('tenon')
      expect(result.isError ?? false).toBe(false)
    } finally {
      await conn.close()
    }
    // stdin EOF is enough for a well-behaved server: no signal needed.
    const exit = await conn.exited
    expect(exit).toEqual({ code: 0, signal: null })
  }, 20_000)

  it('rejects a relative argv[0] before spawning anything', async () => {
    const host = createMemoryHost({ process: createNodeProcess() })
    const spec = serverEverythingSpawnSpec()
    await expect(
      connectStdioServer(host, {
        name: 'bad',
        spawn: { ...spec, argv: ['node', 'x'] },
        sandbox: { profile: 'full-access', workspace: [] },
      }),
    ).rejects.toThrow(/absolute/)
  })
})

const realClock: HostClock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
}

describe('a server whose stream breaks but whose process stays alive', () => {
  it('is reaped: the oversized frame closes the transport and the child is terminated', async () => {
    const host = { ...createMemoryHost({ process: createNodeProcess() }), clock: realClock }
    const fixture = new URL('../support/fixtures/wedged-server.mjs', import.meta.url).pathname
    const conn = await connectStdioServer(host, {
      name: 'wedged',
      spawn: {
        argv: [process.execPath, fixture],
        cwd: absolutePath(process.cwd()),
        env: { PATH: process.env['PATH'] ?? '' },
        stdio: 'pipe',
      },
      sandbox: { profile: 'read-only', workspace: [] },
      transport: { maxBufferChars: 256, graceMs: 100 },
    })
    // The fixture answers `initialize`, then writes one endless unterminated line and
    // ignores stdin EOF. Without the reaping it would run until the test process dies.
    const exit = await conn.exited
    expect(exit.signal).toBe('SIGTERM')
    await conn.close()
    await conn.close()
  }, 15_000)
})
