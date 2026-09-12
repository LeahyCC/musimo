import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

const song = librarySong('song-1', { title: 'First Light', duration: 30 })
const NOTICE = 'This browser has no WebGPU'

// Play a library track and open Now Playing. The saved queue carries the
// track, so a reload lands back on the same stage.
async function openNowPlaying(page: Page) {
  await playerFixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: 'song-1', position: 0, entry: [song] } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/lyrics/song-1', (route) => route.fulfill({ json: { items: [] } }))
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
  await page.goto('/library/albums/album-1')
  await page.getByRole('button', { name: 'Play all' }).click()
  await page.getByRole('link', { name: 'Open Now Playing' }).click()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  return page.locator('.stage')
}

test('without WebGPU the stage shows artwork and says so once', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true })
  })
  const stage = await openNowPlaying(page)
  await expect(stage.locator('img.stage-art')).toBeVisible()
  await expect(stage.locator('canvas.stage-visualizer')).toHaveCount(0)
  await expect(page.getByText(NOTICE)).toBeVisible()
  await stage.hover()
  await expect(stage.getByRole('button', { name: 'Full screen' })).toBeVisible()
  await expect(stage.getByRole('button', { name: /Show (artwork|visualizer)/ })).toHaveCount(0)

  // The notice is for the first visit only.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  await expect(page.locator('.stage img.stage-art')).toBeVisible()
  await expect(page.getByText(NOTICE)).toHaveCount(0)
  expect(
    await page.evaluate(() => localStorage.getItem('musimo.now-playing-visualizer-notice')),
  ).toBe('shown')
})

test('with WebGPU the visualizer is the default, V and the button switch it, and the choice sticks', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  const stage = await openNowPlaying(page)
  // Headless engines often expose navigator.gpu without an adapter; the stage
  // then falls back to artwork, which the previous test covers.
  const adapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  )
  test.skip(!adapter, 'No WebGPU adapter in this browser.')

  const canvas = stage.locator('canvas.stage-visualizer')
  await expect(canvas).toBeVisible()
  await expect(canvas).toHaveAttribute('data-adapter', /.+/)
  // Structure only: which post stages are running, not what they look like.
  await expect(canvas).toHaveAttribute('data-post', /feedback bloom chroma tonemap grain/)
  await stage.hover()
  await expect(stage.getByRole('button', { name: 'Show artwork' })).toBeVisible()
  await expect(stage.getByRole('combobox', { name: 'Particle count' })).toBeVisible()

  // Shortcuts apply while the stage holds focus.
  await stage.focus()
  await page.keyboard.press('h')
  await expect(stage.locator('canvas.stage-hud')).toBeVisible()
  await page.keyboard.press('v')
  await expect(stage.locator('img.stage-art')).toBeVisible()
  await expect(canvas).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('musimo.now-playing-view'))).toBe('artwork')
  await page.keyboard.press('m')
  await expect(stage.getByRole('button', { name: 'Unmute' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  await expect(page.locator('.stage img.stage-art')).toBeVisible()
  await page.locator('.stage').hover()
  await page.getByRole('button', { name: 'Show visualizer' }).click()
  await expect(page.locator('.stage canvas.stage-visualizer')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('musimo.now-playing-view'))).toBe(
    'visualizer',
  )
})
