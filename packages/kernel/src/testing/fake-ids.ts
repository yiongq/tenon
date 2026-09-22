import type { IdSource } from '../ids.js'

/** 12 hex digits is what the last UUID group holds. */
const MAX_COUNTER = 0xffff_ffff_ffff

export interface CounterIdsOptions {
  /** First counter value rendered. Default 1. */
  readonly start?: number
}

export interface CounterIds extends IdSource {
  /** How many ids have been handed out. */
  readonly issued: number
}

/**
 * Deterministic IdSource for tests and fixtures: a counter rendered as a canonical UUID
 * (`00000000-0000-4000-8000-<counter as 12 hex>`, so it also passes a v4-shaped check).
 * Never use it outside tests — the ids are guessable by construction.
 */
export function createCounterIds(options: CounterIdsOptions = {}): CounterIds {
  const start = options.start ?? 1
  if (!Number.isInteger(start) || start < 0 || start > MAX_COUNTER) {
    throw new RangeError(`createCounterIds: start must be an integer in 0..${MAX_COUNTER}`)
  }
  let next = start
  return {
    uuid(): string {
      if (next > MAX_COUNTER) throw new RangeError('createCounterIds: counter exhausted')
      const value = next++
      return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
    },
    get issued(): number {
      return next - start
    },
  }
}
