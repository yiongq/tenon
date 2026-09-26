/**
 * The sub-agent handoff (spec 02 §交接): what a parent session's Agent call gets back, generated
 * mechanically from the child session's tape — never by a model.
 *
 * Declared in plan step 8 because `ToolResultPayload.handoff` (§载荷) references it. If the
 * sub-agent is cut (plan.md 进度吃紧时的砍法), this shape stays: ① and ② already depend on it.
 */
import type { RunUsageLine } from '../tape/entry.js'
import type { ClosureSource, ExecutionState } from './closure.js'
import type { RunEndReason } from './terminal.js'

export interface SubagentHandoff {
  readonly childSessionId: string
  readonly outcome: 'completed' | 'partial' | 'aborted' | 'superseded' | 'uncertain'
  readonly childEndReason: RunEndReason['code'] | null // 子会话最后一个 Run 的结束原因；子会话停在等待上时被停止或取代，记 null
  readonly finalReply: string // 子会话最后一条 message/assistant 的文本块原样拼接，没有就是 ''
  readonly calls: readonly HandoffCall[] // 子会话的每个工具调用各占一行，按 Tape 顺序
  readonly usage: readonly RunUsageLine[] // 子会话各 Run 的 run_terminal.usage，按 (providerId, modelId) 合并，origin 为 'own'
}

export interface HandoffCall {
  readonly toolName: string
  readonly target: string // 与审批卡的「对象」用同一算法（E4）
  readonly state: ExecutionState
  readonly source: ClosureSource | null // 没正常执行完的才有，例如 user-rejected（F2）
}
