/**
 * The Bash tool (spec 02 §内置工具与参数「Bash」).
 *
 * Plan step 9 declares only `CommandShell`, because `LoopPorts.commandShell` references it (open
 * question 17). The executor arrives in plan step 22 and does not change the shape.
 */
import type { AbsolutePath } from '../../host/adapter.js'

/**
 * The shell Bash runs under and its base environment, computed by the host: the kernel reads no
 * `process.env`, `$SHELL` or `PATH` of its own.
 */
export interface CommandShell {
  readonly path: AbsolutePath // argv[0]
  readonly env: () => Promise<Readonly<Record<string, string>>> // desktop 启动时开始解析并记住结果；kernel 每次起进程前取
}
