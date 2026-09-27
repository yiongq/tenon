/**
 * The evals gate (spec 02 §评测集与测试宿主「门禁」): `pnpm evals:gate`, a merge condition in CI once
 * the eval baseline is built (plan step 34), never in pre-commit. Until then it is written and
 * skipped: plain `pnpm test` does not set TENON_EVALS_GATE.
 */
import { join } from 'node:path'
import { PROMPT_LAYER_VERSION } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { gateProblems, resultProblems, taskSetProblems } from './format.js'
import { CHECKS_DIR } from './load-check.js'
import { BASELINE_COLUMN } from './models.js'
import { EVALS_DOCS_DIR } from './task.js'

describe.skipIf(!process.env['TENON_EVALS_GATE'])('evals gate', () => {
  it('20–30 tasks, the required ones, 10+ compare tasks in both profiles, 3 baseline records each', () => {
    const { tasks } = taskSetProblems({
      tasksDir: join(EVALS_DOCS_DIR, 'tasks'),
      fixturesDir: join(EVALS_DOCS_DIR, 'fixtures'),
      checksDir: CHECKS_DIR,
    })
    const { records } = resultProblems(join(EVALS_DOCS_DIR, 'results'))
    expect(
      gateProblems({
        tasks,
        records,
        baseline: BASELINE_COLUMN,
        promptVersion: PROMPT_LAYER_VERSION,
      }),
    ).toEqual([])
  })
})
