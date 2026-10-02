/** Context compaction policy, computed from persisted turns (spec 02 H10). */
import type { ModelInfo, ProviderRequest } from '../provider/types.js'
import type { CompactionAnchorPayload, RunStartedPayload, TapeEntry } from '../tape/entry.js'
import type { TapeAttemptCompletedPayload } from '../tape/projection.js'
import { effectiveMessages } from '../tape/replay.js'

export const COMPACT_RATIO = 0.8
export const COMPACT_ABS_CAP = 150_000
export const COMPACT_KEEP_TURNS = 2
export const COMPACT_RETRY_CAP = 2
/** Rough character estimate; calibrated by plan step 34. */
export const COMPACT_CHARS_PER_TOKEN = 4
export function compactionThreshold(model: ModelInfo): number {
  return Math.min(Math.floor(model.contextLimit * COMPACT_RATIO), COMPACT_ABS_CAP)
}
/**
 * Whether the model checks its echoed thinking blocks as a prefix (02 §压缩时机与估算). M6 §运行时
 * 「前缀检查」: the row says so (`ModelInfo.checksThinkingPrefix`); a row without the key — every row
 * frozen on a Tape before M6 — falls back to 02's rule by id alone, whatever its `providerId`.
 */
export function checksThinkingPrefix(model: ModelInfo): boolean {
  return (
    model.checksThinkingPrefix ??
    (model.id === 'claude-opus-5-5' || model.id === 'claude-fable-5-1')
  )
}
export function summaryThinking(model: ModelInfo): Pick<ProviderRequest, 'thinking' | 'effort'> {
  switch (model.thinkingSpec?.mode) {
    case 'budget':
    case 'adaptive':
      return { thinking: { enabled: false } }
    case 'adaptive-gated':
      return {
        thinking: { enabled: false },
        ...(model.thinkingSpec.disableMaxEffort === undefined
          ? {}
          : { effort: model.thinkingSpec.disableMaxEffort }),
      }
    default:
      return {}
  }
}
export function latestAnchor(entries: readonly TapeEntry[]): TapeEntry | undefined {
  return entries.findLast((entry) => entry.name === 'compaction/anchor')
}
export function isBoundaryRun(entries: readonly TapeEntry[], runId: string): boolean {
  const started = entries.find((e) => e.name === 'execution/run_started' && e.sourceId === runId)
  const cause = (started?.payload as RunStartedPayload | undefined)?.cause
  return cause?.kind === 'user-message' || cause?.kind === 'continue'
}
/** Trigger messages define turns; inserted user messages and resumed Runs do not. */
export function turnStarts(entries: readonly TapeEntry[]): number[] {
  const messages = effectiveMessages(entries)
  const starts: number[] = []
  for (const entry of entries) {
    if (entry.name !== 'execution/run_started') continue
    const cause = (entry.payload as RunStartedPayload).cause
    if (cause.kind !== 'user-message' && cause.kind !== 'continue') continue
    const message = messages.find((m) => m.messageId === cause.messageId)
    // A continue with no new message replays the latest turn, rather than inventing an empty one.
    if (message !== undefined && !starts.includes(message.orderSeq)) starts.push(message.orderSeq)
  }
  return starts.toSorted((a, b) => a - b)
}
export function compactionCut(
  entries: readonly TapeEntry[],
  boundary: boolean,
  keepTurns = COMPACT_KEEP_TURNS,
): { keepFromEntryId: number; coversThroughEntryId: number } | null {
  const starts = turnStarts(entries)
  const keep = starts[Math.max(0, starts.length - 1 - (boundary ? keepTurns : 0))]
  if (keep === undefined) return null
  const previous = latestAnchor(entries)?.payload as CompactionAnchorPayload | undefined
  const lower = previous?.keepFromEntryId ?? 0
  if (!effectiveMessages(entries).some((m) => m.orderSeq >= lower && m.orderSeq < keep)) return null
  return {
    keepFromEntryId: keep,
    coversThroughEntryId: entries.findLast((e) => e.entryId < keep)?.entryId ?? 0,
  }
}
export function roughTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / COMPACT_CHARS_PER_TOKEN)
}
export function estimateInput(entries: readonly TapeEntry[], request: ProviderRequest): number {
  const anchorId = latestAnchor(entries)?.entryId ?? -1
  const latest = entries.findLast(
    (e) =>
      e.name === 'provider/attempt_completed' &&
      e.entryId > anchorId &&
      e.payload['compaction'] === undefined &&
      e.payload['usage'] != null,
  )
  if (latest === undefined)
    return roughTokens({ system: request.system, tools: request.tools, messages: request.messages })
  const fact = latest.payload as unknown as TapeAttemptCompletedPayload
  const usage = fact.usage!
  const input =
    usage.inputTokens +
    (fact.encoder?.wire === 'anthropic-messages'
      ? usage.cacheReadTokens + usage.cacheWriteTokens
      : 0)
  // Its own output is already counted; count only later content facts, never bookkeeping.
  const added = entries
    .filter(
      (e) =>
        e.entryId > latest.entryId &&
        (e.name === 'message/user' ||
          e.name === 'message/continuation' ||
          e.name === 'message/environment' ||
          e.name === 'tool/result'),
    )
    .map((e) => e.payload['content'])
  return input + usage.outputTokens + (added.length === 0 ? 0 : roughTokens(added))
}
