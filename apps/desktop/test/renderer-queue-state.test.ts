/**
 * The renderer's `chat.queue` table (spec 02 §插话与输入框状态表; §进行中、暂停与 RunRegistry「何时推」;
 * plan step 20 「排队气泡」「`chat.queue` 事件带 `held` 时打开模型菜单的确认页」): each root session's
 * queue as main last pushed it, kept for the window rather than for one session's store — a session
 * shown again, or a document reloaded before its session is chosen, must still have the one push
 * that named its queue — with the texts of items that already went in, for the `user-message` that
 * inserts them, and a counter the model menu opens its confirmation on.
 */
import { randomUUID } from 'node:crypto'
import { chatQueueEvent, isEventChannel } from '@tenon-app/contracts'
import type { EventPayload } from '@tenon-app/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { TenonBridge } from '../src/preload/index.js'
import {
  listenForQueue,
  queueOf,
  queuedTextOf,
  subscribeQueue,
} from '../src/renderer/src/runtime/queue-state.js'

type QueuePush = EventPayload<typeof chatQueueEvent>

/** Only `on`, which is all the table takes; `push` delivers a payload as main sent it. */
function fakeBridge(): {
  bridge: Pick<TenonBridge, 'on'>
  push(payload: QueuePush): void
  pushRaw(payload: unknown): void
} {
  const listeners = new Set<(payload: unknown) => void>()
  const pushRaw = (payload: unknown): void => {
    for (const listener of listeners) listener(payload)
  }
  return {
    bridge: {
      on: (channel, listener) => {
        if (!isEventChannel(channel)) throw new Error(`not an event: ${channel}`)
        if (channel !== chatQueueEvent.channel) return () => undefined
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    push: (payload) => pushRaw(chatQueueEvent.payload.parse(payload)),
    pushRaw,
  }
}

const undo: Array<() => void> = []

function listening(): ReturnType<typeof fakeBridge> {
  const fake = fakeBridge()
  undo.push(listenForQueue(fake.bridge))
  return fake
}

afterEach(() => {
  for (const off of undo.splice(0)) off()
})

/** The table is the module's own and outlives a test: each case works on sessions of its own. */
const session = (): string => randomUUID()

const HOST = { host: 'api.anthropic.com' }

describe('the chat.queue table', () => {
  it('keeps each root’s latest push: its items and whether the round is held', () => {
    const fake = listening()
    const a = session()
    const b = session()
    expect(queueOf(a)).toEqual({ items: [], held: null, heldSeq: 0 })
    fake.push({ sessionId: a, items: [{ queuedId: 'q1', text: 'first' }] })
    fake.push({ sessionId: b, items: [{ queuedId: 'q9', text: 'other' }], held: HOST })
    fake.push({
      sessionId: a,
      items: [
        { queuedId: 'q1', text: 'first' },
        { queuedId: 'q2', text: 'second' },
      ],
    })
    expect(queueOf(a)).toEqual({
      items: [
        { queuedId: 'q1', text: 'first' },
        { queuedId: 'q2', text: 'second' },
      ],
      held: null,
      heldSeq: 0,
    })
    expect(queueOf(b)).toEqual({
      items: [{ queuedId: 'q9', text: 'other' }],
      held: HOST,
      heldSeq: 1,
    })
  })

  it('counts a new hold only: not the pushes an edit or a withdraw sends while it lasts', () => {
    // The model menu opens its confirmation on a new count (§模型菜单「从本机切到公网」). While the
    // round stays held for one host, 「修改」 and 「撤回」 re-send `held` with the queue: the menu must
    // not ask again for each. Held for another host, or held again after it was let go, asks again.
    const fake = listening()
    const a = session()
    const OTHER_HOST = { host: 'api.openai.com' }
    const counts: number[] = []
    const push = (items: QueuePush['items'], held?: QueuePush['held']): void => {
      fake.push({ sessionId: a, items, ...(held === undefined ? {} : { held }) })
      counts.push(queueOf(a).heldSeq)
    }
    push(
      [
        { queuedId: 'q1', text: 'go' },
        { queuedId: 'q2', text: 'and this' },
      ],
      HOST,
    )
    push(
      [
        { queuedId: 'q1', text: 'go, edited' },
        { queuedId: 'q2', text: 'and this' },
      ],
      HOST,
    )
    push([{ queuedId: 'q1', text: 'go, edited' }], HOST)
    push([{ queuedId: 'q1', text: 'go, edited' }], OTHER_HOST)
    push([{ queuedId: 'q1', text: 'go, edited' }])
    push([{ queuedId: 'q1', text: 'go, edited' }], HOST)
    expect(counts).toEqual([1, 1, 1, 2, 2, 3])
    expect(queueOf(a)).toMatchObject({ held: HOST, heldSeq: 3 })
    // The edit still reads its new words while held.
    expect(queuedTextOf(a, 'q1')).toBe('go, edited')
  })

  it('an empty push leaves an idle entry that keeps its count, so the next hold is still new', () => {
    const fake = listening()
    const a = session()
    fake.push({ sessionId: a, items: [{ queuedId: 'q1', text: 'go' }], held: HOST })
    fake.push({ sessionId: a, items: [] })
    expect(queueOf(a)).toEqual({ items: [], held: null, heldSeq: 1 })
    fake.push({ sessionId: a, items: [{ queuedId: 'q2', text: 'again' }], held: HOST })
    expect(queueOf(a)).toMatchObject({ held: HOST, heldSeq: 2 })
  })

  it('keeps an item’s text after it left the queue, for the user-message that inserts it', () => {
    // Main takes an item out of the queue as it goes in: the push that empties the queue can come
    // before the `user-message` that names its `queuedId` (§插话与输入框状态表「写入时点」).
    const fake = listening()
    const a = session()
    fake.push({ sessionId: a, items: [{ queuedId: 'q1', text: 'also this' }] })
    fake.push({ sessionId: a, items: [] })
    expect(queueOf(a).items).toEqual([])
    expect(queuedTextOf(a, 'q1')).toBe('also this')
    // Per root: another session's ids are not this one's.
    expect(queuedTextOf(session(), 'q1')).toBeUndefined()
    expect(queuedTextOf(a, 'q-never')).toBeUndefined()
  })

  it('an edited item reads its new words', () => {
    // 旧 220: 「修改」 changes the text inserted later.
    const fake = listening()
    const a = session()
    fake.push({ sessionId: a, items: [{ queuedId: 'q1', text: 'draft' }] })
    fake.push({ sessionId: a, items: [{ queuedId: 'q1', text: 'final words' }] })
    expect(queuedTextOf(a, 'q1')).toBe('final words')
    expect(queueOf(a).items).toEqual([{ queuedId: 'q1', text: 'final words' }])
  })

  it('keeps at most 200 texts a root, dropping the one listed longest ago', () => {
    const fake = listening()
    const a = session()
    for (let i = 0; i < 200; i += 1) {
      fake.push({ sessionId: a, items: [{ queuedId: `q${String(i)}`, text: `text ${String(i)}` }] })
    }
    expect(queuedTextOf(a, 'q0')).toBe('text 0')
    fake.push({ sessionId: a, items: [{ queuedId: 'q200', text: 'text 200' }] })
    expect(queuedTextOf(a, 'q0')).toBeUndefined()
    expect(queuedTextOf(a, 'q1')).toBe('text 1')
    expect(queuedTextOf(a, 'q200')).toBe('text 200')

    // An item listed again counts from its latest push: it outlives the ones listed before it.
    const b = session()
    for (let i = 0; i < 200; i += 1) {
      fake.push({ sessionId: b, items: [{ queuedId: `q${String(i)}`, text: `text ${String(i)}` }] })
    }
    fake.push({ sessionId: b, items: [{ queuedId: 'q0', text: 'text 0' }] })
    fake.push({ sessionId: b, items: [{ queuedId: 'q200', text: 'text 200' }] })
    expect(queuedTextOf(b, 'q0')).toBe('text 0')
    expect(queuedTextOf(b, 'q1')).toBeUndefined()
    expect(queuedTextOf(b, 'q2')).toBe('text 2')
  })

  it('tells subscribers which root changed, until they unsubscribe', () => {
    const fake = listening()
    const a = session()
    const heard: string[] = []
    const off = subscribeQueue((sessionId) => heard.push(sessionId))
    fake.push({ sessionId: a, items: [{ queuedId: 'q1', text: 'x' }] })
    fake.push({ sessionId: a, items: [] })
    off()
    fake.push({ sessionId: a, items: [{ queuedId: 'q2', text: 'y' }] })
    expect(heard).toEqual([a, a])
  })

  it('ignores a payload the event schema refuses', () => {
    const fake = listening()
    const a = session()
    const heard: string[] = []
    undo.push(subscribeQueue((sessionId) => heard.push(sessionId)))
    fake.pushRaw({ sessionId: a, items: [{ queuedId: '', text: 'no id' }] })
    fake.pushRaw({ sessionId: '', items: [] })
    fake.pushRaw({ sessionId: a })
    expect(queueOf(a)).toEqual({ items: [], held: null, heldSeq: 0 })
    expect(queuedTextOf(a, '')).toBeUndefined()
    expect(heard).toEqual([])
  })

  it('stops listening once undone', () => {
    const fake = fakeBridge()
    const off = listenForQueue(fake.bridge)
    const a = session()
    off()
    fake.push({ sessionId: a, items: [{ queuedId: 'q1', text: 'late' }], held: HOST })
    expect(queueOf(a)).toEqual({ items: [], held: null, heldSeq: 0 })
    expect(queuedTextOf(a, 'q1')).toBeUndefined()
  })
})
