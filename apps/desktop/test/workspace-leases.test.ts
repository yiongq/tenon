import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
import {
  workspaceLeases,
  WorkspaceLeases,
  markSnapshotCommand,
  leaseCommand,
  leaseSpawn,
  commandCleaned,
} from '../src/main/host/workspace-leases.js'
import { temp, folder } from './support/snapshot-boundaries.js'
const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const raceNow = async <T>(promise: Promise<T>): Promise<'pending' | 'done'> =>
  Promise.race([promise.then(() => 'done' as const), tick().then(() => 'pending' as const)])

// ---------------------------------------------------------------- workspace-leases.ts
it('05 验收 53: L1: an exclusive lease blocks overlapping shared/exclusive holders, wakes waiters on release, tolerates a double release', async () => {
  const leases = new WorkspaceLeases()
  const release = leases.exclusive(['/w/a', '/w/b'])!
  expect(release).not.toBeNull()
  expect(leases.exclusive(['/w/a/x'])).toBeNull()
  expect(leases.exclusive(['/w'])).toBeNull()
  const unrelated = leases.exclusive(['/other'])!
  expect(unrelated).not.toBeNull()
  unrelated()
  const waiting = leases.shared(['/w/b/sub'])
  expect(await raceNow(waiting)).toBe('pending')
  const multi = leases.shared(['/zzz', '/w/a'])
  expect(await raceNow(multi)).toBe('pending')
  const free = await leases.shared(['/zzz'])
  free()
  release()
  ;(await waiting)()
  ;(await multi)()
  release() // a second release is a no-op
  const shared = await leases.shared(['/w/a'])
  expect(leases.exclusive(['/w/a'])).toBeNull() // shared holders block exclusive ones
  const second = await leases.shared(['/w/a']) // shared holders never block each other
  second()
  shared()
  const final = leases.exclusive(['/w/a'])
  expect(final).not.toBeNull()
  final?.()
})

it('05 验收 53: L2: write() outside every registered folder still waits for an exclusive lease on a folder below its directory', async () => {
  const leases = new WorkspaceLeases()
  const owner = {}
  const inside = absolutePath(join(temp, 'workspace'))
  leases.setFolders(owner, [inside])
  const release = leases.exclusive([inside])!
  let wrote = false
  const writing = leases.write(absolutePath(join(temp, 'sibling.txt')), async () => {
    wrote = true
  })
  expect(await raceNow(writing)).toBe('pending')
  expect(wrote).toBe(false)
  release()
  await writing
  expect(wrote).toBe(true)
  // a write inside the folder is leased on the folder itself, and forget() drops the registration
  const release2 = leases.exclusive([inside])!
  const inner = leases.write(absolutePath(join(inside, 'f.txt')), async () => 1)
  expect(await raceNow(inner)).toBe('pending')
  release2()
  expect(await inner).toBe(1)
  leases.forget(owner)
  const release3 = leases.exclusive([inside])!
  const after = leases.write(absolutePath(join(inside, 'g.txt')), async () => 2)
  // without a registered folder the lease falls back to the directory, which still overlaps
  expect(await raceNow(after)).toBe('pending')
  release3()
  expect(await after).toBe(2)
})

it('05 验收 53: L3: a host-marked snapshot command never waits for an exclusive restore; an unmarked one does; a failed wrap releases its lease', async () => {
  const dir = folder
  const held = workspaceLeases.exclusive([dir])!
  expect(held).not.toBeNull()
  try {
    const marked = ['/usr/bin/git', 'status']
    const internalId = randomUUID()
    markSnapshotCommand(marked)
    const internal = leaseCommand(
      { commandId: internalId, argv: marked, cwd: dir, workspace: [dir] } as never,
      async () => ({ argv: marked }),
      (f) => f,
    )
    expect(await raceNow(internal)).toBe('done')
    commandCleaned(internalId)
    const plain = ['/bin/echo', 'hi']
    const id = `probe-${randomUUID()}`
    const waiting = leaseCommand(
      { commandId: id, argv: plain, cwd: dir, workspace: [dir] } as never,
      async () => ({ argv: plain }),
      (f) => f,
    )
    expect(await raceNow(waiting)).toBe('pending')
    held()
    const result = await waiting
    const child = { exited: Promise.resolve(0) }
    await leaseSpawn(plain, async () => child as never)
    await tick()
    commandCleaned(id)
    expect(result.argv).toBe(plain)
  } finally {
    held()
  }
  // wrap() throwing must not leave the workspace permanently shared-held
  await expect(
    leaseCommand(
      { commandId: `probe-${randomUUID()}`, argv: ['/bin/x'], cwd: dir, workspace: [dir] } as never,
      async () => {
        throw new Error('wrap failed')
      },
      (f) => f,
    ),
  ).rejects.toThrow('wrap failed')
  const again = workspaceLeases.exclusive([dir])
  expect(again).not.toBeNull()
  again?.()
})

it.each(['exit-first', 'cleanup-first'] as const)(
  '05 验收 53: leaseSpawn retains the workspace until both exit and cleanup (%s)',
  async (order) => {
    const id = randomUUID()
    const argv = ['/bin/echo', 'hi']
    const exited = Promise.withResolvers<number>()
    await leaseCommand(
      { commandId: id, argv, cwd: folder, workspace: [folder] } as never,
      async () => ({ argv }),
      (f) => f,
    )
    await leaseSpawn(argv, async () => ({ exited: exited.promise }) as never)
    try {
      if (order === 'exit-first') exited.resolve(0)
      else commandCleaned(id)
      await Promise.resolve()
      expect(workspaceLeases.exclusive([folder])).toBeNull()
    } finally {
      exited.resolve(0)
      commandCleaned(id)
      await Promise.resolve()
    }
    const release = workspaceLeases.exclusive([folder])
    expect(release).not.toBeNull()
    release?.()
  },
)

it('05 验收 53: leaseSpawn failure cleans and releases; cleaning before spawn rejects without launching', async () => {
  const id = randomUUID()
  const argv = ['/bin/echo']
  let cleaned = false
  await leaseCommand(
    { commandId: id, argv, cwd: folder, workspace: [folder] } as never,
    async () => ({ argv }),
    (f) => f,
    async () => {
      cleaned = true
      commandCleaned(id)
    },
  )
  await expect(
    leaseSpawn(argv, async () => {
      throw new Error('spawn failed')
    }),
  ).rejects.toThrow('spawn failed')
  expect(cleaned).toBe(true)
  const release = workspaceLeases.exclusive([folder])
  expect(release).not.toBeNull()
  release?.()
  let launched = false
  await expect(
    leaseSpawn(argv, async () => {
      launched = true
      throw new Error('should not launch')
    }),
  ).rejects.toThrow('already cleaned')
  expect(launched).toBe(false)
})

function isFree(path: typeof folder): boolean {
  const release = workspaceLeases.exclusive([path])
  release?.()
  return release !== null
}

it.each([false, true])(
  '05 验收 53: RC-L1 — reused id cleans the earliest exited lease (both exited before cleanup: %s)',
  async (bothExited) => {
    const id = randomUUID()
    const a = absolutePath(join(temp, 'a'))
    const b = absolutePath(join(temp, 'b'))
    const exitA = Promise.withResolvers<number>()
    const exitB = Promise.withResolvers<number>()
    const wrap = (cwd: typeof a) =>
      leaseCommand(
        {
          commandId: id,
          argv: ['/bin/cat'],
          cwd,
          env: {},
          profile: 'workspace-write',
          workspace: [cwd],
        },
        async () => ({ argv: ['/bin/cat'] }),
        (f) => f,
      )
    const first = await wrap(a)
    await leaseSpawn(first.argv, async () => ({ exited: exitA.promise }) as never)
    const second = await wrap(b)
    await leaseSpawn(second.argv, async () => ({ exited: exitB.promise }) as never)
    try {
      exitB.resolve(0)
      await exitB.promise
      if (bothExited) {
        exitA.resolve(0)
        await exitA.promise
      }
      expect(isFree(a)).toBe(false)
      expect(isFree(b)).toBe(false)
      commandCleaned(id)
      expect(isFree(b)).toBe(true)
      expect(isFree(a)).toBe(false)
      exitA.resolve(0)
      await exitA.promise
      expect(isFree(a)).toBe(false)
      commandCleaned(id)
      expect(isFree(a)).toBe(true)
      expect(isFree(b)).toBe(true)
    } finally {
      exitA.resolve(0)
      exitB.resolve(0)
      await Promise.resolve()
      commandCleaned(id)
      commandCleaned(id)
    }
  },
)
