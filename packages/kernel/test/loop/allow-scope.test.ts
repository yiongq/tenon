/**
 * The card's period is the answer's scope (spec 02 §最小审批卡「期限」, §作用域与授权键「答复作用域」;
 * plan step 20: 旧 217's kernel half, 验收 36 「期限只由 allowScope 和 target.type 决定，并等于写进答复的
 * grant.scope」): for each row of the answer-scope table, `approval.current`'s `allowScope` is the
 * value the table gives, and an allow of that same card writes it into `approval_resolved.grant.scope`.
 *
 * Each card is raised by a real Run in the task profile with one workspace folder: builtin tools run
 * on the test registry's fake executors, `look` is the `fs` connector's tool with nothing set by the
 * user for it (so it asks by default), and `confirm`'s one tool is always allowed but marked as
 * needing the user every time.
 */
import { describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type {
  McpConnection,
  McpToolSource,
  MemoryHost,
  ModelInfo,
  PendingApproval,
  PolicyState,
  SearchBackend,
  SessionService,
  StreamEvent,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import {
  createCounterIds,
  createFakeInspector,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type { FakeInspector, ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'
import { LOOK, lookSource, pendingCard } from './support.js'

const IDENTITY = { userId: 'scope-user', tenantId: 'scope-tenant', profileDir: '/tenon/scope' }
const SESSION = '6c3f9a2e-6b3d-4a71-9f52-0c8de7a11c02'
const DEDICATED = absolutePath(`/home/u/Tenon/workspaces/scope-user/scope-tenant/${SESSION}`)
const WORK = absolutePath('/work/project')
const ELSEWHERE = absolutePath('/elsewhere')

const MODEL: ModelInfo = {
  id: 'claude-scope-1',
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

const USAGE: Usage = {
  inputTokens: 5,
  outputTokens: 2,
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

/** A connector whose one tool shares a session-scoped builtin's name: only its source makes it `once`. */
function lookalike(): McpToolSource {
  const connection = {
    listTools: () => Promise.resolve([{ name: 'WebFetch', inputSchema: { type: 'object' } }]),
    callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  } as unknown as McpConnection
  return { serverId: 'net', connection }
}

/** A connector whose one tool the server marks as needing the user every time (layer 4 ②, D12). */
function confirming(): McpToolSource {
  const connection = {
    listTools: () =>
      Promise.resolve([
        {
          name: 'press',
          inputSchema: { type: 'object' },
          _meta: { 'anthropic/requiresUserInteraction': true },
        },
      ]),
    callTool: () =>
      Promise.resolve({ content: [{ type: 'text', text: 'pressed' }], isError: false }),
  } as unknown as McpConnection
  return { serverId: 'confirm', connection }
}

const ASK = { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] } as const

interface Harness {
  readonly memory: MemoryHost
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  readonly inspector: FakeInspector
}

async function harness(): Promise<Harness> {
  const memory = createMemoryHost({ identity: IDENTITY })
  await memory.fs.mkdirp(WORK)
  await memory.fs.mkdirp(ELSEWHERE)
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  const inspector = createFakeInspector({ id: 'asker', ceiling: 'ask' })
  const loop = createTestLoopPorts({
    connector: {
      provider,
      model: MODEL,
      search: SEARCH,
      mcpSources: [lookSource([]), lookalike(), confirming()],
    },
  })
  const service = createTestSessionService(
    {
      host: memory,
      tape: store,
      ids: createCounterIds(),
      inspectors: [inspector.registration],
      connector: loop.connector,
      protectedFiles: [],
    },
    {
      tools: {},
      // Always allowed by the user: that releases layer 4 ① only, never ② (§合并：两步).
      userSetting: (key) => (key.serverId === 'confirm' ? { userSetting: 'always-allow' } : null),
    },
  )
  service.bindLoop(loop)
  await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
  await service.setWorkspace({
    sessionId: SESSION,
    change: { kind: 'add', folders: [WORK] },
    dedicated: DEDICATED,
  })
  return { memory, store, service, loop, provider, inspector }
}

function policy(rule: Extract<PolicyState, { status: 'current' }>['snapshot']): PolicyState {
  return { status: 'current', version: 'v2', snapshot: rule }
}

/** One reply asking for one call. */
function callOf(name: string, input: Record<string, unknown>): StreamEvent[] {
  return [
    { type: 'tool-call-start', index: 1, id: 'toolu_1', name },
    { type: 'tool-call-end', index: 1, id: 'toolu_1', name, input },
    { type: 'usage', usage: USAGE },
    stopEvent('tool-use', 'tool_use'),
  ]
}

/** Sends a message whose reply asks for the call; the Run pauses on its card. */
async function pausedOn(
  h: Harness,
  name: string,
  input: Record<string, unknown>,
): Promise<PendingApproval> {
  h.provider.script(callOf(name, input))
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: `call ${name}` })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  expect((await h.loop.runEnded({ runId: sent.runId })).reason).toEqual({
    code: 'paused',
    waitingFor: 'approval',
  })
  const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (pending === null) throw new Error('no card')
  return pending
}

async function resolutions(h: Harness): Promise<TapeEntry[]> {
  const { entries } = await h.store.readRange({ sessionId: SESSION, limit: 1000 })
  return entries.filter((entry) => entry.name === 'tool/approval_resolved')
}

/** Allows the card; the grant the answer wrote. */
async function allow(
  h: Harness,
  pending: PendingApproval,
): Promise<{ scope: string; key: string }> {
  h.provider.script(scriptedTurn({ deltas: ['Done.'], usage: USAGE }))
  expect(
    await h.service.answer({
      kind: 'approval',
      sessionId: SESSION,
      requestId: pending.card.requestId,
      decision: 'allow',
      origin: null,
    }),
  ).toEqual({ status: 'applied' })
  await h.loop.runEnded()
  const resolved = (await resolutions(h)).at(-1)
  expect(resolved?.payload['outcome']).toBe('allowed')
  expect(resolved?.payload['decisionKey']).toBe(pending.card.requestId)
  return resolved?.payload['grant'] as { scope: string; key: string }
}

interface Row {
  /** Which row of the table this card falls in, as the spec words it. */
  readonly row: string
  readonly name: string
  readonly input: Record<string, unknown>
  readonly scope: 'once' | 'session'
  /** The card's reason, where it is what puts the card in this row. */
  readonly reason?: string
  /** What makes this card the row's case rather than a later row's. */
  readonly arrange?: (h: Harness) => void
}

/**
 * Top row first; each card is built so that no earlier row holds for it. An irreversible command
 * (plan step 22's pattern table) is layer 4 ① of the first row, and the second row once a policy
 * releases it and only the manual mode asks.
 */
const ROWS: readonly Row[] = [
  {
    row: 'must ask: layer 4 ① (an irreversible command)',
    name: 'Bash',
    input: { command: 'rm -rf build' },
    scope: 'once',
    reason: 'command',
  },
  {
    row: 'must ask: layer 4 ② (a connector tool that needs the user, set to always allow)',
    name: 'confirm__press',
    input: {},
    scope: 'once',
    reason: 'interaction-required',
  },
  {
    row: 'must ask: layer 1 asks (a WebFetch the policy makes ask)',
    name: 'WebFetch',
    input: { url: 'https://example.com/a' },
    scope: 'once',
    reason: 'policy',
    arrange: (h) =>
      h.memory.setPolicy(
        policy({
          tools: [{ policyId: 'p1', serverId: 'builtin', toolName: 'WebFetch', effect: 'ask' }],
        }),
      ),
  },
  {
    row: 'must ask: layer 5 asks, flagged (a Write in the workspace)',
    name: 'Write',
    input: { file_path: `${WORK}/flagged.txt`, content: 'x' },
    scope: 'once',
    reason: 'flagged',
    arrange: (h) => h.inspector.answer(ASK),
  },
  {
    row: 'irreversible, released by the policy (only the manual mode asks)',
    name: 'Bash',
    input: { command: 'git push origin main' },
    scope: 'once',
    reason: 'command',
    arrange: (h) =>
      h.memory.setPolicy(
        policy({
          tools: [
            {
              policyId: 'p2',
              serverId: 'builtin',
              toolName: 'Bash',
              effect: 'release-irreversible',
            },
          ],
        }),
      ),
  },
  {
    row: 'outside the workspace (a Write)',
    name: 'Write',
    input: { file_path: `${ELSEWHERE}/out.txt`, content: 'x' },
    scope: 'once',
    reason: 'outside-workspace',
  },
  {
    row: 'outside the workspace (a Read, 旧 214)',
    name: 'Read',
    input: { file_path: `${ELSEWHERE}/notes.txt` },
    scope: 'once',
    reason: 'outside-workspace',
  },
  { row: 'a connector tool', name: LOOK, input: { at: 'x' }, scope: 'once' },
  {
    row: 'a connector tool named like a builtin',
    name: 'net__WebFetch',
    input: { url: 'https://example.com/c' },
    scope: 'once',
  },
  {
    row: 'the rest: a Write in the workspace',
    name: 'Write',
    input: { file_path: `${WORK}/a.txt`, content: 'x' },
    scope: 'session',
  },
  {
    row: 'the rest: an Edit in the workspace',
    name: 'Edit',
    input: { file_path: `${WORK}/a.txt`, old_string: 'x', new_string: 'y' },
    scope: 'session',
  },
  { row: 'the rest: Bash', name: 'Bash', input: { command: 'ls -la' }, scope: 'session' },
  { row: 'the rest: WebSearch', name: 'WebSearch', input: { query: 'tenon' }, scope: 'session' },
  {
    row: 'the rest: WebFetch',
    name: 'WebFetch',
    input: { url: 'https://example.com/b' },
    scope: 'session',
  },
]

describe('allowScope is the grant.scope the same card’s allow writes (旧 217)', () => {
  for (const row of ROWS) {
    it(`${row.row}: ${row.scope}`, async () => {
      const h = await harness()
      row.arrange?.(h)
      const pending = await pausedOn(h, row.name, row.input)
      expect({ reason: pending.card.reason }).toMatchObject(
        row.reason === undefined ? {} : { reason: row.reason },
      )
      expect(pending.allowScope).toBe(row.scope)
      const grant = await allow(h, pending)
      expect(grant.scope).toBe(pending.allowScope)
    })
  }

  it('reads the scope off the new card when the old one changed, and the answer writes that', async () => {
    const h = await harness()
    const before = await pausedOn(h, 'Write', { file_path: `${WORK}/moved.txt`, content: 'x' })
    expect(before.allowScope).toBe('session')
    // The folder goes: the same call now falls outside it, a different card (F3).
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'remove', folder: WORK },
      dedicated: DEDICATED,
    })
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: before.card.requestId,
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'stale' })
    const after = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
    if (after === null) throw new Error('no new card')
    expect(after.card.requestId).not.toBe(before.card.requestId)
    expect(after.card.reason).toBe('outside-workspace')
    expect(after.allowScope).toBe('once')
    expect((await allow(h, after)).scope).toBe('once')
    expect(await resolutions(h)).toHaveLength(1)
  })
})
