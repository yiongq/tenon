/**
 * A closed call as the interface shows it (spec 02 01 修补 6; §判决记录与摘要): the decision summary
 * — the only half of a decision that crosses (F8) — and the outcome view the live `tool-outcome`
 * event and a redrawn row's `calls[i]` both carry. Its own module because `chat.ts` and `session.ts`
 * both read it, and `approval.ts` imports `session.ts`.
 */
import type {
  ClosureSource,
  DecisionSummary,
  DecisionSummaryCode,
  ExecutionState,
} from '@tenon-app/kernel'
import { z } from 'zod'
import { confirmTargetSchema } from './confirm.js'

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

/** How far a call got (spec 02 §原因码表). */
export const executionStateSchema = z.enum([
  'not-run',
  'aborted',
  'completed',
  'uncertain',
]) satisfies z.ZodType<ExecutionState>

/** Why a call was closed rather than run to its end; only ever added to (spec 02 §原因码表). */
export const closureSourceSchema = z.enum([
  'policy',
  'user-disabled',
  'protected',
  'inspector',
  'user-rejected',
  'stopped',
  'timed-out',
  'superseded',
  'tool-unavailable',
  'invalid-input',
  'crashed',
  'app-exit',
  'output-truncated',
  'step-limit',
  'no-progress',
  'usage-limit',
  'blocked-repeatedly',
  'content-filter',
  'provider-error',
  'repair',
  'no-preference',
  'unanswered',
  'typed-answer',
]) satisfies z.ZodType<ClosureSource>

/**
 * A closed call as the interface shows it (01 修补 6): the kernel's `ToolOutcomeView`. What the
 * model read is `output`; the decision crosses as its summary only (F8). The optional members are
 * exact, like the kernel type's: absent, never `undefined`.
 */
export const toolOutcomeViewShape = {
  effect: z.enum(['read', 'write', 'external', 'blocked']),
  state: executionStateSchema,
  source: closureSourceSchema.nullable(), // null = 正常执行完
  facts: z.record(z.string(), z.string()).exactOptional(), // 只在 source 是拦截码时有，键按 BLOCKED_FACT_KEYS
  output: z.string(),
  permission: decisionSummarySchema.exactOptional(), // 没有判决事实的调用没有这一项（F8）
  approval: z
    .object({
      outcome: z.enum([
        'allowed',
        'denied',
        'cancelled-by-stop',
        'superseded',
        'tool-unavailable',
        'denied-on-rejudge',
      ]),
      scope: z.enum(['once', 'session']).nullable(),
      target: confirmTargetSchema,
    })
    .exactOptional(), // 只在出过卡的调用上有
  question: z
    .object({
      answers: z.record(z.string(), z.array(z.string()).readonly().nullable()),
      response: z.string().exactOptional(),
    })
    .exactOptional(), // 只在答过的 AskUserQuestion 上有（开放问题 18）
  handoff: z
    .object({
      outcome: z.enum(['completed', 'partial', 'aborted', 'superseded', 'uncertain']),
      childEndReason: z.string().nullable(),
      childSessionId: z.string(),
    })
    .exactOptional(), // 只在 Agent 调用上有（开放问题 18）
}
/**
 * Not `satisfies z.ZodType<ToolOutcomeView>`: the kernel brands `ConfirmTarget`'s paths, which a
 * schema of the wire cannot produce. The contract test asserts the kernel view is one of these.
 */
export const toolOutcomeViewSchema = z.object(toolOutcomeViewShape)
export type ToolOutcomeViewContract = z.infer<typeof toolOutcomeViewSchema>
