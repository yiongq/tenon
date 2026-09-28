/**
 * Choosing a model (spec 02 §模型选择, §表外模型与不发工具, 01 修补 6; plan step 19): the five layers
 * and the data-flow check in the Run connector (旧 107, 旧 184's connector half), the key bound to
 * its host (旧 49, 旧 109), what `provider.list` gives the menu, and the two session routes.
 */
import {
  ANTHROPIC_PROVIDER_ID,
  OLLAMA_PROVIDER_ID,
  ProviderConfigMissingError,
  ZHIPU_PROVIDER_ID,
  createMemoryHost,
  createMemoryTapeStore,
  createProviderRegistry,
  createSessionService,
  keyFor,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type {
  AbsolutePath,
  HostAdapter,
  HostSecrets,
  ModelChoice,
  ProviderRegistry,
  SessionService,
} from '@tenon-app/kernel'
import type { IpcMainLike, ProviderEntryContract } from '@tenon-app/contracts'
import { createCounterIds, createTestLoopPorts } from '@tenon-app/kernel/testing'
import { describe, expect, it } from 'vitest'
import { readConfig, writeConfig } from '../src/main/host/profile.js'
import { registerModelRoutes } from '../src/main/model-routes.js'
import { registerProviderRoutes } from '../src/main/provider-routes.js'
import { createRunConnector } from '../src/main/run-assembly.js'
import { startFakeAnthropic } from './support/fake-anthropic.js'

const SESSION = '5c1d9a2e-6b3d-4a71-9f52-0c8de7a11b91'
const KEY = 'sk-bound-key-1'

type Handler = (event: unknown, payload: unknown) => unknown

function registry(): ProviderRegistry {
  const providers = createProviderRegistry()
  registerBuiltinProviders(providers)
  return providers
}

async function freshHost(secrets?: HostSecrets): Promise<HostAdapter> {
  const memory = createMemoryHost()
  const host: HostAdapter = secrets === undefined ? memory : { ...memory, secrets }
  await host.fs.mkdirp(host.identity.profileDir as AbsolutePath)
  return host
}

function secretKey(host: HostAdapter, providerId: string, name: string): string {
  return keyFor(host.identity, 'provider', providerId, name)
}

interface Routes {
  readonly host: HostAdapter
  call(channel: string, payload: unknown): Promise<unknown>
  list(): Promise<ProviderEntryContract[]>
}

async function routes(
  o: {
    host?: HostAdapter
    env?: Record<string, string>
    isPackaged?: boolean
    sessions?: SessionService | null
    gate?: Promise<void>
  } = {},
): Promise<Routes> {
  const host = o.host ?? (await freshHost())
  const handlers = new Map<string, Handler>()
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener as Handler)
    },
  }
  const providers = registry()
  registerProviderRoutes({
    ipcMain,
    host,
    providers,
    env: o.env ?? {},
    isPackaged: o.isPackaged ?? false,
    log: () => {},
  })
  registerModelRoutes({
    ipcMain,
    sessions: o.sessions ?? null,
    providers,
    host,
    ...(o.gate === undefined ? {} : { gate: o.gate }),
  })
  const call = async (channel: string, payload: unknown): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error(`no handler for ${channel}`)
    return handler({}, payload)
  }
  return {
    host,
    call,
    async list() {
      const result = (await call('provider.list', {})) as {
        ok: boolean
        data: ProviderEntryContract[]
      }
      expect(result.ok).toBe(true)
      return result.data
    },
  }
}

const entryOf = (entries: readonly ProviderEntryContract[], id: string): ProviderEntryContract => {
  const found = entries.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no ${id}`)
  return found
}

describe('provider.list for the menu (01 修补 6)', () => {
  it('marks, lists and names each row, with its levels and where the provider sends', async () => {
    const r = await routes()
    const entries = await r.list()
    const anthropic = entryOf(entries, ANTHROPIC_PROVIDER_ID)
    expect(anthropic.endpoint).toEqual({ host: 'api.anthropic.com', reach: 'public' })
    const sonnet = anthropic.models.find((row) => row.id === 'claude-sonnet-5')
    expect(sonnet).toMatchObject({
      mark: 'verified',
      listing: 'main',
      purposeKey: 'model.purpose.sonnet5',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    })
    // Opus 5 is legacy, under 更多模型 ›; Haiku 4.5 thinks on a budget and has no submenu (旧 186).
    expect(anthropic.models.find((row) => row.id === 'claude-opus-5')?.listing).toBe('more')
    expect(
      anthropic.models.find((row) => row.id.startsWith('claude-haiku'))?.effortLevels,
    ).toBeUndefined()
    const zhipu = entryOf(entries, ZHIPU_PROVIDER_ID)
    expect(zhipu.models.find((row) => row.id === 'glm-5.3-flash')?.effortLevels).toEqual([
      'low',
      'high',
      'max',
    ])
    expect(zhipu.models.find((row) => row.id === 'glm-4.6')?.effortLevels).toBeUndefined()
    const ollama = entryOf(entries, OLLAMA_PROVIDER_ID)
    expect(ollama.endpoint).toEqual({ host: 'localhost', reach: 'loopback' })
    expect(ollama.models.every((row) => row.mark === 'local-text-only')).toBe(true)
    expect(ollama.models.find((row) => row.id === 'qwen3:8b')?.effortLevels).toBeUndefined()
    // The new user's fallback, a definition's first row, is never under 更多模型 ›.
    expect(entries.every((entry) => entry.models[0]?.listing !== 'more')).toBe(true)
  })

  it('names a private Ollama host by its address, not as this computer (旧 185)', async () => {
    const r = await routes()
    await writeConfig(r.host.fs, r.host.identity, {
      providerConfig: { [OLLAMA_PROVIDER_ID]: { baseURL: 'http://192.168.1.20:11434/v1/' } },
    })
    expect(entryOf(await r.list(), OLLAMA_PROVIDER_ID).endpoint).toEqual({
      host: '192.168.1.20',
      reach: 'private',
    })
  })
})

describe('「已配置」 is what this build can use (旧 109)', () => {
  it('counts an environment key on a development build only', async () => {
    const env = { ANTHROPIC_API_KEY: KEY }
    const dev = await routes({ env, isPackaged: false })
    expect(entryOf(await dev.list(), ANTHROPIC_PROVIDER_ID).configured).toBe(true)
    const packaged = await routes({ env, isPackaged: true })
    const entry = entryOf(await packaged.list(), ANTHROPIC_PROVIDER_ID)
    expect(entry.configured).toBe(false)
    expect(entry.configKeys.find((key) => key.name === 'apiKey')?.configured).toBe(false)
  })

  it('does not count a key bound to another host than the one the provider sends to', async () => {
    const host = await freshHost()
    await host.secrets.set(secretKey(host, ANTHROPIC_PROVIDER_ID, 'apiKey'), KEY)
    // The keychain key belongs to the stored (here: default) base URL; the dev variable moves the
    // endpoint elsewhere, so a send would be refused, and the card must not claim it is ready.
    const r = await routes({ host, env: { ANTHROPIC_BASE_URL: 'https://relay.example/' } })
    const entry = entryOf(await r.list(), ANTHROPIC_PROVIDER_ID)
    expect(entry.configKeys.find((key) => key.name === 'apiKey')?.configured).toBe(false)
    expect(entry.configured).toBe(false)
  })

  it('is not ready while one of two keys is bound elsewhere, as the send refuses it (s19-spec-3)', async () => {
    // The keychain apiKey belongs to the default host; the dev authToken to the relay the dev base
    // URL names. The send refuses while any present key is unbound (step 19's reading ③), so the
    // menu must not list the provider as ready although one credential is usable.
    const host = await freshHost()
    await host.secrets.set(secretKey(host, ANTHROPIC_PROVIDER_ID, 'apiKey'), KEY)
    const env = { ANTHROPIC_AUTH_TOKEN: 'tok-relay', ANTHROPIC_BASE_URL: 'https://relay.example/' }
    const entry = entryOf(await (await routes({ host, env })).list(), ANTHROPIC_PROVIDER_ID)
    expect(entry.configKeys.find((key) => key.name === 'apiKey')?.configured).toBe(false)
    expect(entry.configKeys.find((key) => key.name === 'authToken')?.configured).toBe(true)
    expect(entry.configured).toBe(false)
    const assembly = await createRunConnector({ host, providers: registry(), env }).assemble({
      sessionId: SESSION,
      rootSessionId: SESSION,
      choice: {
        providerId: ANTHROPIC_PROVIDER_ID,
        modelId: 'claude-sonnet-5',
        effort: null,
        capabilitySource: 'builtin',
      },
      signal: new AbortController().signal,
    })
    expect(() => assembly.provider()).toThrow(ProviderConfigMissingError)
  })
})

describe('02 不变量 4 / 02 不变量 5: the key is bound to its host (A9; 旧 49)', () => {
  it('refuses a save that moves the host without the stored key, and writes nothing', async () => {
    const r = await routes()
    await r.host.secrets.set(secretKey(r.host, ZHIPU_PROVIDER_ID, 'apiKey'), KEY)
    expect(
      await r.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { baseURL: 'https://gateway.example/api/paas/v4/' },
      }),
    ).toEqual({ ok: true, data: { ok: false, code: 'key-host-binding', configKey: 'baseURL' } })
    expect(await r.host.secrets.get(secretKey(r.host, ZHIPU_PROVIDER_ID, 'apiKey'))).toBe(KEY)
    expect((await readConfig(r.host.fs, r.host.identity)).providerConfig).toEqual({})
    // With the key typed again, the move goes through and the key is the new one.
    expect(
      await r.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { baseURL: 'https://gateway.example/api/paas/v4/', apiKey: 'sk-new' },
      }),
    ).toEqual({ ok: true, data: { ok: true } })
    expect(await r.host.secrets.get(secretKey(r.host, ZHIPU_PROVIDER_ID, 'apiKey'))).toBe('sk-new')
  })

  it('asks for every stored credential of Anthropic, and refuses ollama.com for Ollama', async () => {
    const r = await routes()
    await r.host.secrets.set(secretKey(r.host, ANTHROPIC_PROVIDER_ID, 'apiKey'), KEY)
    await r.host.secrets.set(secretKey(r.host, ANTHROPIC_PROVIDER_ID, 'authToken'), 'tok')
    const move = { baseURL: 'https://relay.example/' }
    expect(
      await r.call('provider.configure', {
        id: ANTHROPIC_PROVIDER_ID,
        values: { ...move, apiKey: 'sk-new' },
      }),
    ).toMatchObject({ data: { ok: false, code: 'key-host-binding' } })
    expect(
      await r.call('provider.configure', {
        id: ANTHROPIC_PROVIDER_ID,
        values: { ...move, apiKey: 'sk-new', authToken: '' },
      }),
    ).toEqual({ ok: true, data: { ok: true } })
    expect(
      await r.host.secrets.get(secretKey(r.host, ANTHROPIC_PROVIDER_ID, 'authToken')),
    ).toBeNull()
    // The fully qualified spellings are the same hosts (s19-safety-6).
    for (const baseURL of [
      'https://ollama.com/v1/',
      'https://eu.ollama.com/v1/',
      'https://ollama.com./v1/',
      'https://api.ollama.com.:443/v1/',
    ]) {
      expect(
        // oxlint-disable-next-line no-await-in-loop -- one save at a time
        await r.call('provider.configure', { id: OLLAMA_PROVIDER_ID, values: { baseURL } }),
      ).toMatchObject({ data: { ok: false, code: 'key-host-binding', configKey: 'baseURL' } })
    }
  })

  it('stops with no key when the new key cannot be stored, and the send is then refused', async () => {
    const store = new Map<string, string>()
    const secrets: HostSecrets = {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      set: (key, value) => {
        // A keychain that refuses a value this large (2560 bytes on some platforms).
        if (value.length > 2560) return Promise.reject(new Error('the value is too large'))
        store.set(key, value)
        return Promise.resolve()
      },
      delete: (key) => {
        store.delete(key)
        return Promise.resolve()
      },
    }
    const host = await freshHost(secrets)
    const r = await routes({ host })
    store.set(secretKey(host, ZHIPU_PROVIDER_ID, 'apiKey'), KEY)
    const result = await r.call('provider.configure', {
      id: ZHIPU_PROVIDER_ID,
      values: { baseURL: 'https://gateway.example/api/paas/v4/', apiKey: 'x'.repeat(3000) },
    })
    expect(result).toMatchObject({ ok: false })
    expect(store.size).toBe(0)
    expect(
      (await readConfig(host.fs, host.identity)).providerConfig[ZHIPU_PROVIDER_ID]?.['baseURL'],
    ).toBe('https://gateway.example/api/paas/v4/')
    // No key: a send is a configuration error, and nothing reaches the network.
    let requests = 0
    const connector = createRunConnector({
      host: {
        ...host,
        network: {
          fetchUntrusted: createMemoryHost().network.fetchUntrusted,
          fetch: () => ((requests += 1), Promise.reject(new Error('no'))),
        },
      } as HostAdapter,
      providers: registry(),
      env: {},
    })
    const choice: ModelChoice = {
      providerId: ZHIPU_PROVIDER_ID,
      modelId: 'glm-5.3-flash',
      effort: null,
      capabilitySource: 'builtin',
    }
    const assembly = await connector.assemble({
      sessionId: SESSION,
      rootSessionId: SESSION,
      choice,
      signal: new AbortController().signal,
    })
    expect(() => assembly.provider()).toThrow(ProviderConfigMissingError)
    expect(requests).toBe(0)
  })

  it('stops with no key when the second of two new keys cannot be stored (s19-spec-4)', async () => {
    const store = new Map<string, string>()
    const secrets: HostSecrets = {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      set: (key, value) => {
        if (value.length > 2560) return Promise.reject(new Error('the value is too large'))
        store.set(key, value)
        return Promise.resolve()
      },
      delete: (key) => {
        store.delete(key)
        return Promise.resolve()
      },
    }
    const host = await freshHost(secrets)
    const r = await routes({ host })
    store.set(secretKey(host, ANTHROPIC_PROVIDER_ID, 'apiKey'), KEY)
    // apiKey is declared first and stores; authToken is over the keychain's limit and fails.
    const result = await r.call('provider.configure', {
      id: ANTHROPIC_PROVIDER_ID,
      values: { baseURL: 'https://relay.example/', apiKey: 'sk-new', authToken: 'x'.repeat(3000) },
    })
    expect(result).toMatchObject({ ok: false })
    expect([...store.keys()]).toEqual([])
    expect(
      (await readConfig(host.fs, host.identity)).providerConfig[ANTHROPIC_PROVIDER_ID]?.['baseURL'],
    ).toBe('https://relay.example/')
  })

  it('stops with no key and the old host when config.json cannot be written after the delete', async () => {
    const memory = createMemoryHost()
    await memory.fs.mkdirp(memory.identity.profileDir as AbsolutePath)
    let failWrite = false
    const host: HostAdapter = {
      ...memory,
      fs: {
        ...memory.fs,
        readFile: (path, opts) => memory.fs.readFile(path, opts),
        stat: (path) => memory.fs.stat(path),
        readdir: (path) => memory.fs.readdir(path),
        mkdirp: (path) => memory.fs.mkdirp(path),
        realpath: (path) => memory.fs.realpath(path),
        writeFile: (path, data) =>
          failWrite
            ? Promise.reject(new Error('the disk is full'))
            : memory.fs.writeFile(path, data),
      },
    }
    const r = await routes({ host })
    await host.secrets.set(secretKey(host, ZHIPU_PROVIDER_ID, 'apiKey'), KEY)
    failWrite = true
    const result = await r.call('provider.configure', {
      id: ZHIPU_PROVIDER_ID,
      values: { baseURL: 'https://gateway.example/api/paas/v4/', apiKey: 'sk-new' },
    })
    expect(result).toMatchObject({ ok: false })
    expect(await host.secrets.get(secretKey(host, ZHIPU_PROVIDER_ID, 'apiKey'))).toBeNull()
    expect((await readConfig(host.fs, host.identity)).providerConfig).toEqual({})
  })

  it('keeps each key paired with its host when two saves overlap', async () => {
    const r = await routes()
    await Promise.all([
      r.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { baseURL: 'https://one.example/api/paas/v4/', apiKey: 'sk-one' },
      }),
      r.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { baseURL: 'https://two.example/api/paas/v4/', apiKey: 'sk-two' },
      }),
    ])
    const baseURL = (await readConfig(r.host.fs, r.host.identity)).providerConfig[
      ZHIPU_PROVIDER_ID
    ]?.['baseURL']
    const key = await r.host.secrets.get(secretKey(r.host, ZHIPU_PROVIDER_ID, 'apiKey'))
    expect([baseURL, key]).toEqual(
      baseURL?.includes('two') === true
        ? ['https://two.example/api/paas/v4/', 'sk-two']
        : ['https://one.example/api/paas/v4/', 'sk-one'],
    )
  })

  it('refuses a move while the keychain cannot be read, before config.json is touched', async () => {
    const secrets: HostSecrets = {
      get: () => Promise.reject(new Error('the keychain is locked')),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    }
    const host = await freshHost(secrets)
    const r = await routes({ host })
    expect(
      await r.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { baseURL: 'https://gateway.example/api/paas/v4/' },
      }),
    ).toMatchObject({ data: { ok: false, code: 'key-host-binding' } })
    expect((await readConfig(host.fs, host.identity)).providerConfig).toEqual({})
  })

  it('refuses a move while the keychain cannot be cleared, before config.json is touched', async () => {
    // 「钥匙串读或删出错就整次拒绝、不写 config.json」: the key stays with the host it was saved for.
    const store = new Map<string, string>()
    const secrets: HostSecrets = {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      set: (key, value) => {
        store.set(key, value)
        return Promise.resolve()
      },
      delete: () => Promise.reject(new Error('the keychain is locked')),
    }
    const host = await freshHost(secrets)
    const r = await routes({ host })
    store.set(secretKey(host, ZHIPU_PROVIDER_ID, 'apiKey'), KEY)
    expect(
      await r.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { baseURL: 'https://gateway.example/api/paas/v4/', apiKey: 'sk-new' },
      }),
    ).toEqual({ ok: true, data: { ok: false, code: 'key-host-binding', configKey: 'baseURL' } })
    expect((await readConfig(host.fs, host.identity)).providerConfig).toEqual({})
    expect(store.get(secretKey(host, ZHIPU_PROVIDER_ID, 'apiKey'))).toBe(KEY)
  })

  it('asks for no key again when a save keeps the stored host (01 修补 6「key 绑定主机」)', async () => {
    // The host a key is bound to is the STORED base URL's, not the declared default's: a new path
    // on the same relay is no move.
    const r = await routes()
    await writeConfig(r.host.fs, r.host.identity, {
      providerConfig: { [ZHIPU_PROVIDER_ID]: { baseURL: 'https://gateway.example/api/paas/v4/' } },
    })
    await r.host.secrets.set(secretKey(r.host, ZHIPU_PROVIDER_ID, 'apiKey'), KEY)
    expect(
      await r.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { baseURL: 'https://gateway.example/v4/' },
      }),
    ).toEqual({ ok: true, data: { ok: true } })
    expect(await r.host.secrets.get(secretKey(r.host, ZHIPU_PROVIDER_ID, 'apiKey'))).toBe(KEY)
    expect(
      (await readConfig(r.host.fs, r.host.identity)).providerConfig[ZHIPU_PROVIDER_ID]?.['baseURL'],
    ).toBe('https://gateway.example/v4/')
  })

  it('refuses a send with a key bound elsewhere, before any request (发送前再核一次)', async () => {
    const host = await freshHost()
    await host.secrets.set(secretKey(host, ANTHROPIC_PROVIDER_ID, 'apiKey'), KEY)
    let requests = 0
    const connector = createRunConnector({
      host: {
        ...host,
        network: {
          fetchUntrusted: createMemoryHost().network.fetchUntrusted,
          fetch: () => ((requests += 1), Promise.reject(new Error('no'))),
        },
      } as HostAdapter,
      providers: registry(),
      env: { ANTHROPIC_BASE_URL: 'https://relay.example/' },
    })
    const assembly = await connector.assemble({
      sessionId: SESSION,
      rootSessionId: SESSION,
      choice: {
        providerId: ANTHROPIC_PROVIDER_ID,
        modelId: 'claude-sonnet-5',
        effort: null,
        capabilitySource: 'builtin',
      },
      signal: new AbortController().signal,
    })
    expect(() => assembly.provider()).toThrow(ProviderConfigMissingError)
    expect(requests).toBe(0)
  })
})

describe('a send reads the key and its host as one save left them (s19-safety-5)', () => {
  it('never pairs a key a save stored for the new host with the old base URL', async () => {
    // The keychain read of a send held open (an unanswered prompt) while a save moves the host:
    // 01 修补 6 「由上面的保存规则与锁保证 key 与地址始终配对」 must hold on the read side too.
    const store = new Map<string, string>()
    const reached = Promise.withResolvers<void>()
    const hold = Promise.withResolvers<void>()
    let first = true
    const secrets: HostSecrets = {
      get: async (key) => {
        if (first) {
          first = false
          reached.resolve()
          await hold.promise
        }
        return store.get(key) ?? null
      },
      set: (key, value) => {
        store.set(key, value)
        return Promise.resolve()
      },
      delete: (key) => {
        store.delete(key)
        return Promise.resolve()
      },
    }
    const host = await freshHost(secrets)
    await writeConfig(host.fs, host.identity, {
      providerConfig: { [ZHIPU_PROVIDER_ID]: { baseURL: 'https://a.example/api/paas/v4/' } },
    })
    store.set(secretKey(host, ZHIPU_PROVIDER_ID, 'apiKey'), 'sk-for-A')
    const sent: Array<{ url: string; auth: string | null }> = []
    const connector = createRunConnector({
      host: {
        ...host,
        network: {
          fetchUntrusted: createMemoryHost().network.fetchUntrusted,
          fetch: (input, init) => {
            sent.push({
              url: String(input),
              auth: new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get(
                'authorization',
              ),
            })
            return Promise.reject(new Error('offline'))
          },
        },
      } as HostAdapter,
      providers: registry(),
      env: {},
    })
    const assembling = connector.assemble({
      sessionId: SESSION,
      rootSessionId: SESSION,
      choice: {
        providerId: ZHIPU_PROVIDER_ID,
        modelId: 'glm-5.3-flash',
        effort: null,
        capabilitySource: 'builtin',
      },
      signal: new AbortController().signal,
    })
    await reached.promise
    const r = await routes({ host })
    expect(
      await r.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { baseURL: 'https://b.example/api/paas/v4/', apiKey: 'sk-for-B' },
      }),
    ).toEqual({ ok: true, data: { ok: true } })
    hold.resolve()
    const assembly = await assembling
    expect(assembly.endpointOrigin).toBe('https://b.example')
    const provider = assembly.provider()
    const encoded = provider.encode({
      model: assembly.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 16,
    })
    try {
      for await (const event of provider.stream(encoded, {
        identity: { runId: 'r1', requestSeq: 1, physicalAttempt: 1 },
      })) {
        if (event.type === 'error') break
      }
    } catch {
      // Offline on purpose: only where it went, and with which key, matters.
    }
    expect(sent.length).toBeGreaterThan(0)
    for (const request of sent) {
      expect(request.url.startsWith('https://b.example/')).toBe(true)
      expect(request.auth).toBe('Bearer sk-for-B')
    }
  })

  it('refuses the send, before any request, while saves keep moving its host during every read', async () => {
    // readSettledInputs gives up after its attempts with `settled: false`: a key that no single
    // save left beside this base URL is a configuration error, never a request.
    const store = new Map<string, string>()
    let host: HostAdapter | null = null
    let saves = 0
    const settings = { [ZHIPU_PROVIDER_ID]: { baseURL: 'https://a.example/api/paas/v4/' } }
    const secrets: HostSecrets = {
      get: async (key) => {
        // Another save moves this provider's host while the keychain is read. A save that leaves
        // its settings as they were cannot unpair a key from them, and does not count (rrE-2).
        if (host !== null) {
          saves += 1
          const baseURL = `https://a${String(saves)}.example/api/paas/v4/`
          await writeConfig(host.fs, host.identity, {
            providerConfig: { [ZHIPU_PROVIDER_ID]: { baseURL } },
          })
        }
        return store.get(key) ?? null
      },
      set: (key, value) => {
        store.set(key, value)
        return Promise.resolve()
      },
      delete: (key) => {
        store.delete(key)
        return Promise.resolve()
      },
    }
    host = await freshHost(secrets)
    await writeConfig(host.fs, host.identity, { providerConfig: settings })
    store.set(secretKey(host, ZHIPU_PROVIDER_ID, 'apiKey'), 'sk-for-A')
    let requests = 0
    const connector = createRunConnector({
      host: {
        ...host,
        network: {
          fetchUntrusted: createMemoryHost().network.fetchUntrusted,
          fetch: () => ((requests += 1), Promise.reject(new Error('no'))),
        },
      } as HostAdapter,
      providers: registry(),
      env: {},
    })
    const assembly = await connector.assemble({
      sessionId: SESSION,
      rootSessionId: SESSION,
      choice: {
        providerId: ZHIPU_PROVIDER_ID,
        modelId: 'glm-5.3-flash',
        effort: null,
        capabilitySource: 'builtin',
      },
      signal: new AbortController().signal,
    })
    expect(() => assembly.provider()).toThrow(
      expect.objectContaining({
        name: 'ProviderConfigMissingError',
        key: 'a key read while no save was moving its host',
      }),
    )
    expect(requests).toBe(0)
  })
})

describe('an environment key and a stored base URL on another host (旧 49, s19-spec-9)', () => {
  it('refuses the send before any request, and does not count the key as configured', async () => {
    // 01 修补 6: an environment key is valid for the environment's base URL or the default only —
    // never for a host config.json names.
    const host = await freshHost()
    await writeConfig(host.fs, host.identity, {
      providerConfig: { [ANTHROPIC_PROVIDER_ID]: { baseURL: 'https://relay.example/' } },
    })
    const env = { ANTHROPIC_API_KEY: KEY }
    let requests = 0
    const connector = createRunConnector({
      host: {
        ...host,
        network: {
          fetchUntrusted: createMemoryHost().network.fetchUntrusted,
          fetch: () => ((requests += 1), Promise.reject(new Error('no'))),
        },
      } as HostAdapter,
      providers: registry(),
      env,
    })
    const assembly = await connector.assemble({
      sessionId: SESSION,
      rootSessionId: SESSION,
      choice: {
        providerId: ANTHROPIC_PROVIDER_ID,
        modelId: 'claude-sonnet-5',
        effort: null,
        capabilitySource: 'builtin',
      },
      signal: new AbortController().signal,
    })
    expect(() => assembly.provider()).toThrow(ProviderConfigMissingError)
    expect(requests).toBe(0)
    const entry = entryOf(await (await routes({ host, env })).list(), ANTHROPIC_PROVIDER_ID)
    expect(entry.configKeys.find((key) => key.name === 'apiKey')?.configured).toBe(false)
    expect(entry.configured).toBe(false)
  })
})

describe('the five layers and the data-flow check (旧 107, 旧 184)', () => {
  async function resolve(
    o: {
      config?: Parameters<typeof writeConfig>[2]
      env?: Record<string, string>
      profile?: 'chat' | 'cowork'
      sessionChoice?: ModelChoice | null
      previousOrigin?: string | null
    } = {},
  ): Promise<unknown> {
    const host = await freshHost()
    if (o.config !== undefined) await writeConfig(host.fs, host.identity, o.config)
    const connector = createRunConnector({ host, providers: registry(), env: o.env ?? {} })
    return connector.resolveChoice({
      sessionId: SESSION,
      profile: o.profile ?? 'chat',
      sessionChoice: o.sessionChoice ?? null,
      previousOrigin: o.previousOrigin ?? null,
    })
  }
  const flash = { id: ZHIPU_PROVIDER_ID, modelId: 'glm-5.3-flash' }
  const opus = { id: ANTHROPIC_PROVIDER_ID, modelId: 'claude-opus-5-5' }

  it('takes ① the session, ② the profile default, ③ provider, ④ the dev variables, ⑤ the first row', async () => {
    const own: ModelChoice = {
      providerId: OLLAMA_PROVIDER_ID,
      modelId: 'qwen3:8b',
      effort: null,
      capabilitySource: 'builtin',
    }
    expect(await resolve({ sessionChoice: own, config: { provider: flash } })).toEqual(own)
    expect(
      await resolve({
        profile: 'cowork',
        config: { provider: flash, defaultModelByProfile: { cowork: opus } },
      }),
    ).toMatchObject({ providerId: ANTHROPIC_PROVIDER_ID, modelId: 'claude-opus-5-5' })
    expect(
      await resolve({
        profile: 'chat',
        config: { provider: flash, defaultModelByProfile: { cowork: opus } },
      }),
    ).toMatchObject({ providerId: ZHIPU_PROVIDER_ID, modelId: 'glm-5.3-flash' })
    expect(
      await resolve({ env: { TENON_PROVIDER: ZHIPU_PROVIDER_ID, TENON_MODEL: 'glm-5.3-flashx' } }),
    ).toMatchObject({ providerId: ZHIPU_PROVIDER_ID, modelId: 'glm-5.3-flashx' })
    expect(await resolve()).toMatchObject({
      providerId: ANTHROPIC_PROVIDER_ID,
      modelId: 'claude-opus-5-5',
      effort: null,
      capabilitySource: 'builtin',
    })
    // A hand-typed default is the user's; a dev variable naming no row is a synthesis.
    expect(
      await resolve({
        config: { provider: { id: ZHIPU_PROVIDER_ID, modelId: 'glm-own', source: 'user' } },
      }),
    ).toMatchObject({ modelId: 'glm-own', capabilitySource: 'user' })
    expect(
      await resolve({ env: { TENON_PROVIDER: ZHIPU_PROVIDER_ID, TENON_MODEL: 'glm-dev-only' } }),
    ).toMatchObject({ modelId: 'glm-dev-only', capabilitySource: 'synthesized' })
  })

  it('asks before a default moves history from this machine or a private host to a public one', async () => {
    expect(await resolve({ previousOrigin: 'http://localhost:11434' })).toEqual({
      needsConfirm: { host: 'api.anthropic.com' },
    })
    expect(await resolve({ previousOrigin: 'http://192.168.1.20:11434' })).toEqual({
      needsConfirm: { host: 'api.anthropic.com' },
    })
    // Public to public, a fresh session, and a choice made in the menu are not asked about.
    expect(await resolve({ previousOrigin: 'https://open.bigmodel.cn' })).toMatchObject({
      providerId: ANTHROPIC_PROVIDER_ID,
    })
    expect(await resolve({ previousOrigin: null })).toMatchObject({
      providerId: ANTHROPIC_PROVIDER_ID,
    })
    expect(
      await resolve({
        previousOrigin: 'http://localhost:11434',
        sessionChoice: {
          providerId: ANTHROPIC_PROVIDER_ID,
          modelId: 'claude-sonnet-5',
          effort: null,
          capabilitySource: 'builtin',
        },
      }),
    ).toMatchObject({ providerId: ANTHROPIC_PROVIDER_ID })
  })

  it('reads a private host as the local side: this machine to a private network is not asked about (开放问题 11)', async () => {
    const ollamaDefault = { id: OLLAMA_PROVIDER_ID, modelId: 'qwen3:8b' }
    expect(
      await resolve({
        previousOrigin: 'http://localhost:11434',
        config: {
          provider: ollamaDefault,
          providerConfig: { [OLLAMA_PROVIDER_ID]: { baseURL: 'http://192.168.1.20:11434/v1/' } },
        },
      }),
    ).toMatchObject({ providerId: OLLAMA_PROVIDER_ID, modelId: 'qwen3:8b' })
  })

  it('compares with where the default sends now: the stored base URL, not the declared one (A9)', async () => {
    // Ollama's declared default is this machine; a stored public host is where the history would go.
    expect(
      await resolve({
        previousOrigin: 'http://localhost:11434',
        config: {
          provider: { id: OLLAMA_PROVIDER_ID, modelId: 'qwen3:8b' },
          providerConfig: { [OLLAMA_PROVIDER_ID]: { baseURL: 'https://gpu.example.com/v1/' } },
        },
      }),
    ).toEqual({ needsConfirm: { host: 'gpu.example.com' } })
    // And Anthropic's declared default is public, but a relay on this machine is not.
    expect(
      await resolve({
        previousOrigin: 'http://localhost:11434',
        config: {
          provider: { id: ANTHROPIC_PROVIDER_ID, modelId: 'claude-sonnet-5' },
          providerConfig: { [ANTHROPIC_PROVIDER_ID]: { baseURL: 'http://127.0.0.1:4000' } },
        },
      }),
    ).toMatchObject({ providerId: ANTHROPIC_PROVIDER_ID })
  })

  it('marks as the user’s only the hand-typed id it runs, not what TENON_MODEL filled in (旧 40, 旧 108)', async () => {
    // A blank hand-typed default (a hand-edited config.json) leaves the model to TENON_MODEL: a
    // synthesis the development variable named, not an id the user typed.
    expect(
      await resolve({
        config: { provider: { id: ZHIPU_PROVIDER_ID, modelId: ' ', source: 'user' } },
        env: { TENON_MODEL: 'glm-dev-only' },
      }),
    ).toMatchObject({
      providerId: ZHIPU_PROVIDER_ID,
      modelId: 'glm-dev-only',
      capabilitySource: 'synthesized',
    })
  })
})

describe('a hand-typed model (旧 40, 旧 108)', () => {
  it('runs on the conservative synthesis: no tools, no vision, no thinking', async () => {
    const host = await freshHost()
    const connector = createRunConnector({ host, providers: registry(), env: {} })
    const assembly = await connector.assemble({
      sessionId: SESSION,
      rootSessionId: SESSION,
      choice: {
        providerId: ZHIPU_PROVIDER_ID,
        modelId: 'glm-own',
        effort: null,
        capabilitySource: 'user',
      },
      signal: new AbortController().signal,
    })
    expect(assembly.capabilitySource).toBe('user')
    expect(assembly.endpointOrigin).toBe('https://open.bigmodel.cn')
    expect(assembly.model).toMatchObject({
      id: 'glm-own',
      supportsToolCalling: false,
      supportsVision: false,
      thinkingPreservationFormat: 'drop',
    })
    expect(assembly.model.thinkingSpec).toBeUndefined()
  })
})

describe('session.selectModel and session.modelChoice', () => {
  async function withSessions(
    o: {
      host?: HostAdapter
      gate?: Promise<void>
      /** Records each call the routes make into the session service. */
      asked?: string[]
    } = {},
  ): Promise<{ r: Routes; sessions: SessionService }> {
    const host = o.host ?? (await freshHost())
    const loop = createTestLoopPorts({})
    const sessions = createSessionService({
      host,
      tape: createMemoryTapeStore({ identity: host.identity }),
      ids: createCounterIds(),
      inspectors: [],
      connector: createRunConnector({ host, providers: registry(), env: {} }),
      protectedFiles: [],
    })
    sessions.bindLoop(loop)
    const asked = o.asked
    const seen: SessionService =
      asked === undefined
        ? sessions
        : {
            ...sessions,
            selectModel: (q) => (asked.push('selectModel'), sessions.selectModel(q)),
            effectiveModelChoice: (q) => (
              asked.push('effectiveModelChoice'),
              sessions.effectiveModelChoice(q)
            ),
          }
    return {
      r: await routes({
        host,
        sessions: seen,
        ...(o.gate === undefined ? {} : { gate: o.gate }),
      }),
      sessions,
    }
  }

  it('records the choice and the profile’s default and provider — never the level as a default', async () => {
    const { r, sessions } = await withSessions()
    await sessions.selectProfile({
      sessionId: SESSION,
      profile: 'cowork',
      dedicated: '/home/u/Tenon/workspaces/x' as AbsolutePath,
    })
    expect(
      await r.call('session.selectModel', {
        sessionId: SESSION,
        providerId: ZHIPU_PROVIDER_ID,
        modelId: 'glm-5.3-flash',
        effort: 'high',
      }),
    ).toEqual({ ok: true, data: { ok: true } })
    const config = await readConfig(r.host.fs, r.host.identity)
    expect(config.defaultModelByProfile).toEqual({
      cowork: { id: ZHIPU_PROVIDER_ID, modelId: 'glm-5.3-flash' },
    })
    expect(config.provider).toEqual({ id: ZHIPU_PROVIDER_ID, modelId: 'glm-5.3-flash' })
    expect(await r.call('session.modelChoice', { sessionId: SESSION })).toEqual({
      ok: true,
      data: {
        providerId: ZHIPU_PROVIDER_ID,
        modelId: 'glm-5.3-flash',
        effort: 'high',
        capabilitySource: 'builtin',
      },
    })
  })

  it('refuses a level the row does not list, and any level for a hand-typed id', async () => {
    const { r } = await withSessions()
    for (const [modelId, effort] of [
      ['glm-5.3-flash', 'medium'],
      ['glm-4.6', 'high'],
      ['glm-own', 'high'],
    ] as const) {
      expect(
        // oxlint-disable-next-line no-await-in-loop -- one choice at a time
        await r.call('session.selectModel', {
          sessionId: SESSION,
          providerId: ZHIPU_PROVIDER_ID,
          modelId,
          effort,
        }),
      ).toEqual({ ok: true, data: { ok: false, code: 'invalid-value', configKey: null } })
    }
    // A hand-typed id with no level is the user's (旧 40).
    await r.call('session.selectModel', {
      sessionId: SESSION,
      providerId: ZHIPU_PROVIDER_ID,
      modelId: 'glm-own',
      effort: null,
    })
    expect(await r.call('session.modelChoice', { sessionId: SESSION })).toMatchObject({
      data: { modelId: 'glm-own', capabilitySource: 'user' },
    })
  })

  it('answers neither route until startup recovery is done (plan step 19: 接启动恢复的闸)', async () => {
    const gate = Promise.withResolvers<void>()
    const asked: string[] = []
    const { r } = await withSessions({ gate: gate.promise, asked })
    let answered = 0
    const choosing = r
      .call('session.selectModel', {
        sessionId: SESSION,
        providerId: ZHIPU_PROVIDER_ID,
        modelId: 'glm-5.3-flash',
        effort: null,
      })
      .finally(() => (answered += 1))
    const reading = r
      .call('session.modelChoice', { sessionId: SESSION })
      .finally(() => (answered += 1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toEqual([])
    expect(answered).toBe(0)
    expect((await readConfig(r.host.fs, r.host.identity)).provider).toBeNull()
    gate.resolve()
    expect(await choosing).toEqual({ ok: true, data: { ok: true } })
    expect(await reading).toMatchObject({ ok: true })
    expect(asked.toSorted()).toEqual(['effectiveModelChoice', 'selectModel'])
  })

  it('writes each profile’s default in the profile’s lock: two choices at once keep both (每个 profile 一把主进程锁)', async () => {
    // The first choice's config read is held (a slow disk) while a second choice, in the other
    // profile, arrives: outside the lock the second would be overwritten by a patch built on the
    // first's stale read.
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
    const { r, sessions } = await withSessions({ host })
    const TASK = '7e2f0b1c-3d4a-4b5c-8d6e-9f0a1b2c3d4e'
    await sessions.selectProfile({
      sessionId: TASK,
      profile: 'cowork',
      dedicated: '/home/u/Tenon/workspaces/x' as AbsolutePath,
    })
    // Something read config.json before: the file exists, so each read goes through readFile.
    await writeConfig(host.fs, host.identity, { locale: 'en' })
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    hold = { reached: reached.resolve, release: release.promise }
    const first = r.call('session.selectModel', {
      sessionId: TASK,
      providerId: ANTHROPIC_PROVIDER_ID,
      modelId: 'claude-opus-5-5',
      effort: null,
    })
    await reached.promise
    const second = r.call('session.selectModel', {
      sessionId: SESSION,
      providerId: ZHIPU_PROVIDER_ID,
      modelId: 'glm-5.3-flash',
      effort: null,
    })
    await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 20))])
    release.resolve()
    expect(await first).toEqual({ ok: true, data: { ok: true } })
    expect(await second).toEqual({ ok: true, data: { ok: true } })
    expect((await readConfig(host.fs, host.identity)).defaultModelByProfile).toEqual({
      cowork: { id: ANTHROPIC_PROVIDER_ID, modelId: 'claude-opus-5-5' },
      chat: { id: ZHIPU_PROVIDER_ID, modelId: 'glm-5.3-flash' },
    })
  })

  it('falls back to the task default once a task session is cleared, not the chat’s (旧 37, 验收 33)', async () => {
    // The real connector's ② layer: a cleared cowork session carries its profile (resetSession's
    // carry) and no choice, so it reads `defaultModelByProfile.cowork` — not its own old choice, not
    // the chat default, not `provider`.
    const fake = await startFakeAnthropic({ chunks: ['ok'], delayMs: 1 })
    try {
      const memory = createMemoryHost({
        network: {
          fetchUntrusted: createMemoryHost().network.fetchUntrusted,
          fetch: (input, init) => globalThis.fetch(input, init),
        },
      })
      await memory.fs.mkdirp(memory.identity.profileDir as AbsolutePath)
      const host: HostAdapter = memory
      const env = { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: fake.baseURL }
      const loop = createTestLoopPorts({})
      const sessions = createSessionService({
        host,
        tape: createMemoryTapeStore({ identity: host.identity }),
        ids: createCounterIds(),
        inspectors: [],
        connector: createRunConnector({ host, providers: registry(), env }),
        protectedFiles: [],
      })
      sessions.bindLoop(loop)
      const r = await routes({ host, sessions, env })
      await sessions.selectProfile({
        sessionId: SESSION,
        profile: 'cowork',
        dedicated: '/home/u/Tenon/workspaces/x' as AbsolutePath,
      })
      await r.call('session.selectModel', {
        sessionId: SESSION,
        providerId: ANTHROPIC_PROVIDER_ID,
        modelId: 'claude-sonnet-5',
        effort: null,
      })
      const sent = await sessions.send({ sessionId: SESSION, origin: null, text: 'hello' })
      if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
      await loop.runEnded({ runId: sent.runId })
      // Another task's choice moved the task default since; the chat default is something else.
      const opus = { id: ANTHROPIC_PROVIDER_ID, modelId: 'claude-opus-5-5' }
      const haiku = { id: ANTHROPIC_PROVIDER_ID, modelId: 'claude-haiku-4-5-20251001' }
      await writeConfig(host.fs, host.identity, {
        provider: haiku,
        defaultModelByProfile: { chat: haiku, cowork: opus },
      })
      const modelOf = async (): Promise<unknown> =>
        ((await r.call('session.modelChoice', { sessionId: SESSION })) as { data: unknown }).data
      expect(await modelOf()).toMatchObject({ modelId: 'claude-sonnet-5' })
      await sessions.resetSession(SESSION)
      expect(await sessions.sessionFacts({ sessionId: SESSION })).toMatchObject({
        profile: 'cowork',
      })
      expect(await modelOf()).toMatchObject({ modelId: 'claude-opus-5-5' })
    } finally {
      await fake.close()
    }
  })
})
