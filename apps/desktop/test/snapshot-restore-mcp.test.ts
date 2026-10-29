import { markConnectorCommand } from '../src/main/host/workspace-leases.js'
/** D64: a live stdio connector must not block restoration of a workspace under its cwd. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost } from '@tenon-app/kernel'
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

it('05 验收 53: N2 — desktop MCP controller through stdio and real runtime leaves a home workspace restorable', async () => {
  const { DesktopFs } = await import('../src/main/host/fs.js')
  const { createDesktopMcp } = await import('../src/main/mcp/controller.js')
  const { createSchemaWorker } = await import('../src/main/mcp/schema-worker.js')
  const { readConfig } = await import('../src/main/host/profile.js')
  const { mcpDraft } = await import('./support/mcp-harness.js')
  temp = await realpath(await mkdtemp(join(tmpdir(), 'tenon-mcp-lease-')))
  const home = absolutePath(join(temp, 'home'))
  const folder = absolutePath(join(home, 'project'))
  const profileDir = absolutePath(join(temp, 'profile'))
  await mkdir(folder, { recursive: true })
  await mkdir(profileDir)
  const h = wiringFixture()
  h.runtime.start()
  const wrap = vi.spyOn(h.runtime, 'wrap')
  const host = Object.assign(
    createMemoryHost({ identity: { profileDir }, process: createHostProcess() }),
    {
      fs: new DesktopFs(),
      clock: new SystemClock(),
      sandbox: h.runtime,
    },
  )
  const snapshots = new DesktopSnapshots({ ...host, home })
  const sessionId = randomUUID()
  const roundRunId = randomUUID()
  await snapshots.setWorkspace(sessionId, [folder])
  await snapshots.settled(sessionId)
  const file = absolutePath(join(folder, 'f'))
  const capture = async (moment: SnapshotRequest['moment']) => {
    const result = await snapshots.take(
      {
        sessionId,
        call: { sessionId, roundRunId, runId: roundRunId, requestSeq: 1, ordinal: 0 },
        folders: [folder],
        moment,
        path: file,
      },
      new AbortController().signal,
    )
    if (!result.ok) throw new Error(result.reason)
    return result.snapshotId
  }
  await writeFile(file, 'A')
  const before = await capture('before-call')
  await writeFile(file, 'B')
  const after = await capture('after-call')
  const mcp = createDesktopMcp({
    host,
    config: await readConfig(host.fs, host.identity),
    home,
    baseEnv: async () => ({ PATH: '/bin:/usr/bin' }),
    uuid: randomUUID,
    changed: () => {},
    schemaValidator: createSchemaWorker(),
  })
  try {
    const draft = mcpDraft('restore-fixture')
    draft.transport = {
      type: 'stdio',
      command: process.execPath,
      args: [
        new URL('../../../packages/kernel/test/support/fixtures/modern-server.mjs', import.meta.url)
          .pathname,
        'dual',
      ],
      envs: {},
      env_keys: [],
    }
    expect(
      await mcp.store.save({
        mode: 'create',
        draft,
        secrets: { env: {}, headers: {} },
        consent: 'persistent',
      }),
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(mcp.pool.status()[0]?.phase).toBe('connected'))
    expect(wrap).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: 'mcp:restore-fixture', cwd: home, workspace: [] }),
    )
    const q = { sessionId, roundRunId, calls: [{ callKey: 'write', before, after, path: file }] }
    const preview = await snapshots.preview(q)
    const prepared = await snapshots.prepare({ ...q, previewKey: preview.previewKey })
    expect(prepared).toMatchObject({ ok: true })
    if (prepared.ok) await snapshots.cancel({ sessionId, undoSnapshotId: prepared.undoSnapshotId })
    expect(mcp.pool.status()[0]?.phase).toBe('connected')
  } finally {
    await mcp.close({ deadlineMs: 1000 })
    await snapshots.settled(sessionId)
    await h.runtime.dispose()
    wrap.mockRestore()
  }
})
