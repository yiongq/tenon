/**
 * The Everything fixture as a connector source (spec 02 §工具来源、命名与权限键; plan step 10): its
 * tools enter the table the first time the provider is used, under `everything__<name>`, and every
 * inputSchema it gives builds a validator — so an echo without its message is `invalid-input`, never
 * `tool-unavailable`. One call through approvals and the Tape is plan step 15's.
 */
import { describe, expect, it } from 'vitest'
import { connectStdioServer, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type { ModelInfo, ToolTablePayload, Usage } from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
} from '../../src/testing/index.js'
import { createArgumentValidator } from '../../src/tools/validate.js'
import { createNodeProcess } from '../support/node-process.js'
import { serverEverythingSpawnSpec } from '../support/server-everything.js'

const MODEL: ModelInfo = {
  id: 'claude-everything',
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
const SESSION = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'

describe('the Everything fixture in a tool table', () => {
  it('enters the first table, and each of its schemas builds a validator', async () => {
    const host = createMemoryHost({ process: createNodeProcess() })
    const connection = await connectStdioServer(host, {
      name: 'everything',
      spawn: serverEverythingSpawnSpec(),
      sandbox: { profile: 'read-only', workspace: [] },
    })
    try {
      const provider = createScriptedProvider({ models: [MODEL] })
      provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
      const loop = createTestLoopPorts({
        connector: { provider, model: MODEL, mcpSources: [{ serverId: 'everything', connection }] },
      })
      const store = createMemoryTapeStore({ identity: host.identity })
      const service = createTestSessionService({
        host,
        tape: store,
        ids: createCounterIds(),
        inspectors: [],
        connector: loop.connector,
        protectedFiles: [],
      })
      service.bindLoop(loop)
      const sent = await service.send({ sessionId: SESSION, origin: null, text: 'hi' })
      if (sent.status !== 'started') throw new Error(JSON.stringify(sent))
      await loop.runEnded({ runId: sent.runId })

      const listed = await connection.listTools()
      const page = await store.readRange({ sessionId: SESSION, limit: 1000 })
      const table = page.entries.find((entry) => entry.name === 'view/tool_table')
        ?.payload as unknown as ToolTablePayload
      const connectorTools = table.tools.filter((t) => t.source === 'mcp')
      expect(connectorTools.map((t) => t.originalName).toSorted()).toEqual(
        listed.map((t) => t.name).toSorted(),
      )
      expect(connectorTools.map((t) => t.name)).toContain('everything__echo')
      // The permission key keeps the server's own name and the configured server id (H4).
      expect(connectorTools.find((t) => t.name === 'everything__echo')).toMatchObject({
        serverId: 'everything',
        originalName: 'echo',
      })

      const validator = createArgumentValidator()
      for (const tool of listed) {
        const verdict = validator.check(
          {
            source: 'mcp',
            originalName: tool.name,
            spec: {
              name: tool.name,
              description: '',
              inputSchema: tool.inputSchema as Record<string, unknown>,
            },
          },
          {},
        )
        expect({
          tool: tool.name,
          unusable: !verdict.ok && verdict.source === 'tool-unavailable',
        }).toEqual({
          tool: tool.name,
          unusable: false,
        })
      }
      const echo = listed.find((t) => t.name === 'echo')
      expect(
        validator.check(
          {
            source: 'mcp',
            originalName: 'echo',
            spec: {
              name: 'everything__echo',
              description: '',
              inputSchema: echo?.inputSchema as Record<string, unknown>,
            },
          },
          {},
        ),
      ).toMatchObject({ ok: false, source: 'invalid-input' })
    } finally {
      await connection.close()
    }
  }, 30_000)
})
