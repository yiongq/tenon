/**
 * The settings card's wording after spec 02 (§模型选择「设置卡」; plan step 19, 旧 82's common.json
 * half): the model field is the default of NEW chats, and the card's description says so first.
 */
import { describe, expect, it } from 'vitest'
import { resources } from '../src/i18n/resources.js'
import type { Locale } from '../src/i18n/resources.js'

/** Against the raw bundles, as the catalogue test reads them. */
function text(locale: Locale, key: string): string {
  let node: unknown = resources[locale].common
  for (const segment of key.split('.')) node = (node as Record<string, unknown>)[segment]
  if (typeof node !== 'string') throw new Error(`${locale}: ${key} is not a string`)
  return node
}

describe('the settings card wording', () => {
  it('names the model field the default for new chats, in both languages', () => {
    expect(text('en', 'settings.providers.model')).toBe('Default model for new chats')
    expect(text('zh-CN', 'settings.providers.model')).toBe('新会话默认模型')
    expect(text('en', 'settings.providers.description')).toMatch(/^[^.]*new chats/)
    expect(text('zh-CN', 'settings.providers.description')).toMatch(/^[^。]*新会话/)
  })
})

describe('Fable 5.1’s purpose line (s19-spec-6)', () => {
  it('says what the vendor says: retention turned on for the organization or the workspace', () => {
    // plan step 2's record: Anthropic's data-retention page names 「组织或工作区」.
    expect(text('en', 'model.purpose.fable51')).toBe(
      'Needs 30-day data retention turned on for your organization or workspace',
    )
    expect(text('zh-CN', 'model.purpose.fable51')).toBe('需要组织或工作区开启 30 天数据保留')
  })
})
