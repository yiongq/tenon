/**
 * Bridge frame skeleton — the desktop ↔ server envelope and the five protocol frames.
 *
 * Skeleton: v1 is NOT frozen until phase 6b's first real consumer exists. Phase 1 fixes only
 * the four rules that cannot be retrofitted (spec 01 §桥帧骨架): version negotiation, the
 * non-fatal unknown-frame path, `tenantId` as an assertion, and the reserved `type` syntax.
 * Transport, auth, reconnect/replay and every business frame body belong to phase 6b.
 *
 * Extension shape: decode strips unknown keys, so an additive field on an existing body does not
 * survive it. Rule 1 is taken literally — new behaviour arrives as a new frame `type` behind a
 * capability, never as a new field on `hello` / `welcome` / `error`. 6b confirms this before v1
 * freezes; switching to loose objects afterwards would be a wire change, not a refactor.
 *
 * Pure functions only: no transport, no auth, no I/O. `packages/kernel` never imports this file.
 */
import { z } from 'zod'

/** Carried by every frame. The envelope never parses `body` — only the per-type schemas do. */
export const frameEnvelopeSchema = z.object({
  v: z.number().int().positive(),
  id: z.string().min(1),
  type: z.string().min(1),
  ts: z.number().int(),
  tenantId: z.string().min(1),
  deviceId: z.string().min(1),
  body: z.unknown(),
})
export type FrameEnvelope = z.infer<typeof frameEnvelopeSchema>

/** The envelope minus the two fields each decoded frame narrows. */
export type FrameHeader = Omit<FrameEnvelope, 'type' | 'body'>

/** `hello` reports an interval; new frame kinds arrive as capabilities, not as a major bump. */
export const frameHelloBodySchema = z
  .object({
    vMin: z.number().int().positive(),
    vMax: z.number().int().positive(),
    capabilities: z.array(z.string().min(1)),
  })
  .refine((hello) => hello.vMin <= hello.vMax, { message: 'vMin must not exceed vMax' })
export type FrameHelloBody = z.infer<typeof frameHelloBodySchema>

/** `welcome` picks one `v` out of the interval plus the agreed capability set. */
export const frameWelcomeBodySchema = z.object({
  v: z.number().int().positive(),
  capabilities: z.array(z.string().min(1)),
})
export type FrameWelcomeBody = z.infer<typeof frameWelcomeBodySchema>

/** `ping` and `pong` carry nothing. */
export const frameEmptyBodySchema = z.object({})

export const frameErrorCodeSchema = z.enum([
  'unsupported-frame',
  'unsupported-version',
  'bad-frame',
  'unauthorized',
])
export type FrameErrorCode = z.infer<typeof frameErrorCodeSchema>

export const frameErrorBodySchema = z.object({
  code: frameErrorCodeSchema,
  /** The `id` of the frame this answers, when it was readable. */
  replyTo: z.string().min(1).optional(),
})
export type FrameErrorBody = z.infer<typeof frameErrorBodySchema>

/** The only frames with a body schema. Phase 1 names no business frame at all. */
const protocolBodySchemas = {
  hello: frameHelloBodySchema,
  welcome: frameWelcomeBodySchema,
  ping: frameEmptyBodySchema,
  pong: frameEmptyBodySchema,
  error: frameErrorBodySchema,
} as const

export type ProtocolFrameType = keyof typeof protocolBodySchemas

/** Frozen, not merely `readonly`: a 6b dispatcher may iterate it, so no importer may grow it. */
export const PROTOCOL_FRAME_TYPES: readonly ProtocolFrameType[] = Object.freeze(
  Object.keys(protocolBodySchemas) as ProtocolFrameType[],
)

export type ProtocolFrame = {
  [K in ProtocolFrameType]: FrameHeader & {
    type: K
    body: z.infer<(typeof protocolBodySchemas)[K]>
  }
}[ProtocolFrameType]

export function isProtocolFrameType(type: string): type is ProtocolFrameType {
  return Object.hasOwn(protocolBodySchemas, type)
}

/**
 * Rule 4: a `type` without '/' is reserved for the protocol itself (the five above);
 * a business frame is '<namespace>/<name>'. `reserved` is about the space, not membership —
 * `isProtocolFrameType` answers that.
 *
 * Only the syntax half of rule 4 lives here. The prefix-reservation half — which namespaces are
 * first-party — is Tape's name table in `packages/kernel` (`RESERVED_NAMESPACES`), and this
 * classifier deliberately does not consult it: a frame type is classified by shape, and its bound is
 * the transport's frame size, while a tape name is bounded by what an index and a log line can carry.
 * What the two must share is the per-segment syntax, and `test/frame-tape-syntax.test.ts` is the only
 * thing holding them together — tighten either regex and that test goes red.
 */
export type FrameTypeKind = 'reserved' | 'namespaced' | 'malformed'

const TYPE_SEGMENT = /^[a-z][a-z0-9_]*$/

/**
 * Two or more segments, not exactly two: Tape's only non-first-party name shape is
 * `ext/<owner>/<name>`, and rule 4 puts frame types in that same name space.
 */
export function classifyFrameType(type: string): FrameTypeKind {
  const segments = type.split('/')
  if (!segments.every((segment) => TYPE_SEGMENT.test(segment))) return 'malformed'
  return segments.length === 1 ? 'reserved' : 'namespaced'
}

/** A rejection is always an `error` body the caller wraps in its own envelope. */
export type FrameCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: FrameErrorBody }

export type FrameDecodeResult =
  | { readonly ok: true; readonly frame: ProtocolFrame }
  | { readonly ok: false; readonly error: FrameErrorBody }

function failure(
  code: FrameErrorCode,
  replyTo: string | undefined,
): { readonly ok: false; readonly error: FrameErrorBody } {
  return { ok: false, error: replyTo === undefined ? { code } : { code, replyTo } }
}

/** Salvages an `id` from a frame the envelope rejected, so even a bad frame gets a `replyTo`. */
function salvageId(raw: unknown): string | undefined {
  const id = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Rule 2: an unknown `type` — reserved, namespaced or malformed — decodes into the
 * 'unsupported-frame' error path. It never throws and is never fatal. A malformed envelope,
 * or a known type with a body its schema rejects, is 'bad-frame'.
 */
export function decodeFrame(raw: unknown): FrameDecodeResult {
  try {
    const envelope = frameEnvelopeSchema.safeParse(raw)
    if (!envelope.success) return failure('bad-frame', salvageId(raw))
    const { type, body, ...header } = envelope.data
    if (!isProtocolFrameType(type)) return failure('unsupported-frame', header.id)
    const parsed = protocolBodySchemas[type].safeParse(body)
    if (!parsed.success) return failure('bad-frame', header.id)
    // The cast pairs `type` with its own body schema; TypeScript cannot correlate the two here.
    return { ok: true, frame: { ...header, type, body: parsed.data } as ProtocolFrame }
  } catch {
    // `raw` is `unknown`, so it may be an in-process object with a throwing accessor or a
    // hostile Proxy rather than a parsed JSON value. That is just another bad frame.
    return failure('bad-frame', undefined)
  }
}

/** What this side of the bridge supports. Both ends declare it; neither reads it off a frame. */
export interface ProtocolSupport {
  readonly vMin: number
  readonly vMax: number
  readonly capabilities: readonly string[]
}

export type FrameNegotiationResult =
  | { readonly ok: true; readonly welcome: FrameWelcomeBody }
  | { readonly ok: false; readonly error: FrameErrorBody }

/**
 * Rule 1: pick the highest `v` both ends accept plus the capability intersection; no overlap
 * is an 'unsupported-version' error body, never an exception.
 *
 * Both ends are re-parsed here. `FrameHelloBody` infers to plain numbers, so a caller that
 * skipped `decodeFrame` can hand in a float or a zero; the ok branch must never carry a
 * `welcome` its own schema would reject.
 */
export function negotiateVersion(
  hello: FrameHelloBody,
  local: ProtocolSupport,
  replyTo?: string,
): FrameNegotiationResult {
  const offer = frameHelloBodySchema.safeParse(hello)
  if (!offer.success) return failure('bad-frame', replyTo)
  const v = Math.min(offer.data.vMax, local.vMax)
  if (v < Math.max(offer.data.vMin, local.vMin)) return failure('unsupported-version', replyTo)
  const offered = new Set(offer.data.capabilities)
  const capabilities = [...new Set(local.capabilities.filter((c) => offered.has(c)))]
  const welcome = frameWelcomeBodySchema.safeParse({ v, capabilities })
  // A `local` range the welcome schema rejects is our own misconfiguration, not the peer's offer.
  if (!welcome.success) return failure('unsupported-version', replyTo)
  return { ok: true, welcome: welcome.data }
}

declare const derivedTenant: unique symbol

/**
 * A tenant id the server re-derived from the device credential. The brand is the point: a frame's
 * own `tenantId` is a `string` and cannot be passed as one, so `checkTenantAssertion(frame,
 * frame.tenantId)` — the frame authorising itself — does not typecheck.
 */
export type DerivedTenantId = string & { readonly [derivedTenant]: true }

/**
 * The one mint, so every crossing of this trust boundary is greppable. Its argument must come
 * from the device credential; passing a value read off a frame defeats rule 3.
 */
export function derivedTenantIdFromCredential(tenantId: string): DerivedTenantId {
  return tenantId as DerivedTenantId
}

/**
 * Rule 3: a frame's `tenantId` is an ASSERTION. The server re-derives the tenant from the
 * device credential and compares; a mismatch is 'unauthorized'. This module deliberately
 * exposes no API where a frame's `tenantId` selects a tenant — the ok branch returns no
 * tenant id for a caller to use, and the derived id it compares against is nominally distinct
 * from anything a frame can carry.
 */
export function checkTenantAssertion(
  frame: Pick<FrameEnvelope, 'id' | 'tenantId'>,
  derivedTenantId: DerivedTenantId,
): FrameCheck {
  if (derivedTenantId.length === 0 || derivedTenantId !== frame.tenantId) {
    return failure('unauthorized', frame.id.length > 0 ? frame.id : undefined)
  }
  return { ok: true }
}
