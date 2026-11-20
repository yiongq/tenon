import { z } from 'zod'
import { defineRoute } from '../route.js'
import { canonicalSessionIdSchema } from './session.js'

export const inspectorRelease = defineRoute('inspector.release', {
  request: z.object({ sessionId: canonicalSessionIdSchema, callKey: z.string().min(1) }).strict(),
  response: z.object({
    status: z.enum(['released', 'already-released', 'stale', 'not-found', 'refused']),
  }),
})
