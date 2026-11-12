import type { APIRequestContext } from '@playwright/test'

import { libraryAlbumsSchema, playerQueueSchema } from '../src/api'
import { expect, test } from './test'

/** Empties the saved queue. A refused clear would leave a song for every later page to restore. */
async function clearSavedQueue(request: APIRequestContext) {
  const response = await request.put('/api/player/queue', {
    data: { ids: [], current: '', position: 0 },
  })
  expect(response.status()).toBe(204)
}

// This test saves a real queue on the server, and every later page restores it: a song in the
// player bar, a save the next test may block, a stream it never asked for. The page leaves the app
// first (it sends nothing on the way out), so no save from it can land after the clear. It is not
// closed: the `test` fixture still takes its routes down afterwards.
test.afterEach(async ({ page, request }) => {
  await page.goto('about:blank')
  await clearSavedQueue(request)
})

// No route mocks: the scanner, SQLite, stream and browser must agree on the same ids.
test('local files play, seek, restore their queue and persist playlist edits', async ({
  page,
  request,
  isMobile,
}) => {
  test.setTimeout(60_000)
  // Start from no saved queue, whatever an earlier test or run left behind.
  await clearSavedQueue(request)
  expect((await request.post('/api/library/scan')).ok()).toBeTruthy()
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/library/albums?q=Local%20Playback%20Fixture')
        return libraryAlbumsSchema.parse(await response.json()).items.length
      },
      { timeout: 30_000 },
    )
    .toBe(1)
  const response = await request.get('/api/library/albums?q=Local%20Playback%20Fixture')
  const album = libraryAlbumsSchema.parse(await response.json()).items[0]!
  const playlistName = `Local playback ${test.info().project.name} ${Date.now()}`

  await page.goto(`/library/albums/${album.id}`)
  await expect(page.getByRole('heading', { name: album.name, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Play all', exact: true }).click()
  const audio = page.locator('audio.library-audio[data-role="active"]')
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBeGreaterThan(0)
  await expect(audio).toHaveAttribute('src', /\/api\/player\/stream\/tr-/)

  if (isMobile)
    await page
      .locator('.live-player')
      .getByRole('link', { name: 'Local First Light', exact: true })
      .click()
  const seek = page
    .getByRole('slider', { name: 'Playback position' })
    .filter({ visible: true })
    .first()
  await page
    .getByRole('button', { name: 'Pause', exact: true })
    .filter({ visible: true })
    .last()
    .click()
  await seek.focus()
  await seek.press('Home')
  await seek.press('ArrowRight')
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBeCloseTo(0.1, 1)

  await page
    .getByRole('button', { name: 'Next track', exact: true })
    .filter({ visible: true })
    .click()

  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBeGreaterThan(0)

  await page
    .getByRole('button', { name: 'Pause', exact: true })
    .filter({ visible: true })
    .last()
    .click()

  await expect
    .poll(async () => {
      const saved = playerQueueSchema.parse(await (await request.get('/api/player/queue')).json())
      return saved.entry.find((track) => track.id === saved.current)?.title
    })
    .toBe('Local Second Light')
  await page.reload()
  await expect(page.locator('.live-player')).toContainText('Local Second Light')

  await page.goto('/library/playlists')
  await page.getByRole('button', { name: 'New playlist', exact: true }).click()
  await page.getByLabel('Playlist name', { exact: true }).fill(playlistName)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('heading', { name: playlistName, exact: true })).toBeVisible()
  const playlistUrl = page.url()
  if (isMobile) {
    await page
      .locator('.live-player')
      .getByRole('link', { name: 'Local Second Light', exact: true })
      .click()
    await page.getByRole('button', { name: 'Add to playlist', exact: true }).click()
  } else {
    await page.getByRole('button', { name: 'Add Local Second Light to a playlist' }).click()
  }
  const picker = page.getByRole('dialog', { name: 'Add track to playlist' })
  await picker
    .getByRole('button', { name: `Add Local Second Light to ${playlistName}`, exact: true })
    .click()

  await expect(
    picker.getByRole('button', {
      name: `Added, remove Local Second Light from ${playlistName}`,
      exact: true,
    }),
  ).toBeVisible()
  await picker.getByRole('button', { name: 'Close playlist picker' }).click()
  await page.goto(playlistUrl)
  const remove = page.getByRole('button', { name: 'Remove Local Second Light from playlist' })
  await remove.click()
  await expect(remove).toHaveCount(0)
  await page.reload()
  await expect(remove).toHaveCount(0)
  const playlistId = new URL(playlistUrl).pathname.split('/').pop()!
  expect((await request.delete(`/api/library/playlists/${playlistId}`)).ok()).toBeTruthy()
})
