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
import type { ModelInfo } from '../types.js'

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
