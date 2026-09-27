/**
 * The tool registry (spec 02 §工具来源、命名与权限键): where tools come from, and the name each
 * one goes to a provider under.
 *
 * Three sources in the spec, two in phase 2: the builtin tools, and the MCP servers Tenon's own host
 * connects to (only the kernel tests' Everything fixture, H4). What a provider runs on its own side is
 * neither modelled nor sent.
 *
 * `ToolTableItem` and the reserved builtin server id were declared in plan step 9; the naming rule,
 * the per-request cap and the candidate set are plan step 10's.
 */
import { ZHIPU_PROVIDER_ID } from '../provider/definitions/zhipu.js'
import type { ProviderId, ToolSpec } from '../provider/types.js'
import { canonicalJson } from '../tape/canonical-json.js'
import { sha256Hex } from '../tape/hash.js'
import type { ToolOrigin } from '../tape/entry.js'
import type { SearchBackend } from './search/types.js'
import { BUILTIN_TOOLS, BUILTIN_TOOL_NAMES, isBuiltinToolName } from './builtin/index.js'
import type { BuiltinToolName, ToolProfile } from './builtin/tool.js'

/** The `ToolOrigin.serverId` of the builtin tools. Reserved: phase 3's server config refuses it. */
export const BUILTIN_SERVER_ID = 'builtin'

export interface ToolTableItem extends ToolOrigin {
  name: string // 发给 provider 的名字，满足 ^[a-zA-Z0-9_-]{1,64}$；内置工具 === originalName
  spec: ToolSpec // spec.name === name
  requiresUserInteraction: boolean // 裁决 D12；内置工具恒为 false
}
// provider 服务端执行的 MCP 不在 source 里，要用时只增一个值

/**
 * The builtin tools the PRODUCT offers. A tool joins the table only once both its approval and its
 * closure are done (M1): Read, Glob and Grep with plan step 18, Write, Edit and Bash with step 22,
 * AskUserQuestion step 26, WebFetch step 27 (as `'real'` in the test registry) then 29, WebSearch step
 * 28, Agent step 31. Until then kernel tests reach them through `createTestSessionService`.
 */
export const PRODUCT_BUILTINS: ReadonlySet<BuiltinToolName> = new Set<BuiltinToolName>([
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
])

/**
 * How many tools one request may carry, by provider (H4; 暂定). Zhipu takes 128. Anthropic is not
 * capped by count (400 only past 10 000 deferred tools or 4 MB of definitions); a provider phase 2
 * sends no tools to needs no entry. Builtin tools are never trimmed.
 */
export const TOOLS_PER_REQUEST: ReadonlyMap<ProviderId, number> = new Map([
  [ZHIPU_PROVIDER_ID, 128],
])

/** What a provider name must look like: the intersection of Zhipu's and Anthropic's rules (H4). */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

const MAX_NAME = 64
const KEPT_PREFIX = 55

/**
 * The name an MCP tool goes to the provider under (§工具来源、命名与权限键「命名规则」):
 * `${serverId}__${originalName}`, every character outside `[a-zA-Z0-9_-]` replaced by `_`; when that
 * replaced anything or made it longer than 64, the first 55 characters, `_`, and the first 8 hex
 * digits of `sha256Hex(canonicalJson([serverId, originalName]))`. The suffix is over the PAIR, so two
 * pairs never share one by spelling the same string, and `a.b` / `a_b` never meet.
 */
export function mcpToolName(serverId: string, originalName: string): string {
  const raw = `${serverId}__${originalName}`
  const replaced = raw.replaceAll(/[^a-zA-Z0-9_-]/g, '_')
  if (replaced === raw && raw.length <= MAX_NAME) return raw
  const suffix = sha256Hex(canonicalJson([serverId, originalName])).slice(0, 8)
  return `${replaced.slice(0, KEPT_PREFIX)}_${suffix}`
}

/** One tool as a table may take it: where it is from, the spec under its provider name, D12's flag. */
export interface ToolCandidate extends ToolOrigin {
  readonly name: string
  readonly spec: ToolSpec
  readonly requiresUserInteraction: boolean
}

/**
 * The builtin candidates of a profile (H1): those the registry has (`available`), under their own
 * names. WebSearch's definition follows the search backend's domain filter; when there is no backend
 * it stays a candidate, and the table records it as excluded (`no-search-backend`).
 */
export function builtinCandidates(q: {
  readonly profile: ToolProfile
  readonly available: (name: BuiltinToolName) => boolean
  readonly search: SearchBackend | null
}): ToolCandidate[] {
  return BUILTIN_TOOL_NAMES.filter(
    (name) => BUILTIN_TOOLS[name].profiles.includes(q.profile) && q.available(name),
  ).map((name) => ({
    source: 'builtin',
    serverId: BUILTIN_SERVER_ID,
    originalName: name,
    name,
    spec: BUILTIN_TOOLS[name].spec({ domainFilter: q.search?.domainFilter ?? false }),
    requiresUserInteraction: false,
  }))
}

/**
 * The table's names must be pairwise distinct, match the provider rule, and a connector tool may not
 * take a builtin's name (rules 5 and 6). The mapping is not injective, so a clash is possible; in
 * phase 2 only fixtures can cause one, and it is a failed test.
 */
export function assertToolNames(items: readonly Pick<ToolCandidate, 'name' | 'source'>[]): void {
  const seen = new Set<string>()
  for (const item of items) {
    if (!TOOL_NAME_PATTERN.test(item.name)) {
      throw new Error(`tool table: "${item.name}" is not a valid provider tool name`)
    }
    if (item.source !== 'builtin' && isBuiltinToolName(item.name)) {
      throw new Error(`tool table: a connector tool maps onto the builtin name "${item.name}"`)
    }
    if (seen.has(item.name)) throw new Error(`tool table: two tools map onto "${item.name}"`)
    seen.add(item.name)
  }
}
