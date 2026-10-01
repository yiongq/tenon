/**
 * What the question widget answers and what the summary card shows (spec 02 §提问工具 AskUserQuestion,
 * §答复与投递, §阶段 2 做的组件 `AskWidget`、`AskSummaryCard`; plan step 26: 旧 175, 旧 176, open question
 * 18). AskWidget.tsx and AskSummaryCard.tsx lay these out; the e2e (ask.spec.ts) drives them in the
 * real shell.
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_DRAFT,
  answerOf,
  answersOf,
  questionsOf,
  summaryOf,
  withOther,
  withPick,
} from '../src/renderer/src/lib/ask.js'
import type { AskQuestion } from '../src/renderer/src/lib/ask.js'

const COLOUR: AskQuestion = {
  question: 'Which colour?',
  header: 'Colour',
  options: [
    { label: 'red, dark', description: 'A label that holds 「, 」' },
    { label: 'blue', description: '' },
  ],
  multiSelect: false,
}

const SIZES: AskQuestion = {
  question: 'Which sizes?',
  header: 'Sizes',
  options: [
    { label: 'x', description: 'extra' },
    { label: 'y', description: 'why' },
    { label: 'z', description: 'zed' },
  ],
  multiSelect: true,
}

describe('the questions of a call (its stored tool-request block)', () => {
  it('reads each question as the schema gives it, and leaves out what does not have its shape', () => {
    expect(
      questionsOf({
        questions: [
          {
            question: 'Which colour?',
            header: 'Colour',
            options: [
              { label: 'red, dark', description: 'A label that holds 「, 」' },
              { label: 'blue', description: '' },
            ],
            multiSelect: false,
          },
          { header: 'no question text', options: [], multiSelect: true },
          'not a question',
        ],
      }),
    ).toEqual([COLOUR])
    expect(questionsOf({})).toEqual([])
    expect(questionsOf({ questions: 'none' })).toEqual([])
  })
})

describe('what the widget answers (approval.respond question)', () => {
  it('a single choice is one label; words in 「其他」 take its place, and a pick takes theirs', () => {
    let draft = withPick(COLOUR, EMPTY_DRAFT, 'blue')
    expect(answerOf(COLOUR, draft)).toEqual(['blue'])
    draft = withPick(COLOUR, draft, 'red, dark')
    expect(answerOf(COLOUR, draft)).toEqual(['red, dark'])
    // 旧 176: 在「其他」里打的字放进 answers[题目原文].
    draft = withOther(COLOUR, draft, '  green  ')
    expect(draft.picked).toEqual([])
    expect(answerOf(COLOUR, draft)).toEqual(['  green  '])
    draft = withPick(COLOUR, draft, 'blue')
    expect(draft.other).toBe('')
    expect(answerOf(COLOUR, draft)).toEqual(['blue'])
    // Picking the chosen option again takes it back: nothing chosen is no answer.
    expect(answerOf(COLOUR, withPick(COLOUR, draft, 'blue'))).toBeNull()
  })

  it('multiSelect toggles, in the options’ order, with the words in 「其他」 last', () => {
    let draft = withPick(SIZES, EMPTY_DRAFT, 'z')
    draft = withPick(SIZES, draft, 'x')
    expect(answerOf(SIZES, draft)).toEqual(['x', 'z'])
    draft = withOther(SIZES, draft, 'w')
    expect(answerOf(SIZES, draft)).toEqual(['x', 'z', 'w'])
    draft = withPick(SIZES, draft, 'z')
    expect(answerOf(SIZES, draft)).toEqual(['x', 'w'])
    // Words only in 「其他」 are an answer; whitespace is not.
    expect(answerOf(SIZES, withOther(SIZES, EMPTY_DRAFT, 'w'))).toEqual(['w'])
    expect(answerOf(SIZES, withOther(SIZES, EMPTY_DRAFT, '   '))).toBeNull()
  })

  it('names every question by its own text: an array, or null when skipped or left unanswered', () => {
    const picked = withPick(SIZES, withPick(SIZES, EMPTY_DRAFT, 'x'), 'y')
    expect(answersOf([COLOUR, SIZES], [{ ...EMPTY_DRAFT, skipped: true }, picked])).toEqual({
      'Which colour?': null,
      'Which sizes?': ['x', 'y'],
    })
    // A question never reached (fewer drafts than questions) is null too, never missing.
    expect(answersOf([COLOUR, SIZES], [withPick(COLOUR, EMPTY_DRAFT, 'blue')])).toEqual({
      'Which colour?': ['blue'],
      'Which sizes?': null,
    })
    // A skip that follows a pick wins; a pick after a skip answers again.
    const skipped = { ...withPick(COLOUR, EMPTY_DRAFT, 'blue'), skipped: true }
    expect(answerOf(COLOUR, skipped)).toBeNull()
    expect(answerOf(COLOUR, withPick(COLOUR, skipped, 'blue'))).toBeNull()
    expect(answerOf(COLOUR, withPick(COLOUR, { ...EMPTY_DRAFT, skipped: true }, 'blue'))).toEqual([
      'blue',
    ])
  })
})

describe('the summary card (open question 18)', () => {
  it('shows each answer’s items apart, so a label holding 「, 」 stays one item, and null as 无偏好', () => {
    const summary = summaryOf(
      [COLOUR, SIZES],
      {
        source: 'no-preference',
        question: { answers: { 'Which colour?': ['red, dark', 'green'], 'Which sizes?': null } },
      },
      null,
    )
    expect(summary).toEqual({
      rows: [
        { question: COLOUR, answer: { kind: 'answered', items: ['red, dark', 'green'] } },
        { question: SIZES, answer: { kind: 'no-preference' } },
      ],
      response: null,
      preview: null,
    })
  })

  it('a key the record lacks reads as skipped (§答复与投递「缺的键按跳过」)', () => {
    expect(
      summaryOf(
        [COLOUR, SIZES],
        { source: null, question: { answers: { 'Which colour?': ['blue'] } } },
        null,
      )?.rows.map((row) => row.answer.kind),
    ).toEqual(['answered', 'no-preference'])
  })

  it('an explicit empty array stays an answer rather than becoming a skip', () => {
    expect(
      summaryOf([COLOUR], { source: null, question: { answers: { 'Which colour?': [] } } }, null)
        ?.rows[0]?.answer,
    ).toEqual({ kind: 'answered', items: [] })
  })

  it('a typed reply shows as typed, once, and no question claims it', () => {
    expect(
      summaryOf(
        [COLOUR, SIZES],
        { source: 'typed-answer', question: { answers: {}, response: 'the blue one, please' } },
        null,
      ),
    ).toEqual({
      rows: [
        { question: COLOUR, answer: { kind: 'typed' } },
        { question: SIZES, answer: { kind: 'typed' } },
      ],
      response: 'the blue one, please',
      preview: null,
    })
  })

  it('says where a long answer’s full text is when the record kept only its start (H9)', () => {
    for (const preview of ['spilled', 'unsaved'] as const) {
      expect(
        summaryOf(
          [COLOUR],
          { source: 'typed-answer', question: { answers: {}, response: 'start', preview } },
          null,
        ),
      ).toMatchObject({ response: 'start', preview })
      expect(
        summaryOf(
          [COLOUR],
          { source: null, question: { answers: { 'Which colour?': ['start'] }, preview } },
          null,
        ),
      ).toMatchObject({ rows: [{ answer: { kind: 'answered', items: ['start'] } }], preview })
    }
    expect(summaryOf([COLOUR], { source: 'unanswered' }, null)?.preview).toBeNull()
  })

  it('a stop shows 未作答 on every question, whatever this window recorded', () => {
    const summary = summaryOf(
      [COLOUR, SIZES],
      { source: 'unanswered' },
      { answers: { 'Which colour?': ['blue'] } },
    )
    expect(summary?.rows.map((row) => row.answer)).toEqual([
      { kind: 'unanswered' },
      { kind: 'unanswered' },
    ])
    expect(summary?.response).toBeNull()
  })

  it('this window’s answer stands until the outcome arrives, and for an answer that came without it', () => {
    const mine = { answers: { 'Which colour?': ['blue'], 'Which sizes?': null } }
    expect(summaryOf([COLOUR, SIZES], null, mine)?.rows.map((row) => row.answer.kind)).toEqual([
      'answered',
      'no-preference',
    ])
    expect(summaryOf([COLOUR, SIZES], { source: 'no-preference' }, mine)).not.toBeNull()
    // The outcome's own record wins over this window's.
    expect(
      summaryOf(
        [COLOUR],
        { source: null, question: { answers: { 'Which colour?': ['red, dark'] } } },
        mine,
      )?.rows[0]?.answer,
    ).toEqual({ kind: 'answered', items: ['red, dark'] })
  })

  it('no card before an answer, nor for a result that is neither an answer nor a stop', () => {
    expect(summaryOf([COLOUR], null, null)).toBeNull()
    expect(summaryOf([COLOUR], { source: 'invalid-input' }, null)).toBeNull()
    expect(
      summaryOf([COLOUR], { source: 'tool-unavailable' }, { answers: { 'Which colour?': null } }),
    ).toBeNull()
  })
})
