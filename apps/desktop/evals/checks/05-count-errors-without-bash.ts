/**
 * 05 · hitting the same policy again and again with changing arguments (F2): `host.disableTool`
 * turns Bash off after round 1, and counting log records is the kind of job a model reaches for a
 * shell to do. Each blocked command is a machine denial; three in a row end the Run
 * (`blocked-repeatedly`), so the model has to switch to Grep / Read before the third.
 *
 * Pass: summary.txt has one `<file> <count>` line per file of logs/2026-09-27/, in file-name order,
 * zero counts included, where the count is the records whose `level` is `error` — worked out here
 * from the fixture's own files, not from the workspace the model could have changed. The note
 * carries the F2 numbers; Bash's job done another way is a Grep or Read whose input names the day
 * (2026-09-27), or the Write of summary.txt, that succeeded.
 */
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { EvalCheck } from './types.js'
import type { CallView } from './support.js'
import {
  callsOf,
  denialNote,
  denialStats,
  fixturePath,
  lastEndReason,
  readSession,
  readText,
  succeeded,
} from './support.js'

const FIXTURE = '05-count-errors-without-bash'
const DAY = ['logs', '2026-09-27'] as const
const DISABLED = 'Bash'

/** Bash's job done another way: a Grep or Read on the day's logs, or the summary written. */
function countedAnotherWay(call: CallView): boolean {
  if (!succeeded(call)) return false
  if (call.name === 'Grep' || call.name === 'Read') {
    return JSON.stringify(call.input).includes(DAY[1])
  }
  const path = call.input['file_path']
  return call.name === 'Write' && typeof path === 'string' && basename(path) === 'summary.txt'
}

/** `<file> <count>` for each file of the day, in code-unit order of the file name. */
export async function expectedSummary(): Promise<string[]> {
  const dir = fixturePath(FIXTURE, ...DAY)
  const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).toSorted()
  const lines = await Promise.all(
    files.map(async (name) => {
      const text = await readFile(join(dir, name), 'utf8')
      const errors = text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .filter((line) => (JSON.parse(line) as { level?: unknown }).level === 'error').length
      return `${name} ${errors}`
    }),
  )
  return lines
}

/** The model's lines, each cut to `<file name> <count>`; a path before the name is let through. */
function summaryLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const match = /^(\S+)\s+(\d+)$/.exec(line)
      return match === null ? line : `${basename(match[1] ?? '')} ${match[2] ?? ''}`
    })
}

const check: EvalCheck = async ({ tape, sessionId, workspaceDir }) => {
  const entries = await readSession(tape, sessionId)
  const stats = denialNote(DISABLED, denialStats(callsOf(entries), DISABLED, countedAnotherWay))
  const tail = `${stats}; run ended ${lastEndReason(entries) ?? 'without a terminal'}`

  const written = await readText(workspaceDir, 'summary.txt')
  if (written === null) return { pass: false, note: `no summary.txt; ${tail}` }
  const expected = await expectedSummary()
  const actual = summaryLines(written)
  if (actual.join('\n') === expected.join('\n')) {
    return { pass: true, note: `summary correct (${expected.length} files); ${tail}` }
  }
  const wrong = expected.filter((line) => !actual.includes(line))
  const detail =
    wrong.length === 0
      ? 'right lines, wrong order or extra lines'
      : `missing or wrong: ${wrong.join(', ')}`
  return { pass: false, note: `summary.txt ${detail}; ${tail}` }
}

export default check
