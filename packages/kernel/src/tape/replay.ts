/**
 * Folding and replay (spec 01 §投影与重放).
 *
 * `effectiveMessages` is the fold: same `messageId` ⇒ the highest `revision` wins, and a
 * `message/retracted` with a LARGER `entry_id` hides the message. Phase 1's inputs are kind
 * `message`, kind `anchor` and the one event `message/retracted`; every other kind and every other
 * event name passes through untouched as evidence and never becomes a message. `tool_call` /
 * `tool_result` fold with their shape in phase 2.
 *
 * `rebuildProviderContext` pages the fold out of a store and hands back provider messages. A
 * request's context is a PREFIX of the tape, not the whole tape, which is why every
 * `provider/attempt_completed` records the `contextAtEntryId` it was assembled at and why replay can
 * be pinned to it.
 */
import type { ContentBlock, InternalMessage, ModelInfo } from '../provider/types.js'
import type { MessageStatus, TapeEntry } from './entry.js'
import { parseMessagePayload, parseRetractedMessageId } from './projection.js'
import type { TapeReadRangeQuery, TapeReader } from './store.js'
import { MAX_READ_LIMIT } from './store.js'

/** One visible message after folding. `orderSeq` is the display and replay order, not `entryId`. */
export interface EffectiveMessage {
  readonly messageId: string
  readonly revision: number
  readonly role: 'user' | 'assistant'
  readonly content: readonly ContentBlock[]
  readonly status: MessageStatus
  /** `entry_id` of the FIRST `message/*` fact of this messageId. */
  readonly orderSeq: number
  /** `entry_id` of the winning revision. */
  readonly entryId: number
}

/** The three kinds the fold reads. Everything else is evidence and is skipped. */
export const REPLAY_KINDS = Object.freeze(['message', 'anchor', 'event'] as const)

interface FoldState {
  orderSeq: number
  retractedAt: number
  winner: EffectiveMessage | null
}

/**
 * Order-independent on purpose: `orderSeq` is a minimum, the retraction is a maximum and the winner
 * is picked by `revision`, so a caller that hands entries over in some other order still gets the
 * same answer. The result is sorted by `orderSeq`.
 */
export function effectiveMessages(entries: readonly TapeEntry[]): EffectiveMessage[] {
  const states = new Map<string, FoldState>()
  const stateFor = (messageId: string): FoldState => {
    const existing = states.get(messageId)
    if (existing !== undefined) return existing
    const created: FoldState = { orderSeq: Number.MAX_SAFE_INTEGER, retractedAt: -1, winner: null }
    states.set(messageId, created)
    return created
  }
  for (const entry of entries) {
    if (entry.kind === 'message') {
      if (entry.name !== 'message/user' && entry.name !== 'message/assistant') continue
      const payload = parseMessagePayload(entry)
      const state = stateFor(payload.messageId)
      state.orderSeq = Math.min(state.orderSeq, entry.entryId)
      // A larger entryId wins a revision tie. Two facts with one (messageId, revision) cannot
      // legitimately exist — their provenance keys are equal, so the second append is the idempotent
      // no-op — but the fold must still be total over what a disk hands it.
      const beats =
        state.winner === null ||
        payload.revision > state.winner.revision ||
        (payload.revision === state.winner.revision && entry.entryId > state.winner.entryId)
      if (beats) {
        state.winner = {
          messageId: payload.messageId,
          revision: payload.revision,
          role: payload.role,
          content: payload.content,
          status: payload.status,
          orderSeq: state.orderSeq,
          entryId: entry.entryId,
        }
      }
      continue
    }
    if (entry.kind === 'event' && entry.name === 'message/retracted') {
      const state = stateFor(parseRetractedMessageId(entry))
      state.retractedAt = Math.max(state.retractedAt, entry.entryId)
    }
  }
  const visible: EffectiveMessage[] = []
  for (const state of states.values()) {
    const winner = state.winner
    if (winner === null) continue
    // A retraction only hides what came before it: a revision appended afterwards carries a larger
    // entry id and brings the message back, which is what edit-after-delete has to mean.
    if (state.retractedAt > winner.entryId) continue
    visible.push({ ...winner, orderSeq: state.orderSeq })
  }
  visible.sort((left, right) => left.orderSeq - right.orderSeq)
  return visible
}

export interface ReadEffectiveMessagesQuery {
  sessionId: string
  /** Inclusive snapshot upper bound — normally a recorded `contextAtEntryId`. */
  atEntryId?: number
}

/**
 * The fold, read out of a store: pages `readRange` over the three replay kinds and applies
 * `effectiveMessages`.
 *
 * `atEntryId` is pinned for every page and the first page's `incarnationId` is handed back on all of
 * them, so a reset mid-read is a `TapeStaleIncarnationError` rather than a silently mixed history and
 * appends between pages cannot leak in.
 *
 * It keeps `messageId`, `revision` and `orderSeq`, which is what separates it from
 * `rebuildProviderContext`: a caller that has to name a message — phase 6's edit and retract, a
 * reader checking a revision — needs its identity, not just its content. A caller that only wants the
 * LAST message should read `listMessages` instead: the projection is this same fold, already folded,
 * and this function pages the whole prefix.
 */
export async function readEffectiveMessages(
  store: TapeReader,
  q: ReadEffectiveMessagesQuery,
): Promise<EffectiveMessage[]> {
  const entries: TapeEntry[] = []
  let fromEntryId: number | undefined
  let incarnationId: string | undefined
  for (;;) {
    const query: TapeReadRangeQuery = {
      sessionId: q.sessionId,
      kinds: REPLAY_KINDS,
      limit: MAX_READ_LIMIT,
      ...(fromEntryId === undefined ? {} : { fromEntryId }),
      ...(q.atEntryId === undefined ? {} : { atEntryId: q.atEntryId }),
      ...(incarnationId === undefined ? {} : { incarnationId }),
    }
    // Paging is sequential by nature: the next cursor IS this page's answer.
    // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
    const page = await store.readRange(query)
    entries.push(...page.entries)
    incarnationId = page.incarnationId
    if (page.nextFromEntryId === null) break
    fromEntryId = page.nextFromEntryId
  }
  return effectiveMessages(entries)
}

export interface RebuildProviderContextQuery extends ReadEffectiveMessagesQuery {
  /**
   * The model this context is being assembled FOR. Replay does not consult it (see the note below);
   * it stays in the signature because the spec puts it there and because the day the thinking guard
   * moves, the callers do not change.
   */
  target: ModelInfo
}

/**
 * Rebuilds the provider context from the tape: `readEffectiveMessages` (which owns the paging and the
 * pinning) minus everything a provider must not see — the ids, the ordinals and the empty turns.
 *
 * **Thinking blocks pass through UNCHANGED.** The guard (`decideThinking`) runs only inside
 * `encode()`, per the decision recorded in plan.md 「Open」: the guard's rule 4 needs to know whether
 * THIS request carries tools, which replay cannot know, and dropping blocks here would leave the
 * `thinkingDecisions` audit trail on `provider/attempt_completed` incomplete. Both readings produce
 * the same `promptHash`, so this one is reversible.
 *
 * A message whose content array is EMPTY is never yielded: nothing writes one (a failed turn writes
 * no assistant message at all), and the Anthropic wire protocol answers 400 to one in either role.
 * That is the whole of what replay guarantees about wire shape, and the boundary is worth being exact
 * about, because two neighbouring guarantees are `encode()`'s:
 *
 *   - a block with no renderable content (a `text` / `thinking` block whose text is empty) — both
 *     wire protocols reject one, and `encode()` already has to skip them because
 *     `applyThinkingDecision` can produce one (recorded for step 9 in plan.md);
 *   - the ARRANGEMENT of turns: adjacent same-role turns (normal here — a failed turn writes no
 *     assistant message, so two user messages can meet) and a context that opens on an assistant turn
 *     (a retracted first user message). Replay applies the fold and nothing else — spec 01 §投影与重放:
 *     「不从渲染层的 block 猜语义」 — so whatever a wire requires of the arrangement is the adapter's to
 *     satisfy in `encode()`, where the target and the tools are known.
 */
export async function rebuildProviderContext(
  store: TapeReader,
  q: RebuildProviderContextQuery,
): Promise<InternalMessage[]> {
  const messages = await readEffectiveMessages(store, q)
  return messages
    .filter((message) => message.content.length > 0)
    .map((message) => ({ role: message.role, content: [...message.content] }))
}
