import type { Page } from '@playwright/test'

import { playerFixtures } from './library-fixtures'
import { emptyQueue } from './queue-fixtures'
import { searchFixtures } from './search-fixtures'
import { expect, test } from './test'

async function open(page: Page, layout: 'classic' | 'room', url: string) {
  await page.addInitScript((value) => localStorage.setItem('musimo.layout', value), layout)
  await playerFixtures(page)
  await emptyQueue(page)
  await searchFixtures(page)
  // The artist download sheet reads its plan when it opens; an empty one is enough to see it open.
  await page.route('**/api/artists/7/download-plan*', (route) =>
    route.fulfill({ json: { albums: [] } }),
  )
  await page.goto(url)
}

test('Classic: the top result shows what the library holds and opens the artist sheet', async ({
  page,
}) => {
  await open(page, 'classic', '/search?q=Fixture')
  const top = page.getByRole('region', { name: 'Top result' })
  await expect(top.getByRole('link', { name: 'Fixture artist' })).toBeVisible()
  // The fixture albums hold two of their four songs.
  await expect(top.getByText('2 songs in library')).toBeVisible()
  // Classic's search is the top bar's box at every width; the page has none of its own.
  await expect(page.getByRole('search')).toHaveCount(0)
  await top.getByRole('button', { name: 'Get missing albums' }).click()
  await expect(page.getByRole('dialog', { name: 'Choose albums to download' })).toBeVisible()
})

test('Classic: a phone searches from the top bar, with no second box in the page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, 'classic', '/search?q=Fixture')
  await expect(page.getByRole('textbox', { name: 'Search music or paste a link' })).toHaveValue(
    'Fixture',
  )
  await expect(page.getByRole('search')).toHaveCount(0)
})

test('Listening room: the banner counts the missing songs and the field is always there', async ({
  page,
}) => {
  await open(page, 'room', '/search?q=Fixture')
  await expect(page.getByRole('search')).toBeVisible()
  const banner = page.getByRole('region', { name: 'Top result' })
  const missing = banner.getByRole('button', { name: 'Get the 2 missing' })
  await expect(banner.getByText('2 missing of 4')).toBeVisible()
  await missing.click()
  await expect(page.getByRole('dialog', { name: 'Choose albums to download' })).toBeVisible()
})

test('typing in the page field changes the search in the URL', async ({ page }) => {
  await open(page, 'room', '/search?q=Fixture')
  await page.getByRole('searchbox', { name: 'Search the catalog' }).fill('Harbor')
  await expect(page).toHaveURL(/q=Harbor/)
})

test('a track row names its library state and the download icon follows it', async ({ page }) => {
  await open(page, 'classic', '/search?q=Fixture&tab=track')
  const row = page.locator('.track-row', { hasText: 'Morning Signal' })
  await expect(row.locator("[data-ui='ownership']")).toHaveText('Not in library')
  await expect(row.getByRole('button', { name: /^Download Morning Signal/ })).toBeEnabled()
})
