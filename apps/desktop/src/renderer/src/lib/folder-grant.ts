import { invokeRoute, workspaceGrant } from '@tenon-app/contracts'
import type {
  IpcInvokerLike,
  IpcResult,
  PendingGrant,
  RouteResponse,
  WorkspaceResult,
} from '@tenon-app/contracts'

/** The folder grant dialog's answers (spec 06 §界面「文件夹授权」). */
export type FolderGrantChoice = 'cancel' | 'always' | 'session'

/** A pick or a prefill that added nothing yet: the folders wait on the dialog (D42). */
export function pendingGrantOf(result: IpcResult<WorkspaceResult>): PendingGrant | null {
  return result.ok && result.data.ok ? (result.data.pendingGrant ?? null) : null
}

/**
 * The dialog's answer, as main takes it: 「取消」 calls nothing; the others send the token alone —
 * never a path, main adds its own copy of the folders (D42).
 */
export function answerFolderGrant(
  bridge: IpcInvokerLike,
  sessionId: string,
  grant: PendingGrant,
  choice: FolderGrantChoice,
): Promise<IpcResult<RouteResponse<typeof workspaceGrant>>> | null {
  if (choice === 'cancel') return null
  return invokeRoute(bridge, workspaceGrant, { sessionId, token: grant.token, choice })
}
