import {
  approvalCurrent,
  approvalList,
  approvalRespond,
  approvalResume,
  registerRoute,
} from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import type { RunOrigin, SessionService } from '@tenon-app/kernel'

/**
 * The approval routes (spec 02 §答复与投递, §离开会话, §启动恢复与发送防护): `approval.respond` →
 * `answer`, `approval.current` → `currentPending`, `approval.list` → `listPendingRoots` and
 * `approval.resume` → `resume`. All four only forward — which card is current, whether an answer
 * applies, what it writes and what can be resumed are the kernel's — and all four wait for startup
 * recovery first.
 */
export interface ApprovalRoutesDeps {
  readonly ipcMain: IpcMainLike
  /** `null` when `sessions.db` could not be opened: nothing waits, and nothing can be answered. */
  readonly sessions: SessionService | null
  readonly gate?: Promise<void>
}

export function registerApprovalRoutes({ ipcMain, sessions, gate }: ApprovalRoutesDeps): void {
  registerRoute(ipcMain, approvalRespond, async (request, event) => {
    await gate
    if (sessions === null) return { status: 'not-found' as const }
    const result = await sessions.answer({ ...request, origin: originOf(event) })
    // A refusal is `ok: false` on every loop route (§主进程与 kernel 的循环接口).
    if (result.status === 'refused') {
      throw new Error(
        'answer refused: the loop is unbound, the app is quitting, or a removal is under way',
      )
    }
    return { status: result.status }
  })

  registerRoute(ipcMain, approvalCurrent, async ({ sessionId }) => {
    await gate
    if (sessions === null) return null
    return sessions.currentPending({ sessionId })
  })

  registerRoute(ipcMain, approvalList, async ({ limit }) => {
    await gate
    if (sessions === null) return []
    return [...(await sessions.listPendingRoots({ limit }))]
  })

  registerRoute(ipcMain, approvalResume, async ({ sessionId }, event) => {
    await gate
    if (sessions === null) return { status: 'none' as const }
    const result = await sessions.resume({ rootSessionId: sessionId, origin: originOf(event) })
    if (result.status === 'refused') {
      throw new Error(
        'resume refused: the loop is unbound, the app is quitting, or a removal is under way',
      )
    }
    return { status: result.status }
  })
}

/** The document that answered: the Run the answer opens belongs to it. */
export function originOf(event: unknown): RunOrigin | null {
  if (typeof event !== 'object' || event === null) return null
  const sender = (event as { sender?: unknown }).sender
  if (typeof sender !== 'object' || sender === null) return null
  const hasListeners =
    typeof (sender as { on?: unknown }).on === 'function' &&
    typeof (sender as { off?: unknown }).off === 'function'
  return hasListeners ? sender : null
}
