/**
 * The DeepSeek live group's echo check (M6 验收 29, plan step 12), pinned where CI can see it: the
 * live group itself never runs there. DeepSeek documents a 400 for a request with tools that leaves
 * out an earlier assistant turn's `reasoning_content`, a turn without a tool call included; these
 * read the request record for exactly that.
 */
import { describe, expect, it } from 'vitest'
import { echoGaps, echoedReasoning, expectedEchoes } from '../e2e/helpers/reasoning-echo.js'
import type { EchoBody } from '../e2e/helpers/reasoning-echo.js'

const CALL = { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } }

/** A second turn's request: the first turn's call, its result and its reply, then the new ask. */
const SECOND_TURN = {
  messages: [
    { role: 'system', reasoning_content: 'not a turn of the model' },
    { role: 'user', reasoning_content: 'nor this' },
    { role: 'assistant', reasoning_content: 'I will read it.', tool_calls: [CALL] },
    { role: 'tool', reasoning_content: 'nor this', tool_call_id: 'call_1' },
    { role: 'assistant', reasoning_content: 'It says ALPHA.', content: 'ALPHA' },
    { role: 'user' },
  ],
}

describe('echoedReasoning (M6 验收 29)', () => {
  it('reads each assistant turn’s reasoning_content in order, one without a tool call too', () => {
    expect(echoedReasoning(SECOND_TURN)).toEqual(['I will read it.', 'It says ALPHA.'])
  })

  it('reads a turn sent without a non-empty string as not echoed', () => {
    const body: EchoBody = {
      messages: [
        { role: 'assistant' },
        { role: 'assistant', reasoning_content: '' },
        { role: 'assistant', reasoning_content: null },
        { role: 'assistant', reasoning_content: ['thinking'] },
        { role: 'assistant', reasoning_content: 'kept' },
      ],
    }
    expect(echoedReasoning(body)).toEqual([null, null, null, null, 'kept'])
  })

  it('finds no turns in a first request, a body without messages, or none', () => {
    expect(echoedReasoning({ messages: [{ role: 'user' }] })).toEqual([])
    expect(echoedReasoning({})).toEqual([])
    expect(echoedReasoning(null)).toEqual([])
  })
})

describe('echoGaps (M6 验收 29)', () => {
  it('is empty when every assistant turn of every request carried its reasoning back', () => {
    expect(echoGaps([{ messages: [{ role: 'user' }] }, SECOND_TURN, SECOND_TURN])).toEqual([])
  })

  it('names each request and turn sent without it, a reply without a tool call too', () => {
    const missing: EchoBody = {
      messages: [
        { role: 'user' },
        { role: 'assistant', reasoning_content: 'I will read it.' },
        { role: 'tool' },
        { role: 'assistant', reasoning_content: '' },
        { role: 'user' },
        { role: 'assistant' },
      ],
    }
    expect(echoGaps([{ messages: [{ role: 'user' }] }, SECOND_TURN, missing])).toEqual([
      { request: 2, turn: 1 },
      { request: 2, turn: 2 },
    ])
  })

  it('counts a body that was not JSON as a gap: nothing shows the reasoning went back', () => {
    expect(echoGaps([SECOND_TURN, null])).toEqual([{ request: 1, turn: null }])
  })
})

describe('expectedEchoes (M6 验收 29, revised 2026-10-03)', () => {
  it('expects each thinking turn back as it was and nothing for a turn that did not think', () => {
    expect(expectedEchoes(['', 'It says ALPHA.', '', 'Reading the second.'])).toEqual([
      null,
      'It says ALPHA.',
      null,
      'Reading the second.',
    ])
  })

  it('matches what echoedReasoning reads off a request that echoed exactly those turns', () => {
    const body: EchoBody = {
      messages: [
        { role: 'user' },
        { role: 'assistant' },
        { role: 'tool' },
        { role: 'assistant', reasoning_content: 'It says ALPHA.' },
        { role: 'user' },
      ],
    }
    expect(echoedReasoning(body)).toEqual(expectedEchoes(['', 'It says ALPHA.']))
    // A thinking turn sent without it does not match.
    expect(echoedReasoning(body)).not.toEqual(expectedEchoes(['I will read it.', 'It says ALPHA.']))
  })
})
