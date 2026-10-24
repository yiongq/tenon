import type {
  ProviderEntryContract,
  ProviderSelection,
  RouteRequest,
  providerSelect,
} from '@tenon-app/contracts'

export interface ProviderModelDraft {
  readonly modelId: string
  /** A hand-typed id overrides the dropdown when not blank. */
  readonly customModel: string
}

type FamilyModel = ProviderEntryContract['models'][number] & {
  readonly family: string
  readonly familyNameKey: string
}

/** Settings offer family pointers only for the two builtin providers that support them. */
export function pointerRows(entry: ProviderEntryContract): readonly FamilyModel[] {
  return entry.id === 'anthropic' || entry.id === 'zhipu'
    ? entry.models.filter(
        (model): model is FamilyModel =>
          model.listing === 'main' &&
          model.family !== undefined &&
          model.familyNameKey !== undefined,
      )
    : []
}

/** Keep every raw row id selectable, including an id that resembles a pointer value. */
export function pointerValue(entry: ProviderEntryContract, family: string): string {
  let value = `latest:${family}`
  while (entry.models.some((model) => model.id === value)) value = `:${value}`
  return value
}

/** Reopening the card preserves a saved pointer, pinned row, or hand-typed id. */
export function modelDraftOf(
  entry: ProviderEntryContract,
  saved: ProviderSelection | null,
): ProviderModelDraft {
  const named = saved?.id === entry.id ? saved.modelId : null
  const builtin = named !== null && entry.models.some((model) => model.id === named)
  const pointers = pointerRows(entry)
  const pointer =
    saved?.id === entry.id && saved.source === undefined
      ? pointers.find((model) => model.family === saved.latestOf)
      : undefined
  const modelId =
    pointer !== undefined
      ? pointerValue(entry, pointer.family)
      : named !== null
        ? builtin
          ? named
          : (entry.models[0]?.id ?? '')
        : pointers[0] !== undefined
          ? pointerValue(entry, pointers[0].family)
          : (entry.models[0]?.id ?? '')
  return {
    modelId,
    customModel: saved?.id === entry.id && saved.source === 'user' ? saved.modelId : '',
  }
}

/** Only selecting a pointer option sends latestOf; every raw row id remains pinned. */
export function modelSelectionRequest(
  entry: ProviderEntryContract,
  draft: ProviderModelDraft,
): RouteRequest<typeof providerSelect> {
  const customModel = draft.customModel.trim()
  const pointer =
    customModel === ''
      ? pointerRows(entry).find((model) => pointerValue(entry, model.family) === draft.modelId)
      : undefined
  return {
    providerId: entry.id,
    modelId: customModel === '' ? (pointer?.id ?? draft.modelId) : customModel,
    ...(pointer === undefined ? {} : { latestOf: pointer.family }),
  }
}
