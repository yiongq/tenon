/**
 * Two readings made before `decide()`: reversibility and the call's own card reason.
 *
 * Reversibility is pure over the tool, arguments and host coverage (spec 05 §点名): only Write,
 * Edit and Delete can be `snapshotted`. A model or inspector cannot supply coverage. Connector
 * tools stay `unknown` unless a policy says otherwise (6b).
 *
 * Plan step 11 wrote everything but Bash's conservative pattern table, which is plan step 22's: a
 * command is `irreversible` when the table matches it and `unknown` otherwise — never `read-only`.
 */
import type { AbsolutePath, Reversibility, SnapshotCoverage } from '../host/adapter.js'
import type { SandboxPlan, ToolOrigin } from '../tape/entry.js'
import type { CallReason } from './decide.js'
import type { PathPlace } from './workspace.js'

export function reversibilityOf(
  tool: Pick<ToolOrigin, 'source' | 'originalName'>,
  args: Readonly<Record<string, unknown>>,
  coverage?: SnapshotCoverage,
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
    case 'Write':
    case 'Edit':
      return coverage === 'tree' || coverage === 'file' ? 'snapshotted' : 'unknown'
    case 'Delete':
      return coverage === 'tree' || coverage === 'file' ? 'snapshotted' : 'irreversible'
    default:
      // Agent, WebSearch, WebFetch.
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
 * bundled (`-sSd`); a flag after the command word counts wherever it stands. Command words are
 * case-insensitive, but options keep their case (`git branch -D` is not `git branch -d`).
 */
const COMMAND_PATTERNS: ReadonlyArray<{
  readonly row: string
  readonly hits?: readonly string[]
  readonly misses?: readonly string[]
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
  { row: 'npm publish', test: inOrder(word('npm'), word('publish')) },
  { row: 'pnpm publish', test: inOrder(word('pnpm'), word('publish')) },
  // Includes `yarn npm publish`; this table does not parse intervening arguments.
  { row: 'yarn publish', test: inOrder(word('yarn'), word('publish')) },
  { row: 'docker push', test: inOrder(word('docker'), word('push')) },
  { row: 'podman push', test: inOrder(word('podman'), word('push')) },
  { row: 'gh release create', test: inOrder(word('gh'), word('release'), word('create')) },
  { row: 'twine upload', test: inOrder(word('twine'), word('upload')) },
  {
    row: 'git branch force delete',
    test: (command) =>
      inOrder(GIT, word('branch'), option('-[A-Za-z]*D'))(command) ||
      (inOrder(GIT, word('branch'), option('--delete(?![\\w-])'))(command) &&
        inOrder(GIT, word('branch'), option('--force(?![\\w-])'))(command)),
  },
  { row: 'git stash drop', test: inOrder(GIT, word('stash'), word('drop')) },
  { row: 'git stash clear', test: inOrder(GIT, word('stash'), word('clear')) },
  { row: 'kubectl delete', test: inOrder(word('kubectl'), word('delete')) },
  {
    row: 'shred removing a file',
    test: inOrder(word('shred'), option('-[A-Za-z]*u|--remove(?![\\w-])')),
  },
  {
    row: 'curl DELETE',
    test: inOrder(
      word('curl'),
      option('-[A-Za-z]*X\\s*[\'"]?DELETE(?![\\w-])|--request(?:\\s+|=)[\'"]?DELETE(?![\\w-])'),
    ),
  },
  {
    row: 'git reset --hard',
    test: inOrder(GIT, word('reset'), option('--hard(?![\\w-])')),
    hits: ['git reset --hard', 'git reset --hard=HEAD~1'],
    misses: ['git reset --soft HEAD~1', 'git reset --harder'],
  },
  {
    row: 'git checkout -- or dot',
    test: inOrder(GIT, word('checkout'), option('(?:--|\\.)(?=\\s|$|[\'"])')),
    hits: ['git checkout -- x', 'git checkout .'],
    misses: ['git checkout main', 'git checkout -b x', 'git checkout ./x'],
  },
  {
    row: 'git checkout force',
    test: inOrder(GIT, word('checkout'), option('(?:-f|--force)(?![\\w-])')),
    hits: ['git checkout -f main', 'git checkout --force main'],
    misses: ['git checkout main', 'git checkout --forceful main'],
  },
  {
    row: 'git restore worktree',
    test: (command) => {
      const match = new RegExp(`${GIT.source}[\\s\\S]*?${word('restore').source}`, 'i').exec(
        command,
      )
      if (match === null) return false
      const tail = command.slice(match.index + match[0].length)
      return (
        !option('(?:--staged|-S)(?![\\w-])').test(tail) ||
        option('(?:--worktree|-W)(?![\\w-])').test(tail)
      )
    },
    hits: ['git restore x', 'git restore --staged --worktree x', 'git restore -S -W x'],
    misses: ['git restore --staged x', 'git restore -S x', 'git status'],
  },
  {
    row: 'git switch discard changes',
    test: inOrder(GIT, word('switch'), option('(?:--discard-changes|-f|--force)(?![\\w-])')),
    hits: ['git switch --discard-changes main', 'git switch -f main', 'git switch --force main'],
    misses: ['git switch main', 'git switch --forceful main'],
  },
  {
    row: 'truncate',
    test: inOrder(word('truncate')),
    hits: ['truncate -s 0 x', '/usr/bin/truncate -s 1 x'],
    misses: ['echo truncated', 'cat truncate.txt'],
  },
  {
    row: 'dd of=',
    test: inOrder(word('dd'), option('of=')),
    hits: ['dd if=/dev/zero of=x', 'dd of=x'],
    misses: ['dd if=x', 'echo odd of=x'],
  },
]

/** D3 uses the original text, including quoted text; it is deliberately not a shell parser. */
export function autoStillAsk(command: string): 'redirect' | null {
  const rest = command.replace(/>>|>&|=>|->|>=|>\s*\/dev\/null(?![\w/.-])/g, '')
  return rest.includes('>') ? 'redirect' : null
}

// A broken pattern must fail at load, before any call can rely on it.
for (const row of COMMAND_PATTERNS) {
  if (
    row.hits?.some((sample) => !row.test(sample)) ||
    row.misses?.some((sample) => row.test(sample))
  ) {
    throw new Error(`command pattern self-test failed: ${row.row}`)
  }
}
for (const [sample, expected] of [
  ['npm test > out.log', 'redirect'],
  ['npm test >> out.log', null],
  ['npm test 2>&1', null],
  ['npm test >&2', null],
  ['npm test > /dev/null', null],
  ['x => x', null],
  ['a -> b', null],
  ['a >= b', null],
] as const) {
  if (autoStillAsk(sample) !== expected) throw new Error(`redirect self-test failed: ${sample}`)
}

/** The file tools: the ones a path decides for (§「在不在工作区里」). */
export const FILE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'Delete',
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
  readonly sensitive?: 'credential' | 'auto-run' | 'hardlink'
  readonly real?: AbsolutePath
  /** The workspace's first folder: the `outside-workspace` card's `workspace` slot and the cwd (暂定). */
  readonly workspace: AbsolutePath | null
  /** WebSearch's backend host (H8). */
  readonly searchHost: string | null
  readonly sandbox?: SandboxPlan
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
      if (q.sensitive !== undefined)
        return {
          reason: 'sensitive-path',
          facts: { path, category: q.sensitive, toolName, target: path },
        }
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
      return {
        reason: q.sandbox?.override?.action === 'rerun-unsandboxed' ? 'elevated' : 'command',
        facts: {
          command,
          cwd: q.workspace ?? '',
          toolName,
          ...(q.sandbox?.unavailable === true ? { sandbox: 'unavailable' } : {}),
        },
      }
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
