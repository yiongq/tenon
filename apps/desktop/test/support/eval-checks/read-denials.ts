/** A script check for the runner's offline test: passes, and notes what disabling Read did. */
import {
  callsOf,
  denialNote,
  denialStats,
  readSession,
  succeeded,
} from '../../../evals/checks/support.js'
import type { EvalCheck } from '../../../evals/task.js'

const check: EvalCheck = async ({ tape, sessionId }) => {
  const calls = callsOf(await readSession(tape, sessionId))
  return { pass: true, note: denialNote('Read', denialStats(calls, 'Read', succeeded)) }
}

export default check
