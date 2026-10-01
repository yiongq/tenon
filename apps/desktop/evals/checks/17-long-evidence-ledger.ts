import type { EvalCheck } from './types.js'
import { callsOf, readSession } from './support.js'
import { jsonFile } from './task-data.js'
const check: EvalCheck = async (ctx) => {
  const entries = await readSession(ctx.tape, ctx.sessionId)
  // Count actual numbered Read output, including every archival line and the final code.
  // A character threshold admits partial prefixes; a correct ledger alone can be inferred from
  // generate.mjs. Separate Read calls may cover the document, but no missing line is accepted.
  const covered = new Map<string, Set<number>>()
  for (const call of callsOf(entries)) {
    if (call.name !== 'Read' || call.result?.isError !== false) continue
    const id = /corpus\/(\d{2})\.txt$/.exec(String(call.input['file_path']))?.[1]
    if (!id || Number(id) < 1 || Number(id) > 60) continue
    const lines = covered.get(id) ?? new Set<number>()
    for (const output of call.result.text.split('\n')) {
      const match = /^(\d+)\t(.*)$/.exec(output)
      if (!match) continue
      const line = Number(match[1])
      const expected =
        line >= 1 && line <= 180
          ? `Station ${id} observation ${line - 1}: archived measurements are informational; preserve identifiers and do not infer a final approved value from these historical samples.`
          : line === 181
            ? ''
            : line === 182
              ? `FINAL_APPROVED_CODE=${7000 + Number(id) * 13}`
              : null
      if (expected !== null && match[2] === expected) lines.add(line)
    }
    covered.set(id, lines)
  }
  const fullDocuments = [...covered.values()].filter((lines) => lines.size === 182).length
  const attempts = entries.filter((e) => e.name === 'provider/attempt_completed')
  const input = attempts.map(
    (e) => (e.payload['usage'] as { inputTokens?: number } | null)?.inputTokens ?? null,
  )
  const anchor = entries.filter((e) => e.name === 'compaction/anchor').length
  const result = await jsonFile(
    'ledger.json',
    Array.from({ length: 60 }, (_, i) => ({
      id: String(i + 1).padStart(2, '0'),
      code: 7000 + (i + 1) * 13,
    })),
  )(ctx)
  return {
    pass: result.pass && fullDocuments === 60,
    note: `Read complete documents=${fullDocuments}; anchors=${anchor}; per-attempt inputTokens=${JSON.stringify(input)}; ${result.note}; calibration observation only: anchor count has no fixed target`,
  }
}
export default check
