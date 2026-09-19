import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

const queue = [
  librarySong('song-1', { title: 'First Light', duration: 30 }),
  librarySong('song-2', { title: 'Second Wind', duration: 30, coverArt: 'cover-2' }),
]

// 800 peaks that climb from a whisper to full scale, so bars differ along the bar.
const peaks = Array.from({ length: 800 }, (_, index) =>
  Number((0.05 + (0.95 * index) / 799).toFixed(3)),
)

const answerWithPeaks = (route: Route) => route.fulfill({ json: { peaks } })

/** Opens Now Playing on a restored queue, with `waveform` answering the peaks request. */
async function openNowPlaying(page: Page, waveform: (route: Route) => Promise<void>) {
  // The view is pinned so the stage does not depend on the machine's WebGPU.
  await page.addInitScript(() => localStorage.setItem('musimo.now-playing-view', 'artwork'))
  await playerFixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: 'song-1', position: 0, entry: queue } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/lyrics/**', (route) => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/player/waveform/**', waveform)
  await page.goto('/now-playing')
  await expect(page.locator('.stage')).toBeVisible()
}

const seekBar = (page: Page) => page.locator('[data-seek-bar]')
const slider = (page: Page) => page.getByRole('slider', { name: 'Playback position' })
const barCount = async (page: Page) =>
  ((await seekBar(page).locator('path').first().getAttribute('d')) ?? '').split('M').length - 1

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, 'The phone width is checked at the end, from a desktop browser.')
})

test('the peaks are drawn behind the same slider, one bar to each four pixels', async ({
  page,
}) => {
  const asked: string[] = []
  await openNowPlaying(page, (route) => {
    asked.push(route.request().url().split('/').pop() ?? '')
    return answerWithPeaks(route)
  })

  await expect(seekBar(page)).toHaveAttribute('data-seek-bar', 'waveform')
  // Still the one accessible slider, named as before and counting the track's 30 seconds.
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveCount(1)
  await expect(slider(page)).toBeEnabled()
  await expect(slider(page)).toHaveAttribute('max', '30')
  // The rest and the played part are two layers of the same bars, and neither is announced.
  await expect(seekBar(page).locator('svg[aria-hidden="true"]')).toHaveCount(2)

  const box = await seekBar(page).boundingBox()
  if (!box) throw new Error('Missing seek bar box')
  // The bar is measured after it mounts, so the count settles a frame after the peaks arrive.
  await expect
    .poll(async () => Math.abs((await barCount(page)) - box.width / 4))
    .toBeLessThanOrEqual(1)

  // The next track asks for its own peaks.
  await page.getByRole('button', { name: 'Next track' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Second Wind' })).toBeVisible()
  await expect.poll(() => asked).toEqual(['song-1', 'song-2'])
})

test('the keyboard and the pointer seek as they did without the peaks', async ({
  page,
  browserName,
}) => {
  await openNowPlaying(page, answerWithPeaks)
  await expect(seekBar(page)).toHaveAttribute('data-seek-bar', 'waveform')
  await expect(slider(page)).toBeEnabled()

  await slider(page).focus()
  await slider(page).press('ArrowRight')
  await expect(slider(page)).toHaveValue('0.1')
  await expect
    .poll(() =>
      page
        .locator('audio.library-audio[data-role="active"]')
        .evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBeGreaterThan(0)
  // The input cannot draw its own focus ring while it is invisible, so the box draws it.
  await expect(seekBar(page)).toHaveCSS('outline-style', 'solid')
  await expect(seekBar(page)).toHaveCSS('outline-width', '2px')

  // Where a click lands is measured in Chromium, whose slider is the one the arrows above and the
  // thumb-less track were written against; the other engines are held to the keyboard.
  test.skip(browserName !== 'chromium', 'The click position is checked in Chromium.')
  const box = await seekBar(page).boundingBox()
  if (!box) throw new Error('Missing seek bar box')
  await seekBar(page).click({ position: { x: box.width * 0.25, y: box.height / 2 } })
  // A slider's thumb has a width, so a click a quarter of the way along lands near 7.5 s of 30,
  // not on it.
  await expect
    .poll(async () => Math.abs(Number(await slider(page).inputValue()) - 7.5))
    .toBeLessThan(1)
  // The played part follows the position, wherever exactly the click put it: the clip hides the
  // rest of the accent layer. Only one number in the clip is a percentage, whichever way the
  // engine writes the zeros.
  const played = (Number(await slider(page).inputValue()) / 30) * 100
  const clipped = await page.locator('[data-seek-played]').evaluate((element: HTMLElement) => {
    return element.style.clipPath
  })
  expect(Math.abs(Number(/([\d.]+)%/.exec(clipped)?.[1]) - (100 - played))).toBeLessThan(1)
})

test('the played part is the accent and the rest is muted, both read from the theme tokens', async ({
  page,
}) => {
  await openNowPlaying(page, answerWithPeaks)
  await expect(seekBar(page)).toHaveAttribute('data-seek-bar', 'waveform')

  const fills = () =>
    page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--color-accent)'
      document.body.append(probe)
      const accent = getComputedStyle(probe).color
      probe.remove()
      const [rest, played] = [...document.querySelectorAll('[data-seek-bar] path')].map(
        (path) => getComputedStyle(path).fill,
      )
      return { accent, rest, played }
    })
  const before = await fills()
  expect(before.played).toBe(before.accent)
  expect(before.rest).not.toBe(before.accent)

  // A theme is only token values on <html>, and the bars follow them with no drawing code.
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--color-accent', 'rgb(255, 0, 0)')
    document.documentElement.style.setProperty('--color-muted', 'rgb(0, 0, 255)')
  })
  const after = await fills()
  expect(after.played).toBe('rgb(255, 0, 0)')
  expect(after.rest).not.toBe(before.rest)
})

test('the plain bar shows while the peaks load, and it is the same slider once they arrive', async ({
  page,
}) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await openNowPlaying(page, async (route) => {
    await gate
    await answerWithPeaks(route)
  })

  await expect(seekBar(page)).toHaveAttribute('data-seek-bar', 'plain')
  await expect(seekBar(page).locator('svg')).toHaveCount(0)
  await expect(slider(page)).toBeEnabled()
  await slider(page).focus()

  release()
  await expect(seekBar(page)).toHaveAttribute('data-seek-bar', 'waveform')
  // Not a new element: focus was not lost when the peaks arrived.
  await expect(slider(page)).toBeFocused()
})

for (const [name, answer] of [
  ['has none', (route: Route) => route.fulfill({ status: 404, json: { detail: 'No waveform' } })],
  ['is busy', (route: Route) => route.fulfill({ status: 503, json: { detail: 'Try later' } })],
  ['sends too few peaks', (route: Route) => route.fulfill({ json: { peaks: [0.5] } })],
] as const) {
  test(`the plain bar stays when the server ${name}`, async ({ page }) => {
    await openNowPlaying(page, answer)

    await expect(slider(page)).toBeEnabled()
    await expect(seekBar(page)).toHaveAttribute('data-seek-bar', 'plain')
    await expect(seekBar(page).locator('svg')).toHaveCount(0)
    // Nothing on the page says anything went wrong, and the slider still seeks.
    await expect(page.getByText(/waveform/i)).toHaveCount(0)
    await slider(page).focus()
    await slider(page).press('ArrowRight')
    await expect(slider(page)).toHaveValue('0.1')
  })
}

test('the footer player keeps the plain bar', async ({ page }) => {
  await openNowPlaying(page, answerWithPeaks)
  await expect(seekBar(page)).toHaveAttribute('data-seek-bar', 'waveform')

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Library' })
    .click()
  const footer = page.getByRole('contentinfo')
  await expect(footer).toContainText('First Light')
  await expect(footer.getByRole('slider', { name: 'Playback position' })).toBeVisible()
  await expect(page.locator('[data-seek-bar]')).toHaveCount(0)
})

test('at phone width the bars fit the bar and the page does not scroll sideways', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The phone width is checked in Chromium.')
  await page.setViewportSize({ width: 375, height: 800 })
  await openNowPlaying(page, answerWithPeaks)
  await expect(seekBar(page)).toHaveAttribute('data-seek-bar', 'waveform')

  const box = await seekBar(page).boundingBox()
  if (!box) throw new Error('Missing seek bar box')
  expect(box.width).toBeGreaterThan(100)
  expect(box.x + box.width).toBeLessThanOrEqual(375)
  await expect
    .poll(async () => Math.abs((await barCount(page)) - box.width / 4))
    .toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
})
