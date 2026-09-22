/**
 * Type-level guards on the Provider interface. `pnpm typecheck` is the assertion here: each
 * @ts-expect-error fails the build the day the interface starts accepting the shape it
 * describes, and the runtime expectations exist only to keep the objects alive.
 */
import { describe, expect, it } from 'vitest'
import { BaseProvider } from '../../src/index.js'
import type {
  CompleteResult,
  EncodedRequest,
  ModelInfo,
  Provider,
  ProviderRequest,
  StreamEvent,
} from '../../src/index.js'

const ENCODED: EncodedRequest = {
  providerId: 'typed',
  modelId: 'model-a',
  body: {},
  promptHash: 'prompt-hash',
  toolDefinitionsHash: 'tools-hash',
  thinkingDecisions: [],
}

const RESULT: CompleteResult = {
  message: { role: 'assistant', content: [] },
  usage: null,
  stop: null,
  error: null,
}

async function* noEvents(): AsyncIterable<StreamEvent> {
  // Nothing: the shape is what is under test.
}

describe('the Provider interface', () => {
  it('rejects a stream() that rejects by type', () => {
    const provider: Provider = {
      id: 'bad-stream',
      models: () => Promise.resolve([]),
      encode: () => ENCODED,
      // stream() returns an AsyncIterable, never a promise of one: a promise can reject, and
      // invariant 3 says wire failures arrive as `error` EVENTS, not as a rejection.
      // @ts-expect-error a promise of a stream does not satisfy stream()
      stream: () => Promise.resolve(noEvents()),
      complete: () => Promise.resolve(RESULT),
      managesOwnContext: () => false,
      supportsCacheControl: () => false,
      thinkingEffortSupport: () => 'none',
      retryAdvice: () => ({ maxAttempts: 1, baseDelayMs: 0 }),
    }
    expect(provider.id).toBe('bad-stream')
  })

  it('rejects an async encode()', () => {
    const provider: Provider = {
      id: 'async-encode',
      models: () => Promise.resolve([]),
      // encode() is pure and synchronous — what is hashed has to be computable before any
      // I/O exists (invariant 7).
      // @ts-expect-error a promise of an EncodedRequest does not satisfy encode()
      encode: () => Promise.resolve(ENCODED),
      stream: () => noEvents(),
      complete: () => Promise.resolve(RESULT),
      managesOwnContext: () => false,
      supportsCacheControl: () => false,
      thinkingEffortSupport: () => 'none',
      retryAdvice: () => ({ maxAttempts: 1, baseDelayMs: 0 }),
    }
    expect(provider.id).toBe('async-encode')
  })

  it('requires the defaulted members, so a caller never null-checks them', () => {
    // @ts-expect-error complete / managesOwnContext / retryAdvice are not optional
    const provider: Provider = {
      id: 'partial',
      models: () => Promise.resolve([]),
      encode: () => ENCODED,
      stream: () => noEvents(),
      supportsCacheControl: () => false,
      thinkingEffortSupport: () => 'none',
    }
    expect(provider.id).toBe('partial')
  })

  it('is satisfied by a BaseProvider subclass that adds only the abstract four', () => {
    class MinimalProvider extends BaseProvider {
      readonly id = 'minimal'

      models(): Promise<ModelInfo[]> {
        return Promise.resolve([])
      }

      encode(_req: ProviderRequest): EncodedRequest {
        return ENCODED
      }

      stream(): AsyncIterable<StreamEvent> {
        return noEvents()
      }
    }
    const provider: Provider = new MinimalProvider()
    expect(provider.managesOwnContext()).toBe(false)
    // Truly optional and truly absent.
    expect(provider.countTokens).toBeUndefined()
  })
})
