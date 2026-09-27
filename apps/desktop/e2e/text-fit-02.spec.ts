import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import type { Locale } from './helpers/launch.js'
import { PAST_CLICK_GUARD_MS, newChatFromSidebar } from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import { expectSingleLineUnclipped } from './helpers/text-fit.js'
import {
  bashCall,
  callsReply,
  editCall,
  makeFolderTree,
  providerEnv,
  readCall,
  send,
  startTask,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * 00 acceptance 12's bilingual 「不换行不截断」 regression, over what step 20 added (spec 02 §界面范围:
 * 新组件的界面文字纳入回归; plan step 20: 旧 223): the approval card, the model menu, the failure card,
 * the blocked notice and the pending banner — and, on the same launch, the composer's hint and stop,
 * the queued bubble and the leave dialog. Object lines (paths, commands, URLs) are content and may
 * wrap (E4), so every element measured here is one that holds interface words only.
 */
let fake: FakeAnthropic | undefined
let tree: FolderTree | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
  tree?.dispose()
  tree = undefined
})

/** A model row's two lines: the model's name, then its purpose and host (ModelMenu.tsx `secondLine`). */
const ROW_NAME = '[data-testid^="model-row-"] > span:last-child > span:first-child'
const ROW_LINE = '[data-testid^="model-row-"] > span:last-child > span:last-child'

for (const locale of ['zh-CN', 'en'] as const satisfies readonly Locale[]) {
  // The longest en lines — 「Balanced speed and capability · This computer」 (claude-sonnet-5) and
  // 「Needs 30-day data retention turned on for your organization or workspace · This computer」
  // (claude-fable-5-1) — are the ones that wrapped while the popup kept its trigger's width; it
  // grows to its rows now.
  test(`every model row’s purpose and host line fits in the model menu in ${locale} (旧 223)`, async () => {
    const userData = makeUserDataDir(`fit-02-menu-${locale}`)
    seedConfig(userData, { locale })
    fake = await startFakeAnthropic({ chunks: ['ok'], delayMs: 5 })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await page.getByTestId('model-menu-trigger').click()
      const menu = page.getByTestId('model-menu')
      await expect(menu).toBeVisible()
      // Anthropic's four main rows and Ollama's one.
      await expectSingleLineUnclipped(menu.locator(ROW_LINE), 5)
    } finally {
      await app.close()
    }
  })

  test(`step 20’s components fit at 1280x800 in ${locale} (旧 223)`, async () => {
    const folders = makeFolderTree(`fit-02-${locale}`, {
      'ws/a.txt': 'alpha\n',
      'outside/one.txt': 'one\n',
      'outside/two.txt': 'two\n',
    })
    tree = folders
    const ws = join(folders.real, 'ws')
    const userData = makeUserDataDir(`fit-02-${locale}`)
    seedConfig(userData, { locale })
    // A file in the profile directory, which no Read may reach (D2): a BlockedNotice.
    const guarded = join(dirname(configPathIn(userData)), 'guarded.txt')
    writeFileSync(guarded, 'guarded\n')
    const hold = deferred()
    fake = await startFakeAnthropic({
      replies: [
        callsReply(readCall('toolu_one', join(folders.real, 'outside', 'one.txt'))),
        callsReply(
          readCall('toolu_guarded', guarded),
          readCall('toolu_two', join(folders.real, 'outside', 'two.txt')),
        ),
        {
          steps: [
            { type: 'text', text: 'Working' },
            { type: 'wait', until: hold.promise },
          ],
          delayMs: 5,
        },
      ],
    })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await expect(page.locator('html')).toHaveAttribute('lang', locale)

      // Session A waits on a card; from session B the banner lists it.
      await startTask(app, page, ws)
      await send(page, 'read one')
      await expect(page.getByTestId('approval-card')).toHaveCount(1)
      await newChatFromSidebar(page)
      const banner = page.getByTestId('pending-banner-row')
      await expect(banner).toHaveCount(1)
      await expectSingleLineUnclipped(banner)
      await expectSingleLineUnclipped(page.getByTestId('pending-banner-go'))

      // Session B: a blocked call, then a card of its own.
      await startTask(app, page, ws)
      await send(page, 'read guarded and two')
      const card = page.getByTestId('approval-card')
      await expect(card).toHaveCount(1)
      const notice = page.getByTestId('blocked-notice')
      await expect(notice).toHaveAttribute('data-source', 'protected')
      // Its first line names the file (content); the second is interface words only.
      await expectSingleLineUnclipped(notice.locator('p').last())
      for (const part of ['approval-title', 'approval-scope', 'approval-deny', 'approval-allow']) {
        // oxlint-disable-next-line no-await-in-loop -- one element at a time, so a failure names it
        await expectSingleLineUnclipped(card.getByTestId(part))
      }
      await expectSingleLineUnclipped(page.getByTestId('composer-pending-hint'))
      await expectSingleLineUnclipped(page.getByTestId('composer-stop'))

      // The model menu while a card waits: the next-message label, each group's label, each row's
      // model name (its second line is the next test's), the rest. Text spans, not whole rows: a
      // row's check mark sits in a 16px box with 2px of padding, which is no text of anyone's.
      await page.getByTestId('model-menu-trigger').click()
      const menu = page.getByTestId('model-menu')
      await expect(menu).toBeVisible()
      await expectSingleLineUnclipped(menu.getByTestId('model-next-message'))
      await expectSingleLineUnclipped(
        menu.locator('[data-testid^="model-group-"] > :first-child'),
        2,
      )
      await expectSingleLineUnclipped(menu.locator(ROW_NAME), 3)
      await expectSingleLineUnclipped(menu.getByTestId('model-unconfigured-zhipu'))
      await expectSingleLineUnclipped(menu.getByTestId('model-effort'))
      await expectSingleLineUnclipped(menu.getByTestId('model-more'))
      await expectSingleLineUnclipped(menu.getByTestId('model-manage'))
      // Esc in the menu closes the menu; it is not the thread's stop, which would cancel the card.
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await page.waitForTimeout(300)
      await expect(card).toHaveCount(1)

      // Declined: the collapsed line's result, and the failure card.
      await page.waitForTimeout(PAST_CLICK_GUARD_MS)
      await card.getByTestId('approval-deny').click()
      const answered = page.getByTestId('approval-answered')
      await expect(answered).toHaveAttribute('data-outcome', 'denied')
      await expectSingleLineUnclipped(answered.locator('span').first())
      const failure = page.getByTestId('failure-card')
      await expect(failure).toHaveAttribute('data-code', 'user-rejected')
      await expectSingleLineUnclipped(failure.getByTestId('failure-what'))
      await expectSingleLineUnclipped(failure.getByTestId('failure-effects').locator('p'))
      await expectSingleLineUnclipped(failure.getByTestId('failure-action'))

      // A Run in progress: a queued bubble's row of actions, and the leave dialog.
      await send(page, 'long one')
      await expect(page.getByTestId('assistant-text').last()).toHaveText('Working')
      await send(page, 'queued one')
      const bubble = page.getByTestId('queued-bubble')
      await expect(bubble).toHaveCount(1)
      for (const part of ['queued-label', 'queued-withdraw', 'queued-edit', 'queued-send-now']) {
        // oxlint-disable-next-line no-await-in-loop -- one element at a time, so a failure names it
        await expectSingleLineUnclipped(bubble.getByTestId(part))
      }
      await newChatFromSidebar(page)
      const dialog = page.getByTestId('leave-run')
      await expect(dialog).toBeVisible()
      await expectSingleLineUnclipped(dialog.getByRole('heading'))
      await expectSingleLineUnclipped(dialog.getByTestId('leave-stay'))
      await expectSingleLineUnclipped(dialog.getByTestId('leave-stop'))
      await dialog.getByTestId('leave-stop').click()
      await expect(page.getByTestId('thread-empty')).toBeVisible()
    } finally {
      hold.resolve()
      await app.close()
    }
  })

  test(`step 22’s write and irreversible cards fit at 1280x800 in ${locale} (旧 223)`, async () => {
    const folders = makeFolderTree(`fit-22-${locale}`, { 'ws/a.txt': 'alpha\n' })
    tree = folders
    const ws = join(folders.real, 'ws')
    const userData = makeUserDataDir(`fit-22-${locale}`)
    seedConfig(userData, { locale })
    fake = await startFakeAnthropic({
      replies: [
        callsReply(
          editCall('toolu_edit', join(ws, 'a.txt'), 'alpha', 'beta', { replace_all: true }),
        ),
        callsReply(bashCall('toolu_rm', 'rm a.txt')),
      ],
    })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await startTask(app, page, ws)
      const card = page.getByTestId('approval-card')

      // A write card, its change open: the toggle, the two labels and the replace_all note.
      await send(page, 'edit a')
      await expect(card).toHaveCount(1)
      await card.getByTestId('approval-change-toggle').click()
      await expect(card.getByTestId('approval-change-label')).toHaveCount(2)
      await expectSingleLineUnclipped(card.getByTestId('approval-change-label'), 2)
      for (const part of [
        'approval-title',
        'approval-change-toggle',
        'approval-change-note',
        'approval-scope',
        'approval-deny',
        'approval-allow',
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one element at a time, so a failure names it
        await expectSingleLineUnclipped(card.getByTestId(part))
      }
      await page.waitForTimeout(PAST_CLICK_GUARD_MS)
      await card.getByTestId('approval-deny').click()
      await expect(page.getByTestId('failure-card')).toHaveAttribute('data-code', 'user-rejected')

      // An irreversible card: its own sentence, 「拒绝 ⏎ Esc」 and a bare 「允许」. Denied, nothing runs.
      await send(page, 'delete a')
      await expect(card).toHaveCount(1)
      await expect(card.getByTestId('approval-irreversible')).toHaveCount(1)
      for (const part of [
        'approval-title',
        'approval-irreversible',
        'approval-scope',
        'approval-deny',
        'approval-allow',
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one element at a time, so a failure names it
        await expectSingleLineUnclipped(card.getByTestId(part))
      }
      await page.waitForTimeout(PAST_CLICK_GUARD_MS)
      await card.getByTestId('approval-deny').click()
      await expect(page.getByTestId('failure-card').last()).toHaveAttribute(
        'data-code',
        'user-rejected',
      )
    } finally {
      await app.close()
    }
  })
}
