import type {
  ChatEvent,
  MessageRowContract,
  RunEndReasonContract,
  ToolOutcomeViewContract,
} from '@tenon-app/contracts'

/**
 * The conversation on screen, as the renderer keeps it (spec 02 plan step 20: the external-store
 * runtime). It is built from two sources only — the stored rows a session opens on, and the
 * `chat.event`s of Runs that are live — and never from what assistant-ui itself decides, so a Run
 * the kernel opened on its own (a resume, 「继续」, an auto-send) lands in the same thread as one
 * the user started.
 *
 * Pure: every function returns a new model. The store (ChatProvider) holds the current one.
 */

export type ChatErrorCode = Extract<ChatEvent, { type: 'error' }>['code']

export interface TextPart {
  readonly kind: 'text'
  readonly text: string
}

/** A thinking block; `startedAt` / `endedAt` exist only while it streamed (a replay has no timing). */
export interface ThinkingPart {
  readonly kind: 'thinking'
  readonly text: string
  readonly startedAt: number | null
  readonly endedAt: number | null
}

/** One tool call: its key (unique, unlike the vendor's id), what it was asked, how it closed. */
export interface ToolPart {
  readonly kind: 'tool'
  readonly callKey: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly outcome: ToolOutcomeViewContract | null
  /** The live Run it arrived in (`RunTrack.seq`); null for a stored row. */
  readonly run: number | null
}

export type Part = TextPart | ThinkingPart | ToolPart

/** How a Run ended, on its last assistant turn: what the failure card and the summary line read. */
export interface RunEnd {
  /** From the terminal event itself (null when the Run was never written), never inferred. */
  readonly runId: string | null
  readonly endReason: RunEndReasonContract | null
  readonly errorCode: ChatErrorCode | null
  /**
   * The user message 「重试」 resends, as the kernel names it: the one that opened the Run, when none
   * of the Run's calls was dispatched (§失败卡与结束原因); null for any other Run. The renderer does
   * not infer it — from event order a Run an answer opened can look like one a message opened.
   */
  readonly retryOf: string | null
}

export interface Turn {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly parts: readonly Part[]
  readonly status: 'running' | 'complete' | 'aborted' | 'error'
  readonly runId: string | null
  readonly createdAt: number
  /** A user turn sent from this window and not yet written: its id is still a local one. */
  readonly optimistic?: boolean
  /**
   * Sent while a question waited, so most likely its typed answer, which is no message
   * (§插话与输入框状态表「等提问」): not drawn until the kernel says what it became — the answer takes
   * it away, a `user-message` or a settled send shows it after all.
   */
  readonly answering?: boolean
  readonly end?: RunEnd
  /** For an assistant turn a live Run started: that Run (`RunTrack.seq`). */
  readonly run?: number
  /**
   * For the empty turn of an end nothing was written for: the message this window was sending when
   * it arrived, which it may answer — `withSettled` moves it under that message if the route says
   * nothing was written for it.
   */
  readonly answers?: string
}

/**
 * The live Run as the event order shows it — chat events carry no Run id, and a `callKey` is only
 * ever compared (spec §chat.event): a Run is everything between two terminal events, and its end
 * goes on a turn it wrote itself.
 */
export interface RunTrack {
  readonly seq: number
}

export interface ThreadModel {
  readonly turns: readonly Turn[]
  /** The assistant turn that takes the next delta, or null (a new one starts). */
  readonly draft: string | null
  readonly run: RunTrack
}

const FIRST_RUN: RunTrack = { seq: 0 }

export const EMPTY_THREAD: ThreadModel = { turns: [], draft: null, run: FIRST_RUN }

/** A restored session: its stored rows, tool calls matched to `calls[i]`. */
export function threadFromRows(rows: readonly MessageRowContract[]): ThreadModel {
  return {
    draft: null,
    run: FIRST_RUN,
    turns: rows.map((row) => {
      const calls = row.calls ?? []
      let call = 0
      const parts: Part[] = []
      for (const block of row.content) {
        if (block.type === 'text' && block.text !== '')
          parts.push({ kind: 'text', text: block.text })
        else if (block.type === 'thinking' && block.text !== '') {
          parts.push({ kind: 'thinking', text: block.text, startedAt: null, endedAt: null })
        } else if (block.type === 'tool-request') {
          const known = calls[call]
          call += 1
          parts.push({
            kind: 'tool',
            callKey: known?.callKey ?? `${row.messageId}:${block.id}`,
            name: block.name,
            input: block.input,
            outcome: known?.outcome ?? null,
            run: null,
          })
        }
      }
      return {
        id: row.messageId,
        role: row.role,
        parts,
        status:
          row.status === 'aborted' ? 'aborted' : row.status === 'error' ? 'error' : 'complete',
        runId: null,
        createdAt: row.createdAt,
      }
    }),
  }
}

/**
 * The user's message, shown at once; the kernel's `user-message` gives it its id. One sent while a
 * question waits is kept `answering`, not drawn, until the route says whether it was the answer.
 */
export function withSentText(
  model: ThreadModel,
  text: string,
  id: string,
  now: number,
  answering = false,
): ThreadModel {
  return {
    ...model,
    turns: [
      ...model.turns,
      {
        id,
        role: 'user',
        parts: [{ kind: 'text', text }],
        status: 'complete',
        runId: null,
        createdAt: now,
        optimistic: true,
        ...(answering ? { answering: true } : {}),
      },
    ],
  }
}

/** A written or settled message is drawn, whatever it was sent as. */
function shown(turn: Turn): Turn {
  const { answering: _answering, ...rest } = turn
  return { ...rest, optimistic: false }
}

/** Takes back a message that went to the queue instead (it shows as a queued bubble there). */
export function withoutTurn(model: ThreadModel, id: string): ThreadModel {
  return { ...model, turns: model.turns.filter((turn) => turn.id !== id) }
}

export interface ApplyContext {
  readonly now: number
  /** A fresh local id for a turn the events start. */
  readonly nextId: () => string
  /** The text of a queued item, for the `user-message` that inserts it. */
  readonly queuedText: (queuedId: string) => string | undefined
}

/** One live event of this session. */
export function applyEvent(model: ThreadModel, event: ChatEvent, ctx: ApplyContext): ThreadModel {
  switch (event.type) {
    case 'user-message':
      return userMessage(model, event, ctx)
    case 'text-delta':
      return delta(model, 'text', event.delta, ctx)
    case 'thinking-delta':
      return delta(model, 'thinking', event.delta, ctx)
    case 'tool-call':
      return toolCall(model, event, ctx)
    case 'tool-outcome':
      return toolOutcome(model, event.callKey, outcomeOf(event))
    case 'attempt-discarded':
      return discarded(model)
    case 'done':
      return ended(
        model,
        {
          runId: event.runId ?? null,
          endReason: event.endReason ?? null,
          errorCode: null,
          retryOf: event.retryOf ?? null,
          status: event.stopReason === 'aborted' ? 'aborted' : 'complete',
        },
        ctx,
      )
    case 'error':
      return ended(
        model,
        {
          runId: event.runId ?? null,
          endReason: event.endReason ?? null,
          errorCode: event.code,
          retryOf: event.retryOf ?? null,
          status: 'error',
        },
        ctx,
      )
    default:
      return model
  }
}

function userMessage(
  model: ThreadModel,
  event: Extract<ChatEvent, { type: 'user-message' }>,
  ctx: ApplyContext,
): ThreadModel {
  const known = model.turns.find((turn) => turn.id === event.messageId)
  if (known !== undefined) {
    // A resend the kernel wrote as the same message (01 spec.md:395): the echo 「重试」 showed goes.
    const echo = model.turns.findIndex(
      (turn) => turn.optimistic === true && textOf(turn) === textOf(known),
    )
    const turns = echo < 0 ? model.turns : model.turns.filter((_, i) => i !== echo)
    return { ...model, turns }
  }
  if (event.queuedId === null) {
    // The oldest message this window sent and has not seen written: the mailbox writes sends in
    // the order they arrived, so this is its id on the Tape.
    const index = model.turns.findIndex((turn) => turn.optimistic === true)
    if (index < 0) return model
    const turns = [...model.turns]
    const turn = turns[index] as Turn
    turns[index] = { ...shown(turn), id: event.messageId }
    return { ...model, turns }
  }
  const text = ctx.queuedText(event.queuedId)
  if (text === undefined) return model
  // A queued message went in at a batch boundary (after the results, before the next reply), or
  // out with a new message — ahead of the ones this window is still sending, shown at the end.
  const turn: Turn = {
    id: event.messageId,
    role: 'user',
    parts: [{ kind: 'text', text }],
    status: 'complete',
    runId: null,
    createdAt: ctx.now,
  }
  return { ...model, draft: null, turns: beforeUnsent(model.turns, turn) }
}

function textOf(turn: Turn): string {
  return turn.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('')
}

/** Inserts a turn ahead of the trailing messages this window sent and has not seen written. */
function beforeUnsent(turns: readonly Turn[], turn: Turn): Turn[] {
  let at = turns.length
  while (at > 0 && turns[at - 1]?.optimistic === true) at -= 1
  return [...turns.slice(0, at), turn, ...turns.slice(at)]
}

/** The draft turn, started when there is none: a Run's first delta, or the one after a result. */
function draftOf(model: ThreadModel, ctx: ApplyContext): { model: ThreadModel; index: number } {
  const index = model.turns.findIndex((turn) => turn.id === model.draft)
  if (index >= 0) return { model, index }
  const id = ctx.nextId()
  const turn: Turn = {
    id,
    role: 'assistant',
    parts: [],
    status: 'running',
    runId: null,
    createdAt: ctx.now,
    run: model.run.seq,
  }
  const turns = beforeUnsent(model.turns, turn)
  return { model: { ...model, turns, draft: id }, index: turns.indexOf(turn) }
}

function delta(
  model: ThreadModel,
  kind: 'text' | 'thinking',
  text: string,
  ctx: ApplyContext,
): ThreadModel {
  const drafted = draftOf(model, ctx)
  const turns = [...drafted.model.turns]
  const turn = turns[drafted.index] as Turn
  const parts = [...turn.parts]
  const last = parts.at(-1)
  if (kind === 'text') {
    if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + text }
    else parts.push({ kind: 'text', text })
  } else if (last?.kind === 'thinking') {
    parts[parts.length - 1] = { ...last, text: last.text + text, endedAt: ctx.now }
  } else {
    parts.push({ kind: 'thinking', text, startedAt: ctx.now, endedAt: ctx.now })
  }
  turns[drafted.index] = { ...turn, parts }
  return { ...drafted.model, turns }
}

function toolCall(
  model: ThreadModel,
  event: Extract<ChatEvent, { type: 'tool-call' }>,
  ctx: ApplyContext,
): ThreadModel {
  const drafted = draftOf(model, ctx)
  const turns = [...drafted.model.turns]
  const turn = turns[drafted.index] as Turn
  if (turn.parts.some((part) => part.kind === 'tool' && part.callKey === event.callKey)) {
    return model
  }
  const part: ToolPart = {
    kind: 'tool',
    callKey: event.callKey,
    name: event.name,
    input: event.input,
    outcome: null,
    run: drafted.model.run.seq,
  }
  turns[drafted.index] = { ...turn, parts: [...turn.parts, part] }
  // The calls are announced once the reply is on the Tape: the draft stays open for the batch's
  // other calls, and the next request's text starts the next turn (see `sealAfterCalls`).
  return { ...drafted.model, turns }
}

function toolOutcome(
  model: ThreadModel,
  callKey: string,
  outcome: ToolOutcomeViewContract,
): ThreadModel {
  let found = false
  const turns = model.turns.map((turn) => {
    if (!turn.parts.some((part) => part.kind === 'tool' && part.callKey === callKey)) return turn
    found = true
    return {
      ...turn,
      parts: turn.parts.map((part) =>
        part.kind === 'tool' && part.callKey === callKey ? { ...part, outcome } : part,
      ),
    }
  })
  // A result closes the reply that asked for it: the text after it is the next request's.
  return found ? { ...model, turns, draft: sealed(model, callKey) } : model
}

/** After a result, the next delta belongs to a new turn — unless it is the reply still streaming. */
function sealed(model: ThreadModel, callKey: string): string | null {
  const draft = model.turns.find((turn) => turn.id === model.draft)
  const holds = draft?.parts.some((part) => part.kind === 'tool' && part.callKey === callKey)
  return holds === true ? null : model.draft
}

function outcomeOf(event: Extract<ChatEvent, { type: 'tool-outcome' }>): ToolOutcomeViewContract {
  const {
    type: _type,
    sessionId: _session,
    callKey: _key,
    providerToolCallId: _id,
    ...view
  } = event
  return view
}

/** 「作废」: what the discarded attempt streamed goes; its calls never existed. */
function discarded(model: ThreadModel): ThreadModel {
  const index = model.turns.findIndex((turn) => turn.id === model.draft)
  const turn = model.turns[index]
  if (turn === undefined) return model
  const kept = turn.parts.filter((part) => part.kind === 'tool')
  const turns = [...model.turns]
  if (kept.length === 0) turns.splice(index, 1)
  else turns[index] = { ...turn, parts: kept }
  return { ...model, turns, draft: kept.length === 0 ? null : model.draft }
}

function ended(
  model: ThreadModel,
  end: Pick<RunEnd, 'runId' | 'endReason' | 'errorCode' | 'retryOf'> & {
    status: Turn['status']
  },
  ctx: ApplyContext,
): ThreadModel {
  const seq = model.run.seq
  const turns = model.turns.map((turn) =>
    turn.status === 'running' ? { ...turn, status: end.status } : turn,
  )
  const closing: RunEnd = {
    runId: end.runId,
    endReason: end.endReason,
    errorCode: end.errorCode,
    retryOf: end.retryOf,
  }
  // The failure card and the summary hang on this Run's last assistant turn; a Run that wrote none
  // (a missing key, a stop before any text, a failed 「继续」) gets an empty one of its own, never
  // an earlier Run's, ahead of the messages still on their way. With no Run id it may be the answer
  // to the oldest of them (the mailbox takes sends in order): it says so, and `withSettled` moves it
  // under that message once the route says nothing was written for it.
  const own = turns.findLastIndex((turn) => turn.role === 'assistant' && turn.run === seq)
  let placed: Turn[] = turns
  let index = own
  if (own < 0) {
    const waiting = end.runId === null ? turns.find((turn) => turn.optimistic === true) : undefined
    const empty: Turn = {
      id: ctx.nextId(),
      role: 'assistant',
      parts: [],
      status: end.status,
      runId: end.runId,
      createdAt: ctx.now,
      run: seq,
      ...(waiting === undefined ? {} : { answers: waiting.id }),
    }
    placed = beforeUnsent(turns, empty)
    index = placed.indexOf(empty)
  }
  const turn = placed[index] as Turn
  placed[index] = { ...turn, runId: end.runId, end: closing }
  return { turns: placed, draft: null, run: { seq: seq + 1 } }
}

/**
 * A message this window showed that the kernel will never name — nothing was written (a missing
 * key, a stop in the prebuild, the route's own failure): it stays as sent, no longer awaiting an id,
 * so a later message's id is never given to it. When its end arrived first, that end went ahead of
 * it (marked `answers`): it moves under the message it answers. When the route's answer comes
 * first, the end arrives after the settled message and lands below it anyway.
 */
export function withSettled(model: ThreadModel, id: string): ThreadModel {
  const echo = model.turns.find((turn) => turn.id === id)
  if (echo === undefined) return model
  const answer = model.turns.find((turn) => turn.answers === id)
  const turns = model.turns.flatMap((turn): Turn[] => {
    if (turn === answer) return []
    if (turn !== echo) return [turn]
    const settled: Turn = shown(echo)
    if (answer === undefined) return [settled]
    const { answers: _answers, ...moved } = answer
    return [settled, moved]
  })
  return { ...model, turns }
}

/** The round's last user message: the one the kernel wrote, not one still on its way. */
function lastWritten(turns: readonly Turn[], index: number): number {
  return turns
    .slice(0, index + 1)
    .findLastIndex((turn) => turn.role === 'user' && turn.optimistic !== true)
}

/** What one turn's calls did: `TurnSummaryLine` counts them from the last user message on. */
export interface TurnSummary {
  readonly read: number
  readonly write: number
  readonly external: number
}

export function summaryBefore(turns: readonly Turn[], index: number): TurnSummary | null {
  const lastUser = lastWritten(turns, index)
  // One line a round: a later Run of the same round that ended (paused aside) carries it instead.
  const later = turns.slice(index + 1)
  const nextUser = later.findIndex((turn) => turn.role === 'user' && turn.optimistic !== true)
  const round = nextUser < 0 ? later : later.slice(0, nextUser)
  if (round.some((turn) => turn.end !== undefined && turn.end.endReason?.code !== 'paused')) {
    return null
  }
  let read = 0
  let write = 0
  let external = 0
  for (const turn of turns.slice(lastUser + 1, index + 1)) {
    for (const part of turn.parts) {
      if (part.kind !== 'tool' || part.outcome === null) continue
      if (part.outcome.effect === 'read') read += 1
      else if (part.outcome.effect === 'write') write += 1
      else if (part.outcome.effect === 'external') external += 1
    }
  }
  return read + write + external === 0 ? null : { read, write, external }
}

/**
 * Whether 「重试」 may resend the user's message (§失败卡与结束原因): the kernel named one — a user
 * message opened the Run and none of its calls went out.
 */
export function retryable(turns: readonly Turn[], index: number): boolean {
  return (turns[index]?.end?.retryOf ?? null) !== null
}
