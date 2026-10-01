/**
 * AskUserQuestion (spec 02 §提问工具 AskUserQuestion). The limits follow the Agent SDK
 * (sdk-tools:1102-1110, :3759-3766); a header counts Unicode code points, which is Tenon's reading of
 * the SDK's "max 12 chars" — JSON Schema's `maxLength` counts code points too. The schema holds every
 * limit (1–4 questions, 2–4 options, a header of 12 code points), and the check the SDK's uniqueness,
 * so a call past one closes as `invalid-input` before any decision (§参数校验与失败).
 *
 * It has no executor (plan step 26): an allowed call pauses its Run for the answer (H6), and the
 * answer is written as its result. What the model reads is the fixed template of `MODEL_NOTES.ask`,
 * one `ANSWER_LINE` per question, filled once and stored (A13); what the summary card reads is the
 * `AskAnswerRecord` written with it (open question 18).
 */
import { factText } from '../../loop/spill.js'
import type { SpillMark } from '../../loop/spill.js'
import { MODEL_NOTES, fill } from '../../prompts/index.js'
import type { AskAnswerRecord } from '../../tape/entry.js'
import type { BuiltinTool } from './tool.js'
import { BOTH_PROFILES } from './tool.js'

/** The input the schema below describes. */
export interface AskUserQuestionInput {
  questions: Array<{
    question: string
    header: string // ≤ 12 个 Unicode 码点
    options: Array<{ label: string; description: string }> // 2–4 个；「其他」由界面自带，不算选项
    multiSelect: boolean
  }>
}

/** What the model gets back: a subset of the SDK's AskUserQuestionOutput (sdk-tools:3749). */
export interface AskUserQuestionResult {
  answers: Record<string, string> // 键为题目原文；多选用 ", " 连接；「其他」里打的字也放在这里
  response?: string // 用户不选、直接在输入框打字时的原文；这时 answers 为 {}
}

const DESCRIPTION = [
  'Asks the user one to four multiple-choice questions and waits for the answers.',
  'Use it when the request is unclear or when a choice is the user’s to make, not to ask for permission to use a tool.',
  'Each question has a short header (at most 12 characters) and two to four options; the user can always answer in their own words instead.',
  'Set multiSelect when more than one option may apply.',
].join(' ')

/**
 * One answered question in `MODEL_NOTES.ask.result`'s `{answers}`: the question and its answer, each
 * as a JSON string, so a line break typed into 「其他」 cannot make a line of its own.
 */
export const ANSWER_LINE = '{question} = {answer}'

/** The Agent SDK's own reason, word for word: an answer is keyed by its question and its labels. */
export const ASK_NOT_UNIQUE =
  'Question texts must be unique, option labels must be unique within each question.'

/**
 * The check beyond the schema (§提问工具; Revisions 31): two questions with one text would share one
 * answer, and two options with one label one pick, so either is `invalid-input`, as the Agent SDK
 * refuses it. Only called on arguments the schema accepted.
 */
function uniqueChecks(args: Readonly<Record<string, unknown>>): string | null {
  const questions = args['questions'] as AskUserQuestionInput['questions']
  const texts = questions.map((question) => question.question)
  if (new Set(texts).size < texts.length) return ASK_NOT_UNIQUE
  for (const question of questions) {
    const labels = question.options.map((option) => option.label)
    if (new Set(labels).size < labels.length) return ASK_NOT_UNIQUE
  }
  return null
}

export const ASK_USER_QUESTION_TOOL: BuiltinTool = {
  name: 'AskUserQuestion',
  spec: () => ({
    name: 'AskUserQuestion',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', minLength: 1, description: 'The question, in full.' },
              header: {
                type: 'string',
                minLength: 1,
                maxLength: 12,
                description: 'A short label for the question, at most 12 characters.',
              },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      minLength: 1,
                      description: 'The option, in a few words.',
                    },
                    description: { type: 'string', description: 'What choosing it means.' },
                  },
                  required: ['label', 'description'],
                  additionalProperties: false,
                },
              },
              multiSelect: {
                type: 'boolean',
                description: 'Whether the user may choose more than one option.',
              },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  }),
  // 暂定 (§内置工具与参数, owner 2026-09-25).
  effect: 'read',
  profiles: BOTH_PROFILES,
  check: uniqueChecks,
  texts: { answerLine: ANSWER_LINE, notUnique: ASK_NOT_UNIQUE },
}

/** `approval.respond`'s answers (§答复与投递): by question text; null is a skipped question. */
export type QuestionAnswers = Readonly<Record<string, readonly string[] | null>>

/** An answer as it is written: the model's text, the summary card's record, the closure source. */
export interface AskReply {
  readonly text: string
  readonly record: AskAnswerRecord
  /** `no-preference` when a question was skipped, `typed-answer` for a typed reply, else null. */
  readonly source: 'no-preference' | 'typed-answer' | null
}

/** The texts of the questions a call asked, in its order, each once: the keys an answer may use. */
export function questionTextsOf(input: Readonly<Record<string, unknown>>): string[] {
  const questions = Array.isArray(input['questions']) ? (input['questions'] as unknown[]) : []
  const texts: string[] = []
  for (const question of questions) {
    const text = (question as { question?: unknown } | null)?.question
    if (typeof text === 'string' && !texts.includes(text)) texts.push(text)
  }
  return texts
}

/**
 * The answer `approval.respond` gave (§答复与投递「答案换算」): a list is joined with `", "`, and a
 * question skipped — null or left out — gets the no-preference mark, source
 * `no-preference`. The record keeps each list as it came, so a label that has a `", "` of its own
 * still reads as one choice, and fills every question left out with null. `invalid` when a key is
 * not the text of a question the call asked.
 */
export function answeredReply(
  questions: readonly string[],
  answers: QuestionAnswers,
): AskReply | 'invalid' {
  if (Object.keys(answers).some((key) => !questions.includes(key))) return 'invalid'
  const chosen = questions.map((question): [string, string[] | null] => {
    const given = Object.hasOwn(answers, question) ? answers[question] : undefined
    return [question, given === undefined || given === null ? null : [...given]]
  })
  const result: AskUserQuestionResult = {
    answers: Object.fromEntries(
      chosen.map(([question, labels]) => [
        question,
        labels === null ? MODEL_NOTES.ask.noPreference : labels.join(', '),
      ]),
    ),
  }
  return {
    text: askResultText(questions, result),
    record: { answers: Object.fromEntries(chosen) },
    source: chosen.some(([, labels]) => labels === null) ? 'no-preference' : null,
  }
}

/**
 * A reply typed into the composer while the question waits (§提问工具「直接打字」): its text is the
 * answer, `answers` is {} and `response` the text as typed.
 */
export function typedReply(text: string): AskReply {
  return {
    text: askResultText([], { answers: {}, response: text }),
    record: { answers: {}, response: text },
    source: 'typed-answer',
  }
}

/**
 * The record as its `tool/result` stores it (H9 has no exception: Revisions 31). While the result
 * stays under the spill threshold, as given; past it, the full answer is the spill file's alone, so
 * each answer — a label, the words in 「其他」, a typed reply — keeps its first `SPILL_PREVIEW_CHARS`
 * characters, and `preview` says where the rest is. The question texts, its keys, stay whole: they
 * are the call's own input.
 */
export function storedRecord(
  record: AskAnswerRecord,
  mark: SpillMark | undefined,
): AskAnswerRecord {
  if (mark === undefined) return record
  let cut = false
  const keep = (text: string): string => {
    const kept = factText(text, mark)
    cut ||= kept.cut
    return kept.text
  }
  const stored: AskAnswerRecord = {
    answers: Object.fromEntries(
      Object.entries(record.answers).map(([question, labels]) => [
        question,
        labels === null ? null : labels.map(keep),
      ]),
    ),
    ...(record.response === undefined ? {} : { response: keep(record.response) }),
  }
  return cut ? { ...stored, preview: mark } : record
}

/** `AskUserQuestionResult` through the fixed template (§提问工具「回给模型」): what the model reads. */
export function askResultText(questions: readonly string[], result: AskUserQuestionResult): string {
  if (result.response !== undefined) return fill(MODEL_NOTES.ask.typed, { answer: result.response })
  const lines = questions
    .filter((question) => Object.hasOwn(result.answers, question))
    .map((question) =>
      fill(ANSWER_LINE, {
        question: JSON.stringify(question),
        answer: JSON.stringify(result.answers[question]),
      }),
    )
  return fill(MODEL_NOTES.ask.result, { answers: lines.join('\n') })
}
