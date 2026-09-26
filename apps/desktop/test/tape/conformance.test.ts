/**
 * The shared `TapeStore` conformance suite from `@tenon-app/kernel/testing`, run UNCHANGED against the
 * SQLite store (spec 01 step 7: 「原样跑第 4 步的 conformance 套」). It is the contract: whatever the two
 * stores answer differently is a bug in one of them, and `§删除语义` ships both — SQLite for normal
 * sessions, the memory store for incognito ones.
 *
 * The factory gives every case its own profile directory, so every case gets its own `sessions.db`.
 * Honouring the suite's `identity.profileDir` would put every case in one file, where case 2 would
 * read case 1's rows. The suite closes every store it opened, pass or fail, so the only thing left to
 * clean up is the directories.
 */
import type { TapeStore } from '@tenon-app/kernel'
import { tapeConformanceCases } from '@tenon-app/kernel/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { createSqliteTapeStore } from '../../src/main/tape/sqlite-store.js'
import { dbFile, rawConnection, removeTempProfiles, tempProfileDir } from './fixtures.js'

/**
 * A store for a SECOND tenant on a file already bound to the first — the server shape the suite's
 * `shareBackingWith` asks for. The tenant is compared only when a store opens (`tape_meta`), so the
 * owner row is swapped for that one open and put back; from then on each store binds its OWN tenant on
 * every statement, which is exactly what the tenant cases need to observe. Test-only: nothing in the
 * app ever opens one file for two tenants.
 */
function openAsSecondTenant(
  profileDir: string,
  open: () => TapeStore,
  tenantId: string,
): TapeStore {
  const raw = rawConnection(dbFile(profileDir))
  const owner = (
    raw.prepare('SELECT tenant_id FROM tape_meta WHERE id = 1').get() as {
      tenant_id: string
    }
  ).tenant_id
  raw.prepare('UPDATE tape_meta SET tenant_id = ? WHERE id = 1').run(tenantId)
  try {
    return open()
  } finally {
    raw.prepare('UPDATE tape_meta SET tenant_id = ? WHERE id = 1').run(owner)
    raw.close()
  }
}

describe('tape conformance (SQLite store)', () => {
  afterAll(() => {
    removeTempProfiles()
  })

  const dirs = new WeakMap<TapeStore, string>()
  const cases = tapeConformanceCases((options) => {
    const shared =
      options.shareBackingWith === undefined ? undefined : dirs.get(options.shareBackingWith)
    if (options.shareBackingWith !== undefined && shared === undefined) {
      throw new Error('shareBackingWith names a store this factory did not open')
    }
    const profileDir = shared ?? tempProfileDir(`tape-conformance-${options.label}`)
    const open = (): TapeStore =>
      createSqliteTapeStore({
        // The tenant is the suite's; only the location is the factory's.
        identity: { ...options.identity, profileDir },
        ...(options.project === undefined ? {} : { project: options.project }),
      })
    const store =
      shared === undefined ? open() : openAsSecondTenant(shared, open, options.identity.tenantId)
    dirs.set(store, profileDir)
    return Promise.resolve(store)
  })

  it('runs every case the kernel suite defines', () => {
    // A suite that silently shrank would otherwise look like a passing run.
    expect(cases.length).toBe(42)
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
