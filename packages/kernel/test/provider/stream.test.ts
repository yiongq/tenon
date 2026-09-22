/**
 * The terminal-event wrapper over scripted async iterables: invariants 1-3 (exactly one
 * terminal event, and it is last; an abort is a stop, never an error or a rejection; a throw
 * becomes an `error` event) plus invariant 4's ordering buffer.
 */
import { describe, expect, it } from 'vitest'
import { createBlockAccumulator, withTerminalEvent } from '../../src/index.js'
import type { StreamEvent, Usage } from '../../src/index.js'

type ErrorEvent = Extract<StreamEvent, { type: 'error' }>

const USAGE: Usage = {
  inputTokens: 7,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

function mapped(error: unknown): ErrorEvent {
  return {
    type: 'error',
    code: 'server',
    retryable: true,
    providerCode: null,
    detail: `mapped: ${String(error)}`,
  }
}

/** Fails the test if it runs: these streams must not reach the mapper. */
function neverMaps(error: unknown): ErrorEvent {
  throw new Error(`mapError should not have been called (${String(error)})`)
}

function scripted(events: readonly StreamEvent[]): () => AsyncIterable<StreamEvent> {
  return async function* source() {
    for (const event of events) yield event
  }
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function terminalsOf(events: readonly StreamEvent[]): StreamEvent[] {
  return events.filter((event) => event.type === 'stop' || event.type === 'error')
}

describe('withTerminalEvent', () => {
  it('forwards the source terminal once, as the last event', async () => {
    const events = await collect(
      withTerminalEvent(
        scripted([
          { type: 'text-delta', index: 0, text: 'hi' },
          { type: 'usage', usage: USAGE },
          { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
        ]),
        { mapError: neverMaps, signal: undefined },
      ),
    )
    expect(events).toEqual([
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'usage', usage: USAGE },
      { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
    ])
    expect(terminalsOf(events)).toHaveLength(1)
  })

  it('drops everything the source emits after its own terminal', async () => {
    const events = await collect(
      withTerminalEvent(
        scripted([
          { type: 'stop', reason: 'tool-use', providerReason: 'tool_use' },
          { type: 'usage', usage: USAGE },
          { type: 'text-delta', index: 0, text: 'after' },
          { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
        ]),
        { mapError: neverMaps, signal: undefined },
      ),
    )
    // Invariant 1 verbatim: one terminal, it is last, and every usage precedes it.
    expect(events).toEqual([{ type: 'stop', reason: 'tool-use', providerReason: 'tool_use' }])
  })

  it('turns a throw into an error event through the adapter mapper', async () => {
    const thrown = new Error('overloaded_error')
    const seen: unknown[] = []
    async function* throwing(): AsyncIterable<StreamEvent> {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      throw thrown
    }
    const events = await collect(
      withTerminalEvent(() => throwing(), {
        mapError: (error) => {
          seen.push(error)
          return mapped(error)
        },
        signal: undefined,
      }),
    )
    expect(events).toEqual([{ type: 'text-delta', index: 0, text: 'partial' }, mapped(thrown)])
    expect(seen).toEqual([thrown])
  })

  it('maps a factory that throws while building its stream', async () => {
    // An adapter whose factory constructs the SDK stream eagerly throws before the first
    // next(); invariant 3 says stream() does not reject, so it takes the mapError route too.
    const thrown = new Error('eager-construct')
    const events = await collect(
      withTerminalEvent(
        () => {
          throw thrown
        },
        { mapError: mapped, signal: undefined },
      ),
    )
    expect(events).toEqual([mapped(thrown)])
  })

  it('yields stop{aborted} when the factory throws because the signal aborted', async () => {
    // The SDK raises APIUserAbortError while building the request: still an abort, not an
    // error (invariant 2).
    const controller = new AbortController()
    const events = await collect(
      withTerminalEvent(
        () => {
          controller.abort()
          throw new DOMException('The operation was aborted.', 'AbortError')
        },
        { mapError: neverMaps, signal: controller.signal },
      ),
    )
    expect(events).toEqual([{ type: 'stop', reason: 'aborted', providerReason: null }])
  })

  it('terminates a source that simply ran out', async () => {
    // Both SDK iterators only finish after their end-of-stream frame, so ending without a
    // terminal means a truncated body: a retryable network error, never a clean stop. With
    // no signal passed there is no abort oracle, so this outcome is deliberate: a
    // cancellation that does not go through `options.signal` reads as a truncated stream.
    const events = await collect(
      withTerminalEvent(scripted([{ type: 'text-delta', index: 0, text: 'cut' }]), {
        mapError: neverMaps,
        signal: undefined,
      }),
    )
    expect(events).toEqual([
      { type: 'text-delta', index: 0, text: 'cut' },
      {
        type: 'error',
        code: 'network',
        retryable: true,
        providerCode: null,
        detail: 'stream ended without a terminal event',
      },
    ])
  })

  it('yields stop{aborted} for a signal that was already aborted, without touching the source', async () => {
    const controller = new AbortController()
    controller.abort()
    let created = 0
    const events = await collect(
      withTerminalEvent(
        () => {
          created += 1
          return scripted([{ type: 'text-delta', index: 0, text: 'never' }])()
        },
        { mapError: neverMaps, signal: controller.signal },
      ),
    )
    expect(events).toEqual([{ type: 'stop', reason: 'aborted', providerReason: null }])
    // Invariant 2: a pre-aborted call never reaches the wire.
    expect(created).toBe(0)
  })

  it('yields stop{aborted} when the source throws its abort error mid-stream', async () => {
    const controller = new AbortController()
    async function* aborting(): AsyncIterable<StreamEvent> {
      yield { type: 'text-delta', index: 0, text: 'part' }
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    const events = await collect(
      withTerminalEvent(() => aborting(), { mapError: neverMaps, signal: controller.signal }),
    )
    expect(events).toEqual([
      { type: 'text-delta', index: 0, text: 'part' },
      { type: 'stop', reason: 'aborted', providerReason: null },
    ])
  })

  it('yields stop{aborted} when the source ends silently mid-stream', async () => {
    // What a real mid-stream abort looks like on both SDKs: the iterator just finishes.
    const controller = new AbortController()
    async function* aborting(): AsyncIterable<StreamEvent> {
      yield { type: 'text-delta', index: 0, text: 'part' }
      controller.abort()
    }
    const events = await collect(
      withTerminalEvent(() => aborting(), { mapError: neverMaps, signal: controller.signal }),
    )
    expect(events).toEqual([
      { type: 'text-delta', index: 0, text: 'part' },
      { type: 'stop', reason: 'aborted', providerReason: null },
    ])
  })

  it('yields stop{aborted} when the abort lands while the consumer is working', async () => {
    const controller = new AbortController()
    const stream = withTerminalEvent(
      scripted([
        { type: 'text-delta', index: 0, text: 'a' },
        { type: 'text-delta', index: 0, text: 'b' },
        { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
      ]),
      { mapError: neverMaps, signal: controller.signal },
    )
    const events: StreamEvent[] = []
    for await (const event of stream) {
      events.push(event)
      if (events.length === 1) controller.abort()
    }
    expect(events).toEqual([
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'stop', reason: 'aborted', providerReason: null },
    ])
  })

  it('holds tool-call arguments back until their tool-call-start (invariant 4)', async () => {
    // The OpenAI wire shape: fragments can arrive before the id and name are known.
    const events = await collect(
      withTerminalEvent(
        scripted([
          { type: 'tool-call-args-delta', index: 0, json: '{"pa' },
          { type: 'tool-call-args-delta', index: 0, json: 'th":' },
          { type: 'tool-call-start', index: 0, id: 'call_1', name: 'read_file' },
          { type: 'tool-call-args-delta', index: 0, json: '"/tmp/a"}' },
          {
            type: 'tool-call-end',
            index: 0,
            id: 'call_1',
            name: 'read_file',
            input: { path: '/tmp/a' },
          },
          { type: 'stop', reason: 'tool-use', providerReason: 'tool_calls' },
        ]),
        { mapError: neverMaps, signal: undefined },
      ),
    )
    expect(events.map((event) => event.type)).toEqual([
      'tool-call-start',
      'tool-call-args-delta',
      'tool-call-args-delta',
      'tool-call-args-delta',
      'tool-call-end',
      'stop',
    ])
    expect(events.slice(1, 4)).toEqual([
      { type: 'tool-call-args-delta', index: 0, json: '{"pa' },
      { type: 'tool-call-args-delta', index: 0, json: 'th":' },
      { type: 'tool-call-args-delta', index: 0, json: '"/tmp/a"}' },
    ])
  })

  it('buffers per index and drops fragments whose index never started', async () => {
    const events = await collect(
      withTerminalEvent(
        scripted([
          { type: 'tool-call-args-delta', index: 1, json: 'orphan' },
          { type: 'tool-call-args-delta', index: 0, json: '{}' },
          { type: 'tool-call-start', index: 0, id: 'call_0', name: 'now' },
          { type: 'stop', reason: 'tool-use', providerReason: 'tool_calls' },
        ]),
        { mapError: neverMaps, signal: undefined },
      ),
    )
    // Index 1 neither started nor ended, so no tool request could have materialised from
    // its fragments: nothing downstream can tell they existed.
    expect(events).toEqual([
      { type: 'tool-call-start', index: 0, id: 'call_0', name: 'now' },
      { type: 'tool-call-args-delta', index: 0, json: '{}' },
      { type: 'stop', reason: 'tool-use', providerReason: 'tool_calls' },
    ])
  })

  it('delivers a start-less tool-call-end and drops the fragments held for it', async () => {
    // An OpenAI-compatible endpoint that only reveals the tool id in its last chunk sends
    // fragments first and then one chunk carrying id, name and parsed arguments. Refusing
    // that shape would throw out of the generator and leave the whole turn — text, tool
    // call, usage, stop — with no terminal event at all (invariant 1). The fragments carry
    // nothing the fold reads, so they are what gets dropped.
    const end: StreamEvent = {
      type: 'tool-call-end',
      index: 1,
      id: 'call_x',
      name: 'read_file',
      input: { path: '/etc/hosts' },
    }
    const events = await collect(
      withTerminalEvent(
        scripted([
          { type: 'text-delta', index: 0, text: 'Let me read that file.' },
          { type: 'tool-call-args-delta', index: 1, json: '{"path":' },
          { type: 'tool-call-args-delta', index: 1, json: '"/etc/hosts"}' },
          end,
          { type: 'usage', usage: USAGE },
          { type: 'stop', reason: 'tool-use', providerReason: 'tool_calls' },
        ]),
        { mapError: neverMaps, signal: undefined },
      ),
    )
    expect(events).toEqual([
      { type: 'text-delta', index: 0, text: 'Let me read that file.' },
      end,
      { type: 'usage', usage: USAGE },
      { type: 'stop', reason: 'tool-use', providerReason: 'tool_calls' },
    ])
    // The turn survives all the way into content: the tool request is fully specified, which
    // is why dropping the fragments costs nothing (the fold never read them).
    const blocks = createBlockAccumulator({ provider: 'openai-compatible', providerModel: 'm' })
    for (const event of events) blocks.apply(event)
    expect(blocks.content()).toEqual([
      { type: 'text', text: 'Let me read that file.' },
      { type: 'tool-request', id: 'call_x', name: 'read_file', input: { path: '/etc/hosts' } },
    ])
  })

  it('yields stop{aborted} when the abort lands while the pull is parked', async () => {
    // A source parked on a silent socket — a half-open TCP connection, a stalling proxy —
    // must not be able to outlive a Stop: the signal is the wrapper's abort oracle, so it
    // races every pull rather than being polled between events (invariant 2, and phase 2's
    // "stop = kill"). No timer: the source aborts as it parks.
    const controller = new AbortController()
    let pulls = 0
    const parked = () => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<StreamEvent>> => {
          pulls += 1
          controller.abort()
          return new Promise<IteratorResult<StreamEvent>>(() => {})
        },
      }),
    })
    const events = await collect(
      withTerminalEvent(parked, { mapError: neverMaps, signal: controller.signal }),
    )
    expect(events).toEqual([{ type: 'stop', reason: 'aborted', providerReason: null }])
    expect(pulls).toBe(1)
  })

  it('delivers the terminal even when the abandoned source never finishes closing', async () => {
    // The pull we walked away from is still pending, and an async iterator queues return()
    // behind it: awaiting the close would hand the stalled source back the power the abort
    // race just took away from it.
    const controller = new AbortController()
    const events = await collect(
      withTerminalEvent(
        () => ({
          [Symbol.asyncIterator]: () => ({
            next: (): Promise<IteratorResult<StreamEvent>> => {
              controller.abort()
              return new Promise<IteratorResult<StreamEvent>>(() => {})
            },
            return: (): Promise<IteratorResult<StreamEvent>> =>
              new Promise<IteratorResult<StreamEvent>>(() => {}),
          }),
        }),
        { mapError: neverMaps, signal: controller.signal },
      ),
    )
    expect(events).toEqual([{ type: 'stop', reason: 'aborted', providerReason: null }])
  })

  it('releases the source body before delivering the terminal', async () => {
    const log: string[] = []
    async function* source(): AsyncIterable<StreamEvent> {
      try {
        yield { type: 'text-delta', index: 0, text: 'a' }
        yield { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' }
        yield { type: 'text-delta', index: 0, text: 'never' }
      } finally {
        log.push('closed')
      }
    }
    for await (const event of withTerminalEvent(() => source(), {
      mapError: neverMaps,
      signal: undefined,
    })) {
      log.push(`received:${event.type}`)
    }
    expect(log).toEqual(['received:text-delta', 'closed', 'received:stop'])
  })

  it('survives a source whose return() throws', async () => {
    const stream = withTerminalEvent(
      () => ({
        [Symbol.asyncIterator]: () => {
          let sent = false
          return {
            next: async (): Promise<IteratorResult<StreamEvent>> => {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: { type: 'text-delta', index: 0, text: 'a' } }
            },
            return: async (): Promise<IteratorResult<StreamEvent>> => {
              throw new Error('the body was already gone')
            },
          }
        },
      }),
      { mapError: neverMaps, signal: undefined },
    )
    const events = await collect(stream)
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'network',
      retryable: true,
      providerCode: null,
      detail: 'stream ended without a terminal event',
    })
    expect(terminalsOf(events)).toHaveLength(1)
  })
})
