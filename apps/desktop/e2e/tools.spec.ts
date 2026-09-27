import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import {
  callsReply,
  makeFolderTree,
  providerEnv,
  readCall,
  send,
  startTask,
  stubFolderDialog,
  textReply,
  waitingApproval,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/** apps/desktop/src/renderer/src/lib/visible.ts NEWLINE_MARK: what a newline in tool text shows as. */
const NEWLINE_MARK = '⏎'

/**
 * Tool rows in the real shell (spec 02 §界面范围 `ToolRow`, `BlockedNotice`, `TurnSummaryLine`; plan
 * step 20: 旧 222 without the Write half, which waits for step 22).
 */
let fake: FakeAnthropic | undefined
let tree: FolderTree | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
  tree?.dispose()
  tree = undefined
})

/** Clicks on a card that just appeared are ignored this long (ApprovalCard.tsx's APPROVAL_CLICK_GUARD_MS, 400). */
const PAST_CLICK_GUARD_MS = 600

test('a task Read of a file in the Tenon profile is blocked under its row, with no way to allow it (旧 222)', async () => {
  const folders = makeFolderTree('protected', { 'ws/a.txt': 'alpha\n' })
  tree = folders
  const userData = makeUserDataDir('protected')
  seedConfig(userData, { locale: 'en' })
  // A file in the profile directory, beside config.json and sessions.db: no Read may reach it (D2).
  const note = join(dirname(configPathIn(userData)), 'note.txt')
  writeFileSync(note, 'PROFILE-SECRET-42\n')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_note', note)), textReply('I cannot ', 'read it.')],
  })
  const server = fake
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read the config')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('I cannot read it.')

    const row = page.getByTestId('tool-row')
    await expect(row).toHaveCount(1)
    const notice = row.getByTestId('blocked-notice')
    await expect(notice).toHaveAttribute('data-source', 'protected')
    // What, why (blocked.protected with its target slot filled), and that the model was told.
    await expect(notice).toHaveText(
      `Read can’t reach ${note}: Tenon protects it.The model was told.`,
    )
    // A block is not a closure line and never a card: nothing here lets it through.
    await expect(row.getByTestId('tool-row-closure')).toHaveCount(0)
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    await expect(page.getByTestId('approval-allow')).toHaveCount(0)
    await expect(page.getByTestId('composer-pending-hint')).toHaveCount(0)
    // The model got the block as an error result, and nothing of the file.
    expect(server.requests).toHaveLength(2)
    const second = JSON.stringify(server.requests[1]?.body)
    expect(second).toContain('"is_error":true')
    expect(second).not.toContain('PROFILE-SECRET-42')
  } finally {
    await app.close()
  }
})

test('in a chat, a Read of anything but this chat’s saved files is blocked with the chat’s own sentence (旧 222, open question 13)', async () => {
  const folders = makeFolderTree('chat-read', { 'notes.txt': 'CHAT-NOTE-7731\n' })
  tree = folders
  const notes = join(folders.real, 'notes.txt')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_notes', notes)), textReply('Blocked.')],
  })
  const server = fake
  const userData = makeUserDataDir('chat-read')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await expect(page.getByTestId('mode-switch')).toHaveAttribute('data-profile', 'chat')
    await send(page, 'read my notes')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Blocked.')
    const notice = page.getByTestId('tool-row').getByTestId('blocked-notice')
    await expect(notice).toHaveAttribute('data-source', 'protected')
    await expect(notice).toHaveText(
      `对话里 Read 只能打开 Tenon 为这个对话保存的文件；${notes} 不在其中。已告诉模型。`,
    )
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    expect(JSON.stringify(server.requests[1]?.body)).not.toContain('CHAT-NOTE-7731')
  } finally {
    await app.close()
  }
})

test('in a chat, the notice writes what the path hides as escapes, and the first message fixes the mode (②′; §界面范围 BlockedNotice, ModeSwitch)', async () => {
  const hidden = 'no​tes.txt'
  const folders = makeFolderTree('chat-hidden', { [hidden]: 'CHAT-NOTE-8842\n' })
  tree = folders
  const notes = join(folders.real, hidden)
  const shown = join(folders.real, 'no\\u{200B}tes.txt')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_notes', notes)), textReply('Blocked.')],
  })
  const server = fake
  const userData = makeUserDataDir('chat-hidden')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    // Before the first message either mode can be chosen.
    await expect(page.getByTestId('mode-chat')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('mode-cowork')).toBeVisible()
    await send(page, 'read my notes')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Blocked.')
    // The notice's slots escaped as the card's are: its path reads as the call will run.
    await expect(page.getByTestId('blocked-notice')).toHaveText(
      `In a chat, Read can only open files Tenon saved for this chat; ${shown} is not one of them.The model was told.`,
    )
    // That message established the chat: the mode shows, and the other one is gone.
    await expect(page.getByTestId('mode-chat')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('mode-cowork')).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a task’s folders: commands run in the first, and the ones last picked are offered to the next task (§界面范围 FolderChip; D11, D8)', async () => {
  const folders = makeFolderTree('folders', { 'one/a.txt': 'a\n', 'two/b.txt': 'b\n' })
  tree = folders
  const one = join(folders.real, 'one')
  const two = join(folders.real, 'two')
  const userData = makeUserDataDir('folders')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  try {
    await page.getByTestId('mode-cowork').click()
    const items = page.getByTestId('folder-item')
    // None picked: the session's own folder, where commands run.
    await expect(items).toHaveCount(1)
    await expect(items.first()).toHaveText('Session foldercommands run here')
    await stubFolderDialog(app, [one, two])
    await page.getByTestId('folder-add').click()
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toHaveText('onecommands run here')
    await expect(items.nth(1)).toHaveText('two')
    // Last time's folders are these very ones now: nothing to offer.
    const prefill = page.getByTestId('folder-prefill')
    await expect(prefill).toHaveCount(0)

    // The next task starts on its own folder, with those two offered.
    await page.getByTestId('nav-item').first().click()
    await page.getByTestId('mode-cowork').click()
    await expect(items).toHaveCount(1)
    await expect(prefill).toHaveText('Use the last 2 folders')
    await prefill.click()
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toHaveAttribute('title', one)
    await expect(items.nth(1)).toHaveAttribute('title', two)
    await expect(prefill).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a round with one approval shows one summary line, only once its last Run ends, counting both Runs (旧 222)', async () => {
  const folders = makeFolderTree('summary', {
    'ws/a.txt': 'alpha\n',
    'ws/b.txt': 'beta\n',
    'ws/c.txt': 'gamma\n',
    'outside/x.txt': 'x-ray\n',
  })
  tree = folders
  const ws = join(folders.real, 'ws')
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [
      // Run 1: a read that runs, then one outside the workspace that pauses the Run.
      callsReply(
        readCall('toolu_a', join(ws, 'a.txt')),
        readCall('toolu_x', join(folders.real, 'outside', 'x.txt')),
      ),
      // Run 2, opened by the answer: two more reads, then the reply — held open half way.
      callsReply(readCall('toolu_b', join(ws, 'b.txt')), readCall('toolu_c', join(ws, 'c.txt'))),
      {
        steps: [
          { type: 'text', text: 'All ' },
          { type: 'wait', until: hold.promise },
          { type: 'text', text: 'read.' },
        ],
        delayMs: 5,
      },
    ],
  })
  const server = fake
  const userData = makeUserDataDir('summary')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'read everything')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    await waitingApproval(page)
    // Paused: the first Run has ended, and a paused end shows neither a summary nor a card of its own.
    await expect(page.getByTestId('turn-summary')).toHaveCount(0)
    await expect(page.getByTestId('failure-card')).toHaveCount(0)

    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-allow').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('All')
    await expect(page.getByTestId('tool-row')).toHaveCount(4)
    // The second Run is still going: no summary yet.
    await expect(page.getByTestId('turn-summary')).toHaveCount(0)

    hold.resolve()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('All read.')
    const summary = page.getByTestId('turn-summary')
    await expect(summary).toHaveCount(1)
    // Four reads over both Runs, nothing changed, nothing sent out — under the round's last reply.
    await expect(summary).toHaveText('Read 4 · changed 0')
    await expect(
      page.getByTestId('assistant-message').last().getByTestId('turn-summary'),
    ).toHaveCount(1)
    await expect(page.getByTestId('failure-card')).toHaveCount(0)
    expect(server.requests).toHaveLength(3)
  } finally {
    await app.close()
  }
})

test('a tool row expands to its input and its output, both as plain text (§界面范围 ToolRow)', async () => {
  const folders = makeFolderTree('row-details', { 'ws/page.html': '<b>bold</b> {"k":1}\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const file = join(ws, 'page.html')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_page', file, { limit: 5 })), textReply('Read.')],
  })
  const server = fake
  const userData = makeUserDataDir('row-details')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'read the page')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Read.')
    const row = page.getByTestId('tool-row')
    // One sentence by default: no JSON, no output.
    await expect(row.getByTestId('tool-row-line')).toHaveText(`Read ${file}`)
    await expect(row.getByTestId('tool-row-details')).toHaveCount(0)
    await row.getByTestId('tool-row-line').click()
    const details = row.getByTestId('tool-row-details')
    // The result as the text it is: markup not rendered, JSON not parsed.
    await expect(details.locator('pre')).toHaveCount(2)
    await expect(details.locator('pre').last()).toHaveText('1\t<b>bold</b> {"k":1}')
    await expect(details.locator('b')).toHaveCount(0)
    await expect(details.locator('pre').first()).toContainText(`file_path: ${file}`)
  } finally {
    await app.close()
  }
})

/**
 * Each argument is escaped on its own (§界面范围 ToolRow「按纯文本显示」; E4): the line break between two
 * arguments is the row's own, and the newline mark shows only where an argument holds a newline.
 */
test('the expanded input marks a newline only where an argument holds one (§界面范围 ToolRow; E4)', async () => {
  // A file name may hold a newline; the model's call names it as it is.
  const folders = makeFolderTree('row-input', { 'ws/two\nlines.txt': 'alpha\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const file = join(ws, 'two\nlines.txt')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_a', file, { limit: 5 })), textReply('Read.')],
  })
  const server = fake
  const userData = makeUserDataDir('row-input')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'read a')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Read.')
    const row = page.getByTestId('tool-row')
    // The sentence escapes the same way (②′): the newline in the name is marked, then broken.
    const shown = file.replace('\n', `${NEWLINE_MARK}\n`)
    expect(await row.getByTestId('tool-row-line').textContent()).toBe(`Read ${shown}`)
    await row.getByTestId('tool-row-line').click()
    const input = row.getByTestId('tool-row-details').locator('pre').first()
    await expect(input).toBeVisible()
    // textContent, not toHaveText, which folds every run of whitespace into one space.
    expect(await input.textContent()).toBe(`file_path: ${shown}\nlimit: 5`)
  } finally {
    await app.close()
  }
})
