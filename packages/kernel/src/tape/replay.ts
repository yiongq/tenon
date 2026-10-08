/**
 * Folding and replay (spec 01 §投影与重放; spec 02, 01 修补 7 and §折叠与读法).
 *
 * `effectiveMessages` is the fold: same `messageId` ⇒ the highest `revision` wins, and a
 * `message/retracted` with a LARGER `entry_id` hides the message. Its inputs are kind `message` —
 * `message/user`, `message/assistant` and, from spec 02, `message/continuation`, which is a user
 * message to the provider even though it never gets a projection row — kind `anchor` and the one
 * event `message/retracted`; every other kind and every other event name passes through untouched as
 * evidence and never becomes a message.
 *
 * `REPLAY_KINDS` reads `tool_call` and `tool_result` too (spec 02 only adds those two), and
 * `rebuildProviderContext` places them (§重放怎么排): for the provider, the tool facts are authoritative
 * — an assistant turn's i-th `tool-request` block only marks where its i-th `tool/call` goes, and the
 * results follow that turn in one user message, in `<i>` order, wherever the Tape holds them. A
 * retracted assistant turn takes its calls and results with it: they hang off its `messageId`.
 *
 * `rebuildProviderContext` pages the fold out of a store and hands back provider messages. A
 * request's context is a PREFIX of the tape, not the whole tape, which is why every
 * `provider/attempt_completed` records the `contextAtEntryId` it was assembled at and why replay can
 * be pinned to it. From spec 02 it reads from the most recent `compaction/anchor` at or below that
 * point: the anchor's summary as one user message, then the messages whose `orderSeq` is at or after
 * its `keepFromEntryId` (§重建、保留尾巴与思考块).
 */
import type { ContentBlock, InternalMessage, ModelInfo } from '../provider/types.js'
import type { MessageStatus, TapeEntry } from './entry.js'
import { TapeProjectionError, parseMessagePayload, parseRetractedMessageId } from './projection.js'
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

/**
 * The kinds replay reads. Spec 02 adds `tool_call` and `tool_result` (01 修补 7); everything else is
 * evidence and is skipped.
 */
export const REPLAY_KINDS = Object.freeze([
  'message',
  'anchor',
  'event',
  'tool_call',
  'tool_result',
] as const)

/**
 * The message facts the fold reads. `message/continuation` (spec 02, A2) and `message/environment`
 * (open question 16) are user turns.
 */
function isFoldedMessage(entry: TapeEntry): boolean {
  return (
    entry.name === 'message/user' ||
    entry.name === 'message/assistant' ||
    entry.name === 'message/continuation' ||
    entry.name === 'message/environment' ||
    entry.name === 'message/server_instructions'
  )
}

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
      if (!isFoldedMessage(entry)) continue
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
  return effectiveMessages(await readReplayEntries(store, q))
}

/** The replay kinds of a pinned prefix, paged, with one incarnation carried across every page. */
async function readReplayEntries(
  store: TapeReader,
  q: ReadEffectiveMessagesQuery,
): Promise<TapeEntry[]> {
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
  return entries
}

/** What replay takes from a `compaction/anchor`, read field by field like every other payload. */
interface CompactionCut {
  readonly summary: string
  readonly keepFromEntryId: number
}

function readCompactionCut(entry: TapeEntry): CompactionCut {
  const summary = entry.payload['summary']
  const keepFromEntryId = entry.payload['keepFromEntryId']
  if (typeof summary !== 'string') {
    throw new TapeProjectionError(`${entry.name}: payload.summary must be a string`)
  }
  if (
    typeof keepFromEntryId !== 'number' ||
    !Number.isSafeInteger(keepFromEntryId) ||
    keepFromEntryId < 0
  ) {
    throw new TapeProjectionError(
      `${entry.name}: payload.keepFromEntryId must be a non-negative safe integer`,
    )
  }
  return { summary, keepFromEntryId }
}

/** The most recent `compaction/anchor` of a prefix, or null when none was written. */
function latestCompaction(entries: readonly TapeEntry[]): CompactionCut | null {
  let latest: TapeEntry | null = null
  for (const entry of entries) {
    if (entry.kind !== 'anchor' || entry.name !== 'compaction/anchor') continue
    if (latest === null || entry.entryId > latest.entryId) latest = entry
  }
  return latest === null ? null : readCompactionCut(latest)
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
  return (await replayContext(store, q)).messages
}

/**
 * A client call in the context with no `tool/result`: what the pairing check before `encode()` finds
 * (§崩溃、服务端调用块与兜底「兜底」). `dispatched` says whether its `dispatch_committed` is on the
 * Tape, which is what a repair closure's execution state follows; `closed`, whether its
 * `tool_outcome` is — then only the result is missing, and only it is written (§执行日志与恢复表「损坏」:
 * 补写缺的那一条).
 */
export interface UnansweredCall {
  readonly runId: string
  readonly requestSeq: number
  readonly ordinal: number
  readonly providerToolCallId: string
  readonly name: string
  readonly dispatched: boolean
  readonly closed: boolean
}

/**
 * A visible assistant turn whose `tool-request` blocks and `tool/call` facts disagree in number or in
 * `providerToolCallId` (§重放怎么排 1: 按恢复表的「损坏」类处理). Its calls are placed from the facts
 * (B1: 以工具事实为准组装上下文): a block with no fact is left out, a fact with no block gets one.
 */
export interface MismatchedTurn {
  readonly messageId: string
  readonly blocks: number
  readonly calls: number
}

/**
 * `rebuildProviderContext` and the pairing check in one read of the prefix: the messages, and every
 * call of a visible assistant turn that has no result. A retracted turn's calls are not in the
 * context, so they are never unanswered; nor are the calls a compaction summarised away.
 */
export async function replayContext(
  store: TapeReader,
  q: RebuildProviderContextQuery & { readonly beforeOrderSeq?: number },
): Promise<{
  messages: InternalMessage[]
  orderSeqs: number[]
  unanswered: UnansweredCall[]
  mismatched: MismatchedTurn[]
}> {
  const entries = await readReplayEntries(store, q)
  const cut = latestCompaction(entries)
  const tools = toolFactsOf(entries)
  const messages: InternalMessage[] = []
  const orderSeqs: number[] = []
  const unanswered: UnansweredCall[] = []
  const mismatched: MismatchedTurn[] = []
  for (const message of effectiveMessages(entries)) {
    if (cut !== null && message.orderSeq < cut.keepFromEntryId) continue
    if (q.beforeOrderSeq !== undefined && message.orderSeq >= q.beforeOrderSeq) continue
    if (message.role !== 'assistant') {
      if (message.content.length > 0) {
        messages.push({ role: message.role, content: [...message.content] })
        orderSeqs.push(message.orderSeq)
      }
      continue
    }
    const calls = tools.calls.get(message.messageId) ?? []
    const requests = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-request' }> =>
        block.type === 'tool-request',
    )
    const agrees =
      requests.length === calls.length &&
      requests.every((block, i) => block.id === calls[i]?.providerToolCallId)
    if (!agrees) {
      mismatched.push({
        messageId: message.messageId,
        blocks: requests.length,
        calls: calls.length,
      })
    }
    const content = agrees ? placeCalls(message.content, calls) : byFacts(message.content, calls)
    if (content.length > 0) {
      messages.push({ role: 'assistant', content })
      orderSeqs.push(message.orderSeq)
    }
    // The results follow their assistant turn, in <i> order — wherever the Tape holds them.
    const responses: ContentBlock[] = []
    for (const call of calls) {
      const result = tools.results.get(call.key)
      if (result === undefined) {
        unanswered.push({
          runId: call.runId,
          requestSeq: call.requestSeq,
          ordinal: call.ordinal,
          providerToolCallId: call.providerToolCallId,
          name: call.name,
          dispatched: tools.dispatched.has(call.key),
          closed: tools.closed.has(call.key),
        })
        continue
      }
      responses.push({
        type: 'tool-response',
        id: call.providerToolCallId,
        content: result.content,
        isError: result.isError,
      })
    }
    if (responses.length > 0) {
      messages.push({ role: 'user', content: responses })
      orderSeqs.push(message.orderSeq)
    }
  }
  if (cut === null) return { messages, orderSeqs, unanswered, mismatched }
  // The summary is stored as it was sent (after `compactionWrap`), so replay takes it verbatim.
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: cut.summary }] }, ...messages],
    orderSeqs: [-1, ...orderSeqs],
    unanswered,
    mismatched,
  }
}

/** A `tool/call` as replay places it. */
interface ReplayCall {
  readonly key: string
  readonly runId: string
  readonly requestSeq: number
  readonly ordinal: number
  readonly providerToolCallId: string
  readonly name: string
  readonly input: Record<string, unknown>
}

/** What replay takes from a `tool/result`. */
interface ReplayResult {
  readonly content: Array<Extract<ContentBlock, { type: 'text' | 'image' }>>
  readonly isError: boolean
}

/** A call's identity across its tool/ facts: (runId, requestSeq, <i>). */
function callIdentity(entry: TapeEntry): string {
  return `${String(entry.sourceId)}:${String(entry.sourceSeq)}:${String(entry.payload['ordinal'])}`
}

/**
 * The calls by the assistant message they belong to, in <i> order, the results by call, and which
 * calls were dispatched and which have their outcome.
 */
function toolFactsOf(entries: readonly TapeEntry[]): {
  calls: Map<string, ReplayCall[]>
  results: Map<string, ReplayResult>
  dispatched: Set<string>
  closed: Set<string>
} {
  const calls = new Map<string, ReplayCall[]>()
  const results = new Map<string, ReplayResult>()
  const dispatched = new Set<string>()
  const closed = new Set<string>()
  for (const entry of entries) {
    if (entry.name === 'execution/dispatch_committed') dispatched.add(callIdentity(entry))
    else if (entry.name === 'execution/tool_outcome') closed.add(callIdentity(entry))
    else if (entry.name === 'tool/call') {
      const messageId = entry.payload['messageId']
      if (typeof messageId !== 'string') {
        throw new TapeProjectionError(`${entry.name}: payload.messageId must be a string`)
      }
      const list = calls.get(messageId) ?? []
      list.push({
        key: callIdentity(entry),
        runId: String(entry.sourceId),
        requestSeq: Number(entry.sourceSeq),
        ordinal: Number(entry.payload['ordinal']),
        providerToolCallId: String(entry.payload['providerToolCallId']),
        name: String(entry.payload['name']),
        input: entry.payload['input'] as Record<string, unknown>,
      })
      calls.set(messageId, list)
    } else if (entry.name === 'tool/result') {
      // The first result of a call counts (先写者算数): a later one is never written, and if a disk
      // held one anyway, replay would still pair the call once.
      const key = callIdentity(entry)
      if (results.has(key)) continue
      results.set(key, {
        content: entry.payload['content'] as ReplayResult['content'],
        isError: entry.payload['isError'] === true,
      })
    }
  }
  for (const list of calls.values()) list.sort((a, b) => a.ordinal - b.ordinal)
  return { calls, results, dispatched, closed }
}

/**
 * The assistant content with each `tool-request` block taken from its `tool/call`: the block marks
 * the position, the fact gives the id, the name and the input. The caller has checked that the
 * blocks and the facts agree.
 */
function placeCalls(
  content: readonly ContentBlock[],
  calls: readonly ReplayCall[],
): ContentBlock[] {
  if (calls.length === 0) return [...content]
  let next = 0
  return content.map((block): ContentBlock => {
    if (block.type !== 'tool-request') return block
    const call = calls[next]
    next += 1
    if (call === undefined) return block
    return {
      type: 'tool-request',
      id: call.providerToolCallId,
      name: call.name,
      input: call.input,
      // What the vendor sent verbatim on the block stays with it (01 修补 2), and so does where it
      // came from, which the guard judges it by (s6-spec-2, owner 2026-09-27).
      ...(block.vendorFields === undefined ? {} : { vendorFields: block.vendorFields }),
      ...(block.vendorSource === undefined ? {} : { vendorSource: block.vendorSource }),
    }
  })
}

/**
 * A turn whose blocks and facts disagree (「损坏」), placed from the facts alone: the stored
 * `tool-request` blocks go, and each `tool/call` comes after the rest of the content in `<i>` order,
 * so every call sent has its block and no block is sent without its call. The pairing check before
 * `encode()` throws on such a turn in development and test builds; this is what a packaged build
 * sends after it logs the repair.
 */
function byFacts(content: readonly ContentBlock[], calls: readonly ReplayCall[]): ContentBlock[] {
  return [
    ...content.filter((block) => block.type !== 'tool-request'),
    ...calls.map((call): ContentBlock => ({
      type: 'tool-request',
      id: call.providerToolCallId,
      name: call.name,
      input: call.input,
    })),
  ]
}
