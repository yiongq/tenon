import type {
  ConfirmReason,
  ConfirmRequest,
  FlaggedCategory,
  Reversibility,
} from '@tenon-app/kernel'
import { CONFIRM_FACT_KEYS } from '@tenon-app/kernel'
import { z } from 'zod'
import { defineEvent } from '../route.js'

export const confirmReasonSchema = z.enum([
  'irreversible',
  'outside-workspace',
  'network',
  'elevated',
  'default',
  // added by spec 02 (§`ConfirmReason` 只增四个值)
  'policy',
  'flagged',
  'command',
  'interaction-required',
]) satisfies z.ZodType<ConfirmReason>

/**
 * What `facts.category` of a `flagged` request may hold. Anything else fails parse and the request
 * is not delivered, for the same reason a missing slot is not (00 spec:162).
 */
export const flaggedCategorySchema = z.enum([
  'exfiltration',
  'inspector-failed',
]) satisfies z.ZodType<FlaggedCategory>

export const reversibilitySchema = z.enum([
  'read-only',
  'revertible',
  'snapshotted',
  'irreversible',
  'unknown',
]) satisfies z.ZodType<Reversibility>

/**
 * The card's "object" line (spec 02 §`ConfirmRequest` 只增两个必填成员). Restated from the kernel's
 * ConfirmTarget without the AbsolutePath brand; a type-level test keeps the two in step. An empty
 * string would render an empty object line, so it is refused like an empty fact.
 */
export const confirmTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), command: z.string().min(1), cwd: z.string().min(1) }),
  z.object({ type: z.literal('path'), path: z.string().min(1) }),
  z.object({ type: z.literal('url'), url: z.string().min(1) }),
  z.object({ type: z.literal('search'), query: z.string().min(1), host: z.string().min(1) }),
  z.object({
    type: z.literal('tool'),
    serverId: z.string().min(1),
    toolName: z.string().min(1),
  }),
])

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
  reversibility: reversibilitySchema,
  target: confirmTargetSchema,
})

interface CheckedRequest {
  reason: ConfirmReason
  kind: ConfirmRequest['kind']
  facts: Record<string, string>
  reversibility: Reversibility
}

function checkRequiredFacts(req: CheckedRequest, ctx: z.RefinementCtx): void {
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

/** A missing `category` is already reported by checkRequiredFacts; this checks a present one. */
function checkFlaggedCategory(req: CheckedRequest, ctx: z.RefinementCtx): void {
  if (req.reason !== 'flagged') return
  const category = req.facts['category']
  if (category === undefined || category.length === 0) return
  if (!flaggedCategorySchema.safeParse(category).success) {
    ctx.addIssue({
      code: 'custom',
      path: ['facts', 'category'],
      message: `facts.category "${category}" is not a registered flagged category`,
    })
  }
}

/** One way only (E1): reason `irreversible` needs reversibility `irreversible`; not the reverse. */
function checkReversibility(req: CheckedRequest, ctx: z.RefinementCtx): void {
  if (req.reason === 'irreversible' && req.reversibility !== 'irreversible') {
    ctx.addIssue({
      code: 'custom',
      path: ['reversibility'],
      message: `reason "irreversible" needs reversibility "irreversible", got "${req.reversibility}"`,
    })
  }
}

function checkRequest(req: CheckedRequest, ctx: z.RefinementCtx): void {
  checkRequiredFacts(req, ctx)
  checkFlaggedCategory(req, ctx)
  checkReversibility(req, ctx)
}

/**
 * Rejects a request whose `facts` lack a required slot, so the approval card can never
 * render an unfilled `{slot}`; also an unregistered flagged category and a reason
 * `irreversible` whose reversibility is not.
 */
export const confirmRequestSchema = confirmRequestObject.superRefine(checkRequest)

/**
 * What actually crosses to the renderer: everything except `redacted`, the raw payload the
 * spec keeps away from the UI. zod strips the unknown key on parse.
 */
export const confirmRequestEventPayloadSchema = confirmRequestObject
  .omit({ redacted: true })
  .superRefine(checkRequest)

export type ConfirmRequestInput = z.infer<typeof confirmRequestSchema>

/** main → renderer: a request the kernel wants the user to answer. */
export const confirmRequestEvent = defineEvent('confirm.request', confirmRequestEventPayloadSchema)
