import { useSyncExternalStore } from 'react'

/**
 * A coarse shared clock for labels that age ("5 minutes ago"): one timer for every label on screen,
 * running only while some label is mounted. The value is the time rounded down to the tick, so it is
 * the same on every read between two ticks (what `useSyncExternalStore` requires) and a label that
 * mounts mid-tick is still right to within the tick.
 */
export const TICK_MS = 30_000
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

/** Exported with `coarseNow` for test/renderer-clock.test.ts: the hook is these two and nothing else. */
export function subscribeCoarseNow(listener: () => void): () => void {
  listeners.add(listener)
  timer ??= setInterval(() => {
    for (const each of listeners) each()
  }, TICK_MS)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

export const coarseNow = (): number => Math.floor(Date.now() / TICK_MS) * TICK_MS

export function useCoarseNow(): number {
  return useSyncExternalStore(subscribeCoarseNow, coarseNow)
}
