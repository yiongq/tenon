/**
 * The three definitions the spec ships with, and the one call that registers them.
 *
 * It lives beside the definitions rather than in registry.ts because the registry is generic: a
 * provider registry that imported the builtin tables would make "adding a provider" a change to
 * the registry, which is exactly what acceptance 1 exists to disprove.
 */
import type { ProviderDefinition, ProviderRegistry } from '../types.js'
import { anthropicDefinition } from './anthropic.js'
import { ollamaDefinition } from './ollama.js'
import { zhipuDefinition } from './zhipu.js'

/**
 * Registration order, which `ProviderRegistry.list()` preserves and a settings card will show:
 * the phase 0 path first, then the second provider, then the local one.
 */
export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = [
  anthropicDefinition,
  zhipuDefinition,
  ollamaDefinition,
]

/**
 * Registers all three. The registry never overwrites, so calling this twice on one registry throws
 * `ProviderAlreadyRegisteredError` rather than silently re-pointing a configured provider.
 */
export function registerBuiltinProviders(registry: ProviderRegistry): void {
  for (const definition of BUILTIN_PROVIDERS) registry.register(definition)
}
