/** Regression for a stopped caller whose underlying DesktopFs write has not returned yet. */
import type * as nativeFs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
import { DesktopFs } from '../src/main/host/fs.js'
import { DesktopSnapshots } from '../src/main/host/snapshots.js'
import { createHostProcess } from '../src/main/host/process.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'
import { SystemClock } from '../src/main/host/clock.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nativeFs>()
  return { ...actual, stat: vi.fn<typeof actual.stat>(actual.stat) }
})
const actual = await vi.importActual<typeof nativeFs>('node:fs/promises')

it.each(['same folder', 'ancestor workspace'] as const)(
  '05 验收 53: abandoned DesktopFs write in %s stays busy until it really finishes',
  async (scope) => {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'tenon-write-lease-')))
    const folder = absolutePath(join(temp, 'workspace'))
    const home = absolutePath(join(temp, 'home'))
    const profileDir = absolutePath(join(temp, 'profile'))
    const path = absolutePath(join(folder, 'f'))
    const sessionId = randomUUID()
    await Promise.all([folder, home, profileDir].map((dir) => mkdir(dir)))
    const snapshots = new DesktopSnapshots({
      identity: { userId: 'test', tenantId: 'test', profileDir },
      process: createHostProcess(),
      sandbox: new PassthroughSandbox(() => {}),
      clock: new SystemClock(),
      home,
    })
    const release = Promise.withResolvers<void>()
    let writing: Promise<void> | undefined
    try {
      await snapshots.setWorkspace(sessionId, [folder])
      await snapshots.settled(sessionId)
      await writeFile(path, 'A')
      const request = {
        sessionId,
        call: { sessionId, roundRunId: 'r', runId: 'r', requestSeq: 1, ordinal: 0 },
        folders: [folder],
        path,
      }
      const before = await snapshots.take(
        { ...request, moment: 'before-call' },
        new AbortController().signal,
      )
      await writeFile(path, 'B')
      const after = await snapshots.take(
        { ...request, moment: 'after-call' },
        new AbortController().signal,
      )
      if (!before.ok || !after.ok) throw new Error('Snapshot failed')
      const q = {
        sessionId,
        roundRunId: 'r',
        calls: [{ callKey: 'write', before: before.snapshotId, after: after.snapshotId, path }],
      }
      const preview = await snapshots.preview(q)
      const writeTarget =
        scope === 'same folder' ? path : absolutePath(join(temp, 'sibling', 'other'))
      if (scope === 'ancestor workspace') {
        await mkdir(join(temp, 'sibling'))
        await writeFile(writeTarget, 'other')
        await snapshots.setWorkspace(randomUUID(), [absolutePath(temp)])
      }
      const entered = Promise.withResolvers<void>()
      vi.mocked(stat).mockImplementationOnce(async (...args: Parameters<typeof stat>) => {
        entered.resolve()
        await release.promise
        return actual.stat(...args)
      })
      writing = new DesktopFs().writeFile(writeTarget, 'late from stopped caller')
      await entered.promise
      expect(await snapshots.prepare({ ...q, previewKey: preview.previewKey })).toEqual({
        ok: false,
        reason: 'busy',
      })
      release.resolve()
      await writing
      const fresh = await snapshots.preview(q)
      const overwrite = scope === 'same folder' ? [path] : []
      expect(fresh.conflicts).toEqual(overwrite)
      const prepared = await snapshots.prepare({ ...q, previewKey: fresh.previewKey })
      if (!prepared.ok) throw new Error(prepared.reason)
      expect(
        (
          await snapshots.apply({
            sessionId,
            undoSnapshotId: prepared.undoSnapshotId,
            overwrite,
          })
        ).failed,
      ).toEqual([])
      expect(await readFile(path, 'utf8')).toBe('A')
    } finally {
      release.resolve()
      await writing
      vi.mocked(stat).mockReset()
      vi.mocked(stat).mockImplementation(actual.stat)
      await snapshots.settled(sessionId)
      await rm(temp, { recursive: true, force: true })
    }
  },
)
