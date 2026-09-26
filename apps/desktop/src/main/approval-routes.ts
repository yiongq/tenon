import { approvalCurrent, approvalRespond, registerRoute } from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import type { RunOrigin, SessionService } from '@tenon-app/kernel'

/**
 * The approval routes (spec 02 §答复与投递): `approval.respond` → the kernel's `answer`, and
 * `approval.current` → `currentPending`. Both only forward — which card is current, whether an
 * answer applies, and what it writes are the kernel's. `approval.list` and `approval.resume` come
 * with plan step 16.
 */
export interface ApprovalRoutesDeps {
  readonly ipcMain: IpcMainLike
  /** `null` when `sessions.db` could not be opened: nothing waits, and nothing can be answered. */
  readonly sessions: SessionService | null
}

export function registerApprovalRoutes({ ipcMain, sessions }: ApprovalRoutesDeps): void {
  registerRoute(ipcMain, approvalRespond, async (request, event) => {
    if (sessions === null) return { status: 'not-found' as const }
    const result = await sessions.answer({ ...request, origin: originOf(event) })
    // A refusal is `ok: false` on every loop route (§主进程与 kernel 的循环接口).
    if (result.status === 'refused') {
      throw new Error('answer refused: the loop is not bound, or the app is shutting down')
    }
    return { status: result.status }
  })

  registerRoute(ipcMain, approvalCurrent, async ({ sessionId }) => {
    if (sessions === null) return null
    return sessions.currentPending({ sessionId })
  })
}

/** The document that answered: the Run the answer opens belongs to it. */
function originOf(event: unknown): RunOrigin | null {
  if (typeof event !== 'object' || event === null) return null
  const sender = (event as { sender?: unknown }).sender
  if (typeof sender !== 'object' || sender === null) return null
  const hasListeners =
    typeof (sender as { on?: unknown }).on === 'function' &&
    typeof (sender as { off?: unknown }).off === 'function'
  return hasListeners ? sender : null
}
