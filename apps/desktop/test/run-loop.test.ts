/**
 * The host half of the loop (spec 02 §进行中、暂停与 RunRegistry, §主进程与 kernel 的循环接口; plan
 * step 9): the RunRegistry that is `LoopPorts.leases`, the in-memory queue behind `LoopPorts.queue`,
 * and run-events.ts's mapping from loop events to `chat.event`.
 */
import { chatEvent } from '@tenon-app/contracts'
import type { ChatEvent, IpcMainLike } from '@tenon-app/contracts'
import { createMemoryHost } from '@tenon-app/kernel'
import type { RunLease, SessionEvent, SessionService } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { createDesktopLoop, createRunRegistry, registerChatRoutes } from '../src/main/chat.js'
import { localDateOf } from '../src/main/locale.js'
import { createRunQueue } from '../src/main/queue.js'
import { createRunEvents } from '../src/main/run-events.js'

const ROOT = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'
const CHILD = '0b8f2a1c-3d4e-4f50-8a61-7b2c3d4e5f60'

function lease(result: RunLease | { refused: 'shutting-down' }): RunLease {
  if ('refused' in result) throw new Error('refused')
  return result
}

/** A stand-in for a WebContents: the two events that say the document is gone. */
function fakeOwner(): { owner: object; close(): void; listeners(): number } {
  const listeners = new Map<string, Set<() => void>>()
  const owner = {
    on(name: string, listener: () => void): void {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
    },
    off(name: string, listener: () => void): void {
      listeners.get(name)?.delete(listener)
    },
  }
  return {
    owner,
    close: () => {
      for (const listener of listeners.get('destroyed') ?? []) listener()
    },
    listeners: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  }
}

describe('RunRegistry', () => {
  it('holds one live lease per root, and refuses everything once shutting down', () => {
    const registry = createRunRegistry(createMemoryHost().clock)
    const first = lease(registry.begin({ rootSessionId: ROOT, origin: null }))
    // The kernel never asks twice; if it did, that is its bug and it must be loud.
    expect(() => registry.begin({ rootSessionId: ROOT, origin: null })).toThrow(/live lease/)
    first.finish()
    lease(registry.begin({ rootSessionId: ROOT, origin: null })).finish()
    registry.beginShutdown()
    expect(registry.begin({ rootSessionId: ROOT, origin: null })).toEqual({
      refused: 'shutting-down',
    })
  })

  it('keeps the first cause, and marks a user stop whenever it comes', () => {
    const registry = createRunRegistry(createMemoryHost().clock)
    const live = lease(registry.begin({ rootSessionId: ROOT, origin: null }))
    expect(registry.running()).toEqual([ROOT])
    expect(registry.abort({ rootSessionId: ROOT }, 'close-window')).toBe(true)
    expect(live.signal.reason).toBe('close-window')
    expect(live.stopRequested).toBe(false)
    // Aborted and still closing: not running, but still live (the snapshot has it).
    expect(registry.running()).toEqual([])
    expect(registry.snapshot()).toEqual([{ rootSessionId: ROOT, runId: null, aborted: true }])
    registry.abort('all', 'user-stop')
    expect(live.signal.reason).toBe('close-window')
    expect(live.stopRequested).toBe(true)
    live.finish()
    expect(registry.snapshot()).toEqual([])
  })

  it('aborts a lease when the document that began it goes away, and then lets it go', () => {
    const registry = createRunRegistry(createMemoryHost().clock)
    const window = fakeOwner()
    const other = fakeOwner()
    const mine = lease(registry.begin({ rootSessionId: ROOT, origin: window.owner }))
    const theirs = lease(registry.begin({ rootSessionId: CHILD, origin: other.owner }))
    expect(registry.running(window.owner)).toEqual([ROOT])
    window.close()
    expect(mine.signal.reason).toBe('close-window')
    expect(theirs.signal.aborted).toBe(false)
    mine.finish()
    // Nothing is left listening on a webContents that outlives the lease.
    expect(window.listeners()).toBe(0)
    theirs.finish()
  })

  it('records the first Run a lease opened, sub-agent sessions included', () => {
    const registry = createRunRegistry(createMemoryHost().clock)
    const live = lease(registry.begin({ rootSessionId: ROOT, origin: null }))
    registry.noteRunStarted(ROOT, 'run-1')
    registry.noteRunStarted(ROOT, 'child-run')
    expect(registry.snapshot()).toEqual([{ rootSessionId: ROOT, runId: 'run-1', aborted: false }])
    live.finish()
  })

  it('settles when every lease has finished, or when the time is up', async () => {
    const host = createMemoryHost()
    const registry = createRunRegistry(host.clock)
    await expect(registry.settled(10)).resolves.toBeUndefined()
    const live = lease(registry.begin({ rootSessionId: ROOT, origin: null }))
    const finished = registry.settled(10_000)
    live.finish()
    await expect(finished).resolves.toBeUndefined()
    lease(registry.begin({ rootSessionId: ROOT, origin: null }))
    const timedOut = registry.settled(500)
    host.advance(500)
    await expect(timedOut).resolves.toBeUndefined()
  })
})

describe('the queue', () => {
  it('takes by seq, by id and by urgency, and restores in the original order', async () => {
    const queue = createRunQueue()
    const a = await queue.enqueue(ROOT, 'a', { urgent: false })
    const b = await queue.enqueue(ROOT, 'b', { urgent: true })
    const c = await queue.enqueue(ROOT, 'c', { urgent: false })
    expect((await queue.peek(ROOT)).map((item) => item.text)).toEqual(['a', 'b', 'c'])
    const urgent = await queue.take(ROOT, { upToSeq: null, urgentOnly: true })
    expect(urgent.map((item) => item.text)).toEqual(['b'])
    const upToA = await queue.take(ROOT, { upToSeq: a.seq, urgentOnly: false })
    expect(upToA.map((item) => item.text)).toEqual(['a'])
    // Put back, with the urgent flag the kernel hands in, at the original seq.
    await queue.restore(ROOT, [...upToA, { ...urgent[0]!, urgent: false }])
    expect((await queue.peek(ROOT)).map((item) => [item.text, item.urgent])).toEqual([
      ['a', false],
      ['b', false],
      ['c', false],
    ])
    const one = await queue.take(ROOT, { upToSeq: null, urgentOnly: false, queuedId: c.queuedId })
    expect(one.map((item) => item.queuedId)).toEqual([c.queuedId])
    expect(b.queuedId).not.toBe(c.queuedId)
    expect(await queue.peek(CHILD)).toEqual([])
  })
})

/** What run-events.ts sends for these loop events, and what it hands the registry. */
function mapped(events: readonly SessionEvent[]): { chat: ChatEvent[]; started: string[] } {
  const chat: ChatEvent[] = []
  const started: string[] = []
  const handle = createRunEvents({
    send: (channel, payload) => {
      if (channel !== chatEvent.channel) throw new Error(`sent on ${channel}`)
      chat.push(payload as ChatEvent)
    },
    onRunStarted: (root, runId) => started.push(`${root}:${runId}`),
    log: () => {},
  })
  for (const event of events) handle(event)
  return { chat, started }
}

describe('run-events', () => {
  const root = { rootSessionId: ROOT, sessionId: ROOT }
  const child = { rootSessionId: ROOT, sessionId: CHILD }

  it('forwards the root session only, and every run-started to the registry', () => {
    const { chat, started } = mapped([
      { ...root, type: 'run-started', runId: 'r1' },
      { ...child, type: 'run-started', runId: 'c1' },
      { ...root, type: 'text-delta', runId: 'r1', delta: 'hi' },
      { ...child, type: 'text-delta', runId: 'c1', delta: 'not yours' },
      { ...root, type: 'thinking-delta', runId: 'r1', delta: 'hmm' },
      { ...root, type: 'attempt-discarded', runId: 'r1' },
    ])
    expect(started).toEqual([`${ROOT}:r1`, `${ROOT}:c1`])
    expect(chat).toEqual([
      { type: 'text-delta', sessionId: ROOT, delta: 'hi' },
      { type: 'thinking-delta', sessionId: ROOT, delta: 'hmm' },
      { type: 'attempt-discarded', sessionId: ROOT },
    ])
  })

  it('ends a Run as done or error by 01’s tables', () => {
    const ended = (over: Partial<Extract<SessionEvent, { type: 'run-ended' }>>): SessionEvent => ({
      ...root,
      type: 'run-ended',
      runId: 'r1',
      reason: { code: 'completed' },
      recorded: true,
      lastStop: 'end-turn',
      errorCode: null,
      ...over,
    })
    const { chat } = mapped([
      ended({ lastStop: 'tool-use' }),
      ended({ lastStop: 'max-tokens', reason: { code: 'output-truncated', maxTokens: 1 } }),
      ended({ runId: null, lastStop: null, reason: { code: 'user-stopped' }, recorded: false }),
      ended({
        runId: null,
        lastStop: null,
        reason: { code: 'shutdown-aborted', trigger: 'close-window' },
        recorded: false,
      }),
      ended({
        runId: null,
        lastStop: null,
        errorCode: 'auth',
        recorded: false,
        reason: {
          code: 'provider-error',
          providerId: 'anthropic',
          errorCode: 'auth',
          providerReason: null,
          attempts: 0,
        },
      }),
      ended({ lastStop: null, errorCode: 'quota-exhausted' }),
      ended({ ...child }),
    ])
    expect(
      chat.map((event) =>
        event.type === 'done' ? event.stopReason : event.type === 'error' ? event.code : event.type,
      ),
    ).toEqual(['end-turn', 'error', 'aborted', 'aborted', 'auth', 'unknown'])
  })
})

describe('chat.send before plan step 17', () => {
  it('withdraws a message the kernel queued and refuses it as already streaming', async () => {
    const host = createMemoryHost()
    const sent: unknown[] = []
    const loop = createDesktopLoop({
      clock: host.clock,
      send: (_channel, payload) => sent.push(payload),
      locale: () => 'en',
    })
    // The kernel queued it: something else held the root when its turn came.
    const sessions = {
      send: async () => ({
        status: 'queued',
        queuedId: (await loop.queue.enqueue(ROOT, 'hi', { urgent: false })).queuedId,
      }),
    } as unknown as SessionService
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
    const ipcMain: IpcMainLike = {
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
    }
    registerChatRoutes({ send: () => {}, ipcMain, sessions, loop, log: () => {} })
    const answer = await handlers.get('chat.send')?.({}, { sessionId: ROOT, text: 'hi' })
    expect(answer).toMatchObject({ ok: false, error: { code: 'handler-failed' } })
    expect(await loop.queue.peek(ROOT)).toEqual([])
    expect(sent).toEqual([])
  })

  it('computes the local date in this machine’s time zone', () => {
    const now = new Date(2026, 8, 26, 23, 59).getTime()
    expect(localDateOf(now)).toBe('2026-09-26')
  })
})
