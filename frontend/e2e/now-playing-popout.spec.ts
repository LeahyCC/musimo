import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import type { LibraryTrack } from '../src/api'
import { DEFAULT_THEME } from '../src/theme/themes'
import type { Theme } from '../src/theme/themes'
import { librarySong, playerFixtures } from './library-fixtures'
import { LIGHT_THEME, rgb, themeVars } from './theme-fixtures'

const song = librarySong('song-1', { title: 'First Light', duration: 30 })

test('now playing shows the stage bar and the idle fade, and the transport beside it', async ({
  page,
  browserName,
  isMobile,
}) => {
  test.skip(browserName !== 'chromium' || isMobile, 'Checked on desktop Chromium.')

  // This is about the stage bar and the idle fade, which are the same
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
  await page.getByRole('link', { name: 'Open Now Playing' }).first().click()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()

  const stage = page.locator('.stage')
  await expect(stage).toBeVisible()
  await expect(stage.locator('img.stage-art')).toBeVisible()

  // Hovering shows the top bar. The transport is not over the picture: the page carries it under
  // the stage, and only full screen and the popout draw it on the picture.
  await stage.hover()
  await expect(stage.getByRole('button', { name: 'Full screen' })).toBeVisible()
  await expect(stage.getByRole('button', { name: 'Pause' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()

  // The queue was started from this album, and says so beside how many tracks it holds.
  await expect(page.getByText('Playing from album Clear Water')).toBeVisible()
  await expect(page.getByText('1 TRACK', { exact: true })).toBeVisible()
  // The footer's own status lines stay in the footer, which is hidden here.
  await expect(page.locator('main').getByText('Your Navidrome library')).toHaveCount(0)

  // The popout is offered only where the browser has Document Picture-in-Picture.
  const hasPictureInPicture = await page.evaluate(() => 'documentPictureInPicture' in window)
  await expect(stage.getByRole('button', { name: 'Pop out player' })).toHaveCount(
    hasPictureInPicture ? 1 : 0,
  )

  // The bar rests while music plays and the pointer is still, and wakes on movement. Only the
  // top bar and the visualizer control are over the picture, so its middle is free to rest on.
  const stageBox = await stage.boundingBox()
  if (!stageBox) throw new Error('Stage has no layout box')
  await stage.hover({ position: { x: stageBox.width / 2, y: stageBox.height / 2 } })
  await expect(stage).toHaveClass(/idle/, { timeout: 10_000 })
  await stage.hover({ position: { x: 20, y: 20 } })
  await expect(stage).not.toHaveClass(/idle/)
})

const LONG_TITLE =
  'An Unreasonably Long Song Title That Keeps Going Past Any Sensible Length For A Heading On This Screen'

/** Opens Now Playing on a restored queue, without starting playback. */
async function openNowPlaying(page: Page, queue: LibraryTrack[], lyrics: string[] = []) {
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

  await page.route('**/api/player/lyrics/**', (route) =>
    route.fulfill({
      json: { items: lyrics.length ? [{ line: lyrics.map((value) => ({ value })) }] : [] },
    }),
  )
  await page.goto('/now-playing')
  await expect(page.locator('.stage')).toBeVisible()
}

test('a very long title stays on one line in Up next and stops after two under the stage', async ({
  page,
}) => {
  // The first song is the one playing and so is not in Up next; the next two are.
  await openNowPlaying(page, [
    librarySong('song-long', { title: LONG_TITLE }),
    librarySong('song-long-next', { title: LONG_TITLE }),
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
        lines: box.height / Number.parseFloat(style.lineHeight),
        right: box.right,
        width: innerWidth,
      }
    })
  // The title sits under the stage, smaller than a page heading, and cannot push the controls
  // around: two lines, then an ellipsis.
  expect(hero.size).toBeLessThanOrEqual(32)
  expect(Math.round(hero.lines)).toBeLessThanOrEqual(2)
  expect(hero.right).toBeLessThanOrEqual(hero.width)
})

/** The width the page's content has: `main` less its padding. */
const contentWidth = (page: Page) =>
  page.locator('main').evaluate((element) => {
    const style = getComputedStyle(element)
    return (
      element.getBoundingClientRect().width -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight)
    )
  })

const playerHeight = (page: Page) =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--player-height'))

const next = librarySong('song-2', { title: 'Second Wind' })

type Box = { y: number; height: number } | null

/**
 * Whether the panel sits beside the stage, and whether the stage, the Up next panel and the last
 * control of the row all end inside a window of this height. Read together and polled together:
 * the layout is settled when all four hold.
 */
async function fits(page: Page, height: number) {
  const [stage, panel, close] = await Promise.all([
    page.locator('.stage').boundingBox(),
    page.getByRole('tabpanel', { name: 'Up next' }).boundingBox(),
    page.getByRole('button', { name: 'Close player' }).boundingBox(),
  ])
  const bottom = (box: Box) => (box ? box.y + box.height : Infinity)
  return {
    sideBySide: Boolean(stage && panel && panel.x >= stage.x + stage.width),
    stage: bottom(stage) <= height,
    panel: bottom(panel) <= height,
    controls: bottom(close) <= height,
  }
}

test('on a desktop the stage and its controls sit beside one tabbed panel, all in the window', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The phone layout is checked below.')
  await page.setViewportSize({ width: 1440, height: 900 })
  await openNowPlaying(page, [song, next])

  await expect
    .poll(() => fits(page, 900))
    .toEqual({ sideBySide: true, stage: true, panel: true, controls: true })
  // Nothing below the fold: Up next and Lyrics are both reachable without scrolling the page.
  await expect(page.getByRole('tab', { name: 'Lyrics' })).toBeInViewport()
  const box = await page.locator('.stage').boundingBox()
  if (!box) throw new Error('Missing stage box')
  expect(box.width).toBeCloseTo(box.height, 0)

  // The title is drawn once, and the stage carries no transport of its own while docked.
  await expect(page.locator('main').getByText('First Light', { exact: true })).toHaveCount(1)
  await expect(page.locator('.stage-controls')).toHaveCount(0)

  // Up next is what follows the playing track, so the playing one is not its first row.
  const upNext = page.getByRole('tabpanel', { name: 'Up next' })
  await expect(upNext.getByRole('button', { name: 'Play Second Wind' })).toBeVisible()
  await expect(upNext.getByRole('button', { name: /First Light/ })).toHaveCount(0)
  await expect(page.getByText('2 TRACKS', { exact: true })).toBeVisible()
  // A queue restored after a refresh has no source the player knows, so there is no Playing from.
  await expect(page.getByText(/^Playing from/)).toHaveCount(0)
  // The footer's status line says the queue was restored; the page does not repeat that.
  await expect(page.locator('main').getByText('Queue restored')).toHaveCount(0)

  // The page holds every control the footer has, the close button included, so the footer is
  // gone and takes no room.
  for (const name of ['Add First Light to liked', 'Add to playlist', 'Previous track', 'Play']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  }
  await expect(page.getByRole('button', { name: 'Next track' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Shuffle' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Repeat off' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mute', exact: true })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Volume' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Playback position' })).toBeVisible()
  await expect(page.getByRole('contentinfo')).toBeHidden()
  await expect.poll(() => playerHeight(page)).toBe('0px')

  // The picker still opens from the page's own button, with the footer hidden.
  await page.getByRole('button', { name: 'Add to playlist' }).click()
  await expect(page.getByRole('dialog', { name: 'Add track to playlist' })).toBeVisible()
  await page.getByRole('button', { name: 'Close playlist picker' }).click()

  // Leaving brings the footer back and its height with it.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Library' })
    .click()
  await expect(page.getByRole('contentinfo')).toContainText('First Light')
  await expect.poll(() => playerHeight(page)).not.toBe('0px')
})

test('the close button on the page empties the player', async ({ page }) => {
  await openNowPlaying(page, [song])
  await page.getByRole('button', { name: 'Close player' }).click()
  await expect(page.getByRole('heading', { name: 'Nothing playing yet.' })).toBeVisible()
})

test('a short window shrinks the stage to keep its controls in view', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The phone layout is checked below.')
  await page.setViewportSize({ width: 1440, height: 600 })
  await openNowPlaying(page, [song, next])

  await expect
    .poll(() => fits(page, 600))
    .toEqual({ sideBySide: true, stage: true, panel: true, controls: true })
  const box = await page.locator('.stage').boundingBox()
  if (!box) throw new Error('Missing stage box')
  expect(box.width).toBeCloseTo(box.height, 0)
})

test('the tabs are real tabs, move with the arrow keys and remember the choice', async ({
  page,
}) => {
  await openNowPlaying(page, [song, next], ['Morning finds the water'])

  const upNext = page.getByRole('tab', { name: 'Up next' })
  const lyrics = page.getByRole('tab', { name: 'Lyrics' })
  await expect(page.getByRole('tablist', { name: 'Now Playing panel' })).toBeVisible()
  await expect(upNext).toHaveAttribute('aria-selected', 'true')
  await expect(lyrics).toHaveAttribute('aria-selected', 'false')
  await expect(page.getByRole('tabpanel', { name: 'Lyrics' })).toBeHidden()

  // Arrow keys move between the tabs and select as they go; focus follows.
  await upNext.focus()
  await page.keyboard.press('ArrowRight')
  await expect(lyrics).toHaveAttribute('aria-selected', 'true')
  await expect(lyrics).toBeFocused()
  await expect(page.getByText('Morning finds the water')).toBeVisible()
  await expect(page.getByRole('tabpanel', { name: 'Up next' })).toBeHidden()
  await page.keyboard.press('ArrowRight')
  await expect(upNext).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(lyrics).toBeFocused()
  expect(await page.evaluate(() => localStorage.getItem('musimo.now-playing-tab'))).toBe('lyrics')

  // Only the chosen tab is in the tab order, and the choice survives a reload.
  await expect(upNext).toHaveAttribute('tabindex', '-1')
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Lyrics' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Morning finds the water')).toBeVisible()

  // A click chooses too.
  await page.getByRole('tab', { name: 'Up next' }).click()
  await expect(page.getByRole('tabpanel', { name: 'Up next' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('musimo.now-playing-tab'))).toBe('up-next')
})

test('on a phone the stage takes the full width, the tabs follow the controls and the mini player steps aside', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'The desktop layout is checked above.')
  await openNowPlaying(page, [song, next], ['Morning finds the water'])

  const box = await page.locator('.stage').boundingBox()
  if (!box) throw new Error('Missing stage box')
  expect(box.width).toBeCloseTo(await contentWidth(page), 0)
  // The page has the title, the transport and the seek bar, so the mini player would repeat them.
  await expect(page.getByRole('contentinfo')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Next track' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close player' })).toBeVisible()
  // Lyrics is a tap away, directly under the controls, not after the queue.
  const tab = await page.getByRole('tab', { name: 'Lyrics' }).boundingBox()
  const viewport = page.viewportSize()
  if (!tab || !viewport) throw new Error('Missing tab box or viewport')
  expect(tab.y).toBeLessThan(viewport.height * 2)
  await page.getByRole('tab', { name: 'Lyrics' }).click()
  await expect(page.getByText('Morning finds the water')).toBeVisible()
  // With no footer, the page pads for the bottom bar alone, not for a player that is not there.
  const nav = await page.locator('.sidebar').boundingBox()
  if (!nav) throw new Error('Missing bottom bar box')
  await expect
    .poll(() =>
      page
        .locator('main')
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)),
    )
    .toBeLessThan(nav.height + 60)
})

/** A second custom theme, so a change made while the popout is open has somewhere to go. */
const PLUM: Theme = {
  ...LIGHT_THEME,
  id: 'custom-plum',
  name: 'Plum',
  colors: { ...LIGHT_THEME.colors, '--color-media': '#2a0f30', '--color-canvas': '#3a0f3f' },
}

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
    // The tab is never left without transport: the title and the control row stay on the page.
    await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
    await expect(page.getByRole('slider', { name: 'Playback position' })).toBeVisible()

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
        // The popout has nothing else to hold the transport, so it draws it over the picture.
        controls: popped.querySelector('.stage-controls') !== null,
        canvas: win.document.documentElement.style.getPropertyValue('--color-canvas'),
      }
    })
    expect(popout).toEqual({
      body: 'popout-body',
      media: rgb((theme ?? DEFAULT_THEME).colors['--color-media']),
      fills: true,
      radius: '0px',
      overlay: 'absolute',
      controls: true,
      // The default theme is the absence of an inline value; any other is written onto the popout.
      canvas: theme ? theme.colors['--color-canvas'] : '',
    })

    // A theme picked while the popout is open reaches it too: the popout is a second target the
    // store writes on every change, not a copy taken once at opening.
    await page.evaluate(
      ([id, custom]: readonly [string, string]) => {
        localStorage.setItem('musimo.custom-themes', custom)
        window.dispatchEvent(new StorageEvent('storage', { key: 'musimo.custom-themes' }))
        localStorage.setItem('musimo.theme', id)
        window.dispatchEvent(new StorageEvent('storage', { key: 'musimo.theme' }))
      },
      [PLUM.id, JSON.stringify({ version: 1, themes: [theme ?? LIGHT_THEME, PLUM] })] as const,
    )

    await expect
      .poll(() =>
        page.evaluate(() => {
          const win = (window as PictureInPictureWindow).documentPictureInPicture?.window
          return win?.document.documentElement.style.getPropertyValue('--color-media') ?? null
        }),
      )
      .toBe(PLUM.colors['--color-media'])

    await page.getByRole('button', { name: 'Bring back' }).click()
    await expect(page.getByText('Playing in the popout window.')).toHaveCount(0)
  })
}
