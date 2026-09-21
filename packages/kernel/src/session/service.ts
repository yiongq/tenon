/**
 * The kernel session service (spec 01 §所有权与依赖方向, §entry 模型, §投影与重放, §中止、重试、错误).
 *
 * It creates, resets and deletes sessions, reads the two projections back for a renderer, and runs
 * ONE provider request. **Facts only**: no agent loop, no retry, no tool dispatch. Phase 2 owns
 * those, and this service is deliberately the smallest surface both the desktop chat path (step 13)
 * and that loop can stand on.
 *
 * Four ownership rules it exists to keep:
 *
 *   - **`tape` is a `TapeStore` INSTANCE**, wrapped in the kernel facade in here. This service is the
 *     only thing that writes through that facade; the rule it keeps — 「`apps/*` 的代码不直接调
 *     `TapeStore.append`，只经 kernel 的门面」 (§保留命名空间) — is a rule about app code, not something
 *     the type system closes: the desktop main process constructs the SQLite store and therefore holds
 *     `append`. What a caller owes is to hand the store straight into `createSessionService` and keep
 *     no reference to it. Routing an incognito session to a memory store is then a different instance
 *     rather than a change in the kernel (§删除语义).
 *   - **`ids` is the only randomness.** `sessionId`, `incarnationId`, `messageId` and `runId` are
 *     canonical UUIDs from it; the kernel draws none of its own, which is what makes the conformance
 *     suite and every fixture reproducible. It is deliberately not a `HostAdapter` member.
 *   - **every `createdAt` is a host clock reading**, taken per fact. The tape has no clock of its own.
 *   - **the request is encoded ONCE** and the encoded request is what is streamed: what is hashed is
 *     what is sent, so `provider/attempt_completed.promptHash` describes the bytes that went out.
 *
 * What a crash cannot break. `message/user` and `session/model_selected` land in one transaction
 * BEFORE the request, and `message/assistant` (when there is one) with `provider/attempt_completed` in
 * one transaction after it. Die in between — power cut, a killed process — and a later reader sees a
 * user message with no attempt fact under that `runId`. That is what phase 1 wants it to see: the
 * user's turn is not lost, the transcript still replays (a trailing user message is a legal context),
 * and resending the same text is recognised as a retry of that same message rather than a second turn.
 * The alternative — writing the user message at the terminal event — would lose the turn on every
 * crash and make the retry rule unimplementable. Phase 2 turns "a run with no terminal fact" into a
 * recovery classification (R1's Execution Journal); until then it is a fact with no successor.
 */
import type { HostAdapter } from '../host/adapter.js'
import { isCanonicalUuid } from '../ids.js'
import type { IdSource } from '../ids.js'
import { createBlockAccumulator } from '../provider/base.js'
import { thinkingModelId } from '../provider/thinking.js'
import type {
  ContentBlock,
  ModelInfo,
  Provider,
  ProviderRequest,
  RequestIdentity,
  StreamEvent,
  ToolSpec,
  Usage,
} from '../provider/types.js'
import { assertModelBelongs, requestSnapshot } from '../provider/wire/shared.js'
import { canonicalJson } from '../tape/canonical-json.js'
import type {
  ForkOrigin,
  MessageStatus,
  ModelSelectedPayload,
  NewEntry,
  SessionStartPayload,
} from '../tape/entry.js'
import type {
  TapeAssistantMessagePayload,
  TapeAttemptCompletedPayload,
  TapeAttemptError,
  TapeAttemptStop,
  TapeUserMessagePayload,
} from '../tape/projection.js'
import { parseMessagePayload } from '../tape/projection.js'
import {
  attemptCompletedKey,
  messageRevisionKey,
  modelSelectedKey,
  sessionStartKey,
} from '../tape/provenance.js'
import { rebuildProviderContext } from '../tape/replay.js'
import type { MessageRow, TapeStore } from '../tape/store.js'
import { TapeSessionNotFoundError } from '../tape/store.js'
import { createTape } from '../tape/tape.js'
import type { TapeFact } from '../tape/tape.js'

/**
 * Phase 1 sends one payload once, so both ordinals are fixed — and both are RECORDED on every request
 * all the same (§中止、重试、错误): the day the phase 2 loop resends, the rows written before it existed
 * already say which transmission they were.
 */
const FIRST_REQUEST_SEQ = 1
const FIRST_PHYSICAL_ATTEMPT = 1

/** A new message starts at revision 0; only an edit-and-resend (phase 6) increments it. */
const FIRST_REVISION = 0

/**
 * A user message is never partial: it is written whole, before the run. `aborted` / `error` describe an
 * assistant turn that was cut short, and neither can happen to a message the user already sent.
 */
const USER_MESSAGE_STATUS: MessageStatus = 'complete'

/**
 * How far down the newest-first session list `latestSession` looks for one with messages. A page, not
 * a scan: a user with more than this many freshly opened empty sessions ahead of their last
 * conversation gets the newest of them, which is no worse than the answer before the skip existed.
 */
const LATEST_SESSION_SCAN = 20

export interface SessionServiceOptions {
  /**
   * The host. Only a clock READING is taken from it — every fact's `createdAt` — so that is all the
   * type asks for: a caller passing the whole `HostAdapter` (the spec's
   * `createSessionService({ host, tape, ids })`) satisfies it, a test needs no eight-member double,
   * and widening this later breaks no call site. `Pick<…, 'now'>` rather than the whole clock for the
   * reason step 10 gave the provider the same slice: a timer in here would mean the service could
   * retry or poll, and retrying is the phase 2 loop's job.
   */
  readonly host: { readonly clock: Pick<HostAdapter['clock'], 'now'> }
  /**
   * The store this service writes through. An INSTANCE, not a `HostAdapter` member: one process holds
   * several (SQLite for normal sessions, memory for incognito ones), and which one a session gets is
   * settled before this call.
   */
  readonly tape: TapeStore
  readonly ids: IdSource
}

/** A session's identity after it was created or reset, plus the `session/start` that opened it. */
export interface SessionIncarnation {
  readonly sessionId: string
  readonly incarnationId: string
  /** `entryId` of the `session/start` anchor — the first fact of this incarnation. */
  readonly startEntryId: number
}

/** What a renderer opens on: the newest session and the tail of its messages. */
export interface LatestSession {
  readonly sessionId: string
  readonly messages: readonly MessageRow[]
}

/** The user's turn as a caller states it. Text is the common case; blocks are the general one. */
export type UserTurn = { readonly text: string } | { readonly content: readonly ContentBlock[] }

export interface RunRequestQuery {
  readonly sessionId: string
  readonly user: UserTurn
  /** A CONSTRUCTED provider (`ProviderDefinition.create()`): host capabilities entered there. */
  readonly provider: Provider
  readonly model: ModelInfo
  readonly system?: string
  /**
   * The definitions this request offers. Phase 1 has no tool dispatch and writes no `tool/*` facts
   * (§非目标), so a turn that STOPS on `tool-use` persists the model's `tool-request` block for the
   * transcript and nothing answers it — and replay, which reads message content, would hand that
   * unanswered block back on the next request, where both wires reject it. Phase 1's own chat path
   * sends no tools, so this is a boundary a caller has to know rather than a reachable bug; who
   * resolves it — the service refusing `tools`, or replay assembling the provider context from the
   * tool facts that §entry 模型 makes authoritative for it — is phase 2's to settle, and it is
   * recorded in plan.md's Open list.
   */
  readonly tools?: readonly ToolSpec[]
  readonly maxTokens?: number
  readonly temperature?: number
  readonly thinking?: { readonly enabled: boolean; readonly budgetTokens?: number }
  /** Aborting is the caller's; the provider turns it into `stop{ aborted }` (invariant 2). */
  readonly signal?: AbortSignal
  /**
   * Every `StreamEvent` as it arrives, terminal included. The NON-terminal ones are what a caller
   * renders as they come. The terminal `chat.event` must be derived from the resolved `RunResult`
   * (which carries the same `stop` / `error`) and not from the `stop` / `error` seen here: the facts
   * are committed only when this call resolves, so a renderer told "done" from inside the stream can
   * send again while `message/assistant` is still unwritten — and phase 0's rule that the session is
   * released BEFORE the terminal event goes out would then race its own transcript.
   *
   * It must not throw: a throw propagates and the run rejects with no attempt fact written, which is
   * the crash shape described at the top of this file rather than a recoverable one.
   */
  readonly onEvent?: (event: StreamEvent) => void
}

/**
 * One request's outcome, in the shape a caller maps to its own terminal event: `error` non-null means
 * the turn failed, otherwise `stop` says how it ended. Exactly one of the two is non-null, the same way
 * the fact records it.
 */
export interface RunResult {
  readonly identity: RequestIdentity
  readonly userMessageId: string
  /** false = the append was the idempotent no-op of a retry (§entry 模型 「重试与失败的表示」). */
  readonly userMessageCreated: boolean
  /** The tape prefix this request was assembled from, as recorded on the attempt fact. */
  readonly contextAtEntryId: number
  /** null when no assistant message was written: an error, or nothing arrived. */
  readonly assistantMessageId: string | null
  /** The status that was persisted, or null when no assistant message was written. */
  readonly status: MessageStatus | null
  /** What arrived, whether or not it was persisted. */
  readonly content: readonly ContentBlock[]
  readonly usage: Usage | null
  readonly stop: TapeAttemptStop | null
  readonly error: TapeAttemptError | null
  /** `entryId` of the run's one `provider/attempt_completed` fact. */
  readonly attemptEntryId: number
}

export interface ListMessagesQuery {
  readonly sessionId: string
  readonly limit: number
  readonly afterOrderSeq?: number
  readonly beforeOrderSeq?: number
}

/** What `createSession` takes: an id the caller already owns, a lineage pointer, or neither. */
export interface CreateSessionQuery {
  /**
   * The session id, when the CALLER already minted one — the desktop renderer mints its own and
   * filters every `chat.event` on it, so main would otherwise have to keep a renderer-id → tape-id
   * map, which is the in-process state phase 1 exists to delete. Omitted ⇒ minted from `ids`. It must
   * be a canonical UUID either way: the spec fixes that shape for every id on the tape, and a store
   * that accepts any non-empty string would take a typo as a new session.
   */
  readonly sessionId?: string
  readonly forkedFrom?: ForkOrigin
}

export interface SessionService {
  /** Mints what the caller did not supply and writes `session/start` as the FIRST fact of it. */
  createSession(q?: CreateSessionQuery): Promise<SessionIncarnation>
  /**
   * Clears a session: a new incarnation, and the kernel-built `session/start` handed to the store
   * (§删除语义). The facts of the previous incarnation are physically gone.
   */
  resetSession(sessionId: string): Promise<SessionIncarnation>
  /** Physical delete: facts, head, projections, cursors. */
  deleteSession(sessionId: string): Promise<void>
  /**
   * What a renderer opens on after a restart: the newest session that HAS messages and the last
   * `limit` of them, or null when the store holds none at all.
   */
  latestSession(q: { readonly limit: number }): Promise<LatestSession | null>
  /** One page of a session's messages. No cursor = the tail, which is where a reader opens. */
  listMessages(q: ListMessagesQuery): Promise<MessageRow[]>
  /** One request: write the user's turn, stream the answer, record what happened. */
  runRequest(q: RunRequestQuery): Promise<RunResult>
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  const tape = createTape(options.tape)
  const ids = options.ids
  const now = (): number => options.host.clock.now()
  const sessionSlice = tape.writer('session')
  const messageSlice = tape.writer('message')
  const providerSlice = tape.writer('provider')

  function startFact(
    sessionId: string,
    incarnationId: string,
    forkedFrom: ForkOrigin | undefined,
  ): TapeFact {
    // The lineage pointer is rebuilt field by field rather than spread: the payload is hashed and
    // sealed, so it carries the four fields lineage is checkable from and nothing else a caller
    // happened to hang off its object.
    const payload: SessionStartPayload =
      forkedFrom === undefined
        ? { incarnationId }
        : {
            incarnationId,
            forkedFrom: {
              sessionId: forkedFrom.sessionId,
              incarnationId: forkedFrom.incarnationId,
              entryId: forkedFrom.entryId,
              entryHash: forkedFrom.entryHash,
            },
          }
    return {
      name: 'session/start',
      fields: {
        sourceType: 'session',
        sourceId: sessionId,
        sourceSeq: 0,
        provenanceKey: sessionStartKey(incarnationId),
        payload,
        createdAt: now(),
      },
    }
  }

  /**
   * The retry rule's subject (§entry 模型 「重试与失败的表示」): the folded transcript's LAST message,
   * when it is a user turn carrying exactly this content — which means the previous send of it got no
   * answer, so this is a resend of that message rather than a second turn.
   *
   * It asks `message_projection`, in two bounded reads, rather than re-folding the session: the
   * projection IS the fold (invariant 12 — a rebuild equals the incremental write, and a retracted
   * message has no row), and re-folding would page the whole tape on every send, synchronously on the
   * desktop's main thread, growing without bound. The revision is not a projection column, so it
   * comes from the one fact the row points at — and comparing THAT fact's content is what the
   * idempotent append compares too, so the two can never disagree about whether this is a resend.
   */
  async function resendOf(
    sessionId: string,
    content: readonly ContentBlock[],
  ): Promise<{ messageId: string; revision: number } | null> {
    const [last] = await tape.listMessages({ sessionId, limit: 1 })
    if (last === undefined || last.role !== 'user') return null
    const page = await tape.readRange({
      sessionId,
      fromEntryId: last.entryId,
      atEntryId: last.entryId,
      limit: 1,
    })
    const entry = page.entries[0]
    if (entry === undefined || entry.name !== 'message/user') return null
    const payload = parseMessagePayload(entry)
    if (payload.messageId !== last.messageId) return null
    // Canonical JSON, because the spec says 「同文本」 and on this path the text IS the one text
    // block: the same comparison, generalised to the blocks a turn can carry.
    if (canonicalJson(payload.content) !== canonicalJson(content)) return null
    return { messageId: payload.messageId, revision: payload.revision }
  }

  async function runRequest(q: RunRequestQuery): Promise<RunResult> {
    const content = userContent(q.user)
    // A model that belongs to another provider is a programmer error, and it is checked HERE rather
    // than where `encode()` would raise it: past this point the user's turn and `session/model_selected`
    // are on the tape, and a fact recording a provider / model pair that can never be encoded would
    // advertise itself through `session_projection` for a run that never happened.
    assertModelBelongs(q.model, q.provider.id)
    // The head next, for the incarnation every batch carries. A session that does not exist stays a
    // programmer error: conjuring a head row here would let a typo create a session.
    const head = await tape.head(q.sessionId)
    if (head === null) {
      throw new TapeSessionNotFoundError(
        `session "${q.sessionId}" has no head row; create the session before running a request`,
      )
    }
    const incarnationId = head.incarnationId
    const identity: RequestIdentity = {
      runId: ids.uuid(),
      requestSeq: FIRST_REQUEST_SEQ,
      physicalAttempt: FIRST_PHYSICAL_ATTEMPT,
    }

    // (b) The user's turn, BEFORE the run. A resend reuses the id and revision of the message it is a
    // resend of, so its append is an idempotent no-op; anything else is a new message at revision 0.
    // The payload carries NOTHING run-scoped — `runId` lives on the assistant message only — or a
    // resend would be "same key, different content", which is a `TapeProvenanceConflictError` nobody
    // may swallow.
    const resend = await resendOf(q.sessionId, content)
    const messageId = resend?.messageId ?? ids.uuid()
    const revision = resend?.revision ?? FIRST_REVISION
    const userPayload: TapeUserMessagePayload = {
      messageId,
      revision,
      role: 'user',
      content: [...content],
      status: USER_MESSAGE_STATUS,
    }
    // (c) Which provider and model THIS run used. Choosing one in the settings card writes
    // config.json and no fact; this is the fact.
    const modelPayload: ModelSelectedPayload = { providerId: q.provider.id, modelId: q.model.id }
    // One transaction across two slices: a run must not be able to start with the user's turn written
    // and no record of what it was sent to.
    const before = await tape.appendEntries({
      sessionId: q.sessionId,
      incarnationId,
      entries: [
        messageSlice.entry('message/user', {
          sourceType: 'message',
          sourceId: messageId,
          sourceSeq: revision,
          provenanceKey: messageRevisionKey(messageId, revision),
          payload: userPayload,
          createdAt: now(),
        }),
        sessionSlice.entry('session/model_selected', {
          sourceType: 'session',
          sourceId: q.sessionId,
          provenanceKey: modelSelectedKey(identity.runId),
          payload: modelPayload,
          createdAt: now(),
        }),
      ],
    })
    const userReceipt = before[0]
    if (userReceipt === undefined) throw new Error('the pre-run batch returned no receipt')

    // (d) A request's context is a PREFIX of the tape, pinned here and recorded on the fact, so the
    // request stays re-checkable: replay at this id plus the request snapshot re-encodes to the same
    // promptHash (acceptance 3). The bound is THIS run's own receipts, not a second `head()` read: a
    // batch is one transaction, so the largest id it returned is the tape as this run left it, while
    // the head is shared — a second run's writes landing in between would pin a prefix holding its
    // question, or a whole answer, and the audit would describe a request this run never made. The
    // MAXIMUM, because an idempotent user message returns its ORIGINAL (smaller) entry id, and
    // `session/model_selected` is keyed by `runId` and therefore always new.
    const contextAtEntryId = Math.max(...before.map((receipt) => receipt.entryId))
    // Read BACK from the tape rather than assembled from what this call already has in hand: the
    // recorded `contextAtEntryId` has to describe bytes a later reader can reproduce, and the tape is
    // the only thing they can read. The cost is one paged read per request, which plan.md 「Open」
    // weighs against the threshold for moving SQLite off the main thread.
    const messages = await rebuildProviderContext(tape, {
      sessionId: q.sessionId,
      atEntryId: contextAtEntryId,
      target: q.model,
    })
    const request: ProviderRequest = {
      model: q.model,
      messages,
      ...(q.system === undefined ? {} : { system: q.system }),
      ...(q.tools === undefined ? {} : { tools: [...q.tools] }),
      ...(q.maxTokens === undefined ? {} : { maxTokens: q.maxTokens }),
      ...(q.temperature === undefined ? {} : { temperature: q.temperature }),
      ...(q.thinking === undefined ? {} : { thinking: { ...q.thinking } }),
    }
    // ONCE — and the encoded request is what is streamed.
    const encoded = q.provider.encode(request)

    // (e) Forward every event as it arrives and fold the content ones. A thinking block is stamped
    // with the guard's model identity rather than the wire id, so a block folded here replays as
    // `same-model` instead of looking like a model change.
    const blocks = createBlockAccumulator({
      provider: q.provider.id,
      providerModel: thinkingModelId(q.model),
    })
    let usage: Usage | null = null
    let stop: TapeAttemptStop | null = null
    let error: TapeAttemptError | null = null
    const stream = q.provider.stream(encoded, {
      identity,
      ...(q.signal === undefined ? {} : { signal: q.signal }),
    })
    for await (const event of stream) {
      q.onEvent?.(event)
      switch (event.type) {
        case 'usage':
          // Only the final reading reaches a fact (invariant 1): a `message_start` reading describes
          // the prompt, not the attempt.
          if (event.usage.final) usage = { ...event.usage }
          break
        case 'stop':
          stop = { reason: event.reason, providerReason: event.providerReason }
          break
        case 'error':
          error = attemptError(event)
          break
        default:
          blocks.apply(event)
      }
    }
    // Exactly one of the two, whatever the provider did. An error wins over a stop that also arrived,
    // and a stream that ended with neither is reported as the truncated body it is: claiming a turn
    // nobody finished was complete is the one direction that cannot be corrected later. Invariant 1
    // makes both branches unreachable for a kernel adapter — `provider` is an argument here, and no
    // implementation may leave a run without its one attempt fact.
    if (error !== null) stop = null
    else if (stop === null) error = streamEndedEarly()

    // (f) The terminal facts, in ONE transaction.
    const arrived = blocks.content()
    const aborted = stop !== null && stop.reason === 'aborted'
    // An assistant message is written only when the turn has something to show:
    //   - an error writes none at all — the evidence of a failed turn is this fact's `error`, and the
    //     user's message stays in the transcript so resending it is a retry (§entry 模型);
    //   - an abort writes one only when partial content arrived, with status 'aborted';
    //   - EMPTY content is never written: replay must never produce an empty assistant turn, and both
    //     wires answer 400 to one.
    // Every other stop reason (max-tokens, refusal, content-filter, pause-turn, context-overflow,
    // unknown) persists what arrived as 'complete'. The reasoning: the vocabulary is
    // `MessageStatus = 'complete' | 'aborted' | 'error'`, phase 1 writes only the first two, 'aborted'
    // means the USER stopped it, and text truncated by max_tokens is the assistant's turn as far as the
    // transcript goes — dropping it would lose content the user watched arrive, and calling it
    // 'aborted' would tell the interface someone pressed Stop. Nothing is lost by the choice: the raw
    // `StopReason` sits on the attempt fact beside it, which is where a reader that cares looks.
    const persist = error === null && arrived.length > 0
    const status: MessageStatus | null = persist ? (aborted ? 'aborted' : 'complete') : null
    const assistantMessageId = persist ? ids.uuid() : null
    const attempt: TapeAttemptCompletedPayload = {
      providerId: encoded.providerId,
      modelId: encoded.modelId,
      contextAtEntryId,
      // The snapshot's single owner is the wire layer (step 9): a second recipe here could disagree
      // with the encoder about `maxTokens` or about what counts as "no system prompt", and then the
      // promptHash this fact records would be unverifiable — the one thing the snapshot exists for.
      request: requestSnapshot(request),
      promptHash: encoded.promptHash,
      toolDefinitionsHash: encoded.toolDefinitionsHash,
      thinkingDecisions: [...encoded.thinkingDecisions],
      usage,
      stop,
      error,
    }
    const terminal: NewEntry[] = []
    if (assistantMessageId !== null && status !== null) {
      const assistantPayload: TapeAssistantMessagePayload = {
        messageId: assistantMessageId,
        revision: FIRST_REVISION,
        role: 'assistant',
        content: arrived,
        status,
        runId: identity.runId,
      }
      terminal.push(
        messageSlice.entry('message/assistant', {
          sourceType: 'message',
          sourceId: assistantMessageId,
          sourceSeq: FIRST_REVISION,
          provenanceKey: messageRevisionKey(assistantMessageId, FIRST_REVISION),
          payload: assistantPayload,
          createdAt: now(),
        }),
      )
    }
    terminal.push(
      providerSlice.entry('provider/attempt_completed', {
        sourceType: 'runtime_event',
        sourceId: identity.runId,
        sourceSeq: identity.requestSeq,
        provenanceKey: attemptCompletedKey(
          identity.runId,
          identity.requestSeq,
          identity.physicalAttempt,
        ),
        payload: attempt,
        createdAt: now(),
      }),
    )
    const receipts = await tape.appendEntries({
      sessionId: q.sessionId,
      incarnationId,
      entries: terminal,
    })
    // The attempt fact is the last entry of the batch, so its receipt is the last one.
    const attemptReceipt = receipts.at(-1)
    if (attemptReceipt === undefined) throw new Error('the terminal batch returned no receipt')
    return {
      identity,
      userMessageId: messageId,
      userMessageCreated: userReceipt.created,
      contextAtEntryId,
      assistantMessageId,
      status,
      content: arrived,
      usage,
      stop,
      error,
      attemptEntryId: attemptReceipt.entryId,
    }
  }

  return {
    async createSession(q = {}): Promise<SessionIncarnation> {
      const sessionId = q.sessionId ?? ids.uuid()
      if (!isCanonicalUuid(sessionId)) {
        throw new TypeError(`createSession: "${sessionId}" is not a canonical UUID`)
      }
      const incarnationId = ids.uuid()
      const result = await sessionSlice.write({
        sessionId,
        incarnationId,
        fact: startFact(sessionId, incarnationId, q.forkedFrom),
      })
      return { sessionId, incarnationId, startEntryId: result.entryId }
    },

    async resetSession(sessionId: string): Promise<SessionIncarnation> {
      // A NEW incarnation: reusing the current one would make the two generations
      // hash-indistinguishable. The store refuses that, and refuses a session it has no head row for.
      const incarnationId = ids.uuid()
      const fact = startFact(sessionId, incarnationId, undefined)
      const result = await tape.resetSession({
        sessionId,
        incarnationId,
        start: sessionSlice.entry(fact.name, fact.fields),
      })
      return { sessionId, incarnationId, startEntryId: result.entryId }
    },

    deleteSession(sessionId: string): Promise<void> {
      return tape.deleteSession(sessionId)
    },

    async latestSession(q): Promise<LatestSession | null> {
      // `listSessions` is newest first — but it ranks by `updated_at`, which `session/start` bumps
      // too, so an empty session that was opened and never used would shadow the conversation the
      // user actually wants back (acceptance 5). `lastMessageAt` is written only by `message/*`, so
      // the first row that has one is the newest session with anything to restore; when none has,
      // the newest overall is the honest answer. One bounded page, not a scan.
      const newest = await tape.listSessions({ limit: LATEST_SESSION_SCAN })
      const restorable = newest.find((row) => row.lastMessageAt !== null) ?? newest[0]
      if (restorable === undefined) return null
      const messages = await tape.listMessages({ sessionId: restorable.sessionId, limit: q.limit })
      return { sessionId: restorable.sessionId, messages }
    },

    listMessages(q): Promise<MessageRow[]> {
      return tape.listMessages(q)
    },

    runRequest,
  }
}

/** The blocks of a turn. An empty one is refused: no message on the tape may have no content. */
function userContent(user: UserTurn): readonly ContentBlock[] {
  if ('text' in user) {
    if (user.text === '') {
      throw new TypeError('runRequest: a user turn needs text; an empty message is never written')
    }
    return [{ type: 'text', text: user.text }]
  }
  if (user.content.length === 0) {
    throw new TypeError('runRequest: a user turn needs content; an empty message is never written')
  }
  return user.content
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

/**
 * What is recorded when a stream ends with no terminal event of its own — the same retryable `network`
 * failure `withTerminalEvent` reports for a truncated body, because that is what it is.
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
