import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

const song = librarySong('song-1', { title: 'First Light', duration: 30 })
const NOTICE = 'This browser has no WebGL 2'
const DEFAULT_PRESET = 'Flexi, martin + geiss - dedicated to the sherwin maxawow'
// `data-preset` is written once a preset has loaded, and headless Chromium compiles a preset's
// shaders on its software renderer, which can take several seconds.
const LOADED = { timeout: 20_000 }

// Artwork is the default, so a test that needs the canvas asks for it. Only on a browser that has
// stored nothing, so a choice made in the test survives its own reload.
const showVisualizerFirst = (page: Page) =>
  page.addInitScript(() => {
    if (localStorage.getItem('musimo.now-playing-view') === null)
      localStorage.setItem('musimo.now-playing-view', 'visualizer')
  })

// Whether this browser can make a WebGL 2 context. Headless Chromium can, through its software
// renderer; an engine that cannot runs the artwork test only.
const hasWebGl2 = (page: Page) =>
  page.evaluate(() => Boolean(document.createElement('canvas').getContext('webgl2')))

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

test('without WebGL 2 the stage shows artwork and says so once', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await page.addInitScript(() => {
    Object.defineProperty(window, 'WebGL2RenderingContext', {
      value: undefined,
      configurable: true,
    })
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

test('artwork is the default even with WebGL 2, and the Visualizer button turns it on', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  const stage = await openNowPlaying(page)
  test.skip(!(await hasWebGl2(page)), 'No WebGL 2 in this browser.')

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
  test.skip(!(await hasWebGl2(page)), 'No WebGL 2 in this browser.')

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
  test.skip(!(await hasWebGl2(page)), 'No WebGL 2 in this browser.')

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

test('with WebGL 2 V and the button switch the view, and the choice sticks', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await showVisualizerFirst(page)
  const stage = await openNowPlaying(page)
  test.skip(!(await hasWebGl2(page)), 'No WebGL 2 in this browser.')

  const canvas = stage.locator('canvas.stage-visualizer')
  await expect(canvas).toBeVisible()
  // Structure only: that frames are being drawn, not what they look like.
  await expect(canvas).toHaveAttribute('data-frame-ms', /^\d/)
  await stage.hover()
  await expect(stage.getByRole('button', { name: /^Visualizer/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(stage.getByRole('combobox', { name: 'Preset' })).toBeVisible()

  // Shortcuts apply while the stage holds focus.
  await stage.focus()
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

test('the preset picker, [ and ], and the choice surviving a reload', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await showVisualizerFirst(page)
  const stage = await openNowPlaying(page)
  test.skip(!(await hasWebGl2(page)), 'No WebGL 2 in this browser.')

  const picker = stage.getByRole('combobox', { name: 'Preset' })
  const canvas = stage.locator('canvas.stage-visualizer')
  await stage.hover()
  // The pack's own order, read off the picker, so the test does not repeat the list.
  const names = await picker
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
  const next = names[names.indexOf(DEFAULT_PRESET) + 1] ?? ''
  const first = names[0] ?? ''
  const last = names[names.length - 1] ?? ''
  // Structure only: which preset the canvas names, not what it draws.
  await expect(picker).toHaveValue(DEFAULT_PRESET)
  await expect(canvas).toHaveAttribute('data-preset', DEFAULT_PRESET, LOADED)

  // ] walks forward and [ walks back.
  await stage.focus()
  await page.keyboard.press(']')
  await expect(picker).toHaveValue(next)
  await expect(canvas).toHaveAttribute('data-preset', next, LOADED)
  await page.keyboard.press('[')
  await expect(picker).toHaveValue(DEFAULT_PRESET)

  // The picker itself sets it the same way, and [ wraps from the first to the last.
  await picker.selectOption(first)
  await expect(canvas).toHaveAttribute('data-preset', first, LOADED)
  await stage.focus()
  await page.keyboard.press('[')
  await expect(picker).toHaveValue(last)
  expect(await page.evaluate(() => localStorage.getItem('musimo.visualizer-preset'))).toBe(last)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  await page.locator('.stage').hover()
  await expect(page.getByRole('combobox', { name: 'Preset' })).toHaveValue(last)
})

test('a preset left by the old visualizer starts on the default', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await page.addInitScript(() => localStorage.setItem('musimo.visualizer-preset', 'plume'))
  await showVisualizerFirst(page)
  const stage = await openNowPlaying(page)
  test.skip(!(await hasWebGl2(page)), 'No WebGL 2 in this browser.')

  await stage.hover()
  await expect(stage.getByRole('combobox', { name: 'Preset' })).toHaveValue(DEFAULT_PRESET)
})
