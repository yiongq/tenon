/**
 * Provider errors and the pure helpers both wire adapters need to classify one.
 *
 * The split the spec draws (§中止、重试、错误): a WIRE error is never thrown — the adapter
 * catches whatever the SDK raises and turns it into an `error` event, so `stream()` never
 * rejects. Only PROGRAMMER errors throw: missing configuration, illegal arguments. The
 * classes below are that second category.
 *
 * The classification half lives here rather than in either adapter because both map the same
 * HTTP statuses onto the same `ProviderErrorCode`s: two copies of that table would be two
 * readings of the retry policy the phase 2 loop obeys. What stays per-wire is each vendor's own
 * error vocabulary (Anthropic's `error.type`, OpenAI's `error.code`) and the SDK class a
 * connection failure arrives as.
 */
import { HostNetworkDeniedError } from '../host/adapter.js'
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
 * no clock global, so `now` (a HostClock.now() reading) comes from the caller. Note that
 * `ProviderDefinition.create()` hands an adapter network, config and secrets but no clock —
 * whoever wires step 10 needs a reading to reach here without a `Date.now()` in the kernel.
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
  // A value that starts like a number but failed NUMERIC_HEADER ('-5', '+5', '5-') is a
  // mangled delta-seconds, not an HTTP-date — every HTTP-date form starts with a weekday.
  // Date.parse() would happily read '-5' as the year 2001 and clamp it to "retry now",
  // which is the one answer that makes the phase 2 loop resend immediately.
  if (LOOKS_NUMERIC.test(raw)) return null
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

/** Anything a proxy might have mangled out of delta-seconds, rather than an HTTP-date. */
const LOOKS_NUMERIC = /^[+\-.\d]/

function numericHeader(headers: HeaderLookup, name: string): number | null {
  const raw = headers.get(name)?.trim()
  if (raw === undefined || !NUMERIC_HEADER.test(raw)) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * The ceiling on a delay. A timer clamps anything above 2^31-1 to 1 ms, so an absurd
 * `retry-after` ('99999999999' — about 3170 years) would reach the phase 2 loop as "resend
 * immediately", the same inversion the mangled delta-seconds guard above exists to prevent.
 * Clamped rather than dropped: a server asking for a preposterous wait is still asking to
 * wait, and 2^31-1 ms is as long as a loop can actually sleep.
 */
const MAX_RETRY_AFTER_MS = 2 ** 31 - 1

function clampDelay(ms: number): number | null {
  if (!Number.isFinite(ms)) return null
  return Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_AFTER_MS)
}

/**
 * Carries a `HostNetworkDeniedError` through an SDK's connection layer. Not exported from the
 * package: it exists only between `fetchThroughHost()` and an adapter's error mapper.
 *
 * Both SDKs decide a rejected fetch "timed out" by string-matching the error AND its `cause`, and
 * at least one of them then throws a timeout error carrying no cause at all — so a denial whose
 * message happens to mention a timeout would reach the mapper as an ordinary connection failure
 * and the phase 2 loop would resend a request the host's egress policy just refused. This
 * wrapper's message says nothing timeout-like and keeps the denial OFF `cause`, out of reach of
 * that match; `causeChain()` follows it instead.
 */
export class EgressDeniedError extends Error {
  /** The host's own rejection. Deliberately not on `cause` — see above. */
  readonly denial: HostNetworkDeniedError

  constructor(denial: HostNetworkDeniedError) {
    super('the host refused this request on egress policy')
    this.name = 'EgressDeniedError'
    this.denial = denial
  }
}

/** How deep a `cause` chain is followed. Two links is the SDKs' own depth; five is slack. */
const MAX_CAUSE_DEPTH = 5

/** An error and its `cause` chain, bounded and cycle-safe. */
export function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current: unknown = error
  while (current !== null && current !== undefined && chain.length < MAX_CAUSE_DEPTH) {
    if (chain.includes(current)) break
    chain.push(current)
    current = nextLink(current)
  }
  return chain
}

/** The next link down: `cause`, or the denial an EgressDeniedError carries beside it. */
function nextLink(error: unknown): unknown {
  if (error instanceof EgressDeniedError) return error.denial
  return error instanceof Error ? error.cause : undefined
}

/**
 * Whether the host refused the request on egress policy, anywhere in the chain.
 *
 * `HostNetworkDeniedError` is a bare `extends Error` whose `name` is still 'Error' (plan.md,
 * step 2), so `instanceof` is the only way to recognise it.
 */
export function hasEgressDenial(chain: readonly unknown[]): boolean {
  return chain.some(
    (link) => link instanceof HostNetworkDeniedError || link instanceof EgressDeniedError,
  )
}

/**
 * The HTTP status table, shared by both wires.
 *
 * `message` is the vendor's explanation, which is where a context-window refusal hides: every
 * endpoint reports one as an ordinary 400.
 */
export function statusErrorCode(status: number, message: string): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (status === 529) return 'overloaded'
  if (status >= 500) return 'server'
  if (status === 400 && looksLikeContextOverflow(message)) return 'context-overflow'
  // The two 4xx that resending does fix. A vendor's own `timeout_error` reads as `server` when no
  // status accompanies it, and gaining a status must not turn a transient timeout into a
  // permanent refusal.
  if (status === 408 || status === 425) return 'server'
  // Every other 4xx is a request this payload cannot fix by being sent again: a bad model name
  // (404), an unsupported field (422), a body too large (413).
  if (status >= 400) return 'invalid-request'
  // A 2xx / 3xx that still produced an error is a shape we do not understand.
  return 'unknown'
}

/**
 * A context-window refusal, which every wire reports as an ordinary invalid request. Matched on
 * the vendors' documented wording — Anthropic's "prompt is too long: N tokens > M maximum",
 * OpenAI's "maximum context length is N tokens", the `context_length_exceeded` spelling, and the
 * "context size" / "context limit" phrasings compatible gateways and local servers use — so the
 * phase 2 loop can tell "trim the context and retry" apart from "this request is malformed".
 *
 * The two Chinese phrasings are zhipu's (`Prompt 超长` at HTTP 400, docs.bigmodel.cn/cn/faq/api-code,
 * read 2026-09-21). That vendor also states a numeric code, which the per-wire vocabulary reads
 * first; these cover a gateway that relays the message and drops the code.
 */
const CONTEXT_OVERFLOW =
  /prompt is too long|too many tokens|context[ _-]?(?:window|length|size|limit)|超长|上下文长度/i

export function looksLikeContextOverflow(message: string): boolean {
  return CONTEXT_OVERFLOW.test(message)
}

/** The ceiling on `detail`: a log line, not a transcript of the vendor's body. */
const MAX_DETAIL_LENGTH = 500

/**
 * The `error` event's `detail`, which is for logs only and is never rendered.
 *
 * Redacted BEFORE the cap, never after: a credential that straddles the 500-character boundary
 * would otherwise survive as the prefix the cap left behind, and a prefix of a key is still a key
 * in a log. A gateway that echoes the request into a long error message is the realistic case.
 */
export function errorDetail(chain: readonly unknown[], redact: (text: string) => string): string {
  const text = redact(chain.map(describeLink).join(' <- '))
  return text.length <= MAX_DETAIL_LENGTH ? text : `${text.slice(0, MAX_DETAIL_LENGTH)}…`
}

function describeLink(link: unknown): string {
  if (link instanceof Error) {
    // `name` is 'Error' for most SDK classes (they do not set it), hence the constructor name.
    return `${link.constructor.name}: ${link.message}`
  }
  return String(link)
}

/**
 * Removes the configured credentials from a message before it becomes `detail`.
 *
 * Nothing in either SDK puts a key in an error message today; this exists because `detail` is the
 * one field of the event that carries free text out of the SDK, and "today" is not a property a
 * version pin can guarantee. Replacing rather than dropping the whole message keeps the diagnosis.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text
  for (const credential of credentials) {
    if (credential === '') continue
    out = out.split(credential).join('[redacted]')
  }
  return out
}

/** `err.status` when the SDK attached one; a mid-stream error frame has none. */
export function errorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const status: unknown = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

/** `err.headers` when it is a Headers-like object; `retryAfterMs()` only needs `get()`. */
export function errorHeaders(error: unknown): HeaderLookup | null {
  const headers = objectField(error, 'headers')
  if (headers === null) return null
  return typeof (headers as { get?: unknown }).get === 'function' ? (headers as HeaderLookup) : null
}

/**
 * The text a classifier reads: the thrown error's message plus the vendor's own message out of
 * the error body, because a 400's explanation lives in the body and an SDK's message is a summary
 * of it. Both nesting depths are read — the two SDKs disagree about whether the body's `error`
 * holds the explanation or another `error` does.
 */
export function errorMessage(error: unknown): string {
  const own = error instanceof Error ? error.message : ''
  const body = objectField(error, 'error')
  const direct = stringField(body, 'message') ?? ''
  const nested = stringField(objectField(body, 'error'), 'message') ?? ''
  return `${own} ${direct} ${nested}`
}

/** A non-empty string property, or null. Vendor bodies are data, so nothing is assumed. */
export function stringField(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object') return null
  const field: unknown = (value as Record<string, unknown>)[key]
  if (typeof field === 'string') return field === '' ? null : field
  // A numeric code (zhipu answers `"code": 1113`) is still the vendor naming the failure.
  if (typeof field === 'number' && Number.isFinite(field)) return String(field)
  return null
}

/** An object property, or null. */
export function objectField(value: unknown, key: string): object | null {
  if (value === null || typeof value !== 'object') return null
  const field: unknown = (value as Record<string, unknown>)[key]
  return field !== null && typeof field === 'object' ? field : null
}
