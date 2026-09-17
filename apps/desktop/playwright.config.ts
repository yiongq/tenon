import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // One Electron window at a time: real windows, and screenshots must be deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],

  // Font rendering differs per OS, so a baseline is only ever valid on the platform that
  // produced it. `{platform}` is process.platform: darwin / linux / win32.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',

  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // Already the default for this assertion, but spelled out so nobody swaps in
      // page.screenshot(), which defaults to device pixels and writes 2560x1600 on a Retina Mac.
      scale: 'css',
      animations: 'disabled',
      caret: 'hide',
      // Antialiasing slack only: ~20k pixels of a 1280x800 frame. The DOM assertions, not
      // this number, are what gates the text.
      maxDiffPixelRatio: 0.02,
    },
  },

  use: {
    trace: 'retain-on-failure',
    // NOTE: `viewport` does nothing for _electron.launch pages, and page.setViewportSize()
    // installs a device-metrics override instead of resizing the window. Size the
    // BrowserWindow - see e2e/helpers/launch.ts.
  },
})
