/**
 * What an answer grants (spec 02 §作用域与授权键; D1, D2, D7, D10, D11, H8).
 *
 * A builtin tool's card says only "deny / allow", and "allow" holds for this session and the one
 * object on the card: this file (its real path), this exact command in this cwd, this session's
 * searches, this host's fetches. Nothing a card grants is ever "always"; a connector tool's
 * always-allow / ask / never lives in the profile directory from phase 3 and never passes a card.
 *
 * Session grants are not a table of their own: they are recomputed from `tool/approval_resolved`,
 * so a restart rebuilds them as they were — and a folder removed from the workspace voids the write
 * grants under it for good, as a cwd change voids every command grant (D2 only ever tightens).
 */
import type { AbsolutePath, Reversibility } from '../host/adapter.js'
import { isWithin } from '../host/path.js'
import type { GrantScope } from '../tape/entry.js'
import type { Decision } from './decide.js'
import type { PathPlace } from './workspace.js'

export type GrantObject =
  | { readonly kind: 'file'; readonly path: AbsolutePath } // locatePath 的 real（D8）
  | { readonly kind: 'command'; readonly command: string; readonly cwd: AbsolutePath } // 命令原文逐字，不做任何规范化
  | { readonly kind: 'search'; readonly host: string } // 搜索后端域名（H8）
  | { readonly kind: 'domain'; readonly host: string } // 主机名，规范化见 §搜索与抓取
  | { readonly kind: 'call'; readonly argsHash: string } // 只配 once：MCP 工具

/** `JSON.stringify([serverId, toolName, object.kind, ...该成员其余字段按上面的声明顺序])`. */
export function grantKey(serverId: string, toolName: string, object: GrantObject): string {
  switch (object.kind) {
    case 'file':
      return JSON.stringify([serverId, toolName, object.kind, object.path])
    case 'command':
      return JSON.stringify([serverId, toolName, object.kind, object.command, object.cwd])
    case 'search':
    case 'domain':
      return JSON.stringify([serverId, toolName, object.kind, object.host])
    case 'call':
      return JSON.stringify([serverId, toolName, object.kind, object.argsHash])
  }
}

/** Which session grant a key's object makes (`LayerInputs.sessionGrant.kind`). */
export function sessionGrantKindOf(
  object: GrantObject,
): 'session' | 'session-search' | 'session-domain' {
  if (object.kind === 'search') return 'session-search'
  if (object.kind === 'domain') return 'session-domain'
  return 'session'
}

/** The deciding layers of a card raised by a "must ask" (§合并：两步): their answers hold once. */
const MUST_ASK: ReadonlySet<string> = new Set([
  'tenant-policy',
  'connector-confirm',
  'inspector',
  'irreversible',
])
const SESSION_SCOPED: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'Bash',
  'WebSearch',
  'WebFetch',
])

/**
 * An allowed card's `grant.scope` (the answer-scope table, top row first): a must-ask card, an
 * irreversible call, a path outside the workspace and any connector tool hold `once`; the rest of the
 * builtin tools — Write / Edit in the workspace, Bash, WebSearch, WebFetch — hold for the `session`.
 */
export function answerScope(q: {
  readonly decision: Decision
  readonly reversibility: Reversibility
  readonly place?: PathPlace
  readonly source: 'builtin' | 'mcp'
  readonly toolName: string
}): Extract<GrantScope, 'once' | 'session'> {
  const { record } = q.decision
  if (record.verdict === 'ask' && MUST_ASK.has(record.decidedBy)) return 'once'
  if (q.reversibility === 'irreversible') return 'once'
  if (q.place === 'outside') return 'once'
  if (q.source === 'mcp') return 'once'
  return SESSION_SCOPED.has(q.toolName) ? 'session' : 'once'
}

/** What the session grants are computed from, in Tape order. */
export type GrantFact =
  | {
      readonly kind: 'approval'
      readonly sessionId: string
      readonly approvalKey: string // the tool/approval_resolved's provenanceKey
      readonly outcome: string
      readonly grant: { readonly scope: GrantScope; readonly key: string } | null
    }
  | { readonly kind: 'workspace'; readonly folders: readonly AbsolutePath[] }

export interface GrantSource {
  readonly sessionId: string
  readonly approvalKey: string
}

/**
 * The session grants in force, by `grantKey`. Only allowed answers with `scope: 'session'` grant;
 * `once` answers write a key too and never count. A workspace fact that removes a folder voids every
 * file grant under it, and a later fact that adds it back does not bring them back; a fact that
 * changes the cwd (`folders[0]`) voids every command grant (暂定 rules, §工作区).
 */
export function sessionGrants(facts: readonly GrantFact[]): Map<string, GrantSource> {
  const grants = new Map<string, GrantSource>()
  let folders: readonly AbsolutePath[] | null = null
  for (const fact of facts) {
    if (fact.kind === 'approval') {
      if (fact.outcome === 'allowed' && fact.grant?.scope === 'session') {
        grants.set(fact.grant.key, { sessionId: fact.sessionId, approvalKey: fact.approvalKey })
      }
      continue
    }
    if (folders !== null) {
      const removed = folders.filter((folder) => !fact.folders.includes(folder))
      const cwdChanged = folders[0] !== fact.folders[0]
      for (const key of grants.keys()) {
        const object = objectOfKey(key)
        if (object === null) continue
        if (object.kind === 'file' && removed.some((folder) => isWithin(object.path, folder))) {
          grants.delete(key)
        } else if (object.kind === 'command' && cwdChanged) grants.delete(key)
      }
    }
    folders = fact.folders
  }
  return grants
}

/** The object a key names, read back from the key's own JSON. */
function objectOfKey(key: string): GrantObject | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(key)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const [, , kind, first, second] = parsed as unknown[]
  if (kind === 'file' && typeof first === 'string') return { kind, path: first as AbsolutePath }
  if (kind === 'command' && typeof first === 'string' && typeof second === 'string') {
    return { kind, command: first, cwd: second as AbsolutePath }
  }
  return null
}
