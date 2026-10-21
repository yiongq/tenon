import type { Locator, Page } from '@playwright/test'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic, ScriptedReply } from '../test/support/fake-anthropic.js'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from '../src/main/window-theme.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import type { Locale } from './helpers/launch.js'
import { newChatFromSidebar } from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import { providerEnv, send, textReply } from './helpers/tools.js'

/**
 * The composer's frame and the native shell around it (UX diagnosis M03, N01, N02), measured in the
 * real window:
 *
 * - the composer was one cramped row with the model chip inside the text, two text buttons that
 *   pushed the chip aside when a Run started, and loose rows hanging under the box;
 * - the window repeated 「Tenon」 in the title bar, the sidebar and the top bar, and said nothing
 *   about which conversation it showed.
 */
let fake: FakeAnthropic | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
})

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

async function rectOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('the element is not on screen')
  return box
}

function expectSamePlace(a: Rect, b: Rect): void {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(a[key] - b[key]), key).toBeLessThan(0.5)
  }
}

/** A reply that streams `before`, then holds the stream open until `until` settles. */
function heldReply(before: string, until: Promise<void>): ScriptedReply {
  return {
    steps: [
      { type: 'text', text: before },
      { type: 'wait', until },
      { type: 'text', text: ' Finished.' },
    ],
    delayMs: 5,
  }
}

/** The radius of a button's corners in px (a circle reports a huge one; the browser clamps it). */
function radiusOf(button: Locator): Promise<number> {
  return button.evaluate((el) => Number.parseFloat(getComputedStyle(el).borderTopLeftRadius))
}

test('the composer is two rows: the editor on top, the tool row under it with the model chip and one button on the right', async () => {
  const userData = makeUserDataDir('frame-rows')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  try {
    const frame = await rectOf(page.getByTestId('composer'))
    const editor = await rectOf(page.getByTestId('composer-input'))
    const tools = await rectOf(page.getByTestId('composer-tools'))
    const lead = await rectOf(page.getByTestId('composer-lead'))
    const chip = await rectOf(page.getByTestId('model-menu-trigger'))
    const button = await rectOf(page.getByTestId('composer-send'))
    // The editor is the whole width of the frame and sits above the tool row, inside the frame.
    expect(editor.width).toBeGreaterThan(frame.width - 40)
    expect(editor.y + editor.height).toBeLessThanOrEqual(tools.y + 1)
    expect(tools.y + tools.height).toBeLessThanOrEqual(frame.y + frame.height + 0.5)
    // Left: the folder toggle, in a slot of its own. Right: the chip, then the button, in that order.
    await expect(page.getByTestId('composer-lead').getByTestId('folder-toggle')).toBeVisible()
    expect(lead.x + lead.width).toBeLessThanOrEqual(chip.x + 0.5)
    expect(chip.x + chip.width).toBeLessThanOrEqual(button.x + 0.5)
    expect(button.x + button.width).toBeLessThanOrEqual(frame.x + frame.width)
    // Nothing hangs outside the frame any more: the folder toggle is inside it, not in a row below.
    const mode = await rectOf(page.getByTestId('folder-toggle'))
    expect(mode.y + mode.height).toBeLessThanOrEqual(frame.y + frame.height)
    // The one button is a round, text-free icon with its name for assistive technology.
    const sendButton = page.getByTestId('composer-send')
    await expect(sendButton).toHaveText('')
    await expect(sendButton).toHaveAccessibleName('Send')
    expect(Math.abs(button.width - button.height)).toBeLessThan(0.5)
    expect(await radiusOf(sendButton)).toBeGreaterThanOrEqual(button.width / 2)
    await expect(page.getByTestId('composer-stop')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('send keeps its place; while a Run is live a square Stop stands beside it, and the model chip does not move', async () => {
  const hold = deferred()
  fake = await startFakeAnthropic({ replies: [heldReply('Working', hold.promise)] })
  const userData = makeUserDataDir('frame-stop')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    const sendButton = page.getByTestId('composer-send')
    const idle = await rectOf(sendButton)
    const chipIdle = await rectOf(page.getByTestId('model-menu-trigger'))
    // Sent from the keyboard, on the button itself.
    await page.getByTestId('composer-input').fill('go')
    await sendButton.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Working')
    // The focus did not drop to the page as send went disabled: it is in the editor, and send was
    // never swapped for another button under it.
    await expect(page.getByTestId('composer-input')).toBeFocused()

    // Live Run: stop and send side by side (02 §「停止与发送」), and neither the send button nor the
    // model chip has been pushed aside to make room for it.
    const stop = page.getByTestId('composer-stop')
    await expect(stop).toBeVisible()
    await expect(sendButton).toBeVisible()
    expectSamePlace(await rectOf(sendButton), idle)
    expectSamePlace(await rectOf(page.getByTestId('model-menu-trigger')), chipIdle)
    // An icon with its name for assistive technology; square where the send button is round.
    await expect(stop).toHaveText('')
    await expect(stop).toHaveAccessibleName('Stop')
    expect(await radiusOf(stop)).toBeLessThan(idle.width / 2 - 2)
    // In the tool row, on the chip's free side.
    const stopBox = await rectOf(stop)
    expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(chipIdle.x + 0.5)

    // A message typed meanwhile is a queued one (H13): send is live, and stop is still there.
    await page.getByTestId('composer-input').fill('and then?')
    await expect(sendButton).toBeEnabled()
    await expect(stop).toBeVisible()
    expectSamePlace(await rectOf(sendButton), idle)

    await page.getByTestId('composer-input').fill('')
    // Focus on stop when the Run ends by itself: stop goes away, the focus goes to the editor.
    await stop.focus()
    hold.resolve()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Working Finished.')
    await expect(stop).toHaveCount(0)
    await expect(page.getByTestId('composer-input')).toBeFocused()
    expectSamePlace(await rectOf(sendButton), idle)
  } finally {
    hold.resolve()
    await app.close()
  }
})

test('presentation-r1 验收 10: toggling 在文件夹里工作 moves neither the box nor the line under it (0 px)', async () => {
  const userData = makeUserDataDir('frame-stable')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  try {
    const chat = await rectOf(page.getByTestId('composer'))
    const line = async (): Promise<number> =>
      (await rectOf(page.getByTestId('composer-disclaimer'))).y
    const lineY = await line()
    // The muted line is 8px under the box in a chat, as in a task: no empty band between them.
    expect(Math.abs(lineY - (chat.y + chat.height) - 8)).toBeLessThan(0.5)
    await page.getByTestId('folder-toggle').click()
    await expect(page.getByTestId('folder-chip')).toBeVisible()
    // The chip is beside the toggle, inside the tool row. Neither frame nor line moves, exactly.
    const task = await rectOf(page.getByTestId('composer'))
    const chip = await rectOf(page.getByTestId('folder-chip'))
    const toggle = await rectOf(page.getByTestId('folder-toggle'))
    expect(chip.y).toBeGreaterThanOrEqual(task.y)
    expect(chip.y + chip.height).toBeLessThanOrEqual(task.y + task.height)
    expect(chip.x).toBeGreaterThan(toggle.x + toggle.width)
    expect(task).toEqual(chat)
    expect(await line()).toBe(lineY)
    await expect(page.getByTestId('folder-slot')).toHaveCount(0)
    await page.getByTestId('folder-toggle').click()
    await expect(page.getByTestId('folder-chip')).toHaveCount(0)
    expect(await rectOf(page.getByTestId('composer'))).toEqual(chat)
    expect(await line()).toBe(lineY)
  } finally {
    await app.close()
  }
})

for (const [locale, first, expected, second] of [
  [
    'en',
    'Summarise the report. Keep it short.',
    'Summarise the report.',
    'Thanks, one more thing.',
  ],
  ['zh-CN', '把报告总结一下。要简短。', '把报告总结一下。', '谢谢，还有一件事。'],
] as const satisfies ReadonlyArray<readonly [Locale, string, string, string]>) {
  test(`the top bar names the session by its first sentence and is empty before one exists (${locale})`, async () => {
    fake = await startFakeAnthropic({ replies: [textReply('ok'), textReply('ok again')] })
    const userData = makeUserDataDir(`title-${locale}`)
    seedConfig(userData, { locale })
    const firstLaunch = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      const { page } = firstLaunch
      const title = page.getByTestId('app-title')
      // No session yet: the bar is empty, and 「Tenon」 is on screen once, in the sidebar.
      await expect(title).toHaveCount(0)
      await expect(page.getByTestId('topbar')).toHaveText('')
      await expect(page.getByText('Tenon', { exact: true })).toHaveCount(1)
      await expect(page.getByTestId('brand')).toHaveText('Tenon')

      await send(page, first)
      await expect(title).toHaveText(expected)
      // The first message names it for good.
      await send(page, second)
      await expect(page.getByTestId('assistant-text').last()).toHaveText('ok again')
      await expect(title).toHaveText(expected)

      // A new chat is a session with no message: the bar empties again.
      await newChatFromSidebar(page)
      await expect(page.getByTestId('thread-empty')).toBeVisible()
      await expect(title).toHaveCount(0)
    } finally {
      await firstLaunch.app.close()
    }
    // The stored conversation comes back with its title.
    const again = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await expect(again.page.getByTestId('app-title')).toHaveText(expected)
    } finally {
      await again.app.close()
    }
  })
}

test('a long first sentence is shortened on screen to one line in the top bar, and kept whole in its name', async () => {
  fake = await startFakeAnthropic({ replies: [textReply('ok')] })
  const userData = makeUserDataDir('title-long')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    const words = Array.from({ length: 60 }, (_, i) => `word${String(i)}`).join(' ')
    await send(page, `${words}.`)
    const title = page.getByTestId('app-title')
    await expect(title).toBeVisible()
    // The whole sentence is the heading's text, its tooltip and its accessible name; the bar's CSS
    // shortens it to the width on screen, on one line (no ellipsis spliced in code, 00 §国际化).
    await expect(title).toHaveText(`${words}.`)
    await expect(title).toHaveAttribute('title', `${words}.`)
    await expect(title).toHaveAccessibleName(`${words}.`)
    expect(
      await title.evaluate((el) => ({
        overflow: getComputedStyle(el).textOverflow,
        cut: el.scrollWidth > el.clientWidth,
      })),
    ).toEqual({ overflow: 'ellipsis', cut: true })
    const bar = await rectOf(page.getByTestId('topbar'))
    const heading = await rectOf(title)
    expect(heading.height).toBeLessThan(bar.height)
    expect(heading.x + heading.width).toBeLessThanOrEqual(bar.x + bar.width)
  } finally {
    await app.close()
  }
})

async function dragRegion(locator: Locator): Promise<string> {
  return await locator.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
}

async function platformOf(page: Page): Promise<string | undefined> {
  return await page.evaluate(() => document.documentElement.dataset['platform'])
}

test('on macOS the title bar is hidden: the sidebar runs to the top, clears the traffic lights and drags the window', async () => {
  test.skip(process.platform !== 'darwin', 'the hidden title bar is macOS-only')
  const userData = makeUserDataDir('shell-mac')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  try {
    expect(await platformOf(page)).toBe('darwin')
    // No system title bar: the page is as tall as the window.
    const chrome = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      return win.getBounds().height - win.getContentBounds().height
    })
    expect(chrome).toBe(0)
    const sidebar = await rectOf(page.getByTestId('sidebar'))
    expect(sidebar.y).toBe(0)
    // The lights sit in the first ~72px: the brand and the collapse button start after them.
    expect((await rectOf(page.getByTestId('brand'))).x).toBeGreaterThanOrEqual(76)
    // The header is the window's handle, its button is not.
    const header = page.getByTestId('brand').locator('xpath=..')
    expect(await dragRegion(header)).toBe('drag')
    expect(await dragRegion(page.getByTestId('topbar'))).toBe('drag')
    expect(await dragRegion(page.getByTestId('sidebar-collapse'))).toBe('no-drag')

    // With the sidebar folded away the lights stand over the top bar: its button clears them.
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar')).toHaveCount(0)
    expect((await rectOf(page.getByTestId('sidebar-expand'))).x).toBeGreaterThanOrEqual(76)
  } finally {
    await app.close()
  }
})

test('on macOS a dialog over the drag band takes its clicks: in the smallest window the settings close button and the scrim close it', async () => {
  test.skip(process.platform !== 'darwin', 'the drag region is macOS-only')
  const userData = makeUserDataDir('shell-mac-dialog')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    contentSize: { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT },
  })
  try {
    const band = await rectOf(page.getByTestId('topbar'))
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    const popup = page.getByTestId('provider-settings')
    await expect(popup).toBeVisible()
    // Not vacuous: at this height the dialog's top edge is inside the 44px band.
    await expect.poll(async () => (await rectOf(popup)).y).toBeLessThan(band.y + band.height)
    // Electron stacks drag and no-drag in document order, not by what is on top: the portal's
    // layers come after the band and must opt out themselves, or a click on them drags the window.
    // A synthetic click does not go through the window's hit test, so the region is read as such.
    const overlay = page.locator('[data-slot="dialog-overlay"]')
    expect(await dragRegion(popup)).toBe('no-drag')
    expect(await dragRegion(overlay)).toBe('no-drag')
    await popup.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(popup).toBeHidden()
    // The scrim over the band closes the dialog like the rest of it does.
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    await expect(popup).toBeVisible()
    await page.mouse.click(band.x + band.width - 8, band.y + 8)
    await expect(popup).toBeHidden()

    // A menu is a portal too.
    await page.getByTestId('account-row').click()
    const menu = page.locator('[data-slot="dropdown-menu-content"]')
    await expect(menu).toBeVisible()
    expect(await dragRegion(menu)).toBe('no-drag')
    await page.keyboard.press('Escape')
    // With nothing open, the band still drags the window.
    expect(await dragRegion(page.getByTestId('topbar'))).toBe('drag')
  } finally {
    await app.close()
  }
})

test('on Windows and Linux the native frame stays: no drag region and no room kept for traffic lights', async () => {
  test.skip(process.platform === 'darwin', 'macOS hides the title bar')
  const userData = makeUserDataDir('shell-native')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  try {
    expect(await platformOf(page)).toBe(process.platform)
    expect(await dragRegion(page.getByTestId('topbar'))).not.toBe('drag')
    expect((await rectOf(page.getByTestId('brand'))).x).toBeLessThan(40)
    await page.getByTestId('sidebar-collapse').click()
    expect((await rectOf(page.getByTestId('sidebar-expand'))).x).toBeLessThan(40)
  } finally {
    await app.close()
  }
})
