/**
 * The decision table (spec 02 §权限决策顺序, §判决记录与摘要).
 *
 * Plan step 8 declared `Decision`, because `PermissionDecidedPayload` (§载荷) reads its `confirm` and
 * `block` members. Plan step 10 adds the readings of layers 1 and 3 that the tool table's exclusions
 * need: opening a table and blocking a call after it froze share one reading (§开表与排除). The rest
 * — `LayerInputs`, `DecisionInput`, `InspectorOutcome`, `CallReason`, `decide()` — is plan step 11's.
 */
import type { ConfirmReason } from '../host/adapter.js'
import type { PolicyState } from '../host/policy.js'
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

/** A connector tool's setting in the user's connector menu: 'never' is layer 3, 'always-allow' layer 6. */
export type ConnectorToolSetting = 'always-allow' | 'ask' | 'never'

/** What layer 3 reads for one tool. Phase 2 has no producer: only tests inject it. */
export interface UserToolSetting {
  readonly connectorOff?: true
  readonly userSetting?: ConnectorToolSetting
}

/**
 * Layer 1, whole-tool form (§第 1 层真值表与 TenantPolicy): the policy denies this tool when it is
 * unavailable, or when a `deny` rule names its server — and its tool, or no tool at all. Rules match
 * the ORIGINAL name, never the one mapped for the provider (H4).
 */
export function policyDeniesTool(
  policy: PolicyState,
  tool: { readonly serverId: string; readonly originalName: string },
): boolean {
  if (policy.status === 'unavailable') return true
  return policy.snapshot.tools.some(
    (rule) =>
      rule.effect === 'deny' &&
      rule.serverId === tool.serverId &&
      (rule.toolName === undefined || rule.toolName === tool.originalName),
  )
}

/** Layer 3: the user turned the connector off, or set this tool to never. */
export function userDisablesTool(setting: UserToolSetting | null): boolean {
  return setting !== null && (setting.connectorOff === true || setting.userSetting === 'never')
}
