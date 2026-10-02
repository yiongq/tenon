/**
 * A custom vendor's address (M6 §地址校验): the five rules a new instance's base URL passes, in
 * order, before anything is stored — the first one it fails is the code handed back, and neither the
 * keychain nor `config.json` is touched. The same rules judge an address already in `config.json`
 * (§存储): one a hand edit or an older file left failing is kept but reads as not configured.
 *
 * The rules live here and not in the kernel: `assertBaseUrl` (transport.ts:54-90) is unchanged and
 * still runs when an instance builds its client. Loopback and private are read by spelling, never
 * through DNS (Q7; `reachOf`).
 */
import { endpointOf } from '../endpoint.js'

export type CustomWire = 'openai-chat' | 'anthropic-messages'

/** §地址校验's codes, which are also `providerRefusalSchema`'s for an instance (§存储). */
export type AddressRefusalCode = 'invalid-address' | 'https-required' | 'subscription-endpoint'

/** `baseURL` is the address as stored: `new URL(input).href` without its trailing slash. */
export type AddressCheck =
  | { readonly ok: true; readonly baseURL: string }
  | { readonly ok: false; readonly code: AddressRefusalCode }

/**
 * Zhipu's GLM Coding Plan path (Q13; docs.bigmodel.cn/cn/coding-plan/tool/others,
 * docs.z.ai/devpack/tool/others): a subscription that must not be called from Tenon. Other vendors'
 * subscription addresses are not refused in the first version (Q15).
 */
export const SUBSCRIPTION_PATH = '/api/coding/paas/v4'

/**
 * §地址校验 rules 1–5, in the table's order. The rules read the parsed URL — so a tab or a newline
 * the parser drops cannot hide a path — except rule 3's `?` and `#`, which read the string as typed
 * (推出的读法 40): an empty query or fragment leaves no trace on the parsed URL.
 */
export function checkAddress(input: string, wire: CustomWire): AddressCheck {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return refused('invalid-address')
  }
  // Rule 1: http(s) only (the kernel refuses anything else too, transport.ts:54-75).
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return refused('invalid-address')
  const endpoint = endpointOf(url.href)
  if (endpoint === null) return refused('invalid-address')
  // Rule 2 (A9): plain http only to this machine or a private network.
  if (url.protocol === 'http:' && endpoint.reach === 'public') return refused('https-required')
  // Rule 3 (A9): no credentials in the address, and nothing the SDKs' path join would misplace.
  if (url.username !== '' || url.password !== '') return refused('invalid-address')
  if (input.includes('?') || input.includes('#')) return refused('invalid-address')
  // Rule 4 (Q13).
  if (isSubscriptionPath(url.pathname)) return refused('subscription-endpoint')
  // Rule 5 (transport.ts:83-88): the Anthropic SDK appends its own `/v1`.
  if (wire === 'anthropic-messages' && decodedSegments(url.pathname).at(-1) === 'v1') {
    return refused('invalid-address')
  }
  return { ok: true, baseURL: url.href.replace(/\/+$/, '') }
}

/**
 * Rule 4's match (§地址校验; 推出的读法 40): the path decoded segment by segment, lowercased, with
 * repeated and trailing slashes removed, contains `SUBSCRIPTION_PATH`. A segment's `%2F` decodes to a
 * slash and so takes part in the match. Also the rule for zhipu's own address (§点名 (b), (e)).
 */
export function isSubscriptionPath(pathname: string): boolean {
  const path = `/${decodedSegments(pathname).join('/')}`.toLowerCase().replace(/\/{2,}/g, '/')
  return path.replace(/\/+$/, '').includes(SUBSCRIPTION_PATH)
}

/** The path's non-empty segments, each percent-decoded once (left as is when it does not decode). */
function decodedSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
}

function refused(code: AddressRefusalCode): AddressCheck {
  return { ok: false, code }
}
