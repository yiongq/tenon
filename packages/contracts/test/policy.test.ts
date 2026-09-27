/**
 * The tenant policy schema (spec 02 §`HostAdapter.policy`, D4). Contracts restate the kernel's
 * PolicyState; these assignments, one per direction, make a field added on either side a compile
 * error. The `satisfies` in src/policy.ts alone checks only contract → kernel.
 */
import type { PolicyState, TenantPolicy, ToolPolicyRule } from '@tenon-app/kernel'
import { EMPTY_POLICY } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { policyStateSchema } from '../src/index.js'
import type { PolicyStateContract } from '../src/index.js'

type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

export type ContractPolicyIsKernelPolicy = Assert<Extends<PolicyStateContract, PolicyState>>
export type KernelPolicyIsContractPolicy = Assert<Extends<PolicyState, PolicyStateContract>>

/** Exact key sets per object: an optional member added on one side passes both assignments above. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type ContractSnapshot = Extract<PolicyStateContract, { status: 'current' }>['snapshot']
type ContractRule = ContractSnapshot['tools'][number]
export type StatusKeysMatch = Assert<
  {
    [S in PolicyState['status']]: Equal<
      keyof Extract<PolicyState, { status: S }>,
      keyof Extract<PolicyStateContract, { status: S }>
    >
  }[PolicyState['status']]
>
export type TenantPolicyKeysMatch = Assert<Equal<keyof TenantPolicy, keyof ContractSnapshot>>
export type RuleKeysMatch = Assert<
  {
    [E in ToolPolicyRule['effect']]: Equal<
      keyof Extract<ToolPolicyRule, { effect: E }>,
      keyof Extract<ContractRule, { effect: E }>
    >
  }[ToolPolicyRule['effect']]
>

function withRule(rule: unknown): unknown {
  return { status: 'current', version: 'v1', snapshot: { tools: [rule] } }
}

function withDisableAutoMode(disableAutoMode: unknown): unknown {
  return { status: 'current', version: 'v1', snapshot: { tools: [], disableAutoMode } }
}

describe('policyStateSchema', () => {
  it('accepts the three statuses', () => {
    const states: PolicyState[] = [
      { status: 'current', version: 'empty', snapshot: EMPTY_POLICY },
      {
        status: 'cached',
        version: 'v7',
        snapshot: {
          disableAutoMode: true,
          tools: [
            { policyId: 'p1', serverId: 'builtin', effect: 'deny' },
            { policyId: 'p2', serverId: 'github', effect: 'ask', toolName: 'create_issue' },
            { policyId: 'p3', serverId: 'builtin', effect: 'allow', toolName: 'Read' },
            {
              policyId: 'p4',
              serverId: 'builtin',
              effect: 'release-irreversible',
              toolName: 'Bash',
            },
          ],
        },
      },
      { status: 'unavailable' },
    ]
    for (const state of states) expect(policyStateSchema.parse(state)).toEqual(state)
  })

  it('refuses an unknown status and a status without its fields', () => {
    expect(policyStateSchema.safeParse({ status: 'stale', version: 'v1' }).success).toBe(false)
    expect(policyStateSchema.safeParse({ status: 'current', version: 'v1' }).success).toBe(false)
    expect(policyStateSchema.safeParse({ status: 'cached', snapshot: EMPTY_POLICY }).success).toBe(
      false,
    )
  })

  it('refuses rules the kernel type does not allow', () => {
    // release-irreversible names a single tool
    expect(
      policyStateSchema.safeParse(
        withRule({ policyId: 'p', serverId: 's', effect: 'release-irreversible' }),
      ).success,
    ).toBe(false)
    expect(
      policyStateSchema.safeParse(withRule({ policyId: 'p', serverId: 's', effect: 'block' }))
        .success,
    ).toBe(false)
    expect(policyStateSchema.safeParse(withRule({ serverId: 's', effect: 'deny' })).success).toBe(
      false,
    )
    // optional keys may be absent, never present-but-undefined
    expect(
      policyStateSchema.safeParse(
        withRule({ policyId: 'p', serverId: 's', effect: 'deny', toolName: undefined }),
      ).success,
    ).toBe(false)
  })

  it('takes disableAutoMode as the literal true only', () => {
    expect(policyStateSchema.safeParse(withDisableAutoMode(true)).success).toBe(true)
    expect(policyStateSchema.safeParse(withDisableAutoMode(false)).success).toBe(false)
    expect(policyStateSchema.safeParse(withDisableAutoMode(undefined)).success).toBe(false)
  })
})
