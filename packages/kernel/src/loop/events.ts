/**
 * What the loop tells the host while it runs (spec 02 §主进程与 kernel 的循环接口). Every event is
 * sent AFTER the fact it reports is committed; the desktop's run-events.ts forwards only a root
 * session's events to the renderer (01 修补 6).
 */
import type { ConfirmTarget, Reversibility } from '../host/adapter.js'
import type { DecisionSummary } from '../permission/record.js'
import type { ProviderErrorCode, StopReason } from '../provider/types.js'
import type { SideEffectClass } from '../tape/entry.js'
import type { ClosureSource, ExecutionState } from './closure.js'
import type { SpillMark } from './spill.js'
import type { SubagentHandoff } from './subagent.js'
import type { RunEndReason } from './terminal.js'

export type SessionEvent = { readonly rootSessionId: string; readonly sessionId: string } & (
  | { type: 'run-started'; runId: string }
  | { type: 'text-delta' | 'thinking-delta'; runId: string; delta: string }
  | { type: 'attempt-discarded'; runId: string } // 这次 attempt 不写 assistant（作废或出错），撤回已流出的内容（§一轮回复怎么分流）
  | {
      type: 'tool-call'
      callKey: string
      providerToolCallId: string
      name: string
      input: Record<string, unknown>
    } // tool/call 提交之后
  | { type: 'tool-outcome'; callKey: string; providerToolCallId: string; outcome: ToolOutcomeView } // tool/result 与 tool_outcome 提交之后
  | { type: 'user-message'; runId: string; messageId: string; queuedId: string | null } // message/user 提交之后；排过队的带 queuedId
  | { type: 'queue-held'; host: string | null } // 新一轮要间接切到公网主机，排队项等确认；null = held 已清
  | {
      type: 'run-ended'
      runId: string | null
      reason: RunEndReason
      recorded: boolean // false：终态没进 Tape（新一轮缺 key；登记后 append 前被中止；退出时 TapeClosedError）
      lastStop: StopReason | null
      errorCode: ProviderErrorCode | null // 结束本 Run 的那次 error 事件的 code；新一轮缺 key（recorded: false）为 'auth'；被中止结束、没有 error 事件的为 null
      retryOf: string | null // 打开本 Run 的用户消息的 messageId，且本 Run 没有任何 dispatch_committed：「重试」重发它（§失败卡与结束原因）；由答复、「继续」、续跑、交接打开的 Run 与没打开 Run 的为 null
    }
)

/**
 * A closed call as the interface shows it: the same shape as contracts' `toolOutcomeViewShape`
 * (01 修补 6), declared here because the kernel does not import contracts.
 */
export interface ToolOutcomeView {
  readonly reversibility?: Reversibility
  readonly effect: SideEffectClass // 01 的四个值
  readonly state: ExecutionState
  readonly source: ClosureSource | null // null = 正常执行完
  readonly facts?: Readonly<Record<string, string>> // 只在 source 是拦截码时有，键按 BLOCKED_FACT_KEYS
  readonly output: string // 模型看到的文本；落盘的只有预览（H9）
  readonly permission?: DecisionSummary // 没有判决事实的调用没有这一项（F8）
  readonly approval?: {
    readonly outcome:
      | 'allowed'
      | 'denied'
      | 'cancelled-by-stop'
      | 'superseded'
      | 'tool-unavailable'
      | 'denied-on-rejudge'
    readonly scope: 'once' | 'session' | null
    readonly target: ConfirmTarget
  } // 只在出过卡的调用上有
  readonly question?: {
    readonly answers: Readonly<Record<string, readonly string[] | null>>
    readonly response?: string
    readonly preview?: SpillMark // 有回答只存了开头时才有（H9，Revisions 31）
  } // 只在答过的 AskUserQuestion 上有（开放问题 18）
  readonly handoff?: {
    readonly outcome: SubagentHandoff['outcome']
    readonly childEndReason: string | null
    readonly childSessionId: string
    readonly finalReply: string // 交接存下的子任务回复；结果落盘时只有开头（H9）
    readonly preview?: SpillMark // finalReply 只存了开头时才有（Revisions 31）
  } // 只在 Agent 调用上有（开放问题 18）
}

/** The handoff as a view shows it: its Tape fact without the rows the interface does not read. */
export function handoffView(handoff: SubagentHandoff): NonNullable<ToolOutcomeView['handoff']> {
  return {
    outcome: handoff.outcome,
    childEndReason: handoff.childEndReason,
    childSessionId: handoff.childSessionId,
    finalReply: handoff.finalReply,
    ...(handoff.preview === undefined ? {} : { preview: handoff.preview }),
  }
}
