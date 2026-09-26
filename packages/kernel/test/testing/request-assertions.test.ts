/**
 * The request-body assertions of @tenon-app/kernel/testing, each proven on both halves: it passes
 * on well-formed bodies — the real encoders' output wherever an encoder can produce the shape — and
 * fails on every broken shape it exists to catch. Not tagged 「02 不变量 N」: these prove the helpers,
 * the kernel's invariant tests are the ones that use them.
 */
import { describe, expect, it } from 'vitest'
import {
  AnthropicMessagesProvider,
  encodeAnthropicMessages,
  encodeOpenAIChat,
} from '../../src/index.js'
import type {
  ContentBlock,
  EncodedRequest,
  InternalMessage,
  ProviderRequest,
  StreamEvent,
} from '../../src/index.js'
import {
  RequestAssertionError,
  assertHeaderNamesAllowed,
  assertImagesInline,
  assertLastTurnIsUser,
  assertToolPairing,
  fakeNetwork,
  requestWire,
} from '../../src/testing/index.js'
import type { RecordedRequest } from '../../src/testing/index.js'
import { PLAIN_TEXT_FRAMES } from '../provider/fixtures/anthropic-sse.js'
import {
  PNG_DATA,
  TOOL,
  anthropicModel,
  assistant,
  openAIModel,
  requestOf,
  user,
} from '../provider/wire/fixtures.js'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const OPENAI_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'

function recorded(
  url: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): RecordedRequest {
  const bodyText = body === null ? null : JSON.stringify(body)
  return { url, method: 'POST', headers, bodyText, body }
}

/** What the adapter would have POSTed for `req` on its wire. */
function sent(encoded: EncodedRequest, url: string): RecordedRequest {
  return recorded(url, JSON.parse(JSON.stringify(encoded.body)))
}

function call(id: string, path = '/tmp/a'): ContentBlock {
  return { type: 'tool-request', id, name: 'read_file', input: { path } }
}

function result(
  id: string,
  content: ContentBlock[] = [{ type: 'text', text: 'ok' }],
): ContentBlock {
  return {
    type: 'tool-response',
    id,
    content: content as Extract<ContentBlock, { type: 'text' | 'image' }>[],
    isError: false,
  }
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })
const image: ContentBlock = { type: 'image', mediaType: 'image/png', data: PNG_DATA }

/**
 * Two rounds: a parallel pair answered with trailing user text, then a single call answered. An
 * image rides in the first result only where the wire has a place for it (openai-chat refuses).
 */
function toolHistory(imageInResult = true): InternalMessage[] {
  const first = imageInResult ? [text('a body'), image] : [text('a body')]
  return [
    user(text('look at both files'), image),
    assistant(text('reading'), call('call_1'), call('call_2', '/tmp/b')),
    user(result('call_1', first), result('call_2'), text('and then?')),
    assistant(call('call_3')),
    user(result('call_3')),
  ]
}

function anthropicSent(messages: InternalMessage[] = toolHistory()): RecordedRequest {
  const req: ProviderRequest = requestOf(anthropicModel(), { tools: [TOOL], messages })
  return sent(encodeAnthropicMessages(req, 'anthropic'), ANTHROPIC_URL)
}

function openAISent(messages: InternalMessage[] = toolHistory(false)): RecordedRequest {
  const req: ProviderRequest = requestOf(openAIModel(), { tools: [TOOL], messages })
  return sent(encodeOpenAIChat(req, 'zhipu'), OPENAI_URL)
}

const useBlock = (id: string, extra: Record<string, unknown> = {}): unknown => ({
  type: 'tool_use',
  id,
  name: 'read_file',
  input: {},
  ...extra,
})
const resultBlock = (id: string): unknown => ({ type: 'tool_result', tool_use_id: id })
const textBlock = (value: string): unknown => ({ type: 'text', text: value })

function anthropicBody(...messages: [role: string, content: unknown][]): RecordedRequest {
  return recorded(ANTHROPIC_URL, {
    model: 'claude-test-4',
    messages: messages.map(([role, content]) => ({ role, content })),
  })
}

function openAIBody(...messages: unknown[]): RecordedRequest {
  return recorded(OPENAI_URL, { model: 'glm-test', messages })
}

const toolCall = (id: string, type = 'function'): unknown => ({
  id,
  type,
  function: { name: 'read_file', arguments: '{}' },
})
const toolMessage = (id: string): unknown => ({ role: 'tool', tool_call_id: id, content: 'ok' })

/** The problems a failing assertion reported, or a test failure when it passed. */
function problemsOf(assertion: () => void): readonly string[] {
  try {
    assertion()
  } catch (error) {
    if (error instanceof RequestAssertionError) return error.problems
    throw error
  }
  throw new Error('expected the assertion to fail, and it passed')
}

describe('requestWire', () => {
  it('reads the wire off the URL path', () => {
    expect(requestWire(recorded(ANTHROPIC_URL, null))).toBe('anthropic-messages')
    expect(requestWire(recorded('https://open.bigmodel.cn/api/anthropic/v1/messages', null))).toBe(
      'anthropic-messages',
    )
    expect(requestWire(recorded(OPENAI_URL, null))).toBe('openai-chat')
    expect(requestWire(recorded('http://127.0.0.1:11434/v1/chat/completions', null))).toBe(
      'openai-chat',
    )
    expect(requestWire(recorded('https://open.bigmodel.cn/api/paas/v4/web_search', null))).toBe(
      null,
    )
    expect(requestWire(recorded('not a url', null))).toBe(null)
  })
})

describe('assertToolPairing on anthropic-messages', () => {
  it('passes what the encoder sends for a paired history', () => {
    expect(() => assertToolPairing(anthropicSent())).not.toThrow()
  })

  it('passes results split from the next user text across consecutive user messages', () => {
    const body = anthropicBody(
      ['user', 'go'],
      ['assistant', [useBlock('t1'), useBlock('t2')]],
      ['user', [resultBlock('t1')]],
      ['user', [resultBlock('t2'), textBlock('next')]],
    )
    expect(() => assertToolPairing(body)).not.toThrow()
  })

  it('needs no result for calls the vendor runs', () => {
    const body = anthropicBody(
      ['user', 'go'],
      [
        'assistant',
        [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
          { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'x', server_name: 's', input: {} },
          useBlock('t_code', { caller: { type: 'code_execution_20250825', tool_id: 'srv' } }),
          useBlock('t_direct', { caller: { type: 'direct' } }),
        ],
      ],
      ['user', [resultBlock('t_direct'), textBlock('next')]],
    )
    expect(() => assertToolPairing(body)).not.toThrow()
  })

  it('fails a call with no result before the next user text', () => {
    const body = anthropicBody(['user', 'go'], ['assistant', [useBlock('t1')]], ['user', 'next'])
    expect(problemsOf(() => assertToolPairing(body))).toEqual([
      'messages[1]: tool_use t1 has no result before the next user text',
    ])
  })

  it('fails a call the request ends on', () => {
    const body = anthropicBody(['user', 'go'], ['assistant', [textBlock('hm'), useBlock('t1')]])
    expect(problemsOf(() => assertToolPairing(body))).toEqual([
      'messages[1]: tool_use t1 has no result before the next user text',
    ])
  })

  it('fails a call answered twice', () => {
    const body = anthropicBody(
      ['user', 'go'],
      ['assistant', [useBlock('t1')]],
      ['user', [resultBlock('t1'), resultBlock('t1')]],
    )
    expect(problemsOf(() => assertToolPairing(body))).toEqual([
      'messages[1]: tool_use t1 has 2 results',
    ])
  })

  it('fails a result placed after user text, in the same message or the next', () => {
    const same = anthropicBody(
      ['user', 'go'],
      ['assistant', [useBlock('t1')]],
      ['user', [textBlock('first'), resultBlock('t1')]],
    )
    expect(problemsOf(() => assertToolPairing(same))).toEqual([
      'messages[2].content[1]: tool_result t1 comes after user content at messages[2].content[0]',
    ])
    const next = anthropicBody(
      ['user', 'go'],
      ['assistant', [useBlock('t1')]],
      ['user', 'first'],
      ['user', [resultBlock('t1')]],
    )
    expect(problemsOf(() => assertToolPairing(next))).toEqual([
      'messages[3].content[0]: tool_result t1 comes after user content at messages[2].content[0]',
    ])
  })

  it('fails a result that answers no call right before it', () => {
    const stray = anthropicBody(['user', [resultBlock('ghost'), textBlock('hi')]])
    expect(problemsOf(() => assertToolPairing(stray))).toEqual([
      'messages[0].content[0]: tool_result ghost answers no tool_use of the assistant turn right before it',
    ])
    // Answering a call two turns back is not "right after" it: missing there, stray here.
    const late = anthropicBody(
      ['user', 'go'],
      ['assistant', [useBlock('t1')]],
      ['user', 'wait'],
      ['assistant', [textBlock('ok')]],
      ['user', [resultBlock('t1')]],
    )
    expect(problemsOf(() => assertToolPairing(late))).toEqual([
      'messages[1]: tool_use t1 has no result before the next user text',
      'messages[4].content[0]: tool_result t1 answers no tool_use of the assistant turn right before it',
    ])
  })

  it('fails a tool_use id used twice in one turn', () => {
    const body = anthropicBody(
      ['user', 'go'],
      ['assistant', [useBlock('t1'), useBlock('t1')]],
      ['user', [resultBlock('t1')]],
    )
    expect(problemsOf(() => assertToolPairing(body))).toEqual([
      'messages[1].content[1] repeats tool_use id t1',
    ])
  })
})

describe('assertToolPairing on openai-chat', () => {
  it('passes what the encoder sends for a paired history', () => {
    expect(() => assertToolPairing(openAISent())).not.toThrow()
  })

  it("needs no tool message for Zhipu's vendor-run mcp calls", () => {
    const body = openAIBody(
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [toolCall('m1', 'mcp'), toolCall('c1')] },
      toolMessage('c1'),
      { role: 'user', content: 'next' },
    )
    expect(() => assertToolPairing(body)).not.toThrow()
  })

  it('fails a call whose tool message comes after the next user message', () => {
    const body = openAIBody(
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [toolCall('c1')] },
      { role: 'user', content: 'next' },
      toolMessage('c1'),
    )
    expect(problemsOf(() => assertToolPairing(body))).toEqual([
      'messages[1]: tool_call c1 has no result before the next user text',
      'messages[3]: tool message c1 answers no tool_call of the assistant message right before its run of tool messages',
    ])
  })

  it('fails a call the request ends on, and one answered twice', () => {
    const ends = openAIBody(
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [toolCall('c1')] },
    )
    expect(problemsOf(() => assertToolPairing(ends))).toEqual([
      'messages[1]: tool_call c1 has no result before the next user text',
    ])
    const twice = openAIBody(
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [toolCall('c1')] },
      toolMessage('c1'),
      toolMessage('c1'),
    )
    expect(problemsOf(() => assertToolPairing(twice))).toEqual([
      'messages[1]: tool_call c1 has 2 results',
    ])
  })

  it('fails a tool message that answers no call, and a repeated call id', () => {
    const stray = openAIBody(
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'plain' },
      toolMessage('ghost'),
    )
    expect(problemsOf(() => assertToolPairing(stray))).toEqual([
      'messages[2]: tool message ghost answers no tool_call of the assistant message right before its run of tool messages',
    ])
    // A stray riding in a correctly paired run is still a stray; the paired result is not.
    const riding = openAIBody(
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [toolCall('c1')] },
      toolMessage('c1'),
      toolMessage('ghost'),
    )
    expect(problemsOf(() => assertToolPairing(riding))).toEqual([
      'messages[3]: tool message ghost answers no tool_call of the assistant message right before its run of tool messages',
    ])
    const repeated = openAIBody(
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [toolCall('c1'), toolCall('c1')] },
      toolMessage('c1'),
    )
    expect(problemsOf(() => assertToolPairing(repeated))).toEqual([
      'messages[1].tool_calls[1] repeats id c1',
    ])
  })
})

describe('assertToolPairing on what is not a model request', () => {
  it('throws rather than passing another path or a body without messages', () => {
    expect(
      problemsOf(() =>
        assertToolPairing(recorded('https://open.bigmodel.cn/api/paas/v4/web_search', {})),
      ),
    ).toEqual(['not a model request: the path ends in neither /messages nor /chat/completions'])
    expect(problemsOf(() => assertToolPairing(recorded(ANTHROPIC_URL, null)))).toEqual([
      'the body has no messages array',
    ])
  })
})

describe('assertToolPairing as a checkRequest behind a real provider', () => {
  const identity = {
    runId: '00000000-0000-4000-8000-000000000001',
    requestSeq: 1,
    physicalAttempt: 1,
  }

  async function streamed(messages: InternalMessage[]): Promise<{
    events: StreamEvent[]
    failures: readonly unknown[]
  }> {
    const net = fakeNetwork(
      { kind: 'sse', frames: PLAIN_TEXT_FRAMES },
      {
        checkRequest: assertToolPairing,
      },
    )
    const provider = new AnthropicMessagesProvider({
      id: 'anthropic',
      network: net,
      clock: { now: () => 0 },
      apiKey: 'test-key-not-a-real-credential',
      authToken: null,
      baseURL: 'https://api.anthropic.com',
      models: [anthropicModel()],
    })
    const req = requestOf(anthropicModel(), { tools: [TOOL], messages })
    const events: StreamEvent[] = []
    for await (const event of provider.stream(provider.encode(req), { identity })) {
      events.push(event)
    }
    return { events, failures: net.checkFailures }
  }

  it('records nothing for a paired history', async () => {
    const { failures } = await streamed(toolHistory())
    expect(failures).toEqual([])
  })

  it('records the unpaired call while the reply still streams to its end', async () => {
    const { events, failures } = await streamed([
      user(text('go')),
      assistant(call('call_1')),
      user(text('never mind')),
    ])
    expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'end-turn' })
    expect(failures).toHaveLength(1)
    expect((failures[0] as RequestAssertionError).problems).toEqual([
      'messages[1]: tool_use call_1 has no result before the next user text',
    ])
  })
})

describe('assertLastTurnIsUser', () => {
  it('passes a request that ends on a user turn, a tool-result turn included', () => {
    expect(() => assertLastTurnIsUser(anthropicSent())).not.toThrow()
    // On openai-chat the trailing user turn of results is a run of `tool` messages.
    expect(() => assertLastTurnIsUser(openAISent())).not.toThrow()
    expect(() =>
      assertLastTurnIsUser(openAISent([user(text('hi')), assistant(text('yo')), user(text('hm'))])),
    ).not.toThrow()
  })

  it('fails a request that ends on the assistant, or has no messages', () => {
    expect(
      problemsOf(() => assertLastTurnIsUser(anthropicBody(['user', 'go'], ['assistant', 'pre']))),
    ).toEqual(['messages[1] is "assistant", not a user turn'])
    expect(
      problemsOf(() =>
        assertLastTurnIsUser(
          openAIBody({ role: 'system', content: 's' }, { role: 'assistant', content: 'pre' }),
        ),
      ),
    ).toEqual(['messages[1] is "assistant", not a user turn'])
    // `tool` is a user turn only where the wire has that role.
    expect(
      problemsOf(() => assertLastTurnIsUser(anthropicBody(['user', 'go'], ['tool', 'x']))),
    ).toEqual(['messages[1] is "tool", not a user turn'])
    expect(problemsOf(() => assertLastTurnIsUser(openAIBody()))).toEqual(['there are no messages'])
  })
})

describe('assertHeaderNamesAllowed', () => {
  const request = recorded(ANTHROPIC_URL, null, {
    'content-type': 'application/json',
    'x-api-key': 'sk-ant-secret-value',
    'x-stainless-os': 'MacOS',
  })

  it('passes names inside a set, a list in any casing, or a predicate', () => {
    const names = ['content-type', 'x-api-key', 'x-stainless-os']
    expect(() => assertHeaderNamesAllowed(request, new Set(names))).not.toThrow()
    expect(() =>
      assertHeaderNamesAllowed(request, ['Content-Type', 'X-Api-Key', 'X-Stainless-OS']),
    ).not.toThrow()
    expect(() =>
      assertHeaderNamesAllowed(
        request,
        (name) =>
          name.startsWith('x-stainless-') || name === 'x-api-key' || name === 'content-type',
      ),
    ).not.toThrow()
  })

  it('fails every name outside the set, naming it but never its value', () => {
    let message = ''
    const problems = problemsOf(() => {
      try {
        assertHeaderNamesAllowed(request, ['content-type'])
      } catch (error) {
        message = (error as Error).message
        throw error
      }
    })
    expect(problems).toEqual([
      'header x-api-key is not allowed',
      'header x-stainless-os is not allowed',
    ])
    expect(message).not.toContain('sk-ant-secret-value')
  })
})

describe('assertImagesInline', () => {
  it('passes base64 images and data: URLs, tool results included', () => {
    expect(() => assertImagesInline(anthropicSent())).not.toThrow()
    expect(() => assertImagesInline(openAISent())).not.toThrow()
    expect(() => assertImagesInline(recorded(ANTHROPIC_URL, null))).not.toThrow()
  })

  it('fails an Anthropic image by url or by file, wherever it sits', () => {
    const body = anthropicBody(
      [
        'user',
        [
          { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
          { type: 'image', source: { type: 'file', file_id: 'file_1' } },
        ],
      ],
      ['assistant', [useBlock('t1')]],
      [
        'user',
        [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://example.test/b.png' } },
            ],
          },
        ],
      ],
    )
    expect(problemsOf(() => assertImagesInline(body))).toEqual([
      'body.messages[0].content[0]: image source is "url", not base64',
      'body.messages[0].content[1]: image source is "file", not base64',
      'body.messages[2].content[0].content[0]: image source is "url", not base64',
    ])
  })

  it('fails an OpenAI image_url that is not a data: URL', () => {
    const body = openAIBody({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
        { type: 'image_url', image_url: 'http://example.test/b.png' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_DATA}` } },
      ],
    })
    expect(problemsOf(() => assertImagesInline(body))).toEqual([
      'body.messages[0].content[0]: image_url is not a data: URL',
      'body.messages[0].content[1]: image_url is not a data: URL',
    ])
  })
})
