import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { deferred, messageBodies, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic, ScriptedReply } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import type { Locale } from './helpers/launch.js'
import { allowCard, newChatFromSidebar } from './helpers/navigation.js'
import { named, runEnds, tapeFacts, userTexts } from './helpers/tape.js'
import { expect, test } from './helpers/test.js'
import { expectSingleLineUnclipped } from './helpers/text-fit.js'
import {
  callsReply,
  makeFolderTree,
  providerEnv,
  readCall,
  send,
  startTask,
  textReply,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * AskUserQuestion in the real shell (spec 02 §提问工具 AskUserQuestion, §等待模型, §阶段 2 做的组件
 * `AskWidget`、`AskSummaryCard`, §插话与输入框状态表「等提问」; plan step 26, 验收 46: 旧 133, 旧 175,
 * 旧 176 and 旧 11 the interface halves, the skip, the summary card live and after a restart, and the
 * banner's 「在等你回答」 left from step 20, 旧 134). The widget sits above the composer; the batch's
 * later calls queue under the question's own row; the answer, the skip, a typed reply and a stop each
 * leave the summary card under that row, read again from the Tape after a restart.
 */
let fake: FakeAnthropic | undefined
let tree: FolderTree | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
  tree?.dispose()
  tree = undefined
})

interface Question {
  readonly question: string
  readonly header: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
  readonly multiSelect: boolean
}

/** An `AskUserQuestion` call as the model asks for it. */
function askCall(id: string, questions: readonly Question[]) {
  return { type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } } as const
}

/** A single choice whose first label holds 「, 」 itself — the join the model reads must not split it. */
const COLOUR: Question = {
  question: 'Which colour should the chart use?',
  header: 'Colour',
  options: [
    { label: 'red, dark', description: 'Warm and strong' },
    { label: 'blue', description: 'Calm' },
  ],
  multiSelect: false,
}

const SIZES: Question = {
  question: 'Which sizes should it come in?',
  header: 'Sizes',
  options: [
    { label: 'x', description: 'Small' },
    { label: 'y', description: 'Medium' },
    { label: 'z', description: 'Large' },
  ],
  multiSelect: true,
}

const COPY = {
  'zh-CN': {
    noPreference: '无偏好',
    unanswered: '未作答',
    notAnswered: '没有作答。',
    stopped: '已停止。',
    queued: '排队中',
    pager: (index: number, count: number) => `${String(index)} / ${String(count)}`,
    banner: '另一个会话在等你回答',
    approvalBanner: '另一个会话在等你批准',
    placeholder: '或者直接在这里回复…',
    preview: '内容太长，这里只留了开头；全文在 Tenon 为这个会话保存的文件里，模型可以读取。',
  },
  en: {
    noPreference: 'No preference',
    unanswered: 'Not answered',
    notAnswered: 'Not answered.',
    stopped: 'Stopped.',
    queued: 'Queued',
    pager: (index: number, count: number) => `${String(index)} / ${String(count)}`,
    banner: 'Another session is waiting for your answer',
    approvalBanner: 'Another session is waiting for your approval',
    placeholder: 'Or reply here directly…',
    preview:
      'Too long to keep here in full, so this is only the start. The full text is in a file Tenon saved for this session, which the model can read.',
  },
} as const satisfies Record<Locale, unknown>

/** The tool row of the call the model made as `name`, the n-th such. */
function rowOf(page: Page, name: 'AskUserQuestion' | 'Read', nth = 0) {
  return page
    .getByTestId('tool-row')
    .filter({ has: page.getByTestId('tool-row-line').getByText(ROW_WORDS[name], { exact: false }) })
    .nth(nth)
}

const ROW_WORDS = { AskUserQuestion: /Ask you a question|向你提问/u, Read: /Read |读取 /u } as const

/** The result the model gets for `id` in a request body, and every text block after it. */
function resultAndAfter(
  body: { messages: Array<{ role: string; content: unknown }> },
  id: string,
): { result: { content?: unknown; is_error?: boolean } | undefined; after: string[] } {
  const blocks = body.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as Array<Record<string, unknown>>)
      : [{ type: 'text', text: String(message.content) }],
  )
  const at = blocks.findIndex(
    (block) => block['type'] === 'tool_result' && block['tool_use_id'] === id,
  )
  return {
    result: blocks[at] as { content?: unknown; is_error?: boolean } | undefined,
    after: blocks
      .slice(at + 1)
      .filter((block) => block['type'] === 'text')
      .map((block) => String(block['text'])),
  }
}

/** A tool_result's content as the text the model reads. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ text?: unknown }>).map((block) => String(block.text ?? '')).join('\n')
}

test('answers from the widget, with the later call queued under the question, and the summary is redrawn after a restart (旧 176)', async () => {
  const folders = makeFolderTree('ask-answer', { 'ws/a.txt': 'alpha-content\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(askCall('toolu_ask', [COLOUR, SIZES]), readCall('toolu_read', join(ws, 'a.txt'))),
      textReply('Red, dark it is.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('ask-answer')
  seedConfig(userData, { locale: 'en' })

  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { app, page } = first
    await startTask(app, page, ws)
    await send(page, 'make me a chart')

    // The widget, above the composer: one question a page, its header, its options.
    const widget = page.getByTestId('composer-slots').getByTestId('ask-widget')
    await expect(widget).toBeVisible()
    await expect(widget.getByTestId('ask-question')).toHaveText(COLOUR.question)
    await expect(widget.getByTestId('ask-header')).toHaveText('Colour')
    await expect(widget.getByTestId('ask-pager')).toHaveText(COPY.en.pager(1, 2))
    await expect(widget.getByTestId('ask-option')).toHaveCount(2)
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      COPY.en.placeholder,
    )
    // The composer keeps focus when the widget comes (it takes none).
    // The Read waits behind the question: a queued row under the question's row, no row of its own.
    const ask = rowOf(page, 'AskUserQuestion')
    await expect(ask.getByTestId('approval-queued-row')).toHaveCount(1)
    await expect(ask.getByTestId('approval-queued-row')).toContainText(join(ws, 'a.txt'))
    await expect(ask.getByTestId('approval-queued-row')).toContainText(COPY.en.queued)
    await expect(page.getByTestId('tool-row')).toHaveCount(1)
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    expect(server.requests).toHaveLength(1)

    await widget.locator('[data-testid="ask-option"][data-label="red, dark"]').click()
    await expect(
      widget.locator('[data-testid="ask-option"][data-label="red, dark"]'),
    ).toHaveAttribute('aria-pressed', 'true')
    await widget.getByTestId('ask-next').click()
    await expect(widget.getByTestId('ask-question')).toHaveText(SIZES.question)
    await expect(widget.getByTestId('ask-multi')).toBeVisible()
    await widget.locator('[data-testid="ask-option"][data-label="z"]').click()
    await widget.locator('[data-testid="ask-option"][data-label="x"]').click()
    // 旧 176: 在「其他」里打的字放进 answers[题目原文].
    await widget.getByTestId('ask-other').fill('w')
    await widget.getByTestId('ask-submit').click()

    await expect(page.getByTestId('ask-widget')).toHaveCount(0)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Red, dark it is.')
    const summary = ask.getByTestId('ask-summary')
    await expect(summary.getByTestId('ask-summary-row')).toHaveCount(2)
    // Each item on its own: the label that holds 「, 」 stays one.
    await expect(
      summary.getByTestId('ask-summary-row').nth(0).getByTestId('ask-summary-item'),
    ).toHaveText(['red, dark'])
    await expect(
      summary.getByTestId('ask-summary-row').nth(1).getByTestId('ask-summary-item'),
    ).toHaveText(['x', 'z', 'w'])
    // The Read ran once the answer went in, in the Run the answer opened.
    await expect(page.getByTestId('tool-row')).toHaveCount(2)
    await expect(page.getByTestId('approval-queued-row')).toHaveCount(0)
  } finally {
    await first.app.close()
  }

  const facts = tapeFacts(userData)
  const [asked] = named(facts, 'tool/result')
  expect(asked?.payload['question']).toEqual({
    answers: { [COLOUR.question]: ['red, dark'], [SIZES.question]: ['x', 'z', 'w'] },
  })
  expect(asked?.payload['isError']).toBe(false)
  expect(named(facts, 'execution/tool_outcome').map((fact) => fact.payload['source'])).toEqual([
    null,
    null,
  ])
  expect(runEnds(facts)).toEqual([
    { code: 'paused', waitingFor: 'question' },
    { code: 'completed' },
  ])
  // No message/user but the one the user sent: an answer is the call's result.
  expect(userTexts(facts)).toEqual(['make me a chart'])
  // The model read the answer, then the Read's result, in the next request.
  const [, second] = messageBodies(server)
  if (second === undefined) throw new Error('no second request')
  const { result } = resultAndAfter(second, 'toolu_ask')
  expect(result?.is_error ?? false).toBe(false)
  expect(textOf(result?.content)).toContain('red, dark')
  expect(JSON.stringify(second)).toContain('alpha-content')

  const again = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { page } = again
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Red, dark it is.')
    const summary = rowOf(page, 'AskUserQuestion').getByTestId('ask-summary')
    await expect(
      summary.getByTestId('ask-summary-row').nth(0).getByTestId('ask-summary-item'),
    ).toHaveText(['red, dark'])
    await expect(
      summary.getByTestId('ask-summary-row').nth(1).getByTestId('ask-summary-item'),
    ).toHaveText(['x', 'z', 'w'])
    await expect(page.getByTestId('ask-widget')).toHaveCount(0)
  } finally {
    await again.app.close()
  }
})

for (const locale of ['zh-CN', 'en'] as const) {
  test(`a skipped question is 「无偏好」 in the summary, live and after a restart (旧 24, ${locale})`, async () => {
    const copy = COPY[locale]
    fake = await startFakeAnthropic({
      replies: [callsReply(askCall('toolu_ask', [COLOUR])), textReply('Any colour, then.')],
    })
    const server = fake
    const userData = makeUserDataDir(`ask-skip-${locale}`)
    seedConfig(userData, { locale })

    const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
    try {
      const { page } = first
      // A chat: AskUserQuestion is in both profiles' tables.
      await send(page, 'pick a colour for me')
      const widget = page.getByTestId('ask-widget')
      await expect(widget).toBeVisible()
      // One question: no pager, and its button is 「提交」.
      await expect(widget.getByTestId('ask-pager')).toHaveCount(0)
      await expect(widget.getByTestId('ask-submit')).toBeDisabled()
      await widget.getByTestId('ask-skip').click()
      await expect(page.getByTestId('ask-widget')).toHaveCount(0)
      await expect(page.getByTestId('assistant-text').last()).toHaveText('Any colour, then.')
      const row = page.getByTestId('ask-summary-row')
      await expect(row).toHaveAttribute('data-answer', 'no-preference')
      await expect(row.getByTestId('ask-summary-mark')).toHaveText(copy.noPreference)
      await expect(row.getByTestId('ask-summary-question')).toHaveText(COLOUR.question)
    } finally {
      await first.app.close()
    }

    const facts = tapeFacts(userData)
    const [asked] = named(facts, 'tool/result')
    expect(asked?.payload['question']).toEqual({ answers: { [COLOUR.question]: null } })
    expect(asked?.payload['isError']).toBe(false)
    const [outcome] = named(facts, 'execution/tool_outcome')
    expect(outcome?.payload).toMatchObject({ state: 'completed', source: 'no-preference' })

    const again = await launchTenon({ userData, env: providerEnv(server.baseURL) })
    try {
      const row = again.page.getByTestId('ask-summary-row')
      await expect(row).toHaveAttribute('data-answer', 'no-preference')
      await expect(row.getByTestId('ask-summary-mark')).toHaveText(copy.noPreference)
    } finally {
      await again.app.close()
    }
  })
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`the banner words a waiting question apart from a waiting card, and 「回去」 brings the widget back (验收 23, 旧 134, ${locale})`, async () => {
    const copy = COPY[locale]
    tree = makeFolderTree(`ask-banner-${locale}`, { 'ws/a.txt': 'alpha\n', 'outside.txt': 'out\n' })
    const ws = join(tree.real, 'ws')
    fake = await startFakeAnthropic({
      replies: [
        callsReply(readCall('toolu_read', join(tree.real, 'outside.txt'))),
        callsReply(askCall('toolu_ask', [COLOUR])),
        textReply('Any colour, then.'),
      ],
    })
    const userData = makeUserDataDir(`ask-banner-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      // Session A waits on a card (a task reading outside its folder).
      await startTask(app, page, ws)
      await send(page, 'read outside')
      await expect(page.getByTestId('approval-card')).toHaveCount(1)
      // Session B waits on a question.
      await newChatFromSidebar(page)
      await expect(page.getByTestId('thread-empty')).toBeVisible()
      await send(page, 'pick a colour for me')
      await expect(page.getByTestId('ask-widget')).toBeVisible()

      // From a third session, both are listed, each in its own words (§离开会话 第 5 条).
      await newChatFromSidebar(page)
      await expect(page.getByTestId('thread-empty')).toBeVisible()
      const rows = page.getByTestId('pending-banner-row')
      await expect(rows).toHaveCount(2)
      const question = page.locator('[data-testid="pending-banner-row"][data-wait-kind="question"]')
      const approval = page.locator('[data-testid="pending-banner-row"][data-wait-kind="approval"]')
      await expect(question).toHaveCount(1)
      await expect(approval).toHaveCount(1)
      await expect(question.locator('span').first()).toHaveText(copy.banner)
      await expect(approval.locator('span').first()).toHaveText(copy.approvalBanner)
      // The question row's words fit on one line, unclipped, at 1280x800 (验收 37).
      await expectSingleLineUnclipped(question)

      // 「回去」 on the question's row: its widget is answerable right there, and it is no longer listed.
      await question.getByTestId('pending-banner-go').click()
      await expect(page.getByTestId('user-text')).toHaveText('pick a colour for me')
      const widget = page.getByTestId('ask-widget')
      await expect(widget).toBeVisible()
      await expect(widget.getByTestId('ask-question')).toHaveText(COLOUR.question)
      await expect(rows).toHaveCount(1)
      await expect(rows).toHaveAttribute('data-wait-kind', 'approval')
      await widget.getByTestId('ask-skip').click()
      await expect(page.getByTestId('assistant-text').last()).toHaveText('Any colour, then.')
      expect(fake.requests).toHaveLength(3)
    } finally {
      await app.close()
    }
  })
}

test('a send while the question waits is its answer: no message, a new Run, and the queued message goes in before the next request (旧 133)', async () => {
  const hold = deferred()
  const reply: ScriptedReply = {
    steps: [
      { type: 'text', text: 'Let me ask.' },
      { type: 'wait', until: hold.promise },
      askCall('toolu_ask', [COLOUR]),
    ],
    delayMs: 5,
  }
  fake = await startFakeAnthropic({ replies: [reply, textReply('Blue, and noted.')] })
  const server = fake
  const userData = makeUserDataDir('ask-typed')
  seedConfig(userData, { locale: 'en' })

  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await send(page, 'pick a colour for me')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Let me ask.')
    // Sent while the reply streams: it queues (H13).
    await send(page, 'also make it big')
    await expect(page.getByTestId('queued-bubble')).toHaveCount(1)
    hold.resolve()
    const widget = page.getByTestId('ask-widget')
    await expect(widget).toBeVisible()
    // Paused on the question: the queued message stays queued (§插话与输入框状态表「等提问」).
    await expect(page.getByTestId('queued-bubble')).toHaveCount(1)
    expect(server.requests).toHaveLength(1)

    // 「发送」 while the question waits: the typed words are its answer.
    await send(page, '  the blue one  ')
    await expect(page.getByTestId('ask-widget')).toHaveCount(0)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Blue, and noted.')
    const summary = page.getByTestId('ask-summary')
    await expect(summary.getByTestId('ask-summary-response')).toHaveText('the blue one')
    await expect(summary.getByTestId('ask-summary-row')).toHaveAttribute('data-answer', 'typed')
    // No bubble of the typed answer: it is no message. The queued one went in.
    await expect(page.getByTestId('user-message')).toHaveCount(2)
    await expect(page.getByTestId('user-text')).toHaveText([
      'pick a colour for me',
      'also make it big',
    ])
    await expect(page.getByTestId('queued-bubble')).toHaveCount(0)
    expect(named(tapeFacts(userData), 'tool/result')[0]?.payload['question']).toEqual({
      answers: {},
      response: '  the blue one  ',
    })
  } finally {
    await app.close()
  }
})

// H9 for everyone (Revisions 31, owner 2026-10-01): a long answer is the spill file's alone.
test('a long typed reply keeps only its start on the summary card, which says the full text is saved, live and after a restart', async () => {
  fake = await startFakeAnthropic({
    replies: [callsReply(askCall('toolu_ask', [COLOUR])), textReply('Noted.')],
  })
  const server = fake
  const userData = makeUserDataDir('ask-long')
  seedConfig(userData, { locale: 'zh-CN' })
  const text = 'a long reply in my own words '.repeat(1400)
  expect(text.length).toBeGreaterThan(40_000)
  const start = text.slice(0, 2000)

  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { page } = first
    await send(page, 'pick a colour for me')
    await expect(page.getByTestId('ask-widget')).toBeVisible()
    await send(page, text)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Noted.')
    const summary = page.getByTestId('ask-summary')
    await expect(summary.getByTestId('ask-summary-preview')).toHaveText(COPY['zh-CN'].preview)
    expect(await summary.getByTestId('ask-summary-response').textContent()).toBe(start)
  } finally {
    await first.app.close()
  }

  const facts = tapeFacts(userData)
  expect(named(facts, 'tool/result')[0]?.payload['question']).toEqual({
    answers: {},
    response: start,
    preview: 'spilled',
  })
  expect(facts.filter((fact) => JSON.stringify(fact.payload).includes(text))).toEqual([])
  const [, second] = messageBodies(server)
  expect(JSON.stringify(second)).not.toContain(text)

  const again = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const summary = again.page.getByTestId('ask-summary')
    await expect(summary.getByTestId('ask-summary-preview')).toHaveText(COPY['zh-CN'].preview)
    expect(await summary.getByTestId('ask-summary-response').textContent()).toBe(start)
  } finally {
    await again.app.close()
  }
})

test('a restored unanswered question stops with every question unanswered and later calls not run', async () => {
  tree = makeFolderTree('ask-stop', { 'ws/a.txt': 'not read' })
  const ws = join(tree.real, 'ws')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(askCall('toolu_ask', [COLOUR, SIZES]), readCall('toolu_read', join(ws, 'a.txt'))),
    ],
  })
  const userData = makeUserDataDir('ask-stop')
  seedConfig(userData, { locale: 'en' })
  const env = providerEnv(fake.baseURL)
  const first = await launchTenon({ userData, env })
  try {
    await startTask(first.app, first.page, ws)
    await send(first.page, 'ask before reading')
    await expect(first.page.getByTestId('ask-widget')).toBeVisible()
  } finally {
    await first.app.close()
  }
  const again = await launchTenon({ userData, env })
  try {
    await expect(again.page.getByTestId('ask-widget')).toBeVisible()
    await expect(again.page.getByTestId('ask-question')).toHaveText(COLOUR.question)
    await again.page.getByTestId('composer-stop').click()
    await expect(again.page.getByTestId('ask-widget')).toHaveCount(0)
    await expect(again.page.getByTestId('ask-summary-mark')).toHaveText([
      COPY.en.unanswered,
      COPY.en.unanswered,
    ])
    await expect(again.page.getByTestId('approval-queued-row')).toHaveCount(0)
  } finally {
    await again.app.close()
  }
  expect(
    named(tapeFacts(userData), 'execution/tool_outcome').map((fact) => ({
      state: fact.payload['state'],
      source: fact.payload['source'],
    })),
  ).toEqual([
    { state: 'aborted', source: 'unanswered' },
    { state: 'not-run', source: 'stopped' },
  ])
  expect(fake.requests).toHaveLength(1)
})

test('an earlier approval is answered before the question appears', async () => {
  tree = makeFolderTree('ask-approval', { 'ws/a.txt': 'inside', 'outside.txt': 'outside' })
  const ws = join(tree.real, 'ws')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(
        readCall('toolu_read', join(tree.real, 'outside.txt')),
        askCall('toolu_ask', [COLOUR]),
      ),
      textReply('Done.'),
    ],
  })
  const userData = makeUserDataDir('ask-approval')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'read, then ask')
    await expect(page.getByTestId('approval-card')).toBeVisible()
    await expect(page.getByTestId('ask-widget')).toHaveCount(0)
    await allowCard(page)
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    await expect(page.getByTestId('ask-widget')).toBeVisible()
    await page.getByTestId('ask-skip').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Done.')
  } finally {
    await app.close()
  }
})
