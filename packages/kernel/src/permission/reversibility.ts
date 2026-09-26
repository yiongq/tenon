/**
 * Two readings of §内置工具的默认档位 that the kernel makes before `decide()`, both pure functions of
 * the tool and its arguments: whether the change can be undone, and the call's own card reason.
 *
 * Reversibility (spec 02 §可逆性; E1, E4, D10): it does not look at the protected list or the workspace, and nothing a model
 * or an inspector says can change it. Phase 2 produces three values — reads `read-only`, every write
 * `unknown`, deleting a file or sending content out `irreversible`; connector tools are `unknown`
 * unless a policy says otherwise (6b).
 *
 * Plan step 11 writes everything but Bash's conservative pattern table, which is plan step 22's; until
 * then every command is `unknown` — and never `read-only`, which it can never be.
 */
import type { AbsolutePath, Reversibility } from '../host/adapter.js'
import type { ToolOrigin } from '../tape/entry.js'
import type { CallReason } from './decide.js'
import type { PathPlace } from './workspace.js'

export function reversibilityOf(
  tool: Pick<ToolOrigin, 'source' | 'originalName'>,
  args: Readonly<Record<string, unknown>>,
): Reversibility {
  if (tool.source !== 'builtin') return 'unknown'
  switch (tool.originalName) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'AskUserQuestion':
      return 'read-only'
    case 'Bash':
      return commandReversibility(typeof args['command'] === 'string' ? args['command'] : '')
    default:
      // Write, Edit (every write), Agent, WebSearch, WebFetch.
      return 'unknown'
  }
}

/** Plan step 22 adds the pattern table (`rm`, `curl` with a body, `git push`, `scp`, …). */
function commandReversibility(command: string): Reversibility {
  void command
  return 'unknown'
}

/** The file tools: the ones a path decides for (§「在不在工作区里」). */
export const FILE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
])

export interface CallReasonQuery {
  readonly tool: Pick<ToolOrigin, 'source' | 'originalName'>
  readonly args: Readonly<Record<string, unknown>>
  /** A file tool's path as `locatePath` placed it. */
  readonly place?: PathPlace
  readonly real?: AbsolutePath
  /** The workspace's first folder: the `outside-workspace` card's `workspace` slot and the cwd (暂定). */
  readonly workspace: AbsolutePath | null
  /** WebSearch's backend host (H8). */
  readonly searchHost: string | null
}

/**
 * The call's own reason (the table's 「原因码」 column), with its required slots and `toolName`; a
 * blocked call's `target` comes from here too. Rows with 「—」 give `default`, which only layer 8 uses.
 */
export function callReasonOf(q: CallReasonQuery): CallReason {
  const toolName = q.tool.originalName
  if (q.tool.source === 'builtin') {
    if (FILE_TOOL_NAMES.has(toolName)) {
      const path = q.real ?? ''
      if (q.place === 'outside') {
        return {
          reason: 'outside-workspace',
          facts: { path, workspace: q.workspace ?? '', toolName, target: path },
        }
      }
      return { reason: 'default', facts: { toolName, path, target: path } }
    }
    if (toolName === 'Bash') {
      const command = typeof q.args['command'] === 'string' ? q.args['command'] : ''
      return { reason: 'command', facts: { command, cwd: q.workspace ?? '', toolName } }
    }
    if (toolName === 'WebSearch') {
      return { reason: 'network', facts: { host: q.searchHost ?? '', toolName } }
    }
    if (toolName === 'WebFetch') {
      const url = typeof q.args['url'] === 'string' ? q.args['url'] : ''
      const host = hostOfUrl(url)
      return { reason: 'network', facts: { host, toolName, url, target: host } }
    }
  }
  return { reason: 'default', facts: { toolName } }
}

/** A URL's host, lower-cased; the full normalisation of §搜索与抓取 arrives with plan step 27. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}
