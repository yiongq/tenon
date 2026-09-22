import { ThreadPrimitive } from '@assistant-ui/react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Composer } from './Composer'
import { AssistantMessage, UserMessage } from './Message'

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
      {/* `relative`: each message's `sr-only` label is position:absolute and a STATIC scroller is
          not its containing block, so it escaped this overflow, stretched the document and let a
          wheel scroll the whole shell — the same trap any future absolute content would hit. */}
      <ThreadPrimitive.Viewport
        data-testid="thread-viewport"
        className="relative flex-1 overflow-y-auto overflow-x-hidden px-6 pt-8"
      >
        <div className="mx-auto w-full max-w-[720px]">
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
          <Composer />
        </div>
      </div>
    </ThreadPrimitive.Root>
  )
}
