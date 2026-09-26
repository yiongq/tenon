/**
 * The inspector interface (spec 02 §Inspector 接口与合议). An inspector gives each call one of three
 * opinions — none, ask, deny — and never "allow".
 *
 * Plan step 5 declared `InspectorCategory` and `FlaggedCategory`, which the `flagged` approval reason
 * needs; plan step 8 added `InspectorFinding`, which the decision record (`permission/record.ts`)
 * references; plan step 9 adds the opinions and the registration shape, because
 * `SessionServiceOptions.inspectors` takes them. All are declared exactly as the spec writes them;
 * the steps that run inspectors (11, 12, 29) implement them without changing the shape.
 */
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
