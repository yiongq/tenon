/**
 * One session's state on screen (spec 02 plan step 20; §最小审批卡「数据」「答完」, §HostConfirm 可重复投递,
 * §答复与投递, §插话与输入框状态表, §模型菜单与输入框「输入框」, §离开会话, §启动恢复与发送防护): the store
 * behind the external-store runtime, driven through a bridge that answers each route the way main
 * does — through contracts' `registerRoute`, so the store's requests and the answers it reads both
 * pass the route schemas — and pushes each event only once its payload passes the event schema.
 */
import {
  approvalCurrent,
  approvalList,
  approvalRespond,
  approvalResume,
  chatContinue,
  chatEvent,
  chatQueueAct,
  chatQueueEvent,
  chatSend,
  chatSendNow,
  chatStop,
  confirmRequestEvent,
  isEventChannel,
  isRouteChannel,
  registerRoute,
  runStateEvent,
  sessionFacts,
} from '@tenon-app/contracts'
import type {
  EventDef,
  EventPayload,
  MessageRowContract,
  RouteDef,
  RouteRequest,
  RouteResponse,
} from '@tenon-app/contracts'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import type { TenonBridge } from '../src/preload/index.js'
import { listenForQueue } from '../src/renderer/src/runtime/queue-state.js'
import { listenForRunState } from '../src/renderer/src/runtime/run-state.js'
import { APPROVAL_LIST_LIMIT, SessionStore } from '../src/renderer/src/runtime/session-store.js'
import { retryable } from '../src/renderer/src/runtime/thread-model.js'
import type { PendingCard, PendingQuestion } from '../src/renderer/src/runtime/session-store.js'
import { toThreadMessages } from '../src/renderer/src/runtime/to-thread-messages.js'

const SESSION = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b'
const OTHER = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0'
const RUN = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'
const CALL = `${RUN}:1:0`

type AnyRoute = RouteDef<z.ZodType, z.ZodType>
type Handler = (event: unknown, raw: unknown) => unknown

interface FakeBridge {
  readonly bridge: TenonBridge
  /** Answers `route` from now on (replacing the default), through `registerRoute`. */
  handle<R extends AnyRoute>(
    route: R,
    answer: (input: RouteRequest<R>) => RouteResponse<R> | Promise<RouteResponse<R>>,
  ): void
  /** The requests a route's handler received, parsed, in order. */
  calls<R extends AnyRoute>(route: R): RouteRequest<R>[]
  /** Every channel invoked, in order. */
  readonly log: string[]
  emit<E extends EventDef<z.ZodType>>(event: E, payload: EventPayload<E>): void
}

/** The preload bridge as the renderer sees it, with main's routes answered in-process. */
function fakeBridge(): FakeBridge {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const received = new Map<string, unknown[]>()
  const log: string[] = []
  const ipcMain = {
    handle: (channel: string, listener: Handler) => handlers.set(channel, listener),
  }
  const bridge: TenonBridge = {
    initialLocale: 'en',
    startsNewChat: false,
    invoke: (channel, ...args) => {
      if (!isRouteChannel(channel)) return Promise.reject(new Error(`not a route: ${channel}`))
      log.push(channel)
      const handler = handlers.get(channel)
      if (handler === undefined) return Promise.reject(new Error(`no handler for ${channel}`))
      return Promise.resolve(handler({}, args[0]))
    },
    on: (channel, listener) => {
      if (!isEventChannel(channel)) throw new Error(`not an event: ${channel}`)
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
      return () => set.delete(listener)
    },
  }
  const fake: FakeBridge = {
    bridge,
    log,
    handle(route, answer) {
      registerRoute(ipcMain, route, (input) => {
        const list = received.get(route.channel) ?? []
        list.push(input)
        received.set(route.channel, list)
        return answer(input)
      })
    },
    calls: <R extends AnyRoute>(route: R) =>
      (received.get(route.channel) ?? []) as RouteRequest<R>[],
    emit(event, payload) {
      event.payload.parse(payload)
      for (const listener of listeners.get(event.channel) ?? []) listener(payload)
    },
  }
  // What an idle main answers: nothing waits, nothing resumes, every command accepted.
  fake.handle(approvalCurrent, () => null)
  fake.handle(approvalList, () => [])
  fake.handle(approvalResume, () => ({ status: 'none' as const }))
  fake.handle(approvalRespond, () => ({ status: 'applied' as const }))
  fake.handle(sessionFacts, () => ({
    established: true,
    profile: 'chat' as const,
    workspace: null,
  }))
  fake.handle(chatSend, () => ({ accepted: true as const }))
  fake.handle(chatSendNow, () => ({ accepted: true as const }))
  fake.handle(chatStop, () => ({ stopped: true }))
  fake.handle(chatQueueAct, () => ({ status: 'applied' as const }))
  return fake
}

/** Lets every pending route answer and every `void refresh…()` finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function row(
  messageId: string,
  role: 'user' | 'assistant',
  text: string,
  seq: number,
): MessageRowContract {
  return {
    sessionId: SESSION,
    messageId,
    orderSeq: seq,
    role,
    status: 'complete',
    content: [{ type: 'text', text }],
    entryId: seq,
    createdAt: 1_000 + seq,
    updatedAt: 1_000 + seq,
  }
}

/** The thread as its words: role and text of each turn. */
function thread(store: SessionStore): string[] {
  return store
    .getSnapshot()
    .model.turns.map(
      (turn) =>
        `${turn.role}: ${turn.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('')}`,
    )
}

/** A card waiting for a read outside the workspace (§最小审批卡, 旧 214), as `approval.current` has it. */
function card(requestId: string, over: Partial<PendingCard> = {}): PendingCard {
  return {
    waitKind: 'approval',
    card: {
      requestId,
      sessionId: SESSION,
      kind: 'file',
      reason: 'outside-workspace',
      facts: { path: '/Users/me/notes.md', workspace: '/Users/me/work' },
      reversibility: 'read-only',
      target: { type: 'path', path: '/Users/me/notes.md' },
    },
    callKey: CALL,
    anchorCallKey: CALL,
    allowScope: 'once',
    ...over,
  }
}

const R1 = `tool:v1:decision:${RUN}:1:0`
const R2 = `tool:v1:decision:${RUN}:1:0:rejudged`

/** The `run.state` table is the module's own; every test leaves it with no Run for its sessions. */
function clearRunState(): void {
  const fake = fakeBridge()
  const off = listenForRunState(fake.bridge)
  for (const sessionId of [SESSION, OTHER]) {
    fake.emit(runStateEvent, { sessionId, running: false, runId: null })
  }
  off()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(10_000)
})

afterEach(() => {
  vi.useRealTimers()
  clearRunState()
})

describe('sending', () => {
  it('shows a sent message at once, and takes it back when the route refuses it', async () => {
    // The recovery gate refuses a send before `session.latest` has answered (§启动恢复与发送防护):
    // nothing was sent, so nothing may stay on screen as if it had been.
    const fake = fakeBridge()
    const gate = Promise.withResolvers<void>()
    fake.handle(chatSend, async () => {
      await gate.promise
      throw new Error('startup recovery has not finished')
    })
    const store = new SessionStore(SESSION, fake.bridge, [row('m1', 'user', 'earlier', 1)])
    const sending = store.send('hello')
    expect(thread(store)).toEqual(['user: earlier', 'user: hello'])
    expect(store.getSnapshot().model.turns.at(-1)?.optimistic).toBe(true)
    gate.resolve()
    await sending
    expect(fake.calls(chatSend)).toEqual([{ sessionId: SESSION, text: 'hello' }])
    expect(thread(store)).toEqual(['user: earlier'])
  })

  it('keeps a message the route accepted, and gives it the id the kernel wrote', async () => {
    const fake = fakeBridge()
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    await store.send('hello')
    expect(thread(store)).toEqual(['user: hello'])
    fake.emit(chatEvent, {
      type: 'user-message',
      sessionId: SESSION,
      messageId: 'm-hello',
      queuedId: null,
    })
    const [turn] = store.getSnapshot().model.turns
    expect(turn).toMatchObject({ id: 'm-hello', role: 'user' })
    expect(turn?.optimistic).toBe(false)
    detach()
  })

  it('moves a message that queued from the thread to its queued bubble', async () => {
    // §模型菜单与输入框「排队项」: a send during a Run goes to main's queue, drawn from `chat.queue`;
    // main pushes the queue before the send answers.
    const fake = fakeBridge()
    fake.handle(chatSend, ({ text }) => {
      fake.emit(chatQueueEvent, { sessionId: SESSION, items: [{ queuedId: 'q1', text }] })
      return { accepted: true as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [row('m1', 'user', 'first', 1)])
    const detach = store.attach()
    await store.send('second')
    expect(thread(store)).toEqual(['user: first'])
    expect(store.getSnapshot().queue).toEqual([{ queuedId: 'q1', text: 'second' }])

    // A later push that still lists q1 is no new queued message: the same words sent again, which
    // opened a Run this time, stay in the thread.
    fake.handle(chatSend, () => ({ accepted: true as const }))
    await store.send('second')
    fake.emit(chatQueueEvent, {
      sessionId: SESSION,
      items: [{ queuedId: 'q1', text: 'second' }],
      held: { host: 'api.anthropic.com' },
    })
    expect(thread(store)).toEqual(['user: first', 'user: second'])
    // `held` is what opens the model menu's confirmation (§模型菜单「从本机切到公网」).
    expect(store.getSnapshot().held).toEqual({ host: 'api.anthropic.com' })
    fake.emit(chatQueueEvent, { sessionId: SESSION, items: [] })
    expect(store.getSnapshot().held).toBeNull()
    expect(store.getSnapshot().queue).toEqual([])
    detach()
  })

  it('inserts a queued message with its own text, ahead of a message still being sent', async () => {
    // §插话与输入框状态表: a queued message goes in at a batch boundary, or out with a new message —
    // ahead of it (F11, H13). Main takes it out of the queue as it goes in.
    const fake = fakeBridge()
    const store = new SessionStore(SESSION, fake.bridge, [row('m1', 'user', 'first', 1)])
    const detach = store.attach()
    fake.emit(chatQueueEvent, {
      sessionId: SESSION,
      items: [{ queuedId: 'q2', text: 'also this' }],
    })
    fake.emit(chatQueueEvent, { sessionId: SESSION, items: [] })
    fake.emit(chatEvent, {
      type: 'user-message',
      sessionId: SESSION,
      messageId: 'm-q2',
      queuedId: 'q2',
    })
    expect(thread(store)).toEqual(['user: first', 'user: also this'])
    expect(store.getSnapshot().model.turns.at(-1)?.id).toBe('m-q2')

    fake.emit(chatQueueEvent, { sessionId: SESSION, items: [{ queuedId: 'q3', text: 'and this' }] })
    await store.send('new one')
    fake.emit(chatEvent, {
      type: 'user-message',
      sessionId: SESSION,
      messageId: 'm-q3',
      queuedId: 'q3',
    })
    expect(thread(store)).toEqual([
      'user: first',
      'user: also this',
      'user: and this',
      'user: new one',
    ])
    detach()
  })

  it('resends on 「重试」 the message the kernel named, and nothing for an id it cannot resend', async () => {
    // §失败卡与结束原因: 「重试」 sends the same user message again (01 spec.md:395) — the one the Run's
    // terminal event named (`retryOf`; FailureCard and MessageError pass it), not the last one shown.
    const fake = fakeBridge()
    const store = new SessionStore(SESSION, fake.bridge, [
      row('m1', 'user', 'first', 1),
      row('m2', 'assistant', 'answer', 2),
      row('m3', 'user', 'second', 3),
      { ...row('m4', 'assistant', '', 4), status: 'error' },
      row('m5', 'user', '', 5),
    ])
    await store.retry('m3')
    await store.retry('m1')
    expect(fake.calls(chatSend)).toEqual([
      { sessionId: SESSION, text: 'second' },
      { sessionId: SESSION, text: 'first' },
    ])
    // An id the thread does not have, an assistant turn's, a user turn with no words: nothing.
    await store.retry('m-unknown')
    await store.retry('m2')
    await store.retry('m5')
    // Counted at the bridge: an empty resend would fail the route schema before any handler saw it.
    expect(fake.log.filter((channel) => channel === chatSend.channel)).toHaveLength(2)
    expect(thread(store).filter((line) => line.startsWith('user: '))).toEqual([
      'user: first',
      'user: second',
      'user: ',
      'user: second',
      'user: first',
    ])
  })

  it('resends on 「重试」 the named message while another send is still on its way', async () => {
    // A message sent after the failure and not written yet is shown, but it is not the one whose
    // Run failed: 「重试」 repeats the failed Run's message (01 spec.md:395).
    const fake = fakeBridge()
    const held = Promise.withResolvers<void>()
    fake.handle(chatSend, async ({ text }) => {
      if (text === 'later') await held.promise
      return { accepted: true as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [
      row('m1', 'user', 'failed one', 1),
      { ...row('m2', 'assistant', '', 2), status: 'error' },
    ])
    const later = store.send('later')
    expect(store.getSnapshot().model.turns.at(-1)?.optimistic).toBe(true)
    const retried = store.retry('m1')
    await settle()
    expect(fake.calls(chatSend).map((call) => call.text)).toEqual(['later', 'failed one'])
    held.resolve()
    await Promise.all([later, retried])
  })

  it('sends now with the Run run.state names, and none when idle', async () => {
    // §模型菜单与输入框「停止与发送」 (H13): Cmd/Ctrl+Enter stops the Run the user saw, and only that one.
    const fake = fakeBridge()
    const offRunState = listenForRunState(fake.bridge)
    fake.emit(runStateEvent, { sessionId: SESSION, running: true, runId: 'run-7' })
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    expect(store.getSnapshot()).toMatchObject({ running: true, runId: 'run-7' })
    await store.sendNow('now')

    fake.emit(runStateEvent, { sessionId: SESSION, running: true, runId: 'run-8' })
    await store.sendNow('again')
    await store.queueAct({ action: 'send-now', queuedId: 'q1' })

    fake.emit(runStateEvent, { sessionId: SESSION, running: false, runId: null })
    expect(store.getSnapshot()).toMatchObject({ running: false, runId: null })
    await store.sendNow('idle')

    expect(fake.calls(chatSendNow)).toEqual([
      { sessionId: SESSION, text: 'now', runId: 'run-7' },
      { sessionId: SESSION, text: 'again', runId: 'run-8' },
      { sessionId: SESSION, text: 'idle', runId: null },
    ])
    expect(fake.calls(chatQueueAct)).toEqual([
      { action: 'send-now', sessionId: SESSION, queuedId: 'q1', runId: 'run-8' },
    ])
    detach()
    offRunState()
  })
})

describe('the approval card', () => {
  it('shows a card delivered twice once, and does not bring it back after the answer', async () => {
    // 旧 97; §HostConfirm 可重复投递: the interface dedupes by `requestId` — at most one card, its
    // click guard not restarted by a redelivery — and an answered card, collapsed to a row, stays
    // collapsed when the same `requestId` arrives again.
    const fake = fakeBridge()
    let current: PendingCard | null = card(R1)
    fake.handle(approvalCurrent, () => current)
    fake.handle(approvalRespond, () => {
      current = null
      return { status: 'applied' as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    fake.emit(confirmRequestEvent, card(R1).card)
    await settle()
    const shown = store.getSnapshot().pending
    expect(shown?.waitKind === 'approval' ? shown.card.requestId : null).toBe(R1)
    expect(store.getSnapshot().pendingSince).toBe(10_000)

    vi.setSystemTime(20_000)
    fake.emit(confirmRequestEvent, card(R1).card)
    await settle()
    // The pull on a paused end reads the same card (§答复与投递).
    fake.emit(chatEvent, {
      type: 'done',
      sessionId: SESSION,
      stopReason: 'end-turn',
      endReason: { code: 'paused', waitingFor: 'approval' },
    })
    await settle()
    expect(fake.calls(approvalCurrent)).toHaveLength(3)
    expect(store.getSnapshot().pending).toBe(shown)
    expect(store.getSnapshot().pendingSince).toBe(10_000)

    await store.respond('allow')
    expect(fake.calls(approvalRespond)).toEqual([
      { kind: 'approval', sessionId: SESSION, requestId: R1, decision: 'allow' },
    ])
    const collapsed = {
      outcome: 'allowed',
      scope: 'once',
      target: { type: 'path', path: '/Users/me/notes.md' },
      subtask: false,
    }
    expect(store.getSnapshot().pending).toBeNull()
    expect(store.getSnapshot().answered.get(CALL)).toEqual(collapsed)

    fake.emit(confirmRequestEvent, card(R1).card)
    await settle()
    expect(store.getSnapshot().pending).toBeNull()
    expect(store.getSnapshot().answered.get(CALL)).toEqual(collapsed)
    detach()
  })

  it('shows the new card when the answer was stale', async () => {
    // §答复与投递: `stale` — the call still waits, on another card; the interface switches to it
    // by `approval.current`, and nothing collapses.
    const fake = fakeBridge()
    let current: PendingCard | null = card(R1)
    fake.handle(approvalCurrent, () => current)
    fake.handle(approvalRespond, () => {
      current = card(R2)
      return { status: 'stale' as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [])
    await store.open({ resume: false })
    vi.setSystemTime(30_000)
    await store.respond('allow')
    const pending = store.getSnapshot().pending
    expect(pending?.waitKind === 'approval' ? pending.card.requestId : null).toBe(R2)
    // A new card restarts the click guard (APPROVAL_CLICK_GUARD_MS, §最小审批卡「排队行」).
    expect(store.getSnapshot().pendingSince).toBe(30_000)
    expect(store.getSnapshot().answered.size).toBe(0)
  })

  it('collapses a denial with no scope, and a sub-agent’s allow as the subtask’s', async () => {
    // §最小审批卡「期限」「答完」: the collapse uses the card's own data; a card from a sub-agent
    // (callKey ≠ anchorCallKey) is the subtask's, collapsed under the parent's Agent call it hung under.
    const fake = fakeBridge()
    let current: PendingCard | null = card(R1)
    fake.handle(approvalCurrent, () => current)
    fake.handle(approvalRespond, () => {
      current = null
      return { status: 'applied' as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    await store.open({ resume: false })
    await store.respond('deny')
    expect(store.getSnapshot().answered.get(CALL)).toMatchObject({ outcome: 'denied', scope: null })

    const child = `${RUN}:2:1`
    const agentCall = `${RUN}:1:2`
    const url = { type: 'url' as const, url: 'https://example.com/a' }
    current = card(R2, {
      callKey: child,
      anchorCallKey: agentCall,
      allowScope: 'session',
      card: {
        ...card(R2).card,
        sessionId: OTHER,
        kind: 'network',
        reason: 'network',
        facts: { host: 'example.com', toolName: 'WebFetch' },
        reversibility: 'unknown',
        target: url,
      },
    })
    await store.refreshPending()
    await store.respond('allow')
    // The answer goes to the call's own session, the sub-agent's.
    expect(fake.calls(approvalRespond).at(-1)).toMatchObject({ sessionId: OTHER, requestId: R2 })
    const subtaskRow = store.getSnapshot().answered.get(agentCall)
    expect(subtaskRow).toEqual({ outcome: 'allowed', scope: 'session', target: url, subtask: true })

    // Once the row's own outcome carries the approval, the live collapse is no longer needed.
    fake.emit(chatEvent, {
      type: 'tool-outcome',
      sessionId: SESSION,
      callKey: CALL,
      providerToolCallId: 'toolu_1',
      effect: 'blocked',
      state: 'not-run',
      source: 'user-rejected',
      output: 'The user rejected this tool call.',
      approval: { outcome: 'denied', scope: null, target: card(R1).card.target },
    })
    expect(store.getSnapshot().answered.has(CALL)).toBe(false)
    expect([...store.getSnapshot().answered.values()]).toEqual([subtaskRow])
    detach()
  })

  // A sub-agent's call has no row in the root thread: its answered card collapses under the anchor
  // row that showed it (§最小审批卡「位置」: 「只在当场显示」 there), which is the row ToolRow reads.
  it('collapses a sub-agent’s answered card under the anchor row that showed it', async () => {
    const fake = fakeBridge()
    const child = `${RUN}:2:1`
    let current: PendingCard | null = card(R2, {
      callKey: child,
      anchorCallKey: CALL,
      allowScope: 'session',
      card: { ...card(R2).card, sessionId: OTHER },
    })
    fake.handle(approvalCurrent, () => current)
    fake.handle(approvalRespond, () => {
      current = null
      return { status: 'applied' as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [])
    await store.open({ resume: false })
    await store.respond('allow')
    expect(store.getSnapshot().answered.get(CALL)).toMatchObject({
      outcome: 'allowed',
      scope: 'session',
      subtask: true,
    })
  })

  // §最小审批卡「答完」: a superseded card leaves no collapsed line — it goes at once (plan 旧 21:
  // 「发出后卡片消失」), and the composer's 「发送会取消上面待批的操作」 with it. The kernel closes the
  // waiting call as `superseded` before the new round opens (a `tool-outcome` with no `approval`).
  it('takes the card away once a new message has superseded it', async () => {
    const fake = fakeBridge()
    let current: PendingCard | null = card(R1)
    fake.handle(approvalCurrent, () => current)
    fake.handle(chatSend, () => {
      // What main does for a send while a card waits: the card's call closes, then the round opens.
      current = null
      fake.emit(chatEvent, {
        type: 'tool-outcome',
        sessionId: SESSION,
        callKey: CALL,
        providerToolCallId: 'toolu_1',
        effect: 'blocked',
        state: 'not-run',
        source: 'superseded',
        output: 'Not run: the user sent a new message instead.',
      })
      fake.emit(chatEvent, {
        type: 'user-message',
        sessionId: SESSION,
        messageId: 'm-new',
        queuedId: null,
      })
      return { accepted: true as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    await store.open({ resume: false })
    expect(store.getSnapshot().pending).not.toBeNull()
    await store.send('never mind, do this instead')
    await settle()
    // The new Run is still streaming: no `done` has come, and none is needed for the card to go.
    expect(store.getSnapshot().pending).toBeNull()
    detach()
  })

  it('pulls the card when a Run ends paused, the broadcast having been lost', async () => {
    // §答复与投递: a `confirm.request` sent before the window loaded is gone; the pull on the
    // `paused` end is what brings the card.
    const fake = fakeBridge()
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    fake.handle(approvalCurrent, () => card(R1))
    fake.emit(chatEvent, {
      type: 'done',
      sessionId: SESSION,
      stopReason: 'end-turn',
      endReason: { code: 'paused', waitingFor: 'approval' },
    })
    await settle()
    const pending = store.getSnapshot().pending
    expect(pending?.waitKind === 'approval' ? pending.card.requestId : null).toBe(R1)
    detach()
  })
})

describe('stopping and resuming', () => {
  it('reads the card and whether the session can resume again after a stop', async () => {
    // §答复与投递: a stop on a paused or resumable root closes what waits; the stop button then
    // hides and the 「继续」 row goes (§离开会话 第 3 条).
    const fake = fakeBridge()
    let current: PendingCard | null = card(R1)
    let roots = [{ sessionId: SESSION, waitKind: 'resume' as const }]
    fake.handle(approvalCurrent, () => current)
    fake.handle(approvalList, () => roots)
    fake.handle(chatStop, () => {
      current = null
      roots = []
      return { stopped: true }
    })
    const store = new SessionStore(SESSION, fake.bridge, [])
    await store.open({ resume: false })
    expect(store.getSnapshot().pending).not.toBeNull()
    expect(store.getSnapshot().resumable).toBe(true)
    fake.log.length = 0
    await store.stop()
    expect(fake.log).toEqual(['chat.stop', 'approval.current', 'approval.list'])
    expect(store.getSnapshot().pending).toBeNull()
    expect(store.getSnapshot().resumable).toBe(false)
  })

  it('resumes a session opened by id exactly once, and one restored on its own never', async () => {
    // §离开会话 第 4 条, §启动恢复与发送防护: switching to a session resumes what startup recovery
    // listed for it; the session a window restores by itself only offers 「继续」.
    const opened = fakeBridge()
    let roots = [{ sessionId: SESSION, waitKind: 'resume' as const }]
    opened.handle(approvalList, () => roots)
    opened.handle(approvalResume, () => {
      roots = []
      return { status: 'started' as const }
    })
    const switched = new SessionStore(SESSION, opened.bridge, [])
    await switched.open({ resume: true })
    expect(opened.calls(approvalResume)).toEqual([{ sessionId: SESSION }])
    expect(switched.getSnapshot().resumable).toBe(false)

    const restoredBridge = fakeBridge()
    restoredBridge.handle(approvalList, () => [{ sessionId: SESSION, waitKind: 'resume' as const }])
    const restored = new SessionStore(SESSION, restoredBridge.bridge, [])
    await restored.open({ resume: false })
    expect(restoredBridge.calls(approvalResume)).toEqual([])
    expect(restored.getSnapshot().resumable).toBe(true)
    // Only another session's row: this one cannot resume.
    restoredBridge.handle(approvalList, () => [{ sessionId: OTHER, waitKind: 'resume' as const }])
    await restored.refreshResumable()
    expect(restored.getSnapshot().resumable).toBe(false)
  })

  it('reads whether the session can resume again when a Run ends: a send resumed it', async () => {
    // 打开时续跑: a message sent in the restored, resumable session resumes it first, with no
    // `approval.resume` from here — the end of that Run is what takes 「上次没做完 · 继续」 away.
    const fake = fakeBridge()
    let roots = [{ sessionId: SESSION, waitKind: 'resume' as const }]
    fake.handle(approvalList, () => roots)
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    await store.open({ resume: false })
    expect(store.getSnapshot().resumable).toBe(true)
    roots = []
    fake.emit(chatEvent, {
      type: 'done',
      sessionId: SESSION,
      stopReason: 'end-turn',
      endReason: { code: 'completed' },
    })
    await settle()
    expect(store.getSnapshot().resumable).toBe(false)
    detach()
  })
})

describe('what the store listens to', () => {
  it('ignores what is pushed for another session', async () => {
    const fake = fakeBridge()
    const offRunState = listenForRunState(fake.bridge)
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    fake.emit(chatEvent, { type: 'text-delta', sessionId: OTHER, delta: 'not yours' })
    fake.emit(chatQueueEvent, { sessionId: OTHER, items: [{ queuedId: 'q9', text: 'not yours' }] })
    fake.emit(chatEvent, {
      type: 'user-message',
      sessionId: OTHER,
      messageId: 'm9',
      queuedId: 'q9',
    })
    fake.emit(runStateEvent, { sessionId: OTHER, running: true, runId: 'run-other' })
    fake.emit(chatEvent, { type: 'done', sessionId: OTHER, stopReason: 'end-turn' })
    await settle()
    expect(store.getSnapshot()).toMatchObject({
      queue: [],
      held: null,
      running: false,
      runId: null,
    })
    expect(store.getSnapshot().model.turns).toEqual([])
    // A `done` of another session pulls nothing for this one.
    expect(fake.calls(approvalCurrent)).toEqual([])

    // The same pushes for this session do land: the filter, not a dead listener, ignored them.
    fake.emit(chatEvent, { type: 'text-delta', sessionId: SESSION, delta: 'yours' })
    fake.emit(runStateEvent, { sessionId: SESSION, running: true, runId: 'run-mine' })
    expect(thread(store)).toEqual(['assistant: yours'])
    expect(store.getSnapshot()).toMatchObject({ running: true, runId: 'run-mine' })
    detach()
    offRunState()
  })

  it('hears nothing once detached', async () => {
    const fake = fakeBridge()
    const offRunState = listenForRunState(fake.bridge)
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    detach()
    fake.emit(chatEvent, { type: 'text-delta', sessionId: SESSION, delta: 'late' })
    fake.emit(chatQueueEvent, { sessionId: SESSION, items: [{ queuedId: 'q1', text: 'late' }] })
    fake.emit(confirmRequestEvent, card(R1).card)
    fake.emit(runStateEvent, { sessionId: SESSION, running: true, runId: 'run-late' })
    await settle()
    expect(store.getSnapshot().model.turns).toEqual([])
    expect(store.getSnapshot()).toMatchObject({ queue: [], running: false, pending: null })
    expect(fake.calls(approvalCurrent)).toEqual([])
    offRunState()
  })
})

describe('what can be sent (§模型菜单与输入框「提示与禁发」, §启动恢复与发送防护)', () => {
  it('while restoring, nothing is sent and nothing is shown, by send, send-now or 「重试」', async () => {
    // B15: before startup recovery has finished, the composer cannot send; the store holds the line
    // too, so no path — Enter, Cmd/Ctrl+Enter, the card's 「重试」 — puts a message on screen.
    const fake = fakeBridge()
    const store = new SessionStore(
      SESSION,
      fake.bridge,
      [row('m1', 'user', 'earlier', 1), { ...row('m2', 'assistant', '', 2), status: 'error' }],
      false,
    )
    expect(store.sendBlock()).toBe('restoring')
    await store.send('hello')
    await store.sendNow('now')
    await store.retry('m1')
    expect(fake.log).toEqual([])
    expect(thread(store)).toEqual(['user: earlier', 'assistant: '])

    store.setCanSend(true)
    expect(store.sendBlock()).toBeNull()
    await store.send('hello')
    expect(fake.calls(chatSend)).toEqual([{ sessionId: SESSION, text: 'hello' }])
  })

  it('a task on a text-only model cannot send either; restoring is the reason while both hold', async () => {
    // A15: the menu reports a text-only model in task form; sending is disabled, with the reason.
    const fake = fakeBridge()
    const store = new SessionStore(SESSION, fake.bridge, [row('m1', 'user', 'earlier', 1)])
    let notified = 0
    store.subscribe(() => (notified += 1))
    store.setTextOnlyTask(true)
    store.setTextOnlyTask(true)
    expect(notified).toBe(1)
    expect(store.sendBlock()).toBe('textOnlyTask')
    await store.send('hello')
    await store.sendNow('now')
    await store.retry('m1')
    expect(fake.log).toEqual([])
    expect(thread(store)).toEqual(['user: earlier'])

    store.setCanSend(false)
    expect(store.sendBlock()).toBe('restoring')
    store.setCanSend(true)
    store.setTextOnlyTask(false)
    expect(store.sendBlock()).toBeNull()
    expect(notified).toBe(4)
    await store.sendNow('now')
    expect(fake.calls(chatSendNow)).toEqual([{ sessionId: SESSION, text: 'now', runId: null }])
  })
})

describe('the echo of a send-now and of 「重试」', () => {
  it('send-now shows the message at once, and takes it back when the route refuses it', async () => {
    const fake = fakeBridge()
    const gate = Promise.withResolvers<void>()
    fake.handle(chatSendNow, async () => {
      await gate.promise
      throw new Error('startup recovery has not finished')
    })
    const store = new SessionStore(SESSION, fake.bridge, [])
    const sending = store.sendNow('now')
    expect(thread(store)).toEqual(['user: now'])
    expect(store.getSnapshot().model.turns[0]?.optimistic).toBe(true)
    gate.resolve()
    await sending
    expect(thread(store)).toEqual([])
  })

  it('「重试」 shows the words again; the kernel’s resend is the same message, so one stays', async () => {
    // 01 spec.md:395: the resend reuses the message's id — the thread must not show it twice.
    const fake = fakeBridge()
    fake.handle(chatSend, () => {
      fake.emit(chatEvent, {
        type: 'user-message',
        sessionId: SESSION,
        messageId: 'm3',
        queuedId: null,
      })
      return { accepted: true as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [
      row('m1', 'user', 'first', 1),
      row('m2', 'assistant', 'answer', 2),
      row('m3', 'user', 'second', 3),
    ])
    const detach = store.attach()
    let shown: string[] = []
    const off = store.subscribe(() => {
      if (shown.length === 0) shown = thread(store)
    })
    await store.retry('m3')
    off()
    // The echo came first, then the kernel's `user-message` took it back.
    expect(shown).toEqual(['user: first', 'assistant: answer', 'user: second', 'user: second'])
    expect(thread(store)).toEqual(['user: first', 'assistant: answer', 'user: second'])
    expect(store.getSnapshot().model.turns.some((turn) => turn.optimistic === true)).toBe(false)
    detach()
  })

  it('send-now during a Run: the stopped Run and the message’s own Run each end on their own turn', async () => {
    // §插话与输入框状态表「立即发送」: main queues the message as urgent (its bubble replaces the
    // echo), the Run ends `user-stopped`, then the message goes out and opens the next Run.
    const fake = fakeBridge()
    const offRunState = listenForRunState(fake.bridge)
    fake.emit(runStateEvent, { sessionId: SESSION, running: true, runId: 'run-1' })
    fake.handle(chatSendNow, ({ text }) => {
      fake.emit(chatQueueEvent, { sessionId: SESSION, items: [{ queuedId: 'q1', text }] })
      return { accepted: true as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    await store.send('first')
    fake.emit(chatEvent, {
      type: 'user-message',
      sessionId: SESSION,
      messageId: 'm1',
      queuedId: null,
    })
    fake.emit(chatEvent, { type: 'text-delta', sessionId: SESSION, delta: 'Working' })
    await store.sendNow('stop, do this')
    expect(thread(store)).toEqual(['user: first', 'assistant: Working'])
    expect(store.getSnapshot().queue).toEqual([{ queuedId: 'q1', text: 'stop, do this' }])
    fake.emit(chatEvent, {
      type: 'done',
      sessionId: SESSION,
      stopReason: 'aborted',
      endReason: { code: 'user-stopped' },
      runId: 'run-1',
      retryOf: 'm1',
    })
    fake.emit(chatQueueEvent, { sessionId: SESSION, items: [] })
    fake.emit(chatEvent, {
      type: 'user-message',
      sessionId: SESSION,
      messageId: 'm2',
      queuedId: 'q1',
    })
    fake.emit(chatEvent, {
      type: 'error',
      sessionId: SESSION,
      code: 'provider',
      endReason: {
        code: 'provider-error',
        providerId: 'anthropic',
        errorCode: 'server',
        providerReason: null,
        attempts: 3,
      },
      runId: 'run-2',
      retryOf: 'm2',
    })
    expect(fake.calls(chatSendNow)).toEqual([
      { sessionId: SESSION, text: 'stop, do this', runId: 'run-1' },
    ])
    const turns = store.getSnapshot().model.turns
    expect(thread(store)).toEqual([
      'user: first',
      'assistant: Working',
      'user: stop, do this',
      'assistant: ',
    ])
    expect(turns.map((turn) => turn.end?.runId)).toEqual([undefined, 'run-1', undefined, 'run-2'])
    // The message opened its Run and nothing went out: the kernel names it, and 「重试」 resends it.
    expect(turns[3]?.end?.retryOf).toBe('m2')
    expect(retryable(turns, 3)).toBe(true)
    await store.retry('m2')
    expect(fake.calls(chatSend).at(-1)).toEqual({ sessionId: SESSION, text: 'stop, do this' })
    await settle()
    detach()
    offRunState()
  })
})

describe('「继续」 held for a public host (§重试与「继续」, §模型菜单「从本机切到公网」)', () => {
  it('a held answer opens the menu’s confirmation; a started one changes nothing', async () => {
    const fake = fakeBridge()
    let answer: { status: 'started' | 'held'; host?: string } = {
      status: 'held',
      host: 'api.x.com',
    }
    fake.handle(chatContinue, () => answer)
    const store = new SessionStore(SESSION, fake.bridge, [])
    await store.continueRun()
    expect(fake.calls(chatContinue)).toEqual([{ sessionId: SESSION }])
    expect(store.getSnapshot()).toMatchObject({ held: { host: 'api.x.com' }, heldSeq: 1 })
    // Held again (the user closed the confirmation): a new count, so the menu asks again.
    await store.continueRun()
    expect(store.getSnapshot().heldSeq).toBe(2)
    answer = { status: 'started' }
    await store.continueRun()
    expect(store.getSnapshot()).toMatchObject({ held: { host: 'api.x.com' }, heldSeq: 2 })
  })

  it('a refused 「继续」 changes nothing', async () => {
    const fake = fakeBridge()
    fake.handle(chatContinue, () => {
      throw new Error('shutting down')
    })
    const store = new SessionStore(SESSION, fake.bridge, [])
    await store.continueRun()
    expect(store.getSnapshot()).toMatchObject({ held: null, heldSeq: 0 })
  })
})

describe('a queued send-now held again for the same host (§模型菜单「从本机切到公网」)', () => {
  it('opens the confirmation again on a held send-now, and not on applied or not-found', async () => {
    // The queue push that follows names the same host, so it is no new hold: the route's own
    // `sendStatus` is what says the kernel held the round again (step 20 round 4).
    const fake = fakeBridge()
    let answer: { status: 'applied' | 'not-found'; sendStatus?: 'held' | 'started' } = {
      status: 'applied',
      sendStatus: 'held',
    }
    fake.handle(chatQueueAct, () => answer)
    const store = new SessionStore(SESSION, fake.bridge, [])
    await store.queueAct({ action: 'send-now', queuedId: 'q1' })
    expect(store.getSnapshot().heldSeq).toBe(1)
    answer = { status: 'applied', sendStatus: 'started' }
    await store.queueAct({ action: 'send-now', queuedId: 'q1' })
    answer = { status: 'not-found' }
    await store.queueAct({ action: 'send-now', queuedId: 'q1' })
    await store.queueAct({ action: 'withdraw', queuedId: 'q1' })
    expect(store.getSnapshot().heldSeq).toBe(1)
  })
})

describe('the session’s facts (§界面范围 ModeSwitch)', () => {
  it('reads the facts again once the first message establishes the session, and not after', async () => {
    // The mode can be switched until the first message; from then on it only shows.
    const fake = fakeBridge()
    let established = false
    fake.handle(sessionFacts, () => ({ established, profile: 'chat' as const, workspace: null }))
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    await store.open({ resume: false })
    expect(store.getSnapshot().facts?.established).toBe(false)
    established = true
    fake.emit(chatEvent, {
      type: 'user-message',
      sessionId: SESSION,
      messageId: 'm1',
      queuedId: null,
    })
    await settle()
    expect(fake.calls(sessionFacts)).toHaveLength(2)
    expect(store.getSnapshot().facts?.established).toBe(true)
    fake.emit(chatEvent, {
      type: 'user-message',
      sessionId: SESSION,
      messageId: 'm2',
      queuedId: null,
    })
    fake.emit(chatEvent, { type: 'done', sessionId: SESSION, stopReason: 'end-turn' })
    await settle()
    expect(fake.calls(sessionFacts)).toHaveLength(2)
    detach()
  })

  it('a Run’s end reads them again while the session is not established yet', async () => {
    // A send that ended before its message was written (a missing key) leaves the session a draft:
    // the facts are read again at the end, and stay a draft's.
    const fake = fakeBridge()
    fake.handle(sessionFacts, () => ({
      established: false,
      profile: 'cowork' as const,
      workspace: null,
    }))
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    await store.open({ resume: false })
    fake.emit(chatEvent, { type: 'error', sessionId: SESSION, code: 'auth' })
    await settle()
    expect(fake.calls(sessionFacts)).toHaveLength(2)
    expect(store.getSnapshot().facts).toMatchObject({ established: false, profile: 'cowork' })
    detach()
  })
})

describe('reads that answer out of order', () => {
  it('drops a card read that a later read has overtaken', async () => {
    // The card is only ever what the newest `approval.current` says (§最小审批卡「数据」).
    const fake = fakeBridge()
    const slow = Promise.withResolvers<PendingCard | null>()
    const answers: Array<Promise<PendingCard | null> | PendingCard | null> = [slow.promise, null]
    fake.handle(approvalCurrent, () => answers.shift() ?? null)
    const store = new SessionStore(SESSION, fake.bridge, [])
    const first = store.refreshPending()
    await store.refreshPending()
    slow.resolve(card(R1))
    await first
    expect(fake.calls(approvalCurrent)).toHaveLength(2)
    expect(store.getSnapshot().pending).toBeNull()
  })

  it('drops a facts read and a resumable read that later reads have overtaken', async () => {
    const fake = fakeBridge()
    const slowFacts = Promise.withResolvers<{
      established: boolean
      profile: 'chat'
      workspace: null
    }>()
    const facts = [
      slowFacts.promise,
      { established: true, profile: 'chat' as const, workspace: null },
    ]
    fake.handle(sessionFacts, () => facts.shift() ?? slowFacts.promise)
    const slowList = Promise.withResolvers<Array<{ sessionId: string; waitKind: 'resume' }>>()
    const lists = [slowList.promise, []]
    fake.handle(approvalList, () => lists.shift() ?? [])
    const store = new SessionStore(SESSION, fake.bridge, [])
    const firstFacts = store.refreshFacts()
    const firstList = store.refreshResumable()
    await store.refreshFacts()
    await store.refreshResumable()
    slowFacts.resolve({ established: false, profile: 'chat', workspace: null })
    slowList.resolve([{ sessionId: SESSION, waitKind: 'resume' }])
    await Promise.all([firstFacts, firstList])
    expect(store.getSnapshot().facts?.established).toBe(true)
    expect(store.getSnapshot().resumable).toBe(false)
  })

  it('asks approval.list for APPROVAL_LIST_LIMIT rows (暂定 20, plan step 34)', async () => {
    const fake = fakeBridge()
    const store = new SessionStore(SESSION, fake.bridge, [])
    await store.refreshResumable()
    expect(APPROVAL_LIST_LIMIT).toBe(20)
    expect(fake.calls(approvalList)).toEqual([{ limit: 20 }])
  })
})

describe('opening a session', () => {
  it('opens once per store: a second open, even a concurrent one, reads and resumes nothing', async () => {
    // §离开会话 第 4 条: exactly one `approval.resume` — React's StrictMode runs the effect twice.
    const fake = fakeBridge()
    fake.handle(approvalList, () => [{ sessionId: SESSION, waitKind: 'resume' as const }])
    const store = new SessionStore(SESSION, fake.bridge, [])
    await Promise.all([store.open({ resume: true }), store.open({ resume: true })])
    await store.open({ resume: true })
    expect(fake.calls(approvalResume)).toEqual([{ sessionId: SESSION }])
    expect(fake.calls(approvalCurrent)).toHaveLength(1)
    expect(fake.calls(sessionFacts)).toHaveLength(1)
    // One read on opening, one after the resume.
    expect(fake.calls(approvalList)).toHaveLength(2)
  })
})

describe('a card whose call closed without an answer from here (§最小审批卡「答完」)', () => {
  it('goes at once when its call closes, leaves no collapsed line, and what waits is read again', async () => {
    // Superseded by a message from another window, cancelled by a stop: the card goes before any
    // read answers, and `approval.current` then names whatever waits next.
    const fake = fakeBridge()
    const next = Promise.withResolvers<PendingCard | null>()
    const answers: Array<Promise<PendingCard | null> | PendingCard | null> = [
      card(R1),
      next.promise,
    ]
    fake.handle(approvalCurrent, () => answers.shift() ?? null)
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    await store.open({ resume: false })
    // Another call's outcome is no reason to drop the card.
    fake.emit(chatEvent, {
      type: 'tool-outcome',
      sessionId: SESSION,
      callKey: `${RUN}:0:0`,
      providerToolCallId: 'toolu_0',
      effect: 'read',
      state: 'completed',
      source: null,
      output: 'ok',
    })
    expect(store.getSnapshot().pending).not.toBeNull()
    expect(fake.calls(approvalCurrent)).toHaveLength(1)
    fake.emit(chatEvent, {
      type: 'tool-outcome',
      sessionId: SESSION,
      callKey: CALL,
      providerToolCallId: 'toolu_1',
      effect: 'blocked',
      state: 'not-run',
      source: 'stopped',
      output: 'Not run: the user stopped the task.',
    })
    expect(store.getSnapshot().pending).toBeNull()
    expect(store.getSnapshot().answered.size).toBe(0)
    expect(fake.calls(approvalCurrent)).toHaveLength(2)
    next.resolve(card(R2))
    await settle()
    const shown = store.getSnapshot().pending
    expect(shown?.waitKind === 'approval' ? shown.card.requestId : null).toBe(R2)
    detach()
  })

  it('a sub-agent’s card goes when the Agent call it hangs under closes', async () => {
    // §最小审批卡「位置」: the card hangs under `anchorCallKey`; a stop closes that call in the root
    // thread, while the sub-agent's own call has no row here.
    const fake = fakeBridge()
    const agentCall = `${RUN}:1:2`
    let current: PendingCard | null = card(R2, {
      callKey: `${RUN}:2:1`,
      anchorCallKey: agentCall,
      card: { ...card(R2).card, sessionId: OTHER },
    })
    fake.handle(approvalCurrent, () => current)
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    await store.open({ resume: false })
    expect(store.getSnapshot().pending).not.toBeNull()
    current = null
    fake.emit(chatEvent, {
      type: 'tool-outcome',
      sessionId: SESSION,
      callKey: agentCall,
      providerToolCallId: 'toolu_2',
      effect: 'external',
      state: 'aborted',
      source: 'stopped',
      output: 'The subtask was stopped.',
    })
    expect(store.getSnapshot().pending).toBeNull()
    await settle()
    expect(store.getSnapshot().pending).toBeNull()
    detach()
  })

  it('a message that went in while a card waits reads the card again', async () => {
    // §多卡、拒绝与取代: a new message supersedes what waits.
    const fake = fakeBridge()
    let current: PendingCard | null = card(R1)
    fake.handle(approvalCurrent, () => current)
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    await store.open({ resume: false })
    current = null
    fake.emit(chatEvent, {
      type: 'user-message',
      sessionId: SESSION,
      messageId: 'm9',
      queuedId: null,
    })
    await settle()
    expect(fake.calls(approvalCurrent)).toHaveLength(2)
    expect(store.getSnapshot().pending).toBeNull()
    // With no card, a message reads nothing.
    fake.emit(chatEvent, {
      type: 'user-message',
      sessionId: SESSION,
      messageId: 'm10',
      queuedId: null,
    })
    await settle()
    expect(fake.calls(approvalCurrent)).toHaveLength(2)
    detach()
  })
})

describe('the queue a store starts with (queue-state.ts)', () => {
  it('a store made after the push has the queue, the hold, its count and the texts of items gone in', () => {
    // A session switched back to by id, or a reloaded document: the one push that named the queue
    // came before the store existed (§进行中、暂停与 RunRegistry「何时推」).
    const fake = fakeBridge()
    const offQueue = listenForQueue(fake.bridge)
    const sessionId = randomUUID()
    fake.emit(chatQueueEvent, { sessionId, items: [{ queuedId: 'q1', text: 'went in already' }] })
    fake.emit(chatQueueEvent, {
      sessionId,
      items: [{ queuedId: 'q2', text: 'still waiting' }],
      held: { host: 'api.anthropic.com' },
    })
    const store = new SessionStore(sessionId, fake.bridge, [])
    expect(store.getSnapshot()).toMatchObject({
      queue: [{ queuedId: 'q2', text: 'still waiting' }],
      held: { host: 'api.anthropic.com' },
      heldSeq: 1,
    })
    const detach = store.attach()
    // q1 left the queue before this store existed: its text comes from the table.
    fake.emit(chatEvent, { type: 'user-message', sessionId, messageId: 'm1', queuedId: 'q1' })
    fake.emit(chatEvent, { type: 'user-message', sessionId, messageId: 'm2', queuedId: 'q2' })
    expect(
      store
        .getSnapshot()
        .model.turns.map((turn) => [
          turn.id,
          turn.parts[0]?.kind === 'text' ? turn.parts[0].text : '',
        ]),
    ).toEqual([
      ['m1', 'went in already'],
      ['m2', 'still waiting'],
    ])
    // Still held for the same host: no new count. Held for another counts on from the table's.
    fake.emit(chatQueueEvent, { sessionId, items: [], held: { host: 'api.anthropic.com' } })
    expect(store.getSnapshot().heldSeq).toBe(1)
    fake.emit(chatQueueEvent, { sessionId, items: [], held: { host: 'api.openai.com' } })
    expect(store.getSnapshot().heldSeq).toBe(2)
    detach()
    offQueue()
  })

  it('a seeded item is not new: a send with the same words stays in the thread', async () => {
    const fake = fakeBridge()
    const offQueue = listenForQueue(fake.bridge)
    const sessionId = randomUUID()
    fake.emit(chatQueueEvent, { sessionId, items: [{ queuedId: 'q1', text: 'same words' }] })
    const store = new SessionStore(sessionId, fake.bridge, [])
    const detach = store.attach()
    await store.send('same words')
    fake.emit(chatQueueEvent, { sessionId, items: [{ queuedId: 'q1', text: 'same words' }] })
    expect(store.getSnapshot().model.turns.map((turn) => turn.optimistic)).toEqual([true])
    detach()
    offQueue()
  })
})

describe('what a send answers (chat.send / chat.sendNow `status`, plan step 20)', () => {
  type Status = NonNullable<RouteResponse<typeof chatSend>['status']>

  /** The store's two sends, each through its own route. */
  const SENDS = [
    ['send', chatSend, (store: SessionStore, text: string) => store.send(text)],
    ['send-now', chatSendNow, (store: SessionStore, text: string) => store.sendNow(text)],
  ] as const

  /** Each turn as its words, its id (`local` for one this window made) and whether it awaits one. */
  function turns(store: SessionStore): Array<[string, string, boolean]> {
    const words = thread(store)
    return store
      .getSnapshot()
      .model.turns.map((turn, i) => [
        words[i] ?? '',
        turn.id.startsWith('local-') ? 'local' : turn.id,
        turn.optimistic === true,
      ])
  }

  for (const [name, route, sendWith] of SENDS) {
    it(`${name}, answered: the words were a question's typed answer, no message — they go (plan step 26)`, async () => {
      // §插话与输入框状态表「等提问」: 输入的原文作为当前问题的答案, 不写 message/user — even when this
      // window had not read the question yet; the summary card shows the words as the reply.
      const fake = fakeBridge()
      const store = new SessionStore(SESSION, fake.bridge, [])
      const detach = store.attach()
      fake.handle(route, () => ({ accepted: true as const, status: 'answered' as const }))
      await sendWith(store, 'the blue one')
      expect(turns(store)).toEqual([])
      fake.handle(chatSend, () => ({ accepted: true as const, status: 'started' as const }))
      await store.send('next')
      fake.emit(chatEvent, {
        type: 'user-message',
        sessionId: SESSION,
        messageId: 'm-next',
        queuedId: null,
      })
      expect(turns(store)).toEqual([['user: next', 'm-next', false]])
      detach()
    })

    for (const status of ['not-sent', 'not-found'] as const) {
      it(`${name}, ${status}: nothing will name the message, so it stays as sent and takes no later id`, async () => {
        // §chat.event (plan step 20 只增): after anything but started, queued and held nothing was
        // written; the renderer settles the message it showed and no longer waits for its id.
        const fake = fakeBridge()
        const store = new SessionStore(SESSION, fake.bridge, [])
        const detach = store.attach()
        fake.handle(route, () => ({ accepted: true as const, status }))
        await sendWith(store, 'lost')
        expect(turns(store)).toEqual([['user: lost', 'local', false]])
        // The next message goes through; its user-message names it, not the settled one.
        fake.handle(chatSend, () => ({ accepted: true as const, status: 'started' as const }))
        await store.send('next')
        fake.emit(chatEvent, {
          type: 'user-message',
          sessionId: SESSION,
          messageId: 'm-next',
          queuedId: null,
        })
        expect(turns(store)).toEqual([
          ['user: lost', 'local', false],
          ['user: next', 'm-next', false],
        ])
        detach()
      })
    }

    for (const status of ['started', 'queued', 'held', undefined] as const) {
      it(`${name}, ${String(status)}: the events will show it, so it still awaits its id`, async () => {
        // An absent status is an older main's answer: as before, the user-message names it.
        const fake = fakeBridge()
        const store = new SessionStore(SESSION, fake.bridge, [])
        const detach = store.attach()
        fake.handle(route, () =>
          status === undefined
            ? { accepted: true as const }
            : { accepted: true as const, status: status satisfies Status },
        )
        await sendWith(store, 'shown')
        expect(turns(store)).toEqual([['user: shown', 'local', true]])
        fake.emit(chatEvent, {
          type: 'user-message',
          sessionId: SESSION,
          messageId: 'm-shown',
          queuedId: null,
        })
        expect(turns(store)).toEqual([['user: shown', 'm-shown', false]])
        detach()
      })
    }
  }

  it('a missing key: the end hangs below the message it answers, and the next send is named right', async () => {
    // What main does for a send with no key: the loop ends at once — nothing written, runId null —
    // and the terminal event goes out before the route answers `not-sent`.
    const fake = fakeBridge()
    fake.handle(chatSend, () => {
      fake.emit(chatEvent, {
        type: 'error',
        sessionId: SESSION,
        code: 'auth',
        endReason: {
          code: 'provider-error',
          providerId: 'anthropic',
          errorCode: 'auth',
          providerReason: null,
          attempts: 0,
        },
        runId: null,
        retryOf: null,
      })
      return { accepted: true as const, status: 'not-sent' as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [row('m1', 'user', 'earlier', 1)])
    const detach = store.attach()
    await store.send('no key yet')
    fake.handle(chatSend, () => ({ accepted: true as const, status: 'started' as const }))
    await store.send('with a key now')
    fake.emit(chatEvent, {
      type: 'user-message',
      sessionId: SESSION,
      messageId: 'm2',
      queuedId: null,
    })
    expect(turns(store)).toEqual([
      ['user: earlier', 'm1', false],
      ['user: no key yet', 'local', false],
      ['assistant: ', 'local', false],
      ['user: with a key now', 'm2', false],
    ])
    const end = store.getSnapshot().model.turns[2]?.end
    expect(end).toMatchObject({ runId: null, errorCode: 'auth', retryOf: null })
    detach()
  })
})

describe('a local 「已允许」 whose call never ran (§最小审批卡「答完」)', () => {
  async function allowed(decision: 'allow' | 'deny' = 'allow'): Promise<{
    fake: FakeBridge
    store: SessionStore
    detach: () => void
  }> {
    const fake = fakeBridge()
    let current: PendingCard | null = card(R1)
    fake.handle(approvalCurrent, () => current)
    fake.handle(approvalRespond, () => {
      current = null
      return { status: 'applied' as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    await store.open({ resume: false })
    await store.respond(decision)
    expect(store.getSnapshot().answered.has(CALL)).toBe(true)
    return { fake, store, detach }
  }

  const closed = (
    state: 'completed' | 'not-run',
    source: 'policy' | 'user-rejected' | null,
  ): EventPayload<typeof chatEvent> => ({
    type: 'tool-outcome',
    sessionId: SESSION,
    callKey: CALL,
    providerToolCallId: 'toolu_1',
    effect: state === 'completed' ? 'read' : 'blocked',
    state,
    source,
    output: state === 'completed' ? 'the notes' : 'Not run.',
  })

  it('stays when the call closes not-run with no answer on it: a stop after 允许 keeps 「已允许」', async () => {
    // The redraw reads approval_resolved{allowed} for such a call, so the live row keeps it too.
    const { fake, store, detach } = await allowed()
    fake.emit(chatEvent, closed('not-run', 'user-rejected'))
    expect(store.getSnapshot().answered.has(CALL)).toBe(true)
    detach()
  })

  it('goes when the closure names the answer: a stricter re-judgement leaves no collapsed line', async () => {
    // The kernel's closure for denied-on-rejudge carries `approval`, as the redraw does.
    const { fake, store, detach } = await allowed()
    const closure = closed('not-run', 'policy')
    if (closure.type !== 'tool-outcome') throw new Error('a tool-outcome')
    fake.emit(chatEvent, {
      ...closure,
      approval: { outcome: 'denied-on-rejudge', scope: null, target: card(R1).card.target },
    })
    expect(store.getSnapshot().answered.has(CALL)).toBe(false)
    detach()
  })

  it('stays when the allowed call ran: its outcome carries no answer live, the store’s line stands', async () => {
    const { fake, store, detach } = await allowed()
    fake.emit(chatEvent, closed('completed', null))
    expect(store.getSnapshot().answered.get(CALL)).toMatchObject({ outcome: 'allowed' })
    detach()
  })

  it('a local 「已拒绝」 is not dropped by a not-run closure without its answer', async () => {
    // A denial's closure is not-run by nature; only its own `approval` replaces the local line.
    const { fake, store, detach } = await allowed('deny')
    fake.emit(chatEvent, closed('not-run', 'user-rejected'))
    expect(store.getSnapshot().answered.get(CALL)).toMatchObject({ outcome: 'denied' })
    detach()
  })
})

describe('the model menu’s confirmation count (heldSeq; §模型菜单「从本机切到公网」)', () => {
  it('counts a new hold only: not an edit or a withdraw while held, but another host, or held again', async () => {
    const fake = fakeBridge()
    const store = new SessionStore(SESSION, fake.bridge, [])
    const detach = store.attach()
    const A = { host: 'api.anthropic.com' }
    const B = { host: 'api.openai.com' }
    const push = (items: Array<{ queuedId: string; text: string }>, held?: { host: string }) =>
      fake.emit(chatQueueEvent, {
        sessionId: SESSION,
        items,
        ...(held === undefined ? {} : { held }),
      })
    const counts: number[] = []
    const count = (): void => void counts.push(store.getSnapshot().heldSeq)
    push(
      [
        { queuedId: 'q1', text: 'one' },
        { queuedId: 'q2', text: 'two' },
      ],
      A,
    )
    count()
    // 「修改」 and 「撤回」 while the round stays held re-send `held`: the menu does not ask again.
    push(
      [
        { queuedId: 'q1', text: 'one, edited' },
        { queuedId: 'q2', text: 'two' },
      ],
      A,
    )
    count()
    push([{ queuedId: 'q1', text: 'one, edited' }], A)
    count()
    push([{ queuedId: 'q1', text: 'one, edited' }], B)
    count()
    push([{ queuedId: 'q1', text: 'one, edited' }])
    count()
    push([{ queuedId: 'q1', text: 'one, edited' }], A)
    count()
    expect(counts).toEqual([1, 1, 1, 2, 2, 3])
    expect(store.getSnapshot().held).toEqual(A)
    detach()
  })
})

describe('attach(): what was pushed between the store’s construction and its attach', () => {
  it('reads run.state and the queue table again: a push in that gap reached only them', () => {
    // The store is made during render and attached in an effect (ChatProvider): run.state and
    // chat.queue pushed in between go to the window's tables only (§进行中、暂停与 RunRegistry「何时推」).
    const fake = fakeBridge()
    const offRunState = listenForRunState(fake.bridge)
    const offQueue = listenForQueue(fake.bridge)
    const sessionId = randomUUID()
    const store = new SessionStore(sessionId, fake.bridge, [])
    fake.emit(runStateEvent, { sessionId, running: true, runId: 'run-gap' })
    fake.emit(chatQueueEvent, {
      sessionId,
      items: [{ queuedId: 'q1', text: 'queued in the gap' }],
      held: { host: 'api.anthropic.com' },
    })
    expect(store.getSnapshot()).toMatchObject({
      running: false,
      runId: null,
      queue: [],
      heldSeq: 0,
    })
    const detach = store.attach()
    expect(store.getSnapshot()).toMatchObject({
      running: true,
      runId: 'run-gap',
      queue: [{ queuedId: 'q1', text: 'queued in the gap' }],
      held: { host: 'api.anthropic.com' },
      heldSeq: 1,
    })
    // What it read then is live from here on: the item goes in with its words.
    fake.emit(chatEvent, { type: 'user-message', sessionId, messageId: 'm1', queuedId: 'q1' })
    expect(store.getSnapshot().model.turns.map((turn) => [turn.id, turn.parts])).toEqual([
      ['m1', [{ kind: 'text', text: 'queued in the gap' }]],
    ])
    fake.emit(runStateEvent, { sessionId, running: false, runId: null })
    expect(store.getSnapshot()).toMatchObject({ running: false, runId: null })
    detach()
    offQueue()
    offRunState()
  })

  it('reads an item queued in the gap with no hold: either change is enough to read the table', () => {
    // The usual queue push holds nothing (§插话与输入框状态表): `held` is null before and after, and
    // only the items changed — the bubble must still show once the store attaches.
    const fake = fakeBridge()
    const offQueue = listenForQueue(fake.bridge)
    const sessionId = randomUUID()
    const store = new SessionStore(sessionId, fake.bridge, [])
    fake.emit(chatQueueEvent, { sessionId, items: [{ queuedId: 'q1', text: 'queued, not held' }] })
    expect(store.getSnapshot()).toMatchObject({ queue: [], held: null })
    const detach = store.attach()
    expect(store.getSnapshot()).toMatchObject({
      queue: [{ queuedId: 'q1', text: 'queued, not held' }],
      held: null,
      heldSeq: 0,
    })
    detach()
    offQueue()
  })

  it('with nothing pushed in the gap, attaching changes nothing and tells no one', () => {
    const fake = fakeBridge()
    const offRunState = listenForRunState(fake.bridge)
    const offQueue = listenForQueue(fake.bridge)
    const sessionId = randomUUID()
    fake.emit(runStateEvent, { sessionId, running: true, runId: 'run-before' })
    fake.emit(chatQueueEvent, { sessionId, items: [{ queuedId: 'q1', text: 'before' }] })
    const store = new SessionStore(sessionId, fake.bridge, [])
    const before = store.getSnapshot()
    let notified = 0
    store.subscribe(() => (notified += 1))
    const detach = store.attach()
    expect(notified).toBe(0)
    expect(store.getSnapshot()).toBe(before)
    expect(before).toMatchObject({
      running: true,
      runId: 'run-before',
      queue: [{ queuedId: 'q1' }],
    })
    fake.emit(runStateEvent, { sessionId, running: false, runId: null })
    detach()
    offQueue()
    offRunState()
  })
})

describe('a question (plan step 26; §答复与投递, §插话与输入框状态表「等提问」)', () => {
  const ASK = `${RUN}:1:0`
  const LATER = `${RUN}:1:1`
  const Q1 = `tool:v1:decision:${RUN}:1:0`

  function question(requestId = Q1): PendingQuestion {
    return {
      waitKind: 'question',
      requestId,
      sessionId: SESSION,
      toolRequestId: 'toolu_ask',
      callKey: ASK,
    }
  }

  /** The assistant row that asked, redrawn: an AskUserQuestion and a Read after it, neither closed. */
  function askingRow(): MessageRowContract {
    return {
      ...row('m-ask', 'assistant', '', 2),
      content: [
        {
          type: 'tool-request',
          id: 'toolu_ask',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which colour?',
                header: 'Colour',
                options: [
                  { label: 'red', description: '' },
                  { label: 'blue', description: '' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
        { type: 'tool-request', id: 'toolu_read', name: 'Read', input: { file_path: '/a' } },
      ],
      calls: [
        { callKey: ASK, outcome: null },
        { callKey: LATER, outcome: null },
      ],
    }
  }

  it('answers with every question by its text, and the widget goes once the call has its result', async () => {
    const fake = fakeBridge()
    let current: PendingQuestion | null = question()
    fake.handle(approvalCurrent, () => current)
    const store = new SessionStore(SESSION, fake.bridge, [
      row('m1', 'user', 'pick', 1),
      askingRow(),
    ])
    const detach = store.attach()
    await store.open({ resume: false })
    expect(store.getSnapshot().pending).toEqual(question())
    // Read again — a `paused` end, a push — it is the same question: nothing changes.
    const before = store.getSnapshot()
    await store.refreshPending()
    expect(store.getSnapshot()).toBe(before)

    current = null
    const answers = { 'Which colour?': ['blue'] }
    await store.answerQuestion(answers)
    expect(fake.calls(approvalRespond)).toEqual([
      { kind: 'question', sessionId: SESSION, requestId: Q1, answers },
    ])
    expect(store.getSnapshot().pending).toBeNull()
    // Until the outcome brings the record, the summary card reads this window's.
    expect(store.getSnapshot().asked.get(ASK)).toEqual({ answers })
    fake.emit(chatEvent, {
      type: 'tool-outcome',
      sessionId: SESSION,
      callKey: ASK,
      providerToolCallId: 'toolu_ask',
      effect: 'read',
      state: 'completed',
      source: null,
      output: 'User has answered your questions: "Which colour?"="blue".',
      question: { answers },
    })
    expect(store.getSnapshot().asked.has(ASK)).toBe(false)
    detach()
  })

  it('a stale answer reads the question again and records nothing', async () => {
    const fake = fakeBridge()
    const answers: Array<PendingQuestion | null> = [question(), question(`${Q1}:rejudge:1`)]
    fake.handle(approvalCurrent, () => answers.shift() ?? null)
    fake.handle(approvalRespond, () => ({ status: 'stale' as const }))
    const store = new SessionStore(SESSION, fake.bridge, [askingRow()])
    await store.open({ resume: false })
    await store.answerQuestion({ 'Which colour?': null })
    expect(store.getSnapshot().asked.size).toBe(0)
    const shown = store.getSnapshot().pending
    expect(shown?.waitKind === 'question' ? shown.requestId : null).toBe(`${Q1}:rejudge:1`)
  })

  it('goes when a stop closes the call unanswered, and reads what waits again', async () => {
    const fake = fakeBridge()
    let current: PendingQuestion | null = question()
    fake.handle(approvalCurrent, () => current)
    const store = new SessionStore(SESSION, fake.bridge, [askingRow()])
    const detach = store.attach()
    await store.open({ resume: false })
    current = null
    fake.emit(chatEvent, {
      type: 'tool-outcome',
      sessionId: SESSION,
      callKey: ASK,
      providerToolCallId: 'toolu_ask',
      effect: 'read',
      state: 'aborted',
      source: 'unanswered',
      output: 'The user stopped before answering.',
    })
    expect(store.getSnapshot().pending).toBeNull()
    expect(fake.calls(approvalCurrent)).toHaveLength(2)
    detach()
  })

  it('a send while it waits is the typed answer: never drawn as a message, recorded as the reply', async () => {
    const fake = fakeBridge()
    let current: PendingQuestion | null = question()
    fake.handle(approvalCurrent, () => current)
    const sent = Promise.withResolvers<void>()
    fake.handle(chatSend, async () => {
      await sent.promise
      current = null
      return { accepted: true as const, status: 'answered' as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [
      row('m1', 'user', 'pick', 1),
      askingRow(),
    ])
    const detach = store.attach()
    await store.open({ resume: false })
    const sending = store.send('the blue one')
    // On its way it is not drawn: most likely it is the answer, which is no message.
    expect(store.getSnapshot().model.turns.at(-1)).toMatchObject({ answering: true })
    expect(toThreadMessages(store.getSnapshot().model).map((message) => message.id)).toEqual([
      'm1',
      'm-ask',
    ])
    sent.resolve()
    await sending
    expect(fake.calls(chatSend)).toEqual([{ sessionId: SESSION, text: 'the blue one' }])
    expect(thread(store)).toEqual(['user: pick', 'assistant: '])
    expect(store.getSnapshot().pending).toBeNull()
    expect(store.getSnapshot().asked.get(ASK)).toEqual({ answers: {}, response: 'the blue one' })
    detach()
  })

  it('a send while it waits that became a message after all is drawn once the kernel names it', async () => {
    // The question was answered elsewhere a moment before: the kernel wrote this as a message.
    const fake = fakeBridge()
    fake.handle(approvalCurrent, () => question())
    fake.handle(chatSend, () => {
      fake.emit(chatEvent, {
        type: 'user-message',
        sessionId: SESSION,
        messageId: 'm-typed',
        queuedId: null,
      })
      return { accepted: true as const, status: 'started' as const }
    })
    const store = new SessionStore(SESSION, fake.bridge, [askingRow()])
    const detach = store.attach()
    await store.open({ resume: false })
    await store.send('the blue one')
    const turn = store.getSnapshot().model.turns.at(-1)
    expect(turn).toMatchObject({ id: 'm-typed', optimistic: false })
    expect(turn?.answering).toBeUndefined()
    expect(toThreadMessages(store.getSnapshot().model).map((message) => message.id)).toEqual([
      'm-ask',
      'm-typed',
    ])
    expect(store.getSnapshot().asked.size).toBe(0)
    detach()
  })

  it('a send with no question waiting is drawn at once, as ever', async () => {
    const fake = fakeBridge()
    const store = new SessionStore(SESSION, fake.bridge, [])
    await store.open({ resume: false })
    void store.send('hello')
    expect(store.getSnapshot().model.turns.at(-1)?.answering).toBeUndefined()
    expect(toThreadMessages(store.getSnapshot().model)).toHaveLength(1)
    await settle()
  })
})
