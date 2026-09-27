/**
 * The evals format check in `pnpm test` (spec 02 §评测集与测试宿主; plan step 25, 旧 228's format half;
 * acceptance 45): the root vitest config runs the `evals` project, whose format suite never skips;
 * the checks take tasks, fixtures and results apart with no network and no key; and `.gitignore`
 * swallowing a fixture — a workspace's `.env` stored under its own name — is caught.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
    expect(filesUnder(dir, dir)).toEqual(['a/b/c.txt', 'd.txt'])
  })
})

describe('the gate (skipped until plan step 34)', () => {
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
