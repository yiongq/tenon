/**
 * Bash's shell and base environment — `LoopPorts.commandShell` (spec 02 §内置工具与参数「Bash」,
 * 「desktop 怎么算」; open question 17, owner 2026-09-26). The kernel reads no `process.env`, `$SHELL`
 * or `PATH` of its own, so both halves are computed here:
 *
 *   - **the shell** is the user's login shell when it is one whose `-i -l -c` Tenon knows (zsh, bash,
 *     sh); anything else — fish, a relative path, a file that is gone — gives way to the first of
 *     `/bin/zsh`, `/bin/bash`, `/bin/sh` that exists.
 *   - **the base environment** is the one a new terminal starts with. An app opened from the Dock
 *     inherits launchd's short environment (no Homebrew `PATH`, no version managers), so once the app
 *     is ready the shell is run once, as a terminal runs it, and asked for its environment. `env()`
 *     waits for that answer; a timeout or a failure falls back to the environment Tenon was started
 *     with (snapshotted before `loadDevEnv`, so `.env.local` never leaks in) and logs one line. It is
 *     computed once: a changed rc file takes effect when Tenon restarts.
 *   - **what never reaches a command**: Tenon's own `TENON_*`, Electron's `ELECTRON_*`
 *     (`ELECTRON_RUN_AS_NODE` would turn every Electron-based CLI into a bare node) and, on a
 *     development build, the provider variables Tenon itself reads a key from (`DEV_ENV_FALLBACK`).
 *     The user's own tokens are not filtered by name: every command is asked about and the
 *     exfiltration check backs that up, while filtering would log gh, npm and their kind out.
 */
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, isAbsolute } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import type { AbsolutePath, ChildHandle, CommandShell, HostAdapter } from '@tenon-app/kernel'
import { DEV_ENV_FALLBACK } from '../provider.js'

/** How long the shell may take before its process tree is killed and the startup env stands in. */
export const SHELL_ENV_TIMEOUT_MS = 10_000

/** The shells run with `-i -l -c`; fish, nushell and the like take other flags. */
const KNOWN_SHELLS: ReadonlySet<string> = new Set(['zsh', 'bash', 'sh'])
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh'] as const

/** The one `SandboxRequest.commandId` this probe uses; it is no tool call's. */
const COMMAND_ID = 'shell-env'

const STRIPPED_PREFIXES = ['TENON_', 'ELECTRON_'] as const

export type EnvRecord = Readonly<Record<string, string>>

/** `os.userInfo().shell`, or null where it is unset or the user has no passwd entry. */
function loginShell(): string | null {
  try {
    return userInfo().shell
  } catch {
    return null
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The shell Bash runs under. `userShell` is `os.userInfo().shell`; it is used only when it is an
 * absolute path to a file named zsh, bash or sh. With none of the fallbacks present `/bin/sh` is
 * still named, and its spawn fails the way any missing executable does.
 */
export function pickShell(
  userShell: string | null | undefined = loginShell(),
  isFile: (path: string) => boolean = isRegularFile,
): AbsolutePath {
  if (
    typeof userShell === 'string' &&
    isAbsolute(userShell) &&
    KNOWN_SHELLS.has(basename(userShell)) &&
    isFile(userShell)
  ) {
    return absolutePath(userShell)
  }
  return absolutePath(FALLBACK_SHELLS.find((path) => isFile(path)) ?? '/bin/sh')
}

/** A copy of `process.env` as it is now; main() takes it before `loadDevEnv` touches anything. */
export function snapshotEnv(env: NodeJS.ProcessEnv = process.env): EnvRecord {
  const copy: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) copy[name] = value
  }
  return Object.freeze(copy)
}

/** `env` without `TENON_*`, `ELECTRON_*` and, unless packaged, the dev build's provider variables. */
export function withoutTenonVars(env: EnvRecord, isPackaged: boolean): EnvRecord {
  const devNames = new Set(
    isPackaged ? [] : Object.values(DEV_ENV_FALLBACK).flatMap((names) => Object.values(names)),
  )
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (STRIPPED_PREFIXES.some((prefix) => name.startsWith(prefix)) || devNames.has(name)) continue
    kept[name] = value
  }
  return Object.freeze(kept)
}

export interface CommandShellOptions {
  readonly host: Pick<HostAdapter, 'process' | 'sandbox' | 'clock'>
  /** `pickShell()`. */
  readonly shell: AbsolutePath
  /** `snapshotEnv()` from the top of main(): the probe's own env, and the fallback. */
  readonly startupEnv: EnvRecord
  /** Where the probe runs, as a new terminal opens in it. */
  readonly home: AbsolutePath
  readonly isPackaged: boolean
  readonly log: (line: string) => void
}

/**
 * Starts resolving the environment now, in the background, and returns the `CommandShell` that
 * hands it out. Call it once the app is ready; `env()` always answers the same frozen object.
 */
export function startCommandShell(options: CommandShellOptions): CommandShell {
  const resolved = resolveEnv(options).then((env) => withoutTenonVars(env, options.isPackaged))
  return { path: options.shell, env: () => resolved }
}

/** Never rejects: the shell's answer, or `startupEnv` with one line logged. */
async function resolveEnv(options: CommandShellOptions): Promise<EnvRecord> {
  const { host, shell, startupEnv, home, log } = options
  const fail = (why: string): EnvRecord => {
    log(`[shell-env] ${shell} ${why}; Bash uses the environment Tenon started with`)
    return startupEnv
  }
  const start = randomBytes(16).toString('hex')
  const end = randomBytes(16).toString('hex')
  // rc files may print anything, so only what lies between the two markers is read. `&&`: an `env`
  // that failed prints no end marker, and half an environment is never taken.
  const script = `printf '%s' '${start}'; /usr/bin/env -0 && printf '%s' '${end}'`
  let child: ChildHandle
  try {
    // AGENTS.md: every subprocess goes through the sandbox wrapper. The probe only reads, so it asks
    // for `read-only`; phase 2's wrapper passes it through and logs that.
    const wrapped = await host.sandbox.wrap({
      commandId: COMMAND_ID,
      argv: [shell, '-i', '-l', '-c', script],
      cwd: home,
      env: { ...startupEnv },
      profile: 'read-only',
      workspace: [],
    })
    child = await host.process.spawn({
      argv: wrapped.argv,
      cwd: home,
      env: wrapped.env,
      stdio: 'pipe',
    })
  } catch (error) {
    return fail(`did not start: ${error instanceof Error ? error.message : String(error)}`)
  }
  void child.exited.then(() => host.sandbox.afterExit(COMMAND_ID)).catch(() => {})
  return readEnv(child, host.clock, start, end, fail).catch((error: unknown) =>
    fail(`could not be read: ${error instanceof Error ? error.message : String(error)}`),
  )
}

/**
 * Reads `child`'s stdout up to the end marker, answering once (`fail` is called at most once). The
 * timer outlives an early answer: a shell still running after `SHELL_ENV_TIMEOUT_MS` is killed, tree
 * and all, either way. The pipes are read to the end until the shell has exited as well, so a logout
 * file that prints after the answer gets no SIGPIPE.
 */
function readEnv(
  child: ChildHandle,
  clock: HostAdapter['clock'],
  start: string,
  end: string,
  fail: (why: string) => EnvRecord,
): Promise<EnvRecord> {
  return new Promise<EnvRecord>((resolve) => {
    const stdin = child.stdin.getWriter()
    // Hosts error stdin when the child exits; an rc file that reads the terminal gets EOF.
    void stdin.closed.catch(() => {})
    void stdin.close().catch(() => {})
    const stdout = child.stdout.getReader()
    const stderr = child.stderr.getReader()
    let settled = false
    let exited = false
    let cleaned = false

    // SIGKILL straight away: the probe has nothing to save, and a hung rc file may ignore SIGTERM.
    const cancelTimer = clock.setTimeout(() => {
      void child.kill('SIGKILL').catch(() => {})
      settle(null, `did not answer within ${String(SHELL_ENV_TIMEOUT_MS)} ms`)
    }, SHELL_ENV_TIMEOUT_MS)

    /** Once answered and exited: a descendant that inherited the pipes keeps them open past exit. */
    function cleanUp(): void {
      if (cleaned || !settled || !exited) return
      cleaned = true
      cancelTimer()
      void stdout.cancel().catch(() => {})
      void stderr.cancel().catch(() => {})
    }

    function settle(env: EnvRecord | null, why: string): void {
      if (settled) return
      settled = true
      resolve(env ?? fail(why))
      cleanUp()
    }

    void child.exited.then(() => {
      exited = true
      cleanUp()
    })
    void drain(stderr)
    void (async (): Promise<void> => {
      const decoder = new TextDecoder('utf-8')
      let text = ''
      let started = false
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop
          const { done, value } = await stdout.read()
          if (done) break
          if (settled) continue
          text += decoder.decode(value, { stream: true })
          if (!started) {
            const at = text.indexOf(start)
            if (at === -1) {
              // Junk before the marker is dropped as it comes; only a marker's worth is kept.
              text = text.slice(-(start.length - 1))
              continue
            }
            started = true
            text = text.slice(at + start.length)
          }
          const stop = text.indexOf(end)
          if (stop !== -1) {
            settle(parseEnv0(text.slice(0, stop)), '')
            text = ''
          }
        }
      } catch {
        /* a read error is the same as no answer */
      }
      // stdout closed without the end marker; say how the shell ended (or let the timer say it).
      void child.exited.then(({ code, signal }) =>
        settle(null, `exited (${String(signal ?? code)}) without printing its environment`),
      )
    })()
  })
}

/** `env -0`: NUL-terminated `NAME=value` entries, where a value may hold newlines. */
function parseEnv0(text: string): EnvRecord {
  const env: Record<string, string> = {}
  for (const entry of text.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return Object.freeze(env)
}

/** stderr is read and dropped: a shell whose pipe fills up blocks. */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const { done } = await reader.read()
      if (done) return
    }
  } catch {
    /* cancelled or errored: nothing to keep either way */
  }
}
