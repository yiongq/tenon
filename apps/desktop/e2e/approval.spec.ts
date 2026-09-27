import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { COUNT_ROUTES, routeCalls } from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import {
  callsReply,
  makeFolderTree,
  providerEnv,
  pushesOf,
  readCall,
  recordPushes,
  redeliver,
  send,
  startTask,
  textReply,
  waitingApproval,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * The minimal approval card in the real shell (spec 02 §最小审批卡; plan step 20: 旧 214, 旧 97,
 * 旧 21 e2e): a task-profile Read outside the workspace stops on a card under its own ToolRow, the
 * answer collapses it, and the collapsed line is redrawn from the Tape after a restart. Also the
 * queued rows and the click guard (F6), Esc and the default focus (H3), and an allow the
 * re-judgement tightens into a block (F3).
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

const COPY = {
  'zh-CN': {
    read: (path: string) => `读取 ${path}`,
    reason: (path: string, workspace: string) => `${path} 在工作区（${workspace}）之外。`,
    once: '只这一次',
    allowed: '已允许 · 只这一次',
    hint: '发送会取消上面待批的操作。',
  },
  en: {
    read: (path: string) => `Read ${path}`,
    reason: (path: string, workspace: string) => `${path} is outside the workspace (${workspace}).`,
    once: 'Just this once',
    allowed: 'Allowed · Just this once',
    hint: 'Sending cancels the operation waiting above.',
  },
} as const

for (const locale of ['zh-CN', 'en'] as const) {
  test(`a Read outside the workspace asks under its own row, collapses once allowed, and is redrawn after a restart (旧 214, ${locale})`, async () => {
    const copy = COPY[locale]
    const folders = makeFolderTree('outside-read', {
      'ws/a.txt': 'alpha\n',
      'outside/secret.txt': 'secret-line\n',
    })
    tree = folders
    // Both paths as the model writes them: through the link. What the card shows is the real one.
    const inside = join(folders.link, 'ws', 'a.txt')
    const outside = join(folders.link, 'outside', 'secret.txt')
    const realOutside = join(folders.real, 'outside', 'secret.txt')
    const realWorkspace = join(folders.real, 'ws')
    fake = await startFakeAnthropic({
      replies: [
        callsReply(readCall('toolu_inside', inside), readCall('toolu_outside', outside)),
        textReply('Both ', 'read.'),
      ],
    })
    const server = fake
    const userData = makeUserDataDir('outside-read')
    seedConfig(userData, { locale })

    const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
    let anchor: string
    try {
      const { page } = first
      await startTask(first.app, page, join(folders.link, 'ws'))
      await send(page, 'read both files')

      const card = page.getByTestId('approval-card')
      await expect(card).toHaveCount(1)
      const pending = await waitingApproval(page)
      anchor = pending.anchorCallKey
      // A call of the main session: its own row is the anchor.
      expect(pending.callKey).toBe(anchor)
      expect(pending.allowScope).toBe('once')

      // Under the row whose callKey is the anchor — the outside read, not the one before it.
      const rows = page.getByTestId('tool-row')
      await expect(rows).toHaveCount(2)
      const anchored = page.locator(`[data-testid="tool-row"][data-call-key="${anchor}"]`)
      await expect(anchored.getByTestId('tool-row-line')).toHaveText(copy.read(outside))
      await expect(anchored.getByTestId('approval-card')).toHaveCount(1)
      await expect(rows.first().getByTestId('approval-card')).toHaveCount(0)
      // The workspace root sits under a link, and so does the path the model gave: the read inside
      // it ran without asking, and the card names the file by its real path.
      await expect(rows.first().getByTestId('tool-row-line')).toHaveText(copy.read(inside))
      await expect(anchored.getByTestId('approval-object')).toHaveText(realOutside)
      await expect(anchored.getByTestId('approval-reason')).toHaveText(
        copy.reason(realOutside, realWorkspace),
      )
      await expect(anchored.getByTestId('approval-scope')).toHaveText(copy.once)
      // Nothing of the outside file went out yet: one request so far.
      expect(server.requests).toHaveLength(1)

      await page.waitForTimeout(PAST_CLICK_GUARD_MS)
      await anchored.getByTestId('approval-allow').click()
      // One line: the result and the scope, then the path.
      const answered = anchored.getByTestId('approval-answered')
      await expect(answered).toHaveAttribute('data-outcome', 'allowed')
      await expect(answered).toHaveText(`${copy.allowed}${realOutside}`)
      await expect(page.getByTestId('approval-card')).toHaveCount(0)
      // The resumed Run read the file and sent it on.
      await expect(page.getByTestId('assistant-text').last()).toHaveText('Both read.')
      expect(server.requests).toHaveLength(2)
      expect(JSON.stringify(server.requests[1]?.body)).toContain('secret-line')
    } finally {
      await first.app.close()
    }

    const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
    try {
      const { page } = second
      // Restored from the Tape: the same row by its callKey, the same collapsed line.
      const anchored = page.locator(`[data-testid="tool-row"][data-call-key="${anchor}"]`)
      const answered = anchored.getByTestId('approval-answered')
      await expect(answered).toHaveAttribute('data-outcome', 'allowed')
      await expect(answered).toHaveText(`${copy.allowed}${realOutside}`)
      await expect(page.getByTestId('approval-card')).toHaveCount(0)
      await expect(page.getByTestId('approval-answered')).toHaveCount(1)
    } finally {
      await second.app.close()
    }
  })
}

test('one card per requestId: a redelivery neither doubles it nor re-arms it, and after the answer brings nothing back (旧 97)', async () => {
  test.setTimeout(90_000)
  const folders = makeFolderTree('redeliver', { 'ws/a.txt': 'alpha\n', 'outside/b.txt': 'beta\n' })
  tree = folders
  const outside = join(folders.real, 'outside', 'b.txt')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_b', outside)), textReply('Done ', 'reading.')],
  })
  const server = fake
  const userData = makeUserDataDir('redeliver')
  seedConfig(userData, { locale: 'en' })

  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  let requestId: string
  try {
    const { app, page } = first
    await startTask(app, page, join(folders.real, 'ws'))
    await recordPushes(app)
    await send(page, 'read b')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    const pending = await waitingApproval(page)
    requestId = pending.card.requestId
    await expect(page.getByTestId('approval-card')).toHaveAttribute('data-request-id', requestId)
    // The kernel delivered it once when the pause committed, and the renderer pulled it on `paused`.
    const delivered = await pushesOf<{ requestId: string }>(app, 'confirm.request')
    expect(delivered.map((card) => card.requestId)).toEqual([requestId])
  } finally {
    await first.app.close()
  }

  // A restart delivers it again (startup recovery step 3, before the window can hear it) and the
  // restored session pulls it: still one card, the same requestId.
  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { app, page } = second
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    await expect(card).toHaveAttribute('data-request-id', requestId)
    const pending = await waitingApproval(page)
    expect(pending.card.requestId).toBe(requestId)

    // Well past the click guard of its first arrival; then the same card arrives twice more.
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await redeliver(app, pending.card)
    await redeliver(app, pending.card)
    await page.waitForTimeout(100)
    await expect(card).toHaveCount(1)
    await expect(card).toHaveAttribute('data-request-id', requestId)
    // Not a new card, so the guard a new one gets is not armed again: this click answers it.
    await card.getByTestId('approval-allow').click()
    const answered = page.getByTestId('approval-answered')
    await expect(answered).toHaveAttribute('data-outcome', 'allowed')
    await expect(answered).toHaveText(`Allowed · Just this once${outside}`)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Done reading.')
    // The resumed Run went to the same provider and model as the paused one.
    const bodies = server.requests.map((request) => request.body as { model: string })
    expect(bodies).toHaveLength(2)
    expect(bodies[1]?.model).toBe(bodies[0]?.model)

    // Answered: the same requestId again brings no card back, and the line stays collapsed.
    await redeliver(app, pending.card)
    await page.waitForTimeout(300)
    await expect(card).toHaveCount(0)
    await expect(answered).toHaveCount(1)
    await expect(answered).toHaveText(`Allowed · Just this once${outside}`)
    expect(server.requests).toHaveLength(2)
  } finally {
    await second.app.close()
  }
})

test('with a card waiting the composer warns that sending cancels it, and sending does (旧 21)', async () => {
  const folders = makeFolderTree('supersede', { 'ws/a.txt': 'alpha\n', 'outside/c.txt': 'gamma\n' })
  tree = folders
  const outside = join(folders.real, 'outside', 'c.txt')
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [
      callsReply(readCall('toolu_c', outside)),
      {
        steps: [
          { type: 'text', text: 'Something ' },
          { type: 'wait', until: hold.promise },
          { type: 'text', text: 'else.' },
        ],
        delayMs: 5,
      },
    ],
  })
  const server = fake
  const userData = makeUserDataDir('supersede')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    const hint = page.getByTestId('composer-pending-hint')
    await expect(hint).toHaveCount(0)
    await send(page, 'read c')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    const { callKey } = await waitingApproval(page)
    await expect(hint).toHaveText(COPY['zh-CN'].hint)

    await send(page, 'never mind, do something else')
    // At once: the new message's Run is still streaming (its reply is held), and the card is
    // already gone — not left answerable until that Run ends.
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Something')
    await expect(card).toHaveCount(0)
    await expect(hint).toHaveCount(0)
    // The call closed as superseded, without a collapsed answer line.
    const row = page.locator(`[data-testid="tool-row"][data-call-key="${callKey}"]`)
    await expect(row.getByTestId('tool-row-closure')).toHaveText('没有执行：你发了新消息。')
    await expect(row.getByTestId('approval-answered')).toHaveCount(0)
    hold.resolve()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Something else.')
    // The model sees the closed call before the new message, and the file never left.
    const last = JSON.stringify(server.requests.at(-1)?.body)
    expect(last).not.toContain('gamma')
    expect(last.indexOf('toolu_c')).toBeLessThan(last.indexOf('never mind, do something else'))
    const pending = await page.evaluate(async () => {
      const list = (await window.tenon.invoke('approval.list', { limit: 20 })) as {
        data: unknown[]
      }
      return list.data
    })
    expect(pending).toEqual([])
  } finally {
    await app.close()
  }
})

test('the batch’s later call waits as a queued row under the card, and a click right after the card appears does nothing (F6)', async () => {
  const folders = makeFolderTree('queued-row', {
    'ws/y.txt': 'yankee\n',
    'outside/x.txt': 'x-ray\n',
  })
  tree = folders
  const outside = join(folders.real, 'outside', 'x.txt')
  const later = join(folders.real, 'ws', 'y.txt')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(readCall('toolu_x', outside), readCall('toolu_y', later)),
      textReply('Both ', 'done.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('queued-row')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read x then y')
    const card = page.getByTestId('approval-card')
    // At once, as soon as the card is there: inside the guard, so ignored.
    await card.getByTestId('approval-allow').click()
    await page.waitForTimeout(150)
    await expect(card).toHaveCount(1)
    await expect(page.getByTestId('approval-answered')).toHaveCount(0)
    expect(server.requests).toHaveLength(1)
    // The read after it is in the same batch, cut off by the card (H14): a queued row, no card of
    // its own, nothing to answer.
    const queued = card.locator('..').getByTestId('approval-queued-row')
    await expect(queued).toHaveCount(1)
    await expect(queued).toHaveText(`${later}Queued`)
    await expect(queued.locator('button')).toHaveCount(0)
    // The queued row under the card stands for it: no row of its own claiming it runs.
    const rows = page.getByTestId('tool-row')
    await expect(rows).toHaveCount(1)
    await expect(page.getByText('Running…')).toHaveCount(0)

    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-allow').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Both done.')
    await expect(page.getByTestId('approval-queued-row')).toHaveCount(0)
    // Allowed, the batch ran on: the later call has its own row now, completed.
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(1).getByTestId('tool-row-line')).toHaveText(`Read ${later}`)
    await expect(rows.nth(1).getByTestId('tool-row-closure')).toHaveCount(0)
    // Both results went back in the one resumed request, in the batch's order.
    const resumed = JSON.stringify(server.requests[1]?.body)
    expect(resumed.indexOf('x-ray')).toBeGreaterThan(0)
    expect(resumed.indexOf('x-ray')).toBeLessThan(resumed.indexOf('yankee'))
  } finally {
    await app.close()
  }
})

test('Esc in the card denies: the Run ends as user-rejected, and the queued call closes with it (F2, H3)', async () => {
  const folders = makeFolderTree('deny', { 'ws/y.txt': 'yankee\n', 'outside/x.txt': 'x-ray\n' })
  tree = folders
  const outside = join(folders.real, 'outside', 'x.txt')
  const later = join(folders.real, 'ws', 'y.txt')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_x', outside), readCall('toolu_y', later))],
  })
  const server = fake
  const userData = makeUserDataDir('deny')
  seedConfig(userData, { locale: 'en' })
  const first = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    const { app, page } = first
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read x then y')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    // A new card does not take the focus.
    await expect(page.getByTestId('composer-input')).toBeFocused()
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    // Keyboard focus coming into the card from its row lands on 「允许」, not on the first button
    // Tab reaches (「拒绝」): the card is not irreversible.
    const rows = page.getByTestId('tool-row')
    await rows.first().getByTestId('tool-row-line').focus()
    await page.keyboard.press('Tab')
    await expect(card.getByTestId('approval-allow')).toBeFocused()
    await page.keyboard.press('Escape')

    const answered = page.getByTestId('approval-answered')
    await expect(answered).toHaveAttribute('data-outcome', 'denied')
    await expect(answered).toHaveText(`Denied${outside}`)
    await expect(card).toHaveCount(0)
    // The one queued behind it closes with it and did not run (§最小审批卡「排队行」).
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(1).getByTestId('tool-row-closure')).toHaveText('Not run')
    // Expanded, a call that never ran shows what it was asked and no output: its result is only the
    // kernel's note to the model, which the closure line already says (§界面范围 ToolRow).
    await rows.nth(1).getByTestId('tool-row-line').click()
    const details = rows.nth(1).getByTestId('tool-row-details')
    await expect(details).toContainText(`Inputfile_path: ${later}`)
    await expect(details).not.toContainText('Output')
    const end = page.getByTestId('failure-card')
    await expect(end).toHaveAttribute('data-code', 'user-rejected')
    await expect(end).toHaveAttribute('data-visual', 'neutral')
    await expect(end.getByTestId('failure-what')).toHaveText(
      'You declined Read, so the task ended.',
    )
    await expect(end.getByTestId('failure-effects')).toHaveText('2 calls did not happen.')
    await expect(end.getByTestId('failure-action')).toHaveAttribute('data-action', 'copy')
    // The rejection opens no request (§结束原因词表).
    expect(server.requests).toHaveLength(1)
    // Esc was the card's alone (拒绝): the thread's Esc-to-stop never saw it — main got no stop.
    expect(await routeCalls(app, 'chat.stop')).toBe(0)
  } finally {
    await first.app.close()
  }

  // Redrawn from the Tape: the answered call says you declined it, the other did not run, and the
  // collapsed answer is back.
  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { page } = second
    const rows = page.getByTestId('tool-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.first().getByTestId('tool-row-closure')).toHaveText('You declined this.')
    await expect(rows.nth(1).getByTestId('tool-row-closure')).toHaveText('Not run')
    await expect(page.getByTestId('approval-answered')).toHaveText(`Denied${outside}`)
  } finally {
    await second.app.close()
  }
})

/**
 * §界面范围 ToolRow: a row that did not complete says its closure by its source code — for the call
 * you denied, closure.user-rejected, live as on the redraw (the live `tool-outcome` carries the
 * answer's `approval`, mailbox.ts emitClosures); only the calls queued behind it read 「未执行」.
 */
test('live, the denied call’s own row says you declined it, as its redraw does (§界面范围 ToolRow, §最小审批卡)', async () => {
  const folders = makeFolderTree('deny-live', {
    'ws/y.txt': 'yankee\n',
    'outside/x.txt': 'x-ray\n',
  })
  tree = folders
  const outside = join(folders.real, 'outside', 'x.txt')
  fake = await startFakeAnthropic({ replies: [callsReply(readCall('toolu_x', outside))] })
  const server = fake
  const userData = makeUserDataDir('deny-live')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read x')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-deny').click()
    await expect(page.getByTestId('failure-card')).toHaveAttribute('data-code', 'user-rejected')
    await expect(page.getByTestId('tool-row').getByTestId('tool-row-closure')).toHaveText(
      'You declined this.',
    )
  } finally {
    await app.close()
  }
})

test('an allow the re-judgement tightens closes the call with its BlockedNotice, slots filled, before any restart (§最小审批卡「答完」, F3)', async () => {
  const folders = makeFolderTree('rejudge', { 'ws/a.txt': 'alpha\n', 'outside/x.txt': 'x-ray\n' })
  tree = folders
  const userData = makeUserDataDir('rejudge')
  seedConfig(userData, { locale: 'en' })
  // A file in the profile directory, which no Read may reach (D2).
  const guarded = join(dirname(configPathIn(userData)), 'x.txt')
  writeFileSync(guarded, 'PROFILE-SECRET-9\n')
  // The model reads through `hop`: outside the workspace when the card is judged, into the profile
  // by the time 「允许」 judges the call again.
  const hop = join(dirname(folders.real), 'hop')
  symlinkSync(join(folders.real, 'outside'), hop, 'dir')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_x', join(hop, 'x.txt'))), textReply('Blocked ', 'then.')],
  })
  const server = fake
  const notice = `Read can’t reach ${guarded}: Tenon protects it.The model was told.`

  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  let callKey: string
  try {
    const { app, page } = first
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read x')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    await expect(card.getByTestId('approval-object')).toHaveText(
      join(folders.real, 'outside', 'x.txt'),
    )
    callKey = (await waitingApproval(page)).callKey
    rmSync(hop)
    symlinkSync(dirname(guarded), hop, 'dir')

    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-allow').click()
    // denied-on-rejudge: the card goes and the row carries the block, its target slot filled from
    // the live tool-outcome's facts.
    const row = page.locator(`[data-testid="tool-row"][data-call-key="${callKey}"]`)
    const blocked = row.getByTestId('blocked-notice')
    await expect(blocked).toHaveAttribute('data-source', 'protected')
    await expect(blocked).toHaveText(notice)
    await expect(card).toHaveCount(0)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Blocked then.')
    // The model got the block as an error result, and nothing of the file.
    expect(server.requests).toHaveLength(2)
    const resumed = JSON.stringify(server.requests[1]?.body)
    expect(resumed).toContain('"is_error":true')
    expect(resumed).not.toContain('PROFILE-SECRET-9')
    expect(resumed).not.toContain('x-ray')
  } finally {
    await first.app.close()
  }

  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { page } = second
    const row = page.locator(`[data-testid="tool-row"][data-call-key="${callKey}"]`)
    await expect(row.getByTestId('blocked-notice')).toHaveText(notice)
    // Redrawn from `approval.outcome: 'denied-on-rejudge'`: no collapsed line (不留塌行).
    await expect(page.getByTestId('approval-answered')).toHaveCount(0)
  } finally {
    await second.app.close()
  }
})

test('⏎ on 「允许」 allows; on 「拒绝」 it presses that button, which denies (§最小审批卡, H3)', async () => {
  const folders = makeFolderTree('enter-keys', {
    'ws/a.txt': 'alpha\n',
    'outside/x.txt': 'x-ray\n',
    'outside/y.txt': 'yankee\n',
  })
  tree = folders
  const first = join(folders.real, 'outside', 'x.txt')
  const second = join(folders.real, 'outside', 'y.txt')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_x', first), readCall('toolu_y', second))],
  })
  const server = fake
  const userData = makeUserDataDir('enter-keys')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read x and y')
    const rows = page.getByTestId('tool-row')
    const card = rows.first().getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    // A click on the card's text focuses the card and nothing else: only focus coming in by keyboard
    // moves to the default button.
    await page.getByTestId('composer-input').click()
    await card.getByTestId('approval-title').click()
    await expect(card).toBeFocused()
    await rows.first().getByTestId('tool-row-line').focus()
    await page.keyboard.press('Tab')
    await expect(card.getByTestId('approval-allow')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(rows.first().getByTestId('approval-answered')).toHaveAttribute(
      'data-outcome',
      'allowed',
    )

    // The answer's Run read x and stopped on y's card, the next call of the same batch.
    const next = rows.nth(1).getByTestId('approval-card')
    await expect(next).toHaveCount(1)
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await rows.nth(1).getByTestId('tool-row-line').focus()
    await page.keyboard.press('Tab')
    await expect(next.getByTestId('approval-allow')).toBeFocused()
    // Moving inside the card leaves the focus where it went; ⏎ there is 「拒绝」's own press.
    await page.keyboard.press('Shift+Tab')
    await expect(next.getByTestId('approval-deny')).toBeFocused()
    // Focus that comes back with no element it came from (the window activated again) stays on
    // 「拒绝」: moved to 「允许」, the ⏎ below would allow.
    await page.evaluate(() => {
      const button = document.activeElement as HTMLElement
      button.blur()
      button.focus()
    })
    await expect(next.getByTestId('approval-deny')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(rows.nth(1).getByTestId('approval-answered')).toHaveAttribute(
      'data-outcome',
      'denied',
    )
    await expect(page.getByTestId('failure-card')).toHaveAttribute('data-code', 'user-rejected')
    // y never went out: the one request was the batch's own.
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('the card writes what a path hides as visible escapes, in its object line and its reason (②′, E4)', async () => {
  // A zero-width space and a right-to-left override: neither is drawn, and the second would turn
  // the rest of the name around. The card shows each as `\u{XXXX}`.
  const hidden = 'se​cret‮.txt'
  const folders = makeFolderTree('hidden-path', {
    'ws/a.txt': 'alpha\n',
    [`outside/${hidden}`]: 'x-ray\n',
  })
  tree = folders
  const outside = join(folders.real, 'outside', hidden)
  const shown = join(folders.real, 'outside', 'se\\u{200B}cret\\u{202E}.txt')
  fake = await startFakeAnthropic({ replies: [callsReply(readCall('toolu_h', outside))] })
  const server = fake
  const userData = makeUserDataDir('hidden-path')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read it')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    await expect(card.getByTestId('approval-object')).toHaveText(shown)
    await expect(card.getByTestId('approval-reason')).toHaveText(
      COPY.en.reason(shown, join(folders.real, 'ws')),
    )
    // The row above it reads the same (toolSentence escapes its slot).
    await expect(page.getByTestId('tool-row-line')).toHaveText(COPY.en.read(shown))
  } finally {
    await app.close()
  }
})

test('while a card waits, the model menu says a change takes effect from the next message, and Esc in it stops nothing (§模型菜单与输入框)', async () => {
  const folders = makeFolderTree('menu-waiting', { 'ws/a.txt': 'alpha\n', 'outside/x.txt': 'x\n' })
  tree = folders
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_x', join(folders.real, 'outside', 'x.txt')))],
  })
  const server = fake
  const userData = makeUserDataDir('menu-waiting')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    await expect(page.getByTestId('model-next-message')).toHaveCount(0)
    await send(page, 'read x')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    // No Run is in progress (it paused), yet the next message is where a new model starts.
    await page.getByTestId('model-menu-trigger').click()
    await expect(page.getByTestId('model-next-message')).toHaveText(
      'Takes effect from the next message',
    )
    // A note the menu is read with, not only a group's name: assistive tech is not told to skip it.
    await expect(page.getByTestId('model-next-message')).not.toHaveAttribute('aria-hidden', 'true')
    // Esc belongs to the open menu: it closes, and the waiting card is not stopped.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('model-menu')).toBeHidden()
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await expect(page.getByTestId('composer-stop')).toBeVisible()
    expect((await waitingApproval(page)).waitKind).toBe('approval')
    expect(await routeCalls(app, 'chat.stop')).toBe(0)
  } finally {
    await app.close()
  }
})

/**
 * §最小审批卡「答完」: denied-on-rejudge leaves no collapsed line — live, before any restart, as the
 * redraw from `approval.outcome: 'denied-on-rejudge'` does; the 「已允许」 the answer collapsed to goes
 * once the call's own outcome says it never ran.
 */
test('an allow the re-judgement tightens leaves no collapsed 「已允许」 line (§最小审批卡「答完」: denied-on-rejudge 不留塌行)', async () => {
  const folders = makeFolderTree('rejudge-line', {
    'ws/a.txt': 'alpha\n',
    'outside/x.txt': 'x-ray\n',
  })
  tree = folders
  const userData = makeUserDataDir('rejudge-line')
  seedConfig(userData, { locale: 'en' })
  const guarded = join(dirname(configPathIn(userData)), 'x.txt')
  writeFileSync(guarded, 'PROFILE-SECRET-9\n')
  const hop = join(dirname(folders.real), 'hop')
  symlinkSync(join(folders.real, 'outside'), hop, 'dir')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_x', join(hop, 'x.txt'))), textReply('Blocked ', 'then.')],
  })
  const server = fake
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read x')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    rmSync(hop)
    symlinkSync(dirname(guarded), hop, 'dir')
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-allow').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Blocked then.')
    await expect(page.getByTestId('blocked-notice')).toHaveCount(1)
    await expect(page.getByTestId('approval-answered')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

// §最小审批卡「数据」: a new requestId is a new card. A stale answer (the re-judgement still asks, about
// something else) puts a new card under the same row; nothing of the old one carries over — above
// all not the focus on its 「允许」, where the next ⏎ would allow a card the user has not read.
test('a stale answer’s new card under the same row starts afresh: the old 「允许」’s focus does not carry over (§最小审批卡「数据」)', async () => {
  const folders = makeFolderTree('stale-card', {
    'ws/a.txt': 'alpha\n',
    'outside/x.txt': 'x-ray\n',
    'elsewhere/x.txt': 'x-other\n',
  })
  tree = folders
  const hop = join(dirname(folders.real), 'hop')
  symlinkSync(join(folders.real, 'outside'), hop, 'dir')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_x', join(hop, 'x.txt')))],
  })
  const server = fake
  const userData = makeUserDataDir('stale-card')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read x')
    const row = page.getByTestId('tool-row').first()
    const card = row.getByTestId('approval-card')
    await expect(card.getByTestId('approval-object')).toHaveText(
      join(folders.real, 'outside', 'x.txt'),
    )
    const first = await card.getAttribute('data-request-id')
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await row.getByTestId('tool-row-line').focus()
    await page.keyboard.press('Tab')
    await expect(card.getByTestId('approval-allow')).toBeFocused()
    // The path now resolves elsewhere: the answer's re-judgement asks again, about the new file.
    rmSync(hop)
    symlinkSync(join(folders.real, 'elsewhere'), hop, 'dir')
    await page.keyboard.press('Enter')
    await expect(card.getByTestId('approval-object')).toHaveText(
      join(folders.real, 'elsewhere', 'x.txt'),
    )
    await expect(card).not.toHaveAttribute('data-request-id', first ?? '')
    await expect(card).toHaveCount(1)
    await expect(card.getByTestId('approval-allow')).not.toBeFocused()
    // So a second ⏎ answers nothing: the new card still waits, and nothing more went out.
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    await expect(card).toHaveCount(1)
    await expect(row.getByTestId('approval-answered')).toHaveCount(0)
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})
