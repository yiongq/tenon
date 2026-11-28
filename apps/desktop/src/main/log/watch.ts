/**
 * The two watchers of segment one (docs/features/error-logs/spec.md §记什么): a request from the
 * window that came back `ok: false`, and the errors a window's page leaves on its console. Each is
 * handed what it watches and the log; neither imports electron.
 */
import type { IpcError, IpcMainLike } from '@tenon-app/contracts'
import type { AppLog } from './app-log.js'
import { redactAndCut } from './redact.js'

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
 * of a line longer than 16 384 characters only the start is looked at, and the count of what was
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
