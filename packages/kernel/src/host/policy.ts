/**
 * Tenant policy as the kernel reads it through `HostAdapter.policy` (spec 02 §对 00-foundation 的修补
 * 「`HostAdapter.policy`（只增，第九个成员）」, shapes in §第 1 层真值表与 TenantPolicy).
 *
 * The host fetches and caches the policy; the kernel only reads it. A personal tenant — the
 * desktop in phase 2 — always has EMPTY_POLICY. `unavailable` is read as "the policy refuses every
 * tool" until 6b settles it (spec 02 open question 11, confirmed).
 */

export type PolicyState =
  | { status: 'current'; version: string; snapshot: TenantPolicy } // the latest policy was fetched
  | { status: 'cached'; version: string; snapshot: TenantPolicy } // not reachable; the last known snapshot
  | { status: 'unavailable' } // an organisation tenant that never got a policy

export interface TenantPolicy {
  readonly tools: readonly ToolPolicyRule[]
  /** Turns the auto mode off (D3, D6). A tenant switch, not a mode value; contracts carry it too. */
  readonly disableAutoMode?: true
}

interface ToolPolicyRuleBase {
  readonly policyId: string // goes into the tape's decision record only, never into facts (D5)
  readonly serverId: string // the connector's serverId, or BUILTIN_SERVER_ID (H4, D1)
}

/** `toolName` is always the originalName, never the name mapped for the provider (H4). */
export type ToolPolicyRule =
  // toolName omitted = every tool under this serverId; 'allow' judges like no rule at all (D3)
  | (ToolPolicyRuleBase & { readonly effect: 'deny' | 'ask' | 'allow'; readonly toolName?: string })
  // names one tool only (D2, D3)
  | (ToolPolicyRuleBase & { readonly effect: 'release-irreversible'; readonly toolName: string })

export const EMPTY_POLICY: TenantPolicy = { tools: [] }
