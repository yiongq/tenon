import {
  registerRoute,
  snapshotPreview,
  snapshotRestore,
  snapshotRounds,
} from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import { absolutePath } from '@tenon-app/kernel'
import type { SessionService, SnapshotRefusal } from '@tenon-app/kernel'
import { isSameDocument } from './navigation.js'

export interface SnapshotRoutesDeps {
  readonly ipcMain: IpcMainLike
  readonly sessions: SessionService | null
  readonly gate?: Promise<void>
  /** Main owns visibility; the renderer cannot claim a window or tenant in its request. */
  readonly canAccessSession: (event: unknown, sessionId: string) => boolean
}

/** Spec 05 §接口: the kernel owns Tape identities, mailbox order, leases and restore facts. */
export function registerSnapshotRoutes(deps: SnapshotRoutesDeps): void {
  const { ipcMain, sessions } = deps
  const check = async (event: unknown, sessionId: string): Promise<SnapshotRefusal | null> => {
    await deps.gate
    if (sessions === null || !deps.canAccessSession(event, sessionId)) return GONE
    const facts = await sessions.sessionFacts({ sessionId })
    if (!facts.established) return GONE
    return facts.profile === 'cowork' ? null : { ok: false, code: 'not-cowork' }
  }

  registerRoute(ipcMain, snapshotRounds, async (q, event) => {
    const refusal = await check(event, q.sessionId)
    if (refusal !== null) return refusal
    return sessions!.snapshotRounds(q)
  })

  registerRoute(ipcMain, snapshotPreview, async (q, event) => {
    const refusal = await check(event, q.sessionId)
    if (refusal !== null) return refusal
    // This query validates both the root identity and the round's membership from Tape.
    return sessions!.snapshotPreview(q)
  })

  registerRoute(ipcMain, snapshotRestore, async (q, event) => {
    const refusal = await check(event, q.sessionId)
    if (refusal !== null) return refusal
    const current = await sessions!.snapshotPreview({
      sessionId: q.sessionId,
      roundRunId: q.roundRunId,
    })
    if (!current.ok) return current
    if (current.preview.previewKey !== q.previewKey)
      return { ok: false as const, code: 'stale' as const }
    if (q.overwrite.some((path) => !current.preview.conflicts.includes(absolutePath(path))))
      throw new TypeError('overwrite must be a subset of conflicts')
    // Revalidated inside the root mailbox: a workspace edit between these two turns stays stale.
    return sessions!.snapshotRestore({ ...q, overwrite: q.overwrite.map(absolutePath) })
  })
}

const GONE: SnapshotRefusal = { ok: false, code: 'gone' }

interface SnapshotWindow {
  isDestroyed(): boolean
  readonly webContents: {
    isDestroyed(): boolean
    readonly mainFrame: { readonly url: string }
  }
}

/**
 * Desktop currently has one profile, shared by its app windows. Only their live main document
 * can see that profile's root sessions; an embedded frame or another webContents has no access.
 */
export function snapshotWindowCanAccess(
  event: unknown,
  windows: readonly SnapshotWindow[],
  appUrl: string,
): boolean {
  if (typeof event !== 'object' || event === null) return false
  const { sender, senderFrame } = event as { sender?: unknown; senderFrame?: unknown }
  const win = windows.find((candidate) => candidate.webContents === sender)
  if (win === undefined || win.isDestroyed() || win.webContents.isDestroyed()) return false
  const frame = win.webContents.mainFrame
  return senderFrame === frame && isSameDocument(frame.url, appUrl)
}
