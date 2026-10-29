import type { RestoreQuery } from '@tenon-app/kernel'
import {
  appendFile,
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
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

async function recordedFileCall(
  callKey: string,
  name: string,
  act: () => Promise<void>,
): Promise<RestoreQuery['calls'][number]> {
  const before = await take(name)
  await act()
  return { callKey, path: path(name), before, after: await take(name, 'after-call') }
}

it.each(['B2', 'B4', 'B5', 'B5b', 'B6', 'B7', 'D3', 'D5'] as const)(
  '05 验收 19: D67 %s keeps the outside copy until overwrite is selected',
  async (scenario) => {
    const source = scenario === 'B5' || scenario === 'B5b' ? 'notes' : 'g'
    const target = source === 'notes' ? 'notes.bak' : scenario === 'B7' ? 'g.bak' : 'h'
    if (scenario === 'B5') await writeFile(path(source), 'origin')
    const calls = [
      scenario === 'B5'
        ? await recordedFileCall('c1', source, () => writeFile(path(source), 'agent'))
        : await recordedCall('c1', () => writeFile(path(source), 'agent')),
    ]
    await writeFile(path(source), outside)
    if (scenario === 'D3') {
      // Read has no snapshot; the following Write records only its own target.
      const read = await readFile(path(source))
      calls.push(await recordedFileCall('c2', target, () => writeFile(path(target), read)))
    } else {
      calls.push(
        await recordedCall('c2', async () => {
          if (scenario === 'B5' || scenario === 'B5b' || scenario === 'B6')
            await rename(path(source), path(target))
          else await copyFile(path(source), path(target))
          if (scenario === 'B4' || scenario === 'B5' || scenario === 'B5b')
            await writeFile(path(source), 'new')
          if (scenario === 'B6') await mkdir(path(source))
        }),
      )
    }
    if (scenario === 'B2') calls.push(await recordedCall('c3', () => rm(path(source))))
    if (scenario === 'D3' || scenario === 'D5')
      calls.push(await recordedFileCall('c3', source, () => rm(path(source))))
    if (scenario === 'B7')
      calls.push(await recordedFileCall('c3', source, () => writeFile(path(source), 'rewritten')))
    const q = query(calls)
    expect((await snapshots.preview(q)).conflicts).toContain(path(target))
    expect((await restore(q)).done.failed).toEqual([])
    expect(await readFile(path(target))).toEqual(outside)
    const preview = await snapshots.preview(q)
    expect(preview.conflicts).toContain(path(target))
    expect((await restore(q, [...preview.conflicts])).done.failed).toEqual([])
    const files = await readdir(folder)
    expect(files).toEqual(scenario === 'B5' ? ['notes'] : [])
    expect(await Promise.all(files.map((name) => readFile(path(name), 'utf8')))).toEqual(
      scenario === 'B5' ? ['origin'] : [],
    )
  },
)

it('05 验收 19: D67 B3 copying without changing the source keeps only the source in conflict', async () => {
  const first = await recordedCall('c1', () => writeFile(path('g'), 'agent'))
  await writeFile(path('g'), outside)
  const second = await recordedCall('c2', () => copyFile(path('g'), path('h')))
  const q = query([first, second])
  expect((await snapshots.preview(q)).conflicts).toEqual([path('g')])
  expect((await restore(q)).done).toMatchObject({ removed: 1, kept: 1, failed: [] })
  expect(await readdir(folder)).toEqual(['g'])
  expect(await readFile(path('g'))).toEqual(outside)
})

it('05 验收 19: D67 B5c rebuilding the same name without outside edits restores without conflicts', async () => {
  await writeFile(path('notes'), 'origin')
  const first = await recordedFileCall('c1', 'notes', () => writeFile(path('notes'), 'agent'))
  const second = await recordedCall('c2', async () => {
    await rename(path('notes'), path('notes.bak'))
    await writeFile(path('notes'), 'new')
  })
  const q = query([first, second])
  expect((await snapshots.preview(q)).conflicts).toEqual([])
  expect((await restore(q)).done).toMatchObject({ restored: 1, removed: 1, failed: [] })
  expect(await readdir(folder)).toEqual(['notes'])
  expect(await readFile(path('notes'), 'utf8')).toBe('origin')
})

it('05 验收 19: D67 C2 still keeps the renamed outside source after a separate copy', async () => {
  const first = await recordedCall('c1', () => writeFile(path('g'), 'agent'))
  await writeFile(path('g'), outside)
  const second = await recordedCall('c2', () => copyFile(path('g'), path('h')))
  const third = await recordedCall('c3', () => rename(path('g'), path('k')))
  const q = query([first, second, third])
  expect((await snapshots.preview(q)).conflicts).toContain(path('k'))
  expect((await restore(q)).done.failed).toEqual([])
  expect(await readFile(path('k'))).toEqual(outside)
})

it('05 验收 19: D67 H6 a deleted sibling is not a conflict and returns by default', async () => {
  await writeFile(path('k'), 'k0')
  const first = await recordedCall('c1', () => writeFile(path('g'), 'agent'))
  await writeFile(path('g'), outside)
  const second = await recordedCall('c2', async () => {
    await rename(path('g'), path('h'))
    await rm(path('k'))
  })
  const q = query([first, second])
  expect(await snapshots.preview(q)).toMatchObject({
    restore: [path('k')],
    conflicts: [path('h')],
  })
  expect((await restore(q)).done).toMatchObject({ restored: 1, kept: 1, failed: [] })
  expect(await readFile(path('k'), 'utf8')).toBe('k0')
  expect(await readFile(path('h'))).toEqual(outside)
})

it('05 验收 19: D67 F1 a missing after-call snapshot neither throws nor propagates', async () => {
  const first = await recordedCall('c1', () => writeFile(path('g'), 'agent'))
  await writeFile(path('g'), outside)
  const before = await take()
  await rename(path('g'), path('h'))
  const q = query([first, { callKey: 'c2', before }])
  await expect(snapshots.preview(q)).resolves.toMatchObject({
    restore: [],
    remove: [],
    conflicts: [],
  })
  expect((await restore(q)).done).toMatchObject({ restored: 0, removed: 0, failed: [] })
  expect(await readFile(path('h'))).toEqual(outside)
})

it('05 验收 19: a propagated gap protects a later copy until overwrite is selected', async () => {
  const first = await recordedCall('c1', () => writeFile(path('g'), 'agent'))
  await writeFile(path('g'), outside)
  const second = await recordedCall('c2', () => rename(path('g'), path('h')))
  const third = await recordedCall('c3', () => copyFile(path('h'), path('k')))
  const fourth = await recordedCall('c4', () => rm(path('h')))
  const q = query([first, second, third, fourth])
  expect((await snapshots.preview(q)).conflicts).toEqual([path('k')])
  expect((await restore(q)).done).toMatchObject({ removed: 0, kept: 1, failed: [] })
  expect(await readdir(folder)).toEqual(['k'])
  expect(await readFile(path('k'))).toEqual(outside)
  expect((await restore(q, [path('k')])).done).toMatchObject({ removed: 1, failed: [] })
  expect(await readdir(folder)).toEqual([])
})

it.each([
  ['older source first (g1/g2)', 'g1', 'g2'],
  ['older source last (z1/a2)', 'z1', 'a2'],
] as const)(
  '05 验收 19: multiple gap sources protect the oldest copy until overwrite is selected — %s',
  async (_order, older, newer) => {
    const first = await recordedCall('c1', () => writeFile(path(older), 'agent1'))
    await writeFile(path(older), outside)
    const second = await recordedCall('c2', async () => {
      await copyFile(path(older), path('k'))
      await writeFile(path(newer), 'agent2')
    })
    await writeFile(path(newer), 'outside-2')
    const third = await recordedCall('c3', async () => {
      await rm(path(older))
      await rm(path(newer))
    })
    const q = query([first, second, third])
    expect((await snapshots.preview(q)).conflicts).toEqual([path('k')])
    expect((await restore(q)).done).toMatchObject({ removed: 0, kept: 1, failed: [] })
    expect(await readdir(folder)).toEqual(['k'])
    expect(await readFile(path('k'))).toEqual(outside)
    expect((await restore(q, [path('k')])).done).toMatchObject({ removed: 1, failed: [] })
    expect(await readdir(folder)).toEqual([])
  },
)

it('05 验收 19: a stopped call does not turn an earlier deletion into a conflict', async () => {
  await writeFile(path('p'), 'origin')
  const first = await recordedCall('c1', () => writeFile(path('g'), 'agent'))
  await writeFile(path('g'), outside)
  const second = await recordedCall('c2', () => appendFile(path('p'), '+agent'))
  const third = await recordedCall('c3', () => rm(path('p')))
  const before = await take()
  await appendFile(path('g'), '+stopped')
  const q = query([first, second, third, { callKey: 'c4', before }])
  expect(await snapshots.preview(q)).toMatchObject({
    restore: [path('p')],
    conflicts: [path('g')],
  })
  expect((await restore(q)).done).toMatchObject({ restored: 1, kept: 1, failed: [] })
  expect(await readFile(path('p'), 'utf8')).toBe('origin')
  expect(await readFile(path('g'))).toEqual(Buffer.concat([outside, Buffer.from('+stopped')]))
})

it('05 验收 19: recreating an externally deleted source does not make a new sibling conflict', async () => {
  const first = await recordedCall('c1', () => writeFile(path('g'), 'agent'))
  await rm(path('g'))
  const second = await recordedCall('c2', async () => {
    await writeFile(path('g'), 'agent again')
    await writeFile(path('n'), 'new')
  })
  const q = query([first, second])
  expect((await snapshots.preview(q)).conflicts).toEqual([path('g')])
  expect((await restore(q)).done).toMatchObject({ removed: 1, kept: 1, failed: [] })
  expect(await readdir(folder)).toEqual(['g'])
  expect(await readFile(path('g'), 'utf8')).toBe('agent again')
})

it.each(['new file', 'existing file'] as const)(
  '05 验收 19: moved first edit (%s) stays a conflict after a second edit of the original name',
  async (destination) => {
    await writeFile(path('a'), 'origin a')
    await writeFile(path('d'), 'origin d')
    if (destination === 'existing file') await writeFile(path('c'), 'origin c')
    const first = await recordedCall('c1', () => appendFile(path('a'), ' agent'))
    await writeFile(path('d'), outside)
    const second = await recordedCall('c2', async () => {
      await rename(path('d'), path('c'))
      await copyFile(path('a'), path('d'))
    })
    await writeFile(path('d'), 'your second edit')
    const q = query([first, second])
    const preview = await snapshots.preview(q)
    expect(preview.conflicts.toSorted()).toEqual([path('c'), path('d')])
    expect(destination === 'new file' ? preview.remove : preview.restore).toContain(path('c'))
    // prepare must preserve the same conflict decision as preview, and apply must keep both.
    expect((await restore(q)).done).toMatchObject({ kept: 2, failed: [] })
    expect(await readFile(path('c'))).toEqual(outside)
    expect(await readFile(path('d'), 'utf8')).toBe('your second edit')
    expect((await snapshots.preview(q)).conflicts.toSorted()).toEqual([path('c'), path('d')])
    expect((await restore(q, [path('c'), path('d')])).done).toMatchObject({ kept: 0, failed: [] })
    expect(await readFile(path('d'))).toEqual(outside)
    const remaining = await readFile(path('c'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    expect(remaining).toBe(destination === 'new file' ? null : 'origin c')
  },
)

it('05 验收 19: a move and replacement without outside edits restores without content conflicts', async () => {
  await writeFile(path('a'), 'origin a')
  await writeFile(path('d'), 'origin d')
  const first = await recordedCall('c1', () => appendFile(path('a'), ' agent'))
  const second = await recordedCall('c2', async () => {
    await rename(path('d'), path('c'))
    await copyFile(path('a'), path('d'))
  })
  const q = query([first, second])
  expect((await snapshots.preview(q)).conflicts).toEqual([])
  expect((await restore(q)).done).toMatchObject({ removed: 1, kept: 0, failed: [] })
  expect(await readdir(folder)).toEqual(['a', 'd'])
  expect(await readFile(path('d'), 'utf8')).toBe('origin d')
})

it.each(['different bytes of the same size', 'empty bytes'] as const)(
  '05 验收 19: a new file with %s does not inherit a content conflict',
  async (content) => {
    const origin = content === 'empty bytes' ? '' : 'first'
    const created = content === 'empty bytes' ? '' : 'other'
    await writeFile(path('d'), origin)
    const call = await recordedCall('c1', async () => {
      await writeFile(path('c'), created)
      await writeFile(path('d'), 'agent')
    })
    await writeFile(path('d'), 'your second edit')
    const q = query([call])
    expect((await snapshots.preview(q)).conflicts).toEqual([path('d')])
    expect((await restore(q)).done).toMatchObject({ removed: 1, kept: 1, failed: [] })
    expect(await readdir(folder)).toEqual(['d'])
    expect(await readFile(path('d'), 'utf8')).toBe('your second edit')
  },
)

it.each([true, false])(
  '05 验收 19: content conflicts follow the whole move chain (outside edits: %s)',
  async (edited) => {
    await writeFile(path('d'), 'origin d')
    await writeFile(path('x'), 'origin x')
    const first = await recordedCall('c1', async () => {
      await copyFile(path('d'), path('z'))
      await writeFile(path('d'), 'agent')
    })
    if (edited) {
      await writeFile(path('x'), 'your x')
      await writeFile(path('d'), 'your d')
    }
    const second = await recordedCall('c2', async () => {
      await rename(path('x'), path('y'))
      await rename(path('z'), path('x'))
    })
    const q = query([first, second])
    expect((await snapshots.preview(q)).conflicts.toSorted()).toEqual(
      edited ? [path('d'), path('x'), path('y')] : [],
    )
    expect((await restore(q)).done).toMatchObject({ kept: edited ? 3 : 0, failed: [] })
    expect(await readFile(path('d'), 'utf8')).toBe(edited ? 'your d' : 'origin d')
    expect(await readFile(path('x'), 'utf8')).toBe(edited ? 'origin d' : 'origin x')
    const moved = await readFile(path('y'), 'utf8').catch(() => null)
    expect(moved).toBe(edited ? 'your x' : null)
    const overwrite = (await snapshots.preview(q)).conflicts
    expect((await restore(q, [...overwrite])).done.failed).toEqual([])
    expect(await readdir(folder)).toEqual(['d', 'x'])
    expect(await readFile(path('d'), 'utf8')).toBe('origin d')
    expect(await readFile(path('x'), 'utf8')).toBe(edited ? 'your x' : 'origin x')
  },
)

it.each([true, false])(
  '05 验收 19: a skipped origin protects its moved content (outside edit: %s)',
  async (edited) => {
    await writeFile(path('a'), 'origin a')
    await writeFile(path('d'), 'origin d')
    await writeFile(path('.gitignore'), 'build/\n')
    const first = await recordedCall('c1', () => appendFile(path('a'), ' agent'))
    if (edited) await writeFile(path('d'), 'your d')
    const second = await recordedCall('c2', async () => {
      await rename(path('d'), path('c'))
      await appendFile(path('.gitignore'), 'd\n')
    })
    const q = query([first, second])
    const p = await snapshots.preview(q)
    expect(p.skipped).toContainEqual({ path: path('d'), reason: 'excluded' })
    expect(p.conflicts).toContain(path('c'))
    expect((await restore(q)).done).toMatchObject({ kept: 1, failed: [] })
    expect(await readFile(path('c'), 'utf8')).toBe(edited ? 'your d' : 'origin d')
  },
)

it('05 验收 19: a gap-only conflict protects a copy of the edit made before the first touch', async () => {
  await writeFile(path('a'), 'origin a')
  await writeFile(path('d'), 'origin d')
  const first = await recordedCall('c0', () => appendFile(path('a'), ' agent'))
  await writeFile(path('d'), 'your first edit')
  const second = await recordedCall('c1', async () => {
    await copyFile(path('d'), path('c'))
    await writeFile(path('d'), 'agent one')
  })
  await writeFile(path('d'), 'your second edit')
  const third = await recordedCall('c2', () => writeFile(path('d'), 'agent two'))
  const q = query([first, second, third])
  expect((await snapshots.preview(q)).conflicts.toSorted()).toEqual([path('c'), path('d')])
  expect((await restore(q)).done).toMatchObject({ kept: 2, failed: [] })
  expect(await readFile(path('c'), 'utf8')).toBe('your first edit')
  expect(await readFile(path('d'), 'utf8')).toBe('agent two')
})

it('05 验收 19: an ignored original still in place does not protect its example copy', async () => {
  await writeFile(path('.gitignore'), 'build/\n')
  await writeFile(path('settings.local.json'), '{"name":"local"}\n')
  const call = await recordedCall('copy', async () => {
    await copyFile(path('settings.local.json'), path('settings.example.json'))
    await appendFile(path('.gitignore'), 'settings.local.json\n')
  })
  const q = query([call])
  const preview = await snapshots.preview(q)
  expect(preview.skipped).toContainEqual({ path: path('settings.local.json'), reason: 'excluded' })
  expect(preview.conflicts).toEqual([])
  expect((await restore(q)).done).toMatchObject({ kept: 0, failed: [] })
  expect(await readdir(folder)).toEqual(['.gitignore', 'settings.local.json'])
  expect(await readFile(path('settings.local.json'), 'utf8')).toBe('{"name":"local"}\n')
  expect(await readFile(path('.gitignore'), 'utf8')).toBe('build/\n')
})

it('05 验收 19: ignored originals still in place let all backup copies and their directory be removed', async () => {
  await writeFile(path('.gitignore'), 'build/\n')
  await mkdir(path('data'))
  const names = ['a', 'b', 'c']
  await Promise.all(names.map((name) => writeFile(path(`data/${name}`), `origin ${name}`)))
  const call = await recordedCall('backup', async () => {
    await mkdir(path('backup'))
    await Promise.all(names.map((name) => copyFile(path(`data/${name}`), path(`backup/${name}`))))
    await appendFile(path('.gitignore'), 'data/\n')
  })
  const q = query([call])
  expect((await snapshots.preview(q)).conflicts).toEqual([])
  expect((await restore(q)).done).toMatchObject({ kept: 0, failed: [] })
  expect(await readdir(folder)).toEqual(['.gitignore', 'data'])
  expect(await readdir(path('data'))).toEqual(names)
  expect(await Promise.all(names.map((name) => readFile(path(`data/${name}`), 'utf8')))).toEqual(
    names.map((name) => `origin ${name}`),
  )
  expect(await readFile(path('.gitignore'), 'utf8')).toBe('build/\n')
})

it('05 验收 19: a hardlink skip protects its original bytes moved to a new file', async () => {
  await writeFile(path('h'), 'origin bytes')
  const call = await recordedCall('move', async () => {
    await rename(path('h'), path('moved'))
    await writeFile(path('h'), 'replacement bytes')
    await link(path('h'), path('second-name'))
  })
  const q = query([call])
  const preview = await snapshots.preview(q)
  expect(preview.skipped).toContainEqual({ path: path('h'), reason: 'hardlink' })
  expect(preview.remove).toContain(path('moved'))
  expect(preview.conflicts).toEqual([path('moved')])
  expect((await restore(q)).done).toMatchObject({ kept: 1, failed: [] })
  expect(await readFile(path('moved'), 'utf8')).toBe('origin bytes')
  expect(await readFile(path('h'), 'utf8')).toBe('replacement bytes')
})
