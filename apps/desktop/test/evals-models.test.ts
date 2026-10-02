/**
 * The runner's column and its key (spec 02 §同题对比「评测专用行」, §评测集与测试宿主; H15, A9, M4; M6
 * §点名 (d)): the eval-only glm-5.3 column is a custom vendor instance at Zhipu's /api/anthropic,
 * written into the run's profile only and in no definition's table; each column's key variable is
 * bound to the one host it may go to; the official Anthropic key comes from the runner's
 * environment only. And the `TENON_EVAL_*` variables, which only the runner's environment sets:
 * `.env.local` is read for a key and nothing else.
 */
import { customVendorSchema } from '@tenon-app/contracts'
import { ANTHROPIC_PROVIDER_ID, CUSTOM_PROVIDER_ID_PATTERN } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { OFFICIAL_KEY_ENV } from '../e2e/helpers/app-env.js'
import {
  EVAL_INSTANCE,
  EVAL_INSTANCE_PRICING,
  ZHIPU_ANTHROPIC_BASE_URL,
  assertKeyBound,
  columnSlug,
  evalProviderRegistry,
  readKey,
  resolveColumn,
} from '../evals/models.js'
import { instanceDefinition } from '../src/main/custom-vendors/registry.js'
import {
  TASK_DEADLINE_MS,
  deadlineOf,
  livePlan,
  planLine,
  runsOf,
  selectTasks,
} from '../evals/runner.js'
import type { EvalTask } from '../evals/task.js'

describe('the eval-only column (§同题对比「评测专用行」; M6 §点名 (d))', () => {
  it('is an anthropic-messages instance at Zhipu’s /api/anthropic, in no definition’s table', () => {
    expect(customVendorSchema.parse(EVAL_INSTANCE)).toEqual(EVAL_INSTANCE)
    expect(EVAL_INSTANCE.id).toMatch(CUSTOM_PROVIDER_ID_PATTERN)
    expect(EVAL_INSTANCE).toMatchObject({
      wire: 'anthropic-messages',
      baseURL: ZHIPU_ANTHROPIC_BASE_URL,
      models: [{ id: 'glm-5.3', contextLimit: 1_000_000, maxOutputTokens: 128_000 }],
    })
    // Unprobed as written: the runner's probe is what turns the row's tools on (M6 不变量 6).
    expect(EVAL_INSTANCE.models[0]?.probe).toBeUndefined()
    const [row] = instanceDefinition(EVAL_INSTANCE).builtinModels
    expect(row).toMatchObject({
      supportsToolCalling: false,
      thinkingPreservationFormat: 'signed-blocks',
    })
    // An instance row has no price (§合成): the column's own is the only one (Q17).
    expect(row?.pricing).toBeUndefined()
    expect(EVAL_INSTANCE_PRICING).toEqual({
      inputPerMTok: 8,
      outputPerMTok: 28,
      cacheReadPerMTok: 2,
      currency: 'CNY',
    })
    // The runner's registry is the app's: anthropic takes api.anthropic.com only (§点名 (a)).
    for (const definition of evalProviderRegistry().list()) {
      expect(definition.builtinModels.map((m) => `${definition.id}/${m.id}`)).not.toContain(
        'anthropic/glm-5.3',
      )
    }
    expect(evalProviderRegistry().get(EVAL_INSTANCE.id)).toBeNull()
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
      instance: null,
    })
    expect(
      resolveColumn({ TENON_EVAL_MODEL: 'glm-5.3-flash', TENON_EVAL_EFFORT: 'high' }),
    ).toMatchObject({
      modelId: 'glm-5.3-flash',
      effort: 'high',
    })
  })

  it('sends the eval-only instance to /api/anthropic with ZHIPU_API_KEY, a Claude row to the official host', () => {
    // Still named `anthropic` + `glm-5.3` (M6 §点名 (d)): the column, its name and its key are the
    // 02 row's; what runs it is the instance.
    expect(
      resolveColumn({ TENON_EVAL_PROVIDER: 'anthropic', TENON_EVAL_MODEL: 'glm-5.3' }),
    ).toEqual({
      providerId: EVAL_INSTANCE.id,
      modelId: 'glm-5.3',
      baseURL: ZHIPU_ANTHROPIC_BASE_URL,
      keyEnv: 'ZHIPU_API_KEY',
      keyFromProcessOnly: false,
      effort: null,
      instance: { entry: EVAL_INSTANCE, pricing: EVAL_INSTANCE_PRICING },
    })
    // An instance row has no thinking levels (T5).
    expect(() =>
      resolveColumn({
        TENON_EVAL_PROVIDER: 'anthropic',
        TENON_EVAL_MODEL: 'glm-5.3',
        TENON_EVAL_EFFORT: 'high',
      }),
    ).toThrow(/effort/)
    expect(
      resolveColumn({ TENON_EVAL_PROVIDER: 'anthropic', TENON_EVAL_MODEL: 'claude-opus-5-5' }),
    ).toMatchObject({
      providerId: ANTHROPIC_PROVIDER_ID,
      baseURL: 'https://api.anthropic.com',
      keyEnv: OFFICIAL_KEY_ENV,
      keyFromProcessOnly: true,
      instance: null,
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
