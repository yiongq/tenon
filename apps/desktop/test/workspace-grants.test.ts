/**
 * Folder grants (spec 06 §界面「文件夹授权」, §接口; 验收 36, D42): a pick or the prefill that names a
 * folder never 「以后都允许」ed adds nothing and answers `pendingGrant`; main keeps the paths under a
 * token that is bound to the session, used once and voided by a new pick, a clear or a restart;
 * `workspace.grant` adds them, and 「以后都允许」 keeps their real paths in `config.json`.
 */
import type { IpcMainLike } from '@tenon-app/contracts'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createSessionService,
} from '@tenon-app/kernel'
import { createCounterIds, createTestLoopPorts } from '@tenon-app/kernel/testing'
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DesktopFs } from '../src/main/host/fs.js'
import { createFolderGrants } from '../src/main/folder-grants.js'
import { readConfig, writeConfig } from '../src/main/host/profile.js'
import { createSessionRemoval } from '../src/main/session-removal.js'
import { dedicatedFolderFor, registerWorkspaceRoutes } from '../src/main/workspace.js'

const HOME = absolutePath('/Users/someone')
const IDENTITY = { userId: 'local', tenantId: 'personal', profileDir: '/Users/someone/profile' }
const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const S3 = '33333333-3333-4333-8333-333333333333'
const S4 = '44444444-4444-4444-8444-444444444444'

type Handler = (event: unknown, payload: unknown) => unknown
type Call = (channel: string, payload: unknown) => Promise<unknown>

interface PendingAnswer {
  readonly ok: true
  readonly data: {
    readonly ok: true
    readonly folders: string[]
    readonly pendingGrant?: { token: string; folders: string[] }
  }
}

/** A task session in draft: the profile a folder can be picked for. */
async function task(call: Call, sessionId: string): Promise<void> {
  await call('session.selectProfile', { sessionId, profile: 'cowork' })
}

async function rig() {
  const host = createMemoryHost({ identity: IDENTITY })
  await host.fs.mkdirp(absolutePath(IDENTITY.profileDir))
  for (const folder of ['/work/a', '/work/b', '/work/c']) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of folders
    await host.fs.mkdirp(absolutePath(folder))
  }
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
  const picks: Array<readonly string[] | null> = []
  /** A fresh set of routes on the same profile: what a restart does to main's memory. */
  const register = (grants = createFolderGrants()): Call => {
    const handlers = new Map<string, Handler>()
    const ipcMain: IpcMainLike = {
      handle(channel, listener) {
        handlers.set(channel, listener as Handler)
      },
    }
    registerWorkspaceRoutes({
      ipcMain,
      sessions,
      host,
      home: HOME,
      pickFolders: () => Promise.resolve(picks.shift() ?? null),
      grants,
    })
    return async (channel, payload) => {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`no handler for ${channel}`)
      return handler({}, payload)
    }
  }
  const call = register()
  const pick = (call_: Call, sessionId: string, folders: readonly string[] | null) => {
    picks.push(folders)
    return call_('workspace.pick', { sessionId })
  }
  const folders = async (sessionId: string): Promise<readonly string[]> =>
    (await sessions.sessionFacts({ sessionId })).workspace?.folders ?? []
  const config = () => readConfig(host.fs, host.identity)
  return { host, sessions, call, register, pick, folders, config }
}

const asked = (answer: unknown): { token: string; folders: string[] } => {
  const pending = (answer as PendingAnswer).data.pendingGrant
  if (pending === undefined) throw new Error('no pendingGrant in the answer')
  return pending
}
const STALE = { ok: true, data: { ok: false, code: 'stale' } }

it('06 验收 36: folder grants ask once, persist on always, and revoke for later picks', async () => {
  const r = await rig()
  await task(r.call, S1)
  const dedicated = dedicatedFolderFor(HOME, IDENTITY, S1)

  // An ungranted folder: nothing is added, and main answers the list as it was with the grant.
  const first = await r.pick(r.call, S1, ['/work/a'])
  expect(first).toEqual({
    ok: true,
    data: {
      ok: true,
      folders: [dedicated],
      origin: 'dedicated',
      pendingGrant: { token: expect.any(String), folders: ['/work/a'] },
    },
  })
  expect(await r.folders(S1)).toEqual([dedicated])
  expect((await r.config()).lastWorkspaceFolders).toEqual([])

  // 「允许」: this session only, and nothing kept.
  expect(
    await r.call('workspace.grant', {
      sessionId: S1,
      token: asked(first).token,
      choice: 'session',
    }),
  ).toEqual({ ok: true, data: { ok: true, folders: ['/work/a'], origin: 'picked' } })
  expect(await r.folders(S1)).toEqual(['/work/a'])
  expect((await r.config()).folderAccess).toEqual([])
  expect((await r.config()).lastWorkspaceFolders).toEqual(['/work/a'])
  // The token was used: the second try adds nothing.
  expect(
    await r.call('workspace.grant', { sessionId: S1, token: asked(first).token, choice: 'always' }),
  ).toEqual(STALE)
  expect((await r.config()).folderAccess).toEqual([])

  // Only the session was allowed, so the next pick asks again; 「以后都允许」 keeps the real path.
  await task(r.call, S2)
  const second = await r.pick(r.call, S2, ['/work/a'])
  expect(asked(second).folders).toEqual(['/work/a'])
  expect(await r.folders(S2)).toEqual([dedicatedFolderFor(HOME, IDENTITY, S2)])
  expect(
    await r.call('workspace.grant', {
      sessionId: S2,
      token: asked(second).token,
      choice: 'always',
    }),
  ).toEqual({ ok: true, data: { ok: true, folders: ['/work/a'], origin: 'picked' } })
  expect((await r.config()).folderAccess).toEqual(['/work/a'])

  // Main's memory gone and config.json read back: the pick adds directly, with no grant to answer,
  // and a new session did not get the folder by itself.
  const restarted = r.register()
  await task(restarted, S3)
  expect(await r.folders(S3)).toEqual([dedicatedFolderFor(HOME, IDENTITY, S3)])
  const direct = await r.pick(restarted, S3, ['/work/a'])
  expect(direct).toEqual({ ok: true, data: { ok: true, folders: ['/work/a'], origin: 'picked' } })
  expect(await r.folders(S3)).toEqual(['/work/a'])

  // Settings lists the kept paths and revokes one: the next pick asks again, the session that has it
  // keeps it.
  expect(await restarted('workspace.access', {})).toEqual({
    ok: true,
    data: { folders: ['/work/a'] },
  })
  expect(await restarted('workspace.revokeAccess', { folder: '/work/a' })).toEqual({
    ok: true,
    data: { folders: [] },
  })
  expect((await r.config()).folderAccess).toEqual([])
  expect(await r.folders(S3)).toEqual(['/work/a'])
  await task(restarted, S4)
  expect(asked(await r.pick(restarted, S4, ['/work/a'])).folders).toEqual(['/work/a'])
  expect(await r.folders(S4)).toEqual([dedicatedFolderFor(HOME, IDENTITY, S4)])
})

it("06 验收 36: another session's, a voided and an unknown token each answer stale and add nothing", async () => {
  const r = await rig()
  await task(r.call, S1)
  await task(r.call, S2)
  const dedicated1 = dedicatedFolderFor(HOME, IDENTITY, S1)
  const dedicated2 = dedicatedFolderFor(HOME, IDENTITY, S2)
  const old = asked(await r.pick(r.call, S1, ['/work/a']))
  // A second pick voids the first token, whatever it picks; the first token adds nothing.
  const current = asked(await r.pick(r.call, S1, ['/work/b']))
  expect(current.token).not.toBe(old.token)
  expect(current.folders).toEqual(['/work/b'])
  expect(
    await r.call('workspace.grant', { sessionId: S1, token: old.token, choice: 'session' }),
  ).toEqual(STALE)
  // The session's token, brought by another session, and one nobody minted.
  for (const [sessionId, token] of [
    [S2, current.token],
    [S1, 'never-minted'],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one answer at a time
    expect(await r.call('workspace.grant', { sessionId, token, choice: 'always' })).toEqual(STALE)
  }
  expect(await r.folders(S1)).toEqual([dedicated1])
  expect(await r.folders(S2)).toEqual([dedicated2])
  expect((await r.config()).folderAccess).toEqual([])
  // A cancelled dialog still voids what the last pick left.
  expect(await r.pick(r.call, S1, null)).toEqual({
    ok: true,
    data: { ok: true, folders: [dedicated1], origin: 'dedicated' },
  })
  expect(
    await r.call('workspace.grant', { sessionId: S1, token: current.token, choice: 'session' }),
  ).toEqual(STALE)
  // A request cannot bring folders of its own: the schema takes the token and nothing else.
  const live = asked(await r.pick(r.call, S1, ['/work/c']))
  expect(
    await r.call('workspace.grant', {
      sessionId: S1,
      token: live.token,
      choice: 'session',
      folders: ['/etc'],
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  expect(await r.folders(S1)).toEqual([dedicated1])
  // And the folders it does add are main's copy of what the dialog answered.
  expect(
    await r.call('workspace.grant', { sessionId: S1, token: live.token, choice: 'session' }),
  ).toEqual({ ok: true, data: { ok: true, folders: ['/work/c'], origin: 'picked' } })
})

it('06 验收 36: a selection with one ungranted folder asks for all of it, and always keeps only the ungranted real paths', async () => {
  const r = await rig()
  // /work/a is kept already, under its real path; the link /link reaches /work/b.
  r.host.symlink(absolutePath('/link'), '/work/b')
  await task(r.call, S1)
  const kept = asked(await r.pick(r.call, S1, ['/work/a']))
  await r.call('workspace.grant', { sessionId: S1, token: kept.token, choice: 'always' })
  expect((await r.config()).folderAccess).toEqual(['/work/a'])
  await task(r.call, S2)
  const answer = await r.pick(r.call, S2, ['/work/a', '/link', '/work/b'])
  // Nothing of it is added, though /work/a is granted: the list comes back as it was. The dialog
  // names real paths, the link as the folder it reaches, once.
  expect(await r.folders(S2)).toEqual([dedicatedFolderFor(HOME, IDENTITY, S2)])
  expect(asked(answer).folders).toEqual(['/work/a', '/work/b'])
  const added = await r.call('workspace.grant', {
    sessionId: S2,
    token: asked(answer).token,
    choice: 'always',
  })
  expect(added).toEqual({
    ok: true,
    data: { ok: true, folders: ['/work/a', '/work/b'], origin: 'picked' },
  })
  // The link and the folder it reaches are one real path, kept once; the granted one is not repeated.
  expect((await r.config()).folderAccess).toEqual(['/work/a', '/work/b'])
  // So a later pick through the link is granted by the real path.
  await task(r.call, S3)
  expect(await r.pick(r.call, S3, ['/link'])).toEqual({
    ok: true,
    data: { ok: true, folders: ['/work/b'], origin: 'picked' },
  })
})

it('06 验收 36: the prefill asks like a pick, and a clear of the session voids the grant', async () => {
  const r = await rig()
  const grants = createFolderGrants()
  const call = r.register(grants)
  await task(call, S1)
  await writeConfig(r.host.fs, r.host.identity, { lastWorkspaceFolders: ['/work/a', '/work/b'] })
  const prefilled = await call('workspace.usePrefill', { sessionId: S1 })
  expect(asked(prefilled).folders).toEqual(['/work/a', '/work/b'])
  expect(await r.folders(S1)).toEqual([dedicatedFolderFor(HOME, IDENTITY, S1)])
  // The prefill again replaces the grant it left.
  const again = await call('workspace.usePrefill', { sessionId: S1 })
  expect(
    await call('workspace.grant', {
      sessionId: S1,
      token: asked(prefilled).token,
      choice: 'session',
    }),
  ).toEqual(STALE)
  // A clear of the session starts a new incarnation; main's hook voids what was kept for the old one.
  const removal = createSessionRemoval({
    sessions: {
      resetSession: () =>
        Promise.resolve({ sessionId: S1, incarnationId: 'next', startEntryId: 1 }),
      deleteSession: () => Promise.resolve(),
    },
    runs: () => null,
    profileDir: absolutePath(IDENTITY.profileDir),
    log: () => {},
    removeFolder: () => Promise.resolve(),
    onRemoval: (sessionId) => grants.invalidate(sessionId),
  })
  await removal.clear(S1)
  expect(
    await call('workspace.grant', { sessionId: S1, token: asked(again).token, choice: 'always' }),
  ).toEqual(STALE)
  expect(await r.folders(S1)).toEqual([dedicatedFolderFor(HOME, IDENTITY, S1)])
  expect((await r.config()).folderAccess).toEqual([])
})

it('06 验收 36: a dedicated folder, a cancelled dialog and an empty prefill ask for nothing', async () => {
  const r = await rig()
  await task(r.call, S1)
  const dedicated = dedicatedFolderFor(HOME, IDENTITY, S1)
  const same = { ok: true, data: { ok: true, folders: [dedicated], origin: 'dedicated' } }
  expect(await r.pick(r.call, S1, null)).toEqual(same)
  expect(await r.call('workspace.usePrefill', { sessionId: S1 })).toEqual(same)
  // Chats and unknown sessions are refused before a dialog opens or a grant is made.
  await r.call('session.selectProfile', { sessionId: S2, profile: 'chat' })
  expect(await r.call('workspace.pick', { sessionId: S2 })).toEqual({
    ok: true,
    data: { ok: false, code: 'not-cowork' },
  })
  expect(await r.call('workspace.usePrefill', { sessionId: S3 })).toEqual({
    ok: true,
    data: { ok: false, code: 'unknown-session' },
  })
})

it('06 验收 36: a folder whose real path cannot be named is the add’s own refusal, not a grant', async () => {
  const r = await rig()
  await task(r.call, S1)
  // A link to nothing: realpath throws, so no real path can be kept for it.
  r.host.symlink(absolutePath('/dangling'), '/nowhere/at/all')
  const answer = await r.pick(r.call, S1, ['/work/a', '/dangling'])
  expect(answer).toEqual({ ok: true, data: { ok: false, code: 'root-folder' } })
  expect(await r.folders(S1)).toEqual([dedicatedFolderFor(HOME, IDENTITY, S1)])
})

it('06 验收 36: a prefill that adds directly still voids the grant a pick left', async () => {
  const r = await rig()
  await task(r.call, S1)
  const picked = await r.pick(r.call, S1, ['/work/a'])
  // The prefill names a folder already kept: it adds with no dialog of its own.
  await writeConfig(r.host.fs, r.host.identity, {
    folderAccess: ['/work/b'],
    lastWorkspaceFolders: ['/work/b'],
  })
  const prefilled = (await r.call('workspace.usePrefill', { sessionId: S1 })) as PendingAnswer
  expect(prefilled.data.pendingGrant).toBeUndefined()
  expect(await r.folders(S1)).toEqual(['/work/b'])
  // The dialog the pick opened is gone with it: its token adds nothing now.
  expect(
    await r.call('workspace.grant', {
      sessionId: S1,
      token: asked(picked).token,
      choice: 'session',
    }),
  ).toEqual(STALE)
  expect(await r.folders(S1)).toEqual(['/work/b'])
})

it('06 验收 36: the dialog keeps real paths, so a link pointed elsewhere while it is open changes nothing', async () => {
  const r = await rig()
  await r.host.fs.mkdirp(absolutePath('/secret/a'))
  r.host.symlink(absolutePath('/proj'), '/work')
  await task(r.call, S1)
  const answer = asked(await r.pick(r.call, S1, ['/proj/a']))
  // The dialog names the folder the link reaches now.
  expect(answer.folders).toEqual(['/work/a'])
  await r.host.fs.remove(absolutePath('/proj'))
  r.host.symlink(absolutePath('/proj'), '/secret')
  // The answer adds what the user saw, not the link's new target, and keeps only that.
  expect(
    await r.call('workspace.grant', { sessionId: S1, token: answer.token, choice: 'always' }),
  ).toEqual({ ok: true, data: { ok: true, folders: ['/work/a'], origin: 'picked' } })
  expect((await r.config()).folderAccess).toEqual(['/work/a'])
})

it('06 验收 36: a folder swapped for a link while the dialog is open voids the answer (real disk)', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-grant-')))
  try {
    const fs = new DesktopFs()
    const identity = { ...IDENTITY, profileDir: join(root, 'profile') }
    const host = { ...createMemoryHost({ identity }), fs }
    for (const folder of ['profile', 'work/a', 'secret'])
      // oxlint-disable-next-line no-await-in-loop -- three folders
      await mkdir(join(root, folder), { recursive: true })
    const loop = createTestLoopPorts({
      commandShell: { path: absolutePath('/bin/sh'), env: async () => ({ HOME }) },
    })
    const sessions = createSessionService({
      host,
      tape: createMemoryTapeStore({ identity }),
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
    })
    sessions.bindLoop(loop)
    const handlers = new Map<string, Handler>()
    const picks: string[][] = [[join(root, 'work/a')]]
    registerWorkspaceRoutes({
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener as Handler) },
      sessions,
      host,
      home: absolutePath(root),
      pickFolders: () => Promise.resolve(picks.shift() ?? null),
    })
    const call: Call = async (channel, payload) => handlers.get(channel)!({}, payload)
    await task(call, S1)
    const answer = asked(await call('workspace.pick', { sessionId: S1 }))
    expect(answer.folders).toEqual([join(root, 'work/a')])
    // While the dialog is open the folder becomes a link to somewhere the user never picked.
    await rename(join(root, 'work/a'), join(root, 'work/moved'))
    await symlink(join(root, 'secret'), join(root, 'work/a'))
    expect(
      await call('workspace.grant', { sessionId: S1, token: answer.token, choice: 'always' }),
    ).toEqual(STALE)
    expect((await sessions.sessionFacts({ sessionId: S1 })).workspace?.folders).toEqual([
      dedicatedFolderFor(absolutePath(root), identity, S1),
    ])
    expect((await readConfig(fs, identity)).folderAccess).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
