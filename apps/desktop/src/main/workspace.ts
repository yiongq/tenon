import {
  registerRoute,
  sessionFacts,
  sessionSelectProfile,
  workspacePick,
  workspaceRemove,
  workspaceUsePrefill,
} from '@tenon-app/contracts'
import type { IpcMainLike, SessionFactsResponse, WorkspaceResult } from '@tenon-app/contracts'
import { absolutePath, isAbsolutePath, joinPath } from '@tenon-app/kernel'
import type {
  AbsolutePath,
  HostAdapter,
  HostIdentity,
  SessionFactsView,
  SessionService,
  WorkspaceChange,
} from '@tenon-app/kernel'
import { endpointOf } from './endpoint.js'
import { readConfig, writeConfig } from './host/profile.js'

/**
 * The task profile's workspace, and the profile choice before a session exists (spec 02 §会话形态
 * 「建立前暂存」, §工作区; H1, D11, D8, A9).
 *
 * A folder reaches a session's list only two ways: main's own directory dialog, or the prefill main
 * reads itself (`config.json`'s `lastWorkspaceFolders`). The renderer passes a session id, and for a
 * removal a folder already in the list — never a path to add. The kernel resolves each folder and
 * writes the fact; the prefill is written only after it said yes, and not when the list falls back
 * to the dedicated folder. Every route here waits for startup recovery.
 */

/** The shell files the protected list names (§「在不在工作区里」; D2): in the user's home. */
export const PROTECTED_SHELL_FILES: readonly string[] = [
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.bashrc',
  '.bash_profile',
  '.profile',
]

/** The protected shell files, for `SessionServiceOptions.protectedFiles`; the kernel resolves them. */
export function protectedShellFiles(home: AbsolutePath): AbsolutePath[] {
  return PROTECTED_SHELL_FILES.map((name) => joinPath(home, name))
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
/** With no store there is no session: an unknown one reads as a chat with nothing chosen. */
const NO_FACTS: SessionFactsResponse = { established: false, profile: 'chat', workspace: null }

export interface WorkspaceRoutesDeps {
  readonly ipcMain: IpcMainLike
  /** `null` when `sessions.db` could not be opened: there is no session to choose for. */
  readonly sessions: SessionService | null
  readonly host: Pick<HostAdapter, 'fs' | 'identity'>
  readonly home: AbsolutePath
  /** Main's directory dialog, several folders at once; null or empty when the user cancelled. */
  readonly pickFolders: (event: unknown) => Promise<readonly string[] | null>
  readonly gate?: Promise<void>
}

export function registerWorkspaceRoutes(deps: WorkspaceRoutesDeps): void {
  const { ipcMain, sessions, gate } = deps
  const dedicated = (sessionId: string): AbsolutePath =>
    dedicatedFolderFor(deps.home, deps.host.identity, sessionId)

  /** The change applied by the kernel, then the prefill when a picked list changed. */
  const change = async (sessionId: string, next: WorkspaceChange): Promise<WorkspaceResult> => {
    if (sessions === null) return UNKNOWN_SESSION
    const result = await sessions.setWorkspace({
      sessionId,
      change: next,
      dedicated: dedicated(sessionId),
    })
    if (!result.ok) return { ok: false, code: result.code }
    if (result.origin === 'picked') {
      await writeConfig(deps.host.fs, deps.host.identity, {
        lastWorkspaceFolders: [...result.folders],
      })
    }
    return { ok: true, folders: [...result.folders], origin: result.origin }
  }

  registerRoute(ipcMain, workspacePick, async ({ sessionId }, event) => {
    await gate
    if (sessions === null) return UNKNOWN_SESSION
    // Checked before the dialog opens, and again by the kernel when the change takes its turn.
    const facts = await sessions.sessionFacts({ sessionId })
    if (!facts.established && !facts.drafted) return UNKNOWN_SESSION
    if (facts.profile !== 'cowork' || facts.workspace === null) return NOT_COWORK
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
    return change(sessionId, { kind: 'add', folders: picked.map(absolutePath) })
  })

  registerRoute(ipcMain, workspaceUsePrefill, async ({ sessionId }) => {
    await gate
    const config = await readConfig(deps.host.fs, deps.host.identity)
    const folders = config.lastWorkspaceFolders.filter(isAbsolutePath).map(absolutePath)
    return change(sessionId, { kind: 'add', folders })
  })

  registerRoute(ipcMain, workspaceRemove, async ({ sessionId, folder }) => {
    await gate
    return change(sessionId, { kind: 'remove', folder })
  })

  registerRoute(ipcMain, sessionSelectProfile, async ({ sessionId, profile }) => {
    await gate
    if (sessions === null) return { ok: false as const, code: 'established' as const }
    const result = await sessions.selectProfile(
      profile === 'chat'
        ? { sessionId, profile }
        : { sessionId, profile, dedicated: dedicated(sessionId) },
    )
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
  }
}
