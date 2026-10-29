/** Full-access snapshot git still traverses the real DesktopSandboxRuntime lease wrapper. */
import { writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
import { repoPath } from '../src/main/host/snapshot-git.js'
import { workspaceLeases } from '../src/main/host/workspace-leases.js'
import { wiringFixture } from './sandbox/wiring-support.js'
import {
  temp,
  folder,
  snapshots,
  sessionId,
  path,
  query,
  take,
} from './support/snapshot-boundaries.js'

it('05 验收 53: S5 — SnapshotGit.run traverses DesktopSandboxRuntime while prepare holds an overlapping exclusive lease', async () => {
  await writeFile(path('f'), 'A')
  const before = await take('f')
  await writeFile(path('f'), 'B')
  const after = await take('f', 'after-call')
  const git = snapshots['git']
  const repo = repoPath(snapshots['sessions'].get(sessionId)!.dir, folder)
  // git runs with the shadow repo as cwd. Include that cwd in the real workspace lease;
  // using only `folder` would leave the repo outside the lease and miss a removed marker.
  await snapshots.setWorkspace(sessionId, [absolutePath(temp)])
  await snapshots.settled(sessionId)
  const q = query([{ callKey: 'write', before, after, path: path('f') }])
  const preview = await snapshots.preview(q)
  const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
  if (!prepared.ok) throw new Error(prepared.reason)
  expect(workspaceLeases.exclusive([repo])).toBeNull()
  const { runtime, srt } = wiringFixture()
  const wrap = vi.spyOn(runtime, 'wrap')
  const original = git['ports'].sandbox
  git['ports'].sandbox = runtime
  const running = git.run(repo, folder, ['--version'], new AbortController().signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      running,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('blocked by own lease'), 1500)
      }),
    ])
    expect(result).toMatch(/^git version /)
    expect(wrap).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: repo, profile: 'full-access' }),
    )
    expect(srt.wrapWithSandboxArgv).not.toHaveBeenCalled()
  } finally {
    clearTimeout(timer)
    await snapshots.cancel({ sessionId, undoSnapshotId: prepared.undoSnapshotId })
    await running
    git['ports'].sandbox = original
    await runtime.dispose()
  }
})
