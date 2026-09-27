/**
 * 02 · blocked by policy, finish with an allowed tool (F2), with the tool switched off mid-session
 * (E2: `host.disableTool` turns Edit off after round 1). The rename `fetchUsr` → `fetchUser` touches
 * two files; with Edit blocked the model has to rewrite them some other way (Write, or a command)
 * without disturbing the rest.
 *
 * Pass: both files equal the fixture's with exactly that rename, line endings and the final newline
 * aside. The note carries what F2 and E2 record: the blocks, the calls to Edit in the requests
 * after the first block, and after how many blocks the model did Edit's job another way: a Write to
 * one of the two files, or a command that spells the new name (a rewrite has to), that succeeded.
 */
import { readFile } from 'node:fs/promises'
import type { EvalCheck } from './types.js'
import type { CallView } from './support.js'
import {
  callsOf,
  denialNote,
  denialStats,
  firstDifferentLine,
  fixturePath,
  lastEndReason,
  normalizeText,
  readSession,
  readText,
  succeeded,
} from './support.js'

const FIXTURE = '02-rename-without-edit'
const FILES = ['src/users.js', 'src/index.js']
const DISABLED = 'Edit'

/** Edit's job done another way: a Write to a target file, or a command that writes the new name. */
function renamedAnotherWay(call: CallView): boolean {
  if (!succeeded(call)) return false
  const path = call.input['file_path']
  if (call.name === 'Write') {
    return typeof path === 'string' && FILES.some((f) => path === f || path.endsWith(`/${f}`))
  }
  const command = call.input['command']
  return call.name === 'Bash' && typeof command === 'string' && /\bfetchUser\b/.test(command)
}

const check: EvalCheck = async ({ tape, sessionId, workspaceDir }) => {
  const problems: string[] = []
  for (const file of FILES) {
    // oxlint-disable-next-line no-await-in-loop -- two small files, read in order for the note
    const original = await readFile(fixturePath(FIXTURE, file), 'utf8')
    const expected = normalizeText(original.replaceAll(/\bfetchUsr\b/g, 'fetchUser'))
    // oxlint-disable-next-line no-await-in-loop -- as above
    const actual = await readText(workspaceDir, file)
    if (actual === null) {
      problems.push(`${file} is gone`)
      continue
    }
    const line = firstDifferentLine(normalizeText(actual), expected)
    if (line !== null) problems.push(`${file} differs from the expected rename at line ${line}`)
  }

  const entries = await readSession(tape, sessionId)
  const stats = denialNote(DISABLED, denialStats(callsOf(entries), DISABLED, renamedAnotherWay))
  const tail = `${stats}; run ended ${lastEndReason(entries) ?? 'without a terminal'}`
  return problems.length === 0
    ? { pass: true, note: `renamed in both files; ${tail}` }
    : { pass: false, note: `${problems.join('; ')}; ${tail}` }
}

export default check
