/**
 * Why a whole Run ended (spec 02 §结束原因词表). A closed vocabulary: a new value is an amend, and
 * `execution/run_terminal.reason` is exactly this type — the slots live on the members, the payload
 * carries no separate `slots`.
 *
 * Declared in plan step 8 because `RunTerminalPayload` (§载荷) references it; the loop that produces
 * these values arrives in later steps and does not change the shape.
 */
import type { ProviderErrorCode, ProviderId } from '../provider/types.js'

export type RunEndReason =
  | { code: 'completed' } // 正常结束
  | { code: 'user-stopped' } // 你停下（含「立即发送」打断）
  | { code: 'paused'; waitingFor: 'approval' | 'question' | 'subagent' } // 暂停等你（F3）
  | { code: 'user-rejected'; toolName: string } // 你拒绝了（F2）
  | { code: 'blocked-repeatedly'; count: number } // 连续被拦截（F2）
  | { code: 'step-limit'; limit: number } // 达到步数上限 · 可继续（H11）
  | { code: 'no-progress'; repeats: number } // 原地打转
  | { code: 'usage-limit'; tokenLimit: number } // 超出用量上限（H11）
  | { code: 'refusal'; providerId: ProviderId; modelId: string } // 模型拒答；拒答分类 02 不解码
  | { code: 'content-filter'; providerId: ProviderId } // 内容安全拦截
  | { code: 'context-overflow'; compactions: number } // 上下文溢出（压缩两次后仍溢出）
  | { code: 'quota-exhausted'; providerId: ProviderId; resetAt: number | null } // 额度或花费上限已用尽；取 error.resetAt
  | { code: 'account-config'; providerId: ProviderId } // 账号或组织配置不满足
  | {
      code: 'provider-error' // 模型服务出错（已重试）
      providerId: ProviderId
      errorCode: ProviderErrorCode | null // 由 stop 引起的（pause-turn、其余 unknown、network_error 用尽）为 null
      providerReason: string | null // 那次 stop 或 error 上的厂商原值（stop.providerReason / error.providerCode）
      attempts: number // 本 requestSeq 实际发出的物理请求数
    }
  | { code: 'output-truncated'; maxTokens: number } // 输出被截断 · 可继续（A2）
  | { code: 'shutdown-aborted'; trigger: 'quit' | 'close-window' } // 退出或关窗时中止（B4；取自 RunAbortCause）
  | { code: 'recovered' } // 崩溃后由启动恢复补写的终态（B1、B4）
  | { code: 'time-limit'; limitMs: number } // 子 agent 到期（F7）；只出现在子会话（开放问题 18）
