import { readFileSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { startFakeOpenAI } from '../test/support/fake-openai.js'
import type { FakeOpenAI } from '../test/support/fake-openai.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { COUNT_ROUTES, endCodes, routeCalls } from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import { providerEnv, recordPushes, send } from './helpers/tools.js'

/**
 * The composer's two rules the second review reopened (spec 02 §模型菜单与输入框「输入框」; plan step
 * 20): 「发送」 is disabled, with its reason, while the session is a task on a model that cannot send
 * tools — and only while it is (A15, §表外模型与不发工具); and Esc from the composer stops the Run
 * the stop button stands for, sending nothing typed (components.md:82).
 */
let anthropic: FakeAnthropic | undefined
let ollama: FakeOpenAI | undefined

test.afterEach(async () => {
  await anthropic?.close()
  await ollama?.close()
  anthropic = undefined
  ollama = undefined
})

/** The thread's user turns by text, and each assistant turn by its failure card's code (or none). */
async function threadOrder(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-testid="user-message"], [data-testid="assistant-message"]',
      ),
    ].map((turn) =>
      turn.getAttribute('data-testid') === 'user-message'
        ? `user: ${turn.querySelector('[data-testid="user-text"]')?.textContent ?? ''}`
        : `end: ${turn.querySelector('[data-testid="failure-card"]')?.getAttribute('data-code') ?? ''}`,
    ),
  )
}

test('a new session whose only model is text-only: 任务 disables 「发送」 and says why, 对话 enables it again (§模型菜单与输入框「提示与禁发」, A15)', async () => {
  ollama = await startFakeOpenAI({ chunks: ['local ', 'answer'], delayMs: 5 })
  const server = ollama
  const userData = makeUserDataDir('composer-text-only')
  // Ollama is the one provider there is (no key for anthropic or zhipu): both profiles' model.
  seedConfig(userData, {
    locale: 'zh-CN',
    provider: { id: 'ollama', modelId: 'qwen3:8b' },
    providerConfig: { ollama: { baseURL: server.baseURL } },
  })
  const { app, page } = await launchTenon({ userData, env: COUNT_ROUTES })
  try {
    const modes = page.getByTestId('mode-switch')
    const block = page.getByTestId('composer-send-block')
    const sendButton = page.getByTestId('composer-send')
    const input = page.getByTestId('composer-input')
    await expect(modes).toHaveAttribute('data-profile', 'chat')
    await expect(page.getByTestId('model-menu-current')).toHaveText('qwen3:8b')
    await input.fill('what can you do?')
    // A text conversation on it is fine.
    await expect(sendButton).toBeEnabled()
    await expect(block).toHaveCount(0)

    await page.getByTestId('mode-cowork').click()
    await expect(modes).toHaveAttribute('data-profile', 'cowork')
    await expect(block).toHaveAttribute('data-reason', 'textOnlyTask')
    await expect(block).toHaveText('这个模型不能用工具，不能执行任务。请换一个模型。')
    await expect(sendButton).toBeDisabled()
    // The reason is the button's description, not just text nearby.
    await expect(sendButton).toHaveAttribute('aria-describedby', 'composer-send-block')
    // Neither key sends it either.
    await input.fill('what can you do?')
    await input.press('Enter')
    await input.press('ControlOrMeta+Enter')
    await page.waitForTimeout(300)
    expect(await routeCalls(app, 'chat.send')).toBe(0)
    expect(await routeCalls(app, 'chat.sendNow')).toBe(0)
    await expect(page.getByTestId('user-message')).toHaveCount(0)
    expect(server.requests).toHaveLength(0)

    await page.getByTestId('mode-chat').click()
    await expect(modes).toHaveAttribute('data-profile', 'chat')
    await expect(block).toHaveCount(0)
    await input.fill('what can you do?')
    await expect(sendButton).toBeEnabled()
    await input.press('Enter')
    await expect(page.getByTestId('user-text')).toHaveText('what can you do?')
    await expect(page.getByTestId('assistant-text')).toHaveText('local answer')
    expect(await routeCalls(app, 'chat.send')).toBe(1)
    expect(server.requests).toHaveLength(1)
    // A text conversation: no tools went out with it.
    expect(server.requests[0]?.body).not.toHaveProperty('tools')
  } finally {
    await app.close()
  }
})

// The mode switch changes the profile without the model menu, and the model in effect is that
// profile's default until one is chosen (§模型菜单与输入框): the menu follows the switch, so 「发送」
// is judged against the model the task would actually run on.
test('the model menu follows the mode switch: a task on its own verified default may send, though the chat’s model is text-only (§模型菜单与输入框「提示与禁发」)', async () => {
  ollama = await startFakeOpenAI({ chunks: ['local ', 'answer'], delayMs: 5 })
  anthropic = await startFakeAnthropic({ chunks: ['ok'], delayMs: 5 })
  const userData = makeUserDataDir('composer-profile-defaults')
  seedConfig(userData, {
    locale: 'en',
    provider: { id: 'ollama', modelId: 'qwen3:8b' },
    providerConfig: { ollama: { baseURL: ollama.baseURL } },
  })
  const file = configPathIn(userData)
  const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  config['defaultModelByProfile'] = {
    chat: { id: 'ollama', modelId: 'qwen3:8b' },
    cowork: { id: 'anthropic', modelId: 'claude-opus-5-5' },
  }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  const { app, page } = await launchTenon({
    userData,
    env: { ANTHROPIC_BASE_URL: anthropic.baseURL, ANTHROPIC_API_KEY: 'e2e-anthropic-key' },
  })
  try {
    const modes = page.getByTestId('mode-switch')
    const current = page.getByTestId('model-menu-current')
    const block = page.getByTestId('composer-send-block')
    const sendButton = page.getByTestId('composer-send')
    await page.getByTestId('composer-input').fill('what can you do?')
    await expect(current).toHaveText('qwen3:8b')
    await expect(sendButton).toBeEnabled()

    await page.getByTestId('mode-cowork').click()
    await expect(modes).toHaveAttribute('data-profile', 'cowork')
    await expect(current).toHaveText('claude-opus-5-5 · Medium')
    await expect(block).toHaveCount(0)
    await expect(sendButton).toBeEnabled()

    await page.getByTestId('mode-chat').click()
    await expect(modes).toHaveAttribute('data-profile', 'chat')
    await expect(current).toHaveText('qwen3:8b')
    await expect(block).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('Esc in the composer stops a Run whose answer has not begun, and sends nothing typed there (§模型菜单与输入框「停止与发送」)', async () => {
  const hold = deferred()
  // The stream opens and says nothing until the test lets it (it never does).
  anthropic = await startFakeAnthropic({
    replies: [
      {
        steps: [
          { type: 'wait', until: hold.promise },
          { type: 'text', text: 'never shown' },
        ],
      },
    ],
  })
  const server = anthropic
  const userData = makeUserDataDir('composer-esc')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await recordPushes(app)
    await send(page, 'think first')
    await expect(page.getByTestId('composer-stop')).toBeVisible()
    await expect.poll(() => server.requests.length).toBe(1)
    // The next message half typed while it waits: Esc is still the stop, not a send or a queue.
    const input = page.getByTestId('composer-input')
    await input.fill('then this')
    await expect(input).toBeFocused()
    await page.keyboard.press('Escape')

    await expect.poll(() => endCodes(app)).toEqual(['user-stopped'])
    expect(await routeCalls(app, 'chat.stop')).toBe(1)
    await expect.poll(() => server.aborted).toBe(true)
    await expect(page.getByTestId('composer-stop')).toHaveCount(0)
    expect(await routeCalls(app, 'chat.send')).toBe(1)
    expect(await routeCalls(app, 'chat.sendNow')).toBe(0)
    await expect(page.getByTestId('queued-bubble')).toHaveCount(0)
    // The Run wrote nothing: its end goes on a turn of its own, under the message it stopped.
    await expect(page.getByTestId('failure-card')).toHaveAttribute('data-code', 'user-stopped')
    expect(await threadOrder(page)).toEqual(['user: think first', 'end: user-stopped'])

    // Nothing left to stop: another Esc sends no stop.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    expect(await routeCalls(app, 'chat.stop')).toBe(1)
    expect(server.requests).toHaveLength(1)
  } finally {
    hold.resolve()
    await app.close()
  }
})
