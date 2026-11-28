/**
 * The events the app log takes (docs/features/error-logs/spec.md §接口). Nothing else reaches the
 * write entry: a new kind of event is added here first, and the test's sentinel table
 * (`satisfies Record<LogEvent['event'], …>`) will not compile until it has a row.
 *
 * No electron import: the values Electron knows (version, folders, build kind) are handed in.
 */
import type { IpcError } from '@tenon-app/contracts'

/** error: something went wrong and wants a look; warn: a downgrade, a refusal or a drop; info: lifecycle. */
export type LogLevel = 'error' | 'warn' | 'info'

/** An error as the log keeps it: never the whole object (spec §接口 `ErrorSummary`). */
export interface ErrorSummary {
  /** The constructor's name, else `error.name`. */
  readonly name: string
  /** `error.code`, as `ENOENT`. */
  readonly code?: string
  /** Redacted first, then cut to 500 characters. */
  readonly message: string
  /** The first ten stack frames, each redacted first, then cut to 300 characters. */
  readonly frames?: readonly string[]
}

export type LogEvent =
  | {
      readonly event: 'app.start'
      readonly packaged: boolean
      readonly platform: string
      readonly arch: string
      readonly userData: string
    }
  | {
      readonly event: 'app.unclean-exit'
      readonly startedAt: string | null
      readonly version: string | null
    }
  | { readonly event: 'app.startup-failed'; readonly error: ErrorSummary }
  | { readonly event: 'app.quit' }
  | { readonly event: 'window.shown' }
  | {
      readonly event: 'sandbox.posture'
      readonly state: 'active' | 'degraded' | 'unavailable'
      readonly reasons: readonly string[]
    }
  | {
      readonly event: 'sandbox.helpers'
      readonly packageDir: string
      readonly applySeccomp: string
      readonly javaAgentJar: string
    }
  | {
      readonly event: 'main.uncaught'
      readonly origin: 'uncaughtException' | 'unhandledRejection'
      readonly error: ErrorSummary
    }
  | {
      readonly event: 'process.gone'
      readonly process: string
      readonly reason: string
      readonly exitCode: number
      readonly name?: string
    }
  | {
      readonly event: 'ipc.failed'
      readonly channel: string
      readonly code: IpcError['code']
      readonly message: string
    }
  | {
      readonly event: 'renderer.error'
      readonly message: string
      readonly source: string
      readonly line: number
      readonly repeats: number
    }
  /** What the cap per source threw away, and what the buffer before `open` could not hold. */
  | { readonly event: 'log.dropped'; readonly source: string; readonly count: number }
  /** One line of text, from the `log` callback of a module. */
  | { readonly event: 'line'; readonly source: string; readonly text: string }
