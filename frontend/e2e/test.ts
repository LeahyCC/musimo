import { test as base } from '@playwright/test'

export { expect } from '@playwright/test'

/**
 * Playwright's `test`, with the page's routes taken down before the page closes.
 *
 * Many fixtures pass a request through to the server and read its answer (`route.fetch()`). The
 * app keeps asking for its snapshot and diagnostics until the test ends, so one of those reads can
 * still be waiting when the context closes, and it then fails with "Response has been disposed".
 * That failure belongs to the teardown, not to what the test checked, so it is dropped here.
 */
export const test = base.extend<{ quietRoutes: void }>({
  quietRoutes: [
    async ({ page }, use) => {
      await use()
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    },
    { auto: true },
  ],
})
