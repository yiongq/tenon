/**
 * Startup recovery (spec 02 §启动恢复与发送防护, §执行日志与恢复表; plan step 16). Everything here runs
 * before the next request of any session, sends no request, calls no `assemble` and reads no key:
 *
 *   1. rewrite: every Run with a `run_started` and no `run_terminal` gets a closure for each call it
 *      was responsible for — its own requests' calls, and a resumed batch's — by the recovery table,
 *      then its terminal (`paused` when only waiting calls are left, `recovered` otherwise);
 *   2. re-judge each waiting approval, only ever tighter: a denial or a tool gone closes the call
 *      (no card), a changed card is a new decision;
 *   3. hand back the cards still to deliver;
 *   4. list what can be resumed: the Tape criterion, so both this start's tightenings and an earlier
 *      start's that were never opened are listed. Nothing is resumed here.
 *
 * Sub-agent sessions are recovered before their parents from plan step 31, and the hand-off class
 * with them; until then every session is a root.
 */
import type { AbsolutePath, ConfirmRequest, HostAdapter } from '../host/adapter.js'
import type { UserToolSetting } from '../permission/decide.js'
import type { InspectorRegistration } from '../permission/inspector.js'
import type {
  FactWriter,
  NewEntry,
  PermissionDecidedPayload,
  RunStartedPayload,
  RunTerminalPayload,
  RunUsageLine,
  SideEffectClass,
  TapeEntry,
} from '../tape/entry.js'
import { runTerminalKey } from '../tape/provenance.js'
import { MAX_READ_LIMIT } from '../tape/store.js'
import type { Tape } from '../tape/tape.js'
import type { BuiltinToolName } from '../tools/builtin/tool.js'
import { rebuildToolTable } from '../tools/table.js'
import type { ToolKey } from '../tools/table.js'
import type { ResumeSetup, WaitingCall } from './answer.js'
import {
  confirmRequestOf,
  frozenBatchOf,
  rejudgeDecisionOf,
  rejudgeWaiting,
  resumeSetupOf,
  runFacts,
  tightenedFacts,
  waitingOf,
} from './answer.js'
import type { CompleteCall } from './batch.js'
import { effectOf, readSessionEntries } from './batch.js'
import type { CallRef, ExecutionState } from './closure.js'
import { closureContent, repairFacts, resultFacts } from './closure.js'
import { readViewState } from './run.js'
import type { RunEndReason } from './terminal.js'

import type { RunConnector } from './ports.js'

export interface RecoveryDeps {
  readonly searchTarget?: RunConnector['searchTarget']
  readonly tape: Tape
  readonly now: () => number
  readonly log: (line: string) => void
  readonly host: HostAdapter
  readonly inspectors: readonly InspectorRegistration[]
  readonly protectedFiles: readonly AbsolutePath[]
  readonly userSetting: (key: ToolKey) => UserToolSetting | null
  readonly testTools: Readonly<Partial<Record<BuiltinToolName, 'fake' | 'real' | null>>> | null
  /** Tests and development builds throw on a 损坏 call; the packaged build repairs and logs it. */
  readonly strict: boolean
}

/** A resumable item: the paused Run whose waiting call startup recovery closed (§执行日志与恢复表). */
export interface Resumable {
  readonly rootSessionId: string
  readonly sessionId: string
  readonly runId: string
}

export interface Recovered {
  readonly resumable: readonly Resumable[]
  readonly errors: readonly string[]
  /** The cards still to deliver, once the rest is on the Tape. */
  readonly cards: readonly ConfirmRequest[]
}

/** A call the recovery table calls 损坏: closed `repair`, and in a strict build, thrown. */
export class RecoveryCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryCorruptionError'
  }
}

const RECOVERY: FactWriter = { by: 'recovery' }

export async function recoverTape(deps: RecoveryDeps): Promise<Recovered> {
  const resumable: Resumable[] = []
  const errors: string[] = []
  const cards: ConfirmRequest[] = []
  for (const sessionId of await allSessions(deps, errors)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one session after another: each is one append per Run
      await closeUnfinishedRuns(deps, sessionId, errors)
      // oxlint-disable-next-line no-await-in-loop -- the re-judgement reads what the rewrite wrote
      const card = await rejudgeAtStartup(deps, sessionId)
      if (card !== null) cards.push(card)
      // oxlint-disable-next-line no-await-in-loop -- the list is read from the Tape as it now stands
      const item = await resumableOf(deps.tape, sessionId)
      if (item !== null)
        resumable.push({ rootSessionId: sessionId, sessionId, runId: item.pausedRunId })
    } catch (error) {
      if (deps.strict && error instanceof RecoveryCorruptionError) throw error
      const line = `[recovery] ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      deps.log(line)
      errors.push(line)
    }
  }
  return { resumable, errors, cards }
}

/**
 * Every session of this store's tenant, newest first, paged. The cursor is strictly below (01's
 * `listSessions`), so the next page starts AT the last row's `updatedAt` — its cursor one above it
 * — and the rows seen already are dropped: a session sharing that `updatedAt` with the page boundary
 * is still recovered before its next request (裁决 B1). Only a full page of one `updatedAt` cannot
 * be paged past that way; it moves below it, and the sessions it could not reach are an error line.
 */
async function allSessions(deps: RecoveryDeps, errors: string[]): Promise<string[]> {
  const ids: string[] = []
  const seen = new Set<string>()
  let updatedBefore: number | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's last row
    const page = await deps.tape.listSessions({
      limit: MAX_READ_LIMIT,
      ...(updatedBefore === undefined ? {} : { updatedBefore }),
    })
    const before = ids.length
    for (const row of page) {
      if (seen.has(row.sessionId)) continue
      seen.add(row.sessionId)
      ids.push(row.sessionId)
    }
    const first = page[0]
    const last = page.at(-1)
    if (page.length < MAX_READ_LIMIT || first === undefined || last === undefined) return ids
    if (first.updatedAt === last.updatedAt) {
      const line = `[recovery] ${String(MAX_READ_LIMIT)} sessions share updatedAt ${String(last.updatedAt)}: any more of them were not scanned`
      deps.log(line)
      errors.push(line)
    }
    // Every page adds a session or moves strictly below its last row: the scan ends.
    updatedBefore =
      first.updatedAt === last.updatedAt || ids.length === before
        ? last.updatedAt
        : last.updatedAt + 1
  }
}

/** A tool fact's call: `<runId>:<requestSeq>:<i>`. */
function callOf(entry: TapeEntry): string {
  return `${String(entry.sourceId)}:${String(entry.sourceSeq)}:${String(entry.payload['ordinal'])}`
}

/**
 * Step 1: each Run without a terminal, by the recovery table (§执行日志与恢复表), one append per Run
 * — its closures in `<i>` order, then its terminal, `writer: recovery`.
 */
async function closeUnfinishedRuns(
  deps: RecoveryDeps,
  sessionId: string,
  errors: string[],
): Promise<void> {
  const { tape } = deps
  const entries = await readSessionEntries(tape, sessionId)
  const ended = new Set(
    entries
      .filter((entry) => entry.name === 'execution/run_terminal')
      .map((entry) => entry.sourceId),
  )
  const unfinished = entries.filter(
    (entry) => entry.name === 'execution/run_started' && !ended.has(entry.sourceId),
  )
  if (unfinished.length === 0) return
  const head = await tape.head(sessionId)
  if (head === null) return
  const pending = new Map(
    (await tape.listPendingApprovals({ sessionId, limit: MAX_READ_LIMIT })).map((row) => [
      `${row.runId}:${String(row.requestSeq)}:${String(row.callOrdinal)}`,
      row.waitKind,
    ]),
  )
  const items = await tableItemsOf(deps, sessionId)
  for (const started of unfinished) {
    const runId = String(started.sourceId)
    const cause = (started.payload as unknown as RunStartedPayload).cause
    // Its own requests' facts, paged from `fromEntryId` (B5), and a resumed batch's.
    // oxlint-disable-next-line no-await-in-loop -- one Run's facts at a time
    const own = await runFacts(tape, sessionId, runId)
    const batch =
      cause.kind === 'resume'
        ? // oxlint-disable-next-line no-await-in-loop -- the resumed batch belongs to this Run
          (await runFacts(tape, sessionId, cause.batch.runId)).filter(
            (entry) => entry.sourceSeq === cause.batch.requestSeq,
          )
        : []
    const facts = [...own, ...batch]
    const closures: NewEntry[] = []
    let waitingFor: 'approval' | 'question' | null = null
    const calls = facts
      .filter((entry) => entry.name === 'tool/call')
      .toSorted(
        (a, b) =>
          Number(a.sourceSeq) - Number(b.sourceSeq) ||
          Number(a.payload['ordinal']) - Number(b.payload['ordinal']),
      )
    for (const call of calls) {
      const key = callOf(call)
      const ofCall = facts.filter((entry) => entry.name !== 'tool/call' && callOf(entry) === key)
      const result = ofCall.find((entry) => entry.name === 'tool/result')
      const outcome = ofCall.find((entry) => entry.name === 'execution/tool_outcome')
      const dispatch = ofCall.find((entry) => entry.name === 'execution/dispatch_committed')
      const effect = effectOfCall(items, String(call.payload['name']))
      const ref: CallRef = {
        runId: String(call.sourceId),
        requestSeq: Number(call.sourceSeq),
        ordinal: Number(call.payload['ordinal']),
        providerToolCallId: String(call.payload['providerToolCallId']),
      }
      // 1 已完成
      if (result !== undefined && outcome !== undefined) {
        const said = outcome.payload['effect']
        if (dispatch === undefined && (said === 'write' || said === 'external')) {
          corrupt(deps, errors, `call ${key} has a ${String(said)} outcome and no dispatch`)
        }
        continue
      }
      // 2 等待
      const waitKind = pending.get(key)
      if (waitKind !== undefined) {
        waitingFor = waitKind
        continue
      }
      // 3 损坏: one of the pair, a dispatch no decision allows, or ids that disagree.
      const mismatch = ofCall.some(
        (entry) => entry.payload['providerToolCallId'] !== ref.providerToolCallId,
      )
      const unauthorized = dispatch !== undefined && !dispatchAllowed(dispatch, facts)
      if (result !== undefined || outcome !== undefined || mismatch || unauthorized) {
        corrupt(deps, errors, `call ${key} is broken; its missing closure is written as repair`)
        const repair = repairFacts({
          tape,
          now: deps.now,
          call: ref,
          dispatched: dispatch !== undefined,
          effect,
          writer: RECOVERY,
        })
        closures.push(
          ...repair.filter(
            (entry) =>
              (entry.name === 'tool/result' && result === undefined) ||
              (entry.name === 'execution/tool_outcome' && outcome === undefined),
          ),
        )
        continue
      }
      // 5 不确定 / 6 未派发: never run again (B1).
      closures.push(
        ...crashedFacts(deps, ref, dispatch === undefined ? 'not-run' : 'uncertain', effect),
      )
    }
    const reason: RunEndReason =
      waitingFor === null ? { code: 'recovered' } : { code: 'paused', waitingFor }
    const terminal: RunTerminalPayload = {
      reason,
      steps: new Set(
        own.filter((entry) => entry.name === 'tool/call').map((entry) => entry.sourceSeq),
      ).size,
      usage: usageOf(own),
      writer: RECOVERY,
    }
    closures.push(
      tape.writer('execution').entry('execution/run_terminal', {
        sourceType: 'runtime_event',
        sourceId: runId,
        provenanceKey: runTerminalKey(runId),
        payload: terminal,
        createdAt: deps.now(),
      }),
    )
    // oxlint-disable-next-line no-await-in-loop -- one append per Run, in Tape order
    await tape.appendEntries({ sessionId, incarnationId: head.incarnationId, entries: closures })
  }
}

/** A 损坏 call: an error in the log and the result — and in a strict build, thrown (B1). */
function corrupt(deps: RecoveryDeps, errors: string[], message: string): void {
  if (deps.strict) throw new RecoveryCorruptionError(message)
  const line = `[recovery] ${message}`
  deps.log(line)
  errors.push(line)
}

/**
 * Whether a dispatch names a decision that allowed it: an allow, or an ask the card allowed. Any
 * other decision key makes the call 损坏.
 */
function dispatchAllowed(dispatch: TapeEntry, facts: readonly TapeEntry[]): boolean {
  const decisionKey = dispatch.payload['decisionKey']
  const decision = facts.find((entry) => entry.provenanceKey === decisionKey)
  if (decision === undefined) return false
  const verdict = (decision.payload as unknown as PermissionDecidedPayload).record.verdict
  if (verdict === 'allow') return true
  return (
    verdict === 'ask' &&
    facts.some(
      (entry) =>
        entry.name === 'tool/approval_resolved' &&
        callOf(entry) === callOf(dispatch) &&
        entry.payload['outcome'] === 'allowed',
    )
  )
}

/** A crashed call's closure (§原因码表 `crashed`): not-run before a dispatch, uncertain after one. */
function crashedFacts(
  deps: RecoveryDeps,
  ref: CallRef,
  state: Extract<ExecutionState, 'not-run' | 'uncertain'>,
  effect: SideEffectClass,
): NewEntry[] {
  return resultFacts({
    tape: deps.tape,
    now: deps.now,
    call: ref,
    content: closureContent({ source: 'crashed', state }),
    isError: true,
    kernelAuthored: true,
    effect: state === 'not-run' ? 'blocked' : effect,
    state,
    source: 'crashed',
    reversibility: 'unknown',
    writer: RECOVERY,
  })
}

/** The session's frozen tool items by name, for a dispatched call's effect. */
async function tableItemsOf(
  deps: RecoveryDeps,
  sessionId: string,
): Promise<ReadonlyMap<string, SideEffectClass>> {
  const state = await readViewState(deps.tape, sessionId)
  const effects = new Map<string, SideEffectClass>()
  for (const [tableKey, payload] of state.tables) {
    for (const item of rebuildToolTable(tableKey, payload, state.specs).items) {
      effects.set(item.name, effectOf(item))
    }
  }
  return effects
}

function effectOfCall(items: ReadonlyMap<string, SideEffectClass>, name: string): SideEffectClass {
  return items.get(name) ?? 'external'
}

/** The final usage of every attempt a Run made, by provider and model. */
function usageOf(facts: readonly TapeEntry[]): RunUsageLine[] {
  const lines = new Map<string, RunUsageLine>()
  for (const attempt of facts) {
    if (attempt.name !== 'provider/attempt_completed') continue
    const providerId = String(attempt.payload['providerId'])
    const modelId = String(attempt.payload['modelId'])
    const key = `${providerId}\u0000${modelId}`
    const line = lines.get(key) ?? {
      providerId,
      modelId,
      origin: 'own' as const,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    }
    const usage = (attempt.payload['usage'] ?? null) as Partial<Record<string, number>> | null
    lines.set(key, {
      ...line,
      requests: line.requests + 1,
      inputTokens: line.inputTokens + (usage?.['inputTokens'] ?? 0),
      outputTokens: line.outputTokens + (usage?.['outputTokens'] ?? 0),
      cacheReadTokens: line.cacheReadTokens + (usage?.['cacheReadTokens'] ?? 0),
      cacheWriteTokens: line.cacheWriteTokens + (usage?.['cacheWriteTokens'] ?? 0),
      reasoningTokens: line.reasoningTokens + (usage?.['reasoningTokens'] ?? 0),
    })
  }
  return [...lines.values()]
}

/**
 * Step 2 and 3: the waiting approval judged again, only tighter. A denial or a tool gone closes it
 * with no card; a changed card is a new decision and that card is delivered; an unchanged one is
 * delivered as it is. A question is neither judged nor delivered: `approval.current` brings it back.
 */
async function rejudgeAtStartup(
  deps: RecoveryDeps,
  sessionId: string,
): Promise<ConfirmRequest | null> {
  const waiting = await waitingOf(deps.tape, sessionId)
  if (waiting === null || waiting.waitKind !== 'approval') return null
  const { item, setup } = await frozenBatchOf(deps.tape, waiting)
  const rejudged = await rejudgeWaiting({
    searchTarget: deps.searchTarget,
    providerId: setup.selected.providerId,
    judge: {
      tape: deps.tape,
      host: deps.host,
      inspectors: deps.inspectors,
      protectedFiles: deps.protectedFiles,
      userSetting: deps.userSetting,
      signal: new AbortController().signal,
    },
    waiting,
    item,
    testTools: deps.testTools,
  })
  const head = await deps.tape.head(sessionId)
  if (head === null) return null
  const append = (entries: NewEntry[]): Promise<unknown> =>
    deps.tape.appendEntries({ sessionId, incarnationId: head.incarnationId, entries })
  switch (rejudged.kind) {
    case 'unavailable':
    case 'denied':
      await append(
        tightenedFacts({ tape: deps.tape, now: deps.now, waiting, rejudged, writer: RECOVERY }),
      )
      return null
    case 'changed': {
      const decided = rejudgeDecisionOf({
        tape: deps.tape,
        now: deps.now,
        waiting,
        judged: rejudged.judged,
        writer: RECOVERY,
      })
      await append([decided])
      return confirmRequestOf(
        sessionId,
        decided.provenanceKey,
        decided.payload as unknown as PermissionDecidedPayload,
      )
    }
    default:
      return cardOf(waiting)
  }
}

function cardOf(waiting: WaitingCall): ConfirmRequest | null {
  return confirmRequestOf(waiting.sessionId, waiting.decisionKey, waiting.decision)
}

/** A resumable item as the Tape says it is, with what resuming it needs. */
export interface ResumableBatch {
  readonly sessionId: string
  readonly pausedRunId: string
  readonly batch: { readonly runId: string; readonly requestSeq: number }
  /** The calls of the batch after the one recovery closed that have no result yet. */
  readonly rest: readonly CompleteCall[]
  readonly setup: ResumeSetup
}

/**
 * The Tape criterion (§执行日志与恢复表「可续跑项」): the session's last Run ended `paused{ approval }`,
 * the call it waited on was closed by the startup re-judgement (`writer: recovery`), and no Run's
 * `cause.pausedRunId` points to it. Null for anything else.
 */
export async function resumableOf(tape: Tape, sessionId: string): Promise<ResumableBatch | null> {
  const entries = await readSessionEntries(tape, sessionId)
  const lastStart = entries.findLast((entry) => entry.name === 'execution/run_started')
  if (lastStart === undefined) return null
  const pausedRunId = String(lastStart.sourceId)
  const terminal = entries.find(
    (entry) => entry.name === 'execution/run_terminal' && entry.sourceId === pausedRunId,
  )
  const reason = terminal?.payload['reason'] as RunEndReason | undefined
  if (reason?.code !== 'paused' || reason.waitingFor !== 'approval') return null
  const asked = entries.find(
    (entry) =>
      entry.name === 'tool/permission_decided' &&
      entry.payload['awaits'] === 'approval' &&
      (entry.payload['writer'] as FactWriter | undefined)?.by === 'run' &&
      (entry.payload['writer'] as { runId?: string }).runId === pausedRunId,
  )
  if (asked === undefined) return null
  const key = callOf(asked)
  const resolved = entries.find(
    (entry) => entry.name === 'tool/approval_resolved' && callOf(entry) === key,
  )
  if ((resolved?.payload['writer'] as FactWriter | undefined)?.by !== 'recovery') return null
  const resumedBy = entries.some(
    (entry) =>
      entry.name === 'execution/run_started' &&
      (entry.payload as unknown as RunStartedPayload).cause.kind === 'resume' &&
      (entry.payload['cause'] as { pausedRunId?: string }).pausedRunId === pausedRunId,
  )
  if (resumedBy) return null
  const batch = { runId: String(asked.sourceId), requestSeq: Number(asked.sourceSeq) }
  const inBatch = entries.filter(
    (entry) => entry.sourceId === batch.runId && entry.sourceSeq === batch.requestSeq,
  )
  const answered = new Set(
    inBatch
      .filter((entry) => entry.name === 'tool/result')
      .map((entry) => Number(entry.payload['ordinal'])),
  )
  const rest = inBatch
    .filter((entry) => entry.name === 'tool/call')
    .map((entry): CompleteCall => ({
      ordinal: Number(entry.payload['ordinal']),
      providerToolCallId: String(entry.payload['providerToolCallId']),
      name: String(entry.payload['name']),
      input: entry.payload['input'] as Record<string, unknown>,
      argsHash: String(entry.payload['argsHash']),
    }))
    .filter(
      (call) => call.ordinal > Number(asked.payload['ordinal']) && !answered.has(call.ordinal),
    )
    .toSorted((a, b) => a.ordinal - b.ordinal)
  return { sessionId, pausedRunId, batch, rest, setup: resumeSetupOf(entries, batch) }
}
