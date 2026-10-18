import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'
import { expect, test } from './test'

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

for (const layout of ['classic', 'room'] as const) {
  test.describe(`Accessibility (${layout})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('musimo.layout', value), layout)
    })

    test('home page should not have accessibility violations', async ({ page }) => {
      await page.goto('/')
      await page
        .getByRole('heading', {
          name: /^(Good (morning|afternoon|evening)|Home|Let.s find your music)$/,
          level: 1,
        })
        .waitFor()
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations).toEqual([])
    })

    test('search page should not have accessibility violations', async ({ page }) => {
      await page.goto('/search')
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations).toEqual([])
    })

    test('library page should not have accessibility violations', async ({ page }) => {
      await page.goto('/library/albums')
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
      // The title is the page's one h1 now that the Library heading is gone from detail pages.
      const header = page.locator('.collection-header')
      await expect(header.getByRole('heading', { level: 1, name: 'Clear Water' })).toBeVisible()
      await expect(header).toContainText('ALBUM · 2018')
      await expect(header.locator('.collection-cover img')).toBeVisible()
      await expect(header.getByRole('link', { name: 'Harbor Static' })).toHaveAttribute(
        'href',
        '/library/artists/artist-1',
      )
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations).toEqual([])
    })

    test('artist page should not have accessibility violations', async ({ page }) => {
      await libraryFixtures(page)
      await page.route('/api/library/artists/artist-1', (route) =>
        route.fulfill({
          json: {
            id: 'artist-1',
            name: 'Harbor Static',
            coverArt: 'a1',
            albumCount: 1,
            album: [
              {
                id: 'album-1',
                name: 'Clear Water',
                artist: 'Harbor Static',
                artistId: 'artist-1',
                coverArt: 'cover-1',
                year: 2018,
                songCount: 2,
              },
            ],
          },
        }),
      )

      await page.route('/api/library/artists/artist-1/tracks', (route) =>
        route.fulfill({ json: { items: [librarySong('s1', { title: 'First Light' })] } }),
      )
      await page.goto('/library/artists/artist-1')
      await expect(
        page.locator('.collection-header').getByRole('heading', { level: 1 }),
      ).toHaveText('Harbor Static')
      await expect(page.locator('.collection-header .collection-cover img')).toBeVisible()
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations).toEqual([])
    })

    test('playlist page should not have accessibility violations', async ({ page }) => {
      await libraryFixtures(page)
      const song = librarySong('s1', { title: 'First Light' })
      await page.route(
        (url) => url.pathname === '/api/library/playlists',
        (route) => route.fulfill({ json: { items: [], liked_id: 'liked' } }),
      )

      await page.route('/api/library/playlists/road', (route) =>
        route.fulfill({
          json: {
            id: 'road',
            name: 'Road trip',
            songCount: 1,
            duration: 214,
            public: false,
            owner: 'listener',
            changed: '2026-09-01T00:00:00Z',
            entry: [song],
          },
        }),
      )
      await page.goto('/library/playlists/road')
      await expect(
        page.locator('.collection-header').getByRole('heading', { level: 1 }),
      ).toHaveText('Road trip')
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations).toEqual([])
    })
  })
}
