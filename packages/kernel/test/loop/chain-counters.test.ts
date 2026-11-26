/* oxlint-disable no-await-in-loop -- each case writes its own Tape, one after another */
/** The Tape-side machine-denial counts follow the execution loop's own reset rule (06 §熔断). */
import { expect, it } from 'vitest'
import { createMemoryHost, createMemoryTapeStore, createTape } from '../../src/index.js'
import { chainCounters } from '../../src/loop/run.js'
import {
  dispatchCommittedKey,
  runStartedKey,
  sessionStartKey,
  toolOutcomeKey,
} from '../../src/tape/provenance.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const INC = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'
const MESSAGE = '44444444-4444-4444-8444-444444444444'

interface Closure {
  readonly source: string | null
  readonly dispatched: boolean
  /** The request (model response) and position in it; default: request 0, its index. */
  readonly seq?: number
  readonly ordinal?: number
}
/** One Run whose calls close in this order; `dispatched` closures have their dispatch fact first. */
async function countsAfter(closures: readonly Closure[]) {
  const memory = createMemoryHost()
  const tape = createTape(createMemoryTapeStore({ identity: memory.identity }))
  const base = { sourceType: 'runtime_event' as const, sourceId: RUN, createdAt: 0 }
  const writer = { by: 'run' as const, runId: RUN }
  await tape.appendEntries({
    sessionId: SESSION,
    incarnationId: INC,
    entries: [
      tape.writer('session').entry('session/start', {
        sourceType: 'session',
        sourceId: SESSION,
        sourceSeq: 0,
        provenanceKey: sessionStartKey(INC),
        payload: { incarnationId: INC },
        createdAt: 0,
      }),
      tape.writer('execution').entry('execution/run_started', {
        ...base,
        provenanceKey: runStartedKey(RUN),
        payload: { cause: { kind: 'user-message', messageId: MESSAGE } },
      }),
      ...closures.flatMap(({ source, dispatched, seq = 0, ordinal: at }, index) => {
        const ordinal = at ?? index
        const ref = { ordinal, providerToolCallId: `call-${seq}-${ordinal}` }
        return [
          ...(dispatched
            ? [
                tape.writer('execution').entry('execution/dispatch_committed', {
                  ...base,
                  sourceSeq: seq,
                  provenanceKey: dispatchCommittedKey(RUN, seq, ordinal),
                  payload: {
                    ...ref,
                    name: 'Bash',
                    argsHash: 'hash',
                    decisionKey: 'decision',
                    writer,
                  },
                }),
              ]
            : []),
          tape.writer('execution').entry('execution/tool_outcome', {
            ...base,
            sourceSeq: seq,
            provenanceKey: toolOutcomeKey(RUN, seq, ordinal),
            payload: {
              ...ref,
              state: source === null ? 'completed' : 'not-run',
              effect: 'external',
              source: source as never,
              reversibility: 'unknown',
              writer,
            },
          }),
        ]
      }),
    ],
  })
  const { denials, roundDenials } = await chainCounters(tape, SESSION, RUN)
  return { denials, roundDenials }
}
const denied: Closure = { source: 'inspector', dispatched: false }

it.each(['timed-out', 'tool-unavailable', 'connector-unauthorized', 'crashed'])(
  '06 验收 24: a dispatched call closed as %s resets the consecutive count like the loop does',
  async (source) => {
    expect(await countsAfter([denied, denied, { source, dispatched: true }])).toEqual({
      denials: 0,
      roundDenials: 2,
    })
    expect(await countsAfter([denied, denied, { source, dispatched: true }, denied])).toEqual({
      denials: 1,
      roundDenials: 3,
    })
  },
)

it('06 验收 24: closures that never ran leave the consecutive count alone, as in the loop', async () => {
  for (const source of ['invalid-input', 'tool-unavailable', 'user-rejected', 'stopped'])
    expect(await countsAfter([denied, denied, { source, dispatched: false }])).toEqual({
      denials: 2,
      roundDenials: 2,
    })
})

it('06 验收 24: a dispatched call the sandbox or a protected path blocked still counts', async () => {
  for (const source of ['sandbox', 'protected'])
    expect(await countsAfter([denied, { source, dispatched: true }])).toEqual({
      denials: 2,
      roundDenials: 2,
    })
})

it('06 验收 24: a call that completed with no source resets the count', async () => {
  expect(await countsAfter([denied, denied, { source: null, dispatched: true }, denied])).toEqual({
    denials: 1,
    roundDenials: 3,
  })
})

it('06 验收 24: a repaired call resets the consecutive count, as 02 resets on an allow', async () => {
  // The loop leaves its count alone on a repair; the Tape side follows 02 §上限: the repaired call
  // was allowed, and an allow in between resets. A repair only exists in a packaged build.
  expect(await countsAfter([denied, denied, { source: 'repair', dispatched: true }])).toEqual({
    denials: 0,
    roundDenials: 2,
  })
})

it('06 验收 24: only the same call’s dispatch makes a closure count as run', async () => {
  const ran: Closure = { source: null, dispatched: true, seq: 0, ordinal: 0 }
  // Another call of the same request that never ran keeps the count.
  expect(
    await countsAfter([
      ran,
      { ...denied, ordinal: 1 },
      { ...denied, ordinal: 2 },
      { source: 'invalid-input', dispatched: false, ordinal: 3 },
    ]),
  ).toEqual({ denials: 2, roundDenials: 2 })
  // The same position in a later request is another call.
  expect(
    await countsAfter([
      ran,
      { ...denied, seq: 1, ordinal: 1 },
      { ...denied, seq: 1, ordinal: 2 },
      { source: 'invalid-input', dispatched: false, seq: 1, ordinal: 0 },
    ]),
  ).toEqual({ denials: 2, roundDenials: 2 })
})
