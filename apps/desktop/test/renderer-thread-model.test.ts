/**
 * The conversation model the renderer keeps (spec 02 plan step 20, the external-store runtime;
 * §界面范围「调用的键与读写的数据」, `TurnSummaryLine`, §失败卡与结束原因, §重试与「继续」,
 * §插话与输入框状态表).
 *
 * Built only from stored rows and live `chat.event`s. Every event here goes through
 * `chatEventSchema.parse` first, so the model is fed nothing the main process could not send. Chat
 * events carry no Run id until the terminal one; `RunTrack` only counts Runs by their ends, so a
 * Run's end goes on a turn of its own. Which message 「重试」 resends is the kernel's answer on that
 * terminal event (`retryOf`), never inferred from the event order.
 */
import { chatEventSchema, messageRowSchema, toolOutcomeViewSchema } from '@tenon-app/contracts'
import type {
  ChatEvent,
  MessageRowContract,
  RunEndReasonContract,
  ToolOutcomeViewContract,
} from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_THREAD,
  applyEvent,
  retryable,
  summaryBefore,
  threadFromRows,
  withSentText,
  withSettled,
  withoutTurn,
} from '../src/renderer/src/runtime/thread-model.js'
import type { Part, ThreadModel, Turn } from '../src/renderer/src/runtime/thread-model.js'

const SESSION = '0f1e2d3c-4b5a-4697-8899-aabbccddeeff'

type Body<T extends ChatEvent['type']> = Omit<Extract<ChatEvent, { type: T }>, 'sessionId' | 'type'>

/** A `chat.event` of this session, as the main process would send it. */
function event<T extends ChatEvent['type']>(type: T, body: Body<T>): ChatEvent {
  return chatEventSchema.parse({ type, sessionId: SESSION, ...body })
}

const userMessage = (messageId: string, queuedId: string | null = null): ChatEvent =>
  event('user-message', { messageId, queuedId })
const text = (delta: string): ChatEvent => event('text-delta', { delta })
const thinking = (delta: string): ChatEvent => event('thinking-delta', { delta })
const toolCall = (callKey: string, name = 'Read', input: Record<string, unknown> = {}): ChatEvent =>
  event('tool-call', { callKey, providerToolCallId: `toolu_${callKey}`, name, input })
const toolOutcome = (callKey: string, closed: ToolOutcomeViewContract): ChatEvent =>
  event('tool-outcome', { callKey, providerToolCallId: `toolu_${callKey}`, ...closed })
const discarded = (): ChatEvent => event('attempt-discarded', {})

/**
 * What a terminal event names besides its reason (each absent on an old main): the Run, the message
 * the kernel says 「重试」 resends (run-ended.retryOf), and the stop.
 */
interface Terminal {
  readonly runId?: string | null
  readonly retryOf?: string | null
  readonly stop?: 'end-turn' | 'aborted' | 'error'
}

const done = (endReason?: RunEndReasonContract, o: Terminal = {}): ChatEvent =>
  event('done', {
    stopReason: o.stop ?? 'end-turn',
    ...(endReason === undefined ? {} : { endReason }),
    ...(o.runId === undefined ? {} : { runId: o.runId }),
    ...(o.retryOf === undefined ? {} : { retryOf: o.retryOf }),
  })
const failed = (
  code: Extract<ChatEvent, { type: 'error' }>['code'],
  endReason?: RunEndReasonContract,
  o: Pick<Terminal, 'runId' | 'retryOf'> = {},
): ChatEvent =>
  event('error', {
    code,
    ...(endReason === undefined ? {} : { endReason }),
    ...(o.runId === undefined ? {} : { runId: o.runId }),
    ...(o.retryOf === undefined ? {} : { retryOf: o.retryOf }),
  })

/** A closed call's view; `state` and `effect` are what the counts and the retry rule read. */
function view(
  effect: ToolOutcomeViewContract['effect'],
  state: ToolOutcomeViewContract['state'] = 'completed',
  over: Partial<ToolOutcomeViewContract> = {},
): ToolOutcomeViewContract {
  return toolOutcomeViewSchema.parse({
    effect,
    state,
    source: state === 'completed' ? null : 'stopped',
    output: `${effect}/${state}`,
    ...over,
  })
}

const COMPLETED: RunEndReasonContract = { code: 'completed' }
const PAUSED: RunEndReasonContract = { code: 'paused', waitingFor: 'approval' }
const STOPPED: RunEndReasonContract = { code: 'user-stopped' }
const REJECTED: RunEndReasonContract = { code: 'user-rejected', toolName: 'Write' }
const TRUNCATED: RunEndReasonContract = { code: 'output-truncated', maxTokens: 1024 }
const STEP_LIMIT: RunEndReasonContract = { code: 'step-limit', limit: 100 }
const PROVIDER_ERROR: RunEndReasonContract = {
  code: 'provider-error',
  providerId: 'anthropic',
  errorCode: 'server',
  providerReason: null,
  attempts: 3,
}

/** The store's side of `applyEvent`: a clock that ticks by 10 per event, fresh local ids, the queue's texts. */
class Driver {
  model: ThreadModel
  now = 1_000
  readonly queued = new Map<string, string>()
  #ids = 0

  constructor(model: ThreadModel = EMPTY_THREAD) {
    this.model = model
  }

  /** The user's message, shown at once, as the store's send does. */
  send(value: string): string {
    const id = `local-${String((this.#ids += 1))}`
    this.model = withSentText(this.model, value, id, this.now)
    return id
  }

  apply(...events: readonly ChatEvent[]): ThreadModel {
    for (const next of events) {
      this.now += 10
      this.model = applyEvent(this.model, next, {
        now: this.now,
        nextId: () => `local-${String((this.#ids += 1))}`,
        queuedText: (queuedId) => this.queued.get(queuedId),
      })
    }
    return this.model
  }

  get turns(): readonly Turn[] {
    return this.model.turns
  }

  /** Each turn as role and a readable list of its parts. */
  shape(): string[][] {
    return this.turns.map((turn) => [turn.role, ...turn.parts.map(label)])
  }

  /** The index of the turn that carries the latest end. */
  lastEnded(): number {
    return this.turns.findLastIndex((turn) => turn.end !== undefined)
  }

  /** Every end on the thread, in order, as its code. */
  ends(): Array<string | null> {
    return this.turns.flatMap((turn) =>
      turn.end === undefined ? [] : [turn.end.endReason?.code ?? null],
    )
  }
}

function label(part: Part): string {
  switch (part.kind) {
    case 'text':
      return `text:${part.text}`
    case 'thinking':
      return `thinking:${part.text}`
    case 'tool':
      return `tool:${part.callKey}${part.outcome === null ? '' : `=${part.outcome.state}`}`
  }
}

function row(over: Partial<MessageRowContract>): MessageRowContract {
  return messageRowSchema.parse({
    sessionId: SESSION,
    messageId: 'm1',
    orderSeq: 1,
    role: 'assistant',
    status: 'complete',
    content: [],
    entryId: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  })
}

const THINKING_BLOCK = { signature: 's', provider: 'anthropic', providerModel: 'claude-x' }

describe('threadFromRows', () => {
  it('maps text, thinking and tool requests in order, and matches calls[i] to the i-th request', () => {
    const read = view('read')
    const model = threadFromRows([
      row({
        content: [
          { type: 'thinking', text: 'why', ...THINKING_BLOCK },
          { type: 'text', text: 'first' },
          { type: 'tool-request', id: 't1', name: 'Read', input: { file_path: '/a' } },
          { type: 'text', text: '' },
          { type: 'redacted-thinking', data: 'x', provider: 'anthropic', providerModel: 'm' },
          { type: 'tool-request', id: 't2', name: 'Grep', input: { pattern: 'p' } },
          { type: 'thinking', text: '', ...THINKING_BLOCK },
          { type: 'text', text: 'second' },
        ],
        // By order among the tool requests only: the blocks between them do not shift the index.
        calls: [
          { callKey: 'r1:1:0', outcome: read },
          { callKey: 'r1:1:1', outcome: null },
        ],
      }),
    ])
    expect(model.draft).toBeNull()
    expect(model.turns[0]?.parts).toEqual([
      // A replayed thinking block has no timing: the Tape keeps none.
      { kind: 'thinking', text: 'why', startedAt: null, endedAt: null },
      { kind: 'text', text: 'first' },
      // A stored call belongs to no live Run: it never counts as this Run's dispatch.
      {
        kind: 'tool',
        callKey: 'r1:1:0',
        name: 'Read',
        input: { file_path: '/a' },
        outcome: read,
        run: null,
      },
      {
        kind: 'tool',
        callKey: 'r1:1:1',
        name: 'Grep',
        input: { pattern: 'p' },
        outcome: null,
        run: null,
      },
      { kind: 'text', text: 'second' },
    ])
  })

  it('keys a request calls[] does not cover by its message id and vendor id', () => {
    const model = threadFromRows([
      row({
        messageId: 'm7',
        content: [
          { type: 'tool-request', id: 't1', name: 'Read', input: {} },
          { type: 'tool-request', id: 't2', name: 'Read', input: {} },
        ],
        calls: [{ callKey: 'r1:1:0', outcome: null }],
      }),
      row({
        messageId: 'm8',
        content: [{ type: 'tool-request', id: 't9', name: 'Glob', input: {} }],
      }),
    ])
    const keys = model.turns.map((turn) =>
      turn.parts.map((part) => (part.kind === 'tool' ? part.callKey : '')),
    )
    expect(keys).toEqual([['r1:1:0', 'm7:t2'], ['m8:t9']])
  })

  it('keeps each row’s id, role, time and status, and gives it no Run, end or optimism', () => {
    const model = threadFromRows([
      row({ messageId: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }),
      row({ messageId: 'a1', status: 'aborted', createdAt: 5, content: [] }),
      row({ messageId: 'a2', status: 'error', createdAt: 6, content: [] }),
      row({ messageId: 'a3', createdAt: 7, content: [] }),
    ])
    expect(
      model.turns.map((turn) => [turn.id, turn.role, turn.status, turn.createdAt, turn.runId]),
    ).toEqual([
      ['u1', 'user', 'complete', 1_700_000_000_000, null],
      ['a1', 'assistant', 'aborted', 5, null],
      ['a2', 'assistant', 'error', 6, null],
      ['a3', 'assistant', 'complete', 7, null],
    ])
    for (const turn of model.turns) {
      expect(turn.end).toBeUndefined()
      expect(turn.optimistic).not.toBe(true)
      expect(turn.run).toBeUndefined()
    }
  })
})

describe('withSentText and withoutTurn', () => {
  it('shows the message at once as an optimistic user turn, and takes back only that one', () => {
    const d = new Driver()
    d.apply(text('streaming'))
    const draft = d.model.draft
    const first = d.send('one')
    const second = d.send('two')
    expect(d.turns.at(-1)).toEqual({
      id: second,
      role: 'user',
      parts: [{ kind: 'text', text: 'two' }],
      status: 'complete',
      runId: null,
      createdAt: d.now,
      optimistic: true,
    })
    // The reply still streaming keeps taking deltas.
    expect(d.model.draft).toBe(draft)
    const without = withoutTurn(d.model, first)
    expect(without.turns.map((turn) => turn.id)).toEqual([d.turns[0]?.id, second])
    expect(without.draft).toBe(draft)
  })
})

describe('applyEvent: user-message', () => {
  it('confirms the optimistic turn: the Tape’s id replaces the local one, in place', () => {
    const d = new Driver()
    const local = d.send('hello')
    d.apply(userMessage('msg-1'))
    expect(d.turns).toHaveLength(1)
    expect(d.turns[0]).toMatchObject({ id: 'msg-1', optimistic: false, role: 'user' })
    expect(d.turns[0]?.parts).toEqual([{ kind: 'text', text: 'hello' }])
    expect(d.turns.some((turn) => turn.id === local)).toBe(false)
  })

  it('two sends in flight: each written message takes the oldest local turn, same words or not', () => {
    // The mailbox writes sends in the order they arrived: the first `user-message` is the first send.
    const d = new Driver()
    const first = d.send('again')
    const second = d.send('again')
    const third = d.send('something else')
    d.apply(userMessage('m1'))
    expect(d.turns.map((turn) => [turn.id, turn.optimistic])).toEqual([
      ['m1', false],
      [second, true],
      [third, true],
    ])
    d.apply(userMessage('m2'))
    expect(d.turns.map((turn) => [turn.id, turn.optimistic])).toEqual([
      ['m1', false],
      ['m2', false],
      [third, true],
    ])
    expect(d.turns.some((turn) => turn.id === first)).toBe(false)
    expect(d.shape()).toEqual([
      ['user', 'text:again'],
      ['user', 'text:again'],
      ['user', 'text:something else'],
    ])
  })

  it('a resend: the kernel wrote the same message again, and the echo 「重试」 showed goes', () => {
    // 01 spec.md:395: the same text as the last message reuses its id; the Tape has one message, so
    // the thread must too.
    const d = new Driver(
      threadFromRows([
        row({ messageId: 'u1', role: 'user', content: [{ type: 'text', text: 'try this' }] }),
        row({ messageId: 'a1', status: 'error', orderSeq: 2, content: [] }),
      ]),
    )
    const other = d.send('unrelated')
    d.send('try this')
    d.apply(userMessage('u1'))
    expect(d.turns.map((turn) => turn.id)).toEqual(['u1', 'a1', other])
    expect(d.shape()).toEqual([
      ['user', 'text:try this'],
      ['assistant'],
      ['user', 'text:unrelated'],
    ])
  })

  it('a known message with no echo of its words leaves every turn as it was', () => {
    const d = new Driver()
    d.send('hello')
    d.apply(userMessage('msg-1'), text('reply'), done(COMPLETED, { runId: 'run-1' }))
    const other = d.send('different words')
    const before = d.turns
    d.apply(userMessage('msg-1'))
    expect(d.turns).toEqual(before)
    expect(d.turns.at(-1)?.id).toBe(other)
  })

  it('ignores a message it neither sent nor has queued', () => {
    const d = new Driver()
    d.send('hello')
    d.apply(userMessage('msg-1'), text('streaming'))
    const before = d.model
    // Nothing optimistic left, no queued id: nothing to show it with.
    d.apply(userMessage('msg-2'))
    // A queued id whose text never came through chat.queue.
    d.apply(userMessage('msg-3', 'q-unknown'))
    expect(d.turns).toEqual(before.turns)
    expect(d.model.draft).toBe(before.draft)
  })

  it('inserts a queued message by its queuedId, and the reply after it starts a new turn below it', () => {
    const d = new Driver()
    d.send('first')
    d.apply(userMessage('u1'), text('Looking.'), toolCall('r1:1:0'))
    d.queued.set('q1', 'also check the tests')
    // At the batch boundary: after the result, before the next request's reply.
    d.apply(toolOutcome('r1:1:0', view('read')), userMessage('u2', 'q1'), text('Both done.'))
    expect(d.shape()).toEqual([
      ['user', 'text:first'],
      ['assistant', 'text:Looking.', 'tool:r1:1:0=completed'],
      ['user', 'text:also check the tests'],
      ['assistant', 'text:Both done.'],
    ])
    expect(d.turns[2]).toMatchObject({ id: 'u2', role: 'user', runId: null })
    expect(d.turns[2]?.optimistic).not.toBe(true)
  })

  it('closes the reply in progress when a queued message goes in', () => {
    const d = new Driver()
    d.send('first')
    d.queued.set('q1', 'queued')
    d.apply(userMessage('u1'), text('half'), userMessage('u2', 'q1'), text('next'))
    // A reply never spans a user message: `next` is below the inserted one, not glued to `half`.
    expect(d.shape()).toEqual([
      ['user', 'text:first'],
      ['assistant', 'text:half'],
      ['user', 'text:queued'],
      ['assistant', 'text:next'],
    ])
  })

  it('puts a queued message ahead of the optimistic turn it went out with', () => {
    const d = new Driver()
    d.send('first')
    d.apply(userMessage('u1'), text('reply'), done(COMPLETED))
    d.queued.set('q1', 'queued earlier')
    const local = d.send('sent now')
    // The queue goes out with the new message, ahead of it (§插话与输入框状态表).
    d.apply(userMessage('u2', 'q1'))
    expect(d.turns.map((turn) => turn.id)).toEqual(['u1', d.turns[1]?.id, 'u2', local])
    d.apply(userMessage('u3'))
    expect(d.shape().slice(2)).toEqual([
      ['user', 'text:queued earlier'],
      ['user', 'text:sent now'],
    ])
    expect(d.turns.map((turn) => turn.id).slice(2)).toEqual(['u2', 'u3'])
  })
})

describe('applyEvent: deltas', () => {
  it('starts a running assistant turn on the first text delta and appends the rest to it', () => {
    const d = new Driver()
    d.send('q')
    d.apply(userMessage('u1'), text('Hel'))
    const started = d.now
    d.apply(text('lo'), text(', world'))
    expect(d.turns).toHaveLength(2)
    expect(d.turns[1]).toMatchObject({
      role: 'assistant',
      status: 'running',
      // The Run id comes with the Run's end; while it streams the turn has none.
      runId: null,
      run: 0,
      createdAt: started,
      parts: [{ kind: 'text', text: 'Hello, world' }],
    })
    expect(d.model.draft).toBe(d.turns[1]?.id)
  })

  it('times a thinking block from its first delta to its last, and keeps blocks apart from text', () => {
    const d = new Driver()
    d.apply(thinking('Let me '))
    const first = d.now
    d.apply(thinking('think.'))
    const last = d.now
    d.apply(text('Answer.'), thinking('More'))
    const again = d.now
    expect(d.turns).toHaveLength(1)
    expect(d.turns[0]?.parts).toEqual([
      { kind: 'thinking', text: 'Let me think.', startedAt: first, endedAt: last },
      { kind: 'text', text: 'Answer.' },
      { kind: 'thinking', text: 'More', startedAt: again, endedAt: again },
    ])
  })

  it('a reply that starts after a result goes in ahead of a message still being sent', () => {
    const d = new Driver()
    d.send('q')
    d.apply(userMessage('u1'), text('Looking.'), toolCall('r1:1:0'))
    const local = d.send('and then this')
    d.apply(toolOutcome('r1:1:0', view('read')), text('Found it.'))
    expect(d.shape()).toEqual([
      ['user', 'text:q'],
      ['assistant', 'text:Looking.', 'tool:r1:1:0=completed'],
      ['assistant', 'text:Found it.'],
      ['user', 'text:and then this'],
    ])
    expect(d.turns.at(-1)?.id).toBe(local)
    expect(d.model.draft).toBe(d.turns[2]?.id)
  })
})

describe('applyEvent: tool calls and outcomes', () => {
  it('attaches the calls to the reply that asked for them, once each, tagged with their Run', () => {
    const d = new Driver()
    d.apply(text('Reading both.'), toolCall('r1:1:0', 'Read', { file_path: '/a' }))
    const once = d.apply(toolCall('r1:1:1', 'Read', { file_path: '/b' }))
    expect(d.apply(toolCall('r1:1:1', 'Read', { file_path: '/b' }))).toBe(once)
    expect(d.turns).toHaveLength(1)
    expect(d.turns[0]?.parts).toEqual([
      { kind: 'text', text: 'Reading both.' },
      {
        kind: 'tool',
        callKey: 'r1:1:0',
        name: 'Read',
        input: { file_path: '/a' },
        outcome: null,
        run: 0,
      },
      {
        kind: 'tool',
        callKey: 'r1:1:1',
        name: 'Read',
        input: { file_path: '/b' },
        outcome: null,
        run: 0,
      },
    ])
    // The next Run's calls carry the next Run's number.
    d.apply(done(COMPLETED), toolCall('r2:1:0', 'Glob', { pattern: '*' }))
    const next = d.turns.at(-1)?.parts[0]
    expect(next?.kind === 'tool' ? next.run : null).toBe(1)
  })

  it('starts a turn for a reply that is calls only', () => {
    const d = new Driver()
    d.send('q')
    d.apply(userMessage('u1'), toolCall('r1:1:0', 'Glob', { pattern: '*' }))
    expect(d.shape()).toEqual([
      ['user', 'text:q'],
      ['assistant', 'tool:r1:1:0'],
    ])
    expect(d.turns[1]?.status).toBe('running')
  })

  it('puts the outcome view on its call, without the event’s envelope', () => {
    const d = new Driver()
    d.apply(toolCall('r1:1:0', 'Read', { file_path: '/out/x' }))
    const outcome = view('blocked', 'not-run', {
      source: 'protected',
      facts: { toolName: 'Read', target: '/out/x' },
      permission: { verdict: 'deny', code: 'protected', facts: { toolName: 'Read' } },
      approval: {
        outcome: 'denied',
        scope: null,
        target: { type: 'path', path: '/out/x' },
      },
    })
    d.apply(toolOutcome('r1:1:0', outcome))
    const part = d.turns[0]?.parts[0]
    expect(part?.kind === 'tool' ? part.outcome : undefined).toEqual(outcome)
    // Exactly the view: no type, sessionId, callKey or providerToolCallId came along.
    expect(() =>
      toolOutcomeViewSchema.strict().parse(part?.kind === 'tool' ? part.outcome : null),
    ).not.toThrow()
  })

  it('closes the reply with its result: the next request’s text is a turn of its own', () => {
    const d = new Driver()
    d.apply(text('Looking.'), toolCall('r1:1:0'), toolOutcome('r1:1:0', view('read')))
    d.apply(text('Found it.'))
    expect(d.shape()).toEqual([
      ['assistant', 'text:Looking.', 'tool:r1:1:0=completed'],
      ['assistant', 'text:Found it.'],
    ])
  })

  it('ignores an outcome for a call it never showed', () => {
    const d = new Driver()
    const before = d.apply(text('x'), toolCall('r1:1:0'))
    expect(d.apply(toolOutcome('r9:9:9', view('read')))).toBe(before)
  })

  it('closes a call of the Run before a pause: the answer’s Run reports it on the same row', () => {
    const d = new Driver()
    d.send('write it')
    d.apply(userMessage('u1'), toolCall('r1:1:0', 'Write'), done(PAUSED, { runId: 'run-1' }))
    d.apply(
      toolOutcome('r1:1:0', view('write')),
      text('Written.'),
      done(COMPLETED, { runId: 'run-2' }),
    )
    expect(d.shape()).toEqual([
      ['user', 'text:write it'],
      ['assistant', 'tool:r1:1:0=completed'],
      ['assistant', 'text:Written.'],
    ])
    // Each turn names the Run it belongs to once that Run has ended.
    expect(d.turns.map((turn) => turn.runId)).toEqual([null, 'run-1', 'run-2'])
    expect(d.turns[1]?.end?.endReason).toEqual(PAUSED)
  })
})

describe('applyEvent: attempt-discarded (plan step 20「attempt-discarded（组件测试）」)', () => {
  it('takes back the streamed text and thinking, and the next attempt starts empty', () => {
    const d = new Driver()
    d.send('q')
    d.apply(userMessage('u1'), thinking('Planning'), text('Half an ans'))
    d.apply(discarded())
    expect(d.shape()).toEqual([['user', 'text:q']])
    expect(d.model.draft).toBeNull()
    d.apply(thinking('Again'))
    const restarted = d.now
    d.apply(text('Whole answer.'))
    expect(d.shape()).toEqual([
      ['user', 'text:q'],
      ['assistant', 'thinking:Again', 'text:Whole answer.'],
    ])
    // The thinking timer restarts with the attempt: nothing of the discarded one is measured.
    expect(d.turns[1]?.parts[0]).toMatchObject({ startedAt: restarted, endedAt: restarted })
  })

  it('leaves the replies the Run already wrote, and does nothing with no attempt in view', () => {
    const d = new Driver()
    d.send('q')
    d.apply(userMessage('u1'), text('Looking.'), toolCall('r1:1:0'))
    const settled = d.apply(toolOutcome('r1:1:0', view('read')))
    expect(d.apply(discarded())).toEqual(settled)
    d.apply(text('partial'), discarded(), text('final'))
    expect(d.shape()).toEqual([
      ['user', 'text:q'],
      ['assistant', 'text:Looking.', 'tool:r1:1:0=completed'],
      ['assistant', 'text:final'],
    ])
  })
})

describe('applyEvent: done and error', () => {
  it('done: every running turn completes; the end goes on the Run’s last assistant turn', () => {
    const d = new Driver()
    d.send('q')
    d.apply(userMessage('u1'), text('Looking.'), toolCall('r1:1:0'))
    d.apply(
      toolOutcome('r1:1:0', view('read')),
      text('Done.'),
      done(COMPLETED, { runId: 'run-1', retryOf: null }),
    )
    expect(d.turns.map((turn) => turn.status)).toEqual(['complete', 'complete', 'complete'])
    expect(d.turns[1]?.end).toBeUndefined()
    expect(d.turns[2]?.end).toEqual({
      runId: 'run-1',
      endReason: COMPLETED,
      errorCode: null,
      retryOf: null,
    })
    expect(d.turns[2]?.runId).toBe('run-1')
    expect(d.model.draft).toBeNull()
    // The end closes the reply: whatever streams next is a new turn, of the next Run.
    expect(d.model.run).toEqual({ seq: 1 })
    d.apply(text('late'))
    expect(d.turns).toHaveLength(4)
    expect(d.turns[3]?.run).toBe(1)
  })

  it('done after a stop marks the turns aborted; a done without endReason or runId carries null', () => {
    const d = new Driver()
    d.apply(text('w0 w1'), done(undefined, { stop: 'aborted' }))
    expect(d.turns[0]?.status).toBe('aborted')
    expect(d.turns[0]?.end).toEqual({
      runId: null,
      endReason: null,
      errorCode: null,
      retryOf: null,
    })
  })

  it('error: the turns fail, and the end carries the code, the Run, its reason and its retryOf', () => {
    const d = new Driver()
    d.send('q')
    d.apply(
      userMessage('u1'),
      text('partial'),
      failed('provider', PROVIDER_ERROR, { runId: 'r-9', retryOf: 'u1' }),
    )
    expect(d.turns[1]?.status).toBe('error')
    expect(d.turns[1]?.end).toEqual({
      runId: 'r-9',
      endReason: PROVIDER_ERROR,
      errorCode: 'provider',
      retryOf: 'u1',
    })
  })

  it('an error that is not a Run’s (no endReason) still ends what streamed, with its code only', () => {
    // §失败卡与结束原因 ①: such an error shows phase 1's ThreadError by `code`.
    const d = new Driver()
    d.send('q')
    d.apply(userMessage('u1'), failed('auth'))
    expect(d.turns[1]).toMatchObject({
      role: 'assistant',
      status: 'error',
      runId: null,
      end: { runId: null, endReason: null, errorCode: 'auth' },
    })
  })

  it('a Run that wrote nothing gets an empty assistant turn after the user’s message', () => {
    const d = new Driver()
    d.send('first')
    d.apply(userMessage('u1'), text('reply'), done(COMPLETED, { runId: 'run-1' }))
    d.send('second')
    d.apply(userMessage('u2'), failed('provider', PROVIDER_ERROR, { runId: 'run-2' }))
    expect(d.shape()).toEqual([
      ['user', 'text:first'],
      ['assistant', 'text:reply'],
      ['user', 'text:second'],
      ['assistant'],
    ])
    expect(d.turns[3]).toMatchObject({
      status: 'error',
      runId: 'run-2',
      run: 1,
      end: { runId: 'run-2', endReason: PROVIDER_ERROR, errorCode: 'provider' },
    })
    // The previous round's end is not touched.
    expect(d.turns[1]?.end).toMatchObject({ runId: 'run-1', endReason: COMPLETED })
  })

  it('the empty turn of a Run that wrote nothing goes in ahead of a message still being sent', () => {
    const d = new Driver()
    d.send('first')
    d.apply(userMessage('u1'))
    const local = d.send('never mind')
    d.apply(done(STOPPED, { stop: 'aborted', runId: 'run-1' }))
    expect(d.turns.map((turn) => [turn.role, turn.end?.endReason?.code ?? null])).toEqual([
      ['user', null],
      ['assistant', 'user-stopped'],
      ['user', null],
    ])
    expect(d.turns.at(-1)?.id).toBe(local)
  })

  it('never puts an end on an earlier Run’s turn: a 「继续」 that writes nothing gets its own', () => {
    const d = new Driver()
    d.send('write it all')
    d.apply(userMessage('u1'), text('Starting.'), done(TRUNCATED, { runId: 'run-1' }))
    // The continued Run's attempt fails outright: it is discarded, then the Run ends.
    d.apply(discarded(), failed('provider', PROVIDER_ERROR, { runId: 'run-2' }))
    expect(d.shape()).toEqual([
      ['user', 'text:write it all'],
      ['assistant', 'text:Starting.'],
      ['assistant'],
    ])
    expect(d.turns[1]?.end).toMatchObject({ runId: 'run-1', endReason: TRUNCATED })
    expect(d.turns[1]?.runId).toBe('run-1')
    expect(d.turns[2]?.end).toMatchObject({ runId: 'run-2', endReason: PROVIDER_ERROR })
  })

  it('an answer’s Run that only closes the paused call ends on a turn of its own', () => {
    // §结束原因词表: a denial's Run sends no request; it writes the closure and ends user-rejected.
    const d = new Driver()
    d.send('write it')
    d.apply(userMessage('u1'), toolCall('r1:1:0', 'Write'), done(PAUSED, { runId: 'run-1' }))
    d.apply(
      toolOutcome('r1:1:0', view('blocked', 'not-run', { source: 'user-rejected' })),
      done(REJECTED, { runId: 'run-2' }),
    )
    expect(d.shape()).toEqual([
      ['user', 'text:write it'],
      ['assistant', 'tool:r1:1:0=not-run'],
      ['assistant'],
    ])
    expect(d.ends()).toEqual(['paused', 'user-rejected'])
    expect(d.turns[1]?.end?.runId).toBe('run-1')
  })
})

describe('retryOf: the kernel’s answer on the terminal event (§失败卡与结束原因; plan step 20)', () => {
  it('done and error each carry the retryOf their terminal event names; absent, null', () => {
    const d = new Driver()
    d.send('first')
    d.apply(userMessage('u1'), text('a'), done(COMPLETED, { runId: 'run-1', retryOf: 'u1' }))
    d.send('second')
    d.apply(
      userMessage('u2'),
      failed('provider', PROVIDER_ERROR, { runId: 'run-2', retryOf: 'u2' }),
    )
    // An old main, or a Run no message opened: no retryOf on the event, none on the end.
    d.apply(text('resumed'), failed('provider', PROVIDER_ERROR, { runId: 'run-3' }))
    d.apply(text('again'), done(STOPPED, { runId: 'run-4', retryOf: null, stop: 'aborted' }))
    const ends = d.turns.flatMap((turn) => (turn.end === undefined ? [] : [turn.end]))
    expect(ends.map((end) => [end.runId, end.retryOf])).toEqual([
      ['run-1', 'u1'],
      ['run-2', 'u2'],
      ['run-3', null],
      ['run-4', null],
    ])
    // Each end moves the Run count on, and nothing else is tracked.
    expect(d.model.run).toEqual({ seq: 4 })
  })

  it('the event order decides nothing: a message before the Run’s content is not its opener', () => {
    // The Run an answer opens runs the approved call, then inserts the message that queued before
    // the pause ahead of its first request: tool-outcome → user-message(queuedId) → error. The
    // renderer used to read that message as the Run's opener and offer 「重试」 (§失败卡与结束原因:
    // a Run an answer opened, or one that dispatched a tool, gets copy only). The kernel says null.
    const d = new Driver()
    d.send('write a, then b')
    d.apply(userMessage('u1'), toolCall('r1:1:0', 'Write'), done(PAUSED, { retryOf: 'u1' }))
    d.queued.set('q1', 'queued before the pause')
    d.apply(
      toolOutcome('r1:1:0', view('write')),
      userMessage('u2', 'q1'),
      failed('provider', PROVIDER_ERROR, { retryOf: null }),
    )
    const last = d.lastEnded()
    expect(d.turns[last]?.end?.retryOf).toBeNull()
    expect(retryable(d.turns, last)).toBe(false)
  })

  it('and a Run whose events look like no message’s is resendable once the kernel names one', () => {
    // Nothing is inferred either way: a Run that streamed with no user-message in view (the window
    // missed it, say) still offers 「重试」 when its terminal names the message.
    const d = new Driver(
      threadFromRows([
        row({ messageId: 'u1', role: 'user', content: [{ type: 'text', text: 'try this' }] }),
      ]),
    )
    d.apply(text('Hm'), failed('provider', PROVIDER_ERROR, { runId: 'run-1', retryOf: 'u1' }))
    expect(retryable(d.turns, 1)).toBe(true)
    expect(d.turns[1]?.end?.retryOf).toBe('u1')
  })

  it('send-now: the stopped Run and the message’s own Run each keep the retryOf their end named', () => {
    // §插话与输入框状态表「立即发送」: the Run stops (`user-stopped`), then the message goes out,
    // through the queue (urgent). The store drops its echo once chat.queue lists it.
    const d = new Driver()
    d.send('first')
    d.apply(userMessage('u1'), text('Working'))
    const echo = d.send('stop and do this')
    d.queued.set('q1', 'stop and do this')
    d.model = withoutTurn(d.model, echo)
    d.apply(done(STOPPED, { stop: 'aborted', runId: 'run-1', retryOf: 'u1' }))
    d.apply(
      userMessage('u2', 'q1'),
      failed('provider', PROVIDER_ERROR, { runId: 'run-2', retryOf: 'u2' }),
    )
    expect(d.shape()).toEqual([
      ['user', 'text:first'],
      ['assistant', 'text:Working'],
      ['user', 'text:stop and do this'],
      ['assistant'],
    ])
    expect(d.turns.map((turn) => turn.end?.retryOf)).toEqual([undefined, 'u1', undefined, 'u2'])
    expect(d.turns[1]?.status).toBe('aborted')
    expect(retryable(d.turns, 3)).toBe(true)
  })
})

/** Each turn's role and whether it carries an end. */
function shape(d: Driver): Array<[string, boolean]> {
  return d.turns.map((turn) => [turn.role, turn.end !== undefined])
}

describe('two sends nothing is written for, the route answer and the end in either order', () => {
  const AUTH: RunEndReasonContract = { ...PROVIDER_ERROR, errorCode: 'auth', attempts: 0 }
  const lost = (): ChatEvent => failed('auth', AUTH, { runId: null })

  // The end is emitted before the route answers, but the window may handle the answer first when
  // it is busy (step 20 round 4, measured in the app): each card must still sit under its message.

  it('end first, then the answer, twice: each card under its own message', () => {
    const d = new Driver()
    const first = d.send('first')
    d.apply(lost())
    d.model = withSettled(d.model, first)
    const second = d.send('second')
    d.apply(lost())
    d.model = withSettled(d.model, second)
    expect(shape(d)).toEqual([
      ['user', false],
      ['assistant', true],
      ['user', false],
      ['assistant', true],
    ])
    expect([d.turns[0]?.id, d.turns[2]?.id]).toEqual([first, second])
    expect(d.turns.some((turn) => turn.answers !== undefined)).toBe(false)
  })

  it('the answer first, then the end, twice: the same, and no earlier card moves', () => {
    const d = new Driver()
    const first = d.send('first')
    d.model = withSettled(d.model, first)
    d.apply(lost())
    const second = d.send('second')
    d.model = withSettled(d.model, second)
    d.apply(lost())
    expect(shape(d)).toEqual([
      ['user', false],
      ['assistant', true],
      ['user', false],
      ['assistant', true],
    ])
    expect([d.turns[0]?.id, d.turns[2]?.id]).toEqual([first, second])
  })

  it('mixed: the first end first, the second answer first', () => {
    const d = new Driver()
    const first = d.send('first')
    d.apply(lost())
    d.model = withSettled(d.model, first)
    const second = d.send('second')
    d.model = withSettled(d.model, second)
    d.apply(lost())
    expect(shape(d)).toEqual([
      ['user', false],
      ['assistant', true],
      ['user', false],
      ['assistant', true],
    ])
    expect([d.turns[0]?.id, d.turns[2]?.id]).toEqual([first, second])
  })
})

describe('withSettled: a message the kernel will never name (plan step 20, chat.send status)', () => {
  it('keeps the words and the local id, and stops awaiting an id; other turns are untouched', () => {
    const d = new Driver()
    d.send('first')
    d.apply(userMessage('u1'), text('reply'), done(COMPLETED, { runId: 'run-1' }))
    const lost = d.send('never written')
    const pending = d.send('on its way')
    const before = d.turns
    const settled = withSettled(d.model, lost)
    expect(settled.turns.map((turn) => [turn.id, turn.optimistic])).toEqual([
      ['u1', false],
      [before[1]?.id, undefined],
      [lost, false],
      [pending, true],
    ])
    expect(settled.turns[2]).toEqual({ ...before[2], optimistic: false })
    expect(settled.turns.filter((_, i) => i !== 2)).toEqual(before.filter((_, i) => i !== 2))
    expect(settled.draft).toBe(d.model.draft)
    expect(settled.run).toBe(d.model.run)
    // An id it does not have changes no turn.
    expect(withSettled(d.model, 'local-unknown').turns).toEqual(before)
  })

  it('a later message’s id goes to the next send, never to the one nothing was written for', () => {
    // A missing key: the kernel writes nothing and ends at once (runId null); the route answers
    // `not-sent`, and the store settles the echo. The next send's `user-message` names the next echo.
    const d = new Driver()
    const lost = d.send('first')
    d.apply(failed('auth', { ...PROVIDER_ERROR, errorCode: 'auth' }, { runId: null }))
    d.model = withSettled(d.model, lost)
    const next = d.send('second')
    d.apply(userMessage('u2'))
    expect(d.turns.map((turn) => [turn.role, turn.id, turn.optimistic ?? null])).toEqual([
      ['user', lost, false],
      ['assistant', d.turns[1]?.id, null],
      ['user', 'u2', false],
    ])
    expect(d.turns.some((turn) => turn.id === next)).toBe(false)
    // Unsettled, the first echo would have taken the second message's id.
    const unsettled = new Driver()
    const first = unsettled.send('first')
    unsettled.apply(failed('auth', { ...PROVIDER_ERROR, errorCode: 'auth' }, { runId: null }))
    unsettled.send('second')
    unsettled.apply(userMessage('u2'))
    expect(unsettled.turns.some((turn) => turn.id === first)).toBe(false)
    expect(unsettled.turns.find((turn) => turn.role === 'user')?.id).toBe('u2')
  })

  it('with every echo settled, a message sent elsewhere names none of them', () => {
    const d = new Driver()
    const lost = d.send('first')
    d.model = withSettled(d.model, lost)
    const before = d.turns
    d.apply(userMessage('m-other-window'))
    expect(d.turns).toEqual(before)
  })
})

describe('ended(): where a Run that wrote no turn puts its end', () => {
  const AUTH: RunEndReasonContract = { ...PROVIDER_ERROR, errorCode: 'auth', attempts: 0 }

  it('no Run id — nothing was written: ahead of the messages being sent, then under its own one', () => {
    // The end cannot tell which send it answers (a stopped 「继续」 also ends with no Run id); the
    // route's `not-sent` answer names it, and withSettled moves the end under that message.
    const d = new Driver()
    const first = d.send('first')
    const second = d.send('second')
    d.apply(failed('auth', AUTH, { runId: null }))
    expect(d.turns.map((turn) => [turn.role, turn.id === first || turn.id === second])).toEqual([
      ['assistant', false],
      ['user', true],
      ['user', true],
    ])
    d.model = withSettled(d.model, first)
    expect(d.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user'])
    expect(d.turns[0]?.id).toBe(first)
    expect(d.turns[2]?.id).toBe(second)
    expect(d.turns[1]).toMatchObject({
      role: 'assistant',
      parts: [],
      status: 'error',
      runId: null,
      run: 0,
      end: { runId: null, endReason: AUTH, errorCode: 'auth' },
    })
  })

  it('with a Run id: ahead of every message still being sent, the oldest included', () => {
    const d = new Driver()
    d.send('first')
    d.apply(userMessage('u1'))
    const a = d.send('a')
    const b = d.send('b')
    d.apply(failed('provider', PROVIDER_ERROR, { runId: 'run-1' }))
    expect(d.turns.map((turn) => [turn.role, turn.end?.runId ?? null])).toEqual([
      ['user', null],
      ['assistant', 'run-1'],
      ['user', null],
      ['user', null],
    ])
    expect(d.turns.slice(2).map((turn) => turn.id)).toEqual([a, b])
  })

  it('no Run id and nothing on its way: at the end of the thread', () => {
    const d = new Driver()
    d.send('first')
    d.apply(userMessage('u1'), text('reply'), done(COMPLETED, { runId: 'run-1' }))
    d.apply(done(STOPPED, { runId: null, stop: 'aborted' }))
    expect(d.turns.map((turn) => [turn.role, turn.end?.endReason?.code ?? null])).toEqual([
      ['user', null],
      ['assistant', 'completed'],
      ['assistant', 'user-stopped'],
    ])
  })

  it('a Run that wrote a turn ends on it, with or without its id: no empty turn is added', () => {
    const d = new Driver()
    d.send('first')
    d.apply(userMessage('u1'), text('streamed'))
    const local = d.send('on its way')
    d.apply(done(STOPPED, { runId: null, stop: 'aborted' }))
    expect(d.shape()).toEqual([
      ['user', 'text:first'],
      ['assistant', 'text:streamed'],
      ['user', 'text:on its way'],
    ])
    expect(d.turns[1]?.end?.endReason).toEqual(STOPPED)
    expect(d.turns[2]).toMatchObject({ id: local, optimistic: true })
  })
})

/** A round with a pause in the middle (旧 222): write → allow → read twice, over two Runs. */
function pausedRound(): Driver {
  const d = new Driver()
  d.send('old round')
  d.apply(userMessage('u0'), toolCall('r0:1:0', 'Read'))
  d.apply(toolOutcome('r0:1:0', view('read')), text('ok'), done(COMPLETED))
  d.send('write then read')
  d.apply(userMessage('u1'), text('Writing.'), toolCall('r1:1:0', 'Write'), done(PAUSED))
  d.apply(toolOutcome('r1:1:0', view('write')), toolCall('r2:1:0', 'Read'))
  d.apply(toolOutcome('r2:1:0', view('read')), toolCall('r2:2:0', 'WebFetch'))
  d.apply(toolOutcome('r2:2:0', view('external')), toolCall('r2:3:0', 'Read'))
  d.apply(
    toolOutcome('r2:3:0', view('blocked', 'not-run', { source: 'protected' })),
    toolCall('r2:3:1', 'Read'),
  )
  d.apply(toolOutcome('r2:3:1', view('read')), text('All done.'), done(COMPLETED))
  return d
}

/** A user turn built by hand; `optimistic` for one this window sent and has not seen written. */
function userTurn(id: string, optimistic: boolean): Turn {
  return {
    id,
    role: 'user',
    parts: [{ kind: 'text', text: id }],
    status: 'complete',
    runId: null,
    createdAt: 0,
    ...(optimistic ? { optimistic: true } : {}),
  }
}

/** An assistant turn built by hand: one call, and the end of a Run that dispatched it. */
function endedTurn(id: string, call: Part, endReason: RunEndReasonContract): Turn {
  return {
    id,
    role: 'assistant',
    parts: [call],
    status: 'complete',
    runId: null,
    createdAt: 0,
    end: { runId: null, endReason, errorCode: null, retryOf: null },
  }
}

describe('summaryBefore (TurnSummaryLine)', () => {
  it('旧 222: counts read, changed and sent out over every Run since the last user message', () => {
    const d = pausedRound()
    const last = d.turns.length - 1
    // The write of the paused Run counts; the previous round's read and the blocked read do not.
    expect(summaryBefore(d.turns, last)).toEqual({ read: 2, write: 1, external: 1 })
    // The previous round keeps its own line: the later end is another round's.
    const previous = d.turns.findIndex((turn) => turn.end !== undefined)
    expect(summaryBefore(d.turns, previous)).toEqual({ read: 1, write: 0, external: 0 })
  })

  it('旧 222: one line a round — the paused Run’s turn gives it up once a later Run of the round ends', () => {
    const d = new Driver()
    d.send('write then read')
    d.apply(userMessage('u1'), text('Writing.'), toolCall('r1:1:0', 'Write'), done(PAUSED))
    const paused = d.lastEnded()
    // The write waits on the card: nothing closed, nothing to count.
    expect(summaryBefore(d.turns, paused)).toBeNull()
    d.apply(toolOutcome('r1:1:0', view('write')), toolCall('r2:1:0', 'Read'))
    // The answer's Run is still going: counted up to the turn asked about (the thread shows no line
    // for `paused`; to-thread-messages leaves it out).
    expect(summaryBefore(d.turns, paused)).toEqual({ read: 0, write: 1, external: 0 })
    d.apply(toolOutcome('r2:1:0', view('read')), text('Done.'), done(COMPLETED))
    expect(summaryBefore(d.turns, paused)).toBeNull()
    expect(summaryBefore(d.turns, d.lastEnded())).toEqual({ read: 1, write: 1, external: 0 })
  })

  it('a step-limit then 「继续」: the line moves to the continued Run’s end, over both', () => {
    const d = new Driver()
    d.send('do it all')
    d.apply(userMessage('u1'), toolCall('r1:1:0', 'Write'), toolOutcome('r1:1:0', view('write')))
    d.apply(text('Stopped at the limit.'), done(STEP_LIMIT))
    const limited = d.lastEnded()
    // The step-limit end is not paused: until something else ends in this round, it carries the line.
    expect(summaryBefore(d.turns, limited)).toEqual({ read: 0, write: 1, external: 0 })
    d.apply(toolCall('r2:1:0', 'Read'), toolOutcome('r2:1:0', view('read')), text('Rest.'))
    d.apply(done(COMPLETED))
    expect(summaryBefore(d.turns, limited)).toBeNull()
    expect(summaryBefore(d.turns, d.lastEnded())).toEqual({ read: 1, write: 1, external: 0 })
  })

  it('a later paused end in the round does not take the line from an earlier end', () => {
    const d = new Driver()
    d.send('do it all')
    d.apply(userMessage('u1'), toolCall('r1:1:0'), toolOutcome('r1:1:0', view('read')))
    d.apply(text('Limit.'), done(STEP_LIMIT))
    const limited = d.lastEnded()
    d.apply(toolCall('r2:1:0', 'Write'), done(PAUSED))
    expect(summaryBefore(d.turns, limited)).toEqual({ read: 1, write: 0, external: 0 })
  })

  it('is null for a round that made no call, or whose calls did nothing', () => {
    const d = new Driver()
    d.send('q')
    d.apply(userMessage('u1'), text('Just words.'), done(COMPLETED))
    expect(summaryBefore(d.turns, 1)).toBeNull()
    d.send('again')
    d.apply(userMessage('u2'), toolCall('r2:1:0'))
    d.apply(toolOutcome('r2:1:0', view('blocked', 'not-run', { source: 'policy' })))
    d.apply(text('Blocked.'), done(COMPLETED))
    expect(summaryBefore(d.turns, d.turns.length - 1)).toBeNull()
  })

  it('a message still being sent bounds no round, before the end or after it', () => {
    // Hand-built: applyEvent keeps unsent messages last (beforeUnsent), so this pins the helper's
    // own rule — the round runs from the last message the kernel WROTE, and only a written one
    // after the end starts the next round.
    const read: Part = {
      kind: 'tool',
      callKey: 'r1:1:0',
      name: 'Read',
      input: {},
      outcome: view('read'),
      run: 0,
    }
    const write: Part = { ...read, callKey: 'r2:1:0', name: 'Write', outcome: view('write') }
    const turns = [
      userTurn('u1', false),
      endedTurn('a1', read, STEP_LIMIT),
      userTurn('local-1', true),
      endedTurn('a2', write, COMPLETED),
    ]
    // The unsent message does not end the round at a1: a2's end, later in it, carries the line…
    expect(summaryBefore(turns, 1)).toBeNull()
    // …and does not start one either: a2's line counts a1's read too.
    expect(summaryBefore(turns, 3)).toEqual({ read: 1, write: 1, external: 0 })
  })
})

describe('retryable (§失败卡与结束原因 provider-error; 旧 221)', () => {
  it('yes: the kernel named the message the Run resends', () => {
    const d = new Driver()
    d.send('q')
    d.apply(userMessage('u1'), failed('provider', PROVIDER_ERROR, { retryOf: 'u1' }))
    const last = d.turns.length - 1
    expect(retryable(d.turns, last)).toBe(true)
    // What 「重试」 hands the store is that id.
    expect(d.turns[last]?.end?.retryOf).toBe('u1')
  })

  it('no: the kernel named none — an answer’s, 「继续」’s, a resume’s or a dispatched Run — or an old main', () => {
    for (const o of [{ retryOf: null }, {}] as const) {
      const d = new Driver()
      d.send('q')
      d.apply(userMessage('u1'), text('partial'), failed('provider', PROVIDER_ERROR, o))
      expect([o, retryable(d.turns, d.turns.length - 1)]).toEqual([o, false])
    }
  })

  it('yes, again: the resend is the same message, and the kernel names it for each Run', () => {
    const d = new Driver()
    d.send('q')
    d.apply(
      userMessage('u1'),
      failed('provider', PROVIDER_ERROR, { runId: 'run-1', retryOf: 'u1' }),
    )
    // 「重试」: the store shows the words again; the kernel writes the same message.
    d.send('q')
    d.apply(
      userMessage('u1'),
      text('Half'),
      failed('provider', PROVIDER_ERROR, { runId: 'run-2', retryOf: 'u1' }),
    )
    expect(d.shape()).toEqual([['user', 'text:q'], ['assistant'], ['assistant', 'text:Half']])
    expect(retryable(d.turns, 1)).toBe(true)
    expect(retryable(d.turns, 2)).toBe(true)
  })

  it('a 「继续」 that fails before writing anything: its own end, not resendable; the truncated one is', () => {
    const d = new Driver()
    d.send('write it all')
    d.apply(userMessage('u1'), text('Starting.'), done(TRUNCATED, { retryOf: 'u1' }))
    // The continued Run's attempt fails outright: it is discarded, then the Run ends.
    d.apply(discarded(), failed('provider', PROVIDER_ERROR, { retryOf: null }))
    const last = d.lastEnded()
    expect(last).toBe(2)
    expect(d.turns[last]?.end?.endReason).toEqual(PROVIDER_ERROR)
    expect(retryable(d.turns, last)).toBe(false)
    expect(d.turns[1]?.end?.endReason).toEqual(TRUNCATED)
    expect(retryable(d.turns, 1)).toBe(true)
  })

  it('no: a turn with no end', () => {
    const d = new Driver()
    d.send('q')
    d.apply(userMessage('u1'), text('streaming'))
    expect(retryable(d.turns, 1)).toBe(false)
    expect(retryable(d.turns, 0)).toBe(false)
    expect(retryable(d.turns, 9)).toBe(false)
  })
})
