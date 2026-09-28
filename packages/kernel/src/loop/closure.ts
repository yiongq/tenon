/**
 * How a single tool call is closed (spec 02 §原因码表, §写入：谁写、写几次). §02 的 Tape 事实, §子 agent
 * 契约 and §权限引擎 · Inspector 与判决记录 reference these names; the vocabulary only grows.
 *
 * Every client call ends with exactly one `tool/result` and one `execution/tool_outcome`, written in
 * one batch. A call that did not run normally gets a kernel-authored result — the closure's fixed
 * English, only the model reads it — and an outcome whose `source` names why. The types were declared
 * in plan step 8, `BLOCKED_FACT_KEYS` in step 11; the writers are step 13's.
 */
import type { Reversibility } from '../host/adapter.js'
import { MODEL_NOTES, fill } from '../prompts/index.js'
import type { ContentBlock } from '../provider/types.js'
import type {
  AskAnswerRecord,
  FactWriter,
  NewEntry,
  SideEffectClass,
  ToolOutcomePayload,
  ToolResultPayload,
} from '../tape/entry.js'
import { toolOutcomeKey, toolResultKey } from '../tape/provenance.js'
import type { Tape } from '../tape/tape.js'
import type { SpillRecord } from './spill.js'

export type ExecutionState = 'not-run' | 'aborted' | 'completed' | 'uncertain'

export type BlockReason = 'policy' | 'user-disabled' | 'protected' | 'inspector' // 阶段 4 只增 'sandbox'

export type ClosureSource =
  | BlockReason
  | 'user-rejected'
  | 'stopped'
  | 'timed-out' // Bash ran past its timeout (open question 17)
  | 'superseded'
  | 'tool-unavailable'
  | 'invalid-input' // arguments failed validation before permission (open question 16)
  | 'crashed'
  | 'app-exit'
  | 'output-truncated'
  | 'step-limit'
  | 'no-progress'
  | 'usage-limit'
  | 'blocked-repeatedly'
  | 'content-filter'
  | 'provider-error'
  | 'repair'
  | 'no-preference'
  | 'unanswered'
  | 'typed-answer'

/**
 * The required slots of a blocking code, written like `CONFIRM_FACT_KEYS` (host/adapter.ts). The
 * policy id and version go into the decision record only, never into facts (D5, F8).
 */
export const BLOCKED_FACT_KEYS: Readonly<Record<BlockReason, readonly string[]>> = {
  policy: ['toolName'],
  'user-disabled': ['toolName'],
  protected: ['toolName', 'target'], // target：被拦的路径或主机
  inspector: ['toolName', 'category'],
}

/** A call's identity across its facts (§键与挂靠): the request it was made in, and its `<i>`. */
export interface CallRef {
  readonly runId: string
  readonly requestSeq: number
  readonly ordinal: number
  readonly providerToolCallId: string
}

/** The content a result carries: what the model reads. */
export type ResultContent = Array<Extract<ContentBlock, { type: 'text' | 'image' }>>

export interface ResultFacts {
  readonly tape: Tape
  readonly now: () => number
  readonly call: CallRef
  readonly content: ResultContent
  readonly isError: boolean
  readonly kernelAuthored: boolean
  /** The file the result's whole text went to (§大响应落盘): `spillChecked` gives it. */
  readonly spill?: SpillRecord
  /** An answered AskUserQuestion's record, for the summary card (open question 18). */
  readonly question?: AskAnswerRecord
  readonly effect: SideEffectClass
  readonly state: ExecutionState
  readonly source: ClosureSource | null
  readonly facts?: Readonly<Record<string, string>>
  readonly reversibility: Reversibility
  readonly writer: FactWriter
}

/** `tool/result` and `execution/tool_outcome` of one call, the pair written in one batch. */
export function resultFacts(q: ResultFacts): NewEntry[] {
  const { call } = q
  const identity = {
    sourceType: 'runtime_event' as const,
    sourceId: call.runId,
    sourceSeq: call.requestSeq,
  }
  const result: ToolResultPayload = {
    ordinal: call.ordinal,
    providerToolCallId: call.providerToolCallId,
    isError: q.isError,
    content: [...q.content],
    kernelAuthored: q.kernelAuthored,
    ...(q.spill === undefined ? {} : { spill: { ...q.spill } }),
    ...(q.question === undefined ? {} : { question: q.question }),
    writer: q.writer,
  }
  const outcome: ToolOutcomePayload = {
    ordinal: call.ordinal,
    providerToolCallId: call.providerToolCallId,
    effect: q.effect,
    state: q.state,
    source: q.source,
    ...(q.facts === undefined ? {} : { facts: { ...q.facts } }),
    reversibility: q.reversibility,
    writer: q.writer,
  }
  return [
    q.tape.writer('tool').entry('tool/result', {
      ...identity,
      provenanceKey: toolResultKey(call.runId, call.requestSeq, call.ordinal),
      payload: result,
      createdAt: q.now(),
    }),
    q.tape.writer('execution').entry('execution/tool_outcome', {
      ...identity,
      provenanceKey: toolOutcomeKey(call.runId, call.requestSeq, call.ordinal),
      payload: outcome,
      createdAt: q.now(),
    }),
  ]
}

/**
 * The fixed English a closure sends back (§提示层 `MODEL_NOTES.closure`): the cell for this source
 * and state, filled with the block's slots; a failed inspector's own sentence instead when the
 * blocking step did not answer (§Inspector 接口与合议). A second text block carries the reason when
 * there is one — the validator's message, a command's output before a stop.
 */
export function closureContent(q: {
  readonly source: Exclude<ClosureSource, 'no-preference' | 'typed-answer'>
  readonly state: ExecutionState
  readonly facts?: Readonly<Record<string, string>>
  readonly inspectorStatus?: 'timeout' | 'error'
  readonly detail?: string
}): ResultContent {
  const cell =
    q.source === 'inspector' && q.inspectorStatus !== undefined
      ? MODEL_NOTES.inspectorFailed[q.inspectorStatus]
      : MODEL_NOTES.closure[q.source]?.[q.state]
  if (cell === undefined) {
    throw new Error(`closure: no note for ${q.source} / ${q.state} yet (MODEL_NOTES.closure)`)
  }
  const blocks: ResultContent = [{ type: 'text', text: fill(cell, q.facts ?? {}) }]
  if (q.detail !== undefined && q.detail !== '') blocks.push({ type: 'text', text: q.detail })
  return blocks
}

/** A closure that never ran the call: not-run, blocked, kernel-authored — the common case. */
export function notRunFacts(q: {
  readonly tape: Tape
  readonly now: () => number
  readonly call: CallRef
  readonly source: Exclude<ClosureSource, 'no-preference' | 'typed-answer'>
  readonly facts?: Readonly<Record<string, string>>
  readonly inspectorStatus?: 'timeout' | 'error'
  readonly detail?: string
  readonly reversibility?: Reversibility
  readonly writer: FactWriter
}): NewEntry[] {
  return resultFacts({
    tape: q.tape,
    now: q.now,
    call: q.call,
    content: closureContent({
      source: q.source,
      state: 'not-run',
      ...(q.facts === undefined ? {} : { facts: q.facts }),
      ...(q.inspectorStatus === undefined ? {} : { inspectorStatus: q.inspectorStatus }),
      ...(q.detail === undefined ? {} : { detail: q.detail }),
    }),
    isError: true,
    kernelAuthored: true,
    effect: 'blocked',
    state: 'not-run',
    source: q.source,
    ...(isBlockReason(q.source) && q.facts !== undefined ? { facts: q.facts } : {}),
    // A call closed with no decision fact records unknown (§载荷 ToolOutcomePayload.reversibility).
    reversibility: q.reversibility ?? 'unknown',
    writer: q.writer,
  })
}

/**
 * The fallback closure (§崩溃、服务端调用块与兜底「兜底」, §原因码表 `repair`): a call with no result
 * reached a request. Not-run and blocked when it was never dispatched; uncertain, with the effect its
 * tool would have had, when it was.
 */
export function repairFacts(q: {
  readonly tape: Tape
  readonly now: () => number
  readonly call: CallRef
  readonly dispatched: boolean
  readonly effect: SideEffectClass
  readonly writer: FactWriter
}): NewEntry[] {
  const state: ExecutionState = q.dispatched ? 'uncertain' : 'not-run'
  return resultFacts({
    tape: q.tape,
    now: q.now,
    call: q.call,
    content: closureContent({ source: 'repair', state }),
    isError: true,
    kernelAuthored: true,
    effect: q.dispatched ? q.effect : 'blocked',
    state,
    source: 'repair',
    reversibility: 'unknown',
    writer: q.writer,
  })
}

const BLOCK_REASONS: ReadonlySet<string> = new Set(Object.keys(BLOCKED_FACT_KEYS))

export function isBlockReason(source: ClosureSource | null): source is BlockReason {
  return source !== null && BLOCK_REASONS.has(source)
}
