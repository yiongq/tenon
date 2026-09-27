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
import { LOOK, lookSource, proxyStore } from './support.js'

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
  service.bindLoop(loop)
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
