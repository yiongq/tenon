/** WebFetch crosses permission, dispatch, result, persistence and spill boundaries. */
import { describe, expect, it } from 'vitest'
import { createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type { FetchLike, InspectorRegistration, ModelInfo, StreamEvent } from '../../src/index.js'
import {
  createCounterIds,
  createFakeInspector,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type { FakeExchange } from '../../src/testing/index.js'
import { SPILL_THRESHOLD_CHARS } from '../../src/loop/spill.js'
import { grantKey } from '../../src/permission/grants.js'

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
function calls(...urls: string[]): StreamEvent[] {
  return [
    ...urls.flatMap((url, index): StreamEvent[] => [
      { type: 'tool-call-start', index, id: `fetch${index}`, name: 'WebFetch' },
      { type: 'tool-call-end', index, id: `fetch${index}`, name: 'WebFetch', input: { url } },
    ]),
    { type: 'usage', usage: USAGE },
    stopEvent('tool-use', 'tool_use'),
  ]
}
function harness(
  untrusted: readonly FakeExchange[] = [],
  inspectors: readonly InspectorRegistration[] = [],
  fetch?: FetchLike,
) {
  const net = fakeNetwork([], { untrusted })
  const memory = createMemoryHost({
    identity: IDENTITY,
    network: fetch === undefined ? net : { ...net, fetchUntrusted: fetch },
  })
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
  const service = createTestSessionService(
    {
      host: memory,
      tape: store,
      ids: createCounterIds(),
      inspectors,
      connector: loop.connector,
      protectedFiles: [],
      log: () => {},
    },
    { tools: { WebFetch: 'real' } },
  )
  service.bindLoop(loop)
  return { net, memory, store, provider, loop, service }
}
type Harness = ReturnType<typeof harness>
const done = () => scriptedTurn({ deltas: ['Done'], usage: USAGE })
async function all(h: Harness) {
  return (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}
async function start(h: Harness, ...urls: string[]) {
  h.provider.script(calls(...urls))
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
const page = (body = 'page'): FakeExchange => ({
  kind: 'text',
  body,
  headers: { 'content-type': 'text/plain' },
})

describe('WebFetch in the agent loop', () => {
  it.each([
    'file:///etc/passwd',
    'http://2130706433',
    'http://[::ffff:7f00:1]',
    'https://user:pass@public.example',
    'http://localhost',
  ])('blocks %s without approval or dispatch', async (url) => {
    const h = harness()
    h.provider.script(calls(url))
    h.provider.script(done())
    await h.service.send({ sessionId: SESSION, origin: null, text: 'Fetch' })
    await h.loop.runEnded()
    const facts = await all(h)
    expect(h.net.untrustedRequests).toEqual([])
    expect(h.memory.confirmRequests).toEqual([])
    expect(facts.filter((e) => e.name === 'execution/dispatch_committed')).toEqual([])
    expect(facts.find((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
      state: 'not-run',
      source: 'protected',
      effect: 'blocked',
    })
  })

  it('authorizes exact normalized host once, rechecks redirects without writing another decision', async () => {
    const inspector = createFakeInspector({ id: 'watch', ceiling: 'ask' })
    const h = harness(
      [{ kind: 'text', body: '', status: 302, headers: { location: '/next' } }, page()],
      [inspector.registration],
    )
    expect((await start(h, 'https://A.Example.COM./start')).reason).toEqual({
      code: 'paused',
      waitingFor: 'approval',
    })
    expect(h.net.untrustedRequests).toEqual([])
    const pending = await h.service.currentPending({ sessionId: SESSION })
    expect(pending).toMatchObject({
      card: { reason: 'network', target: { type: 'url', url: 'https://A.Example.COM./start' } },
    })
    h.provider.script(done())
    expect((await allow(h)).reason).toEqual({ code: 'completed' })
    const facts = await all(h)
    expect(facts.filter((e) => e.name === 'tool/permission_decided')).toHaveLength(1)
    expect(
      inspector.calls.some((call) => call.call.args['url'] === 'https://a.example.com./next'),
    ).toBe(true)
    expect(facts.find((e) => e.name === 'tool/approval_resolved')?.payload['grant']).toMatchObject({
      key: grantKey('builtin', 'WebFetch', { kind: 'domain', host: 'a.example.com' }),
    })
    expect(h.net.untrustedRequests).toHaveLength(2)
    expect(h.net.requests).toEqual([])
    h.provider.script(calls('https://a.example.com/again', 'https://sub.a.example.com/private'))
    await h.service.send({ sessionId: SESSION, origin: null, text: 'More' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    expect(h.memory.confirmRequests).toHaveLength(2)
    expect(await h.service.currentPending({ sessionId: SESSION })).toMatchObject({
      card: { target: { url: 'https://sub.a.example.com/private' } },
    })
  })

  it('does not follow a same-host redirect asking for F5 approval, nor persist or deliver its transient decision', async () => {
    const inspector = createFakeInspector({
      id: 'exfiltration',
      ceiling: 'ask',
      answer: (input) =>
        String(input.call.args['url']).endsWith('/private')
          ? { kind: 'ask', category: 'exfiltration', findings: [{ code: 'private-target' }] }
          : { kind: 'none' },
    })
    const h = harness(
      [{ kind: 'text', body: '', status: 302, headers: { location: '/private' } }],
      [inspector.registration],
    )
    await start(h, 'https://a.example/start')
    h.provider.script(done())
    await allow(h)
    const facts = await all(h)
    expect(h.net.untrustedRequests).toHaveLength(1)
    expect(h.memory.confirmRequests).toHaveLength(1)
    expect(facts.filter((e) => e.name === 'tool/permission_decided')).toHaveLength(1)
    expect(facts.find((e) => e.name === 'tool/result')?.payload).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: expect.stringContaining('https://a.example/private') }],
    })
  })

  it('closes DNS refusals after dispatch as blocked, including a later redirect hop, and counts three in a row', async () => {
    const h = harness([
      { kind: 'text', body: '', status: 302, headers: { location: '/next' } },
      { kind: 'denied' },
      { kind: 'denied' },
      { kind: 'denied' },
    ])
    await start(
      h,
      'https://a.example/start',
      'https://a.example/second',
      'https://a.example/third',
      'https://a.example/fourth',
    )
    expect((await allow(h)).reason).toEqual({ code: 'blocked-repeatedly', count: 3 })
    expect(h.net.untrustedRequests).toHaveLength(4)
    const facts = await all(h)
    const outcomes = facts.filter((e) => e.name === 'execution/tool_outcome')
    expect(outcomes.slice(0, 3).map((e) => e.payload)).toEqual(
      expect.arrayContaining(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({
            state: 'not-run',
            source: 'protected',
            effect: 'blocked',
            facts: { toolName: 'WebFetch', target: 'a.example' },
          }),
        ),
      ),
    )
    expect(outcomes[3]?.payload['source']).toBe('blocked-repeatedly')
    expect(facts.filter((e) => e.name === 'execution/dispatch_committed')).toHaveLength(3)
    expect(
      h.loop.recorded.filter((e) => e.type === 'tool-outcome' && e.outcome.source === 'protected'),
    ).toHaveLength(3)
  })

  it('carries DNS denial counts across subsequent provider requests', async () => {
    const h = harness([{ kind: 'denied' }, { kind: 'denied' }, { kind: 'denied' }])
    await start(h, 'https://a.example/first')
    h.provider.script(calls('https://a.example/second'))
    h.provider.script(calls('https://a.example/third'))
    expect((await allow(h)).reason).toEqual({ code: 'blocked-repeatedly', count: 3 })
    expect(h.net.untrustedRequests).toHaveLength(3)
    expect(h.provider.starts).toBe(3)
  })

  it('02 不变量 14: a card clears the denial count, so an approved fetch refused at DNS counts one', async () => {
    // §上限「连续被拦截」: 中间有一次放行或问人就清零. Two blocks, then a card: the approved fetch the
    // DNS check refuses is the first denial after the card, not the third in a row; two more end it.
    const h = harness([{ kind: 'denied' }])
    h.provider.script(calls('http://localhost'))
    h.provider.script(calls('file:///etc/passwd'))
    h.provider.script(calls('https://a.example/asked'))
    expect(
      await h.service.send({ sessionId: SESSION, origin: null, text: 'Fetch pages' }),
    ).toMatchObject({ status: 'started' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    h.provider.script(calls('http://2130706433'))
    h.provider.script(calls('http://[::ffff:7f00:1]'))
    expect((await allow(h)).reason).toEqual({ code: 'blocked-repeatedly', count: 3 })
    const outcomes = (await all(h)).filter((e) => e.name === 'execution/tool_outcome')
    expect(
      outcomes.map((e) => `${String(e.payload['state'])}/${String(e.payload['source'])}`),
    ).toEqual(Array.from({ length: 5 }, () => 'not-run/protected'))
    expect(h.net.untrustedRequests).toHaveLength(1)
    expect(h.provider.starts).toBe(5)
  })

  it('spills long pages and leaves only a preview, path and size in the replayed result', async () => {
    const body = 'long page\n'.repeat(SPILL_THRESHOLD_CHARS)
    const h = harness([page(body)])
    await start(h, 'https://a.example/long')
    h.provider.script(done())
    await allow(h)
    const result = (await all(h)).find((e) => e.name === 'tool/result')
    const spill = result?.payload['spill'] as { file: string; bytes: number }
    expect(spill.bytes).toBe(new TextEncoder().encode(body).byteLength)
    expect(
      new TextDecoder().decode(
        h.memory.files.get(`${IDENTITY.profileDir}/tool-output/${SESSION}/${spill.file}`),
      ),
    ).toBe(body)
    expect(JSON.stringify(result?.payload['content']).length).toBeLessThan(body.length)
    expect(JSON.stringify(h.provider.requests.at(-1)?.body)).toContain(spill.file)
  })

  it('keeps provider fetch untouched, and missing host/fake untrusted support rejects', async () => {
    await expect(createMemoryHost().network.fetchUntrusted('https://a.example')).rejects.toThrow(
      'unavailable',
    )
    const net = fakeNetwork([page('provider')])
    await expect(net.fetchUntrusted('https://a.example')).rejects.toThrow('no script')
    expect(await (await net.fetch('http://localhost:11434')).text()).toBe('provider')
    expect(net.requests).toHaveLength(1)
    expect(net.untrustedRequests).toHaveLength(1)
  })

  it('stops an in-flight fetch as aborted/external, while an ordinary network error completes', async () => {
    const reached = Promise.withResolvers<void>()
    const h = harness(
      [],
      [],
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          reached.resolve()
        }),
    )
    await start(h, 'https://a.example/slow')
    const resumed = allow(h)
    await reached.promise
    await h.service.stop({ rootSessionId: SESSION })
    await resumed
    expect((await all(h)).find((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
      state: 'aborted',
      effect: 'external',
      source: 'stopped',
    })
    const failed = harness([], [], async () => {
      throw new TypeError('network disconnected')
    })
    await start(failed, 'https://a.example/error')
    failed.provider.script(done())
    await allow(failed)
    expect(
      (await all(failed)).find((e) => e.name === 'execution/tool_outcome')?.payload,
    ).toMatchObject({ state: 'completed', effect: 'external', source: null })
  })
})
