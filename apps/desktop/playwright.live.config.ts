import { defineConfig } from '@playwright/test'
import { LIVE_SPEC, shared } from './playwright.shared.js'

/**
 * The manual, opt-in run: `pnpm test:live`, and nothing else, ever selects this file. It matches
 * the live spec ALONE, so even a stray path argument cannot pull another spec onto real
 * credentials, and the spec's own `test.skip(!TENON_LIVE)` stays as the second lock.
 */
export default defineConfig({
  ...shared,
  testMatch: [LIVE_SPEC],
})
