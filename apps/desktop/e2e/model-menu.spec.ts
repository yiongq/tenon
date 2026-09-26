import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { startFakeOpenAI } from '../test/support/fake-openai.js'
import type { FakeOpenAI } from '../test/support/fake-openai.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'

/**
 * The model menu in the real shell (spec 02 §模型菜单与输入框; plan step 19: 旧 38, 旧 39, the menu
 * half of 旧 186 and 旧 37). A fake endpoint stands in for each provider that is sent to; zhipu keeps
 * its public default host, so the confirmation before history leaves this computer can be seen —
 * nothing here sends to it.
 */
let anthropic: FakeAnthropic | undefined
let ollama: FakeOpenAI | undefined

test.afterEach(async () => {
  await anthropic?.close()
  await ollama?.close()
  anthropic = undefined
  ollama = undefined
})

test('lists configured providers by host, greys the rest, and names the thinking level (旧 39, 旧 186)', async () => {
  anthropic = await startFakeAnthropic({ chunks: ['ok'], delayMs: 5 })
  const userData = makeUserDataDir('model-menu')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ANTHROPIC_BASE_URL: anthropic.baseURL, ANTHROPIC_API_KEY: 'e2e-anthropic-key' },
  })
  try {
    // Nothing chosen: the first row, and its default level.
    await expect(page.getByTestId('model-menu-current')).toHaveText('claude-sonnet-5 · High')
    await page.getByTestId('model-menu-trigger').click()
    const menu = page.getByTestId('model-menu')
    await expect(menu).toBeVisible()
    // The fake endpoint is on this computer; Ollama's default is too.
    await expect(page.getByTestId('model-row-anthropic-claude-sonnet-5')).toContainText(
      'This computer',
    )
    await expect(page.getByTestId('model-row-ollama-qwen3:8b')).toContainText(
      'This computer · text conversation only',
    )
    // No key for zhipu: one greyed row that opens the settings card, no zhipu model to pick.
    await expect(page.getByTestId('model-unconfigured-zhipu')).toHaveText(
      'Zhipu GLM · Add a key in Settings',
    )
    await expect(page.locator('[data-testid^="model-row-zhipu-"]')).toHaveCount(0)
    // Opus 5 waits under 更多模型 ›, not in the main list.
    await expect(page.getByTestId('model-row-anthropic-claude-opus-5')).toHaveCount(0)
    // Haiku thinks on a budget: once chosen, no thinking submenu.
    await page.getByTestId('model-row-anthropic-claude-haiku-4-5-20251001').click()
    await expect(page.getByTestId('model-menu-current')).toHaveText('claude-haiku-4-5-20251001')
    await page.getByTestId('model-menu-trigger').click()
    await expect(page.getByTestId('model-effort')).toHaveCount(0)
    await page.getByTestId('model-unconfigured-zhipu').click()
    await expect(page.getByTestId('provider-settings')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('asks before history on this computer goes to a public host, and can open a new chat instead (旧 38)', async () => {
  ollama = await startFakeOpenAI({ chunks: ['local ', 'answer'], delayMs: 5 })
  const userData = makeUserDataDir('model-confirm')
  seedConfig(userData, {
    locale: 'en',
    provider: { id: 'ollama', modelId: 'qwen3:8b' },
    providerConfig: { ollama: { baseURL: ollama.baseURL } },
  })
  const { app, page } = await launchTenon({ userData, env: { ZHIPU_API_KEY: 'e2e-zhipu-key' } })
  try {
    await page.getByTestId('composer-input').fill('keep this local')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-message').getByTestId('assistant-text')).toHaveText(
      'local answer',
    )
    expect(ollama.requests).toHaveLength(1)
    // An Ollama request never carries tools (旧 41).
    expect(ollama.requests[0]?.body).not.toHaveProperty('tools')

    await page.getByTestId('model-menu-trigger').click()
    await page.getByTestId('model-row-zhipu-glm-5.3-flash').click()
    // The menu turns into the confirmation, in place: no native dialog.
    await expect(page.getByTestId('model-confirm')).toContainText(
      'Earlier messages will be sent to open.bigmodel.cn',
    )
    // Backing out leaves the session's choice as it was (旧 185).
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('model-menu')).toBeHidden()
    await expect(page.getByTestId('model-menu-current')).toHaveText('qwen3:8b')
    await page.getByTestId('model-menu-trigger').click()
    await page.getByTestId('model-row-zhipu-glm-5.3-flash').click()
    await page.getByTestId('model-confirm-new-chat').click()
    // A new, empty chat on the new model; the old one sent nothing more anywhere.
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await expect(page.getByTestId('model-menu-current')).toHaveText('glm-5.3-flash · Max')
    expect(ollama.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('writes the default model only when the card’s model field changed (旧 187)', async () => {
  const userData = makeUserDataDir('model-card')
  seedConfig(userData, { locale: 'en', provider: { id: 'anthropic', modelId: 'claude-opus-5-5' } })
  const { app, page } = await launchTenon({ userData })
  try {
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    await page.getByTestId('provider-select').selectOption('zhipu')
    await page.getByTestId('provider-config-apiKey').fill('e2e-zhipu-key')
    await page.getByTestId('provider-save').click()
    await expect(page.getByTestId('provider-settings')).toBeHidden()
    const untouched = (await page.evaluate(() => window.tenon.invoke('config.get', {}))) as {
      data: { provider: unknown; defaultModelByProfile: unknown }
    }
    expect(untouched.data.provider).toEqual({ id: 'anthropic', modelId: 'claude-opus-5-5' })
    expect(untouched.data.defaultModelByProfile).toEqual({})
    // Changing the field writes both profiles' defaults and `provider`.
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    await page.getByTestId('provider-select').selectOption('zhipu')
    await page.getByTestId('model-select').selectOption('glm-5.3-flash')
    await page.getByTestId('provider-save').click()
    await expect(page.getByTestId('provider-settings')).toBeHidden()
    const changed = (await page.evaluate(() => window.tenon.invoke('config.get', {}))) as {
      data: { provider: unknown; defaultModelByProfile: unknown }
    }
    const selection = { id: 'zhipu', modelId: 'glm-5.3-flash' }
    expect(changed.data.provider).toEqual(selection)
    expect(changed.data.defaultModelByProfile).toEqual({ chat: selection, cowork: selection })
  } finally {
    await app.close()
  }
})

test('keeps a default per profile: a new session in each starts on it (旧 37)', async () => {
  anthropic = await startFakeAnthropic({ chunks: ['ok'], delayMs: 5 })
  const userData = makeUserDataDir('model-profiles')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ANTHROPIC_BASE_URL: anthropic.baseURL, ANTHROPIC_API_KEY: 'e2e-anthropic-key' },
  })
  try {
    // The chat on screen chooses X in the menu.
    await page.getByTestId('model-menu-trigger').click()
    await page.getByTestId('model-row-anthropic-claude-opus-5-5').click()
    await expect(page.getByTestId('model-menu-current')).toHaveText('claude-opus-5-5 · Medium')
    // A task session (the mode switch arrives with step 20: chosen over IPC here) chooses Y.
    const choice = await page.evaluate(async () => {
      const task = crypto.randomUUID()
      const chat = crypto.randomUUID()
      await window.tenon.invoke('session.selectProfile', { sessionId: task, profile: 'cowork' })
      await window.tenon.invoke('session.selectModel', {
        sessionId: task,
        providerId: 'anthropic',
        modelId: 'claude-haiku-4-5-20251001',
        effort: null,
      })
      // New sessions of each profile start on that profile's default.
      const nextTask = crypto.randomUUID()
      await window.tenon.invoke('session.selectProfile', { sessionId: nextTask, profile: 'cowork' })
      return {
        task: await window.tenon.invoke('session.modelChoice', { sessionId: nextTask }),
        chat: await window.tenon.invoke('session.modelChoice', { sessionId: chat }),
      }
    })
    expect(choice.task).toMatchObject({ ok: true, data: { modelId: 'claude-haiku-4-5-20251001' } })
    expect(choice.chat).toMatchObject({ ok: true, data: { modelId: 'claude-opus-5-5' } })
  } finally {
    await app.close()
  }
})
