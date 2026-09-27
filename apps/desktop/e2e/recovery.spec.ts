import { symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import { startFakeOpenAI } from '../test/support/fake-openai.js'
import type { FakeOpenAI } from '../test/support/fake-openai.js'
import type { Page } from '@playwright/test'
import type { FakeAnthropic, ScriptedReply } from '../test/support/fake-anthropic.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import {
  COUNT_ROUTES,
  allowCard,
  newChatFromSidebar,
  repoint,
  routeCalls,
  setDefaultModel,
  waitingSessions,
} from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
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
 * Startup recovery as the window meets it (spec 02 §启动恢复与发送防护; plan step 20: 旧 18, 旧 138,
 * 打开时续跑). Until `session.latest` answers nothing can be sent — whatever it answers; and a paused
 * batch the startup re-judgement closed is listed, never run, until the user opens its session: by
 * id (the banner's 「回去」, exactly one `approval.resume`), by the auto-restored session's 「继续」, or
 * by sending there, which resumes first and queues the message. The resumed Run keeps the paused
 * Run's provider and model.
 */
let fake: FakeAnthropic | undefined
let ollama: FakeOpenAI | undefined
let tree: FolderTree | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
  await ollama?.close()
  ollama = undefined
  tree?.dispose()
  tree = undefined
})

/** Long enough for a test to act on the window before the recovery gate opens. */
const RECOVERY_DELAY_MS = 4_000
const DELAYED = { TENON_E2E_RECOVERY_DELAY_MS: String(RECOVERY_DELAY_MS) }

/** Cmd+Enter on macOS, Ctrl+Enter elsewhere (the composer takes either). */
const SEND_NOW_KEY = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'

/** The model a first launch runs on, and the default the second launch has instead. */
const PAUSED_MODEL = 'claude-sonnet-5'
const LATER_DEFAULT = { id: 'anthropic', modelId: 'claude-haiku-4-5-20251001' } as const

function modelOf(fakeServer: FakeAnthropic, index: number): string | undefined {
  return (fakeServer.requests[index]?.body as { model?: string } | undefined)?.model
}

/** A first launch that leaves one conversation behind: `remember tenon-7` → `Noted.`. */
async function oneConversation(tag: string): Promise<{ userData: string; server: FakeAnthropic }> {
  fake = await startFakeAnthropic({
    replies: [textReply('Noted', '.'), textReply('It was ', 'tenon-7.')],
  })
  const server = fake
  const userData = makeUserDataDir(tag)
  seedConfig(userData, { locale: 'en' })
  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await send(first.page, 'remember tenon-7')
    await expect(first.page.getByTestId('assistant-text')).toHaveText('Noted.')
  } finally {
    await first.app.close()
  }
  return { userData, server }
}

/** The roles of the newest session's stored messages, read over the renderer's own bridge. */
async function storedMessages(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const latest = (await window.tenon.invoke('session.latest', { limit: 50 })) as {
      ok: boolean
      data: { messages: Array<{ role: string }> } | null
    }
    return latest.ok && latest.data !== null ? latest.data.messages.map((row) => row.role) : []
  })
}

test('before session.latest answers, send is disabled with the reason, and neither Enter nor Cmd/Ctrl+Enter sends; afterwards it does (旧 18, 旧 138, B15)', async () => {
  const { userData, server } = await oneConversation('restore-gate')
  const second = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...DELAYED, ...COUNT_ROUTES },
  })
  try {
    const { app, page } = second
    const block = page.getByTestId('composer-send-block')
    await expect(block).toHaveAttribute('data-reason', 'restoring')
    await expect(block).toHaveText('Restoring your last conversation…')
    await page.getByTestId('composer-input').fill('too early')
    await expect(page.getByTestId('composer-send')).toBeDisabled()
    await page.getByTestId('composer-input').press('Enter')
    await page.getByTestId('composer-input').press(SEND_NOW_KEY)
    // Refused, not taken: the words stay in the composer for when sending is possible.
    await expect(page.getByTestId('composer-input')).toHaveValue('too early')
    await page.getByTestId('composer-send').click({ force: true })
    // Still restoring: the three tries above all happened with the gate shut.
    await expect(block).toBeVisible()
    await expect(page.getByTestId('user-message')).toHaveCount(0)

    // The answer comes after the recovery delay, with the conversation it restores.
    await expect(page.getByTestId('user-text')).toHaveText('remember tenon-7', {
      timeout: RECOVERY_DELAY_MS + 10_000,
    })
    await expect(block).toHaveCount(0)
    // Nothing reached main, nothing reached the Tape, nothing reached the provider.
    expect(await routeCalls(app, 'chat.send')).toBe(0)
    expect(await routeCalls(app, 'chat.sendNow')).toBe(0)
    expect(await storedMessages(page)).toEqual(['user', 'assistant'])
    expect(server.requests).toHaveLength(1)
    await expect(page.getByTestId('user-message')).toHaveCount(1)

    await send(page, 'what was it?')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('It was tenon-7.')
    expect(await routeCalls(app, 'chat.send')).toBe(1)
    expect(await storedMessages(page)).toEqual(['user', 'assistant', 'user', 'assistant'])
  } finally {
    await second.app.close()
  }
})

test('a session.latest that answers ok:false lets sending through too, in an empty conversation (旧 138, B15)', async () => {
  const { userData, server } = await oneConversation('restore-failed')
  const second = await launchTenon({
    userData,
    env: {
      ...providerEnv(server.baseURL),
      ...DELAYED,
      ...COUNT_ROUTES,
      TENON_E2E_FAIL_ROUTES: 'session.latest',
    },
  })
  try {
    const { app, page } = second
    const block = page.getByTestId('composer-send-block')
    await expect(block).toHaveAttribute('data-reason', 'restoring')
    await expect(page.getByTestId('composer-send')).toBeDisabled()
    await expect(block).toHaveCount(0, { timeout: RECOVERY_DELAY_MS + 10_000 })
    // It did fail: the seam answers every call of the route with ok:false.
    const answer = (await page.evaluate(() =>
      window.tenon.invoke('session.latest', { limit: 20 }),
    )) as { ok: boolean }
    expect(answer.ok).toBe(false)
    expect(await routeCalls(app, 'session.latest')).toBe(2)
    await expect(page.getByTestId('thread-empty')).toBeVisible()

    await page.getByTestId('composer-input').fill('fresh start')
    await expect(page.getByTestId('composer-send')).toBeEnabled()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('user-text')).toHaveText('fresh start')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('It was tenon-7.')
    expect(server.requests).toHaveLength(2)
  } finally {
    await second.app.close()
  }
})

test('New while the restore is in flight can send at once, and the late answer does not take the window back (§启动恢复与发送防护)', async () => {
  const { userData, server } = await oneConversation('restore-superseded')
  const second = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...DELAYED, ...COUNT_ROUTES },
  })
  try {
    const { app, page } = second
    await expect(page.getByTestId('composer-send-block')).toHaveAttribute(
      'data-reason',
      'restoring',
    )
    await newChatFromSidebar(page)
    await expect(page.getByTestId('composer-send-block')).toHaveCount(0)
    await send(page, 'a new chat')
    await expect(page.getByTestId('user-text')).toHaveText('a new chat')
    // main's chat.send waits for recovery; the reply comes once the gate opens.
    await expect(page.getByTestId('assistant-text').last()).toHaveText('It was tenon-7.', {
      timeout: RECOVERY_DELAY_MS + 10_000,
    })
    await page.waitForTimeout(300)
    await expect(page.getByTestId('user-text')).toHaveText('a new chat')
    expect(await routeCalls(app, 'chat.send')).toBe(1)
    // The new chat's request carries nothing of the conversation it superseded.
    expect(JSON.stringify(server.requests[1]?.body)).not.toContain('tenon-7')
  } finally {
    await second.app.close()
  }
})

/** A task that paused on a card for `hop/x.txt`, then a restart whose re-judgement closes that call. */
interface ResumableSetup {
  readonly userData: string
  readonly server: FakeAnthropic
  /** Where the outside files really are. */
  readonly outside: string
}

/**
 * First launch: a task in `ws` asks to Read `hop/x.txt` (and, with `second`, then `outside/y.txt`);
 * `hop` links to the outside folder, so the card asks. Between the launches `hop` is pointed at the
 * profile directory, which no Read may reach (D2): the startup re-judgement closes the call
 * `denied-on-rejudge` without a card, and the session is resumable (§执行日志与恢复表「可续跑项」).
 * The default model changes as well, which a resumed Run must not follow (§续跑).
 */
async function resumableTask(
  tag: string,
  options: {
    readonly second?: boolean
    readonly thenChat?: boolean
    /** The second launch's default instead of LATER_DEFAULT: another provider, with its settings. */
    readonly laterDefault?: {
      readonly choice: { readonly id: string; readonly modelId: string }
      readonly config: Readonly<Record<string, string>>
    }
  },
  later: readonly ScriptedReply[],
): Promise<ResumableSetup> {
  const folders = makeFolderTree(tag, {
    'ws/a.txt': 'alpha\n',
    'outside/x.txt': 'x-content\n',
    'outside/y.txt': 'y-content\n',
  })
  tree = folders
  const outside = join(folders.real, 'outside')
  const hop = join(dirname(folders.real), 'hop')
  symlinkSync(outside, hop, 'dir')
  const calls = [readCall('toolu_x', join(hop, 'x.txt'))]
  if (options.second === true) calls.push(readCall('toolu_y', join(outside, 'y.txt')))
  fake = await startFakeAnthropic({
    replies: [
      callsReply(...calls),
      ...(options.thenChat === true ? [textReply('Hello ', 'there.')] : []),
      ...later,
    ],
  })
  const server = fake
  const userData = makeUserDataDir(tag)
  seedConfig(userData, { locale: 'en', provider: { id: 'anthropic', modelId: PAUSED_MODEL } })
  const guarded = join(dirname(configPathIn(userData)), 'x.txt')
  writeFileSync(guarded, 'PROFILE-SECRET-3\n')

  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { app, page } = first
    await startTask(app, page, join(folders.real, 'ws'))
    await send(page, 'read x')
    await expect(page.getByTestId('approval-object')).toHaveText(join(outside, 'x.txt'))
    if (options.thenChat === true) {
      await newChatFromSidebar(page)
      await send(page, 'hello')
      await expect(page.getByTestId('assistant-text').last()).toHaveText('Hello there.')
    }
  } finally {
    await first.app.close()
  }
  expect(modelOf(server, 0)).toBe(PAUSED_MODEL)
  repoint(hop, dirname(guarded))
  if (options.laterDefault === undefined) setDefaultModel(userData, LATER_DEFAULT)
  else setDefaultModel(userData, options.laterDefault.choice, options.laterDefault.config)
  return { userData, server, outside }
}

/** The resumed request: the call recovery closed went back as an error, and nothing of the file. */
function expectResumedRequest(server: FakeAnthropic, index: number): string {
  const body = JSON.stringify(server.requests[index]?.body)
  expect(body).toContain('toolu_x')
  expect(body).toContain('"is_error":true')
  expect(body).not.toContain('PROFILE-SECRET-3')
  expect(modelOf(server, index)).toBe(PAUSED_MODEL)
  return body
}

test('the auto-restored resumable session does not resume by itself; leaving and coming back resumes it once, on the paused Run’s model (打开时续跑)', async () => {
  const { userData, server } = await resumableTask('resume-latest', {}, [
    textReply('Carried ', 'on.'),
    textReply('New ', 'default.'),
  ])
  const second = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    const { app, page } = second
    await expect(page.getByTestId('user-text')).toHaveText('read x')
    // Listed, not run: the row at the end of the thread, the stop button, no card, no request.
    const row = page.getByTestId('resume-row')
    await expect(row).toContainText('Unfinished last time')
    await expect(page.getByTestId('composer-stop')).toBeVisible()
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    await expect(page.getByTestId('blocked-notice')).toHaveAttribute('data-source', 'protected')
    expect((await waitingSessions(page)).map((waiting) => waiting.waitKind)).toEqual(['resume'])
    await page.waitForTimeout(1_000)
    expect(await routeCalls(app, 'approval.resume')).toBe(0)
    expect(server.requests).toHaveLength(1)

    // Away (it is not in progress: no dialog), then back through the banner's resume row.
    await newChatFromSidebar(page)
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    const banner = page.getByTestId('pending-banner-row')
    await expect(banner).toHaveAttribute('data-wait-kind', 'resume')
    await expect(banner).toContainText('Another session has unfinished work')
    expect(await routeCalls(app, 'approval.resume')).toBe(0)
    await banner.getByTestId('pending-banner-go').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Carried on.')
    expect(await routeCalls(app, 'approval.resume')).toBe(1)
    expect(server.requests).toHaveLength(2)
    expectResumedRequest(server, 1)
    await expect(row).toHaveCount(0)
    expect(await waitingSessions(page)).toEqual([])

    // The default did change: the next message of this session, a user-opened Run, follows it.
    await send(page, 'and now?')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('New default.')
    expect(modelOf(server, 2)).toBe(LATER_DEFAULT.modelId)
    expect(await routeCalls(app, 'approval.resume')).toBe(1)
  } finally {
    await second.app.close()
  }
})

test('the auto-restored session’s 「继续」 is what resumes it: one approval.resume, on the paused Run’s model (§启动恢复与发送防护 第 4 步)', async () => {
  const { userData, server } = await resumableTask('resume-row', {}, [textReply('Continued.')])
  const second = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    const { app, page } = second
    const row = page.getByTestId('resume-row')
    await expect(row).toBeVisible()
    await row.getByTestId('resume-continue').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Continued.')
    expect(await routeCalls(app, 'approval.resume')).toBe(1)
    expect(server.requests).toHaveLength(2)
    expectResumedRequest(server, 1)
    await expect(row).toHaveCount(0)
    await expect(page.getByTestId('composer-stop')).toHaveCount(0)
  } finally {
    await second.app.close()
  }
})

test('the stop button of a resumable session stops it: no request, no resume row, nothing listed any more (§答复与投递「可续跑的会话里停止」)', async () => {
  const { userData, server } = await resumableTask('resume-stop', { second: true }, [])
  const second = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    const { app, page } = second
    const row = page.getByTestId('resume-row')
    await expect(row).toBeVisible()
    await page.getByTestId('composer-stop').click()
    await expect(row).toHaveCount(0)
    await expect(page.getByTestId('composer-stop')).toHaveCount(0)
    expect(await waitingSessions(page)).toEqual([])
    expect(await routeCalls(app, 'chat.stop')).toBe(1)
    expect(await routeCalls(app, 'approval.resume')).toBe(0)
    // The batch's other call closes with the stop; nothing asks, nothing goes out.
    await expect(page.getByTestId('tool-row').last().getByTestId('tool-row-closure')).toHaveText(
      'Stopped.',
    )
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(server.requests).toHaveLength(1)
  } finally {
    await second.app.close()
  }
})

test('a resumable session the window does not open is the banner’s resume row; 「回去」 resumes it once, on the paused Run’s provider and model (打开时续跑)', async () => {
  // The default is another provider by the second launch: a resume that followed it would go there.
  const other = await startFakeOpenAI({ chunks: ['wrong ', 'provider'], delayMs: 5 })
  ollama = other
  const { userData, server } = await resumableTask(
    'resume-banner',
    {
      thenChat: true,
      laterDefault: {
        choice: { id: 'ollama', modelId: 'qwen3:8b' },
        config: { baseURL: other.baseURL },
      },
    },
    [textReply('Back ', 'on it.')],
  )
  const second = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    const { app, page } = second
    await expect(page.getByTestId('user-text')).toHaveText('hello')
    // The new default is in force for a session that never chose one.
    await expect(page.getByTestId('model-menu-current')).toHaveText('qwen3:8b')
    await expect(page.getByTestId('resume-row')).toHaveCount(0)
    await expect(page.getByTestId('composer-stop')).toHaveCount(0)
    const banner = page.getByTestId('pending-banner-row')
    await expect(banner).toHaveCount(1)
    await expect(banner).toHaveAttribute('data-wait-kind', 'resume')
    await page.waitForTimeout(1_000)
    expect(await routeCalls(app, 'approval.resume')).toBe(0)
    expect(server.requests).toHaveLength(2)

    await banner.getByTestId('pending-banner-go').click()
    await expect(page.getByTestId('user-text')).toHaveText('read x')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Back on it.')
    expect(await routeCalls(app, 'approval.resume')).toBe(1)
    expect(server.requests).toHaveLength(3)
    expectResumedRequest(server, 2)
    expect(other.requests).toHaveLength(0)
  } finally {
    await second.app.close()
  }
})

test('sending in the auto-restored resumable session resumes first and shows the message queued; it goes in with the resumed batch (打开时续跑, §插话与输入框状态表 可续跑)', async () => {
  const { userData, server, outside } = await resumableTask('resume-send', { second: true }, [
    textReply('All ', 'done.'),
  ])
  const second = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    const { app, page } = second
    await expect(page.getByTestId('resume-row')).toBeVisible()
    await send(page, 'meanwhile')
    // The resumed Run went on with the batch's next call, which asks; the message waits, queued.
    const card = page.getByTestId('approval-card')
    await expect(card.getByTestId('approval-object')).toHaveText(join(outside, 'y.txt'))
    const bubble = page.getByTestId('queued-bubble')
    await expect(bubble).toContainText('meanwhile')
    await expect(bubble.getByTestId('queued-label')).toHaveText('Queued')
    await expect(page.getByTestId('user-text')).toHaveText('read x')
    expect(await routeCalls(app, 'approval.resume')).toBe(0)
    expect(await routeCalls(app, 'chat.send')).toBe(1)
    expect(server.requests).toHaveLength(1)

    await allowCard(page)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('All done.')
    await expect(bubble).toHaveCount(0)
    expect(server.requests).toHaveLength(2)
    const body = expectResumedRequest(server, 1)
    // Both results first, then the message (inserted before the resumed Run's first request).
    expect(body.indexOf('y-content')).toBeGreaterThan(0)
    expect(body.indexOf('y-content')).toBeLessThan(body.indexOf('meanwhile'))
    await expect(page.getByTestId('user-text')).toHaveText(['read x', 'meanwhile'])
  } finally {
    await second.app.close()
  }
})

test('the Run a send resumed hides 「继续」 while it goes, and once it has ended the row is gone (打开时续跑, §启动恢复与发送防护 第 4 步)', async () => {
  const hold = deferred()
  const { userData, server } = await resumableTask('resume-row-hides', {}, [
    {
      steps: [
        { type: 'text', text: 'Carried ' },
        { type: 'wait', until: hold.promise },
        { type: 'text', text: 'on.' },
      ],
      delayMs: 5,
    },
  ])
  const second = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    const { app, page } = second
    const row = page.getByTestId('resume-row')
    await expect(row).toBeVisible()
    await send(page, 'meanwhile')
    // Resumed by the send, still streaming: the session is still listed as resumable until this
    // Run ends, yet 「继续」 would only start it a second time.
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Carried')
    await expect(row).toHaveCount(0)
    hold.resolve()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Carried on.')
    // Ended: nothing is left to resume, and the row does not come back.
    await expect(page.getByTestId('composer-stop')).toHaveCount(0)
    await expect(row).toHaveCount(0)
    expect(await routeCalls(app, 'approval.resume')).toBe(0)
    expectResumedRequest(server, 1)
  } finally {
    await second.app.close()
  }
})
