import type { ReasoningMessagePartProps } from '@assistant-ui/react'
import { useAuiState } from '@assistant-ui/react'
import { useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { firstSentence } from '@/lib/first-sentence'
import type { TurnCustom } from '@/runtime/to-thread-messages'

// The collapsed line's rule lives in lib/first-sentence.ts, where a node test can reach it.
export { firstSentence }

/**
 * A thinking block (spec 02 §思考的默认与显示; A11): collapsed, its first sentence; expanded, the text
 * the vendor returned (a summary on the Anthropic wire, `reasoning_content` on Zhipu's). A block that
 * streamed here shows how long it took, from its first delta to its last; a replayed one has no
 * timing on the Tape, so it shows none.
 */
export function ThinkingBlock(props: ReasoningMessagePartProps): JSX.Element | null {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const custom = useAuiState((s) => s.message.metadata.custom) as unknown as TurnCustom | undefined
  // The content array itself, not a derived one: a selector that builds a new array each call
  // would never settle.
  const content = useAuiState((s) => s.message.content)
  if (props.text.trim() === '') return null
  const reasoning = content.flatMap((part) =>
    part.type === 'reasoning' && part.text.trim() !== '' ? [part.text] : [],
  )
  const index = reasoning.indexOf(props.text)
  const timing = index < 0 ? undefined : custom?.thinking?.[index]
  const seconds =
    timing?.startedAt == null || timing.endedAt == null
      ? null
      : Math.max(1, Math.round((timing.endedAt - timing.startedAt) / 1000))
  return (
    <div data-testid="thinking-block" className="my-2 font-sans text-ui-sm text-text-muted">
      <button
        type="button"
        aria-expanded={open}
        data-testid="thinking-toggle"
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-baseline gap-2 text-left"
      >
        <span className="shrink-0 font-medium">
          {seconds === null ? t('thinking.label') : t('thinking.took', { seconds })}
        </span>
        {open ? null : (
          <span data-testid="thinking-first" className="min-w-0 truncate">
            {firstSentence(props.text, i18n.language)}
          </span>
        )}
      </button>
      {open ? (
        <p data-testid="thinking-text" className="mt-1 whitespace-pre-wrap">
          {props.text}
        </p>
      ) : null}
    </div>
  )
}
