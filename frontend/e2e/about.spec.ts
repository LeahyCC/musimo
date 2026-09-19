import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

const alpha = librarySong('song-a', { title: 'Alpha' })
const bravo = librarySong('song-b', { title: 'Bravo', track: 2, duration: 180 })

const flac = {
  id: 'song-a',
  suffix: 'flac',
  bitRate: 1012,
  samplingRate: 44100,
  bitDepth: 0,
  channelCount: 2,
  size: 35_840_000,
  path: 'Harbor Static/Clear Water/01 Alpha.flac',
  year: 2020,
  genres: [{ name: 'Ambient' }],
  track: 1,
  discNumber: 1,
  playCount: 4,
  played: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  contributors: [{ role: 'producer', artist: { name: 'Maker' } }],
}

/** Opens Now Playing with `song` as what Navidrome says about Alpha, or nothing at all. */
async function openNowPlaying(page: Page, song: Record<string, unknown> | null, tab = 'about') {
  await page.addInitScript((saved) => {
    localStorage.setItem('musimo.now-playing-view', 'artwork')
    localStorage.setItem('musimo.now-playing-tab', saved)
  }, tab)
  await playerFixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: 'song-a', position: 0, entry: [alpha, bravo] } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/lyrics/**', (route) => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/player/song/song-a', (route) =>
    song ? route.fulfill({ json: song }) : route.fulfill({ status: 404, json: { detail: 'no' } }),
  )

  await page.route('**/api/library/albums/album-1', (route) =>
    route.fulfill({
      json: {
        id: 'album-1',
        name: 'Clear Water',
        artist: 'Harbor Static',
        artistId: 'artist-1',
        songCount: 2,
        recordLabels: [{ name: 'Static Records' }],
        song: [alpha, bravo],
      },
    }),
  )

  await page.route('**/api/library/artists/artist-1', (route) =>
    route.fulfill({
      json: {
        id: 'artist-1',
        name: 'Harbor Static',
        album: [
          { id: 'album-1', name: 'Clear Water', year: 2020 },
          { id: 'album-2', name: 'Low Tide', year: 2018 },
        ],
      },
    }),
  )
  await page.goto('/now-playing')
  await expect(page.getByRole('heading', { level: 1, name: 'Alpha' })).toBeVisible()
}

test('the file is summed up in one line under the artist', async ({ page }) => {
  await openNowPlaying(page, flac, 'up-next')
  await expect(page.getByText('FLAC, 44.1 kHz, 1,012 kbps')).toBeVisible()
})

test('About lists the file, the release, the listening and what else is owned', async ({
  page,
}) => {
  await openNowPlaying(page, flac)
  const panel = page.getByRole('tabpanel', { name: 'About' })
  await expect(page.getByRole('tab', { name: 'About' })).toHaveAttribute('aria-selected', 'true')

  const file = panel.locator('section', { has: page.getByRole('heading', { name: 'File' }) })
  await expect(file).toContainText('1,012 kbps')
  await expect(file).toContainText('44.1 kHz')
  await expect(file).toContainText('Stereo')
  await expect(file).toContainText('34.2 MB')
  await expect(file).toContainText('Harbor Static/Clear Water/01 Alpha.flac')
  // Navidrome sent a bit depth of 0, which is "not known" and gets no row.
  await expect(panel.getByText('Bit depth')).toHaveCount(0)

  const release = panel.locator('section', { has: page.getByRole('heading', { name: 'Release' }) })
  await expect(release).toContainText('Static Records')
  await expect(release).toContainText('2020')
  await expect(release).toContainText('Ambient')
  await expect(release).toContainText('Producer')
  await expect(release).toContainText('Maker')

  const listening = panel.locator('section', {
    has: page.getByRole('heading', { name: 'Listening' }),
  })
  await expect(listening).toContainText('4')
  await expect(listening).toContainText('3 hours ago')

  await expect(panel.getByRole('link', { name: /Low Tide/ })).toHaveAttribute(
    'href',
    '/library/albums/album-2',
  )
  // The playing album is not offered as "more", and neither is the playing song as "the rest".
  await expect(panel.getByRole('link', { name: /Clear Water/ })).toHaveCount(0)
  await expect(panel.getByText('Bravo')).toBeVisible()
  await expect(panel.getByText('Alpha', { exact: true })).toHaveCount(0)
})

test('a good file has no suggestion to look for another', async ({ page }) => {
  await openNowPlaying(page, flac)
  await expect(page.getByRole('tabpanel', { name: 'About' })).toContainText('1,012 kbps')
  await expect(page.getByRole('link', { name: 'Look for a better version' })).toHaveCount(0)
})

test('a small lossy file has a quiet link that searches for it', async ({ page }) => {
  await openNowPlaying(page, { ...flac, suffix: 'mp3', bitRate: 128 })
  await expect(page.getByRole('link', { name: 'Look for a better version' })).toHaveAttribute(
    'href',
    /\/search\?q=Harbor(\+|%20)Static(\+|%20)Alpha/,
  )
})

test('opening the album from About marks the playing song there', async ({ page }) => {
  await openNowPlaying(page, flac)
  const panel = page.getByRole('tabpanel', { name: 'About' })
  await panel.getByRole('link', { name: 'Open album' }).click()
  await expect(page).toHaveURL(/\/library\/albums\/album-1\?track=song-a$/)
  await expect(page.getByRole('button', { name: /^(Play|Pause) Alpha$/ })).toHaveAttribute(
    'aria-current',
    'true',
  )

  await expect(page.getByRole('button', { name: /^(Play|Pause) Bravo$/ })).not.toHaveAttribute(
    'aria-current',
    'true',
  )
})

test('with nothing known about the file the tab shows no empty labels', async ({ page }) => {
  await openNowPlaying(page, null)
  const panel = page.getByRole('tabpanel', { name: 'About' })
  await expect(panel.getByRole('heading', { name: 'Release' })).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'File' })).toHaveCount(0)
  await expect(panel.getByRole('heading', { name: 'Listening' })).toHaveCount(0)
  await expect(panel.getByText('Bit depth')).toHaveCount(0)
  await expect(page.getByText('kbps')).toHaveCount(0)
})
