/** Real-volume probes: Linux CI runs these on ext4, without emulating lstat. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { folder, path, snapshots, query, take, restore } from './support/snapshot-boundaries.js'

const probe = await mkdtemp(join(tmpdir(), 'tenon-case-probe-'))
let caseSensitive: boolean
try {
  await writeFile(join(probe, 'a'), 'probe')
  caseSensitive = !existsSync(join(probe, 'A'))
} finally {
  await rm(probe, { recursive: true, force: true })
}

// Skip only when the actual temporary volume aliases a and A; the scenarios need two real names.
describe.skipIf(!caseSensitive)('case-sensitive volume (requires distinct a and A)', () => {
  it('05 验收 51: CS1 restores deleted A.txt and removes distinct new a.txt', async () => {
    await writeFile(path('A.txt'), 'origin')
    const before = await take()
    await rm(path('A.txt'))
    await writeFile(path('a.txt'), 'new')
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    expect(await snapshots.preview(q)).toMatchObject({
      restore: [path('A.txt')],
      remove: [path('a.txt')],
      skipped: [],
    })
    expect((await restore(q)).done).toMatchObject({ restored: 1, removed: 1, failed: [] })
    expect(await readdir(folder)).toEqual(['A.txt'])
    expect(await readFile(path('A.txt'), 'utf8')).toBe('origin')
  })

  it('05 验收 52: CS2 promised Delete A.txt and Write a.txt both remain actionable', async () => {
    await writeFile(path('A.txt'), 'origin')
    const beforeDelete = await take('A.txt')
    await rm(path('A.txt'))
    const afterDelete = await take('A.txt', 'after-call')
    const beforeWrite = await take('a.txt')
    await writeFile(path('a.txt'), 'new')
    const afterWrite = await take('a.txt', 'after-call')
    const q = query([
      { callKey: 'Delete', before: beforeDelete, after: afterDelete, path: path('A.txt') },
      { callKey: 'Write', before: beforeWrite, after: afterWrite, path: path('a.txt') },
    ])
    expect(await snapshots.preview(q)).toMatchObject({
      restore: [path('A.txt')],
      remove: [path('a.txt')],
      skipped: [],
    })
    expect((await restore(q)).done).toMatchObject({ restored: 1, removed: 1, failed: [] })
    expect(await readdir(folder)).toEqual(['A.txt'])
    expect(await readFile(path('A.txt'), 'utf8')).toBe('origin')
  })

  it('05 验收 49、51: CS3 restores Src and its child while removing distinct src', async () => {
    await mkdir(path('Src'))
    await writeFile(path('Src/x'), 'origin')
    const before = await take()
    await rm(path('Src'), { recursive: true })
    await mkdir(path('src'))
    await writeFile(path('src/y'), 'new')
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const preview = await snapshots.preview(q)
    expect(preview.skipped).toEqual([])
    expect(preview.restore).toEqual(expect.arrayContaining([path('Src'), path('Src/x')]))
    expect(preview.remove).toEqual(expect.arrayContaining([path('src'), path('src/y')]))
    expect((await restore(q)).done.failed).toEqual([])
    expect(await readdir(folder)).toEqual(['Src'])
    expect(await readdir(path('Src'))).toEqual(['x'])
    expect(await readFile(path('Src/x'), 'utf8')).toBe('origin')
  })
})
