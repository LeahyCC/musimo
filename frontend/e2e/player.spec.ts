import { expect, test } from '@playwright/test'

const song = {
  id: 'song-1',
  title: 'First Light',
  artist: 'Harbor Static',
  artistId: 'artist-1',
  album: 'Clear Water',
  albumId: 'album-1',
  coverArt: 'cover-1',
  duration: 184,
  track: 1,
}

test('library playback opens the full player and starts AudioMuse radio', async ({ page }) => {
  await page.route('**/api/player/capabilities', (route) =>
    route.fulfill({
      json: {
        configured: true,
        available: true,
        version: '0.63.2',
        extensions: ['sonicSimilarity', 'songLyrics'],
        sonic_similarity: true,
        detail: 'Navidrome is ready',
      },
    }),
  )

  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: '', position: 0, entry: [] } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/scrobble', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/player/stream/**', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: '' }),
  )

  await page.route('**/api/player/art/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#283d31"/></svg>',
    }),
  )

  await page.route('**/api/library/albums?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'album-1',
            name: 'Clear Water',
            artist: 'Harbor Static',
            coverArt: 'cover-1',
            songCount: 1,
            genre: 'Ambient',
            year: 2026,
          },
        ],
        next_offset: null,
      },
    }),
  )

  await page.route('**/api/library/albums/album-1', (route) =>
    route.fulfill({
      json: {
        id: 'album-1',
        name: 'Clear Water',
        artist: 'Harbor Static',
        coverArt: 'cover-1',
        songCount: 1,
        song: [song],
      },
    }),
  )

  await page.route('**/api/player/lyrics/song-1', (route) =>
    route.fulfill({
      json: { items: [{ line: [{ start: 0, value: 'Morning finds the water' }] }] },
    }),
  )

  await page.route('**/api/player/radio/song-1?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            entry: { ...song, id: 'song-2', title: 'Night Signal' },
            similarity: 0.94,
          },
        ],
      },
    }),
  )

  await page.goto('/library')
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible()
  await expect(page.getByText('AUDIOMUSE READY')).toBeVisible()
  await page.getByLabel('Search albums').fill('clear water')
  await expect(page.getByRole('button', { name: /Clear Water/ })).toBeVisible()
  await page.getByLabel('Sort home').selectOption('title')
  await page.getByLabel('Filter by genre').selectOption('Ambient')
  await page.getByLabel('Filter by year').selectOption('2026')
  await page.getByRole('button', { name: /Clear Water/ }).click()
  await page.getByRole('button', { name: 'Play all' }).click()
  await expect(page.locator('.live-player')).toContainText('First Light')

  await page.locator('.live-player').getByRole('link', { name: 'First Light' }).click()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  await expect(page.getByText('Morning finds the water')).toBeVisible()
  await page.getByRole('button', { name: 'Start AudioMuse radio' }).click()
  await expect(page.getByText('Night Signal')).toBeVisible()
})
