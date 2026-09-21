/**
 * Provider errors and the two pure helpers both wire adapters need.
 *
 * The split the spec draws (§中止、重试、错误): a WIRE error is never thrown — the adapter
 * catches whatever the SDK raises and turns it into an `error` event, so `stream()` never
 * rejects. Only PROGRAMMER errors throw: missing configuration, illegal arguments. The
 * classes below are that second category.
 */
import type { ProviderErrorCode, ProviderId } from './types.js'

/** A required ConfigKey had no value when a ProviderDefinition.create() ran. */
export class ProviderConfigMissingError extends Error {
  readonly providerId: ProviderId
  /** The ConfigKey name, never its value — secrets stay out of messages and logs. */
  readonly key: string

  constructor(providerId: ProviderId, key: string) {
    super(`provider ${providerId}: required config "${key}" is missing`)
    this.name = 'ProviderConfigMissingError'
    this.providerId = providerId
    this.key = key
  }
}

/**
 * A caller or an adapter broke a documented contract: a stream event shape that cannot be
 * folded, a decision applied to the wrong kind of block, a malformed definition. It is a
 * bug in our code, not a condition of the remote endpoint.
 */
export class ProviderInvalidArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderInvalidArgumentError'
  }
}

/** Two definitions claimed the same ProviderId; the registry never overwrites. */
export class ProviderAlreadyRegisteredError extends Error {
  readonly providerId: ProviderId

  constructor(providerId: ProviderId) {
    super(`provider "${providerId}" is already registered`)
    this.name = 'ProviderAlreadyRegisteredError'
    this.providerId = providerId
  }
}

/** The subset of Headers both SDKs expose on a typed error (`err.headers`). */
export interface HeaderLookup {
  get(name: string): string | null
}

/**
 * The retry delay a 429 / 503 asked for, in ms, or null when the response did not say.
 *
 * The SDKs parse `retry-after` only on their own retry path, which `maxRetries: 0` turns
 * off, so each adapter reads it here instead. `retry-after-ms` (already ms) wins over
 * `retry-after` (seconds); a non-numeric `retry-after` is an HTTP-date, and the kernel has
 * no clock global, so `now` (a HostClock.now() reading) comes from the caller.
 *
 * A date already in the past clamps to 0 — "retry now" — rather than a negative delay.
 */
export function retryAfterMs(headers: HeaderLookup | null | undefined, now: number): number | null {
  if (headers == null) return null
  const explicitMs = numericHeader(headers, 'retry-after-ms')
  if (explicitMs !== null) return clampDelay(explicitMs)
  const seconds = numericHeader(headers, 'retry-after')
  if (seconds !== null) return clampDelay(seconds * 1000)
  const raw = headers.get('retry-after')?.trim()
  if (raw === undefined || raw === '') return null
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return clampDelay(at - now)
}

/**
 * Whether a code is worth another attempt when the wire said nothing else. Advice for the
 * phase 2 loop: an `error` event carries its own `retryable`, and an adapter that knows
 * better (an auth error that is really a proxy hiccup) may override it there.
 *
 * A Record rather than a switch so that adding a ProviderErrorCode fails to compile until
 * its retryability is decided. `unknown` is NOT retryable: we do not resend a payload whose
 * failure we could not classify.
 */
export function isRetryableByDefault(code: ProviderErrorCode): boolean {
  return RETRYABLE_BY_DEFAULT[code]
}

const RETRYABLE_BY_DEFAULT: Readonly<Record<ProviderErrorCode, boolean>> = {
  auth: false,
  'egress-denied': false,
  'invalid-request': false,
  'context-overflow': false,
  'rate-limit': true,
  overloaded: true,
  network: true,
  server: true,
  unknown: false,
}

/** Digits with an optional fraction only: `Number('')` is 0 and `Number('Wed')` is NaN. */
const NUMERIC_HEADER = /^\d+(?:\.\d+)?$/

function numericHeader(headers: HeaderLookup, name: string): number | null {
  const raw = headers.get(name)?.trim()
  if (raw === undefined || !NUMERIC_HEADER.test(raw)) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function clampDelay(ms: number): number | null {
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.round(ms))
}
