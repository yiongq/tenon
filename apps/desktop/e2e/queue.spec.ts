import { join } from 'node:path'
import { deferred, messageBodies, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic, ScriptedReply } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import {
  COUNT_ROUTES,
  allowCard,
  endCodes,
  newChatFromSidebar,
  routeCalls,
  waitingSessions,
} from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import {
  callsReply,
  makeFolderTree,
  providerEnv,
  pushesOf,
  readCall,
  recordPushes,
  send,
  startTask,
  textReply,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * Sending while a Run is busy (spec 02 §插话与输入框状态表; plan step 20: 旧 22, 旧 220; H13): the
 * message queues as a bubble at the end of the thread, from `chat.queue`, with withdraw, edit and
 * send now; Cmd/Ctrl+Enter is send now from the composer; stop sits beside send, also while a card
 * waits, and Esc is stop. The queue is main's, so a bubble survives leaving the session and a reload.
 */
let fake: FakeAnthropic | undefined
let tree: FolderTree | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
  tree?.dispose()
  tree = undefined
})

/** Cmd+Enter on macOS, Ctrl+Enter elsewhere (the composer takes either). */
const SEND_NOW_KEY = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'

/** A reply that streams `before`, holds the stream until `until` settles, then goes on with `after`. */
function heldReply(
  before: string,
  until: Promise<void>,
  after: ScriptedReply['steps'] = [],
): ScriptedReply {
  return {
    steps: [{ type: 'text', text: before }, { type: 'wait', until }, ...(after ?? [])],
    delayMs: 5,
  }
}

/** The text of the last user message of a wire request, its text blocks joined. */
function lastUserText(body: { messages: Array<{ role: string; content: unknown }> } | undefined) {
  const last = body?.messages.findLast((message) => message.role === 'user')
  const content = last?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
    .map((block) => block.text)
    .join('')
}

test('while a reply streams, stop and send sit side by side; a send queues as a bubble at the end of the thread, and withdrawing it sends nothing (旧 22, 旧 220)', async () => {
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [heldReply('Working', hold.promise, [{ type: 'text', text: ' done.' }])],
  })
  const server = fake
  const userData = makeUserDataDir('queue-withdraw')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await recordPushes(app)
    await send(page, 'first')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Working')
    // Both at once: stop for the Run, send for a message typed meanwhile (Composer.tsx).
    await page.getByTestId('composer-input').fill('second thoughts')
    await expect(page.getByTestId('composer-stop')).toBeVisible()
    await expect(page.getByTestId('composer-send')).toBeEnabled()
    await page.getByTestId('composer-send').click()
    const bubble = page.getByTestId('queued-bubble')
    await expect(bubble).toHaveCount(1)
    await expect(bubble).toContainText('second thoughts')
    await expect(bubble.getByTestId('queued-label')).toHaveText('排队中')
    // It is main's queue that says so, and the message is a bubble — not also a turn of the thread.
    const queued = await pushesOf<{ items: Array<{ text: string }> }>(app, 'chat.queue')
    expect(queued.at(-1)?.items.map((item) => item.text)).toEqual(['second thoughts'])
    await expect(page.getByTestId('user-message')).toHaveCount(1)
    // Drawn at the end of the thread, below the reply, not above the composer.
    await expect(page.getByTestId('thread-viewport').getByTestId('queued-bubble')).toHaveCount(1)
    const reply = await page.getByTestId('assistant-message').last().boundingBox()
    const drawn = await bubble.boundingBox()
    expect(drawn?.y ?? 0).toBeGreaterThanOrEqual((reply?.y ?? 0) + (reply?.height ?? 0))

    await bubble.getByTestId('queued-withdraw').click()
    await expect(bubble).toHaveCount(0)
    hold.resolve()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Working done.')
    await expect.poll(() => endCodes(app)).toEqual(['completed'])
    // Withdrawn: the Run's end sent nothing after it.
    await page.waitForTimeout(500)
    expect(server.requests).toHaveLength(1)
    await expect(page.getByTestId('user-message')).toHaveCount(1)
    expect(await routeCalls(app, 'chat.queue.act')).toBe(1)
  } finally {
    await app.close()
  }
})

test('editing a queued message changes the text inserted after the batch (旧 220)', async () => {
  const folders = makeFolderTree('queue-edit', { 'ws/a.txt': 'alpha-content\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [
      heldReply('Reading', hold.promise, [readCall('toolu_a', join(ws, 'a.txt'))]),
      textReply('Seen ', 'both.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('queue-edit')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'read a')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Reading')
    await send(page, 'the original words')
    const bubble = page.getByTestId('queued-bubble')
    await expect(bubble).toContainText('the original words')

    await bubble.getByTestId('queued-edit').click()
    // Edited as a send is: without the blank space around the words.
    await page.getByTestId('queued-edit-input').fill('  the edited words \n')
    await page.getByTestId('queued-edit-save').click()
    await expect(bubble).toContainText('the edited words')
    await expect(bubble).not.toContainText('the original words')

    hold.resolve()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Seen both.')
    await expect(bubble).toHaveCount(0)
    // Inserted into the same round, after the batch's result, with the edited text only.
    const bodies = messageBodies(server)
    expect(bodies).toHaveLength(2)
    const resumed = JSON.stringify(bodies[1])
    expect(resumed).not.toContain('the original words')
    expect(resumed.indexOf('alpha-content')).toBeGreaterThan(0)
    expect(resumed.indexOf('alpha-content')).toBeLessThan(resumed.indexOf('the edited words'))
    expect(resumed).toContain('"text":"the edited words"')
    await expect(page.getByTestId('user-text')).toHaveText(['read a', 'the edited words'])
  } finally {
    await app.close()
  }
})

test('「立即发送」 on a queued bubble ends the Run as user-stopped and sends it next (旧 220, H13)', async () => {
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [heldReply('Long', hold.promise), textReply('Right ', 'away.')],
  })
  const server = fake
  const userData = makeUserDataDir('queue-send-now')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await recordPushes(app)
    await send(page, 'first')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Long')
    await send(page, 'do this instead')
    const bubble = page.getByTestId('queued-bubble')
    await expect(bubble).toContainText('do this instead')

    await bubble.getByTestId('queued-send-now').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Right away.')
    await expect(bubble).toHaveCount(0)
    await expect.poll(() => endCodes(app)).toEqual(['user-stopped', 'completed'])
    expect(server.aborted).toBe(true)
    const bodies = messageBodies(server)
    expect(bodies).toHaveLength(2)
    expect(lastUserText(bodies[1])).toBe('do this instead')
    await expect(page.getByTestId('user-text')).toHaveText(['first', 'do this instead'])
    // The queued item's own action, not the stop button's route.
    expect(await routeCalls(app, 'chat.queue.act')).toBe(1)
    expect(await routeCalls(app, 'chat.stop')).toBe(0)
    hold.resolve()
  } finally {
    await app.close()
  }
})

test('Cmd/Ctrl+Enter while a reply streams is chat.sendNow: the Run ends user-stopped and the message goes next (旧 220, H13)', async () => {
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [heldReply('Long', hold.promise), textReply('Switched.')],
  })
  const server = fake
  const userData = makeUserDataDir('queue-cmd-enter')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await recordPushes(app)
    await send(page, 'first')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Long')
    await page.getByTestId('composer-input').fill('urgent change')
    await page.keyboard.press(SEND_NOW_KEY)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Switched.')
    await expect.poll(() => endCodes(app)).toEqual(['user-stopped', 'completed'])
    const bodies = messageBodies(server)
    expect(bodies).toHaveLength(2)
    expect(lastUserText(bodies[1])).toBe('urgent change')
    await expect(page.getByTestId('user-text')).toHaveText(['first', 'urgent change'])
    await expect(page.getByTestId('composer-input')).toHaveValue('')
    expect(await routeCalls(app, 'chat.sendNow')).toBe(1)
    expect(await routeCalls(app, 'chat.send')).toBe(1)
    expect(await routeCalls(app, 'chat.stop')).toBe(0)
    hold.resolve()
  } finally {
    await app.close()
  }
})

test('while a card waits, Cmd/Ctrl+Enter is a plain send: the card is superseded and the message opens the next round (§插话与输入框状态表)', async () => {
  const folders = makeFolderTree('queue-card-cmd', {
    'ws/a.txt': 'a\n',
    'outside/b.txt': 'b-content\n',
  })
  tree = folders
  fake = await startFakeAnthropic({
    replies: [
      callsReply(readCall('toolu_b', join(folders.real, 'outside', 'b.txt'))),
      textReply('Instead.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('queue-card-cmd')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read b')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await page.getByTestId('composer-input').fill('something else')
    await page.keyboard.press(SEND_NOW_KEY)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Instead.')
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    await expect(page.getByTestId('tool-row-closure')).toHaveText(
      'Not run: you sent a new message instead.',
    )
    expect(await routeCalls(app, 'chat.send')).toBe(2)
    expect(await routeCalls(app, 'chat.sendNow')).toBe(0)
    const bodies = messageBodies(server)
    expect(lastUserText(bodies[1])).toBe('something else')
    expect(JSON.stringify(bodies[1])).not.toContain('b-content')
  } finally {
    await app.close()
  }
})

test('Esc while a reply streams stops the Run (§模型菜单与输入框「按键」)', async () => {
  const hold = deferred()
  fake = await startFakeAnthropic({ replies: [heldReply('Going', hold.promise)] })
  const server = fake
  const userData = makeUserDataDir('queue-esc')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await recordPushes(app)
    await send(page, 'go on')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Going')
    await expect(page.getByTestId('composer-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect.poll(() => endCodes(app)).toEqual(['user-stopped'])
    expect(await routeCalls(app, 'chat.stop')).toBe(1)
    await expect(page.getByTestId('composer-stop')).toHaveCount(0)
    expect(server.aborted).toBe(true)
    hold.resolve()
  } finally {
    await app.close()
  }
})

test('the stop button shows while a card waits, and stopping there cancels the card (§离开会话 第 3 条)', async () => {
  const folders = makeFolderTree('queue-card-stop', { 'ws/a.txt': 'a\n', 'outside/b.txt': 'b\n' })
  tree = folders
  fake = await startFakeAnthropic({
    replies: [callsReply(readCall('toolu_b', join(folders.real, 'outside', 'b.txt')))],
  })
  const server = fake
  const userData = makeUserDataDir('queue-card-stop')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    await recordPushes(app)
    await send(page, 'read b')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await expect.poll(() => endCodes(app)).toEqual(['paused'])
    // Paused, nothing in progress — the stop button is there anyway, beside send.
    const stop = page.getByTestId('composer-stop')
    await expect(stop).toBeVisible()
    await expect(page.getByTestId('composer-send')).toBeVisible()

    await stop.click()
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    await expect(stop).toHaveCount(0)
    expect(await routeCalls(app, 'chat.stop')).toBe(1)
    expect(await waitingSessions(page)).toEqual([])
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('a queued bubble outlives the Run pausing, leaving the session and coming back, and a reload; the answer inserts it (旧 220, §插话与输入框状态表 等审批)', async () => {
  const folders = makeFolderTree('queue-survives', {
    'ws/a.txt': 'a\n',
    'outside/one.txt': 'one-content\n',
  })
  tree = folders
  const outside = join(folders.real, 'outside', 'one.txt')
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [
      heldReply('Checking', hold.promise, [readCall('toolu_one', outside)]),
      textReply('Both ', 'seen.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('queue-survives')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read one')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Checking')
    await send(page, 'later please')
    const bubble = page.getByTestId('queued-bubble')
    await expect(bubble).toContainText('later please')

    // The batch after it stops on a card: paused, and the message stays queued.
    hold.resolve()
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await expect(bubble).toContainText('later please')

    // Away and back by id: the other session has no bubble, this one has it again.
    await newChatFromSidebar(page)
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await expect(bubble).toHaveCount(0)
    await page.getByTestId('pending-banner-go').click()
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await expect(bubble).toHaveCount(1)
    await expect(bubble).toContainText('later please')

    // A reload is a new document: main replays the queue, the restored session shows it.
    await page.reload()
    await page.getByTestId('app-root').waitFor()
    await expect(page.getByTestId('user-text')).toHaveText('read one')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await expect(bubble).toHaveCount(1)
    await expect(bubble).toContainText('later please')
    expect(server.requests).toHaveLength(1)

    await allowCard(page)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Both seen.')
    await expect(bubble).toHaveCount(0)
    // Allowed: inserted before the next request, after the call's result (§插话与输入框状态表).
    const resumed = JSON.stringify(messageBodies(server)[1])
    expect(resumed.indexOf('one-content')).toBeGreaterThan(0)
    expect(resumed.indexOf('one-content')).toBeLessThan(resumed.indexOf('later please'))
    await expect(page.getByTestId('user-text')).toHaveText(['read one', 'later please'])
    expect(server.requests).toHaveLength(2)
  } finally {
    await app.close()
  }
})
