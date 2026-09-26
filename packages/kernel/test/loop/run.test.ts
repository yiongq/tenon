/**
 * The Run's rounds and its end (spec 02 §主循环与 Run 的结束, §一轮回复怎么分流, §上限、守卫与用量,
 * §重试与「继续」; plan step 13: 旧 12, 旧 30, 旧 128, 旧 129, 旧 29, 旧 130, 旧 3, 02 不变量 14, 旧 27,
 * 旧 127, 旧 28, the event order, 旧 131).
 *
 * The calls go to a connector tool the user set to always-allow (layer 6), so a batch runs without a
 * card; a deny inspector stands in for a machine denial and an ask one for a card. What needs the
 * answers (a pause across a restart, the step count carried by a resume) is plan step 15's; the
 * compaction retry of an overflow is step 30's.
 */
import { describe, expect, it } from 'vitest'
import {
  ZHIPU_DEFAULT_BASE_URL,
  createMemoryHost,
  createMemoryTapeStore,
  zhipuDefinition,
} from '../../src/index.js'
import type {
  ContentBlock,
  HostAdapter,
  InspectorRegistration,
  LoopPorts,
  McpConnection,
  ModelInfo,
  Provider,
  SendContext,
  SessionEvent,
  SessionService,
  StopReason,
  StreamEvent,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import {
  assertLastTurnIsUser,
  assertToolPairing,
  createCounterIds,
  createFakeInspector,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type { RecordedRequest, ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'
import { MODEL_NOTES } from '../../src/prompts/index.js'
import * as openAIFixture from '../provider/fixtures/openai-sse.js'

const IDENTITY = { userId: 'run-user', tenantId: 'run-tenant', profileDir: '/tenon/run' }
const SESSION = '5a2c9a2e-6b3d-4a71-9f52-0c8de7a11b35'

const MODEL: ModelInfo = {
  id: 'claude-run-1',
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

/** The connector tool every batch calls: `look` on server `fs`, under its provider name. */
const LOOK = 'fs__look'

type RunEnded = Extract<SessionEvent, { type: 'run-ended' }>

interface Harness {
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  /** What each `stream()` was handed, in order. */
  readonly sends: SendContext[]
  /** The arguments of every connector call that ran, in order. */
  readonly executed: Record<string, unknown>[]
  /** Every delay the loop waited on the host clock. */
  readonly delays: number[]
  readonly logs: string[]
}

interface HarnessOptions {
  readonly inspectors?: readonly InspectorRegistration[]
  readonly tokenLimit?: number
  readonly store?: TapeStore
  readonly onEvent?: (event: SessionEvent) => void
  /** The ports the service is bound to, when a case needs to hold one of them. */
  readonly ports?: (loop: TestLoopPorts) => LoopPorts
}

/** A host whose timers fire at once, each delay recorded: a backoff is asserted, not waited for. */
function instantHost(delays: number[]): HostAdapter {
  const host = createMemoryHost()
  let clock = 1_000
  return {
    ...host,
    clock: {
      now: (): number => (clock += 1),
      setTimeout: (fn, ms): (() => void) => {
        delays.push(ms)
        let live = true
        void Promise.resolve().then(() => {
          if (live) fn()
        })
        return () => {
          live = false
        }
      },
    },
  }
}

/** The scripted provider, with each `stream()` call's context recorded. */
function recording(provider: ScriptedProvider, sends: SendContext[]): Provider {
  return new Proxy(provider, {
    get(target, key): unknown {
      if (key === 'stream') {
        return (encoded: Parameters<Provider['stream']>[0], ctx: SendContext) => {
          sends.push(ctx)
          return target.stream(encoded, ctx)
        }
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
}

function harness(options: HarnessOptions = {}): Harness {
  const delays: number[] = []
  const store = options.store ?? createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  const sends: SendContext[] = []
  const executed: Record<string, unknown>[] = []
  const connection = {
    listTools: () => Promise.resolve([{ name: 'look', inputSchema: { type: 'object' } }]),
    callTool: (_name: string, args: Record<string, unknown>) => {
      executed.push(args)
      return Promise.resolve({
        content: [{ type: 'text', text: `looked at ${String(args['at'])}` }],
        isError: false,
      })
    },
  } as unknown as McpConnection
  const loop = createTestLoopPorts({
    connector: {
      provider: recording(provider, sends),
      model: MODEL,
      mcpSources: [{ serverId: 'fs', connection }],
    },
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  })
  const logs: string[] = []
  const service = createTestSessionService(
    {
      host: instantHost(delays),
      tape: store,
      ids: createCounterIds(),
      inspectors: [...(options.inspectors ?? [])],
      connector: loop.connector,
      protectedFiles: [],
      log: (line) => logs.push(line),
    },
    {
      tools: {},
      userSetting: () => ({ userSetting: 'always-allow' }),
      ...(options.tokenLimit === undefined ? {} : { tokenLimit: options.tokenLimit }),
    },
  )
  service.bindLoop(options.ports?.(loop) ?? loop)
  return { store, service, loop, provider, sends, executed, delays, logs }
}

interface Call {
  readonly id: string
  readonly input: Record<string, unknown>
  readonly name?: string
}

/** A reply that asks for these calls, text first, then the usage and a stop. */
function callTurn(
  calls: readonly Call[],
  o: {
    readonly text?: string
    readonly stop?: StopReason
    readonly providerReason?: string | null
    /** A call the stream began and never finished. */
    readonly half?: boolean
    readonly before?: readonly StreamEvent[]
  } = {},
): StreamEvent[] {
  const events: StreamEvent[] = [...(o.before ?? [])]
  if (o.text !== undefined) events.push({ type: 'text-delta', index: 0, text: o.text })
  calls.forEach((call, i) => {
    const index = i + 1
    const name = call.name ?? LOOK
    events.push(
      { type: 'tool-call-start', index, id: call.id, name },
      { type: 'tool-call-args-delta', index, json: JSON.stringify(call.input) },
      { type: 'tool-call-end', index, id: call.id, name, input: call.input },
    )
  })
  if (o.half === true) {
    const index = calls.length + 1
    events.push(
      { type: 'tool-call-start', index, id: 'toolu_half', name: LOOK },
      { type: 'tool-call-args-delta', index, json: '{"at":' },
    )
  }
  events.push({ type: 'usage', usage: USAGE })
  const stop = o.stop ?? 'tool-use'
  events.push(stopEvent(stop, o.providerReason ?? (stop === 'tool-use' ? 'tool_use' : null)))
  return events
}

function errorTurn(
  code: Extract<StreamEvent, { type: 'error' }>['code'],
  o: {
    retryable?: boolean
    providerCode?: string
    deltas?: readonly string[]
    timeout?: 'first-byte' | 'idle'
  } = {},
): StreamEvent[] {
  return scriptedTurn({
    deltas: o.deltas ?? [],
    usage: USAGE,
    terminal: {
      type: 'error',
      code,
      retryable: o.retryable ?? true,
      providerCode: o.providerCode ?? null,
      detail: `a scripted ${code}`,
      ...(o.timeout === undefined ? {} : { timeout: o.timeout }),
    },
  })
}

const done = (text = 'Done.'): StreamEvent[] => scriptedTurn({ deltas: [text], usage: USAGE })

/** Distinct texts, so no message reads as a resend of the one before (01's retry rule). */
let texts = 0

async function send(h: Harness, text = `message ${String((texts += 1))}`): Promise<RunEnded> {
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return h.loop.runEnded({ runId: sent.runId })
}

async function all(h: Harness): Promise<TapeEntry[]> {
  return (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}

function named(entries: readonly TapeEntry[], name: string, runId?: string | null): TapeEntry[] {
  return entries.filter(
    (entry) =>
      entry.name === name &&
      (runId === undefined ||
        runId === null ||
        entry.sourceId === runId ||
        entry.payload['runId'] === runId),
  )
}

/** Each closed call's `(state, source)`, in the Tape's order. */
function outcomes(entries: readonly TapeEntry[], runId?: string | null): string[] {
  return named(entries, 'execution/tool_outcome', runId).map(
    (entry) => `${String(entry.payload['state'])}/${String(entry.payload['source'])}`,
  )
}

/** A scripted request as `fakeNetwork` would have recorded it, for the request assertions. */
function recorded(h: Harness, index: number): RecordedRequest {
  const body = h.provider.requests.at(index)?.body
  return {
    url: 'https://api.anthropic.test/v1/messages',
    method: 'POST',
    headers: {},
    bodyText: JSON.stringify(body),
    body,
  }
}

function lastUserText(h: Harness, index = -1): string {
  const body = h.provider.requests.at(index)?.body as {
    messages: { role: string; content: string | { type: string; text?: string }[] }[]
  }
  const last = body.messages.at(-1)
  if (last === undefined) return ''
  return typeof last.content === 'string'
    ? last.content
    : last.content.map((block) => block.text ?? '').join('')
}

function attemptKeys(entries: readonly TapeEntry[]): string[] {
  return named(entries, 'provider/attempt_completed').map(
    (entry) => entry.provenanceKey?.split(':').slice(-2).join(':') ?? '',
  )
}

describe('a batch and the next request', () => {
  it('runs the calls in order, sends their results back, and ends when the model does', async () => {
    const h = harness()
    h.provider.script(
      callTurn(
        [
          { id: 'toolu_1', input: { at: 'a' } },
          { id: 'toolu_2', input: { at: 'b' } },
        ],
        {
          text: 'Looking.',
        },
      ),
    )
    h.provider.script(done('Both fine.'))
    const ended = await send(h)
    expect(ended).toMatchObject({ reason: { code: 'completed' }, recorded: true })
    expect(h.executed).toEqual([{ at: 'a' }, { at: 'b' }])
    const entries = await all(h)
    expect(named(entries, 'execution/dispatch_committed')).toHaveLength(2)
    expect(outcomes(entries)).toEqual(['completed/null', 'completed/null'])
    // The second request carries both results, right after the call turn.
    expect(h.provider.requests).toHaveLength(2)
    assertToolPairing(recorded(h, 1))
    assertLastTurnIsUser(recorded(h, 1))
    // One terminal, one step, both attempts' usage.
    const [terminal, ...more] = named(entries, 'execution/run_terminal')
    expect(more).toEqual([])
    expect(terminal?.payload).toMatchObject({
      reason: { code: 'completed' },
      steps: 1,
      usage: [{ requests: 2, inputTokens: 18, outputTokens: 8 }],
    })
    // Every event after its facts: the calls once the reply is committed, each outcome once its
    // closure is, the end last.
    expect(h.loop.recorded.map((event) => event.type)).toEqual([
      'run-started',
      'user-message',
      'text-delta',
      'tool-call',
      'tool-call',
      'tool-outcome',
      'tool-outcome',
      'text-delta',
      'run-ended',
    ])
  })

  it('closes the complete calls of a message a stop cut short, not-run / stopped', async () => {
    let h: Harness | undefined
    h = harness({
      onEvent: (event) => {
        if (event.type === 'text-delta' && event.delta === 'then') {
          void h?.service.stop({ rootSessionId: SESSION })
        }
      },
    })
    h.provider.script(
      callTurn([{ id: 'toolu_1', input: { at: 'a' } }], {
        before: [],
        stop: 'end-turn',
      }).toSpliced(
        -2,
        0,
        { type: 'text-delta', index: 2, text: 'then' },
        { type: 'text-delta', index: 2, text: ' more' },
      ),
    )
    const ended = await send(h)
    expect(ended.reason).toEqual({ code: 'user-stopped' })
    const entries = await all(h)
    expect(named(entries, 'message/assistant')[0]?.payload['status']).toBe('aborted')
    expect(named(entries, 'tool/call')).toHaveLength(1)
    expect(outcomes(entries)).toEqual(['not-run/stopped'])
    expect(h.executed).toEqual([])
  })
})

describe('a truncated reply and 「继续」 (旧 30, 旧 128)', () => {
  const truncated = (): StreamEvent[] =>
    callTurn(
      [
        { id: 'toolu_1', input: { at: 'a' } },
        { id: 'toolu_2', input: { at: 'b' } },
      ],
      {
        text: 'Starting.',
        half: true,
        stop: 'max-tokens',
        providerReason: 'max_tokens',
      },
    )

  it('closes each complete call not-run, writes no half call, and continues with a model-only note', async () => {
    const h = harness()
    h.provider.script(truncated())
    const ended = await send(h, 'write it all')
    expect(ended.reason).toEqual({ code: 'output-truncated', maxTokens: MODEL.maxOutputTokens })
    let entries = await all(h)
    expect(named(entries, 'tool/call').map((entry) => entry.payload['providerToolCallId'])).toEqual(
      ['toolu_1', 'toolu_2'],
    )
    expect(outcomes(entries)).toEqual(['not-run/output-truncated', 'not-run/output-truncated'])
    const results = named(entries, 'tool/result')
    expect(
      results.map((entry) => [entry.payload['isError'], entry.payload['kernelAuthored']]),
    ).toEqual([
      [true, true],
      [true, true],
    ])
    expect(named(entries, 'execution/dispatch_committed')).toEqual([])

    h.provider.script(done('…and the rest.'))
    expect(await h.service.continueRun({ sessionId: SESSION, origin: null })).toEqual({
      status: 'started',
    })
    const continued = await h.loop.runEnded()
    expect(continued.reason).toEqual({ code: 'completed' })
    entries = await all(h)
    const [note] = named(entries, 'message/continuation')
    expect(note?.payload).toMatchObject({ cause: 'output-truncated', afterRunId: ended.runId })
    const started = named(entries, 'execution/run_started').at(-1)
    expect(started?.payload['cause']).toEqual({
      kind: 'continue',
      afterRunId: ended.runId,
      messageId: note?.payload['messageId'],
    })
    // No second user message; the note is the request's last user turn, and every call is paired.
    expect(named(entries, 'message/user')).toHaveLength(1)
    assertToolPairing(recorded(h, -1))
    expect(lastUserText(h)).toBe(MODEL_NOTES.continuation['output-truncated'])
    // The transcript shows no note.
    const rows = await h.service.listMessages({ sessionId: SESSION, limit: 10 })
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'assistant'])
    // Nothing left to continue.
    expect(await h.service.continueRun({ sessionId: SESSION, origin: null })).toEqual({
      status: 'not-available',
    })
  })

  it('pairs every call when a new message comes instead of 「继续」', async () => {
    const h = harness()
    h.provider.script(truncated())
    await send(h)
    h.provider.script(done())
    await send(h, 'never mind that')
    assertToolPairing(recorded(h, -1))
    assertLastTurnIsUser(recorded(h, -1))
    // A user message after the truncated Run: 「继续」 no longer applies.
    expect(await h.service.continueRun({ sessionId: SESSION, origin: null })).toEqual({
      status: 'not-available',
    })
  })
})

describe('the three discards and the kept endings (旧 30, 旧 129)', () => {
  it('discards a refusal: the attempt fact alone, one request, no second model', async () => {
    const h = harness()
    h.provider.script(
      callTurn([{ id: 'toolu_1', input: { at: 'a' } }], {
        text: 'I will not',
        stop: 'refusal',
        providerReason: 'refusal',
      }),
    )
    const ended = await send(h)
    expect(ended.reason).toEqual({ code: 'refusal', providerId: 'anthropic', modelId: MODEL.id })
    expect(h.provider.starts).toBe(1)
    const entries = await all(h)
    expect(named(entries, 'message/assistant')).toEqual([])
    expect(named(entries, 'tool/call')).toEqual([])
    expect(named(entries, 'provider/attempt_completed')[0]?.payload['stop']).toEqual({
      reason: 'refusal',
      providerReason: 'refusal',
    })
    expect(h.loop.recorded.filter((event) => event.type === 'attempt-discarded')).toHaveLength(1)
    // The next request ends on the user's turn, with nothing of the discarded reply in it.
    h.provider.script(done())
    await send(h)
    assertLastTurnIsUser(recorded(h, -1))
    expect(JSON.stringify(h.provider.requests.at(-1)?.body)).not.toContain('I will not')
  })

  it('discards a context overflow and a network_error stop, and ends each without an assistant', async () => {
    const overflow = harness()
    overflow.provider.script(callTurn([], { text: 'too long', stop: 'context-overflow' }))
    // Plan step 30 compacts and resends; until then the Run ends here.
    expect((await send(overflow)).reason).toEqual({ code: 'context-overflow', compactions: 0 })
    expect(named(await all(overflow), 'message/assistant')).toEqual([])

    const dropped = harness()
    for (let i = 0; i < 3; i += 1) {
      dropped.provider.script(
        callTurn([], { text: 'half', stop: 'unknown', providerReason: 'network_error' }),
      )
    }
    expect((await send(dropped)).reason).toEqual({
      code: 'provider-error',
      providerId: 'anthropic',
      errorCode: null,
      providerReason: 'network_error',
      attempts: 3,
    })
    expect(named(await all(dropped), 'message/assistant')).toEqual([])
  })

  it('keeps a content-filtered reply and closes its calls not-run / content-filter', async () => {
    const h = harness()
    h.provider.script(
      callTurn([{ id: 'toolu_1', input: { at: 'a' } }], {
        stop: 'content-filter',
        providerReason: 'sensitive',
      }),
    )
    expect((await send(h)).reason).toEqual({ code: 'content-filter', providerId: 'anthropic' })
    const entries = await all(h)
    expect(named(entries, 'message/assistant')).toHaveLength(1)
    expect(outcomes(entries)).toEqual(['not-run/content-filter'])
    expect(h.executed).toEqual([])
  })

  it('keeps a pause-turn reply, closes its calls not-run / provider-error, and says pause_turn', async () => {
    const h = harness()
    h.provider.script(
      callTurn([{ id: 'toolu_1', input: { at: 'a' } }], {
        stop: 'pause-turn',
        providerReason: 'pause_turn',
      }),
    )
    expect((await send(h)).reason).toEqual({
      code: 'provider-error',
      providerId: 'anthropic',
      errorCode: null,
      providerReason: 'pause_turn',
      attempts: 1,
    })
    expect(outcomes(await all(h))).toEqual(['not-run/provider-error'])
  })
})

describe('calls the vendor ran itself (旧 12)', () => {
  const serverBlock: StreamEvent = {
    type: 'vendor-block',
    index: 3,
    raw: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
    replay: 'never',
  }

  it('stores the block, dispatches only the client call, and never sends the block back', async () => {
    const h = harness()
    h.provider.script(
      callTurn([{ id: 'toolu_1', input: { at: 'a' } }], { text: 'Both.' }).toSpliced(
        -2,
        0,
        serverBlock,
      ),
    )
    h.provider.script(done())
    expect((await send(h)).reason).toEqual({ code: 'completed' })
    expect(h.executed).toEqual([{ at: 'a' }])
    expect(h.logs.filter((line) => line.includes('the vendor ran itself'))).toHaveLength(1)
    const content = named(await all(h), 'message/assistant')[0]?.payload[
      'content'
    ] as ContentBlock[]
    expect(content.some((block) => block.type === 'vendor')).toBe(true)
    assertToolPairing(recorded(h, 1))
    expect(JSON.stringify(h.provider.requests[1]?.body)).not.toContain('srvtoolu_1')
  })

  it('ends a tool-use turn of server blocks alone as provider-error, not waiting on a result', async () => {
    const h = harness()
    h.provider.script(callTurn([], { before: [serverBlock] }))
    expect((await send(h)).reason).toEqual({
      code: 'provider-error',
      providerId: 'anthropic',
      errorCode: null,
      providerReason: 'tool_use',
      attempts: 1,
    })
    expect(named(await all(h), 'tool/call')).toEqual([])
    expect(h.logs.filter((line) => line.includes('the vendor ran itself'))).toHaveLength(1)
  })

  it('does the same for zhipu’s tool_calls of type mcp, on the real adapter', async () => {
    const net = fakeNetwork(
      [
        { kind: 'sse', frames: openAIFixture.MCP_CALL_FRAMES },
        { kind: 'sse', frames: openAIFixture.PLAIN_TEXT_FRAMES },
        { kind: 'sse', frames: openAIFixture.MCP_ONLY_FRAMES },
      ],
      {
        checkRequest: (request) => {
          assertToolPairing(request)
          assertLastTurnIsUser(request)
        },
      },
    )
    const provider = zhipuDefinition.create({
      network: net,
      clock: { now: () => 0, setTimeout: () => () => undefined },
      config: { baseURL: ZHIPU_DEFAULT_BASE_URL },
      secrets: { apiKey: 'test-key-not-a-real-credential' },
    })
    const model = zhipuDefinition.builtinModels[0]
    if (model === undefined) throw new Error('the zhipu definition has no builtin model')
    const h = harness()
    h.loop.connector.use({ provider, model })
    // The function call next to it is closed (no tool of that name here) and paired; the mcp one
    // is neither dispatched nor sent back.
    expect((await send(h)).reason).toEqual({ code: 'completed' })
    expect(outcomes(await all(h))).toEqual(['not-run/tool-unavailable'])
    expect(JSON.stringify(net.requests[1]?.body)).not.toContain(openAIFixture.MCP_CALL_ID)
    expect((await send(h)).reason).toMatchObject({ code: 'provider-error', errorCode: null })
    expect(net.checkFailures).toEqual([])
  })
})

describe('resends (旧 29, 旧 130)', () => {
  it('resends a transient error up to min(maxAttempts − 1, RETRY_CAP) times, then ends', async () => {
    const h = harness()
    for (let i = 0; i < 3; i += 1) {
      h.provider.script(errorTurn('overloaded', { providerCode: 'overloaded_error' }))
    }
    expect((await send(h)).reason).toEqual({
      code: 'provider-error',
      providerId: 'anthropic',
      errorCode: 'overloaded',
      providerReason: 'overloaded_error',
      attempts: 3,
    })
    expect(h.provider.starts).toBe(3)
    expect(attemptKeys(await all(h))).toEqual(['1:1', '1:2', '1:3'])
    // From baseDelayMs, doubling (旧开放问题 94).
    expect(h.delays).toEqual([1000, 2000])
  })

  it('counts a first-byte timeout and a network_error stop on the same counter', async () => {
    const h = harness()
    h.provider.script(errorTurn('network', { timeout: 'first-byte' }))
    h.provider.script(
      callTurn([], { text: 'half', stop: 'unknown', providerReason: 'network_error' }),
    )
    h.provider.script(done())
    expect((await send(h)).reason).toEqual({ code: 'completed' })
    expect(attemptKeys(await all(h))).toEqual(['1:1', '1:2', '1:3'])
    // Only the resend right after the first-byte timeout goes without that limit (A5).
    expect(h.sends.map((ctx) => ctx.firstByteTimeout)).toEqual([undefined, false, undefined])
  })

  it('sends a non-retryable error once: auth, and a quota the vendor says is spent', async () => {
    const auth = harness()
    auth.provider.script(
      errorTurn('auth', { retryable: false, providerCode: 'authentication_error' }),
    )
    expect((await send(auth)).reason).toMatchObject({
      code: 'provider-error',
      errorCode: 'auth',
      attempts: 1,
    })
    expect(auth.provider.starts).toBe(1)

    const quota = harness()
    quota.provider.script(
      scriptedTurn({
        terminal: {
          type: 'error',
          code: 'quota-exhausted',
          retryable: false,
          providerCode: '1113',
          detail: 'balance',
        },
      }),
    )
    expect((await send(quota)).reason).toEqual({
      code: 'quota-exhausted',
      providerId: 'anthropic',
      resetAt: null,
    })
    expect(quota.provider.starts).toBe(1)
  })

  it('ends a network failure followed by auth as auth, after two attempts', async () => {
    const h = harness()
    h.provider.script(errorTurn('network'))
    h.provider.script(errorTurn('auth', { retryable: false }))
    expect((await send(h)).reason).toMatchObject({
      code: 'provider-error',
      errorCode: 'auth',
      attempts: 2,
    })
  })

  it('lets each request of one Run fail twice and still finish', async () => {
    const h = harness()
    h.provider.script(errorTurn('overloaded'))
    h.provider.script(errorTurn('network'))
    h.provider.script(callTurn([{ id: 'toolu_1', input: { at: 'a' } }]))
    h.provider.script(errorTurn('overloaded'))
    h.provider.script(errorTurn('network'))
    h.provider.script(done())
    expect((await send(h)).reason).toEqual({ code: 'completed' })
    const entries = await all(h)
    expect(attemptKeys(entries)).toEqual(['1:1', '1:2', '1:3', '2:1', '2:2', '2:3'])
    // Every attempt's final reading is the Run's usage, the failed ones included (旧 131).
    expect(named(entries, 'execution/run_terminal')[0]?.payload['usage']).toMatchObject([
      { requests: 6, inputTokens: 54, outputTokens: 24 },
    ])
  })

  it('sends attempt-discarded before the resend’s first delta', async () => {
    const h = harness()
    h.provider.script(errorTurn('overloaded', { deltas: ['half'] }))
    h.provider.script(done('whole'))
    await send(h)
    const events = h.loop.recorded
      .filter((event) => event.type === 'text-delta' || event.type === 'attempt-discarded')
      .map((event) => (event.type === 'text-delta' ? event.delta : event.type))
    expect(events).toEqual(['half', 'attempt-discarded', 'whole'])
  })
})

describe('the guards (旧 3, 02 不变量 14, 旧 27, 旧 127, 旧 28)', () => {
  it('does not run the fourth identical batch in a row, and a one-byte change does not trigger', async () => {
    const h = harness()
    for (let i = 0; i < 4; i += 1)
      h.provider.script(callTurn([{ id: `toolu_${String(i)}`, input: { at: 'same' } }]))
    expect((await send(h)).reason).toEqual({ code: 'no-progress', repeats: 4 })
    expect(h.executed).toHaveLength(3)
    const entries = await all(h)
    expect(outcomes(entries).at(-1)).toBe('not-run/no-progress')
    expect(named(entries, 'execution/dispatch_committed')).toHaveLength(3)

    const control = harness()
    for (let i = 0; i < 3; i += 1)
      control.provider.script(callTurn([{ id: `toolu_${String(i)}`, input: { at: 'same' } }]))
    control.provider.script(callTurn([{ id: 'toolu_3', input: { at: 'samf' } }]))
    control.provider.script(done())
    expect((await send(control)).reason).toEqual({ code: 'completed' })
    expect(control.executed).toHaveLength(4)
  })

  it('ends repeated machine denials at the third, before no-progress', async () => {
    const deny = createFakeInspector({
      id: 'deny-all',
      ceiling: 'deny',
      answer: { kind: 'deny', category: 'exfiltration', findings: [{ code: 'test' }] },
    })
    const h = harness({ inspectors: [deny.registration] })
    for (let i = 0; i < 4; i += 1)
      h.provider.script(callTurn([{ id: `toolu_${String(i)}`, input: { at: 'same' } }]))
    expect((await send(h)).reason).toEqual({ code: 'blocked-repeatedly', count: 3 })
    expect(h.provider.starts).toBe(3)
    expect(h.executed).toEqual([])
    expect(outcomes(await all(h))).toEqual([
      'not-run/inspector',
      'not-run/inspector',
      'not-run/inspector',
    ])
  })

  it(
    'stops at the step limit, and 「继续」 starts the count again',
    { timeout: 30_000 },
    async () => {
      const h = harness()
      for (let i = 0; i <= 100; i += 1)
        h.provider.script(callTurn([{ id: `toolu_${String(i)}`, input: { at: String(i) } }]))
      const ended = await send(h)
      expect(ended.reason).toEqual({ code: 'step-limit', limit: 100 })
      expect(h.executed).toHaveLength(100)
      let entries = await all(h)
      expect(named(entries, 'execution/dispatch_committed')).toHaveLength(100)
      expect(outcomes(entries).at(-1)).toBe('not-run/step-limit')
      expect(named(entries, 'execution/run_terminal')[0]?.payload['steps']).toBe(100)

      h.provider.script(callTurn([{ id: 'toolu_after', input: { at: 'after' } }]))
      h.provider.script(done())
      expect(await h.service.continueRun({ sessionId: SESSION, origin: null })).toEqual({
        status: 'started',
      })
      expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
      expect(h.executed.at(-1)).toEqual({ at: 'after' })
      expect(lastUserText(h, -2)).toBe(MODEL_NOTES.continuation['step-limit'])
      entries = await all(h)
      expect(named(entries, 'message/user')).toHaveLength(1)
      expect(named(entries, 'execution/run_terminal').at(-1)?.payload['steps']).toBe(1)
    },
  )

  it('closes the batch of the reply that went over the token limit, and sends nothing more', async () => {
    // 13 tokens a reply (uncached input plus output): the first stays under 20, the second does not.
    const h = harness({ tokenLimit: 20 })
    h.provider.script(callTurn([{ id: 'toolu_1', input: { at: 'a' } }]))
    h.provider.script(callTurn([{ id: 'toolu_2', input: { at: 'b' } }]))
    expect((await send(h)).reason).toEqual({ code: 'usage-limit', tokenLimit: 20 })
    expect(h.executed).toEqual([{ at: 'a' }])
    expect(outcomes(await all(h))).toEqual(['completed/null', 'not-run/usage-limit'])
    expect(h.provider.starts).toBe(2)
  })
})

/** An inspector that asks about every call: the card that pauses a Run. */
const ask = (): ReturnType<typeof createFakeInspector> =>
  createFakeInspector({
    id: 'asker',
    ceiling: 'ask',
    answer: { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] },
  })

describe('a pause, and a stop that beats it', () => {
  it('writes the asking decision with the paused terminal, in one batch', async () => {
    const appends: string[][] = []
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = new Proxy(inner, {
      get(target, key): unknown {
        if (key === 'append') {
          return async (batch: Parameters<TapeStore['append']>[0]) => {
            const receipts = await target.append(batch)
            appends.push(batch.entries.map((entry) => entry.name))
            return receipts
          }
        }
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value
      },
    })
    const h = harness({ inspectors: [ask().registration], store })
    h.provider.script(
      callTurn([
        { id: 'toolu_1', input: { at: 'a' } },
        { id: 'toolu_2', input: { at: 'b' } },
      ]),
    )
    expect((await send(h)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    expect(appends.at(-1)).toEqual(['tool/permission_decided', 'execution/run_terminal'])
    expect(h.executed).toEqual([])
    // The call after it waits too: no fact for it yet.
    expect(outcomes(await all(h))).toEqual([])
  })

  it('ends as stopped when the stop lands after the Run decided to pause, and writes no decision', async () => {
    const gate = Promise.withResolvers<void>()
    const inspector = ask()
    const h = harness({
      inspectors: [inspector.registration],
      // A message sent while the Run judges holds the mailbox until the case lets it go, so the
      // Run's terminal task waits behind it.
      ports: (loop) => ({
        ...loop,
        queue: {
          ...loop.queue,
          enqueue: async (...args: Parameters<LoopPorts['queue']['enqueue']>) => {
            await gate.promise
            return loop.queue.enqueue(...args)
          },
        },
      }),
    })
    let queued: Promise<unknown> | undefined
    inspector.answer(() => {
      queued ??= h.service.send({ sessionId: SESSION, origin: null, text: 'one more thing' })
      return { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] }
    })
    h.provider.script(
      callTurn([
        { id: 'toolu_1', input: { at: 'a' } },
        { id: 'toolu_2', input: { at: 'b' } },
      ]),
    )
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'look at both' })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    // Past the decision: the Run has returned its pause and its terminal task is queued.
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    gate.resolve()
    expect(await queued).toMatchObject({ status: 'queued' })
    const ended = await h.loop.runEnded({ runId: sent.runId })
    expect(ended.reason).toEqual({ code: 'user-stopped' })
    const entries = await all(h)
    expect(named(entries, 'tool/permission_decided')).toEqual([])
    expect(outcomes(entries)).toEqual(['not-run/stopped', 'not-run/stopped'])
    expect(named(entries, 'execution/run_terminal')[0]?.payload['reason']).toEqual({
      code: 'user-stopped',
    })
    expect(h.loop.recorded.filter((event) => event.type === 'tool-outcome')).toHaveLength(2)
  })
})

describe('tool-outcome and its facts', () => {
  it('goes out only after the result is committed, and not at all when that append fails', async () => {
    const order: string[] = []
    let failResult = false
    const inner = createMemoryTapeStore({ identity: IDENTITY })
    const store = new Proxy(inner, {
      get(target, key): unknown {
        if (key === 'append') {
          return async (batch: Parameters<TapeStore['append']>[0]) => {
            const names = batch.entries.map((entry) => entry.name)
            if (failResult && names.includes('tool/result')) throw new Error('the disk is full')
            const receipts = await target.append(batch)
            order.push(`commit ${names.join(',')}`)
            return receipts
          }
        }
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value
      },
    })
    const h = harness({
      store,
      onEvent: (event) => {
        if (event.type === 'tool-outcome') order.push('event tool-outcome')
      },
    })
    h.provider.script(callTurn([{ id: 'toolu_1', input: { at: 'a' } }]))
    h.provider.script(done())
    await send(h)
    const committed = order.findIndex((line) => line.includes('tool/result,execution/tool_outcome'))
    expect(committed).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('event tool-outcome')).toBe(committed + 1)

    failResult = true
    h.provider.script(callTurn([{ id: 'toolu_2', input: { at: 'b' } }]))
    const before = h.loop.recorded.length
    const ended = await send(h)
    expect(ended.recorded).toBe(false)
    expect(h.loop.recorded.slice(before).filter((event) => event.type === 'tool-outcome')).toEqual(
      [],
    )
  })
})
