import { describe, expect, it } from 'vitest'
import { anthropicDefinition, arrangeFamilies, newestOfFamily } from '../../src/index.js'
import type { ModelInfo, ProviderDefinition } from '../../src/index.js'
import { frozenModels } from '../../src/provider/definitions/models.js'
import { anthropicModel } from './wire/fixtures.js'

function member(id: string, family: string, generation: readonly [number, number]): ModelInfo {
  return anthropicModel({ id, family, generation })
}

function definition(rows: readonly ModelInfo[]): ProviderDefinition {
  return { ...anthropicDefinition, id: 'synthetic', builtinModels: [...rows] }
}

describe('claude-5-5-models 验收 13: family listings', () => {
  it('claude-5-5-models 验收 13: adding a generation demotes only its own family, without changing input or row order', () => {
    const old = member('old', 'opus', [5, 0])
    const other = member('other', 'sonnet', [5, 0])
    const plain = anthropicModel({ id: 'plain', listing: 'main' })
    const more = anthropicModel({ id: 'more', listing: 'more' })
    const noListing = anthropicModel({ id: 'no-listing' })
    const before = arrangeFamilies([old, other, plain, more, noListing])
    expect(before).toEqual([old, other, plain, more, noListing])
    expect(before[0]).not.toHaveProperty('listing')
    const latest = member('latest', 'opus', [5, 5])
    const input = frozenModels([old, other, plain, more, noListing, latest])
    const arranged = arrangeFamilies(input)
    expect(arranged.map((row) => row.id)).toEqual([
      'old',
      'other',
      'plain',
      'more',
      'no-listing',
      'latest',
    ])
    expect(arranged[0]).toEqual({ ...old, listing: 'more' })
    expect(arranged.slice(1, 5)).toEqual(before.slice(1))
    expect(arranged[5]).toEqual(latest)
    expect(arranged[5]).not.toHaveProperty('listing')
    expect(old).not.toHaveProperty('listing')
    expect(latest).not.toHaveProperty('listing')
  })

  it('claude-5-5-models 验收 13: compares major before minor, even when the older row comes first', () => {
    for (const [older, newer] of [
      [
        [5, 0],
        [5, 5],
      ],
      [
        [4, 6],
        [5, 3],
      ],
      [
        [5, 9],
        [5, 10],
      ],
    ] as const) {
      const old = member('old', 'family', older)
      const latest = member('latest', 'family', newer)
      for (const rows of [
        [old, latest],
        [latest, old],
      ]) {
        const arranged = arrangeFamilies(rows)
        expect(arranged.find((row) => row.id === 'old')).toHaveProperty('listing', 'more')
        expect(arranged.find((row) => row.id === 'latest')).not.toHaveProperty('listing')
        expect(newestOfFamily(definition(arranged), 'family')).toBe(
          arranged.find((row) => row.id === 'latest'),
        )
      }
    }
  })

  it.each(['main', 'more', undefined] as const)(
    'claude-5-5-models 验收 13: rejects a family row with an authored listing key (%s)',
    (listing) => {
      const row = member('bad', 'opus', [5, 5])
      Object.defineProperty(row, 'listing', { value: listing, enumerable: true })
      expect(() => arrangeFamilies([row])).toThrow(/listing/)
    },
  )

  it('claude-5-5-models 验收 13: rejects duplicate generations within a family, including older generations', () => {
    expect(() =>
      arrangeFamilies([
        member('latest', 'opus', [6, 0]),
        member('old', 'opus', [5, 5]),
        member('duplicate', 'opus', [5, 5]),
      ]),
    ).toThrow(/duplicate generation/)
    expect(() =>
      arrangeFamilies([member('opus', 'opus', [5, 5]), member('sonnet', 'sonnet', [5, 5])]),
    ).not.toThrow()
  })

  it.each([{ family: 'opus' }, { generation: [5, 5] as const }])(
    'claude-5-5-models 验收 13: rejects unpaired family / generation ($family)',
    (fields) => {
      expect(() => arrangeFamilies([anthropicModel(fields)])).toThrow(/declared together/)
    },
  )

  it('claude-5-5-models 验收 13: newestOfFamily stays within the definition and family, or returns null', () => {
    const old = member('old', 'opus', [5, 0])
    const newest = member('newest', 'opus', [5, 5])
    const other = member('other', 'sonnet', [9, 0])
    const plain = anthropicModel({ id: 'plain' })
    const def = definition([old, other, newest, plain])
    expect(newestOfFamily(def, 'opus')).toBe(newest)
    expect(newestOfFamily(def, 'sonnet')).toBe(other)
    expect(newestOfFamily(def, 'missing')).toBeNull()
    expect(newestOfFamily(definition([]), 'opus')).toBeNull()
    expect(newestOfFamily(definition([plain]), 'opus')).toBeNull()
    expect(arrangeFamilies([])).toEqual([])
  })
})
