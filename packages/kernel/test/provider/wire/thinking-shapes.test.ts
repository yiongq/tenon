/**
 * Spec 02, acceptance 6 and invariants 1 and 2: the thinking shapes both encoders write from a row's
 * `ThinkingSpec` (01 修补 2 and 3), the local refusals — each before a byte leaves — the snapshot
 * keys that record what was written, and the trailing-user rule. Plan step 6, test points 旧 98,
 * 旧 45 / 99, 旧 100 and the encode half of 旧 46.
 *
 * Rows are the builtin tables' own, looked up by id, wherever the point is about a row; the wire
 * fixtures' synthetic models where the point is about the encoder alone.
 */
import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_BASE_URL,
  ProviderInvalidArgumentError,
  ZHIPU_DEFAULT_BASE_URL,
  anthropicDefinition,
  encodeAnthropicMessages,
  encodeOpenAIChat,
  ollamaDefinition,
  requestSnapshot,
  zhipuDefinition,
} from '../../../src/index.js'
import type {
  EncodedRequest,
  HostClock,
  InternalMessage,
  ModelInfo,
  Provider,
  ProviderDefinition,
  ProviderRequest,
} from '../../../src/index.js'
import { fakeNetwork } from '../../../src/testing/index.js'
import type { FakeNetwork } from '../../../src/testing/index.js'
import {
  TOOL,
  anthropicModel,
  assistant,
  openAIModel,
  requestOf,
  thinkingBlock,
  user,
} from './fixtures.js'

function row(definition: ProviderDefinition, id: string): ModelInfo {
  const found = definition.builtinModels.find((model) => model.id === id)
  if (found === undefined) throw new Error(`no builtin row ${id}`)
  return found
}

const OPUS_5_5 = row(anthropicDefinition, 'claude-opus-5-5')
const OPUS_5 = row(anthropicDefinition, 'claude-opus-5')
const SONNET_5 = row(anthropicDefinition, 'claude-sonnet-5')
const HAIKU_4_5 = row(anthropicDefinition, 'claude-haiku-4-5-20251001')
const FLASH = row(zhipuDefinition, 'glm-5.3-flash')
const GLM_4_6 = row(zhipuDefinition, 'glm-4.6')
const QWEN = row(ollamaDefinition, 'qwen3:8b')

/** Configured so the adapter constructs; nothing may ever be sent, so it is no credential. */
const KEY = 'test-key-not-a-real-credential'

/**
 * A real provider from the definition, over a fake network and a clock that counts: the only
 * objects that could reach the network or a timer. Invariant 1 wants both untouched by encode().
 */
function instance(definition: ProviderDefinition): {
  provider: Provider
  net: FakeNetwork
  clockCalls: () => number
} {
  const net = fakeNetwork([])
  let calls = 0
  const clock: Pick<HostClock, 'now' | 'setTimeout'> = {
    now: () => {
      calls += 1
      return 0
    },
    setTimeout: () => {
      calls += 1
      return () => undefined
    },
  }
  const baseURL =
    definition === anthropicDefinition
      ? ANTHROPIC_DEFAULT_BASE_URL
      : definition === zhipuDefinition
        ? ZHIPU_DEFAULT_BASE_URL
        : OLLAMA_DEFAULT_BASE_URL
  const provider = definition.create({
    network: net,
    clock,
    config: { baseURL },
    secrets: { apiKey: KEY },
  })
  return { provider, net, clockCalls: () => calls }
}

function bodyOf(encoded: EncodedRequest): Record<string, unknown> {
  return encoded.body as Record<string, unknown>
}

const IDENTITY = {
  runId: '00000000-0000-4000-8000-0000000000a6',
  requestSeq: 1,
  physicalAttempt: 1,
}

/**
 * Refused locally, before a byte leaves: encode() throws the named error, and complete() — which
 * encodes and then streams — rejects with it having made no request at all.
 */
async function expectRefusedLocally(
  definition: ProviderDefinition,
  req: ProviderRequest,
): Promise<void> {
  const { provider, net } = instance(definition)
  expect(() => provider.encode(req)).toThrow(ProviderInvalidArgumentError)
  await expect(provider.complete(req, { identity: IDENTITY })).rejects.toThrow(
    ProviderInvalidArgumentError,
  )
  expect(net.callCount).toBe(0)
}

/** apps/desktop/src/main/provider.ts `selectModel()`'s synthesis (01:706), with its numbers. */
function synthesizedRow(providerId: string, id: string): ModelInfo {
  return {
    id,
    providerId,
    contextLimit: 128_000,
    maxOutputTokens: 4096,
    reasoning: false,
    supportsToolCalling: false,
    supportsStreamingToolCalls: false,
    supportsVision: false,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'drop',
    usageNeedsOptIn: false,
  }
}

describe('rows with no thinkingSpec encode exactly as 01 did (旧 98)', () => {
  // The builders below are the ones the golden values were computed with: the pre-02 encoder at
  // 753101e (01 plus plan steps 2-4), on 2026-09-26, and the same script against this change gave
  // identical bytes. A row that declares no thinking shape — the dev-time synthesis, glm-4.6,
  // qwen3:8b — must keep hashing to them.
  const SIGNATURE_01 = 'EqoBCkgIARABGAIiQL2+/wK3Zg=='
  const PNG_01 = 'iVBORw0KGgoAAAANSUhEUg=='
  const TOOL_01 = {
    name: 'read_file',
    description: 'Reads a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  }
  function historyEndingInUser(provider: string, providerModel: string): InternalMessage[] {
    return [
      user(
        { type: 'text', text: 'read /tmp/a' },
        { type: 'image', mediaType: 'image/png', data: PNG_01 },
      ),
      assistant(
        { type: 'thinking', text: 'look first', signature: SIGNATURE_01, provider, providerModel },
        { type: 'text', text: 'reading' },
        { type: 'tool-request', id: 'call_1', name: 'read_file', input: { path: '/tmp/a' } },
      ),
      user({
        type: 'tool-response',
        id: 'call_1',
        content: [{ type: 'text', text: 'export {}' }],
        isError: false,
      }),
      assistant({ type: 'text', text: 'an empty module' }),
      user({ type: 'text', text: 'and the other one?' }),
    ]
  }

  const NO_TOOLS = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
  const OPENAI_TOOLS = '1ccc884ac9a04c167b09cc6fd0be36ff042f11143e1dc6478511b23dc2bc1e8a'
  const cases: readonly {
    readonly name: string
    readonly encode: () => EncodedRequest
    readonly model: ModelInfo
    readonly promptHash: string
    readonly toolDefinitionsHash: string
    readonly decision: { action: string; reason: string }
  }[] = [
    {
      name: 'anthropic, synthesised row, every optional key set',
      model: synthesizedRow('anthropic', 'glm-4.7-flash'),
      encode: () =>
        encodeAnthropicMessages(
          {
            model: synthesizedRow('anthropic', 'glm-4.7-flash'),
            system: 'You are terse.',
            tools: [TOOL_01],
            temperature: 0.3,
            maxTokens: 2048,
            thinking: { enabled: true, budgetTokens: 1024 },
            messages: historyEndingInUser('anthropic', 'glm-4.7-flash'),
          },
          'anthropic',
        ),
      promptHash: '88cae400befbe52d95f1a366db8e83d1a43e535d27ce960d636dd20b17f1df9f',
      toolDefinitionsHash: '46d4fa090c4f679659b54fb34db37ee1ba469d126d0080c419ebd39202b086c1',
      decision: { action: 'drop', reason: 'target-drops' },
    },
    {
      name: 'anthropic, synthesised row, thinking off',
      model: synthesizedRow('anthropic', 'glm-4.7-flash'),
      encode: () =>
        encodeAnthropicMessages(
          {
            model: synthesizedRow('anthropic', 'glm-4.7-flash'),
            thinking: { enabled: false },
            messages: historyEndingInUser('anthropic', 'glm-4.7-flash'),
          },
          'anthropic',
        ),
      promptHash: 'ddc5c35488e353c3b9aeb317ea2751c7a54418f229927cacac8614468cbc8092',
      toolDefinitionsHash: NO_TOOLS,
      decision: { action: 'drop', reason: 'target-drops' },
    },
    {
      name: 'zhipu glm-4.6 with tools',
      model: GLM_4_6,
      encode: () =>
        encodeOpenAIChat(
          {
            model: GLM_4_6,
            system: 'You are terse.',
            tools: [TOOL_01],
            temperature: 0.3,
            thinking: { enabled: true },
            messages: historyEndingInUser('zhipu', 'glm-4.6'),
          },
          'zhipu',
        ),
      promptHash: '75ea1a59b3b0d8865dd5f84f2d0171670befd6b9e9d07a76cadf096140c7d564',
      toolDefinitionsHash: OPENAI_TOOLS,
      decision: { action: 'echo', reason: 'same-model' },
    },
    {
      name: 'zhipu glm-4.6 without tools',
      model: GLM_4_6,
      encode: () =>
        encodeOpenAIChat(
          { model: GLM_4_6, messages: historyEndingInUser('zhipu', 'glm-4.6') },
          'zhipu',
        ),
      promptHash: '91978ad1efc37e9ba5016f3be398412ead0487222f35bbc7af43f19d1248d09a',
      toolDefinitionsHash: NO_TOOLS,
      decision: { action: 'drop', reason: 'no-tools' },
    },
    {
      name: 'ollama qwen3:8b with tools',
      model: QWEN,
      encode: () =>
        encodeOpenAIChat(
          { model: QWEN, tools: [TOOL_01], messages: historyEndingInUser('ollama', 'qwen3:8b') },
          'ollama',
        ),
      promptHash: '051479760ea0f5075b1015b176aee5ce68c7dba56a641722bbb63dc7267b8ddf',
      toolDefinitionsHash: OPENAI_TOOLS,
      decision: { action: 'echo', reason: 'same-model' },
    },
    {
      name: 'zhipu, synthesised row',
      model: synthesizedRow('zhipu', 'glm-4.5-air'),
      encode: () =>
        encodeOpenAIChat(
          {
            model: synthesizedRow('zhipu', 'glm-4.5-air'),
            maxTokens: 1000,
            messages: historyEndingInUser('zhipu', 'glm-4.5-air'),
          },
          'zhipu',
        ),
      promptHash: '0834365f10db01c0499297b36276d2b9b63e15e6b9e39ed55252cbcb9919a596',
      toolDefinitionsHash: NO_TOOLS,
      decision: { action: 'drop', reason: 'target-drops' },
    },
  ]

  it.each(cases)('$name', ({ model, encode, promptHash, toolDefinitionsHash, decision }) => {
    // The premise: no thinking shape, and no cache control for step 7's top-level key to add.
    expect(model.thinkingSpec).toBeUndefined()
    expect(model.supportsCacheControl).toBe(false)
    const encoded = encode()
    expect(encoded.promptHash).toBe(promptHash)
    expect(encoded.toolDefinitionsHash).toBe(toolDefinitionsHash)
    expect(encoded.thinkingDecisions).toEqual([decision])
  })
})

const ask = (model: ModelInfo, over: Partial<ProviderRequest> = {}): ProviderRequest =>
  requestOf(model, over)

describe('the Anthropic wire’s four thinking branches (01 修补 3; 旧 45, 旧 99)', () => {
  // oxlint-disable-next-line vitest/expect-expect -- the assertions are in expectRefusedLocally
  it('refuses on Opus 5.5, locally and with no request: thinking off, an undeclared effort, a non-default sampling value, a budget', async () => {
    const refused: readonly ProviderRequest[] = [
      ask(OPUS_5_5, { thinking: { enabled: false } }),
      ask(OPUS_5_5, { effort: 'minimal' }),
      ask(OPUS_5_5, { temperature: 0.5 }),
      ask(OPUS_5_5, { thinking: { enabled: true, budgetTokens: 2048 } }),
      ask({ ...OPUS_5_5, requestParams: { top_p: 0.9 } }),
      ask({ ...OPUS_5_5, requestParams: { top_k: 40 } }),
    ]
    for (const req of refused) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time, each on a fresh network
      await expectRefusedLocally(anthropicDefinition, req)
    }
  })

  it('writes the shapes Opus 5.5 does take', () => {
    // Default: nothing at all — the model thinks by default at its own default level.
    const plain = bodyOf(encodeAnthropicMessages(ask(OPUS_5_5), 'anthropic'))
    expect(Object.hasOwn(plain, 'thinking')).toBe(false)
    expect(Object.hasOwn(plain, 'output_config')).toBe(false)
    // A display needs an object to sit in: the equivalent adaptive one.
    expect(
      bodyOf(encodeAnthropicMessages(ask(OPUS_5_5, { display: 'summarized' }), 'anthropic'))
        .thinking,
    ).toEqual({ type: 'adaptive', display: 'summarized' })
    // Turned on: adaptive; an effort goes into output_config, never into the thinking object.
    const on = bodyOf(
      encodeAnthropicMessages(
        ask(OPUS_5_5, { thinking: { enabled: true }, effort: 'max' }),
        'anthropic',
      ),
    )
    expect(on.thinking).toEqual({ type: 'adaptive' })
    expect(on.output_config).toEqual({ effort: 'max' })
    // The defaults are accepted: temperature 1.0 and top_p at or above 0.99.
    expect(() =>
      encodeAnthropicMessages(
        ask({ ...OPUS_5_5, requestParams: { top_p: 0.99 } }, { temperature: 1 }),
        'anthropic',
      ),
    ).not.toThrow()
  })

  it('turns Opus 5 off only at an effort no higher than its disableMaxEffort', async () => {
    // No effort: the row's default (`high`) is the ceiling itself, so `disabled` is written.
    expect(
      bodyOf(encodeAnthropicMessages(ask(OPUS_5, { thinking: { enabled: false } }), 'anthropic'))
        .thinking,
    ).toEqual({ type: 'disabled' })
    expect(
      bodyOf(
        encodeAnthropicMessages(
          ask(OPUS_5, { thinking: { enabled: false }, effort: 'low' }),
          'anthropic',
        ),
      ).thinking,
    ).toEqual({ type: 'disabled' })
    for (const effort of ['xhigh', 'max']) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time
      await expectRefusedLocally(
        anthropicDefinition,
        ask(OPUS_5, { thinking: { enabled: false }, effort }),
      )
    }
  })

  it('turns Sonnet 5 off with disabled, and Haiku 4.5 on only with a budget', async () => {
    expect(
      bodyOf(encodeAnthropicMessages(ask(SONNET_5, { thinking: { enabled: false } }), 'anthropic'))
        .thinking,
    ).toEqual({ type: 'disabled' })
    expect(
      bodyOf(
        encodeAnthropicMessages(
          ask(HAIKU_4_5, { thinking: { enabled: true, budgetTokens: 2048 } }),
          'anthropic',
        ),
      ).thinking,
    ).toEqual({ type: 'enabled', budget_tokens: 2048 })
    // The budget form still needs its budget, and effort is no parameter this row declares.
    await expectRefusedLocally(anthropicDefinition, ask(HAIKU_4_5, { thinking: { enabled: true } }))
    await expectRefusedLocally(anthropicDefinition, ask(HAIKU_4_5, { effort: 'high' }))
  })

  it('writes display only while thinking is on, and records it only then (A11)', async () => {
    // Off: `display` with `disabled` is a 400, so neither the body nor the snapshot has it.
    const off = ask(SONNET_5, { thinking: { enabled: false }, display: 'summarized' })
    expect(bodyOf(encodeAnthropicMessages(off, 'anthropic')).thinking).toEqual({ type: 'disabled' })
    expect(Object.hasOwn(requestSnapshot(off), 'display')).toBe(false)
    // Haiku 4.5 is off by default, so a display alone writes nothing…
    const haikuDefault = ask(HAIKU_4_5, { display: 'summarized' })
    expect(
      Object.hasOwn(bodyOf(encodeAnthropicMessages(haikuDefault, 'anthropic')), 'thinking'),
    ).toBe(false)
    expect(Object.hasOwn(requestSnapshot(haikuDefault), 'display')).toBe(false)
    // …and it travels with the budget form once thinking is on.
    const haikuOn = ask(HAIKU_4_5, {
      thinking: { enabled: true, budgetTokens: 2048 },
      display: 'summarized',
    })
    expect(bodyOf(encodeAnthropicMessages(haikuOn, 'anthropic')).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
      display: 'summarized',
    })
    expect(requestSnapshot(haikuOn).display).toBe('summarized')
    // A row that declares no display refuses one, whether or not it has a thinking shape.
    await expectRefusedLocally(
      anthropicDefinition,
      ask(anthropicModel(), { display: 'summarized' }),
    )
  })

  it('refuses a thinking mode the wire does not take, as the table error it is', () => {
    const effortOnly = anthropicModel({
      thinkingSpec: { mode: 'effort-only', defaultOn: true, effortLevels: ['low'] },
    })
    expect(() => encodeAnthropicMessages(ask(effortOnly), 'anthropic')).toThrow(
      ProviderInvalidArgumentError,
    )
  })
})

describe('the OpenAI-compatible wire’s effort-only rule (01 修补 3; 旧 100, 旧 46)', () => {
  it('writes the effort as reasoning_effort, and nothing when there is none', () => {
    const withEffort = requestOf(FLASH, { effort: 'low' })
    const body = bodyOf(encodeOpenAIChat(withEffort, 'zhipu'))
    expect(body.reasoning_effort).toBe('low')
    expect(requestSnapshot(withEffort).effort).toBe('low')
    const without = bodyOf(encodeOpenAIChat(requestOf(FLASH), 'zhipu'))
    expect(Object.hasOwn(without, 'reasoning_effort')).toBe(false)
    // `{ enabled: true }` writes no key of its own; the row's `thinking` passthrough is unchanged.
    expect(
      bodyOf(encodeOpenAIChat(requestOf(FLASH, { thinking: { enabled: true } }), 'zhipu')),
    ).toEqual(without)
  })

  // oxlint-disable-next-line vitest/expect-expect -- the assertions are in expectRefusedLocally
  it('refuses locally: thinking off, a budget, a display, an undeclared level', async () => {
    const refused: readonly ProviderRequest[] = [
      requestOf(FLASH, { thinking: { enabled: false } }),
      requestOf(FLASH, { thinking: { enabled: true, budgetTokens: 1024 } }),
      requestOf(FLASH, { display: 'summarized' }),
      // Not a level the GLM-5.3 family lists: thinking cannot be turned off there.
      requestOf(FLASH, { effort: 'none' }),
      // Not one either (02 declares low / high / max only; whether the vendor 400s is optional).
      requestOf(FLASH, { effort: 'medium' }),
      // A row with no thinking shape declares no level at all.
      requestOf(GLM_4_6, { effort: 'high' }),
    ]
    for (const req of refused) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time, each on a fresh network
      await expectRefusedLocally(zhipuDefinition, req)
    }
  })

  it('reserves the keys the encoders now write (01 修补 3)', () => {
    expect(() =>
      encodeOpenAIChat(
        requestOf({ ...FLASH, requestParams: { reasoning_effort: 'max' } }),
        'zhipu',
      ),
    ).toThrow(ProviderInvalidArgumentError)
    for (const key of ['output_config', 'cache_control']) {
      expect(() =>
        encodeAnthropicMessages(
          requestOf(anthropicModel({ requestParams: { [key]: { type: 'ephemeral' } } })),
          'anthropic',
        ),
      ).toThrow(ProviderInvalidArgumentError)
    }
  })

  it('refuses a thinking mode the wire does not take, as the table error it is', () => {
    const adaptive = openAIModel({ thinkingSpec: { mode: 'adaptive', defaultOn: true } })
    expect(() => encodeOpenAIChat(requestOf(adaptive), 'zhipu')).toThrow(
      ProviderInvalidArgumentError,
    )
  })
})

describe('thinkingEffortSupport() answers from the row (01 修补 3)', () => {
  it('reads budget, effort or none off the thinking shape, and 01’s answer without one', () => {
    const anthropic = instance(anthropicDefinition).provider
    const zhipu = instance(zhipuDefinition).provider
    expect(anthropic.thinkingEffortSupport(OPUS_5_5)).toBe('effort')
    expect(anthropic.thinkingEffortSupport(HAIKU_4_5)).toBe('budget')
    expect(anthropic.thinkingEffortSupport(anthropicModel())).toBe('budget')
    expect(anthropic.thinkingEffortSupport(anthropicModel({ reasoning: false }))).toBe('none')
    expect(zhipu.thinkingEffortSupport(FLASH)).toBe('effort')
    expect(zhipu.thinkingEffortSupport(GLM_4_6)).toBe('none')
  })
})

describe('dropThinkingBefore (01 修补 2 and 3; H10)', () => {
  const messages: InternalMessage[] = [
    user({ type: 'text', text: 'one' }),
    assistant(thinkingBlock(), { type: 'text', text: 'a' }),
    user({ type: 'text', text: 'two' }),
    assistant(thinkingBlock(), { type: 'text', text: 'b' }),
    user({ type: 'text', text: 'three' }),
  ]

  it('drops the thinking of every message below the cut as compacted, and records the cut', () => {
    const req: ProviderRequest = { model: anthropicModel(), messages, dropThinkingBefore: 2 }
    const encoded = encodeAnthropicMessages(req, 'anthropic')
    expect(encoded.thinkingDecisions).toEqual([
      { action: 'drop', reason: 'compacted' },
      { action: 'replay', reason: 'same-model' },
    ])
    const wire = bodyOf(encoded).messages as { role: string; content: { type: string }[] }[]
    expect(wire[1]?.content.map((block) => block.type)).toEqual(['text'])
    expect(wire[3]?.content.map((block) => block.type)).toEqual(['thinking', 'text'])
    expect(requestSnapshot(req).dropThinkingBefore).toBe(2)
    // Absent is 01: nothing is dropped for compaction.
    expect(
      encodeAnthropicMessages({ model: anthropicModel(), messages }, 'anthropic').thinkingDecisions,
    ).toEqual([
      { action: 'replay', reason: 'same-model' },
      { action: 'replay', reason: 'same-model' },
    ])
  })

  it('refuses a cut that is not a message index', () => {
    for (const cut of [-1, 1.5, Number.NaN]) {
      expect(() =>
        encodeAnthropicMessages(
          { model: anthropicModel(), messages, dropThinkingBefore: cut },
          'anthropic',
        ),
      ).toThrow(ProviderInvalidArgumentError)
      expect(() =>
        encodeOpenAIChat({ model: openAIModel(), messages, dropThinkingBefore: cut }, 'zhipu'),
      ).toThrow(ProviderInvalidArgumentError)
    }
  })
})

describe('02 不变量 1: encode() stays pure with effort and display', () => {
  const cases: readonly { name: string; definition: ProviderDefinition; req: ProviderRequest }[] = [
    {
      name: 'anthropic-messages',
      definition: anthropicDefinition,
      req: requestOf(OPUS_5_5, {
        system: 'be terse',
        tools: [TOOL],
        effort: 'high',
        display: 'summarized',
        dropThinkingBefore: 0,
      }),
    },
    {
      name: 'openai-chat',
      definition: zhipuDefinition,
      req: requestOf(FLASH, { system: 'be terse', tools: [TOOL], effort: 'max' }),
    },
  ]

  it.each(cases)('$name', ({ definition, req }) => {
    const { provider, net, clockCalls } = instance(definition)
    const first = provider.encode(req)
    const second = provider.encode(req)
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body))
    expect(second.promptHash).toBe(first.promptHash)
    expect(second.toolDefinitionsHash).toBe(first.toolDefinitionsHash)
    expect(net.callCount).toBe(0)
    expect(clockCalls()).toBe(0)
  })
})

const endsWithAssistant = (model: ModelInfo): ProviderRequest => ({
  model,
  messages: [user({ type: 'text', text: 'hi' }), assistant({ type: 'text', text: 'hello' })],
})

describe('02 不变量 2: a request ends with the user’s turn', () => {
  // oxlint-disable-next-line vitest/expect-expect -- the assertions are in expectRefusedLocally
  it('refuses one that ends with the assistant, locally and with no request, on both wires', async () => {
    await expectRefusedLocally(anthropicDefinition, endsWithAssistant(OPUS_5_5))
    await expectRefusedLocally(anthropicDefinition, endsWithAssistant(anthropicModel()))
    await expectRefusedLocally(zhipuDefinition, endsWithAssistant(FLASH))
    await expectRefusedLocally(zhipuDefinition, endsWithAssistant(GLM_4_6))
  })

  it('leaves every refusal 01 made first, with 01’s own error', () => {
    // A request 01 refused for its own reason is still refused for that reason, not this one.
    const hijacked = endsWithAssistant(anthropicModel({ requestParams: { system: 'x' } }))
    expect(() => encodeAnthropicMessages(hijacked, 'anthropic')).toThrow(
      /requestParams may not set "system"/,
    )
    const noMessages: ProviderRequest = { model: openAIModel(), messages: [] }
    expect(() => encodeOpenAIChat(noMessages, 'zhipu')).toThrow(/at least one message/)
  })
})
