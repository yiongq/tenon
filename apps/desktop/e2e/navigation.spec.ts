import type { ElectronApplication } from '@playwright/test'
import { join } from 'node:path'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic, ScriptedReply } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import {
  COUNT_ROUTES,
  allowCard,
  endCodes,
  newChatFromMenu,
  newChatFromSidebar,
  routeCalls,
  waitingSessions,
} from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import {
  callsReply,
  makeFolderTree,
  providerEnv,
  readCall,
  recordPushes,
  send,
  startTask,
  textReply,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * Leaving a session (spec 02 §离开会话; plan step 20: 旧 17, 旧 134, 旧 135). A Run in progress —
 * by main's `run.state`, never assistant-ui's `running` — makes each way out ask first; a paused or
 * idle session is left at once, and a waiting card is found again through the banner, after a
 * closed window or a restart too. Stopping is only ever the explicit `chat.stop`, counted in main.
 */
let fake: FakeAnthropic | undefined
let tree: FolderTree | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
  tree?.dispose()
  tree = undefined
})

/** A reply that streams `before`, then holds the stream open until `until` settles, then `after`. */
function heldReply(before: string, until: Promise<void>, after: string): ScriptedReply {
  return {
    steps: [
      { type: 'text', text: before },
      { type: 'wait', until },
      { type: 'text', text: after },
    ],
    delayMs: 5,
  }
}

/** A workspace with one file, and one file outside it that a task must ask before reading. */
function outsideTree(tag: string): { ws: string; outside: (name: string) => string } {
  const folders = makeFolderTree(tag, {
    'ws/a.txt': 'alpha\n',
    'outside/one.txt': 'one-content\n',
    'outside/two.txt': 'two-content\n',
  })
  tree = folders
  return {
    ws: join(folders.real, 'ws'),
    outside: (name) => join(folders.real, 'outside', name),
  }
}

test('New while a Run is in progress asks first; 「留在这里」 sends no chat.stop and the Run completes (旧 17 ①, 旧 134)', async () => {
  const hold = deferred()
  fake = await startFakeAnthropic({ replies: [heldReply('Still ', hold.promise, 'going.')] })
  const userData = makeUserDataDir('leave-stay')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(fake.baseURL), ...COUNT_ROUTES },
  })
  try {
    await recordPushes(app)
    await send(page, 'a long task')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Still')

    await newChatFromSidebar(page)
    const dialog = page.getByTestId('leave-run')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Stop this task?')
    await dialog.getByTestId('leave-stay').click()
    await expect(dialog).toBeHidden()
    // Nothing changed: the same session on screen, its Run still streaming.
    await expect(page.getByTestId('user-text')).toHaveText('a long task')
    hold.resolve()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Still going.')
    await expect.poll(() => endCodes(app)).toEqual(['completed'])
    expect(await routeCalls(app, 'chat.stop')).toBe(0)

    // Idle now: New leaves at once, and unmounting the session's provider stops nothing.
    await newChatFromSidebar(page)
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await expect(dialog).toBeHidden()
    expect(await routeCalls(app, 'chat.stop')).toBe(0)
    expect(fake.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('the menu’s New Chat asks too; 「停止任务」 sends exactly one chat.stop, the Run ends user-stopped, then the window moves (旧 17 ①, 旧 134)', async () => {
  const hold = deferred()
  fake = await startFakeAnthropic({ replies: [heldReply('Half ', hold.promise, 'never.')] })
  const userData = makeUserDataDir('leave-stop')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(fake.baseURL), ...COUNT_ROUTES },
  })
  try {
    await recordPushes(app)
    await send(page, 'stop me')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Half')

    await newChatFromMenu(app)
    const dialog = page.getByTestId('leave-run')
    await expect(dialog).toContainText('停止这个任务？')
    await dialog.getByTestId('leave-stop').click()
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await expect.poll(() => endCodes(app)).toEqual(['user-stopped'])
    expect(await routeCalls(app, 'chat.stop')).toBe(1)
    hold.resolve()
    // The stopped session was left, not replaced by anything the stop wrote.
    await expect(page.getByTestId('user-message')).toHaveCount(0)
    expect(await routeCalls(app, 'chat.stop')).toBe(1)
  } finally {
    await app.close()
  }
})

test('paused on a card, New leaves at once; the banner’s 「回去」 makes the card answerable, and the resumed Run asks on New again (旧 17 ②, 旧 134)', async () => {
  const { ws, outside } = outsideTree('paused-leave')
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [
      callsReply(readCall('toolu_one', outside('one.txt'))),
      heldReply('Resumed ', hold.promise, 'and done.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('paused-leave')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await startTask(app, page, ws)
    await recordPushes(app)
    await send(page, 'read one')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await expect.poll(() => endCodes(app)).toEqual(['paused'])

    // Paused is not in progress: no dialog, and the pending card stays on the Tape.
    await newChatFromSidebar(page)
    await expect(page.getByTestId('leave-run')).toBeHidden()
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    const rows = page.getByTestId('pending-banner-row')
    await expect(rows).toHaveCount(1)
    await expect(rows).toHaveAttribute('data-wait-kind', 'approval')
    await expect(rows).toContainText('Another session is waiting for your approval')
    expect(await routeCalls(app, 'chat.stop')).toBe(0)

    await rows.getByTestId('pending-banner-go').click()
    await expect(page.getByTestId('user-text')).toHaveText('read one')
    await expect(page.getByTestId('approval-object')).toHaveText(outside('one.txt'))
    // The banner never lists the session on screen: its card is right here.
    await expect(page.getByTestId('pending-banner')).toHaveCount(0)
    await allowCard(page)
    await expect(page.getByTestId('approval-answered')).toHaveAttribute('data-outcome', 'allowed')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Resumed')

    // The resumed Run is not the thread's own (no adapter opened it); main says it runs, so New asks.
    await newChatFromSidebar(page)
    const dialog = page.getByTestId('leave-run')
    await expect(dialog).toBeVisible()
    // Esc in the dialog is 「留在这里」, never the thread's stop (Thread.tsx StopOnEscape).
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await page.waitForTimeout(300)
    expect(await routeCalls(app, 'chat.stop')).toBe(0)
    hold.resolve()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Resumed and done.')
    await expect.poll(() => endCodes(app)).toEqual(['paused', 'completed'])
    expect(await routeCalls(app, 'chat.stop')).toBe(0)
    expect(server.requests).toHaveLength(2)
    expect(JSON.stringify(server.requests[1]?.body)).toContain('one-content')
  } finally {
    await app.close()
  }
})

/**
 * Holds main's answer to `channel` until the returned release runs: the handler Electron keeps for
 * the route (`ipcMain.handle`'s table, internal to Electron) is wrapped to wait first.
 */
async function holdRoute(app: ElectronApplication, channel: string): Promise<() => Promise<void>> {
  await app.evaluate(({ ipcMain }, name) => {
    // Electron's own table of the routes `ipcMain.handle` registered, by channel.
    const table = (ipcMain as unknown as Record<string, unknown>)['_invokeHandlers'] as
      | Map<string, (...args: unknown[]) => unknown>
      | undefined
    const original = table?.get(name)
    if (table === undefined || original === undefined) throw new Error(`no handler for ${name}`)
    const store = globalThis as { releaseHeldRoute?: () => void }
    const gate = new Promise<void>((resolve) => {
      store.releaseHeldRoute = resolve
    })
    table.set(name, async (...args: unknown[]) => {
      await gate
      return original(...args)
    })
  }, channel)
  return async () => {
    await app.evaluate(() => (globalThis as { releaseHeldRoute?: () => void }).releaseHeldRoute?.())
  }
}

test('a 「回去」 still reading its session’s tail is dropped by a New taken meanwhile: the window stays where the user went (§离开会话 第 1、4 条)', async () => {
  const { ws, outside } = outsideTree('switch-superseded')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_one', outside('one.txt')))],
  })
  const server = fake
  const userData = makeUserDataDir('switch-superseded')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await startTask(app, page, ws)
    await send(page, 'read one')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await newChatFromSidebar(page)
    const go = page.getByTestId('pending-banner-go')
    await expect(go).toHaveCount(1)

    const release = await holdRoute(app, 'session.messages')
    await go.click()
    // The tail is still on its way when the user moves again.
    await newChatFromSidebar(page)
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await release()
    await expect.poll(() => routeCalls(app, 'session.messages')).toBe(1)
    await page.waitForTimeout(300)
    // The late answer neither shows the other session nor resumes it.
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await expect(page.getByTestId('user-text')).toHaveCount(0)
    await expect(page.getByTestId('pending-banner-row')).toHaveCount(1)
    expect(await routeCalls(app, 'approval.resume')).toBe(0)
  } finally {
    await app.close()
  }
})

test('the banner’s 「回去」 asks while this session runs; 「停止任务」 stops it with one chat.stop, then the other session’s card is answerable (旧 17 ①, 旧 134)', async () => {
  const { ws, outside } = outsideTree('go-back-stop')
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [
      callsReply(readCall('toolu_one', outside('one.txt'))),
      heldReply('Busy ', hold.promise, 'forever.'),
      textReply('Read ', 'it.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('go-back-stop')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await startTask(app, page, ws)
    await recordPushes(app)
    await send(page, 'read one')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)

    await newChatFromSidebar(page)
    await send(page, 'something long')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Busy')
    await page.getByTestId('pending-banner-go').click()
    const dialog = page.getByTestId('leave-run')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('leave-stop').click()
    await expect(page.getByTestId('user-text')).toHaveText('read one')
    await expect.poll(() => endCodes(app)).toEqual(['paused', 'user-stopped'])
    expect(await routeCalls(app, 'chat.stop')).toBe(1)
    hold.resolve()

    await allowCard(page)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Read it.')
    expect(await routeCalls(app, 'chat.stop')).toBe(1)
    expect(server.requests).toHaveLength(3)
  } finally {
    await app.close()
  }
})

test('macOS: a card waits, the last window closes, the menu’s New Chat opens a window whose banner leads back to an answerable card (旧 17 ③)', async () => {
  test.skip(process.platform !== 'darwin', 'only macOS keeps the app alive with no window')
  const { ws, outside } = outsideTree('closed-window')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_one', outside('one.txt'))), textReply('Got ', 'it.')],
  })
  const server = fake
  const userData = makeUserDataDir('closed-window')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await startTask(app, page, ws)
    await send(page, 'read one')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)

    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.close()
    })
    // A closing window stays in getAllWindows() until destroyed, and New Chat tells the first one.
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0)
    const opening = app.waitForEvent('window')
    await newChatFromMenu(app)
    const fresh = await opening
    await fresh.getByTestId('app-root').waitFor()
    await expect(fresh.getByTestId('thread-empty')).toBeVisible()
    const rows = fresh.getByTestId('pending-banner-row')
    await expect(rows).toHaveCount(1)
    await expect(rows).toHaveAttribute('data-wait-kind', 'approval')

    await rows.getByTestId('pending-banner-go').click()
    await expect(fresh.getByTestId('approval-object')).toHaveText(outside('one.txt'))
    await allowCard(fresh)
    await expect(fresh.getByTestId('assistant-text').last()).toHaveText('Got it.')
    expect(JSON.stringify(server.requests[1]?.body)).toContain('one-content')
    // Closing the window stopped nothing either.
    expect(await routeCalls(app, 'chat.stop')).toBe(0)
  } finally {
    await app.close()
  }
})

test('restarted with a card waiting in a session the window does not open: the banner lists it and leads back to an answerable card (旧 17 ④(a))', async () => {
  const { ws, outside } = outsideTree('restart-other')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(readCall('toolu_one', outside('one.txt'))),
      textReply('Hello ', 'there.'),
      textReply('Read ', 'after restart.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('restart-other')
  seedConfig(userData, { locale: 'zh-CN' })

  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(first.app, first.page, ws)
    await send(first.page, 'read one')
    await expect(first.page.getByTestId('approval-card')).toHaveCount(1)
    await newChatFromSidebar(first.page)
    await send(first.page, 'hello')
    await expect(first.page.getByTestId('assistant-text').last()).toHaveText('Hello there.')
  } finally {
    await first.app.close()
  }

  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { page } = second
    // The newest conversation opened; the waiting one is the banner's.
    await expect(page.getByTestId('user-text')).toHaveText('hello')
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    const rows = page.getByTestId('pending-banner-row')
    await expect(rows).toHaveCount(1)
    await expect(rows).toHaveAttribute('data-wait-kind', 'approval')
    await expect(rows).toContainText('另一个会话在等你批准')
    await rows.getByTestId('pending-banner-go').click()
    await expect(page.getByTestId('user-text')).toHaveText('read one')
    await expect(page.getByTestId('approval-object')).toHaveText(outside('one.txt'))
    await allowCard(page)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Read after restart.')
    expect(JSON.stringify(server.requests[2]?.body)).toContain('one-content')
  } finally {
    await second.app.close()
  }
})

test('restarted with a card waiting in the session the window opens: the card is answerable at once and the banner does not list it (旧 17 ④(b))', async () => {
  const { ws, outside } = outsideTree('restart-same')
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_one', outside('one.txt'))), textReply('Done ', 'here.')],
  })
  const server = fake
  const userData = makeUserDataDir('restart-same')
  seedConfig(userData, { locale: 'en' })

  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(first.app, first.page, ws)
    await send(first.page, 'read one')
    await expect(first.page.getByTestId('approval-card')).toHaveCount(1)
  } finally {
    await first.app.close()
  }

  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { page } = second
    await expect(page.getByTestId('user-text')).toHaveText('read one')
    await expect(page.getByTestId('approval-object')).toHaveText(outside('one.txt'))
    // It is waiting (approval.list has it), and it is this session: not in the banner.
    expect((await waitingSessions(page)).map((row) => row.waitKind)).toEqual(['approval'])
    await expect(page.getByTestId('pending-banner')).toHaveCount(0)
    await allowCard(page)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Done here.')
    expect(server.requests).toHaveLength(2)
  } finally {
    await second.app.close()
  }
})

test('two sessions waiting at a restart: the one opened is answerable, the banner lists the other, and a new session lists both (旧 135)', async () => {
  const { ws, outside } = outsideTree('two-waiting')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(readCall('toolu_one', outside('one.txt'))),
      callsReply(readCall('toolu_two', outside('two.txt'))),
      textReply('Answered ', 'that one.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('two-waiting')
  seedConfig(userData, { locale: 'en' })

  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { app, page } = first
    await startTask(app, page, ws)
    await send(page, 'read one')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await newChatFromSidebar(page)
    await startTask(app, page, ws)
    await send(page, 'read two')
    await expect(page.getByTestId('approval-object')).toHaveText(outside('two.txt'))
    await expect(page.getByTestId('pending-banner-row')).toHaveCount(1)
  } finally {
    await first.app.close()
  }

  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { page } = second
    // The newest session opens with its card answerable; the banner has the other one only.
    await expect(page.getByTestId('user-text')).toHaveText('read two')
    const card = page.getByTestId('approval-card')
    await expect(card.getByTestId('approval-object')).toHaveText(outside('two.txt'))
    await expect(card.getByTestId('approval-allow')).toBeEnabled()
    expect(await waitingSessions(page)).toHaveLength(2)
    const rows = page.getByTestId('pending-banner-row')
    await expect(rows).toHaveCount(1)

    await newChatFromSidebar(page)
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await expect(rows).toHaveCount(2)
    expect(
      await rows.evaluateAll((all) => all.map((row) => row.getAttribute('data-wait-kind'))),
    ).toEqual(['approval', 'approval'])

    await rows.first().getByTestId('pending-banner-go').click()
    await expect(card).toHaveCount(1)
    // Whichever it was, the banner now lists exactly the other one.
    await expect(rows).toHaveCount(1)
    const opened = await card.getByTestId('approval-object').textContent()
    expect([outside('one.txt'), outside('two.txt')]).toContain(opened)
    await allowCard(page)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Answered that one.')
    const read = opened === outside('one.txt') ? 'one-content' : 'two-content'
    expect(JSON.stringify(server.requests[2]?.body)).toContain(read)
    // Answered, it waits no more; the other still does, and is still the banner's one row.
    expect(await waitingSessions(page)).toHaveLength(1)
    await expect(rows).toHaveCount(1)
  } finally {
    await second.app.close()
  }
})
