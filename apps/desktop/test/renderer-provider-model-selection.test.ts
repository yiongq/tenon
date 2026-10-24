import type { ProviderEntryContract } from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import {
  modelDraftOf,
  modelSelectionRequest,
  pointerRows,
  pointerValue,
} from '../src/renderer/src/lib/provider-model-selection.js'

const OPUS = 'claude-opus-5-5'
const OLD_OPUS = 'claude-opus-5'
const SONNET = 'claude-sonnet-5-5'
const ENTRY: ProviderEntryContract = {
  id: 'anthropic',
  nameKey: 'provider.anthropic.name',
  configKeys: [],
  configured: false,
  endpoint: { host: 'api.anthropic.com', reach: 'public' },
  models: [
    {
      id: OPUS,
      mark: 'verified',
      listing: 'main',
      family: 'opus',
      familyNameKey: 'model.family.opus',
    },
    {
      id: SONNET,
      mark: 'verified',
      listing: 'main',
      family: 'sonnet',
      familyNameKey: 'model.family.sonnet',
    },
    {
      id: OLD_OPUS,
      mark: 'verified',
      listing: 'more',
      family: 'opus',
      familyNameKey: 'model.family.opus',
    },
  ],
}

describe('settings model choices', () => {
  it('claude-5-5-models 验收 17: no default or another provider’s default selects the first pointer', () => {
    const expected = { modelId: pointerValue(ENTRY, 'opus'), customModel: '' }
    expect(modelDraftOf(ENTRY, null)).toEqual(expected)
    expect(modelDraftOf(ENTRY, { id: 'zhipu', modelId: 'glm-5.3-flash' })).toEqual(expected)
    expect(expected.modelId).not.toBe(OPUS)
    expect(pointerRows(ENTRY).map((model) => model.family)).toEqual(['opus', 'sonnet'])
  })

  it('claude-5-5-models 验收 17: reopening a saved pointer selects the current family option', () => {
    expect(modelDraftOf(ENTRY, { id: 'anthropic', modelId: OLD_OPUS, latestOf: 'opus' })).toEqual({
      modelId: pointerValue(ENTRY, 'opus'),
      customModel: '',
    })
  })

  it.each([OPUS, OLD_OPUS])(
    'claude-5-5-models 验收 17: reopening pinned %s keeps its raw row id',
    (modelId) => {
      expect(modelDraftOf(ENTRY, { id: 'anthropic', modelId })).toEqual({
        modelId,
        customModel: '',
      })
    },
  )

  it('claude-5-5-models 验收 17: saving a pointer sends its current row and latestOf', () => {
    expect(
      modelSelectionRequest(ENTRY, { modelId: pointerValue(ENTRY, 'opus'), customModel: '' }),
    ).toEqual({
      providerId: 'anthropic',
      modelId: OPUS,
      latestOf: 'opus',
    })
    expect(
      modelSelectionRequest(ENTRY, { modelId: pointerValue(ENTRY, 'sonnet'), customModel: '' }),
    ).toEqual({
      providerId: 'anthropic',
      modelId: SONNET,
      latestOf: 'sonnet',
    })
  })

  it.each([OPUS, OLD_OPUS])(
    'claude-5-5-models 验收 17: saving pinned %s omits latestOf even for a main row',
    (modelId) => {
      expect(modelSelectionRequest(ENTRY, { modelId, customModel: '' })).toEqual({
        providerId: 'anthropic',
        modelId,
      })
    },
  )

  it('claude-5-5-models 验收 17: hand-typed models override pointer options and preserve saved user ids', () => {
    expect(
      modelSelectionRequest(ENTRY, {
        modelId: pointerValue(ENTRY, 'opus'),
        customModel: ' my-model ',
      }),
    ).toEqual({
      providerId: 'anthropic',
      modelId: 'my-model',
    })
    expect(
      modelDraftOf(ENTRY, { id: 'anthropic', modelId: 'my-model', source: 'user' }).customModel,
    ).toBe('my-model')
    expect(
      modelDraftOf(ENTRY, { id: 'anthropic', modelId: OLD_OPUS, source: 'user', latestOf: 'opus' }),
    ).toEqual({
      modelId: OLD_OPUS,
      customModel: OLD_OPUS,
    })
  })

  it('claude-5-5-models 验收 17: an unknown saved family falls back to its pinned row', () => {
    expect(
      modelDraftOf(ENTRY, { id: 'anthropic', modelId: OLD_OPUS, latestOf: 'removed' }),
    ).toEqual({
      modelId: OLD_OPUS,
      customModel: '',
    })
  })

  it.each(['ollama', 'custom-11111111-1111-4111-8111-111111111111'])(
    'claude-5-5-models 验收 17: %s never offers pointers, even if family metadata arrives',
    (id) => {
      const entry = { ...ENTRY, id }
      expect(pointerRows(entry)).toEqual([])
      expect(modelDraftOf(entry, null)).toEqual({ modelId: OPUS, customModel: '' })
      expect(modelSelectionRequest(entry, { modelId: OPUS, customModel: '' })).toEqual({
        providerId: id,
        modelId: OPUS,
      })
    },
  )

  it('claude-5-5-models 验收 17: Zhipu offers its main family pointer', () => {
    const entry: ProviderEntryContract = {
      ...ENTRY,
      id: 'zhipu',
      models: [
        {
          id: 'glm-5.3',
          mark: 'verified',
          listing: 'main',
          family: 'glm',
          familyNameKey: 'model.family.glm',
        },
      ],
    }
    expect(modelSelectionRequest(entry, modelDraftOf(entry, null))).toEqual({
      providerId: 'zhipu',
      modelId: 'glm-5.3',
      latestOf: 'glm',
    })
  })

  it('claude-5-5-models 验收 17: pointer values do not collide with row ids', () => {
    const entry: ProviderEntryContract = {
      ...ENTRY,
      models: [
        ...ENTRY.models,
        ...['latest:opus', ':latest:opus'].map((id) => ({
          id,
          listing: 'main' as const,
          mark: 'verified' as const,
        })),
      ],
    }
    const draft = modelDraftOf(entry, null)
    expect(entry.models.map((model) => model.id)).not.toContain(draft.modelId)
    expect(modelSelectionRequest(entry, draft)).toEqual({
      providerId: 'anthropic',
      modelId: OPUS,
      latestOf: 'opus',
    })
    expect(modelSelectionRequest(entry, { modelId: 'latest:opus', customModel: '' })).toEqual({
      providerId: 'anthropic',
      modelId: 'latest:opus',
    })
  })
})
