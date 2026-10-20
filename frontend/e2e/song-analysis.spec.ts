import AxeBuilder from '@axe-core/playwright'
import type { Page, Route } from '@playwright/test'

import { expect, test } from './test'

/* Song analysis (/library/analysis) with its routes mocked: the stack under test has no worker
   and no measured songs, and the page must never change the shared installation's settings. */

const RECIPE = 'tempo-beat-v1'

type Status = {
  recipe: string
  active: boolean
  active_recipe: string
  paused: boolean
  token_configured: boolean
  worker: Record<string, unknown> | null
  counts: Record<string, number>
  rate: { songs_per_minute: number | null; run_songs: number; running: boolean }
  eta_seconds: number | null
  estimate: Record<string, unknown>
  batch: Record<string, unknown> | null
}

const song = (id: number, changes: Record<string, unknown> = {}) => ({
  id: `tr-${String(id).padStart(16, '0')}`,
  title: `Song ${id}`,
  artist: `Artist ${id}`,
  album: 'Album',
  duration: 200,
  bpm: 120 + id,
  reading: 120 + id,
  check: 120 + id,
  sure: true,
  why: '',
  energy: 0.05,
  band: 'medium',
  sections: [19, 95, 171],
  ...changes,
})

const LISTEN = {
  recipe: RECIPE,
  measured: 99,
  ambiguous_total: 2,
  groups: {
    fastest: [song(60), song(50)],
    slowest: [song(1, { bpm: 62, reading: 62 })],
    loudest: [song(3, { band: 'high' })],
    quietest: [song(4, { band: 'low' })],
    ambiguous: [
      song(5, { bpm: null, reading: 141.2, sure: false, why: 'sections and 60 s disagree' }),
      song(6, { bpm: 72, reading: 72, band: 'high' }),
    ],
  },
}

function initialStatus(): Status {
  return {
    recipe: RECIPE,
    active: false,
    active_recipe: '',
    paused: false,
    token_configured: true,
    worker: null,
    counts: {
      library: 50510,
      done: 0,
      unsure: 0,
      skipped: 0,
      failed: 0,
      waiting: 0,
      leased: 0,
      lacking: 50510,
    },
    rate: { songs_per_minute: null, run_songs: 0, running: false },
    eta_seconds: null,
    estimate: {
      device: 'cuda',
      seconds_per_song: 0.61,
      source: 'bake-off',
      lacking: 50510,
      whole_library_seconds: 30811,
    },
    batch: null,
  }
}

/** A short silent WAV, so a section button has something real to play. */
function silence(seconds: number): Buffer {
  const rate = 8000
  const data = Buffer.alloc(rate * seconds, 128)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate, 28)
  header.writeUInt16LE(1, 32)
  header.writeUInt16LE(8, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

async function mockAnalysis(page: Page) {
  const state = { status: initialStatus(), posts: [] as { path: string; body: unknown }[] }
  const seen = (route: Route) => {
    const request = route.request()
    const body = request.postData()
    state.posts.push({
      path: new URL(request.url()).pathname,
      body: body ? JSON.parse(body) : null,
    })
  }
  await page.route('**/api/audio-analysis/status', (route) => route.fulfill({ json: state.status }))
  await page.route('**/api/audio-analysis/listen', (route) => route.fulfill({ json: LISTEN }))
  await page.route('**/api/audio-analysis/sample', async (route) => {
    seen(route)
    state.status.counts.waiting = 100
    state.status.batch = { kind: 'sample', total: 100, measured: 37, started_at: '' }
    await route.fulfill({ json: { queued: 100, waiting: 100 } })
  })

  await page.route('**/api/audio-analysis/all', async (route) => {
    seen(route)
    state.status.counts.waiting = 50510
    state.status.batch = { kind: 'all', total: 50510, measured: 0, started_at: '' }
    await route.fulfill({
      json: { queued: 50510, waiting: 50510, lacking: 0, needs_confirmation: false },
    })
  })

  await page.route('**/api/audio-analysis/pause', async (route) => {
    seen(route)
    state.status.paused = (
      JSON.parse(route.request().postData() ?? '{}') as { paused: boolean }
    ).paused
    await route.fulfill({ json: state.status })
  })

  // Switching on is a settings PATCH. It is answered here from the real settings, unchanged
  // apart from the recipe, so the shared stack is never written to.
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }
    seen(route)
    const patch = JSON.parse(route.request().postData() ?? '{}') as {
      audio_scalar_recipe?: string
    }
    const current = await page.request.get('/api/settings')
    const settings = (await current.json()) as Record<string, { value: unknown }>
    const recipe = patch.audio_scalar_recipe ?? ''
    settings.audio_scalar_recipe = { ...settings.audio_scalar_recipe, value: recipe }
    state.status.active = recipe === RECIPE
    state.status.active_recipe = recipe
    await route.fulfill({ json: settings })
  })

  await page.route('**/api/player/stream/**', (route) =>
    route.fulfill({ body: silence(30), contentType: 'audio/wav' }),
  )

  return state
}

test.describe('Song analysis', () => {
  test('Server settings links to it, and a stopped worker shows how to start it', async ({
    page,
  }) => {
    await mockAnalysis(page)
    await page.goto('/settings')
    await page.getByRole('link', { name: 'Song analysis' }).click()
    await expect(page).toHaveURL(/\/library\/analysis$/)
    await expect(page.getByRole('heading', { name: 'Song analysis', level: 1 })).toBeAttached()
    await expect(page.getByText('The worker is not running.')).toBeVisible()
    await expect(
      page.getByText('docker compose --profile analysis-gpu up -d audio-worker-gpu'),
    ).toBeVisible()
    await page.getByRole('radio', { name: 'CPU' }).check({ force: true })
    await expect(
      page.getByText('docker compose --profile analysis up -d audio-worker'),
    ).toBeVisible()

    await expect(
      page.getByRole('switch', { name: 'Octive uses tempo and energy' }),
    ).not.toBeChecked()
    await expect(page.getByText('50,510 songs have no measurement.')).toBeVisible()
    await expect(page.getByText(/About 8 h 34 min on the graphics card/)).toBeVisible()
  })

  test('a running worker, the sample and its progress', async ({ page }) => {
    const state = await mockAnalysis(page)
    state.status.worker = {
      version: '0.5.0',
      device: 'cuda',
      gpu: 'NVIDIA GeForce RTX 5080',
      decoders: 4,
      memory_limit: 4 * 1024 ** 3,
      cpus: 4,
      note: '',
      seen_at: '',
      seconds_ago: 3,
      running: true,
    }
    await page.goto('/library/analysis')
    await expect(
      page.getByText('on graphics card (NVIDIA GeForce RTX 5080), 4 decoders, 4 GB'),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Measure 100 songs' }).click()
    await expect(page.getByText('Queued 100 songs.')).toBeVisible()
    await expect(page.getByRole('progressbar', { name: 'Sample progress' })).toHaveAttribute(
      'aria-valuenow',
      '37',
    )
    await expect(page.getByText('37 of 100 measured')).toBeVisible()
    expect(state.posts.map((post) => post.path)).toEqual(['/api/audio-analysis/sample'])
  })

  test('the listen groups play the measured sections and say tempo can read half or double', async ({
    page,
  }) => {
    await mockAnalysis(page)
    await page.goto('/library/analysis')
    await expect(page.getByText(/Tempo can read half or double/)).toBeVisible()
    const list = page.getByRole('list', { name: 'Fastest' })
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(list.getByText('180 BPM')).toBeVisible()
    await page.getByRole('button', { name: 'Check these (2)' }).click()
    const check = page.getByRole('list', { name: 'Check these' })
    await expect(check.getByText('read 141, unsure')).toBeVisible()
    await expect(check.getByText('72 BPM')).toBeVisible()
    const stream = page.waitForRequest('**/api/player/stream/tr-0000000000000005')
    const play = check.getByRole('button', { name: 'Play 10 seconds from 1:35' }).first()
    await play.click()
    await stream
    const stop = check.getByRole('button', { name: 'Stop 10 seconds from 1:35' })
    await expect(stop).toHaveAttribute('aria-pressed', 'true')
    await stop.click()
    await expect(play).toHaveAttribute('aria-pressed', 'false')
  })

  test('measuring everything asks first, and pause and switching on go to the server', async ({
    page,
  }) => {
    const state = await mockAnalysis(page)
    await page.goto('/library/analysis')
    await page.getByRole('button', { name: 'Measure whole library' }).click()
    await expect(page.getByText('Queue 50,510 songs?')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    expect(state.posts).toEqual([])
    await page.getByRole('button', { name: 'Measure whole library' }).click()
    await page.getByRole('button', { name: 'Queue them' }).click()
    await expect(page.getByRole('progressbar', { name: 'Library progress' })).toBeVisible()
    await page.getByRole('button', { name: 'Pause' }).click()
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    await expect(page.getByText('50,510 waiting, paused.')).toBeVisible()
    await page.getByRole('button', { name: 'Turn on for Octive' }).click()
    await expect(page.getByText(`On. Octive uses ${RECIPE}.`)).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Octive uses tempo and energy' })).toBeChecked()
    await page.getByRole('switch', { name: 'Octive uses tempo and energy' }).uncheck()
    await expect(page.getByRole('button', { name: 'Turn on for Octive' })).toBeVisible()
    expect(state.posts).toEqual([
      { path: '/api/audio-analysis/all', body: { confirm: true } },
      { path: '/api/audio-analysis/pause', body: { paused: true } },
      { path: '/api/settings', body: { audio_scalar_recipe: RECIPE } },
      { path: '/api/settings', body: { audio_scalar_recipe: '' } },
    ])
  })

  test('fits a phone and has no accessibility violations', async ({ page }) => {
    await mockAnalysis(page)
    await page.goto('/library/analysis')
    await expect(page.getByRole('list', { name: 'Fastest' })).toBeVisible()
    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    expect(width.scroll).toBeLessThanOrEqual(width.client)
    const results = await new AxeBuilder({ page }).include('main').analyze()
    expect(results.violations).toEqual([])
  })
})
