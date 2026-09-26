/**
 * Approvals across IPC (spec 02 §答复与投递, §判决记录与摘要). Plan step 12 restates the decision
 * summary — the only half of a decision that crosses the boundary; the full record, its steps and
 * the layer that decided stay on the Tape (F8). The four `approval.*` routes arrive with plan steps
 * 15 and 16.
 */
import type { DecisionSummary, DecisionSummaryCode, PendingRoot } from '@tenon-app/kernel'
import { z } from 'zod'
import { defineRoute } from '../route.js'
import { confirmRequestEventPayloadSchema } from './confirm.js'
import { SESSION_READ_LIMIT_MAX, canonicalSessionIdSchema } from './session.js'

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

/** The decision a card shows, by its provenance key: what the pending row points to (§答复与投递). */
const requestIdSchema = z.string().min(1)

/**
 * An answer to the card or question a session waits on. `sessionId` is the call's own session — a
 * sub-agent's card carries the sub-agent's. `stale`: the call still waits, on another card;
 * `invalid`: the kind does not match what waits, or an answer names a question that is not there.
 */
export const approvalRespond = defineRoute('approval.respond', {
  request: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('approval'),
      sessionId: canonicalSessionIdSchema,
      requestId: requestIdSchema,
      decision: z.enum(['allow', 'deny']),
    }),
    z.object({
      kind: z.literal('question'),
      sessionId: canonicalSessionIdSchema,
      requestId: requestIdSchema,
      answers: z.record(z.string(), z.array(z.string()).readonly().nullable()), // 键为题目原文；null = 跳过
    }),
  ]),
  response: z.object({
    status: z.enum(['applied', 'already-resolved', 'stale', 'not-found', 'invalid']),
  }),
})

/**
 * What the root session shown waits on, or null: the approval card with its call's key, the row it
 * hangs under and the scope an allow grants (§调用的键与读写的数据). The question variant arrives with
 * AskUserQuestion (plan step 26).
 */
export const approvalCurrent = defineRoute('approval.current', {
  request: z.object({ sessionId: canonicalSessionIdSchema }),
  response: z
    .discriminatedUnion('waitKind', [
      z.object({
        waitKind: z.literal('approval'),
        card: confirmRequestEventPayloadSchema,
        callKey: z.string().min(1),
        anchorCallKey: z.string().min(1),
        allowScope: z.enum(['once', 'session']),
      }),
      z.object({
        waitKind: z.literal('question'),
        requestId: requestIdSchema,
        sessionId: canonicalSessionIdSchema,
        toolRequestId: z.string(),
        callKey: z.string().min(1),
      }),
    ])
    .nullable(),
})

/**
 * One row per root session that waits on an answer or can be resumed (§离开会话): a sub-agent's
 * wait is listed under its root; `resume` is a root in the kernel's resumable set. The banner passes a
 * fixed `limit`; startup recovery reads through the service, not this route.
 */
export const pendingRootSchema = z.object({
  sessionId: canonicalSessionIdSchema,
  waitKind: z.enum(['approval', 'question', 'resume']),
}) satisfies z.ZodType<PendingRoot>

export const approvalList = defineRoute('approval.list', {
  request: z.object({ limit: z.number().int().min(1).max(SESSION_READ_LIMIT_MAX) }),
  response: z.array(pendingRootSchema),
})

/**
 * Opening a root session resumes what startup recovery listed for it (§启动恢复与发送防护):
 * `resume({ rootSessionId })`, one to one; a refusal is `ok: false`.
 */
export const approvalResume = defineRoute('approval.resume', {
  request: z.object({ sessionId: canonicalSessionIdSchema }),
  response: z.object({ status: z.enum(['started', 'none']) }),
})
