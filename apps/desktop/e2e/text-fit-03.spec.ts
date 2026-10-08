import { startHttpFixture } from '../../../packages/kernel/test/support/http-fixture.js'
import { mcpServerSchema } from '@tenon-app/contracts'
import { launchHash } from '../src/main/mcp/runtime.js'
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
import { expectSingleLineUnclipped } from './helpers/text-fit.js'
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
  test(`03 验收 46: connector pane, form, grant and card fit in ${locale}`, async () => {
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
        2,
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
        .getByRole('button', { name: /Notes fixture/ })
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
      await expectSingleLineUnclipped(page.getByTestId('grant-warnings').locator('li'), 4)
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
      await expectSingleLineUnclipped(card.getByTestId('reversibility-scale').locator('span'), 5)
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
  test(`03 验收 46: relogin and side-effect text fit in ${locale}`, async () => {
    const http = await startHttpFixture({ era: 'legacy' }),
      fake = await startFakeAnthropic({
        replies: [callsReply(connectorCall('toolu_unauth', 'echo')), textReply('unauthorized')],
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
        .getByRole('button', { name: /Notes fixture/ })
        .click()
      await page.getByTestId('tool-setting-echo').selectOption('always-allow')
      await closeSettings(page)
      http.set({ failNext: '401' })
      await send(page, 'echo')
      await expect(page.getByTestId('tool-relogin')).toBeVisible()
      await expectSingleLineUnclipped(page.getByTestId('tool-relogin'))
      await page.getByTestId('tool-row-line').click()
      await expect(page.getByTestId('tool-side-effects')).toBeVisible()
      await expectSingleLineUnclipped(page.getByTestId('tool-side-effects').locator('p'), 2)
      await expect(page.getByTestId('tool-side-effects')).toContainText(
        locale === 'en' ? 'Not run' : '没执行',
      )
    } finally {
      await app.close()
      await Promise.all([http.close(), fake.close()])
    }
  })
}
