import type { ToolOutcomeViewContract } from '@tenon-app/contracts'

/**
 * AskUserQuestion as the interface reads it (spec 02 §提问工具 AskUserQuestion, §阶段 2 做的组件
 * `AskWidget`、`AskSummaryCard`; H6): the questions from the call's own input, what the widget's
 * choices make of them as `approval.respond`'s answers, and what the summary card shows once the
 * call has its result. Pure, so a node test reaches it.
 */

export interface AskOption {
  readonly label: string
  readonly description: string
}

export interface AskQuestion {
  readonly question: string
  readonly header: string
  readonly options: readonly AskOption[]
  readonly multiSelect: boolean
}

/** `AskAnswerRecord` (§提问工具): keyed by the question's own text; null = skipped. */
export interface AskAnswers {
  readonly answers: Readonly<Record<string, readonly string[] | null>>
  readonly response?: string
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionOf(value: unknown): AskOption | null {
  if (!isRecord(value) || typeof value['label'] !== 'string') return null
  const description = value['description']
  return { label: value['label'], description: typeof description === 'string' ? description : '' }
}

/**
 * The questions of an AskUserQuestion call, from the input its stored `tool-request` block holds.
 * The kernel validated that input before the call could wait (§原因码表 `invalid-input`); a question
 * not in the schema's shape is still left out rather than drawn from a guess.
 */
export function questionsOf(input: Readonly<Record<string, unknown>>): readonly AskQuestion[] {
  const questions = input['questions']
  if (!Array.isArray(questions)) return []
  return questions.flatMap((value): AskQuestion[] => {
    if (!isRecord(value) || typeof value['question'] !== 'string') return []
    const options = Array.isArray(value['options']) ? value['options'] : []
    return [
      {
        question: value['question'],
        header: typeof value['header'] === 'string' ? value['header'] : '',
        options: options.flatMap((option) => {
          const parsed = optionOf(option)
          return parsed === null ? [] : [parsed]
        }),
        multiSelect: value['multiSelect'] === true,
      },
    ]
  })
}

/** One question's state in the widget: the options picked, the words in 「其他」, and a skip. */
export interface AskDraft {
  readonly picked: readonly string[]
  readonly other: string
  readonly skipped: boolean
}

export const EMPTY_DRAFT: AskDraft = { picked: [], other: '', skipped: false }

/**
 * A click on an option: with `multiSelect` it toggles; otherwise it is the one answer, and the
 * words in 「其他」 give way to it. Either way the question is no longer skipped.
 */
export function withPick(question: AskQuestion, draft: AskDraft, label: string): AskDraft {
  if (!question.multiSelect) {
    const picked = draft.picked.includes(label) ? [] : [label]
    return { picked, other: picked.length === 0 ? draft.other : '', skipped: false }
  }
  const picked = draft.picked.includes(label)
    ? draft.picked.filter((candidate) => candidate !== label)
    : [...draft.picked, label]
  return { ...draft, picked, skipped: false }
}

/** Words typed in 「其他」: on a single choice they take the place of a picked option. */
export function withOther(question: AskQuestion, draft: AskDraft, other: string): AskDraft {
  const typed = other.trim() !== ''
  return {
    picked: typed && !question.multiSelect ? [] : draft.picked,
    other,
    skipped: false,
  }
}

/**
 * What one question answers (§提问工具「其他」里打的字也放在这里): the picked labels in the order the
 * options list them, then the words in 「其他」; null when nothing was chosen or it was skipped.
 */
export function answerOf(question: AskQuestion, draft: AskDraft): readonly string[] | null {
  if (draft.skipped) return null
  const other = draft.other
  const picked = question.options
    .map((option) => option.label)
    .filter((label) => draft.picked.includes(label))
  const answer = [...picked, ...(other.trim() === '' ? [] : [other])]
  return answer.length === 0 ? null : answer
}

/**
 * `approval.respond`'s answers: every question by its own text, answered or null. The kernel joins
 * an array with ", " for the model and turns null into its no-preference mark (§答复与投递).
 */
export function answersOf(
  questions: readonly AskQuestion[],
  drafts: readonly AskDraft[],
): Record<string, readonly string[] | null> {
  return Object.fromEntries(
    questions.map((question, index) => [
      question.question,
      answerOf(question, drafts[index] ?? EMPTY_DRAFT),
    ]),
  )
}

/** One question's line on the summary card. */
export type SummaryAnswer =
  /** The picked labels and the words in 「其他」, each its own item — a label may hold 「, 」 itself. */
  | { readonly kind: 'answered'; readonly items: readonly string[] }
  /** Skipped, or left without an answer when the others were given (§答复与投递「缺的键按跳过」). */
  | { readonly kind: 'no-preference' }
  /** A stop came while it waited (`unanswered`). */
  | { readonly kind: 'unanswered' }
  /** A reply typed in the composer answers the whole call, not this question: shown once, below. */
  | { readonly kind: 'typed' }

export interface AskSummary {
  readonly rows: ReadonlyArray<{ readonly question: AskQuestion; readonly answer: SummaryAnswer }>
  /** The reply typed in the composer, as typed (`response`); null when the widget answered. */
  readonly response: string | null
}

/**
 * The summary card of a call that has its result (open question 18, owner 2026-09-26): an answer
 * reads `question` — live from `tool-outcome`, redrawn from `calls[i].outcome` — and a stop's
 * `unanswered` shows 「未作答」 on every question. `answered` is this window's own record of an answer
 * it gave, for the moment before the call's outcome arrives. Null when there is nothing to sum up:
 * no answer yet, or a result that is neither an answer nor a stop (the row's closure line says why).
 */
export function summaryOf(
  questions: readonly AskQuestion[],
  outcome: Pick<ToolOutcomeViewContract, 'source' | 'question'> | null,
  answered: AskAnswers | null,
): AskSummary | null {
  if (outcome?.source === 'unanswered') {
    return {
      rows: questions.map((question) => ({ question, answer: { kind: 'unanswered' } })),
      response: null,
    }
  }
  // A result of one of the three answers (§原因码表: source null, `no-preference`, `typed-answer`)
  // that came without its record falls back on this window's own; any other result has none.
  const answerSource =
    outcome === null ||
    outcome.source === null ||
    outcome.source === 'no-preference' ||
    outcome.source === 'typed-answer'
  const record = outcome?.question ?? (answerSource ? answered : null)
  if (record === null) return null
  if (record.response !== undefined) {
    return {
      rows: questions.map((question) => ({ question, answer: { kind: 'typed' } })),
      response: record.response,
    }
  }
  return {
    rows: questions.map((question) => {
      const given = Object.hasOwn(record.answers, question.question)
        ? record.answers[question.question]
        : null
      return {
        question,
        answer:
          given === null || given === undefined
            ? { kind: 'no-preference' }
            : { kind: 'answered', items: given },
      }
    }),
    response: null,
  }
}
