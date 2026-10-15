import type { Turn } from '../runtime/thread-model'

/**
 * What the line under the latest turn says while a Run is going (components.md `StatusLine`: the
 * vocabulary is fixed, and the whole line goes when the round ends rather than changing its words).
 * Nothing here is a new kernel event: it reads what the window already knows — `run.state`
 * (running) and the thread.
 */
export type StatusLineState =
  | { readonly kind: 'thinking' }
  | { readonly kind: 'writing' }
  | { readonly kind: 'working'; readonly seconds: number }

export interface StatusLineInput {
  /** `run.state.running`: a live lease that is not aborted. */
  readonly running: boolean
  readonly turns: readonly Turn[]
  /** When this window first heard of the Run, or null. */
  readonly since: number | null
  readonly now: number
  /** The calls a card or a question waits on (the call, and the row its card hangs under). */
  readonly waitingOn?: readonly string[]
}

/**
 * - not running → no line. That includes a Run that was stopped and is still closing: 02 §模型菜单与
 *   输入框「停止与发送」 puts what a stop did on the failure card's second line and adds no copy of its
 *   own, so the line simply goes;
 * - a call of the latest reply is out and not waiting on a card → 正在干活 · N 秒, N from the Run's
 *   start. The reply may have ended already: a command approved on its card runs in the Run the
 *   answer started, before that Run has written anything of its own;
 * - a tool call is the latest thing of the reply → 正在干活 too (the model's next step after a result
 *   counts as working);
 * - text is arriving → 撰写中…;
 * - the thinking block is the reply's tail → no line: the block itself says 「思考中 · N 秒」, and
 *   two lines saying the same would be one too many;
 * - anything else — nothing has come back yet → 思考中….
 *
 * A Run that paused on a card or a question is no longer running (the main process reports it as
 * ended), so it has no line: the card is the feedback.
 */
export function statusLineOf(input: StatusLineInput): StatusLineState | null {
  if (!input.running) return null
  const working = (): StatusLineState => ({
    kind: 'working',
    seconds: input.since === null ? 0 : Math.max(0, Math.floor((input.now - input.since) / 1000)),
  })
  const last = input.turns.at(-1)
  // A user message last means the new Run has produced nothing yet.
  if (last?.role !== 'assistant') return { kind: 'thinking' }
  const waiting = input.waitingOn ?? []
  const out = last.parts.some(
    (part) => part.kind === 'tool' && part.outcome === null && !waiting.includes(part.callKey),
  )
  if (out) return working()
  // An old reply from an earlier Run, all of it settled: the new Run has drawn nothing yet.
  if (last.status !== 'running') return { kind: 'thinking' }
  const tail = last.parts.at(-1)
  if (tail?.kind === 'tool') return working()
  if (tail?.kind === 'text') return { kind: 'writing' }
  if (tail?.kind === 'thinking') return null
  return { kind: 'thinking' }
}
