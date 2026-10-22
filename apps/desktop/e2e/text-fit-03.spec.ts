import { startHttpFixture } from '../../../packages/kernel/test/support/http-fixture.js'
import { mcpServerSchema } from '@tenon-app/contracts'
import { launchHash } from '../src/main/mcp/runtime.js'
import { MIN_WINDOW_WIDTH } from '../src/main/window-theme.js'
import type { Locator } from '@playwright/test'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import {
  addStdio,
  closeSettings,
  connected,
  mcpServers,
  connectorCall,
  openConnectors,
  stdioConfig,
} from './helpers/connectors.js'
import { expectSingleLineUnclipped, expectWrappedUnclipped } from './helpers/text-fit.js'
import { callsReply, providerEnv, send, textReply } from './helpers/tools.js'
const evidence = process.env['TENON_SEG3_EVIDENCE_DIR']
/** Forms scroll; measure each label once it is in view, as a user reaches it. */
async function expectScrollableLabels(locator: Locator) {
  const labels = await locator.all()
  expect(labels.length).toBeGreaterThan(0)
  for (const label of labels) {
    // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
    await label.scrollIntoViewIfNeeded()
    // oxlint-disable-next-line no-await-in-loop -- measure after scrolling this label into view
    await expectSingleLineUnclipped(label)
  }
}
for (const locale of ['zh-CN', 'en'] as const) {
  test(`presentation-r1 验收 1: connector pane, form, grant and card fit in ${locale}`, async () => {
    const fake = await startFakeAnthropic({
      replies: [callsReply(connectorCall('toolu_card', 'echo'))],
    })
    const userData = makeUserDataDir('fit03-' + locale)
    const gate = join(userData, 'start-gate'),
      definition = join(userData, 'definition.json')
    writeFileSync(definition, JSON.stringify({ description: 'initial' }))
    seedConfig(userData, {
      locale,
      mcpServers: [
        stdioConfig('notes', [
          '--start-gate-file',
          gate,
          '--definition-file',
          definition,
          '--invisible-text',
        ]),
      ],
    })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    try {
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await expect(page.getByTestId('connector-status-notice')).toBeVisible()
      await expectSingleLineUnclipped(page.getByTestId('connector-status-notice'))
      writeFileSync(gate, 'ready')
      await connected(page)
      await openConnectors(page)
      await expectSingleLineUnclipped(
        page.getByTestId('provider-settings').locator('[role="tab"]'),
        3,
      )
      await expectSingleLineUnclipped(page.getByTestId('connector-add'))
      await expectSingleLineUnclipped(
        page.getByTestId('connector-notes').locator('button > span, div > span:last-child'),
        4,
      )
      if (evidence) {
        mkdirSync(evidence, { recursive: true })
        await page.screenshot({
          animations: 'disabled',
          path: join(evidence, `connectors-${locale}.png`),
        })
      }
      const word = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en)
      await page
        .getByTestId('connector-notes')
        .getByRole('button', { name: /^Notes fixture/ })
        .click()
      const detail = page.getByTestId('connector-detail')
      await expect(detail).toContainText('odd\\u{202E}name')
      await expect(detail).toContainText('odd\\u{202E}description')
      await expect(detail).toContainText('server\\u{202E}instructions')
      await expectScrollableLabels(detail.locator('button'))
      await expectScrollableLabels(detail.getByTestId('connector-instructions-label'))
      writeFileSync(definition, JSON.stringify({ description: 'changed\u202Edescription' }))
      await expect
        .poll(
          async () =>
            (await mcpServers(page))[0]?.toolViews.find((v) => v.originalName === 'echo')?.review,
        )
        .toBe('changed')
      await detail
        .getByTestId('connector-tool-echo')
        .getByRole('button', { name: word('查看变化', 'View changes') })
        .click()
      const dialog = page.getByTestId('connector-review-dialog')
      await expect(dialog).toContainText('changed\\u{202E}description')
      await expectScrollableLabels(dialog.locator('h2,h4'))
      await dialog.locator('[data-slot="dialog-close"]').click()
      await detail.getByRole('button', { name: word('查看日志', 'View log'), exact: true }).click()
      await expect(dialog).toBeVisible()
      await expectSingleLineUnclipped(dialog.locator('h2'))
      await dialog.locator('[data-slot="dialog-close"]').click()
      await detail.getByRole('button', { name: word('删除', 'Delete'), exact: true }).click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await expectSingleLineUnclipped(page.getByRole('alertdialog').locator('h2'))
      await expectSingleLineUnclipped(page.getByRole('alertdialog').locator('button'), 2)
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: word('取消', 'Cancel'), exact: true })
        .click()
      await page.getByTestId('tool-release-echo').click()
      await expect(page.getByTestId('tool-setting-echo')).toBeEnabled()
      await page
        .getByTestId('connectors-pane')
        .getByRole('button', { name: word('返回列表', 'Back to list') })
        .click()
      await addStdio(page, 'draft', ['sudo', 'rm', '-rf', '~/.ssh'])
      await expectScrollableLabels(page.getByTestId('connector-form').locator('label'))
      await expectSingleLineUnclipped(
        page.getByTestId('connector-form').locator('button:not([data-slot="dialog-close"])'),
      )
      if (evidence)
        await page.screenshot({
          animations: 'disabled',
          path: join(evidence, `form-${locale}.png`),
        })
      await page.getByTestId('connector-save').click()
      await expect(page.getByTestId('grant-cancel')).toBeFocused()
      await expectSingleLineUnclipped(page.getByTestId('connector-grant').locator('button'), 3)
      // No variables, no list: every block from the title down to the warnings is one gap apart
      // (an empty list once doubled the gap above the warnings).
      await expect(page.getByTestId('grant-environment')).toHaveCount(0)
      const spacing = await page.getByTestId('connector-grant').evaluate((grant) => {
        // What a user sees as blocks: an empty element is still a grid item and still takes a gap.
        const blocks = [...grant.children].filter(
          (el) =>
            getComputedStyle(el).position === 'static' && el.getBoundingClientRect().height > 0,
        )
        const last = blocks.findIndex((el) => el.getAttribute('data-testid') === 'grant-warnings')
        const rects = blocks.slice(0, last + 1).map((el) => el.getBoundingClientRect())
        return {
          gap: Number.parseFloat(getComputedStyle(grant).rowGap),
          gaps: rects.slice(1).map((rect, i) => rect.top - rects[i]!.bottom),
        }
      })
      expect(spacing.gaps.length).toBeGreaterThanOrEqual(3)
      for (const gap of spacing.gaps) expect(Math.abs(gap - spacing.gap)).toBeLessThanOrEqual(1)
      // `sudo rm -rf ~/.ssh` warns of sudo, rm -rf, the home directory and the SSH one (and of the
      // home directory again for the fixture's own path when the checkout is under home). Each
      // sentence is interface copy and stays on one line in both languages (acceptance 46), the
      // two that quote nothing included; what the others quote is the argv, content that may wrap
      // (02 E4) but is never clipped.
      const warnings = page.getByTestId('grant-warnings')
      await expectSingleLineUnclipped(warnings.locator('[data-slot="warning-copy"]'), 4)
      await expectWrappedUnclipped(warnings.locator('[data-slot="warning-content"]'), 2)
      await expect(warnings.locator('li:not(:has([data-slot="warning-content"]))')).toHaveCount(2)
      if (evidence)
        await page.screenshot({
          animations: 'disabled',
          path: join(evidence, `grant-${locale}.png`),
        })
      await page.keyboard.press('Escape')
      await page.getByTestId('connector-form').locator('[data-slot="dialog-close"]').click()
      await closeSettings(page)
      await send(page, 'echo')
      const card = page.getByTestId('approval-card')
      await expect(card).toBeVisible()
      await expect(card.getByTestId('reversibility-scale')).toHaveCount(0)
      await expectSingleLineUnclipped(card.getByTestId('approval-undo'))
      await expectSingleLineUnclipped(card.getByTestId('approval-server'))
      await expectSingleLineUnclipped(card.locator('button'), 2)
      if (evidence)
        await page.screenshot({
          animations: 'disabled',
          path: join(evidence, `card-${locale}.png`),
        })
      expect(errors).toEqual([])
    } finally {
      await app.close()
      await fake.close()
    }
  })
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`presentation-r1 验收 6: relogin and side-effect text fit in ${locale} (03 验收 46)`, async () => {
    const http = await startHttpFixture({ era: 'legacy' }),
      fake = await startFakeAnthropic({
        replies: [
          callsReply(connectorCall('toolu_ok', 'echo')),
          textReply('done'),
          callsReply(connectorCall('toolu_unauth', 'echo')),
          textReply('unauthorized'),
        ],
      })
    const userData = makeUserDataDir('fit03-row-' + locale),
      config = mcpServerSchema.parse({
        ...stdioConfig(),
        transport: {
          type: 'http',
          url: http.url,
          protocol: 'auto',
          header_keys: [],
          oauth: { ownClient: null, issuers: [] },
        },
      })
    config.consent = { launchHash: launchHash(config) }
    seedConfig(userData, { locale, mcpServers: [config] })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await connected(page)
      await openConnectors(page)
      await page
        .getByTestId('connector-notes')
        .getByRole('button', { name: /^Notes fixture/ })
        .click()
      await page.getByTestId('tool-setting-echo').selectOption('always-allow')
      await closeSettings(page)
      await send(page, 'echo')
      await expect(page.getByTestId('assistant-text').last()).toHaveText('done')
      await page.getByTestId('tool-row-line').click()
      const did = page.getByTestId('tool-side-effects')
      await expect(did).toHaveText(
        locale === 'en'
          ? "Used a connector · If this changes anything, Tenon can't undo it."
          : '用了连接器 · 如果它改了东西，Tenon 没法替你撤回。',
      )
      await expectSingleLineUnclipped(did)
      http.set({ failNext: '401' })
      await send(page, 'echo again')
      await expect(page.getByTestId('tool-relogin')).toBeVisible()
      await expectSingleLineUnclipped(page.getByTestId('tool-relogin'))
      await expect(page.getByTestId('assistant-text').last()).toHaveText('unauthorized')
      const failed = page.getByTestId('tool-row').last()
      await failed.getByTestId('tool-row-line').click()
      await expect(failed.getByTestId('tool-side-effects')).toHaveCount(0)
    } finally {
      await app.close()
      await Promise.all([http.close(), fake.close()])
    }
  })
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`03 验收 46: 「正在连接」 stays whole above the 「回到最新」 pill at the narrowest window in ${locale}`, async () => {
    // A transcript taller than its viewport, scrolled up so the pill shows; then a connector starts
    // its first connection, held at the gate.
    const reply = Array.from({ length: 40 }, (_, i) => `Paragraph ${String(i + 1)}.`).join('\n\n')
    const fake = await startFakeAnthropic({ replies: [textReply(reply)] })
    const userData = makeUserDataDir('fit03-pill-' + locale)
    const gate = join(userData, 'start-gate')
    const server = { ...stdioConfig('notes', ['--start-gate-file', gate]), enabled: false }
    seedConfig(userData, { locale, mcpServers: [server] })
    const { app, page } = await launchTenon({
      userData,
      env: providerEnv(fake.baseURL),
      contentSize: { width: MIN_WINDOW_WIDTH, height: 700 },
    })
    try {
      await send(page, 'a long answer')
      await expect(page.getByTestId('assistant-text')).toContainText('Paragraph 40.')
      await page.evaluate(() => {
        document.querySelector('[data-testid="thread-viewport"]')?.scrollTo({ top: 0 })
      })
      const pill = page.getByTestId('scroll-to-bottom')
      await expect(pill).toBeEnabled()
      expect(
        await page.evaluate(() =>
          window.tenon.invoke('mcp.setEnabled', { id: 'notes', enabled: true }),
        ),
      ).toMatchObject({ ok: true })
      const notice = page.getByTestId('connector-status-notice')
      await expect(notice).toHaveText(
        locale === 'en' ? 'Connecting to Notes fixture…' : '正在连接 Notes fixture…',
      )
      await expect(page.getByTestId('sidebar')).toBeVisible()
      await expectSingleLineUnclipped(notice)
      // Above the pill, not beside it: the two never overlap, and the notice keeps off the box.
      const noticeBox = (await notice.boundingBox())!
      const pillBox = (await pill.boundingBox())!
      const composerBox = (await page.getByTestId('composer').boundingBox())!
      expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(pillBox.y)
      expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(composerBox.y)
      writeFileSync(gate, 'ready')
      await connected(page)
      await expect(notice).toHaveCount(0)
    } finally {
      await app.close()
      await fake.close()
    }
  })
}
