/**
 * The session service's own rules (spec 01 step 12). What it writes to a tape is pinned by the SHARED
 * conformance suite instead — acceptance 3 in full, acceptance 7's tape half, the retry rule and two
 * concurrent runs all run against the memory store here and against the SQLite store in apps/desktop,
 * and a property that only holds on one of them is not a property.
 *
 * What is left for this file is the service's contract with its CALLER: the lifecycle, the read-through
 * a renderer opens on, which failures reject and which are recorded, and the one case that needs a real
 * wire adapter — a connection dropped mid-body after the vendor already billed the turn.
 */
import { describe, expect, it } from 'vitest'
import {
  BaseProvider,
  ZHIPU_DEFAULT_BASE_URL,
  createMemoryTapeStore,
  createSessionService,
  rebuildProviderContext,
  TapeSessionNotFoundError,
  zhipuDefinition,
} from '../../src/index.js'
import type {
  ContentBlock,
  EncodedRequest,
  ModelInfo,
  Provider,
  ProviderId,
  ProviderRequest,
  SendContext,
  SessionService,
  StreamEvent,
  TapeEntry,
  TapeStore,
  ToolSpec,
  Usage,
} from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createStreamGate,
  fakeNetwork,
  scriptedTurn,
} from '../../src/testing/index.js'
import type { ScriptedProvider } from '../../src/testing/index.js'
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

const TOOL: ToolSpec = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
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
}

function harness(): Harness {
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const ids = createCounterIds()
  // A reading per fact; the tape has no clock of its own and `createdAt` is not an ordering key.
  let clock = 1_700_000_000_000
  const service = createSessionService({
    host: {
      clock: {
        now: (): number => {
          clock += 1000
          return clock
        },
      },
    },
    tape: store,
    ids,
  })
  return { store, service, provider: createScriptedProvider({ models: [MODEL] }), ids }
}

function run(
  h: Harness,
  sessionId: string,
  text: string,
  options: {
    readonly provider?: Provider
    readonly model?: ModelInfo
    readonly signal?: AbortSignal
    readonly onEvent?: (event: StreamEvent) => void
  } = {},
): ReturnType<SessionService['runRequest']> {
  return h.service.runRequest({
    sessionId,
    user: { text },
    provider: options.provider ?? h.provider,
    model: options.model ?? MODEL,
    system: 'be brief',
    tools: [TOOL],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  })
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

  it('refuses to run against a session that was never created', async () => {
    const h = harness()
    await expect(run(h, h.ids.uuid(), 'nobody is home')).rejects.toBeInstanceOf(
      TapeSessionNotFoundError,
    )
  })

  it('refuses an empty user turn rather than writing a message with no content', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    await expect(
      h.service.runRequest({
        sessionId,
        user: { text: '' },
        provider: h.provider,
        model: MODEL,
      }),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      h.service.runRequest({
        sessionId,
        user: { content: [] },
        provider: h.provider,
        model: MODEL,
      }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(await allEntries(h.store, sessionId)).toHaveLength(1)
  })
})

describe('one request', () => {
  it('forwards every event as it arrives, terminal included', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    const script = scriptedTurn({ deltas: ['one ', 'two'], usage: USAGE })
    h.provider.script(script)
    const seen: StreamEvent[] = []
    const result = await run(h, sessionId, 'a question', { onEvent: (event) => seen.push(event) })
    expect(seen).toEqual(script)
    expect(seen.at(-1)).toEqual({ type: 'stop', reason: 'end-turn', providerReason: 'end_turn' })
    expect(result.stop).toEqual({ reason: 'end-turn', providerReason: 'end_turn' })
    expect(result.usage).toEqual(USAGE)
    expect(textOf(result.content)).toBe('one two')
    expect(result.identity.requestSeq).toBe(1)
    expect(result.identity.physicalAttempt).toBe(1)
  })

  it('records the run and what it was sent to, with the context it was assembled from', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    h.provider.script(scriptedTurn({ deltas: ['an answer'], usage: USAGE }))
    const result = await run(h, sessionId, 'a question')
    const entries = await allEntries(h.store, sessionId)
    expect(entries.map((entry) => entry.name)).toEqual([
      'session/start',
      'message/user',
      'session/model_selected',
      'message/assistant',
      'provider/attempt_completed',
    ])
    // The user's turn and the model choice land BEFORE the request, in one transaction; the assistant
    // message and the attempt fact land together after it.
    const [, user, model, assistant, attempt] = entries
    expect(model?.payload).toEqual({ providerId: h.provider.id, modelId: MODEL.id })
    expect(user?.sourceType).toBe('message')
    expect(user?.sourceSeq).toBe(0)
    expect(assistant?.payload['runId']).toBe(result.identity.runId)
    expect(attempt?.sourceId).toBe(result.identity.runId)
    expect(attempt?.sourceSeq).toBe(result.identity.requestSeq)
    expect(attempt?.payload['contextAtEntryId']).toBe(model?.entryId)
    expect(attempt?.payload['usage']).toEqual(USAGE)
    expect(attempt?.payload['error']).toBeNull()
    // The request snapshot: what decided the body outside the message list.
    expect(attempt?.payload['request']).toEqual({
      systemHash: expect.any(String),
      maxTokens: MODEL.maxOutputTokens,
    })
  })

  it('persists a truncated turn as complete and records the raw stop reason', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    h.provider.script(
      scriptedTurn({
        deltas: ['as far as it '],
        usage: USAGE,
        terminal: { type: 'stop', reason: 'max-tokens', providerReason: 'max_tokens' },
      }),
    )
    const result = await run(h, sessionId, 'write me an epic')
    // Inside the MessageStatus vocabulary: 'aborted' would tell the interface the user pressed Stop,
    // and dropping the text would lose content the user watched arrive. The reason itself is on the
    // attempt fact, which is where a reader that cares about it looks.
    expect(result.status).toBe('complete')
    expect(result.stop).toEqual({ reason: 'max-tokens', providerReason: 'max_tokens' })
    const rows = await h.service.listMessages({ sessionId, limit: 10 })
    expect(rows.at(-1)?.status).toBe('complete')
    expect(textOf(rows.at(-1)?.content ?? [])).toBe('as far as it ')
    const entries = await allEntries(h.store, sessionId)
    expect(entries.at(-1)?.payload['stop']).toEqual({
      reason: 'max-tokens',
      providerReason: 'max_tokens',
    })
  })

  it('reports a wire error on the fact and writes no assistant message', async () => {
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
    const result = await run(h, sessionId, 'a question')
    expect(result.assistantMessageId).toBeNull()
    expect(result.stop).toBeNull()
    // Every field of the event survives, `retryAfterMs` and `status` included — phase 2's loop reads
    // them off the fact when it decides whether and when to resend.
    expect(result.error).toEqual({
      type: 'error',
      code: 'rate-limit',
      retryable: true,
      retryAfterMs: 1500,
      status: 429,
      providerCode: 'rate_limit_error',
      detail: 'slow down',
    })
    const entries = await allEntries(h.store, sessionId)
    expect(entries.map((entry) => entry.name)).toEqual([
      'session/start',
      'message/user',
      'session/model_selected',
      'provider/attempt_completed',
    ])
    expect(entries.at(-1)?.payload['error']).toEqual(result.error)
    expect(entries.at(-1)?.payload['stop']).toBeNull()
  })

  it('records a stream that ended with no terminal event as a truncated body', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    // Invariant 1 makes this unreachable for a kernel adapter; `provider` is an argument, so the
    // service still may not leave a run without its one attempt fact.
    h.provider.script([{ type: 'text-delta', index: 0, text: 'half a ' }])
    const result = await run(h, sessionId, 'a question')
    expect(result.error?.code).toBe('network')
    expect(result.error?.retryable).toBe(true)
    expect(result.assistantMessageId).toBeNull()
    const entries = await allEntries(h.store, sessionId)
    expect(entries.at(-1)?.name).toBe('provider/attempt_completed')
  })

  it('refuses a model belonging to another provider before it writes anything', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    // A programmer error rejects rather than being recorded (§中止、重试、错误). This one is checked up
    // front, because past the pre-run write `session/model_selected` — and through it
    // `session_projection` — would advertise a provider / model pair that can never be encoded, for a
    // run that never happened.
    await expect(
      run(h, sessionId, 'a question', { model: { ...MODEL, providerId: 'someone-else' } }),
    ).rejects.toThrow(/someone-else/)
    expect((await allEntries(h.store, sessionId)).map((entry) => entry.name)).toEqual([
      'session/start',
    ])
  })

  it('leaves a user message with no attempt fact when the run dies after the pre-run write', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    // `maxTokens: 0` is refused by the encoder, which runs AFTER the user's turn is on the tape: the
    // documented crash shape, reached here without a crash.
    await expect(
      h.service.runRequest({
        sessionId,
        user: { text: 'a question' },
        provider: h.provider,
        model: MODEL,
        maxTokens: 0,
      }),
    ).rejects.toThrow(/max_tokens/)
    // The turn is not lost, nothing claims the request happened, and resending the same text is
    // still a retry of this message rather than a second turn.
    const entries = await allEntries(h.store, sessionId)
    expect(entries.map((entry) => entry.name)).toEqual([
      'session/start',
      'message/user',
      'session/model_selected',
    ])
    h.provider.script(scriptedTurn({ deltas: ['an answer'], usage: USAGE }))
    const retried = await run(h, sessionId, 'a question')
    expect(retried.userMessageCreated).toBe(false)
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
      atEntryId: second.contextAtEntryId,
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
  it('rejects the run instead of resurrecting the session without its anchor', async () => {
    const h = harness()
    const { sessionId } = await h.service.createSession()
    h.provider.script(scriptedTurn({ deltas: ['the answer to delete'], usage: USAGE }))
    const started = deferred()
    const release = deferred()
    const provider = new PausingProvider(h.provider, started.resolve, release.promise)
    const running = h.service.runRequest({
      sessionId,
      user: { text: 'secret question' },
      provider,
      model: MODEL,
    })
    await started.promise
    await h.service.deleteSession(sessionId)
    release.resolve()

    // The run holds the incarnation it read before the delete, and a store creates a head row only
    // for a batch that OPENS with `session/start`. So the terminal write fails loudly instead of
    // bringing the session back with a `message/assistant` as the first fact of an incarnation whose
    // entry ids restart at 1 — content the user asked to delete, back on disk and back in the
    // session list, with every snapshot coordinate into it now pointing at a different fact.
    await expect(running).rejects.toBeInstanceOf(TapeSessionNotFoundError)
    expect(await h.store.head(sessionId)).toBeNull()
    expect(await allEntries(h.store, sessionId)).toEqual([])
    expect(await h.service.latestSession({ limit: 10 })).toBeNull()
  })
})

describe('a connection dropped mid-body', () => {
  it('records a retryable network error and keeps the usage the turn already cost', async () => {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const ids = createCounterIds()
    let clock = 1_700_000_000_000
    const service = createSessionService({
      host: {
        clock: {
          now: (): number => {
            clock += 1000
            return clock
          },
        },
      },
      tape: store,
      ids,
    })
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
      clock: { now: () => clock },
      config: { baseURL: ZHIPU_DEFAULT_BASE_URL },
      secrets: { apiKey: 'test-key-not-a-real-credential' },
    })
    const model = zhipuDefinition.builtinModels[0]
    if (model === undefined) throw new Error('the zhipu definition has no builtin model')
    const { sessionId } = await service.createSession()
    // Role chunk, usage chunk, first text chunk: enough for one delta with a reading already consumed.
    gate.release(3)
    const result = await service.runRequest({
      sessionId,
      user: { text: 'a question' },
      provider,
      model,
      onEvent: (event) => {
        // The connection dies the moment the first delta lands. Deterministic, and no timers.
        if (event.type === 'text-delta') gate.fail()
      },
    })
    expect(result.error?.code).toBe('network')
    expect(result.error?.retryable).toBe(true)
    expect(result.stop).toBeNull()
    // A billed turn must not be indistinguishable from a free one later.
    expect(result.usage?.final).toBe(true)
    expect(result.usage?.inputTokens).toBe(openAIFixture.PROMPT_TOKENS)
    const entries = await store.readRange({ sessionId, limit: 100 })
    const attempt = entries.entries.at(-1)
    expect(attempt?.name).toBe('provider/attempt_completed')
    expect(attempt?.payload['usage']).toEqual(result.usage)
    expect(attempt?.payload['error']).toEqual(result.error)
    // A failed turn writes no assistant message, partial text or not.
    expect(entries.entries.map((entry) => entry.name)).not.toContain('message/assistant')
    await store.close()
  })
})
