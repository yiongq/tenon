/**
 * The OpenAI chat-completions body, block by block. The golden body below is small and
 * hand-checked against the documented wire format (`messages` with a leading `system`,
 * `tool_calls` with JSON-string `arguments`, `role: 'tool'` results keyed by `tool_call_id`,
 * `image_url` data URLs, `tools[].function`, `stream` plus `stream_options.include_usage`), so a
 * later edit that renames a wire key has to change it here too.
 */
import { describe, expect, it } from 'vitest'
import { ProviderInvalidArgumentError, encodeOpenAIChat } from '../../../src/index.js'
import type { ContentBlock, ProviderRequest } from '../../../src/index.js'
import {
  PNG_DATA,
  TOOL,
  assistant,
  openAIModel,
  redactedBlock,
  requestOf,
  thinkingBlock,
  user,
} from './fixtures.js'

function bodyOf(req: ProviderRequest, providerId = 'zhipu'): Record<string, unknown> {
  return encodeOpenAIChat(req, providerId).body as Record<string, unknown>
}

/** Same provider, same model as the fixture: the guard's source gate has to pass. */
function reasoningModel(field: 'reasoning_content' | 'reasoning' = 'reasoning_content') {
  return openAIModel({
    thinkingPreservationFormat: 'reasoning-content',
    reasoningEchoField: field,
  })
}

function echoed(overrides: Partial<Extract<ContentBlock, { type: 'thinking' }>> = {}) {
  return thinkingBlock({ provider: 'zhipu', providerModel: 'glm-test', ...overrides })
}

describe('encodeOpenAIChat', () => {
  it('builds the documented body', () => {
    const body = bodyOf({
      model: openAIModel(),
      system: 'You are terse.',
      temperature: 0.2,
      maxTokens: 512,
      tools: [TOOL],
      messages: [
        user(
          { type: 'text', text: 'read it' },
          { type: 'image', mediaType: 'image/png', data: PNG_DATA },
        ),
        assistant({ type: 'tool-request', id: 'call_1', name: 'read_file', input: {} }),
        user({
          type: 'tool-response',
          id: 'call_1',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      ],
    })
    expect(body).toEqual({
      model: 'glm-test',
      max_tokens: 512,
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Reads a file.',
            parameters: TOOL.inputSchema,
          },
        },
      ],
      messages: [
        { role: 'system', content: 'You are terse.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'read it' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_DATA}` } },
          ],
        },
        {
          role: 'assistant',
          // Invariant 6 on the way out: '{}' for empty input, never 'null'.
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      ],
    })
  })

  it('writes only the optional keys the request carried', () => {
    const body = bodyOf(requestOf(openAIModel({ usageNeedsOptIn: false })))
    expect(body).toEqual({
      model: 'glm-test',
      max_tokens: 4096,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
  })

  it('asks for usage only when the model needs the opt-in', () => {
    // Without it this wire reports no usage at all; with it the reading arrives in a trailing
    // chunk. `stream` is always true — the adapter's whole loop is the streamed shape.
    const optIn = bodyOf(requestOf(openAIModel({ usageNeedsOptIn: true })))
    expect(optIn.stream).toBe(true)
    expect(optIn.stream_options).toEqual({ include_usage: true })
    const plain = bodyOf(requestOf(openAIModel({ usageNeedsOptIn: false })))
    expect(plain.stream).toBe(true)
    expect(Object.hasOwn(plain, 'stream_options')).toBe(false)
  })

  it('treats an empty system prompt as no system prompt', () => {
    const body = bodyOf(requestOf(openAIModel(), { system: '' }))
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('serialises tool arguments as a JSON string with a deterministic key order', () => {
    const body = bodyOf({
      model: openAIModel(),
      messages: [
        assistant({
          type: 'tool-request',
          id: 'call_1',
          name: 'read_file',
          input: { path: '/tmp/a', encoding: 'utf8' },
        }),
      ],
    })
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"encoding":"utf8","path":"/tmp/a"}' },
          },
        ],
      },
    ])
  })

  it('refuses a model that belongs to another provider', () => {
    expect(() => bodyOf(requestOf(openAIModel()), 'ollama')).toThrow(ProviderInvalidArgumentError)
  })
})

describe('encodeOpenAIChat and the thinking guard', () => {
  it('echoes under either field name the model may declare', () => {
    for (const field of ['reasoning_content', 'reasoning'] as const) {
      const body = bodyOf({
        model: reasoningModel(field),
        tools: [TOOL],
        messages: [assistant(echoed(), { type: 'text', text: 'done' })],
      })
      expect(body.messages).toEqual([
        { role: 'assistant', content: 'done', [field]: 'weighing the options' },
      ])
    }
  })

  it('concatenates several echoed blocks of one turn in block order', () => {
    // One field per turn on this wire: the blocks were deltas of one field to begin with. With no
    // text and no tool calls left, the turn also needs the empty `content` this wire requires of
    // an assistant message — the echo field alone does not satisfy it.
    const body = bodyOf({
      model: reasoningModel(),
      tools: [TOOL],
      messages: [assistant(echoed({ text: 'first ' }), echoed({ text: 'second' }))],
    })
    expect(body.messages).toEqual([
      { role: 'assistant', content: '', reasoning_content: 'first second' },
    ])
  })

  it('keeps an echo-only turn alive with the empty content the wire requires', () => {
    // `content` is required on an assistant message unless it carries tool_calls, so an echo on its
    // own would otherwise be a message with neither. With a tool call present, none is needed.
    const withCall = bodyOf({
      model: reasoningModel(),
      tools: [TOOL],
      messages: [
        assistant(echoed(), { type: 'tool-request', id: 'call_1', name: 'read_file', input: {} }),
      ],
    })
    expect(withCall.messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
        reasoning_content: 'weighing the options',
      },
    ])
  })

  it('omits a turn the guard emptied and leaves the turns adjacent', () => {
    // This wire accepts consecutive same-role messages, and merging them would invent a turn
    // boundary no fact records.
    const body = bodyOf({
      model: openAIModel(),
      messages: [
        user({ type: 'text', text: 'first' }),
        assistant(thinkingBlock(), redactedBlock()),
        user({ type: 'text', text: 'second' }),
      ],
    })
    expect(body.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ])
  })

  it('refuses to replay a signed block, which this wire cannot carry', () => {
    const model = openAIModel({ thinkingPreservationFormat: 'signed-blocks' })
    expect(() => bodyOf({ model, messages: [assistant(echoed())] })).toThrow(
      ProviderInvalidArgumentError,
    )
  })

  it('refuses to echo for a model that declares no field name', () => {
    const model = openAIModel({ thinkingPreservationFormat: 'reasoning-content' })
    expect(() => bodyOf({ model, tools: [TOOL], messages: [assistant(echoed())] })).toThrow(
      ProviderInvalidArgumentError,
    )
  })
})

describe('encodeOpenAIChat content rules', () => {
  it('uses a bare string for one text part and the parts array otherwise', () => {
    // The string form is what every OpenAI-compatible endpoint accepts, ollama included.
    expect(bodyOf(requestOf(openAIModel())).messages).toEqual([{ role: 'user', content: 'hello' }])
    const parts = bodyOf({
      model: openAIModel(),
      messages: [user({ type: 'text', text: 'a' }, { type: 'text', text: 'b' })],
    })
    expect(parts.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    ])
  })

  it('emits tool results before the rest of their turn', () => {
    // The wire pairs each tool message with the tool_calls of the assistant message before it.
    const body = bodyOf({
      model: openAIModel(),
      messages: [
        assistant({ type: 'tool-request', id: 'call_1', name: 'read_file', input: {} }),
        user(
          { type: 'text', text: 'and now summarise' },
          {
            type: 'tool-response',
            id: 'call_1',
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
          },
        ),
      ],
    })
    expect((body.messages as { role: string }[]).map((message) => message.role)).toEqual([
      'assistant',
      'tool',
      'user',
    ])
  })

  it('refuses a tool response no earlier tool request asked for', () => {
    expect(() =>
      bodyOf({
        model: openAIModel(),
        messages: [user({ type: 'tool-response', id: 'call_x', content: [], isError: false })],
      }),
    ).toThrow(ProviderInvalidArgumentError)
  })

  it('refuses an image anywhere a user message cannot carry it', () => {
    const image: ContentBlock = { type: 'image', mediaType: 'image/png', data: PNG_DATA }
    // A tool message is text-only on this wire, and so is an assistant one.
    expect(() =>
      bodyOf({
        model: openAIModel(),
        messages: [
          assistant({ type: 'tool-request', id: 'call_1', name: 'read_file', input: {} }),
          user({ type: 'tool-response', id: 'call_1', content: [image], isError: false }),
        ],
      }),
    ).toThrow(ProviderInvalidArgumentError)
    expect(() => bodyOf({ model: openAIModel(), messages: [assistant(image)] })).toThrow(
      ProviderInvalidArgumentError,
    )
  })

  it('refuses a tool call whose input is not an object (invariant 6)', () => {
    // `arguments: 'null'` is exactly what invariant 6 forbids, and canonicalJson would produce it.
    const block = {
      type: 'tool-request',
      id: 'call_1',
      name: 'read_file',
      input: null,
    } as unknown as ContentBlock
    expect(() => bodyOf({ model: openAIModel(), messages: [assistant(block)] })).toThrow(
      ProviderInvalidArgumentError,
    )
  })

  it('refuses a tool call outside an assistant message', () => {
    // It has nowhere to go on this wire, and dropping it silently would leave the tool response
    // that follows referencing a call the endpoint never saw.
    expect(() =>
      bodyOf({
        model: openAIModel(),
        messages: [user({ type: 'tool-request', id: 'call_1', name: 'read_file', input: {} })],
      }),
    ).toThrow(ProviderInvalidArgumentError)
  })

  it('refuses a tool result outside a user message, which the hoist would reorder', () => {
    // A `tool` message answers the assistant message before it. Sharing a message with its own
    // call, the hoist would emit the answer BEFORE the tool_calls it answers — a body the wire
    // rejects — so the two halves have to sit in different turns.
    const call: ContentBlock = { type: 'tool-request', id: 'call_1', name: 'read_file', input: {} }
    const result: ContentBlock = {
      type: 'tool-response',
      id: 'call_1',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }
    expect(() => bodyOf({ model: openAIModel(), messages: [assistant(call, result)] })).toThrow(
      ProviderInvalidArgumentError,
    )
    expect(() =>
      bodyOf({ model: openAIModel(), messages: [assistant(call), assistant(result)] }),
    ).toThrow(ProviderInvalidArgumentError)
  })

  it('refuses a reasoning block outside an assistant message', () => {
    // Whatever the guard would do with it: echoing it on a user turn has no field, and downgrading
    // it to user text would put the model's reasoning in the user's mouth.
    for (const model of [
      reasoningModel(),
      openAIModel({ thinkingPreservationFormat: 'text-only' }),
    ]) {
      expect(() => bodyOf({ model, tools: [TOOL], messages: [user(echoed())] })).toThrow(
        ProviderInvalidArgumentError,
      )
    }
  })

  it('refuses a request with no message left to send', () => {
    expect(() => bodyOf({ model: openAIModel(), messages: [] })).toThrow(
      ProviderInvalidArgumentError,
    )
    // The leading system message is not a turn: a body carrying it alone has no conversation.
    expect(() =>
      bodyOf({
        model: openAIModel({ thinkingPreservationFormat: 'drop' }),
        system: 'You are terse.',
        messages: [assistant(thinkingBlock())],
      }),
    ).toThrow(ProviderInvalidArgumentError)
  })

  it('refuses a media type this wire does not accept', () => {
    const block = {
      type: 'image',
      mediaType: 'image/tiff',
      data: PNG_DATA,
    } as unknown as ContentBlock
    expect(() => bodyOf({ model: openAIModel(), messages: [user(block)] })).toThrow(
      ProviderInvalidArgumentError,
    )
  })
})

describe('encodeOpenAIChat and requestParams', () => {
  it('passes a vendor parameter through verbatim', () => {
    // This is how zhipu's non-OpenAI `thinking` parameter travels (spec 01 §内置 provider): this
    // encoder writes no `thinking` key, so the passthrough is the only thing that can.
    const model = openAIModel({
      requestParams: { thinking: { type: 'enabled' }, do_sample: true },
    })
    const body = bodyOf(requestOf(model, { temperature: 0.1 }))
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.do_sample).toBe(true)
    expect(body.temperature).toBe(0.1)
  })

  it('refuses to let requestParams take over a key this wire reserves', () => {
    // A vendor that spells the output limit differently sets its own key. `stream_options` is here
    // because `include_usage: false` on a `usageNeedsOptIn` model would silently empty the usage of
    // every attempt fact; `max_tokens`, `temperature` and `tools` because the request snapshot and
    // `toolDefinitionsHash` are taken over them.
    for (const key of [
      'model',
      'messages',
      'max_tokens',
      'stream',
      'stream_options',
      'temperature',
      'tools',
    ]) {
      const model = openAIModel({ requestParams: { [key]: 'hijacked' } })
      expect(() => bodyOf(requestOf(model))).toThrow(ProviderInvalidArgumentError)
    }
  })
})
