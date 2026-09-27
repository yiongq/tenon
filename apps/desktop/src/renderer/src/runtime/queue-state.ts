import { chatQueueEvent } from '@tenon-app/contracts'
import type { TenonBridge } from '../../../preload/index'

export interface QueuedItem {
  readonly queuedId: string
  readonly text: string
}

export interface QueueEntry {
  readonly items: readonly QueuedItem[]
  readonly held: { readonly host: string } | null
  /** Bumped when a round becomes held (or held for another host): the menu opens its confirmation. */
  readonly heldSeq: number
}

const EMPTY: QueueEntry = { items: [], held: null, heldSeq: 0 }

/** Texts kept per root after their item left the queue, for the `user-message` that inserts it. */
const TEXTS_KEPT = 200

const table = new Map<string, QueueEntry>()
const texts = new Map<string, Map<string, string>>()
const listeners = new Set<(sessionId: string) => void>()

/**
 * Each root session's queue as main last pushed it (spec 02 §插话与输入框状态表; §进行中、暂停与
 * RunRegistry「何时推」): kept here, not in a session's store, because a store starts only once its
 * session is on screen — a session switched back to by id, or a reloaded document whose restored
 * session is chosen after `session.latest`, would otherwise miss the one push that named its queue.
 * main.tsx calls `listenForQueue` first, before anything awaits, as it does for `run.state`.
 */
export function listenForQueue(bridge: Pick<TenonBridge, 'on'>): () => void {
  return bridge.on(chatQueueEvent.channel, (payload) => {
    const parsed = chatQueueEvent.payload.safeParse(payload)
    if (!parsed.success) return
    const { sessionId, items } = parsed.data
    const held = parsed.data.held ?? null
    const before = table.get(sessionId) ?? EMPTY
    const known = texts.get(sessionId) ?? new Map<string, string>()
    for (const item of items) {
      known.delete(item.queuedId)
      known.set(item.queuedId, item.text)
    }
    while (known.size > TEXTS_KEPT) known.delete(known.keys().next().value as string)
    texts.set(sessionId, known)
    // A new hold, not every push while one lasts: an edit or a withdraw re-sends `held` too.
    const newHold = held !== null && (before.held === null || before.held.host !== held.host)
    const next: QueueEntry = {
      items,
      held,
      heldSeq: newHold ? before.heldSeq + 1 : before.heldSeq,
    }
    if (items.length === 0 && held === null)
      table.set(sessionId, { ...EMPTY, heldSeq: next.heldSeq })
    else table.set(sessionId, next)
    for (const listener of listeners) listener(sessionId)
  })
}

export function queueOf(sessionId: string): QueueEntry {
  return table.get(sessionId) ?? EMPTY
}

/** A queued item's text, while it waits and for a while after it went in. */
export function queuedTextOf(sessionId: string, queuedId: string): string | undefined {
  return texts.get(sessionId)?.get(queuedId)
}

export function subscribeQueue(listener: (sessionId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
