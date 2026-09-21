/**
 * Acceptance 6's other half: every `nameKey` and every `ConfigKey.labelKey` a registered provider
 * declares resolves to a non-empty string in BOTH locale catalogues.
 *
 * This is the only gate behind 「加一个 provider 不碰渲染端代码，只在两份 locale 目录里加键」. The
 * settings card renders those keys from data, so a definition added without its catalogue entries
 * would ship a form whose labels are the raw key strings — visible to a user, invisible to the
 * compiler, and not caught by `pnpm i18n:check` either (that one only compares the two catalogues
 * with each other, and a key missing from both is missing consistently).
 *
 * The lookup goes against the raw bundles, NOT through i18next: `fallbackLng: 'en'` would let a
 * key present only in English answer for zh-CN, which is exactly the omission this test exists to
 * catch.
 */
import { createProviderRegistry, registerBuiltinProviders } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES, resources } from '../src/i18n/resources.js'
import type { Locale } from '../src/i18n/resources.js'

/** A definition's keys carry no namespace, so they live in the default one. */
function lookup(locale: Locale, key: string): unknown {
  let node: unknown = resources[locale].common
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

function registry(): ReturnType<typeof createProviderRegistry> {
  const providers = createProviderRegistry()
  registerBuiltinProviders(providers)
  return providers
}

describe('provider catalogue keys', () => {
  it('has a non-empty name and label in every locale for every registered provider', () => {
    const definitions = registry().list()
    expect(definitions.length).toBeGreaterThan(0)

    const missing: string[] = []
    for (const definition of definitions) {
      const keys = [definition.nameKey, ...definition.configKeys.map((key) => key.labelKey)]
      expect(keys.length).toBeGreaterThan(1)
      for (const locale of SUPPORTED_LOCALES) {
        for (const key of keys) {
          const value = lookup(locale, key)
          if (typeof value !== 'string' || value.trim() === '') {
            missing.push(`${locale}: ${key} (provider ${definition.id})`)
          }
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('fails when a provider is registered without its catalogue entries', () => {
    // The gate proving itself: a fourth definition, registered here, whose keys nobody added.
    const providers = registry()
    const base = providers.list()[0]
    expect(base).toBeDefined()
    providers.register({
      ...(base as NonNullable<typeof base>),
      id: 'probe',
      nameKey: 'provider.probe.name',
    })
    const probe = providers.get('probe')
    expect(probe).not.toBeNull()
    expect(lookup('en', probe?.nameKey ?? '')).toBeUndefined()
  })
})
