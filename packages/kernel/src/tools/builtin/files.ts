/**
 * What Read, Glob and Grep share (spec 02 §内置工具与参数「Read」「Glob、Grep」): reading a text file,
 * walking a folder, and matching a glob — all in process, through `HostFs` only.
 *
 * The walk sorts by path in code units and follows no link that leads outside the workspace (暂定;
 * the engine and the regex dialect are weighed by the evals in plan step 22, and those two floors stay).
 * Every walk checks the stop signal between two `HostFs` calls: once it is set nothing more is read,
 * and the call records `aborted`.
 */
import type { AbsolutePath, HostFs } from '../../host/adapter.js'
import { isWithin, joinPath } from '../../host/path.js'
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
 * its real path is inside one of `roots`; a dangling link, a link leading outside and a link back to a
 * folder above it (a loop) are skipped. A folder below the root that cannot be listed is skipped; the
 * root itself throws.
 */
export async function walkFiles(
  fs: HostFs,
  root: AbsolutePath,
  roots: readonly AbsolutePath[],
  signal: AbortSignal,
): Promise<WalkedFile[]> {
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

/**
 * A glob as a regular expression over a `/`-separated relative path (暂定 dialect): `**` any number of
 * folders, `*` and `?` within one segment, `[...]` (`!` or `^` negates), `{a,b}`, `\` escapes. A
 * pattern with no `/` matches the whole path from the root, so `*.ts` matches only top-level files.
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globSource(pattern)}$`, 'u')
}

function globSource(pattern: string): string {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i] as string
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/'
        out += slash ? '(?:[^/]*/)*' : '.*'
        i += slash ? 3 : 2
      } else {
        out += '[^/]*'
        i += 1
      }
    } else if (c === '?') {
      out += '[^/]'
      i += 1
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end < 0) {
        out += '\\['
        i += 1
      } else {
        let body = pattern.slice(i + 1, end)
        const negated = body.startsWith('!') || body.startsWith('^')
        if (negated) body = body.slice(1)
        out += `[${negated ? '^' : ''}${body.replaceAll('\\', '\\\\').replaceAll(']', '\\]')}]`
        i = end + 1
      }
    } else if (c === '{') {
      const end = closingBrace(pattern, i)
      if (end < 0) {
        out += '\\{'
        i += 1
      } else {
        const options = splitTopLevel(pattern.slice(i + 1, end))
        out += `(?:${options.map(globSource).join('|')})`
        i = end + 1
      }
    } else if (c === '\\' && i + 1 < pattern.length) {
      out += escapeRegExp(pattern[i + 1] as string)
      i += 2
    } else {
      out += escapeRegExp(c)
      i += 1
    }
  }
  return out
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

function escapeRegExp(c: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c
}
