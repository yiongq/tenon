/**
 * What server-everything cannot show (spec 02 plan step 10; 旧 24, 旧 145, 旧 146), against the
 * hand-written test/support/fixtures/tools-server.mjs:
 *
 *   - `_meta["anthropic/requiresUserInteraction"]` survives `connection.listTools()`, and only the JSON
 *     value `true` counts (D12) — checked end to end before layer 4 ② relies on it;
 *   - elicitation is refused without any interface: Tenon's `Client` declares no elicitation
 *     capability, so a 2025-era `elicitation/create` is answered -32601 by the SDK itself; and the
 *     client only negotiates the 2025 era (the SDK's default `versionNegotiation` is legacy), so a
 *     2026-07-28 `input_required` body is never negotiated — a server that sends one anyway makes
 *     `callTool` throw.
 *
 * What the loop makes of a throwing call (is_error, execution state completed) is plan steps 13–14's.
 */
import { SdkError } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { absolutePath, connectStdioServer, createMemoryHost } from '../../src/index.js'
import type { McpConnection } from '../../src/index.js'
import { mcpCandidates } from '../../src/tools/mcp-source.js'
import { createNodeProcess } from '../support/node-process.js'

const FIXTURE = new URL('../support/fixtures/tools-server.mjs', import.meta.url).pathname

async function connect(mode: 'legacy' | 'modern'): Promise<McpConnection> {
  const host = createMemoryHost({ process: createNodeProcess() })
  return connectStdioServer(host, {
    name: `tools-${mode}`,
    spawn: {
      argv: [process.execPath, FIXTURE, mode],
      cwd: absolutePath('/'),
      env: { PATH: process.env['PATH'] ?? '' },
      stdio: 'pipe',
    },
    sandbox: { profile: 'read-only', workspace: [] },
  })
}

describe('the tools fixture server', () => {
  it('keeps _meta through tools/list, and only a JSON true requires the user (D12)', async () => {
    const connection = await connect('legacy')
    try {
      const tools = await connection.listTools()
      const meta = Object.fromEntries(
        tools.map((tool) => [tool.name, (tool as Record<string, unknown>)['_meta']]),
      )
      expect(meta['interactive']).toEqual({ 'anthropic/requiresUserInteraction': true })
      expect(meta['quoted']).toEqual({ 'anthropic/requiresUserInteraction': 'true' })
      const candidates = await mcpCandidates([{ serverId: 'fixture', connection }])
      expect(
        Object.fromEntries(candidates.map((c) => [c.originalName, c.requiresUserInteraction])),
      ).toEqual({ interactive: true, quoted: false, plain: false, elicit: false })
    } finally {
      await connection.close()
    }
  }, 20_000)

  it('has a 2025-era elicitation/create answered -32601 by the SDK, with nothing shown', async () => {
    const connection = await connect('legacy')
    try {
      const result = await connection.callTool('elicit', {})
      // The fixture reports what the client answered its request.
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''
      expect(JSON.parse(text)).toEqual({ error: { code: -32601, message: expect.any(String) } })
    } finally {
      await connection.close()
    }
  }, 20_000)

  it('never negotiates the 2026-07-28 revision, and a call answered input_required throws', async () => {
    const connection = await connect('modern')
    try {
      expect(connection.protocolVersion?.startsWith('2025-')).toBe(true)
      await expect(connection.callTool('elicit', {})).rejects.toBeInstanceOf(SdkError)
      // The connection is still usable after the refused call.
      const echo = await connection.callTool('plain', { x: 1 })
      const echoed = (echo.content as { type: string; text: string }[])[0]?.text ?? ''
      expect(JSON.parse(echoed)).toEqual({ x: 1 })
    } finally {
      await connection.close()
    }
  }, 20_000)
})
