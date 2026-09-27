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
  globMatcher,
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

export interface GrepOptions {
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
      ? (await walkFiles(q.fs, q.target, q.scope, q.signal)).filter((file) => filter.test(file))
      : [{ path: q.target, relative: basename(q.target) }]
    // Only the page is kept; the entries around it are counted, so memory stays bounded by
    // `head_limit` however much the walk finds or one file holds, and the note can still name the
    // total.
    const found: GrepPage = {
      offset: options.offset,
      end: options.headLimit === 0 ? Infinity : options.offset + options.headLimit,
      kept: [],
      total: 0,
    }
    for (const file of files) {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time, the stop checked between
      const text = await searchable(q, file.path)
      checkSignal(q.signal)
      if (text === null) continue
      entriesOf(found, file.path, text, regex.value, options)
    }
    return succeeded(page(found, options))
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

/**
 * The pattern as a global regex: Unicode-aware when it parses that way, else as written. Without the
 * `u` flag `.` and a class match one UTF-16 code unit, so every part a match shows is widened to
 * whole code points (`wholePart`): ripgrep's `.` matches a whole character.
 */
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
      const matcher = globMatcher(glob)
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
    const matchers = globs.map((pattern) => globMatcher(pattern))
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

/**
 * The page one call fills, file after file: every entry found is counted into `total`, and only the
 * ones from `offset` up to `end` are built and kept. One file's entries come a line at a time and
 * are built only on the page (s18-safety-3), so past the file's own text a call holds the page and
 * one line, however many lines the file has — `head_limit` 0, no limit, keeps them all (the owner's).
 */
export interface GrepPage {
  readonly offset: number
  readonly end: number
  readonly kept: string[]
  total: number
}

/** Counts one entry, and builds and keeps it only when it lands on the page. */
function put(found: GrepPage, entry: () => string): void {
  if (found.total >= found.offset && found.total < found.end) found.kept.push(entry())
  found.total += 1
}

/** One file's entries in the chosen mode, onto the page: nothing when it has no match. */
export function entriesOf(
  found: GrepPage,
  path: AbsolutePath,
  content: string,
  regex: RegExp,
  o: GrepOptions,
): void {
  const hits = o.multiline ? multilineHits(content, regex) : lineHits(content, regex)
  if (o.mode === 'files_with_matches') {
    // The first hit names the file; the rest of it is not searched.
    if (hits.next().done !== true) put(found, () => path)
    return
  }
  if (o.mode === 'count') {
    let count = 0
    for (let next = hits.next(); next.done !== true; next = hits.next()) count += 1
    if (count > 0) put(found, () => `${path}:${String(count)}`)
    return
  }
  if (o.onlyMatching) {
    for (const hit of hits) {
      for (const [start, end] of wholeSpans(hit.text, hit.matches)) {
        put(found, () => {
          const part = hit.text.slice(start, end)
          return o.lineNumbers ? `${path}:${String(hit.line)}:${part}` : `${path}:${part}`
        })
      }
    }
    return
  }
  showLines(found, path, content, hits, o)
}

/**
 * Content mode: each matched line with its context, in line order, as ripgrep prints them. The
 * matched lines come in order, so a line is shown once, after the context left over from the match
 * before and the context before it; its text is read only when it lands on the page.
 */
function showLines(
  found: GrepPage,
  path: AbsolutePath,
  content: string,
  hits: Iterable<Hit>,
  o: GrepOptions,
): void {
  const context = o.before > 0 || o.after > 0
  const lineText = lineReader(content)
  let shown = 0
  let matched = 0
  const show = (n: number, mark: ':' | '-'): void => {
    // Groups of context are set apart as ripgrep does; without context there are no groups.
    if (context && shown !== 0 && n > shown + 1) put(found, () => '--')
    put(found, () => {
      const line = lineText(n)
      return o.lineNumbers ? `${path}${mark}${String(n)}${mark}${line}` : `${path}${mark}${line}`
    })
    shown = n
  }
  for (const hit of hits) {
    // A multiline hit matches every line it spans; a line a hit before it matched is not again.
    for (let n = Math.max(hit.line, matched + 1); n <= hit.lastLine; n += 1) {
      const after = matched === 0 ? 0 : matched + o.after
      for (let k = shown + 1; k < n && k <= after; k += 1) show(k, '-')
      for (let k = Math.max(shown + 1, n - o.before); k < n; k += 1) show(k, '-')
      show(n, ':')
      matched = n
    }
  }
  if (matched === 0 || o.after === 0) return
  const last = Math.min(matched + o.after, lineCount(content))
  for (let k = shown + 1; k <= last; k += 1) show(k, '-')
}

/**
 * A matched line, or the lines a multiline match spans, and the text its matches index into: the
 * line itself, or the whole file.
 */
interface Hit {
  readonly line: number
  readonly lastLine: number
  readonly text: string
  readonly matches: readonly RegExpExecArray[]
}

/**
 * The hits of a file, one line at a time: its lines as `linesOf` splits them — on `\n`, a final one
 * ending the last line — never all of them at once.
 */
function* lineHits(content: string, regex: RegExp): Generator<Hit, void, undefined> {
  let n = 0
  for (let start = 0; start < content.length;) {
    const newline = content.indexOf('\n', start)
    const end = newline === -1 ? content.length : newline
    const line = content.slice(start, end)
    n += 1
    const matches = [...line.matchAll(regex)]
    if (matches.length > 0) yield { line: n, lastLine: n, text: line, matches }
    start = end + 1
  }
}

/** The line numbers of increasing offsets, counted forward: no table of where each line starts. */
function lineCounter(content: string): (index: number) => number {
  let line = 1
  let newline = content.indexOf('\n')
  return (index) => {
    while (newline !== -1 && newline < index) {
      line += 1
      newline = content.indexOf('\n', newline + 1)
    }
    return line
  }
}

/** Line `n`'s text, for numbers asked in increasing order: read forward, the file never split. */
function lineReader(content: string): (n: number) => string {
  let line = 1
  let start = 0
  return (n) => {
    for (; line < n; line += 1) start = content.indexOf('\n', start) + 1
    const newline = content.indexOf('\n', start)
    return content.slice(start, newline === -1 ? content.length : newline)
  }
}

/** How many lines `linesOf` finds in a text, without splitting it. */
function lineCount(content: string): number {
  if (content.length === 0) return 0
  let count = 0
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) count += 1
  return content.endsWith('\n') ? count : count + 1
}

/**
 * The spans the matches show, each widened to whole code points: a match that begins on the low half
 * of a surrogate pair takes its high half, and one that ends on a high half takes its low half. A span
 * that then overlaps the one before joins it, so a character is shown once. Half a pair would be
 * stored on the Tape and sent in every later request (§内置工具与参数「不切开代理对」, 「正则方言跟
 * ripgrep」). An empty match shows nothing.
 */
function wholeSpans(text: string, matches: readonly RegExpExecArray[]): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const match of matches) {
    if (match[0] === '') continue
    let start = match.index
    let end = start + match[0].length
    if (isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
      start -= 1
    }
    if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end += 1
    const last = spans.at(-1)
    if (last !== undefined && start < last[1]) last[1] = Math.max(last[1], end)
    else spans.push([start, end])
  }
  return spans
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** The hits of a multiline pattern, one match at a time; an empty match is none. */
function* multilineHits(content: string, regex: RegExp): Generator<Hit, void, undefined> {
  const lineAt = lineCounter(content)
  for (const match of content.matchAll(regex)) {
    if (match[0] === '') continue
    const line = lineAt(match.index)
    const lastLine = lineAt(match.index + match[0].length - 1)
    yield { line, lastLine, text: content, matches: [match] }
  }
}

/**
 * `offset` entries skipped, then at most `head_limit` (0: all), with a note when some were left.
 * `kept` holds just those entries, of `total` found.
 */
function page({ kept, total }: GrepPage, o: GrepOptions): string {
  if (total === 0) return GREP_TEXTS.none
  const from = Math.min(o.offset, total)
  const to = o.headLimit === 0 ? total : Math.min(total, from + o.headLimit)
  const shown = kept.join('\n')
  if (to >= total) return shown.length === 0 ? GREP_TEXTS.none : shown
  const note = fill(GREP_TEXTS.more, {
    from: String(from + 1),
    to: String(to),
    total: String(total),
    next: String(to),
  })
  return `${shown}\n\n${note}`
}

function basename(path: AbsolutePath): string {
  return path.split(/[\\/]/).at(-1) ?? path
}
