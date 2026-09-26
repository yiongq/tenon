/**
 * A Run (spec 02 §Run 的生命周期与每轮顺序): the request half, outside the mailbox.
 *
 * Plan step 9's Run is the smallest the loop can stand on: ONE request, with no system prompt and no
 * tools (the assembled system arrives in plan step 18, the frozen tool table in step 10), recorded
 * the way phase 1's turn was — a turn that stops on `tool-use` ends there. What the Run WRITES is
 * built here and committed by the mailbox (`loop/mailbox.ts`), because a Run's facts are written as
 * mailbox tasks; plan step 13 replaces this body with the per-round loop (several requests, retries,
 * limits, `run_terminal`) without changing how a Run is opened and closed.
 *
 * What survives from the phase 1 service, and why it still holds:
 *
 *   - **the request is encoded ONCE** and the encoded request is what is streamed: what is hashed is
 *     what is sent, so `provider/attempt_completed.promptHash` describes the bytes that went out;
 *   - **the context is a PREFIX of the tape**, read back from the tape at the pin the attempt fact
 *     records (`contextAtEntryId`), so the request stays re-checkable (01 acceptance 3);
 *   - **exactly one of `stop` / `error`** reaches the fact, whatever the provider did;
 *   - **an assistant message only when the turn has something to show**: none for an error, one with
 *     status `aborted` for a stopped turn that had partial content, never an empty one.
 */
import type { IdSource } from '../ids.js'
import { createBlockAccumulator } from '../provider/base.js'
import { thinkingModelId } from '../provider/thinking.js'
import type {
  ContentBlock,
  EncodedRequest,
  ModelInfo,
  Provider,
  ProviderId,
  ProviderRequest,
  RequestIdentity,
  StreamEvent,
  Usage,
} from '../provider/types.js'
import { encoderOf, modelWireHash, requestSnapshot } from '../provider/wire/shared.js'
import type { MessageStatus, NewEntry } from '../tape/entry.js'
import type {
  TapeAssistantMessagePayload,
  TapeAttemptCompletedPayload,
  TapeAttemptError,
  TapeAttemptStop,
} from '../tape/projection.js'
import { attemptCompletedKey, messageRevisionKey } from '../tape/provenance.js'
import { rebuildProviderContext } from '../tape/replay.js'
import type { Tape } from '../tape/tape.js'
import type { RunAbortCause, RunLease } from './ports.js'
import type { RunEndReason } from './terminal.js'

/**
 * Plan step 9 sends one payload once, so both ordinals are fixed — and both are RECORDED all the
 * same, so the rows written before the per-round loop existed already say which transmission they
 * were. Plan step 13 numbers them.
 */
export const FIRST_REQUEST_SEQ = 1
const FIRST_PHYSICAL_ATTEMPT = 1

/** A new message starts at revision 0; only an edit-and-resend (phase 6) increments it. */
export const FIRST_REVISION = 0

export interface RequestQuery {
  readonly tape: Tape
  readonly ids: IdSource
  readonly now: () => number
  readonly sessionId: string
  readonly runId: string
  /** The top of this Run's own pre-run batch: the prefix the request is assembled from. */
  readonly contextAtEntryId: number
  readonly provider: Provider
  readonly model: ModelInfo
  readonly maxTokens: number
  /** The session's thinking effort; null = the model's default, and nothing is sent. */
  readonly effort: string | null
  readonly signal: AbortSignal
  /** Every content delta as it arrives. It must not throw. */
  readonly onDelta: (event: Extract<StreamEvent, { type: 'text-delta' | 'thinking-delta' }>) => void
}

/** What one request left behind: the facts to commit, and how it ended. */
export interface RequestOutcome {
  /** `message/assistant` when there is one, then `provider/attempt_completed`, in that order. */
  readonly terminal: readonly NewEntry[]
  readonly stop: TapeAttemptStop | null
  readonly error: TapeAttemptError | null
  /** The error event's `resetAt` (01 修补 2): the end reason reads it, the fact does not carry it. */
  readonly resetAt: number | null
  readonly providerId: ProviderId
  readonly modelId: string
}

export async function streamRequest(q: RequestQuery): Promise<RequestOutcome> {
  const identity: RequestIdentity = {
    runId: q.runId,
    requestSeq: FIRST_REQUEST_SEQ,
    physicalAttempt: FIRST_PHYSICAL_ATTEMPT,
  }
  // Read BACK from the tape rather than assembled from what the caller has in hand: the recorded
  // `contextAtEntryId` has to describe bytes a later reader can reproduce, and the tape is the only
  // thing they can read.
  const messages = await rebuildProviderContext(q.tape, {
    sessionId: q.sessionId,
    atEntryId: q.contextAtEntryId,
    target: q.model,
  })
  const request: ProviderRequest = {
    model: q.model,
    messages,
    maxTokens: q.maxTokens,
    ...(q.effort === null ? {} : { effort: q.effort }),
  }
  // ONCE — and the encoded request is what is streamed.
  const encoded = q.provider.encode(request)

  // A thinking block is stamped with the guard's model identity rather than the wire id, so a block
  // folded here replays as `same-model` instead of looking like a model change.
  const blocks = createBlockAccumulator({
    provider: q.provider.id,
    providerModel: thinkingModelId(q.model),
  })
  let usage: Usage | null = null
  let stop: TapeAttemptStop | null = null
  let error: TapeAttemptError | null = null
  let resetAt: number | null = null
  /** The model the vendor said answered (spec 02, M5): the first report, if any. */
  let responseModelId: string | null = null
  for await (const event of q.provider.stream(encoded, { identity, signal: q.signal })) {
    switch (event.type) {
      case 'usage':
        // Only the final reading reaches a fact (01 invariant 1): a `message_start` reading
        // describes the prompt, not the attempt.
        if (event.usage.final) usage = { ...event.usage }
        break
      case 'stop':
        stop = { reason: event.reason, providerReason: event.providerReason }
        break
      case 'error':
        error = attemptError(event)
        resetAt = event.resetAt ?? null
        break
      case 'response-model':
        responseModelId ??= event.modelId
        break
      case 'text-delta':
      case 'thinking-delta':
        q.onDelta(event)
        blocks.apply(event)
        break
      default:
        blocks.apply(event)
    }
  }
  // Exactly one of the two, whatever the provider did. An error wins over a stop that also arrived,
  // and a stream that ended with neither is reported as the truncated body it is: claiming a turn
  // nobody finished was complete is the one direction that cannot be corrected later.
  if (error !== null) stop = null
  else if (stop === null) error = streamEndedEarly()

  const arrived = blocks.content()
  const aborted = stop !== null && stop.reason === 'aborted'
  // An assistant message only when the turn has something to show: an error writes none (the
  // evidence is the attempt fact's `error`, and the user's message stays so resending it is a
  // retry); an abort writes one only when partial content arrived; EMPTY content is never written,
  // because replay must never produce an empty assistant turn. Every other stop persists what
  // arrived as `complete` — the three that plan step 13 discards instead (refusal, context-overflow,
  // network_error) are 01 修补 9 (m), and they change with the loop that resends them.
  const persist = error === null && arrived.length > 0
  const status: MessageStatus | null = persist ? (aborted ? 'aborted' : 'complete') : null
  const terminal: NewEntry[] = []
  const messageSlice = q.tape.writer('message')
  if (persist && status !== null) {
    const assistantMessageId = q.ids.uuid()
    const payload: TapeAssistantMessagePayload = {
      messageId: assistantMessageId,
      revision: FIRST_REVISION,
      role: 'assistant',
      content: arrived,
      status,
      runId: q.runId,
    }
    terminal.push(
      messageSlice.entry('message/assistant', {
        sourceType: 'message',
        sourceId: assistantMessageId,
        sourceSeq: FIRST_REVISION,
        provenanceKey: messageRevisionKey(assistantMessageId, FIRST_REVISION),
        payload,
        createdAt: q.now(),
      }),
    )
  }
  const attempt: TapeAttemptCompletedPayload = {
    providerId: encoded.providerId,
    modelId: encoded.modelId,
    contextAtEntryId: q.contextAtEntryId,
    // The snapshot's single owner is the wire layer: a second recipe here could disagree with the
    // encoder about `maxTokens`, and then the recorded promptHash would be unverifiable.
    request: requestSnapshot(request),
    promptHash: encoded.promptHash,
    toolDefinitionsHash: encoded.toolDefinitionsHash,
    thinkingDecisions: [...encoded.thinkingDecisions],
    usage,
    stop,
    error,
    // 01 修补 7: which encoder built the body, the hash of the ModelInfo fields it read, and the
    // model the vendor named.
    ...encoderField(encoded),
    modelWireHash: modelWireHash(q.model),
    ...(responseModelId === null ? {} : { responseModelId }),
  }
  terminal.push(
    q.tape.writer('provider').entry('provider/attempt_completed', {
      sourceType: 'runtime_event',
      sourceId: q.runId,
      sourceSeq: identity.requestSeq,
      provenanceKey: attemptCompletedKey(q.runId, identity.requestSeq, identity.physicalAttempt),
      payload: attempt,
      createdAt: q.now(),
    }),
  )
  return {
    terminal,
    stop,
    error,
    resetAt: error === null ? null : resetAt,
    providerId: encoded.providerId,
    modelId: encoded.modelId,
  }
}

/**
 * The cause an abort carries (§进行中、暂停与 RunRegistry). `stopRequested` wins: a user-stop after
 * a quit or a window close still counts as the user's stop. A reason that is not a `RunAbortCause`
 * reads as a stop too — nothing but a stop aborts a lease without saying why.
 */
export function abortCauseOf(lease: RunLease): RunAbortCause {
  if (lease.stopRequested) return 'user-stop'
  const reason: unknown = lease.signal.reason
  return reason === 'quit' || reason === 'close-window' ? reason : 'user-stop'
}

/** How a Run ended by an abort reads in the end-reason vocabulary. */
export function abortedEndReason(cause: RunAbortCause): RunEndReason {
  return cause === 'user-stop'
    ? { code: 'user-stopped' }
    : { code: 'shutdown-aborted', trigger: cause }
}

/**
 * Why plan step 9's one-request Run ended, per the rows of §一轮回复怎么分流 that a single request
 * can reach. Plan step 13 moves this to the loop with the whole table (resends, compaction, the
 * zero-call `tool-use` turn) — a Run that stops on `tool-use` here simply ends, as phase 1's did.
 */
export function endReasonOf(
  outcome: RequestOutcome,
  lease: RunLease,
  maxTokens: number,
): RunEndReason {
  const { error, stop, providerId, modelId } = outcome
  if (error !== null) {
    if (error.code === 'quota-exhausted') {
      return { code: 'quota-exhausted', providerId, resetAt: outcome.resetAt }
    }
    if (error.code === 'account-config') return { code: 'account-config', providerId }
    return {
      code: 'provider-error',
      providerId,
      errorCode: error.code,
      providerReason: error.providerCode,
      attempts: 1,
    }
  }
  switch (stop?.reason) {
    case 'aborted':
      return abortedEndReason(abortCauseOf(lease))
    case 'max-tokens':
      return { code: 'output-truncated', maxTokens }
    case 'refusal':
      return { code: 'refusal', providerId, modelId }
    case 'content-filter':
      return { code: 'content-filter', providerId }
    case 'context-overflow':
      return { code: 'context-overflow', compactions: 0 }
    case 'pause-turn':
    case 'unknown':
      return {
        code: 'provider-error',
        providerId,
        errorCode: null,
        providerReason: stop.providerReason,
        attempts: 1,
      }
    default:
      return { code: 'completed' }
  }
}

/**
 * The `error` event as the fact records it. Rebuilt key by key because an undefined-valued key is
 * exactly what `canonicalJson` refuses — inside the append transaction, where a throw costs the batch.
 */
function attemptError(event: Extract<StreamEvent, { type: 'error' }>): TapeAttemptError {
  return {
    type: 'error',
    code: event.code,
    retryable: event.retryable,
    ...(event.retryAfterMs === undefined ? {} : { retryAfterMs: event.retryAfterMs }),
    ...(event.status === undefined ? {} : { status: event.status }),
    providerCode: event.providerCode,
    detail: event.detail,
  }
}

/** `encoder` for the attempt fact, or nothing: rebuilt key by key for the same reason as above. */
function encoderField(encoded: EncodedRequest): Pick<TapeAttemptCompletedPayload, 'encoder'> {
  const encoder = encoderOf(encoded)
  return encoder === null
    ? {}
    : { encoder: { wire: encoder.wire, version: encoder.version, sdk: encoder.sdk } }
}

/**
 * What is recorded when a stream ends with no terminal event of its own — the same retryable
 * `network` failure `withTerminalEvent` reports for a truncated body, because that is what it is.
 */
function streamEndedEarly(): TapeAttemptError {
  return {
    type: 'error',
    code: 'network',
    retryable: true,
    providerCode: null,
    detail: 'stream ended without a terminal event',
  }
}

/** The text a user turn is written as. */
export function userTextContent(text: string): readonly ContentBlock[] {
  return [{ type: 'text', text }]
}
