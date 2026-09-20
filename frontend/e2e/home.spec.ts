import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { playerFixtures } from './library-fixtures'

const SEARCHES_KEY = 'musimo.recent-searches'

/** Seeds this browser's remembered searches before the app starts. */
const rememberSearches = (page: Page, searches: string[]) =>
  page.addInitScript(
    ([key, value]) => localStorage.setItem(key ?? '', value ?? ''),
    [SEARCHES_KEY, JSON.stringify(searches)],
  )

const album = (id: string, name: string) => ({
  id,
  name,
  artist: 'Harbor Static',
  coverArt: `cover-${id}`,
  songCount: 9,
  duration: 1800,
  playCount: 0,
  year: 2026,
})

test('a new install offers the four starter artists and nothing else', async ({ page }) => {
  await playerFixtures(page)
  await page.route('**/api/library/albums*', (route) =>
    route.fulfill({ json: { items: [], next_offset: null, total: 0, genres: [], years: [] } }),
  )
  await page.goto('/')

  for (const name of ['Daft Punk', 'Khruangbin', 'Nina Simone', 'Radiohead'])
    await expect(page.getByRole('button', { name })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Recent searches' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Fresh in your library' })).toHaveCount(0)
})

test('recent searches come back as chips, and can be cleared', async ({ page }) => {
  await playerFixtures(page)
  await page.route('**/api/search?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, next_index: null, cached: false } }),
  )
  await rememberSearches(page, ['Portishead', 'Massive Attack'])
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Recent searches' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Portishead' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Massive Attack' })).toBeVisible()
  // Earlier searches stand in for the starters rather than sitting beside them.
  await expect(page.getByRole('button', { name: 'Radiohead' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Portishead' }).click()
  await expect(page).toHaveURL(/\/search\?q=Portishead/)

  await page.goto('/')
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Recent searches' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Radiohead' })).toBeVisible()
  expect(await page.evaluate((key) => localStorage.getItem(key), SEARCHES_KEY)).toBe('[]')
})

test('a search is remembered once it has settled, and only the last eight are kept', async ({
  page,
}) => {
  await playerFixtures(page)
  await page.route('**/api/search?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, next_index: null, cached: false } }),
  )
  const many = Array.from({ length: 8 }, (_, index) => `Artist ${index}`)
  await rememberSearches(page, many)
  await page.goto('/search?q=Portishead')

  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), SEARCHES_KEY), { timeout: 5000 })
    .toBe(JSON.stringify(['Portishead', ...many.slice(0, 7)]))
})

test('fresh albums show under the hero when the library is set up', async ({ page }) => {
  await playerFixtures(page)
  await page.route('**/api/library/albums*', (route) =>
    route.fulfill({
      json: {
        items: [album('a1', 'Clear Water'), album('a2', 'Low Tide')],
        next_offset: null,
        total: 2,
        genres: [],
        years: [],
      },
    }),
  )
  await page.goto('/')

  const shelf = page.getByRole('region', { name: 'Fresh in your library' })
  await expect(shelf.getByRole('link')).toHaveCount(2)
  await expect(shelf.getByRole('link', { name: /Clear Water/ })).toBeVisible()
  await shelf.getByRole('link', { name: /Low Tide/ }).click()
  await expect(page).toHaveURL(/\/library\/albums\/a2$/)
})
