/**
 * The Run's rounds and its end (spec 02 §主循环与 Run 的结束, §一轮回复怎么分流, §上限、守卫与用量,
 * §重试与「继续」; plan step 13: 旧 12, 旧 30, 旧 128, 旧 129, 旧 29, 旧 130, 旧 3, 02 不变量 14, 旧 27,
 * 旧 127, 旧 28, the event order, 旧 131).
 *
 * The calls go to a connector tool the user set to always-allow (layer 6), so a batch runs without a
 * card; a deny inspector stands in for a machine denial and an ask one for a card. What needs the
 * answers (a pause across a restart, the step count carried by a resume) is plan step 15's; the
 * compaction retry of an overflow is step 30's. The last block judges calls in the loop (plan step
 * 12: 旧 162's loop half, 旧 124; step 11: 旧 93's loop half; 02 不变量 16).
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_POLICY,
  INSPECTOR_TIMEOUT_MS,
  ZHIPU_DEFAULT_BASE_URL,
  createMemoryHost,
  createMemoryTapeStore,
  rebuildProviderContext,
  zhipuDefinition,
} from '../../src/index.js'
import type {
  ContentBlock,
  HostAdapter,
  InspectorRegistration,
  LoopPorts,
  ModelInfo,
  PermissionDecidedPayload,
  Provider,
  SendContext,
  SessionEvent,
  SessionService,
  StopReason,
  StreamEvent,
  TapeAttemptCompletedPayload,
  TapeEntry,
  TapeStore,
  ToolSpec,
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
import { LOOK, instantHost, lookSource } from './support.js'

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
  /** A host of the case's own, in place of the instant one (a clock that never fires, a policy). */
  readonly host?: HostAdapter
  /** The instant host lets a fake inspector answer before its time limit fires. */
  readonly answersFirst?: boolean
  readonly tokenLimit?: number
  readonly store?: TapeStore
  readonly onEvent?: (event: SessionEvent) => void
  /** The ports the service is bound to, when a case needs to hold one of them. */
  readonly ports?: (loop: TestLoopPorts) => LoopPorts
  /** A provider's retry advice other than the scripted one's. */
  readonly retryAdvice?: { maxAttempts: number; baseDelayMs: number }
  /** The first id handed out: a restarted app's ids never repeat the ones before. */
  readonly idsFrom?: number
}

/** The scripted provider, with each `stream()` call's context recorded. */
function recording(
  provider: ScriptedProvider,
  sends: SendContext[],
  advice?: { maxAttempts: number; baseDelayMs: number },
): Provider {
  return new Proxy(provider, {
    get(target, key): unknown {
      if (key === 'retryAdvice' && advice !== undefined) return () => advice
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
  const loop = createTestLoopPorts({
    connector: {
      provider: recording(provider, sends, options.retryAdvice),
      model: MODEL,
      mcpSources: [lookSource(executed)],
    },
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  })
  const logs: string[] = []
  const service = createTestSessionService(
    {
      host: options.host ?? instantHost(delays, { answersFirst: options.answersFirst === true }),
      tape: store,
      ids: createCounterIds({ start: options.idsFrom ?? 1 }),
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

/** Each decision's inspector steps, `said` and `status` only, in the Tape's order. */
function inspectorSteps(entries: readonly TapeEntry[]): { said: string; status: string }[] {
  return named(entries, 'tool/permission_decided').flatMap((entry) =>
    (entry.payload as unknown as PermissionDecidedPayload).record.steps
      .filter((step) => step.by === 'inspector')
      .map((step) => ({ said: step.said, status: step.status })),
  )
}

/** The text of each `tool/result`, in the Tape's order. */
function resultTexts(entries: readonly TapeEntry[]): string[] {
  return named(entries, 'tool/result').map((entry) =>
    (entry.payload['content'] as { type: string; text?: string }[])
      .map((block) => block.text ?? '')
      .join('\n'),
  )
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

/**
 * What a request was sent, re-encoded from the Tape alone (acceptance 3, 38): the replay pinned at the
 * fact's `contextAtEntryId`, the incarnation's stored system text, the table's stored specs and the
 * fact's own request snapshot, through the provider's real encoder.
 */
async function reEncodedPromptHash(h: Harness, entry: TapeEntry): Promise<string> {
  const fact = entry.payload as unknown as TapeAttemptCompletedPayload
  const entries = await all(h)
  const byKey = (key: string | undefined): Record<string, unknown> | undefined =>
    entries.find((candidate) => candidate.provenanceKey === key)?.payload
  const contents = named(entries, 'view/content').map((candidate) => candidate.payload)
  const system = contents.find(
    (content) => content['type'] === 'system' && content['hash'] === fact.request.systemHash,
  )?.['text'] as string | undefined
  const sent = byKey(fact.assemblyRef)?.['tools'] as { tableKey: string; sent: boolean } | null
  const table = sent?.sent === true ? byKey(sent.tableKey) : undefined
  const tools = (table?.['tools'] as { specHash: string }[] | undefined)?.map(
    (tool) =>
      contents.find(
        (content) => content['type'] === 'tool_spec' && content['hash'] === tool.specHash,
      )?.['spec'] as ToolSpec,
  )
  const messages = await rebuildProviderContext(h.store, {
    sessionId: SESSION,
    atEntryId: fact.contextAtEntryId,
    target: MODEL,
  })
  return h.provider.encode({
    model: MODEL,
    ...(system === undefined ? {} : { system }),
    messages,
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    maxTokens: fact.request.maxTokens,
    ...(fact.request.temperature === undefined ? {} : { temperature: fact.request.temperature }),
    ...(fact.request.thinking === undefined ? {} : { thinking: fact.request.thinking }),
    ...(fact.request.effort === undefined ? {} : { effort: fact.request.effort }),
    ...(fact.request.display === undefined ? {} : { display: fact.request.display }),
  }).promptHash
}

describe('kernel-written text replays as stored, across a layer change (旧 225 后半, acceptance 38)', () => {
  it('sends an older layer’s closure, continuation and environment notes byte for byte, and its attempts still recompute', async () => {
    // What an older prompt layer wrote (§提示层「存在哪、重放取什么」): the three notes are swapped
    // while the first two Runs write them, and the layer is back to this build's for the third.
    const notes = MODEL_NOTES as unknown as {
      closure: Record<string, Record<string, string>>
      continuation: Record<string, string>
      environment: Record<string, string>
    }
    const older = {
      closure: 'An older layer: the reply ran out before this call, so it did not run.',
      continuation: 'An older layer: carry on from where the reply stopped.',
      date: 'An older layer’s date line: {date}',
    }
    const truncatedCell = notes.closure['output-truncated'] ?? {}
    const current = {
      closure: truncatedCell['not-run'] ?? '',
      continuation: notes.continuation['output-truncated'] ?? '',
      date: notes.environment['date'] ?? '',
    }
    const h = harness()
    truncatedCell['not-run'] = older.closure
    notes.continuation['output-truncated'] = older.continuation
    notes.environment['date'] = older.date
    try {
      h.provider.script(
        callTurn([{ id: 'toolu_1', input: { at: 'a' } }], {
          text: 'Starting.',
          stop: 'max-tokens',
          providerReason: 'max_tokens',
        }),
      )
      expect((await send(h, 'write it all')).reason.code).toBe('output-truncated')
      h.provider.script(done('…and the rest.'))
      await h.service.continueRun({ sessionId: SESSION, origin: null })
      expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    } finally {
      truncatedCell['not-run'] = current.closure
      notes.continuation['output-truncated'] = current.continuation
      notes.environment['date'] = current.date
    }
    h.provider.script(done('Next.'))
    expect((await send(h, 'and now')).reason).toEqual({ code: 'completed' })

    // The stored texts are the older ones, and the request after the change sends them as stored.
    const entries = await all(h)
    expect(resultTexts(entries)).toEqual([older.closure])
    expect(named(entries, 'tool/result')[0]?.payload['kernelAuthored']).toBe(true)
    const stored = (name: string): string =>
      (named(entries, name)[0]?.payload['content'] as { text: string }[] | undefined)?.[0]?.text ??
      ''
    expect(stored('message/continuation')).toBe(older.continuation)
    expect(stored('message/environment')).toContain(older.date.replace(' {date}', ''))
    const [, continued, next] = h.provider.requests.map(
      (request) => (request.body as { messages: unknown[] }).messages,
    )
    const sentText = JSON.stringify(next)
    for (const text of [older.closure, older.continuation, stored('message/environment')]) {
      expect(sentText).toContain(JSON.stringify(text).slice(1, -1))
    }
    for (const text of [current.closure, current.continuation]) {
      expect(sentText).not.toContain(JSON.stringify(text).slice(1, -1))
    }
    // Byte for byte: the request after the change opens with the one before it.
    expect(JSON.stringify(next?.slice(0, continued?.length ?? 0))).toBe(JSON.stringify(continued))
    // Every attempt, the older layer's included, still re-encodes from the Tape to its promptHash.
    const attempts = named(entries, 'provider/attempt_completed')
    expect(attempts).toHaveLength(3)
    for (const attempt of attempts) {
      const fact = attempt.payload as unknown as TapeAttemptCompletedPayload
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time, each read from the Tape
      expect(await reEncodedPromptHash(h, attempt), `attempt ${String(attempt.entryId)}`).toBe(
        fact.promptHash,
      )
    }
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

  it('resends no more than maxAttempts − 1 when that is under RETRY_CAP (验收 16, 旧 29)', async () => {
    // min(maxAttempts − 1, RETRY_CAP) with the two apart: a provider that allows 2 attempts.
    const h = harness({ retryAdvice: { maxAttempts: 2, baseDelayMs: 500 } })
    for (let i = 0; i < 3; i += 1) h.provider.script(errorTurn('overloaded'))
    expect((await send(h)).reason).toMatchObject({
      code: 'provider-error',
      errorCode: 'overloaded',
      attempts: 2,
    })
    expect(h.provider.starts).toBe(2)
    expect(h.delays).toEqual([500])
  })

  it('shares one budget between timeouts and network_error, and ends once it is spent (验收 16)', async () => {
    // 「超时和 network_error 共用这个计数，用尽后以 provider-error 结束」: a first-byte timeout, a
    // network_error stop and an idle timeout are three attempts of one budget, not one each.
    const h = harness()
    h.provider.script(errorTurn('network', { timeout: 'first-byte' }))
    h.provider.script(
      callTurn([], { text: 'half', stop: 'unknown', providerReason: 'network_error' }),
    )
    h.provider.script(errorTurn('network', { timeout: 'idle' }))
    h.provider.script(done())
    expect((await send(h)).reason).toMatchObject({
      code: 'provider-error',
      errorCode: 'network',
      attempts: 3,
    })
    expect(h.provider.starts).toBe(3)
  })

  it('ends a Run stopped during the backoff as user-stopped, with no error code', async () => {
    // §重试与「继续」: 等待中点停止，Run 以 user-stopped 结束; run-ended's errorCode is that of the error
    // that ended the Run, and a stop ended this one (null) — so the interface shows done{aborted}.
    let service: SessionService | undefined
    const memory = createMemoryHost()
    const host: HostAdapter = {
      ...memory,
      clock: {
        now: () => 0,
        setTimeout: () => {
          // The wait never ends by itself: the stop lands inside it, once it is waiting.
          queueMicrotask(() => void service?.stop({ rootSessionId: SESSION }))
          return () => undefined
        },
      },
    }
    const h = harness({ host })
    service = h.service
    h.provider.script(errorTurn('overloaded', { deltas: ['half'] }))
    const ended = await send(h)
    expect(ended).toMatchObject({
      reason: { code: 'user-stopped' },
      recorded: true,
      errorCode: null,
      lastStop: null,
    })
    expect(h.provider.starts).toBe(1)
    const tail = h.loop.recorded.map((event) => event.type).slice(-2)
    expect(tail).toEqual(['attempt-discarded', 'run-ended'])
  })

  it('ends a failed Run whose terminal a stop beat as user-stopped, with no error code', async () => {
    // 「mailbox」: the failure is not written once the lease is aborted — the Run ends by the stop,
    // and no error event ended it.
    const gate = Promise.withResolvers<void>()
    let queued: Promise<unknown> | undefined
    let h: Harness | undefined
    h = harness({
      // A message sent while the reply streams holds the mailbox until the case lets it go.
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
      onEvent: (event) => {
        if (event.type === 'text-delta') {
          queued ??= h?.service.send({ sessionId: SESSION, origin: null, text: 'meanwhile' })
        }
      },
    })
    h.provider.script(errorTurn('auth', { retryable: false, deltas: ['half'] }))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'go' })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    await expect.poll(() => queued !== undefined).toBe(true)
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    gate.resolve()
    const ended = await h.loop.runEnded({ runId: sent.runId })
    expect(ended).toMatchObject({ reason: { code: 'user-stopped' }, errorCode: null })
    expect(named(await all(h), 'execution/run_terminal')[0]?.payload['reason']).toEqual({
      code: 'user-stopped',
    })
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
    // The fake answers before its limit: these are its denials, not three timeouts.
    const h = harness({ inspectors: [deny.registration], answersFirst: true })
    for (let i = 0; i < 4; i += 1)
      h.provider.script(callTurn([{ id: `toolu_${String(i)}`, input: { at: 'same' } }]))
    expect((await send(h)).reason).toEqual({ code: 'blocked-repeatedly', count: 3 })
    expect(h.provider.starts).toBe(3)
    expect(h.executed).toEqual([])
    const entries = await all(h)
    expect(outcomes(entries)).toEqual([
      'not-run/inspector',
      'not-run/inspector',
      'not-run/inspector',
    ])
    expect(named(entries, 'execution/tool_outcome').map((entry) => entry.payload['facts'])).toEqual(
      Array.from({ length: 3 }, () => ({ toolName: 'look', category: 'exfiltration' })),
    )
    expect(inspectorSteps(entries)).toEqual(
      Array.from({ length: 3 }, () => ({ said: 'deny', status: 'ok' })),
    )
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

  it('sends no resend once a discarded attempt went over the token limit (旧 28)', async () => {
    // 「每次 attempt 结束后检查，越限就不再发请求」: 13 tokens an attempt, the second goes over 20.
    const h = harness({ tokenLimit: 20 })
    for (let i = 0; i < 3; i += 1) {
      h.provider.script(
        callTurn([], { text: 'half', stop: 'unknown', providerReason: 'network_error' }),
      )
    }
    const ended = await send(h)
    expect(ended).toMatchObject({
      reason: { code: 'usage-limit', tokenLimit: 20 },
      errorCode: null,
    })
    expect(h.provider.starts).toBe(2)
  })

  it('counts only the uncached input on the openai-chat wire (旧 28, 暂定: 未命中缓存的输入加输出)', async () => {
    // The fixture's usage: prompt 31 with 12 cached and 5 written to the cache, completion 57 —
    // 71 toward the limit, not the 88 openai-chat reports as input plus output (spec §评测运行器
    // 「费用与用量」: that wire's input includes the cache).
    const net = fakeNetwork(
      [
        {
          kind: 'sse',
          frames: openAIFixture.turnFrames(
            [],
            [{ id: 'call_1', name: LOOK, args: JSON.stringify({ at: 'a' }) }],
            'tool_calls',
          ),
        },
        { kind: 'sse', frames: openAIFixture.turnFrames(['Done.'], [], 'stop') },
      ],
      { checkRequest: assertToolPairing },
    )
    const provider = zhipuDefinition.create({
      network: net,
      clock: { now: () => 0, setTimeout: () => () => undefined },
      config: { baseURL: ZHIPU_DEFAULT_BASE_URL },
      secrets: { apiKey: 'test-key-not-a-real-credential' },
    })
    const model = zhipuDefinition.builtinModels[0]
    if (model === undefined) throw new Error('the zhipu definition has no builtin model')
    const h = harness({ tokenLimit: 80 })
    h.loop.connector.use({ provider, model, mcpSources: [lookSource(h.executed)] })
    expect((await send(h)).reason).toEqual({ code: 'completed' })
    expect(h.executed).toEqual([{ at: 'a' }])
    expect(net.callCount).toBe(2)
  })
})

/** An inspector that asks about every call: the card that pauses a Run. */
const ask = (): ReturnType<typeof createFakeInspector> =>
  createFakeInspector({
    id: 'asker',
    ceiling: 'ask',
    answer: { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] },
  })

/** Asks about the call on `at`, and about nothing else: the card that pauses a Run there. */
const askAt = (at: string): ReturnType<typeof createFakeInspector> =>
  createFakeInspector({
    id: 'asker',
    ceiling: 'ask',
    answer: (input) =>
      input.call.args['at'] === at
        ? { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] }
        : { kind: 'none' },
  })

/** Answers the root's one card. */
async function allow(h: Harness): Promise<void> {
  const card = await h.service.currentPending({ sessionId: SESSION })
  if (card === null) throw new Error('no card')
  const answered = await h.service.answer({
    kind: 'approval',
    sessionId: SESSION,
    requestId: card.card.requestId,
    decision: 'allow',
    origin: null,
  })
  expect(answered).toEqual({ status: 'applied' })
}

describe('the step count across a pause and a restart (验收 17, 旧 27, 旧 127)', () => {
  // 「步数跨重启延续：第 60 批时暂停、重启、批准后，新 Run 最多再跑 40 批就以 step-limit 结束」. The host's
  // timers never fire, so the inspector answers rather than timing out.
  const script = (h: Harness, from: number, to: number): void => {
    for (let i = from; i <= to; i += 1)
      h.provider.script(callTurn([{ id: `toolu_${String(i)}`, input: { at: String(i) } }]))
  }
  const terminals = async (h: Harness): Promise<unknown[]> =>
    named(await all(h), 'execution/run_terminal').map((entry) => [
      entry.payload['steps'],
      (entry.payload['reason'] as { code: string }).code,
    ])

  it(
    'pauses at the 60th batch, and the resumed Run stops after 40 more',
    { timeout: 30_000 },
    async () => {
      const h = harness({ inspectors: [askAt('59').registration], host: createMemoryHost() })
      script(h, 0, 59)
      expect((await send(h)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
      script(h, 60, 100)
      await allow(h)
      expect((await h.loop.runEnded()).reason).toEqual({ code: 'step-limit', limit: 100 })
      expect(await terminals(h)).toEqual([
        [60, 'paused'],
        [40, 'step-limit'],
      ])
      expect(h.executed).toHaveLength(100)
      expect(outcomes(await all(h)).at(-1)).toBe('not-run/step-limit')
    },
  )

  it('carries the count through a restart before the answer', { timeout: 30_000 }, async () => {
    const before = harness({ inspectors: [askAt('59').registration], host: createMemoryHost() })
    script(before, 0, 59)
    expect((await send(before)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    // The app restarts: a new service on the same store, recovery, then the answer.
    const h = harness({
      inspectors: [askAt('59').registration],
      host: createMemoryHost(),
      store: before.store,
      idsFrom: 100_000,
    })
    expect(await h.service.recover()).toEqual({ resumable: [], errors: [] })
    expect(await h.service.resume({ rootSessionId: SESSION, origin: null })).toEqual({
      status: 'none',
    })
    script(h, 60, 100)
    await allow(h)
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'step-limit', limit: 100 })
    expect(await terminals(h)).toEqual([
      [60, 'paused'],
      [40, 'step-limit'],
    ])
    expect(before.executed.length + h.executed.length).toBe(100)
  })
})

describe('a stop that beats a limit’s or a truncation’s end (「mailbox」)', () => {
  // 「已中止的…各种上限与截断）连同它们的同批收口都不写…收口照「生成中」一行」: the end's closures go with
  // its terminal, so a stop that lands before the terminal task writes neither.
  it('closes a truncated reply’s calls as stopped when the stop lands after the reply committed', async () => {
    let h: Harness | undefined
    h = harness({
      onEvent: (event) => {
        if (event.type === 'tool-call') void h?.service.stop({ rootSessionId: SESSION })
      },
    })
    h.provider.script(
      callTurn(
        [
          { id: 'toolu_1', input: { at: 'a' } },
          { id: 'toolu_2', input: { at: 'b' } },
        ],
        { stop: 'max-tokens', providerReason: 'max_tokens' },
      ),
    )
    const ended = await send(h)
    expect(ended).toMatchObject({ reason: { code: 'user-stopped' }, errorCode: null })
    const entries = await all(h)
    expect(outcomes(entries)).toEqual(['not-run/stopped', 'not-run/stopped'])
    expect(named(entries, 'execution/run_terminal')[0]?.payload['reason']).toEqual({
      code: 'user-stopped',
    })
    const views = h.loop.recorded.flatMap((event) =>
      event.type === 'tool-outcome' ? [event.outcome.source] : [],
    )
    expect(views).toEqual(['stopped', 'stopped'])
  })

  it('closes a call found unusable as stopped when the stop beats its closure', async () => {
    // §点停止时各状态怎么收: 同批后面还没派发的调用一律记 not-run / stopped — also one the batch had
    // already found unusable, whose closure's write the stop reached first.
    const gate = Promise.withResolvers<void>()
    let queued: Promise<unknown> | undefined
    let h: Harness | undefined
    h = harness({
      // A message sent at the first call's outcome holds the mailbox, so the next write waits.
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
      onEvent: (event) => {
        if (event.type !== 'tool-outcome' || queued !== undefined) return
        queued = h?.service.send({ sessionId: SESSION, origin: null, text: 'meanwhile' })
        setTimeout(() => {
          void h?.service.stop({ rootSessionId: SESSION })
          gate.resolve()
        }, 0)
      },
    })
    h.provider.script(
      callTurn([
        { id: 'toolu_1', input: { at: 'a' } },
        { id: 'toolu_2', input: { at: 'b' }, name: 'fs__nope' },
      ]),
    )
    expect((await send(h)).reason).toEqual({ code: 'user-stopped' })
    expect(outcomes(await all(h))).toEqual(['completed/null', 'not-run/stopped'])
  })

  it('closes the rest of a batch as stopped when the stop lands at the third machine denial', async () => {
    const deny = createFakeInspector({
      id: 'deny-all',
      ceiling: 'deny',
      answer: { kind: 'deny', category: 'exfiltration', findings: [{ code: 'test' }] },
    })
    let seen = 0
    let h: Harness | undefined
    h = harness({
      inspectors: [deny.registration],
      onEvent: (event) => {
        if (event.type === 'tool-outcome' && (seen += 1) === 3) {
          void h?.service.stop({ rootSessionId: SESSION })
        }
      },
    })
    h.provider.script(
      callTurn(['a', 'b', 'c', 'd'].map((at, i) => ({ id: `toolu_${String(i)}`, input: { at } }))),
    )
    expect((await send(h)).reason).toEqual({ code: 'user-stopped' })
    expect(outcomes(await all(h))).toEqual([
      'not-run/inspector',
      'not-run/inspector',
      'not-run/inspector',
      'not-run/stopped',
    ])
  })
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

  // 答复已登记、还没 append 时先以 close-window 中止、再 chat.stop（上一条两个时点同样再各跑一次）: the
  // stop that follows a closed window is read as the stop (lease.stopRequested), here before the
  // commit; answer.test.ts has the other time point, mid-commit.
  for (const cause of ['user-stop', 'close-window-then-stop'] as const) {
    it(`ends as stopped when the stop lands after the Run decided to pause, and writes no decision (${cause})`, async () => {
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
      if (cause === 'close-window-then-stop') h.loop.abort(SESSION, 'close-window')
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
  }
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

/** Lets the loop run until `ready` holds, a macrotask at a time. */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ready(); i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling the loop between two macrotasks
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  }
  if (!ready()) throw new Error('the loop never got there')
}

/** The decision facts' payloads, in the Tape's order. */
function decisions(entries: readonly TapeEntry[]): PermissionDecidedPayload[] {
  return named(entries, 'tool/permission_decided').map(
    (entry) => entry.payload as unknown as PermissionDecidedPayload,
  )
}

/** `n` calls to `look`, each at its own place. */
const calls = (n: number): Call[] =>
  Array.from({ length: n }, (_, i) => ({ id: `toolu_${String(i)}`, input: { at: String(i) } }))

describe('judging a call in the loop (旧 162, 旧 124, 旧 93)', () => {
  it('02 不变量 16: ends three calls a denying inspector failed on as blocked-repeatedly, each with the error sentence', async () => {
    const broken = createFakeInspector({
      id: 'strict',
      ceiling: 'deny',
      answer: { throws: new Error('boom') },
    })
    const h = harness({ inspectors: [broken.registration], answersFirst: true })
    for (const call of calls(3)) h.provider.script(callTurn([call]))
    expect((await send(h)).reason).toEqual({ code: 'blocked-repeatedly', count: 3 })
    expect(h.executed).toEqual([])
    const entries = await all(h)
    expect(resultTexts(entries)).toEqual(
      Array.from({ length: 3 }, () => MODEL_NOTES.inspectorFailed.error),
    )
    expect(outcomes(entries)).toEqual(Array.from({ length: 3 }, () => 'not-run/inspector'))
    expect(named(entries, 'execution/tool_outcome').map((entry) => entry.payload['facts'])).toEqual(
      Array.from({ length: 3 }, () => ({ toolName: 'look', category: 'inspector-failed' })),
    )
    expect(inspectorSteps(entries)).toEqual(
      Array.from({ length: 3 }, () => ({ said: 'deny', status: 'error' })),
    )
  })

  it('02 不变量 16: sends the timed-out sentence when a denying inspector does not answer in time', async () => {
    const slow = createFakeInspector({ id: 'strict', ceiling: 'deny', answer: 'never' })
    const h = harness({ inspectors: [slow.registration] })
    h.provider.script(callTurn(calls(1)))
    h.provider.script(done())
    expect((await send(h)).reason).toEqual({ code: 'completed' })
    expect(h.delays).toContain(INSPECTOR_TIMEOUT_MS['local-rule'])
    const entries = await all(h)
    expect(resultTexts(entries)).toEqual([MODEL_NOTES.inspectorFailed.timeout])
    expect(inspectorSteps(entries)).toEqual([{ said: 'deny', status: 'timeout' }])
    expect(slow.lastSignal?.aborted).toBe(true)
  })

  it('02 不变量 16: writes no decision for a call stopped while its inspectors judge, and closes the batch not-run / stopped', async () => {
    const slow = createFakeInspector({ id: 'slow', ceiling: 'ask', answer: 'never' })
    // A clock that never fires: the inspector is still judging when the stop lands.
    const h = harness({ inspectors: [slow.registration], host: createMemoryHost() })
    h.provider.script(callTurn(calls(2)))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'look at both' })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    await until(() => slow.calls.length === 1)
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect((await h.loop.runEnded({ runId: sent.runId })).reason).toEqual({ code: 'user-stopped' })
    expect(slow.lastSignal?.aborted).toBe(true)
    const entries = await all(h)
    expect(named(entries, 'tool/permission_decided')).toEqual([])
    expect(outcomes(entries)).toEqual(['not-run/stopped', 'not-run/stopped'])
    expect(slow.calls).toHaveLength(1)
  })

  it('writes one decision per judged call: every layer in order, each inspector, decidedBy and the summary (旧 124)', async () => {
    const observer = createFakeInspector({
      id: 'observer',
      ceiling: 'ask',
      answer: { kind: 'none', findings: [{ code: 'seen', confidence: 0.25 }] },
    })
    const judge = createFakeInspector({
      id: 'judge',
      ceiling: 'deny',
      answer: (input) =>
        input.call.args['at'] === 'deny'
          ? { kind: 'deny', category: 'exfiltration', findings: [{ code: 'no' }] }
          : input.call.args['at'] === 'ask'
            ? { kind: 'ask', category: 'exfiltration', findings: [{ code: 'maybe' }] }
            : { kind: 'none' },
    })
    const h = harness({
      inspectors: [observer.registration, judge.registration],
      answersFirst: true,
    })
    h.provider.script(
      callTurn([
        { id: 'toolu_a', input: { at: 'a' } },
        { id: 'toolu_d', input: { at: 'deny' } },
        { id: 'toolu_q', input: { at: 'ask' } },
      ]),
    )
    expect((await send(h)).reason.code).toBe('paused')
    const decided = decisions(await all(h))
    expect(decided.map((d) => [d.ordinal, d.record.verdict, d.record.decidedBy])).toEqual([
      [0, 'allow', 'user-grant'],
      [1, 'deny', 'inspector'],
      [2, 'ask', 'inspector'],
    ])
    for (const d of decided) {
      expect(d.record.steps.map((step) => step.by)).toEqual([
        'tenant-policy',
        'protected',
        'user-disabled',
        'irreversible',
        'connector-confirm',
        'inspector',
        'inspector',
        'user-grant',
        'approval-mode',
        'default',
      ])
      expect(d.record.steps.flatMap((step) => step.inspectorId ?? [])).toEqual([
        'observer',
        'judge',
      ])
      expect(Object.keys(d.summary).toSorted()).toEqual(['code', 'facts', 'verdict'])
      // The policy version is the payload's, never the record's (§判决记录与摘要).
      expect(d.policyVersion).toBe('empty')
      expect('policyVersion' in d.record).toBe(false)
    }
    expect(decided[0]?.record.steps[5]).toEqual({
      by: 'inspector',
      inspectorId: 'observer',
      said: 'none',
      basis: { findings: [{ code: 'seen', confidence: 0.25 }] },
      status: 'ok',
    })
  })

  it('reads the policy once per decision and once per table, and records its version (旧 93)', async () => {
    const memory = createMemoryHost()
    memory.setPolicy({ status: 'current', version: 'v7', snapshot: EMPTY_POLICY })
    let reads = 0
    const host: HostAdapter = {
      ...memory,
      policy: {
        current: () => {
          reads += 1
          return memory.policy.current()
        },
        subscribe: (listener) => memory.policy.subscribe(listener),
      },
    }
    const h = harness({ host })
    h.provider.script(callTurn(calls(2)))
    h.provider.script(done())
    expect((await send(h)).reason).toEqual({ code: 'completed' })
    let entries = await all(h)
    expect(named(entries, 'view/tool_table')[0]?.payload['policyVersion']).toBe('v7')
    expect(decisions(entries).map((d) => d.policyVersion)).toEqual(['v7', 'v7'])
    // One opening of the table, one reading for each of the two decisions.
    expect(reads).toBe(3)

    // After the freeze the policy goes out of reach: the next call is blocked at layer 1.
    memory.setPolicy({ status: 'unavailable' })
    h.provider.script(callTurn([{ id: 'toolu_x', input: { at: 'x' } }]))
    h.provider.script(done())
    expect((await send(h)).reason).toEqual({ code: 'completed' })
    entries = await all(h)
    const last = decisions(entries).at(-1)
    expect([last?.record.verdict, last?.record.decidedBy, last?.policyVersion]).toEqual([
      'deny',
      'tenant-policy',
      'unavailable',
    ])
    expect(last?.block).toEqual({ reason: 'policy', facts: { toolName: 'look' } })
    expect(outcomes(entries).at(-1)).toBe('not-run/policy')
    expect(h.executed).toEqual([{ at: '0' }, { at: '1' }])
    // The table came back from the Tape, not opened again: one more reading, the decision's.
    expect(named(entries, 'view/tool_table')).toHaveLength(1)
    expect(reads).toBe(4)
  })

  it('runs a call on the arguments the model gave when an inspector tries to rewrite them', async () => {
    const rewriter = createFakeInspector({
      id: 'rewriter',
      ceiling: 'ask',
      answer: (input) => {
        ;(input.call.args as Record<string, unknown>)['at'] = 'rewritten-by-inspector'
        return { kind: 'none' }
      },
    })
    const h = harness({ inspectors: [rewriter.registration], answersFirst: true })
    h.provider.script(callTurn([{ id: 'toolu_1', input: { at: 'a' } }]))
    // The write fails on the frozen copy: the inspector erred, so the call asks (its ceiling).
    expect((await send(h)).reason.code).toBe('paused')
    const pending = await h.service.currentPending({ sessionId: SESSION })
    expect(pending?.card.reason).toBe('flagged')
    h.provider.script(done())
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: pending?.card.requestId ?? '',
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    const entries = await all(h)
    expect(named(entries, 'tool/call')[0]?.payload['input']).toEqual({ at: 'a' })
    expect(h.executed).toEqual([{ at: 'a' }])
  })
})
