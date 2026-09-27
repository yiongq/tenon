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

async function harness(): Promise<Harness> {
  const host = createMemoryHost({ identity: IDENTITY })
  await host.fs.mkdirp(absolutePath(IDENTITY.profileDir))
  await Promise.all(['/work/a', '/work/b'].map((folder) => host.fs.mkdirp(absolutePath(folder))))
  const loop = createTestLoopPorts({})
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
