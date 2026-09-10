import { expect, test } from '@playwright/test'

const song = {
  id: 'song-1',
  title: 'First Light',
  artist: 'Harbor Static',
  artistId: 'artist-1',
  album: 'Clear Water',
  albumId: 'album-1',
  coverArt: 'cover-1',
  duration: 30,
  track: 1,
}

// Thirty seconds of 8 kHz mono silence: enough for the stream to play and for
// the visualizer's own decode to succeed. Keep this short - the decoded PCM
// is resampled to 44.1 kHz regardless of this file's own rate, so a longer
// clip means proportionally more samples for the engine to prepare, not just
// a longer playthrough.
function silenceWav(seconds = 30, rate = 8000) {
  const samples = seconds * rate
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  return buffer
}

test('now playing shows the visualizer with hover controls and an artwork switch', async ({
  page,
  browserName,
  isMobile,
}) => {
  test.skip(
    browserName !== 'chromium' || isMobile,
    'The visualizer is checked on desktop Chromium.',
  )
  // Software rendering in CI rebuilds a study slowly; give the whole flow room.
  test.setTimeout(180_000)

  await page.route('**/api/player/capabilities', (route) =>
    route.fulfill({
      json: {
        configured: true,
        available: true,
        version: '0.63.2',
        extensions: [],
        sonic_similarity: false,
        detail: 'Navidrome is ready',
      },
    }),
  )

  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: 'song-1', position: 0, entry: [song] } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/scrobble', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/player/stream/**', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: silenceWav() }),
  )

  await page.route('**/api/player/art/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#283d31"/></svg>',
    }),
  )

  await page.route('**/api/player/lyrics/song-1', (route) => route.fulfill({ json: { items: [] } }))

  await page.route('**/api/library/playlists/liked', (route) =>
    route.fulfill({ json: { id: 'liked', name: 'Liked', entry: [] } }),
  )

  await page.route('**/api/library/playlists', (route) => route.fulfill({ json: { items: [] } }))

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

  const stage = page.locator('.visual-stage')
  await expect(stage).toBeVisible()
  const webgl2 = await page.evaluate(() =>
    Boolean(document.createElement('canvas').getContext('webgl2')),
  )
  if (webgl2) await expect(stage.locator('canvas.visual-canvas')).toBeVisible({ timeout: 90_000 })
  else await expect(stage.getByRole('status')).toContainText(/unavailable|could not|stopped/i)

  // Hovering shows the controls. V moves to the next study.
  await stage.hover()
  const study = stage.getByLabel('Visual study')
  await expect(study).toBeVisible()
  const before = await study.inputValue()
  await stage.focus()
  await page.keyboard.press('v')
  await expect(study).not.toHaveValue(before)
  if (webgl2) await expect(stage).toHaveClass(/live/, { timeout: 90_000 })

  // The popout is offered only where the browser has Document Picture-in-Picture.
  const hasPictureInPicture = await page.evaluate(() => 'documentPictureInPicture' in window)
  await expect(stage.getByRole('button', { name: 'Pop out visualizer' })).toHaveCount(
    hasPictureInPicture ? 1 : 0,
  )

  // Idle only applies while playing, and the 30-second fixture track can have
  // already run out under CI's slow rendering above (playback runs in real
  // time regardless of how slow the visuals are). Rewind and make sure it is
  // still playing before relying on that.
  await stage.getByLabel('Playback position').evaluate((input: HTMLInputElement) => {
    input.value = '0'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const playButton = stage.getByRole('button', { name: 'Play' })
  if (await playButton.isVisible()) await playButton.click()
  if (webgl2) await expect(stage).toHaveClass(/live/, { timeout: 90_000 })

  // The controls rest while music plays and the pointer is still, and wake on movement.
  await stage.hover()
  await expect(stage).toHaveClass(/idle/, { timeout: 30_000 })
  await stage.hover({ position: { x: 40, y: 40 } })
  await expect(stage).not.toHaveClass(/idle/)

  // Artwork instead, remembered across a reload.
  await page.getByRole('button', { name: 'Show artwork' }).click()
  await expect(page.locator('.now-art img')).toBeVisible()
  await expect(stage).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'First Light' })).toBeVisible()
  await expect(page.locator('.now-art img')).toBeVisible()
  await page.getByRole('button', { name: 'Show visuals' }).click()
  await expect(page.locator('.visual-stage')).toBeVisible()
})
