/**
 * Grep (spec 02 §内置工具与参数「Glob、Grep」). The executor lands with plan step 18: in process, over
 * `HostFs`, with JavaScript regular expressions standing in for ripgrep's dialect and a table of the
 * common ripgrep types (暂定: the engine and the dialect are weighed in plan step 22). Files are
 * searched in path order; one that is not text, too large or unreadable is skipped, as ripgrep skips it.
 */
import type { AbsolutePath } from '../../host/adapter.js'
import { fill } from '../../prompts/index.js'
import type { ToolExecutor } from '../executor.js'
import type { WalkedFile } from './files.js'
import {
  FILE_READ_MAX_BYTES,
  FILE_TEXTS,
  WalkAborted,
  checkSignal,
  decodeText,
  failed,
  globToRegExp,
  linesOf,
  succeeded,
  walkFiles,
  whenThrown,
} from './files.js'
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, NOT_ABSOLUTE, absolutePathCheck } from './tool.js'

const DESCRIPTION = [
  'Searches file contents with a regular expression, using ripgrep syntax.',
  'It searches under path, or under the first workspace folder when path is omitted; glob and type narrow the files searched.',
  'output_mode is files_with_matches by default (the paths of matching files); content shows the matching lines, and count the number of matches per file.',
  '-n (line numbers, on by default), -o, -A, -B, -C and context apply to content mode only.',
  'head_limit caps the entries returned (default 250, 0 for no limit) and offset skips entries first.',
].join(' ')

/** Grep's result texts and its own errors (§提示层). */
export const GREP_TEXTS = {
  notAbsolute: NOT_ABSOLUTE,
  ...FILE_TEXTS,
  none: 'No matches found.',
  more: 'Showed entries {from} to {to} of {total}. Call Grep again with offset {next} to see more.',
  invalidPattern: 'The pattern is not a regular expression Grep can use: {message}',
  invalidGlob: '{glob} is not a glob pattern Grep can read: {message}',
  unknownType: '{type} is not a file type Grep knows. Use glob to name the files instead.',
} as const

/** The default of head_limit (sdk-tools; 0 means no limit). */
export const GREP_HEAD_LIMIT = 250

/** The ripgrep types Grep knows (a subset of `rg --type-list`), as basename globs. */
const TYPES: Readonly<Record<string, readonly string[]>> = {
  c: ['*.c', '*.h'],
  cpp: ['*.cpp', '*.cc', '*.cxx', '*.hpp', '*.hh', '*.hxx', '*.h'],
  cs: ['*.cs'],
  css: ['*.css', '*.scss', '*.sass', '*.less'],
  go: ['*.go'],
  html: ['*.html', '*.htm'],
  java: ['*.java'],
  js: ['*.js', '*.mjs', '*.cjs', '*.jsx'],
  json: ['*.json'],
  kotlin: ['*.kt', '*.kts'],
  lua: ['*.lua'],
  markdown: ['*.md', '*.markdown'],
  md: ['*.md', '*.markdown'],
  php: ['*.php'],
  py: ['*.py', '*.pyi'],
  ruby: ['*.rb'],
  rust: ['*.rs'],
  sh: ['*.sh', '*.bash', '*.zsh'],
  sql: ['*.sql'],
  swift: ['*.swift'],
  toml: ['*.toml'],
  ts: ['*.ts', '*.tsx', '*.mts', '*.cts'],
  txt: ['*.txt'],
  xml: ['*.xml'],
  yaml: ['*.yaml', '*.yml'],
}

const flag = (description: string): Record<string, unknown> => ({ type: 'boolean', description })
const lines = (description: string): Record<string, unknown> => ({
  type: 'integer',
  minimum: 0,
  description,
})

export const GREP_TOOL: BuiltinTool = {
  name: 'Grep',
  spec: () => ({
    name: 'Grep',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          minLength: 1,
          description: 'The regular expression to search for.',
        },
        path: {
          type: 'string',
          description:
            'The absolute path of the file or folder to search. Omit it to search the workspace.',
        },
        glob: {
          type: 'string',
          description: 'Only search files matching this glob, such as `*.ts`.',
        },
        type: {
          type: 'string',
          description: 'Only search files of this ripgrep type, such as `py`.',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'What to return (default files_with_matches).',
        },
        '-i': flag('Match case-insensitively.'),
        '-n': flag('Show line numbers (content mode; default true).'),
        '-o': flag('Show only the matching part of each line (content mode).'),
        '-A': lines('Lines of context after each match (content mode).'),
        '-B': lines('Lines of context before each match (content mode).'),
        '-C': lines('Lines of context before and after each match (content mode).'),
        context: lines('The same as -C.'),
        head_limit: lines('Return at most this many entries (default 250; 0 for no limit).'),
        offset: lines('Skip this many entries first (default 0).'),
        multiline: flag('Let the pattern match across lines (default false).'),
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  }),
  effect: 'read',
  profiles: COWORK_ONLY,
  check: (args) => absolutePathCheck(args, 'path'),
  texts: GREP_TEXTS,
}

type Mode = 'content' | 'files_with_matches' | 'count'

interface GrepOptions {
  readonly mode: Mode
  readonly lineNumbers: boolean
  readonly onlyMatching: boolean
  readonly before: number
  readonly after: number
  readonly multiline: boolean
  readonly headLimit: number
  readonly offset: number
}

/** Searches the decision's real path: a file, or a folder — `path`, or the first workspace folder. */
export const grepExecutor: ToolExecutor = async (q) => {
  if (q.target === null) throw new Error('Grep: a call reached its executor with no target path')
  const input = q.input
  const options = optionsOf(input)
  const regex = regexOf(String(input['pattern'] ?? ''), input['-i'] === true, options.multiline)
  if ('failure' in regex) return regex.failure
  const filter = fileFilterOf(input)
  if ('failure' in filter) return filter.failure
  try {
    const stat = await q.fs.stat(q.target)
    if (stat === null) return failed(fill(GREP_TEXTS.notFound, { path: q.target }))
    const files: WalkedFile[] = stat.isDir
      ? (await walkFiles(q.fs, q.target, q.roots, q.signal)).filter((file) => filter.test(file))
      : [{ path: q.target, relative: basename(q.target) }]
    const entries: string[] = []
    for (const file of files) {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time, the stop checked between
      const text = await searchable(q, file.path)
      checkSignal(q.signal)
      if (text !== null) entries.push(...entriesOf(file.path, text, regex.value, options))
    }
    return succeeded(page(entries, options))
  } catch (error) {
    return whenThrown(error, q.target)
  }
}

function optionsOf(input: Readonly<Record<string, unknown>>): GrepOptions {
  const int = (key: string): number | null =>
    typeof input[key] === 'number' ? (input[key] as number) : null
  const around = int('-C') ?? int('context') ?? 0
  const mode = input['output_mode']
  return {
    mode: mode === 'content' || mode === 'count' ? mode : 'files_with_matches',
    lineNumbers: input['-n'] !== false,
    onlyMatching: input['-o'] === true,
    before: int('-B') ?? around,
    after: int('-A') ?? around,
    multiline: input['multiline'] === true,
    headLimit: int('head_limit') ?? GREP_HEAD_LIMIT,
    offset: int('offset') ?? 0,
  }
}

/** The pattern as a global regex: Unicode-aware when it parses that way, else as written. */
function regexOf(
  pattern: string,
  ignoreCase: boolean,
  multiline: boolean,
): { value: RegExp } | { failure: ReturnType<typeof failed> } {
  const flags = `g${ignoreCase ? 'i' : ''}${multiline ? 's' : ''}`
  try {
    return { value: new RegExp(pattern, `${flags}u`) }
  } catch {
    try {
      return { value: new RegExp(pattern, flags) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { failure: failed(fill(GREP_TEXTS.invalidPattern, { message })) }
    }
  }
}

/** `glob` and `type` narrow the files: a glob without `/` matches the file name, one with it the path. */
function fileFilterOf(
  input: Readonly<Record<string, unknown>>,
): { test: (file: WalkedFile) => boolean } | { failure: ReturnType<typeof failed> } {
  const tests: Array<(file: WalkedFile) => boolean> = []
  const glob = input['glob']
  if (typeof glob === 'string') {
    try {
      const matcher = globToRegExp(glob)
      tests.push((file) => matcher.test(glob.includes('/') ? file.relative : basename(file.path)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { failure: failed(fill(GREP_TEXTS.invalidGlob, { glob, message })) }
    }
  }
  const type = input['type']
  if (typeof type === 'string') {
    const globs = TYPES[type]
    if (globs === undefined) return { failure: failed(fill(GREP_TEXTS.unknownType, { type })) }
    const matchers = globs.map((pattern) => globToRegExp(pattern))
    tests.push((file) => matchers.some((matcher) => matcher.test(basename(file.path))))
  }
  return { test: (file) => tests.every((test) => test(file)) }
}

/** A file's text when it is worth searching: not too large, text, readable. */
async function searchable(
  q: Parameters<ToolExecutor>[0],
  path: AbsolutePath,
): Promise<string | null> {
  try {
    const stat = await q.fs.stat(path)
    if (stat === null || stat.isDir || stat.size > FILE_READ_MAX_BYTES) return null
    checkSignal(q.signal)
    return decodeText(await q.fs.readFile(path))
  } catch (error) {
    if (error instanceof WalkAborted) throw error
    return null
  }
}

/** One file's entries in the chosen mode: nothing when it has no match. */
function entriesOf(path: AbsolutePath, content: string, regex: RegExp, o: GrepOptions): string[] {
  const fileLines = linesOf(content)
  const hits = o.multiline ? multilineHits(content, regex) : lineHits(fileLines, regex)
  if (hits.length === 0) return []
  if (o.mode === 'files_with_matches') return [path]
  if (o.mode === 'count') return [`${path}:${String(hits.length)}`]
  if (o.onlyMatching) {
    return hits.flatMap((hit) =>
      hit.parts.map((part) =>
        o.lineNumbers ? `${path}:${String(hit.line)}:${part}` : `${path}:${part}`,
      ),
    )
  }
  const matched = new Set<number>()
  for (const hit of hits) for (let n = hit.line; n <= hit.lastLine; n += 1) matched.add(n)
  const shown = new Set<number>()
  for (const n of matched) {
    for (let k = Math.max(1, n - o.before); k <= Math.min(fileLines.length, n + o.after); k += 1) {
      shown.add(k)
    }
  }
  const out: string[] = []
  let previous = 0
  for (const n of [...shown].toSorted((a, b) => a - b)) {
    // Groups of context are set apart as ripgrep does; without context there are no groups.
    const context = o.before > 0 || o.after > 0
    if (context && previous !== 0 && n > previous + 1) out.push('--')
    const mark = matched.has(n) ? ':' : '-'
    const line = fileLines[n - 1] ?? ''
    out.push(o.lineNumbers ? `${path}${mark}${String(n)}${mark}${line}` : `${path}${mark}${line}`)
    previous = n
  }
  return out
}

interface Hit {
  readonly line: number
  readonly lastLine: number
  readonly parts: readonly string[]
}

function lineHits(fileLines: readonly string[], regex: RegExp): Hit[] {
  const hits: Hit[] = []
  fileLines.forEach((line, i) => {
    const matches = [...line.matchAll(regex)]
    if (matches.length === 0) return
    const parts = matches.map((match) => match[0]).filter((part) => part !== '')
    hits.push({ line: i + 1, lastLine: i + 1, parts })
  })
  return hits
}

function multilineHits(text: string, regex: RegExp): Hit[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1)
  const lineAt = (index: number): number => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if ((starts[mid] ?? 0) <= index) low = mid
      else high = mid - 1
    }
    return low + 1
  }
  const hits: Hit[] = []
  for (const match of text.matchAll(regex)) {
    if (match[0] === '') continue
    const first = lineAt(match.index)
    const last = lineAt(match.index + match[0].length - 1)
    hits.push({ line: first, lastLine: last, parts: [match[0]] })
  }
  return hits
}

/** `offset` entries skipped, then at most `head_limit` (0: all), with a note when some were left. */
function page(entries: readonly string[], o: GrepOptions): string {
  if (entries.length === 0) return GREP_TEXTS.none
  const from = Math.min(o.offset, entries.length)
  const to = o.headLimit === 0 ? entries.length : Math.min(entries.length, from + o.headLimit)
  const shown = entries.slice(from, to).join('\n')
  if (to >= entries.length) return shown.length === 0 ? GREP_TEXTS.none : shown
  const note = fill(GREP_TEXTS.more, {
    from: String(from + 1),
    to: String(to),
    total: String(entries.length),
    next: String(to),
  })
  return `${shown}\n\n${note}`
}

function basename(path: AbsolutePath): string {
  return path.split(/[\\/]/).at(-1) ?? path
}
