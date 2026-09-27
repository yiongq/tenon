import type { RunEndReasonContract } from '@tenon-app/contracts'

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
