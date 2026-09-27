import { z } from 'zod'
import { defineEvent } from '../route.js'
import { canonicalSessionIdSchema } from './session.js'

/**
 * Whether a root session has a Run in progress (spec 02 §进行中、暂停与 RunRegistry; open question 16):
 * the main process's reading, pushed on every change, because the renderer's own thread cannot see
 * a Run it did not start (a resume, 「继续」, an auto-send). The leave dialog and the stop button
 * read it; send-now carries its `runId`.
 */
export const runStateEvent = defineEvent(
  'run.state',
  z.object({
    /** The root session. */
    sessionId: canonicalSessionIdSchema,
    /** A live lease that is not aborted, one that has not opened its Run yet included. */
    running: z.boolean(),
    /** The Run the lease opened (a sub-agent's counts; an aborted one still closing too); else null. */
    runId: z.string().min(1).nullable(),
  }),
)
export type RunState = z.infer<typeof runStateEvent.payload>
