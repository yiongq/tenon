/** Real git and disposable HOME; shared fixture for restore boundary regressions. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
import type { AbsolutePath, RestoreQuery, SnapshotRequest } from '@tenon-app/kernel'
import { DesktopSnapshots } from '../../src/main/host/snapshots.js'
import { SystemClock } from '../../src/main/host/clock.js'
import { createHostProcess } from '../../src/main/host/process.js'
import { PassthroughSandbox } from '../../src/main/host/sandbox.js'
import { workspaceLeases } from '../../src/main/host/workspace-leases.js'
export let temp: string
export let folder: AbsolutePath
export let snapshots: DesktopSnapshots
export let sessionId: string
export let roundRunId: string
const signal = (): AbortSignal => new AbortController().signal
export const path = (name: string): AbsolutePath => absolutePath(join(folder, name))
export const query = (calls: RestoreQuery['calls']): RestoreQuery => ({
  sessionId,
  roundRunId,
  calls,
})
export async function take(
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
export async function restore(q: RestoreQuery, overwrite: AbsolutePath[] = []) {
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
  vi.restoreAllMocks()
  await Promise.all(
    [...snapshots['prepared']].map(([id, prepared]) =>
      snapshots.cancel({ sessionId: id, undoSnapshotId: prepared.id }),
    ),
  )
  await snapshots.settled(sessionId)
  workspaceLeases.forget(snapshots['sessions'].get(sessionId)!)
  await rm(temp, { recursive: true, force: true })
})
