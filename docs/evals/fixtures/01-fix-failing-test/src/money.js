// Money helpers. Every amount is an integer number of cents.

/** '12.34' -> 1234 */
export function toCents(text) {
  const [whole, fraction = ''] = text.trim().split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2))
}

/** 1234 -> '$12.34', -5 -> '-$0.05' */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100)}.${abs % 100}`
}

/** Takes `percent` off, rounding half a cent up. */
export function applyPercentOff(cents, percent) {
  return Math.round((cents * (100 - percent)) / 100)
}
