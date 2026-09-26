/**
 * The queued messages (spec 02 §主进程与 kernel 的循环接口; 01 修补 6「排队、立即发送与继续」): the
 * main process's in-memory store behind `LoopPorts.queue`, gone when the app exits (H13, B4). A
 * message is written to the Tape only when the kernel inserts it; until then it lives here.
 *
 * Plan step 9 implements the four port methods. The `chat.queue` event, `chat.queue.act` (withdraw,
 * edit, send now) and the `held` flag arrive in plan step 17; until then `chat.send` withdraws what the
 * kernel queued (see chat.ts) so nothing waits in a queue that is not yet sent automatically.
 */
import { randomUUID } from 'node:crypto'
import type { LoopPorts, QueuedMessage } from '@tenon-app/kernel'

export type RunQueue = LoopPorts['queue']

export function createRunQueue(): RunQueue {
  const queues = new Map<string, QueuedMessage[]>()
  let nextSeq = 1

  const queueOf = (root: string): QueuedMessage[] => queues.get(root) ?? []
  const store = (root: string, items: QueuedMessage[]): void => {
    if (items.length === 0) queues.delete(root)
    else queues.set(root, items)
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
      store(root, kept)
      return Promise.resolve(taken)
    },
    restore(root, items): Promise<void> {
      // Back at their original seq, with the urgent flag the kernel hands back.
      store(
        root,
        [...queueOf(root), ...items].toSorted((a, b) => a.seq - b.seq),
      )
      return Promise.resolve()
    },
  }
}
