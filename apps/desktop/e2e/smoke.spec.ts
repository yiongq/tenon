import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

// ELECTRON_RUN_AS_NODE is set inside Electron-hosted terminals and would turn the
// electron binary into plain Node.
const { ELECTRON_RUN_AS_NODE: _ignored, ...baseEnv } = process.env

async function launch(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: ['./out/main/index.js'],
    cwd: process.cwd(),
    env: { ...(baseEnv as Record<string, string>), ...extraEnv },
  })
}

test('boots with a sandboxed renderer and a working preload bridge', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('app-root')).toBeAttached()
  expect(await page.evaluate(() => typeof window.tenon)).toBe('object')
  expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe(
    'undefined',
  )
  await app.close()
})

for (const locale of ['zh-CN', 'en'] as const) {
  test(`interface language follows the resolved locale (${locale})`, async () => {
    const app = await launch({ TENON_LOCALE: locale })
    const page = await app.firstWindow()
    await expect(page.getByTestId('app-title')).toHaveText('Tenon')
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(locale)
    const menuLabels = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.items.map((item) => item.label),
    )
    expect(menuLabels).toContain(locale === 'zh-CN' ? '文件' : 'File')
    await app.close()
  })
}
