/**
 * Where a base URL points (spec 02 §模型选择「数据去向」; A9): its host, and whether that host is this
 * machine, a private network, or the public internet. Only `loopback` reads as 「本机」 in the menu;
 * `loopback` and `private` together are the local side a switch to a `public` host must confirm.
 *
 * Read from the URL alone — no DNS (the kernel does none either): a name that resolves to a private
 * address still reads by its spelling. Private: the IPv4 private and link-local ranges and the
 * carrier-grade NAT block, IPv6 unique-local and link-local, a name with no dot, and the `.local`,
 * `.lan`, `.internal` and `.home.arpa` suffixes (暂定, plan step 19).
 *
 * Every spelling of this machine reads as loopback, not only `localhost` and 127/8: the unspecified
 * addresses 0.0.0.0/8 and `::` (a connection to them reaches this machine; `OLLAMA_HOST=0.0.0.0`
 * is a common copy), and IPv4-mapped IPv6 (`::ffff:a.b.c.d`) reads as its IPv4 address. A trailing
 * dot is the same host fully qualified, and is dropped before anything compares it.
 */

export type Reach = 'loopback' | 'private' | 'public'

export interface Endpoint {
  readonly host: string
  readonly reach: Reach
}

/**
 * The host of a URL, lowercase, without IPv6 brackets and without the trailing dot of a fully
 * qualified name (`ollama.com.` is `ollama.com`); null for what is not a URL.
 */
export function hostOf(url: string | undefined): string | null {
  if (url === undefined || url.trim() === '') return null
  try {
    const host = new URL(url).hostname
      .toLowerCase()
      .replace(/^\[(.*)\]$/, '$1')
      .replace(/\.+$/, '')
    return host === '' ? null : host
  } catch {
    return null
  }
}

/** `URL.origin` — scheme, host and port — or null for what is not a URL. */
export function originOf(url: string | undefined): string | null {
  if (url === undefined || url.trim() === '') return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function endpointOf(url: string | undefined): Endpoint | null {
  const host = hostOf(url)
  return host === null ? null : { host, reach: reachOf(host) }
}

const PRIVATE_SUFFIXES = ['.local', '.lan', '.internal', '.home.arpa']

export function reachOf(spelled: string): Reach {
  const host = spelled.replace(/\.+$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback'
  if (host === '::1' || host === '::') return 'loopback'
  const v4 = ipv4(host) ?? mappedIpv4(host)
  if (v4 !== null) {
    const [a = 0, b = 0] = v4
    if (a === 127 || a === 0) return 'loopback'
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private'
    if (a === 169 && b === 254) return 'private'
    if (a === 100 && b >= 64 && b <= 127) return 'private'
    return 'public'
  }
  if (host.includes(':')) {
    // IPv6: unique-local fc00::/7 and link-local fe80::/10; everything else routes publicly.
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return 'private'
    return 'public'
  }
  if (!host.includes('.')) return 'private'
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'private'
  return 'public'
}

/** `::ffff:a.b.c.d` as the URL parser writes it (`::ffff:7f00:1`): the IPv4 address it carries. */
function mappedIpv4(host: string): number[] | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (match === null) return null
  const high = Number.parseInt(match[1] ?? '', 16)
  const low = Number.parseInt(match[2] ?? '', 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

function ipv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  return numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? numbers : null
}
