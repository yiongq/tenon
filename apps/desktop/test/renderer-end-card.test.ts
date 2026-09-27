/**
 * What each Run end shows (spec 02 §失败卡与结束原因, the table at spec.md:2805; plan step 20, 旧 221).
 * The table below is the spec's, row by row, written without looking at the switch: 中性 = neutral,
 * 红 = danger, 琥珀 = warning; 「继续」 = continue, 「重试」 = retry, 「去设置」 = settings, 复制诊断信息 =
 * copy. Every end code the contract has must be in it exactly once.
 */
import { providerErrorCodeSchema, runEndReasonSchema } from '@tenon-app/contracts'
import type { RunEndReasonContract } from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import { cardOf } from '../src/renderer/src/lib/end-card.js'

type Code = RunEndReasonContract['code']
type Row = { readonly visual: string; readonly action: string } | null

/** One valid member per code: the rows are checked against real contract values. */
const SAMPLE: { readonly [C in Code]: Extract<RunEndReasonContract, { code: C }> } = {
  completed: { code: 'completed' },
  paused: { code: 'paused', waitingFor: 'approval' },
  'step-limit': { code: 'step-limit', limit: 100 },
  'output-truncated': { code: 'output-truncated', maxTokens: 1024 },
  'user-stopped': { code: 'user-stopped' },
  'shutdown-aborted': { code: 'shutdown-aborted', trigger: 'quit' },
  'user-rejected': { code: 'user-rejected', toolName: 'Write' },
  'usage-limit': { code: 'usage-limit', tokenLimit: 200_000 },
  recovered: { code: 'recovered' },
  'time-limit': { code: 'time-limit', limitMs: 600_000 },
  'blocked-repeatedly': { code: 'blocked-repeatedly', count: 3 },
  'provider-error': {
    code: 'provider-error',
    providerId: 'anthropic',
    errorCode: 'server',
    providerReason: null,
    attempts: 3,
  },
  refusal: { code: 'refusal', providerId: 'anthropic', modelId: 'claude-x' },
  'content-filter': { code: 'content-filter', providerId: 'zhipu' },
  'context-overflow': { code: 'context-overflow', compactions: 1 },
  'no-progress': { code: 'no-progress', repeats: 4 },
  'quota-exhausted': { code: 'quota-exhausted', providerId: 'zhipu', resetAt: null },
  'account-config': { code: 'account-config', providerId: 'anthropic' },
}

const NEUTRAL_CONTINUE: Row = { visual: 'neutral', action: 'continue' }
const NEUTRAL_COPY: Row = { visual: 'neutral', action: 'copy' }
const DANGER_COPY: Row = { visual: 'danger', action: 'copy' }

/** Every row of the spec's table whose answer does not depend on the Run (all but provider-error). */
const TABLE: ReadonlyArray<readonly [codes: readonly Exclude<Code, 'provider-error'>[], row: Row]> =
  [
    // `completed`: only the summary line; `paused`: no card, the card or the question is in view.
    [['completed'], null],
    [['paused'], null],
    [['step-limit', 'output-truncated'], NEUTRAL_CONTINUE],
    [
      [
        'user-stopped',
        'shutdown-aborted',
        'user-rejected',
        'usage-limit',
        'recovered',
        'time-limit',
      ],
      NEUTRAL_COPY,
    ],
    [['blocked-repeatedly'], { visual: 'warning', action: 'copy' }],
    [
      [
        'refusal',
        'content-filter',
        'context-overflow',
        'no-progress',
        'quota-exhausted',
        'account-config',
      ],
      DANGER_COPY,
    ],
  ]

describe('cardOf (§失败卡与结束原因)', () => {
  it('has a row for every end code of the contract, and only those', () => {
    const contract = runEndReasonSchema.options.map((option) => option.shape.code.value).toSorted()
    const table = [...TABLE.flatMap(([codes]) => codes), 'provider-error'].toSorted()
    expect(table).toEqual(contract)
    expect(contract).toHaveLength(18)
    for (const reason of Object.values(SAMPLE)) runEndReasonSchema.parse(reason)
  })

  for (const [codes, row] of TABLE) {
    for (const code of codes) {
      it(`${code} → ${row === null ? 'no card' : `${row.visual} / ${row.action}`}, whatever the Run`, () => {
        // Only a provider error looks at whether the Run could be resent.
        expect(cardOf(SAMPLE[code], true)).toEqual(row)
        expect(cardOf(SAMPLE[code], false)).toEqual(row)
      })
    }
  }

  it('provider-error with errorCode auth → danger / settings, even when the Run could be resent', () => {
    const auth = { ...SAMPLE['provider-error'], errorCode: 'auth' as const }
    expect(cardOf(auth, true)).toEqual({ visual: 'danger', action: 'settings' })
    expect(cardOf(auth, false)).toEqual({ visual: 'danger', action: 'settings' })
  })

  it('any other provider-error → danger / retry when the Run can be resent, else copy', () => {
    const others = [...providerErrorCodeSchema.options.filter((code) => code !== 'auth'), null]
    expect(others).toHaveLength(providerErrorCodeSchema.options.length)
    for (const errorCode of others) {
      const reason = { ...SAMPLE['provider-error'], errorCode }
      expect([errorCode, cardOf(reason, true)]).toEqual([
        errorCode,
        { visual: 'danger', action: 'retry' },
      ])
      expect([errorCode, cardOf(reason, false)]).toEqual([errorCode, DANGER_COPY])
    }
  })
})
