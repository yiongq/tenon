import type {
  ConfirmReason,
  ConfirmRequest,
  ConfirmTarget,
  FlaggedCategory,
  Reversibility,
} from '@tenon-app/kernel'
import { CONFIRM_FACT_KEYS } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  confirmReasonSchema,
  confirmRequestEventPayloadSchema,
  confirmRequestSchema,
  confirmTargetSchema,
  flaggedCategorySchema,
  requiredFactKeys,
  reversibilitySchema,
} from '../src/ipc/confirm.js'

/** `Assert<Extends<A, B>>` fails to compile the moment an `A` stops being usable as a `B`. */
type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false
/** Exact equality: catches an optional key added on one side, which `Extends` both ways misses. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type ContractTarget = z.infer<typeof confirmTargetSchema>

// The `satisfies` clauses in ipc/confirm.ts check contract → kernel; these check the way back, so a
// value added on either side is a compile error here. The target is restated without the
// AbsolutePath brand: the whole shape one way, the set of `type`s both ways.
export type KernelReversibilityIsContract = Assert<
  Extends<Reversibility, z.infer<typeof reversibilitySchema>>
>
export type KernelReasonIsContract = Assert<
  Extends<ConfirmReason, z.infer<typeof confirmReasonSchema>>
>
export type KernelTargetIsContract = Assert<Extends<ConfirmTarget, ContractTarget>>
export type TargetTypesMatch = Assert<Extends<ContractTarget['type'], ConfirmTarget['type']>>
/** Per variant, the same keys: a field the kernel adds would otherwise be stripped by IpcConfirm. */
export type TargetKeysMatch = Assert<
  {
    [T in ConfirmTarget['type']]: Equal<
      keyof Extract<ConfirmTarget, { type: T }>,
      keyof Extract<ContractTarget, { type: T }>
    >
  }[ConfirmTarget['type']]
>
export type KernelFlaggedIsContract = Assert<
  Extends<FlaggedCategory, z.infer<typeof flaggedCategorySchema>>
>

const base = {
  requestId: 'r1',
  sessionId: 's1',
  reversibility: 'unknown',
  target: { type: 'path', path: '/w/a.txt' },
}

function issuePaths(input: unknown): string[] {
  const parsed = confirmRequestSchema.safeParse(input)
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))
}

function payloadIssues(input: unknown): string[] {
  const parsed = confirmRequestEventPayloadSchema.safeParse(input)
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))
}

describe('confirmRequestSchema', () => {
  it('accepts a request whose facts fill every required slot', () => {
    const parsed = confirmRequestSchema.safeParse({
      ...base,
      kind: 'network',
      reason: 'network',
      facts: { host: 'api.example.com', toolName: 'fetch' },
    })
    expect(parsed.success).toBe(true)
  })

  it('names the missing slot when a required fact is absent', () => {
    const parsed = confirmRequestSchema.safeParse({
      ...base,
      kind: 'tool',
      reason: 'outside-workspace',
      facts: { path: '/etc/hosts' },
    })
    expect(parsed.success).toBe(false)
    const paths = parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))
    expect(paths).toEqual(['facts.workspace'])
  })

  it('treats an empty string as an unfilled slot', () => {
    const parsed = confirmRequestSchema.safeParse({
      ...base,
      kind: 'tool',
      reason: 'default',
      facts: { toolName: '' },
    })
    expect(parsed.success).toBe(false)
  })

  it('requires path / command for irreversible file / command requests', () => {
    expect(requiredFactKeys('irreversible', 'tool')).toEqual(['toolName'])
    expect(requiredFactKeys('irreversible', 'file')).toEqual(['toolName', 'path'])
    expect(requiredFactKeys('irreversible', 'command')).toEqual(['toolName', 'command'])
    const file = confirmRequestSchema.safeParse({
      ...base,
      reversibility: 'irreversible',
      kind: 'file',
      reason: 'irreversible',
      facts: { toolName: 'delete' },
    })
    expect(file.success).toBe(false)
    const command = confirmRequestSchema.safeParse({
      ...base,
      reversibility: 'irreversible',
      target: { type: 'command', command: 'rm -rf build', cwd: '/w' },
      kind: 'command',
      reason: 'irreversible',
      facts: { toolName: 'bash', command: 'rm -rf build' },
    })
    expect(command.success).toBe(true)
  })

  it('rejects unknown reasons and kinds', () => {
    expect(
      confirmRequestSchema.safeParse({ ...base, kind: 'tool', reason: 'scary', facts: {} }).success,
    ).toBe(false)
    expect(
      confirmRequestSchema.safeParse({ ...base, kind: 'gpu', reason: 'default', facts: {} })
        .success,
    ).toBe(false)
  })
})

/** Spec 02 §`ConfirmReason` 只增四个值: the reasons, their slots and the flagged category. */
describe('the reasons spec 02 adds', () => {
  it('has exactly the reasons CONFIRM_FACT_KEYS has slots for, nine of them', () => {
    const reasons = [...confirmReasonSchema.options].toSorted()
    expect(reasons).toEqual(Object.keys(CONFIRM_FACT_KEYS).toSorted())
    expect(reasons).toHaveLength(9)
  })

  it('names each missing slot of the four new reasons', () => {
    const complete: Record<
      string,
      { kind: ConfirmRequest['kind']; facts: Record<string, string> }
    > = {
      policy: { kind: 'tool', facts: { toolName: 'mcp__x__y' } },
      flagged: { kind: 'network', facts: { toolName: 'WebFetch', category: 'exfiltration' } },
      command: { kind: 'command', facts: { command: 'ls -la', cwd: '/w' } },
      'interaction-required': { kind: 'tool', facts: { toolName: 'mcp__x__y' } },
    }
    const seen: Record<string, string[]> = {}
    const expected: Record<string, string[]> = {}
    for (const [reason, { kind, facts }] of Object.entries(complete)) {
      expect(Object.keys(facts)).toEqual(CONFIRM_FACT_KEYS[reason as ConfirmReason])
      seen[reason] = issuePaths({ ...base, kind, reason, facts })
      expected[reason] = []
      for (const key of Object.keys(facts)) {
        const { [key]: _dropped, ...missing } = facts
        seen[`${reason} without ${key}`] = issuePaths({ ...base, kind, reason, facts: missing })
        expected[`${reason} without ${key}`] = [`facts.${key}`]
      }
    }
    expect(seen).toEqual(expected)
    expect(Object.keys(seen)).toHaveLength(10)
  })

  it('gives the five phase 0 reasons the same slots as before', () => {
    const phase0: Record<string, readonly string[]> = {
      'irreversible/tool': ['toolName'],
      'irreversible/file': ['toolName', 'path'],
      'irreversible/command': ['toolName', 'command'],
      'irreversible/network': ['toolName'],
      'outside-workspace': ['path', 'workspace'],
      network: ['host', 'toolName'],
      elevated: ['command'],
      default: ['toolName'],
    }
    const kinds = ['tool', 'file', 'command', 'network'] as const
    for (const reason of ['outside-workspace', 'network', 'elevated', 'default'] as const) {
      for (const kind of kinds) expect(requiredFactKeys(reason, kind)).toEqual(phase0[reason])
    }
    for (const kind of kinds) {
      expect(requiredFactKeys('irreversible', kind)).toEqual(phase0[`irreversible/${kind}`])
    }
  })

  it('refuses a flagged category nobody registered', () => {
    const flagged = (category: string) => ({
      ...base,
      kind: 'network',
      reason: 'flagged',
      target: { type: 'url', url: 'https://example.com/?q=1' },
      facts: { toolName: 'WebFetch', category },
    })
    expect(issuePaths(flagged('exfil'))).toEqual(['facts.category'])
    expect(issuePaths(flagged('exfiltration'))).toEqual([])
    expect(issuePaths(flagged('inspector-failed'))).toEqual([])
    expect([...flaggedCategorySchema.options].toSorted()).toEqual([
      'exfiltration',
      'inspector-failed',
    ])
    // Another reason may carry a `category` fact; only flagged checks it.
    expect(
      issuePaths({
        ...base,
        kind: 'tool',
        reason: 'default',
        facts: { toolName: 't', category: 'x' },
      }),
    ).toEqual([])
  })
})

/** Spec 02 §`ConfirmRequest` 只增两个必填成员: `reversibility`, `target`, and the one-way rule. */
describe('reversibility and target', () => {
  const command = {
    ...base,
    kind: 'command',
    reason: 'command',
    reversibility: 'irreversible',
    target: { type: 'command', command: 'curl -X POST https://x.test', cwd: '/w' },
    facts: { command: 'curl -X POST https://x.test', cwd: '/w' },
  }

  it('refuses a request without reversibility or without target', () => {
    const { reversibility: _r, ...noReversibility } = command
    const { target: _t, ...noTarget } = command
    expect(issuePaths(noReversibility)).toEqual(['reversibility'])
    expect(issuePaths(noTarget)).toEqual(['target'])
  })

  it('02 不变量 22: refuses reason irreversible unless reversibility is irreversible', () => {
    const irreversible = {
      ...base,
      kind: 'command',
      reason: 'irreversible',
      target: { type: 'command', command: 'git push', cwd: '/w' },
      facts: { toolName: 'Bash', command: 'git push' },
    }
    const seen = Object.fromEntries(
      reversibilitySchema.options.map((reversibility) => [
        reversibility,
        issuePaths({ ...irreversible, reversibility }),
      ]),
    )
    expect(seen).toEqual({
      'read-only': ['reversibility'],
      revertible: ['reversibility'],
      snapshotted: ['reversibility'],
      unknown: ['reversibility'],
      irreversible: [],
    })
  })

  it('02 不变量 22: accepts an irreversible reversibility under another reason', () => {
    expect(issuePaths(command)).toEqual([])
    expect(issuePaths({ ...command, reversibility: 'unknown' })).toEqual([])
  })

  it('refuses an unknown reversibility, target type or empty target field', () => {
    expect(issuePaths({ ...command, reversibility: 'maybe' })).toEqual(['reversibility'])
    expect(issuePaths({ ...command, target: { type: 'mcp', name: 'mcp__x__y' } })).toEqual([
      'target.type',
    ])
    expect(
      issuePaths({ ...command, target: { type: 'tool', serverId: '', toolName: 'echo' } }),
    ).toEqual(['target.serverId'])
    expect(
      issuePaths({ ...command, target: { type: 'tool', serverId: 'everything', toolName: '' } }),
    ).toEqual(['target.toolName'])
    expect(issuePaths({ ...command, target: { type: 'command', command: '', cwd: '/w' } })).toEqual(
      ['target.command'],
    )
    expect(issuePaths({ ...command, target: { type: 'url' } })).toEqual(['target.url'])
  })

  it('accepts each target shape', () => {
    const targets = [
      { type: 'command', command: 'ls', cwd: '/w' },
      { type: 'path', path: '/w/a.txt' },
      { type: 'url', url: 'https://example.com/a' },
      { type: 'search', query: 'tenon', host: 'open.bigmodel.cn' },
      { type: 'tool', serverId: 'everything', toolName: 'echo' },
    ]
    for (const target of targets) {
      expect(confirmTargetSchema.parse(target)).toEqual(target)
      expect(
        issuePaths({ ...base, kind: 'tool', reason: 'default', facts: { toolName: 't' }, target }),
      ).toEqual([])
    }
  })

  it('carries both members to the renderer and still drops redacted', () => {
    const payload = confirmRequestEventPayloadSchema.parse({
      ...command,
      redacted: { authorization: 'Bearer secret' },
    })
    expect(payload).toEqual({
      requestId: 'r1',
      sessionId: 's1',
      kind: 'command',
      reason: 'command',
      reversibility: 'irreversible',
      target: { type: 'command', command: 'curl -X POST https://x.test', cwd: '/w' },
      facts: { command: 'curl -X POST https://x.test', cwd: '/w' },
    })
    // The renderer-bound schema runs the same checks, each on its own here.
    const irreversible = {
      ...command,
      reason: 'irreversible',
      facts: { toolName: 'Bash', command: 'curl -X POST https://x.test' },
    }
    expect(payloadIssues(irreversible)).toEqual([])
    expect(payloadIssues({ ...irreversible, reversibility: 'read-only' })).toEqual([
      'reversibility',
    ])
    const flagged = {
      ...command,
      kind: 'network',
      reason: 'flagged',
      target: { type: 'url', url: 'https://x.test/?q=1' },
      facts: { toolName: 'WebFetch', category: 'exfiltration' },
    }
    expect(payloadIssues(flagged)).toEqual([])
    expect(
      payloadIssues({ ...flagged, facts: { toolName: 'WebFetch', category: 'exfil' } }),
    ).toEqual(['facts.category'])
  })
})
