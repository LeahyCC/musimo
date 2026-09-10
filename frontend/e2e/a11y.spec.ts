import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

async function libraryFixtures(page: Page) {
  await playerFixtures(page)
  await page.route('/api/library/albums/album-1', (route) =>
    route.fulfill({
      json: {
        id: 'album-1',
        name: 'Clear Water',
        artist: 'Harbor Static',
        artistId: 'artist-1',
        year: 2018,
        coverArt: 'cover-1',
        songCount: 2,
        duration: 428,
        playCount: 0,
        song: [
          librarySong('s1', { title: 'First Light', track: 1 }),
          librarySong('s2', { title: 'Second Track', track: 2 }),
        ],
      },
    }),
  )

  await page.route('/api/library/tracks*', (route) =>
    route.fulfill({ json: { items: [], next_offset: null, total: 0, genres: [], years: [] } }),
  )
}

test.describe('Accessibility', () => {
  test('search page should not have accessibility violations', async ({ page }) => {
    await page.goto('/')
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })

  test('library page should not have accessibility violations', async ({ page }) => {
    await page.goto('/library')
    await page.waitForSelector('h1')
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })

  test('downloads page should not have accessibility violations', async ({ page }) => {
    await page.goto('/downloads')
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })

  test('settings page should not have accessibility violations', async ({ page }) => {
    await page.goto('/settings')
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })

  test('diagnostics page should not have accessibility violations', async ({ page }) => {
    await page.goto('/diagnostics')
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })

  test('album page should not have accessibility violations', async ({ page }) => {
    await libraryFixtures(page)
    await page.goto('/library/albums/album-1')
    await page.waitForSelector('h2')
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })
})
