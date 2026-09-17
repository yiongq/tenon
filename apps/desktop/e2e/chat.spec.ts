import { expect, test } from '@playwright/test'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'

/**
 * Acceptance 4 in the real shell, against a local Anthropic-compatible endpoint: the reply
 * streams into the thread, Stop aborts the request down to the socket, provider failures
 * show localized copy chosen by error code, and the page never violates its CSP.
 */
let fake: FakeAnthropic | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
})

function providerEnv(baseURL: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'e2e-test-key' }
}

test('a reply streams into the thread as rendered markdown', async () => {
  fake = await startFakeAnthropic({
    chunks: ['Hello ', '**world**', ' from ', 'Tenon'],
    delayMs: 30,
  })
  const userData = makeUserDataDir('chat-stream')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await page.addInitScript(() => {
      const store = globalThis as unknown as { cspViolations: string[] }
      store.cspViolations = []
      document.addEventListener('securitypolicyviolation', (event) => {
        store.cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`)
      })
    })
    await page.reload()
    await page.getByTestId('app-root').waitFor()

    await page.getByTestId('composer-input').fill('hi')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('user-message').getByTestId('user-text')).toHaveText('hi')
    await expect(page.getByTestId('assistant-message').getByTestId('assistant-text')).toHaveText(
      'Hello world from Tenon',
    )
    await expect(page.getByTestId('composer-send')).toBeVisible()

    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.body).toMatchObject({ stream: true, messages: [{ role: 'user' }] })
    const violations = await page.evaluate(
      () => (globalThis as unknown as { cspViolations: string[] }).cspViolations,
    )
    expect(violations).toEqual([])
  } finally {
    await app.close()
  }
})

test('Stop aborts the in-flight reply down to the socket and keeps the partial text', async () => {
  // Far longer than the test needs (30 s): Stop must find the reply still streaming even on
  // a slow CI runner. The abort ends the stream early, so the test never waits for it.
  const chunks = Array.from({ length: 600 }, (_, i) => `word${String(i)} `)
  fake = await startFakeAnthropic({ chunks, delayMs: 50 })
  const userData = makeUserDataDir('chat-stop')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await page.getByTestId('composer-input').fill('go')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-message').getByTestId('assistant-text')).toContainText(
      'word2',
    )
    await page.getByTestId('composer-cancel').click()

    const server = fake
    await expect.poll(() => server.aborted, { timeout: 5000 }).toBe(true)
    expect(server.chunksSent).toBeLessThan(chunks.length)
    await expect(page.getByTestId('composer-send')).toBeVisible()
    await expect(page.getByTestId('assistant-message').getByTestId('assistant-text')).toContainText(
      'word0',
    )
  } finally {
    await app.close()
  }
})

test('a provider failure shows localized copy chosen by its error code', async () => {
  fake = await startFakeAnthropic({
    chunks: [],
    failWith: { status: 401, type: 'authentication_error', message: 'invalid x-api-key' },
  })
  const userData = makeUserDataDir('chat-error')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await page.getByTestId('composer-input').fill('hi')
    await page.keyboard.press('Enter')
    const error = page.getByTestId('message-error')
    await expect(error).toHaveAttribute('data-error-code', 'auth')
    await expect(error.getByTestId('message-error-text')).toHaveText(
      'API 密钥被拒绝，请检查供应商设置。',
    )
    await expect(error.getByTestId('message-retry')).toHaveText('重试')
  } finally {
    await app.close()
  }
})

test('Retry re-sends the failed turn once and the reply then streams', async () => {
  fake = await startFakeAnthropic({
    chunks: ['All ', 'good'],
    delayMs: 20,
    // 400 is not retried by the SDK, so the failure reaches the UI as an error card.
    failWith: { status: 400, type: 'invalid_request_error', message: 'boom' },
    failTimes: 1,
  })
  const userData = makeUserDataDir('chat-retry')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await page.getByTestId('composer-input').fill('question')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('message-error')).toHaveAttribute('data-error-code', 'provider')
    await page.getByTestId('message-retry').click()
    await expect(page.getByTestId('assistant-message').getByTestId('assistant-text')).toHaveText(
      'All good',
    )
    const last = fake.requests.at(-1)?.body as { messages: Array<{ role: string }> }
    expect(last.messages.map((m) => m.role)).toEqual(['user'])
  } finally {
    await app.close()
  }
})
