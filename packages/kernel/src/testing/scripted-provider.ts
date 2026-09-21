/**
 * A scripted `Provider` for tests: a REAL `encode()` — the Anthropic Messages wire encoder — and a
 * `stream()` that replays the events a case wrote down.
 *
 * It exists because the session service's properties are about the TAPE, not about a vendor: what a
 * run records has to be checkable without an SDK, an SSE fixture or a network double, and the shared
 * conformance suite (which ships from `@tenon-app/kernel/testing` and is bundled for the browser) can
 * hold nothing host-specific. `encode()` is the real one all the same: acceptance 3 compares a
 * recorded `promptHash` against a re-encode, and a fake encoder would prove nothing about that.
 *
 * `stream()` goes through the kernel's own `withTerminalEvent`, so a scripted run obeys invariants 1-4
 * exactly like an adapter: exactly one terminal event, an abort — before the call or mid-stream —
 * becoming `stop{ aborted }` without touching the source, and nothing after the terminal.
 */
import { BaseProvider, withTerminalEvent } from '../provider/base.js'
import type {
  EncodedRequest,
  ModelInfo,
  Provider,
  ProviderId,
  ProviderRequest,
  SendContext,
  StopReason,
  StreamEvent,
  Usage,
} from '../provider/types.js'
import { encodeAnthropicMessages } from '../provider/wire/anthropic-messages.js'

export interface ScriptedProviderOptions {
  /** Default `'anthropic'`: the encoder refuses a `ModelInfo` belonging to another provider. */
  readonly id?: ProviderId
  readonly models: readonly ModelInfo[]
}

export interface ScriptedProvider extends Provider {
  /** Queues what ONE run's stream yields, in order, terminal event included. FIFO across runs. */
  script(events: readonly StreamEvent[]): void
  /** Runs that reached the source. An already-aborted signal must never get this far (invariant 2). */
  readonly starts: number
  /** The encoded requests `stream()` was handed, in order. */
  readonly requests: readonly EncodedRequest[]
}

export function createScriptedProvider(options: ScriptedProviderOptions): ScriptedProvider {
  return new ScriptedWire(options)
}

class ScriptedWire extends BaseProvider implements ScriptedProvider {
  readonly id: ProviderId
  readonly #models: readonly ModelInfo[]
  readonly #queue: Array<readonly StreamEvent[]> = []
  readonly #requests: EncodedRequest[] = []
  #starts = 0

  constructor(options: ScriptedProviderOptions) {
    super()
    this.id = options.id ?? 'anthropic'
    this.#models = [...options.models]
  }

  get starts(): number {
    return this.#starts
  }

  get requests(): readonly EncodedRequest[] {
    return this.#requests
  }

  script(events: readonly StreamEvent[]): void {
    this.#queue.push([...events])
  }

  models(): Promise<ModelInfo[]> {
    return Promise.resolve([...this.#models])
  }

  encode(req: ProviderRequest): EncodedRequest {
    return encodeAnthropicMessages(req, this.id)
  }

  stream(encoded: EncodedRequest, ctx: SendContext): AsyncIterable<StreamEvent> {
    return withTerminalEvent(
      () => {
        this.#starts += 1
        this.#requests.push(encoded)
        const events = this.#queue.shift()
        if (events === undefined) {
          // Loud on purpose: a run with no script is a test that forgot one, and the alternative
          // (an empty stream) would be recorded as a plausible-looking truncated-body error.
          throw new Error('scripted provider: no script queued for this run')
        }
        return replay(events)
      },
      {
        mapError: (error) => ({
          type: 'error',
          code: 'unknown',
          retryable: false,
          providerCode: null,
          detail: String(error),
        }),
        signal: ctx.signal,
      },
    )
  }
}

async function* replay(events: readonly StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) yield event
}

export interface ScriptedTurnOptions {
  /** One text block, one `text-delta` per entry — the unit an abort test stops at. */
  readonly deltas?: readonly string[]
  /** The final reading. Omitted = a stream that carried none, which a fact records as null. */
  readonly usage?: Usage
  /** Default: `stop{ end-turn }`. An `error` event here is a failed turn. */
  readonly terminal?: StreamEvent
}

/** One run's script: deltas, then the usage reading, then the terminal event — invariant 1's order. */
export function scriptedTurn(options: ScriptedTurnOptions = {}): StreamEvent[] {
  const events: StreamEvent[] = (options.deltas ?? []).map((text) => ({
    type: 'text-delta',
    index: 0,
    text,
  }))
  if (options.usage !== undefined) events.push({ type: 'usage', usage: options.usage })
  events.push(options.terminal ?? stopEvent('end-turn', 'end_turn'))
  return events
}

export function stopEvent(
  reason: StopReason,
  providerReason: string | null = null,
): Extract<StreamEvent, { type: 'stop' }> {
  return { type: 'stop', reason, providerReason }
}
