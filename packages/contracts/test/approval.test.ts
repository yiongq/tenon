/**
 * The decision summary across IPC (spec 02 §判决记录与摘要; plan step 12, 旧 125, 旧 163, 02 不变量
 * 19): the schema and the kernel type are one shape in both directions, strict, with exactly three
 * keys — and no route anywhere carries a decision's steps, its deciding layer or its basis.
 */
import type {
  AnswerCommand,
  DecisionSummary,
  DecisionSummaryCode,
  PendingCard,
} from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  approvalCurrent,
  approvalRespond,
  decisionSummaryCodeSchema,
  decisionSummarySchema,
  ipcEvents,
  ipcRoutes,
} from '../src/index.js'
import type { DecisionSummaryContract } from '../src/index.js'

type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

// Exported so `noUnusedLocals` keeps them; nothing imports them.
export type ContractSummaryIsKernelSummary = Assert<
  Extends<DecisionSummaryContract, DecisionSummary>
>
export type KernelSummaryIsContractSummary = Assert<
  Extends<DecisionSummary, DecisionSummaryContract>
>
export type CodesMatch = Assert<
  Extends<DecisionSummaryCode, z.infer<typeof decisionSummaryCodeSchema>> extends true
    ? Extends<z.infer<typeof decisionSummaryCodeSchema>, DecisionSummaryCode>
    : false
>

/** Every property name any schema of a route or an event can hold, nested ones included. */
function propertyNames(schema: z.ZodType): Set<string> {
  const names = new Set<string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    const properties = record['properties']
    if (typeof properties === 'object' && properties !== null) {
      for (const name of Object.keys(properties)) names.add(name)
    }
    Object.values(record).forEach(walk)
  }
  walk(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }))
  walk(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'output' }))
  return names
}

describe('decisionSummarySchema', () => {
  it('has exactly verdict, code and facts, and refuses anything else', () => {
    expect(Object.keys(decisionSummarySchema.shape).toSorted()).toEqual([
      'code',
      'facts',
      'verdict',
    ])
    const summary: DecisionSummary = {
      verdict: 'ask',
      code: 'default-ask',
      facts: { toolName: 'Write' },
    }
    expect(decisionSummarySchema.parse(summary)).toEqual(summary)
    for (const extra of ['steps', 'decidedBy', 'basis', 'layer']) {
      expect(decisionSummarySchema.safeParse({ ...summary, [extra]: [] }).success).toBe(false)
    }
    expect(decisionSummarySchema.safeParse({ ...summary, code: 'made-up' }).success).toBe(false)
  })

  it('knows all eighteen codes', () => {
    expect(decisionSummaryCodeSchema.options).toHaveLength(18)
  })
})

describe('no route or event carries a decision’s record', () => {
  it('has no steps, decidedBy or basis anywhere', () => {
    const schemas: z.ZodType[] = [
      ...Object.values(ipcRoutes).flatMap((route) => [
        route.request as z.ZodType,
        route.response as z.ZodType,
      ]),
      ...Object.values(ipcEvents).map((event) => event.payload as z.ZodType),
    ]
    const names = new Set<string>()
    for (const schema of schemas) for (const name of propertyNames(schema)) names.add(name)
    expect(names.size).toBeGreaterThan(10)
    for (const forbidden of ['steps', 'decidedBy', 'basis'])
      expect(names.has(forbidden)).toBe(false)
  })
})

type RespondRequest = z.infer<typeof approvalRespond.request>
type CurrentResponse = NonNullable<z.infer<typeof approvalCurrent.response>>
// The kernel's command and the route's request are one shape; the kernel's card is one of the route's
// answers (one way: the kernel brands the target's paths).
export type RequestIsCommand = Assert<Extends<RespondRequest, AnswerCommand>>
export type CommandIsRequest = Assert<Extends<AnswerCommand, RespondRequest>>

describe('approval.respond and approval.current (plan step 15)', () => {
  const SESSION = '7c4e9a2e-6b3d-4a71-9f52-0c8de7a11b37'
  const requestId = 'tool:v1:decision:00000000-0000-4000-8000-000000000001:1:0'

  it('are registered, and refuse a session id that is not canonical', () => {
    expect(Object.values(ipcRoutes)).toContain(approvalRespond)
    expect(Object.values(ipcRoutes)).toContain(approvalCurrent)
    const ok = { kind: 'approval', sessionId: SESSION, requestId, decision: 'allow' }
    expect(approvalRespond.request.parse(ok)).toEqual(ok)
    expect(approvalRespond.request.safeParse({ ...ok, sessionId: 'abc' }).success).toBe(false)
    expect(approvalRespond.request.safeParse({ ...ok, decision: 'maybe' }).success).toBe(false)
    for (const status of ['applied', 'already-resolved', 'stale', 'not-found', 'invalid']) {
      expect(approvalRespond.response.safeParse({ status }).success).toBe(true)
    }
    expect(approvalRespond.response.safeParse({ status: 'refused' }).success).toBe(false)
  })

  it('carries the kernel’s pending card, and null when nothing waits', () => {
    const card: PendingCard = {
      waitKind: 'approval',
      card: {
        requestId,
        sessionId: SESSION,
        kind: 'tool',
        reason: 'flagged',
        facts: { category: 'exfiltration', toolName: 'look' },
        reversibility: 'unknown',
        target: { type: 'tool', serverId: 'fs', toolName: 'look' },
      },
      callKey: '00000000-0000-4000-8000-000000000001:1:0',
      anchorCallKey: '00000000-0000-4000-8000-000000000001:1:0',
      allowScope: 'once',
    }
    const crossed: CurrentResponse = approvalCurrent.response.parse(card) as CurrentResponse
    expect(crossed).toEqual(card)
    expect(approvalCurrent.response.parse(null)).toBeNull()
  })
})
