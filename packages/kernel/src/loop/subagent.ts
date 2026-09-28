/**
 * The sub-agent handoff (spec 02 §交接): what a parent session's Agent call gets back, generated
 * mechanically from the child session's tape — never by a model.
 *
 * Declared in plan step 8 because `ToolResultPayload.handoff` (§载荷) references it. If the
 * sub-agent is cut (plan.md 进度吃紧时的砍法), this shape stays: ① and ② already depend on it.
 */
import type { ConfirmTarget } from '../host/adapter.js'
import { MODEL_NOTES, fill } from '../prompts/index.js'
import { canonicalJson } from '../tape/canonical-json.js'
import type {
  FactWriter,
  PermissionDecidedPayload,
  RunTerminalPayload,
  RunUsageLine,
  TapeEntry,
  ToolCallPayload,
  ToolOutcomePayload,
} from '../tape/entry.js'
import { effectiveMessages } from '../tape/replay.js'
import type { ClosureSource, ExecutionState } from './closure.js'
import type { RunEndReason } from './terminal.js'

export interface SubagentHandoff {
  readonly childSessionId: string
  readonly outcome: 'completed' | 'partial' | 'aborted' | 'superseded' | 'uncertain'
  readonly childEndReason: RunEndReason['code'] | null // 子会话最后一个 Run 的结束原因；子会话停在等待上时被停止或取代，记 null
  readonly finalReply: string // 子会话最后一条 message/assistant 的文本块原样拼接，没有就是 ''
  readonly calls: readonly HandoffCall[] // 子会话的每个工具调用各占一行，按 Tape 顺序
  readonly usage: readonly RunUsageLine[] // 子会话各 Run 的 run_terminal.usage，按 (providerId, modelId) 合并，origin 为 'own'
}

export interface HandoffCall {
  readonly toolName: string
  readonly target: string // 与审批卡的「对象」用同一算法（E4）
  readonly state: ExecutionState
  readonly source: ClosureSource | null // 没正常执行完的才有，例如 user-rejected（F2）
}

/** Waiting between Runs is absent from these intervals, including across restart. */
export function subagentElapsedMs(
  runs: readonly { readonly startedAt: number; readonly endedAt: number | null }[],
  now: number,
): number {
  return runs.reduce((total, run) => total + Math.max(0, (run.endedAt ?? now) - run.startedAt), 0)
}

/** Recovery must not charge the time the application was not running. */
export function subagentElapsedFromTape(entries: readonly TapeEntry[], now: number): number {
  return subagentElapsedMs(
    entries
      .filter((entry) => entry.name === 'execution/run_started')
      .map((start) => {
        const terminal = entries.find(
          (entry) => entry.name === 'execution/run_terminal' && entry.sourceId === start.sourceId,
        )
        if (terminal === undefined) return { startedAt: start.createdAt, endedAt: null }
        if ((terminal.payload['writer'] as FactWriter).by !== 'recovery')
          return { startedAt: start.createdAt, endedAt: terminal.createdAt }
        const last = entries.findLast((entry) => {
          if (entry.entryId < start.entryId || entry.entryId >= terminal.entryId) return false
          const writer = entry.payload['writer'] as FactWriter | undefined
          if (writer !== undefined) return writer.by === 'run' && writer.runId === start.sourceId
          return entry.sourceId === start.sourceId || entry.payload['runId'] === start.sourceId
        })
        return { startedAt: start.createdAt, endedAt: last?.createdAt ?? start.createdAt }
      }),
    now,
  )
}

function callKey(entry: TapeEntry): string {
  return `${String(entry.sourceId)}:${String(entry.sourceSeq)}:${String(entry.payload['ordinal'])}`
}

/** Data formatting, shared by every handoff outcome; never resolves paths again. */
function targetText(target: ConfirmTarget): string {
  switch (target.type) {
    case 'path':
      return target.path
    case 'url':
      return target.url
    case 'command':
      return fill(MODEL_NOTES.handoff.target.command, target)
    case 'search':
      return fill(MODEL_NOTES.handoff.target.search, target)
    case 'tool':
      return fill(MODEL_NOTES.handoff.target.tool, target)
  }
}

/** The caller closes all child calls before creating this immutable result. */
export function buildSubagentHandoff(
  entries: readonly TapeEntry[],
  q: { readonly childSessionId: string; readonly outcome?: 'aborted' | 'superseded' | 'uncertain' },
): SubagentHandoff {
  const decisions = new Map<string, PermissionDecidedPayload>()
  const latestDecisions = new Map<string, PermissionDecidedPayload>()
  const dispatches = new Map<string, string>()
  const outcomes = new Map<string, ToolOutcomePayload>()
  const usage = new Map<string, RunUsageLine>()
  let lastTerminal: RunTerminalPayload | undefined
  for (const entry of entries) {
    if (entry.name === 'tool/permission_decided') {
      const decision = entry.payload as unknown as PermissionDecidedPayload
      decisions.set(entry.provenanceKey, decision)
      latestDecisions.set(callKey(entry), decision)
    } else if (entry.name === 'execution/dispatch_committed') {
      dispatches.set(callKey(entry), String(entry.payload['decisionKey']))
    } else if (entry.name === 'execution/tool_outcome') {
      outcomes.set(callKey(entry), entry.payload as unknown as ToolOutcomePayload)
    } else if (entry.name === 'execution/run_terminal') {
      lastTerminal = entry.payload as unknown as RunTerminalPayload
      for (const line of lastTerminal.usage) {
        const key = `${line.providerId}\u0000${line.modelId}`
        const previous = usage.get(key)
        usage.set(key, {
          providerId: line.providerId,
          modelId: line.modelId,
          origin: 'own',
          requests: (previous?.requests ?? 0) + line.requests,
          inputTokens: (previous?.inputTokens ?? 0) + line.inputTokens,
          outputTokens: (previous?.outputTokens ?? 0) + line.outputTokens,
          cacheReadTokens: (previous?.cacheReadTokens ?? 0) + line.cacheReadTokens,
          cacheWriteTokens: (previous?.cacheWriteTokens ?? 0) + line.cacheWriteTokens,
          reasoningTokens: (previous?.reasoningTokens ?? 0) + line.reasoningTokens,
        })
      }
    }
  }
  const childEndReason =
    lastTerminal?.reason.code === 'paused' ? null : (lastTerminal?.reason.code ?? null)
  if (q.outcome === undefined && childEndReason === null)
    throw new Error('Cannot hand off a child that has not ended')
  const calls = entries
    .filter((entry) => entry.name === 'tool/call')
    .map((entry): HandoffCall => {
      const key = callKey(entry)
      const call = entry.payload as unknown as ToolCallPayload
      const outcome = outcomes.get(key)
      if (outcome === undefined) throw new Error(`Cannot hand off an open child call: ${key}`)
      const dispatched = dispatches.get(key)
      const decision =
        dispatched === undefined ? latestDecisions.get(key) : decisions.get(dispatched)
      // The optional member is read structurally so old tapes and callers remain compatible.
      const target =
        (decision as (PermissionDecidedPayload & { target?: ConfirmTarget }) | undefined)?.target ??
        decision?.confirm?.target
      return {
        toolName: call.name,
        target:
          target === undefined
            ? fill(MODEL_NOTES.handoff.target.unresolved, {
                toolName: call.name,
                input: canonicalJson(call.input),
              })
            : targetText(target),
        state: outcome.state,
        source: outcome.source,
      }
    })
  const lastReply = effectiveMessages(entries).findLast((message) => message.role === 'assistant')
  return {
    childSessionId: q.childSessionId,
    outcome: q.outcome ?? (childEndReason === 'completed' ? 'completed' : 'partial'),
    childEndReason,
    finalReply:
      lastReply?.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('') ?? '',
    calls,
    usage: [...usage.values()],
  }
}

/** Persist this text with the result; later prompt versions never rewrite it. */
export function handoffText(handoff: SubagentHandoff): string {
  const parts: string[] = []
  if (handoff.outcome !== 'completed')
    parts.push(
      fill(MODEL_NOTES.handoff.status[handoff.outcome], {
        outcome: handoff.outcome,
        childEndReason: handoff.childEndReason ?? 'none',
      }),
    )
  if (handoff.finalReply !== '') parts.push(handoff.finalReply)
  const calls =
    handoff.outcome === 'completed'
      ? handoff.calls.filter((call) => call.source === 'user-rejected')
      : handoff.calls
  if (calls.length > 0)
    parts.push(
      calls
        .map((call) =>
          fill(MODEL_NOTES.handoff.call, {
            toolName: call.toolName,
            target: call.target,
            state: call.state,
            source: call.source ?? 'none',
          }),
        )
        .join('\n'),
    )
  return parts.join('\n\n')
}
