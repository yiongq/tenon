/**
 * The thread model fed by the real kernel (spec 02 plan step 20: live and restart go through the same
 * path; §界面范围「调用的键与读写的数据」, `TurnSummaryLine`, §失败卡与结束原因, §重试与「继续」,
 * §插话与输入框状态表).
 *
 * A scripted provider drives the real session service; its loop events become `chat.event`s through
 * the desktop's own mapping (run-events.ts), and the renderer's `applyEvent` folds them as a window
 * would. The same session is then read back the way a window opens on it (`listMessages` →
 * `projectedRow` → `threadFromRows`): what the user saw live must be what they see after a restart,
 * call keys and outcomes included — an answered card's `approval` too, except on the one closure
 * whose live event does not carry it. Which message 「重试」 resends is the kernel's own answer on the
 * terminal event (`retryOf`), checked here against the message the Run's user-message named.
 */
import { chatEventSchema, messageRowSchema } from '@tenon-app/contracts'
import type { ChatEvent, ToolOutcomeViewContract } from '@tenon-app/contracts'
import { createMemoryHost, createMemoryTapeStore } from '@tenon-app/kernel'
import type {
  HostAdapter,
  McpConnection,
  MemoryHost,
  McpToolSource,
  ModelInfo,
  SendResult,
  SessionEvent,
  SessionService,
  StopReason,
  StreamEvent,
  Usage,
} from '@tenon-app/kernel'
import {
  createCounterIds,
  createFakeInspector,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '@tenon-app/kernel/testing'
import type { FakeInspector, ScriptedProvider, TestLoopPorts } from '@tenon-app/kernel/testing'
import { describe, expect, it } from 'vitest'
import { createRunEvents } from '../src/main/run-events.js'
import { projectedRow } from '../src/main/session.js'
import { cardOf } from '../src/renderer/src/lib/end-card.js'
import {
  EMPTY_THREAD,
  applyEvent,
  retryable,
  summaryBefore,
  threadFromRows,
  withSentText,
  withoutTurn,
} from '../src/renderer/src/runtime/thread-model.js'
import type { ThreadModel, Turn } from '../src/renderer/src/runtime/thread-model.js'

const IDENTITY = { userId: 'thread-user', tenantId: 'thread-tenant', profileDir: '/tenon/thread' }
const SESSION = '3e1c9a2e-6b3d-4a71-9f52-0c8de7a11b39'
/** The connector tool every batch calls, under its provider name. */
const LOOK = 'fs__look'

const MODEL: ModelInfo = {
  id: 'claude-thread-1',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}

const USAGE: Usage = {
  inputTokens: 9,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

const ASK = { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] } as const

/** A host whose timers fire at once: a backoff between resends is not waited for. */
function instantHost(host: MemoryHost): HostAdapter {
  let clock = 1_000
  return {
    ...host,
    clock: {
      now: (): number => (clock += 1),
      setTimeout: (fn, _ms): (() => void) => {
        let pending = true
        void Promise.resolve().then(() => {
          if (pending) fn()
        })
        return () => {
          pending = false
        }
      },
    },
  }
}

/** The `fs` server's one tool; `during` runs while a call is in flight, with the call's `at`. */
function lookSource(during?: (at: string) => void): McpToolSource {
  const connection = {
    listTools: () => Promise.resolve([{ name: 'look', inputSchema: { type: 'object' } }]),
    callTool: (_name: string, args: Record<string, unknown>) => {
      during?.(String(args['at']))
      return Promise.resolve({
        content: [{ type: 'text', text: `looked at ${String(args['at'])}` }],
        isError: false,
      })
    },
  } as unknown as McpConnection
  return { serverId: 'fs', connection }
}

interface Live {
  /** The host's memory half: where a case changes the policy. */
  readonly memory: MemoryHost
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  readonly inspector: FakeInspector
  /** Every `chat.event` the renderer got, in order. */
  readonly chat: ChatEvent[]
  /** The Run `run.state` names now (the latest `run-started`). */
  readonly current: () => string | null
}

interface LiveOptions {
  /** Runs while a call is in flight: where a case sends while the Run is busy. */
  readonly during?: (self: Live, at: string) => void
  /**
   * With an ask inspector, on a clock that never moves on its own (an instant clock would run out
   * the inspector's time limit at once). Without one, on an instant clock: resends are not waited for.
   */
  readonly asks?: boolean
}

function live(o: LiveOptions = {}): Live {
  const chat: ChatEvent[] = []
  let runId: string | null = null
  const toChat = createRunEvents({
    send: (channel, payload) => {
      if (channel === 'chat.event') chat.push(chatEventSchema.parse(payload))
    },
    onRunStarted: (_root, id) => {
      runId = id
    },
    onHeld: () => {},
    log: () => {},
  })
  const provider = createScriptedProvider({ models: [MODEL] })
  // Says nothing unless a case makes it ask: then the call waits on a card.
  const inspector = createFakeInspector({ id: 'asker', ceiling: 'ask', answer: { kind: 'none' } })
  let self: Live | undefined
  const loop = createTestLoopPorts({
    connector: {
      provider,
      model: MODEL,
      mcpSources: [lookSource((at) => (self === undefined ? undefined : o.during?.(self, at)))],
    },
    onEvent: (event: SessionEvent) => toChat(event),
  })
  const memory = createMemoryHost()
  const service = createTestSessionService(
    {
      host: o.asks === true ? memory : instantHost(memory),
      tape: createMemoryTapeStore({ identity: IDENTITY }),
      ids: createCounterIds(),
      inspectors: o.asks === true ? [inspector.registration] : [],
      connector: loop.connector,
      protectedFiles: [],
    },
    // The user set the connector tool to always-allow: without an inspector asking, it runs.
    { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }) },
  )
  service.bindLoop(loop)
  self = { memory, service, loop, provider, inspector, chat, current: () => runId }
  return self
}

/**
 * The renderer's half: the optimistic turn a send shows at once, then every `chat.event` not yet
 * folded, in order. `queued` stands in for the texts `chat.queue` delivered.
 */
class Window {
  model: ThreadModel = EMPTY_THREAD
  readonly queued = new Map<string, string>()
  readonly #live: Live
  #folded = 0
  #now = 0
  #ids = 0

  constructor(h: Live) {
    this.#live = h
  }

  /** A send that opens a Run; resolves once that Run has ended, with its id. */
  async send(text: string): Promise<string> {
    this.show(text)
    const sent = await this.#live.service.send({ sessionId: SESSION, origin: null, text })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    await this.#live.loop.runEnded({ runId: sent.runId })
    this.fold()
    return sent.runId
  }

  /** The echo a send shows at once; its id. */
  show(text: string): string {
    const id = this.#id()
    this.model = withSentText(this.model, text, id, (this.#now += 1))
    return id
  }

  /**
   * A send made while the Run is busy (from inside a call): the echo at once; once the kernel has
   * queued it, what the store does when `chat.queue` lists it — the echo goes, the queued bubble
   * stands for it, and its text is kept for the `user-message` that inserts it.
   */
  sendBusy(text: string, send: () => Promise<SendResult>): Promise<SendResult> {
    const echo = this.show(text)
    return send().then((sent) => {
      if (sent.status !== 'queued') throw new Error(`busy send answered ${JSON.stringify(sent)}`)
      this.fold()
      this.model = withoutTurn(this.model, echo)
      this.queued.set(sent.queuedId, text)
      return sent
    })
  }

  fold(): ThreadModel {
    for (const event of this.#live.chat.slice(this.#folded)) {
      this.model = applyEvent(this.model, event, {
        now: (this.#now += 1),
        nextId: () => this.#id(),
        queuedText: (queuedId) => this.queued.get(queuedId),
      })
    }
    this.#folded = this.#live.chat.length
    return this.model
  }

  #id(): string {
    return `local-${String((this.#ids += 1))}`
  }
}

/** The session as a window opens on it after a restart. */
async function restored(h: Live): Promise<ThreadModel> {
  const rows = await h.service.listMessages({ sessionId: SESSION, limit: 50 })
  return threadFromRows(rows.map((row) => messageRowSchema.parse(projectedRow(row))))
}

/**
 * What the user reads, turn by turn: the role, each part, and a user turn's id (both sides have the
 * Tape's). Left out, none of which a redraw has: a live assistant turn's local id, its Run id and
 * number, its end, a call's Run number, a thinking block's timing; the empty turn a Run that wrote
 * nothing gets live only to carry its end (the Tape has no row for it). `approval` is compared too —
 * every closure an answer, a new message or a stop writes carries it live — except on the calls in
 * `answeredLive`: an allowed call runs in the answer's Run, whose `tool-outcome` is the execution's,
 * and live its collapsed row comes from the card the window answered (§最小审批卡「答完」: live the
 * collapse uses the card's data, a redraw reads `calls[i].outcome.approval`).
 */
function seen(model: ThreadModel, answeredLive: ReadonlySet<string> = new Set()): unknown[] {
  return model.turns
    .filter(
      (turn) => !(turn.role === 'assistant' && turn.parts.length === 0 && turn.end !== undefined),
    )
    .map((turn) => ({
      role: turn.role,
      id: turn.role === 'user' ? turn.id : null,
      parts: turn.parts.map((part) => {
        if (part.kind === 'thinking') return { kind: 'thinking', text: part.text }
        if (part.kind === 'text') return part
        return {
          kind: part.kind,
          callKey: part.callKey,
          name: part.name,
          input: part.input,
          outcome:
            part.outcome === null
              ? null
              : answeredLive.has(part.callKey)
                ? withoutApproval(part.outcome)
                : part.outcome,
        }
      }),
    }))
}

function withoutApproval(
  outcome: ToolOutcomeViewContract,
): Omit<ToolOutcomeViewContract, 'approval'> {
  const { approval: _approval, ...closed } = outcome
  return closed
}

/** The `approval` each call's outcome carries, in order (undefined where it has none). */
function approvals(model: ThreadModel): unknown[] {
  return model.turns.flatMap((turn) =>
    turn.parts.flatMap((part) => (part.kind === 'tool' ? [part.outcome?.approval] : [])),
  )
}

/** A reply asking for these `fs__look` calls, after a thinking block and a text. */
function callTurn(
  ats: readonly string[],
  o: { readonly text?: string; readonly thinking?: string; readonly stop?: StopReason } = {},
): StreamEvent[] {
  const events: StreamEvent[] = []
  if (o.thinking !== undefined) {
    events.push(
      { type: 'thinking-delta', index: 0, text: o.thinking },
      { type: 'thinking-signature', index: 0, signature: 'sig' },
    )
  }
  if (o.text !== undefined) events.push({ type: 'text-delta', index: 1, text: o.text })
  ats.forEach((at, i) => {
    const index = i + 2
    const id = `toolu_${at}`
    events.push(
      { type: 'tool-call-start', index, id, name: LOOK },
      { type: 'tool-call-args-delta', index, json: JSON.stringify({ at }) },
      { type: 'tool-call-end', index, id, name: LOOK, input: { at } },
    )
  })
  const stop = o.stop ?? 'tool-use'
  events.push(
    { type: 'usage', usage: USAGE },
    stopEvent(stop, stop === 'tool-use' ? 'tool_use' : 'max_tokens'),
  )
  return events
}

const reply = (...deltas: readonly string[]): StreamEvent[] =>
  scriptedTurn({ deltas, usage: USAGE })

function failure(
  code: Extract<StreamEvent, { type: 'error' }>['code'],
  o: { readonly retryable?: boolean; readonly deltas?: readonly string[] } = {},
): StreamEvent[] {
  return scriptedTurn({
    deltas: o.deltas ?? [],
    usage: USAGE,
    terminal: {
      type: 'error',
      code,
      retryable: o.retryable ?? false,
      providerCode: null,
      detail: `a scripted ${code}`,
    },
  })
}

function callKeys(model: ThreadModel): string[] {
  return model.turns.flatMap((turn) =>
    turn.parts.flatMap((part) => (part.kind === 'tool' ? [part.callKey] : [])),
  )
}

/** The index of the turn that carries the latest Run's end. */
function lastEnded(turns: readonly Turn[]): number {
  return turns.findLastIndex((turn) => turn.end !== undefined)
}

describe('the live thread against the redraw', () => {
  it('a batch and the next request: same turns, same call keys, same outcomes', async () => {
    const h = live()
    const w = new Window(h)
    h.provider.script(callTurn(['a', 'b'], { thinking: 'Plan it.', text: 'Looking.' }))
    h.provider.script(reply('Both ', 'fine.'))
    await w.send('look at a and b')
    const redraw = await restored(h)
    expect(seen(w.model)).toEqual(seen(redraw))
    expect(w.model.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'assistant'])
    // The kernel's own keys, not the renderer's fallback `<messageId>:<vendor id>`.
    const keys = callKeys(redraw)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
    expect(callKeys(w.model)).toEqual(keys)
    for (const key of keys) expect(key).not.toMatch(/:toolu_/)
    const outcomes = w.model.turns[1]?.parts.map((part) =>
      part.kind === 'tool' ? [part.outcome?.effect, part.outcome?.state] : part.kind,
    )
    expect(outcomes).toEqual([
      'thinking',
      'text',
      ['external', 'completed'],
      ['external', 'completed'],
    ])
    // The live thinking block was timed; the redrawn one cannot be.
    const timed = w.model.turns[1]?.parts[0]
    expect(timed?.kind === 'thinking' ? timed.startedAt : null).not.toBeNull()
    const replayed = redraw.turns[1]?.parts[0]
    expect(replayed?.kind === 'thinking' ? replayed.startedAt : 'x').toBeNull()
  })

  it('the end: completed, on the Run’s last turn, naming the Run, counting the round’s calls', async () => {
    const h = live()
    const w = new Window(h)
    h.provider.script(callTurn(['a'], { text: 'Looking.' }))
    h.provider.script(reply('Done.'))
    const runId = await w.send('look at a')
    const index = lastEnded(w.model.turns)
    expect(index).toBe(w.model.turns.length - 1)
    // The Run dispatched its call: the kernel names no message for 「重试」.
    expect(w.model.turns[index]?.end).toEqual({
      runId,
      endReason: { code: 'completed' },
      errorCode: null,
      retryOf: null,
    })
    expect(summaryBefore(w.model.turns, index)).toEqual({ read: 0, write: 0, external: 1 })
    expect(retryable(w.model.turns, index)).toBe(false)
  })

  it('attempt-discarded: the failed attempt’s text is gone, and the resend’s is all there is', async () => {
    const h = live()
    const w = new Window(h)
    h.provider.script(failure('overloaded', { retryable: true, deltas: ['half an ', 'answer'] }))
    h.provider.script(reply('the whole answer'))
    await w.send('answer me')
    expect(h.chat.map((event) => event.type)).toContain('attempt-discarded')
    expect(seen(w.model)).toEqual(seen(await restored(h)))
    expect(w.model.turns[1]?.parts).toEqual([{ kind: 'text', text: 'the whole answer' }])
  })

  it('a message queued during a batch goes in after its results, and the next reply is below it', async () => {
    let queued: Promise<SendResult> | undefined
    const h = live({
      during: (self) => {
        queued ??= w.sendBusy('also check b', () =>
          self.service.send({ sessionId: SESSION, origin: null, text: 'also check b' }),
        )
      },
    })
    const w = new Window(h)
    h.provider.script(callTurn(['a'], { text: 'Checking a.' }))
    h.provider.script(reply('Checked both.'))
    await w.send('check a')
    expect(await queued).toMatchObject({ status: 'queued' })
    w.fold()
    const redraw = await restored(h)
    expect(redraw.turns.map((turn) => turn.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(seen(w.model)).toEqual(seen(redraw))
    // Inserted mid-Run, after a dispatched call: neither message is the Run's to resend.
    expect(w.model.turns.at(-1)?.end?.retryOf).toBeNull()
  })
})

describe('the round, the end card and 「重试」 on the real kernel', () => {
  it('旧 222: a round with an approval in the middle shows one summary, over both Runs', async () => {
    const h = live({ asks: true })
    const w = new Window(h)
    h.inspector.answer(ASK)
    h.provider.script(callTurn(['a'], { text: 'First a.' }))
    await w.send('look at a, then b')
    const paused = lastEnded(w.model.turns)
    expect(w.model.turns[paused]?.end?.endReason).toEqual({
      code: 'paused',
      waitingFor: 'approval',
    })
    const card = await h.service.currentPending({ sessionId: SESSION })
    if (card?.waitKind !== 'approval') throw new Error('no card')
    h.inspector.answer({ kind: 'none' })
    h.provider.script(callTurn(['b'], { text: 'Now b.' }))
    h.provider.script(reply('Both looked at.'))
    const answered = await h.service.answer({
      kind: 'approval',
      sessionId: SESSION,
      requestId: card.card.requestId,
      decision: 'allow',
      origin: null,
    })
    expect(answered).toMatchObject({ status: 'applied' })
    await h.loop.runEnded()
    w.fold()
    const redraw = await restored(h)
    // The allowed call ran in the answer's Run: live, its collapse is the store's (session-store).
    expect(seen(w.model, new Set([card.callKey]))).toEqual(seen(redraw, new Set([card.callKey])))
    // 旧 214: the answered card's row redraws its collapse from the Tape; live, the store holds it.
    expect(approvals(redraw)).toEqual([
      {
        outcome: 'allowed',
        scope: 'once',
        target: { type: 'tool', serverId: 'fs', toolName: 'look' },
      },
      undefined,
    ])
    const last = lastEnded(w.model.turns)
    expect(w.model.turns[last]?.end?.endReason).toEqual({ code: 'completed' })
    // Two Runs, one round: the count covers both, and the paused Run's turn keeps its own end.
    expect(summaryBefore(w.model.turns, last)).toEqual({ read: 0, write: 0, external: 2 })
    expect(summaryBefore(w.model.turns, paused)).toBeNull()
    expect(w.model.turns[paused]?.end?.endReason?.code).toBe('paused')
    expect(new Set(w.model.turns.flatMap((turn) => turn.end?.runId ?? [])).size).toBe(2)
    // The answer opened the second Run, not a user message; the first wrote its reply (the call)
    // after the message, so neither is 「重试」's to resend.
    expect(w.model.turns[last]?.end?.retryOf).toBeNull()
    expect(w.model.turns[paused]?.end?.retryOf).toBeNull()
  })

  it('a provider error on the user’s own Run, before any call: 「重试」', async () => {
    const h = live()
    const w = new Window(h)
    h.provider.script(failure('server'))
    await w.send('try this')
    const index = lastEnded(w.model.turns)
    const end = w.model.turns[index]?.end
    expect(end?.endReason).toMatchObject({ code: 'provider-error', errorCode: 'server' })
    // The message the user sent, by the id its user-message gave it.
    expect(w.model.turns[0]).toMatchObject({ role: 'user', optimistic: false })
    expect(end?.retryOf).toBe(w.model.turns[0]?.id)
    expect(retryable(w.model.turns, index)).toBe(true)
    if (end?.endReason == null) throw new Error('no end reason')
    expect(cardOf(end.endReason, retryable(w.model.turns, index))).toEqual({
      visual: 'danger',
      action: 'retry',
    })
  })

  it('「重试」 resends the same message: the kernel writes no new one, and the echo goes', async () => {
    // 01 spec.md:395: the same text as the last message is a resend of it, the append a no-op.
    const h = live()
    const w = new Window(h)
    h.provider.script(failure('server'))
    await w.send('try this')
    const user = w.model.turns[0]?.id
    h.provider.script(reply('Now it works.'))
    const second = await w.send('try this')
    const resent = h.chat.filter((event) => event.type === 'user-message')
    expect(resent.map((event) => (event.type === 'user-message' ? event.messageId : null))).toEqual(
      [user, user],
    )
    expect(w.model.turns.filter((turn) => turn.role === 'user')).toHaveLength(1)
    expect(w.model.turns.some((turn) => turn.optimistic === true)).toBe(false)
    // The failed Run keeps its card on a turn of its own; the resend's reply is below it.
    expect(w.model.turns.map((turn) => [turn.role, turn.end?.endReason?.code ?? null])).toEqual([
      ['user', null],
      ['assistant', 'provider-error'],
      ['assistant', 'completed'],
    ])
    expect(seen(w.model)).toEqual(seen(await restored(h)))
    const index = lastEnded(w.model.turns)
    // The resend's own Run wrote its reply: nothing left to resend.
    expect(w.model.turns[index]?.end).toMatchObject({ runId: second, retryOf: null })
  })

  it('a provider error after a call was dispatched: copy, not 「重试」', async () => {
    const h = live()
    const w = new Window(h)
    h.provider.script(callTurn(['a'], { text: 'Looking.' }))
    h.provider.script(failure('server'))
    await w.send('look, then fail')
    const index = lastEnded(w.model.turns)
    const end = w.model.turns[index]?.end
    expect(end?.endReason?.code).toBe('provider-error')
    expect(end?.retryOf).toBeNull()
    expect(retryable(w.model.turns, index)).toBe(false)
    if (end?.endReason == null) throw new Error('no end reason')
    expect(cardOf(end.endReason, false)).toEqual({ visual: 'danger', action: 'copy' })
  })

  it('an auth failure: 「去设置」, whatever else holds', async () => {
    const h = live()
    const w = new Window(h)
    h.provider.script(failure('auth'))
    await w.send('hello')
    const index = lastEnded(w.model.turns)
    const reason = w.model.turns[index]?.end?.endReason
    expect(reason).toMatchObject({ code: 'provider-error', errorCode: 'auth' })
    if (reason == null) throw new Error('no end reason')
    expect(cardOf(reason, retryable(w.model.turns, index))).toEqual({
      visual: 'danger',
      action: 'settings',
    })
  })

  it('a truncated reply offers 「继续」, and the continued Run completes below it', async () => {
    const h = live()
    const w = new Window(h)
    h.provider.script(callTurn([], { text: 'Starting.', stop: 'max-tokens' }))
    await w.send('write it all')
    const truncated = lastEnded(w.model.turns)
    const reason = w.model.turns[truncated]?.end?.endReason
    expect(reason).toEqual({ code: 'output-truncated', maxTokens: MODEL.maxOutputTokens })
    if (reason == null) throw new Error('no end reason')
    expect(cardOf(reason, retryable(w.model.turns, truncated))).toEqual({
      visual: 'neutral',
      action: 'continue',
    })
    h.provider.script(reply('…and the rest.'))
    expect(await h.service.continueRun({ sessionId: SESSION, origin: null })).toEqual({
      status: 'started',
    })
    await h.loop.runEnded()
    w.fold()
    expect(seen(w.model)).toEqual(seen(await restored(h)))
    expect(w.model.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(w.model.turns[truncated]?.end?.endReason?.code).toBe('output-truncated')
    // The truncated Run wrote its partial reply after the message; the continued one is 「继续」's.
    expect(w.model.turns[truncated]?.end?.retryOf).toBeNull()
    expect(w.model.turns.at(-1)?.end?.retryOf).toBeNull()
  })

  it('a provider error on the Run 「继续」 opened: copy, not 「重试」', async () => {
    const h = live()
    const w = new Window(h)
    h.provider.script(callTurn([], { text: 'Starting.', stop: 'max-tokens' }))
    const first = await w.send('write it all')
    h.provider.script(failure('server'))
    expect(await h.service.continueRun({ sessionId: SESSION, origin: null })).toEqual({
      status: 'started',
    })
    await h.loop.runEnded()
    w.fold()
    const index = lastEnded(w.model.turns)
    const reason = w.model.turns[index]?.end?.endReason
    expect(reason).toMatchObject({ code: 'provider-error', errorCode: 'server' })
    expect(retryable(w.model.turns, index)).toBe(false)
    if (reason == null) throw new Error('no end reason')
    expect(cardOf(reason, retryable(w.model.turns, index))).toEqual({
      visual: 'danger',
      action: 'copy',
    })
    // The truncated Run's end is still its own, on its own turn.
    const truncated = w.model.turns.findIndex((turn) => turn.end !== undefined)
    expect(truncated).toBeLessThan(index)
    expect(w.model.turns[truncated]?.end).toMatchObject({
      runId: first,
      endReason: { code: 'output-truncated' },
    })
  })

  it('a message queued during the 「继续」 Run goes in mid-Run: that Run still gets no 「重试」', async () => {
    let queued: Promise<SendResult> | undefined
    const h = live({
      during: (self) => {
        queued ??= w.sendBusy('and b too', () =>
          self.service.send({ sessionId: SESSION, origin: null, text: 'and b too' }),
        )
      },
    })
    const w = new Window(h)
    h.provider.script(callTurn([], { text: 'Starting.', stop: 'max-tokens' }))
    await w.send('write it all')
    h.provider.script(callTurn(['a'], { text: 'Looking at a.' }))
    h.provider.script(failure('server'))
    expect(await h.service.continueRun({ sessionId: SESSION, origin: null })).toEqual({
      status: 'started',
    })
    await h.loop.runEnded()
    expect(await queued).toMatchObject({ status: 'queued' })
    w.fold()
    expect(seen(w.model)).toEqual(seen(await restored(h)))
    // The request after the inserted message failed: the Run wrote nothing below it, so its end
    // hangs on its own last turn, above the message.
    expect(w.model.turns.map((turn) => turn.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'user',
    ])
    const index = lastEnded(w.model.turns)
    expect(index).toBe(2)
    expect(w.model.turns[index]?.end?.endReason?.code).toBe('provider-error')
    expect(w.model.turns[index]?.end?.retryOf).toBeNull()
    expect(retryable(w.model.turns, index)).toBe(false)
  })

  it('send-now stops the Run the user saw; the message then opens a Run of its own', async () => {
    // §插话与输入框状态表「立即发送」: `user-stopped`, then this message goes out as the next one.
    let urgent: Promise<SendResult> | undefined
    const h = live({
      during: (self) => {
        const runId = self.current()
        if (runId === null) throw new Error('no Run in flight')
        urgent ??= w.sendBusy('stop, do this', () =>
          self.service.send({
            sessionId: SESSION,
            origin: null,
            text: 'stop, do this',
            urgent: { runId },
          }),
        )
      },
    })
    const w = new Window(h)
    h.provider.script(callTurn(['a'], { text: 'Looking.' }))
    h.provider.script(failure('server'))
    const stoppedRun = await w.send('look at a')
    expect(await urgent).toMatchObject({ status: 'queued' })
    await h.loop.runEnded()
    w.fold()
    expect(seen(w.model)).toEqual(seen(await restored(h)))
    const ends = w.model.turns.flatMap((turn) => (turn.end === undefined ? [] : [turn.end]))
    // The stopped Run dispatched its call; the message's own Run dispatched nothing, and the kernel
    // names that message — the one the queued bubble went in as.
    const urgentTurn = w.model.turns.find(
      (turn) =>
        turn.role === 'user' &&
        turn.parts[0]?.kind === 'text' &&
        turn.parts[0].text === 'stop, do this',
    )
    expect(urgentTurn?.optimistic).not.toBe(true)
    expect(ends.map((end) => [end.runId === stoppedRun, end.endReason?.code, end.retryOf])).toEqual(
      [
        [true, 'user-stopped', null],
        [false, 'provider-error', urgentTurn?.id],
      ],
    )
    expect(retryable(w.model.turns, lastEnded(w.model.turns))).toBe(true)
  })

  // Once a step-20 bug, fixed in round 3: the Run an answer opens runs the approved call, then inserts the message
  // that queued before the pause ahead of its first request, so a user-message comes before any of
  // its content — the renderer read that as the Run's opener. The kernel now says (retryOf null).
  // §失败卡与结束原因: a Run an answer opened, or one that already dispatched a tool, gets copy only.
  it('a provider error on the answer’s Run, after a queued message went in: copy, not 「重试」', async () => {
    let queued: Promise<SendResult> | undefined
    const h = live({
      asks: true,
      during: (self, at) => {
        if (at !== 'a') return
        queued ??= w.sendBusy('then c', () =>
          self.service.send({ sessionId: SESSION, origin: null, text: 'then c' }),
        )
      },
    })
    const w = new Window(h)
    // `a` runs (and the message queues while it does); `b` waits on a card.
    h.inspector.answer(({ call }) => (call.args['at'] === 'b' ? ASK : { kind: 'none' }))
    h.provider.script(callTurn(['a', 'b'], { text: 'Both.' }))
    await w.send('look at a and b')
    expect(await queued).toMatchObject({ status: 'queued' })
    w.fold()
    expect(w.model.turns[lastEnded(w.model.turns)]?.end?.endReason?.code).toBe('paused')
    const card = await h.service.currentPending({ sessionId: SESSION })
    if (card?.waitKind !== 'approval') throw new Error('no card')
    h.provider.script(failure('server'))
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: card.card.requestId,
        decision: 'allow',
        origin: null,
      }),
    ).toMatchObject({ status: 'applied' })
    await h.loop.runEnded()
    w.fold()
    const types = h.chat.map((event) => event.type)
    const resumedAt = types.lastIndexOf('done') + 1
    expect(types.slice(resumedAt)).toEqual([
      'tool-outcome',
      'user-message',
      'attempt-discarded',
      'error',
    ])
    // `b` ran in the answer's Run: live, its collapse is the store's.
    const answered = new Set([card.callKey])
    expect(seen(w.model, answered)).toEqual(seen(await restored(h), answered))
    const index = lastEnded(w.model.turns)
    expect(w.model.turns[index]?.end?.endReason?.code).toBe('provider-error')
    expect(w.model.turns[index]?.end?.retryOf).toBeNull()
    expect(retryable(w.model.turns, index)).toBe(false)
    if (w.model.turns[index]?.end?.endReason == null) throw new Error('no end reason')
    expect(cardOf(w.model.turns[index].end.endReason, retryable(w.model.turns, index))).toEqual({
      visual: 'danger',
      action: 'copy',
    })
  })
})

describe('a card closed without running: the row live as after a restart (§最小审批卡「答完」)', () => {
  /** `a` waits on a card with `b` behind it in the same batch; the card is returned. */
  async function pausedOnA(): Promise<{ h: Live; w: Window; callKey: string }> {
    const h = live({ asks: true })
    const w = new Window(h)
    h.inspector.answer(ASK)
    h.provider.script(callTurn(['a', 'b'], { text: 'Both.' }))
    await w.send('look at a and b')
    const pending = await h.service.currentPending({ sessionId: SESSION })
    if (pending?.waitKind !== 'approval') throw new Error('no card')
    h.inspector.answer({ kind: 'none' })
    return { h, w, callKey: pending.callKey }
  }

  const TARGET = { type: 'tool', serverId: 'fs', toolName: 'look' }

  async function answer(h: Live, decision: 'allow' | 'deny'): Promise<void> {
    const pending = await h.service.currentPending({ sessionId: SESSION })
    if (pending?.waitKind !== 'approval') throw new Error('no card')
    const answered = await h.service.answer({
      kind: 'approval',
      sessionId: SESSION,
      requestId: pending.card.requestId,
      decision,
      origin: null,
    })
    expect(answered).toMatchObject({ status: 'applied' })
    await h.loop.runEnded()
  }

  it('a denial: the denied row carries its answer live, and the call behind it is not run', async () => {
    const { h, w, callKey } = await pausedOnA()
    await answer(h, 'deny')
    w.fold()
    const redraw = await restored(h)
    expect(seen(w.model)).toEqual(seen(redraw))
    expect(approvals(w.model)).toEqual([
      { outcome: 'denied', scope: null, target: TARGET },
      undefined,
    ])
    const denied = w.model.turns[1]?.parts.find(
      (part) => part.kind === 'tool' && part.callKey === callKey,
    )
    expect(denied?.kind === 'tool' ? denied.outcome : null).toMatchObject({
      state: 'not-run',
      source: 'user-rejected',
      permission: { verdict: 'ask' },
    })
    expect(w.model.turns[lastEnded(w.model.turns)]?.end).toMatchObject({
      endReason: { code: 'user-rejected' },
      retryOf: null,
    })
  })

  it('a new message supersedes the card: the closure reads superseded live, then the new Run', async () => {
    const { h, w } = await pausedOnA()
    h.provider.script(reply('Doing that instead.'))
    await w.send('never mind, do this')
    const redraw = await restored(h)
    expect(seen(w.model)).toEqual(seen(redraw))
    expect(approvals(w.model)).toEqual([
      { outcome: 'superseded', scope: null, target: TARGET },
      undefined,
    ])
    // The new message's Run dispatched nothing, but its reply follows the message.
    expect(w.model.turns.at(-1)?.end).toMatchObject({
      endReason: { code: 'completed' },
      retryOf: null,
    })
  })

  it('a stop cancels the card: the closure reads cancelled-by-stop live', async () => {
    const { h, w } = await pausedOnA()
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    w.fold()
    expect(seen(w.model)).toEqual(seen(await restored(h)))
    expect(approvals(w.model)).toEqual([
      { outcome: 'cancelled-by-stop', scope: null, target: TARGET },
      undefined,
    ])
  })

  it('an allow the re-judgement denied: a BlockedNotice’s facts and decision, live as redrawn', async () => {
    const { h, w, callKey } = await pausedOnA()
    h.memory.setPolicy({
      status: 'current',
      version: 'v2',
      snapshot: { tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'deny' }] },
    })
    h.provider.script(reply('Blocked, then.'))
    await answer(h, 'allow')
    w.fold()
    const redraw = await restored(h)
    // The live closure of the re-judged call has no `approval` (kernel calls.test.ts, BUG(step20)
    // there); ToolRow draws no collapsed row for `denied-on-rejudge`, so nothing on screen differs.
    const rejudged = new Set([callKey])
    expect(seen(w.model, rejudged)).toEqual(seen(redraw, rejudged))
    const row = w.model.turns[1]?.parts.find(
      (part) => part.kind === 'tool' && part.callKey === callKey,
    )
    expect(row?.kind === 'tool' ? row.outcome : null).toMatchObject({
      state: 'not-run',
      source: 'policy',
      facts: { toolName: 'look' },
      permission: { verdict: 'deny' },
    })
  })
})
