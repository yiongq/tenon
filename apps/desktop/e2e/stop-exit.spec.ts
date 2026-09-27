import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { deferred, messageBodies, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { Deferred, FakeAnthropic, ScriptedReply } from '../test/support/fake-anthropic.js'
import { stubExitConfirm } from './helpers/exit.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { allowCard, endCodes } from './helpers/navigation.js'
import { dispatchedOutcomes, runEnds, tapeFacts, userTexts } from './helpers/tape.js'
import { expect, test } from './helpers/test.js'
import {
  bashCall,
  callsReply,
  makeFolderTree,
  providerEnv,
  recordPushes,
  send,
  startTask,
  textReply,
  writeCall,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * Stop kills, and closing a window or quitting asks first (spec 02 §停止与退出, §点停止时各状态怎么收,
 * §e2e 接缝; plan step 23: 旧 7's interface half, 旧 13, 旧 14, 旧 136, the queue step 20 left, and
 * acceptance 22's 「立即发送」 over a Bash; acceptance 41, 42). Main's native confirm is replaced
 * through `electronApp.evaluate` (launchTenon presets 「停止任务」, so no teardown waits on it); a quit
 * is `app.quit()` and a close `BrowserWindow#close()`, both through `evaluate`, as Cmd+Q never
 * reaches the application menu. The one native quit is a SIGTERM: Electron handles it as it does
 * Cmd+Q and the Dock's Quit, with `Browser::Quit` called from native code.
 *
 * The closures written on a quit or a close are `app-exit` (§原因码表): that is the kernel's half of
 * plan step 23 (track K). These cases assert it as the spec writes it.
 */
let fake: FakeAnthropic | undefined
let tree: FolderTree | undefined
const holds: Deferred[] = []

test.afterEach(async () => {
  for (const hold of holds.splice(0)) hold.resolve()
  await fake?.close()
  fake = undefined
  tree?.dispose()
  tree = undefined
})

/** Cmd+Enter on macOS, Ctrl+Enter elsewhere (the composer takes either). */
const SEND_NOW_KEY = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'

/** The zh-CN confirm, as the catalogue writes it: LeaveRunDialog's title and description. */
const CONFIRM = {
  message: '停止这个任务？',
  detail: '任务还在进行。可以停止后离开，或者留在这里等它做完。',
} as const
const QUIT_BUTTONS = ['停止任务并退出', '取消']
const CLOSE_BUTTONS = ['停止任务并关闭', '取消']

/** A reply that streams `before`, holds the stream until the test lets it go, then `after`. */
function heldReply(before: string, after: ScriptedReply['steps'] = []): ScriptedReply {
  const hold = deferred()
  holds.push(hold)
  return {
    steps: [
      { type: 'text', text: before },
      { type: 'wait', until: hold.promise },
      ...(after ?? []),
    ],
    delayMs: 5,
  }
}

/** `app.quit()`, as the menu's Quit and Cmd+Q call it; resolves once the process is gone. */
async function quitAndWait(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ app: electronApp }) => electronApp.quit())
  await closed
}

/** Closes the first window, as its close button does. */
async function closeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
}

async function windowCount(app: ElectronApplication): Promise<number> {
  return await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

/** macOS reopens a window from the Dock: `activate` with none open (index.ts). */
async function reopenFromDock(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => windowCount(app)).toBe(0)
  const opening = app.waitForEvent('window')
  await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
  const page = await opening
  await page.getByTestId('app-root').waitFor()
  return page
}

/** Whether `pid` is a live process: not gone, and not a zombie waiting to be reaped. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .startsWith('Z')
  } catch {
    return false
  }
}

/**
 * A command whose process tree outlives a SIGTERM (旧 7's fixture, the kind P's timing tests use):
 * the shell ignores TERM, forks a child that inherits that, writes both pids, and waits. Only the
 * SIGKILL to the group ends it.
 */
const FORK_FIXTURE = ["trap '' TERM", 'sleep 30 &', 'echo "$$ $!" > pids.txt', 'wait', ''].join(
  '\n',
)

/** The two pids the fixture wrote, once it has. */
async function forkedPids(ws: string): Promise<number[]> {
  const file = join(ws, 'pids.txt')
  let pids: number[] = []
  await expect
    .poll(() => {
      if (!existsSync(file)) return 0
      pids = readFileSync(file, 'utf8').trim().split(/\s+/u).map(Number).filter(Number.isInteger)
      return pids.length
    })
    .toBe(2)
  return pids
}

/** A task on `ws` whose one Bash call has been allowed and is running. */
async function runningBash(
  app: ElectronApplication,
  page: Page,
  ws: string,
  started: string,
): Promise<void> {
  await startTask(app, page, ws)
  await send(page, 'run it')
  await allowCard(page)
  await expect.poll(() => existsSync(join(ws, started))).toBe(true)
}

test('quitting mid-stream asks first; 「停止任务并退出」 quits, and after a restart the Run is shutdown-aborted (旧 13, acceptance 42)', async () => {
  fake = await startFakeAnthropic({ replies: [heldReply('Long')] })
  const server = fake
  const userData = makeUserDataDir('exit-quit-stream')
  seedConfig(userData, { locale: 'zh-CN' })
  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  let quit = false
  try {
    await send(first.page, 'first')
    await expect(first.page.getByTestId('assistant-text').last()).toHaveText('Long')
    await quitAndWait(first.app)
    quit = true
  } finally {
    if (!quit) await first.app.close()
  }
  expect(first.exitConfirms()).toEqual([{ ...CONFIRM, buttons: QUIT_BUTTONS }])
  expect(runEnds(tapeFacts(userData))).toEqual([{ code: 'shutdown-aborted', trigger: 'quit' }])

  // Restarted: the partial reply is what the user saw, and recovery left the Run as the quit ended it.
  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await expect(second.page.getByTestId('assistant-text').last()).toHaveText('Long')
    expect(runEnds(tapeFacts(userData))).toEqual([{ code: 'shutdown-aborted', trigger: 'quit' }])
    expect(server.requests).toHaveLength(1)
  } finally {
    await second.app.close()
  }
  // Nothing was in progress on the second launch: its quit asked nothing.
  expect(second.exitConfirms()).toEqual([])
})

test('macOS: a native quit with nothing in progress exits — a SIGTERM, the path of Cmd+Q and the Dock’s Quit (§停止与退出「退出」)', async () => {
  test.skip(process.platform !== 'darwin', 'elsewhere the last window closing quits in any case')
  const userData = makeUserDataDir('exit-native-quit')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, exitConfirms } = await launchTenon({ userData })
  const pid = app.process().pid
  let exited = false
  try {
    if (pid === undefined) throw new Error('the app has no pid')
    // Nothing to wait for: the quit's steps are microtasks run inside the native `before-quit`.
    process.kill(pid, 'SIGTERM')
    await expect.poll(() => isRunning(pid), { timeout: 5_000 }).toBe(false)
    exited = true
  } finally {
    if (!exited) await app.close()
  }
  expect(exitConfirms()).toEqual([])
})

test('closing the window mid-stream asks too; 「取消」 leaves it open and the task runs to its end (旧 13)', async () => {
  fake = await startFakeAnthropic({
    replies: [heldReply('Long', [{ type: 'text', text: ' and done.' }])],
  })
  const server = fake
  const userData = makeUserDataDir('exit-close-cancel')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page, exitConfirms } = await launchTenon({
    userData,
    env: providerEnv(server.baseURL),
  })
  try {
    await recordPushes(app)
    await send(page, 'first')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Long')
    await stubExitConfirm(app, 'cancel')
    await closeWindow(app)
    await expect.poll(() => exitConfirms()).toEqual([{ ...CONFIRM, buttons: CLOSE_BUTTONS }])
    expect(await windowCount(app)).toBe(1)
    for (const hold of holds) hold.resolve()
    await expect(page.getByTestId('assistant-message').last()).toContainText('and done.')
    await expect.poll(() => endCodes(app)).toEqual(['completed'])
    await expect(page.getByTestId('failure-card')).toHaveCount(0)
    // Done now: closing asks nothing, but the preset goes back first (§e2e 接缝).
    await stubExitConfirm(app, 'stop')
  } finally {
    await app.close()
  }
  expect(exitConfirms()).toHaveLength(1)
  expect(runEnds(tapeFacts(userData))).toEqual([{ code: 'completed' }])
})

test('「停止任务并退出」 while a Bash runs: after a restart the Run is shutdown-aborted{quit}, and every dispatched call closed as app-exit (旧 136)', async () => {
  test.setTimeout(90_000)
  const folders = makeFolderTree('exit-quit-bash', { 'ws/keep.txt': 'keep\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(bashCall('toolu_1', 'echo started > started.txt; sleep 30')),
      textReply('never'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('exit-quit-bash')
  seedConfig(userData, { locale: 'zh-CN' })
  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  let quit = false
  try {
    await runningBash(first.app, first.page, ws, 'started.txt')
    await quitAndWait(first.app)
    quit = true
  } finally {
    if (!quit) await first.app.close()
  }
  expect(first.exitConfirms()).toEqual([{ ...CONFIRM, buttons: QUIT_BUTTONS }])
  const facts = tapeFacts(userData)
  // The first Run paused on the card; the answer's Run was running the command.
  expect(runEnds(facts)).toEqual([
    { code: 'paused', waitingFor: 'approval' },
    { code: 'shutdown-aborted', trigger: 'quit' },
  ])
  // The closure is the shutdown's own (§原因码表 app-exit), not a user's stop — the kernel's half.
  expect(dispatchedOutcomes(facts)).toEqual([
    { call: 'toolu_1', state: 'aborted', source: 'app-exit' },
  ])
  expect(server.requests).toHaveLength(1)

  // Restarted: recovery found nothing left open — no second closure, no other end, no request.
  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await expect(second.page.getByTestId('user-text')).toHaveText(['run it'])
    const after = tapeFacts(userData)
    expect(runEnds(after)).toEqual(runEnds(facts))
    expect(dispatchedOutcomes(after)).toEqual(dispatchedOutcomes(facts))
    expect(server.requests).toHaveLength(1)
  } finally {
    await second.app.close()
  }
})

test('「停止任务并关闭」 while a Bash runs: the Run is shutdown-aborted{close-window}, its call app-exit, and the store stayed open for it (旧 136)', async () => {
  test.setTimeout(90_000)
  const folders = makeFolderTree('exit-close-bash', { 'ws/keep.txt': 'keep\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(bashCall('toolu_1', 'echo started > started.txt; sleep 30')),
      textReply('never'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('exit-close-bash')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page, exitConfirms } = await launchTenon({
    userData,
    env: providerEnv(server.baseURL),
  })
  // Off macOS the last window closing quits the app too.
  const exited = process.platform === 'darwin' ? null : app.waitForEvent('close')
  try {
    await runningBash(app, page, ws, 'started.txt')
    await closeWindow(app)
    // Written while the app still runs, on the store the close left open.
    await expect
      .poll(() => runEnds(tapeFacts(userData)).at(-1))
      .toEqual({ code: 'shutdown-aborted', trigger: 'close-window' })
    expect(exitConfirms()).toEqual([{ ...CONFIRM, buttons: CLOSE_BUTTONS }])
    expect(dispatchedOutcomes(tapeFacts(userData))).toEqual([
      { call: 'toolu_1', state: 'aborted', source: 'app-exit' },
    ])
    expect(server.requests).toHaveLength(1)
  } finally {
    if (exited === null) await app.close()
    else await exited
  }
  // The quit that followed had nothing in progress: one confirm in all.
  expect(exitConfirms()).toHaveLength(1)
})

test('a reload mid-stream ends the Run as shutdown-aborted{close-window} without asking; a navigation main refuses leaves the next one running (§停止与退出「watchOwner」)', async () => {
  fake = await startFakeAnthropic({
    replies: [heldReply('Long'), heldReply('Again', [{ type: 'text', text: ' and done.' }])],
  })
  const server = fake
  const userData = makeUserDataDir('exit-reload')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page, exitConfirms } = await launchTenon({
    userData,
    env: providerEnv(server.baseURL),
  })
  try {
    await send(page, 'first')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Long')
    // The View menu's Reload: the main frame commits a new document.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.reload(),
    )
    await expect
      .poll(() => runEnds(tapeFacts(userData)))
      .toEqual([{ code: 'shutdown-aborted', trigger: 'close-window' }])
    expect(exitConfirms()).toEqual([])

    await page.getByTestId('app-root').waitFor()
    await send(page, 'second')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Again')
    // A navigation away, which main cancels (navigation.ts): the document stays, and so does the Run.
    // No locator after it — Playwright waits on a navigation main cancelled (smoke.spec.ts).
    await page.evaluate(() => {
      location.href = 'https://example.invalid/'
    })
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000)
    })
    expect(runEnds(tapeFacts(userData))).toHaveLength(1)
    holds[1]?.resolve()
    await expect
      .poll(() => runEnds(tapeFacts(userData)))
      .toEqual([{ code: 'shutdown-aborted', trigger: 'close-window' }, { code: 'completed' }])
    expect(server.requests).toHaveLength(2)
  } finally {
    await app.close()
  }
})

test('quitting with a card waiting asks nothing; after a restart the card is there and answerable (旧 14, acceptance 42)', async () => {
  const folders = makeFolderTree('exit-quit-card', { 'ws/keep.txt': 'keep\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const target = join(ws, 'out.txt')
  fake = await startFakeAnthropic({
    replies: [callsReply(writeCall('toolu_1', target, 'hello\n')), textReply('Written.')],
  })
  const server = fake
  const userData = makeUserDataDir('exit-quit-card')
  seedConfig(userData, { locale: 'zh-CN' })
  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  let quit = false
  try {
    await startTask(first.app, first.page, ws)
    await send(first.page, 'write it')
    await expect(first.page.getByTestId('approval-card')).toHaveCount(1)
    await quitAndWait(first.app)
    quit = true
  } finally {
    if (!quit) await first.app.close()
  }
  // A paused Run is not in progress (B4): nothing asked, nothing written for the card.
  expect(first.exitConfirms()).toEqual([])
  expect(runEnds(tapeFacts(userData))).toEqual([{ code: 'paused', waitingFor: 'approval' }])
  expect(existsSync(target)).toBe(false)

  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await allowCard(second.page)
    await expect(second.page.getByTestId('assistant-text').last()).toHaveText('Written.')
    expect(readFileSync(target, 'utf8')).toBe('hello\n')
  } finally {
    await second.app.close()
  }
})

test('macOS: closing the window with a card waiting asks nothing; reopened from the Dock, the card is answerable (旧 14)', async () => {
  test.skip(process.platform !== 'darwin', 'only macOS keeps the app alive with no window')
  const folders = makeFolderTree('exit-close-card', { 'ws/keep.txt': 'keep\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const target = join(ws, 'out.txt')
  fake = await startFakeAnthropic({
    replies: [callsReply(writeCall('toolu_1', target, 'hello\n')), textReply('Written.')],
  })
  const server = fake
  const userData = makeUserDataDir('exit-close-card')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page, exitConfirms } = await launchTenon({
    userData,
    env: providerEnv(server.baseURL),
  })
  try {
    await startTask(app, page, ws)
    await send(page, 'write it')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await closeWindow(app)
    const reopened = await reopenFromDock(app)
    expect(exitConfirms()).toEqual([])
    await allowCard(reopened)
    await expect(reopened.getByTestId('assistant-text').last()).toHaveText('Written.')
    expect(readFileSync(target, 'utf8')).toBe('hello\n')
  } finally {
    await app.close()
  }
})

test('a queued message is dropped by the quit: after a restart it is neither on the Tape nor sent (§插话与输入框状态表, H13, B4)', async () => {
  fake = await startFakeAnthropic({ replies: [heldReply('Long')], chunks: ['never'] })
  const server = fake
  const userData = makeUserDataDir('exit-quit-queue')
  seedConfig(userData, { locale: 'zh-CN' })
  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  let quit = false
  try {
    await send(first.page, 'first')
    await expect(first.page.getByTestId('assistant-text').last()).toHaveText('Long')
    await send(first.page, 'later')
    await expect(first.page.getByTestId('queued-bubble')).toContainText('later')
    await quitAndWait(first.app)
    quit = true
  } finally {
    if (!quit) await first.app.close()
  }
  expect(userTexts(tapeFacts(userData))).toEqual(['first'])

  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await expect(second.page.getByTestId('user-text')).toHaveText(['first'])
    await expect(second.page.getByTestId('queued-bubble')).toHaveCount(0)
    await second.page.waitForTimeout(500)
    expect(server.requests).toHaveLength(1)
  } finally {
    await second.app.close()
  }
  expect(userTexts(tapeFacts(userData))).toEqual(['first'])
})

test('a queued message outlives a stop: the Run ends user-stopped and the message stays queued, unsent (§插话与输入框状态表 Run 结束时)', async () => {
  fake = await startFakeAnthropic({ replies: [heldReply('Long')], chunks: ['never'] })
  const server = fake
  const userData = makeUserDataDir('exit-stop-queue')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await recordPushes(app)
    await send(page, 'first')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Long')
    await send(page, 'later')
    await expect(page.getByTestId('queued-bubble')).toContainText('later')
    await page.getByTestId('composer-stop').click()
    await expect.poll(() => endCodes(app)).toEqual(['user-stopped'])
    await expect(page.getByTestId('failure-card')).toHaveAttribute('data-code', 'user-stopped')
    await page.waitForTimeout(500)
    await expect(page.getByTestId('queued-bubble')).toContainText('later')
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
  expect(userTexts(tapeFacts(userData))).toEqual(['first'])
})

test('macOS: 「停止任务并关闭」 with a message queued leaves it queued, unsent; the window reopened from the Dock shows it (开放问题 26, §从队列取什么)', async () => {
  test.skip(process.platform !== 'darwin', 'only macOS keeps the app alive with no window')
  fake = await startFakeAnthropic({ replies: [heldReply('Long')], chunks: ['never'] })
  const server = fake
  const userData = makeUserDataDir('exit-close-queue')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page, exitConfirms } = await launchTenon({
    userData,
    env: providerEnv(server.baseURL),
  })
  try {
    await send(page, 'first')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Long')
    await send(page, 'later')
    await expect(page.getByTestId('queued-bubble')).toContainText('later')
    await closeWindow(app)
    await expect
      .poll(() => runEnds(tapeFacts(userData)).at(-1))
      .toEqual({ code: 'shutdown-aborted', trigger: 'close-window' })
    expect(exitConfirms()).toEqual([{ ...CONFIRM, buttons: CLOSE_BUTTONS }])
    // Only urgent items go after a closed window's end: this one stays in main's queue.
    const reopened = await reopenFromDock(app)
    await expect(reopened.getByTestId('queued-bubble')).toContainText('later')
    await reopened.waitForTimeout(500)
    expect(server.requests).toHaveLength(1)
    expect(userTexts(tapeFacts(userData))).toEqual(['first'])
  } finally {
    await app.close()
  }
})

test('stopping a Bash whose tree ignores SIGTERM: 「后续写入未发生」 shows only once the whole tree is gone (旧 7, interface half)', async () => {
  test.setTimeout(90_000)
  const folders = makeFolderTree('stop-fork', { 'ws/fork.sh': FORK_FIXTURE })
  tree = folders
  const ws = join(folders.real, 'ws')
  fake = await startFakeAnthropic({
    replies: [callsReply(bashCall('toolu_1', 'sh fork.sh')), textReply('never')],
  })
  const server = fake
  const userData = makeUserDataDir('stop-fork')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await runningBash(app, page, ws, 'pids.txt')
    const pids = await forkedPids(ws)
    expect(pids.every(isRunning)).toBe(true)
    await page.getByTestId('composer-stop').click()
    const effects = page.getByTestId('failure-effects')
    let sawAlive = false
    const deadline = Date.now() + 10_000
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one sample at a time: the line, then the tree
      const shown = (await effects.allTextContents()).join('').includes('后续写入未发生')
      const alive = pids.some(isRunning)
      if (alive) sawAlive = true
      expect({ shown, alive }).not.toEqual({ shown: true, alive: true })
      if (shown) break
      if (Date.now() > deadline) throw new Error('「后续写入未发生」 never showed')
    }
    // The tree did outlive the SIGTERM: the line could only follow the SIGKILL.
    expect(sawAlive).toBe(true)
    await expect(effects).toHaveText('1 个调用中途停下，后续写入未发生。')
    await expect(page.getByTestId('failure-card')).toHaveAttribute('data-code', 'user-stopped')
    expect(pids.some(isRunning)).toBe(false)
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
  expect(dispatchedOutcomes(tapeFacts(userData))).toEqual([
    { call: 'toolu_1', state: 'aborted', source: 'stopped' },
  ])
})

test('「立即发送」 over a running Bash stops it, and the message goes out only after that call is closed (acceptance 22, H13)', async () => {
  test.setTimeout(90_000)
  const folders = makeFolderTree('send-now-bash', { 'ws/fork.sh': FORK_FIXTURE })
  tree = folders
  const ws = join(folders.real, 'ws')
  fake = await startFakeAnthropic({
    replies: [callsReply(bashCall('toolu_1', 'sh fork.sh')), textReply('Switched.')],
  })
  const server = fake
  const userData = makeUserDataDir('send-now-bash')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await recordPushes(app)
    await runningBash(app, page, ws, 'pids.txt')
    const pids = await forkedPids(ws)
    await page.getByTestId('composer-input').fill('switch')
    await page.keyboard.press(SEND_NOW_KEY)
    let sawAlive = false
    const deadline = Date.now() + 10_000
    for (;;) {
      const sent = server.requests.length > 1
      const alive = pids.some(isRunning)
      if (alive) sawAlive = true
      // The next request never leaves while the command's tree still runs.
      expect({ sent, alive }).not.toEqual({ sent: true, alive: true })
      if (sent) break
      if (Date.now() > deadline) throw new Error('the message never went out')
      // oxlint-disable-next-line no-await-in-loop -- sampling until the request arrives
      await page.waitForTimeout(10)
    }
    expect(sawAlive).toBe(true)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Switched.')
    // On the wire, the closed call comes before the message: the Run it stopped closed it first.
    const blocks = (messageBodies(server)[1]?.messages ?? []).flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as Array<{ type: string; text?: string; tool_use_id?: string }>)
        : [{ type: 'text', text: String(message.content) }],
    )
    const closed = blocks.findIndex(
      (block) => block.type === 'tool_result' && block.tool_use_id === 'toolu_1',
    )
    const message = blocks.findIndex((block) => block.type === 'text' && block.text === 'switch')
    expect(closed).toBeGreaterThanOrEqual(0)
    expect(message).toBeGreaterThan(closed)
    const ends = await endCodes(app)
    expect(ends.slice(-2)).toEqual(['user-stopped', 'completed'])
    expect(server.requests).toHaveLength(2)
  } finally {
    await app.close()
  }
  expect(dispatchedOutcomes(tapeFacts(userData))).toEqual([
    { call: 'toolu_1', state: 'aborted', source: 'stopped' },
  ])
  expect(userTexts(tapeFacts(userData))).toEqual(['run it', 'switch'])
})
