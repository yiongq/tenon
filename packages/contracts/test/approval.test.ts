/**
 * The decision summary across IPC (spec 02 §判决记录与摘要; plan step 12, 旧 125, 旧 163, 02 不变量
 * 19): the schema and the kernel type are one shape in both directions, strict, with exactly three
 * keys — and no route anywhere carries a decision's steps, its deciding layer or its basis.
 */
import type { DecisionSummary, DecisionSummaryCode } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
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
