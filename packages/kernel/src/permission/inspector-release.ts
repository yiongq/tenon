/** Inspector receipts release only their original denying checks, for one identical future call. */
import { isCanonicalUuid } from '../ids.js'
import type { InspectorReleaseQuery, ReleaseResult } from '../session/service.js'
import type {
  InspectorOverridePayload,
  PermissionDecidedPayload,
  TapeEntry,
} from '../tape/entry.js'
import { inspectorOverrideKey } from '../tape/provenance.js'
import type { Tape } from '../tape/tape.js'
import { validReceiptReleases } from './receipt-releases.js'

const INSPECTOR_OVERRIDE = 'tool/inspector_override'
export const isInspectorRelease = (entry: TapeEntry) => entry.name === INSPECTOR_OVERRIDE
export const validInspectorReleases = (entries: readonly TapeEntry[]) =>
  validReceiptReleases(entries, isInspectorRelease)

export function unboundInspectorOverride(
  entries: readonly TapeEntry[],
  toolName: string,
  argsHash: string,
) {
  const entry = validInspectorReleases(entries).find(
    (fact) => fact.payload['toolName'] === toolName && fact.payload['argsHash'] === argsHash,
  )
  return entry === undefined ? undefined : { key: entry.provenanceKey }
}

/** Caller owns the root mailbox throughout lookup, deduplication and append. */
export async function releaseInspectorReceipt(
  q: InspectorReleaseQuery,
  ctx: { tape: Tape; entries: readonly TapeEntry[]; now: () => number; refused?: () => boolean },
): Promise<ReleaseResult> {
  const [runId = '', seq = '', ordinal = '', extra] = q.callKey.split(':')
  if (
    !isCanonicalUuid(runId) ||
    !/^(0|[1-9]\d*)$/.test(seq) ||
    !/^(0|[1-9]\d*)$/.test(ordinal) ||
    extra !== undefined ||
    !Number.isSafeInteger(Number(seq)) ||
    !Number.isSafeInteger(Number(ordinal))
  )
    return { status: 'not-found' }
  const { entries } = ctx
  const sameCall = entries.filter(
    (entry) =>
      entry.sourceId === runId &&
      entry.sourceSeq === Number(seq) &&
      entry.payload['ordinal'] === Number(ordinal),
  )
  const call = sameCall.find((entry) => entry.name === 'tool/call')
  if (
    call === undefined ||
    entries.some(
      (entry) =>
        entry.name === 'message/retracted' &&
        entry.payload['messageId'] === call.payload['messageId'],
    )
  )
    return { status: 'not-found' }
  const decision = sameCall.findLast((entry) => entry.name === 'tool/permission_decided')
    ?.payload as PermissionDecidedPayload | undefined
  if (decision?.record.verdict !== 'deny' || decision.record.decidedBy !== 'inspector')
    return { status: 'stale' }
  const inspectorIds = [
    ...new Set(
      decision.record.steps
        .filter(
          (step) =>
            step.by === 'inspector' && step.said === 'deny' && step.inspectorId !== undefined,
        )
        .map((step) => step.inspectorId!),
    ),
  ]
  if (inspectorIds.length === 0) return { status: 'stale' }
  const key = inspectorOverrideKey(runId, Number(seq), Number(ordinal))
  if (entries.some((entry) => entry.provenanceKey === key)) return { status: 'already-released' }
  const head = await ctx.tape.head(q.sessionId)
  if (head === null) return { status: 'not-found' }
  if (ctx.refused?.()) return { status: 'refused' }
  const payload: InspectorOverridePayload = {
    ordinal: Number(ordinal),
    providerToolCallId: String(call.payload['providerToolCallId']),
    toolName: String(call.payload['name']),
    argsHash: String(call.payload['argsHash']),
    inspectorIds,
    via: 'receipt-override',
    writer: { by: 'resolver' },
  }
  await ctx.tape.writer('tool').write({
    sessionId: q.sessionId,
    incarnationId: head.incarnationId,
    fact: {
      name: INSPECTOR_OVERRIDE,
      fields: {
        sourceType: 'runtime_event',
        sourceId: runId,
        sourceSeq: Number(seq),
        provenanceKey: key,
        payload,
        createdAt: ctx.now(),
      },
    },
  })
  return { status: 'released' }
}
