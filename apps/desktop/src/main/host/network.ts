import type { HostNetwork } from '@tenon-app/kernel'

/**
 * The desktop egress: the platform's own fetch, one hop. Phase 4's egress narrowing and
 * 6b's allow-list live here (a refusal rejects with HostNetworkDeniedError), never in the
 * kernel, and never as a `globalThis.fetch ?? …` fallback inside a provider.
 */
export function createDesktopNetwork(): HostNetwork {
  return { fetch: (input, init) => globalThis.fetch(input, init) }
}
