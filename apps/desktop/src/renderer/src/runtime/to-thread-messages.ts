import type { ThreadMessageLike } from '@assistant-ui/react'
import { retryable, summaryBefore } from './thread-model'
import type { RunEnd, ThinkingPart, ThreadModel, Turn, TurnSummary } from './thread-model'

/**
 * The model as assistant-ui draws it. What assistant-ui has no part for — the failure card, the
 * summary line, thinking timings — travels in `metadata.custom`, read back by the message's own
 * components; a tool call's `toolCallId` is its `callKey`, the one key the whole interface shares.
 */
export interface TurnCustom {
  readonly turnId: string
  readonly end?: RunEnd
  readonly summary?: TurnSummary
  readonly retryable?: boolean
  readonly thinking?: ReadonlyArray<{
    readonly startedAt: number | null
    readonly endedAt: number | null
  }>
}

export function toThreadMessages(model: ThreadModel): ThreadMessageLike[] {
  // A reply typed while a question waits is drawn only once it turns out to be a message.
  const turns = model.turns.filter((turn) => turn.answering !== true)
  return turns.map((turn, index) => toMessage(turns, turn, index))
}

function toMessage(turns: readonly Turn[], turn: Turn, index: number): ThreadMessageLike {
  // One timing per reasoning part assistant-ui keeps: it drops a blank one (fromThreadMessageLike),
  // and ThinkingBlock finds its timing by its place among the kept ones.
  const thinking = turn.parts
    .filter((part): part is ThinkingPart => part.kind === 'thinking' && part.text.trim() !== '')
    .map((part) => ({ startedAt: part.startedAt, endedAt: part.endedAt }))
  const custom: TurnCustom = {
    turnId: turn.id,
    ...(turn.end === undefined ? {} : { end: turn.end }),
    ...(turn.end === undefined || turn.end.endReason?.code === 'paused'
      ? {}
      : (() => {
          const summary = summaryBefore(turns, index)
          return summary === null ? {} : { summary }
        })()),
    ...(turn.end === undefined ? {} : { retryable: retryable(turns, index) }),
    ...(thinking.length === 0 ? {} : { thinking }),
  }
  const content = turn.parts.map((part) => {
    switch (part.kind) {
      case 'text':
        return { type: 'text' as const, text: part.text }
      case 'thinking':
        return { type: 'reasoning' as const, text: part.text }
      case 'tool':
        return {
          type: 'tool-call' as const,
          toolCallId: part.callKey,
          toolName: part.name,
          args: part.input as never,
          ...(part.outcome === null ? {} : { result: part.outcome }),
        }
    }
  })
  return {
    id: turn.id,
    role: turn.role,
    createdAt: new Date(turn.createdAt),
    content,
    metadata: { custom: custom as unknown as Record<string, unknown> },
    ...(turn.role === 'assistant' ? { status: statusOf(turn) } : {}),
  }
}

function statusOf(turn: Turn): NonNullable<ThreadMessageLike['status']> {
  switch (turn.status) {
    case 'running':
      return { type: 'running' }
    case 'aborted':
      return { type: 'incomplete', reason: 'cancelled' }
    case 'error':
      return {
        type: 'incomplete',
        reason: 'error',
        error: { code: turn.end?.errorCode ?? 'unknown' },
      }
    case 'complete':
      return { type: 'complete', reason: 'stop' }
  }
}
