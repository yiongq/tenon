import { ComposerPrimitive, useAui } from '@assistant-ui/react'
import type { JSX, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderChip } from '@/components/composer/FolderChip'
import { ModeSwitch } from '@/components/composer/ModeSwitch'
import { ModelMenu } from '@/components/composer/ModelMenu'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'

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
function isImeEnter(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return (
    event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
  )
}

/**
 * The composer (spec 02 §模型菜单与输入框「输入框」; H13, B1, F11, H6, B15): send and stop side by
 * side while a Run is live — sending then queues; Cmd/Ctrl+Enter stops the Run the user sees and
 * sends this next. Stop is its own button calling `chat.stop`, shown while a Run is in progress, while
 * a card waits and while the session can resume — never assistant-ui's cancel, which a remount fires.
 */
export function Composer(): JSX.Element {
  const { t } = useTranslation()
  const aui = useAui()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const waiting = snapshot.pending !== null
  const stoppable = snapshot.running || waiting || snapshot.resumable
  const block = !snapshot.canSend ? 'restoring' : snapshot.textOnlyTask ? 'textOnlyTask' : null
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isImeEnter(event)) {
      event.preventDefault()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      const text = aui.composer().getState().text.trim()
      // The same two reasons that disable 「发送」 hold here (B15: 按回车也不发送).
      if (text === '' || store.sendBlock() !== null) return
      aui.composer().setText('')
      // While a card or a question waits, Cmd/Ctrl+Enter is a plain send (§插话与输入框状态表).
      void (snapshot.running ? store.sendNow(text) : store.send(text))
    }
  }
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
          onKeyDown={onKeyDown}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 font-sans text-ui text-text-primary outline-none placeholder:text-text-muted"
        />
        <ModelMenu />
        {stoppable ? (
          <button
            type="button"
            data-testid="composer-stop"
            aria-label={t('composer.stop')}
            onClick={() => void store.stop()}
            className="ctl-h shrink-0 rounded-sm border border-border-default px-3 font-sans text-ui font-medium text-text-primary"
          >
            {t('composer.stop')}
          </button>
        ) : null}
        <ComposerPrimitive.Send
          data-testid="composer-send"
          aria-label={t('composer.send')}
          aria-describedby={block === null ? undefined : 'composer-send-block'}
          className="ctl-h shrink-0 rounded-sm bg-fill-accent px-3 font-sans text-ui font-medium text-text-on-accent disabled:opacity-40"
        >
          {t('composer.send')}
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
      <div className="flex items-center justify-between gap-2">
        <ModeSwitch />
        <FolderChip />
      </div>
      {block === null ? null : (
        <p
          id="composer-send-block"
          data-testid="composer-send-block"
          data-reason={block}
          className="mt-2 font-sans text-micro text-text-muted"
        >
          {t(block === 'restoring' ? 'composer.restoring' : 'composer.textOnlyTask')}
        </p>
      )}
      {waiting && snapshot.pending?.waitKind === 'approval' ? (
        <p
          data-testid="composer-pending-hint"
          className="mt-2 font-sans text-micro text-text-muted"
        >
          {t('composer.pendingHint')}
        </p>
      ) : null}
      <p
        data-testid="composer-disclaimer"
        className="mt-2 truncate text-center font-sans text-micro text-text-muted"
      >
        {t('composer.disclaimer')}
      </p>
    </div>
  )
}
