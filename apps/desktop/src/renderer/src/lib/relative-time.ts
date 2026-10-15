const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago a message was sent, in the interface's language: under a minute the caller's own
 * 「刚刚」 (a catalogue string, so it is not decided here), then minutes, hours and days through
 * `Intl.RelativeTimeFormat`, and past a week the date itself. A clock that reads earlier than the
 * message (two windows, a skewed machine) is clamped to 「刚刚」, never a negative.
 */
export function relativeTime(then: number, now: number, locale: string, justNow: string): string {
  const elapsed = Math.max(0, now - then)
  if (elapsed < MINUTE) return justNow
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (elapsed < HOUR) return format.format(-Math.floor(elapsed / MINUTE), 'minute')
  if (elapsed < DAY) return format.format(-Math.floor(elapsed / HOUR), 'hour')
  if (elapsed < 7 * DAY) return format.format(-Math.floor(elapsed / DAY), 'day')
  const sameYear = new Date(then).getFullYear() === new Date(now).getFullYear()
  return new Date(then).toLocaleDateString(locale, {
    ...(sameYear ? {} : { year: 'numeric' as const }),
    month: 'short',
    day: 'numeric',
  })
}
