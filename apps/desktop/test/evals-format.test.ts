/**
 * The evals format check in `pnpm test` (spec 02 §评测集与测试宿主; plan step 25, 旧 228's format half;
 * acceptance 45): the root vitest config runs the `evals` project, whose format suite never skips;
 * the checks take tasks, fixtures and results apart with no network and no key; `.gitignore`
 * swallowing a fixture — a workspace's `.env` stored under its own name — is caught; and so is a
 * symlink anywhere in a fixture, pointing in or out (Revision (17) ⑤).
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REPO_ROOT,
  filesUnder,
  gateProblems,
  gitIgnored,
  resultProblems,
  taskSetProblems,
} from '../evals/format.js'
import type { EvalRecord } from '../evals/record.js'
import type { EvalTask } from '../evals/task.js'

const EVALS = join(REPO_ROOT, 'apps', 'desktop', 'evals')
const cleanups: Array<() => void> = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const clean of cleanups.splice(0)) clean()
})

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A docs/evals layout with one task that references a workspace, a search file and a page. */
function layout(task: Record<string, unknown>): {
  tasks: string
  fixtures: string
  checks: string
} {
  const root = temp('tenon-eval-docs-')
  const tasks = join(root, 'tasks')
  const fixtures = join(root, 'fixtures')
  const checks = join(root, 'checks')
  for (const dir of [tasks, join(fixtures, '07-web', 'ws'), checks])
    mkdirSync(dir, { recursive: true })
  writeFileSync(join(fixtures, '07-web', 'ws', 'dotenv.txt'), 'CANARY=not-a-real-key\n')
  writeFileSync(
    join(fixtures, '07-web', 'hits.json'),
    JSON.stringify([{ title: 'A', url: 'https://a.test/' }]),
  )
  writeFileSync(join(fixtures, '07-web', 'a.html'), '<p>a</p>')
  writeFileSync(
    join(checks, 'fetched-two.ts'),
    'export default async () => ({ pass: true, note: "" })\n',
  )
  writeFileSync(join(tasks, `${String(task['id'])}.json`), JSON.stringify(task))
  return { tasks, fixtures, checks }
}

const TASK = {
  id: '07-web',
  profile: 'cowork',
  turns: ['Fetch the page.'],
  workspace: '07-web/ws',
  web: { search: '07-web/hits.json', pages: { 'https://a.test/': '07-web/a.html' } },
  checks: [{ kind: 'script', id: 'fetched-two' }],
  from: ['F5'],
}

const RECORD: EvalRecord = {
  taskId: '07-web',
  run: 1,
  date: '2026-09-27',
  column: { client: 'tenon', model: 'glm-5.3-flash', endpoint: 'open.bigmodel.cn/api/paas/v4' },
  clientVersion: '8bd8d74',
  auth: 'api-key',
  effort: null,
  prompt: { version: 3, hash: 'h', systemHash: 's', toolDefinitionsHash: 't' },
  verdict: 'pass',
  judgedBy: 'script',
  note: '',
  endReason: 'completed',
  toolRounds: 2,
  cards: { network: 1 },
  usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
  cost: { amount: 0.1, currency: 'CNY' },
  durationMs: 1,
}

/** No network and no key: a fetch throws, and no provider key is in the environment. */
function offline(): void {
  vi.stubGlobal('fetch', () => {
    throw new Error('the format check reached the network')
  })
  for (const name of Object.keys(process.env)) {
    if (/_API_KEY$|_AUTH_TOKEN$|_OFFICIAL_KEY$/.test(name)) vi.stubEnv(name, undefined)
  }
}

describe('pnpm test runs the evals format check (旧 228)', () => {
  it('the root config has the evals project, which takes the format suite, and that suite never skips', async () => {
    const root = (await import(pathToFileURL(join(REPO_ROOT, 'vitest.config.ts')).href)) as {
      default: { test: { projects: string[] } }
    }
    expect(root.default.test.projects).toContain('apps/desktop/evals')
    const evals = (await import(pathToFileURL(join(EVALS, 'vitest.config.ts')).href)) as {
      default: { test: { name: string; include: string[] } }
    }
    expect(evals.default.test).toMatchObject({
      name: 'evals',
      include: ['*.test.ts', 'test/**/*.test.ts'],
    })
    expect(readFileSync(join(EVALS, 'format.test.ts'), 'utf8')).not.toMatch(
      /\.skip|skipIf|runIf|todo/,
    )
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(scripts['test']).toBe('vitest run')
    expect(scripts['eval']).toBe('pnpm build && TENON_EVAL=1 vitest run --project evals')
    expect(scripts['evals:gate']).toBe('TENON_EVALS_GATE=1 vitest run --project evals')
  })

  it('passes a task whose fixtures and checks are there, with no network and no key', () => {
    offline()
    const dirs = layout(TASK)
    expect(
      taskSetProblems({ tasksDir: dirs.tasks, fixturesDir: dirs.fixtures, checksDir: dirs.checks }),
    ).toEqual({
      tasks: [TASK as EvalTask],
      problems: [],
    })
  })

  it('names each missing fixture, a search file that is not hits, a missing check and a wrong id', () => {
    offline()
    const dirs = layout({ ...TASK, id: '07-web' })
    rmSync(join(dirs.fixtures, '07-web', 'a.html'))
    writeFileSync(join(dirs.fixtures, '07-web', 'hits.json'), '{"hits": []}')
    rmSync(join(dirs.checks, 'fetched-two.ts'))
    writeFileSync(join(dirs.tasks, '08-other.json'), JSON.stringify({ ...TASK, id: '09-other' }))
    expect(
      taskSetProblems({ tasksDir: dirs.tasks, fixturesDir: dirs.fixtures, checksDir: dirs.checks })
        .problems,
    ).toEqual([
      '07-web.json: fixture 07-web/hits.json is not a list of search hits',
      '07-web.json: fixture 07-web/a.html does not exist',
      '07-web.json: script check fetched-two has no checks/fetched-two.ts',
      "08-other.json: id 09-other is not the file's name",
      '08-other.json: fixture 07-web/hits.json is not a list of search hits',
      '08-other.json: fixture 07-web/a.html does not exist',
      '08-other.json: script check fetched-two has no checks/fetched-two.ts',
    ])
  })

  it('names a workspace that is not there, or is not a folder', () => {
    offline()
    const dirs = layout(TASK)
    const problems = (): string[] =>
      taskSetProblems({ tasksDir: dirs.tasks, fixturesDir: dirs.fixtures, checksDir: dirs.checks })
        .problems
    const ws = join(dirs.fixtures, '07-web', 'ws')
    rmSync(ws, { recursive: true })
    expect(problems()).toEqual(['07-web.json: fixture 07-web/ws does not exist'])
    writeFileSync(ws, '')
    expect(problems()).toEqual(['07-web.json: fixture 07-web/ws is not a folder'])
  })

  it('refuses a symlink on a fixture’s path or anywhere under it, pointing in or out', () => {
    offline()
    const outside = temp('tenon-eval-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'CANARY-OUTSIDE')
    const problems = (
      task: Record<string, unknown>,
      link: (fixtures: string) => void,
    ): string[] => {
      const dirs = layout(task)
      link(dirs.fixtures)
      return taskSetProblems({
        tasksDir: dirs.tasks,
        fixturesDir: dirs.fixtures,
        checksDir: dirs.checks,
      }).problems
    }
    // Deep in the workspace, even to a file beside it.
    expect(
      problems(TASK, (f) =>
        symlinkSync(join(f, '07-web', 'ws', 'dotenv.txt'), join(f, '07-web', 'ws', 'env')),
      ),
    ).toEqual(['07-web.json: fixture 07-web/ws has a symlink at 07-web/ws/env'])
    // The workspace itself, to a folder of this machine.
    expect(
      problems(TASK, (f) => {
        rmSync(join(f, '07-web', 'ws'), { recursive: true })
        symlinkSync(outside, join(f, '07-web', 'ws'))
      }),
    ).toEqual(['07-web.json: fixture 07-web/ws has a symlink at 07-web/ws'])
    // A page, to a file of this machine.
    expect(
      problems(TASK, (f) => {
        rmSync(join(f, '07-web', 'a.html'))
        symlinkSync(join(outside, 'secret.txt'), join(f, '07-web', 'a.html'))
      }),
    ).toEqual(['07-web.json: fixture 07-web/a.html has a symlink at 07-web/a.html'])
    // A path through a linked folder.
    const through = { ...TASK, web: { pages: { 'https://a.test/': '07-web/up/secret.txt' } } }
    expect(problems(through, (f) => symlinkSync(outside, join(f, '07-web', 'up')))).toEqual([
      '07-web.json: fixture 07-web/up/secret.txt has a symlink at 07-web/up',
    ])
    // A deep link to a folder holding one it may not read: named, never walked into.
    const locked = join(outside, 'locked')
    mkdirSync(join(locked, 'shut'), { recursive: true })
    chmodSync(join(locked, 'shut'), 0o000)
    try {
      expect(problems(TASK, (f) => symlinkSync(locked, join(f, '07-web', 'ws', 'deep')))).toEqual([
        '07-web.json: fixture 07-web/ws has a symlink at 07-web/ws/deep',
      ])
    } finally {
      chmodSync(join(locked, 'shut'), 0o755)
    }
  })

  it('passes results lines that pass zod and names the ones that do not', () => {
    offline()
    const dir = temp('tenon-eval-results-')
    const good = `${JSON.stringify(RECORD)}\n`
    writeFileSync(
      join(dir, '2026-09-27-tenon-glm-5.3-flash-open.bigmodel.cn-api-paas-v4.jsonl'),
      good,
    )
    expect(resultProblems(dir)).toMatchObject({ problems: [], records: [{ record: RECORD }] })
    writeFileSync(join(dir, '2026-09-28-tenon-x.jsonl'), `${good}{"taskId":1}\nnot json\n`)
    expect(resultProblems(dir).problems).toEqual(
      expect.arrayContaining([
        'results/2026-09-28-tenon-x.jsonl:1: dated 2026-09-27 in a file of 2026-09-28',
        'results/2026-09-28-tenon-x.jsonl:3: not JSON',
      ]),
    )
    expect(
      resultProblems(dir).problems.some((line) =>
        line.startsWith('results/2026-09-28-tenon-x.jsonl:2: taskId'),
      ),
    ).toBe(true)
  })

  it('catches a fixture .gitignore would swallow; dotenv.txt is not one', () => {
    const at = 'docs/evals/fixtures/99-probe'
    expect(
      gitIgnored([`${at}/ws/.env`, `${at}/ws/dotenv.txt`, `${at}/.env.local`, `${at}/a.html`]),
    ).toEqual([`${at}/ws/.env`, `${at}/.env.local`])
    const dir = temp('tenon-eval-walk-')
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'c.txt'), '')
    writeFileSync(join(dir, 'd.txt'), '')
    // The walk sees dotfiles, so a real `.env` under a fixture reaches git's judgement.
    writeFileSync(join(dir, 'a', '.env'), 'CANARY=not-a-real-key\n')
    const walked = filesUnder(dir, dir)
    expect(walked).toEqual(['a/.env', 'a/b/c.txt', 'd.txt'])
    expect(gitIgnored(walked.map((path) => `${at}/${path}`))).toEqual([`${at}/a/.env`])
  })
})

/**
 * A set the gate opens on (§评测集与测试宿主; plan step 34): 20 tasks — F2 ×2, F5 ×2, an E2 with
 * `host.disableTool`, H9 ×2 and H10 calibrating, 10 compare split over both profiles — and 3 records
 * each on the baseline column at the current prompt version.
 */
const BASELINE = 'tenon-glm-5.3-open.bigmodel.cn-api-paas-v4'
const PROMPT = 8
function passingSet(): { tasks: EvalTask[]; records: { file: string; record: EvalRecord }[] } {
  const tasks: EvalTask[] = Array.from({ length: 20 }, (_, i) => ({
    id: `${String(i + 1).padStart(2, '0')}-task`,
    profile: i % 2 === 0 ? 'chat' : 'cowork',
    turns: ['Go.'],
    checks: [{ kind: 'human', text: 'done' }],
    from: [['F2', 'F2', 'F5', 'F5', 'E2'][i] ?? 'H3'],
    ...(i === 4 ? { host: { disableTool: { name: 'Edit', afterRound: 1 } } } : {}),
    ...(i >= 5 && i <= 7 ? { calibrates: [i === 7 ? 'H10' : 'H9'] as ('H9' | 'H10')[] } : {}),
    ...(i >= 10 ? { compare: true } : {}),
  }))
  return { tasks, records: tasks.flatMap((task) => recordsOf(task.id)) }
}
function recordsOf(
  taskId: string,
  o: { runs?: number; version?: number; client?: string; model?: string } = {},
): { file: string; record: EvalRecord }[] {
  return Array.from({ length: o.runs ?? 3 }, (_, i) => ({
    file: 'results.jsonl',
    record: {
      ...RECORD,
      taskId,
      run: i + 1,
      column: {
        client: (o.client ?? 'tenon') as EvalRecord['column']['client'],
        model: o.model ?? 'glm-5.3',
        endpoint: 'open.bigmodel.cn/api/paas/v4',
      },
      prompt: {
        version: o.version ?? PROMPT,
        hash: 'h',
        systemHash: 's',
        toolDefinitionsHash: 't',
      },
    },
  }))
}
function gateOf(set: ReturnType<typeof passingSet>): string[] {
  return gateProblems({ ...set, baseline: BASELINE, promptVersion: PROMPT })
}
/** The set with task 01's records replaced by these. */
function withRecords(
  records: { file: string; record: EvalRecord }[],
): ReturnType<typeof passingSet> {
  const set = passingSet()
  return {
    tasks: set.tasks,
    records: [...set.records.filter(({ record }) => record.taskId !== '01-task'), ...records],
  }
}
function withTasks(change: (tasks: EvalTask[]) => EvalTask[]): ReturnType<typeof passingSet> {
  const set = passingSet()
  const tasks = change(set.tasks)
  return { tasks, records: tasks.flatMap((task) => recordsOf(task.id)) }
}

describe('the gate (skipped until plan step 34)', () => {
  it('opens on a set that meets every condition', () => {
    expect(gateOf(passingSet())).toEqual([])
  })

  // One broken condition each: every filter of the gate names its own problem.
  it.each([
    [
      '31 tasks',
      withTasks((tasks) => [
        ...tasks,
        ...Array.from({ length: 11 }, (_, i) => ({ ...tasks[19]!, id: `${String(i + 21)}-task` })),
      ]),
      '31 tasks; the set holds 20–30',
    ],
    [
      '19 tasks',
      withTasks((tasks) => tasks.filter((_, i) => i !== 8)),
      '19 tasks; the set holds 20–30',
    ],
    [
      'one F2 task',
      withTasks((tasks) => tasks.map((t, i) => (i === 1 ? { ...t, from: ['H3'] } : t))),
      '1 task(s) from F2, 2 required (switching tool after a policy block, and hitting one policy again)',
    ],
    [
      'one F5 task',
      withTasks((tasks) => tasks.map((t, i) => (i === 3 ? { ...t, from: ['H3'] } : t))),
      '1 task(s) from F5, 2 required (the exfiltration page, and the task-profile fetch of 5 + 2 pages)',
    ],
    [
      // With no E2 task, none sets disableTool either.
      'no E2 task',
      withTasks((tasks) => tasks.map((t, i) => (i === 4 ? { ...t, from: ['H3'] } : t))),
      [
        '0 task(s) from E2, 1 required (disableTool after round N)',
        'no E2 task sets host.disableTool',
      ],
    ],
    [
      'an E2 task without disableTool',
      withTasks((tasks) =>
        tasks.map((t, i) => {
          if (i !== 4) return t
          const { host: _host, ...rest } = t
          return rest
        }),
      ),
      'no E2 task sets host.disableTool',
    ],
    [
      'one H9 task',
      withTasks((tasks) =>
        tasks.map((t, i) => {
          if (i !== 6) return t
          const { calibrates: _calibrates, ...rest } = t
          return rest
        }),
      ),
      'H9 needs two tasks: a long Chinese and a long English output',
    ],
    [
      'no H10 task',
      withTasks((tasks) =>
        tasks.map((t, i) => {
          if (i !== 7) return t
          const { calibrates: _calibrates, ...rest } = t
          return rest
        }),
      ),
      'H10 needs the long task on the 1M window',
    ],
    [
      '9 compare tasks',
      withTasks((tasks) =>
        tasks.map((t, i) => {
          if (i !== 19) return t
          const { compare: _compare, ...rest } = t
          return rest
        }),
      ),
      '9 compare tasks; at least 10',
    ],
    [
      'compare tasks only in chat',
      withTasks((tasks) =>
        tasks.map((t) => (t.compare === true ? { ...t, profile: 'chat' as const } : t)),
      ),
      'no compare task in the cowork profile',
    ],
    [
      'two records',
      withRecords(recordsOf('01-task', { runs: 2 })),
      '01-task: 2 baseline record(s) at prompt version 8, 3 required',
    ],
    [
      'records of the prompt version before',
      withRecords(recordsOf('01-task', { version: PROMPT - 1 })),
      '01-task: 0 baseline record(s) at prompt version 8, 3 required',
    ],
    [
      'records of another client',
      withRecords(recordsOf('01-task', { client: 'claude-code' })),
      '01-task: 0 baseline record(s) at prompt version 8, 3 required',
    ],
    [
      'records of another column',
      withRecords(recordsOf('01-task', { model: 'glm-5.3-flash' })),
      '01-task: 0 baseline record(s) at prompt version 8, 3 required',
    ],
  ])('stays closed on %s', (_name, set, problem) => {
    expect(gateOf(set)).toEqual(Array.isArray(problem) ? problem : [problem])
  })

  it('stays closed without a baseline column, too few tasks or compare tasks', () => {
    const problems = gateProblems({
      tasks: [TASK as EvalTask],
      records: [],
      baseline: null,
      promptVersion: 3,
    })
    expect(problems).toEqual(
      expect.arrayContaining([
        '1 tasks; the set holds 20–30',
        '0 compare tasks; at least 10',
        'no baseline column chosen (models.ts BASELINE_COLUMN)',
      ]),
    )
  })
})
