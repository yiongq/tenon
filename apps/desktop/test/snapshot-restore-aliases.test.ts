vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fsPromises>()) }))
import * as fsPromises from 'node:fs/promises'
import { constants } from 'node:fs'
import type { RestoreQuery } from '@tenon-app/kernel'
/** RC-1: normalization aliases must never delete the only physical copy. */
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { folder, path, snapshots, query, take, restore } from './support/snapshot-boundaries.js'

// APFS commonly aliases Unicode normalization forms; Linux normally treats them as distinct.
it.skipIf(process.platform !== 'darwin')(
  '05 验收 40: RC-1 — NFC/NFD directory aliases keep the only file',
  async () => {
    const nfc = 'Café'
    const nfd = nfc.normalize('NFD')
    await mkdir(path(nfc))
    await writeFile(path(`${nfc}/f`), 'origin')
    const before = await take()
    await rename(path(nfc), path(nfd))
    await writeFile(path(`${nfd}/f`), 'agent edit')
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const initial = await snapshots.preview(q)
    expect(initial.skipped.map((skip) => skip.path).toSorted()).toEqual(
      [path(nfc), path(nfd), path(`${nfc}/f`), path(`${nfd}/f`)].toSorted(),
    )
    const { done } = await restore(q)
    expect(done.removed).toBe(0)
    const names = await readdir(folder)
    expect(names).toHaveLength(1)
    expect(await readFile(path(`${names[0]}/f`), 'utf8')).toBe('agent edit')
    const preview = await snapshots.preview(q)
    expect(preview.remove).toEqual([])
  },
)

it('05 验收 40: proven parent alias propagation folds NFC/NFD and mixed case on every platform', async () => {
  const { foldRestorePath } = await import('../src/main/host/snapshot-restore.js')
  expect(foldRestorePath('/work/Cafe\u0301/F')).toBe(foldRestorePath('/work/CAFÉ/f'))
  expect(foldRestorePath('/work/Café/f')).not.toBe(foldRestorePath('/work/Cafe/f'))
})

// The removal guard must work even if an older/stale plan admitted an aliased removal.
it.skipIf(process.platform !== 'darwin')(
  '05 验收 19、40: apply rejects an inode shared with a skipped spelling',
  async () => {
    const { sessionId } = await import('./support/snapshot-boundaries.js')
    const before = await take()
    await writeFile(path('Café'), 'only copy')
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const preview = await snapshots.preview(q)
    const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
    if (!prepared.ok) throw new Error(prepared.reason)
    const plan = snapshots['prepared'].get(sessionId)!.plan
    plan.preview = {
      ...plan.preview,
      skipped: [...plan.preview.skipped, { path: path('Cafe\u0301'), reason: 'not-covered' }],
    }
    const done = await snapshots.apply({
      sessionId,
      undoSnapshotId: prepared.undoSnapshotId,
      overwrite: [],
    })
    expect(done).toMatchObject({ removed: 0, failed: [path('Café')] })
    expect(await readFile(path('Café'), 'utf8')).toBe('only copy')
  },
)

// APFS aliases normalization forms; Linux normally keeps these as distinct files.
it.skipIf(process.platform !== 'darwin')(
  '05 验收 40: NFC/NFD leaf rename is one restore with the origin spelling, bytes and mode',
  async () => {
    const nfc = 'Café.txt'
    const nfd = nfc.normalize('NFD')
    await writeFile(path(nfc), 'origin', { mode: 0o640 })
    const before = await take()
    await rename(path(nfc), path(nfd))
    await writeFile(path(nfd), 'agent edit')
    await chmod(path(nfd), 0o600)
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    expect(await snapshots.preview(q)).toMatchObject({
      restore: [path(nfc)],
      remove: [path(nfd)],
      skipped: [],
      conflicts: [],
    })
    const { done } = await restore(q)
    expect(done).toMatchObject({ restored: 1, removed: 0, failed: [] })
    expect(await readdir(folder)).toEqual([nfc])
    expect(await readFile(path(nfc), 'utf8')).toBe('origin')
    expect((await lstat(path(nfc))).mode & 0o7777).toBe(0o640)
  },
)

// These paths alias only on macOS; a missing replacement must not destroy the current leaf.
it.skipIf(process.platform !== 'darwin')(
  '05 验收 21、40: a leaf rename keeps its only copy if the origin bytes cannot be read',
  async () => {
    const { sessionId } = await import('./support/snapshot-boundaries.js')
    await writeFile(path('A.txt'), 'origin')
    const before = await take()
    await rename(path('A.txt'), path('a.txt'))
    await writeFile(path('a.txt'), 'agent edit')
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const preview = await snapshots.preview(q)
    const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
    if (!prepared.ok) throw new Error(prepared.reason)
    vi.spyOn(snapshots['git'], 'blob').mockRejectedValue(new Error('unreadable origin blob'))
    const done = await snapshots.apply({
      sessionId,
      undoSnapshotId: prepared.undoSnapshotId,
      overwrite: [],
    })
    expect(done).toMatchObject({ restored: 0, removed: 0 })
    expect(done.failed).toEqual(expect.arrayContaining([path('A.txt'), path('a.txt')]))
    expect(await readdir(folder)).toEqual(['a.txt'])
    expect(await readFile(path('a.txt'), 'utf8')).toBe('agent edit')
  },
)

// lstat identifies the link itself on macOS, never its target.
it.skipIf(process.platform !== 'darwin').each([
  ['link', 'link'],
  ['file', 'link'],
  ['link', 'file'],
] as const)(
  '05 验收 17、40: %s to %s leaf rename restores one original entry without following links',
  async (startKind, nowKind) => {
    await writeFile(path('target'), 'untouched target')
    if (startKind === 'link') await symlink('target', path('A.txt'))
    else await writeFile(path('A.txt'), 'origin', { mode: 0o640 })
    const mode = (await lstat(path('A.txt'))).mode & 0o7777
    const before = await take()
    await rename(path('A.txt'), path('a.txt'))
    await rm(path('a.txt'))
    if (nowKind === 'link') await symlink('absent-target', path('a.txt'))
    else await writeFile(path('a.txt'), 'agent edit')
    const after = await take(undefined, 'after-call')
    const { done } = await restore(query([{ callKey: 'bash', before, after }]))
    expect(done).toMatchObject({ restored: 1, removed: 0, failed: [] })
    expect((await readdir(folder)).toSorted()).toEqual(['A.txt', 'target'])
    const restored =
      startKind === 'link' ? await readlink(path('A.txt')) : await readFile(path('A.txt'), 'utf8')
    expect(restored).toBe(startKind === 'link' ? 'target' : 'origin')
    expect((await lstat(path('A.txt'))).mode & 0o7777).toBe(mode)
    expect(await readFile(path('target'), 'utf8')).toBe('untouched target')
  },
)

async function restoreOrigin(q: RestoreQuery) {
  expect(await snapshots.preview(q)).toMatchObject({
    restore: [path('A.txt')],
    remove: [],
    skipped: [],
  })
  const { done } = await restore(q)
  expect(await readdir(folder)).toEqual(['A.txt'])
  expect(await readFile(path('A.txt'), 'utf8')).toBe('origin')
  return done
}

// APFS resolves both case spellings to one object; Linux tests the distinct-name cases separately.
it.skipIf(process.platform !== 'darwin').each(['P1', 'P6', 'P12'] as const)(
  '05 验收 51、52: %s restores the origin after a historical alias leaves the plan',
  async (scenario) => {
    await writeFile(path('A.txt'), 'origin')
    const calls: RestoreQuery['calls'][number][] = []
    if (scenario === 'P12') {
      const before = await take('A.txt')
      await writeFile(path('A.txt'), 'written')
      calls.push({
        callKey: 'write',
        before,
        after: await take('A.txt', 'after-call'),
        path: path('A.txt'),
      })
    }
    const before = await take()
    await rename(path('A.txt'), path('a.txt'))
    calls.push({ callKey: 'rename', before, after: await take(undefined, 'after-call') })
    const next = await take()
    if (scenario === 'P1') {
      await rename(path('a.txt'), path('A.txt'))
      await writeFile(path('A.txt'), 'edited')
    } else await rm(path('a.txt'))
    calls.push({ callKey: 'last', before: next, after: await take(undefined, 'after-call') })
    expect(await restoreOrigin(query(calls))).toMatchObject({ restored: 1, removed: 0, failed: [] })
  },
)

it.skipIf(process.platform !== 'darwin')(
  '05 验收 51: P11 retries a leaf rename interrupted after unlink and restores the original bytes',
  async () => {
    await writeFile(path('A.txt'), 'origin')
    const before = await take()
    await rename(path('A.txt'), path('a.txt'))
    await writeFile(path('a.txt'), 'agent edit')
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const open = fsPromises.open
    const spy = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      if (
        args[0] === path('A.txt') &&
        typeof args[1] === 'number' &&
        (args[1] & constants.O_CREAT) !== 0
      ) {
        spy.mockRestore()
        throw Object.assign(new Error('Interrupted after unlink'), { code: 'EIO' })
      }
      return open(...args)
    })
    expect((await restore(q)).done).toMatchObject({
      restored: 0,
      removed: 0,
      failed: [path('A.txt')],
    })
    expect(await readdir(folder)).toEqual([])
    spy.mockRestore()
    expect(await restoreOrigin(q)).toMatchObject({ restored: 1, removed: 0, failed: [] })
  },
)
