import type { FetchLike, HostNetwork } from '@tenon-app/kernel'
import { Agent, fetch as undiciFetch } from 'undici'
import type { RequestInit as UndiciRequestInit } from 'undici'

/**
 * undici's own time limits on the desktop egress, both off (spec 02, 01 修补 4 and 01 修补 9 (w);
 * owner 2026-09-27). undici waits 300 s for the response headers and 300 s between two body chunks
 * by default, which would cut underneath the kernel: the resend with `firstByteTimeout: false`, the
 * SDK's ten-minute default on every non-official endpoint and the idle watchdog's threshold. With
 * both at 0 the kernel's first-byte limit and idle watchdog are the only ones.
 */
const NO_TRANSPORT_LIMITS = { headersTimeout: 0, bodyTimeout: 0 } as const

/**
 * The desktop egress: undici's own `fetch`, one hop, through a dispatcher with the limits above.
 * undici's own rather than `globalThis.fetch` plus a dispatcher: a dispatcher belongs to the undici
 * that made it, and the platform's differs (Electron 44 bundles 7.29.1, the version pinned here;
 * Node 22, which runs the unit tests, bundles 6). Phase 4's egress narrowing and 6b's allow-list
 * live here (a refusal rejects with HostNetworkDeniedError), never in the kernel, and never as a
 * `globalThis.fetch ?? …` fallback inside a provider.
 */
export function createDesktopNetwork(): HostNetwork {
  const dispatcher = new Agent(NO_TRANSPORT_LIMITS)
  const fetch: FetchLike = (input, init) => {
    const [target, fields] =
      input instanceof Request ? [input.url, { ...requestFields(input), ...init }] : [input, init]
    // The platform's RequestInit is undici's own shape, typed by an older copy of undici's types
    // (@types/node's undici-types), whose FormData the compiler will not match to this one's.
    return undiciFetch(target, { ...fields, dispatcher } as UndiciRequestInit)
  }
  return { fetch }
}

/**
 * A Request made by the platform's fetch is another undici's class, which this one would read as
 * the string "[object Request]"; its fields go over as init instead. The caller's init still wins,
 * as in `fetch(request, init)`.
 */
function requestFields(request: Request): RequestInit & { duplex?: 'half' } {
  return {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: request.redirect,
    signal: request.signal,
    ...(request.body === null ? {} : { duplex: 'half' }),
  }
}
