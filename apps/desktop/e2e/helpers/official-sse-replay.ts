/** Step 33 old-72: synthetic response bytes only; no credentials, headers or live transport. */
import assert from 'node:assert/strict'
import { anthropicDefinition, createBlockAccumulator, createMemoryHost } from '@tenon-app/kernel'
import type { StreamEvent } from '@tenon-app/kernel'
import { fakeNetwork } from '@tenon-app/kernel/testing'

type Raw = Record<string, unknown>
export interface CapturedFrame {
  raw: string
  atMs: number
}
export interface SseCapture {
  frames: CapturedFrame[]
  tail: string
}

/** Feed original bytes before the live reader parses them. finish() preserves an incomplete tail. */
export function captureOfficialSse() {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const frames: CapturedFrame[] = []
  let pending = ''
  let lastMs = 0
  const split = () => {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(pending)
      if (boundary === null) break
      const end = boundary.index + boundary[0].length
      frames.push({ raw: pending.slice(0, end), atMs: lastMs })
      pending = pending.slice(end)
    }
  }
  return {
    feed(bytes: Uint8Array, atMs: number) {
      lastMs = atMs
      pending += decoder.decode(bytes, { stream: true })
      split()
    },
    finish(): SseCapture {
      pending += decoder.decode()
      split()
      return { frames: [...frames], tail: pending }
    },
  }
}
function data(raw: string): Raw | null {
  const body = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  return body === '' ? null : (JSON.parse(body) as Raw)
}
function kind(value: Raw): string {
  const nested = value['content_block'] ?? value['delta']
  const subtype =
    nested !== null && typeof nested === 'object' && 'type' in nested ? nested.type : ''
  return `${String(value['type'])}${subtype ? `/${String(subtype)}` : ''}`
}
function paths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix]
  return Object.entries(value)
    .flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key))
    .toSorted()
}

/**
 * Replays through the pinned SDK and actual adapter. Fixture comparison concerns frame shapes;
 * live text/signatures/tool ids and token counts are checked against their own adapter output.
 * Missing families remain explicit: this never claims a rare frame was observed live.
 */
export async function replayOfficialSse(
  capture: SseCapture,
  references: Readonly<Record<string, readonly string[]>>,
) {
  assert.equal(capture.tail, '', 'A complete comparison requires no unfinished SSE frame')
  const raw = capture.frames
    .map((frame) => data(frame.raw))
    .filter((event): event is Raw => event !== null)
  const start = raw.find((event) => event['type'] === 'message_start')?.['message'] as
    | Raw
    | undefined
  assert.ok(
    start && typeof start['model'] === 'string',
    'message_start must identify the actual model',
  )
  const model = anthropicDefinition.builtinModels.find((row) => row.id === start['model']) ?? {
    ...anthropicDefinition.builtinModels[0]!,
    id: start['model'],
  }
  const network = fakeNetwork({ kind: 'sse', frames: capture.frames.map((frame) => frame.raw) })
  const host = createMemoryHost()
  const provider = anthropicDefinition.create({
    network,
    clock: host.clock,
    config: {},
    secrets: { apiKey: 'offline-replay-only' },
  })
  const encoded = provider.encode({
    model,
    maxTokens: 4096,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Offline response replay.' }] }],
  })
  const events: StreamEvent[] = []
  for await (const event of provider.stream(encoded, {
    identity: { runId: 'offline-sse-replay', requestSeq: 1, physicalAttempt: 1 },
  }))
    events.push(event)
  assert.equal(
    events.filter((event) => event.type === 'error').length,
    0,
    'Adapter must accept the recorded stream',
  )
  assert.equal(events.filter((event) => event.type === 'stop').length, 1)
  const accumulator = createBlockAccumulator({ provider: 'anthropic', providerModel: model.id })
  for (const event of events) accumulator.apply(event)
  const deltas = (type: string, field: string) =>
    raw
      .filter(
        (event) =>
          event['type'] === 'content_block_delta' && (event['delta'] as Raw)['type'] === type,
      )
      .map((event) => ({ index: event['index'], value: (event['delta'] as Raw)[field] }))
  for (const [wireType, wireField, adapterType, adapterField] of [
    ['text_delta', 'text', 'text-delta', 'text'],
    ['thinking_delta', 'thinking', 'thinking-delta', 'text'],
    ['signature_delta', 'signature', 'thinking-signature', 'signature'],
    ['input_json_delta', 'partial_json', 'tool-call-args-delta', 'json'],
  ] as const) {
    assert.deepEqual(
      events
        .filter((event) => event.type === adapterType)
        .map((event) => {
          const row = event as unknown as Raw
          return { index: row['index'], value: row[adapterField] }
        }),
      deltas(wireType, wireField),
      `Every ${wireType} must survive adapter replay verbatim`,
    )
  }
  const tools = raw.filter(
    (event) =>
      event['type'] === 'content_block_start' &&
      (event['content_block'] as Raw)['type'] === 'tool_use',
  )
  for (const tool of tools) {
    const block = tool['content_block'] as Raw
    const json = deltas('input_json_delta', 'partial_json')
      .filter((delta) => delta.index === tool['index'])
      .map((delta) => delta.value)
      .join('')
    const end = events.find(
      (event) => event.type === 'tool-call-end' && event.index === tool['index'],
    )
    assert.ok(end && end.type === 'tool-call-end', 'Complete tool input must produce tool-call-end')
    assert.equal(end.id, block['id'])
    assert.equal(end.name, block['name'])
    assert.deepEqual(end.input, json ? JSON.parse(json) : block['input'])
  }
  const finalRaw = raw.findLast((event) => event['type'] === 'message_delta')
  assert.ok(finalRaw, 'Final usage and stop must be present')
  const usage = { ...(start['usage'] as Raw), ...(finalRaw['usage'] as Raw) }
  const finalUsage = events.find((event) => event.type === 'usage' && event.usage.final)
  assert.ok(finalUsage && finalUsage.type === 'usage')
  for (const [wireField, normalized] of [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['cache_read_input_tokens', 'cacheReadTokens'],
    ['cache_creation_input_tokens', 'cacheWriteTokens'],
  ] as const)
    assert.equal(finalUsage.usage[normalized], usage[wireField] ?? 0)
  const reasoning = usage['output_tokens_details'] as Raw | undefined
  assert.equal(finalUsage.usage.reasoningTokens, reasoning?.['thinking_tokens'] ?? 0)
  assert.equal(events.at(-1)?.type, 'stop')
  const stop = events.at(-1)
  assert.ok(stop?.type === 'stop')
  assert.equal(stop.providerReason, (finalRaw['delta'] as Raw)['stop_reason'])
  const referenceRows = Object.entries(references).flatMap(([fixture, frames]) =>
    frames.flatMap((frame, index) => {
      const value = data(frame)
      return value ? [{ fixture, index, kind: kind(value), paths: paths(value) }] : []
    }),
  )
  const manifest = raw.map((event, index) => {
    const shape = paths(event)
    const matches = referenceRows.filter((row) => row.kind === kind(event))
    return {
      index,
      kind: kind(event),
      paths: shape,
      fixtureComparisons: matches.map((row) => ({
        fixture: row.fixture,
        index: row.index,
        added: shape.filter((path) => !row.paths.includes(path)),
        missing: row.paths.filter((path) => !shape.includes(path)),
      })),
    }
  })
  const observed = [...new Set(manifest.map((row) => row.kind))]
  const unobserved = [...new Set(referenceRows.map((row) => row.kind))].filter(
    (value) => !observed.includes(value),
  )
  return {
    model: start['model'],
    manifest,
    observed,
    unobserved,
    events,
    content: accumulator.content(),
    pingAtMs: capture.frames
      .filter((frame) => data(frame.raw)?.['type'] === 'ping')
      .map((frame) => frame.atMs),
  }
}
