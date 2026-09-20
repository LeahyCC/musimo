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

// The visualizer control and the palette's commands only ask whether the browser has the API, so a
// bare object stands in for it.
const withWebGpu = (page: Page) =>
  page.addInitScript(() =>
    Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true }),
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

test('the stage keeps its Visualizer button while the docked stage is idle', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The stage controls are checked on desktop.')
  await withWebGpu(page)
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
  // The bars fade out with the stage; the Visualizer control has only dimmed.
  await expect(control.getByRole('button', { name: /^Visualizer/ })).toBeVisible()
  await expect(control).toHaveCSS('opacity', '0.7')
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
  await withWebGpu(page)
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
