import { inspectorRelease, registerRoute } from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import type { SessionService } from '@tenon-app/kernel'

export function registerInspectorRoutes(q: {
  readonly ipcMain: IpcMainLike
  readonly sessions: Pick<SessionService, 'releaseInspector'> | null
  readonly gate?: Promise<void>
}): void {
  registerRoute(q.ipcMain, inspectorRelease, async (request) => {
    await q.gate
    if (q.sessions === null) return { status: 'not-found' as const }
    return q.sessions.releaseInspector(request)
  })
}
