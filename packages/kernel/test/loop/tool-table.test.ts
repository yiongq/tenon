/**
 * The tool table in the loop (spec 02 §工具目录与冻结, §组装清单与内容寄存; plan step 10, 旧 139, 旧 35,
 * 旧 148, 旧 149, 旧 150, 旧 151, 旧 145, 02 不变量 6; step 12's 旧 124 for a tool disabled after
 * the freeze or excluded at it).
 *
 * Most builtin tools reach the kernel through `createTestSessionService`'s test tool registry. The
 * cases are about which definitions each request carries and which facts record it — and what a call
 * to a tool blocked after the freeze, excluded at it or left without an implementation writes.
 */
import { describe, expect, it } from 'vitest'
import {
  ZHIPU_DEFAULT_BASE_URL,
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createSessionService,
  encodeAnthropicMessages,
  zhipuDefinition,
} from '../../src/index.js'
import type {
  McpConnection,
  McpToolSource,
  MemoryHost,
  ModelInfo,
  Provider,
  SearchBackend,
  SessionService,
  TapeEntry,
  TapeStore,
  PermissionDecidedPayload,
  StreamEvent,
  ToolTablePayload,
  ToolsWithheldPayload,
  Usage,
  ViewAssembledPayload,
} from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type {
  ScriptedProvider,
  TestLoopPorts,
  TestServiceExtras,
  TestToolRegistry,
} from '../../src/testing/index.js'
import { MODEL_NOTES } from '../../src/prompts/index.js'
import { readViewState } from '../../src/loop/run.js'
import { rebuildToolTable } from '../../src/tools/table.js'
import * as openAIFixture from '../provider/fixtures/openai-sse.js'

const IDENTITY = { userId: 'table-user', tenantId: 'table-tenant', profileDir: '/tenon/table' }
const SESSION = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'

function model(providerId: string, over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: `${providerId}-model`,
    providerId,
    contextLimit: 200_000,
    maxOutputTokens: 1024,
    reasoning: false,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: false,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'drop',
    usageNeedsOptIn: false,
    ...over,
  }
}

const MODEL_A = model('anthropic')
const MODEL_A_TEXT = model('anthropic', { id: 'hand-typed', supportsToolCalling: false })
const MODEL_B = model('zhipu')

const USAGE: Usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

const SEARCH: SearchBackend = {
  host: 'open.bigmodel.cn',
  domainFilter: false,
  prepareQuery: (query) => ({ query, truncated: false }),
  search: () => Promise.resolve({ ok: true, hits: [] }),
}

interface Harness {
  readonly host: MemoryHost
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly a: ScriptedProvider
  readonly b: ScriptedProvider
}

function harness(
  extras: Omit<TestServiceExtras, 'tools'> = {},
  o: {
    /** A restart: the same store under a new service, its ids past the first one's. */
    readonly store?: TapeStore
    readonly idsFrom?: number
    readonly tools?: TestToolRegistry
  } = {},
): Harness {
  const host = createMemoryHost()
  const store = o.store ?? createMemoryTapeStore({ identity: IDENTITY })
  const a = createScriptedProvider({ models: [MODEL_A, MODEL_A_TEXT] })
  const b = createScriptedProvider({ id: 'zhipu', models: [MODEL_B] })
  const loop = createTestLoopPorts({ connector: { provider: a, model: MODEL_A } })
  const service = createTestSessionService(
    {
      host,
      tape: store,
      ids: createCounterIds({ start: o.idsFrom ?? 1 }),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
    },
    { ...extras, tools: o.tools ?? {} },
  )
  service.bindLoop(loop)
  return { host, store, service, loop, a, b }
}

interface SendWith {
  readonly provider?: Provider
  readonly model?: ModelInfo
  readonly search?: SearchBackend | null
  readonly mcpSources?: readonly McpToolSource[]
  readonly toolsWithheld?: 'provider-text-only' | null
  /** The scripted provider's replies for this Run, in place of one plain answer. */
  readonly turns?: readonly StreamEvent[][]
}

/** Distinct texts, so no message reads as a resend of the one before (01's retry rule). */
let messages = 0

/** One message on the connector's current answer: the provider scripted, the Run to its end. */
async function send(h: Harness, over: SendWith = {}, sessionId = SESSION): Promise<string> {
  const provider = over.provider ?? h.a
  if ('script' in provider) {
    for (const turn of over.turns ?? [scriptedTurn({ deltas: ['ok'], usage: USAGE })])
      (provider as ScriptedProvider).script(turn)
  }
  h.loop.connector.use({
    provider,
    model: over.model ?? (provider === h.b ? MODEL_B : MODEL_A),
    search: over.search ?? null,
    mcpSources: over.mcpSources ?? [],
    toolsWithheld: over.toolsWithheld ?? null,
  })
  messages += 1
  const sent = await h.service.send({
    sessionId,
    origin: null,
    text: `message ${String(messages)}`,
  })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  const ended = await h.loop.runEnded({ runId: sent.runId })
  if (!ended.recorded) throw new Error(`run ${sent.runId} did not record its end`)
  return sent.runId
}

async function entries(store: TapeStore, sessionId = SESSION): Promise<TapeEntry[]> {
  return (await store.readRange({ sessionId, limit: 1000 })).entries
}

function named(all: readonly TapeEntry[], name: string): TapeEntry[] {
  return all.filter((entry) => entry.name === name)
}

function toolNames(provider: ScriptedProvider, index = -1): string[] | undefined {
  const body = provider.requests.at(index)?.body as { tools?: { name: string }[] }
  return body.tools?.map((definition) => definition.name)
}

/** A connection that lists these tools, in this order, and records each call it runs. */
function source(
  serverId: string,
  tools: readonly Record<string, unknown>[],
  called: string[] = [],
): McpToolSource {
  const connection = {
    listTools: () => Promise.resolve(tools),
    callTool: (name: string) => {
      called.push(name)
      return Promise.resolve({ content: [{ type: 'text', text: `ran ${name}` }], isError: false })
    },
  } as unknown as McpConnection
  return { serverId, connection }
}

let calls = 0

/** A reply that calls one tool, then waits for its result. */
function callReply(name: string, input: Record<string, unknown> = {}): StreamEvent[] {
  calls += 1
  const id = `toolu_${String(calls)}`
  return [
    { type: 'tool-call-start', index: 1, id, name },
    { type: 'tool-call-end', index: 1, id, name, input },
    { type: 'usage', usage: USAGE },
    stopEvent('tool-use', 'tool_use'),
  ]
}

const answered = (): StreamEvent[] => scriptedTurn({ deltas: ['done'], usage: USAGE })

/** A closed call's facts, read off the Tape: the result, the outcome and the decision, if any. */
function closure(all: readonly TapeEntry[], at = -1) {
  const result = named(all, 'tool/result').at(at)?.payload
  const outcome = named(all, 'execution/tool_outcome').at(at)?.payload
  return { result, outcome }
}

function decisionsOf(all: readonly TapeEntry[]): PermissionDecidedPayload[] {
  return named(all, 'tool/permission_decided').map(
    (entry) => entry.payload as unknown as PermissionDecidedPayload,
  )
}

function tool(name: string, meta?: Record<string, unknown>): Record<string, unknown> {
  return { name, inputSchema: { type: 'object' }, ...(meta === undefined ? {} : { _meta: meta }) }
}

/**
 * 02 不变量 6, over every attempt of the session: a request that carried its table hashes like the
 * table encoded by this wire; one that did not hashes like no tools at all, and the first such request
 * after one that did has a `view/tools_withheld`.
 */
async function assertToolHashes(store: TapeStore, sessionId = SESSION): Promise<void> {
  const all = await entries(store, sessionId)
  const state = await readViewState(store, sessionId)
  const byKey = new Map(all.map((entry) => [entry.provenanceKey, entry]))
  const lastSent = new Map<string, boolean>()
  for (const attempt of named(all, 'provider/attempt_completed')) {
    const ref = attempt.payload['assemblyRef'] as string
    const assembled = byKey.get(ref)?.payload as unknown as ViewAssembledPayload
    const tools = assembled.tools
    if (tools === null) throw new Error('02 has no request outside a table yet')
    const payload = state.tables.get(tools.tableKey)
    if (payload === undefined) throw new Error(`no table ${tools.tableKey}`)
    const table = rebuildToolTable(tools.tableKey, payload, state.specs)
    const probe = model(table.providerId)
    const encode = (sent: boolean): string =>
      encodeAnthropicMessages(
        {
          model: probe,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
          ...(sent ? { tools: table.items.map((item) => item.spec) } : {}),
        },
        table.providerId,
      ).toolDefinitionsHash
    expect(attempt.payload['toolDefinitionsHash'], `${ref} (sent: ${String(tools.sent)})`).toBe(
      encode(tools.sent),
    )
    const runId = attempt.sourceId ?? ''
    const withheld = all.some(
      (entry) => entry.name === 'view/tools_withheld' && entry.sourceId === runId,
    )
    expect(withheld, `${ref}: tools_withheld`).toBe(
      !tools.sent && (lastSent.get(tools.tableKey) ?? true),
    )
    lastSent.set(tools.tableKey, tools.sent)
  }
}

describe('which tools a request carries', () => {
  it('offers the chat profile’s four, WebSearch only with a search backend (旧 139)', async () => {
    const h = harness()
    await send(h)
    expect(toolNames(h.a)).toEqual(['AskUserQuestion', 'Read', 'WebFetch'])
    const table = named(await entries(h.store), 'view/tool_table')[0]
    if (table === undefined) throw new Error('no tool table')
    expect((table.payload as unknown as ToolTablePayload).excluded).toEqual([
      {
        source: 'builtin',
        serverId: 'builtin',
        originalName: 'WebSearch',
        code: 'no-search-backend',
      },
    ])
    // Another session, with a backend: WebSearch is in.
    const other = '0b8f2a1c-3d4e-4f50-8a61-7b2c3d4e5f60'
    await send(h, { search: SEARCH }, other)
    expect(toolNames(h.a)).toEqual(['AskUserQuestion', 'Read', 'WebFetch', 'WebSearch'])
  })

  it('carries the builtin tools that landed in the product: Read, then Glob and Grep in a task', async () => {
    const store = createMemoryTapeStore({ identity: IDENTITY })
    const provider = createScriptedProvider({ models: [MODEL_A] })
    const loop = createTestLoopPorts({ connector: { provider, model: MODEL_A } })
    const service = createSessionService({
      host: createMemoryHost(),
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
    })
    service.bindLoop(loop)
    provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
    const sent = await service.send({ sessionId: SESSION, origin: null, text: 'hi' })
    if (sent.status === 'started') await loop.runEnded({ runId: sent.runId })
    // Plan step 18: Read is the chat table's only landed tool; the rest join with their steps.
    expect(toolNames(provider)).toEqual(['Read'])
    const task = '5e2d8b3f-7c4e-4b82-8a63-1d9ef8b22c45'
    await service.selectProfile({
      sessionId: task,
      profile: 'cowork',
      dedicated: absolutePath('/home/u/Tenon/workspaces/u/t/task'),
    })
    provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
    const second = await service.send({ sessionId: task, origin: null, text: 'hi' })
    if (second.status === 'started') await loop.runEnded({ runId: second.runId })
    expect(toolNames(provider)).toEqual(['Glob', 'Grep', 'Read'])
  })
})

describe('the table freezes per session × provider (E2)', () => {
  it('writes B’s table on the first switch, and none on the way back to A (旧 35)', async () => {
    const h = harness()
    await send(h)
    const first = h.a.requests.at(-1)?.body as { tools?: unknown }
    await send(h, { provider: h.b })
    await send(h)
    const tables = named(await entries(h.store), 'view/tool_table').map(
      (entry) => (entry.payload as unknown as ToolTablePayload).providerId,
    )
    expect(tables).toEqual(['anthropic', 'zhipu'])
    const back = h.a.requests.at(-1)?.body as { tools?: unknown }
    expect(JSON.stringify(back.tools)).toBe(JSON.stringify(first.tools))
    await assertToolHashes(h.store)
  })

  it('sorts by name whatever order the servers list, and excludes before the first use (旧 148)', async () => {
    const h = harness({
      userSetting: (key) =>
        key.toolName === 'alpha' || key.toolName === 'zeta' ? { userSetting: 'never' } : null,
    })
    h.host.setPolicy({
      status: 'current',
      version: 'p1',
      snapshot: {
        tools: [{ policyId: 'deny-zeta', serverId: 'fix', effect: 'deny', toolName: 'zeta' }],
      },
    })
    await send(h, {
      mcpSources: [source('fix', [tool('zeta'), tool('beta'), tool('Mid'), tool('alpha')])],
    })
    expect(toolNames(h.a)).toEqual(['AskUserQuestion', 'Read', 'WebFetch', 'fix__Mid', 'fix__beta'])
    const all = await entries(h.store)
    const table = named(all, 'view/tool_table')[0]?.payload as unknown as ToolTablePayload
    expect(table.tools.map((t) => t.name)).toEqual(toolNames(h.a))
    expect(table.policyVersion).toBe('p1')
    expect(table.excluded.filter((entry) => entry.source === 'mcp')).toEqual([
      { source: 'mcp', serverId: 'fix', originalName: 'alpha', code: 'user-disabled' },
      // Denied by policy AND set to never: one code, the first in the order.
      { source: 'mcp', serverId: 'fix', originalName: 'zeta', code: 'policy' },
    ])
    // Nothing about the excluded tools beyond that record: no tool/ fact at all.
    expect(all.filter((entry) => entry.name.startsWith('tool/'))).toEqual([])
  })

  it('sorts the OpenAI-compatible wire’s tools the same way', async () => {
    const h = harness()
    const net = fakeNetwork([{ kind: 'sse', frames: openAIFixture.PLAIN_TEXT_FRAMES }])
    const zhipu = zhipuDefinition.create({
      network: net,
      clock: { now: () => 0, setTimeout: () => () => undefined },
      config: { baseURL: ZHIPU_DEFAULT_BASE_URL },
      secrets: { apiKey: 'test-key-not-a-real-credential' },
    })
    const glm = zhipuDefinition.builtinModels.find((m) => m.supportsToolCalling)
    if (glm === undefined) throw new Error('no zhipu model with tools')
    await send(h, {
      provider: zhipu,
      model: glm,
      mcpSources: [source('fix', [tool('zeta'), tool('beta'), tool('Mid')])],
    })
    const body = net.requests[0]?.body as { tools?: { function: { name: string } }[] }
    expect(body.tools?.map((t) => t.function.name)).toEqual([
      'AskUserQuestion',
      'Read',
      'WebFetch',
      'fix__Mid',
      'fix__beta',
      'fix__zeta',
    ])
  })

  it('keeps a table verbatim when a tool is disabled after it froze (旧 149, tools half)', async () => {
    let off = false
    const h = harness({
      userSetting: (key) => (off && key.toolName === 'beta' ? { connectorOff: true } : null),
    })
    const sources = [source('fix', [tool('beta')])]
    await send(h, { mcpSources: sources })
    off = true
    await send(h, { mcpSources: sources })
    expect(toolNames(h.a, -1)).toEqual(toolNames(h.a, -2))
    expect(toolNames(h.a)).toContain('fix__beta')
    expect(named(await entries(h.store), 'view/tool_table')).toHaveLength(1)
  })

  it('blocks a call to a tool the user disabled after the freeze: user-disabled, the table unchanged (旧 149, 旧 124)', async () => {
    let off = false
    const h = harness({
      userSetting: (key) => (off && key.toolName === 'beta' ? { connectorOff: true } : null),
    })
    const called: string[] = []
    const sources = [source('fix', [tool('beta')], called)]
    await send(h, { mcpSources: sources })
    off = true
    await send(h, { mcpSources: sources, turns: [callReply('fix__beta'), answered()] })
    expect(called).toEqual([])
    const all = await entries(h.store)
    const { result, outcome } = closure(all)
    expect(result).toMatchObject({
      isError: true,
      kernelAuthored: true,
      content: [{ type: 'text', text: MODEL_NOTES.closure['user-disabled']['not-run'] }],
    })
    expect(outcome).toMatchObject({
      effect: 'blocked',
      state: 'not-run',
      source: 'user-disabled',
      facts: { toolName: 'beta' },
    })
    const [decided] = decisionsOf(all)
    expect([decided?.record.verdict, decided?.record.decidedBy]).toEqual(['deny', 'user-disabled'])
    expect(decided?.block).toEqual({ reason: 'user-disabled', facts: { toolName: 'beta' } })
    expect(named(all, 'execution/dispatch_committed')).toEqual([])
    // The receipt goes out, and the definitions stay what froze: one table, the same bytes.
    const receipts = h.loop.recorded.filter((event) => event.type === 'tool-outcome')
    expect(receipts.map((event) => event.outcome.source)).toEqual(['user-disabled'])
    expect(named(all, 'view/tool_table')).toHaveLength(1)
    const tools = h.a.requests.map((request) =>
      JSON.stringify((request.body as { tools?: unknown }).tools),
    )
    expect(new Set(tools).size).toBe(1)
    expect(toolNames(h.a)).toContain('fix__beta')
  })

  it('blocks it as policy when the policy denies it after the freeze (旧 149, 旧 124)', async () => {
    const h = harness()
    const called: string[] = []
    const sources = [source('fix', [tool('beta')], called)]
    await send(h, { mcpSources: sources })
    h.host.setPolicy({
      status: 'current',
      version: 'p2',
      snapshot: {
        tools: [{ policyId: 'deny-beta', serverId: 'fix', effect: 'deny', toolName: 'beta' }],
      },
    })
    await send(h, { mcpSources: sources, turns: [callReply('fix__beta'), answered()] })
    expect(called).toEqual([])
    const all = await entries(h.store)
    expect(closure(all).outcome).toMatchObject({ state: 'not-run', source: 'policy' })
    const [decided] = decisionsOf(all)
    expect([decided?.record.decidedBy, decided?.policyVersion]).toEqual(['tenant-policy', 'p2'])
    expect(named(all, 'view/tool_table')).toHaveLength(1)
  })

  it('keeps a tool excluded at the opening out of this session when re-enabled, with no decision for a call (旧 149, 旧 124)', async () => {
    let never = true
    const h = harness({
      userSetting: (key) => (never && key.toolName === 'beta' ? { userSetting: 'never' } : null),
    })
    const called: string[] = []
    const sources = [source('fix', [tool('beta')], called)]
    await send(h, { mcpSources: sources })
    expect(toolNames(h.a)).not.toContain('fix__beta')
    never = false
    // The model calls it anyway: it is not in the frozen table, so it is unavailable, not judged.
    await send(h, { mcpSources: sources, turns: [callReply('fix__beta'), answered()] })
    expect(toolNames(h.a)).not.toContain('fix__beta')
    let all = await entries(h.store)
    expect(closure(all).outcome).toMatchObject({ state: 'not-run', source: 'tool-unavailable' })
    expect(decisionsOf(all)).toEqual([])
    expect(called).toEqual([])
    // A new session opens its own table, and there it is.
    const other = '0b8f2a1c-3d4e-4f50-8a61-7b2c3d4e5f61'
    await send(h, { mcpSources: sources }, other)
    expect(toolNames(h.a)).toContain('fix__beta')
    all = await entries(h.store)
    expect(named(all, 'view/tool_table')).toHaveLength(1)
  })

  it('keeps requiresUserInteraction as frozen when the server later says otherwise, and asks on it (旧 145)', async () => {
    const h = harness()
    await send(h, {
      mcpSources: [source('fix', [tool('ask', { 'anthropic/requiresUserInteraction': true })])],
    })
    // The server changes its answer; the table is rebuilt from the tape, not from tools/list.
    await send(h, { mcpSources: [source('fix', [tool('ask')])] })
    const tables = named(await entries(h.store), 'view/tool_table')
    expect(tables).toHaveLength(1)
    const frozen = tables[0]?.payload as unknown as ToolTablePayload
    expect(frozen.tools.find((t) => t.originalName === 'ask')?.requiresUserInteraction).toBe(true)

    // Restarted on the same Tape, the server now saying false and the user always allowing the tool:
    // the call still asks, as interaction-required, once (§工具来源、命名与权限键「改不了已冻结的标记」).
    const restarted = harness(
      { userSetting: () => ({ userSetting: 'always-allow' }) },
      { store: h.store, idsFrom: 100 },
    )
    const called: string[] = []
    await send(restarted, {
      mcpSources: [source('fix', [tool('ask')], called)],
      turns: [callReply('fix__ask')],
    })
    const pending = await restarted.service.currentPending({ sessionId: SESSION })
    expect(pending?.card.reason).toBe('interaction-required')
    expect(pending?.allowScope).toBe('once')
    const decided = decisionsOf(await entries(h.store)).at(-1)
    expect([decided?.record.verdict, decided?.record.decidedBy]).toEqual([
      'ask',
      'connector-confirm',
    ])
    expect(called).toEqual([])
  })

  it('closes a call to a frozen tool with no implementation as unavailable, uncounted, its definition kept (旧 151)', async () => {
    const h = harness()
    await send(h)
    expect(toolNames(h.a)).toContain('WebFetch')
    const frozen = named(await entries(h.store), 'provider/attempt_completed')[0]?.payload[
      'toolDefinitionsHash'
    ]
    // Restarted on a build without WebFetch's executor: three calls in a row, then an answer.
    const restarted = harness({}, { store: h.store, idsFrom: 100, tools: { WebFetch: null } })
    const fetch = (): StreamEvent[] => callReply('WebFetch', { url: 'https://example.com/' })
    await send(restarted, { turns: [fetch(), fetch(), fetch(), answered()] })
    const all = await entries(h.store)
    expect(named(all, 'execution/tool_outcome').map((e) => e.payload['source'])).toEqual([
      'tool-unavailable',
      'tool-unavailable',
      'tool-unavailable',
    ])
    // Not a machine denial: the Run answers instead of ending blocked-repeatedly.
    expect(named(all, 'execution/run_terminal').at(-1)?.payload['reason']).toEqual({
      code: 'completed',
    })
    expect(decisionsOf(all)).toEqual([])
    const receipts = restarted.loop.recorded.filter((event) => event.type === 'tool-outcome')
    expect(receipts.map((event) => event.outcome.permission)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    for (let i = 0; i < restarted.a.requests.length; i += 1)
      expect(toolNames(restarted.a, i)).toContain('WebFetch')
    expect(
      new Set(
        named(all, 'provider/attempt_completed').map((e) => e.payload['toolDefinitionsHash']),
      ),
    ).toEqual(new Set([frozen]))
  })

  it('opens a fresh first-use table after a reset, generation 0, new incarnation (旧 151)', async () => {
    const h = harness()
    await send(h)
    const before = named(await entries(h.store), 'view/tool_table')[0]?.provenanceKey
    const reset = await h.service.resetSession(SESSION)
    await send(h)
    const after = named(await entries(h.store), 'view/tool_table')
    expect(after).toHaveLength(1)
    const payload = after[0]?.payload as unknown as ToolTablePayload
    expect(payload).toMatchObject({ reason: 'first-use', generation: 0 })
    expect(after[0]?.provenanceKey).toBe(`view:v1:tool_table:${reset.incarnationId}:0:anthropic`)
    expect(after[0]?.provenanceKey).not.toBe(before)
  })
})

/** Each request's messages start with the previous request's, and its tools are the same bytes. */
function assertPrefixes(bodies: readonly { messages: unknown[]; tools?: unknown }[]): void {
  expect(bodies.length).toBeGreaterThan(2)
  for (let i = 1; i < bodies.length; i += 1) {
    const previous = bodies[i - 1]
    const current = bodies[i]
    if (previous === undefined || current === undefined) throw new Error('missing request')
    expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages)
    expect(JSON.stringify(current.tools)).toBe(JSON.stringify(bodies[0]?.tools))
  }
}

describe('the prefix discipline (A13; 旧 32, the part without approvals)', () => {
  it('holds on the Anthropic wire', async () => {
    expect.hasAssertions()
    const h = harness()
    const sources = [source('fix', [tool('beta')])]
    for (let i = 0; i < 3; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one message after the other
      await send(h, { mcpSources: sources })
    }
    assertPrefixes(h.a.requests.map((request) => request.body as { messages: unknown[] }))
  })

  it('holds on the OpenAI-compatible wire', async () => {
    expect.hasAssertions()
    const h = harness()
    const net = fakeNetwork(
      Array.from({ length: 3 }, () => ({
        kind: 'sse' as const,
        frames: openAIFixture.PLAIN_TEXT_FRAMES,
      })),
    )
    const zhipu = zhipuDefinition.create({
      network: net,
      clock: { now: () => 0, setTimeout: () => () => undefined },
      config: { baseURL: ZHIPU_DEFAULT_BASE_URL },
      secrets: { apiKey: 'test-key-not-a-real-credential' },
    })
    const glm = zhipuDefinition.builtinModels.find((m) => m.supportsToolCalling)
    if (glm === undefined) throw new Error('no zhipu model with tools')
    for (let i = 0; i < 3; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one message after the other
      await send(h, { provider: zhipu, model: glm, mcpSources: [source('fix', [tool('beta')])] })
    }
    assertPrefixes(net.requests.map((request) => request.body as { messages: unknown[] }))
  })
})

describe('requests that carry no tools (A14, A15)', () => {
  it('switches to a model without tools with one tools_withheld, and back to the frozen hash (旧 150)', async () => {
    const h = harness()
    await send(h)
    await send(h, { model: MODEL_A_TEXT })
    await send(h, { model: MODEL_A_TEXT })
    await send(h)
    expect(toolNames(h.a, 1)).toBeUndefined()
    expect(toolNames(h.a, 2)).toBeUndefined()
    expect(toolNames(h.a, 3)).toEqual(toolNames(h.a, 0))
    const all = await entries(h.store)
    const withheld = named(all, 'view/tools_withheld').map(
      (entry) => entry.payload as unknown as ToolsWithheldPayload,
    )
    expect(withheld).toEqual([
      {
        providerId: 'anthropic',
        modelId: 'hand-typed',
        tableKey: named(all, 'view/tool_table')[0]?.provenanceKey,
        reason: 'model-without-tools',
      },
    ])
    const hashes = named(all, 'provider/attempt_completed').map(
      (e) => e.payload['toolDefinitionsHash'],
    )
    expect(hashes[3]).toBe(hashes[0])
    expect(hashes[1]).toBe(hashes[2])
    expect(hashes[1]).not.toBe(hashes[0])
    await assertToolHashes(h.store)
  })

  it('sends a text-only provider none, recorded once, with its table opened as usual (A14)', async () => {
    const h = harness()
    await send(h, { toolsWithheld: 'provider-text-only' })
    await send(h, { toolsWithheld: 'provider-text-only' })
    expect(toolNames(h.a)).toBeUndefined()
    const all = await entries(h.store)
    expect(named(all, 'view/tool_table')).toHaveLength(1)
    expect(
      named(all, 'view/tools_withheld').map(
        (entry) => (entry.payload as unknown as ToolsWithheldPayload).reason,
      ),
    ).toEqual(['provider-text-only'])
    await assertToolHashes(h.store)
  })
})
