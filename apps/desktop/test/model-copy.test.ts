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
