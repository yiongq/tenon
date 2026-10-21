import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { MIN_WINDOW_WIDTH } from '../src/main/window-theme.js'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { addStdio, connected, openConnectors, stdioConfig } from './helpers/connectors.js'
import { contrastOf } from './helpers/contrast.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import type { Locale } from './helpers/launch.js'
import { newChatFromSidebar } from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import { expectSingleLineUnclipped, expectWrappedUnclipped } from './helpers/text-fit.js'
import {
  callsReply,
  makeFolderTree,
  providerEnv,
  readCall,
  send,
  startTask,
  stubFolderDialog,
  textReply,
  writeCall,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * The layout craft pass, measured in the real window. Each test is a symptom that shipped:
 *
 * - paths broke mid-name (`real/m⏎y-project`, `my-⏎project`) and the transcript had 90px holes
 *   between two calls of one task;
 * - the settings dialog grew and shrank with its panel, scrolled twice, focused its first field so
 *   that it wore a focus ring on open, and the connector consent card opened over the form's own
 *   fields;
 * - the sidebar listed four rows that did nothing and said 「还没有对话」 under a conversation;
 * - the composer's box jumped when the hint line came, and at the narrowest window a task's tool row
 *   broke into three;
 * - tool output was cut off mid-line with no way to see the rest;
 * - small primary buttons lost their white text, and tool output its 12px size, to a class merger
 *   that took Tenon's size names for colours.
 */
let fake: FakeAnthropic | undefined
let tree: FolderTree | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
  tree?.dispose()
  tree = undefined
})

/** Two Runs of reads, then a Write that waits on its card: the shape of the diagnosis's screenshots. */
async function taskWaitingOnAWrite(locale: Locale) {
  tree = makeFolderTree('ux-craft-long-path-for-wrapping', {
    'a-long-named-project/another-long-folder-name/a.txt': 'alpha\n',
    'a-long-named-project/another-long-folder-name/README.md': 'readme\n',
  })
  const ws = join(tree.real, 'a-long-named-project', 'another-long-folder-name')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(
        readCall('toolu_1', join(ws, 'a.txt')),
        readCall('toolu_2', join(ws, 'README.md')),
      ),
      callsReply(writeCall('toolu_3', join(ws, 'docs', 'plan.md'), 'plan\n')),
      textReply('Done.'),
    ],
  })
  const userData = makeUserDataDir('ux-craft-task')
  seedConfig(userData, { locale })
  const launched = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  await startTask(launched.app, launched.page, ws)
  return launched
}

async function composerBox(page: Page) {
  const box = await page.getByTestId('composer').boundingBox()
  if (box === null) throw new Error('the composer is not on screen')
  return box
}

test('the transcript has one rhythm: 8px between a task’s calls whichever Run they came from, no empty block', async () => {
  const { app, page } = await taskWaitingOnAWrite('en')
  try {
    await send(page, 'tidy this project')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    await expect(page.getByTestId('tool-row')).toHaveCount(3)
    const rhythm = await page.evaluate(() => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- serialised into the page
      const rect = (el: Element) => el.getBoundingClientRect()
      const rows = [...document.querySelectorAll('[data-testid="tool-row"]')].map(rect)
      const user = rect(document.querySelector('[data-testid="user-message"]')!)
      const firstAssistant = rect(document.querySelector('[data-testid="assistant-message"]')!)
      return {
        rowGaps: rows.slice(1).map((row, i) => row.top - rows[i]!.bottom),
        userToAssistant: firstAssistant.top - user.bottom,
        empty: document.querySelectorAll('[data-testid="empty-block"]').length,
        messages: document.querySelectorAll('[data-testid="assistant-message"]').length,
      }
    })
    // Two assistant messages (two Runs), yet the gap between their calls is the gap inside one.
    expect(rhythm.messages).toBe(2)
    expect(rhythm.empty).toBe(0)
    for (const gap of rhythm.rowGaps) expect(Math.abs(gap - 8)).toBeLessThan(1)
    // Between the user's message and the reply: the container's 24px step.
    expect(Math.abs(rhythm.userToAssistant - 24)).toBeLessThan(1)
  } finally {
    await app.close()
  }
})

test('a path breaks only after a slash: in the row, on the card and in the reason; the card’s toggle says both ways', async () => {
  const { app, page } = await taskWaitingOnAWrite('en')
  try {
    await send(page, 'tidy this project')
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveCount(1)
    // The characters are the path, whatever the markup around them.
    await expect(card.getByTestId('approval-object')).toHaveText(
      join(tree!.real, 'a-long-named-project', 'another-long-folder-name', 'docs', 'plan.md'),
    )
    const lines = await page.evaluate(() => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- serialised into the page
      const pxOf = (el: Element) => {
        const style = getComputedStyle(el)
        const line = Number.parseFloat(style.lineHeight)
        return Number.isNaN(line) ? Number.parseFloat(style.fontSize) * 1.5 : line
      }
      const names = [...document.querySelectorAll('[data-slot="path-text"] > span')]
      const objectLine = document.querySelector('[data-testid="approval-object"] code')!
      return {
        names: names.length,
        // A name is atomic: taller than its line height means a name wrapped inside itself.
        wrappedNames: names.filter((el) => el.getBoundingClientRect().height > pxOf(el) * 1.5)
          .length,
        // Not vacuous: the full path on the card does take more than one line.
        objectLines: Math.round(objectLine.getBoundingClientRect().height / pxOf(objectLine)),
        wordBreak: getComputedStyle(objectLine).wordBreak,
        wbrs: document.querySelectorAll('[data-slot="path-text"] wbr').length,
      }
    })
    expect(lines.names).toBeGreaterThan(10)
    expect(lines.wbrs).toBeGreaterThan(10)
    expect(lines.wrappedNames).toBe(0)
    expect(lines.objectLines).toBeGreaterThan(1)
    expect(lines.wordBreak).not.toBe('break-all')

    // 展开改动 / 收起改动: the label follows the state.
    const toggle = card.getByTestId('approval-change-toggle')
    await expect(toggle).toHaveText('Show the change')
    await toggle.click()
    await expect(toggle).toHaveText('Hide the change')
    await expect(card.getByTestId('approval-change-text')).toBeVisible()
    await toggle.click()
    await expect(toggle).toHaveText('Show the change')
    await expect(card.getByTestId('approval-change-text')).toHaveCount(0)

    // The change is tool output's 12px, not the 14px it inherited when its size class was dropped.
    await toggle.click()
    expect(
      await card
        .getByTestId('approval-change-text')
        .evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe('12px')
    // 「Allow」 is light on the dark accent (it was dark on dark, 2:1).
    const allow = await card.getByTestId('approval-allow').evaluate((el) => ({
      color: getComputedStyle(el).color,
      background: getComputedStyle(el).backgroundColor,
    }))
    expect(contrastOf(allow.color, allow.background)).toBeGreaterThanOrEqual(4.5)
  } finally {
    await app.close()
  }
})

test('a call’s input and the failure card’s list of what was done break paths only after a slash too', async () => {
  tree = makeFolderTree('ux-craft-failed-after-reads', {
    'a-long-named-project/another-long-folder-name/a.txt': 'alpha\n',
    'a-long-named-project/another-long-folder-name/a-second-long-folder-name/a.txt': 'readme\n',
  })
  const ws = join(tree.real, 'a-long-named-project', 'another-long-folder-name')
  // Output that names a file by its absolute path, as the note on a spilled result does.
  writeFileSync(
    join(ws, 'a.txt'),
    `Saved all of it to this file:\n${join(ws, 'docs', 'plan.md')}\n`,
  )
  fake = await startFakeAnthropic({
    replies: [
      callsReply(
        readCall('toolu_1', join(ws, 'a.txt')),
        readCall('toolu_2', join(ws, 'a-second-long-folder-name', 'a.txt')),
      ),
      { failWith: { status: 400, type: 'invalid_request_error', message: 'boom' } },
    ],
  })
  const userData = makeUserDataDir('ux-craft-failed-after-reads')
  seedConfig(userData, { locale: 'en' })
  // Narrow, so the full paths do take more than one line.
  const { app, page } = await launchTenon({
    userData,
    env: providerEnv(fake.baseURL),
    contentSize: { width: MIN_WINDOW_WIDTH, height: 700 },
  })
  try {
    await startTask(app, page, ws)
    await send(page, 'read both')
    const done = page.getByTestId('failure-effects-done').locator('li')
    await expect(done).toHaveCount(2)
    // presentation-r1 shortens unique names; two different a.txt paths keep this wrap check meaningful.
    await expect(done).toHaveText([
      `Read ${join(ws, 'a.txt')}`,
      `Read ${join(ws, 'a-second-long-folder-name', 'a.txt')}`,
    ])
    const row = page.getByTestId('tool-row').first()
    await row.getByTestId('tool-row-line').click()
    const input = row.getByTestId('tool-row-details').locator('pre').first()
    await expect(input).toContainText('another-long-folder-name')
    // Input is 12px, as output is.
    expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe('12px')
    const scopes = await page.evaluate(() => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- serialised into the page
      const pxOf = (el: Element) => Number.parseFloat(getComputedStyle(el).lineHeight)
      return [
        '[data-testid="tool-row-details"] pre',
        '[data-testid="tool-row-output"]',
        '[data-testid="failure-effects-done"] li',
      ].map((scope) => {
        const host = document.querySelector(scope)!
        const names = [...host.querySelectorAll('[data-slot="path-text"] > span')]
        return {
          scope,
          names: names.length,
          // A name is atomic: taller than its line means it wrapped inside itself.
          wrapped: names.filter((el) => el.getBoundingClientRect().height > pxOf(el) * 1.5).length,
          // Not vacuous: the whole path does take more than one line.
          lines: Math.round(host.getBoundingClientRect().height / pxOf(host)),
        }
      })
    })
    for (const scope of scopes) {
      expect(scope.names, scope.scope).toBeGreaterThan(5)
      expect(scope.wrapped, scope.scope).toBe(0)
      expect(scope.lines, scope.scope).toBeGreaterThan(1)
    }
    // In output only the absolute path is split into names; the words around it are left alone.
    await expect(row.getByTestId('tool-row-output')).toContainText('Saved all of it to this file:')
    expect(
      await row
        .getByTestId('tool-row-output')
        .locator('[data-slot="path-text"] > span')
        .evaluateAll((names) => names.map((el) => el.textContent).filter((t) => t?.includes(' '))),
    ).toEqual([])
  } finally {
    await app.close()
  }
})

test('the composer’s box holds its place: the stop button and the hint under it do not move or resize it', async () => {
  const { app, page } = await taskWaitingOnAWrite('en')
  try {
    // Already a task with a folder: the folder row sits under the box.
    const withFolder = await composerBox(page)
    await expect(page.getByTestId('composer-disclaimer')).toBeVisible()
    const centreOf = async (testId: string): Promise<number> =>
      page.getByTestId(testId).evaluate((el) => {
        // The words' own extent, not the block's: a left-aligned line would sit at the left edge.
        const range = document.createRange()
        range.selectNodeContents(el)
        const rect = range.getBoundingClientRect()
        return rect.left + rect.width / 2
      })
    const disclaimerCentre = await centreOf('composer-disclaimer')
    await send(page, 'tidy this project')
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    // The hint replaces the disclaimer in the same line instead of adding a line, and the stop
    // button joins send inside the tool row without growing it.
    await expect(page.getByTestId('composer-pending-hint')).toBeVisible()
    await expect(page.getByTestId('composer-disclaimer')).toHaveCount(0)
    await expect(page.getByTestId('composer-stop')).toBeVisible()
    await expect(page.getByTestId('composer-send')).toBeVisible()
    const waiting = await composerBox(page)
    expect(Math.abs(waiting.y - withFolder.y)).toBeLessThan(0.5)
    expect(Math.abs(waiting.height - withFolder.height)).toBeLessThan(0.5)
    // The line keeps its alignment too: the hint is centred where the disclaimer was, so the words
    // do not jump sideways when the state changes.
    expect(Math.abs((await centreOf('composer-pending-hint')) - disclaimerCentre)).toBeLessThan(1)
  } finally {
    await app.close()
  }
})

test('at the narrowest window a task with a folder keeps the tool row on one line, and the folder row under the box on one line too', async () => {
  const userData = makeUserDataDir('ux-craft-mode-row')
  seedConfig(userData, { locale: 'zh-CN' })
  tree = makeFolderTree('ux-craft-mode-row', { 'my-project/a.txt': 'alpha\n' })
  const { app, page } = await launchTenon({
    userData,
    contentSize: { width: MIN_WINDOW_WIDTH, height: 700 },
  })
  try {
    await expect(page.getByTestId('mode-switch')).toBeVisible()
    const rowHeight = async () => (await page.getByTestId('composer-tools').boundingBox())!.height
    const chat = { tools: await rowHeight(), box: await composerBox(page) }
    await page.getByTestId('mode-cowork').click()
    await expect(page.getByTestId('folder-chip')).toBeVisible()
    // Switching to 「任务」 brings the folder row, whose place the chat already kept: the box stays.
    expect(Math.abs((await composerBox(page)).y - chat.box.y)).toBeLessThan(0.5)
    await stubFolderDialog(app, [join(tree.real, 'my-project')])
    await page.getByTestId('folder-add').click()
    await expect(page.getByTestId('folder-item')).toHaveCount(1)
    // The tool row is the one line it is in a chat: 「任务」, the chip and send never wrap.
    expect(Math.abs((await rowHeight()) - chat.tools)).toBeLessThan(0.5)
    const box = await composerBox(page)
    expect(Math.abs(box.height - chat.box.height)).toBeLessThan(0.5)
    // Nor does the first folder: a row with a chip in it is as tall as the row without.
    expect(Math.abs(box.y - chat.box.y)).toBeLessThan(0.5)
    // The folders sit under the box (02 §界面范围 `FolderChip`), on one line.
    const chip = await page.getByTestId('folder-chip').boundingBox()
    const item = await page.getByTestId('folder-item').boundingBox()
    expect(chip!.y).toBeGreaterThanOrEqual(box.y + box.height)
    expect(chip!.height).toBeLessThan(item!.height * 1.5)

    // The chosen mode is outlined, so it shows on the composer's face in either theme, not only by
    // the colour of its words (dark: the fill alone was 1.1:1 against the face).
    const outlined = async (scheme: 'light' | 'dark'): Promise<void> => {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      const mode = await page.getByTestId('mode-cowork').evaluate((el) => ({
        outline: getComputedStyle(el).borderTopColor,
        width: getComputedStyle(el).borderTopWidth,
        face: getComputedStyle(el.closest('[data-testid="composer"]')!).backgroundColor,
      }))
      expect(mode.width).toBe('1px')
      expect(contrastOf(mode.outline, mode.face), scheme).toBeGreaterThanOrEqual(1.5)
    }
    await outlined('light')
    await outlined('dark')
  } finally {
    await app.close()
  }
})

for (const locale of ['zh-CN', 'en'] as const satisfies readonly Locale[]) {
  test(`a long folder name shows whole and wraps instead of ending in an ellipsis (${locale})`, async () => {
    // A folder's name is content (02 §界面范围: paths shown whole, may wrap); 「命令在这里运行」 beside
    // it is interface copy and keeps to one line.
    const name = 'quarterly-planning-workspace-for-the-platform-team-2026'
    const userData = makeUserDataDir(`ux-craft-long-folder-${locale}`)
    seedConfig(userData, { locale })
    tree = makeFolderTree(`ux-craft-long-folder-${locale}`, { [`${name}/a.txt`]: 'alpha\n' })
    const { app, page } = await launchTenon({
      userData,
      contentSize: { width: MIN_WINDOW_WIDTH, height: 700 },
    })
    try {
      await page.getByTestId('mode-cowork').click()
      await stubFolderDialog(app, [join(tree.real, name)])
      await page.getByTestId('folder-add').click()
      const item = page.getByTestId('folder-item')
      await expect(item).toHaveCount(1)
      await expect(item).toContainText(name)
      await expectWrappedUnclipped(item.locator(':scope > span').first())
      await expectSingleLineUnclipped(item.locator(':scope > span').nth(1))
    } finally {
      await app.close()
    }
  })
}

/** Elements under `root` that scroll: overflow auto or scroll with something to scroll. */
async function scrollers(page: Page, testId: string): Promise<string[]> {
  return page.getByTestId(testId).evaluate((root) =>
    [root, ...root.querySelectorAll('*')].flatMap((el) => {
      const style = getComputedStyle(el)
      const scrolls =
        ['auto', 'scroll'].includes(style.overflowY) && el.scrollHeight > el.clientHeight
      return scrolls ? [el.getAttribute('data-testid') ?? el.tagName] : []
    }),
  )
}

test('the settings dialog keeps one size across its sections, scrolls in one place and opens with nothing focused', async () => {
  const userData = makeUserDataDir('ux-craft-settings')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData })
  try {
    await page.getByTestId('account-row').click()
    // Every entry of the account menu has an icon, 「连接器」 included.
    await Promise.all(
      ['account-providers', 'account-connectors', 'account-language'].map((id) =>
        expect(page.getByTestId(id).locator('svg').first()).toBeVisible(),
      ),
    )
    await page.getByTestId('account-providers').click()
    const card = page.getByTestId('provider-settings')
    await expect(card).toBeVisible()
    await expect(page.getByTestId('provider-select')).toBeVisible()
    // Focus rests on the dialog, not on its first field: no focus ring before anything is touched.
    await expect(card).toBeFocused()
    await expect(page.getByTestId('provider-select')).not.toBeFocused()

    const size = async () => {
      const box = await card.boundingBox()
      if (box === null) throw new Error('the settings dialog is not on screen')
      return { width: box.width, height: box.height }
    }
    // The dialog zooms in on open: measure once it has settled.
    await expect.poll(async () => (await size()).width).toBe(744)
    const providers = await size()
    expect(providers.height).toBeLessThanOrEqual(640)
    // One scroll area, and it is the panel's, not the dialog's.
    expect(
      (await scrollers(page, 'provider-settings')).filter((id) => id !== 'settings-scroll'),
    ).toEqual([])

    await page.getByTestId('settings-connectors').click()
    await expect(page.getByTestId('connectors-pane')).toBeVisible()
    const connectors = await size()
    expect(connectors).toEqual(providers)
    // The rail's labels sit at the left edge of their buttons.
    const align = await page.getByTestId('settings-connectors').evaluate((el) => {
      const text = el.querySelector('span')!.getBoundingClientRect().left
      return text - el.getBoundingClientRect().left
    })
    expect(align).toBeLessThan(48)
    // The panel reserves the bar's lane: content does not shift when a bar appears.
    expect(
      await page
        .getByTestId('settings-scroll')
        .evaluate((el) => getComputedStyle(el).scrollbarGutter),
    ).toContain('stable')
    // Content scrolled under the header fades over more than a line of interface text, so no half
    // line shows under the description; at rest the padding keeps the first field out of the fade.
    const fade = await page.getByTestId('settings-scroll').evaluate((el) => {
      const style = getComputedStyle(el)
      // The first colour stop past `transparent` is where the content is fully shown.
      const stop = /\)\s+([\d.]+)px/.exec(style.maskImage)?.[1]
      return { size: Number(stop), padding: Number.parseFloat(style.paddingTop) }
    })
    expect(fade.size).toBeGreaterThanOrEqual(24)
    expect(fade.padding).toBeGreaterThanOrEqual(fade.size)
    // A short description is balanced, so its last line is not one or two characters.
    expect(
      await page
        .locator('[data-slot="dialog-description"]')
        .first()
        .evaluate((el) => getComputedStyle(el).textWrapStyle),
    ).toBe('balance')
  } finally {
    await app.close()
  }
})

test('the connector consent card replaces the form it opened over instead of showing its fields around it', async () => {
  const userData = makeUserDataDir('ux-craft-consent')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  try {
    await openConnectors(page)
    await addStdio(page, 'stacked', ['--a-long-flag-name-that-would-wrap-at-its-hyphens'])
    const form = page.getByTestId('connector-form')
    // Commands, paths and JSON get no red squiggle (nothing in them is a dictionary word); the
    // display name, which is words, is still checked.
    await expect(page.getByTestId('mcp-args')).toHaveAttribute('spellcheck', 'false')
    await expect(page.getByTestId('mcp-command')).toHaveAttribute('spellcheck', 'false')
    await expect(page.getByTestId('mcp-displayName')).toHaveAttribute('spellcheck', 'true')
    // JSON of paths and flags stays on its line and scrolls sideways: no break at a hyphen.
    const args = await page.getByTestId('mcp-args').evaluate((el) => ({
      wrap: el.getAttribute('wrap'),
      whiteSpace: getComputedStyle(el).whiteSpace,
      scrolls: el.scrollWidth > el.clientWidth,
      font: getComputedStyle(el).fontFamily,
    }))
    expect(args).toMatchObject({ wrap: 'off', scrolls: true })
    expect(args.whiteSpace).toMatch(/^pre/)
    expect(args.font).toContain('Source Code Pro')
    const opacity = (testId: string) =>
      page.getByTestId(testId).evaluate((el) => getComputedStyle(el).opacity)
    // Under the form, the settings dialog steps out of sight; the form is the one layer on screen.
    await expect.poll(() => opacity('provider-settings')).toBe('0')
    expect(await opacity('connector-form')).toBe('1')

    await page.getByTestId('connector-save').click()
    await expect(page.getByTestId('connector-grant')).toBeVisible()
    // The consent card is alone over the scrim: the form it opened from is out of sight too.
    await expect.poll(() => opacity('connector-form')).toBe('0')
    expect(await opacity('connector-grant')).toBe('1')
    expect(await form.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')

    await page.getByTestId('grant-cancel').click()
    await expect(page.getByTestId('connector-grant')).toBeHidden()
    await expect.poll(() => opacity('connector-form')).toBe('1')
  } finally {
    await app.close()
  }
})

test('the sidebar draws no inert rows, and 「还没有对话」 only while no chat exists', async () => {
  fake = await startFakeAnthropic({ replies: [textReply('hello ', 'there')] })
  const userData = makeUserDataDir('ux-craft-sidebar')
  seedConfig(userData, { locale: 'zh-CN' })
  const first = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    const { page } = first
    // Only 「新对话」 is a row: the four pages behind the others do not exist yet.
    await expect(page.getByTestId('nav-item')).toHaveCount(1)
    await expect(
      page.getByTestId('sidebar').getByText(/项目|产物|定时任务|技能与连接器/),
    ).toHaveCount(0)
    await expect(page.getByTestId('sidebar-chats-empty')).toHaveText('还没有对话')
    // It tells the user something, so it reads as text does (4.5:1 on the shell), not as a disabled
    // control's 1.9:1.
    const hint = await page.getByTestId('sidebar-chats-empty').evaluate((el) => ({
      color: getComputedStyle(el).color,
      size: Number.parseFloat(getComputedStyle(el).fontSize),
      shell: getComputedStyle(el.closest('[data-testid="sidebar"]')!).backgroundColor,
    }))
    expect(contrastOf(hint.color, hint.shell)).toBeGreaterThanOrEqual(4.5)
    // The heading above it outranks it: darker, and the hint is no larger (they read as two
    // separate levels, not two items of one list).
    const heading = await page.getByTestId('sidebar-section').evaluate((el) => ({
      color: getComputedStyle(el).color,
      size: Number.parseFloat(getComputedStyle(el).fontSize),
    }))
    expect(contrastOf(heading.color, hint.shell)).toBeGreaterThan(
      contrastOf(hint.color, hint.shell) + 1,
    )
    expect(hint.size).toBeLessThanOrEqual(heading.size)
    await send(page, 'hi')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('hello there')
    await expect(page.getByTestId('sidebar-chats-empty')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-section')).toHaveCount(0)
  } finally {
    await first.app.close()
  }
  // The chat was stored: a new window of the same profile restores it and never claims otherwise.
  const second = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await expect(second.page.getByTestId('assistant-text').last()).toHaveText('hello there')
    await expect(second.page.getByTestId('sidebar-chats-empty')).toHaveCount(0)
  } finally {
    await second.app.close()
  }
})

test('tool output that does not fit fades out and offers 「展开全部」 with the lines it takes on screen; a second click puts it back', async () => {
  const LINES = 150
  tree = makeFolderTree('ux-craft-clamp', {
    // Ends in a newline, which is not a line of its own.
    'ws/long.txt': Array.from({ length: LINES }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    // One line with no newline in it, as minified JSON or base64 comes back: it wraps to many.
    'ws/wide.txt': 'x'.repeat(1500),
  })
  const ws = join(tree.real, 'ws')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(
        readCall('toolu_long', join(ws, 'long.txt')),
        readCall('toolu_wide', join(ws, 'wide.txt')),
      ),
      textReply('Read it.'),
    ],
  })
  const userData = makeUserDataDir('ux-craft-clamp')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await startTask(app, page, ws)
    await send(page, 'read the long file')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Read it.')
    const row = page.getByTestId('tool-row').first()
    await row.getByTestId('tool-row-line').click()
    await expect(row.getByTestId('tool-row-details')).toBeVisible()
    const output = row.getByTestId('tool-row-details').locator('pre').last()
    const toggle = row.getByTestId('clamp-toggle')
    // The input is two short lines: it neither fades nor offers anything. Only the output does.
    await expect(row.getByTestId('clamp-toggle')).toHaveCount(1)
    await expect(output).toHaveAttribute('data-clipped', 'true')
    await expect(toggle).toHaveText(`Show all (${LINES} lines)`)
    // Output is 12px, as the input above it.
    expect(await output.evaluate((el) => getComputedStyle(el).fontSize)).toBe('12px')
    const shown = async () => ({
      height: (await output.boundingBox())?.height ?? 0,
      mask: await output.evaluate((el) => getComputedStyle(el).maskImage),
    })
    const collapsed = await shown()
    expect(collapsed.height).toBeLessThanOrEqual(240.5)
    expect(collapsed.mask).not.toBe('none')

    await toggle.click()
    await expect(output).toHaveAttribute('data-clipped', 'false')
    await expect(toggle).toHaveText('Collapse')
    const expanded = await shown()
    expect(expanded.height).toBeGreaterThan(collapsed.height * 2)
    expect(expanded.mask).toBe('none')
    await expect(output).toContainText(`line ${LINES}`)

    await toggle.click()
    await expect(output).toHaveAttribute('data-clipped', 'true')
    await expect(toggle).toHaveText(/^Show all/)

    // The one wide line is counted as the lines it wraps to, not as one.
    const wide = page.getByTestId('tool-row').nth(1)
    await wide.getByTestId('tool-row-line').click()
    const count = Number(
      /\((\d+) lines\)/.exec((await wide.getByTestId('clamp-toggle').textContent()) ?? '')?.[1],
    )
    expect(count).toBeGreaterThan(15)
  } finally {
    await app.close()
  }
})

/**
 * Where a description's lines break, as `[last character of the line, first of the next]` pairs:
 * each character's own box says which line it is on.
 */
async function lineBreaks(page: Page, selector: string): Promise<[string, string][]> {
  return page.locator(selector).evaluate((el) => {
    const chars: { char: string; top: number }[] = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? ''
      for (let i = 0; i < text.length; i += 1) {
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + 1)
        const rect = range.getBoundingClientRect()
        // A collapsed space at a line's end has no box; it is still where that line ended.
        chars.push({ char: text[i]!, top: rect.height > 0 ? rect.top : Number.NaN })
      }
    }
    const breaks: [string, string][] = []
    let line = chars.find((c) => !Number.isNaN(c.top))?.top ?? 0
    chars.forEach((c, i) => {
      if (Number.isNaN(c.top) || i === 0) return
      if (c.top > line + 4) {
        breaks.push([chars[i - 1]!.char, c.char])
        line = c.top
      }
    })
    return breaks
  })
}

/** A line may end on punctuation, or where a space was: never between two characters of a word. */
function fine([end, next]: [string, string]): boolean {
  return /[\s，。；：、！？）」』,.;:!?)]/.test(end) || /\s/.test(next)
}

test('a Chinese dialog description breaks at punctuation or a space, never inside a word', async () => {
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [
      {
        steps: [
          { type: 'text', text: 'Still ' },
          { type: 'wait', until: hold.promise },
          { type: 'text', text: 'going.' },
        ],
        delayMs: 5,
      },
    ],
  })
  const userData = makeUserDataDir('ux-craft-zh-breaks')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    // 「停止这个任务？」: 「…可以停止后离⏎开…」 before.
    await send(page, 'a long task')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Still')
    await newChatFromSidebar(page)
    await expect(page.getByTestId('leave-run')).toBeVisible()
    const leave = await lineBreaks(page, '[data-slot="alert-dialog-description"]')
    expect(leave.length).toBeGreaterThan(0)
    expect(leave.filter((pair) => !fine(pair))).toEqual([])
    await page.getByTestId('leave-stay').click()
    hold.resolve()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Still going.')

    // The connector form's note: 「…环境变量使⏎用 JSON 对象」 before.
    await openConnectors(page)
    await page.getByTestId('connector-add').click()
    const note = page.getByTestId('connector-form').locator('[data-slot="dialog-description"]')
    await expect(note).toContainText('JSON')
    const form = await lineBreaks(
      page,
      '[data-testid="connector-form"] [data-slot="dialog-description"]',
    )
    expect(form.length).toBeGreaterThan(0)
    expect(form.filter((pair) => !fine(pair))).toEqual([])
  } finally {
    await app.close()
  }
})

for (const locale of ['en', 'zh-CN'] as const) {
  test(`at the narrowest window 「正在连接 <显示名>…」 is whole, on one line (${locale})`, async () => {
    const userData = makeUserDataDir(`ux-craft-connecting-${locale}`)
    const gate = join(userData, 'start-gate')
    seedConfig(userData, {
      locale,
      mcpServers: [stdioConfig('notes', ['--start-gate-file', gate])],
    })
    const { app, page } = await launchTenon({
      userData,
      contentSize: { width: MIN_WINDOW_WIDTH, height: 700 },
    })
    try {
      const notice = page.getByTestId('connector-status-notice')
      await expect(notice).toBeVisible()
      await expect(notice).toHaveText(
        locale === 'en' ? 'Connecting to Notes fixture…' : '正在连接 Notes fixture…',
      )
      // With the sidebar open the column is 488px; the notice had a third of it and lost the name.
      await expect(page.getByTestId('sidebar')).toBeVisible()
      await expectSingleLineUnclipped(notice)
      writeFileSync(gate, 'ready')
      await connected(page)
      await expect(notice).toHaveCount(0)
    } finally {
      await app.close()
    }
  })
}
