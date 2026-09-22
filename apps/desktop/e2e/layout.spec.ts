import type { Page } from '@playwright/test'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'

/**
 * The shell must never scroll: only the thread viewport does.
 *
 * REGRESSION. Every message renders `<h3 className="sr-only">` (its accessible name) and an
 * `<output className="sr-only" />`, and Tailwind's `sr-only` is `position: absolute`. While the
 * thread viewport and every ancestor up to `<body>` were `position: static`, those boxes took
 * the INITIAL containing block instead, so the viewport's `overflow-y: auto` never clipped them
 * and they stretched `document.documentElement.scrollHeight` past `innerHeight` (measured:
 * 780 -> 1060 in a 780px window after four short replies). The document became scrollable, and a
 * wheel past the bottom of the thread chained into it: the whole shell, sidebar included, slid
 * up and the body background showed underneath.
 *
 * Two independent defences: the viewport is `relative`, so those boxes are positioned and
 * clipped INSIDE the scroller; and app-root is `relative` + `overflow-hidden`, so nothing in
 * the shell can extend the document. MEASURED, by reverting one class at a time and rebuilding:
 * this spec passes with EITHER one alone, and fails only when both are gone (`scrollHeight`
 * 1060 vs `innerHeight` 780, then `scrollY` 280 and app-root's rect top -280 after the wheel).
 * So do not read a green run as proof that both classes are still there — the comment at each
 * site is what keeps the pair together.
 */
let fake: FakeAnthropic | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
})

/** Heading + bold bullets: four of these overflow a 780px window, which the bug needs. */
const REPLY = [
  '## Answer\n\n',
  '- **First** point, long enough that the thread outgrows the window\n',
  '- **Second** point, long enough that the thread outgrows the window\n',
  '- **Third** point, long enough that the thread outgrows the window\n',
  '- **Fourth** point, long enough that the thread outgrows the window\n',
  '\nDone.',
]

interface ViewportMetrics {
  readonly docScrollHeight: number
  readonly innerHeight: number
  readonly windowScrollY: number
  readonly appRootTop: number
  readonly viewportScrollTop: number
  readonly viewportScrollHeight: number
  readonly viewportClientHeight: number
}

/** One round trip, so every number below describes the same layout. */
function readMetrics(page: Page): Promise<ViewportMetrics> {
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="thread-viewport"]')
    const appRoot = document.querySelector('[data-testid="app-root"]')
    if (!(viewport instanceof HTMLElement) || !(appRoot instanceof HTMLElement)) {
      throw new Error('thread viewport or app root missing')
    }
    return {
      docScrollHeight: document.documentElement.scrollHeight,
      innerHeight: globalThis.innerHeight,
      windowScrollY: globalThis.scrollY,
      appRootTop: appRoot.getBoundingClientRect().top,
      viewportScrollTop: viewport.scrollTop,
      viewportScrollHeight: viewport.scrollHeight,
      viewportClientHeight: viewport.clientHeight,
    }
  })
}

test('a thread taller than the window scrolls itself, never the shell', async () => {
  fake = await startFakeAnthropic({ chunks: REPLY, delayMs: 5 })
  const userData = makeUserDataDir('layout-scroll')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ANTHROPIC_BASE_URL: fake.baseURL, ANTHROPIC_API_KEY: 'e2e-test-key' },
    contentSize: { width: 1280, height: 780 },
  })
  try {
    for (let turn = 0; turn < 4; turn += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await page.getByTestId('composer-input').fill(`question ${String(turn)}`)
      // oxlint-disable-next-line no-await-in-loop
      await page.keyboard.press('Enter')
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        page.getByTestId('assistant-message').nth(turn).getByTestId('assistant-text'),
      ).toContainText('Done.')
    }

    // (a) The document is exactly one window tall the moment the last reply lands - before any
    // wheel, because this is the state the wheel then acts on.
    const settled = await readMetrics(page)
    expect(settled.docScrollHeight).toBe(settled.innerHeight)
    // The premise of the whole test: the conversation really is taller than its viewport.
    expect(settled.viewportScrollHeight).toBeGreaterThan(settled.viewportClientHeight)
    // assistant-ui still auto-scrolls to the newest message, so its button is at rest.
    expect(settled.viewportScrollTop + settled.viewportClientHeight).toBeGreaterThanOrEqual(
      settled.viewportScrollHeight - 2,
    )
    await expect(page.getByTestId('scroll-to-bottom')).toBeDisabled()

    // Back to the top, by script: the scroll-to-bottom button must notice.
    await page.evaluate(() => {
      document.querySelector('[data-testid="thread-viewport"]')?.scrollTo({ top: 0 })
    })
    await expect(page.getByTestId('scroll-to-bottom')).toBeEnabled()

    // (b) A wheel burst over the thread, far past its bottom, then one over the composer.
    const viewportBox = await page.getByTestId('thread-viewport').boundingBox()
    if (!viewportBox) throw new Error('thread viewport has no box')
    await page.mouse.move(
      viewportBox.x + viewportBox.width / 2,
      viewportBox.y + viewportBox.height / 2,
    )
    for (let tick = 0; tick < 12; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await page.mouse.wheel(0, 200)
    }
    const composerBox = await page.getByTestId('composer').boundingBox()
    if (!composerBox) throw new Error('composer has no box')
    await page.mouse.move(
      composerBox.x + composerBox.width / 2,
      composerBox.y + composerBox.height / 2,
    )
    await page.mouse.wheel(0, 200)

    const wheeled = await readMetrics(page)
    expect(wheeled.windowScrollY).toBe(0)
    expect(wheeled.appRootTop).toBe(0)
    expect(wheeled.docScrollHeight).toBe(wheeled.innerHeight)
    // (c) and the thread DID scroll - the test proves the right box moved, not that none did.
    expect(wheeled.viewportScrollTop).toBeGreaterThan(0)
    await expect(page.getByTestId('scroll-to-bottom')).toBeDisabled()
  } finally {
    await app.close()
  }
})
