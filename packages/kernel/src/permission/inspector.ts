/**
 * The inspector interface (spec 02 §Inspector 接口与合议). An inspector gives each call one of three
 * opinions — none, ask, deny — and never "allow".
 *
 * Plan step 5 declares `InspectorCategory` and `FlaggedCategory`, which the `flagged` approval reason
 * needs; plan step 8 adds `InspectorFinding`, which the decision record (`permission/record.ts`)
 * references. The opinions and the registration shape arrive in plan step 9. All are declared
 * exactly as the spec writes them; the later steps implement them without changing the shape.
 */

export type InspectorCategory = 'exfiltration' // what an inspector may report; only ever added to
/** The second value is produced by the kernel alone; shared by `flagged` cards and `inspector` blocks. */
export type FlaggedCategory = InspectorCategory | 'inspector-failed'

export interface InspectorFinding {
  readonly code: string // 发现代码，记进判决记录的「依据」
  readonly confidence?: number // 0–1，只进判决记录
}
