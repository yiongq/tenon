/** Cross-session permissions must follow persisted facts, never model-authored instructions. */
import { expect, it } from 'vitest'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  exfiltrationInspector,
} from '../../src/index.js'
import type { ModelInfo, StreamEvent, SearchBackend } from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'

const SESSION = '7c4e9a2e-6b3d-4a71-9f52-0c8de7a11b37'
const URL = 'https://public.example/next'
const MODEL: ModelInfo = {
  id: 'child-model',
  providerId: 'anthropic',
  contextLimit: 200000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}
function call(name: string, input: Record<string, unknown>): StreamEvent[] {
  return [
    { type: 'tool-call-start', index: 0, id: 'tool', name },
    { type: 'tool-call-end', index: 0, id: 'tool', name, input },
    stopEvent('tool-use', 'tool_use'),
  ]
}
const done = () => scriptedTurn({ deltas: ['done'] })
async function harness() {
  const net = fakeNetwork([], {
    untrusted: Array.from({ length: 5 }, () => ({
      kind: 'text' as const,
      body: 'public page',
      headers: { 'content-type': 'text/plain' },
    })),
  })
  const host = createMemoryHost({ network: net })
  await host.fs.mkdirp(absolutePath('/work'))
  await host.fs.writeFile(absolutePath('/work/.env'), new TextEncoder().encode('FAKE_CANARY'))
  const store = createMemoryTapeStore({ identity: host.identity })
  const provider = createScriptedProvider({ models: [MODEL] })
  const search: SearchBackend = {
    host: 'open.bigmodel.cn',
    domainFilter: false,
    prepareQuery: (query) => ({ query, truncated: false }),
    search: async () => ({ ok: true, hits: [{ title: 'Public page', url: URL }] }),
  }
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL, search } })
  const service = createTestSessionService(
    {
      host,
      tape: store,
      ids: createCounterIds(),
      connector: loop.connector,
      inspectors: [exfiltrationInspector],
      protectedFiles: [],
    },
    { tools: { Agent: 'real', Write: 'real', Read: 'real', WebFetch: 'real', WebSearch: 'real' } },
  )
  service.bindLoop(loop)
  await service.selectProfile({
    sessionId: SESSION,
    profile: 'cowork',
    dedicated: absolutePath('/work'),
  })
  return { net, host, store, provider, loop, service }
}
type Harness = Awaited<ReturnType<typeof harness>>
async function rootEnd(h: Harness) {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- drain child lifecycle events before the root terminal
    const e = await h.loop.runEnded()
    if (e.sessionId === SESSION) return e
  }
}
async function send(h: Harness, text = 'continue') {
  await h.service.send({ sessionId: SESSION, origin: null, text })
  return rootEnd(h)
}
async function pending(h: Harness) {
  const p = await h.service.currentPending({ sessionId: SESSION })
  if (p?.waitKind !== 'approval') throw new Error('Expected approval')
  return p
}
async function allow(h: Harness) {
  const p = await pending(h)
  await h.service.answer({
    kind: 'approval',
    sessionId: p.card.sessionId,
    requestId: p.card.requestId,
    decision: 'allow',
    origin: null,
  })
  return rootEnd(h)
}
async function grantDomain(h: Harness) {
  h.provider.script(call('WebFetch', { url: 'https://public.example/start' }))
  await send(h)
  h.provider.script(done())
  await allow(h)
}

it.each(['agent-prompt', 'root-user', 'parent-search'] as const)(
  'a child only trusts search provenance, not %s text',
  async (source) => {
    const h = await harness()
    await grantDomain(h)
    if (source === 'parent-search') {
      h.provider.script(call('WebSearch', { query: 'public page' }))
      await send(h)
      h.provider.script(done())
      await allow(h)
    }
    h.provider.script(call('Read', { file_path: '/work/.env' }))
    h.provider.script(
      call('Agent', {
        description: 'check page',
        prompt: source === 'agent-prompt' ? `Fetch ${URL}` : 'inspect the public page',
      }),
    )
    h.provider.script(call('WebFetch', { url: URL }))
    if (source === 'parent-search') {
      h.provider.script(done())
      h.provider.script(done())
    }
    const end = await send(h, source === 'root-user' ? `Read ${URL}` : 'delegate investigation')
    const succeeds = source === 'parent-search'
    expect(end.reason).toEqual(
      succeeds ? { code: 'completed' } : { code: 'paused', waitingFor: 'subagent' },
    )
    expect(h.net.untrustedRequests).toHaveLength(succeeds ? 2 : 1)
    const card = await h.service.currentPending({ sessionId: SESSION })
    expect(card?.waitKind === 'approval' ? card.card.reason : null).toBe(
      succeeds ? null : 'flagged',
    )
    expect(card?.waitKind === 'approval' ? card.card.target : null).toEqual(
      succeeds ? null : { type: 'url', url: URL },
    )
    expect(card?.waitKind === 'approval' && card.card.sessionId === SESSION).toBe(false)
    const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    const handoff = parent.findLast((e) => e.name === 'tool/result' && e.payload['handoff'])
      ?.payload['handoff']
    const result = handoff as
      | { outcome: string; calls: { toolName: string; state: string }[] }
      | undefined
    expect(result?.outcome).toBe(succeeds ? 'completed' : undefined)
    expect(result?.calls.map(({ toolName, state }) => ({ toolName, state }))).toEqual(
      succeeds ? [{ toolName: 'WebFetch', state: 'completed' }] : undefined,
    )
  },
)

it('child private reads and untrusted fetches tighten the parent after handoff', async () => {
  const h = await harness()
  await grantDomain(h)
  h.provider.script(call('Agent', { description: 'inspect inputs', prompt: 'read configuration' }))
  h.provider.script(call('Read', { file_path: '/work/.env' }))
  h.provider.script(done())
  h.provider.script(call('WebFetch', { url: URL }))
  expect((await send(h)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
  expect((await pending(h)).card).toMatchObject({
    sessionId: SESSION,
    reason: 'flagged',
    target: { type: 'url', url: URL },
  })
  expect(h.net.untrustedRequests).toHaveLength(1)
})

it('a child session grant never permits the parent to write the same file', async () => {
  const h = await harness()
  h.provider.script(call('Agent', { description: 'write file', prompt: 'write a file' }))
  h.provider.script(call('Write', { file_path: '/work/result.txt', content: 'child' }))
  await send(h)
  expect((await pending(h)).card.sessionId).not.toBe(SESSION)
  h.provider.script(done())
  h.provider.script(call('Write', { file_path: '/work/result.txt', content: 'parent' }))
  expect((await allow(h)).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
  expect((await pending(h)).card.sessionId).toBe(SESSION)
  expect(await h.host.fs.readFile(absolutePath('/work/result.txt'), { encoding: 'utf8' })).toBe(
    'child',
  )
})

it('a later child inherits the private-data condition already handed back by an earlier child', async () => {
  const h = await harness()
  await grantDomain(h)
  h.provider.script(call('Agent', { description: 'read inputs', prompt: 'read configuration' }))
  h.provider.script(call('Read', { file_path: '/work/.env' }))
  h.provider.script(done())
  h.provider.script(done())
  expect((await send(h)).reason.code).toBe('completed')
  h.provider.script(call('Agent', { description: 'check page', prompt: 'inspect public page' }))
  h.provider.script(call('WebFetch', { url: URL }))
  expect((await send(h)).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
  expect((await pending(h)).card).toMatchObject({
    reason: 'flagged',
    target: { type: 'url', url: URL },
  })
  expect(h.net.untrustedRequests).toHaveLength(1)
})

it('a parent file grant permits the child and is explicitly marked inherited', async () => {
  const h = await harness()
  h.provider.script(call('Write', { file_path: '/work/result.txt', content: 'parent' }))
  await send(h)
  h.provider.script(done())
  await allow(h)
  h.provider.script(call('Agent', { description: 'update file', prompt: 'update the result' }))
  h.provider.script(call('Write', { file_path: '/work/result.txt', content: 'child' }))
  h.provider.script(done())
  h.provider.script(done())
  expect((await send(h)).reason.code).toBe('completed')
  const entries = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  const link = entries.find((e) => e.name === 'session/parent_link')!
  const childId = (link.payload['child'] as { sessionId: string }).sessionId
  const child = (await h.store.readRange({ sessionId: childId, limit: 1000 })).entries
  expect(child.find((e) => e.name === 'tool/permission_decided')?.payload['summary']).toMatchObject(
    { code: 'session-allowed', facts: { inherited: 'parent' } },
  )
  expect(await h.host.fs.readFile(absolutePath('/work/result.txt'), { encoding: 'utf8' })).toBe(
    'child',
  )
})

it.each(['kept', 'removed', 'removed-and-readded'] as const)(
  'a parent file grant the child inherits is void once the parent removes its folder: %s',
  async (change) => {
    const h = await harness()
    const shared = absolutePath('/shared')
    await h.host.fs.mkdirp(shared)
    const workspace = (folders: 'add' | 'remove') =>
      h.service.setWorkspace({
        sessionId: SESSION,
        change:
          folders === 'add'
            ? { kind: 'add', folders: [shared] }
            : { kind: 'remove', folder: shared },
        dedicated: absolutePath('/work'),
      })
    await workspace('add')
    h.provider.script(call('Write', { file_path: '/shared/a.txt', content: 'parent' }))
    await send(h)
    h.provider.script(done())
    expect((await allow(h)).reason.code).toBe('completed')
    // Removal voids the parent's own grant for good; adding the folder back does not revive it.
    if (change !== 'kept') await workspace('remove')
    if (change === 'removed-and-readded') await workspace('add')
    h.provider.script(call('Agent', { description: 'update file', prompt: 'update the file' }))
    h.provider.script(call('Write', { file_path: '/shared/a.txt', content: 'child' }))
    h.provider.script(done())
    h.provider.script(done())
    const inherited = change === 'kept'
    expect((await send(h)).reason).toEqual(
      inherited ? { code: 'completed' } : { code: 'paused', waitingFor: 'subagent' },
    )
    const card = await h.service.currentPending({ sessionId: SESSION })
    expect(card?.waitKind === 'approval' ? card.card.target : null).toEqual(
      inherited ? null : { type: 'path', path: '/shared/a.txt' },
    )
    expect(card?.waitKind === 'approval' && card.card.sessionId === SESSION).toBe(false)
    expect(await h.host.fs.readFile(absolutePath('/shared/a.txt'), { encoding: 'utf8' })).toBe(
      inherited ? 'child' : 'parent',
    )
  },
)

it.each(['parent', 'sibling'] as const)(
  'a child search result does not vouch for a later %s fetch',
  async (destination) => {
    const h = await harness()
    await grantDomain(h)
    h.provider.script(call('Agent', { description: 'find page', prompt: 'search public page' }))
    h.provider.script(call('Read', { file_path: '/work/.env' }))
    h.provider.script(call('WebSearch', { query: 'public page' }))
    await send(h)
    h.provider.script(done())
    if (destination === 'sibling')
      h.provider.script(call('Agent', { description: 'fetch page', prompt: 'inspect public page' }))
    h.provider.script(call('WebFetch', { url: URL }))
    expect((await allow(h)).reason).toEqual({
      code: 'paused',
      waitingFor: destination === 'parent' ? 'approval' : 'subagent',
    })
    expect((await pending(h)).card).toMatchObject({
      reason: 'flagged',
      target: { type: 'url', url: URL },
    })
    expect(h.net.untrustedRequests).toHaveLength(1)
  },
)

it.each(['before-grant', 'after-grant', 'legacy'] as const)(
  'rebuilds child file grants using parent workspace causality across restart: %s',
  async (timing) => {
    const h = await harness()
    const shared = absolutePath('/shared')
    await h.host.fs.mkdirp(shared)
    const add = () =>
      h.service.setWorkspace({
        sessionId: SESSION,
        change: { kind: 'add', folders: [shared] },
        dedicated: absolutePath('/work'),
      })
    const remove = () =>
      h.service.setWorkspace({
        sessionId: SESSION,
        change: { kind: 'remove', folder: shared },
        dedicated: absolutePath('/work'),
      })
    await add()
    h.provider.script(call('Agent', { description: 'write files', prompt: 'write both files' }))
    h.provider.script(call('Write', { file_path: '/shared/result.txt', content: 'first' }))
    await send(h)
    if (timing === 'before-grant') {
      await remove()
      await add()
    }
    if (timing === 'legacy') {
      const append = h.store.append.bind(h.store)
      h.store.append = (q) =>
        append({
          ...q,
          entries: q.entries.map((entry) => {
            if (entry.name !== 'tool/approval_resolved') return entry
            const payload = { ...entry.payload }
            delete payload['parentWorkspaceKey']
            return { ...entry, payload }
          }),
        })
    }
    h.provider.script(call('Write', { file_path: '/work/other.txt', content: 'pause here' }))
    const firstCard = await pending(h)
    await h.service.answer({
      kind: 'approval',
      sessionId: firstCard.card.sessionId,
      requestId: firstCard.card.requestId,
      decision: 'allow',
      origin: null,
    })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    if (timing === 'after-grant') {
      await remove()
      await add()
    }
    const childId = (await pending(h)).card.sessionId
    const child = (await h.store.readRange({ sessionId: childId, limit: 1000 })).entries
    const approval = child.find((e) => e.name === 'tool/approval_resolved')!
    const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    expect(new Set([...child, ...parent].map((e) => e.createdAt))).toEqual(new Set([0]))
    expect(
      parent.some(
        (e) =>
          e.name === 'session/workspace_set' &&
          e.provenanceKey === approval.payload['parentWorkspaceKey'],
      ),
    ).toBe(timing !== 'legacy')
    const loop = createTestLoopPorts({ connector: { provider: h.provider, model: MODEL } })
    h.service = createTestSessionService(
      {
        host: h.host,
        tape: h.store,
        ids: createCounterIds({ start: 1000 }),
        connector: loop.connector,
        inspectors: [exfiltrationInspector],
        protectedFiles: [],
      },
      {
        tools: { Agent: 'real', Write: 'real', Read: 'real', WebFetch: 'real', WebSearch: 'real' },
      },
    )
    h.loop = loop
    h.service.bindLoop(loop)
    expect((await h.service.recover()).errors).toEqual([])
    h.provider.script(call('Write', { file_path: '/shared/result.txt', content: 'second' }))
    if (timing === 'before-grant') {
      h.provider.script(done())
      h.provider.script(done())
    }
    const p = await pending(h)
    await h.service.answer({
      kind: 'approval',
      sessionId: p.card.sessionId,
      requestId: p.card.requestId,
      decision: 'deny',
      origin: null,
    })
    const end = timing === 'before-grant' ? await rootEnd(h) : await h.loop.runEnded()
    const succeeds = timing === 'before-grant'
    expect(end.reason).toEqual(
      succeeds ? { code: 'completed' } : { code: 'paused', waitingFor: 'approval' },
    )
    const next = await h.service.currentPending({ sessionId: SESSION })
    expect(next?.waitKind === 'approval' ? next.card.target : null).toEqual(
      succeeds ? null : { type: 'path', path: '/shared/result.txt' },
    )
    expect(await h.host.fs.readFile(absolutePath('/shared/result.txt'), { encoding: 'utf8' })).toBe(
      succeeds ? 'second' : 'first',
    )
  },
)

it('invalidates a child command grant when the parent cwd changes away and back', async () => {
  const h = await harness()
  await h.host.fs.mkdirp(absolutePath('/shared'))
  await h.service.setWorkspace({
    sessionId: SESSION,
    change: { kind: 'add', folders: [absolutePath('/shared')] },
    dedicated: absolutePath('/work'),
  })
  h.provider.script(
    call('Agent', { description: 'inspect folder', prompt: 'inspect working folder' }),
  )
  h.provider.script(call('Bash', { command: 'pwd' }))
  await send(h)
  const first = await pending(h)
  h.provider.script(call('Write', { file_path: '/shared/pause.txt', content: 'wait' }))
  await h.service.answer({
    kind: 'approval',
    sessionId: first.card.sessionId,
    requestId: first.card.requestId,
    decision: 'allow',
    origin: null,
  })
  await h.loop.runEnded()
  await h.service.setWorkspace({
    sessionId: SESSION,
    change: { kind: 'remove', folder: absolutePath('/shared') },
    dedicated: absolutePath('/work'),
  })
  await h.service.setWorkspace({
    sessionId: SESSION,
    change: { kind: 'add', folders: [absolutePath('/shared')] },
    dedicated: absolutePath('/work'),
  })
  const second = await pending(h)
  h.provider.script(call('Bash', { command: 'pwd' }))
  await h.service.answer({
    kind: 'approval',
    sessionId: second.card.sessionId,
    requestId: second.card.requestId,
    decision: 'deny',
    origin: null,
  })
  expect((await h.loop.runEnded()).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
  expect((await pending(h)).card.target).toEqual({
    type: 'command',
    command: 'pwd',
    cwd: '/shared',
  })
})
