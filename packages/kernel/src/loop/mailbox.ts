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
 * Plan step 9 builds the executor, the leases and the new-round path of `send`; step 13 the Run's
 * rounds and its terminal task, and 「继续」. The other commands are declared and answer as if there
 * were nothing for them to do (there is not, yet). Plan step 15 adds the waiting states and the rest
 * of the timing rules, step 16 recovery and resume, step 17 the queue's insertion and auto-send.
 */
import type { AbsolutePath, HostAdapter } from '../host/adapter.js'
import type { IdSource } from '../ids.js'
import { isCanonicalUuid } from '../ids.js'
import { ProviderConfigMissingError, ProviderInvalidArgumentError } from '../provider/errors.js'
import type { Provider, ProviderErrorCode, ProviderId } from '../provider/types.js'
import { assertModelBelongs } from '../provider/wire/shared.js'
import { canonicalJson } from '../tape/canonical-json.js'
import type { InspectorRegistration } from '../permission/inspector.js'
import { MODEL_NOTES } from '../prompts/index.js'
import type {
  ContinuationPayload,
  ModelSelectedPayload,
  NewEntry,
  RunStartedPayload,
  RunTerminalPayload,
  SessionStartPayload,
} from '../tape/entry.js'
import type { TapeUserMessagePayload } from '../tape/projection.js'
import { parseMessagePayload } from '../tape/projection.js'
import {
  messageRevisionKey,
  modelSelectedKey,
  runStartedKey,
  runTerminalKey,
  sessionStartKey,
} from '../tape/provenance.js'
import { MAX_READ_LIMIT } from '../tape/store.js'
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
import type { PolicyState } from '../host/policy.js'
import type { UserToolSetting } from '../permission/decide.js'
import type { BuiltinToolName } from '../tools/builtin/tool.js'
import { readSessionEntries } from './batch.js'
import type { Written } from './batch.js'
import type { CallRef } from './closure.js'
import { notRunFacts } from './closure.js'
import { mcpCandidates } from '../tools/mcp-source.js'
import { builtinCandidates } from '../tools/registry.js'
import { openToolTable } from '../tools/table.js'
import type { FrozenToolTable, ToolKey } from '../tools/table.js'
import type { RunDriverContext, RunFinish } from './run.js'
import {
  FIRST_REVISION,
  abortCauseOf,
  abortedEndReason,
  callKeyOf,
  driveRun,
  notRunView,
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

/** A command that opens a Run, stopped before anything was written. */
type NotSent = { readonly status: 'not-sent'; readonly code: 'stopped' | 'app-exit' }

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
  /** The policy is read from it once per decision and once per table opening (D4). */
  readonly host: HostAdapter
  readonly connector: RunConnector
  readonly log: (line: string) => void
  readonly inspectors: readonly InspectorRegistration[]
  readonly protectedFiles: readonly AbsolutePath[]
  /** Which builtin tools the registry offers: the product's, or every one under a test registry. */
  readonly builtinAvailable: (name: BuiltinToolName) => boolean
  /** The test registry's executors; null in the product. */
  readonly testTools: Readonly<Partial<Record<BuiltinToolName, 'fake' | 'real' | null>>> | null
  /** Layer 3 for a connector tool; the product has no producer, so it always answers null. */
  readonly userSetting: (key: ToolKey) => UserToolSetting | null
  /** A token limit on every Run (H11): off in the product; evals, sub-agents and tests set one. */
  readonly tokenLimit: number | null
  /** A call that reaches a request with no result: throw, or repair and log (§兜底). */
  readonly onUnansweredCall: 'throw' | 'repair'
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
  function abortedBeforeAppend(ports: LoopPorts, box: RootBox, lease: RunLease): NotSent {
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

  /**
   * 「缺 key」: nothing is written, the queue stays as it is, and the failure card is the interface's
   * (owner 2026-09-25).
   */
  function configMissing(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    lease: RunLease,
    pre: Extract<Prebuild, { kind: 'config' }>,
  ): { status: 'not-sent'; code: 'config-missing' } {
    log(`[loop] ${box.rootSessionId}: not sent: ${pre.detail}`)
    finish(box, lease)
    runEnded(ports, box, sessionId, {
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
    if (pre.kind === 'config') return configMissing(ports, box, q.sessionId, lease, pre)
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
    entries.push(
      messageSlice.entry('message/user', {
        sourceType: 'message',
        sourceId: messageId,
        sourceSeq: revision,
        provenanceKey: messageRevisionKey(messageId, revision),
        payload: userPayload,
        createdAt: now(),
      }),
      ...runHead(q.sessionId, runId, { kind: 'user-message', messageId }, pre),
    )
    const opened = await appendOpening(ports, box, q.sessionId, runId, incarnationId, entries)
    emit(ports, {
      type: 'user-message',
      rootSessionId: box.rootSessionId,
      sessionId: q.sessionId,
      runId,
      messageId,
      queuedId: null,
    })
    return opened
  }

  /**
   * `run_started` and `session/model_selected`, last in a Run's opening batch so the latter is the
   * batch's largest id: the pin the first request is assembled from.
   */
  function runHead(
    sessionId: string,
    runId: string,
    cause: RunStartedPayload['cause'],
    pre: Extract<Prebuild, { kind: 'ready' }>,
  ): NewEntry[] {
    const started: RunStartedPayload = { cause }
    // Which provider and model THIS Run used. `capabilitySource` and `endpointOrigin` are written
    // from plan step 19, with the choice they describe.
    const selected: ModelSelectedPayload = {
      providerId: pre.provider.id,
      modelId: pre.assembly.model.id,
    }
    return [
      executionSlice.entry('execution/run_started', {
        sourceType: 'runtime_event',
        sourceId: runId,
        provenanceKey: runStartedKey(runId),
        payload: started,
        createdAt: now(),
      }),
      sessionSlice.entry('session/model_selected', {
        sourceType: 'session',
        sourceId: sessionId,
        provenanceKey: modelSelectedKey(runId),
        payload: selected,
        createdAt: now(),
      }),
    ]
  }

  /** Appends a Run's opening batch: from here the lease has opened its Run. */
  async function appendOpening(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    runId: string,
    incarnationId: string,
    entries: readonly NewEntry[],
  ): Promise<OpenedRound> {
    const receipts = await tape.appendEntries({ sessionId, incarnationId, entries })
    box.runOpen = true
    emit(ports, { type: 'run-started', rootSessionId: box.rootSessionId, sessionId, runId })
    // The pin: THIS Run's own receipts, not a second head read — the head is shared, and another
    // session's writes are not this request's context.
    return {
      runId,
      incarnationId,
      contextAtEntryId: Math.max(...receipts.map((receipt) => receipt.entryId)),
    }
  }

  // ----- 「继续」 -------------------------------------------------------------------------------

  /**
   * What 「继续」 continues (§重试与「继续」): the session's latest Run, when it ended as `step-limit`
   * or `output-truncated` and no `message/user` came after it. Null when there is nothing to continue.
   */
  async function continuable(
    sessionId: string,
  ): Promise<{ runId: string; cause: ContinuationPayload['cause'] } | null> {
    if ((await tape.head(sessionId)) === null) return null
    const entries = await readSessionEntries(tape, sessionId)
    let last: string | null = null
    for (const entry of entries) if (entry.name === 'execution/run_started') last = entry.sourceId
    if (last === null) return null
    const terminal = entries.find(
      (entry) => entry.name === 'execution/run_terminal' && entry.sourceId === last,
    )
    if (terminal === undefined) return null
    const code = (terminal.payload['reason'] as RunEndReason | undefined)?.code
    if (code !== 'step-limit' && code !== 'output-truncated') return null
    const later = entries.some(
      (entry) => entry.name === 'message/user' && entry.entryId > terminal.entryId,
    )
    return later ? null : { runId: last, cause: code }
  }

  async function continueTurn(
    ports: LoopPorts,
    box: RootBox,
    q: { sessionId: string; origin: RunOrigin | null },
    lease: RunLease | null,
    pre: Prebuild | null,
  ): Promise<Turn<ContinueRunResult>> {
    if (lease !== null && lease.signal.aborted) {
      return { kind: 'done', result: abortedBeforeAppend(ports, box, lease) }
    }
    // A Run in progress is never this command's own (its lease has opened nothing yet).
    if (box.lease !== null && box.runOpen)
      return { kind: 'done', result: { status: 'not-available' } }
    const after = await continuable(q.sessionId)
    if (after === null) {
      if (lease !== null) finish(box, lease)
      return { kind: 'done', result: { status: 'not-available' } }
    }
    if (lease === null || pre === null) {
      const begun = ports.leases.begin({ rootSessionId: box.rootSessionId, origin: q.origin })
      if ('refused' in begun) return { kind: 'done', result: { status: 'refused' } }
      return { kind: 'again', lease: hold(box, begun) }
    }
    if (pre.kind === 'aborted')
      return { kind: 'done', result: abortedBeforeAppend(ports, box, lease) }
    if (pre.kind === 'config') {
      return { kind: 'done', result: configMissing(ports, box, q.sessionId, lease, pre) }
    }
    if (pre.kind === 'confirm') {
      // 「继续」 meeting an indirect switch to a public host writes nothing (开放问题 26): the user
      // confirms in the menu and presses 「继续」 again.
      finish(box, lease)
      return { kind: 'done', result: { status: 'held', host: pre.host } }
    }
    let opened: OpenedRound
    try {
      opened = await openContinue(ports, box, q.sessionId, pre, after)
    } catch (error) {
      finish(box, lease)
      throw error
    }
    startRun(ports, box, q.sessionId, opened, lease, pre)
    return { kind: 'done', result: { status: 'started' } }
  }

  /**
   * The continuing Run's opening batch: `message/continuation` — the model-only English note, never
   * rendered, no `message/user` — then the Run's head, with cause `continue`. Its counters start
   * from 0: the chain the guards read stops at a Run not started by a resume.
   */
  async function openContinue(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    pre: Extract<Prebuild, { kind: 'ready' }>,
    after: { runId: string; cause: ContinuationPayload['cause'] },
  ): Promise<OpenedRound> {
    assertModelBelongs(pre.assembly.model, pre.provider.id)
    const head = await tape.head(sessionId)
    if (head === null) throw new Error(`continue: session ${sessionId} has no head`)
    const messageId = ids.uuid()
    const runId = ids.uuid()
    const note: ContinuationPayload = {
      messageId,
      revision: FIRST_REVISION,
      role: 'user',
      content: [...userTextContent(MODEL_NOTES.continuation[after.cause])],
      status: 'complete',
      cause: after.cause,
      afterRunId: after.runId,
    }
    const entries = [
      messageSlice.entry('message/continuation', {
        sourceType: 'message',
        sourceId: messageId,
        sourceSeq: FIRST_REVISION,
        provenanceKey: messageRevisionKey(messageId, FIRST_REVISION),
        payload: note,
        createdAt: now(),
      }),
      ...runHead(sessionId, runId, { kind: 'continue', afterRunId: after.runId, messageId }, pre),
    ]
    return appendOpening(ports, box, sessionId, runId, head.incarnationId, entries)
  }

  /**
   * The Run itself, outside the mailbox (`driveRun`); every fact it writes comes back in as a task.
   * Its end is one more task: `run_terminal` — with a paused decision in the same batch (同批规则 1)
   * — then the lease finished, then `run-ended`. Whatever goes wrong, the lease is finished and
   * `run-ended` is sent: a Run that could not record its end says `recorded: false`.
   */
  function startRun(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    opened: OpenedRound,
    lease: RunLease,
    pre: Extract<Prebuild, { kind: 'ready' }>,
  ): void {
    const { runId, incarnationId } = opened
    const root = box.rootSessionId
    const ctx: RunDriverContext = {
      tape,
      ids,
      now,
      log,
      host: deps.host,
      sessionId,
      incarnationId,
      runId,
      pin: opened.contextAtEntryId,
      provider: () => pre.provider,
      model: pre.assembly.model,
      maxTokens: pre.assembly.maxTokens,
      effort: pre.choice.effort,
      toolsWithheld: pre.assembly.toolsWithheld,
      search: pre.assembly.search,
      mcpSources: pre.assembly.mcpSources,
      // The draft's profile is written from plan step 18; until then every session is a chat.
      profile: 'chat',
      inspectors: deps.inspectors,
      protectedFiles: deps.protectedFiles,
      userSetting: deps.userSetting,
      testTools: deps.testTools,
      tokenLimit: deps.tokenLimit,
      lease,
      openTable: () => openTable(incarnationId, pre.assembly),
      write: (entries) =>
        post(box, 'run', null, () => appendFirstWins(sessionId, incarnationId, entries)),
      onUnansweredCall: deps.onUnansweredCall,
      emit: {
        delta: (id, type, delta) =>
          emit(ports, { type, rootSessionId: root, sessionId, runId: id, delta }),
        discarded: (id) =>
          emit(ports, { type: 'attempt-discarded', rootSessionId: root, sessionId, runId: id }),
        call: (call) =>
          emit(ports, {
            type: 'tool-call',
            rootSessionId: root,
            sessionId,
            callKey: call.callKey,
            providerToolCallId: call.providerToolCallId,
            name: call.name,
            input: call.input,
          }),
        outcome: (call, view) =>
          emit(ports, {
            type: 'tool-outcome',
            rootSessionId: root,
            sessionId,
            callKey: call.callKey,
            providerToolCallId: call.providerToolCallId,
            outcome: view,
          }),
      },
    }
    void (async (): Promise<void> => {
      let finished: RunFinish | null = null
      let failure: unknown = null
      try {
        finished = await driveRun(ctx)
      } catch (error) {
        failure = error
      }
      await post(box, 'run', null, async () => {
        if (finished === null) {
          // A programmer error, a session deleted underneath the Run, a store closed by an exit: no
          // terminal is written, and plan step 16's recovery closes what the Run left open.
          finish(box, lease)
          log(`[loop] run ${runId} of ${sessionId} did not record its end: ${describe(failure)}`)
          runEnded(ports, box, sessionId, {
            runId,
            reason: failedEndReason(pre.provider.id),
            recorded: false,
            lastStop: null,
            errorCode: 'unknown',
          })
          return
        }
        const end = terminalOf(finished, lease, runId)
        let recorded = false
        try {
          await tape.appendEntries({ sessionId, incarnationId, entries: end.entries })
          recorded = true
        } catch (error) {
          log(`[loop] run ${runId} of ${sessionId} did not record its end: ${describe(error)}`)
        }
        // Plan step 17 takes the queue here, between the terminal and the finish.
        finish(box, lease)
        if (recorded) {
          for (const ref of end.stopped) {
            const closure = end.entries.filter((entry) => entry.payload['ordinal'] === ref.ordinal)
            ctx.emit.outcome(
              {
                callKey: callKeyOf(ref.runId, ref.requestSeq, ref.ordinal),
                providerToolCallId: ref.providerToolCallId,
              },
              notRunView('stopped', closure),
            )
          }
        }
        runEnded(ports, box, sessionId, {
          runId,
          reason: end.reason,
          recorded,
          lastStop: finished.lastStop,
          errorCode: finished.errorCode,
        })
      })
    })()
  }

  /**
   * A Run's facts, committed in its mailbox task (§写入：谁写、写几次「先写者算数」): a `tool/result`
   * for a call that already has one is dropped with its `tool_outcome`, and the log hears of it. The
   * look-up and the append share one task, so no other writer of this root lands in between.
   */
  async function appendFirstWins(
    sessionId: string,
    incarnationId: string,
    entries: readonly NewEntry[],
  ): Promise<Written> {
    const results = entries.filter((entry) => entry.name === 'tool/result')
    let kept = entries
    let deferredTo: number | undefined
    if (results.length > 0) {
      const runIds = new Set(results.map((entry) => entry.sourceId ?? ''))
      const existing = await existingResults(sessionId, runIds)
      const beaten = results.filter((entry) => existing.has(entry.provenanceKey))
      const dropped = new Set(beaten.map(callOfFact))
      for (const entry of beaten) {
        deferredTo = Math.max(deferredTo ?? 0, existing.get(entry.provenanceKey) ?? 0)
      }
      if (dropped.size > 0) {
        kept = entries.filter(
          (entry) =>
            !(
              (entry.name === 'tool/result' || entry.name === 'execution/tool_outcome') &&
              dropped.has(callOfFact(entry))
            ),
        )
        for (const call of dropped) {
          log(`[loop] a second result for call ${call} was dropped: the first one written counts`)
        }
      }
    }
    const deferred = deferredTo === undefined ? {} : { deferredTo }
    if (kept.length === 0) return { entries: [], receipts: [], ...deferred }
    const receipts = await tape.appendEntries({ sessionId, incarnationId, entries: kept })
    return { entries: kept, receipts, ...deferred }
  }

  /** Every `tool/result` these Runs already have: its provenance key, and its entry id. */
  async function existingResults(
    sessionId: string,
    runIds: ReadonlySet<string>,
  ): Promise<Map<string, number>> {
    const keys = new Map<string, number>()
    for (const runId of runIds) {
      let fromEntryId: number | undefined
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- the next page starts after this one
        const page = await tape.readBySource({
          sessionId,
          sourceType: 'runtime_event',
          sourceId: runId,
          limit: MAX_READ_LIMIT,
          ...(fromEntryId === undefined ? {} : { fromEntryId }),
        })
        for (const entry of page) {
          if (entry.name === 'tool/result' && entry.provenanceKey !== null) {
            keys.set(entry.provenanceKey, entry.entryId)
          }
        }
        if (page.length < MAX_READ_LIMIT) break
        fromEntryId = (page.at(-1)?.entryId ?? 0) + 1
      }
    }
    return keys
  }

  /**
   * What the terminal task writes. A lease aborted before this task's turn (a stop, a closed window
   * or a quit that came after the Run decided to pause, end or fail) ends the Run by the abort
   * instead: the paused decision is not written and the calls it left waiting close not-run /
   * `stopped`, as a stop while judging would have (§主进程与 kernel 的循环接口「mailbox」; §点停止时各状态怎么收).
   * A pause the stop reaches after its terminal committed is plan step 15's.
   */
  function terminalOf(
    finished: RunFinish,
    lease: RunLease,
    runId: string,
  ): { reason: RunEndReason; entries: NewEntry[]; stopped: readonly CallRef[] } {
    const writer = { by: 'run', runId } as const
    const aborted = lease.signal.aborted
    const reason = aborted ? abortedEndReason(abortCauseOf(lease)) : finished.reason
    const stopped = aborted ? finished.waiting : []
    const entries: NewEntry[] = aborted
      ? stopped.flatMap((ref) => notRunFacts({ tape, now, call: ref, source: 'stopped', writer }))
      : [...finished.withTerminal]
    const payload: RunTerminalPayload = {
      reason,
      steps: finished.steps,
      usage: [...finished.usage],
      writer,
    }
    entries.push(
      executionSlice.entry('execution/run_terminal', {
        sourceType: 'runtime_event',
        sourceId: runId,
        provenanceKey: runTerminalKey(runId),
        payload,
        createdAt: now(),
      }),
    )
    return { reason, entries, stopped }
  }

  /**
   * Opens this provider's table for the generation (§开表与排除): the profile's builtin candidates
   * and every connector tool of the Run's MCP sources, with one reading of the policy (D4). The
   * profile is always chat until plan step 18 writes `session/profile_set`; compaction (step 30) is
   * what makes a generation other than 0.
   */
  async function openTable(
    incarnationId: string,
    assembly: RunAssembly,
  ): Promise<{ table: FrozenToolTable; policy: PolicyState }> {
    const policy = deps.host.policy.current()
    const candidates = [
      ...builtinCandidates({
        profile: 'chat',
        available: deps.builtinAvailable,
        search: assembly.search,
      }),
      ...(await mcpCandidates(assembly.mcpSources)),
    ]
    const table = openToolTable({
      providerId: assembly.model.providerId,
      incarnationId,
      generation: 0,
      reason: 'first-use',
      candidates,
      policy,
      tenantId: deps.host.identity.tenantId,
      userSetting: deps.userSetting,
      hasSearchBackend: assembly.search !== null,
    })
    return { table, policy }
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

  /**
   * A command that may open a Run (send, continue): at its entry, before the first await, it begins
   * a lease only when nothing is ahead of it, and prebuilds; otherwise it queues without one.
   */
  function enter<T>(
    ports: LoopPorts,
    box: RootBox,
    q: { sessionId: string; origin: RunOrigin | null },
    turn: (lease: RunLease | null, pre: Prebuild | null) => Promise<Turn<T>>,
    refused: (code: 'shutting-down') => T,
  ): Promise<T> {
    if (!canBeginAtEntry(box)) return commandFrom(box, q.sessionId, null, null, turn)
    const begun = ports.leases.begin({ rootSessionId: box.rootSessionId, origin: q.origin })
    if ('refused' in begun) {
      dropIfIdle(box)
      return Promise.resolve(refused(begun.refused))
    }
    const lease = hold(box, begun)
    return commandFrom(box, q.sessionId, lease, prebuild(q.sessionId, box, lease), turn)
  }

  async function commandFrom<T>(
    box: RootBox,
    sessionId: string,
    lease: RunLease | null,
    prebuilt: Promise<Prebuild> | null,
    turn: (lease: RunLease | null, pre: Prebuild | null) => Promise<Turn<T>>,
  ): Promise<T> {
    let pre: Prebuild | null = null
    try {
      pre = prebuilt === null ? null : await prebuilt
    } catch (error) {
      // Not a configuration problem: nothing was written, and the lease this command holds is
      // finished before the failure goes up.
      if (lease !== null) finish(box, lease)
      throw error
    }
    const judged = await post(box, 'command', lease, () => turn(lease, pre))
    if (judged.kind === 'done') return judged.result
    // Began in the mailbox: out to prebuild, and in again. Nothing is written in between.
    return commandFrom(box, sessionId, judged.lease, prebuild(sessionId, box, judged.lease), turn)
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
      return enter(
        ports,
        box,
        q,
        (lease, pre) => sendTurn(ports, box, q, lease, pre),
        (code) => ({ status: 'refused', code }),
      )
    },

    continueRun(q): Promise<ContinueRunResult> {
      const ports = bound
      if (ports === null) return Promise.resolve({ status: 'refused' })
      if (!isCanonicalUuid(q.sessionId)) {
        return Promise.reject(
          new TypeError(`continueRun: "${q.sessionId}" is not a canonical UUID`),
        )
      }
      const box = mailboxOf(q.sessionId)
      return enter(
        ports,
        box,
        q,
        (lease, pre) => continueTurn(ports, box, q, lease, pre),
        () => ({ status: 'refused' }),
      )
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

/** A tool fact's call, `<runId>:<requestSeq>:<i>` (§键与挂靠). */
function callOfFact(entry: NewEntry): string {
  return `${String(entry.sourceId)}:${String(entry.sourceSeq)}:${String(entry.payload['ordinal'])}`
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
