import type { Locator } from '@playwright/test'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import {
  addStdio,
  closeSettings,
  connected,
  connectorCall,
  openConnectors,
  stdioConfig,
} from './helpers/connectors.js'
import { expectSingleLineUnclipped } from './helpers/text-fit.js'
import { callsReply, providerEnv, send } from './helpers/tools.js'
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
    seedConfig(userData, { locale, mcpServers: [stdioConfig()] })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    try {
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await connected(page)
      await openConnectors(page)
      await expectSingleLineUnclipped(
        page.getByTestId('provider-settings').locator('nav button'),
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
