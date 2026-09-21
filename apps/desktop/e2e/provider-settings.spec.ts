import { expect, test } from '@playwright/test'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { startFakeOpenAI } from '../test/support/fake-openai.js'
import type { FakeOpenAI } from '../test/support/fake-openai.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'

/**
 * Acceptance 6 in the real shell: switch the provider in the settings card, type a key, save —
 * and the NEXT message goes to the other wire, with what was typed in its Authorization header.
 *
 * Two endpoints stand side by side for the whole run, so "it went to the new one" is not an
 * absence of evidence: the Anthropic fake is still listening and still counts its requests.
 *
 * Credentials travel through the card into `TENON_SECRETS=memory` (the e2e seam): nothing here
 * touches the OS keychain, and nothing here is a real key.
 */
const ZHIPU_KEY = 'e2e-zhipu-key-4c81'
const ZHIPU_MODEL = 'glm-4.6'

let anthropic: FakeAnthropic | undefined
let zhipu: FakeOpenAI | undefined

test.afterEach(async () => {
  await anthropic?.close()
  await zhipu?.close()
  anthropic = undefined
  zhipu = undefined
})

test('acceptance 6: the settings card switches the provider the next message goes to', async () => {
  anthropic = await startFakeAnthropic({ chunks: ['from ', 'anthropic'], delayMs: 10 })
  zhipu = await startFakeOpenAI({ chunks: ['from ', 'zhipu'], delayMs: 10 })
  const first = anthropic
  const second = zhipu
  const userData = makeUserDataDir('provider-card')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ANTHROPIC_BASE_URL: first.baseURL, ANTHROPIC_API_KEY: 'e2e-anthropic-key' },
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
    // Focus starts on the first field, not on the footer: the card mounts before `provider.list`
    // answers, so without the hand-off the dialog would park it on Cancel.
    await expect(page.getByTestId('provider-select')).toBeFocused()

    // Everything below is rendered from `provider.list`: the option, both fields and the model
    // list come from the zhipu DEFINITION, not from any renderer code naming it.
    await page.getByTestId('provider-select').selectOption('zhipu')
    await expect(page.getByTestId('provider-status-apiKey')).toHaveText('No key stored yet.')
    // Endpoint first, key second: on a fresh profile the endpoint is judged before any credential
    // exists, so this order is the one where an over-eager refusal would show up.
    await page.getByTestId('provider-config-baseURL').fill(second.baseURL)
    await page.getByTestId('provider-config-apiKey').fill(ZHIPU_KEY)
    await page.getByTestId('model-select').selectOption(ZHIPU_MODEL)
    await page.getByTestId('provider-save').click()
    await expect(card).toBeHidden()

    await page.getByTestId('composer-input').fill('and now?')
    await page.keyboard.press('Enter')
    await expect(
      page.getByTestId('assistant-message').nth(1).getByTestId('assistant-text'),
    ).toHaveText('from zhipu')

    // The request landed on the OpenAI-compatible endpoint, with the key that was typed.
    expect(second.requests).toHaveLength(1)
    const request = second.requests[0]
    expect(request?.path).toBe('/v1/chat/completions')
    expect(request?.headers['authorization']).toBe(`Bearer ${ZHIPU_KEY}`)
    expect(request?.body).toMatchObject({ model: ZHIPU_MODEL, stream: true })
    const body = request?.body as { messages: Array<{ role: string }> }
    expect(body.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    // ...and the endpoint it used to go to saw nothing more.
    expect(first.requests).toHaveLength(1)

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
  const { app, page } = await launchTenon({
    userData,
    env: { ANTHROPIC_BASE_URL: anthropic.baseURL, ANTHROPIC_API_KEY: 'e2e-anthropic-key' },
  })

  try {
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    // This wire appends its own /v1, so a base URL that already ends in one would 404 on every
    // request. The definition refuses it; the card says so and stays open with the text in it.
    // The endpoint goes in ALONE and on a fresh profile, which is the case a credential check
    // could hide: both wires validate their credentials before their base URL, so a provider
    // whose key is not stored yet must still have its URL judged.
    await page.getByTestId('provider-config-baseURL').fill('https://gateway.example/v1')
    await page.getByTestId('provider-save').click()
    const error = page.getByTestId('provider-error')
    await expect(error).toHaveAttribute('data-error-code', 'invalid-value')
    await expect(error).toHaveText('That value cannot be used. Check it and try again.')
    await expect(page.getByTestId('provider-settings')).toBeVisible()
    // Pointed at the field that was written — the endpoint, not whichever key name the message
    // happens to contain.
    await expect(page.getByTestId('provider-config-baseURL')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
  } finally {
    await app.close()
  }
})
