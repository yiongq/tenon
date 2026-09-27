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
  createMemoryHost,
  createMemoryTapeStore,
  zhipuDefinition,
} from '../../src/index.js'
import type {
  ContentBlock,
  HostAdapter,
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
  createStreamGate,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
} from '../../src/testing/index.js'
import type { FakeNetwork, StreamGate, TestLoopPorts } from '../../src/testing/index.js'
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
  /** Holds the first exchange's frames until the case releases them. */
  readonly gate?: StreamGate
  /** Default: timers that fire at once (an inspector then times out, and asks). */
  readonly host?: HostAdapter
  /** The first id handed out: a restarted app's ids never repeat the ones before. */
  readonly idsFrom?: number
}

function harness(
  wire: Wire,
  exchanges: readonly (readonly string[])[],
  o: HarnessOptions = {},
): Harness {
  const net = fakeNetwork(
    exchanges.map((frames, i) => ({
      kind: 'sse' as const,
      frames,
      ...(i === 0 && o.gate !== undefined ? { gate: o.gate } : {}),
    })),
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
      host: o.host ?? instantHost(),
      tape: store,
      ids: createCounterIds({ start: o.idsFrom ?? 1 }),
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

/** One macrotask: every microtask the frames released so far set going has run. */
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

/** An inspector that asks about the call on `at` and about nothing else. */
function askingAt(at: string): InspectorRegistration {
  return createFakeInspector({
    id: 'asker',
    ceiling: 'ask',
    answer: (input) =>
      input.call.args['at'] === at
        ? { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] }
        : { kind: 'none' },
  }).registration
}

/** An inspector that asks about every call. */
function askAll(): InspectorRegistration {
  return createFakeInspector({
    id: 'asker',
    ceiling: 'ask',
    answer: { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] },
  }).registration
}

/** An inspector that denies the call on `at`: what a restart that tightens a waiting card runs. */
function denyingAt(at: string): InspectorRegistration {
  return createFakeInspector({
    id: 'denier',
    ceiling: 'deny',
    answer: (input) =>
      input.call.args['at'] === at
        ? { kind: 'deny', category: 'exfiltration', findings: [{ code: 'test' }] }
        : { kind: 'none' },
  }).registration
}

/** Whether the Tape holds a reply a stop cut short with tool-request blocks in it. */
function abortedWithCalls(entries: readonly TapeEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.name === 'message/assistant' &&
      entry.payload['status'] === 'aborted' &&
      (entry.payload['content'] as ContentBlock[]).some((block) => block.type === 'tool-request'),
  )
}

describe('a stop at any point leaves every call paired (旧 1, stop half)', () => {
  // 旧 1: 停止取 200 个随机时点，覆盖流式中、工具执行中、等审批三种状态 (做法照 01 验收 7). Each round
  // draws where its stop lands: after an SSE frame — inside and between tool_use blocks too — after
  // a loop event, while the k-th call runs, or while a card waits.
  for (const wire of WIRES) {
    it(`holds over 200 stop points on ${wire}`, { timeout: 120_000 }, async () => {
      const random = seeded(wire === 'anthropic-messages' ? 0x2545f491 : 0x9e3779b9)
      const drawn = { frame: 0, event: 0, call: 0, card: 0 }
      let cutWithCalls = 0
      for (let round = 0; round < 200; round += 1) {
        const chunks = ['Let ', 'me ', 'look.'].slice(0, Math.floor(random() * 4))
        const calls = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, j) => ({
          id: `call_${String(round)}_${String(j)}`,
          at: `${String(round)}-${String(j)}`,
        }))
        const frames = callTurn(wire, chunks, calls)
        const roll = random()
        const kind = roll < 0.4 ? 'frame' : roll < 0.65 ? 'event' : roll < 0.85 ? 'call' : 'card'
        drawn[kind] += 1
        // An unstopped Run sends: run-started, user-message, one delta a chunk, a tool-call and a
        // tool-outcome a call, the second reply's delta, run-ended. A stop lands after any of them
        // but the last.
        const events = 2 + chunks.length + 2 * calls.length + 1
        const afterEvent = kind === 'event' ? 1 + Math.floor(random() * events) : 0
        const duringCall = kind === 'call' ? 1 + Math.floor(random() * calls.length) : 0
        const atFrame = kind === 'frame' ? Math.floor(random() * (frames.length + 1)) : 0
        const asked = calls[Math.floor(random() * calls.length)]?.at ?? ''
        const gate = kind === 'frame' ? createStreamGate() : undefined
        let seen = 0
        let started = 0
        let stopper: SessionService | undefined
        const h = harness(wire, [frames, textTurn(wire), textTurn(wire), textTurn(wire)], {
          onEvent: (event) => {
            seen += 1
            if (seen === afterEvent && event.type !== 'run-ended') {
              void stopper?.stop({ rootSessionId: SESSION })
            }
          },
          during: async () => {
            started += 1
            if (started === duringCall) await stopper?.stop({ rootSessionId: SESSION })
          },
          ...(gate === undefined ? {} : { gate }),
          // The card rounds' inspector answers in time: a host whose timers never fire.
          ...(kind === 'card' ? { inspectors: [askingAt(asked)], host: createMemoryHost() } : {}),
        })
        stopper = h.service
        // oxlint-disable-next-line no-await-in-loop -- one session at a time: the Tape is the assertion
        const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'look' })
        if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
        if (gate !== undefined) {
          // oxlint-disable-next-line no-await-in-loop -- the request goes out before its frames
          while (h.net.callCount === 0) await tick()
          for (let i = 0; i < atFrame; i += 1) {
            gate.release(1)
            // oxlint-disable-next-line no-await-in-loop -- each frame is read before the next
            await tick()
          }
          // oxlint-disable-next-line no-await-in-loop -- the stop lands after exactly these frames
          await h.service.stop({ rootSessionId: SESSION })
          gate.end()
        }
        // oxlint-disable-next-line no-await-in-loop -- the stopped Run's end
        const first = await h.loop.runEnded({ runId: sent.runId })
        expect(first.recorded).toBe(true)
        // A card round paused, and its stop closes the card (暂停中停止).
        const closed =
          // oxlint-disable-next-line no-await-in-loop -- the stop while the card waits
          kind === 'card' ? await h.service.stop({ rootSessionId: SESSION }) : null
        expect(
          kind !== 'card' || (first.reason.code === 'paused' && closed?.stopped === true),
        ).toBe(true)
        stopper = undefined
        // oxlint-disable-next-line no-await-in-loop -- this round's facts
        if (abortedWithCalls(await all(h.store))) cutWithCalls += 1
        // The next request, whatever the stop left: its pairing is checked on the wire.
        // oxlint-disable-next-line no-await-in-loop -- the follow-up comes after the stop
        const next = await send(h)
        expect(next.recorded).toBe(true)
        // oxlint-disable-next-line no-await-in-loop -- this round's facts
        assertOneResultEach(await all(h.store))
        expect(h.net.checkFailures).toEqual([])
      }
      // Every kind of stop point was drawn, and some cut a reply short with its calls in it.
      expect(Object.values(drawn).every((count) => count > 0)).toBe(true)
      expect(cutWithCalls).toBeGreaterThan(0)
    })
  }
})

describe('a crash at any point leaves every call paired after recovery (旧 1, crash half)', () => {
  // 旧 1: 崩溃取 200 个随机时点…崩溃的模拟方法是丢掉内存里的循环、在同一个 store 上跑启动恢复. From its k-th
  // append on the store takes nothing more — the process died there, streaming, running a call or
  // with a card waiting — and a new service on the same store recovers; then the next message goes
  // out through the checked wire.
  for (const wire of WIRES) {
    it(`holds over 200 crash points on ${wire}`, { timeout: 120_000 }, async () => {
      const random = seeded(wire === 'anthropic-messages' ? 0x1b873593 : 0x85ebca6b)
      const seen = { crashed: 0, resumable: 0, card: 0 }
      for (let round = 0; round < 200; round += 1) {
        const calls = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, j) => ({
          id: `call_${String(round)}_${String(j)}`,
          at: `${String(round)}-${String(j)}`,
        }))
        // Plain; a card that waits; a card answered, so the crash may land in the Run it resumes;
        // a card a restart's inspector now denies, which leaves the root resumable.
        const roll = random()
        const kind =
          roll < 0.4 ? 'plain' : roll < 0.6 ? 'card' : roll < 0.8 ? 'answered' : 'tightened'
        const asks = kind !== 'plain'
        const asked = calls[Math.floor(random() * calls.length)]?.at ?? ''
        // An uncrashed Run appends 7 + 2n batches (5 + 2m up to a card on call m), and the Run an
        // answer resumes about as many again: some rounds die after it all, and nothing breaks.
        const crashAt =
          1 + Math.floor(random() * ((kind === 'answered' ? 14 : 8) + 2 * calls.length))
        let appends = 0
        let shared: TapeStore | undefined
        const before = harness(
          wire,
          [callTurn(wire, ['Looking.'], calls), textTurn(wire), textTurn(wire)],
          {
            store: (inner) => {
              shared = inner
              return proxyStore(inner, {
                append: (batch) =>
                  (appends += 1) >= crashAt
                    ? Promise.reject(new Error('the process died here'))
                    : inner.append(batch),
              })
            },
            ...(asks ? { inspectors: [askingAt(asked)], host: createMemoryHost() } : {}),
          },
        )
        try {
          // oxlint-disable-next-line no-await-in-loop -- one session at a time: the Tape is the assertion
          const sent = await before.service.send({ sessionId: SESSION, origin: null, text: 'look' })
          // oxlint-disable-next-line no-await-in-loop -- the Run that may die
          const ended = sent.status === 'started' ? await before.loop.runEnded() : null
          if (kind === 'answered' && ended?.reason.code === 'paused') {
            // oxlint-disable-next-line no-await-in-loop -- the card the answer resumes from
            const card = await before.service.currentPending({ sessionId: SESSION })
            // oxlint-disable-next-line no-await-in-loop -- the answer opens the resumed Run
            const answered = await before.service.answer({
              kind: 'approval',
              sessionId: SESSION,
              requestId: card?.card.requestId ?? '',
              decision: 'allow',
              origin: null,
            })
            // oxlint-disable-next-line no-await-in-loop -- the resumed Run that may die
            if (answered.status === 'applied') await before.loop.runEnded()
          }
        } catch {
          // A batch the command itself appends never landed: nothing of it is on the Tape.
        }
        if (appends >= crashAt) seen.crashed += 1
        const store = shared
        if (store === undefined) throw new Error('no store')
        // The restart: a new loop on the same store, recovery first.
        const after = harness(wire, [textTurn(wire), textTurn(wire), textTurn(wire)], {
          store: () => store,
          idsFrom: 1_000_000,
          ...(kind === 'tightened'
            ? { inspectors: [denyingAt(asked)], host: createMemoryHost() }
            : {}),
        })
        // oxlint-disable-next-line no-await-in-loop -- recovery before the first command
        const recovered = await after.service.recover()
        expect(recovered.errors).toEqual([])
        if (recovered.resumable.length > 0) seen.resumable += 1
        // oxlint-disable-next-line no-await-in-loop -- what the recovery left waiting
        if ((await after.service.currentPending({ sessionId: SESSION })) !== null) seen.card += 1
        // oxlint-disable-next-line no-await-in-loop -- the next message after the restart
        const next = await after.service.send({
          sessionId: SESSION,
          origin: null,
          text: 'and now?',
        })
        expect(['started', 'queued']).toContain(next.status)
        // A resumed batch first, then the message: until no lease is left.
        // oxlint-disable-next-line no-await-in-loop -- the loop settles on its own
        while (after.loop.liveLease(SESSION) !== null) await tick()
        expect(after.loop.queued(SESSION)).toEqual([])
        // oxlint-disable-next-line no-await-in-loop -- this round's facts
        assertOneResultEach(await all(store))
        expect(before.net.checkFailures).toEqual([])
        expect(after.net.checkFailures).toEqual([])
        expect(after.net.callCount).toBeGreaterThan(0)
      }
      // The crash points reached a dead Run, a card that survived and a batch left to resume.
      expect(seen.crashed).toBeGreaterThan(0)
      expect(seen.card).toBeGreaterThan(0)
      expect(seen.resumable).toBeGreaterThan(0)
    })
  }
})

describe('rejecting each call of a batch in turn leaves every call paired (旧 1, 验收 14)', () => {
  // 旧 1: 拒绝按批内位置穷举：一批 n 个要批的调用，拒绝第 k 个，k 取遍 1..n — the calls before it allowed
  // one card at a time, then the next request goes out through the checked wire.
  for (const wire of WIRES) {
    it(`pairs every call on ${wire} when call k of n is rejected, for every k`, async () => {
      for (let n = 1; n <= 3; n += 1) {
        for (let k = 1; k <= n; k += 1) {
          const calls = Array.from({ length: n }, (_, j) => ({
            id: `call_${String(n)}_${String(k)}_${String(j)}`,
            at: String(j),
          }))
          const h = harness(wire, [callTurn(wire, [], calls), textTurn(wire)], {
            inspectors: [askAll()],
            host: createMemoryHost(),
          })
          // oxlint-disable-next-line no-await-in-loop -- one session at a time: the Tape is the assertion
          expect((await send(h)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
          for (let j = 1; j <= k; j += 1) {
            // oxlint-disable-next-line no-await-in-loop -- one card at a time, in the batch's order
            const card = await h.service.currentPending({ sessionId: SESSION })
            // oxlint-disable-next-line no-await-in-loop -- the answer opens the next Run
            const answered = await h.service.answer({
              kind: 'approval',
              sessionId: SESSION,
              requestId: card?.card.requestId ?? '',
              decision: j < k ? 'allow' : 'deny',
              origin: null,
            })
            expect(answered).toEqual({ status: 'applied' })
            // oxlint-disable-next-line no-await-in-loop -- that Run's end
            const ended = await h.loop.runEnded()
            expect(ended.reason).toEqual(
              j < k
                ? { code: 'paused', waitingFor: 'approval' }
                : { code: 'user-rejected', toolName: 'look' },
            )
          }
          // oxlint-disable-next-line no-await-in-loop -- the request after the rejection
          expect((await send(h)).reason).toEqual({ code: 'completed' })
          // oxlint-disable-next-line no-await-in-loop -- this case's facts
          const entries = await all(h.store)
          assertOneResultEach(entries)
          expect({ n, k, outcomes: outcomes(entries) }).toEqual({
            n,
            k,
            outcomes: calls.map((_, j) => (j < k - 1 ? 'completed/null' : 'not-run/user-rejected')),
          })
          expect(h.executed).toHaveLength(k - 1)
          expect(h.net.checkFailures).toEqual([])
        }
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
      // Announced once committed, like any closure: the live row reads an internal error.
      expect(repairViews(h)).toEqual(['uncertain'])
    })

    it(`writes only the missing result on ${wire} when the outcome survived (补写缺的那一条)`, async () => {
      // §执行日志与恢复表「损坏」: result 和 outcome 只有一条…补写缺的那一条 — a second outcome under the
      // same key would conflict, and every later send with it.
      const h = harness(
        wire,
        [callTurn(wire, [], [{ id: 'call_1', at: 'a' }]), textTurn(wire), textTurn(wire)],
        { store: losingFirstResultOnly, onUnansweredCall: 'repair' },
      )
      expect(await send(h)).toMatchObject({ reason: { code: 'completed' }, recorded: true })
      const entries = await all(h.store)
      expect(outcomes(entries)).toEqual(['completed/null'])
      expect(entries.filter((entry) => entry.name === 'tool/result')).toHaveLength(1)
      assertOneResultEach(entries)
      expect(await send(h)).toMatchObject({ reason: { code: 'completed' }, recorded: true })
      expect(h.net.checkFailures).toEqual([])
    })

    it(`throws on ${wire} when a turn's blocks and calls disagree, and repairs from the facts`, async () => {
      // §重放怎么排 1: 个数或 providerToolCallId 对不上，按恢复表的「损坏」类处理 — thrown in development
      // and test builds; a packaged build sends the calls its facts hold (B1: 以工具事实为准).
      const calls = [
        { id: 'call_A', at: 'a' },
        { id: 'call_B', at: 'b' },
      ]
      const strict = harness(wire, [callTurn(wire, [], calls), textTurn(wire)], {
        store: losingSecondCall,
      })
      expect(await send(strict)).toMatchObject({ recorded: false, errorCode: 'unknown' })
      expect(strict.net.callCount).toBe(1)
      expect(strict.logs.filter((line) => line.includes('tool-request block'))).toHaveLength(1)

      const repaired = harness(wire, [callTurn(wire, [], calls), textTurn(wire)], {
        store: losingSecondCall,
        onUnansweredCall: 'repair',
      })
      expect((await send(repaired)).reason).toEqual({ code: 'completed' })
      expect(repaired.net.callCount).toBe(2)
      expect(repaired.net.checkFailures).toEqual([])
      expect(JSON.stringify(repaired.net.requests[1]?.body)).not.toContain('call_B')
      expect(repaired.logs.filter((line) => line.includes('repaired'))).toHaveLength(1)
    })
  }
})

/** The `source: 'repair'` outcomes announced, by their execution state. */
function repairViews(h: Harness): string[] {
  return h.loop.recorded.flatMap((event) =>
    event.type === 'tool-outcome' && event.outcome.source === 'repair' ? [event.outcome.state] : [],
  )
}

/** The first result the Run writes never lands, while its outcome does: a partial loss. */
const losingFirstResultOnly = (inner: TapeStore): TapeStore => {
  let lost = false
  return proxyStore(inner, {
    append: (batch) => {
      if (lost || !batch.entries.some((entry) => entry.name === 'tool/result')) {
        return inner.append(batch)
      }
      lost = true
      return inner.append({
        ...batch,
        entries: batch.entries.filter((entry) => entry.name !== 'tool/result'),
      })
    },
  })
}

/** A reply's second `tool/call` never lands: its block has no fact (a corrupt Tape). */
const losingSecondCall = (inner: TapeStore): TapeStore =>
  proxyStore(inner, {
    append: (batch) =>
      inner.append({
        ...batch,
        entries: batch.entries.filter(
          (entry) => !(entry.name === 'tool/call' && entry.payload['ordinal'] === 1),
        ),
      }),
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
    // The row it drew on the tool-call closes: the repair is announced once committed.
    expect(repairViews(h)).toEqual(['uncertain'])
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
