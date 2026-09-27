/**
 * The model as assistant-ui draws it (spec 02 plan step 20; §界面范围 `ToolRow`, `ThinkingBlock`,
 * `TurnSummaryLine`, §失败卡与结束原因). What assistant-ui has no part for travels in `metadata.custom`;
 * a tool call's `toolCallId` is its `callKey`. Each case also goes through `fromThreadMessageLike`,
 * the conversion the external-store runtime applies, to prove the runtime keeps what was set.
 *
 * The models are built by `applyEvent` from contract-parsed events — the path the window takes.
 */
import { fromThreadMessageLike } from '@assistant-ui/react'
import type { MessageStatus, ThreadMessage, ThreadMessageLike } from '@assistant-ui/react'
import { chatEventSchema, messageRowSchema, toolOutcomeViewSchema } from '@tenon-app/contracts'
import type { ChatEvent, RunEndReasonContract, ToolOutcomeViewContract } from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_THREAD,
  applyEvent,
  threadFromRows,
  withSentText,
} from '../src/renderer/src/runtime/thread-model.js'
import type { ThreadModel } from '../src/renderer/src/runtime/thread-model.js'
import { toThreadMessages } from '../src/renderer/src/runtime/to-thread-messages.js'
import type { TurnCustom } from '../src/renderer/src/runtime/to-thread-messages.js'

const SESSION = '0f1e2d3c-4b5a-4697-8899-aabbccddeeff'
/** What the runtime gives a message that carries no status of its own. */
const AUTO: MessageStatus = { type: 'complete', reason: 'unknown' }

type Body<T extends ChatEvent['type']> = Omit<Extract<ChatEvent, { type: T }>, 'sessionId' | 'type'>

function event<T extends ChatEvent['type']>(type: T, body: Body<T>): ChatEvent {
  return chatEventSchema.parse({ type, sessionId: SESSION, ...body })
}

const text = (delta: string): ChatEvent => event('text-delta', { delta })
const thinking = (delta: string): ChatEvent => event('thinking-delta', { delta })
const toolCall = (callKey: string, name: string, input: Record<string, unknown>): ChatEvent =>
  event('tool-call', { callKey, providerToolCallId: 'toolu_1', name, input })
const toolOutcome = (callKey: string, closed: ToolOutcomeViewContract): ChatEvent =>
  event('tool-outcome', { callKey, providerToolCallId: 'toolu_1', ...closed })
const done = (
  endReason: RunEndReasonContract,
  stopReason: 'end-turn' | 'aborted' = 'end-turn',
  runId = 'run-1',
): ChatEvent => event('done', { stopReason, endReason, runId })
/** A Run's failure; `retryOf` is the message the kernel names for 「重试」 (run-ended.retryOf). */
const failed = (
  code: Extract<ChatEvent, { type: 'error' }>['code'],
  endReason?: RunEndReasonContract,
  retryOf: string | null = null,
): ChatEvent =>
  event('error', {
    code,
    ...(endReason === undefined ? {} : { endReason, runId: 'run-1', retryOf }),
  })

function view(effect: ToolOutcomeViewContract['effect']): ToolOutcomeViewContract {
  return toolOutcomeViewSchema.parse({ effect, state: 'completed', source: null, output: 'ok' })
}

const PAUSED: RunEndReasonContract = { code: 'paused', waitingFor: 'approval' }
const COMPLETED: RunEndReasonContract = { code: 'completed' }
const STEP_LIMIT: RunEndReasonContract = { code: 'step-limit', limit: 100 }
const PROVIDER_ERROR: RunEndReasonContract = {
  code: 'provider-error',
  providerId: 'anthropic',
  errorCode: 'server',
  providerReason: null,
  attempts: 3,
}

/** The events folded onto `model`, the clock ticking by 1000 per event from `now`. */
function fold(model: ThreadModel, events: readonly ChatEvent[], now: number, prefix: string) {
  let at = now
  let ids = 0
  let folded = model
  for (const next of events) {
    at += 1000
    folded = applyEvent(folded, next, {
      now: at,
      nextId: () => `${prefix}${String((ids += 1))}`,
      queuedText: () => undefined,
    })
  }
  return folded
}

/** A user message, confirmed, then the events; the clock ticks by 1000 per event. */
function thread(...events: readonly ChatEvent[]): ThreadModel {
  const sent = withSentText(EMPTY_THREAD, 'question', 'local-0', 10_000)
  return fold(
    sent,
    [event('user-message', { messageId: 'u1', queuedId: null }), ...events],
    10_000,
    'a',
  )
}

const custom = (message: ThreadMessageLike | ThreadMessage): TurnCustom | undefined =>
  message.metadata?.custom as unknown as TurnCustom | undefined

/** Converted as the runtime converts each message. */
const runtime = (message: ThreadMessageLike): ThreadMessage =>
  fromThreadMessageLike(message, 'fallback', AUTO)

describe('toThreadMessages: parts', () => {
  it('maps text, thinking and a tool call, the call keyed by its callKey with its outcome', () => {
    const read = view('read')
    const [, assistant] = toThreadMessages(
      thread(
        thinking('Why.'),
        text('Reading.'),
        toolCall('r1:1:0', 'Read', { file_path: '/a' }),
        toolCall('r1:1:1', 'Read', { file_path: '/b' }),
        toolOutcome('r1:1:0', read),
      ),
    )
    expect(assistant?.content).toEqual([
      { type: 'reasoning', text: 'Why.' },
      { type: 'text', text: 'Reading.' },
      {
        type: 'tool-call',
        toolCallId: 'r1:1:0',
        toolName: 'Read',
        args: { file_path: '/a' },
        result: read,
      },
      // No outcome yet: no `result` at all, so the runtime still reads the call as open.
      { type: 'tool-call', toolCallId: 'r1:1:1', toolName: 'Read', args: { file_path: '/b' } },
    ])
    const converted = runtime(assistant as ThreadMessageLike)
    expect(converted.content).toMatchObject([
      { type: 'reasoning', text: 'Why.' },
      { type: 'text', text: 'Reading.' },
      { type: 'tool-call', toolCallId: 'r1:1:0', toolName: 'Read', result: read },
      { type: 'tool-call', toolCallId: 'r1:1:1', toolName: 'Read', args: { file_path: '/b' } },
    ])
    const open = converted.content[3]
    expect(open?.type === 'tool-call' ? open.result : 'not a call').toBeUndefined()
  })

  it('keeps the id and the time of each turn', () => {
    const [user, assistant] = toThreadMessages(thread(text('hi')))
    expect(user).toMatchObject({ id: 'u1', role: 'user', createdAt: new Date(10_000) })
    expect(assistant).toMatchObject({ id: 'a1', role: 'assistant', createdAt: new Date(12_000) })
    expect(runtime(assistant as ThreadMessageLike).id).toBe('a1')
  })
})

describe('toThreadMessages: status', () => {
  const cases: ReadonlyArray<readonly [string, ThreadModel, MessageStatus]> = [
    ['running', thread(text('streaming')), { type: 'running' }],
    ['complete', thread(text('all'), done(COMPLETED)), { type: 'complete', reason: 'stop' }],
    [
      'stopped',
      thread(text('w0'), done({ code: 'user-stopped' }, 'aborted')),
      { type: 'incomplete', reason: 'cancelled' },
    ],
    [
      'failed',
      thread(text('half'), failed('rate-limit', PROVIDER_ERROR)),
      { type: 'incomplete', reason: 'error', error: { code: 'rate-limit' } },
    ],
  ]

  it.each(cases)(
    'an assistant turn that is %s keeps that status through the runtime',
    (_, model, status) => {
      const assistant = toThreadMessages(model)[1] as ThreadMessageLike
      expect(assistant.status).toEqual(status)
      expect(runtime(assistant).status).toEqual(status)
    },
  )

  it('never puts a status on a user message (the runtime throws on one)', () => {
    for (const [, model] of cases) {
      const user = toThreadMessages(model)[0] as ThreadMessageLike
      expect(user.role).toBe('user')
      expect(user.status).toBeUndefined()
      expect(() => runtime(user)).not.toThrow()
    }
  })
})

describe('toThreadMessages: metadata.custom', () => {
  it('carries the turn id alone on a turn with no end and no thinking', () => {
    const messages = toThreadMessages(thread(text('streaming')))
    expect(messages.map(custom)).toEqual([{ turnId: 'u1' }, { turnId: 'a1' }])
    expect(runtime(messages[1] as ThreadMessageLike).metadata.custom).toEqual({ turnId: 'a1' })
  })

  it('carries the end, the summary and the retry answer on the Run’s last turn', () => {
    const messages = toThreadMessages(
      thread(
        toolCall('r1:1:0', 'Read', {}),
        toolOutcome('r1:1:0', view('read')),
        text('Done.'),
        done(COMPLETED),
      ),
    )
    // The call's turn, closed by its result, carries nothing: the end is the Run's last turn's.
    expect(custom(messages[1] as ThreadMessageLike)).toEqual({ turnId: 'a1' })
    const expected: TurnCustom = {
      turnId: 'a2',
      // The Run dispatched its Read: the kernel names no message to resend.
      end: { runId: 'run-1', endReason: COMPLETED, errorCode: null, retryOf: null },
      summary: { read: 1, write: 0, external: 0 },
      retryable: false,
    }
    expect(custom(messages[2] as ThreadMessageLike)).toEqual(expected)
    expect(runtime(messages[2] as ThreadMessageLike).metadata.custom).toEqual(expected)
  })

  it('carries no summary for a round without calls, and says a Run the kernel named can be resent', () => {
    const [, assistant] = toThreadMessages(thread(failed('provider', PROVIDER_ERROR, 'u1')))
    const expected: TurnCustom = {
      turnId: 'a1',
      end: { runId: 'run-1', endReason: PROVIDER_ERROR, errorCode: 'provider', retryOf: 'u1' },
      retryable: true,
    }
    expect(custom(assistant as ThreadMessageLike)).toEqual(expected)
    expect(runtime(assistant as ThreadMessageLike).metadata.custom).toEqual(expected)
    // The same failure with no message named (an answer's, 「继续」's, a dispatched Run): not resendable.
    const [, other] = toThreadMessages(thread(failed('provider', PROVIDER_ERROR, null)))
    expect(custom(other as ThreadMessageLike)?.retryable).toBe(false)
  })

  it('旧 222: a paused Run shows no summary; the round’s one summary is on its last Run, over both', () => {
    const paused = thread(
      text('Writing.'),
      toolCall('r1:1:0', 'Write', { file_path: '/w/a' }),
      done(PAUSED),
    )
    const pausedOnly = toThreadMessages(paused)
    expect(custom(pausedOnly[1] as ThreadMessageLike)?.end?.endReason).toEqual(PAUSED)
    expect(custom(pausedOnly[1] as ThreadMessageLike)?.summary).toBeUndefined()
    // The write closes in the answer's Run: while that Run goes on, the paused turn still shows none.
    const answering = fold(paused, [toolOutcome('r1:1:0', view('write'))], 50_000, 'b')
    expect(toThreadMessages(answering).map((message) => custom(message)?.summary)).toEqual([
      undefined,
      undefined,
    ])

    const model = fold(
      answering,
      [
        toolCall('r2:1:0', 'Read', {}),
        toolOutcome('r2:1:0', view('read')),
        toolCall('r2:2:0', 'Read', {}),
        toolOutcome('r2:2:0', view('read')),
        text('All done.'),
        done(COMPLETED, 'end-turn', 'run-2'),
      ],
      60_000,
      'c',
    )
    const messages = toThreadMessages(model)
    const summaries = messages.map((message) => custom(message)?.summary)
    expect(summaries.filter((summary) => summary !== undefined)).toEqual([
      { read: 2, write: 1, external: 0 },
    ])
    expect(summaries.at(-1)).toEqual({ read: 2, write: 1, external: 0 })
    // Each end is its own Run's; neither terminal named a message, so neither is resendable.
    expect(messages.map((message) => custom(message)?.end?.runId)).toEqual([
      undefined,
      'run-1',
      undefined,
      undefined,
      'run-2',
    ])
    expect(messages.map((message) => custom(message)?.retryable)).toEqual([
      undefined,
      false,
      undefined,
      undefined,
      false,
    ])
  })

  it('one line a round: after a step-limit and 「继续」, only the continued Run’s end carries it', () => {
    const limited = thread(
      toolCall('r1:1:0', 'Write', { file_path: '/w/a' }),
      toolOutcome('r1:1:0', view('write')),
      text('At the limit.'),
      done(STEP_LIMIT),
    )
    const before = toThreadMessages(limited)
    // Until 「继续」, the step-limit card carries the round's line.
    expect(custom(before.at(-1) as ThreadMessageLike)?.summary).toEqual({
      read: 0,
      write: 1,
      external: 0,
    })
    const continued = fold(
      limited,
      [
        toolCall('r2:1:0', 'Read', {}),
        toolOutcome('r2:1:0', view('read')),
        text('Rest.'),
        done(COMPLETED, 'end-turn', 'run-2'),
      ],
      80_000,
      'c',
    )
    const summaries = toThreadMessages(continued).map((message) => custom(message)?.summary)
    expect(summaries.filter((summary) => summary !== undefined)).toEqual([
      { read: 1, write: 1, external: 0 },
    ])
    expect(summaries.at(-1)).toEqual({ read: 1, write: 1, external: 0 })
  })

  it('carries each thinking block’s timing in order, and null timings for a replayed one', () => {
    const [, assistant] = toThreadMessages(
      thread(thinking('One. '), thinking('Still one.'), text('Say.'), thinking('Two.')),
    )
    // The user message is at 11 000; the deltas follow at 12 000, 13 000, 14 000 and 15 000.
    expect(custom(assistant as ThreadMessageLike)?.thinking).toEqual([
      { startedAt: 12_000, endedAt: 13_000 },
      { startedAt: 15_000, endedAt: 15_000 },
    ])
    expect(runtime(assistant as ThreadMessageLike).metadata.custom['thinking']).toEqual([
      { startedAt: 12_000, endedAt: 13_000 },
      { startedAt: 15_000, endedAt: 15_000 },
    ])
    // Replayed from the Tape, which keeps no timing: the block is there, its time is not.
    const [replayed] = toThreadMessages(
      threadFromRows([
        messageRowSchema.parse({
          sessionId: SESSION,
          messageId: 'm1',
          orderSeq: 1,
          role: 'assistant',
          status: 'complete',
          content: [
            { type: 'thinking', text: 'One.', signature: 's', provider: 'p', providerModel: 'm' },
            { type: 'text', text: 'Say.' },
          ],
          entryId: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
      ]),
    )
    expect(custom(replayed as ThreadMessageLike)).toEqual({
      turnId: 'm1',
      thinking: [{ startedAt: null, endedAt: null }],
    })
  })

  it('gives a blank thinking block no timing: ThinkingBlock finds its own among the kept ones', () => {
    // A vendor may stream a block of whitespace only. ThinkingBlock draws nothing for it and finds
    // its timing by its place among the non-blank blocks, so the timings count those alone — else
    // the block after a blank one would show the blank one's time.
    const [, assistant] = toThreadMessages(
      thread(thinking('  '), text('Say.'), thinking('Two.'), thinking(' More.')),
    )
    // The deltas are at 12 000, 13 000, 14 000 and 15 000: the kept block streamed from 14 000.
    expect(custom(assistant as ThreadMessageLike)?.thinking).toEqual([
      { startedAt: 14_000, endedAt: 15_000 },
    ])
  })
})
