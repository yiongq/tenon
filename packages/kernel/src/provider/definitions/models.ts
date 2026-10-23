/**
 * How a definition's builtin `ModelInfo` table is made immutable at runtime.
 *
 * `readonly ModelInfo[]` is a compile-time claim only, and `models()` hands out a copy of the ARRAY
 * whose entries are the same row objects the module holds. One line in a caller —
 * `(await provider.models())[0].contextLimit = 1` — would therefore edit the builtin table for the
 * rest of the process, changing every later `encode()` (`max_tokens`) and every `ModelInfo` a
 * `provider/attempt_completed` fact records. Freezing makes that assignment throw where it is
 * written instead (module code is strict), which is the difference between a bug with a stack trace
 * and a fact table that quietly disagrees with the vendor.
 */
import type { ModelInfo, ProviderDefinition } from '../types.js'

/**
 * claude-5-5-models §跟随最新「菜单自动排位」: derive listing before frozenModels(). Preserve
 * the authored row order and ungrouped rows; never mutate the input rows, including frozen ones.
 */
export function arrangeFamilies(rows: readonly ModelInfo[]): ModelInfo[] {
  const newest = new Map<string, readonly [number, number]>()
  const seen = new Map<string, Set<string>>()
  for (const row of rows) {
    const { family, generation } = row
    if ((family === undefined) !== (generation === undefined)) {
      throw new Error(`model ${row.id}: family and generation must be declared together`)
    }
    if (family === undefined || generation === undefined) continue
    if (Object.hasOwn(row, 'listing')) {
      throw new Error(`model ${row.id}: a family row must not declare listing`)
    }
    const generations = seen.get(family) ?? new Set<string>()
    const key = generation.join(',')
    if (generations.has(key)) {
      throw new Error(`family ${family}: duplicate generation ${key}`)
    }
    generations.add(key)
    seen.set(family, generations)
    const previous = newest.get(family)
    if (previous === undefined || compareGenerations(generation, previous) > 0) {
      newest.set(family, generation)
    }
  }
  return rows.map((row) => {
    if (row.family === undefined || row.generation === undefined) return row
    const latest = newest.get(row.family)
    return latest !== undefined && compareGenerations(row.generation, latest) < 0
      ? { ...row, listing: 'more' }
      : { ...row }
  })
}

/** claude-5-5-models §跟随最新「解析」: only this definition's family, independent of row order. */
export function newestOfFamily(definition: ProviderDefinition, family: string): ModelInfo | null {
  let newest: ModelInfo | null = null
  for (const row of definition.builtinModels) {
    if (row.family !== family || row.generation === undefined) continue
    if (
      newest?.generation === undefined ||
      compareGenerations(row.generation, newest.generation) > 0
    ) {
      newest = row
    }
  }
  return newest
}

function compareGenerations(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] - b[0] || a[1] - b[1]
}

/**
 * The rows, frozen through `pricing` and `requestParams` as well — `requestParams` is handed to the
 * wire by reference and reaches the hashed body, so a nested object is exactly as reachable as a
 * top-level field. Only plain objects and arrays are walked: a `ModelInfo` holds nothing else, and
 * `canonicalJson` (which every `requestParams` must survive) refuses anything that is not one.
 */
export function frozenModels(models: readonly ModelInfo[]): readonly ModelInfo[] {
  for (const model of models) deepFreeze(model)
  return Object.freeze([...models])
}

function deepFreeze(value: object): void {
  // Frozen already means walked already: this is how a shared nested object is visited once.
  if (Object.isFrozen(value)) return
  Object.freeze(value)
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === 'object') deepFreeze(nested)
  }
}
