import * as nativeFs from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { absolutePath } from '@tenon-app/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopFs } from '../src/main/host/fs.js'
import { unavailableSnapshots } from '../src/main/host/snapshots.js'

// Wrap only open to schedule real disk changes at the async boundary. No file data is faked.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nativeFs>()
  return { ...actual, open: vi.fn<typeof actual.open>(actual.open) }
})
const actualFs = await vi.importActual<typeof nativeFs>('node:fs/promises')

/** Spec 05 §接口, §mtime 守卫 and §Delete 工具: real disk, disposable HOME only. */
describe('05 DesktopFs', () => {
  const fs = new DesktopFs()
  let root: string
  const at = (name: string) => absolutePath(join(root, name))

  beforeEach(async () => {
    root = await nativeFs.mkdtemp(join(tmpdir(), 'tenon-05-fs-'))
    await nativeFs.mkdir(join(root, 'home'))
    vi.stubEnv('HOME', join(root, 'home'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await nativeFs.rm(root, { recursive: true, force: true })
  })

  it('05 验收 32: writeFile refuses a leaf swapped for a link before open', async () => {
    await fs.writeFile(at('target'), 'user content')
    await fs.writeFile(at('victim'), 'agent target')
    const originalOpen = actualFs.open
    vi.mocked(nativeFs.open).mockImplementationOnce(async (...args) => {
      await nativeFs.unlink(at('victim'))
      await nativeFs.symlink(at('target'), at('victim'))
      return originalOpen(...args)
    })
    await expect(fs.writeFile(at('victim'), 'overwrite')).rejects.toMatchObject({ code: 'ELOOP' })
    expect(await nativeFs.readFile(at('target'), 'utf8')).toBe('user content')
  })

  it('05 验收 32: writeFile refuses existing and dangling leaf links', async () => {
    await fs.writeFile(at('target'), 'kept')
    await nativeFs.symlink(at('target'), at('link'))
    await nativeFs.symlink(at('missing'), at('dangling'))
    await expect(fs.writeFile(at('link'), 'bad')).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(fs.writeFile(at('dangling'), 'bad')).rejects.toMatchObject({ code: 'ELOOP' })
    expect(await nativeFs.readFile(at('target'), 'utf8')).toBe('kept')
    expect(await fs.stat(at('missing'))).toBeNull()
  })

  it('05 验收 50: guarded.create is exclusive for files, directories and dangling links', async () => {
    await fs.guarded.create(at('new'), new Uint8Array([0, 255, 1]))
    expect([...(await nativeFs.readFile(at('new')))]).toEqual([0, 255, 1])
    await nativeFs.mkdir(at('dir'))
    await nativeFs.symlink(at('absent'), at('dangling'))
    for (const name of ['new', 'dir', 'dangling']) {
      // oxlint-disable-next-line no-await-in-loop -- each collision must reject without mutation
      await expect(fs.guarded.create(at(name), 'bad')).rejects.toMatchObject({ code: 'EEXIST' })
    }
    expect([...(await nativeFs.readFile(at('new')))]).toEqual([0, 255, 1])
    expect(await fs.identity(at('absent'))).toBeNull()
    await expect(fs.guarded.create(at('missing/child'), 'bad')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('05 验收 23: guarded.read stamps the opened file even when its path is replaced', async () => {
    await fs.writeFile(at('file'), 'opened content')
    await fs.writeFile(at('replacement'), 'different replacement content')
    const stamp = await fs.identity(at('file'))
    const originalOpen = actualFs.open
    vi.mocked(nativeFs.open).mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args)
      await nativeFs.rename(at('file'), at('held'))
      await nativeFs.rename(at('replacement'), at('file'))
      return handle
    })
    expect(await fs.guarded.read(at('file'), { encoding: 'utf8' })).toEqual({
      data: 'opened content',
      stamp,
    })
    expect(await nativeFs.readFile(at('file'), 'utf8')).toBe('different replacement content')
  })

  it('05 验收 23: guarded.read returns no stamp if the open file changes during the read', async () => {
    await fs.writeFile(at('file'), 'old')
    const originalOpen = actualFs.open
    vi.mocked(nativeFs.open).mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args)
      const read = handle.readFile.bind(handle)
      Object.defineProperty(handle, 'readFile', {
        value: async () => {
          const data = await read()
          await nativeFs.writeFile(at('file'), 'changed and longer')
          return data
        },
      })
      return handle
    })
    const result = await fs.guarded.read(at('file'))
    expect([...(result.data as Uint8Array)]).toEqual([...new TextEncoder().encode('old')])
    expect(result.stamp).toBeNull()
  })

  it('05 验收 23: guarded.read follows read links, supports bytes and refuses directories', async () => {
    await fs.writeFile(at('file'), new Uint8Array([0, 255]))
    await nativeFs.symlink(at('file'), at('link'))
    const result = await fs.guarded.read(at('link'))
    expect(result.data).toBeInstanceOf(Uint8Array)
    expect([...(result.data as Uint8Array)]).toEqual([0, 255])
    expect(result.stamp).toEqual(await fs.identity(at('file')))
    await expect(fs.guarded.read(at('home'))).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(fs.guarded.read(at('missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('05 验收 25、32: identity reports bigint lstat fields, device and hardlink count', async () => {
    await fs.writeFile(at('file'), 'é')
    await nativeFs.chmod(at('file'), 0o600)
    await nativeFs.link(at('file'), at('second'))
    await nativeFs.symlink(at('file'), at('link'))
    const stats = await nativeFs.lstat(at('file'), { bigint: true })
    expect(await fs.identity(at('file'))).toEqual({
      kind: 'file',
      size: 2,
      nlink: 2,
      mtimeNs: stats.mtimeNs,
      mode: 0o600,
      dev: stats.dev,
    })
    expect(await fs.identity(at('second'))).toEqual(await fs.identity(at('file')))
    expect(await fs.identity(at('link'))).toMatchObject({ kind: 'link', nlink: 1 })
    expect(await fs.identity(at('home'))).toMatchObject({ kind: 'dir', dev: stats.dev })
    expect(await fs.identity(at('missing'))).toBeNull()
    expect(await fs.identity(at('file/child'))).toBeNull()
    await nativeFs.symlink(at('missing'), at('dangling'))
    expect(await fs.identity(at('dangling'))).toMatchObject({ kind: 'link' })
  })

  it('05 验收 30: remove unlinks only the leaf and refuses directories and missing paths', async () => {
    await fs.writeFile(at('file'), 'kept')
    await nativeFs.symlink(at('file'), at('link'))
    await nativeFs.symlink(at('home'), at('dir-link'))
    await nativeFs.symlink(at('missing'), at('dangling'))
    await fs.remove(at('link'))
    await fs.remove(at('dir-link'))
    await fs.remove(at('dangling'))
    expect(await fs.readFile(at('file'), { encoding: 'utf8' })).toBe('kept')
    await expect(fs.remove(at('home'))).rejects.toMatchObject({
      code: expect.stringMatching(/^(EISDIR|EPERM)$/),
    })
    await expect(fs.remove(at('missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.identity(at('home'))).toMatchObject({ kind: 'dir' })
    await fs.remove(at('file'))
    expect(await fs.identity(at('file'))).toBeNull()
  })

  it('05 验收 30、32: new operations still reject nonabsolute paths', async () => {
    const bad = 'relative' as never
    await expect(fs.identity(bad)).rejects.toThrow(TypeError)
    await expect(fs.remove(bad)).rejects.toThrow(TypeError)
    await expect(fs.guarded.read(bad)).rejects.toThrow(TypeError)
    await expect(fs.guarded.create(bad, 'x')).rejects.toThrow(TypeError)
  })

  it('05 验收 30: identity classifies special files and remove refuses them', async () => {
    const socket = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.listen(at('socket'), resolve)
      })
      expect(await fs.identity(at('socket'))).toMatchObject({ kind: 'other' })
      await expect(fs.remove(at('socket'))).rejects.toThrow(/not a regular file/)
      expect(await fs.identity(at('socket'))).toMatchObject({ kind: 'other' })
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()))
    }
  })

  it('05 验收 31: the desktop placeholder promises no coverage and cannot restore or write', async () => {
    const snapshots = unavailableSnapshots
    const query = { sessionId: 's', roundRunId: 'r', calls: [] }
    expect(snapshots.status('s')).toBe('unavailable')
    expect(await snapshots.coverage({ sessionId: 's', path: at('file') })).toBe('none')
    const q = {
      sessionId: 's',
      call: { sessionId: 's', roundRunId: 'r', runId: 'run', requestSeq: 1, ordinal: 0 },
      folders: [at('home')],
      moment: 'before-call' as const,
    }
    expect(await snapshots.take(q, new AbortController().signal)).toEqual({
      ok: false,
      reason: 'not-covered',
    })
    const stopped = new AbortController()
    stopped.abort()
    expect(await snapshots.take(q, stopped.signal)).toEqual({ ok: false, reason: 'aborted' })
    expect(await snapshots.prepare({ ...query, previewKey: 'key' })).toEqual({
      ok: false,
      reason: 'undo-unavailable',
    })
    expect(await snapshots.preview(query)).toEqual({
      previewKey: '',
      restore: [],
      remove: [],
      conflicts: [],
      skipped: [],
    })
    await expect(
      snapshots.apply({ sessionId: 's', undoSnapshotId: 'id', overwrite: [] }),
    ).rejects.toThrow(/unavailable/)
    await snapshots.cancel({ sessionId: 's', undoSnapshotId: 'id' })
    expect(await snapshots.alive('s', ['id'])).toEqual(new Set())
    expect(await fs.identity(at('file'))).toBeNull()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '05 验收 13、30: identity throws EACCES beneath an unreadable parent (root bypasses POSIX permissions)',
    async () => {
      await nativeFs.mkdir(at('private'))
      await nativeFs.writeFile(at('private/file'), 'fixture')
      await nativeFs.chmod(at('private'), 0o000)
      try {
        await expect(fs.identity(at('private/file'))).rejects.toMatchObject({ code: 'EACCES' })
      } finally {
        await nativeFs.chmod(at('private'), 0o700)
      }
    },
  )

  it.each(['same-size rewrite', 'chmod', 'hardlink'] as const)(
    '05 验收 23: guarded.read discards its stamp after only a %s during the read',
    async (change) => {
      await nativeFs.writeFile(at('file'), 'original', { mode: 0o644 })
      vi.mocked(nativeFs.open).mockImplementationOnce(async (...args) => {
        const handle = await actualFs.open(...args)
        const read = handle.readFile.bind(handle)
        Object.defineProperty(handle, 'readFile', {
          value: async () => {
            const data = await read('utf8')
            if (change === 'same-size rewrite') await nativeFs.writeFile(at('file'), 'modified')
            if (change === 'chmod') await nativeFs.chmod(at('file'), 0o600)
            if (change === 'hardlink') await nativeFs.link(at('file'), at('alias'))
            return data
          },
        })
        return handle
      })
      const read = await fs.guarded.read(at('file'), { encoding: 'utf8' })
      expect(read).toEqual({ data: 'original', stamp: null })
    },
  )

  it.each(['read', 'create'] as const)(
    '05 验收 23、30: guarded.%s closes its opened handle after IO failure',
    async (operation) => {
      if (operation === 'read') await nativeFs.writeFile(at('file'), 'fixture')
      let opened: nativeFs.FileHandle | undefined
      const closed = vi.fn<() => void>()
      vi.mocked(nativeFs.open).mockImplementationOnce(async (...args) => {
        const handle = await actualFs.open(...args)
        opened = handle
        const close = handle.close.bind(handle)
        Object.defineProperty(handle, 'close', {
          value: async () => {
            closed()
            await close()
          },
        })
        Object.defineProperty(handle, operation === 'read' ? 'readFile' : 'writeFile', {
          value: async () => {
            throw new Error('injected IO failure')
          },
        })
        return handle
      })
      const work =
        operation === 'read' ? fs.guarded.read(at('file')) : fs.guarded.create(at('file'), 'bytes')
      await expect(work).rejects.toThrow('injected IO failure')
      expect(closed).toHaveBeenCalledTimes(1)
      await expect(opened!.stat()).rejects.toMatchObject({ code: 'EBADF' })
      await nativeFs.rename(at('file'), at('renamed'))
      await nativeFs.rm(at('renamed'))
    },
  )
})
