import type { ConfirmReason, ConfirmRequest } from '@tenon-app/kernel'
import { CONFIRM_FACT_KEYS } from '@tenon-app/kernel'
import { z } from 'zod'
import { defineEvent } from '../route.js'

export const confirmReasonSchema = z.enum([
  'irreversible',
  'outside-workspace',
  'network',
  'elevated',
  'default',
]) satisfies z.ZodType<ConfirmReason>

export const confirmKindSchema = z.enum(['tool', 'file', 'command', 'network'])

/** Keys that must be present in `facts` for a given request, per spec §HostAdapter. */
export function requiredFactKeys(
  reason: ConfirmReason,
  kind: ConfirmRequest['kind'],
): readonly string[] {
  const keys = [...CONFIRM_FACT_KEYS[reason]]
  if (reason === 'irreversible') {
    if (kind === 'file') keys.push('path')
    if (kind === 'command') keys.push('command')
  }
  return keys
}

/**
 * Rejects a request whose `facts` lack a required slot, so the approval card
 * can never render an unfilled `{slot}`.
 */
const confirmRequestObject = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  kind: confirmKindSchema,
  reason: confirmReasonSchema,
  facts: z.record(z.string(), z.string()),
  redacted: z.unknown().optional(),
})

function checkRequiredFacts(
  req: { reason: ConfirmReason; kind: ConfirmRequest['kind']; facts: Record<string, string> },
  ctx: z.RefinementCtx,
): void {
  for (const key of requiredFactKeys(req.reason, req.kind)) {
    const value = req.facts[key]
    if (value === undefined || value.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['facts', key],
        message: `facts.${key} is required for reason "${req.reason}"`,
      })
    }
  }
}

/**
 * Rejects a request whose `facts` lack a required slot, so the approval card can never
 * render an unfilled `{slot}`.
 */
export const confirmRequestSchema = confirmRequestObject.superRefine(checkRequiredFacts)

/**
 * What actually crosses to the renderer: everything except `redacted`, the raw payload the
 * spec keeps away from the UI. zod strips the unknown key on parse.
 */
export const confirmRequestEventPayloadSchema = confirmRequestObject
  .omit({ redacted: true })
  .superRefine(checkRequiredFacts)

export type ConfirmRequestInput = z.infer<typeof confirmRequestSchema>

/** main → renderer: a request the kernel wants the user to answer. */
export const confirmRequestEvent = defineEvent('confirm.request', confirmRequestEventPayloadSchema)
