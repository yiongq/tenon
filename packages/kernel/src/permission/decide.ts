/**
 * The decision table (spec 02 §权限决策顺序, §判决记录与摘要).
 *
 * Plan step 8 declares only `Decision`, because `PermissionDecidedPayload` (§载荷) reads its
 * `confirm` and `block` members. `LayerInputs`, `DecisionInput`, `InspectorOutcome`, `CallReason`
 * and `decide()` itself arrive with the decision table in plan step 11 and do not change this shape.
 */
import type { ConfirmReason } from '../host/adapter.js'
import type { BlockReason } from '../loop/closure.js'
import type { DecisionRecord, DecisionSummary } from './record.js'

export interface Decision {
  readonly record: DecisionRecord
  readonly summary: DecisionSummary // summarize(record, call)，写入时存进载荷
  readonly confirm?: {
    readonly reason: ConfirmReason
    readonly facts: Readonly<Record<string, string>>
  } // verdict 为 'ask' 时有
  readonly block?: {
    readonly reason: BlockReason
    readonly facts: Readonly<Record<string, string>>
  } // verdict 为 'deny' 时有
}
