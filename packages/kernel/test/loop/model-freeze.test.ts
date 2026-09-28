/** Spec 02 invariant 12: a menu edit cannot change the next tool round of an active Run. */
import { expect, it, vi } from 'vitest'
import {
  anthropicDefinition,
  createMemoryHost,
  createMemoryTapeStore,
  zhipuDefinition,
} from '../../src/index.js'
import {
  assertLastTurnIsUser,
  assertToolPairing,
  createCounterIds,
  createStreamGate,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
} from '../../src/testing/index.js'
import * as anthropicFrames from '../provider/fixtures/anthropic-sse.js'
import * as zhipuFrames from '../provider/fixtures/openai-sse.js'
import { LOOK, lookSource } from './support.js'

for (const { wire, continuation } of (['anthropic', 'zhipu'] as const).flatMap((protocol) =>
  [false, true].map((resume) => ({ wire: protocol, continuation: resume })),
)) {
  it(`02 不变量 12: freezes model and effort through a tool continuation after an in-flight menu change (${wire}, ${continuation ? 'continue' : 'new message'})`, async () => {
    const definition = wire === 'anthropic' ? anthropicDefinition : zhipuDefinition
    const ids =
      wire === 'anthropic'
        ? ['claude-sonnet-5', 'claude-opus-5-5']
        : ['glm-5.3-flash', 'glm-5.3-flashx']
    const first = definition.builtinModels.find((model) => model.id === ids[0])!
    const second = definition.builtinModels.find((model) => model.id === ids[1])!
    const call = [{ id: 'call_look', name: LOOK, args: JSON.stringify({ at: 'a' }) }]
    const frames =
      wire === 'anthropic'
        ? anthropicFrames.turnFrames(['Looking.'], call, 'tool_use')
        : zhipuFrames.turnFrames(['Looking.'], call, 'tool_calls')
    const done =
      wire === 'anthropic'
        ? anthropicFrames.turnFrames(['Done.'], [], 'end_turn')
        : zhipuFrames.turnFrames(['Done.'], [], 'stop')
    const cut =
      wire === 'anthropic'
        ? anthropicFrames.turnFrames(['Partial.'], [], 'max_tokens')
        : zhipuFrames.turnFrames(['Partial.'], [], 'length')
    const gate = createStreamGate()
    const net = fakeNetwork(
      [
        { kind: 'sse', frames, gate },
        { kind: 'sse', frames: continuation ? cut : done },
        { kind: 'sse', frames: done },
      ],
      {
        checkRequest(request) {
          assertToolPairing(request)
          assertLastTurnIsUser(request)
        },
      },
    )
    const host = createMemoryHost()
    const provider = definition.create({
      network: net,
      clock: host.clock,
      config: {},
      secrets: { apiKey: 'offline-only' },
    })
    const store = createMemoryTapeStore({
      identity: { userId: 'freeze', tenantId: 'freeze', profileDir: '/tenon/freeze' },
    })
    const executed: Record<string, unknown>[] = []
    const loop = createTestLoopPorts({
      connector: {
        provider,
        model: first,
        models: [first, second],
        mcpSources: [lookSource(executed)],
      },
    })
    const service = createTestSessionService(
      {
        host,
        tape: store,
        ids: createCounterIds(),
        inspectors: [],
        connector: loop.connector,
        protectedFiles: [],
      },
      { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }) },
    )
    service.bindLoop(loop)
    const sessionId = '3d1d9a2e-6b3d-4a71-9f52-0c8de7a11ba9'
    await service.selectModel({
      sessionId,
      choice: { providerId: definition.id, modelId: first.id, effort: 'low' },
      origin: null,
    })
    try {
      const sent = await service.send({ sessionId, origin: null, text: 'Look, then summarize.' })
      if (sent.status !== 'started') throw new Error('first Run did not start')
      await vi.waitFor(() => expect(net.requests).toHaveLength(1))
      // Keep the first response in flight while the persisted menu selection changes.
      gate.release(2)
      await service.selectModel({
        sessionId,
        choice: { providerId: definition.id, modelId: second.id, effort: 'high' },
        origin: null,
      })
      gate.release(frames.length)
      expect((await loop.runEnded({ runId: sent.runId })).reason.code).toBe(
        continuation ? 'output-truncated' : 'completed',
      )
      expect(executed).toEqual([{ at: 'a' }])
      expect(net.requests).toHaveLength(2)
      const next = continuation
        ? await service.continueRun({ sessionId, origin: null })
        : await service.send({ sessionId, origin: null, text: 'Now use the new selection.' })
      expect(next.status).toBe('started')
      expect((await loop.runEnded()).reason).toEqual({ code: 'completed' })
      const bodies = net.requests.map((request) => request.body as Record<string, unknown>)
      expect(bodies.map((body) => body['model'])).toEqual([first.id, first.id, second.id])
      expect(
        bodies.map((body) =>
          wire === 'anthropic'
            ? (body['output_config'] as { effort: string }).effort
            : body['reasoning_effort'],
        ),
      ).toEqual(['low', 'low', 'high'])
      const selected = (await store.readRange({ sessionId, limit: 1000 })).entries.filter(
        (entry) => entry.name === 'session/model_selected',
      )
      expect(selected.map((entry) => entry.payload['modelId'])).toEqual([first.id, second.id])
      expect(net.checkFailures).toEqual([])
    } finally {
      gate.end()
      await service.stop({ rootSessionId: sessionId })
    }
  })
}
