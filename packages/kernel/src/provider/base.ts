/**
 * BaseProvider plus the two pieces of stream machinery every wire adapter shares: the
 * block accumulator and the terminal-event wrapper.
 *
 * They live next to BaseProvider because `complete()` is defined in terms of them and
 * because both adapters (steps 10 and 11) must fold and terminate identically — two copies
 * would be two readings of invariants 1-6. Nothing here does I/O: the wrapper consumes an
 * iterable the adapter supplies, the accumulator is pure and synchronous.
 */
import { ProviderInvalidArgumentError } from './errors.js'
import { thinkingModelId } from './thinking.js'
import type {
  CompleteResult,
  ContentBlock,
  EncodedRequest,
  InternalMessage,
  ModelInfo,
  Provider,
  ProviderId,
  ProviderRequest,
  SendContext,
  StreamEvent,
  Usage,
} from './types.js'

/**
 * The members that are required on `Provider` but have a defaultable answer, so that a
 * caller never null-checks a capability: "unsupported" is a return value here.
 *
 * `id`, `models()`, `encode()` and `stream()` stay abstract — they are the four things a
 * new wire protocol has to say. `countTokens` is deliberately NOT defined: it is truly
 * optional, and a stub returning 0 would be indistinguishable from a real count.
 */
export abstract class BaseProvider implements Provider {
  abstract readonly id: ProviderId
  abstract models(): Promise<ModelInfo[]>
  abstract encode(req: ProviderRequest): EncodedRequest
  abstract stream(encoded: EncodedRequest, ctx: SendContext): AsyncIterable<StreamEvent>

  /**
   * encode → stream → collect. An error or an abort is reported, never swallowed, and the
   * content that did arrive is kept: `message` holds the partial turn either way.
   */
  async complete(req: ProviderRequest, ctx: SendContext): Promise<CompleteResult> {
    // A ModelInfo that names another provider is an illegal argument, and a silent one if it
    // gets through: the guard compares a block's `provider` against the target model's
    // `providerId`, so stamping from the same caller-supplied field would make rule 1 compare
    // a value with itself. Then a mis-keyed ModelInfo would label THIS provider's signed
    // thinking as someone else's, and a later turn would replay a signature to an endpoint
    // that never issued it — the Anthropic 400 invariant 7 exists to prevent.
    if (req.model.providerId !== this.id) {
      throw new ProviderInvalidArgumentError(
        `model ${req.model.id} belongs to provider "${req.model.providerId}", not "${this.id}"`,
      )
    }
    const encoded = this.encode(req)
    // Stamped from the provider that actually streamed, plus the guard's model identity (not
    // `EncodedRequest.modelId`, which is the wire id), so a block this accumulator produces
    // round-trips through decideThinking() as `replay / same-model` rather than looking like
    // a model change.
    const blocks = createBlockAccumulator({
      provider: this.id,
      providerModel: thinkingModelId(req.model),
    })
    let usage: Usage | null = null
    let stop: CompleteResult['stop'] = null
    let error: CompleteResult['error'] = null
    for await (const event of this.stream(encoded, ctx)) {
      switch (event.type) {
        case 'usage':
          // Only `final: true` reaches the Tape (invariant 1), so only a final reading is
          // kept here: a `message_start` reading must not be able to reach the fact.
          if (event.usage.final) usage = event.usage
          break
        case 'stop':
          stop = { reason: event.reason, providerReason: event.providerReason }
          break
        case 'error':
          error = event
          break
        default:
          blocks.apply(event)
      }
    }
    return {
      // CompleteResult.message is not nullable, so a run that produced nothing yields an
      // empty turn here; `blocks.message()` is what callers persist, and it is null in
      // that case — replay must never see an empty assistant turn.
      message: blocks.message() ?? { role: 'assistant', content: [] },
      usage,
      stop,
      error,
    }
  }

  managesOwnContext(): boolean {
    return false
  }

  supportsCacheControl(model: ModelInfo): boolean {
    return model.supportsCacheControl
  }

  /** The model is unused here on purpose; an adapter that knows better overrides. */
  thinkingEffortSupport(_model: ModelInfo): 'none' | 'budget' | 'effort' {
    return 'none'
  }

  /** Advice only — the retry loop itself is phase 2's. Deliberately conservative. */
  retryAdvice(): { maxAttempts: number; baseDelayMs: number } {
    return { maxAttempts: 3, baseDelayMs: 1000 }
  }
}

export interface BlockAccumulatorOptions {
  /** Stamped onto every thinking / redacted-thinking block: the guard compares on it. */
  readonly provider: ProviderId
  /**
   * The model identity to stamp: `thinkingModelId(model)`, NOT `EncodedRequest.modelId` —
   * the guard compares on the canonical model, so a resale endpoint must not read as a
   * model change. Anyone building an accumulator outside complete() picks the same pair.
   */
  readonly providerModel: string
}

export interface BlockAccumulator {
  /** Folds one event. Terminal and usage events are ignored, so a caller may pass all. */
  apply(event: StreamEvent): void
  /** The content so far — an aborted run keeps exactly what arrived. A fresh array. */
  content(): ContentBlock[]
  /** The assistant turn, or null when there is no content to persist. */
  message(): InternalMessage | null
}

/** Folds a normalised event stream into ContentBlock[] by `index`. Pure and synchronous. */
export function createBlockAccumulator(options: BlockAccumulatorOptions): BlockAccumulator {
  return new BlockFold(options)
}

/**
 * One block slot. `signature: null` means "no signature has arrived" — it is never filled
 * in with a synthesised value, because a signature Anthropic did not produce is a 400.
 */
type BlockSlot =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; signature: string | null }
  | { kind: 'redacted'; data: string }
  | {
      kind: 'tool'
      start: { id: string; name: string } | null
      end: { id: string; name: string; input: Record<string, unknown> } | null
    }

class BlockFold implements BlockAccumulator {
  readonly #provider: ProviderId
  readonly #providerModel: string
  readonly #slots = new Map<number, BlockSlot>()

  constructor(options: BlockAccumulatorOptions) {
    this.#provider = options.provider
    this.#providerModel = options.providerModel
  }

  apply(event: StreamEvent): void {
    switch (event.type) {
      case 'text-delta': {
        const slot = this.#slots.get(event.index)
        if (slot === undefined) {
          this.#slots.set(event.index, { kind: 'text', text: event.text })
          return
        }
        if (slot.kind !== 'text') throw conflict(event.index, 'text', slot)
        slot.text += event.text
        return
      }
      case 'thinking-delta': {
        const slot = this.#slots.get(event.index)
        if (slot === undefined) {
          this.#slots.set(event.index, { kind: 'thinking', text: event.text, signature: null })
          return
        }
        if (slot.kind !== 'thinking') throw conflict(event.index, 'thinking', slot)
        slot.text += event.text
        return
      }
      case 'thinking-signature': {
        const slot = this.#slots.get(event.index)
        if (slot === undefined) {
          // A signature may be the first event of its slot when the vendor sent no deltas.
          this.#slots.set(event.index, {
            kind: 'thinking',
            text: '',
            signature: event.signature,
          })
          return
        }
        if (slot.kind !== 'thinking') throw conflict(event.index, 'thinking', slot)
        if (slot.signature !== null) {
          throw new ProviderInvalidArgumentError(
            `two signatures arrived for block ${event.index}; a signature is never rewritten`,
          )
        }
        // Byte for byte, exactly as it came off the wire.
        slot.signature = event.signature
        return
      }
      case 'redacted-thinking': {
        const slot = this.#slots.get(event.index)
        // Opaque payload: appending a second one would corrupt it, so a reused slot is a bug.
        if (slot !== undefined) throw conflict(event.index, 'a free redacted slot', slot)
        this.#slots.set(event.index, { kind: 'redacted', data: event.data })
        return
      }
      case 'tool-call-start': {
        const slot = this.#slots.get(event.index)
        if (slot !== undefined) throw conflict(event.index, 'a free tool slot', slot)
        this.#slots.set(event.index, {
          kind: 'tool',
          start: { id: event.id, name: event.name },
          end: null,
        })
        return
      }
      case 'tool-call-args-delta': {
        // The fragments themselves are not kept: the parsed input arrives on
        // tool-call-end. They are folded only to enforce invariant 4's ordering, which
        // withTerminalEvent() buffers for — an unordered fragment reaching here is a bug.
        const slot = this.#slots.get(event.index)
        if (slot === undefined || slot.kind !== 'tool' || slot.start === null) {
          throw new ProviderInvalidArgumentError(
            `arguments for block ${event.index} arrived before its tool-call-start`,
          )
        }
        return
      }
      case 'tool-call-end': {
        const slot = this.#slots.get(event.index)
        const end = { id: event.id, name: event.name, input: toolInput(event) }
        if (slot === undefined) {
          // Vendors that hand over a whole tool call at once (Ollama) have no start of
          // their own; the end event carries everything the block needs.
          this.#slots.set(event.index, { kind: 'tool', start: null, end })
          return
        }
        if (slot.kind !== 'tool') throw conflict(event.index, 'tool', slot)
        if (slot.end !== null) {
          throw new ProviderInvalidArgumentError(`tool call ${event.index} ended twice`)
        }
        if (slot.start !== null && (slot.start.id !== event.id || slot.start.name !== event.name)) {
          throw new ProviderInvalidArgumentError(
            `tool call ${event.index} ended as a different call than it started`,
          )
        }
        slot.end = end
        return
      }
      // A caller may fold a whole stream; the terminal and usage events are not content.
      case 'usage':
      case 'stop':
      case 'error':
        return
    }
  }

  content(): ContentBlock[] {
    const blocks: ContentBlock[] = []
    // Ascending `index`: the slot number is the emission order on both wire protocols, and
    // sorting makes the fold independent of the order fragments happened to arrive in.
    for (const index of [...this.#slots.keys()].toSorted((a, b) => a - b)) {
      const slot = this.#slots.get(index)
      if (slot === undefined) continue
      switch (slot.kind) {
        case 'text':
          // An empty text block is not content: it would turn an aborted run into an
          // assistant turn, and both wire protocols reject one on the way back in.
          if (slot.text !== '') blocks.push({ type: 'text', text: slot.text })
          break
        case 'thinking':
          // Nothing to render and nothing to replay is not content either: an empty,
          // unsigned thinking slot would turn an aborted run into an assistant turn, the
          // same reason the empty text slot above is skipped.
          if (slot.text !== '' || slot.signature !== null) {
            blocks.push({
              type: 'thinking',
              text: slot.text,
              // Still empty when no signature arrived — the guard then drops the block as
              // missing-signature. Nothing is invented here.
              signature: slot.signature ?? '',
              provider: this.#provider,
              providerModel: this.#providerModel,
            })
          }
          break
        case 'redacted':
          blocks.push({
            type: 'redacted-thinking',
            data: slot.data,
            provider: this.#provider,
            providerModel: this.#providerModel,
          })
          break
        case 'tool':
          // Invariant 5: no tool-call-end, no tool request. A call truncated by max_tokens
          // gets no content_block_stop on the Anthropic wire, so it must never materialise.
          if (slot.end !== null) {
            blocks.push({
              type: 'tool-request',
              id: slot.end.id,
              name: slot.end.name,
              // Copied again on the way out: a caller that mutates a block it was handed
              // must not be able to reach the slot a later content() call reads.
              input: { ...slot.end.input },
            })
          }
          break
      }
    }
    return blocks
  }

  message(): InternalMessage | null {
    const content = this.content()
    return content.length === 0 ? null : { role: 'assistant', content }
  }
}

/** One `index` cannot hold two kinds of block: an adapter that reuses a slot has a bug. */
function conflict(index: number, expected: string, found: BlockSlot): ProviderInvalidArgumentError {
  return new ProviderInvalidArgumentError(
    `block ${index} is a ${found.kind} block; expected ${expected}`,
  )
}

/**
 * Invariant 6: empty arguments are `{}`, never null and never a JSON string. Absent input
 * is the documented empty case; anything else means the adapter forgot to parse, which is
 * a bug we refuse to pass on as a tool call.
 *
 * The copy is one level deep: it detaches the block from the event object, not from nested
 * objects the adapter parsed. An adapter that keeps mutating the arguments it already handed
 * over is out of contract — the fold cannot defend against that without cloning every call.
 */
function toolInput(
  event: Extract<StreamEvent, { type: 'tool-call-end' }>,
): Record<string, unknown> {
  const input: unknown = event.input
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ProviderInvalidArgumentError(
      `tool call ${event.index} carried ${typeof input} arguments; adapters parse them into an object`,
    )
  }
  return { ...(input as Record<string, unknown>) }
}

export interface TerminalStreamOptions {
  /** Turns whatever the SDK threw into the `error` event that replaces it (invariant 3). */
  readonly mapError: (error: unknown) => Extract<StreamEvent, { type: 'error' }>
  /**
   * `SendContext.signal` — required, nullable on purpose: with exactOptionalPropertyTypes an
   * adapter has to write `signal: ctx.signal` rather than forget it. This signal is the
   * wrapper's ONLY abort oracle, so every cancellation path (phase 2's "stop = kill"
   * included) must go through it; a stream that just ends with no aborted signal is a
   * truncated body, and is reported as `error{ network }`, not as `stop{ aborted }`.
   */
  readonly signal: AbortSignal | undefined
}

/**
 * Wraps an adapter's raw event stream into one that satisfies invariants 1-4.
 *
 * - exactly one terminal event (`stop` or `error`), and it is the last event; anything the
 *   source produces after its own terminal is dropped, so `usage` always precedes it. An
 *   adapter whose wire puts usage AFTER the finish reason (the OpenAI shape) must therefore
 *   defer its own terminal to the end of the iterator, which is what invariant 1 asks of it:
 *   a reading that arrives after the terminal is gone, not reordered in front of it;
 * - a throw becomes an `error` event through the adapter's `mapError`;
 * - an aborted signal — before the call or mid-stream — becomes `stop{ reason: 'aborted' }`,
 *   never an error and never a rejection;
 * - `tool-call-args-delta` is held back until its index has had a `tool-call-start`, which
 *   is where OpenAI's out-of-order fragments (step 11) are put back in order.
 *
 * `source` is a factory, not an iterable: an already-aborted signal must not touch the wire
 * (invariant 2), and an adapter that has to await its SDK does so inside an async generator
 * body, which does not run until the first `next()`.
 */
export async function* withTerminalEvent(
  source: () => AsyncIterable<StreamEvent>,
  options: TerminalStreamOptions,
): AsyncIterable<StreamEvent> {
  const signal = options.signal
  if (isAborted(signal)) {
    yield abortedStop()
    return
  }
  let iterator: AsyncIterator<StreamEvent>
  try {
    iterator = source()[Symbol.asyncIterator]()
  } catch (error) {
    // An adapter that builds its SDK stream eagerly in the factory throws here rather than
    // from next(); invariant 3 holds either way, so it takes the same route.
    yield isAborted(signal) ? abortedStop() : options.mapError(error)
    return
  }
  const started = new Set<number>()
  const held = new Map<number, Array<Extract<StreamEvent, { type: 'tool-call-args-delta' }>>>()
  // The default covers a source that simply ran out: see streamEndedEarly().
  let terminal: Extract<StreamEvent, { type: 'stop' | 'error' }> = streamEndedEarly()
  // Set when the abort race left a pull outstanding: see the close in the finally.
  let abandoned = false
  try {
    for (;;) {
      // Caught here when the abort landed while the consumer was processing an event.
      if (isAborted(signal)) {
        terminal = abortedStop()
        break
      }
      let step: IteratorResult<StreamEvent>
      try {
        // oxlint-disable-next-line no-await-in-loop -- a stream is sequential by nature
        const pulled = await pullOrAbort(iterator, signal)
        if (pulled === ABORTED) {
          // The signal beat the source. Its pull is still outstanding, which is what the
          // close below has to account for.
          abandoned = true
          terminal = abortedStop()
          break
        }
        step = pulled
      } catch (error) {
        // An abort is a stop, not an error, whether the SDK threw APIUserAbortError or the
        // body stream errored underneath it.
        terminal = isAborted(signal) ? abortedStop() : options.mapError(error)
        break
      }
      // Checked before `done`: a mid-stream abort ends both SDK iterators silently.
      if (isAborted(signal)) {
        terminal = abortedStop()
        break
      }
      if (step.done === true) break
      const event = step.value
      if (event.type === 'stop' || event.type === 'error') {
        terminal = event
        break
      }
      if (event.type === 'tool-call-args-delta' && !started.has(event.index)) {
        const queue = held.get(event.index)
        if (queue === undefined) held.set(event.index, [event])
        else queue.push(event)
        continue
      }
      if (event.type === 'tool-call-end') {
        // Fragments still held for this index are dropped, and the end event goes through.
        // Refusing the shape instead would throw out of this generator, past the `yield
        // terminal` below, and leave a complete turn — text, a fully specified tool call,
        // the final usage, the stop reason — with no terminal event at all (invariant 1).
        // The fragments are the cheap thing to lose: the fold never reads them (the parsed
        // input rides on `tool-call-end`), and a start-less end is a shape real endpoints
        // produce — Ollama hands a call over in one piece, and an OpenAI-compatible wire
        // that only reveals the tool id in its last chunk arrives fragments-first.
        held.delete(event.index)
      }
      if (event.type === 'tool-call-start') {
        started.add(event.index)
        yield event
        const queue = held.get(event.index)
        if (queue !== undefined) {
          held.delete(event.index)
          for (const delta of queue) yield delta
        }
        continue
      }
      yield event
    }
  } finally {
    // A pull we walked away from is still pending, and an async iterator queues `return()`
    // behind it: awaiting the close would hand a stalled source back the power the abort race
    // just took away from it. The close is still requested, so the body is released the
    // moment the source lets go.
    if (abandoned) void closeQuietly(iterator)
    else await closeQuietly(iterator)
  }
  // Fragments still held belong to an index that never started; whether it ended or not, no
  // tool request could have materialised from them, so nothing downstream can tell they
  // existed. The one thing that always arrives is this terminal event.
  yield terminal
}

/** What a pull returns when the signal beat the source to it. */
const ABORTED = 'aborted-by-signal'

/**
 * Awaits the next event, but gives up the moment the signal aborts.
 *
 * Polling `signal.aborted` around the pull is not enough: a source parked on a socket that
 * has gone quiet (a half-open connection, a stalling proxy) never settles, and a Stop would
 * then wait on the very thing it is cancelling. Racing makes the signal the abort oracle the
 * wrapper claims to be, whether or not the SDK propagated it into its own fetch.
 */
async function pullOrAbort(
  iterator: AsyncIterator<StreamEvent>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<StreamEvent> | typeof ABORTED> {
  if (signal === undefined) return iterator.next()
  if (signal.aborted) return ABORTED
  let onAbort: (() => void) | null = null
  // Built before the pull starts: a source that aborts synchronously inside its own next()
  // would otherwise fire the event before anyone listens, and the race would never settle.
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([iterator.next(), aborted])
  } finally {
    // One listener per pull, removed here: a long stream must not pile up reactions on a
    // promise that only ever settles if the run is cancelled.
    if (onAbort !== null) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * A function, not an inline `signal?.aborted === true`: tsc narrows the readonly `aborted`
 * property to false after the first check and never widens it again, so every later check
 * would be dead code to the compiler.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function abortedStop(): Extract<StreamEvent, { type: 'stop' }> {
  return { type: 'stop', reason: 'aborted', providerReason: null }
}

/**
 * A source that ended without a terminal event of its own. Reported as a retryable
 * `network` error rather than a clean `stop`: both SDK iterators only finish after their
 * end-of-stream frame (`message_stop` / `[DONE]`), so reaching the end without one means
 * the body was truncated. Calling it `stop{ end-turn }` would let the phase 2 loop treat a
 * truncated turn as a completed one, which is the one mistake that cannot be detected later.
 */
function streamEndedEarly(): Extract<StreamEvent, { type: 'error' }> {
  return {
    type: 'error',
    code: 'network',
    retryable: true,
    providerCode: null,
    detail: 'stream ended without a terminal event',
  }
}

/**
 * Gives the source its chance to release the HTTP body — `return()` is what closes an SDK
 * stream, and skipping it leaks the connection. A throwing `return()` is swallowed: it must
 * not replace the terminal event we are about to yield.
 */
async function closeQuietly(iterator: AsyncIterator<StreamEvent>): Promise<void> {
  try {
    await iterator.return?.()
  } catch {
    // The body is gone either way; the terminal event is what the caller needs.
  }
}
