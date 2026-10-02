/**
 * A host network for the unit tests that talk to a `node:http` fake (M6 §点名「测试接缝」): the
 * platform's fetch, with every official origin in `to` sent to the fake server standing in for it
 * through the same function as the e2e origin map (`redirectOrigins`). The providers keep their
 * official addresses — another base URL now reads as not configured — and so does everything judged
 * on them: the official-origin rule, the key binding, `reachOf` (M6 不变量 19).
 */
import { createMemoryHost } from '@tenon-app/kernel'
import type { HostNetwork } from '@tenon-app/kernel'
import { parseOriginMap, redirectOrigins } from '../../src/main/host/origin-map-test-seam.js'

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com'
export const ZHIPU_ORIGIN = 'https://open.bigmodel.cn'

/** `to`: an https origin → the fake's base URL (its origin is what the map takes). */
export function seamNetwork(to: Readonly<Record<string, string>> = {}): HostNetwork {
  const network: HostNetwork = {
    fetchUntrusted: createMemoryHost().network.fetchUntrusted,
    fetch: (input, init) => globalThis.fetch(input, init),
  }
  const pairs = Object.entries(to).map(([from, url]) => `${from}=${new URL(url).origin}`)
  return pairs.length === 0 ? network : redirectOrigins(network, parseOriginMap(pairs.join(',')))
}
