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
