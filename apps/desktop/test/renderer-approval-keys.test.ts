/**
 * The approval card's scope and reason lines (spec 02 §最小审批卡「期限」 and ③; plan step 20, 旧 217
 * renderer part). The scope comes from `allowScope` and `target.type` only; a card forwarded from a
 * sub-agent (`callKey !== anchorCallKey`) reads as a subtask. The expected words are the spec's own,
 * in both languages, read through the real catalogues.
 */
import {
  confirmKindSchema,
  confirmReasonSchema,
  confirmTargetSchema,
  flaggedCategorySchema,
} from '@tenon-app/contracts'
import type { i18n as I18n } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import { createI18n } from '../src/i18n/create-instance.js'
import {
  APPROVAL_CLICK_GUARD_MS,
  categoryOf,
  reasonKey,
  scopeKey,
} from '../src/renderer/src/lib/approval-keys.js'

const TARGETS = confirmTargetSchema.options.map((option) => option.shape.type.value)
const OTHER_TARGETS = TARGETS.filter((type) => type !== 'url')

let en: I18n
let zh: I18n

beforeAll(async () => {
  en = await createI18n('en', () => {})
  zh = await createI18n('zh-CN', () => {})
})

/** The scope line as a reader sees it: [en, zh-CN]. */
function scopeLine(...args: Parameters<typeof scopeKey>): [string, string] {
  const key = scopeKey(...args)
  return [en.t(key as never), zh.t(key as never)]
}

describe('scopeKey (§最小审批卡「期限」)', () => {
  it('knows all five target types', () => {
    expect(TARGETS.toSorted()).toEqual(['command', 'path', 'search', 'tool', 'url'])
  })

  it('(once, any target) → 「只这一次 / Just this once」, on a sub-agent’s card too', () => {
    for (const type of TARGETS) {
      for (const subtask of [false, true]) {
        expect(scopeLine('once', type, subtask)).toEqual(['Just this once', '只这一次'])
      }
    }
  })

  it('(session, url) → 「本会话里这个域名 / This domain, this session」', () => {
    expect(scopeLine('session', 'url', false)).toEqual([
      'This domain, this session',
      '本会话里这个域名',
    ])
  })

  it('(session, any other target) → 「本会话 / This session」', () => {
    for (const type of OTHER_TARGETS) {
      expect(scopeLine('session', type, false)).toEqual(['This session', '本会话'])
    }
  })

  it('a sub-agent’s card: session → 「本次子任务 / This subtask」, with a url 「本次子任务里这个域名」', () => {
    expect(scopeLine('session', 'url', true)).toEqual([
      'This domain, this subtask',
      '本次子任务里这个域名',
    ])
    for (const type of OTHER_TARGETS) {
      expect(scopeLine('session', type, true)).toEqual(['This subtask', '本次子任务'])
    }
  })
})

describe('reasonKey (§最小审批卡 ③)', () => {
  const kinds = confirmKindSchema.options

  it('irreversible → a sentence per kind', () => {
    for (const kind of kinds) {
      expect(reasonKey({ reason: 'irreversible', kind, facts: {} })).toBe(
        `confirm.reason.irreversible.${kind}`,
      )
    }
  })

  it('flagged → confirm.reason.flagged.<category>, whatever the kind', () => {
    for (const category of ['exfiltration', 'inspector-failed']) {
      for (const kind of kinds) {
        expect(reasonKey({ reason: 'flagged', kind, facts: { category, toolName: 'x' } })).toBe(
          `confirm.reason.flagged.${category}`,
        )
      }
    }
  })

  it('every other reason → confirm.reason.<reason>, whatever the kind', () => {
    const plain = confirmReasonSchema.options.filter(
      (reason) => reason !== 'irreversible' && reason !== 'flagged',
    )
    expect(plain).toHaveLength(7)
    for (const reason of plain) {
      for (const kind of kinds) {
        expect(reasonKey({ reason, kind, facts: { toolName: 'x' } })).toBe(
          `confirm.reason.${reason}`,
        )
      }
    }
  })

  it('names a sentence both catalogues have, for every reason, kind and category', () => {
    const keys = new Set<string>()
    for (const reason of confirmReasonSchema.options) {
      for (const kind of kinds) {
        for (const category of ['exfiltration', 'inspector-failed']) {
          keys.add(reasonKey({ reason, kind, facts: { category } }))
        }
      }
    }
    // 7 plain reasons, 4 irreversible kinds, 2 flagged categories.
    expect(keys.size).toBe(13)
    for (const key of keys) {
      expect([key, en.exists(key, { lng: 'en', fallbackLng: false })]).toEqual([key, true])
      expect([key, zh.exists(key, { lng: 'zh-CN', fallbackLng: false })]).toEqual([key, true])
    }
  })
})

describe('categoryOf (§最小审批卡 ③, §界面范围 BlockedNotice)', () => {
  it('reads a flagged category the contract knows', () => {
    expect(flaggedCategorySchema.options.toSorted()).toEqual(['exfiltration', 'inspector-failed'])
    for (const category of flaggedCategorySchema.options) {
      expect(categoryOf({ category, toolName: 'x' })).toBe(category)
    }
  })

  it('reads anything else as exfiltration: a key segment is never built from a fact’s text', () => {
    // `category` only picks the sentence; an unknown or odd value must not become a key segment.
    for (const category of [
      undefined,
      null,
      7,
      '',
      'Exfiltration',
      'reason.irreversible',
      'toString',
    ]) {
      expect([category, categoryOf({ category })]).toEqual([category, 'exfiltration'])
    }
    expect(categoryOf({})).toBe('exfiltration')
    // A flagged card with such a category reads the exfiltration sentence.
    expect(reasonKey({ reason: 'flagged', kind: 'network', facts: { category: '../x' } })).toBe(
      'confirm.reason.flagged.exfiltration',
    )
  })
})

describe('APPROVAL_CLICK_GUARD_MS (§最小审批卡「排队行」)', () => {
  it('is exported as a positive number of milliseconds', () => {
    expect(Number.isFinite(APPROVAL_CLICK_GUARD_MS)).toBe(true)
    expect(APPROVAL_CLICK_GUARD_MS).toBeGreaterThan(0)
  })
})
