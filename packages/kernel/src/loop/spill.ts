/**
 * Large tool results written to disk (spec 02 §大响应落盘).
 *
 * Only the record type is declared in plan step 8, because `ToolResultPayload.spill` (§载荷)
 * references it. The thresholds and the write path arrive with the spill step and do not change it.
 */

/** `ToolResultPayload.spill?`: the spilled file's relative name, UTF-8 byte count and SHA-256 (hex). */
export type SpillRecord = { file: string; bytes: number; sha256: string }
