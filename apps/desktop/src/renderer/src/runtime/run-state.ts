import { runStateEvent } from '@tenon-app/contracts'
import type { RunState } from '@tenon-app/contracts'
import { useSyncExternalStore } from 'react'
import type { TenonBridge } from '../../../preload/index'

/**
 * Whether each root session has a Run in progress, as the main process says (spec 02 §进行中、暂停与
 * RunRegistry): the leave dialog and the stop button read it, never assistant-ui's own `running`
 * (a resume and 「继续」 do not pass through the thread's runtime). main.tsx calls
 * `listenForRunState` first, before anything awaits, so no push is missed.
 */
type Entry = Omit<RunState, 'sessionId'>

const IDLE: Entry = { running: false, runId: null }
const table = new Map<string, Entry>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Starts the table; returns the undo (a test's, the window never stops listening). */
export function listenForRunState(bridge: Pick<TenonBridge, 'on'>): () => void {
  return bridge.on(runStateEvent.channel, (payload) => {
    const parsed = runStateEvent.payload.safeParse(payload)
    if (!parsed.success) return
    const { sessionId, ...state } = parsed.data
    if (!state.running && state.runId === null) table.delete(sessionId)
    else table.set(sessionId, state)
    notify()
  })
}

export function runStateOf(sessionId: string): Entry {
  return table.get(sessionId) ?? IDLE
}

export function subscribeRunState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRunState(sessionId: string): Entry {
  return useSyncExternalStore(subscribeRunState, () => runStateOf(sessionId))
}
