/**
 * Which provider is chosen, and what a model id that is not in any builtin table means (spec 01
 * §desktop 接线, 「开发期回落保留」). Where the credentials come from is run-assembly.test.ts, since
 * the Run connector builds the provider (spec 02).
 *
 * A host concern the kernel is not allowed to have an opinion about: the synthesised `ModelInfo` is
 * the owner's daily setup — a model behind an Anthropic-compatible endpoint that no table knows.
 */
import {
  ANTHROPIC_PROVIDER_ID,
  createProviderRegistry,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type { ProviderDefinition } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDER_ID,
  PROVIDER_ENV,
  selectModel,
  selectProviderId,
} from '../src/main/provider.js'

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
