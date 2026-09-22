/**
 * The port's type-level fixture plus the one runtime gate that lives on the port itself.
 *
 * Acceptance 15 asks that a `readRange` without `limit` be a TYPE error, not a runtime one: an
 * unbounded read must be impossible to write down, and `@ts-expect-error` inverts the assertion, so
 * the day `limit` becomes optional this file stops compiling under `pnpm typecheck`.
 */
import { describe, expect, it } from 'vitest'
import type { TapePayloadMapIsExhaustive } from '../../src/tape/projection.js'
import type { TapeStore } from '../../src/tape/store.js'
import {
  MAX_READ_LIMIT,
  TapeBusyError,
  TapeProvenanceConflictError,
  TapeReadLimitError,
  TapeSessionNotFoundError,
  TapeStaleIncarnationError,
  TapeTenantMismatchError,
  assertReadLimit,
} from '../../src/tape/store.js'
import { TapeIntegerRangeError } from '../../src/tape/entry.js'

declare const store: TapeStore

/** Never executed: the assertions are what `tsc` does with the file. */
export async function typeLevelFixture(): Promise<void> {
  // @ts-expect-error there is no unbounded read on this port: `limit` is required
  await store.readRange({ sessionId: 's' })
  // @ts-expect-error `readBySource` is bounded too
  await store.readBySource({ sessionId: 's', sourceType: 'runtime_event', sourceId: 'r' })
  // @ts-expect-error so is `verifyChain`
  await store.verifyChain({ sessionId: 's' })
  // @ts-expect-error and both projection reads
  await store.listMessages({ sessionId: 's' })
  // @ts-expect-error …
  await store.listSessions({})
  // @ts-expect-error the tenant is never a parameter: a store is bound to one at construction
  await store.readRange({ sessionId: 's', limit: 10, tenantId: 'other' })
  // The bounded forms compile.
  await store.readRange({ sessionId: 's', limit: MAX_READ_LIMIT, atEntryId: 4, kinds: ['message'] })
}

/** The map in projection.ts must cover exactly the declared names; `never` here would not compile. */
export const payloadMapIsExhaustive: TapePayloadMapIsExhaustive = true

describe('tape store port', () => {
  it('caps every read at 1000', () => {
    expect(MAX_READ_LIMIT).toBe(1000)
    expect(assertReadLimit(1)).toBe(1)
    expect(assertReadLimit(MAX_READ_LIMIT)).toBe(MAX_READ_LIMIT)
    for (const limit of [0, -1, 1.5, MAX_READ_LIMIT + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertReadLimit(limit)).toThrow(TapeReadLimitError)
    }
  })

  it('names all seven tape errors, each carrying its own name', () => {
    const errors = [
      new TapeProvenanceConflictError('x'),
      new TapeTenantMismatchError('x'),
      new TapeStaleIncarnationError('x'),
      new TapeIntegerRangeError('x'),
      new TapeSessionNotFoundError('x'),
      new TapeBusyError('x'),
      new TapeReadLimitError('x'),
    ]
    expect(errors.map((error) => error.name)).toEqual([
      'TapeProvenanceConflictError',
      'TapeTenantMismatchError',
      'TapeStaleIncarnationError',
      'TapeIntegerRangeError',
      'TapeSessionNotFoundError',
      'TapeBusyError',
      'TapeReadLimitError',
    ])
    // Each is its own class: catching one must not catch another.
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error)
      expect(errors.filter((other) => other.constructor === error.constructor)).toHaveLength(1)
    }
  })
})
