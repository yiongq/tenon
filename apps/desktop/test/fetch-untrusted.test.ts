/** DNS pinning, redirect isolation, credentials and cancellation: real sockets, no external network. */
import { readFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import tls from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { HostNetworkDeniedError } from '@tenon-app/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchAddress } from '../src/main/host/fetch-untrusted.js'
import { createDesktopNetwork } from '../src/main/host/network.js'
import { closeServer, listen, serveUntrusted } from './support/untrusted-server.js'

const PUBLIC: FetchAddress = { address: '93.184.216.34', family: 4 }
const LOOPBACK: FetchAddress = { address: '127.0.0.1', family: 4 }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- release servers one at a time
    await close()
  }
})

async function server(reply?: Parameters<typeof serveUntrusted>[0]) {
  const served = await serveUntrusted(reply)
  cleanup.push(served.close)
  return served
}

const seams = () => ({
  lookup: vi.fn<() => Promise<FetchAddress[]>>(async () => [PUBLIC]),
  connectTarget: vi.fn<() => FetchAddress>(() => LOOPBACK),
})

describe('fetchUntrusted checks DNS once, then pins that call’s connection', () => {
  it('returns a 302 and Location unchanged; never follows init or Request redirect preferences', async () => {
    const target = await server()
    const source = await server((_req, res) => {
      res.writeHead(302, { location: `${target.url}/secret`, 'set-cookie': 'session=secret' })
      res.end('moved')
    })
    const seam = seams()
    const network = createDesktopNetwork(seam)
    const request = new Request(source.publicUrl, {
      method: 'POST',
      body: 'must not leave',
      redirect: 'follow',
      credentials: 'include',
      headers: {
        cookie: 'secret',
        authorization: 'Bearer secret',
        'proxy-authorization': 'Basic secret',
        'x-api-key': 'secret',
        host: 'spoofed.example',
      },
    })
    const response = await network.fetchUntrusted(request, {
      redirect: 'follow',
      credentials: 'include',
      headers: { authorization: 'Bearer override' },
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${target.url}/secret`)
    expect(await response.text()).toBe('moved')
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(0)
    expect(source.requests[0]?.method).toBe('GET')
    expect(source.requests[0]?.headers).toMatchObject({
      host: `fetch.example:${String(source.port)}`,
    })
    for (const header of [
      'cookie',
      'authorization',
      'proxy-authorization',
      'x-api-key',
      'content-length',
    ]) {
      expect(source.requests[0]?.headers[header]).toBeUndefined()
    }
    expect(seam.lookup).toHaveBeenCalledExactlyOnceWith('fetch.example')
    expect(seam.connectTarget).toHaveBeenCalledExactlyOnceWith(PUBLIC)
  })

  it.each([
    [LOOPBACK],
    [PUBLIC, LOOPBACK],
    [PUBLIC, { address: '::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }, PUBLIC],
    [{ address: 'fe80::1234', family: 6 }],
    [{ address: 'fc00::1', family: 6 }],
    [{ address: '172.31.0.1', family: 4 }],
    [{ address: '169.254.1.1', family: 4 }],
    [{ address: '0.0.0.0', family: 4 }],
    [{ address: 'garbage', family: 4 }],
    [],
  ] as FetchAddress[][])(
    'denies the whole DNS answer when any address is protected: %j',
    async (...addresses) => {
      const seam = {
        ...seams(),
        lookup: vi.fn<() => Promise<FetchAddress[]>>(async () => addresses),
      }
      await expect(
        createDesktopNetwork(seam).fetchUntrusted('https://fetch.example'),
      ).rejects.toBeInstanceOf(HostNetworkDeniedError)
      expect(seam.lookup).toHaveBeenCalledTimes(1)
      expect(seam.connectTarget).not.toHaveBeenCalled()
    },
  )

  it('rechecks on every call even after a successful request; provider fetch still reaches loopback', async () => {
    const served = await server()
    const seam = seams()
    seam.lookup.mockResolvedValueOnce([PUBLIC]).mockResolvedValueOnce([LOOPBACK])
    const network = createDesktopNetwork(seam)
    expect(await (await network.fetchUntrusted(served.publicUrl)).text()).toBe('public page')
    await expect(network.fetchUntrusted(served.publicUrl)).rejects.toBeInstanceOf(
      HostNetworkDeniedError,
    )
    expect(seam.lookup).toHaveBeenCalledTimes(2)
    expect(seam.connectTarget).toHaveBeenCalledTimes(1)
    expect(served.requests).toHaveLength(1)
    expect(await (await network.fetch(served.url)).text()).toBe('public page')
    expect(seam.lookup).toHaveBeenCalledTimes(2)
    expect(served.requests).toHaveLength(2)
  })

  it('allows the explicitly deferred CGNAT range', async () => {
    const served = await server()
    const seam = seams()
    seam.lookup.mockResolvedValue([{ address: '100.64.0.1', family: 4 }])
    expect(await (await createDesktopNetwork(seam).fetchUntrusted(served.publicUrl)).text()).toBe(
      'public page',
    )
  })
})

describe('cancellation never turns a late DNS answer into a socket', () => {
  it('does no DNS work for a pre-aborted signal', async () => {
    const seam = seams()
    await expect(
      createDesktopNetwork(seam).fetchUntrusted('https://fetch.example', {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(seam.lookup).not.toHaveBeenCalled()
    expect(seam.connectTarget).not.toHaveBeenCalled()
  })

  it('rejects while DNS is pending, and ignores its eventual successful answer', async () => {
    let resolved!: (addresses: FetchAddress[]) => void
    const seam = {
      ...seams(),
      lookup: vi.fn<() => Promise<FetchAddress[]>>(
        () =>
          new Promise<FetchAddress[]>((resolve) => {
            resolved = resolve
          }),
      ),
    }
    const abort = new AbortController()
    const pending = createDesktopNetwork(seam).fetchUntrusted('https://fetch.example', {
      signal: abort.signal,
    })
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    resolved([PUBLIC])
    await Promise.resolve()
    expect(seam.connectTarget).not.toHaveBeenCalled()
  })

  it('does not connect when lookup synchronously aborts its caller', async () => {
    const abort = new AbortController()
    const seam = {
      ...seams(),
      lookup: async () => {
        abort.abort()
        return [PUBLIC]
      },
    }
    await expect(
      createDesktopNetwork(seam).fetchUntrusted('https://fetch.example', { signal: abort.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(seam.connectTarget).not.toHaveBeenCalled()
  })

  it('releases the pinned socket when a caller cancels an unread body', async () => {
    const served = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('body still open')
    })
    const response = await createDesktopNetwork(seams()).fetchUntrusted(served.publicUrl)
    await response.body?.cancel()
    await expect.poll(() => served.requests[0]?.socket.destroyed).toBe(true)
  })

  it('closes a socket aborted after ClientHello while the peer stalls the TLS handshake', async () => {
    const sockets = new Set<Socket>()
    let greeted!: (socket: Socket) => void
    const hello = new Promise<Socket>((resolve) => {
      greeted = resolve
    })
    // A TCP peer accepts TLS bytes but never sends ServerHello. The HTTP context does not exist yet.
    const tcp = createTcpServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', () => greeted(socket))
    })
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject)
      tcp.listen(0, '127.0.0.1', resolve)
    })
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => tcp.close(() => resolve()))
    })
    const port = (tcp.address() as AddressInfo).port
    const abort = new AbortController()
    const pending = createDesktopNetwork(seams()).fetchUntrusted(
      `https://fetch.example:${String(port)}`,
      { signal: abort.signal },
    )
    const peer = await hello
    const settled = Promise.allSettled([pending])
    abort.abort()
    expect((await settled)[0]).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } })
    // Before the fix fetch rejected but this socket stayed open indefinitely (connect timeout = 0).
    await expect.poll(() => peer.destroyed).toBe(true)
  })

  it('aborts both waiting response headers and an in-flight body', async () => {
    let arrived!: () => void
    const reached = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const served = await server((_req, _res) => arrived())
    const abort = new AbortController()
    const pending = createDesktopNetwork(seams()).fetchUntrusted(served.publicUrl, {
      signal: abort.signal,
    })
    await reached
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const body = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('first')
    })
    const bodyAbort = new AbortController()
    const response = await createDesktopNetwork(seams()).fetchUntrusted(body.publicUrl, {
      signal: bodyAbort.signal,
    })
    const reader = response.body?.getReader()
    expect((await reader?.read())?.done).toBe(false)
    bodyAbort.abort()
    await expect(reader?.read()).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('TLS keeps the original hostname after pinning the socket', () => {
  it('sends that SNI and validates its certificate; another hostname is rejected', async () => {
    // Public test-only key/certificate. Only this test’s real TLS connection trusts this CA.
    const cert = readFileSync(
      new URL('./support/fixtures/fetch-test-cert.pem', import.meta.url),
      'utf8',
    )
    const key = readFileSync(
      new URL('./support/fixtures/fetch-test-key.pem', import.meta.url),
      'utf8',
    )
    const names: string[] = []
    const https = createHttpsServer({ cert, key }, (req, res) => {
      names.push((req.socket as TLSSocket).servername || '')
      res.end('secure')
    })
    const port = await listen(https)
    cleanup.push(() => closeServer(https))
    const realConnect = tls.connect
    // The default builtin export is the same object as undici's require('node:tls'). Inject only
    // the test trust root; keep the real handshake, SNI and hostname verification (Node >=22.12).
    const connect = vi.spyOn(tls, 'connect').mockImplementation((...args) => {
      const options: unknown = args[0]
      if (typeof options !== 'object' || options === null)
        throw new Error('Expected undici TLS connection options')
      return realConnect({ ...options, ca: cert })
    })
    try {
      const network = createDesktopNetwork(seams())
      expect(
        await (await network.fetchUntrusted(`https://fetch.example:${String(port)}`)).text(),
      ).toBe('secure')
      expect(names).toEqual(['fetch.example'])
      await expect(
        network.fetchUntrusted(`https://wrong.example:${String(port)}`),
      ).rejects.toMatchObject({ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } })
      expect(names).toHaveLength(1)
    } finally {
      connect.mockRestore()
    }
  })
})
