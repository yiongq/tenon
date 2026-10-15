/**
 * The age a message wears in its action bar (components.md `UserActionBar`, `AssistantActionBar`:
 * 「相对时间」): 「刚刚」 under a minute, then minutes, hours, days through the platform's own
 * relative-time formatter in the interface language, then the date. Both catalogue languages.
 */
import { describe, expect, it } from 'vitest'
import { relativeTime } from '../src/renderer/src/lib/relative-time.js'

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime()
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('relativeTime', () => {
  it('says 「刚刚」 / "Just now" for the first minute, and for a clock that reads earlier', () => {
    expect(relativeTime(NOW, NOW, 'zh-CN', '刚刚')).toBe('刚刚')
    expect(relativeTime(NOW - 59 * SECOND, NOW, 'en', 'Just now')).toBe('Just now')
    expect(relativeTime(NOW + 5 * MINUTE, NOW, 'en', 'Just now')).toBe('Just now')
  })

  it('counts minutes, hours and days in the interface language', () => {
    expect(relativeTime(NOW - 5 * MINUTE, NOW, 'zh-CN', '刚刚')).toBe('5分钟前')
    expect(relativeTime(NOW - 5 * MINUTE, NOW, 'en', 'Just now')).toBe('5 minutes ago')
    expect(relativeTime(NOW - 3 * HOUR - 20 * MINUTE, NOW, 'zh-CN', '刚刚')).toBe('3小时前')
    expect(relativeTime(NOW - 3 * HOUR - 20 * MINUTE, NOW, 'en', 'Just now')).toBe('3 hours ago')
    expect(relativeTime(NOW - DAY, NOW, 'zh-CN', '刚刚')).toBe('昨天')
    expect(relativeTime(NOW - DAY, NOW, 'en', 'Just now')).toBe('yesterday')
    expect(relativeTime(NOW - 4 * DAY, NOW, 'en', 'Just now')).toBe('4 days ago')
  })

  it('switches to the date after a week, with the year only when it is another year', () => {
    const sameYear = new Date(2026, 9, 1, 9, 0, 0).getTime()
    expect(relativeTime(sameYear, NOW, 'en', 'Just now')).toBe('Oct 1')
    expect(relativeTime(sameYear, NOW, 'zh-CN', '刚刚')).toBe('10月1日')
    const lastYear = new Date(2025, 11, 31, 9, 0, 0).getTime()
    expect(relativeTime(lastYear, NOW, 'en', 'Just now')).toBe('Dec 31, 2025')
  })
})
