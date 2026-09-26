import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { compact, emulationGroup, officialGroup } from './helpers/live-env.js'
import type { LiveGroup } from './helpers/live-env.js'
import { expect, test } from './helpers/test.js'

/**
 * Acceptances 4 and 21 against REAL endpoints — the only automated coverage the spec gives the
 * real keychain path and the real wire formats. Opt-in: CI never runs it.
 *
 * HOW TO RUN IT
 *
 *   1. Put the non-official credentials in the repo-root `.env.local` (gitignored, never read by
 *      any other test):
 *        ANTHROPIC_BASE_URL=…      Zhipu's Anthropic-compatible endpoint (…/api/anthropic)
 *        ANTHROPIC_AUTH_TOKEN=…    the Zhipu key; with the base URL, enables the emulation group
 *        TENON_LIVE_MODEL=…        its model, glm-4.7-flash (spec 02 §模型与密钥)
 *        ZHIPU_API_KEY=…           enables the zhipu group (acceptance 21); absent ⇒ it skips
 *        TENON_LIVE_ZHIPU_MODEL=…  glm-5.3-flashx (unset ⇒ glm-4.6); never the emulation group's
 *                                  free model, which 1302-limits a second group on the same key
 *   2. The official Anthropic key, when there is one, NEVER goes into `.env.local` or a shell
 *      profile. Hand it to this one run only, as TENON_LIVE_ANTHROPIC_OFFICIAL_KEY in the command's
 *      environment (from a password manager, not typed into the command line); absent ⇒ the
 *      official group skips. TENON_LIVE_ANTHROPIC_OFFICIAL_MODEL picks its model (default: the
 *      definition's first row). helpers/live-env.ts says why the two Anthropic groups cannot mix.
 *   3. `pnpm test:live`, the ONLY command that selects `playwright.live.config.ts` — the default
 *      config ignores this file, so `pnpm test:e2e` cannot collect it whatever is in your shell.
 *
 * It spends a few thousand tokens per group and run, and the zhipu group goes through the real
 * login keychain, which is why it is manual. Do not point it at an endpoint you do not own.
 *
 * STILL OWED: the Anthropic-wire SSE fixtures (packages/kernel/test/provider/fixtures/
 * anthropic-sse.ts) were written from the documentation and only ever met Zhipu's emulation. The
 * first run of the official group should diff one real stream against them, frame by frame, and
 * record the result (01 plan.md, live record of 2026-09-22).
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

const MAX_TOKENS = pick('TENON_LIVE_MAX_TOKENS', 'TENON_MAX_TOKENS') ?? '2048'
const NOT_LIVE: LiveGroup = { kind: 'absent', reason: 'opt-in' }

/**
 * The Anthropic wire twice, on two endpoints that never share a key: Zhipu's emulation (the
 * adapter swallows it; not the guarantee tier) and the official API (spec 02 §模型与密钥).
 */
const ANTHROPIC_GROUPS: readonly { title: string; tag: string; group: LiveGroup }[] = [
  {
    title: 'live provider · anthropic emulation',
    tag: 'live',
    group: LIVE ? emulationGroup(pick, MAX_TOKENS) : NOT_LIVE,
  },
  {
    title: 'live provider · anthropic official',
    tag: 'live-official',
    group: LIVE ? officialGroup(process.env, fromFile, pick, MAX_TOKENS) : NOT_LIVE,
  },
]

for (const { title, tag, group } of ANTHROPIC_GROUPS) {
  test.describe(title, () => {
    test.skip(!LIVE, 'opt-in: run `pnpm test:live` with credentials in .env.local')
    test.skip(
      LIVE && group.kind === 'absent',
      `skipped: ${group.kind === 'absent' ? group.reason : ''} (see the header of this file)`,
    )
    test.describe.configure({ timeout: 180_000 })

    test.beforeAll(() => {
      // A setup that could send a key to the wrong host fails the group rather than skipping it.
      if (group.kind === 'refused') throw new Error(`${title}: ${group.reason}`)
    })

    async function open(name: string): ReturnType<typeof launchTenon> {
      const userData = makeUserDataDir(`${tag}-${name}`)
      seedConfig(userData, { locale: 'en' })
      const env = group.kind === 'ready' ? group.env : {}
      // In-memory secrets: the real keychain would be read AHEAD of these variables, so a key
      // saved through the settings card in daily use would ride along (helpers/live-env.ts).
      return launchTenon({ userData, env, secrets: 'memory' })
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
}

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
