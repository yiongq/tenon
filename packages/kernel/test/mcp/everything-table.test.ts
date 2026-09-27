/**
 * The Everything fixture as a connector source (spec 02 §工具来源、命名与权限键; plan step 10): its
 * tools enter the table the first time the provider is used, under `everything__<name>`, and every
 * inputSchema it gives builds a validator — so an echo without its message is `invalid-input`, never
 * `tool-unavailable`. One call goes through a card, its allow and the Tape (验收 27; plan step 15).
 */
import { describe, expect, it } from 'vitest'
import { connectStdioServer, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type { ModelInfo, TapeEntry, ToolTablePayload, Usage } from '../../src/index.js'
import {
  createCounterIds,
  createFakeInspector,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
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

  it('takes one call through its card, the allow and the Tape (验收 27)', async () => {
    const host = createMemoryHost({ process: createNodeProcess() })
    const connection = await connectStdioServer(host, {
      name: 'everything',
      spawn: serverEverythingSpawnSpec(),
      sandbox: { profile: 'read-only', workspace: [] },
    })
    try {
      const provider = createScriptedProvider({ models: [MODEL] })
      provider.script([
        { type: 'tool-call-start', index: 1, id: 'toolu_echo', name: 'everything__echo' },
        {
          type: 'tool-call-end',
          index: 1,
          id: 'toolu_echo',
          name: 'everything__echo',
          input: { message: 'across the card' },
        },
        { type: 'usage', usage: USAGE },
        stopEvent('tool-use', 'tool_use'),
      ])
      provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
      const loop = createTestLoopPorts({
        connector: { provider, model: MODEL, mcpSources: [{ serverId: 'everything', connection }] },
      })
      const store = createMemoryTapeStore({ identity: host.identity })
      const inspector = createFakeInspector({
        id: 'asker',
        ceiling: 'ask',
        answer: { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] },
      })
      const service = createTestSessionService(
        {
          host,
          tape: store,
          ids: createCounterIds(),
          inspectors: [inspector.registration],
          connector: loop.connector,
          protectedFiles: [],
        },
        { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }) },
      )
      service.bindLoop(loop)
      const sent = await service.send({ sessionId: SESSION, origin: null, text: 'echo it' })
      if (sent.status !== 'started') throw new Error(JSON.stringify(sent))
      expect((await loop.runEnded({ runId: sent.runId })).reason).toEqual({
        code: 'paused',
        waitingFor: 'approval',
      })
      // The connector card names the server and the tool as the server calls it (开放问题 15).
      const pending = await service.currentPending({ sessionId: SESSION })
      expect(pending?.card).toMatchObject({
        kind: 'tool',
        reason: 'flagged',
        target: { type: 'tool', serverId: 'everything', toolName: 'echo' },
        facts: { category: 'exfiltration', toolName: 'echo' },
      })
      expect(host.confirmRequests.map((request) => request.requestId)).toEqual([
        pending?.card.requestId,
      ])
      expect(
        await service.answer({
          kind: 'approval',
          sessionId: SESSION,
          requestId: pending?.card.requestId ?? '',
          decision: 'allow',
          origin: null,
        }),
      ).toEqual({ status: 'applied' })
      expect((await loop.runEnded()).reason).toEqual({ code: 'completed' })

      const entries = (await store.readRange({ sessionId: SESSION, limit: 1000 })).entries
      const named = (name: string): TapeEntry[] => entries.filter((entry) => entry.name === name)
      expect(named('tool/approval_resolved').map((entry) => entry.payload['outcome'])).toEqual([
        'allowed',
      ])
      const pausedRun = named('execution/run_started')[0]?.sourceId
      const [dispatch] = named('execution/dispatch_committed')
      expect(dispatch).toMatchObject({ sourceId: pausedRun, sourceSeq: 1 })
      expect(dispatch?.payload['decisionKey']).toBe(pending?.card.requestId)
      const [result] = named('tool/result')
      expect(result).toMatchObject({ sourceId: pausedRun, sourceSeq: 1 })
      expect(JSON.stringify(result?.payload['content'])).toContain('across the card')
      expect(
        named('execution/tool_outcome').map((entry) => [
          entry.payload['state'],
          entry.payload['source'],
        ]),
      ).toEqual([['completed', null]])
    } finally {
      await connection.close()
    }
  }, 30_000)
})
