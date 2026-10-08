// Each send advances the same frozen session; assertions inspect facts after its commit.
// oxlint-disable no-await-in-loop
import { expect, it, vi } from 'vitest'
import { createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type {
  McpConnection,
  McpToolSource,
  RunAssembly,
  TapeStore,
  StreamEvent,
  ToolTablePayload,
} from '../../src/index.js'
import {
  recheckAttempt,
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type { TestServiceExtras } from '../../src/testing/index.js'
import { anthropicModel } from '../provider/wire/fixtures.js'
import { McpUnauthorizedError } from '../../src/mcp/connection.js'
import { MODEL_NOTES, fill } from '../../src/prompts/index.js'
import { sha256Hex } from '../../src/tape/hash.js'
import { mcpCandidates } from '../../src/tools/mcp-source.js'
import { openToolTable, rebuildToolTable, specHash } from '../../src/tools/table.js'
import type { ToolCandidate } from '../../src/tools/registry.js'
import { EMPTY_POLICY } from '../../src/host/policy.js'

const SESSION = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'
const MODEL = anthropicModel({ reasoning: false })
const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}
const raw = (description = 'fixture') => ({
  name: 'echo',
  description,
  inputSchema: { type: 'object' as const },
})
function source(
  over: Partial<McpToolSource> = {},
  callTool: McpConnection['callTool'] = async () => ({
    content: [{ type: 'text', text: 'fixture result' }],
  }),
): McpToolSource {
  return {
    serverId: 'fixture',
    connection: { listTools: async () => [raw()], callTool } as unknown as McpConnection,
    ...over,
  }
}
function harness(
  sources: readonly McpToolSource[],
  extras: Omit<TestServiceExtras, 'tools'> = {},
  table?: RunAssembly['mcpTable'],
  store?: TapeStore,
  threshold?: number,
) {
  const host = createMemoryHost()
  const tape = store ?? createMemoryTapeStore({ identity: host.identity })
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({
    connector: {
      provider,
      model: MODEL,
      mcpSources: sources,
      ...(table === undefined ? {} : { mcpTable: table }),
    },
  })
  const service = createTestSessionService(
    {
      host,
      tape,
      ids: createCounterIds({ start: store ? 1000 : 1 }),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
      ...(threshold === undefined ? {} : { compactionThreshold: threshold }),
    },
    { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }), ...extras },
  )
  service.bindLoop(loop)
  return { host, tape, provider, loop, service }
}
function call(): StreamEvent[] {
  return [
    { type: 'tool-call-start', index: 0, id: 'fixture-call', name: 'fixture__echo' },
    { type: 'tool-call-end', index: 0, id: 'fixture-call', name: 'fixture__echo', input: {} },
    { type: 'usage', usage: USAGE },
    stopEvent('tool-use', 'tool_use'),
  ]
}
let message = 0
async function send(
  h: ReturnType<typeof harness>,
  turns = [scriptedTurn({ deltas: ['done'], usage: USAGE })],
) {
  for (const turn of turns) h.provider.script(turn)
  const sent = await h.service.send({
    sessionId: SESSION,
    origin: null,
    text: `message ${++message}`,
  })
  if (sent.status !== 'started') throw new Error('send did not start')
  return h.loop.runEnded({ runId: sent.runId })
}
async function facts(store: TapeStore) {
  return (await store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}
function opening(
  candidates: readonly ToolCandidate[],
  extra: Partial<Parameters<typeof openToolTable>[0]> = {},
) {
  return openToolTable({
    providerId: 'anthropic',
    incarnationId: SESSION,
    generation: 0,
    reason: 'first-use',
    candidates,
    tenantId: 'tenant',
    policy: { status: 'current', version: 'empty', snapshot: EMPTY_POLICY },
    userSetting: () => null,
    hasSearchBackend: false,
    toolsPerRequest: null,
    ...extra,
  })
}
it('03 验收 32 / 38: oversized and changed definitions never enter a new table', async () => {
  const huge = source({
    connection: { listTools: async () => [raw('a'.repeat(65_537))] } as unknown as McpConnection,
  })
  expect(opening(await mcpCandidates([huge])).excluded[0]?.code).toBe('invalid-definition')
  expect(
    opening(await mcpCandidates([source({ review: () => 'changed' })])).excluded[0]?.code,
  ).toBe('definition-changed')
})
it('03 验收 21 (closure): unauthorized closes not-run and the Run goes on; outcome carries reversibility', async () => {
  const execute = vi.fn<McpConnection['callTool']>(async () => {
    throw new McpUnauthorizedError()
  })
  const h = harness([source({}, execute)])
  expect(
    (await send(h, [call(), scriptedTurn({ deltas: ['done'], usage: USAGE })])).reason.code,
  ).toBe('completed')
  const all = await facts(h.tape)
  expect(all.find((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
    source: 'connector-unauthorized',
    state: 'not-run',
    effect: 'blocked',
  })
  expect(all.find((e) => e.name === 'tool/result')?.payload).toMatchObject({
    kernelAuthored: true,
    isError: true,
    content: [{ type: 'text', text: MODEL_NOTES.closure['connector-unauthorized']['not-run'] }],
  })
  expect(h.loop.recorded.find((e) => e.type === 'tool-outcome')).toMatchObject({
    outcome: { reversibility: 'unknown' },
  })
  const rows = await h.service.listMessages({ sessionId: SESSION, limit: 100 })
  expect(
    rows.flatMap((row) => row.calls ?? []).find((rowCall) => rowCall.outcome)?.outcome,
  ).toMatchObject({ reversibility: 'unknown' })
})
it('03 验收 29: only opening a table calls mcpTable; a late source is dispatched in that same Run', async () => {
  const execute = vi.fn<McpConnection['callTool']>(async () => ({ content: [] }))
  const late = source({}, execute)
  const table = vi.fn<NonNullable<RunAssembly['mcpTable']>>(async () => ({
    sources: [late],
    absent: [],
  }))
  const h = harness([], {}, table)
  expect(
    (await send(h, [call(), scriptedTurn({ deltas: ['done'], usage: USAGE })])).reason.code,
  ).toBe('completed')
  expect(execute).toHaveBeenCalledTimes(1)
  await send(h)
  expect(table).toHaveBeenCalledTimes(1)
})
it('03 验收 21 / 29: absent cached tools record unauthorized or unavailable, never-connected servers record nothing', async () => {
  const absentCode = 'connector-unavailable' as const
  const table: NonNullable<RunAssembly['mcpTable']> = async () => ({
    sources: [],
    absent: [
      { serverId: 'fixture', code: 'connector-unauthorized', cachedTools: ['echo'] },
      { serverId: 'offline', code: 'connector-unavailable', cachedTools: ['cached'] },
      { serverId: 'new', code: absentCode, cachedTools: [] },
    ],
  })
  const h = harness([], {}, table)
  await send(h)
  const payload = (await facts(h.tape)).find((e) => e.name === 'view/tool_table')
    ?.payload as unknown as ToolTablePayload
  expect(payload.excluded.filter((entry) => entry.source === 'mcp')).toEqual([
    { source: 'mcp', serverId: 'fixture', originalName: 'echo', code: 'connector-unauthorized' },
    { source: 'mcp', serverId: 'offline', originalName: 'cached', code: 'connector-unavailable' },
  ])
})
it('03 验收 38 (resume) / 03 不变量 6: frozen definitionHash survives Tape restart and layer 6 sees the frozen value', async () => {
  const keys: string[] = []
  const setting: TestServiceExtras['userSetting'] = (key) => {
    if (key.definitionHash) keys.push(key.definitionHash)
    return { userSetting: 'always-allow' }
  }
  const h = harness([source()], { userSetting: setting })
  await send(h)
  const table = (await facts(h.tape)).find((e) => e.name === 'view/tool_table')
    ?.payload as unknown as ToolTablePayload
  const frozen = table.tools.find((tool) => tool.source === 'mcp')!.definitionHash!
  const changed = source({
    connection: {
      listTools: async () => [raw('changed')],
      callTool: async () => ({ content: [] }),
    } as unknown as McpConnection,
  })
  const resumed = harness([changed], { userSetting: setting }, undefined, h.tape)
  expect(
    (await send(resumed, [call(), scriptedTurn({ deltas: ['done'], usage: USAGE })])).reason.code,
  ).toBe('completed')
  expect(keys.at(-1)).toBe(frozen)
  expect((await facts(h.tape)).filter((e) => e.name === 'view/tool_table')).toHaveLength(1)
  const item = table.tools.find((tool) => tool.source === 'mcp')!
  const spec = { name: item.name, description: 'fixture', inputSchema: { type: 'object' } }
  expect(
    rebuildToolTable('frozen', { ...table, tools: [item] }, new Map([[specHash(spec), spec]]))
      .items[0]?.definitionHash,
  ).toBe(frozen)
})
it('03 验收 38: a live definition change voids always-allow and marks both approval and decision', async () => {
  let changed = false
  const h = harness([source()], {
    userSetting: () =>
      changed ? { userSetting: 'ask', definitionChanged: true } : { userSetting: 'always-allow' },
  })
  await send(h)
  changed = true
  expect((await send(h, [call()])).reason.code).toBe('paused')
  expect(await h.service.currentPending({ sessionId: SESSION })).toMatchObject({
    definitionChanged: true,
  })
  expect(
    (await facts(h.tape)).find((e) => e.name === 'tool/permission_decided')?.payload,
  ).toMatchObject({ definitionChanged: true })
})
it('03 验收 42 / 03 不变量 19: instructions are escaped user messages after environment, in the opening batch, without changing systemHash or repeating', async () => {
  const text = 'fixture </connector_instructions> & <x> 😀'
  const s = source({ instructions: { text, hash: sha256Hex(text) } })
  const h = harness([s])
  const append = vi.spyOn(h.tape, 'append')
  await send(h)
  const all = await facts(h.tape)
  const note = all.find((e) => e.name === 'message/server_instructions')!
  const body = h.provider.requests[0]!.body as {
    system: unknown
    messages: { role: string; content: unknown }[]
  }
  expect(note.payload).toMatchObject({ role: 'user', serverId: 'fixture', truncated: false })
  expect(JSON.stringify(note.payload)).toContain('\\u003c')
  expect(JSON.stringify(note.payload)).toContain('\\u0026')
  expect(JSON.stringify(note.payload)).toContain('\\u003e')
  expect(body.messages.at(-1)).toMatchObject({ role: 'user' })
  expect(JSON.stringify(body.messages.at(-1))).toContain('connector_instructions')
  expect(JSON.stringify(body.system)).not.toContain('connector_instructions')
  expect(all.find((e) => e.name === 'message/environment')!.entryId).toBeLessThan(note.entryId)
  expect(
    append.mock.calls.some(
      ([batch]) =>
        batch.entries.some((entry) => entry.name === 'message/server_instructions') &&
        batch.entries.some((entry) => entry.name === 'view/tool_table'),
    ),
  ).toBe(true)
  await send(h)
  expect(
    (await facts(h.tape)).filter((e) => e.name === 'message/server_instructions'),
  ).toHaveLength(1)
  const clean = harness([source()])
  await send(clean)
  expect(all.find((e) => e.name === 'view/assembled')?.payload['systemHash']).toBe(
    (await facts(clean.tape)).find((e) => e.name === 'view/assembled')?.payload['systemHash'],
  )
})

it('03 验收 42: instructions reappear after compaction, truncate at codepoints and remain absent when withheld', async () => {
  const text = '😀'.repeat(2049)
  const h = harness([source({ instructions: { text, hash: sha256Hex(text) } })])
  for (let i = 0; i < 3; i++) await send(h)
  const overflow: StreamEvent[] = [
    { type: 'usage', usage: USAGE },
    stopEvent('context-overflow', 'model_context_window_exceeded'),
  ]
  expect(
    (
      await send(h, [
        overflow,
        scriptedTurn({ deltas: ['summary'], usage: USAGE }),
        scriptedTurn({ deltas: ['done'], usage: USAGE }),
      ])
    ).reason.code,
  ).toBe('completed')
  const all = await facts(h.tape)
  const notes = all.filter((e) => e.name === 'message/server_instructions')
  expect(notes).toHaveLength(2)
  expect(notes[1]!.entryId).toBeGreaterThan(
    all.find((e) => e.name === 'compaction/anchor')!.entryId,
  )
  expect(notes[1]!.entryId).toBeGreaterThan(
    all.findLast((e) => e.name === 'message/environment' && e.entryId < notes[1]!.entryId)!.entryId,
  )
  expect(notes[0]!.payload['truncated']).toBe(true)
  const wrapped = String((notes[0]!.payload['content'] as { text: string }[])[0]?.text)
  expect(
    Array.from(wrapped.match(/>(".*")<\/connector_instructions>/)![1]!).filter(
      (point) => point === '😀',
    ),
  ).toHaveLength(2048)
  const withheld = harness([source()])
  await send(withheld)
  expect((await facts(withheld.tape)).some((e) => e.name === 'message/server_instructions')).toBe(
    false,
  )
})
it('03 验收 30 (loop): an in-flight stopped connector closes stopped / uncertain', async () => {
  let began!: () => void
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  const h = harness([
    source({}, async (_name, _args, options) => {
      began()
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new Error('stop')), { once: true }),
      )
    }),
  ])
  h.provider.script(call())
  const pending = h.service.send({ sessionId: SESSION, origin: null, text: `stop ${++message}` })
  const sent = await pending
  if (sent.status !== 'started') throw new Error('send did not start')
  await started
  await h.service.stop({ rootSessionId: SESSION })
  await h.loop.runEnded({ runId: sent.runId })
  expect(
    (await facts(h.tape)).find((e) => e.name === 'execution/tool_outcome')?.payload,
  ).toMatchObject({ source: 'stopped', state: 'uncertain' })
})
it('03 验收 38 (legacy): a frozen item without definitionHash asks rather than always-allows; never still blocks', async () => {
  const { judgeCall } = await import('../../src/loop/batch.js')
  const { createTape } = await import('../../src/index.js')
  const h = harness([source()])
  await send(h)
  const candidate = (await mcpCandidates([source()]))[0]!
  const { definitionHash: _hash, ...old } = candidate
  const ctx = {
    tape: createTape(h.tape),
    host: h.host,
    sessionId: SESSION,
    inspectors: [],
    protectedFiles: [],
    searchHost: null,
    signal: new AbortController().signal,
    userSetting: () => ({ userSetting: 'always-allow' as const, definitionChanged: true as const }),
  }
  const asked = await judgeCall(ctx, old, { input: {} })
  expect(asked).toMatchObject({ kind: 'judged', decision: { record: { verdict: 'ask' } } })
  expect(asked).not.toHaveProperty('definitionChanged')
  expect(
    await judgeCall({ ...ctx, userSetting: () => ({ userSetting: 'never' }) }, old, { input: {} }),
  ).toMatchObject({ decision: { record: { verdict: 'deny' } } })
})

it('03 不变量 6: a changed live snapshot leaves frozen tools and toolDefinitionsHash unchanged', async () => {
  let description = 'original definition'
  const base = source()
  const s = {
    ...base,
    connection: { ...base.connection, listTools: async () => [raw(description)] } as McpConnection,
  }
  const h = harness([s])
  await send(h)
  const before = await facts(h.tape)
  const table = before.find((e) => e.name === 'view/tool_table')!.payload
  description = 'changed live definition'
  expect(
    (await send(h, [call(), scriptedTurn({ deltas: ['done'], usage: USAGE })])).reason.code,
  ).toBe('completed')
  const tables = (await facts(h.tape)).filter((e) => e.name === 'view/tool_table')
  expect(tables).toHaveLength(1)
  expect(tables[0]!.payload).toEqual(table)
  expect(JSON.stringify(h.provider.requests.at(-1)?.body)).toContain('original definition')
  expect(JSON.stringify(h.provider.requests.at(-1)?.body)).not.toContain('changed live definition')
})

it('03 验收 36 / 03 不变量 9: readOnlyHint never bypasses manual approval', async () => {
  const execute = vi.fn<McpConnection['callTool']>(async () => ({ content: [] }))
  const base = source({}, execute)
  const s = {
    ...base,
    connection: {
      ...base.connection,
      listTools: async () => [
        { ...raw(), annotations: { readOnlyHint: true, destructiveHint: false } },
      ],
    } as McpConnection,
  }
  const h = harness([s], { userSetting: () => ({ userSetting: 'ask' }) })
  expect((await send(h, [call()])).reason.code).toBe('paused')
  expect(await h.service.currentPending({ sessionId: SESSION })).not.toBeNull()
  expect(execute).not.toHaveBeenCalled()
})

it('03 验收 32: physical depth and reference expansion guards exclude invalid definitions at table opening', async () => {
  let nested: Record<string, unknown> = {}
  for (let i = 1; i < 33; i++) nested = { items: nested }
  for (const schema of [nested, { allOf: Array.from({ length: 10001 }, () => ({})) }]) {
    const base = source()
    const s = {
      ...base,
      connection: {
        ...base.connection,
        listTools: async () => [{ ...raw(), inputSchema: { type: 'object' as const, ...schema } }],
      } as McpConnection,
    }
    expect(opening(await mcpCandidates([s])).excluded[0]?.code).toBe('invalid-definition')
  }
})

it('03 验收 21: repeated unauthorized calls never consume the machine-blocked cap and the Run continues', async () => {
  const execute = vi.fn<McpConnection['callTool']>(async () => {
    throw new McpUnauthorizedError()
  })
  const h = harness([source({}, execute)])
  expect(
    (await send(h, [call(), call(), call(), scriptedTurn({ deltas: ['done'], usage: USAGE })]))
      .reason.code,
  ).toBe('completed')
  expect(execute).toHaveBeenCalledTimes(3)
  const outcomes = (await facts(h.tape)).filter((entry) => entry.name === 'execution/tool_outcome')
  expect(outcomes).toHaveLength(3)
  expect(
    outcomes.every(
      (entry) =>
        entry.payload['source'] === 'connector-unauthorized' &&
        entry.payload['state'] === 'not-run',
    ),
  ).toBe(true)
})

it('03 验收 3 (loop): a crash between Runs waits through the frozen proxy and succeeds; an in-flight crash closes connectorFailed completed', async () => {
  const { createMcpPool } = await import('../../src/mcp/pool.js')
  const connections = await import('../../src/mcp/connection.js')
  const { absolutePath } = await import('../../src/index.js')
  const host = createMemoryHost()
  const make = () => {
    let exit!: () => void
    const execute = vi.fn<McpConnection['callTool']>(async () => ({ content: [] }))
    const connection = {
      name: 'fixture',
      client: {},
      instructions: '',
      era: 'legacy',
      protocolVersion: '2025-11-25',
      serverVersion: undefined,
      listTools: async () => [raw()],
      callTool: execute,
      close: async () => {},
      exited: new Promise<{ code: number; signal: null }>((resolve) => {
        exit = () => resolve({ code: 1, signal: null })
      }),
    } as unknown as McpConnection
    return { connection, execute, exit }
  }
  const first = make()
  const second = make()
  const connect = vi
    .spyOn(connections, 'connectStdioServer')
    .mockResolvedValueOnce(first.connection)
    .mockResolvedValueOnce(second.connection)
  const runtime = {
    serverId: 'fixture',
    launchHash: 'launch',
    consented: true,
    transport: { type: 'stdio' as const, command: '/bin/node', args: [], envs: {}, envKeys: [] },
    handshakeTimeoutMs: 30000,
    callTimeoutMs: 1000,
    rank: 0,
    toolsPinned: false,
    pins: {},
    instructions: { enabled: false, pinHash: null },
  }
  const pool = createMcpPool({
    host,
    ids: { uuid: () => crypto.randomUUID() },
    baseEnv: async () => ({}),
    homeDir: absolutePath('/'),
    resolveCommand: async () => ({ ok: true, path: absolutePath('/bin/node') }),
    runtimeOf: () => runtime,
    log: () => {},
    onPin: async () => {},
    onIssuer: async () => {},
    onChange: () => {},
  })
  try {
    pool.apply([runtime])
    await vi.waitFor(() => expect(pool.status()[0]?.phase).toBe('connected'))
    const h = harness(pool.routes())
    await send(h)
    const table = (await facts(h.tape)).find((entry) => entry.name === 'view/tool_table')!.payload
    first.exit()
    await vi.waitFor(() => expect(pool.status()[0]?.phase).toBe('restarting'))
    const waiting = send(h, [call(), scriptedTurn({ deltas: ['done'], usage: USAGE })])
    await vi.waitFor(() => expect(h.provider.requests).toHaveLength(2))
    expect(second.execute).not.toHaveBeenCalled()
    host.advance(1000)
    expect((await waiting).reason.code).toBe('completed')
    expect(second.execute).toHaveBeenCalledTimes(1)
    let fail!: (error: Error) => void
    second.execute.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    const running = send(h, [call(), scriptedTurn({ deltas: ['continued'], usage: USAGE })])
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'))
    second.exit()
    fail(new Error('fixture crashed'))
    expect((await running).reason.code).toBe('completed')
    const all = await facts(h.tape)
    expect(
      all.filter((entry) => entry.name === 'view/tool_table').map((entry) => entry.payload),
    ).toEqual([table])
    expect(all.findLast((entry) => entry.name === 'execution/tool_outcome')?.payload).toMatchObject(
      { state: 'completed', source: null },
    )
    expect(all.findLast((entry) => entry.name === 'tool/result')?.payload).toMatchObject({
      isError: true,
      content: [
        { type: 'text', text: fill(MODEL_NOTES.connectorFailed, { message: 'fixture crashed' }) },
      ],
    })
  } finally {
    const closing = pool.close({ deadlineMs: 0 })
    host.advance(0)
    await closing
    connect.mockRestore()
  }
})

it('03 验收 42: first use with instructions and threshold compaction never conflicts with assembled provenance, and every attempt verifies', async () => {
  const h = harness([], {}, undefined, undefined, 1000)
  for (let i = 0; i < 3; i++) await send(h)
  const model = { ...MODEL, providerId: 'zhipu', id: 'second-provider' }
  const provider = createScriptedProvider({ id: model.providerId, models: [model] })
  const text = '😀'.repeat(2048)
  h.loop.connector.use({
    provider,
    model,
    mcpSources: [source({ instructions: { text, hash: sha256Hex(text) } })],
  })
  await h.service.selectModel({
    sessionId: SESSION,
    origin: null,
    choice: { providerId: model.providerId, modelId: model.id, effort: null },
  })
  provider.script(scriptedTurn({ deltas: ['summary'], usage: USAGE }))
  provider.script(scriptedTurn({ deltas: ['done'], usage: USAGE }))
  expect((await send(h, [])).reason.code).toBe('completed')
  const all = await facts(h.tape)
  expect(
    all.some(
      (entry) =>
        entry.name === 'compaction/anchor' &&
        entry.payload['trigger'] &&
        (entry.payload['trigger'] as { code: string }).code === 'threshold',
    ),
  ).toBe(true)
  for (const attempt of all.filter((entry) => entry.name === 'provider/attempt_completed'))
    expect(
      (
        await recheckAttempt(h.tape, {
          sessionId: SESSION,
          attempt,
          currentModel: (providerId) => (providerId === MODEL.providerId ? MODEL : model),
        })
      ).verdict,
    ).toBe('verified')
  const note = all.findLast((entry) => entry.name === 'message/server_instructions')!
  const environment = all.findLast((entry) => entry.name === 'message/environment')!
  expect(note.entryId).toBeGreaterThan(environment.entryId)
  expect(
    JSON.stringify(provider.requests.at(-1)!.body).match(/<connector_instructions/g),
  ).toHaveLength(1)
})

it('03 验收 29 / 03 不变量 11: a real HTTP pool first-wait timeout and unauthorized or waited-out frozen calls never reach tools/call; connecting early succeeds', async () => {
  const { createMcpPool, absolutePath } = await import('../../src/index.js')
  const { startHttpFixture } = await import('../support/http-fixture.js')
  const fixture = await startHttpFixture({ era: 'legacy' })
  const host = createMemoryHost()
  let release!: () => void
  let hold = true
  let down = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = {
    serverId: 'fixture',
    launchHash: 'launch',
    consented: true,
    transport: {
      type: 'http' as const,
      url: fixture.url,
      protocol: 'legacy' as const,
      headerKeys: [],
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (hold) await gate
        if (down) throw new TypeError('fixture offline')
        return fetch(input, init)
      },
      oauth: { issuers: [], ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
    },
    handshakeTimeoutMs: 30000,
    callTimeoutMs: 1000,
    rank: 0,
    toolsPinned: false,
    pins: {},
    instructions: { enabled: false, pinHash: null },
  }
  const pool = createMcpPool({
    host,
    ids: { uuid: () => crypto.randomUUID() },
    baseEnv: async () => ({}),
    homeDir: absolutePath('/'),
    resolveCommand: async () => ({ ok: false, code: 'command-not-found' }),
    runtimeOf: () => runtime,
    log: () => {},
    onPin: async () => {},
    onIssuer: async () => {},
    onChange: () => {},
  })
  try {
    const h = harness([source()])
    await send(h)
    pool.apply([runtime])
    h.loop.connector.use({ provider: h.provider, model: MODEL, mcpSources: pool.routes() })
    let settled = false
    const waiting = send(h, [call(), scriptedTurn({ deltas: ['continued'], usage: USAGE })])
    void waiting.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(h.provider.requests).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    host.advance(9999)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    host.advance(1)
    expect((await waiting).reason.code).toBe('completed')
    expect(
      (await facts(h.tape)).findLast((e) => e.name === 'execution/tool_outcome')?.payload,
    ).toMatchObject({ source: 'tool-unavailable', state: 'not-run' })
    expect(fixture.requests.filter((r) => r.method === 'tools/call')).toHaveLength(0)
    const succeeds = send(h, [call(), scriptedTurn({ deltas: ['done'], usage: USAGE })])
    await new Promise((resolve) => setTimeout(resolve, 10))
    hold = false
    release()
    expect((await succeeds).reason.code).toBe('completed')
    await vi.waitFor(() => expect(pool.status()[0]?.phase).toBe('connected'))
    expect(fixture.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1)
    fixture.set({ failNext: '403-scope' })
    await pool
      .routes()[0]!
      .connection.callTool('echo', {})
      .catch(() => {})
    expect(pool.status()[0]?.phase).toBe('unauthorized')
    const before = fixture.requests.filter((r) => r.method === 'tools/call').length
    await send(h, [call(), scriptedTurn({ deltas: ['continued'], usage: USAGE })])
    expect(
      (await facts(h.tape)).findLast((e) => e.name === 'execution/tool_outcome')?.payload,
    ).toMatchObject({ source: 'connector-unauthorized', state: 'not-run' })
    expect(fixture.requests.filter((r) => r.method === 'tools/call')).toHaveLength(before)
    pool.restart('fixture')
    await vi.waitFor(() => expect(pool.status()[0]?.phase).toBe('connected'))
    down = true
    await pool
      .routes()[0]!
      .connection.callTool('echo', {})
      .catch(() => {})
    await vi.waitFor(() =>
      expect(pool.status()[0]).toMatchObject({ phase: 'restarting', error: null }),
    )
    const expired = send(h, [call(), scriptedTurn({ deltas: ['continued'], usage: USAGE })])
    await new Promise((resolve) => setTimeout(resolve, 20))
    host.advance(30000)
    expect((await expired).reason.code).toBe('completed')
    expect(
      (await facts(h.tape)).findLast((e) => e.name === 'execution/tool_outcome')?.payload,
    ).toMatchObject({ source: 'tool-unavailable', state: 'not-run' })
    expect(fixture.requests.filter((r) => r.method === 'tools/call')).toHaveLength(before)
  } finally {
    hold = false
    release()
    const closing = pool.close({ deadlineMs: 0 })
    host.advance(0)
    await closing
    await fixture.close()
  }
})

it('03 验收 42: a second provider first-use deduplicates the same instructions hash; a changed hash writes a second note', async () => {
  const a = 'first instruction'
  const h = harness([source({ instructions: { text: a, hash: sha256Hex(a) } })])
  await send(h)
  for (const [providerId, text] of [
    ['zhipu', a],
    ['openai', 'changed instruction'],
  ] as const) {
    const model = { ...MODEL, providerId, id: providerId + '-fixture' }
    const provider = createScriptedProvider({ id: providerId, models: [model] })
    h.loop.connector.use({
      provider,
      model,
      mcpSources: [source({ instructions: { text, hash: sha256Hex(text) } })],
    })
    await h.service.selectModel({
      sessionId: SESSION,
      origin: null,
      choice: { providerId, modelId: model.id, effort: null },
    })
    provider.script(scriptedTurn({ deltas: ['done'], usage: USAGE }))
    expect((await send(h, [])).reason.code).toBe('completed')
    const notes = (await facts(h.tape)).filter((e) => e.name === 'message/server_instructions')
    expect(notes).toHaveLength(providerId === 'zhipu' ? 1 : 2)
    expect(notes.at(-1)?.payload['instructionsHash']).toBe(sha256Hex(text))
  }
})

it('03 验收 42: compaction estimateInput counts instructions written after the latest provider attempt', async () => {
  const { estimateInput } = await import('../../src/loop/compaction.js')
  const text = '说明'.repeat(1000)
  const h = harness([source({ instructions: { text, hash: sha256Hex(text) } })])
  await send(h)
  const all = await facts(h.tape)
  const note = all.find((e) => e.name === 'message/server_instructions')!
  const late = { ...note, entryId: all.at(-1)!.entryId + 1 }
  const request = { model: MODEL, messages: [], maxTokens: 1024 }
  expect(estimateInput([...all, late], request)).toBeGreaterThan(estimateInput(all, request))
})

it('03 验收 21: refresh succeeds but another 401 makes the real pool unauthorized and the Run closes not-run connector-unauthorized', async () => {
  const { createMcpPool, absolutePath } = await import('../../src/index.js')
  const { startHttpFixture, startFakeAuthServer } = await import('../support/http-fixture.js')
  const as = await startFakeAuthServer()
  const fixture = await startHttpFixture({ era: 'legacy', authUrl: as.url })
  const host = createMemoryHost()
  let tokenDown = false
  const runtime = {
    serverId: 'fixture',
    launchHash: 'launch',
    consented: true,
    transport: {
      type: 'http' as const,
      url: fixture.url,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          tokenDown &&
          new URL(input instanceof Request ? input.url : String(input)).pathname === '/token'
        )
          throw new TypeError('fixture token network down')
        return fetch(input, init)
      },
      protocol: 'legacy' as const,
      headerKeys: [],
      oauth: { issuers: [], ownClient: null, clientMetadataUrl: null, dcrRedirectPort: 53280 },
    },
    handshakeTimeoutMs: 30000,
    callTimeoutMs: 1000,
    rank: 0,
    toolsPinned: false,
    pins: {},
    instructions: { enabled: false, pinHash: null },
  }
  const pool = createMcpPool({
    host,
    ids: { uuid: () => crypto.randomUUID() },
    baseEnv: async () => ({}),
    homeDir: absolutePath('/'),
    resolveCommand: async () => ({ ok: false, code: 'command-not-found' }),
    runtimeOf: () => runtime,
    log: () => {},
    onPin: async () => {},
    onIssuer: async () => {},
    onChange: () => {},
  })
  let callback!: URLSearchParams
  try {
    pool.apply([runtime])
    await vi.waitFor(() => expect(pool.status()[0]?.phase).toBe('connected'))
    expect(
      await pool.login('fixture', {
        listen: async (port) => ({
          port,
          waitForCallback: async () => callback,
          close: async () => {},
        }),
        openUrl: async (url) => {
          const response = await fetch(url, { redirect: 'manual' })
          callback = new URL(response.headers.get('location')!).searchParams
        },
      }),
    ).toEqual({ ok: true })
    await vi.waitFor(() => expect(pool.status()[0]?.phase).toBe('connected'))
    const h = harness(pool.routes())
    await send(h)
    tokenDown = true
    fixture.set({ requireToken: 'force-refresh' })
    expect(
      (await send(h, [call(), scriptedTurn({ deltas: ['continued'], usage: USAGE })])).reason.code,
    ).toBe('completed')
    expect(pool.status()[0]?.phase).toBe('connected')
    expect(
      (await facts(h.tape)).findLast((e) => e.name === 'execution/tool_outcome')?.payload,
    ).toMatchObject({ state: 'completed', source: null })
    tokenDown = false
    fixture.set({ requireToken: 'never-accepted' })
    const before = as.requests.filter((r) => r.path === '/token').length
    expect(
      (await send(h, [call(), scriptedTurn({ deltas: ['continued'], usage: USAGE })])).reason.code,
    ).toBe('completed')
    expect(as.requests.filter((r) => r.path === '/token')).toHaveLength(before + 1)
    expect(pool.status()[0]?.phase).toBe('unauthorized')
    expect(
      (await facts(h.tape)).findLast((e) => e.name === 'execution/tool_outcome')?.payload,
    ).toMatchObject({ state: 'not-run', source: 'connector-unauthorized' })
  } finally {
    const closing = pool.close({ deadlineMs: 0 })
    host.advance(0)
    await closing
    await fixture.close()
    await as.close()
  }
})

it('02 environment timing / 03 验收 42: a mid-Run overflow without instructions writes no environment after its anchor', async () => {
  const h = harness([source()])
  for (let i = 0; i < 3; i++) await send(h)
  const overflow: StreamEvent[] = [
    { type: 'usage', usage: USAGE },
    stopEvent('context-overflow', 'model_context_window_exceeded'),
  ]
  expect(
    (
      await send(h, [
        call(),
        overflow,
        scriptedTurn({ deltas: ['summary'], usage: USAGE }),
        scriptedTurn({ deltas: ['done'], usage: USAGE }),
      ])
    ).reason.code,
  ).toBe('completed')
  const all = await facts(h.tape)
  const anchor = all.findLast((entry) => entry.name === 'compaction/anchor')!
  expect(anchor).toBeDefined()
  expect(
    all.filter((entry) => entry.entryId > anchor.entryId && entry.name === 'message/environment'),
  ).toEqual([])
})

it('03 验收 33: external and dangling input refs remain in the tool table but calls close unavailable without dispatch', async () => {
  for (const ref of ['https://example.test/schema', '#missing', 'https://[']) {
    const execute = vi.fn<McpConnection['callTool']>(async () => ({ content: [] }))
    const s = source({
      connection: {
        listTools: async () => [{ ...raw(), inputSchema: { $ref: ref } }],
        callTool: execute,
      } as unknown as McpConnection,
    })
    const table = opening(await mcpCandidates([s]))
    expect(table.items.map((item) => item.name)).toEqual(['fixture__echo'])
    expect(table.excluded).toEqual([])
    const h = harness([s])
    expect(
      (await send(h, [call(), scriptedTurn({ deltas: ['done'], usage: USAGE })])).reason.code,
    ).toBe('completed')
    expect(execute).not.toHaveBeenCalled()
    expect(
      (await facts(h.tape)).findLast((entry) => entry.name === 'execution/tool_outcome')?.payload,
    ).toMatchObject({ state: 'not-run', source: 'tool-unavailable' })
  }
})

it('03 验收 42: mid-Run compaction keeps an already-written instruction once in the retained tail', async () => {
  const h = harness([source()])
  for (let i = 0; i < 3; i++) await send(h)
  const model = { ...MODEL, providerId: 'zhipu', id: 'new-provider' }
  const provider = createScriptedProvider({ id: model.providerId, models: [model] })
  const text = 'instructions opened at the start of this Run'
  h.loop.connector.use({
    provider,
    model,
    mcpSources: [source({ instructions: { text, hash: sha256Hex(text) } })],
  })
  await h.service.selectModel({
    sessionId: SESSION,
    origin: null,
    choice: { providerId: model.providerId, modelId: model.id, effort: null },
  })
  provider.script(call())
  provider.script([
    { type: 'usage', usage: USAGE },
    stopEvent('context-overflow', 'model_context_window_exceeded'),
  ])
  provider.script(scriptedTurn({ deltas: ['summary'], usage: USAGE }))
  provider.script(scriptedTurn({ deltas: ['done'], usage: USAGE }))
  expect((await send(h, [])).reason.code).toBe('completed')
  const all = await facts(h.tape)
  const anchor = all.findLast((entry) => entry.name === 'compaction/anchor')!
  const notes = all.filter((entry) => entry.name === 'message/server_instructions')
  expect(notes).toHaveLength(1)
  expect(notes[0]!.entryId).toBeGreaterThanOrEqual(anchor.payload['keepFromEntryId'] as number)
  expect(notes[0]!.entryId).toBeLessThan(anchor.entryId)
  expect(
    JSON.stringify(provider.requests.at(-1)!.body).match(/<connector_instructions/g),
  ).toHaveLength(1)
})
