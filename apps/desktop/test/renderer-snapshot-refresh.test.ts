import { afterEach, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@tenon-app/contracts'
import { SnapshotRefresh } from '../src/renderer/src/runtime/snapshot-refresh.js'
import type { Rounds } from '../src/renderer/src/lib/snapshots.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const roundRunId = '22222222-2222-4222-8222-222222222222'
const result = (canRestore: boolean): Rounds => ({
  ok: true,
  status: 'tree',
  incompleteRestores: [],
  rounds: [
    {
      roundRunId,
      runIds: [roundRunId],
      endMessageId: 'end',
      calls: [],
      canRestore,
      incompleteCoverage: false,
      commandsWithoutSnapshot: false,
    },
  ],
})
const outcome = (n: number): ChatEvent => ({
  type: 'tool-outcome',
  sessionId: SESSION,
  callKey: `${roundRunId}:0:${n}`,
  providerToolCallId: `call-${n}`,
  state: 'completed',
  effect: 'write',
  isError: false,
  source: null,
  output: 'done',
})
afterEach(() => vi.useRealTimers())

it('05 验收 33: a burst of tool outcomes coalesces; only one request flies, one follow-up publishes the final result', async () => {
  vi.useFakeTimers()
  const first = Promise.withResolvers<unknown>()
  const last = Promise.withResolvers<unknown>()
  const invoke = vi
    .fn<(channel: string, request: unknown) => Promise<unknown>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(last.promise)
  const publish = vi.fn<(data: Rounds | null) => void>()
  const refresh = new SnapshotRefresh({ invoke }, SESSION, publish)
  for (let i = 0; i < 30; i++) refresh.event(outcome(i))
  await vi.advanceTimersByTimeAsync(499)
  expect(invoke).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(invoke).toHaveBeenCalledTimes(1)
  for (let i = 30; i < 60; i++) refresh.event(outcome(i))
  await vi.advanceTimersByTimeAsync(500)
  const focused = refresh.refresh()
  const periodic = refresh.refresh()
  refresh.event({ type: 'error', sessionId: SESSION, code: 'network' })
  expect(invoke).toHaveBeenCalledTimes(1)
  first.resolve({ ok: true, data: result(true) })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledTimes(2)
  last.resolve({ ok: true, data: result(false) })
  expect(await focused).toEqual(result(false))
  expect(await periodic).toEqual(result(false))
  expect(publish).toHaveBeenLastCalledWith(result(false))
  await vi.advanceTimersByTimeAsync(500)
  expect(invoke).toHaveBeenCalledTimes(2)
  refresh.dispose()
})

it('05 验收 33: refresh cancels a pending tool debounce; disposal drops timers and late results', async () => {
  vi.useFakeTimers()
  const gate = Promise.withResolvers<unknown>()
  const invoke = vi
    .fn<(channel: string, request: unknown) => Promise<unknown>>()
    .mockReturnValue(gate.promise)
  const publish = vi.fn<(data: Rounds | null) => void>()
  const refresh = new SnapshotRefresh({ invoke }, SESSION, publish)
  refresh.event(outcome(0))
  refresh.event({ type: 'done', sessionId: SESSION, stopReason: 'end-turn' })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  const work = refresh.refresh()
  await vi.advanceTimersByTimeAsync(500)
  expect(invoke).toHaveBeenCalledTimes(1)
  refresh.event(outcome(1))
  refresh.dispose()
  gate.resolve({ ok: true, data: result(true) })
  await work
  await vi.advanceTimersByTimeAsync(500)
  expect(publish).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledTimes(1)
})

it('05 验收 33: refresh ignores invalid, other-session and unrelated events, and never starts after disposal', async () => {
  vi.useFakeTimers()
  const invoke = vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: result(true) }))
  const publish = vi.fn<(data: Rounds | null) => void>()
  const refresh = new SnapshotRefresh({ invoke }, SESSION, publish)
  for (const event of [
    null,
    {},
    { ...outcome(0), sessionId: roundRunId },
    { type: 'text-delta', sessionId: SESSION, delta: 'hi' },
  ])
    refresh.event(event)
  await vi.advanceTimersByTimeAsync(1000)
  expect(invoke).not.toHaveBeenCalled()
  refresh.event(outcome(1))
  refresh.dispose()
  refresh.event(outcome(2))
  refresh.event({ type: 'error', sessionId: SESSION, code: 'network' })
  expect(await refresh.refresh()).toBeNull()
  await vi.advanceTimersByTimeAsync(1000)
  expect(invoke).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
})

it('05 验收 33: disposal before the scheduled drain cancels it; failures publish null and permit a fresh request', async () => {
  const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
  const publish = vi.fn<(data: Rounds | null) => void>()
  const stopped = new SnapshotRefresh({ invoke }, SESSION, publish)
  const pending = stopped.refresh()
  stopped.dispose()
  await pending
  expect(invoke).not.toHaveBeenCalled()
  const refresh = new SnapshotRefresh({ invoke }, SESSION, publish)
  invoke.mockRejectedValueOnce(new Error('offline'))
  expect(await refresh.refresh()).toBeNull()
  expect(publish).toHaveBeenLastCalledWith(null)
  invoke.mockResolvedValueOnce({ ok: true, data: { ok: false, code: 'gone' } })
  expect(await refresh.refresh()).toBeNull()
  invoke.mockResolvedValueOnce({ ok: true, data: result(true) })
  expect(await refresh.refresh()).toEqual(result(true))
  expect(publish).toHaveBeenLastCalledWith(result(true))
  refresh.dispose()
})
