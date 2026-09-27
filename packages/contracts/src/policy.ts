import type { PolicyState } from '@tenon-app/kernel'
import { z } from 'zod'

/**
 * The tenant policy as it crosses a process or network boundary (spec 02 §`HostAdapter.policy`,
 * D4): 6b's bridge frames and, later, a locally managed policy file are both checked with it.
 * Written from the kernel's PolicyState / TenantPolicy / ToolPolicyRule (host/policy.ts); the
 * `satisfies` below and the assignments in test/policy.test.ts keep the two one shape, with no
 * exception. `exactOptional` because the kernel's optional keys may be absent but never undefined.
 */
const toolPolicyRuleSchema = z.discriminatedUnion('effect', [
  z.object({
    policyId: z.string(),
    serverId: z.string(),
    effect: z.enum(['deny', 'ask', 'allow']),
    toolName: z.string().exactOptional(),
  }),
  z.object({
    policyId: z.string(),
    serverId: z.string(),
    effect: z.literal('release-irreversible'),
    toolName: z.string(),
  }),
])

const tenantPolicySchema = z.object({
  tools: z.array(toolPolicyRuleSchema).readonly(),
  disableAutoMode: z.literal(true).exactOptional(),
})

export const policyStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('current'), version: z.string(), snapshot: tenantPolicySchema }),
  z.object({ status: z.literal('cached'), version: z.string(), snapshot: tenantPolicySchema }),
  z.object({ status: z.literal('unavailable') }),
]) satisfies z.ZodType<PolicyState>

export type PolicyStateContract = z.infer<typeof policyStateSchema>
