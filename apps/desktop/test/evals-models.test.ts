/**
 * The runner's column and its key (spec 02 §同题对比「评测专用行」, §评测集与测试宿主; H15, A9, M4): the
 * eval-only glm-5.3 row sits on the anthropic definition of the runner's registry and in no daily
 * table; each column's key variable is bound to the one host it may go to; the official Anthropic
 * key comes from the runner's environment only. And the `TENON_EVAL_*` variables, which only the
 * runner's environment sets: `.env.local` is read for a key and nothing else.
 */
import {
  ANTHROPIC_PROVIDER_ID,
  createProviderRegistry,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { OFFICIAL_KEY_ENV } from '../e2e/helpers/app-env.js'
import {
  EVAL_GLM_53_ANTHROPIC,
  ZHIPU_ANTHROPIC_BASE_URL,
  assertKeyBound,
  columnSlug,
  evalProviderRegistry,
  readKey,
  resolveColumn,
} from '../evals/models.js'
import {
  TASK_DEADLINE_MS,
  deadlineOf,
  livePlan,
  planLine,
  runsOf,
  selectTasks,
} from '../evals/runner.js'
import type { EvalTask } from '../evals/task.js'

describe('the eval-only row (§同题对比「评测专用行」)', () => {
  it('is glm-5.3 on the anthropic definition, tools on, no thinkingSpec, in the runner’s registry only', () => {
    const anthropic = evalProviderRegistry().get(ANTHROPIC_PROVIDER_ID)
    expect(anthropic?.builtinModels.at(-1)).toBe(EVAL_GLM_53_ANTHROPIC)
    expect(EVAL_GLM_53_ANTHROPIC).toMatchObject({
      id: 'glm-5.3',
      providerId: 'anthropic',
      supportsToolCalling: true,
      thinkingPreservationFormat: 'signed-blocks',
    })
    expect(EVAL_GLM_53_ANTHROPIC.thinkingSpec).toBeUndefined()
    const daily = createProviderRegistry()
    registerBuiltinProviders(daily)
    expect(daily.get(ANTHROPIC_PROVIDER_ID)?.builtinModels.map((m) => m.id)).not.toContain(
      'glm-5.3',
    )
  })
})

describe('columns and keys (A9, M4)', () => {
  it('defaults to zhipu’s first row on /paas/v4 with ZHIPU_API_KEY', () => {
    expect(resolveColumn({})).toEqual({
      providerId: 'zhipu',
      modelId: 'glm-5.3',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
      keyEnv: 'ZHIPU_API_KEY',
      keyFromProcessOnly: false,
      effort: null,
    })
    expect(
      resolveColumn({ TENON_EVAL_MODEL: 'glm-5.3-flash', TENON_EVAL_EFFORT: 'high' }),
    ).toMatchObject({
      modelId: 'glm-5.3-flash',
      effort: 'high',
    })
  })

  it('sends the eval-only row to /api/anthropic with ZHIPU_API_KEY, a Claude row to the official host', () => {
    expect(
      resolveColumn({ TENON_EVAL_PROVIDER: 'anthropic', TENON_EVAL_MODEL: 'glm-5.3' }),
    ).toMatchObject({
      baseURL: ZHIPU_ANTHROPIC_BASE_URL,
      keyEnv: 'ZHIPU_API_KEY',
    })
    expect(
      resolveColumn({ TENON_EVAL_PROVIDER: 'anthropic', TENON_EVAL_MODEL: 'claude-opus-5-5' }),
    ).toMatchObject({
      baseURL: 'https://api.anthropic.com',
      keyEnv: OFFICIAL_KEY_ENV,
      keyFromProcessOnly: true,
    })
  })

  it('refuses what is not a table row, an effort the row lacks, and a key bound elsewhere', () => {
    expect(() => resolveColumn({ TENON_EVAL_PROVIDER: 'ollama' })).toThrow(/zhipu or anthropic/)
    expect(() => resolveColumn({ TENON_EVAL_MODEL: 'glm-9' })).toThrow(/not a row/)
    expect(() =>
      resolveColumn({ TENON_EVAL_MODEL: 'glm-5.3', TENON_EVAL_EFFORT: 'medium' }),
    ).toThrow(/effort/)
    expect(() =>
      assertKeyBound({ baseURL: 'https://api.anthropic.com', keyEnv: 'ZHIPU_API_KEY' }),
    ).toThrow(/A9/)
    expect(() =>
      assertKeyBound({
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
        keyEnv: OFFICIAL_KEY_ENV,
      }),
    ).toThrow(/A9/)
  })

  it('reads the zhipu key from the runner, then .env.local; the official one from the runner alone', () => {
    const zhipu = resolveColumn({})
    expect(readKey(zhipu, { ZHIPU_API_KEY: 'from-runner' }, { ZHIPU_API_KEY: 'from-file' })).toBe(
      'from-runner',
    )
    expect(readKey(zhipu, {}, { ZHIPU_API_KEY: 'from-file' })).toBe('from-file')
    expect(() => readKey(zhipu, {}, {})).toThrow(/no ZHIPU_API_KEY/)
    expect(() => readKey(zhipu, { ZHIPU_API_KEY: 'sk-ant-api03-x' }, {})).toThrow(/official/)
    const official = resolveColumn({
      TENON_EVAL_PROVIDER: 'anthropic',
      TENON_EVAL_MODEL: 'claude-sonnet-5',
    })
    expect(readKey(official, { [OFFICIAL_KEY_ENV]: 'sk-ant-api03-runner' }, {})).toBe(
      'sk-ant-api03-runner',
    )
    expect(() => readKey(official, {}, { [OFFICIAL_KEY_ENV]: 'sk-ant-api03-file' })).toThrow(
      /\.env\.local/,
    )
    // The error names the variable, never the value.
    expect(() =>
      readKey(official, { [OFFICIAL_KEY_ENV]: 'k' }, { OTHER: 'sk-ant-api03-secret' }),
    ).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret') as unknown }),
    )
  })

  it('names the results file by client, model and endpoint', () => {
    expect(
      columnSlug({ modelId: 'glm-5.3-flash', baseURL: 'https://open.bigmodel.cn/api/paas/v4/' }),
    ).toBe('tenon-glm-5.3-flash-open.bigmodel.cn-api-paas-v4')
    expect(columnSlug({ modelId: 'glm-5.3', baseURL: ZHIPU_ANTHROPIC_BASE_URL })).toBe(
      'tenon-glm-5.3-open.bigmodel.cn-api-anthropic',
    )
  })
})

function task(id: string, compare?: boolean): EvalTask {
  return {
    id,
    profile: 'chat',
    turns: ['hi'],
    checks: [{ kind: 'human', text: 'ok' }],
    from: [],
    ...(compare === undefined ? {} : { compare }),
  }
}

describe('TENON_EVAL_RUNS / _TASKS / _COMPARE_ONLY / _TIMING / _DEADLINE_MIN', () => {
  const tasks = [task('01-a', true), task('02-b'), task('03-c', true)]

  it('runs 3 times unless told, and refuses a count that is not a positive integer', () => {
    expect(runsOf({})).toBe(3)
    expect(runsOf({ TENON_EVAL_RUNS: '1' })).toBe(1)
    expect(() => runsOf({ TENON_EVAL_RUNS: '0' })).toThrow(/positive integer/)
  })

  it('picks tasks by id or NN, and the compare set only when asked', () => {
    expect(selectTasks(tasks, {}).map((t) => t.id)).toEqual(['01-a', '02-b', '03-c'])
    expect(selectTasks(tasks, { TENON_EVAL_TASKS: '02, 03-c' }).map((t) => t.id)).toEqual([
      '02-b',
      '03-c',
    ])
    expect(selectTasks(tasks, { TENON_EVAL_COMPARE_ONLY: '1' }).map((t) => t.id)).toEqual([
      '01-a',
      '03-c',
    ])
  })

  it('gives each task 45 minutes unless told, in whole minutes', () => {
    expect(deadlineOf({})).toBe(TASK_DEADLINE_MS)
    expect(TASK_DEADLINE_MS).toBe(45 * 60_000)
    expect(deadlineOf({ TENON_EVAL_DEADLINE_MIN: '60' })).toBe(60 * 60_000)
    expect(() => deadlineOf({ TENON_EVAL_DEADLINE_MIN: '0.5' })).toThrow(/positive integer/)
  })

  it('plans a live run from the runner’s environment alone; .env.local gives the key only', () => {
    const plan = livePlan(
      {
        TENON_EVAL_MODEL: 'glm-5.3-flashx',
        TENON_EVAL_RUNS: '1',
        TENON_EVAL_TIMING: '1',
        TENON_EVAL_DEADLINE_MIN: '20',
      },
      {
        ZHIPU_API_KEY: 'from-file',
        TENON_EVAL_MODEL: 'glm-5.3',
        TENON_EVAL_RUNS: '5',
        TENON_EVAL_TASKS: '02',
      },
      tasks,
    )
    expect(plan).toMatchObject({ key: 'from-file', runs: 1, timing: true, deadlineMs: 20 * 60_000 })
    expect(plan.column.modelId).toBe('glm-5.3-flashx')
    expect(plan.tasks.map((t) => t.id)).toEqual(['01-a', '02-b', '03-c'])
    // A stale selection in the file changes nothing, whatever the shell leaves unset.
    const bare = livePlan({}, { ZHIPU_API_KEY: 'k', TENON_EVAL_MODEL: 'glm-5.3-flash' }, tasks)
    expect(bare).toMatchObject({ runs: 3, timing: false, deadlineMs: TASK_DEADLINE_MS })
    expect(bare.column.modelId).toBe('glm-5.3')
    expect(bare.ignored).toEqual(['TENON_EVAL_MODEL'])
  })

  it('prints the plan in one line before the first request, naming the key’s variable only', () => {
    const plan = livePlan(
      { TENON_EVAL_MODEL: 'glm-5.3-flash', TENON_EVAL_TASKS: '01,03', ZHIPU_API_KEY: 'sk-secret' },
      { TENON_EVAL_RUNS: '9' },
      tasks,
    )
    const line = planLine(plan)
    expect(line).toBe(
      'eval column tenon-glm-5.3-flash-open.bigmodel.cn-api-paas-v4 (provider zhipu, model ' +
        'glm-5.3-flash, effort null, key from $ZHIPU_API_KEY) · runs 3 · tasks 01-a, 03-c · ' +
        'deadline 45 min per task · timing off · not read from .env.local: TENON_EVAL_RUNS',
    )
    expect(line).not.toContain('sk-secret')
  })
})
