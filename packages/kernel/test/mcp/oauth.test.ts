// Test permutations are sequential to isolate authorization-server request counters.
// oxlint-disable no-await-in-loop
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHost } from '../../src/index.js'
import { createMcpOAuthProvider } from '../../src/mcp/oauth.js'
import type { McpLoginUi } from '../../src/mcp/oauth.js'
import type { McpOAuthRuntime } from '../../src/mcp/pool.js'
import { createMcpTokenStore } from '../../src/mcp/token-store.js'
import { wrapMcpFetch } from '../../src/mcp/http-fetch.js'
import { connectHttpServer } from '../../src/mcp/connection.js'
import { startFakeAuthServer, startHttpFixture } from '../support/http-fixture.js'
import type { FakeAuthOptions } from '../support/http-fixture.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
  vi.restoreAllMocks()
})
async function setup(
  authOptions: FakeAuthOptions = {},
  over: Partial<McpOAuthRuntime> = {},
  serverUrl?: string,
) {
  const authServer = await startFakeAuthServer(authOptions)
  cleanup.push(() => authServer.close())
  const host = createMemoryHost()
  let issuerHash: string | null = null
  const order: string[] = []
  const issuerWrites: { issuer: { hash: string; url: string }; write: string }[] = []
  const store = createMcpTokenStore({
    secrets: host.secrets,
    identity: host.identity,
    serverId: 'fixture',
    ids: { uuid: () => crypto.randomUUID() },
    deleting: () => false,
    onIssuer: async (issuer, write) => {
      issuerWrites.push({ issuer, write })
      if (write === 'tokens' && runtime.ownClient?.issuer === null)
        runtime.ownClient = { ...runtime.ownClient, issuer: issuer.url }
      runtime.issuers = [...runtime.issuers.filter((hash) => hash !== issuer.hash), issuer.hash]
      order.push('issuer')
      issuerHash = issuer.hash
    },
    log: () => {},
  })
  const runtime: { -readonly [K in keyof McpOAuthRuntime]: McpOAuthRuntime[K] } = {
    issuers: [],
    ownClient: null,
    clientMetadataUrl: null,
    dcrRedirectPort: 53280,
    ...over,
  }
  let callback: URLSearchParams | null = null
  const ports: number[] = []
  const close = vi.fn<() => Promise<void>>(async () => {})
  const open = vi.fn<McpLoginUi['openUrl']>(async (url) => {
    const response = await fetch(url, { redirect: 'manual' })
    callback = new URL(response.headers.get('location')!).searchParams
  })
  const ui: McpLoginUi = {
    listen: async (port) => {
      ports.push(port)
      return {
        port: port || 43111,
        waitForCallback: async (state, timeout) => {
          expect(timeout).toBe(120_000)
          expect(callback?.get('state')).toBe(state)
          expect(atob(state.replaceAll('-', '+').replaceAll('_', '/')).length).toBe(32)
          return callback!
        },
        close,
      }
    },
    openUrl: open,
  }
  const handed = vi.fn<typeof fetch>(
    wrapMcpFetch(fetch, {
      serverUrl: serverUrl ?? authServer.url,
      staticHeaders: { 'X-Fixture-Static': 'fixture-static-value' },
    }),
  )
  const unauthorized = vi.fn<() => void>()
  const provider = createMcpOAuthProvider({
    serverId: 'fixture',
    serverUrl: serverUrl ?? authServer.url,
    fetch: handed,
    runtime: () => runtime,
    identity: host.identity,
    secrets: host.secrets,
    ids: { uuid: () => crypto.randomUUID() },
    store,
    currentIssuerHash: () => issuerHash,
    onUnauthorized: unauthorized,
    addSecret: () => {},
  })
  return {
    authServer,
    host,
    store,
    provider,
    ui,
    ports,
    close,
    open,
    runtime,
    handed,
    unauthorized,
    order,
    issuerWrites,
  }
}
it('03 验收 15 / 03 不变量 14: missing S256, no S256 or unavailable metadata never authorize or open a browser', async () => {
  for (const opts of [
    { pkceField: 'missing' },
    { pkceField: 'no-s256' },
    { metadataDown: true },
  ] as const) {
    const h = await setup(opts)
    const result = await h.provider.login(h.ui)
    expect(result).toEqual({
      ok: false,
      code: 'metadataDown' in opts ? 'metadata-unreachable' : 'pkce-unsupported',
    })
    expect(h.open).not.toHaveBeenCalled()
    expect(h.authServer.requests.some((r) => r.path === '/authorize')).toBe(false)
    expect(h.authServer.requests.some((r) => r.path === '/register')).toBe(false)
  }
})
it('03 验收 16 / 03 不变量 14: callback iss mismatch, wrong iss on access_denied and metadata mismatch make no token requests', async () => {
  for (const opts of [
    { issInCallback: 'https://wrong.test' },
    { issInCallback: 'https://wrong.test', callbackError: 'access_denied' },
    { issuerInMetadata: 'https://wrong.test' },
  ] as const) {
    const h = await setup(opts)
    expect(await h.provider.login(h.ui)).toEqual({
      ok: false,
      code: opts.issuerInMetadata ? 'issuer-mismatch' : 'iss-mismatch',
    })
    expect(h.authServer.requests.filter((r) => r.path === '/token')).toEqual([])
    expect(h.close).toHaveBeenCalledTimes(opts.issuerInMetadata ? 0 : 1)
  }
})
it('03 验收 16 / 17 / 18: matching iss saves tokens; DCR is native at fixed port; issuer is recorded before each write', async () => {
  const h = await setup()
  const set = h.host.secrets.set.bind(h.host.secrets)
  vi.spyOn(h.host.secrets, 'set').mockImplementation(async (key, value) => {
    h.order.push('write')
    await set(key, value)
  })
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  expect(h.ports).toEqual([53280])
  const registration = h.authServer.requests.find((r) => r.path === '/register')!
  expect(registration.body).toMatchObject({
    application_type: 'native',
    client_name: 'Tenon',
    token_endpoint_auth_method: 'none',
    redirect_uris: ['http://127.0.0.1:53280/callback'],
  })
  expect(await h.provider.tokens()).toMatchObject({
    access_token: 'fixture-access-1',
    issuer: h.authServer.url,
  })
  expect(h.order[0]).toBe('issuer')
  expect(h.close).toHaveBeenCalledTimes(1)
  expect(h.provider.discoveryState?.()).toBeUndefined()
  expect(() => h.provider.codeVerifier()).toThrow(/Unauthorized/i)
})
it('03 验收 17 / 18: CIMD requires URL, declared support and none, listens on port 0; otherwise DCR', async () => {
  const cimd = 'https://metadata.example/tenon/client.json'
  const yes = await setup({ cimd: true }, { clientMetadataUrl: cimd })
  expect(await yes.provider.login(yes.ui)).toEqual({ ok: true })
  expect(yes.ports).toEqual([0])
  expect(yes.authServer.requests.filter((r) => r.path === '/register')).toHaveLength(0)
  expect(new URL(yes.open.mock.calls[0]![0]).searchParams.get('client_id')).toBe(cimd)
  const no = await setup({ cimd: true, authNone: false }, { clientMetadataUrl: cimd })
  expect(await no.provider.login(no.ui)).toEqual({ ok: true })
  expect(no.ports).toEqual([53280])
  expect(no.authServer.requests.filter((r) => r.path === '/register')).toHaveLength(1)
})
it('03 验收 17: an already-bound own client comes first; a changed issuer sends no secret and never registers', async () => {
  const h = await setup()
  h.runtime.ownClient = {
    clientId: 'own-client',
    redirectPort: 43222,
    hasSecret: true,
    issuer: h.authServer.url,
  }
  await h.host.secrets.set('tenant:mcp:fixture:oauth:own:secret', 'fixture-own-secret')
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  expect(h.ports).toEqual([43222])
  expect(h.authServer.requests.filter((r) => r.path === '/register')).toHaveLength(0)
  expect(h.authServer.requests.find((r) => r.path === '/token')?.body['client_secret']).toBe(
    'fixture-own-secret',
  )
  h.runtime.ownClient = { ...h.runtime.ownClient!, issuer: 'https://different.test' }
  const before = h.authServer.requests.length
  expect(await h.provider.login(h.ui)).toEqual({ ok: false, code: 'issuer-changed' })
  expect(
    h.authServer.requests
      .slice(before)
      .filter((r) => r.path === '/token' || r.path === '/register'),
  ).toHaveLength(0)
})
it('03 验收 16: resource is sent without PRM; a missing or wrong callback iss refuses exchange', async () => {
  const h = await setup({ prm: false })
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  expect(new URL(h.open.mock.calls[0]![0]).searchParams.get('resource')).toBe(
    new URL(h.authServer.url).href,
  )
  expect(h.authServer.requests.find((r) => r.path === '/token')?.body['resource']).toBe(
    new URL(h.authServer.url).href,
  )
  const missing = await setup({ issInCallback: null })
  expect(await missing.provider.login(missing.ui)).toEqual({ ok: false, code: 'iss-mismatch' })
})
it('03 验收 20 (provider): tokens without ctx are cached; two concurrent 401s share one rotating refresh; no register or openUrl', async () => {
  const h = await setup()
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  const read = vi.spyOn(h.host.secrets, 'get')
  await h.provider.tokens()
  await h.provider.tokens()
  expect(read).not.toHaveBeenCalled()
  const before = h.authServer.requests.length
  await Promise.all([
    h.provider.authProvider.onUnauthorized!({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL(h.authServer.url),
      fetchFn: fetch,
    }),
    h.provider.authProvider.onUnauthorized!({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL(h.authServer.url),
      fetchFn: fetch,
    }),
  ])
  const refreshes = h.authServer.requests.slice(before).filter((r) => r.path === '/token')
  expect(refreshes).toHaveLength(1)
  expect(refreshes[0]?.body['grant_type']).toBe('refresh_token')
  expect(await h.provider.tokens()).toMatchObject({
    access_token: 'fixture-access-2',
    refresh_token: 'fixture-refresh-2',
  })
  expect(h.authServer.requests.slice(before).filter((r) => r.path === '/register')).toHaveLength(0)
  expect(h.open).toHaveBeenCalledTimes(1)
  expect(await h.store.tokens(h.runtime.issuers.at(-1)!)).toMatchObject({
    access_token: 'fixture-access-2',
    refresh_token: 'fixture-refresh-2',
  })
})
it('03 验收 21 / 03 不变量 21: invalid_grant or invalid_client refresh requires login and cannot register or openUrl', async () => {
  for (const refreshResult of ['invalid_grant', 'invalid_client'] as const) {
    const h = await setup()
    expect(await h.provider.login(h.ui)).toEqual({ ok: true })
    const before = h.authServer.requests.length
    h.authServer.set({ refreshResult })
    await expect(
      h.provider.authProvider.onUnauthorized!({
        response: new Response(null, { status: 401 }),
        serverUrl: new URL(h.authServer.url),
        fetchFn: fetch,
      }),
    ).rejects.toMatchObject({ name: 'McpUnauthorizedError' })
    expect(h.authServer.requests.slice(before).filter((r) => r.path === '/register')).toHaveLength(
      0,
    )
    expect(h.open).toHaveBeenCalledTimes(1)
  }
})

it('03 验收 11 / 12 / 21: transport and auth share fetch; another-origin AS receives no static headers; refreshed calls succeed without a browser', async () => {
  const fixture = await startHttpFixture({ era: 'legacy' })
  cleanup.push(() => fixture.close())
  const h = await setup({}, {}, fixture.url)
  fixture.set({ authUrl: h.authServer.url })
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  fixture.set({ requireToken: 'fixture-access-2' })
  const connection = await connectHttpServer({
    name: 'fixture',
    url: fixture.url,
    fetch: h.handed,
    protocol: 'legacy',
    authProvider: h.provider.authProvider,
  })
  cleanup.push(() => connection.close())
  fixture.set({ requireToken: 'fixture-access-3', failNext: '401' })
  expect(await connection.callTool('echo', {})).toHaveProperty('content')
  expect(await h.provider.tokens()).toMatchObject({
    access_token: 'fixture-access-3',
    refresh_token: 'fixture-refresh-3',
  })
  expect(Object.keys(h.provider.authProvider).toSorted()).toEqual(['onUnauthorized', 'token'])
  expect(h.open).toHaveBeenCalledTimes(1)
  expect(
    fixture.requests.every((r) => r.headers['x-fixture-static'] === 'fixture-static-value'),
  ).toBe(true)
  expect(h.authServer.requests.every((r) => r.headers['x-fixture-static'] === undefined)).toBe(true)
  for (const path of new Set(
    h.authServer.requests.filter((r) => r.path !== '/authorize').map((r) => r.path),
  )) {
    const handed = h.handed.mock.calls.filter(
      ([input]) =>
        new URL(input instanceof Request ? input.url : String(input)).href ===
        h.authServer.url + path,
    )
    expect(handed).toHaveLength(h.authServer.requests.filter((r) => r.path === path).length)
  }
  const registrations = h.authServer.requests.filter((r) => r.path === '/register').length
  fixture.set({ requireToken: 'never-accepted' })
  await expect(connection.callTool('echo', {})).rejects.toMatchObject({
    code: 'CLIENT_HTTP_AUTHENTICATION',
  })
  expect(h.authServer.requests.filter((r) => r.path === '/register')).toHaveLength(registrations)
  expect(h.open).toHaveBeenCalledTimes(1)
  fixture.set({ requireToken: undefined, failNext: '403-scope' })
  await expect(connection.callTool('echo', {})).rejects.toMatchObject({
    name: 'InsufficientScopeError',
  })
})
it('03 验收 18: listener timeout and occupied ports close safely', async () => {
  const h = await setup()
  const timeout: McpLoginUi = {
    ...h.ui,
    listen: async () => ({
      port: 53280,
      close: h.close,
      waitForCallback: async () => {
        throw Object.assign(new Error('fixture timeout'), { code: 'timeout' })
      },
    }),
  }
  expect(await h.provider.login(timeout)).toEqual({ ok: false, code: 'timeout' })
  expect(h.close).toHaveBeenCalledTimes(1)
  const occupied: McpLoginUi = {
    ...h.ui,
    listen: async () => {
      throw Object.assign(new Error('fixture busy'), { code: 'port-in-use' })
    },
  }
  expect(await h.provider.login(occupied)).toEqual({ ok: false, code: 'port-in-use' })
})

it('03 不变量 21: a session refresh during an interactive login cannot open a browser or erase login state', async () => {
  const h = await setup()
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  let release!: (value: URLSearchParams) => void
  let arrived!: () => void
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const callback = new Promise<URLSearchParams>((resolve) => {
    release = resolve
  })
  let received!: URLSearchParams
  const ui: McpLoginUi = {
    ...h.ui,
    listen: async (port) => {
      const listener = await h.ui.listen(port)
      return {
        ...listener,
        waitForCallback: async (state, timeout) => {
          received = await listener.waitForCallback(state, timeout)
          arrived()
          return callback
        },
      }
    },
  }
  const login = h.provider.login(ui)
  await waiting
  h.authServer.set({ refreshResult: 'invalid_grant' })
  await expect(
    h.provider.authProvider.onUnauthorized!({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL(h.authServer.url),
      fetchFn: fetch,
    }),
  ).rejects.toMatchObject({ name: 'McpUnauthorizedError' })
  expect(h.open).toHaveBeenCalledTimes(2)
  release(received)
  expect(await login).toEqual({ ok: true })
})

it('cancelLogin aborts discovery before opening or listening, and a concurrent login is refused', async () => {
  const h = await setup()
  const original = h.handed.getMockImplementation()!
  h.handed.mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    req.signal.throwIfAborted()
    if (req.url.includes('/.well-known/'))
      return new Promise((_resolve, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
      })
    return original(input, init)
  })
  const login = h.provider.login(h.ui)
  await vi.waitFor(() => expect(h.handed).toHaveBeenCalled())
  expect(await h.provider.login(h.ui)).toMatchObject({ ok: false })
  h.provider.cancelLogin()
  expect(await login).toEqual({ ok: false, code: 'cancelled' })
  expect(h.open).not.toHaveBeenCalled()
  expect(h.ports).toEqual([])
})

it('03 验收 17: first own-client tokens write carries raw issuer and binds it, without DCR; later issuer mismatch sends no secret', async () => {
  const h = await setup(
    {},
    { ownClient: { clientId: 'fixture-own', redirectPort: 53289, hasSecret: true, issuer: null } },
  )
  await h.host.secrets.set('tenant:mcp:fixture:oauth:own:secret', 'fixture-own-secret')
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  expect(h.runtime.ownClient?.issuer).toBe(h.authServer.url)
  expect(h.issuerWrites).toEqual([
    { issuer: { url: h.authServer.url, hash: h.runtime.issuers.at(-1) }, write: 'tokens' },
  ])
  expect(h.authServer.requests.filter((r) => r.path === '/register')).toHaveLength(0)
  const before = h.authServer.requests.length
  h.runtime.ownClient = { ...h.runtime.ownClient!, issuer: 'https://changed.invalid' }
  expect(await h.provider.login(h.ui)).toEqual({ ok: false, code: 'issuer-changed' })
  expect(
    h.authServer.requests
      .slice(before)
      .filter((r) => r.path === '/token' || r.path === '/register'),
  ).toHaveLength(0)
})

it('03 验收 20: a fresh provider restores the last configured issuer and caches its tokens; an empty issuer list reads nothing', async () => {
  const h = await setup()
  const tokens = { access_token: 'fixture-restored', token_type: 'Bearer' }
  await h.store.saveTokens(
    { hash: 'first', url: 'https://first.invalid' },
    { ...tokens, access_token: 'fixture-first' },
  )
  await h.store.saveTokens({ hash: 'last', url: 'https://last.invalid' }, tokens)
  const fresh = () =>
    createMcpOAuthProvider({
      serverId: 'fixture',
      serverUrl: h.authServer.url,
      fetch: h.handed,
      runtime: () => h.runtime,
      identity: h.host.identity,
      secrets: h.host.secrets,
      ids: { uuid: () => crypto.randomUUID() },
      store: h.store,
      currentIssuerHash: () => null,
      onUnauthorized: () => {},
      addSecret: () => {},
    })
  const restored = fresh()
  const get = vi.spyOn(h.host.secrets, 'get')
  expect(await restored.tokens()).toEqual(tokens)
  expect(get).toHaveBeenCalledTimes(8)
  expect(await restored.tokens()).toEqual(tokens)
  expect(get).toHaveBeenCalledTimes(8)
  h.runtime.issuers = []
  expect(await fresh().tokens()).toBeUndefined()
  expect(get).toHaveBeenCalledTimes(8)
})

it('03 验收 17: changing the discovered issuer registers a new DCR client instead of reusing the old issuer group', async () => {
  const fixture = await startHttpFixture({ era: 'legacy' })
  cleanup.push(() => fixture.close())
  const h = await setup({}, {}, fixture.url)
  fixture.set({ authUrl: h.authServer.url })
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  const old = h.runtime.issuers.at(-1)!
  const next = await startFakeAuthServer()
  cleanup.push(() => next.close())
  fixture.set({ authUrl: next.url })
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  expect(h.authServer.requests.filter((r) => r.path === '/register')).toHaveLength(1)
  expect(next.requests.filter((r) => r.path === '/register')).toHaveLength(1)
  expect(h.runtime.issuers.at(-1)).not.toBe(old)
  expect((await h.store.client(old))?.issuer).toBe(h.authServer.url)
  expect((await h.store.client(h.runtime.issuers.at(-1)!))?.issuer).toBe(next.url)
  expect(h.runtime.ownClient).toBeNull()
})

it('03 验收 16 / 03 不变量 14: a correct iss access_denied is denied, while an error callback missing required iss is mismatched', async () => {
  const denied = await setup({ callbackError: 'access_denied' })
  expect(await denied.provider.login(denied.ui)).toEqual({ ok: false, code: 'denied' })
  const missing = await setup({ callbackError: 'access_denied', issInCallback: null })
  expect(await missing.provider.login(missing.ui)).toEqual({ ok: false, code: 'iss-mismatch' })
  expect(missing.authServer.requests.filter((r) => r.path === '/token')).toHaveLength(0)
})

it('03 验收 17: null CIMD URL and absent server support independently select DCR', async () => {
  const withoutUrl = await setup({ cimd: true, authNone: true }, { clientMetadataUrl: null })
  expect(await withoutUrl.provider.login(withoutUrl.ui)).toEqual({ ok: true })
  expect(withoutUrl.authServer.requests.filter((r) => r.path === '/register')).toHaveLength(1)
  const unsupported = await setup(
    { cimd: false, authNone: true },
    { clientMetadataUrl: 'https://metadata.example/client.json' },
  )
  expect(await unsupported.provider.login(unsupported.ui)).toEqual({ ok: true })
  expect(unsupported.authServer.requests.filter((r) => r.path === '/register')).toHaveLength(1)
})

it('03 验收 17: direct own clientInformation refuses a changed issuer before reading the secret', async () => {
  const h = await setup(
    {},
    {
      ownClient: {
        clientId: 'fixture-own',
        redirectPort: 53289,
        hasSecret: true,
        issuer: 'https://bound.example',
      },
    },
  )
  const get = vi.spyOn(h.host.secrets, 'get')
  await expect(h.provider.clientInformation({ issuer: 'https://other' })).rejects.toMatchObject({
    code: 'issuer-changed',
  })
  expect(get).not.toHaveBeenCalled()
})

it('读法 65: PRM origin accepts the server and is sent byte-for-byte without a trailing slash; a narrower child resource refuses login', async () => {
  const accepted = await setup()
  accepted.authServer.set({ prmResource: new URL(accepted.authServer.url).origin })
  expect(await accepted.provider.login(accepted.ui)).toEqual({ ok: true })
  expect(accepted.provider).not.toHaveProperty('validateResourceURL')
  expect(accepted.authServer.requests.find((r) => r.path === '/token')?.body['resource']).toBe(
    new URL(accepted.authServer.url).origin,
  )
  const authorize = new URL(String(accepted.open.mock.calls[0]![0]))
  expect(authorize.searchParams.get('resource')).toBe(new URL(accepted.authServer.url).origin)
  const rejected = await setup()
  rejected.authServer.set({ prmResource: rejected.authServer.url + '/child' })
  expect(await rejected.provider.login(rejected.ui)).toEqual({
    ok: false,
    code: 'metadata-unreachable',
  })
  expect(rejected.open).not.toHaveBeenCalled()
})

it('03 验收 20: a rejected keychain read is evicted; tokens and login recover when keychain access returns', async () => {
  const h = await setup()
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  const provider = createMcpOAuthProvider({
    serverId: 'fixture',
    serverUrl: h.authServer.url,
    fetch: h.handed,
    runtime: () => h.runtime,
    identity: h.host.identity,
    secrets: h.host.secrets,
    ids: { uuid: () => crypto.randomUUID() },
    store: h.store,
    currentIssuerHash: () => h.runtime.issuers.at(-1) ?? null,
    onUnauthorized: () => {},
    addSecret: () => {},
  })
  const get = vi
    .spyOn(h.host.secrets, 'get')
    .mockRejectedValueOnce(new Error('fixture keychain refused'))
  await expect(provider.tokens()).rejects.toMatchObject({ name: 'McpKeychainError' })
  get.mockRestore()
  expect(await provider.tokens()).toMatchObject({ access_token: 'fixture-access-1' })
  expect(await provider.login(h.ui)).toEqual({ ok: true })
})

it('minor OAuth errors: refresh network failure and server 5xx propagate without marking unauthorized', async () => {
  for (const network of [true, false]) {
    const h = await setup()
    expect(await h.provider.login(h.ui)).toEqual({ ok: true })
    if (network) {
      const original = h.handed.getMockImplementation()!
      h.handed.mockImplementation(async (input, init) => {
        if (new URL(input instanceof Request ? input.url : String(input)).pathname === '/token')
          throw new TypeError('fixture network down')
        return original(input, init)
      })
    } else h.authServer.set({ tokenStatus: 503 })
    const result = await h.provider.authProvider.onUnauthorized!({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL(h.authServer.url),
      fetchFn: fetch,
    }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect(result).not.toMatchObject({ name: 'McpUnauthorizedError' })
    expect(h.unauthorized).not.toHaveBeenCalled()
  }
})

it('03 验收 21: session refresh with a changed or unbound own-client issuer requires login before registration', async () => {
  for (const issuer of ['https://other', null]) {
    const h = await setup(
      {},
      { ownClient: { clientId: 'own', hasSecret: false, issuer: null, redirectPort: 53280 } },
    )
    expect(await h.provider.login(h.ui)).toEqual({ ok: true })
    h.runtime.ownClient = { ...h.runtime.ownClient!, issuer }
    const before = h.authServer.requests.length
    await expect(
      h.provider.authProvider.onUnauthorized!({
        response: new Response(null, { status: 401 }),
        serverUrl: new URL(h.authServer.url),
        fetchFn: fetch,
      }),
    ).rejects.toMatchObject({ name: 'McpUnauthorizedError' })
    expect(h.unauthorized).toHaveBeenCalled()
    expect(
      h.authServer.requests
        .slice(before)
        .filter((request) => request.path === '/register' || request.path === '/token'),
    ).toEqual([])
    expect(h.open).toHaveBeenCalledTimes(1)
  }
})

it('03 验收 21 / 读法 65: refresh reuses successful login discovery and sends origin resource verbatim', async () => {
  const h = await setup()
  h.authServer.set({ prmResource: h.authServer.url })
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  const before = h.authServer.requests.length
  await h.provider.authProvider.onUnauthorized!({
    response: new Response(null, { status: 401 }),
    serverUrl: new URL(h.authServer.url),
    fetchFn: fetch,
  })
  const fresh = h.authServer.requests.slice(before)
  expect(fresh.filter((request) => request.path.includes('.well-known'))).toEqual([])
  expect(fresh.filter((request) => request.path === '/token')).toHaveLength(1)
  expect(fresh.find((request) => request.path === '/token')?.body['resource']).toBe(
    h.authServer.url,
  )
  expect(await h.store.tokens(h.runtime.issuers.at(-1)!)).toMatchObject({
    access_token: 'fixture-access-2',
    refresh_token: 'fixture-refresh-2',
  })
})

it('03 验收 21: a tolerated PRM 5xx cannot undo an authorized refresh or its persisted rotated tokens', async () => {
  const h = await setup({ prm: false })
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  const original = h.handed.getMockImplementation()!
  let unavailable = 0
  h.handed.mockImplementation(async (input, init) => {
    if (new Request(input, init).url.includes('.well-known/oauth-protected-resource')) {
      unavailable++
      return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })
    }
    return original(input, init)
  })
  await expect(
    h.provider.authProvider.onUnauthorized!({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL(h.authServer.url),
      fetchFn: fetch,
    }),
  ).resolves.toBeUndefined()
  expect(unavailable).toBeGreaterThan(0)
  expect(h.unauthorized).not.toHaveBeenCalled()
  expect(await h.store.tokens(h.runtime.issuers.at(-1)!)).toMatchObject({
    access_token: 'fixture-access-2',
    refresh_token: 'fixture-refresh-2',
  })
})

it('03 验收 21: with no PRM and the PRM path answering 500, invalid_grant refresh requires login', async () => {
  const h = await setup({ prm: false })
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  h.authServer.set({ refreshResult: 'invalid_grant' })
  const original = h.handed.getMockImplementation()!
  h.handed.mockImplementation(async (input, init) => {
    if (new Request(input, init).url.includes('.well-known/oauth-protected-resource'))
      return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
    return original(input, init)
  })
  await expect(
    h.provider.authProvider.onUnauthorized!({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL(h.authServer.url),
      fetchFn: fetch,
    }),
  ).rejects.toMatchObject({ name: 'McpUnauthorizedError' })
  expect(h.unauthorized).toHaveBeenCalled()
  expect(h.open).toHaveBeenCalledTimes(1)
})

it('03 读法 68: forgetting an evicted issuer discards memory tokens and the same provider registers and authorizes it again', async () => {
  const h = await setup()
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  const hash = h.runtime.issuers[0]!
  expect(await h.provider.tokens()).toBeDefined()
  await h.store.deleteTokens(hash)
  await h.store.deleteClient(hash)
  h.runtime.issuers = []
  h.provider.forgetIssuer(hash)
  expect(await h.provider.tokens()).toBeUndefined()
  expect(await h.provider.login(h.ui)).toEqual({ ok: true })
  expect(h.authServer.requests.filter((r) => r.path === '/register')).toHaveLength(2)
  expect(h.authServer.requests.filter((r) => r.path === '/authorize')).toHaveLength(2)
})
