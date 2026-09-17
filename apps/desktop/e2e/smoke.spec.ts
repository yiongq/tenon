import { _electron as electron, expect, test } from '@playwright/test'

test('boots with a sandboxed renderer and a working preload bridge', async () => {
  // ELECTRON_RUN_AS_NODE is set inside Electron-hosted terminals and would turn the
  // electron binary into plain Node.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env

  const app = await electron.launch({
    args: ['./out/main/index.js'],
    cwd: process.cwd(),
    env: env as Record<string, string>,
  })

  const page = await app.firstWindow()
  await expect(page.getByTestId('app-root')).toBeAttached()
  expect(await page.evaluate(() => typeof window.tenon)).toBe('object')
  expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe(
    'undefined',
  )

  await app.close()
})
