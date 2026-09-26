/**
 * How a single tool call is closed (spec 02 §原因码表). §02 的 Tape 事实, §子 agent 契约 and
 * §权限引擎 · Inspector 与判决记录 reference these names; the vocabulary only grows.
 *
 * Declared in plan step 8 because `ToolOutcomePayload` (§载荷) references them. `BLOCKED_FACT_KEYS`
 * belongs to this file too and arrives with the decision table in step 11.
 */

export type ExecutionState = 'not-run' | 'aborted' | 'completed' | 'uncertain'

export type BlockReason = 'policy' | 'user-disabled' | 'protected' | 'inspector' // 阶段 4 只增 'sandbox'

export type ClosureSource =
  | BlockReason
  | 'user-rejected'
  | 'stopped'
  | 'timed-out' // Bash ran past its timeout (open question 17)
  | 'superseded'
  | 'tool-unavailable'
  | 'invalid-input' // arguments failed validation before permission (open question 16)
  | 'crashed'
  | 'app-exit'
  | 'output-truncated'
  | 'step-limit'
  | 'no-progress'
  | 'usage-limit'
  | 'blocked-repeatedly'
  | 'content-filter'
  | 'provider-error'
  | 'repair'
  | 'no-preference'
  | 'unanswered'
  | 'typed-answer'
