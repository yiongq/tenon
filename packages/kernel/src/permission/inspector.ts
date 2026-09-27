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
 *
 * The inspectors are handed a frozen copy of the input (§挂点与会话视图「只读的会话视图」): one that
 * writes to it fails as an `error`, and the call is judged, shown and run on the arguments the model
 * gave (§railguard 映射「按原参数判定」).
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
  const input = frozenCopy(q.input)
  try {
    const running = Promise.all(
      q.inspectors.map((inspector, i) => {
        const controller = controllers[i] ?? new AbortController()
        return inspectOne(inspector, input, q.setTimeout, controller)
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

/** The keys an opinion of each kind may carry, and a finding. */
const NONE_KEYS: ReadonlySet<string> = new Set(['kind', 'findings'])
const JUDGING_KEYS: ReadonlySet<string> = new Set(['kind', 'category', 'findings'])
const FINDING_KEYS: ReadonlySet<string> = new Set(['code', 'confidence'])

/**
 * The opinion, rebuilt as a plain object, if it has the declared shape and stays within the ceiling;
 * null otherwise — an `error` (F1「形状不对，按出错处理」). Every property is read once, through its
 * descriptor, so what is checked is what `decide()` reads and the record keeps: an accessor, a key the
 * type does not declare (an explicit `undefined` included), a finding without a code or with a
 * `confidence` outside 0–1 are all off-shape (§Inspector 接口与合议「意见里只有代码没有文字」).
 */
function validOpinion(value: unknown, ceiling: 'ask' | 'deny'): DenyOpinion | null {
  const opinion = dataFields(value)
  if (opinion === null) return null
  const kind = opinion.get('kind')
  if (kind !== 'none' && kind !== 'ask' && kind !== 'deny') return null
  if (kind === 'deny' && ceiling === 'ask') return null
  const keys = kind === 'none' ? NONE_KEYS : JUDGING_KEYS
  if ([...opinion.keys()].some((key) => !keys.has(key))) return null
  const findings = opinion.has('findings') ? validFindings(opinion.get('findings')) : undefined
  if (findings === null) return null
  if (kind === 'none') return findings === undefined ? { kind } : { kind, findings }
  const category = opinion.get('category')
  if (typeof category !== 'string' || !CATEGORIES.has(category)) return null
  if (findings === undefined) return null
  return { kind, category: category as InspectorCategory, findings }
}

function validFindings(value: unknown): InspectorFinding[] | null {
  if (!Array.isArray(value)) return null
  const findings: InspectorFinding[] = []
  for (let i = 0; i < value.length; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(value, i)
    if (slot === undefined || !('value' in slot)) return null
    const finding = dataFields(slot.value)
    if (finding === null || [...finding.keys()].some((key) => !FINDING_KEYS.has(key))) return null
    const code = finding.get('code')
    if (typeof code !== 'string' || code === '') return null
    if (!finding.has('confidence')) {
      findings.push({ code })
      continue
    }
    const confidence = finding.get('confidence')
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) return null
    findings.push({ code, confidence })
  }
  return findings
}

/**
 * A plain object's own properties, each read once through its descriptor; null for anything else —
 * an array, a class instance, a symbol key, an accessor (whose getter could answer differently on the
 * next read).
 */
function dataFields(value: unknown): Map<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const fields = new Map<string, unknown>()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (property === undefined || !('value' in property)) return null
    fields.set(key, property.value)
  }
  return fields
}

/** A deep copy of plain data, frozen all the way down. */
function frozenCopy<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  const copy: unknown = Array.isArray(value)
    ? value.map((item: unknown) => frozenCopy(item))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozenCopy(item)]))
  return Object.freeze(copy) as T
}
