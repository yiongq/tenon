/**
 * Two readings of §内置工具的默认档位 that the kernel makes before `decide()`, both pure functions of
 * the tool and its arguments: whether the change can be undone, and the call's own card reason.
 *
 * Reversibility (spec 02 §可逆性; E1, E4, D10): it does not look at the protected list or the workspace, and nothing a model
 * or an inspector says can change it. Phase 2 produces three values — reads `read-only`, every write
 * `unknown`, deleting a file or sending content out `irreversible`; connector tools are `unknown`
 * unless a policy says otherwise (6b).
 *
 * Plan step 11 wrote everything but Bash's conservative pattern table, which is plan step 22's: a
 * command is `irreversible` when the table matches it and `unknown` otherwise — never `read-only`.
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

/**
 * The command pattern table (§可逆性「命令的保守模式表」; E1, E4). It is not a shell parser: each row
 * is matched against the command text as written, anywhere in it, never split into segments, no
 * operand `stat`ed — so `echo "rm x"` hits as `rm x` does. A hit is `irreversible`, anything else
 * `unknown`. Rows may only be added, and only ones that judge towards `irreversible`; a row that
 * would need `stat` (an `mv` over an existing file) is not one.
 */
export function commandReversibility(command: string): Reversibility {
  return COMMAND_PATTERNS.some((row) => row.test(command)) ? 'irreversible' : 'unknown'
}

/**
 * A command word: not inside another word or path segment (`form`, `rm.txt` and `--rm` are not `rm`;
 * `/bin/rm`, `\rm` and `"rm` are). Case-insensitive, as a case-insensitive disk finds `RM` too.
 */
function word(name: string): RegExp {
  return new RegExp(`(?<![\\w.-])${name}(?![\\w.-])`, 'i')
}

/** An option, starting a word: after a space, a quote or the start of the text. */
function option(source: string): RegExp {
  return new RegExp(`(?<![^\\s'"])(?:${source})`)
}

/** Each pattern matches, in order, each somewhere after the end of the one before. */
function inOrder(...patterns: readonly RegExp[]): (command: string) => boolean {
  return (command) => {
    let rest = command
    for (const pattern of patterns) {
      const match = pattern.exec(rest)
      if (match === null) return false
      rest = rest.slice(match.index + match[0].length)
    }
    return true
  }
}

const GIT = word('git')

/**
 * The rows (E1: deleting an existing file, sending content out). `curl`'s short options may be
 * bundled (`-sSd`); a flag after the command word counts wherever it stands.
 */
const COMMAND_PATTERNS: ReadonlyArray<{
  readonly row: string
  readonly test: (c: string) => boolean
}> = [
  { row: 'rm', test: inOrder(word('rm')) },
  { row: 'rmdir', test: inOrder(word('rmdir')) },
  { row: 'find -delete', test: inOrder(word('find'), option('-delete(?![\\w-])')) },
  {
    row: 'curl sending a body or a POST',
    test: inOrder(
      word('curl'),
      option(
        [
          '-[A-Za-z]*X\\s*[\'"]?POST(?![\\w-])', // -X POST, -XPOST
          '--request(?:\\s+|=)[\'"]?POST(?![\\w-])',
          '-[A-Za-z]*[dFT]', // -d, -F, -T, bundled or with the value attached
          '--(?:data(?:-[a-z]+)?|form(?:-string)?|upload-file|json)(?![\\w-])',
        ].join('|'),
      ),
    ),
  },
  { row: 'wget posting', test: inOrder(word('wget'), option('--post-(?:data|file)(?![\\w-])')) },
  { row: 'git push', test: inOrder(GIT, word('push')) },
  {
    row: 'git clean -f',
    test: inOrder(GIT, word('clean'), option('-[A-Za-z]*f|--force(?![\\w-])')),
  },
  { row: 'scp', test: inOrder(word('scp')) },
  {
    // A remote `[user@]host:path` or `rsync://` operand; which side it stands on is not parsed.
    row: 'rsync to a remote host',
    test: inOrder(word('rsync'), option('rsync://|(?:[\\w.+-]+@)?[A-Za-z0-9][\\w.-]*:')),
  },
]

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

/** A URL's exact host, lower-cased without its DNS root dot (§搜索与抓取).  */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/u, '')
  } catch {
    return ''
  }
}
