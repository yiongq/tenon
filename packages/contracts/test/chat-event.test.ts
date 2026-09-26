/**
 * Spec 02, 01 修补 6 (step 7, 旧 106): `chat.event` only adds variants. The three that step 7 adds
 * parse; phase 1's variants are unchanged.
 */
import type {
  ClosureSource,
  ExecutionState,
  RunEndReason,
  ToolOutcomeView,
} from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { chatContinue, chatEventSchema, ipcRoutes, runEndReasonSchema } from '../src/index.js'
import type {
  RunEndReasonContract,
  ToolOutcomeViewContract,
  closureSourceSchema,
  executionStateSchema,
} from '../src/index.js'

type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

// Exported so `noUnusedLocals` keeps them; nothing imports them.
export type ContractReasonIsKernelReason = Assert<Extends<RunEndReasonContract, RunEndReason>>
export type KernelReasonIsContractReason = Assert<Extends<RunEndReason, RunEndReasonContract>>
export type StatesMatch = Assert<Extends<z.infer<typeof executionStateSchema>, ExecutionState>>
export type KernelStatesMatch = Assert<
  Extends<ExecutionState, z.infer<typeof executionStateSchema>>
>
export type SourcesMatch = Assert<Extends<z.infer<typeof closureSourceSchema>, ClosureSource>>
export type KernelSourcesMatch = Assert<Extends<ClosureSource, z.infer<typeof closureSourceSchema>>>
// One way only: the kernel brands ConfirmTarget's paths, which the wire carries as plain strings.
export type KernelViewCrosses = Assert<Extends<ToolOutcomeView, ToolOutcomeViewContract>>

/** One of each of the 18 end codes, every slot filled (spec 02 §结束原因词表). */
const END_REASONS: readonly RunEndReason[] = [
  { code: 'completed' },
  { code: 'user-stopped' },
  { code: 'paused', waitingFor: 'approval' },
  { code: 'user-rejected', toolName: 'Write' },
  { code: 'blocked-repeatedly', count: 3 },
  { code: 'step-limit', limit: 100 },
  { code: 'no-progress', repeats: 4 },
  { code: 'usage-limit', tokenLimit: 200_000 },
  { code: 'refusal', providerId: 'anthropic', modelId: 'claude-test' },
  { code: 'content-filter', providerId: 'zhipu' },
  { code: 'context-overflow', compactions: 2 },
  { code: 'quota-exhausted', providerId: 'anthropic', resetAt: null },
  { code: 'account-config', providerId: 'anthropic' },
  {
    code: 'provider-error',
    providerId: 'zhipu',
    errorCode: null,
    providerReason: 'network_error',
    attempts: 3,
  },
  { code: 'output-truncated', maxTokens: 8192 },
  { code: 'shutdown-aborted', trigger: 'close-window' },
  { code: 'recovered' },
  { code: 'time-limit', limitMs: 600_000 },
]

const SESSION = '11111111-1111-4111-8111-111111111111'

describe('chatEventSchema', () => {
  it('accepts the thinking-delta, tool-call and attempt-discarded variants', () => {
    const events = [
      { type: 'thinking-delta', sessionId: SESSION, delta: 'hmm' },
      {
        type: 'tool-call',
        sessionId: SESSION,
        callKey: '00000000-0000-4000-8000-000000000001:1:0',
        providerToolCallId: 'toolu_1',
        name: 'Read',
        input: { file_path: '/a' },
      },
      { type: 'attempt-discarded', sessionId: SESSION },
    ]
    for (const event of events) expect(chatEventSchema.parse(event)).toEqual(event)
  })

  it('refuses a tool-call without a callKey', () => {
    expect(
      chatEventSchema.safeParse({
        type: 'tool-call',
        sessionId: SESSION,
        callKey: '',
        providerToolCallId: 'x',
        name: 'Read',
        input: {},
      }).success,
    ).toBe(false)
  })

  it('keeps phase 1’s done stop reasons and error codes as they were', () => {
    for (const stopReason of ['end-turn', 'aborted', 'error']) {
      expect(
        chatEventSchema.safeParse({ type: 'done', sessionId: SESSION, stopReason }).success,
      ).toBe(true)
    }
    expect(
      chatEventSchema.safeParse({ type: 'error', sessionId: SESSION, code: 'quota-exhausted' })
        .success,
    ).toBe(false)
  })

  it('carries an optional endReason on done and on error, of each of the 18 codes (旧 106)', () => {
    expect(new Set(END_REASONS.map((reason) => reason.code)).size).toBe(18)
    for (const endReason of END_REASONS) {
      const done = { type: 'done', sessionId: SESSION, stopReason: 'end-turn', endReason }
      expect(chatEventSchema.parse(done)).toEqual(done)
      const error = { type: 'error', sessionId: SESSION, code: 'provider', endReason }
      expect(chatEventSchema.parse(error)).toEqual(error)
    }
    // A code outside the vocabulary, or a member missing a slot, does not cross.
    expect(runEndReasonSchema.safeParse({ code: 'crashed' }).success).toBe(false)
    expect(runEndReasonSchema.safeParse({ code: 'step-limit' }).success).toBe(false)
  })
})

describe('chat.continue', () => {
  it('is registered, and answers one of four statuses', () => {
    expect(Object.values(ipcRoutes)).toContain(chatContinue)
    expect(chatContinue.channel).toBe('chat.continue')
    for (const status of ['started', 'not-available', 'not-sent']) {
      expect(chatContinue.response.safeParse({ status }).success).toBe(true)
    }
    expect(
      chatContinue.response.safeParse({ status: 'held', host: 'api.example.com' }).success,
    ).toBe(true)
    expect(chatContinue.response.safeParse({ status: 'refused' }).success).toBe(false)
  })
})

describe('tool-outcome (旧 106)', () => {
  const base = {
    type: 'tool-outcome',
    sessionId: SESSION,
    callKey: '00000000-0000-4000-8000-000000000001:1:0',
    providerToolCallId: 'toolu_1',
  }

  it('carries a closed call as the kernel views it, by callKey', () => {
    const events = [
      { ...base, effect: 'external', state: 'completed', source: null, output: 'ok' },
      {
        ...base,
        effect: 'blocked',
        state: 'not-run',
        source: 'protected',
        facts: { toolName: 'Read', target: '/etc/passwd' },
        output: 'blocked',
        permission: {
          verdict: 'deny',
          code: 'protected',
          facts: { toolName: 'Read' },
        },
      },
      {
        ...base,
        effect: 'write',
        state: 'uncertain',
        source: 'stopped',
        output: '',
        approval: {
          outcome: 'allowed',
          scope: 'once',
          target: { type: 'path', path: '/work/a.ts' },
        },
      },
    ]
    for (const event of events) expect(chatEventSchema.parse(event)).toEqual(event)
  })

  it('refuses a state or a source outside the vocabulary, and an explicit undefined', () => {
    const ok = { ...base, effect: 'blocked', state: 'not-run', source: 'stopped', output: '' }
    expect(chatEventSchema.safeParse(ok).success).toBe(true)
    expect(chatEventSchema.safeParse({ ...ok, state: 'maybe' }).success).toBe(false)
    expect(chatEventSchema.safeParse({ ...ok, source: 'crash' }).success).toBe(false)
    expect(chatEventSchema.safeParse({ ...ok, callKey: '' }).success).toBe(false)
    expect(chatEventSchema.safeParse({ ...ok, facts: undefined }).success).toBe(false)
  })
})
