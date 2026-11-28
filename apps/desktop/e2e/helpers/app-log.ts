/**
 * Reads the app log a launched Tenon left (docs/features/error-logs/spec.md §日志行, §运行标记):
 * `main.jsonl`, one JSON object a line, and `running.json`. It reads the files and nothing else, so
 * it works on a log whose app is gone.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logsDirIn } from './launch.js'

/** The six fixed fields, then the event's own. */
export interface AppLogRecord {
  readonly v: number
  readonly t: string
  readonly level: string
  readonly ver: string
  readonly pid: number
  readonly event: string
  readonly [field: string]: unknown
}

/** `2026-11-28T17:15:02.123+08:00`: local time, to the millisecond, with the zone's offset. */
export const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/u

/** Every record in `main.jsonl` (none when the file is not there yet). */
export function appLogRecords(userData: string): AppLogRecord[] {
  const file = join(logsDirIn(userData), 'main.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as AppLogRecord)
}

/** The kinds of event written so far, in order. */
export function appLogEvents(userData: string): string[] {
  return appLogRecords(userData).map((record) => record.event)
}

/** `running.json` as an object, or null when it is not there. */
export function runningMarker(userData: string): Record<string, unknown> | null {
  const file = join(logsDirIn(userData), 'running.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}
