/**
 * 「重试」's message on `run-ended` (spec 02 §失败卡与结束原因, the `provider-error` row: 「这个 Run 由
 * 用户消息触发，而且还没有任何 `dispatch_committed`」; §主进程与 kernel 的循环接口 `run-ended.retryOf`;
 * plan step 20): the kernel names the user message that opened the Run — its `run_started` cause —
 * when none of the Run's calls got a `dispatch_committed`, and null for every other Run (one an answer,
 * 「继续」 or a resume opened) and for every end that opened no Run. The renderer offers 「重试」 on
 * this alone and resends the message it names.
 *
 * All real: the mailbox, its leases and queue, the Runs, the scripted provider. Each answer is checked
 * against the Tape the Run wrote — its cause, and its dispatches — not against the event order the
 * renderer used to infer it from, which is exactly what several cases here (a queued message inserted
 * before an answer's or a resume's first request) would mislead.
 */
import { describe, expect, it } from 'vitest'
import {
  ProviderConfigMissingError,
  createMemoryHost,
  createMemoryTapeStore,
} from '../../src/index.js'
import type {
  MemoryHost,
  ModelInfo,
  RunStartedPayload,
  SendResult,
  SessionEvent,
  SessionService,
  StreamEvent,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import {
  createCounterIds,
  createFakeInspector,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type { FakeInspector, ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'
import { LOOK, lookSource } from './support.js'

const IDENTITY = { userId: 'retry-user', tenantId: 'retry-tenant', profileDir: '/tenon/retry' }
const SESSION = '6c3e9a2e-6b3d-4a71-9f52-0c8de7a11d02'

const MODEL: ModelInfo = {
  id: 'claude-retry-1',
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
  inputTokens: 7,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

const ASK = { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] } as const
const DENY_LOOK = {
  status: 'current',
  version: 'v2',
  snapshot: { tools: [{ policyId: 'p1', serverId: 'fs', toolName: 'look', effect: 'deny' }] },
} as const

type RunEnded = Extract<SessionEvent, { type: 'run-ended' }>

interface Harness {
  readonly memory: MemoryHost
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  readonly inspector: FakeInspector
}

interface HarnessOptions {
  readonly store?: TapeStore
  readonly idsFrom?: number
  /** Runs while a `look` call is in flight, with its `at`: where a case sends while the Run is busy. */
  readonly during?: (h: Harness, at: string) => void | Promise<void>
  /** Called with every loop event as it is recorded. */
  readonly onEvent?: (h: Harness, event: SessionEvent) => void
}

function harness(o: HarnessOptions = {}): Harness {
  const memory = createMemoryHost({ identity: IDENTITY })
  const store = o.store ?? createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  // Says nothing unless a case makes it ask: then the call waits on a card.
  const inspector = createFakeInspector({ id: 'asker', ceiling: 'ask', answer: { kind: 'none' } })
  let self: Harness | null = null
  const loop = createTestLoopPorts({
    connector: {
      provider,
      model: MODEL,
      mcpSources: [
        lookSource([], (args) =>
          self === null ? undefined : o.during?.(self, String(args['at'])),
        ),
      ],
    },
    onEvent: (event) => {
      if (self !== null) o.onEvent?.(self, event)
    },
  })
  const service = createTestSessionService(
    {
      host: memory,
      tape: store,
      ids: createCounterIds({ start: o.idsFrom ?? 1 }),
      inspectors: [inspector.registration],
      connector: loop.connector,
      protectedFiles: [],
    },
    // `look` is always-allowed by the user: without the inspector's opinion it runs.
    { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }) },
  )
  service.bindLoop(loop)
  self = { memory, store, service, loop, provider, inspector }
  return self
}

type Call = { readonly name: string; readonly input: Record<string, unknown> }

const look = (at: string): Call => ({ name: LOOK, input: { at } })
/** The chat profile's Read of a file that is not its own spill: blocked `protected`, never dispatched. */
const protectedRead: Call = { name: 'Read', input: { file_path: '/etc/passwd' } }

/** One reply asking for these calls, in order. */
function calls(...asked: readonly Call[]): StreamEvent[] {
  const events: StreamEvent[] = []
  asked.forEach((call, i) => {
    const id = `toolu_${String(i)}_${call.name}`
    events.push(
      { type: 'tool-call-start', index: i + 1, id, name: call.name },
      { type: 'tool-call-end', index: i + 1, id, name: call.name, input: call.input },
    )
  })
  events.push({ type: 'usage', usage: USAGE }, stopEvent('tool-use', 'tool_use'))
  return events
}

const done = (): StreamEvent[] => scriptedTurn({ deltas: ['Done.'], usage: USAGE })

const truncated = (): StreamEvent[] => [
  { type: 'text-delta', index: 0, text: 'Starting.' },
  { type: 'usage', usage: USAGE },
  stopEvent('max-tokens', 'max_tokens'),
]

/** A request that fails outright, not retried: the Run ends `provider-error`. */
const failure = (): StreamEvent[] =>
  scriptedTurn({
    deltas: [],
    usage: USAGE,
    terminal: {
      type: 'error',
      code: 'server',
      retryable: false,
      providerCode: null,
      detail: 'a scripted server error',
    },
  })

/** A send that opens a Run; resolves with that Run's end. */
async function send(h: Harness, text: string): Promise<RunEnded> {
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return h.loop.runEnded({ runId: sent.runId })
}

async function entries(h: Harness): Promise<TapeEntry[]> {
  return (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}

/** What the Tape says opened this Run. */
async function causeOf(h: Harness, runId: string | null): Promise<RunStartedPayload['cause']> {
  const started = (await entries(h)).find(
    (entry) => entry.name === 'execution/run_started' && entry.sourceId === runId,
  )
  if (started === undefined) throw new Error(`no run_started for ${String(runId)}`)
  return (started.payload as unknown as RunStartedPayload).cause
}

/** How many of this Run's calls got a `dispatch_committed`. */
async function dispatchesOf(h: Harness, runId: string | null): Promise<number> {
  return (await entries(h)).filter(
    (entry) => entry.name === 'execution/dispatch_committed' && entry.sourceId === runId,
  ).length
}

/** The id a queued message went in as: its `user-message`, found by the words `queued` maps its id to. */
function messageIdOf(h: Harness, text: string, queued: Map<string, string>): string {
  const events = h.loop.recorded.filter(
    (event): event is Extract<SessionEvent, { type: 'user-message' }> =>
      event.type === 'user-message',
  )
  const found = events.findLast((event) =>
    event.queuedId === null ? false : queued.get(event.queuedId) === text,
  )
  if (found === undefined) throw new Error(`no user-message for ${text}`)
  return found.messageId
}

/** The one user message a direct send wrote: the Tape's `message/user` with these words. */
async function writtenId(h: Harness, text: string): Promise<string> {
  const found = (await entries(h)).findLast(
    (entry) => entry.name === 'message/user' && JSON.stringify(entry.payload).includes(text),
  )
  const id = found?.payload['messageId']
  if (typeof id !== 'string') throw new Error(`no message/user for ${text}`)
  return id
}

async function card(h: Harness): Promise<string> {
  const pending = await h.service.currentPending({ sessionId: SESSION })
  if (pending === null) throw new Error('no card')
  return pending.card.requestId
}

async function answer(h: Harness, decision: 'allow' | 'deny'): Promise<RunEnded> {
  const requestId = await card(h)
  const answered = await h.service.answer({
    kind: 'approval',
    sessionId: SESSION,
    requestId,
    decision,
    origin: null,
  })
  expect(answered).toEqual({ status: 'applied' })
  return h.loop.runEnded()
}

describe('a Run a user message opened (§失败卡与结束原因「由用户消息触发」)', () => {
  it('names that message when the Run fails before any call', async () => {
    const h = harness()
    h.provider.script(failure())
    const ended = await send(h, 'try this')
    expect(ended).toMatchObject({ reason: { code: 'provider-error' }, recorded: true })
    const cause = await causeOf(h, ended.runId)
    expect(cause).toEqual({ kind: 'user-message', messageId: await writtenId(h, 'try this') })
    expect(ended.retryOf).toBe(cause.kind === 'user-message' ? cause.messageId : 'not a message')
  })

  it('gives null when the Run’s only call was blocked: its reply follows the message', async () => {
    // Nothing was dispatched, but the reply that asked for the call is on the Tape after the
    // message, so a resend would be a second copy of it, not the same message (01 spec.md:395).
    const h = harness()
    h.provider.script(calls(protectedRead))
    h.provider.script(failure())
    const ended = await send(h, 'read the passwords')
    expect(await dispatchesOf(h, ended.runId)).toBe(0)
    expect(ended.reason.code).toBe('provider-error')
    expect(ended.retryOf).toBeNull()
  })

  it('names the message when the Run failed before any reply of its own', async () => {
    const h = harness()
    h.provider.script(failure())
    const ended = await send(h, 'hello')
    expect(ended.reason.code).toBe('provider-error')
    expect(ended.retryOf).toBe(await writtenId(h, 'hello'))
  })

  it('gives null once one of the Run’s calls was dispatched, however the Run then ends', async () => {
    const failed = harness()
    failed.provider.script(calls(look('a')))
    failed.provider.script(failure())
    const afterCall = await send(failed, 'look, then fail')
    expect(await dispatchesOf(failed, afterCall.runId)).toBe(1)
    expect(afterCall).toMatchObject({ reason: { code: 'provider-error' }, retryOf: null })

    const completed = harness()
    completed.provider.script(calls(protectedRead, look('a')))
    completed.provider.script(done())
    const ended = await send(completed, 'read and look')
    // One call blocked, one dispatched: the one that went out is enough.
    expect(await dispatchesOf(completed, ended.runId)).toBe(1)
    expect(ended).toMatchObject({ reason: { code: 'completed' }, retryOf: null })
  })

  it('gives null for a Run stopped while its call was in flight: that call went out', async () => {
    const h = harness({
      during: async (self) => {
        expect(await self.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
      },
    })
    h.provider.script(calls(look('a')))
    const ended = await send(h, 'look and wait')
    expect(ended.reason.code).toBe('user-stopped')
    expect(await dispatchesOf(h, ended.runId)).toBe(1)
    expect(ended.retryOf).toBeNull()
  })

  it('names the same message again for a resend: the kernel wrote no new one (01 spec.md:395)', async () => {
    const h = harness()
    h.provider.script(failure())
    const first = await send(h, 'try this')
    h.provider.script(failure())
    const second = await send(h, 'try this')
    expect(second.runId).not.toBe(first.runId)
    const messages = (await entries(h)).filter((entry) => entry.name === 'message/user')
    expect(messages).toHaveLength(1)
    expect([first.retryOf, second.retryOf]).toEqual([
      messages[0]?.payload['messageId'],
      messages[0]?.payload['messageId'],
    ])
  })

  it('gives null once a queued message went in after the one that opened the Run', async () => {
    // The second send arrives while the first prebuilds; it is judged once the first opened its Run,
    // so it queues and goes in at the first batch boundary — after the blocked call, mid-Run.
    const h = harness()
    h.provider.script(calls(protectedRead))
    h.provider.script(failure())
    const held = h.loop.connector.holdAssemble()
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'first' })
    await held.reached
    const second = h.service.send({ sessionId: SESSION, origin: null, text: 'second' })
    held.release()
    const opened = await first
    if (opened.status !== 'started') throw new Error(`first answered ${JSON.stringify(opened)}`)
    const queued = await second
    if (queued.status !== 'queued') throw new Error(`second answered ${JSON.stringify(queued)}`)
    const ended = await h.loop.runEnded({ runId: opened.runId })
    const inserted = h.loop.recorded.find(
      (event) => event.type === 'user-message' && event.queuedId === queued.queuedId,
    )
    expect(inserted).toMatchObject({ runId: opened.runId })
    expect(await dispatchesOf(h, ended.runId)).toBe(0)
    // Neither the opener (no longer the last message) nor the inserted one (it did not open the Run).
    expect(ended.retryOf).toBeNull()
  })

  it('names the last of the messages an auto-send took out: the Run’s cause (01 修补 9)', async () => {
    // Both queue behind a streaming reply, which has no batch boundary: they go out together when
    // it completes, and the round's cause is the last one (RunStartedPayload.cause).
    const texts = new Map<string, string>()
    const sends: Array<Promise<SendResult>> = []
    const h = harness({
      onEvent: (self, event) => {
        if (event.type !== 'text-delta' || sends.length > 0) return
        for (const text of ['second', 'third']) {
          sends.push(
            self.service.send({ sessionId: SESSION, origin: null, text }).then((sent) => {
              if (sent.status === 'queued') texts.set(sent.queuedId, text)
              return sent
            }),
          )
        }
      },
    })
    h.provider.script(scriptedTurn({ deltas: ['streaming'], usage: USAGE }))
    h.provider.script(failure())
    const first = await send(h, 'first')
    expect(first).toMatchObject({ reason: { code: 'completed' } })
    expect((await Promise.all(sends)).map((sent) => sent.status)).toEqual(['queued', 'queued'])
    const auto = await h.loop.runEnded()
    expect(auto.reason.code).toBe('provider-error')
    expect(await causeOf(h, auto.runId)).toEqual({
      kind: 'user-message',
      messageId: messageIdOf(h, 'third', texts),
    })
    expect(auto.retryOf).toBe(messageIdOf(h, 'third', texts))
    // The completed Run was the first message's and dispatched nothing, but its reply follows it.
    expect(first.retryOf).toBeNull()
  })

  it('send-now: the stopped Run dispatched its call; the message then opens a Run of its own', async () => {
    // §插话与输入框状态表「立即发送」: the Run the user saw stops, then this message goes out next.
    const texts = new Map<string, string>()
    let urgent: Promise<SendResult> | undefined
    const h = harness({
      during: (self) => {
        const started = self.loop.recorded.findLast((event) => event.type === 'run-started')
        if (started?.type !== 'run-started') throw new Error('no Run in flight')
        urgent ??= self.service
          .send({
            sessionId: SESSION,
            origin: null,
            text: 'stop, do this',
            urgent: { runId: started.runId },
          })
          .then((sent) => {
            if (sent.status === 'queued') texts.set(sent.queuedId, 'stop, do this')
            return sent
          })
      },
    })
    h.provider.script(calls(look('a')))
    h.provider.script(failure())
    const stopped = await send(h, 'look at a')
    expect(await urgent).toMatchObject({ status: 'queued' })
    const next = await h.loop.runEnded()
    expect([stopped.reason.code, stopped.retryOf]).toEqual(['user-stopped', null])
    expect(next.reason.code).toBe('provider-error')
    expect(next.retryOf).toBe(messageIdOf(h, 'stop, do this', texts))
  })

  it('a new message that supersedes a card opens a Run of its own, and names it', async () => {
    const h = harness()
    h.inspector.answer(ASK)
    h.provider.script(calls(look('a')))
    const paused = await send(h, 'look at a')
    expect(paused.reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    h.inspector.answer({ kind: 'none' })
    h.provider.script(failure())
    const ended = await send(h, 'never mind, do this')
    expect(await causeOf(h, ended.runId)).toMatchObject({ kind: 'user-message' })
    expect(ended.retryOf).toBe(await writtenId(h, 'never mind, do this'))
  })
})

describe('a Run no user message opened: null (§失败卡与结束原因「其余情况给复制诊断信息」)', () => {
  /**
   * `a` runs — and 'then c' is sent while it does, queueing — and `b` waits on a card: the paused Run
   * leaves the message queued, to go in before the answer's Run's first request.
   */
  async function pausedWithQueued(): Promise<{ h: Harness; queuedId: string; pausedRun: string }> {
    let queued: Promise<SendResult> | undefined
    const h = harness({
      during: (self, at) => {
        if (at === 'a') {
          queued ??= self.service.send({ sessionId: SESSION, origin: null, text: 'then c' })
        }
      },
    })
    h.inspector.answer(({ call }) => (call.args['at'] === 'b' ? ASK : { kind: 'none' }))
    h.provider.script(calls(look('a'), look('b')))
    const paused = await send(h, 'look at a and b')
    expect(paused.reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    const sent = await queued
    if (sent?.status !== 'queued') throw new Error(`then c answered ${JSON.stringify(sent)}`)
    expect(h.loop.queued(SESSION).map((item) => item.queuedId)).toEqual([sent.queuedId])
    h.inspector.answer({ kind: 'none' })
    return { h, queuedId: sent.queuedId, pausedRun: paused.runId ?? '' }
  }

  it('an allow’s Run that inserts a queued message before its first request (plan step 20)', async () => {
    // The event order is tool-outcome → user-message(queuedId) → … → error: a user message comes
    // before any of the Run's content, which the renderer used to read as the Run's opener.
    const { h, queuedId, pausedRun } = await pausedWithQueued()
    h.provider.script(failure())
    const ended = await answer(h, 'allow')
    expect(ended.reason.code).toBe('provider-error')
    expect(await causeOf(h, ended.runId)).toMatchObject({ kind: 'resume', pausedRunId: pausedRun })
    expect(h.loop.recorded).toContainEqual(
      expect.objectContaining({ type: 'user-message', runId: ended.runId, queuedId }),
    )
    expect(ended.retryOf).toBeNull()
  })

  it('an allow the re-judgement turned into a denial: nothing dispatched, still the answer’s Run', async () => {
    // Isolates the opener: the answer's Run dispatches nothing (b closes not-run / policy) and a
    // queued user message goes in before its first request — yet it is not a message's Run.
    const { h, queuedId } = await pausedWithQueued()
    h.memory.setPolicy(DENY_LOOK)
    h.provider.script(failure())
    const ended = await answer(h, 'allow')
    expect(ended.reason.code).toBe('provider-error')
    expect(await dispatchesOf(h, ended.runId)).toBe(0)
    expect(h.loop.recorded).toContainEqual(
      expect.objectContaining({ type: 'user-message', runId: ended.runId, queuedId }),
    )
    expect(ended.retryOf).toBeNull()
  })

  it('a denial’s Run, which sends no request and ends user-rejected', async () => {
    const { h } = await pausedWithQueued()
    const ended = await answer(h, 'deny')
    expect(ended.reason).toMatchObject({ code: 'user-rejected' })
    expect(ended.retryOf).toBeNull()
  })

  it('「继续」’s Run, as the truncated Run before it with its partial reply written', async () => {
    const h = harness()
    h.provider.script(truncated())
    const cut = await send(h, 'write it all')
    expect(cut.reason).toMatchObject({ code: 'output-truncated' })
    expect(cut.retryOf).toBeNull()
    h.provider.script(failure())
    expect(await h.service.continueRun({ sessionId: SESSION, origin: null })).toEqual({
      status: 'started',
    })
    const continued = await h.loop.runEnded()
    expect(continued.reason.code).toBe('provider-error')
    expect(await causeOf(h, continued.runId)).toMatchObject({ kind: 'continue' })
    expect(continued.retryOf).toBeNull()
  })

  /** Paused on a card for `a`, then restarted under a policy that denies it: listed resumable. */
  async function resumable(): Promise<Harness> {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const before = harness({ store })
    before.inspector.answer(ASK)
    before.provider.script(calls(look('a')))
    expect((await send(before, 'look at a')).reason.code).toBe('paused')
    const after = harness({ store, idsFrom: 1000 })
    after.memory.setPolicy(DENY_LOOK)
    const recovered = await after.service.recover()
    expect(recovered.resumable.map((item) => item.rootSessionId)).toEqual([SESSION])
    return after
  }

  it('a resume’s Run (§启动恢复与发送防护「打开会话才续跑」)', async () => {
    const h = await resumable()
    h.provider.script(failure())
    expect(await h.service.resume({ rootSessionId: SESSION, origin: null })).toEqual({
      status: 'started',
    })
    const ended = await h.loop.runEnded()
    expect(ended.reason.code).toBe('provider-error')
    expect(await causeOf(h, ended.runId)).toMatchObject({ kind: 'resume' })
    expect(await dispatchesOf(h, ended.runId)).toBe(0)
    expect(ended.retryOf).toBeNull()
  })

  it('a resume a message set off: the message queues and goes in first, the Run is still the resume’s', async () => {
    // §插话与输入框状态表: a message to a resumable session resumes it first and waits in the queue.
    const h = await resumable()
    h.provider.script(failure())
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'and also' })
    if (sent.status !== 'queued') throw new Error(`send answered ${JSON.stringify(sent)}`)
    const ended = await h.loop.runEnded()
    expect(ended.reason.code).toBe('provider-error')
    expect(h.loop.recorded).toContainEqual(
      expect.objectContaining({
        type: 'user-message',
        runId: ended.runId,
        queuedId: sent.queuedId,
      }),
    )
    expect(await causeOf(h, ended.runId)).toMatchObject({ kind: 'resume' })
    expect(ended.retryOf).toBeNull()
  })
})

describe('an end that opened no Run: null', () => {
  it('a missing key: nothing is written (「缺 key 什么都不写」)', async () => {
    const h = harness()
    h.loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'))
    expect(await h.service.send({ sessionId: SESSION, origin: null, text: 'hi' })).toEqual({
      status: 'not-sent',
      code: 'config-missing',
    })
    const ended = await h.loop.runEnded()
    expect(ended).toMatchObject({ runId: null, recorded: false, retryOf: null })
    expect(await entries(h)).toEqual([])
  })

  for (const [how, code] of [
    ['a stop', 'stopped'],
    ['a closed window', 'app-exit'],
  ] as const) {
    it(`${how} in the prebuild: the message is never written`, async () => {
      const h = harness()
      const held = h.loop.connector.holdAssemble()
      const sending = h.service.send({ sessionId: SESSION, origin: null, text: 'hi' })
      await held.reached
      const aborted =
        code === 'stopped'
          ? (await h.service.stop({ rootSessionId: SESSION })).stopped
          : h.loop.abort(SESSION, 'close-window')
      expect(aborted).toBe(true)
      held.release()
      expect(await sending).toEqual({ status: 'not-sent', code })
      const ended = await h.loop.runEnded()
      expect(ended).toMatchObject({ runId: null, recorded: false, retryOf: null })
      expect((await entries(h)).filter((entry) => entry.name === 'message/user')).toEqual([])
    })
  }
})
