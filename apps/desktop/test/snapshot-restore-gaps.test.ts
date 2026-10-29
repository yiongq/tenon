import type { RestoreQuery } from '@tenon-app/kernel'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { folder, path, snapshots, query, take, restore } from './support/snapshot-boundaries.js'

async function recordedCall(
  callKey: string,
  act: () => Promise<void>,
): Promise<RestoreQuery['calls'][number]> {
  const before = await take()
  await act()
  return { callKey, before, after: await take(undefined, 'after-call') }
}

const outside = Buffer.from('outside\0bytes\n')
const scenarios = [
  { name: 'G1-plain', origin: 'f', middle: 'g', target: 'f' },
  { name: 'G1-leaf', origin: 'A.txt', middle: 'a.txt', target: 'A.txt' },
  { name: 'G2-plain', origin: undefined, middle: 'g', target: 'h' },
  { name: 'multi-hop', origin: 'f', middle: 'g', target: 'k' },
] as const

async function renamedRound(
  scenario: (typeof scenarios)[number],
  gap: boolean,
): Promise<RestoreQuery> {
  const { origin, middle, target } = scenario
  if (origin !== undefined) await writeFile(path(origin), 'origin')
  const calls = [
    await recordedCall('c1', () =>
      origin === undefined ? writeFile(path(middle), 'agent') : rename(path(origin), path(middle)),
    ),
  ]
  if (gap) await writeFile(path(middle), outside)
  calls.push(
    await recordedCall('c2', () =>
      rename(path(middle), path(scenario.name === 'multi-hop' ? 'h' : target)),
    ),
  )
  if (scenario.name === 'multi-hop')
    calls.push(await recordedCall('c3', () => rename(path('h'), path(target))))
  return query(calls)
}

for (const scenario of scenarios) {
  // Case-only leaf names alias on macOS APFS; ordinary renames run on both platforms.
  it.skipIf(scenario.name === 'G1-leaf' && process.platform !== 'darwin')(
    `05 验收 19: ${scenario.name} keeps renamed outside bytes until overwrite is selected`,
    async () => {
      const q = await renamedRound(scenario, true)
      const target = path(scenario.target)
      expect((await snapshots.preview(q)).conflicts).toContain(target)
      expect((await restore(q)).done).toMatchObject({ kept: 1, failed: [] })
      expect(await readFile(target)).toEqual(outside)
      expect((await snapshots.preview(q)).conflicts).toContain(target)
      expect((await restore(q, [target])).done.failed).toEqual([])
      expect(await readdir(folder)).toEqual(scenario.origin === undefined ? [] : [scenario.origin])
      const files = await readdir(folder)
      expect(await Promise.all(files.map((name) => readFile(path(name), 'utf8')))).toEqual(
        scenario.origin === undefined ? [] : ['origin'],
      )
    },
  )

  it.skipIf(scenario.name === 'G1-leaf' && process.platform !== 'darwin')(
    `05 验收 19: ${scenario.name} without outside edits restores without a conflict`,
    async () => {
      const q = await renamedRound(scenario, false)
      expect((await snapshots.preview(q)).conflicts).toEqual([])
      expect((await restore(q)).done).toMatchObject({ kept: 0, failed: [] })
      expect(await readdir(folder)).toEqual(scenario.origin === undefined ? [] : [scenario.origin])
      const files = await readdir(folder)
      expect(await Promise.all(files.map((name) => readFile(path(name), 'utf8')))).toEqual(
        scenario.origin === undefined ? [] : ['origin'],
      )
    },
  )
}

it('05 验收 19: a disappearing gap protects every changed or created path in that call', async () => {
  await writeFile(path('f'), 'origin')
  await writeFile(path('other'), 'other origin')
  const first = await recordedCall('c1', () => rename(path('f'), path('g')))
  await writeFile(path('g'), outside)
  const second = await recordedCall('c2', async () => {
    await rename(path('g'), path('h'))
    await writeFile(path('other'), 'different changed content')
    await writeFile(path('new'), 'different new content')
  })
  const q = query([first, second])
  expect((await snapshots.preview(q)).conflicts.toSorted()).toEqual(
    [path('h'), path('new'), path('other')].toSorted(),
  )
  expect((await restore(q)).done).toMatchObject({ kept: 3, failed: [] })
  expect(await readFile(path('h'))).toEqual(outside)
  expect(await readFile(path('other'), 'utf8')).toBe('different changed content')
  expect(await readFile(path('new'), 'utf8')).toBe('different new content')
})

it('05 验收 19: a disappearance without a gap does not make a new file conflict', async () => {
  const first = await recordedCall('c1', () => writeFile(path('g'), 'agent'))
  const second = await recordedCall('c2', async () => {
    await rm(path('g'))
    await writeFile(path('new'), 'different content')
  })
  const q = query([first, second])
  expect(await snapshots.preview(q)).toMatchObject({ remove: [path('new')], conflicts: [] })
  expect((await restore(q)).done).toMatchObject({ removed: 1, kept: 0, failed: [] })
  expect(await readdir(folder)).toEqual([])
})
