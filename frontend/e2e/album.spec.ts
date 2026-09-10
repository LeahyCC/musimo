import { expect, test } from '@playwright/test'

import type { MusicResult } from '../src/api'
import { ORIGIN } from './env'
import { emptyQueue } from './queue-fixtures'

const track: MusicResult = {
  id: 101,
  kind: 'track',
  title: 'Recording 1',
  artist: 'Fixture artist',
  artist_id: 7,
  album: 'Fixture album',
  album_id: 42,
  art: '',
  duration: 180,
  year: 2020,
  explicit: false,
  preview: '',
  isrc: '',
  popularity: 1,
  track_count: 2,
  record_type: 'album',
  ownership: 'missing',
  matched_paths: [],
  matched_by: '',
  matched_album: '',
  owned_count: 0,
  coverage_verified: true,
  disc: 1,
  position: 1,
}

for (const ownedCount of [0, 1, 2]) {
  test(`album download adapts to ${ownedCount} of 2 owned tracks`, async ({ page }) => {
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
      else await route.fallback()
    })
    // The download buttons below read the queue, so it comes from the fixture rather than
    // from whatever the shared backend happens to be holding.
    await emptyQueue(page)
    const tracks: MusicResult[] = [0, 1].map((index) => ({
      ...track,
      id: 101 + index,
      title: `Recording ${index + 1}`,
      ownership: index < ownedCount ? 'owned' : 'missing',
    }))
    await page.route('**/api/albums/42*', (route) =>
      route.fulfill({
        json: {
          album: {
            ...track,
            id: 42,
            kind: 'album',
            title: 'Fixture album',
            owned_count: ownedCount,
            ownership: ownedCount === 2 ? 'owned' : ownedCount === 1 ? 'partial' : 'missing',
          },
          tracks,
          label: 'Fixture label',
          duration: 360,
          complete: true,
        },
      }),
    )
    let batch: unknown
    await page.route('**/api/batches', async (route) => {
      batch = route.request().postDataJSON()
      await route.fulfill({ json: { id: 'fixture', jobs: [], skipped: ownedCount } })
    })
    await page.goto('/albums/42')
    const action = page.locator('.album-actions').getByRole('button')
    await expect(action).toHaveCount(1)
    await expect(action).toHaveText(ownedCount === 1 ? 'Download missing (1)' : 'Download album')
    await expect(page.locator('.album-actions').getByText('to /music · Original')).toBeVisible()
    if (ownedCount === 2) await expect(action).toBeDisabled()
    else {
      await expect(action).toBeEnabled()
      await action.click()
      await expect
        .poll(() => batch)
        .toMatchObject({
          album_id: 42,
          missing_only: ownedCount > 0,
          format: 'original',
          target: '/music',
        })
    }

    for (const item of tracks) {
      const button = page.getByRole('button', {
        name:
          item.ownership === 'owned'
            ? `${item.title} is in your library`
            : `Download ${item.title} to /music`,
      })
      if (item.ownership === 'owned') await expect(button).toBeDisabled()
      else await expect(button).toBeEnabled()
    }
  })
}
