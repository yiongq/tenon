/**
 * The host half of the loop (spec 02 §进行中、暂停与 RunRegistry, §主进程与 kernel 的循环接口; plan
 * step 9): the RunRegistry that is `LoopPorts.leases`, the in-memory queue behind `LoopPorts.queue`,
 * and run-events.ts's mapping from loop events to `chat.event`.
 */
import { chatEvent, chatEventSchema } from '@tenon-app/contracts'
import type { ChatEvent, IpcMainLike } from '@tenon-app/contracts'
import { absolutePath, createMemoryHost } from '@tenon-app/kernel'
import type { CommandShell, RunLease, SessionEvent, SessionService } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { createDesktopLoop, createRunRegistry, registerChatRoutes } from '../src/main/chat.js'
import { localDateOf } from '../src/main/locale.js'
import { createRunQueue } from '../src/main/queue.js'
import { createRunEvents } from '../src/main/run-events.js'

/** These cases run no Bash: the shell is a stand-in. */
const NO_SHELL: CommandShell = { path: absolutePath('/bin/sh'), env: () => Promise.resolve({}) }

const ROOT = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'
const CHILD = '0b8f2a1c-3d4e-4f50-8a61-7b2c3d4e5f60'

function lease(result: RunLease | { refused: 'shutting-down' }): RunLease {
  if ('refused' in result) throw new Error('refused')
  return result
}

/** A stand-in for a WebContents: the events that say the document is gone. */
function fakeOwner(): {
  owner: object
  close(): void
  emit(name: string, ...args: unknown[]): void
  listeners(): number
} {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const owner = {
    on(name: string, listener: (...args: unknown[]) => void): void {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
    },
    off(name: string, listener: (...args: unknown[]) => void): void {
      listeners.get(name)?.delete(listener)
    },
  }
  const emit = (name: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }
  return {
    owner,
    close: () => emit('destroyed'),
    emit,
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

  it('aborts the Runs of a document the main frame replaced, and none for a navigation main cancelled', () => {
    // §停止与退出「watchOwner」: 主框架换了文档（重载）时调 abort({ origin }, 'close-window'), 只中止这个
    // 文档登记的进行中 Run. Electron's order (44.4.1): a reload fires `did-start-navigation`, then
    // `did-navigate`; a navigation `hardenWebContents` cancels fires only the first.
    const registry = createRunRegistry(createMemoryHost().clock)
    const window = fakeOwner()
    const other = fakeOwner()
    const mine = lease(registry.begin({ rootSessionId: ROOT, origin: window.owner }))
    const theirs = lease(registry.begin({ rootSessionId: CHILD, origin: other.owner }))
    window.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(mine.signal.aborted).toBe(false)
    window.emit('did-navigate', {}, 'file:///app/index.html', 200, 'OK')
    expect(mine.signal.reason).toBe('close-window')
    // No stop was asked for: nothing a paused session holds is closed on its account.
    expect(mine.stopRequested).toBe(false)
    expect(theirs.signal.aborted).toBe(false)
    expect(registry.running()).toEqual([CHILD])
    mine.finish()
    expect(window.listeners()).toBe(0)
    theirs.finish()
  })

  it('aborts at once a lease begun for a document that is already gone', () => {
    // plan step 9: 「窗口销毁…时以 close-window 中止」 — a command that waited in the mailbox begins
    // its lease with the origin it came with, after that window closed; no `destroyed` comes then.
    const registry = createRunRegistry(createMemoryHost().clock)
    const window = fakeOwner()
    window.close()
    const late = lease(
      registry.begin({ rootSessionId: ROOT, origin: { ...window.owner, isDestroyed: () => true } }),
    )
    expect(late.signal.reason).toBe('close-window')
    expect(late.stopRequested).toBe(false)
    expect(registry.running()).toEqual([])
    late.finish()
    // A live document is left alone.
    const open = fakeOwner()
    const mine = lease(
      registry.begin({ rootSessionId: ROOT, origin: { ...open.owner, isDestroyed: () => false } }),
    )
    expect(mine.signal.aborted).toBe(false)
    mine.finish()
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

  it('edits a message in place: it keeps its seq, so a batch boundary still takes it in turn', async () => {
    // `chat.queue.act` edit (01 修补 6「排队、立即发送与继续」): the words change, the place does not —
    // an insert up to a later message's seq still carries the edited one, ahead of it.
    const queue = createRunQueue()
    const a = await queue.enqueue(ROOT, 'a', { urgent: false })
    const b = await queue.enqueue(ROOT, 'b', { urgent: false })
    expect(queue.edit(ROOT, a.queuedId, 'a, edited')).toBe(true)
    const [edited] = await queue.peek(ROOT)
    expect(edited).toMatchObject({ queuedId: a.queuedId, seq: a.seq, text: 'a, edited' })
    const taken = await queue.take(ROOT, { upToSeq: b.seq, urgentOnly: false })
    expect(taken.map((item) => item.text)).toEqual(['a, edited', 'b'])
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
    onHeld: () => {},
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

  const ended = (over: Partial<Extract<SessionEvent, { type: 'run-ended' }>>): SessionEvent => ({
    ...root,
    type: 'run-ended',
    runId: 'r1',
    reason: { code: 'completed' },
    recorded: true,
    lastStop: 'end-turn',
    errorCode: null,
    retryOf: null,
    ...over,
  })

  it('ends a Run as done or error by 01’s tables', () => {
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
    // Each carries the Run's end reason, done and error alike (plan step 13).
    expect(chat.map((event) => ('endReason' in event ? event.endReason?.code : null))).toEqual([
      'completed',
      'output-truncated',
      'user-stopped',
      'shutdown-aborted',
      'provider-error',
      'completed',
    ])
    // And the Run itself, done and error alike: the failure card copies it (§失败卡与结束原因), and
    // a provider error is the card that offers 「复制诊断信息」 most (plan step 20).
    expect(chat.map((event) => ('runId' in event ? event.runId : 'absent'))).toEqual([
      'r1',
      'r1',
      null,
      null,
      null,
      'r1',
    ])
  })

  it('passes the Run’s retryOf on done and error alike, null included (plan step 20)', () => {
    // §chat.event: `retryOf` is `run-ended.retryOf` — 「重试」 is offered only when it is not null and
    // resends the message it names; the renderer never infers it.
    const providerError = {
      code: 'provider-error',
      providerId: 'anthropic',
      errorCode: 'server',
      providerReason: null,
      attempts: 1,
    } as const
    const { chat } = mapped([
      ended({ retryOf: 'm1' }),
      ended({ lastStop: null, errorCode: 'server', reason: providerError, retryOf: 'm2' }),
      ended({ lastStop: null, errorCode: 'server', reason: providerError }),
      ended({ runId: null, lastStop: null, reason: { code: 'user-stopped' }, recorded: false }),
      ended({ ...child, retryOf: 'm-child' }),
    ])
    expect(
      chat.map((event) => [event.type, 'retryOf' in event ? event.retryOf : 'absent']),
    ).toEqual([
      ['done', 'm1'],
      ['error', 'm2'],
      ['error', null],
      ['done', null],
    ])
    for (const event of chat) expect(chatEventSchema.parse(event)).toEqual(event)
  })

  it('forwards a root’s committed user message, and hands queue-held to the queue (plan step 17)', () => {
    const held: Array<[string, string | null]> = []
    const chat: ChatEvent[] = []
    const handle = createRunEvents({
      send: (_channel, payload) => chat.push(payload as ChatEvent),
      onRunStarted: () => {},
      onHeld: (rootSessionId, host) => held.push([rootSessionId, host]),
      log: () => {},
    })
    handle({ ...root, type: 'user-message', runId: 'r1', messageId: 'm1', queuedId: 'q1' })
    handle({ ...child, type: 'user-message', runId: 'c1', messageId: 'm2', queuedId: null })
    handle({ ...root, type: 'queue-held', host: 'api.example.com' })
    handle({ ...child, type: 'queue-held', host: null })
    expect(chat).toEqual([
      { type: 'user-message', sessionId: ROOT, messageId: 'm1', queuedId: 'q1' },
    ])
    expect(chatEventSchema.parse(chat[0])).toEqual(chat[0])
    expect(held).toEqual([
      [ROOT, 'api.example.com'],
      [ROOT, null],
    ])
  })

  it('forwards a closed call as tool-outcome, by callKey, and it parses (plan step 14)', () => {
    const outcome = {
      effect: 'blocked' as const,
      state: 'not-run' as const,
      source: 'protected' as const,
      facts: { toolName: 'Read', target: '/etc/passwd' },
      output: 'blocked',
    }
    const { chat } = mapped([
      { ...root, type: 'tool-outcome', callKey: 'r1:1:0', providerToolCallId: 'toolu_1', outcome },
      { ...child, type: 'tool-outcome', callKey: 'c1:1:0', providerToolCallId: 'toolu_2', outcome },
    ])
    expect(chat).toEqual([
      {
        type: 'tool-outcome',
        sessionId: ROOT,
        callKey: 'r1:1:0',
        providerToolCallId: 'toolu_1',
        ...outcome,
      },
    ])
    expect(chatEventSchema.parse(chat[0])).toEqual(chat[0])
  })
})

describe('chat.send and the queue (plan step 17)', () => {
  it('leaves a message the kernel queued in the queue, accepted, and pushes the queue', async () => {
    const host = createMemoryHost()
    const sent: unknown[] = []
    const loop = createDesktopLoop({
      clock: host.clock,
      send: (_channel, payload) => sent.push(payload),
      locale: () => 'en',
      commandShell: NO_SHELL,
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
    // The kernel's own status goes back: the renderer keeps waiting for the queue push (plan step 20).
    expect(answer).toEqual({ ok: true, data: { accepted: true, status: 'queued' } })
    expect((await loop.queue.peek(ROOT)).map((item) => item.text)).toEqual(['hi'])
    expect(sent).toEqual([
      { sessionId: ROOT, items: [{ queuedId: expect.any(String), text: 'hi' }] },
    ])
  })

  it('clears held when the held message is withdrawn, and keeps it for any other', async () => {
    // 「间接切公网」: queue.ts 撤回 held 那条时自己清 chat.queue 的 held — the send's answer names the
    // item, the queue-held event before it only the host.
    const host = createMemoryHost()
    const pushed: Array<{ items: unknown[]; held?: unknown }> = []
    const loop = createDesktopLoop({
      clock: host.clock,
      send: (channel, payload) => {
        if (channel === 'chat.queue') pushed.push(payload as { items: unknown[]; held?: unknown })
      },
      locale: () => 'en',
      commandShell: NO_SHELL,
    })
    // A message left from before, then a direct send the kernel holds for a public host.
    const { queuedId: before } = await loop.queue.enqueue(ROOT, 'left from before', {
      urgent: false,
    })
    const sessions = {
      send: async (q: { text: string }) => {
        const { queuedId } = await loop.queue.enqueue(ROOT, q.text, { urgent: false })
        loop.ports.events({
          type: 'queue-held',
          rootSessionId: ROOT,
          sessionId: ROOT,
          host: 'api.example.com',
        })
        return { status: 'held', queuedId }
      },
    } as unknown as SessionService
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
    const ipcMain: IpcMainLike = {
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
    }
    registerChatRoutes({ send: () => {}, ipcMain, sessions, loop, log: () => {} })
    await handlers.get('chat.send')?.({}, { sessionId: ROOT, text: 'to the public host' })
    expect(pushed.at(-1)?.held).toEqual({ host: 'api.example.com' })
    const heldId = (await loop.queue.peek(ROOT)).at(-1)?.queuedId ?? ''
    const act = handlers.get('chat.queue.act')
    // Another item goes: the held one still waits on the menu.
    await act?.({}, { sessionId: ROOT, action: 'withdraw', queuedId: before })
    expect(pushed.at(-1)).toEqual({
      sessionId: ROOT,
      items: [{ queuedId: heldId, text: 'to the public host' }],
      held: { host: 'api.example.com' },
    })
    // Withdrawing the held one leaves nothing to confirm.
    const { queuedId: after } = await loop.queue.enqueue(ROOT, 'written later', { urgent: false })
    await act?.({}, { sessionId: ROOT, action: 'withdraw', queuedId: heldId })
    expect(pushed.at(-1)).toEqual({
      sessionId: ROOT,
      items: [{ queuedId: after, text: 'written later' }],
    })
  })

  it('keeps an auto-send’s hold, which names no item, until the queue is empty', async () => {
    const pushed: Array<{ held?: unknown }> = []
    const queue = createRunQueue({ onChange: (_root, view) => pushed.push(view) })
    const { queuedId: a } = await queue.enqueue(ROOT, 'a', { urgent: false })
    const { queuedId: b } = await queue.enqueue(ROOT, 'b', { urgent: false })
    queue.setHeld(ROOT, 'api.example.com')
    queue.withdraw(ROOT, b)
    expect(pushed.at(-1)?.held).toEqual({ host: 'api.example.com' })
    queue.withdraw(ROOT, a)
    expect(pushed.at(-1)?.held).toBeUndefined()
  })

  it('withdraws, edits and holds queued messages, pushing the whole queue each time', async () => {
    const pushed: unknown[] = []
    const queue = createRunQueue({ onChange: (root, view) => pushed.push({ root, ...view }) })
    const { queuedId: first } = await queue.enqueue(ROOT, 'first', { urgent: false })
    const { queuedId: second } = await queue.enqueue(ROOT, 'second', { urgent: false })
    expect(queue.edit(ROOT, first, 'first, better')).toBe(true)
    queue.setHeld(ROOT, 'api.example.com')
    expect(queue.withdraw(ROOT, second)).toBe(true)
    expect(queue.withdraw(ROOT, second)).toBe(false)
    expect(pushed.at(-1)).toEqual({
      root: ROOT,
      items: [{ queuedId: first, text: 'first, better' }],
      held: { host: 'api.example.com' },
    })
    queue.setHeld(ROOT, null)
    expect(pushed.at(-1)).toEqual({
      root: ROOT,
      items: [{ queuedId: first, text: 'first, better' }],
    })
  })

  it('computes the local date in this machine’s time zone', () => {
    const now = new Date(2026, 8, 26, 23, 59).getTime()
    expect(localDateOf(now)).toBe('2026-09-26')
  })
})
