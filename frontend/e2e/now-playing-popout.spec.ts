import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import type { LibraryTrack } from '../src/api'
import { DEFAULT_THEME } from '../src/theme/themes'
import { librarySong, playerFixtures } from './library-fixtures'
import { LIGHT_THEME, rgb, themeVars } from './theme-fixtures'

const song = librarySong('song-1', { title: 'First Light', duration: 30 })

test('now playing shows hover controls and the idle fade', async ({
  page,
  browserName,
  isMobile,
}) => {
  test.skip(browserName !== 'chromium' || isMobile, 'Checked on desktop Chromium.')

  // This is about the hover controls and the idle fade, which are the same
  // whichever view the stage shows. Pin the view rather than letting the
  // machine decide it: the stage defaults to the visualizer wherever WebGPU
  // has an adapter, so a headless run lands on artwork and a headed one does
  // not, and the artwork assertion below would only hold on the first.
  await page.addInitScript(() => localStorage.setItem('musimo.now-playing-view', 'artwork'))

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
  await expect(page.locator('.live-player')).toContainText('First Light')
  await page.getByRole('link', { name: 'Open Now Playing' }).click()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()

  const stage = page.locator('.stage')
  await expect(stage).toBeVisible()
  await expect(stage.locator('img.stage-art')).toBeVisible()

  // Hovering shows the controls.
  await stage.hover()
  await expect(stage.getByRole('button', { name: 'Full screen' })).toBeVisible()
  await expect(stage.getByRole('button', { name: 'Pause' })).toBeVisible()

  // The popout is offered only where the browser has Document Picture-in-Picture.
  const hasPictureInPicture = await page.evaluate(() => 'documentPictureInPicture' in window)
  await expect(stage.getByRole('button', { name: 'Pop out player' })).toHaveCount(
    hasPictureInPicture ? 1 : 0,
  )

  // The controls rest while music plays and the pointer is still, and wake on
  // movement. The wrapped controls fill most of this small box, so rest the
  // pointer over the gap between the top bar and the controls rather than
  // assuming the box's visual centre is uncovered.
  const stageBox = await stage.boundingBox()
  if (!stageBox) throw new Error('Stage has no layout box')
  const topBottom = await stage
    .locator('.stage-top')
    .evaluate((element) => element.getBoundingClientRect().bottom)
  const controlsTop = await stage
    .locator('.stage-controls')
    .evaluate((element) => element.getBoundingClientRect().top)
  const restY = (topBottom + controlsTop) / 2 - stageBox.y
  await stage.hover({ position: { x: stageBox.width / 2, y: restY } })
  await expect(stage).toHaveClass(/idle/, { timeout: 10_000 })
  await stage.hover({ position: { x: 20, y: 20 } })
  await expect(stage).not.toHaveClass(/idle/)
})

const LONG_TITLE =
  'An Unreasonably Long Song Title That Keeps Going Past Any Sensible Length For A Heading On This Screen'

/** Opens Now Playing on a restored queue, without starting playback. */
async function openNowPlaying(page: Page, queue: LibraryTrack[]) {
  // Pinned for the same reason as above: the stage must not depend on the machine's WebGPU.
  await page.addInitScript(() => localStorage.setItem('musimo.now-playing-view', 'artwork'))
  await playerFixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: queue[0]?.id ?? '', position: 0, entry: queue } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/lyrics/**', (route) => route.fulfill({ json: { items: [] } }))
  await page.goto('/now-playing')
  await expect(page.locator('.stage')).toBeVisible()
}

test('a very long title stays on one line in Up next and stops after three in the hero', async ({
  page,
}) => {
  await openNowPlaying(page, [
    librarySong('song-long', { title: LONG_TITLE }),
    librarySong('song-short', { title: 'Beacon' }),
  ])

  const title = (name: string) =>
    page
      .getByRole('button', { name: `Play ${name}` })
      .locator('strong')
      .evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        cut: element.scrollWidth > element.clientWidth,
      }))
  const long = await title(LONG_TITLE)
  const short = await title('Beacon')
  expect(long.cut).toBe(true)
  expect(long.height).toBe(short.height)

  const hero = await page
    .getByRole('heading', { level: 1, name: LONG_TITLE })
    .evaluate((element) => {
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      return {
        size: Number.parseFloat(style.fontSize),
        // The hero's own clamp(36px, 6vw, 72px), worked out for this window.
        clamp: Math.min(72, Math.max(36, innerWidth * 0.06)),
        lines: box.height / Number.parseFloat(style.lineHeight),
        right: box.right,
        width: innerWidth,
      }
    })
  expect(hero.size).toBeCloseTo(hero.clamp, 1)
  expect(Math.round(hero.lines)).toBeLessThanOrEqual(3)
  expect(hero.right).toBeLessThanOrEqual(hero.width)
})

type PictureInPictureWindow = Window & { documentPictureInPicture?: { window: Window | null } }

for (const theme of [undefined, LIGHT_THEME]) {
  const name = theme ? 'the light fixture theme' : 'the default theme'
  test(`the popout copies the styles and follows ${name}`, async ({
    page,
    browserName,
    isMobile,
  }) => {
    test.skip(
      browserName !== 'chromium' || isMobile,
      'Document Picture-in-Picture is Chromium only.',
    )
    if (theme) {
      await page.addInitScript(
        ([active, custom, vars]: readonly [string, string, string]) => {
          localStorage.setItem('musimo.theme', active)
          localStorage.setItem('musimo.custom-themes', custom)
          localStorage.setItem('musimo.theme-vars', vars)
        },
        [
          theme.id,
          JSON.stringify({ version: 1, themes: [theme] }),
          JSON.stringify(themeVars(theme)),
        ] as const,
      )
    }
    await openNowPlaying(page, [song])
    const stage = page.locator('.stage')
    await stage.hover()
    await stage.getByRole('button', { name: 'Pop out player' }).click()
    await expect(page.getByText('Playing in the popout window.')).toBeVisible()

    const popout = await page.evaluate(() => {
      const win = (window as PictureInPictureWindow).documentPictureInPicture?.window
      const popped = win?.document.querySelector('.stage')
      if (!win || !popped) return null
      const style = win.getComputedStyle(popped)
      return {
        body: win.document.body.className,
        media: style.backgroundColor,
        fills: popped.getBoundingClientRect().width === win.innerWidth,
        radius: style.borderRadius,
        // A utility from the generated sheet, so the popout has more than the handwritten rules.
        overlay: win.getComputedStyle(popped.querySelector('.stage-overlay') ?? popped).position,
        canvas: win.document.documentElement.style.getPropertyValue('--color-canvas'),
      }
    })
    expect(popout).toEqual({
      body: 'popout-body',
      media: rgb((theme ?? DEFAULT_THEME).colors['--color-media']),
      fills: true,
      radius: '0px',
      overlay: 'absolute',
      // The default theme is the absence of an inline value; any other is written onto the popout.
      canvas: theme ? theme.colors['--color-canvas'] : '',
    })

    await page.getByRole('button', { name: 'Bring back' }).click()
    await expect(page.getByText('Playing in the popout window.')).toHaveCount(0)
  })
}
