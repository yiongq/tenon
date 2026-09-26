/**
 * The loop's limits (spec 02 §上限、守卫与用量). The step limit, the no-progress repeats and the
 * machine-denial cap are counted from the Tape, never in memory, so a restart keeps them (F3); the
 * three STOP_* waits are the stop and Bash-timeout sequence's (plan steps 22 and 23 calibrate them).
 * SUBAGENT_STEP_LIMIT and SUBAGENT_TOKEN_LIMIT are declared once the owner gives the numbers.
 */
export const STEP_LIMIT = 100 // 主会话，每条用户消息（H11 ownerNote）
export const NO_PROGRESS_REPEATS = 4 // master-reference.md:900
export const MACHINE_DENIAL_CAP = 3 // F2
export const RETRY_CAP = 2 // 02 全局重试上限，待校准（H12）
export const STOP_TERM_GRACE_MS = 500 // SIGTERM 之后等多久发 SIGKILL（停止与 Bash 超时同用），待校准
export const STOP_EXIT_CONFIRM_MS = 500 // SIGKILL 之后等 exited 的确认窗口，待校准；与上一项之和 ≤ 1000（§13 的 1 秒）
export const STOP_WRITE_WAIT_MS = 2_000 // 进程内写操作的等待上限，待校准；desktop 退出等待取它加 STOP_TERM_GRACE_MS，从这里导入
