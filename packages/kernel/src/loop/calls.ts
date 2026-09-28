/**
 * The calls of each assistant row, as a redraw needs them (spec 02 01 修补 6「session.messages 与内容块」;
 * §调用的键与读写的数据): `calls[i]` belongs to the row's i-th `tool-request` block — its `callKey`,
 * and its closed outcome in the shape the live `tool-outcome` event carries, or null while it has
 * none. An answered card is part of that outcome (`approval`), so a restart redraws the collapsed row.
 *
 * Assembled by the kernel from the Tape (暂定: the projection has no column for it); the desktop only
 * hands it on.
 */
import type {
  ApprovalResolvedPayload,
  PermissionDecidedPayload,
  TapeEntry,
  ToolOutcomePayload,
  ToolResultPayload,
} from '../tape/entry.js'
import type { ToolOutcomeView } from './events.js'

export interface RowCall {
  readonly callKey: string
  readonly outcome: ToolOutcomeView | null
}

/** `<runId>:<requestSeq>:<i>` of a tool/ or execution/ fact that hangs on one call. */
function keyOf(entry: TapeEntry): string {
  return `${String(entry.sourceId)}:${String(entry.sourceSeq)}:${String(entry.payload['ordinal'])}`
}

/** Every assistant message's calls, in `<i>` order, by `messageId`. */
export function callsByMessage(entries: readonly TapeEntry[]): Map<string, RowCall[]> {
  const results = new Map<string, ToolResultPayload>()
  const outcomes = new Map<string, ToolOutcomePayload>()
  const decisions = new Map<string, PermissionDecidedPayload>()
  const decisionsByKey = new Map<string, PermissionDecidedPayload>()
  const resolutions = new Map<string, ApprovalResolvedPayload>()
  const calls: Array<{ messageId: string; ordinal: number; key: string }> = []
  for (const entry of entries) {
    const payload = entry.payload
    switch (entry.name) {
      case 'tool/call':
        calls.push({
          messageId: String(payload['messageId']),
          ordinal: Number(payload['ordinal']),
          key: keyOf(entry),
        })
        break
      case 'tool/result':
        results.set(keyOf(entry), payload as unknown as ToolResultPayload)
        break
      case 'execution/tool_outcome':
        outcomes.set(keyOf(entry), payload as unknown as ToolOutcomePayload)
        break
      case 'tool/permission_decided': {
        // The latest decision of a call is the one in force (a re-judgement comes after it).
        const decided = payload as unknown as PermissionDecidedPayload
        decisions.set(keyOf(entry), decided)
        if (entry.provenanceKey !== null) decisionsByKey.set(entry.provenanceKey, decided)
        break
      }
      case 'tool/approval_resolved':
        resolutions.set(keyOf(entry), payload as unknown as ApprovalResolvedPayload)
        break
      default:
        break
    }
  }
  const byMessage = new Map<string, RowCall[]>()
  for (const call of calls.toSorted((a, b) => a.ordinal - b.ordinal)) {
    const list = byMessage.get(call.messageId) ?? []
    list.push({
      callKey: call.key,
      outcome: viewOf(
        outcomes.get(call.key),
        results.get(call.key),
        decisions.get(call.key),
        resolutions.get(call.key),
        decisionsByKey,
      ),
    })
    byMessage.set(call.messageId, list)
  }
  return byMessage
}

function viewOf(
  outcome: ToolOutcomePayload | undefined,
  result: ToolResultPayload | undefined,
  decision: PermissionDecidedPayload | undefined,
  resolution: ApprovalResolvedPayload | undefined,
  decisionsByKey: ReadonlyMap<string, PermissionDecidedPayload>,
): ToolOutcomeView | null {
  if (outcome === undefined || result === undefined) return null
  const target =
    resolution === undefined
      ? undefined
      : (decisionsByKey.get(resolution.decisionKey)?.confirm?.target ?? decision?.confirm?.target)
  return {
    effect: outcome.effect,
    state: outcome.state,
    source: outcome.source,
    ...(outcome.facts === undefined ? {} : { facts: { ...outcome.facts } }),
    output: textOf(result.content),
    ...(decision === undefined ? {} : { permission: decision.summary }),
    ...(resolution === undefined || target === undefined
      ? {}
      : { approval: approvalOf(resolution, target) }),
    // An answered question's record, for the summary card (open question 18).
    ...(result.question === undefined ? {} : { question: result.question }),
  }
}

/**
 * How an answered card reads on its row (§最小审批卡「答完」): the answer, its scope, the card's
 * object. The live `tool-outcome` and the redraw build it the same way.
 */
export function approvalOf(
  resolution: ApprovalResolvedPayload,
  target: NonNullable<ToolOutcomeView['approval']>['target'],
): NonNullable<ToolOutcomeView['approval']> {
  return {
    outcome: resolution.outcome,
    scope:
      resolution.grant === null ? null : resolution.grant.scope === 'session' ? 'session' : 'once',
    target,
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
}
