/**
 * The Bash tool (spec 02 §内置工具与参数「Bash」).
 *
 * `CommandShell` is declared here because `LoopPorts.commandShell` references it (plan step 9, open
 * question 17); the definition is plan step 10's; the executor arrives in plan step 22.
 */
import type { AbsolutePath } from '../../host/adapter.js'
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, noChecks } from './tool.js'

/**
 * The shell Bash runs under and its base environment, computed by the host: the kernel reads no
 * `process.env`, `$SHELL` or `PATH` of its own.
 */
export interface CommandShell {
  readonly path: AbsolutePath // argv[0]
  readonly env: () => Promise<Readonly<Record<string, string>>> // desktop 启动时开始解析并记住结果；kernel 每次起进程前取
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
}
