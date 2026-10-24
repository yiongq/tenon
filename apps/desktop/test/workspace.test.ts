/**
 * The workspace routes and the profile choice (spec 02 §工作区「路由」, §会话形态「建立前暂存」; plan
 * step 18, 旧 182): folders come only from main's dialog or the prefill it reads itself, the prefill
 * is written only after the kernel accepted a change, and the three refusals leave list and facts
 * as they were.
 */
import type { IpcMainLike } from '@tenon-app/contracts'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createSessionService,
} from '@tenon-app/kernel'
import type { MemoryHost, SessionService } from '@tenon-app/kernel'
import { createCounterIds, createTestLoopPorts } from '@tenon-app/kernel/testing'
import { describe, expect, it } from 'vitest'
import type { WorkspaceRoutesDeps } from '../src/main/workspace.js'
import { readConfig, writeConfig } from '../src/main/host/profile.js'
import {
  dedicatedFolderFor,
  protectedShellFiles,
  registerWorkspaceRoutes,
} from '../src/main/workspace.js'

const SESSION = '3a1d9a2e-6b3d-4a71-9f52-0c8de7a11b61'
const HOME = absolutePath('/Users/someone')
const IDENTITY = { userId: 'local', tenantId: 'personal', profileDir: '/Users/someone/profile' }

type Handler = (event: unknown, payload: unknown) => unknown

interface Harness {
  readonly host: MemoryHost
  readonly sessions: SessionService
  readonly picks: Array<readonly string[] | null>
  call(channel: string, payload: unknown): Promise<unknown>
}

async function harness(
  options: Pick<WorkspaceRoutesDeps, 'onWorkspaceChanged' | 'log'> = {},
): Promise<Harness> {
  const host = createMemoryHost({ identity: IDENTITY })
  await host.fs.mkdirp(absolutePath(IDENTITY.profileDir))
  await Promise.all(['/work/a', '/work/b'].map((folder) => host.fs.mkdirp(absolutePath(folder))))
  const loop = createTestLoopPorts({
    commandShell: { path: absolutePath('/bin/sh'), env: async () => ({ HOME }) },
  })
  const sessions = createSessionService({
    host,
    tape: createMemoryTapeStore({ identity: IDENTITY }),
    ids: createCounterIds(),
    inspectors: [],
    connector: loop.connector,
    protectedFiles: [],
  })
  sessions.bindLoop(loop)
  const handlers = new Map<string, Handler>()
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener as Handler)
    },
  }
  const picks: Array<readonly string[] | null> = []
  registerWorkspaceRoutes({
    ipcMain,
    sessions,
    host,
    home: HOME,
    pickFolders: () => Promise.resolve(picks.shift() ?? null),
    ...options,
  })
  return {
    host,
    sessions,
    picks,
    async call(channel, payload) {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`no handler for ${channel}`)
      return handler({}, payload)
    },
  }
}

const DEDICATED = dedicatedFolderFor(HOME, IDENTITY, SESSION)

describe('the dedicated folder and the protected shell files', () => {
  it('names one folder per session under the home, outside the profile, tenant-scoped', () => {
    expect(DEDICATED).toBe(`/Users/someone/Tenon/workspaces/local/personal/${SESSION}`)
    expect(protectedShellFiles(HOME)).toEqual([
      '/Users/someone/.zshrc',
      '/Users/someone/.zshenv',
      '/Users/someone/.zprofile',
      '/Users/someone/.bashrc',
      '/Users/someone/.bash_profile',
      '/Users/someone/.profile',
    ])
  })
})

describe('workspace routes (旧 182)', () => {
  it('takes only a session id: any other field fails to parse', async () => {
    const h = await harness()
    for (const channel of ['workspace.pick', 'workspace.usePrefill']) {
      // oxlint-disable-next-line no-await-in-loop -- one route at a time
      expect(await h.call(channel, { sessionId: SESSION, folder: '/etc' })).toMatchObject({
        ok: false,
        error: { code: 'invalid-request' },
      })
    }
    expect(
      await h.call('workspace.remove', { sessionId: SESSION, folder: '/work/a', folders: [] }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('answers unknown-session and not-cowork, a draft chat included, before any dialog', async () => {
    const h = await harness()
    h.picks.push(['/work/a'])
    expect(await h.call('workspace.pick', { sessionId: SESSION })).toEqual({
      ok: true,
      data: { ok: false, code: 'unknown-session' },
    })
    await h.call('session.selectProfile', { sessionId: SESSION, profile: 'chat' })
    expect(await h.call('workspace.pick', { sessionId: SESSION })).toEqual({
      ok: true,
      data: { ok: false, code: 'not-cowork' },
    })
    // The dialog never opened.
    expect(h.picks).toHaveLength(1)
  })

  it('picks folders into the list, writes the prefill after the kernel said yes, keeps it on the way back to the dedicated folder', async () => {
    const h = await harness()
    expect(
      await h.call('session.selectProfile', { sessionId: SESSION, profile: 'cowork' }),
    ).toEqual({
      ok: true,
      data: {
        ok: true,
        established: false,
        profile: 'cowork',
        workspace: { folders: [DEDICATED], origin: 'dedicated' },
      },
    })
    // A cancelled dialog: the list as it was, nothing written.
    h.picks.push(null)
    expect(await h.call('workspace.pick', { sessionId: SESSION })).toEqual({
      ok: true,
      data: { ok: true, folders: [DEDICATED], origin: 'dedicated' },
    })
    expect((await readConfig(h.host.fs, h.host.identity)).lastWorkspaceFolders).toEqual([])
    h.picks.push(['/work/a', '/work/b'])
    expect(await h.call('workspace.pick', { sessionId: SESSION })).toEqual({
      ok: true,
      data: { ok: true, folders: ['/work/a', '/work/b'], origin: 'picked' },
    })
    expect((await readConfig(h.host.fs, h.host.identity)).lastWorkspaceFolders).toEqual([
      '/work/a',
      '/work/b',
    ])
    // Not in the list: refused, nothing changes.
    expect(await h.call('workspace.remove', { sessionId: SESSION, folder: '/work/c' })).toEqual({
      ok: true,
      data: { ok: false, code: 'not-in-list' },
    })
    await h.call('workspace.remove', { sessionId: SESSION, folder: '/work/a' })
    expect((await readConfig(h.host.fs, h.host.identity)).lastWorkspaceFolders).toEqual(['/work/b'])
    expect(await h.call('workspace.remove', { sessionId: SESSION, folder: '/work/b' })).toEqual({
      ok: true,
      data: { ok: true, folders: [DEDICATED], origin: 'dedicated' },
    })
    // Back to the dedicated folder: the prefill keeps the last picked list.
    expect((await readConfig(h.host.fs, h.host.identity)).lastWorkspaceFolders).toEqual(['/work/b'])
  })

  it('drops a dialog answer that is not an absolute path, and reads one with none left as a cancel', async () => {
    const h = await harness()
    await h.call('session.selectProfile', { sessionId: SESSION, profile: 'cowork' })
    h.picks.push(['relative/dir'])
    expect(await h.call('workspace.pick', { sessionId: SESSION })).toEqual({
      ok: true,
      data: { ok: true, folders: [DEDICATED], origin: 'dedicated' },
    })
    expect((await readConfig(h.host.fs, h.host.identity)).lastWorkspaceFolders).toEqual([])
    h.picks.push(['relative/dir', '/work/a'])
    expect(await h.call('workspace.pick', { sessionId: SESSION })).toEqual({
      ok: true,
      data: { ok: true, folders: ['/work/a'], origin: 'picked' },
    })
  })

  it('names the session’s own choice as `chosen`, and only when it has one (rrE-1)', async () => {
    // The model menu does not ask again for the host that choice confirmed (§模型选择「数据去向」).
    const h = await harness()
    const facts = async (): Promise<unknown> =>
      ((await h.call('session.facts', { sessionId: SESSION })) as { data: unknown }).data
    expect(await facts()).not.toHaveProperty('chosen')
    await h.sessions.selectModel({
      sessionId: SESSION,
      choice: { providerId: 'zhipu', modelId: 'glm-5.3-flash', effort: null },
      origin: null,
    })
    expect(await facts()).toMatchObject({ chosen: { providerId: 'zhipu' } })
  })

  it('takes the prefill only when asked: until then the workspace is the dedicated folder', async () => {
    const h = await harness()
    await writeConfig(h.host.fs, h.host.identity, { lastWorkspaceFolders: ['/work/a'] })
    await h.call('session.selectProfile', { sessionId: SESSION, profile: 'cowork' })
    expect(await h.call('session.facts', { sessionId: SESSION })).toEqual({
      ok: true,
      data: {
        established: false,
        profile: 'cowork',
        workspace: { folders: [DEDICATED], origin: 'dedicated' },
      },
    })
    expect(await h.call('workspace.usePrefill', { sessionId: SESSION })).toEqual({
      ok: true,
      data: { ok: true, folders: ['/work/a'], origin: 'picked' },
    })
  })
})

it('05 验收 10: failed snapshot notifications cannot change accepted profile or workspace results', async () => {
  const logs: string[] = []
  const h = await harness({
    onWorkspaceChanged: async () => {
      throw new Error('snapshot recovery failed')
    },
    log: (line) => logs.push(line),
  })
  expect(
    await h.call('session.selectProfile', { sessionId: SESSION, profile: 'cowork' }),
  ).toMatchObject({ data: { ok: true } })
  h.picks.push(['/work/a'])
  expect(await h.call('workspace.pick', { sessionId: SESSION })).toMatchObject({
    data: { ok: true, folders: ['/work/a'] },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(logs).toHaveLength(2)
  expect(logs.every((line) => line.includes('snapshot recovery failed'))).toBe(true)
})

it('05 验收 10: accepted workspace selection does not wait for a pending snapshot notification', async () => {
  const release = Promise.withResolvers<void>()
  let hold = false
  const h = await harness({
    onWorkspaceChanged: async () => {
      if (hold) await release.promise
    },
  })
  await h.call('session.selectProfile', { sessionId: SESSION, profile: 'cowork' })
  hold = true
  h.picks.push(['/work/a'])
  const change = h.call('workspace.pick', { sessionId: SESSION })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      change,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('blocked'), 100)
      }),
    ])
    expect(result).toMatchObject({ data: { ok: true, folders: ['/work/a'] } })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    release.resolve()
    await change
  }
})

it('05 验收 13: pick and prefill share root refusal and preserve the accepted list', async () => {
  const h = await harness()
  await h.call('session.selectProfile', { sessionId: SESSION, profile: 'cowork' })
  h.picks.push(['/'])
  expect(await h.call('workspace.pick', { sessionId: SESSION })).toEqual({
    ok: true,
    data: { ok: false, code: 'root-folder' },
  })
  await writeConfig(h.host.fs, IDENTITY, { lastWorkspaceFolders: ['/'] })
  expect(await h.call('workspace.usePrefill', { sessionId: SESSION })).toEqual({
    ok: true,
    data: { ok: false, code: 'root-folder' },
  })
  expect((await h.sessions.sessionFacts({ sessionId: SESSION })).workspace?.folders).toEqual([
    DEDICATED,
  ])
})

it('05 验收 13: the route contract carries the home warning without a renderer change', async () => {
  const h = await harness()
  await h.call('session.selectProfile', { sessionId: SESSION, profile: 'cowork' })
  h.picks.push([HOME])
  expect(await h.call('workspace.pick', { sessionId: SESSION })).toMatchObject({
    data: { ok: true, warning: 'home', folders: [HOME] },
  })
})

it.each(['root', 'volume'] as const)(
  '05 验收 13: the profile route returns handler-failed for a dedicated %s alias and keeps the workspace',
  async (kind) => {
    const h = await harness()
    await h.call('session.selectProfile', { sessionId: SESSION, profile: 'chat' })
    const before = await h.sessions.sessionFacts({ sessionId: SESSION })
    await h.host.fs.mkdirp(absolutePath(DEDICATED.slice(0, DEDICATED.lastIndexOf('/'))))
    await h.host.fs.mkdirp(absolutePath('/mounted'))
    const identity = h.host.fs.identity.bind(h.host.fs)
    h.host.fs.identity = async (path) => {
      const stamp = await identity(path)
      return path === '/mounted' && stamp !== null ? { ...stamp, dev: stamp.dev + 1n } : stamp
    }
    h.host.symlink(DEDICATED, kind === 'root' ? '/' : '/mounted')
    expect(
      await h.call('session.selectProfile', { sessionId: SESSION, profile: 'cowork' }),
    ).toMatchObject({ ok: false, error: { code: 'handler-failed' } })
    expect(await h.sessions.sessionFacts({ sessionId: SESSION })).toEqual(before)
  },
)

it('05 验收 13: removing the final picked folder returns handler-failed for a root alias without changing the workspace', async () => {
  const h = await harness()
  await h.call('session.selectProfile', { sessionId: SESSION, profile: 'cowork' })
  h.picks.push(['/work/a'])
  await h.call('workspace.pick', { sessionId: SESSION })
  const before = await h.sessions.sessionFacts({ sessionId: SESSION })
  const dedicated = dedicatedFolderFor(HOME, IDENTITY, SESSION)
  await h.host.fs.mkdirp(absolutePath(dedicated.slice(0, dedicated.lastIndexOf('/'))))
  h.host.symlink(dedicated, '/')
  expect(await h.call('workspace.remove', { sessionId: SESSION, folder: '/work/a' })).toMatchObject(
    { ok: false, error: { code: 'handler-failed' } },
  )
  expect(await h.sessions.sessionFacts({ sessionId: SESSION })).toEqual(before)
})

it('05 验收 13: remove keeps its original response shape while pick/prefill accept the new outcomes', async () => {
  const { workspaceRemove, workspacePick, workspaceUsePrefill } =
    await import('@tenon-app/contracts')
  expect(workspaceRemove.response.safeParse({ ok: false, code: 'root-folder' }).success).toBe(false)
  const success = { ok: true, folders: [HOME], origin: 'picked', warning: 'home' }
  expect(workspaceRemove.response.parse(success)).not.toHaveProperty('warning')
  for (const route of [workspacePick, workspaceUsePrefill]) {
    expect(route.response.parse(success)).toHaveProperty('warning', 'home')
    expect(route.response.safeParse({ ok: false, code: 'root-folder' }).success).toBe(true)
  }
})
