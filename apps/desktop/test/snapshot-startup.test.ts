/** Spec 05 §快照怎么拍: startup recovery cannot delay desktop host assembly. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import { expect, it, vi } from 'vitest'
import { createDesktopHost } from '../src/main/host/index.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'
import { SnapshotGit } from '../src/main/host/snapshot-git.js'
import { snapshotEnv } from '../src/main/host/shell-env.js'

// Keep this assembly test away from the user's actual sandbox paths and credentials.
vi.mock('../src/main/host/sandbox-runtime.js', () => ({
  createDesktopSandboxRuntime: async () => new PassthroughSandbox(() => {}),
}))

it('05 验收 31、45: host assembly returns while slow snapshot recovery stays conservative', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-snapshot-startup-'))
  const sessionId = '3a1d9a2e-6b3d-4a71-9f52-0c8de7a11b61'
  await mkdir(join(root, 'profiles/u/tenant/snapshots', sessionId), { recursive: true })
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const spy = vi.spyOn(SnapshotGit.prototype, 'available').mockImplementation(async () => {
    reached.resolve()
    await release.promise
    return false
  })
  const creation = createDesktopHost({
    userDataDir: absolutePath(root),
    userId: 'u',
    tenantId: 'tenant',
    send: () => {},
    log: () => {},
    isPackaged: false,
    startupEnv: snapshotEnv({}),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await reached.promise
    const result = await Promise.race([
      creation.then((host) => ({ host })),
      new Promise<{ blocked: true }>((resolve) => {
        timer = setTimeout(() => resolve({ blocked: true }), 100)
      }),
    ])
    expect('host' in result).toBe(true)
    if (!('host' in result)) throw new Error('Host assembly waited for recovery')
    expect(result.host.snapshots.status(sessionId)).toBe('unavailable')
    expect(
      await result.host.snapshots.coverage({ sessionId, path: absolutePath(join(root, 'a')) }),
    ).toBe('none')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    release.resolve()
    await (
      await creation
    ).snapshots.ready
    spy.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
