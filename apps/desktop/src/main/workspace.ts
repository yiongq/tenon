import {
  registerRoute,
  sessionFacts,
  sessionSelectProfile,
  workspaceAccess,
  workspaceGrant,
  workspacePick,
  workspaceRemove,
  workspaceRevokeAccess,
  workspaceUsePrefill,
} from '@tenon-app/contracts'
import type {
  IpcMainLike,
  SessionFactsResponse,
  WorkspaceGrantResult,
  WorkspaceResult,
} from '@tenon-app/contracts'
import { absolutePath, isAbsolutePath, joinPath, resolvePath } from '@tenon-app/kernel'
import type {
  AbsolutePath,
  HostAdapter,
  HostIdentity,
  SessionFactsView,
  SessionService,
  WorkspaceChange,
} from '@tenon-app/kernel'
import { endpointOf } from './endpoint.js'
import { createFolderGrants } from './folder-grants.js'
import type { FolderGrants } from './folder-grants.js'
import { readConfig, withConfigLock, writeConfig, writeConfigHeld } from './host/profile.js'

/**
 * The task profile's workspace, and the profile choice before a session exists (spec 02 §会话形态
 * 「建立前暂存」, §工作区; H1, D11, D8, A9).
 *
 * A folder reaches a session's list only two ways: main's own directory dialog, or the prefill main
 * reads itself (`config.json`'s `lastWorkspaceFolders`). The renderer passes a session id, and for a
 * removal a folder already in the list — never a path to add. The kernel resolves each folder and
 * writes the fact; the prefill is written only after it said yes, and not when the list falls back
 * to the dedicated folder. Every route here waits for startup recovery.
 *
 * Folder grants (spec 06 §界面「文件夹授权」; D42): a folder never 「以后都允许」ed is not added by the
 * pick or the prefill that names it. Main keeps the chosen paths under a token (`folder-grants.ts`),
 * answers the list as it was with `pendingGrant`, and `workspace.grant` adds them — once, for the
 * session the token was made for — through the same change a direct pick makes. 「以后都允许」 also
 * keeps the real paths in `config.json`'s `folderAccess`, which only this module writes.
 */

export { PROTECTED_SHELL_FILES } from './host/sandbox-config.js'
import { protectionList, credentialPaths } from './host/sandbox-config.js'

/** The protected shell files, for `SessionServiceOptions.protectedFiles`; the kernel resolves them. */
export function protectedShellFiles(
  home: AbsolutePath,
  zdotdir: AbsolutePath | null = null,
): AbsolutePath[] {
  return protectionList({
    home,
    zdotdir,
    credentials: credentialPaths(process.platform === 'darwin' ? 'darwin' : 'linux', home),
  }).protectedFiles
}

/**
 * A session's own folder (§工作区「来源」): `<home>/Tenon/workspaces/<userId>/<tenantId>/<sessionId>/`
 * — outside the profile, one per session, tenant-scoped. Only computed here: it is made by the host
 * on the first write or the first command, never before.
 */
export function dedicatedFolderFor(
  home: AbsolutePath,
  identity: Pick<HostIdentity, 'userId' | 'tenantId'>,
  sessionId: string,
): AbsolutePath {
  return joinPath(home, 'Tenon', 'workspaces', identity.userId, identity.tenantId, sessionId)
}

const UNKNOWN_SESSION: WorkspaceResult = { ok: false, code: 'unknown-session' }
const NOT_COWORK: WorkspaceResult = { ok: false, code: 'not-cowork' }
const STALE: WorkspaceGrantResult = { ok: false, code: 'stale' }
const ROOT_FOLDER: WorkspaceResult = { ok: false, code: 'root-folder' }
/** What a change answers: a grant's answer without `stale`, which only a token can be. */
type Changed =
  | Extract<WorkspaceGrantResult, { ok: true }>
  | { ok: false; code: Exclude<Extract<WorkspaceGrantResult, { ok: false }>['code'], 'stale'> }
/** With no store there is no session: an unknown one reads as a chat with nothing chosen. */
const NO_FACTS: SessionFactsResponse = {
  established: false,
  profile: 'chat',
  workspace: null,
  approvalMode: 'manual',
}

export interface WorkspaceRoutesDeps {
  readonly ipcMain: IpcMainLike
  /** `null` when `sessions.db` could not be opened: there is no session to choose for. */
  readonly sessions: SessionService | null
  readonly host: Pick<HostAdapter, 'fs' | 'identity'>
  readonly home: AbsolutePath
  /** Main's directory dialog, several folders at once; null or empty when the user cancelled. */
  readonly pickFolders: (event: unknown) => Promise<readonly string[] | null>
  readonly gate?: Promise<void>
  readonly log?: (line: string) => void
  /**
   * The pending grants. Handed in when something else must void them — a session's clear
   * (`createSessionRemoval`'s `onRemoval`); made here when nothing does.
   */
  readonly grants?: FolderGrants
  /** Spec 05 §快照怎么拍: accepted folders start a background snapshot, without changing selection. */
  readonly onWorkspaceChanged?: (
    sessionId: string,
    folders: readonly AbsolutePath[],
  ) => Promise<void>
}

export function registerWorkspaceRoutes(deps: WorkspaceRoutesDeps): void {
  const { ipcMain, sessions, gate } = deps
  const grants = deps.grants ?? createFolderGrants()
  const dedicated = (sessionId: string): AbsolutePath =>
    dedicatedFolderFor(deps.home, deps.host.identity, sessionId)

  const notifications = new Map<string, Promise<void>>()
  const notify = (sessionId: string, folders: readonly AbsolutePath[]): void => {
    const pending = (notifications.get(sessionId) ?? Promise.resolve())
      .then(() => deps.onWorkspaceChanged?.(sessionId, folders))
      .catch((error: unknown) => {
        ;(deps.log ?? console.warn)(
          `[workspace] ${sessionId}: snapshot notification failed: ` +
            (error instanceof Error ? error.message : String(error)),
        )
      })
    notifications.set(sessionId, pending)
    void pending.finally(() => {
      if (notifications.get(sessionId) === pending) notifications.delete(sessionId)
    })
  }

  /** The change applied by the kernel, then the prefill when a picked list changed. */
  const change = async (sessionId: string, next: WorkspaceChange): Promise<Changed> => {
    if (sessions === null) return UNKNOWN_SESSION
    const result = await sessions.setWorkspace({
      sessionId,
      change: next,
      dedicated: dedicated(sessionId),
    })
    if (!result.ok) return { ok: false, code: result.code }
    notify(sessionId, result.folders)
    if (result.origin === 'picked') {
      await writeConfig(deps.host.fs, deps.host.identity, {
        lastWorkspaceFolders: [...result.folders],
      })
    }
    return {
      ok: true,
      folders: [...result.folders],
      origin: result.origin,
      ...(result.warning === undefined ? {} : { warning: result.warning }),
    }
  }

  /**
   * The folders a pick or the prefill chose, as D42 has it: every one's real path already in
   * `folderAccess` (or none chosen) is today's add; otherwise nothing is added, and the list as it is
   * comes back with `pendingGrant`. A folder whose real path cannot be named is no grant to ask for:
   * the kernel refuses a list with one in it (`root-folder`), and that answer is the add's own.
   *
   * The grant keeps — and the dialog shows — the real paths, resolved now: what the user answers is
   * what gets added, even if a link on the way is pointed elsewhere while the dialog is open.
   */
  const select = async (sessionId: string, chosen: AbsolutePath[]): Promise<WorkspaceResult> => {
    if (sessions === null) return UNKNOWN_SESSION
    const access = new Set((await readConfig(deps.host.fs, deps.host.identity)).folderAccess)
    const reals = await Promise.all(chosen.map((folder) => resolvePath(deps.host.fs, folder)))
    // A folder main cannot name now is refused here, never handed on: the kernel resolving it a
    // moment later could reach a folder no dialog showed and nobody granted.
    if (reals.some((real) => !real.resolved)) return ROOT_FOLDER
    if (reals.every((real) => access.has(real.path))) {
      // The kept folders by the real paths just checked, not the spelling the dialog returned.
      return change(sessionId, { kind: 'add', folders: reals.map((real) => real.path) })
    }
    // Read again, here: the dialog was open, and the session may have gone or changed shape.
    const facts = await sessions.sessionFacts({ sessionId })
    if (!facts.established && !facts.drafted) return UNKNOWN_SESSION
    if (facts.profile !== 'cowork' || facts.workspace === null) return NOT_COWORK
    return {
      ok: true,
      folders: [...facts.workspace.folders],
      origin: facts.workspace.origin,
      pendingGrant: grants.mint(
        sessionId,
        reals.map((real) => real.path),
      ),
    }
  }

  registerRoute(ipcMain, workspacePick, async ({ sessionId }, event) => {
    await gate
    if (sessions === null) return UNKNOWN_SESSION
    // Checked before the dialog opens, and again by the kernel when the change takes its turn.
    const facts = await sessions.sessionFacts({ sessionId })
    if (!facts.established && !facts.drafted) return UNKNOWN_SESSION
    if (facts.profile !== 'cowork' || facts.workspace === null) return NOT_COWORK
    // A new pick voids the grant the last one left, whatever the dialog answers (D42).
    grants.invalidate(sessionId)
    const picked = ((await deps.pickFolders(event)) ?? []).filter(isAbsolutePath)
    if (picked.length === 0) {
      // Cancelled: the list as it is, and no fact.
      const current: WorkspaceResult = {
        ok: true,
        folders: [...facts.workspace.folders],
        origin: facts.workspace.origin,
      }
      return current
    }
    return select(sessionId, picked.map(absolutePath))
  })

  registerRoute(ipcMain, workspaceUsePrefill, async ({ sessionId }) => {
    await gate
    grants.invalidate(sessionId)
    const config = await readConfig(deps.host.fs, deps.host.identity)
    const folders = config.lastWorkspaceFolders.filter(isAbsolutePath).map(absolutePath)
    return select(sessionId, folders)
  })

  /**
   * 「以后都允许」: the grant's real paths that the kernel just put in the session and that were not
   * kept before — only what the kernel accepted, never a path main alone resolved.
   */
  const keepAccess = async (
    kept: readonly AbsolutePath[],
    inSession: readonly string[],
  ): Promise<void> => {
    const accepted = kept.filter((folder) => inSession.includes(folder))
    await withConfigLock(deps.host.identity, async () => {
      const { folderAccess } = await readConfig(deps.host.fs, deps.host.identity)
      const next = [...new Set([...folderAccess, ...accepted])]
      if (next.length > folderAccess.length) {
        await writeConfigHeld(deps.host.fs, deps.host.identity, { folderAccess: next })
      }
    })
  }

  registerRoute(ipcMain, workspaceGrant, async ({ sessionId, token, choice }) => {
    await gate
    // Used in this synchronous stretch: another session's token, a used or a voided one adds nothing.
    const folders = grants.take(sessionId, token)
    if (folders === null) return STALE
    // The real paths the dialog showed must still be themselves: one that resolves elsewhere now (a
    // folder on the way swapped for a link) voids the answer rather than adding what the user never
    // saw. A folder deleted since still names itself; the kernel then refuses it.
    const now = await Promise.all(folders.map((folder) => resolvePath(deps.host.fs, folder)))
    if (now.some((real, at) => !real.resolved || real.path !== folders[at])) return STALE
    const result = await change(sessionId, { kind: 'add', folders: [...folders] })
    if (result.ok && choice === 'always') await keepAccess(folders, result.folders)
    return result
  })

  registerRoute(ipcMain, workspaceAccess, async () => {
    await gate
    return { folders: (await readConfig(deps.host.fs, deps.host.identity)).folderAccess }
  })

  registerRoute(ipcMain, workspaceRevokeAccess, async ({ folder }) => {
    await gate
    // Only the entry goes: a session already using the folder keeps it (D42).
    return withConfigLock(deps.host.identity, async () => {
      const { folderAccess } = await readConfig(deps.host.fs, deps.host.identity)
      if (!folderAccess.includes(folder)) return { folders: folderAccess }
      const next = await writeConfigHeld(deps.host.fs, deps.host.identity, {
        folderAccess: folderAccess.filter((kept) => kept !== folder),
      })
      return { folders: next.folderAccess }
    })
  })

  registerRoute(ipcMain, workspaceRemove, async ({ sessionId, folder }) => {
    await gate
    const result = await change(sessionId, { kind: 'remove', folder })
    if (!result.ok) {
      if (result.code === 'root-folder') throw new Error('Invalid dedicated workspace')
      return { ok: false as const, code: result.code }
    }
    return { ok: true as const, folders: result.folders, origin: result.origin }
  })

  registerRoute(ipcMain, sessionSelectProfile, async ({ sessionId, profile }) => {
    await gate
    if (sessions === null) return { ok: false as const, code: 'established' as const }
    const result = await sessions.selectProfile(
      profile === 'chat'
        ? { sessionId, profile }
        : { sessionId, profile, dedicated: dedicated(sessionId) },
    )
    if (result.ok) notify(sessionId, result.workspace?.folders ?? [])
    return result.ok
      ? { ok: true as const, ...factsOf(result) }
      : { ok: false as const, code: result.code }
  })

  registerRoute(ipcMain, sessionFacts, async ({ sessionId }) => {
    await gate
    if (sessions === null) return NO_FACTS
    return factsOf(await sessions.sessionFacts({ sessionId }))
  })
}

/**
 * The route's shape: `drafted` stays in main, the arrays are copied out of the kernel's answer, and
 * the last origin is classified here, where 「本机」 and the private side are read (endpoint.ts). `chosen`
 * only when the session has its own choice (①; rrE-1).
 */
function factsOf(view: SessionFactsView): SessionFactsResponse {
  const lastEndpoint = endpointOf(view.lastEndpointOrigin ?? undefined)
  return {
    established: view.established,
    profile: view.profile,
    workspace:
      view.workspace === null
        ? null
        : { folders: [...view.workspace.folders], origin: view.workspace.origin },
    ...(lastEndpoint === null ? {} : { lastEndpoint }),
    ...(view.chosen === null ? {} : { chosen: { providerId: view.chosen.providerId } }),
    approvalMode: view.approvalMode,
    ...(view.autoModeDisabled ? { autoModeDisabled: true as const } : {}),
  }
}
