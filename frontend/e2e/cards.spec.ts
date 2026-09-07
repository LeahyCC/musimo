import { expect, test } from '@playwright/test'

import type { MusicResult } from '../src/api'

test('card links and download controls work independently in a natural-height grid', async ({
  page,
  isMobile,
}) => {
  const albums: MusicResult[] = Array.from({ length: 13 }, (_, index) => ({
    id: 42 + index,
    kind: 'album',
    title: `Album ${index + 1}`,
    artist: 'Fixture artist',
    artist_id: 7,
    album: '',
    album_id: 42 + index,
    art: '',
    duration: 180,
    year: 2020,
    explicit: false,
    preview: '',
    isrc: '',
    popularity: 1,
    track_count: 1,
    record_type: 'album',
    ownership: 'missing',
    matched_paths: [],
    owned_count: 0,
    coverage_verified: true,
    disc: 1,
    position: 1,
  }))
  await page.route('**/api/search?*', (route) =>
    route.fulfill({
      json: { items: albums, total: albums.length, next_index: null, cached: false },
    }),
  )

  await page.route('**/api/albums/*', (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    const album = albums.find((item) => item.id === id)
    return route.fulfill({ json: { album, tracks: [], label: '', duration: 180, complete: true } })
  })

  await page.route('**/api/artists/7*', (route) =>
    route.fulfill({
      json: {
        artist: { id: 7, name: 'Fixture artist', art: '' },
        items: [],
        next_index: null,
      },
    }),
  )

  await page.route('**/api/batches', (route) =>
    route.fulfill({
      json: { id: 'fixture', jobs: [], skipped: 0 },
    }),
  )
  await page.goto('/search?q=Fixture&tab=album')
  const cards = page.getByRole('article')
  await expect(cards).toHaveCount(13)
  await expect(page.locator('.virtual-list')).toHaveCount(0)
  const download = cards
    .first()
    .getByRole('button', { name: 'Download missing tracks from Album 1' })
  await expect(download).toHaveCSS('opacity', isMobile ? '1' : '0')
  await download.focus()
  await expect(download).toHaveCSS('opacity', '1')
  await download.click()
  await expect(page).toHaveURL(/\/search\?/)
  await expect(cards.first().getByText('Nothing missing')).toBeVisible()
  await cards.first().getByRole('link', { name: 'Fixture artist' }).click()
  await expect(page).toHaveURL(/\/artists\/7$/)
  await page.goBack()
  await expect(cards).toHaveCount(13)
  await cards.first().click({ position: { x: 12, y: 60 } })
  await expect(page).toHaveURL(/\/albums\/42$/)
})
