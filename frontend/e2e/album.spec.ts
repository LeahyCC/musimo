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

test('an unavailable destination is flagged on one line', async ({ page }) => {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
    else await route.fallback()
  })
  await emptyQueue(page)
  await page.route('**/api/albums/42*', (route) =>
    route.fulfill({
      json: {
        album: { ...track, id: 42, kind: 'album', title: 'Fixture album' },
        tracks: [track],
        label: 'Fixture label',
        duration: 180,
        complete: true,
      },
    }),
  )
  await page.route('**/api/diagnostics', (route) =>
    route.fulfill({
      json: {
        health: { status: 'ok', version: '1.0.0', uptime_seconds: 100, phase: 1 },
        versions: {},
        disks: [
          { path: '/data', free_bytes: 10000, total_bytes: 20000, exists: true, writable: true },
          { path: '/music', free_bytes: 10000, total_bytes: 20000, exists: true, writable: false },
        ],
        sources: [],
        events: [],
        database: { mode: 'wal', schema: 1, retained_events: 0 },
        library: {
          status: 'idle',
          walked: 0,
          indexed: 0,
          errors: 0,
          elapsed: 0,
          detail: 'Ready',
          total_files: 0,
          roots: ['/music'],
        },
        queue: { paused: false, source_paused: false },
        capabilities: { settings: true, events: true, search: true, downloads: true },
        navidrome: null,
        last_download: null,
      },
    }),
  )

  await page.goto('/albums/42')
  const target = page.locator('.album-actions .download-target')
  const warning = target.getByRole('link', { name: 'not available' })
  await expect(warning).toBeVisible()
  // The warning icon sits on the same line as its link rather than on a line of its own.
  const icon = await target.locator('svg').boundingBox()
  const link = await warning.boundingBox()
  if (!icon || !link) throw new Error('Missing warning measurements')
  expect(Math.abs(icon.y + icon.height / 2 - (link.y + link.height / 2))).toBeLessThan(6)
})

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
