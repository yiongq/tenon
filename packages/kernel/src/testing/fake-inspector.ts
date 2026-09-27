/**
 * A fake inspector for tests (spec 02 plan step 12): answers what the case scripts — an opinion, a
 * throw, or never (to be timed out or stopped) — and records every call and whether its signal was
 * aborted. Phase 2's product registers only the exfiltration rule, which only ever asks; a fake that
 * denies exists for tests alone (F1).
 */
import type { AskOpinion, DenyOpinion, InspectorRegistration } from '../permission/inspector.js'
import type { BeforeCallInput } from '../permission/session-view.js'

export type FakeInspectorAnswer =
  | DenyOpinion
  | { readonly throws: Error }
  | 'never'
  | ((input: BeforeCallInput) => DenyOpinion | Promise<DenyOpinion>)

export interface FakeInspector {
  readonly registration: InspectorRegistration
  /** What the next calls answer. */
  answer(next: FakeInspectorAnswer): void
  readonly calls: readonly BeforeCallInput[]
  /** Whether the signal handed to the latest call was aborted, and why. */
  readonly lastSignal: AbortSignal | null
}

export function createFakeInspector(q: {
  readonly id: string
  readonly ceiling: 'ask' | 'deny'
  readonly kind?: 'local-rule' | 'model'
  readonly answer?: FakeInspectorAnswer
}): FakeInspector {
  let next: FakeInspectorAnswer = q.answer ?? { kind: 'none' }
  const calls: BeforeCallInput[] = []
  let lastSignal: AbortSignal | null = null
  const beforeCall = async (input: BeforeCallInput, signal: AbortSignal): Promise<DenyOpinion> => {
    calls.push(input)
    lastSignal = signal
    const answer = next
    if (answer === 'never') return new Promise<DenyOpinion>(() => {})
    if (typeof answer === 'function') return answer(input)
    if ('throws' in answer) throw answer.throws
    return answer
  }
  const base = { id: q.id, kind: q.kind ?? ('local-rule' as const) }
  // A deny-ceiling registration may return what an ask one may not; the fake returns whatever the
  // case scripts, so an ask fake that denies shows the runtime check at work.
  const registration: InspectorRegistration =
    q.ceiling === 'ask'
      ? {
          ...base,
          ceiling: 'ask',
          beforeCall: beforeCall as (i: BeforeCallInput, s: AbortSignal) => Promise<AskOpinion>,
        }
      : { ...base, ceiling: 'deny', beforeCall }
  return {
    registration,
    answer(value): void {
      next = value
    },
    calls,
    get lastSignal(): AbortSignal | null {
      return lastSignal
    },
  }
}
