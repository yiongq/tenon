/**
 * A message's age (「刚刚」, 「5 分钟前」) changes on its own while the window is open: every label
 * reads one shared coarse clock (runtime/clock.ts), which wakes its subscribers each tick and runs no
 * timer while nothing is subscribed. relative-time.test.ts covers the wording; this covers the
 * ticking, without which every label would stay at what it said when it first drew.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TICK_MS, coarseNow, subscribeCoarseNow } from '../src/renderer/src/runtime/clock.js'

describe('the coarse clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T08:00:05Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('wakes every label each tick, with one timer for all of them', () => {
    const first = vi.fn<() => void>()
    const second = vi.fn<() => void>()
    const offFirst = subscribeCoarseNow(first)
    const offSecond = subscribeCoarseNow(second)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(TICK_MS)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(TICK_MS)
    expect(first).toHaveBeenCalledTimes(2)
    offFirst()
    offSecond()
  })

  it('stops its timer when the last label goes, and starts it again for the next', () => {
    const offFirst = subscribeCoarseNow(() => {})
    const offSecond = subscribeCoarseNow(() => {})
    offFirst()
    expect(vi.getTimerCount()).toBe(1)
    offSecond()
    expect(vi.getTimerCount()).toBe(0)
    const listener = vi.fn<() => void>()
    const off = subscribeCoarseNow(listener)
    vi.advanceTimersByTime(TICK_MS)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads the same value all through a tick and moves on at the next', () => {
    const start = coarseNow()
    expect(start % TICK_MS).toBe(0)
    expect(start).toBeLessThanOrEqual(Date.now())
    vi.advanceTimersByTime(TICK_MS - 5_001)
    expect(coarseNow()).toBe(start)
    vi.advanceTimersByTime(1)
    expect(coarseNow()).toBe(start + TICK_MS)
  })
})
