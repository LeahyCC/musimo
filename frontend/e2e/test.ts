import { test as base } from '@playwright/test'
import { readFileSync } from 'node:fs'

import { BASE_URL } from './env'

export { expect } from '@playwright/test'

/** The name globalSetup saved on the isolated stack. Empty when that file is not there yet. */
export function e2eListenerId(): string {
  try {
    return readFileSync(new URL('../../runtime/e2e-listener-id', import.meta.url), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Playwright's `test`, with the page's routes taken down before the page closes.
 *
 * Many fixtures pass a request through to the server and read its answer (`route.fetch()`). The
 * app keeps asking for its snapshot and diagnostics until the test ends, so one of those reads can
 * still be waiting when the context closes, and it then fails with "Response has been disposed".
 * That failure belongs to the teardown, not to what the test checked, so it is dropped here.
 */
export const test = base.extend<{ quietRoutes: void; listener: void }>({
  // API calls from a test (not the page) need the name, or listener routes answer 401.
  request: async ({ playwright }, use) => {
    const id = e2eListenerId()
    const api = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: id ? { 'X-Musimo-Listener': id } : {},
    })
    await use(api)
    await api.dispose()
  },
  quietRoutes: [
    async ({ page }, use) => {
      await use()
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    },
    { auto: true },
  ],
  // The page reads the id itself and sends it. A remembered name keeps the shell usable.
  listener: [
    async ({ page }, use) => {
      const id = e2eListenerId()
      if (id) {
        await page.addInitScript((listenerId) => {
          // A reload keeps a name this page already picked. An empty browser still starts as Listener.
          if (!localStorage.getItem('musimo.listener')) {
            localStorage.setItem('musimo.listener', listenerId)
            localStorage.setItem('musimo.listener-name', 'Listener')
          }
        }, id)

        await page.route('**/api/listeners', async (route) => {
          if (route.request().method() === 'GET') {
            await route.fulfill({ json: { items: [{ id, name: 'Listener' }] } })
            return
          }
          await route.fallback()
        })
      }
      await use()
    },
    { auto: true },
  ],
})
