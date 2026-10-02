/**
 * Connector tool names and the frozen table (spec 02 §工具来源、命名与权限键, §开表与排除; plan step 10,
 * 旧 55, 旧 144, 旧 148, 旧 145 first half). The loop's use of the table — which request carries it,
 * which facts record it — is test/loop/tool-table.test.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_POLICY,
  ZHIPU_PROVIDER_ID,
  canonicalJson,
  sha256Hex,
  zhipuDefinition,
} from '../../src/index.js'
import type { McpConnection, PolicyState, ToolSpec } from '../../src/index.js'
import { BUILTIN_TOOL_NAMES } from '../../src/tools/builtin/index.js'
import { mcpCandidates } from '../../src/tools/mcp-source.js'
import {
  TOOL_NAME_PATTERN,
  assertToolNames,
  builtinCandidates,
  mcpToolName,
} from '../../src/tools/registry.js'
import type { ToolCandidate } from '../../src/tools/registry.js'
import { openToolTable, rebuildToolTable, specHash } from '../../src/tools/table.js'
import type { OpenTableQuery } from '../../src/tools/table.js'

const INCARNATION = '00000000-0000-4000-8000-000000000001'
const CURRENT: PolicyState = { status: 'current', version: 'v1', snapshot: EMPTY_POLICY }

function connectorTool(serverId: string, originalName: string): ToolCandidate {
  const name = mcpToolName(serverId, originalName)
  const spec: ToolSpec = { name, description: '', inputSchema: { type: 'object' } }
  return { source: 'mcp', serverId, originalName, name, spec, requiresUserInteraction: false }
}

function open(over: Partial<OpenTableQuery> & Pick<OpenTableQuery, 'candidates'>) {
  return openToolTable({
    providerId: 'anthropic',
    incarnationId: INCARNATION,
    generation: 0,
    reason: 'first-use',
    policy: CURRENT,
    tenantId: 'tenant',
    userSetting: () => null,
    hasSearchBackend: true,
    toolsPerRequest: null,
    ...over,
  })
}

/** A connection that lists `tools` and does nothing else. */
function listing(tools: readonly Record<string, unknown>[]): McpConnection {
  return {
    listTools: () => Promise.resolve(tools),
  } as unknown as McpConnection
}

describe('connector tool names (H4)', () => {
  it('are server__tool when that already fits, and builtin names stay as they are', () => {
    expect(mcpToolName('everything', 'echo')).toBe('everything__echo')
    expect(mcpToolName('a', 'b_c')).toBe('a__b_c')
    const builtins = builtinCandidates({ profile: 'cowork', available: () => true, search: null })
    expect(builtins.map((candidate) => candidate.name)).toEqual([...BUILTIN_TOOL_NAMES])
  })

  it('replace illegal characters and add a suffix of the pair, so a.b and a_b never meet', () => {
    const dotted = mcpToolName('srv', 'a.b')
    const underscored = mcpToolName('srv', 'a_b')
    expect(underscored).toBe('srv__a_b')
    expect(dotted).toBe(`srv__a_b_${sha256Hex(canonicalJson(['srv', 'a.b'])).slice(0, 8)}`)
    expect(dotted).not.toBe(underscored)
  })

  it('cut a long name to 55 characters and the suffix, within the provider rule', () => {
    const long = mcpToolName('a-very-long-server-id', `${'x'.repeat(80)}/weird name!`)
    expect(long).toHaveLength(64)
    expect(long).toMatch(TOOL_NAME_PATTERN)
    expect(long.slice(55, 56)).toBe('_')
    expect(long.slice(56)).toBe(
      sha256Hex(canonicalJson(['a-very-long-server-id', `${'x'.repeat(80)}/weird name!`])).slice(
        0,
        8,
      ),
    )
  })

  it('cut a name of legal characters too once it is longer than 64, and keep one of exactly 64 (旧 144)', () => {
    expect(mcpToolName('a', 'x'.repeat(61))).toBe(`a__${'x'.repeat(61)}`)
    const long = mcpToolName('a', 'x'.repeat(62))
    expect(long).toMatch(TOOL_NAME_PATTERN)
    expect(long).toBe(
      `a__${'x'.repeat(52)}_${sha256Hex(canonicalJson(['a', 'x'.repeat(62)])).slice(0, 8)}`,
    )
  })

  it('make a table fail when two map onto one name, or a connector takes a builtin name', () => {
    // The mapping is not injective: server a's b__c and server a__b's c both spell a__b__c.
    const clash = [connectorTool('a', 'b__c'), connectorTool('a__b', 'c')]
    expect(clash[0]?.name).toBe(clash[1]?.name)
    expect(() => open({ candidates: clash })).toThrow(/two tools map onto "a__b__c"/)
    expect(() => assertToolNames([{ name: 'Read', source: 'mcp' }])).toThrow(/builtin name "Read"/)
  })
})

describe('opening a table (§开表与排除)', () => {
  it('orders by name in code units, whatever order the registry gives', () => {
    const table = open({
      candidates: [
        connectorTool('z', 'last'),
        connectorTool('A', 'upper'),
        connectorTool('a', 'lower'),
      ],
    })
    // 'A' < 'a' < 'z' by code unit; localeCompare would put A and a together.
    expect(table.items.map((item) => item.name)).toEqual(['A__upper', 'a__lower', 'z__last'])
    expect(table.tableKey).toBe(`view:v1:tool_table:${INCARNATION}:0:anthropic`)
  })

  it('records one code per excluded tool, policy first, and never trims a builtin', () => {
    const policy: PolicyState = {
      status: 'current',
      version: 'v2',
      snapshot: {
        tools: [
          { policyId: 'p1', serverId: 'srv', effect: 'deny', toolName: 'both' },
          { policyId: 'p2', serverId: 'builtin', effect: 'deny', toolName: 'WebFetch' },
        ],
      },
    }
    const table = open({
      policy,
      hasSearchBackend: false,
      candidates: [
        ...builtinCandidates({ profile: 'chat', available: () => true, search: null }),
        connectorTool('srv', 'both'),
        connectorTool('srv', 'off'),
        connectorTool('srv', 'kept'),
      ],
      // Layer 3 says never for both, and policy denies one of them: only `policy` is recorded.
      userSetting: (key) =>
        key.toolName === 'both' || key.toolName === 'off' ? { userSetting: 'never' } : null,
    })
    expect(table.items.map((item) => item.name)).toEqual(['AskUserQuestion', 'Read', 'srv__kept'])
    expect(table.excluded).toEqual([
      { source: 'builtin', serverId: 'builtin', originalName: 'WebFetch', code: 'policy' },
      {
        source: 'builtin',
        serverId: 'builtin',
        originalName: 'WebSearch',
        code: 'no-search-backend',
      },
      { source: 'mcp', serverId: 'srv', originalName: 'both', code: 'policy' },
      { source: 'mcp', serverId: 'srv', originalName: 'off', code: 'user-disabled' },
    ])
  })

  it('reads an unavailable policy as refusing every tool (D4)', () => {
    const table = open({
      policy: { status: 'unavailable' },
      candidates: builtinCandidates({ profile: 'chat', available: () => true, search: null }),
    })
    expect(table.items).toEqual([])
    expect(new Set(table.excluded.map((entry) => entry.code))).toEqual(new Set(['policy']))
  })

  it('caps a request at the cap it is given, builtin ones first, and caps nothing without one (M6 §对 02 的修补 4)', () => {
    const connectors = Array.from({ length: 130 }, (_, i) =>
      connectorTool('fixture', `tool_${String(i).padStart(3, '0')}`),
    )
    const builtins = builtinCandidates({ profile: 'cowork', available: () => true, search: null })
    const zhipu = open({
      providerId: ZHIPU_PROVIDER_ID,
      candidates: [...connectors, ...builtins],
      toolsPerRequest: zhipuDefinition.maxToolsPerRequest ?? null,
    })
    expect(zhipu.items).toHaveLength(128)
    for (const name of BUILTIN_TOOL_NAMES.filter((n) => n !== 'WebSearch')) {
      expect(zhipu.items.map((item) => item.name)).toContain(name)
    }
    const over = zhipu.excluded.filter((entry) => entry.code === 'over-limit')
    // Ten builtins, but WebSearch counts too (a backend is there): 128 − 10 = 118 connector tools.
    expect(over).toHaveLength(130 - 118)
    expect(over.at(0)?.originalName).toBe('tool_118')
    const anthropic = open({ candidates: [...connectors, ...builtins] })
    expect(anthropic.items).toHaveLength(140)
  })

  it('is rebuilt from its payload and specs exactly, requiresUserInteraction included', () => {
    const flagged = { ...connectorTool('srv', 'interactive'), requiresUserInteraction: true }
    const table = open({ candidates: [flagged, connectorTool('srv', 'plain')] })
    const payload = {
      providerId: table.providerId,
      generation: table.generation,
      reason: table.reason,
      policyVersion: 'v1',
      tools: table.items.map((item) => ({
        source: item.source,
        serverId: item.serverId,
        originalName: item.originalName,
        name: item.name,
        specHash: specHash(item.spec),
        requiresUserInteraction: item.requiresUserInteraction,
      })),
      excluded: table.excluded,
    }
    const specs = new Map(table.items.map((item) => [specHash(item.spec), item.spec]))
    expect(rebuildToolTable(table.tableKey, payload, specs)).toEqual(table)
  })
})

describe('connector candidates', () => {
  it('read _meta["anthropic/requiresUserInteraction"] only when it is the JSON value true (D12)', async () => {
    const tools = [
      {
        name: 'yes',
        inputSchema: { type: 'object' },
        _meta: { 'anthropic/requiresUserInteraction': true },
      },
      {
        name: 'string',
        inputSchema: { type: 'object' },
        _meta: { 'anthropic/requiresUserInteraction': 'true' },
      },
      { name: 'absent', inputSchema: { type: 'object' } },
      { name: 'other', inputSchema: { type: 'object' }, _meta: { 'other/flag': true } },
    ]
    const candidates = await mcpCandidates([{ serverId: 'srv', connection: listing(tools) }])
    expect(candidates.map((c) => [c.name, c.requiresUserInteraction])).toEqual([
      ['srv__yes', true],
      ['srv__string', false],
      ['srv__absent', false],
      ['srv__other', false],
    ])
    // The permission key keeps the server's own name: `originalName`, not the provider name.
    expect(candidates[0]).toMatchObject({ source: 'mcp', serverId: 'srv', originalName: 'yes' })
    expect(candidates[0]?.spec).toEqual({
      name: 'srv__yes',
      description: '',
      inputSchema: { type: 'object' },
    })
  })
})
