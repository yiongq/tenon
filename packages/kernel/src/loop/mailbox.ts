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
import type { AbsolutePath, ConfirmRequest, HostAdapter } from '../host/adapter.js'
import type { IdSource } from '../ids.js'
import { isCanonicalUuid } from '../ids.js'
import { ProviderConfigMissingError, ProviderInvalidArgumentError } from '../provider/errors.js'
import type { ModelInfo, Provider, ProviderErrorCode, ProviderId } from '../provider/types.js'
import { assertModelBelongs } from '../provider/wire/shared.js'
import { canonicalJson } from '../tape/canonical-json.js'
import type { InspectorRegistration } from '../permission/inspector.js'
import { MODEL_NOTES } from '../prompts/index.js'
import type {
  AppendResult,
  ApprovalResolvedPayload,
  ContinuationPayload,
  FactWriter,
  ModelChoiceSetPayload,
  ModelSelectedPayload,
  NewEntry,
  PermissionDecidedPayload,
  RunStartedPayload,
  RunTerminalPayload,
  SessionStartPayload,
  WorkspaceSetPayload,
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
  QueuedMessage,
  RunAssembly,
  RunConnector,
  RunLease,
  RunOrigin,
} from './ports.js'
import type { PolicyState } from '../host/policy.js'
import type { UserToolSetting } from '../permission/decide.js'
import type { BuiltinToolName } from '../tools/builtin/tool.js'
import { answerScope, grantKey } from '../permission/grants.js'
import {
  answerTarget,
  confirmRequestOf,
  frozenBatchOf,
  pausedBatchOf,
  rejectFacts,
  rejudgeDecisionOf,
  rejudgeWaiting,
  resolvedEntry,
  resumeHead,
  stopFacts,
  supersedeFacts,
  tightenedFacts,
  waitingOf,
} from './answer.js'
import type { PausedBatch, PendingCard, PendingRoot, ResumeSetup, WaitingCall } from './answer.js'
import { recoverTape, resumableOf } from './recovery.js'
import type { Resumable } from './recovery.js'
import { RunWriteRefusedError, placeOf, readSessionEntries } from './batch.js'
import { approvalOf } from './calls.js'
import type { Written } from './batch.js'
import type { ClosureSource } from './closure.js'
import { notRunFacts } from './closure.js'
import { mcpCandidates } from '../tools/mcp-source.js'
import { builtinCandidates } from '../tools/registry.js'
import { openToolTable } from '../tools/table.js'
import type { FrozenToolTable, ToolKey } from '../tools/table.js'
import type { ResumeBatch, RunDriverContext, RunFinish } from './run.js'
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
import { createDraftStore } from '../session/draft.js'
import type { SessionDraft } from '../session/draft.js'
import {
  creationEntries,
  modelChoiceEntry,
  readSessionFacts,
  workspaceEntry,
} from '../session/facts.js'
import type { Profile, SessionFacts } from '../session/facts.js'
import { resolvePath } from '../permission/workspace.js'

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
  /** The Run the live lease opened: what a send-now names (「立即发送绑定 runId」). */
  runId: string | null
  /** The origin the live lease was begun with: an auto-send after it keeps it. */
  origin: RunOrigin | null
  /** The origin of the latest send that queued an urgent item (「Run 结束」, close-window). */
  urgentOrigin: RunOrigin | null
  /** The indirect switch to a public host waiting on the menu's confirmation (「间接切公网」). */
  held: { readonly host: string; readonly queuedId: string | null } | null
}

/** What a new round prepared before it took its turn: the model, the assembly, the provider. */
type Prebuild =
  | {
      readonly kind: 'ready'
      readonly choice: ModelChoice
      readonly assembly: RunAssembly
      readonly provider: Provider
      /** The session's profile: its `session/profile_set`, or the draft's for a new session. */
      readonly profile: Profile
      /**
       * A new session's draft as it stood when the prebuild began — what its creating batch writes
       * (model1: the batch equals the draft the prebuild read). Null for an established session.
       */
      readonly draft: SessionDraft | null
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

/**
 * What a Run is built from (see `startRun`): a new round's prebuild, or a resumed batch's frozen
 * model and request settings with an assembly made outside the mailbox.
 */
interface RunSetup {
  readonly provider: () => Provider
  /** Which candidate set a table opened by this Run takes (H1). */
  readonly profile: Profile
  readonly model: ModelInfo
  readonly maxTokens: number
  readonly effort: string | null
  readonly assembly: RunAssembly
  readonly resume?: ResumeBatch
}

/**
 * What a new round opens with: queued items an auto-send already took, or a send-now's item (taken
 * with the items before it), or a direct message (taken with everything queued before it).
 */
interface RoundInput {
  readonly sessionId: string
  readonly text: string | null
  readonly queuedId: string | null
  readonly taken: readonly QueuedMessage[] | null
}

/** One user turn of a new round: its text, and the queued item it was, if it was one. */
interface RoundMessage {
  readonly text: string
  readonly queuedId: string | null
}

/** An opened round: its Run, and the prefix its request is assembled from. */
interface OpenedRound {
  readonly runId: string
  readonly incarnationId: string
  /** The top of the Run's own pre-run batch. */
  readonly contextAtEntryId: number
  /** The user message that opened the Run (its `run_started` cause); absent for any other opener. */
  readonly openedBy?: string
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

/** What `sessionFacts` answers: the route's shape, and whether a draft exists (`unknown-session`). */
export interface SessionFactsView {
  readonly established: boolean
  readonly drafted: boolean
  readonly profile: Profile
  readonly workspace: WorkspaceSetPayload | null
  /**
   * Where this session's history last went — the origin the prebuild's data-flow check compares
   * with — so the model menu confirms against the same host (§模型选择「数据去向」). Null before the
   * first Run, and for a draft.
   */
  readonly lastEndpointOrigin: string | null
}

export type SelectProfileQuery =
  | { readonly sessionId: string; readonly profile: 'chat' }
  /** `dedicated`: the session's own folder, computed by the host (the kernel reads no home). */
  | { readonly sessionId: string; readonly profile: 'cowork'; readonly dedicated: AbsolutePath }

export type SelectProfileResult =
  | ({ readonly ok: true } & SessionFactsView)
  | { readonly ok: false; readonly code: 'established' }

/** A change to the workspace list: folders the host's own dialog or prefill gave, or one removed. */
export type WorkspaceChange =
  | { readonly kind: 'add'; readonly folders: readonly AbsolutePath[] }
  | { readonly kind: 'remove'; readonly folder: string }

export type WorkspaceResult =
  | {
      readonly ok: true
      readonly folders: readonly AbsolutePath[]
      readonly origin: 'picked' | 'dedicated'
    }
  | { readonly ok: false; readonly code: 'not-cowork' | 'unknown-session' | 'not-in-list' }

/** A choice in the model menu (§模型选择): what `session/model_choice_set` records. */
export interface SelectModelQuery {
  readonly sessionId: string
  readonly choice: ModelChoiceSetPayload
  /** The document that chose: a held round it releases begins with it (「间接切公网」). */
  readonly origin: RunOrigin | null
}

export interface Loop {
  bind(ports: LoopPorts): void
  /**
   * `session.selectModel` (§模型选择; 01 修补 6): the session's choice fact, or the draft's before it
   * exists; releases what a switch to a public host held. Answers the profile it was made in, which
   * the host writes `defaultModelByProfile` under.
   */
  selectModel(q: SelectModelQuery): Promise<{ readonly profile: Profile }>
  /** `session.modelChoice`: the choice in force for the session's next Run, by the five layers. */
  effectiveModelChoice(q: { sessionId: string }): Promise<ModelChoice>
  /** A session's profile and workspace: the draft's before it is established (open question 16). */
  sessionFacts(q: { sessionId: string }): Promise<SessionFactsView>
  /** The home page's profile, into the draft; `established` once the session exists (H1). */
  selectProfile(q: SelectProfileQuery): Promise<SelectProfileResult>
  /** The cowork workspace, in the draft or as a `session/workspace_set` (§工作区; D11). */
  setWorkspace(q: {
    sessionId: string
    change: WorkspaceChange
    dedicated: AbsolutePath
  }): Promise<WorkspaceResult>
  /**
   * Runs a clear of the session (`resetSession`: the facts read, the carry built, the store's reset)
   * as one command turn of its root's mailbox, where every other `session/*` fact is written
   * (§会话事实「写入」): a workspace change that arrives meanwhile lands before the read or after the
   * reset, never in between, where it would be lost with the old incarnation.
   */
  resetTurn<T>(sessionId: string, reset: () => Promise<T>): Promise<T>
  recover(): Promise<RecoverResult>
  resume(q: { rootSessionId: string; origin: RunOrigin | null }): Promise<ResumeResult>
  send(q: SendQuery): Promise<SendResult>
  continueRun(q: { sessionId: string; origin: RunOrigin | null }): Promise<ContinueRunResult>
  answer(q: AnswerCommand & { origin: RunOrigin | null }): Promise<AnswerResult>
  /** What `approval.current` shows for a root (it and its sub-agents): the one card, or null. */
  currentPending(q: { sessionId: string }): Promise<PendingCard | null>
  /** The roots that wait on an answer or can be resumed, one row each (`approval.list`). */
  listPendingRoots(q: { limit: number }): Promise<readonly PendingRoot[]>
  stop(q: { rootSessionId: string }): Promise<{ stopped: boolean }>
}

export function createLoop(deps: LoopDeps): Loop {
  const { tape, ids, now, connector, log } = deps
  const sessionSlice = tape.writer('session')
  const messageSlice = tape.writer('message')
  const executionSlice = tape.writer('execution')
  const boxes = new Map<string, RootBox>()
  /** Sub-agent session → root (§主进程与 kernel 的循环接口「mailbox」): filled from plan step 31. */
  const roots = new Map<string, string>()
  const rootOf = (sessionId: string): string => roots.get(sessionId) ?? sessionId
  /** The resumable set (§主进程与 kernel 的循环接口「recover」): filled by `recover()`, per root. */
  const resumables = new Map<string, Resumable>()
  /** The drafts of sessions not yet established (§会话形态「建立前暂存」): only mailboxes write them. */
  const drafts = createDraftStore()
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
      box = {
        rootSessionId,
        tasks: [],
        running: false,
        lease: null,
        runOpen: false,
        runId: null,
        origin: null,
        urgentOrigin: null,
        held: null,
      }
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
      box.runId = null
    }
    try {
      lease.finish()
    } catch (error) {
      log(`[loop] finishing a lease of ${box.rootSessionId} threw: ${describe(error)}`)
    }
    pump(box)
  }

  /** Clears `held` and says so (「间接切公网」: a stop, a new round, the held item taken). */
  function clearHeld(ports: LoopPorts, box: RootBox, sessionId: string): void {
    if (box.held === null) return
    box.held = null
    emit(ports, { type: 'queue-held', rootSessionId: box.rootSessionId, sessionId, host: null })
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
    // Taken before the first await, while this lease's holder lets nothing else run: a choice that
    // arrives later waits for the Run to open and lands after the session exists (model1).
    const draft = drafts.get(sessionId)
    const work = (async (): Promise<Prebuild> => {
      const facts = await readSessionFacts(tape, sessionId)
      const profile = facts.established ? facts.profile : (draft?.profile ?? 'chat')
      // ① is the session's own choice (the draft's before it exists); ②–⑤ and the data-flow check,
      // against where the last Run sent, are the connector's (01 修补 6「五层解析」).
      const resolved = await connector.resolveChoice({
        sessionId,
        profile,
        sessionChoice: choiceOf(
          facts.established ? facts.modelChoice : (draft?.modelChoice ?? null),
        ),
        previousOrigin: previousOriginOf(facts),
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
      return {
        kind: 'ready',
        choice: resolved,
        assembly,
        provider: assembly.provider(),
        profile,
        draft: facts.established ? null : draft,
      }
    })().catch((error: unknown): Prebuild => {
      const problem = configProblem(error, providerId)
      if (problem === null) throw error
      return problem
    })
    // Handled here too, so a failure that loses the race is not an unhandled rejection.
    work.catch(() => undefined)
    return Promise.race([work, whenAborted(signal)])
  }

  /**
   * 「登记之后、append 之前被中止」: a user-stop closes, in this command's name, the pause it finds —
   * `cancelled-by-stop` and the closures, no Run; an idle root, a quit or a closed window writes
   * nothing, and a card survives the restart (B4).
   */
  async function abortedBeforeAppend(
    ports: LoopPorts,
    box: RootBox,
    lease: RunLease,
  ): Promise<NotSent> {
    const cause = abortCauseOf(lease)
    // A resumable root is stopped by a Run that sends nothing, on this command's lease; that Run's
    // own `run-ended` is the only one (「登记之后、append 之前被中止」).
    if (await closeAborted(ports, box, lease)) return { status: 'not-sent', code: 'stopped' }
    runEnded(ports, box, box.rootSessionId, {
      runId: null,
      reason: abortedEndReason(cause),
      recorded: false,
      lastStop: null,
      errorCode: null,
      retryOf: null,
    })
    return { status: 'not-sent', code: cause === 'user-stop' ? 'stopped' : 'app-exit' }
  }

  /**
   * What a command whose lease was aborted before it appended closes, then finishes that lease
   * (「登记之后、append 之前被中止」): on a user-stop, the resumable root by the Run that sends nothing
   * — true, that Run said its own end — or else the pause it finds; on a quit or a closed window,
   * nothing, so a card and a resumable root survive the restart (B4).
   */
  async function closeAborted(ports: LoopPorts, box: RootBox, lease: RunLease): Promise<boolean> {
    try {
      if (abortCauseOf(lease) !== 'user-stop') return false
      if ((await stopResumable(ports, box, lease)) === true) return true
      await closePausedByStop(ports, box)
      return false
    } finally {
      if (box.lease === lease) finish(box, lease)
    }
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
      retryOf: null,
    })
    return { status: 'not-sent', code: 'config-missing' }
  }

  async function sendTurn(
    ports: LoopPorts,
    box: RootBox,
    q: SendQuery,
    lease: RunLease | null,
    pre: Prebuild | null,
  ): Promise<Turn<SendResult>> {
    if (lease !== null && lease.signal.aborted) {
      return { kind: 'done', result: await abortedBeforeAppend(ports, box, lease) }
    }
    const root = box.rootSessionId
    // 「立即发送绑定 runId」: an item no longer queued (an auto-send took it, it was inserted or
    // withdrawn) answers not-found and does nothing — no Run stopped, no prebuild's answer acted on
    // (models/model1 sendTurn: `qsend: item gone -> not-found` comes first).
    if (!('text' in q)) {
      const queued = (await ports.queue.peek(root)).some((item) => item.queuedId === q.queuedId)
      if (lease !== null && lease.signal.aborted) {
        return { kind: 'done', result: await abortedBeforeAppend(ports, box, lease) }
      }
      if (!queued) {
        if (lease !== null) finish(box, lease)
        return { kind: 'done', result: { status: 'not-found' } }
      }
    }
    // 「何时判定」: in progress means a Run already opened, an aborted one still closing included — and
    // the message is then marked urgent, so it goes first once that Run ends. A lease with no Run open
    // yet can only be this command's own here: such a holder lets nothing but itself run.
    if (box.lease !== null && box.runOpen) {
      const live = box.lease
      // 「立即发送绑定 runId」: only the Run the user saw is stopped; one that already ended is not,
      // and this is an ordinary send.
      const stopsRun = q.urgent !== undefined && box.runId === q.urgent.runId
      if ('text' in q) {
        if (stopsRun) live.abort('user-stop')
        const urgent = live.signal.aborted
        if (urgent) box.urgentOrigin = q.origin
        const { queuedId } = await ports.queue.enqueue(root, q.text, { urgent })
        return { kind: 'done', result: { status: 'queued', queuedId } }
      }
      // A queued item sent now: taken before anything is stopped — one withdrawn meanwhile stops
      // nothing — then back where it was, marked urgent when its Run was stopped.
      const [item] = await ports.queue.take(root, {
        upToSeq: null,
        urgentOnly: false,
        queuedId: q.queuedId,
      })
      if (item === undefined) return { kind: 'done', result: { status: 'not-found' } }
      if (stopsRun) live.abort('user-stop')
      const urgent = live.signal.aborted
      if (urgent) box.urgentOrigin = q.origin
      // The held item goes out next: it no longer waits on its own switch (「间接切公网」).
      if (urgent && box.held?.queuedId === item.queuedId) clearHeld(ports, box, q.sessionId)
      await ports.queue.restore(root, [{ ...item, urgent: urgent || item.urgent }])
      return { kind: 'done', result: { status: 'queued', queuedId: item.queuedId } }
    }
    // A resumable root resumes first and this message waits in the queue (§插话与输入框状态表); a
    // card waiting is superseded by the new round (§多卡、拒绝与取代); plan step 26 answers a
    // question with the text instead.
    const resumed = await resumeFirst(ports, box, q.origin, lease)
    if (resumed !== null && typeof resumed === 'object' && 'aborted' in resumed) {
      // The lease this send came in with, or the one the resume began for it at its turn.
      return { kind: 'done', result: await abortedBeforeAppend(ports, box, resumed.aborted) }
    }
    if (resumed !== null) {
      if (resumed !== 'started') return { kind: 'done', result: resumed }
      if (!('text' in q))
        return { kind: 'done', result: { status: 'queued', queuedId: q.queuedId } }
      const { queuedId } = await ports.queue.enqueue(root, q.text, { urgent: false })
      return { kind: 'done', result: { status: 'queued', queuedId } }
    }
    if (pre === null) {
      // Entered without a prebuild (the root looked resumable, and is not): prebuild now.
      if (lease !== null) return { kind: 'again', lease }
      const begun = beginLease(ports, box, q.origin)
      if ('refused' in begun)
        return { kind: 'done', result: { status: 'refused', code: begun.refused } }
      return { kind: 'again', lease: hold(box, begun) }
    }
    if (lease === null) throw new Error('send: a prebuild without its lease')
    const input: RoundInput = {
      sessionId: q.sessionId,
      text: 'text' in q ? q.text : null,
      queuedId: 'queuedId' in q ? q.queuedId : null,
      taken: null,
    }
    return { kind: 'done', result: await newRound(ports, box, input, lease, pre) }
  }

  /** An auto-send's turn: it holds the lease it began when the Run before it ended (「Run 结束」). */
  async function autoSendTurn(
    ports: LoopPorts,
    box: RootBox,
    input: RoundInput,
    lease: RunLease | null,
    pre: Prebuild | null,
  ): Promise<Turn<SendResult>> {
    if (lease === null || pre === null)
      throw new Error('auto-send: it holds its lease and prebuild')
    if (lease.signal.aborted) {
      await restoreTaken(ports, box, input.taken)
      return { kind: 'done', result: await abortedBeforeAppend(ports, box, lease) }
    }
    return { kind: 'done', result: await newRound(ports, box, input, lease, pre) }
  }

  async function newRound(
    ports: LoopPorts,
    box: RootBox,
    input: RoundInput,
    lease: RunLease,
    pre: Prebuild,
  ): Promise<SendResult> {
    const root = box.rootSessionId
    if (pre.kind === 'aborted') {
      await restoreTaken(ports, box, input.taken)
      return abortedBeforeAppend(ports, box, lease)
    }
    if (pre.kind === 'config') {
      // 「缺 key」: the queue stays as it was, taken items back in place.
      await restoreTaken(ports, box, input.taken)
      return configMissing(ports, box, input.sessionId, lease, pre)
    }
    let waiting: WaitingCall | null
    try {
      waiting = await waitingOf(tape, root)
    } catch (error) {
      // An auto-send's items go back before its lease does: what waits behind it finds the queue
      // as it was, in order (models/README: 排队消息…按规定次序发出).
      await restoreTaken(ports, box, input.taken)
      finish(box, lease)
      throw error
    }
    // A stop that came while the pause was read: it closes the pause, not this message.
    if (lease.signal.aborted) {
      await restoreTaken(ports, box, input.taken)
      return abortedBeforeAppend(ports, box, lease)
    }
    if (pre.kind === 'confirm') {
      // 「间接切公网」: 0 requests and no fact; the message waits in the queue for the menu's
      // confirmation (released by `session.selectModel`, plan step 19). An auto-send holds nothing
      // of its own: its items go back and `held` names no item.
      try {
        await restoreTaken(ports, box, input.taken)
        let queuedId: string | null = input.queuedId
        if (input.text !== null) {
          queuedId = (await ports.queue.enqueue(root, input.text, { urgent: false })).queuedId
        }
        box.held = { host: pre.host, queuedId }
        emit(ports, {
          type: 'queue-held',
          rootSessionId: root,
          sessionId: input.sessionId,
          host: pre.host,
        })
        // An auto-send answers no caller; a direct message or a send-now is `held` on its item.
        return queuedId === null
          ? { status: 'not-sent', code: 'config-missing' }
          : { status: 'held', queuedId }
      } finally {
        finish(box, lease)
      }
    }
    // What goes with this round: an auto-send's items; a send-now's item and those queued before
    // it; a direct message with everything queued before it (「从队列取什么」).
    let taken: readonly QueuedMessage[]
    if (input.taken !== null) taken = input.taken
    else if (input.queuedId !== null) {
      const target = (await ports.queue.peek(root)).find((item) => item.queuedId === input.queuedId)
      if (target === undefined) {
        finish(box, lease)
        return { status: 'not-found' }
      }
      taken = await ports.queue.take(root, { upToSeq: target.seq, urgentOnly: false })
    } else taken = await ports.queue.take(root, { upToSeq: null, urgentOnly: false })
    if (lease.signal.aborted) {
      await restoreTaken(ports, box, taken)
      return abortedBeforeAppend(ports, box, lease)
    }
    const messages: RoundMessage[] = [
      ...taken.map((item) => ({ text: item.text, queuedId: item.queuedId })),
      ...(input.text === null ? [] : [{ text: input.text, queuedId: null }]),
    ]
    let opened: OpenedRound
    try {
      if (waiting !== null) {
        // 取代: the card and the rest of its batch close as superseded, committed before any fact of
        // the new round — so the next request shows the model those results first (F11).
        const superseded = supersedeFacts(tape, now, waiting)
        await appendTo(waiting.sessionId, superseded)
        emitClosures(ports, box, waiting.sessionId, superseded, waiting)
      }
      opened = await openRound(ports, box, input.sessionId, messages, pre)
    } catch (error) {
      await restoreTaken(ports, box, taken)
      finish(box, lease)
      throw error
    }
    // A new round opened: whatever was held is no longer waiting on its own switch.
    clearHeld(ports, box, input.sessionId)
    startRun(ports, box, input.sessionId, opened, lease, pre.provider.id, () =>
      Promise.resolve(roundSetup(pre)),
    )
    return { status: 'started', runId: opened.runId }
  }

  /**
   * The pre-run batch, in ONE transaction: when the session does not exist yet, `session/start` with
   * the draft's profile, workspace and model choice (§会话事实「建会话」); the user's turns — the
   * queued ones first, in their order, each with a new `messageId` (01 修补 9 (q)(r)), then the direct
   * one — `run_started` naming the last, and `session/model_selected`. The draft goes once that batch
   * commits; a batch that fails leaves it.
   */
  async function openRound(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    messages: readonly RoundMessage[],
    pre: Extract<Prebuild, { kind: 'ready' }>,
  ): Promise<OpenedRound> {
    const { assembly, provider } = pre
    // A model that belongs to another provider is a programmer error, caught before anything is
    // written: past this point `session/model_selected` would advertise a pair nobody can encode.
    assertModelBelongs(assembly.model, provider.id)
    const head = await tape.head(sessionId)
    const incarnationId = head?.incarnationId ?? ids.uuid()
    const entries: NewEntry[] = []
    if (head === null) {
      entries.push(
        startEntry(sessionId, incarnationId),
        ...creationEntries({ tape, sessionId, incarnationId, now }, pre.draft),
      )
    }
    const written: Array<{ messageId: string; queuedId: string | null }> = []
    for (const message of messages) {
      const content = userTextContent(message.text)
      // A resend (01's retry rule, 01 修补 9 (r): only for a message that never queued, sent alone)
      // reuses the id and revision of the message it resends, so its append is the idempotent no-op.
      const resend =
        head === null || message.queuedId !== null || messages.length > 1
          ? null
          : // oxlint-disable-next-line no-await-in-loop -- only ever one message takes this path
            await resendOf(sessionId, content)
      const messageId = resend?.messageId ?? ids.uuid()
      const revision = resend?.revision ?? FIRST_REVISION
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
      )
      written.push({ messageId, queuedId: message.queuedId })
    }
    const last = written.at(-1)
    if (last === undefined) throw new Error('a new round opens with at least one message')
    const runId = ids.uuid()
    entries.push(
      ...runHead(sessionId, runId, { kind: 'user-message', messageId: last.messageId }, pre),
    )
    const opened = await appendOpening(ports, box, sessionId, runId, incarnationId, entries)
    if (head === null) drafts.delete(sessionId)
    for (const message of written) {
      emit(ports, {
        type: 'user-message',
        rootSessionId: box.rootSessionId,
        sessionId,
        runId,
        messageId: message.messageId,
        queuedId: message.queuedId,
      })
    }
    return { ...opened, openedBy: last.messageId }
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
    // Which provider and model THIS Run used, where its capabilities came from and where it sends.
    const selected: ModelSelectedPayload = {
      providerId: pre.provider.id,
      modelId: pre.assembly.model.id,
      capabilitySource: pre.assembly.capabilitySource,
      endpointOrigin: pre.assembly.endpointOrigin,
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
    box.runId = runId
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
      return { kind: 'done', result: await abortedBeforeAppend(ports, box, lease) }
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
      const begun = beginLease(ports, box, q.origin)
      if ('refused' in begun) return { kind: 'done', result: { status: 'refused' } }
      return { kind: 'again', lease: hold(box, begun) }
    }
    if (pre.kind === 'aborted')
      return { kind: 'done', result: await abortedBeforeAppend(ports, box, lease) }
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
    startRun(ports, box, q.sessionId, opened, lease, pre.provider.id, () =>
      Promise.resolve(roundSetup(pre)),
    )
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

  // ----- resumable roots (§启动恢复与发送防护「列出可续跑项，不跑」) -----------------------------------

  /**
   * A resumable root's resuming Run, opened in the mailbox (`resume`, and a send that comes first):
   * begun here when the command holds no lease, then `run_started{ resume }` and `model_selected`,
   * and the Run finishes the batch. Null when the root is not resumable, by the Tape. `aborted`
   * names the lease — the command's, or the one begun here — that was aborted before the append:
   * nothing was written, the root is still resumable, and the caller closes it by the cause
   * (「登记之后、append 之前被中止」).
   */
  async function resumeFirst(
    ports: LoopPorts,
    box: RootBox,
    origin: RunOrigin | null,
    held: RunLease | null,
  ): Promise<
    'started' | { aborted: RunLease } | { status: 'refused'; code: 'shutting-down' } | null
  > {
    const root = box.rootSessionId
    const item = resumables.get(root)
    if (item === undefined) return null
    const found = await resumableOf(tape, item.sessionId)
    if (found === null) {
      resumables.delete(root)
      return null
    }
    // A stop that reached the command's lease while the Tape was read: the command writes the stop
    // instead (「登记之后、append 之前被中止」).
    if (held?.signal.aborted === true) return { aborted: held }
    let lease = held
    if (lease === null) {
      const begun = beginLease(ports, box, origin)
      if ('refused' in begun) return { status: 'refused', code: begun.refused }
      lease = hold(box, begun)
    }
    let opened: string | null
    try {
      opened = await openResumed(
        ports,
        box,
        item.sessionId,
        lease,
        { pausedRunId: found.pausedRunId, batch: found.batch },
        found.setup,
        { ...found.batch, calls: found.rest, approved: null },
        [],
      )
    } catch (error) {
      // Nothing was written: the Tape still says resumable, and so does the set — a later resume or
      // send resumes it (models/model2: resumable-missing-from-set).
      finish(box, lease)
      throw error
    }
    // Aborted before the append — a lease begun for a window already closed is aborted at once — so
    // nothing names the root yet, and it stays in the set.
    if (opened === null) return { aborted: lease }
    // Out of the set in the task that wrote the `run_started{ resume }` naming it, once it did
    // (§主进程与 kernel 的循环接口「recover」).
    resumables.delete(root)
    return 'started'
  }

  /**
   * 可续跑的会话里停止 (§每种答复同批写什么): a Run that sends nothing — its `run_started{ resume }`,
   * the rest of the batch not-run / `stopped`, and `run_terminal{ user-stopped }` in one append — and
   * the root is no longer resumable. `held` is the command's own, already aborted, lease; without one
   * the stop begins its own (origin null). True when it stopped, false when the host refused a lease,
   * null when the root is not resumable.
   */
  async function stopResumable(
    ports: LoopPorts,
    box: RootBox,
    held: RunLease | null,
  ): Promise<boolean | null> {
    const root = box.rootSessionId
    const item = resumables.get(root)
    if (item === undefined) return null
    const found = await resumableOf(tape, item.sessionId)
    if (found === null) {
      resumables.delete(root)
      return null
    }
    let lease = held
    if (lease === null) {
      const begun = beginLease(ports, box, null)
      if ('refused' in begun) return false
      lease = hold(box, begun)
    }
    const runId = ids.uuid()
    const writer: FactWriter = { by: 'run', runId }
    const reason: RunEndReason = { code: 'user-stopped' }
    const terminal: RunTerminalPayload = { reason, steps: 0, usage: [], writer }
    const closures = found.rest.flatMap((call) =>
      notRunFacts({
        tape,
        now,
        call: {
          ...found.batch,
          ordinal: call.ordinal,
          providerToolCallId: call.providerToolCallId,
        },
        source: 'stopped',
        writer,
      }),
    )
    try {
      await appendTo(item.sessionId, [
        ...resumeHead({
          tape,
          now,
          sessionId: item.sessionId,
          runId,
          paused: { pausedRunId: found.pausedRunId, batch: found.batch },
          selected: null,
        }),
        ...closures,
        executionSlice.entry('execution/run_terminal', {
          sourceType: 'runtime_event',
          sourceId: runId,
          provenanceKey: runTerminalKey(runId),
          payload: terminal,
          createdAt: now(),
        }),
      ])
    } finally {
      finish(box, lease)
    }
    resumables.delete(root)
    emit(ports, { type: 'run-started', rootSessionId: root, sessionId: item.sessionId, runId })
    emitClosures(ports, box, item.sessionId, closures)
    runEnded(ports, box, item.sessionId, {
      runId,
      reason,
      recorded: true,
      lastStop: null,
      errorCode: null,
      retryOf: null,
    })
    return true
  }

  // ----- answers (§等待模型：审批、提问与拒绝; §续跑) --------------------------------------------------

  async function answerTurn(
    ports: LoopPorts,
    box: RootBox,
    q: AnswerCommand & { origin: RunOrigin | null },
    held: RunLease | null,
  ): Promise<AnswerResult> {
    let lease = held
    try {
      if (lease !== null && lease.signal.aborted) return await abortedAnswer(ports, box, lease)
      const target = await answerTarget(tape, q)
      if (typeof target === 'string') {
        // A stop that aborted this answer's lease while the Tape was read was promised a close by
        // the holder (「停止」: 有活租约就 abort; 「登记之后、append 之前被中止」): the card still
        // waiting — a newer one than this answer named — is cancelled in its name.
        if (lease !== null && lease.signal.aborted) return await abortedAnswer(ports, box, lease)
        if (lease !== null) finish(box, lease)
        return { status: target }
      }
      if (q.kind === 'question') {
        // A question can only be waiting once AskUserQuestion pauses a Run (plan step 26).
        throw new Error('answering a question is plan step 26')
      }
      if (lease === null) {
        // Its turn opens a Run, and it holds no lease: begun here, in the mailbox (「租约」).
        const begun = beginLease(ports, box, q.origin)
        if ('refused' in begun) return { status: 'refused' }
        lease = hold(box, begun)
      }
      return q.decision === 'deny'
        ? await rejectCard(ports, box, target, lease)
        : await allowCard(ports, box, target, lease)
    } catch (error) {
      if (lease !== null && box.lease === lease) finish(box, lease)
      throw error
    }
  }

  /**
   * An answer whose lease was aborted before it appended (「登记之后、append 之前被中止」): a user-stop
   * cancels the card in this answer's name and it reads `already-resolved`; a quit or a closed window
   * writes nothing, the card survives the restart (B4), and the answer is `refused`.
   */
  async function abortedAnswer(
    ports: LoopPorts,
    box: RootBox,
    lease: RunLease,
  ): Promise<AnswerResult> {
    const stopped = abortCauseOf(lease) === 'user-stop'
    try {
      if (stopped) await closePausedByStop(ports, box)
    } finally {
      finish(box, lease)
    }
    return { status: stopped ? 'already-resolved' : 'refused' }
  }

  /**
   * 主会话里拒绝 (§每种答复同批写什么): no re-judgement; the resolution, this call and the rest of the
   * batch not-run / `user-rejected`, and a Run that ends at once as `user-rejected` — one append.
   */
  async function rejectCard(
    ports: LoopPorts,
    box: RootBox,
    waiting: WaitingCall,
    lease: RunLease,
  ): Promise<AnswerResult> {
    const frozen = await frozenBatchOf(tape, waiting)
    if (lease.signal.aborted) return abortedAnswer(ports, box, lease)
    const runId = ids.uuid()
    const { entries, reason } = rejectFacts({
      tape,
      now,
      sessionId: waiting.sessionId,
      runId,
      waiting,
      toolName: frozen.item?.originalName ?? waiting.call.name,
    })
    await appendTo(waiting.sessionId, entries)
    // The queued messages go out after a `user-rejected` end (「从队列取什么」).
    const taken = await takeAfterEnd(ports, box, reason, lease)
    const origin = autoSendOrigin(box, lease, taken)
    finish(box, lease)
    emit(ports, {
      type: 'run-started',
      rootSessionId: box.rootSessionId,
      sessionId: waiting.sessionId,
      runId,
    })
    emitClosures(ports, box, waiting.sessionId, entries, waiting)
    runEnded(ports, box, waiting.sessionId, {
      runId,
      reason,
      recorded: true,
      lastStop: null,
      errorCode: null,
      retryOf: null,
    })
    autoSend(ports, box, waiting.sessionId, taken, origin)
    return { status: 'applied' }
  }

  /**
   * 允许 (§每种答复同批写什么): judged again first, and only ever tighter (F3). Still allowed — or an
   * ask whose card is unchanged — writes the resolution with the new Run's head and resumes the batch
   * with this call; tightened to a denial, the call closes with its block and the Run resumes the rest;
   * an ask whose card changed writes only the re-judgement, answers `stale` and shows the new card.
   */
  async function allowCard(
    ports: LoopPorts,
    box: RootBox,
    waiting: WaitingCall,
    lease: RunLease,
  ): Promise<AnswerResult> {
    const frozen = await frozenBatchOf(tape, waiting)
    const resolver: FactWriter = { by: 'resolver' }
    const { item } = frozen
    const rejudged = await rejudgeWaiting({
      judge: {
        tape,
        host: deps.host,
        inspectors: deps.inspectors,
        protectedFiles: deps.protectedFiles,
        userSetting: deps.userSetting,
        signal: lease.signal,
      },
      waiting,
      item,
      testTools: deps.testTools,
    })
    if (rejudged.kind === 'stopped' || lease.signal.aborted) return abortedAnswer(ports, box, lease)
    let facts: NewEntry[]
    let resume: ResumeBatch
    const rest: ResumeBatch = {
      runId: waiting.ref.runId,
      requestSeq: waiting.ref.requestSeq,
      calls: waiting.rest,
      approved: null,
    }
    if (rejudged.kind === 'unavailable' || rejudged.kind === 'denied') {
      // Tightened: the call closes, and the new Run handles the rest of the batch.
      facts = tightenedFacts({ tape, now, waiting, rejudged, writer: resolver })
      resume = rest
    } else if (rejudged.kind === 'changed') {
      // Still asks, but about something else: a new card, and the old one's click is stale.
      const decided = rejudgeDecisionOf({
        tape,
        now,
        waiting,
        judged: rejudged.judged,
        writer: resolver,
      })
      await appendTo(waiting.sessionId, [decided])
      // A stop that landed while the re-judgement committed: 暂停中停止 closes the new card, which
      // never shows; a quit or a closed window leaves it for the restart (B4), as a pause does.
      if (lease.signal.aborted) return abortedAnswer(ports, box, lease)
      finish(box, lease)
      const card = cardOfEntries(waiting.sessionId, [decided])
      if (card !== null) deliver(card)
      return { status: 'stale' }
    } else {
      // Allowed as answered: a verdict that loosened since is not taken (F3).
      const { judged } = rejudged
      if (item === undefined) throw new Error('allow: an unchanged judgement has its table item')
      const scope = answerScope({
        decision: { record: waiting.decision.record, summary: waiting.decision.summary },
        reversibility: waiting.decision.reversibility,
        ...(judged.place === undefined ? {} : { place: judged.place }),
        source: item.source === 'mcp' ? 'mcp' : 'builtin',
        toolName: item.originalName,
      })
      const object = judged.grantObject ?? {
        kind: 'call' as const,
        argsHash: waiting.call.argsHash,
      }
      facts = [
        resolvedEntry({
          tape,
          now,
          waiting,
          outcome: 'allowed',
          via: 'card',
          grant: { scope, key: grantKey(item.serverId, item.originalName, object) },
          writer: resolver,
        }),
      ]
      resume = {
        ...rest,
        calls: [waiting.call, ...waiting.rest],
        approved: {
          ordinal: waiting.ref.ordinal,
          decisionKey: waiting.decisionKey,
          summary: waiting.decision.summary,
          reversibility: waiting.decision.reversibility,
        },
      }
    }
    if (lease.signal.aborted) return abortedAnswer(ports, box, lease)
    const opened = await openResumed(
      ports,
      box,
      waiting.sessionId,
      lease,
      pausedBatchOf(waiting),
      frozen.setup,
      resume,
      facts,
      waiting,
    )
    if (opened === null) return abortedAnswer(ports, box, lease)
    return { status: 'applied' }
  }

  /**
   * Opens a Run that resumes a paused batch (an answer, `resume`, a send in a resumable session):
   * the facts that cause it and its head in one append, then the Run, assembled outside the mailbox.
   * Null, with nothing written, when the lease was aborted before the append: at its begin, or by a
   * stop while the head was read (「登记之后、append 之前被中止」).
   */
  async function openResumed(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    lease: RunLease,
    paused: PausedBatch,
    setup: ResumeSetup,
    resume: ResumeBatch,
    facts: readonly NewEntry[],
    /** The answered call, when an answer opens it: its closures name that card, as the redraw does. */
    answered: WaitingCall | null = null,
  ): Promise<string | null> {
    const runId = ids.uuid()
    const head = await tape.head(sessionId)
    if (head === null) throw new Error(`resume: session ${sessionId} has no head`)
    if (lease.signal.aborted) return null
    const opened = await appendOpening(ports, box, sessionId, runId, head.incarnationId, [
      ...facts,
      // The paused Run's model and capabilities; where it sends now, by the synchronous read.
      ...resumeHead({
        tape,
        now,
        sessionId,
        runId,
        paused,
        selected: {
          ...setup.selected,
          ...originNow(setup.selected.providerId, setup.selected.endpointOrigin),
        },
      }),
    ])
    emitClosures(ports, box, sessionId, facts, answered)
    startRun(ports, box, sessionId, opened, lease, setup.selected.providerId, () =>
      resumeSetup(box, sessionId, lease, setup, resume),
    )
    return runId
  }

  /**
   * A resuming Run's setup (§续跑), outside the mailbox: the frozen model, max tokens and effort, and
   * an `assemble` for the search backend and the connector sources. `provider()` is called at the
   * first request only, so a missing key never loses the results of calls already run. A stop while
   * `assemble` hangs is not waited for: the Run starts with nothing assembled and closes as stopped.
   */
  async function resumeSetup(
    box: RootBox,
    sessionId: string,
    lease: RunLease,
    setup: ResumeSetup,
    resume: ResumeBatch,
  ): Promise<RunSetup> {
    const choice: ModelChoice = {
      providerId: setup.selected.providerId,
      modelId: setup.selected.modelId,
      effort: setup.effort,
      capabilitySource: setup.selected.capabilitySource ?? 'builtin',
    }
    const assembling = connector.assemble({
      sessionId,
      rootSessionId: box.rootSessionId,
      choice,
      signal: lease.signal,
    })
    assembling.catch(() => undefined)
    const assembly = await Promise.race([
      assembling,
      whenAborted(lease.signal).then((): RunAssembly => stoppedAssembly(setup)),
    ])
    let built: Provider | undefined
    const { profile } = await readSessionFacts(tape, sessionId)
    return {
      provider: () => (built ??= assembly.provider()),
      profile,
      model: setup.model,
      maxTokens: setup.maxTokens,
      effort: setup.effort,
      assembly,
      resume,
    }
  }

  /**
   * The Run itself, outside the mailbox (`driveRun`); every fact it writes comes back in as a task.
   * Its end is one more task: `run_terminal` — with a paused decision in the same batch (同批规则 1)
   * — then the lease finished, then `run-ended`. Whatever goes wrong, the lease is finished and
   * `run-ended` is sent: a Run that could not record its end says `recorded: false`.
   *
   * `setup` is what the Run is built from: a new round's prebuild, ready at once, or — for a Run an
   * answer opened — the paused batch's frozen facts and an `assemble` called here, outside the mailbox
   * (§主进程与 kernel 的循环接口「续跑」).
   */
  function startRun(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    opened: OpenedRound,
    lease: RunLease,
    providerId: ProviderId,
    setup: () => Promise<RunSetup>,
  ): void {
    const { runId, incarnationId } = opened
    const root = box.rootSessionId
    const events: RunDriverContext['emit'] = {
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
    }
    // Whether any of this Run's calls went out: a Run that dispatched one is not 「重试」's to resend.
    let dispatched = false
    void (async (): Promise<void> => {
      let finished: RunFinish | null = null
      let failure: unknown = null
      try {
        const built = await setup()
        finished = await driveRun({
          tape,
          ids,
          now,
          log,
          host: deps.host,
          sessionId,
          incarnationId,
          runId,
          pin: opened.contextAtEntryId,
          provider: built.provider,
          model: built.model,
          maxTokens: built.maxTokens,
          effort: built.effort,
          toolsWithheld: built.assembly.toolsWithheld,
          search: built.assembly.search,
          mcpSources: built.assembly.mcpSources,
          inspectors: deps.inspectors,
          protectedFiles: deps.protectedFiles,
          userSetting: deps.userSetting,
          testTools: deps.testTools,
          tokenLimit: deps.tokenLimit,
          lease,
          openTable: () => openTable(incarnationId, built.assembly, built.profile),
          // A write task that finds its lease aborted writes no decision, no dispatch and no closure
          // of a call found unusable (§主进程与 kernel 的循环接口「mailbox」): the batch closes the
          // call as stopped instead.
          write: (entries) =>
            post(box, 'run', null, async () => {
              if (lease.signal.aborted && entries.some(isRefusedAfterStop)) {
                throw new RunWriteRefusedError()
              }
              const written = await appendFirstWins(sessionId, incarnationId, entries)
              if (written.entries.some((entry) => entry.name === 'execution/dispatch_committed')) {
                dispatched = true
              }
              return written
            }),
          onUnansweredCall: deps.onUnansweredCall,
          ...(built.resume === undefined ? {} : { resume: built.resume }),
          locale: () => ports.locale({ sessionId }),
          localDate: () => ports.localDate({ sessionId }),
          insertQueued: () =>
            post(box, 'run', null, () =>
              insertAtBoundary(ports, box, sessionId, incarnationId, lease, runId),
            ),
          emit: events,
        })
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
            reason: failedEndReason(providerId),
            recorded: false,
            lastStop: null,
            errorCode: 'unknown',
            retryOf: null,
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
        // 「重试」 resends its opener as that same message only while it is still the last one (01
        // spec.md:395): once a reply or an inserted message followed it, a resend would duplicate it.
        // Read here, before the finish: from the finish to the auto-send nothing may await. A store
        // closed by an exit answers nothing, and no 「重试」 is offered.
        const stillLast =
          recorded &&
          opened.openedBy !== undefined &&
          (await tape.listMessages({ sessionId, limit: 1 }).then(
            ([last]) => last?.messageId === opened.openedBy,
            () => false,
          ))
        // 「从队列取什么」, between the terminal and the finish, in this same task.
        const taken = recorded ? await takeAfterEnd(ports, box, end.reason, lease) : []
        let card: ConfirmRequest | null = null
        if (recorded && end.reason.code === 'paused') {
          if (lease.stopRequested) {
            // A stop that reached the pause while it committed: 暂停中停止, in this same task
            // (「Run 结束」). The card never shows; `run-ended` still says `paused`.
            await closePausedByStop(ports, box)
          } else if (!lease.signal.aborted) {
            card = cardOfEntries(sessionId, end.entries)
          }
          // A quit or a closed window writes nothing more: the card survives the restart (B4).
        }
        const origin = autoSendOrigin(box, lease, taken)
        finish(box, lease)
        if (recorded) emitClosures(ports, box, sessionId, end.entries)
        runEnded(ports, box, sessionId, {
          runId,
          reason: end.reason,
          recorded,
          lastStop: finished.lastStop,
          errorCode: end.aborted ? null : finished.errorCode,
          retryOf: stillLast ? retryOf(opened, dispatched) : null,
        })
        // In the same synchronous stretch as the finish: nothing else takes the root in between.
        autoSend(ports, box, sessionId, taken, origin)
        // Delivered once the pause is on the Tape (§答复与投递「投递」); the renderer also pulls it.
        if (card !== null) deliver(card)
      })
    })()
  }

  /**
   * The queued messages at a batch boundary (§插话与输入框状态表「写入时点」): taken and written as
   * this turn's `message/user` facts, each with a new `messageId`, after the batch's results. A Run
   * stopped first takes nothing; one stopped while the queue answered puts it all back.
   */
  async function insertAtBoundary(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    incarnationId: string,
    lease: RunLease,
    runId: string,
  ): Promise<Written | null> {
    if (lease.signal.aborted) return null
    const root = box.rootSessionId
    const items = await ports.queue.take(root, { upToSeq: null, urgentOnly: false })
    if (items.length === 0) return null
    if (lease.signal.aborted) {
      await ports.queue.restore(root, items)
      return null
    }
    const inserted = items.map((item) => ({ item, messageId: ids.uuid() }))
    const entries = inserted.map(({ item, messageId }) => {
      const payload: TapeUserMessagePayload = {
        messageId,
        revision: FIRST_REVISION,
        role: 'user',
        content: [...userTextContent(item.text)],
        status: 'complete',
      }
      return messageSlice.entry('message/user', {
        sourceType: 'message',
        sourceId: messageId,
        sourceSeq: FIRST_REVISION,
        provenanceKey: messageRevisionKey(messageId, FIRST_REVISION),
        payload,
        createdAt: now(),
      })
    })
    let receipts: readonly AppendResult[]
    try {
      receipts = await tape.appendEntries({ sessionId, incarnationId, entries })
    } catch (error) {
      // Not written, so not inserted: back in the queue, in their order, before the Run fails
      // (models/README: 排队消息不丢).
      await ports.queue.restore(root, items)
      throw error
    }
    for (const { item, messageId } of inserted) {
      emit(ports, {
        type: 'user-message',
        rootSessionId: root,
        sessionId,
        runId,
        messageId,
        queuedId: item.queuedId,
      })
    }
    if (box.held !== null && items.some((item) => item.queuedId === box.held?.queuedId)) {
      clearHeld(ports, box, sessionId)
    }
    return { entries, receipts }
  }

  /**
   * 「从队列取什么」 once a terminal committed: everything after `completed` and `user-rejected`, the
   * urgent items after `user-stopped` and a closed window's `shutdown-aborted`, nothing otherwise. A
   * stop that reached the lease meanwhile is read again by its cause; what was taken too many goes
   * back (the committed terminal still names the `run-ended`).
   */
  async function takeAfterEnd(
    ports: LoopPorts,
    box: RootBox,
    reason: RunEndReason,
    lease: RunLease,
  ): Promise<readonly QueuedMessage[]> {
    const root = box.rootSessionId
    const rule = takeRuleOf(reason)
    if (rule === 'none') return []
    const items = await ports.queue.take(root, { upToSeq: null, urgentOnly: rule === 'urgent' })
    if (
      !lease.signal.aborted ||
      reason.code === 'user-stopped' ||
      reason.code === 'shutdown-aborted'
    ) {
      return items
    }
    const cause = abortCauseOf(lease)
    const keep = cause === 'quit' ? [] : items.filter((item) => item.urgent)
    const back = items.filter((item) => !keep.includes(item))
    if (back.length > 0) await ports.queue.restore(root, back)
    return keep
  }

  /**
   * 自动发出 (「Run 结束」): a new lease begun at once for the items the ended Run took, then the new
   * round's prebuild and its turn. A refused lease, a failed prebuild or a switch to confirm puts
   * the items back, no longer urgent (owner 2026-09-25).
   */
  function autoSend(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    taken: readonly QueuedMessage[],
    origin: RunOrigin | null,
  ): void {
    if (taken.length === 0) return
    const begun = beginLease(ports, box, origin)
    if ('refused' in begun) {
      void restoreTaken(ports, box, taken)
      return
    }
    const lease = hold(box, begun)
    const input: RoundInput = { sessionId, text: null, queuedId: null, taken }
    void commandFrom(box, sessionId, lease, prebuild(sessionId, box, lease), (held, pre) =>
      autoSendTurn(ports, box, input, held, pre),
    ).catch((error: unknown) => {
      void restoreTaken(ports, box, taken)
      log(`[loop] ${box.rootSessionId}: the queued messages were not sent: ${describe(error)}`)
    })
  }

  /** A card to the host, after its facts committed; a host that fails only reaches the log. */
  function deliver(card: ConfirmRequest): void {
    void deps.host.confirm.request(card).catch((error: unknown) => {
      log(`[loop] the card ${card.requestId} was not delivered: ${describe(error)}`)
    })
  }

  /** `tool-outcome` for each closure a mailbox task committed — after the commit, never before. */
  /**
   * Announces the closures a mailbox task wrote (§工具调用的收口). The view is the one a redraw builds
   * from the same facts (calls.ts): the closure's own `facts`; the decision in force — one this batch
   * wrote (a re-judgement), else the waiting call's — so a live BlockedNotice has its slots; and the
   * answer this batch resolved, so the answered row reads the same live and after a restart.
   */
  function emitClosures(
    ports: LoopPorts,
    box: RootBox,
    sessionId: string,
    entries: readonly NewEntry[],
    waiting: WaitingCall | null = null,
  ): void {
    const decided = new Map<string, PermissionDecidedPayload>()
    if (waiting !== null) {
      decided.set(
        callKeyOf(waiting.ref.runId, waiting.ref.requestSeq, waiting.ref.ordinal),
        waiting.decision,
      )
    }
    const resolved = new Map<string, ApprovalResolvedPayload>()
    for (const entry of entries) {
      if (entry.name === 'tool/permission_decided') {
        decided.set(callOfFact(entry), entry.payload as unknown as PermissionDecidedPayload)
      } else if (entry.name === 'tool/approval_resolved') {
        resolved.set(callOfFact(entry), entry.payload as unknown as ApprovalResolvedPayload)
      }
    }
    for (const result of entries) {
      if (result.name !== 'tool/result') continue
      const key = callOfFact(result)
      const outcome = entries.find(
        (entry) => entry.name === 'execution/tool_outcome' && callOfFact(entry) === key,
      )?.payload
      const source = (outcome?.['source'] ?? null) as ClosureSource | null
      if (outcome === undefined || source === null) continue
      const facts = outcome['facts'] as Record<string, string> | undefined
      const permission = decided.get(key)?.summary
      const resolution = resolved.get(key)
      // The card the answer named: the waiting call's decision, as calls.ts reads it by `decisionKey`.
      const target =
        resolution === undefined
          ? undefined
          : resolution.decisionKey === waiting?.decisionKey
            ? waiting.decision.confirm?.target
            : decided.get(key)?.confirm?.target
      emit(ports, {
        type: 'tool-outcome',
        rootSessionId: box.rootSessionId,
        sessionId,
        callKey: key,
        providerToolCallId: String(result.payload['providerToolCallId']),
        outcome: {
          ...notRunView(source, [result]),
          ...(facts === undefined ? {} : { facts: { ...facts } }),
          ...(permission === undefined ? {} : { permission }),
          ...(resolution === undefined || target === undefined
            ? {}
            : { approval: approvalOf(resolution, target) }),
        },
      })
    }
  }

  /** Appends one mailbox task's batch to a session, in its current incarnation. */
  async function appendTo(
    sessionId: string,
    entries: readonly NewEntry[],
  ): Promise<readonly AppendResult[]> {
    const head = await tape.head(sessionId)
    if (head === null) throw new Error(`append: session ${sessionId} has no head`)
    return tape.appendEntries({ sessionId, incarnationId: head.incarnationId, entries })
  }

  /**
   * 暂停中停止 (§每种答复同批写什么): the card this root waits on is cancelled, its call and the rest of
   * its batch close not-run / `stopped`, and no Run opens. True when there was a card.
   */
  async function closePausedByStop(ports: LoopPorts, box: RootBox): Promise<boolean> {
    const waiting = await waitingOf(tape, box.rootSessionId)
    if (waiting === null) return false
    const entries = stopFacts(tape, now, waiting)
    await appendTo(waiting.sessionId, entries)
    emitClosures(ports, box, waiting.sessionId, entries, waiting)
    return true
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
   * instead: neither the paused decision nor the end's own closures (a limit's, a truncation's) are
   * written, and the calls they covered close not-run / `stopped`, as a stop while judging would
   * have (§主进程与 kernel 的循环接口「mailbox」; §点停止时各状态怎么收). `aborted` says the reason was
   * replaced: no error event ended the Run then (run-ended `errorCode`).
   */
  function terminalOf(
    finished: RunFinish,
    lease: RunLease,
    runId: string,
  ): { reason: RunEndReason; entries: NewEntry[]; aborted: boolean } {
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
    return { reason, entries, aborted }
  }

  /**
   * Opens this provider's table for the generation (§开表与排除): the profile's builtin candidates
   * and every connector tool of the Run's MCP sources, with one reading of the policy (D4).
   * Compaction (step 30) is what makes a generation other than 0.
   */
  async function openTable(
    incarnationId: string,
    assembly: RunAssembly,
    profile: Profile,
  ): Promise<{ table: FrozenToolTable; policy: PolicyState }> {
    const policy = deps.host.policy.current()
    const candidates = [
      ...builtinCandidates({
        profile,
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
    prebuilds = true,
  ): Promise<T> {
    if (!canBeginAtEntry(box)) return commandFrom(box, q.sessionId, null, null, turn)
    const begun = beginLease(ports, box, q.origin)
    if ('refused' in begun) {
      dropIfIdle(box)
      return Promise.resolve(refused(begun.refused))
    }
    const lease = hold(box, begun)
    const prebuilt = prebuilds ? prebuild(q.sessionId, box, lease) : null
    return commandFrom(box, q.sessionId, lease, prebuilt, turn)
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
    let judged: Turn<T>
    try {
      judged = await post(box, 'command', lease, () => turn(lease, pre))
    } catch (error) {
      // A turn that failed before its Run opened (a read of the Tape or the queue that threw): the
      // lease it holds — the one it came in with, or one it began in the mailbox — is finished here,
      // or the root would wait on it for good (「租约」: 最后没开 Run 的就 finish; models: 没有死锁).
      // While this turn ran nobody else could begin one, so an unopened live lease is this one's.
      if (box.lease !== null && !box.runOpen) finish(box, box.lease)
      throw error
    }
    if (judged.kind === 'done') return judged.result
    // Began in the mailbox: out to prebuild, and in again. Nothing is written in between.
    return commandFrom(box, sessionId, judged.lease, prebuild(sessionId, box, judged.lease), turn)
  }

  /**
   * Where the session's history last went (§模型选择「数据去向」): the latest Run's recorded origin.
   * A row written before plan step 19 recorded one has none; where its provider sends now is the
   * nearest reading there is, and without it such a session — Ollama's history, say — would reach a
   * public host with no confirmation.
   */
  function previousOriginOf(facts: SessionFacts): string | null {
    const last = facts.lastSelected
    if (last === null) return null
    return last.endpointOrigin ?? connector.endpointOrigin(last.providerId)
  }

  /** `connector.endpointOrigin` for a resumed Run's `model_selected`, or what the paused Run had. */
  function originNow(
    providerId: ProviderId,
    before: string | undefined,
  ): { endpointOrigin?: string } {
    const origin = connector.endpointOrigin(providerId) ?? before
    return origin === undefined ? {} : { endpointOrigin: origin }
  }

  // ----- the home page's choices (§会话形态「建立前暂存」, §工作区) ---------------------------------

  /**
   * One menu choice, in the root's mailbox (§会话事实「写入」): `<n>` counted from the Tape here, so
   * two quick choices never share one; before the session exists, into the draft (a chat draft if
   * there was none). Then whatever a public host held is released.
   */
  async function selectModelTurn(
    ports: LoopPorts,
    box: RootBox,
    q: SelectModelQuery,
  ): Promise<{ readonly profile: Profile }> {
    const facts = await readSessionFacts(tape, q.sessionId)
    let profile: Profile
    const head = facts.established ? await tape.head(q.sessionId) : null
    if (head !== null) {
      await tape.appendEntries({
        sessionId: q.sessionId,
        incarnationId: head.incarnationId,
        entries: [
          modelChoiceEntry(
            { tape, sessionId: q.sessionId, incarnationId: head.incarnationId, now },
            facts.modelChoiceFacts,
            q.choice,
          ),
        ],
      })
      profile = facts.profile
    } else {
      const draft = drafts.get(q.sessionId)
      const next: SessionDraft =
        draft === null
          ? { profile: 'chat', modelChoice: q.choice }
          : { ...draft, modelChoice: q.choice }
      drafts.set(q.sessionId, next)
      profile = next.profile
    }
    await releaseHeld(ports, box, q.origin)
    return { profile }
  }

  /**
   * 「间接切公网」: any choice in the root releases what was held. With no Run left to finish, the held
   * message and those queued before it (all of them, when an auto-send was held) open a new round,
   * begun with the chooser's origin; a held message no longer queued only clears the hold.
   */
  async function releaseHeld(
    ports: LoopPorts,
    box: RootBox,
    origin: RunOrigin | null,
  ): Promise<void> {
    const held = box.held
    if (held === null) return
    const root = box.rootSessionId
    clearHeld(ports, box, root)
    if (box.lease !== null) return
    let taken: readonly QueuedMessage[]
    if (held.queuedId === null) {
      taken = await ports.queue.take(root, { upToSeq: null, urgentOnly: false })
    } else {
      const target = (await ports.queue.peek(root)).find((item) => item.queuedId === held.queuedId)
      if (target === undefined) return
      taken = await ports.queue.take(root, { upToSeq: target.seq, urgentOnly: false })
    }
    autoSend(ports, box, root, taken, origin)
  }

  /** A session's profile and workspace as a route shows them: the Tape's, or the draft's. */
  async function factsView(sessionId: string): Promise<SessionFactsView> {
    const facts = await readSessionFacts(tape, sessionId)
    if (facts.established) {
      return {
        established: true,
        drafted: false,
        profile: facts.profile,
        workspace: facts.workspace,
        lastEndpointOrigin: previousOriginOf(facts),
      }
    }
    const draft = drafts.get(sessionId)
    return {
      established: false,
      drafted: draft !== null,
      profile: draft?.profile ?? 'chat',
      workspace: draft?.profile === 'cowork' ? draft.workspace : null,
      lastEndpointOrigin: null,
    }
  }

  /** The dedicated folder as the workspace: resolved like any root, though it may not exist yet (D8). */
  async function dedicatedWorkspace(dedicated: AbsolutePath): Promise<WorkspaceSetPayload> {
    return { folders: [(await resolvePath(deps.host.fs, dedicated)).path], origin: 'dedicated' }
  }

  async function selectProfileTurn(q: SelectProfileQuery): Promise<SelectProfileResult> {
    if ((await readSessionFacts(tape, q.sessionId)).established) {
      return { ok: false, code: 'established' }
    }
    const draft = drafts.get(q.sessionId)
    const modelChoice = draft?.modelChoice ?? null
    let next: SessionDraft
    if (q.profile === 'chat') next = { profile: 'chat', modelChoice }
    else if (draft?.profile === 'cowork') next = draft
    else {
      // Back to cowork starts from the dedicated folder; what was chosen before stays in the prefill.
      next = { profile: 'cowork', workspace: await dedicatedWorkspace(q.dedicated), modelChoice }
    }
    drafts.set(q.sessionId, next)
    return { ok: true, ...(await factsView(q.sessionId)) }
  }

  /**
   * The next list (§工作区「来源」「中途增删」): new folders after the ones picked before — the dedicated
   * folder gives way to them — or the list without the one removed, back to the dedicated folder once
   * it is empty. Null when nothing changes.
   */
  async function nextWorkspace(
    current: WorkspaceSetPayload,
    change: WorkspaceChange,
    dedicated: AbsolutePath,
  ): Promise<WorkspaceSetPayload | 'not-in-list' | null> {
    const picked = current.origin === 'picked' ? current.folders : []
    if (change.kind === 'remove') {
      if (!picked.includes(change.folder as AbsolutePath)) return 'not-in-list'
      const rest = picked.filter((folder) => folder !== change.folder)
      return rest.length === 0 ? dedicatedWorkspace(dedicated) : { folders: rest, origin: 'picked' }
    }
    const added: AbsolutePath[] = []
    for (const folder of change.folders) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of folders, each resolved once
      const real = (await resolvePath(deps.host.fs, folder)).path
      if (!picked.includes(real) && !added.includes(real)) added.push(real)
    }
    if (added.length === 0) return null
    return { folders: [...picked, ...added], origin: 'picked' }
  }

  async function setWorkspaceTurn(q: {
    sessionId: string
    change: WorkspaceChange
    dedicated: AbsolutePath
  }): Promise<WorkspaceResult> {
    const facts = await readSessionFacts(tape, q.sessionId)
    const draft = facts.established ? null : drafts.get(q.sessionId)
    if (!facts.established && draft === null) return { ok: false, code: 'unknown-session' }
    // A sub-agent has no chip: it reads its parent's workspace and cannot change it (§子 agent 契约).
    const cowork = facts.established
      ? facts.profile === 'cowork' && facts.subagentOf === null
      : draft?.profile === 'cowork'
    const current = facts.established
      ? facts.workspace
      : draft?.profile === 'cowork'
        ? draft.workspace
        : null
    if (!cowork || current === null) return { ok: false, code: 'not-cowork' }
    const next = await nextWorkspace(current, q.change, q.dedicated)
    if (next === 'not-in-list') return { ok: false, code: 'not-in-list' }
    if (next === null) return { ok: true, folders: current.folders, origin: current.origin }
    if (draft?.profile === 'cowork') drafts.set(q.sessionId, { ...draft, workspace: next })
    else {
      const head = await tape.head(q.sessionId)
      if (head === null) return { ok: false, code: 'unknown-session' }
      await tape.appendEntries({
        sessionId: q.sessionId,
        incarnationId: head.incarnationId,
        entries: [
          workspaceEntry(
            { tape, sessionId: q.sessionId, incarnationId: head.incarnationId, now },
            facts.workspaceFacts,
            next,
          ),
        ],
      })
    }
    return { ok: true, folders: next.folders, origin: next.origin }
  }

  return {
    bind(ports): void {
      if (bound !== null) throw new Error('bindLoop: the loop is already bound')
      bound = ports
    },

    sessionFacts(q): Promise<SessionFactsView> {
      if (!isCanonicalUuid(q.sessionId)) {
        return Promise.reject(
          new TypeError(`sessionFacts: "${q.sessionId}" is not a canonical UUID`),
        )
      }
      return factsView(q.sessionId)
    },

    selectModel(q): Promise<{ readonly profile: Profile }> {
      const ports = bound
      if (ports === null) return Promise.reject(new Error('selectModel() before bindLoop()'))
      if (!isCanonicalUuid(q.sessionId)) {
        return Promise.reject(
          new TypeError(`selectModel: "${q.sessionId}" is not a canonical UUID`),
        )
      }
      const box = mailboxOf(rootOf(q.sessionId))
      // Behind a send that is still prebuilding it waits for that Run to open, and lands as the
      // session's n = 1 (model1: the choice is never lost).
      return post(box, 'command', null, () => selectModelTurn(ports, box, q))
    },

    async effectiveModelChoice(q): Promise<ModelChoice> {
      const facts = await readSessionFacts(tape, q.sessionId)
      const draft = facts.established ? null : drafts.get(q.sessionId)
      const own = choiceOf(facts.established ? facts.modelChoice : (draft?.modelChoice ?? null))
      if (own !== null) return own
      // No data-flow check: this only reads what the next Run would choose.
      const resolved = await connector.resolveChoice({
        sessionId: q.sessionId,
        profile: facts.established ? facts.profile : (draft?.profile ?? 'chat'),
        sessionChoice: null,
        previousOrigin: null,
      })
      if ('needsConfirm' in resolved) {
        throw new Error('effectiveModelChoice: a read with no previous origin asked to confirm')
      }
      return resolved
    },

    selectProfile(q): Promise<SelectProfileResult> {
      if (!isCanonicalUuid(q.sessionId)) {
        return Promise.reject(
          new TypeError(`selectProfile: "${q.sessionId}" is not a canonical UUID`),
        )
      }
      // In the root's mailbox, in arrival order: behind a send that is still prebuilding, it waits for
      // that Run to open and answers `established` (model1).
      return post(mailboxOf(rootOf(q.sessionId)), 'command', null, () => selectProfileTurn(q))
    },

    setWorkspace(q): Promise<WorkspaceResult> {
      if (!isCanonicalUuid(q.sessionId)) {
        return Promise.reject(
          new TypeError(`setWorkspace: "${q.sessionId}" is not a canonical UUID`),
        )
      }
      return post(mailboxOf(rootOf(q.sessionId)), 'command', null, () => setWorkspaceTurn(q))
    },

    resetTurn<T>(sessionId: string, reset: () => Promise<T>): Promise<T> {
      return post(mailboxOf(rootOf(sessionId)), 'command', null, reset)
    },

    async recover(): Promise<RecoverResult> {
      if (bound === null) throw new Error('recover() before bindLoop()')
      const recovered = await recoverTape({
        tape,
        now,
        log,
        host: deps.host,
        inspectors: deps.inspectors,
        protectedFiles: deps.protectedFiles,
        userSetting: deps.userSetting,
        testTools: deps.testTools,
        strict: deps.onUnansweredCall === 'throw',
      })
      const resumable = recovered.resumable.map((item) => ({
        ...item,
        rootSessionId: rootOf(item.sessionId),
      }))
      for (const item of resumable) resumables.set(item.rootSessionId, item)
      // Delivered at least once; the renderer pulls `approval.current` on opening a session anyway.
      for (const card of recovered.cards) deliver(card)
      return { resumable, errors: recovered.errors }
    },

    resume(q): Promise<ResumeResult> {
      const ports = bound
      if (ports === null) return Promise.resolve({ status: 'refused' })
      // Its entry never begins a lease: it begins one at its turn, if it opens a Run (「租约」).
      const box = mailboxOf(q.rootSessionId)
      return post(box, 'command', null, async (): Promise<ResumeResult> => {
        const resumed = await resumeFirst(ports, box, q.origin, null)
        if (resumed === null) return { status: 'none' }
        if (typeof resumed === 'object' && 'aborted' in resumed) {
          // Its own lease, aborted before the append: a stop is written in its name, a closed
          // window or a quit writes nothing and the root stays resumable (「登记之后、append 之前被
          // 中止」, B4). No Run was opened, and no `run-ended{ runId: null }` is a resume's to send.
          await closeAborted(ports, box, resumed.aborted)
          return { status: 'none' }
        }
        return resumed === 'started' ? { status: 'started' } : { status: 'refused' }
      })
    },

    async listPendingRoots(q): Promise<readonly PendingRoot[]> {
      // One row per root that waits on an answer or can be resumed (§离开会话「approval.list」).
      const rows = await tape.listPendingApprovals({ limit: MAX_READ_LIMIT })
      const byRoot = new Map<string, PendingRoot>()
      for (const row of rows) {
        const root = rootOf(row.sessionId)
        if (!byRoot.has(root)) byRoot.set(root, { sessionId: root, waitKind: row.waitKind })
      }
      for (const root of resumables.keys()) {
        if (!byRoot.has(root)) byRoot.set(root, { sessionId: root, waitKind: 'resume' })
      }
      return [...byRoot.values()].slice(0, q.limit)
    },

    send(q): Promise<SendResult> {
      const ports = bound
      if (ports === null) return Promise.resolve({ status: 'refused', code: 'not-bound' })
      if (!isCanonicalUuid(q.sessionId)) {
        return Promise.reject(new TypeError(`send: "${q.sessionId}" is not a canonical UUID`))
      }
      if ('text' in q && q.text === '') {
        return Promise.reject(new TypeError('send: an empty message is never written'))
      }
      const box = mailboxOf(q.sessionId)
      return enter(
        ports,
        box,
        q,
        (lease, pre) => sendTurn(ports, box, q, lease, pre),
        (code) => ({ status: 'refused', code }),
        // A root known at the entry to be resumable resumes first: nothing to prebuild (「新一轮先预建」).
        !resumables.has(box.rootSessionId),
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

    answer(q): Promise<AnswerResult> {
      const ports = bound
      if (ports === null) return Promise.resolve({ status: 'refused' })
      if (!isCanonicalUuid(q.sessionId)) {
        return Promise.reject(new TypeError(`answer: "${q.sessionId}" is not a canonical UUID`))
      }
      const box = mailboxOf(rootOf(q.sessionId))
      // The entry, before the first await: a lease only when nothing is ahead of this answer.
      if (!canBeginAtEntry(box)) {
        return post(box, 'command', null, () => answerTurn(ports, box, q, null))
      }
      const begun = beginLease(ports, box, q.origin)
      if ('refused' in begun) {
        dropIfIdle(box)
        return Promise.resolve({ status: 'refused' })
      }
      const lease = hold(box, begun)
      return post(box, 'command', lease, () => answerTurn(ports, box, q, lease))
    },

    async currentPending(q): Promise<PendingCard | null> {
      const waiting = await waitingOf(tape, rootOf(q.sessionId))
      // A question's card is plan step 26's.
      if (waiting === null || waiting.waitKind !== 'approval') return null
      const card = confirmRequestOf(waiting.sessionId, waiting.decisionKey, waiting.decision)
      if (card === null) return null
      const { item } = await frozenBatchOf(tape, waiting)
      const place =
        item === undefined
          ? undefined
          : await placeOf(
              {
                tape,
                host: deps.host,
                sessionId: waiting.sessionId,
                protectedFiles: deps.protectedFiles,
              },
              item,
              waiting.call.input,
            )
      const callKey = callKeyOf(waiting.ref.runId, waiting.ref.requestSeq, waiting.ref.ordinal)
      return {
        waitKind: 'approval',
        card,
        callKey,
        // A sub-agent's card hangs under the parent's Agent call (plan step 31); a root's under its own.
        anchorCallKey: callKey,
        allowScope: answerScope({
          decision: { record: waiting.decision.record, summary: waiting.decision.summary },
          reversibility: waiting.decision.reversibility,
          ...(place === undefined ? {} : { place }),
          source: item?.source === 'builtin' ? 'builtin' : 'mcp',
          toolName: item?.originalName ?? waiting.call.name,
        }),
      }
    },

    stop(q): Promise<{ stopped: boolean }> {
      if (bound === null) return Promise.resolve({ stopped: false })
      // A stop also lets go of a message held for the menu's confirmation (「间接切公网」).
      const known = boxes.get(q.rootSessionId)
      if (known !== undefined) clearHeld(bound, known, q.rootSessionId)
      const live = boxes.get(q.rootSessionId)?.lease ?? null
      if (live !== null) {
        live.abort('user-stop')
        return Promise.resolve({ stopped: true })
      }
      // No live lease: into the mailbox, and looked at again when its turn comes — a command ahead of
      // it may have begun one by then. A paused root is closed here (暂停中停止); plan step 16 stops
      // a resumable one.
      const ports = bound
      const box = mailboxOf(q.rootSessionId)
      return post(box, 'stop', null, async (): Promise<{ stopped: boolean }> => {
        const lease = box.lease
        if (lease !== null) {
          lease.abort('user-stop')
          return { stopped: true }
        }
        const stoppedResumable = await stopResumable(ports, box, null)
        if (stoppedResumable !== null) return { stopped: stoppedResumable }
        return { stopped: await closePausedByStop(ports, box) }
      })
    },
  }
}

/** A new round's Run, from its prebuild. */
/** ① as the connector takes it: a hand-typed id's capabilities are the user's (M6, A15). */
function choiceOf(payload: ModelChoiceSetPayload | null): ModelChoice | null {
  if (payload === null) return null
  return {
    providerId: payload.providerId,
    modelId: payload.modelId,
    effort: payload.effort,
    capabilitySource: payload.source === 'user' ? 'user' : 'builtin',
  }
}

function roundSetup(pre: Extract<Prebuild, { kind: 'ready' }>): RunSetup {
  return {
    provider: () => pre.provider,
    profile: pre.profile,
    model: pre.assembly.model,
    maxTokens: pre.assembly.maxTokens,
    effort: pre.choice.effort,
    assembly: pre.assembly,
  }
}

/** The card an asking decision in these entries describes, or null. */
function cardOfEntries(sessionId: string, entries: readonly NewEntry[]): ConfirmRequest | null {
  const decided = entries.find(
    (entry) => entry.name === 'tool/permission_decided' && entry.payload['awaits'] === 'approval',
  )
  if (decided === undefined) return null
  return confirmRequestOf(
    sessionId,
    decided.provenanceKey,
    decided.payload as unknown as PermissionDecidedPayload,
  )
}

/** `leases.begin`, with the origin kept on the box: an auto-send after this lease reuses it. */
function beginLease(
  ports: LoopPorts,
  box: RootBox,
  origin: RunOrigin | null,
): RunLease | { refused: 'shutting-down' } {
  const begun = ports.leases.begin({ rootSessionId: box.rootSessionId, origin })
  if (!('refused' in begun)) box.origin = origin
  return begun
}

/**
 * The lists of taken items already put back. A failed round is seen twice — by the turn that puts
 * its items back and by the auto-send's catch — and a second `restore` would queue each item twice
 * (models/README: 排队消息不丢、不重复). A list is never taken again once restored: a later `take`
 * returns a new one.
 */
const restoredLists = new WeakSet<readonly QueuedMessage[]>()

/** Taken items that did not go out, back at their seq and no longer urgent (「Run 结束」) — once. */
async function restoreTaken(
  ports: LoopPorts,
  box: RootBox,
  taken: readonly QueuedMessage[] | null,
): Promise<void> {
  if (taken === null || taken.length === 0 || restoredLists.has(taken)) return
  restoredLists.add(taken)
  await ports.queue.restore(
    box.rootSessionId,
    taken.map((item) => ({ ...item, urgent: false })),
  )
}

/**
 * The origin an auto-send begins with (「Run 结束」): the ended lease's. After a closed window, the
 * origin of the send that marked the items urgent, or null. After a stop that took urgent items,
 * that send's too, or else the ended lease's: a window that closes after the stop leaves the cause
 * `user-stop`, so the lease cannot say its window is gone, and an auto-send begun for that window
 * would be aborted at once (rrC-2).
 */
function autoSendOrigin(
  box: RootBox,
  lease: RunLease,
  taken: readonly QueuedMessage[],
): RunOrigin | null {
  if (!lease.signal.aborted) return box.origin
  const cause = abortCauseOf(lease)
  if (cause === 'close-window') return box.urgentOrigin
  const urgent = cause === 'user-stop' && taken.some((item) => item.urgent)
  return urgent ? (box.urgentOrigin ?? box.origin) : box.origin
}

/** 「从队列取什么」 by the end reason: all of it, the urgent items, or nothing. */
function takeRuleOf(reason: RunEndReason): 'all' | 'urgent' | 'none' {
  if (reason.code === 'completed' || reason.code === 'user-rejected') return 'all'
  if (reason.code === 'user-stopped') return 'urgent'
  if (reason.code === 'shutdown-aborted' && reason.trigger === 'close-window') return 'urgent'
  return 'none'
}

/**
 * What a Run's write task refuses once its lease is aborted (「mailbox」): a decision, a dispatch,
 * and the not-run closure of a call found unusable — a call not yet dispatched when the stop came
 * closes as stopped (§点停止时各状态怎么收: 同批后面还没派发的调用一律记 not-run / stopped).
 */
function isRefusedAfterStop(entry: NewEntry): boolean {
  if (entry.name === 'tool/permission_decided' || entry.name === 'execution/dispatch_committed') {
    return true
  }
  const source = entry.name === 'execution/tool_outcome' ? entry.payload['source'] : undefined
  return source === 'tool-unavailable' || source === 'invalid-input'
}

/** What a resumed Run gets when a stop beats its `assemble`: nothing to call, nothing to send to. */
function stoppedAssembly(setup: ResumeSetup): RunAssembly {
  return {
    model: setup.model,
    capabilitySource: setup.selected.capabilitySource ?? 'builtin',
    endpointOrigin: '',
    maxTokens: setup.maxTokens,
    toolsWithheld: null,
    search: null,
    mcpSources: [],
    provider: () => {
      throw new Error('the Run was stopped before it was assembled')
    },
  }
}

/** A tool fact's call, `<runId>:<requestSeq>:<i>` (§键与挂靠). */
function callOfFact(entry: NewEntry): string {
  return `${String(entry.sourceId)}:${String(entry.sourceSeq)}:${String(entry.payload['ordinal'])}`
}

/**
 * 「重试」's message (§失败卡与结束原因): the user message that opened the Run, when none of the Run's
 * calls was dispatched; a Run an answer, 「继续」, a resume or a handoff opened has none.
 */
function retryOf(opened: OpenedRound, dispatched: boolean): string | null {
  return opened.openedBy !== undefined && !dispatched ? opened.openedBy : null
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
