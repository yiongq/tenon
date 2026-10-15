import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, windowBackground } from '../src/main/window-theme.js'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { addStdio, openConnectors } from './helpers/connectors.js'
import { contrastOf } from './helpers/contrast.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import type { Locale } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import { makeFolderTree, providerEnv, send, startTask, textReply } from './helpers/tools.js'

/**
 * The shell's visual foundation, measured in the real window: the theme layer, the bundled fonts
 * and the typographic rules. Each assertion is a user-visible symptom that once shipped:
 *
 * - theme.css cleared Tailwind's `--container-*` and `--text-*` and put back only part of them, so
 *   `max-w-3xl` and `text-3xl` compiled to nothing: the settings and connector dialogs spanned the
 *   whole window and every Markdown heading was as small as the body.
 * - tokens.css named Inter and Source Serif 4 but nothing loaded them, so every Latin glyph came
 *   from PingFang and the assistant's prose looked like the interface.
 * - CJK has no italic: the browser slanted 强调 and block quotes by force.
 * - the dark theme's input borders were a hair away from the dialog behind them.
 */
let fake: FakeAnthropic | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
})

const REPLY: Record<Locale, string[]> = {
  'zh-CN': [
    '# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n#### 四级标题\n\n',
    '正文 Hello Tenon，用于Anthropic。这里有 *强调的词* 和 `inline`。\n\n',
    '> 引用块里的整句话不应该歪着。\n',
  ],
  en: [
    '# Heading one\n\n## Heading two\n\n### Heading three\n\n#### Heading four\n\n',
    'Body Hello Tenon, for Anthropic. Here is an *emphasised phrase* and `inline`.\n\n',
    '> A quoted sentence.\n',
  ],
}

interface FontSample {
  readonly familyName: string
  readonly isCustomFont: boolean
}

/** The fonts Chrome actually painted a node with: the answer to "did the bundled font load". */
async function paintedFonts(page: Page, selector: string): Promise<FontSample[]> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    expect(nodeId, `${selector} not found`).toBeGreaterThan(0)
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    return fonts.map(({ familyName, isCustomFont }) => ({ familyName, isCustomFont }))
  } finally {
    await cdp.detach()
  }
}

async function replyThread(locale: Locale) {
  fake = await startFakeAnthropic({ chunks: REPLY[locale], delayMs: 5 })
  const userData = makeUserDataDir(`foundation-${locale}`)
  seedConfig(userData, { locale })
  const launched = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  await send(launched.page, 'hi')
  await expect(launched.page.getByTestId('composer-send')).toBeVisible()
  await expect(launched.page.getByTestId('assistant-text').locator('blockquote')).toBeVisible()
  return launched
}

interface Typography {
  readonly size: Record<'h1' | 'h2' | 'h3' | 'h4' | 'p', number>
  readonly weight: Record<'h2' | 'p', number>
  readonly emStyle: string
  readonly quoteStyle: string
  readonly smoothing: string
  readonly autospace: string
  readonly paragraphWrap: string
  readonly headingWrap: string
}

function readTypography(page: Page): Promise<Typography> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="assistant-text"]')!
    const style = (selector: string) => getComputedStyle(root.querySelector(selector)!)
    const px = (selector: string) => parseFloat(style(selector).fontSize)
    return {
      size: { h1: px('h1'), h2: px('h2'), h3: px('h3'), h4: px('h4'), p: px('p') },
      weight: { h2: Number(style('h2').fontWeight), p: Number(style('p').fontWeight) },
      emStyle: style('em').fontStyle,
      quoteStyle: style('blockquote').fontStyle,
      smoothing: getComputedStyle(document.documentElement).getPropertyValue(
        '-webkit-font-smoothing',
      ),
      autospace: getComputedStyle(document.documentElement).getPropertyValue('text-autospace'),
      paragraphWrap: style('p').getPropertyValue('text-wrap-style'),
      headingWrap: style('h2').getPropertyValue('text-wrap-style'),
    }
  })
}

for (const locale of ['zh-CN', 'en'] as const satisfies readonly Locale[]) {
  test(`Markdown headings step down from the body, in ${locale}`, async () => {
    const { app, page } = await replyThread(locale)
    try {
      const t = await readTypography(page)
      // Each level larger than the next, and the first three larger than the 16px body.
      expect(t.size.p).toBe(16)
      expect(t.size.h1).toBeGreaterThan(t.size.h2)
      expect(t.size.h2).toBeGreaterThan(t.size.h3)
      expect(t.size.h3).toBeGreaterThan(t.size.p)
      // tokens.md: h4 keeps the body size and is told apart by weight.
      expect(t.size.h4).toBe(t.size.p)
      expect(t.weight.h2).toBeGreaterThan(t.weight.p)
    } finally {
      await app.close()
    }
  })

  test(`typographic rules hold in ${locale}`, async () => {
    const { app, page } = await replyThread(locale)
    try {
      const t = await readTypography(page)
      expect(t.smoothing.trim()).toBe('antialiased')
      expect(t.autospace.trim()).toBe('normal')
      expect(t.paragraphWrap.trim()).toBe('pretty')
      expect(t.headingWrap.trim()).toBe('balance')
      // CJK has no italic and the browser would fake one; Latin keeps the real thing.
      const slanted = locale === 'en' ? 'italic' : 'normal'
      expect(t.emStyle).toBe(slanted)
      expect(t.quoteStyle).toBe(slanted)
    } finally {
      await app.close()
    }
  })
}

test('the bundled fonts are what gets painted: serif prose, sans interface, mono code', async () => {
  const { app, page } = await replyThread('en')
  try {
    const samples = await Promise.all(
      (
        [
          ['[data-testid="assistant-text"] p', 'Source Serif 4'],
          ['[data-testid="nav-item"]', 'Inter'],
          ['[data-testid="assistant-text"] p code', 'Source Code Pro'],
        ] as const
      ).map(async ([selector, family]) => {
        const fonts = await paintedFonts(page, selector)
        return {
          selector,
          ok: fonts.some((f) => f.familyName.startsWith(family) && f.isCustomFont),
          fonts,
        }
      }),
    )
    for (const { selector, ok, fonts } of samples) {
      expect(ok, `${selector} painted with ${JSON.stringify(fonts)}`).toBe(true)
    }
  } finally {
    await app.close()
  }
})

test('a task reply in Chinese paints its digits and Latin words serif, as soon as it shows (00 §国际化)', async () => {
  const tree = makeFolderTree('foundation-task-digits', { 'ws/a.txt': 'alpha\n' })
  fake = await startFakeAnthropic({
    replies: [textReply('42\n\n改成了 42，然后提交 PR。\n\n他说“好的”——就这样……')],
  })
  const userData = makeUserDataDir('foundation-task-digits')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await startTask(app, page, join(tree.real, 'ws'))
    await send(page, '改一下')
    const paragraphs = page.getByTestId('assistant-text').locator('p')
    await expect(paragraphs).toHaveCount(3)
    // Measured at once, not after a pause: the first reply of the window is the one at risk.
    const digits = await paintedFonts(page, '[data-testid="assistant-text"] p')
    expect(digits).toEqual([{ familyName: 'Source Serif 4', isCustomFont: true }])
    // Mixed with Chinese: the Chinese characters fall back to a system sans (the spec's choice; which
    // one depends on the platform), the digits and `PR` stay serif.
    const mixed = await paintedFonts(page, '[data-testid="assistant-text"] p:nth-of-type(2)')
    expect(mixed.filter((f) => f.isCustomFont).map((f) => f.familyName)).toEqual(['Source Serif 4'])
    expect(mixed.some((f) => !f.isCustomFont)).toBe(true)
    // Chinese quotation marks, dash and ellipsis are Chinese characters in a Chinese sentence: drawn
    // by the CJK fallback, not by the Latin serif (narrow, the ellipsis down on the baseline).
    const punctuation = await paintedFonts(page, '[data-testid="assistant-text"] p:nth-of-type(3)')
    expect(punctuation.filter((f) => f.isCustomFont)).toEqual([])
  } finally {
    await app.close()
    tree.dispose()
  }
})

test('the settings and connector dialogs stay bounded instead of spanning the window', async () => {
  const userData = makeUserDataDir('foundation-dialogs')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData })
  try {
    const width = async (testId: string): Promise<number> => {
      const box = await page.getByTestId(testId).boundingBox()
      if (box === null) throw new Error(`${testId} is not on screen`)
      return box.width
    }
    await openConnectors(page)
    // max-w-3xl: 768px in a 1280px window (it was ~1250px).
    expect(await width('provider-settings')).toBeLessThanOrEqual(768)
    expect(await width('provider-settings')).toBeGreaterThan(600)

    await addStdio(page, 'sized')
    // max-w-xl: 576px.
    expect(await width('connector-form')).toBeLessThanOrEqual(576)
    await page.getByTestId('connector-save').click()
    await expect(page.getByTestId('connector-grant')).toBeVisible()
    expect(await width('connector-grant')).toBeLessThanOrEqual(576)
  } finally {
    await app.close()
  }
})

test('the dark theme draws input borders against the dialog at 3:1 or better', async () => {
  const userData = makeUserDataDir('foundation-dark')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData })
  try {
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    const field = page.getByTestId('provider-select')
    await expect(field).toBeVisible()
    const colors = await field.evaluate((el) => ({
      border: getComputedStyle(el).borderTopColor,
      dialog: getComputedStyle(el.closest('[data-slot="dialog-content"]')!).backgroundColor,
    }))
    const ratio = contrastOf(colors.border, colors.dialog)
    expect(ratio).toBeGreaterThanOrEqual(3)
  } finally {
    await app.close()
  }
})

test('the window paints the theme colour before the page does, and has a floor on its size', async () => {
  const userData = makeUserDataDir('foundation-window')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  try {
    const native = await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      return {
        dark: nativeTheme.shouldUseDarkColors,
        background: win.getBackgroundColor(),
        minimum: win.getMinimumSize(),
      }
    })
    // Playwright pins the page to a light scheme; put it on the system's, which is what the
    // native layer follows, and the two must be the same colour.
    await page.emulateMedia({ colorScheme: native.dark ? 'dark' : 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', native.dark ? 'dark' : 'light')
    const painted = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const [r, g, b] = painted.match(/\d+/g)!.map(Number)
    const hex = '#' + [r, g, b].map((v) => v!.toString(16).padStart(2, '0')).join('')
    expect(native.background.toLowerCase()).toBe(hex)
    expect(native.background.toLowerCase()).not.toBe('#ffffff')
    // The floor the layout was measured at, not just any floor.
    expect(native.minimum).toEqual([MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT])

    // The system theme flips while the window is open: the native layer repaints with it, so a
    // resize or the first frame after the flip is the new theme's colour, not the old one's.
    // Playwright runs from apps/desktop, as launchTenon's `./out/main/index.js` assumes.
    const tokens = readFileSync(resolve('src/styles/tokens.css'), 'utf8')
    const nativeBackground = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase(),
      )
    const flip = async (dark: boolean): Promise<void> => {
      await app.evaluate(
        ({ nativeTheme }, source) => {
          nativeTheme.themeSource = source
        },
        (dark ? 'dark' : 'light') as 'dark' | 'light',
      )
      await expect.poll(nativeBackground).toBe(windowBackground(dark, tokens).toLowerCase())
    }
    try {
      await flip(!native.dark)
      await flip(native.dark)
    } finally {
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'system'
      })
    }
  } finally {
    await app.close()
  }
})
