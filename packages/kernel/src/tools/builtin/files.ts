/**
 * What Read, Glob and Grep share (spec 02 §内置工具与参数「Read」「Glob、Grep」): reading a text file,
 * walking a folder, and matching a glob — all in process, through `HostFs` only.
 *
 * The walk sorts by path in code units and follows no link that leads outside the workspace (暂定;
 * the engine and the regex dialect are weighed by the evals in plan step 22, and those two floors stay).
 * It skips every file and subtree its scope places `protected` — the rest of the profile directory,
 * other sessions' spill directories, the shell files — without asking or failing; the session's own
 * spill directory is walked (§内置工具的默认档位「Glob、Grep 的遍历」; D11, E4).
 * Every walk checks the stop signal between two `HostFs` calls: once it is set nothing more is read,
 * and the call records `aborted`.
 */
import type { AbsolutePath, HostFs } from '../../host/adapter.js'
import { isWithin, joinPath } from '../../host/path.js'
import { placeOf } from '../../permission/workspace.js'
import type { PathScope } from '../../permission/workspace.js'
import { fill } from '../../prompts/index.js'
import type { ToolExecution } from '../executor.js'

/** A file larger than this is not opened (a guard against reading a disk image into memory). */
export const FILE_READ_MAX_BYTES = 64 * 1024 * 1024

/** A file whose first this-many bytes hold a NUL is not text. */
const BINARY_SNIFF_BYTES = 8192

/** The execution-time failures the file tools share (§参数校验与失败「执行期失败」). */
export const FILE_TEXTS = {
  notFound: 'Nothing exists at {path}.',
  isDirectory: '{path} is a folder, not a file.',
  notDirectory: '{path} is a file, not a folder.',
  notText: '{path} is not a text file.',
  tooLarge: '{path} is {bytes} bytes, larger than the {max} bytes a file tool opens.',
  hostError: 'Reading {path} failed: {message}',
} as const

/** What a call answers when the host's filesystem throws: a stop, or an is_error with its message. */
export function whenThrown(error: unknown, path: AbsolutePath): ToolExecution {
  if (error instanceof WalkAborted) return ABORTED
  const message = error instanceof Error ? error.message : String(error)
  return failed(fill(FILE_TEXTS.hostError, { path, message }))
}

/** A call that ran and failed (§参数校验与失败「执行期失败」): is_error, `completed`. */
export function failed(text: string): ToolExecution {
  return { content: [{ type: 'text', text }], isError: true, state: 'completed' }
}

/** A call that ran and succeeded. */
export function succeeded(text: string): ToolExecution {
  return { content: [{ type: 'text', text }], isError: false, state: 'completed' }
}

/** Stopped between two reads: the batch writes the stopped note (§点停止时各状态怎么收). */
export const ABORTED: ToolExecution = { content: [], isError: true, state: 'aborted' }

/** Thrown out of a walk once the stop signal is set; the executor answers `ABORTED`. */
export class WalkAborted extends Error {
  constructor() {
    super('the call was stopped')
    this.name = 'WalkAborted'
  }
}

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new WalkAborted()
}

/** A text file's content, or the failure a model gets back. */
export async function readText(
  fs: HostFs,
  path: AbsolutePath,
  signal: AbortSignal,
): Promise<{ text: string } | { failure: ToolExecution }> {
  const stat = await fs.stat(path)
  checkSignal(signal)
  if (stat === null) return { failure: failed(fill(FILE_TEXTS.notFound, { path })) }
  if (stat.isDir) return { failure: failed(fill(FILE_TEXTS.isDirectory, { path })) }
  if (stat.size > FILE_READ_MAX_BYTES) {
    return {
      failure: failed(
        fill(FILE_TEXTS.tooLarge, {
          path,
          bytes: String(stat.size),
          max: String(FILE_READ_MAX_BYTES),
        }),
      ),
    }
  }
  const text = decodeText(await fs.readFile(path))
  checkSignal(signal)
  if (text === null) return { failure: failed(fill(FILE_TEXTS.notText, { path })) }
  return { text }
}

/** UTF-8, bad bytes as U+FFFD; null when the start of the file holds a NUL (not text). */
export function decodeText(data: Uint8Array | string): string | null {
  if (typeof data === 'string')
    return data.slice(0, BINARY_SNIFF_BYTES).includes('\0') ? null : data
  if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null
  return new TextDecoder('utf-8').decode(data)
}

/**
 * The lines of a text: split on `\n`, a final `\n` ending the last line rather than opening an empty
 * one. `\r` stays where it is, so a line reads back as the file has it.
 */
export function linesOf(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** One file a walk found: its path as walked, and its path relative to the walk's root with `/`. */
export interface WalkedFile {
  readonly path: AbsolutePath
  readonly relative: string
}

/**
 * Every file under `root`, depth first, sorted by path in code units. A link is followed only when
 * its real path is inside one of the scope's roots; a dangling link, a link leading outside and a link
 * back to a folder above it (a loop) are skipped. An entry whose real path the scope places
 * `protected` is skipped, a folder with everything under it — unless the session's own spill
 * directory lies inside it, when only the way down to that directory survives. A folder below the
 * root that cannot be listed is skipped; the root itself throws.
 */
export async function walkFiles(
  fs: HostFs,
  root: AbsolutePath,
  scope: PathScope,
  signal: AbortSignal,
): Promise<WalkedFile[]> {
  const { roots } = scope
  const files: WalkedFile[] = []
  const walk = async (
    dir: AbsolutePath,
    real: AbsolutePath,
    prefix: string,
    above: ReadonlySet<string>,
  ): Promise<void> => {
    if (above.has(real)) return
    const inside = new Set([...above, real])
    let names: string[]
    try {
      names = (await fs.readdir(dir)).toSorted()
    } catch (error) {
      // A folder under the root that cannot be listed is skipped, as ripgrep skips it.
      if (prefix === '') throw error
      return
    }
    checkSignal(signal)
    for (const name of names) {
      const path = joinPath(dir, name)
      const relative = prefix === '' ? name : `${prefix}/${name}`
      let resolved: AbsolutePath | null
      try {
        // oxlint-disable-next-line no-await-in-loop -- one entry at a time, the stop checked between
        resolved = await fs.realpath(path)
      } catch {
        continue // a dangling link or a loop
      }
      checkSignal(signal)
      if (resolved === null) continue
      const linked = resolved !== joinPath(real, name)
      if (linked && !roots.some((folder) => isWithin(resolved, folder))) continue
      // oxlint-disable-next-line no-await-in-loop -- one entry at a time, the stop checked between
      const stat = await fs.stat(path)
      checkSignal(signal)
      if (stat === null) continue
      // The protected list, skipped quietly (§内置工具的默认档位): the profile directory is walked
      // only on the way to this session's own spill directory.
      if (
        placeOf(resolved, scope) === 'protected' &&
        !(stat.isDir && isWithin(scope.ownSpillDir, resolved))
      )
        continue
      if (stat.isDir) {
        // oxlint-disable-next-line no-await-in-loop -- depth first, in sorted order
        await walk(path, resolved, relative, inside)
      } else files.push({ path, relative })
    }
  }
  const real = (await fs.realpath(root)) ?? root
  checkSignal(signal)
  await walk(root, real, '', new Set())
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** A compiled glob: whether a `/`-separated relative path (or a file name) matches it. */
export interface GlobMatcher {
  test(path: string): boolean
}

/**
 * A glob over a `/`-separated relative path (暂定 dialect): `**` any number of folders, `*` and `?`
 * within one segment, `[...]` (`!` or `^` negates), `{a,b}`, `\` escapes. A pattern with no `/`
 * matches the whole path from the root, so `*.ts` matches only top-level files. Throws on a class a
 * regular expression cannot hold.
 *
 * It runs as a set of states stepped one character at a time (a Thompson NFA), never as a
 * backtracking regular expression: `*a*a*a*a*a*a*a*a*b` over a long name took seconds that way, in
 * the process every window is served from, where no stop can land (§内置工具与参数「Read、Glob、Grep
 * 在两次 HostFs 调用之间查中止信号」). The time is the path's length times the pattern's.
 */
export function globMatcher(pattern: string): GlobMatcher {
  const nfa: GlobNfa = { states: [] }
  const start = addState(nfa, null)
  const accept = compileGlob(nfa, pattern, start)
  const closures = nfa.states.map((_, i) => epsilonClosure(nfa, i))
  const initial = closures[start] ?? []
  return {
    test(path: string): boolean {
      let current: readonly number[] = initial
      for (const char of path) {
        const seen = new Set<number>()
        for (const state of current) {
          const { test, next } = nfa.states[state] as GlobState
          if (test === null || !test(char)) continue
          for (const reached of closures[next[0] as number] ?? []) seen.add(reached)
        }
        if (seen.size === 0) return false
        current = [...seen]
      }
      return current.includes(accept)
    },
  }
}

/** A state consumes one character that passes `test`, or (`test` null) moves on without one. */
interface GlobState {
  readonly test: ((char: string) => boolean) | null
  readonly next: number[]
}

interface GlobNfa {
  readonly states: GlobState[]
}

function addState(nfa: GlobNfa, test: GlobState['test']): number {
  return nfa.states.push({ test, next: [] }) - 1
}

function link(nfa: GlobNfa, from: number, to: number): void {
  nfa.states[from]?.next.push(to)
}

/** The consuming states and the accepting one reached from `state` without a character. */
function epsilonClosure(nfa: GlobNfa, state: number): number[] {
  const seen = new Set<number>()
  const stack = [state]
  while (stack.length > 0) {
    const at = stack.pop() as number
    if (seen.has(at)) continue
    seen.add(at)
    const s = nfa.states[at] as GlobState
    if (s.test === null) stack.push(...s.next)
  }
  return [...seen]
}

const notSlash = (char: string): boolean => char !== '/'
const isSlash = (char: string): boolean => char === '/'
/** What `.` matched in the regular expression this replaces: anything but a line terminator. */
const notLineEnd = (char: string): boolean =>
  char !== '\n' && char !== '\r' && char !== '\u2028' && char !== '\u2029'

/** Adds `pattern` after state `from`; answers the state it ends on. */
function compileGlob(nfa: GlobNfa, pattern: string, from: number): number {
  let at = from
  const one = (test: (char: string) => boolean): void => {
    const consume = addState(nfa, test)
    const after = addState(nfa, null)
    link(nfa, at, consume)
    link(nfa, consume, after)
    at = after
  }
  /** Any number of characters passing `test`. */
  const many = (test: (char: string) => boolean): void => {
    const loop = addState(nfa, null)
    const consume = addState(nfa, test)
    link(nfa, at, loop)
    link(nfa, loop, consume)
    link(nfa, consume, loop)
    at = loop
  }
  let i = 0
  while (i < pattern.length) {
    const c = String.fromCodePoint(pattern.codePointAt(i) as number)
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/'
        if (slash) {
          // `**/`: nothing, or folders — any run of segments each ending in `/`.
          const loop = addState(nfa, null)
          const done = addState(nfa, null)
          const segment = addState(nfa, null)
          const name = addState(nfa, notSlash)
          const end = addState(nfa, isSlash)
          link(nfa, at, loop)
          link(nfa, loop, done)
          link(nfa, loop, segment)
          link(nfa, segment, name)
          link(nfa, name, segment)
          link(nfa, segment, end)
          link(nfa, end, loop)
          at = done
        } else many(notLineEnd)
        i += slash ? 3 : 2
      } else {
        many(notSlash)
        i += 1
      }
    } else if (c === '?') {
      one(notSlash)
      i += 1
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end < 0) {
        one((char) => char === '[')
        i += 1
      } else {
        let body = pattern.slice(i + 1, end)
        const negated = body.startsWith('!') || body.startsWith('^')
        if (negated) body = body.slice(1)
        // One class, matched against one character: linear, and it throws as the class would.
        const escaped = body.replaceAll('\\', '\\\\').replaceAll(']', '\\]')
        const cls = new RegExp(`^[${negated ? '^' : ''}${escaped}]$`, 'u')
        one((char) => cls.test(char))
        i = end + 1
      }
    } else if (c === '{') {
      const end = closingBrace(pattern, i)
      if (end < 0) {
        one((char) => char === '{')
        i += 1
      } else {
        const done = addState(nfa, null)
        for (const option of splitTopLevel(pattern.slice(i + 1, end))) {
          const begin = addState(nfa, null)
          link(nfa, at, begin)
          link(nfa, compileGlob(nfa, option, begin), done)
        }
        at = done
        i = end + 1
      }
    } else if (c === '\\' && i + 1 < pattern.length) {
      const escaped = String.fromCodePoint(pattern.codePointAt(i + 1) as number)
      one((char) => char === escaped)
      i += 1 + escaped.length
    } else {
      one((char) => char === c)
      i += c.length
    }
  }
  return at
}

function closingBrace(pattern: string, open: number): number {
  let depth = 0
  for (let i = open; i < pattern.length; i += 1) {
    if (pattern[i] === '\\') i += 1
    else if (pattern[i] === '{') depth += 1
    else if (pattern[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\') i += 1
    else if (body[i] === '{') depth += 1
    else if (body[i] === '}') depth -= 1
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts
}
