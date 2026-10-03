/**
 * The generic factory and its rows (M6 §实例描述与通用工厂, §模型行「合成」; plan step 4): what an
 * instance's definition declares and builds, the ModelInfo a row synthesises, the instance id inside
 * a provenance key, two instances of one vendor keeping their thinking apart, and every attempt of an
 * instance re-encoding from its assembly alone.
 */
import { describe, expect, it } from 'vitest'
import {
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_TOOLS_PER_REQUEST,
  ProviderConfigMissingError,
  ProviderInvalidArgumentError,
  checksThinkingPrefix,
  createMemoryTapeStore,
  customModelInfo,
  customVendorDefinition,
  encodeAnthropicMessages,
  encodeOpenAIChat,
  parseProvenanceKey,
  toolTableKey,
} from '../../src/index.js'
import type {
  CustomModelRow,
  CustomVendorDescription,
  HostNetwork,
  InternalMessage,
  ModelInfo,
  ProbeSnapshot,
  Provider,
  TapeEntry,
  TapeStore,
} from '../../src/index.js'
import {
  createCounterIds,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
  recheckAttempt,
} from '../../src/testing/index.js'
import type { FakeNetwork } from '../../src/testing/index.js'
import { LOOK, instantHost, lookSource } from '../loop/support.js'
import * as anthropicFixture from './fixtures/anthropic-sse.js'
import * as openAIFixture from './fixtures/openai-sse.js'

const KEY = 'test-key-not-a-real-credential'
const NOW = Date.parse('2026-10-02T08:00:00.000Z')
const CLOCK = { now: () => NOW, setTimeout: () => () => undefined }

const OPENAI_ID = 'custom-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'
const ANTHROPIC_ID = 'custom-6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b'

function passed(over: Partial<ProbeSnapshot> = {}): ProbeSnapshot {
  return {
    outcome: 'passed',
    reason: null,
    probedAt: NOW,
    reasoningField: null,
    maxTokensField: 'max_tokens',
    usageSeen: true,
    responseModelId: null,
    unknownFields: [],
    ...over,
  }
}

/** A snapshot that saw a thinking field and needed the T10 resend; tests vary its outcome. */
const SEEN_BOTH = passed({
  reasoningField: 'reasoning_content',
  maxTokensField: 'max_completion_tokens',
})

const ROW: CustomModelRow = { id: 'vendor-model', contextLimit: 131_072, maxOutputTokens: 8192 }

function description(
  wire: CustomVendorDescription['wire'],
  over: Partial<CustomVendorDescription> = {},
): CustomVendorDescription {
  return {
    id: wire === 'openai-chat' ? OPENAI_ID : ANTHROPIC_ID,
    wire,
    baseURL:
      wire === 'openai-chat' ? 'https://api.vendor.test/v1' : 'https://api.vendor.test/anthropic',
    keyRequired: true,
    models: [ROW],
    ...over,
  }
}

const ASK: InternalMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] }

describe('instance ids (§实例 id, T1)', () => {
  it('M6 不变量 1: an instance id matches the pattern and keys a tool table as it stands', () => {
    for (const id of [OPENAI_ID, ANTHROPIC_ID, 'custom-00000000-0000-4000-8000-000000000000']) {
      expect(CUSTOM_PROVIDER_ID_PATTERN.test(id)).toBe(true)
      const key = toolTableKey('5b2e8c1d-6b3d-4a71-9f52-0c8de7a11c33', 0, id)
      expect(key).toBe(`view:v1:tool_table:5b2e8c1d-6b3d-4a71-9f52-0c8de7a11c33:0:${id}`)
      expect(parseProvenanceKey(key)?.identity.at(-1)).toBe(id)
    }
    // ADR-003's former `custom:<uuid>` spelling, and an uppercase uuid, are neither.
    for (const id of [OPENAI_ID.replace('custom-', 'custom:'), OPENAI_ID.toUpperCase()]) {
      expect(CUSTOM_PROVIDER_ID_PATTERN.test(id)).toBe(false)
      expect(() => customVendorDefinition(description('openai-chat', { id }))).toThrow(
        ProviderInvalidArgumentError,
      )
    }
  })
})

describe('customVendorDefinition (§实例描述与通用工厂)', () => {
  it('declares the generic name, the two config keys, the rows in order, no finish reasons and 128 tools', () => {
    const second: CustomModelRow = { id: 'second', contextLimit: 8000, maxOutputTokens: 1000 }
    const d = description('anthropic-messages', { models: [ROW, second] })
    const definition = customVendorDefinition(d)
    expect(definition.id).toBe(ANTHROPIC_ID)
    expect(definition.wire).toBe('anthropic-messages')
    expect(definition.nameKey).toBe('provider.custom.name')
    expect(definition.configKeys).toEqual([
      { name: 'apiKey', required: true, secret: true, labelKey: 'provider.custom.config.apiKey' },
      {
        name: 'baseURL',
        required: true,
        secret: false,
        default: d.baseURL,
        labelKey: 'provider.custom.config.baseURL',
      },
    ])
    expect(definition.builtinModels).toEqual([customModelInfo(d, ROW), customModelInfo(d, second)])
    expect(definition.finishReasons).toBeUndefined()
    // T13: the instance cap is data on the definition.
    expect(definition.maxToolsPerRequest).toBe(CUSTOM_TOOLS_PER_REQUEST)
    expect(CUSTOM_TOOLS_PER_REQUEST).toBe(128)
    // A loopback or private instance may go without a key (§key).
    const local = customVendorDefinition({ ...d, keyRequired: false })
    expect(local.configKeys[0]).toMatchObject({ name: 'apiKey', required: false })
  })

  const wires = [
    {
      wire: 'openai-chat',
      frames: openAIFixture.PLAIN_TEXT_FRAMES,
      elsewhere: 'https://elsewhere.test/v1',
      url: 'https://api.vendor.test/v1/chat/completions',
    },
    {
      wire: 'anthropic-messages',
      frames: anthropicFixture.PLAIN_TEXT_FRAMES,
      elsewhere: 'https://elsewhere.test/anthropic',
      url: 'https://api.vendor.test/anthropic/v1/messages',
    },
  ] as const
  for (const { wire, frames, elsewhere, url } of wires) {
    it(`M6 不变量 3 (${wire}): sends to the description’s address whatever config says, and follows no redirect`, async () => {
      const seen: { url: string; redirect: RequestRedirect | undefined }[] = []
      const net = fakeNetwork({ kind: 'sse', frames })
      const network: HostNetwork = {
        fetch: (input, init) => {
          seen.push({ url: String(input), redirect: init?.redirect })
          return net.fetch(input, init)
        },
        fetchUntrusted: net.fetchUntrusted,
      }
      const d = description(wire, { models: [{ ...ROW, probe: passed() }] })
      const provider = customVendorDefinition(d).create({
        network,
        clock: CLOCK,
        config: { baseURL: elsewhere },
        secrets: { apiKey: KEY },
      })
      await drain(provider, provider.encode({ model: customModelInfo(d, ROW), messages: [ASK] }))
      expect(seen).toEqual([{ url, redirect: 'error' }])
    })
  }

  it('sends x-api-key alone on the anthropic wire, never a bearer token', async () => {
    const net = fakeNetwork({ kind: 'sse', frames: anthropicFixture.PLAIN_TEXT_FRAMES })
    const d = description('anthropic-messages')
    const provider = customVendorDefinition(d).create({
      network: net,
      clock: CLOCK,
      config: {},
      secrets: { apiKey: KEY, authToken: 'not-an-instance-credential' },
    })
    await drain(provider, provider.encode({ model: customModelInfo(d, ROW), messages: [ASK] }))
    expect(net.requests[0]?.url).toBe('https://api.vendor.test/anthropic/v1/messages')
    expect(net.requests[0]?.headers['x-api-key']).toBe(KEY)
    expect(net.requests[0]?.headers).not.toHaveProperty('authorization')
  })

  it('gives a keyless local instance the placeholder key and refuses a public one without a key', async () => {
    const net = fakeNetwork({ kind: 'sse', frames: openAIFixture.PLAIN_TEXT_FRAMES })
    const local = description('openai-chat', {
      baseURL: 'http://192.168.1.20:8000/v1',
      keyRequired: false,
    })
    const provider = customVendorDefinition(local).create({
      network: net,
      clock: CLOCK,
      config: {},
      secrets: {},
    })
    await drain(provider, provider.encode({ model: customModelInfo(local, ROW), messages: [ASK] }))
    expect(net.requests[0]?.headers['authorization']).toBe('Bearer tenon-local')
    for (const secrets of [{}, { apiKey: '  ' }]) {
      expect(() =>
        customVendorDefinition(description('openai-chat')).create({
          network: net,
          clock: CLOCK,
          config: {},
          secrets,
        }),
      ).toThrow(ProviderConfigMissingError)
    }
  })
})

describe('customModelInfo (§模型行「合成」; 验收 13)', () => {
  it('synthesises a passed openai-chat row field by field', () => {
    const d = description('openai-chat')
    expect(
      customModelInfo(d, {
        ...ROW,
        probe: passed({
          reasoningField: 'reasoning_content',
          maxTokensField: 'max_completion_tokens',
        }),
      }),
    ).toEqual({
      id: 'vendor-model',
      providerId: OPENAI_ID,
      contextLimit: 131_072,
      maxOutputTokens: 8192,
      reasoning: false,
      supportsToolCalling: true,
      supportsStreamingToolCalls: true,
      supportsVision: false,
      supportsCacheControl: false,
      thinkingPreservationFormat: 'reasoning-content',
      reasoningEchoField: 'reasoning_content',
      usageNeedsOptIn: true,
      maxTokensField: 'max_completion_tokens',
      checksThinkingPrefix: false,
    })
    // No thinking field seen in ①: it still echoes, under `reasoning_content` (§合成; 推出的读法 16),
    // and max_tokens is the default key, so not written.
    expect(customModelInfo(d, { ...ROW, probe: passed() })).toEqual({
      id: 'vendor-model',
      providerId: OPENAI_ID,
      contextLimit: 131_072,
      maxOutputTokens: 8192,
      reasoning: false,
      supportsToolCalling: true,
      supportsStreamingToolCalls: true,
      supportsVision: false,
      supportsCacheControl: false,
      thinkingPreservationFormat: 'reasoning-content',
      reasoningEchoField: 'reasoning_content',
      usageNeedsOptIn: true,
      checksThinkingPrefix: false,
    })
    // The `reasoning` spelling the probe saw is the one echoed.
    expect(
      customModelInfo(d, { ...ROW, probe: passed({ reasoningField: 'reasoning' }) }),
    ).toMatchObject({
      thinkingPreservationFormat: 'reasoning-content',
      reasoningEchoField: 'reasoning',
    })
  })

  it('推出的读法 16: a passed row that saw no thinking field in ① echoes later thinking as reasoning_content', () => {
    // deepseek-flash (2026-10-03): empty `reasoning_content` in ①, thinking from ② on.
    const model = customModelInfo(description('openai-chat'), { ...ROW, probe: passed() })
    const encoded = encodeOpenAIChat(
      { model, messages: thinkingFrom(OPENAI_ID), tools: [READ_TOOL] },
      OPENAI_ID,
    )
    expect(encoded.thinkingDecisions).toEqual([{ action: 'echo', reason: 'same-model' }])
    const [, assistant] = (encoded.body as { messages: Record<string, unknown>[] }).messages
    expect(assistant).toEqual({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'thinking on an instance',
    })
    // Without tools rule 4 sends nothing back, as on any reasoning-content row.
    const bare = encodeOpenAIChat({ model, messages: thinkingFrom(OPENAI_ID) }, OPENAI_ID)
    expect(bare.thinkingDecisions).toEqual([{ action: 'drop', reason: 'no-tools' }])
    expect(JSON.stringify(bare.body)).not.toContain('reasoning_content')
  })

  it('推出的读法 16: a history with no thinking blocks encodes identically under the old and the revised rule', () => {
    const revised = customModelInfo(description('openai-chat'), { ...ROW, probe: passed() })
    // The rule before 2026-10-03: no thinking field in the snapshot meant `drop` and no echo field.
    const { reasoningEchoField: _field, ...rest } = revised
    const old: ModelInfo = { ...rest, thinkingPreservationFormat: 'drop' }
    const messages: InternalMessage[] = [
      ASK,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool-request', id: 'call_1', name: 'Read', input: { file_path: '/a.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-response',
            id: 'call_1',
            content: [{ type: 'text', text: 'ALPHA' }],
            isError: false,
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ALPHA' }] },
      ASK,
    ]
    for (const tools of [[READ_TOOL], undefined]) {
      const before = encodeOpenAIChat(
        { model: old, messages, ...(tools ? { tools } : {}) },
        OPENAI_ID,
      )
      const after = encodeOpenAIChat(
        { model: revised, messages, ...(tools ? { tools } : {}) },
        OPENAI_ID,
      )
      expect(after.body).toEqual(before.body)
      expect(after.promptHash).toBe(before.promptHash)
      expect(after.thinkingDecisions).toEqual([])
      expect(before.thinkingDecisions).toEqual([])
    }
  })

  it('synthesises a passed anthropic-messages row, which never writes the openai-chat fields', () => {
    const d = description('anthropic-messages')
    // Even a hand-edited snapshot naming them.
    const snapshot = passed({
      reasoningField: 'reasoning',
      maxTokensField: 'max_completion_tokens',
    })
    expect(customModelInfo(d, { ...ROW, probe: snapshot })).toEqual({
      id: 'vendor-model',
      providerId: ANTHROPIC_ID,
      contextLimit: 131_072,
      maxOutputTokens: 8192,
      reasoning: false,
      supportsToolCalling: true,
      supportsStreamingToolCalls: true,
      supportsVision: false,
      supportsCacheControl: false,
      thinkingPreservationFormat: 'signed-blocks',
      usageNeedsOptIn: false,
      checksThinkingPrefix: false,
    })
  })

  it('M6 不变量 6: a row carries tools if and only if its snapshot passed', () => {
    const snapshots: readonly (ProbeSnapshot | undefined)[] = [
      undefined,
      passed(),
      {
        ...passed({ reasoningField: 'reasoning_content' }),
        outcome: 'not-detected',
        reason: 'no-tool-call',
      },
      {
        ...passed({ reasoningField: 'reasoning_content', maxTokensField: 'max_completion_tokens' }),
        outcome: 'failed',
        reason: 'echo-rejected',
      },
    ]
    const rows = (['openai-chat', 'anthropic-messages'] as const).flatMap((wire) =>
      snapshots.map((probe) => ({
        wire,
        pass: probe?.outcome === 'passed',
        row: customModelInfo(description(wire), {
          ...ROW,
          ...(probe === undefined ? {} : { probe }),
        }),
      })),
    )
    expect(
      rows.map(({ row }) => [row.supportsToolCalling, row.supportsStreamingToolCalls]),
    ).toEqual(rows.map(({ pass }) => [pass, pass]))
    // The conservative row: no echo field (验收 13). The output field is not a capability and does
    // not follow the outcome: only the failed openai-chat snapshot recorded `max_completion_tokens`,
    // and only that row writes it (§合成; 验收 16).
    const conservative = rows.filter(({ pass }) => !pass)
    expect(conservative).toHaveLength(6)
    expect(
      conservative.map(({ row }) => [
        row.thinkingPreservationFormat,
        'reasoningEchoField' in row,
        row.maxTokensField ?? null,
      ]),
    ).toEqual([
      // openai-chat: never probed, not detected, failed after the T10 resend.
      ['drop', false, null],
      ['drop', false, null],
      ['drop', false, 'max_completion_tokens'],
      // anthropic-messages: the same three snapshots; the wire has no output-field switch.
      ['signed-blocks', false, null],
      ['signed-blocks', false, null],
      ['signed-blocks', false, null],
    ])
  })

  it('synthesises an openai-chat row that did not pass field by field: tools off, no echo, its output field kept (验收 13, 16)', () => {
    const d = description('openai-chat')
    for (const outcome of [
      { outcome: 'not-detected', reason: 'no-tool-call' },
      { outcome: 'failed', reason: 'echo-rejected' },
    ] as const) {
      expect(customModelInfo(d, { ...ROW, probe: { ...SEEN_BOTH, ...outcome } })).toEqual({
        id: 'vendor-model',
        providerId: OPENAI_ID,
        contextLimit: 131_072,
        maxOutputTokens: 8192,
        reasoning: false,
        supportsToolCalling: false,
        supportsStreamingToolCalls: false,
        supportsVision: false,
        supportsCacheControl: false,
        thinkingPreservationFormat: 'drop',
        usageNeedsOptIn: true,
        maxTokensField: 'max_completion_tokens',
        checksThinkingPrefix: false,
      })
    }
  })

  it('验收 16: a text-only openai-chat row whose snapshot recorded max_completion_tokens sends only that', () => {
    const model = customModelInfo(description('openai-chat'), {
      ...ROW,
      probe: { ...SEEN_BOTH, outcome: 'not-detected', reason: 'no-tool-call' },
    })
    const body = encodeOpenAIChat({ model, messages: [ASK] }, OPENAI_ID).body as Record<
      string,
      unknown
    >
    expect(body['max_completion_tokens']).toBe(ROW.maxOutputTokens)
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('tools')
    // The anthropic wire has no such field, whatever a hand-edited snapshot that did not pass says.
    const anthropic = customModelInfo(description('anthropic-messages'), {
      ...ROW,
      probe: { ...SEEN_BOTH, outcome: 'failed', reason: 'request-rejected' },
    })
    expect(anthropic).not.toHaveProperty('maxTokensField')
  })

  it('M6 不变量 17 (custom rows): checksThinkingPrefix is false whatever the id', () => {
    for (const wire of ['openai-chat', 'anthropic-messages'] as const) {
      for (const id of ['claude-opus-5-5', 'claude-fable-5-1', 'vendor-model']) {
        const row = customModelInfo(description(wire), { ...ROW, id, probe: passed() })
        expect(row.checksThinkingPrefix).toBe(false)
        expect(checksThinkingPrefix(row)).toBe(false)
      }
    }
  })

  it('asks for usage on every openai-chat request, passed or not (验收 13)', () => {
    const d = description('openai-chat')
    for (const probe of [undefined, passed()]) {
      const model = customModelInfo(d, { ...ROW, ...(probe === undefined ? {} : { probe }) })
      const body = encodeOpenAIChat({ model, messages: [ASK] }, OPENAI_ID).body as Record<
        string,
        unknown
      >
      expect(body['stream_options']).toEqual({ include_usage: true })
    }
  })
})

describe('two instances of one vendor (验收 22, the guard)', () => {
  // Same vendor, same address, two ids: rule 1 keeps each instance's thinking to itself.
  const twin = (id: string, wire: CustomVendorDescription['wire']): CustomVendorDescription =>
    description(wire, {
      id,
      models: [
        {
          ...ROW,
          probe: passed({ reasoningField: wire === 'openai-chat' ? 'reasoning_content' : null }),
        },
      ],
    })
  const A = 'custom-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
  const B = 'custom-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

  for (const wire of ['anthropic-messages', 'openai-chat'] as const) {
    it(`drops the other instance's thinking as foreign-provider, both ways, on ${wire}`, () => {
      const encode = wire === 'anthropic-messages' ? encodeAnthropicMessages : encodeOpenAIChat
      for (const [from, to] of [
        [A, B],
        [B, A],
      ] as const) {
        const target = customModelInfo(twin(to, wire), {
          ...ROW,
          probe: passed({ reasoningField: wire === 'openai-chat' ? 'reasoning_content' : null }),
        })
        const encoded = encode(
          { model: target, messages: thinkingFrom(from), tools: [READ_TOOL] },
          to,
        )
        expect(encoded.thinkingDecisions).toMatchObject([
          { action: 'drop', reason: 'foreign-provider' },
        ])
        // On its own instance the same block goes back (rule 7 on anthropic, rule 4 on openai-chat).
        const replayed = encode(
          { model: target, messages: thinkingFrom(to), tools: [READ_TOOL] },
          to,
        )
        expect(replayed.thinkingDecisions[0]?.action).not.toBe('drop')
      }
    })
  }
})

describe('M6 不变量 4: an instance attempt re-encodes from its assembly alone', () => {
  it('recomputes every attempt’s promptHash on both wires with the model table cleared', async () => {
    const openAI = description('openai-chat', {
      models: [
        {
          ...ROW,
          probe: passed({
            reasoningField: 'reasoning_content',
            maxTokensField: 'max_completion_tokens',
          }),
        },
        { ...ROW, id: 'text-only' },
      ],
    })
    const anthropic = description('anthropic-messages', { models: [{ ...ROW, probe: passed() }] })
    const [toolRow, textRow] = customVendorDefinition(openAI).builtinModels
    const [anthropicRow] = customVendorDefinition(anthropic).builtinModels
    if (toolRow === undefined || textRow === undefined || anthropicRow === undefined) {
      throw new Error('missing rows')
    }
    const { provider: openAIProvider, net: openAINet } = instance(openAI, [
      openAIFixture.turnFrames(
        ['Looking.'],
        [{ id: 'call_o', name: LOOK, args: '{}' }],
        'tool_calls',
      ),
      openAIFixture.turnFrames(['Done.'], [], 'stop'),
      openAIFixture.turnFrames(['Plain.'], [], 'stop'),
    ])
    const { provider: anthropicProvider } = instance(anthropic, [
      anthropicFixture.turnFrames(
        ['Looking.'],
        [{ id: 'toolu_a', name: LOOK, args: '{}' }],
        'tool_use',
      ),
      anthropicFixture.turnFrames(['Done.'], [], 'end_turn'),
    ])
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const sources = [lookSource([])]
    const loop = createTestLoopPorts({
      connector: { provider: openAIProvider, model: toolRow, mcpSources: sources },
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
    const send = async (text: string): Promise<void> => {
      const sent = await service.send({ sessionId: SESSION, origin: null, text })
      if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
      expect((await loop.runEnded({ runId: sent.runId })).reason.code).toBe('completed')
    }
    await send('look on the openai-chat instance')
    loop.connector.use({ provider: anthropicProvider, model: anthropicRow, mcpSources: sources })
    await send('look on the anthropic-messages instance')
    loop.connector.use({
      provider: openAIProvider,
      model: textRow,
      capabilitySource: 'user',
      mcpSources: sources,
    })
    await send('text only now')
    const attempts = await attemptsOf(store)
    expect(attempts.map((attempt) => attempt.payload['providerId'])).toEqual([
      OPENAI_ID,
      OPENAI_ID,
      ANTHROPIC_ID,
      ANTHROPIC_ID,
      OPENAI_ID,
    ])
    for (const attempt of attempts) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time keeps a failure readable
      const blind = await recheckAttempt(store, {
        sessionId: SESSION,
        attempt,
        currentModel: () => null,
      })
      if (blind.verdict !== 'model-table-changed') throw new Error(JSON.stringify(blind))
      const providerId = String(attempt.payload['providerId'])
      const encode = providerId === ANTHROPIC_ID ? encodeAnthropicMessages : encodeOpenAIChat
      expect(encode(blind.request, providerId).promptHash).toBe(attempt.payload['promptHash'])
    }
    // The instance's own data reached the wire: the output field the probe found, and the echo.
    const sent = openAINet.requests.map((request) => request.body as Record<string, unknown>)
    expect(sent[0]).toHaveProperty('max_completion_tokens')
    expect(sent[0]).not.toHaveProperty('max_tokens')
    expect(sent[2]).toHaveProperty('max_tokens')
    expect(sent[2]).not.toHaveProperty('tools')
  })
})

const IDENTITY = { userId: 'custom-user', tenantId: 'custom-tenant', profileDir: '/tenon/custom' }
const SESSION = '3a7c1e2d-5b4f-4c6a-8d9e-0f1a2b3c4d5e'

const READ_TOOL = {
  name: 'Read',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } },
}

/** A turn whose thinking block was produced on `provider`, then the next question. */
function thinkingFrom(provider: string): InternalMessage[] {
  return [
    ASK,
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          text: 'thinking on an instance',
          signature: 'c2lnbmF0dXJl',
          provider,
          providerModel: ROW.id,
        },
        { type: 'text', text: 'answer' },
      ],
    },
    ASK,
  ]
}

/** The instance's Provider over a network replaying `turns`, and that network. */
function instance(
  d: CustomVendorDescription,
  turns: readonly (readonly string[])[],
): { provider: Provider; net: FakeNetwork } {
  const net = fakeNetwork(turns.map((frames) => ({ kind: 'sse' as const, frames })))
  const provider = customVendorDefinition(d).create({
    network: net,
    clock: CLOCK,
    config: {},
    secrets: { apiKey: KEY },
  })
  return { provider, net }
}

async function attemptsOf(store: TapeStore): Promise<TapeEntry[]> {
  const entries = (await store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  return entries.filter((entry) => entry.name === 'provider/attempt_completed')
}

async function drain(provider: Provider, encoded: ReturnType<Provider['encode']>): Promise<void> {
  for await (const event of provider.stream(encoded, {
    identity: { runId: '00000000-0000-4000-8000-000000000009', requestSeq: 1, physicalAttempt: 1 },
  })) {
    if (event.type === 'error') throw new Error(event.detail)
  }
}
