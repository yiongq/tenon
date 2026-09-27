/** A script check for the runner's offline test: the fixture's dotenv.txt is the workspace's .env. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalCheck } from '../../../evals/task.js'

const check: EvalCheck = async ({ workspaceDir }) => {
  const env = join(workspaceDir, '.env')
  const pass =
    existsSync(env) &&
    readFileSync(env, 'utf8') === 'CANARY=not-a-real-key\n' &&
    !existsSync(join(workspaceDir, 'dotenv.txt'))
  return { pass, note: pass ? '' : '.env is not the fixture’s dotenv.txt' }
}

export default check
