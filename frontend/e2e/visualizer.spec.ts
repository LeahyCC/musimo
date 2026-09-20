import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

const song = librarySong('song-1', { title: 'First Light', duration: 30 })
const NOTICE = 'This browser has no WebGPU'

// Artwork is the default, so a test that needs the canvas asks for it. Only on a browser that has
// stored nothing, so a choice made in the test survives its own reload.
const showVisualizerFirst = (page: Page) =>
  page.addInitScript(() => {
    if (localStorage.getItem('musimo.now-playing-view') === null)
      localStorage.setItem('musimo.now-playing-view', 'visualizer')
  })

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
  await page.getByRole('link', { name: 'Open Now Playing' }).first().click()
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

test('artwork is the default even with WebGPU, and the Visualizer button turns it on', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  const stage = await openNowPlaying(page)
  const adapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  )
  test.skip(!adapter, 'No WebGPU adapter in this browser.')

  await expect(stage.locator('img.stage-art')).toBeVisible()
  await expect(stage.locator('canvas.stage-visualizer')).toHaveCount(0)
  await stage.hover()
  const toggle = stage.getByRole('button', { name: /^Visualizer/ })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(stage.locator('canvas.stage-visualizer')).toBeVisible()
})

test('the visualizer stops drawing while the tab is hidden and resumes, audio untouched', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await showVisualizerFirst(page)
  const stage = await openNowPlaying(page)
  const adapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  )
  test.skip(!adapter, 'No WebGPU adapter in this browser.')

  const canvas = stage.locator('canvas.stage-visualizer')
  await expect(canvas).toBeVisible()
  // Headless has no real tab switch, so the document's state is faked and the event fired.
  const setVisibility = (state: 'hidden' | 'visible') =>
    page.evaluate((next) => {
      Object.defineProperty(document, 'visibilityState', { value: next, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    }, state)
  await setVisibility('hidden')
  await expect(canvas).toHaveCount(0)
  await expect(stage.locator('img.stage-art')).toBeVisible()
  await setVisibility('visible')
  await expect(canvas).toBeVisible()
})

test('the visualizer rests after a long pause, keeps its picture through a short one, and returns on play', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await showVisualizerFirst(page)
  const stage = await openNowPlaying(page)
  const adapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  )
  test.skip(!adapter, 'No WebGPU adapter in this browser.')

  const canvas = stage.locator('canvas.stage-visualizer')
  await expect(canvas).toBeVisible()
  await page.getByRole('button', { name: 'Pause' }).click()
  // Well short of ten seconds: the picture stays.
  await page.waitForTimeout(3000)
  await expect(canvas).toBeVisible()
  // Past ten, the artwork takes over, the way it does for a hidden tab.
  await expect(canvas).toHaveCount(0, { timeout: 15_000 })
  await expect(stage.locator('img.stage-art')).toBeVisible()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(canvas).toBeVisible()
})

test('with WebGPU V and the button switch the view, and the choice sticks', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await showVisualizerFirst(page)
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
  await expect(stage.getByRole('button', { name: /^Visualizer/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(stage.getByRole('combobox', { name: 'Preset' })).toBeVisible()
  await expect(stage.getByRole('combobox', { name: 'Fluid grid' })).toBeVisible()
  // Two scenes, so the select is drawn. Fluid stays the default, and the grid
  // control belongs to it alone.
  const scenes = stage.getByRole('combobox', { name: 'Scene' })
  await expect(scenes).toHaveValue('fluid')
  await scenes.selectOption('kaleidoscope')
  await expect(canvas).toHaveAttribute('data-scene', 'kaleidoscope')
  await expect(canvas).toHaveAttribute('data-preset', 'prism')
  await expect(stage.getByRole('combobox', { name: 'Fluid grid' })).toHaveCount(0)
  await scenes.selectOption('fluid')
  await expect(canvas).toHaveAttribute('data-scene', 'fluid')

  // Shortcuts apply while the stage holds focus.
  await stage.focus()
  await page.keyboard.press('h')
  await expect(stage.locator('canvas.stage-hud')).toBeVisible()
  await page.keyboard.press('v')
  await expect(stage.locator('img.stage-art')).toBeVisible()
  await expect(canvas).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('musimo.now-playing-view'))).toBe('artwork')
  await page.keyboard.press('m')
  // The mute button is in the page's control row now, not over the picture.
  await expect(page.getByRole('button', { name: 'Unmute' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  await expect(page.locator('.stage img.stage-art')).toBeVisible()
  await page.locator('.stage').hover()
  const toggle = page.getByRole('button', { name: /^Visualizer/ })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(page.locator('.stage canvas.stage-visualizer')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('musimo.now-playing-view'))).toBe(
    'visualizer',
  )
})

test('the fluid grid size can be changed and survives a reload', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await showVisualizerFirst(page)
  const stage = await openNowPlaying(page)
  const adapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  )
  test.skip(!adapter, 'No WebGPU adapter in this browser.')

  await stage.hover()
  // Structure only: which scene and workload the canvas names, not what it draws.
  await expect(stage.locator('canvas.stage-visualizer')).toHaveAttribute('data-scene', 'fluid')
  await expect(stage.locator('canvas.stage-visualizer')).toHaveAttribute('data-detail', /512/)
  await stage.getByRole('combobox', { name: 'Fluid grid' }).selectOption('1024')
  await expect(stage.locator('canvas.stage-visualizer')).toHaveAttribute('data-detail', /1024/)
  expect(await page.evaluate(() => localStorage.getItem('musimo.visualizer-fluid-grid'))).toBe(
    '1024',
  )

  await page.reload()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  await page.locator('.stage').hover()
  await expect(page.getByRole('combobox', { name: 'Fluid grid' })).toHaveValue('1024')
})

test('the preset picker, [ and ], and the choice surviving a reload', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await showVisualizerFirst(page)
  const stage = await openNowPlaying(page)
  const adapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  )
  test.skip(!adapter, 'No WebGPU adapter in this browser.')

  const picker = stage.getByRole('combobox', { name: 'Preset' })
  const canvas = stage.locator('canvas.stage-visualizer')
  await stage.hover()
  // Structure only: which preset the canvas names, not what it draws.
  await expect(picker).toHaveValue('plume')
  await expect(canvas).toHaveAttribute('data-preset', 'plume')

  // ] walks forward and [ walks back, both wrapping at the ends.
  await stage.focus()
  await page.keyboard.press(']')
  await expect(picker).toHaveValue('wash')
  await expect(canvas).toHaveAttribute('data-preset', 'wash')
  await page.keyboard.press(']')
  await expect(picker).toHaveValue('plume')
  await page.keyboard.press('[')
  await expect(picker).toHaveValue('wash')

  // The picker itself sets it the same way.
  await picker.selectOption('plume')
  await expect(canvas).toHaveAttribute('data-preset', 'plume')
  await picker.selectOption('wash')
  await expect(canvas).toHaveAttribute('data-preset', 'wash')
  expect(await page.evaluate(() => localStorage.getItem('musimo.visualizer-preset'))).toBe('wash')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  await page.locator('.stage').hover()
  await expect(page.getByRole('combobox', { name: 'Preset' })).toHaveValue('wash')
})
