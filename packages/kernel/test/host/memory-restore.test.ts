import { expect, it } from 'vitest'
import { absolutePath, createMemoryHost } from '../../src/index.js'
import type { HostProcess, RestoreQuery, SnapshotRequest } from '../../src/index.js'

const folder = absolutePath('/workspace')
const path = absolutePath('/workspace/f')
async function setup(process?: HostProcess) {
  const host = createMemoryHost(process === undefined ? {} : { process })
  await host.fs.mkdirp(folder)
  host.snapshots.setStatus('s', 'tree')
  const take = async (moment: SnapshotRequest['moment'] = 'before-call') => {
    const result = await host.snapshots.take(
      {
        sessionId: 's',
        call: { sessionId: 's', roundRunId: 'r', runId: 'r', requestSeq: 0, ordinal: 0 },
        folders: [folder],
        path,
        moment,
      },
      new AbortController().signal,
    )
    if (!result.ok) throw new Error(result.reason)
    return result.snapshotId
  }
  await host.fs.writeFile(path, 'A')
  const before = await take()
  await host.fs.writeFile(path, 'B')
  const after = await take('after-call')
  const query: RestoreQuery = {
    sessionId: 's',
    roundRunId: 'r',
    calls: [{ callKey: 'c', before, after, path }],
  }
  const prepare = async (q = query) => {
    const preview = await host.snapshots.preview(q)
    const result = await host.snapshots.prepare({ ...q, previewKey: preview.previewKey })
    if (!result.ok) throw new Error(result.reason)
    return result.undoSnapshotId
  }
  return { host, query, prepare, take, before, after }
}

it('05 验收 16、21、51: memory cancel is inert, undo captures bytes and already-restored paths disappear', async () => {
  const { host, query, prepare, take } = await setup()
  const cancelled = await prepare()
  await host.snapshots.cancel({ sessionId: 's', undoSnapshotId: cancelled })
  expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('B')
  const undo = await prepare()
  expect(
    await host.snapshots.apply({ sessionId: 's', undoSnapshotId: undo, overwrite: [] }),
  ).toMatchObject({ restored: 1, failed: [] })
  expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('A')
  expect((await host.snapshots.preview(query)).restore).toEqual([])
  const after = await take('after-call')
  const redo = await prepare({ ...query, calls: [{ callKey: 'undo', before: undo, after, path }] })
  await host.snapshots.apply({ sessionId: 's', undoSnapshotId: redo, overwrite: [] })
  expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('B')
})

it('05 验收 18、54: memory call gaps conflict and forged overwrite paths are rejected', async () => {
  const { host, query, prepare, take } = await setup()
  await host.fs.writeFile(path, 'C')
  const before = await take()
  await host.fs.writeFile(path, 'D')
  const after = await take('after-call')
  const q = { ...query, calls: [...query.calls, { callKey: '2', before, after, path }] }
  expect((await host.snapshots.preview(q)).conflicts).toEqual([path])
  const id = await prepare(q)
  expect(
    await host.snapshots.apply({ sessionId: 's', undoSnapshotId: id, overwrite: [] }),
  ).toMatchObject({ kept: 1, restored: 0 })
  expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('D')
  const invalid = await prepare(q)
  await expect(
    host.snapshots.apply({
      sessionId: 's',
      undoSnapshotId: invalid,
      overwrite: [absolutePath('/forged')],
    }),
  ).rejects.toThrow('subset')
  const valid = await prepare(q)
  await host.snapshots.apply({ sessionId: 's', undoSnapshotId: valid, overwrite: [path] })
  expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('A')
})

it('05 验收 21、53: memory undo failure releases leases; prepared restore blocks a later write until cancel', async () => {
  const { host, query, prepare } = await setup()
  const preview = await host.snapshots.preview(query)
  host.snapshots.failNextTake('disk')
  expect(await host.snapshots.prepare({ ...query, previewKey: preview.previewKey })).toEqual({
    ok: false,
    reason: 'undo-unavailable',
  })
  host.snapshots.setStatus('s', 'tree')
  const id = await prepare()
  let wrote = false
  const writing = host.fs.writeFile(path, 'late').then(() => {
    wrote = true
  })
  await Promise.resolve()
  expect(wrote).toBe(false)
  expect(await host.snapshots.prepare({ ...query, previewKey: preview.previewKey })).toEqual({
    ok: false,
    reason: 'busy',
  })
  await host.snapshots.cancel({ sessionId: 's', undoSnapshotId: id })
  await writing
  expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('late')
})

it('05 验收 17、52: memory file-only snapshots restore deletion, creation and link type without following targets', async () => {
  const { host, take } = await setup()
  host.snapshots.setStatus('s', 'file-only')
  await host.fs.remove(path)
  host.symlink(path, 'outside')
  const before = await take()
  await host.fs.remove(path)
  await host.fs.writeFile(path, 'file')
  const after = await take('after-call')
  const q = { sessionId: 's', roundRunId: 'r', calls: [{ callKey: 'type', before, after, path }] }
  const preview = await host.snapshots.preview(q)
  expect(preview.restore).toEqual([path])
  const prepared = await host.snapshots.prepare({ ...q, previewKey: preview.previewKey })
  if (!prepared.ok) throw new Error(prepared.reason)
  const done = await host.snapshots.apply({
    sessionId: 's',
    undoSnapshotId: prepared.undoSnapshotId,
    overwrite: [],
  })
  expect(done.failed).toEqual([])
  expect(await host.fs.identity(path)).toMatchObject({ kind: 'link', size: 7, mode: 0o777 })
  await expect(host.fs.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('05 验收 53: queued memory guarded.create rechecks exclusivity after restore', async () => {
  const { host, query, prepare } = await setup()
  await host.fs.remove(path)
  const id = await prepare()
  const creation = host.fs.guarded.create(path, 'late').then(
    () => 'created',
    (error: { code?: string }) => error.code,
  )
  const done = await host.snapshots.apply({ sessionId: 's', undoSnapshotId: id, overwrite: [path] })
  expect(done.failed).toEqual([])
  expect(await creation).toBe('EEXIST')
  expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('A')
  expect((await host.snapshots.preview(query)).restore).toEqual([])
})

it('05 验收 53: memory writes through a parent alias wait for the real workspace lease', async () => {
  const { host, prepare } = await setup()
  host.symlink(absolutePath('/alias'), '/workspace')
  const id = await prepare()
  let wrote = false
  const writing = host.fs.writeFile(absolutePath('/alias/f'), 'alias write').then(() => {
    wrote = true
  })
  await Promise.resolve()
  try {
    expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('B')
    expect(wrote).toBe(false)
  } finally {
    await host.snapshots.cancel({ sessionId: 's', undoSnapshotId: id })
    await writing
  }
  expect(await host.fs.readFile(path, { encoding: 'utf8' })).toBe('alias write')
})

it('05 验收 53: memory commands stay busy through abort until exit and cleanup, even with no writable paths', async () => {
  const exited = Promise.withResolvers<{ code: number; signal: null }>()
  const { host, query, prepare } = await setup({
    spawn: async () => ({
      pid: 1,
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
      exited: exited.promise,
      kill: async () => {},
    }),
  })
  const wrapped = await host.sandbox.wrap({
    commandId: 'cmd',
    argv: ['/bin/true'],
    cwd: folder,
    env: {},
    profile: 'read-only',
    workspace: [],
  })
  const child = await host.process.spawn({ ...wrapped, cwd: folder, stdio: 'pipe' })
  await child.kill()
  const preview = await host.snapshots.preview(query)
  expect(await host.snapshots.prepare({ ...query, previewKey: preview.previewKey })).toEqual({
    ok: false,
    reason: 'busy',
  })
  await host.sandbox.afterExit('cmd')
  expect(await host.snapshots.prepare({ ...query, previewKey: preview.previewKey })).toEqual({
    ok: false,
    reason: 'busy',
  })
  exited.resolve({ code: 0, signal: null })
  await exited.promise
  const id = await prepare()
  await host.snapshots.cancel({ sessionId: 's', undoSnapshotId: id })
})
