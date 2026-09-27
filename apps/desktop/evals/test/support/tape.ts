/**
 * A hand-built session Tape for the check tests: the real memory store, written through the kernel's
 * slice writers, so every fact has the identity columns and provenance key §02 的 Tape 事实 gives it
 * and the payloads are typed by the kernel's own payload types. One Run; each round is one request,
 * its calls numbered `<i>` from 0 in order.
 */
import {
  createMemoryTapeStore,
  createTape,
  runTerminalKey,
  toolCallKey,
  toolOutcomeKey,
  toolResultKey,
} from '@tenon-app/kernel'
import type {
  ClosureSource,
  NewEntry,
  RunEndReason,
  RunTerminalPayload,
  SpillRecord,
  TapeReader,
  ToolCallPayload,
  ToolOutcomePayload,
  ToolResultPayload,
} from '@tenon-app/kernel'
import { createCounterIds } from '@tenon-app/kernel/testing'

export interface FakeCall {
  readonly name: string
  readonly input: Record<string, unknown>
  /** What the model was sent back. Default: '' */
  readonly text?: string
  readonly isError?: boolean
  readonly spill?: SpillRecord
  /** A closure source (the call did not run) or, by default, null: it ran. */
  readonly source?: ClosureSource | null
}

export interface FakeSession {
  readonly tape: TapeReader
  readonly sessionId: string
}

let clock = 1_790_000_000_000

export type Rounds = readonly (readonly FakeCall[])[]

/** `rounds` may be built from the session id, for calls that name the session's own spill folder. */
export async function tapeOf(
  plan: Rounds | ((sessionId: string) => Rounds),
  end: RunEndReason = { code: 'completed' },
): Promise<FakeSession> {
  const ids = createCounterIds()
  const sessionId = ids.uuid()
  const rounds = typeof plan === 'function' ? plan(sessionId) : plan
  const incarnationId = ids.uuid()
  const runId = ids.uuid()
  const store = createMemoryTapeStore({
    identity: { userId: 'u', tenantId: 'tenant-evals', profileDir: '/profiles/evals' },
  })
  const tape = createTape(store)
  const at = (): number => (clock += 10)
  const entries: NewEntry[] = [
    tape.writer('session').entry('session/start', {
      sourceType: 'session',
      sourceId: sessionId,
      sourceSeq: 0,
      provenanceKey: `session:v1:start:${incarnationId}`,
      payload: { incarnationId },
      createdAt: at(),
    }),
  ]
  const writer = { by: 'run', runId } as const
  for (const [requestSeq, round] of rounds.entries()) {
    const messageId = ids.uuid()
    for (const [ordinal, call] of round.entries()) {
      const ref = { ordinal, providerToolCallId: `toolu_${requestSeq}_${ordinal}` }
      const identity = {
        sourceType: 'runtime_event',
        sourceId: runId,
        sourceSeq: requestSeq,
      } as const
      const source = call.source ?? null
      const payload: ToolCallPayload = {
        ...ref,
        messageId,
        name: call.name,
        input: call.input,
        argsHash: JSON.stringify(call.input),
      }
      const result: ToolResultPayload = {
        ...ref,
        isError: call.isError ?? source !== null,
        content: [{ type: 'text', text: call.text ?? '' }],
        kernelAuthored: source !== null,
        ...(call.spill === undefined ? {} : { spill: call.spill }),
        writer,
      }
      const outcome: ToolOutcomePayload = {
        ...ref,
        effect: source === null ? 'read' : 'blocked',
        state: source === null ? 'completed' : 'not-run',
        source,
        ...(source === 'policy' ? { facts: { toolName: call.name } } : {}),
        reversibility: 'unknown',
        writer,
      }
      entries.push(
        tape.writer('tool').entry('tool/call', {
          ...identity,
          provenanceKey: toolCallKey(runId, requestSeq, ordinal),
          payload,
          createdAt: at(),
        }),
        tape.writer('tool').entry('tool/result', {
          ...identity,
          provenanceKey: toolResultKey(runId, requestSeq, ordinal),
          payload: result,
          createdAt: at(),
        }),
        tape.writer('execution').entry('execution/tool_outcome', {
          ...identity,
          provenanceKey: toolOutcomeKey(runId, requestSeq, ordinal),
          payload: outcome,
          createdAt: at(),
        }),
      )
    }
  }
  const terminal: RunTerminalPayload = { reason: end, steps: rounds.length, usage: [], writer }
  entries.push(
    tape.writer('execution').entry('execution/run_terminal', {
      sourceType: 'runtime_event',
      sourceId: runId,
      provenanceKey: runTerminalKey(runId),
      payload: terminal,
      createdAt: at(),
    }),
  )
  await tape.appendEntries({ sessionId, incarnationId, entries })
  return { tape, sessionId }
}

/** A path inside the session's own spill folder, as the spill note gives it. */
export function spillPath(sessionId: string, file: string): string {
  return `/profiles/evals/tool-output/${sessionId}/${file}`
}
