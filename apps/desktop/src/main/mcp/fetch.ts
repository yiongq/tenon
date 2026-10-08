import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { fetch as undiciFetch } from 'undici'
import type { RequestInit as UndiciInit } from 'undici'
import { HostNetworkDeniedError, isBlockedFetchAddress } from '@tenon-app/kernel'
import type { FetchLike, HostNetwork } from '@tenon-app/kernel'
import type { UntrustedNetworkSeams, FetchAddress } from '../host/fetch-untrusted.js'
import { endpointOf } from '../endpoint.js'
import { abortable, createPinnedDispatcher } from '../host/fetch-untrusted.js'
import { mcpAddress } from './address.js'
export function createMcpFetch(
  serverUrl: string,
  network: HostNetwork,
  seams: UntrustedNetworkSeams = {},
): FetchLike {
  const server = new URL(serverUrl)
  return async (input, init) => {
    const request = new Request(input, init)
    const target = new URL(request.url)
    if (!mcpAddress(target.href).ok) throw new HostNetworkDeniedError('Unsafe MCP URL')
    const originReach = endpointOf(server.href)?.reach
    const reach = endpointOf(target.href)?.reach
    if (
      (reach === 'loopback' && originReach !== 'loopback') ||
      (reach === 'private' && originReach === 'public')
    )
      throw new HostNetworkDeniedError('Protected MCP discovery address')
    if (target.origin === server.origin || originReach !== 'public')
      return network.fetch(request, { redirect: 'manual' })
    const hostname = target.hostname.replace(/^\[|\]$/g, '')
    const addresses: readonly FetchAddress[] = await abortable(
      seams.lookup?.(hostname) ??
        dnsLookup(hostname, { all: true, verbatim: true }).then((rows) =>
          rows.map((r) => ({ address: r.address, family: r.family as 4 | 6 })),
        ),
      request.signal,
    )
    request.signal.throwIfAborted()
    if (
      !addresses.length ||
      addresses.some((a) => isIP(a.address) !== a.family || isBlockedFetchAddress(a.address))
    )
      throw new HostNetworkDeniedError('Protected MCP discovery DNS')
    const checked = seams.connectTarget?.(addresses[0]!) ?? addresses[0]!
    const dispatcher = createPinnedDispatcher(hostname, checked, request.signal)
    try {
      const response = await undiciFetch(target, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        redirect: 'manual',
        ...(request.body ? { duplex: 'half' } : {}),
        dispatcher,
      } as unknown as UndiciInit)
      void dispatcher.close().catch(() => {})
      return response
    } catch (error) {
      await dispatcher.destroy()
      throw error
    }
  }
}
