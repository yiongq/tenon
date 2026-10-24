import { flaggedCategorySchema } from '@tenon-app/contracts'
import type { ConfirmRequestInput } from '@tenon-app/contracts'

type FlaggedCategory = (typeof flaggedCategorySchema.options)[number]

/**
 * After a new card appears, clicks on it are ignored for this long (spec 02 §最小审批卡「排队行」;
 * F6): a click meant for the card that just collapsed must not answer the next one. 暂定 — the value
 * is plan step 20's own reading, to be checked against Cowork's stacked-card behaviour.
 */
export const APPROVAL_CLICK_GUARD_MS = 400

type Card = Pick<ConfirmRequestInput, 'reason' | 'kind' | 'facts' | 'target'>

const CATEGORIES: readonly string[] = flaggedCategorySchema.options

/** The allow button embeds the unchanged scope words (presentation-r1 ⑥). */
export const allowLabelKey = 'confirm.allowScoped' as const

/**
 * A flagged category as a catalogue key segment: one of the known ones, never a fact's text as such
 * (a key is not built from what a fact happens to hold).
 */
export function categoryOf(facts: Readonly<Record<string, unknown>>): FlaggedCategory {
  const category = facts['category']
  return typeof category === 'string' && CATEGORIES.includes(category)
    ? (category as FlaggedCategory)
    : 'exfiltration'
}

/** 「为什么停」: by reason — `irreversible` by kind, `flagged` by its category (00 spec.md:162). */
export function reasonKey(card: Pick<Card, 'reason' | 'kind' | 'facts'>): string {
  if (card.reason === 'irreversible') return `confirm.reason.irreversible.${card.kind}`
  if (card.reason === 'flagged') return `confirm.reason.flagged.${categoryOf(card.facts)}`
  if (card.reason === 'sensitive-path') {
    const category = card.facts['category']
    return `confirm.reason.sensitive-path.${category === 'auto-run' || category === 'hardlink' ? category : 'credential'}`
  }
  return `confirm.reason.${card.reason}`
}

/** 「期限」, only from `allowScope` and the target (§最小审批卡「期限」); a sub-agent's is a subtask. */
export function scopeKey(
  scope: 'once' | 'session' | null,
  targetType: Card['target']['type'],
  subtask: boolean,
): string {
  if (scope !== 'session') return 'confirm.scope.once'
  if (subtask) return targetType === 'url' ? 'confirm.scope.subtaskDomain' : 'confirm.scope.subtask'
  return targetType === 'url' ? 'confirm.scope.sessionDomain' : 'confirm.scope.session'
}
