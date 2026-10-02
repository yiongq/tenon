/**
 * Usage and cost of a Tenon run, from the Tape (spec 02 §记录格式与费用口径; M8).
 *
 * Each `provider/attempt_completed` counts once, with its final usage, priced by the `pricing` of
 * the `view/content(model_info)` its `view/assembled` points at — the price frozen when the request
 * was assembled, never the model table's current one. A sub-agent's attempts count one by one, the
 * same way: `sessionIdsOf` walks `session/parent_link` to them.
 *
 *   - `usage.input` is the input that missed the cache, per wire: `anthropic-messages`' `inputTokens`
 *     leave the cache out already; `openai-chat`'s include it, so `cacheReadTokens` and
 *     `cacheWriteTokens` come off first (the kernel's token limit counts it the same way, loop/run.ts).
 *   - `reasoningTokens` are part of `outputTokens` already and are not priced again.
 *   - Currency is `pricing.currency`, USD when absent (01 修补 2). A missing cache price is the input
 *     price. An attempt with usage and no `pricing` makes the whole cost null, as do two currencies.
 *   - A custom vendor instance's row has no `pricing` (M6 §合成): the eval-only instance column is
 *     priced at the column's own price instead, for every attempt (M6 §点名 (d), Q17).
 *
 * `perRequest` (`EvalRecord.calib`, H10) gives each request's input TOTAL — what §压缩时机与估算
 * estimates the context by: `inputTokens + cacheReadTokens + cacheWriteTokens` on anthropic-messages,
 * `inputTokens` on openai-chat — and its cost; it is recorded only when every attempt is priced.
 */
import { MAX_READ_LIMIT, viewContentKey } from '@tenon-app/kernel'
import type { ModelInfo, TapeEntry, TapeReader, Usage } from '@tenon-app/kernel'
import type { EvalRecord } from './record.js'

export type Wire = 'anthropic-messages' | 'openai-chat'
export type RecordUsage = NonNullable<EvalRecord['usage']>
export type RecordCost = NonNullable<EvalRecord['cost']>
export type Pricing = NonNullable<ModelInfo['pricing']>

const PER_MILLION = 1_000_000

/** One attempt's usage in the record's terms. A missing wire reads as the kernel reads it: as is. */
export function recordUsageOf(usage: Usage, wire: Wire | null): RecordUsage {
  const cached = usage.cacheReadTokens + usage.cacheWriteTokens
  return {
    input: wire === 'openai-chat' ? Math.max(0, usage.inputTokens - cached) : usage.inputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    output: usage.outputTokens,
    reasoning: usage.reasoningTokens,
  }
}

/** What one attempt's usage costs at `pricing`; null without one. */
export function costOf(usage: RecordUsage, pricing: Pricing | undefined): RecordCost | null {
  if (pricing === undefined) return null
  const input = pricing.inputPerMTok
  const amount =
    (usage.input * input +
      usage.cacheRead * (pricing.cacheReadPerMTok ?? input) +
      usage.cacheWrite * (pricing.cacheWritePerMTok ?? input) +
      usage.output * pricing.outputPerMTok) /
    PER_MILLION
  return { amount, currency: pricing.currency ?? 'USD' }
}

/** The input a request's context held, cache included (§压缩时机与估算「输入总量」). */
export function inputTotalOf(usage: Usage, wire: Wire | null): number {
  return wire === 'openai-chat'
    ? usage.inputTokens
    : usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

export interface TapeCost {
  readonly usage: RecordUsage | null
  readonly cost: RecordCost | null
  readonly perRequest: { input: number; cost: number }[] | null
  /** The attempts read, in Tape order per session: the last one's hashes go into `prompt`. */
  readonly attempts: readonly AttemptFacts[]
}

export interface AttemptFacts {
  readonly sessionId: string
  readonly systemHash: string
  readonly toolDefinitionsHash: string
  readonly usage: Usage | null
  readonly wire: Wire | null
  readonly pricing: Pricing | undefined
}

/** Every entry of a session, in order. */
export async function readAll(tape: TapeReader, sessionId: string): Promise<TapeEntry[]> {
  const entries: TapeEntry[] = []
  let from: number | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another, pinned by the cursor
    const page = await tape.readRange({
      sessionId,
      limit: MAX_READ_LIMIT,
      ...(from === undefined ? {} : { fromEntryId: from }),
    })
    entries.push(...page.entries)
    if (page.nextFromEntryId === null) return entries
    from = page.nextFromEntryId
  }
}

/** The root and every sub-agent session under it, through `session/parent_link`. */
export async function sessionIdsOf(tape: TapeReader, rootSessionId: string): Promise<string[]> {
  const ids: string[] = []
  const pending = [rootSessionId]
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    if (ids.includes(next)) continue
    ids.push(next)
    // oxlint-disable-next-line no-await-in-loop -- a child is found only by reading its parent
    for (const entry of await readAll(tape, next)) {
      if (entry.name !== 'session/parent_link') continue
      const child = (entry.payload['child'] as { sessionId?: unknown } | undefined)?.sessionId
      if (typeof child === 'string') pending.push(child)
    }
  }
  return ids
}

/**
 * One session's attempts, each with the pricing its assembly froze — or `priced`, the column's own
 * price, when the caller gives one (an instance column, M6 §点名 (d)).
 */
export function attemptsOf(
  sessionId: string,
  entries: readonly TapeEntry[],
  priced?: Pricing,
): AttemptFacts[] {
  const byKey = new Map(entries.map((entry) => [entry.provenanceKey, entry]))
  const attempts: AttemptFacts[] = []
  for (const entry of entries) {
    if (entry.name !== 'provider/attempt_completed') continue
    const payload = entry.payload
    const request = payload['request'] as { systemHash: string }
    const encoder = payload['encoder'] as { wire: Wire } | undefined
    const assemblyRef = payload['assemblyRef'] as string | undefined
    const assembled = assemblyRef === undefined ? undefined : byKey.get(assemblyRef)
    const modelInfoHash = assembled?.payload['modelInfoHash'] as string | undefined
    const content =
      modelInfoHash === undefined
        ? undefined
        : byKey.get(viewContentKey('model_info', modelInfoHash))
    const model = content?.payload['model'] as ModelInfo | undefined
    attempts.push({
      sessionId,
      systemHash: request.systemHash,
      toolDefinitionsHash: payload['toolDefinitionsHash'] as string,
      usage: (payload['usage'] as Usage | null) ?? null,
      wire: encoder?.wire ?? null,
      pricing: priced ?? model?.pricing,
    })
  }
  return attempts
}

/** Sums the attempts of `rootSessionId` and its sub-agents, at `priced` when given (attemptsOf). */
export async function tapeCost(
  tape: TapeReader,
  rootSessionId: string,
  priced?: Pricing,
): Promise<TapeCost> {
  const attempts: AttemptFacts[] = []
  for (const sessionId of await sessionIdsOf(tape, rootSessionId)) {
    // oxlint-disable-next-line no-await-in-loop -- sessions one after another
    attempts.push(...attemptsOf(sessionId, await readAll(tape, sessionId), priced))
  }
  return { ...sumAttempts(attempts), attempts }
}

/** The record's usage, cost and per-request line over these attempts (§记录格式与费用口径). */
export function sumAttempts(
  attempts: readonly Pick<AttemptFacts, 'usage' | 'wire' | 'pricing'>[],
): Omit<TapeCost, 'attempts'> {
  let usage: RecordUsage | null = null
  let amount = 0
  let currency: RecordCost['currency'] | null = null
  let priced = true
  const perRequest: { input: number; cost: number }[] = []
  for (const attempt of attempts) {
    if (attempt.usage === null) continue
    const line = recordUsageOf(attempt.usage, attempt.wire)
    usage =
      usage === null
        ? line
        : {
            input: usage.input + line.input,
            cacheRead: usage.cacheRead + line.cacheRead,
            cacheWrite: usage.cacheWrite + line.cacheWrite,
            output: usage.output + line.output,
            reasoning: usage.reasoning + line.reasoning,
          }
    const each = costOf(line, attempt.pricing)
    if (each === null || (currency !== null && currency !== each.currency)) {
      priced = false
      continue
    }
    amount += each.amount
    currency = each.currency
    perRequest.push({ input: inputTotalOf(attempt.usage, attempt.wire), cost: each.amount })
  }
  if (usage === null) return { usage: null, cost: null, perRequest: null }
  return priced && currency !== null
    ? { usage, cost: { amount, currency }, perRequest }
    : { usage, cost: null, perRequest: null }
}
