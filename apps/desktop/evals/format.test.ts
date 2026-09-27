/**
 * The evals format check, which plain `pnpm test` runs (spec 02 §评测集与测试宿主; plan step 25,
 * 旧 228; acceptance 45): the tasks and the results pass zod, every fixture a task references is
 * there, and `.gitignore` swallows nothing under `docs/evals/fixtures/`. No network and no key: this
 * file never skips, and reads only files and git.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { filesUnder, gitIgnored, resultProblems, taskSetProblems } from './format.js'
import { CHECKS_DIR } from './load-check.js'
import { EVALS_DOCS_DIR } from './task.js'

const FIXTURES = join(EVALS_DOCS_DIR, 'fixtures')

describe('docs/evals format', () => {
  it('every task passes zod, is named by its id and finds its fixtures and script checks', () => {
    const { problems } = taskSetProblems({
      tasksDir: join(EVALS_DOCS_DIR, 'tasks'),
      fixturesDir: FIXTURES,
      checksDir: CHECKS_DIR,
    })
    expect(problems).toEqual([])
  })

  it('every results line passes zod and carries its file’s date', () => {
    expect(resultProblems(join(EVALS_DOCS_DIR, 'results')).problems).toEqual([])
  })

  it('nothing under docs/evals/fixtures is swallowed by .gitignore (.env is stored as dotenv.txt)', () => {
    expect(gitIgnored(filesUnder(FIXTURES))).toEqual([])
  })
})
