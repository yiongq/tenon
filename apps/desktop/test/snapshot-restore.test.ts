/* oxlint-disable no-await-in-loop -- sequential filesystem assertions preserve the operation order under test. */
/** Real git, disposable HOME/profile/workspace; no user files, models or credentials. */
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
import type { AbsolutePath, RestoreQuery, SnapshotRequest } from '@tenon-app/kernel'
import { DesktopSnapshots } from '../src/main/host/snapshots.js'
import { SystemClock } from '../src/main/host/clock.js'
import { createHostProcess } from '../src/main/host/process.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'
import { DesktopFs } from '../src/main/host/fs.js'
import { wiringFixture } from './sandbox/wiring-support.js'
import {
  workspaceLeases,
  leaseCommand,
  leaseSpawn,
  commandCleaned,
} from '../src/main/host/workspace-leases.js'

let temp: string
let folder: AbsolutePath
let snapshots: DesktopSnapshots
let sessionId: string
let roundRunId: string
const signal = (): AbortSignal => new AbortController().signal
const path = (name: string): AbsolutePath => absolutePath(join(folder, name))
const query = (calls: RestoreQuery['calls']): RestoreQuery => ({ sessionId, roundRunId, calls })
async function take(
  name?: string,
  moment: SnapshotRequest['moment'] = 'before-call',
): Promise<string> {
  const result = await snapshots.take(
    {
      sessionId,
      call: { sessionId, roundRunId, runId: roundRunId, requestSeq: 1, ordinal: 0 },
      folders: [folder],
      moment,
      ...(name === undefined ? {} : { path: path(name) }),
    },
    signal(),
  )
  if (!result.ok) throw new Error(`capture failed: ${result.reason}`)
  return result.snapshotId
}
async function restore(q: RestoreQuery, overwrite: AbsolutePath[] = []) {
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  expect(prepared).toMatchObject({ ok: true })
  if (!prepared.ok) throw new Error(prepared.reason)
  return {
    done: await snapshots.apply({ sessionId, undoSnapshotId: prepared.undoSnapshotId, overwrite }),
    undo: prepared.undoSnapshotId,
  }
}
beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'tenon-restore-')))
  folder = absolutePath(join(temp, 'workspace'))
  const home = absolutePath(join(temp, 'home'))
  const profileDir = absolutePath(join(temp, 'profile'))
  await Promise.all([folder, home, profileDir].map((dir) => mkdir(dir)))
  sessionId = randomUUID()
  roundRunId = randomUUID()
  snapshots = new DesktopSnapshots({
    identity: { userId: 'test', tenantId: 'test', profileDir },
    process: createHostProcess(),
    sandbox: new PassthroughSandbox(() => {}),
    clock: new SystemClock(),
    home,
  })
  await snapshots.setWorkspace(sessionId, [folder])
  await snapshots.settled(sessionId)
  if (snapshots.status(sessionId) !== 'tree')
    throw new Error(snapshots.lastDegradeReason(sessionId) ?? 'Expected tree snapshots')
})
afterEach(async () => {
  await snapshots.settled(sessionId)
  await rm(temp, { recursive: true, force: true })
})

it('05 验收 16: preview and cancel never change workspace bytes or stamps', async () => {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const q = query([{ callKey: 'c', before, after, path: path('f') }])
  const stamp = await lstat(path('f'), { bigint: true })
  const preview = await snapshots.preview(q)
  expect(preview).toMatchObject({ restore: [path('f')], remove: [], conflicts: [], skipped: [] })
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  if (!prepared.ok) throw new Error(prepared.reason)
  await snapshots.cancel({ sessionId, undoSnapshotId: prepared.undoSnapshotId })
  expect(await readFile(path('f'), 'utf8')).toBe('B')
  expect((await lstat(path('f'), { bigint: true })).mtimeNs).toBe(stamp.mtimeNs)
  await expect(
    snapshots.apply({ sessionId, undoSnapshotId: prepared.undoSnapshotId, overwrite: [] }),
  ).rejects.toThrow('not prepared')
})

it('05 验收 17: restore contents, deleted files, binary bytes, link text and modes; remove creations', async () => {
  await writeFile(path('f'), Buffer.from([0, 255, 128, 10]), { mode: 0o600 })
  await writeFile(path('deleted'), 'deleted', { mode: 0o600 })
  await writeFile(path('mode'), 'mode', { mode: 0o600 })
  await symlink('f', path('link'))
  if (process.platform === 'darwin') {
    const { lchmod } = await import('node:fs/promises')
    await lchmod(path('link'), 0o600)
  }
  const linkMode = (await lstat(path('link'))).mode & 0o7777
  const before = await take()
  await writeFile(path('f'), 'B')
  await chmod(path('f'), 0o644)
  await rm(path('deleted'))
  await chmod(path('mode'), 0o644)
  await rm(path('link'))
  await symlink('elsewhere', path('link'))
  await writeFile(path('new'), 'new')
  const after = await take(undefined, 'after-call')
  const modeStamp = (await lstat(path('mode'), { bigint: true })).mtimeNs
  const confirmed = Date.now()
  const { done } = await restore(query([{ callKey: 'bash', before, after }]))
  expect(done).toMatchObject({ restored: 4, removed: 1, failed: [] })
  expect(await readFile(path('f'))).toEqual(Buffer.from([0, 255, 128, 10]))
  expect(await readFile(path('deleted'), 'utf8')).toBe('deleted')
  expect(await readFile(path('mode'), 'utf8')).toBe('mode')
  for (const name of ['f', 'deleted', 'mode'])
    expect((await lstat(path(name))).mode & 0o7777).toBe(0o600)
  expect((await lstat(path('f'))).isFile()).toBe(true)
  expect((await lstat(path('link'))).isSymbolicLink()).toBe(true)
  expect(await readlink(path('link'))).toBe('f')
  expect((await lstat(path('link'))).mode & 0o7777).toBe(linkMode)
  expect((await lstat(path('f'))).mtimeMs).toBeGreaterThanOrEqual(confirmed)
  expect((await lstat(path('mode'), { bigint: true })).mtimeNs).toBe(modeStamp)
  await expect(lstat(path('new'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('05 验收 18、20、54: preserve external edits, reject forged overwrites, restore the first origin after approval', async () => {
  await writeFile(path('f'), 'A')
  const b1 = await take('f')
  await writeFile(path('f'), 'B')
  const a1 = await take('f', 'after-call')
  await writeFile(path('f'), 'C')
  const b2 = await take('f')
  await writeFile(path('f'), 'D')
  const a2 = await take('f', 'after-call')
  const q = query([
    { callKey: '1', before: b1, after: a1, path: path('f') },
    { callKey: '2', before: b2, after: a2, path: path('f') },
  ])
  expect((await snapshots.preview(q)).conflicts).toEqual([path('f')])
  expect((await restore(q)).done).toMatchObject({ restored: 0, kept: 1 })
  expect(await readFile(path('f'), 'utf8')).toBe('D')
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  if (!prepared.ok) throw new Error(prepared.reason)
  await expect(
    snapshots.apply({
      sessionId,
      undoSnapshotId: prepared.undoSnapshotId,
      overwrite: [path('forged')],
    }),
  ).rejects.toThrow('subset')
  expect(await readFile(path('f'), 'utf8')).toBe('D')
  expect((await restore(q, [path('f')])).done).toMatchObject({ restored: 1, kept: 0, failed: [] })
  expect(await readFile(path('f'), 'utf8')).toBe('A')
  // A later round's edit conflicts with this earlier round's last record too.
  await writeFile(path('f'), 'later round')
  expect(
    (await snapshots.preview(query([{ callKey: '1', before: b1, after: a1, path: path('f') }])))
      .conflicts,
  ).toEqual([path('f')])
})

it('05 验收 19: only three agent paths change in a 2000-file tree; approval-gap and ignored edits survive', async () => {
  await Promise.all(
    Array.from({ length: 2000 }, (_, i) => writeFile(path(`f${i}`), `original ${i}`)),
  )
  await writeFile(path('.gitignore'), 'ignored\n')
  await writeFile(path('ignored'), 'original ignored')
  const untouched = await lstat(path('f1999'), { bigint: true })
  const before = await take()
  await Promise.all([0, 1, 2].map((i) => writeFile(path(`f${i}`), 'agent')))
  const after = await take(undefined, 'after-call')
  await writeFile(path('f1998'), 'owner in approval gap')
  await writeFile(path('ignored'), 'owner ignored')
  const { done } = await restore(query([{ callKey: 'bash', before, after }]))
  expect(done).toMatchObject({ restored: 3, removed: 0, failed: [] })
  for (const i of [0, 1, 2]) expect(await readFile(path(`f${i}`), 'utf8')).toBe(`original ${i}`)
  expect(await readFile(path('f1999'), 'utf8')).toBe('original 1999')
  expect((await lstat(path('f1999'), { bigint: true })).mtimeNs).toBe(untouched.mtimeNs)
  expect(await readFile(path('f1998'), 'utf8')).toBe('owner in approval gap')
  expect(await readFile(path('ignored'), 'utf8')).toBe('owner ignored')
}, 30_000)

it('05 验收 21: the undo snapshot can return files to their pre-restore state', async () => {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const { undo } = await restore(query([{ callKey: 'c', before, after, path: path('f') }]))
  expect(await readFile(path('f'), 'utf8')).toBe('A')
  const restored = await take('f', 'after-call')
  expect(
    (await restore(query([{ callKey: 'undo', before: undo, after: restored, path: path('f') }])))
      .done.failed,
  ).toEqual([])
  expect(await readFile(path('f'), 'utf8')).toBe('B')
})

it.skipIf(process.platform === 'win32')(
  '05 验收 39: remove a substituted link before rebuilding parents; a later substituted link fails safely',
  async () => {
    await mkdir(path('sub'))
    await writeFile(path('sub/f'), 'origin', { mode: 0o600 })
    const outside = join(temp, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'f'), 'outside')
    const before = await take()
    await rm(path('sub'), { recursive: true })
    await symlink(outside, path('sub'))
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const { done } = await restore(q)
    expect(done.failed).toEqual([])
    expect((await lstat(path('sub'))).isDirectory()).toBe(true)
    expect((await lstat(path('sub'))).isSymbolicLink()).toBe(false)
    expect(await readFile(path('sub/f'), 'utf8')).toBe('origin')
    expect((await lstat(path('sub/f'))).mode & 0o7777).toBe(0o600)
    expect(await readFile(join(outside, 'f'), 'utf8')).toBe('outside')
    await writeFile(path('sub/f'), 'agent')
    const q2 = query([
      { callKey: 'file', before, after: await take('sub/f', 'after-call'), path: path('sub/f') },
    ])
    const preview = await snapshots.preview(q2)
    const prepared = await snapshots.prepare({ ...q2, previewKey: preview.previewKey })
    if (!prepared.ok) throw new Error(prepared.reason)
    await rm(path('sub'), { recursive: true })
    await symlink(outside, path('sub'))
    expect(
      (await snapshots.apply({ sessionId, undoSnapshotId: prepared.undoSnapshotId, overwrite: [] }))
        .failed,
    ).toContain(path('sub/f'))
    expect(await readFile(join(outside, 'f'), 'utf8')).toBe('outside')
  },
)

// Linux CI uses a case-sensitive volume; this acceptance requires macOS's insensitive volume.
it.skipIf(process.platform !== 'darwin')(
  '05 验收 40: case-only rename is one restore and leaves only the origin spelling',
  async () => {
    await writeFile(path('A.txt'), 'A')
    const before = await take()
    const { rename, readdir } = await import('node:fs/promises')
    await rename(path('A.txt'), path('a.txt'))
    await writeFile(path('a.txt'), 'B')
    const after = await take(undefined, 'after-call')
    const { done } = await restore(query([{ callKey: 'bash', before, after }]))
    expect(done).toMatchObject({ restored: 1, removed: 0, failed: [] })
    expect(await readdir(folder)).toEqual(['A.txt'])
    expect(await readFile(path('A.txt'), 'utf8')).toBe('A')
  },
)

it('05 验收 41: changed ignore rules and nested repositories are skipped rather than treated as additions/deletions', async () => {
  await writeFile(path('f'), 'A')
  await mkdir(path('nested'))
  await writeFile(path('nested/f'), 'A')
  const before = await take()
  await writeFile(path('.gitignore'), 'f\n')
  await writeFile(path('f'), 'B')
  await writeFile(path('nested/.git'), 'gitdir: elsewhere\n')
  const after = await take(undefined, 'after-call')
  const preview = await snapshots.preview(query([{ callKey: 'bash', before, after }]))
  expect(preview.skipped).toEqual(
    expect.arrayContaining([
      { path: path('f'), reason: 'excluded' },
      { path: path('nested/f'), reason: 'excluded' },
    ]),
  )
  expect(preview.restore).not.toContain(path('f'))
  expect(preview.remove).not.toContain(path('nested/f'))
  expect(await readFile(path('f'), 'utf8')).toBe('B')
})

it.skipIf(process.platform === 'win32')(
  '05 验收 49: rebuild deleted nested directories and finalize 0555 permissions after restoring children',
  async () => {
    await mkdir(path('top/ro/deep'), { recursive: true })
    await writeFile(path('top/ro/deep/f'), 'A', { mode: 0o600 })
    await chmod(path('top/ro'), 0o555)
    const before = await take()
    await chmod(path('top/ro'), 0o755)
    await rm(path('top'), { recursive: true })
    const after = await take(undefined, 'after-call')
    const { done } = await restore(query([{ callKey: 'bash', before, after }]))
    expect(done.failed).toEqual([])
    for (const dir of ['top', 'top/ro', 'top/ro/deep'])
      expect((await lstat(path(dir))).isDirectory()).toBe(true)
    expect((await lstat(path('top/ro'))).mode & 0o7777).toBe(0o555)
    expect((await lstat(path('top/ro/deep/f'))).mode & 0o7777).toBe(0o600)
    expect(await readFile(path('top/ro/deep/f'), 'utf8')).toBe('A')
    await chmod(path('top/ro'), 0o755)
  },
)

it('05 验收 51: paths already at origin disappear from the plan and keep their mtime', async () => {
  await writeFile(path('a'), 'A')
  await writeFile(path('b'), 'A')
  const before = await take()
  await writeFile(path('a'), 'B')
  await writeFile(path('b'), 'B')
  const after = await take(undefined, 'after-call')
  await writeFile(path('a'), 'A')
  const stamp = await lstat(path('a'), { bigint: true })
  const q = query([{ callKey: 'bash', before, after }])
  expect((await snapshots.preview(q)).restore).toEqual([path('b')])
  expect((await snapshots.preview(q)).conflicts).toEqual([])
  await restore(q)
  expect((await lstat(path('a'), { bigint: true })).mtimeNs).toBe(stamp.mtimeNs)
  expect(await readFile(path('b'), 'utf8')).toBe('A')
})

it('05 验收 52: an ignored file-tool target remains promised, but a later tree exclusion invalidates it', async () => {
  await writeFile(path('.gitignore'), 'ignored\n')
  await writeFile(path('ignored'), 'A')
  const before = await take('ignored')
  await writeFile(path('ignored'), 'B')
  const after = await take('ignored', 'after-call')
  const q = query([{ callKey: 'file', before, after, path: path('ignored') }])
  expect((await snapshots.preview(q)).restore).toEqual([path('ignored')])
  expect((await restore(q)).done.failed).toEqual([])
  expect(await readFile(path('ignored'), 'utf8')).toBe('A')
  const tree = await take()
  const skipped = await snapshots.preview(
    query([...q.calls, { callKey: 'bash', before: tree, after: tree }]),
  )
  expect(skipped.skipped).toContainEqual({
    path: path('ignored'),
    reason: 'excluded',
    promised: true,
  })
})

it('05 验收 53: shared folder/ancestor work is busy; writes and commands wait for cancel and cleanup', async () => {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const q = query([{ callKey: 'file', before, after, path: path('f') }])
  const preview = await snapshots.preview(q)
  const shared = await workspaceLeases.shared([temp])
  expect(await snapshots.prepare({ ...q, previewKey: preview.previewKey })).toEqual({
    ok: false,
    reason: 'busy',
  })
  shared()
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  if (!prepared.ok) throw new Error(prepared.reason)
  let wrote = false
  const writing = new DesktopFs().writeFile(path('f'), 'late').then(() => {
    wrote = true
  })
  let wrapped = false
  const commandId = randomUUID()
  const command = leaseCommand(
    {
      commandId,
      argv: ['/bin/true'],
      cwd: folder,
      env: {},
      workspace: [folder],
      profile: 'full-access',
    },
    async () => {
      wrapped = true
      return { argv: ['/bin/true'] }
    },
  )
  await new Promise((resolve) => setImmediate(resolve))
  expect(wrote).toBe(false)
  expect(wrapped).toBe(false)
  await snapshots.cancel({ sessionId, undoSnapshotId: prepared.undoSnapshotId })
  await writing
  const result = await command
  const exit = Promise.withResolvers<{ code: number; signal: null }>()
  await leaseSpawn(result.argv, async () => ({
    pid: 1,
    exited: exit.promise,
    kill: async () => {},
    stdin: new WritableStream(),
    stdout: new ReadableStream(),
    stderr: new ReadableStream(),
  }))
  expect(workspaceLeases.exclusive([folder])).toBeNull()
  commandCleaned(commandId)
  expect(workspaceLeases.exclusive([folder])).toBeNull()
  exit.resolve({ code: 0, signal: null })
  await exit.promise
  const exclusive = workspaceLeases.exclusive([folder])
  expect(exclusive).not.toBeNull()
  exclusive?.()
  expect(await readFile(path('f'), 'utf8')).toBe('late')
})

it('05 验收 18、21: stale, missing post-call records and identity changes fail without blocking other paths', async () => {
  await writeFile(path('a'), 'A')
  await writeFile(path('b'), 'A')
  const before = await take()
  await writeFile(path('a'), 'B')
  await writeFile(path('b'), 'B')
  const after = await take(undefined, 'after-call')
  const q = query([{ callKey: 'bash', before, after }])
  const preview = await snapshots.preview(q)
  await writeFile(path('a'), 'C')
  expect(await snapshots.prepare({ ...q, previewKey: preview.previewKey })).toEqual({
    ok: false,
    reason: 'stale',
  })
  expect(
    (await snapshots.preview(query([{ callKey: 'file', before, path: path('b') }]))).conflicts,
  ).toEqual([path('b')])
  await writeFile(path('a'), 'B')
  const fresh = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: fresh.previewKey })
  if (!prepared.ok) throw new Error(prepared.reason)
  await writeFile(path('a'), 'D after prepare')
  const done = await snapshots.apply({
    sessionId,
    undoSnapshotId: prepared.undoSnapshotId,
    overwrite: [],
  })
  expect(done.failed).toEqual([path('a')])
  expect(done.restored).toBe(1)
  expect(await readFile(path('a'), 'utf8')).toBe('D after prepare')
  expect(await readFile(path('b'), 'utf8')).toBe('A')
})

it('05 验收 53: a command stopped after wrap and before spawn releases its shared lease', async () => {
  const commandId = randomUUID()
  const result = await leaseCommand(
    {
      commandId,
      argv: ['/bin/true'],
      cwd: folder,
      env: {},
      workspace: [folder],
      profile: 'full-access',
    },
    async () => ({ argv: ['/bin/true'] }),
  )
  commandCleaned(commandId)
  const exclusive = workspaceLeases.exclusive([folder])
  expect(exclusive).not.toBeNull()
  exclusive?.()
  await expect(
    leaseSpawn(result.argv, async () => {
      throw new Error('must not spawn')
    }),
  ).rejects.toThrow('cleaned')
})

it.each(['tree', 'no-git', 'home', 'windows', 'budget'] as const)(
  '05 验收 52: %s coverage restores every promised file target',
  async (mode) => {
    if (mode !== 'tree') {
      snapshots = new DesktopSnapshots({
        identity: {
          userId: 'test',
          tenantId: 'test',
          profileDir: absolutePath(join(temp, 'profile')),
        },
        process: createHostProcess(),
        sandbox: new PassthroughSandbox(() => {}),
        clock: new SystemClock(),
        home: mode === 'home' ? folder : absolutePath(join(temp, 'home')),
        ...(mode === 'no-git' ? { gitPath: '/missing/tenon-git' } : {}),
        ...(mode === 'windows' ? { platform: 'win32' as const } : {}),
        ...(mode === 'budget' ? { limits: { files: 0 } } : {}),
      })
      if (mode === 'budget') await writeFile(path('warmup'), 'exceed file count')
      await snapshots.setWorkspace(sessionId, [folder])
      await snapshots.settled(sessionId)
      if (snapshots.status(sessionId) !== 'file-only')
        throw new Error('Expected single-file fallback')
    }
    await writeFile(path('f'), 'A', { mode: 0o600 })
    if (mode === 'tree') await take()
    expect(await snapshots.coverage({ sessionId, path: path('f') })).toBe(
      mode === 'tree' ? 'tree' : 'file',
    )
    const before = await take('f')
    await writeFile(path('f'), 'B')
    const after = await take('f', 'after-call')
    const q = query([{ callKey: 'file', before, after, path: path('f') }])
    expect((await snapshots.preview(q)).restore).toEqual([path('f')])
    expect((await restore(q)).done.failed).toEqual([])
    expect(await readFile(path('f'), 'utf8')).toBe('A')
    expect((await lstat(path('f'))).mode & 0o7777).toBe(0o600)
  },
)

it('05 验收 21: inability to publish the undo snapshot rejects without mutation and releases the lease', async () => {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const q = query([{ callKey: 'file', before, after, path: path('f') }])
  const preview = await snapshots.preview(q)
  const manifests = join(temp, 'profile', 'snapshots', sessionId, 'manifests')
  await chmod(manifests, 0o500)
  try {
    expect(await snapshots.prepare({ ...q, previewKey: preview.previewKey })).toEqual({
      ok: false,
      reason: 'undo-unavailable',
    })
  } finally {
    await chmod(manifests, 0o700)
  }
  expect(await readFile(path('f'), 'utf8')).toBe('B')
  const release = workspaceLeases.exclusive([folder])
  expect(release).not.toBeNull()
  release?.()
})

it('05 验收 52: hardlinks and workspaces moved out of scope invalidate a promise with an explicit reason', async () => {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const q = query([{ callKey: 'file', before, after, path: path('f') }])
  const { link } = await import('node:fs/promises')
  await link(path('f'), path('second'))
  expect((await snapshots.preview(q)).skipped).toContainEqual({
    path: path('f'),
    reason: 'hardlink',
    promised: true,
  })
  const outside = absolutePath(join(temp, 'other'))
  await mkdir(outside)
  await snapshots.setWorkspace(sessionId, [outside])
  await snapshots.settled(sessionId)
  expect((await snapshots.preview(q)).skipped).toContainEqual({
    path: path('f'),
    reason: 'outside-folders',
    promised: true,
  })
  expect(await readFile(path('f'), 'utf8')).toBe('B')
})

it('05 验收 17、39: restore a file that the command replaced with a directory without losing outside children', async () => {
  await writeFile(path('f'), 'A')
  const before = await take()
  await rm(path('f'))
  await mkdir(path('f'))
  await writeFile(path('f/child'), 'agent')
  const after = await take(undefined, 'after-call')
  const q = query([{ callKey: 'bash', before, after }])
  expect((await restore(q)).done.failed).toEqual([])
  expect((await lstat(path('f'))).isFile()).toBe(true)
  expect(await readFile(path('f'), 'utf8')).toBe('A')
})

it('05 验收 17、49: directory mode restoration tolerates metadata changes from its own child deletion', async () => {
  await mkdir(path('d'), { mode: 0o755 })
  const before = await take()
  await writeFile(path('d/f'), 'new child')
  await chmod(path('d'), 0o700)
  const after = await take(undefined, 'after-call')
  const { done } = await restore(query([{ callKey: 'bash', before, after }]))
  expect(done.failed).toEqual([])
  expect((await lstat(path('d'))).mode & 0o7777).toBe(0o755)
  await expect(lstat(path('d/f'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['unignore', 'unnest', 'oversize'] as const)(
  '05 验收 41: %s never authorizes an excluded path as an addition or deletion',
  async (kind) => {
    await mkdir(path('sub'))
    await writeFile(path('sub/f'), 'original')
    if (kind === 'unignore') await writeFile(path('.gitignore'), 'sub/f\n')
    if (kind === 'unnest') await writeFile(path('sub/.git'), 'gitdir: elsewhere\n')
    const before = await take()
    if (kind === 'unignore') await writeFile(path('.gitignore'), '')
    if (kind === 'unnest') await rm(path('sub/.git'))
    if (kind === 'oversize') {
      const { truncate } = await import('node:fs/promises')
      await truncate(path('sub/f'), 100_000_001)
    }
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const preview = await snapshots.preview(q)
    expect(preview.skipped).toContainEqual({ path: path('sub/f'), reason: 'excluded' })
    expect(preview.remove).not.toContain(path('sub/f'))
    expect(preview.restore).not.toContain(path('sub/f'))
    expect((await lstat(path('sub/f'))).isFile()).toBe(true)
    expect((await lstat(path('sub/f'))).size).toBe(kind === 'oversize' ? 100_000_001 : 8)
  },
)

it('05 验收 53: commands with an empty writable allowlist still lease their actual workspace', async () => {
  const commandId = randomUUID()
  await leaseCommand(
    { commandId, argv: ['/bin/true'], cwd: folder, env: {}, workspace: [], profile: 'read-only' },
    async () => ({ argv: ['/bin/true'] }),
  )
  const exclusive = workspaceLeases.exclusive([folder])
  try {
    expect(exclusive).toBeNull()
  } finally {
    exclusive?.()
    commandCleaned(commandId)
  }
})

it('05 验收 53: failed spawn retains its lease until sandbox cleanup finishes', async () => {
  const commandId = randomUUID()
  const wrapped = await leaseCommand(
    {
      commandId,
      argv: ['/missing/tenon-command'],
      cwd: folder,
      env: {},
      workspace: [folder],
      profile: 'workspace-write',
    },
    async () => ({ argv: ['/missing/tenon-command'] }),
  )
  await expect(
    leaseSpawn(wrapped.argv, async () => {
      throw new Error('spawn failed')
    }),
  ).rejects.toThrow('spawn failed')
  const exclusive = workspaceLeases.exclusive([folder])
  try {
    expect(exclusive).toBeNull()
  } finally {
    exclusive?.()
    commandCleaned(commandId)
  }
})

it('05 验收 53: desktop spawn failure cleans the sandbox even when its caller has no failure cleanup', async () => {
  const h = wiringFixture()
  h.runtime.start()
  const wrapped = await h.runtime.wrap({
    commandId: randomUUID(),
    argv: ['/missing/tenon-command'],
    cwd: folder,
    env: {},
    workspace: [folder],
    profile: 'full-access',
  })
  await expect(
    createHostProcess().spawn({
      ...wrapped,
      cwd: absolutePath(join(temp, 'missing-cwd')),
      stdio: 'pipe',
    }),
  ).rejects.toMatchObject({ code: 'ENOENT' })
  const release = workspaceLeases.exclusive([folder])
  expect(release).not.toBeNull()
  release?.()
})

it('05 验收 17: restore a binary git blob larger than the normal subprocess output limit', async () => {
  const { open } = await import('node:fs/promises')
  const size = 64_000_001
  const file = await open(path('large'), 'wx', 0o600)
  try {
    await file.truncate(size)
    await file.write(Buffer.from([255]), 0, 1, size - 1)
  } finally {
    await file.close()
  }
  const hash = createHash('sha256')
    .update(await readFile(path('large')))
    .digest('hex')
  const before = await take()
  await writeFile(path('large'), 'B')
  const after = await take(undefined, 'after-call')
  expect((await restore(query([{ callKey: 'bash', before, after }]))).done.failed).toEqual([])
  expect((await lstat(path('large'))).size).toBe(size)
  expect((await lstat(path('large'))).mode & 0o7777).toBe(0o600)
  expect(
    createHash('sha256')
      .update(await readFile(path('large')))
      .digest('hex'),
  ).toBe(hash)
}, 30_000)
