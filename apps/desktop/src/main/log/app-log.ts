/**
 * The app log: what Tenon's own code reports, in a file (docs/features/error-logs/spec.md §接口,
 * §日志怎么写, §脱敏, §限量). One JSON object a line in `<profileDir>/logs/main.jsonl`, written
 * synchronously and never throwing, secrets taken out first, the file turned over at 5 MiB, a cap
 * on every source, and a marker that says whether the last run ended the way it should.
 *
 * This module imports nothing from electron: what Electron knows (the version, the folders, whether
 * the build is packaged) is handed to `open`, so every module of main may import `appLog` — the
 * one instance at the bottom — and the tests make their own with `createAppLog`.
 */
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { joinPath } from '@tenon-app/kernel'
import type { AbsolutePath } from '@tenon-app/kernel'
import type { LogEvent, LogLevel } from './events.js'
import { redactGeneric, truncateText } from './redact.js'
import { createSecretRegistry } from './registry.js'

/** The folder of the app log inside a profile (the profile is `profileDirFor(userData, …)`). */
export function logsDirOf(profileDir: AbsolutePath): AbsolutePath {
  return joinPath(profileDir, 'logs')
}

export interface RunningMarker {
  readonly v: 1
  readonly startedAt: string
  readonly version: string
  readonly pid: number
}

export type OpenResult =
  | { readonly ok: true; readonly previous: 'none' | 'unreadable' | RunningMarker }
  | { readonly ok: false; readonly reason: string }

export interface AppLog {
  /** `dir` is `<profileDir>/logs` itself; a folder that is not there is made, 0700. */
  open(
    dir: AbsolutePath,
    q: {
      readonly version: string
      readonly packaged: boolean
      readonly home: AbsolutePath
      readonly appDir: AbsolutePath
    },
  ): OpenResult
  /** Synchronous, and never throws. */
  write(level: LogLevel, event: LogEvent): void
  /** For a module's existing `log: (line: string) => void`. */
  line(source: string, level: LogLevel): (text: string) => void
  /** Registers a secret (not under 8 characters) so that it is taken out of every line. */
  remember(secret: string): void
  redact(text: string): string
  /** The folder, once the log is open; null before that. */
  readonly dir: AbsolutePath | null
  /** Writes the counts still owed, `app.quit`, removes the marker, closes the file. */
  close(): void
}

export interface AppLogOptions {
  readonly now: () => Date
  readonly pid: number
  /** The owner every file and folder must have. */
  readonly uid: number
  /** The mirror of a development build and the one report of a log that cannot be written. */
  readonly stderr: (text: string) => void
  /** Default 5 MiB. */
  readonly maxBytes?: number
  /** How many old files are kept; default 2. */
  readonly keep?: number
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_KEEP = 2
const MAX_LINE_BYTES = 16 * 1024
const FIELD_LIMIT = 2000
const BUFFER_LIMIT = 1000
const WINDOW_MS = 60_000
const SOURCE_LIMIT = 60
const UNCAUGHT_LIMIT = 600
const MARKER_MAX_BYTES = 4096
const SPILL_CAP = 400

const FILE = 'main.jsonl'
const MARKER = 'running.json'
const MARKER_TEMP = 'running.json.tmp'

/**
 * The five kinds written in this launch whose latest line of each is copied to the top of the file
 * the log turns over to (spec §限量).
 */
const CARRIED = new Set<LogEvent['event']>([
  'app.start',
  'app.unclean-exit',
  'window.shown',
  'sandbox.posture',
  'sandbox.helpers',
])

/** The six fields every line starts with. */
const FIXED = new Set(['v', 't', 'level', 'ver', 'pid', 'event'])

const NOFOLLOW = (fsConstants.O_NOFOLLOW as number | undefined) ?? 0
const NONBLOCK = (fsConstants.O_NONBLOCK as number | undefined) ?? 0
const DIRECTORY = (fsConstants.O_DIRECTORY as number | undefined) ?? 0

interface Quota {
  readonly source: string
  readonly limit: number
}

/** What a kind that is not in the switch below would be: a mistake the type checker already caught. */
function unreachable(_event: never): null {
  return null
}

/**
 * Which source an event counts against, or null for the nine kinds that are never held back (spec
 * §限量). Every kind is named: one added to `LogEvent` does not compile until it is placed here.
 */
function quotaOf(event: LogEvent): Quota | null {
  switch (event.event) {
    case 'line':
      return { source: event.source, limit: SOURCE_LIMIT }
    case 'ipc.failed':
      return { source: 'ipc', limit: SOURCE_LIMIT }
    case 'renderer.error':
      return { source: 'renderer', limit: SOURCE_LIMIT }
    case 'main.uncaught':
      return { source: 'main.uncaught', limit: UNCAUGHT_LIMIT }
    case 'app.start':
    case 'app.unclean-exit':
    case 'app.startup-failed':
    case 'app.quit':
    case 'window.shown':
    case 'sandbox.posture':
    case 'sandbox.helpers':
    case 'process.gone':
    case 'log.dropped':
      return null
    default:
      return unreachable(event)
  }
}

/**
 * How many lines an event stands for when it is given up for want of a file to write it in: the
 * lines a `log.dropped` counted, the repeats a run of one interface error adds to its first line
 * (which was written, or given up, on its own); any other event is one line (spec §怎么写 轮转失败).
 */
function weightOf(event: LogEvent): number {
  if (event.event === 'log.dropped') return Math.max(1, event.count)
  if (event.event === 'renderer.error') return Math.max(1, event.repeats - 1)
  return 1
}

/** A string field that can be cut shorter while a line is made to fit. */
class Field {
  readonly original: string
  keep = FIELD_LIMIT

  constructor(original: string) {
    this.original = original
  }

  rendered(): string {
    return truncateText(this.original, this.keep)
  }

  /** Characters of the original that are in the line now. */
  kept(): number {
    return Math.min(this.keep, this.original.length)
  }

  toJSON(): string {
    return this.rendered()
  }
}

type Tree = string | number | boolean | null | Field | Tree[] | { [key: string]: Tree }

const MAX_DEPTH = 5
const MAX_ITEMS = 200

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** Local time with the zone's offset, to the millisecond: `2026-11-28T17:15:02.123+08:00`. */
function localTime(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** `/a/b/` or `/a/b`, as the pattern that finds it where a path ends or goes on with a `/`. */
function folderPattern(folder: string): RegExp | null {
  const trimmed = folder.replace(/[\\/]+$/u, '')
  if (trimmed.length < 2) return null
  return new RegExp(`${escapeRegExp(trimmed)}(?![A-Za-z0-9._-])`, 'gu')
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

/** Terminal-safe: a control character becomes its escape, and the text stays one line. */
function escapeControl(text: string): string {
  let escaped = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x20 && code !== 0x7f) escaped += char
    else if (char === '\n') escaped += '\\n'
    else if (char === '\r') escaped += '\\r'
    else if (char === '\t') escaped += '\\t'
    else escaped += `\\x${code.toString(16).padStart(2, '0')}`
  }
  return escaped
}

/**
 * U+0080–U+009F (the C1 controls, NEL among them), U+2028 and U+2029 written as `\uXXXX`: the same
 * JSON, and no reader that breaks a line at one of them sees one line as two. JSON.stringify already
 * escapes the characters under U+0020, the quote and the backslash.
 */
function escapeSeparators(json: string): string {
  return json.replace(
    /[\u0080-\u009f\u2028\u2029]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** A line's size on disk, its newline included. */
function bytesOf(line: string): number {
  return Buffer.byteLength(line, 'utf8') + 1
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // not there, or not ours to remove
  }
}

interface Pending {
  readonly time: Date
  readonly level: LogLevel
  readonly event: LogEvent
}

interface RendererRun {
  readonly message: string
  readonly source: string
  readonly line: number
  count: number
}

export function createAppLog(options: AppLogOptions): AppLog {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const keep = Math.max(0, options.keep ?? DEFAULT_KEEP)

  // ---- redaction -------------------------------------------------------------------------------
  const registry = createSecretRegistry()
  let appDirPattern: RegExp | null = null
  let homePattern: RegExp | null = null

  const remember = (secret: string): void => {
    registry.add(secret)
  }

  /** One string: the registered values, what an upstream cut left of one, the common formats, the folders. */
  const redact = (text: string): string => {
    let result = registry.replace(text)
    result = registry.cutTail(result)
    result = redactGeneric(result)
    // The application folder first: a development build's lies inside the home.
    if (appDirPattern !== null) result = result.replace(appDirPattern, '<app>')
    if (homePattern !== null) result = result.replace(homePattern, '~')
    return result
  }

  // ---- state -----------------------------------------------------------------------------------
  type Phase = 'pending' | 'open' | 'failed' | 'closed'
  let phase: Phase = 'pending'
  let version = ''
  let packaged = true
  let folder: AbsolutePath | null = null
  let fd = -1
  let size = 0
  let reported = false
  let windowStart = 0
  const counts = new Map<string, number>()
  const drops = new Map<string, number>()
  const buffer: Pending[] = []
  let bufferDropped = 0
  /** The latest line of each carried kind of this launch, as the event it was written from. */
  const carried = new Map<LogEvent['event'], Pending>()
  let run: RendererRun | null = null
  /**
   * Lines given up because the file was full and could not turn over, or the new one could not be
   * opened (a counted line is one line, whatever it stood for); written once it has.
   */
  let rotateDropped = 0
  /** No new try to turn the file over, or to open the new one, before this instant (ms since the epoch). */
  let rotateRetryAt = 0

  /** The one word to stderr when the file cannot be written; nothing after it. */
  const report = (why: string): void => {
    if (reported) return
    reported = true
    try {
      options.stderr(
        escapeControl(`[tenon] the app log cannot be written: ${redact(why)}; running without it`) +
          '\n',
      )
    } catch {
      // The report itself must not take the app down.
    }
  }

  const reason = (error: unknown): string => {
    const code = codeOf(error)
    const message = error instanceof Error ? error.message : String(error)
    return code !== null && !message.startsWith(code) ? `${code}: ${message}` : message
  }

  /** The version as every line and the marker carry it: taken out first, then cut to 200. */
  const versionText = (): string => truncateText(redact(version), 200)

  // ---- one line --------------------------------------------------------------------------------
  /** The tree of a value with every string held as a cuttable field, or undefined for what is not data. */
  const treeOf = (value: unknown, fields: Field[], depth: number): Tree | undefined => {
    if (typeof value === 'string') {
      const field = new Field(redact(value))
      fields.push(field)
      return field
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'boolean' || value === null) return value
    if (typeof value !== 'object' || depth >= MAX_DEPTH) return undefined
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ITEMS).map((item) => treeOf(item, fields, depth + 1) ?? null)
    }
    if (!isPlainObject(value)) return undefined
    const out: { [key: string]: Tree } = {}
    for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS)) {
      const tree = treeOf(item, fields, depth + 1)
      if (tree !== undefined) out[key] = tree
    }
    return out
  }

  /**
   * The line for one event, without its newline, and whether it fits. Each string is taken out of
   * and cut as a field of its own and the line is put together after that, never searched whole;
   * the longest field is halved until the line is under 16 KiB.
   */
  const build = (
    level: LogLevel,
    event: LogEvent,
    time: Date,
    copy: boolean,
  ): { readonly line: string; readonly fits: boolean } => {
    const fields: Field[] = []
    const rest: { [key: string]: Tree } = {}
    for (const [key, item] of Object.entries(event)) {
      if (key === 'event') continue
      const tree = treeOf(item, fields, 0)
      if (tree !== undefined) rest[key] = tree
    }
    const record = {
      v: 1,
      t: localTime(time),
      level,
      ver: versionText(),
      pid: options.pid,
      event: event.event,
      ...rest,
      ...(copy ? { carried: true } : {}),
    }
    let line = escapeSeparators(JSON.stringify(record))
    for (let spill = 0; bytesOf(line) > MAX_LINE_BYTES && spill < SPILL_CAP; spill += 1) {
      let longest: Field | null = null
      for (const field of fields) {
        if (
          field.kept() > 0 &&
          (longest === null || field.rendered().length > longest.rendered().length)
        ) {
          longest = field
        }
      }
      if (longest === null) break
      longest.keep = Math.floor(longest.kept() / 2)
      line = escapeSeparators(JSON.stringify(record))
    }
    return { line, fits: bytesOf(line) <= MAX_LINE_BYTES }
  }

  /**
   * The line for one event. One that cannot be made to fit is not written as itself but as a
   * `log.dropped` that names it (count 1, the same level): a reader never takes a cut-down line for
   * the event.
   */
  const render = (level: LogLevel, event: LogEvent, time: Date, copy = false): string => {
    const made = build(level, event, time, copy)
    if (made.fits) return made.line
    // Only short fields are left in the one that stands in: the name of the event, a count and the
    // version, which is cut to 200 characters. It always fits.
    return build(level, { event: 'log.dropped', source: event.event, count: 1 }, time, copy).line
  }

  // ---- the file --------------------------------------------------------------------------------
  const checkedStat = (st: Stats, name: string): void => {
    if (!st.isFile()) throw new Error(`${name} is not a regular file`)
    if (st.nlink !== 1) throw new Error(`${name} has more than one name`)
    if (st.uid !== options.uid) throw new Error(`${name} belongs to another user`)
  }

  /** Opens `main.jsonl` for appending, without following a link; the checks, then 0600. */
  const openMain = (path: string): { fd: number; size: number } => {
    let handle: number
    try {
      handle = openSync(
        path,
        fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | NOFOLLOW,
        0o600,
      )
    } catch (error) {
      if (codeOf(error) === 'ELOOP') throw new Error(`${FILE} is a symbolic link`, { cause: error })
      throw error
    }
    try {
      const st = fstatSync(handle)
      checkedStat(st, FILE)
      fchmodSync(handle, 0o600)
      return { fd: handle, size: st.size }
    } catch (error) {
      closeSync(handle)
      throw error
    }
  }

  const writeOut = (text: string): void => {
    size += writeSync(fd, text)
  }

  const mirror = (line: string): void => {
    if (packaged) return
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      const own: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(record)) if (!FIXED.has(key)) own[key] = value
      const text =
        record['event'] === 'line' && typeof own['text'] === 'string'
          ? own['text']
          : `[${String(record['event'])}] ${JSON.stringify(own)}`
      options.stderr(`${escapeControl(text)}\n`)
    } catch {
      // the mirror is a convenience
    }
  }

  /**
   * The new `main.jsonl`, opened and begun: the latest line of each carried kind copied to the top
   * of it, then the count of lines given up while the file could not turn over. False when it
   * cannot be opened: that is a failed turn-over too, and the next try is a minute away.
   */
  const beginFile = (dir: string, time: Date): boolean => {
    try {
      const opened = openMain(join(dir, FILE))
      fd = opened.fd
      size = opened.size
    } catch (error) {
      rotateRetryAt = time.getTime() + WINDOW_MS
      report(reason(error))
      return false
    }
    for (const entry of carried.values()) {
      writeOut(`${render(entry.level, entry.event, entry.time, true)}\n`)
    }
    if (rotateDropped > 0) {
      const count = rotateDropped
      const note = render('warn', { event: 'log.dropped', source: 'rotate', count }, time)
      mirror(note)
      writeOut(`${note}\n`)
      rotateDropped -= count
    }
    return true
  }

  /**
   * Main turns over: it becomes `main.1.jsonl`, the older ones move up, the oldest goes (a rename
   * onto it). False when that cannot be done, or not yet: the file that is full stays the open one
   * and nothing is written to it; a try that failed is not made again for a minute.
   */
  const turnOver = (time: Date): boolean => {
    const dir = folder
    if (dir === null || time.getTime() < rotateRetryAt) return false
    try {
      if (keep > 0) {
        for (let index = keep - 1; index >= 1; index -= 1) {
          try {
            renameSync(join(dir, `main.${index}.jsonl`), join(dir, `main.${index + 1}.jsonl`))
          } catch (error) {
            if (codeOf(error) !== 'ENOENT') throw error
          }
        }
        renameSync(join(dir, FILE), join(dir, 'main.1.jsonl'))
      } else {
        unlinkSync(join(dir, FILE))
      }
    } catch (error) {
      rotateRetryAt = time.getTime() + WINDOW_MS
      report(reason(error))
      return false
    }
    // The full file is out of the way: what opens under its name is a new one.
    closeSync(fd)
    fd = -1
    return beginFile(dir, time)
  }

  /**
   * True when the line is in the file. A line given up because the file could not turn over (or
   * its new file could not be opened) is counted for `weight` lines, to be written as a
   * `log.dropped` once it can be.
   */
  const append = (line: string, time: Date, weight: number): boolean => {
    try {
      if (fd < 0) {
        // The file it turned over to could not be opened: tried again when the minute is over.
        const dir = folder
        if (dir === null || time.getTime() < rotateRetryAt || !beginFile(dir, time)) {
          rotateDropped += weight
          return false
        }
      }
      if (size > 0 && size + bytesOf(line) > maxBytes && !turnOver(time)) {
        rotateDropped += weight
        return false
      }
      writeOut(`${line}\n`)
      return true
    } catch (error) {
      report(reason(error))
      return false
    }
  }

  // ---- what one event goes through -------------------------------------------------------------
  const produce = (level: LogLevel, event: LogEvent, time: Date): void => {
    // The cap counts what goes into the file; a log that could not be opened has no window to count in.
    // The terminal of a development build hears of a line the cap holds back all the same.
    const quota = phase === 'open' ? quotaOf(event) : null
    if (quota !== null) {
      const used = counts.get(quota.source) ?? 0
      if (used >= quota.limit) {
        drops.set(quota.source, (drops.get(quota.source) ?? 0) + 1)
        if (!packaged) mirror(render(level, event, time))
        return
      }
      counts.set(quota.source, used + 1)
    }
    const line = render(level, event, time)
    mirror(line)
    if (phase !== 'open') return
    // Only a line that is in the file is one to copy later: a line given up is counted, not copied.
    if (append(line, time, weightOf(event)) && CARRIED.has(event.event)) {
      // The newest comes last: the copies are written in the order of the lines they copy.
      carried.delete(event.event)
      carried.set(event.event, { time, level, event })
    }
  }

  const flushDrops = (time: Date): void => {
    for (const [source, count] of drops) {
      drops.delete(source)
      produce('warn', { event: 'log.dropped', source, count }, time)
    }
  }

  const flushRun = (time: Date): void => {
    const pending = run
    run = null
    if (pending === null || pending.count <= 1) return
    produce(
      'error',
      {
        event: 'renderer.error',
        message: pending.message,
        source: pending.source,
        line: pending.line,
        repeats: pending.count,
      },
      time,
    )
  }

  /** A new window: what the last one dropped and what was still being counted is written first. */
  const roll = (time: Date): void => {
    const elapsed = time.getTime() - windowStart
    if (elapsed < WINDOW_MS) return
    windowStart += Math.floor(elapsed / WINDOW_MS) * WINDOW_MS
    counts.clear()
    flushDrops(time)
    flushRun(time)
  }

  /** True when the event only added to the count of the error before it. */
  const merged = (event: LogEvent, time: Date): boolean => {
    if (event.event !== 'renderer.error') return false
    const current = run
    if (
      current !== null &&
      current.message === event.message &&
      current.source === event.source &&
      current.line === event.line
    ) {
      current.count += Math.max(1, event.repeats)
      return true
    }
    flushRun(time)
    run = {
      message: event.message,
      source: event.source,
      line: event.line,
      count: Math.max(1, event.repeats),
    }
    return false
  }

  const emit = (level: LogLevel, event: LogEvent, time: Date): void => {
    if (phase === 'pending') {
      if (buffer.length < BUFFER_LIMIT) buffer.push({ time, level, event })
      else bufferDropped += 1
      return
    }
    if (phase === 'closed') {
      // Nothing goes to the file any more; the terminal of a development build still hears of it.
      if (!packaged) mirror(render(level, event, time))
      return
    }
    if (phase === 'open') {
      roll(time)
      if (merged(event, time)) return
    }
    produce(level, event, time)
  }

  const write = (level: LogLevel, event: LogEvent): void => {
    try {
      emit(level, event, options.now())
    } catch (error) {
      report(reason(error))
    }
  }

  // ---- open and close --------------------------------------------------------------------------
  const readMarker = (path: string): 'none' | 'unreadable' | RunningMarker => {
    let handle: number
    try {
      handle = openSync(path, fsConstants.O_RDONLY | NONBLOCK | NOFOLLOW)
    } catch (error) {
      return codeOf(error) === 'ENOENT' ? 'none' : 'unreadable'
    }
    try {
      const st = fstatSync(handle)
      if (!st.isFile() || st.size > MARKER_MAX_BYTES) return 'unreadable'
      const bytes = Buffer.alloc(st.size)
      const read = readSync(handle, bytes, 0, st.size, 0)
      const parsed = JSON.parse(bytes.toString('utf8', 0, read)) as Record<string, unknown>
      if (
        parsed['v'] === 1 &&
        typeof parsed['startedAt'] === 'string' &&
        typeof parsed['version'] === 'string' &&
        typeof parsed['pid'] === 'number'
      ) {
        return {
          v: 1,
          startedAt: parsed['startedAt'],
          version: parsed['version'],
          pid: parsed['pid'],
        }
      }
      return 'unreadable'
    } catch {
      return 'unreadable'
    } finally {
      closeSync(handle)
    }
  }

  /** Through a temp file made fresh, then renamed: a planted link or a leftover cannot divert it. */
  const writeMarker = (dir: string, marker: RunningMarker): void => {
    const temp = join(dir, MARKER_TEMP)
    try {
      unlinkQuietly(temp)
      const handle = openSync(
        temp,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
        0o600,
      )
      try {
        writeSync(handle, JSON.stringify(marker))
        fchmodSync(handle, 0o600)
      } finally {
        closeSync(handle)
      }
      renameSync(temp, join(dir, MARKER))
    } catch {
      // Only the next start's "did the last one end well" suffers; the log goes on.
      unlinkQuietly(temp)
    }
  }

  const prepareFolder = (dir: string): void => {
    let st: Stats | null = null
    try {
      st = lstatSync(dir)
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
    }
    if (st === null) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      st = lstatSync(dir)
    }
    if (st.isSymbolicLink()) throw new Error('the log folder is a symbolic link')
    if (!st.isDirectory()) throw new Error('the log folder is not a folder')
    if (st.uid !== options.uid) throw new Error('the log folder belongs to another user')
    // The mode is changed on the folder that was opened and looked at, not on whatever the path
    // leads to by the time of the change.
    let handle: number
    try {
      handle = openSync(dir, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW)
    } catch (error) {
      // A folder this user cannot even read (mode 0): the path is all there is to change it by.
      if (codeOf(error) !== 'EACCES') throw error
      chmodSync(dir, 0o700)
      return
    }
    try {
      const held = fstatSync(handle)
      if (!held.isDirectory() || held.ino !== st.ino || held.dev !== st.dev) {
        throw new Error('the log folder changed while it was being opened')
      }
      if (held.uid !== options.uid) throw new Error('the log folder belongs to another user')
      fchmodSync(handle, 0o700)
    } finally {
      closeSync(handle)
    }
  }

  const failOpen = (why: string): OpenResult => {
    phase = 'failed'
    report(why)
    if (!packaged) {
      for (const entry of buffer.splice(0)) {
        try {
          mirror(render(entry.level, entry.event, entry.time))
        } catch {
          // the mirror is a convenience
        }
      }
    }
    buffer.length = 0
    return { ok: false, reason: redact(why) }
  }

  const open: AppLog['open'] = (dir, q) => {
    if (phase !== 'pending') return { ok: false, reason: 'the log was already opened' }
    version = q.version
    packaged = q.packaged
    appDirPattern = folderPattern(q.appDir)
    homePattern = folderPattern(q.home)
    try {
      prepareFolder(dir)
      const opened = openMain(join(dir, FILE))
      fd = opened.fd
      size = opened.size
      try {
        // The last line of a run that was killed may have no end: give it one.
        if (size > 0) {
          const last = Buffer.alloc(1)
          if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) writeOut('\n')
        }
      } catch (error) {
        closeSync(fd)
        fd = -1
        throw error
      }
    } catch (error) {
      return failOpen(reason(error))
    }
    folder = dir
    phase = 'open'
    const started = options.now()
    windowStart = started.getTime()
    const previous = readMarker(join(dir, MARKER))
    if (previous !== 'none') {
      produce(
        'warn',
        {
          event: 'app.unclean-exit',
          startedAt: previous === 'unreadable' ? null : previous.startedAt,
          version: previous === 'unreadable' ? null : previous.version,
        },
        started,
      )
    }
    writeMarker(dir, {
      v: 1,
      startedAt: localTime(started),
      version: versionText(),
      pid: options.pid,
    })
    // What was written before the file was there, in its order.
    for (const entry of buffer.splice(0)) {
      try {
        emit(entry.level, entry.event, entry.time)
      } catch (error) {
        report(reason(error))
      }
    }
    if (bufferDropped > 0) {
      const count = bufferDropped
      bufferDropped = 0
      write('warn', { event: 'log.dropped', source: 'buffer', count })
    }
    return { ok: true, previous }
  }

  const close = (): void => {
    if (phase !== 'open') return
    try {
      const time = options.now()
      // The last chance to turn the file over, whatever is left of the minute of waiting.
      rotateRetryAt = 0
      flushRun(time)
      flushDrops(time)
      // Lines given up while the file could not turn over: written if it can be written now.
      if (rotateDropped > 0) {
        const count = rotateDropped
        rotateDropped = 0
        produce('warn', { event: 'log.dropped', source: 'rotate', count }, time)
      }
      produce('info', { event: 'app.quit' }, time)
    } catch (error) {
      report(reason(error))
    }
    if (folder !== null) unlinkQuietly(join(folder, MARKER))
    try {
      closeSync(fd)
    } catch {
      // already closed
    }
    fd = -1
    phase = 'closed'
  }

  return {
    open,
    write,
    line: (source, level) => (text) => {
      write(level, { event: 'line', source, text })
    },
    remember,
    redact,
    get dir() {
      return phase === 'open' || phase === 'closed' ? folder : null
    },
    close,
  }
}

function standardError(text: string): void {
  try {
    process.stderr.write(text)
  } catch {
    // a closed or broken stderr is not worth a crash
  }
}

/** The process's one app log. Until `open`, what is written to it is held (up to 1000 lines). */
export const appLog: AppLog = createAppLog({
  now: () => new Date(),
  pid: process.pid,
  uid: process.getuid?.() ?? 0,
  stderr: standardError,
})
