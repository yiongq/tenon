import { ActionBarPrimitive, useAuiState } from '@assistant-ui/react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { ChatErrorCode } from '../../runtime/tenon-chat-adapter'

const ERROR_KEY = {
  network: 'error.network',
  auth: 'error.auth',
  'rate-limit': 'error.rate-limit',
  provider: 'error.provider',
  unknown: 'error.unknown',
} as const satisfies Record<ChatErrorCode, string>

function isChatErrorCode(value: unknown): value is ChatErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_KEY, value)
}

/**
 * Deliberately NOT `ErrorPrimitive.Message`: that renders the flattened `error.message`
 * (see @assistant-ui/core's `messageErrorText`, which returns `error.message`), which would
 * put a kernel string on screen and destroy the code. `useMessageError` is not even
 * re-exported by @assistant-ui/react. `useAuiState` reaches the message's own status, where
 * the structured `{ code }` survives intact.
 */
export function ThreadError(): JSX.Element | null {
  const { t } = useTranslation()
  const status = useAuiState((s) => s.message.status)
  if (status?.type !== 'incomplete' || status.reason !== 'error') return null

  const raw: unknown = status.error
  const code: ChatErrorCode =
    typeof raw === 'object' && raw !== null && 'code' in raw && isChatErrorCode(raw.code)
      ? raw.code
      : 'unknown'

  return (
    <div
      role="alert"
      data-testid="message-error"
      data-error-code={code}
      className="mt-2 flex w-full items-center justify-between gap-3 rounded-sm border border-text-danger px-3 py-2 font-sans text-ui-sm text-text-danger"
    >
      <span data-testid="message-error-text">{t(ERROR_KEY[code])}</span>
      <ActionBarPrimitive.Reload asChild>
        <Button variant="secondary" size="sm" data-testid="message-retry">
          {t('error.retry')}
        </Button>
      </ActionBarPrimitive.Reload>
    </div>
  )
}
