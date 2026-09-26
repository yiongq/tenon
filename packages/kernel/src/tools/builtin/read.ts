/**
 * Read (spec 02 §内置工具与参数「Read」). The executor lands with plan step 18.
 *
 * Every result keeps itself under `SPILL_THRESHOLD_CHARS`, counted the way the spill check counts
 * (open question 24, owner 2026-09-26): whole lines from `offset`, stopping before the next line that
 * does not fit, and a closing sentence only when it stopped early — the total, the range shown and
 * the next `offset`. A line that alone does not fit gives its first part (never half a surrogate
 * pair); the rest of that line is out of Read's reach. So a Read result is never spilled.
 */
import { fill } from '../../prompts/index.js'
import { SPILL_THRESHOLD_CHARS } from '../../loop/spill.js'
import type { ToolExecutor } from '../executor.js'
import { FILE_TEXTS, failed, linesOf, readText, succeeded, whenThrown } from './files.js'
import type { BuiltinTool } from './tool.js'
import { BOTH_PROFILES, NOT_ABSOLUTE, absolutePathCheck } from './tool.js'

const DESCRIPTION = [
  'Reads a text file from the local filesystem.',
  'file_path must be an absolute path.',
  'Each line of the result starts with its line number (from 1) and a tab; that prefix is not part of the file.',
  'By default it reads from the first line. A result has a size limit: when it stops before the end of the file, it says how many lines the file has and which offset to continue from.',
  'Give offset and limit only for a file too large to read at once.',
].join(' ')

/** Read's result template and its own errors (§提示层: they are part of the layer). */
export const READ_TEXTS = {
  notAbsolute: NOT_ABSOLUTE,
  ...FILE_TEXTS,
  empty: 'The file is empty.',
  pastEnd: 'The file has {total} lines, so there is nothing to read from line {offset}.',
  more: 'Showed lines {from} to {to} of {total}. The file goes on: call Read with offset {next} to read the next part.',
  longLine:
    'Line {line} of {total} is too long for one result: only its first {chars} characters are shown, and Read cannot show the rest of that line. The next part starts at offset {next}.',
  longLastLine:
    'Line {line} of {total} is too long for one result: only its first {chars} characters are shown, and Read cannot show the rest of that line.',
} as const

export const READ_TOOL: BuiltinTool = {
  name: 'Read',
  spec: () => ({
    name: 'Read',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path of the file to read.' },
        offset: {
          type: 'integer',
          minimum: 1,
          description: 'The line number to start reading from; 1 is the first line.',
        },
        limit: { type: 'integer', minimum: 1, description: 'How many lines to read.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  }),
  effect: 'read',
  profiles: BOTH_PROFILES,
  check: (args) => absolutePathCheck(args, 'file_path'),
  texts: READ_TEXTS,
}

/** Reads the decision's real path (§「在不在工作区里」第 5 步), never the path as the model wrote it. */
export const readExecutor: ToolExecutor = async (q) => {
  if (q.target === null) throw new Error('Read: a call reached its executor with no target path')
  const offset = typeof q.input['offset'] === 'number' ? q.input['offset'] : 1
  const limit = typeof q.input['limit'] === 'number' ? q.input['limit'] : null
  try {
    const read = await readText(q.fs, q.target, q.signal)
    if ('failure' in read) return read.failure
    const result = readResult(read.text, offset, limit)
    return result.isError ? failed(result.text) : succeeded(result.text)
  } catch (error) {
    return whenThrown(error, q.target)
  }
}

/** One Read's text: numbered whole lines from `offset`, at most `limit` of them, under the limit. */
export function readResult(
  content: string,
  offset: number,
  limit: number | null,
): { text: string; isError: boolean } {
  const lines = linesOf(content)
  const total = lines.length
  if (total === 0) return { text: READ_TEXTS.empty, isError: false }
  if (offset > total) {
    return {
      text: fill(READ_TEXTS.pastEnd, { total: String(total), offset: String(offset) }),
      isError: true,
    }
  }
  const end = limit === null ? total : Math.min(total, offset + limit - 1)
  const budget = SPILL_THRESHOLD_CHARS - noteReserve(total)
  const shown: string[] = []
  let used = 0
  let n = offset
  for (; n <= end; n += 1) {
    const line = `${String(n)}\t${lines[n - 1] ?? ''}`
    const cost = line.length + (shown.length > 0 ? 1 : 0)
    if (used + cost > budget) break
    shown.push(line)
    used += cost
  }
  if (n > end) return { text: shown.join('\n'), isError: false }
  if (shown.length === 0) {
    // The first line alone does not fit: its first part, cut where no surrogate pair is split.
    const prefix = `${String(n)}\t`
    const raw = lines[n - 1] ?? ''
    let cut = budget - prefix.length
    if (isHighSurrogate(raw.charCodeAt(cut - 1))) cut -= 1
    const slots = { line: String(n), total: String(total), chars: String(cut), next: String(n + 1) }
    const note = fill(n < end ? READ_TEXTS.longLine : READ_TEXTS.longLastLine, slots)
    return { text: `${prefix}${raw.slice(0, cut)}\n\n${note}`, isError: false }
  }
  const note = fill(READ_TEXTS.more, {
    from: String(offset),
    to: String(n - 1),
    total: String(total),
    next: String(n),
  })
  return { text: `${shown.join('\n')}\n\n${note}`, isError: false }
}

/** Room for the closing sentence, with every number as long as any this file can need. */
function noteReserve(total: number): number {
  const wide = String(Math.max(total + 1, SPILL_THRESHOLD_CHARS))
  const slots = { from: wide, to: wide, total: wide, next: wide, line: wide, chars: wide }
  const notes = [READ_TEXTS.more, READ_TEXTS.longLine, READ_TEXTS.longLastLine]
  return Math.max(...notes.map((note) => fill(note, slots).length)) + 2
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}
