/**
 * The desktop's Run connector (spec 02 §主进程与 kernel 的循环接口; run-assembly.ts): which provider
 * and model a new round is sent to, and the provider it is sent through — the half phase 1 called
 * `resolveChatProvider`, now split along the line the loop needs.
 *
 * Where credentials come from is a security boundary the kernel is not allowed to have an opinion
 * about: a value must never be read from the environment while the keychain has one, and a packaged
 * build reads no environment at all. Every case below drives the connector the way a new round does
 * — `resolveChoice`, then `assemble`, then `provider()` — with `config.json` holding what the
 * settings card saved.
 */
import {
  ANTHROPIC_PROVIDER_ID,
  OLLAMA_PROVIDER_ID,
  ZHIPU_PROVIDER_ID,
  createMemoryHost,
  createProviderRegistry,
  keyFor,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type {
  AbsolutePath,
  HostAdapter,
  ModelInfo,
  Provider,
  ProviderDefinition,
  ProviderRegistry,
  RequestIdentity,
  StreamEvent,
} from '@tenon-app/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { configPath, readConfig, writeConfig } from '../src/main/host/profile.js'
import {
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_ENV,
  MODEL_ENV,
  PROVIDER_ENV,
} from '../src/main/provider.js'
import { createRunConnector } from '../src/main/run-assembly.js'
import { startFakeAnthropic } from './support/fake-anthropic.js'
import type { FakeAnthropic } from './support/fake-anthropic.js'

function registry(): ProviderRegistry {
  const providers = createProviderRegistry()
  registerBuiltinProviders(providers)
  return providers
}

function anthropic(): ProviderDefinition {
  const definition = registry().get(ANTHROPIC_PROVIDER_ID)
  if (definition === null) throw new Error('the anthropic definition is not registered')
  return definition
}

const identity: RequestIdentity = { runId: 'r1', requestSeq: 1, physicalAttempt: 1 }

/** Draining the stream is what sends the request. */
async function ask(provider: Provider, model: ModelInfo): Promise<StreamEvent[]> {
  const encoded = provider.encode({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 16,
  })
  const events: StreamEvent[] = []
  for await (const event of provider.stream(encoded, { identity })) events.push(event)
  return events
}

interface ResolveOptions {
  readonly host: HostAdapter
  readonly providers: ProviderRegistry
  /** Saved as `config.json`'s `provider` (with `modelId`) when given. */
  readonly providerId?: string
  readonly modelId?: string | null
  /** Saved as `config.json`'s `providerConfig[providerId]` when given. */
  readonly settings?: Record<string, string>
  readonly env: Record<string, string>
  readonly isPackaged?: boolean
  readonly log: (line: string) => void
}

/** A new round's three calls, in order, against what `config.json` holds. */
async function resolveThrough(options: ResolveOptions): Promise<{
  provider: Provider
  model: ModelInfo
  maxTokens: number
}> {
  const { host, providerId } = options
  if (providerId !== undefined) {
    await host.fs.mkdirp(host.identity.profileDir as AbsolutePath)
    const modelId = options.modelId ?? null
    await writeConfig(host.fs, host.identity, {
      // The settings card always saves a model with its provider; a test that names only the
      // provider takes the environment's model through `TENON_MODEL`, like an unsaved one.
      provider: modelId === null ? null : { id: providerId, modelId },
      ...(options.settings === undefined
        ? {}
        : { providerConfig: { [providerId]: options.settings } }),
    })
  }
  const connector = createRunConnector({
    host,
    providers: options.providers,
    env: { ...(providerId === undefined ? {} : { [PROVIDER_ENV]: providerId }), ...options.env },
    isPackaged: options.isPackaged === true,
    log: options.log,
  })
  const choice = await connector.resolveChoice({
    sessionId: 's',
    profile: 'chat',
    sessionChoice: null,
    previousOrigin: null,
  })
  if ('needsConfirm' in choice) throw new Error('the connector asked for a confirmation')
  const assembly = await connector.assemble({
    sessionId: 's',
    rootSessionId: 's',
    choice,
    signal: new AbortController().signal,
  })
  return { provider: assembly.provider(), model: assembly.model, maxTokens: assembly.maxTokens }
}

describe('the connector builds what phase 1 resolved', () => {
  let fake: FakeAnthropic | undefined

  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  it('sends the keychain credential and never the environment one', async () => {
    fake = await startFakeAnthropic({ chunks: ['hi'], delayMs: 1 })
    const host = createMemoryHost({
      network: { fetch: (input, init) => globalThis.fetch(input, init) },
    })
    await host.secrets.set(
      keyFor(host.identity, 'provider', ANTHROPIC_PROVIDER_ID, 'apiKey'),
      'from-keychain',
    )
    const { provider, model, maxTokens } = await resolveThrough({
      host,
      providers: registry(),
      providerId: ANTHROPIC_PROVIDER_ID,
      settings: { baseURL: fake.baseURL },
      env: { ANTHROPIC_API_KEY: 'from-environment', TENON_MAX_TOKENS: '321' },
      log: () => {},
    })
    expect(maxTokens).toBe(321)

    await ask(provider, model)
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.headers['x-api-key']).toBe('from-keychain')
  })

  it('falls back to the environment only when the keychain holds nothing', async () => {
    fake = await startFakeAnthropic({ chunks: ['hi'], delayMs: 1 })
    const host = createMemoryHost({
      network: { fetch: (input, init) => globalThis.fetch(input, init) },
    })
    const { provider, model } = await resolveThrough({
      host,
      providers: registry(),
      providerId: ANTHROPIC_PROVIDER_ID,
      // A blank value is not a value: it must not shadow the next candidate.
      env: {
        ANTHROPIC_API_KEY: '   ',
        ANTHROPIC_AUTH_TOKEN: 'from-environment',
        ANTHROPIC_BASE_URL: fake.baseURL,
        [MODEL_ENV]: 'claude-haiku-4-5-20251001',
      },
      log: () => {},
    })
    expect(model.id).toBe('claude-haiku-4-5-20251001')

    await ask(provider, model)
    const headers = fake.requests[0]?.headers
    expect(headers?.['authorization']).toBe('Bearer from-environment')
    expect(headers?.['x-api-key']).toBeUndefined()
  })

  it('reports a provider with no credential at all as a named configuration error', async () => {
    const host = createMemoryHost()
    await expect(
      resolveThrough({
        host,
        providers: registry(),
        providerId: ANTHROPIC_PROVIDER_ID,
        env: {},
        log: () => {},
      }),
    ).rejects.toMatchObject({ name: 'ProviderConfigMissingError' })
  })

  it('hands create() the declared default of a key nobody configured', async () => {
    // A fourth definition, registered here: `create()` is documented to receive the non-secret
    // config with defaults applied, and the builtin three would hide a resolver that skipped them
    // because each re-applies its own default inside `create()`.
    const base = anthropic()
    const seen: { config?: Record<string, string> } = {}
    const probe: ProviderDefinition = {
      ...base,
      id: 'probe',
      configKeys: [
        ...base.configKeys,
        {
          name: 'flavour',
          required: false,
          secret: false,
          default: 'from-the-definition',
          labelKey: 'provider.probe.config.flavour',
        },
      ],
      create(args) {
        seen.config = { ...args.config }
        return base.create(args)
      },
    }
    const providers = createProviderRegistry()
    providers.register(probe)
    const host = createMemoryHost()
    await host.secrets.set(keyFor(host.identity, 'provider', 'probe', 'apiKey'), 'from-keychain')

    await resolveThrough({ host, providers, providerId: 'probe', env: {}, log: () => {} })
    expect(seen.config?.['flavour']).toBe('from-the-definition')
    // The one the user saved still wins over the declared default.
    await resolveThrough({
      host,
      providers,
      providerId: 'probe',
      settings: { flavour: 'from-the-settings' },
      env: {},
      log: () => {},
    })
    expect(seen.config?.['flavour']).toBe('from-the-settings')
  })

  it('caps a reply at phase 0 s limit, and never above what the model allows', async () => {
    const host = createMemoryHost()
    await host.secrets.set(
      keyFor(host.identity, 'provider', ANTHROPIC_PROVIDER_ID, 'apiKey'),
      'from-keychain',
    )
    const resolve = (env: Record<string, string>): ReturnType<typeof resolveThrough> =>
      resolveThrough({
        host,
        providers: registry(),
        providerId: ANTHROPIC_PROVIDER_ID,
        env,
        log: () => {},
      })

    // Nothing asked for: phase 0's 64 000, not the default model's own 128 000.
    expect((await resolve({})).maxTokens).toBe(DEFAULT_MAX_TOKENS)
    // A model that cannot go that high keeps its own limit; an explicit request wins outright.
    const small = await resolve({ [MODEL_ENV]: 'gateway/unknown-model' })
    expect(small.maxTokens).toBe(small.model.maxOutputTokens)
    expect((await resolve({ [MAX_TOKENS_ENV]: '99000' })).maxTokens).toBe(99_000)
  })

  it('reads no environment variable at all once packaged', async () => {
    const host = createMemoryHost()
    await expect(
      resolveThrough({
        host,
        providers: registry(),
        providerId: ANTHROPIC_PROVIDER_ID,
        isPackaged: true,
        // A shipped build must not take a credential — or an endpoint — from the ambient shell.
        env: { ANTHROPIC_API_KEY: 'from-environment', ANTHROPIC_BASE_URL: 'https://elsewhere' },
        log: () => {},
      }),
    ).rejects.toMatchObject({ name: 'ProviderConfigMissingError' })

    await host.secrets.set(
      keyFor(host.identity, 'provider', ANTHROPIC_PROVIDER_ID, 'apiKey'),
      'from-keychain',
    )
    const packaged = await resolveThrough({
      host,
      providers: registry(),
      providerId: ANTHROPIC_PROVIDER_ID,
      isPackaged: true,
      env: { [MODEL_ENV]: 'gateway/unknown-model', [MAX_TOKENS_ENV]: '7' },
      log: () => {},
    })
    expect(packaged.model).toBe(anthropic().builtinModels[0])
    expect(packaged.maxTokens).toBe(DEFAULT_MAX_TOKENS)
  })

  it('runs the model the settings saved, with TENON_MODEL filling only what it left empty', async () => {
    const host = createMemoryHost()
    await host.secrets.set(
      keyFor(host.identity, 'provider', ANTHROPIC_PROVIDER_ID, 'apiKey'),
      'from-keychain',
    )
    const resolve = (modelId: string | null): ReturnType<typeof resolveThrough> =>
      resolveThrough({
        host,
        providers: registry(),
        providerId: ANTHROPIC_PROVIDER_ID,
        modelId,
        env: { [MODEL_ENV]: 'claude-haiku-4-5-20251001' },
        log: () => {},
      })
    expect((await resolve('claude-sonnet-5')).model.id).toBe('claude-sonnet-5')
    expect((await resolve(null)).model.id).toBe('claude-haiku-4-5-20251001')
  })

  it('keeps the environment in charge when the keychain cannot be read', async () => {
    fake = await startFakeAnthropic({ chunks: ['hi'], delayMs: 1 })
    const host = createMemoryHost({
      network: { fetch: (input, init) => globalThis.fetch(input, init) },
    })
    host.secrets.get = () => Promise.reject(new Error('the keychain is locked'))
    const lines: string[] = []
    const resolved = await resolveThrough({
      host,
      providers: registry(),
      providerId: ANTHROPIC_PROVIDER_ID,
      env: { ANTHROPIC_API_KEY: 'from-environment', ANTHROPIC_BASE_URL: fake.baseURL },
      log: (line) => lines.push(line),
    })
    expect(resolved.provider.id).toBe(ANTHROPIC_PROVIDER_ID)
    expect(lines.some((line) => line.includes('keychain unavailable'))).toBe(true)
  })
})

describe('what the connector adds for the loop', () => {
  const choose = {
    sessionId: 's',
    profile: 'chat' as const,
    sessionChoice: null,
    previousOrigin: null,
  }

  it('answers a configuration problem from provider(), not from assemble()', async () => {
    const connector = createRunConnector({
      host: createMemoryHost(),
      providers: registry(),
      env: {},
      log: () => {},
    })
    const choice = await connector.resolveChoice(choose)
    if ('needsConfirm' in choice) throw new Error('unexpected confirmation')
    // No key anywhere: the assembly still resolves, and the kernel learns it when it builds.
    const assembly = await connector.assemble({
      sessionId: 's',
      rootSessionId: 's',
      choice,
      signal: new AbortController().signal,
    })
    expect(() => assembly.provider()).toThrow(
      expect.objectContaining({
        name: 'ProviderConfigMissingError',
      }),
    )
  })

  it('withholds tools from Ollama only, and names the endpoint origin', async () => {
    const host = createMemoryHost()
    const connector = createRunConnector({ host, providers: registry(), env: {}, log: () => {} })
    const origins: Record<string, string> = {}
    for (const providerId of [ANTHROPIC_PROVIDER_ID, ZHIPU_PROVIDER_ID, OLLAMA_PROVIDER_ID]) {
      const definition = registry().get(providerId)
      const model = definition?.builtinModels[0]
      // oxlint-disable-next-line no-await-in-loop -- one provider at a time: each reads the last origin
      const assembly = await connector.assemble({
        sessionId: 's',
        rootSessionId: 's',
        choice: {
          providerId,
          modelId: model?.id ?? 'local-model',
          effort: null,
          capabilitySource: model === undefined ? 'synthesized' : 'builtin',
        },
        signal: new AbortController().signal,
      })
      expect(assembly.toolsWithheld).toBe(
        providerId === OLLAMA_PROVIDER_ID ? 'provider-text-only' : null,
      )
      expect(assembly.search).toBeNull()
      expect(assembly.mcpSources).toEqual([])
      origins[providerId] = assembly.endpointOrigin
      // The synchronous read answers the origin the last assembly used.
      expect(connector.endpointOrigin(providerId)).toBe(assembly.endpointOrigin)
    }
    expect(origins[ANTHROPIC_PROVIDER_ID]).toBe('https://api.anthropic.com')
    expect(origins[ZHIPU_PROVIDER_ID]).toBe('https://open.bigmodel.cn')
  })

  it('answers endpointOrigin from config.json before any assembly, and follows each write (s9-spec-2)', async () => {
    // A resume after a restart writes its model_selected from this synchronous read before its
    // assemble runs: it must name the configured host, not the definition's default (§续跑
    // 「endpointOrigin 按实际发往的地址记」), or the next data-flow check compares with a wrong host.
    const host = createMemoryHost()
    await host.fs.mkdirp(host.identity.profileDir as AbsolutePath)
    await writeConfig(host.fs, host.identity, {
      providerConfig: { [ANTHROPIC_PROVIDER_ID]: { baseURL: 'http://127.0.0.1:4000' } },
    })
    // Built the way main builds it: with config.json as read at startup, before bindLoop.
    const connector = createRunConnector({
      host,
      providers: registry(),
      env: {},
      log: () => {},
      config: await readConfig(host.fs, host.identity),
    })
    expect(connector.endpointOrigin(ANTHROPIC_PROVIDER_ID)).toBe('http://127.0.0.1:4000')
    // Unconfigured providers answer their declared default; an unknown one nothing.
    expect(connector.endpointOrigin(ZHIPU_PROVIDER_ID)).toBe('https://open.bigmodel.cn')
    expect(connector.endpointOrigin('no-such-provider')).toBeNull()
    // A save moves it, with no assembly in between.
    await writeConfig(host.fs, host.identity, {
      providerConfig: { [ANTHROPIC_PROVIDER_ID]: { baseURL: 'https://relay.example/' } },
    })
    expect(connector.endpointOrigin(ANTHROPIC_PROVIDER_ID)).toBe('https://relay.example')
    // The development base URL counts where a send would take it, as assemble resolves it.
    const dev = createRunConnector({
      host: createMemoryHost(),
      providers: registry(),
      env: { ANTHROPIC_BASE_URL: 'http://localhost:8080/' },
      log: () => {},
    })
    expect(dev.endpointOrigin(ANTHROPIC_PROVIDER_ID)).toBe('http://localhost:8080')
  })

  it('keeps endpointOrigin on a save that landed during a read, not on the older file the read saw (s9-spec-2)', async () => {
    // A resolveChoice whose config read was slow must not put the snapshot back to what the file
    // held before a save that finished meanwhile: the next model_selected would name the old host.
    const memory = createMemoryHost()
    await memory.fs.mkdirp(memory.identity.profileDir as AbsolutePath)
    let hold: { reached: () => void; release: Promise<void> } | null = null
    const host: HostAdapter = {
      ...memory,
      fs: {
        ...memory.fs,
        readFile: async (path, opts) => {
          const data = await memory.fs.readFile(path, opts)
          const held = hold
          if (held !== null && path.endsWith('config.json')) {
            hold = null
            held.reached()
            await held.release
          }
          return data
        },
        stat: (path) => memory.fs.stat(path),
        readdir: (path) => memory.fs.readdir(path),
        mkdirp: (path) => memory.fs.mkdirp(path),
        realpath: (path) => memory.fs.realpath(path),
        writeFile: (path, data) => memory.fs.writeFile(path, data),
      },
    }
    await writeConfig(host.fs, host.identity, {
      providerConfig: { [ANTHROPIC_PROVIDER_ID]: { baseURL: 'http://127.0.0.1:4000' } },
    })
    const connector = createRunConnector({
      host,
      providers: registry(),
      env: {},
      log: () => {},
      config: await readConfig(host.fs, host.identity),
    })
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    hold = { reached: reached.resolve, release: release.promise }
    const resolving = connector.resolveChoice(choose)
    await reached.promise
    await writeConfig(host.fs, host.identity, {
      providerConfig: { [ANTHROPIC_PROVIDER_ID]: { baseURL: 'https://relay.example/' } },
    })
    release.resolve()
    await resolving
    expect(connector.endpointOrigin(ANTHROPIC_PROVIDER_ID)).toBe('https://relay.example')
  })

  it('moves endpointOrigin to where a send read a config.json edited by hand (旧 49)', async () => {
    // No write of this process announces a hand edit; the send's own read is what the snapshot
    // learns it from (§续跑「endpointOrigin 按实际发往的地址记」).
    const host = createMemoryHost()
    await host.fs.mkdirp(host.identity.profileDir as AbsolutePath)
    await writeConfig(host.fs, host.identity, {
      providerConfig: { [ANTHROPIC_PROVIDER_ID]: { baseURL: 'http://127.0.0.1:4000' } },
    })
    const connector = createRunConnector({
      host,
      providers: registry(),
      env: {},
      log: () => {},
      config: await readConfig(host.fs, host.identity),
    })
    const edited = {
      ...(await readConfig(host.fs, host.identity)),
      providerConfig: { [ANTHROPIC_PROVIDER_ID]: { baseURL: 'https://relay.example/' } },
    }
    await host.fs.writeFile(configPath(host.identity), JSON.stringify(edited))
    const assembly = await connector.assemble({
      sessionId: 's',
      rootSessionId: 's',
      choice: {
        providerId: ANTHROPIC_PROVIDER_ID,
        modelId: 'claude-sonnet-5',
        effort: null,
        capabilitySource: 'builtin',
      },
      signal: new AbortController().signal,
    })
    expect(assembly.endpointOrigin).toBe('https://relay.example')
    expect(connector.endpointOrigin(ANTHROPIC_PROVIDER_ID)).toBe('https://relay.example')
  })

  describe('a keychain read that other writes overlap (rrE-2)', () => {
    const choice = {
      providerId: ANTHROPIC_PROVIDER_ID,
      modelId: 'claude-sonnet-5',
      effort: null,
      capabilitySource: 'builtin' as const,
    }
    const secretCount = anthropic().configKeys.filter((key) => key.secret).length

    /**
     * Anthropic at a.example with a keychain key, and a keychain whose every get first runs
     * `during(n)` — a save landing while the send waits on the keychain (an unanswered prompt).
     */
    async function overlapped(during: (n: number, host: HostAdapter) => Promise<void>): Promise<{
      host: HostAdapter
      connector: ReturnType<typeof createRunConnector>
      gets: () => number
    }> {
      const memory = createMemoryHost()
      await memory.fs.mkdirp(memory.identity.profileDir as AbsolutePath)
      await writeConfig(memory.fs, memory.identity, {
        providerConfig: { [ANTHROPIC_PROVIDER_ID]: { baseURL: 'https://a.example' } },
      })
      await memory.secrets.set(
        keyFor(memory.identity, 'provider', ANTHROPIC_PROVIDER_ID, 'apiKey'),
        'sk-a',
      )
      let gets = 0
      const host: HostAdapter = {
        ...memory,
        secrets: {
          get: async (key) => {
            gets += 1
            await during(gets, memory)
            return memory.secrets.get(key)
          },
          set: (key, value) => memory.secrets.set(key, value),
          delete: (key) => memory.secrets.delete(key),
        },
      }
      const connector = createRunConnector({
        host,
        providers: registry(),
        env: {},
        log: () => {},
        config: await readConfig(host.fs, host.identity),
      })
      return { host, connector, gets: () => gets }
    }

    const assemble = (connector: ReturnType<typeof createRunConnector>) =>
      connector.assemble({
        sessionId: 's',
        rootSessionId: 's',
        choice,
        signal: new AbortController().signal,
      })

    it('neither reads the keychain again nor refuses the send for writes that are not its settings', async () => {
      // A held round's release writes defaultModelByProfile while its prebuild reads the keychain
      // (model-routes.ts); the locale, the sidebar and the folder list are saved at any time. None
      // of them moves where this provider sends, so none unsettles the read (01 修补 6「key 绑定主机」).
      const unrelated = [
        { locale: 'en' as const },
        { sidebarCollapsed: true },
        { lastWorkspaceFolders: ['/w'] },
        { defaultModelByProfile: { chat: { id: ZHIPU_PROVIDER_ID, modelId: 'glm-4.6' } } },
      ]
      const { connector, gets } = await overlapped(async (n, host) => {
        await writeConfig(host.fs, host.identity, unrelated[(n - 1) % unrelated.length] ?? {})
      })
      const assembly = await assemble(connector)
      expect(() => assembly.provider()).not.toThrow()
      expect(gets()).toBe(secretCount)
      expect(assembly.endpointOrigin).toBe('https://a.example')
    })

    it("keeps another provider's save made during the read in the endpointOrigin snapshot", async () => {
      // The read's own config.json predates that save: kept as the snapshot, it would roll the other
      // provider back to where it sent before, and its next model_selected would name that host.
      const { connector, gets } = await overlapped(async (n, host) => {
        if (n !== 1) return
        const { providerConfig } = await readConfig(host.fs, host.identity)
        await writeConfig(host.fs, host.identity, {
          providerConfig: {
            ...providerConfig,
            [ZHIPU_PROVIDER_ID]: { baseURL: 'https://z.example' },
          },
        })
      })
      const assembly = await assemble(connector)
      expect(() => assembly.provider()).not.toThrow()
      expect(gets()).toBe(secretCount)
      expect(connector.endpointOrigin(ZHIPU_PROVIDER_ID)).toBe('https://z.example')
      expect(connector.endpointOrigin(ANTHROPIC_PROVIDER_ID)).toBe('https://a.example')
    })

    it('answers endpointOrigin from the newest save after a read its own saves never let settle', async () => {
      // One save moving this provider's host in each attempt: the send is refused, and the config
      // the last attempt read — older than the save that landed during it — is not remembered.
      const { host, connector } = await overlapped(async (n, h) => {
        if ((n - 1) % secretCount !== 0) return // the first get of each attempt
        await writeConfig(h.fs, h.identity, {
          providerConfig: { [ANTHROPIC_PROVIDER_ID]: { baseURL: `https://b${String(n)}.example` } },
        })
      })
      const assembly = await assemble(connector)
      expect(() => assembly.provider()).toThrow(
        expect.objectContaining({ key: 'a key read while no save was moving its host' }),
      )
      const onDisk = (await readConfig(host.fs, host.identity)).providerConfig[
        ANTHROPIC_PROVIDER_ID
      ]
      expect(onDisk?.baseURL).toBe(`https://b${String(2 * secretCount + 1)}.example`)
      expect(connector.endpointOrigin(ANTHROPIC_PROVIDER_ID)).toBe(onDisk?.baseURL)
    })
  })

  it('says where the model came from, and lets the session choice through untouched', async () => {
    const connector = createRunConnector({
      host: createMemoryHost(),
      providers: registry(),
      env: { [MODEL_ENV]: 'gateway/unknown-model' },
      log: () => {},
    })
    expect(await connector.resolveChoice(choose)).toMatchObject({
      providerId: ANTHROPIC_PROVIDER_ID,
      modelId: 'gateway/unknown-model',
      effort: null,
      capabilitySource: 'synthesized',
    })
    const builtin = createRunConnector({
      host: createMemoryHost(),
      providers: registry(),
      env: {},
      log: () => {},
    })
    expect(await builtin.resolveChoice(choose)).toMatchObject({ capabilitySource: 'builtin' })
    const session = {
      providerId: ZHIPU_PROVIDER_ID,
      modelId: 'glm-4.6',
      effort: 'high',
      capabilitySource: 'builtin' as const,
    }
    expect(await builtin.resolveChoice({ ...choose, sessionChoice: session })).toBe(session)
  })
})
