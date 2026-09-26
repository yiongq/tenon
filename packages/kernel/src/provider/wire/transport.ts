/**
 * What the two SDK-backed adapter halves share: the single seam through which bytes leave the
 * kernel, the checks that decide whether a client may be built at all, and the two decode helpers
 * whose reading must not diverge between wires.
 *
 * The encoders' shared helpers live in ./shared.ts, which is pure. This file is where the host's
 * `fetch` is touched — and nowhere else in the provider layer.
 */
import type { HostClock, HostNetwork } from '../../host/adapter.js'
import { HostNetworkDeniedError } from '../../host/adapter.js'
import { EgressDeniedError, ProviderInvalidArgumentError } from '../errors.js'
import type { ProviderId } from '../types.js'

/**
 * A configured credential or URL, or null when the value is absent / blank.
 *
 * `undefined` reads as "not configured" too, not as a crash: with `noUncheckedIndexedAccess` a
 * caller reading `secrets['apiKey']` holds `string | undefined`, and a provider that has the other
 * credential must not be refused by a TypeError raised over the one it does not have. A blank
 * string is not a credential either — both SDKs would send an empty header and the endpoint would
 * answer 401, which reads as a wrong key rather than a missing one.
 *
 * The value is returned TRIMMED, not just tested trimmed: these values are typed by a user (step
 * 14's settings card), so a pasted key arrives with a trailing newline and a pasted URL with a
 * space. Untrimmed, the padding travels — `Bearer ␣key` reads as a wrong key and
 * `https://host/v1␣␣/chat/completions` as a dead gateway — and the credential the redaction list
 * holds would no longer be the byte sequence that went out. One value, one spelling.
 */
export function configuredValue(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** What a wire needs said about its base URL beyond "it is an absolute http(s) URL". */
export interface BaseUrlPolicy {
  readonly wire: string
  /**
   * true for a wire whose SDK appends its own `/v1` (Anthropic Messages): a gateway URL pasted
   * with the `/v1` suffix every OpenAI-compatible relay documents would then answer 404, which
   * reads as a dead gateway or a bad model name rather than as a mistyped setting. false for the
   * chat-completions wire, where `/v1` is exactly what the endpoint lives under.
   */
  readonly refuseV1Suffix: boolean
}

/**
 * Refuses a base URL no request could succeed against. A user-typed value reaches here (step 14's
 * settings card), so this throws `ProviderInvalidArgumentError` — a configuration error to
 * present, not a crash.
 *
 * Any base path other than a refused `/v1` is left alone: a relay may live under any prefix.
 */
export function assertBaseUrl(
  providerId: ProviderId,
  baseURL: string,
  policy: BaseUrlPolicy,
): void {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new ProviderInvalidArgumentError(
      `provider ${providerId}: baseURL "${baseURL}" is not an absolute http(s) URL`,
    )
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ProviderInvalidArgumentError(
      `provider ${providerId}: baseURL "${baseURL}" is not an absolute http(s) URL`,
    )
  }
  // A query string or a fragment cannot survive the join both SDKs perform: the endpoint's path is
  // appended to the whole string, so `…/v1?tenant=a` sends the request to `/v1` with
  // `?tenant=a/chat/completions` as its query, and `…/v1#frag` never leaves the fragment. Both
  // reach a URL nobody asked for and answer 404, which reads as a dead gateway rather than as a
  // setting with something extra on the end. Refused here, where it is a configuration error to
  // present. (A base PATH is left alone — a relay may live under any prefix.)
  if (url.search !== '' || url.hash !== '') {
    throw new ProviderInvalidArgumentError(
      `provider ${providerId}: baseURL "${baseURL}" carries a query string or a fragment; ${policy.wire} appends its path to it, so the request would not reach the endpoint`,
    )
  }
  if (!policy.refuseV1Suffix) return
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  if (segments.at(-1) === 'v1') {
    throw new ProviderInvalidArgumentError(
      `provider ${providerId}: baseURL "${baseURL}" already ends in /v1, and ${policy.wire} appends its own; drop the suffix`,
    )
  }
}

/** The one host where the vendor's own limits are known (spec 02, 01 修补 4; decision A5). */
export const ANTHROPIC_OFFICIAL_HOST = 'api.anthropic.com'

/**
 * How long the byte-level watchdog waits for the next byte (01 修补 4): 180 s on the official
 * endpoint, 300 s everywhere else — the latter is Tenon's own value, to be calibrated by 02 plan
 * step 7's live measurement.
 */
export const IDLE_MS_OFFICIAL = 180_000
export const IDLE_MS_OTHER = 300_000

/** The idle limit for a provider whose requests go to `baseURL`. */
export function idleMsFor(baseURL: string): number {
  return hostOf(baseURL) === ANTHROPIC_OFFICIAL_HOST ? IDLE_MS_OFFICIAL : IDLE_MS_OTHER
}

/**
 * The first-byte limit handed to the SDK as a per-request `timeout` (01 修补 4): only for the
 * official Anthropic endpoint, 180 s plus one second per started 32 KiB of request body. Null
 * everywhere else, and on the resend right after a first-byte timeout (`firstByteTimeout: false`):
 * the SDK's own ten-minute default then stands.
 */
export function firstByteTimeoutMs(
  baseURL: string,
  body: unknown,
  firstByteTimeout: boolean | undefined,
): number | null {
  if (firstByteTimeout === false || hostOf(baseURL) !== ANTHROPIC_OFFICIAL_HOST) return null
  const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength
  return 180_000 + Math.ceil(bodyBytes / 32_768) * 1000
}

function hostOf(baseURL: string): string | null {
  try {
    return new URL(baseURL).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * The byte-level idle watchdog ran out (01 修补 4): no byte of the response body, not even a ping,
 * arrived for `idleMs`. Both adapters map it to `error{ code: 'network', retryable: true,
 * timeout: 'idle' }`; the caller's AbortSignal is never touched.
 */
export class StreamIdleTimeoutError extends Error {
  readonly idleMs: number

  constructor(idleMs: number) {
    super(`no byte of the response arrived for ${idleMs} ms`)
    this.name = 'StreamIdleTimeoutError'
    this.idleMs = idleMs
  }
}

/** fetchThroughHost()'s fourth parameter: arm the idle watchdog on the response body. */
export interface IdleWatchdog {
  readonly clock: Pick<HostClock, 'setTimeout'>
  readonly idleMs: number
}

/**
 * The host's `fetch`, with an egress denial rewrapped so an SDK cannot lose it. Every byte either
 * adapter sends goes through here (invariant 8).
 *
 * With a `watchdog` (spec 02, 01 修补 4) the timer starts when the response headers arrive, is reset
 * by every chunk of the body, and is torn down when the body is read to the end, cancelled or
 * fails. When it fires, the underlying body is cancelled and the body the caller reads fails with
 * StreamIdleTimeoutError.
 */
export async function fetchThroughHost(
  network: HostNetwork,
  input: string | URL | Request,
  init: RequestInit | undefined,
  watchdog?: IdleWatchdog,
): Promise<Response> {
  let response: Response
  try {
    response = await network.fetch(input, init)
  } catch (error) {
    if (error instanceof HostNetworkDeniedError) throw new EgressDeniedError(error)
    throw error
  }
  if (watchdog === undefined || response.body === null) return response
  return new Response(watchedBody(response.body, watchdog), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function watchedBody(
  body: ReadableStream<Uint8Array>,
  watchdog: IdleWatchdog,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let cancelTimer: (() => void) | null = null
  let settled = false
  const disarm = (): void => {
    cancelTimer?.()
    cancelTimer = null
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const arm = (): void => {
        disarm()
        cancelTimer = watchdog.clock.setTimeout(() => {
          cancelTimer = null
          if (settled) return
          settled = true
          const error = new StreamIdleTimeoutError(watchdog.idleMs)
          // The failure the caller sees is ours; the cancel only releases the socket.
          reader.cancel(error).catch(() => undefined)
          controller.error(error)
        }, watchdog.idleMs)
      }
      arm()
      const pump = async (): Promise<void> => {
        for (;;) {
          let step: ReadableStreamReadResult<Uint8Array>
          try {
            // oxlint-disable-next-line no-await-in-loop -- a body is read chunk by chunk
            step = await reader.read()
          } catch (error) {
            if (settled) return
            settled = true
            disarm()
            controller.error(error)
            return
          }
          if (settled) return
          if (step.done) {
            settled = true
            disarm()
            controller.close()
            return
          }
          arm()
          controller.enqueue(step.value)
        }
      }
      void pump()
    },
    cancel(reason) {
      settled = true
      disarm()
      return reader.cancel(reason)
    },
  })
}

/**
 * What the request-header allowlist lets out (spec 02, 01 修补 4; decision A6): exact names, name
 * prefixes (the `x-stainless-*` group, let through until phase 6), and the protocol headers whose
 * value is fixed — re-set to that value whatever the SDK merged in, because `*_CUSTOM_HEADERS` env
 * lines can replace the value of an allowed header, not only add a name (02 plan step 3, checks 3
 * and 5). The kernel decides `anthropic-beta` itself; 02's list is empty, so it is not allowed.
 */
export interface HeaderAllowList {
  readonly names: readonly string[]
  readonly prefixes: readonly string[]
  readonly pinned: Readonly<Record<string, string>>
}

/**
 * The request as it may leave: every header outside `allow` stripped, every pinned header set to
 * its pinned value. Header names compare lowercased. The search backends (02 §搜索与抓取) call this
 * too before they touch `network.fetch`.
 */
export function allowedRequestInit(
  init: RequestInit | undefined,
  allow: HeaderAllowList,
): RequestInit {
  const incoming = new Headers(init?.headers)
  const out = new Headers()
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (Object.hasOwn(allow.pinned, lower)) return
    if (allow.names.includes(lower) || allow.prefixes.some((prefix) => lower.startsWith(prefix))) {
      out.set(lower, value)
    }
  })
  for (const [name, value] of Object.entries(allow.pinned)) out.set(name, value)
  return { ...init, headers: out }
}

/**
 * Invariant 6: empty arguments are `{}`. Null when the fragments do not form a JSON object, which
 * is a truncated or garbled body rather than an empty call — coercing it to `{}` would invent an
 * empty argument set for a call that had one. What each adapter then DOES with a null differs,
 * because the two wires prove different things about completeness (see their call sites).
 */
export function parseToolArguments(json: string): Record<string, unknown> | null {
  // Neither wire sends any argument fragment at all for a call with no arguments.
  if (json.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** The token count a wire stated, or null when it stated nothing usable. */
export function tokenCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
