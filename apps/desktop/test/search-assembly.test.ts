/** Search selection and credentials are host responsibilities (spec 02 step 28, Revisions 24). */
import {
  ProviderConfigMissingError,
  anthropicDefinition,
  createMemoryHost,
  createProviderRegistry,
  keyFor,
  registerBuiltinProviders,
  zhipuSearchDefinition,
} from '@tenon-app/kernel'
import type { AbsolutePath, HostAdapter, ProviderRegistry, RunConnector } from '@tenon-app/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeConfig } from '../src/main/host/profile.js'
import { createRunConnector } from '../src/main/run-assembly.js'

afterEach(() => vi.restoreAllMocks())

function registry(): ProviderRegistry {
  const providers = createProviderRegistry()
  registerBuiltinProviders(providers)
  return providers
}
async function assemble(connector: RunConnector, providers: ProviderRegistry, providerId: string) {
  const model = providers.get(providerId)?.builtinModels[0]
  return connector.assemble({
    sessionId: 'search',
    rootSessionId: 'search',
    signal: new AbortController().signal,
    choice: {
      providerId,
      modelId: model?.id ?? 'local',
      effort: null,
      capabilitySource: 'builtin',
    },
  })
}
async function key(host: HostAdapter, provider: string, value: string, name = 'apiKey') {
  await host.secrets.set(keyFor(host.identity, 'provider', provider, name), value)
}
async function network() {
  const requests: Array<{ url: string; headers: Headers; body: unknown }> = []
  const fetch: HostAdapter['network']['fetch'] = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    })
    return new Response(JSON.stringify({ search_result: [] }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  const host = createMemoryHost({ network: { ...createMemoryHost().network, fetch } })
  await host.fs.mkdirp(host.identity.profileDir as AbsolutePath)
  return { requests, host }
}

const ZHIPU_CASES = [
  { providerId: 'zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4/', credential: 'apiKey' },
  {
    providerId: 'anthropic',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    credential: 'apiKey',
  },
  {
    providerId: 'anthropic',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    credential: 'authToken',
  },
] as const

describe('the search backend uses the provider’s resolved credentials', () => {
  it.each(ZHIPU_CASES)(
    '$providerId at $baseURL with $credential searches through the same host network',
    async ({ providerId, baseURL, credential }) => {
      const { requests, host } = await network()
      const providers = registry()
      await writeConfig(host.fs, host.identity, { providerConfig: { [providerId]: { baseURL } } })
      await key(host, providerId, 'stored-provider-key', credential)
      const get = vi.spyOn(host.secrets, 'get')
      const definition = providers.get(providerId)
      if (definition === null) throw new Error('test provider missing')
      const createProvider = vi.spyOn(definition, 'create')
      const createSearch = vi.spyOn(zhipuSearchDefinition, 'create')
      const connector = createRunConnector({ host, providers, env: {}, log: () => {} })
      const assembly = await assemble(connector, providers, providerId)
      expect(assembly.search?.host).toBe('open.bigmodel.cn')
      expect(createSearch.mock.calls[0]?.[0].secrets).toBe(
        createProvider.mock.calls[0]?.[0].secrets,
      )
      expect(assembly.search?.domainFilter).toBe(false)
      const query = '🔎'.repeat(100)
      const prepared = assembly.search?.prepareQuery(query)
      expect(prepared).toEqual({ query: '🔎'.repeat(70), truncated: true })
      expect(connector.searchTarget?.(providerId, query)).toEqual({
        host: 'open.bigmodel.cn',
        ...prepared,
      })
      expect(
        await assembly.search?.search({
          query: prepared?.query ?? '',
          signal: new AbortController().signal,
        }),
      ).toEqual({ ok: true, hits: [] })
      expect(get.mock.calls.map(([account]) => account)).toEqual(
        providers
          .get(providerId)
          ?.configKeys.filter((item) => item.secret)
          .map((item) => keyFor(host.identity, 'provider', providerId, item.name)),
      )
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe('https://open.bigmodel.cn/api/paas/v4/web_search')
      expect(requests[0]?.headers.get('authorization')).toBe('Bearer stored-provider-key')
      expect(requests[0]?.body).toMatchObject({ search_query: '🔎'.repeat(70) })
    },
  )

  it('uses the development environment fallback, and a stored key wins over it', async () => {
    const { requests, host } = await network()
    const providers = registry()
    const connector = createRunConnector({
      host,
      providers,
      env: { ZHIPU_API_KEY: 'development-key' },
      log: () => {},
    })
    const first = await assemble(connector, providers, 'zhipu')
    await first.search?.search({ query: 'first', signal: new AbortController().signal })
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer development-key')
    await key(host, 'zhipu', 'keychain-key')
    const second = await assemble(connector, providers, 'zhipu')
    await second.search?.search({ query: 'second', signal: new AbortController().signal })
    expect(requests[1]?.headers.get('authorization')).toBe('Bearer keychain-key')
  })

  it('does not use environment secrets in packaged builds or expose a backend without credentials', async () => {
    const { requests, host } = await network()
    const providers = registry()
    const connector = createRunConnector({
      host,
      providers,
      env: { ZHIPU_API_KEY: 'development-key' },
      isPackaged: true,
      log: () => {},
    })
    const assembly = await assemble(connector, providers, 'zhipu')
    expect(assembly.search).toBeNull()
    expect(() => assembly.provider()).toThrow(ProviderConfigMissingError)
    expect(requests).toEqual([])
    // The synchronous target intentionally does not promise a credential is present.
    expect(connector.searchTarget?.('zhipu', 'words')).toEqual({
      host: 'open.bigmodel.cn',
      query: 'words',
      truncated: false,
    })
  })

  it('retries a credential read crossed by a host save before constructing search', async () => {
    const { host, requests } = await network()
    const providers = registry()
    await key(host, 'anthropic', 'old-official-key')
    let entered!: () => void
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const get = host.secrets.get.bind(host.secrets)
    let first = true
    vi.spyOn(host.secrets, 'get').mockImplementation(async (account) => {
      const value = await get(account)
      if (first) {
        first = false
        entered()
        await held
      }
      return value
    })
    const connector = createRunConnector({ host, providers, env: {}, log: () => {} })
    const pending = assemble(connector, providers, 'anthropic')
    await reached
    await key(host, 'anthropic', 'new-bigmodel-key')
    await writeConfig(host.fs, host.identity, {
      providerConfig: { anthropic: { baseURL: 'https://open.bigmodel.cn/api/anthropic' } },
    })
    release()
    const assembly = await pending
    expect(assembly.search?.host).toBe('open.bigmodel.cn')
    await assembly.search?.search({ query: 'after save', signal: new AbortController().signal })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer new-bigmodel-key')
    expect(connector.searchTarget?.('anthropic', 'after save')?.host).toBe('open.bigmodel.cn')
  })

  it.each(['apiKey', 'authToken'] as const)(
    'binds the anthropic development %s to the configured environment host',
    async (credential) => {
      const { host, requests } = await network()
      const providers = registry()
      const connector = createRunConnector({
        host,
        providers,
        env: {
          ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
          [credential === 'apiKey' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN']: 'env-key',
        },
        log: () => {},
      })
      const assembly = await assemble(connector, providers, 'anthropic')
      expect(assembly.search?.host).toBe('open.bigmodel.cn')
      await assembly.search?.search({ query: 'words', signal: new AbortController().signal })
      expect(requests[0]?.headers.get('authorization')).toBe('Bearer env-key')
      expect(connector.searchTarget?.('anthropic', 'words')?.host).toBe('open.bigmodel.cn')
    },
  )

  it('does not forward an environment key bound to a different host', async () => {
    const { requests, host } = await network()
    const providers = registry()
    await writeConfig(host.fs, host.identity, {
      providerConfig: { anthropic: { baseURL: 'https://open.bigmodel.cn/api/anthropic' } },
    })
    const connector = createRunConnector({
      host,
      providers,
      env: { ANTHROPIC_API_KEY: 'official-host-key' },
      log: () => {},
    })
    const assembly = await assemble(connector, providers, 'anthropic')
    expect(assembly.search).toBeNull()
    expect(() => assembly.provider()).toThrow(ProviderConfigMissingError)
    expect(requests).toEqual([])
  })
})

describe('searchTarget is synchronous and reads the current config snapshot without secrets', () => {
  it('tracks an in-provider host change, and never queries the keychain or network', async () => {
    const { host, requests } = await network()
    const providers = registry()
    const get = vi.spyOn(host.secrets, 'get')
    const connector = createRunConnector({ host, providers, env: {}, log: () => {} })
    await writeConfig(host.fs, host.identity, {
      providerConfig: { anthropic: { baseURL: 'https://open.bigmodel.cn/api/anthropic' } },
    })
    expect(connector.searchTarget?.('anthropic', '🌏'.repeat(90))).toEqual({
      host: 'open.bigmodel.cn',
      query: '🌏'.repeat(70),
      truncated: true,
    })
    await writeConfig(host.fs, host.identity, {
      providerConfig: { anthropic: { baseURL: 'https://relay.example/' } },
    })
    expect(connector.searchTarget?.('anthropic', 'words')).toBeNull()
    await writeConfig(host.fs, host.identity, {
      providerConfig: { anthropic: { baseURL: 'https://api.anthropic.com' } },
    })
    expect(connector.searchTarget?.('anthropic', '🌏'.repeat(90))).toEqual({
      host: 'api.anthropic.com',
      query: '🌏'.repeat(90),
      truncated: false,
    })
    expect(get).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  it.each([
    ['anthropic', 'https://relay.example/'],
    ['zhipu', 'https://api.z.ai/api/paas/v4/'],
    ['ollama', 'http://localhost:11434'],
    ['ollama', 'https://open.bigmodel.cn/'],
  ])('%s at %s has no search backend', async (providerId, baseURL) => {
    const { host, requests } = await network()
    const providers = registry()
    await writeConfig(host.fs, host.identity, { providerConfig: { [providerId]: { baseURL } } })
    await key(host, providerId, 'stored-key')
    const connector = createRunConnector({ host, providers, env: {}, log: () => {} })
    expect((await assemble(connector, providers, providerId)).search).toBeNull()
    expect(connector.searchTarget?.(providerId, 'words')).toBeNull()
    expect(requests).toEqual([])
  })
})

describe('official search model selection is independent of the conversation model', () => {
  it('excludes search when neither candidate supports forced tool choice', async () => {
    const { host, requests } = await network()
    const providers = createProviderRegistry()
    providers.register({
      ...anthropicDefinition,
      builtinModels: anthropicDefinition.builtinModels.map((model) =>
        model.thinkingSpec === undefined
          ? model
          : Object.assign({}, model, {
              thinkingSpec: Object.assign({}, model.thinkingSpec, { forcedToolChoice: false }),
            }),
      ),
    })
    await key(host, 'anthropic', 'official-key')
    const connector = createRunConnector({ host, providers, env: {}, log: () => {} })
    expect((await assemble(connector, providers, 'anthropic')).search).toBeNull()
    expect(connector.searchTarget?.('anthropic', 'words')).toBeNull()
    expect(requests).toEqual([])
  })

  it.each([
    { disabled: [] as string[], expected: 'claude-sonnet-5' },
    { disabled: ['claude-sonnet-5'], expected: 'claude-opus-5' },
  ])('excludes $disabled and selects $expected', async ({ disabled, expected }) => {
    const { host, requests } = await network()
    const providers = createProviderRegistry()
    providers.register({
      ...anthropicDefinition,
      builtinModels: anthropicDefinition.builtinModels.map((model) =>
        disabled.includes(model.id)
          ? model.thinkingSpec === undefined
            ? model
            : Object.assign({}, model, {
                thinkingSpec: Object.assign({}, model.thinkingSpec, { forcedToolChoice: false }),
              })
          : model,
      ),
    })
    await key(host, 'anthropic', 'official-key')
    const connector = createRunConnector({ host, providers, env: {}, log: () => {} })
    const assembly = await assemble(connector, providers, 'anthropic')
    expect(assembly.search?.host).toBe('api.anthropic.com')
    expect(assembly.search?.domainFilter).toBe(true)
    const query = '🌏'.repeat(100)
    expect(connector.searchTarget?.('anthropic', query)).toEqual({
      host: 'api.anthropic.com',
      query,
      truncated: false,
    })
    await assembly.search?.search({ query, signal: new AbortController().signal })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(requests[0]?.headers.get('x-api-key')).toBe('official-key')
    expect(requests[0]?.body).toMatchObject({ model: expected, max_tokens: 4096 })
  })
})
