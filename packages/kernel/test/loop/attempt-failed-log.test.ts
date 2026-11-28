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

function harness(options: { readonly compactionThreshold?: number } = {}) {
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
      ...(options.compactionThreshold === undefined
        ? {}
        : { compactionThreshold: options.compactionThreshold }),
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

/**
 * A long conversation is summarized before its next request is sent (the compaction request,
 * `publish: false`): when that request fails, the Run ends with `provider-error` and the main
 * request never goes out, so the summary's failure is the only failure there is to log.
 */
describe('a failed summary attempt', () => {
  const turn = (inputTokens: number) =>
    scriptedTurn({ deltas: ['an old answer'], usage: { ...USAGE, inputTokens } })

  /** Three finished turns, the last one over the 1000-token threshold: the next send summarizes. */
  async function seeded() {
    const h = harness({ compactionThreshold: 1000 })
    for (const [index, tokens] of [10, 10, 2000].entries()) {
      h.provider.script(turn(tokens))
      // oxlint-disable-next-line no-await-in-loop -- each turn must end before the next begins
      await h.send(`old question ${index}`)
    }
    expect(h.failed()).toEqual([])
    return h
  }

  it('error-logs 验收 7: 复现 a summary request that fails writes the same attempt-failed line as a main request', async () => {
    const h = await seeded()
    h.provider.script(
      failure({
        code: 'auth',
        retryable: false,
        status: 401,
        providerCode: '1000',
        detail: 'DETAIL-SUMMARY: the key was refused',
      }),
    )
    const runId = await h.send('a question that needs a summary first')
    // Only the summary request was sent: three seeded turns and the one failed summary.
    expect(h.provider.requests).toHaveLength(4)
    expect(h.failed()).toEqual([
      `[provider] run ${runId} attempt failed: provider=anthropic model=claude-run-1 code=auth status=401 providerCode=1000 retryable=false detail=DETAIL-SUMMARY: the key was refused`,
    ])
  })

  it('error-logs 验收 7: 复现 every failed summary attempt gets its line, a retryable one included', async () => {
    const h = await seeded()
    h.provider.retryAdvice = () => ({ maxAttempts: 2, baseDelayMs: 0 })
    for (const detail of ['DETAIL-FIRST', 'DETAIL-SECOND']) {
      h.provider.script(
        failure({
          code: 'rate-limit',
          retryable: true,
          status: 429,
          providerCode: null,
          detail,
          retryAfterMs: 0,
        }),
      )
    }
    const runId = await h.send('a question that needs a summary first')
    expect(h.provider.requests).toHaveLength(5)
    expect(h.failed()).toEqual([
      `[provider] run ${runId} attempt failed: provider=anthropic model=claude-run-1 code=rate-limit status=429 providerCode=- retryable=true detail=DETAIL-FIRST`,
      `[provider] run ${runId} attempt failed: provider=anthropic model=claude-run-1 code=rate-limit status=429 providerCode=- retryable=true detail=DETAIL-SECOND`,
    ])
  })

  it('error-logs 验收 7: a summary that succeeds writes no such line', async () => {
    const h = await seeded()
    h.provider.script(scriptedTurn({ deltas: ['the summary'], usage: USAGE }))
    h.provider.script(scriptedTurn({ deltas: ['the answer'], usage: USAGE }))
    await h.send('a question that needs a summary first')
    expect(h.provider.requests).toHaveLength(5)
    expect(h.failed()).toEqual([])
  })
})
