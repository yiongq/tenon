import {
  approvalRespond,
  approvalResume,
  chatContinue,
  chatQueueAct,
  chatSend,
  chatSendNow,
  chatStop,
  sessionSelectModel,
  sessionSelectProfile,
  workspacePick,
  workspaceRemove,
  workspaceUsePrefill,
} from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import { STOP_TERM_GRACE_MS, STOP_WRITE_WAIT_MS } from '@tenon-app/kernel'
import type { RunOrigin } from '@tenon-app/kernel'
import type { RunRegistry } from './chat.js'

/**
 * Closing a window and quitting (spec 02 §停止与退出; B4, B1, B18). Neither is a stop: a paused Run, a
 * card or a question writes nothing and is there after a restart (§启动恢复与发送防护). Only a Run in
 * progress asks first, on main's native confirm, whose copy is `LeaveRunDialog`'s keys; the answer
 * that stops aborts with `close-window` or `quit`, and the kernel records the Run as
 * `shutdown-aborted` with that trigger and each call it closes as `app-exit`.
 *
 * - **A window's `close`**, while no shutdown has begun and the window's document has a Run in
 *   progress: prevented, then 「停止任务并关闭 / 取消」. Cancel changes nothing; stop aborts that
 *   document's Runs with `close-window` and closes the window again, which no longer asks. The store
 *   stays open, so the Run's closing writes land.
 * - **`before-quit`**, the six steps, once: a repeated trigger waits on the same run, and a cancelled
 *   confirm ends it, so the next quit asks again.
 *   1. The first `before-quit` is always prevented — an ordinary quit waits for `tape.close()` too;
 *      the one step 6 makes goes through.
 *   2. With a Run in progress, 「停止任务并退出 / 取消」; cancel returns and nothing changes.
 *   3. In one synchronous stretch `beginShutdown()`, then `abort('all', 'quit')`: no Run can open in
 *      between, and from here on the routes that open a Run or write a fact answer `ok: false`
 *      (`refuseWhileShuttingDown`) and no window's `close` asks.
 *   4. `registry.settled(STOP_TERM_GRACE_MS + STOP_WRITE_WAIT_MS)`: SIGTERM, SIGKILL after the grace,
 *      and an in-process write's wait, Runs a closed window aborted still closing included. Both
 *      constants are the kernel's (loop/limits.ts): the desktop writes no number of its own.
 *   5. `tape.close()`, skipped without a store. A write later than this meets `TapeClosedError`; the
 *      kernel logs it, and the next start's recovery closes what was left open.
 *   6. Shutdown is done; `app.quit()`.
 * - **`before-quit-for-update`** (`quitAndInstall` closes the windows before any `before-quit`):
 *   step 3 with `quit`, and the `before-quit` that follows goes on from step 4.
 *
 * `dialog.showMessageBox(...)` is called on the dialog object itself, never destructured, so an e2e
 * can replace it (§e2e 接缝). Electron-free, like chat.ts: index.ts hands in `app`, `dialog` and the
 * windows.
 */

/** Step 4's bound: the stop sequence's SIGTERM grace, then the in-process write wait (§停止与退出). */
export const SHUTDOWN_SETTLE_MS = STOP_TERM_GRACE_MS + STOP_WRITE_WAIT_MS

/**
 * The routes that open a Run or write a fact (step 3): the sends, the queued item's actions, the stop
 * (it writes `cancelled-by-stop` in a paused session, and a quit cancels no card, B4), 「继续」, the
 * answers, the resume, the model and profile choices and the workspace writers. The reads —
 * `session.latest`, `session.messages`, `session.facts`, `session.modelChoice`, `approval.current`,
 * `approval.list` — still answer; the config and provider writers write no fact.
 */
export const REFUSED_WHILE_SHUTTING_DOWN: ReadonlySet<string> = new Set([
  chatSend.channel,
  chatSendNow.channel,
  chatQueueAct.channel,
  chatStop.channel,
  chatContinue.channel,
  approvalRespond.channel,
  approvalResume.channel,
  sessionSelectModel.channel,
  sessionSelectProfile.channel,
  workspacePick.channel,
  workspaceUsePrefill.channel,
  workspaceRemove.channel,
])

/** A diagnostic, never shown: the renderer maps `code` to copy (contracts' IpcError). */
const SHUTTING_DOWN = 'the app is shutting down'

/**
 * The route table once the shutdown began (step 3): a refused route answers `ok: false` as it
 * arrives, before its handler — so before the recovery gate and before the kernel — and the rest go
 * through untouched.
 */
export function refuseWhileShuttingDown(
  ipc: IpcMainLike,
  shuttingDown: () => boolean,
): IpcMainLike {
  return {
    handle(channel, listener) {
      if (!REFUSED_WHILE_SHUTTING_DOWN.has(channel)) {
        ipc.handle(channel, listener)
        return
      }
      ipc.handle(channel, (event, ...args) => {
        if (shuttingDown()) {
          return { ok: false, error: { code: 'handler-failed', message: SHUTTING_DOWN } }
        }
        return listener(event, ...args)
      })
    },
  }
}

/** The copy of the confirm: `LeaveRunDialog`'s title and description, and the two buttons. */
export type ExitCopyKey =
  | 'leave.title'
  | 'leave.description'
  | 'leave.stopAndClose'
  | 'leave.stopAndQuit'
  | 'leave.cancel'

/** The buttons, in this order: `response` 0 stops, 1 cancels — what an e2e's stub answers. */
export const EXIT_CONFIRM_STOP = 0
export const EXIT_CONFIRM_CANCEL = 1

/** What main passes to `showMessageBox` (a subset of Electron's `MessageBoxOptions`). */
export interface ExitConfirmOptions {
  readonly type: 'warning'
  readonly message: string
  readonly detail: string
  readonly buttons: string[]
  readonly defaultId: number
  readonly cancelId: number
  readonly noLink: true
}

/** Electron's `dialog`, the one method used; `W` is the window a confirm sits over. */
export interface ExitDialog<W> {
  showMessageBox(window: W, options: ExitConfirmOptions): Promise<{ readonly response: number }>
  showMessageBox(options: ExitConfirmOptions): Promise<{ readonly response: number }>
}

/** The half of a BrowserWindow the close handler uses. */
export interface ClosingWindow {
  /** The document the window shows: the `RunOrigin` its Runs were begun with. */
  readonly webContents: RunOrigin
  close(): void
  isDestroyed(): boolean
}

/** The half of Electron's `app` the six steps use. */
export interface ShutdownApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

export interface ShutdownDeps<W extends ClosingWindow> {
  readonly app: ShutdownApp
  readonly dialog: ExitDialog<W>
  /** null exactly when the store could not be opened: no Run can be in progress. */
  readonly registry: Pick<RunRegistry, 'running' | 'abort' | 'settled' | 'beginShutdown'> | null
  /** The session store (step 5); null when it could not be opened. */
  readonly tape: { close(): Promise<void> } | null
  readonly t: (key: ExitCopyKey) => string
  /** The window a quit's confirm sits over, if any is open. */
  readonly parent: () => W | null
  readonly log: (line: string) => void
}

export interface Shutdown<W extends ClosingWindow> {
  /** From step 3 on: the refused routes answer `ok: false`, and no window's close asks. */
  readonly started: boolean
  /** A window's `close` event. */
  onClose(win: W, event: { preventDefault(): void }): void
  /** `autoUpdater`'s `before-quit-for-update`: step 3, with `quit`. */
  beforeQuitForUpdate(): void
}

export function createShutdown<W extends ClosingWindow>(deps: ShutdownDeps<W>): Shutdown<W> {
  const { app, registry } = deps
  let started = false
  let done = false
  /** The one run of the six steps; null before the first quit, and again after a cancel. */
  let flight: Promise<void> | null = null
  /** Windows whose confirm is open: a second close waits on the first answer. */
  const asking = new Set<W>()

  /** True when the user chose to stop; a confirm that fails is a cancel, and is logged. */
  const confirm = async (kind: 'close' | 'quit', over: W | null): Promise<boolean> => {
    // In EXIT_CONFIRM_STOP, EXIT_CONFIRM_CANCEL order.
    const labels = [
      deps.t(kind === 'close' ? 'leave.stopAndClose' : 'leave.stopAndQuit'),
      deps.t('leave.cancel'),
    ]
    const options: ExitConfirmOptions = {
      type: 'warning',
      message: deps.t('leave.title'),
      detail: deps.t('leave.description'),
      buttons: labels,
      defaultId: EXIT_CONFIRM_CANCEL,
      cancelId: EXIT_CONFIRM_CANCEL,
      noLink: true,
    }
    try {
      const answer =
        over === null || over.isDestroyed()
          ? await deps.dialog.showMessageBox(options)
          : await deps.dialog.showMessageBox(over, options)
      return answer.response === EXIT_CONFIRM_STOP
    } catch (error) {
      deps.log(`[shutdown] the confirm failed, nothing is stopped: ${messageOf(error)}`)
      return false
    }
  }

  /** Step 3: nothing opens between the two calls. */
  const stopEverything = (): void => {
    started = true
    registry?.beginShutdown()
    registry?.abort('all', 'quit')
  }

  const quit = async (): Promise<void> => {
    // Step 2: only a Run in progress asks. One a closed window or an update already aborted does not.
    if (!started && registry !== null && registry.running().length > 0) {
      if (!(await confirm('quit', deps.parent()))) {
        flight = null
        return
      }
    }
    stopEverything()
    // Step 4.
    await registry?.settled(SHUTDOWN_SETTLE_MS)
    // Step 5.
    if (deps.tape !== null) {
      try {
        await deps.tape.close()
      } catch (error) {
        deps.log(`[shutdown] the session store did not close cleanly: ${messageOf(error)}`)
      }
    }
    // Step 6.
    done = true
    app.quit()
  }

  app.on('before-quit', (event) => {
    if (done) return
    event.preventDefault()
    flight ??= quit().catch((error: unknown) => {
      deps.log(`[shutdown] failed: ${messageOf(error)}`)
      flight = null
    })
  })

  return {
    get started() {
      return started
    },
    onClose(win, event) {
      if (started) return
      if (asking.has(win)) {
        event.preventDefault()
        return
      }
      const origin = win.webContents
      // Only a Run in progress asks: a card or a question waiting is no reason to (B4).
      if (registry === null || registry.running(origin).length === 0) return
      event.preventDefault()
      asking.add(win)
      void confirm('close', win).then((stop) => {
        asking.delete(win)
        if (!stop || win.isDestroyed()) return
        registry.abort({ origin }, 'close-window')
        // Nothing of this document is in progress now: this close does not ask.
        win.close()
      })
    },
    beforeQuitForUpdate() {
      stopEverything()
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
