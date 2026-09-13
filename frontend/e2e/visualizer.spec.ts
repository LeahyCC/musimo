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
  await expect(stage.getByRole('combobox', { name: 'Preset' })).toBeVisible()
  await expect(stage.getByRole('combobox', { name: 'Scene' })).toBeVisible()
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

test('the scene choice switches the size control and survives a reload', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  const stage = await openNowPlaying(page)
  const adapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  )
  test.skip(!adapter, 'No WebGPU adapter in this browser.')

  await stage.hover()
  // Structure only: which scene is named on the canvas, not what it draws.
  await expect(stage.locator('canvas.stage-visualizer')).toHaveAttribute('data-scene', 'particles')
  await stage.getByRole('combobox', { name: 'Scene' }).selectOption('fluid')
  await expect(stage.getByRole('combobox', { name: 'Fluid grid' })).toBeVisible()
  await expect(stage.getByRole('combobox', { name: 'Particle count' })).toHaveCount(0)
  await expect(stage.locator('canvas.stage-visualizer')).toHaveAttribute('data-scene', 'fluid')
  expect(await page.evaluate(() => localStorage.getItem('musimo.visualizer-scene'))).toBe('fluid')

  await stage.getByRole('combobox', { name: 'Scene' }).selectOption('raymarch')
  await expect(stage.getByRole('combobox', { name: 'Raymarch steps' })).toBeVisible()
  await expect(stage.getByRole('combobox', { name: 'Fluid grid' })).toHaveCount(0)
  await expect(stage.locator('canvas.stage-visualizer')).toHaveAttribute('data-scene', 'raymarch')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  await page.locator('.stage').hover()
  await expect(page.getByRole('combobox', { name: 'Scene' })).toHaveValue('raymarch')
  await expect(page.getByRole('combobox', { name: 'Raymarch steps' })).toBeVisible()
})

test('the preset picker, [ and ], and the choice surviving a reload', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  const stage = await openNowPlaying(page)
  const adapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  )
  test.skip(!adapter, 'No WebGPU adapter in this browser.')

  const picker = stage.getByRole('combobox', { name: 'Preset' })
  const canvas = stage.locator('canvas.stage-visualizer')
  await stage.hover()
  // Structure only: which preset the canvas names, not what it draws.
  await expect(picker).toHaveValue('drift')
  await expect(canvas).toHaveAttribute('data-preset', 'drift')

  // ] walks forward through the six and [ walks back. The second preset is
  // the particle field's other one, so the scene select does not move yet.
  await stage.focus()
  await page.keyboard.press(']')
  await expect(picker).toHaveValue('storm')
  await expect(canvas).toHaveAttribute('data-preset', 'storm')
  await expect(stage.getByRole('combobox', { name: 'Scene' })).toHaveValue('particles')

  // The third belongs to the fluid, so choosing it moves the scene and its
  // size control with it rather than leaving the two disagreeing.
  await page.keyboard.press(']')
  await expect(picker).toHaveValue('plume')
  await expect(stage.getByRole('combobox', { name: 'Scene' })).toHaveValue('fluid')
  await expect(stage.getByRole('combobox', { name: 'Fluid grid' })).toBeVisible()
  await expect(canvas).toHaveAttribute('data-scene', 'fluid')

  await page.keyboard.press('[')
  await expect(picker).toHaveValue('storm')
  await expect(stage.getByRole('combobox', { name: 'Particle count' })).toBeVisible()

  // The picker itself sets the scene the same way.
  await picker.selectOption('furnace')
  await expect(stage.getByRole('combobox', { name: 'Scene' })).toHaveValue('raymarch')
  await expect(canvas).toHaveAttribute('data-preset', 'furnace')
  expect(await page.evaluate(() => localStorage.getItem('musimo.visualizer-preset'))).toBe(
    'furnace',
  )

  await page.reload()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  await page.locator('.stage').hover()
  await expect(page.getByRole('combobox', { name: 'Preset' })).toHaveValue('furnace')
  await expect(page.getByRole('combobox', { name: 'Scene' })).toHaveValue('raymarch')
})

test('choosing a scene moves the preset to that scene', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  const stage = await openNowPlaying(page)
  const adapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  )
  test.skip(!adapter, 'No WebGPU adapter in this browser.')

  await stage.hover()
  await stage.getByRole('combobox', { name: 'Scene' }).selectOption('raymarch')
  await expect(stage.getByRole('combobox', { name: 'Preset' })).toHaveValue('fold')
  await expect(stage.locator('canvas.stage-visualizer')).toHaveAttribute('data-preset', 'fold')
})
