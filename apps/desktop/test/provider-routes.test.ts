/**
 * The provider routes (spec 01 §desktop 接线, 验收 6).
 *
 * The security boundary first: a stored secret must not come back over IPC in any form. The rest
 * pins where each kind of value goes — keychain for secrets, `config.json` for the others — and
 * that a value no client could be built from is reported to the card instead of being written.
 * And M6 §点名 (a), (b), (c), (e) (验收 26, M6 不变量 16): zhipu and anthropic take their official
 * https origin only, zhipu no subscription path; an address in force outside them reads as not
 * configured, says why in `refused`, and a send sends nothing.
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
import type { AbsolutePath, FetchLike, HostAdapter, ProviderDefinition } from '@tenon-app/kernel'
import type { IpcMainLike, ProviderEntryContract } from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import { readConfig, writeConfig } from '../src/main/host/profile.js'
import { registerProviderRoutes } from '../src/main/provider-routes.js'
import { createRunConnector } from '../src/main/run-assembly.js'

type Handler = (event: unknown, ...args: unknown[]) => unknown

interface Harness {
  readonly host: HostAdapter
  call(channel: string, payload: unknown): Promise<unknown>
  list(): Promise<ProviderEntryContract[]>
  entry(id: string): Promise<ProviderEntryContract>
}

/**
 * The profile directory exists before main registers a route: `openProfile` creates it. `env` is a
 * development build's environment; `fetch` the host network's (the memory host's when absent).
 */
async function harness(
  extra: readonly ProviderDefinition[] = [],
  options: { env?: Record<string, string>; fetch?: FetchLike } = {},
): Promise<Harness> {
  const handlers = new Map<string, Handler>()
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
  }
  const memory = createMemoryHost()
  const host =
    options.fetch === undefined
      ? memory
      : createMemoryHost({ network: { ...memory.network, fetch: options.fetch } })
  await host.fs.mkdirp(host.identity.profileDir as AbsolutePath)
  const providers = createProviderRegistry()
  registerBuiltinProviders(providers)
  for (const definition of extra) providers.register(definition)
  registerProviderRoutes({ ipcMain, host, providers, env: options.env ?? {}, log: () => {} })

  const call = async (channel: string, payload: unknown): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return await handler({}, payload)
  }
  const list = async (): Promise<ProviderEntryContract[]> => {
    const result = (await call('provider.list', {})) as {
      ok: boolean
      data: ProviderEntryContract[]
    }
    expect(result.ok).toBe(true)
    return result.data
  }
  return {
    host,
    call,
    list,
    async entry(id) {
      const found = (await list()).find((candidate) => candidate.id === id)
      if (found === undefined) throw new Error(`no provider entry for ${id}`)
      return found
    },
  }
}

const KEY = 'sk-secret-value-9f3a'

describe('provider.list', () => {
  it('describes every registered definition without ever carrying a secret', async () => {
    const h = await harness()
    await h.host.secrets.set(keyFor(h.host.identity, 'provider', ZHIPU_PROVIDER_ID, 'apiKey'), KEY)

    const entries = await h.list()
    expect(entries.map((entry) => entry.id)).toEqual([
      ANTHROPIC_PROVIDER_ID,
      ZHIPU_PROVIDER_ID,
      OLLAMA_PROVIDER_ID,
    ])
    const zhipu = entries.find((entry) => entry.id === ZHIPU_PROVIDER_ID)
    expect(zhipu?.configKeys.find((key) => key.name === 'apiKey')).toMatchObject({
      secret: true,
      required: true,
      configured: true,
    })
    // The whole response, searched: neither the value nor a prefix of it.
    const raw = JSON.stringify(entries)
    expect(raw).not.toContain(KEY)
    expect(raw).not.toContain(KEY.slice(0, 6))
    // And nothing DERIVED from it either — masked, hashed, or a length. A key object carries
    // exactly these fields, so there is nowhere for such a thing to travel.
    const declared = ['configured', 'labelKey', 'name', 'primary', 'required', 'secret']
    for (const key of entries.flatMap((entry) => entry.configKeys)) {
      const expected = key.default === undefined ? declared : [...declared, 'default'].toSorted()
      expect(Object.keys(key).toSorted()).toEqual(expected)
    }
  })

  it('reports a provider as configured only once a credential is stored', async () => {
    const h = await harness()
    // Both of anthropic's credentials are `required: false` (ConfigKey cannot say "one of"), so
    // "no required key is missing" alone would call an unconfigured provider ready.
    expect((await h.entry(ANTHROPIC_PROVIDER_ID)).configured).toBe(false)
    // ollama declares no secret at all and its base URL has a default: ready as it ships.
    expect((await h.entry(OLLAMA_PROVIDER_ID)).configured).toBe(true)

    await h.host.secrets.set(
      keyFor(h.host.identity, 'provider', ANTHROPIC_PROVIDER_ID, 'authToken'),
      KEY,
    )
    expect((await h.entry(ANTHROPIC_PROVIDER_ID)).configured).toBe(true)
  })

  it('never carries a declared default on a secret key', async () => {
    // Nothing in the kernel's `ConfigKey` forbids `{ secret: true, default: … }`, and `default` is
    // the one field on the wire that holds a value at all. No builtin declares such a key, so the
    // guarantee needs a definition that does.
    const base = createProviderRegistry()
    registerBuiltinProviders(base)
    const anthropic = base.get(ANTHROPIC_PROVIDER_ID)
    expect(anthropic).not.toBeNull()
    const h = await harness([
      {
        ...(anthropic as ProviderDefinition),
        id: 'probe',
        configKeys: [
          { name: 'apiKey', required: true, secret: true, default: KEY, labelKey: 'probe.apiKey' },
        ],
      },
    ])

    const probe = await h.entry('probe')
    expect(probe.configKeys[0]).toMatchObject({ name: 'apiKey', secret: true })
    expect(probe.configKeys[0]).not.toHaveProperty('default')
    expect(JSON.stringify(await h.list())).not.toContain(KEY)
  })

  it('lists no thinking levels for a row whose spec names none (旧 186)', async () => {
    // An empty list is no submenu: the menu opens 「思考强度 ›」 for any row that carries the field.
    const base = createProviderRegistry()
    registerBuiltinProviders(base)
    const anthropic = base.get(ANTHROPIC_PROVIDER_ID) as ProviderDefinition
    const row = anthropic.builtinModels[0]
    expect(row).toBeDefined()
    const h = await harness([
      {
        ...anthropic,
        id: 'probe',
        builtinModels: [
          {
            ...(row as NonNullable<typeof row>),
            id: 'probe-model',
            providerId: 'probe',
            thinkingSpec: { mode: 'adaptive', defaultOn: true, effortLevels: [] },
          },
        ],
      },
    ])
    const [listed] = (await h.entry('probe')).models
    expect(listed?.id).toBe('probe-model')
    expect(listed).not.toHaveProperty('effortLevels')
  })

  it('marks a key as configured from its declared default', async () => {
    const h = await harness()
    const baseURL = (await h.entry(ZHIPU_PROVIDER_ID)).configKeys.find(
      (key) => key.name === 'baseURL',
    )
    expect(baseURL).toMatchObject({ secret: false, configured: true })
    expect(baseURL?.default).toMatch(/^https:\/\//)
  })
})

describe('provider.configure', () => {
  it('puts a secret in the keychain and the rest in config.json', async () => {
    const h = await harness()
    expect(
      await h.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { apiKey: KEY, baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
      }),
    ).toEqual({ ok: true, data: { ok: true } })

    const config = await readConfig(h.host.fs, h.host.identity)
    expect(config.providerConfig[ZHIPU_PROVIDER_ID]).toEqual({
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    })
    // The file on disk holds no credential — the point of the split.
    expect(JSON.stringify(config)).not.toContain(KEY)
    expect(
      await h.host.secrets.get(keyFor(h.host.identity, 'provider', ZHIPU_PROVIDER_ID, 'apiKey')),
    ).toBe(KEY)
  })

  it('merges key by key and deletes a secret the user cleared', async () => {
    const h = await harness()
    await h.call('provider.configure', {
      id: ANTHROPIC_PROVIDER_ID,
      values: { apiKey: KEY, baseURL: 'https://api.anthropic.com' },
    })
    // A second save that mentions only one key leaves the other alone.
    await h.call('provider.configure', { id: ANTHROPIC_PROVIDER_ID, values: { apiKey: '' } })

    const config = await readConfig(h.host.fs, h.host.identity)
    expect(config.providerConfig[ANTHROPIC_PROVIDER_ID]).toEqual({
      baseURL: 'https://api.anthropic.com',
    })
    expect(
      await h.host.secrets.get(
        keyFor(h.host.identity, 'provider', ANTHROPIC_PROVIDER_ID, 'apiKey'),
      ),
    ).toBeNull()
  })

  it('reports a value no client could be built from, and writes nothing', async () => {
    const h = await harness()
    await h.call('provider.configure', { id: ANTHROPIC_PROVIDER_ID, values: { apiKey: KEY } })
    // This wire appends its own /v1; a base URL that already ends in one is refused by the
    // definition itself, which is the only place that rule is written down.
    expect(
      await h.call('provider.configure', {
        id: ANTHROPIC_PROVIDER_ID,
        values: { baseURL: 'https://api.anthropic.com/v1' },
      }),
    ).toEqual({
      ok: true,
      data: { ok: false, code: 'invalid-value', configKey: 'baseURL' },
    })
    const config = await readConfig(h.host.fs, h.host.identity)
    expect(config.providerConfig[ANTHROPIC_PROVIDER_ID]?.['baseURL']).toBeUndefined()
  })

  it('refuses a base URL on a provider with no credential stored', async () => {
    const h = await harness()
    // The fresh-profile path, and the one a credential check could hide: both wires validate
    // their credentials BEFORE the base URL, so a provider with no key would never reach the URL
    // rules and every value would look acceptable.
    // On the official origin, past §点名 (a)'s rule, which a foreign address never gets beyond.
    const refusals = await Promise.all(
      ['https://api.anthropic.com/v1', 'https://api.anthropic.com/?token=abc'].map((baseURL) =>
        h.call('provider.configure', { id: ANTHROPIC_PROVIDER_ID, values: { baseURL } }),
      ),
    )
    for (const refusal of refusals) {
      expect(refusal).toEqual({
        ok: true,
        data: { ok: false, code: 'invalid-value', configKey: 'baseURL' },
      })
    }
    // Refused on the OpenAI wire too, where the credential is the one REQUIRED key.
    expect(
      await h.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { baseURL: 'https://open.bigmodel.cn/api/paas/v4?token=abc' },
      }),
    ).toEqual({ ok: true, data: { ok: false, code: 'invalid-value', configKey: 'baseURL' } })

    const config = await readConfig(h.host.fs, h.host.identity)
    expect(config.providerConfig[ANTHROPIC_PROVIDER_ID]).toBeUndefined()
    expect(config.providerConfig[ZHIPU_PROVIDER_ID]).toBeUndefined()
  })

  it('blames the field that was written, not the one the message happens to name', async () => {
    const h = await harness()
    // The kernel quotes the offending value verbatim, so a scan of the error text for key names
    // would answer `apiKey` here — a field the user never touched.
    expect(
      await h.call('provider.configure', {
        id: ANTHROPIC_PROVIDER_ID,
        values: { baseURL: 'https://api.anthropic.com/apiKey/v1' },
      }),
    ).toEqual({ ok: true, data: { ok: false, code: 'invalid-value', configKey: 'baseURL' } })
  })

  it('saves a provider that is still incomplete', async () => {
    const h = await harness()
    // Filling a form one field at a time passes through "no credential yet", which is not an
    // invalid value: `create()` says so with a different error, and it must not be reported here.
    expect(
      await h.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
      }),
    ).toEqual({ ok: true, data: { ok: true } })
    expect((await h.entry(ZHIPU_PROVIDER_ID)).configured).toBe(false)
  })

  it('refuses an unknown provider and an undeclared key', async () => {
    const h = await harness()
    expect(await h.call('provider.configure', { id: 'nope', values: {} })).toEqual({
      ok: true,
      data: { ok: false, code: 'unknown-provider', configKey: null },
    })
    expect(
      await h.call('provider.configure', { id: ZHIPU_PROVIDER_ID, values: { smuggled: 'x' } }),
    ).toEqual({
      ok: true,
      data: { ok: false, code: 'unknown-key', configKey: 'smuggled' },
    })
    const config = await readConfig(h.host.fs, h.host.identity)
    expect(config.providerConfig[ZHIPU_PROVIDER_ID]).toBeUndefined()
  })
})

describe('the builtins’ official origins (M6 §点名 (a), (b), (c), (e); 验收 26)', () => {
  const FOREIGN: readonly (readonly [string, string])[] = [
    [ANTHROPIC_PROVIDER_ID, 'https://open.bigmodel.cn/api/anthropic'],
    [ANTHROPIC_PROVIDER_ID, 'https://gateway.example'],
    [ANTHROPIC_PROVIDER_ID, 'http://api.anthropic.com'],
    [ANTHROPIC_PROVIDER_ID, 'https://api.anthropic.com:8443'],
    [ANTHROPIC_PROVIDER_ID, 'https://api.anthropic.com.evil.test'],
    [ZHIPU_PROVIDER_ID, 'https://api.z.ai/api/paas/v4'],
    [ZHIPU_PROVIDER_ID, 'http://open.bigmodel.cn/api/paas/v4'],
    [ZHIPU_PROVIDER_ID, 'https://open.bigmodel.cn:8443/api/paas/v4'],
    [ZHIPU_PROVIDER_ID, 'http://127.0.0.1:4000/v1'],
  ]

  it.each(FOREIGN)(
    'refuses %s at %s with official-host-only, and writes nothing',
    async (id, baseURL) => {
      const h = await harness()
      expect(await h.call('provider.configure', { id, values: { apiKey: KEY, baseURL } })).toEqual({
        ok: true,
        data: { ok: false, code: 'official-host-only', configKey: 'baseURL' },
      })
      expect((await readConfig(h.host.fs, h.host.identity)).providerConfig[id]).toBeUndefined()
      expect(await h.host.secrets.get(keyFor(h.host.identity, 'provider', id, 'apiKey'))).toBeNull()
    },
  )

  // Not a web URL at all (§地址校验 rule 1's order): the definition's own check answers, not the
  // official-origin rule, whose copy would point at a custom vendor that refuses it too.
  it.each([
    [ANTHROPIC_PROVIDER_ID, 'not a url'],
    [ANTHROPIC_PROVIDER_ID, 'file:///etc/passwd'],
    // A blob URL's `origin` is its inner URL's, yet it is no http(s) address to send to.
    [ANTHROPIC_PROVIDER_ID, 'blob:https://api.anthropic.com/'],
    // The official host or the subscription path, typed without the scheme.
    [ANTHROPIC_PROVIDER_ID, 'api.anthropic.com'],
    [ZHIPU_PROVIDER_ID, 'open.bigmodel.cn/api/coding/paas/v4'],
  ])('refuses %s at %s with invalid-value, and writes nothing', async (id, baseURL) => {
    const h = await harness()
    expect(await h.call('provider.configure', { id, values: { apiKey: KEY, baseURL } })).toEqual({
      ok: true,
      data: { ok: false, code: 'invalid-value', configKey: 'baseURL' },
    })
    expect((await readConfig(h.host.fs, h.host.identity)).providerConfig[id]).toBeUndefined()
    expect(await h.host.secrets.get(keyFor(h.host.identity, 'provider', id, 'apiKey'))).toBeNull()
  })

  it.each([
    'https://open.bigmodel.cn/api/coding/paas/v4',
    'https://open.bigmodel.cn/API/Coding//PaaS/v4/',
    'https://open.bigmodel.cn/api/coding%2Fpaas/v4',
    // Z.ai's GLM Coding Plan (Q13): the subscription, not a custom vendor's address to add.
    'https://api.z.ai/api/coding/paas/v4',
  ])('refuses zhipu on the subscription path %s with subscription-endpoint', async (baseURL) => {
    const h = await harness()
    expect(
      await h.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { apiKey: KEY, baseURL },
      }),
    ).toEqual({
      ok: true,
      data: { ok: false, code: 'subscription-endpoint', configKey: 'baseURL' },
    })
    expect((await readConfig(h.host.fs, h.host.identity)).providerConfig).toEqual({})
    expect(
      await h.host.secrets.get(keyFor(h.host.identity, 'provider', ZHIPU_PROVIDER_ID, 'apiKey')),
    ).toBeNull()
  })

  it('takes the official origin with any path or the default port, and a blank value back', async () => {
    const h = await harness()
    // The subscription path is zhipu's rule alone (§点名 (b), (e)): anthropic takes it.
    for (const baseURL of [
      'https://API.anthropic.com:443/',
      'https://api.anthropic.com/x',
      'https://api.anthropic.com/api/coding/paas/v4',
      '',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- saves one after another
      const saved = await h.call('provider.configure', {
        id: ANTHROPIC_PROVIDER_ID,
        values: { apiKey: KEY, baseURL },
      })
      expect(saved).toEqual({ ok: true, data: { ok: true } })
      // Each one listed as in force, read back before the next save.
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect((await h.entry(ANTHROPIC_PROVIDER_ID)).refused).toBeUndefined()
    }
    // Zhipu's own: the pay-as-you-go path, and its Anthropic-wire path on the same origin.
    expect(
      await h.call('provider.configure', {
        id: ZHIPU_PROVIDER_ID,
        values: { apiKey: KEY, baseURL: 'https://open.bigmodel.cn/api/paas/v4/' },
      }),
    ).toEqual({ ok: true, data: { ok: true } })
  })

  it('M6 不变量 16: an address in force off the official origin, or on zhipu’s subscription path, is not configured and sends nothing', async () => {
    const requests: string[] = []
    const fetch: FetchLike = (input) => {
      requests.push(String(input))
      return Promise.reject(new Error('no request may leave'))
    }
    const cases: readonly {
      readonly id: string
      readonly stored?: string
      readonly env?: Record<string, string>
      readonly refused: ProviderEntryContract['refused']
    }[] = [
      {
        id: ANTHROPIC_PROVIDER_ID,
        stored: 'https://open.bigmodel.cn/api/anthropic/',
        refused: { code: 'official-host-only', origin: 'https://open.bigmodel.cn' },
      },
      {
        id: ZHIPU_PROVIDER_ID,
        stored: 'https://api.z.ai/api/paas/v4',
        refused: { code: 'official-host-only', origin: 'https://api.z.ai' },
      },
      {
        id: ZHIPU_PROVIDER_ID,
        stored: 'https://open.bigmodel.cn/api/coding/paas/v4',
        refused: { code: 'subscription-endpoint' },
      },
      {
        id: ZHIPU_PROVIDER_ID,
        stored: 'https://api.z.ai/api/coding/paas/v4',
        refused: { code: 'subscription-endpoint' },
      },
      // No origin to show: an opaque one, and a blob URL wrapping the official one.
      {
        id: ANTHROPIC_PROVIDER_ID,
        stored: 'file:///etc/passwd',
        refused: { code: 'official-host-only' },
      },
      {
        id: ANTHROPIC_PROVIDER_ID,
        stored: 'blob:https://api.anthropic.com/',
        refused: { code: 'official-host-only' },
      },
      // §点名 (c): the development variable, on a development build.
      {
        id: ANTHROPIC_PROVIDER_ID,
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' },
        refused: { code: 'official-host-only', origin: 'http://127.0.0.1:4000' },
      },
      {
        id: ANTHROPIC_PROVIDER_ID,
        env: { ANTHROPIC_BASE_URL: 'blob:https://api.anthropic.com/' },
        refused: { code: 'official-host-only' },
      },
    ]
    for (const { id, stored, env, refused } of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one profile per case
      const h = await harness([], { fetch, ...(env === undefined ? {} : { env }) })
      if (stored !== undefined) {
        // An address saved before M6 (or by hand): not migrated.
        // oxlint-disable-next-line no-await-in-loop -- as above
        await writeConfig(h.host.fs, h.host.identity, {
          provider: { id, modelId: id === ZHIPU_PROVIDER_ID ? 'glm-4.6' : 'claude-sonnet-5' },
          providerConfig: { [id]: { baseURL: stored } },
        })
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      await h.host.secrets.set(keyFor(h.host.identity, 'provider', id, 'apiKey'), KEY)
      // oxlint-disable-next-line no-await-in-loop -- as above
      const entry = await h.entry(id)
      expect(entry.configured).toBe(false)
      expect(entry.refused).toEqual(refused)
      const providers = createProviderRegistry()
      registerBuiltinProviders(providers)
      const connector = createRunConnector({
        host: h.host,
        providers,
        env: env ?? {},
        log: () => {},
      })
      const model = providers.get(id)?.builtinModels[0]
      // oxlint-disable-next-line no-await-in-loop -- as above
      const assembly = await connector.assemble({
        sessionId: 's',
        rootSessionId: 's',
        choice: {
          providerId: id,
          modelId: model?.id ?? '',
          effort: null,
          capabilitySource: 'builtin',
        },
        signal: new AbortController().signal,
      })
      expect(() => assembly.provider()).toThrow(
        expect.objectContaining({ name: 'ProviderConfigMissingError' }),
      )
      expect(assembly.search).toBeNull()
    }
    expect(requests).toEqual([])
  })

  it('lists the official addresses with no refusal', async () => {
    const h = await harness()
    for (const entry of await h.list()) expect(entry).not.toHaveProperty('refused')
  })
})

describe('provider.select', () => {
  it('writes the choice to config.json', async () => {
    const h = await harness()
    const model = (await h.entry(ZHIPU_PROVIDER_ID)).models[0]?.id
    expect(model).toBeDefined()
    expect(
      await h.call('provider.select', { providerId: ZHIPU_PROVIDER_ID, modelId: model }),
    ).toEqual({ ok: true, data: { ok: true } })
    expect((await readConfig(h.host.fs, h.host.identity)).provider).toEqual({
      id: ZHIPU_PROVIDER_ID,
      modelId: model,
    })
  })

  it.each(['glm-5.3-flash', 'glm-5.3-flashx'])('accepts %s, a builtin row since 02', async (id) => {
    // The daily model and the live suite's: builtin rows, so the card can save them (spec 02 §目标).
    const h = await harness()
    expect((await h.entry(ZHIPU_PROVIDER_ID)).models.map((model) => model.id)).toContain(id)
    expect(await h.call('provider.select', { providerId: ZHIPU_PROVIDER_ID, modelId: id })).toEqual(
      { ok: true, data: { ok: true } },
    )
    expect((await readConfig(h.host.fs, h.host.identity)).provider).toEqual({
      id: ZHIPU_PROVIDER_ID,
      modelId: id,
    })
  })

  it('accepts a hand-typed id as the user’s, and sets both profiles’ defaults (旧 40, 旧 187)', async () => {
    const h = await harness()
    expect(
      await h.call('provider.select', { providerId: ZHIPU_PROVIDER_ID, modelId: 'glm-own-model' }),
    ).toEqual({ ok: true, data: { ok: true } })
    const config = await readConfig(h.host.fs, h.host.identity)
    const selection = { id: ZHIPU_PROVIDER_ID, modelId: 'glm-own-model', source: 'user' }
    expect(config.provider).toEqual(selection)
    expect(config.defaultModelByProfile).toEqual({ chat: selection, cowork: selection })
  })
})
