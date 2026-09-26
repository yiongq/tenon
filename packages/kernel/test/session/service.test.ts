/**
 * The session service's own rules (spec 01 step 12; spec 02 plan step 9). What it writes to a tape is
 * pinned by the SHARED conformance suite instead — acceptance 3 in full, acceptance 7's tape half, the
 * retry rule and two sessions running at once all run against the memory store here and against the
 * SQLite store in apps/desktop, and a property that only holds on one of them is not a property.
 *
 * What is left for this file is the service's contract with its CALLER: the constructor and the loop
 * commands' shapes, the lifecycle, the read-through a renderer opens on, which failures are recorded
 * and which only end the Run, and the one case that needs a real wire adapter — a connection dropped
 * mid-body after the vendor already billed the turn. The mailbox's own rules are test/loop/.
 */
import { describe, expect, it } from 'vitest'
import {
  BaseProvider,
  ZHIPU_DEFAULT_BASE_URL,
  createMemoryHost,
  createMemoryTapeStore,
  createSessionService,
  rebuildProviderContext,
  zhipuDefinition,
} from '../../src/index.js'
import type {
  ContentBlock,
  EncodedRequest,
  HostAdapter,
  InspectorRegistration,
  ModelInfo,
  Provider,
  ProviderId,
  ProviderRequest,
  // @ts-expect-error — spec 02 removed it with runRequest (旧 225)
  RunRequestQuery,
  // @ts-expect-error — and this one
  RunResult,
  SendContext,
  SessionEvent,
  SessionService,
  StreamEvent,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createStreamGate,
  createTestLoopPorts,
  fakeNetwork,
  scriptedTurn,
} from '../../src/testing/index.js'
import type { ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'
import * as openAIFixture from '../provider/fixtures/openai-sse.js'

const IDENTITY = {
  userId: 'service-user',
  tenantId: 'service-tenant',
  profileDir: '/tenon/service',
}

const MODEL: ModelInfo = {
  id: 'claude-service-1',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 2048,
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

interface Harness {
  readonly store: TapeStore
  readonly service: SessionService
  readonly provider: ScriptedProvider
  readonly ids: ReturnType<typeof createCounterIds>
  readonly loop: TestLoopPorts
}

/** A memory host whose clock moves a second per reading: `createdAt` is not an ordering key. */
function tickingHost(): HostAdapter {
  const host = createMemoryHost()
  let clock = 1_700_000_000_000
  return {
    ...host,
    clock: {
      now: (): number => {
        clock += 1000
        return clock
      },
      setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms),
    },
  }
}

function harness(
  options: {
    readonly provider?: Provider
    readonly model?: ModelInfo
    readonly maxTokens?: number
    readonly onEvent?: (event: SessionEvent) => void
  } = {},
): Harness {
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const ids = createCounterIds()
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({
    connector: {
      provider: options.provider ?? provider,
      model: options.model ?? MODEL,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    },
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  })
  const service = createSessionService({
    host: tickingHost(),
    tape: store,
    ids,
    inspectors: [],
    connector: loop.connector,
    protectedFiles: [],
  })
  service.bindLoop(loop)
  return { store, service, provider, ids, loop }
}

/** What one Run left behind, read back from the tape and the loop's events. */
interface Ran {
  readonly runId: string
  readonly ended: Extract<SessionEvent, { type: 'run-ended' }>
  readonly attempt: TapeEntry | undefined
  readonly assistant: TapeEntry | undefined
}

/** One message through the loop: `send`, the Run's end, and what it wrote. */
async function run(h: Harness, sessionId: string, text: string): Promise<Ran> {
  const sent = await h.service.send({ sessionId, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  const ended = await h.loop.runEnded({ runId: sent.runId })
  const entries = await allEntries(h.store, sessionId)
  return {
    runId: sent.runId,
    ended,
    attempt: entries.find(
      (entry) => entry.name === 'provider/attempt_completed' && entry.sourceId === sent.runId,
    ),
    assistant: entries.find(
      (entry) => entry.name === 'message/assistant' && entry.payload['runId'] === sent.runId,
    ),
  }
}

async function allEntries(store: TapeStore, sessionId: string): Promise<TapeEntry[]> {
  const page = await store.readRange({ sessionId, limit: 1000 })
  return page.entries
}

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * Never called: what the service's shape refuses is a compile error, checked by `tsc` (旧 225, 旧
 * 238). Called, the constructors below would throw on the member they leave out.
 */
function refusedShapes(service: SessionService, sessionId: string): void {
  const loop = createTestLoopPorts()
  const base = {
    host: createMemoryHost(),
    tape: createMemoryTapeStore({ identity: IDENTITY }),
    ids: createCounterIds(),
  }
  // @ts-expect-error — `inspectors` is required
  createSessionService({ ...base, connector: loop.connector, protectedFiles: [] })
  // @ts-expect-error — `connector` is required
  createSessionService({ ...base, inspectors: [], protectedFiles: [] })
  // @ts-expect-error — `protectedFiles` is required
  createSessionService({ ...base, inspectors: [], connector: loop.connector })
  createSessionService({
    ...base,
    // @ts-expect-error — a clock alone is no longer a host (01 spec:82 wrote the whole HostAdapter)
    host: { clock: { now: () => 0 } },
    inspectors: [],
    connector: loop.connector,
    protectedFiles: [],
  })
  // @ts-expect-error — phase 1's one-request door is gone; a request is what a Run sends
  void service.runRequest
  // @ts-expect-error — the Run assembles its own system prompt (plan step 18)
  void service.send({ sessionId, origin: null, text: 'hi', system: 'be brief' })
  // @ts-expect-error — and freezes its own tool table (plan step 10)
  void service.send({ sessionId, origin: null, text: 'hi', tools: [] })
  const gone: RunRequestQuery | RunResult | undefined = undefined
  void gone
}

describe('the constructor and the loop commands (spec 02 plan step 9)', () => {
  it('refuses the shapes spec 02 removed, at compile time', () => {
    expect(refusedShapes).toBeTypeOf('function')
  })

  it('refuses every loop command before bindLoop and writes nothing', async () => {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const loop = createTestLoopPorts()
    const service = createSessionService({
      host: createMemoryHost(),
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
    })
    const sessionId = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'
    expect(await service.send({ sessionId, origin: null, text: 'hi' })).toEqual({
      status: 'refused',
      code: 'not-bound',
    })
    expect(await service.continueRun({ sessionId, origin: null })).toEqual({ status: 'refused' })
    expect(
      await service.answer({
        kind: 'approval',
        sessionId,
        requestId: 'r',
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'refused' })
    expect(await service.resume({ rootSessionId: sessionId, origin: null })).toEqual({
      status: 'refused',
    })
    expect(await service.stop({ rootSessionId: sessionId })).toEqual({ stopped: false })
    expect(await store.head(sessionId)).toBeNull()
    expect(loop.leaseLog).toEqual([])
    expect(loop.connector.calls.resolveChoice).toBe(0)

    service.bindLoop(loop)
    expect(() => service.bindLoop(loop)).toThrow(/already bound/)
  })

  it('refuses an inspector registering the after-result hook, and two with one id', () => {
    const loop = createTestLoopPorts()
    const inspector: InspectorRegistration = {
      id: 'watcher',
      kind: 'local-rule',
      ceiling: 'ask',
      beforeCall: () => Promise.resolve({ kind: 'none' }),
    }
    const construct = (inspectors: readonly InspectorRegistration[]): SessionService =>
      createSessionService({
        host: createMemoryHost(),
        tape: createMemoryTapeStore({ identity: IDENTITY }),
        ids: createCounterIds(),
        inspectors,
        connector: loop.connector,
        protectedFiles: [],
      })
    expect(() => construct([inspector])).not.toThrow()
    // Phase 2 never calls it, and a registration carrying one would look as if it ran (F10).
    expect(() => construct([{ ...inspector, afterResult: () => Promise.resolve([]) }])).toThrow(
      /afterResult/,
    )
    expect(() => construct([inspector, inspector])).toThrow(/share the id/)
  })
})

describe('session lifecycle', () => {
  it('opens a session with session/start as the first fact of the incarnation', async () => {
    const h = harness()
    const created = await h.service.createSession()
    const entries = await allEntries(h.store, created.sessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('session/start')
    expect(entries[0]?.entryId).toBe(created.startEntryId)
    expect(entries[0]?.payload).toEqual({ incarnationId: created.incarnationId })
    // The chain of a fresh incarnation starts here.
    expect(entries[0]?.prevHash).toBeNull()
  })

  it('carries a fork origin, entryHash included, on the anchor', async () => {
    const h = harness()
    const parent = await h.service.createSession()
    const parentEntries = await allEntries(h.store, parent.sessionId)
    const anchor = parentEntries[0]
    if (anchor === undefined) throw new Error('the parent has no anchor')
    const forkedFrom = {
      sessionId: parent.sessionId,
      incarnationId: parent.incarnationId,
      entryId: anchor.entryId,
      // Lowercase hex: a payload is JSON, and lineage has to be checkable against the chain.
      entryHash: [...anchor.entryHash].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    }
    const child = await h.service.createSession({ forkedFrom })
    const childEntries = await allEntries(h.store, child.sessionId)
    expect(childEntries[0]?.payload).toEqual({ incarnationId: child.incarnationId, forkedFrom })
    const summary = (await h.store.listSessions({ limit: 10 })).find(
      (row) => row.sessionId === child.sessionId,
    )
    expect(summary?.forkedFromSessionId).toBe(parent.sessionId)
  })

  it('resets into a new incarnation and deletes on request', async () => {
    const h = harness()
    const { sessionId, incarnationId } = await h.service.createSession()
    h.provider.script(scriptedTurn({ deltas: ['an answer'], usage: USAGE }))
    await run(h, sessionId, 'a question')
    expect(await h.service.listMessages({ sessionId, limit: 10 })).toHaveLength(2)

    const reset = await h.service.resetSession(sessionId)
    expect(reset.incarnationId).not.toBe(incarnationId)
    const entries = await allEntries(h.store, sessionId)
    expect(entries.map((entry) => entry.name)).toEqual(['session/start'])
    expect(entries[0]?.payload).toEqual({ incarnationId: reset.incarnationId })
    expect(entries[0]?.entryId).toBeGreaterThan(reset.startEntryId - 1)
    expect(await h.service.listMessages({ sessionId, limit: 10 })).toEqual([])

    await h.service.deleteSession(sessionId)
    expect(await h.store.head(sessionId)).toBeNull()
    expect(await h.service.latestSession({ limit: 10 })).toBeNull()
  })

  it('opens the session id the caller already owns, and refuses one that is not a UUID', async () => {
    const h = harness()
    // The desktop renderer mints its own session id and filters every event on it; main opens THAT
    // id rather than keeping a renderer-id → tape-id map.
    const sessionId = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'
    const created = await h.service.createSession({ sessionId })
    expect(created.sessionId).toBe(sessionId)
    const entries = await allEntries(h.store, sessionId)
    expect(entries.map((entry) => entry.name)).toEqual(['session/start'])
    await expect(h.service.createSession({ sessionId: 'not-a-uuid' })).rejects.toBeInstanceOf(
      TypeError,
    )
    await expect(
      h.service.send({ sessionId: 'not-a-uuid', origin: null, text: 'hi' }),
    ).rejects.toBeInstanceOf(TypeError)
  })

  it('creates the session with the first message, in the same batch', async () => {
    const h = harness()
    const sessionId = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'
    h.provider.script(scriptedTurn({ deltas: ['an answer'], usage: USAGE }))
    // No createSession: the renderer's id becomes a session when its first send opens a Run
    // (§会话形态「建立前暂存」), replacing the desktop's ensureSession.
    const ran = await run(h, sessionId, 'a question')
    const entries = await allEntries(h.store, sessionId)
    expect(entries.map((entry) => entry.name)).toEqual([
      'session/start',
      'message/user',
      'execution/run_started',
      'session/model_selected',
      'view/content',
      'view/tool_table',
      'view/assembled',
      'message/assistant',
      'provider/attempt_completed',
    ])
    expect(ran.ended.recorded).toBe(true)
    // The second message finds the session and writes no second anchor.
    h.provider.script(scriptedTurn({ deltas: ['another'], usage: USAGE }))
    await run(h, sessionId, 'again')
    const names = (await allEntries(h.store, sessionId)).map((entry) => entry.name)
    expect(names.filter((name) => name === 'session/start')).toHaveLength(1)
  })

  it('restores the newest session that has messages, not a newer empty one', async () => {
    const h = harness()
    const chatted = await h.service.createSession()
    h.provider.script(scriptedTurn({ deltas: ['an answer'], usage: USAGE }))
    await run(h, chatted.sessionId, 'a question')
    // Opened afterwards and never used: `session/start` bumps `updated_at`, so the newest row is this
    // one — and restoring it would lose the conversation acceptance 5 is about.
    await h.service.createSession()
    const latest = await h.service.latestSession({ limit: 10 })
    expect(latest?.sessionId).toBe(chatted.sessionId)
    expect(latest?.messages).toHaveLength(2)
  })

  it('reads the newest session and the tail of its messages back', async () => {
    const h = harness()
    const first = await h.service.createSession()
    h.provider.script(scriptedTurn({ deltas: ['first answer'], usage: USAGE }))
    await run(h, first.sessionId, 'first question')
    const second = await h.service.createSession()
    h.provider.script(scriptedTurn({ deltas: ['second answer'], usage: USAGE }))
    await run(h, second.sessionId, 'second question')

    const latest = await h.service.latestSession({ limit: 10 })
    expect(latest?.sessionId).toBe(second.sessionId)
    expect(latest?.messages.map((row) => [row.role, textOf(row.content)])).toEqual([
      ['user', 'second question'],
      ['assistant', 'second answer'],
    ])
    // The page a renderer asks for afterwards is the same read, by session id.
    expect(await h.service.listMessages({ sessionId: first.sessionId, limit: 10 })).toHaveLength(2)
  })

  it('refuses an empty message rather than writing one with no content', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    await expect(h.service.send({ sessionId, origin: null, text: '' })).rejects.toBeInstanceOf(
      TypeError,
    )
    expect(await allEntries(h.store, sessionId)).toHaveLength(1)
    expect(h.loop.leaseLog).toEqual([])
  })
})

describe('one request', () => {
  it('forwards every delta as it arrives, then the end', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    h.provider.script(scriptedTurn({ deltas: ['one ', 'two'], usage: USAGE }))
    const ran = await run(h, sessionId, 'a question')
    const events = h.loop.recorded.map((event) =>
      event.type === 'text-delta' ? [event.type, event.delta] : [event.type],
    )
    expect(events).toEqual([
      ['run-started'],
      ['user-message'],
      ['text-delta', 'one '],
      ['text-delta', 'two'],
      ['run-ended'],
    ])
    expect(ran.ended).toMatchObject({
      runId: ran.runId,
      reason: { code: 'completed' },
      recorded: true,
      lastStop: 'end-turn',
      errorCode: null,
    })
    expect(ran.attempt?.payload['stop']).toEqual({ reason: 'end-turn', providerReason: 'end_turn' })
    expect(ran.attempt?.payload['usage']).toEqual(USAGE)
    expect(textOf((ran.assistant?.payload['content'] ?? []) as ContentBlock[])).toBe('one two')
    // One request, recorded as the first transmission of the first payload.
    expect(ran.attempt?.sourceSeq).toBe(1)
    expect(ran.attempt?.provenanceKey).toMatch(/:1:1$/)
  })

  it('records the run and what it was sent to, with the context it was assembled from', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    h.provider.script(scriptedTurn({ deltas: ['an answer'], usage: USAGE }))
    const ran = await run(h, sessionId, 'a question')
    const entries = await allEntries(h.store, sessionId)
    expect(entries.map((entry) => entry.name)).toEqual([
      'session/start',
      'message/user',
      'execution/run_started',
      'session/model_selected',
      'view/content',
      'view/tool_table',
      'view/assembled',
      'message/assistant',
      'provider/attempt_completed',
    ])
    // The user's turn, the Run's start and the model choice land BEFORE the request, in one
    // transaction; the assistant message and the attempt fact land together after it.
    const [, user, started, model, , , assembled, assistant, attempt] = entries
    expect(started?.sourceId).toBe(ran.runId)
    expect(started?.payload).toEqual({
      cause: { kind: 'user-message', messageId: user?.payload['messageId'] },
    })
    expect(model?.payload).toEqual({ providerId: h.provider.id, modelId: MODEL.id })
    expect(user?.sourceType).toBe('message')
    expect(user?.sourceSeq).toBe(0)
    expect(assistant?.payload['runId']).toBe(ran.runId)
    expect(attempt?.sourceId).toBe(ran.runId)
    expect(attempt?.sourceSeq).toBe(1)
    expect(attempt?.payload['contextAtEntryId']).toBe(model?.entryId)
    expect(attempt?.payload['usage']).toEqual(USAGE)
    expect(attempt?.payload['error']).toBeNull()
    // What the request was assembled from, written after encode() and before the stream (A3).
    expect(attempt?.payload['assemblyRef']).toBe(assembled?.provenanceKey)
    // The request snapshot: no system prompt before plan step 18, the connector's max tokens.
    expect(attempt?.payload['request']).toEqual({
      systemHash: expect.any(String),
      maxTokens: MODEL.maxOutputTokens,
    })
    // And no tools before plan step 10.
    const body = h.provider.requests.at(-1)?.body as { system?: unknown; tools?: unknown }
    expect(body.system).toBeUndefined()
    expect(body.tools).toBeUndefined()
  })

  it('persists a truncated turn as complete and ends the Run as output-truncated', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    h.provider.script(
      scriptedTurn({
        deltas: ['as far as it '],
        usage: USAGE,
        terminal: { type: 'stop', reason: 'max-tokens', providerReason: 'max_tokens' },
      }),
    )
    const ran = await run(h, sessionId, 'write me an epic')
    // Inside the MessageStatus vocabulary: 'aborted' would tell the interface the user pressed Stop,
    // and dropping the text would lose content the user watched arrive.
    expect(ran.assistant?.payload['status']).toBe('complete')
    expect(ran.ended.reason).toEqual({ code: 'output-truncated', maxTokens: MODEL.maxOutputTokens })
    expect(ran.ended.lastStop).toBe('max-tokens')
    const rows = await h.service.listMessages({ sessionId, limit: 10 })
    expect(rows.at(-1)?.status).toBe('complete')
    expect(textOf(rows.at(-1)?.content ?? [])).toBe('as far as it ')
    expect(ran.attempt?.payload['stop']).toEqual({
      reason: 'max-tokens',
      providerReason: 'max_tokens',
    })
  })

  it('reports a wire error on the fact, writes no assistant message and names the code', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    h.provider.script(
      scriptedTurn({
        deltas: ['half a '],
        terminal: {
          type: 'error',
          code: 'rate-limit',
          retryable: true,
          retryAfterMs: 1500,
          status: 429,
          providerCode: 'rate_limit_error',
          detail: 'slow down',
        },
      }),
    )
    const ran = await run(h, sessionId, 'a question')
    expect(ran.assistant).toBeUndefined()
    // Every field of the event survives, `retryAfterMs` and `status` included — the loop reads
    // them off the fact when it decides whether and when to resend (plan step 13).
    expect(ran.attempt?.payload['error']).toEqual({
      type: 'error',
      code: 'rate-limit',
      retryable: true,
      retryAfterMs: 1500,
      status: 429,
      providerCode: 'rate_limit_error',
      detail: 'slow down',
    })
    expect(ran.attempt?.payload['stop']).toBeNull()
    expect(ran.ended).toMatchObject({
      reason: {
        code: 'provider-error',
        providerId: h.provider.id,
        errorCode: 'rate-limit',
        providerReason: 'rate_limit_error',
        attempts: 1,
      },
      recorded: true,
      lastStop: null,
      errorCode: 'rate-limit',
    })
    expect((await allEntries(h.store, sessionId)).map((entry) => entry.name)).toEqual([
      'session/start',
      'message/user',
      'execution/run_started',
      'session/model_selected',
      'view/content',
      'view/tool_table',
      'view/assembled',
      'provider/attempt_completed',
    ])
  })

  it('ends a quota error as quota-exhausted with its reset time', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    const resetAt = Date.UTC(2026, 9, 1)
    h.provider.script(
      scriptedTurn({
        deltas: [],
        terminal: {
          type: 'error',
          code: 'quota-exhausted',
          retryable: false,
          status: 429,
          resetAt,
          providerCode: 'rate_limit_error',
          detail: 'spend limit',
        },
      }),
    )
    const ran = await run(h, sessionId, 'a question')
    expect(ran.ended.reason).toEqual({
      code: 'quota-exhausted',
      providerId: h.provider.id,
      resetAt,
    })
    // The fact keeps 01's error shape: `resetAt` travels on the end reason only.
    expect(ran.attempt?.payload['error']).not.toHaveProperty('resetAt')
  })

  it('records a stream that ended with no terminal event as a truncated body', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    // Invariant 1 makes this unreachable for a kernel adapter; the provider comes from the
    // connector, so the Run still may not leave a request without its one attempt fact.
    h.provider.script([{ type: 'text-delta', index: 0, text: 'half a ' }])
    const ran = await run(h, sessionId, 'a question')
    expect(ran.attempt?.payload['error']).toMatchObject({ code: 'network', retryable: true })
    expect(ran.assistant).toBeUndefined()
    expect((await allEntries(h.store, sessionId)).at(-1)?.name).toBe('provider/attempt_completed')
  })

  it('refuses a model belonging to another provider before it writes anything', async () => {
    const h = harness({ model: { ...MODEL, providerId: 'someone-else' } })
    const { sessionId } = await h.service.createSession()
    // A programmer error rejects rather than being recorded. It is checked before the pre-run write,
    // because past it `session/model_selected` — and through it `session_projection` — would
    // advertise a provider / model pair that can never be encoded, for a Run that never happened.
    await expect(h.service.send({ sessionId, origin: null, text: 'a question' })).rejects.toThrow(
      /someone-else/,
    )
    expect((await allEntries(h.store, sessionId)).map((entry) => entry.name)).toEqual([
      'session/start',
    ])
    // The lease it held is finished: the root is free.
    expect(h.loop.liveLease(sessionId)).toBeNull()
  })

  it('leaves a user message with no attempt fact when the Run dies after the pre-run write', async () => {
    const h = harness({ maxTokens: 0 })
    const { sessionId } = await h.service.createSession()
    // `maxTokens: 0` is refused by the encoder, which runs AFTER the pre-run batch: the documented
    // crash shape, reached here without a crash. The host is told the Run ended, unrecorded.
    const sent = await h.service.send({ sessionId, origin: null, text: 'a question' })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    const ended = await h.loop.runEnded({ runId: sent.runId })
    expect(ended).toMatchObject({ recorded: false, errorCode: 'unknown', lastStop: null })
    expect(h.loop.liveLease(sessionId)).toBeNull()
    // The turn is not lost, nothing claims the request happened, and resending the same text is
    // still a retry of this message rather than a second turn.
    const entries = await allEntries(h.store, sessionId)
    expect(entries.map((entry) => entry.name)).toEqual([
      'session/start',
      'message/user',
      'execution/run_started',
      'session/model_selected',
    ])
    h.loop.connector.use({ provider: h.provider, model: MODEL })
    h.provider.script(scriptedTurn({ deltas: ['an answer'], usage: USAGE }))
    await run(h, sessionId, 'a question')
    const users = (await allEntries(h.store, sessionId)).filter(
      (entry) => entry.name === 'message/user',
    )
    expect(users).toHaveLength(1)
  })

  it('assembles the context from the tape, not from what the caller passed', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    h.provider.script(scriptedTurn({ deltas: ['first answer'], usage: USAGE }))
    await run(h, sessionId, 'first question')
    h.provider.script(scriptedTurn({ deltas: ['second answer'], usage: USAGE }))
    const second = await run(h, sessionId, 'second question')
    const sent = h.provider.requests.at(-1)
    const body = sent?.body as { messages?: { role: string; content: unknown }[] }
    expect(body.messages?.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    // And the same context comes back out of the tape at the pin the fact recorded.
    const replayed = await rebuildProviderContext(h.store, {
      sessionId,
      atEntryId: second.attempt?.payload['contextAtEntryId'] as number,
      target: MODEL,
    })
    expect(replayed.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
  })
})

/** A promise a test resolves by hand: how a run is held open without a timer. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    settle = done
  })
  // The executor already ran, synchronously, so `settle` is assigned.
  return { promise, resolve: () => settle?.() }
}

/**
 * A provider that announces it started and then waits — the only way to hold a run open BETWEEN its
 * pre-run batch and its terminal one, deterministically and with no timer.
 */
class PausingProvider extends BaseProvider {
  readonly id: ProviderId
  readonly #inner: ScriptedProvider
  readonly #started: () => void
  readonly #release: Promise<void>

  constructor(inner: ScriptedProvider, started: () => void, release: Promise<void>) {
    super()
    this.id = inner.id
    this.#inner = inner
    this.#started = started
    this.#release = release
  }

  models(): Promise<ModelInfo[]> {
    return this.#inner.models()
  }

  encode(req: ProviderRequest): EncodedRequest {
    return this.#inner.encode(req)
  }

  async *stream(encoded: EncodedRequest, ctx: SendContext): AsyncIterable<StreamEvent> {
    this.#started()
    await this.#release
    yield* this.#inner.stream(encoded, ctx)
  }
}

describe('a session deleted under a running request', () => {
  it('ends the Run unrecorded instead of resurrecting the session without its anchor', async () => {
    const inner = createScriptedProvider({ models: [MODEL] })
    const started = deferred()
    const release = deferred()
    const provider = new PausingProvider(inner, started.resolve, release.promise)
    const h = harness({ provider })
    const { sessionId } = await h.service.createSession()
    inner.script(scriptedTurn({ deltas: ['the answer to delete'], usage: USAGE }))
    const sent = await h.service.send({ sessionId, origin: null, text: 'secret question' })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    await started.promise
    await h.service.deleteSession(sessionId)
    release.resolve()

    // The Run holds the incarnation it opened in, and a store creates a head row only for a batch
    // that OPENS with `session/start`. So the terminal write fails instead of bringing the session
    // back with a `message/assistant` as the first fact of an incarnation whose entry ids restart at
    // 1 — content the user asked to delete, back on disk and back in the session list.
    const ended = await h.loop.runEnded({ runId: sent.runId })
    expect(ended.recorded).toBe(false)
    expect(await h.store.head(sessionId)).toBeNull()
    expect(await allEntries(h.store, sessionId)).toEqual([])
    expect(await h.service.latestSession({ limit: 10 })).toBeNull()
  })
})

describe('a connection dropped mid-body', () => {
  it('records a retryable network error and keeps the usage the turn already cost', async () => {
    // The real OpenAI-compatible adapter, through a definition: this is the one case the scripted
    // provider cannot stand in for, because what is being checked is the adapter's own behaviour when
    // the body dies after the vendor already stated what the turn cost.
    const gate = createStreamGate()
    const net = fakeNetwork({
      kind: 'sse',
      frames: openAIFixture.USAGE_BEFORE_TEXT_FRAMES,
      gate,
    })
    const provider = zhipuDefinition.create({
      network: net,
      clock: { now: () => 0, setTimeout: () => () => undefined },
      config: { baseURL: ZHIPU_DEFAULT_BASE_URL },
      secrets: { apiKey: 'test-key-not-a-real-credential' },
    })
    const model = zhipuDefinition.builtinModels[0]
    if (model === undefined) throw new Error('the zhipu definition has no builtin model')
    // The connection dies the moment the first delta lands. Deterministic, and no timers.
    const h = harness({
      provider,
      model,
      onEvent: (event) => {
        if (event.type === 'text-delta') gate.fail()
      },
    })
    const { sessionId } = await h.service.createSession()
    // Role chunk, usage chunk, first text chunk: enough for one delta with a reading already consumed.
    gate.release(3)
    const ran = await run(h, sessionId, 'a question')
    const error = ran.attempt?.payload['error'] as { code: string; retryable: boolean }
    expect(error.code).toBe('network')
    expect(error.retryable).toBe(true)
    expect(ran.attempt?.payload['stop']).toBeNull()
    // A billed turn must not be indistinguishable from a free one later.
    const usage = ran.attempt?.payload['usage'] as Usage | null
    expect(usage?.final).toBe(true)
    expect(usage?.inputTokens).toBe(openAIFixture.PROMPT_TOKENS)
    // A failed turn writes no assistant message, partial text or not.
    expect(ran.assistant).toBeUndefined()
    expect(ran.ended).toMatchObject({ recorded: true, errorCode: 'network' })
    await h.store.close()
  })
})
