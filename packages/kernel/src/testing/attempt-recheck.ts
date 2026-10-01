/**
 * The re-check of one `provider/attempt_completed` (spec 02 §组装清单与内容寄存「复算 promptHash」,
 * 02 不变量 33, acceptance 7; decisions A3, M3).
 *
 * The request is rebuilt from the Tape alone — the ModelInfo and system originals its `view/assembled`
 * names, the frozen tool table when it was sent (else `[]`), the attempt's `request` snapshot and the
 * context folded up to its `contextAtEntryId` — and re-encoded by this build's encoder for its wire.
 * No model registry and no system prompt in code are read on the way: that is what lets a record
 * outlive an edit of the model table. The current table is consulted once, after the re-encode, and
 * only to tell 「模型表已变」 from a record that still matches it.
 *
 * The verdicts:
 *
 *   not-covered          no `assemblyRef` (a phase-1 record), or an `encoder` that is not this build's
 *                        wire, version and sdk: invariant 33 speaks of neither (§以后再评估「encoder.version
 *                        不同的旧记录怎么复核」)
 *   tampered             the Tape does not reproduce its own record: an original is missing or does not
 *                        hash to the name it is filed under, or the re-encode gives another hash
 *   model-table-changed  the record recomputes from its originals, but the current row for
 *                        (providerId, modelId) has other wire fields, or there is none — never reported
 *                        as tampering (A3)
 *   verified             it recomputes, and the current row would put the same model fields on the wire
 *
 * A tampered record wins over a changed table: a verdict that blamed the table could hide an edit of
 * the Tape.
 */
import type {
  EncodedRequest,
  ModelInfo,
  ProviderId,
  ProviderRequest,
  ToolSpec,
} from '../provider/types.js'
import {
  ANTHROPIC_MESSAGES_ENCODER,
  encodeAnthropicMessages,
} from '../provider/wire/anthropic-messages.js'
import { OPENAI_CHAT_ENCODER, encodeOpenAIChat } from '../provider/wire/openai-chat.js'
import {
  NO_SYSTEM_PROMPT_HASH,
  canonicalHash,
  modelWireHash,
  systemHash,
} from '../provider/wire/shared.js'
import type { EncoderInfo } from '../provider/wire/shared.js'
import type { TapeEntry, ViewAssembledPayload, ViewContentPayload } from '../tape/entry.js'
import type { TapeAttemptCompletedPayload } from '../tape/projection.js'
import { assembledKey, viewContentKey } from '../tape/provenance.js'
import { rebuildProviderContext, replayContext } from '../tape/replay.js'
import { MAX_READ_LIMIT } from '../tape/store.js'
import type { TapeReader } from '../tape/store.js'

export interface AttemptRecheckQuery {
  readonly sessionId: string
  /** The `provider/attempt_completed` fact, as the store returned it. */
  readonly attempt: TapeEntry
  /**
   * The model table now: the row for this provider and wire id, or null when it has none. Read for
   * the verdict only, never for the re-encode.
   */
  readonly currentModel: (providerId: ProviderId, modelId: string) => ModelInfo | null
}

export type AttemptRecheck =
  | {
      readonly verdict: 'verified'
      /** The request rebuilt from the Tape; it encodes to the recorded `promptHash`. */
      readonly request: ProviderRequest
    }
  | {
      readonly verdict: 'model-table-changed'
      readonly request: ProviderRequest
      /** The current row's `modelWireHash`; null when the table has no row for it. */
      readonly currentModelWireHash: string | null
    }
  | { readonly verdict: 'tampered'; readonly problems: readonly string[] }
  | { readonly verdict: 'not-covered'; readonly reason: 'no-assembly' | 'other-encoder' }

const ENCODERS: readonly EncoderInfo[] = [ANTHROPIC_MESSAGES_ENCODER, OPENAI_CHAT_ENCODER]

/** Re-checks one attempt fact against the Tape it was read from (02 不变量 33). */
export async function recheckAttempt(
  store: TapeReader,
  q: AttemptRecheckQuery,
): Promise<AttemptRecheck> {
  if (q.attempt.name !== 'provider/attempt_completed') {
    throw new Error(`recheckAttempt: entry ${q.attempt.entryId} is ${q.attempt.name}`)
  }
  const fact = q.attempt.payload as unknown as TapeAttemptCompletedPayload
  if (fact.assemblyRef === undefined) return { verdict: 'not-covered', reason: 'no-assembly' }
  const recorded = fact.encoder
  const encoder = ENCODERS.find(
    (candidate) =>
      recorded !== undefined &&
      candidate.wire === recorded.wire &&
      candidate.version === recorded.version &&
      candidate.sdk === recorded.sdk,
  )
  if (encoder === undefined) return { verdict: 'not-covered', reason: 'other-encoder' }

  const problems: string[] = []
  const rebuilt = await rebuildRequest(store, q, fact, problems)
  if (rebuilt === null) return { verdict: 'tampered', problems }
  const encoded = encodeOn(encoder, rebuilt, fact.providerId)
  if (typeof encoded === 'string') {
    return { verdict: 'tampered', problems: [`the rebuilt request does not encode: ${encoded}`] }
  }
  if (encoded.promptHash !== fact.promptHash) problems.push('the promptHash does not recompute')
  if (encoded.toolDefinitionsHash !== fact.toolDefinitionsHash) {
    problems.push('the toolDefinitionsHash does not recompute')
  }
  if (encoded.modelId !== fact.modelId) {
    problems.push(`the stored model is ${encoded.modelId}, the record names ${fact.modelId}`)
  }
  if (problems.length > 0) return { verdict: 'tampered', problems }

  // 「复核先比 modelWireHash」: the record stands; whether the table still agrees is a separate answer.
  const current = q.currentModel(fact.providerId, fact.modelId)
  const currentModelWireHash = current === null ? null : modelWireHash(current)
  return currentModelWireHash === fact.modelWireHash
    ? { verdict: 'verified', request: rebuilt }
    : { verdict: 'model-table-changed', request: rebuilt, currentModelWireHash }
}

/**
 * The request as the Tape describes it, or null with the reasons in `problems`. Each original is found
 * by the key its hash files it under, and hashed again: a copy that no longer hashes to its name is
 * not the original.
 */
async function rebuildRequest(
  store: TapeReader,
  q: AttemptRecheckQuery,
  fact: TapeAttemptCompletedPayload,
  problems: string[],
): Promise<ProviderRequest | null> {
  const runId = q.attempt.sourceId
  const requestSeq = q.attempt.sourceSeq
  if (
    runId === null ||
    requestSeq === null ||
    fact.assemblyRef !== assembledKey(runId, requestSeq)
  ) {
    problems.push(
      `the attempt names the manifest ${String(fact.assemblyRef)}, not its own request's`,
    )
    return null
  }
  const facts = await viewFacts(store, q.sessionId, q.attempt.entryId)
  const assembled = facts.get(fact.assemblyRef)
  if (assembled?.name !== 'view/assembled') {
    problems.push(`no view/assembled ${fact.assemblyRef} before the attempt`)
    return null
  }
  const manifest = assembled.payload as unknown as ViewAssembledPayload

  // The model: the full original, and the wire fields the attempt says it encoded (01 修补 7).
  const model = contentOf(facts, 'model_info', manifest.modelInfoHash)?.model
  if (model === undefined) {
    problems.push(`no view/content(model_info) ${manifest.modelInfoHash}`)
    return null
  }
  if (canonicalHash(model, 'the stored model') !== manifest.modelInfoHash) {
    problems.push('the stored ModelInfo does not hash to view/assembled.modelInfoHash')
  }
  if (modelWireHash(model) !== fact.modelWireHash) {
    problems.push("the stored ModelInfo's wire fields do not hash to attempt.modelWireHash")
  }

  // The system text: none, or the original the manifest names (A13).
  let system: string | undefined
  if (fact.request.systemHash !== manifest.systemHash) {
    problems.push('the request snapshot and the manifest name different system prompts')
  } else if (manifest.systemHash !== NO_SYSTEM_PROMPT_HASH) {
    system = contentOf(facts, 'system', manifest.systemHash)?.text
    if (system === undefined) problems.push(`no view/content(system) ${manifest.systemHash}`)
    else if (systemHash(system) !== manifest.systemHash) {
      problems.push('the stored system text does not hash to its name')
    }
  }

  // The tools: the frozen table's originals in its order when they were sent, else none (E2).
  const tools: ToolSpec[] = []
  if (manifest.tools?.sent === true) {
    const table = facts.get(manifest.tools.tableKey)
    if (table?.name !== 'view/tool_table') {
      problems.push(`no view/tool_table ${manifest.tools.tableKey}`)
    } else {
      for (const item of table.payload['tools'] as Array<{ specHash: string }>) {
        const spec = contentOf(facts, 'tool_spec', item.specHash)?.spec
        if (spec === undefined) problems.push(`no view/content(tool_spec) ${item.specHash}`)
        else if (canonicalHash(spec, 'a stored tool spec') !== item.specHash) {
          problems.push(`the stored tool spec ${item.specHash} does not hash to its name`)
        } else tools.push(spec)
      }
    }
  }
  if (problems.length > 0) return null

  const snapshot = fact.request
  let messages: ProviderRequest['messages']
  try {
    if (fact.compaction === undefined) {
      messages = await rebuildProviderContext(store, {
        sessionId: q.sessionId,
        atEntryId: fact.contextAtEntryId,
        target: model,
      })
    } else {
      const replay = await replayContext(store, {
        sessionId: q.sessionId,
        atEntryId: fact.contextAtEntryId,
        target: model,
        beforeOrderSeq: fact.compaction.keepFromEntryId,
      })
      messages = [
        ...replay.messages,
        { role: 'user', content: [{ type: 'text', text: fact.compaction.requestText }] },
      ]
    }
  } catch (error) {
    // A fact that no longer folds (TapeProjectionError) is a Tape that does not reproduce the record.
    problems.push(
      `the context up to ${String(fact.contextAtEntryId)} does not fold: ${String(error)}`,
    )
    return null
  }
  return {
    model,
    ...(system === undefined ? {} : { system }),
    messages,
    ...(tools.length === 0 ? {} : { tools }),
    maxTokens: snapshot.maxTokens,
    ...(snapshot.temperature === undefined ? {} : { temperature: snapshot.temperature }),
    ...(snapshot.thinking === undefined ? {} : { thinking: snapshot.thinking }),
    ...(snapshot.effort === undefined ? {} : { effort: snapshot.effort }),
    ...(snapshot.display === undefined ? {} : { display: snapshot.display }),
    ...(snapshot.dropThinkingBefore === undefined
      ? {}
      : { dropThinkingBefore: snapshot.dropThinkingBefore }),
  }
}

/** This build's encoder for the wire, or the reason it refused the request. */
function encodeOn(
  encoder: EncoderInfo,
  request: ProviderRequest,
  providerId: ProviderId,
): EncodedRequest | string {
  try {
    return encoder.wire === 'anthropic-messages'
      ? encodeAnthropicMessages(request, providerId)
      : encodeOpenAIChat(request, providerId)
  } catch (error) {
    return String(error)
  }
}

type ContentOf<T extends ViewContentPayload['type']> = Extract<ViewContentPayload, { type: T }>

/** The `view/content` of this type filed under this hash, when its payload says so too. */
function contentOf<T extends ViewContentPayload['type']>(
  facts: ReadonlyMap<string, TapeEntry>,
  type: T,
  hash: string,
): ContentOf<T> | undefined {
  const entry = facts.get(viewContentKey(type, hash))
  if (entry?.name !== 'view/content') return undefined
  const payload = entry.payload as unknown as ViewContentPayload
  return payload.type === type && payload.hash === hash ? (payload as ContentOf<T>) : undefined
}

/** The session's `event` facts up to the attempt, by provenance key: every `view/*` is one. */
async function viewFacts(
  store: TapeReader,
  sessionId: string,
  atEntryId: number,
): Promise<Map<string, TapeEntry>> {
  const facts = new Map<string, TapeEntry>()
  let fromEntryId: number | undefined
  let incarnationId: string | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
    const page = await store.readRange({
      sessionId,
      atEntryId,
      kinds: ['event'],
      limit: MAX_READ_LIMIT,
      ...(fromEntryId === undefined ? {} : { fromEntryId }),
      ...(incarnationId === undefined ? {} : { incarnationId }),
    })
    for (const entry of page.entries) facts.set(entry.provenanceKey, entry)
    incarnationId = page.incarnationId
    if (page.nextFromEntryId === null) return facts
    fromEntryId = page.nextFromEntryId
  }
}
