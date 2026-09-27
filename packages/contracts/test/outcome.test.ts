/**
 * Plan step 20's contract additions (spec 02 01 修补 6「session.messages 与内容块」, §调用的键与读写的数据,
 * §进行中、暂停与 RunRegistry; 旧 125 for `calls[i].outcome`): the outcome view and the decision summary
 * now live in `ipc/outcome.ts` — one schema, restated by `chat.ts` and `approval.ts`, still strict and
 * still the kernel's shapes — a message row's `calls`, and the `run.state` event.
 */
import type {
  ClosureSource,
  DecisionSummary,
  ExecutionState,
  MessageRow,
  RowCall,
  SessionMessageRow,
  ToolOutcomeView,
  ContentBlock,
} from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  chatEventSchema,
  closureSourceSchema,
  decisionSummaryCodeSchema,
  decisionSummarySchema,
  executionStateSchema,
  ipcEvents,
  ipcRoutes,
  messageRowSchema,
  runStateEvent,
  sessionLatest,
  sessionMessages,
  toolOutcomeViewSchema,
  toolOutcomeViewShape,
} from '../src/index.js'
import type { MessageRowContract, RunState } from '../src/index.js'
import * as outcome from '../src/ipc/outcome.js'
import type { DecisionSummaryContract, ToolOutcomeViewContract } from '../src/ipc/outcome.js'
import { isEventChannel, isRouteChannel } from '../src/registry.js'

type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

type CallContract = NonNullable<MessageRowContract['calls']>[number]
/** What main lets cross: the kernel's row without the vendor's verbatim block (session.ts). */
type ProjectedSessionRow = Omit<SessionMessageRow, 'content'> & {
  content: Exclude<ContentBlock, { type: 'vendor' }>[]
}

// Exported so `noUnusedLocals` keeps them; nothing imports them. Read off outcome.ts itself.
export type SummaryBothWays = Assert<
  Extends<DecisionSummaryContract, DecisionSummary> extends true
    ? Extends<DecisionSummary, DecisionSummaryContract>
    : false
>
export type StatesBothWays = Assert<
  Extends<z.infer<typeof outcome.executionStateSchema>, ExecutionState> extends true
    ? Extends<ExecutionState, z.infer<typeof outcome.executionStateSchema>>
    : false
>
export type SourcesBothWays = Assert<
  Extends<z.infer<typeof outcome.closureSourceSchema>, ClosureSource> extends true
    ? Extends<ClosureSource, z.infer<typeof outcome.closureSourceSchema>>
    : false
>
// One way only, as for `tool-outcome`: the kernel brands ConfirmTarget's paths, the wire does not.
export type KernelViewCrosses = Assert<Extends<ToolOutcomeView, ToolOutcomeViewContract>>
export type KernelCallCrosses = Assert<Extends<RowCall, CallContract>>
export type KernelRowCrosses = Assert<Extends<ProjectedSessionRow, MessageRowContract>>
// A row with calls is still a row the kernel would recognise.
export type ContractRowIsKernelRow = Assert<Extends<MessageRowContract, MessageRow>>
export type RunStateShape = Assert<
  Extends<RunState, { sessionId: string; running: boolean; runId: string | null }> extends true
    ? Extends<{ sessionId: string; running: boolean; runId: string | null }, RunState>
    : false
>

const SESSION = '0f1e2d3c-4b5a-4697-8899-aabbccddeeff'
const KEY = '00000000-0000-4000-8000-000000000001:1:0'

const ASKED: ToolOutcomeViewContract = {
  effect: 'external',
  state: 'completed',
  source: null,
  output: 'looked',
  permission: { verdict: 'ask', code: 'exfiltration-recheck', facts: { toolName: 'look' } },
  approval: {
    outcome: 'allowed',
    scope: 'once',
    target: { type: 'tool', serverId: 'fs', toolName: 'look' },
  },
}

function row(calls: unknown): unknown {
  return {
    sessionId: SESSION,
    messageId: 'm1',
    orderSeq: 3,
    role: 'assistant',
    status: 'complete',
    content: [
      { type: 'tool-request', id: 'toolu_1', name: 'fs__look', input: { at: 'a' } },
      { type: 'tool-request', id: 'toolu_2', name: 'fs__look', input: { at: 'b' } },
    ],
    entryId: 9,
    createdAt: 1,
    updatedAt: 2,
    ...(calls === undefined ? {} : { calls }),
  }
}

/** Every property name a schema can hold, nested ones included (as approval.test.ts walks them). */
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
  walk(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'output' }))
  return names
}

describe('ipc/outcome.ts', () => {
  it('is the one definition the restated exports hand out', () => {
    expect(decisionSummarySchema).toBe(outcome.decisionSummarySchema)
    expect(decisionSummaryCodeSchema).toBe(outcome.decisionSummaryCodeSchema)
    expect(toolOutcomeViewSchema).toBe(outcome.toolOutcomeViewSchema)
    expect(toolOutcomeViewShape).toBe(outcome.toolOutcomeViewShape)
    expect(executionStateSchema).toBe(outcome.executionStateSchema)
    expect(closureSourceSchema).toBe(outcome.closureSourceSchema)
  })

  it('refuses a summary with a record’s fields wherever a view crosses (旧 125)', () => {
    const leaked = {
      ...ASKED,
      permission: { ...ASKED.permission, steps: [], decidedBy: 'inspector' },
    }
    expect(outcome.toolOutcomeViewSchema.safeParse(ASKED).success).toBe(true)
    expect(outcome.toolOutcomeViewSchema.safeParse(leaked).success).toBe(false)
    const event = {
      type: 'tool-outcome',
      sessionId: SESSION,
      callKey: KEY,
      providerToolCallId: 't',
    }
    expect(chatEventSchema.safeParse({ ...event, ...ASKED }).success).toBe(true)
    expect(chatEventSchema.safeParse({ ...event, ...leaked }).success).toBe(false)
    expect(messageRowSchema.safeParse(row([{ callKey: KEY, outcome: ASKED }])).success).toBe(true)
    expect(messageRowSchema.safeParse(row([{ callKey: KEY, outcome: leaked }])).success).toBe(false)
  })

  it('keeps optional members exact, and the answer’s scope to the two a card gives', () => {
    for (const key of ['facts', 'permission', 'approval', 'question', 'handoff']) {
      expect(toolOutcomeViewSchema.safeParse({ ...ASKED, [key]: undefined }).success).toBe(false)
    }
    const scoped = (scope: unknown) => ({ ...ASKED, approval: { ...ASKED.approval, scope } })
    expect(toolOutcomeViewSchema.safeParse(scoped(null)).success).toBe(true)
    expect(toolOutcomeViewSchema.safeParse(scoped('session')).success).toBe(true)
    // `persistent` never comes from a card (§作用域与授权键).
    expect(toolOutcomeViewSchema.safeParse(scoped('persistent')).success).toBe(false)
    expect(
      toolOutcomeViewSchema.safeParse({
        ...ASKED,
        approval: { ...ASKED.approval, outcome: 'expired' },
      }).success,
    ).toBe(false)
  })
})

describe('a message row’s calls (01 修补 6)', () => {
  it('carries each call’s key and its outcome, or null while it has none', () => {
    const calls = [
      { callKey: KEY, outcome: ASKED },
      { callKey: `${KEY.slice(0, -1)}1`, outcome: null },
    ]
    expect(messageRowSchema.parse(row(calls))).toEqual(row(calls))
    // A row with no calls crosses without the key, never with an empty stand-in.
    expect('calls' in messageRowSchema.parse(row(undefined))).toBe(false)
  })

  it('refuses an empty key, a missing outcome and an explicit undefined', () => {
    expect(messageRowSchema.safeParse(row([{ callKey: '', outcome: null }])).success).toBe(false)
    expect(messageRowSchema.safeParse(row([{ callKey: KEY }])).success).toBe(false)
    const explicit = { ...(row(undefined) as Record<string, unknown>), calls: undefined }
    expect(messageRowSchema.safeParse(explicit).success).toBe(false)
  })

  it('reaches the summary through both session reads, and never a record’s fields (旧 125)', () => {
    for (const route of [sessionMessages, sessionLatest]) {
      const names = propertyNames(route.response as z.ZodType)
      for (const name of ['calls', 'callKey', 'permission', 'verdict', 'approval']) {
        expect([route.channel, name, names.has(name)]).toEqual([route.channel, name, true])
      }
      for (const name of ['steps', 'decidedBy', 'basis']) expect(names.has(name)).toBe(false)
    }
    expect(Object.values(ipcRoutes)).toContain(sessionMessages)
  })
})

describe('run.state', () => {
  it('is a registered event, not a route', () => {
    expect(Object.values(ipcEvents)).toContain(runStateEvent)
    expect(runStateEvent.channel).toBe('run.state')
    expect(isEventChannel('run.state')).toBe(true)
    expect(isRouteChannel('run.state')).toBe(false)
  })

  it('names a canonical root, whether it runs, and its Run or null', () => {
    for (const state of [
      { sessionId: SESSION, running: true, runId: null },
      { sessionId: SESSION, running: true, runId: 'run-1' },
      { sessionId: SESSION, running: false, runId: 'run-1' },
      { sessionId: SESSION, running: false, runId: null },
    ]) {
      expect(runStateEvent.payload.parse(state)).toEqual(state)
    }
    const ok = { sessionId: SESSION, running: true, runId: null }
    expect(runStateEvent.payload.safeParse({ ...ok, sessionId: 'not-a-uuid' }).success).toBe(false)
    expect(runStateEvent.payload.safeParse({ ...ok, runId: '' }).success).toBe(false)
    expect(runStateEvent.payload.safeParse({ sessionId: SESSION, running: true }).success).toBe(
      false,
    )
    expect(runStateEvent.payload.safeParse({ ...ok, running: 'yes' }).success).toBe(false)
  })
})
