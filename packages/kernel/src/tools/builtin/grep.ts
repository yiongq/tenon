/**
 * Grep (spec 02 §内置工具与参数「Glob、Grep」). The executor lands with plan step 18: in process, over
 * `HostFs`, with a table of the common ripgrep types. Files are searched in path order; one that is
 * not text, too large or unreadable is skipped, as ripgrep skips it.
 *
 * The engine is re2js (plan step 22, weighed against a matcher of our own and a killable worker):
 * RE2's dialect, the family of ripgrep's default engine, with the pattern first rewritten where the
 * two read it differently (「正则方言跟 ripgrep」; `ripgrepPattern`). Like ripgrep without `--pcre2`,
 * it has no look-around and no backreferences.
 *
 * What is bounded (s18-safety-2, adv-3), measured on re2js 2.8.6: matching takes time linear in the
 * text, by a factor that grows with the compiled program, and the program is capped at
 * `GREP_MAX_PROGRAM` instructions — checked on the text before compiling, and on the program after.
 * The cap also bounds re2js's lazy DFA. It keeps at most 10 010 states, its fixed 8 MB budget read at
 * 838 bytes a state (`RE2JS.compile` takes no budget; only `RE2Set` does, and it finds no positions),
 * while each state holds two 256-entry tables and one entry per instruction it is in: about 50 MB
 * full at any size, about 100 MB at the cap, where 142 000 instructions ran a line toward gigabytes.
 * What is not bounded is how long one call holds the main process: files are searched there one by
 * one, the stop checked only between them, and within the cap a line still costs 10 to 15 ms an
 * instruction a MB when the DFA cannot settle, or under `-o` and multiline, which re2js matches on
 * its NFA — 0.3 s a MB for a hostile pattern of 36 instructions, tens of seconds a MB at the cap.
 * Counted repeats, the usual large patterns, settle: `.{1000}` written three times, 3 003
 * instructions, takes 0.17 s over a 1 MB line.
 */
import { RE2JS } from 're2js'
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
  lookaround: 'look-around, including look-ahead and look-behind, is not supported',
  backreference: 'backreferences are not supported',
  classSet: 'nested classes and the class set operations &&, -- and ~~ are not supported',
  negatedNonWord: '\\W is not supported inside a negated class [^...]',
  wordBoundary: '\\<, \\> and \\b{...} are not supported; \\b and \\B are',
  tooLarge: 'the pattern is too large; shorten it or lower its repetition counts',
  invalidGlob: '{glob} is not a glob pattern Grep can read: {message}',
  unknownType: '{type} is not a file type Grep knows. Use glob to name the files instead.',
} as const

/** The default of head_limit (sdk-tools; 0 means no limit). */
export const GREP_HEAD_LIMIT = 250

/**
 * The most instructions a compiled pattern may have (adv-3; re2js's own limit is about 3.3 million).
 * Ordinary patterns compile to tens, `\w{1000}` to 1 002 and `\w{1,1000}` or `.{0,1000}` to about
 * 2 000; `.{1000}` written 142 times, 994 characters, compiles to 142 002 and took 1.9 s over one
 * 10 KB line. See the file's head for what the cap bounds and what it does not. 待校准（第 34 步）.
 */
export const GREP_MAX_PROGRAM = 3000

/**
 * The text's bound on the program above which a pattern is turned down without being compiled.
 * The bound counts high (one-character alternatives compile to one class), so it gets ten times the
 * cap; compiling costs re2js about 0.3 µs and 300 bytes an instruction, and a pattern at re2js's own
 * limit took 1.1 s and 1 GB before the cap could be read.
 */
const TEXT_BOUND_LIMIT = 10 * GREP_MAX_PROGRAM

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
 * The pattern compiled as ripgrep compiles it: rewritten into its dialect (`ripgrepPattern`), `-i`
 * folding case, and `multiline` as `rg -U --multiline-dotall`, where `.` matches a newline and, since
 * ripgrep always sets multi-line, `^` and `$` match at each line's ends. A pattern turned down comes
 * back as `invalidPattern`: with ripgrep's own reason for look-around and backreferences, re2js's for
 * the rest of what it cannot parse — in the words of the pattern as written, not as rewritten — and
 * `tooLarge` for a program over `GREP_MAX_PROGRAM`, by its text or once compiled.
 */
function regexOf(
  pattern: string,
  ignoreCase: boolean,
  multiline: boolean,
): { value: RE2JS } | { failure: ReturnType<typeof failed> } {
  const flags =
    (ignoreCase ? RE2JS.CASE_INSENSITIVE : 0) | (multiline ? RE2JS.DOTALL | RE2JS.MULTILINE : 0)
  const invalid = (message: string): { failure: ReturnType<typeof failed> } => ({
    failure: failed(fill(GREP_TEXTS.invalidPattern, { message })),
  })
  const read = ripgrepPattern(pattern)
  if ('message' in read) return invalid(read.message)
  if (read.bound > TEXT_BOUND_LIMIT) return invalid(GREP_TEXTS.tooLarge)
  let regex: RE2JS
  try {
    regex = RE2JS.compile(read.source, flags)
  } catch (error) {
    return invalid(unsupported(pattern) ?? compileError(pattern, flags, error))
  }
  return regex.programSize() > GREP_MAX_PROGRAM ? invalid(GREP_TEXTS.tooLarge) : { value: regex }
}

/** re2js's reason for turning down the pattern as written, or else the rewritten one's `error`. */
function compileError(pattern: string, flags: number, error: unknown): string {
  try {
    RE2JS.compile(pattern, flags)
  } catch (original) {
    return original instanceof Error ? original.message : String(original)
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * ripgrep's Unicode word characters (UTS #18, as its `\w` has them), as class items re2js reads:
 * Alphabetic, marks, decimal digits, connector punctuation, and the two joiners. It starts and ends
 * on a property, so a `-` beside it reads as it did beside `\w`.
 */
const WORD = '\\p{Alphabetic}\\p{M}\\x{200C}-\\x{200D}\\p{Nd}\\p{Pc}'

/** ripgrep's Perl classes in a class; `\W` has no item re2js reads (see `classOf`). */
const PERL_IN_CLASS: Readonly<Record<string, string>> = {
  w: WORD,
  d: '\\p{Nd}',
  D: '\\P{Nd}',
  s: '\\p{White_Space}',
  S: '\\P{White_Space}',
}

/** ripgrep's `\W`, outside a class or as the alternative `classOf` writes for it. */
const NON_WORD = `[^${WORD}]`

/** ripgrep's Perl classes outside a class. */
const PERL: Readonly<Record<string, string>> = { ...PERL_IN_CLASS, w: `[${WORD}]`, W: NON_WORD }

/** What `ripgrepPattern` reads a pattern as: re2js's source for it, and a bound on its program. */
interface ReadPattern {
  readonly source: string
  readonly bound: number
}

/**
 * The pattern as ripgrep reads it, written for re2js (「正则方言跟 ripgrep」). ripgrep's `\d`, `\s` and
 * `\w` and their negations are Unicode — `\p{Nd}`, `\p{White_Space}` and `WORD` — where RE2's are
 * ASCII, so they are written out, outside a class and in one. Over every code point the result agrees
 * with rg 15.2 except on the ones Unicode 17 added, which re2js's tables have and rg's do not; before,
 * `\w` differed on 144 604. What re2js would misread without a word is turned down: ripgrep's nested
 * classes and class set operations, which re2js takes as literal characters (`classOf`), and its
 * `\<`, `\>` and `\b{…}`. Escapes are stepped over whole, and `\Q…\E` is left as written.
 *
 * Known gap: `\b` and `\B` stay ASCII. RE2 has no Unicode word boundary and none can be built without
 * look-around, so `\b用户` misses 用户 at the start of a line or after a space, where ripgrep finds it.
 *
 * The walk also bounds the program re2js will compile, from the text: one instruction a character,
 * escape or class (three for the alternative `classOf` may write), two more a group, one more an
 * alternative or a `*`, `+` or `?`, and `{n,m}` its operand's bound plus one, times `m`.
 */
function ripgrepPattern(pattern: string): ReadPattern | { readonly message: string } {
  let source = ''
  // The bound of each enclosing group read so far, of the group being read, and of the last operand.
  const groups: number[] = []
  let bound = 2
  let operand = 0
  const emit = (text: string, size: number): void => {
    source += text
    bound += size
    operand = size
  }
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i] ?? ''
    const next = pattern[i + 1] ?? ''
    const repeat =
      c === '{' ? /^\{(\d{1,4})(?:(,)(\d{0,4}))?\}/.exec(pattern.slice(i, i + 11)) : null
    if (c === '\\' && next === 'Q') {
      const close = pattern.indexOf('\\E', i + 2)
      const end = close === -1 ? pattern.length : close + 2
      emit(pattern.slice(i, end), end - i)
      i = end
    } else if (c === '\\') {
      if (
        next === '<' ||
        next === '>' ||
        (next === 'b' && /^\{[a-z]/.test(pattern.slice(i + 2, i + 4)))
      ) {
        return { message: GREP_TEXTS.wordBoundary }
      }
      const end = escapeEnd(pattern, i)
      emit(PERL[next] ?? pattern.slice(i, end), 1)
      i = end
    } else if (c === '[') {
      const read = classOf(pattern, i)
      if ('message' in read) return read
      emit(read.source, read.size)
      i = read.end
    } else if (c === '(') {
      groups.push(bound)
      source += c
      bound = 0
      operand = 0
      i += 1
    } else if (c === ')') {
      const inner = bound
      bound = groups.pop() ?? 0
      emit(c, inner + 2)
      i += 1
    } else if (c === '|' || c === '*' || c === '+' || c === '?') {
      source += c
      bound += 1
      operand = c === '|' ? 0 : operand + 1
      i += 1
    } else if (repeat !== null) {
      const least = Number(repeat[1])
      const most =
        repeat[2] === undefined ? least : repeat[3] === '' ? least + 1 : Number(repeat[3])
      // re2js turns down a count over 1000 itself, with its own reason.
      const times = Math.min(Math.max(least, most), 1001)
      source += repeat[0]
      bound += times * (operand + 1) - operand
      operand = times * (operand + 1)
      i += repeat[0].length
    } else {
      emit(c, 1)
      i += 1
    }
  }
  return { source, bound }
}

/** Where the escape at `i` ends: past its braces for `\p{…}`, `\P{…}` and `\x{…}`. */
function escapeEnd(pattern: string, i: number): number {
  const next = pattern[i + 1] ?? ''
  if ((next === 'p' || next === 'P' || next === 'x') && pattern[i + 2] === '{') {
    const close = pattern.indexOf('}', i + 3)
    return close === -1 ? pattern.length : close + 1
  }
  return Math.min(i + 2, pattern.length)
}

/** What `classOf` reads a class as: re2js's source for it, where it ends, and its instructions. */
interface ReadClass {
  readonly source: string
  readonly end: number
  readonly size: number
}

/**
 * The class that opens at `start`, read by RE2's rules — `^` first negates, `]` first is a literal,
 * `[:name:]` is a POSIX class — and written for re2js. Perl classes are written out, and `\W`, which
 * no class item can hold, becomes an alternative beside the rest; a negated class cannot take one,
 * so there it is turned down. So is what ripgrep reads as a set operation and re2js as literal
 * characters or a range: a nested class (an unescaped `[` that opens no POSIX class), `&&`, `~~` and
 * `--` — even first, where ripgrep reads `[--a]` as `-` and `a`, and re2js as the range from `-` to
 * `a`. An unclosed class is left for re2js to name.
 */
function classOf(pattern: string, start: number): ReadClass | { readonly message: string } {
  let i = start + 1
  const negated = pattern[i] === '^'
  if (negated) i += 1
  const first = i
  let items = ''
  let nonWord = false
  while (i < pattern.length && (pattern[i] !== ']' || i === first)) {
    const c = pattern[i] ?? ''
    if (c === '\\') {
      const end = escapeEnd(pattern, i)
      const next = pattern[i + 1] ?? ''
      if (next === 'W') nonWord = true
      else items += PERL_IN_CLASS[next] ?? pattern.slice(i, end)
      i = end
    } else if (c === '[') {
      const posix = /^\[:\^?[a-z]+:\]/.exec(pattern.slice(i, i + 12))
      if (posix === null) return { message: GREP_TEXTS.classSet }
      items += posix[0]
      i += posix[0].length
    } else if ((c === '&' || c === '~' || c === '-') && pattern[i + 1] === c) {
      return { message: GREP_TEXTS.classSet }
    } else {
      items += c
      i += 1
    }
  }
  if (i >= pattern.length) return { source: pattern.slice(start), end: pattern.length, size: 1 }
  const end = i + 1
  if (!nonWord) return { source: `[${negated ? '^' : ''}${items}]`, end, size: 1 }
  if (negated) return { message: GREP_TEXTS.negatedNonWord }
  if (items === '') return { source: NON_WORD, end, size: 1 }
  const others = `[${items.startsWith('^') ? '\\' : ''}${items}]`
  return { source: `(?:${others}|${NON_WORD})`, end, size: 3 }
}

/**
 * Look-around or a backreference in a pattern re2js turned down, named in ripgrep's words: re2js
 * reads `(?<=` as a bad group name and `\1` as a bad escape. Escapes are stepped over whole.
 */
function unsupported(pattern: string): string | null {
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '\\') {
      const next = pattern[i + 1] ?? ''
      if ((next >= '1' && next <= '9') || pattern.startsWith('k<', i + 1)) {
        return GREP_TEXTS.backreference
      }
      i += 1
    } else if (/^\(\?(?:=|!|<=|<!)/.test(pattern.slice(i, i + 4))) {
      return GREP_TEXTS.lookaround
    } else if (pattern.startsWith('(?P=', i)) {
      return GREP_TEXTS.backreference
    }
  }
  return null
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
  regex: RE2JS,
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
      for (const [start, end] of wholeSpans(hit.text, hit.spans())) {
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

/** Where a match lies in the text it was found in: code-unit offsets, the end exclusive. */
type Span = readonly [start: number, end: number]

/**
 * A matched line, or the lines a multiline match spans, and the text its matches index into: the
 * line itself, or the whole file. A line's matches are found only when asked for: `-o` alone shows
 * them.
 */
interface Hit {
  readonly line: number
  readonly lastLine: number
  readonly text: string
  readonly spans: () => Iterable<Span>
}

/**
 * The hits of a file, one line at a time: its lines as `linesOf` splits them — on `\n`, a final one
 * ending the last line — never all of them at once. A line is a hit when the pattern matches in it,
 * even empty, as ripgrep has it.
 */
function* lineHits(content: string, regex: RE2JS): Generator<Hit, void, undefined> {
  let n = 0
  for (let start = 0; start < content.length;) {
    const newline = content.indexOf('\n', start)
    const end = newline === -1 ? content.length : newline
    const line = content.slice(start, end)
    n += 1
    if (regex.test(line))
      yield { line: n, lastLine: n, text: line, spans: () => spansOf(regex, line) }
    start = end + 1
  }
}

/** The matches in a text, in order; after an empty one, re2js moves on by a whole code point. */
function* spansOf(regex: RE2JS, text: string): Generator<Span, void, undefined> {
  const matcher = regex.matcher(text)
  while (matcher.find()) yield [matcher.start(), matcher.end()]
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
 * of a surrogate pair takes its high half, and one that ends on a high half takes its low half. re2js
 * steps by code point, but a pattern that is one lone surrogate is found by its literal, halfway into
 * a pair. A span that then overlaps the one before joins it, so a character is shown once. Half a pair
 * would be stored on the Tape and sent in every later request (§内置工具与参数「不切开代理对」,
 * 「正则方言跟 ripgrep」). An empty match shows nothing.
 */
function wholeSpans(text: string, matches: Iterable<Span>): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const [matchStart, matchEnd] of matches) {
    if (matchStart === matchEnd) continue
    let start = matchStart
    let end = matchEnd
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

/**
 * The hits of a multiline pattern, one match at a time; an empty match is none. A file the pattern
 * cannot match anywhere is passed over by re2js's DFA before any match is looked for.
 */
function* multilineHits(content: string, regex: RE2JS): Generator<Hit, void, undefined> {
  if (!regex.test(content)) return
  const lineAt = lineCounter(content)
  for (const span of spansOf(regex, content)) {
    const [start, end] = span
    if (start === end) continue
    yield { line: lineAt(start), lastLine: lineAt(end - 1), text: content, spans: () => [span] }
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
