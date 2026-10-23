/**
 * What a renderer may write to `config.json`, and what it may only read.
 *
 * The provider settings are checked against the registered definitions by `provider.configure` /
 * `provider.select` (an unknown id, an undeclared key, a value no client could be built from). A
 * second way in through `config.set` would make every one of those checks optional, so the route's
 * request shape does not carry them — enforced by the schema, not by a handler remembering to look.
 */
import { describe, expect, it } from 'vitest'
import { configSchema, configSet } from '../src/ipc/config.js'
import { providerModelSchema, providerSelect } from '../src/ipc/provider.js'

describe('config.set', () => {
  it('accepts the fields the renderer owns', () => {
    expect(configSet.request.safeParse({ locale: 'en' }).success).toBe(true)
    expect(configSet.request.safeParse({ sidebarCollapsed: true }).success).toBe(true)
    expect(configSet.request.safeParse({}).success).toBe(true)
  })

  it('refuses the provider settings, which have their own validated routes', () => {
    const parsed = configSet.request.safeParse({
      locale: 'en',
      provider: { id: 'zhipu', modelId: 'glm-4.6' },
      providerConfig: { zhipu: { baseURL: 'https://gateway.example/v1' } },
    })
    // Unknown keys are stripped rather than rejected (zod's default), so the assertion is that
    // they do not survive: what comes out is what `writeConfig` would then persist.
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual({ locale: 'en' })
  })

  it('leaves out what the request left out', () => {
    // `writeConfig` merges whatever the request parsed into, so a field materialised by a default
    // here would be written over the stored value: changing the language would collapse the
    // sidebar. `configSchema.partial()` does exactly that, which is why this schema is written out.
    const parsed = configSet.request.parse({ locale: 'en' })
    expect(Object.keys(parsed)).toEqual(['locale'])
    expect(Object.keys(configSet.request.parse({ sidebarCollapsed: true }))).toEqual([
      'sidebarCollapsed',
    ])
  })

  it('still reads them back: the settings card prefills from config.get', () => {
    const config = configSchema.parse({
      provider: { id: 'zhipu', modelId: 'glm-4.6' },
      providerConfig: { zhipu: { baseURL: 'https://gateway.example/v1' } },
    })
    expect(config.provider).toEqual({ id: 'zhipu', modelId: 'glm-4.6' })
    expect(config.providerConfig['zhipu']).toEqual({ baseURL: 'https://gateway.example/v1' })
  })
})

describe('claude-5-5-models config compatibility', () => {
  const pinned = { id: 'anthropic', modelId: 'claude-opus-5' }
  const pointer = { ...pinned, latestOf: 'opus' }

  it('claude-5-5-models 验收 18: legacy config keeps pinned selections without latestOf', () => {
    const parsed = configSchema.parse({
      provider: pinned,
      defaultModelByProfile: { chat: pinned, cowork: pinned },
    })
    expect(parsed.provider).toEqual(pinned)
    expect(parsed.defaultModelByProfile).toEqual({ chat: pinned, cowork: pinned })
  })

  it('claude-5-5-models 验收 18: all three selections preserve valid pointers', () => {
    const parsed = configSchema.parse({
      provider: pointer,
      defaultModelByProfile: { chat: pointer, cowork: pointer },
    })
    expect(parsed.provider).toEqual(pointer)
    expect(parsed.defaultModelByProfile).toEqual({ chat: pointer, cowork: pointer })
  })

  it.each(['', 42, null, {}, []].map((latestOf) => [latestOf]))(
    'claude-5-5-models 验收 18: malformed latestOf %j drops only that key',
    (latestOf) => {
      const parsed = configSchema.parse({
        locale: 'en',
        provider: { ...pinned, latestOf },
        defaultModelByProfile: { chat: { ...pinned, latestOf }, cowork: pointer },
      })
      expect(parsed.provider).toEqual(pinned)
      expect(parsed.defaultModelByProfile).toEqual({ chat: pinned, cowork: pointer })
      expect(parsed.locale).toBe('en')
    },
  )

  it('claude-5-5-models 验收 18: config.set cannot write defaults or pointers', () => {
    expect(
      configSet.request.parse({ provider: pointer, defaultModelByProfile: { chat: pointer } }),
    ).toEqual({})
  })
})

it('claude-5-5-models 验收 16: provider contracts preserve optional pointers and family keys', () => {
  const pinned = { providerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001' }
  expect(providerSelect.request.parse(pinned)).toEqual(pinned)
  expect(providerSelect.request.parse({ ...pinned, latestOf: 'haiku' })).toEqual({
    ...pinned,
    latestOf: 'haiku',
  })
  expect(providerSelect.request.safeParse({ ...pinned, latestOf: '' }).success).toBe(false)
  expect(providerSelect.request.safeParse({ ...pinned, latestOf: 42 }).success).toBe(false)
  const row = {
    id: 'claude-haiku-5-5',
    mark: 'verified',
    listing: 'main',
    family: 'haiku',
    familyNameKey: 'model.family.haiku',
  }
  expect(providerModelSchema.parse(row)).toEqual(row)
  const local = { id: 'qwen3:8b', mark: 'local-text-only', listing: 'main' }
  expect(providerModelSchema.parse(local)).toEqual(local)
})
