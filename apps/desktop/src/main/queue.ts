/**
 * The queued messages (spec 02 §主进程与 kernel 的循环接口; 01 修补 6「排队、立即发送与继续」): the
 * main process's in-memory store behind `LoopPorts.queue`, gone when the app exits (H13, B4). A
 * message is written to the Tape only when the kernel inserts it or sends it; until then it lives
 * here, and every change — the kernel's or the user's — is pushed as `chat.queue`, the whole queue in
 * order, with `held` while a new round waits on the menu's confirmation of a public host.
 */
import { randomUUID } from 'node:crypto'
import type { LoopPorts, QueuedMessage } from '@tenon-app/kernel'

export type RunQueue = LoopPorts['queue']

/** What `chat.queue` carries for one root: the items in order, and `held` when set. */
export interface QueueView {
  readonly items: ReadonlyArray<{ readonly queuedId: string; readonly text: string }>
  readonly held?: { readonly host: string }
}

export interface DesktopQueue extends RunQueue {
  /** `chat.queue.act` withdraw: false when the item is no longer queued. */
  withdraw(root: string, queuedId: string): boolean
  /** `chat.queue.act` edit, in place, keeping its seq: false when the item is no longer queued. */
  edit(root: string, queuedId: string, text: string): boolean
  /** `queue-held` from the kernel: the host a held round waits on, or null once it is cleared. */
  setHeld(root: string, host: string | null): void
  /** Every root whose queue is not empty, as `chat.queue` shows it: what a new window is re-sent. */
  views(): ReadonlyArray<readonly [string, QueueView]>
}

export function createRunQueue(
  options: { readonly onChange?: (root: string, view: QueueView) => void } = {},
): DesktopQueue {
  const queues = new Map<string, QueuedMessage[]>()
  const held = new Map<string, string>()
  let nextSeq = 1

  const queueOf = (root: string): QueuedMessage[] => queues.get(root) ?? []
  const viewOf = (root: string): QueueView => {
    const host = held.get(root)
    return {
      items: queueOf(root).map((item) => ({ queuedId: item.queuedId, text: item.text })),
      ...(host === undefined ? {} : { held: { host } }),
    }
  }
  const notify = (root: string): void => {
    options.onChange?.(root, viewOf(root))
  }
  const store = (root: string, items: QueuedMessage[]): void => {
    if (items.length === 0) queues.delete(root)
    else queues.set(root, items)
    // With nothing left to hold, nothing is held: withdrawing the held message clears it.
    if (items.length === 0) held.delete(root)
    notify(root)
  }

  return {
    enqueue(root, text, o): Promise<{ queuedId: string; seq: number }> {
      const item: QueuedMessage = { queuedId: randomUUID(), seq: nextSeq++, text, urgent: o.urgent }
      store(root, [...queueOf(root), item])
      return Promise.resolve({ queuedId: item.queuedId, seq: item.seq })
    },
    peek(root): Promise<readonly QueuedMessage[]> {
      return Promise.resolve([...queueOf(root)])
    },
    take(root, o): Promise<readonly QueuedMessage[]> {
      const taken: QueuedMessage[] = []
      const kept: QueuedMessage[] = []
      for (const item of queueOf(root)) {
        const picked =
          (o.queuedId === undefined || item.queuedId === o.queuedId) &&
          (o.upToSeq === null || item.seq <= o.upToSeq) &&
          (!o.urgentOnly || item.urgent)
        ;(picked ? taken : kept).push(item)
      }
      if (taken.length > 0) store(root, kept)
      return Promise.resolve(taken)
    },
    restore(root, items): Promise<void> {
      if (items.length === 0) return Promise.resolve()
      // Back at their original seq, with the urgent flag the kernel hands back.
      store(
        root,
        [...queueOf(root), ...items].toSorted((a, b) => a.seq - b.seq),
      )
      return Promise.resolve()
    },
    withdraw(root, queuedId): boolean {
      const items = queueOf(root)
      if (!items.some((item) => item.queuedId === queuedId)) return false
      store(
        root,
        items.filter((item) => item.queuedId !== queuedId),
      )
      return true
    },
    edit(root, queuedId, text): boolean {
      const items = queueOf(root)
      if (!items.some((item) => item.queuedId === queuedId)) return false
      store(
        root,
        items.map((item) =>
          item.queuedId === queuedId
            ? { queuedId: item.queuedId, seq: item.seq, text, urgent: item.urgent }
            : item,
        ),
      )
      return true
    },
    setHeld(root, host): void {
      if (host === null) held.delete(root)
      else held.set(root, host)
      notify(root)
    },
    views() {
      return [...new Set([...queues.keys(), ...held.keys()])].map(
        (root) => [root, viewOf(root)] as const,
      )
    },
  }
}
