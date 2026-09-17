import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { applicationMenuLabels, launchTenon, makeUserDataDir } from './helpers/launch.js'

// Every launch gets its own profile directory: a developer's real config.json (for example a
// language chosen in `pnpm dev`) must never decide whether these tests pass.

test('boots with a sandboxed renderer and a working preload bridge', async () => {
  const { app, page } = await launchTenon({ userData: makeUserDataDir('smoke-boot') })
  try {
    await expect(page.getByTestId('app-root')).toBeAttached()
    expect(await page.evaluate(() => typeof window.tenon)).toBe('object')
    expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe(
      'undefined',
    )
  } finally {
    await app.close()
  }
})

for (const [locale, systemTag] of [
  ['zh-CN', 'zh-Hans-CN'],
  ['en', 'en-US'],
] as const) {
  test(`a fresh profile follows the system language (${locale})`, async () => {
    const { app, page } = await launchTenon({
      userData: makeUserDataDir(`smoke-${locale}`),
      systemLanguages: ['fr-FR', systemTag],
    })
    try {
      await expect(page.getByTestId('app-title')).toHaveText('Tenon')
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      expect(await applicationMenuLabels(app)).toContain(locale === 'zh-CN' ? '文件' : 'File')
    } finally {
      await app.close()
    }
  })
}

test('the window stays on the app document and declines declared-channel abuse', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>remote</title><p>remote page</p>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const remote = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`

  const { app, page } = await launchTenon({ userData: makeUserDataDir('smoke-nav') })
  try {
    const before = page.url()
    expect(before.startsWith('file://')).toBe(true)
    // A compromised renderer script tries to take the window (and its preload bridge) to a
    // remote origin. Main refuses the navigation.
    await page.evaluate((url) => {
      location.href = url
    }, remote)
    await page.waitForTimeout(500)
    expect(page.url()).toBe(before)
    // Main is the authority on what the window shows. (Locators cannot be used here: after a
    // navigation that main cancelled, Playwright keeps waiting for it to finish.)
    const shown = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getURL(),
    )
    expect(shown).toBe(before)
    const stillTheApp = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="app-root"]')),
    )
    expect(stillTheApp).toBe(true)

    // Channels outside @tenon-app/contracts never reach main.
    const refused = await page.evaluate(() =>
      window.tenon.invoke('fs.readFile', '/etc/passwd').then(
        () => 'resolved',
        (error: unknown) => String(error),
      ),
    )
    expect(refused).toContain('not a declared route')
  } finally {
    await app.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
