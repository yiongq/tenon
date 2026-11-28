/**
 * What Tenon does when it cannot start, and the way to its log folder from the Help menu
 * (docs/features/error-logs/spec.md §启动失败, §打开日志文件夹, §接口). Everything Electron knows —
 * the dialog, the shell, `app.exit`, whether the app is ready, the system's languages — is handed
 * in, so the order of the steps can be tested with stand-ins. No electron import.
 */
import type { AbsolutePath } from '@tenon-app/kernel'
import { createI18n } from '../../i18n/create-instance.js'
import { resolveLocale } from '../../i18n/resolve-locale.js'
import type { AppLog } from './app-log.js'
import { summarizeError } from './redact.js'

/** The catalogue in the language of the system's list: zh-CN, or en when nothing there is Chinese or English. */
async function catalogue(languages: readonly string[]) {
  return await createI18n(resolveLocale(languages), () => {})
}

/**
 * Tenon did not start: first the line `app.startup-failed` (a log that is not open is opened first,
 * on the folder it would have used), then the wait for ready (before it a box only reaches stderr
 * on Linux, E7), then the box, then the exit with 1. The running marker stays, so the next start
 * says the last one did not end well. Every step is guarded: one that fails does not keep the
 * exit from happening.
 */
export async function reportStartupFailure(q: {
  readonly error: unknown
  readonly log: AppLog
  /** Opens the log on the folder worked out for it; called only when the log is not open. */
  readonly openFallback: () => void
  /** Resolves when Electron is ready. */
  readonly whenReady: () => Promise<void>
  /** Electron's `dialog.showErrorBox`: blocks until the box is closed. */
  readonly showErrorBox: (title: string, content: string) => void
  /** Electron's `app.exit`. */
  readonly exit: (code: number) => void
  /** The system's preferred languages, most preferred first. */
  readonly languages: readonly string[]
}): Promise<void> {
  try {
    if (q.log.dir === null) {
      try {
        q.openFallback()
      } catch {
        // the line below still goes to the buffer and to stderr where there is one
      }
    }
    q.log.write('error', {
      event: 'app.startup-failed',
      error: summarizeError(q.error, q.log.redact),
    })
    try {
      await q.whenReady()
    } catch {
      // the box can be shown before ready too (on Linux it only reaches stderr); the exit follows
    }
    try {
      const i18n = await catalogue(q.languages)
      const dir = q.log.dir
      // With no folder none is named; with one, it is written as the log writes paths: home is `~`.
      q.showErrorBox(
        i18n.t('logs.startupFailed.title'),
        dir === null
          ? i18n.t('logs.startupFailed.bodyNoLog', {
              error: summarizeError(q.error, q.log.redact).name,
            })
          : i18n.t('logs.startupFailed.body', { folder: q.log.redact(dir) }),
      )
    } catch {
      // a box that cannot be shown does not keep the app from ending
    }
  } finally {
    q.exit(1)
  }
}

/**
 * The Help menu's 「打开日志文件夹」: the folder goes to the system as it is; a system that says it
 * could not open it gets a box that names the path, in full, since the point is that the user can
 * go there. With no log folder (the log never opened) there is nothing to hand over.
 */
export async function openLogsFolder(q: {
  readonly dir: AbsolutePath | null
  /** Electron's `shell.openPath`: resolves to '' when it opened, else to a message. */
  readonly openPath: (path: string) => Promise<string>
  readonly showErrorBox: (title: string, content: string) => void
  readonly languages: readonly string[]
}): Promise<void> {
  const dir = q.dir
  if (dir === null) return
  let opened = false
  try {
    opened = (await q.openPath(dir)) === ''
  } catch {
    // a refusal is the same as a message: the folder was not opened
  }
  if (opened) return
  try {
    const i18n = await catalogue(q.languages)
    q.showErrorBox(i18n.t('logs.openFailed.title'), i18n.t('logs.openFailed.body', { folder: dir }))
  } catch {
    // the click has nothing more to say
  }
}
