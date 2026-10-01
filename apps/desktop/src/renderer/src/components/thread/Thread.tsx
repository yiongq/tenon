import { ThreadPrimitive, useThreadViewportStore } from '@assistant-ui/react'
import { useEffect } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { ComposerSlots } from '@/components/composer/ComposerSlots'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'
import { Composer } from './Composer'
import { AssistantMessage, UserMessage } from './Message'
import { PendingApprovalBanner, QueuedBubbles, ResumeRow } from './ThreadExtras'

/**
 * A message the user just sent comes into view, as phase 1's runtime did on each Run's start: this
 * runtime never reports running (sending during a Run queues), so assistant-ui's own follow never
 * fires. Keyed on the newest turn this window sent.
 */
function FollowOnSend(): null {
  const viewport = useThreadViewportStore()
  const { model } = useSessionSnapshot()
  const sent = model.turns.findLast((turn) => turn.optimistic === true)?.id ?? null
  useEffect(() => {
    if (sent !== null) viewport.getState().scrollToBottom({ behavior: 'auto' })
  }, [sent, viewport])
  return null
}

/** Places whose own Esc comes first: a card (Esc = 拒绝), a dialog, a menu. */
const OWN_ESCAPE =
  '[data-testid="approval-card"], [role="dialog"], [role="alertdialog"], [role="menu"]'

/**
 * An open dialog or menu owns Esc wherever focus is: Base UI moves focus into a popup a moment
 * after it opens, and an Esc in that moment closes the popup, never stops the Run. Closed popups
 * are unmounted (nothing here keeps them mounted), so presence means open.
 */
const OPEN_POPUP = '[role="dialog"], [role="alertdialog"], [role="menu"]'

/**
 * Esc stops (spec 02 §模型菜单与输入框「按键」: 焦点在卡内 = 拒绝，其余 = 停止; components.md
 * StopButton「Esc 等效」) whenever the stop button shows — never while an input method is composing.
 */
function StopOnEscape(): null {
  const store = useSessionStore()
  const { running, pending, resumable } = useSessionSnapshot()
  const stoppable = running || pending !== null || resumable
  useEffect(() => {
    if (!stoppable) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (event.target instanceof Element && event.target.closest(OWN_ESCAPE) !== null) return
      if (document.querySelector(OPEN_POPUP) !== null) return
      event.preventDefault()
      void store.stop()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [store, stoppable])
  return null
}

/**
 * No assistant-ui stylesheet is imported anywhere: every visual is a Tailwind utility whose
 * name is the mechanical result of a `--t-*` key, resolved through `@theme inline`.
 */
export function Thread(): JSX.Element {
  const { t } = useTranslation()
  return (
    <ThreadPrimitive.Root
      data-testid="thread"
      className="flex h-full flex-col bg-surface-0 text-text-primary"
    >
      <FollowOnSend />
      <StopOnEscape />
      {/* `relative`: each message's `sr-only` label is position:absolute and a STATIC scroller is
          not its containing block, so it escaped this overflow, stretched the document and let a
          wheel scroll the whole shell — the same trap any future absolute content would hit. */}
      <ThreadPrimitive.Viewport
        data-testid="thread-viewport"
        className="relative flex-1 overflow-y-auto overflow-x-hidden px-6 pt-8"
      >
        <div className="mx-auto w-full max-w-[720px]">
          <PendingApprovalBanner />
          <ThreadPrimitive.Empty>
            <p
              data-testid="thread-empty"
              className="py-16 text-center font-sans text-ui text-text-muted"
            >
              {t('thread.empty')}
            </p>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage, EditComposer: UserMessage }}
          />
          <QueuedBubbles />
          <ResumeRow />
        </div>
      </ThreadPrimitive.Viewport>

      <ThreadPrimitive.ScrollToBottom
        data-testid="scroll-to-bottom"
        aria-label={t('thread.scrollToBottom')}
        className="mx-auto mb-1 rounded-pill border border-border-default bg-surface-0 px-3 py-1 font-sans text-micro text-text-muted disabled:invisible"
      >
        {t('thread.scrollToBottom')}
      </ThreadPrimitive.ScrollToBottom>

      <div className="px-6 pb-6">
        <div className="mx-auto w-full max-w-[720px]">
          <ComposerSlots />
          <Composer />
        </div>
      </div>
    </ThreadPrimitive.Root>
  )
}
