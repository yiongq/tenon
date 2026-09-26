import type { ProviderErrorCode, RunEndReason } from '@tenon-app/kernel'
import { z } from 'zod'
import { defineEvent, defineRoute } from '../route.js'

export const sessionIdSchema = z.string().min(1)

/** The provider error codes an end reason carries (01 修补 5); only ever added to. */
export const providerErrorCodeSchema = z.enum([
  'auth',
  'rate-limit',
  'overloaded',
  'invalid-request',
  'context-overflow',
  'network',
  'egress-denied',
  'server',
  'unknown',
  'quota-exhausted',
  'account-config',
]) satisfies z.ZodType<ProviderErrorCode>

/**
 * Why a whole Run ended (spec 02 §结束原因词表): a closed vocabulary of 18 codes, each member's
 * slots on the member itself. The interface finds its copy by `code`; the kernel writes no sentence.
 */
export const runEndReasonSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('completed') }),
  z.object({ code: z.literal('user-stopped') }),
  z.object({
    code: z.literal('paused'),
    waitingFor: z.enum(['approval', 'question', 'subagent']),
  }),
  z.object({ code: z.literal('user-rejected'), toolName: z.string() }),
  z.object({ code: z.literal('blocked-repeatedly'), count: z.number().int() }),
  z.object({ code: z.literal('step-limit'), limit: z.number().int() }),
  z.object({ code: z.literal('no-progress'), repeats: z.number().int() }),
  z.object({ code: z.literal('usage-limit'), tokenLimit: z.number() }),
  z.object({ code: z.literal('refusal'), providerId: z.string(), modelId: z.string() }),
  z.object({ code: z.literal('content-filter'), providerId: z.string() }),
  z.object({ code: z.literal('context-overflow'), compactions: z.number().int() }),
  z.object({
    code: z.literal('quota-exhausted'),
    providerId: z.string(),
    resetAt: z.number().nullable(),
  }),
  z.object({ code: z.literal('account-config'), providerId: z.string() }),
  z.object({
    code: z.literal('provider-error'),
    providerId: z.string(),
    errorCode: providerErrorCodeSchema.nullable(),
    providerReason: z.string().nullable(),
    attempts: z.number().int(),
  }),
  z.object({ code: z.literal('output-truncated'), maxTokens: z.number().int() }),
  z.object({ code: z.literal('shutdown-aborted'), trigger: z.enum(['quit', 'close-window']) }),
  z.object({ code: z.literal('recovered') }),
  z.object({ code: z.literal('time-limit'), limitMs: z.number() }),
]) satisfies z.ZodType<RunEndReason>
export type RunEndReasonContract = z.infer<typeof runEndReasonSchema>

/** Send one user message; the reply arrives as `chatEvent`s. */
export const chatSend = defineRoute('chat.send', {
  request: z.object({ sessionId: sessionIdSchema, text: z.string().min(1) }),
  response: z.object({ accepted: z.literal(true) }),
})

/** Abort the in-flight reply of a session. Idempotent. */
export const chatStop = defineRoute('chat.stop', {
  request: z.object({ sessionId: sessionIdSchema }),
  response: z.object({ stopped: z.boolean() }),
})

/**
 * 「继续」 after a Run that ended as `step-limit` or `output-truncated`, with no user message since
 * (spec 02 §重试与「继续」). `not-sent`: a missing key, or stopped before anything was written;
 * `held`: the choice would switch to a public host indirectly, and `host` names it for the menu.
 */
export const chatContinue = defineRoute('chat.continue', {
  request: z.object({ sessionId: sessionIdSchema }),
  response: z.object({
    status: z.enum(['started', 'not-available', 'not-sent', 'held']),
    host: z.string().optional(),
  }),
})

export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), sessionId: sessionIdSchema, delta: z.string() }),
  z.object({
    type: z.literal('done'),
    sessionId: sessionIdSchema,
    stopReason: z.enum(['end-turn', 'aborted', 'error']),
    /** Spec 02 (H12): why the whole Run ended; phase 1's `stopReason` is unchanged beside it. */
    endReason: runEndReasonSchema.optional(),
  }),
  z.object({
    type: z.literal('error'),
    sessionId: sessionIdSchema,
    /** A code the UI maps to copy; never a sentence from the kernel. */
    code: z.enum(['network', 'auth', 'rate-limit', 'provider', 'unknown']),
    detail: z.string().optional(),
    /** Spec 02 (开放问题 16): on every Run's end; absent on an error that is not a Run's. */
    endReason: runEndReasonSchema.optional(),
  }),
  // Spec 02, 01 修补 6 (decisions H12, H3, A11, B1): only-added variants. `tool-outcome` comes with
  // step 14, when the types it carries exist.
  z.object({ type: z.literal('thinking-delta'), sessionId: sessionIdSchema, delta: z.string() }),
  z.object({
    type: z.literal('tool-call'),
    sessionId: sessionIdSchema,
    /** `<runId>:<requestSeq>:<i>`, the same shape as the tool facts' key; the UI compares it only. */
    callKey: z.string().min(1),
    providerToolCallId: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  /** This attempt writes no assistant message (discarded or failed): drop what it streamed. */
  z.object({ type: z.literal('attempt-discarded'), sessionId: sessionIdSchema }),
])
export type ChatEvent = z.infer<typeof chatEventSchema>

export const chatEvent = defineEvent('chat.event', chatEventSchema)

/** main → renderer: start a fresh session (application menu / shortcut). */
export const chatNew = defineEvent('chat.new', z.object({}))
