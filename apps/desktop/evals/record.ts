/**
 * One line of `docs/evals/results/<YYYY-MM-DD>-<column>.jsonl` (spec 02 §记录格式与费用口径). The
 * interface is the spec's, word for word; `evalRecordSchema` checks every line, the runner's own
 * before it is appended and the other clients' lines the owner writes by hand.
 */
import { z } from 'zod'

// apps/desktop/evals/record.ts —— 新增（02）；results/*.jsonl 每行一条
export interface EvalRecord {
  taskId: string
  run: number
  date: string // date：YYYY-MM-DD
  column: {
    client: 'tenon' | 'claude-desktop' | 'claude-code' | 'opencode'
    model: string
    endpoint: string
  } // 客户端 × 模型 × 入口
  clientVersion: string // Tenon 取 `git describe --always --dirty`，以 prompt 为准；其余取客户端自报的版本
  auth: 'api-key' | 'subscription'
  effort: string | null // null = 没传，用模型默认档
  prompt: { version: number; hash: string; systemHash: string; toolDefinitionsHash: string } | null // 只有 Tenon 列有
  verdict: 'pass' | 'fail' | 'excluded'
  judgedBy: 'script' | 'human'
  note: string
  endReason: string | null // Tenon 列：最后一个 Run 的 RunEndReason code
  toolRounds: number | null
  cards: Record<string, number> // cards：按 ConfirmReason 分别计数的弹卡数
  usage: {
    input: number
    cacheRead: number
    cacheWrite: number
    output: number
    reasoning: number
  } | null // input = 未命中缓存的输入
  cost: { amount: number; currency: 'CNY' | 'USD'; usdCny?: number; fxDate?: string } | null
  durationMs: number | null
  timing?: { ttftMs: number; outputTokensPerSec: number } // timing：测速用，如 flashx
  raw?: string // 仓库外原始记录或录屏的文件名
  calib?: {
    machineDenials?: number
    blockedRecalls?: number
    perRequest?: { input: number; cost: number }[]
  }
}

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const count = z.int().nonnegative()
const amount = z.number().nonnegative()

export const evalRecordSchema = z.strictObject({
  taskId: z.string().min(1),
  run: z.int().positive(),
  date: z.string().regex(DATE_PATTERN),
  column: z.strictObject({
    client: z.enum(['tenon', 'claude-desktop', 'claude-code', 'opencode']),
    model: z.string().min(1),
    endpoint: z.string().min(1),
  }),
  clientVersion: z.string().min(1),
  auth: z.enum(['api-key', 'subscription']),
  effort: z.string().min(1).nullable(),
  prompt: z
    .strictObject({
      version: z.int().positive(),
      hash: z.string().min(1),
      systemHash: z.string().min(1),
      toolDefinitionsHash: z.string().min(1),
    })
    .nullable(),
  verdict: z.enum(['pass', 'fail', 'excluded']),
  judgedBy: z.enum(['script', 'human']),
  note: z.string(),
  endReason: z.string().min(1).nullable(),
  toolRounds: count.nullable(),
  cards: z.record(z.string().min(1), count),
  usage: z
    .strictObject({
      input: count,
      cacheRead: count,
      cacheWrite: count,
      output: count,
      reasoning: count,
    })
    .nullable(),
  cost: z
    .strictObject({
      amount,
      currency: z.enum(['CNY', 'USD']),
      usdCny: z.number().positive().exactOptional(),
      fxDate: z.string().regex(DATE_PATTERN).exactOptional(),
    })
    .nullable(),
  durationMs: count.nullable(),
  timing: z.strictObject({ ttftMs: amount, outputTokensPerSec: amount }).exactOptional(),
  raw: z.string().min(1).exactOptional(),
  calib: z
    .strictObject({
      machineDenials: count.exactOptional(),
      blockedRecalls: count.exactOptional(),
      perRequest: z.array(z.strictObject({ input: count, cost: amount })).exactOptional(),
    })
    .exactOptional(),
}) satisfies z.ZodType<EvalRecord>

/** `<YYYY-MM-DD>-<column>.jsonl`: the date the lines inside carry, and the column's slug. */
export const RESULTS_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})-([a-z0-9][a-z0-9.-]*)\.jsonl$/
