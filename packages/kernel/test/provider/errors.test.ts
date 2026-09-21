/**
 * The two pure helpers both wire adapters will call at steps 10 and 11: the retry delay a
 * response asked for, and the default retryability per error code. The SDKs' own parsing of
 * `retry-after` is switched off with `maxRetries: 0`, so this is the only reader.
 */
import { describe, expect, it } from 'vitest'
import { isRetryableByDefault, retryAfterMs } from '../../src/index.js'
import type { ProviderErrorCode } from '../../src/index.js'

/** Headers as both SDKs expose them on a typed error. */
function headersOf(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0)

describe('retryAfterMs', () => {
  it('prefers retry-after-ms, which is already in milliseconds', () => {
    expect(retryAfterMs(headersOf({ 'retry-after-ms': '1500', 'retry-after': '60' }), NOW)).toBe(
      1500,
    )
  })

  it('reads retry-after as seconds', () => {
    expect(retryAfterMs(headersOf({ 'retry-after': '3' }), NOW)).toBe(3000)
    expect(retryAfterMs(headersOf({ 'Retry-After': '0' }), NOW)).toBe(0)
  })

  it('reads a non-numeric retry-after as an HTTP-date against the caller’s clock', () => {
    // The kernel has no clock global: `now` is a HostClock.now() reading passed in.
    const at = new Date(NOW + 30_000).toUTCString()
    expect(retryAfterMs(headersOf({ 'retry-after': at }), NOW)).toBe(30_000)
  })

  it('clamps a date already in the past to zero', () => {
    const at = new Date(NOW - 30_000).toUTCString()
    expect(retryAfterMs(headersOf({ 'retry-after': at }), NOW)).toBe(0)
  })

  it('says nothing when the response did not', () => {
    expect(retryAfterMs(headersOf({}), NOW)).toBeNull()
    expect(retryAfterMs(undefined, NOW)).toBeNull()
    expect(retryAfterMs(null, NOW)).toBeNull()
    // Neither an empty value nor a garbage one is a delay of 0 seconds.
    expect(retryAfterMs(headersOf({ 'retry-after': '' }), NOW)).toBeNull()
    expect(retryAfterMs(headersOf({ 'retry-after': 'soon' }), NOW)).toBeNull()
    expect(retryAfterMs(headersOf({ 'retry-after-ms': 'soon', 'retry-after': '2' }), NOW)).toBe(
      2000,
    )
  })
})

describe('isRetryableByDefault', () => {
  const RETRYABLE: readonly ProviderErrorCode[] = ['rate-limit', 'overloaded', 'network', 'server']
  const FINAL: readonly ProviderErrorCode[] = [
    'egress-denied',
    'auth',
    'invalid-request',
    'context-overflow',
    // An unclassified failure is not resent: we do not know what the payload did.
    'unknown',
  ]

  it.each(RETRYABLE)('%s is worth another attempt', (code) => {
    expect(isRetryableByDefault(code)).toBe(true)
  })

  it.each(FINAL)('%s is not', (code) => {
    expect(isRetryableByDefault(code)).toBe(false)
  })
})
