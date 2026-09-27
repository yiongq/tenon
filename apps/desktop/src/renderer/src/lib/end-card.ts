import type { RunEndReasonContract, ToolOutcomeViewContract } from '@tenon-app/contracts'

type Code = RunEndReasonContract['code']
export type EndVisual = 'neutral' | 'danger' | 'warning'
export type EndAction = 'continue' | 'retry' | 'settings' | 'copy'

/**
 * What a Run's end shows (spec 02 §失败卡与结束原因): an exhaustive switch over every end code — one
 * the switch forgets does not compile — to its visual class and its one action. `completed` has the
 * summary line only; `paused` shows nothing, the card or the question being in view.
 */
export function cardOf(
  reason: RunEndReasonContract,
  retryable: boolean,
): { readonly visual: EndVisual; readonly action: EndAction } | null {
  const code: Code = reason.code
  switch (code) {
    case 'completed':
    case 'paused':
      return null
    case 'step-limit':
    case 'output-truncated':
      return { visual: 'neutral', action: 'continue' }
    case 'user-stopped':
    case 'shutdown-aborted':
    case 'user-rejected':
    case 'usage-limit':
    case 'recovered':
    case 'time-limit':
      return { visual: 'neutral', action: 'copy' }
    case 'blocked-repeatedly':
      return { visual: 'warning', action: 'copy' }
    case 'provider-error':
      if (reason.code === 'provider-error' && reason.errorCode === 'auth') {
        return { visual: 'danger', action: 'settings' }
      }
      return { visual: 'danger', action: retryable ? 'retry' : 'copy' }
    case 'refusal':
    case 'content-filter':
    case 'context-overflow':
    case 'no-progress':
    case 'quota-exhausted':
    case 'account-config':
      return { visual: 'danger', action: 'copy' }
    default: {
      const unhandled: never = code
      return unhandled
    }
  }
}

/** Where one call of the round goes in ② of the card (§失败卡与结束原因). */
export type EffectLine = 'done' | 'stopped' | 'stopped-sent' | 'not-run' | 'uncertain'

/**
 * One call's line in ② (§失败卡与结束原因, §点停止时各状态怎么收): a call stopped part-way says its
 * later writes did not happen — for a command, `aborted` is written only once its `exited` came within
 * the confirmation window, after the SIGKILL of its whole group, so the line never shows while the
 * tree still runs — and a request already in flight (WebSearch, WebFetch, a connector's tool: effect
 * `external`) may have reached the other side, so it never says that. Bash's effect is `external` too
 * (§内置工具与参数), but it is a command, not a request.
 */
export function effectLineOf(
  name: string,
  outcome: Pick<ToolOutcomeViewContract, 'state' | 'effect'>,
): EffectLine {
  switch (outcome.state) {
    case 'completed':
      return 'done'
    case 'aborted':
      return outcome.effect === 'external' && name !== 'Bash' ? 'stopped-sent' : 'stopped'
    case 'not-run':
      return 'not-run'
    default:
      return 'uncertain'
  }
}
