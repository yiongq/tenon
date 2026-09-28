import type { SubagentHandoff } from './subagent.js'
/**
 * A Run (spec 02 §Run 的生命周期与每轮顺序, §一轮回复怎么分流, §上限、守卫与用量, §重试与「继续」):
 * the requests of one trigger, outside the mailbox. Every fact it writes goes in through the mailbox
 * (`write`), and its end — `execution/run_terminal`, the lease finished, `run-ended` — is written by
 * the mailbox task that receives what `driveRun` returns.
 *
 * Each round (plan step 13 builds steps 2 to 4; compaction and the environment note are plan steps 30
 * and 18, inserting queued messages step 17):
 *
 *   2. send the request — every new payload a new `requestSeq`, every resend of it a new
 *      `physicalAttempt` — and route what came back by §一轮回复怎么分流;
 *   3. a reply with complete client calls first meets the step limit, the no-progress guard and the
 *      token limit: any of them closes the whole batch not-run and ends the Run;
 *   4. the batch (`loop/batch.ts`), after which the next request goes out.
 *
 * What survives from the phase 1 service: the request is encoded ONCE per payload and the encoded
 * request is what is streamed; its context is a PREFIX of the Tape, pinned at the top of this Run's
 * latest committed batch and recorded on the attempt; exactly one of `stop` / `error` reaches the
 * attempt fact; an assistant message only when the turn has something to show. What changes (01 修补
 * 9 (m)): a refusal, a context overflow and Zhipu's `network_error` are discarded — the attempt fact
 * alone — like every error, and each such attempt sends `attempt-discarded`.
 */
import type { AbsolutePath, HostAdapter } from '../host/adapter.js'
import type { IdSource } from '../ids.js'
import type { UserToolSetting } from '../permission/decide.js'
import type { InspectorRegistration } from '../permission/inspector.js'
import { createBlockAccumulator } from '../provider/base.js'
import { ProviderConfigMissingError, ProviderInvalidArgumentError } from '../provider/errors.js'
import { MODEL_NOTES, fill, systemPrompt } from '../prompts/index.js'
import { thinkingModelId } from '../provider/thinking.js'
import type {
  ContentBlock,
  EncodedRequest,
  InternalMessage,
  ModelInfo,
  Provider,
  ProviderErrorCode,
  ProviderId,
  ProviderRequest,
  RequestIdentity,
  StopReason,
  StreamEvent,
  ToolSpec,
  Usage,
} from '../provider/types.js'
import {
  canonicalHash,
  encoderOf,
  modelWireHash,
  requestSnapshot,
  systemHash,
} from '../provider/wire/shared.js'
import type {
  CompactionAnchorPayload,
  MessageStatus,
  NewEntry,
  RunUsageLine,
  TapeEntry,
  ToolCallPayload,
  ToolTablePayload,
  ToolsWithheldPayload,
  ViewAssembledPayload,
  ViewContentPayload,
} from '../tape/entry.js'
import type {
  TapeAssistantMessagePayload,
  TapeAttemptCompletedPayload,
  TapeAttemptError,
  TapeAttemptStop,
} from '../tape/projection.js'
import {
  compactionAnchorKey,
  assembledKey,
  attemptCompletedKey,
  messageRevisionKey,
  toolCallKey,
  toolTableKey,
  toolsWithheldKey,
  viewContentKey,
} from '../tape/provenance.js'
import {
  compactionCut,
  compactionThreshold,
  checksThinkingPrefix,
  estimateInput,
  isBoundaryRun,
  latestAnchor,
  turnStarts,
  summaryThinking,
  COMPACT_RETRY_CAP,
} from './compaction.js'
import { replayContext } from '../tape/replay.js'
import { MAX_READ_LIMIT } from '../tape/store.js'
import type { Tape } from '../tape/tape.js'
import type { CommandShell } from '../tools/builtin/bash.js'
import type { BuiltinToolName } from '../tools/builtin/tool.js'
import type { SearchBackend } from '../tools/search/types.js'
import { rebuildToolTable, specHash, toolTableFacts } from '../tools/table.js'
import type { FrozenToolTable, ToolKey } from '../tools/table.js'
import { createArgumentValidator } from '../tools/validate.js'
import type { PolicyState } from '../host/policy.js'
import type { ApprovedCall, BatchContext, BatchResult, CompleteCall, Written } from './batch.js'
import { closedView, effectOf, readSessionEntries, runBatch } from './batch.js'
import type { CallRef, ClosureSource } from './closure.js'
import { isBlockReason, notRunFacts, repairFacts } from './closure.js'
import type { ToolOutcomeView } from './events.js'
import { NO_PROGRESS_REPEATS, RETRY_CAP, STEP_LIMIT } from './limits.js'
import type { McpToolSource, RunAbortCause, RunLease } from './ports.js'
import type { RunEndReason } from './terminal.js'
import {
  environmentEntry,
  environmentNow,
  latestEnvironment,
  sameEnvironment,
} from './environment.js'
import { readSessionFacts } from '../session/facts.js'
import type { Profile } from '../session/facts.js'

/** A new message starts at revision 0; only an edit-and-resend (phase 6) increments it. */
export const FIRST_REVISION = 0

export interface RunDriverContext {
  readonly agent?: BatchContext['agent']
  readonly stepLimit?: number
  readonly elapsed?: () => Promise<number>
  readonly deadlineMs?: number
  readonly tape: Tape
  readonly ids: IdSource
  readonly now: () => number
  readonly log: (line: string) => void
  readonly host: HostAdapter
  readonly sessionId: string
  readonly incarnationId: string
  readonly runId: string
  /** The top of this Run's pre-run batch: the first request's context. */
  readonly pin: number
  /** The provider, built by the prebuild — or on first use, for a resume (plan step 15). */
  readonly provider: () => Provider
  readonly model: ModelInfo
  readonly maxTokens: number
  readonly effort: string | null
  readonly toolsWithheld: 'provider-text-only' | null
  readonly search: SearchBackend | null
  readonly mcpSources: readonly McpToolSource[]
  /** Bash's shell and base environment (`LoopPorts.commandShell`). */
  readonly commandShell: CommandShell
  readonly inspectors: readonly InspectorRegistration[]
  readonly protectedFiles: readonly AbsolutePath[]
  readonly userSetting: (key: ToolKey) => UserToolSetting | null
  readonly testTools: Readonly<Partial<Record<BuiltinToolName, 'fake' | 'real' | null>>> | null
  /** A token limit for this Run (off by default; evals and sub-agents set one, H11). */
  readonly tokenLimit: number | null
  readonly compactionThreshold?: number | null
  readonly lease: RunLease
  readonly openTable: (q: {
    providerId: string
    generation: number
    reason: 'first-use' | 'after-compaction'
  }) => Promise<{ table: FrozenToolTable; policy: PolicyState }>
  /**
   * Commits facts through the mailbox; the answer is what was written, with its receipts. A result
   * for a call that already has one is dropped there (先写者算数), so it can be less than was given.
   */
  readonly write: (entries: readonly NewEntry[]) => Promise<Written>
  /** A call in the context with no result: throw (tests, development) or repair and log (§兜底). */
  readonly onUnansweredCall: 'throw' | 'repair'
  /** A Run an answer opened: it finishes the paused batch before its first request (§续跑). */
  readonly resume?: ResumeBatch
  /**
   * The interface language (`LoopPorts.locale`), read only when this incarnation's system text is
   * assembled — at its first request (§提示层「组装」).
   */
  readonly locale: () => 'zh-CN' | 'en'
  /** The host's local date (`LoopPorts.localDate`), read only for the environment note. */
  readonly localDate: () => string
  /**
   * The queued messages, inserted at a batch boundary — after the batch's results, before the next
   * request, as `message/user` facts of this turn (§插话与输入框状态表「写入时点」). Null when there
   * was none, or the Run was stopped first.
   */
  readonly insertQueued: () => Promise<Written | null>
  readonly emit: {
    delta(runId: string, type: 'text-delta' | 'thinking-delta', delta: string): void
    discarded(runId: string): void
    call(call: CompleteCall & { callKey: string }): void
    outcome(
      call: { readonly callKey: string; readonly providerToolCallId: string },
      view: ToolOutcomeView,
    ): void
  }
}

/** The paused batch a resuming Run finishes: its request, the calls still to handle, the approved one. */
export interface ResumeBatch {
  readonly handoff?: SubagentHandoff
  readonly runId: string
  readonly requestSeq: number
  readonly calls: readonly CompleteCall[]
  readonly approved: ApprovedCall | null
}

/** What a Run leaves for its terminal task. */
export interface RunFinish {
  readonly reason: RunEndReason
  readonly steps: number
  readonly usage: readonly RunUsageLine[]
  readonly lastStop: StopReason | null
  readonly errorCode: ProviderErrorCode | null
  /**
   * Facts that go in the terminal's batch: a paused decision (同批规则 1), or the not-run closures
   * of a Run that ends on a limit, a truncation, a filter or an error (「mailbox」: those closures go
   * with their terminal, so a stop that beats the terminal task writes neither).
   */
  readonly withTerminal: readonly NewEntry[]
  /**
   * The calls `withTerminal` closes or leaves waiting: closed not-run / stopped instead if a stop
   * beats the terminal task (§点停止时各状态怎么收「生成中」).
   */
  readonly waiting: readonly CallRef[]
}

export async function driveRun(ctx: RunDriverContext): Promise<RunFinish> {
  const { tape, runId } = ctx
  const signal = ctx.lease.signal
  let state = await readViewState(tape, ctx.sessionId)
  const { profile } = await readSessionFacts(tape, ctx.sessionId)
  const chain = await chainCounters(tape, ctx.sessionId, runId)
  const validator = createArgumentValidator()
  const usage = new Map<string, RunUsageLine>()
  if (ctx.resume?.handoff !== undefined)
    for (const line of ctx.resume.handoff.usage)
      usage.set(`subagent:${line.providerId}:${line.modelId}`, { ...line, origin: 'subagent' })
  let steps = 0
  let pin = ctx.pin
  let requestSeq = 0
  let mainRequests = 0
  let thresholdChecked = false
  let overflowCompactions = 0
  const boundaryRun = isBoundaryRun(await readSessionEntries(tape, ctx.sessionId), runId)
  let denials = chain.denials
  const batches = [...chain.batches]
  let lastStop: StopReason | null = null
  let errorCode: ProviderErrorCode | null = null
  /** What the token limit counts so far: every attempt's uncached input plus output (H11). */
  let counted = 0
  if (ctx.resume?.handoff !== undefined) {
    const latest = (await readSessionEntries(tape, ctx.sessionId)).findLast(
      (e) => e.name === 'provider/attempt_completed',
    )
    const wire = (
      latest?.payload['encoder'] as { wire?: 'anthropic-messages' | 'openai-chat' } | undefined
    )?.wire
    for (const line of ctx.resume.handoff.usage)
      counted += limitTokensOf({ ...line, final: true }, wire ?? null)
  }
  const finish = (
    reason: RunEndReason,
    extra: Partial<Pick<RunFinish, 'withTerminal' | 'waiting'>> = {},
  ): RunFinish => ({
    reason,
    steps,
    usage: [...usage.values()],
    lastStop,
    errorCode,
    withTerminal: extra.withTerminal ?? [],
    waiting: extra.waiting ?? [],
  })
  /**
   * Ended by the abort (§重试与「继续」: a stop during the wait included). The terminal task reads the
   * lease again, and its `run-ended` carries no error code then: no error event ended this Run.
   */
  const aborted = (): RunFinish => finish(abortedEndReason(abortCauseOf(ctx.lease)))
  /**
   * A Run that ends on a limit, a truncation, a filter or an error with calls it will not run: their
   * not-run closures go in the terminal's batch (see `RunFinish.withTerminal`).
   */
  const endClosing = (
    reason: RunEndReason,
    refs: readonly CallRef[],
    source:
      | 'stopped'
      | 'output-truncated'
      | 'content-filter'
      | 'provider-error'
      | 'step-limit'
      | 'no-progress'
      | 'usage-limit'
      | 'blocked-repeatedly',
  ): RunFinish =>
    finish(reason, {
      withTerminal: refs.flatMap((ref) =>
        notRunFacts({ tape, now: ctx.now, call: ref, source, writer: { by: 'run', runId } }),
      ),
      waiting: refs,
    })
  const write = async (entries: readonly NewEntry[]): Promise<Written> => {
    if (entries.length === 0) return { entries: [], receipts: [] }
    const written = await ctx.write(entries)
    for (const receipt of written.receipts) pin = Math.max(pin, receipt.entryId)
    if (written.deferredTo !== undefined) pin = Math.max(pin, written.deferredTo)
    return written
  }

  const batch = (q: {
    readonly runId: string
    readonly requestSeq: number
    readonly table: FrozenToolTable
    readonly calls: readonly CompleteCall[]
    readonly approved?: ApprovedCall
  }): Promise<BatchResult> =>
    runBatch({
      tape,
      now: ctx.now,
      host: ctx.host,
      sessionId: ctx.sessionId,
      ...q,
      writer: { by: 'run', runId },
      ...(ctx.agent === undefined
        ? {}
        : {
            agent: async (call) => {
              const result = await ctx.agent!(call)
              const latest = (await readSessionEntries(tape, ctx.sessionId)).findLast(
                (e) => e.name === 'provider/attempt_completed',
              )
              const wire = (
                latest?.payload['encoder'] as
                  | { wire?: 'anthropic-messages' | 'openai-chat' }
                  | undefined
              )?.wire
              if (result.kind === 'done')
                for (const line of result.handoff.usage) {
                  counted += limitTokensOf({ ...line, final: true }, wire ?? null)
                  const key = `subagent:${line.providerId}:${line.modelId}`
                  const prior = usage.get(key)
                  usage.set(key, {
                    ...line,
                    origin: 'subagent',
                    requests: (prior?.requests ?? 0) + line.requests,
                    inputTokens: (prior?.inputTokens ?? 0) + line.inputTokens,
                    outputTokens: (prior?.outputTokens ?? 0) + line.outputTokens,
                    cacheReadTokens: (prior?.cacheReadTokens ?? 0) + line.cacheReadTokens,
                    cacheWriteTokens: (prior?.cacheWriteTokens ?? 0) + line.cacheWriteTokens,
                    reasoningTokens: (prior?.reasoningTokens ?? 0) + line.reasoningTokens,
                  })
                }
              return result
            },
          }),
      inspectors: ctx.inspectors,
      validator,
      protectedFiles: ctx.protectedFiles,
      userSetting: ctx.userSetting,
      mcpSources: ctx.mcpSources,
      testTools: ctx.testTools,
      search: ctx.search,
      commandShell: ctx.commandShell,
      denials,
      budgetExceeded: () =>
        ctx.tokenLimit !== null && counted > ctx.tokenLimit ? ctx.tokenLimit : null,
      strict: ctx.onUnansweredCall === 'throw',
      log: ctx.log,
      signal,
      cause: () => abortCauseOf(ctx.lease),
      write,
      outcome: (call, view) =>
        ctx.emit.outcome(
          { ...call, callKey: callKeyOf(q.runId, q.requestSeq, call.ordinal) },
          view,
        ),
    })
  /**
   * At a batch boundary the queued messages go in after the results, once the next request's
   * provider is built — a resumed Run with no key leaves them queued (§续跑) — and the pin moves
   * past them.
   */
  let atBoundary = false
  const boundary = async (): Promise<boolean> => {
    if (!atBoundary) return false
    atBoundary = false
    const inserted = await ctx.insertQueued()
    for (const receipt of inserted?.receipts ?? []) pin = Math.max(pin, receipt.entryId)
    return inserted !== null && inserted.entries.length > 0
  }
  /**
   * 「环境说明」: before a boundary request — the first of a Run a message or 「继续」 opened — and
   * before the request after queued messages went in; after the user's turns, before the context.
   */
  const environment = async (): Promise<void> => {
    const now = await environmentNow(tape, ctx.sessionId, ctx.localDate())
    const latest = await latestEnvironment(tape, ctx.sessionId, pin)
    if (latest !== null && sameEnvironment(latest, now)) return
    const entry = environmentEntry({ tape, now: ctx.now, messageId: ctx.ids.uuid(), state: now })
    await write([entry])
  }
  const compact = async (
    provider: Provider,
    assembled: AssembledRequest,
    boundaryRequest: boolean,
    trigger: CompactionAnchorPayload['trigger'],
  ): Promise<'skipped' | 'done' | RunFinish> => {
    const entries = await readSessionEntries(tape, ctx.sessionId)
    const cut = compactionCut(
      entries,
      boundaryRequest,
      trigger.code === 'overflow' && trigger.retry === 2 ? 1 : 2,
    )
    if (cut === null) return 'skipped'
    if (ctx.tokenLimit !== null && counted > ctx.tokenLimit) {
      errorCode = null
      return finish({ code: 'usage-limit', tokenLimit: ctx.tokenLimit })
    }
    const contextAtEntryId = pin
    const replay = await replayContext(tape, {
      sessionId: ctx.sessionId,
      atEntryId: pin,
      target: ctx.model,
      beforeOrderSeq: cut.keepFromEntryId,
    })
    const requestText = MODEL_NOTES.compactionRequest
    const messages: InternalMessage[] = [
      ...replay.messages,
      { role: 'user', content: [{ type: 'text', text: requestText }] },
    ]
    const request: ProviderRequest = {
      model: ctx.model,
      messages,
      maxTokens: ctx.maxTokens,
      ...(assembled.system === null ? {} : { system: assembled.system }),
      ...summaryThinking(ctx.model),
      dropThinkingBefore: messages.length,
    }
    requestSeq += 1
    const summarySeq = requestSeq
    const assemblyRef = assembledKey(runId, summarySeq)
    const original = assembled.facts.find((e) => e.name === 'view/assembled')!
    const manifest = { ...(original.payload as unknown as ViewAssembledPayload), tools: null }
    await write([
      ...assembled.facts.filter(
        (e) => e.name === 'view/content' && e.payload['type'] !== 'tool_spec',
      ),
      tape.writer('view').entry('view/assembled', {
        sourceType: 'runtime_event',
        sourceId: runId,
        sourceSeq: summarySeq,
        provenanceKey: assemblyRef,
        payload: manifest,
        createdAt: ctx.now(),
      }),
    ])
    state.system = assembled.system
    state.requested = true
    const encoded = provider.encode(request)
    const advice = provider.retryAdvice()
    const resends = Math.max(0, Math.min(advice.maxAttempts - 1, RETRY_CAP))
    let physicalAttempt = 0
    let delay = advice.baseDelayMs
    let firstByteTimeout: false | undefined
    for (;;) {
      physicalAttempt += 1
      const identity = { runId, requestSeq: summarySeq, physicalAttempt }
      // oxlint-disable-next-line no-await-in-loop -- one physical summary attempt at a time
      const attempt = await streamAttempt({
        ctx,
        provider,
        encoded,
        identity,
        signal,
        firstByteTimeout,
        publish: false,
      })
      addUsage(usage, attempt)
      counted += limitTokensOf(attempt.usage, encoderOf(encoded)?.wire ?? null)
      lastStop = attempt.stop?.reason ?? null
      errorCode = attempt.error?.code ?? null
      // oxlint-disable-next-line no-await-in-loop -- audit every summary attempt before any retry or anchor
      await write([
        attemptFact(ctx, {
          encoded,
          request,
          attempt,
          contextAtEntryId,
          identity,
          assemblyRef,
          compaction: { keepFromEntryId: cut.keepFromEntryId, requestText },
        }),
      ])
      if (signal.aborted || attempt.stop?.reason === 'aborted') return aborted()
      const route = routeOf(attempt, ctx.maxTokens)
      if (route.kind === 'discard' && route.transient && physicalAttempt <= resends) {
        if (ctx.tokenLimit !== null && counted > ctx.tokenLimit) {
          errorCode = null
          return finish({ code: 'usage-limit', tokenLimit: ctx.tokenLimit })
        }
        firstByteTimeout = attempt.timeout === 'first-byte' ? false : undefined
        // oxlint-disable-next-line no-await-in-loop -- H12 backoff does not advance the payload identity
        if (!(await wait(ctx.host, attempt.error?.retryAfterMs ?? delay, signal))) return aborted()
        delay *= 2
        continue
      }
      if (attempt.error?.code === 'context-overflow' || attempt.stop?.reason === 'context-overflow')
        return finish({ code: 'context-overflow', compactions: 0 })
      if (
        attempt.error !== null ||
        (attempt.stop?.reason !== 'end-turn' && attempt.stop?.reason !== 'stop-sequence')
      ) {
        errorCode = attempt.error?.code ?? null
        lastStop = attempt.stop?.reason ?? null
        return finish(providerError(attempt, physicalAttempt))
      }
      if (ctx.tokenLimit !== null && counted > ctx.tokenLimit) {
        errorCode = null
        return finish({ code: 'usage-limit', tokenLimit: ctx.tokenLimit })
      }
      const text = attempt.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
      const generation = state.generation + 1
      const providerIds = new Set([...state.tables.values()].map((table) => table.providerId))
      providerIds.add(ctx.model.providerId)
      const tableFacts: NewEntry[] = []
      for (const providerId of providerIds) {
        // oxlint-disable-next-line no-await-in-loop -- assemble other providers outside the mailbox, under this lease
        const fresh = await ctx.openTable({ providerId, generation, reason: 'after-compaction' })
        tableFacts.push(
          ...toolTableFacts({
            view: tape.writer('view'),
            sessionId: ctx.sessionId,
            table: fresh.table,
            policy: fresh.policy,
            now: ctx.now,
          }),
        )
      }
      if (signal.aborted) return aborted()
      const payload: CompactionAnchorPayload = {
        ...cut,
        summary: fill(MODEL_NOTES.compactionWrap, { summary: text }),
        summarizer: { providerId: ctx.model.providerId, modelId: ctx.model.id },
        trigger,
        generation,
      }
      // oxlint-disable-next-line no-await-in-loop -- anchor and all replacement tables are one atomic append
      await write([
        tape.writer('compaction').entry('compaction/anchor', {
          sourceType: 'runtime_event',
          sourceId: runId,
          sourceSeq: summarySeq,
          provenanceKey: compactionAnchorKey(runId, summarySeq),
          payload,
          createdAt: ctx.now(),
        }),
        ...new Map(tableFacts.map((fact) => [fact.provenanceKey, fact])).values(),
      ])
      // oxlint-disable-next-line no-await-in-loop -- memory follows the committed generation only
      state = await readViewState(tape, ctx.sessionId)
      return 'done'
    }
  }
  const batchEnd = (result: BatchResult): RunFinish | null => {
    if (result.kind === 'usage-limit')
      return endClosing(
        { code: 'usage-limit', tokenLimit: result.tokenLimit },
        result.rest,
        'usage-limit',
      )
    if (result.kind === 'paused') {
      return finish(
        { code: 'paused', waitingFor: result.waitingFor },
        { withTerminal: result.withTerminal, waiting: result.waiting },
      )
    }
    if (result.kind === 'blocked-repeatedly') {
      return endClosing(
        { code: 'blocked-repeatedly', count: result.count },
        result.rest,
        'blocked-repeatedly',
      )
    }
    if (result.kind === 'stopped') return aborted()
    return null
  }

  if (ctx.resume !== undefined) {
    if (ctx.tokenLimit !== null && counted > ctx.tokenLimit)
      return endClosing(
        { code: 'usage-limit', tokenLimit: ctx.tokenLimit },
        ctx.resume.calls.map((call) => ({
          runId: ctx.resume!.runId,
          requestSeq: ctx.resume!.requestSeq,
          ordinal: call.ordinal,
          providerToolCallId: call.providerToolCallId,
        })),
        'usage-limit',
      )
    // §续跑: the paused batch first — the approved call, then the rest in order — under the frozen
    // table of the batch's provider. It was counted as a step when it paused, so it is not again.
    const tableKey = toolTableKey(ctx.incarnationId, state.generation, ctx.model.providerId)
    const stored = state.tables.get(tableKey)
    if (stored === undefined) throw new Error(`resume: no frozen table ${tableKey} on the Tape`)
    const result = await batch({
      runId: ctx.resume.runId,
      requestSeq: ctx.resume.requestSeq,
      table: rebuildToolTable(tableKey, stored, state.specs),
      calls: ctx.resume.calls,
      ...(ctx.resume.approved === null ? {} : { approved: ctx.resume.approved }),
    })
    const ended = batchEnd(result)
    if (ended !== null) return ended
    if (result.kind === 'done') denials = result.denials
    atBoundary = true
  }

  // No abort check before a request: an aborted signal reaches the provider, which starts no stream
  // and answers `stop{ aborted }`, so every request of the Run leaves its attempt fact (01 invariant 2).
  requests: for (;;) {
    if (ctx.tokenLimit !== null && counted > ctx.tokenLimit)
      return finish({ code: 'usage-limit', tokenLimit: ctx.tokenLimit })
    if (ctx.elapsed !== undefined && ctx.deadlineMs !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- deadline is recomputed before each new main payload
      if ((await ctx.elapsed()) >= ctx.deadlineMs)
        return finish({ code: 'time-limit', limitMs: ctx.deadlineMs })
    }
    let provider: Provider
    try {
      provider = ctx.provider()
    } catch (error) {
      // A resumed Run stopped before it was assembled has no provider to ask (§续跑).
      if (signal.aborted) return aborted()
      // A configuration problem ends the Run as the failure card names it, with what already ran
      // kept (§续跑「构造失败也不能丢已执行调用的结果」): a missing key is `auth`; a value present but
      // unusable (a base URL with a query string) is `invalid-request`, as a new round's prebuild
      // reads it (mailbox.ts `configProblem`).
      const code =
        error instanceof ProviderConfigMissingError
          ? 'auth'
          : error instanceof ProviderInvalidArgumentError
            ? 'invalid-request'
            : null
      if (code === null) throw error
      errorCode = code
      return finish({
        code: 'provider-error',
        providerId: ctx.model.providerId,
        errorCode: code,
        providerReason: null,
        attempts: 0,
      })
    }
    // oxlint-disable-next-line no-await-in-loop -- the queued messages join before this request
    const inserted = await boundary()
    if (inserted || (mainRequests === 0 && ctx.resume === undefined)) {
      // oxlint-disable-next-line no-await-in-loop -- the note joins before this request's context
      await environment()
    }
    // oxlint-disable-next-line no-await-in-loop -- each request is assembled from what the last one left on the Tape
    const assembled = await assembleRequest({
      tape,
      now: ctx.now,
      sessionId: ctx.sessionId,
      incarnationId: ctx.incarnationId,
      runId,
      requestSeq: requestSeq + 1,
      model: ctx.model,
      toolsWithheld: ctx.toolsWithheld,
      state,
      openTable: ctx.openTable,
      profile,
      locale: ctx.locale,
    })
    // oxlint-disable-next-line no-await-in-loop -- each request is assembled from what the last one left on the Tape
    const messages = await pairedContext(ctx, assembled.table, pin, write, () => pin)
    let request: ProviderRequest = {
      model: ctx.model,
      ...(assembled.system === null ? {} : { system: assembled.system }),
      messages,
      ...(assembled.tools === undefined ? {} : { tools: [...assembled.tools] }),
      maxTokens: ctx.maxTokens,
      // No effort unless one was chosen: the model's own default (A11).
      ...(ctx.effort === null ? {} : { effort: ctx.effort }),
      // §思考的默认与显示: summarized thinking on every request of a model that offers it; the
      // encoder writes it only while thinking is on (with `disabled` it is a 400).
      ...(ctx.model.thinkingSpec?.displays?.includes('summarized') === true
        ? { display: 'summarized' as const }
        : {}),
    }
    const boundaryRequest = mainRequests === 0 && boundaryRun
    // oxlint-disable-next-line no-await-in-loop -- each payload reads evidence left by the preceding one
    const entries = await readSessionEntries(tape, ctx.sessionId)
    if (!thresholdChecked) {
      thresholdChecked = true
      const estimated = estimateInput(entries, request)
      const threshold = ctx.compactionThreshold ?? compactionThreshold(ctx.model)
      if (estimated > threshold && (boundaryRequest || !checksThinkingPrefix(ctx.model))) {
        // oxlint-disable-next-line no-await-in-loop -- summary must finish before this payload can be sent
        const compacted = await compact(provider, assembled, boundaryRequest, {
          code: 'threshold',
          estimatedInputTokens: estimated,
          thresholdTokens: threshold,
        })
        if (compacted !== 'skipped' && compacted !== 'done') return compacted
        if (compacted === 'done') continue requests
      }
    }
    requestSeq += 1
    const anchor = latestAnchor(entries)
    if (anchor !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- the committed anchor determines this request’s cutoff
      const replay = await replayContext(tape, {
        sessionId: ctx.sessionId,
        atEntryId: pin,
        target: ctx.model,
      })
      const lastBoundary = entries.findLast(
        (entry) =>
          entry.name === 'execution/run_started' &&
          entry.sourceId !== null &&
          isBoundaryRun(entries, entry.sourceId),
      )
      const crossedBoundary = lastBoundary !== undefined && lastBoundary.entryId > anchor.entryId
      const turnWasCompacted =
        !crossedBoundary &&
        !boundaryRequest &&
        anchor.payload['keepFromEntryId'] === turnStarts(entries).at(-1)
      const cutoff = crossedBoundary
        ? lastBoundary.entryId
        : turnWasCompacted
          ? Number(anchor.payload['keepFromEntryId'])
          : anchor.entryId
      const index = replay.orderSeqs.findIndex((seq) => seq >= cutoff)
      request = { ...request, dropThinkingBefore: index < 0 ? messages.length : index }
    }
    // ONCE per payload — and the encoded request is what every attempt of it streams.
    const encoded = provider.encode(request)
    const contextAtEntryId = pin
    // The content first, then the manifest, then the bytes leave, then the attempt (A3).
    // oxlint-disable-next-line no-await-in-loop -- the content before the manifest before the bytes (A3)
    await write(assembled.facts)
    recordAssembly(state, assembled)

    const advice = provider.retryAdvice()
    const resends = Math.max(0, Math.min(advice.maxAttempts - 1, RETRY_CAP))
    let physicalAttempt = 0
    let delay = advice.baseDelayMs
    let firstByteTimeout: false | undefined
    for (;;) {
      physicalAttempt += 1
      const identity: RequestIdentity = { runId, requestSeq, physicalAttempt }
      // oxlint-disable-next-line no-await-in-loop -- one physical attempt at a time
      const attempt = await streamAttempt({
        ctx,
        provider,
        encoded,
        identity,
        signal,
        firstByteTimeout,
      })
      addUsage(usage, attempt)
      counted += limitTokensOf(attempt.usage, encoderOf(encoded)?.wire ?? null)
      lastStop = attempt.stop?.reason ?? null
      errorCode = attempt.error?.code ?? null
      const route = routeOf(attempt, ctx.maxTokens)
      const attemptEntry = attemptFact(ctx, {
        encoded,
        request,
        attempt,
        contextAtEntryId,
        identity,
        assemblyRef: assembled.assemblyRef,
      })

      if (route.kind === 'discard') {
        // Only the attempt fact: no assistant, no tool/call (01 修补 9 (m)).
        // oxlint-disable-next-line no-await-in-loop -- the discarded attempt is on the Tape before the resend
        await write([attemptEntry])
        ctx.emit.discarded(runId)
        if (
          attempt.error?.code === 'context-overflow' ||
          attempt.stop?.reason === 'context-overflow'
        ) {
          if (
            overflowCompactions >= COMPACT_RETRY_CAP ||
            (!boundaryRequest && checksThinkingPrefix(ctx.model))
          )
            return finish({ code: 'context-overflow', compactions: overflowCompactions })
          // oxlint-disable-next-line no-await-in-loop -- summary must finish before this payload can be sent
          const compacted = await compact(provider, assembled, boundaryRequest, {
            code: 'overflow',
            retry: (overflowCompactions + 1) as 1 | 2,
          })
          if (compacted === 'skipped')
            return finish({ code: 'context-overflow', compactions: overflowCompactions })
          if (compacted !== 'done') return compacted
          overflowCompactions += 1
          continue requests
        }
        if (route.transient && physicalAttempt <= resends) {
          // §上限「token 上限」: checked after every attempt — over the limit, no resend goes out.
          if (ctx.tokenLimit !== null && counted > ctx.tokenLimit) {
            errorCode = null
            return finish({ code: 'usage-limit', tokenLimit: ctx.tokenLimit })
          }
          // Only the resend right after a first-byte timeout goes without that limit (A5).
          firstByteTimeout = attempt.timeout === 'first-byte' ? false : undefined
          // oxlint-disable-next-line no-await-in-loop -- a resend waits its backoff
          const waited = await wait(ctx.host, attempt.error?.retryAfterMs ?? delay, signal)
          delay *= 2
          if (!waited) return aborted()
          continue
        }
        return finish(
          route.transient
            ? providerError(attempt, physicalAttempt)
            : route.end(attempt, physicalAttempt),
        )
      }

      // ----- the reply is kept: assistant, tool/call and attempt in one batch ------------------------
      const calls = completeCalls(attempt.content, runId, requestSeq)
      const assistantId = attempt.content.length > 0 ? ctx.ids.uuid() : null
      // oxlint-disable-next-line no-await-in-loop -- the reply is on the Tape before its calls are handled
      await write([
        ...(assistantId === null ? [] : [assistantFact(ctx, assistantId, attempt)]),
        ...(assistantId === null
          ? []
          : calls.map((call) => toolCallFact(ctx, call, requestSeq, assistantId))),
        attemptEntry,
      ])
      for (const call of calls) ctx.emit.call(call)
      if (attempt.content.some((block) => block.type === 'vendor' && block.replay === 'never')) {
        ctx.log(
          `[loop] run ${runId}: the reply holds a call the vendor ran itself; not dispatched, not sent back`,
        )
      }
      const refs = calls.map((call) => refOf(runId, requestSeq, call))
      if (route.kind === 'close') {
        // A stream the stop cut short ends by the stop's cause, read at the terminal task: a
        // user-stop wins (B4).
        if (route.source === 'stopped') {
          return endClosing(abortedEndReason(abortCauseOf(ctx.lease)), refs, 'stopped')
        }
        return endClosing(route.end(attempt, physicalAttempt), refs, route.source)
      }
      if (calls.length === 0) {
        // A tool-use turn with nothing to execute (only server-side blocks, or a call the decoder
        // dropped) reads as the pause-turn row: the service went wrong (B1, H12).
        if (attempt.stop?.reason === 'tool-use')
          return finish(providerError(attempt, physicalAttempt))
        return finish({ code: 'completed' })
      }

      // ----- step 3: the three guards, before any decision -------------------------------------
      const signature = JSON.stringify(calls.map((call) => [call.name, call.argsHash]))
      if (chain.steps + steps >= (ctx.stepLimit ?? STEP_LIMIT)) {
        return endClosing(
          { code: 'step-limit', limit: ctx.stepLimit ?? STEP_LIMIT },
          refs,
          'step-limit',
        )
      }
      const previous = batches.slice(-(NO_PROGRESS_REPEATS - 1))
      if (
        previous.length === NO_PROGRESS_REPEATS - 1 &&
        previous.every((earlier) => earlier === signature)
      ) {
        return endClosing(
          { code: 'no-progress', repeats: NO_PROGRESS_REPEATS },
          refs,
          'no-progress',
        )
      }
      if (ctx.tokenLimit !== null && counted > ctx.tokenLimit) {
        return endClosing({ code: 'usage-limit', tokenLimit: ctx.tokenLimit }, refs, 'usage-limit')
      }

      // ----- step 4: the batch -----------------------------------------------------------------
      // oxlint-disable-next-line no-await-in-loop -- the batch runs before the next request is built
      const result = await batch({ runId, requestSeq, table: assembled.table, calls })
      mainRequests += 1
      thresholdChecked = false
      overflowCompactions = 0
      steps += 1
      batches.push(signature)
      const ended = batchEnd(result)
      if (ended !== null) return ended
      if (result.kind === 'done') denials = result.denials
      atBoundary = true
      break
    }
  }
}

// ----- one attempt ------------------------------------------------------------------------------

/** What one attempt produced. */
export interface AttemptOutcome {
  readonly content: ContentBlock[]
  readonly stop: TapeAttemptStop | null
  readonly error: (TapeAttemptError & { readonly retryAfterMs?: number }) | null
  readonly resetAt: number | null
  readonly timeout: 'first-byte' | 'idle' | null
  readonly usage: Usage | null
  readonly responseModelId: string | null
  readonly providerId: ProviderId
  readonly modelId: string
}

async function streamAttempt(q: {
  readonly ctx: RunDriverContext
  readonly provider: Provider
  readonly encoded: EncodedRequest
  readonly identity: RequestIdentity
  readonly signal: AbortSignal
  readonly firstByteTimeout: false | undefined
  readonly publish?: boolean
}): Promise<AttemptOutcome> {
  const { ctx, provider, encoded, identity } = q
  // A thinking block is stamped with the guard's model identity rather than the wire id, so a block
  // folded here replays as `same-model` instead of looking like a model change.
  const blocks = createBlockAccumulator({
    provider: provider.id,
    providerModel: thinkingModelId(ctx.model),
  })
  let usage: Usage | null = null
  let stop: TapeAttemptStop | null = null
  let error: AttemptOutcome['error'] = null
  let resetAt: number | null = null
  let timeout: AttemptOutcome['timeout'] = null
  let responseModelId: string | null = null
  const send = {
    identity,
    signal: q.signal,
    ...(q.firstByteTimeout === undefined ? {} : { firstByteTimeout: q.firstByteTimeout }),
  }
  for await (const event of provider.stream(encoded, send)) {
    switch (event.type) {
      case 'usage':
        // Only the final reading reaches a fact (01 invariant 1).
        if (event.usage.final) usage = { ...event.usage }
        break
      case 'stop':
        stop = { reason: event.reason, providerReason: event.providerReason }
        break
      case 'error':
        error = attemptError(event)
        resetAt = event.resetAt ?? null
        timeout = event.timeout ?? null
        break
      case 'response-model':
        responseModelId ??= event.modelId
        break
      case 'text-delta':
      case 'thinking-delta':
        if (q.publish !== false) ctx.emit.delta(identity.runId, event.type, event.text)
        blocks.apply(event)
        break
      default:
        blocks.apply(event)
    }
  }
  // Exactly one of the two, whatever the provider did.
  if (error !== null) stop = null
  else if (stop === null) error = streamEndedEarly()
  return {
    content: blocks.content(),
    stop,
    error,
    resetAt: error === null ? null : resetAt,
    timeout: error === null ? null : timeout,
    usage,
    responseModelId,
    providerId: encoded.providerId,
    modelId: encoded.modelId,
  }
}

// ----- routing (§一轮回复怎么分流) ------------------------------------------------------------------

type Route =
  | { readonly kind: 'batch' }
  | {
      readonly kind: 'close'
      readonly source: 'output-truncated' | 'content-filter' | 'provider-error' | 'stopped'
      readonly end: (attempt: AttemptOutcome, attempts: number) => RunEndReason
    }
  | {
      readonly kind: 'discard'
      /** Resent as the same payload while the count allows (A2, A5, H12). */
      readonly transient: boolean
      readonly end: (attempt: AttemptOutcome, attempts: number) => RunEndReason
    }

function routeOf(attempt: AttemptOutcome, maxTokens: number): Route {
  const { error, stop } = attempt
  if (error !== null) {
    if (error.retryable) return { kind: 'discard', transient: true, end: providerError }
    if (error.code === 'context-overflow')
      return { kind: 'discard', transient: false, end: overflow }
    if (error.code === 'quota-exhausted') {
      return {
        kind: 'discard',
        transient: false,
        end: (a) => ({ code: 'quota-exhausted', providerId: a.providerId, resetAt: a.resetAt }),
      }
    }
    if (error.code === 'account-config') {
      return {
        kind: 'discard',
        transient: false,
        end: (a) => ({ code: 'account-config', providerId: a.providerId }),
      }
    }
    return { kind: 'discard', transient: false, end: providerError }
  }
  switch (stop?.reason) {
    case 'max-tokens':
      return {
        kind: 'close',
        source: 'output-truncated',
        end: () => ({ code: 'output-truncated', maxTokens }),
      }
    case 'refusal':
      return {
        kind: 'discard',
        transient: false,
        end: (a) => ({ code: 'refusal', providerId: a.providerId, modelId: a.modelId }),
      }
    case 'context-overflow':
      return { kind: 'discard', transient: false, end: overflow }
    case 'content-filter':
      return {
        kind: 'close',
        source: 'content-filter',
        end: (a) => ({ code: 'content-filter', providerId: a.providerId }),
      }
    case 'aborted':
      return { kind: 'close', source: 'stopped', end: () => ({ code: 'user-stopped' }) } // the cause is read by the caller
    case 'unknown':
      // Zhipu's network_error: discarded, and resent like a transient error (H12, A12).
      if (stop.providerReason === 'network_error')
        return { kind: 'discard', transient: true, end: providerError }
      return { kind: 'close', source: 'provider-error', end: providerError }
    case 'pause-turn':
      return { kind: 'close', source: 'provider-error', end: providerError }
    default:
      return { kind: 'batch' }
  }
}

function overflow(): RunEndReason {
  // Compaction and its retry are plan step 30's; until then an overflow ends the Run.
  return { code: 'context-overflow', compactions: 0 }
}

function providerError(attempt: AttemptOutcome, attempts: number): RunEndReason {
  return {
    code: 'provider-error',
    providerId: attempt.providerId,
    errorCode: attempt.error?.code ?? null,
    providerReason: attempt.error?.providerCode ?? attempt.stop?.providerReason ?? null,
    attempts,
  }
}

/** The cause an abort carries (§进行中、暂停与 RunRegistry): a user-stop wins, whenever it came. */
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

// ----- the facts a reply writes ------------------------------------------------------------------

/** The reply's complete client calls, numbered in the stream's order (§名字总表 `<i>`). */
function completeCalls(
  content: readonly ContentBlock[],
  runId: string,
  requestSeq: number,
): Array<CompleteCall & { callKey: string }> {
  return content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'tool-request' }> =>
        block.type === 'tool-request',
    )
    .map((block, ordinal) => ({
      ordinal,
      providerToolCallId: block.id,
      name: block.name,
      input: block.input,
      argsHash: canonicalHash(block.input, `the input of call ${String(ordinal)}`),
      callKey: callKeyOf(runId, requestSeq, ordinal),
    }))
}

/** `<runId>:<requestSeq>:<i>`, the same shape as the tool facts' key; the interface compares it only. */
export function callKeyOf(runId: string, requestSeq: number, ordinal: number): string {
  return `${runId}:${String(requestSeq)}:${String(ordinal)}`
}

function refOf(runId: string, requestSeq: number, call: CompleteCall): CallRef {
  return { runId, requestSeq, ordinal: call.ordinal, providerToolCallId: call.providerToolCallId }
}

function assistantFact(
  ctx: RunDriverContext,
  messageId: string,
  attempt: AttemptOutcome,
): NewEntry {
  const aborted = attempt.stop?.reason === 'aborted'
  const status: MessageStatus = aborted ? 'aborted' : 'complete'
  const payload: TapeAssistantMessagePayload = {
    messageId,
    revision: FIRST_REVISION,
    role: 'assistant',
    content: attempt.content,
    status,
    runId: ctx.runId,
  }
  return ctx.tape.writer('message').entry('message/assistant', {
    sourceType: 'message',
    sourceId: messageId,
    sourceSeq: FIRST_REVISION,
    provenanceKey: messageRevisionKey(messageId, FIRST_REVISION),
    payload,
    createdAt: ctx.now(),
  })
}

function toolCallFact(
  ctx: RunDriverContext,
  call: CompleteCall,
  requestSeq: number,
  messageId: string,
): NewEntry {
  const payload: ToolCallPayload = {
    ordinal: call.ordinal,
    providerToolCallId: call.providerToolCallId,
    messageId,
    name: call.name,
    input: call.input,
    argsHash: call.argsHash,
  }
  return ctx.tape.writer('tool').entry('tool/call', {
    sourceType: 'runtime_event',
    sourceId: ctx.runId,
    sourceSeq: requestSeq,
    provenanceKey: toolCallKey(ctx.runId, requestSeq, call.ordinal),
    payload,
    createdAt: ctx.now(),
  })
}

function attemptFact(
  ctx: RunDriverContext,
  q: {
    readonly encoded: EncodedRequest
    readonly request: ProviderRequest
    readonly attempt: AttemptOutcome
    readonly contextAtEntryId: number
    readonly identity: RequestIdentity
    readonly assemblyRef: string
    readonly compaction?: { keepFromEntryId: number; requestText: string }
  },
): NewEntry {
  const { encoded, attempt, identity } = q
  const payload: TapeAttemptCompletedPayload = {
    providerId: encoded.providerId,
    modelId: encoded.modelId,
    contextAtEntryId: q.contextAtEntryId,
    request: requestSnapshot(q.request),
    promptHash: encoded.promptHash,
    toolDefinitionsHash: encoded.toolDefinitionsHash,
    thinkingDecisions: [...encoded.thinkingDecisions],
    usage: attempt.usage,
    stop: attempt.stop,
    error: attempt.error,
    ...encoderField(encoded),
    modelWireHash: modelWireHash(ctx.model),
    ...(attempt.responseModelId === null ? {} : { responseModelId: attempt.responseModelId }),
    assemblyRef: q.assemblyRef,
    ...(q.compaction === undefined ? {} : { compaction: q.compaction }),
  }
  return ctx.tape.writer('provider').entry('provider/attempt_completed', {
    sourceType: 'runtime_event',
    sourceId: identity.runId,
    sourceSeq: identity.requestSeq,
    provenanceKey: attemptCompletedKey(
      identity.runId,
      identity.requestSeq,
      identity.physicalAttempt,
    ),
    payload,
    createdAt: ctx.now(),
  })
}

/**
 * The context at `pin`, with every call paired (§崩溃、服务端调用块与兜底「兜底」): checked once more
 * after the assembly, before `encode()`. A call without its result, or a turn whose blocks and calls
 * disagree (§重放怎么排 1), throws — the bug is not covered over — unless the host asked for repair:
 * then each unanswered call gets a `repair` closure (only the result, when its outcome is already on
 * the Tape: 补写缺的那一条), announced like any closure; a disagreeing turn is sent as its facts place
 * it; the log hears of it once, and the context is read again at the new pin.
 */
async function pairedContext(
  ctx: RunDriverContext,
  table: FrozenToolTable,
  pin: number,
  write: (entries: readonly NewEntry[]) => Promise<Written>,
  pinAfter: () => number,
): Promise<InternalMessage[]> {
  const query = { sessionId: ctx.sessionId, atEntryId: pin, target: ctx.model }
  const { messages, unanswered, mismatched } = await replayContext(ctx.tape, query)
  if (unanswered.length === 0 && mismatched.length === 0) return messages
  const keys = unanswered.map((call) => callKeyOf(call.runId, call.requestSeq, call.ordinal))
  const problems = [
    ...(unanswered.length === 0
      ? []
      : [
          `${String(unanswered.length)} call(s) reached a request with no result: ${keys.join(', ')}`,
        ]),
    ...mismatched.map(
      (turn) =>
        `assistant ${turn.messageId} holds ${String(turn.blocks)} tool-request block(s) for ${String(turn.calls)} call(s)`,
    ),
  ]
  const line = `run ${ctx.runId}: ${problems.join('; ')}`
  if (ctx.onUnansweredCall === 'throw') throw new Error(`[loop] ${line}`)
  ctx.log(`[loop] ${line}; repaired`)
  if (unanswered.length === 0) return messages
  for (const call of unanswered) {
    const item = table.items.find((candidate) => candidate.name === call.name)
    const facts = repairFacts({
      tape: ctx.tape,
      now: ctx.now,
      call,
      dispatched: call.dispatched,
      effect: item === undefined ? 'external' : effectOf(item),
      writer: { by: 'run', runId: ctx.runId },
    })
    // oxlint-disable-next-line no-await-in-loop -- closures are written in <i> order
    const written = await write(
      call.closed ? facts.filter((entry) => entry.name !== 'execution/tool_outcome') : facts,
    )
    // After the commit, as every closure is (SessionEvent `tool-outcome`): the live row reads an
    // internal error (§原因码表 repair). A call whose outcome was already there was announced then.
    const view = closedView(written.entries)
    if (view !== null) {
      ctx.emit.outcome(
        {
          callKey: callKeyOf(call.runId, call.requestSeq, call.ordinal),
          providerToolCallId: call.providerToolCallId,
        },
        view,
      )
    }
  }
  return (await replayContext(ctx.tape, { ...query, atEntryId: pinAfter() })).messages
}

/** The interface's view of a call closed not-run by the kernel: its closure's text is the output. */
export function notRunView(source: ClosureSource, entries: readonly NewEntry[]): ToolOutcomeView {
  const result = entries.find((entry) => entry.name === 'tool/result')
  const content = (result?.payload['content'] ?? []) as Array<{ type: string; text?: string }>
  return {
    effect: 'blocked',
    state: 'not-run',
    source,
    output: content.map((block) => block.text ?? '').join('\n'),
  }
}

// ----- usage, waiting, the chain's counters --------------------------------------------------------

function addUsage(lines: Map<string, RunUsageLine>, attempt: AttemptOutcome): void {
  const key = `${attempt.providerId}\u0000${attempt.modelId}`
  const line = lines.get(key) ?? {
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    origin: 'own' as const,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  const u = attempt.usage
  lines.set(key, {
    ...line,
    requests: line.requests + 1,
    inputTokens: line.inputTokens + (u?.inputTokens ?? 0),
    outputTokens: line.outputTokens + (u?.outputTokens ?? 0),
    cacheReadTokens: line.cacheReadTokens + (u?.cacheReadTokens ?? 0),
    cacheWriteTokens: line.cacheWriteTokens + (u?.cacheWriteTokens ?? 0),
    reasoningTokens: line.reasoningTokens + (u?.reasoningTokens ?? 0),
  })
}

/**
 * What one attempt counts toward the token limit: uncached input plus output (暂定, H11), by wire as
 * §评测运行器「费用与用量」 counts `usage.input` — anthropic-messages' `inputTokens` leave the cache
 * out already; openai-chat's include it, so the cache reads and writes come off first.
 */
function limitTokensOf(u: Usage | null, wire: 'anthropic-messages' | 'openai-chat' | null): number {
  if (u === null) return 0
  const input =
    wire === 'openai-chat'
      ? Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens)
      : u.inputTokens
  return input + u.outputTokens
}

/** Waits `ms` on the host clock; false when the Run was stopped meanwhile (then it ends as stopped). */
function wait(host: HostAdapter, ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const onAbort = (): void => {
      cancel()
      resolve(false)
    }
    const cancel = host.clock.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The counters the three guards read, from the Tape (§上限、守卫与用量, F3): the chain is this Run and
 * the Runs it resumes, back to one started by a message or by 「继续」. Steps are the earlier Runs'
 * `run_terminal.steps`; the batches are their calls' (name, argsHash) lists in request order; the
 * machine denials are the trailing blocked closures, reset by a call that ran or a card that asked.
 */
async function chainCounters(
  tape: Tape,
  sessionId: string,
  runId: string,
): Promise<{ steps: number; batches: string[]; denials: number }> {
  const entries = await readSessionEntries(tape, sessionId)
  const started = new Map<string, TapeEntry>()
  for (const entry of entries)
    if (entry.name === 'execution/run_started' && entry.sourceId !== null)
      started.set(entry.sourceId, entry)
  const chain: string[] = []
  let current: string | undefined = runId
  while (current !== undefined) {
    const cause = started.get(current)?.payload['cause'] as
      | { kind?: string; pausedRunId?: string }
      | undefined
    if (current !== runId) chain.unshift(current)
    current = cause?.kind === 'resume' ? cause.pausedRunId : undefined
  }
  const inChain = new Set(chain)
  let steps = 0
  const calls = new Map<string, Array<[string, string]>>()
  let denials = 0
  for (const entry of entries) {
    if (entry.sourceId === null || !inChain.has(entry.sourceId)) continue
    if (entry.name === 'execution/run_terminal') steps += Number(entry.payload['steps'] ?? 0)
    else if (entry.name === 'tool/call') {
      const key = `${entry.sourceId}:${String(entry.sourceSeq)}`
      const list = calls.get(key) ?? []
      list.push([String(entry.payload['name']), String(entry.payload['argsHash'])])
      calls.set(key, list)
    } else if (entry.name === 'execution/tool_outcome') {
      const source = (entry.payload['source'] ?? null) as Parameters<typeof isBlockReason>[0]
      if (isBlockReason(source)) denials += 1
      else if (source === null) denials = 0
    } else if (entry.name === 'tool/permission_decided' && entry.payload['awaits'] !== undefined)
      denials = 0
  }
  return { steps, batches: [...calls.values()].map((list) => JSON.stringify(list)), denials }
}

// ----- small pieces -------------------------------------------------------------------------------

/**
 * The `error` event as the loop reads it — with `retryAfterMs` — and as the fact records it. Rebuilt
 * key by key because an undefined-valued key is exactly what `canonicalJson` refuses.
 */
function attemptError(
  event: Extract<StreamEvent, { type: 'error' }>,
): TapeAttemptError & { retryAfterMs?: number } {
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

/** `encoder` for the attempt fact, or nothing. */
function encoderField(encoded: EncodedRequest): Pick<TapeAttemptCompletedPayload, 'encoder'> {
  const encoder = encoderOf(encoded)
  return encoder === null
    ? {}
    : { encoder: { wire: encoder.wire, version: encoder.version, sdk: encoder.sdk } }
}

/** A stream that ended with no terminal event: the retryable `network` failure it is. */
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

/** After a request's assembly commits, the Run's view state knows its table and what it sent. */
function recordAssembly(state: ViewState, assembled: AssembledRequest): void {
  state.system = assembled.system
  state.requested = true
  if (assembled.opened) {
    const table = assembled.table
    const payload: ToolTablePayload = {
      providerId: table.providerId,
      generation: table.generation,
      reason: table.reason,
      policyVersion: '',
      tools: table.items.map((item) => ({
        source: item.source,
        serverId: item.serverId,
        originalName: item.originalName,
        name: item.name,
        specHash: specHash(item.spec),
        requiresUserInteraction: item.requiresUserInteraction,
      })),
      excluded: [...table.excluded],
    }
    state.tables.set(table.tableKey, payload)
    for (const item of table.items) state.specs.set(specHash(item.spec), item.spec)
  }
  state.lastSent.set(assembled.table.tableKey, assembled.sent)
}

// ----- the assembly (spec 02 §组装清单与内容寄存, §工具目录与冻结) ---------------------------------

/**
 * What the Tape already says about a session's tables and requests, read once when a Run starts: the
 * generation (one per compaction), each table and its specs, and whether each table's last request
 * carried its tools. Read once per Run; each request's assembly then updates it in memory once its
 * facts commit (`recordAssembly`), so the Run never reads it back from the Tape.
 */
export interface ViewState {
  readonly generation: number
  readonly tables: Map<string, ToolTablePayload>
  readonly specs: Map<string, ToolSpec>
  readonly lastSent: Map<string, boolean>
  /**
   * The incarnation's system text (`view/content(system)`), once assembled; and whether any request
   * was made — one before the system existed (phase 1's) keeps the incarnation without one.
   */
  system: string | null
  requested: boolean
}

export async function readViewState(
  tape: Pick<Tape, 'readRange'>,
  sessionId: string,
): Promise<ViewState> {
  const state: ViewState = {
    generation: 0,
    tables: new Map(),
    specs: new Map(),
    lastSent: new Map(),
    system: null,
    requested: false,
  }
  let generation = 0
  let fromEntryId: number | undefined
  let incarnationId: string | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
    const page = await tape.readRange({
      sessionId,
      kinds: ['event', 'anchor'],
      limit: MAX_READ_LIMIT,
      ...(fromEntryId === undefined ? {} : { fromEntryId }),
      ...(incarnationId === undefined ? {} : { incarnationId }),
    })
    incarnationId = page.incarnationId
    for (const entry of page.entries) {
      if (entry.name === 'compaction/anchor') generation += 1
      else if (entry.name === 'view/tool_table' && entry.provenanceKey !== null) {
        state.tables.set(entry.provenanceKey, entry.payload as unknown as ToolTablePayload)
      } else if (entry.name === 'view/content') {
        const content = entry.payload as unknown as ViewContentPayload
        if (content.type === 'tool_spec') state.specs.set(content.hash, content.spec)
        else if (content.type === 'system') state.system ??= content.text
      } else if (entry.name === 'view/assembled') {
        const assembled = entry.payload as unknown as ViewAssembledPayload
        state.requested = true
        if (assembled.tools !== null)
          state.lastSent.set(assembled.tools.tableKey, assembled.tools.sent)
      } else if (entry.name === 'provider/attempt_completed') state.requested = true
    }
    if (page.nextFromEntryId === null) break
    fromEntryId = page.nextFromEntryId
  }
  return { ...state, generation }
}

/** A request's assembly: the tools it sends and the facts that record what it was built from. */
export interface AssembledRequest {
  /** The incarnation's system text; null for an incarnation whose requests began without one. */
  readonly system: string | null
  /** The frozen table's definitions when this request carries them; undefined when it does not. */
  readonly tools: readonly ToolSpec[] | undefined
  readonly table: FrozenToolTable
  /** Whether the table is new: the caller records it in its view state once the batch commits. */
  readonly opened: boolean
  readonly sent: boolean
  /** `view/content` (model, specs of a new table), `view/tool_table`, `view/tools_withheld`, `view/assembled`. */
  readonly facts: readonly NewEntry[]
  readonly assemblyRef: string
}

export interface AssembleQuery {
  readonly tape: Tape
  readonly now: () => number
  readonly sessionId: string
  readonly incarnationId: string
  readonly runId: string
  readonly requestSeq: number
  readonly model: ModelInfo
  /** `RunAssembly.toolsWithheld` (A14): the kernel only reads the mark, never the provider id. */
  readonly toolsWithheld: 'provider-text-only' | null
  readonly state: ViewState
  /** Opens the table of this provider and generation; called only when the Tape has none. */
  readonly openTable: (q: {
    providerId: string
    generation: number
    reason: 'first-use' | 'after-compaction'
  }) => Promise<{ table: FrozenToolTable; policy: PolicyState }>
  /** The session's profile (`session/profile_set`): which of the two system prompts (H1). */
  readonly profile: Profile
  /** The interface language, read only when the system text is assembled. */
  readonly locale: () => 'zh-CN' | 'en'
}

/**
 * Settles what one request is built from (§组装清单与内容寄存; §工具目录与冻结). The table of this
 * provider and generation is the one on the Tape, or it opens now — the first time the provider is
 * used, whether or not the model takes tools (E2). A request carries the table verbatim unless its
 * model takes no tools (A15) or its provider is sent none (A14); the first request that stops
 * carrying them records a `view/tools_withheld`, and switching back sends the frozen text again.
 * The system text is assembled once, at the incarnation's first request — its profile's prompt and
 * the interface language then — and sent from the Tape after that, unchanged (A13).
 */
export async function assembleRequest(q: AssembleQuery): Promise<AssembledRequest> {
  const view = q.tape.writer('view')
  const providerId = q.model.providerId
  const tableKey = toolTableKey(q.incarnationId, q.state.generation, providerId)
  const facts: NewEntry[] = []
  const modelHash = canonicalHash(q.model, `the model ${q.model.id}`)
  const modelContent: ViewContentPayload = { type: 'model_info', hash: modelHash, model: q.model }
  facts.push(
    view.entry('view/content', {
      sourceType: 'session',
      sourceId: q.sessionId,
      provenanceKey: viewContentKey('model_info', modelHash),
      payload: modelContent,
      createdAt: q.now(),
    }),
  )
  let system = q.state.system
  if (system === null && !q.state.requested) {
    system = systemPrompt(q.profile, q.locale())
    const hash = systemHash(system)
    const content: ViewContentPayload = { type: 'system', hash, text: system }
    facts.push(
      view.entry('view/content', {
        sourceType: 'session',
        sourceId: q.sessionId,
        provenanceKey: viewContentKey('system', hash),
        payload: content,
        createdAt: q.now(),
      }),
    )
  }
  const stored = q.state.tables.get(tableKey)
  let table: FrozenToolTable
  let opened = false
  if (stored === undefined) {
    const fresh = await q.openTable({
      providerId,
      generation: q.state.generation,
      reason: 'first-use',
    })
    table = fresh.table
    opened = true
    facts.push(
      ...toolTableFacts({ view, sessionId: q.sessionId, table, policy: fresh.policy, now: q.now }),
    )
  } else {
    table = rebuildToolTable(tableKey, stored, q.state.specs)
  }
  const sent = q.model.supportsToolCalling && q.toolsWithheld === null
  if (!sent && (q.state.lastSent.get(tableKey) ?? true)) {
    const withheld: ToolsWithheldPayload = {
      providerId,
      modelId: q.model.id,
      tableKey,
      reason: q.toolsWithheld ?? 'model-without-tools',
    }
    facts.push(
      view.entry('view/tools_withheld', {
        sourceType: 'runtime_event',
        sourceId: q.runId,
        sourceSeq: q.requestSeq,
        provenanceKey: toolsWithheldKey(q.runId, q.requestSeq),
        payload: withheld,
        createdAt: q.now(),
      }),
    )
  }
  const assemblyRef = assembledKey(q.runId, q.requestSeq)
  const assembled: ViewAssembledPayload = {
    modelInfoHash: modelHash,
    systemHash: systemHash(system ?? undefined),
    tools: { tableKey, sent },
  }
  facts.push(
    view.entry('view/assembled', {
      sourceType: 'runtime_event',
      sourceId: q.runId,
      sourceSeq: q.requestSeq,
      provenanceKey: assemblyRef,
      payload: assembled,
      createdAt: q.now(),
    }),
  )
  return {
    system,
    tools: sent ? table.items.map((item) => item.spec) : undefined,
    table,
    opened,
    sent,
    facts,
    assemblyRef,
  }
}
