/**
 * The renderer's `run.state` table (spec 02 §进行中、暂停与 RunRegistry; open question 16): whether
 * each root session has a Run in progress, as main pushes it — what the leave dialog, the stop
 * button and send-now read instead of assistant-ui's own `running`. `useRunState` needs a DOM and
 * is not exercised here.
 */
import { isEventChannel, runStateEvent } from '@tenon-app/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { TenonBridge } from '../src/preload/index.js'
import {
  listenForRunState,
  runStateOf,
  subscribeRunState,
} from '../src/renderer/src/runtime/run-state.js'

const SESSION = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b'
const OTHER = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0'
const NEVER_PUSHED = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

/** Only `on`, which is all the table takes; `push` delivers a payload as main sent it, unchecked. */
function fakeBridge(): { bridge: Pick<TenonBridge, 'on'>; push(payload: unknown): void } {
  const listeners = new Set<(payload: unknown) => void>()
  return {
    bridge: {
      on: (channel, listener) => {
        if (!isEventChannel(channel)) throw new Error(`not an event: ${channel}`)
        if (channel !== runStateEvent.channel) return () => undefined
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    push(payload) {
      for (const listener of listeners) listener(payload)
    },
  }
}

const undo: Array<() => void> = []

function listening(): ReturnType<typeof fakeBridge> {
  const fake = fakeBridge()
  undo.push(listenForRunState(fake.bridge))
  return fake
}

afterEach(() => {
  // The table is the module's own: leave no Run behind for the next test.
  const fake = listening()
  for (const sessionId of [SESSION, OTHER]) fake.push({ sessionId, running: false, runId: null })
  for (const off of undo.splice(0)) off()
})

describe('the run.state table', () => {
  it('keeps what main pushes, per root session', () => {
    const fake = listening()
    expect(runStateOf(SESSION)).toEqual({ running: false, runId: null })

    // A lease that has not opened its Run yet counts as running (§进行中、暂停与 RunRegistry).
    fake.push({ sessionId: SESSION, running: true, runId: null })
    expect(runStateOf(SESSION)).toEqual({ running: true, runId: null })
    fake.push({ sessionId: SESSION, running: true, runId: 'run-1' })
    expect(runStateOf(SESSION)).toEqual({ running: true, runId: 'run-1' })
    expect(runStateOf(OTHER)).toEqual({ running: false, runId: null })

    // An aborted Run still closing is not running, but its id is still the one to name.
    fake.push({ sessionId: SESSION, running: false, runId: 'run-1' })
    expect(runStateOf(SESSION)).toEqual({ running: false, runId: 'run-1' })
  })

  it('holds nothing for a session once it is idle', () => {
    const fake = listening()
    fake.push({ sessionId: SESSION, running: true, runId: 'run-1' })
    fake.push({ sessionId: SESSION, running: false, runId: null })
    expect(runStateOf(SESSION)).toEqual({ running: false, runId: null })
    // The very value a session never pushed gets: the entry was dropped, not kept as idle.
    expect(runStateOf(SESSION)).toBe(runStateOf(NEVER_PUSHED))
  })

  it('ignores a payload the contract refuses, and tells no one', () => {
    const fake = listening()
    fake.push({ sessionId: SESSION, running: true, runId: 'run-1' })
    let told = 0
    const unsubscribe = subscribeRunState(() => {
      told += 1
    })
    for (const payload of [
      { sessionId: 'not-a-uuid', running: true, runId: 'run-2' },
      { sessionId: SESSION.toUpperCase(), running: true, runId: 'run-2' },
      { sessionId: SESSION, running: 'yes', runId: 'run-2' },
      { sessionId: SESSION, running: false, runId: '' },
      { sessionId: SESSION, running: false },
      { sessionId: SESSION },
      null,
      'run.state',
    ]) {
      fake.push(payload)
    }
    expect(told).toBe(0)
    expect(runStateOf(SESSION)).toEqual({ running: true, runId: 'run-1' })
    unsubscribe()
  })

  it('tells each subscriber of every change until it unsubscribes', () => {
    const fake = listening()
    const seen: Array<{ running: boolean; runId: string | null }> = []
    const unsubscribe = subscribeRunState(() => seen.push(runStateOf(SESSION)))
    fake.push({ sessionId: SESSION, running: true, runId: 'run-1' })
    fake.push({ sessionId: SESSION, running: false, runId: null })
    unsubscribe()
    fake.push({ sessionId: SESSION, running: true, runId: 'run-2' })
    expect(seen).toEqual([
      { running: true, runId: 'run-1' },
      { running: false, runId: null },
    ])
  })

  it('stops reading pushes once its undo is called', () => {
    const fake = fakeBridge()
    const off = listenForRunState(fake.bridge)
    fake.push({ sessionId: SESSION, running: true, runId: 'run-1' })
    off()
    fake.push({ sessionId: SESSION, running: true, runId: 'run-2' })
    expect(runStateOf(SESSION)).toEqual({ running: true, runId: 'run-1' })
  })
})
