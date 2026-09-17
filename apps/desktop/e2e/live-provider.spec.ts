import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { expect, test } from '@playwright/test'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'

/**
 * Acceptance 4 against a REAL endpoint. Opt-in (`pnpm test:live`): it needs credentials in
 * the repo-root `.env.local` and spends a few thousand tokens per run, so CI never runs it.
 */
const LIVE = process.env['TENON_LIVE'] === '1'
const ENV_FILE = resolve(process.cwd(), '../../.env.local')
/**
 * One key serves both manual use and these tests; what differs is the model. The tests read
 * their own `TENON_LIVE_*` settings first, so `TENON_MODEL` can stay on the model you like to
 * chat with while the suite runs on a cheap (or free) one. Replies are always capped.
 */
function liveEnv(): Record<string, string> {
  const fromFile = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {}
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = process.env[name] || fromFile[name]
      if (value) return value
    }
    return undefined
  }
  const wanted: Record<string, string | undefined> = {
    ANTHROPIC_BASE_URL: pick('ANTHROPIC_BASE_URL'),
    ANTHROPIC_AUTH_TOKEN: pick('TENON_LIVE_AUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'),
    ANTHROPIC_API_KEY: pick('ANTHROPIC_API_KEY'),
    TENON_MODEL: pick('TENON_LIVE_MODEL', 'TENON_MODEL'),
    TENON_MAX_TOKENS: pick('TENON_LIVE_MAX_TOKENS', 'TENON_MAX_TOKENS') ?? '2048',
  }
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(wanted)) {
    if (value !== undefined) env[name] = value
  }
  return env
}

test.describe('live provider', () => {
  test.skip(!LIVE, 'opt-in: run `pnpm test:live` with credentials in .env.local')
  test.describe.configure({ timeout: 180_000 })

  const env = LIVE ? liveEnv() : {}

  test.beforeAll(() => {
    expect(
      env['ANTHROPIC_AUTH_TOKEN'] ?? env['ANTHROPIC_API_KEY'],
      `no key found: fill in ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) in ${ENV_FILE}`,
    ).toBeTruthy()
  })

  async function open(tag: string): ReturnType<typeof launchTenon> {
    const userData = makeUserDataDir(`live-${tag}`)
    seedConfig(userData, { locale: 'en' })
    return launchTenon({ userData, env })
  }

  test('a real reply streams into the thread', async () => {
    const { app, page } = await open('stream')
    try {
      await page.getByTestId('composer-input').fill('Reply with the single word: pong')
      await page.keyboard.press('Enter')
      const reply = page.getByTestId('assistant-message').getByTestId('assistant-text')
      await expect(reply).toContainText(/pong/i, { timeout: 90_000 })
      await expect(page.getByTestId('composer-send')).toBeVisible({ timeout: 90_000 })
      await expect(page.getByTestId('message-error')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('the model sees the earlier turns of the same session', async () => {
    const { app, page } = await open('context')
    try {
      const input = page.getByTestId('composer-input')
      await input.fill('My codeword is tenon-42. Just answer: OK')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('composer-send')).toBeVisible({ timeout: 90_000 })
      await expect(page.getByTestId('assistant-message')).toHaveCount(1)

      await input.fill('What is my codeword? Answer with the codeword only.')
      await page.keyboard.press('Enter')
      const second = page.getByTestId('assistant-message').nth(1).getByTestId('assistant-text')
      await expect(second).toContainText('tenon-42', { timeout: 90_000 })
    } finally {
      await app.close()
    }
  })

  test('Stop really stops a long reply', async () => {
    const { app, page } = await open('stop')
    try {
      await page
        .getByTestId('composer-input')
        .fill('Count from 1 to 400, one number per line, nothing else.')
      await page.keyboard.press('Enter')
      const reply = page.getByTestId('assistant-message').getByTestId('assistant-text')
      await expect(reply).toContainText('3', { timeout: 90_000 })
      await page.getByTestId('composer-cancel').click()
      await expect(page.getByTestId('composer-send')).toBeVisible()

      const stoppedAt = await reply.innerText()
      await page.waitForTimeout(2500)
      expect(await reply.innerText()).toBe(stoppedAt)
      expect(stoppedAt).not.toContain('400')
    } finally {
      await app.close()
    }
  })
})
