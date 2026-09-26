/**
 * The loop's events on their way to the renderer (spec 02 §主进程与 kernel 的循环接口; 01 修补 6
 * 「chat.event」): `SessionEvent` → `chat.event`, for root sessions only. A sub-agent's session never
 * reaches the renderer's stream; its `run-started` still goes to the RunRegistry, which reports the
 * lease's first Run whichever session it ran in.
 *
 * The two tables are spec 01 §desktop 接线's, moved here from chat.ts unchanged. Every event is sent
 * after the fact it reports is committed, and a `run-ended` after the lease is finished: whoever
 * reacts to `done` by sending again finds the session free.
 *
 * Plan step 9 maps what a one-request Run produces. `tool-outcome` (step 14), `user-message` (step
 * 17) and `queue-held` (step 17, to queue.ts) are not forwarded yet; `done.endReason` is step 13.
 */
import { chatEvent } from '@tenon-app/contracts'
import type { ChatEvent } from '@tenon-app/contracts'
import type { ProviderErrorCode, SessionEvent, StopReason } from '@tenon-app/kernel'
import type { EventSender } from './host/index.js'

/** How the interface names a failure. Never a sentence: the renderer owns the copy. */
type ChatErrorCode = Extract<ChatEvent, { type: 'error' }>['code']
type ChatStopReason = Extract<ChatEvent, { type: 'done' }>['stopReason']

/** Spec 01 §desktop 接线, verbatim. `satisfies` makes a new provider code a compile error here. */
export const ERROR_CODE = {
  network: 'network',
  auth: 'auth',
  'rate-limit': 'rate-limit',
  overloaded: 'rate-limit',
  'invalid-request': 'provider',
  'context-overflow': 'provider',
  server: 'provider',
  'egress-denied': 'unknown',
  unknown: 'unknown',
  // Spec 02, 01 修补 5: the same as 01's fallback; the finer reason travels as the Run's endReason.
  'quota-exhausted': 'unknown',
  'account-config': 'unknown',
} as const satisfies Record<ProviderErrorCode, ChatErrorCode>

/**
 * Also verbatim. The three "finished normally" reasons collapse into `end-turn` because the
 * interface has one piece of copy for them; the raw `StopReason` is on the attempt fact, which is
 * where a reader that cares looks.
 */
export const STOP_REASON = {
  'end-turn': 'end-turn',
  'stop-sequence': 'end-turn',
  'tool-use': 'end-turn',
  aborted: 'aborted',
  'max-tokens': 'error',
  refusal: 'error',
  'content-filter': 'error',
  'pause-turn': 'error',
  'context-overflow': 'error',
  unknown: 'error',
} as const satisfies Record<StopReason, ChatStopReason>

/**
 * Sends one `chat.event`. A send that throws is logged and dropped: it runs inside the loop's event
 * handler, where a throw would only reach the kernel's log anyway.
 */
export function emitChatEvent(
  send: EventSender,
  log: (line: string) => void,
  event: ChatEvent,
): void {
  try {
    send(chatEvent.channel, event)
  } catch (error) {
    log(
      `[chat] dropped a ${event.type} event: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export interface RunEventsOptions {
  readonly send: EventSender
  /** Every `run-started`, sub-agent sessions included: the RunRegistry's runId (§RunRegistry). */
  readonly onRunStarted: (rootSessionId: string, runId: string) => void
  readonly log: (line: string) => void
}

export function createRunEvents(options: RunEventsOptions): (event: SessionEvent) => void {
  const { send, onRunStarted, log } = options
  return (event) => {
    if (event.type === 'run-started') {
      onRunStarted(event.rootSessionId, event.runId)
      return
    }
    // Only the root session's events are the renderer's.
    if (event.sessionId !== event.rootSessionId) return
    const sessionId = event.sessionId
    switch (event.type) {
      case 'text-delta':
      case 'thinking-delta':
        emitChatEvent(send, log, { type: event.type, sessionId, delta: event.delta })
        return
      case 'attempt-discarded':
        emitChatEvent(send, log, { type: 'attempt-discarded', sessionId })
        return
      case 'tool-call':
        emitChatEvent(send, log, {
          type: 'tool-call',
          sessionId,
          callKey: event.callKey,
          providerToolCallId: event.providerToolCallId,
          name: event.name,
          input: event.input,
        })
        return
      case 'run-ended':
        emitChatEvent(send, log, terminalEvent(sessionId, event))
        return
      default:
        // tool-outcome, user-message, queue-held: see the file comment.
        return
    }
  }
}

/**
 * `run-ended` as `done` or `error` (01 修补 6): an error when the Run ended on one, otherwise `done`
 * with the last stop by phase 1's table — or, for a Run that made no attempt, `aborted` when it was
 * stopped and `end-turn` otherwise.
 */
function terminalEvent(
  sessionId: string,
  event: Extract<SessionEvent, { type: 'run-ended' }>,
): ChatEvent {
  if (event.errorCode !== null) {
    const detail = diagnosticOf(event)
    return { type: 'error', sessionId, code: ERROR_CODE[event.errorCode], detail }
  }
  const stopped = event.reason.code === 'user-stopped' || event.reason.code === 'shutdown-aborted'
  const stopReason: ChatStopReason =
    event.lastStop === null ? (stopped ? 'aborted' : 'end-turn') : STOP_REASON[event.lastStop]
  return { type: 'done', sessionId, stopReason }
}

/** The never-rendered `detail`: which Run ended, and by which end reason. */
function diagnosticOf(event: Extract<SessionEvent, { type: 'run-ended' }>): string {
  return `run ${event.runId ?? '(none)'} ended: ${event.reason.code}`
}
