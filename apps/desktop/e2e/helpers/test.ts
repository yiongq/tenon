import { test as base } from '@playwright/test'
import { sweepUserDataDirs } from './launch.js'

/**
 * The `test` every spec in this directory imports, instead of `@playwright/test`'s.
 *
 * It adds one automatic fixture: the temporary profile roots `makeUserDataDir` handed out during
 * a test are deleted once that test has PASSED, and kept when it has not. Specs relaunch into the
 * same root on purpose (acceptance 5 and 9), so the sweep can only happen after the test ends —
 * which is exactly where a teardown fixture runs, after the body and after any `afterEach`.
 */
export const test = base.extend<{ tempProfiles: void }>({
  tempProfiles: [
    // This fixture needs no other fixture, but Playwright inspects the source of the first
    // parameter to decide what to build and REFUSES anything but a destructuring pattern.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      await use()
      sweepUserDataDirs(testInfo.status === testInfo.expectedStatus)
    },
    { auto: true },
  ],
})

export { expect } from '@playwright/test'
