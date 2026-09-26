import { registerRoute, sessionLatest, sessionMessages } from '@tenon-app/contracts'
import type { ContentBlockContract, IpcMainLike, MessageRowContract } from '@tenon-app/contracts'
import type { ContentBlock, MessageRow, SessionService } from '@tenon-app/kernel'

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
    return latest === null
      ? null
      : { sessionId: latest.sessionId, messages: latest.messages.map(projectedRow) }
  })

  registerRoute(ipcMain, sessionMessages, async (query) => {
    if (sessions === null) return []
    // Rebuilt key by key: an optional property that is PRESENT and undefined is not the same as
    // an absent one under exactOptionalPropertyTypes, and the cursors are optional on both sides.
    const rows = await sessions.listMessages({
      sessionId: query.sessionId,
      limit: query.limit,
      ...(query.afterOrderSeq === undefined ? {} : { afterOrderSeq: query.afterOrderSeq }),
      ...(query.beforeOrderSeq === undefined ? {} : { beforeOrderSeq: query.beforeOrderSeq }),
    })
    return rows.map(projectedRow)
  })
}

/**
 * A stored message as it may leave the main process (spec 02 plan, step 6: 原样块取乙). The kernel
 * keeps what the vendor sent verbatim — `vendor` blocks and the `vendorFields` of known blocks
 * (01 修补 2) — for the Tape and for replay; none of it is for the renderer, and the contracts'
 * block union does not have it. It is taken out HERE, before the response schema sees the row, so
 * that schema stays exactly what it was; showing vendor blocks one day is an addition to contracts
 * (甲), not a change.
 *
 * A row whose content was nothing but vendor blocks keeps its place with empty content, so paging
 * by `limit` and `orderSeq` means the same thing on both sides of the boundary.
 */
export function projectedRow(row: MessageRow): MessageRowContract {
  return { ...row, content: row.content.flatMap(projectedBlock) }
}

function projectedBlock(block: ContentBlock): ContentBlockContract[] {
  switch (block.type) {
    case 'vendor':
      return []
    case 'text':
      return [{ type: 'text', text: block.text }]
    case 'thinking':
      return [
        {
          type: 'thinking',
          text: block.text,
          signature: block.signature,
          provider: block.provider,
          providerModel: block.providerModel,
        },
      ]
    case 'redacted-thinking':
      return [
        {
          type: 'redacted-thinking',
          data: block.data,
          provider: block.provider,
          providerModel: block.providerModel,
        },
      ]
    case 'tool-request':
      return [{ type: 'tool-request', id: block.id, name: block.name, input: block.input }]
    case 'tool-response':
      return [
        {
          type: 'tool-response',
          id: block.id,
          content: block.content.map((part) =>
            part.type === 'text' ? { type: 'text', text: part.text } : part,
          ),
          isError: block.isError,
        },
      ]
    case 'image':
      return [block]
  }
}
