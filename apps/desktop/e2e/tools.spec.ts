import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import { routeCalls } from './helpers/navigation.js'
import {
  bashCall,
  callsReply,
  editCall,
  makeFolderTree,
  providerEnv,
  readCall,
  send,
  startTask,
  stubFolderDialog,
  textReply,
  waitingApproval,
  writeCall,
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

test('presentation-r1 验收 5: a protected task Read has one line and no way to allow it (旧 222)', async () => {
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
    // The receipt only explains why; the object is already on the row.
    await expect(notice).toHaveText("This location is protected; Tenon doesn't read it.")
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

test('presentation-r1 验收 5: a chat Read has its own one-line receipt (旧 222, open question 13)', async () => {
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
    await expect(page.getByTestId('folder-toggle')).toHaveAttribute('aria-checked', 'false')
    await send(page, 'read my notes')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Blocked.')
    const notice = page.getByTestId('tool-row').getByTestId('blocked-notice')
    await expect(notice).toHaveAttribute('data-source', 'protected')
    await expect(notice).toHaveText('对话里只能打开 Tenon 为这个对话保存的文件。')
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    expect(JSON.stringify(server.requests[1]?.body)).not.toContain('CHAT-NOTE-7731')
  } finally {
    await app.close()
  }
})

test('presentation-r1 验收 5: the row escapes its path, the receipt does not repeat it, and the first message fixes the mode', async () => {
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
    await expect(page.getByTestId('folder-toggle')).toHaveAttribute('aria-checked', 'false')
    await send(page, 'read my notes')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Blocked.')
    // The row retains the escaped object; the receipt explains why without repeating it.
    await expect(page.getByTestId('tool-row-line')).toHaveText(`Read ${shown}`)
    await expect(page.getByTestId('blocked-notice')).toHaveText(
      'In a chat, only files Tenon saved for this chat can be opened.',
    )
    // That message established the chat: the toggle is gone.
    await expect(page.getByTestId('folder-toggle')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('presentation-r1 验收 10: a task’s folders are picked and removed in the popover, commands run in the first, and prefill joins only when clicked', async () => {
  const folders = makeFolderTree('folders', { 'one/a.txt': 'a\n', 'two/b.txt': 'b\n' })
  tree = folders
  const one = join(folders.real, 'one')
  const two = join(folders.real, 'two')
  const userData = makeUserDataDir('folders')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  try {
    await page.getByTestId('folder-toggle').click()
    const chip = page.getByTestId('folder-chip')
    await expect(chip).toHaveText('Session folder')
    await chip.click()
    const items = page.getByTestId('folder-item')
    await expect(items).toHaveCount(1)
    await expect(items.first().getByTestId('folder-cwd')).toHaveText('commands run here')
    await expect(page.getByTestId('folder-dedicated-note')).toHaveText(
      'With no folder picked, commands run in a folder Tenon creates just for this task.',
    )
    await expect(page.getByTestId('folder-remove')).toHaveCount(0)
    await stubFolderDialog(app, [one, two])
    await page.getByTestId('folder-add').click()
    await expect(items).toHaveCount(2)
    await expect(chip).toHaveText('one+1')
    await expect(chip).toHaveAttribute('title', `${one}\n${two}`)
    await expect(chip).toHaveAccessibleName(`${one} ${two}`)
    await expect(items.nth(0).getByTestId('folder-path')).toHaveText(one)
    await expect(items.nth(0).getByTestId('folder-cwd')).toHaveText('commands run here')
    await expect(items.nth(1).getByTestId('folder-path')).toHaveText(two)
    await expect(items.nth(1).getByTestId('folder-cwd')).toHaveCount(0)
    const prefill = page.getByTestId('folder-prefill')
    await expect(prefill).toHaveCount(0)

    await page.keyboard.press('Escape')
    await page.getByTestId('nav-item').first().click()
    await page.getByTestId('folder-toggle').click()
    await expect(page.getByTestId('folder-popover')).toBeVisible()
    await expect(items).toHaveCount(1)
    await expect(page.getByTestId('folder-prefill-path')).toHaveText([one, two])
    await expect(prefill).toHaveText('Use these 2 folders')
    await expect(chip).toHaveText('Session folder')
    await prefill.click()
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toHaveAttribute('title', one)
    await expect(items.nth(1)).toHaveAttribute('title', two)
    await expect(prefill).toHaveCount(0)
    await items.nth(0).getByTestId('folder-remove').click()
    await expect(items).toHaveCount(1)
    await expect(items.first().getByTestId('folder-path')).toHaveText(two)
    await expect(items.first().getByTestId('folder-cwd')).toHaveText('commands run here')
    await expect(chip).toHaveText('two')
    await items.first().getByTestId('folder-remove').click()
    await expect(chip).toHaveText('Session folder')
    await expect(page.getByTestId('folder-dedicated-note')).toBeVisible()
    await expect(page.getByTestId('folder-remove')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('presentation-r1 验收 10: turning the toggle on opens the popover with each prefilled path in full before 用这 N 个文件夹; focus stays on the toggle; nothing joins the list until it is clicked', async () => {
  const folders = makeFolderTree('prefill-paths', { 'first/a.txt': 'a\n', 'second/b.txt': 'b\n' })
  tree = folders
  const paths = [join(folders.real, 'first'), join(folders.real, 'second')]
  const userData = makeUserDataDir('prefill-paths')
  seedConfig(userData, { locale: 'zh-CN' })
  writeFileSync(
    configPathIn(userData),
    JSON.stringify({ locale: 'zh-CN', lastWorkspaceFolders: paths }),
  )
  const { app, page } = await launchTenon({ userData, env: { TENON_E2E_ROUTE_COUNTS: '1' } })
  try {
    const toggle = page.getByTestId('folder-toggle')
    await toggle.focus()
    await toggle.press('Space')
    const popup = page.getByTestId('folder-popover')
    await expect(popup).toBeVisible()
    await expect(toggle).toBeFocused()
    await expect(page.getByTestId('folder-prefill-path')).toHaveText(paths)
    await expect(page.getByText('上次用过，尚未加入', { exact: true })).toBeVisible()
    await expect(page.getByTestId('folder-prefill')).toHaveText('用这 2 个文件夹')
    await expect(page.getByTestId('folder-item')).toHaveCount(1)
    await expect(page.getByTestId('folder-chip')).toHaveText('专用文件夹')
    const pathBottoms = await page
      .getByTestId('folder-prefill-path')
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().bottom))
    const confirm = await page.getByTestId('folder-prefill').boundingBox()
    for (const bottom of pathBottoms) expect(bottom).toBeLessThanOrEqual(confirm!.y)
    // Merely closing and reopening the offer never confirms it.
    await expect.poll(() => routeCalls(app, 'workspace.usePrefill')).toBe(0)
    await expect(toggle).toBeFocused()
    await page.keyboard.press('Escape')
    await page.getByTestId('folder-chip').click()
    await expect(page.getByTestId('folder-prefill-path')).toHaveText(paths)
    expect(await routeCalls(app, 'workspace.usePrefill')).toBe(0)
    await expect(page.getByTestId('folder-item')).toHaveCount(1)
    await page.getByTestId('folder-prefill').click()
    await expect(page.getByTestId('folder-item')).toHaveCount(2)
    await expect(page.getByTestId('folder-path')).toHaveText(paths)
    await expect(page.getByTestId('folder-prefill')).toHaveCount(0)
    expect(await routeCalls(app, 'workspace.usePrefill')).toBe(1)
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
    await expect(summary).toHaveText('Read 4 files')
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

test('presentation-r1 验收 6: only an irreversible row carries the marker, with its tooltip and screen-reader text', async () => {
  const folders = makeFolderTree('irreversible-marker', { 'ws/victim.txt': 'temporary fixture' })
  tree = folders
  const ws = join(folders.real, 'ws')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(bashCall('toolu_rm', `rm ${join(ws, 'victim.txt')}`)),
      textReply('removed'),
    ],
  })
  const userData = makeUserDataDir('irreversible-marker')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'remove the temporary fixture')
    await expect(page.getByTestId('approval-card')).toBeVisible()
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await page.getByTestId('approval-allow').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('removed')
    const marker = page.getByTestId('tool-effect-marker')
    await expect(marker).toBeVisible()
    await expect(marker.locator('.sr-only')).toHaveText("Can't be undone")
    const line = await page.getByTestId('tool-row-line').boundingBox()
    const box = await marker.boundingBox()
    expect(Math.abs(line!.x + line!.width - (box!.x + box!.width))).toBeLessThan(1)
    await marker.hover()
    await expect(page.getByRole('tooltip')).toHaveText("Can't be undone")
    await page.getByTestId('tool-row-line').click()
    await expect(page.getByTestId('tool-side-effects')).toHaveText(
      'Ran this command · This can’t be undone.',
    )
  } finally {
    await app.close()
  }
})

test('presentation-r1 验收 6: an Edit that came back with an error does not say 改了', async () => {
  const folders = makeFolderTree('write-effect', { 'ws/a.txt': 'before' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const file = join(ws, 'a.txt')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(writeCall('toolu_write', file, 'after')),
      textReply('written'),
      callsReply(editCall('toolu_bad_edit', file, 'missing old string', 'replacement')),
      textReply('edit failed'),
    ],
  })
  const userData = makeUserDataDir('write-effect')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'write the file')
    await expect(page.getByTestId('approval-card')).toBeVisible()
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await page.getByTestId('approval-allow').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('written')
    const written = page.getByTestId('tool-row').first()
    await written.getByTestId('tool-row-line').click()
    // Exercises the real Write outcome, rather than injecting a local result.
    await expect(written.getByTestId('tool-side-effects')).toHaveText(
      "Changed this file · Tenon can't undo this change for you.",
    )
    await send(page, 'try the edit')
    // Edit has its own session grant, separate from Write's.
    await expect(page.getByTestId('approval-card')).toBeVisible()
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await page.getByTestId('approval-allow').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('edit failed')
    const failed = page.getByTestId('tool-row').last()
    await failed.getByTestId('tool-row-line').click()
    const failedCallKey = await failed.getAttribute('data-call-key')
    // The persisted flag lives on this call's outcome, as in the live view. session.latest has
    // message rows, not the tool-response blocks assembled for provider replay.
    await expect
      .poll(async () =>
        page.evaluate(async (callKey) => {
          const current = (await window.tenon.invoke('session.latest', { limit: 1000 })) as {
            ok: boolean
            data: {
              messages: {
                calls?: { callKey: string; outcome: { isError?: boolean } | null }[]
              }[]
            } | null
          }
          return (
            current.ok &&
            current.data?.messages.some((row) =>
              row.calls?.some((call) => call.callKey === callKey && call.outcome?.isError === true),
            )
          )
        }, failedCallKey),
      )
      .toBe(true)
    await expect(failed.getByTestId('tool-row-details')).toBeVisible()
    await expect(failed.getByTestId('tool-side-effects')).toHaveCount(0)
    await expect(written.getByTestId('tool-side-effects')).toBeVisible()
  } finally {
    await app.close()
  }
})
