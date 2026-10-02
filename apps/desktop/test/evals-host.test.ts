/**
 * The eval test host's floor (spec 02 §评测集与测试宿主; plan step 25, 旧 227; acceptance 45): an
 * `outside-workspace` card is always denied, and so is a `command` card in a task with `web`, even
 * when a task object that never met zod says allow; a command runs with HOME and TMPDIR inside the
 * run's mkdtemp directory and an environment of PATH, HOME, TMPDIR and LANG, no key among them; and
 * a task file that gives either card an allow is refused by zod; and a fixture with a symlink in it
 * is refused, never followed. The runs go through the runner on the eval-only instance column, its
 * address sent to a fake Anthropic endpoint on this machine (M6 §点名 (d), 「测试接缝」), with the
 * desktop's real fs and process.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { TapeEntry } from '@tenon-app/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAll } from '../evals/cost.js'
import {
  CHILD_ENV_NAMES,
  autoAnswer,
  childEnv,
  copyWorkspace,
  createEvalHost,
  fakeFetchUntrusted,
  fakeSearchBackend,
  searchHostOf,
} from '../evals/host.js'
import { runTask } from '../evals/runner.js'
import type { RunInspection } from '../evals/runner.js'
import { evalTaskSchema } from '../evals/task.js'
import type { EvalTask } from '../evals/task.js'
import { INSTANCE_COLUMN, originMapTo, startInstanceFake } from './support/eval-column.js'
import type { InstanceFake } from './support/eval-column.js'
import type { ScriptedReply } from './support/fake-anthropic.js'

const CHECKS = join(import.meta.dirname, 'support', 'eval-checks')

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const clean of cleanups.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- one after another
    await clean()
  }
})

function fixtures(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tenon-eval-fixtures-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '01-work'))
  writeFileSync(join(root, '01-work', 'a.txt'), 'alpha\n')
  return root
}

/** The fake for the instance column: the probe's two replies, then `replies`. */
async function fake(replies: readonly ScriptedReply[]): Promise<InstanceFake> {
  const server = await startInstanceFake((index) => replies[index])
  cleanups.push(() => server.close())
  return server
}

const tool = (name: string, input: Record<string, unknown>): ScriptedReply => ({
  steps: [{ type: 'tool_use', id: 'toolu_1', name, input }],
})

async function run(
  task: EvalTask,
  server: InstanceFake,
): Promise<{ entries: TapeEntry[]; inspected: RunInspection; endReason: string | null }> {
  let seen: { entries: TapeEntry[]; inspected: RunInspection } | null = null
  const record = await runTask({
    task,
    run: 1,
    column: INSTANCE_COLUMN,
    originMap: originMapTo(INSTANCE_COLUMN, server),
    key: 'eval-offline-key-not-real',
    date: '2026-09-27',
    clientVersion: 'test-version',
    fixturesDir: fixtures(),
    checksDir: CHECKS,
    runWaitMs: 20_000,
    inspect: async (inspected) => {
      seen = { inspected, entries: await readAll(inspected.tape, inspected.sessionId) }
    },
  })
  if (seen === null) throw new Error('inspect was not called')
  return {
    ...(seen as { entries: TapeEntry[]; inspected: RunInspection }),
    endReason: record.endReason,
  }
}

function outcomes(entries: readonly TapeEntry[]): unknown[] {
  return entries.filter((e) => e.name === 'execution/tool_outcome').map((e) => e.payload['source'])
}

function approvals(entries: readonly TapeEntry[]): unknown[] {
  return entries.filter((e) => e.name === 'tool/approval_resolved').map((e) => e.payload['outcome'])
}

const COWORK: Omit<EvalTask, 'id' | 'turns'> = {
  profile: 'cowork',
  workspace: '01-work',
  checks: [{ kind: 'script', id: 'always-pass' }],
  from: ['D7'],
}

describe('the test host answers cards by reason (旧 227)', () => {
  it('denies an outside-workspace card, even when the task object says allow', async () => {
    const server = await fake([tool('Read', { file_path: '/etc/hosts' })])
    // Past zod on purpose: the host's own rule is the second line.
    const task: EvalTask = {
      ...COWORK,
      id: '01-work',
      turns: ['Read /etc/hosts.'],
      host: { answers: { 'outside-workspace': 'allow' } },
    }
    const { entries, inspected, endReason } = await run(task, server)
    expect(inspected.cards.map((card) => card.reason)).toEqual(['outside-workspace'])
    expect(approvals(entries)).toEqual(['denied'])
    expect(outcomes(entries)).toEqual(['user-rejected'])
    expect(endReason).toBe('user-rejected')
    // A denial sends nothing more.
    expect(server.requests).toHaveLength(1)
  })

  it('denies a command card in a task with web, even when the task object says allow', async () => {
    const server = await fake([tool('Bash', { command: 'echo hi' })])
    const task: EvalTask = {
      ...COWORK,
      id: '01-work',
      turns: ['Say hi in the shell.'],
      web: { pages: {} },
      host: { answers: { command: 'allow' } },
    }
    const { entries, inspected } = await run(task, server)
    expect(inspected.cards.map((card) => card.reason)).toEqual(['command'])
    expect(approvals(entries)).toEqual(['denied'])
    expect(outcomes(entries)).toEqual(['user-rejected'])
  })

  it('denies a reason the task does not list, and allows only what it lists', () => {
    const task = { host: { answers: { default: 'allow', command: 'allow' } } } as const
    expect(autoAnswer('default', task)).toBe('allow')
    expect(autoAnswer('command', task)).toBe('allow')
    expect(autoAnswer('irreversible', task)).toBe('deny')
    expect(autoAnswer('network', {})).toBe('deny')
    expect(autoAnswer('command', { ...task, web: {} })).toBe('deny')
  })

  it('runs a command with HOME and TMPDIR in the mkdtemp dir, and PATH, HOME, TMPDIR, LANG only', async () => {
    // In the runner's own environment, where a leak would come from.
    vi.stubEnv('ZHIPU_API_KEY', 'runner-key-must-not-leak')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'runner-token-must-not-leak')
    vi.stubEnv('TENON_EVAL_LEAK_PROBE', '1')
    const server = await fake([
      tool('Bash', { command: '/usr/bin/env' }),
      { steps: [{ type: 'text', text: 'Done.' }] },
    ])
    const task: EvalTask = {
      ...COWORK,
      id: '01-work',
      turns: ['Print the environment.'],
      host: { answers: { command: 'allow' } },
    }
    const { entries, inspected } = await run(task, server)
    expect(outcomes(entries)).toEqual([null])
    const result = entries.find((e) => e.name === 'tool/result')
    const content = result?.payload['content'] as { type: string; text: string }[]
    const env = new Map(
      content[0]?.text
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
    const dir = inspected.dir
    expect(relative(realpathSync(tmpdir()), dir).startsWith('tenon-eval-')).toBe(true)
    expect(env.get('HOME')).toBe(join(dir, 'home'))
    expect(env.get('TMPDIR')).toBe(join(dir, 'tmp'))
    expect(env.get('PATH')).toBe(process.env['PATH'])
    expect([...env.keys()].filter((name) => /_API_KEY$|_AUTH_TOKEN$/.test(name))).toEqual([])
    expect(env.has('TENON_EVAL_LEAK_PROBE')).toBe(false)
    // What the shell sets itself (PWD, SHLVL, `_`; zsh also LOGNAME) is the shell's; nothing else
    // is inherited.
    const added = [...env.keys()].filter(
      (name) => !(CHILD_ENV_NAMES as readonly string[]).includes(name),
    )
    expect(
      added.filter((name) => !['PWD', 'OLDPWD', 'SHLVL', '_', 'LOGNAME'].includes(name)),
    ).toEqual([])
    // The command's cwd is the workspace, the fixture copied into the run's dir.
    expect(env.get('PWD')).toBe(join(dir, 'workspace'))
  })

  it('builds the child environment from four variables of the runner and the run’s folders', () => {
    const env = childEnv('/r/home' as never, '/r/tmp' as never, {
      PATH: '/bin',
      LANG: 'zh_CN.UTF-8',
      ZHIPU_API_KEY: 'k',
      HOME: '/Users/me',
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/r/home', TMPDIR: '/r/tmp', LANG: 'zh_CN.UTF-8' })
  })
})

/** Where zod refuses a task, as dotted paths; empty when it takes it. */
function issues(task: unknown): string[] {
  const parsed = evalTaskSchema.safeParse(task)
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'))
}

describe('a task file that allows what the host only denies is refused by zod (旧 227)', () => {
  const valid = {
    id: '01-work',
    profile: 'cowork',
    turns: ['Do it.'],
    workspace: '01-work',
    checks: [{ kind: 'script', id: 'always-pass' }],
    from: ['D7'],
  }

  it('takes a task that allows a command or a workspace write', () => {
    expect(issues({ ...valid, host: { answers: { command: 'allow', default: 'allow' } } })).toEqual(
      [],
    )
  })

  it('refuses allow for outside-workspace', () => {
    expect(issues({ ...valid, host: { answers: { 'outside-workspace': 'allow' } } })).toEqual([
      'host.answers.outside-workspace',
    ])
    expect(issues({ ...valid, host: { answers: { 'outside-workspace': 'deny' } } })).toEqual([])
  })

  it('refuses allow for command when the task has web, and only then', () => {
    const web = { ...valid, web: { pages: { 'https://example.com/a': 'p/a.html' } } }
    expect(issues({ ...web, host: { answers: { command: 'allow' } } })).toEqual([
      'host.answers.command',
    ])
    expect(issues({ ...web, host: { answers: { command: 'deny' } } })).toEqual([])
    // Any web: search alone, or none of its members.
    for (const only of [{ search: 'p/hits.json' }, {}]) {
      expect(issues({ ...valid, web: only, host: { answers: { command: 'allow' } } })).toEqual([
        'host.answers.command',
      ])
    }
  })

  it('refuses a workspace on a chat task, unknown keys, and a reason that is not a ConfirmReason', () => {
    expect(issues({ ...valid, profile: 'chat' })).toEqual(['workspace'])
    const { workspace: _workspace, ...chat } = valid
    expect(issues({ ...chat, profile: 'chat' })).toEqual([])
    expect(issues({ ...valid, $schema: 'x' })).not.toEqual([])
    expect(issues({ ...valid, host: { answers: { sometimes: 'allow' } } })).not.toEqual([])
    expect(issues({ ...valid, host: { autoAllow: true } })).not.toEqual([])
    expect(issues({ ...valid, workspace: '../outside' })).toEqual(['workspace'])
  })
})

describe('a fixture is copied and read without following a link (Revision (17) ⑤)', () => {
  function temp(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  it('copies files and folders, dotenv.txt renamed, and refuses a symlink anywhere in them', () => {
    const root = temp('tenon-eval-copy-')
    const from = join(root, 'fixture')
    mkdirSync(join(from, 'sub'), { recursive: true })
    writeFileSync(join(from, 'a.txt'), 'alpha\n')
    writeFileSync(join(from, 'sub', 'dotenv.txt'), 'CANARY=not-a-real-key\n')
    copyWorkspace(from, join(root, 'copy'))
    expect(readFileSync(join(root, 'copy', 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(readFileSync(join(root, 'copy', 'sub', '.env'), 'utf8')).toBe('CANARY=not-a-real-key\n')

    // A folder of this machine behind a link: never copied, and its dotenv.txt never renamed.
    const owner = temp('tenon-eval-owner-')
    writeFileSync(join(owner, 'dotenv.txt'), 'OWNER=real\n')
    symlinkSync(owner, join(from, 'sub', 'linked'))
    expect(() => copyWorkspace(from, join(root, 'again'))).toThrow(/symlink/)
    expect(existsSync(join(owner, 'dotenv.txt'))).toBe(true)
    expect(() => copyWorkspace(join(from, 'sub', 'linked'), join(root, 'third'))).toThrow(/symlink/)
    expect(existsSync(join(owner, 'dotenv.txt'))).toBe(true)
    // Pointing inside the fixture is refused too.
    rmSync(join(from, 'sub', 'linked'))
    symlinkSync(join(from, 'a.txt'), join(from, 'b.txt'))
    expect(() => copyWorkspace(from, join(root, 'fourth'))).toThrow(/symlink/)
  })

  it('refuses a task whose workspace, page or search file has a link on its path', async () => {
    const linked = temp('tenon-eval-fixtures-')
    const owner = temp('tenon-eval-owner-')
    writeFileSync(join(owner, 'secret.txt'), 'CANARY-OUTSIDE')
    writeFileSync(join(owner, 'hits.json'), '[]')
    mkdirSync(join(linked, '07-web'))
    symlinkSync(owner, join(linked, '07-web', 'ws'))
    symlinkSync(join(owner, 'secret.txt'), join(linked, '07-web', 'a.html'))
    symlinkSync(join(owner, 'hits.json'), join(linked, '07-web', 'hits.json'))
    const base: EvalTask = { ...COWORK, id: '07-web', turns: ['Go.'] }
    const host = (task: EvalTask) =>
      createEvalHost({
        task,
        sessionId: '00000000-0000-4000-8000-000000000001',
        fixturesDir: linked,
        // A column with a search backend, so the search file is read at all (an instance has none).
        column: { providerId: 'zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4/' },
        log: () => {},
      })
    await expect(host({ ...base, workspace: '07-web/ws' })).rejects.toThrow(
      'fixture 07-web/ws has a symlink at 07-web/ws',
    )
    const { workspace: _workspace, ...noWorkspace } = base
    await expect(
      host({ ...noWorkspace, web: { pages: { 'https://a.test/': '07-web/a.html' } } }),
    ).rejects.toThrow('fixture 07-web/a.html has a symlink at 07-web/a.html')
    await expect(host({ ...noWorkspace, web: { search: '07-web/hits.json' } })).rejects.toThrow(
      'fixture 07-web/hits.json has a symlink at 07-web/hits.json',
    )
  })
})

describe('the fake network of a web task', () => {
  it('serves the pages of web.pages and answers 404 for any other URL', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tenon-eval-pages-')))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'a.html'), '<p>a</p>')
    const fetched: string[] = []
    const fetchUntrusted = fakeFetchUntrusted(
      { 'https://example.com/a': join(dir, 'a.html') },
      fetched,
    )
    const page = await fetchUntrusted('https://example.com/a')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toBe(readFileSync(join(dir, 'a.html'), 'utf8'))
    expect((await fetchUntrusted('https://example.com/a?d=secret')).status).toBe(404)
    expect(fetched).toEqual(['https://example.com/a', 'https://example.com/a?d=secret'])
  })

  it('searches with the column’s real host and filter, from web.search, without the network', async () => {
    const hits = [{ title: 'A', url: 'https://example.com/a' }]
    const zhipuColumn = { providerId: 'zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4/' }
    expect(searchHostOf(zhipuColumn)).toBe('open.bigmodel.cn')
    const official = { providerId: 'anthropic', baseURL: 'https://api.anthropic.com' }
    expect(searchHostOf(official)).toBe('api.anthropic.com')
    // M6 §点名 (f), Q10: an instance has no search, on Zhipu's host or any other (the product's).
    expect(searchHostOf(INSTANCE_COLUMN)).toBeNull()
    expect(
      searchHostOf({ providerId: 'anthropic', baseURL: 'https://open.bigmodel.cn/api/anthropic' }),
    ).toBeNull()
    expect(searchHostOf({ providerId: 'zhipu', baseURL: 'http://127.0.0.1:9' })).toBeNull()
    const zhipu = fakeSearchBackend(hits, 'open.bigmodel.cn')
    expect(zhipu.domainFilter).toBe(false)
    expect(zhipu.prepareQuery('字'.repeat(71))).toEqual({ query: '字'.repeat(70), truncated: true })
    const anthropic = fakeSearchBackend(hits, 'api.anthropic.com')
    expect(anthropic.domainFilter).toBe(true)
    expect(anthropic.prepareQuery('字'.repeat(71)).truncated).toBe(false)
    expect(await zhipu.search({ query: 'q', signal: new AbortController().signal })).toEqual({
      ok: true,
      hits,
    })
  })
})
