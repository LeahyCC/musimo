import { expect, test } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

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
