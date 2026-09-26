/**
 * Closures and replay (spec 02 §工具调用的收口, §执行日志与恢复表, §折叠与读法; plan step 14: 旧 1 for
 * the stop half, the two fallbacks, 旧 122, 旧 178, 先写者算数, T1, 02 不变量 23 and 31).
 *
 * Every request goes through a real adapter on both wires, with the pairing and last-turn
 * assertions on every fetch. What needs answers — a stop while a card waits, a rejection at each
 * position of a batch — is plan step 15's; a crash and the startup recovery are step 16's.
 */
import { describe, expect, it } from 'vitest'
import {
  ZHIPU_DEFAULT_BASE_URL,
  anthropicDefinition,
  createMemoryTapeStore,
  zhipuDefinition,
} from '../../src/index.js'
import type {
  InspectorRegistration,
  ModelInfo,
  NewEntry,
  SessionEvent,
  SessionService,
  TapeEntry,
  TapeStore,
} from '../../src/index.js'
import { resultFacts } from '../../src/loop/closure.js'
import { messageRetractedKey, messageRevisionKey } from '../../src/tape/provenance.js'
import { createTape } from '../../src/tape/tape.js'
import {
  assertLastTurnIsUser,
  assertToolPairing,
  createCounterIds,
  createFakeInspector,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
} from '../../src/testing/index.js'
import type { FakeNetwork, TestLoopPorts } from '../../src/testing/index.js'
import * as anthropicFixture from '../provider/fixtures/anthropic-sse.js'
import * as openAIFixture from '../provider/fixtures/openai-sse.js'
import { anthropicModel } from '../provider/wire/fixtures.js'
import { LOOK, instantHost, lookSource, proxyStore } from './support.js'

const IDENTITY = {
  userId: 'pairing-user',
  tenantId: 'pairing-tenant',
  profileDir: '/tenon/pairing',
}
const SESSION = '6b3d9a2e-6b3d-4a71-9f52-0c8de7a11b36'

type Wire = 'anthropic-messages' | 'openai-chat'
const WIRES: readonly Wire[] = ['anthropic-messages', 'openai-chat']

interface Call {
  readonly id: string
  readonly at: string
}

/** A turn on this wire: text chunks, then calls to `fs__look`, ended as a tool-use turn. */
function callTurn(wire: Wire, texts: readonly string[], calls: readonly Call[]): readonly string[] {
  const fixtureCalls = calls.map((call) => ({
    id: call.id,
    name: LOOK,
    args: JSON.stringify({ at: call.at }),
  }))
  return wire === 'anthropic-messages'
    ? anthropicFixture.turnFrames(texts, fixtureCalls, 'tool_use')
    : openAIFixture.turnFrames(texts, fixtureCalls, 'tool_calls')
}

function textTurn(wire: Wire, texts: readonly string[] = ['Done.']): readonly string[] {
  return wire === 'anthropic-messages'
    ? anthropicFixture.turnFrames(texts, [], 'end_turn')
    : openAIFixture.turnFrames(texts, [], 'stop')
}

type RunEnded = Extract<SessionEvent, { type: 'run-ended' }>

interface Harness {
  readonly net: FakeNetwork
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly executed: Record<string, unknown>[]
  readonly logs: string[]
}

interface HarnessOptions {
  readonly store?: (inner: TapeStore) => TapeStore
  readonly onEvent?: (event: SessionEvent) => void
  readonly during?: (args: Record<string, unknown>) => void | Promise<void>
  readonly onUnansweredCall?: 'throw' | 'repair'
  readonly inspectors?: readonly InspectorRegistration[]
}

function harness(
  wire: Wire,
  exchanges: readonly (readonly string[])[],
  o: HarnessOptions = {},
): Harness {
  const net = fakeNetwork(
    exchanges.map((frames) => ({ kind: 'sse' as const, frames })),
    {
      checkRequest: (request) => {
        assertToolPairing(request)
        assertLastTurnIsUser(request)
      },
    },
  )
  const definition = wire === 'anthropic-messages' ? anthropicDefinition : zhipuDefinition
  const provider = definition.create({
    network: net,
    clock: { now: () => 0, setTimeout: () => () => undefined },
    config: {
      baseURL:
        wire === 'anthropic-messages' ? 'https://api.anthropic.test' : ZHIPU_DEFAULT_BASE_URL,
    },
    secrets: { apiKey: 'test-key-not-a-real-credential' },
  })
  const zhipuModel = zhipuDefinition.builtinModels[0]
  if (zhipuModel === undefined) throw new Error('the zhipu definition has no builtin model')
  const model: ModelInfo = wire === 'anthropic-messages' ? anthropicModel() : zhipuModel
  const inner = createMemoryTapeStore({ identity: IDENTITY })
  const store = o.store?.(inner) ?? inner
  const executed: Record<string, unknown>[] = []
  const loop = createTestLoopPorts({
    connector: { provider, model, mcpSources: [lookSource(executed, o.during)] },
    ...(o.onEvent === undefined ? {} : { onEvent: o.onEvent }),
  })
  const logs: string[] = []
  const service = createTestSessionService(
    {
      host: instantHost(),
      tape: store,
      ids: createCounterIds(),
      inspectors: [...(o.inspectors ?? [])],
      connector: loop.connector,
      protectedFiles: [],
      log: (line) => logs.push(line),
      ...(o.onUnansweredCall === undefined ? {} : { onUnansweredCall: o.onUnansweredCall }),
    },
    { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }) },
  )
  service.bindLoop(loop)
  return { net, store, service, loop, executed, logs }
}

let texts = 0

async function send(h: Harness, text = `message ${String((texts += 1))}`): Promise<RunEnded> {
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return h.loop.runEnded({ runId: sent.runId })
}

async function all(store: TapeStore): Promise<TapeEntry[]> {
  return (await store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}

function identityOf(entry: {
  sourceId?: string | null
  sourceSeq?: number | null
  payload: Record<string, unknown>
}): string {
  return `${String(entry.sourceId)}:${String(entry.sourceSeq)}:${String(entry.payload['ordinal'])}`
}

/** 02 不变量 23: every client call on the Tape has exactly one result. */
function assertOneResultEach(entries: readonly TapeEntry[]): void {
  const results = new Map<string, number>()
  for (const entry of entries) {
    if (entry.name === 'tool/result')
      results.set(identityOf(entry), (results.get(identityOf(entry)) ?? 0) + 1)
  }
  for (const call of entries.filter((entry) => entry.name === 'tool/call')) {
    expect(results.get(identityOf(call)), `${identityOf(call)}`).toBe(1)
  }
}

function outcomes(entries: readonly TapeEntry[]): string[] {
  return entries
    .filter((entry) => entry.name === 'execution/tool_outcome')
    .map((entry) => `${String(entry.payload['state'])}/${String(entry.payload['source'])}`)
}

/** xorshift32: the stop points are random, and the same on every run of the suite. */
function seeded(seed: number): () => number {
  let x = seed
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 2 ** 32
  }
}

describe('a stop at any point leaves every call paired (旧 1, stop half)', () => {
  for (const wire of WIRES) {
    it(`holds over 200 stop points on ${wire}`, { timeout: 60_000 }, async () => {
      const random = seeded(wire === 'anthropic-messages' ? 0x2545f491 : 0x9e3779b9)
      for (let round = 0; round < 200; round += 1) {
        const chunks = ['Let ', 'me ', 'look.'].slice(0, Math.floor(random() * 4))
        const calls = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, j) => ({
          id: `call_${String(round)}_${String(j)}`,
          at: `${String(round)}-${String(j)}`,
        }))
        // An unstopped Run sends: run-started, user-message, one delta a chunk, a tool-call and a
        // tool-outcome a call, the second reply's delta, run-ended. A stop lands after any of them
        // but the last, or while the k-th call is running.
        const events = 2 + chunks.length + 2 * calls.length + 1
        const duringCall = random() < 0.3 ? 1 + Math.floor(random() * calls.length) : 0
        const afterEvent = 1 + Math.floor(random() * events)
        let seen = 0
        let started = 0
        let stopper: SessionService | undefined
        const h = harness(
          wire,
          [callTurn(wire, chunks, calls), textTurn(wire), textTurn(wire), textTurn(wire)],
          {
            onEvent: (event) => {
              seen += 1
              if (duringCall === 0 && seen === afterEvent && event.type !== 'run-ended') {
                void stopper?.stop({ rootSessionId: SESSION })
              }
            },
            during: async () => {
              started += 1
              if (started === duringCall) await stopper?.stop({ rootSessionId: SESSION })
            },
          },
        )
        stopper = h.service
        // oxlint-disable-next-line no-await-in-loop -- one session at a time: the Tape is the assertion
        const first = await send(h)
        expect(first.recorded).toBe(true)
        stopper = undefined
        // The next request, whatever the stop left: its pairing is checked on the wire.
        // oxlint-disable-next-line no-await-in-loop -- the follow-up comes after the stop
        const next = await send(h)
        expect(next.recorded).toBe(true)
        // oxlint-disable-next-line no-await-in-loop -- this round's facts
        assertOneResultEach(await all(h.store))
        expect(h.net.checkFailures).toEqual([])
      }
    })
  }
})

/** The first result the Run writes never lands: the bug the check is there to catch. */
const losingFirstResult = (inner: TapeStore): TapeStore => {
  let lost = false
  return proxyStore(inner, {
    append: (batch) => {
      if (lost || !batch.entries.some((entry) => entry.name === 'tool/result')) {
        return inner.append(batch)
      }
      lost = true
      const kept = batch.entries.filter(
        (entry) => entry.name !== 'tool/result' && entry.name !== 'execution/tool_outcome',
      )
      return kept.length === 0 ? Promise.resolve([]) : inner.append({ ...batch, entries: kept })
    },
  })
}

describe('the fallback before encode() (§崩溃、服务端调用块与兜底「兜底」)', () => {
  for (const wire of WIRES) {
    it(`throws before sending on ${wire} by default, and the request never leaves`, async () => {
      const h = harness(wire, [callTurn(wire, [], [{ id: 'call_1', at: 'a' }]), textTurn(wire)], {
        store: losingFirstResult,
      })
      const ended = await send(h)
      expect(ended).toMatchObject({ recorded: false, errorCode: 'unknown' })
      expect(h.net.callCount).toBe(1)
      expect(
        h.logs.filter((line) => line.includes('reached a request with no result')),
      ).toHaveLength(1)
    })

    it(`repairs on ${wire} when asked: a repair closure, one log line, a paired request`, async () => {
      const h = harness(wire, [callTurn(wire, [], [{ id: 'call_1', at: 'a' }]), textTurn(wire)], {
        store: losingFirstResult,
        onUnansweredCall: 'repair',
      })
      expect((await send(h)).reason).toEqual({ code: 'completed' })
      expect(h.net.callCount).toBe(2)
      // It was dispatched, so whether it ran is not known.
      expect(outcomes(await all(h.store))).toEqual(['uncertain/repair'])
      expect(h.logs.filter((line) => line.includes('repaired'))).toHaveLength(1)
      expect(h.net.checkFailures).toEqual([])
    })
  }
})

describe('replay after a retraction and a late result', () => {
  it('drops a retracted turn’s calls and results from the next request (旧 122)', async () => {
    const wire: Wire = 'anthropic-messages'
    const h = harness(wire, [
      callTurn(wire, ['Looking.'], [{ id: 'call_gone', at: 'a' }]),
      textTurn(wire),
      textTurn(wire),
    ])
    await send(h, 'look at a')
    const entries = await all(h.store)
    const withCall = entries.find(
      (entry) =>
        entry.name === 'message/assistant' &&
        (entry.payload['content'] as { type: string }[]).some(
          (block) => block.type === 'tool-request',
        ),
    )
    const messageId = String(withCall?.payload['messageId'])
    const head = await h.store.head(SESSION)
    if (head === null) throw new Error('no head')
    const tape = createTape(h.store)
    await tape.appendEntries({
      sessionId: SESSION,
      incarnationId: head.incarnationId,
      entries: [
        tape.writer('message').entry('message/retracted', {
          sourceType: 'message',
          sourceId: messageId,
          provenanceKey: messageRetractedKey(messageId),
          payload: { messageId, reason: 'user-deleted' },
          createdAt: 1,
        }),
      ],
    })
    await send(h, 'and now?')
    const body = JSON.stringify(h.net.requests.at(-1)?.body)
    expect(body).not.toContain('call_gone')
    expect(body).not.toContain('looked at a')
    expect(h.net.checkFailures).toEqual([])
  })

  it('places a result written after a later user message right after its assistant turn (旧 178)', async () => {
    const wire: Wire = 'anthropic-messages'
    // A card pauses the Run; a user message lands on the Tape before the answer (written behind the
    // loop's back, as a message an older build left would be); the answer then runs the call, so
    // its result comes after that message.
    const ask = createFakeInspector({
      id: 'asker',
      ceiling: 'ask',
      answer: { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] },
    })
    const h = harness(wire, [callTurn(wire, [], [{ id: 'call_late', at: 'a' }]), textTurn(wire)], {
      inspectors: [ask.registration],
    })
    expect((await send(h, 'first question')).reason).toEqual({
      code: 'paused',
      waitingFor: 'approval',
    })
    const head = await h.store.head(SESSION)
    if (head === null) throw new Error('no head')
    const tape = createTape(h.store)
    await tape.appendEntries({
      sessionId: SESSION,
      incarnationId: head.incarnationId,
      entries: [
        tape.writer('message').entry('message/user', {
          sourceType: 'message',
          sourceId: '9e1c9a2e-6b3d-4a71-9f52-0c8de7a11b39',
          sourceSeq: 0,
          provenanceKey: messageRevisionKey('9e1c9a2e-6b3d-4a71-9f52-0c8de7a11b39', 0),
          payload: {
            messageId: '9e1c9a2e-6b3d-4a71-9f52-0c8de7a11b39',
            revision: 0,
            role: 'user',
            content: [{ type: 'text', text: 'second question' }],
            status: 'complete',
          },
          createdAt: 1,
        }),
      ],
    })
    const card = await h.service.currentPending({ sessionId: SESSION })
    if (card === null) throw new Error('no card')
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: card.card.requestId,
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    const entries = await all(h.store)
    const user = entries.findLast((entry) => entry.name === 'message/user')
    const result = entries.find((entry) => entry.name === 'tool/result')
    expect(result?.entryId).toBeGreaterThan(user?.entryId ?? Infinity)
    const body = h.net.requests.at(-1)?.body as {
      messages: { role: string; content: { type: string; text?: string }[] }[]
    }
    // Right after its assistant turn, before the later user text — the API reads the two adjacent
    // user turns as one, results first. The first question is followed by the day's environment
    // note (spec 02 §提示层「环境说明」).
    expect(body.messages.map((message) => message.role)).toEqual([
      'user',
      'user',
      'assistant',
      'user',
      'user',
    ])
    expect(body.messages[3]?.content.map((block) => block.type)).toEqual(['tool_result'])
    expect(body.messages[4]?.content.at(-1)).toMatchObject({
      type: 'text',
      text: 'second question',
    })
    expect(h.net.checkFailures).toEqual([])
  })
})

/** Every dispatch the Run writes comes back as already committed. */
const replayedDispatch = (inner: TapeStore): TapeStore =>
  proxyStore(inner, {
    append: async (batch) => {
      const receipts = await inner.append(batch)
      return receipts.map((receipt, i) =>
        batch.entries[i]?.name === 'execution/dispatch_committed'
          ? { entryId: receipt.entryId, entryHash: receipt.entryHash, created: false }
          : receipt,
      )
    },
  })

describe('who writes a result (先写者算数, T1, 02 不变量 31)', () => {
  it('keeps the first result written and drops the Run’s later one, unannounced', async () => {
    const wire: Wire = 'anthropic-messages'
    let early: (() => Promise<void>) | undefined
    const h = harness(wire, [callTurn(wire, [], [{ id: 'call_1', at: 'a' }]), textTurn(wire)], {
      during: () => early?.(),
    })
    early = async (): Promise<void> => {
      // Another writer's result for the same call, committed while the call runs.
      const runId = h.loop.recorded.find((event) => event.type === 'run-started')
      if (runId?.type !== 'run-started') throw new Error('no run-started')
      const head = await h.store.head(SESSION)
      if (head === null) throw new Error('no head')
      const tape = createTape(h.store)
      await tape.appendEntries({
        sessionId: SESSION,
        incarnationId: head.incarnationId,
        entries: resultFacts({
          tape,
          now: () => 1,
          call: { runId: runId.runId, requestSeq: 1, ordinal: 0, providerToolCallId: 'call_1' },
          content: [{ type: 'text', text: 'the first word' }],
          isError: false,
          kernelAuthored: false,
          effect: 'external',
          state: 'completed',
          source: null,
          reversibility: 'unknown',
          writer: { by: 'resolver' },
        }),
      })
    }
    expect((await send(h)).reason).toEqual({ code: 'completed' })
    const entries = await all(h.store)
    expect(entries.filter((entry) => entry.name === 'tool/result')).toHaveLength(1)
    expect(entries.find((entry) => entry.name === 'tool/result')?.payload['content']).toEqual([
      { type: 'text', text: 'the first word' },
    ])
    expect(h.logs.filter((line) => line.includes('the first one written counts'))).toHaveLength(1)
    expect(h.loop.recorded.filter((event) => event.type === 'tool-outcome')).toEqual([])
    expect(JSON.stringify(h.net.requests[1]?.body)).toContain('the first word')
  })

  it('never dispatches twice: a dispatch the Tape already has throws in development (T1)', async () => {
    const wire: Wire = 'anthropic-messages'
    const h = harness(wire, [callTurn(wire, [], [{ id: 'call_1', at: 'a' }]), textTurn(wire)], {
      store: replayedDispatch,
    })
    expect(await send(h)).toMatchObject({ recorded: false })
    expect(h.executed).toEqual([])
  })

  it('and closes it uncertain / repair in the packaged build, without running it', async () => {
    const wire: Wire = 'anthropic-messages'
    const h = harness(wire, [callTurn(wire, [], [{ id: 'call_1', at: 'a' }]), textTurn(wire)], {
      store: replayedDispatch,
      onUnansweredCall: 'repair',
    })
    expect((await send(h)).reason).toEqual({ code: 'completed' })
    expect(h.executed).toEqual([])
    expect(outcomes(await all(h.store))).toEqual(['uncertain/repair'])
    expect(h.logs.filter((line) => line.includes('already committed'))).toHaveLength(1)
  })

  it('writes each fact kind of a batch in <i> order, however they interleave (02 不变量 31)', async () => {
    const wire: Wire = 'openai-chat'
    const calls = [0, 1, 2].map((i) => ({ id: `call_${String(i)}`, at: String(i) }))
    const h = harness(wire, [callTurn(wire, [], calls), textTurn(wire)])
    await send(h)
    const entries = await all(h.store)
    for (const name of [
      'tool/call',
      'tool/permission_decided',
      'execution/dispatch_committed',
      'tool/result',
      'execution/tool_outcome',
    ]) {
      const ordinals = entries
        .filter((entry) => entry.name === name)
        .map((entry) => Number(entry.payload['ordinal']))
      expect({ name, ordinals }).toEqual({ name, ordinals: [0, 1, 2] })
    }
  })
})

// A `NewEntry` import keeps the helpers' parameter types honest where TapeEntry and NewEntry meet.
export type { NewEntry }
