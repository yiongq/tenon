/* oxlint-disable no-await-in-loop -- sequential filesystem assertions preserve the operation order under test. */
/**
 * Spec 05: durable restore safety regressions from the segment-three security review. Real git, disposable HOME/profile/workspace under tmpdir; no user
 * files, models or credentials. Same harness as snapshot-restore.test.ts.
 */
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fsPromises>()),
}))
import * as fsPromises from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
import type { AbsolutePath, ChildHandle, RestoreQuery, SnapshotRequest } from '@tenon-app/kernel'
import { DesktopSnapshots } from '../src/main/host/snapshots.js'
import { SystemClock } from '../src/main/host/clock.js'
import { createHostProcess } from '../src/main/host/process.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'
import { wiringFixture } from './sandbox/wiring-support.js'
import {
  markConnectorCommand,
  commandCleaned,
  leaseCommand,
  leaseSpawn,
  workspaceLeases,
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
async function prepare(q: RestoreQuery): Promise<string> {
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.reason}`)
  return prepared.undoSnapshotId
}
const apply = (undoSnapshotId: string, overwrite: AbsolutePath[] = []) =>
  snapshots.apply({ sessionId, undoSnapshotId, overwrite })
function fakeChild(exited: Promise<{ code: number; signal: null }>): ChildHandle {
  return {
    pid: 1,
    exited,
    kill: async () => {},
    stdin: new WritableStream(),
    stdout: new ReadableStream(),
    stderr: new ReadableStream(),
  }
}

beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'tenon-sec3-')))
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
  vi.restoreAllMocks()
  await snapshots.settled(sessionId)
  await rm(temp, { recursive: true, force: true })
})

it.skipIf(process.platform === 'win32')(
  '05 验收 19、21: SEC-1 规矩 8 / 叶子不跟随: a leaf swapped to an outside link after prepare fails for replace, mode-only and removal; the link and its target survive',
  async () => {
    const outside = join(temp, 'outside')
    await mkdir(outside)
    const secret = join(outside, 'secret')
    await writeFile(secret, 'outside', { mode: 0o600 })
    await writeFile(path('content'), 'A')
    await writeFile(path('mode'), 'M', { mode: 0o600 })
    const before = await take()
    await writeFile(path('content'), 'B')
    await chmod(path('mode'), 0o644)
    await writeFile(path('created'), 'agent new file')
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const preview = await snapshots.preview(q)
    expect(preview.restore.toSorted()).toEqual([path('content'), path('mode')])
    expect(preview.remove).toEqual([path('created')])
    const undo = await prepare(q)
    for (const name of ['content', 'mode', 'created']) {
      await rm(path(name))
      await symlink(secret, path(name))
    }
    const stamp = await lstat(secret, { bigint: true })
    const done = await apply(undo)
    expect(done.failed).toEqual([path('content'), path('created'), path('mode')].toSorted())
    for (const name of ['content', 'mode', 'created']) {
      expect((await lstat(path(name))).isSymbolicLink()).toBe(true)
      expect(await readlink(path(name))).toBe(secret)
    }
    const now = await lstat(secret, { bigint: true })
    expect(await readFile(secret, 'utf8')).toBe('outside')
    expect(Number(now.mode & 0o7777n)).toBe(0o600)
    expect(now.mtimeNs).toBe(stamp.mtimeNs)
    expect(await readdir(outside)).toEqual(['secret'])
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 39: SEC-2 规矩 8 / 真实根: the workspace root replaced by a link after prepare gets no write, create or temp file in the link target',
  async () => {
    await writeFile(path('kept'), 'A')
    await writeFile(path('deleted'), 'D')
    const before = await take()
    await writeFile(path('kept'), 'B')
    await rm(path('deleted'))
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    const undo = await prepare(q)
    const outside = join(temp, 'outside')
    const moved = join(temp, 'moved')
    await mkdir(outside)
    await writeFile(join(outside, 'kept'), 'outside kept')
    await rename(folder, moved)
    await symlink(outside, folder)
    try {
      const done = await apply(undo)
      expect(done.failed).toEqual([path('deleted'), path('kept')])
      expect(await readdir(outside)).toEqual(['kept'])
      expect(await readFile(join(outside, 'kept'), 'utf8')).toBe('outside kept')
      // A fresh preview through the substituted root offers nothing to write.
      const again = await snapshots.preview(q)
      expect(again.restore).toEqual([])
      expect(again.remove).toEqual([])
    } finally {
      await rm(folder)
      await rename(moved, folder)
    }
  },
)

it('05 验收 19、21: SEC-3 identity 比对 / 删除一侧: a file the round created and the user edited after prepare is not deleted', async () => {
  const before = await take()
  await writeFile(path('new'), 'agent')
  const after = await take(undefined, 'after-call')
  const q = query([{ callKey: 'bash', before, after }])
  expect((await snapshots.preview(q)).remove).toEqual([path('new')])
  const undo = await prepare(q)
  await writeFile(path('new'), 'user edit after confirming')
  const done = await apply(undo)
  expect(done.failed).toEqual([path('new')])
  expect(done.removed).toBe(0)
  expect(await readFile(path('new'), 'utf8')).toBe('user edit after confirming')
})

it('05 验收 21: SEC-4 删除不递归: a created directory that also holds an ignored, never-listed file keeps that file', async () => {
  await writeFile(path('.gitignore'), '*.log\n')
  const before = await take()
  await mkdir(path('newdir'))
  await writeFile(path('newdir/a.txt'), 'agent')
  await writeFile(path('newdir/keep.log'), 'user log that no snapshot listed')
  const after = await take(undefined, 'after-call')
  const q = query([{ callKey: 'bash', before, after }])
  const preview = await snapshots.preview(q)
  expect(preview.remove.toSorted()).toEqual([path('newdir'), path('newdir/a.txt')])
  const done = await apply(await prepare(q))
  expect(done.failed).toEqual([path('newdir')])
  expect(await readFile(path('newdir/keep.log'), 'utf8')).toBe('user log that no snapshot listed')
  await expect(lstat(path('newdir/a.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform === 'win32')(
  '05 验收 49: SEC-5 目录权限位只设回重建或放回的目录: an existing parent the user chmod-ed later keeps its mode',
  async () => {
    await mkdir(path('d'), { mode: 0o755 })
    await chmod(path('d'), 0o755)
    await writeFile(path('d/f'), 'A')
    const before = await take('d/f')
    await writeFile(path('d/f'), 'B')
    const after = await take('d/f', 'after-call')
    await chmod(path('d'), 0o700)
    const q = query([{ callKey: 'write', before, after, path: path('d/f') }])
    const done = await apply(await prepare(q))
    expect(done).toMatchObject({ restored: 1, failed: [] })
    expect(await readFile(path('d/f'), 'utf8')).toBe('A')
    expect((await lstat(path('d'))).mode & 0o7777).toBe(0o700)
  },
)

it('05 验收 19、21: SEC-6 新建排他: a deleted file that reappears between prepare and apply is not overwritten', async () => {
  await writeFile(path('g'), 'origin')
  const before = await take()
  await rm(path('g'))
  const after = await take(undefined, 'after-call')
  const q = query([{ callKey: 'bash', before, after }])
  expect((await snapshots.preview(q)).restore).toEqual([path('g')])
  const undo = await prepare(q)
  await writeFile(path('g'), 'user recreated it')
  const done = await apply(undo)
  expect(done.failed).toEqual([path('g')])
  expect(await readFile(path('g'), 'utf8')).toBe('user recreated it')
})

it('05 验收 21、53: SEC-7 同一 undoSnapshotId 只 apply 一次; an overlapping exclusive lease is busy while prepared', async () => {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const q = query([{ callKey: 'write', before, after, path: path('f') }])
  const undo = await prepare(q)
  expect(workspaceLeases.exclusive([absolutePath(temp)])).toBeNull()
  expect(await apply(undo)).toMatchObject({ restored: 1, failed: [] })
  await writeFile(path('f'), 'user after restore')
  await expect(apply(undo)).rejects.toThrow('not prepared')
  expect(await readFile(path('f'), 'utf8')).toBe('user after restore')
  const release = workspaceLeases.exclusive([folder])
  expect(release).not.toBeNull()
  release?.()
})

it('05 验收 53: SEC-8 租约 / 经别名写: a host write through a parent alias waits for the prepared restore, and setWorkspace drops it', async () => {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const q = query([{ callKey: 'write', before, after, path: path('f') }])
  const alias = join(temp, 'alias')
  await symlink(folder, alias)
  const undo = await prepare(q)
  let entered = false
  const writing = workspaceLeases.write(absolutePath(join(alias, 'f')), async () => {
    entered = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(entered).toBe(false)
  const other = absolutePath(join(temp, 'other'))
  await mkdir(other)
  await snapshots.setWorkspace(sessionId, [other])
  await writing
  expect(entered).toBe(true)
  await expect(apply(undo)).rejects.toThrow('not prepared')
  expect(await readFile(path('f'), 'utf8')).toBe('B')
})

// macOS volumes are case-insensitive by default; P12/验收 40 generalised from a file to a directory.
it.skipIf(process.platform !== 'darwin')(
  '05 验收 40: SEC-9 大小写改名 (目录): a case-only directory rename skips both spellings without deleting its only child',
  async () => {
    await mkdir(path('Dir'))
    await writeFile(path('Dir/f'), 'origin')
    const before = await take()
    await rename(path('Dir'), path('dir'))
    await writeFile(path('dir/f'), 'agent edit')
    const after = await take(undefined, 'after-call')
    const q = query([{ callKey: 'bash', before, after }])
    // Conservative policy: both spellings and their ancestor rename stay skipped together.
    const preview = await snapshots.preview(q)
    expect(preview.remove).toEqual([])
    expect(preview.restore).toEqual([])
    expect(preview.skipped).toContainEqual({ path: path('dir/f'), reason: 'not-covered' })
    expect(preview.skipped).toContainEqual({ path: path('Dir/f'), reason: 'not-covered' })
    const done = await apply(await prepare(q))
    expect(done).toMatchObject({ restored: 0, removed: 0, failed: [] })
    expect(await readdir(folder)).toEqual(['dir'])
    expect(await readFile(path('dir/f'), 'utf8')).toBe('agent edit')
  },
)

it('05 验收 53: CHAR-1 a connected MCP stdio server does not hold a workspace lease', async () => {
  // pool.ts connectStdioServer: cwd options.homeDir, sandbox { profile: 'full-access', workspace: [] };
  // here `temp` stands in for HOME because the workspace lives under it.
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const q = query([{ callKey: 'write', before, after, path: path('f') }])
  const h = wiringFixture()
  h.runtime.start()
  const commandId = `mcp:${randomUUID()}`
  const connectorArgv = ['/bin/cat']
  // The desktop pool supplies markConnectorCommand as beforeStdioWrap (D64).
  markConnectorCommand(connectorArgv)
  const wrapped = await h.runtime.wrap({
    commandId,
    argv: connectorArgv,
    cwd: absolutePath(temp),
    env: {},
    profile: 'full-access',
    workspace: [],
  })
  const exit = Promise.withResolvers<{ code: number; signal: null }>()
  await leaseSpawn(wrapped.argv, async () => fakeChild(exit.promise))
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  expect(prepared.ok).toBe(true)
  if (prepared.ok) await snapshots.cancel({ sessionId, undoSnapshotId: prepared.undoSnapshotId })
  exit.resolve({ code: 0, signal: null })
  await exit.promise
  await h.runtime.afterExit(commandId)
  const undo = await prepare(q)
  expect((await apply(undo)).failed).toEqual([])
})

// Keep last: on failure the leaked lease stays in the process-wide registry (on this test's own temp).
it('05 验收 53: SEC-10 异常路径不泄漏租约: reusing a commandId (MCP uses mcp:<serverId>) releases both leases once both commands are cleaned', async () => {
  const cwd = absolutePath(join(temp, 'mcp-cwd'))
  await mkdir(cwd)
  const commandId = 'mcp:same-server'
  const request = {
    commandId,
    argv: ['/bin/cat'],
    cwd,
    env: {},
    profile: 'full-access' as const,
    workspace: [],
  }
  const first = await leaseCommand(request, async () => ({ argv: ['/bin/cat'] }))
  const exit1 = Promise.withResolvers<{ code: number; signal: null }>()
  await leaseSpawn(first.argv, async () => fakeChild(exit1.promise))
  // Reconnect wraps again before the first child's afterExit finished (pool.ts launch → start).
  const second = await leaseCommand({ ...request, argv: ['/bin/cat'] }, async () => ({
    argv: ['/bin/cat'],
  }))
  const exit2 = Promise.withResolvers<{ code: number; signal: null }>()
  await leaseSpawn(second.argv, async () => fakeChild(exit2.promise))
  exit1.resolve({ code: 0, signal: null })
  await exit1.promise
  commandCleaned(commandId)
  exit2.resolve({ code: 0, signal: null })
  await exit2.promise
  await new Promise((resolve) => setImmediate(resolve))
  commandCleaned(commandId)
  const release = workspaceLeases.exclusive([cwd])
  // Both commands exited and were cleaned, so no shared lease may remain on their folder.
  expect(release === null ? 'shared lease still held' : 'released').toBe('released')
  release?.()
})

it('05 验收 49: a directory replaced after open is not chmodded through the old handle', async () => {
  await mkdir(path('d'), { mode: 0o555 })
  const before = await take()
  await chmod(path('d'), 0o755)
  const after = await take(undefined, 'after-call')
  const undo = await prepare(query([{ callKey: 'bash', before, after }]))
  const original = fsPromises.open
  vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (args[0] === path('d') && (Number(args[1]) & constants.O_DIRECTORY) !== 0) {
      await rename(path('d'), path('old'))
      await mkdir(path('d'), { mode: 0o700 })
    }
    return handle
  })
  expect((await apply(undo)).failed).toContain(path('d'))
  expect((await lstat(path('old'))).mode & 0o777).toBe(0o755)
  expect((await lstat(path('d'))).mode & 0o777).toBe(0o700)
})

it('05 验收 39、49: a substituted parent is rejected before opening a directory for chmod', async () => {
  await mkdir(path('d/sub'), { recursive: true })
  await writeFile(path('d/sub/f'), 'origin')
  const before = await take()
  await rm(path('d'), { recursive: true })
  const after = await take(undefined, 'after-call')
  const undo = await prepare(query([{ callKey: 'bash', before, after }]))
  const outside = join(temp, 'outside')
  await mkdir(join(outside, 'sub'), { recursive: true, mode: 0o700 })
  const original = fsPromises.open
  const opens = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (args[0] === path('d/sub/f') && (Number(args[1]) & constants.O_CREAT) !== 0) {
      const write = handle.writeFile.bind(handle)
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => {
        await write(...writeArgs)
        await rename(path('d'), join(temp, 'moved'))
        await symlink(outside, path('d'))
      })
    }
    return handle
  })
  const done = await apply(undo)
  expect(done.failed).toContain(path('d/sub'))
  expect(
    opens.mock.calls.some(
      ([name, flags]) => name === path('d/sub') && (Number(flags) & constants.O_DIRECTORY) !== 0,
    ),
  ).toBe(false)
  expect((await lstat(join(outside, 'sub'))).mode & 0o777).toBe(0o700)
})

it.each([false, true])(
  '05 验收 21: failed creation cleans only its own inode (replaced=%s)',
  async (replaced) => {
    await writeFile(path('f'), 'origin')
    const before = await take('f')
    await rm(path('f'))
    const after = await take('f', 'after-call')
    const undo = await prepare(query([{ callKey: 'delete', before, after, path: path('f') }]))
    const original = fsPromises.open
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args)
      if (args[0] === path('f') && (Number(args[1]) & constants.O_CREAT) !== 0) {
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
          await write('partial')
          if (replaced) {
            await rename(path('f'), path('partial'))
            await writeFile(path('f'), 'user replacement')
          }
          throw new Error('disk full')
        })
      }
      return handle
    })
    expect((await apply(undo)).failed).toEqual([path('f')])
    const result = await readFile(path('f'), 'utf8').catch(
      (error: NodeJS.ErrnoException) => error.code,
    )
    expect(result).toBe(replaced ? 'user replacement' : 'ENOENT')
  },
)

it('05 验收 18: preview reads at most the observed size plus one byte if a file grows', async () => {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const original = fsPromises.open
  let bytesRead = 0
  vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (args[0] === path('f')) {
      const stat = handle.stat.bind(handle)
      let first = true
      vi.spyOn(handle, 'stat').mockImplementation(async (...statArgs) => {
        const result = await stat(...statArgs)
        if (first) {
          first = false
          await fsPromises.appendFile(path('f'), 'X'.repeat(100_000))
        }
        return result
      })
      const readWhole = handle.readFile.bind(handle)
      vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs) => {
        const result = await readWhole(...readArgs)
        bytesRead += result.length
        return result
      })
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
        const result = await read(...readArgs)
        bytesRead += result.bytesRead
        return result
      })
    }
    return handle
  })
  const preview = await snapshots.preview(
    query([{ callKey: 'write', before, after, path: path('f') }]),
  )
  expect(preview.skipped).toContainEqual({ path: path('f'), reason: 'not-covered', promised: true })
  expect(bytesRead).toBeLessThanOrEqual(2)
  expect(bytesRead).toBeGreaterThan(0)
})

it.each(['read-only', 'workspace-write', 'full-access'] as const)(
  '05 验收 53: an unmarked Bash command retains its lease through exit and cleanup (%s)',
  async (profile) => {
    const commandId = randomUUID()
    const wrapped = await leaseCommand(
      {
        commandId,
        argv: ['/bin/cat'],
        cwd: absolutePath(temp),
        env: {},
        profile,
        workspace: [folder],
      },
      async () => ({ argv: ['/bin/cat'] }),
    )
    const exit = Promise.withResolvers<{ code: number; signal: null }>()
    await leaseSpawn(wrapped.argv, async () => fakeChild(exit.promise))
    expect(workspaceLeases.exclusive([folder])).toBeNull()
    exit.resolve({ code: 0, signal: null })
    await exit.promise
    expect(workspaceLeases.exclusive([folder])).toBeNull()
    commandCleaned(commandId)
    const release = workspaceLeases.exclusive([folder])
    expect(release).not.toBeNull()
    release?.()
  },
)

it('05 验收 19、40: apply indexes retained identities once instead of rescanning them for every deletion', async () => {
  const count = 40
  await Promise.all(Array.from({ length: count }, (_, i) => writeFile(path(`old-${i}`), 'A')))
  const before = await take()
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      Promise.all([writeFile(path(`old-${i}`), 'B'), writeFile(path(`new-${i}`), 'C')]),
    ),
  )
  const after = await take(undefined, 'after-call')
  const undo = await prepare(query([{ callKey: 'bash', before, after }]))
  const stats = vi.spyOn(fsPromises, 'lstat')
  const done = await apply(undo)
  expect(done).toMatchObject({ restored: count, removed: count, failed: [] })
  expect(stats.mock.calls.length).toBeLessThan(count * 30)
  expect(await readFile(path('old-0'), 'utf8')).toBe('A')
})
