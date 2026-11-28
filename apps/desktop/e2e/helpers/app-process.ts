/**
 * Starting and ending the app as a process, for the cases of docs/features/error-logs that Playwright
 * cannot do (plan step 3.1): a start that fails, a kill, a crash. Playwright's Electron launcher
 * waits for a debugger connection and adds Chromium switches, one of which turns the crash
 * reporter off (`--disable-breakpad`, evidence.md E7), so a process that is to be killed, or crashed
 * and looked at afterwards, is started the way `single-instance.spec.ts` starts its second instance:
 * the Electron binary, spawned directly.
 *
 * - `spawnTenon` is that spawn, with the environment `launchTenon` gives (`appEnvironment`: memory
 *   secrets, no developer `.env.local`, the fake sandbox).
 * - What a case reads is the files the app leaves (`helpers/app-log.ts`), never the process's
 *   output; the output is kept only to say what happened when a case fails.
 * - Every process this module starts is remembered, and `killSpawnedApps` ends the ones still alive;
 *   a spec calls it from `afterEach`, so a failed case leaves no Electron behind.
 */
import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { ElectronApplication } from '@playwright/test'
import { appEnvironment } from './app-env.js'
import { appLogRecords } from './app-log.js'
import type { AppLogRecord } from './app-log.js'

/** The Electron binary: what `require('electron')` is in Node, a path. */
const electronPath = createRequire(import.meta.url)('electron') as string

/** An absolute path of a file next to this one. */
export function helperFile(name: string): string {
  return fileURLToPath(new URL(name, import.meta.url))
}

export type EntryKind =
  /** `./out/main/index.js`, as Playwright's launcher and `single-instance.spec.ts` give it. */
  | 'file'
  /** `.`, the app folder: how a development start runs it (`electron .`), so the version is package.json's. */
  | 'app'

export interface SpawnOptions {
  readonly userData: string
  /** Extra environment, over `appEnvironment`'s. */
  readonly env?: Readonly<Record<string, string>>
  /** The app's entry: `file` (default), `app`, or the absolute path of an entry script of the test's own. */
  readonly entry?: EntryKind | { readonly script: string }
  /** The system languages the app takes (the `TENON_LOCALE` test seam). */
  readonly systemLanguages?: readonly string[]
  /** A `.cjs` file loaded into the main process before the app, through `NODE_OPTIONS=--require`. */
  readonly preload?: string
}

export interface ExitStatus {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface SpawnedApp {
  readonly child: ChildProcess
  readonly pid: number
  /** Settles when the process is gone. */
  readonly exited: Promise<ExitStatus>
  /** The tail of what it wrote to stderr and stdout, to say what happened when a case fails. */
  output(): string
  isAlive(): boolean
  /** Sends `signal`; false when the process is already gone. */
  signal(signal: NodeJS.Signals): boolean
  /** SIGKILL when it is still there; resolves once it is gone. */
  kill(): Promise<ExitStatus>
}

const live = new Set<SpawnedApp>()

/** Ends every process `spawnTenon` started that is still alive; call from `afterEach`. */
export async function killSpawnedApps(): Promise<void> {
  await Promise.all([...live].map((app) => app.kill()))
}

/** The entry argument(s) of the Electron command line. */
function entryArgs(entry: SpawnOptions['entry']): string[] {
  if (entry === undefined || entry === 'file') return ['./out/main/index.js']
  if (entry === 'app') return ['.']
  return [entry.script]
}

/** Starts the app as a process of its own, in the app's folder (the Playwright config's `cwd`). */
export function spawnTenon(options: SpawnOptions): SpawnedApp {
  const env = appEnvironment(process.env, {
    env: options.env,
    systemLanguages: options.systemLanguages,
  })
  if (options.preload !== undefined) {
    env['NODE_OPTIONS'] = `--require ${JSON.stringify(options.preload)}`
  }
  const child = spawn(
    electronPath,
    [
      // Match Playwright's Linux launch flags (CI runs without Chromium's outer sandbox).
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ...entryArgs(options.entry),
      `--user-data-dir=${options.userData}`,
    ],
    { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (child.pid === undefined) throw new Error('the app did not start: no pid')
  let tail = ''
  const keep = (chunk: Buffer): void => {
    tail = (tail + chunk.toString('utf8')).slice(-8_000)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const exited = new Promise<ExitStatus>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const app: SpawnedApp = {
    child,
    pid: child.pid,
    exited,
    output: () => tail,
    isAlive: () => child.exitCode === null && child.signalCode === null,
    signal: (signal) => (app.isAlive() ? child.kill(signal) : false),
    async kill() {
      if (app.isAlive()) child.kill('SIGKILL')
      const status = await exited
      live.delete(app)
      return status
    },
  }
  live.add(app)
  void exited.then(() => live.delete(app))
  return app
}

/** A normal quit by SIGTERM (the fake sandbox never takes the signal over, so it is the native quit). */
export async function quitBySigterm(app: SpawnedApp): Promise<void> {
  app.signal('SIGTERM')
  const status = await exitWithin(app, 30_000)
  if (status === null) throw new Error(`the app did not quit on SIGTERM:\n${app.output()}`)
}

/** The status of `app` if it is gone within `ms`, else null. */
export async function exitWithin(app: SpawnedApp, ms: number): Promise<ExitStatus | null> {
  const none = Symbol('none')
  const timer = new Promise<typeof none>((resolve) => setTimeout(() => resolve(none), ms))
  const result = await Promise.race([app.exited, timer])
  return result === none ? null : result
}

/** How many lines of `event` the log has so far. */
export function countEvents(userData: string, event: string): number {
  return appLogRecords(userData).filter((record) => record.event === event).length
}

/** The records of `event`, in the order written. */
export function recordsOf(userData: string, event: string): AppLogRecord[] {
  return appLogRecords(userData).filter((record) => record.event === event)
}

/** `app.quit()`, as the menu's Quit and Cmd+Q call it, on an app Playwright started; resolves once it is gone. */
export async function quitAndWait(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ app: electronApp }) => electronApp.quit())
  await closed
}

/** Whether `pid` is a live process: not gone, and not a zombie waiting to be reaped. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .startsWith('Z')
  } catch {
    return false
  }
}

/** The pids of the processes below `root`, `root` itself not among them, with their command lines. */
export function descendants(root: number): Array<{ pid: number; command: string }> {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const rows = table
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line))
    .flatMap((match) =>
      match === null
        ? []
        : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' }],
    )
  const found: Array<{ pid: number; command: string }> = []
  const queue = [root]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const row of rows) {
      if (row.ppid !== parent) continue
      found.push({ pid: row.pid, command: row.command })
      queue.push(row.pid)
    }
  }
  return found
}

/** The pid of the renderer process of the app `main`, or null while there is none. */
export function rendererPidOf(main: number): number | null {
  return descendants(main).find((one) => one.command.includes('--type=renderer'))?.pid ?? null
}
