import { defineConfig } from '@playwright/test'
import { LIVE_SPEC, shared } from './playwright.shared.js'

export default defineConfig({
  ...shared,
  /**
   * The ordinary run never even COLLECTS the live suite. Its own `test.skip(!LIVE)` is a runtime
   * guard, so with `TENON_LIVE=1` exported in a shell — which is exactly the shell of whoever
   * last ran `pnpm test:live` — `pnpm test:e2e` would spend tokens on real endpoints and write
   * into the developer's login keychain. `pnpm test:live` selects `playwright.live.config.ts`
   * instead, which is the only way to reach that file.
   */
  testIgnore: [LIVE_SPEC],
})
