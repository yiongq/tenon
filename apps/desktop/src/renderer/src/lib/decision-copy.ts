import type { ToolOutcomeViewContract } from '@tenon-app/contracts'

type Summary = { readonly verdict: 'allow' | 'ask' | 'deny'; readonly code: string }

/**
 * A decision summary's sentence, for 「查看本次记录」 and an expanded tool row alike (spec 06 §界面
 * 「工具行」): by its code, and for a code this build does not know — read as `unknown`, its verdict
 * kept — one neutral sentence per verdict (rule 14, D32). Display only: nothing here decides.
 */
export function decisionKey(summary: Summary): string {
  return summary.code === 'unknown'
    ? `snapshot.decision.unknown.${summary.verdict}`
    : `snapshot.decision.${summary.code}`
}

/**
 * The expanded row's 「为什么没问」 (D10): only for a call allowed with no card — one a card asked
 * about, or not allowed, has nothing to add. Folded rows never show it.
 */
export function unaskedReason(
  outcome: Pick<ToolOutcomeViewContract, 'permission' | 'approval'> | null,
): { readonly key: string; readonly facts: Readonly<Record<string, string>> } | null {
  const permission = outcome?.permission
  if (permission === undefined || permission.verdict !== 'allow' || outcome?.approval !== undefined)
    return null
  return { key: decisionKey(permission), facts: permission.facts }
}
