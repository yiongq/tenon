import { markConnectorCommand } from '../src/main/host/workspace-leases.js'
/** D64: a live stdio connector must not block restoration of a workspace under its cwd. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
import type { AbsolutePath, RestoreQuery, SnapshotRequest } from '@tenon-app/kernel'
import { DesktopSnapshots } from '../src/main/host/snapshots.js'
import { SystemClock } from '../src/main/host/clock.js'
import { createHostProcess } from '../src/main/host/process.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'
import { wiringFixture } from './sandbox/wiring-support.js'

let temp = ''
afterEach(async () => {
  await rm(temp, { recursive: true, force: true })
})

it('05 验收 53: a connected stdio MCP server permits restore under its home cwd', async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'tenon-review-')))
  const home = absolutePath(join(temp, 'home'))
  const folder = absolutePath(join(home, 'Projects', 'app'))
  const profileDir = absolutePath(join(temp, 'profile'))
  await mkdir(folder, { recursive: true })
  await mkdir(profileDir)
  const sessionId = randomUUID()
  const roundRunId = randomUUID()
  const snapshots = new DesktopSnapshots({
    identity: { userId: 'test', tenantId: 'test', profileDir },
    process: createHostProcess(),
    sandbox: new PassthroughSandbox(() => {}),
    clock: new SystemClock(),
    home,
  })
  await snapshots.setWorkspace(sessionId, [folder])
  await snapshots.settled(sessionId)
  const f = absolutePath(join(folder, 'f'))
  await writeFile(f, 'A')
  const take = async (moment: SnapshotRequest['moment']) => {
    const r = await snapshots.take(
      {
        sessionId,
        call: { sessionId, roundRunId, runId: roundRunId, requestSeq: 1, ordinal: 0 },
        folders: [folder],
        moment,
        path: f,
      },
      new AbortController().signal,
    )
    if (!r.ok) throw new Error(r.reason)
    return r.snapshotId
  }
  const before = await take('before-call')
  await writeFile(f, 'B')
  const after = await take('after-call')
  const q: RestoreQuery = {
    sessionId,
    roundRunId,
    calls: [{ callKey: 'c', before, after, path: f }],
  }

  // Same request shape as kernel mcp/connection.ts connectStdioServer with pool.ts's spawn spec.
  const h = wiringFixture()
  h.runtime.start()
  const commandId = 'mcp:notes'
  const connectorArgv = ['/bin/sleep', '30']
  // The desktop pool supplies markConnectorCommand as beforeStdioWrap (D64).
  markConnectorCommand(connectorArgv)
  const wrapped = await h.runtime.wrap({
    commandId,
    argv: connectorArgv,
    cwd: home as AbsolutePath,
    env: {},
    profile: 'full-access',
    workspace: [],
  })
  const child = await createHostProcess().spawn({
    argv: wrapped.argv,
    cwd: home,
    env: wrapped.env,
    stdio: 'pipe',
  })
  try {
    const preview = await snapshots.preview(q)
    const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
    expect(prepared).toMatchObject({ ok: true })
    if (prepared.ok) await snapshots.cancel({ sessionId, undoSnapshotId: prepared.undoSnapshotId })
  } finally {
    await child.kill('SIGKILL')
    await child.exited
    await h.runtime.afterExit(commandId)
    await snapshots.settled(sessionId)
  }
})
