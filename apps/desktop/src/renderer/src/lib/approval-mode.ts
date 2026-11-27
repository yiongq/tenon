import type { ApprovalMode, RunEndReasonContract, SessionFactsResponse } from '@tenon-app/contracts'

/**
 * The approval mode as the composer shows it (spec 06 §界面). Pure: the menu, the banner and the
 * downgrade line read only `session.facts` and the Run's end, never the policy or the Tape.
 */

/** The menu's items: none outside a task, manual alone while the policy turns auto off (D13, D40). */
export function modeMenuItems(facts: SessionFactsResponse | null): readonly ApprovalMode[] {
  if (facts?.profile !== 'cowork') return []
  return facts.autoModeDisabled === true ? ['manual'] : ['manual', 'auto']
}

/** The banner stays while a task is in auto; it cannot be closed (D9). */
export function showsAutoBanner(facts: SessionFactsResponse | null): boolean {
  return facts?.profile === 'cowork' && facts.approvalMode === 'auto' && !facts.autoModeDisabled
}

/**
 * Consecutive machine blocks that stop a session (02 §上限、守卫与用量 `MACHINE_DENIAL_CAP`). The
 * renderer reads no kernel value, so it is restated here; a test holds the two equal.
 */
export const CONSECUTIVE_BLOCK_CAP = 3

export interface Downgrade {
  readonly scope: 'consecutive' | 'round'
  readonly count: number
}

/**
 * Why a task left auto without the user choosing it (§熔断, §界面「降档提示」): its Run ended on
 * blocks — the reason says which kind and how many — or a child stopped on three in a row while the
 * round went on, which shows only as the mode having changed. A policy fold is not a downgrade (D40).
 */
export function downgradeOf(q: {
  readonly before: SessionFactsResponse | null
  readonly after: SessionFactsResponse
  readonly endReason: RunEndReasonContract | undefined
}): Downgrade | null {
  if (q.before?.profile !== 'cowork' || q.before.approvalMode !== 'auto') return null
  if (q.after.approvalMode !== 'manual' || q.after.autoModeDisabled === true) return null
  if (q.endReason?.code === 'blocked-repeatedly') {
    return {
      scope: q.endReason.scope === 'round' ? 'round' : 'consecutive',
      count: q.endReason.count,
    }
  }
  return { scope: 'consecutive', count: CONSECUTIVE_BLOCK_CAP }
}
