/**
 * What the two SDK-backed adapter halves share: the single seam through which bytes leave the
 * kernel, the checks that decide whether a client may be built at all, and the two decode helpers
 * whose reading must not diverge between wires.
 *
 * The encoders' shared helpers live in ./shared.ts, which is pure. This file is where the host's
 * `fetch` is touched — and nowhere else in the provider layer.
 */
import type { HostNetwork } from '../../host/adapter.js'
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

/**
 * The host's `fetch`, with an egress denial rewrapped so an SDK cannot lose it. Every byte either
 * adapter sends goes through here (invariant 8).
 */
export async function fetchThroughHost(
  network: HostNetwork,
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<Response> {
  try {
    return await network.fetch(input, init)
  } catch (error) {
    if (error instanceof HostNetworkDeniedError) throw new EgressDeniedError(error)
    throw error
  }
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
