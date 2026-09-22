/**
 * The Anthropic Messages body, block by block. The golden body below is small and hand-checked
 * against the documented wire format (top-level `model` / `max_tokens` / `system` / `messages` /
 * `tools` / `thinking`, content blocks `text` / `thinking` / `redacted_thinking` / `tool_use` /
 * `tool_result` / `image`), so a later edit that renames a wire key has to change it here too.
 */
import { describe, expect, it } from 'vitest'
import {
  ProviderInvalidArgumentError,
  canonicalJson,
  encodeAnthropicMessages,
} from '../../../src/index.js'
import type { ContentBlock, ProviderRequest } from '../../../src/index.js'
import {
  PNG_DATA,
  REDACTED_DATA,
  SIGNATURE,
  TOOL,
  anthropicModel,
  assistant,
  redactedBlock,
  requestOf,
  thinkingBlock,
  user,
} from './fixtures.js'

function bodyOf(req: ProviderRequest, providerId = 'anthropic'): Record<string, unknown> {
  return encodeAnthropicMessages(req, providerId).body as Record<string, unknown>
}

describe('encodeAnthropicMessages', () => {
  it('builds the documented body', () => {
    const body = bodyOf({
      model: anthropicModel(),
      system: 'You are terse.',
      temperature: 0.2,
      maxTokens: 2048,
      thinking: { enabled: true, budgetTokens: 1024 },
      tools: [TOOL],
      messages: [
        user({ type: 'text', text: 'read it' }),
        assistant(thinkingBlock(), {
          type: 'tool-request',
          id: 'toolu_1',
          name: 'read_file',
          input: {},
        }),
        user({
          type: 'tool-response',
          id: 'toolu_1',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'image', mediaType: 'image/png', data: PNG_DATA },
          ],
          isError: true,
        }),
      ],
    })
    expect(body).toEqual({
      model: 'claude-test-4',
      max_tokens: 2048,
      stream: true,
      system: 'You are terse.',
      temperature: 0.2,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      tools: [{ name: 'read_file', description: 'Reads a file.', input_schema: TOOL.inputSchema }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'weighing the options', signature: SIGNATURE },
            // Invariant 6 on the way out: `{}`, never null and never a JSON string.
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              is_error: true,
              content: [
                { type: 'text', text: 'ok' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: PNG_DATA },
                },
              ],
            },
          ],
        },
      ],
    })
  })

  it('carries the stream flag inside the hashed body', () => {
    // The endpoint needs it to answer with SSE and the adapter sends the body unchanged, so it
    // belongs to what promptHash covers: what was hashed is what goes out (spec §接口).
    expect(bodyOf(requestOf(anthropicModel())).stream).toBe(true)
  })

  it('writes only the optional keys the request carried', () => {
    const body = bodyOf(requestOf(anthropicModel()))
    for (const key of ['system', 'temperature', 'thinking', 'tools']) {
      expect(Object.hasOwn(body, key)).toBe(false)
    }
    expect(body).toEqual({
      model: 'claude-test-4',
      max_tokens: 8192,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })
  })

  it('treats an empty system prompt as no system prompt', () => {
    expect(Object.hasOwn(bodyOf(requestOf(anthropicModel(), { system: '' })), 'system')).toBe(false)
  })

  it('omits the thinking key unless thinking is enabled', () => {
    const disabled = bodyOf(requestOf(anthropicModel(), { thinking: { enabled: false } }))
    expect(Object.hasOwn(disabled, 'thinking')).toBe(false)
  })

  it('refuses thinking with no budget, which this wire requires', () => {
    expect(() => bodyOf(requestOf(anthropicModel(), { thinking: { enabled: true } }))).toThrow(
      ProviderInvalidArgumentError,
    )
  })

  it('refuses a thinking budget outside the documented bounds', () => {
    // The documented form: an integer, at least 1024, and strictly below max_tokens. Each of these
    // is a 400 this pure function can see coming, and max_tokens can come from an environment
    // variable that moves independently of the budget.
    for (const budgetTokens of [1023, 0, -5, 1024.5, 2048, 4096]) {
      expect(() =>
        bodyOf(
          requestOf(anthropicModel(), {
            maxTokens: 2048,
            thinking: { enabled: true, budgetTokens },
          }),
        ),
      ).toThrow(ProviderInvalidArgumentError)
    }
    const body = bodyOf(
      requestOf(anthropicModel(), {
        maxTokens: 2048,
        thinking: { enabled: true, budgetTokens: 1024 },
      }),
    )
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
  })

  it('refuses a model that belongs to another provider', () => {
    expect(() => bodyOf(requestOf(anthropicModel()), 'zhipu')).toThrow(ProviderInvalidArgumentError)
  })
})

describe('encodeAnthropicMessages and the thinking guard', () => {
  it('replays a signed block and its redacted sibling as stored', () => {
    const body = bodyOf({
      model: anthropicModel(),
      messages: [assistant(thinkingBlock(), redactedBlock())],
    })
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'weighing the options', signature: SIGNATURE },
          { type: 'redacted_thinking', data: REDACTED_DATA },
        ],
      },
    ])
  })

  it('replays a signed block whose text is empty', () => {
    // The signature is what makes the block replayable; splitting it from its (empty) text would
    // be exactly the rewrite invariant 7 forbids.
    const body = bodyOf({
      model: anthropicModel(),
      messages: [assistant(thinkingBlock({ text: '' }))],
    })
    expect(body.messages).toEqual([
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: SIGNATURE }] },
    ])
  })

  it('downgrades to a text block and skips a downgrade with no text', () => {
    const model = anthropicModel({ thinkingPreservationFormat: 'text-only' })
    expect(
      bodyOf({ model, messages: [assistant(thinkingBlock(), { type: 'text', text: 'done' })] })
        .messages,
    ).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'weighing the options' },
          { type: 'text', text: 'done' },
        ],
      },
    ])
    expect(
      bodyOf({
        model,
        messages: [assistant(thinkingBlock({ text: '' }), { type: 'text', text: 'done' })],
      }).messages,
    ).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }])
  })

  it('omits a message that is empty after the guard and leaves the turns adjacent', () => {
    // An empty assistant turn is a 400 here, so the turn goes away entirely. The two user turns
    // then sit next to each other: the API combines consecutive same-role turns, and merging or
    // padding them in the encoder would invent content no fact records.
    const body = bodyOf({
      model: anthropicModel({ thinkingPreservationFormat: 'drop' }),
      messages: [
        user({ type: 'text', text: 'first' }),
        assistant(thinkingBlock(), redactedBlock()),
        user({ type: 'text', text: 'second' }),
      ],
    })
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ])
  })

  it('refuses to echo, because this wire has no reasoning field', () => {
    const model = anthropicModel({
      thinkingPreservationFormat: 'reasoning-content',
      reasoningEchoField: 'reasoning_content',
    })
    expect(() => bodyOf({ model, tools: [TOOL], messages: [assistant(thinkingBlock())] })).toThrow(
      ProviderInvalidArgumentError,
    )
  })
})

describe('encodeAnthropicMessages content rules', () => {
  it('skips empty text blocks, which the API rejects', () => {
    const body = bodyOf({
      model: anthropicModel(),
      messages: [user({ type: 'text', text: '' }, { type: 'text', text: 'kept' })],
    })
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'kept' }] }])
  })

  it('omits a tool result’s content when nothing survived', () => {
    const body = bodyOf({
      model: anthropicModel(),
      messages: [
        assistant({ type: 'tool-request', id: 'toolu_1', name: 'read_file', input: {} }),
        user({ type: 'tool-response', id: 'toolu_1', content: [], isError: false }),
      ],
    })
    expect((body.messages as { content: unknown[] }[])[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false },
    ])
  })

  it('refuses a tool call whose input is not an object (invariant 6)', () => {
    // `input: null` would travel as `input: null`, which is exactly what invariant 6 forbids; a
    // transcript read back from the Tape is data, so the type alone does not settle it.
    const block = {
      type: 'tool-request',
      id: 'toolu_1',
      name: 'read_file',
      input: null,
    } as unknown as ContentBlock
    expect(() => bodyOf({ model: anthropicModel(), messages: [assistant(block)] })).toThrow(
      ProviderInvalidArgumentError,
    )
  })

  it('refuses a tool response no earlier tool request asked for', () => {
    expect(() =>
      bodyOf({
        model: anthropicModel(),
        messages: [
          user({ type: 'tool-response', id: 'toolu_missing', content: [], isError: false }),
        ],
      }),
    ).toThrow(ProviderInvalidArgumentError)
  })

  it('refuses a block in a role this API has no union member for', () => {
    // The user-turn content union has no `tool_use` and no `thinking`; the assistant-turn union has
    // no `tool_result` and no `image`. A transcript read back from the Tape is data, so each of
    // these encodes cleanly unless the encoder checks — and 400s on the wire.
    const call: ContentBlock = { type: 'tool-request', id: 'toolu_1', name: 'read_file', input: {} }
    const result: ContentBlock = {
      type: 'tool-response',
      id: 'toolu_1',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }
    const image: ContentBlock = { type: 'image', mediaType: 'image/png', data: PNG_DATA }
    const cases: readonly ProviderRequest[] = [
      { model: anthropicModel(), messages: [user(call)] },
      { model: anthropicModel(), messages: [assistant(call), assistant(result)] },
      { model: anthropicModel(), messages: [user(thinkingBlock())] },
      { model: anthropicModel(), messages: [assistant(image)] },
      // The same guard is what keeps a tool result out of the message that declared the call.
      { model: anthropicModel(), messages: [assistant(call, result)] },
    ]
    for (const req of cases) {
      expect(() => bodyOf(req)).toThrow(ProviderInvalidArgumentError)
    }
  })

  it('refuses a request with no message left to send', () => {
    // Both vendors require at least one message, whether the caller sent none or the thinking
    // guard emptied every turn there was.
    expect(() => bodyOf({ model: anthropicModel(), messages: [] })).toThrow(
      ProviderInvalidArgumentError,
    )
    expect(() =>
      bodyOf({
        model: anthropicModel({ thinkingPreservationFormat: 'drop' }),
        messages: [assistant(thinkingBlock(), redactedBlock())],
      }),
    ).toThrow(ProviderInvalidArgumentError)
  })

  it('refuses a media type this wire does not accept', () => {
    // The union keeps callers honest at compile time; a transcript read back from the Tape is
    // data, so the check is a runtime boundary too.
    const block = {
      type: 'image',
      mediaType: 'image/tiff',
      data: PNG_DATA,
    } as unknown as ContentBlock
    expect(() => bodyOf({ model: anthropicModel(), messages: [user(block)] })).toThrow(
      ProviderInvalidArgumentError,
    )
  })
})

describe('encodeAnthropicMessages and requestParams', () => {
  it('adds parameters verbatim without disturbing what the encoder wrote', () => {
    const model = anthropicModel({ requestParams: { top_k: 5, metadata: { user_id: 'u1' } } })
    const body = bodyOf(requestOf(model, { temperature: 0.2 }))
    expect(body.top_k).toBe(5)
    expect(body.metadata).toEqual({ user_id: 'u1' })
    // Purely additive: the escape hatch may say things the encoder does not, never contradict it.
    expect(body.temperature).toBe(0.2)
  })

  it('skips an undefined value rather than writing a key the body cannot carry', () => {
    const model = anthropicModel({ requestParams: { top_k: undefined } })
    const body = bodyOf(requestOf(model))
    expect(Object.hasOwn(body, 'top_k')).toBe(false)
    // And the body still hashes: canonicalJson refuses an undefined-valued key.
    expect(canonicalJson(body)).toContain('"model"')
  })

  it('refuses to let requestParams take over a key this wire reserves', () => {
    // Every key the encoder writes — `stream` included — plus the two the SDK moves out of the
    // body into headers. `system` / `temperature` / `thinking` / `tools` are also what the
    // `provider/attempt_completed` snapshot and `toolDefinitionsHash` are taken over: a table that
    // swapped one would leave the recorded fact describing a request nobody sent.
    for (const key of [
      'model',
      'messages',
      'max_tokens',
      'system',
      'tools',
      'temperature',
      'thinking',
      'stream',
      'user_profile_id',
      'workspace_id',
    ]) {
      const model = anthropicModel({ requestParams: { [key]: 'hijacked' } })
      expect(() => bodyOf(requestOf(model))).toThrow(ProviderInvalidArgumentError)
    }
  })

  it('refuses a parameter that assignment could not put on the body', () => {
    // A computed `__proto__` key is an own property of requestParams, but assigning it would set the
    // body's prototype instead of a key, so the parameter would silently never reach the wire.
    const model = anthropicModel({ requestParams: { ['__proto__']: { top_k: 5 } } })
    expect(() => bodyOf(requestOf(model))).toThrow(ProviderInvalidArgumentError)
  })
})
