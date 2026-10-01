/**
 * Spec 02, acceptance 7 (the parts plan step 6 can run): what the vendor sends verbatim survives the
 * Tape and goes back to the model that sent it, byte for byte, and nowhere else (旧 43); a call the
 * vendor ran itself is archived, never dispatched and never sent back (旧 101, 01 修补 9 (t)); and
 * the attempt fact says which encoder and which ModelInfo fields produced its bytes (旧 112, 旧 42).
 *
 * The path is the real one end to end: the Anthropic adapter over fakeNetwork, the session service
 * and its loop, a memory Tape, and the NEXT request rebuilt from that Tape — so "replayed as stored" is about what
 * the stored fact reproduces, not about an object a test kept in hand. Every request of every run
 * is checked with `assertToolPairing` and `assertLastTurnIsUser` as it leaves.
 *
 * The other half of 旧 112 and 旧 42 — `canonicalHash(model)` against `view/assembled.modelInfoHash`,
 * re-encoding from the assembly's ModelInfo, and the re-check that says 「模型表已变」 rather than
 * 「被篡改」 (02 不变量 33) — is attempt-recheck.test.ts, over step 10's assembly record.
 */
import { describe, expect, it } from 'vitest'
import {
  ProviderInvalidArgumentError,
  WIRE_MODEL_FIELDS,
  anthropicDefinition,
  canonicalJson,
  createMemoryHost,
  createMemoryTapeStore,
  createSessionService,
  decideVendorFields,
  encodeAnthropicMessages,
  encodeOpenAIChat,
  modelWireHash,
  sha256Hex,
  zhipuDefinition,
} from '../../src/index.js'
import type {
  ContentBlock,
  InternalMessage,
  ModelInfo,
  ProviderRequest,
  TapeEntry,
  TapeStore,
} from '../../src/index.js'
import {
  assertLastTurnIsUser,
  assertToolPairing,
  createCounterIds,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
} from '../../src/testing/index.js'
import type { FakeNetwork } from '../../src/testing/index.js'
import { LOOK, instantHost, lookSource } from '../loop/support.js'
import * as fixture from './fixtures/anthropic-sse.js'
import { TOOL, anthropicModel, assistant, openAIModel, requestOf, user } from './wire/fixtures.js'

const TAPE_IDENTITY = {
  userId: 'vendor-blocks-user',
  tenantId: 'vendor-blocks-tenant',
  profileDir: '/tenon/vendor-blocks',
}

const MODEL = anthropicModel()
const OTHER_MODEL = anthropicModel({ id: 'claude-test-5' })

interface Session {
  readonly net: FakeNetwork
  readonly store: TapeStore
  readonly sessionId: string
  /** One run: the user's text, answered by the next scripted stream, on `model`. */
  send(text: string, model?: ModelInfo): Promise<TapeEntry>
}

/** A session over the real Anthropic adapter, answering from `streams` in order. */
async function session(streams: readonly (readonly string[])[]): Promise<Session> {
  const net = fakeNetwork(
    streams.map((frames) => ({ kind: 'sse' as const, frames })),
    {
      checkRequest: (request) => {
        assertToolPairing(request)
        assertLastTurnIsUser(request)
      },
    },
  )
  const provider = anthropicDefinition.create({
    network: net,
    clock: { now: () => 0, setTimeout: () => () => undefined },
    config: { baseURL: 'https://api.anthropic.test' },
    secrets: { apiKey: 'test-key-not-a-real-credential' },
  })
  const store = createMemoryTapeStore({ identity: TAPE_IDENTITY })
  let clock = 1_000
  const host = createMemoryHost()
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
  const service = createSessionService({
    host: {
      ...host,
      clock: { now: () => (clock += 1), setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms) },
    },
    tape: store,
    ids: createCounterIds(),
    inspectors: [],
    connector: loop.connector,
    protectedFiles: [],
  })
  service.bindLoop(loop)
  const { sessionId } = await service.createSession()
  return {
    net,
    store,
    sessionId,
    async send(text, model = MODEL) {
      loop.connector.use({ provider, model })
      const sent = await service.send({ sessionId, origin: null, text })
      if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
      await loop.runEnded({ runId: sent.runId })
      const attempt = (
        await store.readBySource({
          sessionId,
          sourceType: 'runtime_event',
          sourceId: sent.runId,
          limit: 10,
        })
      ).find((entry) => entry.name === 'provider/attempt_completed')
      if (attempt === undefined) throw new Error('no attempt fact')
      return attempt
    },
  }
}

interface ToolSession {
  readonly net: FakeNetwork
  readonly store: TapeStore
  readonly sessionId: string
  /** One run on `model`, which may call `LOOK`; answers the run's attempt facts in request order. */
  send(text: string, model?: ModelInfo): Promise<TapeEntry[]>
}

/**
 * A session over the real Anthropic adapter whose first answer carries the vendor fields of a
 * redacted, a text and a tool_use block and calls `LOOK`, answered next by plain text; `more` are the
 * streams after those two.
 */
async function toolSession(...more: (readonly string[])[]): Promise<ToolSession> {
  const net = fakeNetwork(
    [fixture.vendorFieldsFrames(LOOK, JSON.stringify({ at: 'a' })), fixture.PLAIN_TEXT_FRAMES]
      .concat(more)
      .map((frames) => ({ kind: 'sse' as const, frames })),
    {
      checkRequest: (request) => {
        assertToolPairing(request)
        assertLastTurnIsUser(request)
      },
    },
  )
  const provider = anthropicDefinition.create({
    network: net,
    clock: { now: () => 0, setTimeout: () => () => undefined },
    config: { baseURL: 'https://api.anthropic.test' },
    secrets: { apiKey: 'test-key-not-a-real-credential' },
  })
  const store = createMemoryTapeStore({ identity: TAPE_IDENTITY })
  const loop = createTestLoopPorts({
    connector: { provider, model: MODEL, mcpSources: [lookSource([])] },
  })
  const service = createTestSessionService(
    {
      host: instantHost(),
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
    },
    { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }) },
  )
  service.bindLoop(loop)
  const { sessionId } = await service.createSession()
  return {
    net,
    store,
    sessionId,
    async send(text, model = MODEL) {
      loop.connector.use({ provider, model, mcpSources: [lookSource([])] })
      const sent = await service.send({ sessionId, origin: null, text })
      if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
      expect((await loop.runEnded({ runId: sent.runId })).reason.code).toBe('completed')
      const facts = await store.readBySource({
        sessionId,
        sourceType: 'runtime_event',
        sourceId: sent.runId,
        limit: 100,
      })
      return facts.filter((entry) => entry.name === 'provider/attempt_completed')
    },
  }
}

/** The assistant turns of a recorded request body, as the SDK sent them. */
function assistantTurns(net: FakeNetwork, index: number): unknown[][] {
  const body = net.requests[index]?.body as { messages: { role: string; content: unknown[] }[] }
  return body.messages.filter((message) => message.role === 'assistant').map((m) => m.content)
}

/** The assistant content the Tape holds, in order. */
async function storedAssistantContent(
  s: Pick<Session, 'store' | 'sessionId'>,
): Promise<ContentBlock[][]> {
  const page = await s.store.readRange({ sessionId: s.sessionId, limit: 100 })
  return page.entries
    .filter((entry) => entry.name === 'message/assistant')
    .map((entry) => entry.payload['content'] as ContentBlock[])
}

describe('vendor blocks through the Tape (旧 43)', () => {
  it('replays an unknown block and an unknown field to the same model byte for byte', async () => {
    const s = await session([fixture.VENDOR_BLOCKS_FRAMES, fixture.PLAIN_TEXT_FRAMES])
    await s.send('first')
    const second = await s.send('second')
    const [turn] = assistantTurns(s.net, 1)
    // The thinking block with its unknown field, and the unknown block, exactly as they arrived.
    expect(turn?.map((block) => canonicalJson(block))).toEqual([
      canonicalJson({
        type: 'thinking',
        thinking: fixture.THINKING_TEXT[0],
        signature: fixture.THINKING_SIGNATURE,
        ...fixture.THINKING_EXTRA_FIELD,
      }),
      canonicalJson(fixture.UNKNOWN_BLOCK),
      canonicalJson({ type: 'text', text: fixture.VENDOR_ANSWER }),
    ])
    expect(second.payload['thinkingDecisions']).toEqual([
      { action: 'replay', reason: 'same-model' },
      { action: 'replay', reason: 'same-model' },
    ])
    expect(s.net.checkFailures).toEqual([])
  })

  it('replays the unknown fields of a redacted, a text and a tool_use block byte for byte', async () => {
    // Acceptance 7 「未知字段同模型回放逐字节相同」 for the three other known block types: the text
    // block's `citations` come from citations_delta, the rest ride on the block's start. The call is
    // run, so the SAME run's next request carries the turn back, rebuilt from the Tape.
    const s = await toolSession()
    const [, next] = await s.send('look at a')
    const [turn] = assistantTurns(s.net, 1)
    expect(turn?.map((block) => canonicalJson(block))).toEqual([
      canonicalJson({
        type: 'redacted_thinking',
        data: fixture.REDACTED_DATA,
        ...fixture.REDACTED_EXTRA_FIELD,
      }),
      canonicalJson({
        type: 'text',
        text: fixture.VENDOR_FIELDS_TEXT,
        ...fixture.TEXT_EXTRA_FIELD,
        citations: [fixture.CITATION],
      }),
      canonicalJson({
        type: 'tool_use',
        id: fixture.TOOL_ID,
        name: LOOK,
        input: { at: 'a' },
        ...fixture.TOOL_USE_EXTRA_FIELD,
      }),
    ])
    // The redacted block, then one decision per field set of the text and the call (01 修补 2
    // 「每项记进 thinkingDecisions」; s6-spec-2, owner 2026-09-27). The redacted block's own fields
    // go with it under its decision.
    expect(next?.payload['thinkingDecisions']).toEqual([
      { action: 'replay', reason: 'same-model' },
      { action: 'replay', reason: 'same-model' },
      { action: 'replay', reason: 'same-model' },
    ])
    expect(s.net.checkFailures).toEqual([])
  })

  it('never lets a stored vendor field rewrite the block’s own signature or text', () => {
    // Plan step 6 (01 修补 2): the block's own keys win over its vendorFields, so what the Tape kept
    // beside a thinking block can add a field but not replace the signature or what it signed.
    const signature = fixture.THINKING_SIGNATURE
    const block: ContentBlock = {
      type: 'thinking',
      text: 'weighing it',
      signature,
      provider: 'anthropic',
      providerModel: MODEL.id,
      vendorFields: {
        ...fixture.THINKING_EXTRA_FIELD,
        signature: 'Zm9yZ2Vk',
        thinking: 'rewritten',
      },
    }
    const encoded = encodeAnthropicMessages(
      {
        model: MODEL,
        messages: [
          user({ type: 'text', text: 'a' }),
          assistant(block, { type: 'text', text: 'b' }),
          user({ type: 'text', text: 'c' }),
        ],
      },
      'anthropic',
    )
    const messages = (encoded.body as { messages: { content: unknown[] }[] }).messages
    expect(messages[1]?.content[0]).toEqual({
      type: 'thinking',
      thinking: 'weighing it',
      signature,
      ...fixture.THINKING_EXTRA_FIELD,
    })
  })

  it('drops both on a model change and records why', async () => {
    const s = await session([fixture.VENDOR_BLOCKS_FRAMES, fixture.PLAIN_TEXT_FRAMES])
    await s.send('first')
    const second = await s.send('second', OTHER_MODEL)
    const [turn] = assistantTurns(s.net, 1)
    expect(turn).toEqual([{ type: 'text', text: fixture.VENDOR_ANSWER }])
    expect(second.payload['thinkingDecisions']).toEqual([
      { action: 'drop', reason: 'model-changed' },
      { action: 'drop', reason: 'model-changed' },
    ])
    // Dropped from the request, not from the Tape: the record is still whole.
    const [stored] = await storedAssistantContent(s)
    expect(stored?.map((block) => block.type)).toEqual(['thinking', 'vendor', 'text'])
    expect(s.net.checkFailures).toEqual([])
  })

  it('drops the fields of a text and a tool_use block on a model change and records why', async () => {
    // 01 修补 2 「已知块上的未知字段……provider 或模型不同，按规则 1、2 丢」 (s6-spec-2, owner
    // 2026-09-27): the text and the call still go, without the fields another model produced.
    const s = await toolSession(fixture.PLAIN_TEXT_FRAMES)
    await s.send('look at a')
    const [switched] = await s.send('and now?', OTHER_MODEL)
    const [turn] = assistantTurns(s.net, 2)
    expect(turn).toEqual([
      { type: 'text', text: fixture.VENDOR_FIELDS_TEXT },
      { type: 'tool_use', id: fixture.TOOL_ID, name: LOOK, input: { at: 'a' } },
    ])
    expect(switched?.payload['thinkingDecisions']).toEqual([
      { action: 'drop', reason: 'model-changed' },
      { action: 'drop', reason: 'model-changed' },
      { action: 'drop', reason: 'model-changed' },
    ])
    // Dropped from the request, not from the Tape: the fields and their source are still there.
    const [stored] = await storedAssistantContent(s)
    const source = { provider: 'anthropic', providerModel: MODEL.id }
    expect(stored?.[1]).toMatchObject({ type: 'text', vendorSource: source })
    expect(stored?.[2]).toMatchObject({
      type: 'tool-request',
      vendorFields: fixture.TOOL_USE_EXTRA_FIELD,
      vendorSource: source,
    })
    expect(s.net.checkFailures).toEqual([])
  })
})

describe('vendor fields on text and tool_use blocks go through the guard (s6-spec-2)', () => {
  it('merges a same-model field set back, drops the rest, one decision each (anthropic)', () => {
    const encoded = encodeAnthropicMessages(
      { model: MODEL, messages: fieldsHistory() },
      'anthropic',
    )
    const [, turn] = (encoded.body as { messages: { content: unknown[] }[] }).messages
    expect(turn?.content).toEqual([
      { type: 'text', text: 'kept', citations: [1] },
      { type: 'tool_use', id: 't1', name: TOOL.name, input: { path: 'a' } },
      { type: 'text', text: 'foreign' },
      { type: 'text', text: 'unsourced' },
    ])
    expect(encoded.thinkingDecisions).toEqual([
      { action: 'replay', reason: 'same-model' },
      { action: 'drop', reason: 'model-changed' },
      { action: 'drop', reason: 'foreign-provider' },
      { action: 'drop', reason: 'missing-source' },
    ])
  })

  it('records the drops on the wire that has no place for the fields (openai-chat)', () => {
    const model = openAIModel()
    const encoded = encodeOpenAIChat({ model, messages: fieldsHistory() }, 'zhipu')
    const bare = encodeOpenAIChat({ model, messages: fieldsHistory().map(withoutFields) }, 'zhipu')
    // The same bytes as before the guard judged them: this wire never sent them.
    expect(encoded.promptHash).toBe(bare.promptHash)
    expect(encoded.thinkingDecisions).toEqual([
      { action: 'drop', reason: 'foreign-provider' },
      { action: 'drop', reason: 'foreign-provider' },
      { action: 'drop', reason: 'foreign-provider' },
      { action: 'drop', reason: 'missing-source' },
    ])
    expect(bare.thinkingDecisions).toEqual([])
    // A field set the guard would send back has nowhere to go here, and is refused rather than
    // dropped out of the audit, as a replayable vendor block is.
    const own = { provider: 'zhipu', providerModel: model.id } as const
    expect(() =>
      encodeOpenAIChat(
        {
          model,
          messages: [
            user({ type: 'text', text: 'a' }),
            assistant({ type: 'text', text: 'b', vendorFields: { x: 1 }, vendorSource: own }),
            user({ type: 'text', text: 'c' }),
          ],
        },
        'zhipu',
      ),
    ).toThrow(ProviderInvalidArgumentError)
  })

  it('judges with rules 1 and 2 of the vendor-block guard, on the canonical model id', () => {
    const target = { model: anthropicModel({ canonicalId: 'claude-canonical' }), hasTools: false }
    const source = { provider: 'anthropic', providerModel: 'claude-canonical' } as const
    expect(decideVendorFields(source, target)).toEqual({ action: 'replay', reason: 'same-model' })
    expect(decideVendorFields({ ...source, providerModel: target.model.id }, target)).toEqual({
      action: 'drop',
      reason: 'model-changed',
    })
    expect(decideVendorFields({ ...source, provider: 'zhipu' }, target)).toEqual({
      action: 'drop',
      reason: 'foreign-provider',
    })
    expect(decideVendorFields(undefined, target)).toEqual({
      action: 'drop',
      reason: 'missing-source',
    })
  })
})

/**
 * Field sets on text and tool-request blocks, one of each source: MODEL's own, another Anthropic
 * model's, another provider's, and one stored with no source.
 */
function fieldsHistory(): InternalMessage[] {
  const source = { provider: 'anthropic', providerModel: MODEL.id } as const
  return [
    user({ type: 'text', text: 'a' }),
    assistant(
      { type: 'text', text: 'kept', vendorFields: { citations: [1] }, vendorSource: source },
      {
        type: 'tool-request',
        id: 't1',
        name: TOOL.name,
        input: { path: 'a' },
        vendorFields: { future_tool: 1 },
        vendorSource: { ...source, providerModel: 'claude-test-3' },
      },
      {
        type: 'text',
        text: 'foreign',
        vendorFields: { future_text: 2 },
        vendorSource: { provider: 'openai', providerModel: 'gpt-test' },
      },
      { type: 'text', text: 'unsourced', vendorFields: { future_text: 3 } },
    ),
    user({ type: 'tool-response', id: 't1', isError: false, content: [] }),
  ]
}

/** The same history with no vendor fields and no source anywhere. */
function withoutFields(message: InternalMessage): InternalMessage {
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'text' && block.type !== 'tool-request') return block
      const { vendorFields: _fields, vendorSource: _source, ...rest } = block
      return rest
    }),
  }
}

describe('calls the vendor ran itself (旧 101, 01 修补 9 (t))', () => {
  it('stores them as never-replayed, dispatches none and never sends them back', async () => {
    const s = await session([fixture.SERVER_EXECUTED_FRAMES, fixture.PLAIN_TEXT_FRAMES])
    await s.send('search for tenon')
    const [stored] = await storedAssistantContent(s)
    // Three vendor blocks, all `never`, and no `tool-request` for anyone to execute.
    expect(stored?.map((block) => (block.type === 'vendor' ? block.replay : block.type))).toEqual([
      'text',
      'never',
      'never',
      'never',
      'text',
    ])
    const second = await s.send('thanks')
    // Not one of them reaches the next request, and pairing holds there without them.
    const [turn] = assistantTurns(s.net, 1)
    expect(turn).toEqual([
      { type: 'text', text: fixture.TOOL_PREAMBLE },
      { type: 'text', text: fixture.SERVER_ANSWER },
    ])
    expect(s.net.requests[1]?.bodyText).not.toContain(fixture.SERVER_TOOL_ID)
    expect(second.payload['thinkingDecisions']).toEqual([
      { action: 'drop', reason: 'server-executed' },
      { action: 'drop', reason: 'server-executed' },
      { action: 'drop', reason: 'server-executed' },
    ])
    expect(s.net.checkFailures).toEqual([])
  })

  it('drops them before the emptiness check, so a turn of nothing else is omitted (both wires)', () => {
    const never: ContentBlock = {
      type: 'vendor',
      provider: 'anthropic',
      providerModel: 'claude-test-4',
      raw: { type: 'server_tool_use', id: 'srv', name: 'web_search', input: {} },
      replay: 'never',
    }
    const req: ProviderRequest = {
      model: MODEL,
      messages: [
        user({ type: 'text', text: 'a' }),
        assistant(never),
        user({ type: 'text', text: 'b' }),
      ],
    }
    const encoded = encodeAnthropicMessages(req, 'anthropic')
    expect((encoded.body as { messages: unknown[] }).messages).toHaveLength(2)
    expect(encoded.thinkingDecisions).toEqual([{ action: 'drop', reason: 'server-executed' }])
    const zhipuNever: ContentBlock = { ...never, provider: 'zhipu', providerModel: 'glm-test' }
    const openAI = encodeOpenAIChat(
      {
        model: openAIModel(),
        messages: [
          user({ type: 'text', text: 'a' }),
          assistant(zhipuNever),
          user({ type: 'text', text: 'b' }),
        ],
      },
      'zhipu',
    )
    expect((openAI.body as { messages: unknown[] }).messages).toHaveLength(2)
    expect(openAI.thinkingDecisions).toEqual([{ action: 'drop', reason: 'server-executed' }])
  })
})

describe('the attempt says which encoder and which model fields (旧 112, 旧 42)', () => {
  it('records encoder, modelWireHash and responseModelId', async () => {
    const s = await session([fixture.PLAIN_TEXT_FRAMES])
    const attempt = await s.send('hi')
    expect(attempt.payload['encoder']).toEqual({
      wire: 'anthropic-messages',
      version: 3,
      sdk: expect.stringMatching(/^@anthropic-ai\/sdk@\d+\.\d+\.\d+$/),
    })
    // canonicalHash(pick(model, WIRE_MODEL_FIELDS)), computed here from the definition.
    const picked = Object.fromEntries(
      WIRE_MODEL_FIELDS.filter((field) => MODEL[field] !== undefined).map((field) => [
        field,
        MODEL[field],
      ]),
    )
    expect(attempt.payload['modelWireHash']).toBe(sha256Hex(canonicalJson(picked)))
    expect(attempt.payload['responseModelId']).toBe(fixture.RESPONSE_MODEL_ID)
  })

  it('leaves modelWireHash alone when only a field encode() never reads changes', () => {
    const base = anthropicDefinition.builtinModels[1]
    if (base === undefined) throw new Error('no second row')
    expect(modelWireHash({ ...base, pricing: { inputPerMTok: 1, outputPerMTok: 2 } })).toBe(
      modelWireHash(base),
    )
    expect(modelWireHash({ ...base, purposeKey: 'model.purpose.any', contextLimit: 1 })).toBe(
      modelWireHash(base),
    )
    // A field encode() does read is "the model table changed" (旧 42): the hash moves with it.
    expect(modelWireHash({ ...base, maxOutputTokens: base.maxOutputTokens - 1 })).not.toBe(
      modelWireHash(base),
    )
    const { thinkingSpec: _dropped, ...withoutSpec } = base
    expect(modelWireHash(withoutSpec)).not.toBe(modelWireHash(base))
  })

  it('reads no ModelInfo field outside WIRE_MODEL_FIELDS in encode(), on either wire', () => {
    const read = new Set<string>()
    const watched = <T extends object>(model: T): T =>
      new Proxy(model, {
        get(target, key, receiver) {
          if (typeof key === 'string') read.add(key)
          return Reflect.get(target, key, receiver) as unknown
        },
      })
    type Wire = 'anthropic-messages' | 'openai-chat'
    const rows: readonly (readonly [ModelInfo, Wire])[] = [
      ...anthropicDefinition.builtinModels.map((m): readonly [ModelInfo, Wire] => [
        m,
        'anthropic-messages',
      ]),
      ...zhipuDefinition.builtinModels.map((m): readonly [ModelInfo, Wire] => [m, 'openai-chat']),
      [anthropicModel({ canonicalId: 'claude-canonical' }), 'anthropic-messages'],
      [anthropicModel({ thinkingPreservationFormat: 'text-only' }), 'anthropic-messages'],
      [openAIModel(), 'openai-chat'],
      [
        openAIModel({
          thinkingPreservationFormat: 'reasoning-content',
          reasoningEchoField: 'reasoning',
        }),
        'openai-chat',
      ],
      // M6 §对 02 的修补 6: the output limit's key is read, so it is a wire field.
      [openAIModel({ maxTokensField: 'max_completion_tokens' }), 'openai-chat'],
    ]
    for (const [model, wire] of rows) {
      const req: ProviderRequest = {
        ...requestOf(watched(model), { system: 's', tools: [TOOL] }),
        // Every path encode() reads a ModelInfo on (plan 旧 112): the thinking guard and its
        // application, the vendor-block guard, a tool pair and an image, not only the body keys.
        messages: guardedHistory(model, wire),
        dropThinkingBefore: 0,
        ...(model.thinkingSpec?.effortLevels?.[0] === undefined
          ? {}
          : { effort: model.thinkingSpec.effortLevels[0] }),
      }
      if (wire === 'anthropic-messages') encodeAnthropicMessages(req, model.providerId)
      else encodeOpenAIChat(req, model.providerId)
    }
    expect(
      [...read].filter((key) => !(WIRE_MODEL_FIELDS as readonly string[]).includes(key)),
    ).toEqual([])
    // And the watch reached the guard: an encoder that read nothing, or a request that never got
    // past the body keys, would pass the line above.
    expect(
      [
        'thinkingSpec',
        'thinkingPreservationFormat',
        'canonicalId',
        'reasoningEchoField',
        'maxTokensField',
      ].filter((key) => !read.has(key)),
    ).toEqual([])
  })
})

/**
 * A same-model history for `model` that reaches every guard rule a row can reach: a signed and a
 * redacted reasoning block, a vendor block of each replay kind the wire decodes, a tool pair, an
 * image, ending on a user turn. Stamped with the guard's own identity for the row (canonicalId when
 * it has one), so rules 1 and 2 pass and rules 3-7 run.
 */
function guardedHistory(model: ModelInfo, wire: 'anthropic-messages' | 'openai-chat') {
  const provider = model.providerId
  const providerModel = model.canonicalId ?? model.id
  const vendor = (replay: 'same-model' | 'never'): ContentBlock => ({
    type: 'vendor',
    provider,
    providerModel,
    raw: { type: replay === 'never' ? 'server_tool_use' : 'future_block', id: `v-${replay}` },
    replay,
  })
  return [
    user({ type: 'text', text: 'a' }),
    assistant(
      {
        type: 'thinking',
        text: 'weighing',
        signature: 'c2lnbmVk',
        provider,
        providerModel,
      },
      { type: 'redacted-thinking', data: 'cmVkYWN0ZWQ=', provider, providerModel },
      // The OpenAI-compatible wire decodes only calls the vendor ran itself.
      ...(wire === 'anthropic-messages' ? [vendor('same-model')] : []),
      vendor('never'),
      {
        type: 'text',
        text: 'looking',
        // The vendor-fields guard (s6-spec-2): a field set this wire can send back.
        ...(wire === 'anthropic-messages'
          ? { vendorFields: { citations: [] }, vendorSource: { provider, providerModel } }
          : {}),
      },
      { type: 'tool-request', id: 't1', name: TOOL.name, input: { path: 'a' } },
    ),
    user(
      { type: 'tool-response', id: 't1', isError: false, content: [{ type: 'text', text: 'x' }] },
      { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
    ),
    assistant({ type: 'text', text: 'b' }),
    user({ type: 'text', text: 'c' }),
  ]
}
