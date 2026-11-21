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

/**
 * Call first in a test that needs a song to load or play. It skips the test on WebKit on Windows
 * and nowhere else, so the test still runs on Linux and macOS, in Chromium and Firefox, and in the
 * phone project (Chromium).
 *
 * Why: Playwright's WebKit build for Windows has no media backend. An `<audio>` element fails the
 * WAV fixtures with MEDIA_ERR_SRC_NOT_SUPPORTED (code 4), and `play()` rejects with
 * NotSupportedError, even though `canPlayType` answers "probably" for WAV, MP3, FLAC and MP4, so
 * it cannot be used to detect this. The player is right to skip a song it cannot play, so a test
 * that needs the song cannot reach what it checks. Use it in the one test that needs audio, not
 * for a whole spec file.
 */
export function skipWithoutAudio(): void {
  // The project's browser, not `browserName`, so this needs no fixture and no change to the
  // test's signature. Desktop Safari is the only WebKit project.
  const webkit = test.info().project.use.defaultBrowserType === 'webkit'
  test.skip(
    webkit && process.platform === 'win32',
    'Playwright WebKit on Windows cannot decode audio, so no song loads or plays.',
  )
}
