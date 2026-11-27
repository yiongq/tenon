import { registerRoute, sessionSetApprovalMode } from '@tenon-app/contracts'
import type { ApprovalMode, Config, IpcMainLike } from '@tenon-app/contracts'
import type { HostIdentity, SessionService } from '@tenon-app/kernel'
import { watchConfig } from './host/profile.js'

/**
 * Choosing a task's approval mode (spec 06 §档位怎么存、怎么切, §接口; D41). The kernel decides —
 * the draft's choice before the session exists, a `by: 'user'` fact after, both through the root's
 * mailbox — and answers one of five statuses; `set` becomes `{ ok: true, mode }`, every other status
 * is the same code on the wire (a chat's or a child's id is `not-cowork`, a shutdown is `refused`,
 * the policy turning auto off is `policy`). Waits for startup recovery, like every route that writes a
 * fact.
 */
export function registerApprovalModeRoutes(q: {
  readonly ipcMain: IpcMainLike
  readonly sessions: Pick<SessionService, 'setApprovalMode'> | null
  readonly gate?: Promise<void>
}): void {
  registerRoute(q.ipcMain, sessionSetApprovalMode, async ({ sessionId, mode }) => {
    await q.gate
    if (q.sessions === null) return { ok: false as const, code: 'unknown-session' as const }
    const { status } = await q.sessions.setApprovalMode({ sessionId, mode })
    return status === 'set' ? { ok: true as const, mode } : { ok: false as const, code: status }
  })
}

/**
 * A new task's default mode, for `SessionServiceOptions.approvalModeDefault` (spec 06 §档位怎么存、
 * 怎么切; D8). The kernel reads it synchronously when a send starts, so main keeps the value in
 * memory: `config.json`'s `approvalMode` as read at startup, then what every later write of the file
 * left there — `config.set` is the only writer of the key, and the watcher hears every write of the
 * profile, whichever route made it.
 */
export function trackApprovalModeDefault(
  identity: HostIdentity,
  initial: ApprovalMode,
): () => ApprovalMode {
  let current = initial
  watchConfig(identity, (config: Config) => {
    current = config.approvalMode
  })
  return () => current
}
