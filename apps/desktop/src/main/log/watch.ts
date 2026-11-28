/**
 * The watchers (docs/features/error-logs/spec.md §记什么): a request from the window that came back
 * `ok: false`, the errors a window's page leaves on its console, an Electron process that went
 * away, and an error nobody in the main process caught. Each is handed what it watches and the log;
 * none imports electron.
 */
import type { IpcError, IpcMainLike } from '@tenon-app/contracts'
import type { AppLog } from './app-log.js'
import { redactAndCut, summarizeError } from './redact.js'

const RENDERER_MESSAGE_LIMIT = 300
const RENDERER_SOURCE_LIMIT = 200

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** The `ok: false` answer in what a route handler returned, or null. */
function failureOf(answer: unknown): { code: IpcError['code']; message: string } | null {
  if (typeof answer !== 'object' || answer === null) return null
  const { ok, error } = answer as { ok?: unknown; error?: unknown }
  if (ok !== false || typeof error !== 'object' || error === null) return null
  const { code, message } = error as { code?: unknown; message?: unknown }
  return {
    code: typeof code === 'string' ? (code as IpcError['code']) : 'handler-failed',
    message: typeof message === 'string' ? message : '',
  }
}

/**
 * Logs a line for every route that answers `ok: false`: the channel, the kind of failure and its
 * message. It is the outermost wrapper of the route table, closest to `registerRoute`, and looks
 * only at the answer that handler gave: a request refused outside it (the quit under way, a session
 * being removed) never gets here and so is not logged. The answer goes back unchanged.
 */
export function logRouteFailures(ipc: IpcMainLike, log: AppLog): IpcMainLike {
  return {
    handle(channel, listener) {
      const note = (answer: unknown): void => {
        const failure = failureOf(answer)
        if (failure !== null) log.write('warn', { event: 'ipc.failed', channel, ...failure })
      }
      ipc.handle(channel, (event, ...args) => {
        const answer = listener(event, ...args)
        if (!isThenable(answer)) {
          note(answer)
          return answer
        }
        return answer.then((settled) => {
          note(settled)
          return settled
        })
      })
    },
  }
}

/** The file's name alone: no folder, no query, no fragment. */
function fileNameOf(sourceId: string): string {
  const path = sourceId.split(/[?#]/u, 1)[0] ?? ''
  return path.split(/[\\/]/u).at(-1) ?? ''
}

/**
 * Logs the page's errors: only those of level `error`, their first line (redacted, then cut to 300;
 * of a line longer than 4096 characters only the start is looked at, and the count of what was
 * cut is still of the whole line), the file's name and the line number. A run of the same error is
 * one line and a count; that is `AppLog`'s to merge (`renderer.error`).
 */
export function watchRendererConsole(
  contents: {
    on(
      event: 'console-message',
      listener: (details: {
        level: string
        message: string
        sourceId: string
        lineNumber: number
      }) => unknown,
    ): unknown
  },
  log: AppLog,
): void {
  contents.on('console-message', (details) => {
    if (details.level !== 'error') return
    const first = String(details.message).split(/\r?\n/u, 1)[0] ?? ''
    log.write('error', {
      event: 'renderer.error',
      message: redactAndCut(first, RENDERER_MESSAGE_LIMIT, log.redact),
      source: redactAndCut(fileNameOf(String(details.sourceId)), RENDERER_SOURCE_LIMIT, log.redact),
      line: Number.isInteger(details.lineNumber) ? details.lineNumber : 0,
      repeats: 1,
    })
  })
}

/** `value` when it is a finite integer, else `fallback` (an exit code Electron did not give). */
function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

/** `value` when it is a non-empty string, else null. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Logs an Electron process that went away (acceptance 8): `render-process-gone` is the window's
 * renderer, `child-process-gone` any other child Electron manages (GPU, utility, …); the event
 * says which, not the details. A process that left cleanly is not a failure and leaves no line.
 * Neither event covers a Node `child_process` or a normal quit (E4, P3). The listeners never
 * throw: an error here would be a second uncaught error from inside the report of the first.
 */
export function watchProcessExits(
  app: {
    on(
      event: 'render-process-gone',
      listener: (event: unknown, contents: unknown, details: unknown) => void,
    ): unknown
    on(event: 'child-process-gone', listener: (event: unknown, details: unknown) => void): unknown
  },
  log: AppLog,
): void {
  const note = (processName: string, details: unknown): void => {
    try {
      const fields = (typeof details === 'object' && details !== null ? details : {}) as {
        reason?: unknown
        exitCode?: unknown
        name?: unknown
      }
      const reason = textOrNull(fields.reason) ?? 'unknown'
      if (reason === 'clean-exit') return
      const name = textOrNull(fields.name)
      log.write('error', {
        event: 'process.gone',
        process: processName,
        reason,
        exitCode: integerOr(fields.exitCode, -1),
        ...(name === null ? {} : { name }),
      })
    } catch {
      // a details object that cannot be read is not worth a second failure
    }
  }
  app.on('render-process-gone', (_event, _contents, details) => {
    note('renderer', details)
  })
  app.on('child-process-gone', (_event, details) => {
    let type = 'unknown'
    try {
      type = textOrNull((details as { type?: unknown } | null)?.type) ?? type
    } catch {
      // the type stays unknown
    }
    note(type, details)
  })
}

/**
 * Logs what nobody in the main process caught (acceptance 9). An exception goes to Node's
 * `uncaughtExceptionMonitor`, which only watches: Electron's own error box and its "do not quit"
 * stay as they are, and no `uncaughtException` listener is added, because one would take that box
 * away (P2). A lone Promise rejection never reaches the monitor in Electron (P2), so it has a
 * listener of its own that only writes a line. The line's origin is the event that fired, not the
 * `origin` argument the monitor passes.
 */
export function watchUncaught(
  proc: {
    on(event: 'uncaughtExceptionMonitor', listener: (error: Error, origin: string) => void): unknown
    on(
      event: 'unhandledRejection',
      listener: (reason: unknown, promise: Promise<unknown>) => void,
    ): unknown
  },
  log: AppLog,
): void {
  const note = (origin: 'uncaughtException' | 'unhandledRejection', error: unknown): void => {
    try {
      log.write('error', {
        event: 'main.uncaught',
        origin,
        error: summarizeError(error, log.redact),
      })
    } catch {
      // never throw out of a handler of the error that is being reported
    }
  }
  proc.on('uncaughtExceptionMonitor', (error) => note('uncaughtException', error))
  proc.on('unhandledRejection', (reason) => note('unhandledRejection', reason))
}
