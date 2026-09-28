import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Socket } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import { HostNetworkDeniedError, isBlockedFetchAddress } from '@tenon-app/kernel'
import type { FetchLike } from '@tenon-app/kernel'
import { Agent, buildConnector, fetch as undiciFetch } from 'undici'

export interface FetchAddress {
  readonly address: string
  readonly family: 4 | 6
}

/** Only tests inject these; the desktop host factory passes no seams (spec 02 §本机抓取器). */
export interface UntrustedNetworkSeams {
  readonly lookup?: (hostname: string) => Promise<readonly FetchAddress[]>
  /** Maps an already checked address onto a local test server, without changing HTTP/TLS identity. */
  readonly connectTarget?: (address: FetchAddress) => FetchAddress
}

const lookup = async (hostname: string): Promise<readonly FetchAddress[]> => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses.map(({ address, family }) => {
    if (family !== 4 && family !== 6) throw new HostNetworkDeniedError('Invalid DNS address family')
    return { address, family }
  })
}

/** DNS itself cannot be cancelled, but an aborted lookup must never progress to a socket. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (signal === undefined || signal === null) return pending
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    void pending.then(
      (result) => {
        signal.removeEventListener('abort', aborted)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      },
    )
  })
}

/**
 * One untrusted GET. Each invocation resolves once, checks every answer and creates a fresh agent
 * pinned to one checked address: neither DNS rebinding nor pooled sockets bypass that check. The
 * URL still supplies HTTP Host; TLS SNI and certificate verification retain the original hostname.
 * No caller headers, method, body, credentials or redirect policy enter this path. There is no
 * transport timeout: the caller's signal governs DNS, connection and response body consumption.
 */
export function createUntrustedFetch(seams: UntrustedNetworkSeams = {}): FetchLike {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const hostname = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      (isIP(hostname) === 0 && !hostname.includes('.')) ||
      (isIP(hostname) !== 0 && isBlockedFetchAddress(hostname))
    ) {
      throw new HostNetworkDeniedError('Untrusted URL is protected')
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    signal?.throwIfAborted()
    const addresses = await abortable((seams.lookup ?? lookup)(hostname), signal)
    signal?.throwIfAborted()
    if (
      addresses.length === 0 ||
      addresses.some(
        ({ address, family }) => isIP(address) !== family || isBlockedFetchAddress(address),
      )
    ) {
      throw new HostNetworkDeniedError('Untrusted DNS address is protected')
    }
    const checked = addresses[0] as FetchAddress
    const target = seams.connectTarget?.(checked) ?? checked
    signal?.throwIfAborted()
    const connect = buildConnector({
      timeout: 0,
      rejectUnauthorized: true,
      // Even a caller's IP-literal URL is checked against that IP, never against a test seam target.
      checkServerIdentity: (_server, certificate) => checkServerIdentity(hostname, certificate),
    })
    const dispatcher = new Agent({
      headersTimeout: 0,
      bodyTimeout: 0,
      connect: (options, callback) => {
        // undici 7.29.1 returns this socket, although its connector declaration says void. Before
        // the handshake completes Client has no HTTPContext, so Agent.destroy() cannot reach it.
        const socket = connect(
          {
            ...options,
            hostname: target.address,
            servername: isIP(hostname) === 0 ? hostname : '',
          },
          callback,
        ) as unknown as Socket
        if (signal !== undefined && signal !== null) {
          const abort = (): void => {
            socket.destroy(
              signal.reason instanceof Error ? signal.reason : new Error('Untrusted fetch aborted'),
            )
          }
          signal.addEventListener('abort', abort, { once: true })
          socket.once('close', () => signal.removeEventListener('abort', abort))
          if (signal.aborted) abort()
        }
      },
    })
    try {
      const response = await undiciFetch(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        ...(signal === undefined ? {} : { signal }),
        dispatcher,
      })
      // Graceful close waits for this response body to finish or be cancelled, then drops its socket.
      void dispatcher.close().catch(() => undefined)
      return response
    } catch (error) {
      await dispatcher.destroy()
      throw error
    }
  }
}
