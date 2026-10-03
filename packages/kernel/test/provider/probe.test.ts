/**
 * The probe of a custom vendor's row (M6 §探测; plan step 4): the two steps, every reason code, T10's
 * one retry, the checker for fields the openai-chat wire cannot send back (Q14) and where it stops
 * reading, and the abort path.
 *
 * Everything runs through `customVendorDefinition` and `fakeNetwork`: the probe sees the network it is
 * handed and nothing else. The vendor fixtures are in fixtures/probe-documented.ts (按文档、未实测) and
 * fixtures/probe-zhipu.ts (the shape recorded on 2026-09-22); every test that drives one of the former
 * says so in its name.
 */
import { describe, expect, it } from 'vitest'
import {
  createMemoryHost,
  customModelInfo,
  customVendorDefinition,
  encodeOpenAIChat,
  modelWireHash,
  probeModel,
} from '../../src/index.js'
import type {
  CustomVendorDescription,
  HostNetwork,
  ModelInfo,
  ProbeQuery,
  ProbeSnapshot,
  ProviderDefinition,
} from '../../src/index.js'
import { PROBE_PROMPT, PROBE_TOOL_RESULT } from '../../src/provider/probe.js'
import { ALLOWED_HEADERS as ANTHROPIC_HEADERS } from '../../src/provider/wire/anthropic-messages.js'
import { ALLOWED_HEADERS } from '../../src/provider/wire/openai-chat.js'
import { IDLE_MS_OTHER } from '../../src/provider/wire/transport.js'
import { createCounterIds, createStreamGate, fakeNetwork } from '../../src/testing/index.js'
import type { FakeExchange, FakeNetwork } from '../../src/testing/index.js'
import * as anthropicFixture from './fixtures/anthropic-sse.js'
import * as openAIFixture from './fixtures/openai-sse.js'
import * as doc from './fixtures/probe-documented.js'
import * as zhipu from './fixtures/probe-zhipu.js'

const NOW = Date.parse('2026-10-02T08:00:00.000Z')
const KEY = 'test-key-not-a-real-credential'
const MAX_TOKENS = 16_384

const OPENAI_ID = 'custom-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'
const ANTHROPIC_ID = 'custom-6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b'
const OPENAI_BASE = 'https://vendor.test/v1'
const ANTHROPIC_BASE = 'https://vendor.test/anthropic'

/** The task profile's builtin tools without WebSearch, which an instance never has (Q10). */
const PROBE_TOOLS = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'Read',
  'WebFetch',
  'Write',
]

function vendor(
  wire: CustomVendorDescription['wire'],
  modelId = 'vendor-model',
  over: Partial<CustomVendorDescription> = {},
): CustomVendorDescription {
  return {
    id: wire === 'openai-chat' ? OPENAI_ID : ANTHROPIC_ID,
    wire,
    baseURL: wire === 'openai-chat' ? OPENAI_BASE : ANTHROPIC_BASE,
    keyRequired: true,
    models: [{ id: modelId, contextLimit: 128_000, maxOutputTokens: 32_768 }],
    ...over,
  }
}

/** The definition, with every ModelInfo its provider encodes recorded (M6 不变量 9). */
function spied(definition: ProviderDefinition): {
  definition: ProviderDefinition
  models: ModelInfo[]
} {
  const models: ModelInfo[] = []
  return {
    models,
    definition: {
      ...definition,
      create(args) {
        const provider = definition.create(args)
        const encode = provider.encode.bind(provider)
        provider.encode = (req) => {
          models.push(req.model)
          return encode(req)
        }
        return provider
      },
    },
  }
}

interface ProbeRun {
  readonly snapshot: ProbeSnapshot
  readonly net: FakeNetwork
  readonly models: readonly ModelInfo[]
  readonly bodies: readonly Record<string, unknown>[]
}

function query(
  d: CustomVendorDescription,
  net: FakeNetwork,
  definition: ProviderDefinition,
  over: Partial<ProbeQuery> = {},
): ProbeQuery {
  const row = d.models[0]
  if (row === undefined) throw new Error('the description has no row')
  return {
    definition,
    row,
    network: net,
    clock: { now: () => NOW, setTimeout: () => () => undefined },
    config: {},
    secrets: { apiKey: KEY },
    maxTokens: MAX_TOKENS,
    policy: { status: 'current', version: 'probe-policy', snapshot: { tools: [] } },
    tenantId: 'probe-tenant',
    ids: createCounterIds(),
    signal: new AbortController().signal,
    ...over,
  }
}

async function probe(
  d: CustomVendorDescription,
  script: readonly FakeExchange[],
  over: Partial<ProbeQuery> = {},
): Promise<ProbeRun> {
  const net = fakeNetwork(script)
  const { definition, models } = spied(customVendorDefinition(d))
  const snapshot = await probeModel(query(d, net, definition, over))
  return {
    snapshot,
    net,
    models,
    bodies: net.requests.map((request) => request.body as Record<string, unknown>),
  }
}

const sse = (frames: readonly string[]): FakeExchange => ({ kind: 'sse', frames })
const json = (fixture: { status: number; body: unknown }): FakeExchange => ({
  kind: 'json',
  status: fixture.status,
  body: fixture.body,
})

/** A generic ① that calls Read once, and a generic ② that answers and stops. */
const CALL = sse(
  openAIFixture.turnFrames(
    ['Reading.'],
    [{ id: 'call_probe_1', name: 'Read', args: doc.PROBE_PATH_ARGS }],
    'tool_calls',
  ),
)
const ANSWER = sse(openAIFixture.turnFrames(['It said ok.'], [], 'stop'))

function snapshotOf(over: Partial<ProbeSnapshot>): ProbeSnapshot {
  return {
    outcome: 'passed',
    reason: null,
    probedAt: NOW,
    reasoningField: null,
    maxTokensField: 'max_tokens',
    usageSeen: true,
    responseModelId: openAIFixture.RESPONSE_MODEL_ID,
    unknownFields: [],
    ...over,
  }
}

function toolNames(body: Record<string, unknown> | undefined): string[] {
  return ((body?.['tools'] ?? []) as { function: { name: string } }[]).map(
    (tool) => tool.function.name,
  )
}

describe('the two steps (§两步, Q5)', () => {
  it('passes a Zhipu-shaped row in two requests through the instance alone (验收 14, 15)', async () => {
    const d = vendor('openai-chat', zhipu.ZHIPU_MODEL)
    const run = await probe(d, [sse(zhipu.ZHIPU_CALL_FRAMES), sse(zhipu.ZHIPU_ANSWER_FRAMES)])
    expect(run.snapshot).toEqual(
      snapshotOf({ reasoningField: 'reasoning_content', responseModelId: zhipu.ZHIPU_MODEL }),
    )
    expect(run.net.callCount).toBe(2)
    expect(run.net.requests.map((request) => [request.method, request.url])).toEqual([
      ['POST', `${OPENAI_BASE}/chat/completions`],
      ['POST', `${OPENAI_BASE}/chat/completions`],
    ])
    // Every header the A6 allowlist lets out, and no other (§何时、走哪条路).
    const allowed = new Set([...ALLOWED_HEADERS.names, ...Object.keys(ALLOWED_HEADERS.pinned)])
    for (const request of run.net.requests) {
      expect(Object.keys(request.headers).filter((name) => !allowed.has(name))).toEqual([])
      expect(request.headers['authorization']).toBe(`Bearer ${KEY}`)
    }
    const [one, two] = run.bodies
    // §两步「提示」: the prompt asks for one Read of /tenon-probe/ping.txt, a tool the table offers.
    expect(PROBE_PROMPT).toMatch(/\bRead\b/)
    expect(PROBE_PROMPT).toContain('"/tenon-probe/ping.txt"')
    expect(toolNames(one)).toContain('Read')
    // ①: the fixed prompt alone (no session content, T4), the task table without WebSearch, the
    // runtime's own output limit, usage asked for, and nothing T5 or Q9 leaves out.
    expect(one?.['messages']).toEqual([{ role: 'user', content: PROBE_PROMPT }])
    expect(toolNames(one)).toEqual(PROBE_TOOLS)
    expect(one?.['max_tokens']).toBe(MAX_TOKENS)
    expect(one?.['stream_options']).toEqual({ include_usage: true })
    for (const key of [
      'thinking',
      'reasoning_effort',
      'temperature',
      'tool_choice',
      'tool_stream',
    ]) {
      expect(one).not.toHaveProperty(key)
    }
    // ②: ①'s turn with its thinking echoed (the row now carries `reasoning_content`), then the
    // synthetic result — nothing was run.
    expect(two?.['messages']).toEqual([
      { role: 'user', content: PROBE_PROMPT },
      {
        role: 'assistant',
        reasoning_content: zhipu.ZHIPU_REASONING.join(''),
        tool_calls: [
          {
            id: 'call_-8126418316409712345',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"/tenon-probe/ping.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_-8126418316409712345', content: PROBE_TOOL_RESULT },
    ])
    expect(toolNames(two)).toEqual(PROBE_TOOLS)
  })

  it('M6 不变量 8: only the instance Provider and the given network; no tool runs, nothing untrusted', async () => {
    const run = await probe(vendor('openai-chat'), [CALL, ANSWER])
    expect(run.snapshot.outcome).toBe('passed')
    // Each body is exactly what that Provider's encode() produced for the row it was given.
    const encoded = run.models.map((model, i) => {
      const messages = (run.bodies[i]?.['messages'] ?? []) as unknown[]
      return { model: model.id, sent: messages.length }
    })
    expect(encoded).toEqual([
      { model: 'vendor-model', sent: 1 },
      { model: 'vendor-model', sent: 3 },
    ])
    // The call ① asked for was answered by the probe's fixed text, never executed: a Read of a path
    // that exists nowhere would have come back as an error.
    const last = messagesOf(run.bodies[1]).at(-1)
    expect(last).toEqual({ role: 'tool', tool_call_id: 'call_probe_1', content: 'ok' })
    expect(run.net.untrustedRequests).toEqual([])
  })

  const wires = [
    {
      label: 'openai-chat',
      wire: 'openai-chat',
      script: [CALL, ANSWER],
      headers: ALLOWED_HEADERS,
    },
    {
      label: 'anthropic-messages, 按文档、未实测 Anthropic Messages',
      wire: 'anthropic-messages',
      script: [
        sse(doc.anthropicCallFrames('vendor-model', doc.ANTHROPIC_SIGNATURE)),
        sse(doc.anthropicAnswerFrames('vendor-model')),
      ],
      headers: ANTHROPIC_HEADERS,
    },
  ] as const
  for (const { label, wire, script, headers } of wires) {
    it(`M6 不变量 3, 验收 14 (${label}): both requests follow no redirect and carry no header outside the wire’s A6 allowlist`, async () => {
      const redirects: (RequestRedirect | undefined)[] = []
      const net = fakeNetwork(script)
      const network: HostNetwork = {
        fetch: (input, init) => {
          redirects.push(init?.redirect)
          return net.fetch(input, init)
        },
        fetchUntrusted: net.fetchUntrusted,
      }
      const d = vendor(wire)
      const snapshot = await probeModel(
        query(d, fakeNetwork([]), customVendorDefinition(d), { network }),
      )
      expect(snapshot.outcome).toBe('passed')
      // A 3xx reads as a failure of the request, never as a hop to another host (M6 不变量 3).
      expect(redirects).toEqual(['error', 'error'])
      const allowed = new Set([...headers.names, ...Object.keys(headers.pinned)])
      expect(net.requests).toHaveLength(2)
      for (const request of net.requests) {
        expect(Object.keys(request.headers).filter((name) => !allowed.has(name))).toEqual([])
      }
    })
  }

  it('M6 不变量 9: ② sends the very row a pass stores', async () => {
    const d = vendor('openai-chat', zhipu.ZHIPU_MODEL)
    const run = await probe(d, [sse(zhipu.ZHIPU_CALL_FRAMES), sse(zhipu.ZHIPU_ANSWER_FRAMES)])
    const row = d.models[0]
    if (row === undefined) throw new Error('no row')
    const stored = customModelInfo(d, { ...row, probe: run.snapshot })
    expect(run.models[1]).toEqual(stored)
    expect(modelWireHash(run.models[1] as ModelInfo)).toBe(modelWireHash(stored))
    // ① differs only in carrying tools and in what a pass adds.
    expect(run.models[0]).toEqual({
      ...customModelInfo(d, { ...row }),
      supportsToolCalling: true,
    })
  })

  it('records the reported model name without judging it, cut to 200 characters (Q5)', async () => {
    const long = `aliased-${'x'.repeat(300)}`
    const frames = (finish: string, calls: boolean): readonly string[] =>
      openAIFixture
        .turnFrames(
          ['.'],
          calls ? [{ id: 'call_a', name: 'Read', args: doc.PROBE_PATH_ARGS }] : [],
          finish,
        )
        .map((frame) =>
          frame.replaceAll(`"model":"${openAIFixture.RESPONSE_MODEL_ID}"`, `"model":"${long}"`),
        )
    const run = await probe(vendor('openai-chat'), [
      sse(frames('tool_calls', true)),
      sse(frames('stop', false)),
    ])
    expect(run.snapshot.outcome).toBe('passed')
    expect(run.snapshot.responseModelId).toBe(long.slice(0, 200))
  })

  it('freezes the task table under the current policy: a Read the policy denies is not offered', async () => {
    const run = await probe(vendor('openai-chat'), [CALL], {
      policy: {
        status: 'current',
        version: 'no-read',
        snapshot: {
          tools: [{ policyId: 'p', serverId: 'builtin', toolName: 'Read', effect: 'deny' }],
        },
      },
    })
    expect(toolNames(run.bodies[0])).toEqual(PROBE_TOOLS.filter((name) => name !== 'Read'))
    // The model called a tool the table does not hold.
    expect(run.snapshot).toMatchObject({ outcome: 'failed', reason: 'bad-tool-call' })
    expect(run.net.callCount).toBe(1)
  })

  it('re-probes a row that already passed from the row without its probe (§两步 ①)', async () => {
    const old = snapshotOf({
      maxTokensField: 'max_completion_tokens',
      reasoningField: 'reasoning_content',
    })
    const d = vendor('openai-chat', 'vendor-model', {
      models: [{ id: 'vendor-model', contextLimit: 128_000, maxOutputTokens: 32_768, probe: old }],
    })
    const run = await probe(d, [CALL, ANSWER])
    // ① carries none of the old snapshot: the default field, so what is recorded is what was sent.
    expect(run.bodies[0]?.['max_tokens']).toBe(MAX_TOKENS)
    expect(run.bodies[0]).not.toHaveProperty('max_completion_tokens')
    expect(run.snapshot).toEqual(snapshotOf({}))
  })

  it('answers every complete call of ① in ②, one tool-response each, in order (§两步 ②)', async () => {
    const calls = [
      { id: 'call_first', name: 'Read', args: doc.PROBE_PATH_ARGS },
      { id: 'call_second', name: 'Read', args: doc.PROBE_PATH_ARGS },
    ]
    const run = await probe(vendor('openai-chat'), [
      sse(openAIFixture.turnFrames(['Reading.'], calls, 'tool_calls')),
      ANSWER,
    ])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', reason: null })
    const [, assistant, ...results] = messagesOf(run.bodies[1])
    expect(toolCallIds(assistant)).toEqual(['call_first', 'call_second'])
    expect(results).toEqual([
      { role: 'tool', tool_call_id: 'call_first', content: PROBE_TOOL_RESULT },
      { role: 'tool', tool_call_id: 'call_second', content: PROBE_TOOL_RESULT },
    ])
  })

  it('M6 不变量 9: usage from either request counts, the thinking field from ① alone', async () => {
    // ① reports usage and no thinking; ② thinks and reports no usage.
    const thinkingAnswer = sse([
      chunkFrame({ role: 'assistant', reasoning_content: 'It said ok.' }, null),
      chunkFrame({ content: 'It said ok.' }, 'stop'),
      'data: [DONE]\n\n',
    ])
    const d = vendor('openai-chat')
    const run = await probe(d, [CALL, thinkingAnswer])
    expect(run.snapshot).toMatchObject({
      outcome: 'passed',
      usageSeen: true,
      reasoningField: null,
    })
    const row = d.models[0]
    if (row === undefined) throw new Error('no row')
    const stored = customModelInfo(d, { ...row, probe: run.snapshot })
    expect(run.models[1]).toEqual(stored)
    expect(modelWireHash(run.models[1] as ModelInfo)).toBe(modelWireHash(stored))
    // No field seen in ①, and the row a pass stores still echoes, under `reasoning_content` (§合成;
    // 推出的读法 16): thinking that only starts in ② goes back on the row's later requests.
    expect(stored).toMatchObject({
      thinkingPreservationFormat: 'reasoning-content',
      reasoningEchoField: 'reasoning_content',
    })
    // The other way round: ① reports no usage, ② does.
    const reverse = await probe(d, [
      sse(openAIFixture.NO_USAGE_FRAMES.slice(0, 1).concat(CALL_WITHOUT_USAGE)),
      ANSWER,
    ])
    expect(reverse.snapshot).toMatchObject({ outcome: 'passed', usageSeen: true })
  })
})

describe('every reason code (§结果与原因码; 验收 15)', () => {
  const malformed = sse([
    `data: ${JSON.stringify({
      id: 'x',
      model: openAIFixture.RESPONSE_MODEL_ID,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_bad',
                type: 'function',
                function: { name: 'Read', arguments: '{"file_path": ' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })}\n\n`,
    'data: [DONE]\n\n',
  ])
  const cases: readonly {
    readonly name: string
    readonly script: readonly FakeExchange[]
    readonly outcome: ProbeSnapshot['outcome']
    readonly reason: ProbeSnapshot['reason']
    readonly requests: number
  }[] = [
    {
      name: '① answers in text only',
      script: [sse(openAIFixture.turnFrames(['I would rather not.'], [], 'stop'))],
      outcome: 'not-detected',
      reason: 'no-tool-call',
      requests: 1,
    },
    {
      name: '① is content-filtered without a call',
      script: [sse(openAIFixture.turnFrames(['I cannot help with that.'], [], 'content_filter'))],
      outcome: 'not-detected',
      reason: 'no-tool-call',
      requests: 1,
    },
    {
      name: '① runs out of output',
      script: [sse(openAIFixture.turnFrames(['Thinking at length'], [], 'length'))],
      outcome: 'not-detected',
      reason: 'output-limit',
      requests: 1,
    },
    {
      name: '② runs out of output',
      script: [CALL, sse(openAIFixture.turnFrames(['It said'], [], 'length'))],
      outcome: 'not-detected',
      reason: 'output-limit',
      requests: 2,
    },
    {
      name: '② ends some other way',
      script: [CALL, sse(openAIFixture.turnFrames(['It'], [], 'content_filter'))],
      outcome: 'not-detected',
      reason: 'no-finish',
      requests: 2,
    },
    {
      name: '① is refused for its key',
      script: [json(openAIFixture.UNAUTHORIZED)],
      outcome: 'failed',
      reason: 'auth',
      requests: 1,
    },
    {
      name: '① answers 402',
      script: [failing(402, 'insufficient_balance', 'Insufficient Balance')],
      outcome: 'failed',
      reason: 'quota',
      requests: 1,
    },
    {
      name: '① hits an exhausted quota (zhipu 1113)',
      script: [json(openAIFixture.OUT_OF_CREDIT)],
      outcome: 'failed',
      reason: 'quota',
      requests: 1,
    },
    {
      name: '① is rate limited',
      script: [json(openAIFixture.RATE_LIMITED)],
      outcome: 'failed',
      reason: 'rate-limit',
      requests: 1,
    },
    {
      name: '① with tools is refused',
      script: [failing(400, 'invalid_request_error', 'tools are not supported by this model')],
      outcome: 'failed',
      reason: 'request-rejected',
      requests: 1,
    },
    {
      name: '① overflows the context',
      script: [json(openAIFixture.CONTEXT_TOO_LONG)],
      outcome: 'failed',
      reason: 'request-rejected',
      requests: 1,
    },
    {
      name: '② is refused for the echo or the result',
      script: [
        CALL,
        failing(400, 'invalid_request_error', 'reasoning_content must be passed back'),
      ],
      outcome: 'failed',
      reason: 'echo-rejected',
      requests: 2,
    },
    {
      name: '① calls a tool outside the table',
      script: [
        sse(
          openAIFixture.turnFrames(
            [],
            [{ id: 'call_x', name: 'DeleteEverything', args: '{}' }],
            'tool_calls',
          ),
        ),
      ],
      outcome: 'failed',
      reason: 'bad-tool-call',
      requests: 1,
    },
    {
      // Any call outside the table fails ①, even beside one that is in it.
      name: '① calls Read and a tool outside the table',
      script: [
        sse(
          openAIFixture.turnFrames(
            [],
            [
              { id: 'call_probe_1', name: 'Read', args: doc.PROBE_PATH_ARGS },
              { id: 'call_x', name: 'DeleteEverything', args: '{}' },
            ],
            'tool_calls',
          ),
        ),
      ],
      outcome: 'failed',
      reason: 'bad-tool-call',
      requests: 1,
    },
    {
      name: '① stops on tool_calls with no complete call',
      script: [malformed],
      outcome: 'failed',
      reason: 'bad-tool-call',
      requests: 1,
    },
    {
      name: '① meets a server error',
      script: [json(openAIFixture.SERVER_ERROR)],
      outcome: 'failed',
      reason: 'service',
      requests: 1,
    },
    {
      name: '① never connects',
      script: [{ kind: 'connection-failure' }],
      outcome: 'failed',
      reason: 'service',
      requests: 1,
    },
    {
      name: '① is refused by the host’s egress policy',
      script: [{ kind: 'denied' }],
      outcome: 'failed',
      reason: 'service',
      requests: 1,
    },
    {
      // No status, no code, a message no rule reads: the vocabulary's `unknown`.
      name: '① breaks on an error nothing names',
      script: [
        sse([
          ...openAIFixture.turnFrames(['Reading.'], [], 'stop').slice(0, 2),
          `data: ${JSON.stringify({ error: { message: 'The engine hit an unexpected condition.' } })}\n\n`,
        ]),
      ],
      outcome: 'failed',
      reason: 'service',
      requests: 1,
    },
  ]

  for (const testCase of cases) {
    it(`${testCase.name}: ${testCase.outcome} / ${String(testCase.reason)}, ${String(testCase.requests)} request(s)`, async () => {
      const run = await probe(vendor('openai-chat'), testCase.script)
      expect(run.snapshot).toMatchObject({ outcome: testCase.outcome, reason: testCase.reason })
      // ② is sent only after a ① that called the table's tool (验收 14).
      expect(run.net.callCount).toBe(testCase.requests)
    })
  }

  it('config: a public instance without a key sends nothing', async () => {
    const run = await probe(vendor('openai-chat'), [], { secrets: {} })
    expect(run.snapshot).toEqual(
      snapshotOf({ outcome: 'failed', reason: 'config', usageSeen: false, responseModelId: null }),
    )
    expect(run.net.callCount).toBe(0)
  })

  it('a complete call beside one the decoder dropped goes to ②, which answers the complete one alone (§两步 ②)', async () => {
    const both = sse([
      chunkFrame(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_ok',
              type: 'function',
              function: { name: 'Read', arguments: doc.PROBE_PATH_ARGS },
            },
            {
              index: 1,
              id: 'call_cut',
              type: 'function',
              function: { name: 'Read', arguments: '{"file_path": ' },
            },
          ],
        },
        'tool_calls',
      ),
      'data: [DONE]\n\n',
    ])
    const run = await probe(vendor('openai-chat'), [both, ANSWER])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', reason: null })
    expect(run.net.callCount).toBe(2)
    const [, assistant, ...results] = messagesOf(run.bodies[1])
    expect(toolCallIds(assistant)).toEqual(['call_ok'])
    expect(results).toEqual([{ role: 'tool', tool_call_id: 'call_ok', content: PROBE_TOOL_RESULT }])
  })

  it('passes when ② ends by calling a tool again (§结果与原因码「通过」)', async () => {
    const again = sse(
      openAIFixture.turnFrames(
        ['Once more.'],
        [{ id: 'call_again', name: 'Read', args: doc.PROBE_PATH_ARGS }],
        'tool_calls',
      ),
    )
    const run = await probe(vendor('openai-chat'), [CALL, again])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', reason: null })
    expect(run.net.callCount).toBe(2)
  })

  it('bad-tool-call: a ① call whose input ② cannot encode sends no ② (§结果与原因码)', async () => {
    // canonicalJson refuses a `toJSON` key and nesting past 100 levels: Tenon cannot carry the call
    // back, so the probe resolves after one request rather than rejecting.
    for (const input of [
      { ...PROBE_INPUT, toJSON: 1 },
      { ...PROBE_INPUT, x: nested(120) },
    ]) {
      const call = { id: 'call_unencodable', name: 'Read', args: JSON.stringify(input) }
      // oxlint-disable-next-line no-await-in-loop -- one probe per input
      const run = await probe(vendor('openai-chat'), [
        sse(openAIFixture.turnFrames(['Reading.'], [call], 'tool_calls')),
        ANSWER,
      ])
      expect(run.snapshot).toMatchObject({ outcome: 'failed', reason: 'bad-tool-call' })
      expect(run.net.callCount).toBe(1)
    }
  })

  it('config: an address the wire refuses sends nothing', async () => {
    const run = await probe(
      vendor('anthropic-messages', 'm', { baseURL: 'https://vendor.test/anthropic/v1' }),
      [],
    )
    expect(run.snapshot).toMatchObject({ outcome: 'failed', reason: 'config' })
    expect(run.net.callCount).toBe(0)
  })

  it('config: a stored key no header can carry sends nothing, on either wire (§结果与原因码「发出之前」)', async () => {
    for (const wire of ['openai-chat', 'anthropic-messages'] as const) {
      for (const apiKey of ['test-key\nsecond-line', 'test-key-中']) {
        // oxlint-disable-next-line no-await-in-loop -- one probe per wire and key
        const run = await probe(vendor(wire), [], { secrets: { apiKey } })
        expect(run.snapshot).toMatchObject({ outcome: 'failed', reason: 'config' })
        expect(run.net.callCount).toBe(0)
      }
    }
  })

  it('按文档、未实测 Bailian: a 429 insufficient_quota is a rate limit here (验收 24)', async () => {
    const run = await probe(vendor('openai-chat'), [json(doc.BAILIAN_THROTTLED)])
    expect(run.snapshot).toMatchObject({ outcome: 'failed', reason: 'rate-limit' })
  })

  it('按文档、未实测 Kimi: a 429 exceeded_current_quota_error (an empty balance) records rate-limit (T11, 验收 24)', async () => {
    const run = await probe(vendor('openai-chat'), [json(doc.KIMI_BALANCE_EXHAUSTED)])
    expect(run.snapshot).toMatchObject({ outcome: 'failed', reason: 'rate-limit' })
    expect(run.net.callCount).toBe(1)
  })

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'DeepSeek’s live wrong-key 401 (code invalid_request_error) on %s records auth (M6 §点名 (h))',
    async (wire) => {
      // The 401 is read before the body's generic code on both wires; the run time agrees
      // (custom-vendor-runtime.test.ts), and so does /models (remote-models.test.ts).
      const run = await probe(vendor(wire), [json(doc.DEEPSEEK_WRONG_KEY)])
      expect(run.snapshot).toMatchObject({ outcome: 'failed', reason: 'auth' })
      expect(run.net.callCount).toBe(1)
    },
  )
})

describe('T10: the output-limit field (验收 16)', () => {
  const unsupported: FakeExchange = {
    kind: 'json',
    status: 400,
    body: {
      error: {
        message:
          "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        type: 'invalid_request_error',
        param: 'max_tokens',
        code: 'unsupported_parameter',
      },
    },
  }

  it('resends ① once under max_completion_tokens, records it, and the stored row writes only that', async () => {
    const d = vendor('openai-chat')
    const run = await probe(d, [unsupported, CALL, ANSWER])
    expect(run.snapshot).toEqual(snapshotOf({ maxTokensField: 'max_completion_tokens' }))
    expect(run.net.callCount).toBe(3)
    expect(run.bodies.map((body) => [body['max_tokens'], body['max_completion_tokens']])).toEqual([
      [MAX_TOKENS, undefined],
      [undefined, MAX_TOKENS],
      [undefined, MAX_TOKENS],
    ])
    const row = d.models[0]
    if (row === undefined) throw new Error('no row')
    const stored = customModelInfo(d, { ...row, probe: run.snapshot })
    const body = encodeOpenAIChat(
      { model: stored, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      OPENAI_ID,
    ).body as Record<string, unknown>
    expect(body).not.toHaveProperty('max_tokens')
    expect(body['max_completion_tokens']).toBe(row.maxOutputTokens)
  })

  it('验收 16: a row that needed the resend and then did not pass still writes only max_completion_tokens', async () => {
    const d = vendor('openai-chat')
    const run = await probe(d, [
      unsupported,
      sse(openAIFixture.turnFrames(['I would rather not.'], [], 'stop')),
    ])
    expect(run.snapshot).toMatchObject({
      outcome: 'not-detected',
      reason: 'no-tool-call',
      maxTokensField: 'max_completion_tokens',
    })
    const row = d.models[0]
    if (row === undefined) throw new Error('no row')
    // The text-only row it stores (§合成: the field is the wire's fact, not a capability).
    const stored = customModelInfo(d, { ...row, probe: run.snapshot })
    expect(stored.supportsToolCalling).toBe(false)
    const body = encodeOpenAIChat(
      { model: stored, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      OPENAI_ID,
    ).body as Record<string, unknown>
    expect(body).not.toHaveProperty('max_tokens')
    expect(body['max_completion_tokens']).toBe(row.maxOutputTokens)
    expect(body).not.toHaveProperty('tools')
  })

  it('resends on unsupported_parameter about max_tokens, though the message never names max_completion_tokens (§两步 T10)', async () => {
    const run = await probe(vendor('openai-chat'), [
      failing(400, 'unsupported_parameter', "'max_tokens' is not supported with this model."),
      CALL,
      ANSWER,
    ])
    expect(run.snapshot).toMatchObject({
      outcome: 'passed',
      maxTokensField: 'max_completion_tokens',
    })
    expect(run.net.callCount).toBe(3)
  })

  it('resends for a gateway that names both fields without the code', async () => {
    const run = await probe(vendor('openai-chat'), [
      {
        kind: 'json',
        status: 400,
        body: { error: { message: 'max_tokens is deprecated, use max_completion_tokens' } },
      },
      CALL,
      ANSWER,
    ])
    expect(run.snapshot).toMatchObject({
      outcome: 'passed',
      maxTokensField: 'max_completion_tokens',
    })
    expect(run.net.callCount).toBe(3)
  })

  it('does not resend a 400 that names max_tokens alone', async () => {
    const run = await probe(vendor('openai-chat'), [
      {
        kind: 'json',
        status: 400,
        body: {
          error: {
            message: 'max_tokens must be less than or equal to 8192',
            type: 'invalid_request_error',
            code: 'invalid_request_error',
          },
        },
      },
    ])
    expect(run.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'request-rejected',
      maxTokensField: 'max_tokens',
    })
    expect(run.net.callCount).toBe(1)
  })

  const notResent: readonly { name: string; exchange: FakeExchange }[] = [
    {
      name: 'a 422 that names both fields',
      exchange: {
        kind: 'json',
        status: 422,
        body: { error: { message: 'max_tokens is deprecated, use max_completion_tokens' } },
      },
    },
    {
      // The wording reads as `context-overflow`, not `invalid-request`.
      name: 'a 400 that names both fields over the context window',
      exchange: {
        kind: 'json',
        status: 400,
        body: {
          error: {
            message:
              "'max_tokens' or 'max_completion_tokens' is too large: 16384. This model's maximum context length is 8192 tokens",
          },
        },
      },
    },
    {
      name: 'a 400 that names max_completion_tokens alone',
      exchange: {
        kind: 'json',
        status: 400,
        body: { error: { message: 'max_completion_tokens must be at least 1' } },
      },
    },
  ]
  for (const { name, exchange } of notResent) {
    it(`does not resend ${name}`, async () => {
      const run = await probe(vendor('openai-chat'), [exchange])
      expect(run.snapshot).toMatchObject({
        outcome: 'failed',
        reason: 'request-rejected',
        maxTokensField: 'max_tokens',
      })
      expect(run.net.callCount).toBe(1)
    })
  }

  it('does not resend an unsupported_parameter about another parameter, and the row keeps max_tokens', async () => {
    const d = vendor('openai-chat')
    const run = await probe(d, [
      {
        kind: 'json',
        status: 400,
        body: {
          error: {
            message: "Unsupported parameter: 'tools' is not supported with this model.",
            type: 'invalid_request_error',
            param: 'tools',
            code: 'unsupported_parameter',
          },
        },
      },
    ])
    expect(run.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'request-rejected',
      maxTokensField: 'max_tokens',
    })
    expect(run.net.callCount).toBe(1)
    const row = d.models[0]
    if (row === undefined) throw new Error('no row')
    // The text-only row it stores still sends the field its endpoint never refused.
    const stored = customModelInfo(d, { ...row, probe: run.snapshot })
    const body = encodeOpenAIChat(
      { model: stored, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      OPENAI_ID,
    ).body as Record<string, unknown>
    expect(body['max_tokens']).toBe(row.maxOutputTokens)
    expect(body).not.toHaveProperty('max_completion_tokens')
  })

  // §两步 T10: a probe that ends before the endpoint has answered which field it takes keeps the field
  // the row learned, so a re-probe that meets a 429 does not move the row back to `max_tokens`.
  const unanswered: readonly {
    readonly name: string
    readonly script: readonly FakeExchange[]
    readonly over?: Partial<ProbeQuery>
    readonly reason: ProbeSnapshot['reason']
    readonly requests: number
  }[] = [
    {
      name: 'a 429',
      script: [failing(429, 'rate_limit_exceeded')],
      reason: 'rate-limit',
      requests: 1,
    },
    { name: 'a 503', script: [failing(503, 'server_error')], reason: 'service', requests: 1 },
    { name: 'nothing sent', script: [], over: { secrets: {} }, reason: 'config', requests: 0 },
  ]
  for (const { name, script, over, reason, requests } of unanswered) {
    it(`keeps a learned max_completion_tokens through a re-probe that ends in ${name}`, async () => {
      const learned = snapshotOf({ maxTokensField: 'max_completion_tokens' })
      const d = vendor('openai-chat', 'vendor-model', {
        models: [
          { id: 'vendor-model', contextLimit: 128_000, maxOutputTokens: 32_768, probe: learned },
        ],
      })
      const run = await probe(d, script, over)
      expect(run.snapshot).toMatchObject({
        outcome: 'failed',
        reason,
        maxTokensField: 'max_completion_tokens',
      })
      expect(run.net.callCount).toBe(requests)
      const row = d.models[0]
      if (row === undefined) throw new Error('no row')
      // The text-only row the failed snapshot stores still sends only the field its endpoint takes.
      const stored = customModelInfo(d, { ...row, probe: run.snapshot })
      const body = encodeOpenAIChat(
        { model: stored, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
        OPENAI_ID,
      ).body as Record<string, unknown>
      expect(body).not.toHaveProperty('max_tokens')
      expect(body['max_completion_tokens']).toBe(row.maxOutputTokens)
    })
  }

  it('resends only once', async () => {
    const run = await probe(vendor('openai-chat'), [unsupported, unsupported])
    expect(run.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'request-rejected',
      maxTokensField: 'max_completion_tokens',
    })
    expect(run.net.callCount).toBe(2)
  })

  it('never resends on the anthropic-messages wire, which records no field', async () => {
    const run = await probe(vendor('anthropic-messages'), [
      {
        kind: 'json',
        status: 400,
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'max_tokens: use max_completion_tokens instead',
          },
        },
      },
    ])
    expect(run.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'request-rejected',
      maxTokensField: null,
      reasoningField: null,
    })
    expect(run.net.callCount).toBe(1)
  })
})

describe('fields the openai-chat wire cannot send back (§不认识的字段, Q14; 验收 17)', () => {
  const opaque: readonly { name: string; frames: readonly string[]; field: string }[] = [
    { name: 'Volcengine Ark', frames: doc.ARK_ENCRYPTED_FRAMES, field: 'encrypted_content' },
    { name: 'OpenRouter', frames: doc.OPENROUTER_DETAILS_FRAMES, field: 'reasoning_details' },
    { name: 'Gemini', frames: doc.GEMINI_EXTRA_CONTENT_FRAMES, field: 'extra_content' },
  ]
  for (const { name, frames, field } of opaque) {
    it(`M6 不变量 10 — 按文档、未实测 ${name}: ${field} fails ① as opaque-fields and names the key`, async () => {
      const run = await probe(vendor('openai-chat'), [sse(frames)])
      expect(run.snapshot).toMatchObject({
        outcome: 'failed',
        reason: 'opaque-fields',
        unknownFields: [field],
      })
      expect(run.net.callCount).toBe(1)
    })
  }

  const passing: readonly { name: string; script: readonly FakeExchange[]; model: string }[] = [
    {
      name: '按文档、未实测 DeepSeek',
      script: [sse(doc.DEEPSEEK_CALL_FRAMES), sse(doc.DEEPSEEK_ANSWER_FRAMES)],
      model: doc.DEEPSEEK_MODEL,
    },
    {
      name: 'Zhipu (the recorded shape: role on every delta, content on the finish delta, nulls)',
      script: [sse(zhipu.ZHIPU_CALL_FRAMES), sse(zhipu.ZHIPU_ANSWER_FRAMES)],
      model: zhipu.ZHIPU_MODEL,
    },
    {
      name: '按文档、未实测 MiniMax (name: "MiniMax AI" and an empty audio_content on every delta)',
      script: [sse(doc.MINIMAX_CALL_FRAMES), sse(doc.MINIMAX_ANSWER_FRAMES)],
      model: doc.MINIMAX_MODEL,
    },
  ]
  for (const { name, script, model } of passing) {
    it(`passes ${name}`, async () => {
      const run = await probe(vendor('openai-chat', model), script)
      expect(run.snapshot).toMatchObject({ outcome: 'passed', unknownFields: [] })
      expect(run.net.callCount).toBe(2)
    })
  }

  it('验收 30 — 按文档、未实测 Z.ai (智谱国际站): the Zhipu frames stand for it and pass at its preset’s address', async () => {
    // fixtures/probe-zhipu.ts: no z.ai stream has been recorded; its docs give bigmodel's shape.
    const base = 'https://api.z.ai/api/paas/v4'
    const run = await probe(vendor('openai-chat', zhipu.ZHIPU_MODEL, { baseURL: base }), [
      sse(zhipu.ZHIPU_CALL_FRAMES),
      sse(zhipu.ZHIPU_ANSWER_FRAMES),
    ])
    expect(run.snapshot).toEqual(
      snapshotOf({ reasoningField: 'reasoning_content', responseModelId: zhipu.ZHIPU_MODEL }),
    )
    expect(run.net.requests.map((request) => request.url)).toEqual([
      `${base}/chat/completions`,
      `${base}/chat/completions`,
    ])
  })

  it('按文档、未实测 DeepSeek: records reasoning_content and echoes it in ② (验收 29 的形状)', async () => {
    const run = await probe(vendor('openai-chat', doc.DEEPSEEK_MODEL), [
      sse(doc.DEEPSEEK_CALL_FRAMES),
      sse(doc.DEEPSEEK_ANSWER_FRAMES),
    ])
    expect(run.snapshot).toEqual(
      snapshotOf({ reasoningField: 'reasoning_content', responseModelId: doc.DEEPSEEK_MODEL }),
    )
    const assistant = messagesOf(run.bodies[1])[1]
    expect(assistant?.['reasoning_content']).toBe(doc.DEEPSEEK_REASONING)
  })

  it('按文档、未实测 Bailian: usage only in the trailing empty-choices chunk still counts (验收 13)', async () => {
    const run = await probe(vendor('openai-chat', doc.BAILIAN_MODEL), [
      sse(doc.BAILIAN_CALL_FRAMES),
      sse(doc.BAILIAN_ANSWER_FRAMES),
    ])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', usageSeen: true })
    expect(run.bodies[0]?.['stream_options']).toEqual({ include_usage: true })
  })

  it('按文档、未实测 Kimi: passes, reading usage from the include_usage chunk and never from the choice', async () => {
    const run = await probe(vendor('openai-chat', doc.KIMI_MODEL), [
      sse(doc.KIMI_CALL_FRAMES),
      sse(doc.KIMI_ANSWER_FRAMES),
    ])
    expect(run.snapshot).toEqual(
      snapshotOf({ reasoningField: 'reasoning_content', responseModelId: doc.KIMI_MODEL }),
    )
    expect(messagesOf(run.bodies[1])[1]?.['reasoning_content']).toBe(doc.KIMI_REASONING)
    // Without the include_usage chunk only the choice-level `choices[0].usage` is left, which is not
    // the standard path (§合成 `usageNeedsOptIn`).
    const bare = await probe(
      vendor('openai-chat', doc.KIMI_MODEL),
      [doc.KIMI_CALL_FRAMES, doc.KIMI_ANSWER_FRAMES].map((frames) =>
        sse(frames.filter((frame) => frame !== doc.KIMI_USAGE_FRAME)),
      ),
    )
    expect(bare.snapshot).toMatchObject({ outcome: 'passed', usageSeen: false, unknownFields: [] })
  })

  it('reads no usage it was not given', async () => {
    const run = await probe(vendor('openai-chat'), [
      sse(openAIFixture.NO_USAGE_FRAMES.slice(0, 1).concat(CALL_WITHOUT_USAGE)),
      sse(openAIFixture.NO_USAGE_FRAMES),
    ])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', usageSeen: false })
  })

  it('records the thinking field by its spelling: `reasoning` is echoed as `reasoning`', async () => {
    const thinking = sse([
      chunkFrame({ role: 'assistant', reasoning: 'Read it.' }, null),
      ...callWith({}, {}),
    ])
    const run = await probe(vendor('openai-chat'), [thinking, ANSWER])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', reasoningField: 'reasoning' })
    const assistant = messagesOf(run.bodies[1])[1]
    expect(assistant?.['reasoning']).toBe('Read it.')
    expect(assistant).not.toHaveProperty('reasoning_content')
  })

  it('counts only a final usage reading: a stream that broke after message_start has none', async () => {
    const run = await probe(vendor('anthropic-messages'), [
      sse(anthropicFixture.MID_STREAM_ERROR_FRAMES),
    ])
    expect(run.snapshot).toMatchObject({ outcome: 'failed', reason: 'service', usageSeen: false })
  })

  it('looks at ② too', async () => {
    const run = await probe(vendor('openai-chat'), [CALL, sse(withDelta({ refusal_details: 'r' }))])
    expect(run.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['refusal_details'],
    })
    expect(run.net.callCount).toBe(2)
  })

  it('puts opaque-fields before an error in the same response', async () => {
    const frames = [
      ...withDelta({ encrypted_content: 'e' }).slice(0, 1),
      ...openAIFixture.MID_STREAM_ERROR_FRAMES.slice(-2),
    ]
    const run = await probe(vendor('openai-chat'), [sse(frames)])
    expect(run.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['encrypted_content'],
    })
  })

  it('puts opaque-fields before an error in the same response in ② as well', async () => {
    const frames = [
      ...withDelta({ encrypted_content: 'e' }).slice(0, 1),
      ...openAIFixture.MID_STREAM_ERROR_FRAMES.slice(-2),
    ]
    const run = await probe(vendor('openai-chat'), [CALL, sse(frames)])
    expect(run.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['encrypted_content'],
    })
    expect(run.net.callCount).toBe(2)
  })

  it('takes a key whose value is null, empty, [] or {} as absent, and compares names exactly', async () => {
    const quiet = { refusal: null, audio: '', annotations: [], extra_content: {} }
    const run = await probe(vendor('openai-chat'), [sse(withDelta(quiet, true)), ANSWER])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', unknownFields: [] })
    // Only those four count as absent: `false` and `0` are values (§不认识的字段).
    const falsy = await probe(vendor('openai-chat'), [
      sse(withDelta({ x_flag: false, x_count: 0 }, true)),
    ])
    expect(falsy.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['x_flag', 'x_count'],
    })
    // `Content` is not `content`.
    const cased = await probe(vendor('openai-chat'), [sse(withDelta({ Content: 'x' }, true))])
    expect(cased.snapshot.unknownFields).toEqual(['Content'])
    // `audio` (glm-4-voice) is outside the known set once it carries something.
    const audio = await probe(vendor('openai-chat'), [
      sse(withDelta({ audio: { id: 'a', data: 'x' } }, true)),
    ])
    expect(audio.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['audio'],
    })
  })

  it('checks no choice-level key: logprobs or a choice-level usage beside the delta passes', async () => {
    const first = `data: ${JSON.stringify({
      id: 'x',
      model: openAIFixture.RESPONSE_MODEL_ID,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'Working.' },
          logprobs: { content: [{ token: 'x', logprob: -0.1 }] },
          // Kimi puts usage on the choice.
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          finish_reason: null,
        },
      ],
    })}\n\n`
    const run = await probe(vendor('openai-chat'), [sse([first, ...callWith({}, {})]), ANSWER])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', unknownFields: [] })
    expect(run.net.callCount).toBe(2)
  })

  it('reads only the delta of a stream: a whole message restated beside it is choice-level', async () => {
    const call = {
      index: 0,
      id: 'call_m',
      type: 'function',
      function: { name: 'Read', arguments: doc.PROBE_PATH_ARGS },
    }
    // The decoder reads `choices[0].delta` alone, so neither the unknown key nor the thinking text
    // in this `message` reaches it.
    const last = `data: ${JSON.stringify({
      id: 'x',
      model: openAIFixture.RESPONSE_MODEL_ID,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'Restated.',
            tool_calls: [call],
            vendor_trace: 'abc',
          },
        },
      ],
    })}\n\n`
    const run = await probe(vendor('openai-chat'), [
      sse([chunkFrame({ role: 'assistant', tool_calls: [call] }, null), last, 'data: [DONE]\n\n']),
      ANSWER,
    ])
    expect(run.snapshot).toMatchObject({
      outcome: 'passed',
      reasoningField: null,
      unknownFields: [],
    })
    expect(run.net.callCount).toBe(2)
  })

  it('checks the delta of every choice, not only the first (`choices[*]`)', async () => {
    const two = `data: ${JSON.stringify({
      id: 'x',
      model: openAIFixture.RESPONSE_MODEL_ID,
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'x' } },
        { index: 1, delta: { encrypted_content: 'e' } },
      ],
    })}\n\n`
    const run = await probe(vendor('openai-chat'), [sse([two, ...callWith({}, {})]), ANSWER])
    expect(run.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['encrypted_content'],
    })
    expect(run.net.callCount).toBe(1)
  })

  it('takes the thinking field from the first choice alone, as the decoder does', async () => {
    const two = `data: ${JSON.stringify({
      id: 'x',
      model: openAIFixture.RESPONSE_MODEL_ID,
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'x' } },
        { index: 1, delta: { reasoning_content: 'Another choice.' } },
      ],
    })}\n\n`
    const run = await probe(vendor('openai-chat'), [sse([two, ...callWith({}, {})]), ANSWER])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', reasoningField: null })
    const assistant = messagesOf(run.bodies[1])[1]
    expect(assistant).not.toHaveProperty('reasoning_content')
    expect(assistant).not.toHaveProperty('reasoning')
  })

  it('records at most 16 names, each cut to 64 characters, in order of appearance (Q14)', async () => {
    const long = `k${'y'.repeat(64)}`
    const fields: Record<string, string> = { [long]: 'v' }
    for (let i = 0; i < 16; i += 1) fields[`extra_${String(i).padStart(2, '0')}`] = 'v'
    const run = await probe(vendor('openai-chat'), [sse(withDelta(fields, true))])
    expect(run.snapshot.reason).toBe('opaque-fields')
    expect(run.snapshot.unknownFields).toHaveLength(16)
    expect(run.snapshot.unknownFields[0]).toBe(long.slice(0, 64))
    expect(run.snapshot.unknownFields.at(-1)).toBe('extra_14')
    expect(run.snapshot.unknownFields.every((name) => name.length <= 64)).toBe(true)
  })

  it('M6 不变量 10: an unknown key on a tool call or on its function object fails ① as opaque-fields', async () => {
    const onCall = await probe(vendor('openai-chat'), [
      sse(callWith({ custom_sig: 's' }, {})),
      ANSWER,
    ])
    expect(onCall.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['custom_sig'],
    })
    expect(onCall.net.callCount).toBe(1)
    const onFunction = await probe(vendor('openai-chat'), [
      sse(callWith({}, { strict: true })),
      ANSWER,
    ])
    expect(onFunction.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['strict'],
    })
    expect(onFunction.net.callCount).toBe(1)
  })

  it('takes a tool call’s `custom` as unknown: the decoder skips such a call (Q14)', async () => {
    const run = await probe(vendor('openai-chat'), [
      sse(callWith({ custom: { name: 'Read', input: 'x' } }, {})),
    ])
    expect(run.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['custom'],
    })
  })

  it('names a key repeated on every delta once', async () => {
    const run = await probe(vendor('openai-chat'), [
      sse([
        chunkFrame(
          { role: 'assistant', reasoning_details: [{ type: 'reasoning.text', text: 'Reading' }] },
          null,
        ),
        chunkFrame({ reasoning_details: [{ type: 'reasoning.text', text: ' it.' }] }, null),
        ...callWith({}, {}),
      ]),
    ])
    expect(run.snapshot).toMatchObject({
      reason: 'opaque-fields',
      unknownFields: ['reasoning_details'],
    })
  })

  it('M6 不变量 10: reads an event whose data spans two lines as one, as the decoder does', async () => {
    const twoLines =
      `data: {"id":"x","model":"${openAIFixture.RESPONSE_MODEL_ID}","choices":[{"index":0,"delta":\n` +
      'data: {"role":"assistant","content":"Reading.","encrypted_content":"opaque"}}]}\n\n'
    const run = await probe(vendor('openai-chat'), [sse([twoLines, ...callWith({}, {})]), ANSWER])
    expect(run.snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['encrypted_content'],
    })
    expect(run.net.callCount).toBe(1)
  })

  it('M6 不变量 10: joins the data lines with a line break, so a key split across them is no key', async () => {
    // Joined with "\n" the key holds a raw line break, which no JSON parser takes: the decoder
    // cannot read this event either, and reports the broken stream itself.
    const splitKey =
      `data: {"id":"x","model":"${openAIFixture.RESPONSE_MODEL_ID}","choices":[{"index":0,"delta":{"encrypted_\n` +
      'data: content":"e"}}]}\n\n'
    const run = await probe(vendor('openai-chat'), [sse([splitKey, ...callWith({}, {})]), ANSWER])
    expect(run.snapshot).toMatchObject({ outcome: 'failed', reason: 'service', unknownFields: [] })
    expect(run.net.callCount).toBe(1)
  })

  it('M6 不变量 10: reads a key whose UTF-8 bytes are split between chunks whole', async () => {
    const text = [
      chunkFrame({ role: 'assistant', content: 'W', 推理: 'x' }, null),
      ...callWith({}, {}),
    ].join('')
    const encoder = new TextEncoder()
    const bytes = encoder.encode(text)
    // One byte into the three of '推'.
    const cut = encoder.encode(text.slice(0, text.indexOf('推理'))).byteLength + 1
    let calls = 0
    const network: HostNetwork = {
      fetch: () => {
        calls += 1
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, cut))
            controller.enqueue(bytes.slice(cut))
            controller.close()
          },
        })
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        )
      },
      fetchUntrusted: () => Promise.reject(new Error('never')),
    }
    const d = vendor('openai-chat')
    const snapshot = await probeModel(
      query(d, fakeNetwork([]), customVendorDefinition(d), { network }),
    )
    expect(snapshot).toMatchObject({
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['推理'],
    })
    expect(calls).toBe(1)
  })

  const framings: readonly { name: string; exchange: FakeExchange }[] = [
    {
      name: 'a body that came back whole (`choices[*].message`, M6 不变量 10)',
      exchange: json({
        status: 200,
        body: {
          id: 'x',
          object: 'chat.completion',
          model: openAIFixture.RESPONSE_MODEL_ID,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Read.', encrypted_content: 'opaque' },
              finish_reason: 'stop',
            },
          ],
        },
      }),
    },
    {
      name: '`data:` with no space after the colon',
      exchange: sse([
        chunkFrame({ role: 'assistant', content: 'W', encrypted_content: 'opaque' }, null).replace(
          /^data: /,
          'data:',
        ),
        ...callWith({}, {}),
      ]),
    },
    {
      name: 'a last event with no line break after it',
      exchange: sse([
        ...callWith({}, {}).slice(0, 1),
        chunkFrame({ encrypted_content: 'opaque' }, null).trimEnd(),
      ]),
    },
    {
      // M6 不变量 10: the SDK decodes each line on its own, dropping one leading BOM per line, so an
      // event behind a BOM in the middle of the stream is one it reads.
      name: 'an event behind a byte-order mark in the middle of the stream (M6 不变量 10)',
      exchange: sse([
        chunkFrame({ role: 'assistant', content: 'W' }, null),
        `\uFEFF${chunkFrame({ content: 'Seen.', encrypted_content: 'opaque' }, null)}`,
        ...callWith({}, {}),
      ]),
    },
    {
      // M6 不变量 10: a '\r\n' split across two chunks is one line break, as the decoder reads it.
      name: 'a two-line event whose CRLF is split between chunks (M6 不变量 10)',
      exchange: sse([
        `data: {"id":"x","model":"${openAIFixture.RESPONSE_MODEL_ID}","choices":[{"index":0,"delta":\r`,
        '\ndata: {"role":"assistant","content":"R","encrypted_content":"opaque"}}]}\r\n\r\n',
        ...callWith({}, {}),
      ]),
    },
    {
      // M6 不变量 10: a CR that ended an event, held at a chunk edge in case a '\n' follows, still
      // ends that event when the next chunk brings no line break at all; it is not moved behind the
      // next event's data line, which would join the two into one payload that does not parse.
      name: 'an event-ending CR at a chunk edge followed by a chunk with no line break (M6 不变量 10)',
      exchange: sse([
        ...crOnlyFrames([chunkFrame({ role: 'assistant', content: 'W' }, null)]),
        chunkFrame({ content: 'Seen.', encrypted_content: 'opaque' }, null).replace(/\n\n$/, ''),
        '\r\r',
        ...crOnlyFrames(callWith({}, {})),
      ]),
    },
    {
      // M6 不变量 10: a lone CR is a line break to the decoder, so the checker splits on it too.
      name: 'CR-only line endings (M6 不变量 10)',
      exchange: sse(
        crOnlyFrames([
          chunkFrame({ role: 'assistant', content: 'W', encrypted_content: 'opaque' }, null),
          ...callWith({}, {}),
        ]),
      ),
    },
    {
      // M6 不变量 10: the decoder reads `choices?.[0]`, which finds a `choices` sent as an object
      // keyed "0" as well; the checker reads it there too.
      name: '`choices` sent as an object keyed "0" (M6 不变量 10)',
      exchange: sse([
        `data: ${JSON.stringify({
          id: 'x',
          model: openAIFixture.RESPONSE_MODEL_ID,
          choices: {
            0: { delta: { role: 'assistant', content: 'R', encrypted_content: 'opaque' } },
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'x',
          model: openAIFixture.RESPONSE_MODEL_ID,
          choices: {
            0: {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_t',
                    type: 'function',
                    function: { name: 'Read', arguments: doc.PROBE_PATH_ARGS },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    },
  ]
  for (const { name, exchange } of framings) {
    it(`finds an unknown field in ${name}`, async () => {
      const run = await probe(vendor('openai-chat'), [exchange, ANSWER])
      expect(run.snapshot).toMatchObject({
        outcome: 'failed',
        reason: 'opaque-fields',
        unknownFields: ['encrypted_content'],
      })
      expect(run.net.callCount).toBe(1)
    })
  }

  it('records no thinking field for empty thinking text, and echoes none in ②', async () => {
    const run = await probe(vendor('openai-chat'), [
      sse([chunkFrame({ role: 'assistant', reasoning_content: '' }, null), ...callWith({}, {})]),
      ANSWER,
    ])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', reasoningField: null })
    const assistant = messagesOf(run.bodies[1])[1]
    expect(assistant).not.toHaveProperty('reasoning_content')
    expect(assistant).not.toHaveProperty('reasoning')
  })

  it('takes reasoning_content over reasoning when a delta carries both', async () => {
    const run = await probe(vendor('openai-chat'), [
      sse([
        chunkFrame({ role: 'assistant', reasoning_content: 'First.', reasoning: 'Second.' }, null),
        ...callWith({}, {}),
      ]),
      ANSWER,
    ])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', reasoningField: 'reasoning_content' })
  })

  it('takes reasoning when reasoning_content is null beside it (the decoder’s `??`)', async () => {
    const run = await probe(vendor('openai-chat'), [
      sse([
        chunkFrame({ role: 'assistant', reasoning_content: null, reasoning: 'Thinking.' }, null),
        ...callWith({}, {}),
      ]),
      ANSWER,
    ])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', reasoningField: 'reasoning' })
    const assistant = messagesOf(run.bodies[1])[1]
    expect(assistant?.['reasoning']).toBe('Thinking.')
    expect(assistant).not.toHaveProperty('reasoning_content')
  })

  it('records no thinking field when reasoning_content is empty beside reasoning: the decoder reads the empty one', async () => {
    const run = await probe(vendor('openai-chat'), [
      sse([
        chunkFrame({ role: 'assistant', reasoning_content: '', reasoning: 'Thinking.' }, null),
        ...callWith({}, {}),
      ]),
      ANSWER,
    ])
    expect(run.snapshot).toMatchObject({ outcome: 'passed', reasoningField: null })
    const assistant = messagesOf(run.bodies[1])[1]
    expect(assistant).not.toHaveProperty('reasoning_content')
    expect(assistant).not.toHaveProperty('reasoning')
  })
})

describe('the checker stops where the decoder stops (§何时、走哪条路)', () => {
  const CALL_FRAMES = (CALL as { frames: readonly string[] }).frames
  const OPAQUE = chunkFrame({ encrypted_content: 'after-the-end' }, null)

  it('settles when the body stays open after [DONE]', async () => {
    const gate = createStreamGate()
    // Every frame of ①, [DONE] included, and then the body is never closed.
    gate.release(CALL_FRAMES.length)
    const run = await probe(vendor('openai-chat'), [
      { kind: 'sse', frames: CALL_FRAMES, gate },
      ANSWER,
    ])
    expect(run.snapshot).toEqual(snapshotOf({}))
    expect(run.net.callCount).toBe(2)
  })

  it('settles when the body stays open after a [DONE] ended by a lone CR', async () => {
    // CR-only line endings, and LF frames whose [DONE] ends in '\n\r': both leave the checker
    // holding a '\r' that may be half a CRLF, so only the adapter's own cancel can let it go.
    for (const framing of [crOnlyFrames, lfCrDoneFrames]) {
      // oxlint-disable-next-line no-await-in-loop -- one probe per framing
      const run = await probe(vendor('openai-chat'), [
        heldOpen(framing(CALL_FRAMES)),
        heldOpen(framing(ANSWER_FRAMES)),
      ])
      expect(run.snapshot).toEqual(snapshotOf({}))
      expect(run.net.callCount).toBe(2)
    }
  })

  it('judges no frame after [DONE], in the same chunk or a later one', async () => {
    const sameChunk = [...CALL_FRAMES.slice(0, -1), `${CALL_FRAMES.at(-1) ?? ''}${OPAQUE}`]
    const laterChunk = [...CALL_FRAMES, OPAQUE]
    for (const frames of [sameChunk, laterChunk]) {
      // oxlint-disable-next-line no-await-in-loop -- one probe per framing
      const run = await probe(vendor('openai-chat'), [sse(frames), ANSWER])
      expect(run.snapshot).toEqual(snapshotOf({}))
    }
  })

  it('settles a 200 stream that stalls before [DONE] at the idle watchdog, as service', async () => {
    const host = createMemoryHost({ now: NOW })
    const gate = createStreamGate()
    const net = fakeNetwork([{ kind: 'sse', frames: CALL_FRAMES, gate }])
    const d = vendor('openai-chat')
    let settled = false
    const running = probeModel(
      query(d, net, customVendorDefinition(d), { clock: host.clock }),
    ).finally(() => {
      settled = true
    })
    // The role chunk and the text; never the call, the finish or [DONE].
    gate.release(2)
    await waitFor(() => net.callCount === 1)
    await flush()
    host.advance(IDLE_MS_OTHER - 1)
    await flush()
    expect(settled).toBe(false)
    host.advance(1)
    expect(await running).toMatchObject({ outcome: 'failed', reason: 'service' })
    expect(net.callCount).toBe(1)
  })

  it('waits for no byte the adapter did not read, even where the host ignores the abort', async () => {
    const host = createMemoryHost({ now: NOW })
    const gate = createStreamGate()
    const net = fakeNetwork([{ kind: 'sse', frames: CALL_FRAMES, gate }])
    // The body outlives the SDK's own abort at the watchdog: only the checker's bound ends its side.
    const deaf: HostNetwork = {
      fetch: (input, init) => net.fetch(input, { ...init, signal: null }),
      fetchUntrusted: net.fetchUntrusted,
    }
    const d = vendor('openai-chat')
    const running = probeModel(
      query(d, net, customVendorDefinition(d), { clock: host.clock, network: deaf }),
    )
    gate.release(2)
    await waitFor(() => net.callCount === 1)
    await flush()
    host.advance(IDLE_MS_OTHER)
    expect(await running).toMatchObject({ outcome: 'failed', reason: 'service' })
  })

  it('settles a 400 whose body stalls at the idle watchdog, as the refusal it is', async () => {
    const host = createMemoryHost({ now: NOW })
    const gate = createStreamGate()
    const net = fakeNetwork([
      {
        kind: 'sse',
        status: 400,
        headers: { 'content-type': 'application/json' },
        frames: ['{"error":{"message":"tools are not', ' supported"}}'],
        gate,
      },
    ])
    const d = vendor('openai-chat')
    const running = probeModel(query(d, net, customVendorDefinition(d), { clock: host.clock }))
    gate.release(1)
    await waitFor(() => net.callCount === 1)
    await flush()
    host.advance(IDLE_MS_OTHER)
    expect(await running).toMatchObject({ outcome: 'failed', reason: 'request-rejected' })
    expect(net.callCount).toBe(1)
  })
})

describe('the anthropic-messages wire (Q2)', () => {
  it('按文档、未实测 Anthropic Messages: passes, sending a signed thinking block back verbatim in ②', async () => {
    const d = vendor('anthropic-messages')
    const run = await probe(d, [
      sse(doc.anthropicCallFrames('vendor-model', doc.ANTHROPIC_SIGNATURE)),
      sse(doc.anthropicAnswerFrames('vendor-model')),
    ])
    expect(run.snapshot).toEqual(
      snapshotOf({ maxTokensField: null, responseModelId: 'vendor-model' }),
    )
    expect(run.net.requests.map((request) => request.url)).toEqual([
      `${ANTHROPIC_BASE}/v1/messages`,
      `${ANTHROPIC_BASE}/v1/messages`,
    ])
    expect(run.net.requests[0]?.headers['x-api-key']).toBe(KEY)
    expect(run.net.requests[0]?.headers).not.toHaveProperty('authorization')
    const [, assistant, results] = messagesOf<{ content: unknown[] }>(run.bodies[1])
    expect(assistant?.content[0]).toEqual({
      type: 'thinking',
      thinking: doc.ANTHROPIC_THINKING,
      signature: doc.ANTHROPIC_SIGNATURE,
    })
    expect(results?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_probe_fixture',
        content: [{ type: 'text', text: 'ok' }],
        is_error: false,
      },
    ])
  })

  it('按文档、未实测 Bailian: drops an empty signature and still passes', async () => {
    const run = await probe(vendor('anthropic-messages'), [
      sse(doc.anthropicCallFrames('vendor-model', '')),
      sse(doc.anthropicAnswerFrames('vendor-model')),
    ])
    expect(run.snapshot.outcome).toBe('passed')
    const assistant = messagesOf<{ content: { type: string }[] }>(run.bodies[1])[1]
    expect(assistant?.content.map((block) => block.type)).toEqual(['tool_use'])
  })

  it('按文档、未实测 Anthropic Messages: takes a ① that stops on max_tokens as output-limit, even with a complete tool_use in it (§结果与原因码)', async () => {
    // This wire's decoder keeps a finished tool_use block on max_tokens, so the stop is judged first.
    const cut = doc
      .anthropicCallFrames('vendor-model', doc.ANTHROPIC_SIGNATURE)
      .map((frame) => frame.replace('"stop_reason":"tool_use"', '"stop_reason":"max_tokens"'))
    const run = await probe(vendor('anthropic-messages'), [
      sse(cut),
      sse(doc.anthropicAnswerFrames('vendor-model')),
    ])
    expect(run.snapshot).toMatchObject({ outcome: 'not-detected', reason: 'output-limit' })
    expect(run.net.callCount).toBe(1)
  })

  it('按文档、未实测 Anthropic Messages: takes a ① tool_use whose input is not a JSON object as bad-tool-call, as on openai-chat (§结果与原因码)', async () => {
    const garbled = doc
      .anthropicCallFrames('vendor-model', doc.ANTHROPIC_SIGNATURE)
      .map((frame) =>
        frame.replace(JSON.stringify(doc.PROBE_PATH_ARGS), JSON.stringify('{"file_path":')),
      )
    expect(garbled.join('')).not.toContain(JSON.stringify(doc.PROBE_PATH_ARGS))
    const run = await probe(vendor('anthropic-messages'), [
      sse(garbled),
      sse(doc.anthropicAnswerFrames('vendor-model')),
    ])
    expect(run.snapshot).toMatchObject({ outcome: 'failed', reason: 'bad-tool-call' })
    expect(run.net.callCount).toBe(1)
  })

  it('按文档、未实测 Anthropic Messages: a ① turn ② cannot encode is bad-tool-call, with no ② (§结果与原因码)', async () => {
    const frames = doc.anthropicCallFrames('vendor-model', doc.ANTHROPIC_SIGNATURE)
    // A tool_use input with a `toJSON` key.
    const withToJSON = frames.map((frame) =>
      frame.replace(
        JSON.stringify(doc.PROBE_PATH_ARGS),
        JSON.stringify(JSON.stringify({ ...PROBE_INPUT, toJSON: 1 })),
      ),
    )
    // A block of a type this wire does not map, kept whole for the echo, nested past 100 levels.
    const block = { type: 'vendor_widget', data: nested(110) }
    const withDeepBlock = [
      ...frames.slice(0, -2),
      anthropicEvent({ type: 'content_block_start', index: 2, content_block: block }),
      anthropicEvent({ type: 'content_block_stop', index: 2 }),
      ...frames.slice(-2),
    ]
    for (const script of [withToJSON, withDeepBlock]) {
      // oxlint-disable-next-line no-await-in-loop -- one probe per shape
      const run = await probe(vendor('anthropic-messages'), [
        sse(script),
        sse(doc.anthropicAnswerFrames('vendor-model')),
      ])
      expect(run.snapshot).toMatchObject({ outcome: 'failed', reason: 'bad-tool-call' })
      expect(run.net.callCount).toBe(1)
    }
  })
})

describe('an aborted probe (§何时、走哪条路)', () => {
  it('rejects before sending when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const net = fakeNetwork([CALL, ANSWER])
    const d = vendor('openai-chat')
    await expect(
      probeModel(query(d, net, customVendorDefinition(d), { signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // Even where the probe would have failed before sending anything: no snapshot at all.
    await expect(
      probeModel(
        query(d, net, customVendorDefinition(d), { signal: controller.signal, secrets: {} }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(net.callCount).toBe(0)
  })

  for (const step of ['①', '②'] as const) {
    it(`rejects, building no snapshot, when aborted during ${step}`, async () => {
      const controller = new AbortController()
      const gate = createStreamGate()
      const frames = step === '①' ? (CALL as { frames: readonly string[] }).frames : ANSWER_FRAMES
      const gated: FakeExchange = { kind: 'sse', frames, gate }
      const net = fakeNetwork(step === '①' ? [gated] : [CALL, gated])
      const d = vendor('openai-chat')
      const running = probeModel(
        query(d, net, customVendorDefinition(d), { signal: controller.signal }),
      )
      const settled = running.then(
        () => 'resolved',
        (error: unknown) => (error as Error).name,
      )
      // Let the request reach the wire and one frame arrive, then stop.
      gate.release(1)
      await waitFor(() => net.callCount === (step === '①' ? 1 : 2))
      controller.abort()
      expect(await settled).toBe('AbortError')
      expect(net.callCount).toBe(step === '①' ? 1 : 2)
    })
  }
})

/** ② of the generic script, as frames. */
const ANSWER_FRAMES = openAIFixture.turnFrames(['It said ok.'], [], 'stop')

/** A ① call whose stream reports no usage (the frames after the role chunk). */
const CALL_WITHOUT_USAGE: readonly string[] = [
  `data: ${JSON.stringify({
    id: 'x',
    model: openAIFixture.RESPONSE_MODEL_ID,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_nu',
              type: 'function',
              function: { name: 'Read', arguments: doc.PROBE_PATH_ARGS },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  })}\n\n`,
  'data: [DONE]\n\n',
]

/**
 * A turn whose first delta carries `extra` beside its content; with `call`, a ① that calls Read,
 * otherwise a ② that answers and stops.
 */
function withDelta(extra: Record<string, unknown>, call = false): readonly string[] {
  return [
    chunkFrame({ role: 'assistant', content: 'Working.', ...extra }, null),
    call
      ? chunkFrame(
          {
            tool_calls: [
              {
                index: 0,
                id: 'call_w',
                type: 'function',
                function: { name: 'Read', arguments: doc.PROBE_PATH_ARGS },
              },
            ],
          },
          'tool_calls',
        )
      : chunkFrame({ content: ' Done.' }, 'stop'),
    'data: [DONE]\n\n',
  ]
}

/** The frames with every line break a lone CR. */
function crOnlyFrames(frames: readonly string[]): string[] {
  return frames.map((frame) => frame.replaceAll('\n', '\r'))
}

/** The frames with the [DONE] event ended by '\n\r'. */
function lfCrDoneFrames(frames: readonly string[]): string[] {
  return frames.map((frame) => (frame === 'data: [DONE]\n\n' ? 'data: [DONE]\n\r' : frame))
}

/** Every frame delivered, and then the body is never closed. */
function heldOpen(frames: readonly string[]): FakeExchange {
  const gate = createStreamGate()
  gate.release(frames.length)
  return { kind: 'sse', frames, gate }
}

/** An OpenAI-shaped HTTP error with this status and code. */
function failing(status: number, code: string, message = code): FakeExchange {
  return {
    kind: 'json',
    status,
    body: { error: { code, message, type: 'invalid_request_error', param: null } },
  }
}

/** One chunk of the generic fixture model. */
function chunkFrame(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'x',
    model: openAIFixture.RESPONSE_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

/** A ① whose one Read call carries `extra` on the call and `fnExtra` on its function. */
function callWith(
  extra: Record<string, unknown>,
  fnExtra: Record<string, unknown>,
): readonly string[] {
  return [
    chunkFrame(
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_t',
            type: 'function',
            function: { name: 'Read', arguments: doc.PROBE_PATH_ARGS, ...fnExtra },
            ...extra,
          },
        ],
      },
      'tool_calls',
    ),
    'data: [DONE]\n\n',
  ]
}

/** The input of the call the probe's prompt asks for. */
const PROBE_INPUT = JSON.parse(doc.PROBE_PATH_ARGS) as Record<string, unknown>

/** An object nested `depth` levels deep. */
function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true }
  for (let level = 1; level < depth; level += 1) value = { a: value }
  return value
}

/** One anthropic-messages SSE event. */
function anthropicEvent(body: { type: string } & Record<string, unknown>): string {
  return `event: ${body.type}\ndata: ${JSON.stringify(body)}\n\n`
}

/** A request body's messages. */
function messagesOf<T = Record<string, unknown>>(body: Record<string, unknown> | undefined): T[] {
  return (body?.['messages'] ?? []) as T[]
}

/** The ids of an openai-chat assistant message's tool calls. */
function toolCallIds(message: Record<string, unknown> | undefined): string[] {
  return ((message?.['tool_calls'] ?? []) as { id: string }[]).map((call) => call.id)
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling until the request is out
    await flush()
  }
  if (!condition()) throw new Error('the condition never held')
}
