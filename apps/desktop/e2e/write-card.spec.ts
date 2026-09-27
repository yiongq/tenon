import { existsSync, linkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import {
  bashCall,
  callsReply,
  editCall,
  makeFolderTree,
  providerEnv,
  readCall,
  send,
  startTask,
  textReply,
  waitingApproval,
  writeCall,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * The write and irreversible cards in the real shell (spec 02 §最小审批卡, §内置工具的默认档位,
 * §作用域与授权键; plan step 22, the e2e points step 20 left for it: 旧 4, 旧 20, 旧 215, 旧 216,
 * 旧 218, 旧 222's write half; acceptance 19, 20, 36, 37). Write, Edit and Bash run their real
 * executors on the real disk; Bash through the user's own login shell (host/shell-env.ts), so the
 * one case that runs a command keeps to `rm`.
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

/** The session waiting on a card, by `approval.list`: how many rows the pending table holds. */
async function pendingRows(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    const list = (await window.tenon.invoke('approval.list', { limit: 20 })) as {
      data: unknown[]
    }
    return list.data.length
  })
}

/** A file's content, or null while it does not exist. */
function contentOf(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

test('a Write card outlives a restart as one card, and 「允许」 then writes the file on the paused Run’s model, its result under the original call (旧 4, acceptance 19)', async () => {
  const folders = makeFolderTree('write-restart', { 'ws/a.txt': 'alpha\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const file = join(ws, 'new.txt')
  fake = await startFakeAnthropic({
    replies: [callsReply(writeCall('toolu_w', file, 'hello\n')), textReply('Written.')],
  })
  const server = fake
  const userData = makeUserDataDir('write-restart')
  seedConfig(userData, { locale: 'en' })

  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  let requestId: string
  let callKey: string
  try {
    const { app, page } = first
    await startTask(app, page, ws)
    await send(page, 'write new.txt')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    const pending = await waitingApproval(page)
    requestId = pending.card.requestId
    callKey = pending.callKey
    await expect(card).toHaveAttribute('data-request-id', requestId)
    await expect(card.getByTestId('approval-title')).toHaveText('Change this file?')
    expect(pending.card.target).toEqual({ type: 'path', path: file })
    // Nothing is written before the answer.
    expect(contentOf(file)).toBeNull()
  } finally {
    await first.app.close()
  }

  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { page } = second
    // The same card, once, under the same call's row.
    const row = page.locator(`[data-testid="tool-row"][data-call-key="${callKey}"]`)
    const card = row.getByTestId('approval-card')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await expect(card).toHaveAttribute('data-request-id', requestId)
    expect(contentOf(file)).toBeNull()
    expect(server.requests).toHaveLength(1)

    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-allow').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Written.')
    expect(contentOf(file)).toBe('hello\n')
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    await expect(row.getByTestId('approval-answered')).toHaveText(`Allowed · This session${file}`)
    // The resumed request went to the paused Run's provider (this fake endpoint) and model, with the
    // Write's result in it.
    const bodies = server.requests.map((request) => request.body as { model: string })
    expect(bodies).toHaveLength(2)
    expect(bodies[1]?.model).toBe(bodies[0]?.model)
    const resumed = JSON.stringify(bodies[1])
    expect(resumed).toContain('"tool_use_id":"toolu_w"')
    expect(resumed).toContain(`Created ${file}.`)
    // The result hangs under the call the card was for: the same key, `<runId>:<requestSeq>:<i>` of
    // the paused Run, not a new row of the resumed one.
    await expect(page.getByTestId('tool-row')).toHaveCount(1)
    await row.getByTestId('tool-row-line').click()
    await expect(row.getByTestId('tool-row-details').locator('pre').last()).toHaveText(
      `Created ${file}.`,
    )
    const calls = await page.evaluate(async () => {
      const latest = (await window.tenon.invoke('session.latest', { limit: 50 })) as {
        data: { messages: Array<{ calls?: Array<{ callKey: string; outcome: unknown }> }> }
      }
      return latest.data.messages.flatMap((message) => message.calls ?? [])
    })
    expect(calls.map((call) => call.callKey)).toEqual([callKey])
    expect(calls[0]?.outcome).toMatchObject({ state: 'completed' })
  } finally {
    await second.app.close()
  }
})

test('two writes in one reply: the second waits as a 「排队中」 row, then becomes a card whose first clicks are ignored (旧 20, acceptance 20)', async () => {
  const folders = makeFolderTree('two-writes', { 'ws/keep.txt': 'keep\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const a = join(ws, 'a.txt')
  const b = join(ws, 'b.txt')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(writeCall('toolu_a', a, 'A\n'), writeCall('toolu_b', b, 'B\n')),
      textReply('Both ', 'written.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('two-writes')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'write a and b')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    const first = await waitingApproval(page)
    expect(first.card.target).toEqual({ type: 'path', path: a })
    // One row in the pending table; the second write is a queued row under the card, with nothing
    // to answer, and no row of its own.
    expect(await pendingRows(page)).toBe(1)
    const queued = card.locator('..').getByTestId('approval-queued-row')
    await expect(queued).toHaveCount(1)
    await expect(queued).toHaveText(`${b}排队中`)
    await expect(queued.locator('button')).toHaveCount(0)
    await expect(page.getByTestId('tool-row')).toHaveCount(1)

    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-allow').click()
    // a is written; b's card comes up under its own row, a new requestId.
    const rows = page.getByTestId('tool-row')
    const next = rows.nth(1).getByTestId('approval-card')
    await expect(next).toHaveCount(1)
    await expect(next).not.toHaveAttribute('data-request-id', first.card.requestId)
    expect(contentOf(a)).toBe('A\n')
    await expect(page.getByTestId('approval-queued-row')).toHaveCount(0)
    // At once, inside APPROVAL_CLICK_GUARD_MS of it appearing: ignored.
    await next.getByTestId('approval-allow').click()
    await page.waitForTimeout(150)
    await expect(next).toHaveCount(1)
    await expect(rows.nth(1).getByTestId('approval-answered')).toHaveCount(0)
    expect(contentOf(b)).toBeNull()
    expect(server.requests).toHaveLength(1)

    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await next.getByTestId('approval-allow').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Both written.')
    expect(contentOf(b)).toBe('B\n')
    await expect(page.getByTestId('approval-answered')).toHaveCount(2)
    expect(server.requests).toHaveLength(2)
  } finally {
    await app.close()
  }
})

test('two writes in one reply: denying the first turns the stacked row 「未执行」, and neither file is written (旧 20)', async () => {
  const folders = makeFolderTree('two-writes-deny', { 'ws/keep.txt': 'keep\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const a = join(ws, 'a.txt')
  const b = join(ws, 'b.txt')
  fake = await startFakeAnthropic({
    replies: [callsReply(writeCall('toolu_a', a, 'A\n'), writeCall('toolu_b', b, 'B\n'))],
  })
  const server = fake
  const userData = makeUserDataDir('two-writes-deny')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'write a and b')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    await expect(card.locator('..').getByTestId('approval-queued-row')).toHaveText(`${b}排队中`)
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-deny').click()

    await expect(page.getByTestId('failure-card')).toHaveAttribute('data-code', 'user-rejected')
    await expect(card).toHaveCount(0)
    const rows = page.getByTestId('tool-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.first().getByTestId('approval-answered')).toHaveAttribute(
      'data-outcome',
      'denied',
    )
    await expect(rows.nth(1).getByTestId('tool-row-closure')).toHaveText('未执行')
    await expect(page.getByTestId('approval-queued-row')).toHaveCount(0)
    expect(contentOf(a)).toBeNull()
    expect(contentOf(b)).toBeNull()
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('a workspace Write card: the path, the change collapsed and then plain text, 「本会话」 by 「允许」; the same file’s next Write asks nothing, an Edit of it does (旧 215, acceptance 36)', async () => {
  const folders = makeFolderTree('write-card', { 'ws/keep.txt': 'keep\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  // Through the link, as the model may write it: the card names the real path.
  const asked = join(folders.link, 'ws', 'notes.txt')
  const file = join(ws, 'notes.txt')
  const content = 'line one\n<b>two</b> {"k":1}\n'
  fake = await startFakeAnthropic({
    replies: [
      callsReply(writeCall('toolu_w1', asked, content)),
      // The Run the answer opened: the same file again, then an Edit of it.
      callsReply(writeCall('toolu_w2', file, 'v2\n')),
      callsReply(editCall('toolu_e', file, 'v2', 'v3')),
      textReply('Done.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('write-card')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'write the notes')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    await expect(card.getByTestId('approval-title')).toHaveText('修改这个文件？')
    await expect(card.getByTestId('approval-object')).toHaveText(file)
    await expect(card.getByTestId('approval-reason')).toHaveText('Write 需要你批准。')
    await expect(card.getByTestId('approval-irreversible')).toHaveCount(0)
    // 「本会话」 beside 「允许」: this file, this session.
    await expect(card.getByTestId('approval-scope')).toHaveText('本会话')
    expect((await waitingApproval(page)).allowScope).toBe('session')
    // The change starts collapsed.
    const toggle = card.getByTestId('approval-change-toggle')
    await expect(toggle).toHaveText('展开改动')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(card.getByTestId('approval-input')).toHaveCount(0)
    await toggle.click()
    // Expanded: the content as the text it is — no JSON around it, markup not rendered, each
    // newline marked (②′). textContent, as toHaveText folds whitespace.
    const text = card.getByTestId('approval-change-text')
    await expect(text).toHaveCount(1)
    expect(await text.textContent()).toBe('line one⏎\n<b>two</b> {"k":1}⏎\n')
    await expect(card.getByTestId('approval-input').locator('b')).toHaveCount(0)
    await expect(card.getByTestId('approval-change-label')).toHaveCount(0)
    expect(contentOf(file)).toBeNull()

    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-allow').click()
    const rows = page.getByTestId('tool-row')
    // The next Write of the same file runs without a card; the Edit of it asks (the grant is
    // Write's, for this file).
    const edit = rows.nth(2).getByTestId('approval-card')
    await expect(edit).toHaveCount(1)
    expect(contentOf(file)).toBe('v2\n')
    await expect(rows.first().getByTestId('approval-answered')).toHaveText(`已允许 · 本会话${file}`)
    await expect(rows.nth(1).getByTestId('approval-answered')).toHaveCount(0)
    await expect(rows.nth(1).getByTestId('approval-card')).toHaveCount(0)
    await expect(rows.nth(1).getByTestId('tool-row-closure')).toHaveCount(0)

    // The Edit's change: old_string and new_string, each under its label.
    await expect(edit.getByTestId('approval-scope')).toHaveText('本会话')
    await edit.getByTestId('approval-change-toggle').click()
    await expect(edit.getByTestId('approval-change-label')).toHaveText(['把这段', '改成'])
    await expect(edit.getByTestId('approval-change-text')).toHaveText(['v2', 'v3'])
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await edit.getByTestId('approval-allow').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Done.')
    expect(contentOf(file)).toBe('v3\n')
    await expect(page.getByTestId('approval-answered')).toHaveCount(2)
    expect(server.requests).toHaveLength(4)
  } finally {
    await app.close()
  }
})

test('a Bash that deletes a file asks on an irreversible card: ⏎ anywhere in it denies, only a click or Space on 「允许」 runs it, just this once (旧 216, acceptance 36)', async () => {
  test.setTimeout(120_000)
  const folders = makeFolderTree('irreversible', { 'ws/a.txt': 'alpha\n', 'ws/b.txt': 'beta\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const a = join(ws, 'a.txt')
  const b = join(ws, 'b.txt')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(bashCall('toolu_1', 'rm a.txt')),
      callsReply(bashCall('toolu_2', 'rm a.txt')),
      callsReply(bashCall('toolu_3', 'rm a.txt')),
      // The Run the third answer opened: another delete, then the reply.
      callsReply(bashCall('toolu_4', 'rm b.txt')),
      textReply('Removed.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('irreversible')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    const card = page.getByTestId('approval-card')
    const rowOf = async (): Promise<ReturnType<Page['locator']>> =>
      page.locator(
        `[data-testid="tool-row"][data-call-key="${(await waitingApproval(page)).callKey}"]`,
      )

    // ① ⏎ on 「允许」 denies.
    await send(page, 'delete a')
    await expect(card).toHaveCount(1)
    await expect(card.getByTestId('approval-title')).toHaveText('运行这条命令？')
    await expect(card.getByTestId('approval-object')).toHaveText(`rm a.txt位于 ${ws}`)
    await expect(card.getByTestId('approval-reason')).toHaveText(
      `每条命令都先问：在 ${ws} 运行 rm a.txt。`,
    )
    // The sentence of its own, and the buttons 「拒绝 ⏎ Esc」「允许」, the second with no key hint.
    await expect(card.getByTestId('approval-irreversible')).toHaveText('撤不回。')
    await expect(card.getByTestId('approval-deny')).toHaveText('拒绝⏎ Esc')
    await expect(card.getByTestId('approval-allow')).toHaveText('允许')
    await expect(card.getByTestId('approval-allow-keys')).toHaveCount(0)
    await expect(card.getByTestId('approval-scope')).toHaveText('只这一次')
    // No change to show: the command on the object line is the whole of it.
    await expect(card.getByTestId('approval-change-toggle')).toHaveCount(0)
    const pending = await waitingApproval(page)
    expect(pending.allowScope).toBe('once')
    expect(pending.card.target).toEqual({ type: 'command', command: 'rm a.txt', cwd: ws })
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    // Focus coming into the card from after it reaches 「允许」 first, and lands on 「拒绝」.
    await page.getByTestId('composer-input').focus()
    for (let step = 0; step < 12; step += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one key at a time, until focus is in the card
      await page.keyboard.press('Shift+Tab')
      // oxlint-disable-next-line no-await-in-loop -- see above
      if (await card.evaluate((element) => element.contains(document.activeElement))) break
    }
    await expect(card.getByTestId('approval-deny')).toBeFocused()
    // From its row, before it, too.
    const row = await rowOf()
    await row.getByTestId('tool-row-line').focus()
    await page.keyboard.press('Tab')
    await expect(card.getByTestId('approval-deny')).toBeFocused()
    // Moved inside the card, the focus stays on 「允许」; ⏎ there still denies.
    await page.keyboard.press('Tab')
    await expect(card.getByTestId('approval-allow')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(row.getByTestId('approval-answered')).toHaveAttribute('data-outcome', 'denied')
    await expect(page.getByTestId('failure-card')).toHaveAttribute('data-code', 'user-rejected')
    expect(contentOf(a)).toBe('alpha\n')

    // ② ⏎ on the card itself denies.
    await send(page, 'delete a, please')
    await expect(card).toHaveCount(1)
    const second = await rowOf()
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-title').click()
    await expect(card).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(second.getByTestId('approval-answered')).toHaveAttribute('data-outcome', 'denied')
    expect(contentOf(a)).toBe('alpha\n')
    expect(server.requests).toHaveLength(2)

    // ③ A click on 「允许」 runs it.
    await send(page, 'delete a, really')
    await expect(card).toHaveCount(1)
    const third = await rowOf()
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-allow').click()
    await expect(third.getByTestId('approval-answered')).toHaveText(
      `已允许 · 只这一次rm a.txt位于 ${ws}`,
    )
    await expect.poll(() => contentOf(a)).toBeNull()

    // ④ Space on 「允许」 runs the next one.
    const fourthRow = page.locator('[data-testid="tool-row"]', { has: card })
    await expect(card).toHaveCount(1)
    await expect(card.getByTestId('approval-object')).toHaveText(`rm b.txt位于 ${ws}`)
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await fourthRow.getByTestId('tool-row-line').focus()
    await page.keyboard.press('Tab')
    await expect(card.getByTestId('approval-deny')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(card.getByTestId('approval-allow')).toBeFocused()
    await page.keyboard.press('Space')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Removed.')
    expect(contentOf(b)).toBeNull()
    await expect(page.getByTestId('approval-answered').last()).toHaveText(
      `已允许 · 只这一次rm b.txt位于 ${ws}`,
    )
    expect(server.requests).toHaveLength(5)
  } finally {
    await app.close()
  }
})

test('a Write card writes a right-to-left override in the file name as a visible \\u{202E}, character for character (旧 218, ②′)', async () => {
  const folders = makeFolderTree('write-rlo', { 'ws/keep.txt': 'keep\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  // Drawn as is, the override would turn the rest around: «reportexe.txt» reads as a text file.
  const file = join(ws, 'report‮txt.exe')
  fake = await startFakeAnthropic({ replies: [callsReply(writeCall('toolu_r', file, 'x\n'))] })
  const server = fake
  const userData = makeUserDataDir('write-rlo')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'write the report')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    const pending = await waitingApproval(page)
    expect(pending.card.target).toEqual({ type: 'path', path: file })
    const shown = await card.getByTestId('approval-object').textContent()
    expect(shown).toBe(join(ws, 'report\\u{202E}txt.exe'))
    // Character for character: every character of the requested path is on the line, and the one
    // a font does not draw is its escape; nothing else differs.
    expect(shown?.replaceAll('\\u{202E}', '‮')).toBe(file)
    expect(shown).not.toContain('‮')
    await expect(page.getByTestId('tool-row-line')).toHaveText(`Write ${shown ?? ''}`)
  } finally {
    await app.close()
  }
})

test('a round with a write allowed and reads after it shows one summary line, after its last Run, counting both Runs (旧 222 write half, acceptance 37)', async () => {
  const folders = makeFolderTree('write-summary', {
    'ws/a.txt': 'alpha\n',
    'ws/b.txt': 'beta\n',
    'ws/c.txt': 'gamma\n',
  })
  tree = folders
  const ws = join(folders.real, 'ws')
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [
      // Run 1: a read, then a write that pauses it.
      callsReply(
        readCall('toolu_a', join(ws, 'a.txt')),
        writeCall('toolu_w', join(ws, 'w.txt'), 'w\n'),
      ),
      // Run 2, opened by the answer: two more reads, then the reply, held open half way.
      callsReply(readCall('toolu_b', join(ws, 'b.txt')), readCall('toolu_c', join(ws, 'c.txt'))),
      {
        steps: [
          { type: 'text', text: 'All ' },
          { type: 'wait', until: hold.promise },
          { type: 'text', text: 'done.' },
        ],
        delayMs: 5,
      },
    ],
  })
  const server = fake
  const userData = makeUserDataDir('write-summary')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'read, write, read')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    await waitingApproval(page)
    // Paused: no summary.
    await expect(page.getByTestId('turn-summary')).toHaveCount(0)

    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-allow').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('All')
    await expect(page.getByTestId('tool-row')).toHaveCount(4)
    // The second Run is still going: no summary yet.
    await expect(page.getByTestId('turn-summary')).toHaveCount(0)

    hold.resolve()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('All done.')
    const summary = page.getByTestId('turn-summary')
    await expect(summary).toHaveCount(1)
    // Three reads and the write, over both Runs, under the round's last reply.
    await expect(summary).toHaveText('Read 3 · changed 1')
    await expect(
      page.getByTestId('assistant-message').last().getByTestId('turn-summary'),
    ).toHaveCount(1)
    expect(contentOf(join(ws, 'w.txt'))).toBe('w\n')
    expect(server.requests).toHaveLength(3)
  } finally {
    await app.close()
  }
})

/**
 * The hard-link baseline plan step 11 left for the Write executor (旧 51: 「硬链接写入只记回归基线、
 * 不断言拦下」; D8's known limitation, listed in the step 35 audit): a hard link inside the workspace
 * to a file outside it is a file inside — `realpath` cannot tell the two names apart — so it asks as
 * any workspace write does, and the write lands in the outside file. This records today's behaviour;
 * it is not the behaviour wanted, and a change that blocks or asks differently should update it.
 */
test('a hard link in the workspace to a file outside it: today it asks as a workspace write, and the write reaches the outside file (regression baseline, 旧 51)', async () => {
  const folders = makeFolderTree('hard-link', {
    'ws/keep.txt': 'keep\n',
    'outside/secret.txt': 'outside-original\n',
  })
  tree = folders
  const ws = join(folders.real, 'ws')
  const outside = join(folders.real, 'outside', 'secret.txt')
  const linked = join(ws, 'linked.txt')
  linkSync(outside, linked)
  fake = await startFakeAnthropic({
    replies: [callsReply(writeCall('toolu_h', linked, 'written-through\n')), textReply('Written.')],
  })
  const server = fake
  const userData = makeUserDataDir('hard-link')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'write through the link')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    const pending = await waitingApproval(page)
    // Baseline: judged inside (reason default, this session), named by the link's own path.
    expect(pending.card.reason).toBe('default')
    expect(pending.card.target).toEqual({ type: 'path', path: linked })
    expect(pending.allowScope).toBe('session')
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-allow').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Written.')
    // Baseline: one file under two names, written in place.
    expect(contentOf(outside)).toBe('written-through\n')
    expect(contentOf(linked)).toBe('written-through\n')
  } finally {
    await app.close()
  }
})
