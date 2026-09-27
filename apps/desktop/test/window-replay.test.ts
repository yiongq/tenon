/**
 * What a loading document is re-sent (spec 02 §进行中、暂停与 RunRegistry「何时推」「runId 的来历」; plan
 * step 20): on each `did-finish-load` — a new window's first document, and the new document of a
 * reloaded one — `run.state` for every root with a live lease (an aborted one still closing too,
 * from the RunRegistry's snapshot) and `chat.queue` for every queue that is not empty, as the state
 * is at that load. `DesktopQueue.views()` is what the queue half reads.
 */
import { chatQueueEvent, runStateEvent } from '@tenon-app/contracts'
import { absolutePath, createMemoryHost } from '@tenon-app/kernel'
import type { CommandShell, RunLease } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { createDesktopLoop } from '../src/main/chat.js'
import type { DesktopLoop } from '../src/main/chat.js'
import { createRunQueue } from '../src/main/queue.js'
import { replayOnLoad } from '../src/main/window-replay.js'

/** These cases run no Bash: the shell is a stand-in. */
const NO_SHELL: CommandShell = { path: absolutePath('/bin/sh'), env: () => Promise.resolve({}) }

const A = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'
const B = '0b8f2a1c-3d4e-4f50-8a61-7b2c3d4e5f60'
const C = '9d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6'

/** A WebContents as the replay sees it: its load event, and what was sent to its document. */
function fakeContents(): {
  contents: Parameters<typeof replayOnLoad>[0]
  load(): Array<[string, unknown]>
  received(): ReadonlyArray<[string, unknown]>
} {
  const listeners: Array<() => void> = []
  let sent: Array<[string, unknown]> = []
  return {
    contents: {
      on(_event, listener) {
        listeners.push(listener)
      },
      send(channel, payload) {
        sent.push([channel, payload])
      },
    },
    load() {
      sent = []
      for (const listener of listeners) listener()
      return sent
    },
    received: () => sent,
  }
}

function desktopLoop(): { loop: DesktopLoop } {
  const loop = createDesktopLoop({
    clock: createMemoryHost().clock,
    send: () => {},
    locale: () => 'en',
    commandShell: NO_SHELL,
    log: () => {},
  })
  return { loop }
}

function lease(loop: DesktopLoop, root: string): RunLease {
  const begun = loop.ports.leases.begin({ rootSessionId: root, origin: null })
  if ('refused' in begun) throw new Error('refused')
  return begun
}

/** The replay by channel, each payload through the contract that carries it. */
function byChannel(sent: ReadonlyArray<[string, unknown]>): {
  states: unknown[]
  queues: unknown[]
} {
  const states: unknown[] = []
  const queues: unknown[] = []
  for (const [channel, payload] of sent) {
    if (channel === runStateEvent.channel) states.push(runStateEvent.payload.parse(payload))
    else if (channel === chatQueueEvent.channel) queues.push(chatQueueEvent.payload.parse(payload))
    else throw new Error(`replayed on ${channel}`)
  }
  return { states, queues }
}

describe('the replay on each load', () => {
  it('re-sends a reloaded document the state as it is at that load', async () => {
    const { loop } = desktopLoop()
    const win = fakeContents()
    replayOnLoad(win.contents, loop)
    // The first document: nothing live, nothing queued, nothing to re-send.
    expect(win.load()).toEqual([])

    const a = lease(loop, A)
    loop.registry.noteRunStarted(A, 'run-a')
    const b = lease(loop, B)
    const { queuedId } = await loop.queue.enqueue(B, 'next', { urgent: false })
    // The reload's document: A's Run, B's lease still before its Run, B's queue.
    let replay = byChannel(win.load())
    expect(replay.states).toEqual([
      { sessionId: A, running: true, runId: 'run-a' },
      { sessionId: B, running: true, runId: null },
    ])
    expect(replay.queues).toEqual([{ sessionId: B, items: [{ queuedId, text: 'next' }] }])

    // Aborted and still closing: re-sent too, not running, with its Run.
    a.abort('user-stop')
    replay = byChannel(win.load())
    expect(replay.states).toEqual([
      { sessionId: A, running: false, runId: 'run-a' },
      { sessionId: B, running: true, runId: null },
    ])

    // Finished leases and an emptied queue are not re-sent.
    a.finish()
    b.finish()
    await loop.queue.take(B, { upToSeq: null, urgentOnly: false })
    expect(win.load()).toEqual([])
  })

  it('re-sends a held root with its host', () => {
    const { loop } = desktopLoop()
    const win = fakeContents()
    replayOnLoad(win.contents, loop)
    loop.queue.setHeld(C, 'api.anthropic.com')
    expect(byChannel(win.load()).queues).toEqual([
      { sessionId: C, items: [], held: { host: 'api.anthropic.com' } },
    ])
  })

  it('sends each window’s replay to that window only, and nothing without a store', () => {
    const { loop } = desktopLoop()
    const first = fakeContents()
    const second = fakeContents()
    replayOnLoad(first.contents, loop)
    replayOnLoad(second.contents, loop)
    lease(loop, A)
    expect(byChannel(second.load()).states).toEqual([{ sessionId: A, running: true, runId: null }])
    // Only the document that loaded is re-sent anything.
    expect(first.received()).toEqual([])
    const bare = fakeContents()
    replayOnLoad(bare.contents, null)
    expect(bare.load()).toEqual([])
  })
})

describe('DesktopQueue.views()', () => {
  it('lists only roots whose queue is not empty, and held roots, once each', async () => {
    const queue = createRunQueue()
    expect(queue.views()).toEqual([])
    const first = await queue.enqueue(A, 'one', { urgent: false })
    expect(queue.views()).toEqual([[A, { items: [{ queuedId: first.queuedId, text: 'one' }] }]])

    // Held with nothing queued is still listed; held and queued is one row.
    queue.setHeld(B, 'api.example.com')
    const second = await queue.enqueue(B, 'two', { urgent: false })
    expect(queue.views()).toEqual([
      [A, { items: [{ queuedId: first.queuedId, text: 'one' }] }],
      [
        B,
        {
          items: [{ queuedId: second.queuedId, text: 'two' }],
          held: { host: 'api.example.com' },
        },
      ],
    ])

    // Taken, withdrawn, released: gone from the list.
    await queue.take(A, { upToSeq: null, urgentOnly: false })
    queue.setHeld(B, null)
    expect(queue.views()).toEqual([[B, { items: [{ queuedId: second.queuedId, text: 'two' }] }]])
    expect(queue.withdraw(B, second.queuedId)).toBe(true)
    expect(queue.views()).toEqual([])
  })

  it('drops the hold with the last queued item', async () => {
    const queue = createRunQueue()
    const { queuedId } = await queue.enqueue(A, 'only', { urgent: false })
    queue.setHeld(A, 'api.example.com')
    queue.withdraw(A, queuedId)
    expect(queue.views()).toEqual([])
  })
})
