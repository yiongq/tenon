import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import type { AskSummary } from '@/lib/ask'
import { visible } from '@/lib/visible'

/**
 * What stays of an answered question (spec 02 §阶段 2 做的组件 `AskSummaryCard`; open question 18):
 * under its row, each question with its answer — every picked label and the words in 「其他」 as an
 * item of its own, so a label that holds 「, 」 is never split — 「无偏好」 for one skipped, 「未作答」
 * for each after a stop, and a reply typed in the composer as it was typed. The model's words (the
 * questions, the labels) are escaped as the card escapes its object (②′). The same from the live
 * outcome and from the stored one after a restart. An answer past the spill threshold is stored
 * only to its start (H9): the card shows that start, and a line saying where the full text is.
 */
export function AskSummaryCard(props: { readonly summary: AskSummary }): JSX.Element {
  const { t } = useTranslation()
  const { rows, response, preview } = props.summary
  return (
    <div
      data-testid="ask-summary"
      className="mt-1 flex flex-col gap-2 rounded-sm bg-surface-1 px-2 py-1 font-sans text-micro text-text-secondary"
    >
      <ul className="flex flex-col gap-1">
        {rows.map(({ question, answer }, index) => (
          <li
            // oxlint-disable-next-line react/no-array-index-key -- the call's questions, fixed
            key={index}
            data-testid="ask-summary-row"
            data-answer={answer.kind}
            className="flex flex-col gap-0.5"
          >
            <span className="break-words text-text-muted" data-testid="ask-summary-question">
              {visible(question.question)}
            </span>
            {answer.kind === 'answered' ? (
              <ul className="flex flex-wrap gap-1">
                {answer.items.map((item, at) => (
                  <li
                    // oxlint-disable-next-line react/no-array-index-key -- an answer is fixed once given
                    key={at}
                    data-testid="ask-summary-item"
                    className="break-words rounded-sm border border-border-subtle px-1.5 text-text-primary"
                  >
                    {visible(item)}
                  </li>
                ))}
              </ul>
            ) : answer.kind === 'typed' ? null : (
              <span data-testid="ask-summary-mark" className="text-text-muted">
                {t(answer.kind === 'unanswered' ? 'ask.unanswered' : 'ask.noPreference')}
              </span>
            )}
          </li>
        ))}
      </ul>
      {response === null ? null : (
        <div className="flex flex-col gap-0.5">
          <span className="text-text-muted">{t('ask.reply')}</span>
          {/* The user's own words, shown as a message of theirs is (PlainText). */}
          <p
            data-testid="ask-summary-response"
            className="whitespace-pre-wrap break-words text-text-primary"
          >
            {response}
          </p>
        </div>
      )}
      {/* A long answer the Tape kept only to its start: where the full text is (H9). */}
      {preview === null ? null : (
        <p data-testid="ask-summary-preview" className="text-text-muted">
          {t(preview === 'spilled' ? 'preview.spilled' : 'preview.unsaved')}
        </p>
      )}
    </div>
  )
}
