import { describe, expect, it } from 'vitest'
import { connectStdioServer, createMemoryHost } from '../../src/index.js'
import { createNodeProcess } from '../support/node-process.js'
import { serverEverythingSpawnSpec } from '../support/server-everything.js'

/** Acceptance 3: the kernel drives a real MCP stdio server through HostProcess only. */
describe('connectStdioServer against @modelcontextprotocol/server-everything', () => {
  it('negotiates, lists tools and calls echo, then shuts the server down cleanly', async () => {
    const host = createMemoryHost({ process: createNodeProcess() })
    const conn = await connectStdioServer(host, {
      name: 'everything',
      spawn: serverEverythingSpawnSpec(),
    })
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
      connectStdioServer(host, { name: 'bad', spawn: { ...spec, argv: ['node', 'x'] } }),
    ).rejects.toThrow(/absolute/)
  })
})
