import { rm } from 'node:fs/promises'
import {
  approvalRespond,
  approvalResume,
  chatContinue,
  chatQueueAct,
  chatSend,
  chatSendNow,
} from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import { isCanonicalUuid, toolOutputDirFor } from '@tenon-app/kernel'
import type {
  AbsolutePath,
  SessionIncarnation,
  SessionService,
  TapeStore,
  ParentLinkPayload,
} from '@tenon-app/kernel'
import type { RunRegistry } from './chat.js'

/**
 * Clearing and deleting a session (spec 02 §大响应落盘「删除是 host 的义务」, §本地持久化布局：只加一行;
 * H9). A session's large tool outputs are in `<profileDir>/tool-output/<sessionId>/`, which the kernel
 * writes and never deletes (`HostFs` has no delete member), so the host that clears or deletes a
 * session deletes that folder too, in this order:
 *
 *   0. the session's live Run, if it has one, is stopped (`user-stop`), and its lease has finished;
 *   1. the store's `resetSession` / `deleteSession` commits (through the kernel's service);
 *   2. the folder goes (`fs.rm`, recursive, force);
 *   3. only then is the operation complete.
 *
 * Step 0 because neither store call waits for a Run: a clear is a mailbox command, which runs between
 * an open Run's own writes, and a delete skips the mailbox. A call still running at step 2 would spill
 * after it: the old incarnation's full output back in the folder, for good after a delete, or where
 * the new incarnation reads without a card after a clear. A stopped Run spills before its lease
 * finishes, into the folder step 2 removes; a result later than its write wait is only logged
 * (§点停止时各状态怎么收). `user-stop`, because the user asked; the other two causes say the app is
 * going. A paused session has no lease, and its Run writes nothing more: nothing to wait for. A call
 * that ignores the stop (a connector's) holds the removal until it returns, as it holds any stop.
 *
 * From the call until step 3 the session takes no send: a clear keeps the `sessionId`, and a Run of
 * the new incarnation that spilled before step 2 was done would lose its file to it. Two guards:
 * `refuseWhileRemoving` answers the send routes `ok: false` as they arrive, and the RunRegistry
 * refuses the root any lease (chat.ts), which covers every other way a Run opens — an auto-send, the
 * held message a model choice releases, the Run a stop writes to close a paused one. So no Run
 * opens in it again after step 0.
 *
 * A store that throws leaves the folder alone: its facts still name those files. A folder that fails
 * to go is logged and the operation completes anyway; nothing sweeps it at startup (§大响应落盘).
 * Retracting one message deletes no file: 01's deletion table is unchanged, and nothing here hears of
 * it. Phase 2 has no screen that clears or deletes a session (the session list is phase 6); this is
 * the one way the desktop does either, and an e2e reaches it through `exposeSessionRemoval`.
 */
export interface SessionRemoval {
  /** A new incarnation of the session (`SessionService.resetSession`), then its tool-output folder. */
  clear(sessionId: string): Promise<SessionIncarnation>
  /** The session's facts, head and projections (`SessionService.deleteSession`), then its folder. */
  delete(sessionId: string): Promise<void>
  /** From the call until the operation completes, whether it committed or not. */
  removing(sessionId: string): boolean
}

export interface SessionRemovalDeps {
  readonly sessions: Pick<SessionService, 'resetSession' | 'deleteSession'>
  /** Parent links are read before mutation; only profile-owned spill directories are removed. */
  readonly tape?: Pick<TapeStore, 'head' | 'readRange'>
  /**
   * Step 0's: the RunRegistry (chat.ts), or null when there is no loop to open a Run. Read when a
   * removal begins, not when this is made: main makes the removal before the loop and its registry.
   */
  readonly runs: () => Pick<RunRegistry, 'abort' | 'settledRoot'> | null
  /** The profile the store belongs to: `HostIdentity.profileDir`. */
  readonly profileDir: AbsolutePath
  readonly log: (line: string) => void
  /** Step 2; `removeFolder` unless a test holds it. */
  readonly removeFolder?: (folder: AbsolutePath) => Promise<void>
}

/** Step 2: the folder and everything in it; one that is not there is not an error. */
export function removeFolder(folder: AbsolutePath): Promise<void> {
  return rm(folder, { recursive: true, force: true })
}

export function createSessionRemoval(deps: SessionRemovalDeps): SessionRemoval {
  const remove = deps.removeFolder ?? removeFolder
  /** By session id, how many clears and deletes of it have not completed. */
  const pending = new Map<string, number>()

  async function removal<T>(sessionId: string, commit: () => Promise<T>): Promise<T> {
    // Before anything is marked or touched: the id becomes a folder name (toolOutputDirFor).
    if (!isCanonicalUuid(sessionId)) {
      throw new TypeError(`session removal: "${sessionId}" is not a canonical UUID`)
    }
    const folder = toolOutputDirFor(deps.profileDir, sessionId)
    // In the call's own synchronous stretch: a send right behind it is refused, and so is a lease.
    pending.set(sessionId, (pending.get(sessionId) ?? 0) + 1)
    try {
      // Step 0: the only lease the root can have is the one live now.
      const runs = deps.runs()
      runs?.abort({ rootSessionId: sessionId }, 'user-stop')
      await runs?.settledRoot(sessionId)
      const children = await childOutputFolders(deps.tape, deps.profileDir, sessionId)
      const committed = await commit()
      for (const outputFolder of new Set([folder, ...children])) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- every directory is removed after the store commits
          await remove(outputFolder)
        } catch (error) {
          deps.log(
            `[session] ${sessionId}: its tool output was not removed, and nothing sweeps it later: ` +
              (error instanceof Error ? error.message : String(error)),
          )
        }
      }
      return committed
    } finally {
      const left = (pending.get(sessionId) ?? 1) - 1
      if (left === 0) pending.delete(sessionId)
      else pending.set(sessionId, left)
    }
  }

  return {
    clear: (sessionId) => removal(sessionId, () => deps.sessions.resetSession(sessionId)),
    delete: (sessionId) => removal(sessionId, () => deps.sessions.deleteSession(sessionId)),
    removing: (sessionId) => pending.has(sessionId),
  }
}

/** Two-level trees: enumerate recorded children, never user-selected or dedicated workspaces. */
async function childOutputFolders(
  tape: SessionRemovalDeps['tape'],
  profileDir: AbsolutePath,
  sessionId: string,
): Promise<AbsolutePath[]> {
  if (tape === undefined) return []
  const head = await tape.head(sessionId)
  if (head === null) return []
  const folders = new Set<AbsolutePath>()
  let fromEntryId: number | undefined
  do {
    // oxlint-disable-next-line no-await-in-loop -- page one pinned incarnation before deleting its facts
    const page = await tape.readRange({
      sessionId,
      incarnationId: head.incarnationId,
      atEntryId: head.lastEntryId,
      limit: 1000,
      ...(fromEntryId === undefined ? {} : { fromEntryId }),
    })
    for (const entry of page.entries) {
      if (entry.name !== 'session/parent_link') continue
      const link = entry.payload as unknown as ParentLinkPayload
      folders.add(toolOutputDirFor(profileDir, link.child.sessionId))
    }
    if (page.nextFromEntryId === null) break
    fromEntryId = page.nextFromEntryId
  } while (fromEntryId !== undefined)
  return [...folders]
}

/**
 * The routes that send into a session: a message, a stop-and-send, a queued item's send-now, 「继续」,
 * an answer and a resume — each opens a Run in it. A queued item's withdraw and edit open none, and
 * still answer.
 */
export const REFUSED_WHILE_REMOVING: ReadonlySet<string> = new Set([
  chatSend.channel,
  chatSendNow.channel,
  chatQueueAct.channel,
  chatContinue.channel,
  approvalRespond.channel,
  approvalResume.channel,
])

/** A diagnostic, never shown: the renderer maps `code` to copy (contracts' IpcError). */
const REMOVING = 'the session is being cleared or deleted'

/**
 * The route table while a session is being cleared or deleted: a send to it answers `ok: false` as
 * it arrives, before its handler — so before the recovery gate and the kernel — as
 * `refuseWhileShuttingDown` does for a quit. The renderer takes it as it takes that one: nothing was
 * sent. Read off the raw request, which the route's own schema has not checked yet: a request the
 * schema would refuse is refused either way.
 */
export function refuseWhileRemoving(
  ipc: IpcMainLike,
  removing: (sessionId: string) => boolean,
): IpcMainLike {
  return {
    handle(channel, listener) {
      if (!REFUSED_WHILE_REMOVING.has(channel)) {
        ipc.handle(channel, listener)
        return
      }
      ipc.handle(channel, (event, ...args) => {
        const request: unknown = args[0]
        if (sendsInto(channel, request, removing)) {
          return { ok: false, error: { code: 'handler-failed', message: REMOVING } }
        }
        return listener(event, ...args)
      })
    },
  }
}

function sendsInto(
  channel: string,
  request: unknown,
  removing: (sessionId: string) => boolean,
): boolean {
  if (typeof request !== 'object' || request === null) return false
  const { sessionId, action } = request as { sessionId?: unknown; action?: unknown }
  if (typeof sessionId !== 'string' || !removing(sessionId)) return false
  return channel !== chatQueueAct.channel || action === 'send-now'
}

/**
 * The e2e seam: `TENON_E2E_SESSION_REMOVAL=1` puts the removal on `globalThis.tenonSessionRemoval`,
 * for `electronApp.evaluate` to clear or delete a session with — phase 2 has no screen that does.
 * Development builds only, the same class of switch as `TENON_E2E_ROUTE_COUNTS` (e2e-routes.ts).
 */
export const SESSION_REMOVAL_ENV = 'TENON_E2E_SESSION_REMOVAL'

/** Where the seam puts it in the main process. */
export interface SessionRemovalGlobal {
  tenonSessionRemoval?: Pick<SessionRemoval, 'clear' | 'delete'>
}

export function exposeSessionRemoval(
  removal: SessionRemoval | null,
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (removal === null || isPackaged || env[SESSION_REMOVAL_ENV] !== '1') return
  const seam = globalThis as SessionRemovalGlobal
  seam.tenonSessionRemoval = {
    clear: (sessionId) => removal.clear(sessionId),
    delete: (sessionId) => removal.delete(sessionId),
  }
}
