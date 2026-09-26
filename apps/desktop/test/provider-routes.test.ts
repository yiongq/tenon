/**
 * The provider routes (spec 01 §desktop 接线, 验收 6).
 *
 * The security boundary first: a stored secret must not come back over IPC in any form. The rest
 * pins where each kind of value goes — keychain for secrets, `config.json` for the others — and
 * that a value no client could be built from is reported to the card instead of being written.
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
import type { AbsolutePath, HostAdapter, ProviderDefinition } from '@tenon-app/kernel'
import type { IpcMainLike, ProviderEntryContract } from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/main/host/profile.js'
import { registerProviderRoutes } from '../src/main/provider-routes.js'

type Handler = (event: unknown, ...args: unknown[]) => unknown

interface Harness {
  readonly host: HostAdapter
  call(channel: string, payload: unknown): Promise<unknown>
  list(): Promise<ProviderEntryContract[]>
  entry(id: string): Promise<ProviderEntryContract>
}

/** The profile directory exists before main registers a route: `openProfile` creates it. */
async function harness(extra: readonly ProviderDefinition[] = []): Promise<Harness> {
  const handlers = new Map<string, Handler>()
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
  }
  const host = createMemoryHost()
  await host.fs.mkdirp(host.identity.profileDir as AbsolutePath)
  const providers = createProviderRegistry()
  registerBuiltinProviders(providers)
  for (const definition of extra) providers.register(definition)
  registerProviderRoutes({ ipcMain, host, providers, log: () => {} })

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
        values: { apiKey: KEY, baseURL: 'https://gateway.example/v1' },
      }),
    ).toEqual({ ok: true, data: { ok: true } })

    const config = await readConfig(h.host.fs, h.host.identity)
    expect(config.providerConfig[ZHIPU_PROVIDER_ID]).toEqual({
      baseURL: 'https://gateway.example/v1',
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
      values: { apiKey: KEY, baseURL: 'https://gateway.example' },
    })
    // A second save that mentions only one key leaves the other alone.
    await h.call('provider.configure', { id: ANTHROPIC_PROVIDER_ID, values: { apiKey: '' } })

    const config = await readConfig(h.host.fs, h.host.identity)
    expect(config.providerConfig[ANTHROPIC_PROVIDER_ID]).toEqual({
      baseURL: 'https://gateway.example',
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
        values: { baseURL: 'https://gateway.example/v1' },
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
    const refusals = await Promise.all(
      ['https://gateway.example/v1', 'file:///etc/passwd', 'not a url'].map((baseURL) =>
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
        values: { baseURL: 'https://gateway.example?token=abc' },
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
        values: { baseURL: 'https://relay.example/apiKey/v1' },
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
        values: { baseURL: 'https://gateway.example/v1' },
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

  it('refuses a model the definition does not declare', async () => {
    const h = await harness()
    expect(
      await h.call('provider.select', {
        providerId: ZHIPU_PROVIDER_ID,
        modelId: 'claude-opus-5',
      }),
    ).toEqual({ ok: true, data: { ok: false, code: 'unknown-model', configKey: null } })
    expect((await readConfig(h.host.fs, h.host.identity)).provider).toBeNull()
  })
})
