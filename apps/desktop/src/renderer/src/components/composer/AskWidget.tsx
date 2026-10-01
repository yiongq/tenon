import { useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { EMPTY_DRAFT, answerOf, answersOf, withOther, withPick } from '@/lib/ask'
import type { AskDraft, AskQuestion } from '@/lib/ask'
import { visible } from '@/lib/visible'

const SKIPPED: AskDraft = { ...EMPTY_DRAFT, skipped: true }

/**
 * The minimal question widget (spec 02 §阶段 2 做的组件 `AskWidget`; H6): in the slot above the
 * composer, one question a page (1/N), its options — several may be picked with `multiSelect` — the
 * words in 「其他」 and 「跳过」; a reply typed in the composer instead answers the whole call. No
 * minimising in phase 2. Every word the model wrote is escaped as the card escapes its object (②′).
 *
 * It takes no focus when it appears — the composer keeps it, where a reply can be typed at once. Its
 * controls are buttons and one text field with their own keys: ⏎ or Space on an option picks it,
 * ↑ ↓ move between the options, ⏎ in 「其他」 goes on as 「下一题」/「提交」 does. Esc is not the
 * widget's: as anywhere outside a card, it stops (§模型菜单与输入框「停止与发送」).
 */
export function AskWidget(props: {
  readonly questions: readonly AskQuestion[]
  /** Settles once the answer went in or did not: a stale or refused one leaves the widget usable. */
  readonly onAnswer: (answers: Record<string, readonly string[] | null>) => Promise<void>
}): JSX.Element | null {
  const { t } = useTranslation()
  const { questions } = props
  const [page, setPage] = useState(0)
  const [drafts, setDrafts] = useState<readonly AskDraft[]>(() => questions.map(() => EMPTY_DRAFT))
  const [sent, setSent] = useState(false)
  const options = useRef<Array<HTMLButtonElement | null>>([])
  const question = questions[page]
  if (question === undefined) return null
  const draft = drafts[page] ?? EMPTY_DRAFT
  const last = page === questions.length - 1
  const change = (next: AskDraft): void =>
    setDrafts((was) => was.map((one, index) => (index === page ? next : one)))
  const submit = (final: readonly AskDraft[]): void => {
    if (sent) return
    setSent(true)
    // An answer that went in takes the widget away; any other leaves it to be answered again.
    void props.onAnswer(answersOf(questions, final)).then(
      () => setSent(false),
      () => setSent(false),
    )
  }
  /** 「下一题」, or 「提交」 on the last page; a skip first marks this question skipped. */
  const goOn = (skip: boolean): void => {
    const final = drafts.map((one, index) => (index === page && skip ? SKIPPED : one))
    setDrafts(final)
    if (last) submit(final)
    else {
      options.current = []
      setPage(page + 1)
    }
  }
  const answered = answerOf(question, draft) !== null
  const onOptionKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const count = question.options.length
    options.current[(index + step + count) % count]?.focus()
  }
  return (
    <section
      data-testid="ask-widget"
      aria-label={t('ask.label')}
      className="mb-2 flex max-h-[50vh] min-w-0 flex-col gap-2 overflow-y-auto rounded-lg border border-border-default bg-surface-1 p-3 font-sans"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          {question.header === '' ? null : (
            <span
              data-testid="ask-header"
              className="break-words text-micro font-medium text-text-muted"
            >
              {visible(question.header)}
            </span>
          )}
          <p data-testid="ask-question" className="break-words text-ui text-text-primary">
            {visible(question.question)}
          </p>
        </div>
        {questions.length > 1 ? (
          <span
            data-testid="ask-pager"
            className="shrink-0 text-micro tabular-nums text-text-muted"
          >
            {t('ask.pager', { index: page + 1, count: questions.length })}
          </span>
        ) : null}
      </div>
      {question.multiSelect ? (
        <p data-testid="ask-multi" className="text-micro text-text-muted">
          {t('ask.multiSelect')}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {question.options.map((option, index) => {
          const picked = draft.picked.includes(option.label)
          return (
            <li
              // oxlint-disable-next-line react/no-array-index-key -- fixed model options may repeat labels
              key={index}
            >
              <button
                type="button"
                ref={(element) => {
                  options.current[index] = element
                }}
                data-testid="ask-option"
                disabled={sent}
                data-label={option.label}
                aria-pressed={picked}
                onClick={() => change(withPick(question, draft, option.label))}
                onKeyDown={(event) => onOptionKey(event, index)}
                className={
                  picked
                    ? 'flex w-full flex-col items-start gap-0.5 rounded-sm border border-border-strong bg-fill-neutral px-2 py-1 text-left'
                    : 'flex w-full flex-col items-start gap-0.5 rounded-sm border border-border-subtle px-2 py-1 text-left'
                }
              >
                <span className="break-words text-ui-sm font-medium text-text-primary">
                  {visible(option.label)}
                </span>
                {option.description === '' ? null : (
                  <span className="break-words text-micro text-text-secondary">
                    {visible(option.description)}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      <input
        data-testid="ask-other"
        disabled={sent}
        value={draft.other}
        aria-label={t('ask.otherLabel')}
        placeholder={t('ask.other')}
        onChange={(event) => change(withOther(question, draft, event.target.value))}
        onKeyDown={(event) => {
          // An input method's Enter picks a candidate (spec.md「国际化」), as in the composer.
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          if (event.nativeEvent.keyCode === 229) return
          event.preventDefault()
          if (answered) goOn(false)
        }}
        className="rounded-sm border border-border-subtle bg-surface-0 px-2 py-1 text-ui-sm text-text-primary outline-none placeholder:text-text-muted"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-micro text-text-muted" data-testid="ask-reply-hint">
          {t('ask.replyHint')}
        </span>
        {page === 0 ? null : (
          <Button
            variant="ghost"
            size="sm"
            data-testid="ask-previous"
            disabled={sent}
            onClick={() => setPage(page - 1)}
          >
            {t('ask.previous')}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          data-testid="ask-skip"
          disabled={sent}
          onClick={() => goOn(true)}
        >
          {t('ask.skip')}
        </Button>
        <Button
          size="sm"
          data-testid={last ? 'ask-submit' : 'ask-next'}
          disabled={sent || !answered}
          onClick={() => goOn(false)}
        >
          {t(last ? 'ask.submit' : 'ask.next')}
        </Button>
      </div>
    </section>
  )
}
