/** Official, single-request search transports (spec 02 §搜索与抓取). */
import { anthropicDefinition } from '../../provider/definitions/anthropic.js'
import type { ModelInfo } from '../../provider/types.js'
import { allowedRequestInit } from '../../provider/wire/transport.js'
import type { SearchBackendDefinition, SearchHit, SearchOutcome } from './types.js'

export function prepareZhipuSearchQuery(query: string): { query: string; truncated: boolean } {
  const points = Array.from(query)
  return { query: points.slice(0, 70).join(''), truncated: points.length > 70 }
}

const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const failure = (code: string, message = code): SearchOutcome => ({ ok: false, code, message })

export const zhipuSearchDefinition: SearchBackendDefinition = {
  id: 'zhipu',
  create: ({ network, secrets }) => ({
    host: 'open.bigmodel.cn',
    domainFilter: false,
    prepareQuery: prepareZhipuSearchQuery,
    async search(req) {
      try {
        const credential = secrets['apiKey']?.trim() || secrets['authToken']?.trim()
        if (!credential) return failure('credentials-missing')
        const response = await network.fetch(
          'https://open.bigmodel.cn/api/paas/v4/web_search',
          allowedRequestInit(
            {
              method: 'POST',
              redirect: 'error',
              signal: req.signal,
              headers: {
                authorization: `Bearer ${credential}`,
              },
              body: JSON.stringify({
                search_query: req.query,
                search_engine: 'search_pro_quark',
                search_intent: false,
              }),
            },
            { names: ['authorization'], pinned: { 'content-type': 'application/json' } },
          ),
        )
        const data = objectOf(await response.json())
        const error = objectOf(data['error'])
        if (!response.ok || Object.keys(error).length > 0)
          return failure(
            String(error['code'] ?? response.status),
            String(error['message'] ?? response.statusText),
          )
        if (!Array.isArray(data['search_result'])) return failure('invalid-response')
        return {
          ok: true,
          hits: data['search_result'].map((raw: unknown): SearchHit => {
            const hit = objectOf(raw)
            const mapped: SearchHit = {
              title: typeof hit['title'] === 'string' ? hit['title'] : '',
              url: typeof hit['link'] === 'string' && hit['link'] !== '' ? hit['link'] : null,
            }
            if (typeof hit['content'] === 'string') mapped.snippet = hit['content']
            if (typeof hit['publish_date'] === 'string') mapped.publishedAt = hit['publish_date']
            return mapped
          }),
        }
      } catch (error) {
        return failure(
          req.signal.aborted ? 'aborted' : 'network-error',
          error instanceof Error ? error.message : String(error),
        )
      }
    },
  }),
}

export function selectAnthropicSearchModel(
  models: readonly ModelInfo[] = anthropicDefinition.builtinModels,
): ModelInfo | null {
  for (const id of ['claude-sonnet-5', 'claude-opus-5']) {
    const model = models.find(
      (candidate) => candidate.id === id && candidate.thinkingSpec?.forcedToolChoice !== false,
    )
    if (model !== undefined) return model
  }
  return null
}

/** maxTokens is owner-calibrated; this factory deliberately has no guessed default. */
export function createAnthropicSearchDefinition(args: {
  maxTokens: number
  models?: readonly ModelInfo[]
}): SearchBackendDefinition | null {
  const model = selectAnthropicSearchModel(args.models)
  if (model === null) return null
  return {
    id: 'anthropic',
    create: ({ network, secrets }) => ({
      host: 'api.anthropic.com',
      domainFilter: true,
      prepareQuery: (query) => ({ query, truncated: false }),
      async search(req) {
        try {
          if (!secrets['apiKey']?.trim() && !secrets['authToken']?.trim())
            return failure('credentials-missing')
          const response = await network.fetch(
            'https://api.anthropic.com/v1/messages',
            allowedRequestInit(
              {
                method: 'POST',
                redirect: 'error',
                signal: req.signal,
                headers: {
                  ...(secrets['apiKey']?.trim() ? { 'x-api-key': secrets['apiKey'].trim() } : {}),
                  ...(secrets['authToken']?.trim()
                    ? { authorization: `Bearer ${secrets['authToken'].trim()}` }
                    : {}),
                },
                body: JSON.stringify({
                  model: model.id,
                  max_tokens: args.maxTokens,
                  stream: false,
                  ...(model.id === 'claude-sonnet-5' ? { thinking: { type: 'disabled' } } : {}),
                  tools: [
                    {
                      type: 'web_search_20250305',
                      name: 'web_search',
                      max_uses: 1,
                      ...(req.allowedDomains === undefined
                        ? {}
                        : { allowed_domains: req.allowedDomains }),
                      ...(req.blockedDomains === undefined
                        ? {}
                        : { blocked_domains: req.blockedDomains }),
                    },
                  ],
                  tool_choice: { type: 'any' },
                  messages: [{ role: 'user', content: req.query }],
                }),
              },
              {
                names: ['authorization', 'x-api-key'],
                pinned: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
              },
            ),
          )
          const data: unknown = await response.json()
          if (!response.ok) {
            const error = objectOf(objectOf(data)['error'])
            return failure(
              String(error['type'] ?? response.status),
              String(error['message'] ?? response.statusText),
            )
          }
          return parseAnthropicSearchResponse(data)
        } catch (error) {
          return failure(
            req.signal.aborted ? 'aborted' : 'network-error',
            error instanceof Error ? error.message : String(error),
          )
        }
      },
    }),
  }
}

export function parseAnthropicSearchResponse(value: unknown): SearchOutcome {
  const data = objectOf(value)
  if (data['stop_reason'] === 'pause_turn') return failure('pause_turn')
  const blocks = Array.isArray(data['content']) ? data['content'] : []
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  let succeeded = false
  let firstError: string | undefined
  for (const raw of blocks) {
    const block = objectOf(raw)
    if (block['type'] !== 'web_search_tool_result') continue
    const content = block['content']
    if (!Array.isArray(content)) {
      firstError ??= String(objectOf(content)['error_code'] ?? 'invalid-response')
      continue
    }
    succeeded = true
    for (const rawHit of content) {
      const hit = objectOf(rawHit)
      if (
        hit['type'] !== 'web_search_result' ||
        typeof hit['url'] !== 'string' ||
        seen.has(hit['url'])
      )
        continue
      seen.add(hit['url'])
      hits.push({ title: typeof hit['title'] === 'string' ? hit['title'] : '', url: hit['url'] })
    }
  }
  return succeeded ? { ok: true, hits } : failure(firstError ?? 'no-search-result')
}
