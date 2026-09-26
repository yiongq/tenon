/**
 * Spec 02, 01 修补 6 (step 7, 旧 106): `chat.event` only adds variants. The three that step 7 adds
 * parse; phase 1's variants are unchanged.
 */
import { describe, expect, it } from 'vitest'
import { chatEventSchema } from '../src/index.js'

const SESSION = '11111111-1111-4111-8111-111111111111'

describe('chatEventSchema', () => {
  it('accepts the thinking-delta, tool-call and attempt-discarded variants', () => {
    const events = [
      { type: 'thinking-delta', sessionId: SESSION, delta: 'hmm' },
      {
        type: 'tool-call',
        sessionId: SESSION,
        callKey: '00000000-0000-4000-8000-000000000001:1:0',
        providerToolCallId: 'toolu_1',
        name: 'Read',
        input: { file_path: '/a' },
      },
      { type: 'attempt-discarded', sessionId: SESSION },
    ]
    for (const event of events) expect(chatEventSchema.parse(event)).toEqual(event)
  })

  it('refuses a tool-call without a callKey', () => {
    expect(
      chatEventSchema.safeParse({
        type: 'tool-call',
        sessionId: SESSION,
        callKey: '',
        providerToolCallId: 'x',
        name: 'Read',
        input: {},
      }).success,
    ).toBe(false)
  })

  it('keeps phase 1’s done stop reasons and error codes as they were', () => {
    for (const stopReason of ['end-turn', 'aborted', 'error']) {
      expect(
        chatEventSchema.safeParse({ type: 'done', sessionId: SESSION, stopReason }).success,
      ).toBe(true)
    }
    expect(
      chatEventSchema.safeParse({ type: 'error', sessionId: SESSION, code: 'quota-exhausted' })
        .success,
    ).toBe(false)
  })
})
