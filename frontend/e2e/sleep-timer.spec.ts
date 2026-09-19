import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

const alpha = librarySong('song-a', { title: 'Alpha', duration: 30 })
const bravo = librarySong('song-b', { title: 'Bravo', duration: 30 })

/** Now Playing with two songs restored, the clock under the test's control, and Alpha playing. */
async function playOnNowPlaying(page: Page) {
  await page.clock.install()
  await page.addInitScript(() => localStorage.setItem('musimo.now-playing-view', 'artwork'))
  await playerFixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: 'song-a', position: 0, entry: [alpha, bravo] } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/scrobble', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/player/lyrics/**', (route) => route.fulfill({ json: { items: [] } }))
  await page.goto('/now-playing')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
}

test('a timed sleep counts down, can be cancelled, and pauses when it runs out', async ({
  page,
}) => {
  await playOnNowPlaying(page)
  const timer = page.getByRole('combobox', { name: 'Sleep timer' })

  await timer.selectOption('15')
  await expect(page.getByText(/1[45]:\d\d left/)).toBeVisible()

  // Cancelling takes the countdown away and leaves the music alone.
  await page.getByRole('button', { name: 'Cancel sleep timer' }).click()
  await expect(page.getByText(/left$/)).toHaveCount(0)
  await expect(timer).toHaveValue('off')
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()

  // Run one out: the clock is the test's, so fifteen minutes pass at once.
  await timer.selectOption('15')
  await page.clock.fastForward('15:05')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await expect(timer).toHaveValue('off')
})

test('end of album or queue is not offered with shuffle on', async ({ page }) => {
  await playOnNowPlaying(page)
  const option = page
    .getByRole('combobox', { name: 'Sleep timer' })
    .locator('option[value="queue"]')
  await expect(option).toBeEnabled()
  await page.getByRole('button', { name: 'Shuffle', exact: true }).first().click()
  await expect(option).toBeDisabled()
})
