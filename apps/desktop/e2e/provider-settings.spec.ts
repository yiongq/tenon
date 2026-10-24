import type { Config, IpcResult } from '@tenon-app/contracts'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { startFakeOpenAI } from '../test/support/fake-openai.js'
import type { FakeOpenAI } from '../test/support/fake-openai.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { COUNT_ROUTES, newChatFromSidebar, routeCalls } from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import { ANTHROPIC_ORIGIN, ZHIPU_ORIGIN, originMap, providerEnv } from './helpers/tools.js'

/**
 * Acceptance 6 in the real shell: switch the provider in the settings card, type a key, save —
 * and a NEW chat goes to the other wire, with what was typed in its Authorization header.
 *
 * Two endpoints stand side by side for the whole run, so "it went to the new one" is not an
 * absence of evidence: the Anthropic fake is still listening and still counts its requests. Both
 * providers keep their official addresses — the only ones they take (M6 §点名 (a)) — and the origin
 * map test seam sends each to its fake.
 *
 * Credentials travel through the card into `TENON_SECRETS=memory` (the e2e seam): nothing here
 * touches the OS keychain, and nothing here is a real key.
 */
const ZHIPU_KEY = 'e2e-zhipu-key-4c81'
const ZHIPU_MODEL = 'glm-4.6'
/**
 * The zhipu reply in two halves, with the fake holding the second one back. Distinctive strings
 * rather than words, so "visible" cannot be a coincidence of some other copy on the page.
 */
const ZHIPU_HEAD = 'zhipu-head-8f2a'
const ZHIPU_TAIL = 'zhipu-tail-31d7'

let anthropic: FakeAnthropic | undefined
let zhipu: FakeOpenAI | undefined

test.afterEach(async () => {
  await anthropic?.close()
  await zhipu?.close()
  anthropic = undefined
  zhipu = undefined
})

test('claude-5-5-models 验收 15、acceptance 6: settings change new chats while the running session keeps its provider', async () => {
  anthropic = await startFakeAnthropic({ chunks: ['from ', 'anthropic'], delayMs: 10 })
  zhipu = await startFakeOpenAI({
    chunks: [`${ZHIPU_HEAD} `, ZHIPU_TAIL],
    delayMs: 10,
    holdAfter: 1,
  })
  const first = anthropic
  const second = zhipu
  const userData = makeUserDataDir('provider-card')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: providerEnv(first.baseURL, { [ZHIPU_ORIGIN]: second.baseURL }),
  })

  try {
    // Phase 0's path, on the default provider: still the thing that works before anything is set.
    await page.getByTestId('composer-input').fill('hello')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-message').getByTestId('assistant-text')).toHaveText(
      'from anthropic',
    )
    expect(first.requests).toHaveLength(1)

    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    const card = page.getByTestId('provider-settings')
    await expect(card).toBeVisible()
    // Focus rests on the dialog itself: no field wears a focus ring before the user touches one.
    await expect(card).toBeFocused()
    await expect(page.getByTestId('provider-select')).not.toBeFocused()

    // Everything below is rendered from `provider.list`: the option, both fields and the model
    // list come from the zhipu DEFINITION, not from any renderer code naming it.
    await page.getByTestId('provider-select').selectOption('zhipu')
    await expect(page.getByTestId('provider-status-apiKey')).toHaveText('No key stored yet.')
    // The endpoint stays zhipu's official one: the key is all there is to type.
    await page.getByTestId('provider-config-apiKey').fill(ZHIPU_KEY)
    await page.getByTestId('model-select').selectOption(ZHIPU_MODEL)
    // Named as the model menu and its chip name it; the raw id is the tooltip.
    const chosen = page.getByTestId('model-select').locator('option:checked')
    await expect(chosen).toHaveText('GLM-4.6')
    await expect(chosen).toHaveAttribute('title', ZHIPU_MODEL)
    await page.getByTestId('provider-save').click()
    await expect(card).toBeHidden()

    await page.getByTestId('composer-input').fill('still here?')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-text').nth(1)).toHaveText('from anthropic')
    expect(first.requests).toHaveLength(2)
    expect(second.requests).toHaveLength(0)
    await newChatFromSidebar(page)
    await page.getByTestId('composer-input').fill('and now?')
    await page.keyboard.press('Enter')
    const reply = page.getByTestId('assistant-message').getByTestId('assistant-text')
    // 并流式渲染 on THIS wire, not just "the right text arrived": the fake is holding the tail on
    // its side of the socket, so the head is on screen at a moment when the rest of the reply
    // does not exist anywhere. Catches a main process that buffered `text-delta` events until the
    // terminal one — which the final-text assertion below would happily pass.
    await expect(reply).toHaveText(ZHIPU_HEAD)
    expect(second.chunksSent).toBe(1)
    second.release()
    await expect(reply).toHaveText(`${ZHIPU_HEAD} ${ZHIPU_TAIL}`)

    // The request landed on the OpenAI-compatible endpoint, with the key that was typed.
    expect(second.requests).toHaveLength(1)
    const request = second.requests[0]
    expect(request?.path).toBe('/api/paas/v4/chat/completions')
    expect(request?.headers['authorization']).toBe(`Bearer ${ZHIPU_KEY}`)
    expect(request?.body).toMatchObject({ model: ZHIPU_MODEL, stream: true })
    const body = request?.body as { messages: Array<{ role: string }> }
    // The system text leads on this wire; the first turn's environment note follows it (spec 02).
    expect(body.messages.map((message) => message.role)).toEqual(['system', 'user', 'user'])
    // The established session stayed on Anthropic; only the fresh chat used Zhipu.
    expect(first.requests).toHaveLength(2)

    // The key is stored, and `provider.list` says so without carrying it: the raw IPC result,
    // searched for what was typed.
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    await expect(page.getByTestId('provider-status-apiKey')).toHaveText(
      'A key is stored. Type a new one to replace it.',
    )
    await expect(page.getByTestId('provider-config-apiKey')).toHaveValue('')
    // Emptying a stored key deletes it on save, so the field says so BEFORE the save rather than
    // leaving the user with a provider that answers 401 on the next message.
    await page.getByTestId('provider-config-apiKey').fill('x')
    await page.getByTestId('provider-config-apiKey').fill('')
    await expect(page.getByTestId('provider-status-apiKey')).toHaveText(
      'Cleared: saving removes the stored key.',
    )
    const listed = await page.evaluate(() => window.tenon.invoke('provider.list', {}))
    expect(JSON.stringify(listed)).not.toContain(ZHIPU_KEY)
    expect(JSON.stringify(listed)).toContain('"configured":true')
  } finally {
    await app.close()
  }
})

test('a base URL this wire cannot use is reported in the card, not as a crash', async () => {
  anthropic = await startFakeAnthropic({ chunks: ['unused'] })
  const userData = makeUserDataDir('provider-card-invalid')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(anthropic.baseURL) })

  try {
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    // This wire appends its own /v1, so a base URL that already ends in one would 404 on every
    // request. The definition refuses it; the card says so and stays open with the text in it.
    // The endpoint goes in ALONE and on a fresh profile, which is the case a credential check
    // could hide: both wires validate their credentials before their base URL, so a provider
    // whose key is not stored yet must still have its URL judged.
    const baseURL = page.getByTestId('provider-config-baseURL')
    await baseURL.fill('https://api.anthropic.com/v1')
    await page.getByTestId('provider-save').click()
    const error = page.getByTestId('provider-error')
    await expect(error).toHaveAttribute('data-error-code', 'invalid-value')
    await expect(error).toHaveText('That value cannot be used. Check it and try again.')
    await expect(page.getByTestId('provider-settings')).toBeVisible()
    // Pointed at the field that was written — the endpoint, not whichever key name the message
    // happens to contain.
    await expect(baseURL).toHaveAttribute('aria-invalid', 'true')
    // Another endpoint altogether is a custom vendor's (M6 §点名 (a), 验收 26): refused with its
    // own copy, before the definition is asked.
    await baseURL.fill('https://gateway.example')
    await page.getByTestId('provider-save').click()
    await expect(error).toHaveAttribute('data-error-code', 'official-host-only')
    await expect(error).toHaveText(
      'A built-in provider only takes its official address; this address can only be added as a custom provider.',
    )
    await expect(baseURL).toHaveAttribute('aria-invalid', 'true')
    expect(anthropic.requests).toHaveLength(0)
  } finally {
    await app.close()
  }
})

test('M6 regression: saving keeps settings open on Escape and disables pane switching; hash preserves context', async () => {
  const userData = makeUserDataDir('settings-busy')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  try {
    await app.evaluate(({ ipcMain }) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => Promise<unknown>
      >
      const original = handlers.get('provider.configure')!
      handlers.set('provider.configure', async (...args) => {
        await new Promise<void>((done) => {
          ;(globalThis as { finishProviderSave?: () => void }).finishProviderSave = done
        })
        return original(...args)
      })
    })
    await page.evaluate(() => {
      window.location.hash = '#context'
    })
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    await expect(page.getByTestId('settings-providers')).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#settings/providers')
    await page.getByTestId('provider-config-apiKey').fill('e2e-fixture-key')
    await page.getByTestId('provider-save').click()
    await expect(page.getByTestId('settings-connectors')).toBeDisabled()
    await page.keyboard.press('Escape')
    // Keep the IPC write held beyond the dialog exit animation; immediate visibility can race it.
    await page.waitForTimeout(350)
    await expect(page.getByTestId('provider-settings')).toBeVisible()
    await app.evaluate(() =>
      (globalThis as { finishProviderSave?: () => void }).finishProviderSave?.(),
    )
    await expect(page.getByTestId('provider-settings')).toBeHidden()
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#context')
    await page.evaluate(() => {
      window.location.hash = '#settings/connectors'
    })
    await expect(page.getByTestId('connectors-pane')).toBeVisible()
    await expect(page.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical')
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#context')
  } finally {
    await app.close()
  }
})

test('presentation-r1 验收 11: on a fresh profile the send button is off, says to add a key and offers only 去设置', async () => {
  anthropic = await startFakeAnthropic({ chunks: ['unused'] })
  const userData = makeUserDataDir('send-block-fresh')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({
    userData,
    env: {
      ...COUNT_ROUTES,
      ...originMap({ [ANTHROPIC_ORIGIN]: anthropic.baseURL }),
    },
  })
  try {
    await expect(page.getByTestId('composer-send-block')).toHaveAttribute('data-reason', 'noKey')
    await expect(page.getByTestId('composer-block-reason')).toHaveText(
      '这个模型没有可用的 API 密钥。',
    )
    await expect(page.getByTestId('composer-settings')).toHaveText('去设置')
    await expect(page.getByTestId('composer-switch-model')).toHaveCount(0)
    await page.getByTestId('composer-input').fill('not sent')
    await expect(page.getByTestId('composer-send')).toBeDisabled()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Meta+Enter')
    await expect(page.getByTestId('composer-input')).toHaveValue('not sent')
    await expect(page.getByTestId('user-message')).toHaveCount(0)
    expect(await routeCalls(app, 'chat.send')).toBe(0)
    expect(await routeCalls(app, 'chat.sendNow')).toBe(0)
    expect(anthropic.requests).toHaveLength(0)
    await page.getByTestId('composer-settings').click()
    await expect(page.getByTestId('provider-settings')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('presentation-r1 验收 11: a default on a provider without a key offers 改用 <X> naming the provider and the model, with 发往 <host> as its tooltip and description, and in a new chat after it the message goes', async () => {
  anthropic = await startFakeAnthropic({ chunks: ['switched and sent'] })
  const server = anthropic
  const userData = makeUserDataDir('send-block-switch')
  seedConfig(userData, { locale: 'en', provider: { id: 'zhipu', modelId: 'glm-5.3-flash' } })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  try {
    await expect(page.getByTestId('composer-send-block')).toHaveAttribute(
      'data-reason',
      'modelUnusable',
    )
    const change = page.getByTestId('composer-switch-model')
    await expect(change).toHaveText('Switch to Anthropic Opus 5.5')
    await expect(change).toHaveAttribute('aria-describedby', /.+/)
    await expect(change).toHaveAccessibleDescription('Sends to api.anthropic.com')
    await change.hover()
    await expect(page.getByTestId('composer-switch-tooltip')).toHaveText(
      'Sends to api.anthropic.com',
    )
    await change.click()
    await expect(page.getByTestId('composer-send-block')).toHaveCount(0)
    await expect(page.getByTestId('model-menu-current')).toHaveText('Opus 5.5 · Medium')
    expect(await routeCalls(app, 'session.selectModel')).toBe(1)
    await newChatFromSidebar(page)
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await page.getByTestId('composer-input').fill('after switching')
    await expect(page.getByTestId('composer-send')).toBeEnabled()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-text')).toHaveText('switched and sent')
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('presentation-r1 验收 11: a key saved from 去设置 under the box updates the chip and the line when settings close', async () => {
  anthropic = await startFakeAnthropic({ chunks: ['key saved'] })
  const userData = makeUserDataDir('send-block-save')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: {
      ...originMap({ [ANTHROPIC_ORIGIN]: anthropic.baseURL }),
    },
  })
  try {
    await expect(page.getByTestId('composer-send-block')).toHaveAttribute('data-reason', 'noKey')
    await expect(page.getByTestId('model-menu-current')).toHaveText('Opus 5.5 · Medium')
    await page.getByTestId('composer-settings').click()
    await expect(page.getByTestId('provider-settings')).toBeVisible()
    await page.getByTestId('provider-config-apiKey').fill('e2e-saved-key')
    // Step 9 owns first-key defaults; here the dropdown is deliberately changed.
    await page.getByTestId('model-select').selectOption('claude-haiku-4-5-20251001')
    await page.getByTestId('provider-save').click()
    await expect(page.getByTestId('provider-settings')).toBeHidden()
    await expect(page.getByTestId('model-menu-current')).toHaveText('Haiku 4.5')
    await expect(page.getByTestId('composer-send-block')).toHaveCount(0)
    await page.getByTestId('composer-input').fill('with the saved key')
    await expect(page.getByTestId('composer-send')).toBeEnabled()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-text')).toHaveText('key saved')
  } finally {
    await app.close()
  }
})

test('claude-5-5-models 验收 19、presentation-r1 验收 12: fresh profile → save a key → the chip shows that provider’s first row → send goes', async () => {
  zhipu = await startFakeOpenAI({ chunks: ['first key reply'] })
  const server = zhipu
  const userData = makeUserDataDir('first-key-default')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: {
      ...COUNT_ROUTES,
      ...originMap({ [ZHIPU_ORIGIN]: server.baseURL }),
      TENON_PROVIDER: '',
      TENON_MODEL: '',
    },
  })
  try {
    await expect(page.getByTestId('composer-send-block')).toHaveAttribute('data-reason', 'noKey')
    await page.getByTestId('composer-settings').click()
    await expect(page.getByTestId('provider-settings')).toBeVisible()
    await page.getByTestId('provider-select').selectOption('zhipu')
    await page.getByTestId('provider-config-apiKey').fill(ZHIPU_KEY)
    // No model dropdown change: main, rather than provider.select, supplies the first row.
    await page.getByTestId('provider-save').click()
    await expect(page.getByTestId('provider-settings')).toBeHidden()
    await expect(page.getByTestId('model-menu-current')).toHaveText('GLM-5.3 · Max')
    await expect(page.getByTestId('composer-send-block')).toHaveCount(0)
    const config = await page.evaluate(() => window.tenon.invoke('config.get', {}))
    expect(config).toMatchObject({
      ok: true,
      data: {
        provider: { id: 'zhipu', modelId: 'glm-5.3', latestOf: 'glm' },
        defaultModelByProfile: {
          chat: { id: 'zhipu', modelId: 'glm-5.3', latestOf: 'glm' },
          cowork: { id: 'zhipu', modelId: 'glm-5.3', latestOf: 'glm' },
        },
      },
    })
    expect(await routeCalls(app, 'provider.select')).toBe(0)
    await newChatFromSidebar(page)
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await expect(page.getByTestId('model-menu-current')).toHaveText('GLM-5.3 · Max')
    await page.getByTestId('composer-input').fill('first saved key')
    await expect(page.getByTestId('composer-send')).toBeEnabled()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-text')).toHaveText('first key reply')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.body).toMatchObject({ model: 'glm-5.3' })
    expect(server.requests[0]?.headers['authorization']).toBe(`Bearer ${ZHIPU_KEY}`)
  } finally {
    await app.close()
  }
})

for (const locale of ['zh-CN', 'en'] as const) {
  test(`claude-5-5-models 验收 17: ${locale} settings list pointers first, preserve untouched defaults, save pointers and pinned rows`, async () => {
    anthropic = await startFakeAnthropic({ chunks: ['new default reply'] })
    const userData = makeUserDataDir(`provider-pointers-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData, env: providerEnv(anthropic.baseURL) })
    const open = async () => {
      await page.getByTestId('account-row').click()
      await page.getByTestId('account-providers').click()
      await expect(page.getByTestId('provider-settings')).toBeVisible()
    }
    const config = async () =>
      (await page.evaluate(() => window.tenon.invoke('config.get', {}))) as IpcResult<Config>
    try {
      await open()
      const select = page.getByTestId('model-select')
      const options = select.locator('option')
      await expect(options).toHaveCount(11)
      await expect(options).toHaveText(
        locale === 'en'
          ? [
              'Latest Opus (now Opus 5.5)',
              'Latest Sonnet (now Sonnet 5.5)',
              'Latest Haiku (now Haiku 5.5)',
              'Latest Fable (now Fable 5.1)',
              'Opus 5.5',
              'Sonnet 5.5',
              'Haiku 5.5',
              'Fable 5.1',
              'Opus 5',
              'Sonnet 5',
              'Haiku 4.5',
            ]
          : [
              '最新的 Opus（现在是 Opus 5.5）',
              '最新的 Sonnet（现在是 Sonnet 5.5）',
              '最新的 Haiku（现在是 Haiku 5.5）',
              '最新的 Fable（现在是 Fable 5.1）',
              'Opus 5.5',
              'Sonnet 5.5',
              'Haiku 5.5',
              'Fable 5.1',
              'Opus 5',
              'Sonnet 5',
              'Haiku 4.5',
            ],
      )
      const opusValue = await options.nth(0).getAttribute('value')
      const haikuValue = await options.nth(2).getAttribute('value')
      expect(opusValue).not.toBe('claude-opus-5-5')
      await expect(select).toHaveValue(opusValue!)
      await expect(options.nth(0)).toHaveAttribute('title', 'claude-opus-5-5')
      await page.getByTestId('provider-cancel').click()
      expect(
        await page.evaluate(() =>
          window.tenon.invoke('provider.select', { providerId: 'zhipu', modelId: 'glm-5.3-flash' }),
        ),
      ).toEqual({ ok: true, data: { ok: true } })
      const before = await config()
      await open()
      await page.getByTestId('provider-select').selectOption('anthropic')
      await expect(select).toHaveValue(opusValue!)
      await page.getByTestId('provider-config-apiKey').fill('e2e-pointer-key')
      await page.getByTestId('provider-save').click()
      await expect(page.getByTestId('provider-settings')).toBeHidden()
      const after = await config()
      if (!before.ok || !after.ok) throw new Error('config unavailable')
      expect(after.data.provider).toEqual(before.data.provider)
      expect(after.data.defaultModelByProfile).toEqual(before.data.defaultModelByProfile)
      await open()
      await page.getByTestId('provider-select').selectOption('anthropic')
      await select.selectOption(haikuValue!)
      await page.getByTestId('provider-save').click()
      await expect(page.getByTestId('provider-settings')).toBeHidden()
      const haiku = { id: 'anthropic', modelId: 'claude-haiku-5-5', latestOf: 'haiku' }
      expect(await config()).toMatchObject({
        ok: true,
        data: { provider: haiku, defaultModelByProfile: { chat: haiku, cowork: haiku } },
      })
      await newChatFromSidebar(page)
      await expect(page.getByTestId('model-menu-current')).toContainText('Haiku 5.5')
      await page.getByTestId('composer-input').fill('new default')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('assistant-text')).toHaveText('new default reply')
      expect(anthropic.requests[0]?.body).toMatchObject({ model: 'claude-haiku-5-5' })
      await open()
      await expect(select).toHaveValue(haikuValue!)
      await select.selectOption('claude-opus-5-5')
      await page.getByTestId('provider-save').click()
      await expect(page.getByTestId('provider-settings')).toBeHidden()
      const pinned = await config()
      if (!pinned.ok) throw new Error('config unavailable')
      const opus = { id: 'anthropic', modelId: 'claude-opus-5-5' }
      expect(pinned.data.provider).toEqual(opus)
      expect(pinned.data.defaultModelByProfile).toEqual({ chat: opus, cowork: opus })
      await open()
      await expect(select).toHaveValue('claude-opus-5-5')
      await page.getByTestId('provider-select').selectOption('ollama')
      await expect(options).toHaveCount(1)
      await expect(select).toHaveValue('qwen3:8b')
      await page.getByTestId('provider-cancel').click()
      expect(
        await page.evaluate(() =>
          window.tenon.invoke('provider.select', {
            providerId: 'anthropic',
            modelId: 'claude-sonnet-5',
          }),
        ),
      ).toEqual({ ok: true, data: { ok: true } })
      await open()
      await expect(select).toHaveValue('claude-sonnet-5')
    } finally {
      await app.close()
    }
  })
}
