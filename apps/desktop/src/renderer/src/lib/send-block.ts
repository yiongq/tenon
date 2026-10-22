import type { ProviderEntryContract, SessionModelChoice } from '@tenon-app/contracts'
import { customVendorGone, holdsTools } from './custom-vendor'

export type ModelBlock = 'noKey' | 'addressRefused' | 'modelUnusable' | 'modelRemoved'
export type SendBlock = 'restoring' | 'textOnlyTask' | ModelBlock
export type SwitchTarget = {
  readonly entry: ProviderEntryContract
  readonly row: ProviderEntryContract['models'][number]
}

/** presentation-r1: configured is required even for an instance; Ollama has no secret key. */
export function keyedProvider(entry: ProviderEntryContract): boolean {
  return (
    entry.configured &&
    (entry.displayName !== undefined ||
      entry.configKeys.some((key) => key.secret && key.configured))
  )
}

/** Catalogue order, main rows only; a task must be able to use tools. */
export function switchTarget(
  entries: readonly ProviderEntryContract[],
  profile: 'chat' | 'cowork',
): SwitchTarget | null {
  for (const entry of entries) {
    if (!keyedProvider(entry)) continue
    const row = entry.models.find(
      (candidate) =>
        candidate.listing === 'main' && (profile === 'chat' || holdsTools(candidate.mark)),
    )
    if (row !== undefined) return { entry, row }
  }
  return null
}

/** An unread list or choice supplies no evidence to disable sending. */
export function modelBlock(
  entries: readonly ProviderEntryContract[] | null,
  choice: SessionModelChoice | null,
): ModelBlock | null {
  if (entries === null || choice === null) return null
  if (customVendorGone(choice.providerId, choice, entries)) return 'modelRemoved'
  const entry = entries.find((candidate) => candidate.id === choice.providerId)
  if (entry?.refused !== undefined) return 'addressRefused'
  if (entry !== undefined && !entry.configured)
    return entries.some(keyedProvider) ? 'modelUnusable' : 'noKey'
  return null
}

export const MODEL_BLOCK_KEY = {
  noKey: 'composer.noKey',
  modelUnusable: 'composer.noKey',
  addressRefused: 'composer.addressRefused',
  modelRemoved: 'composer.modelRemoved',
} as const satisfies Record<ModelBlock, string>
