/**
 * The Everything fixture as a connector source (spec 02 §工具来源、命名与权限键; plan step 10): its
 * tools enter the table the first time the provider is used, under `everything__<name>`, and every
 * inputSchema it gives builds a validator — so an echo without its message is `invalid-input`, never
 * `tool-unavailable`. And one call goes all the way through a card and the Tape (acceptance 27).
 */
import { describe, expect, it } from 'vitest'
import { connectStdioServer, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type { ModelInfo, TapeEntry, ToolTablePayload, Usage } from '../../src/index.js'
import {
  createCounterIds,
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
})

describe('one Everything call through a card and the Tape (acceptance 27)', () => {
  it('asks for everything__echo, runs it once allowed, and records the server’s answer', async () => {
    const host = createMemoryHost({ process: createNodeProcess() })
    const connection = await connectStdioServer(host, {
      name: 'everything',
      spawn: serverEverythingSpawnSpec(),
      sandbox: { profile: 'read-only', workspace: [] },
    })
    try {
      const provider = createScriptedProvider({ models: [MODEL] })
      const id = 'toolu_echo'
      provider.script([
        { type: 'tool-call-start', index: 1, id, name: 'everything__echo' },
        {
          type: 'tool-call-end',
          index: 1,
          id,
          name: 'everything__echo',
          input: { message: 'hello from Tenon' },
        },
        { type: 'usage', usage: USAGE },
        stopEvent('tool-use', 'tool_use'),
      ])
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
      const sent = await service.send({ sessionId: SESSION, origin: null, text: 'echo it' })
      if (sent.status !== 'started') throw new Error(JSON.stringify(sent))
      expect((await loop.runEnded({ runId: sent.runId })).reason.code).toBe('paused')
      // A connector tool of unknown reversibility, in the manual mode: a tool card, held once.
      const pending = await service.currentPending({ sessionId: SESSION })
      expect(pending?.card).toMatchObject({
        kind: 'tool',
        target: { type: 'tool', serverId: 'everything', toolName: 'echo' },
      })
      expect(pending?.allowScope).toBe('once')
      provider.script(scriptedTurn({ deltas: ['It echoed.'], usage: USAGE }))
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
      expect(named('execution/dispatch_committed').map((entry) => entry.payload['name'])).toEqual([
        'everything__echo',
      ])
      expect(named('tool/result')[0]?.payload).toMatchObject({
        isError: false,
        kernelAuthored: false,
        content: [{ type: 'text', text: 'Echo: hello from Tenon' }],
      })
      expect(named('execution/tool_outcome')[0]?.payload).toMatchObject({
        effect: 'external',
        state: 'completed',
        source: null,
      })
      // The next request carried the server's answer back to the model.
      expect(JSON.stringify(provider.requests.at(-1)?.body)).toContain('Echo: hello from Tenon')
    } finally {
      await connection.close()
    }
  }, 30_000)
})
