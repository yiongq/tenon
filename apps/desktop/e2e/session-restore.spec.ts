import { expect, test } from '@playwright/test'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'

/**
 * Acceptance 5: restart the desktop and the last conversation is still there — on screen AND in
 * the request the next message produces. The second half is the one that matters: a transcript
 * the user can see but the model cannot is exactly the drift phase 0's in-memory `history` Map
 * was living proof of.
 *
 * It is also the Electron half of acceptance 20: every message here round-trips through
 * `sessions.db`, so a `better-sqlite3` that failed to load inside the main process would fail
 * this spec rather than pass silently.
 */
let fake: FakeAnthropic | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
})

function providerEnv(baseURL: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'e2e-test-key' }
}

test('a conversation survives a restart, on screen and on the wire', async () => {
  fake = await startFakeAnthropic({ chunks: ['Noted', '.'], delayMs: 10 })
  const server = fake
  const userData = makeUserDataDir('session-restore')
  seedConfig(userData, { locale: 'en' })

  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await first.page.getByTestId('composer-input').fill('my codeword is tenon-42')
    await first.page.keyboard.press('Enter')
    await expect(
      first.page.getByTestId('assistant-message').getByTestId('assistant-text'),
    ).toHaveText('Noted.')
  } finally {
    await first.app.close()
  }

  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    // Restored from sessions.db, not from any process that is still running.
    await expect(second.page.getByTestId('user-message').getByTestId('user-text')).toHaveText(
      'my codeword is tenon-42',
    )
    await expect(
      second.page.getByTestId('assistant-message').getByTestId('assistant-text'),
    ).toHaveText('Noted.')

    await second.page.getByTestId('composer-input').fill('what was it?')
    await second.page.keyboard.press('Enter')
    await expect(second.page.getByTestId('user-message')).toHaveCount(2)
    await expect(second.page.getByTestId('assistant-message').nth(1)).toBeVisible()

    // The model is handed the whole conversation, the pre-restart turns included.
    const body = server.requests.at(-1)?.body as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(body.messages[0]?.content)).toContain('tenon-42')
    expect(JSON.stringify(body.messages[1]?.content)).toContain('Noted.')

    // ...and "New Chat" still means a new chat. macOS keeps the menu bar alive after the last
    // window closes, so the item opens a window — which must NOT restore what was just left.
    // Only there: elsewhere the last window closing quits the app (index.ts window-all-closed).
    if (process.platform === 'darwin') {
      await second.app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) win.close()
      })
      // A closing window is still in `getAllWindows()` until it is destroyed, and main sends
      // `chat.new` to the first window it finds: wait for there to be none.
      await expect
        .poll(() =>
          second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        )
        .toBe(0)
      const opening = second.app.waitForEvent('window')
      await second.app.evaluate(({ Menu }) => {
        const file = Menu.getApplicationMenu()?.items.find((item) => item.label === 'File')
        const newChat = file?.submenu?.items.find((item) => item.label === 'New Chat')
        if (!newChat) throw new Error('File > New Chat is not in the menu')
        newChat.click()
      })
      const fresh = await opening
      await expect(fresh.getByTestId('thread-empty')).toBeVisible()
      await expect(fresh.getByTestId('user-message')).toHaveCount(0)
    }
  } finally {
    await second.app.close()
  }
})

test('another profile does not see that conversation', async () => {
  fake = await startFakeAnthropic({ chunks: ['ok'], delayMs: 5 })
  const server = fake
  const mine = makeUserDataDir('profile-a')
  seedConfig(mine, { locale: 'en' })

  const first = await launchTenon({ userData: mine, env: providerEnv(server.baseURL) })
  try {
    await first.page.getByTestId('composer-input').fill('private note')
    await first.page.keyboard.press('Enter')
    await expect(
      first.page.getByTestId('assistant-message').getByTestId('assistant-text'),
    ).toHaveText('ok')
  } finally {
    await first.app.close()
  }

  const other = makeUserDataDir('profile-b')
  seedConfig(other, { locale: 'en' })
  const second = await launchTenon({ userData: other, env: providerEnv(server.baseURL) })
  try {
    // A different profile root is a different sessions.db: nothing to restore, and the empty
    // state is what that looks like.
    await expect(second.page.getByTestId('thread-empty')).toBeVisible()
    await expect(second.page.getByTestId('user-message')).toHaveCount(0)
  } finally {
    await second.app.close()
  }
})
