/**
 * The decision record and the summary the interface gets (spec 02 §判决记录与摘要).
 *
 * The record — who said what on which basis, layer by layer — goes into
 * `tool/permission_decided.record` and stays on the tape (F8). The summary is a code plus slots,
 * computed once when the decision is made and stored in the payload's `summary`; it is the only half
 * that crosses IPC.
 *
 * Declared in plan step 8 because `PermissionDecidedPayload` (§载荷) references these types.
 * `summarize` arrives with the decision table in plan step 11 and does not change the shapes.
 *
 * The spec's code block names `decide.ts` and `record.ts` together without splitting it; the record
 * and its summary live here and `Decision`, the output of `decide()`, lives in `decide.ts`.
 */
import type { FlaggedCategory, InspectorFinding } from './inspector.js'

export type DecisionSource = // D2 表的层名，只增
  | 'tenant-policy'
  | 'protected'
  | 'user-disabled'
  | 'irreversible'
  | 'connector-confirm' // 第 4 层「必须问」按来源分两个值
  | 'inspector'
  | 'user-grant'
  | 'approval-mode'
  | 'default'

export interface DecisionStep {
  readonly by: DecisionSource
  readonly inspectorId?: string // by 为 'inspector' 时必有；这时 said 不会是 'allow'
  readonly said: 'deny' | 'ask' | 'allow' | 'none'
  readonly basis?: {
    readonly policyId?: string
    readonly grant?:
      | 'session'
      | 'session-search'
      | 'session-domain'
      | 'always-allow'
      | 'workspace-folder'
      | 'task'
    readonly inherited?: true // 授权继承自父会话（H5 ①）
    readonly grantFrom?: { readonly sessionId: string; readonly approvalKey: string } // 生效授权来自哪条 tool/approval_resolved
    readonly releasedBy?: 'tenant-policy' | 'always-allow' | 'task' // 第一步里撤掉「撤不回」的那种放开（D10）
    readonly modeRule?: 'auto-range' | 'not-gated' // 第 7 层放行的依据：自动档范围内；AskUserQuestion、Agent 启动两档都不问
    readonly category?: FlaggedCategory
    readonly findings?: readonly InspectorFinding[]
  }
  readonly status: 'ok' | 'timeout' | 'error' // 02 里只有 inspector 的步骤可能不是 ok
}

export interface DecisionRecord {
  readonly verdict: 'allow' | 'ask' | 'deny'
  readonly decidedBy: DecisionSource
  readonly steps: readonly DecisionStep[]
}

export type DecisionSummaryCode = // 只增
  | 'session-allowed'
  | 'session-allowed-search'
  | 'session-allowed-domain' // 本会话已允许 / 已允许搜索 / 已允许这个域名
  | 'user-rule'
  | 'org-policy'
  | 'user-disabled' // 你设的规则（连接器工具的总是允许）/ 组织策略 / 用户禁用
  | 'irreversible-once'
  | 'exfiltration-recheck'
  | 'default-ask' // 撤不回只认这一次 / 外带检查要求再问一次 / 默认要问
  // 以下由本 spec 补齐：F8 的清单写的是「例如」，不补这些，表里的判决映射不出代码（owner 已确认）
  | 'workspace-read'
  | 'protected'
  | 'connector-requires-confirm'
  | 'check-incomplete'
  | 'inspector-blocked'
  | 'own-output-read'
  | 'no-approval-needed'
  | 'auto-mode'
  | 'task-grant'

export interface DecisionSummary {
  readonly verdict: 'allow' | 'ask' | 'deny'
  readonly code: DecisionSummaryCode
  readonly facts: Readonly<Record<string, string>> // 必填键一律为 toolName；session-allowed-domain 另加 host（按 §搜索与抓取 规范化）
} // 继承授权放行的 session-allowed* 另带可选槽位 inherited: 'parent'（§子 agent 契约）
