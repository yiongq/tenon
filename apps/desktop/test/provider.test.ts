/**
 * Where credentials come from, and what a model id that is not in any builtin table means
 * (spec 01 §desktop 接线, 「开发期回落保留」).
 *
 * Both halves are host concerns the kernel is not allowed to have an opinion about: the keychain
 * lookup is a security boundary (a value must never be read from the environment while the
 * keychain has one), and the synthesised `ModelInfo` is the owner's daily setup — a model behind
 * an Anthropic-compatible endpoint that no table knows.
 */
import {
  ANTHROPIC_PROVIDER_ID,
  createMemoryHost,
  createProviderRegistry,
  keyFor,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type {
  ModelInfo,
  Provider,
  ProviderDefinition,
  RequestIdentity,
  StreamEvent,
} from '@tenon-app/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_PROVIDER_ID,
  MAX_TOKENS_ENV,
  MODEL_ENV,
  PROVIDER_ENV,
  resolveChatProvider,
  selectModel,
  selectProviderId,
} from '../src/main/provider.js'
import { startFakeAnthropic } from './support/fake-anthropic.js'
import type { FakeAnthropic } from './support/fake-anthropic.js'

function registry(): ReturnType<typeof createProviderRegistry> {
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

/** Draining the stream is what sends the request; the events themselves are step 10's business. */
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

describe('selectModel', () => {
  it('uses the builtin entry when TENON_MODEL names one', () => {
    const definition = anthropic()
    const wanted = definition.builtinModels[1]
    expect(wanted).toBeDefined()
    const lines: string[] = []
    expect(selectModel(definition, wanted?.id ?? '', (line) => lines.push(line))).toBe(wanted)
    expect(lines).toEqual([])
  })

  it('falls back to the first builtin model when nothing was asked for', () => {
    const definition = anthropic()
    expect(selectModel(definition, null, () => {})).toBe(definition.builtinModels[0])
  })

  it('synthesises a conservative model for an id no table knows, and says so once', () => {
    const definition = anthropic()
    const lines: string[] = []
    const model = selectModel(definition, 'gateway/some-model', (line) => lines.push(line))
    expect(lines).toHaveLength(1)
    expect(model).toEqual({
      id: 'gateway/some-model',
      providerId: ANTHROPIC_PROVIDER_ID,
      contextLimit: Math.min(...definition.builtinModels.map((m) => m.contextLimit)),
      maxOutputTokens: Math.min(...definition.builtinModels.map((m) => m.maxOutputTokens)),
      reasoning: false,
      supportsToolCalling: false,
      supportsStreamingToolCalls: false,
      supportsVision: false,
      supportsCacheControl: false,
      thinkingPreservationFormat: 'drop',
      usageNeedsOptIn: false,
    })
  })

  it('falls back to the fixed floor when the definition ships no models', () => {
    const empty: ProviderDefinition = { ...anthropic(), builtinModels: [] }
    const model = selectModel(empty, 'anything', () => {})
    expect([model.contextLimit, model.maxOutputTokens]).toEqual([128_000, 4096])
  })
})

describe('selectProviderId', () => {
  it('prefers the saved choice, then the development variable, then the default', () => {
    // The ordering the spec fixes: a variable in someone's shell FILLS a gap, it never overrides
    // a provider the user chose in the settings card.
    expect(selectProviderId('zhipu', { [PROVIDER_ENV]: 'ollama' })).toBe('zhipu')
    expect(selectProviderId(null, { [PROVIDER_ENV]: 'ollama' })).toBe('ollama')
    expect(selectProviderId(null, {})).toBe(DEFAULT_PROVIDER_ID)
    // Blank is not a choice, in either place.
    expect(selectProviderId('  ', { [PROVIDER_ENV]: '  ' })).toBe(DEFAULT_PROVIDER_ID)
  })
})

describe('resolveChatProvider', () => {
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
    const { provider, model, maxTokens } = await resolveChatProvider({
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
    const { provider, model } = await resolveChatProvider({
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
      resolveChatProvider({
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

    await resolveChatProvider({ host, providers, providerId: 'probe', env: {}, log: () => {} })
    expect(seen.config?.['flavour']).toBe('from-the-definition')
    // The one the user saved still wins over the declared default.
    await resolveChatProvider({
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
    const resolve = (env: Record<string, string>): ReturnType<typeof resolveChatProvider> =>
      resolveChatProvider({
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
      resolveChatProvider({
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
    const packaged = await resolveChatProvider({
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
    const resolve = (modelId: string | null): ReturnType<typeof resolveChatProvider> =>
      resolveChatProvider({
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
    const resolved = await resolveChatProvider({
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
