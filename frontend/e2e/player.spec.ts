import { expect, test } from '@playwright/test'

import { closeLibraryFilters, openLibraryFilters, ORIGIN } from './library-fixtures'

const song = {
  id: 'song-1',
  title: 'First Light',
  artist: 'Harbor Static',
  artistId: 'artist-1',
  album: 'Clear Water',
  albumId: 'album-1',
  coverArt: 'cover-1',
  duration: 184,
  track: 1,
}

test('library playback opens the full player', async ({ page, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 360, height: 844 })

  await page.route('**/api/player/capabilities', (route) =>
    route.fulfill({
      json: {
        configured: true,
        available: true,
        version: '0.63.2',
        detail: 'Navidrome is ready',
      },
    }),
  )

  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: '', position: 0, entry: [] } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/scrobble', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/player/stream/**', async (route) => {
    const silence = await route.fetch({ url: `${ORIGIN}/assets/e2e-silence.wav` })
    await route.fulfill({ response: silence })
  })

  await page.route('**/api/player/art/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#283d31"/></svg>',
    }),
  )

  await page.route('**/api/library/albums?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'album-1',
            name: 'Clear Water',
            artist: 'Harbor Static',
            coverArt: 'cover-1',
            songCount: 1,
            genre: 'Ambient',
            year: 2026,
          },
          {
            id: 'album-2',
            name: 'Stone Lines',
            artist: 'Harbor Static',
            coverArt: 'cover-2',
            songCount: 1,
            genre: 'Rock',
            year: 2025,
          },
        ],
        next_offset: null,
        total: 2,
        // The server sends the whole library's filter choices with the first page.
        genres: ['Ambient', 'Rock'],
        years: [2026, 2025],
      },
    }),
  )

  await page.route('**/api/library/artists?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'artist-1',
            name: 'Harbor Static',
            coverArt: 'artist-cover-1',
            albumCount: 1,
          },
        ],
        next_offset: null,
        total: 1,
      },
    }),
  )

  await page.route('**/api/library/artists/artist-1', (route) =>
    route.fulfill({
      json: {
        id: 'artist-1',
        name: 'Harbor Static',
        coverArt: 'artist-cover-1',
        albumCount: 1,
        album: [
          {
            id: 'album-1',
            name: 'Clear Water',
            artist: 'Harbor Static',
            artistId: 'artist-1',
            coverArt: 'cover-1',
            songCount: 1,
          },
        ],
      },
    }),
  )

  await page.route('**/api/library/artists/artist-1/tracks', (route) =>
    route.fulfill({ json: { items: [song] } }),
  )

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

  await page.route('**/api/player/lyrics/song-1', (route) =>
    route.fulfill({
      json: { items: [{ line: [{ start: 0, value: 'Morning finds the water' }] }] },
    }),
  )

  await page.goto('/library')
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible()
  await expect(page.getByText('NAVIDROME READY')).toBeVisible()
  await page.getByLabel('Search albums').fill('clear water')
  await expect(page.getByRole('button', { name: 'Open Clear Water' })).toBeVisible()
  await openLibraryFilters(page, isMobile)
  await page.getByLabel('Sort home').selectOption('title')
  await page.getByText('All genres', { exact: true }).click()
  await page.getByLabel('Ambient').check()
  await expect(page.getByLabel('Rock')).toBeVisible()
  await page.getByLabel('Rock').check()
  await page.getByText('All years', { exact: true }).click()
  await page.getByLabel('2026').check()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await page.getByRole('button', { name: 'List view' }).click()
  await closeLibraryFilters(page, isMobile)
  await expect(page.getByRole('button', { name: 'Play Clear Water' })).toBeVisible()
  await page.reload()
  await openLibraryFilters(page, isMobile)
  await expect(page.getByRole('button', { name: 'List view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Grid view' }).click()
  await closeLibraryFilters(page, isMobile)
  const grid = page.locator('.library-grid')
  const gridTop = await grid.evaluate((element) => element.getBoundingClientRect().top + scrollY)
  const idleOpacity = await page.evaluate(() => (matchMedia('(hover: none)').matches ? 1 : 0))
  let releasePlayback: () => void = () => undefined
  const pendingPlayback = new Promise<void>((resolve) => {
    releasePlayback = resolve
  })
  await page.route(
    '**/api/library/albums/album-1',
    async (route) => {
      await pendingPlayback
      await route.fallback()
    },
    { times: 1 },
  )
  try {
    await page.getByRole('button', { name: 'Play Clear Water' }).click()
    await expect(page.getByRole('button', { name: 'Play Clear Water' })).toBeDisabled()
    // Sample the whole loading transition so a brief flash cannot pass between assertions.
    const movement = await grid.evaluate(
      async (element, baseline) => {
        const idleButton = element.querySelector('[aria-label="Play Stone Lines"]')
        if (!idleButton) throw new Error('Missing second album play button')
        let positionChange = 0
        let opacityChange = 0
        const start = performance.now()
        await new Promise<void>((resolve) => {
          const sample = () => {
            positionChange = Math.max(
              positionChange,
              Math.abs(element.getBoundingClientRect().top + scrollY - baseline.top),
            )

            opacityChange = Math.max(
              opacityChange,
              Math.abs(Number(getComputedStyle(idleButton).opacity) - baseline.opacity),
            )

            if (performance.now() - start >= 350) resolve()
            else requestAnimationFrame(sample)
          }
          sample()
        })

        return { positionChange, opacityChange }
      },
      { top: gridTop, opacity: idleOpacity },
    )
    expect(movement.positionChange).toBeLessThan(1)
    expect(movement.opacityChange).toBe(0)
  } finally {
    releasePlayback()
  }
  // Its own album owns the queue now, so this control offers pause.
  const albumPlay = grid
    .locator('.library-card')
    .filter({ hasText: 'Clear Water' })
    .locator('.library-card-play')
  await expect(albumPlay).toBeEnabled()
  await expect(albumPlay).toHaveAccessibleName('Pause Clear Water')
  await expect(page.locator('.live-player')).toContainText('First Light')
  expect(
    await grid.evaluate((element) => element.getBoundingClientRect().top + scrollY),
  ).toBeCloseTo(gridTop)
  await expect(page).toHaveURL(/\/library$/)
  await page.getByRole('button', { name: 'Open Clear Water' }).click()
  await expect(page).toHaveURL(/\/library\/albums\/album-1$/)
  // This album already owns the queue, so its control is marked active and toggles that queue
  // rather than fetching the album again and starting it over. The active state depends only
  // on which collection is queued, so it holds on engines that stop headless audio early.
  const playAll = page
    .locator('.library-detail')
    .getByRole('button', { name: /^(Play all|Pause)$/ })
  await expect(playAll).toHaveAttribute('data-active', 'true')
  await playAll.click()
  await expect(page.locator('.live-player')).toContainText('First Light')

  await page.getByRole('button', { name: 'Artists', exact: true }).click()
  await expect(page).toHaveURL(/\/library\/artists$/)
  await expect(page.locator('.library-artist-card img')).toBeVisible()
  await expect(page.locator('.library-artist-card small')).toHaveText('1 album')
  await page.locator('.live-player').getByRole('link', { name: 'Harbor Static' }).click()
  await expect(page).toHaveURL(/\/library\/artists\/artist-1$/)
  await expect(page.locator('.library-artist-heading img')).toBeVisible()
  await page.getByRole('button', { name: 'Open Clear Water' }).click()
  await expect(page).toHaveURL(/\/library\/artists\/artist-1\/albums\/album-1$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/library\/artists\/artist-1$/)
  await page.getByRole('button', { name: 'Open Clear Water' }).click()
  await page.getByRole('button', { name: 'Back to Harbor Static' }).click()
  await expect(page).toHaveURL(/\/library\/artists\/artist-1$/)
  await page.locator('.library-artist-heading').getByRole('button', { name: 'Shuffle' }).click()
  await expect(page.locator('.live-player')).toContainText('First Light')
  await page.locator('.live-player').getByRole('link', { name: 'Clear Water' }).click()
  await expect(page).toHaveURL(/\/library\/albums\/album-1$/)

  // The cover opens Now Playing on every width and is the only stop: the maximise icon beside it
  // on desktop is out of the tab order and the accessibility tree.
  const opener = page.locator('.live-player').getByRole('link', { name: 'Open Now Playing' })
  await expect(opener).toHaveCount(1)
  await opener.click()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  // Lyrics share a panel with Up next, one tap away.
  await page.getByRole('tab', { name: 'Lyrics' }).click()
  await expect(page.getByText('Morning finds the water')).toBeVisible()

  // On desktop the sidebar's last row is Now Playing with the cover as its icon and it is marked
  // active here. A phone's bottom bar stays at five items, so the row is not there.
  const navRow = page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Now Playing' })
  if (isMobile) {
    await expect(navRow).toBeHidden()
  } else {
    await expect(navRow).toHaveAttribute('aria-current', 'page')
    await expect(navRow.locator('img')).toBeVisible()
  }
})
