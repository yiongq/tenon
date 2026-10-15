import { useAuiState } from '@assistant-ui/react'
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { endsRound, replyTextAt, showsAssistantBar, textOfMessage } from '@/lib/message-text'
import { relativeTime } from '@/lib/relative-time'
import { useCoarseNow } from '@/runtime/clock'
import type { TurnCustom } from '@/runtime/to-thread-messages'

/**
 * The action bar of a message (components.md `UserActionBar`, `AssistantActionBar`): copy, then
 * how long ago it was sent. It keeps its height whether shown or not (no jump when it appears) and
 * shows on hover or keyboard focus; the newest message keeps it up. The bar's own parent carries
 * the `group/msg` that the hover reads.
 *
 * Retry, edit-and-resend and branches are not here: 02 allows a retry only on the failure card
 * (§失败卡与结束原因), and edit-and-resend and the retry of other Runs wait for stage 6 (§留到后续阶段).
 */
const BAR =
  'flex h-6 items-center gap-1 font-sans transition-opacity duration-[var(--t-dur-snap)] ease-snap focus-within:opacity-100 group-hover/msg:opacity-100'

/** Copies through the page's own clipboard, which main lets only the app's document write. */
function CopyAction(props: { readonly text: string }): JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const label = t('message.copy')
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        data-testid="copy-message"
        aria-label={label}
        title={label}
        className="text-text-muted hover:text-text-primary"
        onClick={() => {
          navigator.clipboard.writeText(props.text).then(
            () => {
              setCopied(true)
              clearTimeout(timer.current)
              timer.current = setTimeout(() => setCopied(false), 2000)
            },
            () => undefined,
          )
        }}
      >
        {copied ? (
          <Check aria-hidden className="size-3.5" />
        ) : (
          <Copy aria-hidden className="size-3.5" />
        )}
      </Button>
      <output data-testid="copy-message-status" className="sr-only">
        {copied ? t('message.copied') : ''}
      </output>
    </>
  )
}

/** 「5 分钟前」, the full date and time on hover; ages while the window stays open. */
function SentAt(): JSX.Element {
  const { t, i18n } = useTranslation()
  const createdAt = useAuiState((s) => s.message.createdAt.getTime())
  const now = useCoarseNow()
  return (
    <time
      data-testid="message-time"
      dateTime={new Date(createdAt).toISOString()}
      title={new Date(createdAt).toLocaleString(i18n.language)}
      className="px-1 text-micro text-text-muted"
    >
      {relativeTime(createdAt, now, i18n.language, t('message.justNow'))}
    </time>
  )
}

/** Under the user's bubble, right-aligned. Hidden until hover or focus. */
export function UserActionBar(): JSX.Element | null {
  const text = useAuiState((s) => textOfMessage(s.message))
  if (text === '') return null
  return (
    <div data-testid="user-actions" className={`${BAR} mt-1 opacity-0`}>
      <CopyAction text={text} />
      <SentAt />
    </div>
  )
}

/**
 * Closes a round, once: only the last assistant message of the round carries it, and it copies the
 * round's whole reply. Not while the message is still being written (it fades in at the end), and
 * not on a turn that paused for a card or a question (the round is not over).
 */
export function AssistantActionBar(): JSX.Element | null {
  const custom = useAuiState((s) => s.message.metadata.custom) as unknown as TurnCustom | undefined
  const running = useAuiState(
    (s) => s.message.role === 'assistant' && s.message.status.type === 'running',
  )
  const newest = useAuiState((s) => s.message.index === s.thread.messages.length - 1)
  // Empty unless this message closes its round: every message of a long thread runs this on every
  // delta, so the text is only joined for the one that needs it.
  const reply = useAuiState((s) =>
    endsRound(s.thread.messages, s.message.index)
      ? replyTextAt(s.thread.messages, s.message.index)
      : '',
  )
  if (!showsAssistantBar({ running, reply, endCode: custom?.end?.endReason?.code })) return null
  return (
    <div
      data-testid="assistant-actions"
      className={`${BAR} ${newest ? 'opacity-100' : 'opacity-0'}`}
    >
      <CopyAction text={reply} />
      <SentAt />
    </div>
  )
}
