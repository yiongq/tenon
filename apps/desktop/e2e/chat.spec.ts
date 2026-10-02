import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import { providerEnv } from './helpers/tools.js'

/**
 * Acceptance 4 in the real shell, against a local fake standing in for api.anthropic.com (the
 * origin map test seam, M6 §点名「测试接缝」): the reply
 * streams into the thread, Stop aborts the request down to the socket, provider failures
 * show localized copy chosen by error code, and the page never violates its CSP.
 */
let fake: FakeAnthropic | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
})

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
    // The message, then the environment note the Run writes before its first request (spec 02).
    expect(fake.requests[0]?.body).toMatchObject({
      stream: true,
      messages: [{ role: 'user' }, { role: 'user' }],
    })
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
    await page.getByTestId('composer-stop').click()

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

test('a rejected key ends the Run on a failure card that sends the user to settings', async () => {
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
    // A Run's failure reads its end code, never the error event's own code (spec 02 §失败卡与结束原因).
    const card = page.getByTestId('failure-card')
    await expect(card).toHaveAttribute('data-code', 'provider-error')
    await expect(card).toHaveAttribute('data-visual', 'danger')
    await expect(card.getByTestId('failure-what')).toHaveText('模型服务（anthropic）出错。')
    // A failure interrupts: an alert, as phase 1's error was (components.md LiveRegion).
    await expect(card).toHaveAttribute('role', 'alert')
    await expect(card.getByTestId('failure-effects')).toHaveText('没有执行任何操作。')
    const action = card.getByTestId('failure-action')
    await expect(action).toHaveAttribute('data-action', 'settings')
    await expect(action).toHaveText('去设置')
    // 401 is one request, never retried (spec 02 验收 16).
    expect(fake.requests).toHaveLength(1)
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
    const card = page.getByTestId('failure-card')
    await expect(card).toHaveAttribute('data-code', 'provider-error')
    // Started by a user message and nothing dispatched: 「重试」, which sends that message again.
    await expect(card.getByTestId('failure-action')).toHaveAttribute('data-action', 'retry')
    await card.getByTestId('failure-action').click()
    await expect(page.getByTestId('assistant-message').getByTestId('assistant-text')).toHaveText(
      'All good',
    )
    const last = fake.requests.at(-1)?.body as { messages: Array<{ role: string }> }
    // The same turn and its environment note, not a second turn.
    expect(last.messages.map((m) => m.role)).toEqual(['user', 'user'])
  } finally {
    await app.close()
  }
})
