/**
 * The long-output pair, 03 (Chinese) and 04 (English) (spec 02 §评测集与测试宿主, H9): a command
 * prints far more than `SPILL_THRESHOLD_CHARS`, the one line that answers the turn sits past the
 * first Read-sized piece of it, and the model has to find it through the spill preview plus Read with
 * `offset` / `limit` (or Grep on the spill file). The two tasks calibrate the spill threshold, so the
 * note records how the output reached the model.
 *
 * Pass: answer.txt holds exactly the answer (surrounding whitespace aside). The answer is not in the
 * fixture's source — the script computes it from a fixed seed — so it cannot be read off a file.
 */
import type { EvalCheck } from './types.js'
import { callsOf, lastEndReason, readSession, readText, spillNote, spillStats } from './support.js'

export function longLogCheck(q: { readonly command: RegExp; readonly answer: string }): EvalCheck {
  return async ({ tape, sessionId, workspaceDir }) => {
    const entries = await readSession(tape, sessionId)
    const how = spillNote(spillStats(callsOf(entries), sessionId, q.command))
    const tail = `${how}; run ended ${lastEndReason(entries) ?? 'without a terminal'}`
    const written = await readText(workspaceDir, 'answer.txt')
    if (written === null) return { pass: false, note: `no answer.txt; ${tail}` }
    const answer = written.trim()
    return answer === q.answer
      ? { pass: true, note: `answer ${q.answer}; ${tail}` }
      : { pass: false, note: `answer.txt holds ${JSON.stringify(answer.slice(0, 80))}; ${tail}` }
  }
}
