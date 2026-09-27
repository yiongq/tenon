/**
 * The Bash tool (spec 02 §内置工具与参数「Bash」). The executor lands with plan step 22.
 *
 * `CommandShell` is declared here because `LoopPorts.commandShell` references it (plan step 9, open
 * question 17). The batch awaits `commandShell.env()` before the dispatch, raced against the stop,
 * and hands the executor what it resolved to as `CommandRun.env` (loop/batch.ts).
 *
 * One call, one process, the same path as `mcp/connection.ts`: `HostSandbox.wrap`, then
 * `HostProcess.spawn`, then `afterExit` once it exited. The shell runs `exec 2>&1` and only then
 * hands the command to the same shell binary (`COMMAND_SCRIPT`), so stderr joins stdout at the
 * file-descriptor level before the command is even parsed — zsh parses a whole `-c` string before it
 * runs any of it, and its parse errors would otherwise go to the stderr nobody reads — and only stdout
 * is read, in the order the shell wrote it. The stop and the timeout share one kill sequence —
 * SIGTERM, `STOP_TERM_GRACE_MS`, then SIGKILL unconditionally (the direct child's exit says nothing
 * of its group, §点停止时各状态怎么收「执行命令」) — and `exited` within `STOP_EXIT_CONFIRM_MS` of the
 * SIGKILL records `aborted`, anything later `uncertain`. Plan step 23 calibrates the constants.
 */
import type { AbsolutePath, ChildHandle, HostAdapter, HostClock } from '../../host/adapter.js'
import { STOP_EXIT_CONFIRM_MS, STOP_TERM_GRACE_MS } from '../../loop/limits.js'
import { fill } from '../../prompts/index.js'
import type { ToolExecution, ToolExecutor } from '../executor.js'
import { failed } from './files.js'
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, noChecks } from './tool.js'
import { messageOf } from './write.js'

/**
 * The shell Bash runs under and its base environment, computed by the host: the kernel reads no
 * `process.env`, `$SHELL` or `PATH` of its own.
 */
export interface CommandShell {
  readonly path: AbsolutePath // argv[0]
  readonly env: () => Promise<Readonly<Record<string, string>>> // desktop 启动时开始解析并记住结果；kernel 每次起进程前取
}

/** What one Bash call runs with, gathered by the batch before its dispatch. */
export interface CommandRun {
  /** `SandboxRequest.commandId`: the call's `providerToolCallId` (adapter.ts). */
  readonly commandId: string
  readonly shell: AbsolutePath
  /** What `commandShell.env()` resolved to; the kernel adds nothing to it. */
  readonly env: Readonly<Record<string, string>>
  /** The workspace facts' folders, in order: `folders[0]` is the cwd (§工作区). */
  readonly folders: readonly AbsolutePath[]
  /** The session's dedicated folder, which does not exist before its first Write or Bash (§工作区). */
  readonly dedicated: boolean
  readonly host: Pick<HostAdapter, 'process' | 'sandbox' | 'clock'>
}

/** Bash's default timeout, in milliseconds (sdk-tools:796). */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000
/** The largest timeout the schema accepts, in milliseconds (sdk-tools:796). */
export const BASH_MAX_TIMEOUT_MS = 600_000

const DESCRIPTION = [
  'Runs a shell command and returns its output, with stdout and stderr together.',
  'Every call starts a new shell in the first workspace folder, so `cd` does not carry over to the next call.',
  'A command that exits with a non-zero code is reported as an error whose first line is `Exit code: N`.',
  `It is stopped after ${String(BASH_DEFAULT_TIMEOUT_MS)} ms unless timeout says otherwise (at most ${String(BASH_MAX_TIMEOUT_MS)} ms).`,
  'There is no background mode.',
  'Use Read, Glob and Grep rather than cat, find or grep, and Edit or Write rather than editing files from the shell.',
].join(' ')

/**
 * The outer shell's script (§内置工具与参数「Bash」「起进程」): stderr into stdout, then the same
 * shell (`$0`) replaces it and parses the command (`$1`). `--` ends the inner shell's options, so a
 * command that begins with `-` is a command, as it would be in a terminal; the inner shell sees no
 * positional parameters.
 */
export const COMMAND_SCRIPT = 'exec 2>&1; exec "$0" -c -- "$1"'

/** Bash's result template and its own errors (§内置工具与参数「Bash」「输出」; in the prompt layer). */
export const BASH_TEXTS = {
  exitCode: 'Exit code: {code}',
  killedBy: 'Killed by signal: {signal}',
  noOutput: '(no output)',
  notStarted: 'The command could not be started: {message}',
} as const

export const BASH_TOOL: BuiltinTool = {
  name: 'Bash',
  spec: () => ({
    name: 'Bash',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, description: 'The command to run.' },
        timeout: {
          type: 'integer',
          minimum: 1,
          maximum: BASH_MAX_TIMEOUT_MS,
          description: `How long the command may run, in milliseconds (default ${String(BASH_DEFAULT_TIMEOUT_MS)}).`,
        },
        description: {
          type: 'string',
          description: 'A few words saying what the command does, shown to the user.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  }),
  effect: 'external',
  profiles: COWORK_ONLY,
  check: noChecks,
  texts: BASH_TEXTS,
}

/** Runs the command in `folders[0]`; its output, or how the stop or the timeout left it. */
export const bashExecutor: ToolExecutor = async (q) => {
  const run = q.command
  if (run === undefined) throw new Error('Bash: a call reached its executor with no command run')
  const cwd = run.folders[0]
  if (cwd === undefined) throw new Error('Bash: a call reached its executor with no workspace')
  const { clock, sandbox } = run.host
  const command = String(q.input['command'])
  const timeout =
    typeof q.input['timeout'] === 'number' ? q.input['timeout'] : BASH_DEFAULT_TIMEOUT_MS
  let child: ChildHandle
  try {
    if (run.dedicated) await q.fs.mkdirp(cwd)
    const wrapped = await sandbox.wrap({
      commandId: run.commandId,
      argv: [run.shell, '-c', COMMAND_SCRIPT, run.shell, command],
      cwd,
      env: { ...run.env },
      profile: 'workspace-write', // phase 2's wrap passes through: the intent only
      workspace: [...run.folders],
    })
    // A stop that landed while the folder was made or the command wrapped: nothing is started.
    if (q.signal.aborted) return { content: [], isError: true, state: 'aborted' }
    child = await run.host.process.spawn({
      argv: wrapped.argv,
      cwd,
      env: wrapped.env,
      stdio: 'pipe',
    })
  } catch (error) {
    return failed(fill(BASH_TEXTS.notStarted, { message: messageOf(error) }))
  }
  const afterExit = child.exited.then(() => sandbox.afterExit(run.commandId)).catch(() => {})
  void child.stdin.close().catch(() => {})
  const output = readOutput(child.stdout)

  // The timeout runs from the moment the spawn succeeded; the first of exit, timeout and stop wins.
  const ended = Promise.withResolvers<'exited' | 'timed-out' | 'stopped'>()
  const cancelTimeout = clock.setTimeout(() => ended.resolve('timed-out'), timeout)
  const onStop = (): void => ended.resolve('stopped')
  q.signal.addEventListener('abort', onStop, { once: true })
  if (q.signal.aborted) onStop()
  void child.exited.then(() => ended.resolve('exited'))
  const how = await ended.promise
  cancelTimeout()
  q.signal.removeEventListener('abort', onStop)

  if (how === 'exited') {
    const exit = await child.exited
    // A process left in the background may hold the pipe for good (stdio-transport.ts:96).
    await drainWithin(output, clock, STOP_EXIT_CONFIRM_MS)
    await afterExit
    void child.stderr.cancel().catch(() => {})
    return commandResult(exit, output.text())
  }
  // One sequence for the stop and the timeout; a stop during a timeout's kill stays `timed-out`.
  await child.kill('SIGTERM').catch(() => {})
  await sleep(clock, STOP_TERM_GRACE_MS)
  await child.kill('SIGKILL').catch(() => {})
  const window = timer(clock, STOP_EXIT_CONFIRM_MS)
  const confirmed = await Promise.race([
    child.exited.then(() => true),
    window.elapsed.then(() => false),
  ])
  if (confirmed) await Promise.race([output.done, window.elapsed])
  window.cancel()
  await output.cancel()
  if (confirmed) await afterExit
  void child.stderr.cancel().catch(() => {})
  const text = output.text()
  return {
    content: text === '' ? [] : [{ type: 'text', text }],
    isError: true,
    state: confirmed ? 'aborted' : 'uncertain',
    ...(how === 'timed-out' ? { source: 'timed-out' as const } : {}),
  }
}

/** A command that exited on its own: its output, headed by how it failed when it did. */
export function commandResult(
  exit: { readonly code: number | null; readonly signal: string | null },
  output: string,
): ToolExecution {
  const head =
    exit.code !== null && exit.code !== 0
      ? fill(BASH_TEXTS.exitCode, { code: String(exit.code) })
      : exit.code === null && exit.signal !== null
        ? fill(BASH_TEXTS.killedBy, { signal: exit.signal })
        : null
  const body = output === '' ? BASH_TEXTS.noOutput : output
  return {
    content: [{ type: 'text', text: head === null ? body : `${head}\n${body}` }],
    isError: head !== null,
    state: 'completed',
  }
}

/** One stream read to its end, decoded as UTF-8 as it arrives; bad bytes become U+FFFD. */
interface OutputReader {
  readonly done: Promise<void>
  text(): string
  /** Stops reading: what arrived so far is the output. */
  cancel(): Promise<void>
}

/**
 * A read that throws is a pipe that broke: the output ends where it broke. An append that throws is
 * the text past the longest string the engine can hold (V8: 2^29 − 24 code units, a RangeError): the
 * text stays as it was, and the pipe is still drained to its end, so the command is not held on a full
 * pipe until the timeout and ends the way it ends. A long output is spilled by the batch (§大响应落盘).
 */
function readOutput(stream: ReadableStream<Uint8Array>): OutputReader {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let text = ''
  let full = false
  const append = (piece: () => string): void => {
    if (full) return
    try {
      text += piece()
    } catch {
      full = true
    }
  }
  const done = (async (): Promise<void> => {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        // oxlint-disable-next-line no-await-in-loop -- a pipe is read one chunk after another
        chunk = await reader.read()
      } catch {
        break
      }
      if (chunk.done) break
      const { value } = chunk
      append(() => decoder.decode(value, { stream: true }))
    }
    append(() => decoder.decode())
  })()
  return {
    done,
    text: () => text,
    cancel: async () => {
      await reader.cancel().catch(() => {})
      await done
    },
  }
}

/** Waits for the rest of the output at most `ms`, then stops reading. */
async function drainWithin(output: OutputReader, clock: HostClock, ms: number): Promise<void> {
  const window = timer(clock, ms)
  await Promise.race([output.done, window.elapsed])
  window.cancel()
  await output.cancel()
}

function timer(clock: HostClock, ms: number): { elapsed: Promise<void>; cancel: () => void } {
  const elapsed = Promise.withResolvers<void>()
  const cancel = clock.setTimeout(() => elapsed.resolve(), ms)
  return { elapsed: elapsed.promise, cancel }
}

function sleep(clock: HostClock, ms: number): Promise<void> {
  return timer(clock, ms).elapsed
}
