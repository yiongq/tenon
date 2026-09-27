/**
 * Waiting on the user (spec 02 §等待模型：审批、提问与拒绝).
 *
 * Plan step 9 declares `AnswerCommand`, because `SessionService.answer` takes it. It has the shape of
 * `approval.respond`'s request, stated by the kernel and restated by contracts. What an answer
 * writes arrives in plan step 15 (approvals) and step 26 (questions).
 */
export type AnswerCommand =
  | {
      readonly kind: 'approval'
      readonly sessionId: string // 调用所在的会话；子会话转上来的审批填子会话的 id
      readonly requestId: string // 待批行当前指向的那条判决的 provenanceKey
      readonly decision: 'allow' | 'deny'
    }
  | {
      readonly kind: 'question'
      readonly sessionId: string
      readonly requestId: string
      readonly answers: Readonly<Record<string, readonly string[] | null>> // 键为题目原文；null = 跳过
    }
