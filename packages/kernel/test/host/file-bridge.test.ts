import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AbsolutePath,
  FileIdentity,
  HostAdapter,
  HostFs,
  HostSnapshots,
  SnapshotRequest,
} from '../../src/index.js'
import { absolutePath, createMemoryHost } from '../../src/index.js'

const path = absolutePath('/file')
const request: SnapshotRequest = {
  sessionId: 's',
  call: { sessionId: 's', roundRunId: 'round', runId: 'run', requestSeq: 1, ordinal: 0 },
  folders: [absolutePath('/')],
  moment: 'before-call',
  path,
}

describe('05 memory file bridge', () => {
  it('05 验收 23、25、30、32: only the specified HostFs members are added and old signatures stay fixed', () => {
    expectTypeOf<keyof HostFs>().toEqualTypeOf<
      | 'readFile'
      | 'writeFile'
      | 'stat'
      | 'readdir'
      | 'mkdirp'
      | 'realpath'
      | 'remove'
      | 'identity'
      | 'guarded'
    >()
    expectTypeOf<HostFs['readFile']>().toEqualTypeOf<
      (path: AbsolutePath, opts?: { encoding?: 'utf8' }) => Promise<Uint8Array | string>
    >()
    expectTypeOf<HostFs['writeFile']>().toEqualTypeOf<
      (path: AbsolutePath, data: Uint8Array | string) => Promise<void>
    >()
    expectTypeOf<HostFs['stat']>().toEqualTypeOf<
      (path: AbsolutePath) => Promise<{ size: number; mtimeMs: number; isDir: boolean } | null>
    >()
    expectTypeOf<HostFs['guarded']>().toEqualTypeOf<{
      read(
        path: AbsolutePath,
        opts?: { encoding?: 'utf8' },
      ): Promise<{ data: Uint8Array | string; stamp: FileIdentity | null }>
      create(path: AbsolutePath, data: Uint8Array | string): Promise<void>
    }>()
    expectTypeOf<keyof HostAdapter>().toEqualTypeOf<
      | 'identity'
      | 'fs'
      | 'secrets'
      | 'process'
      | 'sandbox'
      | 'confirm'
      | 'clock'
      | 'network'
      | 'policy'
      | 'snapshots'
    >()
    expectTypeOf<keyof HostSnapshots>().toEqualTypeOf<
      'coverage' | 'status' | 'take' | 'preview' | 'prepare' | 'apply' | 'cancel' | 'alive'
    >()
    expectTypeOf<HostAdapter['snapshots']>().toEqualTypeOf<HostSnapshots>()
    expectTypeOf<FileIdentity>().toEqualTypeOf<{
      readonly kind: 'file' | 'dir' | 'link' | 'other'
      readonly size: number
      readonly nlink: number
      readonly mtimeNs: bigint
      readonly mode: number
      readonly dev: bigint
    }>()
  })

  it('05 验收 23、50: guarded read copies bytes and stamps the content; create never replaces', async () => {
    const host = createMemoryHost({ now: 12 })
    await host.fs.guarded.create(path, 'é')
    const result = await host.fs.guarded.read(path)
    expect(result.data).toEqual(new TextEncoder().encode('é'))
    expect(result.stamp).toEqual(await host.fs.identity(path))
    expect(result.stamp).toMatchObject({
      kind: 'file',
      size: 2,
      mtimeNs: 12_000_000n,
      nlink: 1,
      dev: 1n,
    })
    const bytes = result.data as Uint8Array
    bytes[0] = 0
    expect((await host.fs.guarded.read(path, { encoding: 'utf8' })).data).toBe('é')
    await expect(host.fs.guarded.create(path, 'bad')).rejects.toMatchObject({ code: 'EEXIST' })
    await host.fs.remove(path)
    await host.fs.guarded.create(path, 'new')
    expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('new')
  })

  it('05 验收 30、32、50: link identities do not follow leaves, removal leaves the target and writes refuse links', async () => {
    const host = createMemoryHost()
    await host.fs.writeFile(path, 'kept')
    host.symlink(absolutePath('/link'), '/file')
    host.symlink(absolutePath('/dangling'), '/absent')
    expect(await host.fs.identity(absolutePath('/link'))).toMatchObject({ kind: 'link', size: 5 })
    expect(await host.fs.identity(absolutePath('/dangling'))).toMatchObject({ kind: 'link' })
    expect((await host.fs.guarded.read(absolutePath('/link'), { encoding: 'utf8' })).data).toBe(
      'kept',
    )
    await expect(host.fs.writeFile(absolutePath('/link'), 'bad')).rejects.toMatchObject({
      code: 'ELOOP',
    })
    await expect(host.fs.guarded.create(absolutePath('/dangling'), 'bad')).rejects.toMatchObject({
      code: 'EEXIST',
    })
    await host.fs.remove(absolutePath('/link'))
    await host.fs.remove(absolutePath('/dangling'))
    expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('kept')
    expect(await host.fs.identity(absolutePath('/absent'))).toBeNull()
    await expect(host.fs.remove(absolutePath('/'))).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(host.fs.remove(absolutePath('/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('05 验收 25: hardlinks share writes, stamps and their remaining link count', async () => {
    const host = createMemoryHost()
    await host.fs.writeFile(path, 'original')
    host.hardlink(path, absolutePath('/second'))
    expect(await host.fs.identity(path)).toMatchObject({ nlink: 2 })
    host.advance(1)
    await host.fs.writeFile(absolutePath('/second'), 'shared')
    expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('shared')
    expect(await host.fs.identity(path)).toEqual(await host.fs.identity(absolutePath('/second')))
    await host.fs.remove(path)
    expect(await host.fs.identity(absolutePath('/second'))).toMatchObject({ nlink: 1 })
  })

  it('05 验收 31: snapshots simulate all four session states and conservative coverage', async () => {
    const host = createMemoryHost()
    for (const [state, coverage] of [
      ['tree', 'tree'],
      ['warming', 'file'],
      ['file-only', 'file'],
      ['unavailable', 'none'],
    ] as const) {
      host.snapshots.setStatus('s', state)
      expect(host.snapshots.status('s')).toBe(state)
      // oxlint-disable-next-line no-await-in-loop -- all states of the same session
      expect(await host.snapshots.coverage({ sessionId: 's', path })).toBe(coverage)
    }
    expect(host.snapshots.status('other')).toBe('unavailable')
  })

  it('05 验收 2、43: snapshot failure, timeout and abort resolve without creating a snapshot', async () => {
    const host = createMemoryHost()
    host.snapshots.setStatus('s', 'tree')
    host.snapshots.failNextTake('disk')
    expect(await host.snapshots.take(request, new AbortController().signal)).toEqual({
      ok: false,
      reason: 'disk',
    })
    expect(host.snapshots.status('s')).toBe('unavailable')
    host.snapshots.setStatus('s', 'tree')
    host.snapshots.takeDelayMs = 5_001
    const timeout = host.snapshots.take(request, new AbortController().signal)
    host.advance(5_000)
    expect(await timeout).toEqual({ ok: false, reason: 'error' })
    host.snapshots.setStatus('s', 'tree')
    host.snapshots.takeDelayMs = 10
    const controller = new AbortController()
    const aborted = host.snapshots.take(request, controller.signal)
    controller.abort()
    expect(await aborted).toEqual({ ok: false, reason: 'aborted' })
    const stopped = new AbortController()
    stopped.abort()
    expect(await host.snapshots.take(request, stopped.signal)).toEqual({
      ok: false,
      reason: 'aborted',
    })
    expect(await host.snapshots.alive('s', ['memory-snapshot-1'])).toEqual(new Set())
    expect(await host.fs.identity(path)).toBeNull()
  })

  it('05 验收 1、42: a successful memory snapshot returns the target identity and session-scoped liveness', async () => {
    const host = createMemoryHost()
    host.snapshots.setStatus('s', 'file-only')
    await host.fs.writeFile(path, 'before')
    const taken = await host.snapshots.take(request, new AbortController().signal)
    expect(taken).toMatchObject({
      ok: true,
      scope: 'file',
      target: await host.fs.identity(path),
      skipped: 0,
    })
    if (!taken.ok) throw new Error('expected success')
    expect(await host.snapshots.alive('s', [taken.snapshotId, 'missing'])).toEqual(
      new Set([taken.snapshotId]),
    )
    expect(await host.snapshots.alive('other', [taken.snapshotId])).toEqual(new Set())
  })
})

describe('05 memory host boundary cases', () => {
  it('05 验收 23: a concurrent write cannot change the stamp attached to a completed memory read', async () => {
    const host = createMemoryHost({ now: 10 })
    await host.fs.writeFile(path, 'first')
    const stamp = await host.fs.identity(path)
    const read = host.fs.guarded.read(path, { encoding: 'utf8' })
    host.advance(1)
    await host.fs.writeFile(path, 'second version')
    expect(await read).toEqual({ data: 'first', stamp })
    expect(await host.fs.identity(path)).not.toEqual(stamp)
  })

  it('05 验收 30、50: missing parents, directories, link loops and invalid paths keep their errors', async () => {
    const host = createMemoryHost()
    await host.fs.mkdirp(absolutePath('/dir'))
    await expect(host.fs.guarded.create(absolutePath('/dir'), 'x')).rejects.toMatchObject({
      code: 'EEXIST',
    })
    await expect(host.fs.guarded.create(absolutePath('/missing/f'), 'x')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(host.fs.guarded.read(absolutePath('/dir'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    await expect(host.fs.guarded.read(path)).rejects.toMatchObject({ code: 'ENOENT' })
    host.symlink(absolutePath('/loop'), '/loop')
    await expect(host.fs.identity(absolutePath('/loop/f'))).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(host.fs.identity('relative' as never)).rejects.toThrow(TypeError)
    await expect(host.fs.remove('relative' as never)).rejects.toThrow(TypeError)
    await expect(host.fs.guarded.read('relative' as never)).rejects.toThrow(TypeError)
    await expect(host.fs.guarded.create('relative' as never, 'x')).rejects.toThrow(TypeError)
  })

  it('05 验收 2、43: delayed take resolves successfully, and every injected failure stays a resolved result', async () => {
    const host = createMemoryHost()
    host.snapshots.setStatus('s', 'tree')
    host.snapshots.takeDelayMs = 10
    const pending = host.snapshots.take(request, new AbortController().signal)
    host.advance(10)
    expect(await pending).toMatchObject({ ok: true, scope: 'tree', target: null })
    host.snapshots.takeDelayMs = 0
    for (const reason of [
      'over-budget',
      'not-covered',
      'no-git',
      'disk',
      'aborted',
      'error',
    ] as const) {
      host.snapshots.setStatus('s', 'tree')
      host.snapshots.failNextTake(reason)
      // oxlint-disable-next-line no-await-in-loop -- consume each injected failure separately
      expect(await host.snapshots.take(request, new AbortController().signal)).toEqual({
        ok: false,
        reason,
      })
    }
    host.snapshots.setStatus('s', 'warming')
    const { path: _path, ...command } = request
    expect(await host.snapshots.take(command, new AbortController().signal)).toEqual({
      ok: false,
      reason: 'not-covered',
    })
    expect(await host.fs.identity(path)).toBeNull()
  })
})
