/**
 * The registry: definitions are data plus create(), ids stay strings, and registration order
 * is what list() reports. Adding a provider must never mean editing a union or this file.
 */
import { describe, expect, it } from 'vitest'
import {
  ProviderAlreadyRegisteredError,
  ProviderInvalidArgumentError,
  createProviderRegistry,
} from '../../src/index.js'
import type { HostNetwork, Provider, ProviderDefinition } from '../../src/index.js'

const NETWORK: HostNetwork = {
  fetch: () => Promise.reject(new Error('the registry never opens a connection')),
}

function definitionOf(id: string, onCreate?: (args: unknown) => void): ProviderDefinition {
  return {
    id,
    nameKey: `provider.${id}.name`,
    wire: 'openai-chat',
    configKeys: [
      { name: 'apiKey', required: true, secret: true, labelKey: `provider.${id}.apiKey` },
    ],
    builtinModels: [],
    create: (args): Provider => {
      onCreate?.(args)
      // Never exercised here: what matters is that the registry does not call it.
      throw new Error('not built in this test')
    },
  }
}

describe('createProviderRegistry', () => {
  it('registers, looks up and lists in registration order', () => {
    const registry = createProviderRegistry()
    expect(registry.list()).toEqual([])
    expect(registry.get('anthropic')).toBeNull()

    const anthropic = definitionOf('anthropic')
    const zhipu = definitionOf('zhipu')
    const ollama = definitionOf('ollama')
    for (const def of [anthropic, zhipu, ollama]) registry.register(def)

    expect(registry.get('zhipu')).toBe(zhipu)
    expect(registry.list().map((def) => def.id)).toEqual(['anthropic', 'zhipu', 'ollama'])
    // A fourth definition registered at runtime is all it takes (acceptance 1).
    registry.register(definitionOf('in-test'))
    expect(registry.list().map((def) => def.id)).toEqual([
      'anthropic',
      'zhipu',
      'ollama',
      'in-test',
    ])
  })

  it('returns null for an unknown id rather than undefined', () => {
    const registry = createProviderRegistry()
    expect(registry.get('nope')).toBeNull()
  })

  it('refuses a duplicate id instead of overwriting', () => {
    // An overwrite would silently re-point every model and credential already configured.
    const registry = createProviderRegistry()
    const first = definitionOf('anthropic')
    registry.register(first)
    expect(() => registry.register(definitionOf('anthropic'))).toThrow(
      ProviderAlreadyRegisteredError,
    )
    expect(registry.get('anthropic')).toBe(first)
    expect(registry.list()).toHaveLength(1)
  })

  it('refuses a definition without an id', () => {
    const registry = createProviderRegistry()
    expect(() => registry.register(definitionOf('  '))).toThrow(ProviderInvalidArgumentError)
    expect(registry.list()).toEqual([])
  })

  it('hands out a list a caller cannot use to mutate the registry', () => {
    const registry = createProviderRegistry()
    registry.register(definitionOf('anthropic'))
    const list = registry.list()
    list.pop()
    expect(registry.list()).toHaveLength(1)
  })

  it('never calls create() itself: host capabilities enter only at the call site', () => {
    const calls: unknown[] = []
    const registry = createProviderRegistry()
    const definition = definitionOf('anthropic', (args) => calls.push(args))
    registry.register(definition)
    registry.get('anthropic')
    registry.list()
    expect(calls).toEqual([])

    const args = { network: NETWORK, config: { baseURL: 'https://api.example.test' }, secrets: {} }
    expect(() => definition.create(args)).toThrow('not built in this test')
    expect(calls).toEqual([args])
  })
})
