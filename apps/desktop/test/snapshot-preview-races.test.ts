/** Preview rejects a live path that changes across the filesystem observations. */
import * as fs from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { snapshots, path, query, take } from './support/snapshot-boundaries.js'
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    readlink: vi.fn<typeof actual.readlink>(actual.readlink),
    open: vi.fn<typeof actual.open>(actual.open),
  }
})
const real = await vi.importActual<typeof fs>('node:fs/promises')
afterEach(() => {
  vi.mocked(fs.open).mockImplementation(real.open)
  vi.mocked(fs.readlink).mockImplementation(real.readlink)
})

it('05 验收 18、39: T1 — a link swapped during readlink is not planned from stale text', async () => {
  await real.symlink('old-target', path('L'))
  const before = await take()
  await real.rm(path('L'))
  await real.symlink('new-target', path('L'))
  const after = await take(undefined, 'after-call')
  vi.mocked(fs.readlink).mockImplementationOnce(async (...args) => {
    const text = await real.readlink(...args)
    await real.unlink(args[0])
    await real.symlink('swapped-mid-preview', args[0])
    return text
  })
  const preview = await snapshots.preview(query([{ callKey: 'bash', before, after }]))
  expect(preview.skipped).toEqual([{ path: path('L'), reason: 'not-covered' }])
  expect(preview.restore).toEqual([])
})

it.each(['before open', 'while reading'] as const)(
  '05 验收 18、39: T2 — a file changed %s during preview is not covered',
  async (when) => {
    await fs.writeFile(path('f'), 'A')
    const before = await take()
    await fs.writeFile(path('f'), 'B')
    const after = await take(undefined, 'after-call')
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      if (when === 'before open') await real.writeFile(args[0], 'changed before open')
      const handle = await real.open(...args)
      if (when === 'while reading') {
        const read = handle.read.bind(handle)
        vi.spyOn(handle, 'read').mockImplementationOnce(async (...readArgs) => {
          const data = await read(...readArgs)
          await real.writeFile(args[0], 'C') // same length: the final stamp must catch this
          await real.utimes(args[0], new Date(500_000), new Date(500_000))
          return data
        })
      }
      return handle
    })
    const preview = await snapshots.preview(query([{ callKey: 'bash', before, after }]))
    expect(preview.skipped).toEqual([{ path: path('f'), reason: 'not-covered' }])
    expect(preview.restore).toEqual([])
  },
)
