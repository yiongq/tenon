import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/test.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { closeSettings } from './helpers/connectors.js'

async function openPermissions(page: Page) {
  await page.getByTestId('account-row').click()
  await page.getByTestId('account-permissions').click()
  await expect(page.getByTestId('sandbox-pane')).toBeVisible()
}
function savedSettings(userData: string): unknown {
  return (JSON.parse(readFileSync(configPathIn(userData), 'utf8')) as { sandbox: unknown }).sandbox
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`04 验收 30: permissions pane validates, saves and restores command settings (${locale})`, async () => {
    const userData = makeUserDataDir('sandbox-settings')
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData })
    try {
      await openPermissions(page)
      const pane = page.getByTestId('sandbox-pane')
      await expect(page.getByTestId('provider-settings').getByRole('tab')).toHaveCount(3)
      await expect(page.getByTestId('settings-permissions')).toHaveText(
        locale === 'zh-CN' ? '权限与网络' : 'Permissions & network',
      )
      const status = page.getByTestId('sandbox-status')
      await expect(status).toHaveCount(1)
      await expect(status.locator('summary')).toContainText(
        locale === 'zh-CN' ? '沙箱已生效' : 'Sandbox active',
      )
      await expect(status).toContainText(
        locale === 'zh-CN' ? '这是测试接缝' : 'This is a test seam',
      )
      await expect(status).not.toHaveAttribute('open', '')
      await status.locator('summary').click()
      await expect(status).toContainText('fake')
      const input = page.getByTestId('sandbox-domain-input')
      await input.fill('*.com')
      await input.press('Enter')
      await expect(pane.getByRole('alert')).toHaveText(
        locale === 'zh-CN'
          ? '第 1 条地址无效，请检查写法。'
          : 'Address 1 is invalid. Check its format.',
      )
      await expect(input).toHaveValue('*.com')
      await expect(input).toBeEnabled()
      await input.fill('EXAMPLE.COM')
      await input.press('Enter')
      await expect(pane.getByRole('alert')).toHaveCount(0)
      await expect(page.getByTestId('sandbox-domain')).toContainText('example.com')
      await expect(input).toHaveValue('')
      await input.fill('localhost:3000')
      await input.press('Enter')
      await expect(
        page.getByTestId('sandbox-domain').filter({ hasText: 'localhost:3000' }),
      ).toContainText(
        locale === 'zh-CN' ? '只对走代理的客户端有效' : 'only for clients using the proxy',
      )
      await page
        .getByTestId('sandbox-domain')
        .filter({ hasText: 'example.com' })
        .getByRole('button')
        .click()
      await expect(page.getByTestId('sandbox-domain')).toHaveCount(1)
      const preset = page.getByTestId('sandbox-preset')
      await expect(preset).not.toHaveAttribute('open', '')
      await preset.locator('summary').click()
      await expect(preset).toContainText('registry.npmjs.org')
      await expect(preset).toContainText(
        locale === 'zh-CN' ? '同时接受 npm 发布' : 'also accepts npm publishing',
      )
      await expect(preset).toContainText('sandbox-cache')
      await page.getByTestId('sandbox-package-managers').check()
      await expect(page.getByTestId('sandbox-package-managers')).toBeChecked()
      const advanced = page.getByTestId('sandbox-advanced')
      await expect(advanced).not.toHaveAttribute('open', '')
      await advanced.locator('summary').click()
      await advanced.locator('input[value="read-only"]').check()
      await expect(advanced.locator('input[value="read-only"]')).toBeChecked()
      await expect
        .poll(() => savedSettings(userData))
        .toEqual({
          profile: 'read-only',
          allowedDomains: ['localhost:3000'],
          packageManagers: true,
        })
      // A change pushed from outside this pane must update its controlled inputs too.
      const changed = await page.evaluate(() =>
        window.tenon.invoke('sandbox.setSettings', { profile: 'workspace-write' }),
      )
      expect(changed).toEqual({ ok: true, data: { ok: true } })
      await expect(advanced.locator('input[value="workspace-write"]')).toBeChecked()
      await advanced.locator('input[value="read-only"]').check()
      await expect(advanced.locator('input[value="read-only"]')).toBeChecked()
      await closeSettings(page)
      // The location hash must open the new pane directly, as it does the existing sections.
      await page.evaluate(() => {
        window.location.hash = '#settings/permissions'
      })
      await expect(page.getByTestId('sandbox-pane')).toBeVisible()
      await expect(page.getByTestId('sandbox-package-managers')).toBeChecked()
    } finally {
      await app.close()
    }
    const relaunched = await launchTenon({ userData })
    try {
      await openPermissions(relaunched.page)
      await expect(relaunched.page.getByTestId('sandbox-package-managers')).toBeChecked()
      await expect(relaunched.page.getByTestId('sandbox-domain')).toContainText('localhost:3000')
      await relaunched.page.getByTestId('sandbox-advanced').locator('summary').click()
      await expect(
        relaunched.page.locator('input[name="sandbox-profile"][value="read-only"]'),
      ).toBeChecked()
      await expect
        .poll(() => savedSettings(userData))
        .toEqual({
          profile: 'read-only',
          allowedDomains: ['localhost:3000'],
          packageManagers: true,
        })
    } finally {
      await relaunched.app.close()
    }
  })
}

test('04 验收 30: off seam shows an unavailable reason and keeps the fix behind the expander', async () => {
  const userData = makeUserDataDir('sandbox-settings-off')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: { TENON_TEST_SANDBOX: 'off' } })
  try {
    await openPermissions(page)
    const status = page.getByTestId('sandbox-status')
    await expect(status.locator('summary')).toContainText('Sandbox unavailable')
    await expect(status.locator('summary')).toContainText('This is a test seam')
    await expect(page.getByTestId('sandbox-reason-test-seam')).toBeHidden()
    await status.locator('summary').click()
    await expect(page.getByTestId('sandbox-reason-test-seam')).toContainText(
      'TENON_TEST_SANDBOX removed',
    )
    await expect(page.getByTestId('sandbox-reason-test-seam')).toContainText('off')
  } finally {
    await app.close()
  }
})
