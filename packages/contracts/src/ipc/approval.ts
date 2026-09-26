/**
 * Approvals across IPC (spec 02 §答复与投递, §判决记录与摘要). Plan step 12 restates the decision
 * summary — the only half of a decision that crosses the boundary; the full record, its steps and
 * the layer that decided stay on the Tape (F8). The four `approval.*` routes arrive with plan steps
 * 15 and 16.
 */
import type { DecisionSummary, DecisionSummaryCode } from '@tenon-app/kernel'
import { z } from 'zod'

/** The summary codes, only ever added to (§判决记录与摘要). */
export const decisionSummaryCodeSchema = z.enum([
  'session-allowed',
  'session-allowed-search',
  'session-allowed-domain',
  'user-rule',
  'org-policy',
  'user-disabled',
  'irreversible-once',
  'exfiltration-recheck',
  'default-ask',
  'workspace-read',
  'protected',
  'connector-requires-confirm',
  'check-incomplete',
  'inspector-blocked',
  'own-output-read',
  'no-approval-needed',
  'auto-mode',
  'task-grant',
]) satisfies z.ZodType<DecisionSummaryCode>

/**
 * A decision as the interface reads it: a verdict, a code and its slots. Strict: a summary that
 * carried steps, the deciding layer or its basis would fail parse rather than cross.
 */
export const decisionSummarySchema = z
  .object({
    verdict: z.enum(['allow', 'ask', 'deny']),
    code: decisionSummaryCodeSchema,
    facts: z.record(z.string(), z.string()), // 必填键一律为 toolName；session-allowed-domain 另加 host
  })
  .strict() satisfies z.ZodType<DecisionSummary>

export type DecisionSummaryContract = z.infer<typeof decisionSummarySchema>
