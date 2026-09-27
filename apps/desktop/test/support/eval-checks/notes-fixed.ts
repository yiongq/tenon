/** A script check for the runner's offline test (evals-runner.test.ts): the model fixed notes.txt. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalCheck } from '../../../evals/task.js'

const check: EvalCheck = async ({ workspaceDir }) => {
  const text = readFileSync(join(workspaceDir, 'notes.txt'), 'utf8')
  return { pass: text === 'fixed\n', note: `notes.txt holds ${JSON.stringify(text)}` }
}

export default check
