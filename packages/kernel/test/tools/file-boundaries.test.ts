/** Spec 05: failure and race contracts at the file executors' mutation boundary. */
import { describe, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost } from '../../src/index.js'
import type { FileIdentity, MemoryHost } from '../../src/index.js'
import { fill } from '../../src/prompts/index.js'
import { locatePath } from '../../src/permission/workspace.js'
import { DELETE_TEXTS, DELETE_TOOL, deleteExecutor } from '../../src/tools/builtin/delete.js'
import { EDIT_TEXTS, editExecutor } from '../../src/tools/builtin/edit.js'
import { ABORTED, failed } from '../../src/tools/builtin/files.js'
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js'
import { NOT_ABSOLUTE } from '../../src/tools/builtin/tool.js'
import { WRITE_TEXTS, writeExecutor } from '../../src/tools/builtin/write.js'
import type { ExecuteQuery, ToolExecutor } from '../../src/tools/executor.js'
import { BUILTIN_SERVER_ID } from '../../src/tools/registry.js'
import {
  FILE_CHANGED,
  HARDLINK_CHANGED,
  SNAPSHOT_CHANGED,
  snapshotGuard,
} from '../../src/tools/snapshot-guard.js'

const FILE = absolutePath('/ws/a.txt')
const ID: FileIdentity = { kind: 'file', size: 6, nlink: 1, mtimeNs: 5n, mode: 0o644, dev: 1n }
const EXECUTORS = {
  Write: writeExecutor,
  Edit: editExecutor,
  Delete: deleteExecutor,
} satisfies Record<string, ToolExecutor>
type Name = keyof typeof EXECUTORS
async function host() {
  const h = createMemoryHost()
  await h.fs.mkdirp(absolutePath('/ws'))
  await h.fs.writeFile(FILE, 'before')
  return h
}
function query(
  h: MemoryHost,
  name: Name = 'Write',
  over: Partial<ExecuteQuery> = {},
): ExecuteQuery {
  return {
    item: {
      source: 'builtin',
      serverId: BUILTIN_SERVER_ID,
      originalName: name,
      name,
      spec: BUILTIN_TOOLS[name].spec({ domainFilter: false }),
      requiresUserInteraction: false,
    },
    input: { file_path: FILE, content: 'after', old_string: 'before', new_string: 'after' },
    target: FILE,
    fs: h.fs,
    clock: h.clock,
    signal: new AbortController().signal,
    scope: {
      roots: [absolutePath('/ws')],
      profileDir: absolutePath('/profiles'),
      ownSpillDir: absolutePath('/profiles/spill'),
      protectedFiles: [],
    },
    ...over,
  }
}

describe('05 file boundary failures', () => {
  it.each(['parent', 'leaf'] as const)(
    '05 验收 30: Delete reports an execution-time %s lstat error as hostError without removing anything',
    async (where) => {
      const h = await host()
      const identity = h.fs.identity.bind(h.fs)
      const error = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
      vi.spyOn(h.fs, 'identity').mockImplementation((path) =>
        path === (where === 'parent' ? absolutePath('/ws') : FILE)
          ? Promise.reject(error)
          : identity(path),
      )
      if (where === 'leaf') vi.spyOn(h.fs, 'readdir').mockRejectedValue(new Error('cannot list'))
      const remove = vi.spyOn(h.fs, 'remove')
      expect(await deleteExecutor(query(h, 'Delete'))).toEqual(
        failed('Deleting /ws/a.txt failed: EIO: i/o error'),
      )
      expect(remove).not.toHaveBeenCalled()
      expect(await identity(FILE)).not.toBeNull()
    },
  )

  it('05 验收 30: Delete judgment fails closed if parent metadata cannot be read', async () => {
    const h = await host()
    const identity = h.fs.identity.bind(h.fs)
    vi.spyOn(h.fs, 'identity').mockImplementation((path) =>
      path === absolutePath('/ws') ? Promise.reject(new Error('EIO')) : identity(path),
    )
    expect(await locatePath(h.fs, FILE, query(h).scope, 'Delete')).toEqual({
      real: FILE,
      place: 'protected',
    })
  })
  it.each(['Write', 'Edit', 'Delete'] as const)(
    '05 验收 1: %s failing before mutation never claims fileMutationAttempted',
    async (name) => {
      const h = await host()
      vi.spyOn(h.fs, 'identity').mockRejectedValue(new Error('identity failed'))
      const write = vi.spyOn(h.fs, 'writeFile')
      const remove = vi.spyOn(h.fs, 'remove')
      const create = vi.spyOn(h.fs.guarded, 'create')
      const result = await EXECUTORS[name](query(h, name, { snapshotTarget: null }))
      expect(result).toMatchObject({ isError: true, state: 'completed' })
      expect(result).not.toHaveProperty('fileMutationAttempted')
      expect(write).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('05 验收 1、50: Edit catches a host write failure and records the attempted mutation', async () => {
    const h = await host()
    const identity = await h.fs.identity(FILE)
    vi.spyOn(h.fs, 'writeFile').mockRejectedValue(new Error('disk full'))
    expect(await editExecutor(query(h, 'Edit', { snapshotTarget: identity }))).toEqual({
      ...failed(fill(EDIT_TEXTS.writeError, { path: FILE, message: 'disk full' })),
      fileMutationAttempted: true,
    })
    expect(await h.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
  })

  it('05 验收 1: Edit failing its final guard does not claim an attempted mutation', async () => {
    const h = await host()
    const identity = h.fs.identity.bind(h.fs)
    vi.spyOn(h.fs, 'identity')
      .mockImplementationOnce(identity)
      .mockRejectedValueOnce(new Error('final identity failed'))
    const write = vi.spyOn(h.fs, 'writeFile')
    expect(await editExecutor(query(h, 'Edit', { snapshotTarget: await identity(FILE) }))).toEqual(
      failed(fill(EDIT_TEXTS.writeError, { path: FILE, message: 'final identity failed' })),
    )
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['Write', 'Edit'] as const)(
    '05 验收 50: %s reports coded non-EEXIST and primitive host errors without rethrowing',
    async (name) => {
      const h = await host()
      const execute = EXECUTORS[name]
      const errors = [
        Object.assign(new Error('access denied'), { code: 'EACCES' }),
        'plain failure',
        null,
      ]
      for (const error of errors) {
        vi.spyOn(h.fs, 'writeFile').mockRejectedValueOnce(error)
        // oxlint-disable-next-line no-await-in-loop -- each failure is a separate executor invocation
        const result = await execute(query(h, name))
        const message = error instanceof Error ? error.message : String(error)
        expect(result).toEqual(
          failed(
            fill(name === 'Edit' ? EDIT_TEXTS.writeError : WRITE_TEXTS.hostError, {
              path: FILE,
              message,
            }),
          ),
        )
        expect(result.content).not.toEqual(failed(FILE_CHANGED).content)
      }
    },
  )

  it('05 验收 29、30: Delete checks relative paths and accepts absolute ones', () => {
    expect(DELETE_TOOL.check({ file_path: 'relative.txt' })).toBe(
      fill(NOT_ABSOLUTE, { key: 'file_path' }),
    )
    expect(DELETE_TOOL.check({ file_path: FILE })).toBeNull()
  })

  it('05 验收 30: Delete treats the root as a folder', async () => {
    const h = await host()
    expect(await deleteExecutor(query(h, 'Delete', { target: absolutePath('/') }))).toEqual(
      failed('/ is a folder, not a file.'),
    )
  })

  it('05 验收 29、30、32: Delete refuses a link appearing where judgment saw no target', async () => {
    const h = await host()
    await h.fs.remove(FILE)
    h.symlink(FILE, '/ws/elsewhere')
    const remove = vi.spyOn(h.fs, 'remove')
    expect(await deleteExecutor(query(h, 'Delete', { fileTarget: null }))).toEqual(
      failed(DELETE_TEXTS.targetChanged),
    )
    expect(remove).not.toHaveBeenCalled()
    expect(await h.fs.identity(FILE)).toMatchObject({ kind: 'link' })
  })

  it('05 验收 43: Delete returns ABORTED if stopped while its guard reads identity', async () => {
    const h = await host()
    const controller = new AbortController()
    const identity = h.fs.identity.bind(h.fs)
    vi.spyOn(h.fs, 'identity').mockImplementation(async (path) => {
      const result = await identity(path)
      if (path === FILE) controller.abort()
      return result
    })
    const remove = vi.spyOn(h.fs, 'remove')
    expect(await deleteExecutor(query(h, 'Delete', { signal: controller.signal }))).toEqual(ABORTED)
    expect(remove).not.toHaveBeenCalled()
    expect(await identity(FILE)).not.toBeNull()
  })
})

describe('05 snapshot identity comparisons', () => {
  it.each([
    { field: 'kind', change: { kind: 'dir' as const } },
    { field: 'mode', change: { mode: 0o600 } },
    { field: 'dev', change: { dev: 2n } },
    { field: 'mtimeNs', change: { mtimeNs: 6n } },
    { field: 'size', change: { size: 7 } },
    { field: 'nlink', change: { nlink: 3 } },
  ])(
    '05 验收 42: a change only to $field after capture returns SNAPSHOT_CHANGED',
    async ({ change }) => {
      const h = await host()
      const captured = { ...ID, nlink: 2 }
      vi.spyOn(h.fs, 'identity').mockResolvedValue({ ...captured, ...change })
      expect(
        await snapshotGuard(
          query(h, 'Write', { snapshotTarget: captured, fileTarget: { kind: 'file', nlink: 2 } }),
        ),
      ).toEqual({ failure: failed(SNAPSHOT_CHANGED) })
    },
  )

  it.each([null, { kind: 'dir' as const, nlink: 2 }, { kind: 'link' as const, nlink: 1 }])(
    '05 验收 25: a new double-named file after judgment saw %j returns HARDLINK_CHANGED',
    async (fileTarget) => {
      const h = await host()
      vi.spyOn(h.fs, 'identity').mockResolvedValue({ ...ID, nlink: 2 })
      expect(await snapshotGuard(query(h, 'Write', { fileTarget }))).toEqual({
        failure: failed(HARDLINK_CHANGED),
      })
    },
  )
})
