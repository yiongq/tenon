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
])
export type ChatEvent = z.infer<typeof chatEventSchema>

export const chatEvent = defineEvent('chat.event', chatEventSchema)
