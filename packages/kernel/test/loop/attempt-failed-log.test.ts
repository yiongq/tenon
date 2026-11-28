/**
 * The line the loop hands the host's `log` for a model request that failed (docs/features/
 * error-logs/spec.md §记什么「模型请求失败」; acceptance 7's kernel half): one per failed attempt,
 *
 *   [provider] run <runId> attempt failed: provider=<id> model=<id> code=<code>
 *   status=<status | -> providerCode=<code | -> retryable=<true|false> detail=<detail>
 *
 * on one line. A scripted provider stands in for the vendor, so that the failure it reports is
 * exactly what the case wrote down; the loop, the service and the retry are the real ones.
 */
import { describe, expect, it } from 'vitest'
import { createMemoryTapeStore } from '../../src/index.js'
import type { ModelInfo, StreamEvent, Usage } from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
} from '../../src/testing/index.js'
import { instantHost } from './support.js'

const IDENTITY = { userId: 'run-user', tenantId: 'run-tenant', profileDir: '/tenon/run' }
const SESSION = '5a2c9a2e-6b3d-4a71-9f52-0c8de7a11b35'

const MODEL: ModelInfo = {
  id: 'claude-run-1',
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
  inputTokens: 9,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

function failure(error: Omit<Extract<StreamEvent, { type: 'error' }>, 'type'>): StreamEvent[] {
  return scriptedTurn({ usage: USAGE, terminal: { type: 'error', ...error } })
}

function harness() {
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
  const logs: string[] = []
  const service = createTestSessionService(
    {
      host: instantHost(),
      tape: createMemoryTapeStore({ identity: IDENTITY }),
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
      log: (line) => logs.push(line),
    },
    { tools: {} },
  )
  service.bindLoop(loop)
  const send = async (text: string) => {
    const sent = await service.send({ sessionId: SESSION, origin: null, text })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    await loop.runEnded({ runId: sent.runId })
    return sent.runId
  }
  const failed = (): string[] => logs.filter((line) => line.includes('attempt failed'))
  return { provider, logs, send, failed }
}

describe('a failed attempt', () => {
  it('error-logs 验收 7: every failed attempt writes one line with provider, model, code, status, providerCode, retryable and detail', async () => {
    const h = harness()
    // Three resends of a transient failure, each its own attempt, each its own line.
    for (let i = 0; i < 3; i += 1) {
      h.provider.script(
        failure({
          code: 'overloaded',
          retryable: true,
          status: 529,
          providerCode: 'overloaded_error',
          detail: 'DETAIL-ONE: the vendor is busy',
        }),
      )
    }
    const runId = await h.send('first message')
    expect(h.failed()).toEqual(
      Array.from(
        { length: 3 },
        () =>
          `[provider] run ${runId} attempt failed: provider=anthropic model=claude-run-1 code=overloaded status=529 providerCode=overloaded_error retryable=true detail=DETAIL-ONE: the vendor is busy`,
      ),
    )
  })

  it('error-logs 验收 7: a failure with no status and no vendor code shows a dash for each', async () => {
    const h = harness()
    h.provider.script(
      failure({
        code: 'auth',
        retryable: false,
        providerCode: null,
        detail: 'DETAIL-TWO: no status here',
      }),
    )
    const runId = await h.send('second message')
    expect(h.failed()).toEqual([
      `[provider] run ${runId} attempt failed: provider=anthropic model=claude-run-1 code=auth status=- providerCode=- retryable=false detail=DETAIL-TWO: no status here`,
    ])
  })

  it('error-logs 验收 7: an attempt that succeeds writes no such line', async () => {
    const h = harness()
    h.provider.script(
      failure({ code: 'auth', retryable: false, providerCode: null, detail: 'DETAIL-THREE' }),
    )
    await h.send('third message')
    expect(h.failed()).toHaveLength(1)
    // The next message is answered: nothing is added.
    h.provider.script(scriptedTurn({ deltas: ['fine'], usage: USAGE }))
    await h.send('fourth message')
    expect(h.failed()).toHaveLength(1)
  })
})
