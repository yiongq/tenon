/**
 * The copy of the 18 end codes (spec 02 §结束原因词表, §失败卡与结束原因; plan step 13, 旧 106): both
 * locales have a non-empty sentence for every code, each names exactly the slots its sentence reads
 * off the member — never a slot the member does not have — and every one renders.
 */
import type { RunEndReason } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { createI18n } from '../src/i18n/create-instance.js'
import enCommon from '../src/i18n/locales/en/common.json'
import zhCommon from '../src/i18n/locales/zh-CN/common.json'

type Code = RunEndReason['code']
type SlotOf<C extends Code> = Exclude<keyof Extract<RunEndReason, { code: C }>, 'code'>

/**
 * The slots each sentence reads, a subset of the member's own fields by type. `provider-error`'s
 * `errorCode` and `providerReason` go to the copied diagnostics, not the sentence.
 */
const SLOTS: { readonly [C in Code]: readonly SlotOf<C>[] } = {
  completed: [],
  'user-stopped': [],
  paused: ['waitingFor'],
  'user-rejected': ['toolName'],
  'blocked-repeatedly': ['count'],
  'step-limit': ['limit'],
  'no-progress': ['repeats'],
  'usage-limit': ['tokenLimit'],
  refusal: ['modelId', 'providerId'],
  'content-filter': ['providerId'],
  'context-overflow': ['compactions'],
  'quota-exhausted': ['providerId', 'resetAt'],
  'account-config': ['providerId'],
  'provider-error': ['attempts', 'providerId'],
  'output-truncated': ['maxTokens'],
  'shutdown-aborted': ['trigger'],
  recovered: [],
  'time-limit': ['limitMs'],
}

const CODES = Object.keys(SLOTS) as Code[]

/** The ICU arguments a message names, at any depth. */
function argumentsOf(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*[,}]/g)].map((m) => m[1] ?? '')),
  ].toSorted()
}

const SAMPLE: Record<string, string | number> = {
  waitingFor: 'approval',
  toolName: 'Write',
  count: 3,
  limit: 100,
  repeats: 4,
  tokenLimit: 200_000,
  modelId: 'glm-5.3-flash',
  providerId: 'zhipu',
  compactions: 2,
  resetAt: 'unknown',
  attempts: 3,
  maxTokens: 8192,
  trigger: 'quit',
  limitMs: 600_000,
}

describe('the end-code copy', () => {
  const locales = { en: enCommon.runEnd, 'zh-CN': zhCommon.runEnd } as const

  it('has a sentence for each of the 18 codes in both locales, and no other', () => {
    expect(CODES).toHaveLength(18)
    for (const table of Object.values(locales)) {
      expect(Object.keys(table).toSorted()).toEqual([...CODES].toSorted())
    }
  })

  it('names exactly the slots its sentence reads, in both locales', () => {
    for (const [locale, table] of Object.entries(locales)) {
      for (const code of CODES) {
        const message = (table as Record<string, string>)[code] ?? ''
        expect(message.trim().length, `${locale} ${code}`).toBeGreaterThan(0)
        expect(argumentsOf(message), `${locale} ${code}`).toEqual([...SLOTS[code]].toSorted())
      }
    }
  })

  it('renders every sentence without an ICU error', async () => {
    const errors: string[] = []
    for (const locale of ['en', 'zh-CN'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one instance per locale
      const i18n = await createI18n(locale, (line) => errors.push(line))
      for (const code of CODES) {
        const text = i18n.t(`runEnd.${code}`, SAMPLE)
        expect(text, `${locale} ${code}`).not.toMatch(/i18n-error|\{/)
        expect(text.length).toBeGreaterThan(0)
      }
    }
    expect(errors).toEqual([])
  })
})
