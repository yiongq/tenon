import { describe, expect, it } from 'vitest'
import { effectiveLocale, resolveLocale } from '../src/i18n/resolve-locale.js'

describe('resolveLocale', () => {
  it('takes the first supported primary subtag in preference order', () => {
    expect(resolveLocale(['fr-CA', 'zh-Hans-FI', 'en-US'])).toBe('zh-CN')
    expect(resolveLocale(['fr-CA', 'en-US', 'zh-Hans-CN'])).toBe('en')
    expect(resolveLocale(['zh-Hant-TW'])).toBe('zh-CN')
  })

  it('handles POSIX spellings and ignores near misses', () => {
    expect(resolveLocale(['zh_CN'])).toBe('zh-CN')
    expect(resolveLocale(['en_US.UTF-8'])).toBe('en')
    expect(resolveLocale(['zhuang', 'enochian'])).toBe('en')
    expect(resolveLocale(['zha'])).toBe('en')
  })

  it('falls back to English', () => {
    expect(resolveLocale([])).toBe('en')
    expect(resolveLocale(['de-DE', 'ja'])).toBe('en')
  })
})

describe('effectiveLocale', () => {
  it('lets the stored choice override the OS', () => {
    expect(effectiveLocale('en', ['zh-CN'])).toBe('en')
    expect(effectiveLocale('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(effectiveLocale('auto', ['zh-CN'])).toBe('zh-CN')
  })
})
