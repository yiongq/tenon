/**
 * The frozen tool table (spec 02 §工具目录与冻结): one per session × provider × generation. It is opened
 * the first time a provider is used in a generation, whether or not the model it runs takes tools,
 * and then sent verbatim for as long as it lives — a tool disabled after it froze keeps its definition
 * in the list and is blocked when called; a tool that appears later waits for the next table (E2).
 *
 * The table is written to the Tape as `view/tool_table` with its specs in `view/content(tool_spec)`,
 * in the batch of the request that opened it; resuming, continuing and replaying rebuild it from those
 * facts and never ask the registry or a server again (E2, B4, D12).
 */
import type { PolicyState } from '../host/policy.js'
import { policyDeniesTool, userDisablesTool } from '../permission/decide.js'
import type { UserToolSetting } from '../permission/decide.js'
import type { ProviderId, ToolSpec } from '../provider/types.js'
import { canonicalHash } from '../provider/wire/shared.js'
import { canonicalJson } from '../tape/canonical-json.js'
import type {
  NewEntry,
  ToolExclusionCode,
  ToolTablePayload,
  ViewContentPayload,
} from '../tape/entry.js'
import { toolTableKey, viewContentKey } from '../tape/provenance.js'
import type { TapeWriter } from '../tape/tape.js'
import { assertToolNames } from './registry.js'
import type { ToolCandidate, ToolTableItem } from './registry.js'

/** The table in memory. Every value type is the Tape's (§02 的 Tape 事实). */
export interface FrozenToolTable {
  readonly providerId: ProviderId
  readonly generation: number // 即键里的 <g>
  readonly reason: ToolTablePayload['reason']
  readonly tableKey: string // 这条 view/tool_table 的 provenanceKey；tools_withheld、assembled 用它引用
  readonly items: readonly ToolTableItem[] // 按 name 码元升序
  readonly excluded: ToolTablePayload['excluded']
}

/** A connector tool's layer-3 key (H4, D1): the tenant, the server, the ORIGINAL name. */
export interface ToolKey {
  readonly definitionHash?: string
  readonly tenantId: string
  readonly serverId: string
  readonly toolName: string
}

export interface OpenTableQuery {
  readonly providerId: ProviderId
  readonly incarnationId: string
  readonly generation: number
  readonly reason: ToolTablePayload['reason']
  /** The profile's builtin candidates and every connector tool, in any order. */
  readonly candidates: readonly ToolCandidate[]
  /** The one `policy.current()` reading of this opening (D4). */
  readonly policy: PolicyState
  readonly tenantId: string
  /** Layer 3 for a connector tool; phase 2 has no producer, only tests inject one. */
  readonly userSetting: (key: ToolKey) => UserToolSetting | null
  /** Whether the Run has a search backend; WebSearch without one is `no-search-backend` (H8). */
  readonly hasSearchBackend: boolean
  /**
   * At most this many tools in one request: `RunConnector.toolsPerRequest` for this provider, read
   * at the opening (M6 §对 02 的修补 4, T13). Null = no cap by count.
   */
  readonly toolsPerRequest: number | null
}

/**
 * Opens a table: exclusion first, in the spec's order (one code per tool: policy, user-disabled,
 * connector-unauthorized, over-limit, no-search-backend), then the provider's cap, then the order —
 * by name in code units, never `localeCompare` (E2). Builtin tools are never trimmed; connector tools
 * past the cap are, in name order.
 */
export function openToolTable(q: OpenTableQuery): FrozenToolTable {
  const excluded: Array<ToolTablePayload['excluded'][number]> = []
  const exclude = (candidate: ToolCandidate, code: ToolExclusionCode): void => {
    excluded.push({
      source: candidate.source,
      serverId: candidate.serverId,
      originalName: candidate.originalName,
      code,
    })
  }
  const kept: ToolCandidate[] = []
  for (const candidate of sortByName(q.candidates)) {
    if (policyDeniesTool(q.policy, candidate)) exclude(candidate, 'policy')
    else if (candidate.source === 'mcp' && userDisablesTool(q.userSetting(keyOf(q, candidate)))) {
      exclude(candidate, 'user-disabled')
    } else if (
      candidate.source === 'builtin' &&
      candidate.originalName === 'WebSearch' &&
      !q.hasSearchBackend
    ) {
      exclude(candidate, 'no-search-backend')
    } else kept.push(candidate)
  }
  const cap = q.toolsPerRequest ?? Number.POSITIVE_INFINITY
  const builtins = kept.filter((candidate) => candidate.source === 'builtin').length
  let room = cap - builtins
  const items: ToolTableItem[] = []
  for (const candidate of kept) {
    if (candidate.source !== 'builtin') {
      if (room <= 0) {
        exclude(candidate, 'over-limit')
        continue
      }
      room -= 1
    }
    items.push({
      source: candidate.source,
      serverId: candidate.serverId,
      originalName: candidate.originalName,
      name: candidate.name,
      spec: canonicalSpec(candidate.spec),
      requiresUserInteraction: candidate.requiresUserInteraction,
    })
  }
  assertToolNames(items)
  if (items.length > cap) {
    throw new Error(
      `tool table: ${String(items.length)} tools exceed ${q.providerId}'s cap of ${String(cap)}`,
    )
  }
  return {
    providerId: q.providerId,
    generation: q.generation,
    reason: q.reason,
    tableKey: toolTableKey(q.incarnationId, q.generation, q.providerId),
    items,
    excluded,
  }
}

/**
 * The facts a new table is written as: each spec once in `view/content(tool_spec)` (content already on
 * the tape answers `created: false`), then the `view/tool_table`. They go in the batch of the request
 * that opened it, before its `view/assembled`.
 */
export function toolTableFacts(q: {
  readonly view: TapeWriter
  readonly sessionId: string
  readonly table: FrozenToolTable
  readonly policy: PolicyState
  readonly now: () => number
}): NewEntry[] {
  const { view, sessionId, table } = q
  const specs = table.items.map((item) => ({ item, hash: specHash(item.spec) }))
  const entries: NewEntry[] = specs.map(({ item, hash }) => {
    const payload: ViewContentPayload = { type: 'tool_spec', hash, spec: item.spec }
    return view.entry('view/content', {
      sourceType: 'session',
      sourceId: sessionId,
      provenanceKey: viewContentKey('tool_spec', hash),
      payload,
      createdAt: q.now(),
    })
  })
  const payload: ToolTablePayload = {
    providerId: table.providerId,
    generation: table.generation,
    reason: table.reason,
    policyVersion: q.policy.status === 'unavailable' ? 'unavailable' : q.policy.version,
    tools: specs.map(({ item, hash }) => ({
      source: item.source,
      serverId: item.serverId,
      originalName: item.originalName,
      name: item.name,
      specHash: hash,
      requiresUserInteraction: item.requiresUserInteraction,
    })),
    excluded: [...table.excluded],
  }
  entries.push(
    view.entry('view/tool_table', {
      sourceType: 'session',
      sourceId: sessionId,
      sourceSeq: table.generation,
      provenanceKey: table.tableKey,
      payload,
      createdAt: q.now(),
    }),
  )
  return entries
}

/**
 * A table as the Tape holds it: the `view/tool_table` payload and its key, with each spec taken from
 * `view/content(tool_spec)` by hash. The registry is never asked (E2, B4).
 */
export function rebuildToolTable(
  tableKey: string,
  payload: ToolTablePayload,
  specs: ReadonlyMap<string, ToolSpec>,
): FrozenToolTable {
  return {
    providerId: payload.providerId,
    generation: payload.generation,
    reason: payload.reason,
    tableKey,
    items: payload.tools.map((tool) => {
      const spec = specs.get(tool.specHash)
      if (spec === undefined) {
        throw new Error(`tool table ${tableKey}: no view/content for the spec of "${tool.name}"`)
      }
      return {
        source: tool.source,
        serverId: tool.serverId,
        originalName: tool.originalName,
        name: tool.name,
        spec,
        requiresUserInteraction: tool.requiresUserInteraction,
      }
    }),
    excluded: payload.excluded,
  }
}

/**
 * A definition in the form the Tape gives it back: keys in canonical order. The table sends this form
 * from its first request on, so the request that opened it and every later one rebuilt from the Tape
 * carry the same bytes, not only the same hash (§tools 只在下列时点变化).
 */
function canonicalSpec(spec: ToolSpec): ToolSpec {
  return JSON.parse(canonicalJson(spec)) as ToolSpec
}

/** A tool definition's content hash: the key of its `view/content(tool_spec)`. */
export function specHash(spec: ToolSpec): string {
  return canonicalHash(spec, `the tool definition ${spec.name}`)
}

function keyOf(q: OpenTableQuery, candidate: ToolCandidate): ToolKey {
  return { tenantId: q.tenantId, serverId: candidate.serverId, toolName: candidate.originalName }
}

function sortByName<T extends { readonly name: string }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => compareCodeUnits(a.name, b.name))
}

/** Code-unit order: what `<` on strings is, and what `localeCompare` is not. */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
