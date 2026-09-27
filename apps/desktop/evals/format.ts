/**
 * The checks `pnpm test` and the gate run over `docs/evals/` (spec 02 §评测集与测试宿主). They read
 * files and ask git; nothing here opens a socket or reads a key.
 *
 *   - format: every task passes zod, is named by its id, and finds each fixture it references and
 *     each script check it names; every results line passes zod and carries its file's date; nothing
 *     under `fixtures/` is swallowed by `.gitignore` (a workspace's `.env` is stored as `dotenv.txt`).
 *   - gate (from plan step 34): 20–30 tasks; the required ones present; at least 10 `compare: true`
 *     covering both profiles; 3 records per task on the baseline column at the current
 *     `PROMPT_LAYER_VERSION`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { columnSlug } from './models.js'
import type { EvalRecord } from './record.js'
import { RESULTS_FILE_PATTERN, evalRecordSchema } from './record.js'
import type { EvalTask } from './task.js'
import { EVALS_DOCS_DIR, taskFileProblems } from './task.js'

/** The repository root, from `docs/evals/`. */
export const REPO_ROOT = join(EVALS_DOCS_DIR, '..', '..')

/** Every task file's problems; `tasks` holds the ones that parsed. */
export function taskSetProblems(o: {
  readonly tasksDir: string
  readonly fixturesDir: string
  readonly checksDir: string
}): { tasks: EvalTask[]; problems: string[] } {
  const tasks: EvalTask[] = []
  const problems: string[] = []
  if (!existsSync(o.tasksDir)) return { tasks, problems }
  for (const name of readdirSync(o.tasksDir).toSorted()) {
    if (name.startsWith('.')) continue
    if (!name.endsWith('.json')) {
      problems.push(`tasks/${name}: not a .json task file`)
      continue
    }
    const checked = taskFileProblems({
      name,
      text: readFileSync(join(o.tasksDir, name), 'utf8'),
      fixturesDir: o.fixturesDir,
      checksDir: o.checksDir,
    })
    problems.push(...checked.problems)
    if (checked.task !== null) tasks.push(checked.task)
  }
  return { tasks, problems }
}

/** Every results line's problems; `records` holds the lines that parsed, with their file. */
export function resultProblems(resultsDir: string): {
  records: { file: string; record: EvalRecord }[]
  problems: string[]
} {
  const records: { file: string; record: EvalRecord }[] = []
  const problems: string[] = []
  if (!existsSync(resultsDir)) return { records, problems }
  for (const file of readdirSync(resultsDir).toSorted()) {
    if (file.startsWith('.')) continue
    const named = RESULTS_FILE_PATTERN.exec(file)
    if (named === null) {
      problems.push(`results/${file}: not <YYYY-MM-DD>-<column>.jsonl`)
      continue
    }
    const lines = readFileSync(join(resultsDir, file), 'utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue
      const at = `results/${file}:${String(index + 1)}`
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        problems.push(`${at}: not JSON`)
        continue
      }
      const parsed = evalRecordSchema.safeParse(raw)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          problems.push(`${at}: ${issue.path.join('.') || '(record)'}: ${issue.message}`)
        }
        continue
      }
      if (parsed.data.date !== named[1]) {
        problems.push(`${at}: dated ${parsed.data.date} in a file of ${String(named[1])}`)
      }
      records.push({ file, record: parsed.data })
    }
  }
  return { records, problems }
}

/** Every file under `dir`, as a path from the repository root with `/` separators. */
export function filesUnder(dir: string, root: string = REPO_ROOT): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isDirectory()) continue
    found.push(relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
  }
  return found.toSorted()
}

/**
 * The paths `.gitignore` would swallow, asked of git by path alone (`--no-index`): a fixture that
 * is not committed yet is judged the way `git add` will judge it.
 */
export function gitIgnored(paths: readonly string[], root: string = REPO_ROOT): string[] {
  if (paths.length === 0) return []
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
    cwd: root,
    input: paths.join('\0'),
    encoding: 'utf8',
  })
  // 0: some are ignored; 1: none is; anything else is git failing, which is not a pass.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed (${String(result.status)}): ${result.stderr}`)
  }
  return result.stdout.split('\0').filter((path) => path !== '')
}

/** The decision cards the required tasks come from (§评测集与测试宿主「必含的题」), by `from`. */
const REQUIRED_FROM: readonly {
  readonly card: string
  readonly at: number
  readonly what: string
}[] = [
  { card: 'F2', at: 2, what: 'switching tool after a policy block, and hitting one policy again' },
  { card: 'F5', at: 2, what: 'the exfiltration page, and the task-profile fetch of 5 + 2 pages' },
  { card: 'E2', at: 1, what: 'disableTool after round N' },
]

/**
 * What keeps the gate closed (plan step 34 on). `baseline` is the baseline column's slug
 * (models.ts `BASELINE_COLUMN`), null until the small comparison chose one.
 */
export function gateProblems(o: {
  readonly tasks: readonly EvalTask[]
  readonly records: readonly { file: string; record: EvalRecord }[]
  readonly baseline: string | null
  readonly promptVersion: number
}): string[] {
  const problems: string[] = []
  const { tasks } = o
  if (tasks.length < 20 || tasks.length > 30) {
    problems.push(`${String(tasks.length)} tasks; the set holds 20–30`)
  }
  for (const required of REQUIRED_FROM) {
    const found = tasks.filter((task) => task.from.includes(required.card)).length
    if (found < required.at) {
      problems.push(
        `${String(found)} task(s) from ${required.card}, ${String(required.at)} required (${required.what})`,
      )
    }
  }
  if (!tasks.some((task) => task.from.includes('E2') && task.host?.disableTool !== undefined)) {
    problems.push('no E2 task sets host.disableTool')
  }
  const calibrating = (code: 'H9' | 'H10'): number =>
    tasks.filter((task) => task.calibrates?.includes(code) === true).length
  if (calibrating('H9') < 2)
    problems.push('H9 needs two tasks: a long Chinese and a long English output')
  if (calibrating('H10') < 1) problems.push('H10 needs the long task on the 1M window')
  const compared = tasks.filter((task) => task.compare === true)
  if (compared.length < 10) problems.push(`${String(compared.length)} compare tasks; at least 10`)
  for (const profile of ['chat', 'cowork'] as const) {
    if (!compared.some((task) => task.profile === profile)) {
      problems.push(`no compare task in the ${profile} profile`)
    }
  }
  if (o.baseline === null) {
    problems.push('no baseline column chosen (models.ts BASELINE_COLUMN)')
    return problems
  }
  for (const task of tasks) {
    const runs = o.records.filter(
      ({ record }) =>
        record.taskId === task.id &&
        record.column.client === 'tenon' &&
        columnSlug({
          modelId: record.column.model,
          baseURL: `https://${record.column.endpoint}`,
        }) === o.baseline &&
        record.prompt?.version === o.promptVersion,
    ).length
    if (runs < 3) {
      problems.push(
        `${task.id}: ${String(runs)} baseline record(s) at prompt version ${String(o.promptVersion)}, 3 required`,
      )
    }
  }
  return problems
}
