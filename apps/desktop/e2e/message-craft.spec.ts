import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Locator } from '@playwright/test'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import type { Locale } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import { allowCard } from './helpers/navigation.js'
import {
  bashCall,
  callsReply,
  makeFolderTree,
  providerEnv,
  readCall,
  send,
  startTask,
  textReply,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * The phase-2 components the first pass left out (components.md `CodeBlock`, `UserActionBar`,
 * `AssistantActionBar`, `StatusLine`, `ThinkingBlock`), measured in the real window:
 *
 * - a code block was a box inside a box, its language floating between the two, with no way to copy
 *   the code but to select it by hand;
 * - a message had no action at all: no copy, no age;
 * - nothing under the latest turn said that anything was happening;
 * - a thinking block looked like a line of grey text, said it had thought for a second the moment
 *   its first word arrived, and gave no sign that it opens.
 *
 * Copying goes through the page's own clipboard, which main lets the app's document write; each
 * test reads the system clipboard back from main, and puts the developer's own back.
 */
let fake: FakeAnthropic | undefined
let tree: FolderTree | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
  tree?.dispose()
  tree = undefined
})

/** Runs `body` with the system clipboard emptied, and restores what the developer had. */
async function withClipboard(
  app: ElectronApplication,
  body: (read: () => Promise<string>) => Promise<void>,
): Promise<void> {
  const kept = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText(''))
    await body(() => app.evaluate(({ clipboard }) => clipboard.readText()))
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), kept)
  }
}

/** The opacity a hidden action bar is at: it is on the page, it keeps its height, it is not seen. */
const opacityOf = (bar: Locator): Promise<string> =>
  bar.evaluate((el) => getComputedStyle(el).opacity)

const CODE = [
  'export function sum(values: number[]): number {',
  '  return values.reduce(',
  '    (total, value) => total + value,',
  '    0,',
  '  )',
  '}',
].join('\n')
const LONG_LINE = `const long = '${'x'.repeat(400)}'`

const CODE_COPY: Record<Locale, string> = { en: 'Copy code', 'zh-CN': '复制代码' }

/** Serialised into the page: the keyframes an element runs, `none` for none. */
function animationOf(el: Element): string {
  return getComputedStyle(el).animationName
}

/** The widths of a code block's edge fades (theme.css `overflow-hint`). */
function overflowHint(body: Locator): Promise<{ start: string; end: string }> {
  return body.evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      start: style.getPropertyValue('--overflow-hint-start'),
      end: style.getPropertyValue('--overflow-hint-end'),
    }
  })
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`a code block is one frame with its language and a copy button in the header row, and scrolls sideways; a table is one frame too (${locale})`, async () => {
    fake = await startFakeAnthropic({
      replies: [
        textReply(
          'Here is the code:\n\n```ts\n',
          `${CODE}\n`,
          '```\n\nAnd a long line:\n\n```\n',
          `${LONG_LINE}\n`,
          '```\n\nAnd a table:\n\n| Option | Cost |\n| --- | --- |\n| A | Low |\n| B | High |\n',
          '\nThat is all.',
        ),
      ],
    })
    const userData = makeUserDataDir(`message-craft-code-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await send(page, 'show me the code')
      const text = page.getByTestId('assistant-text')
      await expect(text).toHaveAttribute('data-streaming', 'false')
      const frames = text.locator('[data-streamdown="code-block"]')
      await expect(frames).toHaveCount(2)
      const frame = frames.first()
      // The header row names the language.
      await expect(frame.locator('[data-streamdown="code-block-header"]')).toHaveText('ts')

      const layout = await frame.evaluate((el) => {
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- serialised into the page
        const borders = (node: Element): number => {
          const style = getComputedStyle(node)
          return (
            Number.parseFloat(style.borderTopWidth) +
            Number.parseFloat(style.borderRightWidth) +
            Number.parseFloat(style.borderBottomWidth) +
            Number.parseFloat(style.borderLeftWidth)
          )
        }
        const header = el
          .querySelector('[data-streamdown="code-block-header"]')!
          .getBoundingClientRect()
        const language = el
          .querySelector('[data-streamdown="code-block-header"] span')!
          .getBoundingClientRect()
        const copy = el
          .querySelector('[data-streamdown="code-block-copy-button"]')!
          .getBoundingClientRect()
        const body = el.querySelector('[data-streamdown="code-block-body"]')!
        const bodyStyle = getComputedStyle(body)
        return {
          frameBorder: borders(el),
          frameFill: getComputedStyle(el).backgroundColor,
          // Anything inside the frame that draws a line of its own is a second frame.
          innerBorders: [...el.querySelectorAll('*')].filter((node) => borders(node) > 0).length,
          innerFill: bodyStyle.backgroundColor,
          innerRadius: bodyStyle.borderTopLeftRadius,
          headerTop: header.top,
          headerBottom: header.bottom,
          copyTop: copy.top,
          copyBottom: copy.bottom,
          copyLeft: copy.left,
          languageRight: language.right,
          headerRight: header.right,
          copyRight: copy.right,
          bodyTop: body.getBoundingClientRect().top,
        }
      })
      expect(layout.frameBorder).toBeGreaterThan(0)
      // The frame has a face of its own (theme.css `--color-sidebar`), not only a line.
      expect(layout.frameFill).not.toBe('rgba(0, 0, 0, 0)')
      expect(layout.innerBorders).toBe(0)
      expect(layout.innerFill).toBe('rgba(0, 0, 0, 0)')
      expect(layout.innerRadius).toBe('0px')
      // The copy button sits in the header row: inside its height, past the language, at its end.
      expect(layout.copyTop).toBeGreaterThanOrEqual(layout.headerTop - 1)
      expect(layout.copyBottom).toBeLessThanOrEqual(layout.headerBottom + 1)
      expect(layout.copyLeft).toBeGreaterThan(layout.languageRight)
      expect(layout.copyRight).toBeLessThanOrEqual(layout.headerRight + 1)
      expect(layout.bodyTop).toBeGreaterThanOrEqual(layout.headerBottom - 1)

      // A table is one frame as well: the wrapper Streamdown puts around it draws no line and no
      // face, and the one rounded line left is the table's own box.
      const table = await text.locator('[data-streamdown="table-wrapper"]').evaluate((el) => {
        const framed = [el, ...el.querySelectorAll('*')].filter((node) => {
          const style = getComputedStyle(node)
          return (
            Number.parseFloat(style.borderTopWidth) > 0 &&
            Number.parseFloat(style.borderTopLeftRadius) > 0
          )
        })
        const style = getComputedStyle(el)
        return {
          framed: framed.length,
          fill: style.backgroundColor,
          border: style.borderTopWidth,
          padding: style.paddingTop,
        }
      })
      expect(table).toEqual({ framed: 1, fill: 'rgba(0, 0, 0, 0)', border: '0px', padding: '0px' })

      // The long line scrolls inside its block; the page does not.
      const wide = frames.nth(1).locator('[data-streamdown="code-block-body"]')
      const scroll = await wide.evaluate((el) => ({
        overflowX: getComputedStyle(el).overflowX,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }))
      expect(scroll.overflowX).toBe('auto')
      expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth)
      expect(scroll.page).toBe(0)
      // macOS hides the scroll bar, so the side with more to see fades rather than cutting the
      // last character in half at the frame: at rest the end, scrolled to the end the start. A
      // block that fits has nothing to fade.
      await expect.poll(() => overflowHint(wide)).toEqual({ start: '0px', end: '32px' })
      await wide.evaluate((el) => {
        el.scrollLeft = el.scrollWidth
      })
      await expect.poll(() => overflowHint(wide)).toEqual({ start: '32px', end: '0px' })
      expect(await overflowHint(frame.locator('[data-streamdown="code-block-body"]'))).toEqual({
        start: '0px',
        end: '0px',
      })

      // Copy puts the code, and only the code, on the clipboard, and says so for a screen reader.
      const copy = frame.getByRole('button', { name: CODE_COPY[locale] })
      await withClipboard(app, async (read) => {
        await copy.click()
        await expect.poll(read).toBe(`${CODE}\n`)
      })
      await expect(frame.locator('output')).toHaveText(locale === 'en' ? 'Copied' : '已复制')
    } finally {
      await app.close()
    }
  })
}

const COPY: Record<Locale, { message: string; justNow: string; copied: string }> = {
  en: { message: 'Copy', justNow: 'Just now', copied: 'Copied' },
  'zh-CN': { message: '复制', justNow: '刚刚', copied: '已复制' },
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`a message copies its words and shows its age, a reply's bar waits for the end, and none jumps the layout (${locale})`, async () => {
    const copy = COPY[locale]
    const hold = deferred()
    fake = await startFakeAnthropic({
      replies: [
        {
          steps: [
            { type: 'text', text: ['First **reply** ', 'with `code`.'] },
            { type: 'wait', until: hold.promise },
          ],
          delayMs: 5,
        },
        textReply('Second reply.'),
      ],
    })
    const userData = makeUserDataDir(`message-craft-actions-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await send(page, 'First *question*')
      const reply = page.getByTestId('assistant-text')
      await expect(reply).toContainText('First reply with code.')
      // Still being written: no bar under it yet.
      await expect(page.getByTestId('assistant-actions')).toHaveCount(0)
      hold.resolve()
      const bar = page.getByTestId('assistant-actions')
      await expect(bar).toHaveCount(1)

      // The newest message keeps its bar up; the user's waits for the pointer.
      expect(await opacityOf(bar)).toBe('1')
      const userBar = page.getByTestId('user-actions')
      expect(await opacityOf(userBar)).toBe('0')
      const userMessage = page.getByTestId('user-message')
      const heightBefore = (await userMessage.boundingBox())?.height
      await userMessage.hover()
      await expect.poll(() => opacityOf(userBar)).toBe('1')
      // It had its height all along: showing it moves nothing.
      expect((await userMessage.boundingBox())?.height).toBe(heightBefore)

      // The age: this message was sent a moment ago, and says when in full on hover.
      await expect(userBar.getByTestId('message-time')).toHaveText(copy.justNow)
      await expect(userBar.getByTestId('message-time')).toHaveAttribute('title', /\d/)

      await withClipboard(app, async (read) => {
        // The user's own words, as typed, not what they render as.
        await userBar.getByRole('button', { name: copy.message }).click()
        await expect.poll(read).toBe('First *question*')
        await expect(userBar.getByTestId('copy-message-status')).toHaveText(copy.copied)
        // The reply's source text, the markdown the model wrote.
        await bar.getByRole('button', { name: copy.message }).click()
        await expect.poll(read).toBe('First **reply** with `code`.')
      })

      // A second round: the first round's bar goes down to a hidden trigger, back on hover.
      await send(page, 'Second question')
      await expect(page.getByTestId('assistant-actions')).toHaveCount(2)
      await expect(page.getByTestId('assistant-text').nth(1)).toHaveText('Second reply.')
      const first = page.getByTestId('assistant-message').first()
      const firstBar = first.getByTestId('assistant-actions')
      // The pointer is still where the first round's user message was; take it off the thread.
      await page.mouse.move(2, 2)
      await expect.poll(() => opacityOf(firstBar)).toBe('0')
      const firstHeight = (await first.boundingBox())?.height
      await first.hover()
      await expect.poll(() => opacityOf(firstBar)).toBe('1')
      expect((await first.boundingBox())?.height).toBe(firstHeight)
      expect(await opacityOf(page.getByTestId('assistant-actions').nth(1))).toBe('1')
    } finally {
      await app.close()
    }
  })
}

test('one round of a task has one bar, and it copies everything the model said in that round', async () => {
  tree = makeFolderTree('message-craft-round', { 'notes.txt': 'alpha\n' })
  const notes = `${tree.real}/notes.txt`
  fake = await startFakeAnthropic({
    replies: [
      {
        steps: [{ type: 'text', text: ['I will read it.'] }, readCall('toolu_1', notes)],
        delayMs: 5,
      },
      textReply('It says alpha.'),
    ],
  })
  const userData = makeUserDataDir('message-craft-round')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await startTask(app, page, tree.real)
    await send(page, 'read notes.txt')
    await expect(page.getByTestId('assistant-text')).toHaveCount(2)
    // Two assistant messages (the reply that asked for the file, the one after it), one bar.
    await expect(page.getByTestId('assistant-message')).toHaveCount(2)
    await expect(page.getByTestId('assistant-actions')).toHaveCount(1)
    await withClipboard(app, async (read) => {
      await page.getByTestId('assistant-actions').getByRole('button', { name: 'Copy' }).click()
      await expect.poll(read).toBe('I will read it.\n\nIt says alpha.')
    })
  } finally {
    await app.close()
  }
})

const STATUS: Record<
  Locale,
  {
    thinking: string
    writing: string
    working: RegExp
    thinkingLive: RegExp
    took: string
  }
> = {
  en: {
    thinking: 'Thinking…',
    writing: 'Writing…',
    working: /^Working · \d+s$/,
    thinkingLive: /Thinking · \d+s/,
    took: 'Thought for',
  },
  'zh-CN': {
    thinking: '思考中…',
    writing: '撰写中…',
    working: /^正在干活 · \d+ 秒$/,
    thinkingLive: /思考中 · \d+ 秒/,
    took: '思考了',
  },
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`the status line follows the Run: 思考中 before anything comes, then the thinking block alone says it, then 撰写中, then gone with the Run (${locale})`, async () => {
    const copy = STATUS[locale]
    const beforeAnything = deferred()
    const afterThinking = deferred()
    const afterText = deferred()
    fake = await startFakeAnthropic({
      replies: [
        {
          steps: [
            { type: 'wait', until: beforeAnything.promise },
            {
              type: 'thinking',
              thinking: ['Weighing it up. ', 'Then deciding.'],
              signature: 'sig',
            },
            { type: 'wait', until: afterThinking.promise },
            { type: 'text', text: ['The answer ', 'so far,'] },
            { type: 'wait', until: afterText.promise },
            { type: 'text', text: [' and the rest.'] },
          ],
          delayMs: 30,
        },
      ],
    })
    const userData = makeUserDataDir(`message-craft-status-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await send(page, 'a question')
      const line = page.getByTestId('status-line')
      // Sent, and nothing back yet: the line says the model is thinking.
      await expect(line).toHaveAttribute('data-state', 'thinking')
      await expect(line).toHaveText(copy.thinking)
      beforeAnything.resolve()
      // Thinking, held: the block, still the tail, says so with its time; the line steps aside, so
      // 「思考中」 is on screen once, not twice.
      const block = page.getByTestId('thinking-block')
      await expect(block).toHaveAttribute('data-live', 'true')
      await expect(block.getByTestId('thinking-toggle')).toContainText(copy.thinkingLive)
      await expect(line).toHaveCount(0)
      await expect(page.getByText(copy.thinking, { exact: true })).toHaveCount(0)
      // The chevron pulses; the words hold still (at the pulse's low they did not read).
      expect(await block.getByTestId('thinking-label').evaluate(animationOf)).toBe('none')
      expect(await block.getByTestId('thinking-toggle').locator('svg').evaluate(animationOf)).toBe(
        'ebb',
      )

      afterThinking.resolve()
      await expect(line).toHaveAttribute('data-state', 'writing')
      await expect(line).toHaveText(copy.writing)
      // The line sits under the latest turn, and is a status region for a screen reader.
      expect(await line.evaluate((el) => el.tagName)).toBe('OUTPUT')
      // Text came after the thinking: it is no longer going, and says how long it took.
      await expect(block).toHaveAttribute('data-live', 'false')
      await expect(block.getByTestId('thinking-toggle')).toContainText(copy.took)

      afterText.resolve()
      await expect(page.getByTestId('assistant-text')).toHaveText(
        'The answer so far, and the rest.',
      )
      // The Run is over: the line is removed, not reworded; the reply's bar takes its place.
      await expect(line).toHaveCount(0)
      await expect(page.getByTestId('assistant-actions')).toHaveCount(1)
    } finally {
      await app.close()
    }
  })

  test(`the status line says 正在干活 with a running count while a task works (${locale})`, async () => {
    const copy = STATUS[locale]
    const hold = deferred()
    tree = makeFolderTree('message-craft-working', { 'notes.txt': 'alpha\n' })
    fake = await startFakeAnthropic({
      replies: [
        callsReply(readCall('toolu_1', `${tree.real}/notes.txt`)),
        {
          steps: [
            { type: 'wait', until: hold.promise },
            { type: 'text', text: ['Done.'] },
          ],
        },
      ],
    })
    const userData = makeUserDataDir(`message-craft-working-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await startTask(app, page, tree.real)
      await send(page, 'read notes.txt')
      const line = page.getByTestId('status-line')
      await expect(page.getByTestId('tool-row')).toHaveCount(1)
      await expect(line).toHaveAttribute('data-state', 'working')
      await expect(line).toHaveText(copy.working)
      // It counts: a second later it is not at zero.
      await expect(line.getByTestId('status-elapsed')).toHaveText(/[1-9]/, { timeout: 5000 })
      // A screen reader hears the words, never the counter ticking.
      await expect(line.getByTestId('status-elapsed')).toHaveAttribute('aria-hidden', 'true')
      hold.resolve()
      await expect(page.getByTestId('assistant-text')).toHaveText('Done.')
      await expect(line).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test(`after 停止 the status line goes, with no words of its own for the stop (${locale})`, async () => {
    tree = makeFolderTree('message-craft-stopping', { 'ws/keep.txt': 'keep\n' })
    const ws = `${tree.real}/ws`
    fake = await startFakeAnthropic({
      replies: [
        callsReply(bashCall('toolu_1', 'echo started > started.txt; sleep 30')),
        textReply('never'),
      ],
    })
    const userData = makeUserDataDir(`message-craft-stopping-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await startTask(app, page, ws)
      await send(page, 'run it')
      await allowCard(page)
      await expect.poll(() => existsSync(join(ws, 'started.txt'))).toBe(true)
      const line = page.getByTestId('status-line')
      await expect(line).toHaveAttribute('data-state', 'working')
      // Every state the line takes from here on, as drawn: the Run closes as long after the click
      // as the command's kill takes (SIGTERM, a grace, SIGKILL), which a poll could miss.
      await page.evaluate(() => {
        const seen: [string | null, string][] = []
        ;(window as unknown as { statusSeen: typeof seen }).statusSeen = seen
        new MutationObserver(() => {
          const el = document.querySelector('[data-testid="status-line"]')
          if (el !== null) seen.push([el.getAttribute('data-state'), el.textContent ?? ''])
        }).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        })
      })
      await page.getByTestId('composer-stop').click()
      await expect(line).toHaveCount(0)
      const seen = await page.evaluate(
        () => (window as unknown as { statusSeen: [string | null, string][] }).statusSeen,
      )
      // 02 §模型菜单与输入框「停止与发送」: what the stop did is on the failure card, 「不另加文案」. The
      // line never says anything about stopping; it said it was working, then went.
      expect(seen.map(([state]) => state).filter((state) => state !== 'working')).toEqual([])
    } finally {
      await app.close()
    }
  })
}

test('a thinking block shows a chevron that turns when it opens, and its text sits behind a rule', async () => {
  fake = await startFakeAnthropic({
    replies: [
      {
        steps: [
          { type: 'thinking', thinking: ['Short thought. ', 'Then more.'], signature: 'sig' },
          { type: 'text', text: ['Answer.'] },
        ],
        delayMs: 5,
      },
    ],
  })
  const userData = makeUserDataDir('message-craft-chevron')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await send(page, 'a question')
    const toggle = page.getByTestId('thinking-toggle')
    await expect(page.getByTestId('assistant-text')).toHaveText('Answer.')
    const chevron = toggle.locator('svg')
    await expect(chevron).toHaveCount(1)
    // Tailwind turns it with the `rotate` property, not `transform`.
    const turn = (): Promise<string> => chevron.evaluate((el) => getComputedStyle(el).rotate)
    // Closed: pointing right, no rotation.
    expect(await turn()).toBe('none')
    await toggle.click()
    // Open: a quarter turn (the transition has to finish before it reads as one).
    await expect.poll(turn).toBe('90deg')
    const text = page.getByTestId('thinking-text')
    await expect(text).toHaveText('Short thought. Then more.')
    const rule = await text.evaluate((el) => ({
      width: getComputedStyle(el).borderLeftWidth,
      indent: getComputedStyle(el).paddingLeft,
    }))
    expect(Number.parseFloat(rule.width)).toBeGreaterThan(0)
    expect(Number.parseFloat(rule.indent)).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})

test('a link in a reply asks before it leaves the app, in the interface’s language', async () => {
  fake = await startFakeAnthropic({
    replies: [textReply('See [the docs](https://example.com/docs).')],
  })
  const userData = makeUserDataDir('message-craft-link')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await send(page, 'where are the docs?')
    await page.getByTestId('assistant-text').locator('[data-streamdown="link"]').click()
    const dialog = page.locator('[data-streamdown="link-safety-modal"]')
    await expect(dialog).toBeVisible()
    // Every word of it from the catalogue: nothing left in Streamdown's English.
    await expect(dialog).toContainText('打开这个链接？')
    await expect(dialog).toContainText('它会在浏览器里打开，离开 Tenon。')
    await expect(dialog).toContainText('https://example.com/docs')
    await expect(dialog.getByRole('button', { name: '复制链接' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '打开链接' })).toBeVisible()
    await expect(dialog.getByTitle('关闭')).toBeVisible()
    await expect(dialog).not.toContainText(/Open|Copy|external/)
    // Leaving it is a choice: closed, nothing was opened.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  } finally {
    await app.close()
  }
})
