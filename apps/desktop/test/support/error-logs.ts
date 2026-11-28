/**
 * What the error-logs tests share (docs/features/error-logs/spec.md): the log module's API, temp
 * folders, a hand-driven clock, an opened log, and readers of what a log left on disk.
 *
 * The `@ts-expect-error` lines below exist only because `apps/desktop/src/main/log/` was not
 * written when these tests were (test author and implementer are different agents): each turns the
 * missing-module error into an expected one so the repo's typecheck stays green meanwhile, and the
 * names re-exported from a missing module are `any`. When a module lands, tsc reports its directive
 * as unused: delete that directive and nothing else. Every call below is annotated by hand, so the
 * real types apply unchanged.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
// @ts-expect-error — log/app-log.ts does not exist until error-logs segment 1 is implemented
import { createAppLog, type AppLog, type OpenResult } from '../../src/main/log/app-log.js'

// @ts-expect-error — same module, re-exported for the tests
export { appLog, createAppLog } from '../../src/main/log/app-log.js'
// @ts-expect-error — same module, types
export type { AppLog, OpenResult, RunningMarker } from '../../src/main/log/app-log.js'
// @ts-expect-error — log/events.ts does not exist until error-logs segment 1 is implemented
export type { ErrorSummary, LogEvent, LogLevel } from '../../src/main/log/events.js'
// @ts-expect-error — log/redact.ts does not exist until error-logs segment 1 is implemented
export { rememberingSecrets, summarizeError } from '../../src/main/log/redact.js'
// @ts-expect-error — log/watch.ts does not exist until error-logs segment 1 is implemented
export { logRouteFailures, watchRendererConsole } from '../../src/main/log/watch.js'

/** The user's home and the application folder, as the log is told them (`open`'s `home`, `appDir`). */
export const HOME = '/Users/alice'
export const APP_DIR = '/Applications/Tenon.app/Contents/Resources'

/** The four files a log may leave in its folder (spec §日志行, §怎么写). */
export const LOG_FILES = ['main.jsonl', 'main.1.jsonl', 'main.2.jsonl', 'running.json'] as const

const roots: string[] = []

/** A fresh real folder under the OS temp directory, resolved (macOS `/var` is a link). */
export function makeTempRoot(tag: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `tenon-error-logs-${tag}-`)))
  roots.push(root)
  return root
}

/** Removes every folder `makeTempRoot` made. Call from `afterEach`. */
export function sweepTempRoots(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** A clock the test drives: `now` is what the log is given. */
export interface TestClock {
  readonly now: () => Date
  set(iso: string): void
  advance(ms: number): void
}

export function testClock(startIso: string): TestClock {
  let current = new Date(startIso).getTime()
  return {
    now: () => new Date(current),
    set(iso) {
      current = new Date(iso).getTime()
    },
    advance(ms) {
      current += ms
    },
  }
}

/** A line of `main.jsonl`: the six fixed fields first, then the event's own (spec §日志行). */
export interface LogRecord {
  readonly v: number
  readonly t: string
  readonly level: string
  readonly ver: string
  readonly pid: number
  readonly event: string
  readonly [field: string]: unknown
}

/** The file's text, or '' when there is none. */
export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Every line of a log file as an object; a line that is not JSON fails the test that read it. */
export function readRecords(path: string): LogRecord[] {
  return readText(path)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LogRecord)
}

/** The text of every file the log may have left, `running.json` included, for a leak scan. */
export function allLogText(dir: string): string {
  return LOG_FILES.map((name) => readText(join(dir, name))).join('\n')
}

export interface OpenLogOptions {
  /** The folder given to `open`; default: a new `logs` folder in a new temp root. */
  readonly dir?: string
  readonly version?: string
  readonly packaged?: boolean
  readonly maxBytes?: number
  readonly keep?: number
  readonly uid?: number
  /** The instant the clock starts at; default 2026-11-28T09:15:02.123Z. */
  readonly startIso?: string
  /** Create the log but do not call `open` (the pre-open buffer cases). */
  readonly deferOpen?: boolean
  /** Create the folder first, at 0755 (as `openProfile` does), when it is not there. Default true. */
  readonly makeDir?: boolean
  /** `open`'s `home` and `appDir`; default `HOME` and `APP_DIR`. */
  readonly home?: string
  readonly appDir?: string
}

export interface OpenedLog {
  readonly log: AppLog
  /** The logs folder, as given to `open`. */
  readonly dir: string
  readonly clock: TestClock
  /** Every text the log handed its `stderr` option. */
  readonly stderr: string[]
  /** `open`'s answer; null when `deferOpen`. */
  readonly result: OpenResult | null
  /** Opens a log made with `deferOpen`. */
  open(): OpenResult
}

/** The user id files are expected to belong to: the test process's own. */
export function ownUid(): number {
  return process.getuid?.() ?? 0
}

/**
 * A real `createAppLog` on a real folder, with a clock the test drives and `stderr` captured, and
 * (unless `deferOpen`) opened on it the way main does: version 0.0.0, a development build.
 */
export function openLog(options: OpenLogOptions = {}): OpenedLog {
  const dir = options.dir ?? join(makeTempRoot('log'), 'logs')
  if (options.makeDir !== false) mkdirSync(dir, { recursive: true, mode: 0o755 })
  const clock = testClock(options.startIso ?? '2026-11-28T09:15:02.123Z')
  const stderr: string[] = []
  const log: AppLog = createAppLog({
    now: clock.now,
    pid: 4242,
    uid: options.uid ?? ownUid(),
    stderr: (text: string): void => {
      stderr.push(text)
    },
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.keep === undefined ? {} : { keep: options.keep }),
  })
  const open = (): OpenResult =>
    log.open(absolutePath(dir), {
      version: options.version ?? '0.0.0',
      packaged: options.packaged ?? false,
      home: absolutePath(options.home ?? HOME),
      appDir: absolutePath(options.appDir ?? APP_DIR),
    })
  const result = options.deferOpen === true ? null : open()
  return { log, dir, clock, stderr, result, open }
}

/** Every string in a parsed JSON value, keys included. */
function jsonStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) jsonStrings(item, into)
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.push(key)
      jsonStrings(item, into)
    }
  }
  return into
}

/** The strings a file holds once decoded: whole text, and every JSON line (or the whole file) parsed. */
function decodedStrings(text: string): string[] {
  const strings = [text]
  const parsed = (chunk: string): void => {
    try {
      jsonStrings(JSON.parse(chunk) as unknown, strings)
    } catch {
      // a torn line, or something that is not JSON at all: the raw text above still covers it
    }
  }
  parsed(text)
  for (const line of text.split('\n')) if (line !== '') parsed(line)
  return strings
}

/**
 * Which of `needles` appear anywhere the log may have left them: the raw text of `main.jsonl`,
 * its two archives and `running.json`, and the strings those hold once the JSON is decoded (a
 * value that was escaped on the way in is found in either form).
 */
export function leaksIn(dir: string, needles: readonly string[]): string[] {
  const strings = LOG_FILES.flatMap((name) => decodedStrings(readText(join(dir, name))))
  return needles.filter((needle) => strings.some((candidate) => candidate.includes(needle)))
}
