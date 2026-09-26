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
 *      on the Tape (T1) — the executor, then its result and outcome.
 *
 * A stop between calls closes the rest as not-run / stopped.
 */
import type { AbsolutePath, HostAdapter } from '../host/adapter.js'
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
import type { PathScope, PathVerdict } from '../permission/workspace.js'
import type {
  AppendResult,
  DispatchCommittedPayload,
  FactWriter,
  NewEntry,
  PermissionDecidedPayload,
  TapeEntry,
} from '../tape/entry.js'
import { dispatchCommittedKey, permissionDecidedKey } from '../tape/provenance.js'
import { MAX_READ_LIMIT } from '../tape/store.js'
import type { Tape } from '../tape/tape.js'
import { BUILTIN_TOOLS, isBuiltinToolName } from '../tools/builtin/index.js'
import type { BuiltinToolName } from '../tools/builtin/tool.js'
import { executorFor } from '../tools/executor.js'
import type { ToolTableItem } from '../tools/registry.js'
import type { SearchBackend } from '../tools/search/types.js'
import type { FrozenToolTable, ToolKey } from '../tools/table.js'
import type { ArgumentValidator } from '../tools/validate.js'
import type { CallRef } from './closure.js'
import { notRunFacts, repairFacts, resultFacts } from './closure.js'
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
  readonly runId: string
  readonly requestSeq: number
  readonly profile: 'chat' | 'cowork'
  readonly table: FrozenToolTable
  readonly calls: readonly CompleteCall[]
  readonly inspectors: readonly InspectorRegistration[]
  readonly validator: ArgumentValidator
  readonly protectedFiles: readonly AbsolutePath[]
  readonly userSetting: (key: ToolKey) => UserToolSetting | null
  readonly mcpSources: readonly McpToolSource[]
  readonly testTools: Readonly<Partial<Record<BuiltinToolName, 'fake' | 'real' | null>>> | null
  readonly search: SearchBackend | null
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

export type BatchResult =
  | { readonly kind: 'done'; readonly denials: number }
  /** A decision asks: it is written with the Run's `paused` terminal, in one batch. */
  | {
      readonly kind: 'paused'
      readonly withTerminal: readonly NewEntry[]
      /** The asked call and the rest of the batch after it, which wait with it (§等待模型). */
      readonly waiting: readonly CallRef[]
    }
  | { readonly kind: 'blocked-repeatedly'; readonly count: number }
  | { readonly kind: 'stopped' }

export async function runBatch(ctx: BatchContext): Promise<BatchResult> {
  const writer: FactWriter = { by: 'run', runId: ctx.runId }
  const scope = await pathScopeOf(ctx)
  let denials = ctx.denials
  for (let k = 0; k < ctx.calls.length; k += 1) {
    const call = ctx.calls[k] as CompleteCall
    const ref: CallRef = {
      runId: ctx.runId,
      requestSeq: ctx.requestSeq,
      ordinal: call.ordinal,
      providerToolCallId: call.providerToolCallId,
    }
    if (ctx.signal.aborted) {
      // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
      await closeRest(ctx, ctx.calls.slice(k), 'stopped')
      return { kind: 'stopped' }
    }
    const item = ctx.table.items.find((candidate) => candidate.name === call.name)
    if (item === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
      await close(
        ctx,
        call,
        notRunFacts({
          tape: ctx.tape,
          now: ctx.now,
          call: ref,
          source: 'tool-unavailable',
          writer,
        }),
      )
      continue
    }
    const verdict = ctx.validator.check(item, call.input)
    if (!verdict.ok) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
      await close(
        ctx,
        call,
        notRunFacts({
          tape: ctx.tape,
          now: ctx.now,
          call: ref,
          source: verdict.source,
          detail: verdict.reason,
          writer,
        }),
      )
      continue
    }
    const executor = executorFor({ item, mcpSources: ctx.mcpSources, testTools: ctx.testTools })
    if (executor === null) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
      await close(
        ctx,
        call,
        notRunFacts({
          tape: ctx.tape,
          now: ctx.now,
          call: ref,
          source: 'tool-unavailable',
          writer,
        }),
      )
      continue
    }

    // ----- the decision --------------------------------------------------------------------------
    // oxlint-disable-next-line no-await-in-loop -- the view reads what the calls before this one wrote
    const entries = await readSessionEntries(ctx.tape, ctx.sessionId)
    const reversibility = reversibilityOf(item, call.input)
    // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
    const located = await locate(ctx, item, call.input, scope)
    const place = located === undefined ? undefined : placeFor(ctx.profile, located)
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
      profile: ctx.profile,
      ownSpillDir: scope.ownSpillDir,
    })
    // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
    const inspection = await runInspectors({
      inspectors: ctx.inspectors,
      input: { call: inspected, view },
      setTimeout: (fn, ms) => ctx.host.clock.setTimeout(fn, ms),
      signal: ctx.signal,
    })
    if (inspection.stopped) {
      // Stopped while judging: no decision fact, the call and the rest not-run (B1).
      // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
      await closeRest(ctx, ctx.calls.slice(k), 'stopped')
      return { kind: 'stopped' }
    }
    const policy = ctx.host.policy.current()
    const workspace = scope.roots[0] ?? null
    const callReason = callReasonOf({
      tool: item,
      args: call.input,
      ...(place === undefined ? {} : { place }),
      ...(located === undefined ? {} : { real: located.real }),
      workspace,
      searchHost: ctx.search?.host ?? null,
    })
    const setting =
      item.source === 'mcp'
        ? ctx.userSetting({
            tenantId: ctx.host.identity.tenantId,
            serverId: item.serverId,
            toolName: item.originalName,
          })
        : null
    const object = grantObjectOf(item, call.input, located, workspace, ctx.search)
    const grantFrom =
      object === null
        ? undefined
        : sessionGrants(grantFactsOf(entries)).get(
            grantKey(item.serverId, item.originalName, object),
          )
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
    const decisionKey = permissionDecidedKey(ctx.runId, ctx.requestSeq, call.ordinal)
    const decided = decisionFact(ctx, call, decision, {
      reversibility,
      policyVersion: policy.status === 'unavailable' ? 'unavailable' : policy.version,
      key: decisionKey,
      ...(decision.record.verdict === 'ask'
        ? { card: cardOf(item, call.input, located, workspace, ctx.search) }
        : {}),
      writer,
    })

    if (decision.record.verdict === 'deny') {
      const block = decision.block
      if (block === undefined) throw new Error('decide: a denial carries its block')
      const failed =
        decision.record.decidedBy === 'inspector' ? failedStatusOf(decision) : undefined
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
      await close(ctx, call, [
        decided,
        ...notRunFacts({
          tape: ctx.tape,
          now: ctx.now,
          call: ref,
          source: block.reason,
          facts: block.facts,
          ...(failed === undefined ? {} : { inspectorStatus: failed }),
          reversibility,
          writer,
        }),
      ])
      denials += 1
      if (denials >= MACHINE_DENIAL_CAP) {
        // oxlint-disable-next-line no-await-in-loop -- the rest of the batch closes once, in order
        await closeRest(ctx, ctx.calls.slice(k + 1), 'blocked-repeatedly')
        return { kind: 'blocked-repeatedly', count: denials }
      }
      continue
    }
    if (decision.record.verdict === 'ask') {
      // The card waits; the rest of the batch waits with it (§等待模型). Answers are plan step 15's.
      const waiting = ctx.calls.slice(k).map((rest) => ({
        runId: ctx.runId,
        requestSeq: ctx.requestSeq,
        ordinal: rest.ordinal,
        providerToolCallId: rest.providerToolCallId,
      }))
      return { kind: 'paused', withTerminal: [decided], waiting }
    }

    // ----- allowed: decision and dispatch first (T1), then the side effect -------------------------
    denials = 0
    const dispatch: DispatchCommittedPayload = {
      ordinal: call.ordinal,
      providerToolCallId: call.providerToolCallId,
      name: call.name,
      argsHash: call.argsHash,
      decisionKey,
      writer,
    }
    const dispatchEntry = ctx.tape.writer('execution').entry('execution/dispatch_committed', {
      sourceType: 'runtime_event',
      sourceId: ctx.runId,
      sourceSeq: ctx.requestSeq,
      provenanceKey: dispatchCommittedKey(ctx.runId, ctx.requestSeq, call.ordinal),
      payload: dispatch,
      createdAt: ctx.now(),
    })
    // oxlint-disable-next-line no-await-in-loop -- T1: the side effect waits for its dispatch to commit
    const committed = await dispatchOnce(ctx, ref, item, [decided, dispatchEntry], dispatchEntry)
    if (!committed) continue
    // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
    const execution = await executor({ item, input: call.input, signal: ctx.signal })
    const facts = resultFacts({
      tape: ctx.tape,
      now: ctx.now,
      call: ref,
      content: execution.content,
      isError: execution.isError,
      kernelAuthored: false,
      effect: effectOf(item),
      state: execution.state,
      source: execution.state === 'completed' ? null : 'stopped',
      reversibility,
      writer,
    })
    // oxlint-disable-next-line no-await-in-loop -- one call at a time, in the model's order
    await close(ctx, call, facts, decision)
  }
  return { kind: 'done', denials }
}

/**
 * The decision and its `dispatch_committed`, and whether the side effect may follow (T1). An append
 * that finds the same dispatch already committed (`created: false`) never dispatches it twice: tests
 * and development builds throw, the packaged build closes the call uncertain / `repair` and logs it.
 * A `TapeProvenanceConflictError` — another writer's dispatch under this key — goes up as it is: it
 * is the bug the queue exists to rule out (01 spec:492), and plan step 16's recovery reads it as 损坏.
 */
async function dispatchOnce(
  ctx: BatchContext,
  ref: CallRef,
  item: ToolTableItem,
  entries: readonly NewEntry[],
  dispatchEntry: NewEntry,
): Promise<boolean> {
  const written = await ctx.write(entries)
  const at = written.entries.indexOf(dispatchEntry)
  if (written.receipts[at]?.created !== false) return true
  const key = dispatchEntry.provenanceKey ?? ''
  if (ctx.strict)
    throw new Error(`[loop] dispatch ${key} was already committed; it is never dispatched twice`)
  ctx.log(`[loop] dispatch ${key} was already committed; not dispatched again, closed as repair`)
  await ctx.write(
    repairFacts({
      tape: ctx.tape,
      now: ctx.now,
      call: ref,
      dispatched: true,
      effect: effectOf(item),
      writer: { by: 'run', runId: ctx.runId },
    }),
  )
  return false
}

/** Writes a call's closing facts, then tells the interface — after the commit, never before. */
async function close(
  ctx: BatchContext,
  call: CompleteCall,
  entries: readonly NewEntry[],
  decision?: Decision,
): Promise<void> {
  const written = await ctx.write(entries)
  // A result another writer beat is dropped, and so is its announcement (先写者算数).
  const outcome = written.entries.find((entry) => entry.name === 'execution/tool_outcome')
    ?.payload as Record<string, unknown> | undefined
  const result = written.entries.find((entry) => entry.name === 'tool/result')?.payload as
    | Record<string, unknown>
    | undefined
  if (outcome === undefined || result === undefined) return
  const denied = entries.find((entry) => entry.name === 'tool/permission_decided')?.payload as
    | PermissionDecidedPayload
    | undefined
  const summary = decision?.summary ?? denied?.summary
  ctx.outcome(call, {
    effect: outcome['effect'] as ToolOutcomeView['effect'],
    state: outcome['state'] as ToolOutcomeView['state'],
    source: (outcome['source'] ?? null) as ToolOutcomeView['source'],
    ...(outcome['facts'] === undefined
      ? {}
      : { facts: outcome['facts'] as Record<string, string> }),
    output: textOf(result['content']),
    ...(summary === undefined ? {} : { permission: summary }),
  })
}

/** Closes calls that will not run, in order, all with one source. */
async function closeRest(
  ctx: BatchContext,
  calls: readonly CompleteCall[],
  source: 'stopped' | 'blocked-repeatedly',
): Promise<void> {
  const writer: FactWriter = { by: 'run', runId: ctx.runId }
  for (const call of calls) {
    const ref: CallRef = {
      runId: ctx.runId,
      requestSeq: ctx.requestSeq,
      ordinal: call.ordinal,
      providerToolCallId: call.providerToolCallId,
    }
    // oxlint-disable-next-line no-await-in-loop -- closures are written in <i> order
    await close(ctx, call, notRunFacts({ tape: ctx.tape, now: ctx.now, call: ref, source, writer }))
  }
}

function decisionFact(
  ctx: BatchContext,
  call: CompleteCall,
  decision: Decision,
  q: {
    readonly reversibility: PermissionDecidedPayload['reversibility']
    readonly policyVersion: string
    readonly key: string
    readonly card?: Pick<NonNullable<PermissionDecidedPayload['confirm']>, 'kind' | 'target'>
    readonly writer: FactWriter
  },
): NewEntry {
  const payload: PermissionDecidedPayload = {
    ordinal: call.ordinal,
    providerToolCallId: call.providerToolCallId,
    argsHash: call.argsHash,
    reversibility: q.reversibility,
    record: decision.record,
    summary: decision.summary,
    policyVersion: q.policyVersion,
    ...(decision.confirm !== undefined && q.card !== undefined
      ? { confirm: { ...decision.confirm, ...q.card }, awaits: 'approval' as const }
      : {}),
    ...(decision.block === undefined ? {} : { block: decision.block }),
    writer: q.writer,
  }
  return ctx.tape.writer('tool').entry('tool/permission_decided', {
    sourceType: 'runtime_event',
    sourceId: ctx.runId,
    sourceSeq: ctx.requestSeq,
    provenanceKey: q.key,
    payload,
    createdAt: ctx.now(),
  })
}

/** Where file paths are judged from: the workspace roots, the profile, this session's spill, the protected files — all resolved. */
async function pathScopeOf(ctx: BatchContext): Promise<PathScope> {
  const fs = ctx.host.fs
  const profileDir = (await resolvePath(fs, ctx.host.identity.profileDir as AbsolutePath)).path
  const ownSpillDir = (await resolvePath(fs, toolOutputDirFor(profileDir, ctx.sessionId))).path
  const protectedFiles = await Promise.all(
    ctx.protectedFiles.map(async (file) => (await resolvePath(fs, file)).path),
  )
  // The workspace is the cowork profile's (plan step 18); the chat profile has none.
  return { roots: [], profileDir, ownSpillDir, protectedFiles }
}

/** A file tool's path, placed; Glob and Grep without a path search the first folder. */
async function locate(
  ctx: BatchContext,
  item: ToolTableItem,
  input: Record<string, unknown>,
  scope: PathScope,
): Promise<PathVerdict | undefined> {
  if (item.source !== 'builtin' || !FILE_TOOL_NAMES.has(item.originalName)) return undefined
  const raw =
    input[item.originalName === 'Glob' || item.originalName === 'Grep' ? 'path' : 'file_path']
  const path = typeof raw === 'string' ? raw : scope.roots[0]
  if (path === undefined) return { real: scope.ownSpillDir, place: 'outside' }
  return locatePath(ctx.host.fs, path as AbsolutePath, scope)
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
  search: SearchBackend | null,
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
      return search === null ? null : { kind: 'search', host: search.host }
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
  search: SearchBackend | null,
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
        target: { type: 'search', query: String(input['query'] ?? ''), host: search?.host ?? '' },
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
