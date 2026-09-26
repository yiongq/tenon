/**
 * The mailbox: one serial point per root session (spec 02 §主进程与 kernel 的循环接口「mailbox」
 * 「租约」「何时判定」「新一轮先预建」「缺 key」「登记之后、append 之前被中止」「停止」).
 *
 * Every command of a root session — send, stop, answer, continue, resume, the model and profile
 * choices — is judged here, one at a time, in arrival order. A task only judges and writes briefly:
 * it never waits for a Run to end, never calls `assemble`, never reads a secret. A Run runs outside
 * the mailbox and comes back in to write its facts.
 *
 * Two rules carry the whole design, and both are checked by the executable models (models/):
 *
 *   - **one live lease per root, never handed over.** A command that may open a Run begins a lease
 *     at its entry, before its first await, only when the root has no live lease and nothing is
 *     queued or running in its mailbox; otherwise it queues without one and begins, if it still has
 *     to, when its turn comes. A lease that opened no Run is finished by the command that holds it.
 *   - **while a lease is held by a party that has not opened its Run yet, the mailbox runs only that
 *     party (and stops).** Everything else waits, in its original order, until that Run is open or the
 *     lease is finished — so commands are judged in arrival order even when the first one is still
 *     prebuilding outside.
 *
 * Plan step 9 builds the executor, the leases and the new-round path of `send`; the other commands
 * are declared and answer as if there were nothing for them to do (there is not, yet). Plan step 15
 * adds the waiting states and the rest of the timing rules, step 16 recovery and resume, step 17 the
 * queue's insertion and auto-send.
 */
import type { IdSource } from '../ids.js'
import { isCanonicalUuid } from '../ids.js'
import { ProviderConfigMissingError, ProviderInvalidArgumentError } from '../provider/errors.js'
import type { Provider, ProviderErrorCode, ProviderId } from '../provider/types.js'
import { assertModelBelongs } from '../provider/wire/shared.js'
import { canonicalJson } from '../tape/canonical-json.js'
import type {
  ModelSelectedPayload,
  NewEntry,
  RunStartedPayload,
  SessionStartPayload,
} from '../tape/entry.js'
import type { TapeUserMessagePayload } from '../tape/projection.js'
import { parseMessagePayload } from '../tape/projection.js'
import {
  messageRevisionKey,
  modelSelectedKey,
  runStartedKey,
  sessionStartKey,
} from '../tape/provenance.js'
import type { Tape } from '../tape/tape.js'
import type {
  AnswerResult,
  ContinueRunResult,
  RecoverResult,
  ResumeResult,
  SendQuery,
  SendResult,
} from '../session/service.js'
import type { SessionEvent } from './events.js'
import type {
  LoopPorts,
  ModelChoice,
  RunAssembly,
  RunConnector,
  RunLease,
  RunOrigin,
} from './ports.js'
import type { RequestOutcome } from './run.js'
import {
  FIRST_REVISION,
  abortCauseOf,
  abortedEndReason,
  endReasonOf,
  streamRequest,
  userTextContent,
} from './run.js'
import type { RunEndReason } from './terminal.js'
import type { AnswerCommand } from './waiting.js'

/**
 * `command`: a command's judgement (send, continue, answer, resume, the choices). `stop`: a stop that
 * found no live lease at its entry. `run`: a Run coming back in to write its facts.
 */
type TaskKind = 'command' | 'stop' | 'run'

interface Task {
  readonly kind: TaskKind
  /** The lease the command holds, when it began one at its entry or at an earlier turn. */
  readonly owner: RunLease | null
  readonly body: () => Promise<void>
}

/** A root session's serial point, and what the kernel keeps in memory about that root. */
interface RootBox {
  readonly rootSessionId: string
  readonly tasks: Task[]
  running: boolean
  /** The live lease: begun and not yet finished, aborted ones included. */
  lease: RunLease | null
  /** Whether the live lease has opened its Run (its `run_started` is committed). */
  runOpen: boolean
  /** The indirect switch to a public host waiting on the menu's confirmation (plan step 17). */
  held: { readonly host: string; readonly queuedId: string | null } | null
}

/** What a new round prepared before it took its turn: the model, the assembly, the provider. */
type Prebuild =
  | {
      readonly kind: 'ready'
      readonly choice: ModelChoice
      readonly assembly: RunAssembly
      readonly provider: Provider
    }
  | {
      readonly kind: 'config'
      readonly providerId: ProviderId
      readonly errorCode: ProviderErrorCode
      readonly detail: string
    }
  | { readonly kind: 'confirm'; readonly host: string }
  | { readonly kind: 'aborted' }

/** An opened round: its Run, and the prefix its request is assembled from. */
interface OpenedRound {
  readonly runId: string
  readonly incarnationId: string
  /** The top of the Run's own pre-run batch. */
  readonly contextAtEntryId: number
}

/** A command's turn: done with a result, or out of the mailbox to prebuild and in again. */
type Turn<T> =
  | { readonly kind: 'done'; readonly result: T }
  | { readonly kind: 'again'; readonly lease: RunLease }

export interface LoopDeps {
  readonly tape: Tape
  readonly ids: IdSource
  readonly now: () => number
  readonly connector: RunConnector
  readonly log: (line: string) => void
}

export interface Loop {
  bind(ports: LoopPorts): void
  recover(): Promise<RecoverResult>
  resume(q: { rootSessionId: string; origin: RunOrigin | null }): Promise<ResumeResult>
  send(q: SendQuery): Promise<SendResult>
  continueRun(q: { sessionId: string; origin: RunOrigin | null }): Promise<ContinueRunResult>
  answer(q: AnswerCommand & { origin: RunOrigin | null }): Promise<AnswerResult>
  stop(q: { rootSessionId: string }): Promise<{ stopped: boolean }>
}

export function createLoop(deps: LoopDeps): Loop {
  const { tape, ids, now, connector, log } = deps
  const sessionSlice = tape.writer('session')
  const messageSlice = tape.writer('message')
  const executionSlice = tape.writer('execution')
  const boxes = new Map<string, RootBox>()
  let bound: LoopPorts | null = null

  // ----- the executor --------------------------------------------------------------------------

  /**
   * The mailbox of a root. Sub-agent sessions map onto their root in plan step 31; until then every
   * session is its own root. A box that falls idle is dropped (see `pump`), and every post happens
   * either synchronously after this call or while the box holds a live lease, so no caller ever
   * posts to a dropped box.
   */
  function mailboxOf(rootSessionId: string): RootBox {
    let box = boxes.get(rootSessionId)
    if (box === undefined) {
      box = { rootSessionId, tasks: [], running: false, lease: null, runOpen: false, held: null }
      boxes.set(rootSessionId, box)
    }
    return box
  }

  /** Drops a box with nothing left in it: no task, no lease, nothing held. */
  function dropIfIdle(box: RootBox): void {
    if (canBeginAtEntry(box) && box.held === null) boxes.delete(box.rootSessionId)
  }

  function pump(box: RootBox): void {
    if (box.running) return
    const index = nextIndex(box)
    if (index < 0) {
      dropIfIdle(box)
      return
    }
    const [task] = box.tasks.splice(index, 1)
    if (task === undefined) return
    box.running = true
    void task.body().finally(() => {
      box.running = false
      pump(box)
    })
  }

  /** Queues `body` behind this root's earlier tasks and settles with its result. */
  function post<T>(
    box: RootBox,
    kind: TaskKind,
    owner: RunLease | null,
    body: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      box.tasks.push({
        kind,
        owner,
        body: () => body().then(resolve, reject),
      })
      pump(box)
    })
  }

  // ----- leases and events ----------------------------------------------------------------------

  /**
   * Finishes a lease: the kernel's own record first, so a host whose `finish` throws still leaves the
   * root free, then the host's. The tasks that waited behind the holder may run now: inside a task
   * the pump waits for that task to end, outside one (a prebuild that failed) it starts them here.
   */
  function finish(box: RootBox, lease: RunLease): void {
    if (box.lease === lease) {
      box.lease = null
      box.runOpen = false
    }
    try {
      lease.finish()
    } catch (error) {
      log(`[loop] finishing a lease of ${box.rootSessionId} threw: ${describe(error)}`)
    }
    pump(box)
  }

  /** Events are synchronous, and a host that throws from one only reaches the log. */
  function emit(ports: LoopPorts, event: SessionEvent): void {
    try {
      ports.events(event)
    } catch (error) {
      log(`[loop] a ${event.type} event handler threw: ${describe(error)}`)
    }
  }

  function runEnded(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    ended: Omit<
      Extract<SessionEvent, { type: 'run-ended' }>,
      'type' | 'rootSessionId' | 'sessionId'
    >,
  ): void {
    emit(ports, { type: 'run-ended', rootSessionId: box.rootSessionId, sessionId, ...ended })
  }

  // ----- a new round ----------------------------------------------------------------------------

  /**
   * `resolveChoice`, `assemble`, `provider()` — before any fact, racing the lease: the moment it is
   * aborted the round stops waiting (a keychain prompt may never be answered), and a late result or
   * failure is dropped. A configuration problem is an answer, not a failure; anything else rejects.
   */
  function prebuild(sessionId: string, box: RootBox, lease: RunLease): Promise<Prebuild> {
    const signal = lease.signal
    let providerId: ProviderId | null = null
    const work = (async (): Promise<Prebuild> => {
      // ① (the session's own choice, `session/model_choice_set`) is read from the tape in plan step
      // 19, the previous origin with the data-flow check; the draft's profile in step 18.
      const resolved = await connector.resolveChoice({
        sessionId,
        profile: 'chat',
        sessionChoice: null,
        previousOrigin: null,
      })
      if ('needsConfirm' in resolved) return { kind: 'confirm', host: resolved.needsConfirm.host }
      providerId = resolved.providerId
      if (signal.aborted) return { kind: 'aborted' }
      const assembly = await connector.assemble({
        sessionId,
        rootSessionId: box.rootSessionId,
        choice: resolved,
        signal,
      })
      if (signal.aborted) return { kind: 'aborted' }
      return { kind: 'ready', choice: resolved, assembly, provider: assembly.provider() }
    })().catch((error: unknown): Prebuild => {
      const problem = configProblem(error, providerId)
      if (problem === null) throw error
      return problem
    })
    // Handled here too, so a failure that loses the race is not an unhandled rejection.
    work.catch(() => undefined)
    return Promise.race([work, whenAborted(signal)])
  }

  /** 「登记之后、append 之前被中止」: with no waiting state to close yet, nothing is written. */
  function abortedBeforeAppend(ports: LoopPorts, box: RootBox, lease: RunLease): SendResult {
    const cause = abortCauseOf(lease)
    finish(box, lease)
    // Plan step 15: a user-stop here closes the paused state it finds, in this command's name.
    runEnded(ports, box, box.rootSessionId, {
      runId: null,
      reason: abortedEndReason(cause),
      recorded: false,
      lastStop: null,
      errorCode: null,
    })
    return { status: 'not-sent', code: cause === 'user-stop' ? 'stopped' : 'app-exit' }
  }

  async function sendTurn(
    ports: LoopPorts,
    box: RootBox,
    q: SendQuery & { text: string },
    lease: RunLease | null,
    pre: Prebuild | null,
  ): Promise<Turn<SendResult>> {
    if (lease !== null && lease.signal.aborted) {
      return { kind: 'done', result: abortedBeforeAppend(ports, box, lease) }
    }
    // 「何时判定」: in progress means a Run already opened, an aborted one still closing included — and
    // the message is then marked urgent, so it goes first once that Run ends. A lease with no Run open
    // yet can only be this command's own here: such a holder lets nothing but itself run.
    if (box.lease !== null && box.runOpen) {
      const urgent = box.lease.signal.aborted
      const { queuedId } = await ports.queue.enqueue(box.rootSessionId, q.text, { urgent })
      return { kind: 'done', result: { status: 'queued', queuedId } }
    }
    // Plan step 15: a pending approval is superseded here and a pending question answered by the
    // text; plan step 16: a resumable session resumes first and this message queues.
    if (lease === null || pre === null) {
      const begun = ports.leases.begin({ rootSessionId: box.rootSessionId, origin: q.origin })
      if ('refused' in begun)
        return { kind: 'done', result: { status: 'refused', code: begun.refused } }
      return { kind: 'again', lease: hold(box, begun) }
    }
    return { kind: 'done', result: await newRound(ports, box, q, lease, pre) }
  }

  async function newRound(
    ports: LoopPorts,
    box: RootBox,
    q: SendQuery & { text: string },
    lease: RunLease,
    pre: Prebuild,
  ): Promise<SendResult> {
    if (pre.kind === 'aborted') return abortedBeforeAppend(ports, box, lease)
    if (pre.kind === 'config') {
      // 「缺 key」: nothing is written, the queue stays as it is, and the failure card is the
      // interface's (owner 2026-09-25).
      log(`[loop] ${box.rootSessionId}: not sent: ${pre.detail}`)
      finish(box, lease)
      runEnded(ports, box, q.sessionId, {
        runId: null,
        reason: {
          code: 'provider-error',
          providerId: pre.providerId,
          errorCode: pre.errorCode,
          providerReason: null,
          attempts: 0,
        },
        recorded: false,
        lastStop: null,
        errorCode: pre.errorCode,
      })
      return { status: 'not-sent', code: 'config-missing' }
    }
    if (pre.kind === 'confirm') {
      // 「间接切公网」: 0 requests and no fact; this message waits in the queue for the menu's
      // confirmation. Releasing it (`session.selectModel`) and clearing it are plan steps 17 and 19.
      try {
        const { queuedId } = await ports.queue.enqueue(box.rootSessionId, q.text, {
          urgent: false,
        })
        box.held = { host: pre.host, queuedId }
        emit(ports, {
          type: 'queue-held',
          rootSessionId: box.rootSessionId,
          sessionId: q.sessionId,
          host: pre.host,
        })
        return { status: 'held', queuedId }
      } finally {
        finish(box, lease)
      }
    }
    let opened: OpenedRound
    try {
      opened = await openRound(ports, box, q, pre)
    } catch (error) {
      finish(box, lease)
      throw error
    }
    startRun(ports, box, q.sessionId, opened, lease, pre)
    return { status: 'started', runId: opened.runId }
  }

  /**
   * The pre-run batch, in ONE transaction: `session/start` when the session does not exist yet, the
   * user's turn, `run_started` and `session/model_selected`. Plan step 17 puts the queued messages
   * taken with this round in front of the user's turn; plan step 18 adds the draft's profile,
   * workspace and model-choice facts to the creating batch.
   */
  async function openRound(
    ports: LoopPorts,
    box: RootBox,
    q: SendQuery & { text: string },
    pre: Extract<Prebuild, { kind: 'ready' }>,
  ): Promise<OpenedRound> {
    const { assembly, provider } = pre
    // A model that belongs to another provider is a programmer error, caught before anything is
    // written: past this point `session/model_selected` would advertise a pair nobody can encode.
    assertModelBelongs(assembly.model, provider.id)
    const head = await tape.head(q.sessionId)
    const incarnationId = head?.incarnationId ?? ids.uuid()
    const entries: NewEntry[] = []
    if (head === null) entries.push(startEntry(q.sessionId, incarnationId))
    const content = userTextContent(q.text)
    // A resend (01's retry rule, 01 修补 9 (r): only for a message that never queued) reuses the id
    // and revision of the message it resends, so its append is the idempotent no-op.
    const resend = head === null ? null : await resendOf(q.sessionId, content)
    const messageId = resend?.messageId ?? ids.uuid()
    const revision = resend?.revision ?? FIRST_REVISION
    const runId = ids.uuid()
    const userPayload: TapeUserMessagePayload = {
      messageId,
      revision,
      role: 'user',
      content: [...content],
      status: 'complete',
    }
    const started: RunStartedPayload = { cause: { kind: 'user-message', messageId } }
    // Which provider and model THIS Run used. `capabilitySource` and `endpointOrigin` are written
    // from plan step 19, with the choice they describe.
    const selected: ModelSelectedPayload = { providerId: provider.id, modelId: assembly.model.id }
    entries.push(
      messageSlice.entry('message/user', {
        sourceType: 'message',
        sourceId: messageId,
        sourceSeq: revision,
        provenanceKey: messageRevisionKey(messageId, revision),
        payload: userPayload,
        createdAt: now(),
      }),
      executionSlice.entry('execution/run_started', {
        sourceType: 'runtime_event',
        sourceId: runId,
        provenanceKey: runStartedKey(runId),
        payload: started,
        createdAt: now(),
      }),
      // Last, so it is the batch's largest id: the pin the request is assembled from.
      sessionSlice.entry('session/model_selected', {
        sourceType: 'session',
        sourceId: q.sessionId,
        provenanceKey: modelSelectedKey(runId),
        payload: selected,
        createdAt: now(),
      }),
    )
    const receipts = await tape.appendEntries({ sessionId: q.sessionId, incarnationId, entries })
    box.runOpen = true
    emit(ports, {
      type: 'run-started',
      rootSessionId: box.rootSessionId,
      sessionId: q.sessionId,
      runId,
    })
    emit(ports, {
      type: 'user-message',
      rootSessionId: box.rootSessionId,
      sessionId: q.sessionId,
      runId,
      messageId,
      queuedId: null,
    })
    // The pin: THIS Run's own receipts, not a second head read — the head is shared, and another
    // session's writes are not this request's context.
    return {
      runId,
      incarnationId,
      contextAtEntryId: Math.max(...receipts.map((receipt) => receipt.entryId)),
    }
  }

  /**
   * The Run itself, outside the mailbox; it comes back in to write its facts, finish the lease and
   * say so. Whatever goes wrong, the lease is finished and `run-ended` is sent: a Run that could not
   * record its end says `recorded: false`.
   */
  function startRun(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    opened: OpenedRound,
    lease: RunLease,
    pre: Extract<Prebuild, { kind: 'ready' }>,
  ): void {
    const { runId } = opened
    void (async (): Promise<void> => {
      let outcome: RequestOutcome | null = null
      let failure: unknown = null
      try {
        outcome = await streamRequest({
          tape,
          ids,
          now,
          sessionId,
          runId,
          contextAtEntryId: opened.contextAtEntryId,
          provider: pre.provider,
          model: pre.assembly.model,
          maxTokens: pre.assembly.maxTokens,
          effort: pre.choice.effort,
          signal: lease.signal,
          onDelta: (event) =>
            emit(ports, {
              type: event.type,
              rootSessionId: box.rootSessionId,
              sessionId,
              runId,
              delta: event.text,
            }),
        })
      } catch (error) {
        failure = error
      }
      await post(box, 'run', null, async () => {
        let recorded = false
        if (outcome !== null) {
          try {
            await tape.appendEntries({
              sessionId,
              incarnationId: opened.incarnationId,
              entries: outcome.terminal,
            })
            recorded = true
          } catch (error) {
            failure = error
          }
        }
        finish(box, lease)
        if (outcome !== null && recorded) {
          runEnded(ports, box, sessionId, {
            runId,
            reason: endReasonOf(outcome, lease, pre.assembly.maxTokens),
            recorded: true,
            lastStop: outcome.stop?.reason ?? null,
            errorCode: outcome.error?.code ?? null,
          })
          return
        }
        // The Run failed before its facts were written — a programmer error, a session deleted
        // underneath it, a store closed by an exit. Plan step 13 records `run_terminal` and step 16
        // recovers a Run left without one; here the host is told it ended, and why is in the log.
        log(`[loop] run ${runId} of ${sessionId} did not record its end: ${describe(failure)}`)
        runEnded(ports, box, sessionId, {
          runId,
          reason: failedEndReason(pre.provider.id),
          recorded: false,
          lastStop: null,
          errorCode: 'unknown',
        })
      })
    })()
  }

  // ----- facts the round reads and writes ------------------------------------------------------

  function startEntry(sessionId: string, incarnationId: string): NewEntry {
    const payload: SessionStartPayload = { incarnationId }
    return sessionSlice.entry('session/start', {
      sourceType: 'session',
      sourceId: sessionId,
      sourceSeq: 0,
      provenanceKey: sessionStartKey(incarnationId),
      payload,
      createdAt: now(),
    })
  }

  /**
   * The retry rule's subject (01 §entry 模型「重试与失败的表示」): the folded transcript's LAST
   * message, when it is a user turn carrying exactly this content — the previous send of it got no
   * answer, so this is a resend of that message rather than a second turn. Two bounded reads of
   * `message_projection` rather than a re-fold; the revision comes from the one fact the row names.
   */
  async function resendOf(
    sessionId: string,
    content: readonly unknown[],
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
    if (canonicalJson(payload.content) !== canonicalJson(content)) return null
    return { messageId: payload.messageId, revision: payload.revision }
  }

  // ----- the commands ---------------------------------------------------------------------------

  async function sendFrom(
    ports: LoopPorts,
    box: RootBox,
    q: SendQuery & { text: string },
    lease: RunLease | null,
    prebuilt: Promise<Prebuild> | null,
  ): Promise<SendResult> {
    let pre: Prebuild | null = null
    try {
      pre = prebuilt === null ? null : await prebuilt
    } catch (error) {
      // Not a configuration problem: nothing was written, and the lease this command holds is
      // finished before the failure goes up.
      if (lease !== null) finish(box, lease)
      throw error
    }
    const turn = await post(box, 'command', lease, () => sendTurn(ports, box, q, lease, pre))
    if (turn.kind === 'done') return turn.result
    // Began in the mailbox: out to prebuild, and in again. Nothing is written in between.
    return sendFrom(ports, box, q, turn.lease, prebuild(q.sessionId, box, turn.lease))
  }

  return {
    bind(ports): void {
      if (bound !== null) throw new Error('bindLoop: the loop is already bound')
      bound = ports
    },

    recover(): Promise<RecoverResult> {
      if (bound === null) return Promise.reject(new Error('recover() before bindLoop()'))
      // Plan step 16: closes what a crash left open and lists the resumable items.
      return Promise.resolve({ resumable: [], errors: [] })
    },

    resume(): Promise<ResumeResult> {
      // Plan step 16: the kernel's resumable set is filled by recover(), which lists nothing yet.
      return Promise.resolve({ status: bound === null ? 'refused' : 'none' })
    },

    send(q): Promise<SendResult> {
      const ports = bound
      if (ports === null) return Promise.resolve({ status: 'refused', code: 'not-bound' })
      if (!isCanonicalUuid(q.sessionId)) {
        return Promise.reject(new TypeError(`send: "${q.sessionId}" is not a canonical UUID`))
      }
      // Plan step 17: the send-now of a queued item, and the urgent send.
      if (!('text' in q)) return Promise.resolve({ status: 'not-found' })
      if (q.text === '') {
        return Promise.reject(new TypeError('send: an empty message is never written'))
      }
      const box = mailboxOf(q.sessionId)
      // The entry, before the first await: a lease only when nothing is ahead of this command.
      if (!canBeginAtEntry(box)) return sendFrom(ports, box, q, null, null)
      const begun = ports.leases.begin({ rootSessionId: box.rootSessionId, origin: q.origin })
      if ('refused' in begun) {
        dropIfIdle(box)
        return Promise.resolve({ status: 'refused', code: begun.refused })
      }
      const lease = hold(box, begun)
      return sendFrom(ports, box, q, lease, prebuild(q.sessionId, box, lease))
    },

    continueRun(): Promise<ContinueRunResult> {
      // Plan step 13: 「继续」 after a truncated or limited Run.
      return Promise.resolve({ status: bound === null ? 'refused' : 'not-available' })
    },

    answer(): Promise<AnswerResult> {
      // Plan step 15: nothing waits on an answer before the waiting states exist.
      return Promise.resolve({ status: bound === null ? 'refused' : 'not-found' })
    },

    stop(q): Promise<{ stopped: boolean }> {
      if (bound === null) return Promise.resolve({ stopped: false })
      const live = boxes.get(q.rootSessionId)?.lease ?? null
      if (live !== null) {
        live.abort('user-stop')
        return Promise.resolve({ stopped: true })
      }
      // No live lease: into the mailbox, and looked at again when its turn comes — a command ahead of
      // it may have begun one by then. Plan step 15 closes a paused session here, step 16 a
      // resumable one.
      const box = mailboxOf(q.rootSessionId)
      return post(box, 'stop', null, async (): Promise<{ stopped: boolean }> => {
        const lease = box.lease
        if (lease === null) return { stopped: false }
        lease.abort('user-stop')
        return { stopped: true }
      })
    },
  }
}

/** Nothing queued, nothing running, no live lease: an entry may begin a lease. */
function canBeginAtEntry(box: RootBox): boolean {
  return box.lease === null && box.tasks.length === 0 && !box.running
}

/**
 * The next task to run. While the live lease is held by a party that has not opened its Run, only
 * that party's task and stops may run; everything else keeps its place.
 */
function nextIndex(box: RootBox): number {
  const holder = box.lease !== null && !box.runOpen ? box.lease : null
  if (holder === null) return box.tasks.length > 0 ? 0 : -1
  return box.tasks.findIndex((task) => task.owner === holder || task.kind !== 'command')
}

/** Records a lease just begun as this root's live one, held by a party with no Run open yet. */
function hold(box: RootBox, lease: RunLease): RunLease {
  box.lease = lease
  box.runOpen = false
  return lease
}

/** A prebuild failure that is the user's configuration, as the failure card names it. */
function configProblem(error: unknown, providerId: ProviderId | null): Prebuild | null {
  if (error instanceof ProviderConfigMissingError) {
    return {
      kind: 'config',
      providerId: providerId ?? error.providerId,
      errorCode: 'auth',
      detail: error.message,
    }
  }
  // A value that is present but unusable (a base URL with a query string): phase 1's `provider`
  // bucket, which is where the wire's own `invalid-request` goes.
  if (error instanceof ProviderInvalidArgumentError) {
    return {
      kind: 'config',
      providerId: providerId ?? '',
      errorCode: 'invalid-request',
      detail: error.message,
    }
  }
  return null
}

/** How a Run that could not record its end is reported: the service failed, nothing was retried. */
function failedEndReason(providerId: ProviderId): RunEndReason {
  return {
    code: 'provider-error',
    providerId,
    errorCode: 'unknown',
    providerReason: null,
    attempts: 0,
  }
}

/** Resolves once the signal is aborted — the prebuild's side of the race. */
function whenAborted(signal: AbortSignal): Promise<Prebuild> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ kind: 'aborted' })
      return
    }
    signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true })
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
