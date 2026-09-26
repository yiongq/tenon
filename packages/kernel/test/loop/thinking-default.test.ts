/**
 * Thinking by default (spec 02 §思考的默认与显示; plan step 18, 旧 226's request half): no effort
 * unless one was chosen; on the Anthropic wire `display: 'summarized'` on every request of a model
 * that offers it, written only while thinking is on — so Haiku 4.5, which thinks only on a budget,
 * carries none by default.
 */
import { describe, expect, it } from 'vitest'
import { anthropicDefinition, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type { ModelInfo, Usage } from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
} from '../../src/testing/index.js'

const SESSION = '6b1d9a2e-6b3d-4a71-9f52-0c8de7a11b51'
const USAGE: Usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

function row(id: string): ModelInfo {
  const model = anthropicDefinition.builtinModels.find((candidate) => candidate.id === id)
  if (model === undefined) throw new Error(`no ${id} row`)
  return model
}

async function firstBody(model: ModelInfo): Promise<Record<string, unknown>> {
  const provider = createScriptedProvider({ id: 'anthropic', models: [model] })
  provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
  const loop = createTestLoopPorts({ connector: { provider, model } })
  const service = createTestSessionService({
    host: createMemoryHost(),
    tape: createMemoryTapeStore({
      identity: { userId: 'u', tenantId: 't', profileDir: '/tenon/think' },
    }),
    ids: createCounterIds(),
    inspectors: [],
    connector: loop.connector,
    protectedFiles: [],
  })
  service.bindLoop(loop)
  const sent = await service.send({ sessionId: SESSION, origin: null, text: 'hi' })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  await loop.runEnded({ runId: sent.runId })
  return provider.requests[0]?.body as Record<string, unknown>
}

describe('the thinking defaults', () => {
  it('asks a model that thinks by default for summarized thinking, and sends no effort', async () => {
    const body = await firstBody(row('claude-sonnet-5'))
    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(JSON.stringify(body)).not.toContain('"effort"')
  })

  it('writes no display for a model that thinks only on a budget', async () => {
    const body = await firstBody(row('claude-haiku-4-5-20251001'))
    expect(body['thinking']).toBeUndefined()
  })
})
