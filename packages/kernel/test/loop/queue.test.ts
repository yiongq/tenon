/**
 * Messages sent while a Run is busy (spec 02 §插话与输入框状态表, §主进程与 kernel 的循环接口「何时判定」
 * 「Run 结束」「从队列取什么」「立即发送绑定 runId」「间接切公网」; plan step 17: 旧 22, 旧 132, send-now and
 * auto-send). The queue is `createTestLoopPorts`' own; the connector is scripted.
 *
 * Releasing a held message through `session.selectModel` is plan step 19's; stopping a Bash call
 * on send-now is step 23's; a sub-agent's Run ending under its parent's lease is step 31's.
 */
import { describe, expect, it } from 'vitest'
import {
  ProviderConfigMissingError,
  createMemoryHost,
  createMemoryTapeStore,
} from '../../src/index.js'
import type {
  LoopPorts,
  ModelInfo,
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
import { LOOK, closedWindows, lookSource, proxyStore } from './support.js'

const IDENTITY = { userId: 'queue-user', tenantId: 'queue-tenant', profileDir: '/tenon/queue' }
const SESSION = '9a6b9a2e-6b3d-4a71-9f52-0c8de7a11b3d'

const MODEL: ModelInfo = {
  id: 'claude-queue-1',
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

type RunEnded = Extract<SessionEvent, { type: 'run-ended' }>

interface Harness {
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  readonly executed: Record<string, unknown>[]
  readonly inspector: FakeInspector
}

/**
 * `during` runs while a call executes: where a case sends while the Run is busy. The inspector says
 * nothing unless a case makes it ask.
 */
function harness(
  during?: (h: Harness) => void | Promise<void>,
  wrap?: (inner: TapeStore) => TapeStore,
  ports?: (loop: TestLoopPorts) => LoopPorts,
): Harness {
  const inner = createMemoryTapeStore({ identity: IDENTITY })
  const store = wrap?.(inner) ?? inner
  const provider = createScriptedProvider({ models: [MODEL] })
  const executed: Record<string, unknown>[] = []
  const inspector = createFakeInspector({ id: 'asker', ceiling: 'ask', answer: { kind: 'none' } })
  let self: Harness | undefined
  const loop = createTestLoopPorts({
    connector: {
      provider,
      model: MODEL,
      mcpSources: [lookSource(executed, () => (self === undefined ? undefined : during?.(self)))],
    },
  })
  const service = createTestSessionService(
    {
      host: createMemoryHost(),
      tape: store,
      ids: createCounterIds(),
      inspectors: [inspector.registration],
      connector: loop.connector,
      protectedFiles: [],
    },
    { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }) },
  )
  service.bindLoop(ports?.(loop) ?? loop)
  self = { store, service, loop, provider, executed, inspector }
  return self
}

function calls(...ats: readonly string[]): StreamEvent[] {
  return [
    ...ats.flatMap((at, i): StreamEvent[] => [
      { type: 'tool-call-start', index: i + 1, id: `toolu_${at}`, name: LOOK },
      { type: 'tool-call-end', index: i + 1, id: `toolu_${at}`, name: LOOK, input: { at } },
    ]),
    { type: 'usage', usage: USAGE },
    stopEvent('tool-use', 'tool_use'),
  ]
}

const done = (text = 'Done.'): StreamEvent[] => scriptedTurn({ deltas: [text], usage: USAGE })

async function startRun(h: Harness, text: string): Promise<string> {
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return sent.runId
}

async function all(h: Harness): Promise<TapeEntry[]> {
  return (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}

function userTexts(entries: readonly TapeEntry[]): string[] {
  return entries
    .filter((entry) => entry.name === 'message/user')
    .map((entry) => (entry.payload['content'] as { text: string }[])[0]?.text ?? '')
}

function lastUserText(h: Harness): string {
  const body = h.provider.requests.at(-1)?.body as {
    messages: { role: string; content: { type: string; text?: string }[] }[]
  }
  return body.messages.at(-1)?.content.at(-1)?.text ?? ''
}

/** The hosts `queue-held` said, in order: null once a hold was cleared. */
function heldHosts(h: Harness): unknown[] {
  return h.loop.recorded
    .filter((event) => event.type === 'queue-held')
    .map((event) => (event.type === 'queue-held' ? event.host : undefined))
}

function ended(h: Harness): RunEnded[] {
  return h.loop.recorded.filter((event): event is RunEnded => event.type === 'run-ended')
}

describe('a message sent while a Run is busy (旧 22, 旧 132)', () => {
  it('waits in the queue, then joins the same turn after the batch’s results', async () => {
    let sent: Promise<unknown> | undefined
    const h = harness((self) => {
      sent ??= self.service.send({ sessionId: SESSION, origin: null, text: 'also check b' })
    })
    h.provider.script(calls('a'))
    h.provider.script(done())
    const runId = await startRun(h, 'check a')
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'completed' })
    expect(await sent).toMatchObject({ status: 'queued' })
    const entries = await all(h)
    // One Run: the message was written when it was inserted, after the result, before request 2.
    expect(entries.filter((entry) => entry.name === 'execution/run_started')).toHaveLength(1)
    expect(userTexts(entries)).toEqual(['check a', 'also check b'])
    const result = entries.find((entry) => entry.name === 'tool/result')
    const inserted = entries.findLast((entry) => entry.name === 'message/user')
    expect(inserted?.entryId).toBeGreaterThan(result?.entryId ?? Infinity)
    expect(lastUserText(h)).toBe('also check b')
    const users = h.loop.recorded.filter((event) => event.type === 'user-message')
    expect(
      users.map((event) => (event.type === 'user-message' ? event.queuedId !== null : null)),
    ).toEqual([false, true])
    expect(h.loop.queued(SESSION)).toEqual([])
  })

  it('writes two queued messages with the same text as two messages', async () => {
    const h = harness(async (self) => {
      if (self.loop.queued(SESSION).length > 0) return
      await self.service.send({ sessionId: SESSION, origin: null, text: 'same' })
      await self.service.send({ sessionId: SESSION, origin: null, text: 'same' })
    })
    h.provider.script(calls('a'))
    h.provider.script(done())
    await h.loop.runEnded({ runId: await startRun(h, 'go') })
    const users = (await all(h)).filter((entry) => entry.name === 'message/user')
    expect(users.map((entry) => entry.payload['content'])).toEqual([
      [{ type: 'text', text: 'go' }],
      [{ type: 'text', text: 'same' }],
      [{ type: 'text', text: 'same' }],
    ])
    expect(new Set(users.map((entry) => entry.payload['messageId'])).size).toBe(3)
  })

  it('goes out on its own Run after a Run that had no batch to insert it into', async () => {
    const h = harness()
    h.provider.script(scriptedTurn({ deltas: ['thinking ', 'it over'], usage: USAGE }))
    h.provider.script(done('the second answer'))
    let queued: Promise<unknown> | undefined
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'first' })
    queued = h.service.send({ sessionId: SESSION, origin: null, text: 'second' })
    const started = await first
    if (started.status !== 'started') throw new Error('not started')
    expect(await queued).toMatchObject({ status: 'queued' })
    await h.loop.runEnded({ runId: started.runId })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(userTexts(await all(h))).toEqual(['first', 'second'])
    expect(h.loop.leaseLog).toHaveLength(2)
  })

  it('stays queued while the Run waits on a card, and goes in once the card is allowed', async () => {
    const h = harness()
    h.inspector.answer({ kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] })
    h.provider.script(calls('a'))
    expect((await h.loop.runEnded({ runId: await startRun(h, 'check a') })).reason).toEqual({
      code: 'paused',
      waitingFor: 'approval',
    })
    // Sent while the card waits it would supersede; queued while the Run was busy it stays.
    await h.loop.queue.enqueue(SESSION, 'meanwhile', { urgent: false })
    expect(h.loop.queued(SESSION)).toHaveLength(1)
    h.inspector.answer({ kind: 'none' })
    h.provider.script(done())
    const card = await h.service.currentPending({ sessionId: SESSION })
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: card?.card.requestId ?? '',
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(lastUserText(h)).toBe('meanwhile')
    expect(h.loop.queued(SESSION)).toEqual([])
  })

  it('goes out after the card is denied, on the next Run (「Run 结束时」: user-rejected, F2)', async () => {
    // 根会话的 Run 以 completed 或 user-rejected（F2）结束之后，排队消息自动作为下一条发出.
    let queued: Promise<SendResult> | undefined
    const h = harness((self) => {
      queued ??= self.service.send({ sessionId: SESSION, origin: null, text: 'then c' })
    })
    h.inspector.answer(({ call }) =>
      call.args['at'] === 'b'
        ? { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] }
        : { kind: 'none' },
    )
    h.provider.script(calls('a', 'b'))
    const runId = await startRun(h, 'look at a and b')
    expect((await h.loop.runEnded({ runId })).reason).toEqual({
      code: 'paused',
      waitingFor: 'approval',
    })
    expect(await queued).toMatchObject({ status: 'queued' })
    const card = await h.service.currentPending({ sessionId: SESSION })
    h.provider.script(done())
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: card?.card.requestId ?? '',
        decision: 'deny',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-rejected', toolName: 'look' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    const entries = await all(h)
    expect(userTexts(entries)).toEqual(['look at a and b', 'then c'])
    const [opener, sent] = entries.filter((entry) => entry.name === 'message/user')
    expect(sent?.payload['messageId']).not.toBe(opener?.payload['messageId'])
    expect(lastUserText(h)).toBe('then c')
    expect(h.loop.queued(SESSION)).toEqual([])
  })

  it('stays queued when its insertion at the batch boundary could not be written', async () => {
    // 「插进去的那一刻才写 message/user」: not written, not inserted — back in the queue, not lost
    // (models/README: 排队消息不丢).
    let sent: Promise<unknown> | undefined
    let failed = false
    const h = harness(
      (self) => {
        sent ??= self.service.send({ sessionId: SESSION, origin: null, text: 'also check b' })
      },
      (inner) =>
        proxyStore(inner, {
          append: (batch) => {
            if (!failed && batch.entries.every((entry) => entry.name === 'message/user')) {
              failed = true
              return Promise.reject(new Error('SQLITE_FULL: database or disk is full'))
            }
            return inner.append(batch)
          },
        }),
    )
    h.provider.script(calls('a'))
    const runId = await startRun(h, 'check a')
    expect(await h.loop.runEnded({ runId })).toMatchObject({ recorded: false })
    expect(await sent).toMatchObject({ status: 'queued' })
    expect(failed).toBe(true)
    expect(h.loop.queued(SESSION).map((item) => item.text)).toEqual(['also check b'])
    expect(userTexts(await all(h))).toEqual(['check a'])
    expect(
      h.loop.recorded.filter((event) => event.type === 'user-message' && event.queuedId !== null),
    ).toEqual([])
  })
})

describe('send-now (「立即发送绑定 runId」)', () => {
  it('stops the Run the user saw, and sends this as the next message (旧 22)', async () => {
    let urgent: Promise<unknown> | undefined
    let runId = ''
    const h = harness((self) => {
      urgent ??= self.service.send({
        sessionId: SESSION,
        origin: null,
        text: 'stop, do this',
        urgent: { runId },
      })
    })
    h.provider.script(calls('a'))
    h.provider.script(done())
    runId = await startRun(h, 'long task')
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(await urgent).toMatchObject({ status: 'queued' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(userTexts(await all(h))).toEqual(['long task', 'stop, do this'])
  })

  it('sends normally when the Run the user saw already ended, and stops no newer one', async () => {
    const h = harness()
    h.provider.script(done('first'))
    const first = await startRun(h, 'one')
    await h.loop.runEnded({ runId: first })
    h.provider.script(done('second'))
    const sent = await h.service.send({
      sessionId: SESSION,
      origin: null,
      text: 'two',
      urgent: { runId: first },
    })
    expect(sent).toMatchObject({ status: 'started' })
    if (sent.status !== 'started') return
    expect((await h.loop.runEnded({ runId: sent.runId })).reason).toEqual({ code: 'completed' })
  })

  it('queues a send-now whose Run already ended behind the newer Run, and leaves that Run alone', async () => {
    // Plan step 17: chat.sendNow 的 runId 已结束，这条按普通发送处理 — a newer Run in progress is
    // not the one the user saw, so it is not stopped and the message joins it at the boundary.
    let first = ''
    let late: Promise<SendResult> | undefined
    const h = harness((self) => {
      late ??= self.service.send({
        sessionId: SESSION,
        origin: null,
        text: 'sent now, too late',
        urgent: { runId: first },
      })
    })
    h.provider.script(done('first'))
    first = await startRun(h, 'one')
    await h.loop.runEnded({ runId: first })
    h.provider.script(calls('a'))
    h.provider.script(done())
    const second = await startRun(h, 'two')
    expect((await h.loop.runEnded({ runId: second })).reason).toEqual({ code: 'completed' })
    expect(await late).toMatchObject({ status: 'queued' })
    expect(h.loop.leaseLog.map((lease) => lease.stopRequested)).toEqual([false, false])
    expect(userTexts(await all(h))).toEqual(['one', 'two', 'sent now, too late'])
    expect(lastUserText(h)).toBe('sent now, too late')
  })

  it('answers not-found for a queued item an auto-send already took, and leaves that Run alone', async () => {
    const h = harness()
    h.provider.script(done('first'))
    h.provider.script(done('second'))
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'one' })
    const queued = await h.service.send({ sessionId: SESSION, origin: null, text: 'two' })
    const started = await first
    if (started.status !== 'started' || queued.status !== 'queued') throw new Error('unexpected')
    const hold = h.loop.connector.holdAssemble()
    await h.loop.runEnded({ runId: started.runId })
    // The auto-send took 'two' and is prebuilding: a send-now of it finds nothing.
    await hold.reached
    const late = h.service.send({
      sessionId: SESSION,
      origin: null,
      queuedId: queued.queuedId,
      urgent: { runId: started.runId },
    })
    hold.release()
    expect(await late).toEqual({ status: 'not-found' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
  })

  it('answers not-found for an item already inserted into the Run it names, and stops nothing', async () => {
    // 「立即发送绑定 runId」: 已不在队列（…已插入…）的返回 not-found、什么都不做 — a stale bubble's
    // send-now must not stop the Run its item already went into.
    let queued: Promise<SendResult> | undefined
    let late: Promise<SendResult> | undefined
    let runId = ''
    const h = harness(async (self) => {
      if (queued === undefined) {
        queued = self.service.send({ sessionId: SESSION, origin: null, text: 'also b' })
        return
      }
      const first = await queued
      if (first.status !== 'queued') throw new Error(`queued answered ${JSON.stringify(first)}`)
      late ??= self.service.send({
        sessionId: SESSION,
        origin: null,
        queuedId: first.queuedId,
        urgent: { runId },
      })
      await late
    })
    h.provider.script(calls('a'))
    h.provider.script(calls('b'))
    h.provider.script(done())
    runId = await startRun(h, 'check a')
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'completed' })
    expect(await late).toEqual({ status: 'not-found' })
    expect(h.loop.leaseLog.map((lease) => lease.stopRequested)).toEqual([false])
    expect(userTexts(await all(h))).toEqual(['check a', 'also b'])
  })

  it('answers not-found on an idle root before acting on the prebuild’s answer', async () => {
    // A stale bubble's send-now with no key, or meeting a switch to a public host: nothing is
    // written, no failure card, nothing held (models/model1: the item is looked up first).
    const h = harness()
    h.loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'), 1)
    expect(
      await h.service.send({ sessionId: SESSION, origin: null, queuedId: 'queued-gone' }),
    ).toEqual({ status: 'not-found' })
    h.loop.connector.needsConfirm('api.example.com')
    expect(
      await h.service.send({ sessionId: SESSION, origin: null, queuedId: 'queued-gone' }),
    ).toEqual({ status: 'not-found' })
    expect(h.loop.recorded).toEqual([])
    expect(h.loop.liveLease(SESSION)).toBeNull()
    expect(h.loop.leaseLog.every((lease) => lease.finished)).toBe(true)
    // Nothing is held: a later round goes out without asking.
    h.loop.connector.needsConfirm(null)
    h.loop.connector.failProvider(null)
    h.provider.script(done())
    await h.loop.runEnded({ runId: await startRun(h, 'now') })
    expect(h.loop.recorded.filter((event) => event.type === 'queue-held')).toEqual([])
  })

  it('sends a queued item now, with the items before it, when the Run it saw has ended', async () => {
    const h = harness()
    await h.loop.queue.enqueue(SESSION, 'before', { urgent: false })
    const { queuedId } = await h.loop.queue.enqueue(SESSION, 'this one', { urgent: false })
    await h.loop.queue.enqueue(SESSION, 'after', { urgent: false })
    h.provider.script(done())
    const sent = await h.service.send({ sessionId: SESSION, origin: null, queuedId })
    expect(sent).toMatchObject({ status: 'started' })
    if (sent.status !== 'started') return
    await h.loop.runEnded({ runId: sent.runId })
    expect(userTexts(await all(h))).toEqual(['before', 'this one'])
    // The Run completed: what is left goes out after it.
    h.provider.script(done())
    await h.loop.runEnded()
    expect(userTexts(await all(h))).toEqual(['before', 'this one', 'after'])
  })

  it('clears held once the held item is sent now into a Run it stops (「间接切公网」)', async () => {
    // held 另在这些时候清掉、发 queue-held{ host: null }：…held 那条被取走（…立即发送）— at once, not
    // only when the round after it opens (models/model1: held item taken by 立即发送 clears held).
    let heldId = ''
    let afterSendNow: unknown[] | undefined
    const h = harness(async (self) => {
      if (afterSendNow !== undefined || heldId === '') return
      const running = self.loop.recorded.findLast((event) => event.type === 'run-started')
      const answered = await self.service.send({
        sessionId: SESSION,
        origin: null,
        queuedId: heldId,
        urgent: { runId: running?.type === 'run-started' ? running.runId : '' },
      })
      expect(answered).toEqual({ status: 'queued', queuedId: heldId })
      afterSendNow = heldHosts(self)
    })
    h.inspector.answer({ kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] })
    h.provider.script(calls('a'))
    expect((await h.loop.runEnded({ runId: await startRun(h, 'check a') })).reason).toEqual({
      code: 'paused',
      waitingFor: 'approval',
    })
    // A direct send while the card waits meets a public host: it waits in the queue, held.
    h.loop.connector.needsConfirm('api.example.com')
    const held = await h.service.send({ sessionId: SESSION, origin: null, text: 'to the cloud' })
    if (held.status !== 'held') throw new Error(`held answered ${JSON.stringify(held)}`)
    expect(heldHosts(h)).toEqual(['api.example.com'])
    h.loop.connector.needsConfirm(null)
    h.inspector.answer({ kind: 'none' })
    h.provider.script(done())
    const card = await h.service.currentPending({ sessionId: SESSION })
    heldId = held.queuedId
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: card?.card.requestId ?? '',
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
    expect(afterSendNow).toEqual(['api.example.com', null])
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(lastUserText(h)).toBe('to the cloud')
  })

  it('leaves the queued item in place when its send-now has no key', async () => {
    const h = harness()
    const { queuedId } = await h.loop.queue.enqueue(SESSION, 'this one', { urgent: false })
    h.loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'), 1)
    expect(await h.service.send({ sessionId: SESSION, origin: null, queuedId })).toEqual({
      status: 'not-sent',
      code: 'config-missing',
    })
    expect(h.loop.queued(SESSION).map((item) => item.text)).toEqual(['this one'])
    expect(await all(h)).toEqual([])
  })
})

describe('the auto-send after a Run (「Run 结束」「从队列取什么」)', () => {
  it('writes nothing and keeps the queue in order when the auto-send has no key', async () => {
    const h = harness()
    h.provider.script(done())
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'one' })
    await h.service.send({ sessionId: SESSION, origin: null, text: 'two' })
    await h.service.send({ sessionId: SESSION, origin: null, text: 'three' })
    const started = await first
    if (started.status !== 'started') throw new Error('not started')
    h.loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'), 1)
    await h.loop.runEnded({ runId: started.runId })
    const before = (await all(h)).length
    expect(await h.loop.runEnded({ runId: null })).toMatchObject({ recorded: false })
    expect(await all(h)).toHaveLength(before)
    expect(h.loop.queued(SESSION).map((item) => [item.text, item.urgent])).toEqual([
      ['two', false],
      ['three', false],
    ])
  })

  it('puts the items back once when the auto-send’s opening append fails', async () => {
    // 「Run 结束」: a failed auto-send restores what it took — once (models/README: 排队消息不丢、不
    // 重复); the turn and the auto-send's catch both see the failure.
    let openings = 0
    const h = harness(undefined, (inner) =>
      proxyStore(inner, {
        append: (batch) => {
          if (batch.entries.some((entry) => entry.name === 'execution/run_started')) {
            openings += 1
            if (openings === 2) return Promise.reject(new Error('disk full'))
          }
          return inner.append(batch)
        },
      }),
    )
    h.provider.script(done())
    h.provider.script(done())
    const hold = h.loop.connector.holdAssemble()
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'first' })
    await hold.reached
    const second = h.service.send({ sessionId: SESSION, origin: null, text: 'second' })
    hold.release()
    const started = await first
    if (started.status !== 'started') throw new Error('not started')
    expect(await second).toMatchObject({ status: 'queued' })
    await h.loop.runEnded({ runId: started.runId })
    await expect.poll(() => h.loop.liveLease(SESSION)).toBeNull()
    await expect.poll(() => h.loop.queued(SESSION).length).toBeGreaterThan(0)
    expect(h.loop.queued(SESSION).map((item) => [item.text, item.urgent])).toEqual([
      ['second', false],
    ])
    await h.loop.runEnded({ runId: await startRun(h, 'third') })
    expect(userTexts(await all(h))).toEqual(['first', 'second', 'third'])
  })

  it('puts a failed auto-send’s items back before the next command may take the queue', async () => {
    // The lease that took them is finished only once they are back: the message behind it goes
    // out with them, in their order (models/README: 排队消息…按规定次序发出), however slow the
    // host's restore is.
    let reads = 0
    const restoring = Promise.withResolvers<void>()
    const h = harness(
      undefined,
      (inner) =>
        proxyStore(inner, {
          // The auto-send's read of the pause fails: the second round's.
          listPendingApprovals: (q) =>
            (reads += 1) === 2
              ? Promise.reject(new Error('SQLITE_IOERR: disk I/O error'))
              : inner.listPendingApprovals(q),
        }),
      (loop) => ({
        ...loop,
        queue: {
          ...loop.queue,
          restore: async (...args: Parameters<LoopPorts['queue']['restore']>) => {
            await restoring.promise
            return loop.queue.restore(...args)
          },
        },
      }),
    )
    h.provider.script(done())
    h.provider.script(done())
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'first' })
    await h.service.send({ sessionId: SESSION, origin: null, text: 'second' })
    const started = await first
    if (started.status !== 'started') throw new Error('not started')
    const hold = h.loop.connector.holdAssemble()
    await h.loop.runEnded({ runId: started.runId })
    // The auto-send is prebuilding with 'second'; 'third' waits in the mailbox behind it.
    await hold.reached
    const third = h.service.send({ sessionId: SESSION, origin: null, text: 'third' })
    hold.release()
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
    restoring.resolve()
    expect(await third).toMatchObject({ status: 'started' })
    await h.loop.runEnded()
    expect(userTexts(await all(h))).toEqual(['first', 'second', 'third'])
  })

  it('sends nothing to a public host it would switch to indirectly, and says it is held', async () => {
    const h = harness()
    h.provider.script(done())
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'one' })
    await h.service.send({ sessionId: SESSION, origin: null, text: 'two' })
    const started = await first
    if (started.status !== 'started') throw new Error('not started')
    h.loop.connector.needsConfirm('api.example.com')
    await h.loop.runEnded({ runId: started.runId })
    await expect
      .poll(() => h.loop.recorded.filter((event) => event.type === 'queue-held').length)
      .toBe(1)
    expect(h.provider.starts).toBe(1)
    expect(h.loop.queued(SESSION).map((item) => item.text)).toEqual(['two'])
  })

  it('finishes the lease before run-ended, and begins the next with no gap', async () => {
    const h = harness()
    h.provider.script(done())
    h.provider.script(done())
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'one' })
    await h.service.send({ sessionId: SESSION, origin: null, text: 'two' })
    const started = await first
    if (started.status !== 'started') throw new Error('not started')
    const end = await h.loop.runEnded({ runId: started.runId })
    expect(end.reason).toEqual({ code: 'completed' })
    // The recording lease throws on a begin over a live one: two leases, one after the other.
    expect(h.loop.leaseLog.map((lease) => lease.finished)).toEqual([true, false])
    await h.loop.runEnded()
    expect(h.loop.leaseLog.map((lease) => lease.finished)).toEqual([true, true])
  })

  it('queues a send that comes during the auto-send’s prebuild behind what it took', async () => {
    const h = harness()
    h.provider.script(done())
    h.provider.script(done())
    h.provider.script(done())
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'one' })
    await h.service.send({ sessionId: SESSION, origin: null, text: 'two' })
    const started = await first
    if (started.status !== 'started') throw new Error('not started')
    const hold = h.loop.connector.holdAssemble()
    await h.loop.runEnded({ runId: started.runId })
    await hold.reached
    const third = h.service.send({ sessionId: SESSION, origin: null, text: 'three' })
    hold.release()
    expect(await third).toMatchObject({ status: 'queued' })
    await h.loop.runEnded()
    await h.loop.runEnded()
    expect(userTexts(await all(h))).toEqual(['one', 'two', 'three'])
    expect(h.loop.leaseLog).toHaveLength(3)
  })

  it('sends a message that came after the stop once the stopped Run is written, and nothing else', async () => {
    let asked = false
    const h = harness(async (self) => {
      if (asked) return
      asked = true
      await self.service.send({ sessionId: SESSION, origin: null, text: 'queued, not urgent' })
      await self.service.stop({ rootSessionId: SESSION })
      await self.service.send({ sessionId: SESSION, origin: null, text: 'after the stop' })
    })
    h.provider.script(calls('a'))
    h.provider.script(done())
    const runId = await startRun(h, 'work')
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(userTexts(await all(h))).toEqual(['work', 'after the stop'])
  })

  it('sends a message that came after a window closed once that Run is written, for its own window', async () => {
    // Plan step 17, 「从队列取什么」: shutdown-aborted{ close-window } 之后只取 urgent 项; 「Run 结束」:
    // 关窗中止的取把这条记为 urgent 的那次 send 的 origin (开放问题 26 已定).
    const closing = { window: 'closing' }
    const other = { window: 'other' }
    let asked = false
    const h = harness(async (self) => {
      if (asked) return
      asked = true
      await self.service.send({ sessionId: SESSION, origin: closing, text: 'queued, not urgent' })
      expect(self.loop.abort(SESSION, 'close-window')).toBe(true)
      await self.service.send({ sessionId: SESSION, origin: other, text: 'after the close' })
    })
    h.provider.script(calls('a'))
    h.provider.script(done())
    h.provider.script(done())
    const sent = await h.service.send({ sessionId: SESSION, origin: closing, text: 'work' })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    expect((await h.loop.runEnded({ runId: sent.runId })).reason).toEqual({
      code: 'shutdown-aborted',
      trigger: 'close-window',
    })
    // Only the urgent item goes out now, begun for the window that sent it.
    await expect.poll(() => h.loop.leaseLog.length).toBe(2)
    expect(h.loop.leaseLog[1]?.origin).toBe(other)
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    // After that Run completes the rest follows, on the origin of the lease that just ended.
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(userTexts(await all(h))).toEqual(['work', 'after the close', 'queued, not urgent'])
    expect(h.loop.leaseLog.map((lease) => lease.origin)).toEqual([closing, other, other])
  })

  it('sends the urgent message for its own window when the stopped Run’s window closed too', async () => {
    // 「Run 结束」: a window that closes after a stop leaves the cause `user-stop` (stopRequested), so
    // the ended lease cannot say its window is gone; begun for that window, the auto-send would be
    // aborted at once and the urgent message would never go out (rrC-2). Both orders.
    for (const order of ['stop, then close', 'close, then send now'] as const) {
      const closing = { window: 'closing' }
      const other = { window: 'other' }
      const closed: object[] = []
      let runId = ''
      let urgent: Promise<SendResult> | undefined
      const h = harness(
        async (self) => {
          if (urgent !== undefined) return
          if (order === 'stop, then close') {
            urgent = self.service.send({
              sessionId: SESSION,
              origin: other,
              text: 'stop, do this',
              urgent: { runId },
            })
            closed.push(closing)
            self.loop.abort(SESSION, 'close-window')
            return
          }
          closed.push(closing)
          self.loop.abort(SESSION, 'close-window')
          const queued = await self.service.send({
            sessionId: SESSION,
            origin: other,
            text: 'stop, do this',
          })
          if (queued.status !== 'queued') throw new Error(JSON.stringify(queued))
          urgent = self.service.send({
            sessionId: SESSION,
            origin: other,
            queuedId: queued.queuedId,
            urgent: { runId },
          })
        },
        undefined,
        (loop) => closedWindows(loop, closed),
      )
      h.provider.script(calls('a'))
      h.provider.script(done())
      // oxlint-disable-next-line no-await-in-loop -- one Run per order
      const sent = await h.service.send({ sessionId: SESSION, origin: closing, text: 'long task' })
      if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
      runId = sent.runId
      // oxlint-disable-next-line no-await-in-loop -- that Run's end
      expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
      // oxlint-disable-next-line no-await-in-loop -- the urgent send
      expect(await urgent).toMatchObject({ status: 'queued' })
      // oxlint-disable-next-line no-await-in-loop -- the auto-send's end
      expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
      expect(h.loop.leaseLog.map((lease) => lease.origin)).toEqual([closing, other])
      // oxlint-disable-next-line no-await-in-loop -- what was written
      expect(userTexts(await all(h))).toEqual(['long task', 'stop, do this'])
    }
  })

  it('puts an urgent item back as not urgent when the auto-send after the stop has no key', async () => {
    // Plan step 17, 「Run 结束」: 预建失败时 restore 取走的项（去掉 urgent）— a later stop must not
    // send it on its own.
    let runId = ''
    let urgent: Promise<SendResult> | undefined
    const h = harness((self) => {
      self.loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'), 1)
      urgent ??= self.service.send({
        sessionId: SESSION,
        origin: null,
        text: 'stop, do this',
        urgent: { runId },
      })
    })
    h.provider.script(calls('a'))
    runId = await startRun(h, 'long task')
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    expect(await urgent).toMatchObject({ status: 'queued' })
    expect(await h.loop.runEnded({ runId: null })).toMatchObject({ recorded: false })
    expect(h.loop.queued(SESSION).map((item) => [item.text, item.urgent])).toEqual([
      ['stop, do this', false],
    ])
    expect(userTexts(await all(h))).toEqual(['long task'])
  })
})

describe('a direct send and the queue (§插话与输入框状态表「空闲」)', () => {
  it('takes only what was queued before it, in front of it', async () => {
    const h = harness()
    await h.loop.queue.enqueue(SESSION, 'left from before', { urgent: false })
    h.provider.script(done())
    await h.loop.runEnded({ runId: await startRun(h, 'now') })
    expect(userTexts(await all(h))).toEqual(['left from before', 'now'])
  })

  it('holds a direct send that would switch to a public host, and clears it on a later round', async () => {
    const h = harness()
    h.loop.connector.needsConfirm('api.example.com')
    const held = await h.service.send({
      sessionId: SESSION,
      origin: null,
      text: 'to the public host',
    })
    expect(held).toMatchObject({ status: 'held' })
    expect(h.loop.queued(SESSION).map((item) => item.text)).toEqual(['to the public host'])
    const heldEvents = (): unknown[] =>
      h.loop.recorded
        .filter((event) => event.type === 'queue-held')
        .map((event) => (event.type === 'queue-held' ? event.host : undefined))
    expect(heldEvents()).toEqual(['api.example.com'])
    h.loop.connector.needsConfirm(null)
    h.provider.script(done())
    await h.loop.runEnded({ runId: await startRun(h, 'on this machine') })
    expect(heldEvents()).toEqual(['api.example.com', null])
  })

  it('keeps the queue and writes nothing when a direct send has no key', async () => {
    const h = harness()
    await h.loop.queue.enqueue(SESSION, 'waiting', { urgent: false })
    h.loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'), 1)
    expect(await h.service.send({ sessionId: SESSION, origin: null, text: 'now' })).toEqual({
      status: 'not-sent',
      code: 'config-missing',
    })
    expect(await all(h)).toEqual([])
    expect(h.loop.queued(SESSION).map((item) => item.text)).toEqual(['waiting'])
  })

  it('ends as stopped a Run that decided completed when the stop comes before its commit', async () => {
    // Plan step 17: Run 已决定 completed、提交之前 chat.stop：终态为 user-stopped，不自动发出非 urgent
    // 项 — the reply is on the Tape, the terminal task has not run (「mailbox」).
    let stopping: Promise<unknown> | undefined
    let self: Harness | undefined
    const h = harness(undefined, (inner) =>
      proxyStore(inner, {
        append: async (batch) => {
          const receipts = await inner.append(batch)
          if (batch.entries.some((entry) => entry.name === 'message/assistant')) {
            stopping ??= self?.service.stop({ rootSessionId: SESSION })
            await stopping
          }
          return receipts
        },
      }),
    )
    self = h
    h.provider.script(done())
    const hold = h.loop.connector.holdAssemble()
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'one' })
    await hold.reached
    const second = h.service.send({ sessionId: SESSION, origin: null, text: 'two' })
    hold.release()
    expect(await second).toMatchObject({ status: 'queued' })
    const started = await first
    if (started.status !== 'started') throw new Error('not started')
    const end = await h.loop.runEnded({ runId: started.runId })
    expect(await stopping).toEqual({ stopped: true })
    expect(end.reason).toEqual({ code: 'user-stopped' })
    const entries = await all(h)
    expect(entries.filter((entry) => entry.name === 'message/assistant')).toHaveLength(1)
    expect(
      entries.findLast((entry) => entry.name === 'execution/run_terminal')?.payload,
    ).toMatchObject({ reason: { code: 'user-stopped' } })
    expect(h.loop.queued(SESSION).map((item) => item.text)).toEqual(['two'])
    expect(ended(h)).toHaveLength(1)
    expect(h.loop.leaseLog).toHaveLength(1)
  })

  it('keeps the non-urgent items when a stop lands while the completed terminal commits', async () => {
    // 「从队列取什么」: a stop that reached the lease meanwhile is read again by its cause — what was
    // taken too many goes back; the committed terminal still names the run-ended.
    let stopping: Promise<unknown> | undefined
    let self: Harness | undefined
    const h = harness(undefined, (inner) =>
      proxyStore(inner, {
        append: async (batch) => {
          if (batch.entries.some((entry) => entry.name === 'execution/run_terminal')) {
            stopping ??= self?.service.stop({ rootSessionId: SESSION })
            await stopping
          }
          return inner.append(batch)
        },
      }),
    )
    self = h
    h.provider.script(done())
    const hold = h.loop.connector.holdAssemble()
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'one' })
    await hold.reached
    const second = h.service.send({ sessionId: SESSION, origin: null, text: 'two' })
    hold.release()
    expect(await second).toMatchObject({ status: 'queued' })
    const started = await first
    if (started.status !== 'started') throw new Error('not started')
    expect((await h.loop.runEnded({ runId: started.runId })).reason).toEqual({
      code: 'completed',
    })
    expect(await stopping).toEqual({ stopped: true })
    expect(h.loop.queued(SESSION).map((item) => [item.text, item.urgent])).toEqual([['two', false]])
    expect(ended(h)).toHaveLength(1)
    expect(h.loop.leaseLog).toHaveLength(1)
  })

  it('ends as stopped a Run whose completion a stop beat, and sends no queued item', async () => {
    const h = harness()
    h.provider.script(done())
    const hold = h.loop.connector.holdAssemble()
    const first = h.service.send({ sessionId: SESSION, origin: null, text: 'one' })
    await hold.reached
    const second = h.service.send({ sessionId: SESSION, origin: null, text: 'two' })
    hold.release()
    expect(await second).toMatchObject({ status: 'queued' })
    const started = await first
    if (started.status !== 'started') throw new Error('not started')
    await h.service.stop({ rootSessionId: SESSION })
    expect((await h.loop.runEnded({ runId: started.runId })).reason).toEqual({
      code: 'user-stopped',
    })
    expect(h.loop.queued(SESSION).map((item) => item.text)).toEqual(['two'])
    expect(ended(h)).toHaveLength(1)
  })
})
