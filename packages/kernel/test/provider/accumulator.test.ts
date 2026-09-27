/**
 * The block accumulator: invariants 5 and 6, partial content after an abort, and the rules
 * that keep a signature and redacted data untouched.
 */
import { describe, expect, it } from 'vitest'
import { ProviderInvalidArgumentError, createBlockAccumulator } from '../../src/index.js'
import type { BlockAccumulator, StreamEvent, Usage } from '../../src/index.js'

const STAMP = { provider: 'anthropic', providerModel: 'claude-x' } as const

const USAGE: Usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

function fold(events: readonly StreamEvent[]): BlockAccumulator {
  const blocks = createBlockAccumulator(STAMP)
  for (const event of events) blocks.apply(event)
  return blocks
}

describe('block accumulator', () => {
  it('concatenates text deltas per index and orders blocks by index', () => {
    const blocks = fold([
      { type: 'text-delta', index: 1, text: 'second' },
      { type: 'text-delta', index: 0, text: 'fir' },
      { type: 'text-delta', index: 0, text: 'st' },
    ])
    expect(blocks.content()).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])
  })

  it('ignores usage and terminal events, so a caller may fold the whole stream', () => {
    const blocks = fold([
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'usage', usage: USAGE },
      { type: 'stop', reason: 'end-turn', providerReason: 'end_turn' },
      { type: 'error', code: 'server', retryable: true, providerCode: null, detail: 'x' },
    ])
    expect(blocks.content()).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('attaches a thinking signature byte for byte and stamps provider + model', () => {
    const signature = 'EqoBCkgIARAB+/9Zg=='
    const blocks = fold([
      { type: 'thinking-delta', index: 0, text: 'because ' },
      { type: 'thinking-delta', index: 0, text: 'reasons' },
      { type: 'thinking-signature', index: 0, signature },
    ])
    expect(blocks.content()).toEqual([
      {
        type: 'thinking',
        text: 'because reasons',
        signature,
        provider: STAMP.provider,
        providerModel: STAMP.providerModel,
      },
    ])
  })

  it('never rewrites a signature', () => {
    const blocks = createBlockAccumulator(STAMP)
    blocks.apply({ type: 'thinking-delta', index: 0, text: 'a' })
    blocks.apply({ type: 'thinking-signature', index: 0, signature: 'first' })
    expect(() =>
      blocks.apply({ type: 'thinking-signature', index: 0, signature: 'second' }),
    ).toThrow(ProviderInvalidArgumentError)
    const block = blocks.content()[0]
    if (block?.type !== 'thinking') throw new Error('expected a thinking block')
    expect(block.signature).toBe('first')
  })

  it('never synthesises a signature: an unsigned thinking block keeps an empty one', () => {
    // The guard then drops it as missing-signature — which is the point of not inventing one.
    const blocks = fold([{ type: 'thinking-delta', index: 0, text: 'unsigned' }])
    const block = blocks.content()[0]
    expect(block).toEqual({
      type: 'thinking',
      text: 'unsigned',
      signature: '',
      provider: STAMP.provider,
      providerModel: STAMP.providerModel,
    })
  })

  it('keeps redacted thinking opaque', () => {
    const data = 'RURBQ1RFRA=='
    const blocks = fold([{ type: 'redacted-thinking', index: 0, data }])
    expect(blocks.content()).toEqual([
      {
        type: 'redacted-thinking',
        data,
        provider: STAMP.provider,
        providerModel: STAMP.providerModel,
      },
    ])
  })

  it('invariant 5: a tool call without an end never materialises', () => {
    // What max_tokens truncation looks like on the Anthropic wire: no content_block_stop,
    // therefore no tool-call-end.
    const blocks = fold([
      { type: 'text-delta', index: 0, text: 'let me look' },
      { type: 'tool-call-start', index: 1, id: 'toolu_1', name: 'read_file' },
      { type: 'tool-call-args-delta', index: 1, json: '{"path":"/tm' },
      { type: 'stop', reason: 'max-tokens', providerReason: 'max_tokens' },
    ])
    expect(blocks.content()).toEqual([{ type: 'text', text: 'let me look' }])
  })

  it('materialises a tool request on tool-call-end', () => {
    const blocks = fold([
      { type: 'tool-call-start', index: 0, id: 'toolu_1', name: 'read_file' },
      { type: 'tool-call-args-delta', index: 0, json: '{"path":"/tmp/a"}' },
      {
        type: 'tool-call-end',
        index: 0,
        id: 'toolu_1',
        name: 'read_file',
        input: { path: '/tmp/a' },
      },
    ])
    expect(blocks.content()).toEqual([
      { type: 'tool-request', id: 'toolu_1', name: 'read_file', input: { path: '/tmp/a' } },
    ])
  })

  it('materialises a tool call handed over in one piece, with no start of its own', () => {
    // Ollama's shape: the whole call arrives at once, so the adapter has nothing to start.
    const blocks = fold([{ type: 'tool-call-end', index: 0, id: 'call_1', name: 'now', input: {} }])
    expect(blocks.content()).toEqual([
      { type: 'tool-request', id: 'call_1', name: 'now', input: {} },
    ])
  })

  it('invariant 6: empty arguments are {}, never null and never a JSON string', () => {
    const empty = fold([
      { type: 'tool-call-start', index: 0, id: 'toolu_1', name: 'now' },
      { type: 'tool-call-end', index: 0, id: 'toolu_1', name: 'now', input: {} },
    ])
    expect(empty.content()).toEqual([
      { type: 'tool-request', id: 'toolu_1', name: 'now', input: {} },
    ])

    // An adapter that lost the object (`JSON.parse('null')`) must not produce `null` input.
    const nulled = createBlockAccumulator(STAMP)
    nulled.apply({
      type: 'tool-call-end',
      index: 0,
      id: 'toolu_1',
      name: 'now',
      input: null as unknown as Record<string, unknown>,
    })
    expect(nulled.content()).toEqual([
      { type: 'tool-request', id: 'toolu_1', name: 'now', input: {} },
    ])

    // An adapter that forgot to parse is a bug, not a tool call.
    const raw = createBlockAccumulator(STAMP)
    expect(() =>
      raw.apply({
        type: 'tool-call-end',
        index: 0,
        id: 'toolu_1',
        name: 'now',
        input: '{"path":"/tmp/a"}' as unknown as Record<string, unknown>,
      }),
    ).toThrow(ProviderInvalidArgumentError)
  })

  it('copies the input one level deep, in and out', () => {
    // Deep enough to detach the block from the event object and from the block handed to an
    // earlier caller; not a clone of nested objects, which the doc comment says as much.
    const input = { path: '/tmp/a' }
    const blocks = fold([
      { type: 'tool-call-end', index: 0, id: 'toolu_1', name: 'read_file', input },
    ])
    input['path'] = '/etc/passwd'
    const first = blocks.content()[0]
    if (first?.type !== 'tool-request') throw new Error('expected a tool request')
    first.input['injected'] = true
    expect(blocks.content()).toEqual([
      { type: 'tool-request', id: 'toolu_1', name: 'read_file', input: { path: '/tmp/a' } },
    ])
  })

  it('exposes the partial content at any moment', () => {
    const blocks = createBlockAccumulator(STAMP)
    expect(blocks.content()).toEqual([])
    blocks.apply({ type: 'text-delta', index: 0, text: 'par' })
    expect(blocks.content()).toEqual([{ type: 'text', text: 'par' }])
    blocks.apply({ type: 'text-delta', index: 0, text: 'tial' })
    // An aborted run keeps exactly what arrived, and the array handed out is a copy.
    const snapshot = blocks.content()
    snapshot.push({ type: 'text', text: 'not mine' })
    expect(blocks.content()).toEqual([{ type: 'text', text: 'partial' }])
  })

  it('never produces an empty assistant message', () => {
    expect(createBlockAccumulator(STAMP).message()).toBeNull()
    // An empty text delta is not content: it would turn an aborted run into an assistant turn.
    expect(fold([{ type: 'text-delta', index: 0, text: '' }]).message()).toBeNull()
    // Nor is an empty, unsigned thinking slot: nothing to render, nothing to replay.
    expect(fold([{ type: 'thinking-delta', index: 0, text: '' }]).message()).toBeNull()
    // A signature alone IS content: it is what makes the block replayable.
    expect(fold([{ type: 'thinking-signature', index: 0, signature: 'sig' }]).content()).toEqual([
      {
        type: 'thinking',
        text: '',
        signature: 'sig',
        provider: STAMP.provider,
        providerModel: STAMP.providerModel,
      },
    ])
    // Nor is a tool call that never ended.
    expect(
      fold([
        { type: 'tool-call-start', index: 0, id: 'toolu_1', name: 'now' },
        { type: 'tool-call-args-delta', index: 0, json: '{}' },
      ]).message(),
    ).toBeNull()
    expect(fold([{ type: 'text-delta', index: 0, text: 'x' }]).message()).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'x' }],
    })
  })

  it('rejects arguments that arrive before their tool-call-start (invariant 4)', () => {
    // Ordering is the stream wrapper's job; an unordered fragment reaching the fold is a bug.
    const blocks = createBlockAccumulator(STAMP)
    expect(() => blocks.apply({ type: 'tool-call-args-delta', index: 0, json: '{}' })).toThrow(
      ProviderInvalidArgumentError,
    )
  })

  it('rejects a slot reused for another kind of block', () => {
    const blocks = createBlockAccumulator(STAMP)
    blocks.apply({ type: 'text-delta', index: 0, text: 'hi' })
    expect(() => blocks.apply({ type: 'thinking-delta', index: 0, text: 'no' })).toThrow(
      ProviderInvalidArgumentError,
    )
    expect(() => blocks.apply({ type: 'redacted-thinking', index: 0, data: 'x' })).toThrow(
      ProviderInvalidArgumentError,
    )
    expect(() =>
      blocks.apply({ type: 'tool-call-start', index: 0, id: 'toolu_1', name: 'now' }),
    ).toThrow(ProviderInvalidArgumentError)
  })

  it('rejects a tool call that ends twice or ends as a different call', () => {
    const twice = createBlockAccumulator(STAMP)
    twice.apply({ type: 'tool-call-start', index: 0, id: 'toolu_1', name: 'now' })
    twice.apply({ type: 'tool-call-end', index: 0, id: 'toolu_1', name: 'now', input: {} })
    expect(() =>
      twice.apply({ type: 'tool-call-end', index: 0, id: 'toolu_1', name: 'now', input: {} }),
    ).toThrow(ProviderInvalidArgumentError)

    const mismatched = createBlockAccumulator(STAMP)
    mismatched.apply({ type: 'tool-call-start', index: 0, id: 'toolu_1', name: 'now' })
    expect(() =>
      mismatched.apply({ type: 'tool-call-end', index: 0, id: 'toolu_2', name: 'now', input: {} }),
    ).toThrow(ProviderInvalidArgumentError)
  })
})

describe('block accumulator and the vendor’s verbatim content (spec 02, 01 修补 2)', () => {
  it('stamps a vendor block like a reasoning block and keeps it in slot order', () => {
    const raw: Record<string, unknown> = { type: 'future_block', n: 1 }
    const blocks = fold([
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'vendor-block', index: 1, raw, replay: 'same-model' },
      { type: 'response-model', modelId: 'claude-x-2026' },
      { type: 'text-delta', index: 2, text: 'b' },
    ])
    expect(blocks.content()).toEqual([
      { type: 'text', text: 'a' },
      { type: 'vendor', ...STAMP, raw, replay: 'same-model' },
      { type: 'text', text: 'b' },
    ])
    // A copy, one level deep like a tool call's input: the event the adapter handed over cannot
    // reach the stored block.
    raw['n'] = 2
    expect(blocks.content()[1]).toMatchObject({ raw: { n: 1 } })
  })

  it('attaches vendor fields to whatever block the slot holds, whenever they arrive', () => {
    const blocks = fold([
      { type: 'vendor-fields', index: 0, fields: { citations: [] } },
      { type: 'text-delta', index: 0, text: 'cited' },
      { type: 'thinking-delta', index: 1, text: 'hm' },
      { type: 'thinking-signature', index: 1, signature: 'sig' },
      { type: 'vendor-fields', index: 1, fields: { future_field: 1 } },
      { type: 'tool-call-start', index: 2, id: 'toolu_1', name: 'now' },
      { type: 'vendor-fields', index: 2, fields: { extra: true } },
      { type: 'tool-call-end', index: 2, id: 'toolu_1', name: 'now', input: {} },
    ])
    // The text and the tool call carry no provider of their own, so the fields get one: the guard
    // judges them against the model that sent them (01 修补 2; s6-spec-2, owner 2026-09-27). The
    // thinking block already carries it, and its fields go wherever the block goes.
    expect(blocks.content()).toEqual([
      { type: 'text', text: 'cited', vendorFields: { citations: [] }, vendorSource: STAMP },
      {
        type: 'thinking',
        text: 'hm',
        signature: 'sig',
        ...STAMP,
        vendorFields: { future_field: 1 },
      },
      {
        type: 'tool-request',
        id: 'toolu_1',
        name: 'now',
        input: {},
        vendorFields: { extra: true },
        vendorSource: STAMP,
      },
    ])
  })

  it('stamps no source on a block without vendor fields', () => {
    const blocks = fold([
      { type: 'text-delta', index: 0, text: 'plain' },
      { type: 'tool-call-start', index: 1, id: 'toolu_1', name: 'now' },
      { type: 'tool-call-end', index: 1, id: 'toolu_1', name: 'now', input: {} },
    ])
    expect(blocks.content()).toEqual([
      { type: 'text', text: 'plain' },
      { type: 'tool-request', id: 'toolu_1', name: 'now', input: {} },
    ])
  })

  it('refuses a vendor block on a slot that already holds a block', () => {
    const blocks = fold([{ type: 'text-delta', index: 0, text: 'a' }])
    expect(() =>
      blocks.apply({ type: 'vendor-block', index: 0, raw: { type: 'x' }, replay: 'never' }),
    ).toThrow(ProviderInvalidArgumentError)
  })
})
