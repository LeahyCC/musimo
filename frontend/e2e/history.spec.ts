import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

const alpha = librarySong('song-a', { title: 'Alpha' })
const bravo = librarySong('song-b', { title: 'Bravo' })

const entry = (id: string, title: string, playedAt: number) => ({
  id,
  title,
  artist: 'Fixture Artist',
  album: 'Fixture Album',
  duration: 30,
  playedAt,
})

/** Opens Now Playing on the History tab with two songs queued and two older ones in the history. */
async function openHistory(page: Page) {
  const now = Date.now()
  await page.addInitScript(
    (history) => {
      localStorage.setItem('musimo.now-playing-view', 'artwork')
      localStorage.setItem('musimo.now-playing-tab', 'history')
      // Only on a browser with no history yet, so a clear made in the test survives its reload.
      if (localStorage.getItem('musimo.play-history') === null)
        localStorage.setItem('musimo.play-history', JSON.stringify(history))
    },
    [
      entry('song-x', 'Xylophone', now - 5 * 60_000),
      entry('song-y', 'Yonder', now - 3 * 3_600_000),
    ],
  )
  await playerFixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: 'song-a', position: 0, entry: [alpha, bravo] } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/lyrics/**', (route) => route.fulfill({ json: { items: [] } }))
  await page.goto('/now-playing')
  await expect(page.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true')
}

test('history lists what played, newest first, with how long ago', async ({ page }) => {
  await openHistory(page)
  const rows = page
    .getByRole('tabpanel', { name: 'History' })
    .getByRole('button', { name: /^Play / })
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Xylophone')
  await expect(rows.nth(0)).toContainText(/5 min/)
  await expect(rows.nth(1)).toContainText('Yonder')
})

test('playing a history row keeps the queue and puts the song straight after what was playing', async ({
  page,
}) => {
  await openHistory(page)
  await page.getByRole('button', { name: 'Play Xylophone' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Xylophone' })).toBeVisible()

  // Bravo was lined up before the look back and still is.
  await page.getByRole('tab', { name: 'Up next' }).click()
  await expect(page.getByRole('tabpanel', { name: 'Up next' })).toContainText('Bravo')
})

test('clear history asks first, empties the list and stays empty after a reload', async ({
  page,
}) => {
  await openHistory(page)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Clear history' }).click()
  await expect(page.getByText('Nothing played yet.')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Nothing played yet.')).toBeVisible()
})
