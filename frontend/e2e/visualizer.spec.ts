import { expect, test } from '@playwright/test'

test.setTimeout(90000)

const song = {
  id: 'visual-test',
  title: 'Resonance study',
  artist: 'Musimo test fixture',
  album: 'Generated sound',
  albumId: '',
  artistId: '',
  coverArt: '',
  duration: 120,
  track: 1,
}

function sound() {
  const rate = 16000,
    samples = rate * 120
  const data = Buffer.alloc(44 + samples * 2)
  data.write('RIFF')
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(rate, 24)
  data.writeUInt32LE(rate * 2, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) {
    const time = i / rate
    const pulse = Math.exp(-(time % 0.5) * 65)
    data.writeInt16LE(
      Math.round(
        (Math.sin(time * 220 * Math.PI * 2) * 0.08 +
          Math.sin(time * 64 * Math.PI * 2) * pulse * 0.45) *
          32767,
      ),
      44 + i * 2,
    )
  }
  return data
}

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === 'webgl') {
    await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }))
  }
  const audio = sound()
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { entry: [song], current: song.id, position: 0 } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/scrobble', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/player/stream/**', (route) => {
    const range = route
      .request()
      .headers()
      .range?.match(/^bytes=(\d+)-(\d*)$/)
    const start = Number(range?.[1] ?? 0)
    const end = range?.[2] ? Number(range[2]) : audio.length - 1
    return route.fulfill({
      status: range ? 206 : 200,
      body: audio.subarray(start, end + 1),
      contentType: 'audio/wav',
      headers: {
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${audio.length}` } : {}),
      },
    })
  })
  await page.route('**/api/player/lyrics/**', (route) => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/player/capabilities', (route) =>
    route.fulfill({
      json: {
        configured: true,
        available: true,
        version: 'test',
        extensions: [],
        sonic_similarity: false,
        detail: '',
      },
    }),
  )

  await page.route('**/api/visualizer/analysis/**', (route) =>
    route.fulfill({
      json: {
        status: 'ready',
        map: {
          version: 1,
          duration: 120,
          hop: 0.1,
          energy: Array(1200).fill(0.5),
          bass: Array(1200).fill(0.5),
          body: Array(1200).fill(0.3),
          air: Array(1200).fill(0.2),
          confidence: 0.9,
          beats: Array.from({ length: 48 }, (_, index) => index * 0.5),
          sections: [
            { start: 0, end: 8, identity: 0, energy: 0.3 },
            { start: 8, end: 16, identity: 1, energy: 0.8 },
            { start: 16, end: 120, identity: 0, energy: 0.3 },
          ],
        },
      },
    }),
  )
})

test('real audio continues through visuals, seeking, controls and repeated entry', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/now-playing')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.getByRole('button', { name: 'Visualize', exact: true }).click()
  const visual = page.getByRole('dialog', { name: 'Music visualizer' })
  await expect(visual).toBeVisible({ timeout: 30000 })
  await expect(visual.getByText('Forming your world')).toBeHidden({ timeout: 30000 })
  await expect(visual.getByRole('alert')).toHaveCount(0)
  const first = await visual.locator('canvas').screenshot()
  expect(first.length).toBeGreaterThan(18000)
  await expect
    .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeGreaterThan(1)
  await page.mouse.move(120, 80)
  await visual.getByRole('button', { name: 'Visual settings' }).click()
  await expect(visual.getByText('Song map ready')).toBeVisible()
  await visual.getByLabel('Visual quality').selectOption('low')
  await visual.getByLabel('Visual timing adjustment').fill('80')
  await visual.getByRole('button', { name: 'Save', exact: true }).click()
  await visual.getByRole('button', { name: 'Close visual settings' }).click()
  await visual.getByLabel('Playback position', { exact: true }).fill('17')
  await expect(visual.locator('.visualizer-phase')).toHaveText('Return')
  await visual.getByRole('button', { name: 'Pause', exact: true }).click()
  const paused = await page
    .locator('audio')
    .evaluate((audio: HTMLAudioElement) => audio.currentTime)
  await page.waitForTimeout(250)
  expect(
    await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime),
  ).toBeCloseTo(paused, 1)
  await visual.getByRole('button', { name: 'Play', exact: true }).click()
  await visual.getByRole('button', { name: 'Exit visualizer' }).click()
  await expect(visual).toBeHidden()
  await expect
    .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeGreaterThan(paused)
  await page.getByRole('button', { name: 'Visualize', exact: true }).click()
  await expect(visual.getByRole('alert')).toHaveCount(0)
  await page.mouse.move(120, 80)
  await visual.getByRole('button', { name: 'Visual settings' }).click()
  await expect(visual.getByLabel('Visual quality')).toHaveValue('low')
  await expect(visual.getByLabel('Visual timing adjustment')).toHaveValue('80')
  await expect(visual.getByRole('button', { name: 'Save', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(errors).toEqual([])
})

test('analysis failure leaves live rendering and playback available', async ({
  page,
  isMobile,
}) => {
  await page.route('**/api/visualizer/analysis/**', (route) =>
    route.fulfill({ status: 503, json: { detail: 'Fixture unavailable' } }),
  )
  await page.goto('/now-playing')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.getByRole('button', { name: 'Visualize', exact: true }).click()
  const visual = page.getByRole('dialog')
  await expect(visual).toBeVisible({ timeout: 30000 })
  await expect(visual.getByText('Forming your world')).toBeHidden({ timeout: 30000 })
  if (isMobile) await visual.locator('canvas').tap({ position: { x: 80, y: 160 } })
  else await visual.locator('canvas').click({ position: { x: 80, y: 160 } })
  await visual.getByRole('button', { name: 'Visual settings' }).click()
  await expect(visual.getByText('Listening live')).toBeVisible()
  await expect
    .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime), {
      timeout: 15000,
    })
    .toBeGreaterThan(0.5)
})
