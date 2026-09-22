import { readFileSync } from 'node:fs'
import {
  applicationMenuLabels,
  configPathIn,
  launchTenon,
  makeUserDataDir,
  seedConfig,
} from './helpers/launch.js'
import type { Locale } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import { expectSingleLineUnclipped } from './helpers/text-fit.js'

/**
 * Acceptance 12 - the bilingual shell regression. A 1280x800 screenshot per language is the
 * artifact; the DOM assertions are the gate. Acceptance 9 (switch + persist) and 11 (IME
 * Enter) ride on the same launch shape.
 */

/** Rows rendered today: newChat, projects, artifacts, scheduled, customize. */
const NAV_ITEM_COUNT = 5

/** The renderer writes the full tag to `lang` and only the primary subtag to `data-lang`. */
const PRIMARY_SUBTAG: Record<Locale, string> = { 'zh-CN': 'zh', en: 'en' }

for (const locale of ['zh-CN', 'en'] as const satisfies readonly Locale[]) {
  test(`shell fits at 1280x800 in ${locale}`, async () => {
    const testInfo = test.info()
    const userData = makeUserDataDir(`fit-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData })

    try {
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      expect(await page.evaluate(() => document.documentElement.dataset['lang'])).toBe(
        PRIMARY_SUBTAG[locale],
      )

      // Every sidebar row and every Composer string: one line, nothing clipped.
      await expectSingleLineUnclipped(page.getByTestId('nav-item'), NAV_ITEM_COUNT)
      await expectSingleLineUnclipped(page.getByTestId('composer-input'))
      await expectSingleLineUnclipped(page.getByTestId('composer-send'))
      await expectSingleLineUnclipped(page.getByTestId('composer-disclaimer'))
      await expectSingleLineUnclipped(page.getByTestId('account-row'))

      // The baseline is a review artifact, not the gate - see maxDiffPixelRatio in the config.
      // Baselines are committed for darwin; other platforms attach the screenshot instead.
      if (process.platform === 'darwin') {
        await expect(page).toHaveScreenshot(`shell-${locale}.png`)
      } else {
        await testInfo.attach(`shell-${locale}`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        })
      }
    } finally {
      await app.close()
    }
  })
}

test('acceptance 9: the account menu switches language and it survives a relaunch', async () => {
  const userData = makeUserDataDir('locale-persist')
  const first = await launchTenon({ userData, systemLanguages: ['en-US'] })

  try {
    expect(await applicationMenuLabels(first.app)).toContain('File')
    await expect(first.page.locator('html')).toHaveAttribute('lang', 'en')

    await first.page.getByTestId('account-row').click()
    // Open the submenu from the keyboard: a mouse click races the trigger's own
    // open-on-hover and can toggle it shut again.
    await first.page.getByTestId('account-language').focus()
    await first.page.keyboard.press('ArrowRight')
    await first.page.getByTestId('account-language-zh-CN').click()

    // Main owns the switch: the application menu, the window title and the renderer all
    // follow one resolved value pushed over `config.locale`.
    await expect(first.page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect.poll(async () => await applicationMenuLabels(first.app)).toContain('文件')
  } finally {
    await first.app.close()
  }

  // config.json does not exist until something writes it: a fresh launch alone leaves the
  // profile dir empty and readConfig falls back to schema defaults.
  expect(JSON.parse(readFileSync(configPathIn(userData), 'utf8'))).toMatchObject({
    locale: 'zh-CN',
  })

  // Same profile dir, new process, English system: the choice is read back, not re-derived.
  const second = await launchTenon({ userData, systemLanguages: ['en-US'] })
  try {
    await expect(second.page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    expect(await applicationMenuLabels(second.app)).toContain('文件')
    await expectSingleLineUnclipped(second.page.getByTestId('nav-item'), NAV_ITEM_COUNT)
  } finally {
    await second.app.close()
  }
})

test('acceptance 11: Enter during IME composition does not send; after the commit it does', async () => {
  const userData = makeUserDataDir('ime')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData })

  try {
    const composer = page.getByTestId('composer-input')
    const messages = page.getByTestId('user-message')
    await composer.click()

    // Drive Chromium's real input-method controller. keyboard.press cannot set isComposing;
    // this makes the next Enter arrive at React with nativeEvent.isComposing === true and
    // keyCode 13 - exactly what a Pinyin IME delivers.
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 })
    await expect(composer).toHaveValue('你好')
    await page.keyboard.press('Enter')
    // Both halves matter: nothing was sent AND the candidate is still in the box. The
    // count-0 assertion alone would pass even if the Enter had never been delivered.
    // `toContain`, not `toHaveValue`: a CDP-composed Enter still reaches the textarea, so
    // the value is '你好\n' unless the Composer also preventDefaults during composition
    // (measured) - a real IME swallows the key and leaves it at '你好'.
    await expect(messages).toHaveCount(0)
    expect(await composer.inputValue()).toContain('你好')

    // Commit the candidate the way the IME does, then press Enter for real.
    await cdp.send('Input.insertText', { text: '你好' })
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: -1, selectionEnd: -1 })
    await cdp.detach()

    await page.keyboard.press('Enter')
    await expect(messages).toHaveCount(1)
    await expect(messages.first().getByTestId('user-text')).toHaveText('你好')
  } finally {
    await app.close()
  }
})
