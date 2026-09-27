import type { ProviderErrorCode, RunEndReason } from '@tenon-app/kernel'
import { z } from 'zod'
import { defineEvent, defineRoute } from '../route.js'
import { toolOutcomeViewShape } from './outcome.js'

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

// The outcome view and its enums live in outcome.ts (session.ts reads them too); restated here.
export {
  closureSourceSchema,
  executionStateSchema,
  toolOutcomeViewSchema,
  toolOutcomeViewShape,
} from './outcome.js'
export type { ToolOutcomeViewContract } from './outcome.js'

/**
 * What became of a send (spec 02 plan step 20; the kernel's `SendResult` less `refused`, which is a
 * route error): `started`, `queued` and `held` are followed by the events that show the message;
 * after any other the renderer settles the message it showed, since nothing will name it.
 */
export const sendStatusSchema = z.enum([
  'started',
  'queued',
  'held',
  'answered',
  'not-sent',
  'not-found',
])

/** Send one user message; the reply arrives as `chatEvent`s. */
export const chatSend = defineRoute('chat.send', {
  request: z.object({ sessionId: sessionIdSchema, text: z.string().min(1) }),
  response: z.object({ accepted: z.literal(true), status: sendStatusSchema.optional() }),
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
    /** Spec 02 (plan step 20): which Run ended, for the copied diagnostics; null when none was written. */
    runId: z.string().min(1).nullable().optional(),
    /**
     * Spec 02 (plan step 20): the user message that opened the Run, when none of its calls was
     * dispatched — 「重试」 resends it (§失败卡与结束原因); null for any other Run.
     */
    retryOf: z.string().min(1).nullable().optional(),
  }),
  z.object({
    type: z.literal('error'),
    sessionId: sessionIdSchema,
    /** A code the UI maps to copy; never a sentence from the kernel. */
    code: z.enum(['network', 'auth', 'rate-limit', 'provider', 'unknown']),
    detail: z.string().optional(),
    /** Spec 02 (开放问题 16): on every Run's end; absent on an error that is not a Run's. */
    endReason: runEndReasonSchema.optional(),
    /** Spec 02 (plan step 20): as on `done`; absent with `endReason`. */
    runId: z.string().min(1).nullable().optional(),
    retryOf: z.string().min(1).nullable().optional(),
  }),
  // Spec 02, 01 修补 6 (decisions H12, H3, A11, B1): only-added variants.
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
  /** Sent once the call's `tool/result` and `execution/tool_outcome` are committed. */
  z.object({
    type: z.literal('tool-outcome'),
    sessionId: sessionIdSchema,
    callKey: z.string().min(1),
    providerToolCallId: z.string(),
    ...toolOutcomeViewShape,
  }),
  /** This attempt writes no assistant message (discarded or failed): drop what it streamed. */
  z.object({ type: z.literal('attempt-discarded'), sessionId: sessionIdSchema }),
  /**
   * A `message/user` committed (plan step 17): a direct message, or a queued one inserted at a batch
   * boundary or sent after a Run — then with its `queuedId`, so its queued bubble becomes it.
   */
  z.object({
    type: z.literal('user-message'),
    sessionId: sessionIdSchema,
    messageId: z.string().min(1),
    queuedId: z.string().min(1).nullable(),
  }),
])
export type ChatEvent = z.infer<typeof chatEventSchema>

export const chatEvent = defineEvent('chat.event', chatEventSchema)

/**
 * The queue of a session, whole and in order, pushed on every change (spec 02 01 修补 6「排队、立即发送与
 * 继续」); `held` while a new round waits on the menu's confirmation of a public host.
 */
export const chatQueueEvent = defineEvent(
  'chat.queue',
  z.object({
    sessionId: sessionIdSchema,
    items: z.array(z.object({ queuedId: z.string().min(1), text: z.string().min(1) })),
    held: z.object({ host: z.string() }).optional(),
  }),
)

/**
 * What the user does to a queued message: withdraw it, edit it, or send it now — stopping the Run
 * they saw (`runId`), and only that one. `not-found`: already inserted, sent or withdrawn.
 */
export const chatQueueAct = defineRoute('chat.queue.act', {
  request: z.discriminatedUnion('action', [
    z.object({
      action: z.literal('withdraw'),
      sessionId: sessionIdSchema,
      queuedId: z.string().min(1),
    }),
    z.object({
      action: z.literal('edit'),
      sessionId: sessionIdSchema,
      queuedId: z.string().min(1),
      text: z.string().min(1),
    }),
    z.object({
      action: z.literal('send-now'),
      sessionId: sessionIdSchema,
      queuedId: z.string().min(1),
      runId: z.string().min(1).nullable(),
    }),
  ]),
  response: z.object({
    status: z.enum(['applied', 'not-found']),
    /** Spec 02 (plan step 20): for a send-now, what became of the send, as `chat.send`'s `status`. */
    sendStatus: sendStatusSchema.optional(),
  }),
})

/**
 * Cmd/Ctrl+Enter: stop the Run the user saw (`runId`) as a user stop, then send this as the next
 * message; with no Run, the same as `chat.send`.
 */
export const chatSendNow = defineRoute('chat.sendNow', {
  request: z.object({
    sessionId: sessionIdSchema,
    text: z.string().min(1),
    runId: z.string().min(1).nullable(),
  }),
  response: z.object({ accepted: z.literal(true), status: sendStatusSchema.optional() }),
})

/** main → renderer: start a fresh session (application menu / shortcut). */
export const chatNew = defineEvent('chat.new', z.object({}))
