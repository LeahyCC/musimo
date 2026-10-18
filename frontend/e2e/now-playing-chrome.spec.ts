import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

const song = librarySong('song-1', { title: 'First Light', duration: 30 })

/** Puts a track in the saved queue, so a load or reload has a library track loaded and paused. */
async function loadTrack(page: Page) {
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: 'song-1', position: 0, entry: [song] } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/lyrics/song-1', (route) => route.fulfill({ json: { items: [] } }))
}

// The visualizer control and the palette's commands only ask whether the browser has WebGL 2, so it
// is made to say yes everywhere.
const withWebGl2 = (page: Page) =>
  page.addInitScript(() =>
    Object.defineProperty(window, 'WebGL2RenderingContext', {
      value: window.WebGL2RenderingContext ?? function () {},
      configurable: true,
    }),
  )

test('the footer cover rings only while a library track plays', async ({ page }) => {
  await playerFixtures(page)
  // Nothing is loaded yet, so there is no cover to ring.
  await page.goto('/settings/user')
  await expect(page.locator('.live-player .cover-link')).toHaveCount(0)

  await loadTrack(page)
  await page.reload()
  const player = page.locator('.live-player')
  const cover = player.locator('.cover-link')
  await expect(player).toContainText('First Light')
  await expect(cover).toHaveAttribute('data-playing', 'false')

  await player.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(cover).toHaveAttribute('data-playing', 'true')
  await player.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(cover).toHaveAttribute('data-playing', 'false')
})

test('the Visualizer control fades with the bars when the docked stage goes idle', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await withWebGl2(page)
  await playerFixtures(page)
  await loadTrack(page)
  await page.goto('/now-playing')
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()

  const stage = page.locator('.stage')
  const control = stage.locator('.stage-view-control')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await stage.hover()
  // Leaving the stage while music plays is what turns the overlay idle at once.
  await page.mouse.move(0, 0)
  await expect(stage).toHaveClass(/idle/)
  await expect(control).toHaveCSS('opacity', '0')
  // Coming back over the stage shows it again.
  await stage.hover()
  await expect(control).toHaveCSS('opacity', '1')
})

test('the sidebar has no Now Playing row until a library track is loaded', async ({
  page,
  isMobile,
}) => {
  await playerFixtures(page)
  const row = page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Now Playing' })
  await page.goto('/settings/user')
  await expect(page.getByRole('link', { name: 'Diagnostics' }).first()).toBeVisible()
  await expect(row).toHaveCount(0)

  await loadTrack(page)
  await page.reload()
  // A phone's bar keeps its five items, so the row is drawn there but hidden.
  if (isMobile) await expect(row).toBeHidden()
  else await expect(row).toBeVisible()
})

test('the palette offers the visualizer commands only while a library track is loaded', async ({
  page,
}) => {
  await withWebGl2(page)
  await playerFixtures(page)
  const commands = ['Toggle visualizer', 'Next visualizer preset', 'Previous visualizer preset']
  const palette = page.getByRole('dialog', { name: 'Command palette' })

  await page.goto('/now-playing')
  await expect(page.getByRole('heading', { name: 'Nothing playing yet.' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(palette.getByRole('button', { name: 'Now Playing', exact: true })).toBeVisible()
  for (const name of [...commands, 'Fullscreen visualizer'])
    await expect(palette.getByRole('button', { name })).toHaveCount(0)

  await loadTrack(page)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  await page.keyboard.press('Control+k')
  for (const name of [...commands, 'Fullscreen visualizer'])
    await expect(palette.getByRole('button', { name })).toBeVisible()
})

test('the Listening room puts Art or MilkDrop, Auto or Hold and the window buttons in one pill', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await withWebGl2(page)
  await page.addInitScript(() => {
    localStorage.setItem('musimo.layout', 'room')
    if (localStorage.getItem('musimo.now-playing-view') === null)
      localStorage.setItem('musimo.now-playing-view', 'artwork')
  })
  await playerFixtures(page)
  await loadTrack(page)
  await page.goto('/now-playing')
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  // The page holds every control the footer has, so the footer stands down in this layout too.
  await expect(page.getByRole('contentinfo')).toBeHidden()

  const stage = page.locator('.stage')
  const pill = stage.locator('.stage-view-control')
  await stage.hover()
  const view = pill.getByRole('radiogroup', { name: 'Show on the stage' })
  await expect(view.getByRole('radio', { name: 'Art' })).toBeChecked()
  // Over the artwork the pill names the album, and has no preset controls.
  await expect(pill).toContainText('Clear Water')
  await expect(pill.getByRole('button', { name: 'Change with the music' })).toHaveCount(0)
  // Pop out is there too where the browser has Document Picture-in-Picture.
  await expect(pill.getByRole('button', { name: 'Large stage' })).toBeVisible()
  await expect(pill.getByRole('button', { name: 'Full screen' })).toBeVisible()

  // The radios are drawn by their labels, so the label is what a pointer presses.
  await view.getByText('MilkDrop').click()
  await expect(view.getByRole('radio', { name: 'MilkDrop' })).toBeChecked()
  expect(await page.evaluate(() => localStorage.getItem('musimo.now-playing-view'))).toBe(
    'visualizer',
  )
  await expect(pill.getByRole('button', { name: 'Change with the music' })).toBeVisible()
  await expect(pill.getByRole('button', { name: 'Next preset' })).toBeVisible()

  // Lyrics leads the room's tabs, beside the art.
  const tabs = page.getByRole('tablist', { name: 'Now Playing panel' }).getByRole('tab')
  await expect(tabs).toHaveText(['Lyrics', 'Up next', 'About', 'History'])
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
})
