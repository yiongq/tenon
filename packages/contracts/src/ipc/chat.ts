import { z } from 'zod'
import { defineEvent, defineRoute } from '../route.js'

export const sessionIdSchema = z.string().min(1)

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

export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), sessionId: sessionIdSchema, delta: z.string() }),
  z.object({
    type: z.literal('done'),
    sessionId: sessionIdSchema,
    stopReason: z.enum(['end-turn', 'aborted', 'error']),
  }),
  z.object({
    type: z.literal('error'),
    sessionId: sessionIdSchema,
    /** A code the UI maps to copy; never a sentence from the kernel. */
    code: z.enum(['network', 'auth', 'rate-limit', 'provider', 'unknown']),
    detail: z.string().optional(),
  }),
  // Spec 02, 01 修补 6 (decisions H12, H3, A11, B1): only-added variants. `done.endReason` comes with
  // step 13 and `tool-outcome` with step 14, when the types they carry exist.
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
