import { ComposerPrimitive, useAui } from '@assistant-ui/react'
import { ArrowUpIcon, SquareIcon } from 'lucide-react'
import { useCallback, useId, useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ComposerLead } from '@/components/composer/ComposerLead'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ModelMenuHandle } from '@/components/composer/ModelMenu'
import { MODEL_BLOCK_KEY, switchTarget } from '@/lib/send-block'
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
 * The composer (spec 02 §模型菜单与输入框「输入框」; H13, B1, F11, H6, B15): a two-row frame, the
 * editor on top and a tool row under it. The tool row's left cluster is `ComposerLead` (the mode
 * toggle and folder chip); its right cluster is the model chip and the round 「发送」 at the end, always there. While a
 * Run is live (or a card or a question waits, or the session can resume) a square 「停止」 stands beside
 * them — send and stop side by side (§「停止与发送」): sending then queues; Cmd/Ctrl+Enter stops the Run
 * the user sees and sends this next. Stop takes the free room on the cluster's left, so neither the
 * chip nor 「发送」 moves when it comes or goes, and 「发送」 never unmounts under a keyboard user's
 * focus. Stop is its own button calling `chat.stop` — never assistant-ui's cancel, which a remount
 * fires. While a question waits, 「发送」 is its typed answer (§插话与输入框状态表「等提问」).
 *
 * Under the box, 8px down, one muted line that keeps its place whatever it says: a hint replacing the
 * disclaimer moves nothing. Folders are in the tool row (presentation-r1 R3/R8); toggling on adds
 * the chip without moving the box or this line. Only a long folder name makes the tool row taller.
 */
export function Composer(): JSX.Element {
  const { t } = useTranslation()
  const aui = useAui()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const waiting = snapshot.pending !== null
  const stoppable = snapshot.running || waiting || snapshot.resumable
  const block = store.sendBlock()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const menu = useRef<ModelMenuHandle | null>(null)
  const descriptionId = useId()
  const unavailable = block !== null && block !== 'restoring' && block !== 'textOnlyTask'
  const target = unavailable
    ? switchTarget(snapshot.providers ?? [], snapshot.facts?.profile ?? 'chat')
    : null
  const description =
    target === null
      ? ''
      : target.entry.endpoint.reach === 'loopback'
        ? t('model.row.staysLocal')
        : t('model.row.sendsTo', { host: target.entry.endpoint.host })
  const targetLabel =
    target === null
      ? ''
      : t('composer.switchModel', {
          provider: target.entry.displayName ?? t(target.entry.nameKey as never),
          model: target.row.nameKey === undefined ? target.row.id : t(target.row.nameKey as never),
        })
  const blockKey =
    block === 'restoring'
      ? 'composer.restoring'
      : block === 'textOnlyTask'
        ? snapshot.facts?.established
          ? 'composer.textOnlyTaskEstablished'
          : 'composer.textOnlyTask'
        : block === null
          ? null
          : MODEL_BLOCK_KEY[block]
  // A keyboard user's focus never drops to the page: 「发送」 goes disabled once the draft is sent and
  // 「停止」 goes away once the Run is over, and either would take the focus with it. It moves to the
  // editor, where the next thing typed belongs.
  const input = useRef<HTMLTextAreaElement | null>(null)
  const focusInput = (): void => input.current?.focus()
  const stopEl = useRef<HTMLButtonElement | null>(null)
  const stopRef = useCallback((el: HTMLButtonElement | null) => {
    // Detached while still in the document: if it held the focus, hand it on before it is removed.
    if (el === null && stopEl.current !== null && document.activeElement === stopEl.current) {
      input.current?.focus()
    }
    stopEl.current = el
  }, [])
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isImeEnter(event)) {
      event.preventDefault()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      const raw = aui.composer().getState().text
      const text = snapshot.pending?.waitKind === 'question' ? raw : raw.trim()
      // The same reasons that disable 「发送」 hold here (B15: 按回车也不发送).
      if (text.trim() === '' || store.sendBlock() !== null) return
      aui.composer().setText('')
      // While a card or a question waits, Cmd/Ctrl+Enter is a plain send (§插话与输入框状态表).
      void (snapshot.running ? store.sendNow(text) : store.send(text))
    }
  }
  return (
    <div>
      <ComposerPrimitive.Root
        data-testid="composer"
        className="flex w-full flex-col rounded-xl border border-border-default bg-surface-1 shadow-sm focus-within:border-border-strong"
      >
        <ComposerPrimitive.Input
          ref={input}
          data-testid="composer-input"
          rows={1}
          // While a question waits, sending is the answer (§模型菜单与输入框「提示与禁发」; components.md:80).
          placeholder={t(
            snapshot.pending?.waitKind === 'question'
              ? 'composer.placeholderQuestion'
              : 'composer.placeholder',
          )}
          onKeyDown={onKeyDown}
          className="max-h-40 w-full resize-none bg-transparent px-4 pt-3 pb-1 font-sans text-ui text-text-primary outline-none placeholder:text-text-muted"
        />
        <div
          data-testid="composer-tools"
          className="flex min-h-12 items-center justify-between gap-2 px-2 pt-1 pb-2"
        >
          <div
            data-testid="composer-lead"
            className="flex min-h-8 min-w-0 flex-1 items-center gap-2"
          >
            <ComposerLead />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {stoppable ? (
              <button
                type="button"
                ref={stopRef}
                data-testid="composer-stop"
                aria-label={t('composer.stop')}
                title={t('composer.stop')}
                onClick={() => {
                  focusInput()
                  void store.stop()
                }}
                className="flex size-8 items-center justify-center rounded-md border border-border-default text-text-primary hover:bg-alpha-1"
              >
                <SquareIcon aria-hidden className="size-3 fill-current" />
              </button>
            ) : null}
            <ModelMenu ref={menu} />
            <ComposerPrimitive.Send
              data-testid="composer-send"
              // Runs before the send itself, while the button is still enabled and focused.
              onClick={focusInput}
              aria-label={t('composer.send')}
              aria-describedby={block === null ? undefined : 'composer-send-block'}
              className="flex size-8 items-center justify-center rounded-pill bg-fill-accent text-text-on-accent hover:bg-fill-accent-hover disabled:opacity-40"
            >
              <ArrowUpIcon aria-hidden className="size-4" />
            </ComposerPrimitive.Send>
          </div>
        </div>
      </ComposerPrimitive.Root>
      {/* One muted line under the box, whose content changes but not its place or its alignment: why
          「发送」 is off, else what sending now would do to the waiting card, else the disclaimer. */}
      <div className="mt-2 min-h-4 text-center font-sans text-micro text-text-muted">
        {block !== null ? (
          <p id="composer-send-block" data-testid="composer-send-block" data-reason={block}>
            <span data-testid="composer-block-reason">{t(blockKey!)}</span>
            {target !== null ? (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        data-testid="composer-switch-model"
                        aria-label={targetLabel}
                        aria-describedby={descriptionId}
                        className="ml-1 text-text-secondary underline underline-offset-2"
                        onClick={() => void menu.current?.switchTo(target)}
                      />
                    }
                  >
                    {targetLabel}
                  </TooltipTrigger>
                  <TooltipContent data-testid="composer-switch-tooltip">
                    {description}
                  </TooltipContent>
                </Tooltip>
                <span id={descriptionId} className="sr-only">
                  {description}
                </span>
              </>
            ) : null}
            {unavailable && block !== 'modelRemoved' ? (
              <>
                <button
                  type="button"
                  data-testid="composer-settings"
                  className="ml-1 text-text-secondary underline underline-offset-2"
                  onClick={() => setSettingsOpen(true)}
                >
                  {t('composer.settings')}
                </button>
              </>
            ) : null}
          </p>
        ) : waiting && snapshot.pending?.waitKind === 'approval' ? (
          <p data-testid="composer-pending-hint">{t('composer.pendingHint')}</p>
        ) : (
          <p data-testid="composer-disclaimer" className="truncate">
            {t('composer.disclaimer')}
          </p>
        )}
      </div>
      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
