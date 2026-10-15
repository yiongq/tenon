/**
 * The line under the latest turn while a Run is going (components.md `StatusLine`): which words,
 * from what the window already knows — `run.state` and the thread — and when there is no line at
 * all. No kernel event is read that does not already exist.
 */
import { describe, expect, it } from 'vitest'
import { statusLineOf } from '../src/renderer/src/lib/status-line.js'
import type { StatusLineInput } from '../src/renderer/src/lib/status-line.js'
import type { Part, ToolPart, Turn } from '../src/renderer/src/runtime/thread-model.js'

const NOW = 100_000

function turn(role: Turn['role'], status: Turn['status'], ...parts: Part[]): Turn {
  return { id: `${role}-${String(parts.length)}`, role, parts, status, runId: null, createdAt: 0 }
}
const userTurn = turn('user', 'complete', { kind: 'text', text: 'hi' })
const thinking: Part = { kind: 'thinking', text: 'hm', startedAt: null, endedAt: null }
const text: Part = { kind: 'text', text: 'Answer' }
const tool = (outcome: ToolPart['outcome'] = null): Part => ({
  kind: 'tool',
  callKey: 'run:1:0',
  name: 'Read',
  input: {},
  outcome,
  run: 1,
})

function running(over: Partial<StatusLineInput> & Pick<StatusLineInput, 'turns'>): StatusLineInput {
  return { running: true, since: NOW - 7_400, now: NOW, ...over }
}

describe('statusLineOf', () => {
  it('says nothing while no Run is going', () => {
    expect(
      statusLineOf({
        running: false,
        turns: [userTurn, turn('assistant', 'complete', text)],
        since: null,
        now: NOW,
      }),
    ).toBeNull()
  })

  it('says 思考中 until something comes back: the user message is last', () => {
    expect(statusLineOf(running({ turns: [userTurn] }))).toEqual({ kind: 'thinking' })
    expect(statusLineOf(running({ turns: [] }))).toEqual({ kind: 'thinking' })
    // A new Run (a resume, 「继续」) has not drawn its reply yet: the old complete one is not it.
    expect(
      statusLineOf(running({ turns: [userTurn, turn('assistant', 'complete', text)] })),
    ).toEqual({ kind: 'thinking' })
  })

  it('steps aside while a thinking block is the tail: the block says 「思考中」 itself', () => {
    expect(
      statusLineOf(running({ turns: [userTurn, turn('assistant', 'running', thinking)] })),
    ).toBeNull()
    // Once text follows the thinking, the line is back.
    expect(
      statusLineOf(running({ turns: [userTurn, turn('assistant', 'running', thinking, text)] })),
    ).toEqual({ kind: 'writing' })
  })

  it('says 正在干活 while a command approved on its card runs, before the new Run has written anything', () => {
    // The reply that asked ended when it paused; the answer started a new Run, which runs the call.
    const asked = turn('assistant', 'complete', text, tool())
    expect(statusLineOf(running({ turns: [userTurn, asked] }))).toEqual({
      kind: 'working',
      seconds: 7,
    })
    // Not while the call still waits on its card (a sub-agent's card keeps the Run going).
    expect(statusLineOf(running({ turns: [userTurn, asked], waitingOn: ['run:1:0'] }))).toEqual({
      kind: 'thinking',
    })
    // Settled, it is no longer work in progress.
    const settled = turn(
      'assistant',
      'complete',
      tool({ state: 'completed' } as ToolPart['outcome']),
    )
    expect(statusLineOf(running({ turns: [userTurn, settled] }))).toEqual({ kind: 'thinking' })
  })

  it('says 撰写中 while text is the latest thing', () => {
    expect(
      statusLineOf(running({ turns: [userTurn, turn('assistant', 'running', thinking, text)] })),
    ).toEqual({ kind: 'writing' })
  })

  it('says 正在干活 with the seconds since the Run began while a tool call is the latest thing', () => {
    const calling = [userTurn, turn('assistant', 'running', text, tool())]
    expect(statusLineOf(running({ turns: calling }))).toEqual({ kind: 'working', seconds: 7 })
    // The model's next step after a result is still work, not thinking.
    const answered = tool({ state: 'completed' } as ToolPart['outcome'])
    expect(
      statusLineOf(
        running({ turns: [userTurn, turn('assistant', 'running', answered)], now: NOW + 3_000 }),
      ),
    ).toEqual({ kind: 'working', seconds: 10 })
  })

  it('counts no negative or missing seconds', () => {
    const calling = [userTurn, turn('assistant', 'running', tool())]
    expect(statusLineOf(running({ turns: calling, since: null }))).toEqual({
      kind: 'working',
      seconds: 0,
    })
    expect(statusLineOf(running({ turns: calling, since: NOW + 5_000 }))).toEqual({
      kind: 'working',
      seconds: 0,
    })
  })

  it('says nothing once stopped, while the Run is still closing: no copy of its own (02 停止与发送)', () => {
    expect(
      statusLineOf({
        running: false,
        turns: [userTurn, turn('assistant', 'running', text)],
        since: NOW - 4_000,
        now: NOW,
      }),
    ).toBeNull()
  })
})
