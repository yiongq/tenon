import type { SubagentHandoff } from './subagent.js'
/**
 * One batch of tool calls (spec 02 §一批工具怎么执行, §权限决策顺序, §原因码表; plan steps 13, 24).
 *
 * The parallel group first (H14, plan step 24): from the reply's first call, the adjacent calls each a
 * Read, Glob or Grep in the workspace, judged allow as such (`canRunInParallel`), are dispatched
 * together — each judged and dispatched without waiting for the ones before it to end (T1), so a later
 * member's decision and dispatch may precede an earlier one's result. Their results are buffered and
 * written in `<i>` order, whatever order they finish in. The group is cut before the first call that
 * is anything else — one that asks, is denied, changes something, is another tool, reads outside the
 * workspace or the spill, or runs in the chat profile — and that call's judgement, made to find the
 * cut, is the one the serial pass uses. A resumed batch is past its cut already: it never forms a
 * group, and neither does the rest of this one (F6).
 *
 * Then the calls one at a time, in the model's order. For each call:
 *
 *   1. find it in the frozen table — a name it does not hold is `tool-unavailable`;
 *   2. validate its arguments — `invalid-input`, or `tool-unavailable` for a schema that cannot be
 *      used — with no decision and no dispatch, the closure with the validator's message passing the
 *      spill check;
 *   3. find its executor — none in this build is `tool-unavailable`, its definition still sent;
 *   4. decide: every layer's state computed here, the inspectors run first (a stop while they run
 *      writes no decision), then `decide()`;
 *   5. deny: the decision and a kernel-authored closure; the third machine denial in a row ends the
 *      Run as `blocked-repeatedly`. Ask: the decision is written with the Run's `paused` terminal, in
 *      one batch (同批规则 1). AskUserQuestion allowed: the same, its decision `awaits: 'question'` —
 *      it has no executor, and its answer is its result (H6). Allow: the decision and
 *      `dispatch_committed`, then — only once they are
 *      on the Tape (T1) — the executor, then its result and outcome, a result past the spill
 *      threshold written to disk first (§大响应落盘; plan step 24). Bash first awaits its base
 *      environment, raced against the stop (§内置工具与参数「Bash」): a stop that wins writes neither.
 *
 * A stop between calls closes the rest as not-run / stopped. A stop while the group runs closes each
 * member as §点停止时各状态怎么收 says — each with its own write wait, counted from the stop — and then
 * the calls not dispatched, not-run / stopped, after the members' results.
 */
import type { AbsolutePath, ConfirmTarget, HostAdapter, Reversibility } from '../host/adapter.js'
import { toolOutputDirFor } from '../host/profile.js'
import { isBlockedFetchUrl } from '../permission/fetch-address.js'
import { PARALLEL_TOOL_NAMES, canRunInParallel, decide } from '../permission/decide.js'
import type { Decision, UserToolSetting } from '../permission/decide.js'
import { grantKey, sessionGrantKindOf, sessionGrants } from '../permission/grants.js'
import type { GrantFact, GrantObject } from '../permission/grants.js'
import type { InspectorRegistration } from '../permission/inspector.js'
import { runInspectors } from '../permission/inspector.js'
import {
  FILE_TOOL_NAMES,
  callReasonOf,
  hostOfUrl,
  reversibilityOf,
} from '../permission/reversibility.js'
import { buildSessionView } from '../permission/session-view.js'
import type { InspectedCall } from '../permission/session-view.js'
import { locatePath, resolvePath } from '../permission/workspace.js'
import type { PathPlace, PathScope, PathVerdict } from '../permission/workspace.js'
import type { DecisionSummary } from '../permission/record.js'
import type {
  AppendResult,
  DispatchCommittedPayload,
  FactWriter,
  NewEntry,
  PermissionDecidedPayload,
  TapeEntry,
  WorkspaceSetPayload,
} from '../tape/entry.js'
import { dispatchCommittedKey, permissionDecidedKey } from '../tape/provenance.js'
import { MAX_READ_LIMIT, TapeProvenanceConflictError } from '../tape/store.js'
import type { Tape } from '../tape/tape.js'
import { BUILTIN_TOOLS, isBuiltinToolName } from '../tools/builtin/index.js'
import type { BuiltinToolName } from '../tools/builtin/tool.js'
import { executorFor } from '../tools/executor.js'
import type { ToolExecution, ToolExecutor } from '../tools/executor.js'
import type { ToolTableItem } from '../tools/registry.js'
import { SEARCH_TEXTS } from '../tools/builtin/web-search.js'
import type { SearchBackend } from '../tools/search/types.js'
import type { FrozenToolTable, ToolKey } from '../tools/table.js'
import type { ArgumentValidator, ValidationVerdict } from '../tools/validate.js'
import type { CommandRun, CommandShell } from '../tools/builtin/bash.js'
import type { CallRef } from './closure.js'
import { closureContent, notRunFacts, repairFacts, resultFacts } from './closure.js'
import { sessionFactsOf, workspaceOf } from '../session/facts.js'
import { MACHINE_DENIAL_CAP, STOP_WRITE_WAIT_MS } from './limits.js'
import { spillChecked } from './spill.js'
import type { McpToolSource, RunAbortCause } from './ports.js'
import type { ToolOutcomeView } from './events.js'

/** One complete client call of a reply, as `tool/call` records it. */
export interface CompleteCall {
  readonly ordinal: number
  readonly providerToolCallId: string
  readonly name: string
  readonly input: Record<string, unknown>
  readonly argsHash: string
}

export interface AgentDispatch {
  readonly dispatch: readonly NewEntry[]
  readonly call: CallRef
  readonly input: Record<string, unknown>
  readonly table: FrozenToolTable
  readonly reversibility: Reversibility
  readonly summary: DecisionSummary
}
export type AgentDispatchResult =
  | { readonly kind: 'paused' }
  | {
      readonly kind: 'done'
      readonly entries: readonly NewEntry[]
      readonly handoff: SubagentHandoff
      /**
       * The same handoff as `aborted` (§交接: 子会话已提交终态、父会话收交接之前被停止), for a stop that
       * reached the write of `entries` first. Built only then, so a handoff that lands spills once.
       */
      readonly aborted: () => Promise<{ readonly entries: readonly NewEntry[] }>
    }

export interface BatchContext {
  readonly budgetExceeded?: () => number | null
  readonly agent?: (q: AgentDispatch) => Promise<AgentDispatchResult>
  readonly tape: Tape
  readonly now: () => number
  readonly host: HostAdapter
  readonly sessionId: string
  /** The request the calls were made in: every fact of theirs is keyed under it (§键与挂靠). */
  readonly runId: string
  readonly requestSeq: number
  /** Who writes: the Run handling the batch — the one that asked, or the one resuming it (§续跑). */
  readonly writer: FactWriter
  readonly table: FrozenToolTable
  /** The calls still to handle, in `<i>` order. */
  readonly calls: readonly CompleteCall[]
  /** A resumed batch's approved call: dispatched on its answered decision, not judged again (§续跑). */
  readonly approved?: ApprovedCall
  readonly inspectors: readonly InspectorRegistration[]
  readonly validator: ArgumentValidator
  readonly protectedFiles: readonly AbsolutePath[]
  readonly userSetting: (key: ToolKey) => UserToolSetting | null
  readonly mcpSources: readonly McpToolSource[]
  readonly testTools: Readonly<Partial<Record<BuiltinToolName, 'fake' | 'real' | null>>> | null
  readonly search: SearchBackend | null
  /** Bash's shell and base environment (`LoopPorts.commandShell`). */
  readonly commandShell: CommandShell
  /** Machine denials in a row before this batch, counted from the Tape (F2, F3). */
  readonly denials: number
  readonly signal: AbortSignal
  /**
   * Why `signal` was aborted (§进行中、暂停与 RunRegistry「中止原因」), read when a dispatched call
   * closes after it: a user-stop closes it `stopped`, a quit or a closed window `app-exit` (B4).
   */
  readonly cause: () => RunAbortCause
  /** Commits facts through the mailbox; resolves with what was written once it is on the Tape. */
  readonly write: (entries: readonly NewEntry[]) => Promise<Written>
  /**
   * Tests and development builds: a dispatch the Tape already holds throws (§执行日志与恢复表 T1);
   * the packaged build closes that call `repair` and logs it instead.
   */
  readonly strict: boolean
  readonly log: (line: string) => void
  /** A call's closed outcome, for the interface (sent after its two facts are committed). */
  readonly outcome: (call: CompleteCall, view: ToolOutcomeView) => void
}

/** A call the user allowed on its card: the decision it answered, which its dispatch names (T1). */
export interface ApprovedCall {
  readonly searchTarget?: { readonly host: string; readonly query: string }
  readonly ordinal: number
  readonly decisionKey: string
  readonly summary: DecisionSummary
  readonly reversibility: Reversibility
  /**
   * Where a file tool acts: the real path on the card it answered, even when the re-judgement found
   * the call elsewhere; null for any other tool. Not located again after the dispatch — the
   * executor's re-check guards this path (§「在不在工作区里」第 5 步).
   */
  readonly target: AbsolutePath | null
}

/**
 * What a write committed: the entries, in the order given, with their receipts. A result for a call
 * that already has one is left out (先写者算数, §写入：谁写、写几次), and so is its outcome.
 */
export interface Written {
  readonly entries: readonly NewEntry[]
  readonly receipts: readonly AppendResult[]
  /**
   * The top entry id of the results another writer committed first, when this write deferred to
   * them: the Run's context pin moves past them, or its next request would not see them.
   */
  readonly deferredTo?: number
}

/**
 * A Run's write the mailbox refused (§主进程与 kernel 的循环接口「mailbox」): its lease was aborted
 * before the task's turn, and a decision, a dispatch or the closure of a call found unusable is not
 * written after a stop — the call closes as stopped instead.
 */
export class RunWriteRefusedError extends Error {
  constructor() {
    super('the Run was stopped before this decision or dispatch was written')
    this.name = 'RunWriteRefusedError'
  }
}

export type BatchResult =
  | { readonly kind: 'done'; readonly denials: number }
  /**
   * A decision asks, or an AskUserQuestion is allowed: it is written with the Run's `paused` terminal,
   * in one batch, which says what the Run waits for.
   */
  | {
      readonly kind: 'paused'
      readonly waitingFor: 'approval' | 'question' | 'subagent'
      readonly withTerminal: readonly NewEntry[]
      /** The asked call and the rest of the batch after it, which wait with it (§等待模型). */
      readonly waiting: readonly CallRef[]
    }
  /**
   * The third machine denial in a row: the calls after it are the Run's to close, in its terminal's
   * batch (「mailbox」: a stop that beats the terminal task writes neither).
   */
  | {
      readonly kind: 'blocked-repeatedly'
      readonly count: number
      readonly rest: readonly CallRef[]
    }
  | { readonly kind: 'usage-limit'; readonly tokenLimit: number; readonly rest: readonly CallRef[] }
  | { readonly kind: 'stopped' }

export async function runBatch(ctx: BatchContext): Promise<BatchResult> {
  const judge: JudgeContext = {
    ...ctx,
    searchHost: ctx.search?.host ?? null,
    prepareSearch: ctx.search?.prepareQuery,
  }
  let denials = ctx.denials
  const group = await runGroup(ctx, judge)
  if (group.stopped) {
    // Stopped while judging a call: no decision fact for it, it and the rest not-run (B1).
    await closeRest(ctx, ctx.calls.slice(group.closed), 'stopped')
    return { kind: 'stopped' }
  }
  if (group.closed > 0) denials = 0
  for (let k = group.closed; k < ctx.calls.length; k += 1) {
    const call = ctx.calls[k] as CompleteCall
    const ref = refOf(ctx, call)
    if (ctx.signal.aborted) {
      // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
      await closeRest(ctx, ctx.calls.slice(k), 'stopped')
      return { kind: 'stopped' }
    }
    const item = ctx.table.items.find((candidate) => candidate.name === call.name)
    let verdict = item === undefined ? null : ctx.validator.check(item, call.input)
    if (verdict?.ok && item?.source === 'builtin' && item.originalName === 'WebSearch') {
      const prepared = ctx.search?.prepareQuery(String(call.input['query']))
      const approved =
        ctx.approved?.ordinal === call.ordinal ? ctx.approved.searchTarget : undefined
      if (
        ctx.search === null ||
        (ctx.approved?.ordinal === call.ordinal &&
          (approved === undefined ||
            approved.host !== ctx.search.host ||
            approved.query !== prepared?.query))
      ) {
        verdict = { ok: false, source: 'tool-unavailable', reason: SEARCH_TEXTS.changed }
      } else {
        // oxlint-disable-next-line no-await-in-loop -- quota includes preceding dispatches in this batch
        if ((await searchDispatchCount(ctx.tape, ctx.sessionId)) >= 200)
          verdict = { ok: false, source: 'tool-unavailable', reason: SEARCH_TEXTS.quota }
      }
    }
    // AskUserQuestion runs nothing: allowed, it pauses the Run for the answer (H6). One the user
    // allowed on a card — a policy that asks about it, which 02's product never has (open question
    // 15) — is looked up as any other tool.
    const executor =
      item === undefined || verdict?.ok !== true
        ? null
        : item.source === 'builtin' && item.originalName === 'Agent' && ctx.agent !== undefined
          ? 'agent'
          : isQuestion(item) && ctx.approved?.ordinal !== call.ordinal
            ? 'question'
            : executorFor({ item, mcpSources: ctx.mcpSources, testTools: ctx.testTools })
    if (item === undefined || verdict === null || !verdict.ok || executor === null) {
      const invalid = verdict !== null && !verdict.ok ? verdict : null
      try {
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
        await close(ctx, call, await unrunnableFacts(ctx, ref, invalid))
      } catch (error) {
        if (!(error instanceof RunWriteRefusedError)) throw error
        // A stop reached this closure's write first: the call was never dispatched, so it and the
        // rest close as stopped (§点停止时各状态怎么收: 同批后面还没派发的调用一律记 not-run / stopped).
        // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
        await closeRest(ctx, ctx.calls.slice(k), 'stopped')
        return { kind: 'stopped' }
      }
      continue
    }
    // The group's cut, judged already: that judgement stands, with the session it read (no inspector
    // runs twice for one call).
    const held = group.cut?.call === call ? group.cut : undefined
    try {
      // Each call reads the session as the calls before it left it, the workspace included: a folder
      // removed meanwhile is judged by the new list at once (D11).
      // oxlint-disable-next-line no-await-in-loop -- the view reads what the calls before this one wrote
      const facts = held?.facts ?? (await callFactsOf(ctx))
      if (ctx.approved?.ordinal === call.ordinal && executor !== 'question') {
        // Allowed on its card: dispatched on the decision the answer resolved, not judged again.
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
        const command = await commandRunOf(ctx, call, item, facts)
        if (command === 'stopped') {
          // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
          await closeRest(ctx, ctx.calls.slice(k), 'stopped')
          return { kind: 'stopped' }
        }
        const dispatch = dispatchEntryFor(ctx, call, ctx.approved.decisionKey)
        // oxlint-disable-next-line no-await-in-loop -- T1: the side effect waits for its dispatch to commit
        const repair =
          // oxlint-disable-next-line no-await-in-loop -- serial dispatch commits before execution
          executor === 'agent' ? null : await dispatchOnce(ctx, call, item, [dispatch], dispatch)
        if (repair !== null) {
          // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
          await close(ctx, call, repair)
          continue
        }
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
        if (executor === 'agent') {
          // oxlint-disable-next-line no-await-in-loop -- the parent waits for its single child
          const child = await ctx.agent!({
            dispatch: [dispatch],
            call: ref,
            input: call.input,
            table: ctx.table,
            reversibility: ctx.approved.reversibility,
            summary: ctx.approved.summary,
          })
          if (child.kind === 'paused')
            return {
              kind: 'paused',
              waitingFor: 'subagent',
              withTerminal: [],
              waiting: ctx.calls.slice(k).map((c) => refOf(ctx, c)),
            }
          // oxlint-disable-next-line no-await-in-loop -- handoff becomes the original Agent result
          await closeHandoff(ctx, call, child, ctx.approved.summary)
          const budget = ctx.budgetExceeded?.() ?? null
          if (budget !== null)
            return {
              kind: 'usage-limit',
              tokenLimit: budget,
              rest: ctx.calls.slice(k + 1).map((c) => refOf(ctx, c)),
            }
          denials = 0
          continue
        }
        // oxlint-disable-next-line no-await-in-loop -- serial calls preserve model order
        const blocked = await execute(ctx, call, item, executor, {
          reversibility: ctx.approved.reversibility,
          summary: ctx.approved.summary,
          target: ctx.approved.target,
          scope: facts.scope,
          command,
        })
        denials = blocked ? denials + 1 : 0
        if (denials >= MACHINE_DENIAL_CAP) {
          return {
            kind: 'blocked-repeatedly',
            count: denials,
            rest: ctx.calls.slice(k + 1).map((later) => refOf(ctx, later)),
          }
        }
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- the view reads what the calls before this one wrote
      const judged = held?.judged ?? (await judgeCall(judge, item, call, facts))
      if (judged.kind === 'stopped') {
        // Stopped while judging: no decision fact, the call and the rest not-run (B1).
        // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
        await closeRest(ctx, ctx.calls.slice(k), 'stopped')
        return { kind: 'stopped' }
      }
      const { decision } = judged
      const decisionKey = permissionDecidedKey(ctx.runId, ctx.requestSeq, call.ordinal)
      const answerWaits = executor === 'question' && decision.record.verdict === 'allow'
      const decided = decisionEntry({
        ...ctx,
        ref,
        argsHash: call.argsHash,
        judged,
        key: decisionKey,
        ...(answerWaits ? { awaits: 'question' as const } : {}),
      })
      if (decision.record.verdict === 'deny') {
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
        await close(ctx, call, [decided, ...blockFacts(ctx, ref, judged)])
        denials += 1
        if (denials >= MACHINE_DENIAL_CAP) {
          const rest = ctx.calls.slice(k + 1).map((later) => refOf(ctx, later))
          return { kind: 'blocked-repeatedly', count: denials, rest }
        }
        continue
      }
      if (decision.record.verdict === 'ask') {
        // The card waits; the rest of the batch waits with it (§等待模型).
        const waiting = ctx.calls.slice(k).map((rest) => refOf(ctx, rest))
        return { kind: 'paused', waitingFor: 'approval', withTerminal: [decided], waiting }
      }
      if (executor === 'question') {
        // Allowed, and it waits for the user's answer: its decision `awaits: 'question'`, with the
        // Run's `paused` terminal (同批规则 1); the rest of the batch waits with it. No dispatch:
        // the answer is its result (H6).
        const waiting = ctx.calls.slice(k).map((rest) => refOf(ctx, rest))
        return { kind: 'paused', waitingFor: 'question', withTerminal: [decided], waiting }
      }
      // ----- allowed: decision and dispatch first (T1), then the side effect -----------------------
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
      const command = await commandRunOf(ctx, call, item, facts)
      if (command === 'stopped') {
        // Stopped before the dispatch: no decision fact, the call and the rest not-run (B1).
        // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
        await closeRest(ctx, ctx.calls.slice(k), 'stopped')
        return { kind: 'stopped' }
      }
      const dispatch = dispatchEntryFor(ctx, call, decisionKey)
      // oxlint-disable-next-line no-await-in-loop -- T1: the side effect waits for its dispatch to commit
      const repair =
        executor === 'agent'
          ? null
          : // oxlint-disable-next-line no-await-in-loop -- serial dispatch commits before execution
            await dispatchOnce(ctx, call, item, [decided, dispatch], dispatch)
      if (repair !== null) {
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
        await close(ctx, call, repair)
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
      if (executor === 'agent') {
        // oxlint-disable-next-line no-await-in-loop -- the parent waits for its single child
        const child = await ctx.agent!({
          dispatch: [decided, dispatch],
          call: ref,
          input: call.input,
          table: ctx.table,
          reversibility: judged.reversibility,
          summary: decision.summary,
        })
        if (child.kind === 'paused')
          return {
            kind: 'paused',
            waitingFor: 'subagent',
            withTerminal: [],
            waiting: ctx.calls.slice(k).map((c) => refOf(ctx, c)),
          }
        // oxlint-disable-next-line no-await-in-loop -- handoff becomes the original Agent result
        await closeHandoff(ctx, call, child, decision.summary)
        const budget = ctx.budgetExceeded?.() ?? null
        if (budget !== null)
          return {
            kind: 'usage-limit',
            tokenLimit: budget,
            rest: ctx.calls.slice(k + 1).map((c) => refOf(ctx, c)),
          }
        denials = 0
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- serial calls preserve model order
      const blocked = await execute(ctx, call, item, executor, {
        reversibility: judged.reversibility,
        summary: decision.summary,
        target: judged.target,
        scope: facts.scope,
        command,
      })
      denials = blocked ? denials + 1 : 0
      if (denials >= MACHINE_DENIAL_CAP) {
        return {
          kind: 'blocked-repeatedly',
          count: denials,
          rest: ctx.calls.slice(k + 1).map((later) => refOf(ctx, later)),
        }
      }
    } catch (error) {
      if (!(error instanceof RunWriteRefusedError)) throw error
      // A stop reached the decision's or the dispatch's write first: neither is written, and the
      // call and the rest close as a stop while judging would (§点停止时各状态怎么收).
      // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
      await closeRest(ctx, ctx.calls.slice(k), 'stopped')
      return { kind: 'stopped' }
    }
  }
  return { kind: 'done', denials }
}

type Judged = Extract<Judgement, { kind: 'judged' }>

/** What the parallel group leaves the serial pass. */
interface GroupEnd {
  /** How many calls, from the first, it dispatched and closed. */
  readonly closed: number
  /** A stop came while it judged the next call: no decision for it (B1). */
  readonly stopped: boolean
  /** The call it was cut before, when judging it was what told: that judgement stands. */
  readonly cut?: { readonly call: CompleteCall; readonly judged: Judged; readonly facts: CallFacts }
}

/**
 * The parallel group (§一批工具怎么执行 第 2、5 步; H14): from the reply's first call, each adjacent call
 * that is a builtin Read, Glob or Grep with valid arguments and an executor, judged allow as a
 * workspace read (`canRunInParallel`). Each is judged on the session as the members before it left
 * it — their dispatches on the Tape, which the inspectors' view counts (§挂点与会话视图) — then its
 * decision and dispatch are written and at once its side effect begins (T1); the next is judged
 * without waiting for it to end. Their closures are made as they end — on a stop, each with its own
 * write wait counted from the stop (§点停止时各状态怎么收「进程内写操作」) — and written in `<i>` order.
 *
 * The first call that does not qualify is the cut; when judging it was what told, its judgement is
 * kept for the serial pass, so no inspector runs twice for one call. No group for a resumed batch — its
 * first call is the card's, or one after it: past the cut — nor in the chat profile, which has no
 * workspace (F6, E4). A stop before a member's dispatch, or one that reached its write first,
 * dispatches no more: the serial pass closes the rest, not-run / stopped, after these closures.
 */
async function runGroup(ctx: BatchContext, judge: JudgeContext): Promise<GroupEnd> {
  const closures: Array<{
    readonly call: CompleteCall
    readonly facts: Promise<readonly NewEntry[]>
    readonly summary?: DecisionSummary
  }> = []
  let end: Omit<GroupEnd, 'closed'> = { stopped: false }
  const leading = ctx.approved === undefined && ctx.calls[0]?.ordinal === 0
  for (const call of leading ? ctx.calls : []) {
    if (ctx.signal.aborted) break
    const item = ctx.table.items.find((candidate) => candidate.name === call.name)
    if (
      item === undefined ||
      item.source !== 'builtin' ||
      !PARALLEL_TOOL_NAMES.has(item.originalName) ||
      !ctx.validator.check(item, call.input).ok
    ) {
      break
    }
    const executor = executorFor({ item, mcpSources: ctx.mcpSources, testTools: ctx.testTools })
    if (executor === null) break
    // oxlint-disable-next-line no-await-in-loop -- the view reads the dispatches before this call's
    const facts = await callFactsOf(ctx)
    if (facts.profile !== 'cowork') break
    // oxlint-disable-next-line no-await-in-loop -- judged in the model's order, as the serial pass would
    const judged = await judgeCall(judge, item, call, facts)
    if (judged.kind === 'stopped') {
      end = { stopped: true }
      break
    }
    if (!canRunInParallel(inspectedOf(item, call.input, judged.reversibility), judged.decision)) {
      end = { stopped: false, cut: { call, judged, facts } }
      break
    }
    const decisionKey = permissionDecidedKey(ctx.runId, ctx.requestSeq, call.ordinal)
    const decided = decisionEntry({
      ...ctx,
      ref: refOf(ctx, call),
      argsHash: call.argsHash,
      judged,
      key: decisionKey,
    })
    const dispatch = dispatchEntryFor(ctx, call, decisionKey)
    let repair: readonly NewEntry[] | null
    try {
      // oxlint-disable-next-line no-await-in-loop -- T1: each side effect waits for its own dispatch
      repair = await dispatchOnce(ctx, call, item, [decided, dispatch], dispatch)
    } catch (error) {
      if (!(error instanceof RunWriteRefusedError)) throw error
      break
    }
    if (repair !== null) {
      closures.push({ call, facts: Promise.resolve(repair) })
      continue
    }
    const closure = perform(ctx, call, item, executor, {
      reversibility: judged.reversibility,
      summary: judged.decision.summary,
      target: judged.target,
      scope: facts.scope,
      command: undefined,
    })
    // Awaited below, in <i> order; handled now, so one that rejects while an earlier one is awaited is
    // not reported unhandled — the first rejection awaited ends the batch.
    closure.catch(noRejection)
    closures.push({ call, facts: closure, summary: judged.decision.summary })
  }
  for (const closure of closures) {
    // oxlint-disable-next-line no-await-in-loop -- tool/result and tool_outcome are written in <i> order
    await close(ctx, closure.call, await closure.facts, closure.summary)
  }
  return { closed: closures.length, ...end }
}

/** A rejection seen where the promise is awaited, not here. */
function noRejection(): void {}

/**
 * The closure of a call that cannot run (steps 1–3): not-run, blocked, with no decision. The reason,
 * when there is one, is its second text block — for `invalid-input` the validator's message, which
 * echoes the schema (a connector's enum of thousands) and has no bound — so it passes the one spill
 * check as any other result does (§大响应落盘「判断点只有一个」).
 */
async function unrunnableFacts(
  ctx: BatchContext,
  ref: CallRef,
  invalid: Extract<ValidationVerdict, { ok: false }> | null,
): Promise<NewEntry[]> {
  const source = invalid?.source ?? 'tool-unavailable'
  const checked = await spillChecked({
    fs: ctx.host.fs,
    profileDir: ctx.host.identity.profileDir as AbsolutePath,
    sessionId: ctx.sessionId,
    call: ref,
    result: {
      content: closureContent({
        source,
        state: 'not-run',
        ...(invalid === null ? {} : { detail: invalid.reason }),
      }),
      isError: true,
      kernelAuthored: true,
    },
    log: ctx.log,
  })
  return resultFacts({
    tape: ctx.tape,
    now: ctx.now,
    call: ref,
    content: checked.content,
    isError: checked.isError,
    kernelAuthored: checked.kernelAuthored,
    ...(checked.spill === undefined ? {} : { spill: checked.spill }),
    effect: 'blocked',
    state: 'not-run',
    source,
    // No decision fact: unknown (§载荷 ToolOutcomePayload.reversibility).
    reversibility: 'unknown',
    writer: ctx.writer,
  })
}

function refOf(ctx: Pick<BatchContext, 'runId' | 'requestSeq'>, call: CompleteCall): CallRef {
  return {
    runId: ctx.runId,
    requestSeq: ctx.requestSeq,
    ordinal: call.ordinal,
    providerToolCallId: call.providerToolCallId,
  }
}

function dispatchEntryFor(ctx: BatchContext, call: CompleteCall, decisionKey: string): NewEntry {
  const payload: DispatchCommittedPayload = {
    ordinal: call.ordinal,
    providerToolCallId: call.providerToolCallId,
    name: call.name,
    argsHash: call.argsHash,
    decisionKey,
    writer: ctx.writer,
  }
  return ctx.tape.writer('execution').entry('execution/dispatch_committed', {
    sourceType: 'runtime_event',
    sourceId: ctx.runId,
    sourceSeq: ctx.requestSeq,
    provenanceKey: dispatchCommittedKey(ctx.runId, ctx.requestSeq, call.ordinal),
    payload,
    createdAt: ctx.now(),
  })
}

/** What running an allowed call needs beside the call: its decision's reading of it. */
interface Performed {
  readonly reversibility: Reversibility
  readonly summary: DecisionSummary
  readonly target: AbsolutePath | null
  readonly scope: PathScope
  readonly command: CommandRun | undefined
}

/** The side effect, then its result and outcome (`perform`), written. */
async function execute(
  ctx: BatchContext,
  call: CompleteCall,
  item: ToolTableItem,
  executor: ToolExecutor,
  q: Performed,
): Promise<boolean> {
  const facts = await perform(ctx, call, item, executor, q)
  await close(ctx, call, facts, q.summary)
  return facts.some(
    (entry) => entry.name === 'execution/tool_outcome' && entry.payload['source'] === 'protected',
  )
}

/**
 * The side effect, and the result and outcome it leaves, not yet written. A file tool acts on the real
 * path its decision placed (§「在不在工作区里」第 5 步). A call stopped while it ran gets the note of the
 * abort's cause — `stopped` for a user-stop, `app-exit` for a quit or a closed window (§原因码表, B4) —
 * with whatever it had produced as the second block (§点停止时各状态怎么收); a Bash timeout stays
 * `timed-out`, a stop after its kill began included. A call that ended normally before its closure is
 * recorded as it ended. The write wait begins listening for the stop the moment this is called.
 * Every executed call's result passes the spill check before it is built (§大响应落盘; so does the
 * closure of a call whose arguments failed, which carries the validator's message — the batch's
 * other closures are the kernel's fixed notes, which never reach the threshold): a group member
 * spills as it ends, and its result is still written in call order.
 */
async function perform(
  ctx: BatchContext,
  call: CompleteCall,
  item: ToolTableItem,
  executor: ToolExecutor,
  q: Performed,
): Promise<NewEntry[]> {
  const running = executor({
    item,
    input: call.input,
    signal: ctx.signal,
    target: q.target,
    scope: q.scope,
    fs: ctx.host.fs,
    clock: ctx.host.clock,
    ...(ctx.search === null ? {} : { search: ctx.search }),
    ...(item.source === 'builtin' && item.originalName === 'WebFetch'
      ? {
          webFetch: {
            fetch: ctx.host.network.fetchUntrusted,
            canFollow: async (url: string) => {
              const judged = await judgeCall(
                { ...ctx, searchHost: ctx.search?.host ?? null },
                item,
                { input: { url } },
              )
              return judged.kind === 'judged' && judged.decision.record.verdict === 'allow'
            },
          },
        }
      : {}),
    ...(q.command === undefined ? {} : { command: q.command }),
  })
  const execution = inProcess(item) ? await withinWriteWait(ctx, call, running) : await running
  const stopped = execution.state !== 'completed'
  // A Bash timeout is its own code; every other call that did not complete was aborted, by a stop or
  // by the shutdown.
  const source = stopped ? (execution.source ?? abortSourceOf(ctx.cause())) : null
  const output = textOf(execution.content)
  const ref = refOf(ctx, call)
  // The one spill check, on what is about to be written (§大响应落盘): a command's output after its
  // stop note is spilled like any other text.
  const checked = await spillChecked({
    fs: ctx.host.fs,
    profileDir: ctx.host.identity.profileDir as AbsolutePath,
    sessionId: ctx.sessionId,
    call: ref,
    result: {
      content:
        source === null
          ? execution.content
          : closureContent({
              source,
              state: execution.state,
              ...(execution.facts === undefined ? {} : { facts: execution.facts }),
              ...(output === '' ? {} : { detail: output }),
            }),
      isError: stopped || execution.isError,
      kernelAuthored: stopped,
    },
    log: ctx.log,
  })
  return resultFacts({
    tape: ctx.tape,
    now: ctx.now,
    call: ref,
    content: checked.content,
    isError: checked.isError,
    kernelAuthored: checked.kernelAuthored,
    ...(checked.spill === undefined ? {} : { spill: checked.spill }),
    ...(execution.searchHitUrls === undefined ? {} : { searchHitUrls: execution.searchHitUrls }),
    effect: execution.state === 'not-run' ? 'blocked' : effectOf(item),
    ...(execution.facts === undefined ? {} : { facts: execution.facts }),
    state: execution.state,
    source,
    reversibility: q.reversibility,
    writer: ctx.writer,
  })
}

/** A dispatched call's source when the abort ended it: its cause's (§原因码表 `stopped`, `app-exit`). */
function abortSourceOf(cause: RunAbortCause): 'stopped' | 'app-exit' {
  return cause === 'user-stop' ? 'stopped' : 'app-exit'
}

/**
 * The builtin tools that act in process, through `HostFs` (§点停止时各状态怎么收「进程内写操作」):
 * the file tools. Bash has its own kill sequence; a connector call is another process's.
 */
function inProcess(item: ToolTableItem): boolean {
  return item.source === 'builtin' && FILE_TOOL_NAMES.has(item.originalName)
}

/**
 * An in-process call a stop cannot interrupt (§点停止时各状态怎么收「进程内写操作」): `HostFs` takes no
 * AbortSignal, so once the stop lands the closure waits for the call at most `STOP_WRITE_WAIT_MS` on
 * the host clock. Done in time, it is what the call returned — its real end; past the wait, it is
 * uncertain, and what the call returns later is never written — the closure written first counts
 * (§写入：谁写、写几次「先写者算数」) — only logged, once, whether it returns or throws.
 */
async function withinWriteWait(
  ctx: BatchContext,
  call: CompleteCall,
  running: Promise<ToolExecution>,
): Promise<ToolExecution> {
  const { signal } = ctx
  const late = Promise.withResolvers<'late'>()
  const wait = { cancel: noTimer }
  const onStop = (): void => {
    wait.cancel = ctx.host.clock.setTimeout(() => late.resolve('late'), STOP_WRITE_WAIT_MS)
  }
  if (signal.aborted) onStop()
  else signal.addEventListener('abort', onStop, { once: true })
  let first: ToolExecution | 'late'
  try {
    first = await Promise.race([running, late.promise])
  } finally {
    signal.removeEventListener('abort', onStop)
    wait.cancel()
  }
  if (first !== 'late') return first
  const key = `${ctx.runId}:${String(ctx.requestSeq)}:${String(call.ordinal)}`
  const dropped = `[loop] ${call.name} call ${key} was closed uncertain after ${String(STOP_WRITE_WAIT_MS)} ms; what it`
  void running.then(
    (ended) => ctx.log(`${dropped} returned later (${ended.state}) is not written`),
    (error: unknown) =>
      ctx.log(
        `${dropped} threw later is not written: ${error instanceof Error ? error.message : String(error)}`,
      ),
  )
  return { content: [], isError: true, state: 'uncertain' }
}

/** No timer set yet: nothing to cancel. */
function noTimer(): void {}

/**
 * What a Bash call runs with, gathered before its dispatch (§内置工具与参数「Bash」): the base
 * environment `commandShell.env()` resolves to, awaited in a race with the stop, and the workspace it
 * runs in; `'stopped'` when the stop came first — the call is not run. Undefined for every other tool.
 * The host's `env()` does not reject (it falls back to the launch environment and logs).
 */
async function commandRunOf(
  ctx: BatchContext,
  call: CompleteCall,
  item: ToolTableItem,
  facts: CallFacts,
): Promise<CommandRun | 'stopped' | undefined> {
  if (item.source !== 'builtin' || item.originalName !== 'Bash') return undefined
  const { signal } = ctx
  if (signal.aborted) return 'stopped'
  const stop = Promise.withResolvers<'stopped'>()
  const onStop = (): void => stop.resolve('stopped')
  signal.addEventListener('abort', onStop, { once: true })
  let env: Readonly<Record<string, string>> | 'stopped'
  try {
    env = await Promise.race([ctx.commandShell.env(), stop.promise])
  } finally {
    signal.removeEventListener('abort', onStop)
  }
  if (env === 'stopped' || signal.aborted) return 'stopped'
  return {
    commandId: call.providerToolCallId,
    shell: ctx.commandShell.path,
    env,
    folders: facts.scope.roots,
    dedicated: facts.workspace?.origin === 'dedicated',
    host: ctx.host,
  }
}

/** A denial's closure: its block code and slots, or a failed inspector's own note (F1). */
export function blockFacts(
  ctx: Pick<BatchContext, 'tape' | 'now' | 'writer'>,
  ref: CallRef,
  judged: Extract<Judgement, { kind: 'judged' }>,
): NewEntry[] {
  const block = judged.decision.block
  if (block === undefined) throw new Error('decide: a denial carries its block')
  return notRunFacts({
    tape: ctx.tape,
    now: ctx.now,
    call: ref,
    source: block.reason,
    facts: block.facts,
    ...(judged.failed === undefined ? {} : { inspectorStatus: judged.failed }),
    reversibility: judged.reversibility,
    writer: ctx.writer,
  })
}

/**
 * The decision and its `dispatch_committed`; null when the side effect may follow (T1). An append
 * that finds the same dispatch already committed (`created: false`) never dispatches it twice; a
 * `TapeProvenanceConflictError` — another writer's dispatch under this key — dispatches nothing
 * either, and the call closes as the recovery table's 损坏 (§执行日志与恢复表 T1). Tests and
 * development builds throw on both; the packaged build logs and answers the call's uncertain /
 * `repair` closure, for the caller to write in its place — announced like any closure.
 */
async function dispatchOnce(
  ctx: BatchContext,
  call: CompleteCall,
  item: ToolTableItem,
  entries: readonly NewEntry[],
  dispatchEntry: NewEntry,
): Promise<NewEntry[] | null> {
  const key = dispatchEntry.provenanceKey
  const repair = (): NewEntry[] =>
    repairFacts({
      tape: ctx.tape,
      now: ctx.now,
      call: refOf(ctx, call),
      dispatched: true,
      effect: effectOf(item),
      writer: ctx.writer,
    })
  let written: Written
  try {
    written = await ctx.write(entries)
  } catch (error) {
    if (!(error instanceof TapeProvenanceConflictError) || ctx.strict) throw error
    ctx.log(
      `[loop] dispatch ${key} conflicts with another writer's; not dispatched, closed as repair`,
    )
    return repair()
  }
  const at = written.entries.indexOf(dispatchEntry)
  if (written.receipts[at]?.created !== false) return null
  if (ctx.strict)
    throw new Error(`[loop] dispatch ${key} was already committed; it is never dispatched twice`)
  ctx.log(`[loop] dispatch ${key} was already committed; not dispatched again, closed as repair`)
  return repair()
}

/**
 * The interface's view of a closure a write committed: its outcome and its result, or null when
 * either did not land (a result another writer beat is dropped with its outcome, 先写者算数).
 */
export function closedView(
  written: readonly NewEntry[],
  permission?: DecisionSummary,
): ToolOutcomeView | null {
  const outcome = written.find((entry) => entry.name === 'execution/tool_outcome')?.payload as
    | Record<string, unknown>
    | undefined
  const result = written.find((entry) => entry.name === 'tool/result')?.payload as
    | Record<string, unknown>
    | undefined
  if (outcome === undefined || result === undefined) return null
  return {
    effect: outcome['effect'] as ToolOutcomeView['effect'],
    state: outcome['state'] as ToolOutcomeView['state'],
    source: (outcome['source'] ?? null) as ToolOutcomeView['source'],
    ...(outcome['facts'] === undefined
      ? {}
      : { facts: outcome['facts'] as Record<string, string> }),
    output: textOf(result['content']),
    ...(permission === undefined ? {} : { permission }),
    ...(result['handoff'] === undefined
      ? {}
      : { handoff: result['handoff'] as NonNullable<ToolOutcomeView['handoff']> }),
    ...(result['question'] === undefined
      ? {}
      : { question: result['question'] as NonNullable<ToolOutcomeView['question']> }),
  }
}

/** Writes a call's closing facts, then tells the interface — after the commit, never before. */
async function close(
  ctx: BatchContext,
  call: CompleteCall,
  entries: readonly NewEntry[],
  summary?: DecisionSummary,
): Promise<void> {
  const written = await ctx.write(entries)
  const denied = entries.find((entry) => entry.name === 'tool/permission_decided')?.payload as
    | PermissionDecidedPayload
    | undefined
  const view = closedView(written.entries, summary ?? denied?.summary)
  if (view !== null) ctx.outcome(call, view)
}

/**
 * The Agent call's result is its child's handoff. A stop that reached the write first leaves a
 * completed or partial handoff unwritten (the mailbox refuses it), and the aborted one goes instead;
 * the calls after it then close as stopped like any undispatched call (§停止、新消息、退出与重启).
 */
async function closeHandoff(
  ctx: BatchContext,
  call: CompleteCall,
  child: Extract<AgentDispatchResult, { kind: 'done' }>,
  summary: DecisionSummary,
): Promise<void> {
  try {
    await close(ctx, call, child.entries, summary)
  } catch (error) {
    if (!(error instanceof RunWriteRefusedError)) throw error
    await close(ctx, call, (await child.aborted()).entries, summary)
  }
}

/**
 * Closes calls that will not run, in order, all with one source. The approved call has the asking
 * decision it answered, whose reversibility it keeps; the rest have none, so `unknown` (§载荷
 * ToolOutcomePayload: 取判决事实里的值).
 */
async function closeRest(
  ctx: BatchContext,
  calls: readonly CompleteCall[],
  source: 'stopped',
): Promise<void> {
  for (const call of calls) {
    const facts = notRunFacts({
      tape: ctx.tape,
      now: ctx.now,
      call: refOf(ctx, call),
      source,
      ...(ctx.approved?.ordinal === call.ordinal
        ? { reversibility: ctx.approved.reversibility }
        : {}),
      writer: ctx.writer,
    })
    // oxlint-disable-next-line no-await-in-loop -- closures are written in <i> order
    await close(ctx, call, facts)
  }
}

// ----- judging one call (the batch, and the answer's re-judgement) ---------------------------------

/** What judging one call reads: the session's facts, the host's policy and each layer's input. */
export interface JudgeContext {
  readonly tape: Pick<Tape, 'readRange'>
  readonly host: HostAdapter
  readonly sessionId: string
  readonly inspectors: readonly InspectorRegistration[]
  readonly protectedFiles: readonly AbsolutePath[]
  readonly userSetting: (key: ToolKey) => UserToolSetting | null
  /** The search backend's host, for WebSearch's card, grant and reason; null without one. */
  readonly searchHost: string | null
  readonly prepareSearch?: ((query: string) => { query: string; truncated: boolean }) | undefined
  readonly ignoreSearchGrant?: boolean
  readonly signal: AbortSignal
}

export type Judgement =
  | { readonly kind: 'stopped' }
  | {
      readonly kind: 'judged'
      readonly decision: Decision
      readonly reversibility: Reversibility
      readonly place?: PathPlace
      /** Where a file tool acts, when it runs: the real path the decision placed; null otherwise. */
      readonly target: AbsolutePath | null
      readonly policyVersion: string
      /** The card's kind and object, when it asks. */
      readonly decisionTarget?: ConfirmTarget
      readonly card?: Pick<NonNullable<PermissionDecidedPayload['confirm']>, 'kind' | 'target'>
      /** What an allowed answer grants (§作用域与授权键); null when nothing but this call would. */
      readonly grantObject: GrantObject | null
      /** The deciding inspector's failure, when it did not answer (F1). */
      readonly failed?: 'timeout' | 'error'
    }

/**
 * One call's decision (§权限决策顺序): every layer's state computed from the Tape and the host, the
 * inspectors first — a stop while they run gives no decision at all — then `decide()`.
 */
export async function judgeCall(
  ctx: JudgeContext,
  item: ToolTableItem,
  call: Pick<CompleteCall, 'input'>,
  given?: CallFacts,
): Promise<Judgement> {
  const facts = given ?? (await callFactsOf(ctx))
  const { entries, profile, scope: paths } = facts
  const reversibility = reversibilityOf(item, call.input)
  const located = await locate(ctx.host, item, call.input, paths)
  const place = located === undefined ? undefined : placeFor(profile, located)
  const inspected = inspectedOf(item, call.input, reversibility)
  const ownView = buildSessionView(entries, {
    call: inspected,
    profile,
    ownSpillDir: paths.ownSpillDir,
    child: sessionFactsOf(entries).subagentOf !== null,
  })
  const related = buildSessionView(facts.relatedEntries ?? [], {
    call: inspected,
    profile: 'cowork',
    ownSpillDir: paths.ownSpillDir,
    child: true,
  })
  const parentView = buildSessionView(facts.parentEntries ?? [], {
    call: inspected,
    profile: 'cowork',
    ownSpillDir: paths.ownSpillDir,
    child: true,
  })
  const view = {
    ...ownView,
    nonReadOnlyCalls: [...ownView.nonReadOnlyCalls, ...related.nonReadOnlyCalls],
    untrustedSources: [...new Set([...ownView.untrustedSources, ...related.untrustedSources])],
    touchedPrivateData: ownView.touchedPrivateData || related.touchedPrivateData,
    ...(ownView.fetchUrlVouched === undefined
      ? {}
      : { fetchUrlVouched: ownView.fetchUrlVouched || parentView.fetchUrlVouched === true }),
  }
  const urlBlocked =
    item.source === 'builtin' &&
    item.originalName === 'WebFetch' &&
    isBlockedFetchUrl(String(call.input['url'] ?? ''))
  const inspection = urlBlocked
    ? { stopped: false, outcomes: [] }
    : await runInspectors({
        inspectors: ctx.inspectors,
        input: { call: inspected, view },
        setTimeout: (fn, ms) => ctx.host.clock.setTimeout(fn, ms),
        signal: ctx.signal,
      })
  if (inspection.stopped) return { kind: 'stopped' }
  const policy = ctx.host.policy.current()
  const workspace = paths.roots[0] ?? null
  const callReason = callReasonOf({
    tool: item,
    args: call.input,
    ...(place === undefined ? {} : { place }),
    ...(located === undefined ? {} : { real: located.real }),
    workspace,
    searchHost: ctx.searchHost,
  })
  const setting =
    item.source === 'mcp'
      ? ctx.userSetting({
          tenantId: ctx.host.identity.tenantId,
          serverId: item.serverId,
          toolName: item.originalName,
        })
      : null
  const object = grantObjectOf(item, call.input, located, workspace, ctx.searchHost)
  const ownGrant =
    object === null || (item.originalName === 'WebSearch' && ctx.ignoreSearchGrant === true)
      ? undefined
      : ownSessionGrants(entries, facts.parentEntries ?? []).get(
          grantKey(item.serverId, item.originalName, object),
        )
  const inheritedGrant =
    object === null || (item.originalName === 'WebSearch' && ctx.ignoreSearchGrant === true)
      ? undefined
      : sessionGrants(grantFactsOf(facts.parentEntries ?? [])).get(
          grantKey(item.serverId, item.originalName, object),
        )
  const grantFrom = ownGrant ?? inheritedGrant
  const decision = decide({
    call: inspected,
    callReason,
    layers: {
      policy,
      ...(urlBlocked ? { urlBlocked: true as const } : {}),
      ...(place === undefined ? {} : { place }),
      ...(setting?.connectorOff === undefined ? {} : { connectorOff: setting.connectorOff }),
      ...(setting?.userSetting === undefined ? {} : { userSetting: setting.userSetting }),
      reversibility: { value: reversibility, source: 'host' },
      requiresUserInteraction: item.requiresUserInteraction,
      sessionGrant:
        grantFrom === undefined || object === null
          ? null
          : {
              kind: sessionGrantKindOf(object),
              grantFrom,
              ...(ownGrant === undefined && inheritedGrant !== undefined
                ? { inherited: true as const }
                : {}),
            },
      approvalMode: 'manual',
    },
    inspectors: inspection.outcomes,
  })
  const failed = decision.record.decidedBy === 'inspector' ? failedStatusOf(decision) : undefined
  return {
    kind: 'judged',
    decision,
    reversibility,
    ...(place === undefined ? {} : { place }),
    target: located?.real ?? null,
    policyVersion: policy.status === 'unavailable' ? 'unavailable' : policy.version,
    decisionTarget: cardOf(
      item,
      item.originalName === 'WebSearch' && ctx.prepareSearch !== undefined
        ? { ...call.input, query: ctx.prepareSearch(String(call.input['query'])).query }
        : call.input,
      located,
      workspace,
      ctx.searchHost,
    ).target,
    ...(decision.record.verdict === 'ask'
      ? {
          card: cardOf(
            item,
            item.originalName === 'WebSearch' && ctx.prepareSearch !== undefined
              ? { ...call.input, query: ctx.prepareSearch(String(call.input['query'])).query }
              : call.input,
            located,
            workspace,
            ctx.searchHost,
          ),
        }
      : {}),
    grantObject: object,
    ...(failed === undefined ? {} : { failed }),
  }
}

/** A call as the inspectors and the parallel group's test see it. */
function inspectedOf(
  item: ToolTableItem,
  args: Record<string, unknown>,
  reversibility: Reversibility,
): InspectedCall {
  return {
    tool: {
      name: item.name,
      source: item.source,
      serverId: item.serverId,
      originalName: item.originalName,
    },
    args,
    reversibility,
  }
}

/** A `tool/permission_decided`: the first decision of a call, or a re-judgement (`rejudge`). */
export function decisionEntry(q: {
  readonly tape: Tape
  readonly now: () => number
  readonly ref: CallRef
  readonly argsHash: string
  readonly judged: Extract<Judgement, { kind: 'judged' }>
  readonly key: string
  readonly rejudge?: number
  /** An allowed AskUserQuestion: the Run pauses on it until the answer (H6). */
  readonly awaits?: 'question'
  readonly writer: FactWriter
}): NewEntry {
  const { decision } = q.judged
  const payload: PermissionDecidedPayload = {
    ordinal: q.ref.ordinal,
    providerToolCallId: q.ref.providerToolCallId,
    argsHash: q.argsHash,
    reversibility: q.judged.reversibility,
    record: decision.record,
    summary: decision.summary,
    policyVersion: q.judged.policyVersion,
    ...(q.judged.decisionTarget === undefined ? {} : { target: q.judged.decisionTarget }),
    ...(decision.confirm !== undefined && q.judged.card !== undefined
      ? { confirm: { ...decision.confirm, ...q.judged.card }, awaits: 'approval' as const }
      : {}),
    ...(decision.block === undefined ? {} : { block: decision.block }),
    ...(q.awaits === undefined ? {} : { awaits: q.awaits }),
    ...(q.rejudge === undefined ? {} : { rejudge: q.rejudge }),
    writer: q.writer,
  }
  return q.tape.writer('tool').entry('tool/permission_decided', {
    sourceType: 'runtime_event',
    sourceId: q.ref.runId,
    sourceSeq: q.ref.requestSeq,
    provenanceKey: q.key,
    payload,
    createdAt: q.now(),
  })
}

/**
 * What judging one call reads off the session, read once per call: its facts in Tape order, its
 * profile (`session/profile_set`; phase 1's sessions are chats) and where its paths are judged from.
 */
export interface CallFacts {
  readonly parentEntries?: readonly TapeEntry[]
  readonly relatedEntries?: readonly TapeEntry[]
  readonly entries: readonly TapeEntry[]
  readonly profile: 'chat' | 'cowork'
  readonly scope: PathScope
  /** The workspace facts the scope's roots come from; null in the chat profile. */
  readonly workspace: WorkspaceSetPayload | null
}

export async function callFactsOf(
  ctx: Pick<JudgeContext, 'tape' | 'host' | 'sessionId' | 'protectedFiles'>,
): Promise<CallFacts> {
  const entries = await readSessionEntries(ctx.tape, ctx.sessionId)
  const facts = sessionFactsOf(entries)
  const workspace = await workspaceOf(ctx.tape, facts)
  const parentEntries =
    facts.subagentOf === null ? [] : await readSessionEntries(ctx.tape, facts.subagentOf.sessionId)
  const relatedEntries: TapeEntry[] = [...parentEntries]
  {
    const handed = new Set(
      (facts.subagentOf === null ? entries : parentEntries)
        .filter((e) => e.name === 'tool/result' && e.payload['handoff'] !== undefined)
        .map((e) => (e.payload['handoff'] as { childSessionId: string }).childSessionId),
    )
    for (const child of handed) {
      // oxlint-disable-next-line no-await-in-loop -- one linked child at a time, never model text
      relatedEntries.push(...(await readSessionEntries(ctx.tape, child)))
    }
  }
  return {
    entries,
    parentEntries,
    relatedEntries,
    profile: facts.profile,
    scope: await pathScopeOf(ctx, workspace),
    workspace,
  }
}

/**
 * Where file paths are judged from: the workspace roots (real already: resolved when they were
 * chosen), the profile, the protected files — all resolved — and this session's spill, which is not:
 * it is `tool-output/<sessionId>` under the resolved profile, as written. A link planted at
 * `tool-output` or at `<sessionId>` leads elsewhere, and what is read through it is placed as that
 * place — the profile, a protected file, outside — never as the spill's free read (§「在不在工作区里」
 * 第 4 步; §大响应落盘「谁能读」: the one narrow way in). The chat profile has no workspace, so its
 * roots are empty.
 */
export async function pathScopeOf(
  ctx: Pick<JudgeContext, 'host' | 'sessionId' | 'protectedFiles'>,
  workspace: WorkspaceSetPayload | null,
): Promise<PathScope> {
  const fs = ctx.host.fs
  const profileDir = (await resolvePath(fs, ctx.host.identity.profileDir as AbsolutePath)).path
  const ownSpillDir = toolOutputDirFor(profileDir, ctx.sessionId)
  const protectedFiles = await Promise.all(
    ctx.protectedFiles.map(async (file) => (await resolvePath(fs, file)).path),
  )
  return { roots: workspace?.folders ?? [], profileDir, ownSpillDir, protectedFiles }
}

/** Where a file tool's path falls, as a decision places it; undefined for any other tool. */
export async function placeOf(
  ctx: Pick<JudgeContext, 'tape' | 'host' | 'sessionId' | 'protectedFiles'>,
  item: ToolTableItem,
  input: Record<string, unknown>,
): Promise<PathPlace | undefined> {
  const { profile, scope } = await callFactsOf(ctx)
  const located = await locate(ctx.host, item, input, scope)
  return located === undefined ? undefined : placeFor(profile, located)
}

/** A file tool's path, placed; Glob and Grep without a path search the first folder. */
async function locate(
  host: HostAdapter,
  item: ToolTableItem,
  input: Record<string, unknown>,
  scope: PathScope,
): Promise<PathVerdict | undefined> {
  if (item.source !== 'builtin' || !FILE_TOOL_NAMES.has(item.originalName)) return undefined
  const raw =
    input[item.originalName === 'Glob' || item.originalName === 'Grep' ? 'path' : 'file_path']
  const path = typeof raw === 'string' ? raw : scope.roots[0]
  if (path === undefined) return { real: scope.ownSpillDir, place: 'outside' }
  return locatePath(host.fs, path as AbsolutePath, scope)
}

/** In the chat profile, Read reaches only the session's own spill: anything else is protected (H1). */
function placeFor(profile: 'chat' | 'cowork', located: PathVerdict): PathVerdict['place'] {
  if (profile === 'chat' && located.place !== 'own-spill') return 'protected'
  return located.place
}

function grantObjectOf(
  item: ToolTableItem,
  input: Record<string, unknown>,
  located: PathVerdict | undefined,
  workspace: AbsolutePath | null,
  searchHost: string | null,
): GrantObject | null {
  if (item.source !== 'builtin') return null
  switch (item.originalName) {
    case 'Write':
    case 'Edit':
      return located === undefined ? null : { kind: 'file', path: located.real }
    case 'Bash':
      return workspace === null
        ? null
        : { kind: 'command', command: String(input['command'] ?? ''), cwd: workspace }
    case 'WebSearch':
      return searchHost === null ? null : { kind: 'search', host: searchHost }
    case 'WebFetch':
      return { kind: 'domain', host: hostOfUrl(String(input['url'] ?? '')) }
    default:
      return null
  }
}

/** The card's kind and object (§内置工具的默认档位「卡上对象」; §`ConfirmRequest` 只增两个必填成员). */
function cardOf(
  item: ToolTableItem,
  input: Record<string, unknown>,
  located: PathVerdict | undefined,
  workspace: AbsolutePath | null,
  searchHost: string | null,
): Pick<NonNullable<PermissionDecidedPayload['confirm']>, 'kind' | 'target'> {
  if (item.source === 'builtin') {
    if (FILE_TOOL_NAMES.has(item.originalName) && located !== undefined) {
      return { kind: 'file', target: { type: 'path', path: located.real } }
    }
    if (item.originalName === 'Bash') {
      return {
        kind: 'command',
        target: {
          type: 'command',
          command: String(input['command'] ?? ''),
          cwd: workspace ?? ('/' as AbsolutePath),
        },
      }
    }
    if (item.originalName === 'WebSearch') {
      return {
        kind: 'network',
        target: { type: 'search', query: String(input['query'] ?? ''), host: searchHost ?? '' },
      }
    }
    if (item.originalName === 'WebFetch') {
      return { kind: 'network', target: { type: 'url', url: String(input['url'] ?? '') } }
    }
  }
  return {
    kind: 'tool',
    target: { type: 'tool', serverId: item.serverId, toolName: item.originalName },
  }
}

/** What an executed call records: its tool's class; connector tools are external (§原因码表). */
export function effectOf(item: ToolTableItem): 'read' | 'write' | 'external' {
  if (item.source === 'builtin' && isBuiltinToolName(item.originalName))
    return BUILTIN_TOOLS[item.originalName].effect
  return 'external'
}

/** The builtin AskUserQuestion: the one tool whose allowed call waits for the user (H6). */
export function isQuestion(item: ToolTableItem): boolean {
  return item.source === 'builtin' && item.originalName === 'AskUserQuestion'
}

/** The deciding inspector step's failure, when it did not answer: its note is its own (F1). */
function failedStatusOf(decision: Decision): 'timeout' | 'error' | undefined {
  const deciding = decision.record.steps.filter(
    (step) => step.by === 'inspector' && step.said === 'deny',
  )
  if (deciding.some((step) => step.status === 'ok')) return undefined
  const failed = deciding.find((step) => step.status !== 'ok')?.status
  return failed === 'timeout' || failed === 'error' ? failed : undefined
}

/** A child's workspace-sensitive grants carry a causal parent fact, never a wall-clock guess. */
function ownSessionGrants(entries: readonly TapeEntry[], parent: readonly TapeEntry[]) {
  const grants = sessionGrants(grantFactsOf(entries))
  if (sessionFactsOf(entries).subagentOf === null) return grants
  const approvals = new Map(
    entries
      .filter((entry) => entry.name === 'tool/approval_resolved')
      .map((entry) => [entry.provenanceKey, entry]),
  )
  for (const [key, source] of grants) {
    const kind: unknown = (JSON.parse(key) as unknown[])[2]
    if (kind !== 'file' && kind !== 'command') continue
    const approval = approvals.get(source.approvalKey)
    const workspaceKey = approval?.payload['parentWorkspaceKey']
    const at =
      typeof workspaceKey === 'string'
        ? parent.findIndex(
            (entry) =>
              entry.name === 'session/workspace_set' && entry.provenanceKey === workspaceKey,
          )
        : -1
    if (at < 0 || approval === undefined) {
      grants.delete(key)
      continue
    }
    const baseline = parent[at]!
    const replay = sessionGrants([
      ...grantFactsOf([baseline, approval]),
      ...grantFactsOf(
        parent.slice(at + 1).filter((entry) => entry.name === 'session/workspace_set'),
      ),
    ])
    if (!replay.has(key)) grants.delete(key)
  }
  return grants
}

function grantFactsOf(entries: readonly TapeEntry[]): GrantFact[] {
  const facts: GrantFact[] = []
  for (const entry of entries) {
    if (entry.name === 'tool/approval_resolved') {
      facts.push({
        kind: 'approval',
        sessionId: entry.sessionId,
        approvalKey: entry.provenanceKey ?? '',
        outcome: String(entry.payload['outcome']),
        grant: (entry.payload['grant'] ?? null) as GrantFact extends { grant: infer G } ? G : never,
      })
    } else if (entry.name === 'session/workspace_set') {
      facts.push({ kind: 'workspace', folders: (entry.payload['folders'] ?? []) as AbsolutePath[] })
    }
  }
  return facts
}

/** Every fact of the session's current incarnation, paged. */
export async function readSessionEntries(
  tape: Pick<Tape, 'readRange'>,
  sessionId: string,
): Promise<TapeEntry[]> {
  const entries: TapeEntry[] = []
  let fromEntryId: number | undefined
  let incarnationId: string | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
    const page = await tape.readRange({
      sessionId,
      limit: MAX_READ_LIMIT,
      ...(fromEntryId === undefined ? {} : { fromEntryId }),
      ...(incarnationId === undefined ? {} : { incarnationId }),
    })
    entries.push(...page.entries)
    incarnationId = page.incarnationId
    if (page.nextFromEntryId === null) break
    fromEntryId = page.nextFromEntryId
  }
  return entries
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
}

/** Root and linked child dispatch facts are the quota; no derived counter is persisted. */
export async function searchDispatchCount(
  tape: Pick<Tape, 'readRange'>,
  sessionId: string,
): Promise<number> {
  const own = await readSessionEntries(tape, sessionId)
  const rootId = sessionFactsOf(own).subagentOf?.sessionId ?? sessionId
  const root = rootId === sessionId ? own : await readSessionEntries(tape, rootId)
  const ids = new Set(
    root
      .filter((e) => e.name === 'session/parent_link')
      .map((e) => (e.payload['child'] as { sessionId: string }).sessionId),
  )
  ids.delete(rootId)
  let total = countSearchDispatches(root)
  for (const id of ids) {
    // oxlint-disable-next-line no-await-in-loop -- bound memory to one child tape at a time
    total += countSearchDispatches(id === sessionId ? own : await readSessionEntries(tape, id))
  }
  return total
}

const countSearchDispatches = (entries: readonly TapeEntry[]) =>
  entries.filter(
    (e) => e.name === 'execution/dispatch_committed' && e.payload['name'] === 'WebSearch',
  ).length
