/**
 * The origin map test seam (M6 §点名「测试接缝」; 推出的读法 42; 验收 27): read on an unpackaged build
 * with `TENON_DEV_ENV=off` only, a map that is not https origins onto loopback refuses the start,
 * and only the transport moves — and M6 不变量 19: a packaged build never reads the variable, and
 * the official-origin rule, the key binding, `reachOf` and A9 still judge the address as configured.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainLike, ProviderEntryContract } from '@tenon-app/contracts'
import {
  ANTHROPIC_PROVIDER_ID,
  absolutePath,
  createMemoryHost,
  createProviderRegistry,
  keyFor,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type { AbsolutePath, HostAdapter, HostNetwork, ModelChoice } from '@tenon-app/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopHost } from '../src/main/host/index.js'
import {
  ORIGIN_MAP_ENV,
  originMapTestNetwork,
  parseOriginMap,
} from '../src/main/host/origin-map-test-seam.js'
import { writeConfig } from '../src/main/host/profile.js'
import { snapshotEnv } from '../src/main/host/shell-env.js'
import { registerProviderRoutes } from '../src/main/provider-routes.js'
import { createRunConnector } from '../src/main/run-assembly.js'
import { startFakeAnthropic } from './support/fake-anthropic.js'
import type { FakeAnthropic } from './support/fake-anthropic.js'

/** What the test launcher sets (e2e/helpers/app-env.ts): the seam reads both. */
const ON = { TENON_DEV_ENV: 'off', TENON_SECRETS: 'memory' } as const

interface Forwarded {
  readonly url: string
  readonly method: string
  readonly key: string | null
  readonly body: string
  readonly redirect: Request['redirect']
}

function recording(): HostNetwork & {
  readonly seen: string[]
  readonly forwarded: Forwarded[]
  readonly signals: (AbortSignal | null | undefined)[]
} {
  const seen: string[] = []
  const forwarded: Forwarded[] = []
  const signals: (AbortSignal | null | undefined)[] = []
  return {
    seen,
    forwarded,
    signals,
    fetch: async (input, init) => {
      seen.push(input instanceof Request ? input.url : String(input))
      // The caller's signal itself, not the copy a rebuilt Request would hold.
      signals.push(init?.signal)
      // What arrives, as the network would send it: method, the key header, the body, redirect.
      const request = new Request(input, init)
      const { url, method, redirect } = request
      forwarded.push({
        url,
        method,
        key: request.headers.get('x-api-key'),
        body: await request.text(),
        redirect,
      })
      return new Response('ok')
    },
    fetchUntrusted: (input) => {
      seen.push(`untrusted ${String(input)}`)
      return Promise.resolve(new Response('ok'))
    },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

describe('when the seam is on (M6 不变量 19)', () => {
  it('reads nothing once packaged, and is off without TENON_DEV_ENV=off or the map', () => {
    const network = recording()
    const env = Object.defineProperty({}, ORIGIN_MAP_ENV, {
      get() {
        throw new Error('a packaged build read the origin map')
      },
    })
    expect(originMapTestNetwork(network, true, env)).toBe(network)
    const map = 'https://api.anthropic.com=http://127.0.0.1:4000'
    // `pnpm dev` and `.env.local` cannot turn it on: only the test launcher sets TENON_DEV_ENV=off.
    expect(originMapTestNetwork(network, false, { [ORIGIN_MAP_ENV]: map })).toBe(network)
    expect(
      originMapTestNetwork(network, false, { TENON_DEV_ENV: 'on', [ORIGIN_MAP_ENV]: map }),
    ).toBe(network)
    expect(originMapTestNetwork(network, false, ON)).toBe(network)
  })

  it('sends a mapped origin to its loopback stand-in, path and query kept, and nothing else', async () => {
    const network = recording()
    const map =
      'https://api.anthropic.com=http://127.0.0.1:4000,https://vendor.e2e.test=http://[::1]:4001'
    const seam = originMapTestNetwork(network, false, { ...ON, [ORIGIN_MAP_ENV]: map })
    await seam.fetch('https://api.anthropic.com/v1/messages?beta=true')
    await seam.fetch(new URL('https://vendor.e2e.test/v1/chat/completions'))
    await seam.fetch(new Request('https://api.anthropic.com/v1/models'))
    // A Request keeps its method, headers and body on the way to the stand-in.
    await seam.fetch(
      new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'k' },
        body: '{}',
      }),
    )
    // Another origin — another scheme, port or host — is untouched, and so is WebFetch's egress.
    await seam.fetch('http://api.anthropic.com/v1/messages')
    await seam.fetch('https://api.anthropic.com:8443/v1/messages')
    await seam.fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    await seam.fetchUntrusted('https://api.anthropic.com/page')
    expect(network.seen).toEqual([
      'http://127.0.0.1:4000/v1/messages?beta=true',
      'http://[::1]:4001/v1/chat/completions',
      'http://127.0.0.1:4000/v1/models',
      'http://127.0.0.1:4000/v1/messages',
      'http://api.anthropic.com/v1/messages',
      'https://api.anthropic.com:8443/v1/messages',
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      'untrusted https://api.anthropic.com/page',
    ])
    expect(network.forwarded[3]).toEqual({
      url: 'http://127.0.0.1:4000/v1/messages',
      method: 'POST',
      key: 'k',
      body: '{}',
      redirect: 'follow',
    })
  })

  it('a Request keeps its redirect and signal, and the caller’s init still wins (network.ts)', async () => {
    const network = recording()
    const seam = originMapTestNetwork(network, false, {
      ...ON,
      [ORIGIN_MAP_ENV]: 'https://api.anthropic.com=http://127.0.0.1:4000',
    })
    const url = 'https://api.anthropic.com/v1/messages'
    const controller = new AbortController()
    const request = new Request(url, { redirect: 'manual', signal: controller.signal })
    await seam.fetch(request)
    // An instance's network puts `redirect: 'error'` in init (M6 不变量 3): init beats the Request.
    await seam.fetch(new Request(url, { method: 'POST', body: '{}' }), {
      method: 'PUT',
      redirect: 'error',
    })
    expect(network.forwarded.map(({ method, redirect }) => ({ method, redirect }))).toEqual([
      { method: 'GET', redirect: 'manual' },
      { method: 'PUT', redirect: 'error' },
    ])
    // Stop still reaches the rewritten request.
    expect(network.signals[0]).toBe(request.signal)
    controller.abort()
    expect(network.signals[0]?.aborted).toBe(true)
  })

  it.each([
    '',
    'https://api.anthropic.com',
    'http://api.anthropic.com=http://127.0.0.1:4000',
    'https://api.anthropic.com/v1=http://127.0.0.1:4000',
    'https://user@api.anthropic.com=http://127.0.0.1:4000',
    'not a url=http://127.0.0.1:4000',
    'https://api.anthropic.com=http://10.0.0.2:4000',
    'https://api.anthropic.com=http://localhost:4000',
    'https://api.anthropic.com=https://127.0.0.1:4000',
    'https://api.anthropic.com=http://127.0.0.1',
    'https://api.anthropic.com=http://127.0.0.1:4000/v1',
    'https://api.anthropic.com=http://127.0.0.1:4000,https://api.anthropic.com=http://127.0.0.1:4001',
    'https://api.anthropic.com=http://127.0.0.1:4000,',
  ])('refuses %j: an https origin onto loopback only', (value) => {
    expect(() => parseOriginMap(value)).toThrow(ORIGIN_MAP_ENV)
    expect(() =>
      originMapTestNetwork(recording(), false, { ...ON, [ORIGIN_MAP_ENV]: value }),
    ).toThrow(ORIGIN_MAP_ENV)
  })

  it('refuses a map beside any secrets store but memory: the keychain is every profile’s (02 M4)', async () => {
    const map = 'https://api.anthropic.com=http://127.0.0.1:4000'
    for (const secrets of [undefined, 'keychain', '']) {
      const env = { TENON_DEV_ENV: 'off', TENON_SECRETS: secrets, [ORIGIN_MAP_ENV]: map }
      expect(() => originMapTestNetwork(recording(), false, env)).toThrow(
        `${ORIGIN_MAP_ENV} needs TENON_SECRETS=memory`,
      )
    }
    // Main does not start: the host would have held the keychain beside the map.
    const root = await mkdtemp(join(tmpdir(), 'tenon-origin-map-'))
    try {
      vi.stubEnv('TENON_SECRETS', undefined)
      await expect(
        createDesktopHost({
          userDataDir: absolutePath(root),
          userId: 'local',
          tenantId: 'tenant',
          send: () => {},
          log: () => {},
          isPackaged: false,
          startupEnv: snapshotEnv({ TENON_DEV_ENV: 'off', [ORIGIN_MAP_ENV]: map }),
        }),
      ).rejects.toThrow(`${ORIGIN_MAP_ENV} needs TENON_SECRETS=memory`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to build the desktop host, so main does not start, on a map it refuses (验收 27)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-origin-map-'))
    try {
      vi.stubEnv('TENON_SECRETS', 'memory')
      const options = {
        userDataDir: absolutePath(root),
        userId: 'local',
        tenantId: 'tenant',
        send: () => {},
        log: () => {},
        startupEnv: snapshotEnv({
          ...ON,
          [ORIGIN_MAP_ENV]: 'https://api.anthropic.com=http://192.168.1.20:4000',
        }),
      }
      await expect(createDesktopHost({ ...options, isPackaged: false })).rejects.toThrow(
        ORIGIN_MAP_ENV,
      )
      // A packaged build never reads it, whatever it holds.
      await expect(createDesktopHost({ ...options, isPackaged: true })).resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stays off when only `.env.local` brings TENON_DEV_ENV=off and the map (§点名「测试接缝」)', async () => {
    // main() snapshots the environment before `loadDevEnv` copies `.env.local` into process.env,
    // and the seam reads that snapshot: only the launcher's environment can turn it on.
    const root = await mkdtemp(join(tmpdir(), 'tenon-origin-map-'))
    const fake = await startFakeAnthropic({ chunks: ['seam on'], delayMs: 1 })
    try {
      vi.stubEnv('TENON_SECRETS', 'memory')
      vi.stubEnv('TENON_DEV_ENV', undefined)
      vi.stubEnv(ORIGIN_MAP_ENV, undefined)
      const startupEnv = snapshotEnv(process.env)
      // An https origin on this machine whose port is closed: a request that is not rewritten
      // fails at once, and nothing leaves the machine.
      const origin = `https://127.0.0.1:${await closedPort()}`
      const map = `${origin}=${fake.baseURL}`
      const file = join(root, '.env.local')
      await writeFile(file, `TENON_DEV_ENV=off\n${ORIGIN_MAP_ENV}=${map}\n`)
      process.loadEnvFile(file) // what loadDevEnv does on a development build
      expect(process.env['TENON_DEV_ENV']).toBe('off')
      const options = {
        userDataDir: absolutePath(root),
        userId: 'local',
        tenantId: 'tenant',
        send: () => {},
        log: () => {},
        isPackaged: false,
      }
      const send = (host: HostAdapter) =>
        host.network.fetch(`${origin}/v1/messages`, { method: 'POST', body: '{}' })
      const dev = await createDesktopHost({ ...options, startupEnv })
      await expect(send(dev)).rejects.toThrow('fetch failed')
      expect(fake.requests).toHaveLength(0)
      // The same map from the launcher's environment is sent to the fake.
      const launched = await createDesktopHost({
        ...options,
        startupEnv: snapshotEnv({ ...ON, [ORIGIN_MAP_ENV]: map }),
      })
      await (await send(launched)).text()
      expect(fake.requests).toHaveLength(1)
    } finally {
      await fake.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('M6 不变量 19: everything judges the address as configured, not where it is sent', () => {
  let fake: FakeAnthropic | undefined

  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  /** provider.list and the Run connector over a host whose network is the seam, on `map`. */
  async function onSeam(stored?: string) {
    fake = await startFakeAnthropic({ chunks: ['hi'], delayMs: 1 })
    const map = `https://api.anthropic.com=${fake.baseURL}`
    const memory = createMemoryHost({
      network: {
        fetchUntrusted: createMemoryHost().network.fetchUntrusted,
        fetch: (input, init) => globalThis.fetch(input, init),
      },
    })
    const host = {
      ...memory,
      network: originMapTestNetwork(memory.network, false, { ...ON, [ORIGIN_MAP_ENV]: map }),
    }
    await host.fs.mkdirp(host.identity.profileDir as AbsolutePath)
    if (stored !== undefined) {
      await writeConfig(host.fs, host.identity, {
        providerConfig: { [ANTHROPIC_PROVIDER_ID]: { baseURL: stored } },
      })
    }
    await host.secrets.set(
      keyFor(host.identity, 'provider', ANTHROPIC_PROVIDER_ID, 'apiKey'),
      'e2e-test-key',
    )
    const providers = createProviderRegistry()
    registerBuiltinProviders(providers)
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
    const ipcMain: IpcMainLike = {
      handle: (channel, listener) => void handlers.set(channel, listener),
    }
    registerProviderRoutes({ ipcMain, host, providers, env: {}, log: () => {} })
    const listed = (await handlers.get('provider.list')?.({}, {})) as {
      data: ProviderEntryContract[]
    }
    const entry = listed.data.find((candidate) => candidate.id === ANTHROPIC_PROVIDER_ID)
    const connector = createRunConnector({ host, providers, env: {}, log: () => {} })
    const choice: ModelChoice = {
      providerId: ANTHROPIC_PROVIDER_ID,
      modelId: 'claude-sonnet-5',
      effort: null,
      capabilitySource: 'builtin',
    }
    const assembly = await connector.assemble({
      sessionId: 's',
      rootSessionId: 's',
      choice,
      signal: new AbortController().signal,
    })
    return { entry, assembly, connector }
  }

  it('the official address, sent to the fake: configured, public, bound, searchable and sent', async () => {
    const { entry, assembly, connector } = await onSeam()
    expect(entry).toMatchObject({
      configured: true,
      endpoint: { host: 'api.anthropic.com', reach: 'public' },
    })
    expect(entry).not.toHaveProperty('refused')
    expect(assembly.endpointOrigin).toBe('https://api.anthropic.com')
    expect(connector.endpointOrigin(ANTHROPIC_PROVIDER_ID)).toBe('https://api.anthropic.com')
    // The key is bound to api.anthropic.com, so the search backend of that host takes it.
    expect(assembly.search?.host).toBe('api.anthropic.com')
    const provider = assembly.provider()
    const encoded = provider.encode({
      model: assembly.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 16,
    })
    // Draining the stream is what sends the request.
    const events: string[] = []
    for await (const event of provider.stream(encoded, {
      identity: { runId: 'r', requestSeq: 1, physicalAttempt: 1 },
    })) {
      events.push(event.type)
    }
    expect(events).toContain('stop')
    expect(fake?.requests).toHaveLength(1)
    expect(fake?.requests[0]?.headers['x-api-key']).toBe('e2e-test-key')
  })

  it('the fake’s own loopback address, stored: refused as off the official origin, never sent', async () => {
    const started = await startFakeAnthropic({ chunks: ['never'], delayMs: 1 })
    try {
      const { entry, assembly } = await onSeam(started.baseURL)
      expect(entry).toMatchObject({
        configured: false,
        endpoint: { host: '127.0.0.1', reach: 'loopback' },
        refused: { code: 'official-host-only', origin: started.baseURL },
      })
      expect(() => assembly.provider()).toThrow(
        expect.objectContaining({ name: 'ProviderConfigMissingError' }),
      )
      expect(assembly.search).toBeNull()
      expect(started.requests).toHaveLength(0)
      expect(fake?.requests).toHaveLength(0)
    } finally {
      await started.close()
    }
  })
})
