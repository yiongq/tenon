/**
 * Acceptance 2: `encode()` is pure. The same request encoded twice gives byte-identical bodies
 * and hashes, nothing touches the network, and `thinkingDecisions` matches the guard's rule
 * table entry by entry.
 *
 * The rule table is exercised across BOTH wires on purpose: rule 4's echo branch has no field to
 * land in on the Anthropic wire and rule 7's replay has no signed block to carry it on the
 * OpenAI wire, so each wire refuses the branch it cannot represent (its own test file pins the
 * refusal). Between the two, all seven rules are asserted here.
 */
import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  NO_SYSTEM_PROMPT_HASH,
  ProviderInvalidArgumentError,
  ZHIPU_DEFAULT_BASE_URL,
  anthropicDefinition,
  canonicalJson,
  decideThinking,
  encodeAnthropicMessages,
  encodeOpenAIChat,
  requestSnapshot,
  sha256Hex,
  systemHash,
  zhipuDefinition,
} from '../../../src/index.js'
import type {
  ContentBlock,
  EncodedRequest,
  HostNetwork,
  ModelInfo,
  Provider,
  ProviderRequest,
  ThinkingBlock,
  ThinkingDecision,
  ToolSpec,
} from '../../../src/index.js'
import { fakeNetwork } from '../../../src/testing/index.js'
import {
  PNG_DATA,
  REDACTED_DATA,
  SIGNATURE,
  TOOL,
  anthropicModel,
  assistant,
  openAIModel,
  redactedBlock,
  requestOf,
  thinkingBlock,
  user,
} from './fixtures.js'

/** One request that exercises every block kind both wires have to map. */
function richRequest(): ProviderRequest {
  return {
    model: anthropicModel(),
    system: 'You are terse.',
    temperature: 0.2,
    maxTokens: 4096,
    // The documented bounds for this wire's thinking form: an integer >= 1024, below max_tokens.
    thinking: { enabled: true, budgetTokens: 2048 },
    tools: [TOOL],
    messages: [
      user(
        { type: 'text', text: 'what is in this file?' },
        {
          type: 'image',
          mediaType: 'image/png',
          data: PNG_DATA,
        },
      ),
      assistant(
        thinkingBlock(),
        redactedBlock(),
        { type: 'text', text: 'reading it now' },
        {
          type: 'tool-request',
          id: 'toolu_1',
          name: 'read_file',
          input: { path: '/tmp/a', encoding: 'utf8' },
        },
      ),
      user({
        type: 'tool-response',
        id: 'toolu_1',
        content: [{ type: 'text', text: 'file body' }],
        isError: false,
      }),
    ],
  }
}

/** The same request against an OpenAI-compatible model: signed blocks cannot go on that wire. */
function richOpenAIRequest(): ProviderRequest {
  const model = openAIModel({
    thinkingPreservationFormat: 'reasoning-content',
    reasoningEchoField: 'reasoning_content',
  })
  const req = richRequest()
  return {
    ...req,
    model,
    messages: req.messages.map((message) => ({
      role: message.role,
      content: message.content.map((block) =>
        block.type === 'thinking' || block.type === 'redacted-thinking'
          ? { ...block, provider: model.providerId, providerModel: model.id }
          : block,
      ),
    })),
  }
}

/** A clock reading, for the provider instances the network test builds. Nothing here reads it. */
const CLOCK = { now: (): number => Date.parse('2026-09-21T00:00:00.000Z') }

/** Configured so the adapter constructs at all; nothing is ever sent, so it is no credential. */
const CONFIGURED_KEY = 'test-key-not-a-real-credential'

const WIRES: readonly {
  name: string
  encode: (req: ProviderRequest) => EncodedRequest
  request: () => ProviderRequest
  providerId: string
  /** This wire's builtin definition, as the only thing that builds an instance HOLDING a network. */
  provider: (network: HostNetwork) => Provider
}[] = [
  {
    name: 'anthropic-messages',
    encode: (req) => encodeAnthropicMessages(req, 'anthropic'),
    request: richRequest,
    providerId: 'anthropic',
    provider: (network) =>
      anthropicDefinition.create({
        network,
        clock: CLOCK,
        config: { baseURL: ANTHROPIC_DEFAULT_BASE_URL },
        secrets: { apiKey: CONFIGURED_KEY },
      }),
  },
  {
    name: 'openai-chat',
    encode: (req) => encodeOpenAIChat(req, 'zhipu'),
    request: richOpenAIRequest,
    providerId: 'zhipu',
    provider: (network) =>
      zhipuDefinition.create({
        network,
        clock: CLOCK,
        config: { baseURL: ZHIPU_DEFAULT_BASE_URL },
        secrets: { apiKey: CONFIGURED_KEY },
      }),
  },
]

describe.each(WIRES)('$name encode() is pure', ({ encode, request, providerId, provider }) => {
  it('encodes the same request to identical bytes, hashes and decisions', () => {
    const req = request()
    const first = encode(req)
    const second = encode(req)
    // Byte identity, not just deep equality: the canonical form is what promptHash covers, and
    // JSON.stringify also pins the insertion order the SDK would serialise.
    expect(canonicalJson(second.body)).toBe(canonicalJson(first.body))
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body))
    expect(second.promptHash).toBe(first.promptHash)
    expect(second.toolDefinitionsHash).toBe(first.toolDefinitionsHash)
    expect(second.thinkingDecisions).toEqual(first.thinkingDecisions)
    expect(first.providerId).toBe(providerId)
    expect(first.modelId).toBe(req.model.id)
  })

  it('hashes the body with the documented recipe', () => {
    const encoded = encode(request())
    expect(encoded.promptHash).toBe(sha256Hex(canonicalJson(encoded.body)))
  })

  it('touches no network', () => {
    // Through a REAL provider, because the provider is the only object that HOLDS the network:
    // `create()` hands it the fake, and two `encode()` calls still leave it untouched. Catches an
    // `encode()` that reaches for its own `network.fetch(...)`; handing the fake to nobody watched
    // a seam no production code can see. The lint gate and the bundling test cover the rest of the
    // boundary (acceptance 8).
    const net = fakeNetwork([])
    // Counted the instant `fetch` is ENTERED: fakeNetwork records a call only after its first
    // await, so `callCount` alone would still read 0 inside this synchronous test.
    let entered = 0
    const watched: HostNetwork = {
      fetch: (input, init) => {
        entered += 1
        return net.fetch(input, init)
      },
    }
    const instance = provider(watched)
    instance.encode(request())
    instance.encode(request())
    expect(entered).toBe(0)
    expect(net.callCount).toBe(0)
    // And the free function behind it, for the same reason.
    encode(request())
    expect(entered).toBe(0)
    expect(net.requests).toHaveLength(0)
  })

  it('hashes independently of the key insertion order of nested objects', () => {
    const req = request()
    const reordered: ProviderRequest = {
      ...req,
      tools: [
        {
          description: TOOL.description,
          inputSchema: {
            required: ['path'],
            properties: { path: { type: 'string' } },
            type: 'object',
          },
          name: TOOL.name,
        },
      ],
      messages: req.messages.map((message) => ({
        role: message.role,
        content: message.content.map((block) =>
          block.type === 'tool-request'
            ? {
                type: 'tool-request' as const,
                input: { encoding: 'utf8', path: '/tmp/a' },
                name: block.name,
                id: block.id,
              }
            : block,
        ),
      })),
    }
    const plain = encode(req)
    const shuffled = encode(reordered)
    expect(shuffled.promptHash).toBe(plain.promptHash)
    expect(shuffled.toolDefinitionsHash).toBe(plain.toolDefinitionsHash)
    // The two really did differ in insertion order, so the canonical form is doing the work.
    expect(JSON.stringify(shuffled.body)).not.toBe(JSON.stringify(plain.body))
  })

  it('never leaves max_tokens undefined', () => {
    const req = request()
    const { maxTokens: _dropped, ...withoutMaxTokens } = req
    const candidates: readonly ProviderRequest[] = [req, withoutMaxTokens]
    for (const candidate of candidates) {
      const body = encode(candidate).body as Record<string, unknown>
      expect(Object.hasOwn(body, 'max_tokens')).toBe(true)
      expect(body.max_tokens).toBe(candidate.maxTokens ?? candidate.model.maxOutputTokens)
    }
  })

  it('hashes an empty tool list as [] and a present one as the wire definitions', () => {
    const req = request()
    const { tools: _dropped, ...withoutTools } = req
    const bare = encode(withoutTools)
    expect(bare.toolDefinitionsHash).toBe(sha256Hex(canonicalJson([])))
    expect(Object.hasOwn(bare.body as Record<string, unknown>, 'tools')).toBe(false)
    expect(encode(req).toolDefinitionsHash).not.toBe(bare.toolDefinitionsHash)
  })

  it('refuses a max_tokens that is not a positive integer', () => {
    // `max_tokens` is the one key the spec singles out as never undefined, and the dev fallback
    // feeds it from an environment variable. The snapshot goes through the same helper, so the
    // recorded number and the sent one cannot disagree about what is acceptable.
    for (const maxTokens of [0, -1, 1.5, Number.NaN]) {
      const req = { ...request(), maxTokens }
      expect(() => encode(req)).toThrow(ProviderInvalidArgumentError)
      expect(() => requestSnapshot(req)).toThrow(ProviderInvalidArgumentError)
    }
  })

  it('reports an unhashable value as a provider error, not a tape one', () => {
    // The encoders copy tool schemas, tool inputs and requestParams values by reference, so a
    // value canonicalJson refuses surfaces when the body is hashed — inside encode(). A caller
    // that classifies CanonicalJsonError as tape corruption must not see one from here.
    const cases: readonly ProviderRequest[] = [
      {
        ...request(),
        tools: [
          {
            name: 't',
            description: undefined,
            inputSchema: { type: 'object' },
          } as unknown as ToolSpec,
        ],
      },
      { ...request(), model: { ...request().model, requestParams: { opts: { a: undefined } } } },
      { ...request(), model: { ...request().model, requestParams: { meta: { toJSON: 1 } } } },
    ]
    for (const req of cases) {
      expect(() => encode(req)).toThrow(ProviderInvalidArgumentError)
    }
  })

  it('hashes exactly the tool definitions the body carries', () => {
    // The two are separate values in EncodedRequest, and only the body is sent. A hash taken over
    // anything but the body's own `tools` would describe a request nobody made; `tools` is therefore
    // one of the keys requestParams may not touch (each wire's own test pins the refusal).
    const encoded = encode(request())
    const body = encoded.body as Record<string, unknown>
    expect(encoded.toolDefinitionsHash).toBe(sha256Hex(canonicalJson(body.tools)))
  })
})

/**
 * The guard's rule table, as `thinkingDecisions` reports it. Each case names the rules it
 * exercises and lists one decision per reasoning block, in message/block order.
 */
interface DecisionCase {
  readonly name: string
  readonly wire: 'anthropic-messages' | 'openai-chat'
  readonly model: ModelInfo
  readonly blocks: readonly ThinkingBlock[]
  readonly hasTools: boolean
  readonly expected: readonly ThinkingDecision[]
}

/** Keeps the turn alive when every reasoning block of the case is dropped: an empty body is refused. */
const SURVIVOR: ContentBlock = { type: 'text', text: 'and so' }

const FOREIGN = { provider: 'openai', providerModel: 'gpt-test' }

const DECISION_CASES: readonly DecisionCase[] = [
  {
    name: 'rules 1, 2, 6 and 7 on signed blocks',
    wire: 'anthropic-messages',
    model: anthropicModel(),
    blocks: [
      thinkingBlock(FOREIGN),
      redactedBlock(FOREIGN),
      thinkingBlock({ providerModel: 'claude-test-3' }),
      redactedBlock({ providerModel: 'claude-test-3' }),
      thinkingBlock({ signature: '' }),
      thinkingBlock(),
      redactedBlock(),
    ],
    hasTools: false,
    expected: [
      { action: 'drop', reason: 'foreign-provider' },
      { action: 'drop', reason: 'foreign-provider' },
      { action: 'drop', reason: 'model-changed' },
      { action: 'drop', reason: 'model-changed' },
      { action: 'drop', reason: 'missing-signature' },
      { action: 'replay', reason: 'same-model' },
      { action: 'replay', reason: 'same-model' },
    ],
  },
  {
    name: 'rule 3 when the target keeps nothing',
    wire: 'anthropic-messages',
    model: anthropicModel({ thinkingPreservationFormat: 'drop' }),
    blocks: [thinkingBlock(), redactedBlock()],
    hasTools: true,
    expected: [
      { action: 'drop', reason: 'target-drops' },
      { action: 'drop', reason: 'target-drops' },
    ],
  },
  {
    name: 'rule 5 when the target keeps text only',
    wire: 'anthropic-messages',
    model: anthropicModel({ thinkingPreservationFormat: 'text-only' }),
    blocks: [thinkingBlock(), redactedBlock()],
    hasTools: false,
    expected: [
      { action: 'downgrade', reason: 'same-model' },
      { action: 'drop', reason: 'redacted-unsupported' },
    ],
  },
  {
    name: 'rule 4 with tools, echoed under reasoning_content',
    wire: 'openai-chat',
    model: openAIModel({
      thinkingPreservationFormat: 'reasoning-content',
      reasoningEchoField: 'reasoning_content',
    }),
    blocks: [
      thinkingBlock({ provider: 'zhipu', providerModel: 'glm-test' }),
      redactedBlock({ provider: 'zhipu', providerModel: 'glm-test' }),
    ],
    hasTools: true,
    expected: [
      { action: 'echo', reason: 'same-model' },
      { action: 'drop', reason: 'redacted-unsupported' },
    ],
  },
  {
    name: 'rule 4 without tools',
    wire: 'openai-chat',
    model: openAIModel({
      thinkingPreservationFormat: 'reasoning-content',
      reasoningEchoField: 'reasoning',
    }),
    blocks: [thinkingBlock({ provider: 'zhipu', providerModel: 'glm-test' })],
    hasTools: false,
    expected: [{ action: 'drop', reason: 'no-tools' }],
  },
]

describe('thinkingDecisions', () => {
  it.each(DECISION_CASES)('$name', ({ wire, model, blocks, hasTools, expected }) => {
    const req: ProviderRequest = {
      model,
      messages: [assistant(...blocks, SURVIVOR)],
      ...(hasTools ? { tools: [TOOL] } : {}),
    }
    const encoded =
      wire === 'anthropic-messages'
        ? encodeAnthropicMessages(req, model.providerId)
        : encodeOpenAIChat(req, model.providerId)
    expect(encoded.thinkingDecisions).toEqual(expected)
    // And the very same answers the guard gives on its own: no wire may hold a private copy of
    // the rules.
    expect(encoded.thinkingDecisions).toEqual(
      blocks.map((block) => decideThinking(block, { model, hasTools })),
    )
  })

  it('reports one decision per reasoning block in message and block order', () => {
    const model = anthropicModel({ thinkingPreservationFormat: 'text-only' })
    const req: ProviderRequest = {
      model,
      messages: [
        assistant(thinkingBlock(), redactedBlock()),
        user({ type: 'text', text: 'go on' }),
        assistant(redactedBlock(), thinkingBlock({ provider: 'openai' })),
      ],
    }
    expect(encodeAnthropicMessages(req, 'anthropic').thinkingDecisions).toEqual([
      { action: 'downgrade', reason: 'same-model' },
      { action: 'drop', reason: 'redacted-unsupported' },
      { action: 'drop', reason: 'redacted-unsupported' },
      { action: 'drop', reason: 'foreign-provider' },
    ])
  })
})

describe('the request snapshot helpers', () => {
  it('hashes a system prompt and marks its absence with a value no digest can be', () => {
    expect(systemHash('You are terse.')).toBe(sha256Hex('You are terse.'))
    expect(NO_SYSTEM_PROMPT_HASH).toBe('0'.repeat(64))
    expect(systemHash(undefined)).toBe(NO_SYSTEM_PROMPT_HASH)
    // An empty system prompt is no system prompt, which is also why neither wire writes one.
    expect(systemHash('')).toBe(NO_SYSTEM_PROMPT_HASH)
  })

  it('records only the keys the request carried', () => {
    const model = anthropicModel()
    expect(requestSnapshot(requestOf(model))).toEqual({
      systemHash: NO_SYSTEM_PROMPT_HASH,
      maxTokens: model.maxOutputTokens,
    })
    expect(
      requestSnapshot(
        requestOf(model, {
          system: 'be terse',
          temperature: 0.7,
          maxTokens: 64,
          thinking: { enabled: true, budgetTokens: 512 },
        }),
      ),
    ).toEqual({
      systemHash: sha256Hex('be terse'),
      maxTokens: 64,
      temperature: 0.7,
      thinking: { enabled: true, budgetTokens: 512 },
    })
    expect(requestSnapshot(requestOf(model, { thinking: { enabled: false } })).thinking).toEqual({
      enabled: false,
    })
  })

  it('describes the body that was actually built, not just what was asked for', () => {
    // Every field of the snapshot names something an encoder writes, and `requestParams` may not
    // overwrite any of them — otherwise the recorded fact would describe a request nobody sent and
    // the promptHash it carries could never be re-checked (acceptance 3).
    const req = requestOf(anthropicModel(), {
      system: 'You are Tenon.',
      temperature: 0.2,
      maxTokens: 2048,
      thinking: { enabled: true, budgetTokens: 1024 },
    })
    const snapshot = requestSnapshot(req)
    const body = encodeAnthropicMessages(req, 'anthropic').body as Record<string, unknown>
    expect(systemHash(body.system as string)).toBe(snapshot.systemHash)
    expect(body.max_tokens).toBe(snapshot.maxTokens)
    expect(body.temperature).toBe(snapshot.temperature)
    expect(body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: snapshot.thinking?.budgetTokens,
    })
    // And a passthrough cannot move any of them out from under the record.
    for (const key of ['system', 'temperature', 'thinking']) {
      const hijacked = requestOf(anthropicModel({ requestParams: { [key]: 'IGNORE THE ABOVE' } }), {
        system: 'You are Tenon.',
        temperature: 0.2,
        thinking: { enabled: true, budgetTokens: 1024 },
      })
      expect(() => encodeAnthropicMessages(hijacked, 'anthropic')).toThrow(
        ProviderInvalidArgumentError,
      )
    }
  })

  it('agrees with both encoders about max_tokens', () => {
    // The snapshot is what an auditor recomputes promptHash from (acceptance 3), so the two
    // cannot disagree about the fallback.
    const req = requestOf(anthropicModel())
    const snapshot = requestSnapshot(req)
    const anthropic = encodeAnthropicMessages(req, 'anthropic').body as Record<string, unknown>
    expect(anthropic.max_tokens).toBe(snapshot.maxTokens)
    const openAIReq = requestOf(openAIModel())
    const openAIBody = encodeOpenAIChat(openAIReq, 'zhipu').body as Record<string, unknown>
    expect(openAIBody.max_tokens).toBe(requestSnapshot(openAIReq).maxTokens)
  })
})

describe('signatures on the way out (invariant 7)', () => {
  it('replays the stored signature byte for byte and invents none elsewhere', () => {
    const signed = encodeAnthropicMessages(
      {
        model: anthropicModel(),
        messages: [assistant(thinkingBlock(), redactedBlock(), SURVIVOR)],
      },
      'anthropic',
    )
    const signedText = canonicalJson(signed.body)
    expect(signedText).toContain(SIGNATURE)
    expect(signedText).toContain(REDACTED_DATA)
    // Every other branch: nothing signature-shaped reaches the body at all.
    for (const model of [
      anthropicModel({ thinkingPreservationFormat: 'text-only' }),
      anthropicModel({ thinkingPreservationFormat: 'drop' }),
      anthropicModel({ id: 'claude-test-5' }),
    ]) {
      const encoded = encodeAnthropicMessages(
        { model, messages: [assistant(thinkingBlock(), redactedBlock(), SURVIVOR)] },
        'anthropic',
      )
      expect(canonicalJson(encoded.body)).not.toContain(SIGNATURE.slice(0, 12))
    }
  })
})
