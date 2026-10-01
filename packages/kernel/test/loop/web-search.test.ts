/** WebSearch crosses permission, dispatch, result, persistence and spill boundaries. */
import { describe, expect, it } from 'vitest'
import {
  createMemoryHost,
  createMemoryTapeStore,
  prepareZhipuSearchQuery,
  zhipuSearchDefinition,
} from '../../src/index.js'
import type { ModelInfo, StreamEvent, SearchBackend, SearchHit } from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import { SPILL_THRESHOLD_CHARS } from '../../src/loop/spill.js'
import { searchDispatchCount } from '../../src/loop/batch.js'
import { grantKey } from '../../src/permission/grants.js'
import { fill } from '../../src/prompts/index.js'
import { SEARCH_TEXTS } from '../../src/tools/builtin/web-search.js'

const SESSION = '7c4e9a2e-6b3d-4a71-9f52-0c8de7a11b37'
const IDENTITY = { userId: 'fetch', tenantId: 'fetch', profileDir: '/tenon/fetch' }
const MODEL: ModelInfo = {
  id: 'fetch-model',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}
const USAGE = {
  inputTokens: 9,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}
function calls(...queries: string[]): StreamEvent[] {
  return [
    ...queries.flatMap((query, index): StreamEvent[] => [
      { type: 'tool-call-start', index, id: `fetch${index}`, name: 'WebSearch' },
      { type: 'tool-call-end', index, id: `fetch${index}`, name: 'WebSearch', input: { query } },
    ]),
    { type: 'usage', usage: USAGE },
    stopEvent('tool-use', 'tool_use'),
  ]
}
function harness(search: SearchBackend = backend()) {
  const memory = createMemoryHost({ identity: IDENTITY })
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL, search } })
  const service = createTestSessionService(
    {
      host: memory,
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
      log: () => {},
    },
    { tools: { WebSearch: 'real' } },
  )
  service.bindLoop(loop)
  return { memory, store, provider, loop, service }
}
function backend(
  host: SearchBackend['host'] = 'open.bigmodel.cn',
  hits: SearchHit[] = [],
  prepareQuery = prepareZhipuSearchQuery,
): SearchBackend & { queries: string[] } {
  const queries: string[] = []
  return {
    host,
    domainFilter: host === 'api.anthropic.com',
    prepareQuery,
    queries,
    search: async (q) => {
      queries.push(q.query)
      return { ok: true, hits }
    },
  }
}
type Harness = ReturnType<typeof harness>
const done = () => scriptedTurn({ deltas: ['Done'], usage: USAGE })
async function all(h: Harness) {
  return (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}
async function start(h: Harness, ...queries: string[]) {
  h.provider.script(calls(...queries))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'Fetch pages' })
  return h.loop.runEnded()
}
async function allow(h: Harness) {
  const pending = await h.service.currentPending({ sessionId: SESSION })
  if (pending?.waitKind !== 'approval') throw new Error('no approval')
  expect(
    await h.service.answer({
      kind: 'approval',
      sessionId: SESSION,
      requestId: pending.card.requestId,
      decision: 'allow',
      origin: null,
    }),
  ).toEqual({ status: 'applied' })
  return h.loop.runEnded()
}

async function card(h: Harness) {
  const pending = await h.service.currentPending({ sessionId: SESSION })
  if (pending?.waitKind !== 'approval') throw new Error('no card')
  return pending.card
}
function answer(h: Harness, requestId: string) {
  return h.service.answer({
    kind: 'approval',
    sessionId: SESSION,
    requestId,
    decision: 'allow',
    origin: null,
  })
}
function change(h: Harness, search: SearchBackend | null) {
  h.loop.connector.use({ provider: h.provider, model: MODEL, search })
}

describe('WebSearch approval, dispatch and persistence', () => {
  it('keeps original input but approves and sends the prepared query; preserves normalized URLs through spill', async () => {
    const search = backend('open.bigmodel.cn', [
      {
        title: 'First',
        url: 'https://EXAMPLE.com:443/a#one',
        snippet: 'x'.repeat(SPILL_THRESHOLD_CHARS + 1000),
      },
      { title: 'Repeat', url: 'https://example.com/a#two' },
      { title: 'Linkless', url: null },
      { title: 'Invalid', url: 'not a URL' },
    ])
    const h = harness(search)
    const query = '😀'.repeat(71)
    expect((await start(h, query)).reason.code).toBe('paused')
    expect((await card(h)).target).toEqual({
      type: 'search',
      host: search.host,
      query: '😀'.repeat(70),
    })
    expect(search.queries).toEqual([])
    h.provider.script(done())
    await allow(h)
    const facts = await all(h)
    expect(facts.find((e) => e.name === 'tool/call')?.payload['input']).toEqual({ query })
    expect(search.queries).toEqual(['😀'.repeat(70)])
    const result = facts.find((e) => e.name === 'tool/result')!
    expect(result.payload['searchHitUrls']).toEqual(['https://example.com/a'])
    expect(result.payload['spill']).toBeDefined()
    const spill = result.payload['spill'] as { file: string }
    const disk = new TextDecoder().decode(
      h.memory.files.get(`${IDENTITY.profileDir}/tool-output/${SESSION}/${spill.file}`),
    )
    expect(disk).toContain('Linkless')
    expect(disk).toContain('😀'.repeat(70))
    expect(facts.find((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
      state: 'completed',
      effect: 'external',
    })
    expect(facts.filter((e) => e.name === 'execution/dispatch_committed')).toHaveLength(1)
  })
  it('stores the session grant under grantKey’s search key for the backend host (验收 49)', async () => {
    const search = backend('open.bigmodel.cn')
    const h = harness(search)
    await start(h, 'query')
    h.provider.script(done())
    await allow(h)
    expect(
      (await all(h)).find((e) => e.name === 'tool/approval_resolved')?.payload['grant'],
    ).toEqual({
      scope: 'session',
      key: grantKey('builtin', 'WebSearch', { kind: 'search', host: search.host }),
    })
  })
  it.each(['1701', '1702', '1703'])(
    'returns Zhipu search error %s to the model as is_error, after one request (验收 48)',
    async (code) => {
      const network = fakeNetwork([
        { kind: 'json', body: { error: { code: Number(code), message: 'bad query' } } },
      ])
      const h = harness(zhipuSearchDefinition.create({ network, secrets: { apiKey: 'key' } }))
      await start(h, 'query')
      h.provider.script(done())
      expect((await allow(h)).reason).toEqual({ code: 'completed' })
      const facts = await all(h)
      expect(facts.find((e) => e.name === 'tool/result')?.payload).toMatchObject({
        isError: true,
        content: [
          { type: 'text', text: fill(SEARCH_TEXTS.failed, { code, message: 'bad query' }) },
        ],
      })
      expect(facts.find((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
        state: 'completed',
        source: null,
      })
      const sent = h.provider.requests.at(-1)?.body as { messages: { content: unknown }[] }
      expect(sent.messages.at(-1)?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool_result', tool_use_id: 'fetch0', is_error: true }),
        ]),
      )
      expect(network.requests).toHaveLength(1)
    },
  )
  it.each(['host', 'query'] as const)(
    'invalidates an old card when %s changes before allow',
    async (what) => {
      const initial = backend()
      const h = harness(initial)
      await start(h, 'query')
      const old = await card(h)
      const next = backend(what === 'host' ? 'api.anthropic.com' : initial.host, [], (query) => ({
        query: `${query}!`,
        truncated: true,
      }))
      change(h, next)
      expect(await answer(h, old.requestId)).toEqual({ status: 'stale' })
      const fresh = await card(h)
      expect(fresh.requestId).not.toBe(old.requestId)
      expect(fresh.target).toMatchObject({ host: next.host, query: 'query!' })
      expect(initial.queries).toEqual([])
      expect(next.queries).toEqual([])
      expect((await all(h)).filter((e) => e.name === 'tool/approval_resolved')).toEqual([])
      h.provider.script(done())
      await allow(h)
      expect(next.queries).toEqual(['query!'])
    },
  )
  it('still replaces a changed card when the destination already has a session grant', async () => {
    const a = backend('open.bigmodel.cn')
    const b = backend('api.anthropic.com')
    const h = harness(b)
    await start(h, 'first')
    h.provider.script(done())
    await allow(h)
    change(h, a)
    await start(h, 'second')
    const pending = await card(h)
    change(h, b)
    expect(await answer(h, pending.requestId)).toEqual({ status: 'stale' })
    expect((await card(h)).target).toMatchObject({ host: b.host })
    expect(b.queries).toEqual(['first'])
  })
  it.each(['host', 'query', 'missing'] as const)(
    'closes unavailable when %s changes after approval commits but before assembly',
    async (what) => {
      const a = backend()
      const h = harness(a)
      await start(h, 'query')
      const pending = await card(h)
      const held = h.loop.connector.holdAssemble()
      h.provider.script(done())
      const answered = answer(h, pending.requestId)
      await held.reached
      const b = backend(what === 'host' ? 'api.anthropic.com' : a.host, [], (query) => ({
        query: what === 'query' ? query + '!' : query,
        truncated: false,
      }))
      change(h, what === 'missing' ? null : b)
      held.release()
      expect(await answered).toEqual({ status: 'applied' })
      await h.loop.runEnded()
      const facts = await all(h)
      expect(facts.filter((e) => e.name === 'tool/approval_resolved')).toHaveLength(1)
      expect(facts.filter((e) => e.name === 'execution/dispatch_committed')).toEqual([])
      expect(facts.find((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
        state: 'not-run',
        source: 'tool-unavailable',
        effect: 'blocked',
      })
      expect(a.queries).toEqual([])
      expect(b.queries).toEqual([])
      expect(await h.service.currentPending({ sessionId: SESSION })).toBeNull()
    },
  )
  it.each(['missing-port', 'null'] as const)(
    'fails closed on %s when approving a frozen search',
    async (what) => {
      const search = backend()
      const h = harness(search)
      await start(h, 'query')
      if (what === 'null') change(h, null)
      else delete h.loop.connector.searchTarget
      h.provider.script(done())
      await allow(h)
      expect(search.queries).toEqual([])
      expect(
        (await all(h)).find((e) => e.name === 'execution/tool_outcome')?.payload['source'],
      ).toBe('tool-unavailable')
    },
  )
  it('recovery refreshes a changed target without assembling or requesting, and can recover the new card again', async () => {
    const h = harness()
    await start(h, 'query')
    const old = await card(h)
    const next = backend('api.anthropic.com')
    change(h, next)
    const before = h.loop.connector.calls.assemble
    await h.service.recover()
    const fresh = await card(h)
    expect(fresh.requestId).not.toBe(old.requestId)
    expect(fresh.target).toMatchObject({ host: next.host })
    await h.service.recover()
    expect((await card(h)).requestId).toBe(fresh.requestId)
    expect(h.loop.connector.calls.assemble).toBe(before)
    expect(next.queries).toEqual([])
  })
  it('stops in flight as aborted/external, with no backend retries', async () => {
    let reached!: () => void
    const started = new Promise<void>((resolve) => {
      reached = resolve
    })
    const search = backend()
    search.search = async ({ signal }) => {
      reached()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      return { ok: false, code: 'aborted', message: 'aborted' }
    }
    const h = harness(search)
    await start(h, 'query')
    const pending = await card(h)
    await answer(h, pending.requestId)
    await started
    await h.service.stop({ rootSessionId: SESSION })
    await h.loop.runEnded()
    expect((await all(h)).find((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
      state: 'aborted',
      source: 'stopped',
      effect: 'external',
    })
  })
  it('permits the 200th dispatch then rejects the 201st before permission without a stored counter', async () => {
    const search = backend()
    const h = harness(search)
    await start(h, 'query')
    const head = await h.store.head(SESSION)
    if (head === null) throw new Error('missing head')
    // Prior dispatched searches survive restarts. Quota counts facts, irrespective of outcomes.
    await h.store.append({
      sessionId: SESSION,
      incarnationId: head.incarnationId,
      entries: Array.from({ length: 199 }, (_, i) => ({
        name: 'execution/dispatch_committed',
        kind: 'event',
        provenanceKey: `execution:v1:dispatch:prior${i}:0:0`,
        sourceType: 'runtime_event',
        sourceId: `prior${i}`,
        sourceSeq: 0,
        payload: { name: 'WebSearch' },
        createdAt: i,
      })),
    })
    h.provider.script(calls('over-limit'))
    h.provider.script(done())
    await allow(h)
    const facts = await all(h)
    expect(search.queries).toEqual(['query'])
    expect(await searchDispatchCount({ readRange: h.store.readRange.bind(h.store) }, SESSION)).toBe(
      200,
    )
    expect(facts.filter((e) => e.name === 'execution/dispatch_committed')).toHaveLength(200)
    expect(facts.filter((e) => e.name === 'tool/permission_decided')).toHaveLength(1)
    expect(facts.findLast((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
      source: 'tool-unavailable',
      state: 'not-run',
      effect: 'blocked',
    })
    expect(JSON.stringify(facts.findLast((e) => e.name === 'tool/result')?.payload)).toContain(
      '200',
    )
  })
})

it('counts linked children once and follows a child back to the root, paging every tape', async () => {
  const h = harness()
  await start(h, 'q')
  const template = (await all(h))[0]!
  const entry = (name: string, payload: Record<string, unknown>) => ({ ...template, name, payload })
  const root = [
    entry('session/parent_link', { child: { sessionId: 'child' } }),
    entry('session/parent_link', { child: { sessionId: 'child' } }),
    entry('execution/dispatch_committed', { name: 'WebSearch' }),
  ]
  const child = [
    entry('session/profile_set', { profile: 'chat', subagentOf: { sessionId: 'root' } }),
    entry('execution/dispatch_committed', { name: 'WebSearch' }),
    entry('execution/dispatch_committed', { name: 'WebFetch' }),
  ]
  const readRange: Parameters<typeof searchDispatchCount>[0]['readRange'] = async (q) => {
    const list = q.sessionId === 'root' ? root : child
    const offset = q.fromEntryId ?? 0
    return {
      incarnationId: 'incarnation',
      entries: list.slice(offset, offset + 1),
      nextFromEntryId: offset + 1 < list.length ? offset + 1 : null,
    }
  }
  expect(await searchDispatchCount({ readRange }, 'root')).toBe(2)
  expect(await searchDispatchCount({ readRange }, 'child')).toBe(2)
})

it('recovery and allow query the paused Run provider even after the menu changes', async () => {
  const search = backend()
  const h = harness(search)
  await start(h, 'q')
  const providerIds: string[] = []
  h.loop.connector.searchTarget = (providerId, query) => {
    providerIds.push(providerId)
    return { host: search.host, ...search.prepareQuery(query) }
  }
  // Current selection is distinct from the frozen provider used for the waiting call.
  await h.service.selectModel({
    sessionId: SESSION,
    origin: null,
    choice: {
      providerId: 'different',
      modelId: 'other',
      effort: null,
    },
  })
  await h.service.recover()
  h.provider.script(done())
  await allow(h)
  expect(providerIds).toEqual([MODEL.providerId, MODEL.providerId])
})
