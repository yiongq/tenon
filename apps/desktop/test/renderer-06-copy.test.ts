import type { i18n as I18n } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import { confirmRequestSchema } from '@tenon-app/contracts'
import { createI18n } from '../src/i18n/create-instance.js'
import { titleKey, whyKey } from '../src/renderer/src/lib/approval-card.js'
import { decisionKey, unaskedReason } from '../src/renderer/src/lib/decision-copy.js'
import { tx } from '../src/renderer/src/lib/tx.js'

// 06 第三段的文案（§界面「照问的原因」「工具行」、规矩 13–14、§对 presentation-r1 §审批卡「问题式标题」的替换）。
let zh: I18n
let en: I18n
function fail(message: string): never {
  throw new Error(message)
}
beforeAll(async () => {
  zh = await createI18n('zh-CN', fail)
  en = await createI18n('en', fail)
})

const AUTO_ASK = ['no-snapshot', 'linux', 'platform', 'sandbox', 'redirect'] as const

function command(facts: Record<string, string>) {
  return {
    reason: 'command' as const,
    kind: 'command' as const,
    facts: { command: 'npm test', cwd: '/w', toolName: 'Bash', ...facts },
    target: { type: 'command' as const, command: 'npm test', cwd: '/w' },
  }
}
function file(facts: Record<string, string>) {
  return {
    reason: 'default' as const,
    kind: 'file' as const,
    facts: { toolName: 'Write', ...facts },
    target: { type: 'path' as const, path: '/w/a.txt' },
  }
}

function card(toolName: string, reversibility: 'read-only' | 'snapshotted' | 'irreversible') {
  return {
    kind: 'file' as const,
    reversibility,
    target: { type: 'path' as const, path: '/w/a.txt' },
    facts: { toolName },
  }
}
function allowed(code: string, facts: Record<string, string> = { toolName: 'Write' }) {
  return { permission: { verdict: 'allow' as const, code: code as never, facts } }
}

/** Both catalogues have the key; card copy names neither the model, the sandbox nor a check (rule 12). */
function expectCardCopy(key: string): void {
  expect([key, zh.exists(key, { lng: 'zh-CN', fallbackLng: false })]).toEqual([key, true])
  expect([key, en.exists(key, { lng: 'en', fallbackLng: false })]).toEqual([key, true])
  expect(String(zh.t(key as never))).not.toMatch(/模型|沙箱|inspector/i)
  expect(String(en.t(key as never))).not.toMatch(/model|sandbox|inspector/i)
}

describe('06 验收 39: each autoAsk reason has its sentence; Delete has its title', () => {
  it.each(AUTO_ASK)('%s on a file card and a command card', (reason) => {
    const key = `confirm.reason.autoAsk.${reason}`
    expect(whyKey(file({ autoAsk: reason }))).toBe(key)
    expect(whyKey(command({ autoAsk: reason }))).toBe(key)
    expectCardCopy(key)
  })

  it('says Linux only for linux, and the sentences are the spec’s', () => {
    expect(zh.t('confirm.reason.autoAsk.platform')).not.toMatch(/Linux/)
    expect(en.t('confirm.reason.autoAsk.platform')).not.toMatch(/Linux/)
    expect(zh.t('confirm.reason.autoAsk.linux')).toBe(
      '在 Linux 上，自动档里的命令照样先问你：这里护不住命令新建的仓库文件。',
    )
    expect(zh.t('confirm.reason.autoAsk.no-snapshot')).toBe('这个任务没法留底，自动档里也先问你。')
    expect(zh.t('confirm.reason.autoAsk.sandbox')).toBe(
      '命令的隔离还没准备好或只部分生效，自动档里先问你。',
    )
    expect(zh.t('confirm.reason.autoAsk.redirect')).toBe(
      '这条命令会把输出写进文件、盖掉原来的内容，自动档里也先问你。',
    )
    // A card with neither a category nor an autoAsk keeps its silent ③.
    expect(whyKey(command({}))).toBeNull()
    expect(whyKey(file({}))).toBeNull()
    // A command card a check asked about says the check's sentence, never the autoAsk one (D36).
    expect(whyKey(command({ category: 'exfiltration', autoAsk: 'redirect' }))).toBe(
      'confirm.reason.flagged.exfiltration',
    )
  })

  it('titles a Delete card 「删除这个文件？」, other file cards as before', () => {
    expect(titleKey(card('Delete', 'snapshotted'))).toBe('confirm.title.file.delete')
    expect(titleKey(card('Delete', 'irreversible'))).toBe('confirm.title.file.delete')
    expect(titleKey(card('Write', 'snapshotted'))).toBe('confirm.title.file.write')
    expect(titleKey(card('Read', 'read-only'))).toBe('confirm.title.file.read')
    expect(zh.t('confirm.title.file.delete')).toBe('删除这个文件？')
    expect(en.t('confirm.title.file.delete')).toBe('Delete this file?')
    expectCardCopy('confirm.title.file.delete')
  })
})

describe('06 验收 43: unknown autoAsk values and command-card categories deliver with a generic sentence; unknown flagged categories do not', () => {
  const base = { requestId: 'r1', sessionId: 's1', reversibility: 'unknown' }

  it('says the general sentence for what this build does not know', () => {
    expect(whyKey(command({ autoAsk: 'from-a-later-build' }))).toBe(
      'confirm.reason.autoAsk.unknown',
    )
    expect(whyKey(file({ autoAsk: 'from-a-later-build' }))).toBe('confirm.reason.autoAsk.unknown')
    expect(whyKey(command({ category: 'from-a-later-build' }))).toBe(
      'confirm.reason.flagged.unknown',
    )
    expect(zh.t('confirm.reason.autoAsk.unknown')).toBe('这一步在自动档里也先问你。')
    expect(zh.t('confirm.reason.flagged.unknown')).toBe('Tenon 的检查要你再看一眼这一步。')
    expectCardCopy('confirm.reason.autoAsk.unknown')
    expectCardCopy('confirm.reason.flagged.unknown')
  })

  it('delivers such a command card, while a flagged card with an unknown category is refused', () => {
    expect(
      confirmRequestSchema.safeParse({
        ...base,
        ...command({ autoAsk: 'from-a-later-build', category: 'from-a-later-build' }),
      }).success,
    ).toBe(true)
    expect(
      confirmRequestSchema.safeParse({ ...base, ...file({ autoAsk: 'from-a-later-build' }) })
        .success,
    ).toBe(true)
    expect(
      confirmRequestSchema.safeParse({
        ...base,
        reason: 'flagged',
        kind: 'file',
        facts: { toolName: 'Write', category: 'from-a-later-build' },
        target: { type: 'path', path: '/w/a.txt' },
      }).success,
    ).toBe(false)
  })
})

describe('06 验收 38: an expanded allowed row shows why it was not asked', () => {
  it('names the reason of a call allowed with no card', () => {
    const auto = unaskedReason(allowed('auto-mode'))
    expect(auto?.key).toBe('snapshot.decision.auto-mode')
    expect(zh.t(auto!.key as never)).toBe('自动档放行')
    expect(en.t(auto!.key as never)).toBe('Allowed by auto mode')
    const session = unaskedReason(allowed('session-allowed'))
    expect(tx(zh.t, session!.key, session!.facts)).toBe('你已允许本会话使用')
    expect(zh.t('tool.whyUnasked')).toBe('为什么没问')
  })

  it('adds nothing to a call a card asked about, or one that was not allowed', () => {
    expect(
      unaskedReason({
        ...allowed('default-ask'),
        approval: {
          outcome: 'allowed',
          scope: 'once',
          target: { type: 'path', path: '/w/a.txt' },
        },
      }),
    ).toBeNull()
    expect(
      unaskedReason({ permission: { verdict: 'ask', code: 'default-ask', facts: {} } }),
    ).toBeNull()
    expect(
      unaskedReason({ permission: { verdict: 'deny', code: 'org-policy', facts: {} } }),
    ).toBeNull()
    expect(unaskedReason({})).toBeNull()
    expect(unaskedReason(null)).toBeNull()
  })
})

describe('06 验收 44: unknown summary codes read as unknown with one neutral sentence per verdict', () => {
  it.each([
    ['allow', '这一步已放行。', 'This step was allowed.'],
    ['ask', '这一步要你确认。', 'This step needs your OK.'],
    ['deny', '这一步已被拦下。', 'This step was stopped.'],
  ] as const)('%s', (verdict, sentenceZh, sentenceEn) => {
    const key = decisionKey({ verdict, code: 'unknown' })
    expect(key).toBe(`snapshot.decision.unknown.${verdict}`)
    expect(zh.t(key as never)).toBe(sentenceZh)
    expect(en.t(key as never)).toBe(sentenceEn)
    // The expanded row changes only where it already shows a reason: allowed, no card.
    const row = unaskedReason({ permission: { verdict, code: 'unknown' as never, facts: {} } })
    expect(row?.key ?? null).toBe(verdict === 'allow' ? key : null)
    // A known code keeps its own sentence.
    expect(decisionKey({ verdict, code: 'default-ask' })).toBe('snapshot.decision.default-ask')
  })
})
