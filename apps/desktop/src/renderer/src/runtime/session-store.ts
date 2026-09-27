import {
  approvalCurrent,
  approvalList,
  approvalRespond,
  approvalResume,
  chatContinue,
  chatEvent,
  chatEventSchema,
  chatQueueAct,
  chatQueueEvent,
  chatSend,
  chatSendNow,
  chatStop,
  confirmRequestEvent,
  invokeRoute,
  sessionFacts,
} from '@tenon-app/contracts'
import type { ChatEvent, MessageRowContract, SessionFactsResponse } from '@tenon-app/contracts'
import type { TenonBridge } from '../../../preload/index'
import { queueOf, queuedTextOf } from './queue-state'
import type { QueuedItem } from './queue-state'
import { runStateOf, subscribeRunState } from './run-state'
import {
  EMPTY_THREAD,
  applyEvent,
  threadFromRows,
  withSentText,
  withSettled,
  withoutTurn,
} from './thread-model'
import type { ThreadModel } from './thread-model'

export type { QueuedItem }

/** What `approval.current` answers for an approval, as the card reads it. */
export type PendingCard = Extract<
  NonNullable<Awaited<ReturnType<typeof readCurrent>>>,
  { waitKind: 'approval' }
>
type Pending = NonNullable<Awaited<ReturnType<typeof readCurrent>>>

/** An answer this window gave, kept until the row's own outcome says so (a live collapse). */
export interface Answered {
  readonly outcome: 'allowed' | 'denied'
  readonly scope: 'once' | 'session' | null
  readonly target: PendingCard['card']['target']
  readonly subtask: boolean
}

export interface SessionSnapshot {
  readonly model: ThreadModel
  readonly queue: readonly QueuedItem[]
  readonly held: { readonly host: string } | null
  /** Bumped by each round held for a public host (a queue push or 「继续」): the menu's confirmation. */
  readonly heldSeq: number
  readonly pending: Pending | null
  /** When the current card arrived: clicks within `APPROVAL_CLICK_GUARD_MS` do nothing. */
  readonly pendingSince: number
  /** Keyed by the row the card hung under (`anchorCallKey`), where the collapsed line shows. */
  readonly answered: ReadonlyMap<string, Answered>
  /** The kernel's resumable set holds this root (`approval.list`'s `resume` row). */
  readonly resumable: boolean
  readonly facts: SessionFactsResponse | null
  readonly running: boolean
  readonly runId: string | null
  /** False while startup recovery's restore is in flight (B15): nothing can be sent. */
  readonly canSend: boolean
  /** A task whose model holds text conversations only: sending is disabled, with the reason (A15). */
  readonly textOnlyTask: boolean
}

function readCurrent(bridge: TenonBridge, sessionId: string) {
  return invokeRoute(bridge, approvalCurrent, { sessionId }).then((result) =>
    result.ok ? result.data : null,
  )
}

/** A send whose message the events will show: a `user-message`, or a queue push (§插话与输入框状态表). */
const EVENTS_FOLLOW: ReadonlySet<string> = new Set(['started', 'queued', 'held'])

let localIds = 0
const nextLocalId = (): string => `local-${String((localIds += 1))}`

/** How many other sessions' rows `approval.list` returns (暂定; calibrated in plan step 34). */
export const APPROVAL_LIST_LIMIT = 20

/**
 * One session's state on screen (spec 02 plan step 20), behind assistant-ui's external-store runtime:
 * the thread from the stored rows and the live `chat.event`s, the queue from `chat.queue` (seeded
 * from the window's queue table, so a session shown again still has it), the card from
 * `approval.current` (every other source — `confirm.request`, a `paused` end, a `stale` answer, a
 * superseded call — is only a signal to read it again), the running flag from `run.state`.
 */
export class SessionStore {
  readonly sessionId: string
  readonly #bridge: TenonBridge
  readonly #listeners = new Set<() => void>()
  #snapshot: SessionSnapshot
  /** The text of each queued item seen, for the `user-message` that inserts it. */
  readonly #queuedTexts = new Map<string, string>()
  /** Each read is numbered; an answer older than the newest one asked for is dropped. */
  readonly #asked = { pending: 0, facts: 0, resumable: 0 }
  #opened = false

  constructor(
    sessionId: string,
    bridge: TenonBridge,
    rows: readonly MessageRowContract[],
    canSend = true,
  ) {
    this.sessionId = sessionId
    this.#bridge = bridge
    const run = runStateOf(sessionId)
    const queued = queueOf(sessionId)
    for (const item of queued.items) this.#queuedTexts.set(item.queuedId, item.text)
    this.#snapshot = {
      model: rows.length === 0 ? EMPTY_THREAD : threadFromRows(rows),
      queue: queued.items,
      held: queued.held,
      heldSeq: queued.heldSeq,
      pending: null,
      pendingSince: 0,
      answered: new Map(),
      resumable: false,
      facts: null,
      running: run.running,
      runId: run.runId,
      canSend,
      textOnlyTask: false,
    }
  }

  getSnapshot = (): SessionSnapshot => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #set(next: Partial<SessionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next }
    for (const listener of this.#listeners) listener()
  }

  /** Why sending is disabled now, or null (§模型菜单与输入框「提示与禁发」: only these two). */
  sendBlock(): 'restoring' | 'textOnlyTask' | null {
    if (!this.#snapshot.canSend) return 'restoring'
    return this.#snapshot.textOnlyTask ? 'textOnlyTask' : null
  }

  setCanSend(canSend: boolean): void {
    if (canSend !== this.#snapshot.canSend) this.#set({ canSend })
  }

  setTextOnlyTask(textOnlyTask: boolean): void {
    if (textOnlyTask !== this.#snapshot.textOnlyTask) this.#set({ textOnlyTask })
  }

  /** Subscribes to the pushes of this session; returns the undo. */
  attach(): () => void {
    const offs = [
      this.#bridge.on(chatEvent.channel, (payload) => {
        const parsed = chatEventSchema.safeParse(payload)
        if (parsed.success && parsed.data.sessionId === this.sessionId) this.#onEvent(parsed.data)
      }),
      this.#bridge.on(chatQueueEvent.channel, (payload) => {
        const parsed = chatQueueEvent.payload.safeParse(payload)
        if (!parsed.success || parsed.data.sessionId !== this.sessionId) return
        this.#onQueue(parsed.data.items, parsed.data.held ?? null)
      }),
      // Only a signal: the card itself is read from `approval.current` (§最小审批卡「数据」).
      this.#bridge.on(confirmRequestEvent.channel, () => void this.refreshPending()),
      subscribeRunState(() => this.#readRunState()),
    ]
    // What the tables heard between this store's construction (during render) and now (an effect):
    // a push in that gap reached only them.
    this.#readRunState()
    const queued = queueOf(this.sessionId)
    if (queued.items !== this.#snapshot.queue || queued.held !== this.#snapshot.held) {
      this.#onQueue(queued.items, queued.held)
    }
    return () => {
      for (const off of offs) off()
    }
  }

  #readRunState(): void {
    const run = runStateOf(this.sessionId)
    if (run.running !== this.#snapshot.running || run.runId !== this.#snapshot.runId) {
      this.#set({ running: run.running, runId: run.runId })
    }
  }

  #onQueue(items: readonly QueuedItem[], held: { readonly host: string } | null): void {
    const fresh = items.filter((item) => !this.#queuedTexts.has(item.queuedId))
    for (const item of items) this.#queuedTexts.set(item.queuedId, item.text)
    // A message this window just sent that queued instead of opening a Run: its bubble is in the
    // queue now, so the turn shown for it goes — the oldest one with its words, as sends queue in
    // the order they were made.
    let model = this.#snapshot.model
    for (const item of fresh) {
      const shown = model.turns.find(
        (turn) =>
          turn.optimistic === true &&
          turn.parts.some((part) => part.kind === 'text' && part.text === item.text),
      )
      if (shown !== undefined) model = withoutTurn(model, shown.id)
    }
    // A new hold, not every push while one lasts: an edit or a withdraw re-sends `held` too.
    const before = this.#snapshot.held
    const newHold = held !== null && (before === null || before.host !== held.host)
    const heldSeq = newHold ? this.#snapshot.heldSeq + 1 : this.#snapshot.heldSeq
    this.#set({ model, queue: items, held, heldSeq })
  }

  #onEvent(event: ChatEvent): void {
    const model = applyEvent(this.#snapshot.model, event, {
      now: Date.now(),
      nextId: nextLocalId,
      queuedText: (queuedId) =>
        this.#queuedTexts.get(queuedId) ?? queuedTextOf(this.sessionId, queuedId),
    })
    if (model !== this.#snapshot.model) this.#set({ model })
    const pending = this.#snapshot.pending
    if (event.type === 'tool-outcome') {
      const answered = this.#snapshot.answered
      // The row's own outcome is on it now — the kernel names the answer on every closure an answer
      // wrote, a stricter re-judgement's included — so the collapse this window made is not needed.
      if (answered.has(event.callKey) && event.approval !== undefined) {
        const kept = new Map(answered)
        kept.delete(event.callKey)
        this.#set({ answered: kept })
      }
      // The call the card waited on closed without an answer from here — superseded by a new
      // message, cancelled by a stop: the card goes at once, with no collapsed line (§最小审批卡「答完」).
      if (
        pending?.waitKind === 'approval' &&
        (event.callKey === pending.callKey || event.callKey === pending.anchorCallKey)
      ) {
        this.#set({ pending: null, pendingSince: 0 })
        void this.refreshPending()
      }
    }
    if (event.type === 'user-message') {
      // A message that went in while something waited supersedes it (§多卡、拒绝与取代).
      if (pending !== null) void this.refreshPending()
      // The first message establishes the session: the mode is fixed from here (§界面范围 ModeSwitch).
      if (this.#snapshot.facts?.established === false) void this.refreshFacts()
    }
    if (event.type === 'done' || event.type === 'error') {
      // A Run that paused left a card to fetch (§答复与投递); any end may have cleared one.
      void this.refreshPending()
      void this.refreshResumable()
      if (this.#snapshot.facts?.established === false) void this.refreshFacts()
    }
  }

  /**
   * What an opened session needs besides its rows: its card, its facts, whether it can resume.
   * Once per store: a remount of the same session (React's StrictMode runs effects twice) must not
   * resume twice (§离开会话 第 4 条: exactly one `approval.resume`).
   */
  async open(o: { readonly resume: boolean }): Promise<void> {
    if (this.#opened) return
    this.#opened = true
    await Promise.all([this.refreshPending(), this.refreshFacts(), this.refreshResumable()])
    // Switched to by id: the kernel resumes what startup recovery listed (§离开会话 第 4 条). The
    // session a window restored on its own is not "opened": it offers 「继续」 instead.
    if (o.resume) await this.resume()
  }

  async refreshPending(): Promise<void> {
    const asked = (this.#asked.pending += 1)
    const pending = await readCurrent(this.#bridge, this.sessionId)
    if (asked !== this.#asked.pending) return
    const before = this.#snapshot.pending
    const same =
      before !== null &&
      pending !== null &&
      before.waitKind === 'approval' &&
      pending.waitKind === 'approval' &&
      before.card.requestId === pending.card.requestId
    // By `requestId`: the same card delivered twice is one card (§HostConfirm 可重复投递).
    if (same) return
    if (before === null && pending === null) return
    this.#set({ pending, pendingSince: pending === null ? 0 : Date.now() })
  }

  async refreshFacts(): Promise<void> {
    const asked = (this.#asked.facts += 1)
    const facts = await invokeRoute(this.#bridge, sessionFacts, { sessionId: this.sessionId })
    if (asked === this.#asked.facts && facts.ok) this.#set({ facts: facts.data })
  }

  async refreshResumable(): Promise<void> {
    const asked = (this.#asked.resumable += 1)
    const list = await invokeRoute(this.#bridge, approvalList, { limit: APPROVAL_LIST_LIMIT })
    if (asked !== this.#asked.resumable || !list.ok) return
    const resumable = list.data.some(
      (row) => row.sessionId === this.sessionId && row.waitKind === 'resume',
    )
    if (resumable !== this.#snapshot.resumable) this.#set({ resumable })
  }

  async resume(): Promise<void> {
    await invokeRoute(this.#bridge, approvalResume, { sessionId: this.sessionId })
    await this.refreshResumable()
  }

  /** Shows the message at once; the `user-message` gives it its id, a queue push moves it to a bubble. */
  async #sendShown(
    text: string,
    route: () => Promise<
      | { readonly ok: false }
      | { readonly ok: true; readonly data: { readonly status?: string | undefined } }
    >,
  ): Promise<void> {
    if (this.sendBlock() !== null) return
    const id = nextLocalId()
    this.#set({ model: withSentText(this.#snapshot.model, text, id, Date.now()) })
    const sent = await route()
    // Refused outright (recovery gate, shutting down): nothing was sent, so nothing is shown.
    if (!sent.ok) {
      this.#set({ model: withoutTurn(this.#snapshot.model, id) })
      return
    }
    // Taken, but nothing was written and no event will name it (a missing key, a stop in the
    // prebuild): it stays shown as sent, and a later message's id is never given to it.
    const status = sent.data.status
    if (status !== undefined && !EVENTS_FOLLOW.has(status)) {
      this.#set({ model: withSettled(this.#snapshot.model, id) })
    }
    // Held for a public host: the menu opens its confirmation, for this send too when an earlier
    // one was held for the same host (the queue push then carries no new hold).
    if (status === 'held') this.#set({ heldSeq: this.#snapshot.heldSeq + 1 })
  }

  /** 「发送」. */
  send(text: string): Promise<void> {
    return this.#sendShown(text, () =>
      invokeRoute(this.#bridge, chatSend, { sessionId: this.sessionId, text }),
    )
  }

  /**
   * Cmd/Ctrl+Enter: stops the Run the user sees, then this goes next (H13). Shown like any send:
   * when that Run has already ended, the kernel sends it directly.
   */
  sendNow(text: string): Promise<void> {
    return this.#sendShown(text, () =>
      invokeRoute(this.#bridge, chatSendNow, {
        sessionId: this.sessionId,
        text,
        runId: this.#snapshot.runId,
      }),
    )
  }

  async stop(): Promise<void> {
    await invokeRoute(this.#bridge, chatStop, { sessionId: this.sessionId })
    await this.refreshPending()
    await this.refreshResumable()
  }

  /** 「继续」; a round held for a public host opens the model menu's confirmation (§重试与「继续」). */
  async continueRun(): Promise<void> {
    const continued = await invokeRoute(this.#bridge, chatContinue, { sessionId: this.sessionId })
    if (continued.ok && continued.data.status === 'held' && continued.data.host !== undefined) {
      this.#set({ held: { host: continued.data.host }, heldSeq: this.#snapshot.heldSeq + 1 })
    }
  }

  /**
   * 「重试」: the same user message again, which the kernel reads as a resend of it when it is the
   * last message (01 spec.md:395); shown like a send, and taken back when the kernel wrote no new one.
   */
  async retry(messageId: string): Promise<void> {
    const message = this.#snapshot.model.turns.find(
      (turn) => turn.role === 'user' && turn.id === messageId,
    )
    const text = message?.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('')
    if (text === undefined || text === '') return
    await this.send(text)
  }

  async respond(decision: 'allow' | 'deny'): Promise<void> {
    const pending = this.#snapshot.pending
    if (pending?.waitKind !== 'approval') return
    const answered = await invokeRoute(this.#bridge, approvalRespond, {
      kind: 'approval',
      sessionId: pending.card.sessionId,
      requestId: pending.card.requestId,
      decision,
    })
    if (answered.ok && answered.data.status === 'applied') {
      const collapsed = new Map(this.#snapshot.answered)
      // Under the row the card hung under: a sub-agent's card collapses there, not under a call of
      // the child session that this thread has no row for (§最小审批卡「位置」).
      collapsed.set(pending.anchorCallKey, {
        outcome: decision === 'allow' ? 'allowed' : 'denied',
        scope: decision === 'allow' ? pending.allowScope : null,
        target: pending.card.target,
        subtask: pending.callKey !== pending.anchorCallKey,
      })
      this.#set({ answered: collapsed, pending: null, pendingSince: 0 })
    }
    // `stale` shows the new card; anything else re-reads what waits.
    await this.refreshPending()
  }

  async queueAct(
    act:
      | { readonly action: 'withdraw'; readonly queuedId: string }
      | { readonly action: 'edit'; readonly queuedId: string; readonly text: string }
      | { readonly action: 'send-now'; readonly queuedId: string },
  ): Promise<void> {
    const acted = await invokeRoute(this.#bridge, chatQueueAct, {
      ...act,
      sessionId: this.sessionId,
      ...(act.action === 'send-now' ? { runId: this.#snapshot.runId } : {}),
    } as never)
    // Held again for a public host (the same one, so the queue push is no new hold): the menu
    // opens its confirmation on it, as for a held send.
    if (acted.ok && acted.data.sendStatus === 'held') {
      this.#set({ heldSeq: this.#snapshot.heldSeq + 1 })
    }
  }
}
