/**
 * The probe of a custom vendor's row (M6 §探测): what one run of it leaves behind.
 *
 * The snapshot is data stored next to its model row in `config.json` (§存储, T3) and restated by
 * contracts' `probeSnapshotSchema`; a contracts test assigns the two both ways, so a field added on
 * either side is a compile error there.
 */
import type { ModelInfo } from './types.js'

/** §探测「结果与原因码」: one code per row of the table, each with its own copy in both locales. */
export type ProbeReason =
  | 'no-tool-call'
  | 'output-limit'
  | 'no-finish'
  | 'config'
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'request-rejected'
  | 'echo-rejected'
  | 'bad-tool-call'
  | 'opaque-fields'
  | 'service'

export type ProbeSnapshot = {
  /** Passed; not detected (try again); failed (with a reason, and also worth another try). */
  outcome: 'passed' | 'not-detected' | 'failed'
  /** null when passed. */
  reason: ProbeReason | null
  /** `HostClock` epoch ms; shown, never compared. */
  probedAt: number
  /** The thinking field the openai-chat wire saw; always null on anthropic-messages. */
  reasoningField: NonNullable<ModelInfo['reasoningEchoField']> | null
  /** The output-limit key that worked (T10); always null on anthropic-messages. */
  maxTokensField: NonNullable<ModelInfo['maxTokensField']> | null
  /** A final usage reading arrived on the standard path (T10). */
  usageSeen: boolean
  /** The model name the vendor reported, shown and never judged (Q5). */
  responseModelId: string | null
  /** Q14: the names of the fields Tenon cannot send back, never their values. */
  unknownFields: string[]
}
