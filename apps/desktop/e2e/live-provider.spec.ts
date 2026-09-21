import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { expect, test } from '@playwright/test'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'

/**
 * Acceptances 4 and 21 against REAL endpoints — the only automated coverage the spec gives the
 * real keychain path and the real wire formats. Opt-in: CI never runs it.
 *
 * HOW TO RUN IT
 *
 *   1. Put credentials in the repo-root `.env.local` (gitignored, never read by any other test):
 *        ANTHROPIC_AUTH_TOKEN=…   (or ANTHROPIC_API_KEY), optionally ANTHROPIC_BASE_URL
 *        TENON_LIVE_MODEL=…       a cheap model for the Anthropic-wire cases
 *        ZHIPU_API_KEY=…          enables the zhipu group (acceptance 21); absent ⇒ it skips
 *        TENON_LIVE_ZHIPU_MODEL=… defaults to the first model the zhipu definition declares
 *   2. `pnpm test:live` (which is `TENON_LIVE=1 playwright test e2e/live-provider.spec.ts`).
 *
 * It spends a few thousand tokens per run and writes into the login keychain, which is why it is
 * manual. Do not point it at an endpoint you do not own.
 *
 * WHAT THE FIRST RUNNER OWES THE REPOSITORY (plan.md 「Open」):
 *
 *   - **Diff a real stream against the hand-built fixtures.** Neither wire's SSE fixtures were
 *     recorded (`packages/kernel/test/provider/fixtures/*.ts` say so in their headers): they were
 *     written from the vendors' documentation because no agent in this phase was allowed to touch
 *     real credentials. Capture one real stream per wire, compare frame by frame, and correct the
 *     fixtures — or record in plan.md that they match.
 *   - **Settle zhipu's `usageNeedsOptIn`.** It is `false` because the vendor's chat-completions
 *     reference documents no `stream_options` parameter at all, while the spec's provider table
 *     names `include_usage` among the reasons this vendor was chosen. If a real streamed turn
 *     reports no usage without the opt-in, that one line in `definitions/zhipu.ts` becomes `true`
 *     — and if sending the parameter is rejected, the current value is confirmed. Either way,
 *     write down which, because a run recorded with no usage cannot be costed afterwards.
 */
const LIVE = process.env['TENON_LIVE'] === '1'
const ENV_FILE = resolve(process.cwd(), '../../.env.local')
/**
 * One key serves both manual use and these tests; what differs is the model. The tests read
 * their own `TENON_LIVE_*` settings first, so `TENON_MODEL` can stay on the model you like to
 * chat with while the suite runs on a cheap (or free) one. Replies are always capped.
 */
const fromFile = LIVE && existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {}

function pick(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name] || fromFile[name]
    if (value) return value
  }
  return undefined
}

function compact(wanted: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(wanted)) {
    if (value !== undefined) env[name] = value
  }
  return env
}

function liveEnv(): Record<string, string> {
  const wanted: Record<string, string | undefined> = {
    ANTHROPIC_BASE_URL: pick('ANTHROPIC_BASE_URL'),
    ANTHROPIC_AUTH_TOKEN: pick('TENON_LIVE_AUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'),
    ANTHROPIC_API_KEY: pick('ANTHROPIC_API_KEY'),
    TENON_MODEL: pick('TENON_LIVE_MODEL', 'TENON_MODEL'),
    TENON_MAX_TOKENS: pick('TENON_LIVE_MAX_TOKENS', 'TENON_MAX_TOKENS') ?? '2048',
  }
  return compact(wanted)
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
    // The real keychain, because this manual suite is the only automated coverage the spec gives
    // that path: the credentials still arrive through `env`, so what is exercised is
    // `KeychainSecrets` being built and read — the step that CI's Linux cannot do at all.
    return launchTenon({ userData, env, secrets: 'keychain' })
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

/**
 * Acceptance 21: the `zhipu` definition — the OpenAI-compatible wire — against the real endpoint,
 * one streamed turn and one stop.
 *
 * The provider choice is SEEDED into `config.json` rather than clicked through the settings card:
 * this is a test of the wire, and acceptance 6's e2e already drives the card. The credential
 * arrives through the development fallback (`ZHIPU_API_KEY`), which is the one path that needs no
 * real key written anywhere on disk.
 */
const ZHIPU_MODEL_DEFAULT = 'glm-4.6'

test.describe('live provider · zhipu', () => {
  const key = LIVE ? pick('TENON_LIVE_ZHIPU_KEY', 'ZHIPU_API_KEY') : undefined
  test.skip(!LIVE, 'opt-in: run `pnpm test:live` with credentials in .env.local')
  test.skip(
    LIVE && key === undefined,
    `no zhipu key found: fill in ZHIPU_API_KEY in ${ENV_FILE} to run acceptance 21`,
  )
  test.describe.configure({ timeout: 180_000 })

  const model = pick('TENON_LIVE_ZHIPU_MODEL') ?? ZHIPU_MODEL_DEFAULT
  const env = compact({
    ZHIPU_API_KEY: key,
    TENON_MAX_TOKENS: pick('TENON_LIVE_MAX_TOKENS') ?? '2048',
  })

  async function open(tag: string): ReturnType<typeof launchTenon> {
    const userData = makeUserDataDir(`live-zhipu-${tag}`)
    seedConfig(userData, {
      locale: 'en',
      provider: { id: 'zhipu', modelId: model },
      // A gateway, when one is configured; otherwise the definition's own default endpoint.
      ...(pick('TENON_LIVE_ZHIPU_BASE_URL') === undefined
        ? {}
        : { providerConfig: { zhipu: { baseURL: pick('TENON_LIVE_ZHIPU_BASE_URL') ?? '' } } }),
    })
    return launchTenon({ userData, env, secrets: 'keychain' })
  }

  test('a real reply streams in from the OpenAI-compatible endpoint', async () => {
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

  test('Stop really stops a long reply on this wire too', async () => {
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
