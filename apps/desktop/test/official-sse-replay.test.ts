import { expect, it } from 'vitest'
import {
  PLAIN_TEXT_FRAMES,
  THINKING_FRAMES,
  ONE_TOOL_CALL_FRAMES,
  THINKING_SIGNATURE,
  TOOL_INPUT,
} from '../../../packages/kernel/test/provider/fixtures/anthropic-sse.js'
import { captureOfficialSse, replayOfficialSse } from '../e2e/helpers/official-sse-replay.js'
const references = { PLAIN_TEXT_FRAMES, THINKING_FRAMES, ONE_TOOL_CALL_FRAMES }
it.each(Object.entries(references))(
  'replays the existing %s fixture through the real adapter',
  async (name, frames) => {
    const capture = captureOfficialSse()
    const bytes = new TextEncoder().encode(frames.join(''))
    // Real HTTP chunks may split SSE delimiters and JSON; capture must preserve every byte.
    for (let i = 0; i < bytes.length; i += 17) capture.feed(bytes.slice(i, i + 17), i)
    const saved = capture.finish()
    expect(saved.frames.map((frame) => frame.raw).join('')).toBe(frames.join(''))
    const result = await replayOfficialSse(saved, references)
    expect(result.events.at(-1)?.type).toBe('stop')
    expect(
      result.manifest.every((row) =>
        row.fixtureComparisons.some(
          (comparison) => comparison.added.length === 0 && comparison.missing.length === 0,
        ),
      ),
    ).toBe(true)
    const expected: Record<string, { block: object; pings: number; absent: string }> = {
      THINKING_FRAMES: {
        block: { type: 'thinking', signature: THINKING_SIGNATURE },
        pings: 0,
        absent: 'content_block_delta/input_json_delta',
      },
      ONE_TOOL_CALL_FRAMES: {
        block: { type: 'tool-request', input: TOOL_INPUT },
        pings: 0,
        absent: 'content_block_delta/signature_delta',
      },
      PLAIN_TEXT_FRAMES: {
        block: { type: 'text', text: 'Hello, world' },
        pings: 1,
        absent: 'content_block_delta/signature_delta',
      },
    }
    const wanted = expected[name]!
    expect(result.content).toContainEqual(expect.objectContaining(wanted.block))
    expect(result.pingAtMs).toHaveLength(wanted.pings)
    expect(result.unobserved).toContain(wanted.absent)
  },
)
it('preserves an unfinished frame and refuses to present it as complete comparison evidence', async () => {
  const capture = captureOfficialSse()
  capture.feed(new TextEncoder().encode('event: message_start\ndata: {'), 2)
  const saved = capture.finish()
  expect(saved.tail).toBe('event: message_start\ndata: {')
  await expect(replayOfficialSse(saved, references)).rejects.toThrow('unfinished SSE frame')
})
