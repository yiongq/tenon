/**
 * Acceptance 1, the provider half: ONE call path — `registry.get(id)` → `create()` → `encode()` →
 * `stream()` → the block accumulator — driven through every builtin definition and then through a
 * fourth one written inline here, with the same assertions (invariants 1-6) on all of them. What
 * that proves is the claim the spec makes about the abstraction: adding a provider is adding a
 * definition, and nothing else.
 *
 * The other half of acceptance 1 — that the four produce the same-shaped Tape facts — is the second
 * parameterised test at the bottom: the same four definitions, the same fixtures, driven through the
 * kernel session service into a memory store, asserting that the five facts of a turn and the key set
 * of every payload are identical whichever provider produced them. Only the values differ.
 *
 * Plus the definition data itself: the config keys the spec's table fixes, the default base URLs,
 * ollama's default key reaching the Authorization header, and the i18n keys being keys rather than
 * sentences (the kernel produces no prose). Whether those keys RESOLVE in both locale directories
 * is a desktop test (step 14). The model rows spec 02 changes (§内置模型表的数据改动) are pinned
 * at the bottom, the zhipu reasoning echo through each row's own `encode()`.
 */
import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  BUILTIN_PROVIDERS,
  OLLAMA_DEFAULT_API_KEY,
  OLLAMA_DEFAULT_BASE_URL,
  ProviderAlreadyRegisteredError,
  ZHIPU_DEFAULT_BASE_URL,
  anthropicDefinition,
  createBlockAccumulator,
  createMemoryTapeStore,
  createProviderRegistry,
  createSessionService,
  ollamaDefinition,
  OpenAIChatProvider,
  registerBuiltinProviders,
  zhipuDefinition,
} from '../../src/index.js'
import type {
  ContentBlock,
  InternalMessage,
  ModelInfo,
  ProviderDefinition,
  ProviderRegistry,
  RunResult,
  StopReason,
  StreamEvent,
  TapeEntry,
  Usage,
} from '../../src/index.js'
import { createCounterIds, createStreamGate, fakeNetwork } from '../../src/testing/index.js'
import type { FakeNetwork } from '../../src/testing/index.js'
import * as anthropicFixture from './fixtures/anthropic-sse.js'
import * as openAIFixture from './fixtures/openai-sse.js'
import { TOOL } from './wire/fixtures.js'

const NOW = Date.parse('2026-09-21T00:00:00.000Z')

const IDENTITY = {
  runId: '00000000-0000-4000-8000-000000000003',
  requestSeq: 1,
  physicalAttempt: 1,
}

/** The credential every case configures, whichever key name its definition uses. */
const API_KEY = 'test-key-not-a-real-credential'

/** The fourth provider's id, wire and model — a definition that exists only in this file. */
const ACME_ID = 'acme'
const ACME_BASE_URL = 'https://acme.test/v1'

const acmeModel: ModelInfo = {
  id: 'acme-1',
  providerId: ACME_ID,
  contextLimit: 64_000,
  maxOutputTokens: 4096,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: true,
}

/**
 * The fourth definition: data and a `create()`, written here and nowhere else. It is deliberately
 * NOT a new class — a vendor speaking a wire the kernel already has needs no code at all, which is
 * what the identical run below demonstrates.
 */
const acmeDefinition: ProviderDefinition = {
  id: ACME_ID,
  nameKey: 'provider.acme.name',
  wire: 'openai-chat',
  configKeys: [
    { name: 'apiKey', required: true, secret: true, primary: true, labelKey: 'p.acme.apiKey' },
    {
      name: 'baseURL',
      required: true,
      secret: false,
      default: ACME_BASE_URL,
      labelKey: 'p.acme.baseURL',
    },
  ],
  builtinModels: [acmeModel],
  create(args) {
    // The adapter class is the kernel's; the definition only says which one and with what.
    return new OpenAIChatProvider({
      id: ACME_ID,
      network: args.network,
      clock: args.clock,
      apiKey: args.secrets['apiKey'] ?? null,
      baseURL: args.config['baseURL'] ?? ACME_BASE_URL,
      models: [acmeModel],
    })
  },
}

interface DriveCase {
  readonly name: string
  readonly definition: ProviderDefinition
  readonly frames: readonly string[]
  readonly secrets: Record<string, string>
  readonly config: Record<string, string>
  /** What the accumulator must hold once the stream is done. */
  readonly content: readonly ContentBlock[]
  readonly stop: { reason: StopReason; providerReason: string }
  readonly usage: Usage
  /** The request URL the definition's default base URL produces. */
  readonly url: string
  /** The credential header the endpoint must receive, by header name. */
  readonly credential: { readonly name: string; readonly value: string }
}

function anthropicUsage(): Usage {
  return {
    inputTokens: anthropicFixture.INPUT_TOKENS,
    outputTokens: anthropicFixture.OUTPUT_TOKENS,
    cacheReadTokens: anthropicFixture.CACHE_READ_TOKENS,
    cacheWriteTokens: anthropicFixture.CACHE_WRITE_TOKENS,
    reasoningTokens: 0,
    final: true,
  }
}

function openAIUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: openAIFixture.PROMPT_TOKENS,
    outputTokens: openAIFixture.COMPLETION_TOKENS,
    cacheReadTokens: openAIFixture.CACHED_TOKENS,
    cacheWriteTokens: openAIFixture.CACHE_WRITE_TOKENS,
    reasoningTokens: 0,
    final: true,
    ...overrides,
  }
}

/** The text-then-one-tool-call turn, as the accumulator folds it on either wire. */
function textThenCall(text: string, id: string, name: string): ContentBlock[] {
  return [
    { type: 'text', text },
    { type: 'tool-request', id, name, input: { path: '/tmp/a.ts' } },
  ]
}

const CASES: readonly DriveCase[] = [
  {
    name: 'anthropic',
    definition: anthropicDefinition,
    frames: anthropicFixture.ONE_TOOL_CALL_FRAMES,
    secrets: { apiKey: API_KEY },
    config: {},
    content: textThenCall(
      anthropicFixture.TOOL_PREAMBLE,
      anthropicFixture.TOOL_ID,
      anthropicFixture.TOOL_NAME,
    ),
    stop: { reason: 'tool-use', providerReason: 'tool_use' },
    usage: anthropicUsage(),
    url: `${ANTHROPIC_DEFAULT_BASE_URL}/v1/messages`,
    credential: { name: 'x-api-key', value: API_KEY },
  },
  {
    name: 'zhipu',
    definition: zhipuDefinition,
    frames: openAIFixture.TEXT_THEN_TOOL_CALL_FRAMES,
    secrets: { apiKey: API_KEY },
    config: {},
    content: textThenCall(
      openAIFixture.TOOL_PREAMBLE,
      openAIFixture.TOOL_ID,
      openAIFixture.TOOL_NAME,
    ),
    stop: { reason: 'tool-use', providerReason: 'tool_calls' },
    usage: openAIUsage(),
    url: `${ZHIPU_DEFAULT_BASE_URL}chat/completions`,
    credential: { name: 'authorization', value: `Bearer ${API_KEY}` },
  },
  {
    name: 'ollama',
    definition: ollamaDefinition,
    frames: openAIFixture.TEXT_THEN_TOOL_CALL_FRAMES,
    // No secret at all: this provider's key is a non-secret config item with a default.
    secrets: {},
    config: {},
    content: textThenCall(
      openAIFixture.TOOL_PREAMBLE,
      openAIFixture.TOOL_ID,
      openAIFixture.TOOL_NAME,
    ),
    stop: { reason: 'tool-use', providerReason: 'tool_calls' },
    usage: openAIUsage(),
    url: `${OLLAMA_DEFAULT_BASE_URL}chat/completions`,
    // The spec's reason for giving ollama an apiKey at all: the SDK needs a non-empty one.
    credential: { name: 'authorization', value: `Bearer ${OLLAMA_DEFAULT_API_KEY}` },
  },
  {
    name: 'acme (registered in this test file)',
    definition: acmeDefinition,
    frames: openAIFixture.TEXT_THEN_TOOL_CALL_FRAMES,
    secrets: { apiKey: API_KEY },
    config: {},
    content: textThenCall(
      openAIFixture.TOOL_PREAMBLE,
      openAIFixture.TOOL_ID,
      openAIFixture.TOOL_NAME,
    ),
    stop: { reason: 'tool-use', providerReason: 'tool_calls' },
    usage: openAIUsage(),
    url: `${ACME_BASE_URL}/chat/completions`,
    credential: { name: 'authorization', value: `Bearer ${API_KEY}` },
  },
]

interface DriveResult {
  readonly events: StreamEvent[]
  readonly content: ContentBlock[]
  readonly net: FakeNetwork
  readonly model: ModelInfo
}

/**
 * THE call path, identical for every case: look the definition up in the registry, create a
 * provider from host capabilities alone, encode, stream, fold. No branch on the provider id and no
 * mention of a wire anywhere in it.
 */
async function drive(registry: ProviderRegistry, testCase: DriveCase): Promise<DriveResult> {
  const definition = registry.get(testCase.definition.id)
  if (definition === null) throw new Error(`${testCase.definition.id} is not registered`)
  const net = fakeNetwork({ kind: 'sse', frames: testCase.frames })
  const provider = definition.create({
    network: net,
    clock: { now: () => NOW },
    config: applyDefaults(definition, testCase.config),
    secrets: testCase.secrets,
  })
  const models = await provider.models()
  const model = models[0]
  if (model === undefined) throw new Error(`${definition.id} has no builtin model`)
  const encoded = provider.encode({
    model,
    system: 'be brief',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read /tmp/a.ts' }] }],
    tools: [TOOL],
  })
  const blocks = createBlockAccumulator({ provider: provider.id, providerModel: model.id })
  const events: StreamEvent[] = []
  for await (const event of provider.stream(encoded, { identity: IDENTITY })) {
    events.push(event)
    blocks.apply(event)
  }
  return { events, content: blocks.content(), net, model }
}

/** The one terminal event a cancelled run may end on, whichever definition produced it. */
const ABORTED_STOP: StreamEvent = { type: 'stop', reason: 'aborted', providerReason: null }

/**
 * THE call path once more, with a signal — and still no branch on the provider id. Invariant 2 has
 * two halves: a signal already aborted when `stream()` is called never reaches the wire, and one
 * aborted mid-stream ends the run on the same single terminal event as every other provider's.
 *
 * `'mid-stream'` releases every frame but the last, so the source can never reach its own
 * end-of-stream marker (`message_stop` / `[DONE]`): the run can only finish through the abort, and
 * it does so without a timer.
 */
async function driveWithAbort(
  registry: ProviderRegistry,
  testCase: DriveCase,
  when: 'before' | 'mid-stream',
): Promise<{ events: StreamEvent[]; net: FakeNetwork }> {
  const definition = registry.get(testCase.definition.id)
  if (definition === null) throw new Error(`${testCase.definition.id} is not registered`)
  const gate = createStreamGate()
  const net = fakeNetwork({ kind: 'sse', frames: testCase.frames, gate })
  const provider = definition.create({
    network: net,
    clock: { now: () => NOW },
    config: applyDefaults(definition, testCase.config),
    secrets: testCase.secrets,
  })
  const model = (await provider.models())[0]
  if (model === undefined) throw new Error(`${definition.id} has no builtin model`)
  const encoded = provider.encode({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read /tmp/a.ts' }] }],
  })
  const controller = new AbortController()
  if (when === 'before') controller.abort()
  const stream = provider.stream(encoded, { identity: IDENTITY, signal: controller.signal })
  const iterator = stream[Symbol.asyncIterator]()
  const events: StreamEvent[] = []
  if (when === 'mid-stream') {
    gate.release(testCase.frames.length - 1)
    const first = await iterator.next()
    if (first.done === true) throw new Error(`${definition.id}: the stream ended before any event`)
    events.push(first.value)
    controller.abort()
  }
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- draining a stream is sequential by nature
    const step = await iterator.next()
    if (step.done === true) break
    events.push(step.value)
  }
  return { events, net }
}

/** What the caller of `create()` owes it: non-secret items with their declared defaults applied. */
function applyDefaults(
  definition: ProviderDefinition,
  config: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of definition.configKeys) {
    if (key.secret) continue
    const value = config[key.name] ?? key.default
    if (value !== undefined) out[key.name] = value
  }
  return { ...out, ...config }
}

/** Invariants 1-6, asserted identically for every provider. */
function checkInvariants(events: readonly StreamEvent[]): void {
  // 1: exactly one terminal event, last, with every usage reading before it and one final reading.
  const terminals = events.filter((event) => event.type === 'stop' || event.type === 'error')
  expect(terminals).toHaveLength(1)
  expect(events.at(-1)).toBe(terminals[0])
  expect(events.filter((event) => event.type === 'usage' && event.usage.final)).toHaveLength(1)
  // 3: a wire error is an event, never a rejection — reaching here at all is that assertion.
  expect(terminals[0]?.type).toBe('stop')
  // Collected first, asserted once: an assertion inside the loop would be a conditional one.
  const started = new Set<number>()
  const ended = new Set<number>()
  const unstartedFragments: number[] = []
  const badInputs: unknown[] = []
  const unstartedEnds: number[] = []
  for (const event of events) {
    if (event.type === 'tool-call-start') started.add(event.index)
    if (event.type === 'tool-call-args-delta' && !started.has(event.index)) {
      unstartedFragments.push(event.index)
    }
    if (event.type === 'tool-call-end') {
      ended.add(event.index)
      if (!started.has(event.index)) unstartedEnds.push(event.index)
      if (!isPlainObject(event.input)) badInputs.push(event.input)
    }
  }
  // 4: no fragment before its index started.
  expect(unstartedFragments).toEqual([])
  // 6: an object input, never null and never a JSON string.
  expect(badInputs).toEqual([])
  // 5: every call the transcript will hold both started and ended on this wire's happy path.
  expect(unstartedEnds).toEqual([])
  expect(ended.size).toBe(started.size)
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const TAPE_IDENTITY = {
  userId: 'acceptance-1-user',
  tenantId: 'acceptance-1-tenant',
  profileDir: '/tenon/acceptance-1',
}

interface TapeDrive {
  readonly entries: TapeEntry[]
  readonly result: RunResult
  readonly model: ModelInfo
}

/**
 * THE call path again, one layer up: the same definition, the same fixture, through the kernel session
 * service into a memory store. Nothing in it names a provider either.
 */
async function driveThroughTape(
  registry: ProviderRegistry,
  testCase: DriveCase,
): Promise<TapeDrive> {
  const definition = registry.get(testCase.definition.id)
  if (definition === null) throw new Error(`${testCase.definition.id} is not registered`)
  const net = fakeNetwork({ kind: 'sse', frames: testCase.frames })
  const provider = definition.create({
    network: net,
    clock: { now: () => NOW },
    config: applyDefaults(definition, testCase.config),
    secrets: testCase.secrets,
  })
  const model = (await provider.models())[0]
  if (model === undefined) throw new Error(`${definition.id} has no builtin model`)
  const store = createMemoryTapeStore({ identity: TAPE_IDENTITY })
  let clock = NOW
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
    ids: createCounterIds(),
  })
  const { sessionId } = await service.createSession()
  const result = await service.runRequest({
    sessionId,
    user: { text: 'read /tmp/a.ts' },
    provider,
    model,
    system: 'be brief',
    tools: [TOOL],
  })
  const page = await store.readRange({ sessionId, limit: 100 })
  await store.close()
  return { entries: page.entries, result, model }
}

/** A fact minus its values: what has to be identical whichever provider produced the turn. */
function describeFact(entry: TapeEntry): unknown {
  return {
    name: entry.name,
    kind: entry.kind,
    sourceType: entry.sourceType,
    sourceSeq: entry.sourceSeq,
    payloadKeys: Object.keys(entry.payload).toSorted(),
    meta: entry.meta,
  }
}

/** The five facts of one turn. */
const TURN_SHAPE: readonly unknown[] = [
  {
    name: 'session/start',
    kind: 'anchor',
    sourceType: 'session',
    sourceSeq: 0,
    payloadKeys: ['incarnationId'],
    meta: {},
  },
  {
    name: 'message/user',
    kind: 'message',
    sourceType: 'message',
    sourceSeq: 0,
    payloadKeys: ['content', 'messageId', 'revision', 'role', 'status'],
    meta: {},
  },
  {
    name: 'session/model_selected',
    kind: 'event',
    sourceType: 'session',
    sourceSeq: null,
    payloadKeys: ['modelId', 'providerId'],
    meta: {},
  },
  {
    name: 'message/assistant',
    kind: 'message',
    sourceType: 'message',
    sourceSeq: 0,
    payloadKeys: ['content', 'messageId', 'revision', 'role', 'runId', 'status'],
    meta: {},
  },
  {
    name: 'provider/attempt_completed',
    kind: 'event',
    sourceType: 'runtime_event',
    sourceSeq: 1,
    payloadKeys: [
      'contextAtEntryId',
      'error',
      'modelId',
      'promptHash',
      'providerId',
      'request',
      'stop',
      'thinkingDecisions',
      'toolDefinitionsHash',
      'usage',
    ],
    meta: {},
  },
]

describe('acceptance 1 — one call path, four providers', () => {
  const registry = createProviderRegistry()
  registerBuiltinProviders(registry)
  // The fourth provider: one `register()` call with a definition written in this file. No class,
  // no encoder, no branch anywhere in the kernel.
  registry.register(acmeDefinition)

  for (const testCase of CASES) {
    it(`drives ${testCase.name} through the same path`, async () => {
      const result = await drive(registry, testCase)
      checkInvariants(result.events)
      // The accumulated turn, with the thinking-block stamps the fold applies (there are none in
      // this fixture shape, which keeps the four comparable).
      expect(result.content).toEqual(testCase.content)
      expect(result.events.at(-1)).toEqual({ type: 'stop', ...testCase.stop })
      const finalUsage = result.events.find((event) => event.type === 'usage' && event.usage.final)
      expect(finalUsage?.type === 'usage' ? finalUsage.usage : null).toEqual(testCase.usage)
      // One physical request per stream (invariant 8's other half: maxRetries is 0).
      expect(result.net.callCount).toBe(1)
      const request = result.net.requests[0]
      expect(request?.url).toBe(testCase.url)
      expect(request?.headers[testCase.credential.name]).toBe(testCase.credential.value)
      // The model the definition offered is the model that went on the wire.
      expect((request?.body as { model?: string } | undefined)?.model).toBe(result.model.id)
    })
  }

  for (const testCase of CASES) {
    it(`ends ${testCase.name} on one aborted stop, before the wire and mid-stream`, async () => {
      // Invariant 2, from the same four definitions and with no per-provider branch: an abort is a
      // `stop`, never an `error` and never a rejection. Catches a withTerminalEvent that maps an
      // aborted signal onto its `mapError` path — the whole suite's abort cases are otherwise
      // written per wire, and none of them asserts the terminal's TYPE across all four.
      const before = await driveWithAbort(registry, testCase, 'before')
      expect(before.events).toEqual([ABORTED_STOP])
      // The other half of invariant 2: an already-aborted signal never touches the wire.
      expect(before.net.callCount).toBe(0)

      const mid = await driveWithAbort(registry, testCase, 'mid-stream')
      const terminals = mid.events.filter(
        (event) => event.type === 'stop' || event.type === 'error',
      )
      expect(terminals).toEqual([ABORTED_STOP])
      // Exactly one, and LAST: nothing the source had queued behind the abort may follow it.
      expect(mid.events.at(-1)).toBe(terminals[0])
      // And it really was mid-stream: content arrived before the abort, from a live request.
      expect(mid.events.length).toBeGreaterThan(1)
      expect(mid.net.callCount).toBe(1)
    })
  }

  for (const testCase of CASES) {
    it(`writes the same-shaped Tape facts for ${testCase.name}`, async () => {
      const { entries, result, model } = await driveThroughTape(registry, testCase)
      // The shape: which facts a turn writes, in which order, with which identity columns and which
      // payload keys. Identical for all four — a provider that needed a sixth fact, a different
      // ordering or an extra payload key would be a provider the tape's readers have to branch on.
      expect(entries.map(describeFact)).toEqual(TURN_SHAPE)
      // …and the values, which are the only thing that may differ.
      const [, , modelSelected, assistant, attempt] = entries
      expect(modelSelected?.payload).toEqual({
        providerId: testCase.definition.id,
        modelId: model.id,
      })
      expect(assistant?.payload['content']).toEqual(testCase.content)
      expect(assistant?.payload['status']).toBe('complete')
      expect(assistant?.payload['runId']).toBe(result.identity.runId)
      expect(attempt?.payload['providerId']).toBe(testCase.definition.id)
      expect(attempt?.payload['modelId']).toBe(model.id)
      expect(attempt?.payload['stop']).toEqual(testCase.stop)
      expect(attempt?.payload['usage']).toEqual(testCase.usage)
      expect(attempt?.payload['error']).toBeNull()
      expect(attempt?.payload['request']).toEqual({
        systemHash: expect.any(String),
        maxTokens: model.maxOutputTokens,
      })
      // The prefix this request was assembled from is the head after the two pre-run facts.
      expect(attempt?.payload['contextAtEntryId']).toBe(modelSelected?.entryId)
      expect(attempt?.provenanceKey).toBe(`provider:v1:attempt:${result.identity.runId}:1:1`)
    })
  }

  it('lists the four in registration order and refuses a second claim on an id', () => {
    expect(registry.list().map((definition) => definition.id)).toEqual([
      'anthropic',
      'zhipu',
      'ollama',
      ACME_ID,
    ])
    // A second definition claiming an id would silently re-point every configured credential.
    expect(() => registerBuiltinProviders(registry)).toThrow(ProviderAlreadyRegisteredError)
  })
})

describe('builtin provider definitions', () => {
  it('registers the three the spec names, in that order', () => {
    expect(BUILTIN_PROVIDERS.map((definition) => definition.id)).toEqual([
      'anthropic',
      'zhipu',
      'ollama',
    ])
    const registry = createProviderRegistry()
    registerBuiltinProviders(registry)
    expect(registry.get('anthropic')).toBe(anthropicDefinition)
    expect(registry.get('zhipu')).toBe(zhipuDefinition)
    expect(registry.get('ollama')).toBe(ollamaDefinition)
    expect(registry.get('openai')).toBeNull()
    // Spec 02 changes rows, not providers, and leaves ollama's one row able to call tools.
    expect(
      ollamaDefinition.builtinModels.map((model) => [model.id, model.supportsToolCalling]),
    ).toEqual([['qwen3:8b', true]])
  })

  it('declares the wires and default base URLs of the spec table', () => {
    expect(anthropicDefinition.wire).toBe('anthropic-messages')
    expect(zhipuDefinition.wire).toBe('openai-chat')
    expect(ollamaDefinition.wire).toBe('openai-chat')
    expect(defaultOf(anthropicDefinition, 'baseURL')).toBe('https://api.anthropic.com')
    expect(defaultOf(zhipuDefinition, 'baseURL')).toBe('https://open.bigmodel.cn/api/paas/v4/')
    expect(defaultOf(ollamaDefinition, 'baseURL')).toBe('http://localhost:11434/v1/')
  })

  it('declares the config keys of the spec table, secrets included', () => {
    expect(describeKeys(anthropicDefinition)).toEqual([
      { name: 'apiKey', secret: true, required: false, primary: true, default: undefined },
      { name: 'authToken', secret: true, required: false, primary: undefined, default: undefined },
      {
        name: 'baseURL',
        secret: false,
        required: true,
        primary: undefined,
        default: ANTHROPIC_DEFAULT_BASE_URL,
      },
    ])
    // `primary` is marked in exactly one cell of the spec's table — anthropic's `apiKey`, where two
    // credentials compete to be asked for first — so it is absent here and on ollama's baseURL.
    expect(describeKeys(zhipuDefinition)).toEqual([
      { name: 'apiKey', secret: true, required: true, primary: undefined, default: undefined },
      {
        name: 'baseURL',
        secret: false,
        required: true,
        primary: undefined,
        default: ZHIPU_DEFAULT_BASE_URL,
      },
    ])
    // The spec's exact words for ollama: non-secret, not required, default 'ollama'.
    expect(describeKeys(ollamaDefinition)).toEqual([
      {
        name: 'baseURL',
        secret: false,
        required: true,
        primary: undefined,
        default: OLLAMA_DEFAULT_BASE_URL,
      },
      {
        name: 'apiKey',
        secret: false,
        required: false,
        primary: undefined,
        default: OLLAMA_DEFAULT_API_KEY,
      },
    ])
  })

  it("falls back to ollama's default key when the field was cleared, not just absent", async () => {
    // `required: false` with a default has to mean it: the settings card stores a cleared non-secret
    // field as '', and refusing that would name a key the definition says is optional.
    const net = fakeNetwork({ kind: 'sse', frames: openAIFixture.PLAIN_TEXT_FRAMES })
    const provider = ollamaDefinition.create({
      network: net,
      clock: { now: () => NOW },
      config: { apiKey: '', baseURL: OLLAMA_DEFAULT_BASE_URL },
      secrets: {},
    })
    const model = (await provider.models())[0]
    if (model === undefined) throw new Error('ollama has no builtin model')
    const encoded = provider.encode({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    for await (const event of provider.stream(encoded, { identity: IDENTITY })) void event
    expect(net.requests[0]?.headers.authorization).toBe(`Bearer ${OLLAMA_DEFAULT_API_KEY}`)
  })

  it('records no usage for zhipu on an endpoint that gates it behind the opt-in', async () => {
    // The falsifiable half of `usageNeedsOptIn: false` (see the note on zhipu's ModelInfo rows): no
    // zhipu request asks for usage. 01's live record (2026-09-22) found the vendor reports it
    // without the opt-in; an endpoint that gated it would make THIS what every
    // `provider/attempt_completed` records — a zero indistinguishable from a free turn. Pinned so
    // the choice stays visible rather than assumed.
    const net = fakeNetwork({ kind: 'sse', frames: openAIFixture.NO_USAGE_FRAMES })
    const provider = zhipuDefinition.create({
      network: net,
      clock: { now: () => NOW },
      config: {},
      secrets: { apiKey: API_KEY },
    })
    const model = (await provider.models())[0]
    if (model === undefined) throw new Error('zhipu has no builtin model')
    expect(model.usageNeedsOptIn).toBe(false)
    const encoded = provider.encode({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect((encoded.body as Record<string, unknown>).stream_options).toBeUndefined()
    const events: StreamEvent[] = []
    for await (const event of provider.stream(encoded, { identity: IDENTITY })) events.push(event)
    expect(events.filter((event) => event.type === 'usage')).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end-turn', providerReason: 'stop' })
  })

  it('names everything with i18n keys rather than sentences', () => {
    // 00-foundation §国际化: the kernel never produces prose. A key, not a phrase — no spaces, at
    // least two dotted segments.
    const key = /^[a-z][\w-]*(?:\.[\w-]+)+$/i
    for (const definition of BUILTIN_PROVIDERS) {
      expect(definition.nameKey).toMatch(key)
      for (const configKey of definition.configKeys) expect(configKey.labelKey).toMatch(key)
    }
  })

  it('keeps every builtin model consistent with its own declarations', () => {
    // Every row's findings collected first, so one failure names the row instead of a boolean.
    const foreign: string[] = []
    const badLimits: string[] = []
    const missingEchoField: string[] = []
    const misplacedSignedBlocks: string[] = []
    const emptyTables: string[] = []
    for (const definition of BUILTIN_PROVIDERS) {
      if (definition.builtinModels.length === 0) emptyTables.push(definition.id)
      for (const model of definition.builtinModels) {
        // BaseProvider.complete() refuses a foreign ModelInfo, and the thinking guard compares on
        // this field: a mis-keyed row would label one provider's thinking as another's.
        if (model.providerId !== definition.id) foreign.push(model.id)
        if (model.maxOutputTokens < 1 || model.maxOutputTokens > model.contextLimit) {
          badLimits.push(model.id)
        }
        // plan.md, step 8: a 'reasoning-content' model must name the field it echoes under.
        if (
          model.thinkingPreservationFormat === 'reasoning-content' &&
          model.reasoningEchoField === undefined
        ) {
          missingEchoField.push(model.id)
        }
        // Only the Anthropic wire carries signed blocks; the other one throws on replay.
        if (
          model.thinkingPreservationFormat === 'signed-blocks' &&
          definition.wire !== 'anthropic-messages'
        ) {
          misplacedSignedBlocks.push(model.id)
        }
      }
    }
    expect(emptyTables).toEqual([])
    expect(foreign).toEqual([])
    expect(badLimits).toEqual([])
    expect(missingEchoField).toEqual([])
    expect(misplacedSignedBlocks).toEqual([])
  })

  it('hands out models a caller cannot edit through the provider', async () => {
    const provider = zhipuDefinition.create({
      network: fakeNetwork([]),
      clock: { now: () => NOW },
      config: { baseURL: ZHIPU_DEFAULT_BASE_URL },
      secrets: { apiKey: API_KEY },
    })
    const models = await provider.models()
    expect(models).toEqual(zhipuDefinition.builtinModels)
    models.pop()
    expect(await provider.models()).toEqual(zhipuDefinition.builtinModels)
    // The ROWS, not just the array: `readonly ModelInfo[]` is a compile-time claim, and one
    // assignment to a shared row would change every later `encode()` (`max_tokens`) and every
    // recorded ModelInfo for the rest of the process. Frozen, so it throws where it is written.
    const row = (await provider.models())[0]
    if (row === undefined) throw new Error('zhipu has no builtin model')
    const limit = row.contextLimit
    expect(() => {
      row.contextLimit = 1
    }).toThrow(TypeError)
    // Nested objects too: `requestParams` reaches the hashed body by reference.
    expect(() => {
      ;(row.requestParams as Record<string, unknown>)['thinking'] = 'off'
    }).toThrow(TypeError)
    expect(zhipuDefinition.builtinModels[0]?.contextLimit).toBe(limit)
  })
})

/** Spec 02 §内置模型表的数据改动: the zhipu table, in order. */
const ZHIPU_ROWS: readonly string[] = ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-4.6']

const REASONING = 'the user wants the file; read it first'

/** One tool round trip whose reasoning was produced by `modelId`, as the Tape would replay it. */
function toolRoundTrip(modelId: string): InternalMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'read /tmp/a.ts' }] },
    {
      role: 'assistant',
      content: [
        // The OpenAI wire's fold leaves the signature empty: this vendor issues none.
        {
          type: 'thinking',
          text: REASONING,
          signature: '',
          provider: 'zhipu',
          providerModel: modelId,
        },
        { type: 'tool-request', id: 'call_1', name: TOOL.name, input: { path: '/tmp/a.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool-response',
          id: 'call_1',
          content: [{ type: 'text', text: 'export {}' }],
          isError: false,
        },
      ],
    },
  ]
}

/** The assistant turn of `toolRoundTrip()` on the wire, without its reasoning. */
const WIRE_CALL = {
  role: 'assistant',
  tool_calls: [
    {
      id: 'call_1',
      type: 'function',
      function: { name: TOOL.name, arguments: '{"path":"/tmp/a.ts"}' },
    },
  ],
}

describe('the model rows spec 02 changes', () => {
  it('keeps glm-5.3 first and adds the flash pair ahead of glm-4.6', () => {
    // The first row is the fallback for a user who never picked a model (02 decision M5).
    expect(zhipuDefinition.builtinModels.map((model) => model.id)).toEqual(ZHIPU_ROWS)
  })

  it('gives every zhipu row tools, the reasoning echo and tool_stream', () => {
    expect(
      zhipuDefinition.builtinModels.map((model) => ({
        id: model.id,
        reasoning: model.reasoning,
        supportsCacheControl: model.supportsCacheControl,
        usageNeedsOptIn: model.usageNeedsOptIn,
        supportsToolCalling: model.supportsToolCalling,
        supportsStreamingToolCalls: model.supportsStreamingToolCalls,
        thinkingPreservationFormat: model.thinkingPreservationFormat,
        reasoningEchoField: model.reasoningEchoField,
        requestParams: model.requestParams,
      })),
    ).toEqual(
      ZHIPU_ROWS.map((id) => ({
        id,
        reasoning: true,
        // Caching is implicit on this vendor, and usage arrives without the opt-in (01 live record).
        supportsCacheControl: false,
        usageNeedsOptIn: false,
        supportsToolCalling: true,
        // Probe TS (2026-09-26): all four streamed argument fragments with `tool_stream: true` and
        // none refused it. A row that refused it would be false here and send no `tool_stream`.
        supportsStreamingToolCalls: true,
        thinkingPreservationFormat: 'reasoning-content',
        reasoningEchoField: 'reasoning_content',
        // Exactly these: `clear_thinking` stays at the vendor default by never being sent.
        requestParams: { thinking: { type: 'enabled' }, tool_stream: true },
      })),
    )
  })

  it('gives the flash pair 1M / 128K and image input, and keeps the other two text-only', () => {
    expect(
      zhipuDefinition.builtinModels.map((model) => [
        model.id,
        model.contextLimit,
        model.maxOutputTokens,
        model.supportsVision,
      ]),
    ).toEqual([
      ['glm-5.3', 1_000_000, 128_000, false],
      // Probe V (2026-09-26): both named the colour of a base64 PNG; glm-5.3 answered 400.
      ['glm-5.3-flash', 1_000_000, 128_000, true],
      ['glm-5.3-flashx', 1_000_000, 128_000, true],
      ['glm-4.6', 200_000, 128_000, false],
    ])
  })

  it('prices the zhipu rows in CNY and leaves glm-4.6, which the vendor does not list, unpriced', () => {
    // No `cacheWritePerMTok`: the vendor quotes no cache-write price, only hourly storage.
    expect(
      Object.fromEntries(zhipuDefinition.builtinModels.map((model) => [model.id, model.pricing])),
    ).toEqual({
      'glm-5.3': { inputPerMTok: 8, outputPerMTok: 28, cacheReadPerMTok: 2, currency: 'CNY' },
      'glm-5.3-flash': {
        inputPerMTok: 0.8,
        outputPerMTok: 2.8,
        cacheReadPerMTok: 0.23,
        currency: 'CNY',
      },
      'glm-5.3-flashx': {
        inputPerMTok: 2,
        outputPerMTok: 7,
        cacheReadPerMTok: 0.57,
        currency: 'CNY',
      },
      'glm-4.6': undefined,
    })
  })

  for (const id of ZHIPU_ROWS) {
    it(`echoes ${id}'s own reasoning_content when the request carries tools, and only then`, async () => {
      const provider = zhipuDefinition.create({
        network: fakeNetwork([]),
        clock: { now: () => NOW },
        config: { baseURL: ZHIPU_DEFAULT_BASE_URL },
        secrets: { apiKey: API_KEY },
      })
      const model = (await provider.models()).find((row) => row.id === id)
      if (model === undefined) throw new Error(`zhipu has no ${id} row`)
      const history = toolRoundTrip(id)

      // Rule 4 of the guard: the second turn's assistant message carries the same model's reasoning.
      const withTools = provider.encode({ model, messages: history, tools: [TOOL] })
      expect((withTools.body as { messages: unknown[] }).messages[1]).toEqual({
        ...WIRE_CALL,
        reasoning_content: REASONING,
      })
      expect(withTools.thinkingDecisions).toEqual([{ action: 'echo', reason: 'same-model' }])

      // The same history with no tools: nothing is echoed, and the audit says why.
      const without = provider.encode({ model, messages: history })
      expect((without.body as { messages: unknown[] }).messages[1]).toEqual(WIRE_CALL)
      expect(without.thinkingDecisions).toEqual([{ action: 'drop', reason: 'no-tools' }])
      expect(JSON.stringify(without.body)).not.toContain(REASONING)

      // Another row's reasoning is never echoed, tools or not: the four are four models.
      const sibling = ZHIPU_ROWS.find((other) => other !== id) ?? id
      const foreign = provider.encode({ model, messages: toolRoundTrip(sibling), tools: [TOOL] })
      expect(foreign.thinkingDecisions).toEqual([{ action: 'drop', reason: 'model-changed' }])
      expect(JSON.stringify(foreign.body)).not.toContain(REASONING)

      // Both bodies carry the row's own parameters and nothing else of the vendor's.
      for (const encoded of [withTools, without]) {
        const body = encoded.body as Record<string, unknown>
        expect(body['thinking']).toEqual({ type: 'enabled' })
        expect(body['tool_stream']).toBe(true)
      }
    })
  }

  it('puts Sonnet 5 first and Opus 5.5 second until the prefix acceptance passes', () => {
    // 02 decision A16's ownerNote: the order changes once an official key passes, not before.
    expect(anthropicDefinition.builtinModels.map((model) => model.id)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-haiku-4-5-20251001',
      'claude-fable-5-1',
    ])
    const opus = anthropicDefinition.builtinModels[1]
    expect(opus).toMatchObject({
      id: 'claude-opus-5-5',
      providerId: 'anthropic',
      contextLimit: 1_000_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      supportsToolCalling: true,
      supportsStreamingToolCalls: true,
      supportsVision: true,
      supportsCacheControl: true,
      thinkingPreservationFormat: 'signed-blocks',
      usageNeedsOptIn: false,
    })
    // Exact, so no `currency` key: absent reads as USD, like every sibling on this vendor.
    expect(opus?.pricing).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 5,
    })
    expect(anthropicDefinition.builtinModels.map((model) => model.pricing?.currency)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})

function defaultOf(definition: ProviderDefinition, name: string): string | undefined {
  return definition.configKeys.find((key) => key.name === name)?.default
}

function describeKeys(definition: ProviderDefinition): unknown[] {
  return definition.configKeys.map((key) => ({
    name: key.name,
    secret: key.secret,
    required: key.required,
    primary: key.primary,
    default: key.default,
  }))
}
