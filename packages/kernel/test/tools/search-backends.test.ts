import { describe, expect, it } from 'vitest'
import {
  anthropicDefinition,
  createAnthropicSearchDefinition,
  parseAnthropicSearchResponse,
  prepareZhipuSearchQuery,
  selectAnthropicSearchModel,
  zhipuSearchDefinition,
} from '../../src/index.js'
import { fakeNetwork } from '../../src/testing/index.js'
const signal = () => new AbortController().signal
const result = (content: unknown) => ({ type: 'web_search_tool_result', content })
const hit = (url: string) => ({
  type: 'web_search_result',
  title: url,
  url,
  encrypted_content: 'NEVER_KEEP',
})

describe('official search transports', () => {
  it('truncates by Unicode code points and sends only the Zhipu protocol fields to its official host', async () => {
    const network = fakeNetwork([
      {
        kind: 'json',
        body: {
          search_result: [{ title: 'one', link: '', content: 'snippet', publish_date: 'today' }],
        },
      },
    ])
    const backend = zhipuSearchDefinition.create({
      network,
      secrets: { apiKey: ' key ', authToken: 'other' },
    })
    const prepared = prepareZhipuSearchQuery('😀'.repeat(71))
    expect(prepared).toEqual({ query: '😀'.repeat(70), truncated: true })
    expect(prepareZhipuSearchQuery('😀'.repeat(70)).truncated).toBe(false)
    expect(await backend.search({ ...prepared, signal: signal() })).toEqual({
      ok: true,
      hits: [{ title: 'one', url: null, snippet: 'snippet', publishedAt: 'today' }],
    })
    const [request] = network.requests
    expect(request?.url).toBe('https://open.bigmodel.cn/api/paas/v4/web_search')
    expect(request?.body).toEqual({
      search_query: prepared.query,
      search_engine: 'search_pro_quark',
      search_intent: false,
    })
    expect(request?.headers).toEqual({
      authorization: 'Bearer key',
      'content-type': 'application/json',
    })
    expect(network.untrustedRequests).toEqual([])
  })
  it.each([1701, 1702, 1703, 429])('returns error %s without retry', async (code) => {
    const network = fakeNetwork([
      {
        kind: 'json',
        status: code === 429 ? 429 : 200,
        body: { error: { code, message: 'failed' } },
      },
    ])
    const backend = zhipuSearchDefinition.create({ network, secrets: { authToken: 'gateway' } })
    expect(await backend.search({ query: 'q', signal: signal() })).toEqual({
      ok: false,
      code: String(code),
      message: 'failed',
    })
    expect(network.requests).toHaveLength(1)
    expect(network.requests[0]?.headers['authorization']).toBe('Bearer gateway')
  })
  it('selects the first eligible fixed model, never a session model', () => {
    expect(selectAnthropicSearchModel()?.id).toBe('claude-sonnet-5')
    const models = anthropicDefinition.builtinModels.filter((m) => m.id !== 'claude-sonnet-5')
    expect(selectAnthropicSearchModel(models)?.id).toBe('claude-opus-5')
    expect(createAnthropicSearchDefinition({ maxTokens: 4096, models: [] })).toBeNull()
    expect(
      selectAnthropicSearchModel(
        anthropicDefinition.builtinModels.map((m) => ({
          ...m,
          thinkingSpec: { ...m.thinkingSpec!, forcedToolChoice: false },
        })),
      ),
    ).toBeNull()
  })
  it.each(['claude-sonnet-5', 'claude-opus-5'])(
    'sends one nonstream search request for %s',
    async (model) => {
      const network = fakeNetwork([
        { kind: 'json', body: { content: [result([hit('https://a.test')])] } },
      ])
      const definition = createAnthropicSearchDefinition({
        maxTokens: 4096,
        models: anthropicDefinition.builtinModels.filter((m) => m.id === model),
      })!
      const backend = definition.create({ network, secrets: { apiKey: 'key' } })
      expect(
        await backend.search({ query: 'q', allowedDomains: ['a.test'], signal: signal() }),
      ).toEqual({ ok: true, hits: [{ title: 'https://a.test', url: 'https://a.test' }] })
      expect(network.requests).toHaveLength(1)
      const request = network.requests[0]!
      expect(request.body).toEqual({
        model,
        max_tokens: 4096,
        stream: false,
        ...(model.includes('sonnet') ? { thinking: { type: 'disabled' } } : {}),
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 1,
            allowed_domains: ['a.test'],
          },
        ],
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: 'q' }],
      })
      expect(request.headers).toEqual({
        'x-api-key': 'key',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      })
      expect(
        JSON.stringify(
          parseAnthropicSearchResponse({ content: [result([hit('https://a.test')])] }),
        ),
      ).not.toContain('NEVER_KEEP')
    },
  )
  it('merges every successful block, ignores errors when any succeeded, and keeps an empty success', () => {
    const error = result({ type: 'web_search_tool_result_error', error_code: 'too_many_requests' })
    expect(
      parseAnthropicSearchResponse({
        content: [error, result([hit('https://a')]), result([hit('https://a'), hit('https://b')])],
      }),
    ).toEqual({
      ok: true,
      hits: [
        { title: 'https://a', url: 'https://a' },
        { title: 'https://b', url: 'https://b' },
      ],
    })
    expect(parseAnthropicSearchResponse({ content: [error, result([])] })).toEqual({
      ok: true,
      hits: [],
    })
    expect(
      parseAnthropicSearchResponse({ content: [error, result({ error_code: 'query_too_long' })] }),
    ).toMatchObject({ ok: false, code: 'too_many_requests' })
    expect(parseAnthropicSearchResponse({ content: [] })).toMatchObject({ ok: false })
    expect(
      parseAnthropicSearchResponse({
        stop_reason: 'pause_turn',
        content: [result([hit('https://a')])],
      }),
    ).toMatchObject({ ok: false, code: 'pause_turn' })
  })
  it('pins redirect:error and maps a thrown network error without another request', async () => {
    const modes: unknown[] = []
    const network = {
      fetch: async (_url: unknown, init?: RequestInit): Promise<Response> => {
        modes.push(init?.redirect)
        throw new Error('transport failure')
      },
      fetchUntrusted: async (): Promise<Response> => {
        throw new Error('wrong transport')
      },
    }
    for (const definition of [
      zhipuSearchDefinition,
      createAnthropicSearchDefinition({ maxTokens: 4096 })!,
    ]) {
      expect(
        // oxlint-disable-next-line no-await-in-loop -- each transport is checked independently
        await definition
          .create({ network, secrets: { apiKey: 'key' } })
          .search({ query: 'q', signal: signal() }),
      ).toMatchObject({ ok: false, code: 'network-error' })
    }
    expect(modes).toEqual(['error', 'error'])
  })
})

it('uses the provider credential headers independently after trimming and refuses blank credentials', async () => {
  const network = fakeNetwork([{ kind: 'json', body: { content: [result([])] } }])
  const definition = createAnthropicSearchDefinition({ maxTokens: 4096 })!
  await definition
    .create({ network, secrets: { apiKey: ' key ', authToken: ' token ' } })
    .search({ query: 'q', signal: signal() })
  expect(network.requests[0]?.headers).toMatchObject({
    'x-api-key': 'key',
    authorization: 'Bearer token',
  })
  for (const d of [zhipuSearchDefinition, definition]) {
    expect(
      // oxlint-disable-next-line no-await-in-loop -- each credential refusal is checked independently
      await d
        .create({ network, secrets: { apiKey: '  ', authToken: '\n' } })
        .search({ query: 'q', signal: signal() }),
    ).toMatchObject({ ok: false, code: 'credentials-missing' })
  }
  expect(network.requests).toHaveLength(1)
})
