/** The compaction test switch cannot change a packaged application. */
import { describe, expect, it } from 'vitest'
import {
  COMPACTION_THRESHOLD_ENV,
  compactionTestOptions,
} from '../src/main/compaction-test-seam.js'

describe('the development-only compaction threshold', () => {
  it('requires the dedicated variable and a positive safe integer', () => {
    expect(compactionTestOptions(false, { [COMPACTION_THRESHOLD_ENV]: '50' })).toEqual({
      compactionThreshold: 50,
    })
    expect(compactionTestOptions(false, { TENON_MAX_TOKENS: '50' })).toEqual({})
  })

  it.each([undefined, '', '0', '-1', '1.5', 'NaN', 'Infinity', '1e2', ' 12 ', '9007199254740992'])(
    'ignores invalid threshold %s',
    (value) => {
      expect(compactionTestOptions(false, { [COMPACTION_THRESHOLD_ENV]: value })).toEqual({})
    },
  )

  it('does not read the environment at all when packaged', () => {
    const env = Object.defineProperty({}, COMPACTION_THRESHOLD_ENV, {
      get() {
        throw new Error('A packaged app must not read this switch')
      },
    })
    expect(compactionTestOptions(true, env)).toEqual({})
    expect(compactionTestOptions(true, { [COMPACTION_THRESHOLD_ENV]: '1' })).toEqual({})
  })
})
