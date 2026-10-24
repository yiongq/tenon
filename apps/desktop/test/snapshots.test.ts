/** Spec 05 plan step 4: real git, disposable workspace/profile/HOME; no models or credentials. */
import * as nativeFs from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  open,
  link,
  symlink,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AbsolutePath,
  ChildHandle,
  HostProcess,
  SnapshotRequest,
  SnapshotTaken,
  SpawnSpec,
} from '@tenon-app/kernel'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createSessionService,
} from '@tenon-app/kernel'
import type { IpcMainLike } from '@tenon-app/contracts'
import { createCounterIds, createTestLoopPorts } from '@tenon-app/kernel/testing'
import { registerWorkspaceRoutes } from '../src/main/workspace.js'
import { createSessionRemoval } from '../src/main/session-removal.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SystemClock } from '../src/main/host/clock.js'
import { createHostProcess } from '../src/main/host/process.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'
import { SnapshotGit, probeVolume, repoPath } from '../src/main/host/snapshot-git.js'
import { diskBytes, MAX_FILE_BYTES } from '../src/main/host/snapshot-storage.js'
import type { SnapshotManifest } from '../src/main/host/snapshot-storage.js'
import { DesktopSnapshots } from '../src/main/host/snapshots.js'
import type { DesktopSnapshotsOptions } from '../src/main/host/snapshots.js'

// Faults affect the real filesystem operations, while successful paths still use disk and real git.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nativeFs>()
  return {
    ...actual,
    writeFile: vi.fn<typeof actual.writeFile>(actual.writeFile),
    lstat: vi.fn<typeof actual.lstat>(actual.lstat),
  }
})
const actualFs = await vi.importActual<typeof nativeFs>('node:fs/promises')

const SESSION = '3a1d9a2e-6b3d-4a71-9f52-0c8de7a11b61'
let root: string
let home: AbsolutePath
let workspace: AbsolutePath
let profile: AbsolutePath
let snapshots: DesktopSnapshots
const realProcess = createHostProcess()
const sandbox = new PassthroughSandbox(() => {})
const spawned: SpawnSpec[] = []
const tracking: HostProcess = {
  spawn: (spec, signal) => {
    spawned.push(spec)
    return realProcess.spawn(spec, signal)
  },
}
const controllers: DesktopSnapshots[] = []
function make(options: Partial<DesktopSnapshotsOptions> = {}): DesktopSnapshots {
  const controller = new DesktopSnapshots({
    identity: { userId: 'u', tenantId: 'tenant', profileDir: profile },
    process: tracking,
    sandbox,
    clock: new SystemClock(),
    home,
    ...options,
  })
  controllers.push(controller)
  return controller
}
function request(
  path?: string,
  roundRunId: string = randomUUID(),
  sessionId: string = SESSION,
): SnapshotRequest {
  return {
    sessionId,
    call: { sessionId, roundRunId, runId: roundRunId, requestSeq: 1, ordinal: 0 },
    folders: [workspace],
    moment: 'before-call',
    ...(path === undefined ? {} : { path: absolutePath(path) }),
  }
}
function expectState(controller: DesktopSnapshots, state: 'tree' | 'file-only'): void {
  const reasonMatcher = expect.any(String)
  expect({
    state: controller.status(SESSION),
    diagnostic: controller.lastDegradeReason(SESSION),
  }).toEqual({ state, diagnostic: state === 'tree' ? null : reasonMatcher })
}
function expectSuccess(controller: DesktopSnapshots, result: SnapshotTaken): void {
  expect({
    result,
    diagnostic: result.ok ? null : controller.lastDegradeReason(SESSION),
  }).toMatchObject({ result: { ok: true }, diagnostic: null })
}

async function warm(controller = snapshots, folder = workspace): Promise<void> {
  await controller.setWorkspace(SESSION, [folder])
  await controller.settled(SESSION)
}
async function manifest(result: SnapshotTaken, sessionId = SESSION): Promise<SnapshotManifest> {
  if (!result.ok)
    throw new Error(
      `snapshot failed: ${result.reason}; diagnostics: ${controllers.map((controller) => controller.lastDegradeReason(sessionId)).join('; ')}`,
    )
  return JSON.parse(
    await readFile(
      join(profile, 'snapshots', sessionId, 'manifests', `${result.snapshotId}.json`),
      'utf8',
    ),
  ) as SnapshotManifest
}
async function git(args: string[], cwd: string = workspace): Promise<string> {
  const runner = new SnapshotGit({ process: tracking, sandbox })
  return runner.command(['/usr/bin/git', ...args], cwd, home, new AbortController().signal)
}
async function copy(file: SnapshotManifest['files'][number], sessionId = SESSION): Promise<Buffer> {
  return readFile(join(profile, 'snapshots', sessionId, 'files', file!.hash!))
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-05-snapshot-')))
  home = absolutePath(join(root, 'home'))
  workspace = absolutePath(join(root, 'workspace'))
  profile = absolutePath(join(root, 'profiles', 'u', 'tenant'))
  await Promise.all([home, workspace, profile].map((path) => mkdir(path, { recursive: true })))
  spawned.length = 0
  snapshots = make()
})
afterEach(async () => {
  await Promise.all(
    controllers.splice(0).map(async (controller) => {
      await controller.settled(SESSION)
    }),
  )
  vi.mocked(nativeFs.writeFile).mockReset()
  vi.mocked(nativeFs.lstat).mockReset()
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')(
  '05 real git snapshots (POSIX; Windows intentionally uses file copies)',
  () => {
    it('05 验收 5: parentless snapshots stay under the tenant profile and leave user git status unchanged', async () => {
      await git(['init', '--initial-branch=main', workspace])
      await writeFile(join(workspace, 'a.txt'), 'original\r\n')
      const before = await git(['status', '--porcelain=v1', '-uall'])
      const names = await readdir(workspace)
      await warm()
      expectState(snapshots, 'tree')
      const q = request(join(workspace, 'a.txt'))
      const first = await snapshots.take(q, new AbortController().signal)
      const firstManifest = await manifest(first)
      expect(firstManifest.trees).toHaveLength(1)
      const repo = repoPath(join(profile, 'snapshots', SESSION), workspace)
      const commit = firstManifest.trees[0]!.commit
      const metadata = await git([`--git-dir=${repo}`, 'cat-file', '-p', commit])
      expect(metadata).not.toMatch(/^parent /m)
      expect(await git([`--git-dir=${repo}`, 'show', `${commit}:a.txt`])).toBe('original\r\n')
      expect(await readdir(workspace)).toEqual(names)
      expect(await git(['status', '--porcelain=v1', '-uall'])).toBe(before)
      expect(
        spawned.every((spec) => spec.argv[0]!.startsWith('/') && spec.cwd.startsWith('/')),
      ).toBe(true)
      expect(spawned.every((spec) => spec.env['PATH'] === '/usr/bin:/bin')).toBe(true)
    }, 15_000)

    it('05 验收 6: global config, hooks, filters and attributes do not change stored bytes or run commands', async () => {
      await writeFile(
        join(home, '.gitconfig'),
        '[core]\n excludesFile = ' +
          join(home, 'ignored') +
          '\n hooksPath = ' +
          join(home, 'hooks') +
          '\n fsmonitor = ' +
          join(home, 'monitor') +
          '\n[filter "evil"]\n clean = touch ' +
          join(home, 'ran') +
          '\n',
      )
      await writeFile(join(home, 'ignored'), 'secret.txt\n')
      await mkdir(join(home, 'hooks'))
      for (const path of [join(home, 'hooks', 'pre-commit'), join(home, 'monitor')]) {
        // oxlint-disable-next-line no-await-in-loop -- executable fixtures only under disposable HOME
        await writeFile(path, '#!/bin/sh\ntouch ' + join(home, 'ran') + '\n', { mode: 0o700 })
      }
      await writeFile(
        join(workspace, '.gitattributes'),
        '* text eol=lf ident filter=evil working-tree-encoding=UTF-16\n',
      )
      await writeFile(join(workspace, 'secret.txt'), 'raw\r\n$Id$\r\n')
      await warm()
      const result = await snapshots.take(request(), new AbortController().signal)
      const data = await manifest(result)
      const repo = repoPath(join(profile, 'snapshots', SESSION), workspace)
      expect(await git([`--git-dir=${repo}`, 'show', `${data.trees[0]!.commit}:secret.txt`])).toBe(
        'raw\r\n$Id$\r\n',
      )
      await expect(lstat(join(home, 'ran'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        spawned
          .filter((spec) => spec.argv[0] === '/usr/bin/git')
          .every((spec) => spec.env['GIT_CONFIG_NOSYSTEM'] === '1'),
      ).toBe(true)
    }, 15_000)

    it('05 验收 7、46: nested git roots and ignored targets get byte-for-byte single copies', async () => {
      await mkdir(join(workspace, 'nested'))
      await writeFile(join(workspace, 'nested', '.git'), 'gitdir: nowhere\n')
      await writeFile(join(workspace, 'nested', 'n.txt'), 'nested bytes\u0000')
      await writeFile(join(workspace, '.gitignore'), 'ignored.txt\n')
      await writeFile(join(workspace, 'ignored.txt'), 'ignored bytes\r\n')
      await writeFile(join(workspace, 'included.txt'), 'included')
      await warm()
      const nested = await manifest(
        await snapshots.take(
          request(join(workspace, 'nested', 'n.txt')),
          new AbortController().signal,
        ),
      )
      expect(nested.trees[0]!.entries.some((entry) => entry.path.includes('/nested/'))).toBe(false)
      expect(await copy(nested.files[0]!)).toEqual(Buffer.from('nested bytes\u0000'))
      expect(
        await snapshots.coverage({
          sessionId: SESSION,
          path: absolutePath(join(workspace, 'ignored.txt')),
        }),
      ).toBe('file')
      const ignored = await manifest(
        await snapshots.take(request(join(workspace, 'ignored.txt')), new AbortController().signal),
      )
      expect(await copy(ignored.files[0]!)).toEqual(Buffer.from('ignored bytes\r\n'))
    }, 15_000)

    it('05 验收 8: a newly oversized or unreadable file is excluded and counted without failing the tree', async () => {
      const small = join(workspace, 'size.txt')
      await writeFile(small, 'small')
      await writeFile(join(workspace, 'unreadable'), 'private')
      await warm()
      const handle = await open(small, 'r+')
      await handle.truncate(MAX_FILE_BYTES + 1)
      await handle.close()
      await chmod(join(workspace, 'unreadable'), 0)
      try {
        const data = await manifest(await snapshots.take(request(), new AbortController().signal))
        expect(data.trees[0]!.entries.some((entry) => entry.path === small)).toBe(false)
        expect(data.skipped).toBeGreaterThanOrEqual(1)
        expect(data.skipped).toBe(process.getuid?.() === 0 ? 1 : 2)
        expect(data.trees[0]!.entries.some((entry) => entry.path.endsWith('/unreadable'))).toBe(
          process.getuid?.() === 0,
        )
      } finally {
        await chmod(join(workspace, 'unreadable'), 0o600)
      }
    }, 15_000)

    it('05 验收 44、49: volume traits and file/directory modes are captured on the workspace volume', async () => {
      await mkdir(join(workspace, 'readonly'))
      await writeFile(join(workspace, 'readonly', 'secret'), 'secret')
      await chmod(join(workspace, 'readonly', 'secret'), 0o600)
      await chmod(join(workspace, 'readonly'), 0o555)
      try {
        const traits = await probeVolume(workspace, new AbortController().signal)
        await warm()
        const data = await manifest(await snapshots.take(request(), new AbortController().signal))
        expect(data.trees[0]!.directories[join(workspace, 'readonly')]).toBe(0o555)
        expect(
          data.trees[0]!.entries.find((entry) => entry.path.endsWith('/secret'))!.identity!.mode,
        ).toBe(0o600)
        const repo = repoPath(join(profile, 'snapshots', SESSION), workspace)
        expect((await git([`--git-dir=${repo}`, 'config', 'core.ignorecase'])).trim()).toBe(
          String(traits.ignorecase),
        )
        expect((await git([`--git-dir=${repo}`, 'config', 'core.symlinks'])).trim()).toBe(
          String(traits.symlinks),
        )
        expect((await git([`--git-dir=${repo}`, 'config', 'core.filemode'])).trim()).toBe(
          String(traits.filemode),
        )
      } finally {
        await chmod(join(workspace, 'readonly'), 0o700)
      }
    }, 15_000)
  },
)

function injectedProcess(
  intercept: (spec: SpawnSpec, signal?: AbortSignal) => Promise<ChildHandle> | null,
): HostProcess {
  return {
    spawn: (spec, signal) => {
      spawned.push(spec)
      return intercept(spec, signal) ?? realProcess.spawn(spec, signal)
    },
  }
}
function untilAborted(signal?: AbortSignal): Promise<never> {
  if (signal === undefined) return Promise.reject(new Error('Expected snapshot abort signal'))
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  )
}

async function fileOnly(options: Partial<DesktopSnapshotsOptions> = {}): Promise<DesktopSnapshots> {
  const controller = make({ platform: 'win32', ...options })
  await warm(controller)
  expectState(controller, 'file-only')
  return controller
}

describe('05 snapshot budgets and availability', () => {
  it.skipIf(process.platform === 'win32')(
    '05 验收 10: file-count budget permanently downgrades once and later calls use copies',
    async () => {
      await writeFile(join(workspace, 'a'), 'a')
      await writeFile(join(workspace, 'b'), 'b')
      const notices = vi.fn<(id: string, state: string) => void>()
      const controller = make({ limits: { files: 1 }, onDegraded: notices })
      await warm(controller)
      expectState(controller, 'file-only')
      expect(controller.lastDegradeReason(SESSION)).toMatch(/file-count budget/)
      expect(notices).toHaveBeenCalledTimes(1)
      const treeCalls = spawned.filter((spec) => spec.argv.includes('add')).length
      const result = await controller.take(
        request(join(workspace, 'a')),
        new AbortController().signal,
      )
      expect(result).toMatchObject({ ok: true, scope: 'file' })
      expect(spawned.filter((spec) => spec.argv.includes('add'))).toHaveLength(treeCalls)
      const other = absolutePath(join(root, 'other'))
      await mkdir(other)
      await controller.setWorkspace(SESSION, [other])
      await controller.settled(SESSION)
      expect(controller.status(SESSION)).toBe('file-only')
      expect(notices).toHaveBeenCalledTimes(1)
    },
  )

  it('05 验收 10: the first-snapshot deadline downgrades once without delaying file copies', async () => {
    await writeFile(join(workspace, 'a'), 'a')
    const notices = vi.fn<(id: string, state: string) => void>()
    const gate = Promise.withResolvers<void>()
    const controller = make({
      platform: 'linux',
      limits: { firstMs: 100 },
      onDegraded: notices,
      process: injectedProcess((spec, signal) => {
        if (spec.argv.includes('--version')) {
          gate.resolve()
          return untilAborted(signal)
        }
        return null
      }),
    })
    await controller.setWorkspace(SESSION, [workspace])
    await gate.promise
    expect(controller.status(SESSION)).toBe('warming')
    const copied = await controller.take(
      request(join(workspace, 'a')),
      new AbortController().signal,
    )
    expect(copied).toMatchObject({ ok: true, scope: 'file' })
    await controller.settled(SESSION)
    expect(controller.lastDegradeReason(SESSION)).toMatch(/First snapshot timeout/)
    expect(controller.status(SESSION)).toBe('file-only')
    expect(notices).toHaveBeenCalledTimes(1)
    expect(
      await controller.take(request(join(workspace, 'a')), new AbortController().signal),
    ).toMatchObject({ ok: true, scope: 'file' })
    expect(notices).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')(
    '05 验收 10: later snapshot deadline disables all further tree captures',
    async () => {
      await writeFile(join(workspace, 'a'), 'a')
      let block = false
      const notices = vi.fn<(id: string, state: string) => void>()
      const controller = make({
        limits: { takeMs: 150 },
        onDegraded: notices,
        process: injectedProcess((spec, signal) =>
          block && spec.argv.includes('write-tree') ? untilAborted(signal) : null,
        ),
      })
      await warm(controller)
      expectState(controller, 'tree')
      block = true
      expect(await controller.take(request(), new AbortController().signal)).toEqual({
        ok: false,
        reason: 'error',
      })
      expect(controller.status(SESSION)).toBe('file-only')
      expect(controller.lastDegradeReason(SESSION)).toMatch(/timeout budget/)
      const adds = spawned.filter((spec) => spec.argv.includes('add')).length
      expect(
        await controller.take(request(join(workspace, 'a')), new AbortController().signal),
      ).toMatchObject({ ok: true, scope: 'file' })
      expect(spawned.filter((spec) => spec.argv.includes('add'))).toHaveLength(adds)
      expect(notices).toHaveBeenCalledTimes(1)
    },
    10_000,
  )

  it('05 验收 11: a failed xcode-select never launches git and retains single-file coverage', async () => {
    await writeFile(join(workspace, 'a'), 'a')
    const controller = make({
      platform: 'darwin',
      process: injectedProcess((spec) => {
        if (spec.argv[0] === '/usr/bin/xcode-select')
          return Promise.reject(new Error('injected xcode-select failure'))
        return null
      }),
    })
    await warm(controller)
    expect(controller.status(SESSION)).toBe('file-only')
    expect(controller.lastDegradeReason(SESSION)).toMatch(/xcode-select failure/)
    expect(spawned.some((spec) => spec.argv[0] === '/usr/bin/git')).toBe(false)
    expect(
      await controller.take(request(join(workspace, 'a')), new AbortController().signal),
    ).toMatchObject({ ok: true, scope: 'file' })
  })

  it.each(['old-version', 'init-failure'] as const)(
    '05 验收 11: %s git falls back to single-file copies',
    async (failure) => {
      await writeFile(join(workspace, 'a'), 'a')
      const exe = join(root, 'test-git')
      const version = failure === 'old-version' ? '2.42.0' : '2.43.0'
      await writeFile(
        exe,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "git version ' +
          version +
          '\\n"; else exit 1; fi\n',
        { mode: 0o700 },
      )
      const controller = make({ platform: 'linux', gitPath: exe })
      await warm(controller)
      expectState(controller, 'file-only')
      expect(controller.lastDegradeReason(SESSION)).toMatch(
        failure === 'old-version' ? /below 2.43/ : /subprocess failed/,
      )
      expect(
        await controller.take(request(join(workspace, 'a')), new AbortController().signal),
      ).toMatchObject({ ok: true, scope: 'file' })
    },
  )

  it.each(['home', 'Desktop', 'Documents', 'Downloads', 'parent'] as const)(
    '05 验收 12: %s gets copies without a shadow repository',
    async (kind) => {
      const folder = absolutePath(
        kind === 'home' ? home : kind === 'parent' ? root : join(home, kind),
      )
      await mkdir(folder, { recursive: true })
      const target = join(folder, 'example')
      await writeFile(target, 'bytes')
      const controller = make()
      await warm(controller, folder)
      expect(controller.status(SESSION)).toBe('file-only')
      expect(await readdir(join(profile, 'snapshots', SESSION, 'repos'))).toEqual([])
      expect(await controller.coverage({ sessionId: SESSION, path: absolutePath(target) })).toBe(
        'file',
      )
      const data = await manifest(
        // oxlint-disable-next-line no-await-in-loop -- snapshot one retained round before continuing
        await controller.take(
          { ...request(target), folders: [folder] },
          new AbortController().signal,
        ),
      )
      expect(await copy(data.files[0]!)).toEqual(Buffer.from('bytes'))
    },
  )

  it('05 验收 31: pending, file-only and full-disk unavailable states are synchronous and notify once', async () => {
    const notices = vi.fn<(id: string, state: string) => void>()
    const controller = await fileOnly({ onDegraded: notices })
    expect(controller.status('unknown')).toBe('unavailable')
    await writeFile(join(workspace, 'a'), 'a')
    vi.mocked(nativeFs.writeFile).mockImplementation(async (...args) => {
      if (String(args[0]).includes('/files/'))
        throw Object.assign(new Error('ENOSPC: injected full disk'), { code: 'ENOSPC' })
      return actualFs.writeFile(...args)
    })
    expect(
      await controller.take(request(join(workspace, 'a')), new AbortController().signal),
    ).toEqual({ ok: false, reason: 'disk' })
    expect(controller.status(SESSION)).toBe('unavailable')
    expect(controller.lastDegradeReason(SESSION)).toMatch(/ENOSPC/)
    expect(
      await controller.coverage({ sessionId: SESSION, path: absolutePath(join(workspace, 'a')) }),
    ).toBe('none')
    expect(
      await controller.take(request(join(workspace, 'a')), new AbortController().signal),
    ).toEqual({ ok: false, reason: 'disk' })
    expect(notices.mock.calls.map((call) => call[1])).toEqual(['file-only', 'unavailable'])
  })
})

function manualClock(): { clock: SystemClock; advance(ms: number): void } {
  let now = 1_000_000
  const clock = new SystemClock()
  clock.now = () => now
  return {
    clock,
    advance: (ms) => {
      now += ms
    },
  }
}

describe('05 retention and reservations', () => {
  it('05 验收 14: retention keeps all calls of the latest twenty rounds and no older round', async () => {
    const time = manualClock()
    const controller = await fileOnly({ clock: time.clock })
    const ids: string[] = []
    await writeFile(join(workspace, 'a'), 'initial')
    for (let i = 0; i < 22; i++) {
      time.advance(1)
      const q = request(join(workspace, 'a'))
      // oxlint-disable-next-line no-await-in-loop -- exercise the real retention boundary at 20 rounds
      const before = await controller.take(q, new AbortController().signal)
      // oxlint-disable-next-line no-await-in-loop -- every round has both before and after records
      const after = await controller.take(
        { ...q, moment: 'after-call' },
        new AbortController().signal,
      )
      expectSuccess(controller, before)
      expectSuccess(controller, after)
      ids.push(
        (before as Extract<SnapshotTaken, { ok: true }>).snapshotId,
        (after as Extract<SnapshotTaken, { ok: true }>).snapshotId,
      )
    }
    expect(await controller.alive(SESSION, ids)).toEqual(new Set(ids.slice(4)))
    expect(await readdir(join(profile, 'snapshots', SESSION, 'manifests'))).toHaveLength(40)
  }, 10_000)

  it.each([1, 2])(
    '05 验收 14: thirty days clears all %i rounds even if latest or active',
    async (count) => {
      const time = manualClock()
      const controller = await fileOnly({ clock: time.clock })
      const ids: string[] = []
      let lastRound = ''
      for (let i = 0; i < count; i++) {
        lastRound = randomUUID()
        // oxlint-disable-next-line no-await-in-loop -- distinct byte copies for each retained round
        await writeFile(join(workspace, 'a'), 'content ' + i)
        // oxlint-disable-next-line no-await-in-loop -- publish each snapshot before advancing age
        const data = await manifest(
          // oxlint-disable-next-line no-await-in-loop -- snapshot one retained round before continuing
          await controller.take(
            request(join(workspace, 'a'), lastRound),
            new AbortController().signal,
          ),
        )
        ids.push(data.id)
        time.advance(1)
      }
      controller.bindActiveRounds(() => [{ rootSessionId: SESSION, runId: lastRound }])
      time.advance(30 * 24 * 60 * 60 * 1000)
      expect(await controller.alive(SESSION, ids)).toEqual(new Set())
      expect(await readdir(join(profile, 'snapshots', SESSION, 'files'))).toEqual([])
      expect(await readdir(join(profile, 'snapshots', SESSION, 'manifests'))).toEqual([])
    },
  )

  it('05 验收 14: space reclaim removes old rounds and keeps the active origin and latest round', async () => {
    const time = manualClock()
    const budget = 220_000
    const controller = await fileOnly({ clock: time.clock, limits: { bytes: budget } })
    const ids: string[] = []
    let origin = ''
    for (let i = 0; i < 6; i++) {
      const round = randomUUID()
      if (i === 0) {
        origin = round
        controller.bindActiveRounds(() => [{ rootSessionId: SESSION, runId: origin }])
      }
      time.advance(1)
      // oxlint-disable-next-line no-await-in-loop -- incompressible copies make real allocated blocks observable
      await writeFile(join(workspace, 'a'), randomBytes(32_000))
      // oxlint-disable-next-line no-await-in-loop -- fill the injected budget with successive user rounds
      const data = await manifest(
        // oxlint-disable-next-line no-await-in-loop -- snapshot one retained round before continuing
        await controller.take(request(join(workspace, 'a'), round), new AbortController().signal),
      )
      ids.push(data.id)
    }
    const live = await controller.alive(SESSION, ids)
    expect(live.has(ids[0]!)).toBe(true)
    expect(live.has(ids.at(-1)!)).toBe(true)
    expect(live.size).toBeLessThan(ids.length)
    expect(await diskBytes(join(profile, 'snapshots'))).toBeLessThanOrEqual(budget)
  })

  it('05 验收 14: over-budget never removes the protected origin to fund a new promise', async () => {
    const controller = await fileOnly({ limits: { bytes: 160_000 } })
    const round = randomUUID()
    await writeFile(join(workspace, 'a'), randomBytes(20_000))
    const before = await manifest(
      await controller.take(request(join(workspace, 'a'), round), new AbortController().signal),
    )
    controller.bindActiveRounds(() => [{ rootSessionId: SESSION, runId: round }])
    await writeFile(join(workspace, 'a'), randomBytes(100_000))
    expect(
      await controller.take(request(join(workspace, 'a'), round), new AbortController().signal),
    ).toEqual({ ok: false, reason: 'over-budget' })
    expect(await controller.alive(SESSION, [before.id])).toEqual(new Set([before.id]))
    expect(await copy(before.files[0]!)).toHaveLength(20_000)
    expect(await diskBytes(join(profile, 'snapshots'))).toBeLessThanOrEqual(160_000)
  })

  it.skipIf(process.platform === 'win32')(
    '05 验收 14: first-tree estimate over remaining budget stages no files',
    async () => {
      await writeFile(join(workspace, 'a'), randomBytes(200_000))
      const controller = make({ limits: { bytes: 300_000 } })
      await warm(controller)
      expect(controller.status(SESSION)).toBe('file-only')
      expect(controller.lastDegradeReason(SESSION)).toMatch(/budget/)
      expect(spawned.some((spec) => spec.argv.includes('add'))).toBe(false)
      expect(
        await controller.take(request(join(workspace, 'a')), new AbortController().signal),
      ).toEqual({ ok: false, reason: 'over-budget' })
      expect(await readdir(join(profile, 'snapshots', SESSION, 'manifests'))).toEqual([])
      expect(await diskBytes(join(profile, 'snapshots'))).toBeLessThanOrEqual(300_000)
    },
  )

  it('05 验收 14: concurrent reservations across sessions cannot spend the same free blocks', async () => {
    const second = randomUUID()
    const controller = await fileOnly({ limits: { bytes: 190_000 } })
    await controller.setWorkspace(second, [workspace])
    await controller.settled(second)
    await writeFile(join(workspace, 'a'), randomBytes(32_000))
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let hold = true
    vi.mocked(nativeFs.writeFile).mockImplementation(async (...args) => {
      if (hold && String(args[0]).includes('/files/')) {
        hold = false
        reached.resolve()
        await release.promise
      }
      return actualFs.writeFile(...args)
    })
    const first = controller.take(request(join(workspace, 'a')), new AbortController().signal)
    try {
      await reached.promise
      expect(
        await controller.take(
          request(join(workspace, 'a'), randomUUID(), second),
          new AbortController().signal,
        ),
      ).toEqual({ ok: false, reason: 'over-budget' })
    } finally {
      release.resolve()
    }
    expect(await first).toMatchObject({ ok: true })
    expect(
      await controller.take(
        request(join(workspace, 'a'), randomUUID(), second),
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true })
    expect(await diskBytes(join(profile, 'snapshots'))).toBeLessThanOrEqual(190_000)
  })
})

describe('05 recovery, lifecycle and coverage', () => {
  it.skipIf(process.platform === 'win32')(
    '05 验收 45: restart drops partial manifests, orphan refs and index.lock and rebuilds the latest index',
    async () => {
      await writeFile(join(workspace, 'a'), 'before')
      await warm()
      const data = await manifest(await snapshots.take(request(), new AbortController().signal))
      const repo = repoPath(join(profile, 'snapshots', SESSION), workspace)
      await writeFile(join(repo, 'index.lock'), 'left by a crash')
      await writeFile(join(repo, 'index'), 'partial index')
      await writeFile(join(profile, 'snapshots', SESSION, 'manifests', 'partial.tmp'), '{}')
      await writeFile(join(profile, 'snapshots', SESSION, 'files', 'unpublished'), 'garbage')
      const orphan = randomUUID()
      await git([`--git-dir=${repo}`, 'update-ref', `refs/tenon/${orphan}`, data.trees[0]!.commit])
      const reopened = make()
      await reopened.ready
      expect(reopened.lastDegradeReason(SESSION)).toBeNull()
      await expect(lstat(join(repo, 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(join(profile, 'snapshots', SESSION, 'manifests'))).toEqual([
        data.id + '.json',
      ])
      expect(await readdir(join(profile, 'snapshots', SESSION, 'files'))).toEqual([])
      const rebuilt = await git([`--git-dir=${repo}`, 'ls-files', '--stage'])
      expect(rebuilt).toContain('a')
      expect(
        (
          await git([`--git-dir=${repo}`, 'for-each-ref', '--format=%(refname)', 'refs/tenon/'])
        ).trim(),
      ).toBe(`refs/tenon/${data.id}`)
      expect(await reopened.alive(SESSION, [data.id, orphan])).toEqual(new Set([data.id]))
    },
    15_000,
  )

  it.skipIf(process.platform === 'win32')(
    '05 验收 45: concurrent captures and age cleanup keep live parentless trees sound',
    async () => {
      const time = manualClock()
      const controller = make({ clock: time.clock, limits: { ageMs: 100 } })
      await writeFile(join(workspace, 'a'), 'old')
      await warm(controller)
      const old = await manifest(await controller.take(request(), new AbortController().signal))
      time.advance(101)
      await writeFile(join(workspace, 'a'), 'new')
      const [a, b] = await Promise.all([
        controller.take(request(), new AbortController().signal),
        controller.take(request(), new AbortController().signal),
        controller.alive(SESSION, [old.id]),
      ])
      const captured = await Promise.all([manifest(a), manifest(b)])
      const repo = repoPath(join(profile, 'snapshots', SESSION), workspace)
      await git([`--git-dir=${repo}`, 'fsck', '--no-reflogs'])
      expect(
        await controller.alive(
          SESSION,
          captured.map((item) => item.id),
        ),
      ).toEqual(new Set(captured.map((item) => item.id)))
      expect(await controller.alive(SESSION, [old.id])).toEqual(new Set())
      expect(await git([`--git-dir=${repo}`, 'show', `${captured[0]!.trees[0]!.commit}:a`])).toBe(
        'new',
      )
    },
    15_000,
  )

  it.skipIf(process.platform === 'win32')(
    '05 验收 14: age cleanup releases old git blobs immediately, even for the only round',
    async () => {
      const time = manualClock()
      const controller = make({ clock: time.clock, limits: { ageMs: 100 } })
      await writeFile(join(workspace, 'a'), randomBytes(16_000))
      await warm(controller)
      const old = await manifest(await controller.take(request(), new AbortController().signal))
      const repo = repoPath(join(profile, 'snapshots', SESSION), workspace)
      const blob = old.trees[0]!.entries[0]!.hash!
      time.advance(101)
      expect(await controller.alive(SESSION, [old.id])).toEqual(new Set())
      await expect(git([`--git-dir=${repo}`, 'cat-file', '-e', blob])).rejects.toThrow(
        /subprocess failed/,
      )
    },
    15_000,
  )

  it.each(['clear', 'delete'] as const)(
    '05 验收 14: session %s removes its snapshot directory after the store commits',
    async (action) => {
      const controller = await fileOnly()
      await writeFile(join(workspace, 'a'), 'a')
      await controller.take(request(join(workspace, 'a')), new AbortController().signal)
      const committed: string[] = []
      const removal = createSessionRemoval({
        sessions: {
          resetSession: async (id) => {
            committed.push('clear')
            return { sessionId: id, incarnationId: randomUUID(), startEntryId: 1 }
          },
          deleteSession: async () => {
            committed.push('delete')
          },
        },
        profileDir: profile,
        runs: () => null,
        log: () => {},
        removeSnapshots: async (id) => {
          expect(committed).toEqual([action])
          await controller.removeSession(id)
        },
      })
      await removal[action](SESSION)
      await expect(lstat(join(profile, 'snapshots', SESSION))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(await controller.alive(SESSION, [])).toEqual(new Set())
    },
  )

  it.skipIf(process.platform === 'win32')(
    '05 验收 10: accepted workspace notifications start the first tree in the background',
    async () => {
      await writeFile(join(workspace, 'a'), 'a')
      const memory = createMemoryHost({ identity: { profileDir: profile } })
      await memory.fs.mkdirp(profile)
      await memory.fs.mkdirp(workspace)
      const ports = createTestLoopPorts({})
      const sessions = createSessionService({
        host: memory,
        tape: createMemoryTapeStore({ identity: memory.identity }),
        ids: createCounterIds(),
        inspectors: [],
        connector: ports.connector,
        protectedFiles: [],
      })
      sessions.bindLoop(ports)
      const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
      const ipcMain: IpcMainLike = {
        handle: (channel, callback) => {
          handlers.set(channel, callback as (event: unknown, input: unknown) => unknown)
        },
      }
      registerWorkspaceRoutes({
        ipcMain,
        sessions,
        host: memory,
        home,
        pickFolders: async () => [workspace],
        onWorkspaceChanged: (id, folders) => snapshots.setWorkspace(id, folders),
      })
      await handlers.get('session.selectProfile')!({}, { sessionId: SESSION, profile: 'cowork' })
      await handlers.get('workspace.pick')!({}, { sessionId: SESSION })
      expect(snapshots.status(SESSION)).toBe('warming')
      await snapshots.settled(SESSION)
      expectState(snapshots, 'tree')
      expect(await readdir(join(profile, 'snapshots', SESSION, 'manifests'))).toHaveLength(1)
    },
    15_000,
  )

  it('05 验收 31: warming, tree, file-only and unavailable answer their actual state', async () => {
    const release = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const notices = vi.fn<(id: string, state: string) => void>()
    const controller = make({
      platform: 'linux',
      onDegraded: notices,
      process: injectedProcess((spec, signal) => {
        if (spec.argv.includes('--version')) {
          reached.resolve()
          return Promise.race([release.promise, untilAborted(signal)]).then(() =>
            realProcess.spawn(spec, signal),
          )
        }
        return null
      }),
    })
    await writeFile(join(workspace, 'a'), 'a')
    await controller.setWorkspace(SESSION, [workspace])
    try {
      await reached.promise
      expect(controller.status(SESSION)).toBe('warming')
    } finally {
      release.resolve()
    }
    await controller.settled(SESSION)
    expectState(controller, 'tree')
    await controller.setWorkspace(SESSION, [home])
    await controller.settled(SESSION)
    expect(controller.status(SESSION)).toBe('file-only')
    await writeFile(join(home, 'a'), 'a')
    vi.mocked(nativeFs.writeFile).mockImplementation(async (...args) => {
      if (String(args[0]).includes('/files/'))
        throw Object.assign(new Error('ENOSPC: full disk'), { code: 'ENOSPC' })
      return actualFs.writeFile(...args)
    })
    expect(
      await controller.take(
        { ...request(join(home, 'a')), folders: [home] },
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, reason: 'disk' })
    expect(controller.status(SESSION)).toBe('unavailable')
    expect(controller.lastDegradeReason(SESSION)).toMatch(/ENOSPC/)
    expect(notices.mock.calls.map((call) => call[1])).toEqual(['file-only', 'unavailable'])
  }, 15_000)

  it('05 验收 4、25: coverage is read-only, bounded, and rejects hardlinks, git metadata and outside paths', async () => {
    const controller = await fileOnly({ limits: { coverageMs: 10 } })
    await writeFile(join(workspace, 'a'), 'a')
    await link(join(workspace, 'a'), join(workspace, 'b'))
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, '.git', 'config'), 'git data')
    const paths = [join(workspace, 'a'), join(workspace, '.git', 'config'), join(root, 'outside')]
    expect(
      await Promise.all(
        paths.map((path) => controller.coverage({ sessionId: SESSION, path: absolutePath(path) })),
      ),
    ).toEqual(['none', 'none', 'none'])
    const stalled = Promise.withResolvers<void>()
    Object.defineProperty(controller, 'ready', { value: stalled.promise })
    try {
      expect(
        await controller.coverage({
          sessionId: SESSION,
          path: absolutePath(join(workspace, 'new')),
        }),
      ).toBe('none')
    } finally {
      stalled.resolve()
    }
    expect(
      await controller.coverage({ sessionId: SESSION, path: absolutePath(join(workspace, 'new')) }),
    ).toBe('file')
  })

  it.skipIf(process.platform === 'win32')(
    '05 验收 7: a workspace that is itself a git worktree snapshots normally',
    async () => {
      const original = join(root, 'original')
      await mkdir(original)
      await git(['init', '--initial-branch=main', original])
      await writeFile(join(original, 'a'), 'worktree bytes')
      await git(['add', '--all'], original)
      await git(['commit', '-m', 'fixture'], original)
      await git(['worktree', 'add', '--detach', workspace], original)
      await warm()
      const data = await manifest(await snapshots.take(request(), new AbortController().signal))
      expect(data.trees[0]!.entries.map((entry) => entry.path)).toEqual([join(workspace, 'a')])
    },
    15_000,
  )

  it('05 验收 46: file copies record missing files and link text without following targets', async () => {
    const controller = await fileOnly()
    await symlink('/does/not/exist', join(workspace, 'link'))
    const missing = await manifest(
      await controller.take(request(join(workspace, 'new')), new AbortController().signal),
    )
    expect(missing.files).toEqual([{ path: join(workspace, 'new'), identity: null }])
    const linked = await manifest(
      await controller.take(request(join(workspace, 'link')), new AbortController().signal),
    )
    expect(linked.files[0]).toMatchObject({ link: '/does/not/exist', identity: { kind: 'link' } })
    expect(await readdir(join(profile, 'snapshots', SESSION, 'files'))).toEqual([])
  })
})

// A genuinely different owner needs chown privileges. No sudo or real user folders are used.
it.skipIf(process.platform === 'win32' || process.getuid?.() !== 0)(
  '05 验收 5: safe.directory permits a workspace owned by a different uid (requires root)',
  async () => {
    await writeFile(join(workspace, 'a'), 'owned fixture')
    await chown(workspace, 65534, 65534)
    expect((await lstat(workspace)).uid).not.toBe(process.getuid?.())
    await warm()
    expectState(snapshots, 'tree')
    expect(await snapshots.take(request(), new AbortController().signal)).toMatchObject({
      ok: true,
      scope: 'tree',
    })
    expect(
      spawned
        .filter((spec) => spec.argv.some((arg) => arg.startsWith('--git-dir=')))
        .every((spec) => spec.argv.includes(`safe.directory=${workspace}`)),
    ).toBe(true)
  },
  15_000,
)

// The optional path must be a disposable, writable case-sensitive volume on macOS.
// The usual fixture stays on the profile volume; no disk images are mounted by this suite.
it.skipIf(process.platform !== 'darwin' || !process.env['TENON_SNAPSHOT_CASE_SENSITIVE_VOLUME'])(
  '05 验收 44: Makefile and makefile remain distinct across profile and workspace volumes',
  async () => {
    const other = absolutePath(
      await mkdtemp(join(process.env['TENON_SNAPSHOT_CASE_SENSITIVE_VOLUME']!, 'tenon-case-')),
    )
    try {
      const workspaceTraits = await probeVolume(other, new AbortController().signal)
      const profileTraits = await probeVolume(profile, new AbortController().signal)
      expect(workspaceTraits.ignorecase).toBe(false)
      expect(profileTraits.ignorecase).toBe(true)
      await writeFile(join(other, 'Makefile'), 'upper')
      await writeFile(join(other, 'makefile'), 'lower')
      await warm(snapshots, other)
      const data = await manifest(
        await snapshots.take({ ...request(), folders: [other] }, new AbortController().signal),
      )
      const repo = repoPath(join(profile, 'snapshots', SESSION), other)
      expect(await git([`--git-dir=${repo}`, 'show', `${data.trees[0]!.commit}:Makefile`])).toBe(
        'upper',
      )
      expect(await git([`--git-dir=${repo}`, 'show', `${data.trees[0]!.commit}:makefile`])).toBe(
        'lower',
      )
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  },
  15_000,
)

describe.skipIf(process.platform === 'win32' || process.env['TENON_SNAPSHOT_SLOW'] !== '1')(
  '05 slow snapshots (opt in with TENON_SNAPSHOT_SLOW=1)',
  () => {
    it('05 验收 10: a real ten-thousand-file listing stops at the injected count budget', async () => {
      for (let batch = 0; batch < 21; batch++) {
        const start = batch * 500
        // oxlint-disable-next-line no-await-in-loop -- bounded batches keep the filesystem queue under control
        await Promise.all(
          Array.from({ length: Math.min(500, 10_001 - start) }, (_, offset) =>
            writeFile(join(workspace, `file-${start + offset}`), 'x'),
          ),
        )
      }
      const controller = make({ limits: { files: 10_000 } })
      await warm(controller)
      expect(controller.status(SESSION)).toBe('file-only')
      expect(controller.lastDegradeReason(SESSION)).toMatch(/file-count budget/)
    }, 120_000)
  },
)

// Review regressions: deterministic interleavings still use real disk and git on success.
describe('05 publication and recovery regressions', () => {
  it('05 验收 45、46: a concurrent copy never reuses a partially written CAS file', async () => {
    const controller = await fileOnly()
    const bytes = randomBytes(24_000)
    await writeFile(join(workspace, 'a'), bytes)
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let firstWrite = true
    vi.mocked(nativeFs.writeFile).mockImplementation(async (...args) => {
      if (firstWrite && String(args[0]).includes('/files/')) {
        firstWrite = false
        await actualFs.writeFile(args[0], bytes.subarray(0, 100), { flag: 'wx' })
        reached.resolve()
        await release.promise
        throw Object.assign(new Error('injected partial CAS write'), { code: 'ENOSPC' })
      }
      return actualFs.writeFile(...args)
    })
    const first = controller.take(request(join(workspace, 'a')), new AbortController().signal)
    try {
      await reached.promise
      const second = await manifest(
        await controller.take(request(join(workspace, 'a')), new AbortController().signal),
      )
      expect(await copy(second.files[0]!)).toEqual(bytes)
    } finally {
      release.resolve()
      await first
    }
  })

  it.skipIf(process.platform === 'win32')(
    '05 验收 10、45: a warming leaf call stays a leaf copy after the first tree finishes',
    async () => {
      const entered = Promise.withResolvers<void>()
      const releaseWarm = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      const releaseLeaf = Promise.withResolvers<void>()
      const controller = make({
        process: {
          spawn: async (spec, signal) => {
            if (spec.argv.includes('--version')) {
              entered.resolve()
              await releaseWarm.promise
            }
            return tracking.spawn(spec, signal)
          },
        },
      })
      const path = join(workspace, 'a')
      await writeFile(path, 'a')
      await controller.setWorkspace(SESSION, [workspace])
      await entered.promise
      let pause = true
      vi.mocked(nativeFs.lstat).mockImplementation(async (...args) => {
        if (pause && String(args[0]) === path) {
          pause = false
          held.resolve()
          await releaseLeaf.promise
        }
        return actualFs.lstat(...args)
      })
      const leaf = controller.take(request(path), new AbortController().signal)
      try {
        await held.promise
        releaseWarm.resolve()
        await controller.settled(SESSION)
      } finally {
        releaseWarm.resolve()
        releaseLeaf.resolve()
      }
      expect(await leaf).toMatchObject({ ok: true, scope: 'file' })
    },
    15_000,
  )

  it.skipIf(process.platform === 'win32')(
    '05 验收 45: restart removes a repository whose first ref has no published manifest',
    async () => {
      await writeFile(join(workspace, 'a'), randomBytes(16_000))
      await warm()
      const dir = join(profile, 'snapshots', SESSION)
      const repo = repoPath(dir, workspace)
      await rm(join(dir, 'manifests'), { recursive: true })
      const reopened = make()
      await reopened.ready
      expect(reopened.lastDegradeReason(SESSION)).toBeNull()
      await expect(lstat(repo)).rejects.toMatchObject({ code: 'ENOENT' })
    },
    15_000,
  )

  it.skipIf(process.platform === 'win32')(
    '05 验收 14、45: a failed capture resets the index before reclaiming unpublished blobs',
    async () => {
      let fail = false
      const controller = make({
        process: {
          spawn: (spec, signal) => {
            if (fail && spec.argv.includes('write-tree')) {
              fail = false
              throw new Error('injected failure after staging')
            }
            return tracking.spawn(spec, signal)
          },
        },
      })
      await writeFile(join(workspace, 'a'), 'old')
      await warm(controller)
      const repo = repoPath(join(profile, 'snapshots', SESSION), workspace)
      await writeFile(join(workspace, 'b'), randomBytes(16_000))
      const hash = (await git(['hash-object', join(workspace, 'b')])).trim()
      fail = true
      expect(await controller.take(request(), new AbortController().signal)).toMatchObject({
        ok: false,
      })
      await expect(git([`--git-dir=${repo}`, 'cat-file', '-e', hash])).rejects.toThrow(
        /subprocess failed/,
      )
      expect(await git([`--git-dir=${repo}`, 'ls-files'])).toBe('a\n')
    },
    15_000,
  )

  it.skipIf(process.platform === 'win32')(
    '05 验收 12: an existing volume-root workspace keeps copies without a shadow repository',
    async () => {
      vi.mocked(nativeFs.lstat).mockImplementation(async (...args) => {
        const stat = await actualFs.lstat(...args)
        if (String(args[0]) === workspace)
          stat.dev = typeof stat.dev === 'bigint' ? stat.dev + 1n : stat.dev + 1
        return stat
      })
      await writeFile(join(workspace, 'a'), 'a')
      await warm()
      expectState(snapshots, 'file-only')
      expect(await readdir(join(profile, 'snapshots', SESSION, 'repos'))).toEqual([])
      expect(
        await snapshots.take(request(join(workspace, 'a')), new AbortController().signal),
      ).toMatchObject({ ok: true, scope: 'file' })
    },
  )

  it.skipIf(process.platform === 'win32')(
    '05 验收 31: git storage exhaustion reports unavailable once through the subprocess error path',
    async () => {
      const notices: string[] = []
      let fail = false
      const controller = make({
        onDegraded: (_id, state) => notices.push(state),
        process: {
          spawn: (spec, signal) =>
            tracking.spawn(
              fail && spec.argv.includes('add')
                ? {
                    ...spec,
                    argv: [
                      '/bin/sh',
                      '-c',
                      'echo "fatal: unable to write object: No space left on device" >&2; exit 128',
                    ],
                  }
                : spec,
              signal,
            ),
        },
      })
      await writeFile(join(workspace, 'a'), 'old')
      await warm(controller)
      fail = true
      await writeFile(join(workspace, 'a'), 'new')
      expect(
        await controller.take(request(join(workspace, 'a')), new AbortController().signal),
      ).toEqual({ ok: false, reason: 'disk' })
      expect(controller.status(SESSION)).toBe('unavailable')
      expect(
        await controller.take(request(join(workspace, 'a')), new AbortController().signal),
      ).toEqual({ ok: false, reason: 'disk' })
      expect(notices).toEqual(['unavailable'])
    },
    15_000,
  )
})

it.skipIf(process.platform === 'win32')(
  '05 验收 31: a completed first tree cannot undo a disk-full degradation from a concurrent copy',
  async () => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const notices: string[] = []
    const controller = make({
      onDegraded: (_id, state) => notices.push(state),
      process: {
        spawn: async (spec, signal) => {
          if (spec.argv.includes('--version')) {
            reached.resolve()
            await release.promise
          }
          return tracking.spawn(spec, signal)
        },
      },
    })
    await writeFile(join(workspace, 'a'), 'a')
    await controller.setWorkspace(SESSION, [workspace])
    try {
      await reached.promise
      vi.mocked(nativeFs.writeFile).mockImplementation(async (...args) => {
        if (String(args[0]).includes('/files/'))
          throw Object.assign(new Error('injected full profile volume'), { code: 'ENOSPC' })
        return actualFs.writeFile(...args)
      })
      expect(
        await controller.take(request(join(workspace, 'a')), new AbortController().signal),
      ).toEqual({ ok: false, reason: 'disk' })
    } finally {
      release.resolve()
    }
    await controller.settled(SESSION)
    expect(controller.status(SESSION)).toBe('unavailable')
    expect(notices).toEqual(['unavailable'])
  },
  15_000,
)

it.skipIf(process.platform === 'win32')(
  '05 验收 45: a workspace warmup waits for an already running repository reclaim',
  async () => {
    const time = manualClock()
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let pause = false
    let collecting = false
    let collision = false
    const controller = make({
      clock: time.clock,
      limits: { ageMs: 100 },
      process: {
        spawn: async (spec, signal) => {
          if (pause && spec.argv.includes('for-each-ref')) {
            pause = false
            collecting = true
            reached.resolve()
            await release.promise
            collecting = false
          }
          if (collecting && spec.argv.includes('read-tree')) collision = true
          return tracking.spawn(spec, signal)
        },
      },
    })
    await writeFile(join(workspace, 'a'), 'a')
    await warm(controller)
    const other = absolutePath(join(root, 'other'))
    await mkdir(other)
    time.advance(101)
    pause = true
    const cleanup = controller.alive(SESSION, [])
    try {
      await reached.promise
      await controller.setWorkspace(SESSION, [workspace, other])
      // Let filesystem discovery finish while the old GC is deliberately held.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(collision).toBe(false)
    } finally {
      release.resolve()
      await cleanup
      await controller.settled(SESSION)
    }
    expectState(controller, 'tree')
    const repo = repoPath(join(profile, 'snapshots', SESSION), workspace)
    await git([`--git-dir=${repo}`, 'fsck', '--no-reflogs'])
  },
  15_000,
)

it.skipIf(process.platform === 'win32')(
  '05 验收 8、10: files excluded for size do not spend the eligible file-count budget',
  async () => {
    await writeFile(join(workspace, 'a'), 'a')
    const handle = await open(join(workspace, 'large'), 'w')
    try {
      await handle.truncate(MAX_FILE_BYTES + 1)
    } finally {
      await handle.close()
    }
    const controller = make({ limits: { files: 1 } })
    await warm(controller)
    expectState(controller, 'tree')
    const data = await manifest(await controller.take(request(), new AbortController().signal))
    expect(data.trees[0]!.entries.map((entry) => entry.path)).toEqual([join(workspace, 'a')])
    expect(data.skipped).toBe(1)
  },
  15_000,
)
