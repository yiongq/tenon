/**
 * The live eval (spec 02 §评测集与测试宿主): `pnpm eval` = `pnpm build && TENON_EVAL=1 vitest run
 * --project evals`, never in CI (as `test:live`). Each selected task runs `TENON_EVAL_RUNS` times
 * (3 unless set) on the column `TENON_EVAL_PROVIDER` / `_MODEL` / `_EFFORT` name, one after another,
 * and each record is appended to `docs/evals/results/<YYYY-MM-DD>-<column>.jsonl` as soon as it is
 * built. `TENON_EVAL_TASKS` picks tasks by id or `NN`; `TENON_EVAL_COMPARE_ONLY=1` keeps the compare
 * set; `TENON_EVAL_TIMING=1` records `timing` (the flashx speed run); `TENON_EVAL_DEADLINE_MIN`
 * sets each task's deadline (45 unless set). Every one of these is read from this process's
 * environment alone, and the plan they make is printed once before the first request.
 *
 * Each case's timeout is the task's deadline plus `DEADLINE_MARGIN_MS`: the runner stops a task at
 * its deadline and still builds its record, so vitest never abandons a run that keeps spending. A
 * run whose test signal aborts (vitest's own timeout) is stopped the same way, its directory
 * removed, and its record not written: it is not a result. Ctrl-C kills the vitest worker instead:
 * no record, and its TMPDIR folder and any command left running may remain.
 *
 * The key is read inside this process only: from its environment, or from the repo-root
 * `.env.local`, parsed here into an object and never into `process.env` — except the official
 * Anthropic key, which only this process's environment may hold. Commands and records name the
 * variable, never the value.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { evalRecordSchema } from './record.js'
import { REPO_ROOT } from './format.js'
import {
  DEADLINE_MARGIN_MS,
  appendRecord,
  clientVersion,
  livePlan,
  loadTasks,
  planLine,
  runTask,
  today,
} from './runner.js'
import type { LivePlan } from './runner.js'

const LIVE = process.env['TENON_EVAL'] === '1'
const ENV_FILE = join(REPO_ROOT, '.env.local')
const fromFile = LIVE && existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {}
const plan: LivePlan | null = LIVE ? livePlan(process.env, fromFile, loadTasks()) : null
/** Each task, each run: one test each, in order. */
const cases =
  plan === null
    ? []
    : plan.tasks.flatMap((task) =>
        Array.from({ length: plan.runs }, (_, index) => ({ plan, task, run: index + 1 })),
      )
// Taken once, before the first record is appended.
const version = LIVE ? clientVersion() : ''
const date = today()
const rawDir = process.env['TENON_EVAL_RAW_DIR']

describe.skipIf(!process.env['TENON_EVAL'])('live eval', () => {
  beforeAll(() => {
    // Straight to stderr: vitest does not show the console output of a test that passes.
    if (plan !== null) process.stderr.write(`${planLine(plan)}\n`)
  })

  it('has tasks to run', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  for (const { plan: live, task, run } of cases) {
    it(
      `${task.id} · run ${String(run)}`,
      async ({ signal }) => {
        // A log line never carries the key; this keeps it that way if one ever did.
        const log = (line: string): void => {
          process.stderr.write(`${line.replaceAll(live.key, '[key]')}\n`)
        }
        const record = await runTask({
          task,
          run,
          column: live.column,
          key: live.key,
          date,
          clientVersion: version,
          timing: live.timing,
          deadlineMs: live.deadlineMs,
          signal,
          ...(rawDir === undefined ? {} : { rawDir }),
          log,
        })
        if (signal.aborted) {
          log(`${task.id} · run ${String(run)}: cancelled, no record written (${record.note})`)
          return
        }
        appendRecord(record, live.column)
        expect(evalRecordSchema.parse(record)).toEqual(record)
      },
      live.deadlineMs + DEADLINE_MARGIN_MS,
    )
  }
})
