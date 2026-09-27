/**
 * The script check's type, word for word from spec 02 §评测集与测试宿主 (the `EvalCheck` beside
 * `EvalTask` in `apps/desktop/evals/task.ts`). Declared here only until the runner's `task.ts` lands:
 * then this file re-exports that one, and no check changes.
 *
 * `cards` is every approval request the test host received; `workspaceDir` is the host's copy of the
 * task's fixture, as the run left it.
 */
import type { ConfirmRequest, TapeReader } from '@tenon-app/kernel'

export type EvalCheck = (ctx: {
  tape: TapeReader
  sessionId: string
  workspaceDir: string
  cards: readonly ConfirmRequest[]
}) => Promise<{ pass: boolean; note: string }>
