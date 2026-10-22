import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import { closeSettings } from './helpers/connectors.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { PAST_CLICK_GUARD_MS } from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import { expectSingleLineUnclipped, expectWrappedUnclipped } from './helpers/text-fit.js'
import {
  bashCall,
  callsReply,
  makeFolderTree,
  providerEnv,
  send,
  startTask,
  textReply,
} from './helpers/tools.js'

/** Scroll each label into view; off-screen text in a scrollable pane is still reachable. */
async function fitEach(locator: Locator, wrap = false): Promise<void> {
  await expect(locator).not.toHaveCount(0)
  for (const element of await locator.all()) {
    // oxlint-disable-next-line no-await-in-loop -- each measurement needs its own scroll position
    await element.scrollIntoViewIfNeeded()
    // oxlint-disable-next-line no-await-in-loop -- measure only after scrolling this element
    if (wrap) await expectWrappedUnclipped(element)
    // oxlint-disable-next-line no-await-in-loop -- fixed interface labels stay on one line
    else await expectSingleLineUnclipped(element)
  }
}

async function allowCommand(page: Page): Promise<void> {
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await page.waitForTimeout(PAST_CLICK_GUARD_MS)
  await page.getByTestId('approval-allow').click()
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`04 验收 33: permissions settings, validation, preset and advanced labels fit in ${locale}`, async () => {
    const userData = makeUserDataDir(`fit04-settings-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData })
    try {
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await page.getByTestId('account-row').click()
      await page.getByTestId('account-permissions').click()
      const pane = page.getByTestId('sandbox-pane')
      await expect(pane).toBeVisible()
      await fitEach(page.getByTestId('settings-permissions'))
      await fitEach(pane.locator('h3, label[for="sandbox-domain"]'))
      await fitEach(pane.getByTestId('sandbox-preset').locator('summary'))
      await fitEach(pane.getByTestId('sandbox-advanced').locator('summary'))
      await fitEach(pane.getByTestId('sandbox-status').locator('summary'))
      await pane.getByTestId('sandbox-status').locator('summary').click()
      await expect(pane.getByTestId('sandbox-reason-test-seam')).toBeVisible()
      await fitEach(pane.getByTestId('sandbox-reason-test-seam').locator('p'))
      await fitEach(pane.getByTestId('sandbox-reason-test-seam').locator('pre'), true)
      const input = pane.getByTestId('sandbox-domain-input')
      await input.fill('*.com')
      await input.press('Enter')
      await expect(pane.getByRole('alert')).toBeVisible()
      await fitEach(pane.getByRole('alert'))
      await expect(input).toBeEnabled()
      await input.fill('localhost:3000')
      await input.press('Enter')
      await expect(pane.getByTestId('sandbox-domain')).toBeVisible()
      await fitEach(pane.getByTestId('sandbox-domain').locator('button'))
      await fitEach(pane.getByTestId('sandbox-domain').locator('p').first(), true)
      await fitEach(pane.getByTestId('sandbox-domain').locator('p').nth(1))
      await pane.getByTestId('sandbox-preset').locator('summary').click()
      await expect(pane.getByTestId('sandbox-preset')).toHaveAttribute('open', '')
      await pane.getByTestId('sandbox-advanced').locator('summary').click()
      await expect(pane.getByTestId('sandbox-advanced')).toHaveAttribute('open', '')
      await fitEach(pane.locator('legend'))
      await fitEach(pane.locator('fieldset label > span'), true)
      await fitEach(pane.locator('fieldset label > span > span'))
      // The radio name is a direct text node above its separate hint, not a two-line label.
      expect(
        await pane.locator('fieldset label > span').evaluateAll((labels) =>
          labels.map((label) => {
            const range = document.createRange()
            range.selectNode(label.firstChild!)
            return new Set([...range.getClientRects()].map((box) => Math.round(box.top))).size
          }),
        ),
      ).toEqual([1, 1])
      await fitEach(
        pane.locator('label').filter({ has: pane.getByTestId('sandbox-package-managers') }),
      )
      await fitEach(pane.locator('p:visible:not(.font-mono)'))
      await fitEach(pane.getByTestId('sandbox-preset').locator('li'), true)
      await fitEach(pane.locator('form button'))
      await closeSettings(page)
    } finally {
      await app.close()
    }
  })

  test(`04 验收 33: receipt objects, three release controls, scope notes and elevated card fit in ${locale}`, async () => {
    const tree = makeFolderTree(`fit04-receipt-${locale}`, {
      'ws/keep.txt': 'keep',
      'outside/a-very-long-report-filename-for-text-fit-regression-2026.txt': 'outside',
    })
    const target = join(
      tree.real,
      'outside/a-very-long-report-filename-for-text-fit-regression-2026.txt',
    )
    const command = `: tenon-test-blocked:registry.example.test tenon-test-write:${target}`
    const fake = await startFakeAnthropic({
      replies: [
        callsReply(bashCall('fit_blocked', command)),
        textReply('Blocked.'),
        callsReply(bashCall('fit_elevated', command)),
        textReply('Finished.'),
      ],
    })
    const userData = makeUserDataDir(`fit04-receipt-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await startTask(app, page, join(tree.real, 'ws'))
      await send(page, 'run the command')
      await allowCommand(page)
      await expect(page.getByTestId('assistant-text').last()).toHaveText('Blocked.')
      const receipt = page.getByTestId('sandbox-notice')
      await expect(receipt).toBeVisible()
      await expect(receipt.getByTestId('receipt-objects')).toContainText(target)
      await expect(receipt.getByTestId('receipt-action')).toHaveCount(3)
      // Paths, hosts, commands and the scope notes under the buttons may wrap; short labels stay on one line.
      await fitEach(receipt.getByTestId('receipt-objects').locator('p'), true)
      await fitEach(receipt.getByTestId('receipt-why').locator('p'))
      await fitEach(receipt.getByTestId('receipt-action-note'), true)
      await fitEach(receipt.getByTestId('receipt-allow-domain'), true)
      await fitEach(receipt.getByTestId('receipt-allow-path'), true)
      await fitEach(receipt.getByTestId('receipt-rerun-unsandboxed'))
      await receipt.getByTestId('receipt-allow-path').click()
      await expect(receipt.getByTestId('receipt-allow-path')).toHaveText(
        locale === 'en' ? 'Allowed' : '已放行',
      )
      await fitEach(receipt.getByTestId('receipt-allow-path'))
      await receipt.getByTestId('receipt-rerun-unsandboxed').click()
      await expect(receipt.getByTestId('receipt-rerun-unsandboxed')).toBeDisabled()
      await fitEach(receipt.getByTestId('receipt-rerun-unsandboxed'))
      await send(page, 'retry the identical command')
      const card = page.getByTestId('approval-card')
      await expect(card).toBeVisible()
      await expect(card.getByTestId('approval-reason')).toHaveAttribute(
        'data-copy-key',
        'confirm.reason.elevated',
      )
      await fitEach(card.getByTestId('approval-title'))
      await fitEach(card.getByTestId('approval-object'), true)
      await fitEach(card.getByTestId('approval-reason'), true)
      await fitEach(card.getByTestId('approval-allow'))
      await fitEach(card.getByTestId('approval-deny'))
      await allowCommand(page)
      await expect(page.getByTestId('assistant-text').last()).toHaveText('Finished.')
      expect(fake.unscripted).toBe(0)
    } finally {
      await app.close()
      await fake.close()
      tree.dispose()
    }
  })

  test(`04 验收 33: unavailable command warning and settings fix fit in ${locale}`, async () => {
    const tree = makeFolderTree(`fit04-unavailable-${locale}`, { 'ws/keep.txt': 'keep' })
    const fake = await startFakeAnthropic({
      replies: [callsReply(bashCall('fit_unavailable', 'printf unavailable')), textReply('Done.')],
    })
    const userData = makeUserDataDir(`fit04-unavailable-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({
      userData,
      env: { ...providerEnv(fake.baseURL), TENON_TEST_SANDBOX: 'off' },
    })
    try {
      await startTask(app, page, join(tree.real, 'ws'))
      await send(page, 'run the command')
      await expect(page.getByTestId('approval-unavailable')).toBeVisible()
      await fitEach(page.getByTestId('approval-unavailable'))
      await allowCommand(page)
      await expect(page.getByTestId('assistant-text').last()).toHaveText('Done.')
      await page.getByTestId('account-row').click()
      await page.getByTestId('account-permissions').click()
      await expect(page.getByTestId('sandbox-pane')).toBeVisible()
      await fitEach(page.getByTestId('sandbox-status').locator('summary'))
      await page.getByTestId('sandbox-status').locator('summary').click()
      await fitEach(page.getByTestId('sandbox-reason-test-seam').locator('p'))
      await closeSettings(page)
    } finally {
      await app.close()
      await fake.close()
      tree.dispose()
    }
  })
}
