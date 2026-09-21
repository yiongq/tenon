/**
 * BaseProvider's defaults over a tiny in-test provider: the members a caller must never
 * null-check, and complete()'s contract that an error or an abort is surfaced rather than
 * swallowed while the partial content is kept.
 */
import { describe, expect, it } from 'vitest'
import { BaseProvider } from '../../src/index.js'
import type {
  EncodedRequest,
  ModelInfo,
  Provider,
  ProviderRequest,
  SendContext,
  StreamEvent,
  Usage,
} from '../../src/index.js'

const MODEL: ModelInfo = {
  id: 'claude-x',
  providerId: 'scripted',
  contextLimit: 200_000,
  maxOutputTokens: 8192,
  reasoning: true,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: true,
  thinkingPreservationFormat: 'signed-blocks',
  usageNeedsOptIn: false,
}

const CONTEXT: SendContext = {
  identity: { runId: '00000000-0000-4000-8000-000000000001', requestSeq: 1, physicalAttempt: 1 },
}

function usageOf(outputTokens: number, final: boolean): Usage {
  return {
    inputTokens: 10,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    final,
  }
}

function requestOf(): ProviderRequest {
  return { model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
}

/** Replays a fixed event list; `encode()` is pure and records what `stream()` was handed. */
class ScriptedProvider extends BaseProvider {
  readonly id = 'scripted'
  readonly encoded: EncodedRequest[] = []
  readonly streamed: EncodedRequest[] = []
  readonly #events: readonly StreamEvent[]

  constructor(events: readonly StreamEvent[]) {
    super()
    this.#events = events
  }

  models(): Promise<ModelInfo[]> {
    return Promise.resolve([MODEL])
  }

  encode(req: ProviderRequest): EncodedRequest {
    const encoded: EncodedRequest = {
      providerId: this.id,
      modelId: req.model.id,
      body: { model: req.model.id },
      promptHash: 'prompt-hash',
      toolDefinitionsHash: 'tools-hash',
      thinkingDecisions: [],
    }
    this.encoded.push(encoded)
    return encoded
  }

  async *stream(encoded: EncodedRequest): AsyncIterable<StreamEvent> {
    this.streamed.push(encoded)
    for (const event of this.#events) yield event
  }
}

describe('BaseProvider.complete', () => {
  it('encodes once and streams exactly what it encoded', async () => {
    const provider = new ScriptedProvider([
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
    ])
    const result = await provider.complete(requestOf(), CONTEXT)
    expect(provider.encoded).toHaveLength(1)
    // What gets hashed is what goes out: stream() consumes the encode() product itself.
    expect(provider.streamed[0]).toBe(provider.encoded[0])
    expect(result).toEqual({
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      usage: null,
      stop: { reason: 'end-turn', providerReason: 'end_turn' },
      error: null,
    })
  })

  it('keeps the final usage, whatever order the readings arrive in', async () => {
    const ascending = new ScriptedProvider([
      { type: 'usage', usage: usageOf(1, false) },
      { type: 'usage', usage: usageOf(9, true) },
      { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
    ])
    expect((await ascending.complete(requestOf(), CONTEXT)).usage).toEqual(usageOf(9, true))

    // Anthropic sends one at message_start and one at message_delta; a non-final reading
    // arriving late must not displace the final one (invariant 1).
    const descending = new ScriptedProvider([
      { type: 'usage', usage: usageOf(9, true) },
      { type: 'usage', usage: usageOf(1, false) },
      { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
    ])
    expect((await descending.complete(requestOf(), CONTEXT)).usage).toEqual(usageOf(9, true))
  })

  it('surfaces an error and keeps the content that arrived', async () => {
    const error: Extract<StreamEvent, { type: 'error' }> = {
      type: 'error',
      code: 'overloaded',
      retryable: true,
      retryAfterMs: 1500,
      status: 529,
      providerCode: 'overloaded_error',
      detail: 'upstream busy',
    }
    const provider = new ScriptedProvider([
      { type: 'text-delta', index: 0, text: 'half a th' },
      { type: 'usage', usage: usageOf(4, true) },
      error,
    ])
    const result = await provider.complete(requestOf(), CONTEXT)
    expect(result.error).toEqual(error)
    expect(result.stop).toBeNull()
    expect(result.message.content).toEqual([{ type: 'text', text: 'half a th' }])
    expect(result.usage).toEqual(usageOf(4, true))
  })

  it('surfaces an abort and keeps the content that arrived', async () => {
    const provider = new ScriptedProvider([
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'stop', reason: 'aborted', providerReason: null },
    ])
    const result = await provider.complete(requestOf(), CONTEXT)
    expect(result.stop).toEqual({ reason: 'aborted', providerReason: null })
    expect(result.error).toBeNull()
    expect(result.message.content).toEqual([{ type: 'text', text: 'partial' }])
  })

  it('stamps thinking blocks with the provider id and the encoded model id', async () => {
    const provider = new ScriptedProvider([
      { type: 'thinking-delta', index: 0, text: 'hmm' },
      { type: 'thinking-signature', index: 0, signature: 'sig' },
      { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
    ])
    const result = await provider.complete(requestOf(), CONTEXT)
    expect(result.message.content).toEqual([
      {
        type: 'thinking',
        text: 'hmm',
        signature: 'sig',
        provider: 'scripted',
        providerModel: MODEL.id,
      },
    ])
  })

  it('reports an empty turn as empty content rather than inventing one', async () => {
    const provider = new ScriptedProvider([
      { type: 'stop', reason: 'aborted', providerReason: null },
    ])
    const result = await provider.complete(requestOf(), CONTEXT)
    expect(result.message).toEqual({ role: 'assistant', content: [] })
  })
})

describe('BaseProvider defaults', () => {
  const provider = new ScriptedProvider([])

  it('answers every optional capability with a value, so callers never null-check', () => {
    expect(provider.managesOwnContext()).toBe(false)
    expect(provider.supportsCacheControl(MODEL)).toBe(true)
    expect(provider.supportsCacheControl({ ...MODEL, supportsCacheControl: false })).toBe(false)
    expect(provider.thinkingEffortSupport(MODEL)).toBe('none')
    expect(provider.retryAdvice()).toEqual({ maxAttempts: 3, baseDelayMs: 1000 })
  })

  it('hands out a fresh retryAdvice object', () => {
    const advice = provider.retryAdvice()
    advice.maxAttempts = 99
    expect(provider.retryAdvice().maxAttempts).toBe(3)
  })

  it('leaves countTokens absent rather than stubbing it', () => {
    // A stub returning 0 would be indistinguishable from a real count of zero.
    const asProvider: Provider = provider
    expect(asProvider.countTokens).toBeUndefined()
  })
})
