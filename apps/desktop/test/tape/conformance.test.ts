/**
 * The shared `TapeStore` conformance suite from `@tenon-app/kernel/testing`, run UNCHANGED against the
 * SQLite store (spec 01 step 7: 「原样跑第 4 步的 conformance 套」). It is the contract: whatever the two
 * stores answer differently is a bug in one of them, and `§删除语义` ships both — SQLite for normal
 * sessions, the memory store for incognito ones.
 *
 * The factory gives every case its own profile directory, so every case gets its own `sessions.db`.
 * Honouring the suite's `identity.profileDir` would put all 22 cases in one file, where case 2 would
 * read case 1's rows. The suite closes every store it opened, pass or fail, so the only thing left to
 * clean up is the directories.
 */
import { tapeConformanceCases } from '@tenon-app/kernel/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { createSqliteTapeStore } from '../../src/main/tape/sqlite-store.js'
import { removeTempProfiles, tempProfileDir } from './fixtures.js'

describe('tape conformance (SQLite store)', () => {
  afterAll(() => {
    removeTempProfiles()
  })

  const cases = tapeConformanceCases((options) => {
    const profileDir = tempProfileDir(`tape-conformance-${options.label}`)
    return Promise.resolve(
      createSqliteTapeStore({
        // The tenant is the suite's; only the location is the factory's.
        identity: { ...options.identity, profileDir },
        ...(options.project === undefined ? {} : { project: options.project }),
      }),
    )
  })

  it('runs every case the kernel suite defines', () => {
    // A suite that silently shrank would otherwise look like a passing run.
    expect(cases.length).toBe(24)
  })

  for (const conformanceCase of cases) {
    // A conformance case throws on failure rather than calling expect().
    // oxlint-disable-next-line vitest/expect-expect
    it(
      // oxlint-disable-next-line vitest/valid-title -- the title is data the suite owns
      conformanceCase.name,
      async () => {
        await conformanceCase.run()
      },
      60_000,
    )
  }
})
