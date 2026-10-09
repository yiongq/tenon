// Real local listeners, files and child processes verify the privileged boundary.
// oxlint-disable no-await-in-loop
import * as files from 'node:fs/promises'
import { mkdtemp, writeFile, chmod, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:https'
import { createServer as createTcpServer, createConnection } from 'node:net'
import { mcpLoginErrorSchema } from '@tenon-app/contracts'
import { createI18n } from '../src/i18n/create-instance.js'
import type { Socket, AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import tls from 'node:tls'
import http from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost, connectStdioServer } from '@tenon-app/kernel'
import { createHostProcess } from '../src/main/host/process.js'
import { createMcpLogSink } from '../src/main/mcp/log-sink.js'
import { resolveMcpCommand } from '../src/main/mcp/resolve-command.js'
import { createMcpFetch } from '../src/main/mcp/fetch.js'
import { listenMcpCallback, usesMcpCallbackTestPort } from '../src/main/mcp/loopback.js'
import { createMcpOpenUrl } from '../src/main/mcp/open-url.js'
import { listen, closeServer } from './support/untrusted-server.js'
vi.mock('node:fs/promises', { spy: true })
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(cleanup.splice(0).map((f) => f()))
})
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-mcp-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}
it('03 验收 4: log rotation keeps three files and reads only the final 64 KiB', async () => {
  const dir = await directory()
  const sink = createMcpLogSink({ ...createMemoryHost().identity, profileDir: dir })
  for (const ch of ['a', 'b', 'c', 'd']) await sink.append('notes', ch.repeat(700_000))
  await sink.close()
  expect((await readdir(join(dir, 'logs'))).toSorted()).toEqual([
    'mcp-notes.log',
    'mcp-notes.log.1',
    'mcp-notes.log.2',
  ])
  expect((await readFile(join(dir, 'logs/mcp-notes.log.2'), 'utf8'))[0]).toBe('b')
  expect(await sink.read('notes')).toEqual({ text: 'd'.repeat(65535) + '\n', truncated: true })
})
it('03 验收 8: PATH is resolved on each spawn; absolute, missing and Windows script cases', async () => {
  const a = await directory(),
    b = await directory()
  for (const dir of [a, b]) {
    await writeFile(join(dir, 'fixture'), '')
    await chmod(join(dir, 'fixture'), 0o755)
  }
  expect(await resolveMcpCommand('fixture', a)).toEqual({ ok: true, path: join(a, 'fixture') })
  expect(await resolveMcpCommand('fixture', b)).toEqual({ ok: true, path: join(b, 'fixture') })
  expect(await resolveMcpCommand('/missing/absolute', '')).toEqual({
    ok: true,
    path: '/missing/absolute',
  })
  expect(await resolveMcpCommand('missing', a)).toEqual({ ok: false, code: 'command-not-found' })
  expect(await resolveMcpCommand('C:\\fixture.cmd', '', 'win32')).toEqual({
    ok: false,
    code: 'windows-unsupported',
  })
})
it('03 验收 10 (fetch): reach checks refuse protected URLs without making requests; same-origin skips DNS', async () => {
  const closed = createTcpServer()
  await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done))
  const closedPort = (closed.address() as AddressInfo).port
  await new Promise<void>((done) => closed.close(() => done()))
  const host = createMemoryHost(),
    fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('', { status: 302, headers: { location: 'https://other.example' } }),
    )
  const lookup = vi.fn<() => Promise<{ address: string; family: 4 }[]>>(async () => [
    { address: '93.184.216.34', family: 4 as const },
  ])
  const network = { ...host.network, fetch }
  for (const url of [
    'http://public.example',
    'https://127.0.0.1',
    'https://10.1.1.1',
    'https://169.254.169.254',
    'https://u:p@public.example',
  ]) {
    const target = new URL(url)
    target.port = String(closedPort)
    await expect(
      createMcpFetch('https://mcp.example', network, {
        lookup,
        connectTarget: () => ({ address: '127.0.0.1', family: 4 }),
      })(target),
    ).rejects.toThrow(/./)
  }
  expect(fetch).not.toHaveBeenCalled()
  expect(lookup).not.toHaveBeenCalled()
  expect(
    (await createMcpFetch('https://mcp.example', network, { lookup })('https://mcp.example/x'))
      .status,
  ).toBe(302)
  expect(lookup).not.toHaveBeenCalled()
  expect(fetch.mock.calls).toHaveLength(1)
  expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual')
  await createMcpFetch('http://127.0.0.1', network)('http://127.0.0.1/callback')
  await createMcpFetch('http://10.1.1.1', network)('http://10.2.1.1/token')
  await expect(createMcpFetch('http://10.1.1.1', network)('https://127.0.0.1')).rejects.toThrow(/./)
})
it('03 验收 10 (fetch, DNS): checks every answer before a socket; pins the checked target with method, headers, body and TLS identity', async () => {
  let requests = 0,
    body = '',
    identity = ''
  const server = createServer(
    {
      key: readFileSync(new URL('./support/fixtures/fetch-test-key.pem', import.meta.url)),
      cert: readFileSync(new URL('./support/fixtures/fetch-test-cert.pem', import.meta.url)),
    },
    (req, res) => {
      requests++
      identity = req.headers.host ?? ''
      expect(req.method).toBe('POST')
      expect(req.headers['x-fixture']).toBe('yes')
      req.on('data', (c) => {
        body += String(c)
      })
      req.on('end', () => {
        res.writeHead(302, { location: 'https://other.example' })
        res.end('reply')
      })
    },
  )
  const port = await listen(server)
  cleanup.push(() => closeServer(server))
  const realConnect = tls.connect
  vi.spyOn(tls, 'connect').mockImplementation((...args) =>
    realConnect({
      ...(args[0] as tls.ConnectionOptions),
      ca: readFileSync(new URL('./support/fixtures/fetch-test-cert.pem', import.meta.url)),
    }),
  )
  const url = `https://fetch.example:${port}/token`,
    publicAddress = { address: '93.184.216.34', family: 4 as const }
  const network = createMemoryHost().network,
    target = vi.fn<() => { address: string; family: 4 }>(() => ({
      address: '127.0.0.1',
      family: 4 as const,
    }))
  for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254'])
    await expect(
      createMcpFetch('https://mcp.example', network, {
        lookup: async () => [publicAddress, { address, family: 4 }],
        connectTarget: target,
      })(url),
    ).rejects.toThrow(/./)
  expect(requests).toBe(0)
  expect(target).not.toHaveBeenCalled()
  const response = await createMcpFetch('https://mcp.example', network, {
    lookup: async () => [publicAddress],
    connectTarget: target,
  })(url, { method: 'POST', headers: { 'x-fixture': 'yes' }, body: 'payload' })
  expect(response.status).toBe(302)
  expect(await response.text()).toBe('reply')
  expect(body).toBe('payload')
  expect(identity).toBe(`fetch.example:${port}`)
  expect(requests).toBe(1)
  expect(target).toHaveBeenCalledExactlyOnceWith(publicAddress)
})
it('03 验收 18: wrong state keeps waiting, correct state closes; busy port, timeout and cancellation close listeners', async () => {
  const binding = vi.spyOn(http.Server.prototype, 'listen')
  const listener = await listenMcpCallback(0)
  expect(binding.mock.calls[0]?.[1]).toBe('127.0.0.1')
  cleanup.push(() => listener.close())
  const waiting = listener.waitForCallback('right', 120_000)
  const url = `http://127.0.0.1:${listener.port}/callback`
  expect((await fetch(url + '?state=wrong')).status).toBe(400)
  await expect(listenMcpCallback(listener.port)).rejects.toMatchObject({ code: 'port-in-use' })
  const response = fetch(url + '?state=right&code=fixture')
  expect((await waiting).get('code')).toBe('fixture')
  await listener.close()
  listener.complete({ ok: true })
  expect((await response).status).toBe(200)
  await expect(fetch(url)).rejects.toThrow(/./)
  const slow = await listenMcpCallback(0)
  vi.useFakeTimers()
  const timed = slow.waitForCallback('right', 120_000)
  // oxlint-disable-next-line vitest/valid-expect -- attached before triggering rejection, awaited below
  const failure = expect(timed).rejects.toMatchObject({ code: 'timeout' })
  await vi.advanceTimersByTimeAsync(120_000)
  await failure
  vi.useRealTimers()
  await expect(fetch(`http://127.0.0.1:${slow.port}/callback`)).rejects.toThrow(/./)
  await slow.close()
  const cancelled = await listenMcpCallback(0)
  const pending = cancelled.waitForCallback('right', 120_000)
  // oxlint-disable-next-line vitest/valid-expect -- attached before triggering rejection, awaited below
  const stopped = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  await cancelled.close()
  await stopped
})
it('03 验收 19: unsafe URLs never reach shell; the direct seam requires development and an unpackaged app', async () => {
  const shell = vi.fn<(url: string) => Promise<void>>(async () => {}),
    net = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1:1234/callback?state=x' },
        }),
    )
  for (const q of [
    { isPackaged: true, env: { TENON_DEV_ENV: 'off', TENON_TEST_MCP_OPEN_URL: 'direct' } },
    { isPackaged: false, env: { TENON_TEST_MCP_OPEN_URL: 'direct' } },
  ]) {
    const open = createMcpOpenUrl({ ...q, openExternal: shell, fetch: net })
    for (const url of [
      'javascript:alert(1)',
      'data:text/plain,x',
      'file:///tmp/x',
      'vbscript:x',
      'http://public.example',
      'http://10.0.0.5',
      'http://printer.local',
      'http://intranet',
    ])
      await expect(open(new URL(url))).rejects.toMatchObject({ code: 'unsafe-url' })
    await open(new URL('https://public.example/login'))
  }
  expect(shell).toHaveBeenCalledTimes(2)
  expect(net).not.toHaveBeenCalled()
})
it('03 验收 5 / 03 不变量 18: failed handshake closes an EOF-ignoring tree, including its orphaned process group', async () => {
  const processHost = createHostProcess()
  let pid = 0
  const host = createMemoryHost({
    process: {
      spawn: async (spec, signal) => {
        const child = await processHost.spawn(spec, signal)
        pid = child.pid
        return child
      },
    },
  })
  // Real time matters for the TERM grace; the test memory clock is explicitly advanced.
  const pending = connectStdioServer(host, {
    name: 'tree',
    spawn: {
      argv: [
        process.execPath,
        new URL('../../../packages/kernel/test/support/fixtures/tree-server.mjs', import.meta.url)
          .pathname,
      ],
      cwd: absolutePath('/'),
      env: {},
      stdio: 'pipe',
    },
    sandbox: { profile: 'full-access', workspace: [] },
    handshakeTimeoutMs: 100,
    log: () => {},
  })
  // oxlint-disable-next-line vitest/valid-expect -- attached before triggering rejection, awaited below
  const failed = expect(pending).rejects.toThrow(/./)
  await new Promise((r) => setTimeout(r, 150))
  host.advance(10_000)
  await failed
  await vi.waitFor(() => {
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(-pid, 0)).toThrow(/./)
  })
})

it('03 验收 5 / 03 不变量 18: closing a connected tree server kills the group after the leader exits at EOF', async () => {
  const processHost = createHostProcess()
  let pid = 0
  const host = createMemoryHost({
    process: {
      spawn: async (spec, signal) => {
        const child = await processHost.spawn(spec, signal)
        pid = child.pid
        return child
      },
    },
  })
  const c = await connectStdioServer(host, {
    name: 'tree',
    spawn: {
      argv: [
        process.execPath,
        new URL('../../../packages/kernel/test/support/fixtures/tree-server.mjs', import.meta.url)
          .pathname,
        '--serve',
      ],
      cwd: absolutePath('/'),
      env: {},
      stdio: 'pipe',
    },
    sandbox: { profile: 'full-access', workspace: [] },
    handshakeTimeoutMs: 1000,
    log: () => {},
  })
  const closing = c.close()
  await new Promise((r) => setTimeout(r, 100))
  host.advance(10_000)
  await closing
  await vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow(/./))
})
it('03 验收 18: an early browser callback is held until auth starts waiting for its state', async () => {
  const listener = await listenMcpCallback(0)
  cleanup.push(() => listener.close())
  const callback = fetch(`http://127.0.0.1:${listener.port}/callback?state=right&code=early`)
  await new Promise((r) => setTimeout(r, 20))
  const waiting = listener.waitForCallback('right', 120_000)
  expect((await waiting).get('code')).toBe('early')
  await listener.close()
  listener.complete({ ok: true })
  expect((await callback).status).toBe(200)
})

it('03 验收 10 (fetch cancellation): aborting a stalled TLS handshake closes the pinned socket', async () => {
  const sockets = new Set<Socket>(),
    hello = Promise.withResolvers<Socket>()
  const tcp = createTcpServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', () => hello.resolve(socket))
  })
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => tcp.close(() => resolve()))
  })
  const port = (tcp.address() as AddressInfo).port,
    abort = new AbortController()
  const pending = createMcpFetch('https://mcp.example', createMemoryHost().network, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    connectTarget: () => ({ address: '127.0.0.1', family: 4 }),
  })(`https://fetch.example:${port}`, { signal: abort.signal })
  const peer = await hello.promise,
    settled = Promise.allSettled([pending])
  abort.abort()
  expect((await settled)[0]).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } })
  await expect.poll(() => peer.destroyed).toBe(true)
})

it('03 验收 8: Windows PATH respects PATHEXT, refuses cmd/bat and directories, and never searches relative paths', async () => {
  const access = vi.spyOn(files, 'access').mockResolvedValue(undefined)
  const stat = vi
    .spyOn(files, 'stat')
    .mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof files.stat>>)
  for (const extension of ['.CMD', '.BAT']) {
    access.mockClear()
    expect(await resolveMcpCommand('npx', 'C:\\bin', 'win32', extension + ';.EXE')).toEqual({
      ok: false,
      code: 'windows-unsupported',
    })
    expect(access.mock.calls[0]?.[0]).toBe('C:\\bin\\npx' + extension)
  }
  stat.mockResolvedValue({ isFile: () => false } as Awaited<ReturnType<typeof files.stat>>)
  expect(await resolveMcpCommand('directory', 'C:\\bin', 'win32', '.EXE')).toEqual({
    ok: false,
    code: 'command-not-found',
  })
  access.mockClear()
  expect(await resolveMcpCommand('./x', 'C:\\bin', 'win32')).toEqual({
    ok: false,
    code: 'command-not-found',
  })
  expect(await resolveMcpCommand('../x', '/bin')).toEqual({ ok: false, code: 'command-not-found' })
  expect(access).not.toHaveBeenCalled()
})

it('03 验收 10: address normalization removes path slashes and fragments while preserving the query', async () => {
  const { mcpAddress } = await import('../src/main/mcp/address.js')
  expect(mcpAddress('https://example.com/mcp///?next=/#fragment')).toEqual({
    ok: true,
    url: 'https://example.com/mcp?next=/',
  })
  expect(mcpAddress('https://example.com/#fragment')).toEqual({
    ok: true,
    url: 'https://example.com',
  })
})

it('03 验收 19: direct seam uses the actual e2e off environment, manual redirects and no system browser', async () => {
  const shell = vi.fn<() => Promise<void>>(async () => {}),
    net = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1:1234/callback?state=x' },
        }),
    )
  await createMcpOpenUrl({
    isPackaged: false,
    env: { TENON_DEV_ENV: 'off', TENON_TEST_MCP_OPEN_URL: 'direct' },
    openExternal: shell,
    fetch: net,
  })(new URL('http://127.0.0.1:2345/authorize'))
  expect(shell).not.toHaveBeenCalled()
  expect(net).toHaveBeenCalledTimes(2)
  expect(net.mock.calls[0]?.[1]?.redirect).toBe('manual')
  expect(String(net.mock.calls[1]?.[0])).toContain('/callback?state=x')
})

it('03 验收 18 / 18a-1: callback auto requires unpackaged and actual e2e off environment', () => {
  const env = { TENON_DEV_ENV: 'off', TENON_TEST_MCP_CALLBACK_PORT: 'auto' }
  expect(usesMcpCallbackTestPort({ isPackaged: false, env })).toBe(true)
  expect(usesMcpCallbackTestPort({ isPackaged: true, env })).toBe(false)
  for (const value of [undefined, '1', 'on', ''])
    expect(
      usesMcpCallbackTestPort({ isPackaged: false, env: { ...env, TENON_DEV_ENV: value } }),
    ).toBe(false)
  expect(usesMcpCallbackTestPort({ isPackaged: false, env: { TENON_DEV_ENV: 'off' } })).toBe(false)
})

async function tcpConnect(port: number) {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', reject)
  })
}
function securePage(response: Response, body: string) {
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(response.headers.get('content-security-policy')).toBe(
    "default-src 'none'; style-src 'unsafe-inline'",
  )
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  const all = body + JSON.stringify([...response.headers])
  for (const value of [
    'private-code',
    'private-state',
    'private-token',
    '<script',
    'http://',
    'https://',
  ])
    expect(all).not.toContain(value)
}
it.each(['zh-CN', 'en'] as const)(
  '03 验收 53: %s callback pages describe every result with safe HTML and headers',
  async (locale) => {
    const i = await createI18n(locale, () => {})
    for (const code of [null, ...mcpLoginErrorSchema.options]) {
      // oxlint-disable-next-line no-await-in-loop -- independent callback listeners
      const listener = await listenMcpCallback(0, { locale, displayName: 'Notes <&>' })
      const waiting = listener.waitForCallback('private-state', 120_000)
      const pending = fetch(
        `http://127.0.0.1:${listener.port}/callback?state=private-state&code=private-code&token=private-token`,
      )
      // oxlint-disable-next-line no-await-in-loop -- wait for the request to be retained
      await waiting
      // oxlint-disable-next-line no-await-in-loop -- kernel closes before the route completes the page
      await listener.close()
      listener.complete(code === null ? { ok: true } : { ok: false, code })
      // oxlint-disable-next-line no-await-in-loop -- each response is asserted separately
      const response = await pending
      // oxlint-disable-next-line no-await-in-loop -- each body is asserted separately
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body).toContain(
        code === null
          ? i.t('mcp.callback.success', { name: 'Notes &lt;&amp;&gt;' })
          : i.t(`mcp.callback.${code}`),
      )
      expect(body).toContain(`lang="${locale}"`)
      expect(body.includes('Notes &lt;&amp;&gt;')).toBe(code === null)
      securePage(response, body)
      // oxlint-disable-next-line no-await-in-loop -- verify the port itself, not merely HTTP failure
      await expect(tcpConnect(listener.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    }
  },
)
it('03 验收 53: mismatched state returns a safe localized 400 and still accepts the real login', async () => {
  const listener = await listenMcpCallback(0, { locale: 'zh-CN', displayName: 'Notes' })
  cleanup.push(() => listener.close())
  const waiting = listener.waitForCallback('private-state', 120_000)
  const response = await fetch(
    `http://127.0.0.1:${listener.port}/callback?state=wrong&code=private-code`,
  )
  const body = await response.text()
  expect(response.status).toBe(400)
  expect(body).toContain('这不是 Tenon 发起的登录，或已过期')
  securePage(response, body)
  await tcpConnect(listener.port)
  const good = fetch(`http://127.0.0.1:${listener.port}/callback?state=private-state`)
  await waiting
  await listener.close()
  listener.complete({ ok: true })
  expect((await good).status).toBe(200)
})
it('03 验收 53: no login result by 30 seconds returns the pending page and closes idle connections', async () => {
  const listener = await listenMcpCallback(0, { locale: 'zh-CN', displayName: 'Notes' })
  cleanup.push(() => listener.close())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const waiting = listener.waitForCallback('private-state', 120_000)
  let finished = false
  const pending = fetch(
    `http://127.0.0.1:${listener.port}/callback?state=private-state&code=private-code`,
  ).then((response) => {
    finished = true
    return response
  })
  await waiting
  await listener.close()
  await vi.advanceTimersByTimeAsync(29_999)
  expect(finished).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  const response = await pending
  const body = await response.text()
  expect(response.status).toBe(200)
  expect(body).toContain('正在完成登录，可以回到 Tenon 查看结果')
  securePage(response, body)
  listener.complete({ ok: true })
  vi.useRealTimers()
  await expect(tcpConnect(listener.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
})
it('03 验收 18: TCP is refused before login and after success, failure, cancellation or timeout', async () => {
  const reserved = createTcpServer()
  await new Promise<void>((done) => reserved.listen(0, '127.0.0.1', done))
  const port = (reserved.address() as AddressInfo).port
  await new Promise<void>((done) => reserved.close(() => done()))
  await expect(tcpConnect(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  for (const result of [{ ok: true }, { ok: false, code: 'denied' }] as const) {
    // oxlint-disable-next-line no-await-in-loop -- reuse the same port across completed logins
    const listener = await listenMcpCallback(port)
    const waiting = listener.waitForCallback('right', 120_000)
    const response = fetch(`http://127.0.0.1:${port}/callback?state=right`)
    // oxlint-disable-next-line no-await-in-loop -- callback must arrive before kernel close
    await waiting
    // oxlint-disable-next-line no-await-in-loop -- a held response must not block close
    await listener.close()
    // oxlint-disable-next-line no-await-in-loop -- listener is gone even before the page is written
    await expect(tcpConnect(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    listener.complete(result)
    // oxlint-disable-next-line no-await-in-loop -- drain the page before rebinding
    await (await response).text()
  }
  const listener = await listenMcpCallback(port)
  cleanup.push(() => listener.close())
  const waiting = listener.waitForCallback('right', 120_000)
  // oxlint-disable-next-line vitest/valid-expect -- rejection attached before cancelling
  const cancelled = expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
  await listener.close()
  await cancelled
  await expect(tcpConnect(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  const slow = await listenMcpCallback(port)
  cleanup.push(() => slow.close())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const pending = slow.waitForCallback('right', 120_000)
  // oxlint-disable-next-line vitest/valid-expect -- rejection attached before advancing time
  const failure = expect(pending).rejects.toMatchObject({ code: 'timeout' })
  await vi.advanceTimersByTimeAsync(120_000)
  await failure
  vi.useRealTimers()
  await expect(tcpConnect(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
})

it('03 验收 18 / 53: closing the listener drains idle keep-alive sockets while retaining the callback response', async () => {
  const listener = await listenMcpCallback(0)
  cleanup.push(() => listener.close())
  const agent = new http.Agent({ keepAlive: true })
  cleanup.push(async () => {
    agent.destroy()
  })
  const waiting = listener.waitForCallback('right', 120_000)
  const url = `http://127.0.0.1:${listener.port}/callback`
  const idle = await new Promise<Socket>((resolve, reject) => {
    const request = http.get(url + '?state=wrong', { agent }, (response) => {
      const socket = response.socket
      response.resume()
      response.once('end', () => resolve(socket))
    })
    request.once('error', reject)
  })
  expect(idle.destroyed).toBe(false)
  const pending = fetch(url + '?state=right')
  await waiting
  await listener.close()
  await expect.poll(() => idle.destroyed).toBe(true)
  listener.complete({ ok: true })
  expect((await pending).status).toBe(200)
})
