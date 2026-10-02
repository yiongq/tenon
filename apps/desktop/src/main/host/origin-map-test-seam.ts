/**
 * The origin map test seam (M6 §点名「测试接缝」; 推出的读法 42; M6 不变量 19): a development build
 * started by the e2e launcher can send what goes to an official origin, or to a public-shaped host
 * like `https://vendor.e2e.test`, to a fake server on this machine — so the tests run against the
 * addresses the product accepts, now that zhipu and anthropic take their official origin only.
 *
 *   - Read only when the build is not packaged, `TENON_DEV_ENV=off` (which only the test launcher
 *     sets, e2e/helpers/app-env.ts) and `TENON_TEST_ORIGIN_MAP` is set, both in the environment
 *     Tenon was started with: main hands over its snapshot from before `loadDevEnv`, so neither
 *     `pnpm dev` nor `.env.local` can turn it on. A packaged build never reads the variable at all.
 *   - The secrets must be the in-memory store (`TENON_SECRETS=memory`, which the test launcher sets
 *     too): the OS keychain is shared by every profile, so with it the developer's own official
 *     Anthropic key would go to the fake — the redirect 02 M4 forbids, and one the launcher's
 *     environment check cannot see. Map set without it, main refuses to start.
 *   - `<https origin>=<http://127.0.0.1:port>` pairs, comma-separated: a left side that is not an
 *     https origin, or a right side that is not `http://127.0.0.1:<port>` / `http://[::1]:<port>`,
 *     refuses the start (main exits) rather than sending anywhere else.
 *   - Only the transport moves: `host.network.fetch` rewrites a listed origin, keeping the path and
 *     the query. The official-origin rule, `reachOf`, the key binding and A9 all read the URL as
 *     configured, before the rewrite; `fetchUntrusted` (WebFetch's egress) is never rewritten.
 *   - The variable never reaches a command (`TENON_*`, host/shell-env.ts:39), is never inherited by
 *     a launched app (NEVER_INHERITED), and the live suite refuses to run when it sees it.
 *
 * Same shape of switch as official-protocol-test-seam.ts.
 */
import type { FetchLike, HostNetwork } from '@tenon-app/kernel'

export const ORIGIN_MAP_ENV = 'TENON_TEST_ORIGIN_MAP'

/** A public https origin → the loopback origin of the fake server standing in for it. */
export type OriginMap = ReadonlyMap<string, string>

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]'])

/**
 * `host.network` with the map applied when the seam is on, or `network` itself. Throws for a value
 * that is not a valid map, or for a map beside any secrets store but the in-memory one, which
 * refuses the start. No environment property is read once packaged.
 */
export function originMapTestNetwork(
  network: HostNetwork,
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): HostNetwork {
  if (isPackaged) return network
  if (env['TENON_DEV_ENV'] !== 'off') return network
  const value = env[ORIGIN_MAP_ENV]
  if (value === undefined) return network
  // With TENON_DEV_ENV=off main skips `loadDevEnv`, so this agrees with the store
  // `useMemorySecrets` picks from process.env (host/index.ts).
  if (env['TENON_SECRETS'] !== 'memory') {
    throw new Error(
      `${ORIGIN_MAP_ENV} needs TENON_SECRETS=memory: the keychain is shared by every profile, and ` +
        'its official Anthropic key would go to this machine (M6 §点名「测试接缝」, 02 M4)',
    )
  }
  return redirectOrigins(network, parseOriginMap(value))
}

/**
 * The map in `TENON_TEST_ORIGIN_MAP`: every pair `<https origin>=<loopback origin>`, comma
 * separated. Throws naming the pair at fault; an empty value, or an origin given twice, is no map
 * either.
 */
export function parseOriginMap(value: string): OriginMap {
  const map = new Map<string, string>()
  for (const pair of value.split(',')) {
    const at = pair.indexOf('=')
    if (at < 0) throw new Error(`${ORIGIN_MAP_ENV}: "${pair}" is not <https origin>=<loopback>`)
    const from = originIn(pair.slice(0, at).trim())
    const to = originIn(pair.slice(at + 1).trim())
    if (from === null || from.protocol !== 'https:') {
      throw new Error(`${ORIGIN_MAP_ENV}: the left side of "${pair}" is not an https origin`)
    }
    if (
      to === null ||
      to.protocol !== 'http:' ||
      !LOOPBACK_HOSTS.has(to.hostname) ||
      to.port === ''
    ) {
      throw new Error(
        `${ORIGIN_MAP_ENV}: the right side of "${pair}" is not http://127.0.0.1:<port> or ` +
          'http://[::1]:<port>',
      )
    }
    if (map.has(from.origin)) throw new Error(`${ORIGIN_MAP_ENV}: ${from.origin} is mapped twice`)
    map.set(from.origin, to.origin)
  }
  return map
}

/**
 * `network` whose `fetch` sends a request for a mapped origin to its loopback stand-in, path and
 * query kept; every other request, and `fetchUntrusted`, untouched. Also the eval host's network in
 * its offline tests (evals/host.ts), so both rewrite the same way.
 */
export function redirectOrigins(network: HostNetwork, map: OriginMap): HostNetwork {
  const fetch: FetchLike = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const to = map.get(url.origin)
    if (to === undefined) return network.fetch(input, init)
    const target = `${to}${url.pathname}${url.search}`
    return input instanceof Request
      ? network.fetch(target, { ...requestFields(input), ...init })
      : network.fetch(target, init)
  }
  return { ...network, fetch }
}

/**
 * A URL that is an origin and nothing more — no userinfo, path, query or fragment; a trailing slash
 * is allowed — or null.
 */
function originIn(text: string): URL | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  return text === url.origin || text === `${url.origin}/` ? url : null
}

/** A Request's fields as init, the way the desktop network takes one (network.ts). */
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
