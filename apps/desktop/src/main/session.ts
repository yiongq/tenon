import { registerRoute, sessionLatest, sessionMessages } from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import type { SessionService } from '@tenon-app/kernel'

/**
 * Reading the stored conversation back (spec 01 §desktop 接线): what the renderer opens on after a
 * restart, and one page of a session's messages. Both are reads — appending to the tape happens
 * only through `chat.send`, and both routes go through the contracts registry, never through a
 * bare `ipcMain.handle`.
 *
 * `limit` is bounded by the schema, so an unbounded read cannot even be expressed on this
 * boundary (invariant 16 says the same thing one layer down).
 */
export interface SessionRoutesDeps {
  ipcMain: IpcMainLike
  /** `null` when `sessions.db` could not be opened: there is nothing to restore, honestly. */
  sessions: SessionService | null
}

export function registerSessionRoutes({ ipcMain, sessions }: SessionRoutesDeps): void {
  registerRoute(ipcMain, sessionLatest, async ({ limit }) => {
    if (sessions === null) return null
    const latest = await sessions.latestSession({ limit })
    // Copied out of the readonly view the kernel hands back: the response schema owns what
    // crosses, and a shared array would let a handler hold a reference into the kernel's answer.
    return latest === null ? null : { sessionId: latest.sessionId, messages: [...latest.messages] }
  })

  registerRoute(ipcMain, sessionMessages, async (query) => {
    if (sessions === null) return []
    // Rebuilt key by key: an optional property that is PRESENT and undefined is not the same as
    // an absent one under exactOptionalPropertyTypes, and the cursors are optional on both sides.
    return await sessions.listMessages({
      sessionId: query.sessionId,
      limit: query.limit,
      ...(query.afterOrderSeq === undefined ? {} : { afterOrderSeq: query.afterOrderSeq }),
      ...(query.beforeOrderSeq === undefined ? {} : { beforeOrderSeq: query.beforeOrderSeq }),
    })
  })
}
