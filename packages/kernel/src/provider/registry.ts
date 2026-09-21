/**
 * The provider registry: definitions are data plus a `create()`, and a ProviderId stays a
 * string, so adding a provider is adding one definition (acceptance 1) — never a change to
 * a union type or to this file.
 */
import { ProviderAlreadyRegisteredError, ProviderInvalidArgumentError } from './errors.js'
import type { ProviderDefinition, ProviderId, ProviderRegistry } from './types.js'

export function createProviderRegistry(): ProviderRegistry {
  return new DefinitionRegistry()
}

class DefinitionRegistry implements ProviderRegistry {
  /** A Map keeps registration order, which `list()` is specified to preserve. */
  readonly #definitions = new Map<ProviderId, ProviderDefinition>()

  register(def: ProviderDefinition): void {
    if (def.id.trim() === '') {
      throw new ProviderInvalidArgumentError('a provider definition needs a non-empty id')
    }
    // Never an overwrite: a second definition claiming an id would silently re-point every
    // model and credential already configured under it.
    if (this.#definitions.has(def.id)) throw new ProviderAlreadyRegisteredError(def.id)
    this.#definitions.set(def.id, def)
  }

  get(id: ProviderId): ProviderDefinition | null {
    return this.#definitions.get(id) ?? null
  }

  list(): ProviderDefinition[] {
    return [...this.#definitions.values()]
  }
}
