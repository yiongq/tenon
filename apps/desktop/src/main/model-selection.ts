import type { ProviderSelection } from '@tenon-app/contracts'
import { ANTHROPIC_PROVIDER_ID, ZHIPU_PROVIDER_ID } from '@tenon-app/kernel'
import type { ProviderDefinition } from '@tenon-app/kernel'

/** What `config.json` records for a choice: the id, marked when no builtin table has it. */
export function selectionOf(
  definition: ProviderDefinition,
  modelId: string,
): { id: string; modelId: string; source?: 'user' } {
  const builtin = definition.builtinModels.some((model) => model.id === modelId)
  return builtin ? { id: definition.id, modelId } : { id: definition.id, modelId, source: 'user' }
}

/** Main-list family choices follow that family for new sessions; all other choices pin a row. */
export function menuSelectionOf(
  definition: ProviderDefinition,
  modelId: string,
): ProviderSelection {
  const row = definition.builtinModels.find((model) => model.id === modelId)
  return [ANTHROPIC_PROVIDER_ID, ZHIPU_PROVIDER_ID].includes(definition.id) &&
    row?.family !== undefined &&
    row.listing !== 'more'
    ? { id: definition.id, modelId, latestOf: row.family }
    : selectionOf(definition, modelId)
}
