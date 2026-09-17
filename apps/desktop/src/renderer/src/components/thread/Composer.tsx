import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react'
import type { JSX, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * spec.md「国际化」: "Composer 收到 Enter 时若 `KeyboardEvent.isComposing === true` 或
 * `keyCode === 229`，视为输入法选字，不发送."
 *
 * MEASURED against @assistant-ui/react 0.15.20: `ComposerPrimitive.Input`'s own
 * `handleKeyPress` bails on `e.nativeEvent.isComposing` and on NOTHING else — there is no
 * keyCode check, and the `compositionRef` it keeps is used only for cursor bookkeeping in
 * `onChange`/`onSelect`, never consulted before submitting. This guard supplies the missing
 * half. It wins because assistant-ui composes the user handler first via Radix
 * `composeEventHandlers(onKeyDown, handleKeyPress)`, whose default
 * `checkForDefaultPrevented: true` skips the built-in handler once we call preventDefault().
 *
 * RESIDUAL HOLE (measured, and inherent to the spec as written): an Enter that follows a
 * compositionstart but carries neither signal still sends. Closing it would mean tracking
 * compositionstart/compositionend here.
 */
function guardImeEnter(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key !== 'Enter') return
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) event.preventDefault()
}

export function Composer(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div>
      <ComposerPrimitive.Root
        data-testid="composer"
        className="flex w-full items-end gap-2 rounded-lg border border-border-default bg-surface-0 p-2"
      >
        <ComposerPrimitive.Input
          data-testid="composer-input"
          rows={1}
          placeholder={t('composer.placeholder')}
          onKeyDown={guardImeEnter}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 font-sans text-ui text-text-primary outline-none placeholder:text-text-muted"
        />
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send
            data-testid="composer-send"
            aria-label={t('composer.send')}
            className="ctl-h shrink-0 rounded-sm bg-fill-accent px-3 font-sans text-ui font-medium text-text-on-accent disabled:opacity-40"
          >
            {t('composer.send')}
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel
            data-testid="composer-cancel"
            aria-label={t('composer.stop')}
            className="ctl-h shrink-0 rounded-sm border border-border-default px-3 font-sans text-ui font-medium text-text-primary"
          >
            {t('composer.stop')}
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </ComposerPrimitive.Root>
      <p
        data-testid="composer-disclaimer"
        className="mt-2 truncate text-center font-sans text-micro text-text-muted"
      >
        {t('composer.disclaimer')}
      </p>
    </div>
  )
}
