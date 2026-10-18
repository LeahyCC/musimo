import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { playerFixtures } from './library-fixtures'
import { emptyQueue } from './queue-fixtures'
import { searchFixtures } from './search-fixtures'

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
  // On a desktop the top bar is the search box; the page's own is for phones.
  if ((page.viewportSize()?.width ?? 0) > 600) await expect(page.getByRole('search')).toBeHidden()
  await top.getByRole('button', { name: 'Get missing albums' }).click()
  await expect(page.getByRole('dialog', { name: 'Choose albums to download' })).toBeVisible()
})

test('Classic: a phone gets the search field in the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, 'classic', '/search?q=Fixture')
  await expect(page.getByRole('search')).toBeVisible()
  await expect(page.getByRole('searchbox', { name: 'Search the catalog' })).toHaveValue('Fixture')
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
