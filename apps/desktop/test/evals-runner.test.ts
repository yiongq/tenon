/**
 * The eval runner end to end, offline (spec 02 §评测集与测试宿主, §记录格式与费用口径; plan step 25): a
 * task goes through the desktop's own Run connector — config.json and the memory secrets as the
 * settings card leaves them — to a fake Anthropic endpoint on this machine, through the product's
 * kernel service and the desktop's loop, with the test host answering the cards; then its script
 * checks run and the record is built from the Tape, passes record zod and is appended to a results
 * file that passes the format check. The column is the eval-only glm-5.3 row, priced in CNY, so the
 * cost is checked against a hand computation too.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROMPT_LAYER_HASH, PROMPT_LAYER_VERSION } from '@tenon-app/kernel'
import type { TapeEntry } from '@tenon-app/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { readAll } from '../evals/cost.js'
import { resultProblems } from '../evals/format.js'
import { loadCheck } from '../evals/load-check.js'
import { EVAL_GLM_53_ANTHROPIC } from '../evals/models.js'
import type { EvalColumn } from '../evals/models.js'
import { evalRecordSchema } from '../evals/record.js'
import type { EvalRecord } from '../evals/record.js'
import { appendRecord, runTask, verdictOf } from '../evals/runner.js'
import type { RunInspection } from '../evals/runner.js'
import type { EvalTask } from '../evals/task.js'
import { startFakeAnthropic } from './support/fake-anthropic.js'
import type { FakeAnthropic, ScriptedReply } from './support/fake-anthropic.js'

const CHECKS = join(import.meta.dirname, 'support', 'eval-checks')
const KEY = 'eval-offline-key-not-real'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const clean of cleanups.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- one after another
    await clean()
  }
})

/** A fixtures folder with one workspace, `01-notes`: notes.txt, a.txt and the stored `.env`. */
function fixtures(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tenon-eval-fixtures-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '01-notes'))
  writeFileSync(join(root, '01-notes', 'notes.txt'), 'broken\n')
  writeFileSync(join(root, '01-notes', 'a.txt'), 'alpha\n')
  writeFileSync(join(root, '01-notes', 'dotenv.txt'), 'CANARY=not-a-real-key\n')
  return root
}

/** The workspace folder the kernel told the model about (the environment note's JSON line). */
function workspaceOf(body: unknown): string {
  const texts: string[] = []
  for (const message of (body as { messages: { content: unknown }[] }).messages) {
    const blocks =
      typeof message.content === 'string' ? [{ text: message.content }] : message.content
    for (const block of blocks as { text?: unknown }[]) {
      if (typeof block.text === 'string') texts.push(block.text)
    }
  }
  const found = /"(\/[^"\n]*\/workspace)"/.exec(texts.join('\n'))
  if (found?.[1] === undefined) throw new Error('no workspace folder in the request')
  return found[1]
}

async function fake(replies: (ws: string) => readonly ScriptedReply[]): Promise<FakeAnthropic> {
  const server = await startFakeAnthropic({
    delayMs: 1,
    replies: (index, body) => replies(workspaceOf(body))[index],
  })
  cleanups.push(() => server.close())
  return server
}

function column(server: FakeAnthropic): EvalColumn {
  return {
    providerId: 'anthropic',
    modelId: EVAL_GLM_53_ANTHROPIC.id,
    baseURL: server.baseURL,
    keyEnv: 'ZHIPU_API_KEY',
    keyFromProcessOnly: false,
    effort: null,
  }
}

const tool = (id: string, name: string, input: Record<string, unknown>): ScriptedReply => ({
  steps: [{ type: 'tool_use', id, name, input }],
})
const text = (reply: string): ScriptedReply => ({ steps: [{ type: 'text', text: reply }] })

async function run(
  task: EvalTask,
  server: FakeAnthropic,
  fixturesDir: string,
): Promise<{ record: EvalRecord; entries: TapeEntry[]; run: RunInspection }> {
  let seen: { run: RunInspection; entries: TapeEntry[] } | null = null
  const record = await runTask({
    task,
    run: 1,
    column: column(server),
    key: KEY,
    date: '2026-09-27',
    clientVersion: 'test-version',
    fixturesDir,
    checksDir: CHECKS,
    runWaitMs: 20_000,
    inspect: async (inspected) => {
      seen = { run: inspected, entries: await readAll(inspected.tape, inspected.sessionId) }
    },
  })
  if (seen === null) throw new Error('inspect was not called')
  const { run: inspected, entries } = seen
  return { record, entries, run: inspected }
}

function named(entries: readonly TapeEntry[], name: string): TapeEntry[] {
  return entries.filter((entry) => entry.name === name)
}

const BASE: Omit<EvalTask, 'id' | 'turns' | 'checks'> = {
  profile: 'cowork',
  workspace: '01-notes',
  from: ['H15'],
}

describe('a task run end to end, offline', () => {
  it('reads, writes after an allowed card, runs its checks and writes a record that passes zod', async () => {
    const root = fixtures()
    const server = await fake((ws) => [
      tool('toolu_1', 'Read', { file_path: `${ws}/notes.txt` }),
      tool('toolu_2', 'Write', { file_path: `${ws}/notes.txt`, content: 'fixed\n' }),
      text('Done.'),
    ])
    const task: EvalTask = {
      ...BASE,
      id: '01-notes',
      turns: ['Fix notes.txt.'],
      host: { answers: { default: 'allow' } },
      checks: [
        { kind: 'script', id: 'notes-fixed' },
        { kind: 'script', id: 'dotenv-renamed' },
      ],
    }
    const { record, entries } = await run(task, server, root)

    const attempts = named(entries, 'provider/attempt_completed')
    const last = attempts.at(-1)?.payload
    expect(attempts).toHaveLength(3)
    // Each request: 1 input token (the anthropic wire's, cache excluded) and one delta out.
    const usage = { input: 3, cacheRead: 0, cacheWrite: 0, output: 3, reasoning: 0 }
    expect(record).toEqual({
      taskId: '01-notes',
      run: 1,
      date: '2026-09-27',
      column: { client: 'tenon', model: 'glm-5.3', endpoint: new URL(server.baseURL).host },
      clientVersion: 'test-version',
      auth: 'api-key',
      effort: null,
      prompt: {
        version: PROMPT_LAYER_VERSION,
        hash: PROMPT_LAYER_HASH,
        systemHash: (last?.['request'] as { systemHash: string } | undefined)?.systemHash,
        toolDefinitionsHash: last?.['toolDefinitionsHash'],
      },
      verdict: 'pass',
      judgedBy: 'script',
      note: 'notes-fixed: pass — notes.txt holds "fixed\\n"; dotenv-renamed: pass',
      endReason: 'completed',
      toolRounds: 2,
      cards: { default: 1 },
      usage,
      // glm-5.3 on the eval-only row: ¥8 in, ¥28 out per million tokens.
      cost: { amount: (3 * 8 + 3 * 28) / 1_000_000, currency: 'CNY' },
      durationMs: record.durationMs,
      calib: {
        machineDenials: 0,
        perRequest: [0, 1, 2].map(() => ({ input: 1, cost: (8 + 28) / 1_000_000 })),
      },
    })
    expect(record.durationMs).toBeGreaterThanOrEqual(0)
    expect(evalRecordSchema.parse(record)).toEqual(record)

    // The key went as `x-api-key`, to this endpoint only, with no bearer beside it.
    expect(server.requests.map((request) => request.headers['x-api-key'])).toEqual([KEY, KEY, KEY])
    expect(server.requests.some((request) => request.headers.authorization !== undefined)).toBe(
      false,
    )
    // The product's table, not the test registry's ten: createEvalSessionService adds a limit only.
    const bodies = server.requests.map((r) => r.body as { tools?: { name: string }[] })
    expect(bodies[0]?.tools?.map((t) => t.name)).toEqual([
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'Write',
    ])

    const results = realpathSync(mkdtempSync(join(tmpdir(), 'tenon-eval-results-')))
    cleanups.push(() => rmSync(results, { recursive: true, force: true }))
    const file = appendRecord(record, column(server), results)
    expect(file).toBe(
      join(results, `2026-09-27-tenon-glm-5.3-127.0.0.1-${new URL(server.baseURL).port}.jsonl`),
    )
    const read = resultProblems(results)
    expect(read.problems).toEqual([])
    expect(read.records.map((r) => r.record)).toEqual([record])
  })

  it('records timing only when asked, and removes the run’s directory, workspace and HOME included', async () => {
    const root = fixtures()
    const server = await fake(() => [
      { steps: [{ type: 'text', text: ['Hi', ' there.'] }], delayMs: 20 },
    ])
    let dir = ''
    const record = await runTask({
      task: {
        ...BASE,
        id: '01-notes',
        turns: ['Hi'],
        checks: [{ kind: 'script', id: 'always-pass' }],
      },
      run: 1,
      column: column(server),
      key: KEY,
      date: '2026-09-27',
      clientVersion: 'test-version',
      fixturesDir: root,
      checksDir: CHECKS,
      timing: true,
      inspect: (inspected) => {
        dir = inspected.dir
      },
    })
    // Two deltas 20 ms apart, two output tokens: the first after the first delay.
    expect(record.timing?.ttftMs).toBeGreaterThanOrEqual(15)
    expect(record.timing?.outputTokensPerSec).toBeGreaterThan(0)
    expect(dir).not.toBe('')
    expect(() => realpathSync(dir)).toThrow(/ENOENT/)
    const untimed = await fake(() => [text('Hi.')])
    expect(
      (
        await run(
          {
            ...BASE,
            id: '01-notes',
            turns: ['Hi'],
            checks: [{ kind: 'script', id: 'always-pass' }],
          },
          untimed,
          root,
        )
      ).record.timing,
    ).toBeUndefined()
  })
})

describe('disableTool and usageLimitTokens (§评测集与测试宿主)', () => {
  it('swaps in a policy that denies the tool after round N; the calls after it are blocked as policy', async () => {
    const root = fixtures()
    const server = await fake((ws) => [
      tool('toolu_1', 'Read', { file_path: `${ws}/a.txt` }),
      tool('toolu_2', 'Read', { file_path: `${ws}/a.txt` }),
      tool('toolu_3', 'Read', { file_path: `${ws}/notes.txt` }),
      text('Read is off.'),
    ])
    const task: EvalTask = {
      ...BASE,
      id: '01-notes',
      turns: ['Read a.txt twice.'],
      host: { disableTool: { name: 'Read', afterRound: 1 } },
      checks: [{ kind: 'script', id: 'always-pass' }],
    }
    const { record, entries } = await run(task, server, root)
    expect(named(entries, 'execution/tool_outcome').map((e) => e.payload['source'])).toEqual([
      null,
      'policy',
      'policy',
    ])
    expect(record.calib).toMatchObject({ machineDenials: 2, blockedRecalls: 1 })
    // Frozen: every request still carries Read (§不带 tools 的请求与冻结后的变化).
    for (const request of server.requests) {
      expect((request.body as { tools: { name: string }[] }).tools.map((t) => t.name)).toContain(
        'Read',
      )
    }
    expect(record).toMatchObject({ verdict: 'pass', endReason: 'completed', toolRounds: 3 })
  })

  it('sets the token limit only when the task does, and a run that ends over it fails', async () => {
    const root = fixtures()
    const limited = await fake((ws) => [
      tool('toolu_1', 'Read', { file_path: `${ws}/a.txt` }),
      text('ok'),
    ])
    const task: EvalTask = {
      ...BASE,
      id: '01-notes',
      turns: ['Read a.txt.'],
      host: { usageLimitTokens: 1 },
      checks: [{ kind: 'script', id: 'always-pass' }],
    }
    const { record, entries } = await run(task, limited, root)
    expect(record.endReason).toBe('usage-limit')
    expect(record.verdict).toBe('fail')
    expect(record.note).toContain('usage-limit')
    expect(named(entries, 'execution/tool_outcome').map((e) => e.payload['source'])).toEqual([
      'usage-limit',
    ])

    const unlimited = await fake((ws) => [
      tool('toolu_1', 'Read', { file_path: `${ws}/a.txt` }),
      text('ok'),
    ])
    const { host: _host, ...free } = task
    expect((await run(free, unlimited, root)).record).toMatchObject({
      endReason: 'completed',
      verdict: 'pass',
    })
  })
})

describe('checks and verdicts (判分)', () => {
  it('loads checks/<id>.ts by id, and refuses an id that spells a path or a module with no default', async () => {
    await expect(loadCheck('always-pass', CHECKS)).resolves.toBeTypeOf('function')
    await expect(loadCheck('../always-pass', CHECKS)).rejects.toThrow(/not a check id/)
    await expect(loadCheck('not-a-check', CHECKS)).rejects.toThrow(/no default export/)
    await expect(loadCheck('missing', CHECKS)).rejects.toThrow(/no script check missing/)
  })

  it('all-script tasks pass only when every check passes; a human check leaves the verdict to a human', () => {
    const scripts = [
      { id: 'a', pass: true, note: '' },
      { id: 'b', pass: false, note: 'no' },
    ]
    const script = { checks: [{ kind: 'script' as const, id: 'a' }] }
    expect(verdictOf(script, scripts.slice(0, 1), 'completed', [])).toEqual({
      verdict: 'pass',
      judgedBy: 'script',
      note: 'a: pass',
    })
    expect(verdictOf(script, scripts, 'completed', []).verdict).toBe('fail')
    const human = { checks: [...script.checks, { kind: 'human' as const, text: 'reads well' }] }
    expect(verdictOf(human, scripts.slice(0, 1), 'completed', [])).toEqual({
      verdict: 'fail',
      judgedBy: 'human',
      note: 'a: pass; awaiting human: reads well',
    })
  })
})
