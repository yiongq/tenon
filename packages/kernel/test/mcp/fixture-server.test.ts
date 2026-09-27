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
 * In the loop, both refusals close the call as one that ran: a result, execution state completed, and
 * nothing shown — is_error when the call threw (旧 146).
 */
import { SdkError } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import {
  absolutePath,
  connectStdioServer,
  createMemoryHost,
  createMemoryTapeStore,
} from '../../src/index.js'
import type { McpConnection, MemoryHost, ModelInfo, TapeEntry, Usage } from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import { mcpCandidates } from '../../src/tools/mcp-source.js'
import { createNodeProcess } from '../support/node-process.js'

const FIXTURE = new URL('../support/fixtures/tools-server.mjs', import.meta.url).pathname

async function connect(
  mode: 'legacy' | 'modern',
  host: MemoryHost = createMemoryHost({ process: createNodeProcess() }),
): Promise<McpConnection> {
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

const MODEL: ModelInfo = {
  id: 'claude-fixture',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}
const USAGE: Usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}
const SESSION = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b39'

/** One Run whose model calls `fixture__elicit`, allowed by the user's setting; its closing facts. */
async function elicitInTheLoop(mode: 'legacy' | 'modern') {
  const host = createMemoryHost({ process: createNodeProcess() })
  const connection = await connect(mode, host)
  try {
    const provider = createScriptedProvider({ models: [MODEL] })
    provider.script([
      { type: 'tool-call-start', index: 1, id: 'toolu_elicit', name: 'fixture__elicit' },
      { type: 'tool-call-end', index: 1, id: 'toolu_elicit', name: 'fixture__elicit', input: {} },
      { type: 'usage', usage: USAGE },
      stopEvent('tool-use', 'tool_use'),
    ])
    provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
    const loop = createTestLoopPorts({
      connector: { provider, model: MODEL, mcpSources: [{ serverId: 'fixture', connection }] },
    })
    const store = createMemoryTapeStore({ identity: host.identity })
    const service = createTestSessionService(
      {
        host,
        tape: store,
        ids: createCounterIds(),
        inspectors: [],
        connector: loop.connector,
        protectedFiles: [],
      },
      { userSetting: () => ({ userSetting: 'always-allow' }) },
    )
    service.bindLoop(loop)
    const sent = await service.send({ sessionId: SESSION, origin: null, text: 'ask me' })
    if (sent.status !== 'started') throw new Error(JSON.stringify(sent))
    const ended = await loop.runEnded({ runId: sent.runId })
    const entries = (await store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    const first = (name: string): TapeEntry['payload'] | undefined =>
      entries.find((entry) => entry.name === name)?.payload
    return {
      code: ended.reason.code,
      result: first('tool/result'),
      outcome: first('execution/tool_outcome'),
      confirms: host.confirmRequests.length,
    }
  } finally {
    await connection.close()
  }
}

describe('elicitation in the loop (旧 146)', () => {
  it('closes a 2026-07-28 input_required call as is_error, completed, with nothing shown', async () => {
    const modern = await elicitInTheLoop('modern')
    expect(modern.code).toBe('completed')
    expect(modern.result).toMatchObject({ isError: true, kernelAuthored: false })
    expect(modern.outcome).toMatchObject({ state: 'completed', source: null })
    expect(modern.confirms).toBe(0)
  }, 20_000)

  it('closes a 2025-era elicitation the SDK refused as a call that ran, with nothing shown', async () => {
    const legacy = await elicitInTheLoop('legacy')
    expect(legacy.code).toBe('completed')
    const content = (legacy.result?.['content'] ?? []) as { text: string }[]
    const text = content[0]?.text ?? ''
    expect(JSON.parse(text)).toEqual({ error: { code: -32601, message: expect.any(String) } })
    expect(legacy.outcome).toMatchObject({ state: 'completed', source: null })
    expect(legacy.confirms).toBe(0)
  }, 20_000)
})
