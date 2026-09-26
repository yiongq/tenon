/**
 * The inspector interface (spec 02 §Inspector 接口与合议). An inspector gives each call one of three
 * opinions — none, ask, deny — and never "allow".
 *
 * Plan step 5 declared `InspectorCategory` and `FlaggedCategory`, which the `flagged` approval reason
 * needs; plan step 8 added `InspectorFinding`, which the decision record (`permission/record.ts`)
 * references; plan step 9 the opinions and the registration shape, because
 * `SessionServiceOptions.inspectors` takes them. Plan step 12 adds the first half of a decision
 * (§判决记录与摘要): running every inspector, with a time limit the kernel sets by `kind`, and folding a
 * timeout, an error or an answer beyond the declared ceiling into an outcome `decide()` reads.
 */
import type { HostClock } from '../host/adapter.js'
import type { InspectorOutcome } from './decide.js'
import type { AfterResultInput, BeforeCallInput, ResultMarker } from './session-view.js'

export type InspectorCategory = 'exfiltration' // what an inspector may report; only ever added to
/** The second value is produced by the kernel alone; shared by `flagged` cards and `inspector` blocks. */
export type FlaggedCategory = InspectorCategory | 'inspector-failed'

export interface InspectorFinding {
  readonly code: string // 发现代码，记进判决记录的「依据」
  readonly confidence?: number // 0–1，只进判决记录
}

export type AskOpinion =
  | { readonly kind: 'none'; readonly findings?: readonly InspectorFinding[] } // 只观察的命中也放在这里，只进记录
  | {
      readonly kind: 'ask'
      readonly category: InspectorCategory
      readonly findings: readonly InspectorFinding[]
    }

export type DenyOpinion =
  | AskOpinion
  | {
      readonly kind: 'deny'
      readonly category: InspectorCategory
      readonly findings: readonly InspectorFinding[]
    }

interface InspectorBase {
  readonly id: string // 服务内唯一，写进判决记录
  readonly kind: 'local-rule' | 'model' // kernel 据此给时限
  /** 结果后挂点。02 只定签名，kernel 不调用；注册时带了它，构造服务就抛错，免得以为它在跑 */
  readonly afterResult?: (
    input: AfterResultInput,
    signal: AbortSignal,
  ) => Promise<readonly ResultMarker[]>
}

/**
 * The `ceiling` narrows the return type: an inspector registered with `'ask'` cannot type a denial.
 * Property syntax rather than method shorthand, for the reason `HostNetwork.fetch` gives: a method
 * is bivariant in its parameters, a property is checked.
 */
export type InspectorRegistration =
  | (InspectorBase & {
      readonly ceiling: 'ask'
      readonly beforeCall: (i: BeforeCallInput, s: AbortSignal) => Promise<AskOpinion>
    })
  | (InspectorBase & {
      readonly ceiling: 'deny'
      readonly beforeCall: (i: BeforeCallInput, s: AbortSignal) => Promise<DenyOpinion>
    })

/** Per `kind`, given by the kernel; an inspector cannot state its own. To be calibrated (F1). */
export const INSPECTOR_TIMEOUT_MS = { 'local-rule': 2_000, model: 30_000 } as const

/** What the first half returns: every outcome in registration order, or that the Run was stopped. */
export type InspectionResult =
  | { readonly stopped: false; readonly outcomes: readonly InspectorOutcome[] }
  | { readonly stopped: true }

/**
 * Runs every inspector on one call, all at once, each against its time limit (F1). An inspector that
 * throws, rejects, answers beyond its declared ceiling or with a malformed opinion is an `error`; one
 * that does not answer in time is a `timeout`; `decide()` folds both into the strictest opinion the
 * ceiling allows. A stop while they run aborts their signals and is not a failure: the result says
 * `stopped`, and the call gets no decision fact — it closes as not-run / stopped (B1).
 */
export async function runInspectors(q: {
  readonly inspectors: readonly InspectorRegistration[]
  readonly input: BeforeCallInput
  readonly setTimeout: HostClock['setTimeout']
  readonly signal: AbortSignal
}): Promise<InspectionResult> {
  if (q.signal.aborted) return { stopped: true }
  const controllers = q.inspectors.map(() => new AbortController())
  const onStop = (): void => {
    for (const controller of controllers) controller.abort(q.signal.reason)
  }
  q.signal.addEventListener('abort', onStop, { once: true })
  const stopped = new Promise<'stopped'>((resolve) => {
    q.signal.addEventListener('abort', () => resolve('stopped'), { once: true })
  })
  try {
    const running = Promise.all(
      q.inspectors.map((inspector, i) => {
        const controller = controllers[i] ?? new AbortController()
        return inspectOne(inspector, q.input, q.setTimeout, controller)
      }),
    )
    const settled = await Promise.race([running, stopped])
    if (settled === 'stopped') return { stopped: true }
    return { stopped: false, outcomes: settled }
  } finally {
    q.signal.removeEventListener('abort', onStop)
  }
}

async function inspectOne(
  inspector: InspectorRegistration,
  input: BeforeCallInput,
  setTimeout: HostClock['setTimeout'],
  controller: AbortController,
): Promise<InspectorOutcome> {
  const base = { inspectorId: inspector.id, ceiling: inspector.ceiling }
  let cancel: () => void = noop
  const timedOut = new Promise<'timeout'>((resolve) => {
    cancel = setTimeout(() => {
      controller.abort('timeout')
      resolve('timeout')
    }, INSPECTOR_TIMEOUT_MS[inspector.kind])
  })
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() => inspector.beforeCall(input, controller.signal)),
      timedOut,
    ])
    if (answer === 'timeout') return { ...base, status: 'timeout' }
    const opinion = validOpinion(answer, inspector.ceiling)
    return opinion === null ? { ...base, status: 'error' } : { ...base, status: 'ok', opinion }
  } catch {
    return { ...base, status: 'error' }
  } finally {
    cancel()
  }
}

function noop(): void {}

const CATEGORIES: ReadonlySet<string> = new Set<InspectorCategory>(['exfiltration'])

/** The opinion if it has the declared shape and stays within the ceiling; null otherwise. */
function validOpinion(value: unknown, ceiling: 'ask' | 'deny'): DenyOpinion | null {
  if (typeof value !== 'object' || value === null) return null
  const opinion = value as Record<string, unknown>
  const findings = opinion['findings']
  const findingsOk =
    findings === undefined ||
    (Array.isArray(findings) &&
      findings.every(
        (f) =>
          typeof f === 'object' &&
          f !== null &&
          typeof (f as Record<string, unknown>)['code'] === 'string',
      ))
  if (!findingsOk) return null
  if (opinion['kind'] === 'none') return value as DenyOpinion
  if (opinion['kind'] !== 'ask' && opinion['kind'] !== 'deny') return null
  if (opinion['kind'] === 'deny' && ceiling === 'ask') return null
  if (typeof opinion['category'] !== 'string' || !CATEGORIES.has(opinion['category'])) return null
  if (!Array.isArray(findings)) return null
  return value as DenyOpinion
}
