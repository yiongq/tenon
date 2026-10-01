/**
 * What an answer finds and writes (spec 02 §等待模型：审批、提问与拒绝, §每种答复同批写什么, §待批表,
 * §续跑; plan step 15). Everything here reads the Tape or builds facts; when and in which mailbox task
 * they are written is the mailbox's.
 *
 * The call a root waits on is the one row of `pending_approval_projection` (at most one per root,
 * §待批表). Its latest decision names the card an answer answers: `requestId` is that decision's
 * provenance key, so a click on a card that has since changed is `stale`, never an approval of the
 * new one. Each answer is one append: the resolution, the closures it causes and, when it opens a
 * Run, that Run's head — so a crash leaves either nothing (the card is still answerable) or all of it.
 */
import type { AbsolutePath, ConfirmRequest, HostAdapter } from '../host/adapter.js'
import type { RunConnector } from './ports.js'
import type { ModelInfo } from '../provider/types.js'
import type {
  ApprovalResolvedPayload,
  FactWriter,
  ModelSelectedPayload,
  NewEntry,
  PermissionDecidedPayload,
  RunStartedPayload,
  RunTerminalPayload,
  TapeEntry,
  ViewAssembledPayload,
  ViewContentPayload,
} from '../tape/entry.js'
import {
  approvalResolvedKey,
  assembledKey,
  modelSelectedKey,
  permissionDecidedKey,
  runStartedKey,
  runTerminalKey,
  toolTableKey,
  viewContentKey,
} from '../tape/provenance.js'
import { MAX_READ_LIMIT } from '../tape/store.js'
import type { Tape } from '../tape/tape.js'
import { canonicalJson } from '../tape/canonical-json.js'
import { answeredReply, questionTextsOf, storedRecord } from '../tools/builtin/ask-user-question.js'
import type { AskReply, QuestionAnswers } from '../tools/builtin/ask-user-question.js'
import type { BuiltinToolName } from '../tools/builtin/tool.js'
import { executorFor } from '../tools/executor.js'
import type { ToolTableItem } from '../tools/registry.js'
import { rebuildToolTable } from '../tools/table.js'
import { blockFacts, decisionEntry, judgeCall, readSessionEntries } from './batch.js'
import type { CompleteCall, JudgeContext, Judgement } from './batch.js'
import { readViewState } from './run.js'
import type { CallRef, ClosureSource } from './closure.js'
import { closureContent, notRunFacts, resultFacts } from './closure.js'
import { spillChecked } from './spill.js'
import type { RunEndReason } from './terminal.js'

/** The call a paused root waits on, read back from the Tape. */
export interface WaitingCall {
  readonly sessionId: string
  readonly waitKind: 'approval' | 'question'
  readonly ref: CallRef
  readonly call: CompleteCall
  /** The call's latest decision: the card it shows. */
  readonly decision: PermissionDecidedPayload
  /** Its provenance key: the `requestId` an answer names. */
  readonly decisionKey: string
  /** The `<r>` of the latest decision; 0 for the first. */
  readonly rejudge: number
  /** The calls of the batch after it that have no result yet, in `<i>` order. */
  readonly rest: readonly CompleteCall[]
  /** The Run that ended paused on it: the one that wrote its first decision. */
  readonly pausedRunId: string
}

/** Every fact a Run keyed under its id, paged from `fromEntryId` (B5). */
export async function runFacts(tape: Tape, sessionId: string, runId: string): Promise<TapeEntry[]> {
  const entries: TapeEntry[] = []
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
    entries.push(...page)
    if (page.length < MAX_READ_LIMIT) return entries
    fromEntryId = (page.at(-1)?.entryId ?? 0) + 1
  }
}

/** The one call this root waits on, or null (§待批表: at most one row per root). */
export async function waitingOf(tape: Tape, sessionId: string): Promise<WaitingCall | null> {
  const [row] = await tape.listPendingApprovals({ sessionId, limit: MAX_READ_LIMIT })
  if (row === undefined) return null
  const facts = await runFacts(tape, sessionId, row.runId)
  const inRequest = facts.filter((entry) => entry.sourceSeq === row.requestSeq)
  const calls = inRequest
    .filter((entry) => entry.name === 'tool/call')
    .map(callOf)
    .toSorted((a, b) => a.ordinal - b.ordinal)
  const call = calls.find((candidate) => candidate.ordinal === row.callOrdinal)
  const latest = inRequest.find((entry) => entry.entryId === row.entryId)
  const first = inRequest.find(
    (entry) =>
      entry.name === 'tool/permission_decided' &&
      entry.payload['ordinal'] === row.callOrdinal &&
      entry.payload['rejudge'] === undefined,
  )
  if (call === undefined || latest === undefined || first === undefined) {
    throw new Error(`waiting: the pending row of ${sessionId} names facts the Tape does not hold`)
  }
  const answered = new Set(
    inRequest
      .filter((entry) => entry.name === 'tool/result')
      .map((entry) => Number(entry.payload['ordinal'])),
  )
  const writer = (first.payload as unknown as PermissionDecidedPayload).writer
  return {
    sessionId,
    waitKind: row.waitKind,
    ref: {
      runId: row.runId,
      requestSeq: row.requestSeq,
      ordinal: call.ordinal,
      providerToolCallId: call.providerToolCallId,
    },
    call,
    decision: latest.payload as unknown as PermissionDecidedPayload,
    decisionKey: latest.provenanceKey ?? '',
    rejudge: Number(latest.payload['rejudge'] ?? 0),
    rest: calls.filter((rest) => rest.ordinal > call.ordinal && !answered.has(rest.ordinal)),
    pausedRunId: writer.by === 'run' ? writer.runId : row.runId,
  }
}

function callOf(entry: TapeEntry): CompleteCall {
  return {
    ordinal: Number(entry.payload['ordinal']),
    providerToolCallId: String(entry.payload['providerToolCallId']),
    name: String(entry.payload['name']),
    input: entry.payload['input'] as Record<string, unknown>,
    argsHash: String(entry.payload['argsHash']),
  }
}

const DECISION_KEY = /^tool:v1:decision:([0-9a-f-]{36}):(\d+):(\d+)(?::rejudge:\d+)?$/u

/**
 * What an answer's `requestId` names (§答复与投递「status」): the waiting call, or why there is
 * nothing to apply the answer to.
 */
export async function answerTarget(
  tape: Tape,
  q: {
    readonly sessionId: string
    readonly requestId: string
    readonly kind: 'approval' | 'question'
  },
): Promise<WaitingCall | 'not-found' | 'already-resolved' | 'stale' | 'invalid'> {
  const match = DECISION_KEY.exec(q.requestId)
  if (match === null) return 'not-found'
  const [, runId = '', seq = '', ordinal = ''] = match
  const facts = await runFacts(tape, q.sessionId, runId)
  const ofCall = facts.filter(
    (entry) => entry.sourceSeq === Number(seq) && entry.payload['ordinal'] === Number(ordinal),
  )
  if (!ofCall.some((entry) => entry.name === 'tool/call')) return 'not-found'
  if (
    ofCall.some((entry) => entry.name === 'tool/approval_resolved' || entry.name === 'tool/result')
  )
    return 'already-resolved'
  const waiting = await waitingOf(tape, q.sessionId)
  if (
    waiting === null ||
    waiting.ref.runId !== runId ||
    waiting.ref.requestSeq !== Number(seq) ||
    waiting.ref.ordinal !== Number(ordinal)
  ) {
    return 'not-found'
  }
  if (waiting.decisionKey !== q.requestId) return 'stale'
  if (waiting.waitKind !== q.kind) return 'invalid'
  return waiting
}

// ----- the facts an answer writes -----------------------------------------------------------------

/** `tool/approval_resolved`: how the card was answered. One key per call, whatever the outcome. */
export function resolvedEntry(q: {
  readonly tape: Tape
  readonly now: () => number
  readonly waiting: WaitingCall
  readonly outcome: ApprovalResolvedPayload['outcome']
  readonly via: ApprovalResolvedPayload['via']
  readonly grant?: ApprovalResolvedPayload['grant']
  readonly parentWorkspaceKey?: string
  readonly writer: FactWriter
}): NewEntry {
  const { ref } = q.waiting
  const payload: ApprovalResolvedPayload = {
    ordinal: ref.ordinal,
    providerToolCallId: ref.providerToolCallId,
    decisionKey: q.waiting.decisionKey,
    outcome: q.outcome,
    via: q.via,
    grant: q.grant ?? null,
    ...(q.parentWorkspaceKey === undefined ? {} : { parentWorkspaceKey: q.parentWorkspaceKey }),
    writer: q.writer,
  }
  return q.tape.writer('tool').entry('tool/approval_resolved', {
    sourceType: 'runtime_event',
    sourceId: ref.runId,
    sourceSeq: ref.requestSeq,
    provenanceKey: approvalResolvedKey(ref.runId, ref.requestSeq, ref.ordinal),
    payload,
    createdAt: q.now(),
  })
}

/**
 * Not-run closures, one source, for these calls of the waiting batch, in `<i>` order. The waiting
 * call has its asking decision, whose reversibility it keeps; the rest have none, so `unknown`
 * (§载荷 ToolOutcomePayload).
 */
export function batchClosures(q: {
  readonly tape: Tape
  readonly now: () => number
  readonly waiting: WaitingCall
  readonly calls: readonly CompleteCall[]
  readonly source: Exclude<ClosureSource, 'no-preference' | 'typed-answer'>
  readonly writer: FactWriter
}): NewEntry[] {
  return q.calls.flatMap((call) =>
    notRunFacts({
      tape: q.tape,
      now: q.now,
      call: {
        runId: q.waiting.ref.runId,
        requestSeq: q.waiting.ref.requestSeq,
        ordinal: call.ordinal,
        providerToolCallId: call.providerToolCallId,
      },
      source: q.source,
      ...(call.ordinal === q.waiting.ref.ordinal
        ? { reversibility: q.waiting.decision.reversibility }
        : {}),
      writer: q.writer,
    }),
  )
}

/**
 * A stop while the root waits (§每种答复同批写什么「暂停中停止」): the card is cancelled and this call
 * and the rest of the batch close not-run / `stopped`; no Run opens. A question stopped before its
 * answer is filled `unanswered` — aborted, is_error — and the rest of its batch closes not-run /
 * `stopped` (§点停止时各状态怎么收「等提问」).
 */
export function stopFacts(tape: Tape, now: () => number, waiting: WaitingCall): NewEntry[] {
  const writer: FactWriter = { by: 'resolver' }
  if (waiting.waitKind === 'question') {
    return [
      ...resultFacts({
        tape,
        now,
        call: waiting.ref,
        content: closureContent({ source: 'unanswered', state: 'aborted' }),
        isError: true,
        kernelAuthored: true,
        effect: 'blocked',
        state: 'aborted',
        source: 'unanswered',
        reversibility: waiting.decision.reversibility,
        writer,
      }),
      ...batchClosures({ tape, now, waiting, calls: waiting.rest, source: 'stopped', writer }),
    ]
  }
  return [
    resolvedEntry({ tape, now, waiting, outcome: 'cancelled-by-stop', via: 'stop', writer }),
    ...batchClosures({
      tape,
      now,
      waiting,
      calls: [waiting.call, ...waiting.rest],
      source: 'stopped',
      writer,
    }),
  ]
}

/**
 * The reply `approval.respond` gave to a waiting question, or `invalid` when its answers name a
 * question the call did not ask (§答复与投递「status」): nothing is written then.
 */
export function questionReplyOf(
  waiting: WaitingCall,
  answers: QuestionAnswers,
): AskReply | 'invalid' {
  return answeredReply(questionTextsOf(waiting.call.input), answers)
}

/**
 * The answer to a waiting question (§每种答复同批写什么「提问答复」), before the new Run's head: its
 * `tool/result` — the fixed template, through the spill check like any result the user's own text
 * can make long (§大响应落盘; plan step 24) — with the summary card's record, cut like the content
 * when the result spills, and its `tool_outcome`, completed, source `no-preference`, `typed-answer`
 * or null.
 */
export async function questionAnswerFacts(q: {
  readonly tape: Tape
  readonly now: () => number
  readonly host: Pick<HostAdapter, 'fs' | 'identity'>
  readonly log: (line: string) => void
  readonly waiting: WaitingCall
  readonly reply: AskReply
}): Promise<NewEntry[]> {
  const { waiting, reply } = q
  const checked = await spillChecked({
    fs: q.host.fs,
    profileDir: q.host.identity.profileDir as AbsolutePath,
    sessionId: waiting.sessionId,
    call: waiting.ref,
    result: { content: [{ type: 'text', text: reply.text }], isError: false, kernelAuthored: true },
    log: q.log,
  })
  return resultFacts({
    tape: q.tape,
    now: q.now,
    call: waiting.ref,
    content: checked.content,
    isError: checked.isError,
    kernelAuthored: checked.kernelAuthored,
    ...(checked.spill === undefined ? {} : { spill: checked.spill }),
    // Past the threshold the answer's full text is the spill file's alone (H9; Revisions 31).
    question: storedRecord(reply.record, checked.mark),
    effect: 'blocked',
    state: 'completed',
    source: reply.source,
    reversibility: waiting.decision.reversibility,
    writer: { by: 'resolver' },
  })
}

/** A new message while the card waits (§多卡、拒绝与取代「取代」): superseded, and the rest with it. */
export function supersedeFacts(tape: Tape, now: () => number, waiting: WaitingCall): NewEntry[] {
  const writer: FactWriter = { by: 'resolver' }
  return [
    resolvedEntry({ tape, now, waiting, outcome: 'superseded', via: 'new-message', writer }),
    ...batchClosures({
      tape,
      now,
      waiting,
      calls: [waiting.call, ...waiting.rest],
      source: 'superseded',
      writer,
    }),
  ]
}

/** The paused Run a resuming one names, and the request of the batch it finishes (§续跑). */
export interface PausedBatch {
  readonly pausedRunId: string
  readonly batch: { readonly runId: string; readonly requestSeq: number }
}

/** The paused batch a waiting call belongs to. */
export function pausedBatchOf(waiting: WaitingCall): PausedBatch {
  return {
    pausedRunId: waiting.pausedRunId,
    batch: { runId: waiting.ref.runId, requestSeq: waiting.ref.requestSeq },
  }
}

/**
 * The head of a Run that resumes a paused batch: `run_started{ resume }`, and its `model_selected`
 * when it will request (an answer, `resume`); a Run that only closes calls writes none.
 */
export function resumeHead(q: {
  readonly tape: Tape
  readonly now: () => number
  readonly sessionId: string
  readonly runId: string
  readonly paused: PausedBatch
  readonly selected: ModelSelectedPayload | null
}): NewEntry[] {
  const started: RunStartedPayload = {
    cause: { kind: 'resume', pausedRunId: q.paused.pausedRunId, batch: q.paused.batch },
  }
  const entries = [
    q.tape.writer('execution').entry('execution/run_started', {
      sourceType: 'runtime_event',
      sourceId: q.runId,
      provenanceKey: runStartedKey(q.runId),
      payload: started,
      createdAt: q.now(),
    }),
  ]
  if (q.selected !== null) {
    entries.push(
      q.tape.writer('session').entry('session/model_selected', {
        sourceType: 'session',
        sourceId: q.sessionId,
        provenanceKey: modelSelectedKey(q.runId),
        payload: q.selected,
        createdAt: q.now(),
      }),
    )
  }
  return entries
}

/**
 * The user's rejection in the main session (§每种答复同批写什么「主会话里拒绝」): the resolution, this
 * call and the rest of the batch not-run / `user-rejected`, and a Run that sends nothing — its
 * `run_started` and its `run_terminal{ user-rejected }`, no `model_selected`.
 */
export function rejectFacts(q: {
  readonly tape: Tape
  readonly now: () => number
  readonly sessionId: string
  readonly runId: string
  readonly waiting: WaitingCall
  readonly toolName: string
}): { entries: NewEntry[]; reason: RunEndReason } {
  const run: FactWriter = { by: 'run', runId: q.runId }
  const reason: RunEndReason = { code: 'user-rejected', toolName: q.toolName }
  const terminal: RunTerminalPayload = { reason, steps: 0, usage: [], writer: run }
  return {
    reason,
    entries: [
      resolvedEntry({ ...q, outcome: 'denied', via: 'card', writer: { by: 'resolver' } }),
      ...batchClosures({
        ...q,
        calls: [q.waiting.call, ...q.waiting.rest],
        source: 'user-rejected',
        writer: run,
      }),
      ...resumeHead({ ...q, paused: pausedBatchOf(q.waiting), selected: null }),
      q.tape.writer('execution').entry('execution/run_terminal', {
        sourceType: 'runtime_event',
        sourceId: q.runId,
        provenanceKey: runTerminalKey(q.runId),
        payload: terminal,
        createdAt: q.now(),
      }),
    ],
  }
}

// ----- what a resuming Run is built from --------------------------------------------------------

/**
 * A resuming Run's model and request settings, from the paused batch's own facts (§续跑): the
 * provider and model its Run selected, the ModelInfo its request was assembled with, and the max
 * tokens and effort its attempt sent. Nothing is read from the current model table (A3, 不变量 33).
 */
export interface ResumeSetup {
  readonly selected: ModelSelectedPayload
  readonly model: ModelInfo
  readonly maxTokens: number
  readonly effort: string | null
}

export function resumeSetupOf(
  entries: readonly TapeEntry[],
  batch: { readonly runId: string; readonly requestSeq: number },
): ResumeSetup {
  const byKey = new Map(entries.map((entry) => [entry.provenanceKey, entry]))
  const selected = byKey.get(modelSelectedKey(batch.runId))?.payload as
    | ModelSelectedPayload
    | undefined
  const assembled = byKey.get(assembledKey(batch.runId, batch.requestSeq))?.payload as
    | ViewAssembledPayload
    | undefined
  const content =
    assembled === undefined
      ? undefined
      : (byKey.get(viewContentKey('model_info', assembled.modelInfoHash))?.payload as
          | ViewContentPayload
          | undefined)
  const attempt = entries.findLast(
    (entry) =>
      entry.name === 'provider/attempt_completed' &&
      entry.sourceId === batch.runId &&
      entry.sourceSeq === batch.requestSeq,
  )
  const request = (attempt?.payload['request'] ?? {}) as { maxTokens?: number; effort?: string }
  if (selected === undefined || content?.type !== 'model_info' || attempt === undefined) {
    throw new Error(
      `resume: the facts of request ${batch.runId}:${String(batch.requestSeq)} are incomplete`,
    )
  }
  // The paused Run's model and where its capabilities came from (§续跑); where it sends is read
  // again when the resuming Run is written.
  return {
    selected: {
      providerId: selected.providerId,
      modelId: selected.modelId,
      ...(selected.capabilitySource === undefined
        ? {}
        : { capabilitySource: selected.capabilitySource }),
      ...(selected.endpointOrigin === undefined ? {} : { endpointOrigin: selected.endpointOrigin }),
    },
    model: content.model,
    maxTokens: request.maxTokens ?? content.model.maxOutputTokens,
    effort: request.effort ?? null,
  }
}

/**
 * What `approval.current` shows (§答复与投递, §调用的键与读写的数据): the approval card, or the
 * question that waits (plan step 26 adds the second variant).
 */
export type PendingCard = PendingApproval | PendingQuestion

/** The approval card: the card, the call's key, the row it hangs under, and the scope an「允许」grants. */
export interface PendingApproval {
  readonly waitKind: 'approval'
  readonly card: ConfirmRequest
  readonly callKey: string
  readonly anchorCallKey: string
  readonly allowScope: 'once' | 'session'
}

/**
 * The question that waits: its `requestId` (the allowing decision's provenance key), the session its
 * call is in, the `tool-request` block the widget reads the questions from, and the call's key.
 */
export interface PendingQuestion {
  readonly waitKind: 'question'
  readonly requestId: string
  readonly sessionId: string
  readonly toolRequestId: string
  readonly callKey: string
}

/** One row of `approval.list`: a root that waits on an answer, or that can be resumed (§离开会话). */
export interface PendingRoot {
  readonly sessionId: string
  readonly waitKind: 'approval' | 'question' | 'resume'
}

/** The card an asking decision describes, as `HostConfirm.request` delivers it (§答复与投递「投递」). */
export function confirmRequestOf(
  sessionId: string,
  requestId: string,
  decision: PermissionDecidedPayload,
): ConfirmRequest | null {
  const confirm = decision.confirm
  if (confirm === undefined) return null
  return {
    requestId,
    sessionId,
    kind: confirm.kind,
    reason: confirm.reason,
    facts: { ...confirm.facts },
    reversibility: decision.reversibility,
    target: confirm.target,
  }
}

// ----- the re-judgement (§等待模型「重新判定」) --------------------------------------------------------

/** How a waiting call judges now: only ever tighter than the card it waits on (F3). */
export type Rejudged =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'denied'; readonly judged: Extract<Judgement, { kind: 'judged' }> }
  | { readonly kind: 'changed'; readonly judged: Extract<Judgement, { kind: 'judged' }> }
  | { readonly kind: 'unchanged'; readonly judged: Extract<Judgement, { kind: 'judged' }> }

/**
 * The paused batch's frozen facts: its model setup, and the table item of the waiting call, from
 * the table frozen for that provider and generation.
 */
export async function frozenBatchOf(
  tape: Tape,
  waiting: WaitingCall,
): Promise<{ setup: ResumeSetup; item: ToolTableItem | undefined }> {
  const entries = await readSessionEntries(tape, waiting.sessionId)
  const setup = resumeSetupOf(entries, waiting.ref)
  const head = await tape.head(waiting.sessionId)
  const state = await readViewState(tape, waiting.sessionId)
  const tableKey = toolTableKey(
    head?.incarnationId ?? '',
    state.generation,
    setup.selected.providerId,
  )
  const stored = state.tables.get(tableKey)
  const table = stored === undefined ? null : rebuildToolTable(tableKey, stored, state.specs)
  return { setup, item: table?.items.find((candidate) => candidate.name === waiting.call.name) }
}

/**
 * The call judged again, before an allow is applied or at startup: gone (out of the frozen table,
 * or a builtin with no executor in this build — a connector's server is only reachable through an
 * assembly, and is checked at dispatch), denied, still asking about something else, or as it was.
 * A verdict that loosened since is read as `unchanged`: an allow never comes from a re-judgement.
 */
export async function rejudgeWaiting(q: {
  readonly judge: Omit<JudgeContext, 'sessionId' | 'searchHost'>
  readonly searchTarget?: RunConnector['searchTarget']
  readonly providerId?: string
  readonly waiting: WaitingCall
  readonly item: ToolTableItem | undefined
  readonly testTools: Readonly<Partial<Record<BuiltinToolName, 'fake' | 'real' | null>>> | null
}): Promise<Rejudged> {
  const { item, waiting } = q
  if (
    item === undefined ||
    (item.source === 'builtin' &&
      executorFor({ item, mcpSources: [], testTools: q.testTools }) === null)
  ) {
    return { kind: 'unavailable' }
  }
  const target = waiting.decision.confirm?.target
  const searching = item.source === 'builtin' && item.originalName === 'WebSearch'
  const current = searching
    ? q.searchTarget?.(q.providerId ?? '', String(waiting.call.input['query']))
    : null
  if (searching && current == null) return { kind: 'unavailable' }
  const changed =
    searching &&
    current != null &&
    (target?.type !== 'search' || target.host !== current.host || target.query !== current.query)
  const judged = await judgeCall(
    {
      ...q.judge,
      sessionId: waiting.sessionId,
      searchHost: current?.host ?? null,
      ...(current == null ? {} : { prepareSearch: () => current }),
      ignoreSearchGrant: changed,
    },
    item,
    waiting.call,
  )
  if (judged.kind === 'stopped') return judged
  const verdict = judged.decision.record.verdict
  if (verdict === 'deny') return { kind: 'denied', judged }
  if (verdict === 'ask' && cardChanged(waiting.decision, judged)) return { kind: 'changed', judged }
  return { kind: 'unchanged', judged }
}

/** Whether a re-judgement's card differs from the one waiting: verdict, summary or card (F3). */
function cardChanged(
  before: PermissionDecidedPayload,
  judged: Extract<Judgement, { kind: 'judged' }>,
): boolean {
  const { decision } = judged
  const after = {
    verdict: decision.record.verdict,
    summary: decision.summary,
    confirm:
      decision.confirm === undefined || judged.card === undefined
        ? null
        : { ...decision.confirm, ...judged.card },
  }
  const was = {
    verdict: before.record.verdict,
    summary: before.summary,
    confirm: before.confirm ?? null,
  }
  return canonicalJson(after) !== canonicalJson(was)
}

/** The re-judgement's own decision fact, `…:rejudge:<r>`: a denial, or a card that changed. */
export function rejudgeDecisionOf(q: {
  readonly tape: Tape
  readonly now: () => number
  readonly waiting: WaitingCall
  readonly judged: Extract<Judgement, { kind: 'judged' }>
  readonly writer: FactWriter
}): NewEntry {
  const rejudge = q.waiting.rejudge + 1
  const { ref } = q.waiting
  return decisionEntry({
    tape: q.tape,
    now: q.now,
    ref,
    argsHash: q.waiting.call.argsHash,
    judged: q.judged,
    key: permissionDecidedKey(ref.runId, ref.requestSeq, ref.ordinal, rejudge),
    rejudge,
    writer: q.writer,
  })
}

/**
 * A tightened re-judgement's facts (§每种答复同批写什么): the denial's own decision when it denies,
 * the resolution (`denied-on-rejudge` or `tool-unavailable`, via `rejudge`) and the call's closure.
 * Whoever re-judged writes them: the resolver before an allow, the recovery at startup.
 */
export function tightenedFacts(q: {
  readonly tape: Tape
  readonly now: () => number
  readonly waiting: WaitingCall
  readonly rejudged: Extract<Rejudged, { kind: 'unavailable' | 'denied' }>
  readonly writer: FactWriter
}): NewEntry[] {
  const { tape, now, waiting, writer } = q
  if (q.rejudged.kind === 'unavailable') {
    return [
      resolvedEntry({ tape, now, waiting, outcome: 'tool-unavailable', via: 'rejudge', writer }),
      ...batchClosures({
        tape,
        now,
        waiting,
        calls: [waiting.call],
        source: 'tool-unavailable',
        writer,
      }),
    ]
  }
  const { judged } = q.rejudged
  return [
    rejudgeDecisionOf({ tape, now, waiting, judged, writer }),
    resolvedEntry({ tape, now, waiting, outcome: 'denied-on-rejudge', via: 'rejudge', writer }),
    ...blockFacts({ tape, now, writer }, waiting.ref, judged),
  ]
}
