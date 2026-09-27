/**
 * Large tool results written to disk (spec 02 §大响应落盘).
 *
 * The record type is plan step 8's, because `ToolResultPayload.spill` (§载荷) references it. The
 * threshold and the counting function come forward to plan step 18 (open question 24): every Read
 * keeps its own result under the threshold with the same count, so the spill check — plan step 24 —
 * never holds for it.
 */
import type { ResultContent } from './closure.js'

/** `ToolResultPayload.spill?`: the spilled file's relative name, UTF-8 byte count and SHA-256 (hex). */
export type SpillRecord = { file: string; bytes: number; sha256: string }

/** Past this many characters of text a result is written to disk (暂定; calibrated in plan step 34). */
export const SPILL_THRESHOLD_CHARS = 30_000
/** How much of a spilled result the model sees (暂定; calibrated in plan step 34). */
export const SPILL_PREVIEW_CHARS = 2_000

/**
 * The one count both sides use: the characters of every `text` block, in UTF-16 code units
 * (`String.length`). An `image` block does not count.
 */
export function textChars(content: ResultContent): number {
  let chars = 0
  for (const block of content) if (block.type === 'text') chars += block.text.length
  return chars
}
