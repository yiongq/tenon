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
it('03 验收 31 / 34 / 03 不变量 20: same-server duplicate names both collide; policy and user-disabled take priority', async () => {
  const candidate = (await mcpCandidates([source()]))[0]!
  expect(opening([candidate, candidate]).excluded.map((t) => t.code)).toEqual([
    'name-collision',
    'name-collision',
  ])
  expect(
    opening([candidate, { ...candidate, review: 'changed' }]).excluded.map((t) => t.code),
  ).toEqual(['name-collision', 'name-collision'])
  expect(
    opening([candidate, candidate], { userSetting: () => ({ userSetting: 'never' }) }).excluded.map(
      (t) => t.code,
    ),
  ).toEqual(['user-disabled', 'user-disabled'])
  expect(
    opening([{ ...candidate, definitionProblem: 'size', review: 'changed' }]).excluded[0]?.code,
  ).toBe('invalid-definition')
})
it('03 验收 35 / 03 不变量 12: cap sorts by rank then name and never trims a builtin', async () => {
  const candidate = (await mcpCandidates([source()]))[0]!
  const builtin: ToolCandidate = {
    ...candidate,
    source: 'builtin',
    serverId: 'builtin',
    originalName: 'Read',
    name: 'Read',
    spec: { ...candidate.spec, name: 'Read' },
  }
  const a = {
    ...candidate,
    originalName: 'a',
    name: 'fixture__a',
    spec: { ...candidate.spec, name: 'fixture__a' },
    rank: 9,
  }
  const z = {
    ...candidate,
    originalName: 'z',
    name: 'fixture__z',
    spec: { ...candidate.spec, name: 'fixture__z' },
    rank: 0,
  }
  const table = opening([a, z, builtin], { toolsPerRequest: 2 })
  expect(table.items.map((t) => t.name)).toEqual(['Read', 'fixture__z'])
  expect(table.excluded).toMatchObject([{ originalName: 'a', code: 'over-limit' }])
})
it('03 验收 32 / 38: oversized and changed definitions never enter a new table', async () => {
  const huge = source({
    connection: { listTools: async () => [raw('a'.repeat(65_537))] } as unknown as McpConnection,
  })
  expect(opening(await mcpCandidates([huge])).excluded[0]?.code).toBe('invalid-definition')
  expect(
    opening(await mcpCandidates([source({ review: () => 'changed' })])).excluded[0]?.code,
  ).toBe('definition-changed')
})
it('03 验收 21 (closure) / 03 不变量 11: unauthorized closes not-run and the Run goes on; outcome carries reversibility', async () => {
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
    userSetting: () => ({ userSetting: 'always-allow' as const }),
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
  for (const schema of [nested, { allOf: Array.from({ length: 10000 }, () => ({})) }]) {
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
