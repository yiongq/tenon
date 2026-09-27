/**
 * Large tool results written to disk (spec 02 §大响应落盘; H9, A13).
 *
 * The record type is plan step 8's, because `ToolResultPayload.spill` (§载荷) references it. The
 * threshold and the counting function come forward to plan step 18 (open question 24): every Read
 * keeps its own result under the threshold with the same count, so the spill check — plan step 24 —
 * never holds for it.
 */
import type { AbsolutePath, HostFs } from '../host/adapter.js'
import { joinPath } from '../host/path.js'
import { toolOutputDirFor } from '../host/profile.js'
import { MODEL_NOTES, fill } from '../prompts/index.js'
import { sha256Hex } from '../tape/hash.js'
import type { CallRef, ResultContent } from './closure.js'

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

/** A result as its `tool/result` is written: what the model reads, and the file its text went to. */
export interface CheckedResult {
  readonly content: ResultContent
  readonly isError: boolean
  readonly kernelAuthored: boolean
  readonly spill?: SpillRecord
}

/**
 * `<runId>-<requestSeq>-<i>.txt`, from the call's identity alone (§键与挂靠) — never a string a model
 * or a vendor gave — so it has no `/` and names one call's result.
 */
export function spillFileName(call: CallRef): string {
  return `${call.runId}-${String(call.requestSeq)}-${String(call.ordinal)}.txt`
}

/**
 * The spill check (§大响应落盘「判断点只有一个」), run on a result just before its `tool/result` is
 * written, whatever the tool, a failed result as well as a good one. Past `SPILL_THRESHOLD_CHARS`, the
 * text blocks, joined by `\n` in their order, are written as UTF-8 to the session's `tool-output/`
 * folder — the file first, the result after — and the result's text becomes `MODEL_NOTES.spill`, with
 * the image blocks after it as they were. The note carries the tool's own text, so it is not
 * kernel-authored, and it is stored filled: a replay sends it as stored (A13). The hash is of the
 * bytes written, taken here, outside the append transaction. The full text and the path stay out of
 * every other payload: `spill.file` is the bare file name.
 *
 * A spill file is written once, under a name no earlier write used, so an entry already under that
 * name is refused, not written through: a link planted at the next name, which `writeFile` would
 * follow onto the file it names, or a dangling one (its `realpath` throws), which would create the
 * file it points to — the same re-check as Write's (§「在不在工作区里」第 5 步). A check and the write
 * after it still race, as there (第 6 步).
 *
 * A failed write — the folder, the file, a name already taken, a text too long to encode — makes the
 * result is_error with `MODEL_NOTES.spillFailed`: the preview, and no path, as no file holds the rest.
 * The error goes to the log only, since its message may name the path.
 */
export async function spillChecked(q: {
  readonly fs: HostFs
  readonly profileDir: AbsolutePath
  readonly sessionId: string
  readonly call: CallRef
  readonly result: Omit<CheckedResult, 'spill'>
  readonly log: (line: string) => void
}): Promise<CheckedResult> {
  const { content } = q.result
  if (textChars(content) <= SPILL_THRESHOLD_CHARS) return q.result
  const texts = content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  const images = content.filter((block) => block.type === 'image')
  const preview = spillPreview(texts)
  const dir = toolOutputDirFor(q.profileDir, q.sessionId)
  const file = spillFileName(q.call)
  const path = joinPath(dir, file)
  let bytes: Uint8Array
  try {
    bytes = new TextEncoder().encode(texts.join('\n'))
    await q.fs.mkdirp(dir)
    if ((await q.fs.realpath(path)) !== null) throw new Error(`${path} is already there`)
    await q.fs.writeFile(path, bytes)
  } catch (error) {
    q.log(
      `[loop] the result of ${file} could not be saved, so it goes back cut short: ${error instanceof Error ? error.message : String(error)}`,
    )
    return {
      content: [{ type: 'text', text: fill(MODEL_NOTES.spillFailed, { preview }) }, ...images],
      isError: true,
      kernelAuthored: false,
    }
  }
  const spill: SpillRecord = { file, bytes: bytes.length, sha256: sha256Hex(bytes) }
  const note = fill(MODEL_NOTES.spill, { bytes: String(spill.bytes), path, preview })
  return {
    content: [{ type: 'text', text: note }, ...images],
    isError: q.result.isError,
    kernelAuthored: false,
    spill,
  }
}

/**
 * The first `SPILL_PREVIEW_CHARS` characters of the texts joined by `\n` — one character fewer when
 * the cut would split a surrogate pair — without joining more of them than that takes.
 */
export function spillPreview(texts: readonly string[]): string {
  let head = ''
  for (const [k, text] of texts.entries()) {
    if (head.length > SPILL_PREVIEW_CHARS) break
    head += `${k === 0 ? '' : '\n'}${text.slice(0, SPILL_PREVIEW_CHARS + 1)}`
  }
  let cut = Math.min(head.length, SPILL_PREVIEW_CHARS)
  if (cut < head.length && isHigh(head.charCodeAt(cut - 1)) && isLow(head.charCodeAt(cut))) cut -= 1
  return head.slice(0, cut)
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
