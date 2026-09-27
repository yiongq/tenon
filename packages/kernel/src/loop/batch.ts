/**
 * One batch of tool calls (spec 02 §一批工具怎么执行, §权限决策顺序, §原因码表; plan step 13).
 *
 * The calls of one reply are handled one at a time, in the model's order — plan step 13 is serial;
 * the parallel group of workspace reads (H14) may come later without changing the Tape's shape (M1).
 * For each call:
 *
 *   1. find it in the frozen table — a name it does not hold is `tool-unavailable`;
 *   2. validate its arguments — `invalid-input`, or `tool-unavailable` for a schema that cannot be
 *      used — with no decision and no dispatch;
 *   3. find its executor — none in this build is `tool-unavailable`, its definition still sent;
 *   4. decide: every layer's state computed here, the inspectors run first (a stop while they run
 *      writes no decision), then `decide()`;
 *   5. deny: the decision and a kernel-authored closure; the third machine denial in a row ends the
 *      Run as `blocked-repeatedly`. Ask: the decision is written with the Run's `paused` terminal, in
 *      one batch (同批规则 1). Allow: the decision and `dispatch_committed`, then — only once they are
 *      on the Tape (T1) — the executor, then its result and outcome. Bash first awaits its base
 *      environment, raced against the stop (§内置工具与参数「Bash」): a stop that wins writes neither.
 *
 * A stop between calls closes the rest as not-run / stopped.
 */
import type { AbsolutePath, HostAdapter, Reversibility } from '../host/adapter.js'
import { toolOutputDirFor } from '../host/profile.js'
import { decide } from '../permission/decide.js'
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
import type { ToolTableItem } from '../tools/registry.js'
import type { SearchBackend } from '../tools/search/types.js'
import type { FrozenToolTable, ToolKey } from '../tools/table.js'
import type { ArgumentValidator } from '../tools/validate.js'
import type { CommandRun, CommandShell } from '../tools/builtin/bash.js'
import type { CallRef } from './closure.js'
import { closureContent, notRunFacts, repairFacts, resultFacts } from './closure.js'
import { sessionFactsOf, workspaceOf } from '../session/facts.js'
import { MACHINE_DENIAL_CAP } from './limits.js'
import type { McpToolSource } from './ports.js'
import type { ToolOutcomeView } from './events.js'

/** One complete client call of a reply, as `tool/call` records it. */
export interface CompleteCall {
  readonly ordinal: number
  readonly providerToolCallId: string
  readonly name: string
  readonly input: Record<string, unknown>
  readonly argsHash: string
}

export interface BatchContext {
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
  readonly ordinal: number
  readonly decisionKey: string
  readonly summary: DecisionSummary
  readonly reversibility: Reversibility
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
  /** A decision asks: it is written with the Run's `paused` terminal, in one batch. */
  | {
      readonly kind: 'paused'
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
  | { readonly kind: 'stopped' }

export async function runBatch(ctx: BatchContext): Promise<BatchResult> {
  const { writer } = ctx
  const judge: JudgeContext = { ...ctx, searchHost: ctx.search?.host ?? null }
  let denials = ctx.denials
  for (let k = 0; k < ctx.calls.length; k += 1) {
    const call = ctx.calls[k] as CompleteCall
    const ref = refOf(ctx, call)
    if (ctx.signal.aborted) {
      // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
      await closeRest(ctx, ctx.calls.slice(k), 'stopped')
      return { kind: 'stopped' }
    }
    const item = ctx.table.items.find((candidate) => candidate.name === call.name)
    const verdict = item === undefined ? null : ctx.validator.check(item, call.input)
    const executor =
      item === undefined || verdict?.ok !== true
        ? null
        : executorFor({ item, mcpSources: ctx.mcpSources, testTools: ctx.testTools })
    if (item === undefined || verdict === null || !verdict.ok || executor === null) {
      const invalid = verdict !== null && !verdict.ok ? verdict : null
      try {
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
        await close(
          ctx,
          call,
          notRunFacts({
            tape: ctx.tape,
            now: ctx.now,
            call: ref,
            source: invalid?.source ?? 'tool-unavailable',
            ...(invalid === null ? {} : { detail: invalid.reason }),
            writer,
          }),
        )
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
    try {
      // Each call reads the session as the calls before it left it, the workspace included: a folder
      // removed meanwhile is judged by the new list at once (D11).
      // oxlint-disable-next-line no-await-in-loop -- the view reads what the calls before this one wrote
      const facts = await callFactsOf(ctx)
      if (ctx.approved?.ordinal === call.ordinal) {
        // Allowed on its card: dispatched on the decision the answer resolved, not judged again.
        denials = 0
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
        const command = await commandRunOf(ctx, call, item, facts)
        if (command === 'stopped') {
          // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
          await closeApprovedAndRest(ctx, ctx.approved, k)
          return { kind: 'stopped' }
        }
        const dispatch = dispatchEntryFor(ctx, call, ctx.approved.decisionKey)
        // oxlint-disable-next-line no-await-in-loop -- T1: the side effect waits for its dispatch to commit
        if (!(await dispatchOnce(ctx, call, item, [dispatch], dispatch))) continue
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
        const target = await locate(ctx.host, item, call.input, facts.scope)
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
        await execute(ctx, call, item, executor, {
          reversibility: ctx.approved.reversibility,
          summary: ctx.approved.summary,
          target: target?.real ?? null,
          scope: facts.scope,
          command,
        })
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- the view reads what the calls before this one wrote
      const judged = await judgeCall(judge, item, call, facts)
      if (judged.kind === 'stopped') {
        // Stopped while judging: no decision fact, the call and the rest not-run (B1).
        // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
        await closeRest(ctx, ctx.calls.slice(k), 'stopped')
        return { kind: 'stopped' }
      }
      const { decision } = judged
      const decisionKey = permissionDecidedKey(ctx.runId, ctx.requestSeq, call.ordinal)
      const decided = decisionEntry({
        ...ctx,
        ref,
        argsHash: call.argsHash,
        judged,
        key: decisionKey,
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
        return { kind: 'paused', withTerminal: [decided], waiting }
      }
      // ----- allowed: decision and dispatch first (T1), then the side effect -----------------------
      denials = 0
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
      if (!(await dispatchOnce(ctx, call, item, [decided, dispatch], dispatch))) continue
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
      await execute(ctx, call, item, executor, {
        reversibility: judged.reversibility,
        summary: decision.summary,
        target: judged.target,
        scope: facts.scope,
        command,
      })
    } catch (error) {
      if (!(error instanceof RunWriteRefusedError)) throw error
      // A stop reached the decision's or the dispatch's write first: neither is written, and the
      // call and the rest close as a stop while judging would (§点停止时各状态怎么收).
      // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
      await (ctx.approved?.ordinal === call.ordinal
        ? closeApprovedAndRest(ctx, ctx.approved, k)
        : closeRest(ctx, ctx.calls.slice(k), 'stopped'))
      return { kind: 'stopped' }
    }
  }
  return { kind: 'done', denials }
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

/**
 * The side effect, then its result and outcome. A file tool acts on the real path its decision placed
 * (§「在不在工作区里」第 5 步). A call stopped while it ran gets the stopped note, with whatever it had
 * produced as the second block (§点停止时各状态怎么收).
 */
async function execute(
  ctx: BatchContext,
  call: CompleteCall,
  item: ToolTableItem,
  executor: NonNullable<ReturnType<typeof executorFor>>,
  q: {
    readonly reversibility: Reversibility
    readonly summary: DecisionSummary
    readonly target: AbsolutePath | null
    readonly scope: PathScope
    readonly command: CommandRun | undefined
  },
): Promise<void> {
  const execution = await executor({
    item,
    input: call.input,
    signal: ctx.signal,
    target: q.target,
    scope: q.scope,
    fs: ctx.host.fs,
    ...(q.command === undefined ? {} : { command: q.command }),
  })
  const stopped = execution.state !== 'completed'
  // A Bash timeout is its own code; every other call that did not complete was stopped.
  const source = stopped ? (execution.source ?? 'stopped') : null
  const output = textOf(execution.content)
  const facts = resultFacts({
    tape: ctx.tape,
    now: ctx.now,
    call: refOf(ctx, call),
    content:
      source === null
        ? execution.content
        : closureContent({
            source,
            state: execution.state,
            ...(output === '' ? {} : { detail: output }),
          }),
    isError: stopped || execution.isError,
    kernelAuthored: stopped,
    effect: effectOf(item),
    state: execution.state,
    source,
    reversibility: q.reversibility,
    writer: ctx.writer,
  })
  await close(ctx, call, facts, q.summary)
}

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
 * The decision and its `dispatch_committed`, and whether the side effect may follow (T1). An append
 * that finds the same dispatch already committed (`created: false`) never dispatches it twice; a
 * `TapeProvenanceConflictError` — another writer's dispatch under this key — dispatches nothing
 * either, and the call closes as the recovery table's 损坏 (§执行日志与恢复表 T1). Tests and
 * development builds throw on both; the packaged build closes the call uncertain / `repair`, announced
 * like any closure, and logs.
 */
async function dispatchOnce(
  ctx: BatchContext,
  call: CompleteCall,
  item: ToolTableItem,
  entries: readonly NewEntry[],
  dispatchEntry: NewEntry,
): Promise<boolean> {
  const key = dispatchEntry.provenanceKey
  const repair = (): Promise<void> =>
    close(
      ctx,
      call,
      repairFacts({
        tape: ctx.tape,
        now: ctx.now,
        call: refOf(ctx, call),
        dispatched: true,
        effect: effectOf(item),
        writer: ctx.writer,
      }),
    )
  let written: Written
  try {
    written = await ctx.write(entries)
  } catch (error) {
    if (!(error instanceof TapeProvenanceConflictError) || ctx.strict) throw error
    ctx.log(
      `[loop] dispatch ${key} conflicts with another writer's; not dispatched, closed as repair`,
    )
    await repair()
    return false
  }
  const at = written.entries.indexOf(dispatchEntry)
  if (written.receipts[at]?.created !== false) return true
  if (ctx.strict)
    throw new Error(`[loop] dispatch ${key} was already committed; it is never dispatched twice`)
  ctx.log(`[loop] dispatch ${key} was already committed; not dispatched again, closed as repair`)
  await repair()
  return false
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
 * A stop before the approved call's dispatch: it closes not-run / stopped with the reversibility of
 * the asking decision it already has (§载荷 ToolOutcomePayload: 取判决事实里的值), then the rest.
 */
async function closeApprovedAndRest(
  ctx: BatchContext,
  approved: ApprovedCall,
  k: number,
): Promise<void> {
  const call = ctx.calls[k]
  if (call === undefined) throw new Error('batch: the approved call is not in the batch')
  await close(
    ctx,
    call,
    notRunFacts({
      tape: ctx.tape,
      now: ctx.now,
      call: refOf(ctx, call),
      source: 'stopped',
      reversibility: approved.reversibility,
      writer: ctx.writer,
    }),
  )
  await closeRest(ctx, ctx.calls.slice(k + 1), 'stopped')
}

/** Closes calls that will not run, in order, all with one source. */
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
  const { entries, profile, scope: paths } = given ?? (await callFactsOf(ctx))
  const reversibility = reversibilityOf(item, call.input)
  const located = await locate(ctx.host, item, call.input, paths)
  const place = located === undefined ? undefined : placeFor(profile, located)
  const inspected: InspectedCall = {
    tool: {
      name: item.name,
      source: item.source,
      serverId: item.serverId,
      originalName: item.originalName,
    },
    args: call.input,
    reversibility,
  }
  const view = buildSessionView(entries, {
    call: inspected,
    profile,
    ownSpillDir: paths.ownSpillDir,
  })
  const inspection = await runInspectors({
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
  const grantFrom =
    object === null
      ? undefined
      : sessionGrants(grantFactsOf(entries)).get(grantKey(item.serverId, item.originalName, object))
  const decision = decide({
    call: inspected,
    callReason,
    layers: {
      policy,
      ...(place === undefined ? {} : { place }),
      ...(setting?.connectorOff === undefined ? {} : { connectorOff: setting.connectorOff }),
      ...(setting?.userSetting === undefined ? {} : { userSetting: setting.userSetting }),
      reversibility: { value: reversibility, source: 'host' },
      requiresUserInteraction: item.requiresUserInteraction,
      sessionGrant:
        grantFrom === undefined || object === null
          ? null
          : { kind: sessionGrantKindOf(object), grantFrom },
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
    ...(decision.record.verdict === 'ask'
      ? { card: cardOf(item, call.input, located, workspace, ctx.searchHost) }
      : {}),
    grantObject: object,
    ...(failed === undefined ? {} : { failed }),
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
    ...(decision.confirm !== undefined && q.judged.card !== undefined
      ? { confirm: { ...decision.confirm, ...q.judged.card }, awaits: 'approval' as const }
      : {}),
    ...(decision.block === undefined ? {} : { block: decision.block }),
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
  return { entries, profile: facts.profile, scope: await pathScopeOf(ctx, workspace), workspace }
}

/**
 * Where file paths are judged from: the workspace roots (real already: resolved when they were
 * chosen), the profile, this session's spill, the protected files — all resolved. The chat profile
 * has no workspace, so its roots are empty.
 */
export async function pathScopeOf(
  ctx: Pick<JudgeContext, 'host' | 'sessionId' | 'protectedFiles'>,
  workspace: WorkspaceSetPayload | null,
): Promise<PathScope> {
  const fs = ctx.host.fs
  const profileDir = (await resolvePath(fs, ctx.host.identity.profileDir as AbsolutePath)).path
  const ownSpillDir = (await resolvePath(fs, toolOutputDirFor(profileDir, ctx.sessionId))).path
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

/** The deciding inspector step's failure, when it did not answer: its note is its own (F1). */
function failedStatusOf(decision: Decision): 'timeout' | 'error' | undefined {
  const deciding = decision.record.steps.filter(
    (step) => step.by === 'inspector' && step.said === 'deny',
  )
  if (deciding.some((step) => step.status === 'ok')) return undefined
  const failed = deciding.find((step) => step.status !== 'ok')?.status
  return failed === 'timeout' || failed === 'error' ? failed : undefined
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
