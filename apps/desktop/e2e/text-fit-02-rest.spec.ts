import { symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { startFakeOpenAI } from '../test/support/fake-openai.js'
import type { FakeOpenAI } from '../test/support/fake-openai.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import type { Locale } from './helpers/launch.js'
import { newChatFromSidebar, repoint } from './helpers/navigation.js'
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
 * 00 acceptance 12's bilingual 「不换行不截断」 regression over the rest of phase 2's new components
 * (spec 02 §界面范围: 新组件的界面文字纳入回归; acceptance 37), the ones text-fit-02.spec.ts does not
 * reach: ModeSwitch, FolderChip, AskWidget, AskSummaryCard, ThinkingBlock, the round's summary line,
 * a ToolRow's closure line, the model menu's confirmation, and the resume row with its banner row
 * (ask.spec.ts measures the question's banner row, where it already has one waiting).
 * What the model wrote — a question, an option, a thinking sentence, a tool's object — is content and
 * is not measured; every element measured here holds interface words, or a short folder name beside
 * them.
 */
let fake: FakeAnthropic | undefined
let ollama: FakeOpenAI | undefined
let tree: FolderTree | undefined

test.afterEach(async () => {
  await fake?.close()
  await ollama?.close()
  fake = undefined
  ollama = undefined
  tree?.dispose()
  tree = undefined
})

/**
 * The session's default: anthropic, whose official host the origin map test seam sends to the fake
 * (M6 §点名「测试接缝」) — a public host, so the confirmation is measured from a chat on Ollama.
 */
const PROVIDER = { id: 'anthropic', modelId: 'claude-sonnet-5' } as const

/** An `AskUserQuestion` call: one single choice, then one multiple choice. */
function askCall(id: string, count: 1 | 2) {
  const questions = [
    {
      question: 'Which colour should the chart use?',
      header: 'Colour',
      options: [
        { label: 'red', description: 'Warm' },
        { label: 'blue', description: 'Calm' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which sizes should it come in?',
      header: 'Sizes',
      options: [
        { label: 'small', description: '' },
        { label: 'large', description: '' },
      ],
      multiSelect: true,
    },
  ].slice(0, count)
  return { type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } } as const
}

for (const locale of ['zh-CN', 'en'] as const satisfies readonly Locale[]) {
  test(`the mode switch, folder chip and its prefill, question widget, its summaries, thinking, the round’s line, a closure line and the confirmation fit at 1280x800 in ${locale} (验收 37)`, async () => {
    const folders = makeFolderTree(`fit-02-rest-${locale}`, { 'ws/a.txt': 'alpha\n' })
    tree = folders
    const ws = join(folders.real, 'ws')
    const file = join(ws, 'a.txt')
    const userData = makeUserDataDir(`fit-02-rest-${locale}`)
    // Ollama on a loopback fake: the history on this computer the confirmation is about.
    ollama = await startFakeOpenAI({ chunks: ['local ', 'answer'], delayMs: 5 })
    const local = ollama
    seedConfig(userData, {
      locale,
      provider: PROVIDER,
      providerConfig: { ollama: { baseURL: local.baseURL } },
    })
    fake = await startFakeAnthropic({
      replies: [
        // Round 1: thinking, two questions, and a Read queued behind them; both are skipped.
        {
          steps: [
            { type: 'thinking', thinking: ['Ask first. ', 'Then read.'], signature: 'sig-fit' },
            askCall('toolu_ask1', 2),
            readCall('toolu_read1', file),
          ],
          delayMs: 5,
        },
        textReply('Noted.'),
        // Round 2: a reply typed in the composer answers the question.
        callsReply(askCall('toolu_ask2', 1)),
        textReply('Blue.'),
        // Round 3: stopped while it waits — the question unanswered, the Read not run.
        callsReply(askCall('toolu_ask3', 1), readCall('toolu_read3', file)),
      ],
    })
    const server = fake
    // A key for zhipu, whose public host the confirmation names. Nothing is ever sent there: the
    // confirmation is backed out of, and the chat stays on Ollama.
    const { app, page } = await launchTenon({
      userData,
      env: { ...providerEnv(server.baseURL), ZHIPU_API_KEY: 'e2e-zhipu-key' },
    })
    try {
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await expect(page.getByTestId('model-menu-current')).toContainText(PROVIDER.modelId)

      // ModeSwitch before the first message: both choices.
      await expectSingleLineUnclipped(page.getByTestId('mode-chat'))
      await expectSingleLineUnclipped(page.getByTestId('mode-cowork'))
      // FolderChip with nothing picked: its label, the session's own folder, 「添加文件夹…」.
      await page.getByTestId('mode-cowork').click()
      const chip = page.getByTestId('folder-chip')
      await expect(chip.getByTestId('folder-item')).toHaveCount(1)
      await expectSingleLineUnclipped(chip.locator(':scope > span').first())
      await expectSingleLineUnclipped(chip.getByTestId('folder-item'))
      await expectSingleLineUnclipped(chip.getByTestId('folder-add'))
      // A picked folder: its short name and 「命令在这里运行」. Its prefill offer is measured last,
      // from the next task.
      await startTask(app, page, ws)
      await expectSingleLineUnclipped(chip.getByTestId('folder-item'))

      // Round 1: the widget on its first page, the thinking block's label, the composer's placeholder.
      await send(page, 'ask me first')
      const widget = page.getByTestId('ask-widget')
      await expect(widget).toBeVisible()
      for (const part of ['ask-pager', 'ask-reply-hint', 'ask-skip', 'ask-next', 'ask-other']) {
        // oxlint-disable-next-line no-await-in-loop -- one element at a time, so a failure names it
        await expectSingleLineUnclipped(widget.getByTestId(part))
      }
      await expectSingleLineUnclipped(page.getByTestId('composer-input'))
      await expectSingleLineUnclipped(
        page.getByTestId('thinking-toggle').locator(':scope > span').first(),
      )
      // Its second page: the multiple-choice note, 「上一题」 and 「提交」.
      await widget.getByTestId('ask-skip').click()
      await expect(widget.getByTestId('ask-multi')).toBeVisible()
      for (const part of ['ask-multi', 'ask-previous', 'ask-skip', 'ask-submit']) {
        // oxlint-disable-next-line no-await-in-loop -- one element at a time, so a failure names it
        await expectSingleLineUnclipped(widget.getByTestId(part))
      }
      await widget.getByTestId('ask-skip').click()
      await expect(page.getByTestId('assistant-text').last()).toHaveText('Noted.')
      // The summary's 「无偏好」 twice, and the round's one summary line (the Read ran).
      await expect(page.getByTestId('ask-summary-mark')).toHaveCount(2)
      await expectSingleLineUnclipped(page.getByTestId('ask-summary-mark'), 2)
      await expect(page.getByTestId('turn-summary')).toHaveCount(1)
      await expectSingleLineUnclipped(page.getByTestId('turn-summary'))

      // Round 2: a typed reply, under 「你直接回复：」.
      await send(page, 'ask me again')
      await expect(widget).toBeVisible()
      await send(page, 'the blue one')
      await expect(page.getByTestId('assistant-text').last()).toHaveText('Blue.')
      const typed = page.getByTestId('ask-summary-response')
      await expect(typed).toHaveText('the blue one')
      await expectSingleLineUnclipped(typed.locator('xpath=preceding-sibling::span'))

      // Round 3: stopped while it waits — 「未作答」, and the Read's closure line.
      await send(page, 'ask once more')
      await expect(widget).toBeVisible()
      await page.getByTestId('composer-stop').click()
      await expect(widget).toHaveCount(0)
      const marks = page.getByTestId('ask-summary-mark')
      await expect(marks).toHaveCount(3)
      await expectSingleLineUnclipped(marks.last())
      const closure = page.getByTestId('tool-row-closure')
      await expect(closure.last()).toBeVisible()
      await expectSingleLineUnclipped(closure)
      expect(server.requests).toHaveLength(5)

      // The model menu's confirmation before history leaves this computer: a chat on Ollama, then
      // zhipu's public host — its two choices.
      await newChatFromSidebar(page)
      await page.getByTestId('model-menu-trigger').click()
      await page.getByTestId('model-row-ollama-qwen3:8b').click()
      await send(page, 'keep this local')
      await expect(page.getByTestId('assistant-text').last()).toHaveText('local answer')
      await page.getByTestId('model-menu-trigger').click()
      await page.getByTestId('model-row-zhipu-glm-5.3-flash').click()
      const confirm = page.getByTestId('model-confirm')
      await expect(confirm).toBeVisible()
      await expectSingleLineUnclipped(page.getByTestId('model-confirm-switch'))
      await expectSingleLineUnclipped(page.getByTestId('model-confirm-new-chat'))
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('model-menu')).toBeHidden()
      await expect(page.getByTestId('model-menu-current')).toContainText('qwen3:8b')
      expect(local.requests).toHaveLength(1)

      // The next task: FolderChip offers the folder this one picked (「用上次的 1 个文件夹」).
      await newChatFromSidebar(page)
      await page.getByTestId('mode-cowork').click()
      await expect(chip.getByTestId('folder-item')).toHaveCount(1)
      await expect(chip.getByTestId('folder-prefill')).toHaveAttribute('title', ws)
      await expectSingleLineUnclipped(chip.getByTestId('folder-prefill'))
      expect(server.requests).toHaveLength(5)
    } finally {
      await app.close()
    }
  })

  test(`the resume row and its banner row fit at 1280x800 in ${locale} (验收 37)`, async () => {
    // A task paused on a card for `hop/x.txt`; between the launches `hop` is pointed at the profile
    // directory, so the startup re-judgement closes the call and the session is resumable
    // (recovery.spec.ts's setup, §执行日志与恢复表「可续跑项」).
    const folders = makeFolderTree(`fit-02-resume-${locale}`, {
      'ws/a.txt': 'alpha\n',
      'outside/x.txt': 'x\n',
    })
    tree = folders
    const hop = join(dirname(folders.real), 'hop')
    symlinkSync(join(folders.real, 'outside'), hop, 'dir')
    fake = await startFakeAnthropic({
      replies: [callsReply(readCall('toolu_x', join(hop, 'x.txt')))],
    })
    const server = fake
    const userData = makeUserDataDir(`fit-02-resume-${locale}`)
    seedConfig(userData, { locale, provider: PROVIDER })
    const guarded = join(dirname(configPathIn(userData)), 'x.txt')
    writeFileSync(guarded, 'guarded\n')

    const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
    try {
      await startTask(first.app, first.page, join(folders.real, 'ws'))
      await send(first.page, 'read x')
      await expect(first.page.getByTestId('approval-card')).toHaveCount(1)
    } finally {
      await first.app.close()
    }
    repoint(hop, dirname(guarded))

    const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
    try {
      const { page } = second
      const row = page.getByTestId('resume-row')
      await expect(row).toBeVisible()
      await expectSingleLineUnclipped(row.locator(':scope > span'))
      await expectSingleLineUnclipped(row.getByTestId('resume-continue'))
      await newChatFromSidebar(page)
      const banner = page.getByTestId('pending-banner-row')
      await expect(banner).toHaveAttribute('data-wait-kind', 'resume')
      await expectSingleLineUnclipped(banner)
      await expectSingleLineUnclipped(banner.getByTestId('pending-banner-go'))
      // Listed only: nothing resumed, nothing sent.
      expect(server.requests).toHaveLength(1)
    } finally {
      await second.app.close()
    }
  })
}
